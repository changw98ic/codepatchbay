import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rmdir } from "node:fs/promises";
import path from "node:path";

import {
  openHubRedisStateBackend,
  redisRestoreCommitOutcome,
  type RedisLogicalSnapshot,
} from "../../../shared/hub-state-redis.js";
import { acquireHubMaintenance, fsyncDirectory } from "../../../shared/hub-maintenance.js";
import {
  readBoundedRegularFileNoFollow,
  type BoundedRegularFileReadHooks,
} from "../../../core/runtime/durable-directory-lock.js";
import { materializeJob } from "../event/event-store.js";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_LOG_BYTES = 256 * 1024 * 1024;
const MAX_MIGRATION_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_MIGRATION_SNAPSHOT_BYTES = 300 * 1024 * 1024;
const MAX_MIGRATION_RESULT_BYTES = 1024 * 1024;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type LooseRecord = Record<string, unknown>;

type MigrationMetadataReadKind = "local-json" | "local-event" | "journal" | "snapshot" | "result";

type MigrationTestHooks = {
  readHooks?: Partial<Record<MigrationMetadataReadKind, BoundedRegularFileReadHooks>>;
  beforeAuthorityIsolation?: (context: {
    sourcePath: string;
    isolationRoot: string;
    quarantinePath: string;
    operation: string;
  }) => void | Promise<void>;
  afterAuthorityIsolation?: (context: {
    sourcePath: string;
    isolationRoot: string;
    quarantinePath: string;
    operation: string;
  }) => void | Promise<void>;
  syncDirectory?: (context: { directory: string; operation: string }) => void | Promise<void>;
  afterOutputDirectoryMkdir?: (context: { output: string; parent: string }) => void | Promise<void>;
  afterMigrationArtifactPublish?: (context: {
    filePath: string;
    operation: string;
  }) => void | Promise<void>;
  afterRedisRestoreCommitBoundary?: (context: { operation: string }) => void | Promise<void>;
  beforeRedisMaintenanceFinalize?: (context: { operation: string }) => void | Promise<void>;
};

const migrationTestHookStorage = new AsyncLocalStorage<MigrationTestHooks>();
const migrationCommitContextStorage = new AsyncLocalStorage<MigrationCommitContext>();
const migrationFsMutationErrorContexts = new WeakMap<object, MigrationCommitContext>();
const redisOutcomeErrorContexts = new WeakMap<object, MigrationCommitContext>();

function migrationFsMutationError<T extends Error>(error: T) {
  const context = migrationCommitContextStorage.getStore();
  if (context) migrationFsMutationErrorContexts.set(error, context);
  return error;
}

function migrationTestHooks() {
  return migrationTestHookStorage.getStore() || {};
}

export async function _internalWithHubRedisMigrationTestHooksForTests<T>(
  hooks: MigrationTestHooks,
  callback: () => Promise<T>,
) {
  const inherited = migrationTestHookStorage.getStore();
  const readHooks = inherited?.readHooks || hooks.readHooks
    ? Object.freeze({ ...inherited?.readHooks, ...hooks.readHooks })
    : undefined;
  return await migrationTestHookStorage.run(
    Object.freeze({ ...inherited, ...hooks, ...(readHooks ? { readHooks } : {}) }),
    callback,
  );
}

type PathGeneration = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type FileAuthority = {
  path: string;
  type: "file";
  generation: PathGeneration;
  sha256: string;
  maxBytes: number;
  readKind: MigrationMetadataReadKind;
};

type DirectoryAuthority = {
  path: string;
  type: "directory";
  generation: PathGeneration;
};

type LocalPathAuthority = FileAuthority | DirectoryAuthority;
type AuthoritySink = Map<string, LocalPathAuthority>;

export type LocalRedisMigrationInventory = {
  projects: number;
  queueEntries: number;
  assignments: number;
  attempts: number;
  workers: number;
  inboxEntries: number;
  leases: number;
  jobs: number;
  jobEvents: number;
  runtimeRoots: string[];
  sourcePaths: string[];
};

function migrationError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function pathGeneration(info: Stats): PathGeneration {
  return {
    dev: Number(info.dev),
    ino: Number(info.ino),
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function samePathGeneration(expected: PathGeneration, actual: PathGeneration) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

function sameRelocatedGeneration(expected: PathGeneration, actual: PathGeneration) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.birthtimeMs === actual.birthtimeMs
    && actual.ctimeMs >= expected.ctimeMs;
}

function sameDirectoryIdentity(expected: PathGeneration, actual: PathGeneration) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.birthtimeMs === actual.birthtimeMs;
}

function samePathAuthority(expected: LocalPathAuthority, actual: LocalPathAuthority) {
  return expected.path === actual.path
    && expected.type === actual.type
    && samePathGeneration(expected.generation, actual.generation)
    && (expected.type !== "file" || actual.type !== "file" || (
      expected.sha256 === actual.sha256
      && expected.maxBytes === actual.maxBytes
      && expected.readKind === actual.readKind
    ));
}

function authorityChanged(
  label: string,
  targetPath: string,
  recoveryPaths: Record<string, string> = {},
  metadata: Record<string, unknown> = {},
) {
  const error = Object.assign(new Error(`${label} authority changed before mutation: ${targetPath}`), {
    code: "HUB_REDIS_MIGRATION_AUTHORITY_CHANGED",
    committed: false,
    committedPath: null,
    recoveryPaths,
    ...metadata,
  });
  return migrationFsMutationError(error);
}

function committedDurabilityAmbiguity(
  message: string,
  committedPath: string | null,
  recoveryPaths: Record<string, string>,
  cause: unknown,
) {
  const error = Object.assign(new Error(message, { cause }), {
    code: "HUB_REDIS_MIGRATION_COMMITTED_DURABILITY_AMBIGUOUS",
    committed: true,
    committedPath,
    recoveryPaths,
  });
  return migrationFsMutationError(error);
}

function successorPreserved(
  message: string,
  committedPath: string | null,
  recoveryPaths: Record<string, string>,
) {
  const error = Object.assign(new Error(message), {
    code: "HUB_REDIS_MIGRATION_SUCCESSOR_PRESERVED",
    committed: true,
    committedPath,
    successorPreserved: true,
    recoveryPaths,
  });
  return migrationFsMutationError(error);
}

type MigrationCommitContext = {
  redisCommitted: boolean;
  commitMayHaveOccurred: boolean;
  recoveryPaths: Readonly<Record<string, string>>;
};

function redisCommittedFailure(error: unknown, context: MigrationCommitContext) {
  if (error && typeof error === "object" && redisOutcomeErrorContexts.get(error) === context) {
    return error instanceof Error ? error : Object.assign(new Error(String(error)), error);
  }
  const rawDetails = error && typeof error === "object"
    ? { ...(error as Record<string, unknown>) }
    : {};
  const details = { ...rawDetails };
  for (const key of [
    "committed",
    "committedPath",
    "redisCommitted",
    "commitMayHaveOccurred",
    "recoveryPaths",
    "successorPreserved",
  ]) delete details[key];
  const boundOutcomeContext = error && typeof error === "object"
    ? redisOutcomeErrorContexts.get(error)
    : undefined;
  const boundFsContext = error && typeof error === "object"
    ? migrationFsMutationErrorContexts.get(error)
    : undefined;
  const foreignBoundError = Boolean(
    (boundOutcomeContext && boundOutcomeContext !== context)
    || (boundFsContext && boundFsContext !== context)
  );
  const trustedFsMutationError = Boolean(
    error
    && typeof error === "object"
    && migrationFsMutationErrorContexts.get(error) === context
  );
  const priorRecoveryPaths = trustedFsMutationError && rawDetails.recoveryPaths
    && typeof rawDetails.recoveryPaths === "object"
    && !Array.isArray(rawDetails.recoveryPaths)
    ? rawDetails.recoveryPaths as Record<string, string>
    : {};
  const committedPath = trustedFsMutationError && rawDetails.committed === true
    && (typeof rawDetails.committedPath === "string" || rawDetails.committedPath === null)
    ? rawDetails.committedPath
    : null;
  const code = !foreignBoundError && typeof details.code === "string"
    ? details.code
    : "HUB_REDIS_MIGRATION_REDIS_COMMITTED";
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = Object.assign(new Error(message, { cause: error }), details, {
    code,
    committed: true,
    committedPath,
    redisCommitted: true,
    ...(trustedFsMutationError && rawDetails.successorPreserved === true
      ? { successorPreserved: true }
      : {}),
    recoveryPaths: Object.freeze({ ...priorRecoveryPaths, ...context.recoveryPaths }),
  });
  redisOutcomeErrorContexts.set(wrapped, context);
  return wrapped;
}

function redisCommitOutcomeUnknownFailure(error: unknown, context: MigrationCommitContext) {
  if (error && typeof error === "object" && redisOutcomeErrorContexts.get(error) === context) {
    return error instanceof Error ? error : Object.assign(new Error(String(error)), error);
  }
  const details = error && typeof error === "object"
    ? { ...(error as Record<string, unknown>) }
    : {};
  for (const key of [
    "committed",
    "committedPath",
    "redisCommitted",
    "commitMayHaveOccurred",
    "recoveryPaths",
    "successorPreserved",
  ]) delete details[key];
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = Object.assign(new Error(message, { cause: error }), details, {
    code: typeof details.code === "string" ? details.code : "HUB_REDIS_MIGRATION_COMMIT_OUTCOME_UNKNOWN",
    committed: false,
    committedPath: null,
    redisCommitted: false,
    commitMayHaveOccurred: true,
    recoveryPaths: Object.freeze({ ...context.recoveryPaths }),
  });
  redisOutcomeErrorContexts.set(wrapped, context);
  return wrapped;
}

function redisOutcomeFailure(error: unknown, context: MigrationCommitContext) {
  if (context.redisCommitted) return redisCommittedFailure(error, context);
  if (context.commitMayHaveOccurred) return redisCommitOutcomeUnknownFailure(error, context);
  return error;
}

async function runAfterRedisCommit<T>(context: MigrationCommitContext, callback: () => Promise<T>) {
  try {
    return await migrationCommitContextStorage.run(context, callback);
  } catch (error) {
    throw redisCommittedFailure(error, context);
  }
}

async function syncMigrationDirectory(directory: string, operation: string) {
  await migrationTestHooks().syncDirectory?.({ directory, operation });
  await fsyncDirectory(directory);
}

function record(value: unknown, label: string): LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", `${label} must be an object`);
  }
  return value as LooseRecord;
}

