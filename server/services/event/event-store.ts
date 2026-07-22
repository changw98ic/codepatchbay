import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord, recordValue, type LooseRecord } from "../../../core/contracts/types.js";
import { resolveCachedProjectRuntimeRoot } from "../phase-locator.js";
import {
  isSecretArtifact,
  isSecretContent,
  isSecretPath,
  makeSecretBlockedEvent,
  redactSecrets,
} from "../secret-policy.js";
import {
  materializeJob,
  advanceMaterializedJob,
  POST_TERMINAL_ALLOWED,
  TERMINAL_STATUSES,
  type MaterializedJobState,
} from "./event-materializer.js";
import type {
  ConditionalEventAppendResult,
  EventRecord,
  EventStreamCursor,
  EventStreamDurabilityResult,
  EventStoreOptions,
  EventWriteNotification,
} from "./event-types.js";
import { withTraceContext } from "../trace/trace-context.js";
import {
  openPinnedHubRedisStateBackend,
  type HubRedisStateBackend,
} from "../../../shared/hub-state-redis.js";
import type { ProcessIdentity } from "../../../core/runtime/process-tree.js";
import { withDurableDirectoryLock } from "../../../core/runtime/durable-directory-lock.js";
import { parseWorktreeOwnership } from "../../../core/contracts/worktree-ownership.js";
import { removeDurable, writeJsonDurableAtomic } from "../../../shared/hub-maintenance.js";

export { materializeJob, advanceMaterializedJob } from "./event-materializer.js";

const EVENT_LOCK_TTL_MS = 30_000;
const RESERVED_EXTERNAL_JOURNAL_PREFIXES = ["finalizer-journal-"] as const;

export type EventLockTestHooks = {
  afterRecoveryObserved?: (context: { lockDir: string; owner: LooseRecord | null }) => void | Promise<void>;
  afterQuarantineRename?: (context: { lockDir: string; quarantineDir: string; ownerToken: string | null }) => void | Promise<void>;
  captureProcessIdentity?: () => ProcessIdentity | null;
  beforeCheckpointDeleteFinalRename?: (context: { filePath: string; quarantinePath: string }) => void | Promise<void>;
  afterAppendOpen?: (context: { filePath: string; created: boolean }) => void | Promise<void>;
  afterAppendWrite?: (context: { filePath: string; bytesWritten: number }) => void | Promise<void>;
  afterAppendWriteChunk?: (context: { filePath: string; bytesWritten: number; expectedBytes: number }) => void | Promise<void>;
  maxAppendWriteBytes?: number;
  beforeEventFileSync?: (context: { filePath: string; operation: "append" | "recover" | "ensure" }) => void | Promise<void>;
  beforeEventParentSync?: (context: { directory: string; filePath: string }) => void | Promise<void>;
  afterDurabilityOpen?: (context: { filePath: string }) => void | Promise<void>;
  afterRecoveryRead?: (context: { filePath: string; bytesRead: number }) => void | Promise<void>;
  afterRecoveryWrite?: (context: { filePath: string; bytesWritten: number }) => void | Promise<void>;
  afterEventHandleClose?: (context: { filePath: string; authority: "file" | "directory" }) => void | Promise<void>;
  afterCheckpointSnapshot?: (context: { filePath: string; eventCount: number; eventDigest: string }) => void | Promise<void>;
  openRedisEventBackend?: () => Promise<HubRedisStateBackend | null>;
  waitMs?: number;
};

const eventLockTestHookStorage = new AsyncLocalStorage<EventLockTestHooks>();

export function withEventLockTestHooksForTests<T>(hooks: EventLockTestHooks, operation: () => T): T {
  const parent = eventLockTestHookStorage.getStore();
  return eventLockTestHookStorage.run(parent ? { ...parent, ...hooks } : hooks, operation);
}

function eventLockTestHooks() {
  return eventLockTestHookStorage.getStore() || {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function isEventRecord(value: unknown): value is EventRecord {
  return isRecord(value);
}

function missingEventStreamIdentity(value: unknown) {
  return value === undefined || value === null || value === "";
}

function eventStreamIdentityMismatch(
  project: string,
  jobId: string,
  event: EventRecord,
  details: LooseRecord = {},
) {
  return Object.assign(
    new Error(`event identity does not match stream ${project}/${jobId}`),
    {
      code: "EVENT_STREAM_IDENTITY_MISMATCH",
      committed: false,
      project,
      jobId,
      eventProject: event.project ?? null,
      eventJobId: event.jobId ?? null,
      ...details,
    },
  );
}

function bindEventStreamIdentity(event: EventRecord, project: string, jobId: string): EventRecord {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);
  const bound = { ...event };
  if (missingEventStreamIdentity(bound.project)) {
    bound.project = project;
  } else if (bound.project !== project) {
    throw eventStreamIdentityMismatch(project, jobId, bound);
  }
  if (missingEventStreamIdentity(bound.jobId)) {
    bound.jobId = jobId;
  } else if (bound.jobId !== jobId) {
    throw eventStreamIdentityMismatch(project, jobId, bound);
  }
  return bound;
}

function assertPersistedEventStreamIdentity(
  event: EventRecord,
  project: string,
  jobId: string,
  details: LooseRecord,
) {
  if (
    (!missingEventStreamIdentity(event.project) && event.project !== project)
    || (!missingEventStreamIdentity(event.jobId) && event.jobId !== jobId)
  ) {
    throw eventStreamIdentityMismatch(project, jobId, event, details);
  }
}

function reservedExternalJournal(jobId: string) {
  return RESERVED_EXTERNAL_JOURNAL_PREFIXES.some((prefix) => jobId.startsWith(prefix));
}

function assertConditionalExternalJournalWriter(jobId: string, externalJournal: boolean) {
  if (!reservedExternalJournal(jobId) || externalJournal) return;
  throw Object.assign(new Error("reserved external journal requires the conditional external-journal writer"), {
    code: "JOB_PROJECTION_CONFLICT",
    committed: false,
    jobId,
  });
}

function rejectGenericReservedJournalWriter(jobId: string) {
  if (!reservedExternalJournal(jobId)) return;
  throw Object.assign(new Error("job event append cannot write a reserved external journal"), {
    code: "JOB_PROJECTION_CONFLICT",
    committed: false,
    jobId,
  });
}

function redisJobField(project: string, jobId: string) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);
  const part = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `job:${part(project)}:${part(jobId)}`;
}

async function redisEventBackend() {
  const testBackend = eventLockTestHooks().openRedisEventBackend;
  if (testBackend) return await testBackend();
  const hubRoot = process.env.CPB_HUB_ROOT;
  if (!hubRoot) return null;
  return await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot,
  });
}

