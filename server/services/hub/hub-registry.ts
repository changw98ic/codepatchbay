/**
 * hub-registry.ts — merged from:
 *   server/services/hub-registry.ts
 *   server/services/hub-runtime.ts
 *   server/services/hub-cli.ts
 *   server/services/attention-projection.ts
 */

// ─── hub-registry.ts ────────────────────────────────────────────────────────

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { defaultProjectRuntimeRoot, projectRuntimeRoot as resolveProjectRuntimeRoot } from "../runtime.js";
import { generateProjectCapabilityMaps } from "../project/project-index.js";
import type { LooseRecord } from "../../../core/contracts/types.js";
import {
  assertExplicitInsecureHttpOptIn,
  isLoopbackHost,
} from "../../../shared/network.js";
import { loadHubAuthConfig } from "../../../shared/hub-auth.js";
import { openHubOidcProvider } from "../../../shared/hub-oidc.js";
import { assertHubWritable, recoverStaleHubMaintenance } from "../../../shared/hub-maintenance.js";
import { openPinnedHubRedisStateBackend, type HubRedisStateBackend } from "../../../shared/hub-state-redis.js";
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  killTree,
  sameProcessIdentity,
  type KillTreeOptions,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../../../core/runtime/process-tree.js";
import { withDirectoryProcessFence } from "../../../core/runtime/durable-directory-lock.js";
import type { QuotaDelegateLockReceipt } from "../quota-delegate-client.js";

const REGISTRY_VERSION = 1;
const SAFE_ID = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const SAFE_GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SAFE_GITHUB_REPO = /^[A-Za-z0-9._-]+$/;
const REGISTRY_LOCK_TTL_MS = 30_000;
const REGISTRY_LOCK_FORMAT = "cpb-hub-registry-lock/v2";
const REGISTRY_LOCK_WAIT_MS = 20_000;
const REGISTRY_LOCK_RETRY_MS = 10;
const REGISTRY_LOCK_MAX_BYTES = 16 * 1024;
const REGISTRY_MAX_BYTES = 16 * 1024 * 1024;
const REGISTRY_CAS_MAX_ATTEMPTS = 64;

type HubRecord = LooseRecord & {
  id?: string;
  name?: string;
  version?: string;
  revision?: number;
  updatedAt?: string;
  projects?: Record<string, ProjectRecord>;
  projectRevisions?: Record<string, number>;
  mutationId?: string | null;
  sourcePath?: string;
  projectRoot?: string;
  projectRuntimeRoot?: string;
  enabled?: boolean;
  weight?: number;
  createdAt?: string;
  metadata?: HubRecord;
  capabilityMapConfidence?: string;
  project_capability_map?: HubRecord;
  projectCapabilityMap?: HubRecord;
  originJobId?: string;
  retryJobId?: string;
  approval?: HubRecord;
  github?: HubRecord & {
    owner?: string;
    repo?: string;
    fullName?: string;
    triggers?: unknown[];
    boundAt?: string;
    automation?: HubRecord & {
      enabled?: boolean;
      exclude?: unknown;
      rules?: HubRecord[];
    };
  };
  worker?: WorkerHeartbeat | null;
  shutdownRequested?: boolean;
  workerId?: string;
  pid?: number;
  processIdentity?: ProcessIdentity | null;
  hubId?: string;
  startupToken?: string;
  status?: string;
  capabilities?: unknown[];
  claimTimeoutMs?: number;
  lastSeenAt?: string;
  cpbRoot?: string;
  executorRoot?: string;
  hubRoot?: string;
  port?: string | number;
  host?: string;
  sourceContext?: HubRecord;
  queue?: HubRecord;
  retry?: HubRecord;
  reviewLoop?: HubRecord;
  queueEntryId?: string;
  entryId?: string;
  previousQueueEntryId?: string;
  retryQueueEntryId?: string;
  project?: string;
  projectId?: string;
  description?: string;
  task?: string;
  priority?: string;
  codegraphReadiness?: HubRecord;
  indexFreshness?: HubRecord;
  dirtyReasons?: unknown[];
  rateLimitReason?: string;
  reason?: string;
  jobId?: string;
  failureCause?: HubRecord | string | null;
  lastActivityMessage?: string;
  failureCode?: string;
  eventLogPath?: string;
  nodeStates?: Record<string, HubRecord>;
  phase?: string;
  failedAt?: string;
  error?: unknown;
  intent?: string;
  sessionId?: string;
  reviews?: HubRecord[];
  jobs?: HubRecord[];
  queueEntries?: HubRecord[];
  runtimeHealth?: HubRecord | null;
  jobsIndexDivergence?: HubRecord;
  blockers?: HubRecord[];
  staleJobs?: number;
  queueBlockingCounts?: HubRecord;
  code?: string;
  message?: string;
  count?: number;
  codegraphUnavailable?: number;
  agentRateLimited?: number;
  agent_rate_limited?: number;
  primaryEvidenceId?: string;
  dedupeKeys?: string[];
  severity?: string;
  kind?: keyof typeof KIND_RANK | string;
  title?: string;
  impact?: string;
  ageMs?: number | null;
  nextHumanAction?: unknown;
  evidence?: EvidenceRecord[];
  _priority?: string | null;
  _primaryEvidenceId?: string;
  _dedupeKeys?: string[];
};

export type ProjectRecord = HubRecord & {
  id: string;
  sourcePath: string;
};

export type ProjectRegistrationReceipt = {
  projectId: string;
  committedProjectRevision: number;
  previousProject: ProjectRecord | null;
  committedProject: ProjectRecord;
};

export type ProjectRegistrationResult = {
  project: ProjectRecord;
  receipt: ProjectRegistrationReceipt;
  /** Non-empty warnings are blocking: the caller must fail its gate or compensate with the receipt. */
  commitWarnings: readonly HubRegistryCommitWarning[];
};

type WorkerHeartbeat = HubRecord & {
  workerId: string;
  pid: number;
  status: string;
  capabilities: unknown[];
  lastSeenAt: string;
};

export type RegistryRecord = {
  version: number;
  revision: number;
  updatedAt: string;
  projects: Record<string, ProjectRecord>;
  projectRevisions: Record<string, number>;
  mutationId: string | null;
};

type RegistryLockRecord = {
  format: typeof REGISTRY_LOCK_FORMAT;
  ownerToken: string;
  ownerPid: number;
  ownerHost: string;
  acquiredAt: string;
  processIdentity: ProcessIdentity;
  releaseFailedAt?: string;
};

type PathGeneration = {
  dev: bigint | number;
  ino: bigint | number;
  size: bigint | number;
  mtimeMs: bigint | number;
  ctimeMs: bigint | number;
  birthtimeMs: bigint | number;
};

type RegistryLockCandidate = {
  owner: RegistryLockRecord | null;
  lockIdentity: PathGeneration;
  kind: "released" | "stale" | "incomplete";
};

type RegistryLockLease = {
  assertOwned: () => Promise<void>;
};

type RegistryBackend = Pick<HubRedisStateBackend, "readRegistry" | "compareAndSwapRegistry">;

type RegistryCommitDetails<T = unknown> = {
  mutationId: string;
  committedRegistry: RegistryRecord;
  result?: T;
  receipt?: ProjectRegistrationReceipt;
};

type RegistryUnknownDetails<T = unknown> = {
  mutationId: string;
  result?: T;
  receipt?: ProjectRegistrationReceipt;
};

export type HubRegistryCommittedOutcome<T = unknown> = RegistryCommitDetails<T> & {
  status: "committed";
};

export type HubRegistryCommitUnknownOutcome<T = unknown> = RegistryUnknownDetails<T> & {
  status: "unknown";
};

export type HubRegistryCommittedError<T = unknown> = Error & RegistryCommitDetails<T> & {
  code: "HUB_REGISTRY_COMMITTED";
  committed: true;
  outcome: HubRegistryCommittedOutcome<T>;
  cause: unknown;
};

export type HubRegistryCommitUnknownError<T = unknown> = Error & RegistryUnknownDetails<T> & {
  code: "HUB_REGISTRY_COMMIT_UNKNOWN";
  committed: false;
  outcome: HubRegistryCommitUnknownOutcome<T>;
  cause: unknown;
};

export type HubRegistryCommitWarning = {
  code: "HUB_REGISTRY_COMMITTED";
  requiresAction: "fail-or-compensate";
  message: string;
  mutationId: string;
  committedRegistry: RegistryRecord;
};

type HubRegistryTestHooks = {
  beforeAtomicRename?: (context: { filePath: string; tmpPath: string }) => Promise<void> | void;
  afterAtomicRename?: (filePath: string) => Promise<void> | void;
  afterBoundedFilePreflight?: (filePath: string) => Promise<void> | void;
  afterBoundedFileHandleRead?: (filePath: string) => Promise<void> | void;
  beforeLockReleaseRemove?: (lockDir: string) => Promise<void> | void;
  afterRegistryLockRecoveryObserved?: (context: { lockDir: string; ownerToken: string | null; kind: string }) => Promise<void> | void;
  afterRegistryLockQuarantineRename?: (context: { lockDir: string; quarantineDir: string; ownerToken: string | null; kind: string }) => Promise<void> | void;
  beforeRegistryLockQuarantineFinalCheck?: (context: { lockDir: string; quarantineDir: string; ownerToken: string | null; kind: string }) => Promise<void> | void;
  syncDirectory?: (directory: string) => Promise<void> | void;
  afterRedisCompareAndSwap?: (mutationId: string) => Promise<void> | void;
  registryBackend?: RegistryBackend | null;
};

type EvidenceRecord = {
  type: string;
  id: string;
  path?: string;
};

type AttentionItem = HubRecord & {
  id: string;
  severity: string;
  kind: string;
  title: string;
  reason: string;
  impact: string;
  evidence: EvidenceRecord[];
  _priority: string | null;
  _primaryEvidenceId: string;
  _dedupeKeys: string[];
};

function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isHubRecord(value: unknown): value is HubRecord {
  return typeof value === "object" && value !== null;
}

function numberValue(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}


export const DEFAULT_GITHUB_TRIGGERS = [
  { event: "issues.labeled", label: "cpb", workflow: "standard" },
  { event: "issue_comment.created", command: "/cpb run", workflow: "standard" },
];

export function resolveHubRoot(cpbRoot = process.cwd()) {
  if (process.env.CPB_HUB_ROOT) return path.resolve(process.env.CPB_HUB_ROOT);
  const home = os.homedir();
  return home ? path.join(home, ".cpb") : path.join(path.resolve(cpbRoot), ".cpb", "hub");
}

export function registryPath(hubRoot: string) {
  return path.join(path.resolve(hubRoot), "projects.json");
}

export function defaultRegistry(): RegistryRecord {
  return {
    version: REGISTRY_VERSION,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    projects: {},
    projectRevisions: {},
    mutationId: null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(value: unknown, fallback = "project") {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return SAFE_ID.test(slug) ? slug : fallback;
}

function pathHash(sourcePath: string) {
  return createHash("sha256").update(sourcePath).digest("hex").slice(0, 8);
}

function hubRegistryError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function hubRegistryCommittedError<T>(message: string, cause: unknown, details: RegistryCommitDetails<T>): HubRegistryCommittedError<T> {
  const outcome: HubRegistryCommittedOutcome<T> = {
    status: "committed",
    ...details,
  };
  return Object.assign(new Error(message), details, {
    code: "HUB_REGISTRY_COMMITTED",
    committed: true,
    cause,
    outcome,
  }) as HubRegistryCommittedError<T>;
}

function hubRegistryCommitUnknownError<T>(message: string, cause: unknown, details: RegistryUnknownDetails<T>): HubRegistryCommitUnknownError<T> {
  const outcome: HubRegistryCommitUnknownOutcome<T> = {
    status: "unknown",
    ...details,
  };
  return Object.assign(new Error(message), details, {
    code: "HUB_REGISTRY_COMMIT_UNKNOWN",
    committed: false,
    cause,
    outcome,
  }) as HubRegistryCommitUnknownError<T>;
}

export function isHubRegistryCommittedError<T = unknown>(error: unknown): error is HubRegistryCommittedError<T> {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    committed?: unknown;
    mutationId?: unknown;
    committedRegistry?: unknown;
    outcome?: { status?: unknown; mutationId?: unknown; committedRegistry?: unknown };
  };
  return value.code === "HUB_REGISTRY_COMMITTED"
    && value.committed === true
    && typeof value.mutationId === "string"
    && value.mutationId.length > 0
    && Boolean(value.committedRegistry && typeof value.committedRegistry === "object")
    && value.outcome?.status === "committed"
    && value.outcome.mutationId === value.mutationId
    && value.outcome.committedRegistry === value.committedRegistry;
}

export function isHubRegistryCommitUnknownError<T = unknown>(error: unknown): error is HubRegistryCommitUnknownError<T> {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    committed?: unknown;
    mutationId?: unknown;
    outcome?: { status?: unknown; mutationId?: unknown };
  };
  return value.code === "HUB_REGISTRY_COMMIT_UNKNOWN"
    && value.committed === false
    && typeof value.mutationId === "string"
    && value.mutationId.length > 0
    && value.outcome?.status === "unknown"
    && value.outcome.mutationId === value.mutationId;
}

export function hubRegistryCommitOutcome<T = unknown>(error: unknown): HubRegistryCommittedOutcome<T> | HubRegistryCommitUnknownOutcome<T> | null {
  if (isHubRegistryCommittedError<T>(error) || isHubRegistryCommitUnknownError<T>(error)) return error.outcome;
  return null;
}

function committedReceiptFromResult(result: unknown): ProjectRegistrationReceipt | undefined {
  if (!result || typeof result !== "object") return undefined;
  return (result as { receipt?: ProjectRegistrationReceipt }).receipt;
}

function pathGeneration(info: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "birthtimeMs">): PathGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function samePathGeneration(expected: PathGeneration, actual: PathGeneration) {
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs
    && actual.birthtimeMs === expected.birthtimeMs;
}

function samePathGenerationAcrossRename(expected: PathGeneration, actual: PathGeneration) {
  return actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.birthtimeMs === expected.birthtimeMs;
}

const hubRegistryTestHookStorage = new AsyncLocalStorage<Readonly<HubRegistryTestHooks>>();

export async function withHubRegistryTestHooks<T>(hooks: HubRegistryTestHooks, operation: () => Promise<T>): Promise<T> {
  const inherited = hubRegistryTestHookStorage.getStore();
  return await hubRegistryTestHookStorage.run(Object.freeze({ ...inherited, ...hooks }), operation);
}

function currentHubRegistryTestHooks() {
  return hubRegistryTestHookStorage.getStore();
}

async function syncDirectory(directory: string) {
  await currentHubRegistryTestHooks()?.syncDirectory?.(directory);
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_DIRECTORY !== "number") {
    throw hubRegistryError(`strict no-follow directory opens are unavailable: ${directory}`, "HUB_REGISTRY_DIRECTORY_UNSAFE");
  }
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw hubRegistryError(`unsafe directory path: ${directory}`, "HUB_REGISTRY_DIRECTORY_UNSAFE");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let primaryError: unknown = null;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.isSymbolicLink() || !samePathGeneration(pathGeneration(before), pathGeneration(opened))) {
      throw hubRegistryError(`directory identity changed while opening: ${directory}`, "HUB_REGISTRY_DIRECTORY_UNSAFE");
    }
    await handle.sync();
    const after = await lstat(directory);
    if (!after.isDirectory() || after.isSymbolicLink() || !samePathGeneration(pathGeneration(opened), pathGeneration(after))) {
      throw hubRegistryError(`directory pathname changed during sync: ${directory}`, "HUB_REGISTRY_DIRECTORY_UNSAFE");
    }
  } catch (error) {
    primaryError = hasErrorCode(error, "ELOOP") || hasErrorCode(error, "EMLINK")
      ? Object.assign(hubRegistryError(`unsafe symbolic-link directory: ${directory}`, "HUB_REGISTRY_DIRECTORY_UNSAFE"), { cause: error })
      : error;
  }
  let closeError: unknown = null;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw new AggregateError([primaryError, closeError], `directory sync and close both failed: ${directory}`, {
      cause: primaryError,
    });
  }
  if (closeError) throw closeError;
}

