import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { LooseRecord } from "../../shared/types.js";
import { writeJsonAtomic } from "../../shared/fs-utils.js";
import {
  openPinnedHubRedisStateBackend,
  type HubRedisStateBackend,
  type RedisLeaderStatus,
} from "../../shared/hub-state-redis.js";
import { processLeaderFence, registerProcessLeaderFence } from "../../shared/hub-leader-fence.js";
import { readBoundedRegularFileNoFollow } from "../../core/runtime/durable-directory-lock.js";
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  killTree,
  sameProcessIdentity,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../../core/runtime/process-tree.js";

const DEFAULT_TTL_MS = 60_000;
const RENEW_INTERVAL_MS = 20_000;
const LEADER_STATE_MAX_BYTES = 64 * 1024;
const RECOVERY_FENCE_READY_TIMEOUT_MS = 15_000;
const RECOVERY_FENCE_CLOSE_GRACE_MS = 100;
const RECOVERY_FENCE_TERM_GRACE_MS = 250;
const RECOVERY_FENCE_FORCE_VERIFY_MS = 1_000;
const SAFE_START_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;

type AcquisitionReceipt = {
  hubId: string;
  host: string;
  pid: number;
  processIdentity: ProcessIdentity;
  lockToken: string;
  createdAt: string;
};

type ReadyReceipt = AcquisitionReceipt & {
  epoch: number;
  readyAt: string;
};

type RecoveryFenceLease = {
  assertHeld: () => void;
  release: () => Promise<void>;
};

type RecoveryFenceCloseRecord = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
};

type RecoveryFenceRuntimeOptions = {
  /** Test seam for identity observation and signaling. */
  processTreeSystem?: ProcessTreeSystem;
  /** Test seam for keeping the helper alive past stdin closure. */
  helperCloseDelayMs?: number;
  closeGraceMs?: number;
  termGraceMs?: number;
  forceVerifyMs?: number;
};

type DirectoryGeneration = {
  dev: bigint | number;
  ino: bigint | number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type LeaderLockTestHooks = {
  resolveDirectoryOpenFlags?: (context: { directory: string }) => number | undefined;
  beforeDirectorySync?: (context: { directory: string }) => void | Promise<void>;
  afterLeaderTempWritten?: (context: {
    tempPath: string;
    leaderFile: string;
    lockDir: string;
  }) => void | Promise<void>;
  afterLeaderOwnerValidated?: (context: {
    phase: "guarded-write";
    tempPath: string;
    leaderFile: string;
    lockDir: string;
  }) => void | Promise<void>;
};

const leaderLockTestHookStorage = new AsyncLocalStorage<Readonly<LeaderLockTestHooks>>();

export async function withLeaderLockTestHooks<T>(
  hooks: LeaderLockTestHooks,
  operation: () => Promise<T>,
): Promise<T> {
  return leaderLockTestHookStorage.run(Object.freeze({ ...hooks }), operation);
}

function leaderLockTestHooks() {
  return leaderLockTestHookStorage.getStore();
}

function dateInput(value: unknown): string | number | Date | null {
  if (typeof value === "string" || typeof value === "number" || value instanceof Date) return value;
  return null;
}

function numericPid(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

function noFollowFlag(file: string, code: string) {
  if (typeof fsConstants.O_NOFOLLOW !== "number" || fsConstants.O_NOFOLLOW === 0) {
    throw leaderLockError(`no-follow file opens are unavailable for leader lock path: ${file}`, code);
  }
  return fsConstants.O_NOFOLLOW;
}

function noFollowCreateExclusiveWriteFlags(file: string, code: string) {
  return fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | noFollowFlag(file, code);
}

async function syncDirectory(directory: string) {
  const flags = strictDirectoryOpenFlags(directory);
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw leaderLockError(`unsafe leader directory sync target: ${directory}`, "HUB_LEADER_DIRECTORY_UNSAFE");
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(directory, flags);
  } catch (error) {
    throw leaderLockError(
      `leader directory sync target could not be opened safely: ${directory}`,
      "HUB_LEADER_DIRECTORY_UNSAFE",
      error,
    );
  }
  let primaryError: unknown;
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || !sameDirectoryGeneration(directoryGenerationFromStats(before), directoryGenerationFromStats(opened))) {
      throw leaderLockError(`leader directory sync target changed while opening: ${directory}`, "HUB_LEADER_DIRECTORY_UNSAFE");
    }
    await leaderLockTestHooks()?.beforeDirectorySync?.({ directory });
    await handle.sync();
    const afterDescriptor = await handle.stat();
    const afterPath = await lstat(directory);
    if (
      !afterDescriptor.isDirectory()
      || !afterPath.isDirectory()
      || afterPath.isSymbolicLink()
      || !sameDirectoryGeneration(directoryGenerationFromStats(opened), directoryGenerationFromStats(afterDescriptor))
      || !sameDirectoryGeneration(directoryGenerationFromStats(opened), directoryGenerationFromStats(afterPath))
    ) {
      throw leaderLockError(`leader directory sync target changed during sync: ${directory}`, "HUB_LEADER_DIRECTORY_UNSAFE");
    }
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw new AggregateError([primaryError, closeError], `leader directory sync and close failed: ${directory}`, {
      cause: primaryError,
    });
  }
  if (closeError) throw closeError;
}

async function directoryGeneration(directory: string): Promise<DirectoryGeneration> {
  const flags = strictDirectoryOpenFlags(directory);
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw leaderLockError(`unsafe leader lock directory: ${directory}`, "HUB_LEADER_DIRECTORY_UNSAFE");
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(directory, flags);
  } catch (error) {
    throw leaderLockError(`unsafe leader lock directory: ${directory}`, "HUB_LEADER_DIRECTORY_UNSAFE", error);
  }
  let primaryError: unknown;
  let generation: DirectoryGeneration | null = null;
  try {
    const opened = await handle.stat();
    const afterPath = await lstat(directory);
    if (
      !opened.isDirectory()
      || !afterPath.isDirectory()
      || afterPath.isSymbolicLink()
      || !sameDirectoryGeneration(directoryGenerationFromStats(before), directoryGenerationFromStats(opened))
      || !sameDirectoryGeneration(directoryGenerationFromStats(opened), directoryGenerationFromStats(afterPath))
    ) {
      throw leaderLockError(`leader lock directory changed while opening: ${directory}`, "HUB_LEADER_DIRECTORY_UNSAFE");
    }
    generation = directoryGenerationFromStats(opened);
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError) {
    if (!closeError) throw primaryError;
    throw new AggregateError([primaryError, closeError], `leader directory generation and close failed: ${directory}`, {
      cause: primaryError,
    });
  }
  if (closeError) throw closeError;
  if (!generation) {
    throw leaderLockError(`leader lock directory generation unavailable: ${directory}`, "HUB_LEADER_DIRECTORY_UNSAFE");
  }
  return generation;
}

function strictDirectoryOpenFlags(directory: string) {
  if (
    typeof fsConstants.O_NOFOLLOW !== "number"
    || fsConstants.O_NOFOLLOW === 0
    || typeof fsConstants.O_DIRECTORY !== "number"
    || fsConstants.O_DIRECTORY === 0
  ) {
    throw leaderLockError(`strict directory opens are unavailable: ${directory}`, "HUB_LEADER_DIRECTORY_UNSAFE");
  }
  const flags = leaderLockTestHooks()?.resolveDirectoryOpenFlags?.({ directory })
    ?? (fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY);
  if (
    (flags & fsConstants.O_NOFOLLOW) !== fsConstants.O_NOFOLLOW
    || (flags & fsConstants.O_DIRECTORY) !== fsConstants.O_DIRECTORY
  ) {
    throw leaderLockError(`strict directory open flags are required: ${directory}`, "HUB_LEADER_DIRECTORY_UNSAFE");
  }
  return flags;
}

