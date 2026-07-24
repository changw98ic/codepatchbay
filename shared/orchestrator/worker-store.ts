import type { LooseRecord } from "../types.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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

const WORKERS_DIR = "workers";
export const INBOX_CLAIM_TTL_MS = 60_000;
const LOCAL_INBOX_WRITE_OWNER_SUFFIX = ".write-owner";
const LOCAL_INBOX_LOCK_TTL_MS = 30_000;
const LOCAL_INBOX_LOCK_RETRIES = 500;
const LOCAL_INBOX_LOCK_RETRY_MS = 10;
const LOCAL_INBOX_LOCK_OWNER_MAX_BYTES = 64 * 1024;
const LOCAL_WORKER_JSON_MAX_BYTES = 1024 * 1024;
const LOCAL_WORKER_DIRECTORY_MAX_ENTRIES = 100_000;

export type WorkerUpdateExpectation = {
  incarnationToken?: string;
  currentAssignmentId?: string | null;
  currentAttemptToken?: string | null;
  status?: string | string[];
};

export type WorkerInboxReceipt = {
  workerId: string;
  assignmentId: string;
  attempt: number;
  attemptToken: string;
  backend: "local" | "redis";
  ref: string;
  path?: string;
  previousRecord: LooseRecord | null;
  committedRecord: LooseRecord;
  writeFence:
    | {
        backend: "local";
        ownerToken: string;
        previousOwner: LooseRecord | null;
        committedOwner: LooseRecord;
        payloadGeneration: WorkerPathGeneration;
        ownerGeneration: WorkerPathGeneration;
      }
    | {
        backend: "redis";
        revision: number;
      };
};

type LocalInboxLockCandidate = {
  kind: "released" | "stale" | "incomplete";
  ownerToken: string | null;
  owner: LooseRecord | null;
  processIdentity?: ProcessIdentity;
  lockGeneration: WorkerPathGeneration;
};

type WorkerPathGeneration = {
  dev: number | bigint;
  ino: number | bigint;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type WorkerPathKind = "file" | "directory";

type LocalWorkerRecord = LooseRecord & Record<string, any>;

export type WorkerStoreTestHooks = {
  afterLocalInboxLockMkdir?: (context: { lockDir: string; ownerToken: string }) => void | Promise<void>;
  beforeLocalInboxLockQuarantineRename?: (context: {
    lockDir: string;
    ownerToken: string | null;
    kind: string;
  }) => void | Promise<void>;
  afterLocalInboxLockQuarantineRename?: (context: {
    lockDir: string;
    quarantineDir: string;
    ownerToken: string | null;
    kind: string;
  }) => void | Promise<void>;
  beforeLocalInboxLockReleaseMarker?: (context: { lockDir: string; ownerToken: string }) => void | Promise<void>;
  beforeLocalInboxWriteOwner?: (context: { ownerPath: string; ownerToken: string }) => void | Promise<void>;
  afterLocalInboxWriteOwner?: (context: {
    filePath: string;
    ownerPath: string;
    stagingPath: string;
    ownerToken: string;
  }) => void | Promise<void>;
  isLocalInboxProcessIdentityAlive?: (identity: ProcessIdentity) => boolean;
  syncWorkerDirectory?: (directory: string) => Promise<void>;
  beforeWorkerPathIsolationRename?: (context: {
    filePath: string;
    quarantinePath: string;
    kind: WorkerPathKind;
    reason: string;
  }) => void | Promise<void>;
  afterWorkerPathIsolationRename?: (context: {
    filePath: string;
    quarantinePath: string;
    kind: WorkerPathKind;
    reason: string;
  }) => void | Promise<void>;
};

const workerStoreTestHookStorage = new AsyncLocalStorage<WorkerStoreTestHooks>();

export function withWorkerStoreTestHooksForTests<T>(hooks: WorkerStoreTestHooks, fn: () => T): T {
  const parent = workerStoreTestHookStorage.getStore();
  return workerStoreTestHookStorage.run(parent ? { ...parent, ...hooks } : hooks, fn);
}

function workerStoreTestHooks() {
  return workerStoreTestHookStorage.getStore() || {};
}

async function syncWorkerDirectory(directory: string) {
  const hook = workerStoreTestHooks().syncWorkerDirectory;
  if (hook) {
    await hook(directory);
    return;
  }
  await fsyncDirectory(directory);
}

function workerPathGeneration(info: WorkerPathGeneration): WorkerPathGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function validWorkerPathGeneration(value: unknown): WorkerPathGeneration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const validDevicePart = (part: unknown) => (typeof part === "number" && Number.isFinite(part))
    || typeof part === "bigint";
  const validMetric = (metric: unknown) => typeof metric === "number" && Number.isFinite(metric);
  if (!validDevicePart(candidate.dev)
    || !validDevicePart(candidate.ino)
    || !validMetric(candidate.size)
    || !validMetric(candidate.mtimeMs)
    || !validMetric(candidate.ctimeMs)
    || !validMetric(candidate.birthtimeMs)) {
    return null;
  }
  return workerPathGeneration(candidate as WorkerPathGeneration);
}

function sameWorkerPathGeneration(expected: WorkerPathGeneration, actual: WorkerPathGeneration) {
  return String(expected.dev) === String(actual.dev)
    && String(expected.ino) === String(actual.ino)
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

function sameMovedWorkerPathGeneration(expected: WorkerPathGeneration, actual: WorkerPathGeneration) {
  return String(expected.dev) === String(actual.dev)
    && String(expected.ino) === String(actual.ino)
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

function sameWorkerPathIdentity(expected: WorkerPathGeneration, actual: WorkerPathGeneration) {
  return String(expected.dev) === String(actual.dev)
    && String(expected.ino) === String(actual.ino)
    && expected.birthtimeMs === actual.birthtimeMs;
}

function workerPathError(message: string, code: string, cause?: unknown) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code },
  );
}

function requiredWorkerPathOpenFlags(kind: WorkerPathKind) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw workerPathError("worker path cleanup requires O_NOFOLLOW", "HUB_WORKER_PATH_UNSAFE");
  }
  if (kind === "directory"
    && (typeof constants.O_DIRECTORY !== "number" || constants.O_DIRECTORY === 0)) {
    throw workerPathError("worker directory cleanup requires O_DIRECTORY", "HUB_WORKER_PATH_UNSAFE");
  }
  return constants.O_RDONLY
    | constants.O_NOFOLLOW
    | (kind === "directory" ? constants.O_DIRECTORY : 0);
}

function assertWorkerPathKind(
  info: { isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean },
  kind: WorkerPathKind,
  filePath: string,
) {
  const valid = kind === "directory" ? info.isDirectory() : info.isFile();
  if (!valid || info.isSymbolicLink()) {
    throw workerPathError(
      `worker ${kind} path is unsafe: ${filePath}`,
      "HUB_WORKER_PATH_UNSAFE",
    );
  }
}

async function closeWorkerHandle(handle: FileHandle | null) {
  if (!handle) return null;
  try {
    await handle.close();
    return null;
  } catch (error) {
    return error;
  }
}

async function openPinnedWorkerPath(
  filePath: string,
  kind: WorkerPathKind,
): Promise<{ handle: FileHandle; generation: WorkerPathGeneration } | null> {
  let before;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  assertWorkerPathKind(before, kind, filePath);

  let handle: FileHandle | null = null;
  let primary: unknown;
  let failed = false;
  try {
    handle = await open(filePath, requiredWorkerPathOpenFlags(kind));
    const opened = await handle.stat();
    assertWorkerPathKind(opened, kind, filePath);
    if (!sameWorkerPathGeneration(workerPathGeneration(before), workerPathGeneration(opened))) {
      throw workerPathError(
        `worker ${kind} generation changed while opening: ${filePath}`,
        "HUB_WORKER_PATH_GENERATION_CONFLICT",
      );
    }
    const after = await lstat(filePath);
    assertWorkerPathKind(after, kind, filePath);
    if (!sameWorkerPathGeneration(workerPathGeneration(opened), workerPathGeneration(after))) {
      throw workerPathError(
        `worker ${kind} pathname changed while opening: ${filePath}`,
        "HUB_WORKER_PATH_GENERATION_CONFLICT",
      );
    }
    return { handle, generation: workerPathGeneration(opened) };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      const closeError = await closeWorkerHandle(handle);
      if (closeError) {
        throw new AggregateError(
          [error, closeError],
          `worker ${kind} path disappeared and handle close failed: ${filePath}`,
          { cause: error },
        );
      }
      return null;
    }
    primary = error;
    failed = true;
  }

  const closeError = await closeWorkerHandle(handle);
  if (failed && closeError) {
    throw new AggregateError(
      [primary, closeError],
      `worker ${kind} authority open and close failed: ${filePath}`,
      { cause: primary },
    );
  }
  if (failed) throw primary;
  throw closeError;
}

async function observeWorkerPathGeneration(
  filePath: string,
  kind: WorkerPathKind,
): Promise<WorkerPathGeneration | null> {
  const pinned = await openPinnedWorkerPath(filePath, kind);
  if (!pinned) return null;
  const closeError = await closeWorkerHandle(pinned.handle);
  if (closeError) throw closeError;
  return pinned.generation;
}