async function writeAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  let primaryError: unknown = null;
  try {
    handle = await open(tmp, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await currentHubRegistryTestHooks()?.beforeAtomicRename?.({ filePath, tmpPath: tmp });
    await rename(tmp, filePath);
    renamed = true;
    await currentHubRegistryTestHooks()?.afterAtomicRename?.(filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  const errors = [primaryError, closeError].filter((error) => error !== null);
  if (errors.length === 0) return;
  const cause = errors.length === 1
    ? errors[0]
    : new AggregateError(errors, `atomic write and cleanup failed: ${filePath}`, { cause: primaryError ?? errors[0] });
  if (renamed) {
    throw Object.assign(new Error(`atomic write committed but post-rename durability failed: ${filePath}`), {
      code: "CPB_ATOMIC_WRITE_COMMITTED",
      committed: true,
      cause,
    });
  }
  throw cause;
}

function sameFileGeneration(expected: Stats, actual: Stats) {
  return samePathGeneration(pathGeneration(expected), pathGeneration(actual));
}

function assertBoundedRegularFile(
  info: Stats,
  filePath: string,
  maxBytes: number,
  unsafeCode: string,
  tooLargeCode: string,
) {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw hubRegistryError(`unsafe non-regular file: ${filePath}`, unsafeCode);
  }
  if (info.size > maxBytes) {
    throw hubRegistryError(`file exceeds ${maxBytes} byte limit: ${filePath}`, tooLargeCode);
  }
}

async function readRegularFileBounded(
  filePath: string,
  maxBytes: number,
  unsafeCode: string,
  tooLargeCode: string,
) {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw hubRegistryError(`strict no-follow opens are unavailable: ${filePath}`, unsafeCode);
  }
  const before = await lstat(filePath);
  assertBoundedRegularFile(before, filePath, maxBytes, unsafeCode, tooLargeCode);
  await currentHubRegistryTestHooks()?.afterBoundedFilePreflight?.(filePath);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ELOOP") || hasErrorCode(error, "EMLINK")) {
      throw Object.assign(hubRegistryError(`unsafe symbolic-link file: ${filePath}`, unsafeCode), { cause: error });
    }
    throw error;
  }
  let primaryError: unknown = null;
  let openedGeneration: Stats | null = null;
  let value = "";
  try {
    const opened = await handle.stat();
    assertBoundedRegularFile(opened, filePath, maxBytes, unsafeCode, tooLargeCode);
    if (!sameFileGeneration(before, opened)) {
      throw hubRegistryError(`file identity changed while opening: ${filePath}`, unsafeCode);
    }
    openedGeneration = opened;

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) {
        throw hubRegistryError(`file exceeds ${maxBytes} byte limit: ${filePath}`, tooLargeCode);
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw hubRegistryError(`file exceeds ${maxBytes} byte limit: ${filePath}`, tooLargeCode);
      }
      if (total > opened.size) {
        throw hubRegistryError(`file grew during bounded read: ${filePath}`, unsafeCode);
      }
      chunks.push(chunk.subarray(0, bytesRead));
      const observed = await handle.stat();
      assertBoundedRegularFile(observed, filePath, maxBytes, unsafeCode, tooLargeCode);
      if (!sameFileGeneration(opened, observed)) {
        throw hubRegistryError(`file changed during bounded read: ${filePath}`, unsafeCode);
      }
    }
    const after = await handle.stat();
    assertBoundedRegularFile(after, filePath, maxBytes, unsafeCode, tooLargeCode);
    if (!sameFileGeneration(opened, after)) {
      throw hubRegistryError(`file changed during bounded read: ${filePath}`, unsafeCode);
    }
    await currentHubRegistryTestHooks()?.afterBoundedFileHandleRead?.(filePath);
    value = Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  let pathValidationError: unknown = null;
  if (!primaryError && openedGeneration) {
    try {
      const finalPath = await lstat(filePath);
      assertBoundedRegularFile(finalPath, filePath, maxBytes, unsafeCode, tooLargeCode);
      if (!sameFileGeneration(openedGeneration, finalPath)) {
        throw hubRegistryError(`file pathname changed during bounded read: ${filePath}`, unsafeCode);
      }
    } catch (error) {
      pathValidationError = hasErrorCode(error, "ENOENT")
        || hasErrorCode(error, unsafeCode)
        || hasErrorCode(error, tooLargeCode)
        ? error
        : Object.assign(
          hubRegistryError(`file pathname could not be validated after bounded read: ${filePath}`, unsafeCode),
          { cause: error },
        );
    }
  }
  const errors = [primaryError, pathValidationError, closeError].filter((error) => error !== null);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `bounded file read, path validation, or close failed: ${filePath}`, {
      cause: primaryError ?? pathValidationError ?? closeError,
    });
  }
  return value;
}

async function withRegistryProcessFence<T>(lockDir: string, deadlineAt: number, operation: () => Promise<T>) {
  try {
    return await withDirectoryProcessFence(lockDir, operation, {
      waitMs: Math.max(1, deadlineAt - Date.now()),
    });
  } catch (error) {
    if (hasErrorCode(error, "DIRECTORY_LOCK_BUSY")) {
      throw hubRegistryError(`registry process fence busy: ${path.basename(lockDir)}`, "HUB_REGISTRY_LOCK_BUSY");
    }
    throw error;
  }
}

function registryProcessIdentity(value: unknown, expectedPid: number): ProcessIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ProcessIdentity>;
  const processGroupId = Number(candidate.processGroupId);
  if (
    !Number.isSafeInteger(candidate.pid)
    || candidate.pid !== expectedPid
    || candidate.birthIdPrecision !== "exact"
    || typeof candidate.birthId !== "string"
    || !candidate.birthId
    || candidate.incarnation !== `${candidate.pid}:${candidate.birthId}`
    || typeof candidate.capturedAt !== "string"
    || Number.isNaN(new Date(candidate.capturedAt).getTime())
    || new Date(Date.parse(candidate.capturedAt)).toISOString() !== candidate.capturedAt
    || (candidate.processGroupId !== undefined && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
  ) return null;
  return {
    pid: candidate.pid,
    birthId: candidate.birthId,
    incarnation: candidate.incarnation,
    capturedAt: candidate.capturedAt,
    birthIdPrecision: "exact",
    ...(candidate.processGroupId === undefined ? {} : { processGroupId }),
  };
}

function exactProcessIdentity(identity: ProcessIdentity | null): ProcessIdentity | null {
  if (!identity || identity.birthIdPrecision !== "exact") return null;
  return identity;
}

function captureCurrentExactProcessIdentity() {
  return exactProcessIdentity(captureProcessIdentity(process.pid, { strict: true }));
}

