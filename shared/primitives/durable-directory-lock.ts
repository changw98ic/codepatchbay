/** Shared, implementation-layer-independent durable directory locking primitive. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  type ProcessIdentity,
} from "./process-tree.js";

const OWNER_FORMAT = "cpb-directory-lock/v1";
const OWNER_MAX_BYTES = 64 * 1024;

let cachedCurrentLockIdentity: ProcessIdentity | null = null;

function captureCurrentLockIdentity() {
  if (!cachedCurrentLockIdentity) {
    cachedCurrentLockIdentity = captureProcessIdentity(process.pid, { strict: true });
  }
  return cachedCurrentLockIdentity ? { ...cachedCurrentLockIdentity } : null;
}

type DirectoryLockOwner = {
  format: typeof OWNER_FORMAT;
  ownerToken: string;
  lockPath: string;
  pid: number;
  host: string;
  acquiredAt: string;
  processIdentity: ProcessIdentity;
};

type DirectoryGeneration = {
  dev: bigint | number;
  ino: bigint | number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type LockCandidate = {
  owner: DirectoryLockOwner | null;
  lockIdentity: DirectoryGeneration;
  kind: "stale" | "incomplete" | "released";
};

export type DurableDirectoryLockHooks = {
  resolveDirectoryOpenFlags?: () => number | undefined;
  beforeOwnerPublish?: (context: {
    lockDir: string;
    ownerFile: string;
    tempPath: string;
    ownerToken: string;
  }) => void | Promise<void>;
  beforeOwnerDirectorySync?: (context: {
    directory: string;
    lockDir: string;
    ownerFile: string;
    phase: "owner-publish" | "lock-directory-publish";
  }) => void | Promise<void>;
  afterRecoveryObserved?: (context: {
    lockDir: string;
    ownerToken: string | null;
    kind: LockCandidate["kind"];
  }) => void | Promise<void>;
  afterQuarantineRename?: (context: {
    lockDir: string;
    quarantineDir: string;
    ownerToken: string | null;
    kind: LockCandidate["kind"];
  }) => void | Promise<void>;
  beforeQuarantineRename?: (context: {
    lockDir: string;
    quarantineDir: string;
    ownerToken: string | null;
    kind: LockCandidate["kind"];
  }) => void | Promise<void>;
  beforeDirectorySync?: (context: {
    directory: string;
    lockDir: string;
    quarantineDir: string;
    phase: "quarantine-rename" | "quarantine-remove";
  }) => void | Promise<void>;
  beforeRelease?: (context: { lockDir: string; ownerToken: string }) => void | Promise<void>;
};

export type DurableDirectoryLockOptions = {
  ttlMs?: number;
  waitMs?: number;
  retryMs?: number;
  signal?: AbortSignal;
  hooks?: DurableDirectoryLockHooks;
  identityAlive?: (identity: ProcessIdentity) => boolean;
  captureIdentity?: () => ProcessIdentity | null;
};

export type BoundedRegularFileReadHooks = {
  afterOpen?: (context: { filePath: string; size: number }) => void | Promise<void>;
  afterChunk?: (context: { filePath: string; bytesRead: number; totalBytes: number }) => void | Promise<void>;
  beforePathGenerationCheck?: (context: { filePath: string; totalBytes: number }) => void | Promise<void>;
};

export type BoundedRegularFileReadOptions = {
  maxBytes: number;
  hooks?: BoundedRegularFileReadHooks;
};

type BoundedFileErrorCode =
  | "BOUNDED_FILE_UNSAFE"
  | "BOUNDED_FILE_TOO_LARGE"
  | "BOUNDED_FILE_CHANGED"
  | "BOUNDED_FILE_READ_FAILED";

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function lockError(message: string, code: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function boundedFileError(message: string, code: BoundedFileErrorCode, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function sameFileGeneration(
  expected: {
    dev: bigint | number;
    ino: bigint | number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
  },
  actual: {
    dev: bigint | number;
    ino: bigint | number;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    birthtimeMs: number;
  },
) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.ctimeMs === actual.ctimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

function sameFileGenerationAcrossRename(
  expected: {
    dev: bigint | number;
    ino: bigint | number;
    size: number;
    mtimeMs: number;
    birthtimeMs: number;
  },
  actual: {
    dev: bigint | number;
    ino: bigint | number;
    size: number;
    mtimeMs: number;
    birthtimeMs: number;
  },
) {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeMs === actual.mtimeMs
    && expected.birthtimeMs === actual.birthtimeMs;
}

/**
 * Read a small lock/owner metadata file through a pinned descriptor.
 *
 * The path is checked before opening, the descriptor is checked after opening
 * and after every read, and the path is checked again while the descriptor is
 * still open. Reading is capped at maxBytes + 1 so an attacker cannot grow a
 * file after the initial size check and turn this into an unbounded read.
 */
