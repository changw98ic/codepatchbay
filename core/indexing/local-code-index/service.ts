/**
 * Local Code Index v2 — three-entry orchestration facade.
 *
 * Implements spec sections 7.6 (Publication), 5 (Interface), 8 (Freshness),
 * and 12 (Errors) for the local code index.
 *
 * Three public operations:
 *   1. `ensureLocalCodeIndex` — create or refresh an exact snapshot.
 *   2. `localCodeIndexStatus` — inspect the last published snapshot
 *      without writing any persistent bytes.
 *   3. `queryLocalCodeIndex` — (Phase 7; not implemented here).
 *
 * Publication protocol (spec section 7.6, 16 steps):
 *   1.  Acquire repository-key object lock, then worktree-key lock.
 *   2.  Exclusively create each missing object temporary file.
 *   3.  Write, sync, close, and identity-check each temporary file.
 *   4.  Atomically publish each absent final object path (exclusive
 *       hard link), unlink temp, fsync object directory.
 *   5.  Exclusively create temporary snapshot directory.
 *   6.  Write, sync, close, and verify index-map.json.
 *   7.  Write, sync, close, and verify identity.json.
 *   8.  Fsync the temporary snapshot directory.
 *   9.  Rename to snapshots/<snapshot-id>, fsync snapshots/.
 *   10. Reopen both snapshot files and verify exact shape.
 *   11. Re-observe exact source state.
 *   12. Write run-report, sync, close, rename, fsync runs/.
 *   13. Build current.json with worktree key, snapshot ID,
 *       identity hash, owner token, and two previous snapshot IDs.
 *   14. Write, sync, close, and identity-check current.json.
 *   15. Atomically rename over current.json, fsync worktree namespace.
 *   16. Release locks only if owner token and lock directory identity
 *       still match (reverse order).
 *
 * Retry policy: if source state changes before step 13, the operation
 * retries once from a new inventory. A second change fails with
 * `source_changed_during_index`.
 *
 * Force policy: `force: true` performs a full parse while retaining
 * both exact observations and every durable publication check.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md
 * Plan: docs/architecture/local-code-index-v2-implementation-plan.md Phase 6
 *
 * Dependencies: node:crypto, node:fs/promises, node:path,
 *   contracts.ts, paths.ts, lock.ts, safe-files.ts,
 *   git-observer.ts, directory-observer.ts, change-plan.ts,
 *   extract.ts, ast-grep-adapter.ts, object-store.ts,
 *   relationships.ts, shards.ts, snapshot-store.ts, coverage.ts,
 *   canonical-json.ts.
 */

