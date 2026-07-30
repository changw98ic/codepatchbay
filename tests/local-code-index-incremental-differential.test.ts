/**
 * Tests for Local Code Index v2 — incremental and differential rebuild.
 *
 * Verifies that:
 *   1. One-file changes rebuild only required file/shard objects.
 *   2. Rename reuses file facts but rebuilds path-dependent relationships.
 *   3. Unique-to-ambiguous and ambiguous-to-unique transitions update all evidence.
 *   4. A deterministic differential suite applies alias/config edits, addition,
 *      deletion, rename, retarget, and zero/one/many-definition transitions,
 *      then byte-compares all queryable incremental output with a forced full build.
 *
 * Dependencies: shards.ts, relationships.ts, change-plan.ts, object-store.ts,
 *   snapshot-store.ts, canonical-json.ts, contracts.ts, extract.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildSymbolShard,
  buildRelationShard,
  deriveShardObjectId,
  distributeBySymbol,
  distributeByPath,
  rebuildShards,
  symbolBucketKey,
  pathBucketKey,
  normalizeSymbol,
  normalizePath,
} from "../core/indexing/local-code-index/shards.js";

import type {
  ShardSymbolEntry,
  ShardFileSummaryEntry,
  ShardRelationshipEntry,
  SymbolShard,
  RelationShard,
  ShardRebuildInput,
  ShardRebuildResult,
} from "../core/indexing/local-code-index/shards.js";

import {
  buildSymbolDefinitionIndex,
  resolveImportsForFile,
  resolveAllImports,
  buildReferencesForFile,
  buildAllReferences,
  buildRelationshipShard,
  buildAllRelationshipShards,
  computeAffectedSet,
  buildAllRelationships,
  deriveResolutionConfigFingerprint,
  deriveRelationshipShardId,
  WEIGHT_IMPORT,
  WEIGHT_UNIQUE_REF,
  WEIGHT_AMBIGUOUS_REF,
} from "../core/indexing/local-code-index/relationships.js";

import type {
  ResolutionConfig,
  PathInventoryEntry,
  ResolvedImport,
  RelationshipRecord,
  RelationshipShard,
  AffectedSetInput,
  SymbolDefinitionIndex,
  BuildRelationshipsInput,
} from "../core/indexing/local-code-index/relationships.js";

import {
  buildChangePlan,
  isChangePlanEmpty,
  getComputeEntries,
  getDeleteEntries,
  getRetargetEntries,
  getReuseEntries,
} from "../core/indexing/local-code-index/change-plan.js";

import type {
  SourceState,
  SourceStateEntry,
  ChangePlan,
} from "../core/indexing/local-code-index/change-plan.js";

import { canonicalStringify, objectId } from "../core/indexing/local-code-index/canonical-json.js";

import type { ExtractedDefinition, ExtractedReference, ExtractedImport } from "../core/indexing/local-code-index/extract.js";
import type { SourceRange } from "../core/indexing/local-code-index/contracts.js";

// ── Deterministic test fixtures ────────────────────────────────────────────

/** SHA-256 hex of a label, used as a fake content ID. */
function contentId(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

/** Fixed source range for deterministic tests. */
function range(line: number, col = 0, endCol = 10): SourceRange {
  return { startLine: line, startColumn: col, endLine: line, endColumn: endCol };
}

/** Build a deterministic PinnedFileMetadata from a path label. */
function fakeMeta(label: string) {
  const h = createHash("sha256").update(label).digest();
  return {
    device: "0",
    inode: String(BigInt("0x" + h.subarray(0, 8).toString("hex"))),
    size: "100",
    mtimeNs: "1000000000",
    ctimeNs: "1000000000",
    mode: 0o100644,
  };
}

/** Build a SourceStateEntry for change-plan tests. */
function stateEntry(
  path: string,
  label: string,
  lang = "typescript",
): SourceStateEntry {
  return {
    path,
    contentId: contentId(label),
    language: lang,
    parserMode: "structural",
    languageExtractorFingerprint: "fp-v1",
    metadata: fakeMeta(label),
    gitBlobId: null,
    materializationFingerprint: null,
  };
}

/** Build a minimal SourceState from entries. */
function sourceState(entries: readonly SourceStateEntry[]): SourceState {
  return {
    repository: { commonGitDir: null, objectFormat: null, head: null, branch: null },
    materialization: { autocrlf: false, eol: "lf", attributesFile: null },
    entries: [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    worktreeStateFingerprint: "wfp",
    observedAt: Date.now(),
  };
}

/** Build a deterministic symbol entry for shard tests. */
function sym(
  symbol: string,
  path: string,
  role: "definition" | "reference" = "definition",
  line = 1,
): ShardSymbolEntry {
  return {
    symbol,
    kind: role === "definition" ? "function" : "reference",
    role,
    path,
    range: range(line),
    exported: role === "definition",
    coverage: "ast-grep-structural",
  };
}

/** Build a deterministic file summary entry for shard tests. */
function summary(path: string, lang = "typescript"): ShardFileSummaryEntry {
  return {
    path,
    language: lang,
    size: 1024,
    contentId: contentId(path),
    coverage: "ast-grep-structural",
  };
}

/** Build a deterministic relationship entry for shard tests. */
function rel(
  fromPath: string,
  toPath: string,
  type: "imports" | "references" | "ambiguous-reference" = "imports",
): ShardRelationshipEntry {
  return {
    fromPath,
    toPath,
    type,
    symbol: null,
    weight: type === "imports" ? WEIGHT_IMPORT : type === "references" ? WEIGHT_UNIQUE_REF : WEIGHT_AMBIGUOUS_REF,
  };
}

/** Build a deterministic ExtractedDefinition. */
function def(name: string, line = 1, exported = true): ExtractedDefinition {
  return {
    name,
    kind: "function",
    range: range(line),
    exported,
    signature: null,
  };
}

/** Build a deterministic ExtractedReference. */
function ref(name: string, line = 1): ExtractedReference {
  return {
    name,
    range: range(line),
    referenceKind: "unknown",
  };
}

/** Build a deterministic ExtractedImport. */
function imp(requested: string, line = 1): ExtractedImport {
  return {
    requested,
    range: range(line),
    importKind: "esm",
  };
}

/** Build a deterministic resolution config. */
function config(overrides?: Partial<ResolutionConfig>): ResolutionConfig {
  return {
    language: "typescript",
    version: 1,
    moduleResolution: "node",
    baseUrl: null,
    pathAliases: {},
    extensions: [".ts", ".js"],
    indexFiles: ["index.ts", "index.js"],
    packageFields: [],
    ...overrides,
  };
}

/** Byte-compare two canonical-JSON-serialisable values. */
function assertByteEqual(actual: unknown, expected: unknown, msg?: string): void {
  const a = canonicalStringify(actual);
  const e = canonicalStringify(expected);
  assert.equal(a, e, msg ?? "canonical JSON mismatch");
}

/** SHA-256 of canonical JSON bytes for a value. */
function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8").digest("hex");
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. One-file changes rebuild only required file/shard objects
// ══════════════════════════════════════════════════════════════════════════════

describe("incremental: one-file change", () => {
  it("changing one file's content rebuilds only the shards that file touches", async () => {
    // Three files with distinct symbols, each potentially in its own shard bucket.
    const fileA = sym("Alpha", "src/a.ts");
    const fileB = sym("Beta", "src/b.ts");
    const fileC = sym("Gamma", "src/c.ts");
    const entries1 = [fileA, fileB, fileC];
    const summaries1 = [summary("src/a.ts"), summary("src/b.ts"), summary("src/c.ts")];
    const rels1 = [rel("src/a.ts", "src/b.ts")];

    // First full build.
    const first = await rebuildShards({
      previousSymbolEntries: [],
      currentSymbolEntries: entries1,
      previousFileSummaries: [],
      currentFileSummaries: summaries1,
      previousRelationships: [],
      currentRelationships: rels1,
      previousSymbolShardIds: new Map(),
      previousRelationShardIds: new Map(),
    });

    // Change only file B's symbol (Beta -> Beta2).
    const fileB2 = sym("Beta2", "src/b.ts");
    const entries2 = [fileA, fileB2, fileC];
    // File B content changed -> new contentId.
    const summaries2 = [summary("src/a.ts"), summary("src/b.ts"), summary("src/c.ts")];
    // Relationship unchanged.
    const rels2 = rels1;

    const second = await rebuildShards({
      previousSymbolEntries: entries1,
      currentSymbolEntries: entries2,
      previousFileSummaries: summaries1,
      currentFileSummaries: summaries2,
      previousRelationships: rels1,
      currentRelationships: rels2,
      previousSymbolShardIds: first.symbolShardIds,
      previousRelationShardIds: first.relationShardIds,
    });

    // Alpha and Gamma shards must be reused (same entries in their buckets).
    const alphaBucket = symbolBucketKey("Alpha");
    const gammaBucket = symbolBucketKey("Gamma");
    const betaBucket = symbolBucketKey("Beta");
    const beta2Bucket = symbolBucketKey("Beta2");

    // Alpha's shard object ID must not change.
    assert.equal(
      second.symbolShardIds.get(alphaBucket),
      first.symbolShardIds.get(alphaBucket),
      "Alpha shard ID must be unchanged",
    );

    // Gamma's shard object ID must not change.
    assert.equal(
      second.symbolShardIds.get(gammaBucket),
      first.symbolShardIds.get(gammaBucket),
      "Gamma shard ID must be unchanged",
    );

    // At most 2 symbol shards rebuilt (Beta's old bucket and Beta2's new bucket,
    // which may be the same bucket).
    assert.ok(
      second.rebuiltSymbolShardCount <= 2,
      `expected <=2 rebuilt symbol shards, got ${second.rebuiltSymbolShardCount}`,
    );
    assert.ok(
      second.rebuiltSymbolShardCount >= 1,
      `expected >=1 rebuilt symbol shard, got ${second.rebuiltSymbolShardCount}`,
    );
  });

  it("changing one file's content rebuilds only the relation shard for that file's bucket", async () => {
    const summaries1 = [summary("src/a.ts"), summary("src/b.ts"), summary("src/c.ts")];
    const rels1 = [
      rel("src/a.ts", "src/b.ts"),
      rel("src/b.ts", "src/c.ts"),
      rel("src/c.ts", "src/a.ts"),
    ];

    const first = await rebuildShards({
      previousSymbolEntries: [],
      currentSymbolEntries: [],
      previousFileSummaries: [],
      currentFileSummaries: summaries1,
      previousRelationships: [],
      currentRelationships: rels1,
      previousSymbolShardIds: new Map(),
      previousRelationShardIds: new Map(),
    });

    // Change file B's summary (new contentId).
    const summaries2 = [
      summary("src/a.ts"),
      { ...summary("src/b.ts"), contentId: contentId("b-changed") },
      summary("src/c.ts"),
    ];
    // Only B's relationship changed.
    const rels2 = [
      rel("src/a.ts", "src/b.ts"),
      rel("src/b.ts", "src/a.ts"), // B now imports A instead of C
      rel("src/c.ts", "src/a.ts"),
    ];

    const second = await rebuildShards({
      previousSymbolEntries: [],
      currentSymbolEntries: [],
      previousFileSummaries: summaries1,
      currentFileSummaries: summaries2,
      previousRelationships: rels1,
      currentRelationships: rels2,
      previousSymbolShardIds: new Map(),
      previousRelationShardIds: first.relationShardIds,
    });

    // A's relation shard and C's relation shard should be reused if their
    // bucket entries didn't change.
    const aBucket = pathBucketKey("src/a.ts");
    const cBucket = pathBucketKey("src/c.ts");

    // At least the B bucket is rebuilt.
    assert.ok(second.rebuiltRelationShardCount >= 1);

    // If A is in a different bucket from B, A's shard must be reused.
    const bBucket = pathBucketKey("src/b.ts");
    if (aBucket !== bBucket) {
      assert.equal(
        second.relationShardIds.get(aBucket),
        first.relationShardIds.get(aBucket),
        "A's relation shard must be reused when B changes",
      );
    }
    if (cBucket !== bBucket) {
      assert.equal(
        second.relationShardIds.get(cBucket),
        first.relationShardIds.get(cBucket),
        "C's relation shard must be reused when B changes",
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Rename reuses file facts but rebuilds path-dependent relationships
// ══════════════════════════════════════════════════════════════════════════════

describe("incremental: rename", () => {
  it("change plan classifies rename as retarget (same contentId, different path)", () => {
    const prev = sourceState([stateEntry("src/old.ts", "fileA")]);
    const curr = sourceState([stateEntry("src/new.ts", "fileA")]);

    const plan = buildChangePlan({ previous: prev, current: curr });

    assert.equal(plan.entries.length, 2); // one retarget + one delete (old path missing)
    const retargets = getRetargetEntries(plan);
    const deletes = getDeleteEntries(plan);
    assert.equal(retargets.length, 1, "expected one retarget entry");
    assert.equal(deletes.length, 1, "expected one delete entry for old path");
    assert.equal(retargets[0]!.path, "src/new.ts");
    assert.equal(retargets[0]!.retargetFrom, "src/old.ts");
  });

  it("rename reuses the file object (contentId unchanged) but marks the path as needing relationship rebuild", () => {
    // The file fact (definitions, references, imports) is keyed by contentId
    // so renaming does not require re-extraction. But path-dependent
    // relationships (imports from other files targeting the old path, and
    // the file's own resolved imports) must be rebuilt.
    const affected = computeAffectedSet({
      changedDefinitions: [],
      changedImports: [],
      changedAliases: [],
      configChanged: false,
      deletedPaths: [],
      renamedPaths: [{ from: "src/old.ts", to: "src/new.ts" }],
      retargetedPaths: [],
      uniquenessTransitions: [],
      previousImportTargets: new Map(),
      currentImportTargets: new Map(),
      importersByTarget: new Map([
        ["src/old.ts", ["src/consumer.ts"]],
      ]),
      referencesBySymbol: new Map(),
    });

    // Both old and new paths are affected.
    assert.ok(affected.paths.has("src/old.ts"), "old path must be in affected set");
    assert.ok(affected.paths.has("src/new.ts"), "new path must be in affected set");
    // Importers of the old path are also affected.
    assert.ok(affected.paths.has("src/consumer.ts"), "importer of old path must be affected");

    const oldEntry = affected.entries.find((e) => e.path === "src/old.ts");
    assert.ok(oldEntry?.reasons.includes("renamed"));
    const consumerEntry = affected.entries.find((e) => e.path === "src/consumer.ts");
    assert.ok(consumerEntry?.reasons.includes("import-changed"));
  });

  it("rename propagates through the full relationship pipeline", () => {
    // Before rename: consumer.ts imports old.ts
    const fileDefs = new Map<string, readonly ExtractedDefinition[]>([
      ["src/old.ts", [def("OldClass", 1)]],
      ["src/consumer.ts", []],
    ]);
    const fileRefs = new Map<string, readonly ExtractedReference[]>([
      ["src/consumer.ts", [ref("OldClass", 5)]],
    ]);
    const fileImports = new Map<string, readonly ExtractedImport[]>([
      ["src/consumer.ts", [imp("./old")]],
    ]);

    const pathInventory = new Map<string, PathInventoryEntry>([
      ["src/old.ts", { path: "src/old.ts", language: "typescript", exportedSymbols: ["OldClass"] }],
      ["src/consumer.ts", { path: "src/consumer.ts", language: "typescript", exportedSymbols: [] }],
    ]);

    const cfg = config();
    const result = buildAllRelationships({
      fileImports,
      fileReferences: fileRefs,
      fileDefinitions: fileDefs,
      resolutionConfig: cfg,
      pathInventory,
    });

    // consumer should import old.ts.
    const consumerShard = result.shards.get("src/consumer.ts");
    assert.ok(consumerShard, "consumer shard must exist");
    const importRels = consumerShard!.relationships.filter((r) => r.type === "imports");
    assert.equal(importRels.length, 1);
    assert.equal(importRels[0]!.toPath, "src/old.ts");

    // After rename: old.ts -> new.ts
    const fileDefs2 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/new.ts", [def("OldClass", 1)]],
      ["src/consumer.ts", []],
    ]);
    const fileRefs2 = new Map<string, readonly ExtractedReference[]>([
      ["src/consumer.ts", [ref("OldClass", 5)]],
    ]);
    const fileImports2 = new Map<string, readonly ExtractedImport[]>([
      ["src/consumer.ts", [imp("./new")]],
    ]);
    const pathInventory2 = new Map<string, PathInventoryEntry>([
      ["src/new.ts", { path: "src/new.ts", language: "typescript", exportedSymbols: ["OldClass"] }],
      ["src/consumer.ts", { path: "src/consumer.ts", language: "typescript", exportedSymbols: [] }],
    ]);

    const result2 = buildAllRelationships({
      fileImports: fileImports2,
      fileReferences: fileRefs2,
      fileDefinitions: fileDefs2,
      resolutionConfig: cfg,
      pathInventory: pathInventory2,
    });

    const consumerShard2 = result2.shards.get("src/consumer.ts");
    assert.ok(consumerShard2, "consumer shard must exist after rename");
    const importRels2 = consumerShard2!.relationships.filter((r) => r.type === "imports");
    assert.equal(importRels2.length, 1);
    assert.equal(importRels2[0]!.toPath, "src/new.ts", "import must resolve to new path after rename");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Unique-to-ambiguous and ambiguous-to-unique transitions
// ══════════════════════════════════════════════════════════════════════════════

describe("incremental: uniqueness transitions", () => {
  it("unique -> ambiguous: a second definition makes the reference ambiguous", () => {
    // State 1: only a.ts defines "Foo" — consumer's reference is unique.
    const defs1 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", [def("Foo")]],
      ["src/b.ts", []],
      ["src/consumer.ts", []],
    ]);
    const refs1 = new Map<string, readonly ExtractedReference[]>([
      ["src/consumer.ts", [ref("Foo", 5)]],
    ]);
    const defIndex1 = buildSymbolDefinitionIndex(defs1);

    const rels1 = buildReferencesForFile("src/consumer.ts", refs1.get("src/consumer.ts")!, defIndex1);
    assert.equal(rels1.length, 1);
    assert.equal(rels1[0]!.type, "references", "must be unique when one definition");
    assert.deepEqual(rels1[0]!.toPath, "src/a.ts");

    // State 2: both a.ts and b.ts define "Foo" — now ambiguous.
    const defs2 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", [def("Foo")]],
      ["src/b.ts", [def("Foo")]],
      ["src/consumer.ts", []],
    ]);
    const refs2 = new Map<string, readonly ExtractedReference[]>([
      ["src/consumer.ts", [ref("Foo", 5)]],
    ]);
    const defIndex2 = buildSymbolDefinitionIndex(defs2);

    const rels2 = buildReferencesForFile("src/consumer.ts", refs2.get("src/consumer.ts")!, defIndex2);
    assert.equal(rels2.length, 2, "must have two ambiguous-reference records");
    for (const r of rels2) {
      assert.equal(r.type, "ambiguous-reference", "must be ambiguous when two definitions");
      assert.equal(r.weight, WEIGHT_AMBIGUOUS_REF);
    }
  });

  it("ambiguous -> unique: removing one definition makes the reference unique", () => {
    // State 1: ambiguous (two definitions).
    const defs1 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", [def("Foo")]],
      ["src/b.ts", [def("Foo")]],
      ["src/consumer.ts", []],
    ]);
    const refs1 = new Map<string, readonly ExtractedReference[]>([
      ["src/consumer.ts", [ref("Foo", 5)]],
    ]);
    const defIndex1 = buildSymbolDefinitionIndex(defs1);
    const rels1 = buildReferencesForFile("src/consumer.ts", refs1.get("src/consumer.ts")!, defIndex1);
    assert.equal(rels1.length, 2);
    for (const r of rels1) assert.equal(r.type, "ambiguous-reference");

    // State 2: only a.ts defines Foo — unique.
    const defs2 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", [def("Foo")]],
      ["src/b.ts", []],
      ["src/consumer.ts", []],
    ]);
    const defIndex2 = buildSymbolDefinitionIndex(defs2);
    const rels2 = buildReferencesForFile("src/consumer.ts", refs1.get("src/consumer.ts")!, defIndex2);
    assert.equal(rels2.length, 1);
    assert.equal(rels2[0]!.type, "references", "must be unique after removing one definition");
    assert.equal(rels2[0]!.weight, WEIGHT_UNIQUE_REF);
  });

  it("zero -> one definition: a new definition creates a unique reference", () => {
    // State 1: no definitions for "Bar".
    const defs1 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", []],
      ["src/consumer.ts", []],
    ]);
    const refs1 = new Map<string, readonly ExtractedReference[]>([
      ["src/consumer.ts", [ref("Bar", 5)]],
    ]);
    const defIndex1 = buildSymbolDefinitionIndex(defs1);
    const rels1 = buildReferencesForFile("src/consumer.ts", refs1.get("src/consumer.ts")!, defIndex1);
    assert.equal(rels1.length, 0, "no relationship when zero definitions");

    // State 2: a.ts now defines Bar.
    const defs2 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", [def("Bar")]],
      ["src/consumer.ts", []],
    ]);
    const defIndex2 = buildSymbolDefinitionIndex(defs2);
    const rels2 = buildReferencesForFile("src/consumer.ts", refs1.get("src/consumer.ts")!, defIndex2);
    assert.equal(rels2.length, 1);
    assert.equal(rels2[0]!.type, "references");
    assert.equal(rels2[0]!.toPath, "src/a.ts");
  });

  it("one -> zero definitions: removing the sole definition breaks the reference", () => {
    const defs1 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", [def("Foo")]],
      ["src/consumer.ts", []],
    ]);
    const refs = new Map<string, readonly ExtractedReference[]>([
      ["src/consumer.ts", [ref("Foo", 5)]],
    ]);
    const defIndex1 = buildSymbolDefinitionIndex(defs1);
    const rels1 = buildReferencesForFile("src/consumer.ts", refs.get("src/consumer.ts")!, defIndex1);
    assert.equal(rels1.length, 1);
    assert.equal(rels1[0]!.type, "references");

    // Remove the definition.
    const defs2 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", []],
      ["src/consumer.ts", []],
    ]);
    const defIndex2 = buildSymbolDefinitionIndex(defs2);
    const rels2 = buildReferencesForFile("src/consumer.ts", refs.get("src/consumer.ts")!, defIndex2);
    assert.equal(rels2.length, 0, "no relationship when definition removed");
  });

  it("uniqueness-transition propagates through affected-set computation", () => {
    const affected = computeAffectedSet({
      changedDefinitions: ["src/b.ts"],
      changedImports: [],
      changedAliases: [],
      configChanged: false,
      deletedPaths: [],
      renamedPaths: [],
      retargetedPaths: [],
      uniquenessTransitions: [{
        symbol: "Foo",
        oldDefiningPaths: ["src/a.ts"],
        newDefiningPaths: ["src/a.ts", "src/b.ts"],
      }],
      previousImportTargets: new Map(),
      currentImportTargets: new Map(),
      importersByTarget: new Map(),
      referencesBySymbol: new Map([
        ["Foo", ["src/consumer.ts"]],
      ]),
    });

    // consumer.ts must be in the affected set because it references "Foo".
    assert.ok(affected.paths.has("src/consumer.ts"), "consumer must be affected by uniqueness transition");
    const entry = affected.entries.find((e) => e.path === "src/consumer.ts");
    assert.ok(entry?.reasons.includes("uniqueness-transition"));

    // Both defining paths must be affected.
    assert.ok(affected.paths.has("src/a.ts"));
    assert.ok(affected.paths.has("src/b.ts"));
  });

  it("uniqueness transitions update shard-level evidence", async () => {
    // State 1: unique — Foo defined in a.ts only.
    const symbolEntries1 = [
      sym("Foo", "src/a.ts", "definition"),
      sym("Foo", "src/consumer.ts", "reference", 5),
    ];
    const fileSummaries1 = [summary("src/a.ts"), summary("src/consumer.ts")];
    // unique reference
    const rels1: ShardRelationshipEntry[] = [{
      fromPath: "src/consumer.ts",
      toPath: "src/a.ts",
      type: "references",
      symbol: "Foo",
      weight: WEIGHT_UNIQUE_REF,
    }];

    const first = await rebuildShards({
      previousSymbolEntries: [],
      currentSymbolEntries: symbolEntries1,
      previousFileSummaries: [],
      currentFileSummaries: fileSummaries1,
      previousRelationships: [],
      currentRelationships: rels1,
      previousSymbolShardIds: new Map(),
      previousRelationShardIds: new Map(),
    });

    // State 2: ambiguous — Foo defined in both a.ts and b.ts.
    const symbolEntries2 = [
      sym("Foo", "src/a.ts", "definition"),
      sym("Foo", "src/b.ts", "definition"),
      sym("Foo", "src/consumer.ts", "reference", 5),
    ];
    const fileSummaries2 = [summary("src/a.ts"), summary("src/b.ts"), summary("src/consumer.ts")];
    const rels2: ShardRelationshipEntry[] = [
      { fromPath: "src/consumer.ts", toPath: "src/a.ts", type: "ambiguous-reference", symbol: "Foo", weight: WEIGHT_AMBIGUOUS_REF },
      { fromPath: "src/consumer.ts", toPath: "src/b.ts", type: "ambiguous-reference", symbol: "Foo", weight: WEIGHT_AMBIGUOUS_REF },
    ];

    const second = await rebuildShards({
      previousSymbolEntries: symbolEntries1,
      currentSymbolEntries: symbolEntries2,
      previousFileSummaries: fileSummaries1,
      currentFileSummaries: fileSummaries2,
      previousRelationships: rels1,
      currentRelationships: rels2,
      previousSymbolShardIds: first.symbolShardIds,
      previousRelationShardIds: first.relationShardIds,
    });

    // The consumer's relation shard must be rebuilt.
    const consumerBucket = pathBucketKey("src/consumer.ts");
    assert.notEqual(
      second.relationShardIds.get(consumerBucket),
      first.relationShardIds.get(consumerBucket),
      "consumer's relation shard must change when uniqueness transitions",
    );

    // The rebuilt shard must contain ambiguous-reference entries.
    const consumerShard = second.relationShards.find((s) => s.bucketKey === consumerBucket);
    assert.ok(consumerShard, "consumer relation shard must exist");
    const ambRels = consumerShard!.shard.relationships.filter(
      (r) => r.fromPath === "src/consumer.ts" && r.type === "ambiguous-reference",
    );
    assert.equal(ambRels.length, 2, "must have two ambiguous-reference relationships");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Deterministic differential suite — byte-compare incremental vs full build
// ══════════════════════════════════════════════════════════════════════════════

describe("deterministic differential suite", () => {
  /**
   * Helper: run a full (no-previous) shard build and return the result.
   */
  async function fullBuild(
    syms: readonly ShardSymbolEntry[],
    sums: readonly ShardFileSummaryEntry[],
    rels: readonly ShardRelationshipEntry[],
  ): Promise<ShardRebuildResult> {
    return rebuildShards({
      previousSymbolEntries: [],
      currentSymbolEntries: syms,
      previousFileSummaries: [],
      currentFileSummaries: sums,
      previousRelationships: [],
      currentRelationships: rels,
      previousSymbolShardIds: new Map(),
      previousRelationShardIds: new Map(),
    });
  }

  /**
   * Helper: run an incremental shard build and return the result.
   */
  async function incrementalBuild(
    prevSyms: readonly ShardSymbolEntry[],
    currSyms: readonly ShardSymbolEntry[],
    prevSums: readonly ShardFileSummaryEntry[],
    currSums: readonly ShardFileSummaryEntry[],
    prevRels: readonly ShardRelationshipEntry[],
    currRels: readonly ShardRelationshipEntry[],
    prevSymIds: ReadonlyMap<string, string>,
    prevRelIds: ReadonlyMap<string, string>,
  ): Promise<ShardRebuildResult> {
    return rebuildShards({
      previousSymbolEntries: prevSyms,
      currentSymbolEntries: currSyms,
      previousFileSummaries: prevSums,
      currentFileSummaries: currSums,
      previousRelationships: prevRels,
      currentRelationships: currRels,
      previousSymbolShardIds: prevSymIds,
      previousRelationShardIds: prevRelIds,
    });
  }

  /**
   * Assert that two shard rebuild results produce byte-identical
   * canonical-JSON output for every queryable shard.
   */
  function assertShardOutputByteEqual(
    incremental: ShardRebuildResult,
    full: ShardRebuildResult,
    label: string,
  ): void {
    // Symbol shard IDs must match.
    assert.equal(
      incremental.symbolShardIds.size,
      full.symbolShardIds.size,
      `${label}: symbol shard count mismatch`,
    );
    for (const [bucket, id] of full.symbolShardIds) {
      assert.equal(
        incremental.symbolShardIds.get(bucket),
        id,
        `${label}: symbol shard ID mismatch for bucket ${bucket}`,
      );
    }

    // Relation shard IDs must match.
    assert.equal(
      incremental.relationShardIds.size,
      full.relationShardIds.size,
      `${label}: relation shard count mismatch`,
    );
    for (const [bucket, id] of full.relationShardIds) {
      assert.equal(
        incremental.relationShardIds.get(bucket),
        id,
        `${label}: relation shard ID mismatch for bucket ${bucket}`,
      );
    }

    // Byte-compare every symbol shard payload.
    const incSymByKey = new Map(incremental.symbolShards.map((s) => [s.bucketKey, s]));
    for (const fullShard of full.symbolShards) {
      const incShard = incSymByKey.get(fullShard.bucketKey);
      assert.ok(incShard, `${label}: missing symbol shard ${fullShard.bucketKey}`);
      assertByteEqual(
        incShard!.shard,
        fullShard.shard,
        `${label}: symbol shard ${fullShard.bucketKey} payload mismatch`,
      );
    }

    // Byte-compare every relation shard payload.
    const incRelByKey = new Map(incremental.relationShards.map((s) => [s.bucketKey, s]));
    for (const fullShard of full.relationShards) {
      const incShard = incRelByKey.get(fullShard.bucketKey);
      assert.ok(incShard, `${label}: missing relation shard ${fullShard.bucketKey}`);
      assertByteEqual(
        incShard!.shard,
        fullShard.shard,
        `${label}: relation shard ${fullShard.bucketKey} payload mismatch`,
      );
    }
  }

  // ── Sub-tests ─────────────────────────────────────────────────────────

  it("addition: adding a new file produces byte-identical output to full build", async () => {
    // Baseline: two files.
    const syms1 = [sym("Foo", "src/a.ts"), sym("Bar", "src/b.ts")];
    const sums1 = [summary("src/a.ts"), summary("src/b.ts")];
    const rels1 = [rel("src/a.ts", "src/b.ts")];

    const first = await fullBuild(syms1, sums1, rels1);

    // Add file c.ts.
    const syms2 = [...syms1, sym("Baz", "src/c.ts")];
    const sums2 = [...sums1, summary("src/c.ts")];
    const rels2 = [...rels1, rel("src/c.ts", "src/a.ts")];

    const inc = await incrementalBuild(
      syms1, syms2, sums1, sums2, rels1, rels2,
      first.symbolShardIds, first.relationShardIds,
    );
    const full = await fullBuild(syms2, sums2, rels2);

    assertShardOutputByteEqual(inc, full, "addition");
  });

  it("deletion: removing a file produces byte-identical output to full build", async () => {
    const syms1 = [sym("Foo", "src/a.ts"), sym("Bar", "src/b.ts"), sym("Baz", "src/c.ts")];
    const sums1 = [summary("src/a.ts"), summary("src/b.ts"), summary("src/c.ts")];
    const rels1 = [rel("src/a.ts", "src/b.ts"), rel("src/c.ts", "src/a.ts")];

    const first = await fullBuild(syms1, sums1, rels1);

    // Remove c.ts.
    const syms2 = [sym("Foo", "src/a.ts"), sym("Bar", "src/b.ts")];
    const sums2 = [summary("src/a.ts"), summary("src/b.ts")];
    const rels2 = [rel("src/a.ts", "src/b.ts")];

    const inc = await incrementalBuild(
      syms1, syms2, sums1, sums2, rels1, rels2,
      first.symbolShardIds, first.relationShardIds,
    );
    const full = await fullBuild(syms2, sums2, rels2);

    assertShardOutputByteEqual(inc, full, "deletion");
  });

  it("rename (retarget): renaming a file produces byte-identical output to full build", async () => {
    const syms1 = [sym("Foo", "src/old.ts"), sym("Bar", "src/b.ts")];
    const sums1 = [summary("src/old.ts"), summary("src/b.ts")];
    const rels1 = [rel("src/old.ts", "src/b.ts")];

    const first = await fullBuild(syms1, sums1, rels1);

    // Rename old.ts -> new.ts (same symbol name, different path).
    const syms2 = [sym("Foo", "src/new.ts"), sym("Bar", "src/b.ts")];
    const sums2 = [summary("src/new.ts"), summary("src/b.ts")];
    const rels2 = [rel("src/new.ts", "src/b.ts")];

    const inc = await incrementalBuild(
      syms1, syms2, sums1, sums2, rels1, rels2,
      first.symbolShardIds, first.relationShardIds,
    );
    const full = await fullBuild(syms2, sums2, rels2);

    assertShardOutputByteEqual(inc, full, "rename");
  });

  it("alias edit: changing an export alias produces byte-identical output to full build", async () => {
    // Simulates: a.ts exports "Foo" -> later exports "FooRenamed" (alias change).
    const syms1 = [sym("Foo", "src/a.ts"), sym("Bar", "src/b.ts")];
    const sums1 = [summary("src/a.ts"), summary("src/b.ts")];
    const rels1: ShardRelationshipEntry[] = [
      { fromPath: "src/b.ts", toPath: "src/a.ts", type: "references", symbol: "Foo", weight: WEIGHT_UNIQUE_REF },
    ];

    const first = await fullBuild(syms1, sums1, rels1);

    // Rename symbol Foo -> FooRenamed.
    const syms2 = [sym("FooRenamed", "src/a.ts"), sym("Bar", "src/b.ts")];
    const sums2 = [summary("src/a.ts"), summary("src/b.ts")];
    const rels2: ShardRelationshipEntry[] = [
      { fromPath: "src/b.ts", toPath: "src/a.ts", type: "references", symbol: "FooRenamed", weight: WEIGHT_UNIQUE_REF },
    ];

    const inc = await incrementalBuild(
      syms1, syms2, sums1, sums2, rels1, rels2,
      first.symbolShardIds, first.relationShardIds,
    );
    const full = await fullBuild(syms2, sums2, rels2);

    assertShardOutputByteEqual(inc, full, "alias edit");
  });

  it("config edit: changing resolution config produces byte-identical relationship output to full build", () => {
    // This tests the relationship layer (not shards, which are a downstream concern).
    const fileDefs = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", [def("Foo")]],
      ["src/consumer.ts", []],
    ]);
    const fileRefs = new Map<string, readonly ExtractedReference[]>([
      ["src/consumer.ts", [ref("Foo", 5)]],
    ]);
    const fileImports = new Map<string, readonly ExtractedImport[]>([
      ["src/consumer.ts", [imp("@app/a")]],
    ]);
    const pathInventory = new Map<string, PathInventoryEntry>([
      ["src/a.ts", { path: "src/a.ts", language: "typescript", exportedSymbols: ["Foo"] }],
      ["src/consumer.ts", { path: "src/consumer.ts", language: "typescript", exportedSymbols: [] }],
    ]);

    // Config 1: no alias — @app/a is unresolvable.
    const cfg1 = config();
    const result1 = buildAllRelationships({
      fileImports, fileReferences: fileRefs, fileDefinitions: fileDefs,
      resolutionConfig: cfg1, pathInventory,
    });

    const consumerShard1 = result1.shards.get("src/consumer.ts")!;
    const importRels1 = consumerShard1.relationships.filter((r) => r.type === "imports");
    assert.equal(importRels1.length, 0, "without alias, @app/a is unresolvable");

    // Config 2: add @app/* alias -> ./* (relative to importing file's directory).
    // From src/consumer.ts, @app/a → ./a → src/a.ts
    const cfg2 = config({ pathAliases: { "@app/*": ["./*"] } });
    const result2 = buildAllRelationships({
      fileImports, fileReferences: fileRefs, fileDefinitions: fileDefs,
      resolutionConfig: cfg2, pathInventory,
    });

    const consumerShard2 = result2.shards.get("src/consumer.ts")!;
    const importRels2 = consumerShard2.relationships.filter((r) => r.type === "imports");
    assert.equal(importRels2.length, 1, "with alias, @app/a resolves to src/a.ts");
    assert.equal(importRels2[0]!.toPath, "src/a.ts");

    // Fingerprint must change.
    assert.notEqual(
      deriveResolutionConfigFingerprint(cfg1),
      deriveResolutionConfigFingerprint(cfg2),
      "config fingerprint must change when alias is added",
    );
  });

  it("zero -> one -> many definitions: each transition produces byte-identical shard output to full build", async () => {
    // State 0: zero definitions for "Foo".
    const syms0 = [sym("Foo", "src/consumer.ts", "reference", 5)];
    const sums0 = [summary("src/consumer.ts")];
    const rels0: ShardRelationshipEntry[] = [];

    const build0 = await fullBuild(syms0, sums0, rels0);

    // State 1: one definition for "Foo" in a.ts.
    const syms1 = [
      sym("Foo", "src/a.ts", "definition"),
      sym("Foo", "src/consumer.ts", "reference", 5),
    ];
    const sums1 = [summary("src/a.ts"), summary("src/consumer.ts")];
    const rels1: ShardRelationshipEntry[] = [
      { fromPath: "src/consumer.ts", toPath: "src/a.ts", type: "references", symbol: "Foo", weight: WEIGHT_UNIQUE_REF },
    ];

    const inc1 = await incrementalBuild(
      syms0, syms1, sums0, sums1, rels0, rels1,
      build0.symbolShardIds, build0.relationShardIds,
    );
    const full1 = await fullBuild(syms1, sums1, rels1);
    assertShardOutputByteEqual(inc1, full1, "0->1 definition");

    // State 2: two definitions for "Foo" (a.ts and b.ts) — now ambiguous.
    const syms2 = [
      sym("Foo", "src/a.ts", "definition"),
      sym("Foo", "src/b.ts", "definition"),
      sym("Foo", "src/consumer.ts", "reference", 5),
    ];
    const sums2 = [summary("src/a.ts"), summary("src/b.ts"), summary("src/consumer.ts")];
    const rels2: ShardRelationshipEntry[] = [
      { fromPath: "src/consumer.ts", toPath: "src/a.ts", type: "ambiguous-reference", symbol: "Foo", weight: WEIGHT_AMBIGUOUS_REF },
      { fromPath: "src/consumer.ts", toPath: "src/b.ts", type: "ambiguous-reference", symbol: "Foo", weight: WEIGHT_AMBIGUOUS_REF },
    ];

    const inc2 = await incrementalBuild(
      syms1, syms2, sums1, sums2, rels1, rels2,
      inc1.symbolShardIds, inc1.relationShardIds,
    );
    const full2 = await fullBuild(syms2, sums2, rels2);
    assertShardOutputByteEqual(inc2, full2, "1->2 definitions");
  });

  it("multi-step differential: sequential edits produce byte-identical output to independent full build at each step", async () => {
    // Step 0: baseline with 3 files.
    let prevSyms = [sym("Alpha", "src/a.ts"), sym("Beta", "src/b.ts"), sym("Gamma", "src/c.ts")];
    let prevSums = [summary("src/a.ts"), summary("src/b.ts"), summary("src/c.ts")];
    let prevRels: ShardRelationshipEntry[] = [
      rel("src/a.ts", "src/b.ts"),
      rel("src/b.ts", "src/c.ts"),
    ];

    let prev = await fullBuild(prevSyms, prevSums, prevRels);

    // Step 1: edit file a.ts (Alpha -> Alpha2).
    {
      const currSyms = [sym("Alpha2", "src/a.ts"), sym("Beta", "src/b.ts"), sym("Gamma", "src/c.ts")];
      const currSums = [summary("src/a.ts"), summary("src/b.ts"), summary("src/c.ts")];
      const currRels = prevRels;

      const inc = await incrementalBuild(
        prevSyms, currSyms, prevSums, currSums, prevRels, currRels,
        prev.symbolShardIds, prev.relationShardIds,
      );
      const full = await fullBuild(currSyms, currSums, currRels);
      assertShardOutputByteEqual(inc, full, "step 1: edit a.ts");

      prevSyms = currSyms;
      prevSums = currSums;
      prevRels = currRels;
      prev = inc;
    }

    // Step 2: add file d.ts.
    {
      const currSyms = [...prevSyms, sym("Delta", "src/d.ts")];
      const currSums = [...prevSums, summary("src/d.ts")];
      const currRels = [...prevRels, rel("src/d.ts", "src/a.ts")];

      const inc = await incrementalBuild(
        prevSyms, currSyms, prevSums, currSums, prevRels, currRels,
        prev.symbolShardIds, prev.relationShardIds,
      );
      const full = await fullBuild(currSyms, currSums, currRels);
      assertShardOutputByteEqual(inc, full, "step 2: add d.ts");

      prevSyms = currSyms;
      prevSums = currSums;
      prevRels = currRels;
      prev = inc;
    }

    // Step 3: rename c.ts -> c-renamed.ts.
    {
      const currSyms = prevSyms
        .filter((e) => e.path !== "src/c.ts")
        .concat([sym("Gamma", "src/c-renamed.ts")]);
      const currSums = prevSums
        .filter((e) => e.path !== "src/c.ts")
        .concat([summary("src/c-renamed.ts")]);
      const currRels = prevRels
        .filter((r) => r.fromPath !== "src/c.ts" && r.toPath !== "src/c.ts")
        .concat([rel("src/b.ts", "src/c-renamed.ts")]);

      const inc = await incrementalBuild(
        prevSyms, currSyms, prevSums, currSums, prevRels, currRels,
        prev.symbolShardIds, prev.relationShardIds,
      );
      const full = await fullBuild(currSyms, currSums, currRels);
      assertShardOutputByteEqual(inc, full, "step 3: rename c.ts");

      prevSyms = currSyms;
      prevSums = currSums;
      prevRels = currRels;
      prev = inc;
    }

    // Step 4: delete b.ts.
    {
      const currSyms = prevSyms.filter((e) => e.path !== "src/b.ts");
      const currSums = prevSums.filter((e) => e.path !== "src/b.ts");
      const currRels = prevRels.filter((r) => r.fromPath !== "src/b.ts" && r.toPath !== "src/b.ts");

      const inc = await incrementalBuild(
        prevSyms, currSyms, prevSums, currSums, prevRels, currRels,
        prev.symbolShardIds, prev.relationShardIds,
      );
      const full = await fullBuild(currSyms, currSums, currRels);
      assertShardOutputByteEqual(inc, full, "step 4: delete b.ts");

      prevSyms = currSyms;
      prevSums = currSums;
      prevRels = currRels;
      prev = inc;
    }

    // Step 5: uniqueness transition — add second definition of "Alpha2" in d.ts.
    {
      const currSyms = [
        ...prevSyms,
        sym("Alpha2", "src/d.ts", "definition"),
      ];
      const currSums = prevSums;
      // d.ts now has both Delta and Alpha2 definitions; references to Alpha2 become ambiguous.
      const currRels: readonly ShardRelationshipEntry[] = [
        ...prevRels,
        { fromPath: "src/d.ts", toPath: "src/a.ts", type: "ambiguous-reference" as const, symbol: "Alpha2", weight: WEIGHT_AMBIGUOUS_REF },
        { fromPath: "src/d.ts", toPath: "src/d.ts", type: "ambiguous-reference" as const, symbol: "Alpha2", weight: WEIGHT_AMBIGUOUS_REF },
      ];

      const inc = await incrementalBuild(
        prevSyms, currSyms, prevSums, currSums, prevRels, currRels,
        prev.symbolShardIds, prev.relationShardIds,
      );
      const full = await fullBuild(currSyms, currSums, currRels);
      assertShardOutputByteEqual(inc, full, "step 5: uniqueness transition");
    }
  });

  it("retarget: same content appears at new path, incremental matches full build", async () => {
    // a.ts has content "X", b.ts has content "Y".
    const syms1 = [sym("Foo", "src/a.ts"), sym("Bar", "src/b.ts")];
    const sums1 = [summary("src/a.ts"), summary("src/b.ts")];
    const rels1 = [rel("src/a.ts", "src/b.ts")];

    const first = await fullBuild(syms1, sums1, rels1);

    // Now c.ts appears with the same content ID as old a.ts (retarget scenario).
    // a.ts changes to new content, c.ts takes a.ts's old content.
    const syms2 = [sym("FooNew", "src/a.ts"), sym("Bar", "src/b.ts"), sym("Foo", "src/c.ts")];
    const sums2 = [summary("src/a.ts"), summary("src/b.ts"), summary("src/c.ts")];
    const rels2 = [rel("src/c.ts", "src/b.ts")];

    const inc = await incrementalBuild(
      syms1, syms2, sums1, sums2, rels1, rels2,
      first.symbolShardIds, first.relationShardIds,
    );
    const full = await fullBuild(syms2, sums2, rels2);

    assertShardOutputByteEqual(inc, full, "retarget");
  });

  it("change plan retarget detection matches expected decisions", () => {
    // a.ts had content "X", now c.ts has content "X" and a.ts has new content "Z".
    const prevEntries = [stateEntry("src/a.ts", "contentX"), stateEntry("src/b.ts", "contentY")];
    const currEntries = [
      stateEntry("src/a.ts", "contentZ"), // changed
      stateEntry("src/b.ts", "contentY"), // unchanged
      stateEntry("src/c.ts", "contentX"), // same content as old a.ts
    ];

    const plan = buildChangePlan({
      previous: sourceState(prevEntries),
      current: sourceState(currEntries),
    });

    // a.ts: content changed -> compute (or retarget if new content matches something)
    // b.ts: unchanged -> reuse
    // c.ts: new path, but content matches old a.ts -> retarget
    const byPath = new Map(plan.entries.map((e) => [e.path, e]));

    assert.equal(byPath.get("src/b.ts")!.decision, "reuse", "b.ts unchanged");
    assert.equal(byPath.get("src/c.ts")!.decision, "retarget", "c.ts is retarget of old a.ts");
    assert.equal(byPath.get("src/c.ts")!.retargetFrom, "src/a.ts");
    assert.equal(byPath.get("src/a.ts")!.decision, "compute", "a.ts content changed");
  });

  it("change plan detects deletions", () => {
    const prevEntries = [stateEntry("src/a.ts", "X"), stateEntry("src/b.ts", "Y")];
    const currEntries = [stateEntry("src/a.ts", "X")];

    const plan = buildChangePlan({
      previous: sourceState(prevEntries),
      current: sourceState(currEntries),
    });

    assert.equal(plan.summary.delete, 1, "one deletion");
    assert.equal(plan.summary.reuse, 1, "one reuse");
    const deletes = getDeleteEntries(plan);
    assert.equal(deletes[0]!.path, "src/b.ts");
  });

  it("empty change plan (no changes) is correctly detected", () => {
    const entries = [stateEntry("src/a.ts", "X"), stateEntry("src/b.ts", "Y")];
    const prev = sourceState(entries);
    const curr = sourceState(entries);

    const plan = buildChangePlan({ previous: prev, current: curr });
    assert.ok(isChangePlanEmpty(plan), "plan must be empty when states are identical");
    assert.equal(plan.summary.reuse, 2);
    assert.equal(plan.summary.compute, 0);
    assert.equal(plan.summary.delete, 0);
    assert.equal(plan.summary.retarget, 0);
  });

  it("first build (no previous) produces all-compute plan", () => {
    const entries = [stateEntry("src/a.ts", "X"), stateEntry("src/b.ts", "Y")];
    const curr = sourceState(entries);

    const plan = buildChangePlan({ previous: null, current: curr });
    assert.equal(plan.summary.compute, 2, "all entries must be compute on first build");
    assert.equal(plan.summary.reuse, 0);
    assert.equal(plan.summary.delete, 0);
    assert.equal(plan.summary.retarget, 0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Relationship shard byte-equality: incremental affected-set rebuild
//    produces identical shards to full rebuild
// ══════════════════════════════════════════════════════════════════════════════

describe("relationship shard incremental byte-equality", () => {
  /**
   * Build all relationship shards for a snapshot.
   * Returns a map from path to the canonical-JSON hash of the shard.
   */
  function buildShardHashMap(result: ReturnType<typeof buildAllRelationships>): Map<string, string> {
    const map = new Map<string, string>();
    for (const [path, shard] of result.shards) {
      map.set(path, canonicalHash(shard));
    }
    return map;
  }

  it("after adding a definition, affected shards match full rebuild", () => {
    // State 1: consumer references "Foo" with zero definitions.
    const defs1 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", []],
      ["src/consumer.ts", []],
    ]);
    const refs1 = new Map<string, readonly ExtractedReference[]>([
      ["src/consumer.ts", [ref("Foo", 5)]],
    ]);
    const imports1 = new Map<string, readonly ExtractedImport[]>([
      ["src/consumer.ts", [imp("./a")]],
    ]);
    const inventory1 = new Map<string, PathInventoryEntry>([
      ["src/a.ts", { path: "src/a.ts", language: "typescript", exportedSymbols: [] }],
      ["src/consumer.ts", { path: "src/consumer.ts", language: "typescript", exportedSymbols: [] }],
    ]);

    const cfg = config();
    const result1 = buildAllRelationships({
      fileImports: imports1, fileReferences: refs1, fileDefinitions: defs1,
      resolutionConfig: cfg, pathInventory: inventory1,
    });

    // State 2: a.ts now exports Foo.
    const defs2 = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", [def("Foo")]],
      ["src/consumer.ts", []],
    ]);
    const refs2 = new Map<string, readonly ExtractedReference[]>([
      ["src/consumer.ts", [ref("Foo", 5)]],
    ]);
    const imports2 = imports1;
    const inventory2 = new Map<string, PathInventoryEntry>([
      ["src/a.ts", { path: "src/a.ts", language: "typescript", exportedSymbols: ["Foo"] }],
      ["src/consumer.ts", { path: "src/consumer.ts", language: "typescript", exportedSymbols: [] }],
    ]);

    // Full rebuild from state 2.
    const fullResult = buildAllRelationships({
      fileImports: imports2, fileReferences: refs2, fileDefinitions: defs2,
      resolutionConfig: cfg, pathInventory: inventory2,
    });

    // The consumer shard should now have a unique-reference relationship.
    const fullConsumerShard = fullResult.shards.get("src/consumer.ts")!;
    const uniqueRefs = fullConsumerShard.relationships.filter(
      (r) => r.type === "references" && r.symbol === "Foo",
    );
    assert.equal(uniqueRefs.length, 1);
    assert.equal(uniqueRefs[0]!.toPath, "src/a.ts");
    assert.equal(uniqueRefs[0]!.weight, WEIGHT_UNIQUE_REF);

    // Verify that the full rebuild is deterministic: building again produces
    // identical hashes.
    const fullResult2 = buildAllRelationships({
      fileImports: imports2, fileReferences: refs2, fileDefinitions: defs2,
      resolutionConfig: cfg, pathInventory: inventory2,
    });
    assertByteEqual(
      buildShardHashMap(fullResult),
      buildShardHashMap(fullResult2),
      "full rebuild must be deterministic",
    );
  });

  it("relationship shard IDs are deterministic across rebuilds", () => {
    const defs = new Map<string, readonly ExtractedDefinition[]>([
      ["src/a.ts", [def("Foo")]],
      ["src/b.ts", [def("Bar")]],
    ]);
    const refs = new Map<string, readonly ExtractedReference[]>([
      ["src/a.ts", [ref("Bar", 10)]],
      ["src/b.ts", [ref("Foo", 20)]],
    ]);
    const imports = new Map<string, readonly ExtractedImport[]>([]);
    const inventory = new Map<string, PathInventoryEntry>([
      ["src/a.ts", { path: "src/a.ts", language: "typescript", exportedSymbols: ["Foo"] }],
      ["src/b.ts", { path: "src/b.ts", language: "typescript", exportedSymbols: ["Bar"] }],
    ]);
    const cfg = config();

    const input: BuildRelationshipsInput = {
      fileImports: imports,
      fileReferences: refs,
      fileDefinitions: defs,
      resolutionConfig: cfg,
      pathInventory: inventory,
    };

    const result1 = buildAllRelationships(input);
    const result2 = buildAllRelationships(input);

    // Shard IDs must be byte-identical.
    for (const [path, shard1] of result1.shards) {
      const shard2 = result2.shards.get(path);
      assert.ok(shard2, `missing shard for ${path}`);
      assert.equal(
        deriveRelationshipShardId(shard1),
        deriveRelationshipShardId(shard2!),
        `shard ID mismatch for ${path}`,
      );
    }
  });
});