export async function readBoundedRegularFileNoFollow(
  filePath: string,
  { maxBytes, hooks }: BoundedRegularFileReadOptions,
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError("maxBytes must be a non-negative safe integer");
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw boundedFileError(
      `no-follow file opens are unavailable for bounded read: ${filePath}`,
      "BOUNDED_FILE_UNSAFE",
    );
  }

  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw boundedFileError(`bounded read requires a regular file: ${filePath}`, "BOUNDED_FILE_UNSAFE");
  }
  if (before.size > maxBytes) {
    throw boundedFileError(`file exceeds ${maxBytes} byte limit: ${filePath}`, "BOUNDED_FILE_TOO_LARGE");
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(errorCode(error))) {
      throw boundedFileError(`symbolic-link file rejected during bounded read: ${filePath}`, "BOUNDED_FILE_UNSAFE", error);
    }
    throw error;
  }

  let primaryError: unknown = null;
  let value = "";
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileGeneration(before, opened)) {
      throw boundedFileError(`file changed while opening for bounded read: ${filePath}`, "BOUNDED_FILE_CHANGED");
    }
    await hooks?.afterOpen?.({ filePath, size: opened.size });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = maxBytes + 1 - totalBytes;
      if (remaining <= 0) {
        throw boundedFileError(`file exceeds ${maxBytes} byte limit: ${filePath}`, "BOUNDED_FILE_TOO_LARGE");
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, totalBytes);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw boundedFileError(`file exceeds ${maxBytes} byte limit: ${filePath}`, "BOUNDED_FILE_TOO_LARGE");
      }
      if (totalBytes > opened.size) {
        throw boundedFileError(`file grew during bounded read: ${filePath}`, "BOUNDED_FILE_CHANGED");
      }
      chunks.push(chunk.subarray(0, bytesRead));
      await hooks?.afterChunk?.({ filePath, bytesRead, totalBytes });
      const observed = await handle.stat();
      if (!observed.isFile() || !sameFileGeneration(opened, observed)) {
        throw boundedFileError(`file changed during bounded read: ${filePath}`, "BOUNDED_FILE_CHANGED");
      }
    }

    const afterDescriptor = await handle.stat();
    if (!afterDescriptor.isFile() || !sameFileGeneration(opened, afterDescriptor)) {
      throw boundedFileError(`file changed after bounded descriptor read: ${filePath}`, "BOUNDED_FILE_CHANGED");
    }
    await hooks?.beforePathGenerationCheck?.({ filePath, totalBytes });
    let afterPath;
    try {
      afterPath = await lstat(filePath);
    } catch (error) {
      throw boundedFileError(`file path disappeared after bounded read: ${filePath}`, "BOUNDED_FILE_CHANGED", error);
    }
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || !sameFileGeneration(opened, afterPath)) {
      throw boundedFileError(`file path changed after bounded read: ${filePath}`, "BOUNDED_FILE_CHANGED");
    }
    value = Buffer.concat(chunks, totalBytes).toString("utf8");
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
    throw Object.assign(
      new AggregateError([primaryError, closeError], `bounded file read and close failed: ${filePath}`, {
        cause: primaryError,
      }),
      { code: errorCode(primaryError) || "BOUNDED_FILE_READ_FAILED", primaryError, closeError },
    );
  }
  if (closeError) {
    throw boundedFileError(`bounded file close failed: ${filePath}`, "BOUNDED_FILE_READ_FAILED", closeError);
  }
  return value;
}

function abortError(signal: AbortSignal) {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return Object.assign(new Error("directory lock operation aborted", { cause: reason }), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}

async function delay(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => finish(() => reject(signal ? abortError(signal) : new Error("aborted")));
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function strictDirectoryOpenFlags(resolveFlags?: () => number | undefined) {
  const flags = resolveFlags
    ? resolveFlags()
    : typeof constants.O_NOFOLLOW === "number"
      && constants.O_NOFOLLOW !== 0
      && typeof constants.O_DIRECTORY === "number"
      && constants.O_DIRECTORY !== 0
      ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY
      : undefined;
  if (
    typeof flags !== "number"
    || flags === 0
    || (flags & constants.O_NOFOLLOW) !== constants.O_NOFOLLOW
    || (flags & constants.O_DIRECTORY) !== constants.O_DIRECTORY
  ) {
    throw lockError(
      "strict no-follow directory opens are unavailable",
      "DIRECTORY_LOCK_DIRECTORY_UNSAFE",
    );
  }
  return flags;
}

function sameDirectoryDescriptorIdentity(
  left: { dev: bigint | number; ino: bigint | number; birthtimeMs: number },
  right: { dev: bigint | number; ino: bigint | number; birthtimeMs: number },
) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && left.birthtimeMs === right.birthtimeMs;
}

async function syncDirectory(
  directory: string,
  beforeSync?: () => void | Promise<void>,
  resolveFlags?: () => number | undefined,
) {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let primaryError: unknown = null;
  try {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw lockError(`unsafe directory sync target: ${directory}`, "DIRECTORY_LOCK_DIRECTORY_UNSAFE");
    }
    handle = await open(directory, strictDirectoryOpenFlags(resolveFlags));
    const opened = await handle.stat();
    if (
      !opened.isDirectory()
      || opened.isSymbolicLink()
      || !sameDirectoryDescriptorIdentity(before, opened)
    ) {
      throw lockError(`directory changed while opening for sync: ${directory}`, "DIRECTORY_LOCK_DIRECTORY_UNSAFE");
    }
    await beforeSync?.();
    await handle.sync();
  } catch (error) {
    primaryError = ["ELOOP", "EMLINK", "ENOTDIR"].includes(errorCode(error))
      ? lockError(`unsafe directory sync target: ${directory}`, "DIRECTORY_LOCK_DIRECTORY_UNSAFE", error)
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
      new AggregateError([primaryError, closeError], `directory sync and close failed: ${directory}`, {
        cause: primaryError,
      }),
      { code: errorCode(primaryError) || "DIRECTORY_LOCK_DIRECTORY_SYNC_FAILED", primaryError, closeError },
    );
  }
  if (closeError) throw closeError;
}

function committedOwnerPublishError(
  message: string,
  code: "DIRECTORY_LOCK_OWNER_COMMITTED_AMBIGUOUS" | "DIRECTORY_LOCK_ACQUIRE_COMMITTED_AMBIGUOUS",
  ownerFile: string,
  cause: unknown,
) {
  const lockDir = path.dirname(ownerFile);
  return Object.assign(lockError(message, code, cause), {
    committed: true,
    phase: "owner-publish",
    committedPath: ownerFile,
    recoveryPaths: { lockDir, ownerFile },
  });
}

