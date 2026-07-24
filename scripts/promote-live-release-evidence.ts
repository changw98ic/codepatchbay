#!/usr/bin/env node
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import path from "node:path";

import type { LooseRecord } from "../shared/types.js";
import {
  captureProcessIdentity,
  sameProcessIdentity,
  type ProcessIdentity,
} from "../core/runtime/process-tree.js";
import {
  readBoundedRegularFileNoFollow,
  type BoundedRegularFileReadHooks,
} from "../core/runtime/durable-directory-lock.js";
import {
  stableJsonSha256,
  validateSweBenchBatchReport,
} from "./queue-swebench-batch.js";
import {
  DEFAULT_LIVE_RELEASE_EVIDENCE_FILE,
  DEFAULT_PRODUCT_EVIDENCE_FILE,
  verifyProviderConnectivityEvidence,
  verifyLiveReleaseEvidenceFile,
} from "./verify-live-release-evidence.js";
import { fsyncDirectory } from "../shared/hub-maintenance.js";

const LIVE_EVIDENCE_ROOT = "docs/product/evidence/live-release";
const RUNS_ROOT = `${LIVE_EVIDENCE_ROOT}/runs`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OWNER_MARKER = ".cpb-promotion-owner.json";
const OWNER_MARKER_MAX_BYTES = 64 * 1024;
const CLEANUP_RECEIPT_MAX_BYTES = 1024 * 1024;

export type PromoteLiveReleaseEvidenceOptions = {
  root?: string;
  runRoot: string;
  providerReport?: string;
  draftRehearsal?: string;
  providerOnly?: boolean;
  runId?: string;
  evidenceFile?: string;
  productEvidenceFile?: string;
  lockIdentityForTest?: ProcessIdentity;
  captureLockIdentityForTest?: (pid: number) => ProcessIdentity | null;
  lockTimeoutMsForTest?: number;
  syncDirectoryForTest?: (directory: string) => Promise<void>;
  boundedReadHooksForTest?: BoundedRegularFileReadHooks;
  afterPhaseForTest?: (
    phase: PromotionTestPhase,
    context: Record<string, string>,
  ) => void | Promise<void>;
  beforeCleanupRemovalForTest?: (context: CleanupRemovalContext) => void | Promise<void>;
};

type CleanupRemovalContext = {
  kind: string;
  entryType: "directory" | "file";
  canonicalPath: string;
  isolatedPath: string;
  cleanupContainer: string;
};

type PromotionTestPhase =
  | "lock-directory-created"
  | "candidate-owner-marker-initialized"
  | "before-manifest-commit"
  | "after-manifest-commit"
  | "before-candidate-marker-cleanup"
  | "before-run-lock-cleanup"
  | "after-stale-lock-quarantine"
  | "after-committed-cleanup-takeover";

type PromotionResidual = {
  path: string;
  kind: string;
  reason: string;
  committed?: boolean;
  committedPath?: string;
  recoveryPaths?: string[];
};

type PromotionCommitReceipt = {
  transactionId: string;
  runId: string;
  providerOnly: boolean;
  cleanupReceiptFile: string;
};

export type PromoteLiveReleaseEvidenceResult = {
  ok: boolean;
  committed: boolean;
  outcome: "not_committed" | "committed" | "committed_cleanup_required";
  providerOnly: boolean;
  runRoot: string;
  runId: string;
  runDirectory: string;
  providerEvidenceFile: string | null;
  draftPrEvidenceFile: string | null;
  liveReleaseEvidenceFile: string | null;
  recoveredCleanup: boolean;
  receipt: PromotionCommitReceipt | null;
  residuals: PromotionResidual[];
  recoveryPaths: string[];
  violations: Array<{ path: string; reason: string }>;
};

type FileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type LockRuntime = {
  currentIdentity: ProcessIdentity;
  captureIdentity: (pid: number) => ProcessIdentity | null;
  timeoutMs: number;
  syncDirectory: (directory: string) => Promise<void>;
  readHooks?: BoundedRegularFileReadHooks;
};

type DirectoryLockHandle = {
  directory: string;
  token: string;
  kind: string;
  generation: string;
  fencePort: number;
  identity: FileIdentity;
  processIdentity: ProcessIdentity;
  recoveredStale: boolean;
  syncDirectory: (directory: string) => Promise<void>;
  readHooks?: BoundedRegularFileReadHooks;
  releaseFence: () => Promise<void>;
};

const cleanupRemovalHookScope = new AsyncLocalStorage<
  PromoteLiveReleaseEvidenceOptions["beforeCleanupRemovalForTest"]
>();

type DirectoryLockSnapshot = Omit<DirectoryLockHandle, "directory" | "recoveredStale" | "syncDirectory" | "readHooks" | "releaseFence">;

const activeLockGenerations = new Set<string>();

type CleanupReceipt = {
  schemaVersion: 1;
  generator: "scripts/promote-live-release-evidence.ts#cleanupReceipt";
  transactionId: string;
  state: "prepared" | "commit-intent" | "cleanup-required" | "committed-clean";
  runId: string;
  providerOnly: boolean;
  runDirectory: string;
  providerEvidenceFile: string;
  providerSha: string;
  draftPrEvidenceFile: string | null;
  draftSha: string | null;
  liveReleaseEvidenceFile: string | null;
  productEvidenceFile: string | null;
  productSha: string | null;
  fingerprint: string;
  ownerToken: string;
  receiptFile: string;
  runLock: string;
  lockGeneration: string;
  cleanupGeneration: string | null;
  manifestLock: string | null;
  manifestLockToken: string | null;
  candidateFile: string | null;
  candidateToken: string | null;
  existingDraftOwned: boolean;
};

class PromotionError extends Error {
  violations: Array<{ path: string; reason: string }>;

  constructor(pathName: string, reason: string) {
    super(`${pathName}: ${reason}`);
    this.violations = [{ path: pathName, reason }];
  }
}

class PromotionValidationError extends Error {
  violations: Array<{ path: string; reason: string }>;

  constructor(violations: Array<{ path: string; reason: string }>) {
    super("promotion validation failed");
    this.violations = violations;
  }
}

class PromotionAggregateError extends Error {
  violations: Array<{ path: string; reason: string }>;
  recoveryPaths: string[];
  committed: boolean;
  committedPath?: string;

  constructor(primary: unknown, cleanup: Array<unknown>) {
    const primaryReason = primary instanceof Error ? primary.message : String(primary);
    super(`promotion failed: ${primaryReason}; cleanup failures: ${cleanup.length}`);
    this.violations = [
      ...(primary instanceof PromotionError || primary instanceof PromotionValidationError || primary instanceof PromotionAggregateError
        ? primary.violations
        : [{ path: "$", reason: primaryReason }]),
      ...cleanup.map((error) => ({
        path: "cleanup",
        reason: error instanceof Error ? error.message : String(error),
      })),
    ];
    const nested = [primary, ...cleanup];
    this.recoveryPaths = uniqueRecoveryPaths(nested.flatMap((error) => nestedRecoveryPaths(error)));
    this.committed = nested.some((error) => nestedCommitted(error));
    this.committedPath = nested
      .map((error) => nestedCommittedPath(error))
      .find((candidate): candidate is string => typeof candidate === "string");
    this.cause = primary;
  }
}

class PromotionCommittedDurabilityError extends Error {
  readonly code = "PROMOTION_COMMITTED_DURABILITY_AMBIGUOUS";
  readonly committed = true;
  readonly committedPath: string;
  readonly recoveryPaths: string[];

  constructor(committedPath: string, cause: unknown) {
    super(`promotion commit reached ${committedPath}, but parent directory durability is ambiguous`);
    this.name = "PromotionCommittedDurabilityError";
    this.committedPath = committedPath;
    this.recoveryPaths = [committedPath, path.dirname(committedPath)];
    this.cause = cause;
  }
}

function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): LooseRecord {
  return isRecord(value) ? value : {};
}

function nestedRecoveryPaths(error: unknown): string[] {
  if (!error || typeof error !== "object" || !("recoveryPaths" in error)) return [];
  const value = error.recoveryPaths;
  if (Array.isArray(value)) return value.filter((candidate): candidate is string => typeof candidate === "string");
  if (!isRecord(value)) return [];
  return Object.values(value).filter((candidate): candidate is string => typeof candidate === "string");
}

function nestedCommitted(error: unknown) {
  return Boolean(error && typeof error === "object" && "committed" in error && error.committed === true);
}

function nestedCommittedPath(error: unknown) {
  return error && typeof error === "object" && "committedPath" in error && typeof error.committedPath === "string"
    ? error.committedPath
    : undefined;
}

function uniqueRecoveryPaths(paths: string[]) {
  return [...new Set(paths.filter((candidate) => candidate.length > 0))];
}

function promotionPathError(
  pathName: string,
  reason: string,
  code: string,
  recoveryPaths: string[],
  cause?: unknown,
  extra: Record<string, unknown> = {},
) {
  return Object.assign(new PromotionError(pathName, reason), {
    code,
    recoveryPaths: uniqueRecoveryPaths(recoveryPaths),
    ...(cause === undefined ? {} : { cause }),
    ...extra,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableJsonBytes(value: unknown) {
  return Buffer.byteLength(stableJson(value), "utf8");
}

function sha256(raw: Buffer | string) {
  return createHash("sha256").update(raw).digest("hex");
}

async function syncFile(filePath: string) {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryStableIncarnation(
  directory: string,
  syncDirectory: (directory: string) => Promise<void>,
) {
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw Object.assign(new Error(`directory fsync target is unsafe: ${directory}`), {
      code: "PROMOTION_DIRECTORY_GENERATION_CHANGED",
    });
  }
  const identity = fileIdentity(before);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await syncDirectory(directory);
      const after = await lstat(directory);
      if (!after.isDirectory()
        || after.isSymbolicLink()
        || !sameFileIncarnation(identity, fileIdentity(after))) {
        throw Object.assign(new Error(`directory generation changed while syncing: ${directory}`), {
          code: "PROMOTION_DIRECTORY_GENERATION_CHANGED",
        });
      }
      return;
    } catch (error) {
      lastError = error;
      const after = await lstat(directory).catch(() => null);
      if (!after
        || !after.isDirectory()
        || after.isSymbolicLink()
        || !sameFileIncarnation(identity, fileIdentity(after))) {
        throw Object.assign(new Error(`directory generation changed while syncing: ${directory}`, { cause: error }), {
          code: "PROMOTION_DIRECTORY_GENERATION_CHANGED",
        });
      }
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code || "")
        : "";
      if (code !== "DIRECTORY_AUTHORITY_UNSAFE" || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt));
    }
  }
  throw lastError;
}

async function writeJson(
  filePath: string,
  value: unknown,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await syncFile(filePath);
  await syncDirectory(path.dirname(filePath));
}

function enoent(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function uniqueHiddenName(prefix: string) {
  return `.${prefix}.${randomUUID()}`;
}

function fileIdentity(details: {
  dev: number | bigint;
  ino: number | bigint;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}): FileIdentity {
  return {
    dev: Number(details.dev),
    ino: Number(details.ino),
    size: details.size,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs,
    birthtimeMs: details.birthtimeMs,
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameFileInode(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileIncarnation(left: FileIdentity, right: FileIdentity) {
  return sameFileInode(left, right) && left.birthtimeMs === right.birthtimeMs;
}

function sameFileAfterRename(left: FileIdentity, right: FileIdentity) {
  return sameFileInode(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function recordedFileIdentity(value: unknown, pathName: string): FileIdentity {
  const identity = recordValue(value);
  const parsed = {
    dev: Number(identity.dev),
    ino: Number(identity.ino),
    size: Number(identity.size),
    mtimeMs: Number(identity.mtimeMs),
    ctimeMs: Number(identity.ctimeMs),
    birthtimeMs: Number(identity.birthtimeMs),
  };
  if (!Number.isSafeInteger(parsed.dev)
    || parsed.dev < 0
    || !Number.isSafeInteger(parsed.ino)
    || parsed.ino < 0
    || !Number.isSafeInteger(parsed.size)
    || parsed.size < 0
    || !Number.isFinite(parsed.mtimeMs)
    || !Number.isFinite(parsed.ctimeMs)
    || !Number.isFinite(parsed.birthtimeMs)) {
    throw new PromotionError(pathName, "must contain a complete file generation");
  }
  return parsed;
}

async function lstatIfPresent(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if (enoent(error)) return null;
    throw error;
  }
}

type MetadataSnapshot = {
  value: unknown;
  identity: FileIdentity;
};

async function readMetadataSnapshot(
  filePath: string,
  pathName: string,
  maxBytes: number,
  hooks?: BoundedRegularFileReadHooks,
): Promise<MetadataSnapshot> {
  let before;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (enoent(error)) {
      throw promotionPathError(
        pathName,
        "metadata path is missing",
        "ENOENT",
        [filePath, path.dirname(filePath)],
        error,
      );
    }
    throw promotionPathError(
      pathName,
      `metadata path cannot be inspected safely: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_METADATA_UNSAFE",
      [filePath, path.dirname(filePath)],
      error,
    );
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw promotionPathError(
      pathName,
      "metadata must be a non-symlink regular file",
      "PROMOTION_METADATA_UNSAFE",
      [filePath, path.dirname(filePath)],
    );
  }
  const beforeIdentity = fileIdentity(before);
  let raw: string;
  try {
    raw = await readBoundedRegularFileNoFollow(filePath, { maxBytes, hooks });
  } catch (error) {
    throw promotionPathError(
      pathName,
      `metadata cannot be read safely: ${error instanceof Error ? error.message : String(error)}`,
      error && typeof error === "object" && "code" in error
        ? String(error.code || "PROMOTION_METADATA_UNSAFE")
        : "PROMOTION_METADATA_UNSAFE",
      [filePath, path.dirname(filePath)],
      error,
    );
  }
  let after;
  try {
    after = await lstat(filePath);
  } catch (error) {
    throw promotionPathError(
      pathName,
      "metadata path disappeared after bounded read",
      "PROMOTION_METADATA_CHANGED",
      [filePath, path.dirname(filePath)],
      error,
    );
  }
  const afterIdentity = fileIdentity(after);
  if (!after.isFile() || after.isSymbolicLink() || !sameFileIdentity(beforeIdentity, afterIdentity)) {
    throw promotionPathError(
      pathName,
      "metadata generation changed during bounded read",
      "PROMOTION_METADATA_CHANGED",
      [filePath, path.dirname(filePath)],
    );
  }
  try {
    return { value: parseJson(raw, pathName), identity: afterIdentity };
  } catch (error) {
    throw promotionPathError(
      pathName,
      `metadata must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_METADATA_MALFORMED",
      [filePath, path.dirname(filePath)],
      error,
    );
  }
}

async function writeJsonExclusive(
  filePath: string,
  value: unknown,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await syncFile(filePath);
  await syncDirectory(path.dirname(filePath));
}

async function writeOwnerMarker(
  directory: string,
  token: string,
  kind: string,
  metadata: Record<string, unknown> = {},
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  const markerPath = path.join(directory, OWNER_MARKER);
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw promotionPathError(
      `${kind}.owner`,
      "no-follow owner marker creation is unavailable",
      "PROMOTION_METADATA_UNSAFE",
      [markerPath, directory],
    );
  }
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw promotionPathError(
      `${kind}.owner`,
      "owned path must be a non-symlink directory",
      "PROMOTION_METADATA_UNSAFE",
      [directory, path.dirname(directory)],
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let markerCreated = false;
  let primaryError: unknown = null;
  let identity: FileIdentity | null = null;
  try {
    handle = await open(
      markerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    markerCreated = true;
    const withMarker = await lstat(directory);
    identity = fileIdentity(withMarker);
    if (!withMarker.isDirectory()
      || withMarker.isSymbolicLink()
      || !sameFileInode(fileIdentity(before), identity)) {
      throw new Error("owned directory changed while creating its owner marker");
    }
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      generator: "scripts/promote-live-release-evidence.ts#ownerToken",
      kind,
      token,
      identity,
      ...metadata,
    }, null, 2)}\n`, "utf8");
    await handle.sync();
    const markerDescriptor = fileIdentity(await handle.stat());
    const markerPathDetails = await lstat(markerPath);
    if (!markerPathDetails.isFile()
      || markerPathDetails.isSymbolicLink()
      || !sameFileIdentity(markerDescriptor, fileIdentity(markerPathDetails))) {
      throw new Error("owner marker path changed while it was being initialized");
    }
    const after = await lstat(directory);
    if (!after.isDirectory()
      || after.isSymbolicLink()
      || !sameFileIdentity(identity, fileIdentity(after))) {
      throw new Error("owned directory generation changed while initializing its owner marker");
    }
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
  let syncError: unknown = null;
  if (!primaryError && !closeError) {
    try {
      await syncDirectory(directory);
    } catch (error) {
      syncError = error;
    }
  }
  const errors = [primaryError, closeError, syncError].filter((error) => error !== null);
  if (errors.length > 0) {
    const cause = errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `owner marker initialization failed: ${markerPath}`, {
        cause: primaryError ?? closeError ?? syncError,
      });
    throw promotionPathError(
      `${kind}.owner`,
      `owner marker initialization failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      markerCreated ? "PROMOTION_METADATA_COMMITTED_AMBIGUOUS" : "PROMOTION_METADATA_WRITE_FAILED",
      [markerPath, directory, path.dirname(directory)],
      cause,
      markerCreated ? { committed: true, committedPath: markerPath } : {},
    );
  }
  if (!identity) throw new Error(`owner marker identity was not captured: ${markerPath}`);
  return identity;
}

async function verifyOwnerMarker(
  directory: string,
  token: string,
  kind: string,
  generation?: string,
  expectedIdentity?: FileIdentity,
  readHooks?: BoundedRegularFileReadHooks,
) {
  const markerPath = path.join(directory, OWNER_MARKER);
  const before = await lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw promotionPathError(
      `${kind}.owner`,
      "owned path must be a non-symlink directory",
      "PROMOTION_METADATA_UNSAFE",
      [directory, markerPath, path.dirname(directory)],
    );
  }
  const beforeIdentity = fileIdentity(before);
  const markerSnapshot = await readMetadataSnapshot(
    markerPath,
    `${kind}.owner`,
    OWNER_MARKER_MAX_BYTES,
    readHooks,
  );
  const marker = markerSnapshot.value;
  const after = await lstat(directory);
  const currentIdentity = fileIdentity(after);
  if (!after.isDirectory()
    || after.isSymbolicLink()
    || !sameFileIdentity(beforeIdentity, currentIdentity)) {
    throw promotionPathError(
      `${kind}.owner`,
      "owned directory generation changed while reading its owner marker",
      "PROMOTION_METADATA_CHANGED",
      [directory, markerPath, path.dirname(directory)],
    );
  }
  if (!isRecord(marker)
    || marker.generator !== "scripts/promote-live-release-evidence.ts#ownerToken"
    || marker.token !== token
    || marker.kind !== kind
    || (generation !== undefined && marker.generation !== generation)) {
    throw promotionPathError(
      `${kind}.owner`,
      "owner token did not match; refusing cleanup or publication",
      "PROMOTION_OWNER_MISMATCH",
      [directory, markerPath, path.dirname(directory)],
    );
  }
  const recordedIdentity = recordedFileIdentity(marker.identity, `${kind}.owner.identity`);
  const recordedMatches = sameFileIdentity(currentIdentity, recordedIdentity)
    || sameFileAfterRename(recordedIdentity, currentIdentity)
    || (kind === "staging" && sameFileIncarnation(recordedIdentity, currentIdentity));
  if (!recordedMatches) {
    throw promotionPathError(
      `${kind}.owner`,
      "owned directory identity changed; refusing cleanup or publication",
      "PROMOTION_OWNER_GENERATION_CHANGED",
      [directory, markerPath, path.dirname(directory)],
    );
  }
  if (expectedIdentity && !sameFileIdentity(expectedIdentity, currentIdentity)) {
    throw promotionPathError(
      `${kind}.owner`,
      "owned directory no longer matches the pinned cleanup generation; preserving it",
      "PROMOTION_OWNER_GENERATION_CHANGED",
      [directory, markerPath, path.dirname(directory)],
    );
  }
  return currentIdentity;
}

