import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../../core/contracts/canonical-json.js";
import { assertReleaseHash } from "../../core/contracts/release-evidence.js";
import { readBoundedRegularFileNoFollow } from "../../core/runtime/durable-directory-lock.js";

// ---------------------------------------------------------------------------
// Shared low-level helpers.
//
// These error/id helpers are consumed by every layer of the release-gate
// module (storage, decoding, verification, and the public write entry points
// in release-gate-receipts.ts). They live here, in the lowest layer, so that
// no higher layer has to be imported just to format an error or validate an
// id -- this keeps the dependency graph acyclic.
// ---------------------------------------------------------------------------

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

export function receiptError(message: string, code = "RELEASE_GATE_RECEIPT_INVALID", details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...details });
}

export function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "RELEASE_GATE_RECEIPT_INVALID";
}

export function requireSafeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw receiptError(`${label} is invalid`, "RELEASE_GATE_RECEIPT_INVALID", { field: label });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Path + directory helpers.
// ---------------------------------------------------------------------------

export function fingerprintDirectoryName(fingerprint: string): string {
  assertReleaseHash(fingerprint, "releaseSourceFingerprint");
  return `sha256-${fingerprint.slice("sha256:".length)}`;
}

export function ensureInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolvedCandidate;
  throw receiptError(`release evidence path escapes its root: ${candidate}`, "RELEASE_GATE_RECEIPT_INVALID");
}

export async function ensureSafeDirectory(baseRoot: string, directory: string): Promise<void> {
  const resolvedBase = path.resolve(baseRoot);
  const resolvedDirectory = ensureInside(resolvedBase, directory);
  await mkdir(resolvedBase, { recursive: true, mode: 0o700 });
  let baseStat = await lstat(resolvedBase, { bigint: true });
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
    throw receiptError(`release evidence root is unsafe: ${resolvedBase}`);
  }
  const relative = path.relative(resolvedBase, resolvedDirectory);
  let cursor = resolvedBase;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      await mkdir(cursor, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    baseStat = await lstat(cursor, { bigint: true });
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) {
      throw receiptError(`release evidence directory is unsafe: ${cursor}`);
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Immutable file writes + no-follow JSON reads.
// ---------------------------------------------------------------------------

export async function writeImmutableFile(baseRoot: string, filePath: string, bytes: Buffer): Promise<void> {
  const resolvedPath = ensureInside(baseRoot, filePath);
  const parent = path.dirname(resolvedPath);
  await ensureSafeDirectory(baseRoot, parent);
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === 0) {
    throw receiptError("O_NOFOLLOW is unavailable for release evidence writes");
  }
  const temporaryPath = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  let linked = false;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, resolvedPath);
    linked = true;
    await unlink(temporaryPath);
    await syncDirectory(parent);
  } catch (cause) {
    if (handle) await handle.close().catch(() => undefined);
    if (!linked) await unlink(temporaryPath).catch(() => undefined);
    throw Object.assign(receiptError(
      linked
        ? `release evidence write committed with ambiguous durability: ${resolvedPath}`
        : `release evidence file already exists or could not be written: ${resolvedPath}`,
      "RELEASE_GATE_RECEIPT_INVALID",
      { path: resolvedPath, committed: linked },
    ), { cause });
  }
}

export async function writeImmutableJson(baseRoot: string, filePath: string, value: unknown): Promise<void> {
  await writeImmutableFile(baseRoot, filePath, Buffer.from(`${canonicalJson(value)}\n`, "utf8"));
}

export async function readJsonNoFollow(filePath: string): Promise<unknown> {
  const raw = await readBoundedRegularFileNoFollow(filePath, { maxBytes: MAX_JSON_BYTES });
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw Object.assign(receiptError(`release evidence JSON is invalid: ${filePath}`), { cause });
  }
}

// ---------------------------------------------------------------------------
// Safe artifact hashing (no-follow, race-detected).
// ---------------------------------------------------------------------------

type FileGeneration = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

function fileGeneration(stat: BigIntStats): FileGeneration {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameFileGeneration(left: FileGeneration, right: FileGeneration): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export async function hashRawFileNoFollow(filePath: string): Promise<Readonly<{ bytes: number; sha256: string }>> {
  const beforeStat = await lstat(filePath, { bigint: true });
  if (!beforeStat.isFile() || beforeStat.isSymbolicLink() || beforeStat.size > BigInt(MAX_ARTIFACT_BYTES)) {
    throw receiptError(`release artifact is unsafe or too large: ${filePath}`);
  }
  const before = fileGeneration(beforeStat);
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow === 0) throw receiptError("O_NOFOLLOW is unavailable for release evidence reads");
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileGeneration(before, fileGeneration(opened))) {
      throw receiptError(`release artifact changed before read: ${filePath}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = fileGeneration(await handle.stat({ bigint: true }));
    if (!sameFileGeneration(before, after) || BigInt(offset) !== before.size) {
      throw receiptError(`release artifact changed during read: ${filePath}`);
    }
    return { bytes: offset, sha256: `sha256:${hash.digest("hex")}` };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Release-evidence layout.
// ---------------------------------------------------------------------------

export function releasePaths(runtimeRoot: string, fingerprint: string, sessionId?: string) {
  const evidenceRoot = path.join(path.resolve(runtimeRoot), "release-evidence");
  const fingerprintRoot = path.join(evidenceRoot, fingerprintDirectoryName(fingerprint));
  return {
    evidenceRoot,
    fingerprintRoot,
    externalRoot: path.join(fingerprintRoot, "external"),
    sessionRoot: sessionId ? path.join(fingerprintRoot, requireSafeId(sessionId, "sessionId")) : null,
  };
}
