import { recordValue, type LooseRecord } from "../types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { writeJsonAtomic, writeJsonOnce } from "../fs-utils.js";
import { assertHubWritable, fsyncDirectory, writeJsonDurableAtomic } from "../hub-maintenance.js";
import { openPinnedHubRedisStateBackend, type HubRedisStateBackend } from "../hub-state-redis.js";
import { processLeaderFence } from "../hub-leader-fence.js";
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  sameProcessIdentity,
  type ProcessIdentity,
} from "../primitives/process-tree.js";
import {
  readBoundedRegularFileNoFollow,
  withDirectoryProcessFence,
} from "../primitives/durable-directory-lock.js";

const ASSIGNMENTS_DIR = "assignments";
const LOCAL_ENQUEUE_OWNER_FILE = "enqueue-owner.json";
const LOCAL_MUTATION_OWNER_FILE = "mutation-owner.json";
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

export type AssignmentEnqueueReceipt = {
  assignmentId: string;
  previousDocument: AssignmentDocument | null;
  committedDocument: AssignmentDocument;
  assignment: AssignmentRecord;
  attempt: AssignmentAttempt;
  writeFence:
    | {
        backend: "local";
        ownerToken: string;
        mutationOwnerToken: string;
        previousOwner: LooseRecord | null;
        committedOwner: LooseRecord;
      }
    | {
        backend: "redis";
        revision: number;
      };
};

export type AssignmentWriteCancelOptions = {
  signal?: AbortSignal;
  /** Absolute Unix epoch milliseconds. */
  deadlineAt?: number;
};

type LocalAssignmentSnapshot = {
  input: AssignmentRecord | null;
  state: AssignmentRecord | null;
  attempts: Record<string, AssignmentAttempt>;
  writeOwner: LooseRecord | null;
  foreignAttemptEntries: string[];
};

type AssignmentLockContext = {
  ownerToken: string;
  predecessorMutationOwnerToken: string | null;
};

type AssignmentLockCandidate = {
  kind: "released" | "stale" | "incomplete";
  owner: LooseRecord | null;
  ownerToken: string | null;
  lockIdentity: AssignmentPathGeneration;
};

type AssignmentPathGeneration = {
  dev: bigint | number;
  ino: bigint | number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type LocalRestoreComponent = "input" | "state" | "owner" | "removeAttempt" | "restoreAttempt" | "removeAssignment";

export type AssignmentStoreTestHooks = {
  afterLocalEnqueueInputWrite?: (context: { assignmentId: string }) => void | Promise<void>;
  afterLocalEnqueueAttemptWrite?: (context: { assignmentId: string; attempt: number }) => void | Promise<void>;
  afterLocalEnqueueStateWrite?: (context: { assignmentId: string; attempt: number }) => void | Promise<void>;
  beforeLocalRestoreComponent?: (context: {
    assignmentId: string;
    component: LocalRestoreComponent;
    attempt?: number;
  }) => void | Promise<void>;
  afterLocalCancelCommit?: (context: { assignmentId: string; attempt: number }) => void | Promise<void>;
  afterRedisCancelRead?: (context: { assignmentId: string; revision: number }) => void | Promise<void>;
  afterRedisCancelCommit?: (context: { assignmentId: string; attempt: number; revision: number }) => void | Promise<void>;
  afterAssignmentLockRecoveryObserved?: (context: { lockDir: string; ownerToken: string | null; kind: string }) => void | Promise<void>;
  afterAssignmentLockQuarantineRename?: (context: { lockDir: string; quarantineDir: string; ownerToken: string | null; kind: string }) => void | Promise<void>;
  captureAssignmentProcessIdentity?: (pid: number) => ProcessIdentity | null;
  isAssignmentProcessIdentityAlive?: (identity: ProcessIdentity) => boolean;
  syncAssignmentDirectory?: (directory: string) => Promise<void>;
};

const assignmentStoreTestHookStorage = new AsyncLocalStorage<AssignmentStoreTestHooks>();

export function withAssignmentStoreTestHooksForTests<T>(hooks: AssignmentStoreTestHooks, fn: () => T): T {
  const parent = assignmentStoreTestHookStorage.getStore();
  return assignmentStoreTestHookStorage.run(parent ? { ...parent, ...hooks } : hooks, fn);
}

function assignmentStoreTestHooks() {
  return assignmentStoreTestHookStorage.getStore() || {};
}

function terminalStatusFromResult(status: unknown) {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "blocked") return "blocked";
  return "failed";
}

const TERMINAL_ASSIGNMENT_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);
const ASSIGNMENT_OWNER_SCHEMA_VERSION = 2;
const LOCAL_ASSIGNMENT_JSON_MAX_BYTES = 1024 * 1024;

async function syncAssignmentDirectory(directory: string) {
  const hook = assignmentStoreTestHooks().syncAssignmentDirectory;
  if (hook) {
    await hook(directory);
    return;
  }
  await fsyncDirectory(directory);
}

async function removeLocalPathDurable(filePath: string, options: { recursive?: boolean } = {}) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw assignmentLockConflict(`refusing to remove symbolic link assignment path: ${filePath}`);
  }
  if (options.recursive === true && !info.isDirectory()) {
    throw assignmentLockConflict(`recursive assignment removal requires a real directory: ${filePath}`);
  }
  if (options.recursive !== true && !info.isFile()) {
    throw assignmentLockConflict(`assignment removal requires a regular file: ${filePath}`);
  }
  const parent = path.dirname(filePath);
  const quarantinePath = path.join(parent, `.${path.basename(filePath)}.remove-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`);
  const expected = assignmentPathGeneration(info);
  const current = await lstat(filePath);
  if (!sameAssignmentPathGeneration(expected, assignmentPathGeneration(current))) {
    throw assignmentLockConflict(`assignment path changed before removal: ${filePath}`);
  }
  await rename(filePath, quarantinePath);
  await syncAssignmentDirectory(parent);
  const quarantined = await lstat(quarantinePath);
  if (!sameAssignmentPathGenerationAcrossRename(expected, assignmentPathGeneration(quarantined))) {
    throw Object.assign(assignmentLockConflict(`assignment path changed during removal isolation: ${filePath}`), {
      committed: true,
      committedPath: quarantinePath,
      recoveryPaths: { canonical: filePath, quarantine: quarantinePath },
      successorPreserved: false,
    });
  }
  await syncAssignmentDirectory(parent);
}

function staleAttemptError(assignmentId: string, attemptNum: number, detail: string) {
  return Object.assign(
    new Error(`stale attempt ${assignmentId} attempt ${attemptNum}: ${detail}`),
    { code: "STALE_ATTEMPT" },
  );
}

function assignmentLockConflict(message: string, cause?: unknown) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code: "HUB_ASSIGNMENT_LOCK_CONFLICT" },
  );
}

function assignmentLockReadChanged(error: unknown) {
  return errorCode(error) === "HUB_ASSIGNMENT_LOCK_CONFLICT"
    && error instanceof Error
    && errorCode(error.cause) === "BOUNDED_FILE_CHANGED";
}

function assignmentPathGeneration(info: Awaited<ReturnType<typeof lstat>>): AssignmentPathGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
    ctimeMs: Number(info.ctimeMs),
    birthtimeMs: Number(info.birthtimeMs),
  };
}

