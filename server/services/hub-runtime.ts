// @ts-nocheck
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const RUNTIME_VERSION = "0.2.0";

const instances = new Map();

function instanceKey(cpbRoot, hubRoot) {
  return `${path.resolve(cpbRoot)}\0${path.resolve(hubRoot)}`;
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

async function readRuntimeState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

function buildRuntimeMeta(cpbRoot, hubRoot) {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cpbRoot: path.resolve(cpbRoot),
    hubRoot: path.resolve(hubRoot),
    version: RUNTIME_VERSION,
    runtime: "node",
    health: "alive",
  };
}

function sameRuntime(a, b) {
  return Boolean(
    a &&
    b &&
    a.pid === b.pid &&
    a.startedAt === b.startedAt &&
    path.resolve(a.cpbRoot || "") === path.resolve(b.cpbRoot || "") &&
    path.resolve(a.hubRoot || "") === path.resolve(b.hubRoot || ""),
  );
}

export function getHubRuntime(cpbRoot, hubRoot) {
  const key = instanceKey(cpbRoot, hubRoot);
  const existing = instances.get(key);
  if (existing) return existing;

  const meta = Object.freeze(buildRuntimeMeta(cpbRoot, hubRoot));
  const statePath = path.join(path.resolve(hubRoot), "state", "hub.json");

  const runtime = {
    ...meta,
    statePath,

    async persist() {
      const current = await readRuntimeState(statePath);
      if (current && !sameRuntime(current, meta) && current.health !== "dead" && isPidAlive(current.pid)) {
        return { ...current, statePath, skipped: "live-owner-present" };
      }
      await writeAtomic(statePath, `${JSON.stringify(meta, null, 2)}\n`);
      return meta;
    },

    status() {
      return { ...meta, statePath };
    },

    async markDead() {
      const current = await readRuntimeState(statePath);
      if (current && !sameRuntime(current, meta) && current.health !== "dead" && isPidAlive(current.pid)) {
        return { ...current, statePath, skipped: "live-owner-present" };
      }
      const deadMeta = { ...meta, health: "dead", stoppedAt: new Date().toISOString() };
      await writeAtomic(statePath, `${JSON.stringify(deadMeta, null, 2)}\n`);
      return deadMeta;
    },
  };

  instances.set(key, runtime);
  return runtime;
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but no permission → still alive
    if (err.code === "EPERM") return true;
    return false;
  }
}

export async function readHubLiveness(hubRoot) {
  const statePath = path.join(path.resolve(hubRoot), "state", "hub.json");
  let meta = null;
  try {
    const raw = await readFile(statePath, "utf8");
    meta = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      return { alive: false, reason: "no-hub-json" };
    }
    return { alive: false, reason: "read-error", error: err.message };
  }

  // If hub.json claims alive, verify PID
  if (meta.health !== "dead" && meta.pid) {
    if (isPidAlive(meta.pid)) {
      return { alive: true, pid: meta.pid, startedAt: meta.startedAt, version: meta.version, runtime: meta.runtime };
    }
  }

  // hub.json says dead or PID gone — try HTTP probe as fallback
  const port = parseInt(process.env.CPB_PORT || "3456", 10);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      return { alive: true, pid: meta.pid || null, startedAt: meta.startedAt, version: meta.version, runtime: meta.runtime, source: "http-probe" };
    }
  } catch {}

  // Truly dead
  if (meta.health === "dead") {
    return { alive: false, reason: "shutdown", pid: meta.pid, stoppedAt: meta.stoppedAt, startedAt: meta.startedAt };
  }
  return { alive: false, reason: "process-gone", pid: meta.pid, startedAt: meta.startedAt };
}

export function resetInstances() {
  instances.clear();
}

export { RUNTIME_VERSION };