async function exists(target: string) {
  try { await lstat(target); return true; } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readPinnedMetadata(
  target: string,
  maxBytes: number,
  readKind: MigrationMetadataReadKind,
): Promise<{ raw: string; authority: FileAuthority }> {
  const resolved = path.resolve(target);
  const before = await lstat(resolved);
  const raw = await readBoundedRegularFileNoFollow(resolved, {
    maxBytes,
    hooks: migrationTestHooks().readHooks?.[readKind],
  });
  const after = await lstat(resolved);
  const beforeGeneration = pathGeneration(before);
  const afterGeneration = pathGeneration(after);
  if (!before.isFile() || before.isSymbolicLink()
    || !after.isFile() || after.isSymbolicLink()
    || !samePathGeneration(beforeGeneration, afterGeneration)) {
    throw Object.assign(new Error(`metadata path changed during pinned read: ${resolved}`), {
      code: "BOUNDED_FILE_CHANGED",
    });
  }
  return {
    raw,
    authority: {
      path: resolved,
      type: "file",
      generation: afterGeneration,
      sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      maxBytes,
      readKind,
    },
  };
}

function registerAuthority(authorities: AuthoritySink | undefined, authority: LocalPathAuthority) {
  if (!authorities) return;
  const existing = authorities.get(authority.path);
  if (existing && !samePathAuthority(existing, authority)) {
    throw authorityChanged("local migration input", authority.path);
  }
  authorities.set(authority.path, authority);
}

async function readJsonFilePinned(
  target: string,
  label: string,
  maxBytes = MAX_JSON_BYTES,
  readKind: MigrationMetadataReadKind = "local-json",
) {
  const pinned = await readPinnedMetadata(target, maxBytes, readKind);
  let value: unknown;
  try {
    value = JSON.parse(pinned.raw);
  } catch (error) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...pinned, value };
}

async function readJsonFile(
  target: string,
  label: string,
  maxBytes = MAX_JSON_BYTES,
  authorities?: AuthoritySink,
) {
  const pinned = await readJsonFilePinned(target, label, maxBytes, "local-json");
  registerAuthority(authorities, pinned.authority);
  return pinned.value;
}

function part(value: unknown) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function stateEnvelope(data: unknown, revision = 1) {
  return JSON.stringify({ revision, data });
}

async function captureDirectoryAuthority(target: string, label: string): Promise<DirectoryAuthority> {
  const resolved = path.resolve(target);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", `${label} must be a real directory`);
  }
  return { path: resolved, type: "directory", generation: pathGeneration(info) };
}

async function realDirectoryEntries(target: string, label: string, authorities?: AuthoritySink) {
  let before: DirectoryAuthority;
  try {
    before = await captureDirectoryAuthority(target, label);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
  const entries = await readdir(before.path, { withFileTypes: true });
  const after = await captureDirectoryAuthority(before.path, label);
  if (!samePathAuthority(before, after)) {
    throw authorityChanged(label, before.path);
  }
  registerAuthority(authorities, after);
  return entries;
}

async function readLocalRegistry(hubRoot: string, authorities: AuthoritySink) {
  const target = path.join(hubRoot, "projects.json");
  let rawRegistry: unknown;
  try {
    rawRegistry = await readJsonFile(target, "Hub project registry", MAX_JSON_BYTES, authorities);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    return {
      target,
      present: false,
      registry: { version: 1, revision: 0, updatedAt: new Date(0).toISOString(), projects: {} },
    };
  }
  const registry = record(rawRegistry, "Hub project registry");
  const projects = record(registry.projects || {}, "Hub project registry projects");
  const revision = Number(registry.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Hub project registry revision is invalid");
  }
  return { target, present: true, registry: { ...registry, projects, revision } };
}

async function readLocalQueue(hubRoot: string, authorities: AuthoritySink) {
  const target = path.join(hubRoot, "queue", "queue.json");
  let rawQueue: unknown;
  try {
    rawQueue = await readJsonFile(target, "Hub queue", MAX_JSON_BYTES, authorities);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
    const entries = await realDirectoryEntries(path.dirname(target), "Hub queue directory", authorities);
    if (entries.length > 0) {
      throw migrationError(
        "HUB_REDIS_MIGRATION_UNSAFE",
        `Hub queue directory contains state without queue.json: ${path.dirname(target)}`,
      );
    }
    return { target, present: false, queue: { version: 1, entries: [] as unknown[] } };
  }
  const queue = record(rawQueue, "Hub queue");
  if (queue.version !== 1 || !Array.isArray(queue.entries)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Hub queue envelope is invalid");
  }
  registerAuthority(authorities, await captureDirectoryAuthority(path.dirname(target), "Hub queue directory"));
  return { target, present: true, queue: { version: 1, entries: queue.entries } };
}

async function captureAssignments(
  hubRoot: string,
  fields: Array<[string, string]>,
  sourcePaths: Set<string>,
  authorities: AuthoritySink,
) {
  const root = path.join(hubRoot, "assignments");
  const entries = await realDirectoryEntries(root, "assignment store", authorities);
  let assignments = 0;
  let attempts = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith("a-")) continue;
    const assignmentRoot = path.join(root, entry.name);
    registerAuthority(authorities, await captureDirectoryAuthority(assignmentRoot, `assignment ${entry.name} root`));
    const statePath = path.join(assignmentRoot, "state.json");
    const state = record(
      await readJsonFile(statePath, `assignment ${entry.name}`, MAX_JSON_BYTES, authorities),
      `assignment ${entry.name}`,
    );
    if (state.assignmentId !== entry.name) {
      throw migrationError("HUB_REDIS_MIGRATION_INVALID", `assignment identity mismatch: ${entry.name}`);
    }
    const attemptRecords: Record<string, LooseRecord> = {};
    const attemptsRoot = path.join(assignmentRoot, "attempts");
    for (const attemptEntry of await realDirectoryEntries(attemptsRoot, `assignment ${entry.name} attempts`, authorities)) {
      if (!attemptEntry.isDirectory() || attemptEntry.isSymbolicLink() || !/^\d{3}$/.test(attemptEntry.name)) continue;
      const attemptRoot = path.join(attemptsRoot, attemptEntry.name);
      registerAuthority(
        authorities,
        await captureDirectoryAuthority(attemptRoot, `assignment ${entry.name} attempt ${attemptEntry.name} root`),
      );
      const attempt = record(
        await readJsonFile(
          path.join(attemptRoot, "attempt.json"),
          `assignment ${entry.name} attempt ${attemptEntry.name}`,
          MAX_JSON_BYTES,
          authorities,
        ),
        `assignment ${entry.name} attempt ${attemptEntry.name}`,
      );
      const attemptNumber = Number(attempt.attempt);
      if (attempt.assignmentId !== entry.name || !Number.isInteger(attemptNumber) || attemptNumber < 1) {
        throw migrationError("HUB_REDIS_MIGRATION_INVALID", `assignment attempt identity mismatch: ${entry.name}/${attemptEntry.name}`);
      }
      attemptRecords[String(attemptNumber)] = attempt;
      attempts += 1;
    }
    fields.push([
      `assignment:${part(entry.name)}`,
      stateEnvelope({ input: { ...state }, state, attempts: attemptRecords }),
    ]);
    assignments += 1;
  }
  if (entries.length > 0) sourcePaths.add(path.resolve(root));
  return { assignments, attempts, root };
}

async function captureWorkers(
  hubRoot: string,
  fields: Array<[string, string]>,
  sourcePaths: Set<string>,
  authorities: AuthoritySink,
) {
  const workersRoot = path.join(hubRoot, "workers");
  const registryRoot = path.join(workersRoot, "registry");
  const inboxRoot = path.join(workersRoot, "inbox");
  const workerRootEntries = await realDirectoryEntries(workersRoot, "worker store", authorities);
  let workers = 0;
  let inboxEntries = 0;
  for (const entry of await realDirectoryEntries(registryRoot, "worker registry", authorities)) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const worker = record(
      await readJsonFile(path.join(registryRoot, entry.name), `worker ${entry.name}`, MAX_JSON_BYTES, authorities),
      `worker ${entry.name}`,
    );
    const workerId = String(worker.workerId || "");
    if (!workerId || !worker.incarnationToken || !worker.status) {
      throw migrationError("HUB_REDIS_MIGRATION_INVALID", `worker record is incomplete: ${entry.name}`);
    }
    fields.push([`worker:${part(workerId)}`, stateEnvelope(worker)]);
    workers += 1;
  }
  for (const workerEntry of await realDirectoryEntries(inboxRoot, "worker inbox", authorities)) {
    if (!workerEntry.isDirectory() || workerEntry.isSymbolicLink()) continue;
    const workerId = workerEntry.name;
    const captureDir = async (directory: string) => {
      for (const entry of await realDirectoryEntries(directory, `worker ${workerId} inbox`, authorities)) {
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
        const file = path.join(directory, entry.name);
        const payload = record(
          await readJsonFile(file, `worker ${workerId} inbox ${entry.name}`, MAX_JSON_BYTES, authorities),
          `worker ${workerId} inbox ${entry.name}`,
        );
        const assignmentId = String(payload.assignmentId || entry.name.slice(0, -5));
        const attempt = Number(payload.attempt);
        const attemptToken = typeof payload.attemptToken === "string" ? payload.attemptToken : "";
        const suffix = `${part(workerId)}:${part(assignmentId)}`
          + `${Number.isInteger(attempt) && attempt > 0 ? `:${attempt}` : ""}`
          + `${attemptToken ? `:${part(attemptToken)}` : ""}`;
        const fileAuthority = authorities.get(path.resolve(file));
        if (!fileAuthority || fileAuthority.type !== "file") {
          throw migrationError("HUB_REDIS_MIGRATION_INVALID", `worker inbox authority is missing: ${file}`);
        }
        fields.push([`workerInbox:${suffix}`, stateEnvelope({
          workerId,
          assignmentId,
          status: "pending",
          payload,
          writtenAt: new Date(fileAuthority.generation.mtimeMs).toISOString(),
          migratedFromProcessing: path.basename(directory) === "processing",
        })]);
        inboxEntries += 1;
      }
    };
    const workerInbox = path.join(inboxRoot, workerId);
    await captureDir(workerInbox);
    await captureDir(path.join(workerInbox, "processing"));
  }
  if (workerRootEntries.length > 0) {
    registerAuthority(authorities, await captureDirectoryAuthority(workersRoot, "worker store"));
    sourcePaths.add(path.resolve(workersRoot));
  }
  return { workers, inboxEntries, root: workersRoot };
}

