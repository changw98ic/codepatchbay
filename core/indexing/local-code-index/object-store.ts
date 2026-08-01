/**
 * Local Code Index v2 — immutable object publication and lookup.
 *
 * Implements spec section 7.3 (File object) and section 7.6 (Publication)
 * for repository-scoped immutable objects:
 *
 *   - file objects: path-independent parse facts keyed by
 *     SHA-256("cpb-file-object-v2\0" + language + "\0" + parserMode +
 *     "\0" + extractorFingerprint + "\0" + sourceContentId)
 *   - blob-map objects: Git blob to source-content/file-object mapping,
 *     keyed by SHA-256 of canonical JSON bytes
 *   - symbol-shard objects: keyed by SHA-256 of canonical JSON bytes
 *   - relation-shard objects: keyed by SHA-256 of canonical JSON bytes
 *
 * Publication protocol (section 7.6 steps 2-4):
 *   1. Exclusively create a synced temporary file alongside the final path.
 *   2. Write canonical bytes, fsync, close, and identity-check.
 *   3. Atomically publish via exclusive same-filesystem hard link.
 *   4. Unlink the temporary path and, before reporting a batch successful,
 *      fsync every object directory modified by that batch.
 *   5. If the final path already exists, bounded-read and byte-compare;
 *      exact equality reuses, any mismatch fails object_identity_collision.
 *
 * All operations are called while the caller already holds the repository-key
 * object lock.  This module does not acquire locks itself.
 *
 * Security:
 *   - Every file open uses O_NOFOLLOW.
 *   - Reads are bounded by file size.
 *   - No absolute paths, source contents, or secrets in error messages.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md sections 7.3, 7.6
 * Plan: docs/architecture/local-code-index-v2-implementation-plan.md Phase 4
 *
 * Dependencies: node:crypto, node:fs, node:fs/promises, node:path,
 *   contracts.ts, canonical-json.ts, paths.ts, safe-files.ts.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import { LocalCodeIndexUnavailableError } from "./contracts.js";
import { canonicalStringify, objectId } from "./canonical-json.js";
import {
  fileObjectPath,
  blobMapObjectPath,
  symbolShardPath,
  relationShardPath,
  tempFileName,
} from "./paths.js";
import {
  readBoundedFileNoFollow,
  writeDurableFile,
  syncDirectory,
  ExclusiveCreateConflictError,
  FileSizeExceededError,
  SymlinkFollowError,
} from "./safe-files.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Domain separator prefix for file object IDs.
 * The trailing \0 is part of the prefix; additional \0 separators follow
 * between each field.
 */
const FILE_OBJECT_ID_PREFIX = "cpb-file-object-v2\0";

/**
 * Maximum bytes accepted when reading back a stored object for comparison.
 * Objects are bounded by extraction limits (section 9.3): max 5 MiB source,
 * max 10 000 symbols, max 100 000 references.  The serialized JSON may be
 * larger due to metadata.  16 MiB is a generous upper bound that still
 * prevents unbounded reads.
 */
const MAX_OBJECT_READ_BYTES = 64 * 1024 * 1024;

/** Bound concurrent durable writes so publication overlaps I/O without exhaustion. */
const MAX_CONCURRENT_OBJECT_PUBLICATIONS = 64;

/** Bound concurrent file-object serialization and durable writes. */
const MAX_CONCURRENT_FILE_OBJECT_PUBLICATIONS = 8;

// ── File-object ID ───────────────────────────────────────────────────────────

/**
 * Derive a file object ID from its identity fields.
 *
 * Formula (spec section 7.3):
 *   SHA-256(
 *     "cpb-file-object-v2\0" +
 *     effective-language + "\0" +
 *     parser-mode + "\0" +
 *     language-extractor-fingerprint + "\0" +
 *     source-content-id
 *   )
 *
 * The resulting ID is a 64-character lowercase hex SHA-256 digest.
 * Two files with identical source bytes but different language, parser mode,
 * or extractor fingerprint produce different IDs.
 */
export function deriveFileObjectId(
  language: string,
  parserMode: string,
  extractorFingerprint: string,
  sourceContentId: string,
): string {
  return createHash("sha256")
    .update(FILE_OBJECT_ID_PREFIX)
    .update(language)
    .update("\0")
    .update(parserMode)
    .update("\0")
    .update(extractorFingerprint)
    .update("\0")
    .update(sourceContentId)
    .digest("hex");
}

// ── Blob-map object ID ──────────────────────────────────────────────────────

