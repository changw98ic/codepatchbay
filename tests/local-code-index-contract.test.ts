/**
 * Compile-time contract tests for the Local Code Index v2 public module.
 *
 * These tests verify that the public barrel (core/indexing/local-code-index/index.ts)
 * exports exactly the types, classes, and constants declared in the spec
 * (docs/architecture/local-code-index-v2-spec.md section 5) and nothing more.
 *
 * Several assertions are purely type-level: the TypeScript compiler itself
 * rejects the file if the contract is violated.  The remaining checks are
 * runtime assertions executed by the Node test runner.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  // ── value exports (runtime-checkable) ────────────────────────────────────
  LOCAL_CODE_INDEX_DEFAULT_LIMIT,
  LOCAL_CODE_INDEX_MAX_LIMIT,
  LocalCodeIndexUnavailableError,

  // ── type-only exports (compile-time checks below) ────────────────────────
  type LocalCodeIndexRef,
  type LocalCodeIndexQuery,
  type LocalCodeIndexQueryResult,
  type LocalCodeIndexCoverage,
  type LocalCodeIndexCoverageSummary,
  type LocalCodeIndexErrorReason,
} from "../core/indexing/local-code-index/index.js";

// Import the entire module as a namespace for negative export checks
import * as publicModule from "../core/indexing/local-code-index/index.js";

// ──────────────────────────────────────────────────────────────────────────────
// Compile-time type helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Fails to compile if T is not exactly `true`. */
type Expect<T extends true> = T;

/** True when A and B are mutually assignable (exact structural equality). */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// ══════════════════════════════════════════════════════════════════════════════
// 1. Internal storage types are NOT exported from the public module.
// ══════════════════════════════════════════════════════════════════════════════

test("manifestPath is not a public export", () => {
  // @ts-expect-error — manifestPath must not exist on the public module namespace
  void publicModule.manifestPath;
});

test("indexFile is not a public export", () => {
  // @ts-expect-error — indexFile must not exist on the public module namespace
  void publicModule.indexFile;
});