async function captureRuntimeRoot(
  dataRoot: string,
  fields: Array<[string, string]>,
  jobStreams: RedisLogicalSnapshot["jobStreams"],
  seenJobs: Map<string, string>,
  sourcePaths: Set<string>,
  authorities: AuthoritySink,
) {
  let leases = 0;
  let jobs = 0;
  let jobEvents = 0;
  const leasesRoot = path.join(dataRoot, "leases");
  const leaseEntries = await realDirectoryEntries(leasesRoot, `leases at ${dataRoot}`, authorities);
  for (const entry of leaseEntries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const leaseId = entry.name.slice(0, -5);
    const lease = record(
      await readJsonFile(path.join(leasesRoot, entry.name), `lease ${leaseId}`, MAX_JSON_BYTES, authorities),
      `lease ${leaseId}`,
    );
    if (lease.leaseId !== leaseId) throw migrationError("HUB_REDIS_MIGRATION_INVALID", `lease identity mismatch: ${leaseId}`);
    const expiresAtMs = Date.parse(String(lease.expiresAt || ""));
    fields.push([`lease:${part(leaseId)}`, stateEnvelope({ ...lease, expiresAtMs })]);
    leases += 1;
  }
  if (leaseEntries.length > 0) sourcePaths.add(path.resolve(leasesRoot));

  const eventsRoot = path.join(dataRoot, "events");
  const projectEntries = await realDirectoryEntries(eventsRoot, `events at ${dataRoot}`, authorities);
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink() || !SAFE_COMPONENT.test(projectEntry.name)) continue;
    for (const eventEntry of await realDirectoryEntries(
      path.join(eventsRoot, projectEntry.name),
      `events for ${projectEntry.name}`,
      authorities,
    )) {
      if (!eventEntry.isFile() || eventEntry.isSymbolicLink() || !eventEntry.name.endsWith(".jsonl")) continue;
      const jobId = eventEntry.name.slice(0, -".jsonl".length);
      if (!SAFE_COMPONENT.test(jobId)) continue;
      const file = path.join(eventsRoot, projectEntry.name, eventEntry.name);
      const pinned = await readPinnedMetadata(file, MAX_EVENT_LOG_BYTES, "local-event");
      registerAuthority(authorities, pinned.authority);
      const raw = pinned.raw;
      if (raw && !raw.endsWith("\n")) throw migrationError("HUB_REDIS_MIGRATION_INVALID", `job event log has a truncated tail: ${file}`);
      const events = raw.split("\n").filter(Boolean).map((line, index) => {
        try { return record(JSON.parse(line), `job event ${projectEntry.name}/${jobId}#${index + 1}`); }
        catch (error) { throw migrationError("HUB_REDIS_MIGRATION_INVALID", `invalid job event ${projectEntry.name}/${jobId}#${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
      });
      if (events.length === 0) continue;
      const projection = materializeJob(events as never[]);
      if (projection.project !== projectEntry.name || projection.jobId !== jobId || !projection.status) {
        throw migrationError("HUB_REDIS_MIGRATION_INVALID", `job projection identity mismatch: ${projectEntry.name}/${jobId}`);
      }
      const field = `job:${part(projectEntry.name)}:${part(jobId)}`;
      const serializedEvents = events.map((event) => JSON.stringify(event));
      const fingerprint = createHash("sha256").update(JSON.stringify(serializedEvents)).digest("hex");
      const prior = seenJobs.get(field);
      if (prior && prior !== fingerprint) {
        throw migrationError("HUB_REDIS_MIGRATION_CONFLICT", `duplicate job history differs across runtime roots: ${projectEntry.name}/${jobId}`);
      }
      if (prior) continue;
      seenJobs.set(field, fingerprint);
      fields.push([field, stateEnvelope(projection, events.length)]);
      jobStreams.push({ field, events: serializedEvents });
      jobs += 1;
      jobEvents += events.length;
    }
  }
  if (projectEntries.length > 0) sourcePaths.add(path.resolve(eventsRoot));
  return { leases, jobs, jobEvents };
}

async function assertCompleteAuthorityTree(sourcePath: string, authorities: AuthoritySink) {
  const source = path.resolve(sourcePath);
  const stack = [source];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const authority = authorities.get(current);
    if (!authority) {
      throw migrationError(
        "HUB_REDIS_MIGRATION_UNSAFE",
        `local retirement tree contains an unauthorised path: ${current}`,
      );
    }
    await repinPathAuthority(authority, "local retirement tree");
    if (authority.type !== "directory") continue;
    const entries = await readdir(current);
    await repinPathAuthority(authority, "local retirement tree");
    for (const entry of entries) {
      const child = path.join(current, entry);
      if (!authorities.has(child)) {
        throw migrationError(
          "HUB_REDIS_MIGRATION_UNSAFE",
          `local retirement tree contains an unauthorised path: ${child}`,
        );
      }
      stack.push(child);
    }
  }
}

export async function buildLocalRedisMigrationSnapshot(options: {
  cpbRoot: string;
  hubRoot: string;
  backendIdentityFingerprint: string;
}) {
  const cpbRoot = path.resolve(options.cpbRoot);
  const hubRoot = path.resolve(options.hubRoot);
  if (!/^[a-f0-9]{64}$/.test(options.backendIdentityFingerprint)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis backend identity fingerprint is invalid");
  }
  const fields: Array<[string, string]> = [];
  const jobStreams: RedisLogicalSnapshot["jobStreams"] = [];
  const sourcePaths = new Set<string>();
  const authorities: AuthoritySink = new Map();
  const { target: registryTarget, present: registryPresent, registry } = await readLocalRegistry(hubRoot, authorities);
  const projects = record(registry.projects, "Hub project registry projects");
  fields.push(["revision", String(registry.revision)], ["data", JSON.stringify(registry)]);
  if (registryPresent) sourcePaths.add(path.resolve(registryTarget));
  const { target: queueTarget, present: queuePresent, queue } = await readLocalQueue(hubRoot, authorities);
  fields.push(["queueRevision", "1"], ["queueData", JSON.stringify(queue)], ["leaderEpoch", "1"]);
  if (queuePresent) sourcePaths.add(path.resolve(path.dirname(queueTarget)));
  const assignmentCounts = await captureAssignments(hubRoot, fields, sourcePaths, authorities);
  const workerCounts = await captureWorkers(hubRoot, fields, sourcePaths, authorities);

  const runtimeRoots = new Set<string>();
  for (const project of Object.values(projects)) {
    const projectRecord = record(project, "Hub project");
    if (typeof projectRecord.projectRuntimeRoot === "string" && projectRecord.projectRuntimeRoot) {
      runtimeRoots.add(path.resolve(projectRecord.projectRuntimeRoot));
    }
  }
  const legacyRoot = path.join(cpbRoot, "cpb-task");
  try {
    registerAuthority(authorities, await captureDirectoryAuthority(legacyRoot, "legacy runtime root"));
    runtimeRoots.add(path.resolve(legacyRoot));
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
  const seenJobs = new Map<string, string>();
  let leases = 0;
  let jobs = 0;
  let jobEvents = 0;
  for (const dataRoot of [...runtimeRoots].sort()) {
    const counts = await captureRuntimeRoot(dataRoot, fields, jobStreams, seenJobs, sourcePaths, authorities);
    leases += counts.leases;
    jobs += counts.jobs;
    jobEvents += counts.jobEvents;
  }
  fields.sort(([left], [right]) => left.localeCompare(right));
  jobStreams.sort((left, right) => left.field.localeCompare(right.field));
  const capturedAt = new Date().toISOString();
  const body = {
    format: "cpb-hub-redis-logical-snapshot/v1" as const,
    backendIdentityFingerprint: options.backendIdentityFingerprint,
    capturedAt,
    hashFields: fields,
    jobStreams,
  };
  const snapshot: RedisLogicalSnapshot = {
    ...body,
    sha256: createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"),
  };
  const inventory: LocalRedisMigrationInventory = {
    projects: Object.keys(projects).length,
    queueEntries: queue.entries.length,
    assignments: assignmentCounts.assignments,
    attempts: assignmentCounts.attempts,
    workers: workerCounts.workers,
    inboxEntries: workerCounts.inboxEntries,
    leases,
    jobs,
    jobEvents,
    runtimeRoots: [...runtimeRoots].sort(),
    sourcePaths: [...sourcePaths].sort(),
  };
  assertNonOverlappingRetirementPaths(inventory.sourcePaths);
  for (const sourcePath of inventory.sourcePaths) {
    await assertCompleteAuthorityTree(sourcePath, authorities);
  }
  const localAuthorities = [...authorities.values()].sort((left, right) => left.path.localeCompare(right.path));
  return { snapshot, inventory, localAuthorities };
}

const MIGRATION_FORMAT = "cpb-hub-redis-migration/v1";
const SNAPSHOT_FILE = "redis-logical-snapshot.json";
const RESULT_FILE = "migration-result.json";

type MigrationJournal = {
  format: typeof MIGRATION_FORMAT;
  migrationId: string;
  operationToken: string;
  phase: "prepared" | "redis_committed";
  cpbRoot: string;
  hubRoot: string;
  output: string;
  outputParentAuthority: DirectoryAuthority;
  outputAuthority: DirectoryAuthority;
  backupPath: string;
  auditArchivePath: string | null;
  snapshotPath: string;
  snapshotSha256: string;
  snapshotAuthority: FileAuthority;
  backendIdentityFingerprint: string;
  inventory: LocalRedisMigrationInventory;
  localAuthorities: LocalPathAuthority[];
  createdAt: string;
  updatedAt: string;
  journalHmac: string;
};

export function hubRedisMigrationJournalPath(hubRoot: string) {
  const resolved = path.resolve(hubRoot);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.redis-migration.json`);
}

function businessState(value: RedisLogicalSnapshot) {
  return JSON.stringify({
    hashFields: value.hashFields.filter(([field]) => field !== "leaderEpoch"),
    jobStreams: value.jobStreams,
  });
}

function assertNonOverlappingRetirementPaths(sourcePaths: string[]) {
  for (let index = 0; index < sourcePaths.length; index += 1) {
    for (let other = index + 1; other < sourcePaths.length; other += 1) {
      const left = sourcePaths[index];
      const right = sourcePaths[other];
      if (childPath(left, right) || childPath(right, left)) {
        throw migrationError(
          "HUB_REDIS_MIGRATION_UNSAFE",
          `migration retirement paths overlap and cannot be isolated independently: ${left}, ${right}`,
        );
      }
    }
  }
}

function assertRetirementPaths(journal: MigrationJournal) {
  const allowed = new Set([
    path.join(journal.hubRoot, "projects.json"),
    path.join(journal.hubRoot, "queue"),
    path.join(journal.hubRoot, "assignments"),
    path.join(journal.hubRoot, "workers"),
    ...journal.inventory.runtimeRoots.flatMap((root) => [path.join(root, "leases"), path.join(root, "events")]),
  ].map((value) => path.resolve(value)));
  for (const source of journal.inventory.sourcePaths) {
    if (path.resolve(source) !== source || !allowed.has(source)) {
      throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", `migration journal contains an unsafe retirement path: ${source}`);
    }
    if (!journal.localAuthorities.some((authority) => authority.path === source)) {
      throw migrationError("HUB_REDIS_MIGRATION_INVALID", `migration journal lacks authority for retirement path: ${source}`);
    }
  }
  assertNonOverlappingRetirementPaths(journal.inventory.sourcePaths);
}

async function repinPathAuthorityAt(
  authority: LocalPathAuthority,
  observedPath: string,
  label: string,
  recoveryPaths: Record<string, string> = {},
  relocated = false,
) {
  const resolved = path.resolve(observedPath);
  try {
    if (authority.type === "file") {
      const pinned = await readPinnedMetadata(resolved, authority.maxBytes, authority.readKind);
      const generationMatches = relocated
        ? sameRelocatedGeneration(authority.generation, pinned.authority.generation)
        : samePathGeneration(authority.generation, pinned.authority.generation);
      if (!generationMatches || authority.sha256 !== pinned.authority.sha256) {
        throw authorityChanged(label, authority.path, recoveryPaths);
      }
      return;
    }
    const info = await lstat(resolved);
    const generation = pathGeneration(info);
    const generationMatches = relocated
      ? sameRelocatedGeneration(authority.generation, generation)
      : samePathGeneration(authority.generation, generation);
    if (!info.isDirectory() || info.isSymbolicLink() || !generationMatches) {
      throw authorityChanged(label, authority.path, recoveryPaths);
    }
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw authorityChanged(label, authority.path, recoveryPaths);
    throw error;
  }
}

async function repinPathAuthority(
  authority: LocalPathAuthority,
  label: string,
  recoveryPaths: Record<string, string> = {},
) {
  await repinPathAuthorityAt(authority, authority.path, label, recoveryPaths);
}

async function repinFileAuthority(
  authority: FileAuthority,
  label: string,
  recoveryPaths: Record<string, string> = {},
) {
  await repinPathAuthority(authority, label, recoveryPaths);
}

function childPath(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function sameOrChildPath(parent: string, candidate: string) {
  return parent === candidate || childPath(parent, candidate);
}

async function canonicalOutputPathAuthority(output: string, hubRoot: string) {
  const resolvedOutput = path.resolve(output);
  const parent = path.dirname(resolvedOutput);
  const [canonicalParent, canonicalHubRoot] = await Promise.all([
    realpath(parent),
    realpath(hubRoot),
  ]);
  const canonicalOutput = path.join(canonicalParent, path.basename(resolvedOutput));
  if (sameOrChildPath(canonicalHubRoot, canonicalOutput)) {
    throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", "migration output must be outside the Hub root");
  }
  const parentAuthority = await captureDirectoryAuthority(canonicalParent, "migration output parent directory");
  return { output: canonicalOutput, parent: canonicalParent, parentAuthority };
}

async function assertOutputDoesNotOverlapRetirement(output: string, sourcePaths: string[]) {
  for (const sourcePath of sourcePaths) {
    const canonicalSource = await realpath(sourcePath).catch(() => path.resolve(sourcePath));
    if (sameOrChildPath(canonicalSource, output) || sameOrChildPath(output, canonicalSource)) {
      throw migrationError(
        "HUB_REDIS_MIGRATION_UNSAFE",
        `migration output overlaps a local retirement authority: ${output}, ${canonicalSource}`,
      );
    }
  }
}

function assertJournalOutputDoesNotOverlapRetirement(output: string, sourcePaths: string[]) {
  for (const sourcePath of sourcePaths) {
    const canonicalSource = path.resolve(sourcePath);
    if (sameOrChildPath(canonicalSource, output) || sameOrChildPath(output, canonicalSource)) {
      throw migrationError(
        "HUB_REDIS_MIGRATION_UNSAFE",
        `Redis migration journal output overlaps a local retirement authority: ${output}, ${canonicalSource}`,
      );
    }
  }
}

async function repinOutputAuthority(
  authority: DirectoryAuthority,
  label: string,
  recoveryPaths: Record<string, string> = {},
) {
  try {
    const info = await lstat(authority.path);
    if (!info.isDirectory() || info.isSymbolicLink()
      || !sameDirectoryIdentity(authority.generation, pathGeneration(info))) {
      throw authorityChanged(label, authority.path, recoveryPaths);
    }
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw authorityChanged(label, authority.path, recoveryPaths);
    throw error;
  }
}

type MigrationOutputLineage = {
  parentAuthority: DirectoryAuthority;
  outputAuthority: DirectoryAuthority;
};

async function repinCanonicalOutputAuthority(
  authority: DirectoryAuthority,
  label: string,
  recoveryPaths: Record<string, string> = {},
) {
  await repinOutputAuthority(authority, label, recoveryPaths);
  let canonical: string;
  try {
    canonical = await realpath(authority.path);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw authorityChanged(label, authority.path, recoveryPaths);
    throw error;
  }
  if (canonical !== authority.path) throw authorityChanged(label, authority.path, recoveryPaths);
  await repinOutputAuthority(authority, label, recoveryPaths);
}

async function repinOutputLineage(
  lineage: MigrationOutputLineage,
  recoveryPaths: Record<string, string> = {},
) {
  if (path.dirname(lineage.outputAuthority.path) !== lineage.parentAuthority.path) {
    throw authorityChanged("migration output lineage", lineage.outputAuthority.path, recoveryPaths);
  }
  await repinCanonicalOutputAuthority(
    lineage.parentAuthority,
    "migration output parent directory",
    recoveryPaths,
  );
  await repinCanonicalOutputAuthority(
    lineage.outputAuthority,
    "migration output directory",
    recoveryPaths,
  );
}

async function prepareMigrationOutput(
  output: string,
  parent: string,
  parentAuthority: DirectoryAuthority,
) {
  await repinCanonicalOutputAuthority(parentAuthority, "migration output parent directory");
  if (await exists(output)) {
    throw migrationError("HUB_REDIS_MIGRATION_OUTPUT_EXISTS", "migration output already exists");
  }
  await repinCanonicalOutputAuthority(parentAuthority, "migration output parent directory");
  await mkdir(output, { mode: 0o700 });
  const outputAuthority = await captureDirectoryAuthority(output, "migration output directory");
  const lineage = { parentAuthority, outputAuthority };
  await migrationTestHooks().afterOutputDirectoryMkdir?.({ output, parent });
  await repinOutputLineage(lineage);
  try {
    await syncMigrationDirectory(parent, "migration-output-mkdir");
  } catch (error) {
    throw committedDurabilityAmbiguity(
      `migration output was created but parent durability is ambiguous: ${output}`,
      output,
      { output },
      error,
    );
  }
  await repinOutputLineage(lineage);
  return lineage;
}

function authoritiesForSource(journal: MigrationJournal, sourcePath: string) {
  return journal.localAuthorities.filter((authority) => (
    authority.path === sourcePath || childPath(sourcePath, authority.path)
  ));
}

function isolationPaths(sourcePath: string, operationToken: string) {
  const parent = path.dirname(sourcePath);
  const basename = path.basename(sourcePath).slice(0, 48) || "authority";
  const sourceDigest = createHash("sha256").update(sourcePath, "utf8").digest("hex").slice(0, 12);
  const isolationRoot = path.join(parent, `.${basename}.cpb-redis-migration-${sourceDigest}-${operationToken}`);
  return { isolationRoot, quarantinePath: path.join(isolationRoot, "authority") };
}

async function validateRelocatedAuthorities(
  sourcePath: string,
  quarantinePath: string,
  authorities: LocalPathAuthority[],
  recoveryPaths: Record<string, string>,
) {
  const authorityPaths = new Set(authorities.map((authority) => authority.path));
  for (const authority of authorities) {
    const relative = path.relative(sourcePath, authority.path);
    const relocatedPath = relative === "" ? quarantinePath : path.join(quarantinePath, relative);
    await repinPathAuthorityAt(
      authority,
      relocatedPath,
      "isolated local migration",
      recoveryPaths,
      relative === "",
    );
    if (authority.type === "directory") {
      const entries = await readdir(relocatedPath);
      for (const entry of entries) {
        if (!authorityPaths.has(path.join(authority.path, entry))) {
          throw authorityChanged("isolated local migration", authority.path, recoveryPaths);
        }
      }
    }
  }
}

async function prepareIsolationRoot(
  isolationRoot: string,
  quarantinePath: string,
  recoveryPaths: Record<string, string>,
) {
  await captureDirectoryAuthority(path.dirname(isolationRoot), "migration isolation parent directory");
  let created = false;
  try {
    await mkdir(isolationRoot, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    const info = await lstat(isolationRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw authorityChanged("migration isolation directory", isolationRoot, recoveryPaths);
    }
  }
  if (created) {
    try {
      await syncMigrationDirectory(path.dirname(isolationRoot), "retirement-isolation-root");
    } catch (error) {
      throw committedDurabilityAmbiguity(
        `migration isolation directory was created but parent durability is ambiguous: ${isolationRoot}`,
        isolationRoot,
        recoveryPaths,
        error,
      );
    }
    return;
  }
  const entries = await readdir(isolationRoot);
  if (entries.some((entry) => entry !== path.basename(quarantinePath))) {
    throw authorityChanged("migration isolation directory", isolationRoot, recoveryPaths);
  }
}

async function isolateAuthority(
  sourcePath: string,
  rootAuthority: LocalPathAuthority,
  relatedAuthorities: LocalPathAuthority[],
  operationToken: string,
  operation: string,
  recoveryPaths: Record<string, string>,
) {
  const { isolationRoot, quarantinePath } = isolationPaths(sourcePath, operationToken);
  const contextualRecoveryPaths = {
    ...recoveryPaths,
    canonical: sourcePath,
    isolationRoot,
    isolatedAuthority: quarantinePath,
  };
  await prepareIsolationRoot(isolationRoot, quarantinePath, contextualRecoveryPaths);

  if (await exists(quarantinePath)) {
    try {
      await validateRelocatedAuthorities(sourcePath, quarantinePath, relatedAuthorities, contextualRecoveryPaths);
    } catch (error) {
      throw authorityChanged("isolated local migration", sourcePath, {
        ...contextualRecoveryPaths,
        preservedSuccessor: quarantinePath,
      }, {
        committed: true,
        committedPath: quarantinePath,
        successorPreserved: true,
        cause: error,
      });
    }
    if (await exists(sourcePath)) {
      throw successorPreserved(
        `a canonical successor appeared after local migration authority isolation: ${sourcePath}`,
        quarantinePath,
        { ...contextualRecoveryPaths, successor: sourcePath },
      );
    }
    return { sourcePath, isolationRoot, quarantinePath, relatedAuthorities, recoveryPaths: contextualRecoveryPaths };
  }

  if (!await exists(sourcePath)) {
    await rmdir(isolationRoot).catch(() => undefined);
    return null;
  }
  for (const authority of relatedAuthorities) {
    await repinPathAuthority(authority, "local migration retirement", contextualRecoveryPaths);
  }
  await repinPathAuthority(rootAuthority, "local migration retirement", contextualRecoveryPaths);
  await migrationTestHooks().beforeAuthorityIsolation?.({
    sourcePath,
    isolationRoot,
    quarantinePath,
    operation,
  });
  try {
    await rename(sourcePath, quarantinePath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw authorityChanged("local migration retirement", sourcePath, contextualRecoveryPaths);
    }
    throw error;
  }
  try {
    await validateRelocatedAuthorities(sourcePath, quarantinePath, relatedAuthorities, contextualRecoveryPaths);
  } catch (error) {
    throw authorityChanged("local migration retirement", sourcePath, {
      ...contextualRecoveryPaths,
      preservedSuccessor: quarantinePath,
    }, {
      committed: true,
      committedPath: quarantinePath,
      successorPreserved: true,
      cause: error,
    });
  }
  try {
    await syncMigrationDirectory(path.dirname(sourcePath), "retirement-isolate");
  } catch (error) {
    throw committedDurabilityAmbiguity(
      `local migration authority was isolated but parent durability is ambiguous: ${sourcePath}`,
      quarantinePath,
      contextualRecoveryPaths,
      error,
    );
  }
  await migrationTestHooks().afterAuthorityIsolation?.({
    sourcePath,
    isolationRoot,
    quarantinePath,
    operation,
  });
  if (await exists(sourcePath)) {
    throw successorPreserved(
      `a canonical successor appeared after local migration authority isolation: ${sourcePath}`,
      quarantinePath,
      { ...contextualRecoveryPaths, successor: sourcePath },
    );
  }
  return { sourcePath, isolationRoot, quarantinePath, relatedAuthorities, recoveryPaths: contextualRecoveryPaths };
}

async function preserveIsolatedAuthority(isolated: NonNullable<Awaited<ReturnType<typeof isolateAuthority>>>) {
  try {
    await validateRelocatedAuthorities(
      isolated.sourcePath,
      isolated.quarantinePath,
      isolated.relatedAuthorities,
      isolated.recoveryPaths,
    );
  } catch (error) {
    throw authorityChanged("isolated local migration", isolated.sourcePath, {
      ...isolated.recoveryPaths,
      preservedSuccessor: isolated.quarantinePath,
    }, {
      committed: true,
      committedPath: isolated.quarantinePath,
      successorPreserved: true,
      cause: error,
    });
  }
  try {
    await syncMigrationDirectory(isolated.isolationRoot, "retirement-preserve");
  } catch (error) {
    throw committedDurabilityAmbiguity(
      `local migration authority was preserved but isolation durability is ambiguous: ${isolated.sourcePath}`,
      isolated.quarantinePath,
      {
        ...isolated.recoveryPaths,
        preservedAuthority: isolated.quarantinePath,
        deletedCanonical: isolated.sourcePath,
      },
      error,
    );
  }
  try {
    await syncMigrationDirectory(path.dirname(isolated.isolationRoot), "retirement-preserve-parent");
  } catch (error) {
    throw committedDurabilityAmbiguity(
      `local migration authority preservation committed but parent durability is ambiguous: ${isolated.sourcePath}`,
      isolated.quarantinePath,
      {
        ...isolated.recoveryPaths,
        preservedAuthority: isolated.quarantinePath,
        deletedCanonical: isolated.sourcePath,
      },
      error,
    );
  }
}

async function isolateAndPreserveAuthority(
  sourcePath: string,
  rootAuthority: LocalPathAuthority,
  relatedAuthorities: LocalPathAuthority[],
  operationToken: string,
  operation: string,
  recoveryPaths: Record<string, string>,
) {
  const isolated = await isolateAuthority(
    sourcePath,
    rootAuthority,
    relatedAuthorities,
    operationToken,
    operation,
    recoveryPaths,
  );
  if (!isolated) return false;
  await preserveIsolatedAuthority(isolated);
  if (await exists(sourcePath)) {
    throw successorPreserved(
      `a canonical successor appeared during local migration authority preservation: ${sourcePath}`,
      isolated.quarantinePath,
      { ...isolated.recoveryPaths, successor: sourcePath, preservedAuthority: isolated.quarantinePath },
    );
  }
  return true;
}

export async function _internalReadMigrationMetadataForTests(
  target: string,
  readKind: MigrationMetadataReadKind,
  maxBytes: number,
) {
  return readJsonFilePinned(target, `Redis migration ${readKind}`, maxBytes, readKind);
}

export async function _internalRepinMigrationMetadataForTests(authority: FileAuthority, label: string) {
  await repinFileAuthority(authority, label);
}

const migrationTestAuthoritySets = new WeakMap<LocalPathAuthority, LocalPathAuthority[]>();

export async function _internalCaptureMigrationPathAuthorityForTests(target: string) {
  const resolved = path.resolve(target);
  const authorities: LocalPathAuthority[] = [];
  const stack = [resolved];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const info = await lstat(current);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      const authority = await captureDirectoryAuthority(current, "migration test authority");
      authorities.push(authority);
      const entries = await readdir(current);
      for (const entry of entries) stack.push(path.join(current, entry));
      continue;
    }
    const pinned = await readPinnedMetadata(current, MAX_JSON_BYTES, "local-json");
    authorities.push(pinned.authority);
  }
  const rootAuthority = authorities.find((authority) => authority.path === resolved);
  if (!rootAuthority) throw migrationError("HUB_REDIS_MIGRATION_INVALID", `test authority is missing: ${resolved}`);
  migrationTestAuthoritySets.set(rootAuthority, authorities);
  return rootAuthority;
}

export async function _internalRetireMigrationPathForTests(
  sourcePath: string,
  authority: LocalPathAuthority,
) {
  return isolateAndPreserveAuthority(
    path.resolve(sourcePath),
    authority,
    migrationTestAuthoritySets.get(authority) || [authority],
    randomUUID(),
    "retirement",
    { testRoot: path.dirname(path.resolve(sourcePath)) },
  );
}

async function validateLocalAuthorities(journal: MigrationJournal, recoveryPaths: Record<string, string>) {
  for (const authority of journal.localAuthorities) {
    await repinPathAuthority(authority, "local migration input", recoveryPaths);
  }
}

async function assertPostCommitMetadataAuthorities(
  journalAuthority: FileAuthority,
  snapshotAuthority: FileAuthority,
  recoveryPaths: Record<string, string>,
) {
  try {
    await repinFileAuthority(journalAuthority, "migration journal", recoveryPaths);
    await repinFileAuthority(snapshotAuthority, "migration snapshot", recoveryPaths);
  } catch (error) {
    throw Object.assign(new Error("Redis migration committed, but its local authorization metadata changed", {
      cause: error,
    }), {
      code: "HUB_REDIS_MIGRATION_REDIS_COMMITTED_AUTHORITY_CHANGED",
      committed: true,
      committedPath: null,
      redisCommitted: true,
      recoveryPaths,
    });
  }
}

async function retireLocalAuthority(
  journal: MigrationJournal,
  journalAuthority: FileAuthority,
  snapshotAuthority: FileAuthority,
  recoveryPaths: Record<string, string>,
) {
  assertRetirementPaths(journal);
  for (const source of [...journal.inventory.sourcePaths].sort((left, right) => right.length - left.length)) {
    await repinFileAuthority(journalAuthority, "migration journal", recoveryPaths);
    await repinFileAuthority(snapshotAuthority, "migration snapshot", recoveryPaths);
    const rootAuthority = journal.localAuthorities.find((authority) => authority.path === source);
    if (!rootAuthority) throw migrationError("HUB_REDIS_MIGRATION_INVALID", `missing retirement authority: ${source}`);
    const relatedAuthorities = authoritiesForSource(journal, source);
    await isolateAndPreserveAuthority(
      source,
      rootAuthority,
      relatedAuthorities,
      journal.operationToken,
      "retirement",
      recoveryPaths,
    );
  }
  for (const source of journal.inventory.sourcePaths) {
    if (await exists(source)) {
      throw successorPreserved(
        `a canonical successor appeared after local migration retirement: ${source}`,
        null,
        { ...recoveryPaths, successor: source, deletedCanonical: source },
      );
    }
  }
}

function migrationJournalPayload(journal: Omit<MigrationJournal, "journalHmac"> | MigrationJournal) {
  const { journalHmac: _journalHmac, ...payload } = journal as MigrationJournal;
  return JSON.stringify(payload);
}

function signMigrationJournal(journal: Omit<MigrationJournal, "journalHmac">, signingKey: string): MigrationJournal {
  return {
    ...journal,
    journalHmac: createHmac("sha256", signingKey).update(migrationJournalPayload(journal), "utf8").digest("hex"),
  };
}

function verifyMigrationJournalHmac(journal: LooseRecord, signingKey: string) {
  const actual = typeof journal.journalHmac === "string" && /^[a-f0-9]{64}$/.test(journal.journalHmac)
    ? Buffer.from(journal.journalHmac, "hex")
    : Buffer.alloc(0);
  const expected = createHmac("sha256", signingKey)
    .update(migrationJournalPayload(journal as unknown as MigrationJournal), "utf8")
    .digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw migrationError("HUB_REDIS_MIGRATION_AUTHENTICATION_FAILED", "Redis migration journal authentication failed");
  }
}

async function writeJsonOnceDurable(
  filePath: string,
  value: unknown,
  operation: string,
  maxBytes: number,
  recoveryPaths: Record<string, string>,
  commitContext?: MigrationCommitContext,
  outputLineage?: MigrationOutputLineage,
) {
  const resolved = path.resolve(filePath);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw migrationError("HUB_REDIS_MIGRATION_TOO_LARGE", `${operation} exceeds ${maxBytes} bytes`);
    }
    const parent = path.dirname(resolved);
    if (outputLineage) await repinOutputLineage(outputLineage, recoveryPaths);
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", `${operation} parent must be a real directory: ${parent}`);
    }
    if (typeof constants.O_NOFOLLOW !== "number") {
      throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", `no-follow writes are unavailable for ${operation}`);
    }
    const tempPath = path.join(parent, `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`);
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await link(tempPath, resolved);
    } catch (error) {
      if (errnoCode(error) === "EEXIST") {
        throw migrationFsMutationError(Object.assign(new Error(`${operation} successor was preserved: ${resolved}`, { cause: error }), {
          code: "HUB_REDIS_MIGRATION_SUCCESSOR_PRESERVED",
          committed: false,
          committedPath: null,
          successorPreserved: true,
          recoveryPaths: { ...recoveryPaths, successor: resolved },
        }));
      }
      throw error;
    }
    await migrationTestHooks().afterMigrationArtifactPublish?.({ filePath: resolved, operation });
    if (outputLineage) await repinOutputLineage(outputLineage, recoveryPaths);
    try {
      await syncMigrationDirectory(parent, `${operation}-publish`);
    } catch (error) {
      throw committedDurabilityAmbiguity(
        `${operation} was published but parent durability is ambiguous: ${resolved}`,
        resolved,
        { ...recoveryPaths, published: resolved },
        error,
      );
    }
    if (outputLineage) await repinOutputLineage(outputLineage, recoveryPaths);
  } catch (error) {
    if (commitContext?.redisCommitted) throw redisCommittedFailure(error, commitContext);
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

export async function _internalWriteMigrationJsonOnceForTests(
  filePath: string,
  value: unknown,
  operation = "migration-test-artifact",
  outputLineage?: MigrationOutputLineage,
) {
  await writeJsonOnceDurable(
    filePath,
    value,
    operation,
    MAX_MIGRATION_RESULT_BYTES,
    { artifact: path.resolve(filePath) },
    undefined,
    outputLineage,
  );
}

export async function _internalPrepareMigrationOutputForTests(output: string, hubRoot: string) {
  const authority = await canonicalOutputPathAuthority(output, hubRoot);
  return await prepareMigrationOutput(
    authority.output,
    authority.parent,
    authority.parentAuthority,
  );
}

export async function _internalMigrationCommitContextTransplantProbeForTests() {
  const contextA: MigrationCommitContext = {
    redisCommitted: true,
    commitMayHaveOccurred: false,
    recoveryPaths: Object.freeze({
      output: "/canonical/a/output",
      snapshot: "/canonical/a/snapshot",
      journal: "/canonical/a/journal",
      backup: "/canonical/a/backup",
      result: "/canonical/a/result",
    }),
  };
  const contextB: MigrationCommitContext = {
    redisCommitted: true,
    commitMayHaveOccurred: false,
    recoveryPaths: Object.freeze({
      output: "/canonical/b/output",
      snapshot: "/canonical/b/snapshot",
      journal: "/canonical/b/journal",
      backup: "/canonical/b/backup",
      result: "/canonical/b/result",
    }),
  };
  let fromA: unknown;
  try {
    await runAfterRedisCommit(contextA, async () => {
      throw successorPreserved(
        "migration A successor",
        "/canonical/a/committed",
        { ...contextA.recoveryPaths, successor: "/canonical/a/successor" },
      );
    });
  } catch (error) {
    fromA = error;
  }
  return {
    fromA,
    reboundForB: redisCommittedFailure(fromA, contextB),
  };
}

export function _internalMigrationCommitOutcomeUnknownProbeForTests() {
  const context: MigrationCommitContext = {
    redisCommitted: false,
    commitMayHaveOccurred: true,
    recoveryPaths: Object.freeze({
      output: "/canonical/unknown/output",
      snapshot: "/canonical/unknown/snapshot",
      journal: "/canonical/unknown/journal",
      backup: "/canonical/unknown/backup",
      result: "/canonical/unknown/result",
    }),
  };
  const underlying = Object.assign(new Error("Redis restore commit response was lost"), {
    code: "HUB_STATE_BACKEND_UNAVAILABLE",
    commitOutcome: "unknown",
    commitMayHaveOccurred: true,
    committed: true,
    committedPath: "/poisoned/committed-path",
    successorPreserved: true,
    recoveryPaths: { output: "/poisoned/output" },
    redisCommitRecovery: Object.freeze({
      registryKey: "cpb:{unit}:registry",
      stageRegistryKey: "cpb:{unit}:restore:probe:registry",
      stageStreamKeys: Object.freeze([]),
      backendIdentityFingerprint: "a".repeat(64),
      snapshotSha256: "b".repeat(64),
    }),
  });
  return redisCommitOutcomeUnknownFailure(underlying, context);
}

async function removePinnedAuthority(
  authority: LocalPathAuthority,
  operationToken: string,
  operation: string,
  recoveryPaths: Record<string, string>,
) {
  return isolateAndPreserveAuthority(
    authority.path,
    authority,
    [authority],
    operationToken,
    operation,
    recoveryPaths,
  );
}

async function commitMigration(
  backend: NonNullable<Awaited<ReturnType<typeof openHubRedisStateBackend>>>,
  snapshot: RedisLogicalSnapshot,
  operation: string,
  validateBeforeRestore: () => Promise<void>,
  commitContext: MigrationCommitContext,
) {
  const token = `migration-${randomUUID()}`;
  const acquired = await backend.acquireMaintenance(token, operation, 3_600_000);
  if (!acquired.acquired) throw migrationError("HUB_MAINTENANCE_ACTIVE", "another Redis maintenance operation is active");
  try {
    const current = await backend.exportSnapshot(token);
    const currentBusiness = businessState(current);
    const targetBusiness = businessState(snapshot);
    const empty = current.hashFields.every(([field]) => field === "leaderEpoch") && current.jobStreams.length === 0;
    if (currentBusiness !== targetBusiness && !empty) {
      throw migrationError("HUB_REDIS_MIGRATION_TARGET_NOT_EMPTY", "Redis business authority is neither empty nor the prepared migration snapshot");
    }
    const alreadyCommitted = currentBusiness === targetBusiness;
    if (!alreadyCommitted) await validateBeforeRestore();
    if (alreadyCommitted) commitContext.redisCommitted = true;
    let restored = current;
    if (!alreadyCommitted) {
      try {
        restored = await backend.restoreSnapshot(token, snapshot);
      } catch (error) {
        const outcome = redisRestoreCommitOutcome(error, {
          registryKey: backend.registryKey,
          backendIdentityFingerprint: backend.identityFingerprint,
          snapshotSha256: snapshot.sha256,
          operationToken: token,
        });
        if (outcome === "committed") commitContext.redisCommitted = true;
        if (outcome === "unknown") {
          commitContext.commitMayHaveOccurred = true;
          throw redisCommitOutcomeUnknownFailure(error, commitContext);
        }
        throw error;
      }
      commitContext.redisCommitted = true;
      await migrationTestHooks().afterRedisRestoreCommitBoundary?.({ operation });
    }
    if (businessState(restored) !== targetBusiness) {
      throw migrationError("HUB_REDIS_MIGRATION_VERIFY_FAILED", "Redis business authority does not match the prepared migration snapshot");
    }
    return { snapshot: restored, alreadyCommitted };
  } catch (error) {
    if (commitContext.redisCommitted || commitContext.commitMayHaveOccurred) {
      throw redisOutcomeFailure(error, commitContext);
    }
    throw error;
  } finally {
    try {
      await migrationTestHooks().beforeRedisMaintenanceFinalize?.({ operation });
      const status = await backend.readMaintenance();
      if (status.active && status.token === token) await backend.releaseMaintenance(token);
    } catch (error) {
      if (commitContext.redisCommitted || commitContext.commitMayHaveOccurred) {
        throw redisOutcomeFailure(error, commitContext);
      }
      throw error;
    }
  }
}

export async function migrateLocalHubToRedis(options: {
  cpbRoot: string;
  hubRoot: string;
  configFile: string;
  output: string;
  dryRun?: boolean;
  backupSigningKey?: string;
  auditSigningKey?: string;
  afterRedisCommit?: () => Promise<void>;
}) {
  const cpbRoot = path.resolve(options.cpbRoot);
  const hubRoot = path.resolve(options.hubRoot);
  const outputPathAuthority = await canonicalOutputPathAuthority(options.output, hubRoot);
  const { output, parent: outputParent, parentAuthority: outputParentAuthority } = outputPathAuthority;
  const journalPath = hubRedisMigrationJournalPath(hubRoot);
  if (await exists(journalPath)) {
    throw migrationError("HUB_REDIS_MIGRATION_RECOVERY_REQUIRED", `recover the interrupted Redis migration first: ${journalPath}`);
  }
  const backend = await openHubRedisStateBackend({ configFile: options.configFile, hubRoot });
  if (!backend) throw migrationError("HUB_REDIS_MIGRATION_CONFIG_REQUIRED", "Redis migration requires a state backend config file");
  await backend.preflight();
  const preview = await buildLocalRedisMigrationSnapshot({
    cpbRoot, hubRoot, backendIdentityFingerprint: backend.identityFingerprint,
  });
  await assertOutputDoesNotOverlapRetirement(output, preview.inventory.sourcePaths);
  if (options.dryRun !== false) return { dryRun: true as const, ...preview.inventory };
  if (!options.backupSigningKey) {
    throw migrationError("HUB_REDIS_MIGRATION_SIGNING_KEY_REQUIRED", "CPB_HUB_BACKUP_SIGNING_KEY is required for the migration rollback backup");
  }
  const outputLineage = await prepareMigrationOutput(output, outputParent, outputParentAuthority);
  const { outputAuthority } = outputLineage;

  const { inspectHubAccessAuditUsage } = await import("../audit/hub-access-audit.js");
  const { createHubAccessAuditArchive } = await import("../audit/hub-access-audit-archive.js");
  await repinOutputLineage(outputLineage);
  const auditUsage = await inspectHubAccessAuditUsage({ hubRoot });
  let auditArchivePath: string | null = null;
  if (auditUsage.sizeBytes > 0) {
    if (!options.auditSigningKey) {
      throw migrationError("HUB_REDIS_MIGRATION_SIGNING_KEY_REQUIRED", "CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY is required to archive the local audit chain");
    }
    auditArchivePath = path.join(output, "local-access-audit");
    await createHubAccessAuditArchive({
      hubRoot,
      output: auditArchivePath,
      signingKey: options.auditSigningKey,
    });
    await repinOutputLineage(outputLineage, { output, auditArchive: auditArchivePath });
  }

  const maintenance = await acquireHubMaintenance(hubRoot, "Hub local-to-Redis migration");
  let commitContext: MigrationCommitContext | null = null;
  try {
    const { createHubBackupUnlocked } = await import("./hub-backup.js");
    const backupPath = path.join(output, "hub-backup");
    await repinOutputLineage(outputLineage, { output, backup: backupPath });
    await createHubBackupUnlocked({
      cpbRoot,
      hubRoot,
      output: backupPath,
      signingKey: options.backupSigningKey,
      redisBackend: null,
      localOnly: true,
    });
    await repinOutputLineage(outputLineage, { output, backup: backupPath });
    const prepared = await buildLocalRedisMigrationSnapshot({
      cpbRoot, hubRoot, backendIdentityFingerprint: backend.identityFingerprint,
    });
    await assertOutputDoesNotOverlapRetirement(output, prepared.inventory.sourcePaths);
    const snapshotPath = path.join(output, SNAPSHOT_FILE);
    const baseRecoveryPaths = { output, snapshot: snapshotPath, journal: journalPath, backup: backupPath };
    const resultPath = path.join(output, RESULT_FILE);
    const activeCommitContext: MigrationCommitContext = {
      redisCommitted: false,
      commitMayHaveOccurred: false,
      recoveryPaths: Object.freeze({ ...baseRecoveryPaths, result: resultPath }),
    };
    commitContext = activeCommitContext;
    await writeJsonOnceDurable(
      snapshotPath,
      prepared.snapshot,
      "migration-snapshot",
      MAX_MIGRATION_SNAPSHOT_BYTES,
      baseRecoveryPaths,
      undefined,
      outputLineage,
    );
    const pinnedSnapshot = await readJsonFilePinned(
      snapshotPath,
      "Redis migration snapshot",
      MAX_MIGRATION_SNAPSHOT_BYTES,
      "snapshot",
    );
    const persistedSnapshot = validateMigrationSnapshot(
      pinnedSnapshot.value,
      backend.identityFingerprint,
      prepared.snapshot.sha256,
    );
    const now = new Date().toISOString();
    const unsignedJournal: Omit<MigrationJournal, "journalHmac"> = {
      format: MIGRATION_FORMAT,
      migrationId: randomUUID(),
      operationToken: randomUUID(),
      phase: "prepared",
      cpbRoot,
      hubRoot,
      output,
      outputParentAuthority,
      outputAuthority,
      backupPath,
      auditArchivePath,
      snapshotPath,
      snapshotSha256: prepared.snapshot.sha256,
      snapshotAuthority: pinnedSnapshot.authority,
      backendIdentityFingerprint: backend.identityFingerprint,
      inventory: prepared.inventory,
      localAuthorities: prepared.localAuthorities,
      createdAt: now,
      updatedAt: now,
    };
    const journal = signMigrationJournal(unsignedJournal, options.backupSigningKey);
    await writeJsonOnceDurable(
      journalPath,
      journal,
      "migration-journal",
      MAX_MIGRATION_JOURNAL_BYTES,
      baseRecoveryPaths,
      undefined,
      outputLineage,
    );
    const pinnedJournal = await readJsonFilePinned(
      journalPath,
      "Redis migration journal",
      MAX_MIGRATION_JOURNAL_BYTES,
      "journal",
    );
    const persistedJournal = migrationJournal(pinnedJournal.value, hubRoot, options.backupSigningKey);
    await repinFileAuthority(pinnedJournal.authority, "migration journal", baseRecoveryPaths);
    await repinFileAuthority(pinnedSnapshot.authority, "migration snapshot", baseRecoveryPaths);
    await commitMigration(backend, persistedSnapshot, "Hub local-to-Redis migration", async () => {
      await repinFileAuthority(pinnedJournal.authority, "migration journal", baseRecoveryPaths);
      await repinFileAuthority(pinnedSnapshot.authority, "migration snapshot", baseRecoveryPaths);
      await repinOutputLineage(outputLineage, baseRecoveryPaths);
      await validateLocalAuthorities(persistedJournal, baseRecoveryPaths);
    }, activeCommitContext);
    return await runAfterRedisCommit(activeCommitContext, async () => {
      await assertPostCommitMetadataAuthorities(
        pinnedJournal.authority,
        pinnedSnapshot.authority,
        activeCommitContext.recoveryPaths,
      );
      await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      await options.afterRedisCommit?.();
      await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      await assertPostCommitMetadataAuthorities(
        pinnedJournal.authority,
        pinnedSnapshot.authority,
        activeCommitContext.recoveryPaths,
      );
      await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      await retireLocalAuthority(
        persistedJournal,
        pinnedJournal.authority,
        pinnedSnapshot.authority,
        activeCommitContext.recoveryPaths,
      );
      await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      const result = {
        format: MIGRATION_FORMAT,
        migrationId: persistedJournal.migrationId,
        completedAt: new Date().toISOString(),
        backendIdentityFingerprint: backend.identityFingerprint,
        backupPath,
        auditArchivePath,
        snapshotSha256: prepared.snapshot.sha256,
        inventory: prepared.inventory,
      };
      await writeJsonOnceDurable(
        resultPath,
        result,
        "migration-result",
        MAX_MIGRATION_RESULT_BYTES,
        activeCommitContext.recoveryPaths,
        activeCommitContext,
        outputLineage,
      );
      await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      await removePinnedAuthority(
        pinnedJournal.authority,
        persistedJournal.operationToken,
        "journal-remove",
        activeCommitContext.recoveryPaths,
      );
      await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      return { dryRun: false as const, output, ...result };
    });
  } finally {
    try {
      if (!(await maintenance.release())) {
        throw migrationError("HUB_MAINTENANCE_INVALID", `migration lost local maintenance lock ownership: ${maintenance.lockPath}`);
      }
    } catch (error) {
      if (commitContext && (commitContext.redisCommitted || commitContext.commitMayHaveOccurred)) {
        throw redisOutcomeFailure(error, commitContext);
      }
      throw error;
    }
  }
}

function parsedGeneration(value: unknown, label: string): PathGeneration {
  const raw = record(value, `${label} generation`);
  const fields = ["dev", "ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"] as const;
  for (const field of fields) {
    if (typeof raw[field] !== "number" || !Number.isFinite(raw[field]) || Number(raw[field]) < 0) {
      throw migrationError("HUB_REDIS_MIGRATION_INVALID", `${label} generation ${field} is invalid`);
    }
  }
  return Object.fromEntries(fields.map((field) => [field, Number(raw[field])])) as PathGeneration;
}

function maxBytesForReadKind(readKind: MigrationMetadataReadKind) {
  if (readKind === "local-json") return MAX_JSON_BYTES;
  if (readKind === "local-event") return MAX_EVENT_LOG_BYTES;
  if (readKind === "journal") return MAX_MIGRATION_JOURNAL_BYTES;
  if (readKind === "snapshot") return MAX_MIGRATION_SNAPSHOT_BYTES;
  return MAX_MIGRATION_RESULT_BYTES;
}

function parsedPathAuthority(value: unknown, label: string): LocalPathAuthority {
  const raw = record(value, label);
  const authorityPath = typeof raw.path === "string" ? raw.path : "";
  if (!authorityPath || path.resolve(authorityPath) !== authorityPath) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", `${label} path is invalid`);
  }
  const generation = parsedGeneration(raw.generation, label);
  if (raw.type === "directory") return { path: authorityPath, type: "directory", generation };
  if (raw.type !== "file" || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)
    || !["local-json", "local-event", "journal", "snapshot", "result"].includes(String(raw.readKind))) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", `${label} file authority is invalid`);
  }
  const readKind = raw.readKind as MigrationMetadataReadKind;
  if (raw.maxBytes !== maxBytesForReadKind(readKind)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", `${label} file authority bound is invalid`);
  }
  return {
    path: authorityPath,
    type: "file",
    generation,
    sha256: raw.sha256,
    maxBytes: raw.maxBytes,
    readKind,
  };
}