type RemoveDirectoryOptions = {
  expectedIdentity?: FileIdentity;
  expectedSuccessor?: DirectoryLockHandle;
  allowSuccessor?: boolean;
  readHooks?: BoundedRegularFileReadHooks;
};

async function verifyDirectorySuccessor(
  directory: string,
  expectedSuccessor: DirectoryLockHandle | undefined,
  readHooks?: BoundedRegularFileReadHooks,
  allowSuccessor = false,
) {
  if (!expectedSuccessor) {
    if (allowSuccessor) return;
    if (await lstatIfPresent(directory)) {
      throw promotionPathError(
        "cleanup.successor",
        "a successor appeared at the owned directory path; preserving isolated evidence",
        "PROMOTION_CLEANUP_SUCCESSOR_CHANGED",
        [directory, path.dirname(directory)],
      );
    }
    return;
  }
  const successorPath = expectedSuccessor.directory;
  const successor = await readDirectoryLockSnapshot(successorPath, expectedSuccessor.kind, readHooks);
  if (!successor
    || successor.token !== expectedSuccessor.token
    || successor.generation !== expectedSuccessor.generation
    || successor.fencePort !== expectedSuccessor.fencePort
    || !sameFileIdentity(successor.identity, expectedSuccessor.identity)) {
    throw promotionPathError(
      `${expectedSuccessor.kind}.successor`,
      "the canonical successor generation changed; preserving isolated evidence",
      "PROMOTION_CLEANUP_SUCCESSOR_CHANGED",
      [successorPath, path.join(successorPath, OWNER_MARKER), directory, path.dirname(successorPath)],
    );
  }
}

type CleanupIsolation = {
  canonicalPath: string;
  cleanupContainer: string;
  cleanupContainerIdentity: FileIdentity;
  isolatedPath: string;
  parentPath: string;
  parentIdentity: FileIdentity;
};

async function claimCleanupIsolation(
  canonicalPath: string,
  kind: string,
  syncDirectory: (directory: string) => Promise<void>,
): Promise<CleanupIsolation> {
  const parentPath = path.dirname(canonicalPath);
  let parentDetails;
  try {
    parentDetails = await lstat(parentPath);
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `cleanup parent could not be pinned: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [canonicalPath, parentPath],
      error,
    );
  }
  if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink()) {
    throw promotionPathError(
      `${kind}.cleanup`,
      "cleanup parent is not a safe directory",
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [canonicalPath, parentPath],
    );
  }
  const parentIdentity = fileIdentity(parentDetails);
  const cleanupContainer = path.join(
    parentPath,
    uniqueHiddenName(`${path.basename(canonicalPath)}.cleanup-container`),
  );
  try {
    // mkdir is the cross-platform no-clobber claim. The child destination is
    // generated only after this private container generation is pinned.
    await mkdir(cleanupContainer, { mode: 0o700 });
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `could not claim a no-clobber cleanup container: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [canonicalPath, cleanupContainer, parentPath],
      error,
    );
  }
  let details;
  try {
    details = await lstat(cleanupContainer);
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `cleanup container generation could not be pinned after creation: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [canonicalPath, cleanupContainer, parentPath],
      error,
      { committed: true },
    );
  }
  const cleanupContainerIdentity = fileIdentity(details);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw promotionPathError(
      `${kind}.cleanup`,
      "cleanup container generation changed before it could be pinned",
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [canonicalPath, cleanupContainer, parentPath],
      undefined,
      { committed: true },
    );
  }
  const isolation = {
    canonicalPath,
    cleanupContainer,
    cleanupContainerIdentity,
    isolatedPath: path.join(cleanupContainer, uniqueHiddenName("owned-generation")),
    parentPath,
    parentIdentity,
  };
  try {
    await syncCleanupParent(isolation, kind, syncDirectory);
  } catch (error) {
    if (nestedCommitted(error)) throw error;
    throw promotionPathError(
      `${kind}.cleanup`,
      "cleanup container creation durability is ambiguous",
      "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS",
      [canonicalPath, cleanupContainer, parentPath],
      error,
      { committed: true },
    );
  }
  await validateCleanupContainer(isolation, kind);
  return isolation;
}

async function validateCleanupContainer(isolation: CleanupIsolation, kind: string) {
  let details;
  try {
    details = await lstat(isolation.cleanupContainer);
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `cleanup container disappeared or became unreadable: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolation.canonicalPath, isolation.isolatedPath, isolation.cleanupContainer, isolation.parentPath],
      error,
      { committed: true },
    );
  }
  if (!details.isDirectory()
    || details.isSymbolicLink()
    || !sameFileIncarnation(isolation.cleanupContainerIdentity, fileIdentity(details))) {
    throw promotionPathError(
      `${kind}.cleanup`,
      "cleanup container generation changed; preserving all reachable generations",
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolation.canonicalPath, isolation.isolatedPath, isolation.cleanupContainer, isolation.parentPath],
      undefined,
      { committed: true },
    );
  }
}

async function validateCleanupParent(isolation: CleanupIsolation, kind: string) {
  let details;
  try {
    details = await lstat(isolation.parentPath);
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `cleanup parent disappeared or became unreadable: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolation.canonicalPath, isolation.isolatedPath, isolation.cleanupContainer, isolation.parentPath],
      error,
      { committed: true },
    );
  }
  if (!details.isDirectory()
    || details.isSymbolicLink()
    || !sameFileIncarnation(isolation.parentIdentity, fileIdentity(details))) {
    throw promotionPathError(
      `${kind}.cleanup`,
      "cleanup parent generation changed; preserving all reachable generations",
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolation.canonicalPath, isolation.isolatedPath, isolation.cleanupContainer, isolation.parentPath],
      undefined,
      { committed: true },
    );
  }
}

async function syncCleanupParent(
  isolation: CleanupIsolation,
  kind: string,
  syncDirectory: (directory: string) => Promise<void>,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await validateCleanupParent(isolation, kind);
    try {
      await syncDirectory(isolation.parentPath);
      await validateCleanupParent(isolation, kind);
      return;
    } catch (error) {
      await validateCleanupParent(isolation, kind);
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code || "")
        : "";
      if (code !== "DIRECTORY_AUTHORITY_UNSAFE" || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

async function inspectIsolatedCleanupGeneration(
  isolation: CleanupIsolation,
  kind: string,
  phase: string,
) {
  try {
    return await lstat(isolation.isolatedPath);
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `${phase}: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolation.canonicalPath, isolation.isolatedPath, isolation.cleanupContainer, isolation.parentPath],
      error,
      { committed: true },
    );
  }
}

async function beforeCleanupRemoval(
  isolation: CleanupIsolation,
  kind: string,
  entryType: CleanupRemovalContext["entryType"],
) {
  await cleanupRemovalHookScope.getStore()?.({
    kind,
    entryType,
    canonicalPath: isolation.canonicalPath,
    isolatedPath: isolation.isolatedPath,
    cleanupContainer: isolation.cleanupContainer,
  });
}

async function releaseCleanupIsolation(
  isolation: CleanupIsolation,
  kind: string,
  syncDirectory: (directory: string) => Promise<void>,
) {
  let isolatedDetails;
  try {
    isolatedDetails = await lstatIfPresent(isolation.isolatedPath);
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `isolated generation absence could not be verified before cleanup container release: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS",
      [isolation.isolatedPath, isolation.cleanupContainer, isolation.parentPath],
      error,
      { committed: true },
    );
  }
  if (isolatedDetails) {
    throw promotionPathError(
      `${kind}.cleanup`,
      "a same-path successor appeared after isolated generation removal; preserving it",
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolation.isolatedPath, isolation.cleanupContainer, isolation.parentPath],
      undefined,
      { committed: true },
    );
  }
  await validateCleanupContainer(isolation, kind);
  let entries;
  try {
    entries = await readdir(isolation.cleanupContainer);
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `cleanup container contents could not be verified before release: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS",
      [isolation.cleanupContainer, isolation.parentPath],
      error,
      { committed: true },
    );
  }
  if (entries.length > 0) {
    throw promotionPathError(
      `${kind}.cleanup`,
      "cleanup container is not empty; preserving its successor contents",
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolation.cleanupContainer, isolation.parentPath],
      undefined,
      { committed: true, committedPath: isolation.cleanupContainer },
    );
  }
  let removed = false;
  try {
    await rmdir(isolation.cleanupContainer);
    removed = true;
    await syncCleanupParent(isolation, kind, syncDirectory);
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      removed
        ? "cleanup container removal durability is ambiguous"
        : "cleanup container could not be released",
      removed ? "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS" : "PROMOTION_CLEANUP_FAILED",
      removed ? [isolation.parentPath] : [isolation.cleanupContainer, isolation.parentPath],
      error,
      removed ? { committed: true } : { committed: true, committedPath: isolation.cleanupContainer },
    );
  }
}

async function removeDirectoryAfterIsolation(
  directory: string,
  identity: FileIdentity,
  kind: string,
  token?: string,
  generation?: string,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
  options: RemoveDirectoryOptions = {},
) {
  const isolation = await claimCleanupIsolation(directory, kind, syncDirectory);
  const isolated = isolation.isolatedPath;
  try {
    await validateCleanupContainer(isolation, kind);
    const finalCanonicalDetails = await lstat(directory);
    if (!finalCanonicalDetails.isDirectory()
      || finalCanonicalDetails.isSymbolicLink()
      || !sameFileIdentity(identity, fileIdentity(finalCanonicalDetails))) {
      throw promotionPathError(
        `${kind}.cleanup`,
        "owned directory changed before the no-clobber isolation rename; preserving it",
        "PROMOTION_CLEANUP_GENERATION_CHANGED",
        [directory, isolated, isolation.cleanupContainer, path.dirname(directory)],
        undefined,
        { committed: true, committedPath: isolation.cleanupContainer },
      );
    }
    await rename(directory, isolated);
  } catch (error) {
    if (enoent(error)) {
      throw promotionPathError(
        `${kind}.cleanup`,
        "owned directory disappeared during cleanup fencing",
        "PROMOTION_CLEANUP_GENERATION_CHANGED",
        [directory, isolated, isolation.cleanupContainer, path.dirname(directory)],
        error,
        { committed: true },
      );
    }
    if (nestedCommitted(error)) throw error;
    throw promotionPathError(
      `${kind}.cleanup`,
      `owned directory isolation failed; preserving every reachable generation: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS",
      [directory, isolated, isolation.cleanupContainer, path.dirname(directory)],
      error,
      { committed: true },
    );
  }
  try {
    await syncCleanupParent(isolation, kind, syncDirectory);
    await syncDirectory(isolation.cleanupContainer);
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `directory was isolated but parent durability is ambiguous: ${isolated}: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS",
      [isolated, directory, isolation.cleanupContainer, path.dirname(directory)],
      error,
      { committed: true, committedPath: isolated },
    );
  }
  const isolatedDetails = await inspectIsolatedCleanupGeneration(
    isolation,
    kind,
    "isolated directory could not be inspected after cleanup rename",
  );
  const isolatedIdentity = fileIdentity(isolatedDetails);
  if (!isolatedDetails.isDirectory()
    || isolatedDetails.isSymbolicLink()
    || !sameFileAfterRename(identity, isolatedIdentity)) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `directory generation changed during cleanup; preserving isolated residual: ${isolated}`,
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolated, directory, isolation.cleanupContainer, path.dirname(directory)],
      undefined,
      { committed: true, committedPath: isolated },
    );
  }
  try {
    if (token) {
      await verifyOwnerMarker(isolated, token, kind, generation, isolatedIdentity, options.readHooks);
    }
    await verifyDirectorySuccessor(
      directory,
      options.expectedSuccessor,
      options.readHooks,
      options.allowSuccessor,
    );
  } catch (error) {
    if (nestedCommitted(error)) throw error;
    throw promotionPathError(
      `${kind}.cleanup`,
      `post-isolation ownership or successor validation failed; preserving ${isolated}: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS",
      uniqueRecoveryPaths([
        isolated,
        directory,
        isolation.cleanupContainer,
        path.dirname(directory),
        ...nestedRecoveryPaths(error),
      ]),
      error,
      { committed: true, committedPath: isolated },
    );
  }
  const beforeRemoval = fileIdentity(await inspectIsolatedCleanupGeneration(
    isolation,
    kind,
    "isolated directory could not be inspected before removal",
  ));
  if (!sameFileIdentity(isolatedIdentity, beforeRemoval)) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `isolated directory changed before removal; preserving it: ${isolated}`,
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolated, directory, isolation.cleanupContainer, path.dirname(directory)],
      undefined,
      { committed: true, committedPath: isolated },
    );
  }
  if (token) {
    try {
      await verifyOwnerMarker(isolated, token, kind, generation, beforeRemoval, options.readHooks);
    } catch (error) {
      throw promotionPathError(
        `${kind}.cleanup`,
        `isolated owner validation changed before removal; preserving ${isolated}: ${error instanceof Error ? error.message : String(error)}`,
        "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS",
        uniqueRecoveryPaths([isolated, directory, isolation.cleanupContainer, path.dirname(directory), ...nestedRecoveryPaths(error)]),
        error,
        { committed: true, committedPath: isolated },
      );
    }
  }
  await beforeCleanupRemoval(isolation, kind, "directory");
  await validateCleanupContainer(isolation, kind);
  const finalRemovalDetails = await inspectIsolatedCleanupGeneration(
    isolation,
    kind,
    "isolated directory changed at the final removal boundary",
  );
  if (!finalRemovalDetails.isDirectory()
    || finalRemovalDetails.isSymbolicLink()
    || !sameFileIdentity(beforeRemoval, fileIdentity(finalRemovalDetails))) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `isolated directory changed at the final removal boundary; preserving it: ${isolated}`,
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolated, directory, isolation.cleanupContainer, path.dirname(directory)],
      undefined,
      { committed: true, committedPath: isolated },
    );
  }
  await verifyDirectorySuccessor(
    directory,
    options.expectedSuccessor,
    options.readHooks,
    options.allowSuccessor,
  );
  let isolatedRemoved = false;
  try {
    await rm(isolated, { recursive: true, force: false });
    isolatedRemoved = true;
    await syncDirectory(path.dirname(isolated));
  } catch (error) {
    const isolatedStillPresent = await lstatIfPresent(isolated).catch(() => null);
    throw promotionPathError(
      `${kind}.cleanup`,
      isolatedRemoved
        ? `isolated directory removal committed but durability is ambiguous: ${isolated}`
        : `failed to remove isolated owned directory ${isolated}: ${error instanceof Error ? error.message : String(error)}`,
      isolatedRemoved ? "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS" : "PROMOTION_CLEANUP_FAILED",
      isolatedRemoved
        ? [directory, isolation.cleanupContainer, path.dirname(directory)]
        : [isolated, directory, isolation.cleanupContainer, path.dirname(directory)],
      error,
      {
        committed: true,
        ...(!isolatedRemoved && isolatedStillPresent ? { committedPath: isolated } : {}),
      },
    );
  }
  if (await lstatIfPresent(isolated)) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `a same-path successor appeared after isolated directory removal: ${isolated}`,
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [isolated, directory, isolation.cleanupContainer, path.dirname(directory)],
      undefined,
      { committed: true },
    );
  }
  await releaseCleanupIsolation(isolation, kind, syncDirectory);
  try {
    await verifyDirectorySuccessor(
      directory,
      options.expectedSuccessor,
      options.readHooks,
      options.allowSuccessor,
    );
  } catch (error) {
    throw promotionPathError(
      `${kind}.cleanup`,
      `owned directory was removed but successor validation failed: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS",
      uniqueRecoveryPaths([directory, path.dirname(directory), ...nestedRecoveryPaths(error)]),
      error,
      { committed: true },
    );
  }
}

async function removeOwnedDirectory(
  directory: string,
  token: string,
  kind: string,
  generation?: string,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
  options: RemoveDirectoryOptions = {},
) {
  const details = await lstatIfPresent(directory);
  if (!details) return;
  const identity = await verifyOwnerMarker(
    directory,
    token,
    kind,
    generation,
    options.expectedIdentity,
    options.readHooks,
  );
  const confirmed = fileIdentity(await lstat(directory));
  if (!sameFileIdentity(identity, confirmed)) {
    throw promotionPathError(
      `${kind}.cleanup`,
      "owned directory changed before cleanup isolation; preserving it",
      "PROMOTION_CLEANUP_GENERATION_CHANGED",
      [directory, path.join(directory, OWNER_MARKER), path.dirname(directory)],
    );
  }
  await removeDirectoryAfterIsolation(directory, identity, kind, token, generation, syncDirectory, options);
}

async function removeCreatedDirectory(
  directory: string,
  identity: FileIdentity,
  kind: string,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  const details = await lstatIfPresent(directory);
  if (!details) return;
  if (!sameFileIdentity(identity, fileIdentity(details))) {
    throw new PromotionError(`${kind}.cleanup`, "newly-created lock identity changed; refusing cleanup");
  }
  await removeDirectoryAfterIsolation(directory, identity, kind, undefined, undefined, syncDirectory);
}

