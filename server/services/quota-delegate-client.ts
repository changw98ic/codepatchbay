import type { LooseRecord } from "../../shared/types.js";
import type {
  ProviderUnavailablePayload,
  ProviderUsagePayload,
} from "../../core/engine/provider-handoff.js";
/**
 * Quota Delegate Client — IPC client for the quota delegate process.
 *
 * Sends structured commands as individual files to {hubRoot}/providers/delegate/inbox/.
 * Each command is a file named {commandId}.json, published without replacing an existing command.
 * Quota writes use strong ack (poll for ack file); usage writes are fire-and-forget.
 * Fails closed when delegate is unavailable (no fallback to direct writes).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { assertHubWritable } from "../../shared/hub-maintenance.js";
import { createHash, randomUUID } from "node:crypto";
import type { readProviderQuotas } from "./provider-quota.js";
import {
  isProcessIdentityAlive,
  sameProcessIdentity,
  type ProcessIdentity,
} from "../../core/runtime/process-tree.js";

const ACK_POLL_MS = Number(process.env.CPB_DELEGATE_ACK_POLL_MS || 50);
const ACK_TIMEOUT_MS = Number(process.env.CPB_DELEGATE_ACK_TIMEOUT_MS || 5000);
type ProviderQuotaEntry = Awaited<ReturnType<typeof readProviderQuotas>>[string];

type ProviderUnavailablePublicInput = Pick<ProviderUnavailablePayload, "providerKey" | "agent" | "status">
  & Partial<Omit<ProviderUnavailablePayload, "providerKey" | "agent" | "status">>;

type ProviderUsagePublicInput = Pick<ProviderUsagePayload, "phase" | "providerKey" | "agent" | "status" | "phaseStatus">
  & Partial<Omit<ProviderUsagePayload, "phase" | "providerKey" | "agent" | "status" | "phaseStatus">>;

export interface QuotaDelegateClientPersistenceHooks {
  resolveNoFollowFlag?: () => number | undefined;
  resolveDirectoryFlags?: () => number | undefined;
  afterInitialLstat?: (context: { filePath: string }) => void | Promise<void>;
  afterRead?: (context: { filePath: string; totalBytes: number }) => void | Promise<void>;
  beforePathGenerationCheck?: (context: { filePath: string; totalBytes: number }) => void | Promise<void>;
  beforeRename?: (context: {
    filePath: string;
    tempPath: string;
    command: LooseRecord;
    commandDigest: string;
  }) => void | Promise<void>;
  afterRename?: (context: {
    filePath: string;
    tempPath: string;
    command: LooseRecord;
    commandDigest: string;
  }) => void | Promise<void>;
  beforeTempIsolation?: (context: {
    filePath: string;
    tempPath: string;
    isolationPath: string;
    commandDigest: string;
  }) => void | Promise<void>;
  afterTempIsolation?: (context: {
    filePath: string;
    tempPath: string;
    isolationPath: string;
    commandDigest: string;
  }) => void | Promise<void>;
  beforeTempRemoval?: (context: {
    filePath: string;
    tempPath: string;
    isolationPath: string;
    commandDigest: string;
  }) => void | Promise<void>;
  syncDirectory?: (context: {
    directory: string;
    phase: "command-publish" | "temp-isolate" | "temp-remove";
  }) => void | Promise<void>;
}

const quotaDelegateClientPersistenceHookStorage = new AsyncLocalStorage<Readonly<QuotaDelegateClientPersistenceHooks>>();

export async function withQuotaDelegateClientPersistenceHooksForTests<T>(
  hooks: QuotaDelegateClientPersistenceHooks,
  operation: () => Promise<T>,
) {
  const inherited = quotaDelegateClientPersistenceHookStorage.getStore();
  return await quotaDelegateClientPersistenceHookStorage.run(
    Object.freeze({ ...inherited, ...hooks }),
    operation,
  );
}

function currentQuotaDelegateClientPersistenceHooks() {
  return quotaDelegateClientPersistenceHookStorage.getStore() ?? null;
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

// ─── Paths ───────────────────────────────────────────────────────────

function delegateDir(hubRoot: string) {
  return path.join(hubRoot, "providers", "delegate");
}

function inboxDir(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "inbox");
}

function acksDir(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "acks");
}

function commandFilePath(hubRoot: string, commandId: string) {
  return path.join(inboxDir(hubRoot), `${commandId}.json`);
}

function ackFilePath(hubRoot: string, commandId: string) {
  return path.join(acksDir(hubRoot), `${commandId}.json`);
}

function lockFilePath(hubRoot: string) {
  return path.join(delegateDir(hubRoot), "delegate.lock");
}

// ─── Command Write (per-file, no-clobber publication) ────────────────

const SAFE_COMMAND_ID = /^[A-Za-z0-9._-]+$/;
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const CONTROL_FILE_READ_CHUNK_BYTES = 64 * 1024;

type RegularFileGeneration = {
  dev: bigint | number;
  ino: bigint | number;
  size: bigint | number;
  mtimeMs: bigint | number;
  ctimeMs: bigint | number;
  birthtimeMs: bigint | number;
};

function normalizedHubRoot(hubRoot: string) {
  return path.resolve(hubRoot);
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function invalidRegularFile(description: string, code: string) {
  return delegateClientError(`${description} must be a regular file opened without following symlinks`, code);
}

function sameRegularFileGeneration(left: RegularFileGeneration, right: RegularFileGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameRegularFileGenerationAcrossRename(left: RegularFileGeneration, right: RegularFileGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function sameDirectoryIdentity(left: RegularFileGeneration, right: RegularFileGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function regularFileGeneration(
  info: Pick<Awaited<ReturnType<typeof lstat>>, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "birthtimeMs">,
): RegularFileGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function errorRecoveryPaths(error: unknown) {
  if (!error || typeof error !== "object" || !("recoveryPaths" in error)) return [];
  const recoveryPaths = (error as { recoveryPaths?: unknown }).recoveryPaths;
  return Array.isArray(recoveryPaths)
    ? recoveryPaths.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
}

function errorCommittedPath(error: unknown) {
  if (!error || typeof error !== "object" || !("committedPath" in error)) return "";
  const committedPath = (error as { committedPath?: unknown }).committedPath;
  return typeof committedPath === "string" ? committedPath : "";
}

function errorIsCommitted(error: unknown) {
  return Boolean(error && typeof error === "object" && "committed" in error
    && (error as { committed?: unknown }).committed === true);
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.filter((value) => value.length > 0))];
}

function unsafeDirectory(message: string, cause?: unknown) {
  return Object.assign(delegateClientError(message, "QUOTA_DELEGATE_DIRECTORY_UNSAFE"), {
    ...(cause === undefined ? {} : { cause }),
  });
}

function directoryOpenFlags(hooks: QuotaDelegateClientPersistenceHooks | null) {
  const flags = hooks?.resolveDirectoryFlags
    ? hooks.resolveDirectoryFlags()
    : typeof constants.O_NOFOLLOW === "number"
      && constants.O_NOFOLLOW !== 0
      && typeof constants.O_DIRECTORY === "number"
      && constants.O_DIRECTORY !== 0
      ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
      : undefined;
  if (typeof flags !== "number" || flags === 0) {
    throw unsafeDirectory("safe directory descriptor flags are unavailable");
  }
  return flags;
}

async function assertSafeDirectory(directory: string, hooks: QuotaDelegateClientPersistenceHooks | null) {
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw unsafeDirectory(`quota delegate directory is not a real directory: ${directory}`);
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  try {
    handle = await open(directory, directoryOpenFlags(hooks));
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.isSymbolicLink()
      || !sameDirectoryIdentity(regularFileGeneration(before), regularFileGeneration(opened))
    ) {
      throw unsafeDirectory(`quota delegate directory changed while opening: ${directory}`);
    }
  } catch (error) {
    primaryError = ["ELOOP", "EMLINK", "ENOTDIR"].includes(errorCode(error))
      ? unsafeDirectory(`refusing unsafe quota delegate directory: ${directory}`, error)
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
    throw Object.assign(
      new AggregateError([asError(primaryError), asError(closeError)], asError(primaryError).message, {
        cause: asError(primaryError),
      }),
      { code: errorCode(primaryError) || "QUOTA_DELEGATE_DIRECTORY_UNSAFE", primaryError, closeError },
    );
  }
  if (closeError) throw closeError;
}

async function ensureSafeDirectoryBelow(
  hubRoot: string,
  directory: string,
  hooks: QuotaDelegateClientPersistenceHooks | null,
) {
  const root = path.resolve(hubRoot);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw unsafeDirectory(`quota delegate directory escapes hub root: ${directory}`);
  }
  await assertSafeDirectory(root, hooks);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    await assertSafeDirectory(current, hooks);
  }
}

async function assertSafeExistingDirectoryBelow(
  hubRoot: string,
  directory: string,
  hooks: QuotaDelegateClientPersistenceHooks | null,
) {
  const root = path.resolve(hubRoot);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw unsafeDirectory(`quota delegate directory escapes hub root: ${directory}`);
  }
  await assertSafeDirectory(root, hooks);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    await assertSafeDirectory(current, hooks);
  }
}

async function readRegularFileNoFollow(filePath: string, description: string, invalidCode: string) {
  const hooks = currentQuotaDelegateClientPersistenceHooks();
  const noFollowFlag = hooks?.resolveNoFollowFlag
    ? hooks.resolveNoFollowFlag()
    : constants.O_NOFOLLOW;
  if (typeof noFollowFlag !== "number" || noFollowFlag === 0) {
    throw invalidRegularFile(`${description}; O_NOFOLLOW is unavailable`, invalidCode);
  }
  const before = await lstat(filePath);
  if (!before.isFile()) throw invalidRegularFile(description, invalidCode);
  if (before.size > MAX_CONTROL_FILE_BYTES) {
    throw delegateClientError(`${description} exceeds ${MAX_CONTROL_FILE_BYTES} bytes`, invalidCode);
  }
  await hooks?.afterInitialLstat?.({ filePath });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  let content = "";
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollowFlag);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameRegularFileGeneration(before, opened)) {
      throw invalidRegularFile(description, invalidCode);
    }
    if (opened.size > MAX_CONTROL_FILE_BYTES) {
      throw delegateClientError(`${description} exceeds ${MAX_CONTROL_FILE_BYTES} bytes`, invalidCode);
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = MAX_CONTROL_FILE_BYTES + 1 - totalBytes;
      if (remaining <= 0) {
        throw delegateClientError(`${description} exceeds ${MAX_CONTROL_FILE_BYTES} bytes`, invalidCode);
      }
      const chunk = Buffer.allocUnsafe(Math.min(CONTROL_FILE_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_CONTROL_FILE_BYTES) {
        throw delegateClientError(`${description} exceeds ${MAX_CONTROL_FILE_BYTES} bytes`, invalidCode);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    await hooks?.afterRead?.({ filePath, totalBytes });
    const afterDescriptor = await handle.stat();
    if (!afterDescriptor.isFile() || !sameRegularFileGeneration(opened, afterDescriptor)) {
      throw invalidRegularFile(`${description}; file generation changed during read`, invalidCode);
    }
    await hooks?.beforePathGenerationCheck?.({ filePath, totalBytes });
    let afterPath;
    try {
      afterPath = await lstat(filePath);
    } catch (error) {
      throw Object.assign(
        invalidRegularFile(`${description}; file path changed during read`, invalidCode),
        { cause: error },
      );
    }
    if (!afterPath.isFile() || !sameRegularFileGeneration(opened, afterPath)) {
      throw invalidRegularFile(`${description}; file generation changed during read`, invalidCode);
    }
    content = Buffer.concat(chunks, totalBytes).toString("utf8");
  } catch (error) {
    primaryError = ["ELOOP", "EMLINK"].includes(errorCode(error))
      ? invalidRegularFile(description, invalidCode)
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
    throw Object.assign(new AggregateError([asError(primaryError), asError(closeError)], asError(primaryError).message, {
      cause: asError(primaryError),
    }), { code: (primaryError as NodeJS.ErrnoException).code, primaryError, cleanupError: closeError });
  }
  if (closeError) throw closeError;
  return content;
}

async function syncDirectory(
  dirPath: string,
  phase: "command-publish" | "temp-isolate" | "temp-remove",
  hooks: QuotaDelegateClientPersistenceHooks | null,
) {
  const before = await lstat(dirPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw unsafeDirectory(`quota delegate durability target is not a real directory: ${dirPath}`);
  }
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  try {
    handle = await open(dirPath, directoryOpenFlags(hooks));
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.isSymbolicLink()
      || !sameDirectoryIdentity(regularFileGeneration(before), regularFileGeneration(opened))
    ) {
      throw unsafeDirectory(`quota delegate durability directory changed while opening: ${dirPath}`);
    }
    await hooks?.syncDirectory?.({ directory: dirPath, phase });
    await handle.sync();
  } catch (error) {
    primaryError = ["ELOOP", "EMLINK", "ENOTDIR"].includes(errorCode(error))
      ? unsafeDirectory(`refusing unsafe quota delegate durability directory: ${dirPath}`, error)
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
    throw Object.assign(
      new AggregateError([asError(primaryError), asError(closeError)], asError(primaryError).message, {
        cause: asError(primaryError),
      }),
      { code: errorCode(primaryError), primaryError, closeError },
    );
  }
  if (closeError) throw closeError;
}

async function isolateAndRemoveTempDurably({
  filePath,
  tempPath,
  directory,
  expectedGeneration,
  commandDigest,
  hooks,
}: {
  filePath: string;
  tempPath: string;
  directory: string;
  expectedGeneration: RegularFileGeneration;
  commandDigest: string;
  hooks: QuotaDelegateClientPersistenceHooks | null;
}) {
  const isolationPath = `${tempPath}.retired-${randomUUID()}`;
  const context = { filePath, tempPath, isolationPath, commandDigest };
  await hooks?.beforeTempIsolation?.(context);
  let before;
  try {
    before = await lstat(tempPath);
  } catch (error) {
    throw Object.assign(
      delegateClientError(
        `quota delegate temporary generation disappeared before isolation: ${tempPath}`,
        "QUOTA_DELEGATE_TEMP_GENERATION_LOST",
      ),
      {
        cause: error,
        committed: false,
        successorPreserved: errorCode(error) !== "ENOENT",
        recoveryPaths: [tempPath, isolationPath, directory],
      },
    );
  }
  if (
    !before.isFile()
    || before.isSymbolicLink()
    || !sameRegularFileGeneration(expectedGeneration, regularFileGeneration(before))
  ) {
    throw Object.assign(
      delegateClientError(
        `quota delegate temporary successor preserved before isolation: ${tempPath}`,
        "QUOTA_DELEGATE_TEMP_SUCCESSOR_PRESERVED",
      ),
      {
        committed: false,
        successorPreserved: true,
        recoveryPaths: [tempPath, isolationPath, directory],
      },
    );
  }

  try {
    await rename(tempPath, isolationPath);
  } catch (error) {
    throw Object.assign(
      asError(error),
      {
        code: errorCode(error) || "QUOTA_DELEGATE_TEMP_ISOLATION_FAILED",
        committed: false,
        successorPreserved: true,
        recoveryPaths: [tempPath, isolationPath, directory],
      },
    );
  }

  try {
    await syncDirectory(directory, "temp-isolate", hooks);
    await hooks?.afterTempIsolation?.(context);
  } catch (error) {
    throw Object.assign(
      delegateClientError(
        `quota delegate temporary isolation committed with ambiguous durability: ${tempPath}`,
        "QUOTA_DELEGATE_TEMP_ISOLATION_COMMITTED_DURABILITY_AMBIGUOUS",
      ),
      {
        cause: error,
        primaryError: error,
        cleanupErrors: [],
        committed: true,
        committedPath: isolationPath,
        isolationCommitted: true,
        successorPreserved: true,
        recoveryPaths: [tempPath, isolationPath, directory],
      },
    );
  }

  let moved;
  try {
    moved = await lstat(isolationPath);
  } catch (error) {
    throw Object.assign(
      delegateClientError(
        `quota delegate isolated temporary generation disappeared: ${isolationPath}`,
        "QUOTA_DELEGATE_TEMP_ISOLATION_LOST",
      ),
      {
        cause: error,
        committed: true,
        committedPath: isolationPath,
        isolationCommitted: true,
        successorPreserved: true,
        recoveryPaths: [tempPath, isolationPath, directory],
      },
    );
  }
  if (
    !moved.isFile()
    || moved.isSymbolicLink()
    || !sameRegularFileGenerationAcrossRename(expectedGeneration, regularFileGeneration(moved))
  ) {
    throw Object.assign(
      delegateClientError(
        `quota delegate isolated temporary successor preserved: ${isolationPath}`,
        "QUOTA_DELEGATE_TEMP_SUCCESSOR_PRESERVED",
      ),
      {
        committed: true,
        committedPath: isolationPath,
        isolationCommitted: true,
        successorPreserved: true,
        recoveryPaths: [tempPath, isolationPath, directory],
      },
    );
  }

  await hooks?.beforeTempRemoval?.(context);
  const final = await lstat(isolationPath);
  if (
    !final.isFile()
    || final.isSymbolicLink()
    || !sameRegularFileGeneration(regularFileGeneration(moved), regularFileGeneration(final))
  ) {
    throw Object.assign(
      delegateClientError(
        `quota delegate isolated temporary successor preserved before removal: ${isolationPath}`,
        "QUOTA_DELEGATE_TEMP_SUCCESSOR_PRESERVED",
      ),
      {
        committed: true,
        committedPath: isolationPath,
        isolationCommitted: true,
        successorPreserved: true,
        recoveryPaths: [tempPath, isolationPath, directory],
      },
    );
  }

  try {
    await unlink(isolationPath);
  } catch (error) {
    throw Object.assign(asError(error), {
      code: errorCode(error) || "QUOTA_DELEGATE_TEMP_REMOVE_FAILED",
      committed: true,
      committedPath: isolationPath,
      isolationCommitted: true,
      removalCommitted: false,
      recoveryPaths: [tempPath, isolationPath, directory],
    });
  }
  try {
    await syncDirectory(directory, "temp-remove", hooks);
  } catch (error) {
    throw Object.assign(
      delegateClientError(
        `quota delegate temporary removal committed with ambiguous durability: ${isolationPath}`,
        "QUOTA_DELEGATE_TEMP_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS",
      ),
      {
        cause: error,
        primaryError: error,
        cleanupErrors: [],
        committed: true,
        committedPath: isolationPath,
        isolationCommitted: true,
        removalCommitted: true,
        recoveryPaths: [tempPath, isolationPath, directory],
      },
    );
  }
}

async function writeCommandAtomically(hubRoot: string, filePath: string, command: LooseRecord) {
  const dir = path.dirname(filePath);
  const hooks = currentQuotaDelegateClientPersistenceHooks();
  await ensureSafeDirectoryBelow(hubRoot, dir, hooks);
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const commandContent = JSON.stringify(command) + "\n";
  const commandDigest = createHash("sha256").update(commandContent).digest("hex");
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let tempCreated = false;
  let tempGeneration: RegularFileGeneration | null = null;
  let cleanupGeneration: RegularFileGeneration | null = null;
  let committed = false;
  let primaryError: unknown = null;
  try {
    const noFollowFlag = hooks?.resolveNoFollowFlag
      ? hooks.resolveNoFollowFlag()
      : constants.O_NOFOLLOW;
    if (typeof noFollowFlag !== "number" || noFollowFlag === 0) {
      throw delegateClientError(
        "O_NOFOLLOW is unavailable; refusing unsafe quota delegate command publication",
        "QUOTA_DELEGATE_COMMAND_UNSAFE",
      );
    }
    handle = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag,
      0o600,
    );
    tempCreated = true;
    await handle.writeFile(commandContent, "utf8");
    await handle.sync();
    const written = await handle.stat();
    if (!written.isFile() || written.isSymbolicLink() || written.size !== Buffer.byteLength(commandContent)) {
      throw delegateClientError(
        `quota delegate command temporary generation is invalid: ${tmp}`,
        "QUOTA_DELEGATE_COMMAND_UNSAFE",
      );
    }
    tempGeneration = regularFileGeneration(written);
    await handle.close();
    handle = null;
    await hooks?.beforeRename?.({
      filePath,
      tempPath: tmp,
      command,
      commandDigest,
    });
    try {
      await link(tmp, filePath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      throw Object.assign(
        delegateClientError(
          `quota delegate commandId is already in flight: ${stringValue(command.commandId)}`,
          "QUOTA_DELEGATE_COMMAND_ID_CONFLICT",
        ),
        {
          cause: error,
          committed: false,
          publicationKind: "hard-link",
          publicationCommitted: false,
          existingPath: filePath,
          recoveryPaths: [filePath],
          commandId: stringValue(command.commandId),
          mutationId: stringValue(command.mutationId),
          commandDigest,
        },
      );
    }
    committed = true;
    const [publishedTemp, publishedPath] = await Promise.all([lstat(tmp), lstat(filePath)]);
    if (
      !publishedTemp.isFile()
      || publishedTemp.isSymbolicLink()
      || !publishedPath.isFile()
      || publishedPath.isSymbolicLink()
      || !sameRegularFileGeneration(
        regularFileGeneration(publishedTemp),
        regularFileGeneration(publishedPath),
      )
    ) {
      throw Object.assign(
        delegateClientError(
          `quota delegate command publication generation changed: ${filePath}`,
          "QUOTA_DELEGATE_COMMAND_PUBLICATION_CHANGED",
        ),
        {
          committed: true,
          committedPath: filePath,
          successorPreserved: true,
          recoveryPaths: [filePath, tmp, dir],
        },
      );
    }
    cleanupGeneration = regularFileGeneration(publishedTemp);
    await hooks?.afterRename?.({
      filePath,
      tempPath: tmp,
      command,
      commandDigest,
    });
    await syncDirectory(dir, "command-publish", hooks);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: Error[] = [];
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(asError(error));
    }
  }
  const shouldCleanup = committed
    || errorCode(primaryError) === "QUOTA_DELEGATE_COMMAND_ID_CONFLICT";
  if (tempCreated && shouldCleanup && (cleanupGeneration || tempGeneration)) {
    try {
      await isolateAndRemoveTempDurably({
        filePath,
        tempPath: tmp,
        directory: dir,
        expectedGeneration: cleanupGeneration ?? tempGeneration as RegularFileGeneration,
        commandDigest,
        hooks,
      });
    } catch (error) {
      cleanupErrors.push(asError(error));
    }
  }
  const cleanupRecoveryPaths = uniquePaths(cleanupErrors.flatMap(errorRecoveryPaths));
  const cleanupCommitted = cleanupErrors.some(errorIsCommitted);
  if (committed && (primaryError || cleanupErrors.length > 0)) {
    const error = primaryError ? asError(primaryError) : cleanupErrors[0];
    const causes = primaryError ? [error, ...cleanupErrors] : cleanupErrors;
    throw Object.assign(
      new AggregateError(causes, error.message, { cause: error }),
      {
        code: "QUOTA_DELEGATE_COMMAND_COMMITTED_DURABILITY_AMBIGUOUS",
        primaryError: error,
        cleanupErrors,
        committed: true,
        committedPath: filePath,
        publicationKind: "hard-link",
        publicationCommitted: true,
        recoveryPaths: uniquePaths([
          filePath,
          dir,
          ...(cleanupErrors.length > 0 ? [tmp] : []),
          ...cleanupRecoveryPaths,
        ]),
        commandId: stringValue(command.commandId),
        mutationId: stringValue(command.mutationId),
        commandDigest,
      },
    );
  }
  if (primaryError) {
    const error = asError(primaryError);
    if (!tempCreated || shouldCleanup) {
      if (cleanupErrors.length === 0) throw error;
      throw Object.assign(new AggregateError([error, ...cleanupErrors], error.message, { cause: error }), {
        code: cleanupCommitted
          ? "QUOTA_DELEGATE_COMMAND_CLEANUP_COMMITTED_DURABILITY_AMBIGUOUS"
          : errorCode(error),
        primaryError: error,
        cleanupErrors,
        committed: false,
        publicationKind: "hard-link",
        publicationCommitted: false,
        cleanupCommitted,
        ...(cleanupCommitted
          ? { cleanupCommittedPath: cleanupErrors.map(errorCommittedPath).find(Boolean) }
          : {}),
        recoveryPaths: uniquePaths([
          ...errorRecoveryPaths(error),
          ...cleanupRecoveryPaths,
          ...(cleanupErrors.length > 0 ? [tmp, dir] : []),
        ]),
        commandId: stringValue(command.commandId),
        mutationId: stringValue(command.mutationId),
        commandDigest,
      });
    }
    throw Object.assign(
      new AggregateError([error, ...cleanupErrors], error.message, { cause: error }),
      {
        code: "QUOTA_DELEGATE_COMMAND_RECOVERY_REQUIRED",
        primaryError: error,
        cleanupErrors,
        committed: false,
        publicationKind: "hard-link",
        publicationCommitted: false,
        successorPreserved: true,
        recoveryPaths: uniquePaths([tmp, filePath, dir, ...errorRecoveryPaths(error)]),
        commandId: stringValue(command.commandId),
        mutationId: stringValue(command.mutationId),
        commandDigest,
      },
    );
  }
  if (cleanupErrors.length > 0) {
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    throw new AggregateError(cleanupErrors, "quota delegate command cleanup failed");
  }
}

export async function appendCommand(hubRoot: string, command: { commandId: string } & LooseRecord) {
  const root = normalizedHubRoot(hubRoot);
  await assertHubWritable(root);
  const commandId = stringValue(command.commandId);
  const mutationId = stringValue(command.mutationId);
  if (!SAFE_COMMAND_ID.test(commandId) || !SAFE_COMMAND_ID.test(mutationId)) {
    throw delegateClientError("quota delegate commandId and mutationId must be safe non-empty identifiers", "QUOTA_DELEGATE_COMMAND_INVALID");
  }
  await writeCommandAtomically(root, commandFilePath(root, commandId), command);
}

// ─── Ack Polling ─────────────────────────────────────────────────────

export async function waitForAck(hubRoot: string, commandId: string, timeoutMs = ACK_TIMEOUT_MS) {
  const root = normalizedHubRoot(hubRoot);
  if (!SAFE_COMMAND_ID.test(commandId)) {
    throw delegateClientError("quota delegate commandId must be a safe non-empty identifier", "QUOTA_DELEGATE_COMMAND_INVALID");
  }
  const ackPath = ackFilePath(root, commandId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await assertSafeExistingDirectoryBelow(
        root,
        path.dirname(ackPath),
        currentQuotaDelegateClientPersistenceHooks(),
      );
      const content = await readRegularFileNoFollow(ackPath, "quota delegate ack", "QUOTA_DELEGATE_ACK_INVALID");
      let ack: Record<string, unknown>;
      try {
        ack = recordValue(JSON.parse(content));
      } catch (error) {
        throw Object.assign(delegateClientError("quota delegate ack contains invalid JSON", "QUOTA_DELEGATE_ACK_INVALID"), {
          cause: error,
        });
      }
      if (
        stringValue(ack.commandId) !== commandId
        || stringValue(ack.mutationId) !== commandId
        || !stringValue(ack.hubRoot)
        || normalizedHubRoot(stringValue(ack.hubRoot)) !== root
        || !stringValue(ack.ts)
        || typeof ack.ok !== "boolean"
      ) {
        throw delegateClientError("quota delegate ack fields do not match the requested command", "QUOTA_DELEGATE_ACK_INVALID");
      }
      return ack;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
      await new Promise((r) => setTimeout(r, ACK_POLL_MS));
    }
  }
  return null;
}

// ─── Delegate Liveness ───────────────────────────────────────────────

function delegateClientError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseQuotaDelegateLockReceipt(raw: string, expectedHubRoot?: string): QuotaDelegateLockReceipt {
  let lock: Record<string, unknown>;
  try {
    lock = recordValue(JSON.parse(raw));
  } catch (error) {
    throw Object.assign(
      delegateClientError("quota delegate lock contains invalid JSON", "QUOTA_DELEGATE_LOCK_INVALID"),
      { cause: error },
    );
  }
  const processIdentity = recordValue(lock.processIdentity);
  const pid = numberValue(lock.pid);
  const identityPid = numberValue(processIdentity.pid);
  const ownerToken = stringValue(lock.ownerToken);
  const generation = stringValue(lock.generation);
  const hubRootValue = stringValue(lock.hubRoot);
  const startedAt = stringValue(lock.startedAt);
  const birthId = stringValue(processIdentity.birthId);
  const identityIncarnation = stringValue(processIdentity.incarnation);
  const capturedAt = stringValue(processIdentity.capturedAt);
  const birthIdPrecision = processIdentity.birthIdPrecision;
  const processGroupId = processIdentity.processGroupId;
  const incarnation = stringValue(lock.incarnation);
  if (
    !pid
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || !identityPid
    || !Number.isSafeInteger(identityPid)
    || identityPid <= 0
    || !ownerToken
    || !generation
    || !hubRootValue
    || !startedAt
    || Number.isNaN(Date.parse(startedAt))
    || new Date(Date.parse(startedAt)).toISOString() !== startedAt
    || !birthId
    || birthIdPrecision !== "exact"
    || !identityIncarnation
    || !capturedAt
    || Number.isNaN(Date.parse(capturedAt))
    || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
    || !incarnation
    || (processGroupId !== undefined && (!Number.isSafeInteger(processGroupId) || Number(processGroupId) <= 0))
  ) {
    throw delegateClientError("quota delegate lock is missing required owner fields", "QUOTA_DELEGATE_LOCK_INVALID");
  }
  if (pid !== identityPid || incarnation !== identityIncarnation) {
    throw delegateClientError("quota delegate lock identity fields do not agree", "QUOTA_DELEGATE_LOCK_INVALID");
  }
  if (identityIncarnation !== `${identityPid}:${birthId}`) {
    throw delegateClientError("quota delegate lock process identity is malformed", "QUOTA_DELEGATE_LOCK_INVALID");
  }
  if (expectedHubRoot && normalizedHubRoot(hubRootValue) !== normalizedHubRoot(expectedHubRoot)) {
    throw delegateClientError("quota delegate lock is bound to a different hub root", "QUOTA_DELEGATE_LOCK_INVALID");
  }
  return {
    pid,
    hubRoot: hubRootValue,
    startedAt,
    ownerToken,
    generation,
    processIdentity: {
      pid: identityPid,
      birthId,
      incarnation: identityIncarnation,
      capturedAt,
      birthIdPrecision: "exact",
      ...(processGroupId === undefined ? {} : { processGroupId: Number(processGroupId) }),
    },
    incarnation,
  };
}

export async function readQuotaDelegateLockReceipt(hubRoot: string): Promise<QuotaDelegateLockReceipt | null> {
  const root = normalizedHubRoot(hubRoot);
  try {
    await assertSafeExistingDirectoryBelow(
      root,
      path.dirname(lockFilePath(root)),
      currentQuotaDelegateClientPersistenceHooks(),
    );
    return parseQuotaDelegateLockReceipt(
      await readRegularFileNoFollow(
        lockFilePath(root),
        "quota delegate lock",
        "QUOTA_DELEGATE_LOCK_INVALID",
      ),
      root,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
}

function expectedIdentity(expected?: ProcessIdentity | QuotaDelegateLockReceipt | null) {
  if (!expected) return null;
  if ("processIdentity" in expected) return expected.processIdentity;
  return expected;
}

function expectedToken(expected?: ProcessIdentity | QuotaDelegateLockReceipt | null) {
  return expected && "ownerToken" in expected ? expected.ownerToken : null;
}

async function readQuotaDelegateLockForLiveness(hubRoot: string) {
  try {
    return await readQuotaDelegateLockReceipt(hubRoot);
  } catch (error) {
    if (errorCode(error) === "QUOTA_DELEGATE_LOCK_INVALID") return null;
    throw error;
  }
}

export async function isDelegateIncarnationAlive(
  hubRoot: string,
  expected: ProcessIdentity | QuotaDelegateLockReceipt,
) {
  const lock = await readQuotaDelegateLockForLiveness(hubRoot);
  if (!lock) return false;
  const identity = expectedIdentity(expected);
  const token = expectedToken(expected);
  if (token && lock.ownerToken !== token) return false;
  if (identity && !sameProcessIdentity(lock.processIdentity, identity)) return false;
  return isProcessIdentityAlive(lock.processIdentity);
}

export async function waitForDelegateIncarnation(
  hubRoot: string,
  expected: ProcessIdentity | QuotaDelegateLockReceipt,
  timeoutMs = ACK_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await readQuotaDelegateLockForLiveness(hubRoot);
    if (lock) {
      const identity = expectedIdentity(expected);
      const token = expectedToken(expected);
      if (
        (!token || lock.ownerToken === token)
        && (!identity || sameProcessIdentity(lock.processIdentity, identity))
        && isProcessIdentityAlive(lock.processIdentity)
      ) {
        return lock;
      }
    }
    await new Promise((r) => setTimeout(r, ACK_POLL_MS));
  }
  return null;
}

export async function isDelegateAlive(hubRoot: string) {
  const lock = await readQuotaDelegateLockForLiveness(hubRoot);
  if (!lock) return false;
  return isProcessIdentityAlive(lock.processIdentity);
}

// ─── High-Level APIs ─────────────────────────────────────────────────

/**
 * Mark a provider as unavailable via the delegate.
 * Strong ack: blocks until delegate confirms the quota write.
 * Fails closed: returns null if delegate is unavailable (no fallback).
 */
