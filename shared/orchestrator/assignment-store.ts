import { recordValue, type LooseRecord } from "../types.js";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { writeJsonAtomic, writeJsonOnce } from "../fs-utils.js";
import { assertHubWritable } from "../hub-maintenance.js";
import { openPinnedHubRedisStateBackend, type HubRedisStateBackend } from "../hub-state-redis.js";
import { processLeaderFence } from "../hub-leader-fence.js";

const ASSIGNMENTS_DIR = "assignments";
const ASSIGNMENT_LOCK_TTL_MS = 30_000;
const ASSIGNMENT_LOCK_RETRIES = 500;
const ASSIGNMENT_LOCK_RETRY_MS = 10;

export type AssignmentRecord = LooseRecord & {
  assignmentId?: string;
  entryId?: string;
  projectId?: string;
  task?: string;
  sourcePath?: string;
  workflow?: string;
  planMode?: string;
  sourceContext?: LooseRecord;
  metadata?: LooseRecord;
  status?: string;
  attempts?: number;
  activeAttempt?: number;
  workerId?: string;
};

export type AssignmentAttempt = LooseRecord & {
  assignmentId: string;
  attempt: number;
  entryId?: string;
  projectId?: string;
  workerId?: string;
  status: string;
  orchestratorEpoch?: number;
  attemptToken: string;
  createdAt: string;
};

type AssignmentEntryInput = Omit<LooseRecord, "sourceContext"> & {
  entryId?: string | number;
  projectId?: string;
  task?: string;
  sourcePath?: string;
  workflow?: string;
  planMode?: string;
  sourceContext?: unknown;
};

export type AttemptIdentity = LooseRecord & {
  assignmentId?: unknown;
  attempt?: unknown;
  attemptToken?: unknown;
  orchestratorEpoch?: unknown;
};

type ActiveAttemptContext = {
  state: AssignmentRecord;
  attempt: AssignmentAttempt;
};

type AssignmentDocument = {
  input: AssignmentRecord;
  state: AssignmentRecord;
  attempts: Record<string, AssignmentAttempt & {
    heartbeat?: LooseRecord;
    cancel?: LooseRecord;
    result?: LooseRecord;
  }>;
};

function terminalStatusFromResult(status: unknown) {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "blocked") return "blocked";
  return "failed";
}

const TERMINAL_ASSIGNMENT_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);

function staleAttemptError(assignmentId: string, attemptNum: number, detail: string) {
  return Object.assign(
    new Error(`stale attempt ${assignmentId} attempt ${attemptNum}: ${detail}`),
    { code: "STALE_ATTEMPT" },
  );
}

export class AssignmentStore {
  hubRoot: string;
  baseDir: string;
  _redisBackend: HubRedisStateBackend | null | undefined;

  constructor(hubRoot: string) {
    this.hubRoot = path.resolve(hubRoot);
    this.baseDir = path.join(this.hubRoot, ASSIGNMENTS_DIR);
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

  _assignmentField(assignmentId: string) {
    return `assignment:${Buffer.from(String(assignmentId), "utf8").toString("base64url")}`;
  }

  _inboxClaimField(workerId: string, assignmentId: string, attemptNum: number, attemptToken: string) {
    const part = (value: string) => Buffer.from(value, "utf8").toString("base64url");
    return `workerInbox:${part(workerId)}:${part(assignmentId)}:${attemptNum}:${part(attemptToken)}`;
  }

  _assignmentDocument(value: unknown, assignmentId: string): AssignmentDocument | null {
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw Object.assign(new Error(`invalid Redis assignment record: ${assignmentId}`), { code: "HUB_STATE_RECORD_INVALID" });
    }
    const candidate = value as Partial<AssignmentDocument>;
    if (!candidate.input || !candidate.state || !candidate.attempts || typeof candidate.attempts !== "object" || Array.isArray(candidate.attempts)) {
      throw Object.assign(new Error(`invalid Redis assignment envelope: ${assignmentId}`), { code: "HUB_STATE_RECORD_INVALID" });
    }
    return candidate as AssignmentDocument;
  }

  async _readRedisDocument(backend: HubRedisStateBackend, assignmentId: string) {
    const snapshot = await backend.readStateRecord(this._assignmentField(assignmentId));
    return { snapshot, document: this._assignmentDocument(snapshot.data, assignmentId) };
  }