import { createHash } from "node:crypto";
import { mkdir, open, rename, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import {
  LocalCodeIndexUnavailableError,
  deriveRepositoryKey,
  deriveWorktreeKey,
} from "./contracts.js";
import type {
  EnsureLocalCodeIndexOptions,
  EnsureLocalCodeIndexResult,
  LocalCodeIndexStatus,
  LocalCodeIndexRef,
  LocalCodeIndexToolState,
  LocalCodeIndexBuildStats,
  LocalCodeIndexCoverageSummary,
} from "./contracts.js";

import {
  resolveStorageRoot,
  validateSourcePath,
  computeKeys,
  repositoryObjectsLockDir,
  worktreeLockDir,
  worktreeCurrentPointer,
  snapshotDir,
  snapshotIdentityPath,
  fileObjectPath,
  symbolShardPath,
  relationShardPath,
  repositoryReusableSnapshotPath,
  tempFileName,
} from "./paths.js";

import { withOrderedIndexLocks } from "./lock.js";
import type { IndexLockOwner } from "./lock.js";

import { readBoundedFileNoFollow, syncDirectory } from "./safe-files.js";

import { canonicalStringify } from "./canonical-json.js";

import {
  observeGitSourceState,
  observeGitSourceStateOnce,
  resolveGitCommonDirectory,
} from "./git-observer.js";
import type {
  SourceStatePayload,
  InventoryEntry,
  GitObservationResult,
} from "./git-observer.js";

import { observeDirectory, areSourceStatesEqual } from "./directory-observer.js";
import type { DirectorySourceState } from "./directory-observer.js";

import { buildChangePlan, isChangePlanEmpty, getComputeEntries } from "./change-plan.js";
import type {
  SourceState,
  SourceStateEntry,
  RepositoryIdentity,
  ChangePlan,
} from "./change-plan.js";

import {
  extractFileFacts,
  languageForFile,
  computeLanguageExtractorFingerprint,
} from "./extract.js";
import {
  AstGrepAdapter,
  AST_GREP_OUTLINE_BATCH_SIZE,
  AST_GREP_REFERENCE_BATCH_SIZE,
  outlineFileToParseResult,
} from "./ast-grep-adapter.js";
import type {
  AstGrepFileResult,
  AstGrepSymbol,
} from "./ast-grep-adapter.js";
import type {
  FileExtractionResult,
  SupportedLanguage,
  ExtractedDefinition,
  ExtractedReference,
  ExtractedImport,
} from "./extract.js";

import {
  publishFileObjects,
  publishObjects,
  readFileObject,
} from "./object-store.js";
import type { FileObject, PublishObjectsOptions } from "./object-store.js";

import { buildAllRelationships } from "./relationships.js";
import type {
  BuildRelationshipsResult,
  ResolutionConfig,
  PathInventoryEntry,
  RelationshipShard,
} from "./relationships.js";

import {
  buildSymbolShard,
  buildRelationShard,
  deriveShardObjectId,
  distributeBySymbol,
  distributeByPath,
  pathBucketKey,
  rebuildShards,
} from "./shards.js";
import type {
  ShardSymbolEntry,
  ShardFileSummaryEntry,
  ShardRelationshipEntry,
  ShardRebuildInput,
  ShardRebuildResult,
  RelationShard,
} from "./shards.js";

import {
  publishSnapshot,
  writeRunReport,
  readSnapshotIdentity,
  readIndexMap,
  verifySnapshotIdentity,
  verifyIndexMap,
  deriveSnapshotId,
} from "./snapshot-store.js";
import type {
  SnapshotIdentity,
  SnapshotInventoryEntry,
  SnapshotToolState,
  GitIdentity,
  IndexMap,
} from "./snapshot-store.js";

import { aggregateCoverage } from "./coverage.js";
import type { FileCoverageOutcome } from "./coverage.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Maximum bytes for reading current.json. */
const MAX_CURRENT_JSON_BYTES = 4096;

/** Maximum bytes for reading snapshot files during verification. */
const MAX_SNAPSHOT_READ_BYTES = 32 * 1024 * 1024;

/** Maximum source file size for extraction (5 MiB). */
const MAX_SOURCE_FILE_BYTES = 5 * 1024 * 1024;
const INDEX_EXTRACTION_SCHEMA_VERSION = 2;
const SHARD_LAYOUT_VERSION = 4;

function indexExtractorFingerprint(parserVersion: string | null): string {
  return createHash("sha256")
    .update([
      `parser:${parserVersion ?? "none"}`,
      `extraction-schema:${INDEX_EXTRACTION_SCHEMA_VERSION}`,
      `shard-layout:${SHARD_LAYOUT_VERSION}`,
    ].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

// ── Current-pointer type ───────────────────────────────────────────────────

/**
 * Internal representation of the current.json pointer file.
 *
 * Spec section 7.6 step 13: "containing worktree key, snapshot ID,
 * identity hash, publication owner token, and a deduplicated
 * newest-first list of the two previously current snapshot IDs."
 */
type CurrentPointer = Readonly<{
  schemaVersion: 1;
  worktreeKey: string;
  snapshotId: string;
  identityHash: string;
  ownerToken: string;
  publishedAt: string;
  previousSnapshotIds: readonly string[];
}>;

/**
 * A repository-scoped pointer to one immutable snapshot. It is published only
 * for clean Git states, so a different worktree may reuse its already-parsed
 * file objects after matching the content-derived state key below.
 */
type ReusableGitSnapshotRecord = Readonly<{
  schemaVersion: 2;
  reusableStateKey: string;
  repositoryKey: string;
  extractorFingerprint: string;
  worktreeKey: string;
  snapshotId: string;
}>;

type ReusableIndexBaseline = Readonly<{
  identity: SnapshotIdentity;
  indexMap: IndexMap;
  existingObjectIds: Set<string>;
}>;

function usesLegacyShardBuckets(indexMap: IndexMap | null): boolean {
  if (indexMap === null) return false;
  return Object.keys(indexMap.relationShards).some(
    (key) => !/^rel-[0-9a-f]{2}$/u.test(key),
  );
}

// ── Promise coalescing ─────────────────────────────────────────────────────

/**
 * In-process promise coalescing map keyed by `storageRoot + "\0" + sourceKey`.
 *
 * Prevents duplicate concurrent builds for the same source.  The promise
 * is removed from the map when it settles (resolve or reject).
 */
const inflightEnsure = new Map<string, Promise<EnsureLocalCodeIndexResult>>();

function coalesceKey(storageRoot: string, sourceKey: string): string {
  return `${storageRoot}\0${sourceKey}`;
}

// ── Public entry: ensureLocalCodeIndex ─────────────────────────────────────

/**
 * Create or refresh an exact local code index snapshot.
 *
 * Implements in-process promise coalescing keyed by storage root + source key.
 * Holds repository then worktree locks through the 16-step publication protocol.
 * Retries once on source mutation; fails on second change.
 *
 * @param options - Source path, optional CPB root, optional force flag, optional abort signal.
 * @returns The published snapshot ref, tool state, and build statistics.
 * @throws {LocalCodeIndexUnavailableError} on any failure.
 */
export async function ensureLocalCodeIndex(
  options: EnsureLocalCodeIndexOptions,
): Promise<EnsureLocalCodeIndexResult> {
  const {
    sourcePath,
    cpbRoot,
    astGrepBinaryPath = process.env.CPB_AST_GREP_BINARY ?? "ast-grep",
    force = false,
    signal,
  } = options;

  // A pre-aborted request must not start ast-grep merely to discover its
  // version and then kill that child. Reject before any filesystem authority
  // acquisition or subprocess creation.
  signal?.throwIfAborted();

  // ── Resolve storage root and keys ─────────────────────────────────────
  const canonicalSource = await validateSourcePath(sourcePath);
  const storageRoot = await resolveStorageRoot(cpbRoot, canonicalSource);

  // Determine whether this is a Git repository and key its shared object
  // namespace by Git's common directory. A linked worktree has a `.git` file,
  // so keying by its source directory would prevent any cross-worktree reuse.
  let commonGitDir = canonicalSource;
  let isGit = false;
  try {
    await lstat(path.join(canonicalSource, ".git"));
    isGit = true;
  } catch {
    // Not Git.
  }
  if (isGit) {
    commonGitDir = await resolveGitCommonDirectory(canonicalSource);
  }

  const { repositoryKey, worktreeKey, sourceKey } = computeKeys(
    commonGitDir,
    canonicalSource,
  );
  const astGrepAdapter = new AstGrepAdapter({
    binaryPath: astGrepBinaryPath,
    cwd: canonicalSource,
  });

  // ── Promise coalescing ────────────────────────────────────────────────
  const key = `${coalesceKey(storageRoot, sourceKey)}\0${astGrepBinaryPath}`;
  const existing = inflightEnsure.get(key);
  if (existing !== undefined) {
    return existing;
  }

  const promise = ensureLocalCodeIndexInner(
    storageRoot,
    repositoryKey,
    worktreeKey,
    sourceKey,
    canonicalSource,
    isGit,
    astGrepAdapter,
    force,
    signal,
  ).finally(() => {
    inflightEnsure.delete(key);
  });

  inflightEnsure.set(key, promise);
  return promise;
}

// ── Inner ensure implementation ────────────────────────────────────────────

/**
 * Core ensure implementation.  Called once per coalesce key.
 */
async function ensureLocalCodeIndexInner(
  storageRoot: string,
  repositoryKey: string,
  worktreeKey: string,
  sourceKey: string,
  canonicalSource: string,
  isGit: boolean,
  astGrepAdapter: AstGrepAdapter,
  force: boolean,
  signal?: AbortSignal,
): Promise<EnsureLocalCodeIndexResult> {
  const parserVersion = await astGrepAdapter.getVersion(signal);
  const expectedExtractorFingerprint = indexExtractorFingerprint(parserVersion);
  let isFirstAttempt = true;

  while (true) {
    signal?.throwIfAborted();

    // ── Read current pointer ────────────────────────────────────────────
    let currentPtr = await readCurrentPointer(storageRoot, worktreeKey);
    // Repository objects were previously keyed by the source directory. Once
    // a worktree correctly switches to the shared Git common-directory key,
    // its old pointer cannot safely name objects in the new namespace. Drop
    // that pointer and rebuild a canonical snapshot instead of mixing stores.
    if (currentPtr !== null) {
      const pointerIdentity = await readSnapshotIdentity(
        storageRoot,
        worktreeKey,
        currentPtr.snapshotId,
      );
      if (pointerIdentity === null || pointerIdentity.repositoryKey !== repositoryKey) {
        currentPtr = null;
      }
    }

    // ── Observe source state (first observation) ────────────────────────
    const firstObservation = await observeSourceState(canonicalSource, isGit);

    // ── Detect source mutation between observations ─────────────────────
    let sourceStateForPlan: SourceState;
    let originalObservation: SourceStatePayload | DirectorySourceState;

    if (isGit) {
      const gitObs = firstObservation as GitObservationResult;
      originalObservation = gitObs.payload;
      if (gitObs.state === "changed") {
        if (!isFirstAttempt) {
          throw new LocalCodeIndexUnavailableError("source_changed_during_index", {
            sourcePath: canonicalSource,
          });
        }
        isFirstAttempt = false;
        continue;
      }
      sourceStateForPlan = convertGitToSourceState(
        gitObs.payload,
        canonicalSource,
        parserVersion,
      );
    } else {
      const dirObs = firstObservation as DirectorySourceState;
      originalObservation = dirObs;
      // Second observation for non-Git.
      const secondObs = await observeDirectory({ sourcePath: canonicalSource, signal });
      if (!areSourceStatesEqual(dirObs, secondObs)) {
        if (!isFirstAttempt) {
          throw new LocalCodeIndexUnavailableError("source_changed_during_index", {
            sourcePath: canonicalSource,
          });
        }
        isFirstAttempt = false;
        continue;
      }
      sourceStateForPlan = convertDirectoryToSourceState(
        dirObs,
        canonicalSource,
        parserVersion,
      );
    }

    // A clean worktree at the same content-derived Git state can borrow the
    // previous worktree's immutable objects and shards. It still receives its
    // own snapshot identity and current pointer, so freshness remains local to
    // this worktree.
    const reusableStateKey = isGit
      ? deriveReusableGitStateKey(
        originalObservation as SourceStatePayload,
        expectedExtractorFingerprint,
      )
      : null;
    const reusableBaseline = (
      !force && currentPtr === null && reusableStateKey !== null
    )
      ? await readReusableIndexBaseline(
        storageRoot,
        repositoryKey,
        reusableStateKey,
        expectedExtractorFingerprint,
      )
      : null;

    // ── Read previous snapshot state ────────────────────────────────────
    let previousSourceState: SourceState | null = null;
    let previousIdentity: SnapshotIdentity | null = null;
    let existingObjectIds = new Set<string>();

    if (currentPtr !== null && !force) {
      const prevIdentity = await readSnapshotIdentity(
        storageRoot,
        worktreeKey,
        currentPtr.snapshotId,
      );
      if (prevIdentity !== null) {
        const previousIndexMap = await readIndexMap(
          storageRoot,
          worktreeKey,
          currentPtr.snapshotId,
        );
        if (
          !usesLegacyShardBuckets(previousIndexMap)
          && prevIdentity.extractorFingerprint === expectedExtractorFingerprint
          && hasCompleteExtractionIdentity(prevIdentity)
        ) {
          const verifiedObjectIds = await buildExistingFileObjectIds(
            storageRoot,
            repositoryKey,
            prevIdentity,
          );
          if (hasAllInventoryObjects(prevIdentity, verifiedObjectIds)) {
            previousIdentity = prevIdentity;
            previousSourceState = convertIdentityToSourceState(prevIdentity);
            existingObjectIds = verifiedObjectIds;
          }
        }
      }
    }

    if (reusableBaseline !== null) {
      previousIdentity = reusableBaseline.identity;
      previousSourceState = convertIdentityToSourceState(reusableBaseline.identity);
      existingObjectIds = reusableBaseline.existingObjectIds;
    }

    sourceStateForPlan = await hydrateObservedContentIds(
      sourceStateForPlan,
      previousSourceState,
      canonicalSource,
      signal,
      reusableBaseline?.identity ?? null,
    );
    sourceStateForPlan = alignObservedEntriesWithPreviousExtraction(
      sourceStateForPlan,
      previousSourceState,
    );

    // ── Build change plan ───────────────────────────────────────────────
    const changePlan = buildChangePlan({
      previous: previousSourceState,
      current: sourceStateForPlan,
      force,
      existingObjectIds,
    });

    if (
      !force
      && currentPtr !== null
      && previousIdentity !== null
      && isChangePlanEmpty(changePlan)
      && changePlan.entries.every((entry) =>
        entry.decision !== "reuse" || entry.existingFileObjectId !== null
      )
    ) {
      await verifySourceUnchanged(canonicalSource, originalObservation, isGit);
      return reusedEnsureResult(
        previousIdentity,
        canonicalSource,
        sourceKey,
        changePlan.summary.reuse,
      );
    }

    // ── Acquire locks and run publication protocol ──────────────────────
    try {
      return await runPublicationProtocol(
        storageRoot,
        repositoryKey,
        worktreeKey,
        sourceKey,
        canonicalSource,
        sourceStateForPlan,
        changePlan,
        currentPtr,
        isGit,
        astGrepAdapter,
        parserVersion,
        expectedExtractorFingerprint,
        force,
        signal,
        originalObservation,
        reusableBaseline,
        reusableStateKey,
      );
    } catch (error: unknown) {
      if (
        error instanceof LocalCodeIndexUnavailableError &&
        error.reason === "source_changed_during_index"
      ) {
        if (!isFirstAttempt) {
          throw error;
        }
        isFirstAttempt = false;
        continue;
      }
      throw error;
    }
  }
}

// ── Publication protocol ───────────────────────────────────────────────────

/**
 * Run the 16-step publication protocol under ordered locks.
 */
async function runPublicationProtocol(
  storageRoot: string,
  repositoryKey: string,
  worktreeKey: string,
  sourceKey: string,
  canonicalSource: string,
  sourceState: SourceState,
  changePlan: ChangePlan,
  currentPtr: CurrentPointer | null,
  isGit: boolean,
  astGrepAdapter: AstGrepAdapter,
  parserVersion: string | null,
  expectedExtractorFingerprint: string,
  force: boolean,
  signal: AbortSignal | undefined,
  originalObservation: SourceStatePayload | DirectorySourceState,
  reusableBaseline: ReusableIndexBaseline | null,
  reusableStateKey: string | null,
): Promise<EnsureLocalCodeIndexResult> {
  const repositoryLockDir = repositoryObjectsLockDir(storageRoot, repositoryKey);
  const worktreeLock = worktreeLockDir(storageRoot, worktreeKey);
  const startTime = Date.now();

  // Step 1: Acquire repository-key object lock, then worktree-key lock.
  return withOrderedIndexLocks(
    repositoryLockDir,
    worktreeLock,
    { scopeKey: repositoryKey, signal },
    { scopeKey: worktreeKey, signal },
    async ({ repositoryOwner, worktreeOwner }) => {
      // ── Steps 2–4: Extract, build objects, and publish ──────────────
      const extractionResult = await extractAndPublishObjects(
        storageRoot,
        repositoryKey,
        canonicalSource,
        sourceState,
        changePlan,
        repositoryOwner,
        astGrepAdapter,
        parserVersion,
        expectedExtractorFingerprint,
        signal,
      );

      // ── Build relationships and shards ──────────────────────────────
      const prevIds = force
        ? emptyPreviousShardIds()
        : reusableBaseline !== null
          ? previousShardIdsFromIndexMap(reusableBaseline.indexMap)
          : await readPreviousShardIds(currentPtr, storageRoot, worktreeKey);
      const previousIdentity = force
        ? null
        : reusableBaseline?.identity ?? (currentPtr === null
          ? null
          : await readSnapshotIdentity(storageRoot, worktreeKey, currentPtr.snapshotId));
      const shardResult = await buildAndPublishShards(
        storageRoot,
        repositoryKey,
        sourceState,
        extractionResult,
        changePlan,
        previousIdentity,
        prevIds,
        repositoryOwner,
        signal,
      );

      // ── Steps 5–9: Publish snapshot ────────────────────────────────
      const snapshotPublicationStart = Date.now();
      const snapshotResult = await publishSnapshotWithVerification(
        storageRoot,
        worktreeKey,
        repositoryKey,
        sourceKey,
        canonicalSource,
        sourceState,
        extractionResult,
        shardResult,
        worktreeOwner,
      );
      const snapshotPublicationMs = Date.now() - snapshotPublicationStart;
      const timings = {
        ...extractionResult.timings,
        relationshipMs: shardResult.relationshipMs,
        shardPublicationMs: shardResult.shardPublicationMs,
        snapshotPublicationMs,
        publicationMs: extractionResult.timings.fileObjectPublicationMs
          + shardResult.shardPublicationMs
          + snapshotPublicationMs,
      };

      // ── Step 10: Verify snapshot identity ──────────────────────────
      await verifyPublishedSnapshot(
        storageRoot,
        worktreeKey,
        snapshotResult.snapshotId,
        snapshotResult.identityBytes,
        snapshotResult.indexMapBytes,
      );

      // ── Step 11: Re-observe exact source state ─────────────────────
      await verifySourceUnchanged(canonicalSource, originalObservation, isGit);

      // ── Step 12: Write run report ──────────────────────────────────
      const runDurationMs = Date.now() - startTime;
      const buildMode = force || (currentPtr === null && reusableBaseline === null)
        ? "full" as const
        : changePlan.summary.compute > 0
          ? "incremental" as const
          : "reused" as const;

      await writeRunReport({
        storageRoot,
        worktreeKey,
        ownerToken: worktreeOwner.ownerToken,
        snapshotId: snapshotResult.snapshotId,
        mode: buildMode,
        durationMs: runDurationMs,
        discoveredFiles: sourceState.entries.length,
        reusedFiles: changePlan.summary.reuse,
        hashedFiles: sourceState.entries.length,
        parsedFiles: changePlan.summary.compute,
        deletedFiles: changePlan.summary.delete,
        oversizedFiles: extractionResult.oversizedFiles,
        rebuiltSymbolShards: shardResult.rebuiltSymbolShards,
        rebuiltRelationShards: shardResult.rebuiltRelationShards,
        bytesRead: extractionResult.bytesRead,
        bytesWritten: snapshotResult.bytesWritten + shardResult.bytesWritten,
        timings,
      });

      // ── Steps 13–15: Publish current pointer ───────────────────────
      await publishCurrentPointer(
        storageRoot,
        worktreeKey,
        snapshotResult.snapshotId,
        snapshotResult.identityBytes,
        worktreeOwner,
        currentPtr,
      );

      if (isGit && reusableStateKey !== null && reusableBaseline === null) {
        await publishReusableGitSnapshot(
          storageRoot,
          repositoryKey,
          reusableStateKey,
          expectedExtractorFingerprint,
          worktreeKey,
          snapshotResult.snapshotId,
          repositoryOwner,
        );
      }

      // ── Build result ────────────────────────────────────────────────
      const ref: LocalCodeIndexRef = {
        schemaVersion: 2,
        sourcePath: canonicalSource,
        repositoryKey,
        worktreeKey,
        sourceKey,
        snapshotId: snapshotResult.snapshotId,
      };

      const toolState: LocalCodeIndexToolState = {
        name: "ast-grep",
        version: extractionResult.parserVersion,
        extractorFingerprint: extractionResult.extractorFingerprint,
        available: extractionResult.parserVersion !== null,
        coverage: extractionResult.coverage,
        errors: [],
      };

      const stats: LocalCodeIndexBuildStats = {
        mode: buildMode,
        discoveredFiles: sourceState.entries.length,
        reusedFiles: changePlan.summary.reuse,
        hashedFiles: sourceState.entries.length,
        parsedFiles: changePlan.summary.compute,
        deletedFiles: changePlan.summary.delete,
        oversizedFiles: extractionResult.oversizedFiles,
        rebuiltSymbolShards: shardResult.rebuiltSymbolShards,
        rebuiltRelationShards: shardResult.rebuiltRelationShards,
        bytesRead: extractionResult.bytesRead,
        bytesWritten: snapshotResult.bytesWritten + shardResult.bytesWritten,
        coverage: extractionResult.coverage,
        parserVersion: extractionResult.parserVersion,
        timings,
        durationMs: runDurationMs,
      };

      return { available: true as const, ref, tool: toolState, stats };
    },
  );
}

// ── Public entry: localCodeIndexStatus ─────────────────────────────────────

/**
 * Exact, read-only status inspection of the local code index.
 *
 * Writes no persistent bytes.  Reads current.json, snapshot identity,
 * and index-map to produce an exact status report.
 */
export async function localCodeIndexStatus(
  options: Readonly<{ cpbRoot?: string; sourcePath: string }>,
): Promise<LocalCodeIndexStatus> {
  const { sourcePath, cpbRoot } = options;

  // ── Resolve and validate paths ────────────────────────────────────────
  let canonicalSource: string;
  try {
    canonicalSource = await validateSourcePath(sourcePath);
  } catch {
    return {
      available: false as const,
      fresh: false as const,
      exact: false as const,
      reason: "unsafe_source_path",
      sourcePath: sourcePath ?? null,
    };
  }

  let storageRoot: string;
  try {
    storageRoot = await resolveStorageRoot(cpbRoot, canonicalSource, {
      readOnly: true,
    });
  } catch {
    return {
      available: false as const,
      fresh: false as const,
      exact: false as const,
      reason: "unsafe_storage_root",
      sourcePath: canonicalSource,
    };
  }

  let commonGitDir = canonicalSource;
  try {
    await lstat(path.join(canonicalSource, ".git"));
    commonGitDir = await resolveGitCommonDirectory(canonicalSource);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        available: false as const,
        fresh: false as const,
        exact: false as const,
        reason: "unsupported_git_state",
        sourcePath: canonicalSource,
      };
    }
  }
  const { repositoryKey, worktreeKey, sourceKey } = computeKeys(commonGitDir, canonicalSource);

  // ── Read current pointer ──────────────────────────────────────────────
  const currentPtr = await readCurrentPointer(storageRoot, worktreeKey);
  if (currentPtr === null) {
    return {
      available: false as const,
      fresh: false as const,
      exact: false as const,
      reason: "missing_local_code_index",
      sourcePath: canonicalSource,
    };
  }

  // ── Read snapshot identity ────────────────────────────────────────────
  const identity = await readSnapshotIdentity(
    storageRoot,
    worktreeKey,
    currentPtr.snapshotId,
  );
  if (identity === null) {
    return {
      available: false as const,
      fresh: false as const,
      exact: false as const,
      reason: "corrupt_index",
      sourcePath: canonicalSource,
    };
  }

  if (identity.schemaVersion !== 2) {
    return {
      available: false as const,
      fresh: false as const,
      exact: false as const,
      reason: "unsupported_index_schema",
      sourcePath: canonicalSource,
    };
  }

  // ── Verify identity hash ──────────────────────────────────────────────
  const identityBytes = new TextEncoder().encode(canonicalStringify(identity));
  const identityHash = createHash("sha256").update(identityBytes).digest("hex");
  if (identityHash !== currentPtr.identityHash) {
    return {
      available: false as const,
      fresh: false as const,
      exact: false as const,
      reason: "corrupt_index",
      sourcePath: canonicalSource,
    };
  }

  // ── Build ref ─────────────────────────────────────────────────────────
  const ref: LocalCodeIndexRef = {
    schemaVersion: 2,
    sourcePath: canonicalSource,
    repositoryKey,
    worktreeKey,
    sourceKey,
    snapshotId: currentPtr.snapshotId,
  };

  // ── Compute file count and indexed bytes from inventory ───────────────
  let files = 0;
  let indexedBytes = 0;
  for (const entry of Object.values(identity.inventory)) {
    files += 1;
    indexedBytes += parseInt(entry.metadata.size, 10) || 0;
  }

  // ── Build tool state from identity ────────────────────────────────────
  const tool: LocalCodeIndexToolState = {
    name: identity.toolState.name,
    version: identity.toolState.version,
    extractorFingerprint: identity.extractorFingerprint,
    available: identity.toolState.available,
    coverage: {
      effective: identity.toolState.coverage,
      partial: false,
      failedFiles: 0,
      oversizedFiles: 0,
    },
    errors: [...identity.toolState.errors],
  };

  // ── Observe the current source twice ─────────────────────────────────
  //
  // The current pointer only proves which snapshot was published. It cannot
  // prove that the worktree still matches that snapshot. Compare two complete
  // current observations first, then compare their stable fingerprint with the
  // fingerprint persisted in identity.json.
  let currentFingerprint: string;
  try {
    let isGit = false;
    try {
      await lstat(path.join(canonicalSource, ".git"));
      isGit = true;
    } catch {
      // Non-Git directory.
    }

    if (isGit) {
      // observeGitSourceState already performs and byte-compares two complete
      // observations. Retry that atomic observation once for a transient
      // metadata race, rather than nesting another redundant double-observe.
      let observation = await observeGitSourceState(canonicalSource);
      if (observation.state === "changed") {
        observation = await observeGitSourceState(canonicalSource);
      }
      if (observation.state === "changed") {
        return {
          available: false as const,
          fresh: false as const,
          exact: false as const,
          reason: "source_changed_during_index",
          sourcePath: canonicalSource,
        };
      }
      currentFingerprint = convertGitToSourceState(
        observation.payload,
        canonicalSource,
        identity.toolState.version,
      ).worktreeStateFingerprint;
    } else {
      const observationA = await observeDirectory({ sourcePath: canonicalSource });
      const observationB = await observeDirectory({ sourcePath: canonicalSource });
      if (!areSourceStatesEqual(observationA, observationB)) {
        return {
          available: false as const,
          fresh: false as const,
          exact: false as const,
          reason: "source_changed_during_index",
          sourcePath: canonicalSource,
        };
      }
      currentFingerprint = convertDirectoryToSourceState(
        observationA,
        canonicalSource,
        identity.toolState.version,
      ).worktreeStateFingerprint;
    }
  } catch (error: unknown) {
    const reason = error instanceof LocalCodeIndexUnavailableError
      ? error.reason
      : "unsafe_source_path";
    return {
      available: false as const,
      fresh: false as const,
      exact: false as const,
      reason,
      sourcePath: canonicalSource,
    };
  }

  const fresh = currentFingerprint === identity.worktreeStateFingerprint;

  return {
    available: true as const,
    fresh,
    exact: true as const,
    reason: fresh ? null : "local_code_index_stale",
    ref,
    tool,
    files,
    indexedBytes,
  };
}

// ── Source observation helpers ─────────────────────────────────────────────

/**
 * Observe source state.  For Git, delegates to the git-observer which
 * performs two internal observations.  For non-Git, performs one observation
 * (the caller handles the second observation and comparison).
 */
async function observeSourceState(
  canonicalSource: string,
  isGit: boolean,
): Promise<GitObservationResult | DirectorySourceState> {
  if (isGit) {
    return {
      state: "clean",
      payload: await observeGitSourceStateOnce(canonicalSource),
    };
  }
  return observeDirectory({ sourcePath: canonicalSource });
}

/**
 * Convert a Git source-state payload to the change-plan SourceState type.
 *
 * The git-observer InventoryEntry has raw Git data (stage, attributes,
 * porcelain).  We derive the change-plan fields from that data:
 * - contentId: computed from reading the file bytes (deferred to extraction)
 * - language: detected from file extension
 * - gitBlobId: from stage entry
 * - materializationFingerprint: from attributes + materialization config
 */
function convertGitToSourceState(
  payload: SourceStatePayload,
  canonicalSource: string,
  parserVersion: string | null,
): SourceState {
  const repository: RepositoryIdentity = {
    commonGitDir: payload.commonDir,
    objectFormat: payload.objectFormat,
    head: payload.headCommit,
    branch: payload.branch,
  };

  // Derive materialization config for the change-plan type.
  const autocrlfValue: boolean | "input" =
    payload.materializationConfig.autocrlf === "input"
      ? "input"
      : payload.materializationConfig.autocrlf !== "false";
  const eolValue: "lf" | "crlf" | "native" | "auto" =
    payload.materializationConfig.eol === "lf" ||
    payload.materializationConfig.eol === "crlf" ||
    payload.materializationConfig.eol === "native" ||
    payload.materializationConfig.eol === "auto"
      ? payload.materializationConfig.eol
      : "native";

  const presentEntries = payload.entries.filter((e): e is typeof e & { metadata: NonNullable<typeof e.metadata> } => e.metadata !== null);
  const entries: SourceStateEntry[] = presentEntries.map((e) => {
    const lang = languageForFile(e.path);
    const structurallySupported = lang && lang !== "json" && lang !== "yaml"
      && lang !== "css" && lang !== "html" && lang !== "markdown"
      ? true
      : false;
    const parserMode = structurallySupported
      ? parserVersion === null ? "lexical-fallback" : "structural"
      : "file-inventory-only";
    const extractorFingerprint = lang
      ? computeLanguageExtractorFingerprint(lang, parserMode, parserVersion)
      : computeLanguageExtractorFingerprint(
          "unknown" as SupportedLanguage,
          "file-inventory-only",
          null,
        );

    return {
      path: e.path,
      contentId: "", // Will be computed during extraction.
      language: lang ?? "unknown",
      parserMode,
      languageExtractorFingerprint: extractorFingerprint,
      metadata: {
        device: e.metadata.device,
        inode: e.metadata.inode,
        size: e.metadata.size,
        mtimeNs: e.metadata.mtimeNs,
        ctimeNs: e.metadata.ctimeNs,
        mode: e.metadata.mode,
      },
      gitBlobId: e.stage?.blobId ?? null,
      materializationFingerprint: buildMaterializationFingerprint(
        e.attributes,
        payload.materializationConfig,
      ),
    };
  });

  return {
    repository,
    materialization: {
      autocrlf: autocrlfValue,
      eol: eolValue,
      attributesFile: payload.materializationConfig.attributesFile,
    },
    entries,
    worktreeStateFingerprint: computePayloadFingerprint(payload),
    observedAt: Date.now(),
  };
}

/**
 * Convert a DirectorySourceState to the change-plan SourceState type.
 */
function convertDirectoryToSourceState(
  state: DirectorySourceState,
  canonicalSource: string,
  parserVersion: string | null,
): SourceState {
  const repository: RepositoryIdentity = {
    commonGitDir: null,
    objectFormat: null,
    head: null,
    branch: null,
  };

  const entries: SourceStateEntry[] = [];
  for (const [relativePath, meta] of Object.entries(state.inventory)) {
    const lang = languageForFile(relativePath);
    const structurallySupported = lang && lang !== "json" && lang !== "yaml"
      && lang !== "css" && lang !== "html" && lang !== "markdown"
      ? true
      : false;
    const parserMode = structurallySupported
      ? parserVersion === null ? "lexical-fallback" : "structural"
      : "file-inventory-only";
    const extractorFingerprint = lang
      ? computeLanguageExtractorFingerprint(lang, parserMode, parserVersion)
      : computeLanguageExtractorFingerprint(
          "unknown" as SupportedLanguage,
          "file-inventory-only",
          null,
        );

    entries.push({
      path: relativePath,
      contentId: meta.contentId,
      language: lang ?? "unknown",
      parserMode,
      languageExtractorFingerprint: extractorFingerprint,
      metadata: {
        device: meta.device,
        inode: meta.inode,
        size: String(meta.size),
        mtimeNs: meta.mtimeNs,
        ctimeNs: meta.ctimeNs,
        mode: meta.mode,
      },
      gitBlobId: null,
      materializationFingerprint: null,
    });
  }

  return {
    repository,
    materialization: {
      autocrlf: false,
      eol: "lf",
      attributesFile: null,
    },
    entries,
    worktreeStateFingerprint: state.canonicalHash,
    observedAt: Date.now(),
  };
}

/**
 * Convert a stored snapshot identity back to a SourceState for change planning.
 */
function convertIdentityToSourceState(
  identity: SnapshotIdentity,
): SourceState {
  const repository: RepositoryIdentity = {
    commonGitDir: identity.git?.commonDir ?? null,
    objectFormat: identity.git?.objectFormat ?? null,
    head: identity.git?.head ?? null,
    branch: identity.git?.branch ?? null,
  };

  const entries: SourceStateEntry[] = [];
  for (const [relativePath, invEntry] of Object.entries(identity.inventory)) {
    entries.push({
      path: relativePath,
      contentId: invEntry.sourceContentId,
      language: invEntry.language,
      parserMode: invEntry.parserMode,
      languageExtractorFingerprint: invEntry.languageExtractorFingerprint,
      metadata: {
        device: invEntry.metadata.device,
        inode: invEntry.metadata.inode,
        size: invEntry.metadata.size,
        mtimeNs: invEntry.metadata.mtimeNs,
        ctimeNs: invEntry.metadata.ctimeNs,
        mode: invEntry.metadata.mode,
      },
      gitBlobId: null,
      materializationFingerprint: null,
    });
  }

  return {
    repository,
    materialization: {
      autocrlf: false,
      eol: "lf",
      attributesFile: null,
    },
    entries,
    worktreeStateFingerprint: identity.worktreeStateFingerprint,
    observedAt: Date.now(),
  };
}

function hasCompleteExtractionIdentity(identity: SnapshotIdentity): boolean {
  return Object.values(identity.inventory).every((entry) =>
    typeof entry.language === "string"
    && entry.language.length > 0
    && typeof entry.parserMode === "string"
    && entry.parserMode.length > 0
    && typeof entry.languageExtractorFingerprint === "string"
    && entry.languageExtractorFingerprint.length > 0,
  );
}

function hasAllInventoryObjects(
  identity: SnapshotIdentity,
  objectIds: ReadonlySet<string>,
): boolean {
  return Object.values(identity.inventory).every((entry) =>
    objectIds.has(entry.fileObjectId),
  );
}

/**
 * Source observation predicts a parser mode before ast-grep runs. A prior
 * immutable snapshot records the actual mode selected for a stable path and
 * content. Keep that proven identity for change planning; otherwise an empty
 * or inventory-only file could be needlessly parsed again in every worktree.
 */
function alignObservedEntriesWithPreviousExtraction(
  current: SourceState,
  previous: SourceState | null,
): SourceState {
  if (previous === null) return current;
  const previousByPath = new Map(previous.entries.map((entry) => [entry.path, entry]));
  return {
    ...current,
    entries: current.entries.map((entry) => {
      const prior = previousByPath.get(entry.path);
      if (prior === undefined || prior.contentId !== entry.contentId) return entry;
      return {
        ...entry,
        language: prior.language,
        parserMode: prior.parserMode,
        languageExtractorFingerprint: prior.languageExtractorFingerprint,
      };
    }),
  };
}

function samePinnedMetadata(
  left: SourceStateEntry["metadata"],
  right: SourceStateEntry["metadata"],
): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode;
}