function sameAssignmentPathGeneration(left: AssignmentPathGeneration, right: AssignmentPathGeneration) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameAssignmentPathGenerationAcrossRename(left: AssignmentPathGeneration, right: AssignmentPathGeneration) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameAssignmentPathObject(left: AssignmentPathGeneration, right: AssignmentPathGeneration) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

async function openPinnedAssignmentDirectory(directory: string, label: string) {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw assignmentLockConflict(`${label} cannot be opened with no-follow directory flags: ${directory}`);
  }
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw assignmentLockConflict(`${label} is not a real directory: ${directory}`);
  }
  const generation = assignmentPathGeneration(before);
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let primaryError: unknown = null;
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameAssignmentPathGeneration(generation, assignmentPathGeneration(opened))) {
      throw assignmentLockConflict(`${label} changed while opening: ${directory}`, Object.assign(
        new Error("bounded assignment directory changed while opening"),
        { code: "BOUNDED_FILE_CHANGED" },
      ));
    }
    return { handle, generation };
  } catch (error) {
    primaryError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (primaryError) {
      throw new AggregateError([primaryError, closeError], `${label} open and close failed: ${directory}`, {
        cause: primaryError,
      });
    }
    throw closeError;
  }
  throw primaryError;
}

function stableJsonForReceipt(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonForReceipt(item)).join(",")}]`;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonForReceipt(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptDeepEqual(left: unknown, right: unknown) {
  return stableJsonForReceipt(left) === stableJsonForReceipt(right);
}

function receiptClone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function normalizeJsonValue<T>(value: T, label: string): T {
  let cloned: T;
  let serialized: string | undefined;
  try {
    cloned = structuredClone(value);
    serialized = JSON.stringify(cloned);
  } catch (cause) {
    throw Object.assign(new TypeError(`${label} must be JSON-cloneable`, { cause }), {
      code: "HUB_ASSIGNMENT_JSON_INVALID",
    });
  }
  if (serialized === undefined) {
    throw Object.assign(new TypeError(`${label} must serialize to JSON`), {
      code: "HUB_ASSIGNMENT_JSON_INVALID",
    });
  }
  const normalized = JSON.parse(serialized) as unknown;
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw Object.assign(new TypeError(`${label} must be a JSON object`), {
      code: "HUB_ASSIGNMENT_JSON_INVALID",
    });
  }
  return normalized as T;
}

function deepFreezeReceipt<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreezeReceipt(nested);
    Object.freeze(value);
  }
  return value;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function assignmentOperationAbortError(message: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

function validIsoTimestamp(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function throwIfAssignmentOperationStopped(options: AssignmentWriteCancelOptions = {}) {
  if (options.signal?.aborted) {
    const reason = options.signal.reason;
    if (reason instanceof Error) throw reason;
    throw assignmentOperationAbortError("assignment operation aborted", reason);
  }
  if (options.deadlineAt !== undefined) {
    if (!Number.isFinite(options.deadlineAt)) {
      throw new TypeError("assignment operation deadlineAt must be a finite Unix epoch millisecond value");
    }
    if (Date.now() >= options.deadlineAt) {
      throw assignmentOperationAbortError("assignment operation deadline exceeded");
    }
  }
}

async function waitForAssignmentRetry(delayMs: number, options: AssignmentWriteCancelOptions = {}) {
  throwIfAssignmentOperationStopped(options);
  const untilDeadline = options.deadlineAt === undefined
    ? delayMs
    : Math.max(0, Math.min(delayMs, options.deadlineAt - Date.now()));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => {
      const reason = options.signal?.reason;
      reject(reason instanceof Error ? reason : assignmentOperationAbortError("assignment operation aborted", reason));
    });
    const timer = setTimeout(() => finish(resolve), untilDeadline);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
  });
  throwIfAssignmentOperationStopped(options);
}

function flattenedErrors(error: unknown): unknown[] {
  return error instanceof AggregateError
    ? error.errors.flatMap((nested) => flattenedErrors(nested))
    : [error];
}

function enqueueReceipt(input: {
  assignmentId: string;
  previousDocument: AssignmentDocument | null;
  committedDocument: AssignmentDocument;
  assignment: AssignmentRecord;
  attempt: AssignmentAttempt;
  writeFence: AssignmentEnqueueReceipt["writeFence"];
}): AssignmentEnqueueReceipt {
  return deepFreezeReceipt({
    assignmentId: input.assignmentId,
    previousDocument: receiptClone(input.previousDocument),
    committedDocument: receiptClone(input.committedDocument),
    assignment: receiptClone(input.assignment),
    attempt: receiptClone(input.attempt),
    writeFence: receiptClone(input.writeFence),
  });
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

  async _mutateRedisDocumentWithRevision<T>(
    backend: HubRedisStateBackend,
    assignmentId: string,
    callback: (current: AssignmentDocument | null) => {
      document: AssignmentDocument;
      result: (revision: number) => T;
    },
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
      if (committed.committed) return mutation.result(committed.revision);
    }
    throw Object.assign(new Error(`assignment changed too frequently: ${assignmentId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }

  async _mutateRedisDocumentAbortable<T>(
    backend: HubRedisStateBackend,
    assignmentId: string,
    options: AssignmentWriteCancelOptions,
    callback: (current: AssignmentDocument | null) => { document: AssignmentDocument; result: T },
  ): Promise<T> {
    const fence = processLeaderFence(backend.identityFingerprint);
    for (let retry = 0; retry < 64; retry += 1) {
      throwIfAssignmentOperationStopped(options);
      const { snapshot, document } = await this._readRedisDocument(backend, assignmentId);
      await assignmentStoreTestHooks().afterRedisCancelRead?.({ assignmentId, revision: snapshot.revision });
      throwIfAssignmentOperationStopped(options);
      const mutation = callback(document);
      throwIfAssignmentOperationStopped(options);
      const committed = await backend.compareAndSwapStateRecord(
        this._assignmentField(assignmentId),
        snapshot.revision,
        mutation.document,
        fence,
      );
      if (committed.fenced) {
        throw Object.assign(new Error("leader lease no longer authorizes this assignment write"), { code: "HUB_LEADER_FENCED" });
      }
      if (committed.committed) {
        await assignmentStoreTestHooks().afterRedisCancelCommit?.({
          assignmentId,
          attempt: Number(mutation.document.state.activeAttempt || 0),
          revision: committed.revision,
        });
        return mutation.result;
      }
      throwIfAssignmentOperationStopped(options);
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
          entryId: String(state.entryId || ""),
          projectId: String(state.projectId || ""),
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
      const normalizedWorkerId = typeof workerId === "string" ? workerId : undefined;
      const attempt = {
        assignmentId,
        attempt: attemptNum,
        entryId: String(state.entryId || ""),
        projectId: String(state.projectId || ""),
        workerId: normalizedWorkerId,
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
      state.workerId = normalizedWorkerId;
      await this._writeState(assignmentId, state);

      return attempt;
    });
  }

  async enqueueWithReceipt(input: AssignmentEntryInput, { workerId, orchestratorEpoch }: LooseRecord): Promise<AssignmentEnqueueReceipt> {
    const normalizedInput = normalizeJsonValue(input, "assignment enqueue input") as AssignmentEntryInput;
    const entryIdText = String(normalizedInput.entryId);
    const assignmentId = `a-${entryIdText}`;
    const backend = await this._backend();
    if (backend) {
      const authorityNow = new Date(await backend.serverTimeMs()).toISOString();
      return this._mutateRedisDocumentWithRevision(backend, assignmentId, (current) => {
        const previousDocument = current ? receiptClone(current) : null;
        const currentState = current?.state;
        const assignment = normalizeJsonValue(currentState
          ? {
              ...currentState,
              workflow: normalizedInput.workflow || currentState.workflow,
              planMode: normalizedInput.planMode || currentState.planMode,
              sourceContext: { ...recordValue(currentState.sourceContext), ...recordValue(normalizedInput.sourceContext) },
              task: normalizedInput.task || currentState.task,
              sourcePath: normalizedInput.sourcePath || currentState.sourcePath,
              metadata: { ...recordValue(currentState.metadata), ...recordValue(normalizedInput.metadata) },
              status: "scheduled",
              resultWrittenAt: null,
              queueFinalizedAt: null,
              workerFinalizedAt: null,
            }
          : {
              assignmentId,
              entryId: entryIdText,
              projectId: normalizedInput.projectId,
              task: normalizedInput.task,
              sourcePath: normalizedInput.sourcePath,
              workflow: normalizedInput.workflow || "standard",
              planMode: normalizedInput.planMode || "full",
              sourceContext: recordValue(normalizedInput.sourceContext),
              metadata: recordValue(normalizedInput.metadata),
              status: "scheduled",
              createdAt: authorityNow,
              resultWrittenAt: null,
              queueFinalizedAt: null,
              workerFinalizedAt: null,
            }, "assignment enqueue record") as AssignmentRecord;
        const attempts = { ...(current?.attempts || {}) };
        const state = { ...(assignment as LooseRecord) };
        const attemptNum = (typeof currentState?.attempts === "number" ? currentState.attempts : 0) + 1;
        const attempt = normalizeJsonValue({
          assignmentId,
          attempt: attemptNum,
          entryId: String(state.entryId || ""),
          projectId: String(state.projectId || ""),
          workerId: typeof workerId === "string" ? workerId : undefined,
          status: "assigned",
          orchestratorEpoch: typeof orchestratorEpoch === "number" ? orchestratorEpoch : undefined,
          attemptToken: crypto.randomBytes(16).toString("hex"),
          createdAt: authorityNow,
        }, "assignment enqueue attempt") as AssignmentAttempt;
        state.attempts = attemptNum;
        state.activeAttempt = attemptNum;
        state.status = "assigned";
        state.assignedAt = authorityNow;
        state.workerId = typeof workerId === "string" ? workerId : undefined;
        attempts[String(attemptNum)] = attempt;
        const committedDocument = normalizeJsonValue({
          input: assignment,
          state,
          attempts,
        }, "assignment enqueue document") as AssignmentDocument;
        return {
          document: committedDocument,
          result: (revision: number) => enqueueReceipt({
            assignment: committedDocument.state,
            attempt: committedDocument.attempts[String(attemptNum)],
            previousDocument,
            committedDocument,
            assignmentId,
            writeFence: { backend: "redis", revision },
          }),
        };
      });
    }
    await this.init();
    return this._withAssignmentLock(assignmentId, async (lockContext) => {
      const dir = path.join(this.baseDir, assignmentId);
      const previousSnapshot = await this._localDocumentSnapshot(assignmentId);
      const previousDocument = this._assignmentDocumentFromLocalSnapshot(assignmentId, previousSnapshot);
      const previousOwner = previousSnapshot?.writeOwner || null;
      const existing = previousDocument?.state;
      const assignment = normalizeJsonValue(existing
        ? {
            ...existing,
            workflow: normalizedInput.workflow || existing.workflow,
            planMode: normalizedInput.planMode || existing.planMode,
            sourceContext: { ...recordValue(existing.sourceContext), ...recordValue(normalizedInput.sourceContext) },
            task: normalizedInput.task || existing.task,
            sourcePath: normalizedInput.sourcePath || existing.sourcePath,
            metadata: { ...recordValue(existing.metadata), ...recordValue(normalizedInput.metadata) },
            status: "scheduled",
            resultWrittenAt: null,
            queueFinalizedAt: null,
            workerFinalizedAt: null,
          }
        : {
            assignmentId,
            entryId: entryIdText,
            projectId: normalizedInput.projectId,
            task: normalizedInput.task,
            sourcePath: normalizedInput.sourcePath,
            workflow: normalizedInput.workflow || "standard",
            planMode: normalizedInput.planMode || "full",
            sourceContext: recordValue(normalizedInput.sourceContext),
            metadata: recordValue(normalizedInput.metadata),
            status: "scheduled",
            createdAt: new Date().toISOString(),
            resultWrittenAt: null,
            queueFinalizedAt: null,
            workerFinalizedAt: null,
          }, "assignment enqueue record") as AssignmentRecord;
      const previousAttempts = typeof existing?.attempts === "number" ? existing.attempts : 0;
      const attemptNum = previousAttempts + 1;
      const attemptDir = path.join(dir, "attempts", String(attemptNum).padStart(3, "0"));
      const attempt = normalizeJsonValue({
        assignmentId,
        attempt: attemptNum,
        entryId: assignment.entryId,
        projectId: assignment.projectId,
        workerId,
        status: "assigned",
        orchestratorEpoch: typeof orchestratorEpoch === "number" ? orchestratorEpoch : undefined,
        attemptToken: crypto.randomBytes(16).toString("hex"),
        createdAt: new Date().toISOString(),
      }, "assignment enqueue attempt") as AssignmentAttempt;
      const state = normalizeJsonValue({
        ...assignment,
        attempts: attemptNum,
        activeAttempt: attemptNum,
        status: "assigned",
        assignedAt: new Date().toISOString(),
        workerId,
      }, "assignment enqueue state") as AssignmentRecord;
      const attempts = previousDocument ? { ...previousDocument.attempts } : {};
      attempts[String(attemptNum)] = attempt;
      const committedDocument = normalizeJsonValue({ input: assignment, state, attempts }, "assignment enqueue document") as AssignmentDocument;
      const committedOwner = normalizeJsonValue({
        assignmentId,
        attempt: attemptNum,
        ownerToken: crypto.randomUUID(),
        writtenAt: new Date().toISOString(),
      }, "assignment enqueue owner");
      try {
        await mkdir(path.join(dir, "attempts"), { recursive: true });
        await writeJsonAtomic(path.join(dir, "input.json"), committedDocument.input);
        await assignmentStoreTestHooks().afterLocalEnqueueInputWrite?.({ assignmentId });
        await mkdir(path.join(attemptDir, "control"), { recursive: true });
        await writeJsonAtomic(path.join(attemptDir, "attempt.json"), committedDocument.attempts[String(attemptNum)]);
        await assignmentStoreTestHooks().afterLocalEnqueueAttemptWrite?.({ assignmentId, attempt: attemptNum });
        await this._writeState(assignmentId, committedDocument.state);
        await writeJsonAtomic(path.join(dir, LOCAL_ENQUEUE_OWNER_FILE), committedOwner);
        await assignmentStoreTestHooks().afterLocalEnqueueStateWrite?.({ assignmentId, attempt: attemptNum });
      } catch (error) {
        await this._restoreLocalEnqueueAfterFailure(
          assignmentId,
          previousDocument,
          committedDocument,
          previousOwner,
          committedOwner,
          error,
        );
      }
      return enqueueReceipt({
        assignment: committedDocument.state,
        attempt: committedDocument.attempts[String(attemptNum)],
        previousDocument,
        committedDocument,
        assignmentId,
        writeFence: {
          backend: "local",
          ownerToken: String(committedOwner.ownerToken),
          mutationOwnerToken: lockContext.ownerToken,
          previousOwner,
          committedOwner,
        },
      });
    });
  }

  async _readLocalJsonObject(filePath: string, label: string): Promise<LooseRecord | null> {
    try {
      let raw: string;
      try {
        raw = await readBoundedRegularFileNoFollow(filePath, {
          maxBytes: LOCAL_ASSIGNMENT_JSON_MAX_BYTES,
        });
      } catch (error) {
        if (errorCode(error) === "ENOENT") throw error;
        throw Object.assign(new Error(`${label} is not a safe bounded regular file: ${filePath}`, { cause: error }), {
          code: "HUB_ASSIGNMENT_DOCUMENT_INVALID",
        });
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw Object.assign(new Error(`${label} is not a JSON object`), { code: "HUB_ASSIGNMENT_DOCUMENT_INVALID" });
      }
      return parsed as LooseRecord;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        throw Object.assign(new Error(`${label} JSON is malformed: ${filePath}`, { cause: error }), {
          code: "HUB_ASSIGNMENT_DOCUMENT_INVALID",
        });
      }
      throw error;
    }
  }

  async _localDocumentSnapshot(assignmentId: string): Promise<LocalAssignmentSnapshot | null> {
    const assignmentDir = path.join(this.baseDir, assignmentId);
    const input = await this._readLocalJsonObject(path.join(assignmentDir, "input.json"), "assignment input") as AssignmentRecord | null;
    const state = await this._readLocalJsonObject(path.join(assignmentDir, "state.json"), "assignment state") as AssignmentRecord | null;
    const writeOwner = await this._readLocalJsonObject(path.join(assignmentDir, LOCAL_ENQUEUE_OWNER_FILE), "assignment enqueue owner");
    const attempts: Record<string, AssignmentAttempt> = {};
    const foreignAttemptEntries: string[] = [];
    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      entries = await readdir(path.join(assignmentDir, "attempts"), { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      const attemptNum = Number(entry.name);
      if (!entry.isDirectory()
        || !/^\d{3,}$/.test(entry.name)
        || !Number.isInteger(attemptNum)
        || attemptNum < 1
        || String(attemptNum).padStart(3, "0") !== entry.name) {
        foreignAttemptEntries.push(entry.name);
        continue;
      }
      const attempt = await this._readLocalJsonObject(
        path.join(assignmentDir, "attempts", entry.name, "attempt.json"),
        `assignment attempt ${entry.name}`,
      );
      if (!attempt || attempt.assignmentId !== assignmentId || Number(attempt.attempt) !== attemptNum) {
        foreignAttemptEntries.push(`${entry.name}/attempt.json`);
        continue;
      }
      attempts[String(attemptNum)] = attempt as AssignmentAttempt;
    }
    if (!input && !state && !writeOwner && Object.keys(attempts).length === 0 && foreignAttemptEntries.length === 0) return null;
    return { input, state, attempts, writeOwner, foreignAttemptEntries };
  }

  _assignmentDocumentFromLocalSnapshot(assignmentId: string, snapshot: LocalAssignmentSnapshot | null): AssignmentDocument | null {
    if (!snapshot) return null;
    if (snapshot.foreignAttemptEntries.length > 0 || !snapshot.input || !snapshot.state) {
      throw Object.assign(new Error(`invalid local assignment document: ${assignmentId}`), {
        code: "HUB_ASSIGNMENT_DOCUMENT_INVALID",
      });
    }
    const attemptCount = Number(snapshot.state.attempts || 0);
    const actualAttemptKeys = Object.keys(snapshot.attempts).sort((left, right) => Number(left) - Number(right));
    if (!Number.isInteger(attemptCount)
      || attemptCount < 0
      || actualAttemptKeys.length !== attemptCount
      || actualAttemptKeys.some((attemptKey, index) => attemptKey !== String(index + 1))) {
      throw Object.assign(new Error(`invalid local assignment attempt history: ${assignmentId}`), {
        code: "HUB_ASSIGNMENT_DOCUMENT_INVALID",
      });
    }
    return { input: snapshot.input, state: snapshot.state, attempts: snapshot.attempts };
  }

  _localDocumentMatchesEnqueuePartial(
    current: LocalAssignmentSnapshot | null,
    previous: AssignmentDocument | null,
    committed: AssignmentDocument,
    previousOwner: LooseRecord | null,
    committedOwner: LooseRecord,
  ) {
    const componentAllowed = (actual: unknown, before: unknown, after: unknown) => {
      if (actual === null || actual === undefined) return before === null || before === undefined;
      return (before !== null && before !== undefined && receiptDeepEqual(actual, before))
        || receiptDeepEqual(actual, after);
    };
    if (!current) return previous === null && previousOwner === null;
    if (current.foreignAttemptEntries.length > 0) return false;
    if (!componentAllowed(current.input, previous?.input, committed.input)) return false;
    if (!componentAllowed(current.state, previous?.state, committed.state)) return false;
    if (!componentAllowed(current.writeOwner, previousOwner, committedOwner)) return false;
    const previousAttempts = previous?.attempts || {};
    const allowedAttemptNums = new Set([...Object.keys(previousAttempts), ...Object.keys(committed.attempts)]);
    for (const attemptNum of Object.keys(current.attempts)) {
      if (!allowedAttemptNums.has(attemptNum)) return false;
      if (!componentAllowed(current.attempts[attemptNum], previousAttempts[attemptNum], committed.attempts[attemptNum])) return false;
    }
    for (const attemptNum of Object.keys(previousAttempts)) {
      if (!current.attempts[attemptNum]) return false;
    }
    return true;
  }

  async _restoreLocalDocumentComponents(
    assignmentId: string,
    previousDocument: AssignmentDocument | null,
    committedDocument: AssignmentDocument,
    previousOwner: LooseRecord | null,
  ) {
    const assignmentDir = path.join(this.baseDir, assignmentId);
    const operation = (
      component: LocalRestoreComponent,
      callback: () => Promise<unknown>,
      attempt?: number,
    ) => async () => {
      await assignmentStoreTestHooks().beforeLocalRestoreComponent?.({ assignmentId, component, attempt });
      await callback();
    };
    const operations: Array<() => Promise<void>> = [];
    if (!previousDocument) {
      operations.push(operation("removeAssignment", async () => {
        // Keep the live state.lock directory until _withAssignmentLock releases
        // it; deleting the fixed lock path here would let a successor enter
        // before this compensation has actually settled.
        // Each durable removal pins and fsyncs the same assignment directory.
        // Running sibling renames concurrently changes that directory's
        // metadata while another removal is validating its authority and
        // manufactures DIRECTORY_AUTHORITY_UNSAFE on an otherwise private,
        // lock-held rollback. Serialize the removals while retaining the
        // collect-all-errors behavior.
        const errors: unknown[] = [];
        for (const remove of [
          () => removeLocalPathDurable(path.join(assignmentDir, "input.json")),
          () => removeLocalPathDurable(path.join(assignmentDir, "state.json")),
          () => removeLocalPathDurable(path.join(assignmentDir, "attempts"), { recursive: true }),
          () => removeLocalPathDurable(path.join(assignmentDir, LOCAL_ENQUEUE_OWNER_FILE)),
        ]) {
          try {
            await remove();
          } catch (error) {
            errors.push(...flattenedErrors(error));
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, `new assignment removal failed: ${assignmentId}`);
      }));
    } else {
      operations.push(
        operation("input", () => writeJsonAtomic(path.join(assignmentDir, "input.json"), previousDocument.input)),
        operation("state", () => this._writeState(assignmentId, previousDocument.state)),
        operation("owner", () => previousOwner
          ? writeJsonAtomic(path.join(assignmentDir, LOCAL_ENQUEUE_OWNER_FILE), previousOwner)
          : removeLocalPathDurable(path.join(assignmentDir, LOCAL_ENQUEUE_OWNER_FILE))),
      );
      const previousAttemptNums = new Set(Object.keys(previousDocument.attempts));
      for (const attemptNum of Object.keys(committedDocument.attempts)) {
        if (!previousAttemptNums.has(attemptNum)) {
          operations.push(operation(
            "removeAttempt",
            () => removeLocalPathDurable(path.join(assignmentDir, "attempts", attemptNum.padStart(3, "0")), { recursive: true }),
            Number(attemptNum),
          ));
        }
      }
      for (const [attemptNum, attempt] of Object.entries(previousDocument.attempts)) {
        operations.push(operation(
          "restoreAttempt",
          () => this._writeAttempt(assignmentId, Number(attemptNum), attempt),
          Number(attemptNum),
        ));
      }
    }
    const errors: unknown[] = [];
    for (const run of operations) {
      try {
        await run();
      } catch (error) {
        errors.push(...flattenedErrors(error));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `assignment document restore failed: ${assignmentId}`);
    }
  }

  async _restoreLocalDocument(
    assignmentId: string,
    previousDocument: AssignmentDocument | null,
    committedDocument: AssignmentDocument,
    previousOwner: LooseRecord | null,
    committedOwner: LooseRecord,
  ) {
    const current = await this._localDocumentSnapshot(assignmentId);
    if (!this._localDocumentMatchesEnqueuePartial(current, previousDocument, committedDocument, previousOwner, committedOwner)) {
      throw Object.assign(
        new Error(`assignment compensation conflict: ${assignmentId} changed after partial enqueue`),
        { code: "HUB_ASSIGNMENT_COMPENSATION_CONFLICT" },
      );
    }
    await this._restoreLocalDocumentComponents(assignmentId, previousDocument, committedDocument, previousOwner);
  }

  async _restoreLocalEnqueueAfterFailure(
    assignmentId: string,
    previousDocument: AssignmentDocument | null,
    committedDocument: AssignmentDocument,
    previousOwner: LooseRecord | null,
    committedOwner: LooseRecord,
    originalError: unknown,
  ): Promise<never> {
    const cleanup = await Promise.allSettled([
      this._restoreLocalDocument(assignmentId, previousDocument, committedDocument, previousOwner, committedOwner),
    ]);
    const cleanupErrors = cleanup.flatMap((result) => result.status === "rejected" ? flattenedErrors(result.reason) : []);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [originalError, ...cleanupErrors],
        `assignment enqueue rollback failed: ${assignmentId}`,
      );
    }
    throw originalError;
  }

  async compensateEnqueueReceipt(receipt: AssignmentEnqueueReceipt) {
    const backend = await this._backend();
    if (backend) {
      if (receipt.writeFence.backend !== "redis") {
        throw Object.assign(new Error(`assignment compensation backend mismatch: ${receipt.assignmentId}`), { code: "HUB_ASSIGNMENT_COMPENSATION_CONFLICT" });
      }
      const { snapshot, document } = await this._readRedisDocument(backend, receipt.assignmentId);
      if (snapshot.revision !== receipt.writeFence.revision || !receiptDeepEqual(document, receipt.committedDocument)) {
        throw Object.assign(new Error(`assignment compensation conflict: ${receipt.assignmentId} changed after enqueue`), { code: "HUB_ASSIGNMENT_COMPENSATION_CONFLICT" });
      }
      const committed = await backend.compareAndSwapStateRecord(
        this._assignmentField(receipt.assignmentId),
        snapshot.revision,
        receipt.previousDocument,
        processLeaderFence(backend.identityFingerprint),
      );
      if (committed.fenced) {
        throw Object.assign(new Error("leader lease no longer authorizes assignment compensation"), { code: "HUB_LEADER_FENCED" });
      }
      if (!committed.committed) {
        throw Object.assign(new Error(`assignment compensation conflict: ${receipt.assignmentId} changed during rollback`), { code: "HUB_ASSIGNMENT_COMPENSATION_CONFLICT" });
      }
      return true;
    }
    return this._withAssignmentLock(receipt.assignmentId, async (lockContext) => {
      if (receipt.writeFence.backend !== "local") {
        throw Object.assign(new Error(`assignment compensation backend mismatch: ${receipt.assignmentId}`), { code: "HUB_ASSIGNMENT_COMPENSATION_CONFLICT" });
      }
      const currentSnapshot = await this._localDocumentSnapshot(receipt.assignmentId);
      const currentDocument = this._assignmentDocumentFromLocalSnapshot(receipt.assignmentId, currentSnapshot);
      if (lockContext.predecessorMutationOwnerToken !== receipt.writeFence.mutationOwnerToken
        || !receiptDeepEqual(currentDocument, receipt.committedDocument)
        || !receiptDeepEqual(currentSnapshot?.writeOwner || null, receipt.writeFence.committedOwner)
        || currentSnapshot?.writeOwner?.ownerToken !== receipt.writeFence.ownerToken) {
        throw Object.assign(new Error(`assignment compensation conflict: ${receipt.assignmentId} changed after enqueue`), { code: "HUB_ASSIGNMENT_COMPENSATION_CONFLICT" });
      }
      await this._restoreLocalDocumentComponents(
        receipt.assignmentId,
        receipt.previousDocument,
        receipt.committedDocument,
        receipt.writeFence.previousOwner,
      );
      return true;
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
      attempt.result = result;
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
      attempt.result = syntheticResult;
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

  /**
   * Persist a cancellation request. The optional signal/deadline can stop
   * lock acquisition and pre-commit I/O; once the durable write/CAS commits,
   * the method returns that committed result even if cancellation races it.
   */
  async writeCancel(
    assignmentId: string,
    attemptNum: number,
    reason: string,
    options: AssignmentWriteCancelOptions = {},
  ) {
    throwIfAssignmentOperationStopped(options);
    const backend = await this._backend();
    throwIfAssignmentOperationStopped(options);
    if (backend) {
      return this._mutateRedisDocumentAbortable(backend, assignmentId, options, (current) => {
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
      throwIfAssignmentOperationStopped(options);
      const { state } = await this._loadActiveAttempt(assignmentId, attemptNum);
      throwIfAssignmentOperationStopped(options);
      if (["completed", "failed", "cancelled", "blocked"].includes(String(state.status || ""))) {
        return false;
      }
      const dir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"), "control");
      throwIfAssignmentOperationStopped(options);
      await mkdir(dir, { recursive: true });
      throwIfAssignmentOperationStopped(options);
      await writeJsonAtomic(path.join(dir, "cancel.json"), {
        reason,
        requestedAt: new Date().toISOString(),
        requestedBy: "hub",
      });
      await assignmentStoreTestHooks().afterLocalCancelCommit?.({ assignmentId, attempt: attemptNum });
      return true;
    }, options);
  }

  async readCancel(assignmentId: string, attemptNum: number) {
    const backend = await this._backend();
    if (backend) {
      const { document } = await this._readRedisDocument(backend, assignmentId);
      if (!document) return null;
      return document.attempts[String(attemptNum)]?.cancel || null;
    }
    try {
      return await this._readLocalJsonObject(
        path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"), "control", "cancel.json"),
        "assignment cancel",
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async getAssignment(assignmentId: string): Promise<AssignmentRecord | null> {
    const backend = await this._backend();
    if (backend) return (await this._readRedisDocument(backend, assignmentId)).document?.state || null;
    return this._readState(assignmentId);
  }

  async getAttempt(assignmentId: string, attemptNum: number): Promise<AssignmentAttempt | null> {
    if (!Number.isSafeInteger(attemptNum) || attemptNum < 1) return null;
    const backend = await this._backend();
    if (backend) {
      const { document } = await this._readRedisDocument(backend, assignmentId);
      return document?.attempts[String(attemptNum)] || null;
    }
    try {
      const attempt = await this._readAttempt(assignmentId, attemptNum);
      const heartbeat = await this._readLocalJsonObject(
        path.join(
          this.baseDir,
          assignmentId,
          "attempts",
          String(attemptNum).padStart(3, "0"),
          "heartbeat.json",
        ),
        "assignment heartbeat",
      );
      return heartbeat ? { ...attempt, heartbeat } : attempt;
    } catch (error) {
      if (errorCode(error) === "ENOENT" || String(error).includes("assignment attempt not found")) return null;
      throw error;
    }
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
    const state = await this._readLocalJsonObject(
      path.join(this.baseDir, assignmentId, "state.json"),
      "assignment state",
    );
    return state ? recordValue(state) as AssignmentRecord : null;
  }

  async _writeState(assignmentId: string, state: LooseRecord) {
    await writeJsonAtomic(path.join(this.baseDir, assignmentId, "state.json"), state);
  }

  async _readAttempt(assignmentId: string, attemptNum: number): Promise<AssignmentAttempt> {
    const dir = String(attemptNum).padStart(3, "0");
    const attempt = await this._readLocalJsonObject(
      path.join(this.baseDir, assignmentId, "attempts", dir, "attempt.json"),
      `assignment attempt ${dir}`,
    );
    if (!attempt) throw new Error(`assignment attempt not found: ${assignmentId} attempt ${attemptNum}`);
    return recordValue(attempt) as AssignmentAttempt;
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

  async _withAssignmentLock<T>(
    assignmentId: string,
    callback: (context: AssignmentLockContext) => Promise<T>,
    options: AssignmentWriteCancelOptions = {},
  ): Promise<T> {
    throwIfAssignmentOperationStopped(options);
    await assertHubWritable(this.hubRoot);
    throwIfAssignmentOperationStopped(options);
    const assignmentDir = path.join(this.baseDir, assignmentId);
    const lockDir = path.join(assignmentDir, "state.lock");
    const ownerFile = path.join(lockDir, "owner.json");
    const ownerToken = crypto.randomUUID();
    const captureProcessIdentityHook = assignmentStoreTestHooks().captureAssignmentProcessIdentity;
    const capturedIdentity = captureProcessIdentityHook
      ? captureProcessIdentityHook(process.pid)
      : captureProcessIdentity(process.pid, { strict: true });
    const processIdentity = capturedIdentity
      ? this._assignmentProcessIdentity(capturedIdentity, process.pid)
      : null;
    if (!processIdentity) {
      throw assignmentLockConflict(`assignment lock process identity unavailable: ${assignmentId}`);
    }
    await mkdir(assignmentDir, { recursive: true });
    throwIfAssignmentOperationStopped(options);

    let acquired = false;
    for (let attempt = 0; attempt < ASSIGNMENT_LOCK_RETRIES; attempt += 1) {
      throwIfAssignmentOperationStopped(options);
      acquired = await withDirectoryProcessFence(lockDir, async () => {
        let createdInfo: AssignmentPathGeneration;
        try {
          await mkdir(lockDir);
          createdInfo = assignmentPathGeneration(await lstat(lockDir));
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          let candidate: AssignmentLockCandidate | null;
          try {
            candidate = await this._assignmentLockRecoveryCandidate(lockDir, ownerFile);
          } catch (recoveryError) {
            if (assignmentLockReadChanged(recoveryError)) return false;
            throw recoveryError;
          }
          throwIfAssignmentOperationStopped(options);
          if (candidate) {
            await assignmentStoreTestHooks().afterAssignmentLockRecoveryObserved?.({
              lockDir,
              ownerToken: candidate.ownerToken,
              kind: candidate.kind,
            });
            await this._quarantineAssignmentLock(lockDir, candidate);
            throwIfAssignmentOperationStopped(options);
          }
          return false;
        }

        const owner = {
          schemaVersion: ASSIGNMENT_OWNER_SCHEMA_VERSION,
          ownerToken,
          pid: process.pid,
          host: os.hostname(),
          acquiredAt: new Date().toISOString(),
          processIdentity,
        };
        try {
          await writeJsonDurableAtomic(ownerFile, owner, { syncParentDirectory: syncAssignmentDirectory });
          await syncAssignmentDirectory(assignmentDir);
          return true;
        } catch (primaryError) {
          if (primaryError && typeof primaryError === "object"
            && "committed" in primaryError && primaryError.committed === true) {
            throw primaryError;
          }
          let cleanupError: unknown = null;
          try {
            const currentOwner = await this._readAssignmentLockOwner(ownerFile);
            if (currentOwner && !this._sameAssignmentLockOwner(owner, currentOwner)) {
              throw assignmentLockConflict(`assignment lock owner changed after acquisition write failed: ${assignmentId}`);
            }
            await this._quarantineAssignmentLock(lockDir, {
              kind: "incomplete",
              owner: currentOwner,
              ownerToken: typeof currentOwner?.ownerToken === "string" ? currentOwner.ownerToken : null,
              lockIdentity: createdInfo,
            });
          } catch (error) {
            cleanupError = error;
          }
          if (!cleanupError) throw primaryError;
          throw assignmentLockConflict(
            `assignment lock acquisition and cleanup both failed: ${assignmentId}`,
            new AggregateError([primaryError, cleanupError], `assignment lock acquisition and cleanup both failed: ${assignmentId}`, {
              cause: primaryError,
            }),
          );
        }
      }, {
        waitMs: Math.max(ASSIGNMENT_LOCK_RETRY_MS, ASSIGNMENT_LOCK_RETRIES * ASSIGNMENT_LOCK_RETRY_MS),
        signal: options.signal,
      });
      if (acquired) break;
      await waitForAssignmentRetry(ASSIGNMENT_LOCK_RETRY_MS, options);
      }

    if (!acquired) throw new Error(`assignment state lock busy: ${assignmentId}`);
    let value: T | undefined;
    let primaryError: unknown = null;
    try {
      throwIfAssignmentOperationStopped(options);
      const mutationOwnerFile = path.join(assignmentDir, LOCAL_MUTATION_OWNER_FILE);
      const predecessor = await this._readLocalJsonObject(mutationOwnerFile, "assignment mutation owner");
      throwIfAssignmentOperationStopped(options);
      await writeJsonDurableAtomic(mutationOwnerFile, {
        schemaVersion: ASSIGNMENT_OWNER_SCHEMA_VERSION,
        assignmentId,
        ownerToken,
        pid: process.pid,
        host: os.hostname(),
        acquiredAt: new Date().toISOString(),
        processIdentity,
      }, { syncParentDirectory: syncAssignmentDirectory });
      await syncAssignmentDirectory(assignmentDir);
      throwIfAssignmentOperationStopped(options);
      value = await callback({
        ownerToken,
        predecessorMutationOwnerToken: typeof predecessor?.ownerToken === "string" && predecessor.ownerToken
          ? predecessor.ownerToken
          : null,
      });
    } catch (error) {
      primaryError = error;
    }
    let releaseError: unknown = null;
    try {
      await this._releaseAssignmentLock(ownerFile, ownerToken);
    } catch (error) {
      releaseError = error;
    }
    if (primaryError) {
      if (!releaseError) throw primaryError;
      throw new AggregateError(
        [primaryError, releaseError],
        `assignment operation and lock release both failed: ${assignmentId}`,
        { cause: primaryError },
      );
    }
    if (releaseError) throw releaseError;
    return value as T;
  }

  async _readAssignmentLockOwner(ownerFile: string) {
    try {
      const raw = await readBoundedRegularFileNoFollow(ownerFile, { maxBytes: 64 * 1024 });
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw assignmentLockConflict(`assignment lock owner is not a JSON object: ${ownerFile}`);
      }
      const owner = parsed as LooseRecord;
      if (typeof owner.ownerToken !== "string" || !owner.ownerToken
        || !Number.isSafeInteger(Number(owner.pid)) || Number(owner.pid) <= 0
        || typeof owner.host !== "string" || !owner.host
        || !validIsoTimestamp(owner.acquiredAt)
        || (owner.releasedAt !== undefined && !validIsoTimestamp(owner.releasedAt))) {
        throw assignmentLockConflict(`assignment lock owner is malformed: ${ownerFile}`);
      }
      if (owner.schemaVersion !== undefined
        && (!Number.isInteger(Number(owner.schemaVersion)) || Number(owner.schemaVersion) !== ASSIGNMENT_OWNER_SCHEMA_VERSION)) {
        throw assignmentLockConflict(`assignment lock owner schema is unsupported: ${ownerFile}`);
      }
      if (owner.schemaVersion === ASSIGNMENT_OWNER_SCHEMA_VERSION && owner.processIdentity === undefined) {
        throw assignmentLockConflict(`assignment lock owner process identity is missing: ${ownerFile}`);
      }
      if (owner.processIdentity !== undefined && !this._assignmentProcessIdentity(owner.processIdentity, Number(owner.pid))) {
        throw assignmentLockConflict(`assignment lock owner process identity is malformed: ${ownerFile}`);
      }
      return owner;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      if (errorCode(error) === "HUB_ASSIGNMENT_LOCK_CONFLICT") throw error;
      throw assignmentLockConflict(`assignment lock owner cannot be read safely: ${ownerFile}`, error);
    }
  }

  _assignmentProcessIdentity(value: unknown, expectedPid: number): ProcessIdentity | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Partial<ProcessIdentity>;
    const processGroupId = Number(candidate.processGroupId);
    if (
      !Number.isSafeInteger(candidate.pid)
      || !Number.isSafeInteger(expectedPid)
      || candidate.pid !== expectedPid
      || typeof candidate.birthId !== "string"
      || !candidate.birthId
      || candidate.incarnation !== `${candidate.pid}:${candidate.birthId}`
      || candidate.birthIdPrecision !== "exact"
      || typeof candidate.capturedAt !== "string"
      || !validIsoTimestamp(candidate.capturedAt)
      || (candidate.processGroupId !== undefined && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
    ) return null;
    const identity: ProcessIdentity = {
      pid: candidate.pid,
      birthId: candidate.birthId,
      incarnation: candidate.incarnation,
      capturedAt: candidate.capturedAt,
      birthIdPrecision: "exact",
    };
    if (candidate.processGroupId !== undefined) identity.processGroupId = processGroupId;
    return identity;
  }

  _assignmentLockOwnerAlive(owner: LooseRecord | null) {
    if (!owner) return false;
    const pid = Number(owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const host = typeof owner.host === "string" ? owner.host : "";
    // A different host cannot be checked against this machine's exact process
    // identity. Preserve its potentially active shared-filesystem lock.
    if (host && host !== os.hostname()) return true;
    const identity = this._assignmentProcessIdentity(owner.processIdentity, pid);
    if (!identity) return true;
    try {
      return (assignmentStoreTestHooks().isAssignmentProcessIdentityAlive || isProcessIdentityAlive)(identity);
    } catch (error) {
      throw assignmentLockConflict(`assignment lock owner identity probe failed for pid ${pid}`, error);
    }
  }

  async _assignmentLockRecoveryCandidate(lockDir: string, ownerFile: string): Promise<AssignmentLockCandidate | null> {
    let pinned: Awaited<ReturnType<typeof openPinnedAssignmentDirectory>>;
    try {
      pinned = await openPinnedAssignmentDirectory(lockDir, "assignment lock path");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      if (errorCode(error) === "HUB_ASSIGNMENT_LOCK_CONFLICT") throw error;
      throw assignmentLockConflict(`assignment lock path cannot be inspected safely: ${lockDir}`, error);
    }
    let primaryError: unknown = null;
    let result: AssignmentLockCandidate | null = null;
    try {
      const owner = await this._readAssignmentLockOwner(ownerFile);
      const afterOwnerRead = await lstat(lockDir);
      if (!afterOwnerRead.isDirectory()
        || afterOwnerRead.isSymbolicLink()
        || !sameAssignmentPathGeneration(pinned.generation, assignmentPathGeneration(afterOwnerRead))) {
        throw assignmentLockConflict(`assignment lock path changed during owner read: ${lockDir}`, Object.assign(
          new Error("bounded assignment lock directory changed"),
          { code: "BOUNDED_FILE_CHANGED" },
        ));
      }
      const ownerToken = typeof owner?.ownerToken === "string" && owner.ownerToken ? owner.ownerToken : null;
      const ownerIdentity = owner
        ? this._assignmentProcessIdentity(owner.processIdentity, Number(owner.pid))
        : null;
      if (owner?.releasedAt) {
        result = ownerIdentity
          ? { kind: "released", owner, ownerToken, lockIdentity: pinned.generation }
          : null;
      } else if (Date.now() - afterOwnerRead.mtimeMs >= ASSIGNMENT_LOCK_TTL_MS && !this._assignmentLockOwnerAlive(owner)) {
        result = {
          kind: owner ? "stale" : "incomplete",
          owner,
          ownerToken,
          lockIdentity: pinned.generation,
        };
      }
    } catch (error) {
      primaryError = error;
    }
    try {
      await pinned.handle.close();
    } catch (closeError) {
      if (primaryError) {
        throw new AggregateError([primaryError, closeError], `assignment lock path read and close failed: ${lockDir}`, {
          cause: primaryError,
        });
      }
      throw closeError;
    }
    if (primaryError) throw primaryError;
    return result;
  }

  async _assignmentLockRecoveryKind(lockDir: string, ownerFile: string) {
    return (await this._assignmentLockRecoveryCandidate(lockDir, ownerFile))?.kind || null;
  }

  _sameAssignmentLockOwner(expected: LooseRecord | null, actual: LooseRecord | null) {
    if (!expected || !actual) return expected === actual;
    if (expected.ownerToken !== actual.ownerToken || Number(expected.pid) !== Number(actual.pid)) return false;
    const expectedIdentity = this._assignmentProcessIdentity(expected.processIdentity, Number(expected.pid));
    const actualIdentity = this._assignmentProcessIdentity(actual.processIdentity, Number(actual.pid));
    if (expectedIdentity || actualIdentity) return sameProcessIdentity(expectedIdentity, actualIdentity);
    return true;
  }

  async _restoreQuarantinedAssignmentLock(quarantineDir: string, lockDir: string, conflict: Error) {
    const errors: unknown[] = [conflict];
    let successorPreserved = false;
    try {
      await lstat(lockDir);
      successorPreserved = true;
    } catch (restoreError) {
      if (errorCode(restoreError) !== "ENOENT") errors.push(restoreError);
    }
    try {
      await syncAssignmentDirectory(path.dirname(lockDir));
    } catch (syncError) {
      errors.push(syncError);
    }
    try {
      await syncAssignmentDirectory(quarantineDir);
    } catch (syncError) {
      errors.push(syncError);
    }
    throw Object.assign(new AggregateError(
      errors,
      successorPreserved
        ? `assignment lock successor preserved while quarantine remains: ${lockDir}; quarantined=${quarantineDir}`
        : `assignment lock quarantine preserved; canonical restore refused: ${lockDir}; quarantined=${quarantineDir}`,
      { cause: conflict },
    ), {
      code: "HUB_ASSIGNMENT_LOCK_CONFLICT",
      committed: false,
      recoveryPaths: { quarantineDir, lockDir },
      quarantineDir,
      lockDir,
      successorPreserved,
    });
  }

  async _quarantineAssignmentLock(lockDir: string, candidate: AssignmentLockCandidate) {
    const quarantineDir = `${lockDir}.${candidate.kind}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    const pinned = await openPinnedAssignmentDirectory(lockDir, "assignment lock path");
    try {
      if (!sameAssignmentPathGeneration(pinned.generation, candidate.lockIdentity)) {
        throw Object.assign(
          assignmentLockConflict(`assignment lock successor preserved before quarantine: ${lockDir}`),
          {
            committed: false,
            recoveryPaths: { lockDir },
            lockDir,
            successorPreserved: true,
          },
        );
      }
    } finally {
      await pinned.handle.close();
    }
    const beforeRename = await lstat(lockDir);
    if (!beforeRename.isDirectory()
      || beforeRename.isSymbolicLink()
      || !sameAssignmentPathGeneration(assignmentPathGeneration(beforeRename), candidate.lockIdentity)) {
      throw Object.assign(
        assignmentLockConflict(`assignment lock successor preserved before quarantine: ${lockDir}`),
        {
          committed: false,
          recoveryPaths: { lockDir },
          lockDir,
          successorPreserved: true,
        },
      );
    }
    try {
      await rename(lockDir, quarantineDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    await syncAssignmentDirectory(path.dirname(lockDir));
    await assignmentStoreTestHooks().afterAssignmentLockQuarantineRename?.({
      lockDir,
      quarantineDir,
      ownerToken: candidate.ownerToken,
      kind: candidate.kind,
    });
    const quarantinedInfo = await lstat(quarantineDir);
    const quarantinedOwner = await this._readAssignmentLockOwner(path.join(quarantineDir, "owner.json"));
    try {
      await lstat(lockDir);
      await this._restoreQuarantinedAssignmentLock(
        quarantineDir,
        lockDir,
        assignmentLockConflict(`assignment lock successor appeared during quarantine: ${lockDir}`),
      );
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (
      !sameAssignmentPathObject(assignmentPathGeneration(quarantinedInfo), candidate.lockIdentity)
      || !this._sameAssignmentLockOwner(candidate.owner, quarantinedOwner)
    ) {
      await this._restoreQuarantinedAssignmentLock(
        quarantineDir,
        lockDir,
        assignmentLockConflict(`assignment lock owner changed during quarantine: ${lockDir}`),
      );
    }
    await syncAssignmentDirectory(path.dirname(lockDir));
    return true;
  }

  async _writeAssignmentLockOwnerGuarded(ownerFile: string, ownerToken: string, next: LooseRecord) {
    const lockDir = path.dirname(ownerFile);
    const tempPath = path.join(lockDir, `.owner-${ownerToken}-${crypto.randomUUID()}.tmp`);
    let created = false;
    let renamed = false;
    let result = false;
    let primaryError: unknown = null;
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
      if (current?.ownerToken === ownerToken) {
        try {
          await rename(tempPath, ownerFile);
          renamed = true;
          await syncAssignmentDirectory(lockDir);
          result = true;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") primaryError = error;
    }
    const cleanupErrors: unknown[] = [];
    if (created && !renamed) {
      try {
        await lstat(tempPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") cleanupErrors.push(error);
      }
      try {
        await syncAssignmentDirectory(lockDir);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const cleanupError = cleanupErrors.length === 0
      ? null
      : new AggregateError(cleanupErrors, `assignment lock owner temp cleanup failed: ${ownerFile}`);
    if (primaryError) {
      const error = new AggregateError(
        cleanupError ? [primaryError, cleanupError] : [primaryError],
        `assignment lock owner update and temp cleanup both failed: ${ownerFile}`,
        { cause: primaryError },
      );
      if (renamed) {
        throw Object.assign(error, {
          code: "HUB_ASSIGNMENT_LOCK_CONFLICT",
          committed: true,
          recoveryPaths: { ownerFile, lockDir },
          ownerFile,
          lockDir,
        });
      }
      if (!cleanupError) throw primaryError;
      throw error;
    }
    if (cleanupError) throw cleanupError;
    return result;
  }

  async _releaseAssignmentLock(ownerFile: string, ownerToken: string) {
    const lockDir = path.dirname(ownerFile);
    return withDirectoryProcessFence(lockDir, async () => {
      const owner = await this._readAssignmentLockOwner(ownerFile);
      if (owner?.ownerToken !== ownerToken) {
        throw assignmentLockConflict(`assignment lock owner changed before release: ${lockDir}`);
      }
      const releasedAt = new Date().toISOString();
      const released = await this._writeAssignmentLockOwnerGuarded(ownerFile, ownerToken, {
        ...owner,
        releasedAt,
      });
      if (!released) {
        throw assignmentLockConflict(`assignment lock owner changed during release: ${lockDir}`);
      }
      return true;
    }, {
      waitMs: Math.max(ASSIGNMENT_LOCK_RETRY_MS, ASSIGNMENT_LOCK_RETRIES * ASSIGNMENT_LOCK_RETRY_MS),
    });
  }
}