function canonicalPathArray(value: unknown, label: string) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && path.resolve(entry) === entry)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", `${label} is invalid`);
  }
  const paths = value as string[];
  const sorted = [...new Set(paths)].sort();
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", `${label} must be sorted and unique`);
  }
  return paths;
}

function migrationJournal(value: unknown, expectedHubRoot: string, signingKey: string): MigrationJournal {
  const raw = record(value, "Redis migration journal");
  verifyMigrationJournalHmac(raw, signingKey);
  const rawInventory = record(raw.inventory, "Redis migration inventory");
  const countFields = [
    "projects",
    "queueEntries",
    "assignments",
    "attempts",
    "workers",
    "inboxEntries",
    "leases",
    "jobs",
    "jobEvents",
  ] as const;
  for (const field of countFields) {
    if (!Number.isSafeInteger(rawInventory[field]) || Number(rawInventory[field]) < 0) {
      throw migrationError("HUB_REDIS_MIGRATION_INVALID", `Redis migration inventory ${field} is invalid`);
    }
  }
  const inventory: LocalRedisMigrationInventory = {
    ...Object.fromEntries(countFields.map((field) => [field, Number(rawInventory[field])])),
    runtimeRoots: canonicalPathArray(rawInventory.runtimeRoots, "Redis migration runtime roots"),
    sourcePaths: canonicalPathArray(rawInventory.sourcePaths, "Redis migration source paths"),
  } as LocalRedisMigrationInventory;
  if (!Array.isArray(raw.localAuthorities)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration local authorities are invalid");
  }
  const localAuthorities = raw.localAuthorities.map((authority, index) => (
    parsedPathAuthority(authority, `Redis migration local authority ${index + 1}`)
  ));
  if (localAuthorities.some((authority) => authority.type === "file"
    && authority.readKind !== "local-json" && authority.readKind !== "local-event")) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration local file authority kind is invalid");
  }
  const authorityPaths = localAuthorities.map((authority) => authority.path);
  if (JSON.stringify(authorityPaths) !== JSON.stringify([...new Set(authorityPaths)].sort())) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration local authorities must be sorted and unique");
  }
  const snapshotAuthority = parsedPathAuthority(raw.snapshotAuthority, "Redis migration snapshot authority");
  if (snapshotAuthority.type !== "file" || snapshotAuthority.readKind !== "snapshot") {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration snapshot authority is invalid");
  }
  const outputAuthority = parsedPathAuthority(raw.outputAuthority, "Redis migration output authority");
  if (outputAuthority.type !== "directory") {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration output authority is invalid");
  }
  const outputParentAuthority = parsedPathAuthority(
    raw.outputParentAuthority,
    "Redis migration output parent authority",
  );
  if (outputParentAuthority.type !== "directory") {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration output parent authority is invalid");
  }
  if (raw.format !== MIGRATION_FORMAT || typeof raw.migrationId !== "string" || !UUID_RE.test(raw.migrationId)
    || typeof raw.operationToken !== "string" || !UUID_RE.test(raw.operationToken)
    || !["prepared", "redis_committed"].includes(String(raw.phase))
    || path.resolve(String(raw.hubRoot || "")) !== expectedHubRoot
    || typeof raw.cpbRoot !== "string" || path.resolve(raw.cpbRoot) !== raw.cpbRoot
    || typeof raw.output !== "string" || typeof raw.snapshotPath !== "string"
    || typeof raw.backupPath !== "string" || typeof raw.snapshotSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(raw.snapshotSha256)
    || typeof raw.backendIdentityFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(raw.backendIdentityFingerprint)
    || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))
    || typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration journal is invalid");
  }
  const output = path.resolve(raw.output);
  const outputRelative = path.relative(expectedHubRoot, output);
  if (outputRelative === "" || (!path.isAbsolute(outputRelative)
      && outputRelative !== ".." && !outputRelative.startsWith(`..${path.sep}`))
    || path.resolve(raw.snapshotPath) !== path.join(output, SNAPSHOT_FILE)
    || path.resolve(raw.backupPath) !== path.join(output, "hub-backup")
    || (raw.auditArchivePath !== null && path.resolve(String(raw.auditArchivePath)) !== path.join(output, "local-access-audit"))) {
    throw migrationError("HUB_REDIS_MIGRATION_UNSAFE", "Redis migration journal artifact paths are invalid");
  }
  const journal = {
    ...raw,
    phase: raw.phase as MigrationJournal["phase"],
    cpbRoot: raw.cpbRoot,
    hubRoot: expectedHubRoot,
    output,
    outputParentAuthority,
    outputAuthority,
    backupPath: path.resolve(raw.backupPath),
    auditArchivePath: raw.auditArchivePath === null ? null : path.resolve(String(raw.auditArchivePath)),
    snapshotPath: path.resolve(raw.snapshotPath),
    snapshotAuthority,
    inventory,
    localAuthorities,
  } as MigrationJournal;
  if (journal.snapshotAuthority.path !== journal.snapshotPath) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration snapshot path authority is invalid");
  }
  if (journal.outputAuthority.path !== journal.output) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration output path authority is invalid");
  }
  if (journal.outputParentAuthority.path !== path.dirname(journal.output)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration output parent path authority is invalid");
  }
  assertJournalOutputDoesNotOverlapRetirement(journal.output, journal.inventory.sourcePaths);
  assertRetirementPaths(journal);
  return journal;
}

