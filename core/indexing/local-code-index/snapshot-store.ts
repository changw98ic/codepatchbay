/**
 * Local Code Index v2 — snapshot identity, index-map, run reports, and
 * collision-safe publication.
 *
 * Implements spec section 7.4 (Snapshot identity and run report):
 *
 *   - `identity.json` — immutable canonical snapshot identity.  Byte-identical
 *     source + extractor state always produces byte-identical bytes and
 *     therefore the same snapshot ID.
 *   - Snapshot ID: `idx2-` + first 24 hex chars of SHA-256(identity.json bytes).
 *   - `index-map.json` — maps lookup buckets to immutable object IDs.  Its
 *     hash and length are recorded inside identity.json so that the snapshot
 *     identity covers both files.
 *   - `runs/<run-id>.json` — creation time, mode, duration, reuse counts.
 *     Run reports never affect snapshot identity.
 *   - Collision detection: same snapshot ID directory + byte mismatch = fail
 *     with `snapshot_identity_collision`.
 *
 * Publication protocol (section 7.6 steps 5–9) is handled here:
 *   1. Exclusively create a temporary snapshot directory.
 *   2. Write, sync, and verify `index-map.json`.
 *   3. Write, sync, and verify `identity.json`.
 *   4. Fsync the temporary directory.
 *   5. Atomically rename to `snapshots/<snapshot-id>`.
 *   6. Fsync the `snapshots/` parent.
 *
 * Dependencies: node:crypto, node:fs, node:fs/promises, node:path,
 *   contracts.ts, canonical-json.ts, paths.ts, safe-files.ts.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md section 7.4
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { LocalCodeIndexUnavailableError } from "./contracts.js";
import type {
  LocalCodeIndexCoverageSummary,
  LocalCodeIndexPhaseTimings,
} from "./contracts.js";
import { canonicalStringify } from "./canonical-json.js";
import {
  snapshotDir,
  snapshotIdentityPath,
  snapshotIndexMapPath,
  snapshotsDir,
  runsDir,
  runReportPath,
  tempFileName,
} from "./paths.js";
import {
  readBoundedFileNoFollow,
  syncDirectory,
} from "./safe-files.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum bytes accepted when reading back a snapshot file for comparison.
 * identity.json and index-map.json are bounded by inventory size.
 * 32 MiB is a generous upper bound that still prevents unbounded reads.
 */
const MAX_SNAPSHOT_READ_BYTES = 32 * 1024 * 1024;

/**
 * Snapshot ID prefix per spec section 7.4.
 */
const SNAPSHOT_ID_PREFIX = "idx2-";

/**
 * Number of hex characters taken from the SHA-256 digest for the snapshot ID.
 * Combined with the 5-char prefix, the total snapshot ID is 29 characters.
 */
const SNAPSHOT_ID_HEX_LENGTH = 24;

// ── Identity types ───────────────────────────────────────────────────────────

/**
 * Pinned filesystem metadata for a single snapshot inventory path.
 *
 * Spec section 8.1: device, inode, size, mtimeNs, ctimeNs, mode are
 * recorded as strings (except mode which is a number) to preserve
 * platform-specific precision.
 *
 * Named `SnapshotPinnedMetadata` to avoid collision with the
 * git-observer `PinnedMetadata` type.
 */
export type SnapshotPinnedMetadata = Readonly<{
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  mode: number;
}>;

/**
 * A single entry in the snapshot file inventory.
 *
 * Spec section 7.4: "file inventory mapping normalized path to source
 * content ID, file object ID, and pinned metadata identity".
 *
 * Named `SnapshotInventoryEntry` to avoid collision with the
 * git-observer `InventoryEntry` type.
 */
export type SnapshotInventoryEntry = Readonly<{
  /** SHA-256 of the source worktree bytes. */
  sourceContentId: string;
  /** Derived file object ID (from object-store.ts). */
  fileObjectId: string;
  /** Effective language recorded by the extraction that produced fileObjectId. */
  language: string;
  /** Parser mode recorded by the extraction that produced fileObjectId. */
  parserMode: string;
  /** Extractor fingerprint recorded by the extraction that produced fileObjectId. */
  languageExtractorFingerprint: string;
  /** Pinned filesystem metadata for identity rechecks. */
  metadata: SnapshotPinnedMetadata;
}>;