/**
 * Derive a blob-map object ID from its canonical JSON bytes.
 *
 * The ID is the full SHA-256 hex digest of the canonical JSON serialization
 * of the blob-map entry (spec section 7.3: "Blob-map, symbol-shard, and
 * relation-shard object IDs are full SHA-256 digests of their canonical
 * JSON bytes").
 */
export function deriveBlobMapObjectId(blobMapEntry: unknown): string {
  return objectId(blobMapEntry);
}

// ── Object types ─────────────────────────────────────────────────────────────

/**
 * A definition extracted from source code.
 *
 * Spec section 7.3: "definitions with name, kind, range, export status,
 * and optional signature".
 */
export type ObjectDefinition = Readonly<{
  name: string;
  kind: string;
  range: Readonly<{
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }>;
  exported: boolean;
  signature?: string;
}>;

/**
 * A reference to a symbol found in source code.
 *
 * Spec section 7.3: "references with name, range, and reference kind".
 */
export type ObjectReference = Readonly<{
  name: string;
  range: Readonly<{
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }>;
  referenceKind: string;
}>;

/**
 * A raw import/include request found in source code.
 *
 * Spec section 7.3: "raw import/include requests with syntax range and
 * import kind".  No resolved target — resolution belongs to relationship
 * shards.
 */
export type ObjectImport = Readonly<{
  requested: string;
  range: Readonly<{
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }>;
  importKind: string;
}>;

/**
 * An immutable file object stored in the repository object namespace.
 *
 * Spec section 7.3: "The object contains no absolute path, source-relative
 * path, resolved import target, package-resolution result, or repository
 * configuration.  It stores only facts derivable from the source bytes and
 * extractor fingerprint."
 */
export type FileObject = Readonly<{
  /** SHA-256 of the source worktree bytes. */
  sourceContentId: string;
  /** Language-specific extractor fingerprint. */
  languageExtractorFingerprint: string;
  /** Byte size of the source file. */
  byteSize: number;
  /** Effective language (e.g., "typescript"). */
  language: string;
  /** Parser mode used (e.g., "ast-grep", "lexical"). */
  parserMode: string;
  /** Extracted definitions. */
  definitions: readonly ObjectDefinition[];
  /** Extracted references. */
  references: readonly ObjectReference[];
  /** Raw import/include requests. */
  imports: readonly ObjectImport[];
  /** Parser errors encountered during extraction. */
  errors: readonly string[];
  /** Whether the parser output was truncated. */
  truncated: boolean;
  /** Extractor version string. */
  extractorVersion: string | null;
  /** Rule-set fingerprint used for extraction. */
  ruleSetFingerprint: string;
}>;

/**
 * A blob-map entry mapping Git blob identity to source content and file
 * object.  The full entry (including key fields) is serialized to derive
 * the blob-map object ID.
 *
 * Spec section 7.3: a blob-map records
 * `(git-object-format, git-blob-id, worktree-materialization-fingerprint,
 * effective-language, parser-mode, language-extractor-fingerprint)
 * -> (source-content-id, file-object-id)`.
 */
export type BlobMapEntry = Readonly<{
  /** Git object format ("sha1" or "sha256"). */
  gitObjectFormat: string;
  /** Git blob ID. */
  gitBlobId: string;
  /** Worktree materialization fingerprint. */
  materializationFingerprint: string;
  /** Effective language. */
  language: string;
  /** Parser mode. */
  parserMode: string;
  /** Language-specific extractor fingerprint. */
  languageExtractorFingerprint: string;
  /** Derived source content ID. */
  sourceContentId: string;
  /** Derived file object ID. */
  fileObjectId: string;
}>;

// ── Publication options ──────────────────────────────────────────────────────

/**
 * Options for publishing a batch of objects under the repository lock.
 */
export type PublishObjectsOptions = Readonly<{
  /** Canonical storage root. */
  storageRoot: string;
  /** Repository key (32 hex chars). */
  repositoryKey: string;
  /** Owner token for temporary file scoping. */
  ownerToken: string;
}>;

/**
 * Result of publishing a single object.
 */
export type PublishObjectResult = Readonly<{
  /** The object ID that was published or reused. */
  objectId: string;
  /** Whether the object was newly created or reused from disk. */
  status: "created" | "reused";
}>;

/**
 * Result of a batch publication.
 */
export type PublishBatchResult = Readonly<{
  /** Per-object results. */
  objects: readonly PublishObjectResult[];
  /** Total bytes written to disk (new objects only). */
  bytesWritten: number;
}>;

// ── Core publication ─────────────────────────────────────────────────────────