function validateMigrationSnapshot(value: unknown, backendIdentityFingerprint: string, snapshotSha256: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration snapshot must be an object");
  }
  const snapshot = value as RedisLogicalSnapshot;
  if (snapshot.format !== "cpb-hub-redis-logical-snapshot/v1"
    || snapshot.backendIdentityFingerprint !== backendIdentityFingerprint
    || snapshot.sha256 !== snapshotSha256
    || !Array.isArray(snapshot.hashFields)
    || !Array.isArray(snapshot.jobStreams)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration snapshot identity is invalid");
  }
  const { sha256: _sha256, ...body } = snapshot;
  const digest = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
  if (digest !== snapshot.sha256) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "Redis migration snapshot digest is invalid");
  }
  return snapshot;
}

async function readMigrationSnapshot(journal: MigrationJournal) {
  const pinned = await readJsonFilePinned(
    journal.snapshotPath,
    "Redis migration snapshot",
    MAX_MIGRATION_SNAPSHOT_BYTES,
    "snapshot",
  );
  if (!samePathAuthority(journal.snapshotAuthority, pinned.authority)) {
    throw authorityChanged("migration snapshot", journal.snapshotPath, {
      journal: hubRedisMigrationJournalPath(journal.hubRoot),
      snapshot: journal.snapshotPath,
      backup: journal.backupPath,
    });
  }
  return {
    snapshot: validateMigrationSnapshot(
      pinned.value,
      journal.backendIdentityFingerprint,
      journal.snapshotSha256,
    ),
    authority: pinned.authority,
  };
}