/**
 * Git-specific identity fields included in the snapshot when the source
 * is a Git repository.
 *
 * Spec section 7.4: "Git common directory, HEAD, branch, and object
 * format when applicable".
 */
export type GitIdentity = Readonly<{
  /** Canonical common git directory path. */
  commonDir: string;
  /** HEAD commit SHA. */
  head: string;
  /** Current branch name, or null for detached HEAD. */
  branch: string | null;
  /** Git object format ("sha1" or "sha256"). */
  objectFormat: string;
}>;

/**
 * Tool state recorded in the snapshot identity.
 *
 * Spec section 7.4: "tool state and explicit fallback coverage".
 */
export type SnapshotToolState = Readonly<{
  /** Tool name (always "ast-grep" in this version). */
  name: "ast-grep";
  /** Tool version string, or null if unavailable. */
  version: string | null;
  /** Extractor fingerprint covering rules + parser version. */
  extractorFingerprint: string;
  /** Whether the tool was available during this snapshot. */
  available: boolean;
  /** Exact whole-snapshot coverage summary. */
  coverage: LocalCodeIndexCoverageSummary;
  /** Any errors encountered during tool invocation. */
  errors: readonly string[];
}>;

/**
 * The complete canonical snapshot identity written to `identity.json`.
 *
 * Every field is derived from source observation and extraction state.
 * No timestamps, durations, or runtime statistics appear here — those
 * belong in run reports.
 *
 * Spec section 7.4: identity.json contains only the listed fields.
 */
export type SnapshotIdentity = Readonly<{
  /** Schema version — always 2. */
  schemaVersion: 2;
  /** Repository key (32 hex chars). */
  repositoryKey: string;
  /** Worktree key (32 hex chars). */
  worktreeKey: string;
  /** Source key (full SHA-256 hex). */
  sourceKey: string;
  /** Canonical absolute source path. */
  sourcePath: string;
  /** Git identity, or null for non-Git directories. */
  git: GitIdentity | null;
  /** SHA-256 of the worktree state observation payload. */
  worktreeStateFingerprint: string;
  /** File inventory: normalized path -> inventory entry. */
  inventory: Readonly<Record<string, SnapshotInventoryEntry>>;
  /** Object extractor fingerprint. */
  extractorFingerprint: string;
  /** Symbol lookup shard object IDs, sorted by shard ID. */
  symbolShardIds: readonly string[];
  /** Relationship lookup shard object IDs, sorted by shard ID. */
  relationShardIds: readonly string[];
  /** Tool state and coverage. */
  toolState: SnapshotToolState;
  /** SHA-256 of the canonical index-map.json bytes. */
  indexMapHash: string;
  /** Byte length of the canonical index-map.json. */
  indexMapByteLength: number;
}>;

/**
 * Index-map: maps lookup buckets to immutable object IDs.
 *
 * Spec section 7.4: "maps lookup buckets to immutable object IDs and
 * contains no timestamps or runtime statistics."
 *
 * The keys are bucket identifiers (e.g., symbol shard prefixes, relation
 * shard prefixes, file-summary shard prefixes).  Values are object IDs
 * of the immutable shard files in the repository object store.
 */
export type IndexMap = Readonly<{
  /** Schema version — always 2. */
  schemaVersion: 2;
  /** Snapshot ID this index map belongs to (informational, not identity-critical). */
  snapshotId: string;
  /** Symbol shards: "sym-<prefix>" -> object ID. */
  symbolShards: Readonly<Record<string, string>>;
  /** Relation shards: "rel-<prefix>" -> object ID. */
  relationShards: Readonly<Record<string, string>>;
  /** File-summary shards: "fs-<prefix>" -> object ID. */
  fileSummaryShards: Readonly<Record<string, string>>;
}>;

/**
 * Run report stored in `runs/<run-id>.json`.
 *
 * Spec section 7.4: "Creation time, mode, duration, reuse counts,
 * bytes, and phase timings are stored in a separate immutable
 * runs/<run-id>.json.  run-id includes a random UUID.  Run reports
 * never affect snapshot identity."
 */