function directoryGenerationFromStats(info: {
  dev: bigint | number;
  ino: bigint | number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}): DirectoryGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function sameDirectoryGeneration(left: DirectoryGeneration, right: DirectoryGeneration) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameDirectoryGenerationAcrossRename(left: DirectoryGeneration, right: DirectoryGeneration) {
  return String(left.dev) === String(right.dev)
    && String(right.ino) === String(left.ino)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function leaderLockError(message: string, code: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function committedLeaderWriteError(
  message: string,
  code: string,
  committedPath: string,
  cause: unknown,
  extraRecoveryPaths: Record<string, string> = {},
) {
  return Object.assign(leaderLockError(message, code, cause), {
    committed: true,
    committedPath,
    recoveryPaths: { committedPath, ...extraRecoveryPaths },
  });
}

async function preserveExistingPathAsQuarantine(
  source: string,
  quarantineDir: string,
  prefix: string,
) {
  try {
    await lstat(source);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  await mkdir(quarantineDir, { recursive: true });
  const target = path.join(quarantineDir, `${prefix}-${Date.now()}-${randomUUID()}`);
  try {
    await rename(source, target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  await syncDirectory(path.dirname(source));
  await syncDirectory(quarantineDir);
  return target;
}

function isCommittedAmbiguousWrite(error: unknown) {
  return Boolean(
    error
    && typeof error === "object"
    && (
      (error as { committed?: unknown }).committed === true
      || (error as { renameCommitted?: unknown }).renameCommitted === true
    ),
  );
}

function validIsoDate(value: unknown) {
  if (typeof value !== "string" || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function requiredBoundedString(value: unknown, maxLength = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function parseProcessIdentity(value: unknown): ProcessIdentity | null {
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
    || !requiredBoundedString(birthId, 1_024)
    || incarnation !== `${pid}:${birthId}`
    || !validIsoDate(capturedAt)
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

function exactProcessIdentity(
  identity: ProcessIdentity | null,
  expectedPid?: number,
): ProcessIdentity | null {
  if (!identity || identity.birthIdPrecision !== "exact") return null;
  const exact = parseProcessIdentity(identity);
  if (!exact || (expectedPid !== undefined && exact.pid !== expectedPid)) return null;
  return exact;
}

function captureCurrentExactProcessIdentity() {
  return exactProcessIdentity(captureProcessIdentity(process.pid, { strict: true }), process.pid);
}

async function captureExactProcessIdentityAfterSpawn(
  pid: number,
  system?: ProcessTreeSystem,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const identity = exactProcessIdentity(captureProcessIdentity(pid, {
        strict: true,
        ...(system ? { system } : {}),
      }), pid);
      if (identity) return identity;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref();
    });
  }
  if (lastError) throw lastError;
  return null;
}

async function readBoundedRegularJson(file: string): Promise<LooseRecord | null> {
  try {
    const raw = await readBoundedRegularFileNoFollow(file, { maxBytes: LEADER_STATE_MAX_BYTES });
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw leaderLockError(`leader state is not a JSON object: ${file}`, "HUB_LEADER_STATE_INVALID");
    }
    return parsed as LooseRecord;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (errorCode(error) === "BOUNDED_FILE_TOO_LARGE") {
      throw leaderLockError(`leader state too large: ${file}`, "HUB_LEADER_STATE_TOO_LARGE", error);
    }
    if (errorCode(error) === "BOUNDED_FILE_CHANGED") {
      throw leaderLockError(`leader state changed while it was read: ${file}`, "HUB_LEADER_STATE_UNSTABLE", error);
    }
    if (String(errorCode(error)).startsWith("BOUNDED_FILE_") || ["ELOOP", "EMLINK"].includes(errorCode(error))) {
      throw leaderLockError(`unsafe leader state symlink or non-regular path: ${file}`, "HUB_LEADER_STATE_UNSAFE", error);
    }
    throw error;
  }
}

function validateLeaderRecord(raw: LooseRecord | null, file: string): LooseRecord | null {
  if (!raw) return null;
  const pid = numericPid(raw.pid);
  const identity = parseProcessIdentity(raw.processIdentity);
  const epoch = Number(raw.epoch);
  if (
    !requiredBoundedString(raw.hubId)
    || !requiredBoundedString(raw.host)
    || !pid
    || !identity
    || identity.pid !== pid
    || !Number.isSafeInteger(epoch)
    || epoch < 0
    || !requiredBoundedString(raw.lockToken)
    || typeof raw.initializing !== "boolean"
    || !validIsoDate(raw.startedAt)
    || !validIsoDate(raw.heartbeatAt)
    || !validIsoDate(raw.expiresAt)
    || (raw.releasedAt !== undefined && !validIsoDate(raw.releasedAt))
    || (raw.ready !== undefined && typeof raw.ready !== "boolean")
    || (raw.ready === true && !validIsoDate(raw.readyAt))
    || (raw.ready !== true && raw.readyAt !== undefined)
  ) {
    throw leaderLockError(`invalid leader state: ${file}`, "HUB_LEADER_STATE_INVALID");
  }
  return raw;
}

function validateReadyReceipt(raw: LooseRecord | null, file: string): ReadyReceipt | null {
  if (!raw) return null;
  const owner = validateAcquisitionReceipt(raw, file);
  const epoch = Number(raw.epoch);
  if (!owner || !Number.isSafeInteger(epoch) || epoch <= 0 || !validIsoDate(raw.readyAt)) {
    throw leaderLockError(`invalid leader readiness receipt: ${file}`, "HUB_LEADER_READY_INVALID");
  }
  return {
    ...owner,
    epoch,
    readyAt: String(raw.readyAt),
  };
}

function validateAcquisitionReceipt(raw: LooseRecord | null, file: string): AcquisitionReceipt | null {
  if (!raw) return null;
  const pid = numericPid(raw.pid);
  const identity = parseProcessIdentity(raw.processIdentity);
  if (
    !requiredBoundedString(raw.hubId)
    || !requiredBoundedString(raw.host)
    || !pid
    || !identity
    || identity.pid !== pid
    || !requiredBoundedString(raw.lockToken)
    || !validIsoDate(raw.createdAt)
  ) {
    throw leaderLockError(`invalid leader acquisition receipt: ${file}`, "HUB_LEADER_ACQUISITION_INVALID");
  }
  return {
    hubId: String(raw.hubId),
    host: String(raw.host),
    pid,
    processIdentity: identity,
    lockToken: String(raw.lockToken),
    createdAt: String(raw.createdAt),
  };
}

type OwnerIdentityLike = {
  hubId?: unknown;
  host?: unknown;
  pid?: unknown;
  processIdentity?: unknown;
  lockToken?: unknown;
};

function sameOwnerIdentity(left: OwnerIdentityLike, right: OwnerIdentityLike) {
  const leftPid = numericPid(left.pid);
  const rightPid = numericPid(right.pid);
  const leftIdentity = parseProcessIdentity(left.processIdentity);
  const rightIdentity = parseProcessIdentity(right.processIdentity);
  return requiredBoundedString(left.hubId)
    && requiredBoundedString(right.hubId)
    && left.hubId === right.hubId
    && left.host === right.host
    && leftPid !== null
    && leftPid === rightPid
    && left.lockToken === right.lockToken
    && sameProcessIdentity(leftIdentity, rightIdentity);
}

function leaderOwner(record: LooseRecord): AcquisitionReceipt {
  const processIdentity = parseProcessIdentity(record.processIdentity);
  if (!processIdentity) {
    throw leaderLockError("leader state has no valid process identity", "HUB_LEADER_STATE_INVALID");
  }
  return {
    hubId: String(record.hubId),
    host: String(record.host),
    pid: Number(record.pid),
    processIdentity,
    lockToken: String(record.lockToken),
    createdAt: String(record.startedAt),
  };
}

function currentLeaderOwner(hubId: string, lockToken: string): AcquisitionReceipt | null {
  const processIdentity = captureCurrentExactProcessIdentity();
  if (!processIdentity) return null;
  return {
    hubId,
    host: os.hostname(),
    pid: process.pid,
    processIdentity,
    lockToken,
    createdAt: processIdentity.capturedAt,
  };
}

function readyReceiptPath(hubRoot: string, lockToken: string) {
  const generation = createHash("sha256").update(lockToken).digest("hex").slice(0, 32);
  return path.join(path.resolve(hubRoot), "orchestrator", `leader.ready-${generation}.json`);
}

function readyReceiptMatches(
  receipt: ReadyReceipt | null,
  leader: LooseRecord | RedisLeaderStatus | ReadyReceipt,
) {
  if (!receipt) return false;
  const identity = parseProcessIdentity("processIdentity" in leader ? leader.processIdentity : undefined);
  return receipt.hubId === leader.hubId
    && receipt.host === leader.host
    && receipt.pid === leader.pid
    && receipt.lockToken === leader.lockToken
    && receipt.epoch === Number(leader.epoch)
    && (!identity || sameProcessIdentity(receipt.processIdentity, identity));
}

function recoveryFenceCommand(helperCloseDelayMs = 0) {
  if (process.platform === "darwin") {
    return {
      command: "/usr/bin/python3",
      args: ["-c", recoveryFencePythonHelperSource(helperCloseDelayMs)],
      contentionExitCodes: new Set([75]),
    };
  }
  if (process.platform === "freebsd" || process.platform === "openbsd") {
    return {
      command: "/usr/bin/lockf",
      args: ["-s", "-t", "0", "/dev/fd/3", process.execPath, "-e", recoveryFenceHelperSource(helperCloseDelayMs)],
      contentionExitCodes: new Set([75]),
    };
  }
  if (process.platform === "linux") {
    return {
      command: "/usr/bin/flock",
      args: ["--exclusive", "--nonblock", "3", process.execPath, "-e", recoveryFenceHelperSource(helperCloseDelayMs)],
      contentionExitCodes: new Set([1]),
    };
  }
  throw leaderLockError(
    `local leader recovery fencing is unavailable on ${process.platform}`,
    "HUB_LEADER_RECOVERY_FENCE_UNAVAILABLE",
  );
}

function recoveryFenceHelperSource(closeDelayMs = 0) {
  return [
    "process.stdout.write('CPB_LEADER_RECOVERY_FENCE_READY\\n');",
    "process.stdin.resume();",
    `process.stdin.once('end', () => setTimeout(() => process.exit(0), ${closeDelayMs}));`,
    "process.stdin.once('error', () => process.exit(1));",
  ].join("");
}

function recoveryFencePythonHelperSource(closeDelayMs = 0) {
  return [
    "import fcntl",
    "import sys",
    "import time",
    "try:",
    "    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)",
    "except BlockingIOError:",
    "    sys.exit(75)",
    "except OSError:",
    "    sys.exit(1)",
    "sys.stdout.write('CPB_LEADER_RECOVERY_FENCE_READY\\n')",
    "sys.stdout.flush()",
    "try:",
    "    sys.stdin.buffer.read()",
    "except Exception:",
    "    sys.exit(1)",
    `time.sleep(${closeDelayMs} / 1000)`,
  ].join("\n");
}

function recoveryFenceDuration(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.trunc(Number(value)) : fallback;
}

function monitorRecoveryFenceHolder(holder: ChildProcessWithoutNullStreams) {
  let processError: Error | null = null;
  holder.once("error", (error) => {
    processError = error;
  });
  return new Promise<RecoveryFenceCloseRecord>((resolve) => {
    holder.once("close", (code, signal) => resolve({ code, signal, error: processError }));
  });
}

async function waitForRecoveryFenceClose(
  closePromise: Promise<RecoveryFenceCloseRecord>,
  timeoutMs: number,
) {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      closePromise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeRecoveryFenceHolder(
  holder: ChildProcessWithoutNullStreams,
  closePromise: Promise<RecoveryFenceCloseRecord>,
  identity: ProcessIdentity | null,
  options: RecoveryFenceRuntimeOptions = {},
) {
  const errors: unknown[] = [];
  const closeGraceMs = recoveryFenceDuration(options.closeGraceMs, RECOVERY_FENCE_CLOSE_GRACE_MS);
  const termGraceMs = recoveryFenceDuration(options.termGraceMs, RECOVERY_FENCE_TERM_GRACE_MS);
  const forceVerifyMs = recoveryFenceDuration(options.forceVerifyMs, RECOVERY_FENCE_FORCE_VERIFY_MS);
  let stdinError: Error | null = null;
  const onStdinError = (error: Error) => {
    stdinError = error;
  };
  holder.stdin.once("error", onStdinError);
  try {
    holder.stdin.end();
  } catch (error) {
    errors.push(error);
  }

  let closeRecord = await waitForRecoveryFenceClose(closePromise, closeGraceMs);
  if (!closeRecord && identity) {
    try {
      await killTree(identity.pid, termGraceMs, {
        expectedRootIdentity: identity,
        requireDescendantScan: true,
        forceVerifyMs,
        ...(options.processTreeSystem ? { system: options.processTreeSystem } : {}),
      });
    } catch (error) {
      errors.push(error);
    }
  } else if (!closeRecord) {
    errors.push(leaderLockError(
      "leader recovery fence helper exact process identity is unavailable; refusing bare-pid termination",
      "HUB_LEADER_RECOVERY_FENCE_UNVERIFIED",
    ));
  }

  if (!closeRecord) {
    closeRecord = await waitForRecoveryFenceClose(
      closePromise,
      Math.max(1, closeGraceMs, forceVerifyMs),
    );
  }
  if (stdinError) errors.push(stdinError);
  if (closeRecord?.error) errors.push(closeRecord.error);
  if (!closeRecord) {
    try {
      holder.stdout.destroy();
      holder.stderr.destroy();
      holder.unref();
    } catch (error) {
      errors.push(error);
    }
    errors.push(leaderLockError(
      `leader recovery fence helper ${holder.pid ?? "unknown"} did not emit close after cleanup`,
      "HUB_LEADER_RECOVERY_FENCE_CLOSE_TIMEOUT",
    ));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "leader recovery fence helper cleanup failed");
  }
  return closeRecord;
}

async function acquireKernelRecoveryFence(
  file: string,
  options: RecoveryFenceRuntimeOptions = {},
): Promise<RecoveryFenceLease> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(
    file,
    fsConstants.O_CREAT | fsConstants.O_RDWR | noFollowFlag(file, "HUB_LEADER_RECOVERY_FENCE_UNSAFE"),
    0o600,
  );
  let child: ChildProcessWithoutNullStreams | null = null;
  let childClose: Promise<RecoveryFenceCloseRecord> | null = null;
  let holderIdentity: ProcessIdentity | null = null;
  let requestedRelease = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw leaderLockError(`unsafe recovery fence path: ${file}`, "HUB_LEADER_RECOVERY_FENCE_UNSAFE");
    }
    const spec = recoveryFenceCommand(recoveryFenceDuration(options.helperCloseDelayMs, 0));
    child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe", handle.fd],
    });
    const holder = child;
    const closePromise = monitorRecoveryFenceHolder(holder);
    childClose = closePromise;
    let ready = false;
    let stdout = "";
    let stderr = "";
    let lostError: Error | null = null;
    let terminated = false;

    const recordTermination = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!terminated) {
        terminated = true;
        if (ready && !requestedRelease) {
          lostError = leaderLockError(
            `leader recovery fence exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
            "HUB_LEADER_RECOVERY_FENCE_LOST",
          );
        }
      }
    };
    holder.once("exit", recordTermination);
    void closePromise.then(({ code, signal }) => recordTermination(code, signal));
    await handle.close();

    const readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        holder.stdout.removeListener("data", onStdout);
        holder.stderr.removeListener("data", onStderr);
        if (error) reject(error);
        else resolve();
      };
      const onStdout = (chunk: Buffer) => {
        stdout = `${stdout}${chunk.toString("utf8")}`.slice(-1_024);
        if (stdout.includes("CPB_LEADER_RECOVERY_FENCE_READY\n")) {
          ready = true;
          finish();
        }
      };
      const onStderr = (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
      };
      const onCloseBeforeReady = (record: RecoveryFenceCloseRecord) => {
        if (ready) return;
        const { code, signal, error } = record;
        const contention = code !== null && spec.contentionExitCodes.has(code);
        finish(leaderLockError(
          contention
            ? "leader recovery fence is held by another acquirer"
            : error
              ? `leader recovery fence could not start: ${error.message}`
              : `leader recovery fence failed before readiness (code=${String(code)}, signal=${String(signal)}${stderr ? `: ${stderr.trim()}` : ""})`,
          contention ? "HUB_LEADER_RECOVERY_FENCE_CONTENDED" : "HUB_LEADER_RECOVERY_FENCE_UNAVAILABLE",
          error || undefined,
        ));
      };
      const timer = setTimeout(() => finish(leaderLockError(
        `leader recovery fence readiness timed out${stderr ? `: ${stderr.trim()}` : ""}${stdout ? ` stdout=${stdout.trim()}` : ""}`,
        "HUB_LEADER_RECOVERY_FENCE_UNAVAILABLE",
      )), RECOVERY_FENCE_READY_TIMEOUT_MS);
      timer.unref();
      holder.stdout.on("data", onStdout);
      holder.stderr.on("data", onStderr);
      void closePromise.then(onCloseBeforeReady);
    });

    await readyPromise;
    const capturedHolderIdentity = holder.pid
      && !terminated
      && holder.exitCode === null
      && holder.signalCode === null
      ? await captureExactProcessIdentityAfterSpawn(holder.pid, options.processTreeSystem)
      : null;
    holderIdentity = terminated || holder.exitCode !== null || holder.signalCode !== null
      ? null
      : capturedHolderIdentity;
    if (!holderIdentity) {
      throw leaderLockError(
        "leader recovery fence helper exact process identity could not be captured after spawn",
        "HUB_LEADER_RECOVERY_FENCE_UNVERIFIED",
      );
    }

    return {
      assertHeld() {
        if (lostError) throw lostError;
        if (terminated) {
          throw leaderLockError("leader recovery fence is no longer held", "HUB_LEADER_RECOVERY_FENCE_LOST");
        }
      },
      async release() {
        if (requestedRelease) return;
        requestedRelease = true;
        const closeRecord = await closeRecoveryFenceHolder(holder, closePromise, holderIdentity, options);
        if (closeRecord.code !== 0 || closeRecord.signal !== null) {
          throw leaderLockError(
            `leader recovery fence release failed (code=${String(closeRecord.code)}, signal=${String(closeRecord.signal)})`,
            "HUB_LEADER_RECOVERY_FENCE_RELEASE_FAILED",
          );
        }
      },
    };
  } catch (error) {
    requestedRelease = true;
    await handle.close().catch(() => undefined);
    if (child && childClose) {
      try {
        await closeRecoveryFenceHolder(child, childClose, holderIdentity, options);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "leader recovery fence startup and cleanup both failed", {
          cause: error,
        });
      }
    }
    throw error;
  }
}

export class LeaderLock {
  hubRoot: string;
  lockDir: string;
  leaderFile: string;
  epochFile: string;
  quarantineDir: string;
  acquisitionFile: string;
  recoveryFenceFile: string;
  hubId: string;
  lockToken: string;
  epoch: number;
  _renewTimer: NodeJS.Timeout | null;
  _onLost?: () => void;
  _redisBackend: HubRedisStateBackend | null | undefined;
  _recoveryFenceRuntime: RecoveryFenceRuntimeOptions;

  constructor(hubRoot: string) {
    this.hubRoot = path.resolve(hubRoot);
    this.lockDir = path.join(this.hubRoot, "orchestrator", "leader.lock");
    this.leaderFile = path.join(this.lockDir, "leader.json");
    this.epochFile = path.join(this.hubRoot, "orchestrator", "epoch.json");
    this.quarantineDir = path.join(this.hubRoot, "orchestrator", "leader.quarantine");
    this.acquisitionFile = path.join(this.hubRoot, "orchestrator", "leader.acquiring.json");
    this.recoveryFenceFile = path.join(this.hubRoot, "orchestrator", "leader.recovery.fence");
    const startToken = process.env.CPB_ORCHESTRATOR_START_TOKEN?.trim() || "";
    if (startToken && !SAFE_START_TOKEN.test(startToken)) {
      throw leaderLockError(
        "CPB_ORCHESTRATOR_START_TOKEN must contain 1-128 safe alphanumeric, hyphen, or underscore characters",
        "HUB_ORCHESTRATOR_START_TOKEN_INVALID",
      );
    }
    this.hubId = startToken
      ? `${os.hostname()}-${process.pid}-${startToken}`
      : `${os.hostname()}-${process.pid}`;
    this.lockToken = randomUUID();
    this.epoch = 0;
    this._renewTimer = null;
    this._redisBackend = undefined;
    this._recoveryFenceRuntime = {};
  }

  async acquire() {
    const redis = await this._redisState();
    if (redis) {
      if (processLeaderFence(redis.identityFingerprint)) {
        throw Object.assign(
          new Error("this process has a retired Redis leader fence; start a new process before reacquiring leadership"),
          { code: "HUB_LEADER_PROCESS_RESTART_REQUIRED" },
        );
      }
      const result = await redis.acquireLeader({
        hubId: this.hubId,
        lockToken: this.lockToken,
        host: os.hostname(),
        pid: process.pid,
      }, DEFAULT_TTL_MS);
      if (!result.acquired) {
        throw new Error(`leader lock held by ${result.leader.hubId || "unknown"} (expires ${result.leader.expiresAt || "unknown"})`);
      }
      this.epoch = result.leader.epoch;
      registerProcessLeaderFence(redis.identityFingerprint, this._fence());
      return redisLeaderRecord(result.leader);
    }
    return this._withRecoveryFence(async () => {
      const existing = await this._readLeader();

      if (existing && !this._isExpired(existing)) {
        throw new Error(`leader lock held by ${existing.hubId} (expires ${existing.expiresAt})`);
      }

      if (existing) {
        if (existing.initializing && !existing.releasedAt) {
          await this._recoverInitializingLeader(existing);
        } else {
          await this._quarantineCurrentLock(
            existing,
            existing.releasedAt ? "released" : "stale",
          );
        }
      } else {
        await this._recoverIncompleteLock();
      }

      await mkdir(path.dirname(this.lockDir), { recursive: true });
      const startedAt = new Date().toISOString();
      const processIdentity = captureCurrentExactProcessIdentity();
      if (!processIdentity) {
        throw leaderLockError(
          "current process identity could not be captured for leader acquisition",
          "HUB_LEADER_PROCESS_IDENTITY_UNAVAILABLE",
        );
      }
      const acquisition: AcquisitionReceipt = {
        hubId: this.hubId,
        host: os.hostname(),
        pid: process.pid,
        processIdentity,
        lockToken: this.lockToken,
        createdAt: startedAt,
      };
      await this._writeAcquisitionReceipt(acquisition);

      let directoryAcquired = false;
      try {
        // mkdir remains the sole ownership primitive. The kernel recovery
        // fence serializes the receipt -> mkdir -> leader publication window.
        await mkdir(this.lockDir);
        directoryAcquired = true;

        const provisional = {
          hubId: this.hubId,
          host: os.hostname(),
          pid: process.pid,
          processIdentity,
          epoch: 0,
          lockToken: this.lockToken,
          initializing: true,
          ready: false,
          startedAt,
          heartbeatAt: startedAt,
          expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
        };
        await writeJsonAtomic(this.leaderFile, provisional);

        // Lock acquired — now safe to increment epoch (epoch only after lock held).
        this.epoch = await this._incrementEpoch();
        const leader = {
          ...provisional,
          epoch: this.epoch,
          initializing: false,
          ready: false,
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + DEFAULT_TTL_MS).toISOString(),
        };
        if (!await this._writeLeaderGuarded(leader, false)) {
          throw new Error("leader lock ownership changed before acquisition committed");
        }
        await this._removeAcquisitionReceipt(acquisition);
        return leader;
      } catch (error) {
        const cleanupErrors: unknown[] = [];
        if (directoryAcquired && !isCommittedAmbiguousWrite(error)) {
          try {
            await this._expireOwnedInitialization(error);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        try {
          await this._removeAcquisitionReceipt(acquisition);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            "leader acquisition and cleanup both failed",
          );
        }
        throw error;
      }
    });
  }

  async renew() {
    const redis = await this._redisState();
    if (redis) return (await redis.renewLeader(this._fence(), DEFAULT_TTL_MS)).renewed;

    const current = await this._readLeader();
    if (!this._isCurrentLeader(current)) {
      return false;
    }
    current.heartbeatAt = new Date().toISOString();
    current.expiresAt = new Date(Date.now() + DEFAULT_TTL_MS).toISOString();
    return this._writeLeaderGuarded(current, true);
  }

  async markReady(): Promise<boolean> {
    const redis = await this._redisState();
    if (redis) {
      const current = await redis.readLeader();
      if (
        !current.alive
        || current.hubId !== this.hubId
        || current.lockToken !== this.lockToken
        || current.epoch !== this.epoch
        || current.host !== os.hostname()
        || current.pid !== process.pid
      ) return false;
      const identity = captureCurrentExactProcessIdentity();
      if (!identity) {
        throw leaderLockError(
          "current process identity could not be captured for leader readiness",
          "HUB_LEADER_PROCESS_IDENTITY_UNAVAILABLE",
        );
      }
      const receipt = this._readyReceipt(identity);
      await this._publishReadyReceipt(receipt);
      const confirmed = await redis.readLeader();
      return confirmed.alive
        && confirmed.hubId === this.hubId
        && confirmed.lockToken === this.lockToken
        && confirmed.epoch === this.epoch
        && confirmed.host === os.hostname()
        && confirmed.pid === process.pid;
    }

    return this._withRecoveryFence(async () => {
      const current = await this._readLeader();
      if (!this._isCurrentLeader(current)) return false;
      const identity = parseProcessIdentity(current?.processIdentity);
      if (!current || !identity) {
        throw leaderLockError("leader process identity is unavailable during readiness", "HUB_LEADER_STATE_INVALID");
      }
      const receipt = this._readyReceipt(identity);
      const published = await this._publishReadyReceipt(receipt);
      const readyAt = published.readyAt;
      if (!await this._writeLeaderGuarded({ ...current, ready: true, readyAt }, true)) return false;
      const confirmed = await this._readLeader();
      return Boolean(
        confirmed
        && this._isCurrentLeader(confirmed)
        && confirmed.ready === true
        && confirmed.readyAt === readyAt,
      );
    });
  }

  /**
   * Start periodic renewal. Calls onLost() if renewal fails (lock stolen/expired).
   */
  startRenewal(onLost: () => void) {
    this._onLost = onLost;
    this._renewTimer = setInterval(async () => {
      let ok = false;
      try {
        ok = await this.renew();
      } catch {
        ok = false;
      }
      if (!ok) {
        clearInterval(this._renewTimer);
        this._renewTimer = null;
        if (this._onLost) this._onLost();
      }
    }, RENEW_INTERVAL_MS);
    this._renewTimer.unref();
  }

  stopRenewal() {
    if (this._renewTimer) {
      clearInterval(this._renewTimer);
      this._renewTimer = null;
    }
  }

  async release() {
    this.stopRenewal();
    const redis = await this._redisState();
    if (redis) {
      const fence = this._fence();
      // Keep the released fence armed in this process. stop() does not join
      // in-flight tick/janitor callbacks, so clearing it would let their
      // later queue mutations silently downgrade to unfenced writes. This
      // process must exit before another LeaderLock can acquire the backend.
      return await redis.releaseLeader(fence);
    }

    const current = await this._readLeader();
    if (!this._matchesCurrentIdentity(current)) return false;
    const releasedAt = new Date().toISOString();
    return this._writeLeaderGuarded({
      ...current,
      releasedAt,
      heartbeatAt: releasedAt,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    }, true);
  }

  /**
   * Check if this Hub still holds the leader lock (for epoch fencing).
   */
  async stillHeld() {
    const redis = await this._redisState();
    if (redis) {
      const current = await redis.readLeader();
      return current.alive
        && current.hubId === this.hubId
        && current.lockToken === this.lockToken
        && current.epoch === this.epoch;
    }

    const current = await this._readLeader();
    return this._isCurrentLeader(current);
  }

  async _redisState() {
    if (this._redisBackend !== undefined) return this._redisBackend;
    this._redisBackend = await openPinnedHubRedisStateBackend({
      configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
      hubRoot: this.hubRoot,
    });
    return this._redisBackend;
  }

  _fence() {
    return { hubId: this.hubId, lockToken: this.lockToken, epoch: this.epoch };
  }

  async _readLeader() {
    return validateLeaderRecord(await readBoundedRegularJson(this.leaderFile), this.leaderFile);
  }

  async _readLeaderAt(file: string) {
    return validateLeaderRecord(await readBoundedRegularJson(file), file);
  }

  async _readAcquisitionReceipt(file = this.acquisitionFile) {
    return validateAcquisitionReceipt(await readBoundedRegularJson(file), file);
  }

  _readyReceipt(identity: ProcessIdentity): ReadyReceipt {
    return {
      hubId: this.hubId,
      host: os.hostname(),
      pid: process.pid,
      processIdentity: identity,
      lockToken: this.lockToken,
      epoch: this.epoch,
      createdAt: new Date().toISOString(),
      readyAt: new Date().toISOString(),
    };
  }

  async _readReadyReceipt(lockToken = this.lockToken) {
    const file = readyReceiptPath(this.hubRoot, lockToken);
    return validateReadyReceipt(await readBoundedRegularJson(file), file);
  }

  async _publishReadyReceipt(receipt: ReadyReceipt) {
    const file = readyReceiptPath(this.hubRoot, receipt.lockToken);
    await mkdir(path.dirname(file), { recursive: true });
    let handle;
    let created = false;
    let fileCommitted = false;
    let complete = false;
    let operationError: unknown;
    try {
      handle = await open(file, noFollowCreateExclusiveWriteFlags(file, "HUB_LEADER_READY_UNSAFE"), 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      fileCommitted = true;
      await syncDirectory(path.dirname(file));
      complete = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        operationError = fileCommitted
          ? committedLeaderWriteError(
            `leader readiness receipt committed with ambiguous durability: ${file}`,
            "HUB_LEADER_READY_COMMITTED_AMBIGUOUS",
            file,
            error,
            { readyFile: file, orchestratorDir: path.dirname(file) },
          )
          : error;
      }
    }
    const cleanupErrors: unknown[] = [];
    try {
      await handle?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (created && !fileCommitted) {
      try {
        await preserveExistingPathAsQuarantine(file, this.quarantineDir, "ready-uncommitted");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (operationError !== undefined || cleanupErrors.length > 0) {
      const errors = [...(operationError === undefined ? [] : [operationError]), ...cleanupErrors];
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, "leader readiness receipt write and cleanup failed");
    }
    const published = await this._readReadyReceipt(receipt.lockToken);
    if (!published || !readyReceiptMatches(published, receipt)) {
      throw leaderLockError(
        "leader readiness receipt belongs to a different generation",
        "HUB_LEADER_READY_OWNER_CHANGED",
      );
    }
    return published;
  }

  _isExpired(leader: LooseRecord | null) {
    const expiresAtValue = dateInput(leader?.expiresAt);
    const expiresAt = expiresAtValue ? new Date(expiresAtValue).getTime() : NaN;
    return !Number.isFinite(expiresAt) || Date.now() > expiresAt;
  }

  _matchesCurrentIdentity(leader: LooseRecord | null) {
    const owner = currentLeaderOwner(this.hubId, this.lockToken);
    return Boolean(
      leader
      && owner
      && this.epoch > 0
      && sameOwnerIdentity(leaderOwner(leader), owner)
      && Number(leader.epoch) === this.epoch,
    );
  }

  _matchesLockToken(leader: LooseRecord | null) {
    const owner = currentLeaderOwner(this.hubId, this.lockToken);
    return Boolean(
      leader
      && owner
      && sameOwnerIdentity(leaderOwner(leader), owner),
    );
  }

  _isCurrentLeader(leader: LooseRecord | null) {
    return this._matchesCurrentIdentity(leader) && !this._isExpired(leader);
  }

  async _incrementEpoch() {
    const data = await readBoundedRegularJson(this.epochFile);
    const current = data ? Number(data.epoch) : 0;
    if (!Number.isSafeInteger(current) || current < 0 || (data && !validIsoDate(data.updatedAt))) {
      throw leaderLockError(`invalid leader epoch state: ${this.epochFile}`, "HUB_LEADER_EPOCH_INVALID");
    }
    const next = current + 1;
    await mkdir(path.dirname(this.epochFile), { recursive: true });
    await writeJsonAtomic(this.epochFile, { epoch: next, updatedAt: new Date().toISOString() });
    return next;
  }

  async _withRecoveryFence<T>(operation: () => Promise<T>) {
    const lease = await acquireKernelRecoveryFence(this.recoveryFenceFile, this._recoveryFenceRuntime);
    let result: T | undefined;
    let operationError: unknown;
    try {
      lease.assertHeld();
      result = await operation();
      lease.assertHeld();
    } catch (error) {
      operationError = error;
    }

    try {
      await lease.release();
    } catch (releaseError) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, releaseError],
          "leader lock operation and recovery-fence release both failed",
        );
      }
      throw releaseError;
    }
    if (operationError !== undefined) throw operationError;
    return result as T;
  }

  _isProcessIdentityAlive(identity: ProcessIdentity) {
    return isProcessIdentityAlive(identity);
  }

  _requireLocalOwner(receipt: AcquisitionReceipt) {
    if (receipt.host !== os.hostname()) {
      throw leaderLockError(
        `cannot prove leader acquisition owner dead on remote host ${receipt.host}`,
        "HUB_LEADER_OWNER_LIVENESS_UNKNOWN",
      );
    }
  }

  _assertOwnerDead(receipt: AcquisitionReceipt) {
    this._requireLocalOwner(receipt);
    if (this._isProcessIdentityAlive(receipt.processIdentity)) {
      throw leaderLockError(
        `leader lock is still owned by live process incarnation ${receipt.processIdentity.incarnation}`,
        "HUB_LEADER_OWNER_ALIVE",
      );
    }
  }

  async _ensureQuarantineDir() {
    await mkdir(this.quarantineDir, { recursive: true });
    const info = await lstat(this.quarantineDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw leaderLockError(`unsafe leader quarantine path: ${this.quarantineDir}`, "HUB_LEADER_QUARANTINE_UNSAFE");
    }
  }

  async _restoreQuarantinedLock(target: string, cause: unknown) {
    const errors = [cause];
    let successorPreserved = false;
    try {
      await lstat(this.lockDir);
      successorPreserved = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") errors.push(error);
    }
    for (const directory of [target, this.quarantineDir, path.dirname(this.lockDir)]) {
      try {
        await syncDirectory(directory);
      } catch (error) {
        errors.push(error);
      }
    }
    throw Object.assign(
      new AggregateError(
        errors,
        successorPreserved
          ? `leader lock successor preserved while quarantine remains: ${this.lockDir}; quarantined=${target}`
          : `leader lock quarantine preserved; canonical restore refused: ${this.lockDir}; quarantined=${target}`,
        { cause },
      ),
      {
        code: successorPreserved ? "HUB_LEADER_SUCCESSOR_PRESERVED" : "HUB_LEADER_QUARANTINE_PRESERVED",
        committed: true,
        recoveryPaths: { lockDir: this.lockDir, quarantineDir: target },
        quarantineDir: target,
        lockDir: this.lockDir,
        quarantinePreserved: true,
        successorPreserved,
      },
    );
  }

  async _preserveQuarantinedLockIfCanonicalSuccessor(target: string, message: string) {
    try {
      await lstat(this.lockDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      await this._restoreQuarantinedLock(target, error);
      return;
    }
    await this._restoreQuarantinedLock(
      target,
      leaderLockError(message, "HUB_LEADER_QUARANTINE_ABA"),
    );
  }

  async _quarantineCurrentLock(expected: LooseRecord, reason: "stale" | "released" | "incomplete") {
    await this._ensureQuarantineDir();
    const expectedGeneration = await directoryGeneration(this.lockDir);
    const current = await this._readLeader();
    if (!current || !sameOwnerIdentity(leaderOwner(expected), leaderOwner(current)) || Number(expected.epoch) !== Number(current.epoch)) {
      throw leaderLockError(
        `leader lock ${reason} quarantine refused after owner identity changed`,
        "HUB_LEADER_QUARANTINE_OWNER_CHANGED",
      );
    }
    if (reason === "released" && !current.releasedAt) {
      throw leaderLockError("leader lock is no longer released", "HUB_LEADER_QUARANTINE_STATE_CHANGED");
    }
    if (reason !== "released" && !this._isExpired(current)) {
      throw leaderLockError("leader lock lease was renewed before quarantine", "HUB_LEADER_QUARANTINE_STATE_CHANGED");
    }
    const receipt = await this._readAcquisitionReceipt();
    if (receipt && !sameOwnerIdentity(receipt, leaderOwner(current))) {
      throw leaderLockError(
        "leader acquisition receipt belongs to a different owner",
        "HUB_LEADER_ACQUISITION_OWNER_CHANGED",
      );
    }
    if (!sameDirectoryGeneration(expectedGeneration, await directoryGeneration(this.lockDir))) {
      throw leaderLockError(
        `leader lock ${reason} quarantine refused after directory generation changed`,
        "HUB_LEADER_QUARANTINE_OWNER_CHANGED",
      );
    }
    const target = path.join(this.quarantineDir, `${reason}-${Date.now()}-${randomUUID()}`);
    try {
      await rename(this.lockDir, target);
    } catch (error) {
      throw leaderLockError(
        `leader lock ${reason} quarantine lost a contention race`,
        "HUB_LEADER_QUARANTINE_CONTENDED",
        error,
      );
    }
    try {
      await syncDirectory(path.dirname(this.lockDir));
      await syncDirectory(this.quarantineDir);
      const movedGeneration = await directoryGeneration(target);
      if (!sameDirectoryGenerationAcrossRename(expectedGeneration, movedGeneration)) {
        throw leaderLockError(
          "quarantined leader directory did not match the expected generation",
          "HUB_LEADER_QUARANTINE_ABA",
        );
      }
      const moved = await this._readLeaderAt(path.join(target, "leader.json"));
      if (!moved || !sameOwnerIdentity(leaderOwner(expected), leaderOwner(moved)) || Number(expected.epoch) !== Number(moved.epoch)) {
        throw leaderLockError(
          "quarantined leader did not match the expected owner incarnation",
          "HUB_LEADER_QUARANTINE_ABA",
        );
      }
      if (reason === "released" && !moved.releasedAt) {
        throw leaderLockError(
          "quarantined released leader lost its released marker",
          "HUB_LEADER_QUARANTINE_ABA",
        );
      }
      if (reason !== "released" && !this._isExpired(moved)) {
        throw leaderLockError(
          "quarantined stale leader renewed its lease before the rename",
          "HUB_LEADER_QUARANTINE_ABA",
        );
      }
      const receiptAfter = await this._readAcquisitionReceipt();
      if (
        (receipt && (!receiptAfter || !sameOwnerIdentity(receipt, receiptAfter)))
        || (!receipt && receiptAfter)
      ) {
        throw leaderLockError(
          "leader acquisition receipt changed during quarantine",
          "HUB_LEADER_QUARANTINE_ABA",
        );
      }
    } catch (error) {
      await this._restoreQuarantinedLock(target, error);
      throw error;
    }
    await this._preserveQuarantinedLockIfCanonicalSuccessor(
      target,
      `leader lock successor appeared during ${reason} quarantine`,
    );
    if (receipt) await this._removeAcquisitionReceipt(receipt);
    return target;
  }

  async _quarantineIncompleteLock(expected: AcquisitionReceipt) {
    await this._ensureQuarantineDir();
    const currentLeader = await this._readLeader();
    const currentReceipt = await this._readAcquisitionReceipt();
    if (currentLeader || !currentReceipt || !sameOwnerIdentity(expected, currentReceipt)) {
      throw leaderLockError(
        "incomplete leader lock owner changed before quarantine",
        "HUB_LEADER_QUARANTINE_OWNER_CHANGED",
      );
    }
    const expectedGeneration = await directoryGeneration(this.lockDir);
    const receiptBeforeRename = await this._readAcquisitionReceipt();
    if (!receiptBeforeRename || !sameOwnerIdentity(expected, receiptBeforeRename)) {
      throw leaderLockError(
        "incomplete leader acquisition receipt changed before quarantine",
        "HUB_LEADER_QUARANTINE_OWNER_CHANGED",
      );
    }
    const target = path.join(this.quarantineDir, `incomplete-${Date.now()}-${randomUUID()}`);
    try {
      await rename(this.lockDir, target);
    } catch (error) {
      throw leaderLockError(
        "incomplete leader lock quarantine lost a contention race",
        "HUB_LEADER_QUARANTINE_CONTENDED",
        error,
      );
    }
    try {
      await syncDirectory(path.dirname(this.lockDir));
      await syncDirectory(this.quarantineDir);
      const movedGeneration = await directoryGeneration(target);
      if (!sameDirectoryGenerationAcrossRename(expectedGeneration, movedGeneration)) {
        throw leaderLockError(
          "quarantined incomplete lock directory changed during quarantine",
          "HUB_LEADER_QUARANTINE_ABA",
        );
      }
      const movedLeader = await this._readLeaderAt(path.join(target, "leader.json"));
      if (movedLeader) {
        throw leaderLockError(
          "quarantined incomplete lock contained a successor leader",
          "HUB_LEADER_QUARANTINE_ABA",
        );
      }
      const receiptAfter = await this._readAcquisitionReceipt();
      if (!receiptAfter || !sameOwnerIdentity(expected, receiptAfter)) {
        throw leaderLockError(
          "incomplete leader acquisition receipt changed during quarantine",
          "HUB_LEADER_QUARANTINE_ABA",
        );
      }
    } catch (error) {
      await this._restoreQuarantinedLock(target, error);
      throw error;
    }
    await this._preserveQuarantinedLockIfCanonicalSuccessor(
      target,
      "leader lock successor appeared during incomplete quarantine",
    );
    return target;
  }

  async _recoverIncompleteLock() {
    let lockExists = false;
    try {
      const info = await lstat(this.lockDir);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw leaderLockError(`unsafe leader lock path: ${this.lockDir}`, "HUB_LEADER_STATE_UNSAFE");
      }
      lockExists = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const receipt = await this._readAcquisitionReceipt();
    if (!lockExists && !receipt) return false;
    if (!receipt) {
      throw leaderLockError(
        "incomplete leader lock has no process-identity acquisition receipt",
        "HUB_LEADER_INCOMPLETE_UNBOUND",
      );
    }
    this._assertOwnerDead(receipt);
    if (lockExists) await this._quarantineIncompleteLock(receipt);
    await this._removeAcquisitionReceipt(receipt);
    return true;
  }

  async _recoverInitializingLeader(expected: LooseRecord) {
    const owner = leaderOwner(expected);
    this._assertOwnerDead(owner);
    await this._quarantineCurrentLock(expected, "incomplete");
    return true;
  }

  async _writeAcquisitionReceipt(receipt: AcquisitionReceipt) {
    let handle;
    let created = false;
    let fileCommitted = false;
    let complete = false;
    let operationError: unknown;
    try {
      handle = await open(
        this.acquisitionFile,
        noFollowCreateExclusiveWriteFlags(this.acquisitionFile, "HUB_LEADER_ACQUISITION_UNSAFE"),
        0o600,
      );
      created = true;
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      fileCommitted = true;
      await syncDirectory(path.dirname(this.acquisitionFile));
      complete = true;
    } catch (error) {
      operationError = fileCommitted
        ? committedLeaderWriteError(
          `leader acquisition receipt committed with ambiguous durability: ${this.acquisitionFile}`,
          "HUB_LEADER_ACQUISITION_COMMITTED_AMBIGUOUS",
          this.acquisitionFile,
          error,
          { acquisitionFile: this.acquisitionFile, orchestratorDir: path.dirname(this.acquisitionFile) },
        )
        : error;
    }
    const cleanupErrors: unknown[] = [];
    try {
      await handle?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (created && !fileCommitted) {
      try {
        await preserveExistingPathAsQuarantine(this.acquisitionFile, this.quarantineDir, "acquisition-uncommitted");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (operationError !== undefined || cleanupErrors.length > 0) {
      const errors = [...(operationError === undefined ? [] : [operationError]), ...cleanupErrors];
      if (errors.length === 1) throw errors[0];
      throw new AggregateError(errors, "leader acquisition receipt write and cleanup failed");
    }
  }

  async _removeAcquisitionReceipt(expected: AcquisitionReceipt) {
    const current = await this._readAcquisitionReceipt();
    if (!current) return false;
    if (!sameOwnerIdentity(expected, current)) {
      throw leaderLockError(
        "leader acquisition receipt owner changed before cleanup",
        "HUB_LEADER_ACQUISITION_OWNER_CHANGED",
      );
    }
    await this._ensureQuarantineDir();
    const target = path.join(this.quarantineDir, `acquisition-${Date.now()}-${randomUUID()}.json`);
    await rename(this.acquisitionFile, target);
    await syncDirectory(path.dirname(this.acquisitionFile));
    await syncDirectory(this.quarantineDir);
    try {
      const moved = await this._readAcquisitionReceipt(target);
      if (!moved || !sameOwnerIdentity(expected, moved)) {
        throw leaderLockError(
          "moved leader acquisition receipt did not match its expected owner",
          "HUB_LEADER_ACQUISITION_ABA",
        );
      }
    } catch (error) {
      try {
        await lstat(this.acquisitionFile);
        throw leaderLockError(
          "cannot restore moved acquisition receipt because a successor exists",
          "HUB_LEADER_ACQUISITION_RESTORE_BLOCKED",
          error,
        );
      } catch (stateError) {
        if (errorCode(stateError) !== "ENOENT") throw stateError;
      }
      throw Object.assign(
        leaderLockError(
          "leader acquisition receipt quarantine preserved after validation failure",
          "HUB_LEADER_ACQUISITION_PRESERVED",
          error,
        ),
        {
          committed: true,
          recoveryPaths: { acquisitionFile: this.acquisitionFile, quarantineFile: target },
          quarantineFile: target,
          quarantinePreserved: true,
        },
      );
    }
    await syncDirectory(this.quarantineDir);
    return true;
  }

  async _writeLeaderGuarded(next: LooseRecord, requireEpoch: boolean) {
    const tempPath = path.join(this.lockDir, `.leader-${this.lockToken}-${randomUUID()}.tmp`);
    let created = false;
    let published = false;
    try {
      const handle = await open(
        tempPath,
        noFollowCreateExclusiveWriteFlags(tempPath, "HUB_LEADER_STATE_UNSAFE"),
        0o600,
      );
      created = true;
      try {
        await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await leaderLockTestHooks()?.afterLeaderTempWritten?.({
        tempPath,
        leaderFile: this.leaderFile,
        lockDir: this.lockDir,
      });

      // The temp file is created before the identity check. If a contender
      // renames this lock directory at any later point, the temp file moves
      // with the old directory and rename(tempPath, leaderFile) fails instead
      // of overwriting the replacement leader at the reused pathname.
      const lockGeneration = await directoryGeneration(this.lockDir);
      const current = await this._readLeader();
      const ownsCurrent = requireEpoch
        ? this._isCurrentLeader(current)
        : this._matchesLockToken(current);
      if (!ownsCurrent) return false;
      await leaderLockTestHooks()?.afterLeaderOwnerValidated?.({
        phase: "guarded-write",
        tempPath,
        leaderFile: this.leaderFile,
        lockDir: this.lockDir,
      });
      const afterValidationGeneration = await directoryGeneration(this.lockDir);
      if (!sameDirectoryGeneration(lockGeneration, afterValidationGeneration)) return false;
      const confirmed = await this._readLeader();
      const stillOwns = requireEpoch
        ? this._isCurrentLeader(confirmed)
        : this._matchesLockToken(confirmed);
      if (!stillOwns) return false;

      await this._ensureQuarantineDir();
      const retiredPath = path.join(this.quarantineDir, `leader-current-${Date.now()}-${randomUUID()}.json`);
      try {
        await rename(this.leaderFile, retiredPath);
        await syncDirectory(this.lockDir);
        await syncDirectory(this.quarantineDir);
        const retired = await this._readLeaderAt(retiredPath);
        const retiredOwns = requireEpoch
          ? this._isCurrentLeader(retired)
          : this._matchesLockToken(retired);
        if (!retiredOwns) {
          throw Object.assign(
            leaderLockError(
              "retired leader state changed before no-clobber publication",
              "HUB_LEADER_STATE_OWNER_CHANGED",
            ),
            {
              committed: true,
              recoveryPaths: { leaderFile: this.leaderFile, retiredLeaderFile: retiredPath, tempPath },
              quarantinePreserved: true,
            },
          );
        }
        await link(tempPath, this.leaderFile);
        await syncDirectory(this.lockDir);
        published = true;
      } catch (error) {
        if (errorCode(error) === "ENOENT") {
          const latest = await this._readLeader();
          const ownsLatest = requireEpoch
            ? this._isCurrentLeader(latest)
            : this._matchesLockToken(latest);
          if (!ownsLatest) return false;
        }
        if (errorCode(error) === "EEXIST") return false;
        if (!published) throw error;
        throw committedLeaderWriteError(
          `leader state committed with ambiguous durability: ${this.leaderFile}`,
          "HUB_LEADER_STATE_COMMITTED_AMBIGUOUS",
          this.leaderFile,
          error,
          { lockDir: this.lockDir, leaderFile: this.leaderFile },
        );
      }
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        const latest = await this._readLeader();
        const stillOwns = requireEpoch
          ? this._isCurrentLeader(latest)
          : this._matchesLockToken(latest);
        if (!stillOwns) return false;
      }
      throw error;
    } finally {
      if (created) {
        try {
          await preserveExistingPathAsQuarantine(tempPath, this.quarantineDir, "leader-temp");
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            if (published) {
              throw committedLeaderWriteError(
                `leader state committed but temp preservation failed: ${this.leaderFile}`,
                "HUB_LEADER_STATE_COMMITTED_AMBIGUOUS",
                this.leaderFile,
                error,
                { lockDir: this.lockDir, leaderFile: this.leaderFile, tempPath },
              );
            }
            throw error;
          }
        }
      }
    }
  }

  async _expireOwnedInitialization(error: unknown) {
    const current = await this._readLeader();
    if (!this._matchesLockToken(current)) return false;
    const failedAt = new Date().toISOString();
    return this._writeLeaderGuarded({
      ...current,
      initializing: false,
      initializationFailedAt: failedAt,
      initializationFailure: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      heartbeatAt: failedAt,
      expiresAt: new Date(Date.now() - 1).toISOString(),
    }, false);
  }

  getEpoch() { return this.epoch; }
  getHubId() { return this.hubId; }
}

export async function readLeaderStatus(hubRoot: string) {
  const redis = await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot,
  });
  if (redis) {
    const leader = await redis.readLeader();
    const readyFile = leader.lockToken ? readyReceiptPath(hubRoot, leader.lockToken) : null;
    const readyReceipt = readyFile
      ? validateReadyReceipt(await readBoundedRegularJson(readyFile), readyFile)
      : null;
    let ready = leader.alive && readyReceiptMatches(readyReceipt, leader);
    if (ready && leader.host === os.hostname() && readyReceipt) {
      ready = isProcessIdentityAlive(readyReceipt.processIdentity);
    }
    return {
      status: leader.alive ? "running" : "stopped",
      ready,
      readyAt: ready ? readyReceipt?.readyAt || null : null,
      hubId: leader.hubId,
      host: leader.host,
      epoch: leader.epoch,
      pid: leader.pid,
      processIdentity: ready ? readyReceipt?.processIdentity || null : null,
      lockToken: leader.lockToken,
      heartbeatAt: leader.heartbeatAt,
      expiresAt: leader.expiresAt,
    };
  }

  const lockDir = path.join(hubRoot, "orchestrator", "leader.lock");
  const leaderFile = path.join(lockDir, "leader.json");
  const epochFile = path.join(hubRoot, "orchestrator", "epoch.json");
  const leader = validateLeaderRecord(await readBoundedRegularJson(leaderFile), leaderFile);
  const epochState = await readBoundedRegularJson(epochFile);
  if (
    epochState
    && (!Number.isSafeInteger(Number(epochState.epoch))
      || Number(epochState.epoch) < 0
      || !validIsoDate(epochState.updatedAt))
  ) {
    throw leaderLockError(`invalid leader epoch state: ${epochFile}`, "HUB_LEADER_EPOCH_INVALID");
  }
  const leaderAlive = isLeaderAlive(leader);
  const readyFile = leader ? readyReceiptPath(hubRoot, String(leader.lockToken)) : null;
  const readyReceipt = readyFile
    ? validateReadyReceipt(await readBoundedRegularJson(readyFile), readyFile)
    : null;
  const ready = Boolean(
    leaderAlive
    && leader?.ready === true
    && readyReceiptMatches(readyReceipt, leader)
    && leader.readyAt === readyReceipt?.readyAt,
  );

  return {
    status: leaderAlive ? "running" : "stopped",
    ready,
    readyAt: ready ? readyReceipt?.readyAt || null : null,
    hubId: leader?.hubId || null,
    host: leader?.host || null,
    epoch: leader?.epoch || epochState?.epoch || 0,
    pid: leader?.pid || null,
    processIdentity: leader ? parseProcessIdentity(leader.processIdentity) : null,
    lockToken: leader?.lockToken || null,
    heartbeatAt: leader?.heartbeatAt || null,
    expiresAt: leader?.expiresAt || null,
  };
}

function redisLeaderRecord(leader: RedisLeaderStatus) {
  return {
    hubId: leader.hubId,
    host: leader.host,
    pid: leader.pid,
    processIdentity: null,
    epoch: leader.epoch,
    lockToken: leader.lockToken,
    initializing: false,
    ready: false,
    readyAt: null,
    startedAt: leader.startedAt,
    heartbeatAt: leader.heartbeatAt,
    expiresAt: leader.expiresAt,
  };
}

function isLeaderAlive(leader: LooseRecord | null) {
  const expiresAtValue = dateInput(leader?.expiresAt);
  const expiresAt = expiresAtValue ? new Date(expiresAtValue).getTime() : NaN;
  if (
    !leader
    || leader.initializing
    || leader.releasedAt
    || !Number.isFinite(expiresAt)
    || Date.now() > expiresAt
  ) return false;
  const pid = numericPid(leader.pid);
  if (!pid || leader.host !== os.hostname()) return true;
  const identity = parseProcessIdentity(leader.processIdentity);
  if (!identity || identity.pid !== pid) return true;
  return isProcessIdentityAlive(identity);
}