async function readRegistryLock(lockDir: string): Promise<RegistryLockRecord | null> {
  try {
    const lockPath = path.join(lockDir, "lock.json");
    const raw = JSON.parse(await readRegularFileBounded(
      lockPath,
      REGISTRY_LOCK_MAX_BYTES,
      "HUB_REGISTRY_LOCK_UNSAFE",
      "HUB_REGISTRY_LOCK_TOO_LARGE",
    )) as Partial<Omit<RegistryLockRecord, "format" | "processIdentity">> & {
      format?: unknown;
      processIdentity?: unknown;
    };
    if (
      raw.format !== REGISTRY_LOCK_FORMAT
      || typeof raw.ownerToken !== "string"
      || !raw.ownerToken
      || !Number.isSafeInteger(raw.ownerPid)
      || Number(raw.ownerPid) <= 0
      || typeof raw.ownerHost !== "string"
      || !raw.ownerHost
      || typeof raw.acquiredAt !== "string"
      || Number.isNaN(new Date(raw.acquiredAt).getTime())
      || new Date(Date.parse(raw.acquiredAt)).toISOString() !== raw.acquiredAt
      || (raw.releaseFailedAt !== undefined
        && (typeof raw.releaseFailedAt !== "string"
          || Number.isNaN(new Date(raw.releaseFailedAt).getTime())
          || new Date(Date.parse(raw.releaseFailedAt)).toISOString() !== raw.releaseFailedAt))
    ) {
      throw hubRegistryError(`registry lock owner is malformed: ${lockDir}`, "HUB_REGISTRY_LOCK_UNSAFE");
    }
    const processIdentity = registryProcessIdentity(raw.processIdentity, Number(raw.ownerPid));
    if (!processIdentity) {
      throw hubRegistryError(`registry lock owner process identity is malformed: ${lockDir}`, "HUB_REGISTRY_LOCK_UNSAFE");
    }
    return {
      format: REGISTRY_LOCK_FORMAT,
      ownerToken: raw.ownerToken,
      ownerPid: Number(raw.ownerPid),
      ownerHost: raw.ownerHost,
      acquiredAt: raw.acquiredAt,
      processIdentity,
      ...(raw.releaseFailedAt === undefined ? {} : { releaseFailedAt: raw.releaseFailedAt }),
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    if (error instanceof SyntaxError) {
      throw Object.assign(
        hubRegistryError(`registry lock owner JSON is malformed: ${lockDir}`, "HUB_REGISTRY_LOCK_UNSAFE"),
        { cause: error },
      );
    }
    throw error;
  }
}

function sameRegistryLockOwner(expected: RegistryLockRecord | null, actual: RegistryLockRecord | null) {
  if (!expected || !actual) return expected === actual;
  return expected.format === actual.format
    && expected.ownerToken === actual.ownerToken
    && expected.ownerPid === actual.ownerPid
    && expected.ownerHost === actual.ownerHost
    && expected.acquiredAt === actual.acquiredAt
    && expected.releaseFailedAt === actual.releaseFailedAt
    && isDeepStrictEqual(expected.processIdentity, actual.processIdentity)
    && sameProcessIdentity(expected.processIdentity, actual.processIdentity);
}

async function registryLockRecoveryCandidate(lockDir: string): Promise<RegistryLockCandidate | null> {
  const info = await lstat(lockDir).catch((error) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw hubRegistryError(`unsafe registry lock path: ${lockDir}`, "HUB_REGISTRY_LOCK_UNSAFE");
  }

  const lock = await readRegistryLock(lockDir);
  if (lock?.releaseFailedAt) {
    return { owner: lock, lockIdentity: pathGeneration(info), kind: "released" };
  }
  const acquiredAt = lock ? new Date(lock.acquiredAt).getTime() : 0;
  const lastLeaseActivity = Math.max(info.mtimeMs, acquiredAt);
  if (Date.now() - lastLeaseActivity < REGISTRY_LOCK_TTL_MS) return null;
  if (!lock) return { owner: null, lockIdentity: pathGeneration(info), kind: "incomplete" };
  if (lock.ownerHost !== os.hostname()) return null;
  try {
    if (isProcessIdentityAlive(lock.processIdentity)) return null;
  } catch (error) {
    throw Object.assign(
      hubRegistryError(`registry lock owner identity probe failed: ${lock.ownerPid}`, "HUB_REGISTRY_LOCK_UNSAFE"),
      { cause: error },
    );
  }
  return { owner: lock, lockIdentity: pathGeneration(info), kind: "stale" };
}

async function restoreRegistryLockQuarantine(quarantineDir: string, lockDir: string, conflict: Error) {
  const errors: unknown[] = [conflict];
  let successorPreserved = false;
  try {
    await lstat(lockDir);
    successorPreserved = true;
  } catch (restoreError) {
    if (!hasErrorCode(restoreError, "ENOENT")) errors.push(restoreError);
  }
  try {
    await syncDirectory(quarantineDir);
  } catch (syncError) {
    errors.push(syncError);
  }
  try {
    await syncDirectory(path.dirname(lockDir));
  } catch (syncError) {
    errors.push(syncError);
  }
  throw Object.assign(new AggregateError(
    errors,
    successorPreserved
      ? `registry lock successor preserved while quarantine remains: ${lockDir}; quarantined=${quarantineDir}`
      : `registry lock quarantine preserved; canonical restore refused: ${lockDir}; quarantined=${quarantineDir}`,
    { cause: conflict },
  ), {
    code: successorPreserved ? "HUB_REGISTRY_LOCK_SUCCESSOR_PRESERVED" : "HUB_REGISTRY_LOCK_RESTORE_FAILED",
    committed: true,
    committedPath: quarantineDir,
    recoveryPaths: { quarantineDir, lockDir },
    quarantineDir,
    lockDir,
    successorPreserved,
  });
}

async function quarantineRegistryLock(
  lockDir: string,
  candidate: RegistryLockCandidate,
  label: "stale" | "released" = "stale",
) {
  const quarantineDir = `${lockDir}.${label}-${Date.now()}-${randomUUID()}`;
  const currentInfo = await lstat(lockDir);
  if (
    !currentInfo.isDirectory()
    || currentInfo.isSymbolicLink()
    || !samePathGeneration(candidate.lockIdentity, pathGeneration(currentInfo))
  ) {
    throw Object.assign(
      hubRegistryError(`registry lock successor preserved before quarantine: ${lockDir}`, "HUB_REGISTRY_LOCK_SUCCESSOR_PRESERVED"),
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
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  const hookContext = {
    lockDir,
    quarantineDir,
    ownerToken: candidate.owner?.ownerToken || null,
    kind: candidate.kind,
  };
  try {
    await syncDirectory(path.dirname(lockDir));
    await currentHubRegistryTestHooks()?.afterRegistryLockQuarantineRename?.(hookContext);
  } catch (cause) {
    throw Object.assign(
      hubRegistryError(`registry lock quarantine committed with ambiguous durability: ${lockDir}; quarantined=${quarantineDir}`, "HUB_REGISTRY_LOCK_QUARANTINE_COMMITTED_DURABILITY_AMBIGUOUS"),
      {
        committed: true,
        committedPath: quarantineDir,
        recoveryPaths: { quarantineDir, lockDir },
        quarantineDir,
        lockDir,
        cause,
      },
    );
  }
  if (candidate.kind !== "released") {
    try {
      await lstat(lockDir);
      await restoreRegistryLockQuarantine(
        quarantineDir,
        lockDir,
        hubRegistryError(`registry lock successor appeared during quarantine: ${lockDir}`, "HUB_REGISTRY_LOCK_LOST"),
      );
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
  }
  const movedInfo = await lstat(quarantineDir);
  const movedOwner = await readRegistryLock(quarantineDir);
  if (
    !movedInfo.isDirectory()
    || movedInfo.isSymbolicLink()
    || !samePathGenerationAcrossRename(candidate.lockIdentity, pathGeneration(movedInfo))
    || !sameRegistryLockOwner(candidate.owner, movedOwner)
  ) {
    await restoreRegistryLockQuarantine(
      quarantineDir,
      lockDir,
      hubRegistryError(`registry lock owner changed during quarantine: ${lockDir}`, "HUB_REGISTRY_LOCK_LOST"),
    );
  }
  try {
    await currentHubRegistryTestHooks()?.beforeRegistryLockQuarantineFinalCheck?.(hookContext);
    const finalInfo = await lstat(quarantineDir);
    const finalOwner = await readRegistryLock(quarantineDir);
    if (
      !finalInfo.isDirectory()
      || finalInfo.isSymbolicLink()
      || !samePathGeneration(pathGeneration(movedInfo), pathGeneration(finalInfo))
      || !sameRegistryLockOwner(movedOwner, finalOwner)
    ) {
      await restoreRegistryLockQuarantine(
        quarantineDir,
        lockDir,
        hubRegistryError(`registry lock quarantine changed after validation: ${lockDir}`, "HUB_REGISTRY_LOCK_LOST"),
      );
    }
    await syncDirectory(path.dirname(lockDir));
  } catch (cause) {
    if (hasErrorCode(cause, "HUB_REGISTRY_LOCK_SUCCESSOR_PRESERVED") || hasErrorCode(cause, "HUB_REGISTRY_LOCK_RESTORE_FAILED")) {
      throw cause;
    }
    throw Object.assign(
      hubRegistryError(`registry lock quarantine committed with ambiguous durability: ${lockDir}; quarantined=${quarantineDir}`, "HUB_REGISTRY_LOCK_QUARANTINE_COMMITTED_DURABILITY_AMBIGUOUS"),
      {
        committed: true,
        committedPath: quarantineDir,
        recoveryPaths: { quarantineDir, lockDir },
        quarantineDir,
        lockDir,
        cause,
      },
    );
  }
  return true;
}

async function abandonOwnedRegistryLock(lockDir: string, expectedOwner: RegistryLockRecord) {
  const cleanupErrors: unknown[] = [];
  let current: RegistryLockRecord | null;
  try {
    current = await readRegistryLock(lockDir);
  } catch (error) {
    cleanupErrors.push(error);
    return cleanupErrors;
  }
  if (!sameRegistryLockOwner(expectedOwner, current)) return cleanupErrors;

  try {
    const info = await lstat(lockDir);
    await quarantineRegistryLock(lockDir, {
      owner: current,
      lockIdentity: pathGeneration(info),
      kind: "released",
    }, "released");
    return cleanupErrors;
  } catch (error) {
    cleanupErrors.push(error);
  }

  try {
    current = await readRegistryLock(lockDir);
    if (!sameRegistryLockOwner(expectedOwner, current)) return cleanupErrors;
    await writeAtomic(path.join(lockDir, "lock.json"), `${JSON.stringify({
      ...current,
      releaseFailedAt: nowIso(),
    } satisfies RegistryLockRecord, null, 2)}\n`);
  } catch (error) {
    cleanupErrors.push(error);
  }
  return cleanupErrors;
}

function aggregateCallbackAndReleaseErrors(callbackError: unknown, releaseError: unknown) {
  const aggregate = Object.assign(
    new AggregateError([callbackError, releaseError], "registry callback and lock release both failed"),
    {
      code: "HUB_REGISTRY_CALLBACK_AND_RELEASE_FAILED",
      callbackError,
      releaseError,
    },
  );
  if (isHubRegistryCommittedError(callbackError)) {
    return Object.assign(aggregate, {
      code: callbackError.code,
      committed: true,
      mutationId: callbackError.mutationId,
      committedRegistry: callbackError.committedRegistry,
      result: callbackError.result,
      receipt: callbackError.receipt,
      outcome: callbackError.outcome,
      cause: callbackError,
    });
  }
  if (isHubRegistryCommitUnknownError(callbackError)) {
    return Object.assign(aggregate, {
      code: callbackError.code,
      committed: false,
      mutationId: callbackError.mutationId,
      result: callbackError.result,
      receipt: callbackError.receipt,
      outcome: callbackError.outcome,
      cause: callbackError,
    });
  }
  if (hasErrorCode(callbackError, "HUB_REGISTRY_LOCK_LOST")) {
    return Object.assign(aggregate, {
      code: "HUB_REGISTRY_LOCK_LOST",
      cause: callbackError,
    });
  }
  return aggregate;
}

async function withRegistryLock<T>(hubRoot: string, callback: (lease: RegistryLockLease) => Promise<T>): Promise<T> {
  await assertHubWritable(hubRoot);
  const file = registryPath(hubRoot);
  const lockDir = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true });

  let acquired = false;
  const processIdentity = captureCurrentExactProcessIdentity();
  if (!processIdentity) {
    throw hubRegistryError("registry lock process identity is unavailable", "HUB_REGISTRY_LOCK_IDENTITY_UNAVAILABLE");
  }
  const owner: RegistryLockRecord = {
    format: REGISTRY_LOCK_FORMAT,
    ownerToken: randomUUID(),
    ownerPid: process.pid,
    ownerHost: os.hostname(),
    acquiredAt: nowIso(),
    processIdentity,
  };
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    acquired = await withRegistryProcessFence(lockDir, deadline, async () => {
      let createdInfo: Awaited<ReturnType<typeof lstat>>;
      try {
        await mkdir(lockDir);
        createdInfo = await lstat(lockDir);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        const candidate = await registryLockRecoveryCandidate(lockDir);
        if (candidate) {
          await currentHubRegistryTestHooks()?.afterRegistryLockRecoveryObserved?.({
            lockDir,
            ownerToken: candidate.owner?.ownerToken || null,
            kind: candidate.kind,
          });
          await quarantineRegistryLock(lockDir, candidate);
        }
        return false;
      }

      try {
        await writeAtomic(path.join(lockDir, "lock.json"), `${JSON.stringify(owner, null, 2)}\n`);
        await syncDirectory(path.dirname(lockDir));
        return true;
      } catch (primaryError) {
        let cleanupError: unknown = null;
        try {
          const current = await readRegistryLock(lockDir);
          if (current && !sameRegistryLockOwner(owner, current)) {
            throw hubRegistryError("registry lock owner changed after acquisition write failed", "HUB_REGISTRY_LOCK_LOST");
          }
          await quarantineRegistryLock(lockDir, {
            owner: current,
            lockIdentity: pathGeneration(createdInfo),
            kind: "incomplete",
          });
        } catch (error) {
          cleanupError = error;
        }
        if (!cleanupError) throw primaryError;
        throw Object.assign(
          hubRegistryError("registry lock acquisition and cleanup both failed", "HUB_REGISTRY_LOCK_ACQUIRE_FAILED"),
          {
            cause: new AggregateError(
              [primaryError, cleanupError],
              "registry lock acquisition and cleanup both failed",
              { cause: primaryError },
            ),
          },
        );
      }
    });
    if (acquired) break;
    const retryDelay = REGISTRY_LOCK_RETRY_MS + Math.floor(Math.random() * REGISTRY_LOCK_RETRY_MS);
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }

  if (!acquired) {
    throw hubRegistryError(`registry lock busy: ${path.basename(file)}`, "HUB_REGISTRY_LOCK_BUSY");
  }

  const assertOwned = async () => {
    const current = await readRegistryLock(lockDir);
    if (!sameRegistryLockOwner(owner, current)) {
      throw hubRegistryError(`registry lock ownership lost: ${path.basename(file)}`, "HUB_REGISTRY_LOCK_LOST");
    }
  };

  let callbackResult: T | undefined;
  let callbackError: unknown;
  try {
    callbackResult = await callback({ assertOwned });
  } catch (error) {
    callbackError = error;
  }

  let releaseError: unknown;
  try {
    await withRegistryProcessFence(lockDir, Date.now() + REGISTRY_LOCK_WAIT_MS, async () => {
      const current = await readRegistryLock(lockDir);
      if (!sameRegistryLockOwner(owner, current)) {
        throw hubRegistryError(`registry lock ownership lost: ${path.basename(file)}`, "HUB_REGISTRY_LOCK_LOST");
      }
      await currentHubRegistryTestHooks()?.beforeLockReleaseRemove?.(lockDir);
      const releasable = await readRegistryLock(lockDir);
      if (!sameRegistryLockOwner(owner, releasable)) {
        throw hubRegistryError(`registry lock ownership lost: ${path.basename(file)}`, "HUB_REGISTRY_LOCK_LOST");
      }
      const info = await lstat(lockDir);
      await quarantineRegistryLock(lockDir, {
        owner: releasable,
        lockIdentity: pathGeneration(info),
        kind: "released",
      }, "released");
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await withRegistryProcessFence(lockDir, Date.now() + REGISTRY_LOCK_WAIT_MS, async () => {
        cleanupErrors.push(...await abandonOwnedRegistryLock(lockDir, owner));
      });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    releaseError = Object.assign(
      hubRegistryError(`registry lock release failed: ${path.basename(file)}`, "HUB_REGISTRY_LOCK_RELEASE_FAILED"),
      {
        cause: cleanupErrors.length > 0
          ? new AggregateError([error, ...cleanupErrors], "registry lock release and recovery failed")
          : error,
        committedResult: callbackResult,
      },
    );
  }

  if (callbackError && releaseError) throw aggregateCallbackAndReleaseErrors(callbackError, releaseError);
  if (releaseError) throw releaseError;
  if (callbackError) throw callbackError;
  return callbackResult as T;
}

async function canonicalSourcePath(sourcePath: string) {
  if (!sourcePath || typeof sourcePath !== "string") {
    throw new Error("sourcePath is required");
  }
  const resolved = path.resolve(sourcePath);
  const canonical = await realpath(resolved);
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new Error(`sourcePath is not a directory: ${sourcePath}`);
  }
  return canonical;
}

function normalizeRegistry(raw: unknown): RegistryRecord {
  const registry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : defaultRegistry();
  const record = registry as HubRecord;
  const revision = Number(record.revision);
  const projectRevisions: Record<string, number> = {};
  if (record.projectRevisions && typeof record.projectRevisions === "object" && !Array.isArray(record.projectRevisions)) {
    for (const [projectId, value] of Object.entries(record.projectRevisions)) {
      const projectRevision = Number(value);
      if (Number.isSafeInteger(projectRevision) && projectRevision >= 0) {
        projectRevisions[projectId] = projectRevision;
      }
    }
  }
  return {
    version: Number(record.version) || REGISTRY_VERSION,
    revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
    updatedAt: record.updatedAt || new Date(0).toISOString(),
    projects: record.projects && typeof record.projects === "object" && !Array.isArray(record.projects)
      ? record.projects
      : {},
    projectRevisions,
    mutationId: typeof record.mutationId === "string" && record.mutationId.length > 0 && record.mutationId.length <= 128
      ? record.mutationId
      : null,
  };
}

function nextProjectRevision(registry: RegistryRecord, projectId: string) {
  return (registry.projectRevisions[projectId] || 0) + 1;
}

function beginProjectMutationTracking(registry: RegistryRecord) {
  const projects = registry.projects;
  const beforeProjects = receiptClone(projects);
  const beforeRevisions = { ...registry.projectRevisions };
  const touched = new Set<string>();
  const trackedProjects = new Proxy(projects, {
    set(target, property, value) {
      if (typeof property === "string") touched.add(property);
      return Reflect.set(target, property, value, target);
    },
    deleteProperty(target, property) {
      if (typeof property === "string") touched.add(property);
      return Reflect.deleteProperty(target, property);
    },
    defineProperty(target, property, descriptor) {
      if (typeof property === "string") touched.add(property);
      return Reflect.defineProperty(target, property, descriptor);
    },
  });
  registry.projects = trackedProjects;

  const restoreProjects = () => {
    registry.projects = projects;
  };
  return {
    abort: restoreProjects,
    complete() {
      const completedProjects = registry.projects === trackedProjects ? projects : registry.projects;
      if (completedProjects !== projects) {
        for (const projectId of new Set([...Object.keys(projects), ...Object.keys(completedProjects)])) {
          touched.add(projectId);
        }
      }
      registry.projects = completedProjects;
      registry.projectRevisions = beforeRevisions;
      const projectIds = new Set([
        ...Object.keys(beforeProjects),
        ...Object.keys(completedProjects),
        ...touched,
      ]);
      for (const projectId of projectIds) {
        const changed = touched.has(projectId)
          || !receiptDeepEqual(beforeProjects[projectId] || null, completedProjects[projectId] || null);
        if (changed) registry.projectRevisions[projectId] = (beforeRevisions[projectId] || 0) + 1;
      }
    },
  };
}

async function runRegistryMutationCallback<T>(registry: RegistryRecord, callback: (registry: RegistryRecord) => Promise<T> | T) {
  const tracking = beginProjectMutationTracking(registry);
  try {
    const result = await callback(registry);
    tracking.complete();
    return result;
  } catch (error) {
    tracking.abort();
    throw error;
  }
}

function reconcileSavedProjectRevisions(current: RegistryRecord, candidate: RegistryRecord) {
  const nextRevisions = { ...current.projectRevisions };
  const projectIds = new Set([
    ...Object.keys(current.projects),
    ...Object.keys(candidate.projects),
  ]);
  for (const projectId of projectIds) {
    if (!receiptDeepEqual(current.projects[projectId] || null, candidate.projects[projectId] || null)) {
      nextRevisions[projectId] = (current.projectRevisions[projectId] || 0) + 1;
    }
  }
  candidate.projectRevisions = nextRevisions;
}

async function loadLocalRegistry(hubRoot: string) {
  try {
    const raw = await readRegularFileBounded(
      registryPath(hubRoot),
      REGISTRY_MAX_BYTES,
      "HUB_REGISTRY_UNSAFE",
      "HUB_REGISTRY_TOO_LARGE",
    );
    return normalizeRegistry(JSON.parse(raw));
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return defaultRegistry();
    throw err;
  }
}

async function configuredRedisState(hubRoot: string): Promise<HubRedisStateBackend | null> {
  const hooks = currentHubRegistryTestHooks();
  if (hooks && Object.hasOwn(hooks, "registryBackend")) {
    return (hooks.registryBackend || null) as HubRedisStateBackend | null;
  }
  return await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot,
  });
}

async function loadRedisRegistry(backend: RegistryBackend) {
  const raw = await backend.readRegistry();
  if (raw === null) return defaultRegistry();
  if (Buffer.byteLength(raw, "utf8") > REGISTRY_MAX_BYTES) {
    throw hubRegistryError(`registry exceeds ${REGISTRY_MAX_BYTES} byte limit`, "HUB_REGISTRY_TOO_LARGE");
  }
  return normalizeRegistry(JSON.parse(raw));
}

export async function loadRegistry(hubRoot: string) {
  const backend = await configuredRedisState(hubRoot);
  return backend ? await loadRedisRegistry(backend) : await loadLocalRegistry(hubRoot);
}

function prepareRegistryWrite(registry: unknown, currentRevision: number, mutationId: string) {
  const normalized = normalizeRegistry(registry);
  normalized.version = REGISTRY_VERSION;
  normalized.revision = currentRevision + 1;
  normalized.updatedAt = nowIso();
  normalized.mutationId = mutationId;
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > REGISTRY_MAX_BYTES) {
    throw hubRegistryError(`registry exceeds ${REGISTRY_MAX_BYTES} byte limit`, "HUB_REGISTRY_TOO_LARGE");
  }
  return { registry: normalizeRegistry(JSON.parse(serialized)), serialized };
}

function redisCommitOutcomeIsUnknown(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { commitOutcome?: unknown }).commitOutcome === "unknown");
}

async function compareAndSwapRegistry(
  backend: RegistryBackend,
  expectedRevision: number,
  prepared: ReturnType<typeof prepareRegistryWrite>,
  mutationId: string,
) {
  const committed = await backend.compareAndSwapRegistry(
    expectedRevision,
    prepared.registry.revision,
    prepared.serialized,
    mutationId,
  );
  if (committed.committed) {
    try {
      await currentHubRegistryTestHooks()?.afterRedisCompareAndSwap?.(mutationId);
    } catch (cause) {
      throw Object.assign(new Error("Redis registry CAS response was lost after commit"), {
        code: "HUB_STATE_BACKEND_UNAVAILABLE",
        commitOutcome: "unknown",
        mutationId,
        cause,
      });
    }
  }
  return committed;
}

type RedisCommitResolution =
  | { status: "committed"; registry: RegistryRecord }
  | { status: "not-committed" }
  | { status: "unknown"; cause: unknown };

function assessObservedRedisMutation(
  observed: RegistryRecord,
  expectedRevision: number,
  nextRevision: number,
  mutationId: string,
): RedisCommitResolution | null {
  if (observed.mutationId === mutationId) {
    return observed.revision === nextRevision
      ? { status: "committed", registry: observed }
      : {
        status: "unknown",
        cause: hubRegistryError(
          "registry mutation id was reused at an unexpected revision",
          "HUB_REGISTRY_COMMIT_UNKNOWN",
        ),
      };
  }
  if (observed.revision === nextRevision) return { status: "not-committed" };
  if (observed.revision > nextRevision) {
    return {
      status: "unknown",
      cause: hubRegistryError("registry advanced before the ambiguous mutation could be identified", "HUB_REGISTRY_COMMIT_UNKNOWN"),
    };
  }
  if (observed.revision < expectedRevision || observed.revision > expectedRevision) {
    return {
      status: "unknown",
      cause: hubRegistryError("registry revision was invalid while confirming an ambiguous mutation", "HUB_REGISTRY_COMMIT_UNKNOWN"),
    };
  }
  return null;
}

