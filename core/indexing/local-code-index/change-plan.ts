/**
 * Local Code Index v2 — change planner.
 *
 * Compares two source-state payloads (previous snapshot vs current observation)
 * and produces a deterministic change plan with reuse/compute/delete/retarget
 * decisions for downstream extraction.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md section 8.3
 *
 * Dependencies: node:crypto, contracts.ts, canonical-json.ts.
 */

import { createHash } from "node:crypto";

import { canonicalStringify } from "./canonical-json.js";
import { deriveFileObjectId } from "./object-store.js";

// ── Source-state entry types ────────────────────────────────────────────────

/**
 * Pinned filesystem metadata for a single file path.
 *
 * All numeric identity fields are serialized as strings to preserve
 * BigInt precision across JSON round-trips.
 */
export type PinnedFileMetadata = Readonly<{
  device: string;
  inode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  mode: number;
}>;

/**
 * A single entry in the source-state file inventory.
 *
 * Represents one tracked or untracked path with its content identity,
 * language, extractor fingerprint, and pinned filesystem metadata.
 */
export type SourceStateEntry = Readonly<{
  /** Canonical relative path from the source root. */
  path: string;
  /** SHA-256 hex digest of the worktree source bytes. */
  contentId: string;
  /** Effective language identifier (e.g., "typescript", "python"). */
  language: string;
  /** Parser mode used for extraction (e.g., "ast-grep", "lexical"). */
  parserMode: string;
  /** Language-specific extractor fingerprint. */
  languageExtractorFingerprint: string;
  /** Pinned filesystem metadata at observation time. */
  metadata: PinnedFileMetadata;
  /** Git blob ID for clean tracked files, null for dirty/untracked. */
  gitBlobId: string | null;
  /** Worktree materialization fingerprint for clean tracked files. */
  materializationFingerprint: string | null;
}>;

/**
 * Repository-level identity captured during source observation.
 */
export type RepositoryIdentity = Readonly<{
  /** Canonical common git directory path, or null for non-Git. */
  commonGitDir: string | null;
  /** Git object format (e.g., "sha1", "sha256"). */
  objectFormat: string | null;
  /** HEAD commit hash, or null for non-Git. */
  head: string | null;
  /** Current branch name, or null for detached HEAD. */
  branch: string | null;
}>;

/**
 * Materialization configuration captured during source observation.
 *
 * Includes effective core.autocrlf, core.eol, and attributes file location.
 */
export type MaterializationConfig = Readonly<{
  autocrlf: boolean | "input";
  eol: "lf" | "crlf" | "native" | "auto";
  attributesFile: string | null;
}>;

/**
 * Complete source-state payload produced by git-observer or directory-observer.
 *
 * This is the canonical representation of the source tree at a point in time.
 * Two observations of the same stable state produce byte-identical payloads.
 */
export type SourceState = Readonly<{
  /** Repository identity (null fields for non-Git directories). */
  repository: RepositoryIdentity;
  /** Materialization configuration (defaults for non-Git). */
  materialization: MaterializationConfig;
  /** Complete file inventory, sorted by path. */
  entries: readonly SourceStateEntry[];
  /** Worktree state fingerprint (branch, HEAD, stage, status). */
  worktreeStateFingerprint: string;
  /** Timestamp when the observation completed (ms since epoch). */
  observedAt: number;
}>;

// ── Change plan types ───────────────────────────────────────────────────────

/**
 * Decision types for each path in the change plan.
 *
 * - `reuse`: content object and extractor fingerprint already exist in the
 *   object store; no extraction needed.
 * - `compute`: content object is absent or extractor fingerprint changed;
 *   extraction (ast-grep) is required.
 * - `delete`: path existed in the previous snapshot but is absent from the
 *   new inventory; snapshot-local records must be removed.
 * - `retarget`: path now names a content object already present under another
 *   path; the existing file object can be reused with a new path binding.
 */
export type ChangeDecision = "reuse" | "compute" | "delete" | "retarget";

/**
 * A single entry in the change plan describing what to do with one path.
 */