/**
 * Publish a single immutable object to the repository object store.
 *
 * Publication protocol (spec section 7.6 steps 2-4):
 *   1. Ensure the parent prefix directory exists.
 *   2. Exclusively create a synced temporary file alongside the final path.
 *   3. Write canonical bytes, fsync, close.
 *   4. Atomically publish via exclusive same-filesystem hard link.
 *   5. Unlink the temporary path and fsync the object directory before the
 *      caller reports publication success (batch callers may coalesce this).
 *   6. If the final path already exists, bounded-read and byte-compare;
 *      exact equality reuses, any mismatch fails object_identity_collision.
 *
 * @param finalPath Absolute path to the final object location.
 * @param canonicalBytes The canonical UTF-8 bytes to publish.
 * @param ownerToken Owner token for temp file scoping.
 * @returns Whether the object was created or reused.
 */
async function publishSingleObject(
  finalPath: string,
  canonicalBytes: Uint8Array,
  ownerToken: string,
  syncParentDirectory = true,
): Promise<"created" | "reused"> {
  const dir = path.dirname(finalPath);
  await mkdir(dir, { recursive: true });

  // Step 2: exclusively create a synced temporary file.
  const tmpName = tempFileName(ownerToken, "obj");
  const tmpPath = path.join(dir, tmpName);

  // Create the temp file exclusively.
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(
      tmpPath,
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
    // Step 3: write, sync, close.
    await fh.write(canonicalBytes);
    await fh.sync();
  } finally {
    await fh.close();
  }

  // Step 4: atomically publish via exclusive hard link.
  try {
    const { link } = await import("node:fs/promises");
    await link(tmpPath, finalPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;

    if (code === "EEXIST") {
      // Final path already exists — bounded-read and byte-compare.
      try {
        const existing = await readBoundedFileNoFollow(
          finalPath,
          MAX_OBJECT_READ_BYTES,
        );
        if (buffersEqual(existing, canonicalBytes)) {
          // Exact equality — reuse.
          await safeUnlink(tmpPath);
          return "reused";
        }
        // Mismatch — object identity collision.
        await safeUnlink(tmpPath);
        throw new LocalCodeIndexUnavailableError("object_identity_collision");
      } catch (readErr: unknown) {
        if (readErr instanceof LocalCodeIndexUnavailableError) {
          await safeUnlink(tmpPath);
          throw readErr;
        }
        // Read failed for other reasons — propagate as publication failure.
        await safeUnlink(tmpPath);
        throw new LocalCodeIndexUnavailableError("index_publication_failed", {
          cause: readErr,
        });
      }
    }

    // Other link errors — clean up and fail.
    await safeUnlink(tmpPath);
    throw new LocalCodeIndexUnavailableError("index_publication_failed", {
      cause: err,
    });
  }

  // Step 5: unlink the temporary path and fsync the object directory. Batch
  // callers may defer the directory sync until every atomically linked object
  // in the batch is complete; they never report success before that sync.
  await safeUnlink(tmpPath);
  if (syncParentDirectory) await syncDirectory(dir);

  return "created";
}

/**
 * Publish a batch of immutable objects under the repository lock.
 *
 * Each object is published independently: a failure on one object does not
 * prevent publication of others that have already succeeded.  The caller
 * receives aggregated results and can decide how to handle partial failures.
 *
 * @param objects Array of `{ finalPath, canonicalBytes }` pairs.
 * @param options Publication options (storage root, repository key, owner token).
 * @returns Per-object results and total bytes written.
 */
export async function publishObjects(
  objects: ReadonlyArray<{
    finalPath: string;
    canonicalBytes: Uint8Array;
  }>,
  options: PublishObjectsOptions,
): Promise<PublishBatchResult> {
  const results = new Array<PublishObjectResult>(objects.length);
  const writtenBytes = new Array<number>(objects.length).fill(0);
  const workerCount = Math.min(
    MAX_CONCURRENT_OBJECT_PUBLICATIONS,
    objects.length,
  );
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= objects.length) return;
      const obj = objects[index]!;
      const status = await publishSingleObject(
        obj.finalPath,
        obj.canonicalBytes,
        options.ownerToken,
      );
      const objectId = path.basename(obj.finalPath, ".json");
      results[index] = { objectId, status };
      if (status === "created") {
        writtenBytes[index] = obj.canonicalBytes.byteLength;
      }
    }
  }));

  return {
    objects: results,
    bytesWritten: writtenBytes.reduce((total, bytes) => total + bytes, 0),
  };
}

// ── File object helpers ──────────────────────────────────────────────────────