export async function delegateMarkProviderUnavailable(
  hubRoot: string,
  opts: ProviderUnavailablePublicInput,
  ackTimeoutMs?: number,
): Promise<ProviderQuotaEntry> {
  const commandId = randomUUID();
  const command = {
    commandId,
    mutationId: commandId,
    type: "quota_write",
    ts: new Date().toISOString(),
    providerKey: opts.providerKey,
    entry: {
      agent: opts.agent,
      variant: opts.variant || null,
      status: opts.status,
      ...(opts.nextEligibleAt == null ? {} : { nextEligibleAt: opts.nextEligibleAt }),
      source: opts.source || "delegate-client",
      confidence: opts.confidence ?? 1,
      reason: opts.reason || "",
    },
  };

  await appendCommand(hubRoot, command);
  const ack = await waitForAck(hubRoot, commandId, ackTimeoutMs || ACK_TIMEOUT_MS);
  if (!ack?.ok) {
    // retain: dynamic property augmentation on Error — TS idiom for attaching `.code`; no narrower/guard applies, subclass would be over-engineering for a single use site
    const err = new Error("quota delegate unavailable; provider state not recorded") as Error & { code?: string };
    err.code = "QUOTA_DELEGATE_UNAVAILABLE";
    throw err;
  }
  return recordValue(ack.entry) as ProviderQuotaEntry;
}