function ownedFileMarkerPath(filePath: string) {
  return `${filePath}.owner.json`;
}

async function writeOwnedFileMarker(
  filePath: string,
  token: string,
  kind: string,
  metadata: Record<string, unknown> = {},
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  const details = await lstat(filePath);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new PromotionError(`${kind}.owner`, "owned path must be a non-symlink regular file");
  }
  await writeJsonExclusive(ownedFileMarkerPath(filePath), {
    schemaVersion: 1,
    generator: "scripts/promote-live-release-evidence.ts#ownerToken",
    kind,
    token,
    identity: fileIdentity(details),
    ...metadata,
  }, syncDirectory);
}

type OwnedFileMarkerSnapshot = {
  marker: LooseRecord;
  identity: FileIdentity;
};

function validateOwnedFileMarker(value: unknown, token: string, kind: string, pathName: string) {
  if (!isRecord(value)
    || value.generator !== "scripts/promote-live-release-evidence.ts#ownerToken"
    || value.token !== token
    || value.kind !== kind) {
    throw new PromotionError(pathName, "owner token did not match; refusing cleanup");
  }
  recordedFileIdentity(value.identity, `${pathName}.identity`);
  return value;
}

async function readOwnedFileMarkerSnapshot(
  filePath: string,
  token: string,
  kind: string,
  readHooks?: BoundedRegularFileReadHooks,
): Promise<OwnedFileMarkerSnapshot> {
  const markerPath = ownedFileMarkerPath(filePath);
  const snapshot = await readMetadataSnapshot(
    markerPath,
    `${kind}.owner`,
    kind === "cleanup-receipt" ? CLEANUP_RECEIPT_MAX_BYTES : OWNER_MARKER_MAX_BYTES,
    readHooks,
  );
  return {
    marker: validateOwnedFileMarker(snapshot.value, token, kind, `${kind}.owner`),
    identity: snapshot.identity,
  };
}

function cleanupPathError(
  pathName: string,
  reason: string,
  recoveryPaths: string[],
  cause?: unknown,
  committedPath?: string,
  committed = committedPath !== undefined,
) {
  return promotionPathError(
    pathName,
    reason,
    committed ? "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS" : "PROMOTION_CLEANUP_GENERATION_CHANGED",
    recoveryPaths,
    cause,
    committed
      ? { committed: true, ...(committedPath ? { committedPath } : {}) }
      : {},
  );
}

async function removeOwnedFile(
  filePath: string,
  token: string,
  kind = "candidate",
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
  readHooks?: BoundedRegularFileReadHooks,
) {
  const markerPath = ownedFileMarkerPath(filePath);
  const [fileDetails, markerDetails] = await Promise.all([
    lstatIfPresent(filePath),
    lstatIfPresent(markerPath),
  ]);
  if (!fileDetails && !markerDetails) return;
  if (fileDetails && !markerDetails) {
    throw cleanupPathError(
      `${kind}.owner`,
      "owner marker is missing while owned data still exists; refusing cleanup",
      [filePath, markerPath, path.dirname(filePath)],
    );
  }
  const markerSnapshot = await readOwnedFileMarkerSnapshot(filePath, token, kind, readHooks);
  const marker = markerSnapshot.marker;
  let dataIdentity: FileIdentity | null = null;
  if (fileDetails) {
    if (fileDetails.isSymbolicLink() || !fileDetails.isFile()) {
      throw cleanupPathError(
        `${kind}.owner`,
        "owned data must remain a non-symlink regular file",
        [filePath, markerPath, path.dirname(filePath)],
      );
    }
    dataIdentity = fileIdentity(fileDetails);
    const recordedIdentity = recordedFileIdentity(marker.identity, `${kind}.owner.identity`);
    if (!sameFileIdentity(dataIdentity, recordedIdentity)) {
      throw cleanupPathError(
        `${kind}.owner`,
        "owned file generation changed; refusing cleanup",
        [filePath, markerPath, path.dirname(filePath)],
      );
    }
    const confirmed = await lstat(filePath);
    if (!sameFileIdentity(dataIdentity, fileIdentity(confirmed))) {
      throw cleanupPathError(
        `${kind}.owner`,
        "owned file changed before cleanup isolation; refusing cleanup",
        [filePath, markerPath, path.dirname(filePath)],
      );
    }
  }

  let dataIsolation: CleanupIsolation | null = null;
  let markerIsolation: CleanupIsolation | null = null;
  let isolatedData = "";
  let isolatedMarker = "";
  let isolatedDataIdentity: FileIdentity | null = null;
  if (dataIdentity) {
    dataIsolation = await claimCleanupIsolation(filePath, kind, syncDirectory);
    isolatedData = dataIsolation.isolatedPath;
    try {
      await validateCleanupContainer(dataIsolation, kind);
      const finalDataDetails = await lstat(filePath);
      if (!finalDataDetails.isFile()
        || finalDataDetails.isSymbolicLink()
        || !sameFileIdentity(dataIdentity, fileIdentity(finalDataDetails))) {
        throw cleanupPathError(
          `${kind}.cleanup`,
          "owned data changed before the no-clobber isolation rename",
          [filePath, markerPath, isolatedData, dataIsolation.cleanupContainer, path.dirname(filePath)],
          undefined,
          dataIsolation.cleanupContainer,
        );
      }
      await rename(filePath, isolatedData);
      await syncDirectory(path.dirname(filePath));
      await syncDirectory(dataIsolation.cleanupContainer);
    } catch (error) {
      throw cleanupPathError(
        `${kind}.cleanup`,
        `failed to isolate owned data: ${error instanceof Error ? error.message : String(error)}`,
        [filePath, markerPath, isolatedData, dataIsolation.cleanupContainer, path.dirname(filePath)],
        error,
        await lstatIfPresent(isolatedData) ? isolatedData : dataIsolation.cleanupContainer,
      );
    }
    const isolatedDetails = await inspectIsolatedCleanupGeneration(
      dataIsolation,
      kind,
      "isolated owned data could not be inspected after cleanup rename",
    );
    isolatedDataIdentity = fileIdentity(isolatedDetails);
    if (!isolatedDetails.isFile()
      || isolatedDetails.isSymbolicLink()
      || !sameFileAfterRename(dataIdentity, isolatedDataIdentity)) {
      throw cleanupPathError(
        `${kind}.cleanup`,
        "owned data generation changed during isolation; preserving it",
        [filePath, markerPath, isolatedData, dataIsolation.cleanupContainer, path.dirname(filePath)],
        undefined,
        isolatedData,
      );
    }
  }

  const markerBeforeRename = await lstatIfPresent(markerPath);
  if (!markerBeforeRename
    || !sameFileIdentity(markerSnapshot.identity, fileIdentity(markerBeforeRename))) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "owner marker generation changed before isolation; preserving owned data",
      [filePath, markerPath, isolatedData, path.dirname(filePath)],
      undefined,
      isolatedDataIdentity ? isolatedData : undefined,
    );
  }
  markerIsolation = await claimCleanupIsolation(markerPath, kind, syncDirectory);
  isolatedMarker = markerIsolation.isolatedPath;
  try {
    await validateCleanupContainer(markerIsolation, kind);
    const finalMarkerDetails = await lstat(markerPath);
    if (!finalMarkerDetails.isFile()
      || finalMarkerDetails.isSymbolicLink()
      || !sameFileIdentity(markerSnapshot.identity, fileIdentity(finalMarkerDetails))) {
      throw cleanupPathError(
        `${kind}.cleanup`,
        "owner marker changed before the no-clobber isolation rename",
        [filePath, markerPath, isolatedData, isolatedMarker, markerIsolation.cleanupContainer, path.dirname(filePath)],
        undefined,
        isolatedDataIdentity && dataIsolation ? isolatedData : markerIsolation.cleanupContainer,
      );
    }
    await rename(markerPath, isolatedMarker);
    await syncDirectory(path.dirname(markerPath));
    await syncDirectory(markerIsolation.cleanupContainer);
  } catch (error) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      `failed to isolate owner marker: ${error instanceof Error ? error.message : String(error)}`,
      [filePath, markerPath, isolatedData, isolatedMarker, markerIsolation.cleanupContainer, path.dirname(filePath)],
      error,
      await lstatIfPresent(isolatedMarker)
        ? isolatedMarker
        : (isolatedDataIdentity ? isolatedData : markerIsolation.cleanupContainer),
    );
  }
  const isolatedMarkerDetails = await inspectIsolatedCleanupGeneration(
    markerIsolation,
    kind,
    "isolated owner marker could not be inspected after cleanup rename",
  );
  const isolatedMarkerIdentity = fileIdentity(isolatedMarkerDetails);
  if (!isolatedMarkerDetails.isFile()
    || isolatedMarkerDetails.isSymbolicLink()
    || !sameFileAfterRename(markerSnapshot.identity, isolatedMarkerIdentity)) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "owner marker generation changed during isolation; preserving cleanup evidence",
      [filePath, markerPath, isolatedData, isolatedMarker, markerIsolation.cleanupContainer, path.dirname(filePath)],
      undefined,
      isolatedMarker,
    );
  }
  const isolatedMarkerSnapshot = await readMetadataSnapshot(
    isolatedMarker,
    `${kind}.owner`,
    kind === "cleanup-receipt" ? CLEANUP_RECEIPT_MAX_BYTES : OWNER_MARKER_MAX_BYTES,
    readHooks,
  );
  validateOwnedFileMarker(isolatedMarkerSnapshot.value, token, kind, `${kind}.owner`);
  if (!sameFileIdentity(isolatedMarkerSnapshot.identity, isolatedMarkerIdentity)) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "isolated owner marker changed before removal; preserving cleanup evidence",
      [filePath, markerPath, isolatedData, isolatedMarker, markerIsolation.cleanupContainer, path.dirname(filePath)],
      undefined,
      isolatedMarker,
    );
  }
  if (await lstatIfPresent(filePath) || await lstatIfPresent(markerPath)) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "a successor appeared at an owned file path; preserving isolated cleanup evidence",
      [
        filePath,
        markerPath,
        isolatedData,
        isolatedMarker,
        ...(dataIsolation ? [dataIsolation.cleanupContainer] : []),
        markerIsolation.cleanupContainer,
        path.dirname(filePath),
      ],
      undefined,
      isolatedMarker,
    );
  }
  if (isolatedDataIdentity) {
    if (!dataIsolation) throw new Error("owned data cleanup isolation is unavailable");
    const beforeRemoval = await inspectIsolatedCleanupGeneration(
      dataIsolation,
      kind,
      "isolated owned data could not be inspected before removal",
    );
    if (!sameFileIdentity(isolatedDataIdentity, fileIdentity(beforeRemoval))) {
      throw cleanupPathError(
        `${kind}.cleanup`,
        "isolated owned data changed before removal; preserving cleanup evidence",
        [isolatedData, isolatedMarker, dataIsolation.cleanupContainer, markerIsolation.cleanupContainer, path.dirname(filePath)],
        undefined,
        isolatedData,
      );
    }
    await beforeCleanupRemoval(dataIsolation, kind, "file");
    await validateCleanupContainer(dataIsolation, kind);
    const finalDataRemoval = await inspectIsolatedCleanupGeneration(
      dataIsolation,
      kind,
      "isolated owned data changed at the final removal boundary",
    );
    if (!finalDataRemoval.isFile()
      || finalDataRemoval.isSymbolicLink()
      || !sameFileIdentity(beforeRemoval, fileIdentity(finalDataRemoval))
      || await lstatIfPresent(filePath)) {
      throw cleanupPathError(
        `${kind}.cleanup`,
        "isolated owned data or canonical successor changed at the final removal boundary",
        [isolatedData, isolatedMarker, filePath, dataIsolation.cleanupContainer, markerIsolation.cleanupContainer, path.dirname(filePath)],
        undefined,
        isolatedData,
      );
    }
    let dataRemoved = false;
    try {
      await rm(isolatedData, { force: false });
      dataRemoved = true;
      await syncDirectory(dataIsolation.cleanupContainer);
    } catch (error) {
      throw cleanupPathError(
        `${kind}.cleanup`,
        dataRemoved
          ? `owned data removal committed but durability is ambiguous: ${error instanceof Error ? error.message : String(error)}`
          : `owned data removal failed: ${error instanceof Error ? error.message : String(error)}`,
        dataRemoved
          ? [isolatedMarker, filePath, markerPath, dataIsolation.cleanupContainer, markerIsolation.cleanupContainer, path.dirname(filePath)]
          : [isolatedData, isolatedMarker, filePath, markerPath, dataIsolation.cleanupContainer, markerIsolation.cleanupContainer, path.dirname(filePath)],
        error,
        dataRemoved ? undefined : isolatedData,
        true,
      );
    }
    if (await lstatIfPresent(isolatedData)) {
      throw cleanupPathError(
        `${kind}.cleanup`,
        "a same-path successor appeared after isolated owned data removal",
        [isolatedData, isolatedMarker, dataIsolation.cleanupContainer, markerIsolation.cleanupContainer, path.dirname(filePath)],
        undefined,
        undefined,
        true,
      );
    }
    await releaseCleanupIsolation(dataIsolation, kind, syncDirectory);
  }
  const markerBeforeRemoval = await inspectIsolatedCleanupGeneration(
    markerIsolation,
    kind,
    "isolated owner marker could not be inspected before removal",
  );
  if (!sameFileIdentity(isolatedMarkerIdentity, fileIdentity(markerBeforeRemoval))) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "isolated owner marker changed before removal; preserving cleanup evidence",
      [isolatedMarker, filePath, markerPath, markerIsolation.cleanupContainer, path.dirname(filePath)],
      undefined,
      isolatedMarker,
    );
  }
  await beforeCleanupRemoval(markerIsolation, kind, "file");
  await validateCleanupContainer(markerIsolation, kind);
  const finalMarkerRemoval = await inspectIsolatedCleanupGeneration(
    markerIsolation,
    kind,
    "isolated owner marker changed at the final removal boundary",
  );
  if (!finalMarkerRemoval.isFile()
    || finalMarkerRemoval.isSymbolicLink()
    || !sameFileIdentity(isolatedMarkerIdentity, fileIdentity(finalMarkerRemoval))
    || await lstatIfPresent(markerPath)) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "isolated owner marker or canonical successor changed at the final removal boundary",
      [isolatedMarker, filePath, markerPath, markerIsolation.cleanupContainer, path.dirname(filePath)],
      undefined,
      isolatedMarker,
    );
  }
  let markerRemoved = false;
  try {
    await rm(isolatedMarker, { force: false });
    markerRemoved = true;
    await syncDirectory(markerIsolation.cleanupContainer);
  } catch (error) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      markerRemoved
        ? `owner marker removal committed but durability is ambiguous: ${error instanceof Error ? error.message : String(error)}`
        : `owner marker removal failed: ${error instanceof Error ? error.message : String(error)}`,
      markerRemoved
        ? [filePath, markerPath, markerIsolation.cleanupContainer, path.dirname(filePath)]
        : [isolatedMarker, filePath, markerPath, markerIsolation.cleanupContainer, path.dirname(filePath)],
      error,
      markerRemoved ? undefined : isolatedMarker,
      true,
    );
  }
  if (await lstatIfPresent(isolatedMarker)) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "a same-path successor appeared after isolated owner marker removal",
      [isolatedMarker, markerIsolation.cleanupContainer, path.dirname(filePath)],
      undefined,
      undefined,
      true,
    );
  }
  await releaseCleanupIsolation(markerIsolation, kind, syncDirectory);
}

async function removeCreatedFileAfterIsolation(
  filePath: string,
  expectedIdentity: FileIdentity,
  kind: string,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  const current = await lstatIfPresent(filePath);
  if (!current) return;
  if (!current.isFile()
    || current.isSymbolicLink()
    || !sameFileIdentity(expectedIdentity, fileIdentity(current))) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "newly-created file generation changed; preserving it",
      [filePath, path.dirname(filePath)],
    );
  }
  const isolation = await claimCleanupIsolation(filePath, kind, syncDirectory);
  const isolated = isolation.isolatedPath;
  try {
    await validateCleanupContainer(isolation, kind);
    const finalCanonical = await lstat(filePath);
    if (!finalCanonical.isFile()
      || finalCanonical.isSymbolicLink()
      || !sameFileIdentity(expectedIdentity, fileIdentity(finalCanonical))) {
      throw cleanupPathError(
        `${kind}.cleanup`,
        "newly-created file changed before the no-clobber isolation rename",
        [filePath, isolated, isolation.cleanupContainer, path.dirname(filePath)],
        undefined,
        isolation.cleanupContainer,
      );
    }
    await rename(filePath, isolated);
    await syncDirectory(path.dirname(filePath));
    await syncDirectory(isolation.cleanupContainer);
  } catch (error) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      `newly-created file isolation failed or is not durable: ${error instanceof Error ? error.message : String(error)}`,
      [filePath, isolated, isolation.cleanupContainer, path.dirname(filePath)],
      error,
      await lstatIfPresent(isolated) ? isolated : isolation.cleanupContainer,
    );
  }
  const isolatedDetails = await inspectIsolatedCleanupGeneration(
    isolation,
    kind,
    "isolated newly-created file could not be inspected after cleanup rename",
  );
  const isolatedIdentity = fileIdentity(isolatedDetails);
  if (!isolatedDetails.isFile()
    || isolatedDetails.isSymbolicLink()
    || !sameFileAfterRename(expectedIdentity, isolatedIdentity)
    || await lstatIfPresent(filePath)) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "newly-created file or canonical path changed during cleanup; preserving isolated evidence",
      [filePath, isolated, isolation.cleanupContainer, path.dirname(filePath)],
      undefined,
      isolated,
    );
  }
  const beforeRemoval = await inspectIsolatedCleanupGeneration(
    isolation,
    kind,
    "isolated newly-created file could not be inspected before removal",
  );
  if (!sameFileIdentity(isolatedIdentity, fileIdentity(beforeRemoval))) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "isolated newly-created file changed before removal; preserving it",
      [filePath, isolated, isolation.cleanupContainer, path.dirname(filePath)],
      undefined,
      isolated,
    );
  }
  await beforeCleanupRemoval(isolation, kind, "file");
  await validateCleanupContainer(isolation, kind);
  const finalRemoval = await inspectIsolatedCleanupGeneration(
    isolation,
    kind,
    "isolated newly-created file changed at the final removal boundary",
  );
  if (!finalRemoval.isFile()
    || finalRemoval.isSymbolicLink()
    || !sameFileIdentity(isolatedIdentity, fileIdentity(finalRemoval))
    || await lstatIfPresent(filePath)) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "isolated newly-created file or canonical successor changed at the final removal boundary",
      [filePath, isolated, isolation.cleanupContainer, path.dirname(filePath)],
      undefined,
      isolated,
    );
  }
  let isolatedRemoved = false;
  try {
    await rm(isolated, { force: false });
    isolatedRemoved = true;
    await syncDirectory(isolation.cleanupContainer);
  } catch (error) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      isolatedRemoved
        ? `newly-created file removal committed but durability is ambiguous: ${error instanceof Error ? error.message : String(error)}`
        : `isolated newly-created file removal failed: ${error instanceof Error ? error.message : String(error)}`,
      isolatedRemoved
        ? [filePath, isolation.cleanupContainer, path.dirname(filePath)]
        : [filePath, isolated, isolation.cleanupContainer, path.dirname(filePath)],
      error,
      isolatedRemoved ? undefined : isolated,
      true,
    );
  }
  if (await lstatIfPresent(isolated) || await lstatIfPresent(filePath)) {
    throw cleanupPathError(
      `${kind}.cleanup`,
      "a successor appeared after newly-created file removal",
      [filePath, isolated, isolation.cleanupContainer, path.dirname(filePath)],
      undefined,
      undefined,
      true,
    );
  }
  await releaseCleanupIsolation(isolation, kind, syncDirectory);
}