export type RunReport = Readonly<{
  /** Schema version — always 1. */
  schemaVersion: 1;
  /** Unique run identifier (includes a random UUID). */
  runId: string;
  /** Snapshot ID produced by this run. */
  snapshotId: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Build mode. */
  mode: "reused" | "incremental" | "full";
  /** Total duration in milliseconds. */
  durationMs: number;
  /** File counts. */
  discoveredFiles: number;
  reusedFiles: number;
  hashedFiles: number;
  parsedFiles: number;
  deletedFiles: number;
  oversizedFiles: number;
  /** Rebuilt shard counts. */
  rebuiltSymbolShards: number;
  rebuiltRelationShards: number;
  /** Byte counts. */
  bytesRead: number;
  bytesWritten: number;
  /** Phase timings in milliseconds. */
  timings: LocalCodeIndexPhaseTimings;
}>;

// ── Snapshot ID derivation ───────────────────────────────────────────────────

/**
 * Derive the snapshot ID from canonical identity.json bytes.
 *
 * Formula (spec section 7.4):
 *   `idx2-<first 24 hex characters of SHA-256(canonical identity.json bytes)>`
 *
 * The canonical bytes are the UTF-8 encoding of the deterministic JSON
 * produced by `canonicalStringify`.  Rebuilding identical source and
 * extractor state produces byte-identical bytes and the same snapshot ID.
 */
export function deriveSnapshotId(identityBytes: Uint8Array): string {
  const hash = createHash("sha256").update(identityBytes).digest("hex");
  return SNAPSHOT_ID_PREFIX + hash.slice(0, SNAPSHOT_ID_HEX_LENGTH);
}

/**
 * Generate a unique run ID containing a random UUID.
 *
 * Spec section 7.4: "run-id includes a random UUID".
 */
export function generateRunId(): string {
  return `run-${randomUUID()}`;
}

// ── Canonical serialization ──────────────────────────────────────────────────

/**
 * Serialize the snapshot identity to canonical JSON bytes.
 *
 * The output uses sorted keys (including sorted inventory paths and
 * sorted shard ID arrays), no insignificant whitespace, and exactly
 * one trailing newline.  This is the exact byte sequence that feeds
 * into `deriveSnapshotId`.
 */
export function serializeIdentity(identity: SnapshotIdentity): Uint8Array {
  // Ensure inventory keys and shard arrays are sorted before serialization.
  const sortedIdentity: SnapshotIdentity = {
    ...identity,
    inventory: sortRecord(identity.inventory),
    symbolShardIds: [...identity.symbolShardIds].sort(),
    relationShardIds: [...identity.relationShardIds].sort(),
  };
  const json = canonicalStringify(sortedIdentity);
  return new TextEncoder().encode(json);
}

/**
 * Serialize the index-map to canonical JSON bytes.
 *
 * The output uses sorted keys for all nested records.
 */
export function serializeIndexMap(indexMap: IndexMap): Uint8Array {
  const sorted: IndexMap = {
    ...indexMap,
    symbolShards: sortRecord(indexMap.symbolShards),
    relationShards: sortRecord(indexMap.relationShards),
    fileSummaryShards: sortRecord(indexMap.fileSummaryShards),
  };
  const json = canonicalStringify(sorted);
  return new TextEncoder().encode(json);
}

/**
 * Serialize a run report to canonical JSON bytes.
 */
export function serializeRunReport(report: RunReport): Uint8Array {
  const json = canonicalStringify(report);
  return new TextEncoder().encode(json);
}

// ── Snapshot publication ─────────────────────────────────────────────────────

/**
 * Options for publishing a snapshot.
 */
export type PublishSnapshotOptions = Readonly<{
  /** Canonical storage root. */
  storageRoot: string;
  /** Worktree key (32 hex chars). */
  worktreeKey: string;
  /** Owner token for temporary file scoping. */
  ownerToken: string;
  /** The complete snapshot identity (without indexMapHash/Length — those are computed). */
  identityInput: Omit<SnapshotIdentity, "indexMapHash" | "indexMapByteLength">;
  /** The index-map to publish alongside the identity. */
  indexMap: IndexMap;
}>;

/**
 * Result of a successful snapshot publication.
 */
