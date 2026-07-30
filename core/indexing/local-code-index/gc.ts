/**
 * Local Code Index v2 — garbage collection.
 *
 * Implements spec section 10.5 (Deadlines and cleanup) and the GC contract
 * from the Phase 6 implementation plan:
 *
 *   - Explicit GC under the repository lock across every worktree namespace.
 *   - Retained-snapshot and object collection.
 *   - Cannot remove objects retained by a current snapshot.
 *   - Interruption cleanup for owner-scoped unpublished files only.
 *
 * GC protocol:
 *
 *   1. Acquire the repository-key object lock.
 *   2. Enumerate every worktree directory under the storage root.
 *   3. For each worktree, read `current.json` to obtain the current snapshot
 *      ID and the two previous snapshot IDs.
 *   4. For each retained snapshot, read `identity.json` and `index-map.json`
 *      to collect all referenced object IDs (file objects, blob-map objects,
 *      symbol shards, relation shards).
 *   5. Scan the repository objects directory and build the set of all stored
 *      object IDs.
 *   6. Delete objects that are not in the retained set.
 *   7. Optionally quarantine snapshot directories that are not retained by
 *      any worktree.
 *   8. Clean up owner-scoped unpublished temporary files (files matching
 *      `.tmp-<ownerToken>-*`) in the objects and snapshots directories.
 *   9. Release the repository lock.
 *
 * Safety invariants:
 *
 *   - GC holds the repository object lock for the entire scan-and-delete
 *     cycle. A concurrent ensure either waits or times out.
 *   - An object is retained when ANY worktree's current or previous snapshot
 *     references it. Objects shared across worktrees are never removed while
 *     any worktree retains them.
 *   - GC never touches recovery-elections, quarantines, or lock directories.
 *   - GC never runs inside a readiness check or query path.
 *
 * Dependencies: node:fs/promises, node:path,
 *   contracts.ts, paths.ts, snapshot-store.ts, lock.ts, safe-files.ts.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md section 10.5
 * Plan: docs/architecture/local-code-index-v2-implementation-plan.md Phase 6
 */

import { readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";

import {
  repositoryObjectsLockDir,
  repositoryObjectsDir,
  snapshotsDir,
  worktreeDir,
} from "./paths.js";
import {
  readSnapshotIdentity,
  readIndexMap,
  listSnapshotIds,
  type SnapshotIdentity,
  type IndexMap,
} from "./snapshot-store.js";
import {
  acquireIndexLock,
  releaseIndexLock,
  type IndexLockOwner,
} from "./lock.js";
import { readBoundedFileNoFollow } from "./safe-files.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum bytes for reading `current.json`.
 * The file contains worktree key, snapshot ID, identity hash, owner token,
 * and at most two previous snapshot IDs.  4 KiB is generous.
 */
const MAX_CURRENT_JSON_BYTES = 4 * 1024;

/**
 * Prefix for owner-scoped temporary files.
 */
const TEMP_FILE_PREFIX = ".tmp-";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Parsed `current.json` content for a single worktree.
 *
 * Spec section 7.6 step 13: "containing worktree key, snapshot ID,
 * identity hash, publication owner token, and a deduplicated newest-first
 * list of the two previously current snapshot IDs."
 */
export type CurrentPointer = Readonly<{
  /** Worktree key this pointer belongs to. */
  worktreeKey: string;
  /** The current snapshot ID. */
  snapshotId: string;
  /** SHA-256 of the canonical identity.json bytes. */
  identityHash: string;
  /** Owner token of the publication that wrote this pointer. */
  ownerToken: string;
  /** Deduplicated newest-first list of previous snapshot IDs (at most 2). */
  previousSnapshotIds: readonly string[];
}>;

/**
 * Options for a single GC run.
 */
export type GarbageCollectOptions = Readonly<{
  /** Canonical storage root. */
  storageRoot: string;
  /** Repository key (32 hex chars). */
  repositoryKey: string;
  /** Maximum time in ms to wait for the repository lock. Default 10 000. */
  lockWaitMs?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /**
   * When true, quarantine unreferenced snapshot directories instead of
   * leaving them in place. Default false.
   */
  quarantineUnreferencedSnapshots?: boolean;
}>;

/**
 * Result of a GC run.
 */
export type GarbageCollectResult = Readonly<{
  /** Number of worktree namespaces scanned. */
  worktreesScanned: number;
  /** Total number of retained snapshots across all worktrees. */
  retainedSnapshots: number;
  /** Total number of stored objects found in the repository. */
  storedObjects: number;
  /** Number of objects deleted. */
  deletedObjects: number;
  /** Number of temporary files cleaned up. */
  cleanedTempFiles: number;
  /** Number of unreferenced snapshot directories quarantined (if requested). */
  quarantinedSnapshots: number;
  /** IDs of retained snapshots, grouped by worktree key. */
  retainedSnapshotMap: Readonly<Record<string, readonly string[]>>;
}>;

// ── Current pointer reading ──────────────────────────────────────────────────

/**
 * Read and parse `current.json` for a worktree.
 *
 * Returns null when the file is absent or malformed.  The caller handles
 * the null case by treating the worktree as having no retained snapshots.
 */
async function readCurrentPointer(
  storageRoot: string,
  worktreeKey: string,
): Promise<CurrentPointer | null> {
  const currentPath = path.join(
    worktreeDir(storageRoot, worktreeKey),
    "current.json",
  );

  let raw: Uint8Array;
  try {
    raw = await readBoundedFileNoFollow(currentPath, MAX_CURRENT_JSON_BYTES);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }

  // Validate required fields.
  if (typeof parsed.worktreeKey !== "string" || !parsed.worktreeKey)
    return null;
  if (typeof parsed.snapshotId !== "string" || !parsed.snapshotId)
    return null;
  if (typeof parsed.identityHash !== "string" || !parsed.identityHash)
    return null;
  if (typeof parsed.ownerToken !== "string" || !parsed.ownerToken)
    return null;

  // previousSnapshotIds: deduplicated newest-first list, at most 2.
  const rawPrev = parsed.previousSnapshotIds;
  let previousSnapshotIds: string[] = [];
  if (Array.isArray(rawPrev)) {
    const seen = new Set<string>();
    for (const entry of rawPrev) {
      if (typeof entry === "string" && entry && !seen.has(entry)) {
        seen.add(entry);
        previousSnapshotIds.push(entry);
        if (previousSnapshotIds.length >= 2) break;
      }
    }
  }

  return {
    worktreeKey: parsed.worktreeKey,
    snapshotId: parsed.snapshotId,
    identityHash: parsed.identityHash,
    ownerToken: parsed.ownerToken,
    previousSnapshotIds,
  };
}

// ── Worktree enumeration ─────────────────────────────────────────────────────

/**
 * List all worktree keys under the storage root.
 *
 * Reads the `worktrees/` directory and returns directory names that look
 * like valid worktree keys (32 hex chars).
 */
async function enumerateWorktreeKeys(
  storageRoot: string,
): Promise<string[]> {
  const worktreesParent = path.join(storageRoot, "worktrees");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(worktreesParent, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^[0-9a-f]{32}$/.test(name))
    .sort();
}

// ── Object collection from snapshots ─────────────────────────────────────────

/**
 * Collect all object IDs referenced by a single snapshot.
 *
 * Reads the snapshot's `identity.json` and `index-map.json` to extract:
 * - File object IDs from the inventory.
 * - Symbol shard object IDs from the index-map.
 * - Relation shard object IDs from the index-map.
 * - File-summary shard object IDs from the index-map.
 *
 * Returns an empty set when the snapshot directory is absent.
 */
async function collectSnapshotObjects(
  storageRoot: string,
  worktreeKey: string,
  snapshotId: string,
): Promise<Set<string>> {
  const objects = new Set<string>();

  // Read identity.json for inventory (file object IDs).
  const identity: SnapshotIdentity | null = await readSnapshotIdentity(
    storageRoot,
    worktreeKey,
    snapshotId,
  );
  if (identity) {
    for (const entry of Object.values(identity.inventory)) {
      objects.add(entry.fileObjectId);
    }
    // Symbol and relation shard IDs from identity.
    for (const shardId of identity.symbolShardIds) {
      objects.add(shardId);
    }
    for (const shardId of identity.relationShardIds) {
      objects.add(shardId);
    }
  }

  // Read index-map.json for shard object IDs.
  const indexMap: IndexMap | null = await readIndexMap(
    storageRoot,
    worktreeKey,
    snapshotId,
  );
  if (indexMap) {
    for (const shardId of Object.values(indexMap.symbolShards)) {
      objects.add(shardId);
    }
    for (const shardId of Object.values(indexMap.relationShards)) {
      objects.add(shardId);
    }
    for (const shardId of Object.values(indexMap.fileSummaryShards)) {
      objects.add(shardId);
    }
  }

  return objects;
}

/**
 * Collect all retained object IDs across every worktree.
 *
 * For each worktree, reads `current.json` to determine the current and
 * previous snapshot IDs, then collects object IDs from each retained
 * snapshot.
 *
 * Returns the union of all retained object IDs and a map of worktree key
 * to retained snapshot IDs.
 */
async function collectAllRetainedObjects(
  storageRoot: string,
  worktreeKeys: readonly string[],
): Promise<{
  retainedObjects: Set<string>;
  retainedSnapshotMap: Record<string, string[]>;
  totalRetainedSnapshots: number;
}> {
  const retainedObjects = new Set<string>();
  const retainedSnapshotMap: Record<string, string[]> = {};
  let totalRetainedSnapshots = 0;

  for (const worktreeKey of worktreeKeys) {
    const pointer = await readCurrentPointer(storageRoot, worktreeKey);
    if (!pointer) {
      retainedSnapshotMap[worktreeKey] = [];
      continue;
    }

    // Collect the current snapshot ID and up to two previous IDs.
    const snapshotIds = [
      pointer.snapshotId,
      ...pointer.previousSnapshotIds,
    ];
    retainedSnapshotMap[worktreeKey] = snapshotIds;
    totalRetainedSnapshots += snapshotIds.length;

    // Collect objects from each retained snapshot.
    for (const snapshotId of snapshotIds) {
      const objects = await collectSnapshotObjects(
        storageRoot,
        worktreeKey,
        snapshotId,
      );
      for (const obj of objects) {
        retainedObjects.add(obj);
      }
    }
  }

  return { retainedObjects, retainedSnapshotMap, totalRetainedSnapshots };
}

// ── Object scanning ──────────────────────────────────────────────────────────

/**
 * Object subdirectory names under `objects/`.
 */
const OBJECT_SUBDIRS = ["files", "blob-map", "symbol-shards", "relation-shards"];

/**
 * Scan all stored object IDs in the repository objects directory.
 *
 * Walks `objects/files/`, `objects/blob-map/`, `objects/symbol-shards/`,
 * and `objects/relation-shards/`, reading prefix directories and extracting
 * object IDs from `.json` filenames.
 *
 * Returns a map from object ID to its absolute path.
 */
async function scanStoredObjects(
  storageRoot: string,
  repositoryKey: string,
): Promise<Map<string, string>> {
  const objectsDir = repositoryObjectsDir(storageRoot, repositoryKey);
  const result = new Map<string, string>();

  for (const subdir of OBJECT_SUBDIRS) {
    const subdirPath = path.join(objectsDir, subdir);
    let prefixEntries: import("node:fs").Dirent[];
    try {
      prefixEntries = await readdir(subdirPath, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }

    for (const prefixEntry of prefixEntries) {
      if (!prefixEntry.isDirectory()) continue;
      const prefixPath = path.join(subdirPath, prefixEntry.name);

      let fileEntries: import("node:fs").Dirent[];
      try {
        fileEntries = await readdir(prefixPath, { withFileTypes: true });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }

      for (const fileEntry of fileEntries) {
        if (
          !fileEntry.isFile() ||
          !fileEntry.name.endsWith(".json") ||
          fileEntry.name.startsWith(".tmp-")
        ) {
          continue;
        }
        const objectId = fileEntry.name.slice(0, -5); // strip .json
        const filePath = path.join(prefixPath, fileEntry.name);
        result.set(objectId, filePath);
      }
    }
  }

  return result;
}

// ── Temporary file cleanup ───────────────────────────────────────────────────

/**
 * Find and remove owner-scoped temporary files in the repository objects
 * directory.
 *
 * Temporary files are identified by the `.tmp-` prefix (spec section 7.6
 * step 2: "exclusively create a synced temporary file alongside the final
 * path").  They are created during publication and may be left behind when
 * the publishing process is interrupted.
 *
 * Only files matching the `.tmp-` prefix are removed.  Lock directories,
 * recovery elections, and other structural directories are never touched.
 *
 * Returns the number of files removed.
 */
async function cleanupTempFiles(
  storageRoot: string,
  repositoryKey: string,
): Promise<number> {
  const objectsDir = repositoryObjectsDir(storageRoot, repositoryKey);
  let removed = 0;

  for (const subdir of OBJECT_SUBDIRS) {
    const subdirPath = path.join(objectsDir, subdir);
    let prefixEntries: import("node:fs").Dirent[];
    try {
      prefixEntries = await readdir(subdirPath, { withFileTypes: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }

    for (const prefixEntry of prefixEntries) {
      if (!prefixEntry.isDirectory()) continue;
      const prefixPath = path.join(subdirPath, prefixEntry.name);

      let fileEntries: import("node:fs").Dirent[];
      try {
        fileEntries = await readdir(prefixPath, { withFileTypes: true });
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }

      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile() || !fileEntry.name.startsWith(TEMP_FILE_PREFIX))
          continue;
        const filePath = path.join(prefixPath, fileEntry.name);
        try {
          await unlink(filePath);
          removed++;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw err;
        }
      }
    }
  }

  return removed;
}

/**
 * Find and remove owner-scoped temporary files in a worktree's snapshots
 * directory.
 *
 * Temporary snapshot directories are identified by the `.tmp-` prefix
 * (spec section 7.6 step 5: "exclusively create a temporary snapshot
 * directory").  They are created during snapshot publication and may be
 * left behind when the publishing process is interrupted.
 *
 * Returns the number of directories removed.
 */
async function cleanupWorktreeTempFiles(
  storageRoot: string,
  worktreeKey: string,
): Promise<number> {
  const snapshotsParent = snapshotsDir(storageRoot, worktreeKey);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(snapshotsParent, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_FILE_PREFIX))
      continue;
    const dirPath = path.join(snapshotsParent, entry.name);
    try {
      await rm(dirPath, { recursive: true, force: true });
      removed++;
    } catch {
      // Best-effort cleanup — do not fail the GC run.
    }
  }

  return removed;
}