export type ChangePlanEntry = Readonly<{
  /** Canonical relative path from the source root. */
  path: string;
  /** The decision for this path. */
  decision: ChangeDecision;
  /**
   * For `reuse` and `retarget`: the existing file object ID to reuse.
   * For `compute`: null (object must be built).
   * For `delete`: null (object records must be removed).
   */
  existingFileObjectId: string | null;
  /**
   * For `retarget`: the previous path that held the same content object.
   * Null for all other decisions.
   */
  retargetFrom: string | null;
  /**
   * Reason the decision was made. Useful for diagnostics and logging.
   */
  reason: string;
}>;

/**
 * Classification of detected changes between two source states.
 *
 * Each flag is true when at least one change of that type was detected.
 */
export type ChangeClassification = {
  /** At least one path was added (present in current but not previous). */
  hasAdditions: boolean;
  /** At least one path was modified (present in both, content or fingerprint changed). */
  hasModifications: boolean;
  /** At least one path was deleted (present in previous but not current). */
  hasDeletions: boolean;
  /** At least one path was renamed (same content ID, different path). */
  hasRenames: boolean;
  /** The branch changed between observations. */
  hasBranchChange: boolean;
  /** At least one file changed line-ending style (CRLF <-> LF). */
  hasCrlfChanges: boolean;
  /** At least one file changed encoding (detected via contentId change with same size). */
  hasEncodingChanges: boolean;
};

/**
 * Deterministic change plan produced by comparing two source-state payloads.
 *
 * The plan is sorted by path for deterministic downstream consumption.
 * The `planId` is a content-addressed hash of the plan entries, suitable
 * for caching and idempotency checks.
 */
export type ChangePlan = Readonly<{
  /** Content-addressed plan ID (SHA-256 hex of canonical entries). */
  planId: string;
  /** Previous snapshot's source state, or null if this is the first build. */
  previous: SourceState | null;
  /** Current observed source state. */
  current: SourceState;
  /** Sorted change plan entries. */
  entries: readonly ChangePlanEntry[];
  /** Classification of detected changes. */
  classification: ChangeClassification;
  /** Summary counts by decision type. */
  summary: Readonly<{
    reuse: number;
    compute: number;
    delete: number;
    retarget: number;
    total: number;
  }>;
  /** Whether force mode was used (bypasses reuse decisions). */
  forced: boolean;
}>;

// ── Input types ─────────────────────────────────────────────────────────────

/**
 * Options for building a change plan.
 */
export type ChangePlanOptions = Readonly<{
  /**
   * Previous source-state payload (from the last published snapshot).
   * Null when building for the first time (all entries will be `compute`).
   */
  previous: SourceState | null;
  /**
   * Current observed source-state payload.
   */
  current: SourceState;
  /**
   * When true, bypasses reuse decisions — all entries with changed content
   * or fingerprints become `compute` even if the content object already
   * exists. Still performs both observations for validation.
   *
   * Default: false.
   */
  force?: boolean;
  /**
   * File object IDs that were verified in the immutable object store.
   *
   * A source-content hash alone is insufficient: identical bytes can be
   * indexed under different languages or parser modes and must therefore
   * retain distinct file object IDs. Missing IDs imply `compute`.
   */
  existingObjectIds?: ReadonlySet<string>;
}>;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 hex digest of a value's canonical JSON.
 */
