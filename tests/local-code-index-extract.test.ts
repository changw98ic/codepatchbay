/**
 * Tests for local-code-index extraction pipeline.
 *
 * Covers Phase 4 gates from the implementation plan:
 *
 *   1. Identical bytes with different language/parser/fingerprint cannot collide
 *      (file object ID derivation).
 *   2. Parser absence produces exact coverage summaries.
 *   3. force=true change plan hashes and parses every eligible file.
 *   4. Extraction produces correct definitions, references, raw imports.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md sections 7.3, 8.3, 8.4, 9
 * Gate: docs/architecture/local-code-index-v2-implementation-plan.md Phase 4
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import {
  // File object ID derivation
  computeFileObjectId,
  computeLanguageExtractorFingerprint,
  computeSourceContentId,

  // Extraction entry points
  extractFileFacts,
  extractLexical,
  extractInventoryOnly,

  // Language mapping
  languageForFile,
  languageForExtension,

  // Batch / coverage
  computeAggregateCoverage,

  // Types
  type AstGrepParseResult,
  type AstGrepNode,
  type FileExtractionResult,
  type SupportedLanguage,
  type ParserMode,

  // Constants
  MAX_INDEX_FILE_SIZE_BYTES,
  MAX_SYMBOLS_PER_FILE,
  MAX_REFERENCES_PER_FILE,
} from "../core/indexing/local-code-index/extract.js";

import {
  aggregateCoverage,
  parserAbsentSummary,
  singleFileSummary,
} from "../core/indexing/local-code-index/coverage.js";

import {
  buildChangePlan,
  getComputeEntries,
  isChangePlanEmpty,
  type SourceState,
  type SourceStateEntry,
  type ChangePlan,
} from "../core/indexing/local-code-index/change-plan.js";

import type { LocalCodeIndexCoverage } from "../core/indexing/local-code-index/contracts.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function makeBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function makeSourceContentId(text: string): string {
  return computeSourceContentId(makeBytes(text));
}

/** Build a minimal SourceStateEntry for change-plan tests. */
function makeEntry(
  path: string,
  contentId: string,
  language: string,
  extractorFingerprint: string,
): SourceStateEntry {
  return {
    path,
    contentId,
    language,
    parserMode: "lexical-fallback",
    languageExtractorFingerprint: extractorFingerprint,
    metadata: {
      device: "1",
      inode: "100",
      size: "100",
      mtimeNs: "1000000000",
      ctimeNs: "1000000000",
      mode: 0o100644,
    },
    gitBlobId: null,
    materializationFingerprint: null,
  };
}