/**
 * Enqueue a usage record via the delegate.
 * Fire-and-forget: no ack, no waiting.
 */
export async function delegateEnqueueProviderUsage(
  hubRoot: string,
  record: ProviderUsagePublicInput,
): Promise<void> {
  const commandId = randomUUID();
  const recordedAt = new Date().toISOString();
  const command = {
    commandId,
    mutationId: commandId,
    type: "usage_write",
    ts: recordedAt,
    record: {
      project: record.project || null,
      jobId: record.jobId || null,
      attemptId: record.attemptId || null,
      taskCategory: record.taskCategory || null,
      issueNumber: record.issueNumber ?? null,
      attempt: record.attempt ?? null,
      retryCount: record.retryCount ?? 0,
      jobRetryCount: record.jobRetryCount ?? 0,
      phaseRetryCount: record.phaseRetryCount ?? 0,
      isRetry: record.isRetry === true,
      phase: record.phase,
      role: record.role || null,
      providerKey: record.providerKey,
      agent: record.agent,
      variant: record.variant || null,
      providerRegion: record.providerRegion || null,
      providerAdapter: record.providerAdapter || null,
      status: record.status,
      phaseStatus: record.phaseStatus,
      failureKind: record.failureKind || null,
      durationMs: record.durationMs ?? null,
      quota: record.quota || null,
      usage: record.usage || null,
      fallback: record.fallback || null,
      providerAttempts: record.providerAttempts || null,
      source: record.source || null,
      recordedAt,
    },
  };

  await appendCommand(hubRoot, command);
}
