import { openSync, readSync, closeSync, writeSync, fstatSync } from "node:fs";
import { mkdir, stat, readFile, writeFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { resolveHubRoot } from "./hub-registry.js";
import { readHubLiveness, getHubRuntime } from "./hub-runtime.js";
import { buildChildEnv, buildRuntimeEnv } from "./secret-policy.js";
import { hubConcurrencyEnv, resolveHubConcurrencyLimits } from "./concurrency-limits.js";

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

/**
 * Rotate a log file if it exceeds maxSize by keeping only the last keepSize bytes.
 * Truncates at the first newline boundary to avoid partial lines.
 */
function rotateLogIfNeeded(filePath, maxSize = 10 * 1024 * 1024, keepSize = 1024 * 1024) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const info = fstatSync(fd);
    if (info.size <= maxSize) { closeSync(fd); return; }
    const buf = Buffer.alloc(keepSize);
    readSync(fd, buf, 0, keepSize, info.size - keepSize);
    closeSync(fd);
    fd = undefined;
    // Find first newline to avoid partial lines
    const nlIdx = buf.indexOf("\n");
    const trimmed = nlIdx >= 0 ? buf.slice(nlIdx + 1) : buf;
    const wfd = openSync(filePath, "w");
    writeSync(wfd, trimmed);
    closeSync(wfd);
  } catch {
    // File doesn't exist yet or can't be read — that's fine
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
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

  // Ensure Playwright Chromium is installed when browser-agent is configured
  try {
    const { getManagedAcpPool } = await import("./acp-pool.js");
    const pool = getManagedAcpPool({ cpbRoot, hubRoot });
    const status = pool.status();
    const hasBrowserAgent = Object.values(status.pools || {}).some((p) => p.agent === "browser-agent" || p.mode === "persistent");
    if (hasBrowserAgent) {
      const { default: playwright } = await import("playwright");
      const execPath = playwright.chromium.executablePath();
      await stat(execPath);
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
  const configuredEnv = hubConcurrencyEnv(await resolveHubConcurrencyLimits(hubRoot, {
    maxActivePerProject: process.env.CPB_HUB_MAX_ACTIVE_PER_PROJECT,
    maxActiveTotal: process.env.CPB_HUB_MAX_ACTIVE_TOTAL,
    acpPoolTotal: process.env.CPB_ACP_POOL_TOTAL,
    acpProviderMax: process.env.CPB_ACP_POOL_PROVIDER_MAX,
  }));
  const hubProcessEnv = { ...process.env, ...configuredEnv };
  await mkdir(hubRoot, { recursive: true });

  const { spawn } = await import("node:child_process");
  rotateLogIfNeeded(path.join(hubRoot, "hub.log"));
  // Rotate worker logs (keep last 5MB)
  try {
    const logsDir = path.join(hubRoot, "logs");
    const logEntries = await readdir(logsDir);
    for (const e of logEntries) {
      if (e.endsWith(".log")) rotateLogIfNeeded(path.join(logsDir, e), 10 * 1024 * 1024, 5 * 1024 * 1024);
    }
  } catch {}
  const logFd = openSync(path.join(hubRoot, "hub.log"), "a");
  const child = spawn(process.execPath, [path.join(executorRoot, "server", "index.js")], {
    cwd: cpbRoot,
    env: buildHubServerEnv(hubProcessEnv, { cpbRoot, executorRoot, hubRoot, port, host }),
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
        rotateLogIfNeeded(path.join(hubRoot, "orchestrator.log"));
        const orchLogFd = openSync(path.join(hubRoot, "orchestrator.log"), "a");
        const orchChild = spawn(process.execPath, [
          path.join(executorRoot, "cli", "cpb.mjs"), "hub-orch", "start",
        ], {
          cwd: cpbRoot,
          env: buildHubServerEnv(hubProcessEnv, { cpbRoot, executorRoot, hubRoot, port, host }),
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
        rotateLogIfNeeded(path.join(hubRoot, "quota-delegate.log"));
        const delegateLogFd = openSync(path.join(hubRoot, "quota-delegate.log"), "a");
        const delegateChild = spawn(process.execPath, [
          path.join(executorRoot, "server", "services", "quota-delegate.js"),
          "--hub-root", hubRoot,
        ], {
          cwd: cpbRoot,
          env: buildHubServerEnv(hubProcessEnv, { cpbRoot, executorRoot, hubRoot }),
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
  const { cpbRoot, hubRoot } = resolveRoots();

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
    const liveWorkers = workers.filter((w) => w.pid && w.status !== "exited");
    let stopped = 0;
    for (const w of liveWorkers) {
      try { process.kill(w.pid, "SIGTERM"); stopped++; } catch {
        // Process already dead — mark exited immediately
        await store.updateWorker(w.workerId, { status: "exited" });
      }
    }
    if (stopped > 0) console.log(`Managed workers stopped (${stopped})`);

    // Wait for workers to exit (up to 5s), then force-mark stragglers
    if (stopped > 0) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        let allGone = true;
        for (const w of liveWorkers) {
          const cur = await store.getWorker(w.workerId);
          if (cur && cur.status === "exited") continue;
          try { process.kill(w.pid, 0); allGone = false; } catch {
            await store.updateWorker(w.workerId, { status: "exited" });
          }
        }
        if (allGone) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // Mark any stragglers as exited and prune dead workers from registry
    for (const w of liveWorkers) {
      const current = await store.getWorker(w.workerId);
      if (current && current.status !== "exited") {
        try { process.kill(w.pid, 9); } catch {}
        await store.updateWorker(w.workerId, { status: "exited" });
      }
    }
    await store.pruneDead();
  } catch {}

  // Release in_progress queue entries back to failed (workers are gone)
  try {
    const { loadQueue, saveQueue } = await import("../services/hub-queue.js");
    const queue = await loadQueue(hubRoot);
    let released = 0;
    for (const e of queue.entries) {
      if (e.status === "in_progress") {
        e.status = "failed";
        e.updatedAt = new Date().toISOString();
        released++;
      }
    }
    if (released > 0) {
      await saveQueue(hubRoot, queue);
      console.log(`Queue entries released (${released})`);
    }
  } catch {}

  // Flush jobs-index (rebuild from event logs to ensure consistency)
  try {
    const { rebuildJobsIndex } = await import("../services/jobs-index.js");
    await rebuildJobsIndex(cpbRoot);
    console.log("Jobs index flushed");
  } catch (err) {
    console.error(`Jobs index flush failed: ${err.message}`);
  }

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