async function assertNoLocalEvent(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions) {
  const dataRoot = opts.dataRoot || resolveCachedProjectRuntimeRoot(cpbRoot, project);
  if (!dataRoot) return;
  const file = eventFileFor(cpbRoot, project, jobId, { ...opts, dataRoot, legacyOnly: false });
  try {
    if ((await stat(file)).size > 0) {
      throw Object.assign(new Error("local job events require an explicit Redis migration"), {
        code: "HUB_JOB_MIGRATION_REQUIRED",
      });
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

function redisPersistableEvent(event: EventRecord, project: string, jobId: string): EventRecord {
  const artifact = event.artifact;
  const blocked = (reason: string) => {
    const value = makeSecretBlockedEvent(artifact, reason);
    value.jobId = event.jobId ?? jobId;
    value.project = event.project ?? project;
    return withTraceContext(value, { project, jobId }) as EventRecord;
  };
  if (artifact && isSecretPath(artifact)) return blocked("secret-like artifact path blocked");
  if (typeof artifact === "string" && isSecretArtifact(artifact, artifact)) {
    return blocked("secret-like artifact content blocked");
  }
  if (typeof artifact === "string") {
    const payload = [event.content, event.output, event.stdout, event.stderr, event.body]
      .filter((value) => value !== undefined && value !== null);
    if (payload.some((value) => isSecretContent(typeof value === "string" ? value : JSON.stringify(value)))) {
      return blocked("secret-like artifact content blocked");
    }
  }
  return redactPersistableEvent(event);
}

function redactPersistableEvent(event: EventRecord): EventRecord {
  const ownership = event.type === "worktree_created" && event.worktreeOwnership !== undefined
    ? parseWorktreeOwnership(event.worktreeOwnership)
    : null;
  const redacted = recordValue(redactSecrets(event)) as EventRecord;
  if (ownership) {
    const redactedOwnership = recordValue(redacted.worktreeOwnership);
    redacted.worktreeOwnership = {
      ...redactedOwnership,
      ownerToken: ownership.ownerToken,
    };
    parseWorktreeOwnership(redacted.worktreeOwnership);
  }
  return redacted;
}

async function withEventLock<T>(eventFile: string, callback: () => Promise<T>): Promise<T> {
  const lockDir = `${eventFile}.lock`;
  const testHooks = eventLockTestHooks();
  try {
    return await withDurableDirectoryLock(lockDir, callback, {
      ttlMs: EVENT_LOCK_TTL_MS,
      waitMs: testHooks.waitMs ?? EVENT_LOCK_TTL_MS,
      retryMs: 10,
      hooks: {
        afterRecoveryObserved: ({ lockDir: observedLockDir }) => eventLockTestHooks().afterRecoveryObserved?.({
          lockDir: observedLockDir,
          owner: null,
        }),
        afterQuarantineRename: ({ lockDir: quarantinedLockDir, quarantineDir, ownerToken }) => (
          eventLockTestHooks().afterQuarantineRename?.({
            lockDir: quarantinedLockDir,
            quarantineDir,
            ownerToken,
          })
        ),
      },
      captureIdentity: testHooks.captureProcessIdentity
        ? () => eventLockTestHooks().captureProcessIdentity?.() ?? null
        : undefined,
    });
  } catch (error) {
    const primary = error instanceof AggregateError && error.cause && typeof error.cause === "object"
      ? error.cause
      : null;
    const primaryRecord = recordValue(primary);
    const primaryCode = errnoCode(primary);
    if (primary && primaryCode) {
      Object.assign(error, {
        code: primaryCode,
        primaryError: primary,
        ...(primaryRecord.successorPreserved === true ? { successorPreserved: true } : {}),
        ...(primaryRecord.committed !== undefined ? { committed: primaryRecord.committed } : {}),
        ...(primaryRecord.durableWriteCommitted !== undefined
          ? { durableWriteCommitted: primaryRecord.durableWriteCommitted }
          : {}),
        ...(primaryRecord.durabilityAmbiguous !== undefined
          ? { durabilityAmbiguous: primaryRecord.durabilityAmbiguous }
          : {}),
        recoveryPaths: primaryRecord.recoveryPaths || [eventFile, path.dirname(eventFile), lockDir],
      });
    }
    throw error;
  }
}

export const JOBS_EVENTS_FORMAT_VERSION = 1;
const eventWriteListeners = new Set<(payload: EventWriteNotification) => void | Promise<void>>();

export function onEventWritten(listener: (payload: EventWriteNotification) => void | Promise<void>) {
  eventWriteListeners.add(listener);
  return () => eventWriteListeners.delete(listener);
}

async function notifyEventWritten(payload: EventWriteNotification) {
  for (const listener of eventWriteListeners) {
    try {
      await listener(payload);
    } catch {}
  }
}

function _base(cpbRoot: string, opts: EventStoreOptions) {
  if (opts?.dataRoot) return opts.dataRoot;
  if (opts?.legacyOnly === true) return legacyRuntimeRoot(cpbRoot);
  throw new Error("dataRoot is required for project event store paths");
}

function legacyRuntimeRoot(cpbRoot: string) {
  return path.join(path.resolve(cpbRoot), "cpb-task");
}

function validatePathComponent(name: string, value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)
  ) {
    throw new Error(`invalid ${name}`);
  }
}

function serializeEvent(event: unknown) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("invalid event: expected a non-null object");
  }

  let serialized;
  try {
    serialized = JSON.stringify(event);
  } catch (err) {
    throw new Error(`invalid event: ${err.message}`);
  }

  if (typeof serialized !== "string") {
    throw new Error("invalid event: must serialize to JSON");
  }

  return serialized;
}

function canonicalSerializedEvent(serialized: string) {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!isRecord(value)) return value;
    const normalized: LooseRecord = {};
    for (const key of Object.keys(value).sort()) normalized[key] = canonical(value[key]);
    return normalized;
  };
  return JSON.stringify(canonical(JSON.parse(serialized)));
}

export type EventCheckpointCursor = EventStreamCursor;

export type JobEventProjection = EventCheckpointCursor & {
  checkpointEventCount: number | null;
  state: MaterializedJobState;
};

type EventCheckpointRecord = {
  filePath: string;
  cursor: EventCheckpointCursor | null;
  state: MaterializedJobState;
};

const CHECKPOINT_CURSOR_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function eventCursor(events: EventRecord[]): EventCheckpointCursor {
  const hash = createHash("sha256");
  for (const event of events) {
    hash.update(serializeEvent(event), "utf8");
    hash.update("\n", "utf8");
  }
  return {
    eventCount: events.length,
    eventDigest: hash.digest("hex"),
  };
}

export function eventStreamCursorForRecords(events: EventRecord[]): EventStreamCursor {
  return eventCursor(events);
}

function assertEventStreamCursor(value: EventStreamCursor): EventStreamCursor {
  if (
    !value
    || !Number.isSafeInteger(value.eventCount)
    || value.eventCount < 0
    || typeof value.eventDigest !== "string"
    || !SHA256_PATTERN.test(value.eventDigest)
  ) {
    throw Object.assign(new Error("invalid expected event stream cursor"), {
      code: "EVENT_STREAM_CURSOR_INVALID",
      committed: false,
    });
  }
  return {
    eventCount: value.eventCount,
    eventDigest: value.eventDigest,
  };
}

function sameEventStreamCursor(left: EventStreamCursor, right: EventStreamCursor) {
  return left.eventCount === right.eventCount && left.eventDigest === right.eventDigest;
}

function checkpointStateDigest(state: LooseRecord | MaterializedJobState) {
  return sha256(serializeEvent(state));
}

function sameCheckpointState(left: LooseRecord | MaterializedJobState, right: LooseRecord | MaterializedJobState) {
  return checkpointStateDigest(left) === checkpointStateDigest(right);
}

function malformedEventError(file: string, lineNumber: number, reason: string) {
  return new Error(`${file} at line ${lineNumber}: malformed event: ${reason}`);
}

type EventFileGeneration = Pick<Stats,
  "dev" | "ino" | "mode" | "nlink" | "uid" | "gid" | "size" | "mtimeMs" | "ctimeMs" | "birthtimeMs"
>;

type EventDirectoryIdentity = Pick<Stats, "dev" | "ino" | "mode" | "uid" | "gid" | "birthtimeMs">;

type EventDirectoryAuthority = {
  directory: string;
  handle: Awaited<ReturnType<typeof open>>;
  identity: EventDirectoryIdentity;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function eventStoreError(
  message: string,
  code: string,
  filePath: string,
  cause?: unknown,
  details: LooseRecord = {},
) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code, filePath, ...details },
  );
}

function fileGeneration(info: Stats): EventFileGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    nlink: info.nlink,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function directoryIdentity(info: Stats): EventDirectoryIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    birthtimeMs: info.birthtimeMs,
  };
}

function sameFileGeneration(left: EventFileGeneration, right: EventFileGeneration | Stats) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameDirectoryIdentity(left: EventDirectoryIdentity, right: EventDirectoryIdentity | Stats) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.birthtimeMs === right.birthtimeMs;
}

function noFollowFlag(filePath: string) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw eventStoreError(
      `O_NOFOLLOW is unavailable for event file authority: ${filePath}`,
      "EVENT_FILE_AUTHORITY_UNAVAILABLE",
      filePath,
    );
  }
  return constants.O_NOFOLLOW;
}

function directoryOpenFlags(directory: string) {
  if (
    typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw eventStoreError(
      `O_DIRECTORY is unavailable for event directory authority: ${directory}`,
      "EVENT_DIRECTORY_AUTHORITY_UNAVAILABLE",
      directory,
    );
  }
  return constants.O_RDONLY | noFollowFlag(directory) | constants.O_DIRECTORY;
}

async function eventPathGeneration(filePath: string): Promise<EventFileGeneration | null> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw eventStoreError(
        `event path is not a real regular file: ${filePath}`,
        "EVENT_FILE_UNSAFE",
        filePath,
      );
    }
    return fileGeneration(info);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function openEventDirectoryAuthority(filePath: string): Promise<EventDirectoryAuthority> {
  const directory = path.dirname(filePath);
  let before: Stats;
  try {
    before = await lstat(directory);
  } catch (error) {
    throw eventStoreError(
      `event directory cannot be inspected safely: ${directory}`,
      "EVENT_DIRECTORY_UNSAFE",
      filePath,
      error,
      { directory },
    );
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw eventStoreError(
      `event directory is not a real directory: ${directory}`,
      "EVENT_DIRECTORY_UNSAFE",
      filePath,
      undefined,
      { directory },
    );
  }
  const expected = directoryIdentity(before);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(directory, directoryOpenFlags(directory));
    const opened = await handle.stat();
    const current = await lstat(directory);
    if (
      !opened.isDirectory()
      || !current.isDirectory()
      || current.isSymbolicLink()
      || !sameDirectoryIdentity(expected, opened)
      || !sameDirectoryIdentity(expected, current)
    ) {
      throw eventStoreError(
        `event directory identity changed while opening: ${directory}`,
        "EVENT_DIRECTORY_CHANGED",
        filePath,
        undefined,
        { directory },
      );
    }
    return { directory, handle, identity: expected };
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        throw Object.assign(new AggregateError(
          [error, closeError],
          `event directory open and close failed: ${directory}`,
          { cause: error },
        ), {
          code: errnoCode(error) || "EVENT_DIRECTORY_UNSAFE",
          primaryError: error,
          closeError,
          filePath,
          directory,
        });
      }
    }
    throw error;
  }
}