async function readWorkerDirectoryNamesPinned(directory: string): Promise<string[] | null> {
  const pinned = await openPinnedWorkerPath(directory, "directory");
  if (!pinned) return null;
  let stream: Awaited<ReturnType<typeof opendir>> | null = null;
  let primary: unknown;
  let failed = false;
  const names: string[] = [];
  try {
    stream = await opendir(directory);
    while (true) {
      const entry = await stream.read();
      if (!entry) break;
      names.push(entry.name);
      if (names.length > LOCAL_WORKER_DIRECTORY_MAX_ENTRIES) {
        throw workerPathError(
          `worker directory exceeds ${LOCAL_WORKER_DIRECTORY_MAX_ENTRIES} entries: ${directory}`,
          "HUB_WORKER_DIRECTORY_TOO_LARGE",
        );
      }
    }
    const openedAfter = await pinned.handle.stat();
    const pathAfter = await lstat(directory);
    assertWorkerPathKind(openedAfter, "directory", directory);
    assertWorkerPathKind(pathAfter, "directory", directory);
    if (!sameWorkerPathGeneration(pinned.generation, workerPathGeneration(openedAfter))
      || !sameWorkerPathGeneration(pinned.generation, workerPathGeneration(pathAfter))) {
      throw workerPathError(
        `worker directory changed during listing: ${directory}`,
        "HUB_WORKER_PATH_GENERATION_CONFLICT",
      );
    }
  } catch (error) {
    primary = error;
    failed = true;
  }

  const closeErrors: unknown[] = [];
  if (stream) {
    try {
      await stream.close();
    } catch (error) {
      closeErrors.push(error);
    }
  }
  const handleCloseError = await closeWorkerHandle(pinned.handle);
  if (handleCloseError) closeErrors.push(handleCloseError);
  if (failed) {
    if (closeErrors.length === 0) throw primary;
    throw new AggregateError(
      [primary, ...closeErrors],
      `worker directory listing and close failed: ${directory}`,
      { cause: primary },
    );
  }
  if (closeErrors.length === 1) throw closeErrors[0];
  if (closeErrors.length > 1) {
    throw new AggregateError(closeErrors, `worker directory close failed: ${directory}`);
  }
  return names;
}

function workerIsolationError(
  message: string,
  code: string,
  {
    filePath,
    quarantinePath,
    committed,
    cause,
    successorPreserved,
  }: {
    filePath: string;
    quarantinePath: string;
    committed: boolean;
    cause?: unknown;
    successorPreserved: boolean | null;
  },
) {
  return Object.assign(workerPathError(message, code, cause), {
    committed,
    renameCommitted: committed,
    committedPath: committed ? quarantinePath : null,
    recoveryPaths: committed
      ? [filePath, quarantinePath, path.dirname(filePath)]
      : [filePath],
    successorPreserved,
    quarantinePreserved: committed,
  });
}

async function canonicalWorkerPathState(filePath: string) {
  try {
    await lstat(filePath);
    return "present" as const;
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" as const : "unavailable" as const;
  }
}

async function isolateWorkerPathDurable(
  filePath: string,
  {
    kind,
    reason,
    expectedGeneration,
  }: {
    kind: WorkerPathKind;
    reason: string;
    expectedGeneration?: WorkerPathGeneration;
  },
) {
  const candidate = expectedGeneration ?? await observeWorkerPathGeneration(filePath, kind);
  if (!candidate) return false;
  const quarantinePath = path.join(path.dirname(filePath), `.worker-cleanup-${crypto.randomUUID()}`);
  await workerStoreTestHooks().beforeWorkerPathIsolationRename?.({
    filePath,
    quarantinePath,
    kind,
    reason,
  });
  const current = await observeWorkerPathGeneration(filePath, kind);
  if (!current || !sameWorkerPathGeneration(candidate, current)) {
    throw workerIsolationError(
      `worker ${kind} successor preserved before isolation: ${filePath}`,
      "HUB_WORKER_PATH_GENERATION_CONFLICT",
      {
        filePath,
        quarantinePath,
        committed: false,
        successorPreserved: current !== null,
      },
    );
  }
  try {
    await rename(filePath, quarantinePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  let hookError: unknown;
  let hookFailed = false;
  try {
    await workerStoreTestHooks().afterWorkerPathIsolationRename?.({
      filePath,
      quarantinePath,
      kind,
      reason,
    });
  } catch (error) {
    hookError = error;
    hookFailed = true;
  }
  try {
    await syncWorkerDirectory(path.dirname(filePath));
  } catch (error) {
    const canonicalState = await canonicalWorkerPathState(filePath);
    const cause = hookFailed
      ? new AggregateError(
        [hookError, error],
        `worker ${kind} isolation hook and directory sync failed: ${filePath}`,
        { cause: hookError },
      )
      : error;
    throw workerIsolationError(
      `worker ${kind} isolation committed with ambiguous durability: ${filePath}`,
      "HUB_WORKER_PATH_ISOLATION_COMMITTED_AMBIGUOUS",
      {
        filePath,
        quarantinePath,
        committed: true,
        cause,
        successorPreserved: canonicalState === "present"
          ? true
          : canonicalState === "missing" ? false : null,
      },
    );
  }

  const moved = await observeWorkerPathGeneration(quarantinePath, kind);
  if (!moved || !sameMovedWorkerPathGeneration(candidate, moved)) {
    const canonicalState = await canonicalWorkerPathState(filePath);
    throw workerIsolationError(
      `worker ${kind} generation changed after isolation: ${filePath}`,
      "HUB_WORKER_PATH_GENERATION_CONFLICT",
      {
        filePath,
        quarantinePath,
        committed: true,
        successorPreserved: canonicalState === "present"
          ? true
          : canonicalState === "missing" ? false : null,
      },
    );
  }
  if (hookFailed) {
    const canonicalState = await canonicalWorkerPathState(filePath);
    throw workerIsolationError(
      `worker ${kind} quarantine preserved after isolation hook failure: ${filePath}`,
      "HUB_WORKER_PATH_QUARANTINE_PRESERVED",
      {
        filePath,
        quarantinePath,
        committed: true,
        cause: hookError,
        successorPreserved: canonicalState === "present"
          ? true
          : canonicalState === "missing" ? false : null,
      },
    );
  }
  const canonicalState = await canonicalWorkerPathState(filePath);
  if (canonicalState !== "missing") {
    throw workerIsolationError(
      canonicalState === "present"
        ? `worker ${kind} successor and quarantine preserved: ${filePath}`
        : `worker ${kind} canonical state is unavailable; quarantine preserved: ${filePath}`,
      canonicalState === "present"
        ? "HUB_WORKER_PATH_SUCCESSOR_PRESERVED"
        : "HUB_WORKER_PATH_QUARANTINE_PRESERVED",
      {
        filePath,
        quarantinePath,
        committed: true,
        successorPreserved: canonicalState === "present" ? true : null,
      },
    );
  }
  return { quarantinePath, generation: candidate };
}

async function removeWorkerPathDurable(filePath: string, options: { recursive?: boolean; reason?: string } = {}) {
  return isolateWorkerPathDurable(filePath, {
    kind: options.recursive === true ? "directory" : "file",
    reason: options.reason || "worker-path-cleanup",
  });
}

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

function normalizeJsonRecord(value: unknown, label: string): LooseRecord {
  let cloned: unknown;
  let serialized: string | undefined;
  try {
    cloned = structuredClone(value);
    serialized = JSON.stringify(cloned);
  } catch (cause) {
    throw Object.assign(new TypeError(`${label} must be JSON-cloneable`, { cause }), {
      code: "HUB_WORKER_INBOX_PAYLOAD_INVALID",
    });
  }
  if (serialized === undefined) {
    throw Object.assign(new TypeError(`${label} must serialize to JSON`), {
      code: "HUB_WORKER_INBOX_PAYLOAD_INVALID",
    });
  }
  const normalized = JSON.parse(serialized) as unknown;
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw Object.assign(new TypeError(`${label} must be a JSON object`), {
      code: "HUB_WORKER_INBOX_PAYLOAD_INVALID",
    });
  }
  return normalized as LooseRecord;
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

function lockConflict(message: string, cause?: unknown) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code: "HUB_WORKER_INBOX_LOCK_CONFLICT" },
  );
}

function retryableLockConflict(message: string, cause?: unknown) {
  return Object.assign(lockConflict(message, cause), { retryable: true });
}

function lockConflictAggregate(errors: unknown[], message: string, quarantineDir: string) {
  return Object.assign(new AggregateError(errors, message), {
    code: "HUB_WORKER_INBOX_LOCK_CONFLICT",
    quarantineDir,
  });
}

function validProcessIdentity(value: unknown, expectedPid?: number): ProcessIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = value as LooseRecord;
  if (typeof identity.pid !== "number"
    || !Number.isSafeInteger(identity.pid) || identity.pid <= 0
    || (expectedPid !== undefined && identity.pid !== expectedPid)
    || typeof identity.birthId !== "string" || !identity.birthId
    || identity.incarnation !== `${identity.pid}:${identity.birthId}`
    || typeof identity.capturedAt !== "string" || !identity.capturedAt
    || !Number.isFinite(Date.parse(identity.capturedAt))
    || new Date(Date.parse(identity.capturedAt)).toISOString() !== identity.capturedAt
    || identity.birthIdPrecision !== "exact"
    || (identity.processGroupId !== undefined
      && (typeof identity.processGroupId !== "number"
        || !Number.isSafeInteger(identity.processGroupId)
        || identity.processGroupId <= 0))) {
    return null;
  }
  const parsed: ProcessIdentity = {
    pid: identity.pid,
    birthId: identity.birthId,
    incarnation: identity.incarnation,
    capturedAt: identity.capturedAt,
  };
  parsed.birthIdPrecision = "exact";
  if (typeof identity.processGroupId === "number") parsed.processGroupId = identity.processGroupId;
  return parsed;
}

function processIdentityFromOwner(owner: LooseRecord | null) {
  const expectedPid = typeof owner?.pid === "number" ? owner.pid : undefined;
  return validProcessIdentity(owner?.processIdentity, expectedPid);
}

function processIdentityForPersistence(value: unknown, expectedPid: unknown): ProcessIdentity {
  const pid = typeof expectedPid === "number" && Number.isSafeInteger(expectedPid) && expectedPid > 0
    ? expectedPid
    : null;
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as LooseRecord
    : null;
  const identity = validProcessIdentity(candidate, pid ?? undefined);
  if (!identity || pid === null) {
    throw Object.assign(new Error("worker process identity is not an exact canonical identity"), {
      code: "HUB_WORKER_PROCESS_IDENTITY_INVALID",
    });
  }
  return identity;
}

function workerCleanupError(message: string, code = "HUB_WORKER_CLEANUP_UNVERIFIED", cause?: unknown) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code },
  );
}

