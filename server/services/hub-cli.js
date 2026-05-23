import { openSync } from "node:fs";
import { mkdir, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveHubRoot } from "./hub-registry.js";
import { readHubLiveness, getHubRuntime } from "./hub-runtime.js";

function resolveRoots() {
  const cpbRoot = path.resolve(process.env.CPB_ROOT || ".");
  const executorRoot = path.resolve(process.env.CPB_EXECUTOR_ROOT || cpbRoot);
  const hubRoot = resolveHubRoot(cpbRoot);
  return { cpbRoot, executorRoot, hubRoot };
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
    execSync("npm install --silent", { cwd: path.join(executorRoot, "server"), stdio: "pipe" });
  }

  const port = process.env.CPB_PORT || "3456";
  const host = process.env.CPB_HOST || "127.0.0.1";
  await mkdir(hubRoot, { recursive: true });

  const { spawn } = await import("node:child_process");
  const logFd = openSync(path.join(hubRoot, "hub.log"), "a");
  const child = spawn(process.execPath, [path.join(executorRoot, "server", "index.js")], {
    cwd: cpbRoot,
    env: { ...process.env, CPB_ROOT: cpbRoot, CPB_EXECUTOR_ROOT: executorRoot, CPB_HUB_ROOT: hubRoot, CPB_PORT: port, CPB_HOST: host },
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
