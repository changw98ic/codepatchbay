/**
 * Review Session — session lifecycle, bundle building, and review loop.
 *
 * Merged from:
 *   - review-session.ts   (session CRUD, budget, idempotency)
 *   - review-bundle.ts    (bundle assembly from git + artifacts)
 *   - review-loop.ts      (accept/reject bundle, retry queue)
 */

// ─── review-session.ts ────────────────────────────────────────────
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHubRoot } from "../hub/hub-registry.js";
import type { ProcessIdentity } from "../../../core/runtime/process-tree.js";
import {
  readBoundedRegularFileNoFollow,
  withDirectoryProcessFence,
  withDurableDirectoryLock,
  type BoundedRegularFileReadHooks,
} from "../../../core/runtime/durable-directory-lock.js";
import { writeJsonDurableAtomic } from "../../../shared/hub-maintenance.js";
import { canonicalReviewBundleDirectory } from "../../../shared/orchestrator/review-bundle-path.js";
import { LooseRecord } from "../../../shared/types.js";
import {
  parseWorktreeOwnership,
  type ReadyWorktreeOwnership,
  type WorktreeDirectoryIdentity,
} from "../../../core/contracts/worktree-ownership.js";

const LOCK_MAX_ATTEMPTS = 6_000;
const LOCK_BASE_DELAY_MS = 10;
const LOCK_TTL_MS = 30_000;
const REVIEW_SESSION_MAX_BYTES = 16 * 1024 * 1024;
const REVIEW_LOCK_DIRECTORY = ".locks";
const REVIEW_DURABLE_LOCK = "reviews.lock";
const REVIEW_PROCESS_FENCE = "reviews-operation.lock";

export type ReviewSessionStatus =
  | "idle"
  | "researching"
  | "planning"
  | "reviewing"
  | "revising"
  | "user_review"
  | "dispatched"
  | "merge_failed"
  | "expired"
  | "completed"
  | "cancelled";

export interface ReviewSessionIssue extends LooseRecord {
  severity: number;
  description: string;
  message?: string;
}

export interface ReviewSessionRound extends LooseRecord {
  round: number;
  codex: string;
  claude: string;
  codexIssues: ReviewSessionIssue[];
  claudeIssues: ReviewSessionIssue[];
}

export interface ReviewSessionBudget extends LooseRecord {
  maxRounds: number;
  maxPromptBytes: number;
  maxAcpCalls: number;
  usedAcpCalls: number;
  usedPromptBytes: number;
}

export interface ReviewSessionRecord extends LooseRecord {
  sessionId: string;
  project: string;
  intent: string;
  status: ReviewSessionStatus;
  round: number;
  research: { codex: string | null; claude: string | null };
  plan: string | null;
  reviews: ReviewSessionRound[];
  userVerdict: string | null;
  jobId: string | null;
  queueEntryId: string | null;
  budget: ReviewSessionBudget;
  idempotency: { startKey: string | null; dispatchKey: string | null };
  createdAt: string;
  updatedAt: string;
  detail?: string;
  worktreePath?: string;
  mergeError?: string;
  merged?: boolean;
  sourceBaseBranch?: string;
  sourceBaseCommit?: string;
  reviewDecision?: ReviewDecisionJournal;
}

export type ReviewDecisionAction = "accept" | "reject";
export type ReviewDecisionPhase = "intent" | "merge_proof" | "cleanup_proof" | "final";

export type ReviewSourceRepositoryState = {
  symbolicRef: string | null;
  head: string | null;
  baseRefHead: string | null;
  mergeHead: string | null;
  statusPorcelainV2: string;
  indexEntries: string;
  indexTree: string | null;
  captureErrors: string[];
};

export type ReviewMergeProof = {
  outcome: "committed" | "not_committed" | "unconfirmed";
  mergeCommit: string | null;
  parents: string[];
  tree: string | null;
  before: ReviewSourceRepositoryState;
  after: ReviewSourceRepositoryState;
  sourceMutation: boolean;
  errorCode: string | null;
  error: string | null;
};

export type ReviewCleanupProof = {
  outcome: "committed" | "not_committed" | "unconfirmed";
  committed: boolean;
  durabilityConfirmed: boolean;
  quarantinePreserved: boolean;
  successorPreserved: boolean;
  recoveryPaths: string[];
  errorCode: string | null;
  error: string | null;
};

export type ReviewDecisionIntent = {
  createdAt: string;
  sourcePath: string;
  sourceBaseBranch: string;
  sourceBaseCommit: string;
  sourceBefore: ReviewSourceRepositoryState;
  worktreePath: string;
  worktreeBranch: string;
  fixedWorktreeHead: string;
  worktreeOwnership: ReadyWorktreeOwnership;
  quarantineContainerPath: string;
  quarantineContainerDirectory: WorktreeDirectoryIdentity;
  quarantinePath: string;
};

export type ReviewDecisionJournal = {
  version: 1;
  decisionId: string;
  action: ReviewDecisionAction;
  phase: ReviewDecisionPhase;
  intent: ReviewDecisionIntent;
  mergeProof: ReviewMergeProof | null;
  cleanupProof: ReviewCleanupProof | null;
  final: {
    status: "completed" | "expired" | "merge_failed";
    merged: boolean | null;
    completedAt: string;
    errorCode: string | null;
    error: string | null;
  } | null;
};

export type ReviewSessionLockTestHooks = {
  afterRecoveryObserved?: (context: {
    lockDir: string;
    owner: LooseRecord | null;
    ownerToken: string | null;
    kind: "stale" | "incomplete" | "released";
  }) => void | Promise<void>;
  afterQuarantineRename?: (context: {
    lockDir: string;
    quarantineDir: string;
    ownerToken: string | null;
    kind: "stale" | "incomplete" | "released";
  }) => void | Promise<void>;
  captureProcessIdentity?: () => ProcessIdentity | null;
  waitMs?: number;
  makeSessionId?: () => string;
  readFile?: BoundedRegularFileReadHooks;
  beforeSessionPublish?: (context: {
    filePath: string;
    tempPath: string;
    sessionId: string;
  }) => void | Promise<void>;
  afterSessionPublish?: (context: {
    filePath: string;
    tempPath: string;
    sessionId: string;
  }) => void | Promise<void>;
  beforeCreateOpen?: (context: { filePath: string; sessionId: string }) => void | Promise<void>;
  afterCreateOpen?: (context: { filePath: string; sessionId: string }) => void | Promise<void>;
  beforeCreateDirectorySync?: (context: { filePath: string; sessionId: string }) => void | Promise<void>;
};

const reviewSessionLockTestHookStorage = new AsyncLocalStorage<ReviewSessionLockTestHooks>();

export function withReviewSessionLockTestHooksForTests<T>(
  hooks: ReviewSessionLockTestHooks,
  action: () => T,
): T {
  return reviewSessionLockTestHookStorage.run(hooks, action);
}

function reviewSessionTestHooks() {
  return reviewSessionLockTestHookStorage.getStore() || {};
}

type SessionFileGeneration = {
  dev: bigint | number;
  ino: bigint | number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  nlink: number;
};

type SessionFileAuthority = {
  filePath: string;
  generation: SessionFileGeneration;
  sha256: string;
  session: ReviewSessionRecord;
};

type ReviewsDirectoryAuthority = {
  directory: string;
  handle: Awaited<ReturnType<typeof open>>;
  identity: { dev: bigint | number; ino: bigint | number; birthtimeMs: number };
};

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function reviewSessionError(
  message: string,
  code: string,
  metadata: Record<string, unknown> = {},
  cause?: unknown,
) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code, ...metadata },
  );
}

function sessionFileGeneration(info: SessionFileGeneration): SessionFileGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
    nlink: info.nlink,
  };
}

function sameSessionFileGeneration(expected: SessionFileGeneration, actual: SessionFileGeneration) {
  return String(expected.dev) === String(actual.dev)
    && String(expected.ino) === String(actual.ino)
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.birthtimeMs === actual.birthtimeMs
    && expected.nlink === actual.nlink;
}

function sameDirectoryIdentity(
  expected: { dev: bigint | number; ino: bigint | number; birthtimeMs: number },
  actual: { dev: bigint | number; ino: bigint | number; birthtimeMs: number },
) {
  return String(expected.dev) === String(actual.dev)
    && String(expected.ino) === String(actual.ino)
    && expected.birthtimeMs === actual.birthtimeMs;
}

function strictDirectoryOpenFlags() {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw reviewSessionError(
      "strict no-follow directory opens are unavailable",
      "REVIEW_SESSION_DIRECTORY_UNSAFE",
      { committed: false },
    );
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
}

async function isTrustedDarwinRootAlias(component: string) {
  if (process.platform !== "darwin" || !["/etc", "/tmp", "/var"].includes(component)) return false;
  try {
    return await realpath(component) === `/private${component}`;
  } catch {
    return false;
  }
}

async function assertSafeDirectoryChain(directory: string) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      if (await isTrustedDarwinRootAlias(current)) continue;
      throw reviewSessionError(
        `unsafe review session directory component: ${current}`,
        "REVIEW_SESSION_DIRECTORY_UNSAFE",
        { committed: false, recoveryPaths: [current] },
      );
    }
    if (!info.isDirectory()) {
      throw reviewSessionError(
        `review session directory component is not a directory: ${current}`,
        "REVIEW_SESSION_DIRECTORY_UNSAFE",
        { committed: false, recoveryPaths: [current] },
      );
    }
  }
}

async function ensureSafeDirectory(directory: string) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) {
      if (await isTrustedDarwinRootAlias(current)) continue;
      throw reviewSessionError(
        `unsafe review session directory component: ${current}`,
        "REVIEW_SESSION_DIRECTORY_UNSAFE",
        { committed: false, recoveryPaths: [current] },
      );
    }
    if (!info.isDirectory()) {
      throw reviewSessionError(
        `review session directory component is not a directory: ${current}`,
        "REVIEW_SESSION_DIRECTORY_UNSAFE",
        { committed: false, recoveryPaths: [current] },
      );
    }
  }
  await assertSafeDirectoryChain(absolute);
}

