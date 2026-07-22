#!/usr/bin/env node
/**
 * Quota Delegate — single-writer IPC process for provider quota and usage state.
 *
 * The client writes command JSON files under {hubRoot}/providers/delegate/inbox.
 * This process serializes writes to provider quota/usage files and emits ack files
 * for commands that require confirmation.
 */

import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import {
  _internalMarkProviderUnavailable,
  _internalValidateProviderUnavailableInput,
  readProviderQuotas,
} from "./provider-quota.js";
import {
  _internalAppendUsageLine,
  _internalValidateProviderUsageInput,
  readProviderUsage,
} from "./provider-usage.js";
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  sameProcessIdentity,
  type ProcessIdentity,
} from "../../core/runtime/process-tree.js";
import { recordValue, type LooseRecord } from "../../shared/types.js";
import { assertHubWritable } from "../../shared/hub-maintenance.js";

const POLL_MS = Number(process.env.CPB_DELEGATE_POLL_MS || 50);
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;

function argValue(argv: string[], name: string) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function delegateDir(hubRoot: string) {
  return path.join(hubRoot, "providers", "delegate");
}

function inboxDir(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "inbox");
}

function acksDir(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "acks");
}

function lockFilePath(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "delegate.lock");
}

function lockTempFilePath(hubRoot: string) {
  return path.join(delegateDir(hubRoot), `.delegate.lock.${process.pid}.${randomUUID()}.tmp`);
}

function lockQuarantineFilePath(hubRoot: string) {
  return path.join(delegateDir(hubRoot), `.delegate.lock.${process.pid}.${randomUUID()}.quarantine`);
}

function lockClaimFilePath(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "delegate.lock.claim");
}

function lockClaimQuarantineFilePath(hubRoot: string) {
  return path.join(delegateDir(hubRoot), `.delegate.lock.claim.${process.pid}.${randomUUID()}.quarantine`);
}

function ackFilePath(hubRoot: string, commandId: string) {
  return path.join(acksDir(hubRoot), `${commandId}.json`);
}

function transactionsDir(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "transactions");
}

function transactionFilePath(hubRoot: string, mutationId: string) {
  return path.join(transactionsDir(hubRoot), `${mutationId}.json`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface QuotaDelegateLockReceipt {
  pid: number;
  hubRoot: string;
  startedAt: string;
  ownerToken: string;
  generation: string;
  processIdentity: ProcessIdentity;
  incarnation: string;
}

interface QuotaDelegateLockCandidate {
  receipt: QuotaDelegateLockReceipt;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

interface RegularFileGeneration {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

interface RegularFileAuthority {
  filePath: string;
  generation: RegularFileGeneration;
  sha256: string;
}

interface DirectoryAuthority {
  dirPath: string;
  generation: RegularFileGeneration;
}

type EntryInspectionState = "missing" | "regular-file" | "other" | "unavailable";

interface QuotaDelegateMutationClaim {
  version: 1;
  hubRoot: string;
  claimToken: string;
  purpose: "acquire" | "cleanup";
  targetGeneration: string | null;
  createdAt: string;
  processIdentity: ProcessIdentity;
}

export interface QuotaDelegateLockHooks {
  afterMutationClaimAcquired?: (context: {
    claimPath: string;
    purpose: "acquire" | "cleanup";
    targetGeneration: string | null;
  }) => void | Promise<void>;
  afterStaleLockObserved?: (context: { receipt: QuotaDelegateLockReceipt }) => void | Promise<void>;
  afterLockCommitted?: (context: {
    receipt: QuotaDelegateLockReceipt;
    tempPath: string;
    claimPath: string;
  }) => void | Promise<void>;
  afterOwnedLockObserved?: (context: { receipt: QuotaDelegateLockReceipt }) => void | Promise<void>;
  afterStaleMutationClaimObserved?: (context: { claimPath: string; claim: QuotaDelegateMutationClaim }) => void | Promise<void>;
  afterMutationClaimValidated?: (context: {
    claimPath: string;
    quarantinePath: string;
    claim: QuotaDelegateMutationClaim;
    action: "stale-recovery" | "release" | "rollback";
  }) => void | Promise<void>;
  afterLockQuarantined?: (context: {
    canonicalPath: string;
    quarantinePath: string;
    receipt: QuotaDelegateLockReceipt;
  }) => void | Promise<void>;
  afterQuarantinedLockValidated?: (context: {
    canonicalPath: string;
    quarantinePath: string;
    receipt: QuotaDelegateLockReceipt;
  }) => void | Promise<void>;
  syncQuarantineDirectory?: (context: {
    directory: string;
    phase: "post-rename" | "post-remove";
  }) => void | Promise<void>;
}

interface QuotaDelegateLockOperationOptions {
  hooks?: QuotaDelegateLockHooks;
  identityAlive?: (identity: ProcessIdentity) => boolean;
}

export interface QuotaDelegateLockAcquireOptions extends QuotaDelegateLockOperationOptions {
  ownerToken?: string;
}

export interface QuotaDelegateLockCleanupOutcome {
  status: "removed" | "missing" | "preserved";
  expectedGeneration: string;
  currentGeneration: string | null;
}

interface CleanupIssue {
  operation: string;
  path: string;
  error: Error;
}

export interface QuotaDelegateCommittedLockOutcome {
  committed: true;
  receipt: QuotaDelegateLockReceipt;
  cleanupErrors: Error[];
  cleanupIssues: CleanupIssue[];
  residualPaths: string[];
}

function quotaDelegateError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code || "";
}

function isDeterministicMutationFailure(error: unknown) {
  const code = errorCode(error);
  return code === "QUOTA_DELEGATE_COMMAND_INVALID";
}

function normalizedHubRoot(hubRoot: string) {
  return path.resolve(hubRoot);
}

function operationError(primary: unknown, cleanupIssues: CleanupIssue[]) {
  if (cleanupIssues.length === 0) return primary;
  const primaryError = asError(primary);
  return Object.assign(
    new AggregateError(
      [primaryError, ...cleanupIssues.map((issue) => issue.error)],
      primaryError.message,
      { cause: primaryError },
    ),
    primaryError,
    {
      code: (primaryError as NodeJS.ErrnoException).code || "QUOTA_DELEGATE_OPERATION_FAILED",
      primaryError,
      cleanupErrors: cleanupIssues.map((issue) => issue.error),
      cleanupIssues,
    },
  );
}

async function settleCleanup(tasks: Array<{ operation: string; path: string; run: () => Promise<unknown> }>) {
  const settled = await Promise.allSettled(tasks.map((task) => task.run()));
  const issues: CleanupIssue[] = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      issues.push({
        operation: tasks[index].operation,
        path: tasks[index].path,
        error: asError(result.reason),
      });
    }
  });
  return issues;
}

function invalidFileError(description: string, code: string) {
  return quotaDelegateError(`${description} must be a regular file opened without following symlinks`, code);
}

