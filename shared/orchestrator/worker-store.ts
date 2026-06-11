import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { writeJsonAtomic } from "../fs-utils.js";

const WORKERS_DIR = "workers";

export class WorkerStore {
  baseDir: string;
  registryDir: string;
  inboxDir: string;

  constructor(hubRoot: string) {
    this.baseDir = path.join(hubRoot, WORKERS_DIR);
    this.registryDir = path.join(this.baseDir, "registry");
    this.inboxDir = path.join(this.baseDir, "inbox");
  }

  async init() {
    await mkdir(this.registryDir, { recursive: true });
    await mkdir(this.inboxDir, { recursive: true });
  }

  async registerWorker(workerId: string, meta: Record<string, any> = {}) {
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
    await writeJsonAtomic(file, worker);
    return worker;
  }

  async updateWorker(workerId: string, updates: Record<string, any>) {
    const worker = await this.getWorker(workerId);
    if (!worker) return null;
    const updated = { ...worker, ...updates, lastHeartbeatAt: new Date().toISOString() };
    await writeJsonAtomic(
      path.join(this.registryDir, `worker-${workerId}.json`),
      updated,
    );
    return updated;
  }

  async getWorker(workerId: string) {
    try {
      return JSON.parse(await readFile(path.join(this.registryDir, `worker-${workerId}.json`), "utf8"));
    } catch { return null; }
  }

  async listWorkers(filter: Record<string, any> = {}) {
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

  async findIdleWorker(projectId?: string) {
    const workers = await this.listWorkers();
    for (const worker of workers) {
      if (worker.status !== "ready") continue;
      if (projectId && worker.projectId && worker.projectId !== projectId) continue;
      if (worker.currentAssignmentId) continue;
      if (await this.hasInboxWork(worker.workerId)) continue;
      return worker;
    }
    return null;
  }

  async hasInboxWork(workerId: string) {
    const inboxDir = path.join(this.inboxDir, workerId);
    const hasJsonFile = async (dir: string) => {
      try {
        return (await readdir(dir)).some((file) => file.endsWith(".json"));
      } catch {
        return false;
      }
    };
    return await hasJsonFile(inboxDir) || await hasJsonFile(path.join(inboxDir, "processing"));
  }

  async writeInbox(workerId: string, assignment: Record<string, any>) {
    const dir = path.join(this.inboxDir, workerId);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(
      path.join(dir, `${assignment.assignmentId}.json`),
      assignment,
    );
  }

  async readInbox(workerId: string) {
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

  async clearInboxEntry(workerId: string, assignmentId: string) {
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(path.join(this.inboxDir, workerId, `${assignmentId}.json`));
    } catch { /* already cleared */ }
  }

  async pruneDead() {
    const workers = await this.listWorkers();
    const { unlink, rm } = await import("node:fs/promises");
    let removed = 0;
    for (const worker of workers) {
      if (worker.status === "exited" || (worker.status === "unhealthy" && !this._isAlive(worker.pid))) {
        try { await unlink(path.join(this.registryDir, `worker-${worker.workerId}.json`)); } catch {}
        try { await rm(path.join(this.inboxDir, worker.workerId), { recursive: true, force: true }); } catch {}
        removed++;
      }
    }
    return removed;
  }

  _isAlive(pid: unknown) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  static makeWorkerId() {
    return `w-${crypto.randomBytes(4).toString("hex")}`;
  }
}

export function summarizeWorkers(workers: Array<Record<string, any>> = []) {
  const counts: Record<string, number> = { ready: 0, running: 0, unhealthy: 0, exited: 0 };
  for (const worker of workers) {
    const status = worker.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}