async function openReviewsDirectoryAuthority(directory: string, create: boolean) {
  if (create) await ensureSafeDirectory(directory);
  else await assertSafeDirectoryChain(directory);
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw reviewSessionError(
      `unsafe review session directory: ${directory}`,
      "REVIEW_SESSION_DIRECTORY_UNSAFE",
      { committed: false, recoveryPaths: [directory] },
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(directory, strictDirectoryOpenFlags());
  } catch (cause) {
    throw reviewSessionError(
      `review session directory could not be opened safely: ${directory}`,
      "REVIEW_SESSION_DIRECTORY_UNSAFE",
      { committed: false, recoveryPaths: [directory] },
      cause,
    );
  }
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameDirectoryIdentity(before, opened)) {
      throw reviewSessionError(
        `review session directory changed while opening: ${directory}`,
        "REVIEW_SESSION_DIRECTORY_UNSAFE",
        { committed: false, recoveryPaths: [directory] },
      );
    }
    return {
      directory,
      handle,
      identity: { dev: opened.dev, ino: opened.ino, birthtimeMs: opened.birthtimeMs },
    } satisfies ReviewsDirectoryAuthority;
  } catch (error) {
    let closeError: unknown = null;
    try { await handle.close(); } catch (failure) { closeError = failure; }
    if (!closeError) throw error;
    throw new AggregateError([error, closeError], `review session directory open verification failed: ${directory}`, {
      cause: error,
    });
  }
}

async function validateReviewsDirectoryAuthority(authority: ReviewsDirectoryAuthority) {
  await assertSafeDirectoryChain(authority.directory);
  const [descriptor, current] = await Promise.all([
    authority.handle.stat(),
    lstat(authority.directory),
  ]);
  if (
    !descriptor.isDirectory()
    || !current.isDirectory()
    || current.isSymbolicLink()
    || !sameDirectoryIdentity(authority.identity, descriptor)
    || !sameDirectoryIdentity(authority.identity, current)
  ) {
    throw reviewSessionError(
      `review session directory authority changed: ${authority.directory}`,
      "REVIEW_SESSION_DIRECTORY_UNSAFE",
      { committed: false, recoveryPaths: [authority.directory] },
    );
  }
}

async function syncReviewsDirectoryAuthority(authority: ReviewsDirectoryAuthority) {
  await validateReviewsDirectoryAuthority(authority);
  await authority.handle.sync();
  await validateReviewsDirectoryAuthority(authority);
}

async function withReviewsDirectoryAuthority<T>(
  directory: string,
  create: boolean,
  operation: (authority: ReviewsDirectoryAuthority) => Promise<T>,
) {
  const authority = await openReviewsDirectoryAuthority(directory, create);
  let value: T | undefined;
  let primaryError: unknown = null;
  try {
    value = await operation(authority);
  } catch (error) {
    primaryError = error;
  }
  let validationError: unknown = null;
  try {
    await validateReviewsDirectoryAuthority(authority);
  } catch (error) {
    validationError = error;
  }
  let closeError: unknown = null;
  try { await authority.handle.close(); } catch (error) { closeError = error; }
  if (validationError) {
    const errors = [primaryError, validationError, closeError].filter((error) => error !== null);
    const primaryCommitted = primaryError && typeof primaryError === "object"
      && "committed" in primaryError
      && primaryError.committed === true;
    throw Object.assign(
      new AggregateError(errors, `review session directory authority was lost: ${directory}`, {
        cause: validationError,
      }),
      {
        code: errorCode(validationError) || "REVIEW_SESSION_DIRECTORY_UNSAFE",
        committed: primaryCommitted,
        successorPreserved: true,
        recoveryPaths: [directory],
        primaryError,
        validationError,
        closeError,
      },
    );
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    const metadata = primaryError && typeof primaryError === "object"
      ? Object.fromEntries([
        "code",
        "committed",
        "committedPath",
        "recoveryPaths",
        "successorPreserved",
        "quarantinePreserved",
      ].filter((key) => key in primaryError).map((key) => [key, (primaryError as Record<string, unknown>)[key]]))
      : {};
    throw Object.assign(
      new AggregateError([primaryError, closeError], `review session operation and directory close failed: ${directory}`, {
        cause: primaryError,
      }),
      metadata,
      { primaryError, closeError },
    );
  }
  if (closeError) throw closeError;
  return value as T;
}

async function withFileLock<T>(
  reviewsDirectory: string,
  hooks: ReviewSessionLockTestHooks,
  fn: (authority: ReviewsDirectoryAuthority) => Promise<T>,
): Promise<T> {
  await ensureSafeDirectory(reviewsDirectory);
  const lockNamespace = path.join(reviewsDirectory, REVIEW_LOCK_DIRECTORY);
  await ensureSafeDirectory(lockNamespace);
  const durableLock = path.join(lockNamespace, REVIEW_DURABLE_LOCK);
  const processFence = path.join(lockNamespace, REVIEW_PROCESS_FENCE);
  const waitMs = hooks.waitMs ?? LOCK_MAX_ATTEMPTS * LOCK_BASE_DELAY_MS;
  return withDirectoryProcessFence(
    processFence,
    () => withDurableDirectoryLock(
      durableLock,
      () => withReviewsDirectoryAuthority(reviewsDirectory, false, fn),
      {
        ttlMs: LOCK_TTL_MS,
        waitMs,
        retryMs: LOCK_BASE_DELAY_MS,
        hooks: {
          afterRecoveryObserved: ({ lockDir, ownerToken, kind }) => hooks.afterRecoveryObserved?.({
            lockDir,
            owner: null,
            ownerToken,
            kind,
          }),
          afterQuarantineRename: ({ lockDir, quarantineDir, ownerToken, kind }) => (
            hooks.afterQuarantineRename?.({ lockDir, quarantineDir, ownerToken, kind })
          ),
        },
        captureIdentity: hooks.captureProcessIdentity
          ? () => hooks.captureProcessIdentity?.() ?? null
          : undefined,
      },
    ),
    { waitMs },
  );
}

const VALID_TRANSITIONS = {
  idle: ["researching"],
  researching: ["planning", "expired"],
  planning: ["reviewing", "expired"],
  reviewing: ["revising", "user_review", "expired"],
  revising: ["reviewing", "expired"],
  user_review: ["dispatched", "expired", "merge_failed", "completed"],
  dispatched: ["merge_failed", "completed"],
  merge_failed: ["dispatched"],
  expired: [],
};

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validateSessionId(sessionId: string) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("invalid sessionId: must be a non-empty string");
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`invalid sessionId: ${sessionId}`);
  }
  return sessionId;
}

function reviewsDir(cpbRoot: string, options: LooseRecord = {}) {
  const controlRoot = options.controlRoot || options.hubRoot;
  if (controlRoot) return path.join(path.resolve(controlRoot), "reviews");
  return path.join(resolveHubRoot(cpbRoot), "reviews");
}

const REVIEW_SESSION_STATUSES = new Set([
  "idle",
  "researching",
  "planning",
  "reviewing",
  "revising",
  "user_review",
  "dispatched",
  "merge_failed",
  "expired",
  "completed",
  "cancelled",
]);

function isPlainRecord(value: unknown): value is LooseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonValue(value: unknown, field: string, depth = 0, seen = new Set<object>()) {
  if (depth > 64) {
    throw reviewSessionError(`review session JSON is too deeply nested at ${field}`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (seen.has(value)) throw reviewSessionError(`review session JSON contains a cycle at ${field}`, "REVIEW_SESSION_SCHEMA_INVALID");
    seen.add(value);
    value.forEach((entry, index) => validateJsonValue(entry, `${field}[${index}]`, depth + 1, seen));
    seen.delete(value);
    return;
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) throw reviewSessionError(`review session JSON contains a cycle at ${field}`, "REVIEW_SESSION_SCHEMA_INVALID");
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw reviewSessionError(`unsafe review session JSON key at ${field}.${key}`, "REVIEW_SESSION_SCHEMA_INVALID");
      }
      validateJsonValue(entry, `${field}.${key}`, depth + 1, seen);
    }
    seen.delete(value);
    return;
  }
  throw reviewSessionError(`review session field is not JSON-safe: ${field}`, "REVIEW_SESSION_SCHEMA_INVALID");
}