async function validateEventDirectoryAuthority(authority: EventDirectoryAuthority, filePath: string) {
  let current: Stats;
  try {
    current = await lstat(authority.directory);
  } catch (error) {
    throw eventStoreError(
      `event directory path disappeared or changed: ${authority.directory}`,
      "EVENT_DIRECTORY_CHANGED",
      filePath,
      error,
      { directory: authority.directory },
    );
  }
  const opened = await authority.handle.stat();
  if (
    !opened.isDirectory()
    || !current.isDirectory()
    || current.isSymbolicLink()
    || !sameDirectoryIdentity(authority.identity, opened)
    || !sameDirectoryIdentity(authority.identity, current)
  ) {
    throw eventStoreError(
      `event directory identity changed: ${authority.directory}`,
      "EVENT_DIRECTORY_CHANGED",
      filePath,
      undefined,
      { directory: authority.directory },
    );
  }
}

async function throwAfterClosing(
  primaryError: unknown,
  handles: Array<{
    handle: Awaited<ReturnType<typeof open>> | null;
    authority: "file" | "directory";
  }>,
  filePath: string,
  message: string,
) {
  const closeErrors: unknown[] = [];
  for (const { handle, authority } of handles) {
    if (!handle) continue;
    try {
      await handle.close();
      await eventLockTestHooks().afterEventHandleClose?.({ filePath, authority });
    } catch (error) {
      closeErrors.push(error);
    }
  }
  if (primaryError) {
    if (closeErrors.length === 0) throw primaryError;
    throw Object.assign(new AggregateError(
      [primaryError, ...closeErrors],
      message,
      { cause: primaryError },
    ), {
      code: errnoCode(primaryError) || "EVENT_FILE_CLOSE_FAILED",
      primaryError,
      closeErrors,
    });
  }
  if (closeErrors.length > 0) {
    throw Object.assign(new AggregateError(closeErrors, message, { cause: closeErrors[0] }), {
      code: "EVENT_FILE_CLOSE_FAILED",
      closeErrors,
    });
  }
}

function eventFileChanged(filePath: string, message = `event file generation changed: ${filePath}`) {
  return eventStoreError(message, "EVENT_FILE_CHANGED", filePath, undefined, {
    committed: false,
    successorPreserved: true,
    recoveryPaths: [filePath, path.dirname(filePath)],
  });
}

async function readEventFileStable(
  filePath: string,
  operation: "read" | "checkpoint" = "read",
): Promise<string | null> {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const expected = await eventPathGeneration(filePath);
    if (!expected) return null;
    let parentAuthority: EventDirectoryAuthority | null = null;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let value: string | null = null;
    let verifiedFile: EventFileGeneration | null = null;
    let verifiedParent: EventDirectoryIdentity | null = null;
    let primaryError: unknown = null;
    try {
      parentAuthority = await openEventDirectoryAuthority(filePath);
      handle = await open(filePath, constants.O_RDONLY | noFollowFlag(filePath));
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFileGeneration(expected, opened)) {
        throw eventFileChanged(filePath, `event file changed while opening for read: ${filePath}`);
      }
      await validateEventDirectoryAuthority(parentAuthority, filePath);
      const raw = await handle.readFile();
      const afterDescriptor = await handle.stat();
      const afterPath = await eventPathGeneration(filePath);
      await validateEventDirectoryAuthority(parentAuthority, filePath);
      if (
        !afterPath
        || !sameFileGeneration(expected, afterDescriptor)
        || !sameFileGeneration(expected, afterPath)
      ) {
        throw eventFileChanged(filePath, `event file changed during read: ${filePath}`);
      }
      verifiedFile = afterPath;
      verifiedParent = parentAuthority.identity;
      value = raw.toString("utf8");
      if (!Buffer.from(value, "utf8").equals(raw)) {
        throw eventStoreError(
          `event file is not valid UTF-8: ${filePath}`,
          "EVENT_FILE_INVALID_UTF8",
          filePath,
        );
      }
    } catch (error) {
      primaryError = error;
    }
    try {
      await throwAfterClosing(
        primaryError,
        [
          { handle, authority: "file" },
          { handle: parentAuthority?.handle || null, authority: "directory" },
        ],
        filePath,
        `event file read authority close failed: ${filePath}`,
      );
      if (!verifiedFile || !verifiedParent) {
        throw eventFileChanged(filePath, `event file read authority was not retained through close: ${filePath}`);
      }
      await assertClosedEventPostcondition(filePath, verifiedFile, verifiedParent, operation);
    } catch (error) {
      if (errnoCode(error) === "EVENT_FILE_CHANGED" && attempt < 4) continue;
      throw error;
    }
    return value;
  }
  throw eventFileChanged(filePath, `event file could not reach a stable generation: ${filePath}`);
}

export function eventFileFor(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);

  const eventsRoot = path.join(_base(cpbRoot, opts), "events");
  const file = path.resolve(eventsRoot, project, `${jobId}.jsonl`);
  const relative = path.relative(eventsRoot, file);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("event file resolves outside events root");
  }

  return file;
}

async function _scanEventsDir(eventsRoot: string) {
  let projectEntries;
  try {
    projectEntries = await readdir(eventsRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const files = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const project = projectEntry.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(project)) continue;

    let jobEntries;
    try {
      jobEntries = await readdir(path.join(eventsRoot, project), { withFileTypes: true });
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }

    for (const jobEntry of jobEntries) {
      if (!jobEntry.isFile() || !jobEntry.name.endsWith(".jsonl")) continue;
      const jobId = jobEntry.name.slice(0, -".jsonl".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(jobId)) continue;
      files.push({ project, jobId, file: path.join(eventsRoot, project, jobEntry.name) });
    }
  }
  return files;
}

export async function listEventFiles(cpbRoot: string, opts: EventStoreOptions = {}) {
  const includeLegacyFallback = opts.includeLegacyFallback === true || opts.legacyOnly === true;
  if (!opts.dataRoot && !includeLegacyFallback) {
    throw new Error("dataRoot is required for project event store paths");
  }

  const rtRoot = opts.dataRoot && opts.legacyOnly !== true ? path.join(opts.dataRoot, "events") : null;
  const legacyRoot = path.join(legacyRuntimeRoot(cpbRoot), "events");

  const seen = new Set();
  const allFiles = [];

  if (rtRoot && rtRoot !== legacyRoot) {
    for (const f of await _scanEventsDir(rtRoot)) {
      const key = `${f.project}/${f.jobId}`;
      if (!seen.has(key)) { seen.add(key); allFiles.push(f); }
    }
  }
  if (includeLegacyFallback) {
    for (const f of await _scanEventsDir(legacyRoot)) {
      const key = `${f.project}/${f.jobId}`;
      if (!seen.has(key)) { seen.add(key); allFiles.push(f); }
    }
  }

  return allFiles.sort((a, b) => a.file.localeCompare(b.file));
}

type EventFileOperation = "append" | "recover" | "read" | "checkpoint" | "ensure";

function eventFileSuccessor(
  filePath: string,
  operation: EventFileOperation,
  {
    writeCommitted = false,
    fileSynced = false,
    parentSynced = false,
  }: {
    writeCommitted?: boolean;
    fileSynced?: boolean;
    parentSynced?: boolean;
  } = {},
) {
  return eventStoreError(
    `event file successor preserved during ${operation}: ${filePath}`,
    "EVENT_FILE_SUCCESSOR_PRESERVED",
    filePath,
    undefined,
    {
      committed: false,
      canonicalCommit: false,
      writeCommitted,
      durableWriteCommitted: writeCommitted && fileSynced && parentSynced,
      durabilityAmbiguous: writeCommitted && (!fileSynced || !parentSynced),
      successorPreserved: true,
      recoveryPaths: [filePath, path.dirname(filePath)],
    },
  );
}

async function assertClosedEventPostcondition(
  filePath: string,
  expectedFile: EventFileGeneration,
  expectedParent: EventDirectoryIdentity,
  operation: EventFileOperation,
  durability: { writeCommitted?: boolean; fileSynced?: boolean; parentSynced?: boolean } = {},
) {
  let currentFile: EventFileGeneration | null = null;
  let currentParent: Stats | null = null;
  try {
    currentFile = await eventPathGeneration(filePath);
    currentParent = await lstat(path.dirname(filePath));
  } catch {
    throw eventFileSuccessor(filePath, operation, durability);
  }
  if (
    !currentFile
    || !currentParent.isDirectory()
    || currentParent.isSymbolicLink()
    || !sameFileGeneration(expectedFile, currentFile)
    || !sameDirectoryIdentity(expectedParent, currentParent)
  ) {
    throw eventFileSuccessor(filePath, operation, durability);
  }
}

