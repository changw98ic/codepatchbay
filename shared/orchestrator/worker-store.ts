import type { LooseRecord } from "../types.js";
import { mkdir, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { writeJsonAtomic } from "../fs-utils.js";
import { assertHubWritable } from "../hub-maintenance.js";
import { openPinnedHubRedisStateBackend, type HubRedisStateBackend } from "../hub-state-redis.js";
import { processLeaderFence } from "../hub-leader-fence.js";

const WORKERS_DIR = "workers";
export const INBOX_CLAIM_TTL_MS = 60_000;

export type WorkerUpdateExpectation = {
  incarnationToken?: string;
  currentAssignmentId?: string | null;
  currentAttemptToken?: string | null;
  status?: string | string[];
};

function workerMatchesExpectation(worker: LooseRecord, expected: WorkerUpdateExpectation) {
  if (expected.incarnationToken !== undefined && worker.incarnationToken !== expected.incarnationToken) return false;
  if (Object.prototype.hasOwnProperty.call(expected, "currentAssignmentId")
    && (worker.currentAssignmentId ?? null) !== expected.currentAssignmentId) return false;
  if (Object.prototype.hasOwnProperty.call(expected, "currentAttemptToken")
    && (worker.currentAttemptToken ?? null) !== expected.currentAttemptToken) return false;
  if (expected.status !== undefined) {
    const allowed = Array.isArray(expected.status) ? expected.status : [expected.status];
    if (!allowed.includes(String(worker.status || ""))) return false;
  }
  return true;
}

export class WorkerStore {
  hubRoot: string;
  baseDir: string;
  registryDir: string;
  inboxDir: string;
  _redisBackend: HubRedisStateBackend | null | undefined;

  constructor(hubRoot: string) {
    this.hubRoot = path.resolve(hubRoot);
    this.baseDir = path.join(this.hubRoot, WORKERS_DIR);
    this.registryDir = path.join(this.baseDir, "registry");
    this.inboxDir = path.join(this.baseDir, "inbox");
    this._redisBackend = undefined;
  }

  async _backend() {
    if (this._redisBackend !== undefined) return this._redisBackend;
    this._redisBackend = await openPinnedHubRedisStateBackend({
      configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
      hubRoot: this.hubRoot,
    });
    return this._redisBackend;
  }

  async usesSharedState() {
    return Boolean(await this._backend());
  }

  _recordPart(value: string) {
    return Buffer.from(String(value), "utf8").toString("base64url");
  }

  _workerField(workerId: string) {
    return `worker:${this._recordPart(workerId)}`;
  }

  _inboxPrefix(workerId: string) {
    return `workerInbox:${this._recordPart(workerId)}:`;
  }

  _inboxField(workerId: string, assignmentId: string, attempt?: unknown, attemptToken?: unknown) {
    const attemptPart = Number.isInteger(attempt) && Number(attempt) > 0 ? `:${attempt}` : "";
    const tokenPart = typeof attemptToken === "string" && attemptToken
      ? `:${this._recordPart(attemptToken)}`
      : "";
    return `${this._inboxPrefix(workerId)}${this._recordPart(assignmentId)}${attemptPart}${tokenPart}`;
  }

  async _mutateRedisRecord<T>(
    backend: HubRedisStateBackend,
    field: string,
    callback: (current: LooseRecord | null) => { data: LooseRecord | null; result: T },
  ): Promise<T> {
    const fence = processLeaderFence(backend.identityFingerprint);
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const snapshot = await backend.readStateRecord(field);
      const current = snapshot.data && typeof snapshot.data === "object" && !Array.isArray(snapshot.data)
        ? snapshot.data as LooseRecord
        : null;
      if (snapshot.data !== null && !current) {
        throw Object.assign(new Error(`invalid Redis worker state record: ${field}`), { code: "HUB_STATE_RECORD_INVALID" });
      }
      const mutation = callback(current);
      const committed = await backend.compareAndSwapStateRecord(field, snapshot.revision, mutation.data, fence);
      if (committed.fenced) {
        throw Object.assign(new Error("leader lease no longer authorizes this worker-state write"), { code: "HUB_LEADER_FENCED" });
      }
      if (committed.committed) return mutation.result;
    }
    throw Object.assign(new Error(`worker state changed too frequently: ${field}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }

  async init() {
    await assertHubWritable(this.hubRoot);
    const backend = await this._backend();
    if (backend) {
      await backend.preflight();
      const [workers, inboxes] = await Promise.all([
        backend.scanStateRecords("worker:"),
        backend.scanStateRecords("workerInbox:"),
      ]);
      if (await this._hasLocalWorkerState()) {
        throw Object.assign(
          new Error("local worker registry or inbox state requires an explicit Redis migration"),
          { code: "HUB_WORKER_MIGRATION_REQUIRED" },
        );
      }
      return;
    }
    await mkdir(this.registryDir, { recursive: true });
    await mkdir(this.inboxDir, { recursive: true });
  }

  async _hasLocalWorkerState() {
    const registryFiles = await readdir(this.registryDir).catch((): string[] => []);
    if (registryFiles.some((file) => file.endsWith(".json"))) return true;
    const workerDirs = await readdir(this.inboxDir).catch((): string[] => []);
    for (const workerDir of workerDirs) {
      const root = path.join(this.inboxDir, workerDir);
      const pending = await readdir(root).catch((): string[] => []);
      if (pending.some((file) => file.endsWith(".json"))) return true;
      const processing = await readdir(path.join(root, "processing")).catch((): string[] => []);
      if (processing.some((file) => file.endsWith(".json"))) return true;
    }
    return false;
  }

  async registerWorker(workerId: string, meta: LooseRecord = {}) {
    await assertHubWritable(this.hubRoot);
    const backend = await this._backend();
    const authorityNow = new Date(backend ? await backend.serverTimeMs() : Date.now()).toISOString();
    const requestedIncarnation = typeof meta.incarnationToken === "string" && meta.incarnationToken
      ? meta.incarnationToken
      : null;
    const worker = {
      projectId: meta.projectId || null,
      pid: meta.pid || null,
      host: meta.host || os.hostname(),
      status: "starting",
      currentAssignmentId: null,
      restartCount: 0,
      ...meta,
      workerId,
      startedAt: authorityNow,
      lastHeartbeatAt: authorityNow,
      incarnationToken: requestedIncarnation,
    };
    if (backend) {
      return this._mutateRedisRecord(backend, this._workerField(workerId), (current) => {
        const incarnationToken = requestedIncarnation || current?.incarnationToken || crypto.randomUUID();
        const merged: LooseRecord = { ...current, ...worker, incarnationToken };
        const sameIncarnation = Boolean(current && current.incarnationToken === incarnationToken);
        if (sameIncarnation && current.currentAssignmentId) {
          merged.currentAssignmentId = current.currentAssignmentId;
          merged.currentAttemptToken = current.currentAttemptToken ?? null;
          if (["assigned", "running"].includes(String(current.status || ""))) {
            merged.status = current.status;
          }
        }
        if (worker.status === "starting" && current?.status && current.status !== "starting") {
          merged.status = current.status;
        }
        return { data: merged, result: merged };
      });
    }
    worker.incarnationToken ||= crypto.randomUUID();
    const file = path.join(this.registryDir, `worker-${workerId}.json`);
    await writeJsonAtomic(file, worker);
    return worker;
  }

  async updateWorker(workerId: string, updates: LooseRecord) {
    return this.updateWorkerIf(workerId, updates, {});
  }

  async updateWorkerIf(workerId: string, updates: LooseRecord, expected: WorkerUpdateExpectation) {
    await assertHubWritable(this.hubRoot);
    const backend = await this._backend();
    if (backend) {
      const authorityNow = new Date(await backend.serverTimeMs()).toISOString();
      return this._mutateRedisRecord(backend, this._workerField(workerId), (worker) => {
        if (!worker) return { data: null, result: null };
        if (!workerMatchesExpectation(worker, expected)) return { data: worker, result: null };
        const updated = { ...worker, ...updates, lastHeartbeatAt: authorityNow };
        return { data: updated, result: updated };
      });
    }
    const worker = await this.getWorker(workerId);
    if (!worker) return null;
    if (!workerMatchesExpectation(worker, expected)) return null;
    const updated = { ...worker, ...updates, lastHeartbeatAt: new Date().toISOString() };
    await writeJsonAtomic(
      path.join(this.registryDir, `worker-${workerId}.json`),
      updated,
    );
    return updated;
  }

  async authorityTimeMs() {
    const backend = await this._backend();
    return backend ? await backend.serverTimeMs() : Date.now();
  }

  async getWorker(workerId: string) {
    const backend = await this._backend();
    if (backend) {
      const record = await backend.readStateRecord(this._workerField(workerId));
      return record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : null;
    }
    try {
      return JSON.parse(await readFile(path.join(this.registryDir, `worker-${workerId}.json`), "utf8"));
    } catch { return null; }
  }

  async listWorkers(filter: LooseRecord = {}) {
    const backend = await this._backend();
    if (backend) {
      const records = await backend.scanStateRecords("worker:");
      return records.flatMap(({ record }) => {
        const worker = record.data && typeof record.data === "object" && !Array.isArray(record.data)
          ? record.data as LooseRecord
          : null;
        if (!worker || (filter.status && worker.status !== filter.status)) return [];
        return [worker];
      });
    }
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
    const backend = await this._backend();
    if (backend) return (await backend.scanStateRecords(this._inboxPrefix(workerId))).length > 0;
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

  async writeInbox(workerId: string, assignment: LooseRecord) {
    await assertHubWritable(this.hubRoot);
    const assignmentId = String(assignment.assignmentId || "");
    if (!assignmentId) throw new Error("assignmentId is required for worker inbox");
    const backend = await this._backend();
    if (backend) {
      const attempt = Number(assignment.attempt);
      const attemptToken = String(assignment.attemptToken || "");
      if (!Number.isInteger(attempt) || attempt < 1 || !attemptToken) {
        throw new Error("attempt and attemptToken are required for Redis worker inbox");
      }
      return this._mutateRedisRecord(backend, this._inboxField(workerId, assignmentId, attempt, attemptToken), (current) => {
        if (current) {
          const existingPayload = current.payload as LooseRecord | undefined;
          if (existingPayload?.attempt !== attempt || existingPayload?.attemptToken !== attemptToken) {
            throw Object.assign(new Error("worker inbox idempotency conflict"), { code: "HUB_STATE_RECORD_CONFLICT" });
          }
          return { data: current, result: current };
        }
        const record = {
          workerId,
          assignmentId,
          status: "pending",
          payload: assignment,
          writtenAt: new Date().toISOString(),
        };
        return { data: record, result: record };
      });
    }
    const dir = path.join(this.inboxDir, workerId);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(
      path.join(dir, `${assignment.assignmentId}.json`),
      assignment,
    );
  }

  async readInbox(workerId: string) {
    const backend = await this._backend();
    if (backend) {
      return (await backend.scanStateRecords(this._inboxPrefix(workerId))).flatMap(({ record }) => {
        const inbox = record.data && typeof record.data === "object" && !Array.isArray(record.data)
          ? record.data as LooseRecord
          : null;
        const payload = inbox?.payload;
        return payload && typeof payload === "object" && !Array.isArray(payload) ? [payload] : [];
      });
    }
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
    await assertHubWritable(this.hubRoot);
    const backend = await this._backend();
    if (backend) {
      for (const { field, record } of await backend.scanStateRecords(this._inboxPrefix(workerId))) {
        const inbox = record.data as LooseRecord | null;
        if (inbox?.assignmentId === assignmentId) {
          await this._mutateRedisRecord(backend, field, () => ({ data: null, result: undefined }));
        }
      }
      return;
    }
    try {
      await unlink(path.join(this.inboxDir, workerId, `${assignmentId}.json`));
    } catch { /* already cleared */ }
  }

  async claimInboxEntries(workerId: string, incarnationToken?: string) {
    const backend = await this._backend();
    if (backend) {
      const claims: Array<{ assignmentId: string; assignment: LooseRecord; claimToken: string }> = [];
      const nowMs = await backend.serverTimeMs();
      const records = await backend.scanStateRecords(this._inboxPrefix(workerId));
      records.sort((left, right) => left.field.localeCompare(right.field));
      for (const { field } of records) {
        const claimToken = crypto.randomUUID();
        const claim = await this._mutateRedisRecord(backend, field, (current) => {
          const expired = current?.status === "processing"
            && Number(current.claimExpiresAtMs || 0) <= nowMs;
          if (!current || (current.status !== "pending" && !expired)) return { data: current, result: null };
          const payload = current.payload;
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            throw Object.assign(new Error(`invalid Redis inbox payload: ${field}`), { code: "HUB_STATE_RECORD_INVALID" });
          }
          return {
            data: {
              ...current,
              status: "processing",
              claimToken,
              claimedBy: workerId,
              claimedIncarnationToken: incarnationToken || null,
              claimedAt: new Date(nowMs).toISOString(),
              claimExpiresAtMs: nowMs + INBOX_CLAIM_TTL_MS,
            },
            result: { assignmentId: String(current.assignmentId || ""), assignment: payload as LooseRecord, claimToken },
          };
        });
        if (claim) {
          claims.push(claim);
          break;
        }
      }
      return claims;
    }

    const dir = path.join(this.inboxDir, workerId);
    const processingDir = path.join(dir, "processing");
    await mkdir(processingDir, { recursive: true });
    const claims: Array<{ assignmentId: string; assignment: LooseRecord; claimToken: string }> = [];
    const files = await readdir(dir).catch((): string[] => []);
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const source = path.join(dir, file);
      const claimed = path.join(processingDir, file);
      try {
        await rename(source, claimed);
      } catch {
        continue;
      }
      try {
        const assignment = JSON.parse(await readFile(claimed, "utf8"));
        if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) throw new Error("invalid inbox payload");
        claims.push({ assignmentId: file.slice(0, -5), assignment, claimToken: claimed });
      } catch {
        claims.push({
          assignmentId: file.slice(0, -5),
          assignment: { __malformedInbox: true },
          claimToken: claimed,
        });
      }
    }
    return claims;
  }

  async completeInboxClaim(workerId: string, assignmentId: string, claimToken: string) {
    await assertHubWritable(this.hubRoot);
    const backend = await this._backend();
    if (backend) {
      for (const { field, record } of await backend.scanStateRecords(this._inboxPrefix(workerId))) {
        const inbox = record.data as LooseRecord | null;
        if (inbox?.assignmentId !== assignmentId || inbox.claimToken !== claimToken) continue;
        return this._mutateRedisRecord(backend, field, (current) => {
          if (!current || current.status !== "processing" || current.claimToken !== claimToken) {
            return { data: current, result: false };
          }
          return { data: null, result: true };
        });
      }
      return false;
    }
    if (!claimToken.startsWith(path.join(this.inboxDir, workerId, "processing") + path.sep)) return false;
    try {
      await unlink(claimToken);
      return true;
    } catch {
      return false;
    }
  }

  async renewInboxClaim(workerId: string, assignmentId: string, claimToken: string, incarnationToken?: string) {
    const backend = await this._backend();
    if (!backend) return true;
    const nowMs = await backend.serverTimeMs();
    for (const { field, record } of await backend.scanStateRecords(this._inboxPrefix(workerId))) {
      const inbox = record.data as LooseRecord | null;
      if (inbox?.assignmentId !== assignmentId || inbox.claimToken !== claimToken) continue;
      return this._mutateRedisRecord(backend, field, (current) => {
        if (!current || current.status !== "processing" || current.claimToken !== claimToken
          || (incarnationToken && current.claimedIncarnationToken !== incarnationToken)) {
          return { data: current, result: false };
        }
        return {
          data: { ...current, claimExpiresAtMs: nowMs + INBOX_CLAIM_TTL_MS },
          result: true,
        };
      });
    }
    return false;
  }

  async pruneDead() {
    await assertHubWritable(this.hubRoot);
    const workers = await this.listWorkers();
    const backend = await this._backend();
    let removed = 0;
    for (const worker of workers) {
      const localWorker = worker.host === "local" || worker.host === os.hostname();
      if (worker.status === "exited" || (worker.status === "unhealthy" && localWorker && !this._isAlive(worker.pid))) {
        if (backend) {
          await this._mutateRedisRecord(backend, this._workerField(String(worker.workerId)), () => ({ data: null, result: undefined }));
          for (const { field } of await backend.scanStateRecords(this._inboxPrefix(String(worker.workerId)))) {
            await this._mutateRedisRecord(backend, field, () => ({ data: null, result: undefined }));
          }
          removed++;
          continue;
        }
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

export function summarizeWorkers(workers: Array<LooseRecord> = []) {
  const counts: Record<string, number> = { ready: 0, running: 0, unhealthy: 0, exited: 0 };
  for (const worker of workers) {
    const status = worker.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}