export type PublishSnapshotResult = Readonly<{
  /** The derived snapshot ID. */
  snapshotId: string;
  /** Whether the snapshot was newly created or reused from disk. */
  status: "created" | "reused";
  /** Absolute path to the published snapshot directory. */
  snapshotPath: string;
}>;

/**
 * Publish an immutable snapshot atomically.
 *
 * Implements spec section 7.6 steps 5–9:
 *   1. Serialize index-map and compute its hash + length.
 *   2. Build the complete identity (with index-map metadata).
 *   3. Serialize identity and derive snapshot ID.
 *   4. If the snapshot directory already exists, byte-compare both files:
 *      - Exact equality → reuse.
 *      - Any difference → `snapshot_identity_collision`.
 *   5. Exclusively create a temporary snapshot directory.
 *   6. Write and verify index-map.json inside it.
 *   7. Write and verify identity.json inside it.
 *   8. Fsync the temporary directory.
 *   9. Atomically rename to `snapshots/<snapshot-id>`.
 *   10. Fsync `snapshots/`.
 */
export async function publishSnapshot(
  options: PublishSnapshotOptions,
): Promise<PublishSnapshotResult> {
  const { storageRoot, worktreeKey, ownerToken, identityInput, indexMap } = options;

  // Step 1: Serialize index-map and compute its hash + byte length.
  const indexMapBytes = serializeIndexMap(indexMap);
  const indexMapHash = createHash("sha256").update(indexMapBytes).digest("hex");
  const indexMapByteLength = indexMapBytes.byteLength;

  // Step 2: Build the complete identity.
  const identity: SnapshotIdentity = {
    ...identityInput,
    indexMapHash,
    indexMapByteLength,
  };

  // Step 3: Serialize identity and derive snapshot ID.
  const identityBytes = serializeIdentity(identity);
  const snapshotId = deriveSnapshotId(identityBytes);

  // Check if the snapshot directory already exists.
  const targetDir = snapshotDir(storageRoot, worktreeKey, snapshotId);
  const existingIdentityPath = snapshotIdentityPath(storageRoot, worktreeKey, snapshotId);
  const existingIndexPath = snapshotIndexMapPath(storageRoot, worktreeKey, snapshotId);

  try {
    const existingIdentityBytes = await readBoundedFileNoFollow(
      existingIdentityPath,
      MAX_SNAPSHOT_READ_BYTES,
    );
    const existingIndexBytes = await readBoundedFileNoFollow(
      existingIndexPath,
      MAX_SNAPSHOT_READ_BYTES,
    );

    // Byte-compare both files.
    if (
      buffersEqual(existingIdentityBytes, identityBytes) &&
      buffersEqual(existingIndexBytes, indexMapBytes)
    ) {
      // Exact equality — reuse.
      return { snapshotId, status: "reused", snapshotPath: targetDir };
    }

    // Any difference — collision.
    throw new LocalCodeIndexUnavailableError("snapshot_identity_collision", {
      snapshotId,
    });
  } catch (err: unknown) {
    if (err instanceof LocalCodeIndexUnavailableError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // ENOENT means the directory does not exist yet — proceed with creation.
  }

  // Step 5: Exclusively create a temporary snapshot directory.
  const snapshotsParent = snapshotsDir(storageRoot, worktreeKey);
  await mkdir(snapshotsParent, { recursive: true });

  const tmpDirName = tempFileName(ownerToken, "snap");
  const tmpDir = path.join(snapshotsParent, tmpDirName);
  await mkdir(tmpDir, { recursive: false });

  try {
    // Step 6: Write and verify index-map.json inside the temp directory.
    await writeAndVerify(tmpDir, "index-map.json", indexMapBytes);

    // Step 7: Write and verify identity.json inside the temp directory.
    await writeAndVerify(tmpDir, "identity.json", identityBytes);

    // Step 8: Fsync the temporary directory.
    await syncDirectory(tmpDir);

    // Step 9: Atomically rename to the final snapshot directory.
    await rename(tmpDir, targetDir);

    // Step 10: Fsync the snapshots parent directory.
    await syncDirectory(snapshotsParent);
  } catch (err: unknown) {
    // Clean up the temporary directory on failure.
    await safeRemoveDir(tmpDir);
    throw err;
  }

  return { snapshotId, status: "created", snapshotPath: targetDir };
}

// ── Run report publication ───────────────────────────────────────────────────

/**
 * Options for writing a run report.
 */
export type WriteRunReportOptions = Readonly<{
  /** Canonical storage root. */
  storageRoot: string;
  /** Worktree key (32 hex chars). */
  worktreeKey: string;
  /** Owner token for temporary file scoping. */
  ownerToken: string;
  /** Snapshot ID this run produced. */
  snapshotId: string;
  /** Build mode. */
  mode: "reused" | "incremental" | "full";
  /** Total duration in milliseconds. */
  durationMs: number;
  /** File counts. */
  discoveredFiles: number;
  reusedFiles: number;
  hashedFiles: number;
  parsedFiles: number;
  deletedFiles: number;
  oversizedFiles: number;
  /** Rebuilt shard counts. */
  rebuiltSymbolShards: number;
  rebuiltRelationShards: number;
  /** Byte counts. */
  bytesRead: number;
  bytesWritten: number;
  /** Phase timings. */
  timings: RunReport["timings"];
}>;

/**
 * Write an immutable run report.
 *
 * Spec section 7.4: "runs/<run-id>.json — creation time, mode, duration,
 * reuse counts, bytes, and phase timings.  run-id includes a random UUID.
 * Run reports never affect snapshot identity."
 *
 * The run ID is generated fresh for each call.
 */
export async function writeRunReport(
  options: WriteRunReportOptions,
): Promise<{ runId: string; runPath: string }> {
  const runId = generateRunId();
  const report: RunReport = {
    schemaVersion: 1,
    runId,
    snapshotId: options.snapshotId,
    createdAt: new Date().toISOString(),
    mode: options.mode,
    durationMs: options.durationMs,
    discoveredFiles: options.discoveredFiles,
    reusedFiles: options.reusedFiles,
    hashedFiles: options.hashedFiles,
    parsedFiles: options.parsedFiles,
    deletedFiles: options.deletedFiles,
    oversizedFiles: options.oversizedFiles,
    rebuiltSymbolShards: options.rebuiltSymbolShards,
    rebuiltRelationShards: options.rebuiltRelationShards,
    bytesRead: options.bytesRead,
    bytesWritten: options.bytesWritten,
    timings: options.timings,
  };

  const bytes = serializeRunReport(report);
  const targetPath = runReportPath(options.storageRoot, options.worktreeKey, runId);

  // Ensure the runs directory exists.
  const runsParent = runsDir(options.storageRoot, options.worktreeKey);
  await mkdir(runsParent, { recursive: true });

  // Write with exclusive creation, sync, and verify.
  await writeAndVerify(path.dirname(targetPath), path.basename(targetPath), bytes);

  // Fsync the runs directory.
  await syncDirectory(runsParent);

  return { runId, runPath: targetPath };
}

// ── Snapshot reading ─────────────────────────────────────────────────────────

/**
 * Read and deserialize a stored snapshot identity.
 *
 * Returns null if the snapshot directory does not exist.
 * Throws on read errors, symlink detection, or size exceeded.
 */
export async function readSnapshotIdentity(
  storageRoot: string,
  worktreeKey: string,
  snapshotId: string,
): Promise<SnapshotIdentity | null> {
  const identityPath = snapshotIdentityPath(storageRoot, worktreeKey, snapshotId);
  try {
    const bytes = await readBoundedFileNoFollow(identityPath, MAX_SNAPSHOT_READ_BYTES);
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as SnapshotIdentity;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read and deserialize a stored index-map.
 *
 * Returns null if the snapshot directory does not exist.
 * Throws on read errors, symlink detection, or size exceeded.
 */
export async function readIndexMap(
  storageRoot: string,
  worktreeKey: string,
  snapshotId: string,
): Promise<IndexMap | null> {
  const indexPath = snapshotIndexMapPath(storageRoot, worktreeKey, snapshotId);
  try {
    const bytes = await readBoundedFileNoFollow(indexPath, MAX_SNAPSHOT_READ_BYTES);
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as IndexMap;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read and deserialize a stored run report.
 *
 * Returns null if the run file does not exist.
 */
export async function readRunReport(
  storageRoot: string,
  worktreeKey: string,
  runId: string,
): Promise<RunReport | null> {
  const reportPath = runReportPath(storageRoot, worktreeKey, runId);
  try {
    const bytes = await readBoundedFileNoFollow(reportPath, MAX_SNAPSHOT_READ_BYTES);
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as RunReport;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * List all snapshot IDs in a worktree's snapshots directory.
 *
 * Returns an empty array if the directory does not exist.
 */
export async function listSnapshotIds(
  storageRoot: string,
  worktreeKey: string,
): Promise<string[]> {
  const dir = snapshotsDir(storageRoot, worktreeKey);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith(SNAPSHOT_ID_PREFIX))
      .map((e) => e.name)
      .sort();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * List all run IDs in a worktree's runs directory.
 *
 * Returns an empty array if the directory does not exist.
 */
export async function listRunIds(
  storageRoot: string,
  worktreeKey: string,
): Promise<string[]> {
  const dir = runsDir(storageRoot, worktreeKey);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name.slice(0, -5)) // strip .json
      .sort();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Verify that a stored snapshot's identity bytes match the expected
 * canonical bytes.  Used during publication verification (section 7.6
 * step 10).
 *
 * Returns true if bytes match exactly, false if mismatch, null if
 * the snapshot does not exist.
 */
export async function verifySnapshotIdentity(
  storageRoot: string,
  worktreeKey: string,
  snapshotId: string,
  expectedIdentityBytes: Uint8Array,
): Promise<boolean | null> {
  const identityPath = snapshotIdentityPath(storageRoot, worktreeKey, snapshotId);
  try {
    const existing = await readBoundedFileNoFollow(identityPath, MAX_SNAPSHOT_READ_BYTES);
    return buffersEqual(existing, expectedIdentityBytes);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Verify that a stored snapshot's index-map bytes match the expected
 * canonical bytes.
 *
 * Returns true if bytes match exactly, false if mismatch, null if
 * the snapshot does not exist.
 */
export async function verifyIndexMap(
  storageRoot: string,
  worktreeKey: string,
  snapshotId: string,
  expectedIndexBytes: Uint8Array,
): Promise<boolean | null> {
  const indexPath = snapshotIndexMapPath(storageRoot, worktreeKey, snapshotId);
  try {
    const existing = await readBoundedFileNoFollow(indexPath, MAX_SNAPSHOT_READ_BYTES);
    return buffersEqual(existing, expectedIndexBytes);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Write a file exclusively inside a directory, sync it, close it,
 * re-read it, and verify the bytes match exactly.
 *
 * Uses O_NOFOLLOW to prevent symlink attacks.
 */
async function writeAndVerify(
  dir: string,
  filename: string,
  expectedBytes: Uint8Array,
): Promise<void> {
  const filePath = path.join(dir, filename);

  // Exclusively create the file.
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LocalCodeIndexUnavailableError("index_publication_failed", {
        cause: err,
      });
    }
    throw err;
  }

  try {
    // Write, sync.
    await fh.write(expectedBytes);
    await fh.sync();
  } finally {
    await fh.close();
  }

  // Re-read and verify.
  const actual = await readBoundedFileNoFollow(filePath, MAX_SNAPSHOT_READ_BYTES);
  if (!buffersEqual(actual, expectedBytes)) {
    throw new LocalCodeIndexUnavailableError("index_publication_failed", {
      snapshotId: undefined,
    });
  }
}

/**
 * Remove a directory and all its contents, ignoring ENOENT.
 *
 * Used for cleanup of temporary snapshot directories on failure.
 */
async function safeRemoveDir(dirPath: string): Promise<void> {
  try {
    const { rm } = await import("node:fs/promises");
    await rm(dirPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors.
  }
}

/**
 * Constant-time comparison of two Uint8Array buffers.
 */
function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Sort the keys of a record and return a new record with sorted entries.
 * Used to ensure canonical serialization order for inventory and shard maps.
 */
function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  const keys = Object.keys(record).sort();
  const sorted: Record<string, T> = {};
  for (const key of keys) {
    sorted[key] = record[key] as T;
  }
  return sorted;
}