function isCommittedOwnerPublishError(error: unknown) {
  return Boolean(error && typeof error === "object" && "committed" in error && (error as { committed?: unknown }).committed === true);
}

async function writeOwnerDurable(
  ownerFile: string,
  owner: DirectoryLockOwner,
  hooks?: DurableDirectoryLockHooks,
) {
  const parent = path.dirname(ownerFile);
  const tempPath = path.join(parent, `.owner-${owner.ownerToken}-${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let tempCreated = false;
  let tempGeneration: Awaited<ReturnType<typeof lstat>> | null = null;
  let renamed = false;
  let primaryError: unknown = null;
  try {
    if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
      throw lockError(
        `strict no-follow owner publication is unavailable: ${ownerFile}`,
        "DIRECTORY_LOCK_OWNER_UNSAFE",
      );
    }
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    tempCreated = true;
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
    await handle.sync();
    tempGeneration = await handle.stat();
    if (!tempGeneration.isFile() || tempGeneration.isSymbolicLink()) {
      throw lockError(`unsafe directory lock owner temporary file: ${tempPath}`, "DIRECTORY_LOCK_OWNER_UNSAFE");
    }
    await handle.close();
    handle = null;
    await hooks?.beforeOwnerPublish?.({
      lockDir: parent,
      ownerFile,
      tempPath,
      ownerToken: owner.ownerToken,
    });
    const beforeRename = await lstat(tempPath);
    if (
      !beforeRename.isFile()
      || beforeRename.isSymbolicLink()
      || !tempGeneration
      || !sameFileGeneration(tempGeneration, beforeRename)
    ) {
      throw lockError(
        `directory lock owner temporary generation changed before publication: ${tempPath}`,
        "DIRECTORY_LOCK_OWNER_UNSAFE",
      );
    }
    await rename(tempPath, ownerFile);
    renamed = true;
    const published = await lstat(ownerFile);
    if (
      !published.isFile()
      || published.isSymbolicLink()
      || !sameFileGenerationAcrossRename(beforeRename, published)
      || !sameOwner(owner, await readOwner(ownerFile))
    ) {
      throw lockError(
        `directory lock owner generation changed during publication: ${ownerFile}`,
        "DIRECTORY_LOCK_OWNER_UNSAFE",
      );
    }
    await hooks?.beforeOwnerDirectorySync?.({
      directory: parent,
      lockDir: parent,
      ownerFile,
      phase: "owner-publish",
    });
    await syncDirectory(parent, undefined, hooks?.resolveDirectoryOpenFlags);
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
    : new AggregateError(errors, `directory lock owner write and close failed: ${ownerFile}`, {
      cause: primaryError ?? errors[0],
    });
  if (renamed) {
    throw committedOwnerPublishError(
      `directory lock owner committed with ambiguous durability: ${ownerFile}`,
      "DIRECTORY_LOCK_OWNER_COMMITTED_AMBIGUOUS",
      ownerFile,
      cause,
    );
  }
  throw Object.assign(
    lockError(
      tempCreated
        ? `directory lock owner publication failed; temporary generation retained: ${tempPath}`
        : `directory lock owner publication failed before temporary creation: ${ownerFile}`,
      "DIRECTORY_LOCK_OWNER_RECOVERY_REQUIRED",
      cause,
    ),
    {
      committed: false,
      publicationKind: "rename",
      publicationCommitted: false,
      tempPreserved: tempCreated,
      recoveryPaths: { lockDir: parent, ownerFile, ...(tempCreated ? { tempPath } : {}) },
    },
  );
}

function processIdentity(value: unknown, expectedPid: number): ProcessIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ProcessIdentity>;
  if (
    !Number.isSafeInteger(candidate.pid)
    || candidate.pid !== expectedPid
    || typeof candidate.birthId !== "string"
    || !candidate.birthId
    || candidate.incarnation !== `${candidate.pid}:${candidate.birthId}`
    || typeof candidate.capturedAt !== "string"
    || !Number.isFinite(Date.parse(candidate.capturedAt))
    || new Date(Date.parse(candidate.capturedAt)).toISOString() !== candidate.capturedAt
    || candidate.birthIdPrecision !== "exact"
    || (candidate.processGroupId !== undefined
      && (!Number.isSafeInteger(candidate.processGroupId) || Number(candidate.processGroupId) <= 0))
  ) return null;
  const identity: ProcessIdentity = {
    pid: candidate.pid,
    birthId: candidate.birthId,
    incarnation: candidate.incarnation,
    capturedAt: candidate.capturedAt,
    birthIdPrecision: "exact",
  };
  if (candidate.processGroupId !== undefined) identity.processGroupId = Number(candidate.processGroupId);
  return identity;
}

async function readOwner(ownerFile: string): Promise<DirectoryLockOwner | null> {
  try {
    const raw = await readBoundedRegularFileNoFollow(ownerFile, { maxBytes: OWNER_MAX_BYTES });
    const parsed = JSON.parse(raw) as Partial<DirectoryLockOwner>;
    if (
      parsed.format !== OWNER_FORMAT
      || typeof parsed.ownerToken !== "string"
      || !parsed.ownerToken
      || typeof parsed.lockPath !== "string"
      || !parsed.lockPath
      || !Number.isSafeInteger(parsed.pid)
      || Number(parsed.pid) <= 0
      || typeof parsed.host !== "string"
      || !parsed.host
      || typeof parsed.acquiredAt !== "string"
      || Number.isNaN(new Date(parsed.acquiredAt).getTime())
      || new Date(Date.parse(parsed.acquiredAt)).toISOString() !== parsed.acquiredAt
      || !processIdentity(parsed.processIdentity, Number(parsed.pid))
    ) throw lockError(`malformed directory lock owner: ${ownerFile}`, "DIRECTORY_LOCK_UNSAFE");
    return parsed as DirectoryLockOwner;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (errorCode(error).startsWith("BOUNDED_FILE_")) {
      throw lockError(`unsafe directory lock owner file: ${ownerFile}`, "DIRECTORY_LOCK_UNSAFE", error);
    }
    if (error instanceof SyntaxError) {
      throw lockError(`malformed directory lock owner JSON: ${ownerFile}`, "DIRECTORY_LOCK_UNSAFE", error);
    }
    throw error;
  }
}

function sameOwner(expected: DirectoryLockOwner | null, actual: DirectoryLockOwner | null) {
  if (!expected || !actual) return expected === actual;
  if (
    expected.format !== actual.format
    || expected.ownerToken !== actual.ownerToken
    || expected.lockPath !== actual.lockPath
    || expected.pid !== actual.pid
    || expected.host !== actual.host
    || expected.acquiredAt !== actual.acquiredAt
  ) return false;
  return expected.processIdentity.pid === actual.processIdentity.pid
    && expected.processIdentity.birthId === actual.processIdentity.birthId
    && expected.processIdentity.incarnation === actual.processIdentity.incarnation
    && expected.processIdentity.capturedAt === actual.processIdentity.capturedAt
    && expected.processIdentity.birthIdPrecision === actual.processIdentity.birthIdPrecision
    && expected.processIdentity.processGroupId === actual.processIdentity.processGroupId;
}

async function ownerLockPathMatchesDirectory(ownerLockPath: string, lockDir: string) {
  if (typeof ownerLockPath !== "string" || !ownerLockPath.trim()) return false;
  const expected = path.resolve(lockDir);
  const actual = path.resolve(ownerLockPath);
  if (path.basename(actual) !== path.basename(expected)) return false;
  try {
    const expectedParent = await realpath(path.dirname(expected));
    const actualParent = await realpath(path.dirname(actual));
    return actualParent === expectedParent;
  } catch {
    return false;
  }
}

const FENCE_PROTOCOL = "cpb-directory-lock-fence/v2 ";

function fenceIdentity(lockDir: string) {
  return createHash("sha256")
    .update(`${path.resolve(lockDir)}\0durable-directory-lock-fence-v2`)
    .digest("hex");
}

function fencePorts(fenceKey: string) {
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

async function probeProcessFence(
  port: number,
  expectedKey: string,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<"same" | "other" | "indeterminate"> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.unref();
    let settled = false;
    let response = "";
    const finish = (result: "same" | "other" | "indeterminate", error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish("indeterminate", signal ? abortError(signal) : new Error("aborted"));
    const timer = setTimeout(
      () => finish("indeterminate"),
      Math.max(1, Math.min(250, deadlineAt - Date.now())),
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline >= 0) {
        finish(response.slice(0, newline) === `${FENCE_PROTOCOL}${expectedKey}` ? "same" : "other");
      } else if (response.length > FENCE_PROTOCOL.length && !response.startsWith(FENCE_PROTOCOL)) {
        finish("other");
      }
    });
    socket.on("end", () => {
      const line = response.trim();
      finish(line === `${FENCE_PROTOCOL}${expectedKey}` ? "same" : line ? "other" : "indeterminate");
    });
    socket.on("error", () => finish("indeterminate"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function acquireProcessFence(lockDir: string, deadlineAt: number, signal?: AbortSignal) {
  const fenceKey = fenceIdentity(lockDir);
  const ports = fencePorts(fenceKey);
  for (;;) {
    throwIfAborted(signal);
    let contention = false;
    for (const port of ports) {
      const server = net.createServer((socket) => {
        socket.on("error", () => undefined);
        socket.end(`${FENCE_PROTOCOL}${fenceKey}\n`);
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
          let closeError: unknown = null;
          try {
            await new Promise<void>((resolve, reject) => {
              server.close((error) => error ? reject(error) : resolve());
            });
          } catch (error) {
            closeError = error;
          }
          if (runtimeError || closeError) {
            throw lockError(
              `directory lock process fence release failed on 127.0.0.1:${port}`,
              "DIRECTORY_LOCK_FENCE_RELEASE_FAILED",
              new AggregateError(
                [runtimeError, closeError].filter((error) => error !== null),
                `directory lock process fence release failed on 127.0.0.1:${port}`,
              ),
            );
          }
        };
      }
      if (listenError.code !== "EADDRINUSE") {
        throw lockError(
          `directory lock process fence acquisition failed on 127.0.0.1:${port}`,
          "DIRECTORY_LOCK_FENCE_FAILED",
          listenError,
        );
      }
      const probe = await probeProcessFence(port, fenceKey, deadlineAt, signal);
      if (probe === "other") continue;
      contention = true;
      break;
    }
    if (Date.now() >= deadlineAt) {
      throw lockError(
        contention
          ? `directory lock process fence busy: ${lockDir}`
          : `directory lock process fence namespace exhausted: ${lockDir}`,
        contention ? "DIRECTORY_LOCK_BUSY" : "DIRECTORY_LOCK_FENCE_FAILED",
      );
    }
    await delay(Math.min(10, Math.max(1, deadlineAt - Date.now())), signal);
  }
}

async function withProcessFence<T>(
  lockDir: string,
  deadlineAt: number,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
) {
  const releaseFence = await acquireProcessFence(lockDir, deadlineAt, signal);
  let value: T | undefined;
  let primaryError: unknown = null;
  try {
    value = await operation();
  } catch (error) {
    primaryError = error;
  }
  let releaseError: unknown = null;
  try {
    await releaseFence();
  } catch (error) {
    releaseError = error;
  }
  if (primaryError) {
    if (!releaseError) throw primaryError;
    throw lockError(
      `directory lock operation and process-fence release failed: ${lockDir}`,
      "DIRECTORY_LOCK_FENCE_FAILED",
      new AggregateError([primaryError, releaseError], "directory lock operation and process-fence release failed", {
        cause: primaryError,
      }),
    );
  }
  if (releaseError) throw releaseError;
  return value as T;
}

export async function withDirectoryProcessFence<T>(
  lockPath: string,
  operation: () => Promise<T>,
  {
    waitMs = 10_000,
    signal,
  }: { waitMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  if (typeof lockPath !== "string" || !lockPath.trim()) {
    throw new TypeError("directory process fence path must be a non-empty string");
  }
  if (!Number.isFinite(waitMs) || waitMs <= 0) {
    throw new TypeError("directory process fence waitMs must be a finite positive value");
  }
  const requestedLockDir = path.resolve(lockPath);
  const lockBase = path.basename(requestedLockDir);
  if (
    requestedLockDir === path.parse(requestedLockDir).root
    || (!lockBase.endsWith(".lock") && !lockBase.startsWith(".lock-"))
  ) {
    throw lockError(`unsafe directory process fence target: ${requestedLockDir}`, "DIRECTORY_LOCK_PATH_INVALID");
  }
  await mkdir(path.dirname(requestedLockDir), { recursive: true });
  const lockDir = path.join(await realpath(path.dirname(requestedLockDir)), path.basename(requestedLockDir));
  return withProcessFence(lockDir, Date.now() + waitMs, signal, operation);
}

type CandidateGenerationObservation = {
  state: "match" | "mismatch" | "missing" | "unavailable";
  lockIdentity?: DirectoryGeneration;
  ownerToken?: string | null;
  cause?: unknown;
};

function directoryGeneration(info: DirectoryGeneration): DirectoryGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    birthtimeMs: info.birthtimeMs,
  };
}

function sameDirectoryGeneration(expected: DirectoryGeneration, actual: DirectoryGeneration) {
  return String(actual.dev) === String(expected.dev)
    && String(actual.ino) === String(expected.ino)
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.ctimeMs === expected.ctimeMs
    && actual.birthtimeMs === expected.birthtimeMs;
}

// A rename within the same parent legitimately advances the directory ctime.
// Everything else in this identity remains pinned across that rename and lets
// us distinguish the observed candidate from a successor moved by an ABA race.
function sameMovedDirectoryGeneration(expected: DirectoryGeneration, actual: DirectoryGeneration) {
  return String(actual.dev) === String(expected.dev)
    && String(actual.ino) === String(expected.ino)
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
    && actual.birthtimeMs === expected.birthtimeMs;
}

function candidateGenerationMatches(
  candidate: LockCandidate,
  info: DirectoryGeneration,
  owner: DirectoryLockOwner | null,
  moved: boolean,
) {
  return (moved
    ? sameMovedDirectoryGeneration(candidate.lockIdentity, info)
    : sameDirectoryGeneration(candidate.lockIdentity, info))
    && sameOwner(candidate.owner, owner);
}

async function observeCandidateGeneration(
  directory: string,
  candidate: LockCandidate,
  { moved = false }: { moved?: boolean } = {},
): Promise<CandidateGenerationObservation> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(directory);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { state: "missing", cause: error }
      : { state: "unavailable", cause: error };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return {
      state: "mismatch",
      lockIdentity: directoryGeneration(info),
      ownerToken: null,
    };
  }
  let owner: DirectoryLockOwner | null;
  try {
    owner = await readOwner(path.join(directory, "owner.json"));
  } catch (error) {
    return {
      state: "unavailable",
      lockIdentity: directoryGeneration(info),
      cause: error,
    };
  }
  let afterOwner: Awaited<ReturnType<typeof lstat>>;
  try {
    afterOwner = await lstat(directory);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { state: "missing", cause: error }
      : { state: "unavailable", cause: error };
  }
  if (!afterOwner.isDirectory() || afterOwner.isSymbolicLink() || !sameDirectoryGeneration(info, afterOwner)) {
    return {
      state: "mismatch",
      lockIdentity: directoryGeneration(afterOwner),
      ownerToken: owner?.ownerToken || null,
    };
  }
  return {
    state: candidateGenerationMatches(candidate, info, owner, moved) ? "match" : "mismatch",
    lockIdentity: directoryGeneration(info),
    ownerToken: owner?.ownerToken || null,
  };
}

function quarantineStateError(
  message: string,
  code: string,
  {
    lockDir,
    quarantineDir,
    candidate,
    observation,
    phase,
    committed,
    removalCommitted,
    cause,
    successorPreserved,
  }: {
    lockDir: string;
    quarantineDir: string;
    candidate: LockCandidate;
    observation?: CandidateGenerationObservation;
    phase: string;
    committed: boolean;
    removalCommitted: boolean;
    cause?: unknown;
    successorPreserved?: boolean | null;
  },
) {
  return Object.assign(lockError(message, code, cause), {
    committed,
    renameCommitted: committed,
    removalCommitted,
    phase,
    lockDir,
    quarantineDir,
    recoveryPaths: { canonical: lockDir, quarantine: quarantineDir },
    candidateGeneration: {
      dev: String(candidate.lockIdentity.dev),
      ino: String(candidate.lockIdentity.ino),
      size: candidate.lockIdentity.size,
      mtimeMs: candidate.lockIdentity.mtimeMs,
      ctimeMs: candidate.lockIdentity.ctimeMs,
      birthtimeMs: candidate.lockIdentity.birthtimeMs,
      ownerToken: candidate.owner?.ownerToken || null,
    },
    observedGeneration: observation ? {
      state: observation.state,
      dev: observation.lockIdentity === undefined ? null : String(observation.lockIdentity.dev),
      ino: observation.lockIdentity === undefined ? null : String(observation.lockIdentity.ino),
      size: observation.lockIdentity?.size ?? null,
      mtimeMs: observation.lockIdentity?.mtimeMs ?? null,
      ctimeMs: observation.lockIdentity?.ctimeMs ?? null,
      birthtimeMs: observation.lockIdentity?.birthtimeMs ?? null,
      ownerToken: observation.ownerToken ?? null,
    } : null,
    committedPath: committed && !removalCommitted ? quarantineDir : null,
    quarantinePreserved: committed && !removalCommitted,
    successorPreserved: successorPreserved === undefined
      ? code === "DIRECTORY_LOCK_GENERATION_CONFLICT" && committed && !removalCommitted
      : successorPreserved,
  });
}

async function canonicalPathState(lockDir: string): Promise<"missing" | "present" | "unavailable"> {
  try {
    await lstat(lockDir);
    return "present";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "missing" : "unavailable";
  }
}

async function quarantinePreservedError(
  lockDir: string,
  quarantineDir: string,
  candidate: LockCandidate,
  observation: CandidateGenerationObservation,
  cause: unknown,
) {
  const canonicalState = await canonicalPathState(lockDir);
  const successorPreserved = canonicalState === "present";
  return quarantineStateError(
    successorPreserved
      ? `directory lock successor and quarantine preserved after quarantine failure: ${lockDir}; quarantined=${quarantineDir}`
      : `directory lock quarantine preserved after quarantine failure: ${lockDir}; quarantined=${quarantineDir}`,
    successorPreserved ? "DIRECTORY_LOCK_SUCCESSOR_PRESERVED" : "DIRECTORY_LOCK_QUARANTINE_PRESERVED",
    {
      lockDir,
      quarantineDir,
      candidate,
      observation,
      phase: "quarantine-preserved",
      committed: true,
      removalCommitted: false,
      cause,
      successorPreserved,
    },
  );
}

function generationConflict(
  lockDir: string,
  quarantineDir: string,
  candidate: LockCandidate,
  observation: CandidateGenerationObservation,
  phase: "before-quarantine-rename" | "post-quarantine-rename" | "post-quarantine-hook",
  committed: boolean,
  cause?: unknown,
) {
  return quarantineStateError(
    `directory lock generation changed during quarantine (${phase}): ${lockDir}; quarantined=${quarantineDir}`,
    "DIRECTORY_LOCK_GENERATION_CONFLICT",
    {
      lockDir,
      quarantineDir,
      candidate,
      observation,
      phase,
      committed,
      removalCommitted: false,
      cause: cause ?? observation.cause,
    },
  );
}

async function quarantine(
  lockDir: string,
  candidate: LockCandidate,
  hooks?: DurableDirectoryLockHooks,
) {
  const quarantineDir = `${lockDir}.${candidate.kind}-${Date.now()}-${randomUUID()}`;
  const beforeRename = await observeCandidateGeneration(lockDir, candidate);
  if (beforeRename.state === "missing") return false;
  if (beforeRename.state !== "match") {
    throw generationConflict(
      lockDir,
      quarantineDir,
      candidate,
      beforeRename,
      "before-quarantine-rename",
      false,
    );
  }
  await hooks?.beforeQuarantineRename?.({
    lockDir,
    quarantineDir,
    ownerToken: candidate.owner?.ownerToken || null,
    kind: candidate.kind,
  });
  try {
    await rename(lockDir, quarantineDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  try {
    await syncDirectory(
      path.dirname(lockDir),
      () => hooks?.beforeDirectorySync?.({
        directory: path.dirname(lockDir),
        lockDir,
        quarantineDir,
        phase: "quarantine-rename",
      }),
      hooks?.resolveDirectoryOpenFlags,
    );
  } catch (error) {
    throw quarantineStateError(
      `directory lock quarantine rename committed with ambiguous durability: ${lockDir}; quarantined=${quarantineDir}`,
      "DIRECTORY_LOCK_QUARANTINE_RENAME_COMMITTED_AMBIGUOUS",
      {
        lockDir,
        quarantineDir,
        candidate,
        phase: "quarantine-rename-durability",
        committed: true,
        removalCommitted: false,
        cause: error,
      },
    );
  }

  const moved = await observeCandidateGeneration(quarantineDir, candidate, { moved: true });
  if (moved.state !== "match") {
    throw generationConflict(
      lockDir,
      quarantineDir,
      candidate,
      moved,
      "post-quarantine-rename",
      true,
    );
  }

  let hookError: unknown = null;
  try {
    await hooks?.afterQuarantineRename?.({
      lockDir,
      quarantineDir,
      ownerToken: candidate.owner?.ownerToken || null,
      kind: candidate.kind,
    });
  } catch (error) {
    hookError = error;
  }

  const retained = await observeCandidateGeneration(quarantineDir, candidate, { moved: true });
  if (retained.state !== "match") {
    throw generationConflict(
      lockDir,
      quarantineDir,
      candidate,
      retained,
      "post-quarantine-hook",
      true,
      hookError ?? retained.cause,
    );
  }
  if (hookError) {
    throw await quarantinePreservedError(lockDir, quarantineDir, candidate, retained, hookError);
  }

  const canonicalState = await canonicalPathState(lockDir);
  const releaseSuccessorPresent = candidate.kind === "released" && canonicalState === "present";
  if (canonicalState !== "missing" && !releaseSuccessorPresent) {
    throw quarantineStateError(
      canonicalState === "present"
        ? `directory lock successor and quarantine preserved: ${lockDir}; quarantined=${quarantineDir}`
        : `directory lock canonical path could not be proven absent; quarantine preserved: ${lockDir}; quarantined=${quarantineDir}`,
      canonicalState === "present"
        ? "DIRECTORY_LOCK_SUCCESSOR_PRESERVED"
        : "DIRECTORY_LOCK_QUARANTINE_PRESERVED",
      {
        lockDir,
        quarantineDir,
        candidate,
        observation: retained,
        phase: "quarantine-preserved",
        committed: true,
        removalCommitted: false,
        successorPreserved: canonicalState === "present" ? true : null,
      },
    );
  }

  // Preserve the verified quarantine. Node does not provide a portable
  // directory-descriptor-bound recursive delete, so pathname removal would
  // reopen an ABA window after the final generation check.
  return quarantineDir;
}

async function recoveryCandidate(
  lockDir: string,
  ttlMs: number,
  identityAlive: (identity: ProcessIdentity) => boolean,
): Promise<LockCandidate | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(lockDir);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw lockError(`unsafe directory lock path: ${lockDir}`, "DIRECTORY_LOCK_UNSAFE");
  }
  const owner = await readOwner(path.join(lockDir, "owner.json"));
  const acquiredAt = owner ? new Date(owner.acquiredAt).getTime() : 0;
  if (Date.now() - Math.max(info.mtimeMs, acquiredAt) < ttlMs) return null;
  if (!owner) {
    return { owner: null, lockIdentity: directoryGeneration(info), kind: "incomplete" };
  }
  if (!await ownerLockPathMatchesDirectory(owner.lockPath, lockDir)) {
    throw lockError(`directory lock owner path mismatch: ${lockDir}`, "DIRECTORY_LOCK_UNSAFE");
  }
  if (owner.host !== os.hostname()) return null;
  if (owner.processIdentity.birthIdPrecision !== "exact") return null;
  try {
    if (identityAlive(owner.processIdentity)) return null;
  } catch (error) {
    throw lockError(`directory lock owner liveness probe failed: ${lockDir}`, "DIRECTORY_LOCK_UNSAFE", error);
  }
  return { owner, lockIdentity: directoryGeneration(info), kind: "stale" };
}

async function releaseExact(
  lockDir: string,
  owner: DirectoryLockOwner,
  hooks: DurableDirectoryLockHooks | undefined,
  allowMissing: boolean,
) {
  const before = await lstat(lockDir);
  const current = await readOwner(path.join(lockDir, "owner.json"));
  if (!current && allowMissing) return false;
  if (!sameOwner(owner, current)) {
    throw lockError(`directory lock ownership lost: ${lockDir}`, "DIRECTORY_LOCK_LOST");
  }
  await hooks?.beforeRelease?.({ lockDir, ownerToken: owner.ownerToken });
  const verified = await readOwner(path.join(lockDir, "owner.json"));
  if (!sameOwner(owner, verified)) {
    throw lockError(`directory lock ownership lost before release: ${lockDir}`, "DIRECTORY_LOCK_LOST");
  }
  const info = await lstat(lockDir);
  if (!before.isDirectory() || before.isSymbolicLink() || !info.isDirectory() || info.isSymbolicLink()
    || !sameDirectoryGeneration(before, info)) {
    throw lockError(`directory lock generation changed before release: ${lockDir}`, "DIRECTORY_LOCK_LOST");
  }
  return quarantine(lockDir, {
    owner: verified,
    lockIdentity: directoryGeneration(info),
    kind: "released",
  }, hooks);
}

export async function withDurableDirectoryLock<T>(
  lockPath: string,
  callback: () => Promise<T>,
  {
    ttlMs = 30_000,
    waitMs = 10_000,
    retryMs = 10,
    signal,
    hooks,
    identityAlive = isProcessIdentityAlive,
    captureIdentity = captureCurrentLockIdentity,
  }: DurableDirectoryLockOptions = {},
): Promise<T> {
  if (typeof lockPath !== "string" || !lockPath.trim()) {
    throw new TypeError("directory lock path must be a non-empty string");
  }
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || !Number.isFinite(waitMs) || waitMs <= 0 || !Number.isFinite(retryMs) || retryMs <= 0) {
    throw new TypeError("directory lock timing options must be finite positive values (ttlMs may be zero)");
  }
  const requestedLockDir = path.resolve(lockPath);
  const lockBase = path.basename(requestedLockDir);
  if (
    requestedLockDir === path.parse(requestedLockDir).root
    || (!lockBase.endsWith(".lock") && !lockBase.startsWith(".lock-"))
  ) {
    throw lockError(`unsafe directory lock target: ${requestedLockDir}`, "DIRECTORY_LOCK_PATH_INVALID");
  }
  await mkdir(path.dirname(requestedLockDir), { recursive: true });
  const lockDir = path.join(await realpath(path.dirname(requestedLockDir)), path.basename(requestedLockDir));
  const ownerFile = path.join(lockDir, "owner.json");
  throwIfAborted(signal);
  let capturedIdentity: ProcessIdentity | null;
  try {
    capturedIdentity = captureIdentity();
  } catch (cause) {
    throw lockError(
      `directory lock exact process identity unavailable: ${lockDir}`,
      "DIRECTORY_LOCK_IDENTITY_UNAVAILABLE",
      cause,
    );
  }
  const ownerIdentity = processIdentity(capturedIdentity, process.pid);
  if (!ownerIdentity) {
    throw lockError(`directory lock process identity unavailable: ${lockDir}`, "DIRECTORY_LOCK_IDENTITY_UNAVAILABLE");
  }
  const owner: DirectoryLockOwner = {
    format: OWNER_FORMAT,
    ownerToken: randomUUID(),
    lockPath: lockDir,
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    processIdentity: ownerIdentity,
  };
  const deadlineAt = Date.now() + waitMs;
  let acquired = false;
  while (Date.now() < deadlineAt) {
    throwIfAborted(signal);
    let acquiredInsideFence = false;
    try {
      acquired = await withProcessFence(lockDir, deadlineAt, signal, async () => {
        let createdInfo: Awaited<ReturnType<typeof lstat>>;
        try {
          await mkdir(lockDir);
          createdInfo = await lstat(lockDir);
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          const candidate = await recoveryCandidate(lockDir, ttlMs, identityAlive);
          if (candidate) {
            await hooks?.afterRecoveryObserved?.({
              lockDir,
              ownerToken: candidate.owner?.ownerToken || null,
              kind: candidate.kind,
            });
            await quarantine(lockDir, candidate, hooks);
          }
          return false;
        }
        try {
          await writeOwnerDurable(ownerFile, owner, hooks);
          try {
            const parent = path.dirname(lockDir);
            await hooks?.beforeOwnerDirectorySync?.({
              directory: parent,
              lockDir,
              ownerFile,
              phase: "lock-directory-publish",
            });
            await syncDirectory(parent, undefined, hooks?.resolveDirectoryOpenFlags);
          } catch (cause) {
            throw committedOwnerPublishError(
              `directory lock committed with ambiguous parent durability: ${lockDir}`,
              "DIRECTORY_LOCK_ACQUIRE_COMMITTED_AMBIGUOUS",
              ownerFile,
              cause,
            );
          }
          acquiredInsideFence = true;
          return true;
        } catch (primaryError) {
          if (isCommittedOwnerPublishError(primaryError)) throw primaryError;
          let cleanupError: unknown = null;
          let cleanupQuarantineDir = "";
          try {
            const current = await readOwner(ownerFile);
            if (current && !sameOwner(owner, current)) {
              throw lockError(`directory lock owner changed after acquisition failure: ${lockDir}`, "DIRECTORY_LOCK_LOST");
            }
            const currentInfo = await lstat(lockDir);
            if (String(currentInfo.dev) !== String(createdInfo.dev) || String(currentInfo.ino) !== String(createdInfo.ino)) {
              throw lockError(`directory lock generation changed after acquisition failure: ${lockDir}`, "DIRECTORY_LOCK_LOST");
            }
            const quarantineResult = await quarantine(lockDir, {
              owner: current,
              lockIdentity: directoryGeneration(currentInfo),
              kind: "incomplete",
            });
            cleanupQuarantineDir = typeof quarantineResult === "string" ? quarantineResult : "";
          } catch (error) {
            cleanupError = error;
          }
          if (!cleanupError) {
            if (cleanupQuarantineDir && primaryError && typeof primaryError === "object") {
              const existingRecovery = "recoveryPaths" in primaryError
                && primaryError.recoveryPaths
                && typeof primaryError.recoveryPaths === "object"
                && !Array.isArray(primaryError.recoveryPaths)
                ? primaryError.recoveryPaths as Record<string, unknown>
                : {};
              throw Object.assign(primaryError, {
                cleanupCommitted: true,
                cleanupCommittedPath: cleanupQuarantineDir,
                quarantinePreserved: true,
                recoveryPaths: {
                  ...existingRecovery,
                  lockDir,
                  ownerFile,
                  quarantineDir: cleanupQuarantineDir,
                },
              });
            }
            throw primaryError;
          }
          throw lockError(
            `directory lock acquisition and cleanup failed: ${lockDir}`,
            "DIRECTORY_LOCK_ACQUIRE_FAILED",
            new AggregateError([primaryError, cleanupError], "directory lock acquisition and cleanup failed", {
              cause: primaryError,
            }),
          );
        }
      });
    } catch (primaryError) {
      if (!acquiredInsideFence) throw primaryError;
      let cleanupError: unknown = null;
      try {
        await withProcessFence(
          lockDir,
          Date.now() + waitMs,
          undefined,
          () => releaseExact(lockDir, owner, undefined, true),
        );
      } catch (error) {
        cleanupError = error;
      }
      if (!cleanupError) throw primaryError;
      throw lockError(
        `directory lock process-fence release and acquired-lock cleanup failed: ${lockDir}`,
        "DIRECTORY_LOCK_ACQUIRE_FAILED",
        new AggregateError(
          [primaryError, cleanupError],
          "directory lock process-fence release and acquired-lock cleanup failed",
          { cause: primaryError },
        ),
      );
    }
    if (acquired) break;
    await delay(Math.min(retryMs, Math.max(1, deadlineAt - Date.now())), signal);
  }
  if (!acquired) throw lockError(`directory lock busy: ${lockDir}`, "DIRECTORY_LOCK_BUSY");

  let value: T | undefined;
  let primaryError: unknown = null;
  try {
    value = await callback();
  } catch (error) {
    primaryError = error;
  }

  let releaseError: unknown = null;
  try {
    await withProcessFence(lockDir, Date.now() + waitMs, undefined, () => releaseExact(lockDir, owner, hooks, false));
  } catch (error) {
    let cleanupError: unknown = null;
    try {
      await withProcessFence(lockDir, Date.now() + waitMs, undefined, () => releaseExact(lockDir, owner, undefined, true));
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure;
    }
    releaseError = cleanupError
      ? lockError(
        `directory lock release and cleanup failed: ${lockDir}`,
        "DIRECTORY_LOCK_RELEASE_FAILED",
        new AggregateError([error, cleanupError], "directory lock release and cleanup failed", { cause: error }),
      )
      : error;
  }

  if (primaryError) {
    if (!releaseError) throw primaryError;
    throw new AggregateError(
      [primaryError, releaseError],
      `directory lock callback and release failed: ${lockDir}`,
      { cause: primaryError },
    );
  }
  if (releaseError) throw releaseError;
  return value as T;
}