async function resolveAmbiguousRedisCommit(
  backend: RegistryBackend,
  expectedRevision: number,
  prepared: ReturnType<typeof prepareRegistryWrite>,
  mutationId: string,
  initialError: unknown,
): Promise<RedisCommitResolution> {
  const errors: unknown[] = [initialError];
  try {
    const observed = await loadRedisRegistry(backend);
    const assessed = assessObservedRedisMutation(observed, expectedRevision, prepared.registry.revision, mutationId);
    if (assessed) return assessed;
  } catch (error) {
    errors.push(error);
  }

  try {
    const retried = await backend.compareAndSwapRegistry(
      expectedRevision,
      prepared.registry.revision,
      prepared.serialized,
      mutationId,
    );
    if (retried.committed) {
      if (retried.revision === prepared.registry.revision) {
        return { status: "committed", registry: prepared.registry };
      }
      errors.push(hubRegistryError(
        "Redis idempotent registry confirmation returned an unexpected revision",
        "HUB_REGISTRY_COMMIT_UNKNOWN",
      ));
    }
  } catch (error) {
    errors.push(error);
  }

  try {
    const observed = await loadRedisRegistry(backend);
    const assessed = assessObservedRedisMutation(observed, expectedRevision, prepared.registry.revision, mutationId);
    if (assessed) return assessed;
  } catch (error) {
    errors.push(error);
  }
  return {
    status: "unknown",
    cause: new AggregateError(errors, "Redis registry mutation could not be confirmed"),
  };
}

async function confirmLocalRegistryMutation(hubRoot: string, mutationId: string) {
  try {
    const observed = await loadLocalRegistry(hubRoot);
    return observed.mutationId === mutationId ? observed : null;
  } catch {
    return null;
  }
}

async function writeRegistryUnlocked(hubRoot: string, registry: unknown, currentRevision: number, mutationId: string) {
  const prepared = prepareRegistryWrite(registry, currentRevision, mutationId);
  try {
    await writeAtomic(registryPath(hubRoot), prepared.serialized);
  } catch (error) {
    if ((error as { code?: unknown; committed?: unknown }).code === "CPB_ATOMIC_WRITE_COMMITTED") {
      const confirmed = await confirmLocalRegistryMutation(hubRoot, mutationId);
      if (confirmed) {
        throw hubRegistryCommittedError(
          `registry write committed but post-commit durability failed: ${path.basename(registryPath(hubRoot))}`,
          error,
          { mutationId, committedRegistry: confirmed },
        );
      }
      throw hubRegistryCommitUnknownError(
        `registry write outcome is unknown after post-commit durability failure: ${path.basename(registryPath(hubRoot))}`,
        error,
        { mutationId },
      );
    }
    throw error;
  }
  return prepared.registry;
}

export async function saveRegistry(hubRoot: string, registry: unknown) {
  const candidate = normalizeRegistry(registry);
  const mutationId = randomUUID();
  const backend = await configuredRedisState(hubRoot);
  if (backend) {
    await assertHubWritable(hubRoot);
    const current = await loadRedisRegistry(backend);
    if (candidate.revision !== current.revision) {
      throw hubRegistryError(
        `registry revision conflict: expected ${candidate.revision}, current ${current.revision}`,
        "HUB_REGISTRY_CONFLICT",
      );
    }
    reconcileSavedProjectRevisions(current, candidate);
    const prepared = prepareRegistryWrite(candidate, current.revision, mutationId);
    let committed: Awaited<ReturnType<RegistryBackend["compareAndSwapRegistry"]>>;
    try {
      committed = await compareAndSwapRegistry(backend, current.revision, prepared, mutationId);
    } catch (error) {
      if (!redisCommitOutcomeIsUnknown(error)) throw error;
      const resolution = await resolveAmbiguousRedisCommit(backend, current.revision, prepared, mutationId, error);
      if (resolution.status === "committed") {
        throw hubRegistryCommittedError("registry committed after an ambiguous Redis CAS response", error, {
          mutationId,
          committedRegistry: resolution.registry,
        });
      }
      if (resolution.status === "unknown") {
        throw hubRegistryCommitUnknownError("registry Redis CAS outcome could not be confirmed", resolution.cause, { mutationId });
      }
      committed = { committed: false, revision: prepared.registry.revision };
    }
    if (!committed.committed) {
      throw hubRegistryError(
        `registry revision conflict: expected ${current.revision}, current ${committed.revision}`,
        "HUB_REGISTRY_CONFLICT",
      );
    }
    return prepared.registry;
  }
  try {
    const committed = await withRegistryLock(hubRoot, async (lease) => {
      const current = await loadLocalRegistry(hubRoot);
      if (candidate.revision !== current.revision) {
        throw hubRegistryError(
          `registry revision conflict: expected ${candidate.revision}, current ${current.revision}`,
          "HUB_REGISTRY_CONFLICT",
        );
      }
      reconcileSavedProjectRevisions(current, candidate);
      await lease.assertOwned();
      const committedRegistry = await writeRegistryUnlocked(hubRoot, candidate, current.revision, mutationId);
      return { mutationId, committedRegistry };
    });
    return committed.committedRegistry;
  } catch (error) {
    if (isHubRegistryCommittedError(error) || isHubRegistryCommitUnknownError(error)) throw error;
    const committedResult = (error as {
      committedResult?: { mutationId?: string; committedRegistry?: RegistryRecord };
    }).committedResult;
    if ((error as { code?: unknown }).code === "HUB_REGISTRY_LOCK_RELEASE_FAILED" && committedResult?.committedRegistry) {
      const confirmed = await confirmLocalRegistryMutation(hubRoot, committedResult.mutationId || mutationId);
      if (confirmed) {
        throw hubRegistryCommittedError(
          `registry committed but lock release failed: ${path.basename(registryPath(hubRoot))}`,
          error,
          { mutationId, committedRegistry: confirmed },
        );
      }
      throw hubRegistryCommitUnknownError(
        `registry outcome is unknown after lock release failed: ${path.basename(registryPath(hubRoot))}`,
        error,
        { mutationId },
      );
    }
    throw error;
  }
}

export async function mutateRegistry<T>(
  hubRoot: string,
  callback: (registry: RegistryRecord) => Promise<T> | T,
): Promise<T> {
  const mutationId = randomUUID();
  const backend = await configuredRedisState(hubRoot);
  if (backend) {
    for (let attempt = 0; attempt < REGISTRY_CAS_MAX_ATTEMPTS; attempt += 1) {
      await assertHubWritable(hubRoot);
      const registry = await loadRedisRegistry(backend);
      const currentRevision = registry.revision;
      const result = await runRegistryMutationCallback(registry, callback);
      const prepared = prepareRegistryWrite(registry, currentRevision, mutationId);
      let committed: Awaited<ReturnType<RegistryBackend["compareAndSwapRegistry"]>>;
      try {
        committed = await compareAndSwapRegistry(backend, currentRevision, prepared, mutationId);
      } catch (error) {
        if (!redisCommitOutcomeIsUnknown(error)) throw error;
        const resolution = await resolveAmbiguousRedisCommit(backend, currentRevision, prepared, mutationId, error);
        if (resolution.status === "committed") {
          throw hubRegistryCommittedError("registry committed after an ambiguous Redis CAS response", error, {
            mutationId,
            committedRegistry: resolution.registry,
            result,
            receipt: committedReceiptFromResult(result),
          });
        }
        if (resolution.status === "unknown") {
          throw hubRegistryCommitUnknownError("registry Redis CAS outcome could not be confirmed", resolution.cause, {
            mutationId,
            result,
            receipt: committedReceiptFromResult(result),
          });
        }
        committed = { committed: false, revision: prepared.registry.revision };
      }
      if (committed.committed) return result;
      const retryDelay = Math.min(100, 2 ** Math.min(attempt, 6)) + Math.floor(Math.random() * 10);
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
    throw hubRegistryError("registry CAS contention exceeded the retry limit", "HUB_REGISTRY_LOCK_BUSY");
  }
  try {
    const committed = await withRegistryLock(hubRoot, async (lease) => {
      const registry = await loadLocalRegistry(hubRoot);
      const currentRevision = registry.revision;
      const result = await runRegistryMutationCallback(registry, callback);
      await lease.assertOwned();
      try {
        const committedRegistry = await writeRegistryUnlocked(hubRoot, registry, currentRevision, mutationId);
        return { result, committedRegistry, mutationId };
      } catch (error) {
        if (isHubRegistryCommittedError(error)) {
          throw hubRegistryCommittedError(error.message, error.cause, {
            mutationId,
            committedRegistry: error.committedRegistry,
            result,
            receipt: committedReceiptFromResult(result),
          });
        }
        if (isHubRegistryCommitUnknownError(error)) {
          throw hubRegistryCommitUnknownError(error.message, error.cause, {
            mutationId,
            result,
            receipt: committedReceiptFromResult(result),
          });
        }
        throw error;
      }
    });
    return committed.result;
  } catch (error) {
    if (isHubRegistryCommittedError(error) || isHubRegistryCommitUnknownError(error)) throw error;
    const committedResult = (error as {
      committedResult?: { result?: T; committedRegistry?: RegistryRecord; mutationId?: string };
    }).committedResult;
    if ((error as { code?: unknown }).code === "HUB_REGISTRY_LOCK_RELEASE_FAILED" && committedResult?.committedRegistry) {
      const confirmed = await confirmLocalRegistryMutation(hubRoot, committedResult.mutationId || mutationId);
      const details = {
        mutationId,
        result: committedResult.result,
        receipt: committedReceiptFromResult(committedResult.result),
      };
      if (confirmed) {
        throw hubRegistryCommittedError(
          `registry committed but lock release failed: ${path.basename(registryPath(hubRoot))}`,
          error,
          { ...details, committedRegistry: confirmed },
        );
      }
      throw hubRegistryCommitUnknownError(
        `registry outcome is unknown after lock release failed: ${path.basename(registryPath(hubRoot))}`,
        error,
        details,
      );
    }
    throw error;
  }
}

function resolveProjectId(registry: RegistryRecord, preferredId: string, sourcePath: string) {
  const existing = Object.values(registry.projects).find((project) => project.sourcePath === sourcePath);
  if (existing?.id) return existing.id;

  const base = slugify(preferredId || path.basename(sourcePath));
  const current = registry.projects[base];
  if (!current || current.sourcePath === sourcePath) return base;
  return `${base}-${pathHash(sourcePath)}`;
}

function isPathInsideOrEqual(parentPath: string, childPath: string) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateProjectRuntimeRoot(hubRoot: string, id: string, projectRuntimeRoot: string) {
  const expectedRoot = resolveProjectRuntimeRoot(hubRoot, id);
  const resolvedRoot = path.resolve(projectRuntimeRoot);
  if (!isPathInsideOrEqual(expectedRoot, resolvedRoot)) {
    throw new Error(`invalid projectRuntimeRoot: expected path under ${expectedRoot}`);
  }
  return resolvedRoot;
}

function receiptClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreezeReceipt<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeReceipt(child);
  }
  return Object.freeze(value);
}

function immutableProjectRegistrationReceipt(input: ProjectRegistrationReceipt): ProjectRegistrationReceipt {
  return deepFreezeReceipt({
    projectId: input.projectId,
    committedProjectRevision: input.committedProjectRevision,
    previousProject: receiptClone(input.previousProject),
    committedProject: receiptClone(input.committedProject),
  });
}

function receiptDeepEqual(left: unknown, right: unknown) {
  return isDeepStrictEqual(left, right);
}

export async function registerProjectWithReceipt(hubRoot: string, input: HubRecord = {}): Promise<ProjectRegistrationResult> {
  const sourcePath = await canonicalSourcePath(input.sourcePath || process.cwd());
  const generatedMetadata = input.skipCodeGraphGate
    ? {}
    : await generateProjectCapabilityMaps({
      cpbRoot: input.cpbRoot || sourcePath,
      sourcePath,
    });
  try {
    const result = await mutateRegistry(hubRoot, async (registry) => {
      const id = resolveProjectId(registry, input.id || input.name, sourcePath);
      const committedProjectRevision = nextProjectRevision(registry, id);
      const previousProject = registry.projects[id] ? receiptClone(registry.projects[id]) : null;
      const existing: Partial<ProjectRecord> = registry.projects[id] || {};
      const existingMetadata = receiptClone(existing.metadata || {});
      const inputMetadata = receiptClone(input.metadata || {});
      const capabilityMetadata = receiptClone(generatedMetadata);
      const timestamp = nowIso();
      const projectRoot = input.projectRoot ? path.resolve(input.projectRoot) : path.join(sourcePath, "cpb-task");

      const projectRuntimeRoot = input.projectRuntimeRoot
        ? validateProjectRuntimeRoot(hubRoot, id, input.projectRuntimeRoot)
        : existing.projectRuntimeRoot || resolveProjectRuntimeRoot(hubRoot, id);

      const project = {
        ...existing,
        id,
        name: input.name || existing.name || id,
        sourcePath,
        projectRoot,
        projectRuntimeRoot,
        enabled: input.enabled ?? existing.enabled ?? true,
        weight: Number.isFinite(Number(input.weight)) ? Number(input.weight) : existing.weight ?? 1,
        createdAt: existing.createdAt || timestamp,
        updatedAt: timestamp,
        metadata: {
          ...existingMetadata,
          ...inputMetadata,
          ...capabilityMetadata,
        },
      };
      const committedProject = receiptClone(project);

      registry.projects[id] = receiptClone(committedProject);
      return {
        project: receiptClone(committedProject),
        receipt: immutableProjectRegistrationReceipt({
          projectId: id,
          committedProjectRevision,
          previousProject,
          committedProject,
        }),
      };
    });
    return {
      ...result,
      commitWarnings: Object.freeze([]),
    } satisfies ProjectRegistrationResult;
  } catch (error) {
    if (!isHubRegistryCommittedError<{ project: ProjectRecord; receipt: ProjectRegistrationReceipt }>(error)) throw error;
    const result = error.outcome.result;
    if (!result?.project || !result.receipt) throw error;
    const warning: HubRegistryCommitWarning = Object.freeze({
      code: "HUB_REGISTRY_COMMITTED",
      requiresAction: "fail-or-compensate",
      message: error.message,
      mutationId: error.mutationId,
      committedRegistry: error.committedRegistry,
    });
    return {
      project: receiptClone(result.project),
      receipt: result.receipt,
      commitWarnings: Object.freeze([warning]),
    } satisfies ProjectRegistrationResult;
  }
}

export async function compensateProjectRegistration(hubRoot: string, receipt: ProjectRegistrationReceipt) {
  const expectedCommittedProject = receiptClone(receipt.committedProject);
  const previousProject = receiptClone(receipt.previousProject);
  return await mutateRegistry(hubRoot, (registry) => {
    const current = registry.projects[receipt.projectId] || null;
    if ((registry.projectRevisions[receipt.projectId] || 0) !== receipt.committedProjectRevision) {
      throw hubRegistryError(
        `project compensation conflict: ${receipt.projectId} advanced after registration`,
        "HUB_REGISTRY_COMPENSATION_CONFLICT",
      );
    }
    if (!receiptDeepEqual(current, expectedCommittedProject)) {
      throw hubRegistryError(`project compensation conflict: ${receipt.projectId} changed after registration`, "HUB_REGISTRY_COMPENSATION_CONFLICT");
    }
    if (previousProject) {
      registry.projects[receipt.projectId] = receiptClone(previousProject);
    } else {
      delete registry.projects[receipt.projectId];
    }
    return true;
  });
}

export async function registerProject(hubRoot: string, input: HubRecord = {}) {
  const registered = await registerProjectWithReceipt(hubRoot, input);
  const warning = registered.commitWarnings[0];
  if (warning) {
    throw hubRegistryCommittedError(warning.message, warning, {
      mutationId: warning.mutationId,
      committedRegistry: warning.committedRegistry,
      result: registered.project,
      receipt: registered.receipt,
    });
  }
  return registered.project;
}

