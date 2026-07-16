import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import { open, type FileHandle } from "node:fs/promises";
import { LooseRecord } from "../../shared/types.js";
import { WorkerStore } from "../../shared/orchestrator/worker-store.js";
import { executorEnv, resolveExecutorRoot } from "../services/setup.js";
import { assertHubWritable } from "../../shared/hub-maintenance.js";

const IDLE_STOP_MS = 600_000; // 10 min idle → stop worker
const HEARTBEAT_STALE_MS = 60_000; // 60s without heartbeat → unhealthy
const MAX_RESTARTS = 3;

export class WorkerSupervisor {
  hubRoot: string;
  cpbRoot: string;
  executorRoot: string;
  workers: WorkerStore;
  _children: Map<string, ChildProcess>;

  constructor(hubRoot: string, cpbRoot: string, { workerStore, executorRoot }: LooseRecord = {}) {
    this.hubRoot = path.resolve(hubRoot);
    this.cpbRoot = path.resolve(cpbRoot);
    this.executorRoot = path.resolve(executorRoot || resolveExecutorRoot({
      env: process.env,
      fallbackRoot: this.cpbRoot,
    }));
    this.workers = workerStore instanceof WorkerStore ? workerStore : new WorkerStore(this.hubRoot);
    this._children = new Map(); // workerId → ChildProcess
  }

  async ensureWorkerFor(assignment: LooseRecord, worker: LooseRecord | null) {
    if (worker && worker.status === "ready") return worker;
    if (worker && worker.status === "starting") return worker;

    return this.startWorker(assignment);
  }

  async startWorker(assignment: LooseRecord) {
    await assertHubWritable(this.hubRoot);
    const workerId = WorkerStore.makeWorkerId();
    const incarnationToken = crypto.randomUUID();
    const brokerToken = crypto.randomBytes(32).toString("base64url");
    const brokerTokenHash = crypto.createHash("sha256").update(brokerToken, "utf8").digest("hex");
    const brokerUrl = process.env.CPB_HUB_WORKER_BROKER_URL || "";
    const redisConfigFile = process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE || "";
    if (redisConfigFile && !brokerUrl) {
      throw Object.assign(
        new Error("managed workers require CPB_HUB_WORKER_BROKER_URL when Redis shared state is enabled"),
        { code: "HUB_WORKER_BROKER_REQUIRED" },
      );
    }
    const executorRoot = this.executorRoot;
    const restartCount = assignment._restartCount || 0;

    // Publish the capability hash before spawn. Otherwise a fast worker can
    // reach the broker before its credential exists and fail authentication.
    let worker = await this.workers.registerWorker(workerId, {
      projectId: assignment.projectId,
      pid: null,
      status: "starting",
      executorRoot,
      restartCount,
      incarnationToken,
      brokerTokenHash,
    });

    const logDir = path.join(this.hubRoot, "logs");
    await mkdir(logDir, { recursive: true });
    const logFd = await open(path.join(logDir, `worker-${workerId}.log`), "a");
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [
        path.join(executorRoot, "runtime", "worker", "managed-worker.js"),
        "--worker-id", workerId,
        "--hub-root", this.hubRoot,
        "--cpb-root", this.cpbRoot,
      ], {
        cwd: executorRoot,
        env: {
          ...executorEnv(process.env, { cpbRoot: this.cpbRoot, executorRoot }),
          CPB_HUB_ROOT: this.hubRoot,
          // Redis credentials remain in the Hub. Managed workers receive only a
          // short-lived, worker/incarnation-scoped broker capability.
          CPB_WORKER_INCARNATION_TOKEN: incarnationToken,
          ...(brokerUrl ? {
            CPB_HUB_WORKER_BROKER_URL: brokerUrl,
            CPB_HUB_WORKER_BROKER_TOKEN: brokerToken,
          } : {}),
        },
        detached: true,
        // retain: dynamic @types/node gap — spawn stdio accepts a FileHandle at runtime
        // (libuv passes its fd to the child), but StdioOptions' union omits FileHandle.
        // Switching to logFd.fd would change the runtime code path, so cast to satisfy types.
        stdio: ["ignore", logFd as unknown as NodeJS.WriteStream, logFd as unknown as NodeJS.WriteStream],
      });
    } catch (error) {
      await logFd.close().catch(() => {});
      await this.workers.updateWorkerIf(workerId, {
        status: "exited",
        brokerTokenHash: null,
        spawnError: error instanceof Error ? error.message : String(error),
      }, { incarnationToken });
      throw error;
    }
    child.unref();
    await logFd.close().catch(() => {});

    this._children.set(workerId, child);

    child.on("exit", async (code) => {
      this._children.delete(workerId);
      const current = await this.workers.getWorker(workerId);
      const wasDeliberate = current?.status === "draining" || current?.stopReason || current?.exitSignal === "idle";
      await this.workers.updateWorkerIf(workerId, {
        status: "exited",
        exitCode: code,
        brokerTokenHash: null,
      }, {
        incarnationToken,
      });

      const nextRestart = (current?.restartCount || 0) + 1;
      if (!wasDeliberate && nextRestart <= MAX_RESTARTS) {
        await this.workers.updateWorkerIf(workerId, {
          restartCount: nextRestart,
          status: "restarting",
        }, {
          incarnationToken,
        });
        try {
          await this.startWorker({ ...assignment, _restartOf: workerId, _restartCount: nextRestart });
        } catch (err) {
          await this.workers.updateWorkerIf(workerId, {
            status: "exhausted",
            restartError: err.message,
          }, {
            incarnationToken,
          });
        }
      } else if (!wasDeliberate) {
        await this.workers.updateWorkerIf(workerId, {
          status: "exhausted",
        }, {
          incarnationToken,
        });
      }
    });

    worker = await this.workers.updateWorkerIf(workerId, { pid: child.pid }, { incarnationToken }) || worker;

    return worker;
  }

  async stopWorker(workerId: string, reason: string) {
    const child = this._children.get(workerId);
    const worker = await this.workers.getWorker(workerId);
    if (!child && ["exited", "exhausted"].includes(String(worker?.status || ""))) return worker;
    await this.workers.updateWorker(workerId, {
      status: "draining",
      stopReason: reason,
    });
    const pid = child?.pid || worker?.pid;
    if (pid && (!worker?.host || worker.host === "local" || worker.host === os.hostname())) {
      this._killProcessGroup(pid);
    }
  }

  async checkHealth() {
    const workers = await this.workers.listWorkers();
    const now = await this.workers.authorityTimeMs();

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
    const now = await this.workers.authorityTimeMs();
    for (const worker of workers) {
      // Mark stale workers
      if (worker.status === "running" || worker.status === "assigned") {
        const lastHb = worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).getTime() : 0;
        if (now - lastHb > HEARTBEAT_STALE_MS * 2) {
          if (!worker.host || worker.host === "local" || worker.host === os.hostname()) this._killProcessGroup(worker.pid);
          await this.workers.updateWorker(worker.workerId, { status: "exited" });
        }
      }
      // Check if pid still alive
      if (worker.pid && worker.status !== "exited" && (!worker.host || worker.host === "local" || worker.host === os.hostname())) {
        try { process.kill(worker.pid, 0); } catch {
          this._killProcessGroup(worker.pid);
          await this.workers.updateWorker(worker.workerId, { status: "exited" });
        }
      }
    }
  }

  _killProcessGroup(pid: number | null | undefined) {
    if (!pid) return;
    try { process.kill(-pid, "SIGTERM"); } catch { /* no group or already dead */ }
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }
}