/**
 * Serialize a file object to canonical JSON bytes for publication.
 *
 * The canonical form uses sorted keys, no insignificant whitespace, and
 * one trailing newline (per canonical-json.ts rules).
 */
export function serializeFileObject(fileObject: FileObject): Uint8Array {
  const json = canonicalStringify(fileObject);
  return new TextEncoder().encode(json);
}

/**
 * Derive the final publication path for a file object.
 */
export function fileObjectPublishPath(
  storageRoot: string,
  repositoryKey: string,
  fileObjectId: string,
): string {
  return fileObjectPath(storageRoot, repositoryKey, fileObjectId);
}

/**
 * Publish a file object to the repository object store.
 *
 * Convenience wrapper that serializes and publishes a single file object.
 *
 * @param fileObject The file object to publish.
 * @param options Publication options.
 * @returns The file object ID and whether it was created or reused.
 */
export async function publishFileObject(
  fileObject: FileObject,
  options: PublishObjectsOptions,
): Promise<PublishObjectResult> {
  const id = deriveFileObjectId(
    fileObject.language,
    fileObject.parserMode,
    fileObject.languageExtractorFingerprint,
    fileObject.sourceContentId,
  );
  const finalPath = fileObjectPublishPath(
    options.storageRoot,
    options.repositoryKey,
    id,
  );
  const bytes = serializeFileObject(fileObject);
  const status = await publishSingleObject(finalPath, bytes, options.ownerToken);
  return { objectId: id, status };
}

/**
 * Publish file objects with the same identity rules as {@link publishFileObject}
 * while allowing the bounded object-store worker pool to overlap durable I/O.
 * The result order always matches the input order.
 */
export async function publishFileObjects(
  fileObjects: readonly FileObject[],
  options: PublishObjectsOptions,
): Promise<readonly PublishObjectResult[]> {
  const results: PublishObjectResult[] = [];
  const dirtyDirectories = new Set<string>();
  let nextIndex = 0;
  const workerCount = Math.min(
    MAX_CONCURRENT_FILE_OBJECT_PUBLICATIONS,
    fileObjects.length,
  );

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= fileObjects.length) return;
      const fileObject = fileObjects[index]!;
      const objectId = deriveFileObjectId(
        fileObject.language,
        fileObject.parserMode,
        fileObject.languageExtractorFingerprint,
        fileObject.sourceContentId,
      );
      const finalPath = fileObjectPublishPath(
        options.storageRoot,
        options.repositoryKey,
        objectId,
      );
      const status = await publishSingleObject(
        finalPath,
        serializeFileObject(fileObject),
        options.ownerToken,
        false,
      );
      results[index] = { objectId, status };
      if (status === "created") dirtyDirectories.add(path.dirname(finalPath));
    }
  }));

  const directories = [...dirtyDirectories];
  for (let offset = 0; offset < directories.length; offset += MAX_CONCURRENT_OBJECT_PUBLICATIONS) {
    await Promise.all(
      directories
        .slice(offset, offset + MAX_CONCURRENT_OBJECT_PUBLICATIONS)
        .map((dir) => syncDirectory(dir)),
    );
  }
  return results;
}

// ── Blob-map helpers ─────────────────────────────────────────────────────────

/**
 * Serialize a blob-map entry to canonical JSON bytes for publication.
 */
export function serializeBlobMapEntry(entry: BlobMapEntry): Uint8Array {
  const json = canonicalStringify(entry);
  return new TextEncoder().encode(json);
}

/**
 * Derive the final publication path for a blob-map object.
 */
export function blobMapObjectPublishPath(
  storageRoot: string,
  repositoryKey: string,
  blobMapObjectId: string,
): string {
  return blobMapObjectPath(storageRoot, repositoryKey, blobMapObjectId);
}

/**
 * Publish a blob-map entry to the repository object store.
 *
 * @param entry The blob-map entry to publish.
 * @param options Publication options.
 * @returns The blob-map object ID and whether it was created or reused.
 */
export async function publishBlobMapEntry(
  entry: BlobMapEntry,
  options: PublishObjectsOptions,
): Promise<PublishObjectResult> {
  const id = deriveBlobMapObjectId(entry);
  const finalPath = blobMapObjectPublishPath(
    options.storageRoot,
    options.repositoryKey,
    id,
  );
  const bytes = serializeBlobMapEntry(entry);
  const status = await publishSingleObject(finalPath, bytes, options.ownerToken);
  return { objectId: id, status };
}

// ── Symbol / relation shard helpers ──────────────────────────────────────────

