import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";

import { WorkerSupervisor } from "../server/orchestrator/worker-supervisor.js";

class MemoryWorkerStore {
  constructor() {
    this.workers = new Map();
  }

  async registerWorker(workerId, meta = {}) {
    const worker = { workerId, ...meta };
    this.workers.set(workerId, worker);
    return worker;
  }

  async updateWorker(workerId, updates = {}) {
    const worker = this.workers.get(workerId);
    if (!worker) return null;
    const updated = { ...worker, ...updates };
    this.workers.set(workerId, updated);
    return updated;
  }

  async listWorkers() {
    return [...this.workers.values()];
  }
}

async function waitForJson(file, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      lastError = err;
      await delay(50);
    }
  }
  throw lastError || new Error(`timed out waiting for ${file}`);
}

describe("WorkerSupervisor executor root", () => {
  it("spawns managed workers from executor root while keeping CPB_ROOT on runtime state", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-worker-executor-root-"));
    try {
      const hubRoot = path.join(tmpDir, "hub");
      const cpbRoot = path.join(tmpDir, "runtime-state");
      const executorRoot = path.join(tmpDir, "installed-package");
      await mkdir(path.join(executorRoot, "runtime", "worker"), { recursive: true });
      await mkdir(cpbRoot, { recursive: true });

      await writeFile(
        path.join(executorRoot, "runtime", "worker", "managed-worker.js"),
        `
import fs from "node:fs";
import path from "node:path";

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const hubRoot = arg("--hub-root");
fs.mkdirSync(hubRoot, { recursive: true });
fs.writeFileSync(path.join(hubRoot, "worker-marker.json"), JSON.stringify({
  argv: process.argv,
  cwd: process.cwd(),
  cpbRoot: process.env.CPB_ROOT,
  hubRoot: process.env.CPB_HUB_ROOT,
  executorRoot: process.env.CPB_EXECUTOR_ROOT,
}, null, 2));
`,
        "utf8",
      );

      const workerStore = new MemoryWorkerStore();
      const supervisor = new WorkerSupervisor(hubRoot, cpbRoot, {
        workerStore,
        executorRoot,
      });

      const worker = await supervisor.startWorker({ projectId: "flow" });
      const marker = await waitForJson(path.join(hubRoot, "worker-marker.json"));

      assert.equal(await realpath(marker.cwd), await realpath(executorRoot));
      assert.equal(marker.cpbRoot, cpbRoot);
      assert.equal(marker.hubRoot, hubRoot);
      assert.equal(marker.executorRoot, executorRoot);
      assert.ok(marker.argv.includes(path.join(executorRoot, "runtime", "worker", "managed-worker.js")));
      assert.equal(worker.executorRoot, executorRoot);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