function hashValue(value: unknown): string {
  const canonical = canonicalStringify(value);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Build a composite fingerprint from language, parser mode, and extractor
 * fingerprint. This is the key for determining whether a file object can
 * be reused.
 */
function extractorKey(entry: SourceStateEntry): string {
  return `${entry.language}\0${entry.parserMode}\0${entry.languageExtractorFingerprint}`;
}

/**
 * Derive the only file object that can safely represent this source-state
 * entry. The object ID includes language, parser mode, and extractor
 * fingerprint in addition to the source bytes.
 */
function fileObjectIdForEntry(entry: SourceStateEntry): string {
  return deriveFileObjectId(
    entry.language,
    entry.parserMode,
    entry.languageExtractorFingerprint,
    entry.contentId,
  );
}

function verifiedFileObjectId(
  entry: SourceStateEntry,
  existingObjectIds: ReadonlySet<string> | undefined,
): string | null {
  const fileObjectId = fileObjectIdForEntry(entry);
  return existingObjectIds === undefined || existingObjectIds.has(fileObjectId)
    ? fileObjectId
    : null;
}

function reusablePreviousEntry(
  candidates: readonly SourceStateEntry[] | undefined,
  current: SourceStateEntry,
): SourceStateEntry | null {
  if (candidates === undefined) return null;
  const currentExtractorKey = extractorKey(current);
  return candidates.find((candidate) =>
    extractorKey(candidate) === currentExtractorKey,
  ) ?? null;
}

/**
 * Detect CRLF changes by comparing content IDs of files with the same path
 * and same size but different content. This heuristic catches line-ending
 * conversions without reading file bytes.
 */
function detectCrlfChange(
  prev: SourceStateEntry,
  curr: SourceStateEntry,
): boolean {
  // Same size, different content, same language — likely a line-ending change.
  if (
    prev.metadata.size === curr.metadata.size &&
    prev.contentId !== curr.contentId &&
    prev.language === curr.language
  ) {
    // Further check: if the content IDs differ but the extractor keys match,
    // and the size is identical, this is likely a whitespace/line-ending change.
    return true;
  }
  return false;
}

/**
 * Detect encoding changes by comparing content IDs of files with the same
 * path and same size but different content, when CRLF is not the cause.
 */
function detectEncodingChange(
  prev: SourceStateEntry,
  curr: SourceStateEntry,
): boolean {
  // Same size, different content, different extractor fingerprint —
  // likely an encoding change that affected the fingerprint.
  if (
    prev.metadata.size === curr.metadata.size &&
    prev.contentId !== curr.contentId &&
    prev.languageExtractorFingerprint !== curr.languageExtractorFingerprint
  ) {
    return true;
  }
  return false;
}

/**
 * Build a map from content ID to all paths that have that content in the
 * given source state. Used for rename and retarget detection.
 */
function buildContentIdIndex(
  entries: readonly SourceStateEntry[],
): ReadonlyMap<string, readonly string[]> {
  const index = new Map<string, string[]>();
  for (const entry of entries) {
    const paths = index.get(entry.contentId);
    if (paths) {
      paths.push(entry.path);
    } else {
      index.set(entry.contentId, [entry.path]);
    }
  }
  return index;
}

/**
 * Build a map from path to entry for quick lookup.
 */
function buildPathIndex(
  entries: readonly SourceStateEntry[],
): ReadonlyMap<string, SourceStateEntry> {
  const index = new Map<string, SourceStateEntry>();
  for (const entry of entries) {
    index.set(entry.path, entry);
  }
  return index;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a deterministic change plan by comparing two source-state payloads.
 *
 * The planner classifies each path as:
 * - `reuse`: content object and extractor fingerprint already exist;
 * - `compute`: content object is absent or extractor fingerprint changed;
 * - `delete`: path existed in the previous snapshot but not the new inventory;
 * - `retarget`: path now names a content object already present under another path.
 *
 * When `force=true`, all entries with changed content or fingerprints become
 * `compute` even if the content object already exists. Both observations are
 * still performed for validation.
 *
 * The returned plan is sorted by path for deterministic downstream consumption.
 *
 * @param options - Previous and current source states, optional force flag,
 *   and optional existing object map.
 * @returns A deterministic change plan with entries, classification, and summary.
 *
 * @example
 * ```ts
 * const plan = buildChangePlan({
 *   previous: lastSnapshot.sourceState,
 *   current: currentObservation,
 *   existingObjectIds: objectStore.getVerifiedFileObjectIds(),
 * });
 *
 * for (const entry of plan.entries) {
 *   if (entry.decision === "compute") {
 *     await extractAndStore(entry.path);
 *   }
 * }
 * ```
 */
export function buildChangePlan(options: ChangePlanOptions): ChangePlan {
  const { previous, current, force = false, existingObjectIds } = options;

  // ── Build indices ───────────────────────────────────────────────────────
  const prevPathIndex = previous
    ? buildPathIndex(previous.entries)
    : new Map<string, SourceStateEntry>();
  const currPathIndex = buildPathIndex(current.entries);

  const prevContentIndex = previous
    ? buildContentIdIndex(previous.entries)
    : new Map<string, readonly string[]>();

  // ── Classify each current path ──────────────────────────────────────────
  const planEntries: ChangePlanEntry[] = [];
  const classification: ChangeClassification = {
    hasAdditions: false,
    hasModifications: false,
    hasDeletions: false,
    hasRenames: false,
    hasBranchChange: false,
    hasCrlfChanges: false,
    hasEncodingChanges: false,
  };

  // Detect branch change.
  if (
    previous &&
    previous.repository.branch !== current.repository.branch
  ) {
    classification.hasBranchChange = true;
  }

  // Process all current paths.
  for (const currEntry of current.entries) {
    const prevEntry = prevPathIndex.get(currEntry.path);

    if (!prevEntry) {
      // ── New path (addition) ──────────────────────────────────────────
      classification.hasAdditions = true;

      // Check if this content already exists under a different path (retarget).
      const previousEntriesForContent = (prevContentIndex.get(currEntry.contentId) ?? [])
        .map((previousPath) => prevPathIndex.get(previousPath))
        .filter((entry): entry is SourceStateEntry => entry !== undefined);
      const retargetSource = reusablePreviousEntry(previousEntriesForContent, currEntry);
      const existingId = retargetSource === null
        ? null
        : verifiedFileObjectId(currEntry, existingObjectIds);
      if (retargetSource !== null && existingId !== null) {
        // Content existed under another path — this is a retarget.
        const retargetFrom = retargetSource.path;
        classification.hasRenames = true;

        planEntries.push({
          path: currEntry.path,
          decision: "retarget",
          existingFileObjectId: existingId,
          retargetFrom,
          reason: `content previously at ${retargetFrom}`,
        });
      } else {
        // Truly new content — compute.
        planEntries.push({
          path: currEntry.path,
          decision: "compute",
          existingFileObjectId: null,
          retargetFrom: null,
          reason: "new file",
        });
      }
      continue;
    }

    // ── Path exists in both states ──────────────────────────────────────
    const prevExtKey = extractorKey(prevEntry);
    const currExtKey = extractorKey(currEntry);
    const contentChanged = prevEntry.contentId !== currEntry.contentId;
    const fingerprintChanged = prevExtKey !== currExtKey;

    if (!contentChanged && !fingerprintChanged) {
      // ── Unchanged — reuse ──────────────────────────────────────────
      if (force) {
        // Force mode: still compute even if unchanged.
        planEntries.push({
          path: currEntry.path,
          decision: "compute",
          existingFileObjectId: null,
          retargetFrom: null,
          reason: "forced recompute",
        });
      } else {
        // Normal mode: reuse existing object.
        const existingId = verifiedFileObjectId(currEntry, existingObjectIds);
        if (existingId === null && existingObjectIds !== undefined) {
          planEntries.push({
            path: currEntry.path,
            decision: "compute",
            existingFileObjectId: null,
            retargetFrom: null,
            reason: "file object missing from immutable store",
          });
        } else {
          planEntries.push({
            path: currEntry.path,
            decision: "reuse",
            existingFileObjectId: existingId,
            retargetFrom: null,
            reason: "content and fingerprint unchanged",
          });
        }
      }
    } else if (contentChanged) {
      // ── Content changed — compute ──────────────────────────────────
      classification.hasModifications = true;

      // Detect CRLF and encoding changes.
      if (detectCrlfChange(prevEntry, currEntry)) {
        classification.hasCrlfChanges = true;
      }
      if (detectEncodingChange(prevEntry, currEntry)) {
        classification.hasEncodingChanges = true;
      }

      // Check if the new content already exists under another path.
      const previousEntriesForContent = (prevContentIndex.get(currEntry.contentId) ?? [])
        .map((previousPath) => prevPathIndex.get(previousPath))
        .filter((entry): entry is SourceStateEntry => entry !== undefined);
      const retargetSource = reusablePreviousEntry(previousEntriesForContent, currEntry);
      const existingId = retargetSource === null
        ? null
        : verifiedFileObjectId(currEntry, existingObjectIds);
      if (retargetSource !== null && existingId !== null) {
        // New content existed elsewhere — retarget.
        classification.hasRenames = true;
        const retargetFrom = retargetSource.path;
        planEntries.push({
          path: currEntry.path,
          decision: "retarget",
          existingFileObjectId: existingId,
          retargetFrom,
          reason: `content changed to match ${retargetFrom}`,
        });
      } else {
        // Content changed to something new — compute.
        planEntries.push({
          path: currEntry.path,
          decision: "compute",
          existingFileObjectId: null,
          retargetFrom: null,
          reason: force
            ? "forced recompute (content changed)"
            : "content changed",
        });
      }
    } else {
      // ── Only fingerprint changed — compute ──────────────────────────
      classification.hasModifications = true;
      planEntries.push({
        path: currEntry.path,
        decision: "compute",
        existingFileObjectId: null,
        retargetFrom: null,
        reason: force
          ? "forced recompute (fingerprint changed)"
          : "extractor fingerprint changed",
      });
    }
  }

  // ── Process deletions ──────────────────────────────────────────────────
  for (const prevEntry of previous?.entries ?? []) {
    if (!currPathIndex.has(prevEntry.path)) {
      classification.hasDeletions = true;
      planEntries.push({
        path: prevEntry.path,
        decision: "delete",
        existingFileObjectId: null,
        retargetFrom: null,
        reason: "file deleted",
      });
    }
  }

  // ── Sort by path for deterministic output ──────────────────────────────
  planEntries.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });

  // ── Compute summary ────────────────────────────────────────────────────
  const summary = {
    reuse: 0,
    compute: 0,
    delete: 0,
    retarget: 0,
    total: planEntries.length,
  };
  for (const entry of planEntries) {
    summary[entry.decision]++;
  }

  // ── Compute plan ID ────────────────────────────────────────────────────
  const planId = hashValue(planEntries);

  return {
    planId,
    previous,
    current,
    entries: planEntries,
    classification,
    summary,
    forced: force,
  };
}