async function retryOwnedFileCleanup(
  filePath: string,
  token: string,
  kind: string,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
  readHooks?: BoundedRegularFileReadHooks,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await removeOwnedFile(filePath, token, kind, syncDirectory, readHooks);
      return;
    } catch (error) {
      lastError = error;
      if (nestedCommitted(error)) throw error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function retryCleanupAction(action: () => Promise<void>) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      if (nestedCommitted(error)) throw error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function releaseOwnedMarkerForCommittedFile(
  markerOwnerPath: string,
  committedFilePath: string,
  token: string,
  kind: string,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
  readHooks?: BoundedRegularFileReadHooks,
) {
  const markerPath = ownedFileMarkerPath(markerOwnerPath);
  if (!(await lstatIfPresent(markerPath))) return;
  const markerSnapshot = await readOwnedFileMarkerSnapshot(markerOwnerPath, token, kind, readHooks);
  const fileBefore = await lstatIfPresent(committedFilePath);
  if (!fileBefore || !fileBefore.isFile() || fileBefore.isSymbolicLink()) {
    throw cleanupPathError(
      `${kind}.owner`,
      "committed owned file disappeared or became unsafe before marker cleanup",
      [committedFilePath, markerPath, path.dirname(markerPath)],
    );
  }
  const committedIdentity = fileIdentity(fileBefore);
  const recordedIdentity = recordedFileIdentity(markerSnapshot.marker.identity, `${kind}.owner.identity`);
  if (!sameFileIdentity(committedIdentity, recordedIdentity)
    && !sameFileAfterRename(recordedIdentity, committedIdentity)) {
    throw cleanupPathError(
      `${kind}.owner`,
      "committed file generation changed; refusing marker cleanup",
      [committedFilePath, markerPath, path.dirname(markerPath)],
    );
  }
  const fileConfirmed = await lstat(committedFilePath);
  if (!sameFileIdentity(committedIdentity, fileIdentity(fileConfirmed))) {
    throw cleanupPathError(
      `${kind}.owner`,
      "committed file changed before marker isolation",
      [committedFilePath, markerPath, path.dirname(markerPath)],
    );
  }
  const isolation = await claimCleanupIsolation(markerPath, kind, syncDirectory);
  const isolatedMarker = isolation.isolatedPath;
  try {
    await validateCleanupContainer(isolation, kind);
    const finalMarker = await lstat(markerPath);
    if (!finalMarker.isFile()
      || finalMarker.isSymbolicLink()
      || !sameFileIdentity(markerSnapshot.identity, fileIdentity(finalMarker))) {
      throw cleanupPathError(
        `${kind}.owner`,
        "owner marker changed before the no-clobber isolation rename",
        [committedFilePath, markerPath, isolatedMarker, isolation.cleanupContainer, path.dirname(markerPath)],
        undefined,
        isolation.cleanupContainer,
      );
    }
    await rename(markerPath, isolatedMarker);
    await syncDirectory(path.dirname(markerPath));
    await syncDirectory(isolation.cleanupContainer);
  } catch (error) {
    throw cleanupPathError(
      `${kind}.owner`,
      `owner marker isolation failed or is not durable: ${error instanceof Error ? error.message : String(error)}`,
      [committedFilePath, markerPath, isolatedMarker, isolation.cleanupContainer, path.dirname(markerPath)],
      error,
      await lstatIfPresent(isolatedMarker) ? isolatedMarker : isolation.cleanupContainer,
    );
  }
  const isolatedSnapshot = await readMetadataSnapshot(
    isolatedMarker,
    `${kind}.owner`,
    OWNER_MARKER_MAX_BYTES,
    readHooks,
  );
  validateOwnedFileMarker(isolatedSnapshot.value, token, kind, `${kind}.owner`);
  if (!sameFileAfterRename(markerSnapshot.identity, isolatedSnapshot.identity)) {
    throw cleanupPathError(
      `${kind}.owner`,
      "owner marker generation changed during isolation; preserving it",
      [committedFilePath, markerPath, isolatedMarker, isolation.cleanupContainer, path.dirname(markerPath)],
      undefined,
      isolatedMarker,
    );
  }
  const committedConfirmed = await lstat(committedFilePath);
  if (!sameFileIdentity(committedIdentity, fileIdentity(committedConfirmed))
    || await lstatIfPresent(markerPath)) {
    throw cleanupPathError(
      `${kind}.owner`,
      "committed file or marker path changed before marker removal; preserving isolated marker",
      [committedFilePath, markerPath, isolatedMarker, isolation.cleanupContainer, path.dirname(markerPath)],
      undefined,
      isolatedMarker,
    );
  }
  const markerConfirmed = await inspectIsolatedCleanupGeneration(
    isolation,
    `${kind}.owner`,
    "isolated committed owner marker could not be inspected before removal",
  );
  if (!sameFileIdentity(isolatedSnapshot.identity, fileIdentity(markerConfirmed))) {
    throw cleanupPathError(
      `${kind}.owner`,
      "isolated owner marker changed before removal; preserving it",
      [committedFilePath, markerPath, isolatedMarker, isolation.cleanupContainer, path.dirname(markerPath)],
      undefined,
      isolatedMarker,
    );
  }
  await beforeCleanupRemoval(isolation, `${kind}.owner`, "file");
  await validateCleanupContainer(isolation, `${kind}.owner`);
  const finalMarkerRemoval = await inspectIsolatedCleanupGeneration(
    isolation,
    `${kind}.owner`,
    "isolated committed owner marker changed at the final removal boundary",
  );
  if (!finalMarkerRemoval.isFile()
    || finalMarkerRemoval.isSymbolicLink()
    || !sameFileIdentity(isolatedSnapshot.identity, fileIdentity(finalMarkerRemoval))
    || await lstatIfPresent(markerPath)) {
    throw cleanupPathError(
      `${kind}.owner`,
      "isolated owner marker or canonical successor changed at the final removal boundary",
      [committedFilePath, markerPath, isolatedMarker, isolation.cleanupContainer, path.dirname(markerPath)],
      undefined,
      isolatedMarker,
    );
  }
  let markerRemoved = false;
  try {
    await rm(isolatedMarker, { force: false });
    markerRemoved = true;
    await syncDirectory(isolation.cleanupContainer);
  } catch (error) {
    throw cleanupPathError(
      `${kind}.owner`,
      markerRemoved
        ? `owner marker removal committed but durability is ambiguous: ${error instanceof Error ? error.message : String(error)}`
        : `isolated owner marker removal failed: ${error instanceof Error ? error.message : String(error)}`,
      markerRemoved
        ? [committedFilePath, markerPath, isolation.cleanupContainer, path.dirname(markerPath)]
        : [committedFilePath, markerPath, isolatedMarker, isolation.cleanupContainer, path.dirname(markerPath)],
      error,
      markerRemoved ? undefined : isolatedMarker,
      true,
    );
  }
  await releaseCleanupIsolation(isolation, `${kind}.owner`, syncDirectory);
  const committedAfter = await lstatIfPresent(committedFilePath);
  if (!committedAfter || !sameFileIdentity(committedIdentity, fileIdentity(committedAfter))) {
    throw cleanupPathError(
      `${kind}.owner`,
      "committed file generation changed while removing its owner marker",
      [committedFilePath, markerPath, path.dirname(markerPath)],
      undefined,
      committedFilePath,
    );
  }
}

async function releaseOwnedFileMarker(
  filePath: string,
  token: string,
  kind: string,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
  readHooks?: BoundedRegularFileReadHooks,
) {
  await releaseOwnedMarkerForCommittedFile(filePath, filePath, token, kind, syncDirectory, readHooks);
}

async function releaseRenamedOwnedFileMarker(
  originalFilePath: string,
  committedFilePath: string,
  token: string,
  kind: string,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
  readHooks?: BoundedRegularFileReadHooks,
) {
  await releaseOwnedMarkerForCommittedFile(
    originalFilePath,
    committedFilePath,
    token,
    kind,
    syncDirectory,
    readHooks,
  );
}

function capturedExactProcessIdentity(value: unknown, pathName: string): ProcessIdentity {
  const identity = recordValue(value);
  const capturedAt = typeof identity.capturedAt === "string" ? identity.capturedAt : "";
  const capturedAtMs = Date.parse(capturedAt);
  if (!Number.isSafeInteger(identity.pid)
    || Number(identity.pid) <= 0
    || typeof identity.birthId !== "string"
    || identity.birthId.length === 0
    || identity.incarnation !== `${identity.pid}:${identity.birthId}`
    || !Number.isFinite(capturedAtMs)
    || new Date(capturedAtMs).toISOString() !== capturedAt
    || identity.birthIdPrecision !== "exact") {
    throw new PromotionError(pathName, "must contain a valid captured process identity");
  }
  const processGroupId = identity.processGroupId;
  if (processGroupId !== undefined
    && (!Number.isSafeInteger(processGroupId) || Number(processGroupId) <= 0)) {
    throw new PromotionError(pathName, "must contain a valid captured process identity");
  }
  return {
    pid: Number(identity.pid),
    birthId: identity.birthId,
    incarnation: identity.incarnation,
    capturedAt,
    birthIdPrecision: "exact",
    ...(processGroupId === undefined ? {} : { processGroupId: Number(processGroupId) }),
  };
}

function validatedProcessIdentity(value: unknown, pathName: string): ProcessIdentity {
  const identity = recordValue(value);
  if (identity.birthIdPrecision !== "exact") {
    throw new PromotionError(pathName, "must contain an explicit exact process identity");
  }
  return capturedExactProcessIdentity(identity, pathName);
}

async function readDirectoryLockSnapshot(
  lockDirectory: string,
  expectedKind: string,
  readHooks?: BoundedRegularFileReadHooks,
  movedFromIdentity?: FileIdentity,
): Promise<DirectoryLockSnapshot | null> {
  const before = await lstatIfPresent(lockDirectory);
  if (!before) return null;
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw promotionPathError(
      `${expectedKind}.owner`,
      "lock must be a non-symlink directory",
      "PROMOTION_METADATA_UNSAFE",
      [lockDirectory, path.join(lockDirectory, OWNER_MARKER), path.dirname(lockDirectory)],
    );
  }
  const beforeIdentity = fileIdentity(before);
  const markerPath = path.join(lockDirectory, OWNER_MARKER);
  try {
    const markerSnapshot = await readMetadataSnapshot(
      markerPath,
      `${expectedKind}.owner`,
      OWNER_MARKER_MAX_BYTES,
      readHooks,
    );
    const marker = markerSnapshot.value;
    if (!isRecord(marker)
      || marker.generator !== "scripts/promote-live-release-evidence.ts#ownerToken"
      || marker.kind !== expectedKind
      || typeof marker.token !== "string"
      || marker.token.length === 0
      || typeof marker.generation !== "string"
      || marker.generation.length === 0
      || !Number.isInteger(marker.fencePort)
      || Number(marker.fencePort) < 1
      || Number(marker.fencePort) > 65_535) {
      throw promotionPathError(
        `${expectedKind}.owner`,
        "lock owner marker is malformed",
        "PROMOTION_METADATA_MALFORMED",
        [markerPath, lockDirectory, path.dirname(lockDirectory)],
      );
    }
    const after = await lstat(lockDirectory);
    const currentIdentity = fileIdentity(after);
    if (!after.isDirectory()
      || after.isSymbolicLink()
      || !sameFileIdentity(beforeIdentity, currentIdentity)) {
      throw promotionPathError(
        `${expectedKind}.owner`,
        "lock directory generation changed while reading its owner marker",
        "PROMOTION_METADATA_CHANGED",
        [markerPath, lockDirectory, path.dirname(lockDirectory)],
      );
    }
    const recordedIdentity = recordedFileIdentity(marker.identity, `${expectedKind}.owner.identity`);
    const recordedMatchesCurrent = sameFileIdentity(currentIdentity, recordedIdentity)
      || sameFileAfterRename(recordedIdentity, currentIdentity);
    const movedGenerationMatches = movedFromIdentity === undefined
      || (sameFileAfterRename(recordedIdentity, movedFromIdentity)
        && sameFileAfterRename(movedFromIdentity, currentIdentity));
    if (!recordedMatchesCurrent || !movedGenerationMatches) {
      throw promotionPathError(
        `${expectedKind}.owner`,
        "lock directory generation changed",
        "PROMOTION_OWNER_GENERATION_CHANGED",
        [markerPath, lockDirectory, path.dirname(lockDirectory)],
      );
    }
    return {
      token: marker.token,
      kind: expectedKind,
      generation: marker.generation,
      fencePort: Number(marker.fencePort),
      identity: currentIdentity,
      processIdentity: validatedProcessIdentity(marker.processIdentity, `${expectedKind}.owner`),
    };
  } catch (error) {
    const afterFailure = await lstatIfPresent(lockDirectory);
    if (!afterFailure) return null;
    if (afterFailure.isDirectory()
      && !afterFailure.isSymbolicLink()
      && !sameFileIncarnation(beforeIdentity, fileIdentity(afterFailure))) {
      // The observed generation completed release while this snapshot was
      // being read. Restart acquisition against the successor instead of
      // misreporting the expected handoff race as corrupt owner metadata.
      return null;
    }
    throw error;
  }
}

function directoryLockIsStale(snapshot: DirectoryLockSnapshot, runtime: LockRuntime) {
  const current = runtime.captureIdentity(snapshot.processIdentity.pid);
  if (!current || !sameProcessIdentity(snapshot.processIdentity, current)) return true;
  return sameProcessIdentity(snapshot.processIdentity, runtime.currentIdentity)
    && !activeLockGenerations.has(snapshot.generation);
}

function captureLiveProcessIdentity(pid: number) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ESRCH") return null;
    throw error;
  }
  const identity = captureProcessIdentity(pid, { strict: true });
  return identity ? capturedExactProcessIdentity(identity, "lock.identity") : null;
}

const LOCK_FENCE_PREFIX = "CPB_PROMOTION_LOCK_FENCE_V1";

async function listenForLockFence(port: number, token: string): Promise<Server | null> {
  const server = createServer((socket) => {
    socket.end(`${LOCK_FENCE_PREFIX} ${token}\n`);
  });
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    };
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.removeListener("error", onError);
      server.unref();
      resolve(server);
    });
  });
}

function releaseLockFence(server: Server) {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  };
}

async function probeLockProcessFence(port: number, token: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let data = "";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(250, () => finish(false));
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.includes("\n")) {
        finish(data.trim() === `${LOCK_FENCE_PREFIX} ${token}`);
      }
    });
    socket.on("error", () => finish(false));
    socket.on("end", () => finish(data.trim() === `${LOCK_FENCE_PREFIX} ${token}`));
  });
}

type AcquiredFence = {
  port: number;
  release: () => Promise<void>;
  held: boolean;
  ownerProof: boolean;
};