function regularFileGeneration(info: RegularFileGeneration): RegularFileGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function sameRegularFileGeneration(left: RegularFileGeneration, right: RegularFileGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameGenerationAcrossRename(left: RegularFileGeneration, right: RegularFileGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function exactProcessIdentityRecord(left: ProcessIdentity, right: ProcessIdentity) {
  return sameProcessIdentity(left, right)
    && left.pid === right.pid
    && left.birthId === right.birthId
    && left.birthIdPrecision === right.birthIdPrecision
    && left.incarnation === right.incarnation
    && left.capturedAt === right.capturedAt
    && (left.processGroupId ?? null) === (right.processGroupId ?? null);
}

function fileAuthority(
  filePath: string,
  content: string,
  generation: RegularFileGeneration,
): RegularFileAuthority {
  return {
    filePath,
    generation: regularFileGeneration(generation),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

function sameFileAuthority(
  expected: RegularFileAuthority,
  actual: RegularFileAuthority,
  { moved = false }: { moved?: boolean } = {},
) {
  return (moved
    ? sameGenerationAcrossRename(expected.generation, actual.generation)
    : sameRegularFileGeneration(expected.generation, actual.generation))
    && expected.sha256 === actual.sha256;
}

async function readDirectoryAuthority(dirPath: string): Promise<DirectoryAuthority> {
  const info = await lstat(dirPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw quotaDelegateError(`directory authority is unsafe: ${dirPath}`, "QUOTA_DELEGATE_DIRECTORY_UNSAFE");
  }
  return { dirPath, generation: regularFileGeneration(info) };
}

async function repinDirectoryAuthority(authority: DirectoryAuthority) {
  const current = await readDirectoryAuthority(authority.dirPath);
  if (!sameRegularFileGeneration(authority.generation, current.generation)) {
    throw quotaDelegateError(
      `directory authority changed before publication: ${authority.dirPath}`,
      "QUOTA_DELEGATE_ATOMIC_PUBLISH_CONFLICT",
    );
  }
}

function sameDirectoryIdentity(left: DirectoryAuthority, right: DirectoryAuthority) {
  return left.generation.dev === right.generation.dev
    && left.generation.ino === right.generation.ino
    && left.generation.birthtimeMs === right.generation.birthtimeMs;
}

async function inspectEntry(filePath: string): Promise<{
  state: EntryInspectionState;
  error: Error | null;
}> {
  try {
    const info = await lstat(filePath);
    return {
      state: info.isFile() && !info.isSymbolicLink() ? "regular-file" : "other",
      error: null,
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "missing", error: null };
    return { state: "unavailable", error: asError(error) };
  }
}

async function inspectCommandRemovalState(
  directory: string,
  expectedDirectory: DirectoryAuthority | null,
  canonicalPath: string,
  quarantinePath: string,
) {
  const issues: CleanupIssue[] = [];
  let directoryTrusted = false;
  if (expectedDirectory) {
    try {
      const currentDirectory = await readDirectoryAuthority(directory);
      directoryTrusted = sameDirectoryIdentity(expectedDirectory, currentDirectory);
      if (!directoryTrusted) {
        issues.push({
          operation: "repin quota delegate command directory",
          path: directory,
          error: quotaDelegateError(
            `quota delegate command directory identity changed: ${directory}`,
            "QUOTA_DELEGATE_DIRECTORY_UNSAFE",
          ),
        });
      }
    } catch (error) {
      issues.push({
        operation: "repin quota delegate command directory",
        path: directory,
        error: asError(error),
      });
    }
  }
  if (!directoryTrusted) {
    return {
      directoryTrusted,
      canonicalState: "unavailable" as const,
      quarantineState: "unavailable" as const,
      issues,
    };
  }
  const [canonical, quarantine] = await Promise.all([
    inspectEntry(canonicalPath),
    inspectEntry(quarantinePath),
  ]);
  if (canonical.error) {
    issues.push({ operation: "inspect quota delegate command", path: canonicalPath, error: canonical.error });
  }
  if (quarantine.error) {
    issues.push({ operation: "inspect quarantined quota delegate command", path: quarantinePath, error: quarantine.error });
  }
  return {
    directoryTrusted,
    canonicalState: canonical.state,
    quarantineState: quarantine.state,
    issues,
  };
}

function parseJsonRecord(raw: string, description: string, code: string) {
  try {
    return recordValue(JSON.parse(raw));
  } catch (error) {
    throw Object.assign(quotaDelegateError(`${description} contains invalid JSON`, code), { cause: error });
  }
}

async function readRegularFileNoFollowWithGeneration(
  filePath: string,
  description: string,
  invalidCode: string,
  maxBytes = MAX_CONTROL_FILE_BYTES,
  raceCode = invalidCode,
) {
  const before = await lstat(filePath);
  if (!before.isFile()) throw invalidFileError(description, invalidCode);
  if (!constants.O_NOFOLLOW) {
    throw invalidFileError(`${description}; O_NOFOLLOW is unavailable`, invalidCode);
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  let content = "";
  let generation: RegularFileGeneration | null = null;
  let linkCount: number | null = null;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameRegularFileGeneration(before, opened)) {
      throw invalidFileError(`${description}; file generation changed while opening`, raceCode);
    }
    if (opened.size > maxBytes) {
      throw quotaDelegateError(`${description} exceeds ${maxBytes} bytes`, invalidCode);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) {
        throw quotaDelegateError(`${description} exceeds ${maxBytes} bytes`, invalidCode);
      }
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const afterRead = await handle.stat();
    const afterPath = await lstat(filePath);
    if (
      !afterRead.isFile()
      || !afterPath.isFile()
      || !sameRegularFileGeneration(opened, afterRead)
      || !sameRegularFileGeneration(opened, afterPath)
    ) {
      throw invalidFileError(`${description}; file generation changed during read`, raceCode);
    }
    content = Buffer.concat(chunks, total).toString("utf8");
    generation = regularFileGeneration(afterPath);
    linkCount = afterPath.nlink;
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes((error as NodeJS.ErrnoException | undefined)?.code || "")) {
      primaryError = invalidFileError(description, invalidCode);
    } else {
      primaryError = error;
    }
  }
  const cleanupIssues = handle
    ? await settleCleanup([{ operation: "close", path: filePath, run: () => handle!.close() }])
    : [];
  if (primaryError) throw operationError(primaryError, cleanupIssues);
  if (cleanupIssues.length > 0) throw cleanupIssues[0].error;
  if (!generation || linkCount === null) throw invalidFileError(description, invalidCode);
  return {
    content,
    generation,
    authority: fileAuthority(filePath, content, generation),
    linkCount,
  };
}

async function readRegularFileNoFollow(filePath: string, description: string, invalidCode: string) {
  return (await readRegularFileNoFollowWithGeneration(filePath, description, invalidCode)).content;
}

async function syncDirectory(dirPath: string) {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw quotaDelegateError(
      `strict directory opens are unavailable: ${dirPath}`,
      "QUOTA_DELEGATE_DIRECTORY_UNSAFE",
    );
  }
  const before = await lstat(dirPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw quotaDelegateError(`directory sync target is unsafe: ${dirPath}`, "QUOTA_DELEGATE_DIRECTORY_UNSAFE");
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dirPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  } catch (error) {
    throw Object.assign(
      quotaDelegateError(`directory sync target could not be opened safely: ${dirPath}`, "QUOTA_DELEGATE_DIRECTORY_UNSAFE"),
      { cause: error },
    );
  }
  let primaryError: unknown = null;
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.birthtimeMs !== before.birthtimeMs
    ) {
      throw quotaDelegateError(`directory sync target changed while opening: ${dirPath}`, "QUOTA_DELEGATE_DIRECTORY_UNSAFE");
    }
    await handle.sync();
    const afterDescriptor = await handle.stat();
    const afterPath = await lstat(dirPath);
    if (
      !afterDescriptor.isDirectory()
      || !afterPath.isDirectory()
      || afterPath.isSymbolicLink()
      || afterDescriptor.dev !== opened.dev
      || afterDescriptor.ino !== opened.ino
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
      || afterDescriptor.birthtimeMs !== opened.birthtimeMs
      || afterPath.birthtimeMs !== opened.birthtimeMs
    ) {
      throw quotaDelegateError(`directory sync target changed during sync: ${dirPath}`, "QUOTA_DELEGATE_DIRECTORY_UNSAFE");
    }
  } catch (error) {
    primaryError = error;
  }
  const cleanupIssues = await settleCleanup([{ operation: "close", path: dirPath, run: () => handle.close() }]);
  if (primaryError) throw operationError(primaryError, cleanupIssues);
  if (cleanupIssues.length > 0) throw cleanupIssues[0].error;
}

async function writeDurableExclusive(filePath: string, content: string) {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let created = false;
  let primaryError: unknown = null;
  let authority: RegularFileAuthority | null = null;
  try {
    if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
      throw quotaDelegateError(
        `strict exclusive writes are unavailable: ${filePath}`,
        "QUOTA_DELEGATE_WRITE_UNSAFE",
      );
    }
    handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(content, "utf8");
    const info = await handle.stat();
    if (!info.isFile()) {
      throw invalidFileError(`exclusive write target ${filePath}`, "QUOTA_DELEGATE_WRITE_UNSAFE");
    }
    authority = fileAuthority(filePath, content, regularFileGeneration(info));
    await handle.sync();
  } catch (error) {
    primaryError = error;
  }
  const closeIssues = handle
    ? await settleCleanup([{ operation: "close", path: filePath, run: () => handle!.close() }])
    : [];
  if (!primaryError && closeIssues.length > 0) primaryError = closeIssues.shift()!.error;
  const cleanupIssues = [...closeIssues];
  if (primaryError) {
    const preservation = created
      ? await inspectEntry(filePath)
      : { state: "missing" as const, error: null };
    if (preservation.error) {
      cleanupIssues.push({
        operation: "inspect failed exclusive write",
        path: filePath,
        error: preservation.error,
      });
    }
    const residualPresent = preservation.state === "regular-file" || preservation.state === "other";
    throw Object.assign(asError(operationError(primaryError, cleanupIssues)), {
      committed: false,
      created,
      committedPath: null,
      recoveryPaths: created ? [filePath, path.dirname(filePath)] : [],
      residualPaths: residualPresent ? [filePath] : [],
      recoveryState: preservation.state,
      ...(authority ? { authority } : {}),
    });
  }
  if (!authority) throw quotaDelegateError(`exclusive write authority unavailable: ${filePath}`, "QUOTA_DELEGATE_WRITE_UNSAFE");
  return authority;
}

async function readFileAuthority(
  filePath: string,
  description: string,
  invalidCode = "QUOTA_DELEGATE_FILE_RACE",
) {
  const observed = await readRegularFileNoFollowWithGeneration(filePath, description, invalidCode);
  return observed.authority;
}

async function authorityRaceError(
  message: string,
  code: string,
  authority: RegularFileAuthority,
  recoveryPath: string,
  committed: boolean,
  cause?: unknown,
) {
  const canonical = await inspectEntry(authority.filePath);
  const recovery = recoveryPath === authority.filePath
    ? canonical
    : await inspectEntry(recoveryPath);
  const inspectionErrors = [canonical.error, recovery.error]
    .filter((error): error is Error => error !== null);
  const canonicalPresent = canonical.state === "regular-file" || canonical.state === "other";
  const recoveryPresent = recovery.state === "regular-file" || recovery.state === "other";
  return Object.assign(quotaDelegateError(message, code), {
    ...(cause === undefined ? {} : { cause }),
    committed,
    renameCommitted: committed,
    committedPath: committed && recoveryPresent ? recoveryPath : null,
    recoveryPaths: [authority.filePath, recoveryPath, path.dirname(authority.filePath)],
    residualPaths: [
      ...(canonicalPresent ? [authority.filePath] : []),
      ...(recoveryPath !== authority.filePath && recoveryPresent ? [recoveryPath] : []),
    ],
    successorPreserved: canonical.state === "unavailable" ? null : canonicalPresent,
    recoveryPreserved: recovery.state === "unavailable" ? null : recoveryPresent,
    preservation: {
      canonicalState: canonical.state,
      recoveryState: recovery.state,
    },
    cleanupErrors: inspectionErrors,
    expectedFileIdentity: authority.generation,
  });
}

async function cleanupPinnedTemporary(
  authority: RegularFileAuthority,
  description: string,
) {
  const quarantinePath = `${authority.filePath}.${randomUUID()}.cleanup-recovery`;
  let current: RegularFileAuthority;
  try {
    current = await readFileAuthority(authority.filePath, description);
  } catch (error) {
    throw await authorityRaceError(
      `${description} changed before cleanup; successor preserved`,
      "QUOTA_DELEGATE_TEMP_RACE",
      authority,
      authority.filePath,
      false,
      error,
    );
  }
  if (!sameFileAuthority(authority, current)) {
    throw await authorityRaceError(
      `${description} changed before cleanup; successor preserved`,
      "QUOTA_DELEGATE_TEMP_RACE",
      authority,
      authority.filePath,
      false,
    );
  }
  try {
    await rename(authority.filePath, quarantinePath);
  } catch (error) {
    throw await authorityRaceError(
      `${description} could not be isolated for cleanup`,
      "QUOTA_DELEGATE_TEMP_RACE",
      authority,
      authority.filePath,
      false,
      error,
    );
  }
  try {
    await syncDirectory(path.dirname(authority.filePath));
    const moved = await readFileAuthority(quarantinePath, description);
    if (!sameFileAuthority(current, moved, { moved: true })) {
      throw await authorityRaceError(
        `${description} changed during cleanup isolation; recovery evidence preserved`,
        "QUOTA_DELEGATE_TEMP_RACE",
        authority,
        quarantinePath,
        true,
      );
    }
    return quarantinePath;
  } catch (error) {
    if (errorCode(error) === "QUOTA_DELEGATE_TEMP_RACE") throw error;
    throw await authorityRaceError(
      `${description} cleanup failed after isolation`,
      "QUOTA_DELEGATE_TEMP_CLEANUP_FAILED",
      authority,
      quarantinePath,
      true,
      error,
    );
  }
}