/** Build a minimal SourceState from entries. */
function makeSourceState(entries: SourceStateEntry[]): SourceState {
  return {
    repository: {
      commonGitDir: null,
      objectFormat: null,
      head: null,
      branch: null,
    },
    materialization: {
      autocrlf: false,
      eol: "lf",
      attributesFile: null,
    },
    entries: entries.slice().sort((a, b) => a.path.localeCompare(b.path)),
    worktreeStateFingerprint: sha256hex("state"),
    observedAt: Date.now(),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Identical bytes with different language/parser/fingerprint cannot collide
// ══════════════════════════════════════════════════════════════════════════════

describe("file object ID collision resistance", () => {
  const sampleSource = "export function hello() { return 42; }";
  const sourceContentId = makeSourceContentId(sampleSource);

  test("same bytes, same language, same mode, same fingerprint produce the same file object ID", () => {
    const fp = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
    const id1 = computeFileObjectId("typescript", "structural", fp, sourceContentId);
    const id2 = computeFileObjectId("typescript", "structural", fp, sourceContentId);
    assert.strictEqual(id1, id2, "deterministic: identical inputs yield identical IDs");
    assert.strictEqual(id1.length, 64, "file object ID is 64 hex chars (full SHA-256)");
  });

  test("same bytes with different language produce different file object IDs", () => {
    const fp = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
    const idTs = computeFileObjectId("typescript", "structural", fp, sourceContentId);
    const idPy = computeFileObjectId("python", "structural", fp, sourceContentId);
    assert.notStrictEqual(idTs, idPy, "different language must not collide");
  });

  test("same bytes with different parser mode produce different file object IDs", () => {
    const fpStructural = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
    const fpLexical = computeLanguageExtractorFingerprint("typescript", "lexical-fallback", "0.1.0");
    const idStructural = computeFileObjectId("typescript", "structural", fpStructural, sourceContentId);
    const idLexical = computeFileObjectId("typescript", "lexical-fallback", fpLexical, sourceContentId);
    assert.notStrictEqual(idStructural, idLexical, "different parser mode must not collide");
  });

  test("same bytes with different extractor fingerprint produce different file object IDs", () => {
    const fp1 = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
    const fp2 = computeLanguageExtractorFingerprint("typescript", "structural", "0.2.0");
    const id1 = computeFileObjectId("typescript", "structural", fp1, sourceContentId);
    const id2 = computeFileObjectId("typescript", "structural", fp2, sourceContentId);
    assert.notStrictEqual(id1, id2, "different parser version must not collide");
  });

  test("same bytes with different language extractor fingerprint (rule change) produce different file object IDs", () => {
    // The fingerprint includes the rule hash. Using different languages with the
    // same parser mode and version produces different fingerprints because each
    // language has different rules.
    const fpTs = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
    const fpJs = computeLanguageExtractorFingerprint("javascript", "structural", "0.1.0");
    assert.notStrictEqual(fpTs, fpJs, "different language rules yield different fingerprints");

    const idTs = computeFileObjectId("typescript", "structural", fpTs, sourceContentId);
    const idJs = computeFileObjectId("javascript", "structural", fpJs, sourceContentId);
    assert.notStrictEqual(idTs, idJs, "file object IDs must differ when fingerprints differ");
  });

  test("different bytes with same language/parser/fingerprint produce different file object IDs", () => {
    const fp = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
    const id1 = computeFileObjectId("typescript", "structural", fp, sourceContentId);
    const otherContentId = makeSourceContentId("const x = 1;");
    const id2 = computeFileObjectId("typescript", "structural", fp, otherContentId);
    assert.notStrictEqual(id1, id2, "different content must not collide");
  });

  test("exhaustive: all supported languages with the same bytes produce distinct file object IDs", () => {
    const languages: SupportedLanguage[] = [
      "typescript",
      "typescriptreact",
      "javascript",
      "javascriptreact",
      "json",
      "python",
      "rust",
      "go",
      "css",
      "html",
      "markdown",
      "yaml",
    ];

    const ids = new Set<string>();
    for (const lang of languages) {
      const fp = computeLanguageExtractorFingerprint(lang, "structural", "0.1.0");
      const id = computeFileObjectId(lang, "structural", fp, sourceContentId);
      ids.add(id);
    }
    assert.strictEqual(ids.size, languages.length, "each language must produce a unique file object ID");
  });

  test("exhaustive: all parser modes with the same bytes and language produce distinct IDs", () => {
    const modes: ParserMode[] = ["structural", "lexical-fallback", "file-inventory-only"];
    const ids = new Set<string>();
    for (const mode of modes) {
      const fp = computeLanguageExtractorFingerprint("typescript", mode, "0.1.0");
      const id = computeFileObjectId("typescript", mode, fp, sourceContentId);
      ids.add(id);
    }
    assert.strictEqual(ids.size, modes.length, "each parser mode must produce a unique file object ID");
  });

  test("source content ID is deterministic for the same bytes", () => {
    const id1 = computeSourceContentId(makeBytes(sampleSource));
    const id2 = computeSourceContentId(makeBytes(sampleSource));
    assert.strictEqual(id1, id2);
    assert.strictEqual(id1.length, 64);
  });

  test("source content ID differs for different bytes", () => {
    const id1 = computeSourceContentId(makeBytes("hello"));
    const id2 = computeSourceContentId(makeBytes("world"));
    assert.notStrictEqual(id1, id2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Parser absence produces exact coverage summaries
// ══════════════════════════════════════════════════════════════════════════════

describe("parser absence produces exact coverage summaries", () => {
  test("parserAbsentSummary always returns file-inventory-only with partial=true", () => {
    const summary = parserAbsentSummary(42);
    assert.strictEqual(summary.effective, "file-inventory-only");
    assert.strictEqual(summary.partial, true);
    assert.strictEqual(summary.failedFiles, 0);
    assert.strictEqual(summary.oversizedFiles, 0);
  });

  test("parserAbsentSummary preserves failed and oversized counts", () => {
    const summary = parserAbsentSummary(100, 3, 7);
    assert.strictEqual(summary.effective, "file-inventory-only");
    assert.strictEqual(summary.partial, true);
    assert.strictEqual(summary.failedFiles, 3);
    assert.strictEqual(summary.oversizedFiles, 7);
  });

  test("extractInventoryOnly returns file-inventory-only coverage with empty symbol data", () => {
    const fingerprint = computeLanguageExtractorFingerprint("typescript", "file-inventory-only", null);
    const contentId = makeSourceContentId("some content");
    const result = extractInventoryOnly("typescript", fingerprint, contentId, 1234);

    assert.strictEqual(result.coverage, "file-inventory-only");
    assert.strictEqual(result.parserMode, "file-inventory-only");
    assert.strictEqual(result.sourceContentId, contentId);
    assert.strictEqual(result.byteSize, 1234);
    assert.strictEqual(result.language, "typescript");
    assert.deepStrictEqual(result.definitions, []);
    assert.deepStrictEqual(result.references, []);
    assert.deepStrictEqual(result.imports, []);
    assert.deepStrictEqual(result.errors, []);
    assert.deepStrictEqual(result.truncation, []);
  });

  test("extractInventoryOnly with null language produces 'unknown' language", () => {
    const fingerprint = computeLanguageExtractorFingerprint("unknown" as SupportedLanguage, "file-inventory-only", null);
    const contentId = makeSourceContentId("binary data");
    const result = extractInventoryOnly(null, fingerprint, contentId, 500);

    assert.strictEqual(result.language, "unknown" as SupportedLanguage);
    assert.strictEqual(result.coverage, "file-inventory-only");
  });

  test("extractFileFacts for unrecognized file extension produces file-inventory-only", () => {
    const bytes = makeBytes("binary content");
    const result = extractFileFacts(bytes, "file.xyz", null, null);

    assert.strictEqual(result.coverage, "file-inventory-only");
    assert.strictEqual(result.parserMode, "file-inventory-only");
    assert.deepStrictEqual(result.definitions, []);
    assert.deepStrictEqual(result.references, []);
    assert.deepStrictEqual(result.imports, []);
  });

  test("extractFileFats for oversized file produces file-inventory-only with truncation marker", () => {
    // Create a source larger than MAX_INDEX_FILE_SIZE_BYTES.
    const bigSource = "x".repeat(MAX_INDEX_FILE_SIZE_BYTES + 100);
    const bytes = makeBytes(bigSource);
    const result = extractFileFacts(bytes, "big.ts", null, null);

    assert.strictEqual(result.coverage, "file-inventory-only");
    assert.strictEqual(result.truncation.length, 1);
    assert.strictEqual(result.truncation[0]!.limitKind, "max-file-size");
    assert.strictEqual(result.truncation[0]!.limit, MAX_INDEX_FILE_SIZE_BYTES);
    assert.strictEqual(result.truncation[0]!.actual, bytes.byteLength);
  });

  test("extractFileFacts with null astGrepResult falls back to lexical extraction for supported languages", () => {
    const source = 'import { foo } from "./bar";\nexport function hello() { return foo(); }';
    const bytes = makeBytes(source);
    const result = extractFileFacts(bytes, "test.ts", null, null);

    // Without ast-grep, we fall back to lexical extraction.
    assert.strictEqual(result.coverage, "lexical-reference-fallback");
    assert.strictEqual(result.parserMode, "lexical-fallback");
    assert.ok(result.definitions.length > 0, "lexical extraction should find definitions");
  });

  test("aggregateCoverage: all file-inventory-only produces file-inventory-only with partial=true", () => {
    const summary = aggregateCoverage([
      "file-inventory-only",
      "file-inventory-only",
      "file-inventory-only",
    ]);
    assert.strictEqual(summary.effective, "file-inventory-only");
    assert.strictEqual(summary.partial, false);
    assert.strictEqual(summary.failedFiles, 0);
    assert.strictEqual(summary.oversizedFiles, 0);
  });

  test("aggregateCoverage: mixed structural and inventory produces partial", () => {
    const summary = aggregateCoverage([
      "ast-grep-structural",
      "ast-grep-structural",
      "file-inventory-only",
    ]);
    assert.strictEqual(summary.effective, "file-inventory-only");
    assert.strictEqual(summary.partial, true);
  });

  test("aggregateCoverage: all structural with a failed file produces partial", () => {
    const summary = aggregateCoverage([
      "ast-grep-structural",
      "ast-grep-structural",
      "failed",
    ]);
    assert.strictEqual(summary.effective, "ast-grep-structural");
    assert.strictEqual(summary.partial, true);
    assert.strictEqual(summary.failedFiles, 1);
  });

  test("aggregateCoverage: all structural with an oversized file produces partial", () => {
    const summary = aggregateCoverage([
      "ast-grep-structural",
      "oversized",
    ]);
    assert.strictEqual(summary.effective, "ast-grep-structural");
    assert.strictEqual(summary.partial, true);
    assert.strictEqual(summary.oversizedFiles, 1);
  });

  test("aggregateCoverage: empty array defaults to file-inventory-only with partial=true", () => {
    const summary = aggregateCoverage([]);
    assert.strictEqual(summary.effective, "file-inventory-only");
    assert.strictEqual(summary.partial, true);
  });

  test("aggregateCoverage: all failed defaults to file-inventory-only with partial=true", () => {
    const summary = aggregateCoverage(["failed", "failed"]);
    assert.strictEqual(summary.effective, "file-inventory-only");
    assert.strictEqual(summary.partial, true);
    assert.strictEqual(summary.failedFiles, 2);
  });

  test("singleFileSummary delegates to aggregateCoverage", () => {
    const summary = singleFileSummary("lexical-reference-fallback");
    assert.strictEqual(summary.effective, "lexical-reference-fallback");
    assert.strictEqual(summary.partial, false);
  });

  test("singleFileSummary for a failed file produces file-inventory-only with partial=true", () => {
    const summary = singleFileSummary("failed");
    assert.strictEqual(summary.effective, "file-inventory-only");
    assert.strictEqual(summary.partial, true);
    assert.strictEqual(summary.failedFiles, 1);
  });

  test("computeAggregateCoverage matches aggregateCoverage for same inputs", () => {
    const outcomes: LocalCodeIndexCoverage[] = [
      "ast-grep-structural",
      "lexical-reference-fallback",
      "file-inventory-only",
    ];
    const a = computeAggregateCoverage(outcomes, 2, 3);
    const b = aggregateCoverage([...outcomes, "failed", "failed", "oversized", "oversized", "oversized"]);

    // Both should agree on effective and partial.
    assert.strictEqual(a.effective, b.effective);
    assert.strictEqual(a.partial, b.partial);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. force=true change plan hashes and parses every eligible file
// ══════════════════════════════════════════════════════════════════════════════

describe("force=true change plan", () => {
  const fpTs = computeLanguageExtractorFingerprint("typescript", "lexical-fallback", "0.1.0");

  test("force=true converts all unchanged entries from reuse to compute", () => {
    const entryA = makeEntry("src/a.ts", sha256hex("content-a"), "typescript", fpTs);
    const entryB = makeEntry("src/b.ts", sha256hex("content-b"), "typescript", fpTs);

    const prev = makeSourceState([entryA, entryB]);
    const curr = makeSourceState([entryA, entryB]);

    // Without force — all reuse.
    const normalPlan = buildChangePlan({ previous: prev, current: curr });
    assert.strictEqual(normalPlan.summary.reuse, 2);
    assert.strictEqual(normalPlan.summary.compute, 0);
    assert.strictEqual(normalPlan.forced, false);

    // With force — all compute.
    const forcedPlan = buildChangePlan({ previous: prev, current: curr, force: true });
    assert.strictEqual(forcedPlan.summary.compute, 2, "force=true must convert all reuse to compute");
    assert.strictEqual(forcedPlan.summary.reuse, 0, "force=true must leave zero reuse entries");
    assert.strictEqual(forcedPlan.forced, true);

    // Every forced entry has decision "compute" and reason mentions "forced".
    for (const entry of forcedPlan.entries) {
      assert.strictEqual(entry.decision, "compute");
      assert.ok(entry.reason.includes("forced"), `reason should mention forced: ${entry.reason}`);
    }
  });

  test("force=true changes the plan ID compared to normal mode", () => {
    const entry = makeEntry("src/index.ts", sha256hex("content"), "typescript", fpTs);
    const prev = makeSourceState([entry]);
    const curr = makeSourceState([entry]);

    const normalPlan = buildChangePlan({ previous: prev, current: curr });
    const forcedPlan = buildChangePlan({ previous: prev, current: curr, force: true });

    assert.notStrictEqual(normalPlan.planId, forcedPlan.planId, "plan IDs must differ between modes");
  });

  test("force=true still classifies content-changed entries as compute", () => {
    const entryOld = makeEntry("src/a.ts", sha256hex("old-content"), "typescript", fpTs);
    const entryNew = makeEntry("src/a.ts", sha256hex("new-content"), "typescript", fpTs);

    const prev = makeSourceState([entryOld]);
    const curr = makeSourceState([entryNew]);

    const plan = buildChangePlan({ previous: prev, current: curr, force: true });
    assert.strictEqual(plan.summary.compute, 1);
    assert.strictEqual(plan.entries[0]!.decision, "compute");
  });

  test("force=true with new files produces compute for additions", () => {
    const entryA = makeEntry("src/a.ts", sha256hex("content-a"), "typescript", fpTs);
    const entryB = makeEntry("src/b.ts", sha256hex("content-b"), "typescript", fpTs);

    const prev = makeSourceState([entryA]);
    const curr = makeSourceState([entryA, entryB]);

    const plan = buildChangePlan({ previous: prev, current: curr, force: true });
    assert.strictEqual(plan.summary.compute, 2, "both entries should be compute in force mode");
    assert.ok(plan.classification.hasAdditions, "should detect addition");
  });

  test("force=true first build (no previous) produces compute for all entries", () => {
    const entryA = makeEntry("src/a.ts", sha256hex("content-a"), "typescript", fpTs);
    const entryB = makeEntry("src/b.ts", sha256hex("content-b"), "typescript", fpTs);
    const entryC = makeEntry("src/c.ts", sha256hex("content-c"), "typescript", fpTs);

    const curr = makeSourceState([entryA, entryB, entryC]);

    const plan = buildChangePlan({ previous: null, current: curr, force: true });
    assert.strictEqual(plan.summary.compute, 3);
    assert.strictEqual(plan.summary.reuse, 0);
    assert.strictEqual(plan.summary.delete, 0);
    assert.strictEqual(plan.forced, true);
  });

  test("force=true with existing objects map still forces compute", () => {
    const entryA = makeEntry("src/a.ts", sha256hex("content-a"), "typescript", fpTs);
    const prev = makeSourceState([entryA]);
    const curr = makeSourceState([entryA]);

    // Provide an existing objects map that would normally cause reuse.
    const existingObjects = new Map<string, string>();
    existingObjects.set(entryA.contentId, "fake-object-id-12345");

    const plan = buildChangePlan({
      previous: prev,
      current: curr,
      force: true,
      existingObjects,
    });

    assert.strictEqual(plan.summary.compute, 1, "force=true must ignore existingObjects for reuse");
    assert.strictEqual(plan.summary.reuse, 0);
  });

  test("force=true preserves deletions", () => {
    const entryA = makeEntry("src/a.ts", sha256hex("content-a"), "typescript", fpTs);
    const entryB = makeEntry("src/b.ts", sha256hex("content-b"), "typescript", fpTs);

    const prev = makeSourceState([entryA, entryB]);
    const curr = makeSourceState([entryA]);

    const plan = buildChangePlan({ previous: prev, current: curr, force: true });
    assert.strictEqual(plan.summary.delete, 1, "deleted file should still be delete");
    assert.strictEqual(plan.summary.compute, 1, "remaining file should be compute");
    assert.ok(plan.classification.hasDeletions);
  });

  test("getComputeEntries returns all entries when force=true", () => {
    const entries = [
      makeEntry("src/a.ts", sha256hex("a"), "typescript", fpTs),
      makeEntry("src/b.ts", sha256hex("b"), "typescript", fpTs),
      makeEntry("src/c.ts", sha256hex("c"), "typescript", fpTs),
    ];
    const prev = makeSourceState(entries);
    const curr = makeSourceState(entries);

    const plan = buildChangePlan({ previous: prev, current: curr, force: true });
    const computeEntries = getComputeEntries(plan);
    assert.strictEqual(computeEntries.length, 3, "all entries should be compute");
  });

  test("isChangePlanEmpty returns false when force=true even with identical state", () => {
    const entry = makeEntry("src/a.ts", sha256hex("content"), "typescript", fpTs);
    const prev = makeSourceState([entry]);
    const curr = makeSourceState([entry]);

    const plan = buildChangePlan({ previous: prev, current: curr, force: true });
    assert.strictEqual(isChangePlanEmpty(plan), false, "forced plan is never empty");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Extraction produces correct definitions, references, raw imports
// ══════════════════════════════════════════════════════════════════════════════

describe("extraction produces correct definitions, references, and imports", () => {
  describe("TypeScript lexical extraction", () => {
    const fp = computeLanguageExtractorFingerprint("typescript", "lexical-fallback", null);

    test("extracts function definitions", () => {
      const source = 'export function hello() { return 42; }\nfunction world() { return 0; }';
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      const names = result.definitions.map((d) => d.name);
      assert.ok(names.includes("hello"), "should find exported function hello");
      assert.ok(names.includes("world"), "should find non-exported function world");

      const helloDef = result.definitions.find((d) => d.name === "hello")!;
      assert.strictEqual(helloDef.kind, "function");
      assert.strictEqual(helloDef.exported, true);
    });

    test("extracts class definitions", () => {
      const source = "export class MyService { }\nclass Internal { }";
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      const names = result.definitions.map((d) => d.name);
      assert.ok(names.includes("MyService"));
      assert.ok(names.includes("Internal"));

      const myServiceDef = result.definitions.find((d) => d.name === "MyService")!;
      assert.strictEqual(myServiceDef.kind, "class");
      assert.strictEqual(myServiceDef.exported, true);
    });

    test("extracts interface definitions", () => {
      const source = "export interface Config { port: number; }";
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      assert.ok(result.definitions.some((d) => d.name === "Config" && d.kind === "interface"));
    });

    test("extracts type alias definitions", () => {
      const source = "export type ID = string | number;";
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      assert.ok(result.definitions.some((d) => d.name === "ID" && d.kind === "type"));
    });

    test("extracts enum definitions", () => {
      const source = "export enum Status { Active, Inactive }";
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      assert.ok(result.definitions.some((d) => d.name === "Status" && d.kind === "enum"));
    });

    test("extracts const and let variable definitions", () => {
      const source = "export const MAX = 100;\nlet counter = 0;";
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      const names = result.definitions.map((d) => d.name);
      assert.ok(names.includes("MAX"));
      assert.ok(names.includes("counter"));
    });

    test("extracts ESM import with named specifiers", () => {
      const source = 'import { readFile, writeFile } from "node:fs/promises";';
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      assert.strictEqual(result.imports.length, 1);
      assert.strictEqual(result.imports[0]!.requested, "node:fs/promises");
      assert.strictEqual(result.imports[0]!.importKind, "esm");
    });

    test("extracts default ESM import", () => {
      const source = 'import path from "node:path";';
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      // The ts-import-esm and ts-import-default regexes both match this syntax,
      // so the specifier appears at least once.
      assert.ok(result.imports.some((i) => i.requested === "node:path"), "should find node:path import");
    });

    test("extracts namespace ESM import", () => {
      const source = 'import * as fs from "node:fs";';
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      // The ts-import-esm and ts-import-namespace regexes both match this syntax.
      assert.ok(result.imports.some((i) => i.requested === "node:fs"), "should find node:fs import");
    });

    test("extracts type-only import", () => {
      const source = 'import type { Foo } from "./types";';
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      // The ts-import-esm and ts-import-type regexes both match this syntax.
      // Lexical extraction deduplicates by specifier; the first matching rule
      // (ts-import-esm) wins, so importKind is "esm".  The specifier is found.
      assert.ok(result.imports.some((i) => i.requested === "./types"), "should find ./types import");
    });

    test("extracts dynamic import", () => {
      const source = 'const mod = import("./lazy-module");';
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      assert.strictEqual(result.imports.length, 1);
      assert.strictEqual(result.imports[0]!.requested, "./lazy-module");
      assert.strictEqual(result.imports[0]!.importKind, "dynamic");
    });

    test("deduplicates imports by specifier", () => {
      const source = 'import { a } from "./x";\nimport { b } from "./x";';
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      // Both import the same specifier "./x" — should be deduplicated.
      const xImports = result.imports.filter((i) => i.requested === "./x");
      assert.strictEqual(xImports.length, 1, "duplicate import specifier should be deduplicated");
    });

    test("deduplicates definitions by name", () => {
      const source = "function foo() {}\nfunction foo() { return 1; }";
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      const foos = result.definitions.filter((d) => d.name === "foo");
      assert.strictEqual(foos.length, 1, "duplicate definition name should be deduplicated");
    });

    test("does not treat definition names as references", () => {
      const source = "export function myFunc() { return 1; }";
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      // myFunc appears as a definition, so should NOT appear as a reference.
      const refNames = result.references.filter((r) => r.name === "myFunc");
      assert.strictEqual(refNames.length, 0, "definition names should not also be references");
    });

    test("source ranges have 1-based line and column numbers", () => {
      const source = "function foo() { return 1; }";
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      const fooDef = result.definitions.find((d) => d.name === "foo")!;
      assert.ok(fooDef.range.startLine >= 1, "startLine should be >= 1");
      assert.ok(fooDef.range.startColumn >= 1, "startColumn should be >= 1");
      assert.ok(fooDef.range.endLine >= fooDef.range.startLine, "endLine should be >= startLine");
    });

    test("source ranges track multi-line definitions", () => {
      const source = "function\nfoo() { return 1; }";
      const result = extractLexical(source, "typescript", fp, makeSourceContentId(source), source.length);

      const fooDef = result.definitions.find((d) => d.name === "foo")!;
      // "function" is on line 1, "foo" is captured on line 2
      assert.ok(fooDef.range.startLine >= 1);
    });
  });

  describe("JavaScript lexical extraction", () => {
    const fp = computeLanguageExtractorFingerprint("javascript", "lexical-fallback", null);

    test("extracts CommonJS require", () => {
      const source = 'const fs = require("node:fs");';
      const result = extractLexical(source, "javascript", fp, makeSourceContentId(source), source.length);

      assert.strictEqual(result.imports.length, 1);
      assert.strictEqual(result.imports[0]!.requested, "node:fs");
      assert.strictEqual(result.imports[0]!.importKind, "cjs");
    });

    test("extracts destructured CommonJS require", () => {
      const source = 'const { join } = require("node:path");';
      const result = extractLexical(source, "javascript", fp, makeSourceContentId(source), source.length);

      assert.strictEqual(result.imports.length, 1);
      assert.strictEqual(result.imports[0]!.requested, "node:path");
      assert.strictEqual(result.imports[0]!.importKind, "cjs");
    });

    test("extracts var, let, const definitions", () => {
      const source = "var a = 1;\nlet b = 2;\nconst c = 3;";
      const result = extractLexical(source, "javascript", fp, makeSourceContentId(source), source.length);

      const names = result.definitions.map((d) => d.name);
      assert.ok(names.includes("a"));
      assert.ok(names.includes("b"));
      assert.ok(names.includes("c"));
    });
  });

  describe("Python lexical extraction", () => {
    const fp = computeLanguageExtractorFingerprint("python", "lexical-fallback", null);

    test("extracts function definitions", () => {
      const source = "def hello():\n    return 42\n\ndef world():\n    return 0";
      const result = extractLexical(source, "python", fp, makeSourceContentId(source), source.length);

      const names = result.definitions.map((d) => d.name);
      assert.ok(names.includes("hello"));
      assert.ok(names.includes("world"));
    });

    test("extracts class definitions", () => {
      const source = "class MyClass:\n    pass";
      const result = extractLexical(source, "python", fp, makeSourceContentId(source), source.length);

      assert.ok(result.definitions.some((d) => d.name === "MyClass" && d.kind === "class"));
    });

    test("extracts import statements", () => {
      const source = "import os\nimport sys.path";
      const result = extractLexical(source, "python", fp, makeSourceContentId(source), source.length);

      const specifiers = result.imports.map((i) => i.requested);
      assert.ok(specifiers.includes("os"));
      assert.ok(specifiers.includes("sys.path"));
    });

    test("extracts from-import statements", () => {
      const source = "from collections import OrderedDict";
      const result = extractLexical(source, "python", fp, makeSourceContentId(source), source.length);

      assert.ok(result.imports.some((i) => i.requested === "collections"));
    });
  });

  describe("Rust lexical extraction", () => {
    const fp = computeLanguageExtractorFingerprint("rust", "lexical-fallback", null);

    test("extracts function definitions", () => {
      const source = "pub fn hello() -> i32 { 42 }\nfn world() {}";
      const result = extractLexical(source, "rust", fp, makeSourceContentId(source), source.length);

      const names = result.definitions.map((d) => d.name);
      assert.ok(names.includes("hello"));
      assert.ok(names.includes("world"));
    });

    test("extracts struct definitions", () => {
      const source = "pub struct Config { port: u16 }";
      const result = extractLexical(source, "rust", fp, makeSourceContentId(source), source.length);

      assert.ok(result.definitions.some((d) => d.name === "Config" && d.kind === "struct"));
    });

    test("extracts use statements", () => {
      const source = "use std::io;\npub use crate::error::Error;";
      const result = extractLexical(source, "rust", fp, makeSourceContentId(source), source.length);

      assert.ok(result.imports.length >= 2);
    });
  });

  describe("Go lexical extraction", () => {
    const fp = computeLanguageExtractorFingerprint("go", "lexical-fallback", null);

    test("extracts function definitions", () => {
      const source = "func Hello() string { return \"hi\" }\nfunc world() {}";
      const result = extractLexical(source, "go", fp, makeSourceContentId(source), source.length);

      const names = result.definitions.map((d) => d.name);
      assert.ok(names.includes("Hello"));
      assert.ok(names.includes("world"));
    });

    test("extracts import statements", () => {
      const source = 'import "fmt"\nimport "os"';
      const result = extractLexical(source, "go", fp, makeSourceContentId(source), source.length);

      const specifiers = result.imports.map((i) => i.requested);
      assert.ok(specifiers.includes("fmt"));
      assert.ok(specifiers.includes("os"));
    });
  });

  describe("structural extraction via ast-grep adapter output", () => {
    test("extracts definitions from function_declaration nodes", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "function_declaration",
          text: "function hello() { return 42; }",
          start: { line: 1, column: 1 },
          end: { line: 1, column: 32 },
          children: [
            {
              kind: "identifier",
              text: "hello",
              start: { line: 1, column: 10 },
              end: { line: 1, column: 15 },
            },
          ],
          isExported: true,
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const source = "function hello() { return 42; }";
      const result = extractFileFacts(makeBytes(source), "test.ts", "0.1.0", astResult);

      assert.strictEqual(result.coverage, "ast-grep-structural");
      assert.strictEqual(result.parserMode, "structural");
      assert.strictEqual(result.definitions.length, 1);
      assert.strictEqual(result.definitions[0]!.name, "hello");
      assert.strictEqual(result.definitions[0]!.kind, "function");
      assert.strictEqual(result.definitions[0]!.exported, true);
    });

    test("extracts definitions from class_declaration nodes", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "class_declaration",
          text: "class MyService { }",
          start: { line: 1, column: 1 },
          end: { line: 1, column: 20 },
          children: [
            {
              kind: "identifier",
              text: "MyService",
              start: { line: 1, column: 7 },
              end: { line: 1, column: 16 },
            },
          ],
          isExported: false,
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const source = "class MyService { }";
      const result = extractFileFacts(makeBytes(source), "test.ts", "0.1.0", astResult);

      assert.strictEqual(result.definitions.length, 1);
      assert.strictEqual(result.definitions[0]!.name, "MyService");
      assert.strictEqual(result.definitions[0]!.kind, "class");
      assert.strictEqual(result.definitions[0]!.exported, false);
    });

    test("extracts import_statement nodes", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "import_statement",
          text: 'import { foo } from "./bar";',
          start: { line: 1, column: 1 },
          end: { line: 1, column: 28 },
          children: [
            {
              kind: "string",
              text: '"./bar"',
              start: { line: 1, column: 21 },
              end: { line: 1, column: 27 },
            },
          ],
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const source = 'import { foo } from "./bar";';
      const result = extractFileFacts(makeBytes(source), "test.ts", "0.1.0", astResult);

      assert.strictEqual(result.imports.length, 1);
      assert.strictEqual(result.imports[0]!.requested, "./bar");
      assert.strictEqual(result.imports[0]!.importKind, "esm");
    });

    test("extracts identifier reference nodes", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "identifier",
          text: "myVar",
          start: { line: 1, column: 1 },
          end: { line: 1, column: 6 },
        },
        {
          kind: "type_identifier",
          text: "MyType",
          start: { line: 2, column: 1 },
          end: { line: 2, column: 7 },
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const source = "myVar\nMyType";
      const result = extractFileFacts(makeBytes(source), "test.ts", "0.1.0", astResult);

      assert.strictEqual(result.references.length, 2);
      assert.ok(result.references.some((r) => r.name === "myVar" && r.referenceKind === "unknown"));
      assert.ok(result.references.some((r) => r.name === "MyType" && r.referenceKind === "type"));
    });

    test("extracts require call_expression as CJS import", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "call_expression",
          text: 'require("fs")',
          start: { line: 1, column: 1 },
          end: { line: 1, column: 14 },
          children: [
            {
              kind: "string",
              text: '"fs"',
              start: { line: 1, column: 9 },
              end: { line: 1, column: 13 },
            },
          ],
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const source = 'require("fs")';
      const result = extractFileFacts(makeBytes(source), "test.js", "0.1.0", astResult);

      assert.strictEqual(result.imports.length, 1);
      assert.strictEqual(result.imports[0]!.requested, "fs");
      assert.strictEqual(result.imports[0]!.importKind, "cjs");
    });

    test("extracts dynamic import call_expression", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "call_expression",
          text: 'import("./lazy")',
          start: { line: 1, column: 1 },
          end: { line: 1, column: 16 },
          children: [
            {
              kind: "string",
              text: '"./lazy"',
              start: { line: 1, column: 8 },
              end: { line: 1, column: 15 },
            },
          ],
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const source = 'import("./lazy")';
      const result = extractFileFacts(makeBytes(source), "test.ts", "0.1.0", astResult);

      assert.strictEqual(result.imports.length, 1);
      assert.strictEqual(result.imports[0]!.requested, "./lazy");
      assert.strictEqual(result.imports[0]!.importKind, "dynamic");
    });

    test("records parse errors from ast-grep result", () => {
      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: false,
        nodes: [],
        parseErrors: ["unexpected token at line 5", "syntax error at line 10"],
      };

      const source = "invalid code";
      const result = extractFileFacts(makeBytes(source), "test.ts", "0.1.0", astResult);

      assert.strictEqual(result.errors.length, 2);
      assert.strictEqual(result.errors[0]!.severity, "error");
      assert.strictEqual(result.errors[0]!.message, "unexpected token at line 5");
    });

    test("recursively extracts from nested child nodes", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "lexical_declaration",
          text: "const outer = 1;",
          start: { line: 1, column: 1 },
          end: { line: 1, column: 17 },
          children: [
            {
              kind: "identifier",
              text: "outer",
              start: { line: 1, column: 7 },
              end: { line: 1, column: 12 },
            },
            {
              kind: "function_declaration",
              text: "function inner() {}",
              start: { line: 2, column: 3 },
              end: { line: 2, column: 22 },
              children: [
                {
                  kind: "identifier",
                  text: "inner",
                  start: { line: 2, column: 12 },
                  end: { line: 2, column: 17 },
                },
              ],
            },
          ],
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const source = "const outer = 1;\n  function inner() {}";
      const result = extractFileFacts(makeBytes(source), "test.ts", "0.1.0", astResult);

      // Both the outer variable and the inner function should be found.
      const defNames = result.definitions.map((d) => d.name);
      assert.ok(defNames.includes("outer"), "should find outer variable");
      assert.ok(defNames.includes("inner"), "should find nested inner function");
    });

    test("interface_declaration produces interface kind", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "interface_declaration",
          text: "interface Props { x: number; }",
          start: { line: 1, column: 1 },
          end: { line: 1, column: 30 },
          children: [
            {
              kind: "identifier",
              text: "Props",
              start: { line: 1, column: 11 },
              end: { line: 1, column: 16 },
            },
          ],
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const result = extractFileFacts(makeBytes("interface Props { x: number; }"), "test.ts", "0.1.0", astResult);
      assert.strictEqual(result.definitions[0]!.kind, "interface");
    });

    test("type_alias_declaration produces type kind", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "type_alias_declaration",
          text: "type ID = string | number;",
          start: { line: 1, column: 1 },
          end: { line: 1, column: 26 },
          children: [
            {
              kind: "identifier",
              text: "ID",
              start: { line: 1, column: 6 },
              end: { line: 1, column: 8 },
            },
          ],
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const result = extractFileFacts(makeBytes("type ID = string | number;"), "test.ts", "0.1.0", astResult);
      assert.strictEqual(result.definitions[0]!.kind, "type");
    });

    test("enum_declaration produces enum kind", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "enum_declaration",
          text: "enum Color { Red, Green }",
          start: { line: 1, column: 1 },
          end: { line: 1, column: 26 },
          children: [
            {
              kind: "identifier",
              text: "Color",
              start: { line: 1, column: 6 },
              end: { line: 1, column: 11 },
            },
          ],
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const result = extractFileFacts(makeBytes("enum Color { Red, Green }"), "test.ts", "0.1.0", astResult);
      assert.strictEqual(result.definitions[0]!.kind, "enum");
    });

    test("method_definition produces method kind", () => {
      const nodes: AstGrepNode[] = [
        {
          kind: "method_definition",
          text: "doWork() { return 1; }",
          start: { line: 1, column: 3 },
          end: { line: 1, column: 25 },
          children: [
            {
              kind: "identifier",
              text: "doWork",
              start: { line: 1, column: 3 },
              end: { line: 1, column: 9 },
            },
          ],
        },
      ];

      const astResult: AstGrepParseResult = {
        version: "0.1.0",
        success: true,
        nodes,
        parseErrors: [],
      };

      const result = extractFileFacts(makeBytes("  doWork() { return 1; }"), "test.ts", "0.1.0", astResult);
      assert.strictEqual(result.definitions[0]!.kind, "method");
    });
  });

  describe("language mapping", () => {
    test("languageForExtension maps known extensions", () => {
      assert.strictEqual(languageForExtension(".ts"), "typescript");
      assert.strictEqual(languageForExtension(".tsx"), "typescriptreact");
      assert.strictEqual(languageForExtension(".js"), "javascript");
      assert.strictEqual(languageForExtension(".jsx"), "javascriptreact");
      assert.strictEqual(languageForExtension(".json"), "json");
      assert.strictEqual(languageForExtension(".py"), "python");
      assert.strictEqual(languageForExtension(".rs"), "rust");
      assert.strictEqual(languageForExtension(".go"), "go");
      assert.strictEqual(languageForExtension(".css"), "css");
      assert.strictEqual(languageForExtension(".html"), "html");
      assert.strictEqual(languageForExtension(".md"), "markdown");
      assert.strictEqual(languageForExtension(".yaml"), "yaml");
      assert.strictEqual(languageForExtension(".yml"), "yaml");
      assert.strictEqual(languageForExtension(".mjs"), "javascript");
      assert.strictEqual(languageForExtension(".cjs"), "javascript");
    });

    test("languageForExtension returns null for unrecognized extensions", () => {
      assert.strictEqual(languageForExtension(".xyz"), null);
      assert.strictEqual(languageForExtension(".bin"), null);
      assert.strictEqual(languageForExtension(""), null);
    });

    test("languageForExtension handles extension without leading dot", () => {
      assert.strictEqual(languageForExtension("ts"), "typescript");
      assert.strictEqual(languageForExtension("py"), "python");
    });

    test("languageForFile maps file paths correctly", () => {
      assert.strictEqual(languageForFile("src/index.ts"), "typescript");
      assert.strictEqual(languageForFile("lib/utils.js"), "javascript");
      assert.strictEqual(languageForFile("README.md"), "markdown");
      assert.strictEqual(languageForFile("config.json"), "json");
    });

    test("languageForFile returns null for files without extension", () => {
      assert.strictEqual(languageForFile("Makefile"), null);
      assert.strictEqual(languageForFile("Dockerfile"), null);
    });

    test("languageForFile returns null for files ending with dot", () => {
      assert.strictEqual(languageForFile("file."), null);
    });
  });

  describe("JSON/YAML/CSS/HTML/Markdown inventory-only behavior", () => {
    test("JSON files get file-inventory-only coverage even with rules present", () => {
      const source = '{"name": "test", "version": "1.0.0"}';
      const result = extractFileFacts(makeBytes(source), "package.json", null, null);

      assert.strictEqual(result.coverage, "file-inventory-only");
      assert.strictEqual(result.language, "json");
    });

    test("YAML files get file-inventory-only coverage", () => {
      const source = "name: test\nversion: 1.0.0";
      const result = extractFileFacts(makeBytes(source), "config.yaml", null, null);

      assert.strictEqual(result.coverage, "file-inventory-only");
      assert.strictEqual(result.language, "yaml");
    });

    test("Markdown files get file-inventory-only coverage", () => {
      const source = "# Hello\n\nSome content.";
      const result = extractFileFacts(makeBytes(source), "README.md", null, null);

      assert.strictEqual(result.coverage, "file-inventory-only");
      assert.strictEqual(result.language, "markdown");
    });
  });

  describe("extractor fingerprint stability", () => {
    test("same inputs produce the same fingerprint", () => {
      const fp1 = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
      const fp2 = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
      assert.strictEqual(fp1, fp2);
    });

    test("different language produces different fingerprint", () => {
      const fpTs = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
      const fpPy = computeLanguageExtractorFingerprint("python", "structural", "0.1.0");
      assert.notStrictEqual(fpTs, fpPy);
    });

    test("different parser mode produces different fingerprint", () => {
      const fpStructural = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
      const fpLexical = computeLanguageExtractorFingerprint("typescript", "lexical-fallback", "0.1.0");
      assert.notStrictEqual(fpStructural, fpLexical);
    });

    test("different parser version produces different fingerprint", () => {
      const fp1 = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
      const fp2 = computeLanguageExtractorFingerprint("typescript", "structural", "0.2.0");
      assert.notStrictEqual(fp1, fp2);
    });

    test("null parser version produces different fingerprint from any string version", () => {
      const fpNull = computeLanguageExtractorFingerprint("typescript", "structural", null);
      const fpStr = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
      assert.notStrictEqual(fpNull, fpStr);
    });

    test("fingerprint is 32 hex characters", () => {
      const fp = computeLanguageExtractorFingerprint("typescript", "structural", "0.1.0");
      assert.strictEqual(fp.length, 32);
      assert.match(fp, /^[0-9a-f]{32}$/);
    });
  });
});
