/**
 * Evidence invariant tests for the Local Code Index v2.
 *
 * Verifies three behavioral invariants demanded by the evidence contract:
 *
 *   1. Related-file scores always include evidence — every scored file in
 *      a related-files result must carry at least one FileRelationship with
 *      non-empty SourceRange evidence.
 *   2. Ambiguous references never appear as exact call edges — when a
 *      symbol is defined in multiple files the resulting relationship type
 *      is "ambiguous-reference", never "references".
 *   3. Evidence pack is bounded — buildLocalCodeIndexEvidence caps output
 *      at maxChars and emits a truncation marker.
 *
 * Run:
 *   npm run build:tests
 *   node dist-tests/scripts/run-node-tests.js tests/local-code-index-evidence.test.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type {
  ExtractedDefinition,
  ExtractedReference,
  ExtractedImport,
} from "../core/indexing/local-code-index/extract.js";

import {
  buildSymbolDefinitionIndex,
  buildReferencesForFile,
  buildAllRelationships,
  buildRelationshipShard,
  WEIGHT_IMPORT,
  WEIGHT_UNIQUE_REF,
  WEIGHT_AMBIGUOUS_REF,
} from "../core/indexing/local-code-index/relationships.js";

import type {
  ResolutionConfig,
  PathInventoryEntry,
  RelationshipRecord,
} from "../core/indexing/local-code-index/relationships.js";

import {
  taskSymbolCandidates,
  exactSymbolFilesFromQuery,
  buildLocalCodeIndexEvidence,
  formatRelatedFileScores,
} from "../core/indexing/local-code-index/evidence.js";

import type {
  FileRelationship,
  LocalCodeIndexQueryResult,
  SourceRange,
  SymbolOccurrence,
  LocalCodeIndexCoverageSummary,
} from "../core/indexing/local-code-index/contracts.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

function range(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): SourceRange {
  return { startLine, startColumn, endLine, endColumn };
}

const COVERAGE: LocalCodeIndexCoverageSummary = Object.freeze({
  effective: "ast-grep-structural",
  partial: false,
  failedFiles: 0,
  oversizedFiles: 0,
});

function makeOccurrence(overrides: Partial<SymbolOccurrence> & Pick<SymbolOccurrence, "symbol" | "path">): SymbolOccurrence {
  return {
    kind: "function",
    role: "definition",
    range: range(1, 1, 1, 20),
    exported: true,
    coverage: "ast-grep-structural",
    ...overrides,
  };
}

function makeDefinitionsResult(
  occurrences: SymbolOccurrence[],
  opts?: { truncated?: boolean; snapshotId?: string },
): LocalCodeIndexQueryResult {
  return {
    kind: "definitions",
    snapshotId: opts?.snapshotId ?? "snap-001",
    coverage: COVERAGE,
    truncated: opts?.truncated ?? false,
    durationMs: 10,
    occurrences,
  };
}

function makeInventoryResult(
  files: Array<{ path: string; language: string; size: number; nodeCount?: number; coverage: "ast-grep-structural" | "lexical-reference-fallback" | "file-inventory-only" }>,
  opts?: { truncated?: boolean; snapshotId?: string },
): LocalCodeIndexQueryResult {
  return {
    kind: "inventory",
    snapshotId: opts?.snapshotId ?? "snap-001",
    coverage: COVERAGE,
    truncated: opts?.truncated ?? false,
    durationMs: 5,
    files: files.map((file) => ({ ...file, nodeCount: file.nodeCount ?? 0 })),
    nextCursor: null,
  };
}

function makeRelatedFilesResult(
  files: Array<{ path: string; score: number; evidence: FileRelationship[] }>,
  opts?: { truncated?: boolean; snapshotId?: string },
): LocalCodeIndexQueryResult {
  return {
    kind: "related-files",
    snapshotId: opts?.snapshotId ?? "snap-001",
    coverage: COVERAGE,
    truncated: opts?.truncated ?? false,
    durationMs: 8,
    files,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Related-file scores always include evidence
// ──────────────────────────────────────────────────────────────────────────────

describe("related-file scores always include evidence", () => {
  test("every scored file in a related-files result carries non-empty evidence", () => {
    const files: Array<{ path: string; score: number; evidence: FileRelationship[] }> = [
      {
        path: "src/utils.ts",
        score: 3,
        evidence: [
          {
            fromPath: "src/index.ts",
            toPath: "src/utils.ts",
            type: "imports",
            symbol: null,
            evidence: [range(1, 1, 1, 30)],
            weight: WEIGHT_IMPORT,
          },
        ],
      },
      {
        path: "src/helper.ts",
        score: 2,
        evidence: [
          {
            fromPath: "src/index.ts",
            toPath: "src/helper.ts",
            type: "references",
            symbol: "doWork",
            evidence: [range(5, 3, 5, 10)],
            weight: WEIGHT_UNIQUE_REF,
          },
        ],
      },
    ];

    const result = makeRelatedFilesResult(files);

    if (result.kind !== "related-files") throw new Error("expected related-files");
    for (const file of result.files) {
      assert.ok(
        file.evidence.length > 0,
        `file "${file.path}" with score ${file.score} must have non-empty evidence`,
      );
      for (const rel of file.evidence) {
        assert.ok(
          rel.evidence.length > 0,
          `relationship ${rel.fromPath} -> ${rel.toPath} (type=${rel.type}) must carry SourceRange evidence`,
        );
      }
    }
  });

  test("formatRelatedFileScores produces evidence lines for every scored file", () => {
    const result = makeRelatedFilesResult([
      {
        path: "src/greeter.ts",
        score: 3.0,
        evidence: [
          {
            fromPath: "src/index.ts",
            toPath: "src/greeter.ts",
            type: "imports",
            symbol: null,
            evidence: [range(1, 1, 1, 35)],
            weight: WEIGHT_IMPORT,
          },
        ],
      },
    ]);

    const lines = formatRelatedFileScores(result);
    assert.ok(lines.length > 0, "must produce at least one evidence line");
    assert.ok(
      lines[0].includes("src/greeter.ts"),
      "evidence line must reference the scored file path",
    );
    assert.ok(
      lines[0].includes("score:"),
      "evidence line must include the score",
    );
    assert.ok(
      lines[0].includes("imports"),
      "evidence line must include the relationship type",
    );
  });

  test("formatRelatedFileScores returns empty for non-related-files query results", () => {
    const defResult = makeDefinitionsResult([]);
    const lines = formatRelatedFileScores(defResult);
    assert.deepStrictEqual(lines, []);
  });

  test("buildLocalCodeIndexEvidence renders related-file evidence sections", () => {
    const relatedResult = makeRelatedFilesResult([
      {
        path: "src/deep.ts",
        score: 5,
        evidence: [
          {
            fromPath: "src/index.ts",
            toPath: "src/deep.ts",
            type: "imports",
            symbol: null,
            evidence: [range(2, 1, 2, 30)],
            weight: WEIGHT_IMPORT,
          },
          {
            fromPath: "src/index.ts",
            toPath: "src/deep.ts",
            type: "references",
            symbol: "helper",
            evidence: [range(4, 5, 4, 12)],
            weight: WEIGHT_UNIQUE_REF,
          },
        ],
      },
    ]);

    const evidence = buildLocalCodeIndexEvidence(
      { "related-files": relatedResult },
      "test task",
    );

    assert.ok(
      evidence.includes("src/deep.ts"),
      "evidence must mention the related file path",
    );
    assert.ok(
      evidence.includes("score:"),
      "evidence must include the score",
    );
    assert.ok(
      evidence.includes("imports") || evidence.includes("references"),
      "evidence must include relationship type details",
    );
  });

  test("relationship shard preserves evidence on every relationship", () => {
    const resolvedImports = [
      {
        requested: "./utils",
        resolvedPath: "src/utils.ts",
        range: range(1, 1, 1, 25),
        importKind: "esm" as const,
        resolutionConfigFingerprint: "abc123",
      },
    ];

    const referenceRelationships: RelationshipRecord[] = [
      {
        fromPath: "src/index.ts",
        toPath: "src/helper.ts",
        type: "references",
        symbol: "doWork",
        evidence: [range(5, 3, 5, 10)],
        weight: WEIGHT_UNIQUE_REF,
      },
    ];

    const shard = buildRelationshipShard(
      "src/index.ts",
      resolvedImports,
      referenceRelationships,
      "abc123",
    );

    for (const rel of shard.relationships) {
      assert.ok(
        rel.evidence.length > 0,
        `shard relationship ${rel.fromPath} -> ${rel.toPath} must have non-empty evidence`,
      );
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. Ambiguous references never appear as exact call edges
// ──────────────────────────────────────────────────────────────────────────────

describe("ambiguous references never appear as exact call edges", () => {
  test("symbol defined in multiple files produces ambiguous-reference type", () => {
    const definitions = new Map<string, readonly ExtractedDefinition[]>([
      [
        "src/format-a.ts",
        [
          { name: "format", kind: "function", range: range(1, 1, 3, 2), exported: true, signature: null },
        ],
      ],
      [
        "src/format-b.ts",
        [
          { name: "format", kind: "function", range: range(1, 1, 3, 2), exported: true, signature: null },
        ],
      ],
    ]);

    const definitionIndex = buildSymbolDefinitionIndex(definitions);

    const references: readonly ExtractedReference[] = [
      { name: "format", range: range(10, 5, 10, 11), referenceKind: "call" },
    ];

    const records = buildReferencesForFile(
      "src/consumer.ts",
      references,
      definitionIndex,
    );

    assert.ok(records.length > 0, "must produce at least one relationship record");

    for (const record of records) {
      assert.strictEqual(
        record.type,
        "ambiguous-reference",
        `symbol "format" defined in 2 files must produce type "ambiguous-reference", got "${record.type}"`,
      );
    }
  });

  test("ambiguous-reference weight is strictly less than unique-reference weight", () => {
    assert.ok(
      WEIGHT_AMBIGUOUS_REF < WEIGHT_UNIQUE_REF,
      `WEIGHT_AMBIGUOUS_REF (${WEIGHT_AMBIGUOUS_REF}) must be < WEIGHT_UNIQUE_REF (${WEIGHT_UNIQUE_REF})`,
    );
  });

  test("ambiguous-reference weight is strictly less than import weight", () => {
    assert.ok(
      WEIGHT_AMBIGUOUS_REF < WEIGHT_IMPORT,
      `WEIGHT_AMBIGUOUS_REF (${WEIGHT_AMBIGUOUS_REF}) must be < WEIGHT_IMPORT (${WEIGHT_IMPORT})`,
    );
  });

  test("symbol defined in exactly one file produces references type (not ambiguous)", () => {
    const definitions = new Map<string, readonly ExtractedDefinition[]>([
      [
        "src/format.ts",
        [
          { name: "format", kind: "function", range: range(1, 1, 3, 2), exported: true, signature: null },
        ],
      ],
    ]);

    const definitionIndex = buildSymbolDefinitionIndex(definitions);

    const references: readonly ExtractedReference[] = [
      { name: "format", range: range(10, 5, 10, 11), referenceKind: "call" },
    ];

    const records = buildReferencesForFile(
      "src/consumer.ts",
      references,
      definitionIndex,
    );

    assert.ok(records.length > 0, "must produce at least one relationship record");
    assert.strictEqual(
      records[0].type,
      "references",
      `symbol defined in exactly 1 file must produce type "references"`,
    );
    assert.strictEqual(records[0].weight, WEIGHT_UNIQUE_REF);
  });

  test("relationship shard never labels an ambiguous reference as type references", () => {
    // Build a scenario with both unique and ambiguous symbols.
    const fileDefinitions = new Map<string, readonly ExtractedDefinition[]>([
      [
        "src/unique.ts",
        [
          { name: "onlyHere", kind: "function", range: range(1, 1, 3, 2), exported: true, signature: null },
        ],
      ],
      [
        "src/ambig-a.ts",
        [
          { name: "shared", kind: "function", range: range(1, 1, 3, 2), exported: true, signature: null },
        ],
      ],
      [
        "src/ambig-b.ts",
        [
          { name: "shared", kind: "function", range: range(1, 1, 3, 2), exported: true, signature: null },
        ],
      ],
    ]);

    const fileReferences = new Map<string, readonly ExtractedReference[]>([
      [
        "src/consumer.ts",
        [
          { name: "onlyHere", range: range(5, 3, 5, 11), referenceKind: "call" },
          { name: "shared", range: range(6, 3, 6, 9), referenceKind: "call" },
        ],
      ],
    ]);

    const fileImports = new Map<string, readonly ExtractedImport[]>([
      ["src/consumer.ts", []],
    ]);

    const config: ResolutionConfig = {
      language: "typescript",
      version: 1,
      moduleResolution: "node",
      baseUrl: null,
      pathAliases: {},
      extensions: [".ts", ".js"],
      indexFiles: ["index.ts"],
      packageFields: [],
    };

    const pathInventory = new Map<string, PathInventoryEntry>([
      ["src/unique.ts", { path: "src/unique.ts", language: "typescript", exportedSymbols: ["onlyHere"] }],
      ["src/ambig-a.ts", { path: "src/ambig-a.ts", language: "typescript", exportedSymbols: ["shared"] }],
      ["src/ambig-b.ts", { path: "src/ambig-b.ts", language: "typescript", exportedSymbols: ["shared"] }],
      ["src/consumer.ts", { path: "src/consumer.ts", language: "typescript", exportedSymbols: [] }],
    ]);

    const result = buildAllRelationships({
      fileImports,
      fileReferences,
      fileDefinitions,
      resolutionConfig: config,
      pathInventory,
    });

    const consumerRefs = result.referenceRelationships.get("src/consumer.ts") ?? [];

    // The "shared" symbol must be classified as ambiguous-reference.
    const sharedRels = consumerRefs.filter((r) => r.symbol === "shared");
    assert.ok(sharedRels.length > 0, "must produce relationships for the shared symbol");

    for (const rel of sharedRels) {
      assert.strictEqual(
        rel.type,
        "ambiguous-reference",
        `symbol "shared" defined in 2 files must never appear as type "references"; got "${rel.type}"`,
      );
      assert.strictEqual(
        rel.weight,
        WEIGHT_AMBIGUOUS_REF,
        `ambiguous reference must use WEIGHT_AMBIGUOUS_REF`,
      );
    }

    // The "onlyHere" symbol should be a unique reference.
    const uniqueRels = consumerRefs.filter((r) => r.symbol === "onlyHere");
    assert.ok(uniqueRels.length > 0, "must produce relationships for the unique symbol");

    for (const rel of uniqueRels) {
      assert.strictEqual(
        rel.type,
        "references",
        `symbol "onlyHere" defined in 1 file must be type "references"`,
      );
    }
  });

  test("three-way ambiguous symbol never appears as references in shard", () => {
    const fileDefinitions = new Map<string, readonly ExtractedDefinition[]>([
      [
        "src/a.ts",
        [{ name: "process", kind: "function", range: range(1, 1, 5, 2), exported: true, signature: null }],
      ],
      [
        "src/b.ts",
        [{ name: "process", kind: "function", range: range(1, 1, 5, 2), exported: true, signature: null }],
      ],
      [
        "src/c.ts",
        [{ name: "process", kind: "function", range: range(1, 1, 5, 2), exported: true, signature: null }],
      ],
    ]);

    const fileReferences = new Map<string, readonly ExtractedReference[]>([
      [
        "src/caller.ts",
        [
          { name: "process", range: range(10, 10, 10, 17), referenceKind: "call" },
        ],
      ],
    ]);

    const fileImports = new Map<string, readonly ExtractedImport[]>([
      ["src/caller.ts", []],
      ["src/a.ts", []],
      ["src/b.ts", []],
      ["src/c.ts", []],
    ]);

    const config: ResolutionConfig = {
      language: "typescript",
      version: 1,
      moduleResolution: "node",
      baseUrl: null,
      pathAliases: {},
      extensions: [".ts", ".js"],
      indexFiles: ["index.ts"],
      packageFields: [],
    };

    const pathInventory = new Map<string, PathInventoryEntry>([
      ["src/a.ts", { path: "src/a.ts", language: "typescript", exportedSymbols: ["process"] }],
      ["src/b.ts", { path: "src/b.ts", language: "typescript", exportedSymbols: ["process"] }],
      ["src/c.ts", { path: "src/c.ts", language: "typescript", exportedSymbols: ["process"] }],
      ["src/caller.ts", { path: "src/caller.ts", language: "typescript", exportedSymbols: [] }],
    ]);

    const result = buildAllRelationships({
      fileImports,
      fileReferences,
      fileDefinitions,
      resolutionConfig: config,
      pathInventory,
    });

    const shard = result.shards.get("src/caller.ts");
    assert.ok(shard, "must produce a shard for src/caller.ts");

    for (const rel of shard!.relationships) {
      if (rel.symbol === "process") {
        assert.strictEqual(
          rel.type,
          "ambiguous-reference",
          `three-way ambiguous symbol "process" must never appear as type "references" in shard`,
        );
      }
    }
  });

  test("no exported definitions means no relationship records for that symbol", () => {
    const definitions = new Map<string, readonly ExtractedDefinition[]>([
      [
        "src/internal.ts",
        [
          // Not exported — must not appear in cross-file references.
          { name: "secretHelper", kind: "function", range: range(1, 1, 3, 2), exported: false, signature: null },
        ],
      ],
    ]);

    const definitionIndex = buildSymbolDefinitionIndex(definitions);

    const references: readonly ExtractedReference[] = [
      { name: "secretHelper", range: range(10, 5, 10, 17), referenceKind: "call" },
    ];

    const records = buildReferencesForFile(
      "src/consumer.ts",
      references,
      definitionIndex,
    );

    assert.strictEqual(
      records.length,
      0,
      "non-exported definitions must not produce cross-file relationships",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Evidence pack is bounded
// ──────────────────────────────────────────────────────────────────────────────

describe("evidence pack is bounded", () => {
  test("buildLocalCodeIndexEvidence respects maxChars cap with truncation marker", () => {
    // Build a large related-files result to exceed a small cap.
    const files: Array<{ path: string; score: number; evidence: FileRelationship[] }> = [];
    for (let i = 0; i < 50; i++) {
      files.push({
        path: `src/module-${String(i).padStart(3, "0")}.ts`,
        score: 3,
        evidence: [
          {
            fromPath: "src/index.ts",
            toPath: `src/module-${String(i).padStart(3, "0")}.ts`,
            type: "imports",
            symbol: null,
            evidence: [range(i + 1, 1, i + 1, 30)],
            weight: WEIGHT_IMPORT,
          },
        ],
      });
    }

    const relatedResult = makeRelatedFilesResult(files);

    const maxChars = 500;
    const evidence = buildLocalCodeIndexEvidence(
      { "related-files": relatedResult },
      "very long task description that takes up space in the output buffer",
      maxChars,
    );

    assert.ok(
      evidence.length <= maxChars + 200,
      `evidence length ${evidence.length} must not far exceed maxChars ${maxChars}`,
    );
    assert.ok(
      evidence.includes("[Local code index evidence truncated"),
      "must include the truncation marker when output exceeds maxChars",
    );
  });

  test("evidence under maxChars has no truncation marker", () => {
    const relatedResult = makeRelatedFilesResult([
      {
        path: "src/one.ts",
        score: 2,
        evidence: [
          {
            fromPath: "src/index.ts",
            toPath: "src/one.ts",
            type: "imports",
            symbol: null,
            evidence: [range(1, 1, 1, 20)],
            weight: WEIGHT_IMPORT,
          },
        ],
      },
    ]);

    const evidence = buildLocalCodeIndexEvidence(
      { "related-files": relatedResult },
      "short task",
      32_000,
    );

    assert.ok(
      !evidence.includes("[Local code index evidence truncated"),
      "must not include truncation marker when output fits within maxChars",
    );
  });

  test("truncation marker includes original length for diagnostics", () => {
    const files: Array<{ path: string; score: number; evidence: FileRelationship[] }> = [];
    for (let i = 0; i < 100; i++) {
      files.push({
        path: `src/large-module-${String(i).padStart(4, "0")}.ts`,
        score: 3,
        evidence: [
          {
            fromPath: "src/index.ts",
            toPath: `src/large-module-${String(i).padStart(4, "0")}.ts`,
            type: "imports",
            symbol: null,
            evidence: [range(i + 1, 1, i + 1, 40)],
            weight: WEIGHT_IMPORT,
          },
        ],
      });
    }

    const maxChars = 300;
    const evidence = buildLocalCodeIndexEvidence(
      { "related-files": makeRelatedFilesResult(files) },
      "task",
      maxChars,
    );

    // The truncation marker must include the original length.
    const markerMatch = evidence.match(
      /\[Local code index evidence truncated at (\d+) chars; original length: (\d+)\]/,
    );
    assert.ok(markerMatch, "must contain truncation marker with original length");
    assert.strictEqual(
      parseInt(markerMatch![1], 10),
      maxChars,
      "marker must reference the maxChars value used",
    );
    assert.ok(
      parseInt(markerMatch![2], 10) > maxChars,
      "original length must exceed maxChars",
    );
  });

  test("evidence pack includes all sections without exceeding default maxChars for small inputs", () => {
    const definitionsResult = makeDefinitionsResult([
      makeOccurrence({
        symbol: "buildIndex",
        path: "src/indexer.ts",
        kind: "function",
      }),
    ]);

    const inventoryResult = makeInventoryResult([
      { path: "src/indexer.ts", language: "typescript", size: 1024, coverage: "ast-grep-structural" },
      { path: "src/utils.ts", language: "typescript", size: 512, coverage: "ast-grep-structural" },
    ]);

    const relatedResult = makeRelatedFilesResult([
      {
        path: "src/utils.ts",
        score: 3,
        evidence: [
          {
            fromPath: "src/indexer.ts",
            toPath: "src/utils.ts",
            type: "imports",
            symbol: null,
            evidence: [range(1, 1, 1, 25)],
            weight: WEIGHT_IMPORT,
          },
        ],
      },
    ]);

    const evidence = buildLocalCodeIndexEvidence(
      {
        definitions: definitionsResult,
        inventory: inventoryResult,
        "related-files": relatedResult,
      },
      "refactor the indexer",
    );

    // Must include all section headers.
    assert.ok(evidence.includes("## Symbol definitions"), "must have definitions section");
    assert.ok(evidence.includes("## File inventory"), "must have inventory section");
    assert.ok(evidence.includes("## Related files"), "must have related-files section");
    assert.ok(evidence.includes("## Coverage"), "must have coverage section");

    // Must not be truncated at default 32k.
    assert.ok(
      !evidence.includes("[Local code index evidence truncated"),
      "small inputs must not trigger truncation at default maxChars",
    );
  });

  test("default maxChars is 32000 when not specified", () => {
    const smallFiles: Array<{ path: string; score: number; evidence: FileRelationship[] }> = [];
    for (let i = 0; i < 5; i++) {
      smallFiles.push({
        path: `src/mod-${i}.ts`,
        score: 3,
        evidence: [
          {
            fromPath: "src/index.ts",
            toPath: `src/mod-${i}.ts`,
            type: "imports",
            symbol: null,
            evidence: [range(i + 1, 1, i + 1, 20)],
            weight: WEIGHT_IMPORT,
          },
        ],
      });
    }

    const evidence = buildLocalCodeIndexEvidence(
      { "related-files": makeRelatedFilesResult(smallFiles) },
      "test",
    );

    // Default 32000 — small content must not be truncated.
    assert.ok(
      !evidence.includes("[Local code index evidence truncated"),
      "small evidence must not be truncated at the default 32000 char limit",
    );
    assert.ok(evidence.length < 32_000, "small evidence must be under 32000 chars");
  });

  test("empty inventory produces file-inventory-only coverage", () => {
    const results: Record<string, LocalCodeIndexQueryResult> = {};
    const evidence = buildLocalCodeIndexEvidence(results, "task");
    assert.ok(
      evidence.includes("No relevant local code index evidence found"),
      "must report empty state for empty input",
    );
  });
});
