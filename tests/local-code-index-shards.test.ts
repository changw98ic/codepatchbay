/**
 * Tests for core/indexing/local-code-index/shards.ts
 *
 * Covers:
 *   - Symbol NFC normalization
 *   - Path normalization
 *   - Deterministic bucket computation (symbol and path)
 *   - Shard construction determinism
 *   - Incremental rebuild (touched vs untouched buckets)
 *   - Object ID derivation from canonical JSON bytes
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  SHARD_BUCKET_COUNT,
  PATH_SHARD_BUCKET_COUNT,
  normalizeSymbol,
  normalizePath,
  symbolBucketIndex,
  symbolBucketKey,
  pathBucketIndex,
  pathBucketKey,
  buildSymbolShard,
  buildRelationShard,
  deriveShardObjectId,
  distributeBySymbol,
  distributeByPath,
  rebuildShards,
} from "../core/indexing/local-code-index/shards.js";

import type {
  ShardSymbolEntry,
  ShardFileSummaryEntry,
  ShardRelationshipEntry,
  SymbolShard,
  RelationShard,
} from "../core/indexing/local-code-index/shards.js";

import { canonicalStringify } from "../core/indexing/local-code-index/canonical-json.js";

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeSymbolEntry(
  symbol: string,
  path: string,
  role: "definition" | "reference" = "definition",
  startLine = 1,
): ShardSymbolEntry {
  return {
    symbol,
    kind: role === "definition" ? "function" : "reference",
    role,
    path,
    range: { startLine, startColumn: 0, endLine: startLine, endColumn: 10 },
    exported: false,
    coverage: "ast-grep-structural",
  };
}

function makeFileSummary(
  path: string,
  language = "typescript",
): ShardFileSummaryEntry {
  return {
    path,
    language,
    size: 1024,
    contentId: createHash("sha256").update(path).digest("hex"),
    coverage: "ast-grep-structural",
  };
}

function makeRelationship(
  fromPath: string,
  toPath: string,
  type: "imports" | "references" | "ambiguous-reference" = "imports",
): ShardRelationshipEntry {
  return {
    fromPath,
    toPath,
    type,
    symbol: null,
    weight: 1.0,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("shards", () => {
  // ── Constants ──────────────────────────────────────────────────────────

  describe("SHARD_BUCKET_COUNT", () => {
    it("is 256 (2^8)", () => {
      assert.equal(SHARD_BUCKET_COUNT, 256);
    });

    it("keeps path shards at 65536 (2^16)", () => {
      assert.equal(PATH_SHARD_BUCKET_COUNT, 65_536);
    });
  });

  // ── Normalization ──────────────────────────────────────────────────────

  describe("normalizeSymbol", () => {
    it("returns ASCII symbols unchanged", () => {
      assert.equal(normalizeSymbol("foo"), "foo");
      assert.equal(normalizeSymbol("MyClass"), "MyClass");
      assert.equal(normalizeSymbol("_private"), "_private");
    });

    it("preserves case", () => {
      assert.equal(normalizeSymbol("FOO"), "FOO");
      assert.equal(normalizeSymbol("foo"), "foo");
      assert.notEqual(normalizeSymbol("FOO"), normalizeSymbol("foo"));
    });

    it("applies NFC normalization to composed forms", () => {
      // e-acute as precomposed (U+00E9) vs decomposed (U+0065 U+0301)
      const precomposed = "é"; // e + acute (single code point)
      const decomposed = "é"; // e + combining acute
      assert.equal(normalizeSymbol(decomposed), precomposed);
    });

    it("handles empty string", () => {
      assert.equal(normalizeSymbol(""), "");
    });
  });

  describe("normalizePath", () => {
    it("returns simple forward-slash paths unchanged", () => {
      assert.equal(normalizePath("src/index.ts"), "src/index.ts");
    });

    it("replaces backslashes with forward slashes", () => {
      assert.equal(normalizePath("src\\index.ts"), "src/index.ts");
      assert.equal(
        normalizePath("src\\lib\\utils.ts"),
        "src/lib/utils.ts",
      );
    });

    it("removes leading ./ prefix", () => {
      assert.equal(normalizePath("./src/index.ts"), "src/index.ts");
    });

    it("removes trailing slash", () => {
      assert.equal(normalizePath("src/lib/"), "src/lib");
    });

    it("preserves single-character path without stripping", () => {
      assert.equal(normalizePath("a"), "a");
    });

    it("applies NFC normalization", () => {
      const decomposed = "é/"; // e-acute decomposed + slash
      const normalized = normalizePath(decomposed);
      assert.equal(normalized, "é"); // NFC composed, trailing slash removed
    });

    it("handles backslash + leading dot-slash combination", () => {
      assert.equal(normalizePath(".\\src\\index.ts"), "src/index.ts");
    });
  });

  // ── Bucket computation ─────────────────────────────────────────────────

  describe("symbolBucketIndex", () => {
    it("returns values in [0, 255]", () => {
      for (const sym of ["foo", "bar", "MyClass", "_x", "A"]) {
        const idx = symbolBucketIndex(sym);
        assert.ok(idx >= 0, `${sym}: idx=${idx} < 0`);
        assert.ok(idx < SHARD_BUCKET_COUNT, `${sym}: idx=${idx} >= ${SHARD_BUCKET_COUNT}`);
      }
    });

    it("is deterministic (same input -> same output)", () => {
      assert.equal(symbolBucketIndex("foo"), symbolBucketIndex("foo"));
      assert.equal(symbolBucketIndex("MyClass"), symbolBucketIndex("MyClass"));
    });

    it("matches manual SHA-256 computation", () => {
      const symbol = "testSymbol";
      const normalized = normalizeSymbol(symbol);
      const hash = createHash("sha256").update(normalized, "utf8").digest();
      const expected = hash[0]!;
      assert.equal(symbolBucketIndex(symbol), expected);
    });

    it("NFC-normalizes before hashing", () => {
      const precomposed = "é";
      const decomposed = "é";
      // Both should hash to the same bucket after NFC normalization.
      assert.equal(symbolBucketIndex(precomposed), symbolBucketIndex(decomposed));
    });
  });

  describe("symbolBucketKey", () => {
    it("returns 2-character lowercase hex string", () => {
      for (const sym of ["foo", "bar", "MyClass"]) {
        const key = symbolBucketKey(sym);
        assert.equal(key.length, 2, `${sym}: key length ${key.length}`);
        assert.match(key, /^[0-9a-f]{2}$/, `${sym}: key=${key}`);
      }
    });

    it("matches the hex representation of symbolBucketIndex", () => {
      const sym = "example";
      const idx = symbolBucketIndex(sym);
      const expected = idx.toString(16).padStart(2, "0");
      assert.equal(symbolBucketKey(sym), expected);
    });
  });

  describe("pathBucketIndex", () => {
    it("returns values in [0, 65535]", () => {
      for (const p of ["src/index.ts", "lib/utils.ts", "a"]) {
        const idx = pathBucketIndex(p);
        assert.ok(idx >= 0, `${p}: idx=${idx} < 0`);
        assert.ok(idx < PATH_SHARD_BUCKET_COUNT, `${p}: idx=${idx} >= ${PATH_SHARD_BUCKET_COUNT}`);
      }
    });

    it("is deterministic", () => {
      assert.equal(
        pathBucketIndex("src/index.ts"),
        pathBucketIndex("src/index.ts"),
      );
    });

    it("normalizes paths before hashing", () => {
      // Backslash vs forward-slash should produce the same bucket.
      assert.equal(
        pathBucketIndex("src\\index.ts"),
        pathBucketIndex("src/index.ts"),
      );
      // Leading ./ should be stripped.
      assert.equal(
        pathBucketIndex("./src/index.ts"),
        pathBucketIndex("src/index.ts"),
      );
    });

    it("matches manual SHA-256 computation", () => {
      const p = "src/index.ts";
      const normalized = normalizePath(p);
      const hash = createHash("sha256").update(normalized, "utf8").digest();
      const expected = (hash[0]! << 8) | hash[1]!;
      assert.equal(pathBucketIndex(p), expected);
    });
  });

  describe("pathBucketKey", () => {
    it("returns 4-character lowercase hex string", () => {
      for (const p of ["src/index.ts", "lib/utils.ts"]) {
        const key = pathBucketKey(p);
        assert.equal(key.length, 4);
        assert.match(key, /^[0-9a-f]{4}$/);
      }
    });

    it("matches hex of pathBucketIndex", () => {
      const p = "lib/core.ts";
      const idx = pathBucketIndex(p);
      assert.equal(pathBucketKey(p), idx.toString(16).padStart(4, "0"));
    });
  });

  // ── Shard construction ─────────────────────────────────────────────────

  describe("buildSymbolShard", () => {
    it("sorts entries deterministically by path, range, kind, symbol", () => {
      const entries: ShardSymbolEntry[] = [
        makeSymbolEntry("zFunc", "b.ts"),
        makeSymbolEntry("aFunc", "a.ts", "definition", 5),
        makeSymbolEntry("aFunc", "a.ts", "definition", 1),
      ];

      const shard1 = buildSymbolShard("abcd", entries);
      const shard2 = buildSymbolShard("abcd", [...entries].reverse());

      // Both should produce identical output regardless of input order.
      assert.deepEqual(shard1, shard2);

      // Verify sort order: a.ts before b.ts, line 1 before line 5.
      assert.equal(shard1.entries[0]!.path, "a.ts");
      assert.equal(shard1.entries[0]!.range.startLine, 1);
      assert.equal(shard1.entries[1]!.path, "a.ts");
      assert.equal(shard1.entries[1]!.range.startLine, 5);
      assert.equal(shard1.entries[2]!.path, "b.ts");
    });

    it("sets the bucket key", () => {
      const shard = buildSymbolShard("1234", []);
      assert.equal(shard.bucket, "1234");
    });

    it("handles empty entries", () => {
      const shard = buildSymbolShard("0000", []);
      assert.deepEqual(shard.entries, []);
    });
  });

  describe("buildRelationShard", () => {
    it("sorts file summaries by path", () => {
      const summaries = [
        makeFileSummary("z.ts"),
        makeFileSummary("a.ts"),
      ];
      const shard = buildRelationShard("abcd", summaries, []);
      assert.equal(shard.fileSummaries[0]!.path, "a.ts");
      assert.equal(shard.fileSummaries[1]!.path, "z.ts");
    });

    it("sorts relationships by fromPath, toPath, type, symbol", () => {
      const rels = [
        makeRelationship("b.ts", "a.ts"),
        makeRelationship("a.ts", "b.ts", "references"),
        makeRelationship("a.ts", "b.ts", "imports"),
      ];
      const shard = buildRelationShard("abcd", [], rels);
      assert.equal(shard.relationships[0]!.fromPath, "a.ts");
      assert.equal(shard.relationships[0]!.type, "imports");
      assert.equal(shard.relationships[1]!.fromPath, "a.ts");
      assert.equal(shard.relationships[1]!.type, "references");
      assert.equal(shard.relationships[2]!.fromPath, "b.ts");
    });

    it("produces identical output regardless of input order", () => {
      const summaries = [makeFileSummary("a.ts"), makeFileSummary("b.ts")];
      const rels = [makeRelationship("a.ts", "b.ts")];

      const shard1 = buildRelationShard("abcd", summaries, rels);
      const shard2 = buildRelationShard(
        "abcd",
        [...summaries].reverse(),
        [...rels].reverse(),
      );
      assert.deepEqual(shard1, shard2);
    });
  });

  // ── Object ID derivation ───────────────────────────────────────────────

  describe("deriveShardObjectId", () => {
    it("produces a 64-char hex SHA-256 digest", () => {
      const shard = buildSymbolShard("abcd", [
        makeSymbolEntry("foo", "a.ts"),
      ]);
      const id = deriveShardObjectId(shard);
      assert.equal(id.length, 64);
      assert.match(id, /^[0-9a-f]{64}$/);
    });

    it("matches objectId from canonical-json.ts", () => {
      const shard = buildSymbolShard("abcd", [
        makeSymbolEntry("foo", "a.ts"),
      ]);
      const id = deriveShardObjectId(shard);
      // objectId hashes the canonical JSON of the value.
      const canonical = canonicalStringify(shard);
      const expected = createHash("sha256")
        .update(canonical, "utf8")
        .digest("hex");
      assert.equal(id, expected);
    });

    it("is deterministic for identical shards", () => {
      const shard1 = buildSymbolShard("abcd", [
        makeSymbolEntry("foo", "a.ts"),
      ]);
      const shard2 = buildSymbolShard("abcd", [
        makeSymbolEntry("foo", "a.ts"),
      ]);
      assert.equal(deriveShardObjectId(shard1), deriveShardObjectId(shard2));
    });

    it("differs for different shards", () => {
      const shard1 = buildSymbolShard("abcd", [
        makeSymbolEntry("foo", "a.ts"),
      ]);
      const shard2 = buildSymbolShard("abcd", [
        makeSymbolEntry("bar", "a.ts"),
      ]);
      assert.notEqual(deriveShardObjectId(shard1), deriveShardObjectId(shard2));
    });

    it("works for relation shards", () => {
      const shard = buildRelationShard(
        "abcd",
        [makeFileSummary("a.ts")],
        [makeRelationship("a.ts", "b.ts")],
      );
      const id = deriveShardObjectId(shard);
      assert.equal(id.length, 64);
      assert.match(id, /^[0-9a-f]{64}$/);
    });
  });

  // ── Distribution ───────────────────────────────────────────────────────

  describe("distributeBySymbol", () => {
    it("groups items by their symbol bucket", () => {
      const items = [
        makeSymbolEntry("foo", "a.ts"),
        makeSymbolEntry("foo", "b.ts"),
        makeSymbolEntry("bar", "c.ts"),
      ];
      const dist = distributeBySymbol(items, (e) => e.symbol);

      // foo entries should be in the same bucket.
      const fooKey = symbolBucketKey("foo");
      const barKey = symbolBucketKey("bar");

      assert.equal(dist.get(fooKey)!.length, 2);
      assert.equal(dist.get(barKey)!.length, 1);
    });

    it("returns only non-empty buckets", () => {
      const items = [makeSymbolEntry("x", "a.ts")];
      const dist = distributeBySymbol(items, (e) => e.symbol);
      assert.equal(dist.size, 1);
    });
  });

  describe("distributeByPath", () => {
    it("groups items by their path bucket", () => {
      const items = [
        makeFileSummary("src/a.ts"),
        makeFileSummary("src/b.ts"),
      ];
      const dist = distributeByPath(items, (e) => e.path);
      // Both might land in the same or different buckets — just verify
      // the total count matches.
      let total = 0;
      for (const bucket of dist.values()) total += bucket.length;
      assert.equal(total, 2);
    });
  });

  // ── Incremental rebuild ────────────────────────────────────────────────

  describe("rebuildShards", () => {
    it("rebuilds all shards on a full build (no previous data)", async () => {
      const entries = [
        makeSymbolEntry("foo", "a.ts"),
        makeSymbolEntry("bar", "b.ts"),
      ];
      const summaries = [makeFileSummary("a.ts"), makeFileSummary("b.ts")];
      const rels = [makeRelationship("a.ts", "b.ts")];

      const result = await rebuildShards({
        previousSymbolEntries: [],
        currentSymbolEntries: entries,
        previousFileSummaries: [],
        currentFileSummaries: summaries,
        previousRelationships: [],
        currentRelationships: rels,
        previousSymbolShardIds: new Map(),
        previousRelationShardIds: new Map(),
      });

      // All shards should be rebuilt.
      assert.ok(result.rebuiltSymbolShardCount > 0);
      assert.ok(result.rebuiltRelationShardCount > 0);

      for (const shard of result.symbolShards) {
        assert.equal(shard.status, "rebuilt");
      }
      for (const shard of result.relationShards) {
        assert.equal(shard.status, "rebuilt");
      }
    });

    it("reuses untouched shards when entries are unchanged", async () => {
      const entries = [
        makeSymbolEntry("foo", "a.ts"),
        makeSymbolEntry("bar", "b.ts"),
      ];
      const summaries = [makeFileSummary("a.ts")];

      // First build.
      const first = await rebuildShards({
        previousSymbolEntries: [],
        currentSymbolEntries: entries,
        previousFileSummaries: [],
        currentFileSummaries: summaries,
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: new Map(),
        previousRelationShardIds: new Map(),
      });

      // Second build with identical data.
      const second = await rebuildShards({
        previousSymbolEntries: entries,
        currentSymbolEntries: entries,
        previousFileSummaries: summaries,
        currentFileSummaries: summaries,
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: first.symbolShardIds,
        previousRelationShardIds: first.relationShardIds,
      });

      // All shards should be reused.
      assert.equal(second.rebuiltSymbolShardCount, 0);
      assert.equal(second.rebuiltRelationShardCount, 0);

      // Object IDs should be identical.
      for (const [key, id] of first.symbolShardIds) {
        assert.equal(second.symbolShardIds.get(key), id);
      }
      for (const [key, id] of first.relationShardIds) {
        assert.equal(second.relationShardIds.get(key), id);
      }
    });

    it("rebuilds only the touched symbol shard when one entry changes", async () => {
      const entries1 = [
        makeSymbolEntry("foo", "a.ts"),
        makeSymbolEntry("bar", "b.ts"),
      ];
      const summaries = [makeFileSummary("a.ts")];

      // First build.
      const first = await rebuildShards({
        previousSymbolEntries: [],
        currentSymbolEntries: entries1,
        previousFileSummaries: [],
        currentFileSummaries: summaries,
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: new Map(),
        previousRelationShardIds: new Map(),
      });

      // Change only "bar" -> "baz" (may or may not be in the same bucket).
      const entries2 = [
        makeSymbolEntry("foo", "a.ts"),
        makeSymbolEntry("baz", "b.ts"),
      ];

      const second = await rebuildShards({
        previousSymbolEntries: entries1,
        currentSymbolEntries: entries2,
        previousFileSummaries: summaries,
        currentFileSummaries: summaries,
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: first.symbolShardIds,
        previousRelationShardIds: first.relationShardIds,
      });

      // At most 2 symbol shards rebuilt (the ones containing bar and baz).
      assert.ok(second.rebuiltSymbolShardCount <= 2);
      assert.ok(second.rebuiltSymbolShardCount >= 1);

      // Relation shards should all be reused (summaries didn't change).
      assert.equal(second.rebuiltRelationShardCount, 0);
    });

    it("handles deletion of entries", async () => {
      const entries1 = [
        makeSymbolEntry("foo", "a.ts"),
        makeSymbolEntry("bar", "b.ts"),
      ];

      const first = await rebuildShards({
        previousSymbolEntries: [],
        currentSymbolEntries: entries1,
        previousFileSummaries: [],
        currentFileSummaries: [],
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: new Map(),
        previousRelationShardIds: new Map(),
      });

      // Remove "bar".
      const entries2 = [makeSymbolEntry("foo", "a.ts")];

      const second = await rebuildShards({
        previousSymbolEntries: entries1,
        currentSymbolEntries: entries2,
        previousFileSummaries: [],
        currentFileSummaries: [],
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: first.symbolShardIds,
        previousRelationShardIds: first.relationShardIds,
      });

      // The shard containing "bar" should be rebuilt (or removed).
      if (symbolBucketKey("bar") !== symbolBucketKey("foo")) {
        // Different buckets: "bar"'s bucket is gone, "foo"'s is reused.
        assert.ok(second.rebuiltSymbolShardCount >= 0);
      }
      // "foo"'s shard should be reused if it's in a different bucket.
      const fooKey = symbolBucketKey("foo");
      const barKey = symbolBucketKey("bar");
      if (fooKey !== barKey) {
        assert.equal(
          second.symbolShardIds.get(fooKey),
          first.symbolShardIds.get(fooKey),
        );
      }
    });

    it("rebuilds relation shard when file summaries change", async () => {
      const summaries1 = [makeFileSummary("a.ts")];
      const rels = [makeRelationship("a.ts", "b.ts")];

      const first = await rebuildShards({
        previousSymbolEntries: [],
        currentSymbolEntries: [],
        previousFileSummaries: [],
        currentFileSummaries: summaries1,
        previousRelationships: [],
        currentRelationships: rels,
        previousSymbolShardIds: new Map(),
        previousRelationShardIds: new Map(),
      });

      // Change the file summary (different size).
      const summaries2: ShardFileSummaryEntry[] = [
        { ...makeFileSummary("a.ts"), size: 2048 },
      ];

      const second = await rebuildShards({
        previousSymbolEntries: [],
        currentSymbolEntries: [],
        previousFileSummaries: summaries1,
        currentFileSummaries: summaries2,
        previousRelationships: rels,
        currentRelationships: rels,
        previousSymbolShardIds: new Map(),
        previousRelationShardIds: first.relationShardIds,
      });

      // The relation shard containing "a.ts" should be rebuilt.
      assert.ok(second.rebuiltRelationShardCount >= 1);
    });

    it("output shards are sorted by bucket key", async () => {
      const entries: ShardSymbolEntry[] = [];
      for (let i = 0; i < 100; i++) {
        entries.push(makeSymbolEntry(`sym${i}`, `file${i}.ts`));
      }

      const result = await rebuildShards({
        previousSymbolEntries: [],
        currentSymbolEntries: entries,
        previousFileSummaries: [],
        currentFileSummaries: [],
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: new Map(),
        previousRelationShardIds: new Map(),
      });

      for (let i = 1; i < result.symbolShards.length; i++) {
        assert.ok(
          result.symbolShards[i]!.bucketKey >=
            result.symbolShards[i - 1]!.bucketKey,
          `Shards not sorted: ${result.symbolShards[i - 1]!.bucketKey} > ${result.symbolShards[i]!.bucketKey}`,
        );
      }
    });

    it("with readExistingShard callback, reuses verified shards", async () => {
      const entries = [makeSymbolEntry("foo", "a.ts")];

      const first = await rebuildShards({
        previousSymbolEntries: [],
        currentSymbolEntries: entries,
        previousFileSummaries: [],
        currentFileSummaries: [],
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: new Map(),
        previousRelationShardIds: new Map(),
      });

      // Build a fake reader that returns the shard payload.
      const shardStore = new Map<string, SymbolShard | RelationShard>();
      for (const s of first.symbolShards) {
        shardStore.set(s.objectId, s.shard);
      }

      const second = await rebuildShards({
        previousSymbolEntries: entries,
        currentSymbolEntries: entries,
        previousFileSummaries: [],
        currentFileSummaries: [],
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: first.symbolShardIds,
        previousRelationShardIds: first.relationShardIds,
        readExistingShard: async (id) => shardStore.get(id) ?? null,
      });

      // All shards should be reused.
      assert.equal(second.rebuiltSymbolShardCount, 0);
      for (const s of second.symbolShards) {
        assert.equal(s.status, "reused");
      }
    });

    it("with readExistingShard returning null, rebuilds the shard", async () => {
      const entries = [makeSymbolEntry("foo", "a.ts")];

      const first = await rebuildShards({
        previousSymbolEntries: [],
        currentSymbolEntries: entries,
        previousFileSummaries: [],
        currentFileSummaries: [],
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: new Map(),
        previousRelationShardIds: new Map(),
      });

      // Reader always returns null (simulating GC'd shard).
      const second = await rebuildShards({
        previousSymbolEntries: entries,
        currentSymbolEntries: entries,
        previousFileSummaries: [],
        currentFileSummaries: [],
        previousRelationships: [],
        currentRelationships: [],
        previousSymbolShardIds: first.symbolShardIds,
        previousRelationShardIds: first.relationShardIds,
        readExistingShard: async () => null,
      });

      // Shards should be rebuilt because the reader returned null.
      assert.ok(second.rebuiltSymbolShardCount > 0);
    });
  });

  // ── Round-trip: bucket computation is consistent ────────────────────────

  describe("round-trip consistency", () => {
    it("symbolBucketKey matches symbolBucketIndex hex encoding", () => {
      const symbols = [
        "foo", "bar", "MyClass", "_private", "UPPER",
        "mixedCase", "with-dash", "with.dot", "123numeric",
      ];
      for (const sym of symbols) {
        const idx = symbolBucketIndex(sym);
        const key = symbolBucketKey(sym);
        assert.equal(key, idx.toString(16).padStart(2, "0"), `Mismatch for ${sym}`);
      }
    });

    it("pathBucketKey matches pathBucketIndex hex encoding", () => {
      const paths = [
        "src/index.ts", "lib/utils.ts", "./relative.ts",
        "deep\\nested\\path.ts", "trailing/",
      ];
      for (const p of paths) {
        const idx = pathBucketIndex(p);
        const key = pathBucketKey(p);
        assert.equal(key, idx.toString(16).padStart(4, "0"), `Mismatch for ${p}`);
      }
    });

    it("symbol and path bucketing are independent", () => {
      // A symbol and a path with the same string may hash to different buckets.
      const key = "foo";
      // Just verify both produce valid buckets without error.
      const symIdx = symbolBucketIndex(key);
      const pathIdx = pathBucketIndex(key);
      assert.ok(symIdx >= 0 && symIdx < SHARD_BUCKET_COUNT);
      assert.ok(pathIdx >= 0 && pathIdx < PATH_SHARD_BUCKET_COUNT);
    });
  });
});