function parseProcessIdentity(value: unknown, invalidCode: string): ProcessIdentity {
  const identity = recordValue(value);
  const pid = nullableNumber(identity.pid);
  const birthId = stringValue(identity.birthId);
  const incarnation = stringValue(identity.incarnation);
  const capturedAt = stringValue(identity.capturedAt);
  const birthIdPrecision = identity.birthIdPrecision;
  const processGroupId = identity.processGroupId;
  if (
    !pid
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || !birthId
    || birthIdPrecision !== "exact"
    || !incarnation
    || !capturedAt
    || !canonicalIsoTimestamp(capturedAt)
    || incarnation !== `${pid}:${birthId}`
    || (processGroupId !== undefined && (!Number.isSafeInteger(processGroupId) || Number(processGroupId) <= 0))
  ) {
    throw quotaDelegateError("quota delegate process identity is invalid", invalidCode);
  }
  return {
    pid,
    birthId,
    incarnation,
    capturedAt,
    birthIdPrecision: "exact",
    ...(processGroupId === undefined ? {} : { processGroupId: Number(processGroupId) }),
  } satisfies ProcessIdentity;
}

function canonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function captureQuotaDelegateProcessIdentity(): ProcessIdentity {
  let identity: ProcessIdentity | null;
  try {
    identity = captureProcessIdentity(process.pid, { strict: true });
  } catch (error) {
    throw Object.assign(
      quotaDelegateError("quota delegate exact process identity unavailable", "QUOTA_DELEGATE_IDENTITY_UNAVAILABLE"),
      { cause: error },
    );
  }
  if (
    !identity
    || identity.pid !== process.pid
    || identity.birthIdPrecision !== "exact"
    || !identity.birthId
    || identity.incarnation !== `${identity.pid}:${identity.birthId}`
    || !identity.capturedAt
    || !canonicalIsoTimestamp(identity.capturedAt)
    || (identity.processGroupId !== undefined
      && (!Number.isSafeInteger(identity.processGroupId) || identity.processGroupId <= 0))
  ) {
    throw quotaDelegateError(
      "quota delegate exact process identity unavailable",
      "QUOTA_DELEGATE_IDENTITY_UNAVAILABLE",
    );
  }
  return { ...identity, birthIdPrecision: "exact" };
}

function parseLockReceipt(raw: string, expectedHubRoot?: string): QuotaDelegateLockReceipt {
  const lock = parseJsonRecord(raw, "quota delegate lock", "QUOTA_DELEGATE_LOCK_INVALID");
  const processIdentity = parseProcessIdentity(lock.processIdentity, "QUOTA_DELEGATE_LOCK_INVALID");
  const pid = nullableNumber(lock.pid);
  const ownerToken = stringValue(lock.ownerToken);
  const generation = stringValue(lock.generation);
  const incarnation = stringValue(lock.incarnation);
  const hubRootValue = stringValue(lock.hubRoot);
  const startedAt = stringValue(lock.startedAt);
  if (
    !pid
    || !ownerToken
    || !generation
    || !incarnation
    || !hubRootValue
    || !canonicalIsoTimestamp(startedAt)
  ) {
    throw quotaDelegateError("quota delegate lock is missing required owner fields", "QUOTA_DELEGATE_LOCK_INVALID");
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid !== processIdentity.pid || incarnation !== processIdentity.incarnation) {
    throw quotaDelegateError("quota delegate lock identity fields do not agree", "QUOTA_DELEGATE_LOCK_INVALID");
  }
  if (expectedHubRoot && normalizedHubRoot(hubRootValue) !== normalizedHubRoot(expectedHubRoot)) {
    throw quotaDelegateError("quota delegate lock is bound to a different hub root", "QUOTA_DELEGATE_LOCK_INVALID");
  }
  return {
    pid,
    hubRoot: normalizedHubRoot(hubRootValue),
    startedAt,
    ownerToken,
    generation,
    processIdentity,
    incarnation,
  };
}

async function readLockCandidateAtPath(filePath: string, hubRoot: string): Promise<QuotaDelegateLockCandidate> {
  const observed = await readRegularFileNoFollowWithGeneration(
    filePath,
    "quota delegate lock",
    "QUOTA_DELEGATE_LOCK_INVALID",
  );
  const receipt = parseLockReceipt(
    observed.content,
    hubRoot,
  );
  return { receipt, ...observed.generation };
}

