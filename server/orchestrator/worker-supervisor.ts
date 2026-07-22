import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { mkdir } from "node:fs/promises";
import { open, type FileHandle } from "node:fs/promises";
import { LooseRecord } from "../../shared/types.js";
import { WorkerStore } from "../../shared/orchestrator/worker-store.js";
import { executorEnv, resolveExecutorRoot } from "../services/executor-root.js";
import { assertHubWritable } from "../../shared/hub-maintenance.js";
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  killTree,
  sameProcessIdentity,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../../core/runtime/process-tree.js";

const IDLE_STOP_MS = 600_000; // 10 min idle → stop worker
const HEARTBEAT_STALE_MS = 60_000; // 60s without heartbeat → unhealthy
const MAX_RESTARTS = 3;

export class WorkerSupervisor {
  hubRoot: string;
  cpbRoot: string;
  executorRoot: string;
  workers: WorkerStore;
  _children: Map<string, ChildProcess>;
  _pendingStops: Map<string, { incarnationToken: string | null; processIdentity: ProcessIdentity; reason: string }>;
  _processSystem?: ProcessTreeSystem;
  _killGraceMs: number;
  _forceVerifyMs?: number;

  constructor(hubRoot: string, cpbRoot: string, { workerStore, executorRoot, processSystem, killGraceMs, forceVerifyMs }: LooseRecord = {}) {
    this.hubRoot = path.resolve(hubRoot);
    this.cpbRoot = path.resolve(cpbRoot);
    this.executorRoot = path.resolve(executorRoot || resolveExecutorRoot({
      env: process.env,
      fallbackRoot: this.cpbRoot,
    }));
    this.workers = workerStore instanceof WorkerStore ? workerStore : new WorkerStore(this.hubRoot);
    this._children = new Map(); // workerId → ChildProcess
    this._pendingStops = new Map();
    this._processSystem = processSystem as ProcessTreeSystem | undefined;
    this._killGraceMs = Number.isFinite(Number(killGraceMs)) ? Number(killGraceMs) : 2_000;
    this._forceVerifyMs = Number.isFinite(Number(forceVerifyMs)) ? Number(forceVerifyMs) : undefined;
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

    const childPid = child.pid;
    if (!Number.isInteger(childPid) || Number(childPid) <= 0) {
      await this.workers.updateWorkerIf(workerId, {
        status: "exited",
        brokerTokenHash: null,
        spawnError: "spawned worker did not expose a valid pid",
      }, { incarnationToken });
      throw Object.assign(new Error("spawned worker did not expose a valid pid"), { code: "WORKER_PID_UNAVAILABLE" });
    }

    let processIdentity: ProcessIdentity | null = null;
    let processIdentityError: Error | null = null;
    try {
      processIdentity = this._captureRequiredProcessIdentity(childPid as number);
    } catch (error) {
      processIdentityError = error instanceof Error ? error : new Error(String(error));
    }
    if (!processIdentity) {
      const error = Object.assign(
        new Error("worker process identity unavailable after spawn; cleanup not attempted without exact identity"),
        {
          code: "WORKER_PROCESS_IDENTITY_UNAVAILABLE",
          cleanupVerified: false,
          unregisteredChildPid: childPid,
          cause: processIdentityError || undefined,
        },
      );
      await this.workers.updateWorkerIf(workerId, {
        pid: childPid,
        processIdentity: null,
        status: "unhealthy",
        brokerTokenHash: null,
        spawnError: error.message,
        cleanupVerified: false,
        recoveryError: "missing_process_identity",
      }, { incarnationToken });
      throw error;
    }

    this._children.set(workerId, child);
    this._attachChildExitHandler({ child, workerId, incarnationToken, processIdentity, assignment });

    const persisted = await this.workers.updateWorkerIf(workerId, { pid: childPid, processIdentity }, { incarnationToken });
    if (!persisted) {
      this._pendingStops.set(workerId, { incarnationToken, processIdentity, reason: "spawn_identity_persist_failed" });
      await this._killIdentity(processIdentity);
      this._pendingStops.delete(workerId);
      throw Object.assign(new Error("worker incarnation changed before process identity was persisted"), { code: "WORKER_IDENTITY_PERSIST_FAILED" });
    }
    worker = persisted;

    return worker;
  }

