import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { open } from "node:fs/promises";
import { WorkerStore } from "./worker-store.js";

const IDLE_STOP_MS = 600_000; // 10 min idle → stop worker
const HEARTBEAT_STALE_MS = 60_000; // 60s without heartbeat → unhealthy
const MAX_RESTARTS = 3;

export class WorkerSupervisor {
  constructor(hubRoot, cpbRoot, { workerStore }) {
    this.hubRoot = hubRoot;
    this.cpbRoot = cpbRoot;
    this.workers = workerStore;
    this._children = new Map(); // workerId → ChildProcess
  }

  async ensureWorkerFor(assignment, worker) {
    if (worker && worker.status === "ready") return worker;
    if (worker && worker.status === "starting") return worker;

    // Start a new worker
    return this.startWorker(assignment);
  }

  async startWorker(assignment) {
    const workerId = WorkerStore.makeWorkerId();
    const executorRoot = this.cpbRoot;

    const logDir = path.join(this.hubRoot, "logs");
    await mkdir(logDir, { recursive: true });
    const logFd = await open(path.join(logDir, `worker-${workerId}.log`), "a");
    const child = spawn(process.execPath, [
      path.join(executorRoot, "runtime/worker/managed-worker.js"),
      "--worker-id", workerId,
      "--hub-root", this.hubRoot,
      "--cpb-root", this.cpbRoot,
    ], {
      cwd: this.cpbRoot,
      env: { ...process.env, CPB_ROOT: this.cpbRoot, CPB_HUB_ROOT: this.hubRoot },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();

    this._children.set(workerId, child);

    const worker = await this.workers.registerWorker(workerId, {
      projectId: assignment.projectId,
      pid: child.pid,
      status: "starting",
    });

    child.on("exit", async (code) => {
      this._children.delete(workerId);
      await this.workers.updateWorker(workerId, {
        status: "exited",
        exitCode: code,
      });
    });

    return worker;
  }

  async stopWorker(workerId, reason) {
    const child = this._children.get(workerId);
    if (child?.pid) {
      this._killProcessGroup(child.pid);
    }
    await this.workers.updateWorker(workerId, {
      status: "draining",
      stopReason: reason,
    });
  }

  async checkHealth() {
    const workers = await this.workers.listWorkers();
    const now = Date.now();

    for (const worker of workers) {
      if (worker.status === "exited" || worker.status === "draining") continue;

      const lastHb = worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).getTime() : 0;
      if (now - lastHb > HEARTBEAT_STALE_MS && worker.status !== "starting") {
        await this.workers.updateWorker(worker.workerId, { status: "unhealthy" });
      }

      // Idle worker cleanup
      if (worker.status === "ready" && !worker.currentAssignmentId && worker.startedAt) {
        const startedAt = new Date(worker.startedAt).getTime();
        if (now - startedAt > IDLE_STOP_MS) {
          await this.stopWorker(worker.workerId, "idle_timeout");
        }
      }
    }
  }

  async recoverWorkers() {
    const workers = await this.workers.listWorkers();
    for (const worker of workers) {
      // Mark stale workers
      if (worker.status === "running" || worker.status === "assigned") {
        const lastHb = worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).getTime() : 0;
        if (Date.now() - lastHb > HEARTBEAT_STALE_MS * 2) {
          this._killProcessGroup(worker.pid);
          await this.workers.updateWorker(worker.workerId, { status: "exited" });
        }
      }
      // Check if pid still alive
      if (worker.pid && worker.status !== "exited") {
        try { process.kill(worker.pid, 0); } catch {
          this._killProcessGroup(worker.pid);
          await this.workers.updateWorker(worker.workerId, { status: "exited" });
        }
      }
    }
  }

  _killProcessGroup(pid) {
    if (!pid) return;
    try { process.kill(-pid, "SIGTERM"); } catch { /* no group or already dead */ }
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }
}
