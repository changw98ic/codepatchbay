/**
 * Local Code Index v2 — public contracts.
 *
 * Canonical module seam for index creation, inspection, and querying.
 * No caller imports storage types or reads index JSON directly.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md sections 5–6, 12
 */

import { createHash } from "node:crypto";

// ── Limits ──────────────────────────────────────────────────────────────────

/** Default result limit when caller omits `limit`. */
export const LOCAL_CODE_INDEX_DEFAULT_LIMIT = 50;

/** Absolute upper bound for any `limit` parameter. */
export const LOCAL_CODE_INDEX_MAX_LIMIT = 500;

/** Maximum number of input paths accepted in a single query. */
export const LOCAL_CODE_INDEX_MAX_INPUT_PATHS = 100;

/** Maximum number of input symbols accepted in a single query. */
export const LOCAL_CODE_INDEX_MAX_INPUT_SYMBOLS = 100;

/** Maximum symbol length in UTF-8 bytes. */
export const LOCAL_CODE_INDEX_MAX_SYMBOL_LENGTH = 512;

// ── Coverage ordering ───────────────────────────────────────────────────────

/**
 * Strongest-to-weakest ordering for `LocalCodeIndexCoverage`.
 * Used to derive `LocalCodeIndexCoverageSummary.effective` (weakest wins).
 */
export const LOCAL_CODE_INDEX_COVERAGE_ORDER: readonly LocalCodeIndexCoverage[] =
  ["ast-grep-structural", "lexical-reference-fallback", "file-inventory-only"];

// ── Error reasons ───────────────────────────────────────────────────────────

export type LocalCodeIndexErrorReason =
  | "missing_source_path"
  | "unsafe_source_path"
  | "unsafe_storage_root"
  | "missing_local_code_index"
  | "unsupported_index_schema"
  | "corrupt_index"
  | "invalid_index_ref"
  | "invalid_query"
  | "invalid_cursor"
  | "cursor_snapshot_mismatch"
  | "operation_aborted"
  | "unsupported_platform"
  | "unsupported_git_state"
  | "index_lock_timeout"
  | "index_lock_lost"
  | "index_lock_repair_required"
  | "source_changed_during_index"
  | "parser_unavailable"
  | "parser_output_invalid"
  | "index_publication_failed"
  | "index_publication_ambiguous"
  | "object_identity_collision"
  | "snapshot_identity_collision"
  | "index_cleanup_ambiguous";

// ── Coverage ────────────────────────────────────────────────────────────────

export type LocalCodeIndexCoverage =
  | "ast-grep-structural"
  | "lexical-reference-fallback"
  | "file-inventory-only";

export type LocalCodeIndexCoverageSummary = Readonly<{
  effective: LocalCodeIndexCoverage;
  partial: boolean;
  failedFiles: number;
  oversizedFiles: number;
}>;

// ── Ref / identity ──────────────────────────────────────────────────────────

export type LocalCodeIndexRef = Readonly<{
  schemaVersion: 2;
  sourcePath: string;
  repositoryKey: string;
  worktreeKey: string;
  sourceKey: string;
  snapshotId: string;
}>;

// ── Tool state ──────────────────────────────────────────────────────────────

export type LocalCodeIndexToolState = Readonly<{
  name: "ast-grep";
  version: string | null;
  extractorFingerprint: string;
  available: boolean;
  coverage: LocalCodeIndexCoverageSummary;
  errors: readonly string[];
}>;

// ── Timings ─────────────────────────────────────────────────────────────────

export type LocalCodeIndexPhaseTimings = Readonly<{
  inventoryMs: number;
  hashingMs: number;
  /** ast-grep process execution and validated output decoding only. */
  parsingMs: number;
  /** Alias for parsingMs retained for explicit run-report consumers. */
  astGrepMs: number;
  /** Safe source-byte reads only. */
  fileReadMs: number;
  /** Conversion of parsed facts into the canonical per-file representation. */
  fileFactExtractionMs: number;
  /** Durable file-object publication. */
  fileObjectPublicationMs: number;
  /** Relationship resolution and deterministic shard construction. */
  relationshipMs: number;
  /** Durable symbol- and relation-shard publication. */
  shardPublicationMs: number;
  /** Immutable snapshot publication and verification. */
  snapshotPublicationMs: number;
  lookupMs: number;
  /** Sum of the durable publication phases. */
  publicationMs: number;
}>;