  async stopWorker(workerId: string, reason: string) {
    const worker = await this.workers.getWorker(workerId);
    if (["exited", "exhausted"].includes(String(worker?.status || ""))) return worker;
    if (!worker) return null;
    if (!this._isLocalWorker(worker)) {
      throw Object.assign(new Error(`worker ${workerId} is not local; refusing bare remote stop`), { code: "WORKER_NOT_LOCAL" });
    }
    const identity = this._workerProcessIdentity(worker);
    if (!identity) {
      throw Object.assign(new Error(`worker ${workerId} has no persisted process identity; refusing bare pid stop`), {
        code: "WORKER_PROCESS_IDENTITY_UNAVAILABLE",
      });
    }
    if (worker.pid !== identity.pid) {
      throw Object.assign(new Error(`worker ${workerId} pid does not match persisted process identity`), {
        code: "WORKER_PROCESS_IDENTITY_MISMATCH",
      });
    }
    const incarnationToken = typeof worker.incarnationToken === "string" ? worker.incarnationToken : null;
    this._pendingStops.set(workerId, { incarnationToken, processIdentity: identity, reason });
    try {
      await this._killIdentity(identity);
    } catch (error) {
      this._pendingStops.delete(workerId);
      throw error;
    }
    const updated = incarnationToken
      ? await this.workers.updateWorkerIf(workerId, {
        status: "exited",
        stopReason: reason,
        exitSignal: "stop",
        brokerTokenHash: null,
      }, { incarnationToken })
      : await this.workers.updateWorker(workerId, {
        status: "exited",
        stopReason: reason,
        exitSignal: "stop",
        brokerTokenHash: null,
      });
    this._pendingStops.delete(workerId);
    return updated;
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
          if (this._isLocalWorker(worker)) {
            const identity = this._workerProcessIdentity(worker);
            if (!identity) {
              await this.workers.updateWorkerIf(worker.workerId, {
                status: "unhealthy",
                recoveryError: "missing_process_identity",
              }, { incarnationToken: worker.incarnationToken });
              continue;
            }
            await this.stopWorker(worker.workerId, "stale_heartbeat");
          }
        }
      }
      // Check if pid still alive
      if (worker.pid && worker.status !== "exited" && this._isLocalWorker(worker)) {
        const identity = this._workerProcessIdentity(worker);
        if (!identity) {
          await this.workers.updateWorkerIf(worker.workerId, {
            status: "unhealthy",
            recoveryError: "missing_process_identity",
          }, { incarnationToken: worker.incarnationToken });
          continue;
        }
        try {
          if (!isProcessIdentityAlive(identity, this._processSystem)) {
            await this.workers.updateWorkerIf(worker.workerId, { status: "exited" }, { incarnationToken: worker.incarnationToken });
          }
        } catch (error) {
          await this.workers.updateWorkerIf(worker.workerId, {
            status: "unhealthy",
            recoveryError: error instanceof Error ? error.message : String(error),
          }, { incarnationToken: worker.incarnationToken });
        }
      }
    }
  }

  _attachChildExitHandler({
    child,
    workerId,
    incarnationToken,
    processIdentity,
    assignment,
  }: {
    child: ChildProcess;
    workerId: string;
    incarnationToken: string;
    processIdentity: ProcessIdentity;
    assignment: LooseRecord;
  }) {
    child.on("exit", async (code) => {
      await this._handleChildExit({ workerId, incarnationToken, processIdentity, assignment, code });
    });
  }

  async _handleChildExit({
    workerId,
    incarnationToken,
    processIdentity,
    assignment,
    code,
  }: {
    workerId: string;
    incarnationToken: string;
    processIdentity: ProcessIdentity;
    assignment: LooseRecord;
    code: number | null;
  }) {
    this._children.delete(workerId);
    const current = await this.workers.getWorker(workerId);
    if (!current || current.incarnationToken !== incarnationToken || !sameProcessIdentity(processIdentity, this._workerProcessIdentity(current))) {
      return;
    }
    const pendingStop = this._pendingStops.get(workerId);
    const wasDeliberate = Boolean(
      (pendingStop && pendingStop.incarnationToken === incarnationToken && sameProcessIdentity(pendingStop.processIdentity, processIdentity))
      || current.status === "draining"
      || current.stopReason
      || current.exitSignal === "idle",
    );
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
      } catch (err: unknown) {
        await this.workers.updateWorkerIf(workerId, {
          status: "exhausted",
          restartError: err instanceof Error ? err.message : String(err),
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
  }

  _captureRequiredProcessIdentity(pid: number) {
    return captureProcessIdentity(pid, { strict: true, system: this._processSystem });
  }

  _workerProcessIdentity(worker: LooseRecord | null | undefined): ProcessIdentity | null {
    const identity = worker?.processIdentity;
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
    const record = identity as LooseRecord;
    const pid = Number(record.pid);
    const birthId = typeof record.birthId === "string" ? record.birthId : "";
    const incarnation = typeof record.incarnation === "string" ? record.incarnation : "";
    const capturedAt = typeof record.capturedAt === "string" ? record.capturedAt : "";
    const birthIdPrecision = typeof record.birthIdPrecision === "string" ? record.birthIdPrecision : undefined;
    const processGroupId = Number(record.processGroupId);
    if (
      !Number.isSafeInteger(pid)
      || pid <= 0
      || !birthId
      || !capturedAt
      || !Number.isFinite(Date.parse(capturedAt))
      || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
      || incarnation !== `${pid}:${birthId}`
      || birthIdPrecision !== "exact"
      || (record.processGroupId !== undefined && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
    ) return null;
    const parsed: ProcessIdentity = {
      pid: Number(record.pid),
      birthId,
      incarnation,
      capturedAt,
      birthIdPrecision: "exact",
    };
    if (Number.isSafeInteger(processGroupId) && processGroupId > 0) parsed.processGroupId = processGroupId;
    return parsed;
  }

  _isLocalWorker(worker: LooseRecord) {
    return !worker.host || worker.host === "local" || worker.host === os.hostname();
  }

  async _killIdentity(identity: ProcessIdentity) {
    const current = captureProcessIdentity(identity.pid, { strict: true, system: this._processSystem });
    if (!sameProcessIdentity(identity, current)) {
      throw Object.assign(new Error(`worker process identity mismatch for pid ${identity.pid}`), {
        code: "PROCESS_IDENTITY_MISMATCH",
      });
    }
    await killTree(identity.pid, this._killGraceMs, {
      requireDescendantScan: true,
      expectedRootIdentity: identity,
      system: this._processSystem,
      forceVerifyMs: this._forceVerifyMs,
    });
  }

}