function eventMutationFailure(
  operation: "append" | "recover",
  filePath: string,
  error: unknown,
  {
    bytesWritten,
    fileSynced,
    created = false,
    parentSynced = !created,
    expectedBytes = null,
  }: {
    bytesWritten: number;
    fileSynced: boolean;
    created?: boolean;
    parentSynced?: boolean;
    expectedBytes?: number | null;
  },
) {
  if (errnoCode(error) === "EVENT_FILE_SUCCESSOR_PRESERVED") return error;
  if (bytesWritten <= 0) {
    if (error && typeof error === "object" && !("committed" in error)) {
      Object.assign(error, { committed: false });
    }
    return error;
  }
  if (
    operation === "append"
    && Number.isSafeInteger(expectedBytes)
    && Number(expectedBytes) > 0
    && bytesWritten < Number(expectedBytes)
  ) {
    return eventStoreError(
      `append wrote only part of an event record: ${filePath}`,
      "EVENT_APPEND_PARTIAL_WRITE",
      filePath,
      error,
      {
        committed: null,
        logicalWriteCommitted: false,
        partialWrite: true,
        durabilityAmbiguous: true,
        commitState: "partial-write",
        bytesWritten,
        expectedBytes,
        recoveryPaths: [filePath, path.dirname(filePath)],
      },
    );
  }
  return eventStoreError(
    `${operation} reached the event file but did not establish complete durable authority: ${filePath}`,
    operation === "append" ? "EVENT_APPEND_DURABILITY_AMBIGUOUS" : "EVENT_RECOVERY_DURABILITY_AMBIGUOUS",
    filePath,
    error,
    {
      committed: fileSynced && parentSynced ? true : null,
      durabilityAmbiguous: !fileSynced || !parentSynced,
      commitState: fileSynced && parentSynced ? "durable" : fileSynced ? "file-synced" : "write-complete",
      created,
      bytesWritten,
      recoveryPaths: [filePath, path.dirname(filePath)],
    },
  );
}

async function recoverEventFileLocked(filePath: string) {
  const expected = await eventPathGeneration(filePath);
  if (!expected) return { recovered: false, removedBytes: 0 };

  let parentAuthority: EventDirectoryAuthority | null = null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  let result: { recovered: boolean; removedBytes: number; addedNewline?: boolean } | null = null;
  let bytesWritten = 0;
  let fileSynced = false;
  let verifiedFile: EventFileGeneration | null = null;
  let verifiedParent: EventDirectoryIdentity | null = null;
  try {
    parentAuthority = await openEventDirectoryAuthority(filePath);
    handle = await open(filePath, constants.O_RDWR | noFollowFlag(filePath));
    const opened = await handle.stat();
    const openedGeneration = fileGeneration(opened);
    const canonical = await eventPathGeneration(filePath);
    if (
      !opened.isFile()
      || !canonical
      || !sameFileGeneration(expected, openedGeneration)
      || !sameFileGeneration(expected, canonical)
    ) {
      throw eventFileSuccessor(filePath, "recover");
    }
    await validateEventDirectoryAuthority(parentAuthority, filePath);
    const rawBuffer = await handle.readFile();
    const raw = rawBuffer.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(rawBuffer)) {
      throw eventStoreError(
        `event file is not valid UTF-8: ${filePath}`,
        "EVENT_FILE_INVALID_UTF8",
        filePath,
      );
    }
    await eventLockTestHooks().afterRecoveryRead?.({ filePath, bytesRead: rawBuffer.byteLength });

    const retainedDescriptor = await handle.stat();
    const retainedPath = await eventPathGeneration(filePath);
    await validateEventDirectoryAuthority(parentAuthority, filePath);
    if (
      !retainedPath
      || !sameFileGeneration(openedGeneration, retainedDescriptor)
      || !sameFileGeneration(openedGeneration, retainedPath)
    ) {
      throw eventFileSuccessor(filePath, "recover");
    }

    if (raw.endsWith("\n") || raw.length === 0) {
      verifiedFile = retainedPath;
      verifiedParent = parentAuthority.identity;
      result = { recovered: false, removedBytes: 0 };
    } else {
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      let replacement: Buffer;
      let removedBytes = 0;
      let addedNewline = false;
      if (lines.length === 0) {
        replacement = Buffer.alloc(0);
        removedBytes = rawBuffer.byteLength;
      } else {
        const lastLine = lines[lines.length - 1];
        try {
          JSON.parse(lastLine);
          replacement = Buffer.concat([rawBuffer, Buffer.from("\n")]);
          addedNewline = true;
        } catch {
          const lastNewline = raw.lastIndexOf("\n");
          const validPrefix = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
          replacement = Buffer.from(validPrefix, "utf8");
          removedBytes = rawBuffer.byteLength - replacement.byteLength;
        }
      }

      if (replacement.byteLength > rawBuffer.byteLength) {
        let offset = rawBuffer.byteLength;
        while (offset < replacement.byteLength) {
          const write = await handle.write(
            replacement,
            offset,
            replacement.byteLength - offset,
            offset,
          );
          if (write.bytesWritten <= 0) {
            throw eventStoreError(
              `event recovery write made no progress: ${filePath}`,
              "EVENT_RECOVERY_PARTIAL_WRITE",
              filePath,
            );
          }
          offset += write.bytesWritten;
          bytesWritten += write.bytesWritten;
        }
      } else {
        await handle.truncate(replacement.byteLength);
        bytesWritten = Math.abs(rawBuffer.byteLength - replacement.byteLength);
      }
      await eventLockTestHooks().afterRecoveryWrite?.({ filePath, bytesWritten });
      await eventLockTestHooks().beforeEventFileSync?.({ filePath, operation: "recover" });
      await handle.sync();
      fileSynced = true;

      const committed = fileGeneration(await handle.stat());
      const committedPath = await eventPathGeneration(filePath);
      await validateEventDirectoryAuthority(parentAuthority, filePath);
      if (!committedPath || !sameFileGeneration(committed, committedPath)) {
        throw eventFileSuccessor(filePath, "recover");
      }
      verifiedFile = committedPath;
      verifiedParent = parentAuthority.identity;
      result = addedNewline
        ? { recovered: true, removedBytes, addedNewline: true }
        : { recovered: true, removedBytes };
    }
  } catch (error) {
    primaryError = eventMutationFailure("recover", filePath, error, { bytesWritten, fileSynced });
  }

  await throwAfterClosing(
    primaryError,
    [
      { handle, authority: "file" },
      { handle: parentAuthority?.handle || null, authority: "directory" },
    ],
    filePath,
    `event recovery authority close failed: ${filePath}`,
  );
  if (!verifiedFile || !verifiedParent) {
    throw eventFileSuccessor(filePath, "recover", {
      writeCommitted: bytesWritten > 0,
      fileSynced,
      parentSynced: true,
    });
  }
  await assertClosedEventPostcondition(filePath, verifiedFile, verifiedParent, "recover", {
    writeCommitted: bytesWritten > 0,
    fileSynced,
    parentSynced: true,
  });
  return result || { recovered: false, removedBytes: 0 };
}

export async function recoverEventFile(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  const file = eventFileFor(cpbRoot, project, jobId, opts);
  return withEventLock(file, () => recoverEventFileLocked(file));
}