/**
 * Serialize any shard payload to canonical JSON bytes.
 *
 * Shard object IDs are full SHA-256 digests of their canonical JSON bytes
 * (spec section 7.3).
 */
export function serializeShard(shardData: unknown): Uint8Array {
  const json = canonicalStringify(shardData);
  return new TextEncoder().encode(json);
}

/**
 * Derive the final publication path for a symbol shard.
 */
export function symbolShardPublishPath(
  storageRoot: string,
  repositoryKey: string,
  shardId: string,
): string {
  return symbolShardPath(storageRoot, repositoryKey, shardId);
}

/**
 * Derive the final publication path for a relation shard.
 */
export function relationShardPublishPath(
  storageRoot: string,
  repositoryKey: string,
  shardId: string,
): string {
  return relationShardPath(storageRoot, repositoryKey, shardId);
}

/**
 * Publish a symbol shard to the repository object store.
 *
 * @param shardData The shard payload (will be canonical-serialized).
 * @param options Publication options.
 * @returns The shard ID and whether it was created or reused.
 */
export async function publishSymbolShard(
  shardData: unknown,
  options: PublishObjectsOptions,
): Promise<PublishObjectResult> {
  const bytes = serializeShard(shardData);
  const id = createHash("sha256").update(bytes).digest("hex");
  const finalPath = symbolShardPublishPath(
    options.storageRoot,
    options.repositoryKey,
    id,
  );
  const status = await publishSingleObject(finalPath, bytes, options.ownerToken);
  return { objectId: id, status };
}

/**
 * Publish a relation shard to the repository object store.
 *
 * @param shardData The shard payload (will be canonical-serialized).
 * @param options Publication options.
 * @returns The shard ID and whether it was created or reused.
 */
export async function publishRelationShard(
  shardData: unknown,
  options: PublishObjectsOptions,
): Promise<PublishObjectResult> {
  const bytes = serializeShard(shardData);
  const id = createHash("sha256").update(bytes).digest("hex");
  const finalPath = relationShardPublishPath(
    options.storageRoot,
    options.repositoryKey,
    id,
  );
  const status = await publishSingleObject(finalPath, bytes, options.ownerToken);
  return { objectId: id, status };
}

// ── Object lookup ────────────────────────────────────────────────────────────

/**
 * Read a stored object by its final path.
 *
 * Returns the raw bytes if the object exists and is within bounds.
 * Returns null if the object does not exist.
 * Throws on read errors, symlink detection, or size exceeded.
 *
 * @param objectPath Absolute path to the stored object.
 * @returns The object bytes, or null if not found.
 */
export async function readStoredObject(
  objectPath: string,
): Promise<Uint8Array | null> {
  try {
    return await readBoundedFileNoFollow(objectPath, MAX_OBJECT_READ_BYTES);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Check whether a stored object's bytes match expected canonical bytes.
 *
 * Performs a bounded no-follow read and byte comparison.  Used during
 * publication when the final path already exists.
 *
 * @param objectPath Absolute path to the stored object.
 * @param expectedBytes Expected canonical bytes.
 * @returns true if bytes match exactly, false if mismatch, null if not found.
 */
export async function verifyStoredObject(
  objectPath: string,
  expectedBytes: Uint8Array,
): Promise<boolean | null> {
  const existing = await readStoredObject(objectPath);
  if (existing === null) return null;
  return buffersEqual(existing, expectedBytes);
}

/**
 * Read and deserialize a stored file object.
 *
 * @param objectPath Absolute path to the stored file object.
 * @returns The parsed file object, or null if not found.
 */
export async function readFileObject(
  objectPath: string,
): Promise<FileObject | null> {
  const bytes = await readStoredObject(objectPath);
  if (bytes === null) return null;
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as FileObject;
}

/**
 * Read and deserialize a stored blob-map entry.
 *
 * @param objectPath Absolute path to the stored blob-map object.
 * @returns The parsed blob-map entry, or null if not found.
 */
export async function readBlobMapEntry(
  objectPath: string,
): Promise<BlobMapEntry | null> {
  const bytes = await readStoredObject(objectPath);
  if (bytes === null) return null;
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as BlobMapEntry;
}

// ── Utilities ────────────────────────────────────────────────────────────────

/**
 * Constant-time comparison of two Uint8Array buffers.
 *
 * Uses byte-by-byte comparison to avoid timing side-channels on
 * hash collisions.  The spec does not require cryptographic constant-time
 * comparison, but it is good practice for identity checks.
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
 * Safely unlink a path, ignoring ENOENT errors.
 */
async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