  async _mutateRedisDocument<T>(
    backend: HubRedisStateBackend,
    assignmentId: string,
    callback: (current: AssignmentDocument | null) => { document: AssignmentDocument; result: T },
  ): Promise<T> {
    const fence = processLeaderFence(backend.identityFingerprint);
    for (let retry = 0; retry < 64; retry += 1) {
      const { snapshot, document } = await this._readRedisDocument(backend, assignmentId);
      const mutation = callback(document);
      const committed = await backend.compareAndSwapStateRecord(
        this._assignmentField(assignmentId),
        snapshot.revision,
        mutation.document,
        fence,
      );
      if (committed.fenced) {
        throw Object.assign(new Error("leader lease no longer authorizes this assignment write"), { code: "HUB_LEADER_FENCED" });
      }
      if (committed.committed) return mutation.result;
    }
    throw Object.assign(new Error(`assignment changed too frequently: ${assignmentId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }

  _redisActiveAttempt(document: AssignmentDocument, assignmentId: string, attemptNum: number): ActiveAttemptContext {
    const activeAttempt = Number(document.state.activeAttempt);
    if (!Number.isInteger(activeAttempt) || activeAttempt !== attemptNum) {
      throw staleAttemptError(assignmentId, attemptNum, `active attempt is ${document.state.activeAttempt ?? "none"}`);
    }
    const attempt = document.attempts[String(attemptNum)];
    if (!attempt || attempt.assignmentId !== assignmentId || attempt.attempt !== attemptNum) {
      throw staleAttemptError(assignmentId, attemptNum, "attempt record identity mismatch");
    }
    return { state: document.state, attempt };
  }

  async init() {
    await assertHubWritable(this.hubRoot);
    const backend = await this._backend();
    if (backend) {
      await backend.preflight();
      await backend.scanStateRecords("assignment:");
      const localEntries = await readdir(this.baseDir).catch((): string[] => []);
      if (localEntries.some((entry) => entry.startsWith("a-"))) {
        throw Object.assign(
          new Error("local assignments exist and require an explicit Redis migration"),
          { code: "HUB_ASSIGNMENT_MIGRATION_REQUIRED" },
        );
      }
      return;
    }
    await mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Idempotent: creates assignment on first call, updates mutable fields on retry/reroute.
   * Preserves attempt history (counter + attempt directories) across retries.
   */
  async getOrCreateAssignmentForEntry({ entryId, projectId, task, sourcePath, workflow, planMode, sourceContext, metadata }: AssignmentEntryInput): Promise<AssignmentRecord> {
    const entryIdText = String(entryId);
    const id = `a-${entryIdText}`;
    const backend = await this._backend();
    if (backend) {
      return this._mutateRedisDocument(backend, id, (current) => {
        if (current) {
          const updated = {
            ...current.state,
            workflow: workflow || current.state.workflow,
            planMode: planMode || current.state.planMode,
            sourceContext: { ...recordValue(current.state.sourceContext), ...recordValue(sourceContext) },
            task: task || current.state.task,
            sourcePath: sourcePath || current.state.sourcePath,
            metadata: { ...recordValue(current.state.metadata), ...recordValue(metadata) },
            status: "scheduled",
            resultWrittenAt: null,
            queueFinalizedAt: null,
            workerFinalizedAt: null,
          };
          return {
            document: { ...current, input: updated, state: updated },
            result: updated,
          };
        }
        const assignment: AssignmentRecord = {
          assignmentId: id,
          entryId: entryIdText,
          projectId,
          task,
          sourcePath,
          workflow: workflow || "standard",
          planMode: planMode || "full",
          sourceContext: recordValue(sourceContext),
          metadata: recordValue(metadata),
          status: "scheduled",
          createdAt: new Date().toISOString(),
          resultWrittenAt: null,
          queueFinalizedAt: null,
          workerFinalizedAt: null,
        };
        return {
          document: { input: assignment, state: { ...assignment, attempts: 0 }, attempts: {} },
          result: assignment,
        };
      });
    }
    const dir = path.join(this.baseDir, id);
    return this._withAssignmentLock(id, async () => {
      // Preserve existing assignment on retry/reroute — don't reset attempt history
      const existing = await this._readState(id);
      if (existing) {
        const updated = {
          ...existing,
          // Update mutable fields (may change on reroute)
          workflow: workflow || existing.workflow,
          planMode: planMode || existing.planMode,
          sourceContext: { ...recordValue(existing.sourceContext), ...recordValue(sourceContext) },
          task: task || existing.task,
          sourcePath: sourcePath || existing.sourcePath,
          metadata: { ...recordValue(existing.metadata), ...recordValue(metadata) },
          // Reset scheduling state for new attempt
          status: "scheduled",
          resultWrittenAt: null,
          queueFinalizedAt: null,
          workerFinalizedAt: null,
        };
        await writeJsonAtomic(path.join(dir, "input.json"), updated);
        await this._writeState(id, updated);
        return updated;
      }

      // First creation — full initialization
      await mkdir(path.join(dir, "attempts"), { recursive: true });

      const assignment = {
        assignmentId: id,
        entryId: entryIdText,
        projectId,
        task,
        sourcePath,
        workflow: workflow || "standard",
        planMode: planMode || "full",
        sourceContext: recordValue(sourceContext),
        metadata: recordValue(metadata),
        status: "scheduled",
        createdAt: new Date().toISOString(),
        // P0-3 fix: finalization tracking
        resultWrittenAt: null,
        queueFinalizedAt: null,
        workerFinalizedAt: null,
      };

      await writeJsonAtomic(path.join(dir, "input.json"), assignment);
      await writeJsonAtomic(path.join(dir, "state.json"), { ...assignment, attempts: 0 });

      return assignment;
    });
  }

  async createAttempt(assignmentId: string, { workerId, orchestratorEpoch }: LooseRecord): Promise<AssignmentAttempt> {
    const backend = await this._backend();
    if (backend) {
      const authorityNow = new Date(await backend.serverTimeMs()).toISOString();
      return this._mutateRedisDocument(backend, assignmentId, (current) => {
        if (!current) throw new Error(`assignment not found: ${assignmentId}`);
        const state = { ...current.state };
        const attemptNum = (typeof state.attempts === "number" ? state.attempts : 0) + 1;
        const attempt: AssignmentAttempt = {
          assignmentId,
          attempt: attemptNum,
          entryId: state.entryId,
          projectId: state.projectId,
          workerId: typeof workerId === "string" ? workerId : undefined,
          status: "assigned",
          orchestratorEpoch: typeof orchestratorEpoch === "number" ? orchestratorEpoch : undefined,
          attemptToken: crypto.randomBytes(16).toString("hex"),
          createdAt: authorityNow,
        };
        state.attempts = attemptNum;
        state.activeAttempt = attemptNum;
        state.status = "assigned";
        state.assignedAt = authorityNow;
        state.workerId = typeof workerId === "string" ? workerId : undefined;
        return {
          document: {
            ...current,
            state,
            attempts: { ...current.attempts, [String(attemptNum)]: attempt },
          },
          result: attempt,
        };
      });
    }
    return this._withAssignmentLock(assignmentId, async () => {
      const state = await this._readState(assignmentId);
      if (!state) throw new Error(`assignment not found: ${assignmentId}`);
      const previousAttempts = typeof state.attempts === "number" ? state.attempts : 0;
      const attemptNum = previousAttempts + 1;
      const attemptDir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"));
      await mkdir(attemptDir, { recursive: true });
      await mkdir(path.join(attemptDir, "control"), { recursive: true });

      const attemptToken = crypto.randomBytes(16).toString("hex");
      const attempt = {
        assignmentId,
        attempt: attemptNum,
        entryId: state.entryId,
        projectId: state.projectId,
        workerId,
        status: "assigned",
        orchestratorEpoch: typeof orchestratorEpoch === "number" ? orchestratorEpoch : undefined,
        attemptToken,
        createdAt: new Date().toISOString(),
      };

      await writeJsonAtomic(path.join(attemptDir, "attempt.json"), attempt);

      state.attempts = attemptNum;
      state.activeAttempt = attemptNum;
      state.status = "assigned";
      state.assignedAt = new Date().toISOString();
      state.workerId = workerId;
      await this._writeState(assignmentId, state);

      return attempt;
    });
  }

  async markRunning(assignmentId: string, attemptNum: number, identity?: AttemptIdentity) {
    const backend = await this._backend();
    if (backend) {
      return this._mutateRedisDocument(backend, assignmentId, (current) => {
        if (!current) throw new Error(`assignment not found: ${assignmentId}`);
        const { state: currentState, attempt: currentAttempt } = this._redisActiveAttempt(current, assignmentId, attemptNum);
        if (identity) this._validateAttemptIdentity(assignmentId, attemptNum, currentAttempt, identity, true);
        if (TERMINAL_ASSIGNMENT_STATUSES.has(String(currentState.status || "")) || currentAttempt.result) {
          throw staleAttemptError(assignmentId, attemptNum, `assignment is terminal (${currentState.status})`);
        }
        if (!["assigned", "running"].includes(String(currentAttempt.status || ""))) {
          throw staleAttemptError(assignmentId, attemptNum, `attempt is ${currentAttempt.status || "unknown"}`);
        }
        if (currentState.status === "running" && currentAttempt.status === "running") {
          return { document: current, result: undefined };
        }
        const state = { ...currentState, status: "running", startedAt: new Date().toISOString() };
        const attempt = { ...currentAttempt, status: "running", acceptedAt: new Date().toISOString() };
        return {
          document: { ...current, state, attempts: { ...current.attempts, [String(attemptNum)]: attempt } },
          result: undefined,
        };
      });
    }
    return this._withAssignmentLock(assignmentId, async () => {
      const { state, attempt } = await this._loadActiveAttempt(assignmentId, attemptNum);
      if (identity) this._validateAttemptIdentity(assignmentId, attemptNum, attempt, identity, true);
      if (TERMINAL_ASSIGNMENT_STATUSES.has(String(state.status || ""))) {
        throw staleAttemptError(assignmentId, attemptNum, `assignment is terminal (${state.status})`);
      }
      if (!["assigned", "running"].includes(String(attempt.status || ""))) {
        throw staleAttemptError(assignmentId, attemptNum, `attempt is ${attempt.status || "unknown"}`);
      }
      if (state.status === "running" && attempt.status === "running") return;
      state.status = "running";
      state.startedAt = new Date().toISOString();
      attempt.status = "running";
      attempt.acceptedAt = new Date().toISOString();

      await this._writeAttempt(assignmentId, attemptNum, attempt);
      await this._writeState(assignmentId, state);
    });
  }

  async recordHeartbeat(assignmentId: string, attemptNum: number, heartbeat: LooseRecord) {
    await assertHubWritable(this.hubRoot);
    const backend = await this._backend();
    if (backend) {
      const authorityNow = new Date(await backend.serverTimeMs()).toISOString();
      return this._mutateRedisDocument(backend, assignmentId, (current) => {
        if (!current) throw new Error(`assignment not found: ${assignmentId}`);
        const { state, attempt } = this._redisActiveAttempt(current, assignmentId, attemptNum);
        if (TERMINAL_ASSIGNMENT_STATUSES.has(String(state.status || "")) || attempt.result) {
          return { document: current, result: false };
        }
        const previousHeartbeat = recordValue(attempt.heartbeat);
        const sourceProgressUpdatedAt = typeof heartbeat.progressUpdatedAt === "string"
          ? heartbeat.progressUpdatedAt
          : null;
        const progressChanged = Boolean(sourceProgressUpdatedAt
          && sourceProgressUpdatedAt !== previousHeartbeat.sourceProgressUpdatedAt);
        const updatedAttempt = {
          ...attempt,
          heartbeat: {
            ...heartbeat,
            sourceProgressUpdatedAt,
            updatedAt: authorityNow,
            progressUpdatedAt: progressChanged
              ? authorityNow
              : previousHeartbeat.progressUpdatedAt || authorityNow,
          },
        };
        return {
          document: { ...current, attempts: { ...current.attempts, [String(attemptNum)]: updatedAttempt } },
          result: undefined,
        };
      });
    }
    const dir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"));
    await writeJsonAtomic(
      path.join(dir, "heartbeat.json"),
      { ...heartbeat, updatedAt: new Date().toISOString() },
    );
  }

  /**
   * P0-4 fix: Validate a worker-written result and update assignment/attempt state.
   * Does NOT write result.json — worker already wrote it.
   */
  async completeAttemptFromExistingResult(assignmentId: string, attemptNum: number, result: LooseRecord) {
    const backend = await this._backend();
    if (backend) {
      return this._mutateRedisDocument(backend, assignmentId, (current) => {
        if (!current) throw new Error(`assignment not found: ${assignmentId}`);
        const context = this._redisActiveAttempt(current, assignmentId, attemptNum);
        this._validateAttemptIdentity(assignmentId, attemptNum, context.attempt, result, true);
        if (context.attempt.result || TERMINAL_ASSIGNMENT_STATUSES.has(String(context.state.status || ""))) {
          return { document: current, result: false };
        }
        const now = new Date().toISOString();
        const terminalStatus = terminalStatusFromResult(result.status);
        const attempt = { ...context.attempt, status: terminalStatus, completedAt: now, result };
        const state = {
          ...context.state,
          status: terminalStatus,
          completedAt: now,
          resultWrittenAt: now,
          queueFinalizedAt: context.state.queueFinalizedAt ?? null,
          workerFinalizedAt: context.state.workerFinalizedAt ?? null,
        };
        return {
          document: { ...current, state, attempts: { ...current.attempts, [String(attemptNum)]: attempt } },
          result: true,
        };
      });
    }
    return this._withAssignmentLock(assignmentId, async () => {
      const { state, attempt } = await this._loadActiveAttempt(assignmentId, attemptNum);
      this._validateAttemptIdentity(assignmentId, attemptNum, attempt, result, true);
      if (TERMINAL_ASSIGNMENT_STATUSES.has(String(state.status || ""))) return false;

      const terminalStatus = terminalStatusFromResult(result.status);
      attempt.status = terminalStatus;
      attempt.completedAt = new Date().toISOString();
      await this._writeAttempt(assignmentId, attemptNum, attempt);

      state.status = terminalStatus;
      state.completedAt = new Date().toISOString();
      state.resultWrittenAt = new Date().toISOString();
      // P0-3: reset finalization tracking — reconciler will finalize
      state.queueFinalizedAt ??= null;
      state.workerFinalizedAt ??= null;
      await this._writeState(assignmentId, state);
      return true;
    });
  }

  /** Atomically commits a Redis terminal result and acknowledges its inbox claim. */
  async completeAttemptAndAckInbox(
    assignmentId: string,
    attemptNum: number,
    result: LooseRecord,
    { workerId, claimToken }: { workerId: string; claimToken: string },
  ) {
    const backend = await this._backend();
    if (!backend) {
      const accepted = await this.completeAttemptFromExistingResult(assignmentId, attemptNum, result);
      return { accepted: accepted !== false, inboxAcked: false };
    }
    for (let retry = 0; retry < 64; retry += 1) {
      const { snapshot, document } = await this._readRedisDocument(backend, assignmentId);
      if (!document) throw new Error(`assignment not found: ${assignmentId}`);
      const context = this._redisActiveAttempt(document, assignmentId, attemptNum);
      this._validateAttemptIdentity(assignmentId, attemptNum, context.attempt, result, true);
      const alreadyTerminal = Boolean(context.attempt.result)
        || TERMINAL_ASSIGNMENT_STATUSES.has(String(context.state.status || ""));
      let nextDocument = document;
      if (!alreadyTerminal) {
        const now = new Date().toISOString();
        const terminalStatus = terminalStatusFromResult(result.status);
        const attempt = { ...context.attempt, status: terminalStatus, completedAt: now, result };
        const state = {
          ...context.state,
          status: terminalStatus,
          completedAt: now,
          resultWrittenAt: now,
          queueFinalizedAt: context.state.queueFinalizedAt ?? null,
          workerFinalizedAt: context.state.workerFinalizedAt ?? null,
        };
        nextDocument = {
          ...document,
          state,
          attempts: { ...document.attempts, [String(attemptNum)]: attempt },
        };
      }
      const committed = await backend.commitStateRecordAndDeleteClaim(
        this._assignmentField(assignmentId),
        snapshot.revision,
        nextDocument,
        this._inboxClaimField(workerId, assignmentId, attemptNum, String(context.attempt.attemptToken || "")),
        claimToken,
      );
      if (!committed.claimMatched) {
        throw Object.assign(new Error("worker inbox claim is no longer active"), { code: "STALE_INBOX_CLAIM" });
      }
      if (committed.committed) return { accepted: !alreadyTerminal, inboxAcked: true };
    }
    throw Object.assign(new Error(`assignment changed too frequently: ${assignmentId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }

  /**
   * Write a synthetic failure result (for reconciler-created failures like heartbeat lost).
   * Uses writeJsonOnce to prevent overwriting worker results.
   */
  async writeSyntheticFailure(assignmentId: string, attemptNum: number, result: LooseRecord) {
    const backend = await this._backend();
    if (backend) {
      return this._mutateRedisDocument(backend, assignmentId, (current) => {
        if (!current) throw new Error(`assignment not found: ${assignmentId}`);
        const context = this._redisActiveAttempt(current, assignmentId, attemptNum);
        this._validateAttemptIdentity(assignmentId, attemptNum, context.attempt, result, false);
        if (context.attempt.result) return { document: current, result: false };
        const syntheticResult = {
          ...result,
          assignmentId,
          attempt: attemptNum,
          attemptToken: context.attempt.attemptToken,
          ...(context.attempt.orchestratorEpoch !== undefined ? { orchestratorEpoch: context.attempt.orchestratorEpoch } : {}),
        };
        const now = new Date().toISOString();
        const attempt = { ...context.attempt, status: "failed", completedAt: now, result: syntheticResult };
        const state = {
          ...context.state,
          status: "failed",
          completedAt: now,
          resultWrittenAt: now,
          queueFinalizedAt: null,
          workerFinalizedAt: null,
        };
        return {
          document: { ...current, state, attempts: { ...current.attempts, [String(attemptNum)]: attempt } },
          result: true,
        };
      });
    }
    return this._withAssignmentLock(assignmentId, async () => {
      const { state, attempt } = await this._loadActiveAttempt(assignmentId, attemptNum);
      this._validateAttemptIdentity(assignmentId, attemptNum, attempt, result, false);
      const syntheticResult = {
        ...result,
        assignmentId,
        attempt: attemptNum,
        attemptToken: attempt.attemptToken,
        ...(attempt.orchestratorEpoch !== undefined ? { orchestratorEpoch: attempt.orchestratorEpoch } : {}),
      };

      const dir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"));
      const resultPath = path.join(dir, "result.json");
      const written = await writeJsonOnce(resultPath, syntheticResult);
      if (!written) {
        // Worker already wrote result — use that instead
        return false;
      }

      attempt.status = "failed";
      attempt.completedAt = new Date().toISOString();
      await this._writeAttempt(assignmentId, attemptNum, attempt);

      state.status = "failed";
      state.completedAt = new Date().toISOString();
      state.resultWrittenAt = new Date().toISOString();
      state.queueFinalizedAt = null;
      state.workerFinalizedAt = null;
      await this._writeState(assignmentId, state);
      return true;
    });
  }

  /**
   * P0-3 fix: Mark finalization steps complete. Idempotent.
   */
  async markFinalized(assignmentId: string, step: string) {
    const backend = await this._backend();
    if (backend) {
      return this._mutateRedisDocument(backend, assignmentId, (current) => {
        if (!current) throw new Error(`assignment not found: ${assignmentId}`);
        const key = `${step}FinalizedAt`;
        if (current.state[key]) return { document: current, result: undefined };
        return {
          document: { ...current, state: { ...current.state, [key]: new Date().toISOString() } },
          result: undefined,
        };
      });
    }
    return this._withAssignmentLock(assignmentId, async () => {
      const state = await this._readState(assignmentId);
      if (!state) return;
      const key = `${step}FinalizedAt`;
      if (!state[key]) {
        state[key] = new Date().toISOString();
        await this._writeState(assignmentId, state);
      }
    });
  }

  async assertActiveAttemptIdentity(assignmentId: string, attemptNum: number, identity: AttemptIdentity) {
    const backend = await this._backend();
    if (backend) {
      const { document } = await this._readRedisDocument(backend, assignmentId);
      if (!document) throw new Error(`assignment not found: ${assignmentId}`);
      const context = this._redisActiveAttempt(document, assignmentId, attemptNum);
      this._validateAttemptIdentity(assignmentId, attemptNum, context.attempt, identity, true);
      if (context.attempt.result || TERMINAL_ASSIGNMENT_STATUSES.has(String(context.state.status || ""))) {
        throw staleAttemptError(assignmentId, attemptNum, `assignment is terminal (${context.state.status})`);
      }
      return context.attempt;
    }
    return this._withAssignmentLock(assignmentId, async () => {
      const context = await this._loadActiveAttempt(assignmentId, attemptNum);
      this._validateAttemptIdentity(assignmentId, attemptNum, context.attempt, identity, true);
      if (TERMINAL_ASSIGNMENT_STATUSES.has(String(context.state.status || ""))) {
        throw staleAttemptError(assignmentId, attemptNum, `assignment is terminal (${context.state.status})`);
      }
      return context.attempt;
    });
  }

  async writeCancel(assignmentId: string, attemptNum: number, reason: string) {
    const backend = await this._backend();
    if (backend) {
      return this._mutateRedisDocument(backend, assignmentId, (current) => {
        if (!current) throw new Error(`assignment not found: ${assignmentId}`);
        const context = this._redisActiveAttempt(current, assignmentId, attemptNum);
        if (["completed", "failed", "cancelled", "blocked"].includes(String(context.state.status || ""))) {
          return { document: current, result: false };
        }
        const attempt = {
          ...context.attempt,
          cancel: { reason, requestedAt: new Date().toISOString(), requestedBy: "hub" },
        };
        return {
          document: { ...current, attempts: { ...current.attempts, [String(attemptNum)]: attempt } },
          result: true,
        };
      });
    }
    return this._withAssignmentLock(assignmentId, async () => {
      const { state } = await this._loadActiveAttempt(assignmentId, attemptNum);
      if (["completed", "failed", "cancelled", "blocked"].includes(String(state.status || ""))) {
        return false;
      }
      const dir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"), "control");
      await mkdir(dir, { recursive: true });
      await writeJsonAtomic(path.join(dir, "cancel.json"), {
        reason,
        requestedAt: new Date().toISOString(),
        requestedBy: "hub",
      });
      return true;
    });
  }

  async readCancel(assignmentId: string, attemptNum: number) {
    const backend = await this._backend();
    if (backend) {
      const { document } = await this._readRedisDocument(backend, assignmentId);
      if (!document) return null;
      return document.attempts[String(attemptNum)]?.cancel || null;
    }
    try {
      return JSON.parse(await readFile(
        path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"), "control", "cancel.json"),
        "utf8",
      ));
    } catch { return null; }
  }

  async getAssignment(assignmentId: string): Promise<AssignmentRecord | null> {
    const backend = await this._backend();
    if (backend) return (await this._readRedisDocument(backend, assignmentId)).document?.state || null;
    return this._readState(assignmentId);
  }

  async getActiveAttempt(assignmentId: string): Promise<AssignmentAttempt | null> {
    const backend = await this._backend();
    if (backend) {
      const { document } = await this._readRedisDocument(backend, assignmentId);
      if (!document) return null;
      const activeAttempt = Number(document.state.activeAttempt);
      if (!Number.isInteger(activeAttempt) || activeAttempt <= 0) return null;
      return document.attempts[String(activeAttempt)] || null;
    }
    const state = await this._readState(assignmentId);
    if (!state) return null;
    const activeAttempt = typeof state.activeAttempt === "number" ? state.activeAttempt : Number(state.activeAttempt);
    if (!Number.isFinite(activeAttempt) || activeAttempt <= 0) return null;
    return this._readAttempt(assignmentId, activeAttempt);
  }

  async listAssignments(filter: LooseRecord = {}): Promise<AssignmentRecord[]> {
    const backend = await this._backend();
    if (backend) {
      const records = await backend.scanStateRecords("assignment:");
      return records.flatMap(({ record }) => {
        const document = this._assignmentDocument(record.data, "scanned");
        const state = document?.state;
        if (!state) return [];
        if (filter.status && state.status !== filter.status) return [];
        if (filter.projectId && state.projectId !== filter.projectId) return [];
        return [state];
      });
    }
    const entries: AssignmentRecord[] = [];
    try {
      const dirs = await readdir(this.baseDir);
      for (const dir of dirs) {
        if (!dir.startsWith("a-")) continue;
        const state = await this._readState(dir);
        if (!state) continue;
        if (filter.status && state.status !== filter.status) continue;
        if (filter.projectId && state.projectId !== filter.projectId) continue;
        entries.push(state);
      }
    } catch { /* no assignments yet */ }
    return entries;
  }

  async _readState(assignmentId: string): Promise<AssignmentRecord | null> {
    try {
      return recordValue(JSON.parse(await readFile(path.join(this.baseDir, assignmentId, "state.json"), "utf8"))) as AssignmentRecord;
    } catch { return null; }
  }

  async _writeState(assignmentId: string, state: LooseRecord) {
    await writeJsonAtomic(path.join(this.baseDir, assignmentId, "state.json"), state);
  }

  async _readAttempt(assignmentId: string, attemptNum: number): Promise<AssignmentAttempt> {
    const dir = String(attemptNum).padStart(3, "0");
    return recordValue(JSON.parse(await readFile(path.join(this.baseDir, assignmentId, "attempts", dir, "attempt.json"), "utf8"))) as AssignmentAttempt;
  }

  async _writeAttempt(assignmentId: string, attemptNum: number, attempt: LooseRecord) {
    const dir = String(attemptNum).padStart(3, "0");
    await writeJsonAtomic(path.join(this.baseDir, assignmentId, "attempts", dir, "attempt.json"), attempt);
  }

  async _loadActiveAttempt(assignmentId: string, attemptNum: number): Promise<ActiveAttemptContext> {
    const state = await this._readState(assignmentId);
    if (!state) throw new Error(`assignment not found: ${assignmentId}`);
    const activeAttempt = Number(state.activeAttempt);
    if (!Number.isInteger(activeAttempt) || activeAttempt !== attemptNum) {
      throw staleAttemptError(assignmentId, attemptNum, `active attempt is ${state.activeAttempt ?? "none"}`);
    }
    const attempt = await this._readAttempt(assignmentId, attemptNum);
    if (attempt.assignmentId !== assignmentId || attempt.attempt !== attemptNum) {
      throw staleAttemptError(assignmentId, attemptNum, "attempt record identity mismatch");
    }
    return { state, attempt };
  }

  _validateAttemptIdentity(
    assignmentId: string,
    attemptNum: number,
    attempt: AssignmentAttempt,
    identity: AttemptIdentity,
    requireCompleteIdentity: boolean,
  ) {
    if (requireCompleteIdentity && identity.assignmentId === undefined) {
      throw new Error(`missing assignment identity for ${assignmentId} attempt ${attemptNum}`);
    }
    if (identity.assignmentId !== undefined && identity.assignmentId !== assignmentId) {
      throw staleAttemptError(assignmentId, attemptNum, `assignment identity mismatch: ${String(identity.assignmentId)}`);
    }
    if (requireCompleteIdentity && identity.attempt === undefined) {
      throw new Error(`missing attempt identity for ${assignmentId} attempt ${attemptNum}`);
    }
    if (identity.attempt !== undefined && Number(identity.attempt) !== attemptNum) {
      throw staleAttemptError(assignmentId, attemptNum, `attempt identity mismatch: ${String(identity.attempt)}`);
    }
    if (requireCompleteIdentity && identity.attemptToken === undefined) {
      throw new Error(`missing attempt token for ${assignmentId} attempt ${attemptNum}`);
    }
    if (identity.attemptToken !== undefined && identity.attemptToken !== attempt.attemptToken) {
      throw new Error(`attempt token mismatch for ${assignmentId} attempt ${attemptNum}`);
    }
    if (attempt.orchestratorEpoch !== undefined) {
      if (requireCompleteIdentity && identity.orchestratorEpoch === undefined) {
        throw new Error(`missing orchestrator epoch for ${assignmentId} attempt ${attemptNum}`);
      }
      if (identity.orchestratorEpoch !== undefined && Number(identity.orchestratorEpoch) !== attempt.orchestratorEpoch) {
        throw staleAttemptError(
          assignmentId,
          attemptNum,
          `orchestrator epoch mismatch: expected ${attempt.orchestratorEpoch}, received ${String(identity.orchestratorEpoch)}`,
        );
      }
    }
  }

  async _withAssignmentLock<T>(assignmentId: string, callback: () => Promise<T>): Promise<T> {
    await assertHubWritable(this.hubRoot);
    const assignmentDir = path.join(this.baseDir, assignmentId);
    const lockDir = path.join(assignmentDir, "state.lock");
    const ownerFile = path.join(lockDir, "owner.json");
    const ownerToken = crypto.randomUUID();
    await mkdir(assignmentDir, { recursive: true });

    let acquired = false;
    for (let attempt = 0; attempt < ASSIGNMENT_LOCK_RETRIES; attempt += 1) {
      try {
        await mkdir(lockDir);
        await writeJsonAtomic(ownerFile, {
          ownerToken,
          pid: process.pid,
          host: os.hostname(),
          acquiredAt: new Date().toISOString(),
        });
        acquired = true;
        break;
      } catch (err) {
        if (!(err && typeof err === "object" && "code" in err && err.code === "EEXIST")) throw err;
        try {
          const recoveryKind = await this._assignmentLockRecoveryKind(lockDir, ownerFile);
          if (recoveryKind) {
            const staleDir = `${lockDir}.${recoveryKind}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
            await rename(lockDir, staleDir);
            await rm(staleDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          // Lock disappeared or another writer quarantined it; retry.
        }
        await new Promise((resolve) => setTimeout(resolve, ASSIGNMENT_LOCK_RETRY_MS));
      }
    }

    if (!acquired) throw new Error(`assignment state lock busy: ${assignmentId}`);
    try {
      return await callback();
    } finally {
      await this._releaseAssignmentLock(ownerFile, ownerToken);
    }
  }

  async _readAssignmentLockOwner(ownerFile: string) {
    try {
      return recordValue(JSON.parse(await readFile(ownerFile, "utf8")));
    } catch {
      return null;
    }
  }

  _assignmentLockOwnerAlive(owner: LooseRecord | null) {
    if (!owner) return false;
    const pid = Number(owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const host = typeof owner.host === "string" ? owner.host : "";
    if (host && host !== os.hostname()) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async _assignmentLockRecoveryKind(lockDir: string, ownerFile: string) {
    const owner = await this._readAssignmentLockOwner(ownerFile);
    if (owner?.releasedAt) return "released";

    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs < ASSIGNMENT_LOCK_TTL_MS) return null;
    if (this._assignmentLockOwnerAlive(owner)) return null;
    return owner ? "stale" : "incomplete";
  }

  async _writeAssignmentLockOwnerGuarded(ownerFile: string, ownerToken: string, next: LooseRecord) {
    const lockDir = path.dirname(ownerFile);
    const tempPath = path.join(lockDir, `.owner-${ownerToken}-${crypto.randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(tempPath, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      // Create the temp file before checking ownership. If a contender moves
      // this lock directory after either step, the source temp moves with the
      // old lock and cannot overwrite owner.json in a replacement directory.
      const current = await this._readAssignmentLockOwner(ownerFile);
      if (current?.ownerToken !== ownerToken) return false;
      try {
        await rename(tempPath, ownerFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
        throw error;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    } finally {
      if (created) await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  async _releaseAssignmentLock(ownerFile: string, ownerToken: string) {
    try {
      const owner = await this._readAssignmentLockOwner(ownerFile);
      if (owner?.ownerToken !== ownerToken) return false;
      const releasedAt = new Date().toISOString();
      return this._writeAssignmentLockOwnerGuarded(ownerFile, ownerToken, {
        ...owner,
        releasedAt,
      });
    } catch {
      // Lock was already quarantined or replaced.
      return false;
    }
  }
}