async function appendSerializedEventDurably(filePath: string, serialized: string) {
  const payload = Buffer.from(`${serialized}\n`, "utf8");
  const expected = await eventPathGeneration(filePath);
  let parentAuthority: EventDirectoryAuthority | null = null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  let created = false;
  let bytesWritten = 0;
  let fileSynced = false;
  let parentSynced = expected !== null;
  let verifiedFile: EventFileGeneration | null = null;
  let verifiedParent: EventDirectoryIdentity | null = null;
  try {
    parentAuthority = await openEventDirectoryAuthority(filePath);
    const flags = constants.O_WRONLY
      | constants.O_APPEND
      | noFollowFlag(filePath)
      | (expected ? 0 : constants.O_CREAT | constants.O_EXCL);
    try {
      handle = await open(filePath, flags, 0o600);
    } catch (error) {
      if (!expected && errnoCode(error) === "EEXIST") {
        throw eventFileSuccessor(filePath, "append");
      }
      if (["ELOOP", "EMLINK"].includes(errnoCode(error))) {
        throw eventStoreError(
          `event path rejected a no-follow append: ${filePath}`,
          "EVENT_FILE_UNSAFE",
          filePath,
          error,
        );
      }
      throw error;
    }
    created = expected === null;
    const opened = await handle.stat();
    const openedGeneration = fileGeneration(opened);
    const canonical = await eventPathGeneration(filePath);
    if (
      !opened.isFile()
      || !canonical
      || (expected && !sameFileGeneration(expected, openedGeneration))
      || (expected && !sameFileGeneration(expected, canonical))
      || (!expected && !sameFileGeneration(openedGeneration, canonical))
    ) {
      throw eventFileSuccessor(filePath, "append");
    }
    await validateEventDirectoryAuthority(parentAuthority, filePath);
    await eventLockTestHooks().afterAppendOpen?.({ filePath, created });

    const retainedDescriptor = await handle.stat();
    const retainedPath = await eventPathGeneration(filePath);
    await validateEventDirectoryAuthority(parentAuthority, filePath);
    if (
      !retainedPath
      || !sameFileGeneration(openedGeneration, retainedDescriptor)
      || !sameFileGeneration(openedGeneration, retainedPath)
    ) {
      throw eventFileSuccessor(filePath, "append");
    }

    while (bytesWritten < payload.byteLength) {
      const maxWriteBytes = eventLockTestHooks().maxAppendWriteBytes;
      const remainingBytes = payload.byteLength - bytesWritten;
      const requestedBytes = Number.isSafeInteger(maxWriteBytes) && Number(maxWriteBytes) > 0
        ? Math.min(remainingBytes, Number(maxWriteBytes))
        : remainingBytes;
      const write = await handle.write(
        payload,
        bytesWritten,
        requestedBytes,
        null,
      );
      if (write.bytesWritten <= 0) {
        throw eventStoreError(
          `event append made no progress: ${filePath}`,
          "EVENT_APPEND_PARTIAL_WRITE",
          filePath,
        );
      }
      bytesWritten += write.bytesWritten;
      await eventLockTestHooks().afterAppendWriteChunk?.({
        filePath,
        bytesWritten,
        expectedBytes: payload.byteLength,
      });
    }
    await eventLockTestHooks().afterAppendWrite?.({ filePath, bytesWritten });
    await eventLockTestHooks().beforeEventFileSync?.({ filePath, operation: "append" });
    await handle.sync();
    fileSynced = true;

    const committed = fileGeneration(await handle.stat());
    const committedPath = await eventPathGeneration(filePath);
    await validateEventDirectoryAuthority(parentAuthority, filePath);
    if (!committedPath || !sameFileGeneration(committed, committedPath)) {
      throw eventFileSuccessor(filePath, "append");
    }

    if (created) {
      await eventLockTestHooks().beforeEventParentSync?.({
        directory: parentAuthority.directory,
        filePath,
      });
      await parentAuthority.handle.sync();
      parentSynced = true;
      await validateEventDirectoryAuthority(parentAuthority, filePath);
    } else {
      parentSynced = true;
    }
    verifiedFile = committedPath;
    verifiedParent = parentAuthority.identity;
  } catch (error) {
    primaryError = eventMutationFailure("append", filePath, error, {
      bytesWritten,
      fileSynced,
      created,
      parentSynced,
      expectedBytes: payload.byteLength,
    });
  }

  await throwAfterClosing(
    primaryError,
    [
      { handle, authority: "file" },
      { handle: parentAuthority?.handle || null, authority: "directory" },
    ],
    filePath,
    `event append authority close failed: ${filePath}`,
  );
  if (!verifiedFile || !verifiedParent) {
    throw eventFileSuccessor(filePath, "append", {
      writeCommitted: bytesWritten > 0,
      fileSynced,
      parentSynced,
    });
  }
  await assertClosedEventPostcondition(filePath, verifiedFile, verifiedParent, "append", {
    writeCommitted: bytesWritten > 0,
    fileSynced,
    parentSynced,
  });
}

export async function appendEvent(cpbRoot: string, project: string, jobId: string, event: EventRecord, opts: EventStoreOptions = {}) {
  const boundEvent = bindEventStreamIdentity(event, project, jobId);
  const tracedEvent = withTraceContext(boundEvent, { project, jobId }) as EventRecord;
  // Validate event structure first (throws on invalid input)
  serializeEvent(tracedEvent);
  rejectGenericReservedJournalWriter(jobId);

  const redis = await redisEventBackend();
  if (redis) {
    await assertNoLocalEvent(cpbRoot, project, jobId, opts);
    const field = redisJobField(project, jobId);
    const persistable = redisPersistableEvent(tracedEvent, project, jobId);
    const serialized = serializeEvent(persistable);
    for (let retry = 0; retry < 64; retry += 1) {
      const snapshot = await redis.readStateRecord(field);
      const current = snapshot.data === null ? null : snapshot.data as MaterializedJobState;
      if (current && (!isRecord(current) || current.jobId !== jobId || current.project !== project)) {
        throw Object.assign(new Error(`invalid Redis job projection: ${project}/${jobId}`), { code: "HUB_STATE_RECORD_INVALID" });
      }
      if (current && recordValue(current).schema === "cpb.external-event-journal.v1") {
        throw Object.assign(new Error("job event append cannot reuse an external journal projection"), {
          code: "JOB_PROJECTION_CONFLICT",
          committed: false,
        });
      }
      const eventType = text(persistable.type);
      if (current && TERMINAL_STATUSES.has(current.status) && !POST_TERMINAL_ALLOWED.has(eventType)) {
        console.warn(`[event-store] skipped ${eventType || "unknown"} on terminal job ${jobId} (status: ${current.status})`);
        return null;
      }
      const projection = current
        ? advanceMaterializedJob(current, persistable)
        : materializeJob([persistable]);
      const committed = await redis.appendJobEvent(field, snapshot.revision, projection, serialized);
      if (!committed.committed) continue;
      await notifyEventWritten({
        cpbRoot, project, jobId, file: `redis:${field}`,
        dataRoot: opts.dataRoot ?? null, event: persistable,
      });
      return persistable;
    }
    throw Object.assign(new Error(`job events changed too frequently: ${project}/${jobId}`), { code: "HUB_STATE_RECORD_CONFLICT" });
  }

  const file = eventFileFor(cpbRoot, project, jobId, opts);

  const written = await withEventLock(file, async () => {
    // Terminal seal: reject business-state mutations on terminal job event logs.
    const existing = await readEvents(cpbRoot, project, jobId, opts.dataRoot ? { ...opts, includeLegacyFallback: false } : opts);
    if (existing.length > 0) {
      const state = materializeJob(existing);
      const eventType = text(tracedEvent.type);
      if (TERMINAL_STATUSES.has(state.status) && !POST_TERMINAL_ALLOWED.has(eventType)) {
        console.warn(`[event-store] skipped ${eventType || "unknown"} on terminal job ${jobId} (status: ${state.status})`);
        return null;
      }
    }

    const writeBlocked = async (artifactName: unknown, reason: string): Promise<EventRecord> => {
      const blocked: EventRecord = makeSecretBlockedEvent(artifactName, reason);
      blocked.jobId = tracedEvent.jobId ?? jobId;
      blocked.project = tracedEvent.project ?? project;
      const tracedBlocked = withTraceContext(blocked, { project, jobId }) as EventRecord;
      const serialized = serializeEvent(tracedBlocked);
      await appendSerializedEventDurably(file, serialized);
      return tracedBlocked;
    };

    // Block secret-like artifacts before persisting
    const artifact = tracedEvent.artifact;
    if (artifact && isSecretPath(artifact)) {
      return writeBlocked(tracedEvent.artifact, "secret-like artifact path blocked");
    }

    // Block events with secret-like content in artifact fields
    if (typeof artifact === "string" && isSecretArtifact(artifact, artifact)) {
      return writeBlocked(artifact, "secret-like artifact content blocked");
    }

    if (typeof artifact === "string") {
      const artifactPayload = [
        tracedEvent.content,
        tracedEvent.output,
        tracedEvent.stdout,
        tracedEvent.stderr,
        tracedEvent.body,
      ].filter((value) => value !== undefined && value !== null);
      if (artifactPayload.some((value) => isSecretContent(typeof value === "string" ? value : JSON.stringify(value)))) {
        return writeBlocked(artifact, "secret-like artifact content blocked");
      }
    }

    // Redact secrets from event payload before persisting
    const redacted = redactPersistableEvent(tracedEvent);
    const serialized = serializeEvent(redacted);
    await appendSerializedEventDurably(file, serialized);
    return redacted;
  });
  if (written) {
    await notifyEventWritten({ cpbRoot, project, jobId, file, dataRoot: opts.dataRoot ?? null, event: written });
  }
  return written;
}

