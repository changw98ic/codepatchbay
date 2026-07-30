/**
 * Local Code Index v2 — deterministic coverage aggregation.
 *
 * Computes `LocalCodeIndexCoverageSummary` from per-file outcomes.
 * The effective coverage is the weakest level present (highest index in
 * `LOCAL_CODE_INDEX_COVERAGE_ORDER`), because a single file stuck at
 * `file-inventory-only` prevents the overall index from claiming
 * `ast-grep-structural`.
 *
 * Partial = true when at least one file did not reach the strongest
 * coverage level observed among all files.
 *
 * Parser absence and per-file failures produce exact summaries with
 * `effective: "file-inventory-only"`, `partial: true`, and the
 * appropriate failed-files count.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md sections 5, 12
 *
 * Dependencies: contracts.ts only (pure computation, no I/O).
 */

import {
  type LocalCodeIndexCoverage,
  type LocalCodeIndexCoverageSummary,
  LOCAL_CODE_INDEX_COVERAGE_ORDER,
} from "./contracts.js";

// ── Per-file input ───────────────────────────────────────────────────────────

/**
 * Outcome of indexing a single file.
 *
 * - `"ast-grep-structural"` — parser ran and produced structural symbols.
 * - `"lexical-reference-fallback"` — parser absent or failed; lexical
 *   reference extraction succeeded.
 * - `"file-inventory-only"` — only the file path/metadata was recorded.
 * - `"failed"` — the file could not be indexed at all (I/O error, parse
 *   crash, etc.).  Contributes to `failedFiles`.
 * - `"oversized"` — the file exceeded the size bound and was skipped.
 *   Contributes to `oversizedFiles`.
 */
export type FileCoverageOutcome =
  | LocalCodeIndexCoverage
  | "failed"
  | "oversized";

// ── Coverage ordering lookup ─────────────────────────────────────────────────

/**
 * Map from coverage level to its ordinal position (lower = stronger).
 * Index 0 = strongest (`ast-grep-structural`), index 2 = weakest
 * (`file-inventory-only`).
 */
const COVERAGE_ORDINAL: ReadonlyMap<LocalCodeIndexCoverage, number> = new Map(
  LOCAL_CODE_INDEX_COVERAGE_ORDER.map((level, idx) => [level, idx]),
);

/**
 * Return the ordinal for a coverage level.  Throws on invalid input
 * (programming error, not runtime data).
 */