async function readExistingLockCandidate(hubRoot: string) {
  try {
    return await readLockCandidateAtPath(lockFilePath(hubRoot), hubRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
}

async function readExistingLock(hubRoot: string) {
  return (await readExistingLockCandidate(hubRoot))?.receipt ?? null;
}

function sameLockOwner(expected: QuotaDelegateLockReceipt, actual: QuotaDelegateLockReceipt) {
  return expected.ownerToken === actual.ownerToken
    && expected.generation === actual.generation
    && expected.pid === actual.pid
    && expected.hubRoot === actual.hubRoot
    && expected.startedAt === actual.startedAt
    && expected.incarnation === actual.incarnation
    && exactProcessIdentityRecord(expected.processIdentity, actual.processIdentity);
}

function sameMutationClaim(expected: QuotaDelegateMutationClaim, actual: QuotaDelegateMutationClaim) {
  return expected.version === actual.version
    && expected.hubRoot === actual.hubRoot
    && expected.claimToken === actual.claimToken
    && expected.purpose === actual.purpose
    && expected.targetGeneration === actual.targetGeneration
    && expected.createdAt === actual.createdAt
    && exactProcessIdentityRecord(expected.processIdentity, actual.processIdentity);
}

function candidateFileIdentity(candidate: RegularFileGeneration) {
  return regularFileGeneration(candidate);
}

interface QuarantinedLockRestoration {
  canonicalState: "missing" | "present" | "unavailable";
  quarantineState: "missing" | "present" | "unavailable";
  inspectionIssues: CleanupIssue[];
}

async function inspectQuarantinedLockState(
  hubRoot: string,
  quarantinePath: string,
): Promise<QuarantinedLockRestoration> {
  const publicPath = lockFilePath(hubRoot);
  const inspectionIssues: CleanupIssue[] = [];
  const inspect = async (operation: string, filePath: string) => {
    try {
      await lstat(filePath);
      return "present" as const;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "missing" as const;
      inspectionIssues.push({ operation, path: filePath, error: asError(error) });
      return "unavailable" as const;
    }
  };
  const [canonicalState, quarantineState] = await Promise.all([
    inspect("inspect canonical quota delegate lock", publicPath),
    inspect("inspect quarantined quota delegate lock", quarantinePath),
  ]);
  return { canonicalState, quarantineState, inspectionIssues };
}

async function quarantinedLockFailure(
  hubRoot: string,
  primary: unknown,
  expected: QuotaDelegateLockCandidate,
  moved: QuotaDelegateLockCandidate | null,
  quarantinePath: string,
) {
  const publicPath = lockFilePath(hubRoot);
  const preservation = await inspectQuarantinedLockState(hubRoot, quarantinePath);
  return Object.assign(asError(operationError(primary, preservation.inspectionIssues)), {
    committed: true,
    renameCommitted: true,
    removalCommitted: false,
    committedPath: preservation.quarantineState === "present" ? quarantinePath : null,
    quarantinePreserved: preservation.quarantineState === "present",
    successorPreserved: preservation.canonicalState === "present",
    recoveryPaths: { canonical: publicPath, quarantine: quarantinePath },
    expectedReceipt: expected.receipt,
    expectedFileIdentity: candidateFileIdentity(expected),
    movedReceipt: moved?.receipt ?? null,
    movedFileIdentity: moved ? candidateFileIdentity(moved) : null,
    quarantinePath,
    preservation: {
      canonicalState: preservation.canonicalState,
      quarantineState: preservation.quarantineState,
    },
    residualPaths: [
      ...(preservation.canonicalState === "present" ? [publicPath] : []),
      ...(preservation.quarantineState === "present" ? [quarantinePath] : []),
    ],
  });
}

async function preQuarantineLockFailure(
  hubRoot: string,
  primary: unknown,
  expected: QuotaDelegateLockCandidate,
  current: QuotaDelegateLockCandidate | null,
  quarantinePath: string,
) {
  const publicPath = lockFilePath(hubRoot);
  const preservation = await inspectQuarantinedLockState(hubRoot, quarantinePath);
  return Object.assign(asError(operationError(primary, preservation.inspectionIssues)), {
    committed: false,
    renameCommitted: false,
    removalCommitted: false,
    committedPath: null,
    quarantinePreserved: preservation.quarantineState === "present",
    successorPreserved: preservation.canonicalState === "present",
    recoveryPaths: { canonical: publicPath, quarantine: quarantinePath },
    expectedReceipt: expected.receipt,
    expectedFileIdentity: candidateFileIdentity(expected),
    currentReceipt: current?.receipt ?? null,
    currentFileIdentity: current ? candidateFileIdentity(current) : null,
    residualPaths: [
      ...(preservation.canonicalState === "present" ? [publicPath] : []),
      ...(preservation.quarantineState === "present" ? [quarantinePath] : []),
    ],
  });
}

async function quarantineAndRemoveLock(
  hubRoot: string,
  expected: QuotaDelegateLockCandidate,
  validateMoved?: (receipt: QuotaDelegateLockReceipt) => void | Promise<void>,
  hooks?: QuotaDelegateLockHooks,
) {
  const publicPath = lockFilePath(hubRoot);
  const quarantinePath = lockQuarantineFilePath(hubRoot);
  const directory = delegateDir(hubRoot);
  let current: QuotaDelegateLockCandidate;
  try {
    current = await readLockCandidateAtPath(publicPath, hubRoot);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw await preQuarantineLockFailure(hubRoot, error, expected, null, quarantinePath);
  }
  if (
    !sameRegularFileGeneration(current, expected)
    || !sameLockOwner(expected.receipt, current.receipt)
  ) {
    throw await preQuarantineLockFailure(
      hubRoot,
      quotaDelegateError(
        "quota delegate lock ownership changed before quarantine",
        "QUOTA_DELEGATE_LOCK_RACE",
      ),
      expected,
      current,
      quarantinePath,
    );
  }
  try {
    await rename(publicPath, quarantinePath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }

  let renamedGeneration: RegularFileGeneration;
  try {
    const renamedInfo = await lstat(quarantinePath);
    if (!renamedInfo.isFile() || !sameGenerationAcrossRename(current, renamedInfo)) {
      throw quotaDelegateError(
        "quota delegate lock generation changed during quarantine rename",
        "QUOTA_DELEGATE_LOCK_RACE",
      );
    }
    renamedGeneration = regularFileGeneration(renamedInfo);
  } catch (error) {
    throw await quarantinedLockFailure(hubRoot, error, expected, null, quarantinePath);
  }

  try {
    await hooks?.syncQuarantineDirectory?.({ directory, phase: "post-rename" });
    await syncDirectory(directory);
  } catch (error) {
    throw await quarantinedLockFailure(
      hubRoot,
      Object.assign(
        quotaDelegateError(
          "quota delegate lock quarantine committed but directory durability is ambiguous",
          "QUOTA_DELEGATE_LOCK_QUARANTINE_DURABILITY_AMBIGUOUS",
        ),
        { cause: error },
      ),
      expected,
      null,
      quarantinePath,
    );
  }

  let moved: QuotaDelegateLockCandidate | null = null;
  let verificationError: unknown = null;
  try {
    await hooks?.afterLockQuarantined?.({
      canonicalPath: publicPath,
      quarantinePath,
      receipt: expected.receipt,
    });
    moved = await readLockCandidateAtPath(quarantinePath, hubRoot);
    if (
      !sameRegularFileGeneration(moved, renamedGeneration)
      || !sameLockOwner(expected.receipt, moved.receipt)
    ) {
      verificationError = quotaDelegateError(
        "quota delegate lock ownership changed before quarantine",
        "QUOTA_DELEGATE_LOCK_RACE",
      );
    } else {
      await validateMoved?.(moved.receipt);
    }
  } catch (error) {
    verificationError = error;
  }

  if (verificationError) {
    throw await quarantinedLockFailure(hubRoot, verificationError, expected, moved, quarantinePath);
  }

  try {
    await hooks?.afterQuarantinedLockValidated?.({
      canonicalPath: publicPath,
      quarantinePath,
      receipt: expected.receipt,
    });
    const retained = await readLockCandidateAtPath(quarantinePath, hubRoot);
    if (
      !moved
      || !sameRegularFileGeneration(moved, retained)
      || !sameLockOwner(moved.receipt, retained.receipt)
    ) {
      throw quotaDelegateError(
        "quota delegate lock generation changed after quarantine validation",
        "QUOTA_DELEGATE_LOCK_RACE",
      );
    }
    moved = retained;
  } catch (error) {
    throw await quarantinedLockFailure(hubRoot, error, expected, moved, quarantinePath);
  }

  try {
    await lstat(publicPath);
    throw quotaDelegateError(
      "quota delegate lock successor appeared while quarantine was held",
      "QUOTA_DELEGATE_LOCK_SUCCESSOR_PRESERVED",
    );
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw await quarantinedLockFailure(hubRoot, error, expected, moved, quarantinePath);
    }
  }

  // The canonical owner is removed by the rename. Retain the validated,
  // uniquely-named quarantine as recovery evidence instead of unlinking a
  // pathname that could have been replaced after validation.
  return true;
}

function parseMutationClaim(raw: string, expectedHubRoot: string): QuotaDelegateMutationClaim {
  const value = parseJsonRecord(raw, "quota delegate mutation claim", "QUOTA_DELEGATE_MUTATION_CLAIM_INVALID");
  const version = nullableNumber(value.version);
  const hubRoot = stringValue(value.hubRoot);
  const claimToken = stringValue(value.claimToken);
  const purpose = stringValue(value.purpose);
  const targetGeneration = value.targetGeneration === null ? null : stringValue(value.targetGeneration);
  const createdAt = stringValue(value.createdAt);
  const processIdentity = parseProcessIdentity(value.processIdentity, "QUOTA_DELEGATE_MUTATION_CLAIM_INVALID");
  if (
    version !== 1
    || !hubRoot
    || !claimToken
    || (purpose !== "acquire" && purpose !== "cleanup")
    || (value.targetGeneration !== null && !targetGeneration)
    || !canonicalIsoTimestamp(createdAt)
    || normalizedHubRoot(hubRoot) !== normalizedHubRoot(expectedHubRoot)
  ) {
    throw quotaDelegateError("quota delegate mutation claim is invalid", "QUOTA_DELEGATE_MUTATION_CLAIM_INVALID");
  }
  return {
    version: 1,
    hubRoot: normalizedHubRoot(hubRoot),
    claimToken,
    purpose,
    targetGeneration,
    createdAt,
    processIdentity,
  };
}

async function readMutationClaim(hubRoot: string) {
  return parseMutationClaim(
    await readRegularFileNoFollow(
      lockClaimFilePath(hubRoot),
      "quota delegate mutation claim",
      "QUOTA_DELEGATE_MUTATION_CLAIM_INVALID",
    ),
    hubRoot,
  );
}

async function readMutationClaimWithStat(hubRoot: string) {
  const claimPath = lockClaimFilePath(hubRoot);
  const observed = await readRegularFileNoFollowWithGeneration(
    claimPath,
    "quota delegate mutation claim",
    "QUOTA_DELEGATE_MUTATION_CLAIM_INVALID",
  );
  const claim = parseMutationClaim(
    observed.content,
    hubRoot,
  );
  return { claim, ...observed.generation };
}

type MutationClaimCandidate = Awaited<ReturnType<typeof readMutationClaimWithStat>>;

async function mutationClaimFailure(
  hubRoot: string,
  expected: MutationClaimCandidate,
  quarantinePath: string,
  committed: boolean,
  cause: unknown,
) {
  const claimPath = lockClaimFilePath(hubRoot);
  const inspect = async (filePath: string) => {
    try {
      await lstat(filePath);
      return "present" as const;
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "missing" as const : "unavailable" as const;
    }
  };
  const [canonicalState, quarantineState] = await Promise.all([
    inspect(claimPath),
    inspect(quarantinePath),
  ]);
  return Object.assign(asError(cause), {
    code: errorCode(cause) || "QUOTA_DELEGATE_MUTATION_CLAIM_RACE",
    committed,
    renameCommitted: committed,
    removalCommitted: false,
    committedPath: quarantineState === "present" ? quarantinePath : null,
    quarantinePreserved: quarantineState === "present",
    successorPreserved: canonicalState === "present",
    recoveryPaths: { canonical: claimPath, quarantine: quarantinePath },
    expectedClaim: expected.claim,
    expectedFileIdentity: regularFileGeneration(expected),
    residualPaths: [
      ...(canonicalState === "present" ? [claimPath] : []),
      ...(quarantineState === "present" ? [quarantinePath] : []),
    ],
  });
}

async function quarantineMutationClaim(
  hubRoot: string,
  expected: MutationClaimCandidate,
  action: "stale-recovery" | "release" | "rollback",
  hooks?: QuotaDelegateLockHooks,
) {
  const claimPath = lockClaimFilePath(hubRoot);
  const quarantinePath = lockClaimQuarantineFilePath(hubRoot);
  let current: MutationClaimCandidate;
  try {
    current = await readMutationClaimWithStat(hubRoot);
  } catch (error) {
    throw await mutationClaimFailure(hubRoot, expected, quarantinePath, false, error);
  }
  if (!sameRegularFileGeneration(expected, current) || !sameMutationClaim(expected.claim, current.claim)) {
    throw await mutationClaimFailure(
      hubRoot,
      expected,
      quarantinePath,
      false,
      quotaDelegateError("quota delegate mutation claim changed before isolation", "QUOTA_DELEGATE_MUTATION_CLAIM_RACE"),
    );
  }
  try {
    await rename(claimPath, quarantinePath);
  } catch (error) {
    throw await mutationClaimFailure(hubRoot, expected, quarantinePath, false, error);
  }
  try {
    await syncDirectory(delegateDir(hubRoot));
    const movedObserved = await readRegularFileNoFollowWithGeneration(
      quarantinePath,
      "quota delegate quarantined mutation claim",
      "QUOTA_DELEGATE_MUTATION_CLAIM_INVALID",
    );
    const moved: MutationClaimCandidate = {
      claim: parseMutationClaim(movedObserved.content, hubRoot),
      ...movedObserved.generation,
    };
    if (!sameGenerationAcrossRename(current, moved) || !sameMutationClaim(expected.claim, moved.claim)) {
      throw quotaDelegateError(
        "quota delegate mutation claim changed during isolation",
        "QUOTA_DELEGATE_MUTATION_CLAIM_RACE",
      );
    }
    await hooks?.afterMutationClaimValidated?.({
      claimPath,
      quarantinePath,
      claim: moved.claim,
      action,
    });
    const retainedObserved = await readRegularFileNoFollowWithGeneration(
      quarantinePath,
      "quota delegate quarantined mutation claim",
      "QUOTA_DELEGATE_MUTATION_CLAIM_INVALID",
    );
    const retained: MutationClaimCandidate = {
      claim: parseMutationClaim(retainedObserved.content, hubRoot),
      ...retainedObserved.generation,
    };
    if (!sameRegularFileGeneration(moved, retained) || !sameMutationClaim(moved.claim, retained.claim)) {
      throw quotaDelegateError(
        "quota delegate mutation claim changed after validation",
        "QUOTA_DELEGATE_MUTATION_CLAIM_RACE",
      );
    }
    return quarantinePath;
  } catch (error) {
    throw await mutationClaimFailure(hubRoot, expected, quarantinePath, true, error);
  }
}

const MUTATION_FENCE_PROTOCOL = "cpb-quota-delegate-mutation-fence/v2 ";

function claimFenceKey(hubRoot: string) {
  return createHash("sha256")
    .update(`${normalizedHubRoot(hubRoot)}\0quota-delegate-mutation-fence-v2`)
    .digest("hex");
}

function claimFencePorts(hubRoot: string) {
  const fenceKey = claimFenceKey(hubRoot);
  const ports: number[] = [];
  const seen = new Set<number>();
  for (let counter = 0; ports.length < 32; counter += 1) {
    const digest = createHash("sha256").update(`${fenceKey}\0${counter}`).digest();
    for (let offset = 0; offset + 1 < digest.length && ports.length < 32; offset += 2) {
      const port = 20_000 + (digest.readUInt16BE(offset) % 40_000);
      if (seen.has(port)) continue;
      seen.add(port);
      ports.push(port);
    }
  }
  return ports;
}

export function _internalQuotaDelegateMutationFenceForTests(hubRoot: string) {
  return {
    protocol: MUTATION_FENCE_PROTOCOL,
    key: claimFenceKey(normalizedHubRoot(hubRoot)),
    ports: claimFencePorts(normalizedHubRoot(hubRoot)),
  };
}

async function probeMutationKernelFence(
  port: number,
  expectedKey: string,
): Promise<"same" | "other" | "indeterminate"> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.unref();
    let settled = false;
    let response = "";
    const finish = (result: "same" | "other" | "indeterminate") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("indeterminate"), 250);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline >= 0) {
        finish(response.slice(0, newline) === `${MUTATION_FENCE_PROTOCOL}${expectedKey}` ? "same" : "other");
      } else if (response.length > MUTATION_FENCE_PROTOCOL.length && !response.startsWith(MUTATION_FENCE_PROTOCOL)) {
        finish("other");
      }
    });
    socket.on("end", () => {
      finish(response.trim() === `${MUTATION_FENCE_PROTOCOL}${expectedKey}` ? "same" : "other");
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") finish("other");
      else finish("indeterminate");
    });
  });
}