/**
 * Check if a change plan indicates no changes are needed.
 *
 * A plan is "empty" when all entries are `reuse` decisions, meaning
 * the current state matches the previous snapshot exactly.
 *
 * @param plan - The change plan to check.
 * @returns true if all entries are `reuse` (no work needed).
 */
export function isChangePlanEmpty(plan: ChangePlan): boolean {
  return plan.summary.compute === 0 &&
    plan.summary.delete === 0 &&
    plan.summary.retarget === 0;
}

/**
 * Get only the entries that require extraction (compute decisions).
 *
 * @param plan - The change plan to filter.
 * @returns Array of entries with decision === "compute".
 */
export function getComputeEntries(
  plan: ChangePlan,
): readonly ChangePlanEntry[] {
  return plan.entries.filter((e) => e.decision === "compute");
}

/**
 * Get only the entries that require deletion (delete decisions).
 *
 * @param plan - The change plan to filter.
 * @returns Array of entries with decision === "delete".
 */
export function getDeleteEntries(
  plan: ChangePlan,
): readonly ChangePlanEntry[] {
  return plan.entries.filter((e) => e.decision === "delete");
}

/**
 * Get only the entries that can be retargeted (retarget decisions).
 *
 * @param plan - The change plan to filter.
 * @returns Array of entries with decision === "retarget".
 */
export function getRetargetEntries(
  plan: ChangePlan,
): readonly ChangePlanEntry[] {
  return plan.entries.filter((e) => e.decision === "retarget");
}

/**
 * Get only the entries that can be reused (reuse decisions).
 *
 * @param plan - The change plan to filter.
 * @returns Array of entries with decision === "reuse".
 */
export function getReuseEntries(
  plan: ChangePlan,
): readonly ChangePlanEntry[] {
  return plan.entries.filter((e) => e.decision === "reuse");
}