async function acquireLockProcessFence(
  port: number,
  token: string,
  kind: string,
  deadline: number,
): Promise<AcquiredFence> {
  for (;;) {
    const server = await listenForLockFence(port, token);
    if (server) return { port, release: releaseLockFence(server), held: true, ownerProof: false };
    if (await probeLockProcessFence(port, token)) {
      return { port, release: async () => {}, held: false, ownerProof: true };
    }
    if (Date.now() >= deadline) {
      return { port, release: async () => {}, held: false, ownerProof: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function acquireFreshLockProcessFence(token: string) {
  const server = await listenForLockFence(0, token);
  if (!server) throw new PromotionError("lock", "could not allocate a publication process fence");
  const address = server.address();
  if (!address || typeof address === "string") {
    await releaseLockFence(server)();
    throw new PromotionError("lock", "publication process fence did not report a TCP port");
  }
  return { port: address.port, release: releaseLockFence(server), held: true, ownerProof: false };
}

async function initializeDirectoryLock(
  lockDirectory: string,
  token: string,
  kind: string,
  runtime: LockRuntime,
  fencePort: number,
  releaseFence: () => Promise<void>,
  afterPhaseForTest?: PromoteLiveReleaseEvidenceOptions["afterPhaseForTest"],
): Promise<DirectoryLockHandle | null> {
  const generation = randomUUID();
  const pendingDirectory = `${lockDirectory}.pending.${generation}`;
  let identity: FileIdentity | null = null;
  let creationIdentity: FileIdentity | null = null;
  try {
    await mkdir(pendingDirectory);
    creationIdentity = fileIdentity(await lstat(pendingDirectory));
    await afterPhaseForTest?.("lock-directory-created", {
      kind,
      lockDirectory,
      markerPath: path.join(pendingDirectory, OWNER_MARKER),
      generation,
    });
    const beforeMarker = await lstat(pendingDirectory);
    identity = fileIdentity(beforeMarker);
    if (!beforeMarker.isDirectory()
      || beforeMarker.isSymbolicLink()
      || !sameFileInode(creationIdentity, identity)) {
      throw promotionPathError(
        `${kind}.owner`,
        "newly-created lock directory was replaced before owner initialization",
        "PROMOTION_OWNER_GENERATION_CHANGED",
        [pendingDirectory, path.dirname(pendingDirectory)],
      );
    }
    identity = await writeOwnerMarker(pendingDirectory, token, kind, {
      generation,
      fencePort,
      processIdentity: runtime.currentIdentity,
    }, runtime.syncDirectory);
    activeLockGenerations.add(generation);
    let published = false;
    try {
      await rename(pendingDirectory, lockDirectory);
      published = true;
      await runtime.syncDirectory(path.dirname(lockDirectory));
    } catch (error) {
      if (published) {
        throw promotionPathError(
          `${kind}.owner`,
          "lock publication committed but parent directory durability is ambiguous",
          "PROMOTION_METADATA_COMMITTED_AMBIGUOUS",
          [lockDirectory, path.join(lockDirectory, OWNER_MARKER), path.dirname(lockDirectory)],
          error,
          { committed: true, committedPath: lockDirectory },
        );
      }
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST"
        && (error as NodeJS.ErrnoException | undefined)?.code !== "ENOTEMPTY") {
        throw error;
      }
      activeLockGenerations.delete(generation);
      await removeOwnedDirectory(
        pendingDirectory,
        token,
        kind,
        generation,
        runtime.syncDirectory,
        { expectedIdentity: identity, readHooks: runtime.readHooks },
      );
      return null;
    }
    const snapshot = await readDirectoryLockSnapshot(lockDirectory, kind, runtime.readHooks, identity);
    if (!snapshot
      || snapshot.token !== token
      || snapshot.generation !== generation
      || !sameFileAfterRename(identity, snapshot.identity)) {
      throw promotionPathError(
        `${kind}.owner`,
        "new lock ownership changed during publication",
        "PROMOTION_OWNER_GENERATION_CHANGED",
        [lockDirectory, path.join(lockDirectory, OWNER_MARKER), path.dirname(lockDirectory)],
      );
    }
    return {
      directory: lockDirectory,
      ...snapshot,
      recoveredStale: false,
      syncDirectory: runtime.syncDirectory,
      readHooks: runtime.readHooks,
      releaseFence,
    } satisfies DirectoryLockHandle;
  } catch (error) {
    activeLockGenerations.delete(generation);
    const cleanupFailures: unknown[] = [];
    if (identity && await lstatIfPresent(pendingDirectory)) {
      try {
        await removeCreatedDirectory(pendingDirectory, identity, kind, runtime.syncDirectory);
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
    if (cleanupFailures.length > 0) throw new PromotionAggregateError(error, cleanupFailures);
    throw error;
  }
}

async function acquireDirectoryLock(
  lockDirectory: string,
  token: string,
  kind: string,
  runtime: LockRuntime,
  afterPhaseForTest?: PromoteLiveReleaseEvidenceOptions["afterPhaseForTest"],
): Promise<DirectoryLockHandle> {
  await mkdir(path.dirname(lockDirectory), { recursive: true });
  const deadline = Date.now() + runtime.timeoutMs;
  for (;;) {
    const observed = await readDirectoryLockSnapshot(lockDirectory, kind, runtime.readHooks);
    const fence = observed
      ? await acquireLockProcessFence(observed.fencePort, observed.token, kind, deadline)
      : await acquireFreshLockProcessFence(token);
    try {
      const current = await readDirectoryLockSnapshot(lockDirectory, kind, runtime.readHooks);
      if (observed && (!current
        || current.token !== observed.token
        || current.generation !== observed.generation
        || current.fencePort !== observed.fencePort
        || !sameFileIdentity(current.identity, observed.identity))) {
        await fence.release();
        continue;
      }
      if (!observed && current) {
        await fence.release();
        continue;
      }
      if (!current) {
        const initialized = await initializeDirectoryLock(
          lockDirectory,
          token,
          kind,
          runtime,
          fence.port,
          fence.release,
          afterPhaseForTest,
        );
        if (initialized) return initialized;
        await fence.release();
        continue;
      }
      if (!directoryLockIsStale(current, runtime)) {
        await fence.release();
        if (Date.now() >= deadline) throw new PromotionError(kind, "timed out waiting for publication lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }

      const quarantined = `${lockDirectory}.stale.${current.generation}.${randomUUID()}`;
      await verifyOwnerMarker(
        lockDirectory,
        current.token,
        kind,
        current.generation,
        current.identity,
        runtime.readHooks,
      );
      await rename(lockDirectory, quarantined);
      try {
        await runtime.syncDirectory(path.dirname(lockDirectory));
      } catch (error) {
        throw promotionPathError(
          `${kind}.cleanup`,
          `stale lock was quarantined but parent durability is ambiguous: ${quarantined}`,
          "PROMOTION_CLEANUP_COMMITTED_AMBIGUOUS",
          [quarantined, lockDirectory, path.dirname(lockDirectory)],
          error,
          { committed: true, committedPath: quarantined },
        );
      }
      const quarantinedSnapshot = await readDirectoryLockSnapshot(
        quarantined,
        kind,
        runtime.readHooks,
        current.identity,
      );
      if (!quarantinedSnapshot
        || quarantinedSnapshot.token !== current.token
        || quarantinedSnapshot.generation !== current.generation
        || quarantinedSnapshot.fencePort !== current.fencePort
        || !sameFileAfterRename(current.identity, quarantinedSnapshot.identity)) {
        throw promotionPathError(
          `${kind}.cleanup`,
          `stale lock changed during quarantine; preserving it: ${quarantined}`,
          "PROMOTION_CLEANUP_GENERATION_CHANGED",
          [quarantined, lockDirectory, path.dirname(lockDirectory)],
          undefined,
          { committed: true, committedPath: quarantined },
        );
      }
      const takeoverFence = fence.held ? fence : await acquireFreshLockProcessFence(token);
      const initialized = await initializeDirectoryLock(
        lockDirectory,
        token,
        kind,
        runtime,
        takeoverFence.port,
        takeoverFence.release,
        afterPhaseForTest,
      );
      if (!initialized) {
        await takeoverFence.release();
        throw new PromotionError(kind, "another owner replaced the lock while its process fence was held");
      }
      initialized.recoveredStale = true;
      try {
        await afterPhaseForTest?.("after-stale-lock-quarantine", {
          kind,
          lockDirectory,
          quarantinedDirectory: quarantined,
          generation: initialized.generation,
          staleGeneration: current.generation,
        });
        if (!directoryLockIsStale(quarantinedSnapshot, runtime)) {
          throw new PromotionError(`${kind}.cleanup`, "quarantined owner became active; refusing stale cleanup");
        }
        await removeOwnedDirectory(
          quarantined,
          current.token,
          kind,
          current.generation,
          runtime.syncDirectory,
          {
            expectedIdentity: quarantinedSnapshot.identity,
            expectedSuccessor: initialized,
            readHooks: runtime.readHooks,
          },
        );
        return initialized;
      } catch (error) {
        const cleanupFailures: unknown[] = [];
        try {
          await releaseDirectoryLock(initialized);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        if (cleanupFailures.length > 0) throw new PromotionAggregateError(error, cleanupFailures);
        throw error;
      }
    } catch (error) {
      const cleanupFailures: unknown[] = [];
      try {
        await fence.release();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
      if (cleanupFailures.length > 0) throw new PromotionAggregateError(error, cleanupFailures);
      throw error;
    }
  }
}

async function releaseDirectoryLock(
  handle: DirectoryLockHandle,
  beforeRelease?: () => void | Promise<void>,
) {
  let failure: unknown = null;
  try {
    await beforeRelease?.();
    await removeOwnedDirectory(
      handle.directory,
      handle.token,
      handle.kind,
      handle.generation,
      handle.syncDirectory,
      { expectedIdentity: handle.identity, allowSuccessor: true, readHooks: handle.readHooks },
    );
  } catch (error) {
    failure = error;
  } finally {
    activeLockGenerations.delete(handle.generation);
    try {
      await handle.releaseFence();
    } catch (error) {
      if (!failure) failure = error;
      else failure = new PromotionAggregateError(failure, [error]);
    }
  }
  if (failure) throw failure;
}

async function copyFileExclusive(
  source: string,
  destination: string,
  pathName: string,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await syncFile(destination);
    await syncDirectory(path.dirname(destination));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      throw new PromotionError(pathName, "destination already exists");
    }
    throw error;
  }
}

async function copyOwnedFileExclusive(
  source: string,
  destination: string,
  token: string,
  kind: string,
  metadata: Record<string, unknown> = {},
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  await copyFileExclusive(source, destination, "destination", syncDirectory);
  const identity = fileIdentity(await lstat(destination));
  try {
    await writeOwnedFileMarker(destination, token, kind, metadata, syncDirectory);
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      await removeCreatedFileAfterIsolation(destination, identity, kind, syncDirectory);
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      if (await lstatIfPresent(ownedFileMarkerPath(destination))) {
        await retryOwnedFileCleanup(destination, token, kind, syncDirectory);
      }
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (!(await lstatIfPresent(destination))
      && !(await lstatIfPresent(ownedFileMarkerPath(destination)))
      && !cleanupFailures.some((cleanupError) => nestedCommitted(cleanupError))) {
      cleanupFailures.length = 0;
    }
    if (cleanupFailures.length > 0) throw new PromotionAggregateError(error, cleanupFailures);
    throw error;
  }
}

async function writeOwnedJsonExclusive(
  filePath: string,
  value: unknown,
  token: string,
  kind: string,
  metadata: Record<string, unknown> = {},
  afterMarkerInitialized?: () => void | Promise<void>,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  await writeJsonExclusive(filePath, value, syncDirectory);
  const identity = fileIdentity(await lstat(filePath));
  try {
    await writeOwnedFileMarker(filePath, token, kind, metadata, syncDirectory);
    await afterMarkerInitialized?.();
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      await removeCreatedFileAfterIsolation(filePath, identity, kind, syncDirectory);
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    try {
      if (await lstatIfPresent(ownedFileMarkerPath(filePath))) {
        await retryOwnedFileCleanup(filePath, token, kind, syncDirectory);
      }
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (!(await lstatIfPresent(filePath))
      && !(await lstatIfPresent(ownedFileMarkerPath(filePath)))
      && !cleanupFailures.some((cleanupError) => nestedCommitted(cleanupError))) {
      cleanupFailures.length = 0;
    }
    if (cleanupFailures.length > 0) throw new PromotionAggregateError(error, cleanupFailures);
    throw error;
  }
}

function receiptFingerprint(receipt: Pick<
  CleanupReceipt,
  | "providerOnly"
  | "runId"
  | "runDirectory"
  | "providerEvidenceFile"
  | "providerSha"
  | "draftPrEvidenceFile"
  | "draftSha"
  | "liveReleaseEvidenceFile"
  | "productEvidenceFile"
  | "productSha"
>) {
  return sha256(stableJson({
    providerOnly: receipt.providerOnly,
    runId: receipt.runId,
    runDirectory: receipt.runDirectory,
    providerEvidenceFile: receipt.providerEvidenceFile,
    providerSha: receipt.providerSha,
    draftPrEvidenceFile: receipt.draftPrEvidenceFile,
    draftSha: receipt.draftSha,
    liveReleaseEvidenceFile: receipt.liveReleaseEvidenceFile,
    productEvidenceFile: receipt.productEvidenceFile,
    productSha: receipt.productSha,
  }));
}

function publicReceipt(receipt: CleanupReceipt): PromotionCommitReceipt {
  return {
    transactionId: receipt.transactionId,
    runId: receipt.runId,
    providerOnly: receipt.providerOnly,
    cleanupReceiptFile: receipt.receiptFile,
  };
}

async function writeCleanupReceipt(
  repoRoot: string,
  receipt: CleanupReceipt,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  const receiptAbs = path.resolve(repoRoot, receipt.receiptFile);
  await writeOwnedJsonExclusive(receiptAbs, receipt, receipt.ownerToken, "cleanup-receipt", { receipt }, undefined, syncDirectory);
}

async function rewriteJsonPinned(
  filePath: string,
  value: unknown,
  expectedIdentity: FileIdentity,
  pathName: string,
  recoveryPaths: string[],
) {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw promotionPathError(
      pathName,
      "no-follow metadata updates are unavailable",
      "PROMOTION_METADATA_UNSAFE",
      recoveryPaths,
    );
  }
  const before = await lstat(filePath);
  if (!before.isFile()
    || before.isSymbolicLink()
    || !sameFileIdentity(expectedIdentity, fileIdentity(before))) {
    throw promotionPathError(
      pathName,
      "metadata generation changed before guarded update",
      "PROMOTION_METADATA_CHANGED",
      recoveryPaths,
    );
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let mutationStarted = false;
  let primaryError: unknown = null;
  let updatedIdentity: FileIdentity | null = null;
  try {
    handle = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(expectedIdentity, fileIdentity(opened))) {
      throw new Error("metadata generation changed while opening guarded update");
    }
    mutationStarted = true;
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    const afterDescriptor = await handle.stat();
    const afterPath = await lstat(filePath);
    updatedIdentity = fileIdentity(afterDescriptor);
    if (!afterDescriptor.isFile()
      || !afterPath.isFile()
      || afterPath.isSymbolicLink()
      || !sameFileIdentity(updatedIdentity, fileIdentity(afterPath))) {
      throw new Error("metadata path changed during guarded update");
    }
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
  if (errors.length > 0) {
    const cause = errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `guarded metadata update failed: ${filePath}`, {
        cause: primaryError ?? closeError,
      });
    throw promotionPathError(
      pathName,
      `guarded metadata update failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      mutationStarted ? "PROMOTION_METADATA_COMMITTED_AMBIGUOUS" : "PROMOTION_METADATA_CHANGED",
      recoveryPaths,
      cause,
      mutationStarted ? { committed: true, committedPath: filePath } : {},
    );
  }
  if (!updatedIdentity) throw new Error(`guarded metadata update did not capture identity: ${filePath}`);
  return updatedIdentity;
}

async function updateCleanupReceipt(
  repoRoot: string,
  receipt: CleanupReceipt,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
  readHooks?: BoundedRegularFileReadHooks,
) {
  const receiptAbs = path.resolve(repoRoot, receipt.receiptFile);
  const markerPath = ownedFileMarkerPath(receiptAbs);
  const recoveryPaths = [receiptAbs, markerPath, path.dirname(receiptAbs)];
  const dataSnapshot = await readMetadataSnapshot(
    receiptAbs,
    "cleanup-receipt",
    CLEANUP_RECEIPT_MAX_BYTES,
    readHooks,
  );
  const markerSnapshot = await readOwnedFileMarkerSnapshot(
    receiptAbs,
    receipt.ownerToken,
    "cleanup-receipt",
    readHooks,
  );
  const recordedIdentity = recordedFileIdentity(
    markerSnapshot.marker.identity,
    "cleanup-receipt.owner.identity",
  );
  if (!sameFileIdentity(dataSnapshot.identity, recordedIdentity)) {
    throw promotionPathError(
      "cleanup-receipt.owner",
      "receipt generation changed; refusing guarded update",
      "PROMOTION_OWNER_GENERATION_CHANGED",
      recoveryPaths,
    );
  }
  const updatedDataIdentity = await rewriteJsonPinned(
    receiptAbs,
    receipt,
    dataSnapshot.identity,
    "cleanup-receipt",
    recoveryPaths,
  );
  const updatedMarker = {
    ...markerSnapshot.marker,
    identity: updatedDataIdentity,
    receipt,
  };
  try {
    await rewriteJsonPinned(
      markerPath,
      updatedMarker,
      markerSnapshot.identity,
      "cleanup-receipt.owner",
      recoveryPaths,
    );
  } catch (error) {
    throw promotionPathError(
      "cleanup-receipt.owner",
      `receipt data committed before owner marker update completed: ${error instanceof Error ? error.message : String(error)}`,
      "PROMOTION_METADATA_COMMITTED_AMBIGUOUS",
      recoveryPaths,
      error,
      { committed: true, committedPath: receiptAbs },
    );
  }
  try {
    await syncDirectory(path.dirname(receiptAbs));
  } catch (error) {
    throw promotionPathError(
      "cleanup-receipt",
      "cleanup receipt update committed but parent directory durability is ambiguous",
      "PROMOTION_METADATA_COMMITTED_AMBIGUOUS",
      recoveryPaths,
      error,
      { committed: true, committedPath: receiptAbs },
    );
  }
}

async function readCleanupReceipt(
  repoRoot: string,
  receiptFile: string,
  readHooks?: BoundedRegularFileReadHooks,
): Promise<CleanupReceipt | null> {
  const receiptAbs = path.resolve(repoRoot, receiptFile);
  const markerPath = ownedFileMarkerPath(receiptAbs);
  const dataDetails = await lstatIfPresent(receiptAbs);
  const markerDetails = await lstatIfPresent(markerPath);
  if (!dataDetails && !markerDetails) return null;
  if (!markerDetails) {
    throw promotionPathError(
      "cleanup-receipt.owner",
      "cleanup receipt owner marker is missing",
      "PROMOTION_OWNER_MISSING",
      [receiptAbs, markerPath, path.dirname(receiptAbs)],
    );
  }
  const markerSnapshot = await readMetadataSnapshot(
    markerPath,
    "cleanup-receipt.owner",
    CLEANUP_RECEIPT_MAX_BYTES,
    readHooks,
  );
  let value: unknown;
  let dataSnapshot: MetadataSnapshot | null = null;
  if (dataDetails) {
    dataSnapshot = await readMetadataSnapshot(
      receiptAbs,
      "cleanup-receipt",
      CLEANUP_RECEIPT_MAX_BYTES,
      readHooks,
    );
    value = dataSnapshot.value;
  } else {
    value = recordValue(markerSnapshot.value).receipt;
  }
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.generator !== "scripts/promote-live-release-evidence.ts#cleanupReceipt"
    || typeof value.transactionId !== "string"
    || typeof value.ownerToken !== "string"
    || typeof value.fingerprint !== "string"
    || typeof value.runId !== "string"
    || typeof value.runDirectory !== "string"
    || typeof value.providerOnly !== "boolean"
    || typeof value.providerEvidenceFile !== "string"
    || typeof value.providerSha !== "string"
    || typeof value.receiptFile !== "string"
    || typeof value.runLock !== "string"
    || typeof value.lockGeneration !== "string"
    || value.lockGeneration.length === 0
    || (value.cleanupGeneration !== null
      && (typeof value.cleanupGeneration !== "string" || value.cleanupGeneration.length === 0))
    || (value.state !== "prepared"
      && value.state !== "commit-intent"
      && value.state !== "cleanup-required"
      && value.state !== "committed-clean")) {
    throw promotionPathError(
      "cleanup-receipt",
      "must contain a valid promotion cleanup receipt",
      "PROMOTION_METADATA_MALFORMED",
      [receiptAbs, markerPath, path.dirname(receiptAbs)],
    );
  }
  const receipt = value as CleanupReceipt;
  const marker = validateOwnedFileMarker(
    markerSnapshot.value,
    receipt.ownerToken,
    "cleanup-receipt",
    "cleanup-receipt.owner",
  );
  if (dataSnapshot) {
    const recordedIdentity = recordedFileIdentity(marker.identity, "cleanup-receipt.owner.identity");
    if (!sameFileIdentity(recordedIdentity, dataSnapshot.identity)
      || stableJson(marker.receipt) !== stableJson(receipt)) {
      throw promotionPathError(
        "cleanup-receipt.owner",
        "cleanup receipt and owner marker generations do not match",
        "PROMOTION_OWNER_GENERATION_CHANGED",
        [receiptAbs, markerPath, path.dirname(receiptAbs)],
      );
    }
  }
  const expectedRunDirectory = `${RUNS_ROOT}/${sanitizeRunId(receipt.runId)}`;
  const expectedRunLock = `${path.dirname(expectedRunDirectory)}/.${sanitizeRunId(receipt.runId)}.publish.lock`;
  const localPath = (candidate: unknown) => {
    if (typeof candidate !== "string" || !candidate || path.isAbsolute(candidate)) return false;
    const relative = path.relative(repoRoot, path.resolve(repoRoot, candidate));
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const expectedManifestLock = receipt.liveReleaseEvidenceFile
    ? `${path.dirname(receipt.liveReleaseEvidenceFile)}/.${path.basename(receipt.liveReleaseEvidenceFile)}.publish.lock`
    : null;
  if (receipt.receiptFile !== receiptFile
    || receipt.runId !== sanitizeRunId(receipt.runId)
    || receipt.runDirectory !== expectedRunDirectory
    || receipt.runLock !== expectedRunLock
    || receipt.providerEvidenceFile !== `${expectedRunDirectory}/provider-connectivity.json`
    || receipt.draftPrEvidenceFile !== (receipt.providerOnly ? null : `${expectedRunDirectory}/draft-pr-rehearsal.json`)
    || receipt.manifestLock !== expectedManifestLock
    || receipt.fingerprint !== receiptFingerprint(receipt)
    || !localPath(receipt.receiptFile)
    || !localPath(receipt.runLock)
    || !localPath(receipt.providerEvidenceFile)
    || (receipt.draftPrEvidenceFile !== null && !localPath(receipt.draftPrEvidenceFile))
    || (receipt.liveReleaseEvidenceFile !== null && !localPath(receipt.liveReleaseEvidenceFile))
    || (receipt.productEvidenceFile !== null && !localPath(receipt.productEvidenceFile))
    || (receipt.manifestLock !== null && !localPath(receipt.manifestLock))
    || (receipt.candidateFile !== null && !localPath(receipt.candidateFile))) {
    throw promotionPathError(
      "cleanup-receipt",
      "contains inconsistent or non-local transaction paths",
      "PROMOTION_METADATA_MALFORMED",
      [receiptAbs, markerPath, path.dirname(receiptAbs)],
    );
  }
  return receipt;
}

function manifestFingerprint(value: unknown) {
  const manifest = recordValue(value);
  return sha256(stableJson({
    providerConnectivity: manifest.providerConnectivity,
    draftPrRehearsal: manifest.draftPrRehearsal,
    productEvidence: manifest.productEvidence,
  }));
}

function expectedManifestFingerprint(receipt: CleanupReceipt) {
  return sha256(stableJson({
    providerConnectivity: {
      evidenceBundleRef: receipt.providerEvidenceFile,
      sha256: receipt.providerSha,
    },
    draftPrRehearsal: {
      evidenceBundleRef: receipt.draftPrEvidenceFile,
      sha256: receipt.draftSha,
    },
    productEvidence: {
      evidenceBundleRef: receipt.productEvidenceFile,
      sha256: receipt.productSha,
    },
  }));
}

async function receiptCommitIsPresent(
  repoRoot: string,
  receipt: CleanupReceipt,
  readHooks?: BoundedRegularFileReadHooks,
) {
  if (receipt.state === "prepared") return false;
  if (receipt.providerOnly) {
    const providerAbs = path.resolve(repoRoot, receipt.providerEvidenceFile);
    const providerDetails = await lstatIfPresent(providerAbs);
    return Boolean(providerDetails?.isFile()) && await sha256File(providerAbs) === receipt.providerSha;
  }
  if (!receipt.liveReleaseEvidenceFile) return false;
  const manifestAbs = path.resolve(repoRoot, receipt.liveReleaseEvidenceFile);
  const manifestDetails = await lstatIfPresent(manifestAbs);
  if (!manifestDetails?.isFile() || manifestDetails.isSymbolicLink()) return false;
  const manifest = await readMetadataSnapshot(
    manifestAbs,
    "cleanup-receipt.manifest",
    CLEANUP_RECEIPT_MAX_BYTES,
    readHooks,
  );
  return manifestFingerprint(manifest.value) === expectedManifestFingerprint(receipt);
}

function cleanupResidual(pathName: string, kind: string, error: unknown): PromotionResidual {
  const recoveryPaths = nestedRecoveryPaths(error);
  return {
    path: pathName,
    kind,
    reason: error instanceof Error ? error.message : String(error),
    committed: nestedCommitted(error),
    ...(nestedCommittedPath(error) ? { committedPath: nestedCommittedPath(error) } : {}),
    recoveryPaths: recoveryPaths.length > 0 ? recoveryPaths : [pathName],
  };
}

function recoveryPathsForResiduals(residuals: PromotionResidual[]) {
  return uniqueRecoveryPaths(residuals.flatMap((residual) => (
    residual.recoveryPaths && residual.recoveryPaths.length > 0
      ? residual.recoveryPaths
      : [residual.path]
  )));
}

async function cleanupCommittedReceipt(
  repoRoot: string,
  receipt: CleanupReceipt,
  runLock: DirectoryLockHandle,
  lockRuntime: LockRuntime,
  afterPhaseForTest?: PromoteLiveReleaseEvidenceOptions["afterPhaseForTest"],
  heldManifestLock: DirectoryLockHandle | null = null,
  syncDirectory: (directory: string) => Promise<void> = fsyncDirectory,
) {
  const residuals: PromotionResidual[] = [];
  const attempt = async (pathName: string, kind: string, action: () => Promise<unknown> | unknown) => {
    try {
      await action();
    } catch (error) {
      residuals.push(cleanupResidual(pathName, kind, error));
    }
  };
  receipt.cleanupGeneration = runLock.generation;
  receipt.state = "cleanup-required";
  await attempt(receipt.receiptFile, "cleanup-receipt", () => updateCleanupReceipt(
    repoRoot,
    receipt,
    syncDirectory,
    lockRuntime.readHooks,
  ));
  if (residuals.length === 0 && receipt.lockGeneration !== runLock.generation) {
    await attempt(receipt.runLock, "run-lock", () => afterPhaseForTest?.("after-committed-cleanup-takeover", {
      lockDirectory: runLock.directory,
      generation: runLock.generation,
      priorGeneration: receipt.lockGeneration,
    }));
  }

  let manifestLock = heldManifestLock;
  if (residuals.length === 0 && receipt.manifestLock && !manifestLock) {
    await attempt(receipt.manifestLock, "manifest-lock", async () => {
      manifestLock = await acquireDirectoryLock(
        path.resolve(repoRoot, receipt.manifestLock as string),
        randomUUID(),
        "manifest-lock",
        lockRuntime,
        afterPhaseForTest,
      );
    });
  }
  if (residuals.length === 0 && receipt.candidateFile && receipt.candidateToken && receipt.liveReleaseEvidenceFile) {
    await attempt(`${receipt.candidateFile}.owner.json`, "candidate-owner", async () => {
      await retryCleanupAction(async () => {
        await afterPhaseForTest?.("before-candidate-marker-cleanup", {
          candidateFile: path.resolve(repoRoot, receipt.candidateFile as string),
          markerPath: ownedFileMarkerPath(path.resolve(repoRoot, receipt.candidateFile as string)),
        });
        await releaseRenamedOwnedFileMarker(
          path.resolve(repoRoot, receipt.candidateFile as string),
          path.resolve(repoRoot, receipt.liveReleaseEvidenceFile as string),
          receipt.candidateToken as string,
          "candidate",
          syncDirectory,
          lockRuntime.readHooks,
        );
      });
    });
  }
  if (residuals.length === 0 && receipt.existingDraftOwned && receipt.draftPrEvidenceFile) {
    await attempt(`${receipt.draftPrEvidenceFile}.owner.json`, "draft-owner", () => releaseOwnedFileMarker(
      path.resolve(repoRoot, receipt.draftPrEvidenceFile as string),
      receipt.ownerToken,
      "draft",
      syncDirectory,
      lockRuntime.readHooks,
    ));
  }
  if (manifestLock) {
    const lockToRelease = manifestLock;
    await attempt(receipt.manifestLock || lockToRelease.directory, "manifest-lock", () => releaseDirectoryLock(lockToRelease));
  }
  receipt.state = residuals.length === 0 ? "committed-clean" : "cleanup-required";
  await attempt(receipt.receiptFile, "cleanup-receipt", () => updateCleanupReceipt(
    repoRoot,
    receipt,
    syncDirectory,
    lockRuntime.readHooks,
  ));
  return residuals;
}

function parseJson(raw: string, pathName: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new PromotionError(pathName, "must be valid JSON");
  }
}

function sanitizeRunId(value: string) {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || `run-${Date.now()}`;
}

function repoLocalJsonPath(root: string, value: string, pathName: string) {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  if (!normalized
    || path.isAbsolute(normalized)
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || !normalized.endsWith(".json")) {
    throw new PromotionError(pathName, "must be a repository-local JSON path");
  }
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PromotionError(pathName, "must stay inside the repository root");
  }
  return { relative: relative.replaceAll("\\", "/"), resolved };
}

async function repoLocalRegularFile(root: string, value: string, pathName: string) {
  const local = repoLocalJsonPath(root, value, pathName);
  try {
    const entry = await lstat(local.resolved);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new PromotionError(pathName, "must be a non-symlink regular file");
    }
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(local.resolved)]);
    const relative = path.relative(realRoot, realFile);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new PromotionError(pathName, "must not escape the repository through a symlink");
    }
  } catch (error) {
    if (error instanceof PromotionError) throw error;
    throw new PromotionError(pathName, "source file could not be read");
  }
  return local;
}

function artifactReference(value: unknown, pathName: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PromotionError(pathName, "must reference a source artifact");
  }
  const raw = value.trim();
  const hashIndex = raw.indexOf("#");
  const artifactPath = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : raw.slice(hashIndex + 1);
  if (!artifactPath || (hashIndex !== -1 && !fragment)) {
    throw new PromotionError(pathName, "must reference a source artifact and optional non-empty fragment");
  }
  return { artifactPath, fragment };
}

async function ordinaryFileInsideRunRoot(runRootReal: string, filePath: string, pathName: string) {
  const lexical = path.resolve(filePath);
  let realFile: string;
  try {
    const linkStat = await lstat(lexical);
    if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
      throw new PromotionError(pathName, "must be a non-symlink regular file");
    }
    realFile = await realpath(lexical);
    const fileStat = await stat(realFile);
    if (!fileStat.isFile()) {
      throw new PromotionError(pathName, "must be a regular file");
    }
  } catch (error) {
    if (error instanceof PromotionError) throw error;
    throw new PromotionError(pathName, "source file could not be read");
  }
  const relative = path.relative(runRootReal, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PromotionError(pathName, "must stay inside --run-root");
  }
  return { realFile, relative: relative.replaceAll("\\", "/") };
}

async function sourceFileFromReference(
  runRootReal: string,
  referenceValue: unknown,
  baseDir: string,
  pathName: string,
) {
  const ref = artifactReference(referenceValue, pathName);
  const sourcePath = path.isAbsolute(ref.artifactPath)
    ? ref.artifactPath
    : path.resolve(baseDir, ref.artifactPath);
  const source = await ordinaryFileInsideRunRoot(runRootReal, sourcePath, pathName);
  return { ...ref, ...source };
}

function matchingFragmentValue(value: unknown, fragment: string): unknown {
  if (!isRecord(value)) return null;
  const candidates = [
    value.event,
    value.type,
    value.kind,
    value.name,
    isRecord(value.event) ? value.event.type : null,
    isRecord(value.event) ? value.event.kind : null,
    isRecord(value.payload) ? value.payload.event : null,
    isRecord(value.payload) ? value.payload.type : null,
    isRecord(value.payload) ? value.payload.kind : null,
  ];
  return candidates.includes(fragment) ? value : null;
}

function parseJsonOrJsonlFragment(raw: string, fragment: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const direct = matchingFragmentValue(parsed, fragment);
    if (direct) return direct;
    if (Array.isArray(parsed)) return parsed.find((item) => matchingFragmentValue(item, fragment)) || null;
  } catch {
    // Fall through to JSONL.
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const matching = matchingFragmentValue(parsed, fragment);
      if (matching) return matching;
    } catch {
      // Ignore non-matching malformed lines.
    }
  }
  return null;
}

async function verifyArtifactBinding(
  file: string,
  fragment: string,
  bytesValue: unknown,
  shaValue: unknown,
  pathName: string,
) {
  const expectedBytes = Number(bytesValue);
  const expectedSha = typeof shaValue === "string" ? shaValue.trim() : "";
  if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
    throw new PromotionError(`${pathName}.bytes`, "must be a positive byte count");
  }
  if (!SHA256_PATTERN.test(expectedSha)) {
    throw new PromotionError(`${pathName}.sha256`, "must be a lowercase SHA-256 digest");
  }
  const raw = await readFile(file);
  let actualBytes = raw.byteLength;
  let actualSha = sha256(raw);
  if (fragment) {
    const fragmentValue = parseJsonOrJsonlFragment(raw.toString("utf8"), fragment);
    if (fragmentValue === null) {
      throw new PromotionError(`${pathName}.path`, "referenced artifact fragment does not exist");
    }
    actualBytes = stableJsonBytes(fragmentValue);
    actualSha = stableJsonSha256(fragmentValue);
  }
  if (actualBytes !== expectedBytes) {
    throw new PromotionError(`${pathName}.bytes`, "does not match source artifact content");
  }
  if (actualSha !== expectedSha) {
    throw new PromotionError(`${pathName}.sha256`, "does not match source artifact content");
  }
}

async function assertDestinationParentSafe(root: string, runDirectory: string) {
  const parent = path.dirname(path.resolve(root, runDirectory));
  await mkdir(parent, { recursive: true });
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(parent)]);
  const relative = path.relative(realRoot, realParent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PromotionError("destination", "must stay inside the repository through realpath");
  }
  const existingParent = await lstat(parent);
  if (existingParent.isSymbolicLink() || !existingParent.isDirectory()) {
    throw new PromotionError("destination", "parent must be a non-symlink directory");
  }
  const relativeParts = path.relative(path.resolve(root), parent)
    .split(path.sep)
    .filter(Boolean);
  let cursor = path.resolve(root);
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    const entry = await lstat(cursor);
    if (entry.isSymbolicLink()) {
      throw new PromotionError("destination", "path components must not be symlinks");
    }
  }
}

async function copyBoundArtifact(
  root: string,
  runRootReal: string,
  sourceReference: unknown,
  bytesValue: unknown,
  shaValue: unknown,
  {
    sourceBaseDir,
    stagingRoot,
    runDirectory,
    pathName,
  }: {
    sourceBaseDir: string;
    stagingRoot: string;
    runDirectory: string;
    pathName: string;
  },
) {
  const source = await sourceFileFromReference(runRootReal, sourceReference, sourceBaseDir, `${pathName}.path`);
  await verifyArtifactBinding(source.realFile, source.fragment, bytesValue, shaValue, pathName);
  const destinationRelative = `${runDirectory}/artifacts/${source.relative}`;
  const destinationFile = path.resolve(root, stagingRoot, "artifacts", source.relative);
  await mkdir(path.dirname(destinationFile), { recursive: true });
  await copyFile(source.realFile, destinationFile);
  await verifyArtifactBinding(destinationFile, source.fragment, bytesValue, shaValue, pathName);
  return `${destinationRelative}${source.fragment ? `#${source.fragment}` : ""}`;
}

async function copyControlPlaneAuditArtifact(
  root: string,
  runRootReal: string,
  auditRef: LooseRecord,
  {
    sourceBaseDir,
    stagingRoot,
    runDirectory,
    pathName,
    sourceOutputPath,
    promotedOutputPath,
  }: {
    sourceBaseDir: string;
    stagingRoot: string;
    runDirectory: string;
    pathName: string;
    sourceOutputPath: string;
    promotedOutputPath: string;
  },
) {
  const source = await sourceFileFromReference(runRootReal, auditRef.path, sourceBaseDir, `${pathName}.path`);
  const rawSource = await sourceFileFromReference(runRootReal, auditRef.rawPath, sourceBaseDir, `${pathName}.rawPath`);
  if (source.fragment) {
    throw new PromotionError(`${pathName}.path`, "must reference a whole control-plane audit artifact");
  }
  if (rawSource.fragment) {
    throw new PromotionError(`${pathName}.rawPath`, "must reference a whole raw control-plane audit stream");
  }
  await verifyArtifactBinding(source.realFile, "", auditRef.bytes, auditRef.sha256, pathName);
  await verifyArtifactBinding(rawSource.realFile, "", auditRef.rawBytes, auditRef.rawSha256, `${pathName}.raw`);
  const destinationRelative = `${runDirectory}/artifacts/${source.relative}`;
  const rawDestinationRelative = `${runDirectory}/artifacts/${rawSource.relative}`;
  const destinationFile = path.resolve(root, stagingRoot, "artifacts", source.relative);
  const rawDestinationFile = path.resolve(root, stagingRoot, "artifacts", rawSource.relative);
  await mkdir(path.dirname(destinationFile), { recursive: true });
  await mkdir(path.dirname(rawDestinationFile), { recursive: true });
  await copyFile(rawSource.realFile, rawDestinationFile);
  await verifyArtifactBinding(rawDestinationFile, "", auditRef.rawBytes, auditRef.rawSha256, `${pathName}.raw`);
  const artifact = parseJson(await readFile(source.realFile, "utf8"), `${pathName}.path`);
  if (!isRecord(artifact) || !isRecord(artifact.jobIdentity) || !isRecord(artifact.rawStream)) {
    throw new PromotionError(`${pathName}.path`, "must contain a structured control-plane audit artifact");
  }
  if (artifact.jobIdentity.outputPathSha256 !== sha256(sourceOutputPath)) {
    throw new PromotionError(`${pathName}.path`, "output path binding does not match the source phase artifact");
  }
  artifact.jobIdentity.outputPathSha256 = sha256(promotedOutputPath);
  artifact.rawStream.path = path.basename(rawDestinationRelative);
  artifact.rawStream.bytes = auditRef.rawBytes;
  artifact.rawStream.sha256 = auditRef.rawSha256;
  await writeJson(destinationFile, artifact);
  const destinationRaw = await readFile(destinationFile);
  const summarySha256 = String(artifact.summarySha256 || "");
  if (!SHA256_PATTERN.test(summarySha256) || summarySha256 !== auditRef.summarySha256) {
    throw new PromotionError(`${pathName}.summarySha256`, "does not match the rewritten audit artifact");
  }
  return {
    path: destinationRelative,
    bytes: destinationRaw.byteLength,
    sha256: sha256(destinationRaw),
    rawPath: rawDestinationRelative,
    rawBytes: Number(auditRef.rawBytes),
    rawSha256: String(auditRef.rawSha256),
    summarySha256,
  };
}

async function rewriteProviderPreflightAuditRefs({
  preflight,
  root,
  runRootReal,
  providerReportDir,
  stagingRoot,
  runDirectory,
  pathName,
}: {
  preflight: unknown;
  root: string;
  runRootReal: string;
  providerReportDir: string;
  stagingRoot: string;
  runDirectory: string;
  pathName: string;
}) {
  const preflightRecord = recordValue(preflight);
  const phases = Array.isArray(preflightRecord.phases) ? preflightRecord.phases : [];
  for (const [phaseIndex, phaseValue] of phases.entries()) {
    if (!isRecord(phaseValue)) continue;
    const handshake = isRecord(phaseValue.handshake) ? phaseValue.handshake : null;
    const audit = isRecord(handshake?.controlPlaneAudit) ? handshake.controlPlaneAudit : null;
    if (!audit) throw new PromotionError(`${pathName}.phases[${phaseIndex}].handshake.controlPlaneAudit`, "must reference a source audit artifact");
    if (typeof audit.path === "string"
      && audit.path.startsWith(`${runDirectory}/artifacts/`)
      && typeof phaseValue.outputPath === "string"
      && phaseValue.outputPath.startsWith(`${runDirectory}/artifacts/`)) {
      continue;
    }
    if (!handshake) {
      throw new PromotionError(`${pathName}.phases[${phaseIndex}].handshake`, "must retain the live phase handshake");
    }
    const outputSource = await sourceFileFromReference(
      runRootReal,
      phaseValue.outputPath,
      providerReportDir,
      `${pathName}.phases[${phaseIndex}].outputPath`,
    );
    if (outputSource.fragment) {
      throw new PromotionError(`${pathName}.phases[${phaseIndex}].outputPath`, "must reference a whole phase output artifact");
    }
    await verifyArtifactBinding(
      outputSource.realFile,
      "",
      phaseValue.outputBytes,
      phaseValue.outputSha256,
      `${pathName}.phases[${phaseIndex}].output`,
    );
    const sourceOutput = parseJson(
      await readFile(outputSource.realFile, "utf8"),
      `${pathName}.phases[${phaseIndex}].outputPath`,
    );
    if (stableJson(sourceOutput) !== stableJson(handshake)) {
      throw new PromotionError(`${pathName}.phases[${phaseIndex}].outputPath`, "content must match the retained handshake");
    }
    const promotedOutputPath = `${runDirectory}/artifacts/${outputSource.relative}`;
    const copied = await copyControlPlaneAuditArtifact(root, runRootReal, audit, {
      sourceBaseDir: providerReportDir,
      stagingRoot,
      runDirectory,
      pathName: `${pathName}.phases[${phaseIndex}].handshake.controlPlaneAudit`,
      sourceOutputPath: String(phaseValue.outputPath),
      promotedOutputPath,
    });
    Object.assign(audit, copied);
    phaseValue.outputPath = promotedOutputPath;
    const outputDestinationFile = path.resolve(root, stagingRoot, "artifacts", outputSource.relative);
    await mkdir(path.dirname(outputDestinationFile), { recursive: true });
    await writeJson(outputDestinationFile, handshake);
    const outputDestinationRaw = await readFile(outputDestinationFile);
    phaseValue.outputBytes = outputDestinationRaw.byteLength;
    phaseValue.outputSha256 = sha256(outputDestinationRaw);
    await verifyArtifactBinding(
      outputDestinationFile,
      "",
      phaseValue.outputBytes,
      phaseValue.outputSha256,
      `${pathName}.phases[${phaseIndex}].output`,
    );
    const rewrittenOutput = parseJson(
      outputDestinationRaw.toString("utf8"),
      `${pathName}.phases[${phaseIndex}].outputPath`,
    );
    if (stableJson(rewrittenOutput) !== stableJson(handshake)) {
      throw new PromotionError(`${pathName}.phases[${phaseIndex}].outputPath`, "rewritten content must match the retained handshake");
    }
  }
}

async function rewriteProviderArtifacts({
  provider,
  root,
  runRootReal,
  providerReportDir,
  stagingRoot,
  runDirectory,
}: {
  provider: LooseRecord;
  root: string;
  runRootReal: string;
  providerReportDir: string;
  stagingRoot: string;
  runDirectory: string;
}) {
  const jobs = Array.isArray(provider.jobs) ? provider.jobs : [];
  await rewriteProviderPreflightAuditRefs({
    preflight: recordValue(provider.sourceManifest).providerPreflight,
    root,
    runRootReal,
    providerReportDir,
    stagingRoot,
    runDirectory,
    pathName: "sourceManifest.providerPreflight",
  });
  await rewriteProviderPreflightAuditRefs({
    preflight: recordValue(provider.manifest).providerPreflight,
    root,
    runRootReal,
    providerReportDir,
    stagingRoot,
    runDirectory,
    pathName: "manifest.providerPreflight",
  });
  for (const [jobIndex, jobValue] of jobs.entries()) {
    if (!isRecord(jobValue)) continue;
    const patch = isRecord(jobValue.patch) ? jobValue.patch : null;
    if (patch) {
      patch.path = await copyBoundArtifact(root, runRootReal, patch.path, patch.bytes, patch.sha256, {
        sourceBaseDir: providerReportDir,
        stagingRoot,
        runDirectory,
        pathName: `jobs[${jobIndex}].patch`,
      });
    }
    const phaseEvidence = isRecord(jobValue.phaseEvidence) ? jobValue.phaseEvidence : {};
    for (const [phase, phaseValue] of Object.entries(phaseEvidence)) {
      if (!isRecord(phaseValue)) continue;
      phaseValue.structuredOutputPath = await copyBoundArtifact(
        root,
        runRootReal,
        phaseValue.structuredOutputPath,
        phaseValue.structuredOutputBytes,
        phaseValue.artifactSha256,
        {
          sourceBaseDir: providerReportDir,
          stagingRoot,
          runDirectory,
          pathName: `jobs[${jobIndex}].phaseEvidence.${phase}.structuredOutput`,
        },
      );
    }
    const providerRoute = recordValue(jobValue.providerRoute);
    const actualRoute = recordValue(providerRoute.actual);
    await rewriteProviderPreflightAuditRefs({
      preflight: { phases: actualRoute.preflight },
      root,
      runRootReal,
      providerReportDir,
      stagingRoot,
      runDirectory,
      pathName: `jobs[${jobIndex}].providerRoute.actual.preflight`,
    });
  }
  const sourceManifest = recordValue(provider.sourceManifest);
  const manifest = recordValue(provider.manifest);
  manifest.hash = stableJsonSha256(sourceManifest);
}

async function readBoundJson(runRootReal: string, filePath: string, pathName: string) {
  const source = await ordinaryFileInsideRunRoot(runRootReal, path.resolve(filePath), pathName);
  const raw = await readFile(source.realFile, "utf8");
  return {
    value: parseJson(raw, pathName),
    realFile: source.realFile,
    sha256: sha256(raw),
  };
}

function providerSourceManifest(provider: LooseRecord) {
  const sourceManifest = isRecord(provider.sourceManifest) ? provider.sourceManifest : null;
  if (!sourceManifest) throw new PromotionError("providerReport.sourceManifest", "must be present");
  return sourceManifest;
}

async function promoteProviderBundle({
  root,
  runRootReal,
  providerReport,
  stagingRoot,
  runDirectory,
}: {
  root: string;
  runRootReal: string;
  providerReport: string;
  stagingRoot: string;
  runDirectory: string;
}) {
  const providerSource = await ordinaryFileInsideRunRoot(runRootReal, path.resolve(providerReport), "providerReport");
  const provider = parseJson(await readFile(providerSource.realFile, "utf8"), "providerReport");
  if (!isRecord(provider)) throw new PromotionError("providerReport", "must be a JSON object");
  const originalSourceManifest = providerSourceManifest(provider);
  const originalValidation = validateSweBenchBatchReport({
    manifest: originalSourceManifest,
    report: provider,
    artifactBaseDir: path.dirname(providerSource.realFile),
  });
  if (!originalValidation.valid) {
    throw new PromotionError("providerReport.validation", `must pass before promotion: ${JSON.stringify(originalValidation.violations || [])}`);
  }
  await rewriteProviderArtifacts({
    provider,
    root,
    runRootReal,
    providerReportDir: path.dirname(providerSource.realFile),
    stagingRoot,
    runDirectory,
  });
  const sourceManifest = providerSourceManifest(provider);
  recordValue(provider.manifest).hash = stableJsonSha256(sourceManifest);
  provider.validation = validateSweBenchBatchReport({
    manifest: sourceManifest,
    report: provider,
    artifactBaseDir: root,
    artifactPathRewrite: { from: runDirectory, to: stagingRoot },
  });
  const validation = isRecord(provider.validation) ? provider.validation : {};
  if (validation.valid !== true) {
    throw new PromotionError("providerReport.validation", `must pass after promotion rewrite: ${JSON.stringify(validation.violations || [])}`);
  }
  const providerRelative = `${runDirectory}/provider-connectivity.json`;
  const providerStagingAbs = path.resolve(root, stagingRoot, "provider-connectivity.json");
  await writeJson(providerStagingAbs, provider);
  const providerConnectivity = await verifyProviderConnectivityEvidence(provider, {
    root,
    artifactPathRewrite: { from: runDirectory, to: stagingRoot },
  });
  if (!providerConnectivity.ok) {
    throw new PromotionError("providerConnectivity", `must pass before promotion publish: ${JSON.stringify(providerConnectivity.violations)}`);
  }
  return {
    providerRelative,
    providerSha: sha256(await readFile(providerStagingAbs, "utf8")),
  };
}

async function promoteDraftBundle({
  root,
  runRootReal,
  draftRehearsal,
  stagingRoot,
  runDirectory,
}: {
  root: string;
  runRootReal: string;
  draftRehearsal: string;
  stagingRoot: string;
  runDirectory: string;
}) {
  const draft = await readBoundJson(runRootReal, draftRehearsal, "draftRehearsal");
  const draftRelative = `${runDirectory}/draft-pr-rehearsal.json`;
  const draftDestination = path.resolve(root, stagingRoot, "draft-pr-rehearsal.json");
  await writeJson(draftDestination, draft.value);
  return { draftRelative, draftSha: await sha256File(draftDestination) };
}

async function sha256File(filePath: string) {
  return sha256(await readFile(filePath, "utf8"));
}

async function regularFileHashes(rootDirectory: string, pathName: string) {
  const files = new Map<string, string>();
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relative = path.relative(rootDirectory, entryPath).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) {
        throw new PromotionError(pathName, "must not contain symlinks");
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (relative === OWNER_MARKER || relative === "draft-pr-rehearsal.json") continue;
      if (!entry.isFile()) {
        throw new PromotionError(pathName, "must contain only regular files");
      }
      files.set(relative, await sha256File(entryPath));
    }
  }
  await visit(rootDirectory);
  return files;
}

async function assertReusableProviderBundle({
  existingRunAbs,
  stagedProviderAbs,
}: {
  existingRunAbs: string;
  stagedProviderAbs: string;
}) {
  const existing = await regularFileHashes(existingRunAbs, "destination");
  const staged = await regularFileHashes(stagedProviderAbs, "destination");
  if (!existing.has("provider-connectivity.json")) {
    throw new PromotionError("destination", "existing run directory is not a provider-only promotion bundle");
  }
  if (existing.size !== staged.size) {
    throw new PromotionError("destination", "existing provider bundle content does not match the source report");
  }
  for (const [relative, digest] of staged.entries()) {
    if (existing.get(relative) !== digest) {
      throw new PromotionError("destination", "existing provider bundle content does not match the source report");
    }
  }
}

export async function promoteLiveReleaseEvidence(
  options: PromoteLiveReleaseEvidenceOptions,
): Promise<PromoteLiveReleaseEvidenceResult> {
  return await cleanupRemovalHookScope.run(
    options.beforeCleanupRemovalForTest,
    () => promoteLiveReleaseEvidenceInternal(options),
  );
}

async function promoteLiveReleaseEvidenceInternal({
  root = process.cwd(),
  runRoot,
  providerReport,
  draftRehearsal,
  providerOnly = false,
  runId,
  evidenceFile = DEFAULT_LIVE_RELEASE_EVIDENCE_FILE,
  productEvidenceFile = DEFAULT_PRODUCT_EVIDENCE_FILE,
  lockIdentityForTest,
  captureLockIdentityForTest,
  lockTimeoutMsForTest,
  syncDirectoryForTest,
  boundedReadHooksForTest,
  afterPhaseForTest,
}: PromoteLiveReleaseEvidenceOptions): Promise<PromoteLiveReleaseEvidenceResult> {
  const repoRoot = path.resolve(root);
  let receiptFileForFailure: string | null = null;
  let runLockWasAcquired = false;
  const resultBase: PromoteLiveReleaseEvidenceResult = {
    ok: false,
    committed: false,
    outcome: "not_committed",
    providerOnly,
    runRoot,
    runId: "",
    runDirectory: "",
    providerEvidenceFile: null,
    draftPrEvidenceFile: null,
    liveReleaseEvidenceFile: null,
    recoveredCleanup: false,
    receipt: null,
    residuals: [],
    recoveryPaths: [],
    violations: [] as Array<{ path: string; reason: string }>,
  };
  try {
    let capturedLockIdentity: ProcessIdentity | null = null;
    try {
      capturedLockIdentity = lockIdentityForTest || captureProcessIdentity(process.pid, { strict: true });
    } catch (error) {
      throw new PromotionError(
        "lock",
        `could not capture an exact current process identity: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!capturedLockIdentity) {
      throw new PromotionError("lock", "could not capture an exact current process identity");
    }
    const currentLockIdentity = capturedExactProcessIdentity(capturedLockIdentity, "lock.identity");
    const rawSyncDirectory = syncDirectoryForTest || fsyncDirectory;
    const syncDirectory = (directory: string) => (
      syncDirectoryStableIncarnation(directory, rawSyncDirectory)
    );
    const lockRuntime: LockRuntime = {
      currentIdentity: currentLockIdentity,
      captureIdentity: captureLockIdentityForTest
        ? (pid) => {
          const captured = captureLockIdentityForTest(pid);
          return captured ? capturedExactProcessIdentity(captured, "lock.identity") : null;
        }
        : captureLiveProcessIdentity,
      timeoutMs: lockTimeoutMsForTest ?? 30_000,
      syncDirectory,
      readHooks: boundedReadHooksForTest,
    };
    if (!runRoot) throw new PromotionError("runRoot", "--run-root is required");
    const runRootReal = await realpath(path.resolve(runRoot));
    if (!(await stat(runRootReal)).isDirectory()) {
      throw new PromotionError("runRoot", "must be a directory");
    }
    const sourceReport = providerReport ? path.resolve(providerReport) : path.join(runRootReal, "report.json");
    const selectedRunId = sanitizeRunId(runId || path.basename(runRootReal));
    const runDirectory = `${RUNS_ROOT}/${selectedRunId}`;
    resultBase.runId = selectedRunId;
    resultBase.runDirectory = runDirectory;
    await assertDestinationParentSafe(repoRoot, runDirectory);
    const ownerToken = randomUUID();
    const stagingRoot = `${path.dirname(runDirectory)}/${uniqueHiddenName(`${selectedRunId}.staging`)}`;
    const stagingAbs = path.resolve(repoRoot, stagingRoot);
    const publishedRunAbs = path.resolve(repoRoot, runDirectory);
    const runLockAbs = path.resolve(repoRoot, path.dirname(runDirectory), `.${selectedRunId}.publish.lock`);
    const receiptRel = `${path.dirname(runDirectory)}/.${selectedRunId}.promotion-receipt.json`;
    receiptFileForFailure = receiptRel;
    const manifestLockToken = randomUUID();
    const transactionId = randomUUID();
    let draftPublishedAbs: string | null = null;
    let existingRunDirectory = false;
    let runPublished = false;
    let stagingActive = false;
    let draftPublished = false;
    let runLockHandle: DirectoryLockHandle | null = null;
    let manifestLockHandle: DirectoryLockHandle | null = null;
    let committed = false;
    let receipt: CleanupReceipt | null = null;
    let receiptWritten = false;
    let candidateAbs: string | null = null;
    let candidateToken: string | null = null;
    const releaseRunLock = async () => {
      const handle = runLockHandle;
      if (!handle) return;
      runLockHandle = null;
      await releaseDirectoryLock(handle, () => afterPhaseForTest?.("before-run-lock-cleanup", {
        lockDirectory: handle.directory,
        markerPath: path.join(handle.directory, OWNER_MARKER),
        generation: handle.generation,
      }));
    };
    const releaseManifestLock = async () => {
      const handle = manifestLockHandle;
      if (!handle) return;
      manifestLockHandle = null;
      await releaseDirectoryLock(handle);
    };
    try {
      await mkdir(stagingAbs, { recursive: true });
      await writeOwnerMarker(stagingAbs, ownerToken, "staging", {}, syncDirectory);
      stagingActive = true;
      const provider = await promoteProviderBundle({
        root: repoRoot,
        runRootReal,
        providerReport: sourceReport,
        stagingRoot,
        runDirectory,
      });
      let draft: { draftRelative: string; draftSha: string } | null = null;
      if (draftRehearsal) {
        draft = await promoteDraftBundle({
          root: repoRoot,
          runRootReal,
          draftRehearsal: path.resolve(draftRehearsal),
          stagingRoot,
          runDirectory,
        });
      }
      resultBase.providerEvidenceFile = provider.providerRelative;
      if (draft) resultBase.draftPrEvidenceFile = draft.draftRelative;
      if (!providerOnly && !draft) {
        throw new PromotionError("draftRehearsal", "is required unless --provider-only is set");
      }

      const productSource = providerOnly
        ? null
        : await repoLocalRegularFile(repoRoot, productEvidenceFile, "productEvidenceFile");
      const evidenceTarget = providerOnly
        ? null
        : repoLocalJsonPath(repoRoot, evidenceFile, "evidenceFile");
      if (evidenceTarget) {
        await assertDestinationParentSafe(repoRoot, evidenceTarget.relative);
        const existingEvidence = await lstatIfPresent(evidenceTarget.resolved);
        if (existingEvidence && (existingEvidence.isSymbolicLink() || !existingEvidence.isFile())) {
          throw new PromotionError("evidenceFile", "destination must be a non-symlink regular file");
        }
      }
      const productSha = productSource ? await sha256File(productSource.resolved) : null;
      const manifest = draft && productSource ? {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        providerConnectivity: {
          evidenceBundleRef: provider.providerRelative,
          sha256: provider.providerSha,
        },
        draftPrRehearsal: {
          evidenceBundleRef: draft.draftRelative,
          sha256: draft.draftSha,
        },
        productEvidence: {
          evidenceBundleRef: productSource.relative,
          sha256: productSha,
        },
      } : null;
      const candidateRel = evidenceTarget
        ? `${path.dirname(evidenceTarget.relative)}/${uniqueHiddenName(`${path.basename(evidenceTarget.relative)}.candidate`)}.json`
        : null;
      candidateAbs = candidateRel ? path.resolve(repoRoot, candidateRel) : null;
      candidateToken = candidateRel ? randomUUID() : null;
      const manifestLockAbs = evidenceTarget
        ? path.resolve(repoRoot, path.dirname(evidenceTarget.relative), `.${path.basename(evidenceTarget.relative)}.publish.lock`)
        : null;

      const expectedReceipt = {
        providerOnly,
        runId: selectedRunId,
        runDirectory,
        providerEvidenceFile: provider.providerRelative,
        providerSha: provider.providerSha,
        draftPrEvidenceFile: draft?.draftRelative || null,
        draftSha: draft?.draftSha || null,
        liveReleaseEvidenceFile: evidenceTarget?.relative || null,
        productEvidenceFile: productSource?.relative || null,
        productSha,
      };
      const expectedFingerprint = receiptFingerprint(expectedReceipt);
      runLockHandle = await acquireDirectoryLock(
        runLockAbs,
        ownerToken,
        "run-lock",
        lockRuntime,
        afterPhaseForTest,
      );
      runLockWasAcquired = true;
      const receiptAfterLock = await readCleanupReceipt(repoRoot, receiptRel, boundedReadHooksForTest);
      if (receiptAfterLock) {
        if (await receiptCommitIsPresent(repoRoot, receiptAfterLock, boundedReadHooksForTest)) {
          const recoveryNeeded = receiptAfterLock.state !== "committed-clean" || runLockHandle.recoveredStale;
          const recoveryResiduals = recoveryNeeded
            ? await cleanupCommittedReceipt(
              repoRoot,
              receiptAfterLock,
              runLockHandle,
              lockRuntime,
              afterPhaseForTest,
              null,
              syncDirectory,
            )
            : [];
          if (recoveryResiduals.length > 0) {
            try {
              await removeOwnedDirectory(
                stagingAbs,
                ownerToken,
                "staging",
                undefined,
                syncDirectory,
                { readHooks: boundedReadHooksForTest },
              );
              stagingActive = false;
            } catch (error) {
              recoveryResiduals.push(cleanupResidual(stagingRoot, "staging", error));
            }
            try {
              await releaseRunLock();
            } catch (error) {
              recoveryResiduals.push(cleanupResidual(receiptAfterLock.runLock, "run-lock", error));
            }
            return {
              ...resultBase,
              committed: true,
              outcome: "committed_cleanup_required",
              receipt: publicReceipt(receiptAfterLock),
              residuals: recoveryResiduals,
              recoveryPaths: recoveryPathsForResiduals(recoveryResiduals),
              violations: recoveryResiduals.map((residual) => ({ path: "cleanup", reason: residual.reason })),
            };
          }
          if (receiptAfterLock.fingerprint === expectedFingerprint && recoveryNeeded) {
            await removeOwnedDirectory(
              stagingAbs,
              ownerToken,
              "staging",
              undefined,
              syncDirectory,
              { readHooks: boundedReadHooksForTest },
            );
            stagingActive = false;
            try {
              await releaseRunLock();
            } catch (error) {
              const residual = cleanupResidual(receiptAfterLock.runLock, "run-lock", error);
              return {
                ...resultBase,
                committed: true,
                outcome: "committed_cleanup_required",
                providerOnly: receiptAfterLock.providerOnly,
                runId: receiptAfterLock.runId,
                runDirectory: receiptAfterLock.runDirectory,
                providerEvidenceFile: receiptAfterLock.providerEvidenceFile,
                draftPrEvidenceFile: receiptAfterLock.draftPrEvidenceFile,
                liveReleaseEvidenceFile: receiptAfterLock.liveReleaseEvidenceFile,
                receipt: publicReceipt(receiptAfterLock),
                residuals: [residual],
                recoveryPaths: recoveryPathsForResiduals([residual]),
                violations: [{ path: "cleanup", reason: residual.reason }],
              };
            }
            return {
              ...resultBase,
              ok: true,
              committed: true,
              outcome: "committed",
              providerOnly: receiptAfterLock.providerOnly,
              runId: receiptAfterLock.runId,
              runDirectory: receiptAfterLock.runDirectory,
              providerEvidenceFile: receiptAfterLock.providerEvidenceFile,
              draftPrEvidenceFile: receiptAfterLock.draftPrEvidenceFile,
              liveReleaseEvidenceFile: receiptAfterLock.liveReleaseEvidenceFile,
              recoveredCleanup: recoveryNeeded,
              receipt: publicReceipt(receiptAfterLock),
            };
          }
          if (receiptAfterLock.fingerprint !== expectedFingerprint
            && receiptAfterLock.providerOnly
            && !providerOnly) {
            await retryOwnedFileCleanup(
              path.resolve(repoRoot, receiptAfterLock.receiptFile),
              receiptAfterLock.ownerToken,
              "cleanup-receipt",
              syncDirectory,
              boundedReadHooksForTest,
            );
          }
        } else {
          throw new PromotionError("cleanup-receipt", "an uncommitted promotion cleanup receipt still owns this run id");
        }
      }

      const existingRun = await lstatIfPresent(publishedRunAbs);
      if (existingRun) {
        if (existingRun.isSymbolicLink() || !existingRun.isDirectory()) {
          throw new PromotionError("destination", "existing run path must be a non-symlink directory");
        }
        if (providerOnly) {
          throw new PromotionError("destination", "run directory already exists");
        }
        existingRunDirectory = true;
        await assertReusableProviderBundle({
          existingRunAbs: publishedRunAbs,
          stagedProviderAbs: stagingAbs,
        });
      }

      draftPublishedAbs = draft ? path.resolve(repoRoot, draft.draftRelative) : null;
      if (existingRunDirectory && draftPublishedAbs && await lstatIfPresent(draftPublishedAbs)) {
        throw new PromotionError("destination", "existing run directory already contains draft evidence");
      }

      receipt = {
        schemaVersion: 1,
        generator: "scripts/promote-live-release-evidence.ts#cleanupReceipt",
        transactionId,
        state: providerOnly ? "commit-intent" : "prepared",
        ...expectedReceipt,
        fingerprint: expectedFingerprint,
        ownerToken,
        receiptFile: receiptRel,
        runLock: path.relative(repoRoot, runLockAbs).replaceAll("\\", "/"),
        lockGeneration: runLockHandle.generation,
        cleanupGeneration: null,
        manifestLock: manifestLockAbs ? path.relative(repoRoot, manifestLockAbs).replaceAll("\\", "/") : null,
        manifestLockToken: manifestLockAbs ? manifestLockToken : null,
        candidateFile: candidateRel,
        candidateToken,
        existingDraftOwned: existingRunDirectory,
      };
      await writeCleanupReceipt(repoRoot, receipt, syncDirectory);
      receiptWritten = true;

      if (providerOnly) {
        await verifyOwnerMarker(stagingAbs, ownerToken, "staging");
        await rename(stagingAbs, publishedRunAbs);
        stagingActive = false;
        runPublished = true;
        committed = true;
        try {
          await syncDirectory(path.dirname(publishedRunAbs));
        } catch (error) {
          throw new PromotionCommittedDurabilityError(publishedRunAbs, error);
        }
      } else if (existingRunDirectory && draft && draftPublishedAbs) {
        await copyOwnedFileExclusive(
          path.resolve(repoRoot, stagingRoot, "draft-pr-rehearsal.json"),
          draftPublishedAbs,
          ownerToken,
          "draft",
          { transactionId },
          syncDirectory,
        );
        draftPublished = true;
        await removeOwnedDirectory(
          stagingAbs,
          ownerToken,
          "staging",
          undefined,
          syncDirectory,
          { readHooks: boundedReadHooksForTest },
        );
        stagingActive = false;
      } else {
        await verifyOwnerMarker(stagingAbs, ownerToken, "staging");
        await rename(stagingAbs, publishedRunAbs);
        stagingActive = false;
        runPublished = true;
        await syncDirectory(path.dirname(publishedRunAbs));
      }

      if (!providerOnly) {
        if (!manifest || !candidateAbs || !candidateToken || !candidateRel || !evidenceTarget || !productSource || !manifestLockAbs) {
          throw new PromotionError("manifest", "full promotion transaction was not initialized");
        }
        await writeOwnedJsonExclusive(
          candidateAbs,
          manifest,
          candidateToken,
          "candidate",
          { transactionId },
          () => afterPhaseForTest?.("candidate-owner-marker-initialized", {
            candidateFile: candidateAbs as string,
            candidateMarker: ownedFileMarkerPath(candidateAbs as string),
          }),
          syncDirectory,
        );
        const verification = await verifyLiveReleaseEvidenceFile({
          root: repoRoot,
          evidenceFile: candidateRel,
          productEvidenceFile: productSource.relative,
        });
        if (!verification.ok) throw new PromotionValidationError(verification.violations);
        receipt.state = "commit-intent";
        await updateCleanupReceipt(repoRoot, receipt, syncDirectory, boundedReadHooksForTest);
        manifestLockHandle = await acquireDirectoryLock(
          manifestLockAbs,
          manifestLockToken,
          "manifest-lock",
          lockRuntime,
          afterPhaseForTest,
        );
        await afterPhaseForTest?.("before-manifest-commit", {
          candidateFile: candidateAbs,
          candidateMarker: ownedFileMarkerPath(candidateAbs),
          manifestFile: evidenceTarget.resolved,
        });
        await rename(candidateAbs, evidenceTarget.resolved);
        committed = true;
        try {
          await syncDirectory(path.dirname(evidenceTarget.resolved));
        } catch (error) {
          throw new PromotionCommittedDurabilityError(evidenceTarget.resolved, error);
        }
        await afterPhaseForTest?.("after-manifest-commit", {
          candidateFile: candidateAbs,
          candidateMarker: ownedFileMarkerPath(candidateAbs),
          manifestFile: evidenceTarget.resolved,
        });
      }

      if (!receipt || !committed) {
        throw new PromotionError("transaction", "publication did not reach its commit point");
      }
      if (!runLockHandle) throw new PromotionError("run-lock", "publication lock handle missing before committed cleanup");
      const heldManifestLock = manifestLockHandle;
      manifestLockHandle = null;
      const committedResiduals = await cleanupCommittedReceipt(
        repoRoot,
        receipt,
        runLockHandle,
        lockRuntime,
        afterPhaseForTest,
        heldManifestLock,
        syncDirectory,
      );
      try {
        await releaseRunLock();
      } catch (error) {
        committedResiduals.push(cleanupResidual(receipt.runLock, "run-lock", error));
      }
      if (committedResiduals.length > 0) {
        return {
          ...resultBase,
          committed: true,
          outcome: "committed_cleanup_required",
          providerEvidenceFile: provider.providerRelative,
          draftPrEvidenceFile: draft?.draftRelative || null,
          liveReleaseEvidenceFile: evidenceTarget?.relative || null,
          receipt: publicReceipt(receipt),
          residuals: committedResiduals,
          recoveryPaths: recoveryPathsForResiduals(committedResiduals),
          violations: committedResiduals.map((residual) => ({
            path: "cleanup",
            reason: `committed publication cleanup failed for ${residual.path}: ${residual.reason}`,
          })),
        };
      }
      return {
        ...resultBase,
        ok: true,
        committed: true,
        outcome: "committed",
        providerEvidenceFile: provider.providerRelative,
        draftPrEvidenceFile: draft?.draftRelative || null,
        liveReleaseEvidenceFile: evidenceTarget?.relative || null,
        receipt: publicReceipt(receipt),
      };
    } catch (error) {
      if (committed && receipt) {
        const residuals = [cleanupResidual("$", "post-commit", error)];
        if (runLockHandle) {
          const heldManifestLock = manifestLockHandle;
          manifestLockHandle = null;
          residuals.push(...await cleanupCommittedReceipt(
            repoRoot,
            receipt,
            runLockHandle,
            lockRuntime,
            afterPhaseForTest,
            heldManifestLock,
            syncDirectory,
          ));
          if (residuals.length > 0) {
            receipt.state = "cleanup-required";
            await updateCleanupReceipt(repoRoot, receipt, syncDirectory, boundedReadHooksForTest).catch((cleanupError) => {
              residuals.push(cleanupResidual(receipt!.receiptFile, "cleanup-receipt", cleanupError));
            });
          }
          try {
            await releaseRunLock();
          } catch (cleanupError) {
            residuals.push(cleanupResidual(receipt.runLock, "run-lock", cleanupError));
          }
        } else {
          residuals.push(cleanupResidual(receipt.runLock, "run-lock", "run lock was not retained for committed cleanup"));
        }
        return {
          ...resultBase,
          committed: true,
          outcome: "committed_cleanup_required",
          providerEvidenceFile: receipt.providerEvidenceFile,
          draftPrEvidenceFile: receipt.draftPrEvidenceFile,
          liveReleaseEvidenceFile: receipt.liveReleaseEvidenceFile,
          receipt: publicReceipt(receipt),
          residuals,
          recoveryPaths: recoveryPathsForResiduals(residuals),
          violations: residuals.map((residual) => ({
            path: "cleanup",
            reason: `committed publication cleanup failed for ${residual.path}: ${residual.reason}`,
          })),
        };
      }

      const cleanupFailures: unknown[] = [];
      const cleanup = async (action: () => Promise<void>) => {
        try {
          await action();
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
      };
      if (candidateAbs && candidateToken) {
        await cleanup(() => retryOwnedFileCleanup(
          candidateAbs as string,
          candidateToken as string,
          "candidate",
          syncDirectory,
          boundedReadHooksForTest,
        ));
      }
      await cleanup(releaseManifestLock);
      if (draftPublished && draftPublishedAbs) {
        await cleanup(() => retryOwnedFileCleanup(
          draftPublishedAbs as string,
          ownerToken,
          "draft",
          syncDirectory,
          boundedReadHooksForTest,
        ));
        draftPublished = false;
      }
      if (runPublished && !providerOnly) {
        await cleanup(() => removeOwnedDirectory(
          publishedRunAbs,
          ownerToken,
          "staging",
          undefined,
          syncDirectory,
          { readHooks: boundedReadHooksForTest },
        ));
        runPublished = false;
      }
      if (stagingActive) {
        await cleanup(() => removeOwnedDirectory(
          stagingAbs,
          ownerToken,
          "staging",
          undefined,
          syncDirectory,
          { readHooks: boundedReadHooksForTest },
        ));
        stagingActive = false;
      }
      if (receiptWritten && receipt && cleanupFailures.length === 0) {
        await cleanup(() => retryOwnedFileCleanup(
          path.resolve(repoRoot, receipt?.receiptFile as string),
          ownerToken,
          "cleanup-receipt",
          syncDirectory,
          boundedReadHooksForTest,
        ));
        receiptWritten = false;
      }
      await cleanup(releaseRunLock);
      if (cleanupFailures.length > 0) throw new PromotionAggregateError(error, cleanupFailures);
      throw error;
    }
  } catch (error) {
    if (receiptFileForFailure && !runLockWasAcquired) {
      try {
        const committedReceipt = await readCleanupReceipt(repoRoot, receiptFileForFailure, boundedReadHooksForTest);
        if (committedReceipt && await receiptCommitIsPresent(repoRoot, committedReceipt, boundedReadHooksForTest)) {
          const residual = cleanupResidual(committedReceipt.runLock, "run-lock", error);
          return {
            ...resultBase,
            committed: true,
            outcome: "committed_cleanup_required",
            providerOnly: committedReceipt.providerOnly,
            runId: committedReceipt.runId,
            runDirectory: committedReceipt.runDirectory,
            providerEvidenceFile: committedReceipt.providerEvidenceFile,
            draftPrEvidenceFile: committedReceipt.draftPrEvidenceFile,
            liveReleaseEvidenceFile: committedReceipt.liveReleaseEvidenceFile,
            receipt: publicReceipt(committedReceipt),
            residuals: [residual],
            recoveryPaths: recoveryPathsForResiduals([residual]),
            violations: [{ path: "cleanup", reason: residual.reason }],
          };
        }
      } catch {
        // Preserve the original fail-closed lock or transaction error.
      }
    }
    if (error instanceof PromotionError || error instanceof PromotionValidationError || error instanceof PromotionAggregateError) {
      const errorCommitted = nestedCommitted(error);
      return {
        ...resultBase,
        committed: errorCommitted,
        outcome: errorCommitted ? "committed_cleanup_required" : "not_committed",
        recoveryPaths: nestedRecoveryPaths(error),
        violations: error.violations,
      };
    }
    const errorCommitted = nestedCommitted(error);
    return {
      ...resultBase,
      committed: errorCommitted,
      outcome: errorCommitted ? "committed_cleanup_required" : "not_committed",
      recoveryPaths: nestedRecoveryPaths(error),
      violations: [{ path: "$", reason: error instanceof Error ? error.message : String(error) }],
    };
  }
}

function stringArg(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? "" : args[index + 1] || "";
}

async function main() {
  const args = process.argv.slice(2);
  const result = await promoteLiveReleaseEvidence({
    runRoot: stringArg(args, "--run-root"),
    providerReport: stringArg(args, "--provider-report") || undefined,
    draftRehearsal: stringArg(args, "--draft-rehearsal") || undefined,
    providerOnly: args.includes("--provider-only"),
    runId: stringArg(args, "--run-id") || undefined,
    evidenceFile: stringArg(args, "--evidence-file") || undefined,
    productEvidenceFile: stringArg(args, "--product-evidence-file") || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