export function _internalSignMigrationJournalForTests(value: unknown, signingKey: string) {
  return signMigrationJournal(value as Omit<MigrationJournal, "journalHmac">, signingKey);
}

export function _internalParseMigrationJournalForTests(value: unknown, hubRoot: string, signingKey: string) {
  return migrationJournal(value, path.resolve(hubRoot), signingKey);
}

export async function recoverHubRedisMigration(options: {
  hubRoot: string;
  configFile?: string;
  backupSigningKey?: string;
}) {
  const hubRoot = path.resolve(options.hubRoot);
  const journalPath = hubRedisMigrationJournalPath(hubRoot);
  if (!await exists(journalPath)) return { recovered: false as const };
  if (!options.configFile) {
    throw migrationError("HUB_REDIS_MIGRATION_CONFIG_REQUIRED", "interrupted Redis migration recovery requires the original Redis config file");
  }
  if (!options.backupSigningKey) {
    throw migrationError("HUB_REDIS_MIGRATION_SIGNING_KEY_REQUIRED", "migration recovery requires CPB_HUB_BACKUP_SIGNING_KEY");
  }
  const pinnedJournal = await readJsonFilePinned(
    journalPath,
    "Redis migration journal",
    MAX_MIGRATION_JOURNAL_BYTES,
    "journal",
  );
  const journal = migrationJournal(pinnedJournal.value, hubRoot, options.backupSigningKey);
  const outputLineage: MigrationOutputLineage = {
    parentAuthority: journal.outputParentAuthority,
    outputAuthority: journal.outputAuthority,
  };
  await repinOutputLineage(outputLineage, { journal: journalPath, output: journal.output });
  const { snapshot, authority: snapshotAuthority } = await readMigrationSnapshot(journal);
  if (!await exists(journal.backupPath)) {
    throw migrationError("HUB_REDIS_MIGRATION_INVALID", "verified rollback backup is missing during migration recovery");
  }
  const { verifyHubBackup } = await import("./hub-backup.js");
  await verifyHubBackup(journal.backupPath, {
    signingKey: options.backupSigningKey,
    requireSignature: true,
  });
  await repinOutputLineage(outputLineage, {
    journal: journalPath,
    output: journal.output,
    backup: journal.backupPath,
  });
  const backend = await openHubRedisStateBackend({ configFile: options.configFile, hubRoot });
  if (!backend || backend.identityFingerprint !== journal.backendIdentityFingerprint) {
    throw migrationError("HUB_REDIS_MIGRATION_CONFIG_MISMATCH", "Redis migration recovery backend identity does not match the journal");
  }
  await backend.preflight();
  const maintenance = await acquireHubMaintenance(hubRoot, "Hub Redis migration recovery");
  let commitContext: MigrationCommitContext | null = null;
  try {
    const baseRecoveryPaths = {
      journal: journalPath,
      snapshot: journal.snapshotPath,
      backup: journal.backupPath,
      output: journal.output,
    };
    const resultPath = path.join(journal.output, RESULT_FILE);
    const activeCommitContext: MigrationCommitContext = {
      redisCommitted: false,
      commitMayHaveOccurred: false,
      recoveryPaths: Object.freeze({ ...baseRecoveryPaths, result: resultPath }),
    };
    commitContext = activeCommitContext;
    await repinFileAuthority(pinnedJournal.authority, "migration journal", baseRecoveryPaths);
    await repinFileAuthority(snapshotAuthority, "migration snapshot", baseRecoveryPaths);
    await commitMigration(backend, snapshot, "Hub Redis migration recovery", async () => {
      await repinFileAuthority(pinnedJournal.authority, "migration journal", baseRecoveryPaths);
      await repinFileAuthority(snapshotAuthority, "migration snapshot", baseRecoveryPaths);
      await repinOutputLineage(outputLineage, baseRecoveryPaths);
      await validateLocalAuthorities(journal, baseRecoveryPaths);
    }, activeCommitContext);
    return await runAfterRedisCommit(activeCommitContext, async () => {
      await assertPostCommitMetadataAuthorities(
        pinnedJournal.authority,
        snapshotAuthority,
        activeCommitContext.recoveryPaths,
      );
      await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      await retireLocalAuthority(
        journal,
        pinnedJournal.authority,
        snapshotAuthority,
        activeCommitContext.recoveryPaths,
      );
      await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      let result = {
        format: MIGRATION_FORMAT,
        migrationId: journal.migrationId,
        completedAt: new Date().toISOString(),
        backendIdentityFingerprint: backend.identityFingerprint,
        backupPath: journal.backupPath,
        auditArchivePath: journal.auditArchivePath,
        snapshotSha256: snapshot.sha256,
        inventory: journal.inventory,
        recovered: true as const,
      };
      if (await exists(resultPath)) {
        await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
        const pinnedResult = await readJsonFilePinned(
          resultPath,
          "Redis migration result",
          MAX_MIGRATION_RESULT_BYTES,
          "result",
        );
        const existing = record(pinnedResult.value, "Redis migration result");
        if (existing.format !== MIGRATION_FORMAT || existing.migrationId !== journal.migrationId
          || existing.backendIdentityFingerprint !== backend.identityFingerprint
          || existing.snapshotSha256 !== snapshot.sha256
          || existing.backupPath !== journal.backupPath
          || existing.auditArchivePath !== journal.auditArchivePath
          || JSON.stringify(existing.inventory) !== JSON.stringify(journal.inventory)
          || typeof existing.completedAt !== "string" || !Number.isFinite(Date.parse(existing.completedAt))) {
          throw migrationFsMutationError(Object.assign(new Error(`migration result successor was preserved: ${resultPath}`), {
            code: "HUB_REDIS_MIGRATION_SUCCESSOR_PRESERVED",
            committed: false,
            committedPath: null,
            successorPreserved: true,
            recoveryPaths: activeCommitContext.recoveryPaths,
          }));
        }
        result = { ...existing, recovered: true } as typeof result;
        await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      } else {
        await writeJsonOnceDurable(
          resultPath,
          result,
          "migration-result",
          MAX_MIGRATION_RESULT_BYTES,
          activeCommitContext.recoveryPaths,
          activeCommitContext,
          outputLineage,
        );
      }
      await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      await removePinnedAuthority(
        pinnedJournal.authority,
        journal.operationToken,
        "journal-remove",
        activeCommitContext.recoveryPaths,
      );
      await repinOutputLineage(outputLineage, activeCommitContext.recoveryPaths);
      return result;
    });
  } finally {
    try {
      if (!(await maintenance.release())) {
        throw migrationError("HUB_MAINTENANCE_INVALID", `migration recovery lost local maintenance lock ownership: ${maintenance.lockPath}`);
      }
    } catch (error) {
      if (commitContext && (commitContext.redisCommitted || commitContext.commitMayHaveOccurred)) {
        throw redisOutcomeFailure(error, commitContext);
      }
      throw error;
    }
  }
}
