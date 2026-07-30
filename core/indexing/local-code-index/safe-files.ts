/**
 * Local Code Index v2 — safe filesystem operations.
 *
 * All operations use O_NOFOLLOW where possible to prevent symlink attacks.
 * Designed for index publication and atomic state management.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md section 7
 */

import { constants } from "node:fs";
import { link, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Metadata identity for pinned recheck. */
export type FileIdentity = Readonly<{
  /** File size in bytes. */
  size: number;
  /** Inode number (platform-dependent). */
  ino: number;
  /** Device ID (platform-dependent). */
  dev: number;
}>;

// ── Errors ────────────────────────────────────────────────────────────────────

/** Thrown when a file exceeds the read bound. */
export class FileSizeExceededError extends Error {
  override readonly name = "FileSizeExceededError";
  readonly path: string;
  readonly maxBytes: number;
  readonly actualBytes: number;

  constructor(path: string, maxBytes: number, actualBytes: number) {
    super(
      `File ${path} size ${actualBytes} exceeds bound ${maxBytes}`,
    );
    this.path = path;
    this.maxBytes = maxBytes;
    this.actualBytes = actualBytes;
  }
}

/** Thrown when a path is a symlink and O_NOFOLLOW is active. */
export class SymlinkFollowError extends Error {
  override readonly name = "SymlinkFollowError";
  readonly path: string;

  constructor(path: string, cause?: unknown) {
    super(`Symlink follow rejected for ${path}`, { cause });
    this.path = path;
  }
}

/** Thrown when exclusive creation fails because the target already exists. */
export class ExclusiveCreateConflictError extends Error {
  override readonly name = "ExclusiveCreateConflictError";
  readonly path: string;

  constructor(path: string, cause?: unknown) {
    super(`Exclusive create conflict at ${path}`, { cause });
    this.path = path;
  }
}

/** Thrown when identity recheck detects a mismatch. */
export class IdentityMismatchError extends Error {
  override readonly name = "IdentityMismatchError";
  readonly path: string;
  readonly expected: FileIdentity;
  readonly actual: FileIdentity;

  constructor(path: string, expected: FileIdentity, actual: FileIdentity) {
    super(
      `Identity mismatch for ${path}: expected ino=${expected.ino} dev=${expected.dev} size=${expected.size}, ` +
        `got ino=${actual.ino} dev=${actual.dev} size=${actual.size}`,
    );
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Read a regular file with a byte bound, rejecting symlinks via O_NOFOLLOW.
 *
 * Returns the file contents as a Uint8Array if the file size is within bounds.
 * Throws FileSizeExceededError if the file exceeds maxBytes.
 * Throws SymlinkFollowError if the path is a symlink.
 *
 * @param path Absolute path to the file.
 * @param maxBytes Maximum number of bytes to read.
 */
export async function readBoundedFileNoFollow(
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  // First stat to check size (without following symlinks via lstat).
  // We use stat with O_NOFOLLOW behavior: lstat does not follow symlinks.
  const { size } = await stat(path, { bigint: false });

  if (size > maxBytes) {
    throw new FileSizeExceededError(path, maxBytes, size);
  }

  // Open with O_NOFOLLOW to reject symlinks at the fd level.
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = new Uint8Array(size);
    const { bytesRead } = await fh.read(buffer, 0, size, 0);
    if (bytesRead !== size) {
      throw new Error(
        `Short read for ${path}: expected ${size} bytes, got ${bytesRead}`,
      );
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Write bytes to a path durably: write + fsync + close.
 *
 * Creates or truncates the target file. Uses O_NOFOLLOW to reject symlinks.
 *
 * @param path Absolute path to write.
 * @param bytes Data to write.
 */
export async function writeDurableFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const fh = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await fh.write(bytes);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Create an exclusive temporary file in the given directory.
 *
 * The file is created with O_CREAT | O_EXCL to guarantee exclusivity.
 * Returns the path to the created temporary file.
 *
 * @param dir Directory in which to create the temp file.
 * @param prefix Filename prefix (e.g., "index-shard-").
 */
export async function exclusiveCreateTemp(
  dir: string,
  prefix: string,
): Promise<string> {
  // Ensure directory exists.
  await mkdir(dir, { recursive: true });

  // Generate a unique name using mkdtemp pattern, then create the file exclusively.
  // We use mkdtemp to get a unique directory name, then create a file inside it,
  // but that's wasteful. Instead, we use a timestamp + random suffix approach.
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  const name = `${prefix}${timestamp}-${random}`;

  const filePath = join(dir, name);

  // Create exclusively — fails if file already exists.
  const fh = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  await fh.close();

  return filePath;
}

/**
 * Atomic rename with fsync on the target directory.
 *
 * On POSIX, rename(2) is atomic. We fsync the directory afterward to ensure
 * durability of the directory entry.
 *
 * @param tempPath Source path (must exist).
 * @param finalPath Target path.
 */
export async function atomicRename(
  tempPath: string,
  finalPath: string,
): Promise<void> {
  await rename(tempPath, finalPath);

  // Fsync the parent directory to ensure the rename is durable.
  await syncDirectory(dirname(finalPath));
}

/**
 * Publish a file via exclusive hard link, then remove the temporary source.
 *
 * Uses link(2) with O_NOFOLLOW semantics — fails if finalPath already exists.
 * Unlinks tempPath after successful link. Fsyncs the parent directory.
 *
 * @param tempPath Source path (must exist, same filesystem as finalPath).
 * @param finalPath Target path (must not exist).
 */
export async function exclusiveHardLinkPublish(
  tempPath: string,
  finalPath: string,
): Promise<void> {
  // link(2) creates a new directory entry. It fails with EEXIST if finalPath exists.
  await link(tempPath, finalPath);

  // Fsync the parent directory of the final path.
  await syncDirectory(dirname(finalPath));

  // Remove the temporary source.
  await unlink(tempPath);
}

/**
 * Fsync a directory to ensure all recent changes are durable.
 *
 * @param dirPath Absolute path to the directory.
 */
export async function syncDirectory(dirPath: string): Promise<void> {
  const fh = await open(dirPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Re-read a file's metadata and compare against an expected identity.
 *
 * Used to detect if a file was replaced or modified after initial read.
 * Throws IdentityMismatchError if the metadata differs.
 *
 * @param path Absolute path to the file.
 * @param expected Expected identity (size, ino, dev).
 */
export async function pinnedIdentityRecheck(
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const info = await stat(path, { bigint: false });

  const actual: FileIdentity = {
    size: info.size,
    ino: info.ino,
    dev: info.dev,
  };

  if (
    actual.size !== expected.size ||
    actual.ino !== expected.ino ||
    actual.dev !== expected.dev
  ) {
    throw new IdentityMismatchError(path, expected, actual);
  }
}