export async function listProjects(hubRoot: string, { enabledOnly = false }: { enabledOnly?: boolean } = {}) {
  const registry = await loadRegistry(hubRoot);
  return Object.values(registry.projects)
    .filter((project) => !enabledOnly || project.enabled !== false)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getProject(hubRoot: string, id: string) {
  const registry = await loadRegistry(hubRoot);
  return registry.projects[id] || null;
}

export function parseGithubRepo(value: string) {
  const input = String(value || "").trim();
  const parts = input.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("invalid GitHub repo: expected owner/repo");
  }

  const [owner, repo] = parts;
  if (!SAFE_GITHUB_OWNER.test(owner)) {
    throw new Error(`invalid GitHub repo owner: ${owner}`);
  }
  if (!SAFE_GITHUB_REPO.test(repo) || repo === "." || repo === ".." || repo.endsWith(".git")) {
    throw new Error(`invalid GitHub repo name: ${repo}`);
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

export async function bindProjectGithub(hubRoot: string, id: string, repoFullName: string, { triggers = DEFAULT_GITHUB_TRIGGERS }: { triggers?: unknown[] } = {}) {
  if (!SAFE_ID.test(id)) throw new Error(`invalid project id: ${id}`);
  const repo = parseGithubRepo(repoFullName);
  const existing = await getProject(hubRoot, id);
  if (!existing) return null;
  return await updateProject(hubRoot, id, {
    github: {
      ...(existing.github || {}),
      owner: repo.owner,
      repo: repo.repo,
      fullName: repo.fullName,
      triggers: Array.isArray(existing.github?.triggers) ? existing.github.triggers : triggers,
      boundAt: nowIso(),
    },
  });
}

export async function updateProject(hubRoot: string, id: string, patch: HubRecord = {}) {
  if (!SAFE_ID.test(id)) throw new Error(`invalid project id: ${id}`);
  return await mutateRegistry(hubRoot, async (registry) => {
    const existing = registry.projects[id];
    if (!existing) return null;
    const updated = {
      ...existing,
      ...patch,
      id,
      sourcePath: existing.sourcePath,
      projectRoot: patch.projectRoot ? path.resolve(patch.projectRoot) : existing.projectRoot,
      projectRuntimeRoot: patch.projectRuntimeRoot ? validateProjectRuntimeRoot(hubRoot, id, patch.projectRuntimeRoot) : existing.projectRuntimeRoot,
      updatedAt: nowIso(),
    };
    registry.projects[id] = updated;
    return updated;
  });
}

export async function heartbeatWorker(hubRoot: string, id: string, worker: HubRecord = {}) {
  const heartbeat = {
    workerId: worker.workerId || `worker-${process.pid}`,
    pid: worker.pid || process.pid,
    status: worker.status || "online",
    capabilities: Array.isArray(worker.capabilities) ? worker.capabilities : [],
    claimTimeoutMs: worker.claimTimeoutMs ?? undefined,
    lastSeenAt: nowIso(),
  };
  const project = await updateProject(hubRoot, id, { worker: heartbeat });
  const actions: HubRecord[] = [];
  if (project && project.shutdownRequested) {
    actions.push({ action: "stop", reason: "shutdown_requested" });
  }
  return { project, actions };
}

export function deriveWorkerStatus(worker: HubRecord | null | undefined) {
  const status = worker?.status || null;
  if (!status) return "offline";
  if (["online", "idle", "busy", "ready", "running", "starting"].includes(status)) return "online";
  if (["stale", "unhealthy"].includes(status)) return "stale";
  if (["offline", "exited"].includes(status)) return "offline";
  return status;
}

function summarizeProjectWorkers(projects: ProjectRecord[]) {
  const summary = {
    workersOnline: 0,
    workersStale: 0,
    workersOffline: 0,
    workersUnknown: 0,
  };
  for (const project of projects) {
    if (!project.worker) continue;
    const derived = deriveWorkerStatus(project.worker);
    if (derived === "online") summary.workersOnline += 1;
    else if (derived === "stale") summary.workersStale += 1;
    else if (derived === "offline") summary.workersOffline += 1;
    else summary.workersUnknown += 1;
  }
  return summary;
}

export async function hubStatus(hubRoot: string) {
  const registry = await loadRegistry(hubRoot);
  const projects = Object.values(registry.projects);
  return {
    hubRoot: path.resolve(hubRoot),
    registryPath: registryPath(hubRoot),
    projectCount: projects.length,
    enabledProjectCount: projects.filter((project) => project.enabled !== false).length,
    ...summarizeProjectWorkers(projects),
    updatedAt: registry.updatedAt,
  };
}

// ─── hub-runtime.ts ─────────────────────────────────────────────────────────

import { openSync, readSync, closeSync, writeSync, fstatSync } from "node:fs";
const RUNTIME_VERSION = "0.2.0";
const HUB_RUNTIME_STATE_MAX_BYTES = 64 * 1024;

const instances = new Map();

function instanceKey(cpbRoot: string, hubRoot: string) {
  return `${path.resolve(cpbRoot)}\0${path.resolve(hubRoot)}`;
}

function buildRuntimeMeta(cpbRoot: string, hubRoot: string) {
  const processIdentity = captureCurrentExactProcessIdentity();
  return {
    pid: process.pid,
    processIdentity,
    startedAt: new Date().toISOString(),
    cpbRoot: path.resolve(cpbRoot),
    hubRoot: path.resolve(hubRoot),
    version: RUNTIME_VERSION,
    runtime: "node",
    health: "alive",
  };
}

function sameRuntime(a: HubRecord, b: HubRecord) {
  if (a.processIdentity || b.processIdentity) {
    return sameProcessIdentity(a.processIdentity, b.processIdentity);
  }
  return Boolean(
    a &&
    b &&
    a.pid === b.pid &&
    a.startedAt === b.startedAt &&
    path.resolve(a.cpbRoot || "") === path.resolve(b.cpbRoot || "") &&
    path.resolve(a.hubRoot || "") === path.resolve(b.hubRoot || ""),
  );
}

export function getHubRuntime(cpbRoot: string, hubRoot: string) {
  const key = instanceKey(cpbRoot, hubRoot);
  const existing = instances.get(key);
  if (existing) return existing;

  const meta = Object.freeze(buildRuntimeMeta(cpbRoot, hubRoot));
  const statePath = path.join(path.resolve(hubRoot), "state", "hub.json");

  const runtime = {
    ...meta,
    statePath,

    async persist() {
      const current = await readRuntimeState(statePath);
      if (current && !sameRuntime(current, meta) && current.health !== "dead" && current.processIdentity && isProcessIdentityAlive(current.processIdentity)) {
        return { ...current, statePath, skipped: "live-owner-present" };
      }
      await assertHubWritable(hubRoot);
      await writeAtomic(statePath, `${JSON.stringify(meta, null, 2)}\n`);
      return meta;
    },

    status() {
      return { ...meta, statePath };
    },

    async markDead() {
      const current = await readRuntimeState(statePath);
      if (current && !sameRuntime(current, meta) && current.health !== "dead" && current.processIdentity && isProcessIdentityAlive(current.processIdentity)) {
        return { ...current, statePath, skipped: "live-owner-present" };
      }
      const deadMeta = { ...meta, health: "dead", stoppedAt: new Date().toISOString() };
      await writeAtomic(statePath, `${JSON.stringify(deadMeta, null, 2)}\n`);
      return deadMeta;
    },
  };

  instances.set(key, runtime);
  return runtime;
}

async function readRuntimeState(statePath: string) {
  try {
    return parseHubRuntimeState(await readRegularFileBounded(
      statePath,
      HUB_RUNTIME_STATE_MAX_BYTES,
      "HUB_RUNTIME_STATE_UNSAFE",
      "HUB_RUNTIME_STATE_TOO_LARGE",
    ));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    return null;
  }
}

function parseProcessIdentityValue(value: unknown): ProcessIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as LooseRecord;
  const pid = Number(record.pid);
  const birthId = typeof record.birthId === "string" ? record.birthId : "";
  const incarnation = typeof record.incarnation === "string" ? record.incarnation : "";
  const capturedAt = typeof record.capturedAt === "string" ? record.capturedAt : "";
  const processGroupId = Number(record.processGroupId);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || record.birthIdPrecision !== "exact"
    || !birthId
    || incarnation !== `${pid}:${birthId}`
    || !capturedAt
    || Number.isNaN(new Date(capturedAt).getTime())
    || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
    || (record.processGroupId !== undefined && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
  ) return null;
  return {
    pid,
    birthId,
    incarnation,
    capturedAt,
    birthIdPrecision: "exact",
    ...(record.processGroupId === undefined ? {} : { processGroupId }),
  };
}

function parseHubRuntimeState(raw: string): HubRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw hubRegistryError("hub runtime state is not a JSON object", "HUB_RUNTIME_STATE_INVALID");
  }
  const record = parsed as HubRecord;
  const pid = Number(record.pid);
  const identity = parseProcessIdentityValue(record.processIdentity);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !identity || identity.pid !== pid) {
    throw hubRegistryError("hub runtime state is missing a valid process identity", "HUB_RUNTIME_STATE_INVALID");
  }
  return { ...record, pid, processIdentity: identity };
}

type HubLivenessOptions = {
  system?: ProcessTreeSystem;
};

export async function readHubLiveness(hubRoot: string, options: HubLivenessOptions = {}) {
  const statePath = path.join(path.resolve(hubRoot), "state", "hub.json");
  let meta: HubRecord;
  try {
    meta = await readRuntimeState(statePath) as HubRecord;
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) {
      return { alive: false, reason: "no-hub-json" };
    }
    return { alive: true, reason: "unsafe-state", error: errorMessage(err) };
  }
  if (!meta) return { alive: false, reason: "no-hub-json" };

  const identity = meta.processIdentity || null;

  if (meta.health !== "dead" && identity) {
    try {
      const alive = isProcessIdentityAlive(identity, options.system);
      if (alive) {
        return {
          alive: true,
          pid: identity.pid,
          processIdentity: identity,
          startedAt: meta.startedAt,
          version: meta.version,
          runtime: meta.runtime,
        };
      }
      const successor = captureProcessIdentity(identity.pid, { strict: false, system: options.system });
      return {
        alive: false,
        reason: successor ? "process-reused" : "process-gone",
        pid: identity.pid,
        processIdentity: identity,
        successorIdentity: successor || undefined,
        startedAt: meta.startedAt,
      };
    } catch (error) {
      return {
        alive: true,
        reason: "liveness-unknown",
        pid: identity.pid,
        processIdentity: identity,
        error: errorMessage(error),
        startedAt: meta.startedAt,
      };
    }
  }

  if (meta.health === "dead") {
    return {
      alive: false,
      reason: "shutdown",
      pid: meta.pid,
      processIdentity: identity,
      stoppedAt: meta.stoppedAt,
      startedAt: meta.startedAt,
    };
  }
  return { alive: true, reason: "unsafe-state", pid: meta.pid, startedAt: meta.startedAt };
}

export function resetInstances() {
  instances.clear();
}

export { RUNTIME_VERSION };

// ─── hub-cli.ts ─────────────────────────────────────────────────────────────

import { buildChildEnv, buildRuntimeEnv } from "../secret-policy.js";
import { hubConcurrencyEnv, resolveHubConcurrencyLimits } from "../infra.js";

function resolveRoots() {
  const cpbRoot = path.resolve(process.env.CPB_ROOT || ".");
  const executorRoot = path.resolve(process.env.CPB_EXECUTOR_ROOT || cpbRoot);
  const hubRoot = resolveHubRoot(cpbRoot);
  return { cpbRoot, executorRoot, hubRoot };
}

export function buildHubControlPlaneEnv(
  parentEnv = process.env,
  { cpbRoot, executorRoot, hubRoot, port, host, startupToken }: HubRecord = {},
) {
  return buildChildEnv(parentEnv, {
    CPB_ROOT: cpbRoot,
    CPB_EXECUTOR_ROOT: executorRoot,
    CPB_HUB_ROOT: hubRoot,
    CPB_PORT: port == null ? undefined : String(port),
    CPB_HOST: host,
    CPB_ORCHESTRATOR_START_TOKEN: startupToken,
    CPB_HUB_STATE_REDIS_CONFIG_FILE: parentEnv.CPB_HUB_STATE_REDIS_CONFIG_FILE,
  }, { allowKeys: ["CPB_HUB_STATE_REDIS_CONFIG_FILE", "CPB_ORCHESTRATOR_START_TOKEN"] });
}

export function buildHubServerEnv(parentEnv = process.env, options: HubRecord = {}) {
  return buildChildEnv(parentEnv, {
    ...buildHubControlPlaneEnv(parentEnv, options),
    CPB_HUB_BEARER_TOKEN: parentEnv.CPB_HUB_BEARER_TOKEN,
    CPB_HUB_SERVICE_TOKENS_FILE: parentEnv.CPB_HUB_SERVICE_TOKENS_FILE,
    CPB_HUB_OIDC_CONFIG_FILE: parentEnv.CPB_HUB_OIDC_CONFIG_FILE,
    CPB_HUB_STATE_REDIS_CONFIG_FILE: parentEnv.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    CPB_HUB_ACCESS_AUDIT_MAX_BYTES: parentEnv.CPB_HUB_ACCESS_AUDIT_MAX_BYTES,
    CPB_HUB_ALLOW_INSECURE_HTTP: parentEnv.CPB_HUB_ALLOW_INSECURE_HTTP,
  }, { allowKeys: [
    "CPB_HUB_BEARER_TOKEN",
    "CPB_HUB_SERVICE_TOKENS_FILE",
    "CPB_HUB_OIDC_CONFIG_FILE",
    "CPB_HUB_STATE_REDIS_CONFIG_FILE",
    "CPB_HUB_ACCESS_AUDIT_MAX_BYTES",
    "CPB_HUB_ALLOW_INSECURE_HTTP",
  ] });
}

export function buildHubInstallEnv(parentEnv = process.env) {
  return buildRuntimeEnv(parentEnv);
}

function invalidRuntimeState(message: string, code: string) {
  return hubRegistryError(message, code);
}

function runtimeProcessIdentityFromRecord(record: HubRecord, label: string) {
  const pid = Number(record.pid);
  const processIdentity = parseProcessIdentityValue(record.processIdentity);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processIdentity || processIdentity.pid !== pid) {
    throw invalidRuntimeState(`${label} is missing a valid process identity`, "HUB_CONTROL_PLANE_STATE_INVALID");
  }
  return processIdentity;
}

async function writeOrchestratorRuntimeState(
  statePath: string,
  processIdentity: ProcessIdentity,
  hubId: string,
  startupToken: string,
  lockToken: string,
  epoch: number,
  readyAt: string,
) {
  await writeAtomic(statePath, `${JSON.stringify({
    pid: processIdentity.pid,
    processIdentity,
    hubId,
    startupToken,
    lockToken,
    epoch,
    readyAt,
    startedAt: new Date().toISOString(),
    host: os.hostname(),
    version: RUNTIME_VERSION,
  }, null, 2)}\n`);
}