// ── Build stats ─────────────────────────────────────────────────────────────

export type LocalCodeIndexBuildStats = Readonly<{
  mode: "reused" | "incremental" | "full";
  discoveredFiles: number;
  reusedFiles: number;
  hashedFiles: number;
  parsedFiles: number;
  deletedFiles: number;
  oversizedFiles: number;
  rebuiltSymbolShards: number;
  rebuiltRelationShards: number;
  bytesRead: number;
  bytesWritten: number;
  coverage: LocalCodeIndexCoverageSummary;
  parserVersion: string | null;
  timings: LocalCodeIndexPhaseTimings;
  durationMs: number;
}>;

// ── Ensure options / result ─────────────────────────────────────────────────

export type EnsureLocalCodeIndexOptions = Readonly<{
  cpbRoot?: string;
  sourcePath: string;
  /** ast-grep executable resolved by the caller. Defaults to the PATH command. */
  astGrepBinaryPath?: string;
  force?: boolean;
  signal?: AbortSignal;
}>;

export type EnsureLocalCodeIndexResult = Readonly<{
  available: true;
  ref: LocalCodeIndexRef;
  tool: LocalCodeIndexToolState;
  stats: LocalCodeIndexBuildStats;
}>;

// ── Status ──────────────────────────────────────────────────────────────────

export type LocalCodeIndexStatus =
  | Readonly<{
      available: false;
      fresh: false;
      exact: false;
      reason: LocalCodeIndexErrorReason;
      sourcePath: string | null;
    }>
  | Readonly<{
      available: true;
      fresh: boolean;
      exact: true;
      reason: null | "local_code_index_stale";
      ref: LocalCodeIndexRef;
      tool: LocalCodeIndexToolState;
      files: number;
      indexedBytes: number;
    }>;

// ── Query types ─────────────────────────────────────────────────────────────

export type SourceRange = Readonly<{
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}>;

export type SymbolOccurrence = Readonly<{
  symbol: string;
  kind: string;
  role: "definition" | "reference";
  path: string;
  range: SourceRange;
  exported: boolean;
  coverage: LocalCodeIndexCoverage;
}>;

export type FileRelationship = Readonly<{
  fromPath: string;
  toPath: string;
  type: "imports" | "references" | "ambiguous-reference";
  symbol: string | null;
  evidence: readonly SourceRange[];
  weight: number;
}>;

export type FileSummary = Readonly<{
  path: string;
  language: string;
  size: number;
  contentId: string;
  coverage: LocalCodeIndexCoverage;
  definitions: readonly SymbolOccurrence[];
  imports: readonly Readonly<{
    requested: string;
    resolvedPath: string | null;
    range: SourceRange;
  }>[];
  errors: readonly string[];
}>;

export type LocalCodeIndexQuery =
  | Readonly<{
      kind: "definitions";
      symbol: string;
      match: "exact" | "prefix";
      limit?: number;
    }>
  | Readonly<{
      kind: "references";
      symbol: string;
      match: "exact";
      limit?: number;
    }>
  | Readonly<{
      kind: "imports";
      path: string;
      limit?: number;
    }>
  | Readonly<{
      kind: "file-summary";
      path: string;
    }>
  | Readonly<{
      kind: "related-files";
      paths: string[];
      symbols?: string[];
      limit?: number;
    }>
  | Readonly<{
      kind: "inventory";
      cursor?: string;
      limit?: number;
    }>;

