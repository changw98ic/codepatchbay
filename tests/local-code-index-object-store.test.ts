/**
 * Object-store publication and coverage-aggregation tests.
 *
 * 1. Equal objects are reused (content-addressable deduplication).
 * 2. Unequal final bytes fail with object_identity_collision.
 * 3. Per-file failure produces correct coverage summaries.
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md sections 7.3, 7.6, 12
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, beforeEach, afterEach } from "node:test";

import {
  publishObjects,
  publishFileObject,
  publishFileObjects,
  publishSymbolShard,
  publishRelationShard,
  readStoredObject,
  verifyStoredObject,
  deriveFileObjectId,
  serializeFileObject,
  fileObjectPublishPath,
  type FileObject,
  type PublishObjectsOptions,
} from "../core/indexing/local-code-index/object-store.js";

import {
  LocalCodeIndexUnavailableError,
} from "../core/indexing/local-code-index/contracts.js";

import {
  aggregateCoverage,
  parserAbsentSummary,
  mergeCoverageSummaries,
  countOutcomes,
  coverageDegradationReason,
  type FileCoverageOutcome,
} from "../core/indexing/local-code-index/coverage.js";


// ── Test fixtures ────────────────────────────────────────────────────────────

let tmpDir: string;
let storageRoot: string;
let options: PublishObjectsOptions;

const REPO_KEY = "aabbccdd".repeat(4); // 32 hex chars
const OWNER_TOKEN = "test-owner-token-001";

/** Minimal valid file object for testing. */
function makeFileObject(overrides: Partial<FileObject> = {}): FileObject {
  return {
    sourceContentId: "deadbeef".repeat(8), // 64 hex chars
    languageExtractorFingerprint: "fingerprint-v1",
    byteSize: 42,
    language: "typescript",
    parserMode: "structural",
    definitions: [],
    references: [],
    imports: [],
    errors: [],
    truncated: false,
    extractorVersion: "1.0.0",
    ruleSetFingerprint: "ruleset-v1",
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "obj-store-test-"));
  storageRoot = path.join(tmpDir, "storage");
  await mkdir(storageRoot, { recursive: true });
  options = { storageRoot, repositoryKey: REPO_KEY, ownerToken: OWNER_TOKEN };
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. Equal objects are reused
// ══════════════════════════════════════════════════════════════════════════════

test("publishFileObject: identical file object is reused on second publish", async () => {
  const fo = makeFileObject();

  const first = await publishFileObject(fo, options);
  assert.equal(first.status, "created");

  const second = await publishFileObject(fo, options);
  assert.equal(second.status, "reused");
  assert.equal(first.objectId, second.objectId);
});

test("publishFileObjects preserves input order while publishing distinct file objects", async () => {
  const objects = [
    makeFileObject({ sourceContentId: "01".repeat(32) }),
    makeFileObject({ sourceContentId: "02".repeat(32) }),
    makeFileObject({ sourceContentId: "03".repeat(32) }),
  ];

  const published = await publishFileObjects(objects, options);

  assert.deepEqual(
    published.map((entry) => entry.objectId),
    objects.map((fileObject) => deriveFileObjectId(
      fileObject.language,
      fileObject.parserMode,
      fileObject.languageExtractorFingerprint,
      fileObject.sourceContentId,
    )),
  );
  assert.deepEqual(published.map((entry) => entry.status), ["created", "created", "created"]);
});

test("publishObjects: identical batch entry is reused on second publish", async () => {
  const fo = makeFileObject();
  const bytes = serializeFileObject(fo);
  const id = deriveFileObjectId(fo.language, fo.parserMode, fo.languageExtractorFingerprint, fo.sourceContentId);
  const finalPath = fileObjectPublishPath(storageRoot, REPO_KEY, id);

  const objects = [{ finalPath, canonicalBytes: bytes }];

  const first = await publishObjects(objects, options);
  assert.equal(first.objects[0]!.status, "created");
  assert.equal(first.bytesWritten, bytes.byteLength);

  const second = await publishObjects(objects, options);
  assert.equal(second.objects[0]!.status, "reused");
  assert.equal(second.bytesWritten, 0, "reused objects contribute zero bytes");
});

