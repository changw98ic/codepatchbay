import { openSync } from "node:fs";
import { mkdir, stat, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveHubRoot } from "./hub-registry.js";
import { readHubLiveness, getHubRuntime } from "./hub-runtime.js";
import { buildChildEnv, buildRuntimeEnv } from "./secret-policy.js";

function resolveRoots() {
  const cpbRoot = path.resolve(process.env.CPB_ROOT || ".");
  const executorRoot = path.resolve(process.env.CPB_EXECUTOR_ROOT || cpbRoot);
  const hubRoot = resolveHubRoot(cpbRoot);
  return { cpbRoot, executorRoot, hubRoot };
}

export function buildHubServerEnv(parentEnv = process.env, { cpbRoot, executorRoot, hubRoot, port, host } = {}) {
  return buildChildEnv(parentEnv, {
    CPB_ROOT: cpbRoot,
    CPB_EXECUTOR_ROOT: executorRoot,
    CPB_HUB_ROOT: hubRoot,
    CPB_PORT: port,
    CPB_HOST: host,
  });
}

export function buildHubInstallEnv(parentEnv = process.env) {
  return buildRuntimeEnv(parentEnv);
}

export async function cmdStart() {
  const { cpbRoot, executorRoot, hubRoot } = resolveRoots();

  const liveness = await readHubLiveness(hubRoot);
  if (liveness.alive) {
    console.log(`Hub is already running (pid: ${liveness.pid}).`);
    return;
  }

  try {
    await stat(path.join(executorRoot, "server", "node_modules"));
  } catch {
    console.log("Installing server deps...");
    const { execSync } = await import("node:child_process");
    execSync("npm install --silent", {
      cwd: path.join(executorRoot, "server"),
      env: buildHubInstallEnv(process.env),
      stdio: "pipe",
    });
  }

  // Auto-install Playwright Chromium when browser-agent is configured
  try {
    const { getManagedAcpPool } = await import("./acp-pool.js");
    const pool = getManagedAcpPool({ cpbRoot, hubRoot });
    const status = pool.status();
    const hasBrowserAgent = Object.values(status.pools || {}).some(
      (p) => p.agent === "browser-agent" || p.mode === "persistent",
    );
    if (hasBrowserAgent) {
      const { default: playwright } = await import("playwright");
      await stat(playwright.chromium.executablePath());
    }
  } catch {
    console.log("Installing Playwright Chromium (browser-agent dependency)...");
    const { execSync: _execSync } = await import("node:child_process");
    try {
      _execSync("npx playwright install chromium", {
        cwd: executorRoot,
        stdio: "pipe",
        timeout: 120_000,
      });
    } catch {
      console.error("Warning: Playwright Chromium install failed. Browser-agent tasks will not work.");
    }
  }

  const port = process.env.CPB_PORT || "3456";
  const host = process.env.CPB_HOST || "127.0.0.1";
  await mkdir(hubRoot, { recursive: true });

  const { spawn } = await import("node:child_process");
  const logFd = openSync(path.join(hubRoot, "hub.log"), "a");
  const child = spawn(process.execPath, [path.join(executorRoot, "server", "index.js")], {
    cwd: cpbRoot,
    env: buildHubServerEnv(process.env, { cpbRoot, executorRoot, hubRoot, port, host }),
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  const runtime = getHubRuntime(cpbRoot, hubRoot);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const check = await readHubLiveness(hubRoot);
    if (check.alive) {
      console.log(`Hub started on http://${host}:${port} (pid: ${check.pid})`);
      // Auto-start Hub Orchestrator
      try {
        const orchLogFd = openSync(path.join(hubRoot, "orchestrator.log"), "a");
        const orchChild = spawn(process.execPath, [
          path.join(executorRoot, "cli", "cpb.mjs"), "hub-orch", "start",
        ], {
          cwd: cpbRoot,
          env: buildHubServerEnv(process.env, { cpbRoot, executorRoot, hubRoot, port, host }),
          detached: true,
          stdio: ["ignore", orchLogFd, orchLogFd],
        });
        orchChild.unref();
        // Persist orchestrator PID for clean shutdown
        await mkdir(path.join(hubRoot, "state"), { recursive: true });
        await writeFile(
          path.join(hubRoot, "state", "orchestrator.json"),
          JSON.stringify({ pid: orchChild.pid, startedAt: new Date().toISOString() }, null, 2) + "\n",
        );
        console.log(`Orchestrator started (pid: ${orchChild.pid})`);
      } catch (e) {
        console.error(`Orchestrator start failed: ${e.message}`);
      }
      // Auto-start Quota Delegate (skip if already running)
      try {
        const { isDelegateAlive } = await import("./quota-delegate-client.js");
        if (await isDelegateAlive(hubRoot)) {
          console.log("Quota delegate already running, skipping start");
        } else {
        const delegateLogFd = openSync(path.join(hubRoot, "quota-delegate.log"), "a");
        const delegateChild = spawn(process.execPath, [
          path.join(executorRoot, "server", "services", "quota-delegate.js"),
          "--hub-root", hubRoot,
        ], {
          cwd: cpbRoot,
          env: buildHubServerEnv(process.env, { cpbRoot, executorRoot, hubRoot }),
          detached: true,
          stdio: ["ignore", delegateLogFd, delegateLogFd],
        });
        delegateChild.unref();
        console.log(`Quota delegate started (pid: ${delegateChild.pid})`);
        }
      } catch (e) {
        console.error(`Quota delegate start failed: ${e.message}`);
      }
      // Auto-start CodeGraph MCP server
      try {
        const { run: codegraphRun } = await import("../../cli/commands/codegraph.js");
        await codegraphRun(["start"], { cpbRoot, executorRoot });
      } catch (e) {
        console.error(`CodeGraph start failed: ${e.message}`);
      }
      return;
    }
  }
  console.error(`Hub failed to start within 5 seconds. Check ${path.join(hubRoot, "hub.log")}`);
  process.exit(1);
}

export async function cmdStop() {
  const { hubRoot } = resolveRoots();

  const liveness = await readHubLiveness(hubRoot);
  if (!liveness.alive) {
    if (liveness.reason === "shutdown") {
      console.log("Hub is not running (graceful shutdown recorded).");
    } else if (liveness.reason === "no-hub-json") {
      console.log("Hub is not running (no state file).");
    } else {
      console.log(`Hub process ${liveness.pid} is not running.`);
    }
    return;
  }

  process.kill(liveness.pid, "SIGTERM");

  // Stop managed workers (from WorkerStore)
  try {
    const { WorkerStore } = await import("../orchestrator/worker-store.js");
    const store = new WorkerStore(hubRoot);
    const workers = await store.listWorkers();
    let stopped = 0;
    for (const w of workers) {
      if (w.pid && w.status !== "exited") {
        try { process.kill(w.pid, "SIGTERM"); stopped++; } catch {}
      }
    }
    if (stopped > 0) console.log(`Managed workers stopped (${stopped})`);
  } catch {}

  // Stop orchestrator process by PID (direct SIGTERM, not just lock release)
  try {
    const orchStatePath = path.join(hubRoot, "state", "orchestrator.json");
    const orchState = JSON.parse(await readFile(orchStatePath, "utf8"));
    if (orchState.pid) {
      try { process.kill(orchState.pid, "SIGTERM"); } catch {}
      // Also release leader lock for graceful cleanup
      const { cpbRoot: r1, hubRoot: h1 } = resolveRoots();
      const { HubOrchestrator } = await import("../orchestrator/hub-orchestrator.js");
      const orch = new HubOrchestrator(h1, r1);
      await orch.stop();
      console.log(`Orchestrator stopped (pid: ${orchState.pid})`);
    }
    await rm(orchStatePath, { force: true });
  } catch {}

  // Stop quota delegate process by PID (from delegate.lock)
  try {
    const delegateLockPath = path.join(hubRoot, "providers", "delegate", "delegate.lock");
    const delegateLock = JSON.parse(await readFile(delegateLockPath, "utf8"));
    if (delegateLock.pid) {
      try { process.kill(delegateLock.pid, "SIGTERM"); } catch {}
      console.log(`Quota delegate stopping (pid: ${delegateLock.pid})`);

      // Wait for process to actually exit (up to 5s)
      const deadline = Date.now() + 5000;
      let exited = false;
      while (Date.now() < deadline) {
        try {
          process.kill(delegateLock.pid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          exited = true;
          break;
        }
      }

      if (exited) {
        // Process exited; delegate should have cleaned its lock. Remove if stale.
        await rm(delegateLockPath, { force: true });
        console.log(`Quota delegate stopped (pid: ${delegateLock.pid})`);
      } else {
        console.error(`Quota delegate did not exit within timeout; leaving lock in place`);
      }
    }
  } catch {}

  // Auto-stop CodeGraph MCP server
  try {
    const { cpbRoot: r2, executorRoot: e2 } = resolveRoots();
    const { run: codegraphRun } = await import("../../cli/commands/codegraph.js");
    await codegraphRun(["stop"], { cpbRoot: r2, executorRoot: e2 });
  } catch {}

  // Auto-stop Queue Daemon workers
  try {
    const { cpbRoot: r3 } = resolveRoots();
    const { stopDaemon } = await import("./queue-daemon.js");
    const result = await stopDaemon({ cpbRoot: r3 });
    if (result.status === "stopped" && result.pid) {
      console.log(`Daemon workers stopped (pid: ${result.pid})`);
    }
  } catch {}

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(liveness.pid, 0);
    } catch (err) {
      // EPERM: process still alive (just no permission to signal) — keep waiting
      if (err.code === "EPERM") continue;
      console.log(`Hub stopped (was pid: ${liveness.pid}).`);
      return;
    }
  }
  try {
    process.kill(liveness.pid, 9);
  } catch {}
  console.log(`Hub force-stopped (was pid: ${liveness.pid}).`);
}