function parseEventJsonl(
  raw: string,
  file: string,
  project: string,
  jobId: string,
  { requireTerminatingNewline = false }: { requireTerminatingNewline?: boolean } = {},
) {
  if (requireTerminatingNewline && raw.length > 0 && !raw.endsWith("\n")) {
    throw eventStoreError(
      `event stream ends with a partial record: ${file}`,
      "EVENT_STREAM_PARTIAL_RECORD",
      file,
      undefined,
      { committed: null, durabilityAmbiguous: true },
    );
  }
  const lines = raw
    .split("\n")
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0);

  const events: EventRecord[] = [];
  for (const { line, lineNumber } of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `malformed event JSON in ${file} at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!isEventRecord(event)) {
      throw malformedEventError(file, lineNumber, "expected a non-null object");
    }
    assertPersistedEventStreamIdentity(event, project, jobId, { filePath: file, lineNumber });
    events.push(event);
  }
  return events;
}

async function _parseEventFileReadOnly(
  file: string,
  project: string,
  jobId: string,
): Promise<EventRecord[] | null> {
  try {
    const raw = await readEventFileStable(file);
    if (raw === null) return null;
    return parseEventJsonl(raw, file, project, jobId);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function parseRedisEventRecords(serializedEvents: string[], project: string, jobId: string): EventRecord[] {
  return serializedEvents.map((serialized, index) => {
    let event: unknown;
    try {
      event = JSON.parse(serialized);
      if (!isEventRecord(event)) throw new Error("expected object");
    } catch (error) {
      throw new Error(`Redis job event ${project}/${jobId} at index ${index}: malformed event: ${error instanceof Error ? error.message : String(error)}`);
    }
    assertPersistedEventStreamIdentity(event, project, jobId, {
      source: `redis:${redisJobField(project, jobId)}`,
      eventIndex: index,
    });
    return event;
  });
}

async function readRedisEventRecords(
  redis: HubRedisStateBackend,
  field: string,
  project: string,
  jobId: string,
) {
  return parseRedisEventRecords(await redis.readJobEvents(field), project, jobId);
}

function eventDurabilityFailure(error: unknown, authority: string) {
  if (error && typeof error === "object") {
    const record = recordValue(error);
    Object.assign(error, {
      committed: null,
      durabilityAmbiguous: true,
      durabilityAuthority: authority,
      recoveryPaths: record.recoveryPaths || [authority],
    });
    return error;
  }
  return Object.assign(new Error(`event stream durability promotion failed: ${String(error)}`), {
    code: "EVENT_STREAM_DURABILITY_FAILED",
    committed: null,
    durabilityAmbiguous: true,
    durabilityAuthority: authority,
    recoveryPaths: [authority],
  });
}

async function ensureFilesystemEventStreamDurable(
  file: string,
  project: string,
  jobId: string,
): Promise<EventStreamDurabilityResult> {
  const expected = await eventPathGeneration(file);
  if (!expected) {
    return {
      backend: "filesystem",
      committed: true,
      exists: false,
      cursor: eventCursor([]),
      file,
    };
  }

  let parentAuthority: EventDirectoryAuthority | null = null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  let verifiedFile: EventFileGeneration | null = null;
  let verifiedParent: EventDirectoryIdentity | null = null;
  let events: EventRecord[] | null = null;
  try {
    parentAuthority = await openEventDirectoryAuthority(file);
    handle = await open(file, constants.O_RDONLY | noFollowFlag(file));
    const opened = await handle.stat();
    const canonical = await eventPathGeneration(file);
    if (
      !opened.isFile()
      || !canonical
      || !sameFileGeneration(expected, opened)
      || !sameFileGeneration(expected, canonical)
    ) {
      throw eventFileSuccessor(file, "ensure");
    }
    await validateEventDirectoryAuthority(parentAuthority, file);
    await eventLockTestHooks().afterDurabilityOpen?.({ filePath: file });

    const rawBuffer = await handle.readFile();
    const raw = rawBuffer.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(rawBuffer)) {
      throw eventStoreError(
        `event file is not valid UTF-8: ${file}`,
        "EVENT_FILE_INVALID_UTF8",
        file,
      );
    }
    events = parseEventJsonl(raw, file, project, jobId, { requireTerminatingNewline: true });

    const retainedDescriptor = await handle.stat();
    const retainedPath = await eventPathGeneration(file);
    await validateEventDirectoryAuthority(parentAuthority, file);
    if (
      !retainedPath
      || !sameFileGeneration(expected, retainedDescriptor)
      || !sameFileGeneration(expected, retainedPath)
    ) {
      throw eventFileSuccessor(file, "ensure");
    }

    await eventLockTestHooks().beforeEventFileSync?.({ filePath: file, operation: "ensure" });
    await handle.sync();
    const syncedDescriptor = await handle.stat();
    const syncedPath = await eventPathGeneration(file);
    await validateEventDirectoryAuthority(parentAuthority, file);
    if (
      !syncedPath
      || !sameFileGeneration(expected, syncedDescriptor)
      || !sameFileGeneration(expected, syncedPath)
    ) {
      throw eventFileSuccessor(file, "ensure", { writeCommitted: true, fileSynced: true });
    }

    await eventLockTestHooks().beforeEventParentSync?.({
      directory: parentAuthority.directory,
      filePath: file,
    });
    await parentAuthority.handle.sync();
    const committedDescriptor = await handle.stat();
    const committedPath = await eventPathGeneration(file);
    await validateEventDirectoryAuthority(parentAuthority, file);
    if (
      !committedPath
      || !sameFileGeneration(expected, committedDescriptor)
      || !sameFileGeneration(expected, committedPath)
    ) {
      throw eventFileSuccessor(file, "ensure", {
        writeCommitted: true,
        fileSynced: true,
        parentSynced: true,
      });
    }
    verifiedFile = committedPath;
    verifiedParent = parentAuthority.identity;
  } catch (error) {
    primaryError = error;
  }

  await throwAfterClosing(
    primaryError,
    [
      { handle, authority: "file" },
      { handle: parentAuthority?.handle || null, authority: "directory" },
    ],
    file,
    `event stream durability authority close failed: ${file}`,
  );
  if (!verifiedFile || !verifiedParent || !events) {
    throw eventFileSuccessor(file, "ensure", {
      writeCommitted: true,
      fileSynced: true,
      parentSynced: true,
    });
  }
  await assertClosedEventPostcondition(file, verifiedFile, verifiedParent, "ensure", {
    writeCommitted: true,
    fileSynced: true,
    parentSynced: true,
  });
  return {
    backend: "filesystem",
    committed: true,
    exists: true,
    cursor: eventCursor(events),
    file,
  };
}

/**
 * Promote an event stream to explicit durable read authority.
 *
 * Ordinary reads deliberately do not imply this guarantee. Filesystem streams
 * are parsed and fsynced together with their parent directory while the exact
 * file and directory generations remain pinned under the event lock.
 */
export async function ensureEventStreamDurable(
  cpbRoot: string,
  project: string,
  jobId: string,
  opts: EventStoreOptions = {},
): Promise<EventStreamDurabilityResult> {
  let authority = `${project}/${jobId}`;
  try {
    validatePathComponent("project", project);
    validatePathComponent("jobId", jobId);
    const redis = await redisEventBackend();
    if (redis) {
      await assertNoLocalEvent(cpbRoot, project, jobId, opts);
      const field = redisJobField(project, jobId);
      authority = `redis:${field}`;
      const events = await readRedisEventRecords(redis, field, project, jobId);
      return {
        backend: "redis",
        committed: true,
        exists: events.length > 0,
        cursor: eventCursor(events),
        file: authority,
      };
    }

    const file = eventFileFor(cpbRoot, project, jobId, opts);
    authority = file;
    return await withEventLock(file, () => ensureFilesystemEventStreamDurable(file, project, jobId));
  } catch (error) {
    throw eventDurabilityFailure(error, authority);
  }
}

export async function readEventStreamCursor(
  cpbRoot: string,
  project: string,
  jobId: string,
  opts: EventStoreOptions = {},
): Promise<EventStreamCursor> {
  const redis = await redisEventBackend();
  if (redis) {
    await assertNoLocalEvent(cpbRoot, project, jobId, opts);
    const field = redisJobField(project, jobId);
    return eventCursor(await readRedisEventRecords(redis, field, project, jobId));
  }
  const file = eventFileFor(cpbRoot, project, jobId, opts);
  return eventCursor(await _parseEventFileReadOnly(file, project, jobId) ?? []);
}

/**
 * Append one raw event only when the exact event-stream cursor still matches.
 *
 * This primitive deliberately does not advance a materialized job projection
 * or jobs index. It is intended for dedicated append-only journals whose
 * reducer and lifecycle are owned by their caller. Redis still uses the job
 * event append transaction for an atomic stream write, but leaves the existing
 * projection data unchanged.
 */
export async function appendEventIfCursor(
  cpbRoot: string,
  project: string,
  jobId: string,
  event: EventRecord,
  expectedCursor: EventStreamCursor,
  opts: EventStoreOptions = {},
): Promise<ConditionalEventAppendResult> {
  const expected = assertEventStreamCursor(expectedCursor);
  const boundEvent = bindEventStreamIdentity(event, project, jobId);
  assertConditionalExternalJournalWriter(jobId, opts.externalJournal === true);
  const tracedEvent = withTraceContext(boundEvent, { project, jobId }) as EventRecord;
  const tracedSerialized = serializeEvent(tracedEvent);
  const candidatePersistable = redisPersistableEvent(tracedEvent, project, jobId);
  const candidateSerialized = serializeEvent(candidatePersistable);
  if (
    opts.externalJournal === true
    && canonicalSerializedEvent(candidateSerialized) !== canonicalSerializedEvent(tracedSerialized)
  ) {
    throw Object.assign(new Error("external journal event requires secret blocking or redaction"), {
      code: "EXTERNAL_JOURNAL_PAYLOAD_REWRITE_REJECTED",
      committed: false,
      project,
      jobId,
    });
  }
  const persistable = opts.externalJournal === true ? tracedEvent : candidatePersistable;
  const serialized = opts.externalJournal === true ? tracedSerialized : candidateSerialized;

  const redis = await redisEventBackend();
  if (redis) {
    await assertNoLocalEvent(cpbRoot, project, jobId, opts);
    const field = redisJobField(project, jobId);
    const snapshot = await redis.readStateRecord(field);
    const existing = await readRedisEventRecords(redis, field, project, jobId);
    const current = eventCursor(existing);
    if (!sameEventStreamCursor(current, expected)) {
      return { committed: false, conflict: true, cursor: current };
    }

    const candidateCursor = eventCursor([...existing, persistable]);
    // A dedicated external journal does not have a materialized job projection.
    // Redis state records intentionally reject `data: null`, so initialize the
    // stream with an explicit non-job projection instead of weakening the normal
    // job-projection invariant in the shared backend.
    if (snapshot.data == null && opts.externalJournal !== true) {
      throw Object.assign(new Error("conditional job event append requires an existing Redis projection"), {
        code: "JOB_PROJECTION_REQUIRED",
        committed: false,
      });
    }
    const existingProjection = recordValue(snapshot.data);
    if (snapshot.data != null && opts.externalJournal === true && (
      existingProjection.schema !== "cpb.external-event-journal.v1"
      || existingProjection.project !== project
      || existingProjection.jobId !== jobId
    )) {
      throw Object.assign(new Error("external event journal conflicts with an existing Redis projection"), {
        code: "EXTERNAL_JOURNAL_PROJECTION_CONFLICT",
        committed: false,
      });
    }
    if (snapshot.data != null && opts.externalJournal !== true
      && existingProjection.schema === "cpb.external-event-journal.v1") {
      throw Object.assign(new Error("job event append cannot reuse an external journal projection"), {
        code: "JOB_PROJECTION_CONFLICT",
        committed: false,
      });
    }
    const projection = snapshot.data ?? {
      schema: "cpb.external-event-journal.v1",
      project,
      jobId,
    };
    let appended: Awaited<ReturnType<HubRedisStateBackend["appendJobEvent"]>>;
    try {
      appended = await redis.appendJobEvent(
        field,
        snapshot.revision,
        projection,
        serialized,
      );
    } catch (error) {
      if (error && typeof error === "object") {
        Object.assign(error, {
          expectedCursor: { ...expected },
          candidateCursor: { ...candidateCursor },
        });
      }
      throw error;
    }
    if (!appended.committed) {
      const conflictedCursor = eventCursor(await readRedisEventRecords(redis, field, project, jobId));
      return { committed: false, conflict: true, cursor: conflictedCursor };
    }
    await notifyEventWritten({
      cpbRoot,
      project,
      jobId,
      file: `redis:${field}`,
      dataRoot: opts.dataRoot ?? null,
      event: persistable,
    });
    return { committed: true, conflict: false, cursor: candidateCursor };
  }

  const file = eventFileFor(cpbRoot, project, jobId, opts);
  let candidateCursor: EventStreamCursor | null = null;
  let writtenEvent: EventRecord | null = null;
  let result: ConditionalEventAppendResult;
  try {
    result = await withEventLock(file, async () => {
      const existing = await _parseEventFileReadOnly(file, project, jobId) ?? [];
      const current = eventCursor(existing);
      if (!sameEventStreamCursor(current, expected)) {
        return { committed: false, conflict: true, cursor: current };
      }
      const nextCursor = eventCursor([...existing, persistable]);
      candidateCursor = nextCursor;
      await appendSerializedEventDurably(file, serialized);
      writtenEvent = persistable;
      return { committed: true, conflict: false, cursor: nextCursor };
    });
  } catch (error) {
    if (error && typeof error === "object") {
      Object.assign(error, {
        expectedCursor: { ...expected },
        ...(candidateCursor ? { candidateCursor: { ...candidateCursor } } : {}),
      });
    }
    throw error;
  }
  if (writtenEvent) {
    await notifyEventWritten({
      cpbRoot,
      project,
      jobId,
      file,
      dataRoot: opts.dataRoot ?? null,
      event: writtenEvent,
    });
  }
  return result;
}

export async function readEvents(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  const redis = await redisEventBackend();
  if (redis) {
    await assertNoLocalEvent(cpbRoot, project, jobId, opts);
    const field = redisJobField(project, jobId);
    return readRedisEventRecords(redis, field, project, jobId);
  }
  const cachedDataRoot = opts.dataRoot || (opts.legacyOnly !== true ? resolveCachedProjectRuntimeRoot(cpbRoot, project) : null);

  // Try runtime root first when we have one and it differs from legacy.
  if (opts.legacyOnly !== true && cachedDataRoot && cachedDataRoot !== legacyRuntimeRoot(cpbRoot)) {
    const rtFile = eventFileFor(cpbRoot, project, jobId, { ...opts, dataRoot: cachedDataRoot });
    const rtEvents = await _parseEventFileReadOnly(rtFile, project, jobId);
    if (rtEvents !== null) return rtEvents;
  }
  const includeLegacyFallback = opts.includeLegacyFallback === true || opts.legacyOnly === true;
  if (!includeLegacyFallback) {
    if (!cachedDataRoot) throw new Error("dataRoot is required for project event store paths");
    return [];
  }

  // Legacy path
  const file = eventFileFor(cpbRoot, project, jobId, { legacyOnly: true });
  const result = await _parseEventFileReadOnly(file, project, jobId);
  return result ?? [];
}

export async function readEventsReadOnly(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  const redis = await redisEventBackend();
  if (redis) return await readEvents(cpbRoot, project, jobId, opts);
  const cachedDataRoot = opts.dataRoot || (opts.legacyOnly !== true ? resolveCachedProjectRuntimeRoot(cpbRoot, project) : null);

  if (opts.legacyOnly !== true && cachedDataRoot && cachedDataRoot !== legacyRuntimeRoot(cpbRoot)) {
    const rtFile = eventFileFor(cpbRoot, project, jobId, { ...opts, dataRoot: cachedDataRoot });
    const rtEvents = await _parseEventFileReadOnly(rtFile, project, jobId);
    if (rtEvents !== null) return rtEvents;
  }
  const includeLegacyFallback = opts.includeLegacyFallback === true || opts.legacyOnly === true;
  if (!includeLegacyFallback) {
    if (!cachedDataRoot) throw new Error("dataRoot is required for project event store paths");
    return [];
  }
  const file = eventFileFor(cpbRoot, project, jobId, { legacyOnly: true });
  const result = await _parseEventFileReadOnly(file, project, jobId);
  return result ?? [];
}

function checkpointFileFor(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);
  const checkpointsRoot = path.join(_base(cpbRoot, opts), "checkpoints");
  return path.resolve(checkpointsRoot, project, `${jobId}.json`);
}

export async function writeCheckpoint(
  cpbRoot: string,
  project: string,
  jobId: string,
  state: LooseRecord,
  opts: EventStoreOptions = {},
  cursor: EventCheckpointCursor | null = null,
) {
  const file = checkpointFileFor(cpbRoot, project, jobId, opts);
  const checkpoint: LooseRecord = {
    _meta: {
      version: JOBS_EVENTS_FORMAT_VERSION,
      writtenAt: new Date().toISOString(),
      cursorVersion: cursor ? CHECKPOINT_CURSOR_VERSION : null,
      eventCount: cursor?.eventCount ?? null,
      eventDigest: cursor?.eventDigest ?? null,
      stateDigest: checkpointStateDigest(state),
    },
    state,
  };
  await withEventLock(file, () => writeJsonDurableAtomic(file, checkpoint));
  return file;
}

async function readCheckpointFile(filePath: string, project: string, jobId: string) {
  const raw = await readEventFileStable(filePath, "checkpoint");
  if (raw === null) return { found: false as const, record: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw eventStoreError(
      `malformed checkpoint JSON: ${filePath}`,
      "CHECKPOINT_INVALID",
      filePath,
      error,
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed._meta) || !isRecord(parsed.state)) {
    throw eventStoreError(
      `malformed checkpoint contract: ${filePath}`,
      "CHECKPOINT_INVALID",
      filePath,
    );
  }
  if (parsed._meta.version !== JOBS_EVENTS_FORMAT_VERSION) {
    throw eventStoreError(
      `unsupported checkpoint version in ${filePath}`,
      "CHECKPOINT_VERSION_UNSUPPORTED",
      filePath,
    );
  }
  if (parsed.state.jobId !== jobId || parsed.state.project !== project) {
    throw eventStoreError(
      `checkpoint identity does not match ${project}/${jobId}: ${filePath}`,
      "CHECKPOINT_IDENTITY_MISMATCH",
      filePath,
    );
  }
  if (!TERMINAL_STATUSES.has(parsed.state.status)) {
    throw eventStoreError(
      `checkpoint state is not terminal for ${project}/${jobId}: ${filePath}`,
      "CHECKPOINT_INVALID",
      filePath,
    );
  }

  const meta = parsed._meta;
  const hasLegacyCursor = meta.cursorVersion === undefined || meta.cursorVersion === null;
  const hasLegacyEventCount = meta.eventCount === undefined || meta.eventCount === null;
  const hasLegacyEventDigest = meta.eventDigest === undefined || meta.eventDigest === null;
  const legacy = hasLegacyCursor && hasLegacyEventCount && hasLegacyEventDigest;
  let cursor: EventCheckpointCursor | null = null;
  if (!legacy) {
    if (
      meta.cursorVersion !== CHECKPOINT_CURSOR_VERSION
      || typeof meta.eventCount !== "number"
      || !Number.isSafeInteger(meta.eventCount)
      || meta.eventCount < 1
      || typeof meta.eventDigest !== "string"
      || !SHA256_PATTERN.test(meta.eventDigest)
      || typeof meta.writtenAt !== "string"
      || !meta.writtenAt
      || typeof meta.stateDigest !== "string"
      || !SHA256_PATTERN.test(meta.stateDigest)
    ) {
      throw eventStoreError(
        `malformed checkpoint cursor contract: ${filePath}`,
        "CHECKPOINT_INVALID",
        filePath,
      );
    }
    cursor = {
      eventCount: meta.eventCount,
      eventDigest: meta.eventDigest,
    };
  } else if (
    meta.stateDigest !== undefined
    && meta.stateDigest !== null
    && (typeof meta.stateDigest !== "string" || !SHA256_PATTERN.test(meta.stateDigest))
  ) {
    throw eventStoreError(
      `malformed checkpoint state digest: ${filePath}`,
      "CHECKPOINT_INVALID",
      filePath,
    );
  }

  if (
    typeof meta.stateDigest === "string"
    && checkpointStateDigest(parsed.state) !== meta.stateDigest
  ) {
    throw eventStoreError(
      `checkpoint state digest does not match its payload: ${filePath}`,
      "CHECKPOINT_STATE_DIGEST_MISMATCH",
      filePath,
    );
  }
  return {
    found: true as const,
    record: {
      filePath,
      cursor,
      state: parsed.state as MaterializedJobState,
    } satisfies EventCheckpointRecord,
  };
}

async function readCheckpointRecord(
  cpbRoot: string,
  project: string,
  jobId: string,
  opts: EventStoreOptions = {},
): Promise<EventCheckpointRecord | null> {
  // Try runtime root first
  if (opts.legacyOnly !== true && opts.dataRoot && opts.dataRoot !== legacyRuntimeRoot(cpbRoot)) {
    const rtFile = checkpointFileFor(cpbRoot, project, jobId, opts);
    const runtimeCheckpoint = await readCheckpointFile(rtFile, project, jobId);
    if (runtimeCheckpoint.found) return runtimeCheckpoint.record;
  }
  const includeLegacyFallback = opts.includeLegacyFallback === true || opts.legacyOnly === true;
  if (!includeLegacyFallback) {
    if (!opts.dataRoot) throw new Error("dataRoot is required for project event store paths");
    return null;
  }
  const file = checkpointFileFor(cpbRoot, project, jobId, { legacyOnly: true });
  const legacyCheckpoint = await readCheckpointFile(file, project, jobId);
  return legacyCheckpoint.found ? legacyCheckpoint.record : null;
}

export async function readCheckpoint(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}): Promise<MaterializedJobState | null> {
  return (await readCheckpointRecord(cpbRoot, project, jobId, opts))?.state ?? null;
}

function checkpointReplayError(record: EventCheckpointRecord, message: string, code: string, details: LooseRecord = {}) {
  return eventStoreError(message, code, record.filePath, undefined, {
    committed: false,
    recoveryPaths: [record.filePath, path.dirname(record.filePath)],
    ...details,
  });
}

function checkpointPrefixEventCount(record: EventCheckpointRecord, events: EventRecord[]) {
  if (record.cursor) {
    if (record.cursor.eventCount > events.length) {
      throw checkpointReplayError(
        record,
        `checkpoint cursor is ahead of the event stream: ${record.filePath}`,
        "CHECKPOINT_CURSOR_AHEAD",
        { checkpointEventCount: record.cursor.eventCount, eventCount: events.length },
      );
    }
    const prefix = events.slice(0, record.cursor.eventCount);
    const actualCursor = eventCursor(prefix);
    if (actualCursor.eventDigest !== record.cursor.eventDigest) {
      throw checkpointReplayError(
        record,
        `checkpoint event prefix identity does not match the event stream: ${record.filePath}`,
        "CHECKPOINT_EVENT_PREFIX_MISMATCH",
        { checkpointEventCount: record.cursor.eventCount },
      );
    }
    if (!sameCheckpointState(record.state, materializeJob(prefix))) {
      throw checkpointReplayError(
        record,
        `checkpoint state does not match its committed event prefix: ${record.filePath}`,
        "CHECKPOINT_STATE_MISMATCH",
        { checkpointEventCount: record.cursor.eventCount },
      );
    }
    return record.cursor.eventCount;
  }

  let candidate = materializeJob([]);
  let matchedEventCount: number | null = null;
  for (let index = 0; index < events.length; index += 1) {
    candidate = advanceMaterializedJob(candidate, events[index]!);
    if (sameCheckpointState(record.state, candidate)) matchedEventCount = index + 1;
  }
  if (matchedEventCount === null) {
    throw checkpointReplayError(
      record,
      `legacy checkpoint state is not an exact prefix of the event stream: ${record.filePath}`,
      "CHECKPOINT_STATE_MISMATCH",
      { checkpointEventCount: null, eventCount: events.length },
    );
  }
  return matchedEventCount;
}

export async function readJobProjection(
  cpbRoot: string,
  project: string,
  jobId: string,
  opts: EventStoreOptions = {},
): Promise<JobEventProjection> {
  const redis = await redisEventBackend();
  const checkpoint = redis ? null : await readCheckpointRecord(cpbRoot, project, jobId, opts);
  const events = await readEvents(cpbRoot, project, jobId, opts);
  const cursor = eventCursor(events);
  if (!checkpoint) {
    return {
      ...cursor,
      checkpointEventCount: null,
      state: materializeJob(events),
    };
  }

  const checkpointEventCount = checkpointPrefixEventCount(checkpoint, events);
  let replayed = structuredClone(checkpoint.state);
  for (const event of events.slice(checkpointEventCount)) {
    replayed = advanceMaterializedJob(replayed, event);
  }
  const fullyMaterialized = materializeJob(events);
  if (!sameCheckpointState(replayed, fullyMaterialized)) {
    throw checkpointReplayError(
      checkpoint,
      `checkpoint suffix replay diverged from a full event replay: ${checkpoint.filePath}`,
      "CHECKPOINT_REPLAY_MISMATCH",
      { checkpointEventCount, eventCount: events.length },
    );
  }
  return {
    ...cursor,
    checkpointEventCount,
    state: replayed,
  };
}

export async function withLockedJobProjection<T>(
  cpbRoot: string,
  project: string,
  jobId: string,
  opts: EventStoreOptions,
  operation: (projection: JobEventProjection) => Promise<T>,
): Promise<T> {
  if (await redisEventBackend()) {
    return operation(await readJobProjection(cpbRoot, project, jobId, opts));
  }
  const file = eventFileFor(cpbRoot, project, jobId, opts);
  return withEventLock(file, async () => (
    operation(await readJobProjection(cpbRoot, project, jobId, opts))
  ));
}

export async function deleteCheckpoint(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  const file = checkpointFileFor(cpbRoot, project, jobId, opts);
  return withEventLock(file, () => removeDurable(file, {
    beforeFinalRename: (context) => eventLockTestHooks().beforeCheckpointDeleteFinalRename?.(context),
  }));
}

export async function checkpointJob(cpbRoot: string, project: string, jobId: string, opts: EventStoreOptions = {}) {
  const checkpointSnapshot = async () => {
    const events = await readEvents(cpbRoot, project, jobId, opts);
    if (events.length === 0) return null;
    const state = materializeJob(events);
    if (!TERMINAL_STATUSES.has(state.status)) return null;
    const cursor = eventCursor(events);
    await eventLockTestHooks().afterCheckpointSnapshot?.({
      filePath: eventFileFor(cpbRoot, project, jobId, opts),
      ...cursor,
    });
    await writeCheckpoint(cpbRoot, project, jobId, state, opts, cursor);
    return state;
  };

  if (await redisEventBackend()) return checkpointSnapshot();
  const file = eventFileFor(cpbRoot, project, jobId, opts);
  return withEventLock(file, checkpointSnapshot);
}