async function acquireMutationKernelFence(hubRoot: string) {
  const fenceKey = claimFenceKey(hubRoot);
  const ports = claimFencePorts(hubRoot);
  let exhaustedByUnrelated = true;
  for (const port of ports) {
    const existing = await probeMutationKernelFence(port, fenceKey);
    if (existing !== "other") {
      exhaustedByUnrelated = false;
      throw quotaDelegateError(
        existing === "same"
          ? "quota delegate lock mutation is already fenced by another local owner"
          : "quota delegate lock mutation fence owner could not be verified",
        "QUOTA_DELEGATE_LOCK_BUSY",
      );
    }
    const server = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end(`${MUTATION_FENCE_PROTOCOL}${fenceKey}\n`);
    });
    server.unref();
    const listenError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        resolve(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(null);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: "127.0.0.1", port, exclusive: true });
    });
    if (!listenError) {
      let runtimeError: unknown = null;
      server.on("error", (error) => {
        runtimeError = error;
      });
      return async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error || runtimeError) {
              reject(error || runtimeError);
            } else {
              resolve();
            }
          });
        });
      };
    }
    if (listenError.code !== "EADDRINUSE") throw listenError;
    const probe = await probeMutationKernelFence(port, fenceKey);
    if (probe === "other") continue;
    exhaustedByUnrelated = false;
    throw quotaDelegateError(
      probe === "same"
        ? "quota delegate lock mutation is already fenced by another local owner"
        : "quota delegate lock mutation fence owner could not be verified",
      "QUOTA_DELEGATE_LOCK_BUSY",
    );
  }
  throw quotaDelegateError(
    exhaustedByUnrelated
      ? "quota delegate lock mutation fence namespace is occupied by unrelated listeners"
      : "quota delegate lock mutation is already fenced by another local owner",
    exhaustedByUnrelated ? "QUOTA_DELEGATE_FENCE_UNAVAILABLE" : "QUOTA_DELEGATE_LOCK_BUSY",
  );
}

interface ActiveMutationClaim extends QuotaDelegateMutationClaim {
  releaseKernelFence: () => Promise<void>;
}

async function acquireMutationClaim(
  hubRoot: string,
  purpose: "acquire" | "cleanup",
  targetGeneration: string | null,
  identityAlive: (identity: ProcessIdentity) => boolean,
  hooks?: QuotaDelegateLockHooks,
): Promise<ActiveMutationClaim> {
  const releaseKernelFence = await acquireMutationKernelFence(hubRoot);
  let processIdentity: ProcessIdentity;
  try {
    processIdentity = captureQuotaDelegateProcessIdentity();
  } catch (error) {
    const cleanupIssues = await settleCleanup([
      { operation: "release mutation kernel fence", path: `127.0.0.1:${claimFencePorts(hubRoot).join(",")}`, run: releaseKernelFence },
    ]);
    throw operationError(error, cleanupIssues);
  }
  const claim: QuotaDelegateMutationClaim = {
    version: 1,
    hubRoot,
    claimToken: randomUUID(),
    purpose,
    targetGeneration,
    createdAt: new Date().toISOString(),
    processIdentity,
  };
  const claimPath = lockClaimFilePath(hubRoot);

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeDurableExclusive(claimPath, JSON.stringify(claim, null, 2) + "\n");
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
          const failedWrite = error as Error & {
            created?: boolean;
            authority?: RegularFileAuthority;
            residualPaths?: string[];
          };
          let isolatedPath: string | null = null;
          const isolationIssues: CleanupIssue[] = [];
          if (failedWrite.created && failedWrite.authority) {
            try {
              isolatedPath = await cleanupPinnedTemporary(
                failedWrite.authority,
                "failed quota delegate mutation claim",
              );
            } catch (isolationError) {
              isolationIssues.push({
                operation: "isolate failed mutation claim",
                path: claimPath,
                error: asError(isolationError),
              });
            }
          }
          const enriched = asError(operationError(error, isolationIssues));
          throw Object.assign(enriched, {
            committed: false,
            publicationCommitted: false,
            cleanupCommitted: isolatedPath !== null,
            committedPath: isolatedPath,
            recoveryPaths: [claimPath, ...(isolatedPath ? [isolatedPath] : []), delegateDir(hubRoot)],
            residualPaths: isolatedPath ? [isolatedPath] : (failedWrite.residualPaths ?? []),
          });
        }
        let existing: Awaited<ReturnType<typeof readMutationClaimWithStat>>;
        try {
          existing = await readMutationClaimWithStat(hubRoot);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
          throw readError;
        }
        if (identityAlive(existing.claim.processIdentity)) {
          throw Object.assign(
            quotaDelegateError("quota delegate lock mutation is already in progress", "QUOTA_DELEGATE_LOCK_BUSY"),
            { claim: existing.claim },
          );
        }
        await hooks?.afterStaleMutationClaimObserved?.({ claimPath, claim: existing.claim });
        await quarantineMutationClaim(hubRoot, existing, "stale-recovery", hooks);
        continue;
      }
      try {
        await syncDirectory(delegateDir(hubRoot));
        return { ...claim, releaseKernelFence } satisfies ActiveMutationClaim;
      } catch (error) {
        const rollbackIssues: CleanupIssue[] = [];
        try {
          const current = await readMutationClaimWithStat(hubRoot);
          if (!sameMutationClaim(claim, current.claim)) {
            throw quotaDelegateError(
              "quota delegate mutation claim changed before rollback isolation",
              "QUOTA_DELEGATE_MUTATION_CLAIM_RACE",
            );
          }
          await quarantineMutationClaim(hubRoot, current, "rollback", hooks);
        } catch (rollbackError) {
          rollbackIssues.push({
            operation: "isolate unsynced mutation claim",
            path: claimPath,
            error: asError(rollbackError),
          });
        }
        throw operationError(error, rollbackIssues);
      }
    }
    throw quotaDelegateError("quota delegate mutation claim raced with another owner", "QUOTA_DELEGATE_LOCK_RACE");
  } catch (error) {
    const cleanupIssues = await settleCleanup([
      { operation: "release mutation kernel fence", path: `127.0.0.1:${claimFencePorts(hubRoot).join(",")}`, run: releaseKernelFence },
    ]);
    throw operationError(error, cleanupIssues);
  }
}

async function releaseMutationClaim(hubRoot: string, claim: ActiveMutationClaim, hooks?: QuotaDelegateLockHooks) {
  let primaryError: unknown = null;
  try {
    const current = await readMutationClaimWithStat(hubRoot);
    if (
      !sameMutationClaim(claim, current.claim)
    ) {
      throw quotaDelegateError("quota delegate mutation claim ownership changed", "QUOTA_DELEGATE_MUTATION_CLAIM_MISMATCH");
    }
    await quarantineMutationClaim(hubRoot, current, "release", hooks);
  } catch (error) {
    primaryError = error;
  }
  const cleanupIssues = await settleCleanup([
    { operation: "release mutation kernel fence", path: `127.0.0.1:${claimFencePorts(hubRoot).join(",")}`, run: claim.releaseKernelFence },
  ]);
  if (primaryError) throw operationError(primaryError, cleanupIssues);
  if (cleanupIssues.length > 0) throw cleanupIssues[0].error;
}

function reportedResidualPaths(error: unknown) {
  if (!error || typeof error !== "object") return [];
  const value = error as { residualPaths?: unknown; committedPath?: unknown };
  return [
    ...(Array.isArray(value.residualPaths)
      ? value.residualPaths.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      : []),
    ...(typeof value.committedPath === "string" && value.committedPath.length > 0 ? [value.committedPath] : []),
  ];
}

function committedLockError(receipt: QuotaDelegateLockReceipt, cleanupIssues: CleanupIssue[]) {
  const outcome: QuotaDelegateCommittedLockOutcome = {
    committed: true,
    receipt,
    cleanupErrors: cleanupIssues.map((issue) => issue.error),
    cleanupIssues,
    residualPaths: [...new Set(cleanupIssues.flatMap((issue) => [
      issue.path,
      ...reportedResidualPaths(issue.error),
    ]))],
  };
  return Object.assign(
    quotaDelegateError(
      "quota delegate lock was committed but post-commit cleanup failed",
      "QUOTA_DELEGATE_LOCK_COMMITTED_CLEANUP_FAILED",
    ),
    { outcome },
  );
}

export async function acquireQuotaDelegateLock(
  rawHubRoot: string,
  {
    ownerToken = randomUUID(),
    hooks,
    identityAlive = isProcessIdentityAlive,
  }: QuotaDelegateLockAcquireOptions = {},
): Promise<QuotaDelegateLockReceipt> {
  const hubRoot = normalizedHubRoot(rawHubRoot);
  await mkdir(delegateDir(hubRoot), { recursive: true });
  const identity = captureQuotaDelegateProcessIdentity();
  const lockOwnerToken = ownerToken || randomUUID();
  const receipt: QuotaDelegateLockReceipt = {
    pid: process.pid,
    hubRoot,
    startedAt: new Date().toISOString(),
    ownerToken: lockOwnerToken,
    generation: randomUUID(),
    processIdentity: identity,
    incarnation: identity.incarnation,
  };
  const tmpPath = lockTempFilePath(hubRoot);
  let claim: ActiveMutationClaim | null = null;
  let tempCreated = false;
  let tempAuthority: RegularFileAuthority | null = null;
  let cleanupTempAuthority: RegularFileAuthority | null = null;
  let committed = false;
  let primaryError: unknown = null;
  try {
    claim = await acquireMutationClaim(hubRoot, "acquire", null, identityAlive, hooks);
    await hooks?.afterMutationClaimAcquired?.({
      claimPath: lockClaimFilePath(hubRoot),
      purpose: "acquire",
      targetGeneration: null,
    });
    const existing = await readExistingLockCandidate(hubRoot);
    if (existing) {
      if (identityAlive(existing.receipt.processIdentity)) {
        throw quotaDelegateError("quota delegate already owns the live lock", "QUOTA_DELEGATE_ALREADY_RUNNING");
      }
      await hooks?.afterStaleLockObserved?.({ receipt: existing.receipt });
      await quarantineAndRemoveLock(hubRoot, existing, (movedReceipt) => {
        if (identityAlive(movedReceipt.processIdentity)) {
          throw quotaDelegateError("quota delegate already owns the live lock", "QUOTA_DELEGATE_ALREADY_RUNNING");
        }
      }, hooks);
    }
    tempAuthority = await writeDurableExclusive(tmpPath, JSON.stringify(receipt, null, 2) + "\n");
    tempCreated = true;
    await link(tmpPath, lockFilePath(hubRoot));
    committed = true;
    cleanupTempAuthority = await readFileAuthority(tmpPath, "quota delegate committed lock candidate");
    await hooks?.afterLockCommitted?.({
      receipt,
      tempPath: tmpPath,
      claimPath: lockClaimFilePath(hubRoot),
    });
  } catch (error) {
    primaryError = error;
  }

  const cleanupTasks: Array<{ operation: string; path: string; run: () => Promise<unknown> }> = [];
  if (tempCreated && tempAuthority) {
    cleanupTasks.push({
      operation: "remove pinned candidate",
      path: tmpPath,
      run: () => cleanupPinnedTemporary(
        cleanupTempAuthority || tempAuthority!,
        "quota delegate lock candidate",
      ),
    });
  }
  if (committed) {
    cleanupTasks.push({
      operation: "sync committed lock directory",
      path: lockFilePath(hubRoot),
      run: () => syncDirectory(delegateDir(hubRoot)),
    });
  }
  const cleanupIssues = await settleCleanup(cleanupTasks);
  if (claim) {
    cleanupIssues.push(...await settleCleanup([{
      operation: "release mutation claim",
      path: lockClaimFilePath(hubRoot),
      run: () => releaseMutationClaim(hubRoot, claim!, hooks),
    }]));
  }
  if (committed && (primaryError || cleanupIssues.length > 0)) {
    const issues = primaryError
      ? [{ operation: "post-commit hook", path: lockFilePath(hubRoot), error: asError(primaryError) }, ...cleanupIssues]
      : cleanupIssues;
    throw committedLockError(receipt, issues);
  }
  if (primaryError) throw operationError(primaryError, cleanupIssues);
  if (cleanupIssues.length > 0) throw cleanupIssues[0].error;
  return receipt;
}