async function readOrchestratorRuntimeState(statePath: string) {
  try {
    const raw = await readRegularFileBounded(
      statePath,
      HUB_RUNTIME_STATE_MAX_BYTES,
      "HUB_ORCHESTRATOR_STATE_UNSAFE",
      "HUB_ORCHESTRATOR_STATE_TOO_LARGE",
    );
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidRuntimeState("orchestrator state is not a JSON object", "HUB_ORCHESTRATOR_STATE_INVALID");
    }
    return parsed as HubRecord;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function stopExpectedControlPlaneProcess(
  label: string,
  processIdentity: ProcessIdentity,
  options: KillTreeOptions = {},
) {
  if (!isProcessIdentityAlive(processIdentity, options.system)) return false;
  await killTree(processIdentity.pid, 5000, {
    ...options,
    requireDescendantScan: true,
    expectedRootIdentity: processIdentity,
  });
  if (isProcessIdentityAlive(processIdentity, options.system)) {
    throw hubRegistryError(`${label} did not stop cleanly: pid ${processIdentity.pid}`, "HUB_CONTROL_PLANE_STOP_FAILED");
  }
  return true;
}

export type HubControlPlaneKind = "hub" | "orchestrator" | "quota-delegate";

export type HubControlPlaneSpawnSpec = {
  kind: HubControlPlaneKind;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
};

type HubLivenessResult = {
  alive: boolean;
  reason?: string;
  pid?: number;
  processIdentity?: ProcessIdentity;
  error?: string;
};

type OrchestratorStatus = {
  status?: string;
  ready?: boolean;
  readyAt?: string | null;
  pid?: number | null;
  hubId?: string | null;
  processIdentity?: ProcessIdentity | null;
  lockToken?: string | null;
  epoch?: number;
};

export type HubControlPlaneStartRuntime = {
  spawnProcess: (spec: HubControlPlaneSpawnSpec) => Promise<number>;
  captureIdentity: (pid: number) => ProcessIdentity | null;
  identityAlive: (identity: ProcessIdentity) => boolean;
  stopProcess: (kind: HubControlPlaneKind, pid: number, identity?: ProcessIdentity) => Promise<void>;
  readHubLiveness: (hubRoot: string) => Promise<HubLivenessResult>;
  readOrchestratorStatus: (hubRoot: string) => Promise<OrchestratorStatus>;
  readDelegateReceipt: (hubRoot: string) => Promise<QuotaDelegateLockReceipt | null>;
  writeOrchestratorState: (
    statePath: string,
    identity: ProcessIdentity,
    hubId: string,
    startupToken: string,
    lockToken: string,
    epoch: number,
    readyAt: string,
  ) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
};

export type HubControlPlaneStartOptions = {
  cpbRoot: string;
  executorRoot: string;
  hubRoot: string;
  port: string;
  host: string;
  hubEnv: NodeJS.ProcessEnv;
  controlEnv: NodeJS.ProcessEnv;
  readinessAttempts?: number;
  readinessIntervalMs?: number;
  hostname?: string;
};

type StartedControlProcess = {
  kind: HubControlPlaneKind;
  pid: number;
  identity?: ProcessIdentity;
  ownerToken?: string;
  generation?: string;
  hubId?: string;
};

function controlPlaneError(message: string, code: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function aggregateOperationErrors(message: string, code: string, errors: unknown[]) {
  const normalized = errors.map((error) => error instanceof Error ? error : new Error(String(error)));
  return Object.assign(new AggregateError(normalized, message, { cause: normalized[0] }), {
    code,
    primaryError: normalized[0],
    cleanupErrors: normalized.slice(1),
  });
}

function expectedOrchestratorHubId(hostname: string, pid: number, startupToken: string) {
  return `${hostname}-${pid}-${startupToken}`;
}

async function spawnAndCaptureControlProcess(
  runtime: HubControlPlaneStartRuntime,
  spec: HubControlPlaneSpawnSpec,
  started: StartedControlProcess[],
) {
  let pid: number;
  try {
    pid = await runtime.spawnProcess(spec);
  } catch (error) {
    const spawnedPid = Number((error as { spawnedPid?: unknown }).spawnedPid);
    if (Number.isSafeInteger(spawnedPid) && spawnedPid > 0) {
      started.push({ kind: spec.kind, pid: spawnedPid });
    }
    throw error;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw controlPlaneError(`${spec.kind} process did not expose a pid after spawn`, "HUB_START_SPAWN_FAILED");
  }
  const process: StartedControlProcess = { kind: spec.kind, pid };
  started.push(process);
  const identity = runtime.captureIdentity(pid);
  if (!identity || identity.pid !== pid) {
    throw controlPlaneError(
      `${spec.kind} process identity could not be captured after spawn`,
      "HUB_START_IDENTITY_UNAVAILABLE",
    );
  }
  process.identity = identity;
  return process;
}

async function waitForHubReadiness(
  hubRoot: string,
  expected: ProcessIdentity,
  runtime: HubControlPlaneStartRuntime,
  attempts: number,
  intervalMs: number,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const liveness = await runtime.readHubLiveness(hubRoot);
    if (
      liveness.alive
      && liveness.reason !== "liveness-unknown"
      && sameProcessIdentity(liveness.processIdentity, expected)
    ) return liveness;
    if (liveness.alive) {
      throw controlPlaneError(
        `hub readiness belongs to an unsafe or different incarnation: ${liveness.reason || "identity-mismatch"}`,
        "HUB_START_READINESS_INVALID",
      );
    }
    if (!runtime.identityAlive(expected)) {
      throw controlPlaneError("hub process exited before becoming ready", "HUB_START_PROCESS_EXITED");
    }
    if (attempt + 1 < attempts) await runtime.sleep(intervalMs);
  }
  throw controlPlaneError("hub failed to become ready before the startup deadline", "HUB_START_TIMEOUT");
}

async function waitForOrchestratorReadiness(
  hubRoot: string,
  expected: ProcessIdentity,
  expectedHubId: string,
  runtime: HubControlPlaneStartRuntime,
  attempts: number,
  intervalMs: number,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await runtime.readOrchestratorStatus(hubRoot);
    if (status.status === "running") {
      if (status.pid === expected.pid && status.hubId === expectedHubId) {
        if (status.processIdentity && !sameProcessIdentity(status.processIdentity, expected)) {
          throw controlPlaneError(
            "orchestrator leader receipt belongs to a different process incarnation",
            "HUB_ORCHESTRATOR_READINESS_INVALID",
          );
        }
        if (!status.ready) {
          if (!runtime.identityAlive(expected)) {
            throw controlPlaneError(
              "orchestrator exited before publishing full initialization readiness",
              "HUB_ORCHESTRATOR_START_FAILED",
            );
          }
          if (attempt + 1 < attempts) await runtime.sleep(intervalMs);
          continue;
        }
        if (
          !sameProcessIdentity(status.processIdentity, expected)
          || typeof status.lockToken !== "string"
          || !status.lockToken
          || !Number.isSafeInteger(status.epoch)
          || Number(status.epoch) <= 0
          || typeof status.readyAt !== "string"
          || !status.readyAt
        ) {
          throw controlPlaneError(
            "orchestrator ready receipt is missing its identity, token, epoch, or timestamp fence",
            "HUB_ORCHESTRATOR_READINESS_INVALID",
          );
        }
        if (!runtime.identityAlive(expected)) {
          throw controlPlaneError(
            "orchestrator exited while publishing its leader receipt",
            "HUB_ORCHESTRATOR_START_FAILED",
          );
        }
        return status;
      }
      throw controlPlaneError(
        "orchestrator leader receipt belongs to another startup generation",
        "HUB_ORCHESTRATOR_START_CONFLICT",
      );
    }
    if (!runtime.identityAlive(expected)) {
      throw controlPlaneError("orchestrator exited before becoming ready", "HUB_ORCHESTRATOR_START_FAILED");
    }
    if (attempt + 1 < attempts) await runtime.sleep(intervalMs);
  }
  throw controlPlaneError("orchestrator failed to become ready before the startup deadline", "HUB_ORCHESTRATOR_START_TIMEOUT");
}

async function waitForDelegateReadiness(
  hubRoot: string,
  expected: ProcessIdentity,
  ownerToken: string,
  runtime: HubControlPlaneStartRuntime,
  attempts: number,
  intervalMs: number,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = await runtime.readDelegateReceipt(hubRoot);
    if (receipt) {
      if (
        receipt.ownerToken === ownerToken
        && sameProcessIdentity(receipt.processIdentity, expected)
        && receipt.generation
      ) {
        if (!runtime.identityAlive(expected)) {
          throw controlPlaneError(
            "quota delegate exited while publishing its lock receipt",
            "HUB_QUOTA_DELEGATE_START_FAILED",
          );
        }
        return receipt;
      }
      if (runtime.identityAlive(receipt.processIdentity)) {
        throw controlPlaneError(
          "quota delegate lock belongs to another live startup generation",
          "HUB_QUOTA_DELEGATE_START_CONFLICT",
        );
      }
    }
    if (!runtime.identityAlive(expected)) {
      throw controlPlaneError("quota delegate exited before becoming ready", "HUB_QUOTA_DELEGATE_START_FAILED");
    }
    if (attempt + 1 < attempts) await runtime.sleep(intervalMs);
  }
  throw controlPlaneError("quota delegate failed to become ready before the startup deadline", "HUB_QUOTA_DELEGATE_START_TIMEOUT");
}

async function verifyOrchestratorReleased(
  hubRoot: string,
  process: StartedControlProcess,
  runtime: HubControlPlaneStartRuntime,
  attempts: number,
  intervalMs: number,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await runtime.readOrchestratorStatus(hubRoot);
    if (
      status.status !== "running"
      || (process.hubId && status.hubId !== process.hubId)
      || (status.processIdentity && process.identity && !sameProcessIdentity(status.processIdentity, process.identity))
    ) return;
    if (attempt + 1 < attempts) await runtime.sleep(intervalMs);
  }
  throw controlPlaneError(
    `orchestrator leader receipt still belongs to pid ${process.pid}`,
    "HUB_ORCHESTRATOR_STOP_UNVERIFIED",
  );
}

async function verifyDelegateReleased(
  hubRoot: string,
  process: StartedControlProcess,
  runtime: HubControlPlaneStartRuntime,
  attempts: number,
  intervalMs: number,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = await runtime.readDelegateReceipt(hubRoot);
    if (
      !receipt
      || receipt.ownerToken !== process.ownerToken
      || (process.identity && !sameProcessIdentity(receipt.processIdentity, process.identity))
      || (process.generation && receipt.generation !== process.generation)
    ) return;
    if (attempt + 1 < attempts) await runtime.sleep(intervalMs);
  }
  throw controlPlaneError(
    `quota delegate lock still belongs to pid ${process.pid}`,
    "HUB_QUOTA_DELEGATE_STOP_UNVERIFIED",
  );
}

