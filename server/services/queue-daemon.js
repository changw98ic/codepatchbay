import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHubRoot } from "./hub-registry.js";

const DAEMON_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

export function daemonStatePath(cpbRoot) {
  return path.join(path.resolve(cpbRoot || process.env.CPB_ROOT || process.cwd()), "cpb-task", "daemon", "queue-worker.json");
}

async function readDaemonState(cpbRoot) {
  try {
    return JSON.parse(await readFile(daemonStatePath(cpbRoot), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeDaemonState(cpbRoot, state) {
  const file = daemonStatePath(cpbRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function statusDaemon({ cpbRoot, isProcessAlive = defaultIsProcessAlive } = {}) {
  const state = await readDaemonState(cpbRoot);
  if (!state?.pid) {
    return { running: false, status: "stopped", pid: null, state: null };
  }
  const running = isProcessAlive(state.pid);
  return {
    running,
    status: running ? "running" : "stale",
    pid: state.pid,
    state,
  };
}

export async function startDaemon({
  cpbRoot = process.env.CPB_ROOT || process.cwd(),
  executorRoot = cpbRoot,
  hubRoot = resolveHubRoot(cpbRoot),
  spawnFn = spawn,
  isProcessAlive = defaultIsProcessAlive,
  extraArgs = [],
} = {}) {
  const current = await statusDaemon({ cpbRoot, isProcessAlive });
  if (current.running) {
    return { status: "already-running", pid: current.pid, state: current.state };
  }

  const workerScript = path.join(path.resolve(executorRoot), "bridges", "project-worker.mjs");
  const child = spawnFn(process.execPath, [
    workerScript,
    "--pool",
    "--hub-root", path.resolve(hubRoot),
    "--cpb-root", path.resolve(cpbRoot),
    "--executor-root", path.resolve(executorRoot),
    ...extraArgs,
  ], {
    cwd: path.resolve(cpbRoot),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CPB_ROOT: path.resolve(cpbRoot),
      CPB_EXECUTOR_ROOT: path.resolve(executorRoot),
      CPB_HUB_ROOT: path.resolve(hubRoot),
    },
  });
  child.unref?.();

  const state = await writeDaemonState(cpbRoot, {
    schemaVersion: DAEMON_VERSION,
    pid: child.pid,
    hubRoot: path.resolve(hubRoot),
    cpbRoot: path.resolve(cpbRoot),
    executorRoot: path.resolve(executorRoot),
    startedAt: nowIso(),
    worker: "project-worker",
    mode: "pool",
  });
  return { status: "started", pid: child.pid, state };
}

export async function stopDaemon({
  cpbRoot = process.env.CPB_ROOT || process.cwd(),
  killFn = process.kill,
} = {}) {
  const state = await readDaemonState(cpbRoot);
  if (!state?.pid) {
    return { status: "stopped", pid: null };
  }
  try {
    killFn(state.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await rm(daemonStatePath(cpbRoot), { force: true });
  return { status: "stopped", pid: state.pid };
}