test("storage-layout object types are not public exports", () => {
  // Internal storage types (spec section 7) must not leak through the barrel.
  // @ts-expect-error — FileObject is an internal storage type, not exported
  void publicModule.FileObject;

  // @ts-expect-error — BlobMapObject is an internal storage type, not exported
  void publicModule.BlobMapObject;

  // @ts-expect-error — SymbolShard is an internal storage type, not exported
  void publicModule.SymbolShard;

  // @ts-expect-error — RelationShard is an internal storage type, not exported
  void publicModule.RelationShard;

  // @ts-expect-error — SnapshotIdentity is an internal storage type, not exported
  void publicModule.SnapshotIdentity;

  // @ts-expect-error — IndexMap is an internal storage type, not exported
  void publicModule.IndexMap;
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. LocalCodeIndexRef has exactly the 6 declared fields.
// ══════════════════════════════════════════════════════════════════════════════

test("LocalCodeIndexRef key set is exactly {schemaVersion, sourcePath, repositoryKey, worktreeKey, sourceKey, snapshotId} (compile-time)", () => {
  // This is a pure compile-time assertion.  If LocalCodeIndexRef gains or
  // loses a key the following type alias resolves to something other than
  // `true` and the file fails to compile.
  type RefKeys = keyof LocalCodeIndexRef;
  type ExpectedKeys =
    | "schemaVersion"
    | "sourcePath"
    | "repositoryKey"
    | "worktreeKey"
    | "sourceKey"
    | "snapshotId";

  // Bidirectional assignability: the key sets must be identical.
  type _Check = Expect<Equal<RefKeys, ExpectedKeys>>;

  // Also verify schemaVersion is the literal type 2.
  type _SchemaCheck = Expect<
    Equal<
      LocalCodeIndexRef["schemaVersion"],
      2
    >
  >;

  // Runtime: construct a conforming value and verify key count.
  const ref: LocalCodeIndexRef = {
    schemaVersion: 2,
    sourcePath: "/tmp/test",
    repositoryKey: "a".repeat(32),
    worktreeKey: "b".repeat(32),
    sourceKey: "c".repeat(64),
    snapshotId: "snap-001",
  };
  const keys = Object.keys(ref).sort();
  assert.deepStrictEqual(keys, [
    "repositoryKey",
    "schemaVersion",
    "snapshotId",
    "sourceKey",
    "sourcePath",
    "worktreeKey",
  ]);
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. LocalCodeIndexQuery discriminated union covers all 6 query kinds.
// ══════════════════════════════════════════════════════════════════════════════

test("LocalCodeIndexQuery.kind covers exactly 6 kinds (compile-time)", () => {
  // Extract the discriminant from the union.
  type QueryKind = LocalCodeIndexQuery["kind"];

  // The spec declares exactly these six.
  type ExpectedKind =
    | "definitions"
    | "references"
    | "imports"
    | "file-summary"
    | "related-files"
    | "inventory";

  type _Check = Expect<Equal<QueryKind, ExpectedKind>>;

  // Verify each variant is individually assignable to the union.
  type _Def = Expect<
    Equal<
      Extract<LocalCodeIndexQuery, { kind: "definitions" }>["kind"],
      "definitions"
    >
  >;
  type _Ref = Expect<
    Equal<
      Extract<LocalCodeIndexQuery, { kind: "references" }>["kind"],
      "references"
    >
  >;
  type _Imp = Expect<
    Equal<
      Extract<LocalCodeIndexQuery, { kind: "imports" }>["kind"],
      "imports"
    >
  >;
  type _FS = Expect<
    Equal<
      Extract<LocalCodeIndexQuery, { kind: "file-summary" }>["kind"],
      "file-summary"
    >
  >;
  type _RF = Expect<
    Equal<
      Extract<LocalCodeIndexQuery, { kind: "related-files" }>["kind"],
      "related-files"
    >
  >;
  type _Inv = Expect<
    Equal<
      Extract<LocalCodeIndexQuery, { kind: "inventory" }>["kind"],
      "inventory"
    >
  >;

  // Exhaustiveness: assigning to `never` proves nothing is left over.
  type Remaining = Exclude<QueryKind, ExpectedKind>;
  type _Exhaustive = Expect<Equal<Remaining, never>>;

  // Runtime: verify each kind is a valid discriminated-union member.
  const kinds: QueryKind[] = [
    "definitions",
    "references",
    "imports",
    "file-summary",
    "related-files",
    "inventory",
  ];
  assert.strictEqual(kinds.length, 6);

  // Verify each kind can narrow to the correct variant at runtime.
  for (const kind of kinds) {
    // Narrowing: every kind is a valid LocalCodeIndexQuery["kind"].
    const q: LocalCodeIndexQuery = { kind } as LocalCodeIndexQuery;
    assert.strictEqual(q.kind, kind);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. LocalCodeIndexUnavailableError has a `reason` field.
// ══════════════════════════════════════════════════════════════════════════════

test("LocalCodeIndexUnavailableError has a reason field (compile-time + runtime)", () => {
  // Compile-time: the class must expose `reason` of type LocalCodeIndexErrorReason.
  type _ReasonExists = Expect<
    "reason" extends keyof InstanceType<typeof LocalCodeIndexUnavailableError>
      ? true
      : false
  >;

  // Compile-time: the error must also carry the fixed `code` discriminant.
  type _CodeExists = Expect<
    "code" extends keyof InstanceType<typeof LocalCodeIndexUnavailableError>
      ? true
      : false
  >;

  // Runtime: construct every valid reason and verify the field is set.
  const reasons: LocalCodeIndexErrorReason[] = [
    "missing_source_path",
    "unsafe_source_path",
    "unsafe_storage_root",
    "missing_local_code_index",
    "unsupported_index_schema",
    "corrupt_index",
    "invalid_index_ref",
    "invalid_query",
    "invalid_cursor",
    "cursor_snapshot_mismatch",
    "operation_aborted",
    "unsupported_platform",
    "unsupported_git_state",
    "index_lock_timeout",
    "index_lock_lost",
    "index_lock_repair_required",
    "source_changed_during_index",
    "parser_unavailable",
    "parser_output_invalid",
    "index_publication_failed",
    "index_publication_ambiguous",
    "object_identity_collision",
    "snapshot_identity_collision",
    "index_cleanup_ambiguous",
  ];

  for (const reason of reasons) {
    const err = new LocalCodeIndexUnavailableError(reason);
    assert.strictEqual(err.reason, reason);
    assert.strictEqual(err.code, "local_code_index_unavailable");
    assert.strictEqual(err.name, "LocalCodeIndexUnavailableError");
    assert.ok(err instanceof Error);
    assert.ok(err instanceof LocalCodeIndexUnavailableError);
    assert.ok(err.message.includes(reason));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Limits are exported and have the correct values.
// ══════════════════════════════════════════════════════════════════════════════

test("LOCAL_CODE_INDEX_DEFAULT_LIMIT is 50", () => {
  assert.strictEqual(LOCAL_CODE_INDEX_DEFAULT_LIMIT, 50);

  // Compile-time: must be a literal 50, not a widened number.
  type _Check = Expect<Equal<typeof LOCAL_CODE_INDEX_DEFAULT_LIMIT, 50>>;
});

test("LOCAL_CODE_INDEX_MAX_LIMIT is 500", () => {
  assert.strictEqual(LOCAL_CODE_INDEX_MAX_LIMIT, 500);

  // Compile-time: must be a literal 500, not a widened number.
  type _Check = Expect<Equal<typeof LOCAL_CODE_INDEX_MAX_LIMIT, 500>>;
});

test("default limit is less than max limit", () => {
  assert.ok(
    LOCAL_CODE_INDEX_DEFAULT_LIMIT < LOCAL_CODE_INDEX_MAX_LIMIT,
    `default (${LOCAL_CODE_INDEX_DEFAULT_LIMIT}) must be < max (${LOCAL_CODE_INDEX_MAX_LIMIT})`,
  );
});