function ordinal(level: LocalCodeIndexCoverage): number {
  const ord = COVERAGE_ORDINAL.get(level);
  if (ord === undefined) {
    throw new Error(`unknown coverage level: ${level}`);
  }
  return ord;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

/**
 * Compute the coverage summary from an array of per-file outcomes.
 *
 * Rules:
 * 1. `effective` = weakest (highest ordinal) coverage level among all
 *    files that reached a real coverage level (not `"failed"` or
 *    `"oversized"`).
 * 2. If zero files reached any coverage level (all failed/oversized),
 *    effective falls back to `"file-inventory-only"`.
 * 3. `partial` = true when at least one file with a real coverage level
 *    has a weaker level than the strongest level present, OR when any
 *    file is `"failed"` or `"oversized"`.
 * 4. `failedFiles` = count of `"failed"` outcomes.
 * 5. `oversizedFiles` = count of `"oversized"` outcomes.
 *
 * @param outcomes Per-file outcomes from the indexing run.
 * @returns A frozen coverage summary.
 */
export function aggregateCoverage(
  outcomes: readonly FileCoverageOutcome[],
): LocalCodeIndexCoverageSummary {
  let failedFiles = 0;
  let oversizedFiles = 0;

  // Track the strongest and weakest real coverage levels seen.
  let strongestOrdinal = Infinity;
  let weakestOrdinal = -1;

  for (const outcome of outcomes) {
    if (outcome === "failed") {
      failedFiles++;
      continue;
    }
    if (outcome === "oversized") {
      oversizedFiles++;
      continue;
    }

    const ord = ordinal(outcome);
    if (ord < strongestOrdinal) strongestOrdinal = ord;
    if (ord > weakestOrdinal) weakestOrdinal = ord;
  }

  // No file reached a real coverage level.
  if (strongestOrdinal === Infinity) {
    return Object.freeze({
      effective: "file-inventory-only" as LocalCodeIndexCoverage,
      partial: true,
      failedFiles,
      oversizedFiles,
    });
  }

  // Effective = weakest level present.
  const effective = LOCAL_CODE_INDEX_COVERAGE_ORDER[weakestOrdinal]!;

  // Partial when:
  // - any file is weaker than the strongest level (coverage is mixed), OR
  // - any file failed or was oversized (not all files indexed).
  const partial =
    weakestOrdinal > strongestOrdinal ||
    failedFiles > 0 ||
    oversizedFiles > 0;

  return Object.freeze({
    effective,
    partial,
    failedFiles,
    oversizedFiles,
  });
}

// ── Parser-absence summary ───────────────────────────────────────────────────

/**
 * Produce a coverage summary when the parser tool is entirely absent.
 *
 * Every file degrades to `"file-inventory-only"`, and the summary is
 * marked partial (because structural analysis was not available).
 *
 * @param fileCount Total number of files discovered.
 * @param failedFiles Number of files that failed during inventory.
 * @param oversizedFiles Number of files that exceeded size bounds.
 * @returns A frozen coverage summary.
 */
export function parserAbsentSummary(
  fileCount: number,
  failedFiles: number = 0,
  oversizedFiles: number = 0,
): LocalCodeIndexCoverageSummary {
  return Object.freeze({
    effective: "file-inventory-only" as LocalCodeIndexCoverage,
    partial: true,
    failedFiles,
    oversizedFiles,
  });
}

// ── Single-file coverage ─────────────────────────────────────────────────────

/**
 * Compute a coverage summary for a single-file query result.
 *
 * This is a convenience for callers that need the summary shape but
 * only have one file's coverage level (e.g., `file-summary` queries).
 *
 * @param coverage The coverage level for the single file.
 * @param failed Whether the file failed during indexing.
 * @param oversized Whether the file was oversized.
 * @returns A frozen coverage summary.
 */
export function singleFileSummary(
  coverage: FileCoverageOutcome,
): LocalCodeIndexCoverageSummary {
  return aggregateCoverage([coverage]);
}

// ── Merge two summaries ──────────────────────────────────────────────────────

/**
 * Merge two coverage summaries into one.
 *
 * Useful when combining results from incremental and reused file sets,
 * or when merging results from separate parsing passes.
 *
 * Rules:
 * - `effective` = weaker of the two effective levels.
 * - `partial` = true if either is partial, or if the two effective
 *   levels differ.
 * - `failedFiles` and `oversizedFiles` are summed.
 *
 * @param a First summary.
 * @param b Second summary.
 * @returns A frozen merged summary.
 */
export function mergeCoverageSummaries(
  a: LocalCodeIndexCoverageSummary,
  b: LocalCodeIndexCoverageSummary,
): LocalCodeIndexCoverageSummary {
  const aOrd = ordinal(a.effective);
  const bOrd = ordinal(b.effective);
  const weakerOrdinal = Math.max(aOrd, bOrd);
  const effective = LOCAL_CODE_INDEX_COVERAGE_ORDER[weakerOrdinal]!;

  const partial =
    a.partial || b.partial || aOrd !== bOrd;

  return Object.freeze({
    effective,
    partial,
    failedFiles: a.failedFiles + b.failedFiles,
    oversizedFiles: a.oversizedFiles + b.oversizedFiles,
  });
}

// ── Exhaustive outcome counter ───────────────────────────────────────────────

/**
 * Counts for each outcome category.  Useful for diagnostics and logging.
 */
export type CoverageOutcomeCounts = Readonly<{
  astGrepStructural: number;
  lexicalReferenceFallback: number;
  fileInventoryOnly: number;
  failed: number;
  oversized: number;
  total: number;
}>;

/**
 * Count occurrences of each outcome type.
 *
 * @param outcomes Per-file outcomes.
 * @returns A frozen count object.
 */
export function countOutcomes(
  outcomes: readonly FileCoverageOutcome[],
): CoverageOutcomeCounts {
  let astGrepStructural = 0;
  let lexicalReferenceFallback = 0;
  let fileInventoryOnly = 0;
  let failed = 0;
  let oversized = 0;

  for (const outcome of outcomes) {
    switch (outcome) {
      case "ast-grep-structural":
        astGrepStructural++;
        break;
      case "lexical-reference-fallback":
        lexicalReferenceFallback++;
        break;
      case "file-inventory-only":
        fileInventoryOnly++;
        break;
      case "failed":
        failed++;
        break;
      case "oversized":
        oversized++;
        break;
    }
  }

  return Object.freeze({
    astGrepStructural,
    lexicalReferenceFallback,
    fileInventoryOnly,
    failed,
    oversized,
    total: outcomes.length,
  });
}

// ── Coverage degradation reason ──────────────────────────────────────────────

/**
 * Human-readable reason why the effective coverage is weaker than
 * `ast-grep-structural`.  Returns `null` when coverage is fully
 * structural.
 *
 * Deterministic: same input always produces the same reason string.
 */
export function coverageDegradationReason(
  summary: LocalCodeIndexCoverageSummary,
): string | null {
  if (
    summary.effective === "ast-grep-structural" &&
    !summary.partial
  ) {
    return null;
  }

  const parts: string[] = [];

  if (summary.effective === "file-inventory-only") {
    parts.push("effective=file-inventory-only");
  } else if (summary.effective === "lexical-reference-fallback") {
    parts.push("effective=lexical-reference-fallback");
  }

  if (summary.partial) {
    parts.push("partial=true");
  }
  if (summary.failedFiles > 0) {
    parts.push(`failedFiles=${summary.failedFiles}`);
  }
  if (summary.oversizedFiles > 0) {
    parts.push(`oversizedFiles=${summary.oversizedFiles}`);
  }

  return parts.join("; ");
}