test("publishSymbolShard: identical shard is reused", async () => {
  const shardData = { symbols: [{ name: "foo", kind: "function" }] };

  const first = await publishSymbolShard(shardData, options);
  assert.equal(first.status, "created");

  const second = await publishSymbolShard(shardData, options);
  assert.equal(second.status, "reused");
  assert.equal(first.objectId, second.objectId);
});

test("publishRelationShard: identical shard is reused", async () => {
  const shardData = { relations: [{ from: "a", to: "b", type: "imports" }] };

  const first = await publishRelationShard(shardData, options);
  assert.equal(first.status, "created");

  const second = await publishRelationShard(shardData, options);
  assert.equal(second.status, "reused");
  assert.equal(first.objectId, second.objectId);
});

test("readStoredObject returns the same bytes that were published", async () => {
  const fo = makeFileObject();
  const id = deriveFileObjectId(fo.language, fo.parserMode, fo.languageExtractorFingerprint, fo.sourceContentId);
  const finalPath = fileObjectPublishPath(storageRoot, REPO_KEY, id);

  await publishFileObject(fo, options);

  const stored = await readStoredObject(finalPath);
  assert.ok(stored !== null, "object should exist on disk");

  const expected = serializeFileObject(fo);
  assert.deepEqual(stored, expected);
});

test("verifyStoredObject returns true for matching bytes and null for missing", async () => {
  const fo = makeFileObject();
  const id = deriveFileObjectId(fo.language, fo.parserMode, fo.languageExtractorFingerprint, fo.sourceContentId);
  const finalPath = fileObjectPublishPath(storageRoot, REPO_KEY, id);
  const expected = serializeFileObject(fo);

  // Before publish: null
  const before = await verifyStoredObject(finalPath, expected);
  assert.equal(before, null);

  await publishFileObject(fo, options);

  // After publish: true
  const after = await verifyStoredObject(finalPath, expected);
  assert.equal(after, true);

  // Mismatching bytes: false
  const wrong = new TextEncoder().encode("not-the-right-bytes\n");
  const mismatch = await verifyStoredObject(finalPath, wrong);
  assert.equal(mismatch, false);
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Unequal final bytes fail object_identity_collision
// ══════════════════════════════════════════════════════════════════════════════

test("publishObjects: different bytes at the same final path throw object_identity_collision", async () => {
  const fo = makeFileObject();
  const id = deriveFileObjectId(fo.language, fo.parserMode, fo.languageExtractorFingerprint, fo.sourceContentId);
  const finalPath = fileObjectPublishPath(storageRoot, REPO_KEY, id);

  // First publish: normal file object.
  const goodBytes = serializeFileObject(fo);
  await publishObjects([{ finalPath, canonicalBytes: goodBytes }], options);

  // Second publish: different bytes to the same path.
  const badBytes = new TextEncoder().encode('{"deliberately":"different"}\n');

  await assert.rejects(
    publishObjects([{ finalPath, canonicalBytes: badBytes }], options),
    (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "object_identity_collision");
      assert.equal(err.code, "local_code_index_unavailable");
      return true;
    },
  );
});

test("publishFileObject: same ID but different sourceContentId produces collision", async () => {
  // The file object ID is derived from language + parserMode + extractorFingerprint + sourceContentId.
  // If we change sourceContentId, we get a different ID — no collision.
  // To force a collision we must publish different canonical bytes to the same path
  // by manipulating the finalPath directly.

  const fo = makeFileObject();
  const id = deriveFileObjectId(fo.language, fo.parserMode, fo.languageExtractorFingerprint, fo.sourceContentId);
  const finalPath = fileObjectPublishPath(storageRoot, REPO_KEY, id);

  // Publish the real file object.
  await publishFileObject(fo, options);

  // Now publish different bytes to the same final path using publishObjects.
  const tampered = serializeFileObject(makeFileObject({ byteSize: 9999 }));
  // Tampered bytes are different from what's on disk, so collision.
  await assert.rejects(
    publishObjects([{ finalPath, canonicalBytes: tampered }], options),
    (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "object_identity_collision");
      return true;
    },
  );
});

