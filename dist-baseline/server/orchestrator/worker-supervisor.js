import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { open } from "node:fs/promises";
import { WorkerStore } from "../../shared/orchestrator/worker-store.js";
import { executorEnv, resolveExecutorRoot } from "../services/setup.js";
const IDLE_STOP_MS = 600_000; // 10 min idle → stop worker
const HEARTBEAT_STALE_MS = 60_000; // 60s without heartbeat → unhealthy
const MAX_RESTARTS = 3;
export class WorkerSupervisor {
    hubRoot;
    cpbRoot;
    executorRoot;
    workers;
    _children;
    constructor(hubRoot, cpbRoot, { workerStore, executorRoot } = {}) {
        this.hubRoot = path.resolve(hubRoot);
        this.cpbRoot = path.resolve(cpbRoot);
        this.executorRoot = path.resolve(executorRoot || resolveExecutorRoot({
            env: process.env,
            fallbackRoot: this.cpbRoot,
        }));
        this.workers = workerStore;
        this._children = new Map(); // workerId → ChildProcess
    }
    async ensureWorkerFor(assignment, worker) {
        if (worker && worker.status === "ready")
            return worker;
        if (worker && worker.status === "starting")
            return worker;
        return this.startWorker(assignment);
    }
    async startWorker(assignment) {
        const workerId = WorkerStore.makeWorkerId();
        const executorRoot = this.executorRoot;
        const logDir = path.join(this.hubRoot, "logs");
        await mkdir(logDir, { recursive: true });
        const logFd = await open(path.join(logDir, `worker-${workerId}.log`), "a");
        const child = spawn(process.execPath, [
            path.join(executorRoot, "runtime", "worker", "managed-worker.js"),
            "--worker-id", workerId,
            "--hub-root", this.hubRoot,
            "--cpb-root", this.cpbRoot,
        ], {
            cwd: executorRoot,
            env: {
                ...executorEnv(process.env, { cpbRoot: this.cpbRoot, executorRoot }),
                CPB_HUB_ROOT: this.hubRoot,
            },
            detached: true,
            stdio: ["ignore", logFd, logFd],
        });
        child.unref();
        this._children.set(workerId, child);
        const restartCount = assignment._restartCount || 0;
        const worker = await this.workers.registerWorker(workerId, {
            projectId: assignment.projectId,
            pid: child.pid,
            status: "starting",
            executorRoot,
            restartCount,
        });
        child.on("exit", async (code) => {
            this._children.delete(workerId);
            const current = await this.workers.getWorker(workerId);
            const wasDeliberate = current?.status === "draining" || current?.stopReason;
            await this.workers.updateWorker(workerId, {
                status: "exited",
                exitCode: code,
            });
            const nextRestart = (current?.restartCount || 0) + 1;
            if (!wasDeliberate && nextRestart <= MAX_RESTARTS) {
                await this.workers.updateWorker(workerId, {
                    restartCount: nextRestart,
                    status: "restarting",
                });
                try {
                    await this.startWorker({ ...assignment, _restartOf: workerId, _restartCount: nextRestart });
                }
                catch (err) {
                    await this.workers.updateWorker(workerId, {
                        status: "exhausted",
                        restartError: err.message,
                    });
                }
            }
            else if (!wasDeliberate) {
                await this.workers.updateWorker(workerId, {
                    status: "exhausted",
                });
            }
        });
        return worker;
    }
    async stopWorker(workerId, reason) {
        const child = this._children.get(workerId);
        const worker = await this.workers.getWorker(workerId);
        const pid = child?.pid || worker?.pid;
        if (pid) {
            this._killProcessGroup(pid);
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
            if (worker.status === "exited" || worker.status === "draining")
                continue;
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
                try {
                    process.kill(worker.pid, 0);
                }
                catch {
                    this._killProcessGroup(worker.pid);
                    await this.workers.updateWorker(worker.workerId, { status: "exited" });
                }
            }
        }
    }
    _killProcessGroup(pid) {
        if (!pid)
            return;
        try {
            process.kill(-pid, "SIGTERM");
        }
        catch { /* no group or already dead */ }
        try {
            process.kill(pid, "SIGTERM");
        }
        catch { /* already dead */ }
    }
}
