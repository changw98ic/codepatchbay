import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const WORKERS_DIR = "workers";

export class WorkerStore {
  constructor(hubRoot) {
    this.baseDir = path.join(hubRoot, WORKERS_DIR);
    this.registryDir = path.join(this.baseDir, "registry");
    this.inboxDir = path.join(this.baseDir, "inbox");
  }

  async init() {
    await mkdir(this.registryDir, { recursive: true });
    await mkdir(this.inboxDir, { recursive: true });
  }

  async registerWorker(workerId, meta = {}) {
    const file = path.join(this.registryDir, `worker-${workerId}.json`);
    const worker = {
      workerId,
      projectId: meta.projectId || null,
      pid: meta.pid || null,
      host: meta.host || "local",
      status: "starting",
      currentAssignmentId: null,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      restartCount: 0,
      ...meta,
    };
    await writeFile(file, JSON.stringify(worker, null, 2) + "\n", "utf8");
    return worker;
  }

  async updateWorker(workerId, updates) {
    const worker = await this.getWorker(workerId);
    if (!worker) return null;
    const updated = { ...worker, ...updates, lastHeartbeatAt: new Date().toISOString() };
    await writeFile(
      path.join(this.registryDir, `worker-${workerId}.json`),
      JSON.stringify(updated, null, 2) + "\n",
      "utf8",
    );
    return updated;
  }

  async getWorker(workerId) {
    try {
      return JSON.parse(await readFile(path.join(this.registryDir, `worker-${workerId}.json`), "utf8"));
    } catch { return null; }
  }

  async listWorkers(filter = {}) {
    const workers = [];
    try {
      const files = await readdir(this.registryDir);
      for (const file of files) {
        if (!file.startsWith("worker-")) continue;
        try {
          const worker = JSON.parse(await readFile(path.join(this.registryDir, file), "utf8"));
          if (filter.status && worker.status !== filter.status) continue;
          workers.push(worker);
        } catch { /* skip malformed */ }
      }
    } catch { /* no registry yet */ }
    return workers;
  }

  async findIdleWorker(projectId) {
    const workers = await this.listWorkers();
    return workers.find(w =>
      w.status === "ready" &&
      (!projectId || !w.projectId || w.projectId === projectId) &&
      !w.currentAssignmentId,
    ) || null;
  }

  async writeInbox(workerId, assignment) {
    const dir = path.join(this.inboxDir, workerId);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${assignment.assignmentId}.json`),
      JSON.stringify(assignment, null, 2) + "\n",
      "utf8",
    );
  }

  async readInbox(workerId) {
    const dir = path.join(this.inboxDir, workerId);
    const entries = [];
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          entries.push(JSON.parse(await readFile(path.join(dir, file), "utf8")));
        } catch { /* skip malformed */ }
      }
    } catch { /* no inbox */ }
    return entries;
  }

  async clearInboxEntry(workerId, assignmentId) {
    try {
      const file = path.join(this.inboxDir, workerId, `${assignmentId}.json`);
      const { unlink } = await import("node:fs/promises");
      await unlink(file);
    } catch { /* already cleared */ }
  }

  static makeWorkerId() {
    return `w-${crypto.randomBytes(4).toString("hex")}`;
  }
}