function workerCleanupAuthorityError(
  message: string,
  registryPath: string,
  {
    cause,
    successorPreserved,
  }: { cause?: unknown; successorPreserved: boolean | null },
) {
  return Object.assign(
    workerCleanupError(message, "HUB_WORKER_CLEANUP_AUTHORITY_CONFLICT", cause),
    {
      committed: false,
      renameCommitted: false,
      committedPath: null,
      recoveryPaths: [registryPath],
      successorPreserved,
      quarantinePreserved: false,
    },
  );
}

async function readLocalWorkerJsonAuthority(
  filePath: string,
  label: string,
  invalidCode: string,
  maxBytes = LOCAL_WORKER_JSON_MAX_BYTES,
): Promise<{ record: LooseRecord; generation: WorkerPathGeneration } | null> {
  try {
    const before = await observeWorkerPathGeneration(filePath, "file");
    if (!before) return null;
    let raw: string;
    try {
      raw = await readBoundedRegularFileNoFollow(filePath, { maxBytes });
    } catch (error) {
      throw Object.assign(new Error(`${label} is not a safe bounded regular file: ${filePath}`, { cause: error }), {
        code: invalidCode,
      });
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw Object.assign(new Error(`${label} is not a JSON object: ${filePath}`), { code: invalidCode });
    }
    const after = await observeWorkerPathGeneration(filePath, "file");
    if (!after || !sameWorkerPathGeneration(before, after)) {
      throw Object.assign(new Error(`${label} generation changed during authority read: ${filePath}`), {
        code: invalidCode,
      });
    }
    return { record: parsed as LooseRecord, generation: after };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (errorCode(error) === invalidCode) throw error;
    if (error instanceof SyntaxError) {
      throw Object.assign(new SyntaxError(`${label} JSON is malformed: ${filePath}`, { cause: error }), {
        code: invalidCode,
      });
    }
    throw Object.assign(new Error(`${label} cannot be read safely: ${filePath}`, { cause: error }), {
      code: invalidCode,
    });
  }
}

async function readLocalWorkerJsonObject(
  filePath: string,
  label: string,
  invalidCode: string,
  maxBytes = LOCAL_WORKER_JSON_MAX_BYTES,
): Promise<LooseRecord | null> {
  return (await readLocalWorkerJsonAuthority(filePath, label, invalidCode, maxBytes))?.record ?? null;
}

