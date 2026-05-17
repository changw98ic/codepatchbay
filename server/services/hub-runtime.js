import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { shouldUseRustRuntime } from "./runtime-cli.js";

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

function buildRuntimeMeta(cpbRoot, hubRoot) {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cpbRoot: path.resolve(cpbRoot),
    hubRoot: path.resolve(hubRoot),
    version: RUNTIME_VERSION,
    runtime: shouldUseRustRuntime() ? "rust" : "node",
    health: "alive",
  };
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
      await writeAtomic(statePath, `${JSON.stringify(meta, null, 2)}\n`);
      return meta;
    },

    status() {
      return { ...meta, statePath };
    },
  };

  instances.set(key, runtime);
  return runtime;
}

export function resetInstances() {
  instances.clear();
}

export { RUNTIME_VERSION };