export type LocalCodeIndexQueryResult =
  | Readonly<{
      kind: "definitions" | "references";
      snapshotId: string;
      coverage: LocalCodeIndexCoverageSummary;
      truncated: boolean;
      durationMs: number;
      occurrences: readonly SymbolOccurrence[];
    }>
  | Readonly<{
      kind: "imports";
      snapshotId: string;
      coverage: LocalCodeIndexCoverageSummary;
      truncated: boolean;
      durationMs: number;
      relationships: readonly FileRelationship[];
    }>
  | Readonly<{
      kind: "file-summary";
      snapshotId: string;
      coverage: LocalCodeIndexCoverageSummary;
      truncated: false;
      durationMs: number;
      file: FileSummary | null;
    }>
  | Readonly<{
      kind: "related-files";
      snapshotId: string;
      coverage: LocalCodeIndexCoverageSummary;
      truncated: boolean;
      durationMs: number;
      files: readonly Readonly<{
        path: string;
        score: number;
        evidence: readonly FileRelationship[];
      }>[];
    }>
  | Readonly<{
      kind: "inventory";
      snapshotId: string;
      coverage: LocalCodeIndexCoverageSummary;
      truncated: boolean;
      durationMs: number;
      files: readonly Readonly<{
        path: string;
        language: string;
        size: number;
        nodeCount: number;
        coverage: LocalCodeIndexCoverage;
      }>[];
      nextCursor: string | null;
    }>;

// ── Typed error ─────────────────────────────────────────────────────────────

/**
 * Typed error for all externally visible local-code-index failures.
 *
 * Spec section 12: every failure surface uses
 * `{ code: "local_code_index_unavailable", reason, ... }`.
 */
export class LocalCodeIndexUnavailableError extends Error {
  override readonly name = "LocalCodeIndexUnavailableError";

  readonly code: "local_code_index_unavailable" =
    "local_code_index_unavailable";
  readonly reason: LocalCodeIndexErrorReason;
  readonly sourcePath?: string;
  readonly committed?: boolean;
  readonly snapshotId?: string;
  readonly recoveryPaths?: readonly string[];

  constructor(
    reason: LocalCodeIndexErrorReason,
    details?: Readonly<{
      sourcePath?: string;
      committed?: boolean;
      snapshotId?: string;
      recoveryPaths?: readonly string[];
      cause?: unknown;
    }>,
  ) {
    const parts = [`local_code_index_unavailable: ${reason}`];
    if (details?.sourcePath !== undefined) {
      parts.push(`sourcePath=${details.sourcePath}`);
    }
    if (details?.snapshotId !== undefined) {
      parts.push(`snapshotId=${details.snapshotId}`);
    }
    super(parts.join("; "), { cause: details?.cause });
    this.reason = reason;
    if (details?.sourcePath !== undefined) {
      this.sourcePath = details.sourcePath;
    }
    if (details?.committed !== undefined) {
      this.committed = details.committed;
    }
    if (details?.snapshotId !== undefined) {
      this.snapshotId = details.snapshotId;
    }
    if (details?.recoveryPaths !== undefined) {
      this.recoveryPaths = details.recoveryPaths;
    }
  }
}

// ── Key derivation helpers ──────────────────────────────────────────────────

const REPOSITORY_PREFIX = "cpb-local-index-v2-repository\0";
const WORKTREE_PREFIX = "cpb-local-index-v2-worktree\0";

/**
 * Derive a 32-hex-char repository key from the canonical common git dir
 * (or source path for non-git directories).
 */
export function deriveRepositoryKey(
  canonicalCommonGitDirOrSourcePath: string,
): string {
  return createHash("sha256")
    .update(REPOSITORY_PREFIX)
    .update(canonicalCommonGitDirOrSourcePath)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Derive a 32-hex-char worktree key from the canonical source path.
 */
export function deriveWorktreeKey(canonicalSourcePath: string): string {
  return createHash("sha256")
    .update(WORKTREE_PREFIX)
    .update(canonicalSourcePath)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Derive the source key from repository and worktree keys.
 */
export function deriveSourceKey(
  repositoryKey: string,
  worktreeKey: string,
): string {
  return createHash("sha256")
    .update(repositoryKey)
    .update("\0")
    .update(worktreeKey)
    .digest("hex");
}
