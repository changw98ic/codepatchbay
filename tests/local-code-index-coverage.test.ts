/**
 * Tests for core/indexing/local-code-index/coverage.ts
 *
 * Deterministic coverage aggregation: effective level, partial flag,
 * failed/oversized counts, parser absence, merge, and degradation reasons.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateCoverage,
  parserAbsentSummary,
  singleFileSummary,
  mergeCoverageSummaries,
  countOutcomes,
  coverageDegradationReason,
  type FileCoverageOutcome,
} from "../core/indexing/local-code-index/coverage.js";

import type {
  LocalCodeIndexCoverageSummary,
} from "../core/indexing/local-code-index/contracts.js";

// ══════════════════════════════════════════════════════════════════════════════
// 1. aggregateCoverage — basic effective-level derivation
// ══════════════════════════════════════════════════════════════════════════════

test("all files ast-grep-structural => effective=ast-grep-structural, partial=false", () => {
  const s = aggregateCoverage([
    "ast-grep-structural",
    "ast-grep-structural",
    "ast-grep-structural",
  ]);
  assert.equal(s.effective, "ast-grep-structural");
  assert.equal(s.partial, false);
  assert.equal(s.failedFiles, 0);
  assert.equal(s.oversizedFiles, 0);
});

test("all files lexical-reference-fallback => effective=lexical-reference-fallback, partial=false", () => {
  const s = aggregateCoverage([
    "lexical-reference-fallback",
    "lexical-reference-fallback",
  ]);
  assert.equal(s.effective, "lexical-reference-fallback");
  assert.equal(s.partial, false);
});

test("all files file-inventory-only => effective=file-inventory-only, partial=false", () => {
  const s = aggregateCoverage(["file-inventory-only"]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, false);
});

test("weakest level wins: one file-inventory-only among ast-grep-structural", () => {
  const s = aggregateCoverage([
    "ast-grep-structural",
    "ast-grep-structural",
    "file-inventory-only",
  ]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
});

test("weakest level wins: one lexical-reference-fallback among ast-grep-structural", () => {
  const s = aggregateCoverage([
    "ast-grep-structural",
    "lexical-reference-fallback",
    "ast-grep-structural",
  ]);
  assert.equal(s.effective, "lexical-reference-fallback");
  assert.equal(s.partial, true);
});

test("mixed lexical and inventory => effective=file-inventory-only, partial=true", () => {
  const s = aggregateCoverage([
    "lexical-reference-fallback",
    "file-inventory-only",
  ]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. aggregateCoverage — failed and oversized tracking
// ══════════════════════════════════════════════════════════════════════════════

test("failed files count toward failedFiles and make partial=true", () => {
  const s = aggregateCoverage([
    "ast-grep-structural",
    "failed",
    "ast-grep-structural",
  ]);
  assert.equal(s.effective, "ast-grep-structural");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 1);
  assert.equal(s.oversizedFiles, 0);
});

test("oversized files count toward oversizedFiles and make partial=true", () => {
  const s = aggregateCoverage([
    "lexical-reference-fallback",
    "oversized",
    "oversized",
  ]);
  assert.equal(s.effective, "lexical-reference-fallback");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 0);
  assert.equal(s.oversizedFiles, 2);
});

test("mixed failed and oversized both counted", () => {
  const s = aggregateCoverage([
    "file-inventory-only",
    "failed",
    "oversized",
    "failed",
  ]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 2);
  assert.equal(s.oversizedFiles, 1);
});

test("all files failed => effective=file-inventory-only, partial=true", () => {
  const s = aggregateCoverage(["failed", "failed", "failed"]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 3);
  assert.equal(s.oversizedFiles, 0);
});

test("all files oversized => effective=file-inventory-only, partial=true", () => {
  const s = aggregateCoverage(["oversized"]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 0);
  assert.equal(s.oversizedFiles, 1);
});

test("all failed+oversized => effective=file-inventory-only, partial=true", () => {
  const s = aggregateCoverage(["failed", "oversized"]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 1);
  assert.equal(s.oversizedFiles, 1);
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. aggregateCoverage — empty input
// ══════════════════════════════════════════════════════════════════════════════

test("empty outcomes => effective=file-inventory-only, partial=true", () => {
  const s = aggregateCoverage([]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 0);
  assert.equal(s.oversizedFiles, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. parserAbsentSummary
// ══════════════════════════════════════════════════════════════════════════════

test("parserAbsentSummary => file-inventory-only, partial=true", () => {
  const s = parserAbsentSummary(42);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 0);
  assert.equal(s.oversizedFiles, 0);
});

test("parserAbsentSummary with failures and oversized", () => {
  const s = parserAbsentSummary(100, 3, 5);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 3);
  assert.equal(s.oversizedFiles, 5);
});

test("parserAbsentSummary defaults to zero failed/oversized", () => {
  const s = parserAbsentSummary(10);
  assert.equal(s.failedFiles, 0);
  assert.equal(s.oversizedFiles, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. singleFileSummary
// ══════════════════════════════════════════════════════════════════════════════

test("singleFileSummary with ast-grep-structural", () => {
  const s = singleFileSummary("ast-grep-structural");
  assert.equal(s.effective, "ast-grep-structural");
  assert.equal(s.partial, false);
  assert.equal(s.failedFiles, 0);
  assert.equal(s.oversizedFiles, 0);
});

test("singleFileSummary with failed", () => {
  const s = singleFileSummary("failed");
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 1);
});

test("singleFileSummary with oversized", () => {
  const s = singleFileSummary("oversized");
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.oversizedFiles, 1);
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. mergeCoverageSummaries
// ══════════════════════════════════════════════════════════════════════════════

test("merge two identical non-partial summaries => same result", () => {
  const a: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "ast-grep-structural",
    partial: false,
    failedFiles: 0,
    oversizedFiles: 0,
  });
  const b: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "ast-grep-structural",
    partial: false,
    failedFiles: 0,
    oversizedFiles: 0,
  });
  const m = mergeCoverageSummaries(a, b);
  assert.equal(m.effective, "ast-grep-structural");
  assert.equal(m.partial, false);
  assert.equal(m.failedFiles, 0);
  assert.equal(m.oversizedFiles, 0);
});

test("merge weaker into stronger => weaker wins, partial=true", () => {
  const a: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "ast-grep-structural",
    partial: false,
    failedFiles: 0,
    oversizedFiles: 0,
  });
  const b: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "lexical-reference-fallback",
    partial: false,
    failedFiles: 0,
    oversizedFiles: 0,
  });
  const m = mergeCoverageSummaries(a, b);
  assert.equal(m.effective, "lexical-reference-fallback");
  assert.equal(m.partial, true);
});

test("merge sums failed and oversized", () => {
  const a: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "ast-grep-structural",
    partial: true,
    failedFiles: 2,
    oversizedFiles: 1,
  });
  const b: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "ast-grep-structural",
    partial: true,
    failedFiles: 3,
    oversizedFiles: 4,
  });
  const m = mergeCoverageSummaries(a, b);
  assert.equal(m.effective, "ast-grep-structural");
  assert.equal(m.partial, true);
  assert.equal(m.failedFiles, 5);
  assert.equal(m.oversizedFiles, 5);
});

test("merge partial + non-partial => partial", () => {
  const a: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "lexical-reference-fallback",
    partial: false,
    failedFiles: 0,
    oversizedFiles: 0,
  });
  const b: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "lexical-reference-fallback",
    partial: true,
    failedFiles: 0,
    oversizedFiles: 0,
  });
  const m = mergeCoverageSummaries(a, b);
  assert.equal(m.partial, true);
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. countOutcomes
// ══════════════════════════════════════════════════════════════════════════════

test("countOutcomes with all categories", () => {
  const c = countOutcomes([
    "ast-grep-structural",
    "ast-grep-structural",
    "lexical-reference-fallback",
    "file-inventory-only",
    "file-inventory-only",
    "file-inventory-only",
    "failed",
    "oversized",
  ]);
  assert.equal(c.astGrepStructural, 2);
  assert.equal(c.lexicalReferenceFallback, 1);
  assert.equal(c.fileInventoryOnly, 3);
  assert.equal(c.failed, 1);
  assert.equal(c.oversized, 1);
  assert.equal(c.total, 8);
});

test("countOutcomes empty => all zeros", () => {
  const c = countOutcomes([]);
  assert.equal(c.astGrepStructural, 0);
  assert.equal(c.lexicalReferenceFallback, 0);
  assert.equal(c.fileInventoryOnly, 0);
  assert.equal(c.failed, 0);
  assert.equal(c.oversized, 0);
  assert.equal(c.total, 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. coverageDegradationReason
// ══════════════════════════════════════════════════════════════════════════════

test("full structural non-partial => null reason", () => {
  const s: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "ast-grep-structural",
    partial: false,
    failedFiles: 0,
    oversizedFiles: 0,
  });
  assert.equal(coverageDegradationReason(s), null);
});

test("structural but partial => reason mentions partial", () => {
  const s: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "ast-grep-structural",
    partial: true,
    failedFiles: 0,
    oversizedFiles: 0,
  });
  const r = coverageDegradationReason(s);
  assert.notEqual(r, null);
  assert.ok(r!.includes("partial=true"));
});

test("lexical fallback => reason mentions effective level", () => {
  const s: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "lexical-reference-fallback",
    partial: false,
    failedFiles: 0,
    oversizedFiles: 0,
  });
  const r = coverageDegradationReason(s);
  assert.notEqual(r, null);
  assert.ok(r!.includes("effective=lexical-reference-fallback"));
});

test("file-inventory-only with failures => reason includes failedFiles", () => {
  const s: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "file-inventory-only",
    partial: true,
    failedFiles: 5,
    oversizedFiles: 2,
  });
  const r = coverageDegradationReason(s);
  assert.notEqual(r, null);
  assert.ok(r!.includes("effective=file-inventory-only"));
  assert.ok(r!.includes("partial=true"));
  assert.ok(r!.includes("failedFiles=5"));
  assert.ok(r!.includes("oversizedFiles=2"));
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. Frozen output
// ══════════════════════════════════════════════════════════════════════════════

test("aggregateCoverage returns frozen object", () => {
  const s = aggregateCoverage(["ast-grep-structural"]);
  assert.ok(Object.isFrozen(s));
});

test("parserAbsentSummary returns frozen object", () => {
  const s = parserAbsentSummary(5);
  assert.ok(Object.isFrozen(s));
});

test("mergeCoverageSummaries returns frozen object", () => {
  const a: LocalCodeIndexCoverageSummary = Object.freeze({
    effective: "ast-grep-structural",
    partial: false,
    failedFiles: 0,
    oversizedFiles: 0,
  });
  const m = mergeCoverageSummaries(a, a);
  assert.ok(Object.isFrozen(m));
});

test("countOutcomes returns frozen object", () => {
  const c = countOutcomes(["ast-grep-structural"]);
  assert.ok(Object.isFrozen(c));
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. Determinism — same input always produces same output
// ══════════════════════════════════════════════════════════════════════════════

test("deterministic: same outcomes produce identical summary", () => {
  const outcomes: FileCoverageOutcome[] = [
    "ast-grep-structural",
    "lexical-reference-fallback",
    "failed",
    "oversized",
    "file-inventory-only",
  ];
  const first = aggregateCoverage(outcomes);
  const second = aggregateCoverage(outcomes);
  assert.deepStrictEqual(first, second);
});

test("deterministic: order does not matter", () => {
  const a: FileCoverageOutcome[] = [
    "ast-grep-structural",
    "lexical-reference-fallback",
    "failed",
  ];
  const b: FileCoverageOutcome[] = [
    "failed",
    "lexical-reference-fallback",
    "ast-grep-structural",
  ];
  assert.deepStrictEqual(aggregateCoverage(a), aggregateCoverage(b));
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. Edge: single outcome categories
// ══════════════════════════════════════════════════════════════════════════════

test("single ast-grep-structural => non-partial", () => {
  const s = aggregateCoverage(["ast-grep-structural"]);
  assert.equal(s.effective, "ast-grep-structural");
  assert.equal(s.partial, false);
});

test("single lexical-reference-fallback => non-partial", () => {
  const s = aggregateCoverage(["lexical-reference-fallback"]);
  assert.equal(s.effective, "lexical-reference-fallback");
  assert.equal(s.partial, false);
});

test("single file-inventory-only => non-partial", () => {
  const s = aggregateCoverage(["file-inventory-only"]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, false);
});

test("single failed => partial, effective=file-inventory-only", () => {
  const s = aggregateCoverage(["failed"]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.failedFiles, 1);
});

test("single oversized => partial, effective=file-inventory-only", () => {
  const s = aggregateCoverage(["oversized"]);
  assert.equal(s.effective, "file-inventory-only");
  assert.equal(s.partial, true);
  assert.equal(s.oversizedFiles, 1);
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. Parser-absence scenario: degraded but still counting
// ══════════════════════════════════════════════════════════════════════════════

test("parser absence with per-file failures matches aggregateCoverage of all-inventory", () => {
  // When parser is absent, every file is file-inventory-only.
  // If 2 of 10 files also fail I/O, the summary should match.
  const fromParser = parserAbsentSummary(10, 2, 0);
  const fromOutcomes = aggregateCoverage([
    ...Array(8).fill("file-inventory-only") as FileCoverageOutcome[],
    "failed",
    "failed",
  ]);
  assert.deepStrictEqual(fromParser, fromOutcomes);
});

test("parser absence with oversized matches aggregateCoverage", () => {
  const fromParser = parserAbsentSummary(5, 0, 1);
  const fromOutcomes = aggregateCoverage([
    ...Array(4).fill("file-inventory-only") as FileCoverageOutcome[],
    "oversized",
  ]);
  assert.deepStrictEqual(fromParser, fromOutcomes);
});