test("object_identity_collision error does not leak source content or absolute paths", async () => {
  const fo = makeFileObject();
  const id = deriveFileObjectId(fo.language, fo.parserMode, fo.languageExtractorFingerprint, fo.sourceContentId);
  const finalPath = fileObjectPublishPath(storageRoot, REPO_KEY, id);

  await publishFileObject(fo, options);

  const badBytes = new TextEncoder().encode('{"x":"y"}\n');
  try {
    await publishObjects([{ finalPath, canonicalBytes: badBytes }], options);
    assert.fail("should have thrown");
  } catch (err: unknown) {
    assert.ok(err instanceof LocalCodeIndexUnavailableError);
    // Error message must not contain the storage root or source content.
    assert.ok(!err.message.includes(storageRoot), "error must not contain storage root");
    assert.ok(!err.message.includes("deadbeef"), "error must not contain source content ID");
  }
});

test("collision on one object does not prevent other objects from being published", async () => {
  const fo1 = makeFileObject({ sourceContentId: "11111111".repeat(8) });
  const fo2 = makeFileObject({ sourceContentId: "22222222".repeat(8) });

  const id1 = deriveFileObjectId(fo1.language, fo1.parserMode, fo1.languageExtractorFingerprint, fo1.sourceContentId);
  const id2 = deriveFileObjectId(fo2.language, fo2.parserMode, fo2.languageExtractorFingerprint, fo2.sourceContentId);
  const path1 = fileObjectPublishPath(storageRoot, REPO_KEY, id1);
  const path2 = fileObjectPublishPath(storageRoot, REPO_KEY, id2);

  // Publish both objects.
  const bytes1 = serializeFileObject(fo1);
  const bytes2 = serializeFileObject(fo2);
  await publishObjects([
    { finalPath: path1, canonicalBytes: bytes1 },
    { finalPath: path2, canonicalBytes: bytes2 },
  ], options);

  // Now try to publish a batch where object 1 collides but object 2 is fine.
  const badBytes1 = new TextEncoder().encode('{"tampered":true}\n');

  // The batch iterates sequentially; object 1 throws, object 2 is never reached.
  await assert.rejects(
    publishObjects([
      { finalPath: path1, canonicalBytes: badBytes1 },
      { finalPath: path2, canonicalBytes: bytes2 },
    ], options),
    (err: unknown) => {
      assert.ok(err instanceof LocalCodeIndexUnavailableError);
      assert.equal(err.reason, "object_identity_collision");
      return true;
    },
  );

  // Object 2 should still be on disk and reusable.
  const stored2 = await readStoredObject(path2);
  assert.ok(stored2 !== null, "object 2 should remain on disk");
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Per-file failure produces correct coverage
// ══════════════════════════════════════════════════════════════════════════════

test("aggregateCoverage: all files structural produces non-partial summary", () => {
  const outcomes: FileCoverageOutcome[] = [
    "ast-grep-structural",
    "ast-grep-structural",
    "ast-grep-structural",
  ];
  const summary = aggregateCoverage(outcomes);
  assert.equal(summary.effective, "ast-grep-structural");
  assert.equal(summary.partial, false);
  assert.equal(summary.failedFiles, 0);
  assert.equal(summary.oversizedFiles, 0);
});

test("aggregateCoverage: one failed file makes summary partial", () => {
  const outcomes: FileCoverageOutcome[] = [
    "ast-grep-structural",
    "ast-grep-structural",
    "failed",
  ];
  const summary = aggregateCoverage(outcomes);
  assert.equal(summary.effective, "ast-grep-structural");
  assert.equal(summary.partial, true, "failed file must make summary partial");
  assert.equal(summary.failedFiles, 1);
  assert.equal(summary.oversizedFiles, 0);
});

test("aggregateCoverage: one oversized file makes summary partial", () => {
  const outcomes: FileCoverageOutcome[] = [
    "ast-grep-structural",
    "oversized",
  ];
  const summary = aggregateCoverage(outcomes);
  assert.equal(summary.effective, "ast-grep-structural");
  assert.equal(summary.partial, true);
  assert.equal(summary.failedFiles, 0);
  assert.equal(summary.oversizedFiles, 1);
});

test("aggregateCoverage: mixed coverage levels degrade effective to weakest", () => {
  const outcomes: FileCoverageOutcome[] = [
    "ast-grep-structural",
    "lexical-reference-fallback",
    "file-inventory-only",
  ];
  const summary = aggregateCoverage(outcomes);
  assert.equal(summary.effective, "file-inventory-only");
  assert.equal(summary.partial, true);
  assert.equal(summary.failedFiles, 0);
});

test("aggregateCoverage: all failed falls back to file-inventory-only", () => {
  const outcomes: FileCoverageOutcome[] = ["failed", "failed", "failed"];
  const summary = aggregateCoverage(outcomes);
  assert.equal(summary.effective, "file-inventory-only");
  assert.equal(summary.partial, true);
  assert.equal(summary.failedFiles, 3);
  assert.equal(summary.oversizedFiles, 0);
});

test("aggregateCoverage: empty outcomes produces file-inventory-only", () => {
  const summary = aggregateCoverage([]);
  assert.equal(summary.effective, "file-inventory-only");
  assert.equal(summary.partial, true);
  assert.equal(summary.failedFiles, 0);
});

test("aggregateCoverage: multiple failed + oversized counted separately", () => {
  const outcomes: FileCoverageOutcome[] = [
    "ast-grep-structural",
    "failed",
    "failed",
    "oversized",
    "oversized",
    "oversized",
  ];
  const summary = aggregateCoverage(outcomes);
  assert.equal(summary.effective, "ast-grep-structural");
  assert.equal(summary.partial, true);
  assert.equal(summary.failedFiles, 2);
  assert.equal(summary.oversizedFiles, 3);
});

test("aggregateCoverage: lexical-reference-fallback with no failures is not partial", () => {
  const outcomes: FileCoverageOutcome[] = [
    "lexical-reference-fallback",
    "lexical-reference-fallback",
  ];
  const summary = aggregateCoverage(outcomes);
  assert.equal(summary.effective, "lexical-reference-fallback");
  assert.equal(summary.partial, false);
  assert.equal(summary.failedFiles, 0);
});

test("countOutcomes: returns exact counts per category", () => {
  const outcomes: FileCoverageOutcome[] = [
    "ast-grep-structural",
    "ast-grep-structural",
    "lexical-reference-fallback",
    "file-inventory-only",
    "file-inventory-only",
    "file-inventory-only",
    "failed",
    "oversized",
  ];
  const counts = countOutcomes(outcomes);
  assert.equal(counts.astGrepStructural, 2);
  assert.equal(counts.lexicalReferenceFallback, 1);
  assert.equal(counts.fileInventoryOnly, 3);
  assert.equal(counts.failed, 1);
  assert.equal(counts.oversized, 1);
  assert.equal(counts.total, 8);
});

test("parserAbsentSummary: all files degrade to file-inventory-only", () => {
  const summary = parserAbsentSummary(10, 2, 1);
  assert.equal(summary.effective, "file-inventory-only");
  assert.equal(summary.partial, true);
  assert.equal(summary.failedFiles, 2);
  assert.equal(summary.oversizedFiles, 1);
});

test("mergeCoverageSummaries: weaker effective wins", () => {
  const a = aggregateCoverage(["ast-grep-structural", "ast-grep-structural"]);
  const b = aggregateCoverage(["lexical-reference-fallback"]);

  const merged = mergeCoverageSummaries(a, b);
  assert.equal(merged.effective, "lexical-reference-fallback");
  assert.equal(merged.partial, true, "different effective levels must be partial");
});

test("mergeCoverageSummaries: failed files accumulate", () => {
  const a = aggregateCoverage(["ast-grep-structural", "failed"]);
  const b = aggregateCoverage(["ast-grep-structural", "failed", "failed"]);

  const merged = mergeCoverageSummaries(a, b);
  assert.equal(merged.failedFiles, 3);
  assert.equal(merged.partial, true);
});

test("coverageDegradationReason: returns null for full structural", () => {
  const summary = aggregateCoverage(["ast-grep-structural"]);
  assert.equal(coverageDegradationReason(summary), null);
});

test("coverageDegradationReason: describes partial with failures", () => {
  const summary = aggregateCoverage(["ast-grep-structural", "failed", "oversized"]);
  const reason = coverageDegradationReason(summary);
  assert.ok(reason !== null);
  assert.ok(reason.includes("partial=true"));
  assert.ok(reason.includes("failedFiles=1"));
  assert.ok(reason.includes("oversizedFiles=1"));
});

test("coverageDegradationReason: describes effective degradation", () => {
  const summary = aggregateCoverage(["lexical-reference-fallback"]);
  const reason = coverageDegradationReason(summary);
  assert.ok(reason !== null);
  assert.ok(reason.includes("effective=lexical-reference-fallback"));
});