function requireNullableString(value: unknown, field: string): asserts value is string | null {
  if (value !== null && typeof value !== "string") {
    throw reviewSessionError(`review session ${field} must be a string or null`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
}

function requireNonNegativeInteger(value: unknown, field: string, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || Number(value) < (positive ? 1 : 0)) {
    throw reviewSessionError(
      `review session ${field} must be a ${positive ? "positive" : "non-negative"} safe integer`,
      "REVIEW_SESSION_SCHEMA_INVALID",
    );
  }
}

function requireCanonicalTimestamp(value: unknown, field: string) {
  if (
    typeof value !== "string"
    || !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw reviewSessionError(`review session ${field} must be a canonical timestamp`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
}

const REVIEW_DECISION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVIEW_COMMIT_ID = /^[0-9a-f]{40,64}$/;

function requireExactObjectKeys(value: LooseRecord, expected: string[], field: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    throw reviewSessionError(`review session ${field} has unexpected or missing fields`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
}

function requireAbsolutePath(value: unknown, field: string) {
  if (typeof value !== "string" || !value || value.includes("\0") || !path.isAbsolute(value)) {
    throw reviewSessionError(`review session ${field} must be an absolute path`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
}

function requireCommit(value: unknown, field: string, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !REVIEW_COMMIT_ID.test(value)) {
    throw reviewSessionError(`review session ${field} must be a commit object id`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
}

function validateSourceRepositoryState(value: unknown, field: string): asserts value is ReviewSourceRepositoryState {
  if (!isPlainRecord(value)) {
    throw reviewSessionError(`review session ${field} must be an object`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
  requireExactObjectKeys(value, [
    "symbolicRef",
    "head",
    "baseRefHead",
    "mergeHead",
    "statusPorcelainV2",
    "indexEntries",
    "indexTree",
    "captureErrors",
  ], field);
  for (const nullableField of ["symbolicRef", "head", "baseRefHead", "mergeHead", "indexTree"]) {
    const entry = value[nullableField];
    if (entry !== null && typeof entry !== "string") {
      throw reviewSessionError(
        `review session ${field}.${nullableField} must be a string or null`,
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
  }
  for (const commitField of ["head", "baseRefHead", "mergeHead", "indexTree"]) {
    const entry = value[commitField];
    if (entry !== null) requireCommit(entry, `${field}.${commitField}`);
  }
  if (typeof value.symbolicRef === "string" && !value.symbolicRef.startsWith("refs/heads/")) {
    throw reviewSessionError(`review session ${field}.symbolicRef must be a branch ref`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (typeof value.statusPorcelainV2 !== "string" || typeof value.indexEntries !== "string") {
    throw reviewSessionError(`review session ${field} status/index evidence must be strings`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (!Array.isArray(value.captureErrors) || value.captureErrors.some((entry) => typeof entry !== "string")) {
    throw reviewSessionError(`review session ${field}.captureErrors must be a string array`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
}

function sameSourceRepositoryState(
  left: ReviewSourceRepositoryState,
  right: ReviewSourceRepositoryState,
) {
  return left.symbolicRef === right.symbolicRef
    && left.head === right.head
    && left.baseRefHead === right.baseRefHead
    && left.mergeHead === right.mergeHead
    && left.statusPorcelainV2 === right.statusPorcelainV2
    && left.indexEntries === right.indexEntries
    && left.indexTree === right.indexTree
    && left.captureErrors.length === right.captureErrors.length
    && left.captureErrors.every((entry, index) => entry === right.captureErrors[index]);
}

function validateReviewDecision(value: unknown): asserts value is ReviewDecisionJournal {
  if (!isPlainRecord(value)) {
    throw reviewSessionError("review session reviewDecision must be an object", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  requireExactObjectKeys(value, [
    "version",
    "decisionId",
    "action",
    "phase",
    "intent",
    "mergeProof",
    "cleanupProof",
    "final",
  ], "reviewDecision");
  if (value.version !== 1) {
    throw reviewSessionError("review session reviewDecision.version must be 1", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (typeof value.decisionId !== "string" || !REVIEW_DECISION_ID.test(value.decisionId)) {
    throw reviewSessionError("review session reviewDecision.decisionId must be a random UUID", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  const action = value.action;
  if (action !== "accept" && action !== "reject") {
    throw reviewSessionError("review session reviewDecision.action is invalid", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  const phase = value.phase;
  if (phase !== "intent" && phase !== "merge_proof" && phase !== "cleanup_proof" && phase !== "final") {
    throw reviewSessionError("review session reviewDecision.phase is invalid", "REVIEW_SESSION_SCHEMA_INVALID");
  }

  if (!isPlainRecord(value.intent)) {
    throw reviewSessionError("review session reviewDecision.intent must be an object", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  requireExactObjectKeys(value.intent, [
    "createdAt",
    "sourcePath",
    "sourceBaseBranch",
    "sourceBaseCommit",
    "sourceBefore",
    "worktreePath",
    "worktreeBranch",
    "fixedWorktreeHead",
    "worktreeOwnership",
    "quarantineContainerPath",
    "quarantineContainerDirectory",
    "quarantinePath",
  ], "reviewDecision.intent");
  requireCanonicalTimestamp(value.intent.createdAt, "reviewDecision.intent.createdAt");
  for (const field of ["sourcePath", "worktreePath", "quarantineContainerPath", "quarantinePath"]) {
    requireAbsolutePath(value.intent[field], `reviewDecision.intent.${field}`);
  }
  if (
    typeof value.intent.sourceBaseBranch !== "string"
    || !value.intent.sourceBaseBranch.startsWith("refs/heads/")
    || typeof value.intent.worktreeBranch !== "string"
    || !value.intent.worktreeBranch.startsWith("cpb/")
  ) {
    throw reviewSessionError("review session reviewDecision intent branch binding is invalid", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  requireCommit(value.intent.sourceBaseCommit, "reviewDecision.intent.sourceBaseCommit");
  validateSourceRepositoryState(value.intent.sourceBefore, "reviewDecision.intent.sourceBefore");
  requireCommit(value.intent.fixedWorktreeHead, "reviewDecision.intent.fixedWorktreeHead");
  let ownership;
  try {
    ownership = parseWorktreeOwnership(value.intent.worktreeOwnership);
  } catch (cause) {
    throw reviewSessionError(
      "review session reviewDecision worktree ownership is invalid",
      "REVIEW_SESSION_SCHEMA_INVALID",
      {},
      cause,
    );
  }
  if (ownership.state !== "ready") {
    throw reviewSessionError("review session reviewDecision worktree ownership is not ready", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (
    value.intent.sourceBaseBranch !== `refs/heads/${ownership.baseBranch}`
    || value.intent.sourceBaseCommit !== ownership.baseCommit
  ) {
    throw reviewSessionError(
      "review session reviewDecision intent base fields disagree with worktree ownership",
      "REVIEW_SESSION_SCHEMA_INVALID",
    );
  }
  if (
    path.dirname(String(value.intent.quarantinePath)) !== value.intent.quarantineContainerPath
    || path.basename(String(value.intent.quarantinePath)) !== path.basename(String(value.intent.worktreePath))
    || path.dirname(String(value.intent.quarantineContainerPath)) !== path.dirname(String(value.intent.worktreePath))
    || !path.basename(String(value.intent.quarantineContainerPath)).startsWith(".review-quarantine-")
    || !REVIEW_DECISION_ID.test(
      path.basename(String(value.intent.quarantineContainerPath)).slice(".review-quarantine-".length),
    )
  ) {
    throw reviewSessionError(
      "review session reviewDecision quarantine paths are not an exact private sibling binding",
      "REVIEW_SESSION_SCHEMA_INVALID",
    );
  }
  if (!isPlainRecord(value.intent.quarantineContainerDirectory)) {
    throw reviewSessionError(
      "review session reviewDecision quarantine container identity is invalid",
      "REVIEW_SESSION_SCHEMA_INVALID",
    );
  }
  try {
    parseWorktreeOwnership({
      ...ownership,
      directory: value.intent.quarantineContainerDirectory,
    });
  } catch (cause) {
    throw reviewSessionError(
      "review session reviewDecision quarantine container identity is invalid",
      "REVIEW_SESSION_SCHEMA_INVALID",
      {},
      cause,
    );
  }

  let mergeOutcome: "committed" | "not_committed" | "unconfirmed" | null = null;
  let mergeErrorCode: string | null = null;
  let committedMergeCheckoutExact = false;
  if (value.mergeProof !== null) {
    const mergeProof = value.mergeProof;
    if (!isPlainRecord(mergeProof)) {
      throw reviewSessionError("review session reviewDecision.mergeProof must be an object or null", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    requireExactObjectKeys(mergeProof, [
      "outcome",
      "mergeCommit",
      "parents",
      "tree",
      "before",
      "after",
      "sourceMutation",
      "errorCode",
      "error",
    ], "reviewDecision.mergeProof");
    const outcome = mergeProof.outcome;
    if (outcome !== "committed" && outcome !== "not_committed" && outcome !== "unconfirmed") {
      throw reviewSessionError("review session reviewDecision.mergeProof.outcome is invalid", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    mergeOutcome = outcome;
    requireCommit(mergeProof.mergeCommit, "reviewDecision.mergeProof.mergeCommit", true);
    requireCommit(mergeProof.tree, "reviewDecision.mergeProof.tree", true);
    if (!Array.isArray(mergeProof.parents)) {
      throw reviewSessionError("review session reviewDecision.mergeProof.parents must be an array", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    mergeProof.parents.forEach((entry, index) => requireCommit(entry, `reviewDecision.mergeProof.parents[${index}]`));
    const mergeBefore = mergeProof.before;
    const mergeAfter = mergeProof.after;
    validateSourceRepositoryState(mergeBefore, "reviewDecision.mergeProof.before");
    validateSourceRepositoryState(mergeAfter, "reviewDecision.mergeProof.after");
    if (!sameSourceRepositoryState(mergeBefore, value.intent.sourceBefore)) {
      throw reviewSessionError(
        "review session merge proof before-state does not match decision intent",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
    const exactUnchanged = mergeBefore.captureErrors.length === 0
      && mergeAfter.captureErrors.length === 0
      && sameSourceRepositoryState(mergeBefore, mergeAfter);
    const sourceMutation = mergeProof.sourceMutation;
    if (typeof sourceMutation !== "boolean") {
      throw reviewSessionError("review session reviewDecision.mergeProof.sourceMutation must be boolean", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    if (sourceMutation !== !exactUnchanged) {
      throw reviewSessionError(
        "review session merge proof sourceMutation disagrees with exact before/after evidence",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
    if ((outcome === "not_committed") !== exactUnchanged) {
      throw reviewSessionError(
        "review session merge proof not_committed outcome lacks exact unchanged evidence",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
    const mergeProofErrorCode = mergeProof.errorCode;
    const mergeProofError = mergeProof.error;
    requireNullableString(mergeProofErrorCode, "reviewDecision.mergeProof.errorCode");
    requireNullableString(mergeProofError, "reviewDecision.mergeProof.error");
    if ((mergeProofErrorCode === null) !== (mergeProofError === null)) {
      throw reviewSessionError(
        "review session merge proof error code/message fields disagree",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
    if (outcome !== "committed" && mergeProofErrorCode === null) {
      throw reviewSessionError(
        "review session non-committed merge proof is missing failure evidence",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
    mergeErrorCode = mergeProofErrorCode;
    if (
      outcome === "committed"
      && (
        mergeProof.mergeCommit === null
        || mergeProof.tree === null
        || mergeProof.parents.length !== 2
        || mergeProof.parents[0] !== value.intent.sourceBaseCommit
        || mergeProof.parents[1] !== value.intent.fixedWorktreeHead
      )
    ) {
      throw reviewSessionError(
        "review session committed merge proof does not match the pinned parents",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
    if (outcome === "not_committed" && mergeProof.mergeCommit !== null) {
      throw reviewSessionError(
        "review session not_committed merge proof cannot name a merge commit",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
    committedMergeCheckoutExact = outcome === "committed"
      && mergeProof.mergeCommit !== null
      && mergeAfter.captureErrors.length === 0
      && mergeAfter.symbolicRef === value.intent.sourceBaseBranch
      && mergeAfter.head === mergeProof.mergeCommit
      && mergeAfter.baseRefHead === mergeProof.mergeCommit
      && mergeAfter.mergeHead === null
      && mergeAfter.statusPorcelainV2 === "";
  }

  let cleanupCommitted: boolean | null = null;
  let cleanupDurabilityConfirmed: boolean | null = null;
  let cleanupErrorCode: string | null = null;
  if (value.cleanupProof !== null) {
    const cleanupProof = value.cleanupProof;
    if (!isPlainRecord(cleanupProof)) {
      throw reviewSessionError("review session reviewDecision.cleanupProof must be an object or null", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    requireExactObjectKeys(cleanupProof, [
      "outcome",
      "committed",
      "durabilityConfirmed",
      "quarantinePreserved",
      "successorPreserved",
      "recoveryPaths",
      "errorCode",
      "error",
    ], "reviewDecision.cleanupProof");
    const outcome = cleanupProof.outcome;
    if (outcome !== "committed" && outcome !== "not_committed" && outcome !== "unconfirmed") {
      throw reviewSessionError("review session reviewDecision.cleanupProof.outcome is invalid", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    const committed = cleanupProof.committed;
    const durabilityConfirmed = cleanupProof.durabilityConfirmed;
    const quarantinePreserved = cleanupProof.quarantinePreserved;
    const successorPreserved = cleanupProof.successorPreserved;
    if (typeof committed !== "boolean") {
      throw reviewSessionError("review session reviewDecision.cleanupProof.committed must be boolean", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    if (typeof durabilityConfirmed !== "boolean") {
      throw reviewSessionError("review session reviewDecision.cleanupProof.durabilityConfirmed must be boolean", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    if (typeof quarantinePreserved !== "boolean") {
      throw reviewSessionError("review session reviewDecision.cleanupProof.quarantinePreserved must be boolean", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    if (typeof successorPreserved !== "boolean") {
      throw reviewSessionError("review session reviewDecision.cleanupProof.successorPreserved must be boolean", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    if (!Array.isArray(cleanupProof.recoveryPaths)) {
      throw reviewSessionError("review session reviewDecision.cleanupProof.recoveryPaths must be an array", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    cleanupProof.recoveryPaths.forEach((entry, index) => (
      requireAbsolutePath(entry, `reviewDecision.cleanupProof.recoveryPaths[${index}]`)
    ));
    const cleanupProofErrorCode = cleanupProof.errorCode;
    const cleanupProofError = cleanupProof.error;
    requireNullableString(cleanupProofErrorCode, "reviewDecision.cleanupProof.errorCode");
    requireNullableString(cleanupProofError, "reviewDecision.cleanupProof.error");
    if ((cleanupProofErrorCode === null) !== (cleanupProofError === null)) {
      throw reviewSessionError(
        "review session cleanup proof error code/message fields disagree",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
    cleanupCommitted = committed;
    cleanupDurabilityConfirmed = durabilityConfirmed;
    cleanupErrorCode = cleanupProofErrorCode;
    if (
      (committed && outcome !== "committed")
      || (!committed && outcome === "committed")
      || (durabilityConfirmed && !committed)
    ) {
      throw reviewSessionError(
        "review session cleanup proof outcome/commit/durability fields disagree",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
  }

  let finalStatus: "completed" | "expired" | "merge_failed" | null = null;
  let finalMerged: boolean | null = null;
  let finalErrorCode: string | null = null;
  if (value.final !== null) {
    const final = value.final;
    if (!isPlainRecord(final)) {
      throw reviewSessionError("review session reviewDecision.final must be an object or null", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    requireExactObjectKeys(final, [
      "status",
      "merged",
      "completedAt",
      "errorCode",
      "error",
    ], "reviewDecision.final");
    const status = final.status;
    if (status !== "completed" && status !== "expired" && status !== "merge_failed") {
      throw reviewSessionError("review session reviewDecision.final.status is invalid", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    const merged = final.merged;
    if (merged === null) {
      finalMerged = null;
    } else if (typeof merged === "boolean") {
      finalMerged = merged;
    } else {
      throw reviewSessionError("review session reviewDecision.final.merged must be boolean or null", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    requireCanonicalTimestamp(final.completedAt, "reviewDecision.final.completedAt");
    const finalProofErrorCode = final.errorCode;
    const finalProofError = final.error;
    requireNullableString(finalProofErrorCode, "reviewDecision.final.errorCode");
    requireNullableString(finalProofError, "reviewDecision.final.error");
    if ((finalProofErrorCode === null) !== (finalProofError === null)) {
      throw reviewSessionError(
        "review session final error code/message fields disagree",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
    finalStatus = status;
    finalErrorCode = finalProofErrorCode;
  }

  if (phase === "intent" && (value.mergeProof !== null || value.cleanupProof !== null || value.final !== null)) {
    throw reviewSessionError("review session reviewDecision intent phase contains later proofs", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (phase === "merge_proof" && (value.mergeProof === null || value.cleanupProof !== null || value.final !== null)) {
    throw reviewSessionError("review session reviewDecision merge_proof phase is inconsistent", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (phase === "cleanup_proof" && (value.cleanupProof === null || value.final !== null)) {
    throw reviewSessionError("review session reviewDecision cleanup_proof phase is inconsistent", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (phase === "final" && value.final === null) {
    throw reviewSessionError("review session reviewDecision final phase is inconsistent", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (action === "accept" && (phase === "merge_proof" || phase === "cleanup_proof") && value.mergeProof === null) {
    throw reviewSessionError("review session accept decision is missing merge proof", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (action === "reject" && value.mergeProof !== null) {
    throw reviewSessionError("review session reject decision cannot contain merge proof", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (finalStatus !== null) {
    if (
      finalStatus === "completed"
      && (
        action !== "accept"
        || finalMerged !== true
        || mergeOutcome !== "committed"
        || mergeErrorCode !== null
        || !committedMergeCheckoutExact
        || cleanupCommitted !== true
        || cleanupDurabilityConfirmed !== true
        || cleanupErrorCode !== null
        || finalErrorCode !== null
      )
    ) {
      throw reviewSessionError("review session completed decision lacks exact merge/cleanup proof", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    if (
      finalStatus === "expired"
      && (
        action !== "reject"
        || finalMerged !== null
        || cleanupCommitted !== true
        || cleanupDurabilityConfirmed !== true
        || cleanupErrorCode !== null
        || finalErrorCode !== null
      )
    ) {
      throw reviewSessionError("review session expired decision lacks exact reject cleanup proof", "REVIEW_SESSION_SCHEMA_INVALID");
    }
    const exactMergedTruth = mergeOutcome === "committed"
      ? true
      : mergeOutcome === "not_committed"
        ? false
        : null;
    if (
      finalStatus === "merge_failed"
      && (
        action !== "accept"
        || mergeOutcome === null
        || finalMerged !== exactMergedTruth
        || finalErrorCode === null
      )
    ) {
      throw reviewSessionError("review session merge_failed decision lacks merge proof", "REVIEW_SESSION_SCHEMA_INVALID");
    }
  }
}

function validateIssues(value: unknown, field: string) {
  if (!Array.isArray(value)) {
    throw reviewSessionError(`review session ${field} must be an array`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
  for (const [index, issue] of value.entries()) {
    if (
      !isPlainRecord(issue)
      || !Number.isSafeInteger(issue.severity)
      || Number(issue.severity) < 0
      || Number(issue.severity) > 3
      || typeof issue.description !== "string"
    ) {
      throw reviewSessionError(`review session ${field}[${index}] is invalid`, "REVIEW_SESSION_SCHEMA_INVALID");
    }
  }
}

function validateReviewSession(value: unknown, expectedSessionId?: string): ReviewSessionRecord {
  validateJsonValue(value, "session");
  if (!isPlainRecord(value)) {
    throw reviewSessionError("review session must be an object", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (typeof value.sessionId !== "string") {
    throw reviewSessionError("review session sessionId must be a string", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  const sessionId = validateSessionId(value.sessionId);
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    throw reviewSessionError(
      `review session identity mismatch: expected ${expectedSessionId}, received ${sessionId}`,
      "REVIEW_SESSION_SCHEMA_INVALID",
    );
  }
  if (typeof value.project !== "string" || !value.project) {
    throw reviewSessionError("review session project must be a non-empty string", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (typeof value.intent !== "string") {
    throw reviewSessionError("review session intent must be a string", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (typeof value.status !== "string" || !REVIEW_SESSION_STATUSES.has(value.status)) {
    throw reviewSessionError(`review session status is invalid: ${String(value.status)}`, "REVIEW_SESSION_SCHEMA_INVALID");
  }
  requireNonNegativeInteger(value.round, "round");
  if (!isPlainRecord(value.research)) {
    throw reviewSessionError("review session research must be an object", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  requireNullableString(value.research.codex, "research.codex");
  requireNullableString(value.research.claude, "research.claude");
  requireNullableString(value.plan, "plan");
  if (!Array.isArray(value.reviews)) {
    throw reviewSessionError("review session reviews must be an array", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  for (const [index, review] of value.reviews.entries()) {
    if (!isPlainRecord(review)) {
      throw reviewSessionError(`review session reviews[${index}] must be an object`, "REVIEW_SESSION_SCHEMA_INVALID");
    }
    requireNonNegativeInteger(review.round, `reviews[${index}].round`, { positive: true });
    if (typeof review.codex !== "string" || typeof review.claude !== "string") {
      throw reviewSessionError(`review session reviews[${index}] responses must be strings`, "REVIEW_SESSION_SCHEMA_INVALID");
    }
    validateIssues(review.codexIssues, `reviews[${index}].codexIssues`);
    validateIssues(review.claudeIssues, `reviews[${index}].claudeIssues`);
  }
  requireNullableString(value.userVerdict, "userVerdict");
  requireNullableString(value.jobId, "jobId");
  requireNullableString(value.queueEntryId, "queueEntryId");
  if (!isPlainRecord(value.budget)) {
    throw reviewSessionError("review session budget must be an object", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  requireNonNegativeInteger(value.budget.maxRounds, "budget.maxRounds", { positive: true });
  requireNonNegativeInteger(value.budget.maxPromptBytes, "budget.maxPromptBytes", { positive: true });
  requireNonNegativeInteger(value.budget.maxAcpCalls, "budget.maxAcpCalls", { positive: true });
  requireNonNegativeInteger(value.budget.usedAcpCalls, "budget.usedAcpCalls");
  requireNonNegativeInteger(value.budget.usedPromptBytes, "budget.usedPromptBytes");
  if (!isPlainRecord(value.idempotency)) {
    throw reviewSessionError("review session idempotency must be an object", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  requireNullableString(value.idempotency.startKey, "idempotency.startKey");
  requireNullableString(value.idempotency.dispatchKey, "idempotency.dispatchKey");
  requireCanonicalTimestamp(value.createdAt, "createdAt");
  requireCanonicalTimestamp(value.updatedAt, "updatedAt");
  for (const field of ["detail", "worktreePath", "mergeError", "sourceBaseBranch", "sourceBaseCommit"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw reviewSessionError(`review session ${field} must be a string`, "REVIEW_SESSION_SCHEMA_INVALID");
    }
  }
  if (
    value.sourceBaseBranch !== undefined
    && (typeof value.sourceBaseBranch !== "string" || !value.sourceBaseBranch.startsWith("refs/heads/"))
  ) {
    throw reviewSessionError("review session sourceBaseBranch must be a branch ref", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (value.sourceBaseCommit !== undefined) requireCommit(value.sourceBaseCommit, "sourceBaseCommit");
  if (value.merged !== undefined && typeof value.merged !== "boolean") {
    throw reviewSessionError("review session merged must be a boolean", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  if (value.reviewDecision !== undefined) {
    const reviewDecision = value.reviewDecision;
    validateReviewDecision(reviewDecision);
    if (reviewDecision.final !== null && value.status !== reviewDecision.final.status) {
      throw reviewSessionError(
        "review session status disagrees with the durable review decision final status",
        "REVIEW_SESSION_SCHEMA_INVALID",
      );
    }
  }
  return value as ReviewSessionRecord;
}

async function readSessionFileAuthority(
  filePath: string,
  expectedSessionId: string,
  hooks: ReviewSessionLockTestHooks,
): Promise<SessionFileAuthority> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(filePath);
  } catch (error) {
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw reviewSessionError(
      `unsafe review session file: ${filePath}`,
      "REVIEW_SESSION_FILE_UNSAFE",
      { committed: false, successorPreserved: true, recoveryPaths: [filePath] },
    );
  }
  let raw: string;
  try {
    raw = await readBoundedRegularFileNoFollow(filePath, {
      maxBytes: REVIEW_SESSION_MAX_BYTES,
      hooks: hooks.readFile,
    });
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") throw cause;
    throw reviewSessionError(
      `unsafe review session bounded read: ${filePath}`,
      errorCode(cause) === "BOUNDED_FILE_TOO_LARGE"
        ? "REVIEW_SESSION_FILE_TOO_LARGE"
        : "REVIEW_SESSION_FILE_UNSAFE",
      { committed: false, successorPreserved: true, recoveryPaths: [filePath] },
      cause,
    );
  }
  const after = await lstat(filePath);
  if (
    !after.isFile()
    || after.isSymbolicLink()
    || after.nlink !== 1
    || !sameSessionFileGeneration(sessionFileGeneration(before), sessionFileGeneration(after))
  ) {
    throw reviewSessionError(
      `review session generation changed during read: ${filePath}`,
      "REVIEW_SESSION_GENERATION_CONFLICT",
      { committed: false, successorPreserved: true, recoveryPaths: [filePath] },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw reviewSessionError(
      `invalid review session JSON: ${filePath}`,
      "REVIEW_SESSION_JSON_INVALID",
      { committed: false, recoveryPaths: [filePath] },
      cause,
    );
  }
  const session = validateReviewSession(parsed, expectedSessionId);
  return {
    filePath,
    generation: sessionFileGeneration(after),
    sha256: createHash("sha256").update(raw).digest("hex"),
    session,
  };
}

function sameSessionAuthority(expected: SessionFileAuthority, actual: SessionFileAuthority) {
  return sameSessionFileGeneration(expected.generation, actual.generation)
    && expected.sha256 === actual.sha256
    && expected.session.sessionId === actual.session.sessionId;
}

async function repinSessionAuthority(
  expected: SessionFileAuthority,
  expectedSessionId: string,
  hooks: ReviewSessionLockTestHooks,
) {
  let current: SessionFileAuthority;
  try {
    current = await readSessionFileAuthority(expected.filePath, expectedSessionId, hooks);
  } catch (cause) {
    throw reviewSessionError(
      `review session successor preserved before publication: ${expected.filePath}`,
      "REVIEW_SESSION_GENERATION_CONFLICT",
      { committed: false, successorPreserved: true, recoveryPaths: [expected.filePath] },
      cause,
    );
  }
  if (!sameSessionAuthority(expected, current)) {
    throw reviewSessionError(
      `review session generation changed before publication: ${expected.filePath}`,
      "REVIEW_SESSION_GENERATION_CONFLICT",
      { committed: false, successorPreserved: true, recoveryPaths: [expected.filePath] },
    );
  }
}

function collectRecoveryPathCandidates(error: unknown, seen = new Set<unknown>()): string[] {
  if (!error || typeof error !== "object" || seen.has(error)) return [];
  seen.add(error);
  const candidate = error as Record<string, unknown> & { cause?: unknown; cleanupErrors?: unknown };
  const own = candidate.recoveryPaths;
  const paths = Array.isArray(own)
    ? own.filter((entry): entry is string => typeof entry === "string")
    : isPlainRecord(own)
      ? Object.values(own).filter((entry): entry is string => typeof entry === "string")
      : [];
  return [...paths,
    ...(error instanceof AggregateError
      ? error.errors.flatMap((nested) => collectRecoveryPathCandidates(nested, seen))
      : []),
    ...(Array.isArray(candidate.cleanupErrors)
      ? candidate.cleanupErrors.flatMap((nested) => collectRecoveryPathCandidates(nested, seen))
      : []),
    ...collectRecoveryPathCandidates(candidate.cause, seen),
  ];
}

async function existingRecoveryPaths(error: unknown, additional: string[] = []) {
  const retained: string[] = [];
  for (const candidate of [...new Set([...collectRecoveryPathCandidates(error), ...additional])]) {
    try {
      await lstat(candidate);
      retained.push(candidate);
    } catch {
      // Unverifiable paths are omitted rather than advertised as recovery evidence.
    }
  }
  return retained;
}

function nestedErrorCode(error: unknown, expected: string, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const candidate = error as { code?: unknown; cause?: unknown; primaryError?: unknown; cleanupErrors?: unknown };
  return candidate.code === expected
    || nestedErrorCode(candidate.primaryError, expected, seen)
    || nestedErrorCode(candidate.cause, expected, seen)
    || (error instanceof AggregateError && error.errors.some((nested) => nestedErrorCode(nested, expected, seen)))
    || (Array.isArray(candidate.cleanupErrors)
      && candidate.cleanupErrors.some((nested) => nestedErrorCode(nested, expected, seen)));
}

async function writeSessionFile(
  authority: ReviewsDirectoryAuthority,
  predecessor: SessionFileAuthority,
  session: ReviewSessionRecord,
  hooks: ReviewSessionLockTestHooks,
) {
  const sessionId = String(session.sessionId);
  validateReviewSession(session, sessionId);
  try {
    await writeJsonDurableAtomic(predecessor.filePath, session, {
      syncParentDirectory: async (directory) => {
        if (path.resolve(directory) !== path.resolve(authority.directory)) {
          throw reviewSessionError(
            `review session sync escaped directory authority: ${directory}`,
            "REVIEW_SESSION_DIRECTORY_UNSAFE",
            { committed: true, recoveryPaths: [predecessor.filePath, authority.directory] },
          );
        }
        await syncReviewsDirectoryAuthority(authority);
      },
      beforePublishRename: async ({ filePath, tempPath }) => {
        await hooks.beforeSessionPublish?.({ filePath, tempPath, sessionId });
        await validateReviewsDirectoryAuthority(authority);
        await repinSessionAuthority(predecessor, sessionId, hooks);
      },
      afterPublishRename: async ({ filePath, tempPath }) => {
        await hooks.afterSessionPublish?.({ filePath, tempPath, sessionId });
        await validateReviewsDirectoryAuthority(authority);
      },
    });
    const published = await readSessionFileAuthority(predecessor.filePath, sessionId, hooks);
    if (JSON.stringify(published.session) !== JSON.stringify(session)) {
      throw reviewSessionError(
        `review session publication content changed: ${predecessor.filePath}`,
        "REVIEW_SESSION_COMMITTED_PUBLICATION_RACE",
        {
          committed: true,
          successorPreserved: true,
          recoveryPaths: [predecessor.filePath],
        },
      );
    }
  } catch (error) {
    const generationConflict = nestedErrorCode(error, "REVIEW_SESSION_GENERATION_CONFLICT");
    const paths = await existingRecoveryPaths(error, [predecessor.filePath, authority.directory]);
    if (generationConflict && error && typeof error === "object") {
      throw Object.assign(error, {
        code: "REVIEW_SESSION_GENERATION_CONFLICT",
        committed: false,
        successorPreserved: true,
        recoveryPaths: paths,
      });
    }
    if (error && typeof error === "object") {
      const hadCommittedPath = "committedPath" in error;
      const committedPath = hadCommittedPath && typeof error.committedPath === "string"
        && paths.includes(error.committedPath)
        ? error.committedPath
        : null;
      throw Object.assign(error, {
        recoveryPaths: paths,
        ...(hadCommittedPath ? { committedPath } : {}),
      });
    }
    throw error;
  }
}

async function createSessionFileExclusive(
  authority: ReviewsDirectoryAuthority,
  filePath: string,
  session: ReviewSessionRecord,
  hooks: ReviewSessionLockTestHooks,
) {
  const sessionId = String(session.sessionId);
  validateReviewSession(session, sessionId);
  const serialized = `${JSON.stringify(session, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > REVIEW_SESSION_MAX_BYTES) {
    throw reviewSessionError(
      `review session exceeds ${REVIEW_SESSION_MAX_BYTES} bytes: ${filePath}`,
      "REVIEW_SESSION_FILE_TOO_LARGE",
      { committed: false },
    );
  }
  await hooks.beforeCreateOpen?.({ filePath, sessionId });
  await validateReviewsDirectoryAuthority(authority);
  try {
    const existing = await lstat(filePath);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw reviewSessionError(
        `unsafe review session collision target: ${filePath}`,
        "REVIEW_SESSION_FILE_UNSAFE",
        { committed: false, successorPreserved: true, recoveryPaths: [filePath] },
      );
    }
    throw reviewSessionError(
      `review session id already exists: ${sessionId}`,
      "REVIEW_SESSION_ID_COLLISION",
      { committed: false, successorPreserved: true, recoveryPaths: [filePath] },
    );
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await validateReviewsDirectoryAuthority(authority);
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw reviewSessionError(
      `no-follow review session creation is unavailable: ${filePath}`,
      "REVIEW_SESSION_FILE_UNSAFE",
      { committed: false },
    );
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (cause) {
    if (errorCode(cause) === "EEXIST") {
      throw reviewSessionError(
        `review session id already exists: ${sessionId}`,
        "REVIEW_SESSION_ID_COLLISION",
        { committed: false, successorPreserved: true, recoveryPaths: [filePath] },
        cause,
      );
    }
    throw reviewSessionError(
      `review session could not be created exclusively: ${filePath}`,
      errorCode(cause) || "REVIEW_SESSION_CREATE_FAILED",
      { committed: false, recoveryPaths: [authority.directory] },
      cause,
    );
  }

  let primaryError: unknown = null;
  let generation: SessionFileGeneration | null = null;
  let dataSynced = false;
  try {
    await validateReviewsDirectoryAuthority(authority);
    await hooks.afterCreateOpen?.({ filePath, sessionId });
    await validateReviewsDirectoryAuthority(authority);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    dataSynced = true;
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw reviewSessionError(`unsafe newly created review session: ${filePath}`, "REVIEW_SESSION_FILE_UNSAFE");
    }
    generation = sessionFileGeneration(info);
  } catch (error) {
    primaryError = error;
    try {
      const info = await handle.stat();
      if (info.isFile()) generation = sessionFileGeneration(info);
    } catch {
      // The descriptor remains the only authority; no pathname cleanup is attempted.
    }
  }
  let closeError: unknown = null;
  try { await handle.close(); } catch (error) { closeError = error; }
  if (!primaryError && closeError) primaryError = closeError;

  if (!primaryError && generation) {
    try {
      const published = await lstat(filePath);
      if (
        !published.isFile()
        || published.isSymbolicLink()
        || published.nlink !== 1
        || !sameSessionFileGeneration(generation, sessionFileGeneration(published))
      ) {
        throw reviewSessionError(
          `review session creation pathname authority changed: ${filePath}`,
          "REVIEW_SESSION_COMMITTED_PUBLICATION_RACE",
        );
      }
      await hooks.beforeCreateDirectorySync?.({ filePath, sessionId });
      await syncReviewsDirectoryAuthority(authority);
      const final = await lstat(filePath);
      if (
        !final.isFile()
        || final.isSymbolicLink()
        || final.nlink !== 1
        || !sameSessionFileGeneration(generation, sessionFileGeneration(final))
      ) {
        throw reviewSessionError(
          `review session creation changed after directory sync: ${filePath}`,
          "REVIEW_SESSION_COMMITTED_PUBLICATION_RACE",
        );
      }
      await readSessionFileAuthority(filePath, sessionId, hooks);
      return;
    } catch (error) {
      primaryError = error;
    }
  }

  const paths = await existingRecoveryPaths(primaryError, [filePath, authority.directory]);
  let committedPath: string | null = null;
  let successorPreserved = false;
  try {
    const current = await lstat(filePath);
    if (
      generation
      && current.isFile()
      && !current.isSymbolicLink()
      && current.nlink === 1
      && sameSessionFileGeneration(generation, sessionFileGeneration(current))
    ) committedPath = filePath;
    else successorPreserved = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") successorPreserved = true;
  }
  throw reviewSessionError(
    `review session creation committed with recovery evidence: ${filePath}`,
    errorCode(primaryError) || "REVIEW_SESSION_CREATE_FAILED",
    {
      committed: true,
      publicationCommitted: dataSynced,
      committedPath,
      successorPreserved,
      recoveryPaths: paths,
    },
    primaryError,
  );
}

function positiveEnvironmentInteger(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function makeSessionId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const suffix = randomBytes(3).toString("hex");
  return `rev-${ts}-${suffix}`;
}

export async function createSession(cpbRoot: string, { project, intent, ...options }: LooseRecord) {
  const dir = reviewsDir(cpbRoot, options);
  const hooks = reviewSessionTestHooks();
  return withFileLock(dir, hooks, async (authority) => {
    const sessionId = validateSessionId(hooks.makeSessionId?.() || makeSessionId());
    const now = new Date().toISOString();
    const session = validateReviewSession({
      sessionId,
      project,
      intent,
      status: "idle",
      round: 0,
      research: { codex: null, claude: null },
      plan: null,
      reviews: [],
      userVerdict: null,
      jobId: null,
      queueEntryId: null,
      budget: {
        maxRounds: positiveEnvironmentInteger("CPB_REVIEW_MAX_ROUNDS", 5),
        maxPromptBytes: positiveEnvironmentInteger("CPB_REVIEW_MAX_PROMPT_BYTES", 120_000),
        maxAcpCalls: positiveEnvironmentInteger("CPB_REVIEW_MAX_ACP_CALLS", 30),
        usedAcpCalls: 0,
        usedPromptBytes: 0,
      },
      idempotency: {
        startKey: null,
        dispatchKey: null,
      },
      createdAt: now,
      updatedAt: now,
    }, sessionId);
    const filePath = path.join(authority.directory, `${sessionId}.json`);
    await createSessionFileExclusive(authority, filePath, session, hooks);
    return session;
  });
}

export async function getSession(
  cpbRoot: string,
  sessionId: string,
  options: LooseRecord = {},
): Promise<ReviewSessionRecord | null> {
  const safeId = validateSessionId(sessionId);
  const directory = reviewsDir(cpbRoot, options);
  const hooks = reviewSessionTestHooks();
  try {
    return await withReviewsDirectoryAuthority(directory, false, async (authority) => (
      (await readSessionFileAuthority(
        path.join(authority.directory, `${safeId}.json`),
        safeId,
        hooks,
      )).session
    ));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export async function listSessions(
  cpbRoot: string,
  options: LooseRecord = {},
): Promise<ReviewSessionRecord[]> {
  const directory = reviewsDir(cpbRoot, options);
  const hooks = reviewSessionTestHooks();
  try {
    return await withReviewsDirectoryAuthority(directory, false, async (authority) => {
      const entries = await readdir(authority.directory, { withFileTypes: true });
      await validateReviewsDirectoryAuthority(authority);
      const sessions: ReviewSessionRecord[] = [];
      for (const entry of entries.filter(({ name }) => name.endsWith(".json")).sort((left, right) => (
        right.name.localeCompare(left.name)
      ))) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw reviewSessionError(
            `unsafe review session directory entry: ${entry.name}`,
            "REVIEW_SESSION_FILE_UNSAFE",
            { committed: false, successorPreserved: true, recoveryPaths: [path.join(authority.directory, entry.name)] },
          );
        }
        const id = entry.name.slice(0, -".json".length);
        try {
          validateSessionId(id);
        } catch (cause) {
          throw reviewSessionError(
            `invalid review session directory entry: ${entry.name}`,
            "REVIEW_SESSION_FILE_UNSAFE",
            { committed: false, recoveryPaths: [path.join(authority.directory, entry.name)] },
            cause,
          );
        }
        const filePath = path.join(authority.directory, entry.name);
        try {
          sessions.push((await readSessionFileAuthority(filePath, id, hooks)).session);
        } catch (cause) {
          if (errorCode(cause) !== "ENOENT") throw cause;
          throw reviewSessionError(
            `review session entry disappeared while listing: ${filePath}`,
            "REVIEW_SESSION_GENERATION_CONFLICT",
            { committed: false, successorPreserved: true, recoveryPaths: [authority.directory] },
            cause,
          );
        }
      }
      return sessions;
    });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function updateSessionLocked(
  cpbRoot: string,
  sessionId: string,
  patch: LooseRecord,
  options: LooseRecord = {},
  shouldWrite: (session: ReviewSessionRecord) => boolean = () => true,
) {
  const safeId = validateSessionId(sessionId);
  const { skipTransitionCheck = false } = options;
  if (!isPlainRecord(patch)) {
    throw reviewSessionError("review session patch must be an object", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  validateJsonValue(patch, "patch");

  const dir = reviewsDir(cpbRoot, options);
  const hooks = reviewSessionTestHooks();
  return withFileLock(dir, hooks, async (directoryAuthority) => {
    const filePath = path.join(directoryAuthority.directory, `${safeId}.json`);
    let predecessor: SessionFileAuthority;
    try {
      predecessor = await readSessionFileAuthority(filePath, safeId, hooks);
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Error(`review session not found: ${sessionId}`);
      throw error;
    }
    const session = predecessor.session;
    if (!shouldWrite(session)) return session;

    if (!skipTransitionCheck && patch.status) {
      if (patch.status === session.status) {
        throw new Error(`already in status: ${session.status}`);
      }
      const allowed = VALID_TRANSITIONS[String(session.status) as keyof typeof VALID_TRANSITIONS];
      if (!allowed || typeof patch.status !== "string" || !(allowed as readonly string[]).includes(patch.status)) {
        throw new Error(`invalid transition: ${session.status} → ${patch.status}`);
      }
    }

    const updated = {
      ...session,
      ...patch,
      sessionId: session.sessionId, // immutable
      project: session.project,
      intent: session.intent,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
    };

    const validated = validateReviewSession(updated, safeId);
    await writeSessionFile(directoryAuthority, predecessor, validated, hooks);
    return validated;
  });
}

export async function updateSession(cpbRoot: string, sessionId: string, patch: LooseRecord, options: LooseRecord = {}) {
  return updateSessionLocked(cpbRoot, sessionId, patch, options);
}

export async function updateSessionIfNotCancelled(cpbRoot: string, sessionId: string, patch: LooseRecord, options: LooseRecord = {}) {
  return updateSessionLocked(
    cpbRoot,
    sessionId,
    patch,
    options,
    (session) => session.status !== "cancelled",
  );
}

const CANCELLABLE_REVIEW_SESSION_STATUSES = new Set<ReviewSessionStatus>([
  "idle",
  "researching",
  "planning",
  "reviewing",
  "revising",
  "user_review",
]);

export async function cancelReviewSession(
  cpbRoot: string,
  sessionId: string,
  reason: string,
  options: LooseRecord = {},
) {
  return updateSessionLocked(
    cpbRoot,
    sessionId,
    { status: "cancelled", detail: reason },
    { ...options, skipTransitionCheck: true },
    (session) => session.status === "cancelled"
      || CANCELLABLE_REVIEW_SESSION_STATUSES.has(session.status),
  );
}

export function parseIssues(text: string) {
  if (!text || typeof text !== "string") return [];
  const issues = [];
  const regex = /\[P([0-3])\]\s*(.*?)(?=\n\[P[0-3]\]|$)/gs;
  let match;
  while ((match = regex.exec(text)) !== null) {
    issues.push({
      severity: parseInt(match[1], 10),
      description: match[2].trim(),
    });
  }
  return issues;
}

export async function startSessionResearch(cpbRoot: string, sessionId: string, key: string, options: LooseRecord = {}) {
  const safeId = validateSessionId(sessionId);
  if (typeof key !== "string" || !key) {
    throw reviewSessionError("review session start key must be a non-empty string", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  const dir = reviewsDir(cpbRoot, options);
  const hooks = reviewSessionTestHooks();
  return withFileLock(dir, hooks, async (directoryAuthority) => {
    const filePath = path.join(directoryAuthority.directory, `${safeId}.json`);
    let predecessor: SessionFileAuthority;
    try {
      predecessor = await readSessionFileAuthority(filePath, safeId, hooks);
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Error(`review session not found: ${sessionId}`);
      throw error;
    }
    const session = predecessor.session;

    const existingKey = session.idempotency.startKey;
    if (existingKey === key) return session; // idempotent

    if (existingKey !== null && existingKey !== undefined) {
      throw new Error(`idempotency conflict: session already started with key ${existingKey}`);
    }

    if (session.status !== "idle") {
      throw new Error(`invalid transition: ${session.status} → researching`);
    }

    const updated = {
      ...session,
      status: "researching",
      idempotency: { ...session.idempotency, startKey: key },
      updatedAt: new Date().toISOString(),
    };
    const validated = validateReviewSession(updated, safeId);
    await writeSessionFile(directoryAuthority, predecessor, validated, hooks);
    return validated;
  });
}

export async function noteReviewAcpCall(cpbRoot: string, sessionId: string, { agent, promptBytes }: LooseRecord, options: LooseRecord = {}) {
  const safeId = validateSessionId(sessionId);
  if (typeof agent !== "string" || !agent) {
    throw reviewSessionError("review session ACP agent must be a non-empty string", "REVIEW_SESSION_SCHEMA_INVALID");
  }
  const promptByteCount = promptBytes === undefined ? 0 : promptBytes;
  requireNonNegativeInteger(promptByteCount, "ACP promptBytes");
  const dir = reviewsDir(cpbRoot, options);
  const hooks = reviewSessionTestHooks();
  return withFileLock(dir, hooks, async (directoryAuthority) => {
    const filePath = path.join(directoryAuthority.directory, `${safeId}.json`);
    let predecessor: SessionFileAuthority;
    try {
      predecessor = await readSessionFileAuthority(filePath, safeId, hooks);
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Error(`review session not found: ${sessionId}`);
      throw error;
    }
    const session = predecessor.session;
    const budget = {
      ...session.budget,
      usedAcpCalls: session.budget.usedAcpCalls + 1,
      usedPromptBytes: session.budget.usedPromptBytes + Number(promptByteCount),
    };

    const updated = {
      ...session,
      budget,
      updatedAt: new Date().toISOString(),
    };
    const validated = validateReviewSession(updated, safeId);
    await writeSessionFile(directoryAuthority, predecessor, validated, hooks);
    return validated;
  });
}

export function assertReviewBudget(session: LooseRecord) {
  const budget = session.budget;
  if (!budget) return session;
  if (budget.usedAcpCalls >= budget.maxAcpCalls) {
    throw new Error(`budget exhausted: usedAcpCalls(${budget.usedAcpCalls}) >= maxAcpCalls(${budget.maxAcpCalls})`);
  }
  if (budget.usedPromptBytes >= budget.maxPromptBytes) {
    throw new Error(`budget exhausted: usedPromptBytes(${budget.usedPromptBytes}) >= maxPromptBytes(${budget.usedPromptBytes})`);
  }
  return session;
}

// ─── review-bundle.ts ─────────────────────────────────────────────
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readEventsReadOnly, materializeJob } from "../event/event-store.js";
import { buildArtifactIndex } from "../job/job-projection.js";
import { parseVerdictEnvelope } from "../../../core/workflow/verdict.js";

const execFileAsync = promisify(execFile);

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function recordOrNull(value: unknown): LooseRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : null;
}

function artifactContent(value: unknown): string | null {
  const record = recordValue(value);
  return typeof record.content === "string" ? record.content : null;
}

async function runGit(cwd: string, args: string[], { allowFailure = false }: LooseRecord = {}) {
  try {
    const result = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return { stdout: result.stdout || "", stderr: result.stderr || "", exitCode: 0 };
  } catch (err) {
    if (!allowFailure) throw err;
    return {
      stdout: err?.stdout || "",
      stderr: err?.stderr || err?.message || "",
      exitCode: Number.isInteger(err?.code) ? err.code : 1,
    };
  }
}

async function getDiff(worktreePath: string, sourceHead: string | null) {
  if (!sourceHead) return "";
  const result = await runGit(worktreePath, ["diff", sourceHead, "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

async function getDiffStat(worktreePath: string, sourceHead: string | null) {
  if (!sourceHead) return "";
  const result = await runGit(worktreePath, ["diff", "--stat", sourceHead, "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

async function getChangedFiles(worktreePath: string, sourceHead: string | null) {
  if (!sourceHead) return [];
  const result = await runGit(worktreePath, ["diff", "--name-only", sourceHead, "HEAD"], { allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").filter(Boolean);
}

async function getUncommittedDiff(worktreePath: string) {
  const result = await runGit(worktreePath, ["diff", "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout : "";
}

async function getCurrentHead(repoPath: string) {
  const result = await runGit(repoPath, ["rev-parse", "HEAD"], { allowFailure: true });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function getLog(worktreePath: string, sourceHead: string | null, maxCount: number = 20) {
  if (!sourceHead) return [];
  const result = await runGit(worktreePath, [
    "log", "--oneline", `${sourceHead}..HEAD`, `--max-count=${maxCount}`,
  ], { allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").filter(Boolean);
}

export async function buildReviewBundle(cpbRoot: string, project: string, jobId: string, {
  entry = null,
  job = null,
  sourcePath = null,
  worktreePath = null,
  dataRoot = null,
  wikiDir = null,
} = {}) {
  const events = await readEventsReadOnly(cpbRoot, project, jobId, { dataRoot });
  const jobState = materializeJob(events);

  const worktree = worktreePath || jobState.worktree || job?.worktree || null;
  const baseBranch = jobState.worktreeBaseBranch || job?.worktreeBaseBranch || "main";
  const branch = jobState.worktreeBranch || job?.worktreeBranch || null;

  const artifactIndex = await buildArtifactIndex(cpbRoot, project, jobId, { dataRoot, wikiDir });

  const planArtifact = artifactIndex.entries.find((e) => e.kind === "plan" && !e.broken);
  const deliverableArtifact = artifactIndex.entries.find((e) => e.kind === "deliverable" && !e.broken);
  const verdictArtifact = [...artifactIndex.entries].reverse().find((e) => e.kind === "verdict" && !e.broken);
  const reviewArtifact = artifactIndex.entries.find((e) => e.kind === "review" && !e.broken);
  const promptAudit = artifactIndex.entries
    .filter((e) => e.kind === "prompt")
    .map((e) => ({
      id: e.id,
      phase: e.phase || null,
      path: e.path,
      sha256: e.sha256,
      producerAgent: e.producerAgent || null,
      broken: e.broken,
      reason: e.reason || null,
    }));

  let planContent = null;
  if (planArtifact) {
    try { planContent = await readFile(planArtifact.path, "utf8"); } catch {}
  }

  let deliverableContent = null;
  if (deliverableArtifact) {
    try { deliverableContent = await readFile(deliverableArtifact.path, "utf8"); } catch {}
  }

  let verdictContent = null;
  let verdictParsed = null;
  if (verdictArtifact) {
    try {
      verdictContent = await readFile(verdictArtifact.path, "utf8");
      verdictParsed = parseVerdictEnvelope(verdictContent);
    } catch {}
  }

  let reviewContent = null;
  if (reviewArtifact) {
    try { reviewContent = await readFile(reviewArtifact.path, "utf8"); } catch {}
  }

  let diffEvidence = null;
  let diffStat = null;
  let changedFiles = [];
  let commitLog = [];
  let uncommittedDiff = null;

  if (worktree) {
    const sourceHead = sourcePath ? await getCurrentHead(sourcePath) : null;
    const wtHead = await getCurrentHead(worktree);
    const effectiveSourceHead = sourceHead || (wtHead ? `${wtHead}~1` : null);

    [diffEvidence, diffStat, changedFiles, commitLog, uncommittedDiff] = await Promise.all([
      getDiff(worktree, effectiveSourceHead),
      getDiffStat(worktree, effectiveSourceHead),
      getChangedFiles(worktree, effectiveSourceHead),
      getLog(worktree, effectiveSourceHead),
      getUncommittedDiff(worktree),
    ]);
  }

  const timeline = events.map((ev) => ({
    type: ev.type,
    ts: ev.ts || null,
    phase: ev.phase || null,
    agent: ev.agent || null,
    status: ev.status || null,
  }));

  const metadata = entry?.metadata || {};
  const taskDescription = entry?.description || jobState.task || job?.task || null;

  const bundle = {
    schemaVersion: 1,
    bundleType: "local_review",
    generatedAt: new Date().toISOString(),
    project,
    jobId,

    request: {
      task: taskDescription,
      workflow: metadata.workflow || jobState.workflow || "standard",
      planMode: metadata.planMode || jobState.planMode || "full",
      source: metadata.source || "cli",
      actor: metadata.actor || null,
      requestedAt: metadata.requestedAt || jobState.createdAt || null,
    },

    status: {
      jobStatus: jobState.status,
      completedPhases: jobState.completedPhases,
      failureCode: jobState.failureCode || null,
      failurePhase: jobState.failurePhase || null,
    },

    evidence: {
      plan: planContent ? { path: planArtifact?.path || null, content: planContent } : null,
      deliverable: deliverableContent ? { path: deliverableArtifact?.path || null, content: deliverableContent } : null,
      verdict: verdictParsed || (verdictContent ? { raw: verdictContent } : null),
      review: reviewContent || null,
      diff: diffEvidence || null,
      diffStat: diffStat || null,
      uncommittedDiff: uncommittedDiff || null,
      changedFiles,
      commitLog,
    },

    git: {
      worktree,
      branch,
      baseBranch,
      sourcePath: sourcePath || null,
    },

    timeline,

    dw: buildDwSection(jobState),

    promptAudit,

    links: {
      eventLog: `events/${project}/${jobId}.jsonl`,
      artifacts: artifactIndex.entries.map((e) => ({
        kind: e.kind,
        phase: e.phase || null,
        path: e.path,
        sha256: e.sha256,
        broken: e.broken,
      })),
    },
  };

  return bundle;
}

export async function writeReviewBundle(outputDir: string, bundle: LooseRecord) {
  const slug = `${bundle.project}-${bundle.jobId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `${slug}-review-bundle.json`;
  const filePath = path.join(outputDir, fileName);
  await mkdir(outputDir, { recursive: true });
  await writeFile(filePath, JSON.stringify(bundle, null, 2), "utf8");
  return filePath;
}

/**
 * Build the DW (Dynamic Workflow) evidence section from materialized job state.
 */
function buildDwSection(jobState: LooseRecord) {
  const dag = recordValue(jobState.workflowDag);
  const dagNodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
  const dagEdges = Array.isArray(dag?.edges) ? dag.edges : [];

  return {
    riskMap: jobState.riskMap ?? null,
    workflowDag: dag
      ? {
          name: dag.name ?? jobState.workflow ?? null,
          nodeCount: dagNodes.length,
          edgeCount: dagEdges.length,
          nodes: dagNodes.map((n) => ({
            id: n.id ?? null,
            phase: n.phase ?? n.id ?? null,
            role: n.role ?? null,
          })),
        }
      : null,
    dynamicAgentPlan: jobState.dynamicAgentPlan ?? null,
    verdict: jobState.artifacts?.verdict
      ? { status: jobState.verdict ?? null, artifact: jobState.artifacts.verdict }
      : null,
    adversarialVerdict: jobState.adversarialVerdict ?? null,
    completionGate: jobState.completionGate ?? null,
  };
}

export function reviewBundleDir(hubRoot: string, project: string, jobId: string) {
  void jobId;
  return canonicalReviewBundleDirectory(path.resolve(hubRoot), project);
}

export function reviewBundleDwContract() {
  return {
    includesRiskMap: true,
    includesWorkflowDag: true,
    includesDynamicAgentPlan: true,
    includesAdversarialVerdict: true,
    includesCompletionGate: true,
  };
}

// ─── review-loop.ts ───────────────────────────────────────────────
import { readEventsReadOnly as readEventsReadOnlyForLoop, appendEvent, checkpointJob } from "../event/event-store.js";
import { enqueue, updateEntry } from "../hub/hub-queue.js";
import { updateJobsIndexEntry } from "../job/job-store.js";


function nowIso() {
  return new Date().toISOString();
}

function trimText(value: string, maxChars: number = 6000) {
  const text = String(value || "").trim();
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function bundleIdFor(project: string, jobId: string) {
  return `rb-${project}-${jobId}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

const REVIEWABLE_TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "superseded"]);

export class ReviewLoopError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = "ReviewLoopError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isReviewLoopError(error: unknown): boolean {
  if (error instanceof ReviewLoopError) return true;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "statusCode" in error
  ) {
    return Boolean(error.code && error.statusCode);
  }
  return false;
}

function reviewLoopError(message: string, code: string, statusCode: number) {
  return new ReviewLoopError(message, code, statusCode);
}

function assertReviewableJob(job: LooseRecord) {
  if (!REVIEWABLE_TERMINAL_STATUSES.has(job?.status)) {
    throw reviewLoopError(
      `review bundle can only be accepted or rejected after the job is terminal; current status: ${job?.status || "unknown"}`,
      "REVIEW_JOB_NOT_TERMINAL",
      409,
    );
  }
}

function assertReviewNotFinalized(loop: LooseRecord) {
  const latestVerdict = loop?.latest?.verdict;
  if (latestVerdict === "accepted" || latestVerdict === "rejected") {
    throw reviewLoopError(
      `review bundle already ${latestVerdict}`,
      "REVIEW_BUNDLE_ALREADY_REVIEWED",
      409,
    );
  }
}

async function refreshJobIndex(cpbRoot: string, project: string, jobId: string, { dataRoot }: LooseRecord = {}) {
  const job = await checkpointJob(cpbRoot, project, jobId, { dataRoot })
    || materializeJob(await readEventsReadOnlyForLoop(cpbRoot, project, jobId, { dataRoot }));
  await updateJobsIndexEntry(cpbRoot, project, jobId, job, { dataRoot });
  return job;
}

function reviewLoopState(events: LooseRecord[]) {
  const rounds = [];
  for (const event of events) {
    if (event.type === "review_bundle_accepted" || event.type === "review_bundle_rejected") {
      rounds.push({
        round: event.round ?? rounds.length + 1,
        verdict: event.verdict ?? (event.type === "review_bundle_accepted" ? "accepted" : "rejected"),
        feedback: event.feedback ?? null,
        retryQueueEntryId: event.retryQueueEntryId ?? null,
        bundleId: event.bundleId ?? null,
        actor: event.actor ?? null,
        createdAt: event.ts ?? null,
      });
    }
  }
  return { rounds, nextRound: rounds.length + 1, latest: rounds[rounds.length - 1] ?? null };
}

function retryPreviousOutput(bundle: LooseRecord) {
  const chunks = [];
  const evidence = recordValue(bundle.evidence);
  if (evidence.verdict) {
    chunks.push(`Previous verdict:\n${typeof evidence.verdict === "string" ? evidence.verdict : JSON.stringify(evidence.verdict, null, 2)}`);
  }
  const deliverableContent = artifactContent(evidence.deliverable);
  if (deliverableContent) {
    chunks.push(`Previous deliverable:\n${deliverableContent}`);
  }
  const planContent = artifactContent(evidence.plan);
  if (planContent) {
    chunks.push(`Previous plan:\n${planContent}`);
  }
  if (evidence.diffStat) {
    chunks.push(`Previous diff stat:\n${evidence.diffStat}`);
  }
  return trimText(chunks.join("\n\n"), 8000);
}

function buildRetrySourceContext(job: LooseRecord, bundle: LooseRecord, { round, feedback, actor, ts, retryQueueEntryId }: LooseRecord) {
  const base = job?.sourceContext && typeof job.sourceContext === "object" ? { ...job.sourceContext } : {};
  const jobResume = recordOrNull(job.dagResume);
  const baseResume = recordOrNull(base.dagResume);
  const dagResume = job?.dagResume && typeof job.dagResume === "object"
    ? {
        failedNodeId: jobResume?.failedNodeId ?? null,
        resumeTarget: recordOrNull(jobResume?.resumeTarget),
        completedNodeIds: Array.isArray(jobResume?.completedNodeIds) ? [...jobResume.completedNodeIds] : [],
      }
    : base.dagResume && typeof base.dagResume === "object"
      ? {
          failedNodeId: baseResume?.failedNodeId ?? null,
          resumeTarget: recordOrNull(baseResume?.resumeTarget),
          completedNodeIds: Array.isArray(baseResume?.completedNodeIds) ? [...baseResume.completedNodeIds] : [],
        }
      : null;
  const bundleId = bundleIdFor(job.project, job.jobId);
  const retry = {
    failureKind: "human_rejected_review_bundle",
    failureReason: feedback,
    previousOutput: retryPreviousOutput(bundle),
    previousJobId: job.jobId,
    previousPhase: dagResume?.resumeTarget?.phase || job.failurePhase || job.phase || null,
    previousNodeId: dagResume?.failedNodeId || dagResume?.resumeTarget?.nodeId || null,
    resumeTarget: dagResume?.resumeTarget ? { ...dagResume.resumeTarget } : null,
    completedNodeIds: dagResume?.completedNodeIds ? [...dagResume.completedNodeIds] : [],
    previousQueueEntryId: job.queueEntryId || base.queueEntryId || null,
    originalBundleId: bundleId,
    reviewRound: round,
    trigger: "review_bundle_rejected",
    actor,
    rejectedAt: ts,
    retryQueueEntryId,
    artifacts: job.artifacts || {},
  };
  return {
    ...base,
    ...(dagResume ? { dagResume } : {}),
    type: base.type || "review_bundle_retry",
    retry,
    reviewLoop: {
      originalJobId: job.jobId,
      originalBundleId: bundleId,
      round,
      retryQueueEntryId,
    },
    previousFailure: {
      kind: retry.failureKind,
      reason: retry.failureReason,
      jobId: job.jobId,
      phase: retry.previousPhase,
      nodeId: retry.previousNodeId,
      resumeTarget: retry.resumeTarget ? { ...retry.resumeTarget } : null,
      completedNodeIds: [...retry.completedNodeIds],
    },
  };
}

export async function getReviewLoop(cpbRoot: string, project: string, jobId: string, { dataRoot }: LooseRecord = {}) {
  const events = await readEventsReadOnlyForLoop(cpbRoot, project, jobId, { dataRoot });
  return reviewLoopState(events);
}

export async function acceptReviewBundle(cpbRoot: string, project: string, jobId: string, {
  actor = null,
  feedback = "",
  ts = nowIso(),
  dataRoot,
}: LooseRecord = {}) {
  const normalizedActor = typeof actor === "string" ? actor : null;
  const events = await readEventsReadOnlyForLoop(cpbRoot, project, jobId, { dataRoot });
  const job = materializeJob(events);
  if (!job?.jobId) throw reviewLoopError(`job not found: ${jobId}`, "REVIEW_JOB_NOT_FOUND", 404);
  assertReviewableJob(job);

  const loop = reviewLoopState(events);
  assertReviewNotFinalized(loop);
  const round = loop.nextRound;
  const event = await appendEvent(cpbRoot, project, jobId, {
    type: "review_bundle_accepted",
    jobId,
    project,
    bundleId: bundleIdFor(project, jobId),
    round,
    verdict: "accepted",
    feedback: trimText(feedback),
    actor: normalizedActor,
    ts,
  }, { dataRoot });
  await refreshJobIndex(cpbRoot, project, jobId, { dataRoot });

  return {
    accepted: true,
    jobId,
    project,
    round,
    bundleId: bundleIdFor(project, jobId),
    event,
  };
}

export async function rejectReviewBundle(cpbRoot: string, project: string, jobId: string, {
  feedback,
  actor = null,
  hubRoot,
  sourcePath = null,
  priority = "P0",
  ts = nowIso(),
  dataRoot,
}: LooseRecord = {}) {
  const normalizedFeedback = trimText(feedback);
  const normalizedActor = typeof actor === "string" ? actor : null;
  if (!normalizedFeedback) throw reviewLoopError("feedback required", "REVIEW_FEEDBACK_REQUIRED", 400);
  if (!hubRoot) throw reviewLoopError("hubRoot required", "REVIEW_HUB_ROOT_REQUIRED", 400);

  const events = await readEventsReadOnlyForLoop(cpbRoot, project, jobId, { dataRoot });
  const job = materializeJob(events);
  if (!job?.jobId) throw reviewLoopError(`job not found: ${jobId}`, "REVIEW_JOB_NOT_FOUND", 404);
  assertReviewableJob(job);

  const bundle = recordValue(await buildReviewBundle(cpbRoot, project, jobId, {
    dataRoot,
    sourcePath: typeof sourcePath === "string" ? sourcePath : null,
    worktreePath: job.worktree || null,
  }));
  const loop = reviewLoopState(events);
  assertReviewNotFinalized(loop);
  const round = loop.nextRound;
  const bundleId = bundleIdFor(project, jobId);
  const queueDedupeKey = `review-loop:${project}:${jobId}:${round}`;

  const sourceContext = buildRetrySourceContext(job, bundle, {
    round,
    feedback: normalizedFeedback,
    actor: normalizedActor,
    ts,
    retryQueueEntryId: null,
  });

  const entry = await enqueue(hubRoot, {
    projectId: project,
    sourcePath,
    priority: typeof priority === "string" ? priority : "P0",
    description: job.task || bundle.request?.task || `Retry rejected review bundle ${jobId}`,
    type: "review_bundle_retry",
    metadata: {
      source: "review_bundle_rejection",
      sourceType: "review_bundle_rejection",
      workflow: job.workflow || bundle.request?.workflow || "standard",
      planMode: job.planMode || bundle.request?.planMode || "full",
      actor: normalizedActor,
      originJobId: jobId,
      originalJobId: jobId,
      originalBundleId: bundleId,
      reviewRound: round,
      userFeedback: normalizedFeedback,
      requestedAt: ts,
      queueDedupeKey,
      sourceContext,
    },
  });

  sourceContext.reviewLoop.retryQueueEntryId = entry.id;
  sourceContext.retry.retryQueueEntryId = entry.id;
  const updatedEntry = await updateEntry(hubRoot, entry.id, {
    metadata: { sourceContext },
  });

  await appendEvent(cpbRoot, project, jobId, {
    type: "review_bundle_rejected",
    jobId,
    project,
    bundleId,
    round,
    verdict: "rejected",
    feedback: normalizedFeedback,
    actor: normalizedActor,
    retryQueueEntryId: entry.id,
    ts,
  }, { dataRoot });
  await refreshJobIndex(cpbRoot, project, jobId, { dataRoot });

  return {
    rejected: true,
    jobId,
    project,
    round,
    bundleId,
    retryQueueEntry: updatedEntry || entry,
  };
}