function inboxReceipt(input: WorkerInboxReceipt): WorkerInboxReceipt {
  return deepFreezeReceipt({
    workerId: input.workerId,
    assignmentId: input.assignmentId,
    attempt: input.attempt,
    attemptToken: input.attemptToken,
    backend: input.backend,
    ref: input.ref,
    ...(input.path ? { path: input.path } : {}),
    previousRecord: receiptClone(input.previousRecord),
    committedRecord: receiptClone(input.committedRecord),
    writeFence: receiptClone(input.writeFence),
  });
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

  async _withLocalInboxLock<T>(workerId: string, assignmentId: string, callback: () => Promise<T>) {
    await assertHubWritable(this.hubRoot);
    const dir = path.join(this.inboxDir, workerId);
    await mkdir(dir, { recursive: true });
    const lockDir = path.join(dir, `${assignmentId}.lock`);
    const ownerFile = path.join(lockDir, "owner.json");
    const ownerToken = crypto.randomUUID();
    let acquired = false;
    const tryAcquire = async () => {
      let createdGeneration: WorkerPathGeneration | null = null;
      try {
        await mkdir(lockDir);
        createdGeneration = await observeWorkerPathGeneration(lockDir, "directory");
        if (!createdGeneration) {
          throw lockConflict(`worker inbox lock disappeared after creation: ${lockDir}`);
        }
        await syncWorkerDirectory(dir);
        await workerStoreTestHooks().afterLocalInboxLockMkdir?.({ lockDir, ownerToken });
        const processIdentity = this._captureCurrentProcessIdentity();
        await writeJsonDurableAtomic(ownerFile, {
          ownerToken,
          pid: process.pid,
          host: os.hostname(),
          processIdentity,
          acquiredAt: new Date().toISOString(),
        }, { syncParentDirectory: syncWorkerDirectory });
        await syncWorkerDirectory(dir);
        return true;
      } catch (ownerWriteError) {
        if (errorCode(ownerWriteError) === "EEXIST") {
          try {
            const candidate = await this._localInboxLockRecoveryCandidate(lockDir, ownerFile);
            if (candidate) await this._quarantineLocalInboxLock(lockDir, candidate);
          } catch (recoveryError) {
            if (!(recoveryError && typeof recoveryError === "object"
              && "retryable" in recoveryError && recoveryError.retryable === true)) {
              throw recoveryError;
            }
          }
          return false;
        }
        if (ownerWriteError && typeof ownerWriteError === "object"
          && "committed" in ownerWriteError && ownerWriteError.committed === true) {
          throw ownerWriteError;
        }
        let cleanupError: unknown = null;
        try {
          if (!createdGeneration) throw ownerWriteError;
          await this._quarantineLocalInboxLock(
            lockDir,
            {
              kind: "incomplete",
              ownerToken,
              owner: null,
              lockGeneration: createdGeneration,
            },
            { quarantineKind: "owner-write-failed" },
          );
        } catch (error) {
          cleanupError = error;
        }
        if (cleanupError) {
          throw new AggregateError(
            [ownerWriteError, cleanupError],
            `worker inbox lock owner write cleanup failed: ${workerId}/${assignmentId}`,
          );
        }
        throw ownerWriteError;
      }
    };
    for (let attempt = 0; attempt < LOCAL_INBOX_LOCK_RETRIES; attempt += 1) {
      acquired = await withDirectoryProcessFence(lockDir, tryAcquire, {
        waitMs: Math.max(LOCAL_INBOX_LOCK_RETRY_MS, LOCAL_INBOX_LOCK_RETRIES * LOCAL_INBOX_LOCK_RETRY_MS),
      });
      if (acquired) break;
      await new Promise((resolve) => setTimeout(resolve, LOCAL_INBOX_LOCK_RETRY_MS));
    }
    if (!acquired) throw new Error(`worker inbox lock busy: ${workerId}/${assignmentId}`);
    let result: T | undefined;
    let callbackError: unknown = null;
    try {
      result = await callback();
    } catch (error) {
      callbackError = error;
    }
    let releaseError: unknown = null;
    try {
      await withDirectoryProcessFence(
        lockDir,
        () => this._releaseLocalInboxLock(lockDir, ownerFile, ownerToken),
        { waitMs: Math.max(LOCAL_INBOX_LOCK_RETRY_MS, LOCAL_INBOX_LOCK_RETRIES * LOCAL_INBOX_LOCK_RETRY_MS) },
      );
    } catch (error) {
      releaseError = error;
    }
    if (callbackError && releaseError) {
      throw new AggregateError(
        [callbackError, releaseError],
        `worker inbox callback and lock release failed: ${workerId}/${assignmentId}`,
      );
    }
    if (callbackError) throw callbackError;
    if (releaseError) throw releaseError;
    return result as T;
  }

  async _readLocalInboxLockOwner(ownerFile: string) {
    try {
      const raw = await readBoundedRegularFileNoFollow(ownerFile, {
        maxBytes: LOCAL_INBOX_LOCK_OWNER_MAX_BYTES,
      });
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw lockConflict(`worker inbox lock owner is invalid: ${ownerFile}`);
      }
      const owner = parsed as LooseRecord;
      if (typeof owner.ownerToken !== "string" || !owner.ownerToken
        || typeof owner.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || typeof owner.host !== "string" || !owner.host
        || typeof owner.acquiredAt !== "string" || !owner.acquiredAt
        || !Number.isFinite(Date.parse(owner.acquiredAt))
        || new Date(Date.parse(owner.acquiredAt)).toISOString() !== owner.acquiredAt
        || (owner.releasedAt !== undefined
          && (typeof owner.releasedAt !== "string"
            || !Number.isFinite(Date.parse(owner.releasedAt))
            || new Date(Date.parse(owner.releasedAt)).toISOString() !== owner.releasedAt))) {
        throw lockConflict(`worker inbox lock owner is malformed: ${ownerFile}`);
      }
      const hasProcessIdentity = Object.prototype.hasOwnProperty.call(owner, "processIdentity");
      const identity = processIdentityFromOwner(owner);
      if (hasProcessIdentity) {
        if (!identity) {
          throw lockConflict(`worker inbox lock owner process identity is malformed: ${ownerFile}`);
        }
        owner.processIdentity = identity;
      } else {
        // Legacy records remain readable for diagnostics, but recovery treats
        // a missing exact identity as live and preserves the lock evidence.
        delete owner.processIdentity;
      }
      return owner;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      if (errorCode(error) === "HUB_WORKER_INBOX_LOCK_CONFLICT") throw error;
      throw lockConflict(`worker inbox lock owner cannot be read safely: ${ownerFile}`, error);
    }
  }

  _localInboxLockOwnerAlive(owner: LooseRecord | null) {
    if (!owner) return false;
    const pid = Number(owner.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    const host = typeof owner.host === "string" ? owner.host : "";
    if (host && host !== os.hostname()) return true;
    const identity = processIdentityFromOwner(owner);
    if (!identity) return true;
    try {
      return (workerStoreTestHooks().isLocalInboxProcessIdentityAlive || isProcessIdentityAlive)(identity);
    } catch (error) {
      throw lockConflict(`worker inbox lock owner identity probe failed for pid ${pid}`, error);
    }
  }

  _localInboxLockReleaseMarkerPath(lockDir: string, ownerToken: string) {
    const tokenHash = crypto.createHash("sha256").update(ownerToken).digest("hex");
    return path.join(lockDir, `.released-${tokenHash}`);
  }

  async _localInboxLockReleaseMarkerExists(lockDir: string, ownerToken: string) {
    const markerPath = this._localInboxLockReleaseMarkerPath(lockDir, ownerToken);
    try {
      const marker = await readLocalWorkerJsonObject(
        markerPath,
        "worker inbox release marker",
        "HUB_WORKER_INBOX_LOCK_CONFLICT",
        LOCAL_INBOX_LOCK_OWNER_MAX_BYTES,
      );
      if (!marker) return false;
      if ((marker as LooseRecord).ownerToken !== ownerToken) {
        throw lockConflict(`worker inbox release marker is invalid: ${markerPath}`);
      }
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async _localInboxLockRecoveryCandidate(lockDir: string, ownerFile: string): Promise<LocalInboxLockCandidate | null> {
    let generation: WorkerPathGeneration | null;
    try {
      generation = await observeWorkerPathGeneration(lockDir, "directory");
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "HUB_WORKER_PATH_GENERATION_CONFLICT") {
        throw retryableLockConflict(`worker inbox lock path changed during inspection: ${lockDir}`, error);
      }
      throw lockConflict(`worker inbox lock path cannot be inspected safely: ${lockDir}`, error);
    }
    if (!generation) return null;
    const owner = await this._readLocalInboxLockOwner(ownerFile);
    let afterOwner: WorkerPathGeneration | null;
    try {
      afterOwner = await observeWorkerPathGeneration(lockDir, "directory");
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "HUB_WORKER_PATH_GENERATION_CONFLICT") {
        throw retryableLockConflict(`worker inbox lock changed during owner read: ${lockDir}`, error);
      }
      throw lockConflict(`worker inbox lock changed during owner read: ${lockDir}`, error);
    }
    if (!afterOwner || !sameWorkerPathGeneration(generation, afterOwner)) {
      throw retryableLockConflict(`worker inbox lock generation changed during owner read: ${lockDir}`);
    }
    generation = afterOwner;
    const ownerToken = typeof owner?.ownerToken === "string" && owner.ownerToken ? owner.ownerToken : null;
    const processIdentity = processIdentityFromOwner(owner) ?? undefined;
    if (owner && !processIdentity) return null;
    if (ownerToken && (owner?.releasedAt || await this._localInboxLockReleaseMarkerExists(lockDir, ownerToken))) {
      return { kind: "released", ownerToken, owner, processIdentity, lockGeneration: generation };
    }
    if (Date.now() - generation.mtimeMs < LOCAL_INBOX_LOCK_TTL_MS) return null;
    if (this._localInboxLockOwnerAlive(owner)) return null;
    return ownerToken
      ? { kind: "stale", ownerToken, owner, processIdentity, lockGeneration: generation }
      : { kind: "incomplete", ownerToken: null, owner: null, lockGeneration: generation };
  }

  async _restoreQuarantinedInboxLock(quarantineDir: string, lockDir: string, conflict: Error) {
    const errors: unknown[] = [conflict];
    let successorPreserved: boolean | null = false;
    try {
      await lstat(lockDir);
      successorPreserved = true;
    } catch (restoreError) {
      if (errorCode(restoreError) !== "ENOENT") {
        successorPreserved = null;
        errors.push(restoreError);
      }
    }
    try {
      await syncWorkerDirectory(path.dirname(lockDir));
    } catch (syncError) {
      errors.push(syncError);
    }
    try {
      await syncWorkerDirectory(quarantineDir);
    } catch (syncError) {
      errors.push(syncError);
    }
    throw Object.assign(lockConflictAggregate(
      errors,
      successorPreserved
        ? `worker inbox lock successor preserved while quarantine remains: ${lockDir}`
        : `worker inbox lock quarantine preserved; canonical restore refused: ${lockDir}`,
      quarantineDir,
    ), {
      committed: true,
      renameCommitted: true,
      committedPath: quarantineDir,
      recoveryPaths: { quarantineDir, lockDir },
      lockDir,
      successorPreserved,
      quarantinePreserved: true,
    });
  }

  async _observeLocalInboxLock(lockDir: string) {
    let generation: WorkerPathGeneration | null;
    try {
      generation = await observeWorkerPathGeneration(lockDir, "directory");
    } catch (error) {
      return { state: "unavailable" as const, cause: error };
    }
    if (!generation) return { state: "missing" as const };
    let owner: LooseRecord | null;
    try {
      owner = await this._readLocalInboxLockOwner(path.join(lockDir, "owner.json"));
    } catch (error) {
      return { state: "unavailable" as const, generation, cause: error };
    }
    let afterOwner: WorkerPathGeneration | null;
    try {
      afterOwner = await observeWorkerPathGeneration(lockDir, "directory");
    } catch (error) {
      return { state: "unavailable" as const, generation, owner, cause: error };
    }
    if (!afterOwner || !sameWorkerPathGeneration(generation, afterOwner)) {
      return { state: "mismatch" as const, generation: afterOwner, owner };
    }
    return { state: "observed" as const, generation: afterOwner, owner };
  }

  _localInboxLockCandidateMatches(
    candidate: LocalInboxLockCandidate,
    observation: Awaited<ReturnType<WorkerStore["_observeLocalInboxLock"]>>,
    moved: boolean,
  ) {
    if (observation.state !== "observed") return false;
    const generationMatches = moved
      ? sameMovedWorkerPathGeneration(candidate.lockGeneration, observation.generation)
      : sameWorkerPathGeneration(candidate.lockGeneration, observation.generation);
    if (!generationMatches || !receiptDeepEqual(candidate.owner, observation.owner)) return false;
    if (!candidate.processIdentity) return true;
    return sameProcessIdentity(candidate.processIdentity, processIdentityFromOwner(observation.owner));
  }

  async _quarantineLocalInboxLock(
    lockDir: string,
    candidate: LocalInboxLockCandidate,
    options: { quarantineKind?: string } = {},
  ) {
    const beforeQuarantineHook = workerStoreTestHooks().beforeLocalInboxLockQuarantineRename;
    await beforeQuarantineHook?.({
      lockDir,
      ownerToken: candidate.ownerToken,
      kind: options.quarantineKind || candidate.kind,
    });
    const quarantineDir = `${lockDir}.${options.quarantineKind || candidate.kind}-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`;
    const beforeRename = await this._observeLocalInboxLock(lockDir);
    if (beforeRename.state === "missing") return false;
    if (!this._localInboxLockCandidateMatches(candidate, beforeRename, false)) {
      const observationCause = "cause" in beforeRename ? beforeRename.cause : undefined;
      throw Object.assign(
        lockConflict(`worker inbox lock successor preserved before quarantine: ${lockDir}`, observationCause),
        {
          committed: false,
          renameCommitted: false,
          committedPath: null,
          recoveryPaths: { lockDir },
          lockDir,
          successorPreserved: true,
          quarantinePreserved: false,
          retryable: !beforeQuarantineHook,
        },
      );
    }
    try {
      await rename(lockDir, quarantineDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    try {
      await syncWorkerDirectory(path.dirname(lockDir));
    } catch (error) {
      const canonicalState = await canonicalWorkerPathState(lockDir);
      throw Object.assign(
        lockConflict(`worker inbox lock quarantine rename committed with ambiguous durability: ${lockDir}`, error),
        {
          committed: true,
          renameCommitted: true,
          committedPath: quarantineDir,
          recoveryPaths: { quarantineDir, lockDir },
          lockDir,
          successorPreserved: canonicalState === "present"
            ? true
            : canonicalState === "missing" ? false : null,
          quarantinePreserved: true,
        },
      );
    }
    let hookError: unknown;
    let hookFailed = false;
    try {
      await workerStoreTestHooks().afterLocalInboxLockQuarantineRename?.({
        lockDir,
        quarantineDir,
        ownerToken: candidate.ownerToken,
        kind: options.quarantineKind || candidate.kind,
      });
    } catch (error) {
      hookError = error;
      hookFailed = true;
    }
    const quarantined = await this._observeLocalInboxLock(quarantineDir);
    if (!this._localInboxLockCandidateMatches(candidate, quarantined, true)) {
      const observationCause = "cause" in quarantined ? quarantined.cause : undefined;
      await this._restoreQuarantinedInboxLock(
        quarantineDir,
        lockDir,
        lockConflict(`worker inbox lock generation or owner changed after quarantine: ${lockDir}`, observationCause),
      );
    }
    if (hookFailed) {
      await this._restoreQuarantinedInboxLock(
        quarantineDir,
        lockDir,
        lockConflict(`worker inbox lock quarantine hook failed: ${lockDir}`, hookError),
      );
    }
    const canonicalState = await canonicalWorkerPathState(lockDir);
    if (canonicalState !== "missing") {
      await this._restoreQuarantinedInboxLock(
        quarantineDir,
        lockDir,
        lockConflict(canonicalState === "present"
          ? `worker inbox lock successor appeared during quarantine: ${lockDir}`
          : `worker inbox lock canonical state is unavailable after quarantine: ${lockDir}`),
      );
    }
    return true;
  }

  async _releaseLocalInboxLock(lockDir: string, ownerFile: string, ownerToken: string) {
    const generationBefore = await observeWorkerPathGeneration(lockDir, "directory");
    if (!generationBefore) {
      throw lockConflict(`worker inbox lock disappeared before release: ${lockDir}`);
    }
    const ownerBefore = await this._readLocalInboxLockOwner(ownerFile);
    const generationAfterOwner = await observeWorkerPathGeneration(lockDir, "directory");
    const currentIdentity = this._captureCurrentProcessIdentity();
    if (!generationAfterOwner || !sameWorkerPathGeneration(generationBefore, generationAfterOwner)
      || ownerBefore?.ownerToken !== ownerToken
      || !sameProcessIdentity(processIdentityFromOwner(ownerBefore), currentIdentity)) {
      throw lockConflict(`worker inbox lock owner changed before release: ${lockDir}`);
    }
    await workerStoreTestHooks().beforeLocalInboxLockReleaseMarker?.({ lockDir, ownerToken });
    const generationBeforeMarker = await observeWorkerPathGeneration(lockDir, "directory");
    const ownerBeforeMarker = await this._readLocalInboxLockOwner(ownerFile);
    const generationAfterMarkerAuthority = await observeWorkerPathGeneration(lockDir, "directory");
    if (!generationBeforeMarker || !generationAfterMarkerAuthority
      || !sameWorkerPathGeneration(generationAfterOwner, generationBeforeMarker)
      || !sameWorkerPathGeneration(generationBeforeMarker, generationAfterMarkerAuthority)
      || !receiptDeepEqual(ownerBefore, ownerBeforeMarker)
      || !sameProcessIdentity(processIdentityFromOwner(ownerBeforeMarker), currentIdentity)) {
      throw lockConflict(`worker inbox lock authority changed before release marker: ${lockDir}`);
    }
    const markerPath = this._localInboxLockReleaseMarkerPath(lockDir, ownerToken);
    const marker = {
      ownerToken,
      releasedAt: new Date().toISOString(),
    };
    if (!await writeJsonOnce(markerPath, marker)) {
      const existingMarker = await readLocalWorkerJsonObject(
        markerPath,
        "worker inbox release marker",
        "HUB_WORKER_INBOX_LOCK_CONFLICT",
        LOCAL_INBOX_LOCK_OWNER_MAX_BYTES,
      );
      if (existingMarker?.ownerToken !== ownerToken) {
        throw lockConflict(`worker inbox release marker successor preserved: ${markerPath}`);
      }
    }
    const releaseCommittedConflict = (
      message: string,
      cause?: unknown,
      successorPreserved: boolean | null = true,
    ) => Object.assign(lockConflict(message, cause), {
      committed: true,
      renameCommitted: false,
      committedPath: markerPath,
      recoveryPaths: [lockDir, markerPath, path.dirname(lockDir)],
      successorPreserved,
      quarantinePreserved: null,
    });
    const generationAfterMarker = await observeWorkerPathGeneration(lockDir, "directory");
    if (!generationAfterMarker) return true;
    if (!sameWorkerPathIdentity(generationAfterMarkerAuthority, generationAfterMarker)) {
      throw releaseCommittedConflict(`worker inbox lock path changed during release marker publication: ${lockDir}`);
    }
    let ownerAfter: LooseRecord | null;
    try {
      ownerAfter = await this._readLocalInboxLockOwner(ownerFile);
    } catch (error) {
      if (await canonicalWorkerPathState(lockDir) === "missing") return true;
      throw releaseCommittedConflict(`worker inbox lock owner became unavailable after release: ${lockDir}`, error, null);
    }
    const generationFinal = await observeWorkerPathGeneration(lockDir, "directory");
    if (!generationFinal) return true;
    if (!sameWorkerPathGeneration(generationAfterMarker, generationFinal)
      || !receiptDeepEqual(ownerBefore, ownerAfter)
      || ownerAfter?.ownerToken !== ownerToken
      || !sameProcessIdentity(processIdentityFromOwner(ownerAfter), currentIdentity)) {
      throw releaseCommittedConflict(`worker inbox lock owner changed during release: ${lockDir}`);
    }
    return true;
  }

  _captureCurrentProcessIdentity() {
    let captured: ProcessIdentity | null;
    try {
      captured = captureProcessIdentity(process.pid, { strict: true });
    } catch (error) {
      throw lockConflict("worker inbox lock requires an exact current process identity", error);
    }
    const identity = validProcessIdentity(captured, process.pid);
    if (!identity) {
      throw lockConflict("worker inbox lock requires an exact current process identity");
    }
    return identity;
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

  async _mutateRedisRecordWithRevision<T>(
    backend: HubRedisStateBackend,
    field: string,
    callback: (current: LooseRecord | null) => {
      data: LooseRecord | null;
      result: (revision: number) => T;
    },
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
      if (committed.committed) return mutation.result(committed.revision);
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
    const registryFiles = await readWorkerDirectoryNamesPinned(this.registryDir) ?? [];
    if (registryFiles.some((file) => file.endsWith(".json"))) return true;
    const workerDirs = await readWorkerDirectoryNamesPinned(this.inboxDir) ?? [];
    for (const workerDir of workerDirs) {
      const root = path.join(this.inboxDir, workerDir);
      const pending = await readWorkerDirectoryNamesPinned(root) ?? [];
      if (pending.some((file) => file.endsWith(".json"))) return true;
      const processing = await readWorkerDirectoryNamesPinned(path.join(root, "processing")) ?? [];
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
    const worker: LooseRecord = {
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
    if (Object.prototype.hasOwnProperty.call(meta, "processIdentity") && worker.processIdentity != null) {
      worker.processIdentity = processIdentityForPersistence(worker.processIdentity, worker.pid);
    }
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
        const updated: LooseRecord = { ...worker, ...updates, lastHeartbeatAt: authorityNow };
        if (Object.prototype.hasOwnProperty.call(updates, "processIdentity") && updated.processIdentity != null) {
          updated.processIdentity = processIdentityForPersistence(updated.processIdentity, updated.pid);
        }
        return { data: updated, result: updated };
      });
    }
    const worker = await this.getWorker(workerId);
    if (!worker) return null;
    if (!workerMatchesExpectation(worker, expected)) return null;
    const updated: LooseRecord = { ...worker, ...updates, lastHeartbeatAt: new Date().toISOString() };
    if (Object.prototype.hasOwnProperty.call(updates, "processIdentity") && updated.processIdentity != null) {
      updated.processIdentity = processIdentityForPersistence(updated.processIdentity, updated.pid);
    }
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

  async getWorker(workerId: string): Promise<LocalWorkerRecord | null> {
    const backend = await this._backend();
    if (backend) {
      const record = await backend.readStateRecord(this._workerField(workerId));
      return record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? record.data as LocalWorkerRecord
        : null;
    }
    return await readLocalWorkerJsonObject(
      path.join(this.registryDir, `worker-${workerId}.json`),
      "worker registry record",
      "HUB_WORKER_REGISTRY_INVALID",
    ) as LocalWorkerRecord | null;
  }

  async listWorkers(filter: LooseRecord = {}): Promise<LocalWorkerRecord[]> {
    const backend = await this._backend();
    if (backend) {
      const records = await backend.scanStateRecords("worker:");
      return records.flatMap(({ record }) => {
        const worker = record.data && typeof record.data === "object" && !Array.isArray(record.data)
          ? record.data as LocalWorkerRecord
          : null;
        if (!worker || (filter.status && worker.status !== filter.status)) return [];
        return [worker];
      });
    }
    const workers: LocalWorkerRecord[] = [];
    const files = await readWorkerDirectoryNamesPinned(this.registryDir) ?? [];
    for (const file of files) {
      if (!file.startsWith("worker-") || !file.endsWith(".json")) continue;
      const worker = await readLocalWorkerJsonObject(
        path.join(this.registryDir, file),
        "worker registry record",
        "HUB_WORKER_REGISTRY_INVALID",
      ) as LocalWorkerRecord | null;
      if (!worker) continue;
      if (filter.status && worker.status !== filter.status) continue;
      workers.push(worker);
    }
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
      return (await readWorkerDirectoryNamesPinned(dir) ?? [])
        .some((file) => file.endsWith(".json"));
    };
    return await hasJsonFile(inboxDir) || await hasJsonFile(path.join(inboxDir, "processing"));
  }

  async _readLocalInboxJson(filePath: string, label: string): Promise<LooseRecord | null> {
    return readLocalWorkerJsonObject(filePath, label, "HUB_WORKER_INBOX_PAYLOAD_INVALID");
  }

  _localInboxWriteOwnerPath(filePath: string) {
    return `${filePath}${LOCAL_INBOX_WRITE_OWNER_SUFFIX}`;
  }

  async _unlinkLocalInboxPath(filePath: string, expectedGeneration?: WorkerPathGeneration) {
    return isolateWorkerPathDurable(filePath, {
      kind: "file",
      reason: "local-inbox-entry-cleanup",
      expectedGeneration,
    });
  }

  async _localInboxCleanupAuthority(filePath: string) {
    const ownerPath = this._localInboxWriteOwnerPath(filePath);
    const payloadBefore = await observeWorkerPathGeneration(filePath, "file");
    const owner = await readLocalWorkerJsonAuthority(
      ownerPath,
      "worker inbox cleanup owner",
      "HUB_WORKER_INBOX_PAYLOAD_INVALID",
    );
    const payloadAfter = await observeWorkerPathGeneration(filePath, "file");
    const ownerAfter = await observeWorkerPathGeneration(ownerPath, "file");
    const payloadStable = payloadBefore === null
      ? payloadAfter === null
      : payloadAfter !== null && sameWorkerPathGeneration(payloadBefore, payloadAfter);
    const ownerStable = owner === null
      ? ownerAfter === null
      : ownerAfter !== null && sameWorkerPathGeneration(owner.generation, ownerAfter);
    if (!payloadStable || !ownerStable) {
      throw Object.assign(
        new Error(`worker inbox cleanup authority changed: ${filePath}`),
        {
          code: "HUB_WORKER_INBOX_COMPENSATION_CONFLICT",
          committed: false,
          renameCommitted: false,
          committedPath: null,
          recoveryPaths: [filePath, ownerPath],
          successorPreserved: true,
          quarantinePreserved: false,
        },
      );
    }
    return {
      ownerPath,
      owner: owner?.record ?? null,
      payloadGeneration: payloadAfter,
      ownerGeneration: ownerAfter,
    };
  }

  async _removeLocalInboxPair(filePath: string) {
    const authority = await this._localInboxCleanupAuthority(filePath);
    let payloadIsolation: Awaited<ReturnType<WorkerStore["_unlinkLocalInboxPath"]>> = false;
    if (authority.payloadGeneration) {
      payloadIsolation = await this._unlinkLocalInboxPath(filePath, authority.payloadGeneration);
    }
    try {
      if (await observeWorkerPathGeneration(filePath, "file")) {
        throw Object.assign(
          new Error(`worker inbox payload successor appeared during cleanup: ${filePath}`),
          { code: "HUB_WORKER_PATH_SUCCESSOR_PRESERVED", successorPreserved: true },
        );
      }
      if (authority.ownerGeneration) {
        const currentOwner = await readLocalWorkerJsonAuthority(
          authority.ownerPath,
          "worker inbox cleanup owner",
          "HUB_WORKER_INBOX_PAYLOAD_INVALID",
        );
        if (!currentOwner
          || !sameWorkerPathGeneration(authority.ownerGeneration, currentOwner.generation)
          || !receiptDeepEqual(authority.owner, currentOwner.record)) {
          throw Object.assign(
            new Error(`worker inbox owner successor preserved: ${authority.ownerPath}`),
            { code: "HUB_WORKER_PATH_GENERATION_CONFLICT", successorPreserved: currentOwner !== null },
          );
        }
        await this._unlinkLocalInboxPath(authority.ownerPath, authority.ownerGeneration);
      } else if (await observeWorkerPathGeneration(authority.ownerPath, "file")) {
        throw Object.assign(
          new Error(`worker inbox owner appeared during cleanup and was preserved: ${authority.ownerPath}`),
          { code: "HUB_WORKER_PATH_SUCCESSOR_PRESERVED", successorPreserved: true },
        );
      }
    } catch (error) {
      if (!payloadIsolation) throw error;
      throw Object.assign(
        new AggregateError(
          [error],
          `worker inbox payload isolated but owner cleanup was preserved: ${filePath}`,
          { cause: error },
        ),
        {
          code: "HUB_WORKER_INBOX_CLEANUP_PARTIAL",
          committed: true,
          renameCommitted: true,
          committedPath: payloadIsolation.quarantinePath,
          recoveryPaths: [
            filePath,
            authority.ownerPath,
            payloadIsolation.quarantinePath,
            path.dirname(filePath),
          ],
          successorPreserved: error && typeof error === "object" && "successorPreserved" in error
            ? Boolean(error.successorPreserved)
            : null,
          quarantinePreserved: true,
        },
      );
    }
    return Boolean(payloadIsolation);
  }

  async _restoreLocalInboxWrite(
    filePath: string,
    ownerPath: string,
    previousRecord: LooseRecord | null,
    previousOwner: LooseRecord | null,
    committedRecord: LooseRecord,
    committedOwner: LooseRecord,
    generations: {
      payload: WorkerPathGeneration | null;
      owner: WorkerPathGeneration | null;
      staging: WorkerPathGeneration | null;
    },
    stagingPath?: string,
  ) {
    const restorations = [
      () => this._restoreOwnedLocalInboxPath(
        filePath,
        previousRecord,
        committedRecord,
        generations.payload,
        "worker inbox payload",
      ),
      () => this._restoreOwnedLocalInboxPath(
        ownerPath,
        previousOwner,
        committedOwner,
        generations.owner,
        "worker inbox write owner",
      ),
      ...(stagingPath ? [() => this._restoreOwnedLocalInboxPath(
        stagingPath,
        null,
        committedRecord,
        generations.staging,
        "worker inbox staging payload",
      )] : []),
    ];
    const errors: unknown[] = [];
    for (const restore of restorations) {
      try {
        await restore();
      } catch (error) {
        errors.push(error);
        if (error && typeof error === "object" && "committed" in error && error.committed === true) break;
      }
    }
    if (errors.length > 0) {
      const committedErrors = errors.filter((error) => error && typeof error === "object"
        && "committed" in error && error.committed === true);
      const recoveryPaths = [...new Set(errors.flatMap((error) => (
        error && typeof error === "object" && "recoveryPaths" in error && Array.isArray(error.recoveryPaths)
          ? error.recoveryPaths.map(String)
          : []
      )))];
      const successorStates = errors.flatMap((error) => (
        error && typeof error === "object" && "successorPreserved" in error
          ? [error.successorPreserved]
          : []
      ));
      const committedPaths = committedErrors.flatMap((error) => (
        error && typeof error === "object" && "committedPath" in error
          ? [error.committedPath]
          : []
      ));
      throw Object.assign(
        new AggregateError(errors, `worker inbox write restore failed: ${filePath}`),
        {
          code: "HUB_WORKER_INBOX_COMPENSATION_CONFLICT",
          committed: committedErrors.length > 0,
          committedPath: committedPaths[0] ?? null,
          recoveryPaths: recoveryPaths.length > 0 ? recoveryPaths : [filePath, ownerPath],
          successorPreserved: successorStates.includes(true)
            ? true
            : successorStates.includes(null) ? null : false,
        },
      );
    }
  }

  async _restoreOwnedLocalInboxPath(
    filePath: string,
    previousRecord: LooseRecord | null,
    committedRecord: LooseRecord,
    expectedCommittedGeneration: WorkerPathGeneration | null,
    label: string,
  ) {
    const conflict = (
      message: string,
      {
        committed = false,
        committedPath = null,
        recoveryPaths = [filePath],
        successorPreserved = true,
        cause,
      }: {
        committed?: boolean;
        committedPath?: string | null;
        recoveryPaths?: string[];
        successorPreserved?: boolean | null;
        cause?: unknown;
      } = {},
    ) => Object.assign(
      new Error(message, cause === undefined ? undefined : { cause }),
      {
        code: "HUB_WORKER_INBOX_COMPENSATION_CONFLICT",
        committed,
        committedPath,
        recoveryPaths,
        successorPreserved,
      },
    );

    const current = await readLocalWorkerJsonAuthority(
      filePath,
      label,
      "HUB_WORKER_INBOX_PAYLOAD_INVALID",
    );
    if (current && receiptDeepEqual(current.record, previousRecord)) return false;
    if (!current && !previousRecord) return false;
    if (!expectedCommittedGeneration) {
      throw conflict(`${label} was not published by this write; changed path preserved: ${filePath}`, {
        successorPreserved: current !== null,
      });
    }
    if (!current) {
      throw conflict(`${label} disappeared before exact-generation restore: ${filePath}`, {
        successorPreserved: false,
      });
    }
    if (!sameWorkerPathGeneration(expectedCommittedGeneration, current.generation)
      || !receiptDeepEqual(current.record, committedRecord)) {
      throw conflict(`${label} changed before restore; successor preserved: ${filePath}`);
    }

    const isolated = await isolateWorkerPathDurable(filePath, {
      kind: "file",
      reason: "local-inbox-rollback",
      expectedGeneration: expectedCommittedGeneration,
    });
    if (!isolated) {
      if (!previousRecord) return true;
      throw conflict(`${label} disappeared during exact-generation restore: ${filePath}`, {
        successorPreserved: false,
      });
    }
    if (!previousRecord) return true;

    try {
      const created = await writeJsonOnce(filePath, previousRecord);
      if (!created) {
        throw conflict(`${label} successor preserved after committed isolation: ${filePath}`, {
          committed: true,
          committedPath: isolated.quarantinePath,
          recoveryPaths: [filePath, isolated.quarantinePath, path.dirname(filePath)],
        });
      }
    } catch (error) {
      if (errorCode(error) === "HUB_WORKER_INBOX_COMPENSATION_CONFLICT") throw error;
      throw conflict(`${label} restore failed after committed isolation: ${filePath}`, {
        committed: true,
        committedPath: isolated.quarantinePath,
        recoveryPaths: [filePath, isolated.quarantinePath, path.dirname(filePath)],
        successorPreserved: error && typeof error === "object" && "successorPreserved" in error
          ? Boolean(error.successorPreserved)
          : null,
        cause: error,
      });
    }
    return true;
  }

  async writeInboxWithReceipt(workerId: string, assignment: LooseRecord): Promise<WorkerInboxReceipt> {
    const committedPayload = normalizeJsonRecord(assignment, "worker inbox payload");
    await assertHubWritable(this.hubRoot);
    const assignmentId = String(committedPayload.assignmentId || "");
    if (!assignmentId) throw new Error("assignmentId is required for worker inbox");
    const backend = await this._backend();
    if (backend) {
      const attempt = Number(committedPayload.attempt);
      const attemptToken = String(committedPayload.attemptToken || "");
      if (!Number.isInteger(attempt) || attempt < 1 || !attemptToken) {
        throw new Error("attempt and attemptToken are required for Redis worker inbox");
      }
      const field = this._inboxField(workerId, assignmentId, attempt, attemptToken);
      return this._mutateRedisRecordWithRevision(backend, field, (current) => {
        const previousRecord = current ? receiptClone(current) : null;
        if (current) {
          const existingPayload = current.payload as LooseRecord | undefined;
          if (existingPayload?.attempt !== attempt || existingPayload?.attemptToken !== attemptToken) {
            throw Object.assign(new Error("worker inbox idempotency conflict"), { code: "HUB_STATE_RECORD_CONFLICT" });
          }
          return {
            data: current,
            result: (revision: number) => inboxReceipt({
              workerId,
              assignmentId,
              attempt,
              attemptToken,
              backend: "redis",
              ref: field,
              previousRecord,
              committedRecord: current,
              writeFence: { backend: "redis", revision },
            }),
          };
        }
        const record = normalizeJsonRecord({
          workerId,
          assignmentId,
          status: "pending",
          payload: committedPayload,
          writtenAt: new Date().toISOString(),
        }, "Redis worker inbox record");
        return {
          data: record,
          result: (revision: number) => inboxReceipt({
            workerId,
            assignmentId,
            attempt,
            attemptToken,
            backend: "redis",
            ref: field,
            previousRecord,
            committedRecord: record,
            writeFence: { backend: "redis", revision },
          }),
        };
      });
    }
    return this._withLocalInboxLock(workerId, assignmentId, async () => {
      const filePath = path.join(this.inboxDir, workerId, `${assignmentId}.json`);
      const ownerPath = this._localInboxWriteOwnerPath(filePath);
      const previousRecord = await this._readLocalInboxJson(filePath, "worker inbox payload");
      const previousOwner = await this._readLocalInboxJson(ownerPath, "worker inbox write owner");
      const attempt = Number(committedPayload.attempt);
      const attemptToken = String(committedPayload.attemptToken || "");
      if (!Number.isInteger(attempt) || attempt < 1 || !attemptToken) {
        throw new Error("attempt and attemptToken are required for worker inbox");
      }
      if (previousRecord) {
        if (previousRecord.attempt !== attempt || previousRecord.attemptToken !== attemptToken) {
          throw Object.assign(new Error("worker inbox idempotency conflict"), { code: "HUB_STATE_RECORD_CONFLICT" });
        }
      }
      const committedOwner = normalizeJsonRecord({
        workerId,
        assignmentId,
        attempt,
        attemptToken,
        ownerToken: crypto.randomUUID(),
        writtenAt: new Date().toISOString(),
      }, "worker inbox write owner");
      const stagingPath = `${filePath}.pending-${String(committedOwner.ownerToken)}`;
      let payloadRenamed = false;
      let stagingGeneration: WorkerPathGeneration | null = null;
      let committedOwnerGeneration: WorkerPathGeneration | null = null;
      let committedPayloadGeneration: WorkerPathGeneration | null = null;
      try {
        await writeJsonAtomic(stagingPath, committedPayload);
        stagingGeneration = await observeWorkerPathGeneration(stagingPath, "file");
        if (!stagingGeneration) {
          throw Object.assign(new Error(`worker inbox staging payload disappeared: ${stagingPath}`), {
            code: "HUB_WORKER_INBOX_COMMIT_INVALID",
          });
        }
        await workerStoreTestHooks().beforeLocalInboxWriteOwner?.({
          ownerPath,
          ownerToken: String(committedOwner.ownerToken),
        });
        await writeJsonAtomic(ownerPath, committedOwner);
        committedOwnerGeneration = await observeWorkerPathGeneration(ownerPath, "file");
        if (!committedOwnerGeneration) {
          throw Object.assign(new Error(`worker inbox write owner disappeared: ${ownerPath}`), {
            code: "HUB_WORKER_INBOX_COMMIT_INVALID",
          });
        }
        await workerStoreTestHooks().afterLocalInboxWriteOwner?.({
          filePath,
          ownerPath,
          stagingPath,
          ownerToken: String(committedOwner.ownerToken),
        });
        await rename(stagingPath, filePath);
        payloadRenamed = true;
        committedPayloadGeneration = await observeWorkerPathGeneration(filePath, "file");
        if (!committedPayloadGeneration
          || !sameMovedWorkerPathGeneration(stagingGeneration, committedPayloadGeneration)) {
          throw Object.assign(new Error("worker inbox payload generation changed during publication"), {
            code: "HUB_WORKER_INBOX_COMMIT_INVALID",
          });
        }
        try {
          await syncWorkerDirectory(path.dirname(filePath));
        } catch (error) {
          throw Object.assign(
            new AggregateError(
              [error],
              `worker inbox payload committed but directory durability is ambiguous: ${assignmentId}`,
              { cause: error },
            ),
            {
              code: "HUB_WORKER_INBOX_COMMITTED_DURABILITY_AMBIGUOUS",
              committed: true,
              filePath,
              committedPath: filePath,
              recoveryPaths: [filePath, ownerPath, path.dirname(filePath)],
            },
          );
        }
        const persistedPayload = await readLocalWorkerJsonAuthority(
          filePath,
          "committed worker inbox payload",
          "HUB_WORKER_INBOX_PAYLOAD_INVALID",
        );
        const persistedOwner = await readLocalWorkerJsonAuthority(
          ownerPath,
          "committed worker inbox write owner",
          "HUB_WORKER_INBOX_PAYLOAD_INVALID",
        );
        if (!persistedPayload || !persistedOwner
          || !sameWorkerPathGeneration(committedPayloadGeneration, persistedPayload.generation)
          || !sameWorkerPathGeneration(committedOwnerGeneration, persistedOwner.generation)
          || !receiptDeepEqual(persistedPayload.record, committedPayload)
          || !receiptDeepEqual(persistedOwner.record, committedOwner)) {
          throw Object.assign(new Error("worker inbox commit verification failed"), { code: "HUB_WORKER_INBOX_COMMIT_INVALID" });
        }
      } catch (originalError) {
        const reportsCommitted = Boolean(originalError && typeof originalError === "object"
          && "committed" in originalError && originalError.committed === true);
        if (reportsCommitted) {
          throw originalError;
        }
        if (payloadRenamed) {
          const canonicalState = await canonicalWorkerPathState(filePath);
          throw Object.assign(
            new Error(`worker inbox payload rename committed; automatic rollback refused: ${assignmentId}`, {
              cause: originalError,
            }),
            {
              code: "HUB_WORKER_INBOX_COMMIT_INVALID",
              committed: true,
              renameCommitted: true,
              committedPath: filePath,
              recoveryPaths: [filePath, ownerPath, path.dirname(filePath)],
              successorPreserved: canonicalState === "present"
                ? true
                : canonicalState === "missing" ? false : null,
            },
          );
        }
        try {
          await this._restoreLocalInboxWrite(
            filePath,
            ownerPath,
            previousRecord,
            previousOwner,
            committedPayload,
            committedOwner,
            {
              payload: null,
              owner: committedOwnerGeneration,
              staging: stagingGeneration,
            },
            stagingPath,
          );
        } catch (cleanupError) {
          const cleanupErrors = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
          throw new AggregateError(
            [originalError, ...cleanupErrors],
            `worker inbox write rollback failed: ${assignmentId}`,
          );
        }
        throw originalError;
      }
      if (!committedPayloadGeneration || !committedOwnerGeneration) {
        throw Object.assign(new Error("worker inbox commit generations are unavailable"), {
          code: "HUB_WORKER_INBOX_COMMIT_INVALID",
          committed: true,
          committedPath: filePath,
          recoveryPaths: [filePath, ownerPath, path.dirname(filePath)],
        });
      }
      return inboxReceipt({
        workerId,
        assignmentId,
        attempt,
        attemptToken,
        backend: "local",
        ref: filePath,
        path: filePath,
        previousRecord,
        committedRecord: committedPayload,
        writeFence: {
          backend: "local",
          ownerToken: String(committedOwner.ownerToken),
          previousOwner,
          committedOwner,
          payloadGeneration: committedPayloadGeneration,
          ownerGeneration: committedOwnerGeneration,
        },
      });
    });
  }

  async compensateInboxReceipt(receipt: WorkerInboxReceipt) {
    await assertHubWritable(this.hubRoot);
    const backend = await this._backend();
    if (backend) {
      if (receipt.writeFence.backend !== "redis") {
        throw Object.assign(new Error("worker inbox compensation backend mismatch"), { code: "HUB_WORKER_INBOX_COMPENSATION_CONFLICT" });
      }
      const field = this._inboxField(receipt.workerId, receipt.assignmentId, receipt.attempt, receipt.attemptToken);
      const snapshot = await backend.readStateRecord(field);
      const current = snapshot.data && typeof snapshot.data === "object" && !Array.isArray(snapshot.data)
        ? snapshot.data as LooseRecord
        : null;
      if (snapshot.revision !== receipt.writeFence.revision || !receiptDeepEqual(current, receipt.committedRecord)) {
        throw Object.assign(new Error("worker inbox compensation conflict"), { code: "HUB_WORKER_INBOX_COMPENSATION_CONFLICT" });
      }
      const committed = await backend.compareAndSwapStateRecord(
        field,
        snapshot.revision,
        receipt.previousRecord,
        processLeaderFence(backend.identityFingerprint),
      );
      if (committed.fenced) {
        throw Object.assign(new Error("leader lease no longer authorizes worker inbox compensation"), { code: "HUB_LEADER_FENCED" });
      }
      if (!committed.committed) {
        throw Object.assign(new Error("worker inbox changed during compensation"), { code: "HUB_WORKER_INBOX_COMPENSATION_CONFLICT" });
      }
      return true;
    }
    return this._withLocalInboxLock(receipt.workerId, receipt.assignmentId, async () => {
      if (receipt.writeFence.backend !== "local") {
        throw Object.assign(new Error("worker inbox compensation backend mismatch"), { code: "HUB_WORKER_INBOX_COMPENSATION_CONFLICT" });
      }
      const filePath = path.join(this.inboxDir, receipt.workerId, `${receipt.assignmentId}.json`);
      const ownerPath = this._localInboxWriteOwnerPath(filePath);
      const expectedPayloadGeneration = validWorkerPathGeneration(receipt.writeFence.payloadGeneration);
      const expectedOwnerGeneration = validWorkerPathGeneration(receipt.writeFence.ownerGeneration);
      if (!expectedPayloadGeneration || !expectedOwnerGeneration) {
        throw Object.assign(new Error("worker inbox compensation conflict"), { code: "HUB_WORKER_INBOX_COMPENSATION_CONFLICT" });
      }
      const current = await readLocalWorkerJsonAuthority(
        filePath,
        "worker inbox payload",
        "HUB_WORKER_INBOX_PAYLOAD_INVALID",
      );
      const currentOwner = await readLocalWorkerJsonAuthority(
        ownerPath,
        "worker inbox write owner",
        "HUB_WORKER_INBOX_PAYLOAD_INVALID",
      );
      if (!current || !currentOwner
        || !sameWorkerPathGeneration(expectedPayloadGeneration, current.generation)
        || !sameWorkerPathGeneration(expectedOwnerGeneration, currentOwner.generation)
        || !receiptDeepEqual(current.record, receipt.committedRecord)
        || !receiptDeepEqual(currentOwner.record, receipt.writeFence.committedOwner)
        || currentOwner.record.ownerToken !== receipt.writeFence.ownerToken) {
        throw Object.assign(new Error("worker inbox compensation conflict"), {
          code: "HUB_WORKER_INBOX_COMPENSATION_CONFLICT",
          committed: false,
          committedPath: null,
          recoveryPaths: [filePath, ownerPath],
          successorPreserved: Boolean(current || currentOwner),
        });
      }
      await this._restoreLocalInboxWrite(
        filePath,
        ownerPath,
        receipt.previousRecord,
        receipt.writeFence.previousOwner,
        receipt.committedRecord,
        receipt.writeFence.committedOwner,
        {
          payload: expectedPayloadGeneration,
          owner: expectedOwnerGeneration,
          staging: null,
        },
      );
      return true;
    });
  }

  async writeInbox(workerId: string, assignment: LooseRecord) {
    return (await this.writeInboxWithReceipt(workerId, assignment)).committedRecord;
  }

  async readInbox(workerId: string): Promise<LooseRecord[]> {
    const backend = await this._backend();
    if (backend) {
      return (await backend.scanStateRecords(this._inboxPrefix(workerId))).flatMap(({ record }) => {
        const inbox = record.data && typeof record.data === "object" && !Array.isArray(record.data)
          ? record.data as LooseRecord
          : null;
        const payload = inbox?.payload;
        return payload && typeof payload === "object" && !Array.isArray(payload)
          ? [payload as LooseRecord]
          : [];
      });
    }
    const dir = path.join(this.inboxDir, workerId);
    const entries: LooseRecord[] = [];
    const files = await readWorkerDirectoryNamesPinned(dir) ?? [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const entry = await this._readLocalInboxJson(path.join(dir, file), "worker inbox entry");
        if (entry) entries.push(entry);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
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
    await this._withLocalInboxLock(workerId, assignmentId, async () => {
      const filePath = path.join(this.inboxDir, workerId, `${assignmentId}.json`);
      await this._removeLocalInboxPair(filePath);
    });
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
    const files = await readWorkerDirectoryNamesPinned(dir) ?? [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const assignmentId = file.slice(0, -5);
      const claim = await this._withLocalInboxLock(workerId, assignmentId, async () => {
        const source = path.join(dir, file);
        const claimed = path.join(processingDir, file);
        const ownerPath = this._localInboxWriteOwnerPath(source);
        const claimedOwnerPath = this._localInboxWriteOwnerPath(claimed);
        try {
          await rename(source, claimed);
          await syncWorkerDirectory(dir);
          await syncWorkerDirectory(processingDir);
        } catch (error) {
          if (errorCode(error) === "ENOENT") return null;
          throw error;
        }
        try {
          await rename(ownerPath, claimedOwnerPath);
          await syncWorkerDirectory(dir);
          await syncWorkerDirectory(processingDir);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            try {
              await rename(claimed, source);
              await syncWorkerDirectory(dir);
              await syncWorkerDirectory(processingDir);
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                `worker inbox claim rollback failed: ${assignmentId}`,
              );
            }
            throw error;
          }
        }
        try {
          const assignment = await this._readLocalInboxJson(claimed, "claimed worker inbox payload");
          if (!assignment) throw Object.assign(new Error("claimed worker inbox payload disappeared"), { code: "ENOENT" });
          return { assignmentId, assignment: assignment as LooseRecord, claimToken: claimed };
        } catch (error) {
          const code = errorCode(error);
          if (code && code !== "ENOENT" && code !== "HUB_WORKER_INBOX_PAYLOAD_INVALID") throw error;
          return {
            assignmentId,
            assignment: { __malformedInbox: true },
            claimToken: claimed,
          };
        }
      });
      if (claim) claims.push(claim);
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
    const expectedClaimToken = path.join(this.inboxDir, workerId, "processing", `${assignmentId}.json`);
    if (path.resolve(claimToken) !== path.resolve(expectedClaimToken)) return false;
    return this._withLocalInboxLock(workerId, assignmentId, async () => {
      return this._removeLocalInboxPair(claimToken);
    });
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

  async _removeRedisWorkerInbox(backend: HubRedisStateBackend, workerId: string) {
    const prefix = this._inboxPrefix(workerId);
    const records = await backend.scanStateRecords(prefix);
    const settled = await Promise.allSettled(records.map(({ field }) => (
      this._mutateRedisRecord(backend, field, () => ({ data: null, result: undefined }))
    )));
    const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) {
      throw new AggregateError(errors, `worker Redis inbox cleanup failed: ${workerId}`);
    }
    const remaining = await backend.scanStateRecords(prefix);
    if (remaining.length > 0) {
      throw workerCleanupError(
        `worker ${workerId} Redis inbox still has ${remaining.length} record(s) after cleanup`,
        "HUB_WORKER_CLEANUP_INBOX_REMAINS",
      );
    }
  }

  async _removeRedisWorkerRegistry(backend: HubRedisStateBackend, workerId: string) {
    await this._mutateRedisRecord(
      backend,
      this._workerField(workerId),
      () => ({ data: null, result: undefined }),
    );
  }

  _localWorkerRegistryPath(workerId: string) {
    if (!workerId || path.basename(workerId) !== workerId || workerId === "." || workerId === "..") {
      throw workerCleanupError(
        `worker cleanup refused unsafe worker id: ${workerId}`,
        "HUB_WORKER_CLEANUP_AUTHORITY_CONFLICT",
      );
    }
    return path.join(this.registryDir, `worker-${workerId}.json`);
  }

  async _localWorkerCleanupAuthority(workerId: string, expectedWorker: LooseRecord) {
    const registryPath = this._localWorkerRegistryPath(workerId);
    let authority: Awaited<ReturnType<typeof readLocalWorkerJsonAuthority>>;
    try {
      authority = await readLocalWorkerJsonAuthority(
        registryPath,
        "worker registry cleanup authority",
        "HUB_WORKER_REGISTRY_INVALID",
      );
    } catch (error) {
      throw workerCleanupAuthorityError(
        `worker ${workerId} cleanup authority cannot be read safely`,
        registryPath,
        { cause: error, successorPreserved: true },
      );
    }
    if (!authority) {
      throw workerCleanupAuthorityError(
        `worker ${workerId} cleanup authority disappeared`,
        registryPath,
        { successorPreserved: false },
      );
    }
    const current = authority.record;
    const localWorker = current.host === "local" || current.host === os.hostname();
    const cleanupCandidate = current.status === "exited"
      || (current.status === "unhealthy" && localWorker);
    if (String(current.workerId || "") !== workerId
      || !receiptDeepEqual(current, expectedWorker)
      || !cleanupCandidate) {
      throw workerCleanupAuthorityError(
        `worker ${workerId} cleanup authority changed; successor preserved`,
        registryPath,
        { successorPreserved: true },
      );
    }
    let gone: boolean;
    try {
      gone = this._workerProcessIdentityGone(current);
    } catch (error) {
      throw workerCleanupAuthorityError(
        `worker ${workerId} cleanup identity cannot be revalidated`,
        registryPath,
        { cause: error, successorPreserved: true },
      );
    }
    if (!gone) {
      throw workerCleanupAuthorityError(
        `worker ${workerId} became live before cleanup; record preserved`,
        registryPath,
        { successorPreserved: true },
      );
    }
    return { registryPath, record: current, generation: authority.generation };
  }

  async _removeLocalWorkerInbox(workerId: string, expectedWorker: LooseRecord) {
    await this._localWorkerCleanupAuthority(workerId, expectedWorker);
    const inboxPath = path.join(this.inboxDir, workerId);
    await removeWorkerPathDurable(inboxPath, {
      recursive: true,
      reason: "dead-worker-inbox-cleanup",
    });
  }

  async _removeLocalWorkerRegistry(workerId: string, expectedWorker: LooseRecord) {
    const authority = await this._localWorkerCleanupAuthority(workerId, expectedWorker);
    await isolateWorkerPathDurable(authority.registryPath, {
      kind: "file",
      reason: "dead-worker-registry-cleanup",
      expectedGeneration: authority.generation,
    });
  }

  async pruneDead() {
    await assertHubWritable(this.hubRoot);
    const workers = await this.listWorkers();
    const backend = await this._backend();
    let removed = 0;
    const cleanupErrors: unknown[] = [];
    for (const worker of workers) {
      const localWorker = worker.host === "local" || worker.host === os.hostname();
      const cleanupCandidate = worker.status === "exited" || (worker.status === "unhealthy" && localWorker);
      if (!cleanupCandidate) continue;
      let gone = false;
      try {
        gone = this._workerProcessIdentityGone(worker);
      } catch (error) {
        cleanupErrors.push(error);
        continue;
      }
      if (!gone) continue;
      if (backend) {
        try {
          const workerId = String(worker.workerId);
          await this._removeRedisWorkerInbox(backend, workerId);
          await this._removeRedisWorkerRegistry(backend, workerId);
          removed++;
        } catch (error) {
          cleanupErrors.push(error);
        }
        continue;
      }
      try {
        const workerId = String(worker.workerId);
        await this._removeLocalWorkerInbox(workerId, worker);
        await this._removeLocalWorkerRegistry(workerId, worker);
        removed++;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw Object.assign(new AggregateError(cleanupErrors, "worker cleanup failed or could not verify process identity"), {
        code: "HUB_WORKER_CLEANUP_FAILED",
      });
    }
    return removed;
  }

  _isAlive(pid: unknown) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
    const current = this._captureProcessIdentity(pid);
    return Boolean(current);
  }

  _captureProcessIdentity(pid: number) {
    return captureProcessIdentity(pid, { strict: true });
  }

  _workerProcessIdentityGone(worker: LooseRecord) {
    const workerPid = typeof worker.pid === "number" && Number.isSafeInteger(worker.pid) && worker.pid > 0
      ? worker.pid
      : null;
    const identity = workerPid === null ? null : validProcessIdentity(worker.processIdentity, workerPid);
    if (!identity) {
      throw workerCleanupError(`worker ${String(worker.workerId || "")} has no valid process identity`);
    }
    const host = typeof worker.host === "string" ? worker.host : "";
    if (host && host !== os.hostname() && host !== "local") {
      throw workerCleanupError(`worker ${String(worker.workerId || "")} belongs to another host: ${host}`);
    }
    let current: ProcessIdentity | null;
    try {
      current = this._captureProcessIdentity(identity.pid);
    } catch (error) {
      throw workerCleanupError(
        `worker ${String(worker.workerId || "")} process identity probe failed for pid ${identity.pid}`,
        "HUB_WORKER_CLEANUP_LIVENESS_UNKNOWN",
        error,
      );
    }
    if (!current) return true;
    if (sameProcessIdentity(identity, current)) return false;
    throw workerCleanupError(
      `worker ${String(worker.workerId || "")} pid ${identity.pid} is now a different process`,
      "HUB_WORKER_CLEANUP_IDENTITY_MISMATCH",
    );
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