async function hydrateObservedContentIds(
  current: SourceState,
  previous: SourceState | null,
  canonicalSource: string,
  signal?: AbortSignal,
  reusableIdentity: SnapshotIdentity | null = null,
): Promise<SourceState> {
  if (current.entries.every((entry) => entry.contentId.length > 0)) return current;
  const previousByPath = new Map(
    (previous?.entries ?? []).map((entry) => [entry.path, entry]),
  );
  const reusableContentByPath = new Map(
    Object.entries(reusableIdentity?.inventory ?? {}).map(([filePath, entry]) => [
      filePath,
      entry.sourceContentId,
    ]),
  );
  const entries: SourceStateEntry[] = [];
  for (const entry of current.entries) {
    signal?.throwIfAborted();
    if (entry.contentId.length > 0) {
      entries.push(entry);
      continue;
    }
    const reusableContentId = reusableContentByPath.get(entry.path);
    if (reusableContentId) {
      entries.push({ ...entry, contentId: reusableContentId });
      continue;
    }
    const old = previousByPath.get(entry.path);
    if (
      old
      && samePinnedMetadata(old.metadata, entry.metadata)
      && old.language === entry.language
      && old.parserMode === entry.parserMode
      && old.languageExtractorFingerprint === entry.languageExtractorFingerprint
    ) {
      entries.push({ ...entry, contentId: old.contentId });
      continue;
    }
    const bytes = await readBoundedFileNoFollow(
      path.resolve(canonicalSource, entry.path),
      MAX_SOURCE_FILE_BYTES,
    );
    entries.push({
      ...entry,
      contentId: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { ...current, entries };
}

function reusedEnsureResult(
  identity: SnapshotIdentity,
  canonicalSource: string,
  sourceKey: string,
  reusedFiles: number,
): EnsureLocalCodeIndexResult {
  const indexedBytes = Object.values(identity.inventory)
    .reduce((total, entry) => total + (parseInt(entry.metadata.size, 10) || 0), 0);
  const coverage: LocalCodeIndexCoverageSummary = {
    effective: identity.toolState.coverage,
    partial: false,
    failedFiles: 0,
    oversizedFiles: 0,
  };
  return {
    available: true,
    ref: {
      schemaVersion: 2,
      sourcePath: canonicalSource,
      repositoryKey: identity.repositoryKey,
      worktreeKey: identity.worktreeKey,
      sourceKey,
      snapshotId: deriveSnapshotId(new TextEncoder().encode(canonicalStringify(identity))),
    },
    tool: {
      name: "ast-grep",
      version: identity.toolState.version,
      extractorFingerprint: identity.extractorFingerprint,
      available: identity.toolState.available,
      coverage,
      errors: identity.toolState.errors,
    },
    stats: {
      mode: "reused",
      discoveredFiles: Object.keys(identity.inventory).length,
      reusedFiles,
      hashedFiles: 0,
      parsedFiles: 0,
      deletedFiles: 0,
      oversizedFiles: 0,
      rebuiltSymbolShards: 0,
      rebuiltRelationShards: 0,
      bytesRead: 0,
      bytesWritten: 0,
      coverage,
      parserVersion: identity.toolState.version,
      timings: {
        inventoryMs: 0,
        hashingMs: 0,
        parsingMs: 0,
        astGrepMs: 0,
        fileReadMs: 0,
        fileFactExtractionMs: 0,
        fileObjectPublicationMs: 0,
        relationshipMs: 0,
        shardPublicationMs: 0,
        snapshotPublicationMs: 0,
        lookupMs: 0,
        publicationMs: 0,
      },
      durationMs: 0,
    },
  };
}

/**
 * Compute a fingerprint of the Git source-state payload for comparison.
 */
function computePayloadFingerprint(payload: SourceStatePayload): string {
  const canonical = canonicalStringify({
    sourcePath: payload.sourcePath,
    commonDir: payload.commonDir,
    objectFormat: payload.objectFormat,
    headCommit: payload.headCommit,
    branch: payload.branch,
    materializationConfig: payload.materializationConfig,
    filterConfigs: payload.filterConfigs,
    entries: payload.entries,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Build a materialization fingerprint from Git attributes and config.
 */
function buildMaterializationFingerprint(
  attributes: SourceStatePayload["entries"][number]["attributes"],
  materializationConfig: SourceStatePayload["materializationConfig"],
): string {
  const canonical = canonicalStringify({
    filter: attributes.filter,
    ident: attributes.ident,
    workingTreeEncoding: attributes.workingTreeEncoding,
    text: attributes.text,
    eol: attributes.eol,
    autocrlf: materializationConfig.autocrlf,
    eolConfig: materializationConfig.eol,
    objectFormat: materializationConfig.autocrlf, // placeholder
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Return a reuse key only for a clean, fully tracked Git worktree. It omits
 * the source path and file metadata, which necessarily differ between
 * worktrees, while retaining every input that can affect materialized bytes.
 */
function deriveReusableGitStateKey(
  payload: SourceStatePayload,
  extractorFingerprint: string,
): string | null {
  if (payload.entries.some((entry) => entry.stage === null || entry.porcelain !== null)) {
    return null;
  }
  const stableState = {
    schemaVersion: 1,
    extractorFingerprint,
    commonDir: payload.commonDir,
    objectFormat: payload.objectFormat,
    headCommit: payload.headCommit,
    materializationConfig: payload.materializationConfig,
    filterConfigs: payload.filterConfigs,
    entries: payload.entries.map((entry) => ({
      path: entry.path,
      stage: entry.stage,
      attributes: entry.attributes,
      eolInfo: entry.eolInfo,
    })),
  };
  return createHash("sha256")
    .update(canonicalStringify(stableState), "utf8")
    .digest("hex");
}

async function readReusableIndexBaseline(
  storageRoot: string,
  repositoryKey: string,
  reusableStateKey: string,
  extractorFingerprint: string,
): Promise<ReusableIndexBaseline | null> {
  const cachePath = repositoryReusableSnapshotPath(
    storageRoot,
    repositoryKey,
    reusableStateKey,
  );
  let record: ReusableGitSnapshotRecord;
  try {
    const bytes = await readBoundedFileNoFollow(cachePath, MAX_CURRENT_JSON_BYTES);
    record = JSON.parse(new TextDecoder().decode(bytes)) as ReusableGitSnapshotRecord;
  } catch {
    return null;
  }
  if (
    record.schemaVersion !== 2
    || record.reusableStateKey !== reusableStateKey
    || record.repositoryKey !== repositoryKey
    || record.extractorFingerprint !== extractorFingerprint
    || typeof record.worktreeKey !== "string"
    || typeof record.snapshotId !== "string"
  ) {
    return null;
  }
  try {
    const identity = await readSnapshotIdentity(
      storageRoot,
      record.worktreeKey,
      record.snapshotId,
    );
    const indexMap = await readIndexMap(
      storageRoot,
      record.worktreeKey,
      record.snapshotId,
    );
    if (
      identity === null
      || indexMap === null
      || !hasCompleteExtractionIdentity(identity)
      || identity.repositoryKey !== repositoryKey
      || identity.extractorFingerprint !== extractorFingerprint
      || usesLegacyShardBuckets(indexMap)
    ) {
      return null;
    }
    const existingObjectIds = await buildExistingFileObjectIds(
      storageRoot,
      repositoryKey,
      identity,
    );
    if (!hasAllInventoryObjects(identity, existingObjectIds)) {
      return null;
    }
    return { identity, indexMap, existingObjectIds };
  } catch {
    return null;
  }
}

async function publishReusableGitSnapshot(
  storageRoot: string,
  repositoryKey: string,
  reusableStateKey: string,
  extractorFingerprint: string,
  worktreeKey: string,
  snapshotId: string,
  lockOwner: IndexLockOwner,
): Promise<void> {
  const record: ReusableGitSnapshotRecord = {
    schemaVersion: 2,
    reusableStateKey,
    repositoryKey,
    extractorFingerprint,
    worktreeKey,
    snapshotId,
  };
  try {
    await publishObjects([{
      finalPath: repositoryReusableSnapshotPath(storageRoot, repositoryKey, reusableStateKey),
      canonicalBytes: new TextEncoder().encode(canonicalStringify(record)),
    }], {
      storageRoot,
      repositoryKey,
      ownerToken: lockOwner.ownerToken,
    });
  } catch (error) {
    // The catalog is a first-writer-wins selection, not a content-addressed
    // object: two clean worktrees at the same Git state point to different
    // local snapshot paths. A full rebuild can therefore race an already
    // published selection after its reusable baseline was unavailable. Keep
    // the existing selection only after revalidating its snapshot and every
    // referenced object; otherwise preserve the collision as a hard failure.
    if (
      error instanceof LocalCodeIndexUnavailableError
      && error.reason === "object_identity_collision"
      && await readReusableIndexBaseline(
        storageRoot,
        repositoryKey,
        reusableStateKey,
        extractorFingerprint,
      ) !== null
    ) return;
    throw error;
  }
}

// ── Existing objects map ───────────────────────────────────────────────────

/**
 * Build the set of verified file object IDs from the previous snapshot's inventory.
 *
 * Used by the change planner to identify reusable file objects. This checks
 * only a safe, no-follow filesystem identity because every file object was
 * byte-verified at its immutable publication boundary. Re-reading thousands
 * of object bodies here would make a clean linked worktree needlessly slow.
 */
async function buildExistingFileObjectIds(
  storageRoot: string,
  repositoryKey: string,
  identity: SnapshotIdentity,
): Promise<Set<string>> {
  const objectIds = new Set<string>();
  for (const [, invEntry] of Object.entries(identity.inventory)) {
    const objectPath = fileObjectPath(
      storageRoot,
      repositoryKey,
      invEntry.fileObjectId,
    );
    try {
      const objectStat = await lstat(objectPath);
      if (objectStat.isFile() && !objectStat.isSymbolicLink()) {
        objectIds.add(invEntry.fileObjectId);
      }
    } catch {
      // Object doesn't exist or is unreadable — skip.
    }
  }
  return objectIds;
}

// ── Get previous shard IDs from current pointer ────────────────────────────

/**
 * Read the previous snapshot's shard ID maps for incremental rebuild.
 */
async function readPreviousShardIds(
  currentPtr: CurrentPointer | null,
  storageRoot: string,
  worktreeKey: string,
): Promise<{
  symbolShardIds: ReadonlyMap<string, string>;
  relationShardIds: ReadonlyMap<string, string>;
}> {
  if (currentPtr === null) {
    return emptyPreviousShardIds();
  }

  const identity = await readSnapshotIdentity(
    storageRoot,
    worktreeKey,
    currentPtr.snapshotId,
  );

  if (identity === null) {
    return emptyPreviousShardIds();
  }

  const indexMap = await readIndexMap(
    storageRoot,
    worktreeKey,
    currentPtr.snapshotId,
  );
  if (indexMap === null) {
    return emptyPreviousShardIds();
  }

  return previousShardIdsFromIndexMap(indexMap);
}

function emptyPreviousShardIds(): {
  symbolShardIds: ReadonlyMap<string, string>;
  relationShardIds: ReadonlyMap<string, string>;
} {
  return {
    symbolShardIds: new Map(),
    relationShardIds: new Map(),
  };
}

function previousShardIdsFromIndexMap(indexMap: IndexMap): {
  symbolShardIds: ReadonlyMap<string, string>;
  relationShardIds: ReadonlyMap<string, string>;
} {

  const symMap = new Map<string, string>();
  for (const [key, shardId] of Object.entries(indexMap.symbolShards)) {
    if (/^sym-[0-9a-f]{2}$/u.test(key)) symMap.set(key.slice(4), shardId);
  }

  const relMap = new Map<string, string>();
  for (const [key, shardId] of Object.entries(indexMap.relationShards)) {
    if (/^rel-[0-9a-f]{2}$/u.test(key)) relMap.set(key.slice(4), shardId);
  }

  return { symbolShardIds: symMap, relationShardIds: relMap };
}

// ── Extraction and object publication ──────────────────────────────────────

type ExtractionPhaseResult = Readonly<{
  fileObjectIds: Map<string, string>;
  extractionResults: Map<string, FileExtractionResult>;
  coverage: LocalCodeIndexCoverageSummary;
  extractorFingerprint: string;
  parserVersion: string | null;
  oversizedFiles: number;
  bytesRead: number;
  timings: EnsureLocalCodeIndexResult["stats"]["timings"];
}>;

function normalizedAstGrepPath(canonicalSource: string, filePath: string): string | null {
  const relativePath = path.isAbsolute(filePath)
    ? path.relative(canonicalSource, filePath)
    : filePath;
  const normalizedPath = relativePath.split(path.sep).join("/");
  if (
    normalizedPath.length === 0
    || normalizedPath === ".."
    || normalizedPath.startsWith("../")
  ) {
    return null;
  }
  return normalizedPath;
}

function collectDeclarationPositions(
  symbols: readonly AstGrepSymbol[],
  target: Set<string>,
): void {
  for (const symbol of symbols) {
    if (symbol.role === "definition" && symbol.signature !== null) {
      const nameOffset = symbol.signature.indexOf(symbol.name);
      if (nameOffset >= 0) {
        target.add(
          `${symbol.name}\0${symbol.range.startLine}\0${symbol.range.startColumn + nameOffset}`,
        );
      }
    }
    collectDeclarationPositions(symbol.members, target);
  }
}

function isInsideSymbolRange(
  candidate: AstGrepSymbol,
  container: AstGrepSymbol,
): boolean {
  const startsAfter = candidate.range.startLine > container.range.startLine
    || (
      candidate.range.startLine === container.range.startLine
      && candidate.range.startColumn >= container.range.startColumn
    );
  const endsBefore = candidate.range.endLine < container.range.endLine
    || (
      candidate.range.endLine === container.range.endLine
      && candidate.range.endColumn <= container.range.endColumn
    );
  return startsAfter && endsBefore;
}

/**
 * Extract file facts and publish immutable objects.
 *
 * Steps 2–4 of the publication protocol.
 */
async function extractAndPublishObjects(
  storageRoot: string,
  repositoryKey: string,
  canonicalSource: string,
  sourceState: SourceState,
  changePlan: ChangePlan,
  lockOwner: IndexLockOwner,
  adapter: AstGrepAdapter,
  parserVersion: string | null,
  expectedExtractorFingerprint: string,
  signal: AbortSignal | undefined,
): Promise<ExtractionPhaseResult> {
  const computeEntries = getComputeEntries(changePlan);
  const publishOptions: PublishObjectsOptions = {
    storageRoot,
    repositoryKey,
    ownerToken: lockOwner.ownerToken,
  };

  const fileObjectIds = new Map<string, string>();
  const extractionResults = new Map<string, FileExtractionResult>();
  const sourceEntriesByPath = new Map(
    sourceState.entries.map((entry) => [entry.path, entry]),
  );
  const coverageOutcomes: FileCoverageOutcome[] = [];
  let bytesRead = 0;
  let oversizedFiles = 0;
  const extractorFingerprint = expectedExtractorFingerprint;
  const structuralOutlines = new Map<string, AstGrepFileResult>();
  const outlineAvailablePaths = new Set<string>();
  let astGrepMs = 0;
  let fileReadMs = 0;
  let fileFactExtractionMs = 0;
  let fileObjectPublicationMs = 0;

  const hashingStart = Date.now();

  // ── Process reuse entries (from previous snapshot) ───────────────────
  for (const entry of changePlan.entries) {
    if (entry.decision === "reuse" || entry.decision === "retarget") {
      const stateEntry = sourceEntriesByPath.get(entry.path);
      if (stateEntry && entry.existingFileObjectId) {
        fileObjectIds.set(entry.path, entry.existingFileObjectId);
        const coverage = stateEntry.parserMode === "structural"
          ? "ast-grep-structural"
          : stateEntry.parserMode === "lexical-fallback"
            ? "lexical-reference-fallback"
            : "file-inventory-only";
        coverageOutcomes.push(coverage);
      }
    }
  }

  const hashingMs = Date.now() - hashingStart;

  // ── Process compute entries (need extraction) ────────────────────────
  if (computeEntries.length > 0) {
    if (parserVersion !== null) {
      // Outlines are compact: parse the approved paths in large batches to
      // avoid paying ast-grep process startup once per tiny batch. References
      // remain smaller because their JSON can be orders of magnitude larger.
      for (
        let offset = 0;
        offset < computeEntries.length;
        offset += AST_GREP_OUTLINE_BATCH_SIZE
      ) {
        signal?.throwIfAborted();
        const batch = computeEntries.slice(
          offset,
          offset + AST_GREP_OUTLINE_BATCH_SIZE,
        );
        const astGrepStart = Date.now();
        try {
          const outlines = await adapter.extractFiles(
            batch.map((entry) => entry.path),
            { signal },
          );
          astGrepMs += Date.now() - astGrepStart;
          for (const entry of batch) outlineAvailablePaths.add(entry.path);
          for (const file of outlines.files) {
            const normalizedPath = normalizedAstGrepPath(canonicalSource, file.path);
            if (normalizedPath === null) continue;
            structuralOutlines.set(normalizedPath, { ...file, path: normalizedPath });
          }
        } catch (error: unknown) {
          astGrepMs += Date.now() - astGrepStart;
          if (
            error instanceof LocalCodeIndexUnavailableError
            && error.reason === "operation_aborted"
          ) {
            throw error;
          }
          // A failed outline batch falls back file-by-file below. Other batches
          // still retain structural coverage.
        }
      }
    }

    for (
      let offset = 0;
      offset < computeEntries.length;
      offset += AST_GREP_REFERENCE_BATCH_SIZE
    ) {
      signal?.throwIfAborted();
      const batch = computeEntries.slice(
        offset,
        offset + AST_GREP_REFERENCE_BATCH_SIZE,
      );
      const batchFiles = new Map<string, AstGrepFileResult>();
      const batchFileObjectEntries: Array<readonly [string, FileObject]> = [];
      let hasStructuralFacts = parserVersion !== null
        && batch.every((entry) => outlineAvailablePaths.has(entry.path));

      if (hasStructuralFacts) {
        const astGrepStart = Date.now();
        try {
          const references = await adapter.extractReferences(
            batch.map((entry) => entry.path),
            { signal },
          );
          astGrepMs += Date.now() - astGrepStart;
          const declarationPositions = new Map<string, Set<string>>();
          const importRanges = new Map<string, AstGrepSymbol[]>();

          for (const entry of batch) {
            const outline = structuralOutlines.get(entry.path);
            const file: AstGrepFileResult = outline === undefined
              ? {
                path: entry.path,
                language: sourceEntriesByPath.get(entry.path)?.language ?? "unknown",
                symbols: [],
              }
              : { ...outline, symbols: [...outline.symbols] };
            batchFiles.set(entry.path, file);
            const positions = new Set<string>();
            collectDeclarationPositions(file.symbols, positions);
            declarationPositions.set(entry.path, positions);
            importRanges.set(
              entry.path,
              file.symbols.filter((symbol) => symbol.isImport),
            );
          }

          for (const file of references.files) {
            const normalizedPath = normalizedAstGrepPath(canonicalSource, file.path);
            if (normalizedPath === null) continue;
            const current = batchFiles.get(normalizedPath);
            if (current === undefined) continue;
            const declarationKeys = declarationPositions.get(normalizedPath)
              ?? new Set<string>();
            const referenceSymbols = file.symbols.filter((symbol) =>
              !declarationKeys.has(
                `${symbol.name}\0${symbol.range.startLine}\0${symbol.range.startColumn}`,
              )
              && !(importRanges.get(normalizedPath) ?? []).some(
                (importSymbol) => isInsideSymbolRange(symbol, importSymbol),
              )
            );
            batchFiles.set(normalizedPath, {
              ...current,
              symbols: [...current.symbols, ...referenceSymbols],
            });
          }
        } catch (error: unknown) {
          astGrepMs += Date.now() - astGrepStart;
          if (
            error instanceof LocalCodeIndexUnavailableError
            && error.reason === "operation_aborted"
          ) {
            throw error;
          }
          // Do not claim structural coverage if references could not be read.
          hasStructuralFacts = false;
          batchFiles.clear();
        }
      }

      for (const entry of batch) {
        signal?.throwIfAborted();

        const stateEntry = sourceEntriesByPath.get(entry.path);
        if (!stateEntry) continue;

        // Read source bytes.
        const filePath = path.resolve(canonicalSource, entry.path);
        let sourceBytes: Uint8Array;
        const fileReadStart = Date.now();
        try {
          sourceBytes = await readBoundedFileNoFollow(filePath, MAX_SOURCE_FILE_BYTES);
        } catch {
          fileReadMs += Date.now() - fileReadStart;
          coverageOutcomes.push("failed");
          continue;
        }
        fileReadMs += Date.now() - fileReadStart;
        bytesRead += sourceBytes.byteLength;

        const structuralFile = hasStructuralFacts
          ? batchFiles.get(entry.path)
          : undefined;
        const fileFactExtractionStart = Date.now();
        const result = extractFileFacts(
          sourceBytes,
          entry.path,
          parserVersion,
          structuralFile !== undefined && parserVersion !== null
            ? outlineFileToParseResult(structuralFile, parserVersion)
            : null,
        );
        fileFactExtractionMs += Date.now() - fileFactExtractionStart;

        extractionResults.set(entry.path, result);
        coverageOutcomes.push(result.coverage);

        if (result.truncation.some((t) => t.limitKind === "max-file-size")) {
          oversizedFiles += 1;
        }

        const fileObject = fileObjectFromExtractionResult(result, parserVersion);
        batchFileObjectEntries.push([entry.path, fileObject]);
      }

      // Keep only one parser batch of serialized bytes live at a time. The
      // object store performs up to eight durable file-object publications
      // concurrently,
      // eliminating per-file fsync serialization without accumulating a
      // repository-sized second copy in memory.
      if (batchFileObjectEntries.length > 0) {
        const publicationStart = Date.now();
        const publications = await publishFileObjects(
          batchFileObjectEntries.map(([, fileObject]) => fileObject),
          publishOptions,
        );
        fileObjectPublicationMs += Date.now() - publicationStart;
        for (const [index, [filePath]] of batchFileObjectEntries.entries()) {
          fileObjectIds.set(filePath, publications[index]!.objectId);
        }
      }
    }
  }

  const coverage = aggregateCoverage(coverageOutcomes);

  return {
    fileObjectIds,
    extractionResults,
    coverage,
    extractorFingerprint,
    parserVersion,
    oversizedFiles,
    bytesRead,
    timings: {
      inventoryMs: 0,
      hashingMs,
      parsingMs: astGrepMs,
      astGrepMs,
      fileReadMs,
      fileFactExtractionMs,
      fileObjectPublicationMs,
      relationshipMs: 0,
      shardPublicationMs: 0,
      snapshotPublicationMs: 0,
      lookupMs: 0,
      publicationMs: fileObjectPublicationMs,
    },
  };
}

// ── Relationships and shards ───────────────────────────────────────────────

function fileObjectCoverage(fileObject: FileObject): FileExtractionResult["coverage"] {
  return fileObject.parserMode === "structural"
    ? "ast-grep-structural"
    : fileObject.parserMode === "lexical-fallback"
      ? "lexical-reference-fallback"
      : "file-inventory-only";
}

function fileObjectToExtractionResult(fileObject: FileObject): FileExtractionResult {
  return {
    sourceContentId: fileObject.sourceContentId,
    byteSize: fileObject.byteSize,
    language: fileObject.language as SupportedLanguage,
    parserMode: fileObject.parserMode as FileExtractionResult["parserMode"],
    extractorFingerprint: fileObject.languageExtractorFingerprint,
    coverage: fileObjectCoverage(fileObject),
    definitions: fileObject.definitions.map((definition) => ({
      ...definition,
      signature: definition.signature ?? null,
    })),
    references: fileObject.references as FileExtractionResult["references"],
    imports: fileObject.imports as FileExtractionResult["imports"],
    errors: fileObject.errors.map((message) => ({
      message,
      range: null,
      severity: "warning" as const,
    })),
    truncation: [],
  };
}

/**
 * Convert retained extraction facts into the immutable object payload only at
 * the point where it is needed for publication or comparison. Keeping this
 * derivation lazy prevents a second repository-sized reference graph from
 * remaining live during cold indexing.
 */
function fileObjectFromExtractionResult(
  result: FileExtractionResult,
  parserVersion: string | null,
): FileObject {
  return {
    sourceContentId: result.sourceContentId,
    languageExtractorFingerprint: result.extractorFingerprint,
    byteSize: result.byteSize,
    language: result.language,
    parserMode: result.parserMode,
    definitions: result.definitions.map((definition) => ({
      name: definition.name,
      kind: definition.kind,
      range: definition.range,
      exported: definition.exported,
      ...(definition.signature != null ? { signature: definition.signature } : {}),
    })),
    references: result.references.map((reference) => ({
      name: reference.name,
      range: reference.range,
      referenceKind: reference.referenceKind,
    })),
    imports: result.imports.map((entry) => ({
      requested: entry.requested,
      range: entry.range,
      importKind: entry.importKind,
    })),
    errors: result.errors.map((error) => error.message),
    truncated: result.truncation.length > 0,
    extractorVersion: parserVersion,
    ruleSetFingerprint: createHash("sha256")
      .update(result.extractorFingerprint)
      .digest("hex"),
  };
}

function semanticFileObject(fileObject: FileObject): unknown {
  return {
    languageExtractorFingerprint: fileObject.languageExtractorFingerprint,
    language: fileObject.language,
    parserMode: fileObject.parserMode,
    definitions: fileObject.definitions,
    references: fileObject.references,
    imports: fileObject.imports,
    errors: fileObject.errors,
    truncated: fileObject.truncated,
    extractorVersion: fileObject.extractorVersion,
    ruleSetFingerprint: fileObject.ruleSetFingerprint,
  };
}

type ShardPhaseResult = Readonly<{
  symbolShardIds: readonly string[];
  relationShardIds: readonly string[];
  symbolShardIdsByBucket: ReadonlyMap<string, string>;
  relationShardIdsByBucket: ReadonlyMap<string, string>;
  rebuiltSymbolShards: number;
  rebuiltRelationShards: number;
  bytesWritten: number;
  relationshipMs: number;
  shardPublicationMs: number;
}>;

/**
 * Build relationships, construct shards, and publish shard objects.
 */
async function buildAndPublishShards(
  storageRoot: string,
  repositoryKey: string,
  sourceState: SourceState,
  extractionResult: ExtractionPhaseResult,
  changePlan: ChangePlan,
  previousIdentity: SnapshotIdentity | null,
  prevShardIds: {
    symbolShardIds: ReadonlyMap<string, string>;
    relationShardIds: ReadonlyMap<string, string>;
  },
  lockOwner: IndexLockOwner,
  signal: AbortSignal | undefined,
): Promise<ShardPhaseResult> {
  const phaseStart = Date.now();
  const publishOptions: PublishObjectsOptions = {
    storageRoot,
    repositoryKey,
    ownerToken: lockOwner.ownerToken,
  };

  // A clean, content-identical Git worktree has the same path-bound symbol
  // and relationship shards. Rebinding its snapshot must not reopen every
  // file object just to reconstruct those immutable shards.
  if (previousIdentity !== null && isChangePlanEmpty(changePlan)) {
    return {
      symbolShardIds: [...prevShardIds.symbolShardIds.values()].sort(),
      relationShardIds: [...prevShardIds.relationShardIds.values()].sort(),
      symbolShardIdsByBucket: new Map(prevShardIds.symbolShardIds),
      relationShardIdsByBucket: new Map(prevShardIds.relationShardIds),
      rebuiltSymbolShards: 0,
      rebuiltRelationShards: 0,
      bytesWritten: 0,
      relationshipMs: 0,
      shardPublicationMs: 0,
    };
  }

  const relationshipStart = Date.now();
  const computePaths = changePlan.entries
    .filter((entry) => entry.decision === "compute")
    .map((entry) => entry.path);
  const canUseFactStableFastPath = previousIdentity !== null
    && computePaths.length > 0
    && changePlan.entries.every((entry) =>
      entry.decision === "reuse" || entry.decision === "compute"
    );

  if (canUseFactStableFastPath) {
    let factsStable = true;
    for (const filePath of computePaths) {
      const previousEntry = previousIdentity.inventory[filePath];
      const currentFacts = extractionResult.extractionResults.get(filePath);
      if (!previousEntry || !currentFacts) {
        factsStable = false;
        break;
      }
      const currentObject = fileObjectFromExtractionResult(
        currentFacts,
        extractionResult.parserVersion,
      );
      const previousObject = await readFileObject(
        fileObjectPath(storageRoot, repositoryKey, previousEntry.fileObjectId),
      );
      if (
        previousObject === null
        || canonicalStringify(semanticFileObject(previousObject))
          !== canonicalStringify(semanticFileObject(currentObject))
      ) {
        factsStable = false;
        break;
      }
    }

    if (factsStable) {
      const relationIds = new Map(prevShardIds.relationShardIds);
      const pathsByBucket = new Map<string, string[]>();
      for (const filePath of computePaths) {
        const bucket = pathBucketKey(filePath);
        const paths = pathsByBucket.get(bucket) ?? [];
        paths.push(filePath);
        pathsByBucket.set(bucket, paths);
      }
      let bytesWritten = 0;
      for (const [bucket, changedPaths] of pathsByBucket) {
        const previousId = relationIds.get(bucket);
        if (!previousId) {
          factsStable = false;
          break;
        }
        const bytes = await readBoundedFileNoFollow(
          relationShardPath(storageRoot, repositoryKey, previousId),
          64 * 1024 * 1024,
        );
        const previousShard = JSON.parse(
          new TextDecoder().decode(bytes),
        ) as RelationShard;
        const changed = new Set(changedPaths);
        const summaries = previousShard.fileSummaries.filter(
          (summary) => !changed.has(summary.path),
        );
        for (const filePath of changedPaths) {
          const result = extractionResult.extractionResults.get(filePath)!;
          summaries.push({
            path: filePath,
            language: result.language,
            size: result.byteSize,
            contentId: result.sourceContentId,
            coverage: result.coverage,
          });
        }
        const shard = buildRelationShard(
          bucket,
          summaries,
          previousShard.relationships,
        );
        const objectId = deriveShardObjectId(shard);
        const publication = await publishObjects(
          [{
            finalPath: relationShardPath(storageRoot, repositoryKey, objectId),
            canonicalBytes: new TextEncoder().encode(canonicalStringify(shard)),
          }],
          publishOptions,
        );
        bytesWritten += publication.bytesWritten;
        relationIds.set(bucket, objectId);
      }
      if (factsStable) {
        return {
          symbolShardIds: [...prevShardIds.symbolShardIds.values()].sort(),
          relationShardIds: [...relationIds.values()].sort(),
          symbolShardIdsByBucket: new Map(prevShardIds.symbolShardIds),
          relationShardIdsByBucket: relationIds,
          rebuiltSymbolShards: 0,
          rebuiltRelationShards: pathsByBucket.size,
          bytesWritten,
          relationshipMs: 0,
          shardPublicationMs: Date.now() - phaseStart,
        };
      }
    }
  }

  // The general path needs complete current facts. Load only here; the
  // fact-stable edit path above avoids opening every reused file object.
  const reusedEntries = sourceState.entries.filter(
    (entry) => !extractionResult.extractionResults.has(entry.path),
  );
  let nextReusedEntry = 0;
  const reusedReaderCount = Math.min(64, reusedEntries.length);
  await Promise.all(Array.from({ length: reusedReaderCount }, async () => {
    while (true) {
      const index = nextReusedEntry++;
      if (index >= reusedEntries.length) return;
      const entry = reusedEntries[index]!;
      const objectId = extractionResult.fileObjectIds.get(entry.path);
      if (!objectId) throw new LocalCodeIndexUnavailableError("corrupt_index");
      const fileObject = await readFileObject(
        fileObjectPath(storageRoot, repositoryKey, objectId),
      );
      if (fileObject === null) {
        throw new LocalCodeIndexUnavailableError("corrupt_index");
      }
      extractionResult.extractionResults.set(
        entry.path,
        fileObjectToExtractionResult(fileObject),
      );
    }
  }));

  // ── Build input maps for buildAllRelationships ───────────────────────
  const fileImports = new Map<string, readonly ExtractedImport[]>();
  const fileReferences = new Map<string, readonly ExtractedReference[]>();
  const fileDefinitions = new Map<string, readonly ExtractedDefinition[]>();

  for (const entry of sourceState.entries) {
    const filePath = entry.path;
    const result = extractionResult.extractionResults.get(filePath);
    if (!result) continue;
    fileImports.set(filePath, result.imports);
    fileReferences.set(filePath, result.references);
    fileDefinitions.set(filePath, result.definitions);
  }

  // Build path inventory for import resolution.
  const pathInventory = new Map<string, PathInventoryEntry>();
  for (const entry of sourceState.entries) {
    const extResult = extractionResult.extractionResults.get(entry.path);
    pathInventory.set(entry.path, {
      path: entry.path,
      language: entry.language,
      exportedSymbols: extResult?.definitions
        .filter((d) => d.exported)
        .map((d) => d.name) ?? [],
    });
  }

  // ── Build relationships ──────────────────────────────────────────────
  const relResult: BuildRelationshipsResult = buildAllRelationships({
    fileImports,
    fileReferences,
    fileDefinitions,
    resolutionConfig: buildDefaultResolutionConfig(),
    pathInventory,
  });

  // ── Build shard entries ──────────────────────────────────────────────
  const currentSymbolEntries: ShardSymbolEntry[] = [];
  for (const entry of sourceState.entries) {
    const filePath = entry.path;
    const result = extractionResult.extractionResults.get(filePath);
    if (!result) continue;
    for (const def of result.definitions) {
      currentSymbolEntries.push({
        symbol: def.name,
        kind: def.kind,
        role: "definition",
        path: filePath,
        range: def.range,
        exported: def.exported,
        coverage: result.coverage,
      });
    }
    for (const ref of result.references) {
      currentSymbolEntries.push({
        symbol: ref.name,
        kind: ref.referenceKind,
        role: "reference",
        path: filePath,
        range: ref.range,
        exported: false,
        coverage: result.coverage,
      });
    }
  }

  const currentFileSummaries: ShardFileSummaryEntry[] = [];
  for (const entry of sourceState.entries) {
    const extResult = extractionResult.extractionResults.get(entry.path);
    if (extResult) {
      currentFileSummaries.push({
        path: entry.path,
        language: entry.language,
        size: extResult.byteSize,
        contentId: extResult.sourceContentId,
        coverage: extResult.coverage,
      });
    }
  }

  const currentRelationships: ShardRelationshipEntry[] = [];
  for (const [fromPath, shard] of relResult.shards) {
    for (const rel of shard.relationships) {
      currentRelationships.push({
        fromPath,
        toPath: rel.toPath,
        type: rel.type,
        symbol: rel.symbol,
        weight: rel.weight,
      });
    }
  }

  const previousSymbolEntries: ShardSymbolEntry[] = [];
  const previousFileSummaries: ShardFileSummaryEntry[] = [];
  const previousImports = new Map<string, readonly ExtractedImport[]>();
  const previousReferences = new Map<string, readonly ExtractedReference[]>();
  const previousDefinitions = new Map<string, readonly ExtractedDefinition[]>();
  const previousPathInventory = new Map<string, PathInventoryEntry>();
  const decisions = new Map(changePlan.entries.map((entry) => [entry.path, entry.decision]));

  if (previousIdentity !== null) {
    for (const [filePath, inventoryEntry] of Object.entries(previousIdentity.inventory)) {
      let facts = decisions.get(filePath) === "reuse"
        ? extractionResult.extractionResults.get(filePath)
        : undefined;
      if (!facts) {
        const object = await readFileObject(
          fileObjectPath(storageRoot, repositoryKey, inventoryEntry.fileObjectId),
        );
        if (object === null) throw new LocalCodeIndexUnavailableError("corrupt_index");
        const coverage = object.parserMode === "structural"
          ? "ast-grep-structural"
          : object.parserMode === "lexical-fallback"
            ? "lexical-reference-fallback"
            : "file-inventory-only";
        facts = {
          sourceContentId: object.sourceContentId,
          byteSize: object.byteSize,
          language: object.language as SupportedLanguage,
          parserMode: object.parserMode as FileExtractionResult["parserMode"],
          extractorFingerprint: object.languageExtractorFingerprint,
          coverage,
          definitions: object.definitions.map((definition) => ({
            ...definition,
            signature: definition.signature ?? null,
          })),
          references: object.references as FileExtractionResult["references"],
          imports: object.imports as FileExtractionResult["imports"],
          errors: [],
          truncation: [],
        };
      }
      previousImports.set(filePath, facts.imports);
      previousReferences.set(filePath, facts.references);
      previousDefinitions.set(filePath, facts.definitions);
      previousPathInventory.set(filePath, {
        path: filePath,
        language: facts.language,
        exportedSymbols: facts.definitions
          .filter((definition) => definition.exported)
          .map((definition) => definition.name),
      });
      previousFileSummaries.push({
        path: filePath,
        language: facts.language,
        size: facts.byteSize,
        contentId: facts.sourceContentId,
        coverage: facts.coverage,
      });
      for (const definition of facts.definitions) {
        previousSymbolEntries.push({
          symbol: definition.name,
          kind: definition.kind,
          role: "definition",
          path: filePath,
          range: definition.range,
          exported: definition.exported,
          coverage: facts.coverage,
        });
      }
      for (const reference of facts.references) {
        previousSymbolEntries.push({
          symbol: reference.name,
          kind: reference.referenceKind,
          role: "reference",
          path: filePath,
          range: reference.range,
          exported: false,
          coverage: facts.coverage,
        });
      }
    }
  }

  const previousRelationships: ShardRelationshipEntry[] = [];
  if (previousIdentity !== null) {
    const previousRelationshipResult = buildAllRelationships({
      fileImports: previousImports,
      fileReferences: previousReferences,
      fileDefinitions: previousDefinitions,
      resolutionConfig: buildDefaultResolutionConfig(),
      pathInventory: previousPathInventory,
    });
    for (const [fromPath, shard] of previousRelationshipResult.shards) {
      for (const relationship of shard.relationships) {
        previousRelationships.push({
          fromPath,
          toPath: relationship.toPath,
          type: relationship.type,
          symbol: relationship.symbol,
          weight: relationship.weight,
        });
      }
    }
  }

  // ── Rebuild shards ───────────────────────────────────────────────────
  const shardInput: ShardRebuildInput = {
    previousSymbolEntries,
    currentSymbolEntries,
    previousFileSummaries,
    currentFileSummaries,
    previousRelationships,
    currentRelationships,
    previousSymbolShardIds: prevShardIds.symbolShardIds,
    previousRelationShardIds: prevShardIds.relationShardIds,
  };

  const shardRebuildResult: ShardRebuildResult = await rebuildShards(shardInput);

  const relationshipMs = Date.now() - relationshipStart;

  // ── Publish rebuilt shards ────────────────────────────────────────────
  const shardPublicationStart = Date.now();
  let bytesWritten = 0;

  const publicationBatchSize = 128;
  const rebuiltSymbolShards = shardRebuildResult.symbolShards.filter(
    (shard) => shard.status === "rebuilt",
  );
  for (let offset = 0; offset < rebuiltSymbolShards.length; offset += publicationBatchSize) {
    const batch = rebuiltSymbolShards.slice(offset, offset + publicationBatchSize);
    const result = await publishObjects(
      batch.map((symShard) => ({
        finalPath: symbolShardPath(
          storageRoot,
          repositoryKey,
          symShard.objectId,
        ),
        canonicalBytes: new TextEncoder().encode(canonicalStringify(symShard.shard)),
      })),
      publishOptions,
    );
    bytesWritten += result.bytesWritten;
  }

  const rebuiltRelationShards = shardRebuildResult.relationShards.filter(
    (shard) => shard.status === "rebuilt",
  );
  for (let offset = 0; offset < rebuiltRelationShards.length; offset += publicationBatchSize) {
    const batch = rebuiltRelationShards.slice(offset, offset + publicationBatchSize);
    const result = await publishObjects(
      batch.map((relShard) => ({
        finalPath: relationShardPath(
          storageRoot,
          repositoryKey,
          relShard.objectId,
        ),
        canonicalBytes: new TextEncoder().encode(canonicalStringify(relShard.shard)),
      })),
      publishOptions,
    );
    bytesWritten += result.bytesWritten;
  }

  // Build sorted shard ID arrays for the snapshot identity.
  const symbolShardIds = [...shardRebuildResult.symbolShardIds.values()].sort();
  const relationShardIds = [...shardRebuildResult.relationShardIds.values()].sort();

  return {
    symbolShardIds,
    relationShardIds,
    symbolShardIdsByBucket: shardRebuildResult.symbolShardIds,
    relationShardIdsByBucket: shardRebuildResult.relationShardIds,
    rebuiltSymbolShards: shardRebuildResult.rebuiltSymbolShardCount,
    rebuiltRelationShards: shardRebuildResult.rebuiltRelationShardCount,
    bytesWritten,
    relationshipMs,
    shardPublicationMs: Date.now() - shardPublicationStart,
  };
}

/**
 * Build a default resolution config for relationship building.
 */
function buildDefaultResolutionConfig(): ResolutionConfig {
  return {
    language: "typescript",
    version: 1,
    moduleResolution: "node",
    baseUrl: null,
    pathAliases: {},
    extensions: [".ts", ".tsx", ".js", ".jsx"],
    indexFiles: ["index.ts", "index.tsx", "index.js", "index.jsx"],
    packageFields: ["main", "module", "exports"],
  };
}

// ── Snapshot publication ───────────────────────────────────────────────────

type SnapshotPublicationResult = Readonly<{
  snapshotId: string;
  snapshotPath: string;
  identityBytes: Uint8Array;
  indexMapBytes: Uint8Array;
  bytesWritten: number;
}>;

/**
 * Publish snapshot with full verification.
 *
 * Steps 5–9 of the publication protocol.
 */
async function publishSnapshotWithVerification(
  storageRoot: string,
  worktreeKey: string,
  repositoryKey: string,
  sourceKey: string,
  canonicalSource: string,
  sourceState: SourceState,
  extractionResult: ExtractionPhaseResult,
  shardResult: ShardPhaseResult,
  lockOwner: IndexLockOwner,
): Promise<SnapshotPublicationResult> {
  // Build tool state.
  const toolState: SnapshotToolState = {
    name: "ast-grep",
    version: extractionResult.parserVersion,
    extractorFingerprint: extractionResult.extractorFingerprint,
    available: extractionResult.parserVersion !== null,
    coverage: extractionResult.coverage.effective,
    errors: [],
  };

  // Build git identity.
  let gitIdentity: GitIdentity | null = null;
  if (sourceState.repository.commonGitDir) {
    gitIdentity = {
      commonDir: sourceState.repository.commonGitDir,
      head: sourceState.repository.head ?? "",
      branch: sourceState.repository.branch,
      objectFormat: sourceState.repository.objectFormat ?? "sha1",
    };
  }

  // Build inventory entries.
  const inventory: Record<string, SnapshotInventoryEntry> = {};
  for (const entry of sourceState.entries) {
    const foId = extractionResult.fileObjectIds.get(entry.path);
    if (foId) {
      const extracted = extractionResult.extractionResults.get(entry.path);
      inventory[entry.path] = {
        sourceContentId: extracted?.sourceContentId ?? entry.contentId,
        fileObjectId: foId,
        language: extracted?.language ?? entry.language,
        parserMode: extracted?.parserMode ?? entry.parserMode,
        languageExtractorFingerprint: extracted?.extractorFingerprint
          ?? entry.languageExtractorFingerprint,
        metadata: {
          device: entry.metadata.device,
          inode: entry.metadata.inode,
          size: entry.metadata.size,
          mtimeNs: entry.metadata.mtimeNs,
          ctimeNs: entry.metadata.ctimeNs,
          mode: entry.metadata.mode,
        },
      };
    }
  }

  // Build index-map.
  const symbolShardsMap: Record<string, string> = {};
  for (const [bucket, id] of shardResult.symbolShardIdsByBucket) {
    symbolShardsMap[`sym-${bucket}`] = id;
  }
  const relationShardsMap: Record<string, string> = {};
  for (const [bucket, id] of shardResult.relationShardIdsByBucket) {
    relationShardsMap[`rel-${bucket}`] = id;
  }

  const indexMap: IndexMap = {
    schemaVersion: 2,
    snapshotId: "", // Will be filled by publishSnapshot.
    symbolShards: symbolShardsMap,
    relationShards: relationShardsMap,
    fileSummaryShards: {},
  };

  // Publish snapshot (steps 5–9).
  const result = await publishSnapshot({
    storageRoot,
    worktreeKey,
    ownerToken: lockOwner.ownerToken,
    identityInput: {
      schemaVersion: 2,
      repositoryKey,
      worktreeKey,
      sourceKey,
      sourcePath: canonicalSource,
      git: gitIdentity,
      worktreeStateFingerprint: sourceState.worktreeStateFingerprint,
      inventory,
      extractorFingerprint: extractionResult.extractorFingerprint,
      symbolShardIds: shardResult.symbolShardIds,
      relationShardIds: shardResult.relationShardIds,
      toolState,
    },
    indexMap,
  });

  // Read back the published files for verification.
  const identityBytes = await readBoundedFileNoFollow(
    snapshotIdentityPath(storageRoot, worktreeKey, result.snapshotId),
    MAX_SNAPSHOT_READ_BYTES,
  );
  const indexMapBytes = await readBoundedFileNoFollow(
    path.join(snapshotDir(storageRoot, worktreeKey, result.snapshotId), "index-map.json"),
    MAX_SNAPSHOT_READ_BYTES,
  );

  return {
    snapshotId: result.snapshotId,
    snapshotPath: result.snapshotPath,
    identityBytes,
    indexMapBytes,
    bytesWritten: result.status === "created"
      ? identityBytes.byteLength + indexMapBytes.byteLength
      : 0,
  };
}

// ── Snapshot verification ──────────────────────────────────────────────────

/**
 * Step 10: Verify published snapshot files match expected bytes.
 */
async function verifyPublishedSnapshot(
  storageRoot: string,
  worktreeKey: string,
  snapshotId: string,
  expectedIdentityBytes: Uint8Array,
  expectedIndexMapBytes: Uint8Array,
): Promise<void> {
  const identityMatch = await verifySnapshotIdentity(
    storageRoot,
    worktreeKey,
    snapshotId,
    expectedIdentityBytes,
  );
  if (identityMatch !== true) {
    throw new LocalCodeIndexUnavailableError("index_publication_failed", { snapshotId });
  }

  const indexMatch = await verifyIndexMap(
    storageRoot,
    worktreeKey,
    snapshotId,
    expectedIndexMapBytes,
  );
  if (indexMatch !== true) {
    throw new LocalCodeIndexUnavailableError("index_publication_failed", { snapshotId });
  }
}

// ── Source re-observation ──────────────────────────────────────────────────

/**
 * Step 11: Re-observe exact source state and compare with the original.
 *
 * If the source changed, throws `source_changed_during_index`.
 */
async function verifySourceUnchanged(
  canonicalSource: string,
  originalObservation: SourceStatePayload | DirectorySourceState,
  isGit: boolean,
): Promise<void> {
  if (isGit) {
    const reobservation = await observeGitSourceStateOnce(canonicalSource);
    const originalBytes = canonicalStringify(originalObservation);
    const reobservationBytes = canonicalStringify(reobservation);
    if (originalBytes !== reobservationBytes) {
      throw new LocalCodeIndexUnavailableError("source_changed_during_index", {
        sourcePath: canonicalSource,
      });
    }
  } else {
    const reobservation = await observeDirectory({ sourcePath: canonicalSource });
    const origDirObs = originalObservation as DirectorySourceState;
    if (!areSourceStatesEqual(origDirObs, reobservation)) {
      throw new LocalCodeIndexUnavailableError("source_changed_during_index", {
        sourcePath: canonicalSource,
      });
    }
  }
}

// ── Current-pointer publication ────────────────────────────────────────────

/**
 * Steps 13–15: Build, write, and atomically publish current.json.
 */
async function publishCurrentPointer(
  storageRoot: string,
  worktreeKey: string,
  snapshotId: string,
  identityBytes: Uint8Array,
  lockOwner: IndexLockOwner,
  previousPtr: CurrentPointer | null,
): Promise<void> {
  const identityHash = createHash("sha256").update(identityBytes).digest("hex");

  // Build deduplicated, newest-first list of previous snapshot IDs.
  const previousIds: string[] = [];
  if (previousPtr !== null) {
    previousIds.push(previousPtr.snapshotId);
    for (const id of previousPtr.previousSnapshotIds) {
      if (id !== previousPtr.snapshotId && !previousIds.includes(id)) {
        previousIds.push(id);
      }
    }
  }
  while (previousIds.length > 2) {
    previousIds.pop();
  }

  const pointer: CurrentPointer = {
    schemaVersion: 1,
    worktreeKey,
    snapshotId,
    identityHash,
    ownerToken: lockOwner.ownerToken,
    publishedAt: new Date().toISOString(),
    previousSnapshotIds: previousIds,
  };

  const pointerBytes = new TextEncoder().encode(canonicalStringify(pointer));
  const pointerPath = worktreeCurrentPointer(storageRoot, worktreeKey);
  const worktreeDirPath = path.dirname(pointerPath);

  await mkdir(worktreeDirPath, { recursive: true });

  // Step 13: Exclusively create a temporary file.
  const tmpName = tempFileName(lockOwner.ownerToken, "current");
  const tmpPath = path.join(worktreeDirPath, tmpName);

  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LocalCodeIndexUnavailableError("index_publication_failed", { cause: err });
    }
    throw err;
  }

  try {
    // Step 14: Write, sync, close.
    await fh.write(pointerBytes);
    await fh.sync();
  } finally {
    await fh.close();
  }

  // Verify the written bytes.
  const verifyBytes = await readBoundedFileNoFollow(tmpPath, MAX_CURRENT_JSON_BYTES);
  if (!buffersEqual(verifyBytes, pointerBytes)) {
    throw new LocalCodeIndexUnavailableError("index_publication_failed");
  }

  // Step 15: Atomically rename over current.json.
  await rename(tmpPath, pointerPath);
  await syncDirectory(worktreeDirPath);
}

// ── Current-pointer reading ────────────────────────────────────────────────

/**
 * Read and validate the current.json pointer file.
 */
async function readCurrentPointer(
  storageRoot: string,
  worktreeKey: string,
): Promise<CurrentPointer | null> {
  const pointerPath = worktreeCurrentPointer(storageRoot, worktreeKey);

  let raw: Uint8Array;
  try {
    raw = await readBoundedFileNoFollow(pointerPath, MAX_CURRENT_JSON_BYTES);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (parsed.schemaVersion !== 1) return null;
  if (typeof parsed.worktreeKey !== "string" || !parsed.worktreeKey) return null;
  if (typeof parsed.snapshotId !== "string" || !parsed.snapshotId) return null;
  if (typeof parsed.identityHash !== "string" || !parsed.identityHash) return null;
  if (typeof parsed.ownerToken !== "string" || !parsed.ownerToken) return null;
  if (typeof parsed.publishedAt !== "string") return null;

  const previousSnapshotIds = Array.isArray(parsed.previousSnapshotIds)
    ? (parsed.previousSnapshotIds as unknown[]).filter((id): id is string => typeof id === "string")
    : [];

  return {
    schemaVersion: 1,
    worktreeKey: parsed.worktreeKey,
    snapshotId: parsed.snapshotId,
    identityHash: parsed.identityHash,
    ownerToken: parsed.ownerToken,
    publishedAt: parsed.publishedAt,
    previousSnapshotIds,
  };
}

// ── Buffer comparison ──────────────────────────────────────────────────────

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