async function cleanupStartedControlProcess(
  hubRoot: string,
  process: StartedControlProcess,
  runtime: HubControlPlaneStartRuntime,
  attempts: number,
  intervalMs: number,
) {
  const errors: unknown[] = [];
  try {
    await runtime.stopProcess(process.kind, process.pid, process.identity);
  } catch (error) {
    errors.push(error);
  }
  try {
    if (process.kind === "orchestrator" && process.hubId) {
      await verifyOrchestratorReleased(hubRoot, process, runtime, attempts, intervalMs);
    } else if (process.kind === "quota-delegate" && process.ownerToken) {
      await verifyDelegateReleased(hubRoot, process, runtime, attempts, intervalMs);
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw aggregateOperationErrors(
      `${process.kind} startup cleanup failed`,
      "HUB_START_COMPONENT_CLEANUP_FAILED",
      errors,
    );
  }
}

async function cleanupStartedControlProcesses(
  hubRoot: string,
  started: StartedControlProcess[],
  runtime: HubControlPlaneStartRuntime,
  attempts: number,
  intervalMs: number,
) {
  const errors: unknown[] = [];
  // Teardown is dependency ordered: delegate -> orchestrator -> hub. Keep
  // attempting after a failure, but do not stop the parent hub while one of
  // its children is still in its awaited cleanup/receipt-verification phase.
  for (const process of [...started].reverse()) {
    try {
      await cleanupStartedControlProcess(hubRoot, process, runtime, attempts, intervalMs);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

export async function startHubControlPlane(
  options: HubControlPlaneStartOptions,
  runtime: HubControlPlaneStartRuntime,
) {
  const attempts = Math.max(1, options.readinessAttempts ?? 50);
  const intervalMs = Math.max(0, options.readinessIntervalMs ?? 100);
  const started: StartedControlProcess[] = [];
  try {
    const hub = await spawnAndCaptureControlProcess(runtime, {
      kind: "hub",
      command: process.execPath,
      args: [path.join(options.executorRoot, "server", "index.js")],
      cwd: options.cpbRoot,
      env: options.hubEnv,
      logPath: path.join(options.hubRoot, "hub.log"),
    }, started);
    await waitForHubReadiness(options.hubRoot, hub.identity!, runtime, attempts, intervalMs);

    const startupToken = randomUUID();
    const orchestrator = await spawnAndCaptureControlProcess(runtime, {
      kind: "orchestrator",
      command: process.execPath,
      args: [path.join(options.executorRoot, "cli", "cpb.js"), "hub", "orch", "start"],
      cwd: options.cpbRoot,
      env: { ...options.controlEnv, CPB_ORCHESTRATOR_START_TOKEN: startupToken },
      logPath: path.join(options.hubRoot, "orchestrator.log"),
    }, started);
    orchestrator.hubId = expectedOrchestratorHubId(
      options.hostname || os.hostname(),
      orchestrator.pid,
      startupToken,
    );
    const orchestratorStatus = await waitForOrchestratorReadiness(
      options.hubRoot,
      orchestrator.identity!,
      orchestrator.hubId,
      runtime,
      attempts,
      intervalMs,
    );
    await runtime.writeOrchestratorState(
      path.join(options.hubRoot, "state", "orchestrator.json"),
      orchestrator.identity!,
      orchestrator.hubId,
      startupToken,
      orchestratorStatus.lockToken!,
      orchestratorStatus.epoch!,
      orchestratorStatus.readyAt!,
    );

    let delegateReceipt = await runtime.readDelegateReceipt(options.hubRoot);
    if (delegateReceipt && !runtime.identityAlive(delegateReceipt.processIdentity)) delegateReceipt = null;
    if (!delegateReceipt) {
      const ownerToken = randomUUID();
      const delegate = await spawnAndCaptureControlProcess(runtime, {
        kind: "quota-delegate",
        command: process.execPath,
        args: [
          path.join(options.executorRoot, "server", "services", "quota-delegate.js"),
          "--hub-root", options.hubRoot,
          "--owner-token", ownerToken,
        ],
        cwd: options.cpbRoot,
        env: options.controlEnv,
        logPath: path.join(options.hubRoot, "quota-delegate.log"),
      }, started);
      delegate.ownerToken = ownerToken;
      delegateReceipt = await waitForDelegateReadiness(
        options.hubRoot,
        delegate.identity!,
        ownerToken,
        runtime,
        attempts,
        intervalMs,
      );
      delegate.generation = delegateReceipt.generation;
    }

    runtime.log(`Hub started on http://${options.host}:${options.port} (pid: ${hub.pid})`);
    runtime.log(`Orchestrator started (pid: ${orchestrator.pid})`);
    runtime.log(`Quota delegate ready (pid: ${delegateReceipt.pid}, generation: ${delegateReceipt.generation})`);
    return {
      hubIdentity: hub.identity!,
      orchestratorIdentity: orchestrator.identity!,
      orchestratorHubId: orchestrator.hubId,
      delegateReceipt,
    };
  } catch (primaryError) {
    const cleanupErrors = await cleanupStartedControlProcesses(
      options.hubRoot,
      started,
      runtime,
      attempts,
      intervalMs,
    );
    if (cleanupErrors.length > 0) {
      throw aggregateOperationErrors(
        "hub control-plane startup and cleanup both failed",
        "HUB_START_AND_CLEANUP_FAILED",
        [primaryError, ...cleanupErrors],
      );
    }
    throw primaryError;
  }
}

/**
 * Rotate a log file if it exceeds maxSize by keeping only the last keepSize bytes.
 * Truncates at the first newline boundary to avoid partial lines.
 */
function rotateLogIfNeeded(filePath: string, maxSize = 10 * 1024 * 1024, keepSize = 1024 * 1024) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const info = fstatSync(fd);
    if (info.size <= maxSize) { closeSync(fd); return; }
    const buf = Buffer.alloc(keepSize);
    readSync(fd, buf, 0, keepSize, info.size - keepSize);
    closeSync(fd);
    fd = undefined;
    // Find first newline to avoid partial lines
    const nlIdx = buf.indexOf("\n");
    const trimmed = nlIdx >= 0 ? buf.slice(nlIdx + 1) : buf;
    const wfd = openSync(filePath, "w");
    writeSync(wfd, trimmed);
    closeSync(wfd);
  } catch {
    // File doesn't exist yet or can't be read — that's fine
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

async function spawnDetachedControlProcess(spec: HubControlPlaneSpawnSpec) {
  const { spawn } = await import("node:child_process");
  rotateLogIfNeeded(spec.logPath);
  let logFd: number | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let primaryError: unknown;
  try {
    logFd = openSync(spec.logPath, "a");
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    if (!child.pid) {
      primaryError = controlPlaneError(
        `${spec.kind} process did not expose a pid after spawn`,
        "HUB_START_SPAWN_FAILED",
      );
    }
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown;
  if (logFd !== undefined) {
    try {
      closeSync(logFd);
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError || closeError) {
    const errors = [primaryError, closeError].filter((error) => error !== undefined);
    const failure = errors.length > 1
      ? aggregateOperationErrors(
        `${spec.kind} spawn and log cleanup both failed`,
        "HUB_START_SPAWN_AND_CLEANUP_FAILED",
        errors,
      )
      : errors[0];
    if (failure && typeof failure === "object" && child?.pid) {
      Object.assign(failure, { spawnedPid: child.pid });
    }
    throw failure;
  }
  return child!.pid!;
}

async function productionHubControlPlaneStartRuntime(): Promise<HubControlPlaneStartRuntime> {
  const [{ readLeaderStatus }, { readQuotaDelegateLockReceipt }] = await Promise.all([
    import("../../orchestrator/leader-lock.js"),
    import("../quota-delegate-client.js"),
  ]);
  return {
    spawnProcess: spawnDetachedControlProcess,
    captureIdentity: (pid) => captureProcessIdentity(pid, { strict: true }),
    identityAlive: (identity) => isProcessIdentityAlive(identity),
    stopProcess: async (_kind, pid, identity) => {
      await killTree(pid, 5000, {
        requireDescendantScan: true,
        expectedRootIdentity: identity,
      });
    },
    readHubLiveness: async (root) => await readHubLiveness(root),
    readOrchestratorStatus: async (root) => await readLeaderStatus(root) as OrchestratorStatus,
    readDelegateReceipt: async (root) => await readQuotaDelegateLockReceipt(root),
    writeOrchestratorState: writeOrchestratorRuntimeState,
    sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  };
}

export async function cmdStart() {
  const { cpbRoot, executorRoot, hubRoot } = resolveRoots();

  const { recoverInterruptedHubRestore } = await import("./hub-backup.js");
  await recoverInterruptedHubRestore({
    hubRoot,
    signingKey: process.env.CPB_HUB_BACKUP_SIGNING_KEY,
  });
  await recoverStaleHubMaintenance(hubRoot);
  const { recoverHubAccessAuditArchive } = await import("../audit/hub-access-audit-archive.js");
  await recoverHubAccessAuditArchive({
    hubRoot,
    signingKey: process.env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY,
  });
  await assertHubWritable(hubRoot);

  const liveness = await readHubLiveness(hubRoot);
  if (liveness.alive) {
    if (liveness.reason || !liveness.processIdentity) {
      throw controlPlaneError(
        `Hub startup refused because existing liveness is unverified: ${liveness.reason || "missing-process-identity"}${liveness.error ? ` (${liveness.error})` : ""}`,
        "HUB_START_EXISTING_STATE_UNVERIFIED",
      );
    }
    console.log(`Hub is already running (pid: ${liveness.pid}).`);
    return;
  }

  const port = process.env.CPB_PORT || "3456";
  const host = process.env.CPB_HOST || "127.0.0.1";
  const hubOidc = await openHubOidcProvider({
    configFile: process.env.CPB_HUB_OIDC_CONFIG_FILE,
    hubRoot,
  });
  const hubAuth = await loadHubAuthConfig({
    bearerToken: process.env.CPB_HUB_BEARER_TOKEN,
    serviceTokensFile: process.env.CPB_HUB_SERVICE_TOKENS_FILE,
    hubRoot,
    requireAuthentication: hubOidc.configured,
  });
  const stateBackend = await configuredRedisState(hubRoot);
  await stateBackend?.preflight();
  if (!isLoopbackHost(host) && !hubAuth.required) {
    throw new Error(
      "CPB_HUB_BEARER_TOKEN, CPB_HUB_SERVICE_TOKENS_FILE, or CPB_HUB_OIDC_CONFIG_FILE is required when CPB_HOST is non-loopback",
    );
  }
  assertExplicitInsecureHttpOptIn(
    host,
    process.env.CPB_HUB_ALLOW_INSECURE_HTTP,
    "CPB_HUB_ALLOW_INSECURE_HTTP",
    "CPB Hub",
  );
  const configuredEnv = hubConcurrencyEnv(await resolveHubConcurrencyLimits(hubRoot, {
    maxActivePerProject: process.env.CPB_HUB_MAX_ACTIVE_PER_PROJECT,
    acpProviderMax: process.env.CPB_ACP_POOL_PROVIDER_MAX,
  }));
  const hubProcessEnv = { ...process.env, ...configuredEnv };
  await mkdir(hubRoot, { recursive: true });

  // Rotate worker logs (keep last 5MB)
  try {
    const logsDir = path.join(hubRoot, "logs");
    const logEntries = await readdir(logsDir);
    for (const e of logEntries) {
      if (e.endsWith(".log")) rotateLogIfNeeded(path.join(logsDir, e), 10 * 1024 * 1024, 5 * 1024 * 1024);
    }
  } catch {}
  const controlEnv = buildHubControlPlaneEnv(hubProcessEnv, {
    cpbRoot,
    executorRoot,
    hubRoot,
    port,
    host,
  });
  await startHubControlPlane({
    cpbRoot,
    executorRoot,
    hubRoot,
    port: String(port),
    host,
    hubEnv: buildHubServerEnv(hubProcessEnv, { cpbRoot, executorRoot, hubRoot, port, host }),
    controlEnv,
  }, await productionHubControlPlaneStartRuntime());
}

export type HubControlPlaneStopStep = {
  name: string;
  code: string;
  run: () => Promise<void>;
};

export async function runHubControlPlaneStopSequence(steps: readonly HubControlPlaneStopStep[]) {
  const errors: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      errors.push(Object.assign(
        new Error(`${step.name} failed during hub stop`, {
          cause: error instanceof Error ? error : new Error(String(error)),
        }),
        { code: step.code, component: step.name },
      ));
    }
  }
  if (errors.length > 0) {
    throw Object.assign(new AggregateError(errors, "hub control-plane shutdown failed", { cause: errors[0] }), {
      code: "HUB_CONTROL_PLANE_STOP_FAILED",
      componentErrors: errors,
    });
  }
}

export type HubOrchestratorStopRuntime = {
  stopExpected: (label: string, identity: ProcessIdentity) => Promise<boolean>;
  readStatus: (hubRoot: string) => Promise<OrchestratorStatus>;
  sleep: (ms: number) => Promise<void>;
};

async function productionHubOrchestratorStopRuntime(): Promise<HubOrchestratorStopRuntime> {
  const { readLeaderStatus } = await import("../../orchestrator/leader-lock.js");
  return {
    stopExpected: async (label, identity) => await stopExpectedControlPlaneProcess(label, identity),
    readStatus: async (root) => await readLeaderStatus(root) as OrchestratorStatus,
    sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

async function waitForStoppedOrchestratorReceipt(
  hubRoot: string,
  expectedIdentity: ProcessIdentity,
  expectedHubId: string | null,
  runtime: HubOrchestratorStopRuntime,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await runtime.readStatus(hubRoot);
    if (status.status !== "running") return;
    if (expectedHubId && status.hubId !== expectedHubId) return;
    if (status.pid !== expectedIdentity.pid) return;
    if (status.processIdentity && !sameProcessIdentity(status.processIdentity, expectedIdentity)) return;
    if (attempt < 49) await runtime.sleep(100);
  }
  throw controlPlaneError(
    `orchestrator leader receipt still belongs to pid ${expectedIdentity.pid}`,
    "HUB_ORCHESTRATOR_STOP_UNVERIFIED",
  );
}

export async function stopOrchestratorDuringHubStop(
  hubRoot: string,
  suppliedRuntime?: HubOrchestratorStopRuntime,
) {
  const runtime = suppliedRuntime || await productionHubOrchestratorStopRuntime();
  const statePath = path.join(hubRoot, "state", "orchestrator.json");
  const state = await readOrchestratorRuntimeState(statePath);
  if (!state) {
    const status = await runtime.readStatus(hubRoot);
    if (status.status === "running") {
      throw controlPlaneError(
        "orchestrator is running without an incarnation-bound runtime state",
        "HUB_ORCHESTRATOR_STATE_INVALID",
      );
    }
    return;
  }
  const identity = runtimeProcessIdentityFromRecord(state, "orchestrator state");
  const expectedHubId = typeof state.hubId === "string" && state.hubId ? state.hubId : null;
  const errors: unknown[] = [];
  try {
    await runtime.stopExpected("orchestrator", identity);
  } catch (error) {
    errors.push(error);
  }
  try {
    await waitForStoppedOrchestratorReceipt(hubRoot, identity, expectedHubId, runtime);
  } catch (error) {
    errors.push(error);
  }
  // The runtime state is intentionally retained. Removing or rewriting the
  // fixed pathname after a verify-then-act check could erase a successor's
  // state published during this stop operation.
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw aggregateOperationErrors("orchestrator stop and receipt verification failed", "HUB_ORCHESTRATOR_STOP_FAILED", errors);
  }
  console.log(`Orchestrator stopped (pid: ${identity.pid})`);
}

async function stopManagedWorkersDuringHubStop(hubRoot: string, cpbRoot: string) {
  const { WorkerStore } = await import("../../../shared/orchestrator/worker-store.js");
  const { WorkerSupervisor } = await import("../../orchestrator/worker-supervisor.js");
  const store = new WorkerStore(hubRoot);
  const supervisor = new WorkerSupervisor(hubRoot, cpbRoot, { workerStore: store });
  const workers = await store.listWorkers();
  const liveWorkers = workers.filter((worker) => worker.pid && worker.status !== "exited");
  const stopResults = await Promise.allSettled(
    liveWorkers.map((worker) => supervisor.stopWorker(String(worker.workerId), "hub_stop")),
  );
  const errors: unknown[] = stopResults
    .map((result, index) => ({ result, worker: liveWorkers[index] }))
    .filter((entry): entry is { result: PromiseRejectedResult; worker: typeof liveWorkers[number] } => (
      entry.result.status === "rejected"
    ))
    .map(({ result, worker }) => controlPlaneError(
      `managed worker stop failed: ${worker.workerId}`,
      "HUB_WORKER_STOP_FAILED",
      result.reason,
    ));

  const verificationResults = await Promise.allSettled(liveWorkers.map(async (worker) => {
    const current = await store.getWorker(worker.workerId);
    if (!current || current.status === "exited") return;
    const identity = parseProcessIdentityValue(current.processIdentity || worker.processIdentity);
    if (!identity) {
      throw controlPlaneError(
        `managed worker ${worker.workerId} is missing process identity; refusing pid-only stop`,
        "HUB_WORKER_STATE_INVALID",
      );
    }
    await stopExpectedControlPlaneProcess(`managed worker ${worker.workerId}`, identity);
  }));
  errors.push(...verificationResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason));

  if (errors.length === 0) await store.pruneDead();
  if (errors.length > 0) {
    throw aggregateOperationErrors("managed worker shutdown failed", "HUB_WORKER_SHUTDOWN_FAILED", errors);
  }
  if (liveWorkers.length > 0) console.log(`Managed workers stopped (${liveWorkers.length})`);
}

async function releaseQueueDuringHubStop(hubRoot: string) {
  const { loadQueue, updateEntry } = await import("../hub/hub-queue.js");
  const queue = await loadQueue(hubRoot);
  const inProgress = queue.entries.filter((entry) => entry.status === "in_progress");
  const settled = await Promise.allSettled(inProgress.map((entry) => updateEntry(hubRoot, entry.id, {
    status: "failed",
    updatedAt: new Date().toISOString(),
  })));
  const errors = settled
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw aggregateOperationErrors("queue release failed", "HUB_QUEUE_RELEASE_FAILED", errors);
  }
  if (inProgress.length > 0) console.log(`Queue entries released (${inProgress.length})`);
}

async function flushJobsIndexesDuringHubStop(hubRoot: string, cpbRoot: string) {
  const { rebuildJobsIndex } = await import("../job/job-store.js");
  const projects = (await listProjects(hubRoot)).filter((project) => project.projectRuntimeRoot);
  const settled = await Promise.allSettled(projects.map((project) => (
    rebuildJobsIndex(cpbRoot, { dataRoot: project.projectRuntimeRoot })
  )));
  const errors = settled
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw aggregateOperationErrors("jobs index flush failed", "HUB_JOBS_INDEX_FLUSH_FAILED", errors);
  }
  console.log(`Jobs indexes flushed (${projects.length})`);
}

async function stopQuotaDelegateDuringHubStop(hubRoot: string) {
  const { readQuotaDelegateLockReceipt } = await import("../quota-delegate-client.js");
  const expected = await readQuotaDelegateLockReceipt(hubRoot);
  if (!expected) return;
  const errors: unknown[] = [];
  try {
    await stopExpectedControlPlaneProcess("quota delegate", expected.processIdentity);
  } catch (error) {
    errors.push(error);
  }
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const current = await readQuotaDelegateLockReceipt(hubRoot);
      if (
        !current
        || current.ownerToken !== expected.ownerToken
        || current.generation !== expected.generation
        || !sameProcessIdentity(current.processIdentity, expected.processIdentity)
      ) break;
      if (attempt === 49) {
        throw controlPlaneError(
          "quota delegate lock still belongs to the stopped incarnation",
          "HUB_QUOTA_DELEGATE_STOP_UNVERIFIED",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    errors.push(error);
  }
  // The delegate owns lock cleanup. Never unlink a fixed lock pathname from
  // this process: a successor may have published there after the signal.
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw aggregateOperationErrors("quota delegate stop and lock verification failed", "HUB_QUOTA_DELEGATE_STOP_FAILED", errors);
  }
  console.log(`Quota delegate stopped (pid: ${expected.pid})`);
}

export async function cmdStop() {
  const { cpbRoot, hubRoot } = resolveRoots();
  let liveness: Awaited<ReturnType<typeof readHubLiveness>> | null = null;
  let livenessReadError: unknown;
  try {
    liveness = await readHubLiveness(hubRoot);
  } catch (error) {
    livenessReadError = error;
  }

  await runHubControlPlaneStopSequence([
    {
      name: "orchestrator",
      code: "HUB_ORCHESTRATOR_STOP_FAILED",
      run: async () => await stopOrchestratorDuringHubStop(hubRoot),
    },
    {
      name: "managed workers",
      code: "HUB_WORKER_SHUTDOWN_FAILED",
      run: async () => await stopManagedWorkersDuringHubStop(hubRoot, cpbRoot),
    },
    {
      name: "queue release",
      code: "HUB_QUEUE_RELEASE_FAILED",
      run: async () => await releaseQueueDuringHubStop(hubRoot),
    },
    {
      name: "jobs index flush",
      code: "HUB_JOBS_INDEX_FLUSH_FAILED",
      run: async () => await flushJobsIndexesDuringHubStop(hubRoot, cpbRoot),
    },
    {
      name: "quota delegate",
      code: "HUB_QUOTA_DELEGATE_STOP_FAILED",
      run: async () => await stopQuotaDelegateDuringHubStop(hubRoot),
    },
    {
      name: "hub",
      code: "HUB_STOP_FAILED",
      run: async () => {
        if (livenessReadError !== undefined) throw livenessReadError;
        if (!liveness) {
          throw controlPlaneError("Hub liveness state was not read", "HUB_CONTROL_PLANE_STATE_INVALID");
        }
        if (!liveness.alive) {
          if (liveness.reason === "shutdown") {
            console.log("Hub is not running (graceful shutdown recorded).");
          } else if (liveness.reason === "no-hub-json") {
            console.log("Hub is not running (no state file).");
          } else {
            console.log(`Hub process ${liveness.pid} is not running.`);
          }
          return;
        }
        if (liveness.reason === "liveness-unknown") {
          throw controlPlaneError(
            `Hub incarnation liveness could not be verified: ${liveness.error || "unknown probe failure"}`,
            "HUB_CONTROL_PLANE_LIVENESS_UNVERIFIED",
          );
        }
        if (!liveness.processIdentity) {
          throw hubRegistryError(
            `Hub liveness is unsafe; refusing to signal pid ${liveness.pid || "unknown"}`,
            "HUB_CONTROL_PLANE_STATE_INVALID",
          );
        }
        await stopExpectedControlPlaneProcess("hub", liveness.processIdentity);
        console.log(`Hub stopped (was pid: ${liveness.pid}).`);
      },
    },
  ]);
}

// ─── attention-projection.ts ────────────────────────────────────────────────

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const KIND_RANK = {
  jobs_index_divergent: 0,
  stale_runtime: 1,
  codegraph_unavailable: 2,
  agent_rate_limited: 3,
  workflow_failed: 4,
  dag_node_failed: 5,
  waiting_approval: 6,
  review_ready: 7,
};
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };

const CODEGRAPH_CODES = new Set(["codegraph_unavailable", "missing_codegraph_state", "missing_codegraph_index"]);
const RATE_LIMIT_CODES = new Set(["agent_rate_limited", "rate_limited"]);

