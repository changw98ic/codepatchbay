/**
 * Tests for local-code-index import resolution and evidence graph construction.
 *
 * Covers:
 *   - relative import resolution (./, ../)
 *   - bare specifier resolution (suffix matching)
 *   - path alias resolution
 *   - extension and index-file fallback
 *   - unresolvable imports produce null
 *   - symbol definition index construction (exported only)
 *   - reference classification (unique vs ambiguous)
 *   - evidence deduplication
 *   - relationship shard construction (imports + references)
 *   - content-addressed shard ID derivation
 *   - affected-set invalidation rules
 *   - full buildAllRelationships pipeline
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  ResolutionConfig,
  PathInventoryEntry,
  RelationshipShard,
  AffectedSetInput,
} from "../core/indexing/local-code-index/relationships.js";

import {
  deriveResolutionConfigFingerprint,
  buildSymbolDefinitionIndex,
  resolveImportsForFile,
  resolveAllImports,
  buildReferencesForFile,
  buildAllReferences,
  buildRelationshipShard,
  buildAllRelationshipShards,
  deriveRelationshipShardId,
  computeAffectedSet,
  buildAllRelationships,
  WEIGHT_IMPORT,
  WEIGHT_UNIQUE_REF,
  WEIGHT_AMBIGUOUS_REF,
} from "../core/indexing/local-code-index/relationships.js";

import type {
  ExtractedImport,
  ExtractedReference,
  ExtractedDefinition,
} from "../core/indexing/local-code-index/extract.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function range(sl: number, sc: number, el: number, ec: number) {
  return { startLine: sl, startColumn: sc, endLine: el, endColumn: ec };
}

function makeImport(
  requested: string,
  sl = 1,
  sc = 1,
  el = 1,
  ec = 20,
  importKind: ExtractedImport["importKind"] = "esm",
): ExtractedImport {
  return { requested, range: range(sl, sc, el, ec), importKind };
}

function makeRef(
  name: string,
  sl = 2,
  sc = 1,
  el = 2,
  ec = 10,
  referenceKind: ExtractedReference["referenceKind"] = "unknown",
): ExtractedReference {
  return { name, range: range(sl, sc, el, ec), referenceKind };
}

function makeDef(
  name: string,
  kind = "function",
  exported = true,
  sl = 1,
  sc = 1,
  el = 1,
  ec = 30,
): ExtractedDefinition {
  return { name, kind, range: range(sl, sc, el, ec), exported, signature: null };
}

const TS_CONFIG: ResolutionConfig = {
  language: "typescript",
  version: 1,
  moduleResolution: "node",
  baseUrl: null,
  pathAliases: {},
  extensions: [".ts", ".js", ".tsx", ".jsx"],
  indexFiles: ["index.ts", "index.js"],
  packageFields: [],
};

function fingerprint(config: ResolutionConfig = TS_CONFIG): string {
  return deriveResolutionConfigFingerprint(config);
}

function pathEntry(
  path: string,
  language = "typescript",
  exportedSymbols: string[] = [],
): [string, PathInventoryEntry] {
  return [path, { path, language, exportedSymbols }];
}

function makePathIndex(
  entries: Array<[string, PathInventoryEntry]>,
): Map<string, PathInventoryEntry> {
  return new Map(entries);
}

// ── Resolution config fingerprint ────────────────────────────────────────────

test("deriveResolutionConfigFingerprint produces stable 32-hex string", () => {
  const fp1 = deriveResolutionConfigFingerprint(TS_CONFIG);
  const fp2 = deriveResolutionConfigFingerprint(TS_CONFIG);
  assert.equal(fp1, fp2);
  assert.equal(fp1.length, 32);
  assert.match(fp1, /^[0-9a-f]{32}$/);
});

test("fingerprint changes when config fields change", () => {
  const fp1 = deriveResolutionConfigFingerprint(TS_CONFIG);
  const fp2 = deriveResolutionConfigFingerprint({
    ...TS_CONFIG,
    moduleResolution: "bundler",
  });
  assert.notEqual(fp1, fp2);
});

test("fingerprint changes when extensions order changes", () => {
  const fp1 = deriveResolutionConfigFingerprint(TS_CONFIG);
  const fp2 = deriveResolutionConfigFingerprint({
    ...TS_CONFIG,
    extensions: [".js", ".ts"],
  });
  assert.notEqual(fp1, fp2);
});

// ── Relative import resolution ───────────────────────────────────────────────

test("resolveImportsForFile resolves ./ sibling import", () => {
  const imports = [makeImport("./utils")];
  const pathIndex = makePathIndex([
    pathEntry("src/utils.ts"),
    pathEntry("src/app.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, "src/utils.ts");
  assert.equal(results[0]!.requested, "./utils");
});

test("resolveImportsForFile resolves ../ parent-relative import", () => {
  const imports = [makeImport("../types")];
  const pathIndex = makePathIndex([
    pathEntry("src/types.ts"),
    pathEntry("src/components/button.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/components/button.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, "src/types.ts");
});

test("resolveImportsForFile resolves extension-less import by trying extensions", () => {
  const imports = [makeImport("./helper")];
  const pathIndex = makePathIndex([
    pathEntry("src/helper.js"), // only .js exists
    pathEntry("src/main.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/main.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, "src/helper.js");
});

test("resolveImportsForFile resolves directory import via index file", () => {
  const imports = [makeImport("./lib")];
  const pathIndex = makePathIndex([
    pathEntry("src/lib/index.ts"),
    pathEntry("src/main.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/main.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, "src/lib/index.ts");
});

test("resolveImportsForFile resolves direct path with extension", () => {
  const imports = [makeImport("./config.json")];
  const pathIndex = makePathIndex([
    pathEntry("src/config.json", "json"),
    pathEntry("src/app.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, "src/config.json");
});

// ── Bare specifier resolution ────────────────────────────────────────────────

test("resolveImportsForFile resolves bare specifier by suffix match", () => {
  const imports = [makeImport("utils")];
  const pathIndex = makePathIndex([
    pathEntry("src/utils.ts"),
    pathEntry("src/app.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, "src/utils.ts");
});

test("resolveImportsForFile resolves bare specifier with extension", () => {
  const imports = [makeImport("config")];
  const pathIndex = makePathIndex([
    pathEntry("config.ts"),
    pathEntry("src/app.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, "config.ts");
});

// ── Path alias resolution ────────────────────────────────────────────────────

test("resolveImportsForFile resolves path alias", () => {
  // Alias targets are resolved relative to the importing file's directory.
  // From src/app.ts, @app/utils → ./* → ./utils → src/utils.ts
  const configWithAlias: ResolutionConfig = {
    ...TS_CONFIG,
    pathAliases: { "@app/*": ["./*"] },
  };

  const imports = [makeImport("@app/utils")];
  const pathIndex = makePathIndex([
    pathEntry("src/utils.ts"),
    pathEntry("src/app.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    configWithAlias,
    deriveResolutionConfigFingerprint(configWithAlias),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, "src/utils.ts");
});

test("resolveImportsForFile tries multiple alias targets", () => {
  const configWithAliases: ResolutionConfig = {
    ...TS_CONFIG,
    pathAliases: { "@lib/*": ["./lib/*", "./src/lib/*"] },
  };

  const imports = [makeImport("@lib/helpers")];
  const pathIndex = makePathIndex([
    pathEntry("src/lib/helpers.ts"),
    pathEntry("src/app.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    configWithAliases,
    deriveResolutionConfigFingerprint(configWithAliases),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, "src/lib/helpers.ts");
});

// ── Unresolvable imports ────────────────────────────────────────────────────

test("resolveImportsForFile returns null for external package imports", () => {
  const imports = [makeImport("lodash")];
  const pathIndex = makePathIndex([
    pathEntry("src/app.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, null);
  assert.equal(results[0]!.requested, "lodash");
});

test("resolveImportsForFile returns null for nonexistent relative import", () => {
  const imports = [makeImport("./nonexistent")];
  const pathIndex = makePathIndex([
    pathEntry("src/app.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0]!.resolvedPath, null);
});

// ── Multiple imports in one file ─────────────────────────────────────────────

test("resolveImportsForFile handles multiple imports in a single file", () => {
  const imports = [
    makeImport("./utils", 1, 1, 1, 20),
    makeImport("./config", 2, 1, 2, 22),
    makeImport("lodash", 3, 1, 3, 18),
  ];
  const pathIndex = makePathIndex([
    pathEntry("src/utils.ts"),
    pathEntry("src/config.ts"),
    pathEntry("src/app.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results.length, 3);
  assert.equal(results[0]!.resolvedPath, "src/utils.ts");
  assert.equal(results[1]!.resolvedPath, "src/config.ts");
  assert.equal(results[2]!.resolvedPath, null); // lodash is external
});

// ── resolveAllImports ────────────────────────────────────────────────────────

test("resolveAllImports processes all files in the snapshot", () => {
  const fileImports = new Map([
    ["src/a.ts", [makeImport("./b")]],
    ["src/b.ts", [makeImport("./a")]],
  ]);
  const pathIndex = makePathIndex([
    pathEntry("src/a.ts"),
    pathEntry("src/b.ts"),
  ]);

  const results = resolveAllImports(fileImports, TS_CONFIG, pathIndex);

  assert.equal(results.size, 2);
  assert.equal(results.get("src/a.ts")![0]!.resolvedPath, "src/b.ts");
  assert.equal(results.get("src/b.ts")![0]!.resolvedPath, "src/a.ts");
});

// ── Import resolution config fingerprint in results ──────────────────────────

test("resolved imports carry the resolution config fingerprint", () => {
  const imports = [makeImport("./utils")];
  const pathIndex = makePathIndex([
    pathEntry("src/utils.ts"),
    pathEntry("src/app.ts"),
  ]);
  const fp = fingerprint();

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    TS_CONFIG,
    fp,
    pathIndex,
  );

  assert.equal(results[0]!.resolutionConfigFingerprint, fp);
});

test("resolved imports preserve import kind from extraction", () => {
  const imports = [
    makeImport("./a", 1, 1, 1, 15, "esm"),
    makeImport("./b", 2, 1, 2, 15, "dynamic"),
    makeImport("./c", 3, 1, 3, 15, "type-only"),
  ];
  const pathIndex = makePathIndex([
    pathEntry("src/a.ts"),
    pathEntry("src/b.ts"),
    pathEntry("src/c.ts"),
    pathEntry("src/app.ts"),
  ]);

  const results = resolveImportsForFile(
    "src/app.ts",
    imports,
    TS_CONFIG,
    fingerprint(),
    pathIndex,
  );

  assert.equal(results[0]!.importKind, "esm");
  assert.equal(results[1]!.importKind, "dynamic");
  assert.equal(results[2]!.importKind, "type-only");
});

// ── Symbol definition index ──────────────────────────────────────────────────

test("buildSymbolDefinitionIndex includes only exported definitions", () => {
  const files = new Map([
    [
      "src/a.ts",
      [
        makeDef("foo", "function", true),
        makeDef("bar", "function", false), // not exported
      ],
    ],
    [
      "src/b.ts",
      [makeDef("baz", "class", true)],
    ],
  ]);

  const index = buildSymbolDefinitionIndex(files);

  assert.ok(index.has("foo"));
  assert.ok(index.has("baz"));
  assert.ok(!index.has("bar")); // non-exported excluded
});

test("buildSymbolDefinitionIndex groups multiple definitions of same name", () => {
  const files = new Map([
    ["src/a.ts", [makeDef("shared", "function", true)]],
    ["src/b.ts", [makeDef("shared", "function", true)]],
  ]);

  const index = buildSymbolDefinitionIndex(files);

  const entries = index.get("shared")!;
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.path, "src/a.ts");
  assert.equal(entries[1]!.path, "src/b.ts");
});

test("buildSymbolDefinitionIndex returns empty map for no exported defs", () => {
  const files = new Map([
    ["src/a.ts", [makeDef("local", "function", false)]],
  ]);

  const index = buildSymbolDefinitionIndex(files);
  assert.equal(index.size, 0);
});

// ── Reference classification ────────────────────────────────────────────────

test("buildReferencesForFile produces unique reference for single definition", () => {
  const files = new Map([
    ["src/utils.ts", [makeDef("helper", "function", true)]],
  ]);
  const defIndex = buildSymbolDefinitionIndex(files);

  const refs = buildReferencesForFile(
    "src/app.ts",
    [makeRef("helper")],
    defIndex,
  );

  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.type, "references");
  assert.equal(refs[0]!.toPath, "src/utils.ts");
  assert.equal(refs[0]!.symbol, "helper");
  assert.equal(refs[0]!.weight, WEIGHT_UNIQUE_REF);
});

test("buildReferencesForFile produces ambiguous reference for multiple definitions", () => {
  const files = new Map([
    ["src/a.ts", [makeDef("shared", "function", true)]],
    ["src/b.ts", [makeDef("shared", "function", true)]],
  ]);
  const defIndex = buildSymbolDefinitionIndex(files);

  const refs = buildReferencesForFile(
    "src/app.ts",
    [makeRef("shared")],
    defIndex,
  );

  assert.equal(refs.length, 2); // one record per target path
  for (const ref of refs) {
    assert.equal(ref.type, "ambiguous-reference");
    assert.equal(ref.weight, WEIGHT_AMBIGUOUS_REF);
  }
  const targets = refs.map((r) => r.toPath).sort();
  assert.deepEqual(targets, ["src/a.ts", "src/b.ts"]);
});

test("buildReferencesForFile skips self-references", () => {
  const files = new Map([
    ["src/a.ts", [makeDef("foo", "function", true)]],
  ]);
  const defIndex = buildSymbolDefinitionIndex(files);

  // Reference from the same file that defines "foo"
  const refs = buildReferencesForFile(
    "src/a.ts",
    [makeRef("foo")],
    defIndex,
  );

  assert.equal(refs.length, 0);
});

test("buildReferencesForFile skips references to undefined symbols", () => {
  const files = new Map([
    ["src/a.ts", [makeDef("foo", "function", true)]],
  ]);
  const defIndex = buildSymbolDefinitionIndex(files);

  const refs = buildReferencesForFile(
    "src/app.ts",
    [makeRef("nonexistent")],
    defIndex,
  );

  assert.equal(refs.length, 0);
});

// ── Evidence deduplication ───────────────────────────────────────────────────

test("buildReferencesForFile deduplicates evidence ranges at same position", () => {
  const files = new Map([
    ["src/utils.ts", [makeDef("helper", "function", true)]],
  ]);
  const defIndex = buildSymbolDefinitionIndex(files);

  // Two references at the exact same position
  const refs = buildReferencesForFile(
    "src/app.ts",
    [
      makeRef("helper", 5, 1, 5, 10),
      makeRef("helper", 5, 1, 5, 10),
    ],
    defIndex,
  );

  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.evidence.length, 1); // deduplicated
});

test("buildReferencesForFile keeps distinct evidence ranges", () => {
  const files = new Map([
    ["src/utils.ts", [makeDef("helper", "function", true)]],
  ]);
  const defIndex = buildSymbolDefinitionIndex(files);

  const refs = buildReferencesForFile(
    "src/app.ts",
    [
      makeRef("helper", 5, 1, 5, 10),
      makeRef("helper", 10, 1, 10, 10),
    ],
    defIndex,
  );

  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.evidence.length, 2);
});

// ── Evidence ranges are sorted deterministically ─────────────────────────────

test("evidence ranges are sorted by start position", () => {
  const files = new Map([
    ["src/utils.ts", [makeDef("helper", "function", true)]],
  ]);
  const defIndex = buildSymbolDefinitionIndex(files);

  const refs = buildReferencesForFile(
    "src/app.ts",
    [
      makeRef("helper", 10, 5, 10, 15),
      makeRef("helper", 3, 1, 3, 10),
      makeRef("helper", 7, 2, 7, 12),
    ],
    defIndex,
  );

  assert.equal(refs.length, 1);
  const evidence = refs[0]!.evidence;
  assert.equal(evidence.length, 3);
  assert.equal(evidence[0]!.startLine, 3);
  assert.equal(evidence[1]!.startLine, 7);
  assert.equal(evidence[2]!.startLine, 10);
});

// ── Relationship weights ─────────────────────────────────────────────────────

test("weight constants have expected ordering", () => {
  assert.ok(WEIGHT_IMPORT > WEIGHT_UNIQUE_REF);
  assert.ok(WEIGHT_UNIQUE_REF > WEIGHT_AMBIGUOUS_REF);
  assert.equal(WEIGHT_IMPORT, 3);
  assert.equal(WEIGHT_UNIQUE_REF, 2);
  assert.equal(WEIGHT_AMBIGUOUS_REF, 1);
});

// ── Relationship shard construction ─────────────────────────────────────────

test("buildRelationshipShard combines imports and references", () => {
  const resolvedImports = [
    {
      requested: "./utils",
      resolvedPath: "src/utils.ts",
      range: range(1, 1, 1, 20),
      importKind: "esm" as const,
      resolutionConfigFingerprint: "abc123",
    },
  ];
  const refRecords = [
    {
      fromPath: "src/app.ts",
      toPath: "src/utils.ts",
      type: "references" as const,
      symbol: "helper",
      evidence: [range(5, 1, 5, 10)],
      weight: WEIGHT_UNIQUE_REF,
    },
  ];

  const shard = buildRelationshipShard(
    "src/app.ts",
    resolvedImports,
    refRecords,
    "abc123",
  );

  assert.equal(shard.schemaVersion, 1);
  assert.equal(shard.path, "src/app.ts");
  assert.equal(shard.resolutionConfigFingerprint, "abc123");
  assert.equal(shard.relationships.length, 2);

  // First relationship: import
  assert.equal(shard.relationships[0]!.type, "imports");
  assert.equal(shard.relationships[0]!.toPath, "src/utils.ts");
  assert.equal(shard.relationships[0]!.symbol, null);
  assert.equal(shard.relationships[0]!.weight, WEIGHT_IMPORT);

  // Second relationship: reference
  assert.equal(shard.relationships[1]!.type, "references");
  assert.equal(shard.relationships[1]!.symbol, "helper");
});

test("buildRelationshipShard skips unresolvable imports", () => {
  const resolvedImports = [
    {
      requested: "lodash",
      resolvedPath: null,
      range: range(1, 1, 1, 18),
      importKind: "esm" as const,
      resolutionConfigFingerprint: "abc123",
    },
  ];

  const shard = buildRelationshipShard(
    "src/app.ts",
    resolvedImports,
    [],
    "abc123",
  );

  assert.equal(shard.relationships.length, 0);
});

test("buildRelationshipShard includes evidence from import range", () => {
  const importRange = range(3, 1, 3, 25);
  const resolvedImports = [
    {
      requested: "./config",
      resolvedPath: "src/config.ts",
      range: importRange,
      importKind: "esm" as const,
      resolutionConfigFingerprint: "fp",
    },
  ];

  const shard = buildRelationshipShard(
    "src/app.ts",
    resolvedImports,
    [],
    "fp",
  );

  assert.equal(shard.relationships[0]!.evidence.length, 1);
  assert.deepEqual(shard.relationships[0]!.evidence[0], importRange);
});

// ── buildAllRelationshipShards ───────────────────────────────────────────────

test("buildAllRelationshipShards covers all paths from both maps", () => {
  const resolvedImports = new Map([
    [
      "src/a.ts",
      [
        {
          requested: "./b",
          resolvedPath: "src/b.ts",
          range: range(1, 1, 1, 10),
          importKind: "esm" as const,
          resolutionConfigFingerprint: "fp",
        },
      ],
    ],
  ]);
  const refRelationships = new Map([
    [
      "src/b.ts",
      [
        {
          fromPath: "src/b.ts",
          toPath: "src/a.ts",
          type: "references" as const,
          symbol: "foo",
          evidence: [range(5, 1, 5, 5)],
          weight: WEIGHT_UNIQUE_REF,
        },
      ],
    ],
  ]);

  const shards = buildAllRelationshipShards(
    resolvedImports,
    refRelationships,
    "fp",
  );

  assert.equal(shards.size, 2);
  assert.ok(shards.has("src/a.ts"));
  assert.ok(shards.has("src/b.ts"));
});

test("buildAllRelationshipShards handles paths only in imports map", () => {
  const resolvedImports = new Map([
    [
      "src/a.ts",
      [
        {
          requested: "./b",
          resolvedPath: "src/b.ts",
          range: range(1, 1, 1, 10),
          importKind: "esm" as const,
          resolutionConfigFingerprint: "fp",
        },
      ],
    ],
  ]);

  const shards = buildAllRelationshipShards(
    resolvedImports,
    new Map(),
    "fp",
  );

  assert.equal(shards.size, 1);
  assert.equal(shards.get("src/a.ts")!.relationships.length, 1);
});

// ── Shard ID derivation ─────────────────────────────────────────────────────

test("deriveRelationshipShardId produces deterministic content-addressed ID", () => {
  const shard: RelationshipShard = {
    schemaVersion: 1,
    path: "src/app.ts",
    resolutionConfigFingerprint: "abc",
    relationships: [
      {
        fromPath: "src/app.ts",
        toPath: "src/utils.ts",
        type: "imports",
        symbol: null,
        evidence: [range(1, 1, 1, 20)],
        weight: WEIGHT_IMPORT,
      },
    ],
  };

  const id1 = deriveRelationshipShardId(shard);
  const id2 = deriveRelationshipShardId(shard);
  assert.equal(id1, id2);
  assert.equal(id1.length, 64); // full SHA-256 hex
});

test("deriveRelationshipShardId produces different IDs for different shards", () => {
  const shard1: RelationshipShard = {
    schemaVersion: 1,
    path: "src/a.ts",
    resolutionConfigFingerprint: "fp",
    relationships: [],
  };
  const shard2: RelationshipShard = {
    schemaVersion: 1,
    path: "src/b.ts",
    resolutionConfigFingerprint: "fp",
    relationships: [],
  };

  assert.notEqual(
    deriveRelationshipShardId(shard1),
    deriveRelationshipShardId(shard2),
  );
});

// ── Affected-set computation ─────────────────────────────────────────────────

test("computeAffectedSet includes changed definitions", () => {
  const input: AffectedSetInput = {
    changedDefinitions: ["src/a.ts"],
    changedImports: [],
    changedAliases: [],
    configChanged: false,
    deletedPaths: [],
    renamedPaths: [],
    retargetedPaths: [],
    uniquenessTransitions: [],
    previousImportTargets: new Map(),
    currentImportTargets: new Map(),
    importersByTarget: new Map(),
    referencesBySymbol: new Map(),
  };

  const result = computeAffectedSet(input);

  assert.ok(result.paths.has("src/a.ts"));
  assert.equal(result.configChanged, false);
  const entry = result.entries.find((e) => e.path === "src/a.ts")!;
  assert.ok(entry.reasons.includes("definition-changed"));
});

test("computeAffectedSet propagates to importers of deleted paths", () => {
  const input: AffectedSetInput = {
    changedDefinitions: [],
    changedImports: [],
    changedAliases: [],
    configChanged: false,
    deletedPaths: ["src/utils.ts"],
    renamedPaths: [],
    retargetedPaths: [],
    uniquenessTransitions: [],
    previousImportTargets: new Map(),
    currentImportTargets: new Map(),
    importersByTarget: new Map([
      ["src/utils.ts", ["src/app.ts", "src/other.ts"]],
    ]),
    referencesBySymbol: new Map(),
  };

  const result = computeAffectedSet(input);

  assert.ok(result.paths.has("src/utils.ts"));
  assert.ok(result.paths.has("src/app.ts"));
  assert.ok(result.paths.has("src/other.ts"));

  const appEntry = result.entries.find((e) => e.path === "src/app.ts")!;
  assert.ok(appEntry.reasons.includes("import-changed"));
});

test("computeAffectedSet marks renamed paths and their importers", () => {
  const input: AffectedSetInput = {
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
      ["src/old.ts", ["src/app.ts"]],
    ]),
    referencesBySymbol: new Map(),
  };

  const result = computeAffectedSet(input);

  assert.ok(result.paths.has("src/old.ts"));
  assert.ok(result.paths.has("src/new.ts"));
  assert.ok(result.paths.has("src/app.ts"));

  const oldEntry = result.entries.find((e) => e.path === "src/old.ts")!;
  assert.ok(oldEntry.reasons.includes("renamed"));
});

test("computeAffectedSet handles uniqueness transitions", () => {
  const input: AffectedSetInput = {
    changedDefinitions: [],
    changedImports: [],
    changedAliases: [],
    configChanged: false,
    deletedPaths: [],
    renamedPaths: [],
    retargetedPaths: [],
    uniquenessTransitions: [
      {
        symbol: "shared",
        oldDefiningPaths: ["src/a.ts"],
        newDefiningPaths: ["src/a.ts", "src/b.ts"],
      },
    ],
    previousImportTargets: new Map(),
    currentImportTargets: new Map(),
    importersByTarget: new Map(),
    referencesBySymbol: new Map([
      ["shared", ["src/consumer.ts"]],
    ]),
  };

  const result = computeAffectedSet(input);

  assert.ok(result.paths.has("src/a.ts"));
  assert.ok(result.paths.has("src/b.ts"));
  assert.ok(result.paths.has("src/consumer.ts"));

  const consumerEntry = result.entries.find(
    (e) => e.path === "src/consumer.ts",
  )!;
  assert.ok(consumerEntry.reasons.includes("uniqueness-transition"));
});

test("computeAffectedSet marks configChanged and adds reason to all entries", () => {
  const input: AffectedSetInput = {
    changedDefinitions: ["src/a.ts"],
    changedImports: [],
    changedAliases: [],
    configChanged: true,
    deletedPaths: [],
    renamedPaths: [],
    retargetedPaths: [],
    uniquenessTransitions: [],
    previousImportTargets: new Map(),
    currentImportTargets: new Map(),
    importersByTarget: new Map(),
    referencesBySymbol: new Map(),
  };

  const result = computeAffectedSet(input);

  assert.ok(result.configChanged);
  const entry = result.entries.find((e) => e.path === "src/a.ts")!;
  assert.ok(entry.reasons.includes("config-changed"));
});

test("computeAffectedSet returns empty for no changes", () => {
  const input: AffectedSetInput = {
    changedDefinitions: [],
    changedImports: [],
    changedAliases: [],
    configChanged: false,
    deletedPaths: [],
    renamedPaths: [],
    retargetedPaths: [],
    uniquenessTransitions: [],
    previousImportTargets: new Map(),
    currentImportTargets: new Map(),
    importersByTarget: new Map(),
    referencesBySymbol: new Map(),
  };

  const result = computeAffectedSet(input);

  assert.equal(result.entries.length, 0);
  assert.equal(result.paths.size, 0);
});

test("computeAffectedSet entries are sorted by path", () => {
  const input: AffectedSetInput = {
    changedDefinitions: ["src/c.ts", "src/a.ts", "src/b.ts"],
    changedImports: [],
    changedAliases: [],
    configChanged: false,
    deletedPaths: [],
    renamedPaths: [],
    retargetedPaths: [],
    uniquenessTransitions: [],
    previousImportTargets: new Map(),
    currentImportTargets: new Map(),
    importersByTarget: new Map(),
    referencesBySymbol: new Map(),
  };

  const result = computeAffectedSet(input);

  const paths = result.entries.map((e) => e.path);
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
});

// ── Full pipeline: buildAllRelationships ─────────────────────────────────────

test("buildAllRelationships produces complete result from extraction data", () => {
  const fileImports = new Map<string, readonly ExtractedImport[]>([
    ["src/app.ts", [makeImport("./utils", 1, 1, 1, 20)]],
    ["src/utils.ts", [makeImport("./config", 1, 1, 1, 22)]],
  ]);
  const fileReferences = new Map<string, readonly ExtractedReference[]>([
    ["src/app.ts", [makeRef("helper", 5, 1, 5, 10)]],
  ]);
  const fileDefinitions = new Map<string, readonly ExtractedDefinition[]>([
    ["src/utils.ts", [makeDef("helper", "function", true)]],
    ["src/config.ts", [makeDef("CONFIG", "variable", true)]],
  ]);
  const pathInventory = makePathIndex([
    pathEntry("src/app.ts"),
    pathEntry("src/utils.ts"),
    pathEntry("src/config.ts"),
  ]);

  const result = buildAllRelationships({
    fileImports,
    fileReferences,
    fileDefinitions,
    resolutionConfig: TS_CONFIG,
    pathInventory,
  });

  // Definition index
  assert.ok(result.definitionIndex.has("helper"));
  assert.ok(result.definitionIndex.has("CONFIG"));

  // Resolved imports
  assert.equal(result.resolvedImports.size, 2);
  assert.equal(
    result.resolvedImports.get("src/app.ts")![0]!.resolvedPath,
    "src/utils.ts",
  );
  assert.equal(
    result.resolvedImports.get("src/utils.ts")![0]!.resolvedPath,
    "src/config.ts",
  );

  // Reference relationships
  const appRefs = result.referenceRelationships.get("src/app.ts")!;
  assert.equal(appRefs.length, 1);
  assert.equal(appRefs[0]!.type, "references");
  assert.equal(appRefs[0]!.toPath, "src/utils.ts");

  // Shards
  assert.ok(result.shards.has("src/app.ts"));
  assert.ok(result.shards.has("src/utils.ts"));

  // App shard has both import and reference relationships
  const appShard = result.shards.get("src/app.ts")!;
  assert.equal(appShard.relationships.length, 2);
  assert.ok(
    appShard.relationships.some((r) => r.type === "imports"),
  );
  assert.ok(
    appShard.relationships.some((r) => r.type === "references"),
  );

  // Fingerprint is consistent
  assert.equal(
    result.resolutionConfigFingerprint,
    deriveResolutionConfigFingerprint(TS_CONFIG),
  );
});

test("buildAllRelationships handles empty inputs gracefully", () => {
  const result = buildAllRelationships({
    fileImports: new Map(),
    fileReferences: new Map(),
    fileDefinitions: new Map(),
    resolutionConfig: TS_CONFIG,
    pathInventory: makePathIndex([]),
  });

  assert.equal(result.shards.size, 0);
  assert.equal(result.resolvedImports.size, 0);
  assert.equal(result.referenceRelationships.size, 0);
  assert.equal(result.definitionIndex.size, 0);
});

test("buildAllRelationships fingerprint is stable across calls", () => {
  const input = {
    fileImports: new Map<string, readonly ExtractedImport[]>(),
    fileReferences: new Map<string, readonly ExtractedReference[]>(),
    fileDefinitions: new Map<string, readonly ExtractedDefinition[]>(),
    resolutionConfig: TS_CONFIG,
    pathInventory: makePathIndex([]),
  };

  const r1 = buildAllRelationships(input);
  const r2 = buildAllRelationships(input);

  assert.equal(r1.resolutionConfigFingerprint, r2.resolutionConfigFingerprint);
});

// ── Integration: diamond dependency graph ────────────────────────────────────

test("diamond dependency: a->b, a->c, b->d, c->d resolves all edges", () => {
  const fileImports = new Map<string, readonly ExtractedImport[]>([
    ["src/a.ts", [makeImport("./b", 1, 1, 1, 10), makeImport("./c", 2, 1, 2, 10)]],
    ["src/b.ts", [makeImport("./d", 1, 1, 1, 10)]],
    ["src/c.ts", [makeImport("./d", 1, 1, 1, 10)]],
  ]);
  const fileReferences = new Map<string, readonly ExtractedReference[]>();
  const fileDefinitions = new Map<string, readonly ExtractedDefinition[]>([
    ["src/d.ts", [makeDef("shared", "function", true)]],
  ]);
  const pathInventory = makePathIndex([
    pathEntry("src/a.ts"),
    pathEntry("src/b.ts"),
    pathEntry("src/c.ts"),
    pathEntry("src/d.ts"),
  ]);

  const result = buildAllRelationships({
    fileImports,
    fileReferences,
    fileDefinitions,
    resolutionConfig: TS_CONFIG,
    pathInventory,
  });

  // a has 2 import relationships
  const aShard = result.shards.get("src/a.ts")!;
  assert.equal(aShard.relationships.length, 2);
  const aTargets = aShard.relationships.map((r) => r.toPath).sort();
  assert.deepEqual(aTargets, ["src/b.ts", "src/c.ts"]);

  // b and c each have 1 import to d
  const bShard = result.shards.get("src/b.ts")!;
  assert.equal(bShard.relationships.length, 1);
  assert.equal(bShard.relationships[0]!.toPath, "src/d.ts");

  const cShard = result.shards.get("src/c.ts")!;
  assert.equal(cShard.relationships.length, 1);
  assert.equal(cShard.relationships[0]!.toPath, "src/d.ts");
});

// ── Integration: re-export / barrel file ─────────────────────────────────────

test("barrel file re-exporting symbols creates import + reference edges", () => {
  const fileImports = new Map<string, readonly ExtractedImport[]>([
    ["src/index.ts", [makeImport("./utils", 1, 1, 1, 20)]],
  ]);
  const fileReferences = new Map<string, readonly ExtractedReference[]>([
    ["src/index.ts", [makeRef("helper", 2, 1, 2, 10)]],
  ]);
  const fileDefinitions = new Map<string, readonly ExtractedDefinition[]>([
    ["src/utils.ts", [makeDef("helper", "function", true)]],
  ]);
  const pathInventory = makePathIndex([
    pathEntry("src/index.ts"),
    pathEntry("src/utils.ts"),
  ]);

  const result = buildAllRelationships({
    fileImports,
    fileReferences,
    fileDefinitions,
    resolutionConfig: TS_CONFIG,
    pathInventory,
  });

  const indexShard = result.shards.get("src/index.ts")!;
  // Should have both an import edge and a reference edge to utils.ts
  assert.equal(indexShard.relationships.length, 2);
  assert.ok(indexShard.relationships.every((r) => r.toPath === "src/utils.ts"));
  assert.ok(indexShard.relationships.some((r) => r.type === "imports"));
  assert.ok(indexShard.relationships.some((r) => r.type === "references"));
});