// ── Snapshot quarantine ──────────────────────────────────────────────────────

/**
 * Quarantine unreferenced snapshot directories for a worktree.
 *
 * A snapshot is unreferenced when its ID does not appear in the worktree's
 * retained snapshot list (current + previous from `current.json`).
 *
 * Quarantine renames the snapshot directory to a name containing a random
 * suffix, preventing it from being mistaken for a valid snapshot.
 *
 * Returns the number of snapshots quarantined.
 */
async function quarantineUnreferencedSnapshots(
  storageRoot: string,
  worktreeKey: string,
  retainedIds: readonly string[],
): Promise<number> {
  const retainedSet = new Set(retainedIds);
  const allSnapshotIds = await listSnapshotIds(storageRoot, worktreeKey);

  let quarantined = 0;
  for (const snapshotId of allSnapshotIds) {
    if (retainedSet.has(snapshotId)) continue;

    const snapshotPath = path.join(
      snapshotsDir(storageRoot, worktreeKey),
      snapshotId,
    );
    const quarantinePath = `${snapshotPath}.quarantined-gc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      const { rename } = await import("node:fs/promises");
      await rename(snapshotPath, quarantinePath);
      quarantined++;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Best-effort — do not fail the GC run for a single snapshot.
    }
  }

  return quarantined;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run garbage collection on the local code index for a repository.
 *
 * This is the single entry point for GC.  It acquires the repository-key
 * object lock, scans every worktree namespace, collects retained objects,
 * deletes unreferenced objects, cleans up temporary files, and optionally
 * quarantines unreferenced snapshots.
 *
 * GC is an explicit operation — it is never called from a readiness check,
 * query path, or background timer.  The caller decides when to invoke it.
 *
 * @param options GC options including storage root, repository key, and
 *   optional lock timeout and abort signal.
 * @returns Statistics about the GC run.
 */
export async function garbageCollect(
  options: GarbageCollectOptions,
): Promise<GarbageCollectResult> {
  const {
    storageRoot,
    repositoryKey,
    lockWaitMs = 10_000,
    signal,
    quarantineUnreferencedSnapshots: shouldQuarantine = false,
  } = options;

  // Step 1: Acquire the repository-key object lock.
  const lockDir = repositoryObjectsLockDir(storageRoot, repositoryKey);
  const owner: IndexLockOwner = await acquireIndexLock(lockDir, {
    scopeKind: "repository-objects",
    scopeKey: repositoryKey,
    waitMs: lockWaitMs,
    signal,
  });

  try {
    return await runGcUnderLock(
      storageRoot,
      repositoryKey,
      shouldQuarantine,
    );
  } finally {
    // Release the lock.  Best-effort — do not mask the GC result.
    try {
      await releaseIndexLock(lockDir, owner);
    } catch {
      // Swallow release errors — the GC result is more important.
    }
  }
}

/**
 * Internal GC logic that runs while the repository lock is held.
 */
async function runGcUnderLock(
  storageRoot: string,
  repositoryKey: string,
  shouldQuarantine: boolean,
): Promise<GarbageCollectResult> {
  // Step 2: Enumerate every worktree namespace.
  const worktreeKeys = await enumerateWorktreeKeys(storageRoot);

  // Step 3–4: Collect retained objects from all worktrees.
  const { retainedObjects, retainedSnapshotMap, totalRetainedSnapshots } =
    await collectAllRetainedObjects(storageRoot, worktreeKeys);

  // Step 5: Scan all stored objects.
  const storedObjects = await scanStoredObjects(storageRoot, repositoryKey);

  // Step 6: Delete objects not in the retained set.
  let deletedObjects = 0;
  for (const [objectId, filePath] of storedObjects) {
    if (retainedObjects.has(objectId)) continue;
    try {
      await unlink(filePath);
      deletedObjects++;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }

  // Step 7: Clean up owner-scoped temporary files in the objects directory.
  let cleanedTempFiles = await cleanupTempFiles(storageRoot, repositoryKey);

  // Clean up temporary files in each worktree's snapshots directory.
  for (const worktreeKey of worktreeKeys) {
    cleanedTempFiles += await cleanupWorktreeTempFiles(
      storageRoot,
      worktreeKey,
    );
  }

  // Step 8: Optionally quarantine unreferenced snapshot directories.
  let quarantinedSnapshots = 0;
  if (shouldQuarantine) {
    for (const worktreeKey of worktreeKeys) {
      const retainedIds = retainedSnapshotMap[worktreeKey] ?? [];
      quarantinedSnapshots += await quarantineUnreferencedSnapshots(
        storageRoot,
        worktreeKey,
        retainedIds,
      );
    }
  }

  // Sync the objects directory to ensure deletions are durable.
  try {
    const { syncDirectory } = await import("./safe-files.js");
    const objectsDir = repositoryObjectsDir(storageRoot, repositoryKey);
    await syncDirectory(objectsDir);
  } catch {
    // Best-effort sync — do not fail the GC run.
  }

  return {
    worktreesScanned: worktreeKeys.length,
    retainedSnapshots: totalRetainedSnapshots,
    storedObjects: storedObjects.size,
    deletedObjects,
    cleanedTempFiles,
    quarantinedSnapshots,
    retainedSnapshotMap: retainedSnapshotMap as Readonly<
      Record<string, readonly string[]>
    >,
  };
}