function priorityRank(priority: unknown) {
  return (PRIORITY_RANK as Record<string, number>)[String(priority || "")] ?? 9;
}

function normalizeStatus(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[.\s-]+/g, "_");
}

function normalizeText(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function uniqueKeys(keys: (string | null | undefined)[]) {
  return [...new Set(keys.filter(Boolean))];
}

function scopedKey(project: string, kind: string, scope: string, id: string) {
  const value = normalizeText(id);
  return value ? `${project || "system"}:${kind}:${scope}:${value}` : null;
}

function workKey(project: string, kind: string, title: string) {
  return scopedKey(project, kind, "work", title);
}

function queueContextIds(sourceContext: HubRecord | null | undefined) {
  if (!sourceContext || typeof sourceContext !== "object") return [];
  return [
    sourceContext.queueEntryId,
    sourceContext.entryId,
    sourceContext.queue?.entryId,
    sourceContext.previousQueueEntryId,
    sourceContext.retry?.previousQueueEntryId,
    sourceContext.retry?.retryQueueEntryId,
    sourceContext.reviewLoop?.previousQueueEntryId,
    sourceContext.reviewLoop?.retryQueueEntryId,
  ];
}

function queueDedupeKeys(entry: HubRecord, kind: string, project: string, title: string) {
  const metadata = entry.metadata || {};
  return uniqueKeys([
    scopedKey(project, kind, "queue", entry.id),
    scopedKey(project, kind, "job", metadata.originJobId),
    scopedKey(project, kind, "job", metadata.retryJobId),
    ...queueContextIds(metadata.sourceContext).map((id) => scopedKey(project, kind, "queue", id)),
    workKey(project, kind, title),
  ]);
}

function jobDedupeKeys(job: HubRecord, kind: string, project: string, title: string) {
  return uniqueKeys([
    scopedKey(project, kind, "job", job.jobId),
    scopedKey(project, kind, "queue", job.queueEntryId),
    ...queueContextIds(job.sourceContext).map((id) => scopedKey(project, kind, "queue", id)),
    workKey(project, kind, title),
  ]);
}

function toIso(value: unknown) {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ageMs(updatedAt: unknown) {
  if (!updatedAt) return null;
  const time = new Date(updatedAt as string | number | Date).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Date.now() - time);
}

function evidence(type: string, id: string, path: string | null = null) {
  return {
    type,
    id: String(id),
    ...(path ? { path } : {}),
  };
}

function text(value: unknown, fallback: string): string {
  const str = String(value || "").trim();
  return str || fallback;
}

function jobReason(job: HubRecord) {
  const failureCause = isHubRecord(job.failureCause) ? job.failureCause : {};
  return text(
    job.blockedReason || failureCause.reason || failureCause.message || job.lastActivityMessage || job.failureCode,
    "Workflow needs operator attention",
  );
}

function codeForJob(job: HubRecord) {
  const failureCause = isHubRecord(job.failureCause) ? job.failureCause : {};
  return normalizeStatus(job.failureCode || failureCause.kind || failureCause.code || failureCause.status);
}

function attentionItem({
  kind,
  severity,
  project = null,
  title,
  reason,
  impact,
  updatedAt = null,
  priority = null,
  nextHumanAction,
  primaryEvidenceId,
  dedupeKeys = null,
  evidence: evidenceList,
}: HubRecord) {
  const normalizedUpdatedAt = toIso(updatedAt);
  return {
    id: `${project || "system"}:${kind}:${primaryEvidenceId}`,
    severity,
    kind,
    project,
    title,
    reason: text(reason, "Attention required"),
    impact,
    ageMs: ageMs(normalizedUpdatedAt),
    updatedAt: normalizedUpdatedAt,
    nextHumanAction,
    evidence: evidenceList,
    _priority: priority || null,
    _primaryEvidenceId: String(primaryEvidenceId),
    _dedupeKeys: uniqueKeys(dedupeKeys || [`${project || "system"}:${kind}:evidence:${primaryEvidenceId}`]),
  };
}

function queueItem(entry: HubRecord, kind: string, severity: string) {
  const project = entry.projectId || entry.project || null;
  const title = text(entry.description || entry.metadata?.task, "Queued work needs attention");
  const reason = kind === "codegraph_unavailable"
    ? text(entry.metadata?.codegraphReadiness?.reason || entry.metadata?.indexFreshness?.dirtyReasons?.[0], "CodeGraph is unavailable for this queued work")
    : text(entry.metadata?.rateLimitReason || entry.metadata?.reason, "Agent provider rate limit is blocking this queued work");
  const action = kind === "codegraph_unavailable"
    ? { kind: "repair_runtime", label: "Repair runtime", href: "/hub/queue" }
    : { kind: "retry", label: "Retry when capacity is available", href: "/hub/queue" };
  return attentionItem({
    kind,
    severity,
    project,
    title,
    reason,
    impact: "The dispatcher cannot safely start this work until the blocker clears.",
    updatedAt: entry.updatedAt || entry.createdAt,
    priority: entry.priority,
    nextHumanAction: action,
    primaryEvidenceId: entry.id,
    dedupeKeys: queueDedupeKeys(entry, kind, project, title),
    evidence: [evidence("queue", entry.id)],
  });
}

function jobBlockerItem(job: HubRecord, kind: string, severity: string) {
  const project = job.project || null;
  const title = text(job.task, "Workflow needs attention");
  const action = kind === "codegraph_unavailable"
    ? { kind: "repair_runtime", label: "Repair runtime", href: `/inbox/${job.jobId}` }
    : kind === "agent_rate_limited"
      ? { kind: "retry", label: "Retry when capacity is available", href: `/inbox/${job.jobId}` }
      : { kind: "approve", label: "Review approval gate", href: `/inbox/${job.jobId}` };
  return attentionItem({
    kind,
    severity,
    project,
    title,
    reason: jobReason(job),
    impact: "The workflow cannot continue until this blocker is resolved.",
    updatedAt: job.updatedAt || job.createdAt,
    priority: job.priority,
    nextHumanAction: action,
    primaryEvidenceId: job.jobId,
    dedupeKeys: jobDedupeKeys(job, kind, project, title),
    evidence: [evidence("job", job.jobId, job.eventLogPath)],
  });
}

function workflowFailedItem(job: HubRecord) {
  return attentionItem({
    kind: "workflow_failed",
    severity: "warning",
    project: job.project || null,
    title: text(job.task, "Workflow failed"),
    reason: jobReason(job),
    impact: "The requested work is stopped until someone reviews the failure and chooses a recovery path.",
    updatedAt: job.updatedAt || job.createdAt,
    priority: job.priority,
    nextHumanAction: { kind: "retry", label: "Review failure and retry or cancel", href: `/inbox/${job.jobId}` },
    primaryEvidenceId: job.jobId,
    evidence: [evidence("job", job.jobId, job.eventLogPath)],
  });
}

function dagNodeFailedItems(job: HubRecord) {
  const nodeStates = (job.nodeStates || {}) as Record<string, HubRecord>;
  return Object.entries(nodeStates)
    .filter(([, node]) => node?.status === "failed")
    .map(([nodeId, node]) => attentionItem({
      kind: "dag_node_failed",
      severity: "warning",
      project: job.project || null,
      title: `${text(job.task, "Workflow")} failed at ${node.phase || nodeId}`,
      reason: text(node.reason || node.error || jobReason(job), "DAG node failed"),
      impact: "Downstream workflow nodes are blocked until this node is recovered.",
      updatedAt: node.failedAt || job.updatedAt || job.createdAt,
      priority: job.priority,
      nextHumanAction: { kind: "retry", label: "Review failed node and retry", href: `/inbox/${job.jobId}` },
      primaryEvidenceId: `${job.jobId}:${nodeId}`,
      evidence: [evidence("job", `${job.jobId}:${nodeId}`, job.eventLogPath)],
    }));
}

function reviewReadyItem(session: HubRecord) {
  return attentionItem({
    kind: "review_ready",
    severity: "info",
    project: session.project || null,
    title: text(session.intent, "Review ready"),
    reason: "A review session is waiting for user review.",
    impact: "The review loop is paused until the patch is approved or rejected.",
    updatedAt: session.updatedAt || session.createdAt,
    priority: session.priority || "P0",
    nextHumanAction: { kind: "approve", label: "Review and approve or reject", href: `/review/${session.sessionId}` },
    primaryEvidenceId: session.sessionId,
    evidence: [evidence("review", session.sessionId)],
  });
}

function runtimeItems(runtimeHealth: HubRecord | null | undefined) {
  if (!runtimeHealth) return [];
  const items: AttentionItem[] = [];
  const divergence = runtimeHealth.jobsIndexDivergence || {};
  if (numberValue(divergence.count) > 0 || ["warning", "blocker"].includes(String(divergence.severity || ""))) {
    const severity = divergence.severity === "blocker" ? "critical" : "warning";
    items.push(attentionItem({
      kind: "jobs_index_divergent",
      severity,
      title: "Jobs index differs from event log",
      reason: text(divergence.message, `Jobs index divergence count is ${divergence.count ?? "unknown"}.`),
      impact: "Inbox and runtime status can be incomplete until the index is reconciled.",
      nextHumanAction: { kind: "repair_runtime", label: "Reconcile jobs index", href: "/hub/runtime" },
      primaryEvidenceId: "jobs-index",
      evidence: [evidence("runtime_health", "jobs-index")],
    }));
  }

  const staleRuntimeIssue = numberValue(runtimeHealth.staleJobs) > 0
    || (runtimeHealth.blockers || []).some((blocker: HubRecord) => ["release_version_mismatch", "stale_jobs"].includes(blocker?.code));
  if (staleRuntimeIssue) {
    const detail = (runtimeHealth.blockers || []).find((blocker: HubRecord) => ["release_version_mismatch", "stale_jobs"].includes(blocker?.code));
    items.push(attentionItem({
      kind: "stale_runtime",
      severity: "critical",
      title: "Runtime state needs attention",
      reason: text(detail?.message, `${runtimeHealth.staleJobs || 0} stale runtime job(s) detected.`),
      impact: "Runtime actions may target stale state until the environment is refreshed or repaired.",
      nextHumanAction: { kind: "repair_runtime", label: "Inspect runtime health", href: "/hub/runtime" },
      primaryEvidenceId: "runtime",
      evidence: [evidence("runtime_health", "runtime")],
    }));
  }

  const codegraphCount = numberValue(runtimeHealth.queueBlockingCounts?.codegraph_unavailable || runtimeHealth.queueBlockingCounts?.codegraphUnavailable);
  if (codegraphCount > 0) {
    items.push(attentionItem({
      kind: "codegraph_unavailable",
      severity: "warning",
      title: "CodeGraph unavailable",
      reason: `${codegraphCount} queued item(s) are blocked by CodeGraph readiness.`,
      impact: "Workers cannot start affected queue entries until CodeGraph is available.",
      nextHumanAction: { kind: "repair_runtime", label: "Repair CodeGraph", href: "/hub/queue" },
      primaryEvidenceId: "codegraph",
      evidence: [evidence("runtime_health", "codegraph")],
    }));
  }

  const rateCount = numberValue(runtimeHealth.queueBlockingCounts?.agent_rate_limited || runtimeHealth.queueBlockingCounts?.agentRateLimited);
  if (rateCount > 0) {
    items.push(attentionItem({
      kind: "agent_rate_limited",
      severity: "warning",
      title: "Agent provider rate limited",
      reason: `${rateCount} queued item(s) are blocked by provider rate limits.`,
      impact: "Automation will remain delayed until capacity returns or routing changes.",
      nextHumanAction: { kind: "retry", label: "Retry when capacity returns", href: "/hub/queue" },
      primaryEvidenceId: "agent-rate-limit",
      evidence: [evidence("runtime_health", "agent-rate-limit")],
    }));
  }

  return items;
}

function addDeduped(map: Map<string, AttentionItem>, candidate: AttentionItem) {
  const keys = candidate._dedupeKeys?.length ? candidate._dedupeKeys : [candidate.id];
  const key = keys.find((candidateKey: string) => map.has(candidateKey)) || keys[0];
  const existing = map.get(key);
  if (!existing) {
    for (const candidateKey of keys) map.set(candidateKey, candidate);
    return;
  }

  for (const candidateKey of keys) map.set(candidateKey, existing);

  const evidenceKeys = new Set(existing.evidence.map((entry: EvidenceRecord) => `${entry.type}:${entry.id}:${entry.path || ""}`));
  for (const entry of candidate.evidence) {
    const evidenceKey = `${entry.type}:${entry.id}:${entry.path || ""}`;
    if (!evidenceKeys.has(evidenceKey)) {
      existing.evidence.push(entry);
      evidenceKeys.add(evidenceKey);
    }
  }

  if (candidate.evidence.length > existing.evidence.length) {
    Object.assign(existing, {
      title: candidate.title,
      reason: candidate.reason,
      impact: candidate.impact,
      nextHumanAction: candidate.nextHumanAction,
    });
  }
  if ((SEVERITY_RANK[candidate.severity] ?? 9) < (SEVERITY_RANK[existing.severity] ?? 9)) {
    existing.severity = candidate.severity;
  }
  existing._priority = priorityRank(candidate._priority) < priorityRank(existing._priority)
    ? candidate._priority
    : existing._priority;
}

function sortAttention(a: AttentionItem, b: AttentionItem) {
  const severity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  if (severity !== 0) return severity;
  const kind = (KIND_RANK[a.kind] ?? 99) - (KIND_RANK[b.kind] ?? 99);
  if (kind !== 0) return kind;
  const at = a.updatedAt ? new Date(a.updatedAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  const priority = priorityRank(a._priority) - priorityRank(b._priority);
  if (priority !== 0) return priority;
  return a.id.localeCompare(b.id);
}

function publicItem(attentionItem: AttentionItem) {
  const { _priority, _primaryEvidenceId, _dedupeKeys, ...publicFields } = attentionItem;
  return publicFields;
}

export function buildAttentionProjection({
  jobs = [],
  queueEntries = [],
  reviews = [],
  runtimeHealth = null,
}: {
  jobs?: HubRecord[];
  queueEntries?: HubRecord[];
  reviews?: HubRecord[];
  runtimeHealth?: HubRecord | null;
} = {}) {
  const deduped = new Map<string, AttentionItem>();

  for (const runtimeItem of runtimeItems(runtimeHealth)) addDeduped(deduped, runtimeItem);

  for (const entry of queueEntries || []) {
    if (!entry?.id) continue;
    const status = normalizeStatus(entry.status);
    const approvalStatus = normalizeStatus(entry.metadata?.approval?.status);
    if (status === "codegraph_unavailable" || status === "index_unavailable") {
      addDeduped(deduped, queueItem(entry, "codegraph_unavailable", "warning"));
    } else if (status === "agent_rate_limited" || status === "rate_limited") {
      addDeduped(deduped, queueItem(entry, "agent_rate_limited", "warning"));
    } else if (status === "waiting_approval" || approvalStatus === "waiting_approval") {
      addDeduped(deduped, queueItem(entry, "waiting_approval", "warning"));
    }
  }

  for (const job of jobs || []) {
    if (!job?.jobId) continue;
    const code = codeForJob(job);
    const status = normalizeStatus(job.status);
    if (CODEGRAPH_CODES.has(code)) {
      addDeduped(deduped, jobBlockerItem(job, "codegraph_unavailable", "critical"));
    } else if (RATE_LIMIT_CODES.has(code) || status === "agent_rate_limited") {
      addDeduped(deduped, jobBlockerItem(job, "agent_rate_limited", "warning"));
    } else if (status === "waiting_approval" || code === "waiting_approval" || code === "approval_required") {
      addDeduped(deduped, jobBlockerItem(job, "waiting_approval", "warning"));
    } else if (status === "failed") {
      addDeduped(deduped, workflowFailedItem(job));
    }

    for (const dagItem of dagNodeFailedItems(job)) addDeduped(deduped, dagItem);
  }

  for (const session of reviews || []) {
    if (session?.sessionId && session.status === "user_review") {
      addDeduped(deduped, reviewReadyItem(session));
    }
  }

  return [...new Set(deduped.values())].sort(sortAttention).map(publicItem);
}