export async function cleanupQuotaDelegateLock(
  rawHubRoot: string,
  receipt: QuotaDelegateLockReceipt,
  {
    hooks,
    identityAlive = isProcessIdentityAlive,
  }: QuotaDelegateLockOperationOptions = {},
): Promise<QuotaDelegateLockCleanupOutcome> {
  const hubRoot = normalizedHubRoot(rawHubRoot);
  parseLockReceipt(JSON.stringify(receipt), hubRoot);
  await mkdir(delegateDir(hubRoot), { recursive: true });
  let claim: ActiveMutationClaim | null = null;
  let primaryError: unknown = null;
  let removed = false;
  let status: QuotaDelegateLockCleanupOutcome["status"] = "missing";
  let currentGeneration: string | null = null;
  try {
    claim = await acquireMutationClaim(hubRoot, "cleanup", receipt.generation, identityAlive, hooks);
    await hooks?.afterMutationClaimAcquired?.({
      claimPath: lockClaimFilePath(hubRoot),
      purpose: "cleanup",
      targetGeneration: receipt.generation,
    });
    const current = await readExistingLockCandidate(hubRoot);
    currentGeneration = current?.receipt.generation || null;
    if (!current) {
      status = "missing";
    } else if (
      sameLockOwner(current.receipt, receipt)
    ) {
      await hooks?.afterOwnedLockObserved?.({ receipt: current.receipt });
      removed = await quarantineAndRemoveLock(hubRoot, current, undefined, hooks);
      status = removed ? "removed" : "missing";
    } else {
      status = "preserved";
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupIssues: CleanupIssue[] = [];
  if (claim) {
    cleanupIssues.push(...await settleCleanup([{
      operation: "release mutation claim",
      path: lockClaimFilePath(hubRoot),
      run: () => releaseMutationClaim(hubRoot, claim!, hooks),
    }]));
  }
  if (removed && cleanupIssues.length > 0) {
    throw Object.assign(
      quotaDelegateError(
        "quota delegate lock was removed but cleanup could not be fully verified",
        "QUOTA_DELEGATE_LOCK_REMOVED_CLEANUP_FAILED",
      ),
      {
        outcome: {
          status: "removed_cleanup_failed",
          expectedGeneration: receipt.generation,
          cleanupErrors: cleanupIssues.map((issue) => issue.error),
          cleanupIssues,
          residualPaths: [...new Set(cleanupIssues.flatMap((issue) => [
            issue.path,
            ...reportedResidualPaths(issue.error),
          ]))],
        },
      },
    );
  }
  if (primaryError) throw operationError(primaryError, cleanupIssues);
  if (cleanupIssues.length > 0) throw cleanupIssues[0].error;
  return { status, expectedGeneration: receipt.generation, currentGeneration };
}

export interface QuotaDelegateCommandHooks {
  beforeAckPublish?: (context: { ackPath: string; tempPath: string }) => void | Promise<void>;
  beforeCommandRemoval?: (context: { filePath: string; commandId: string }) => void | Promise<void>;
  afterCommandQuarantined?: (context: {
    filePath: string;
    quarantinePath: string;
    commandId: string;
  }) => void | Promise<void>;
  syncCommandRemovalDirectory?: (context: {
    directory: string;
    filePath: string;
    commandId: string;
  }) => void | Promise<void>;
}

interface QuotaDelegateCommandProcessOptions {
  hooks?: QuotaDelegateCommandHooks;
}

interface CommandTransaction {
  version: 1;
  hubRoot: string;
  commandId: string;
  mutationId: string;
  commandDigest: string;
  state: "executing" | "applied" | "failed";
  startedAt: string;
  updatedAt: string;
  ack: LooseRecord | null;
}

const SAFE_COMMAND_ID = /^[A-Za-z0-9._-]+$/;

function validateCommandId(value: unknown, field: string) {
  const id = stringValue(value);
  if (!id || !SAFE_COMMAND_ID.test(id)) {
    throw quotaDelegateError(`quota delegate command ${field} is invalid`, "QUOTA_DELEGATE_COMMAND_INVALID");
  }
  return id;
}

function commandDigest(raw: string) {
  return createHash("sha256").update(raw).digest("hex");
}

function commandInvalidFromPayloadError(error: unknown) {
  return Object.assign(
    quotaDelegateError(asError(error).message, "QUOTA_DELEGATE_COMMAND_INVALID"),
    { cause: error },
  );
}

function validateCommandPayload(command: LooseRecord, type: string) {
  if (type === "quota_write") {
    try {
      _internalValidateProviderUnavailableInput(command.providerKey, recordValue(command.entry));
    } catch (error) {
      throw commandInvalidFromPayloadError(error);
    }
    return;
  }
  if (type === "usage_write") {
    try {
      _internalValidateProviderUsageInput(command.record);
    } catch (error) {
      throw commandInvalidFromPayloadError(error);
    }
  }
}

async function atomicPublish(
  filePath: string,
  content: string,
  {
    exclusive = false,
    beforePublish,
  }: {
    exclusive?: boolean;
    beforePublish?: (context: { path: string; tempPath: string }) => void | Promise<void>;
  } = {},
) {
  const dirPath = path.dirname(filePath);
  await mkdir(dirPath, { recursive: true });
  await syncDirectory(dirPath);
  const tempPath = path.join(dirPath, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const tempAuthority = await writeDurableExclusive(tempPath, content);
  let cleanupTempAuthority = tempAuthority;
  const directoryAuthority = await readDirectoryAuthority(dirPath);
  let committed = false;
  let alreadyExists = false;
  let previousPath = "";
  let primaryError: unknown = null;
  try {
    await beforePublish?.({ path: filePath, tempPath });
    const currentTemp = await readFileAuthority(tempPath, "quota delegate atomic publication temp");
    if (!sameFileAuthority(tempAuthority, currentTemp)) {
      throw quotaDelegateError(
        "quota delegate atomic publication temp changed before publication",
        "QUOTA_DELEGATE_ATOMIC_TEMP_RACE",
      );
    }
    await repinDirectoryAuthority(directoryAuthority);
    if (exclusive) {
      try {
        await link(tempPath, filePath);
        committed = true;
        cleanupTempAuthority = await readFileAuthority(
          tempPath,
          "linked quota delegate atomic publication temp",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") alreadyExists = true;
        else throw error;
      }
    } else {
      let previous: RegularFileAuthority | null = null;
      try {
        previous = await readFileAuthority(filePath, "existing quota delegate publication");
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (previous) {
        previousPath = path.join(
          dirPath,
          `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.previous-recovery`,
        );
        const repinned = await readFileAuthority(filePath, "existing quota delegate publication");
        if (!sameFileAuthority(previous, repinned)) {
          throw quotaDelegateError(
            "existing quota delegate publication changed before isolation",
            "QUOTA_DELEGATE_ATOMIC_PUBLISH_CONFLICT",
          );
        }
        await rename(filePath, previousPath);
        await syncDirectory(dirPath);
        const moved = await readFileAuthority(previousPath, "isolated quota delegate publication");
        if (!sameFileAuthority(repinned, moved, { moved: true })) {
          throw Object.assign(quotaDelegateError(
            "existing quota delegate publication changed during isolation",
            "QUOTA_DELEGATE_ATOMIC_PUBLISH_CONFLICT",
          ), {
            committed: true,
            publicationCommitted: false,
            committedPath: previousPath,
            recoveryPaths: [filePath, previousPath, tempPath, dirPath],
          });
        }
      }
      try {
        await link(tempPath, filePath);
        committed = true;
        cleanupTempAuthority = await readFileAuthority(
          tempPath,
          "linked quota delegate atomic publication temp",
        );
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw Object.assign(quotaDelegateError(
            "quota delegate publication successor appeared; successor preserved",
            "QUOTA_DELEGATE_ATOMIC_PUBLISH_CONFLICT",
          ), {
            committed: previousPath.length > 0,
            publicationCommitted: false,
            committedPath: previousPath || null,
            recoveryPaths: [filePath, ...(previousPath ? [previousPath] : []), tempPath, dirPath],
          });
        }
        throw error;
      }
    }
    if (committed) await syncDirectory(dirPath);
  } catch (error) {
    primaryError = error;
  }

  const cleanupIssues = await settleCleanup([{
    operation: "remove pinned atomic temp",
    path: tempPath,
    run: () => cleanupPinnedTemporary(cleanupTempAuthority, "quota delegate atomic publication temp"),
  }]);
  if (committed && (primaryError || cleanupIssues.length > 0)) {
    const issues = primaryError
      ? [{ operation: "sync atomic publication", path: filePath, error: asError(primaryError) }, ...cleanupIssues]
      : cleanupIssues;
    throw Object.assign(
      quotaDelegateError("atomic publication committed but durability cleanup failed", "QUOTA_DELEGATE_ATOMIC_PUBLISH_COMMITTED"),
      {
        committed: true,
        committedPath: filePath,
        recoveryPaths: [filePath, ...(previousPath ? [previousPath] : []), tempPath, dirPath],
        cleanupIssues: issues,
        cleanupErrors: issues.map((issue) => issue.error),
      },
    );
  }
  if (primaryError) throw operationError(primaryError, cleanupIssues);
  if (cleanupIssues.length > 0) throw cleanupIssues[0].error;
  return { committed, alreadyExists, tempPath, previousPath: previousPath || null };
}

function parseCommandTransaction(raw: string, expectedHubRoot: string): CommandTransaction {
  const value = parseJsonRecord(raw, "quota delegate transaction", "QUOTA_DELEGATE_TRANSACTION_INVALID");
  const version = nullableNumber(value.version);
  const hubRoot = stringValue(value.hubRoot);
  const commandId = stringValue(value.commandId);
  const mutationId = stringValue(value.mutationId);
  const digest = stringValue(value.commandDigest);
  const state = stringValue(value.state);
  const startedAt = stringValue(value.startedAt);
  const updatedAt = stringValue(value.updatedAt);
  const ackIsRecord = value.ack !== null
    && typeof value.ack === "object"
    && !Array.isArray(value.ack);
  const ack = value.ack === null ? null : recordValue(value.ack);
  if (
    version !== 1
    || !hubRoot
    || normalizedHubRoot(hubRoot) !== normalizedHubRoot(expectedHubRoot)
    || !SAFE_COMMAND_ID.test(commandId)
    || !SAFE_COMMAND_ID.test(mutationId)
    || !/^[a-f0-9]{64}$/.test(digest)
    || (state !== "executing" && state !== "applied" && state !== "failed")
    || !canonicalIsoTimestamp(startedAt)
    || !canonicalIsoTimestamp(updatedAt)
    || (state === "executing" && value.ack !== null)
    || ((state === "applied" || state === "failed") && !ackIsRecord)
  ) {
    throw quotaDelegateError("quota delegate transaction receipt is invalid", "QUOTA_DELEGATE_TRANSACTION_INVALID");
  }
  return {
    version: 1,
    hubRoot: normalizedHubRoot(hubRoot),
    commandId,
    mutationId,
    commandDigest: digest,
    state,
    startedAt,
    updatedAt,
    ack,
  };
}

async function readCommandTransaction(hubRoot: string, mutationId: string) {
  return parseCommandTransaction(
    await readRegularFileNoFollow(
      transactionFilePath(hubRoot, mutationId),
      "quota delegate transaction",
      "QUOTA_DELEGATE_TRANSACTION_INVALID",
    ),
    hubRoot,
  );
}

async function createCommandTransaction(transaction: CommandTransaction) {
  const result = await atomicPublish(
    transactionFilePath(transaction.hubRoot, transaction.mutationId),
    JSON.stringify(transaction, null, 2) + "\n",
    { exclusive: true },
  );
  return result.committed;
}

async function updateCommandTransaction(transaction: CommandTransaction) {
  await atomicPublish(
    transactionFilePath(transaction.hubRoot, transaction.mutationId),
    JSON.stringify(transaction, null, 2) + "\n",
  );
}

async function writeAck(
  hubRoot: string,
  commandId: string,
  mutationId: string,
  ack: LooseRecord,
  hooks?: QuotaDelegateCommandHooks,
) {
  const ackPath = ackFilePath(hubRoot, commandId);
  await atomicPublish(ackPath, JSON.stringify({
    commandId,
    mutationId,
    hubRoot,
    ts: new Date().toISOString(),
    ...ack,
  }, null, 2) + "\n", {
    beforePublish: ({ tempPath }) => hooks?.beforeAckPublish?.({ ackPath, tempPath }),
  });
}

async function appliedEvidenceForCommand(
  hubRoot: string,
  command: LooseRecord,
  mutationId: string,
  digest: string,
): Promise<LooseRecord | null> {
  const type = stringValue(command.type);
  if (type === "quota_write") {
    const providerKey = stringValue(command.providerKey);
    if (!providerKey) return null;
    const quotas = await readProviderQuotas(hubRoot);
    const entry = quotas[providerKey];
    if (entry?.mutationId === mutationId && entry.commandDigest === digest) {
      return { ok: true, entry };
    }
    return null;
  }
  if (type === "usage_write") {
    const usage = await readProviderUsage(hubRoot);
    const applied = usage.find((entry) => (
      entry.mutationId === mutationId
      && entry.commandDigest === digest
    ));
    return applied ? { ok: true } : null;
  }
  return null;
}

async function applyCommandMutation(
  hubRoot: string,
  command: LooseRecord,
  mutationId: string,
  digest: string,
): Promise<LooseRecord> {
  try {
    const type = stringValue(command.type);
    if (type === "quota_write") {
      const providerKey = stringValue(command.providerKey);
      const entry = recordValue(command.entry);
      if (!providerKey) throw quotaDelegateError("quota_write command missing providerKey", "QUOTA_DELEGATE_COMMAND_INVALID");
      const updated = await _internalMarkProviderUnavailable(hubRoot, {
        providerKey,
        agent: stringValue(entry.agent, providerKey),
        variant: nullableString(entry.variant),
        status: stringValue(entry.status, "unknown"),
        nextEligibleAt: nullableNumber(entry.nextEligibleAt),
        source: stringValue(entry.source, "quota-delegate"),
        confidence: nullableNumber(entry.confidence) ?? 1,
        reason: stringValue(entry.reason),
        mutationId,
        commandDigest: digest,
      });
      return { ok: true, entry: updated };
    }
    if (type === "usage_write") {
      await _internalAppendUsageLine(hubRoot, {
        ...recordValue(command.record),
        mutationId,
        commandDigest: digest,
      });
      return { ok: true };
    }
    throw quotaDelegateError(`unknown delegate command type: ${type || "(missing)"}`, "QUOTA_DELEGATE_COMMAND_INVALID");
  } catch (error) {
    if (!isDeterministicMutationFailure(error)) throw error;
    return {
      ok: false,
      code: "QUOTA_DELEGATE_MUTATION_FAILED",
      error: asError(error).message,
    };
  }
}

async function removeCommandAfterAck(
  hubRoot: string,
  filePath: string,
  commandId: string,
  authority: RegularFileAuthority,
  hooks?: QuotaDelegateCommandHooks,
) {
  await hooks?.beforeCommandRemoval?.({ filePath, commandId });
  const directory = inboxDir(hubRoot);
  const quarantinePath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.processed-recovery`,
  );
  let current: RegularFileAuthority;
  try {
    current = await readFileAuthority(filePath, "quota delegate command", "QUOTA_DELEGATE_COMMAND_INVALID");
  } catch (error) {
    throw Object.assign(quotaDelegateError(
      "quota delegate command changed before removal; successor preserved",
      "QUOTA_DELEGATE_COMMAND_RACE",
    ), {
      cause: error,
      committed: false,
      recoveryPaths: [filePath, directory],
      commandId,
    });
  }
  if (!sameFileAuthority(authority, current)) {
    throw Object.assign(quotaDelegateError(
      "quota delegate command changed before removal; successor preserved",
      "QUOTA_DELEGATE_COMMAND_RACE",
    ), {
      committed: false,
      recoveryPaths: [filePath, directory],
      commandId,
    });
  }
  let isolated = false;
  let postRenameDirectory: DirectoryAuthority | null = null;
  try {
    await rename(filePath, quarantinePath);
    isolated = true;
    postRenameDirectory = await readDirectoryAuthority(directory);
    await hooks?.syncCommandRemovalDirectory?.({ directory, filePath, commandId });
    const retainedDirectory = await readDirectoryAuthority(directory);
    if (!sameDirectoryIdentity(postRenameDirectory, retainedDirectory)) {
      throw quotaDelegateError(
        "quota delegate command directory changed after removal isolation",
        "QUOTA_DELEGATE_DIRECTORY_UNSAFE",
      );
    }
    await syncDirectory(directory);
  } catch (error) {
    if (!isolated) {
      throw Object.assign(asError(error), {
        committed: false,
        removalCommitted: false,
        committedPath: null,
        recoveryPaths: [filePath, directory],
        commandId,
      });
    }
    const primaryError = asError(error);
    const cleanupErrors = error && typeof error === "object" && "cleanupErrors" in error
      && Array.isArray((error as { cleanupErrors?: unknown }).cleanupErrors)
      ? (error as { cleanupErrors: Error[] }).cleanupErrors
      : [];
    const preservation = await inspectCommandRemovalState(
      directory,
      postRenameDirectory,
      filePath,
      quarantinePath,
    );
    const inspectionErrors = preservation.issues.map((issue) => issue.error);
    const quarantinePreserved = preservation.quarantineState === "unavailable"
      ? null
      : preservation.quarantineState === "regular-file";
    const successorPreserved = preservation.canonicalState === "unavailable"
      ? null
      : preservation.canonicalState === "regular-file";
    throw Object.assign(
      new AggregateError(
        [primaryError, ...cleanupErrors, ...inspectionErrors],
        primaryError.message,
        { cause: primaryError },
      ),
      {
        code: "QUOTA_DELEGATE_COMMAND_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS",
        primaryError,
        cleanupErrors: [...cleanupErrors, ...inspectionErrors],
        inspectionIssues: preservation.issues,
        committed: true,
        renameCommitted: true,
        removalCommitted: false,
        committedPath: quarantinePreserved === true ? quarantinePath : null,
        quarantinePreserved,
        successorPreserved,
        preservation: {
          directoryTrusted: preservation.directoryTrusted,
          canonicalState: preservation.canonicalState,
          quarantineState: preservation.quarantineState,
        },
        recoveryPaths: [filePath, quarantinePath, directory],
        residualPaths: [
          ...(["regular-file", "other"].includes(preservation.canonicalState) ? [filePath] : []),
          ...(["regular-file", "other"].includes(preservation.quarantineState) ? [quarantinePath] : []),
        ],
        commandId,
      },
    );
  }
  try {
    const moved = await readFileAuthority(
      quarantinePath,
      "quarantined quota delegate command",
      "QUOTA_DELEGATE_COMMAND_INVALID",
    );
    if (!sameFileAuthority(current, moved, { moved: true })) {
      throw quotaDelegateError(
        "quota delegate command changed during removal isolation",
        "QUOTA_DELEGATE_COMMAND_RACE",
      );
    }
    await hooks?.afterCommandQuarantined?.({ filePath, quarantinePath, commandId });
    const retained = await readFileAuthority(
      quarantinePath,
      "quarantined quota delegate command",
      "QUOTA_DELEGATE_COMMAND_INVALID",
    );
    if (!sameFileAuthority(moved, retained)) {
      throw quotaDelegateError(
        "quota delegate command changed after removal validation",
        "QUOTA_DELEGATE_COMMAND_RACE",
      );
    }
  } catch (error) {
    const preservation = await inspectCommandRemovalState(
      directory,
      postRenameDirectory,
      filePath,
      quarantinePath,
    );
    const primaryError = asError(error);
    const inspectionErrors = preservation.issues.map((issue) => issue.error);
    const quarantinePreserved = preservation.quarantineState === "unavailable"
      ? null
      : preservation.quarantineState === "regular-file";
    const successorPreserved = preservation.canonicalState === "unavailable"
      ? null
      : preservation.canonicalState === "regular-file";
    throw Object.assign(asError(error), {
      code: errorCode(error) || "QUOTA_DELEGATE_COMMAND_RACE",
      primaryError,
      cleanupErrors: inspectionErrors,
      inspectionIssues: preservation.issues,
      committed: true,
      renameCommitted: true,
      removalCommitted: false,
      committedPath: quarantinePreserved === true ? quarantinePath : null,
      quarantinePreserved,
      successorPreserved,
      preservation: {
        directoryTrusted: preservation.directoryTrusted,
        canonicalState: preservation.canonicalState,
        quarantineState: preservation.quarantineState,
      },
      recoveryPaths: [filePath, quarantinePath, directory],
      residualPaths: [
        ...(["regular-file", "other"].includes(preservation.canonicalState) ? [filePath] : []),
        ...(["regular-file", "other"].includes(preservation.quarantineState) ? [quarantinePath] : []),
      ],
      commandId,
    });
  }
}

async function recordCommandFailure(
  hubRoot: string,
  filePath: string,
  commandId: string,
  mutationId: string,
  code: string,
  error: unknown,
  authority: RegularFileAuthority,
  hooks?: QuotaDelegateCommandHooks,
  digest?: string,
) {
  await writeAck(hubRoot, commandId, mutationId, {
    ok: false,
    code,
    error: asError(error).message,
    ...(digest ? { commandDigest: digest } : {}),
  }, hooks);
  await removeCommandAfterAck(hubRoot, filePath, commandId, authority, hooks);
}

async function replayCommandTransaction(
  hubRoot: string,
  filePath: string,
  transaction: CommandTransaction,
  command: LooseRecord,
  authority: RegularFileAuthority,
  hooks?: QuotaDelegateCommandHooks,
) {
  let ack = transaction.ack;
  if (transaction.state === "executing") {
    ack = await appliedEvidenceForCommand(
      hubRoot,
      command,
      transaction.mutationId,
      transaction.commandDigest,
    );
    if (!ack) {
      ack = await applyCommandMutation(hubRoot, command, transaction.mutationId, transaction.commandDigest);
    }
    transaction.state = ack.ok === true ? "applied" : "failed";
    transaction.ack = ack;
    transaction.updatedAt = new Date().toISOString();
    await updateCommandTransaction(transaction);
  }
  if (!ack) {
    throw quotaDelegateError("quota delegate transaction lacks durable ack", "QUOTA_DELEGATE_TRANSACTION_INVALID");
  }
  await writeAck(hubRoot, transaction.commandId, transaction.mutationId, ack, hooks);
  await removeCommandAfterAck(hubRoot, filePath, transaction.commandId, authority, hooks);
}

async function processCommand(
  hubRoot: string,
  filePath: string,
  { hooks }: QuotaDelegateCommandProcessOptions = {},
) {
  const fileCommandId = path.basename(filePath, ".json");
  let observed: Awaited<ReturnType<typeof readRegularFileNoFollowWithGeneration>>;
  try {
    observed = await readRegularFileNoFollowWithGeneration(
      filePath,
      "quota delegate command",
      "QUOTA_DELEGATE_COMMAND_INVALID",
      MAX_CONTROL_FILE_BYTES,
      "QUOTA_DELEGATE_COMMAND_READ_RACE",
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "QUOTA_DELEGATE_COMMAND_READ_RACE") return;
    throw error;
  }
  const raw = observed.content;
  const authority = observed.authority;
  // Client publication uses a no-clobber hard link. Until its private link is
  // isolated and removed, the shared inode still has nlink > 1 and its ctime
  // is expected to change. Defer rather than processing an authority that is
  // not yet stable enough for the later full-generation removal check.
  if (observed.linkCount !== 1) return;
  let command: LooseRecord;
  try {
    command = recordValue(JSON.parse(raw));
  } catch (error) {
    await recordCommandFailure(
      hubRoot,
      filePath,
      fileCommandId,
      fileCommandId,
      "QUOTA_DELEGATE_COMMAND_MALFORMED",
      error,
      authority,
      hooks,
      commandDigest(raw),
    );
    return;
  }

  let commandId: string;
  let mutationId: string;
  let type: string;
  try {
    commandId = validateCommandId(command.commandId, "commandId");
    mutationId = validateCommandId(command.mutationId, "mutationId");
    type = stringValue(command.type);
    if (commandId !== fileCommandId) {
      throw quotaDelegateError("quota delegate commandId does not match its filename", "QUOTA_DELEGATE_COMMAND_INVALID");
    }
    if (type !== "quota_write" && type !== "usage_write") {
      throw quotaDelegateError(`unknown delegate command type: ${type || "(missing)"}`, "QUOTA_DELEGATE_COMMAND_INVALID");
    }
    validateCommandPayload(command, type);
  } catch (error) {
    await recordCommandFailure(
      hubRoot,
      filePath,
      fileCommandId,
      stringValue(command.mutationId, fileCommandId),
      (error as NodeJS.ErrnoException).code || "QUOTA_DELEGATE_COMMAND_INVALID",
      error,
      authority,
      hooks,
      commandDigest(raw),
    );
    return;
  }

  const digest = commandDigest(raw);
  const now = new Date().toISOString();
  const transaction: CommandTransaction = {
    version: 1,
    hubRoot,
    commandId,
    mutationId,
    commandDigest: digest,
    state: "executing",
    startedAt: now,
    updatedAt: now,
    ack: null,
  };
  const created = await createCommandTransaction(transaction);
  if (!created) {
    const existing = await readCommandTransaction(hubRoot, mutationId);
    if (existing.commandId !== commandId || existing.commandDigest !== digest) {
      throw quotaDelegateError(
        "quota delegate mutationId was reused for different command content",
        "QUOTA_DELEGATE_MUTATION_ID_CONFLICT",
      );
    }
    await replayCommandTransaction(hubRoot, filePath, existing, command, authority, hooks);
    return;
  }

  const ack = await applyCommandMutation(hubRoot, command, mutationId, digest);
  transaction.state = ack.ok === true ? "applied" : "failed";
  transaction.ack = ack;
  transaction.updatedAt = new Date().toISOString();
  await updateCommandTransaction(transaction);
  await writeAck(hubRoot, commandId, mutationId, ack, hooks);
  await removeCommandAfterAck(hubRoot, filePath, commandId, authority, hooks);
}

export async function processQuotaDelegateInbox(
  rawHubRoot: string,
  options: QuotaDelegateCommandProcessOptions = {},
) {
  const hubRoot = normalizedHubRoot(rawHubRoot);
  await mkdir(inboxDir(hubRoot), { recursive: true });
  const entries = await readdir(inboxDir(hubRoot));
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json") || entry.includes(".tmp-")) continue;
    await processCommand(hubRoot, path.join(inboxDir(hubRoot), entry), options);
  }
}

export async function runQuotaDelegate(
  rawHubRoot: string,
  {
    ownerToken,
    hooks,
    identityAlive,
  }: QuotaDelegateLockAcquireOptions = {},
) {
  const hubRoot = normalizedHubRoot(rawHubRoot);
  let lockReceipt: QuotaDelegateLockReceipt;
  try {
    lockReceipt = await acquireQuotaDelegateLock(hubRoot, { ownerToken, hooks, identityAlive });
  } catch (error) {
    const outcome = (error as { outcome?: QuotaDelegateCommittedLockOutcome }).outcome;
    if (!outcome?.committed) throw error;

    const rollbackResults = await Promise.allSettled([
      cleanupQuotaDelegateLock(hubRoot, outcome.receipt, { identityAlive }),
    ]);
    const rollbackErrors = rollbackResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => asError(result.reason));
    let residualLock: QuotaDelegateLockReceipt | null = null;
    let residualCheckError: Error | null = null;
    try {
      residualLock = await readExistingLock(hubRoot);
    } catch (readError) {
      residualCheckError = asError(readError);
    }
    console.error(JSON.stringify({
      level: "error",
      code: "QUOTA_DELEGATE_LOCK_COMMITTED_CLEANUP_FAILED",
      message: "quota delegate will not start because lock publication cleanup failed",
      generation: outcome.receipt.generation,
      residualPaths: outcome.residualPaths,
      residualLockGeneration: residualLock?.generation || null,
      residualCheckError: residualCheckError?.message || null,
    }));
    const primary = asError(error);
    const secondary = [...rollbackErrors, ...(residualCheckError ? [residualCheckError] : [])];
    throw Object.assign(
      new AggregateError([primary, ...secondary], primary.message, { cause: primary }),
      {
        code: (primary as NodeJS.ErrnoException).code,
        primaryError: primary,
        committedOutcome: outcome,
        rollbackErrors,
        residualLock,
        residualCheckError,
      },
    );
  }
  console.log(`quota-delegate: started pid=${process.pid} incarnation=${lockReceipt.incarnation} generation=${lockReceipt.generation} hubRoot=${hubRoot}`);

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  let primaryError: unknown = null;
  try {
    while (!stopping) {
      await processQuotaDelegateInbox(hubRoot);
      await sleep(POLL_MS);
    }
  } catch (error) {
    primaryError = error;
  }
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  const cleanupResults = await Promise.allSettled([cleanupQuotaDelegateLock(hubRoot, lockReceipt, { identityAlive })]);
  const cleanupErrors = cleanupResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => asError(result.reason));
  if (primaryError) {
    const primary = asError(primaryError);
    if (cleanupErrors.length === 0) throw primary;
    throw Object.assign(
      new AggregateError([primary, ...cleanupErrors], primary.message, { cause: primary }),
      { code: (primary as NodeJS.ErrnoException).code, primaryError: primary, cleanupErrors },
    );
  }
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
  console.log("quota-delegate: stopped");
}

async function main() {
  const rawHubRoot = argValue(process.argv, "--hub-root") || process.env.CPB_HUB_ROOT || "";
  const ownerToken = argValue(process.argv, "--owner-token") || process.env.CPB_DELEGATE_OWNER_TOKEN || undefined;
  if (!rawHubRoot) {
    throw new Error("quota delegate requires --hub-root or CPB_HUB_ROOT");
  }
  const hubRoot = path.resolve(rawHubRoot);
  await assertHubWritable(hubRoot);
  await runQuotaDelegate(hubRoot, { ownerToken });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
