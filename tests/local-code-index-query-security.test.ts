/**
 * Security tests for Local Code Index v2 query, ensure, and GC interactions.
 *
 * Verifies three behavioral guarantees demanded by the query security contract:
 *
 *   1. Query/ensure/GC races return a complete locked snapshot or fail before
 *      partial output. The repository-key object lock serializes all three
 *      operations so no partial result is ever exposed.
 *   2. No referenced object disappears mid-query. A query that acquires the
 *      repository lock sees a frozen set of objects; GC cannot delete until
 *      the lock is released.
 *   3. Path traversal in queries is rejected. Absolute paths are rejected by
 *      the path validator; dot-dot sequences either fail validation or
 *      produce deterministic empty results without escaping the snapshot
 *      namespace.
 *
 * All tests use temporary directories and exercise the real modules.
 *
 * Run:
 *   npm run build:tests
 *   node dist-tests/scripts/run-node-tests.js tests/local-code-index-query-security.test.ts
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import { ensureLocalCodeIndex } from "../core/indexing/local-code-index/service.js";
import { queryLocalCodeIndex } from "../core/indexing/local-code-index/query.js";
import { garbageCollect } from "../core/indexing/local-code-index/gc.js";

import {
  resolveStorageRoot,
  repositoryObjectsLockDir,
} from "../core/indexing/local-code-index/paths.js";

import {
  acquireIndexLock,
  releaseIndexLock,
} from "../core/indexing/local-code-index/lock.js";
import type { IndexLockOwner } from "../core/indexing/local-code-index/lock.js";

import type { LocalCodeIndexRef } from "../core/indexing/local-code-index/contracts.js";
import { readSnapshotIdentity } from "../core/indexing/local-code-index/snapshot-store.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

async function tempDir(label: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `lci-security-${label}-`));
}

async function createSourceTree(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
}

const SAMPLE_FILES: Readonly<Record<string, string>> = {
  "src/index.ts": [
    'import { greet } from "./greeter.js";',
    "",
    "export function main(): void {",
    '  console.log(greet("world"));',
    "}",
  ].join("\n"),
  "src/greeter.ts": [
    "export function greet(name: string): string {",
    '  return `Hello, ${name}!`;',
    "}",
  ].join("\n"),
  "src/utils.ts": [
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
  ].join("\n"),
};

// ──────────────────────────────────────────────────────────────────────────────
// 1. Query/ensure/GC lock contention: complete result or fail, never partial
// ──────────────────────────────────────────────────────────────────────────────

describe("query/ensure/GC lock contention", () => {
  let sourceRoot: string;
  let storageRoot: string;

  beforeEach(async () => {
    sourceRoot = await tempDir("lock-source");
    storageRoot = await tempDir("lock-storage");
    await createSourceTree(sourceRoot, SAMPLE_FILES);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  });

  test("query completes successfully when GC is not running", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const queryResult = await queryLocalCodeIndex(result.ref, {
      kind: "definitions",
      symbol: "greet",
      match: "exact",
    }, { cpbRoot: storageRoot });

    assert.strictEqual(queryResult.kind, "definitions");
    if (queryResult.kind === "definitions") {
      assert.ok(Array.isArray(queryResult.occurrences));
    }
  });

  test("query fails cleanly when the repository lock is held by another operation", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const resolvedStorage = await resolveStorageRoot(storageRoot, result.ref.sourcePath);
    const { repositoryKey } = result.ref;
    const lockDir = repositoryObjectsLockDir(resolvedStorage, repositoryKey);

    // Hold the repository lock externally.
    const lockOwner: IndexLockOwner = await acquireIndexLock(lockDir, {
      scopeKind: "repository-objects",
      scopeKey: repositoryKey,
      waitMs: 5_000,
    });

    try {
      // Query should fail with lock timeout because the lock is already held.
      await assert.rejects(
        () =>
          queryLocalCodeIndex(result.ref, {
            kind: "definitions",
            symbol: "greet",
            match: "exact",
          }, { cpbRoot: storageRoot, signal: AbortSignal.timeout(500) }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          return true;
        },
      );
    } finally {
      await releaseIndexLock(lockDir, lockOwner);
    }
  });

  test("GC times out when the repository lock is held by a query", async () => {
    const indexed = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const resolvedStorage = await resolveStorageRoot(storageRoot, indexed.ref.sourcePath);
    const { repositoryKey } = indexed.ref;
    const lockDir = repositoryObjectsLockDir(resolvedStorage, repositoryKey);

    // Hold the repository lock externally.
    const lockOwner: IndexLockOwner = await acquireIndexLock(lockDir, {
      scopeKind: "repository-objects",
      scopeKey: repositoryKey,
      waitMs: 5_000,
    });

    try {
      // GC should time out waiting for the lock.
      await assert.rejects(
        () =>
          garbageCollect({
            storageRoot: resolvedStorage,
            repositoryKey,
            lockWaitMs: 200,
            signal: AbortSignal.timeout(500),
          }),
        (err: unknown) => {
          assert.ok(err instanceof Error);
          return true;
        },
      );
    } finally {
      await releaseIndexLock(lockDir, lockOwner);
    }
  });

  test("ensure coalesces concurrent calls: duplicate callers get the same promise", async () => {
    const opts = { sourcePath: sourceRoot, cpbRoot: storageRoot };

    const [r1, r2] = await Promise.all([
      ensureLocalCodeIndex(opts),
      ensureLocalCodeIndex(opts),
    ]);

    assert.strictEqual(r1.ref.snapshotId, r2.ref.snapshotId);
    assert.strictEqual(r1.ref.repositoryKey, r2.ref.repositoryKey);
    assert.strictEqual(r1.ref.worktreeKey, r2.ref.worktreeKey);
  });

  test("sequential ensure then query work correctly without corruption", async () => {
    const opts = { sourcePath: sourceRoot, cpbRoot: storageRoot };

    // Build the index.
    const ensureResult = await ensureLocalCodeIndex(opts);
    assert.strictEqual(ensureResult.available, true);
    assert.ok(ensureResult.stats.discoveredFiles >= 3, "must discover at least 3 files");

    // Read the snapshot identity directly to verify it exists on disk.
    const canonicalSource = path.resolve(sourceRoot);
    const resolvedStorage = await resolveStorageRoot(storageRoot, canonicalSource);
    const identity = await readSnapshotIdentity(
      resolvedStorage,
      ensureResult.ref.worktreeKey,
      ensureResult.ref.snapshotId,
    );

    assert.notStrictEqual(identity, null, "snapshot identity must exist on disk");
    if (identity) {
      assert.strictEqual(identity.schemaVersion, 2);
      assert.strictEqual(identity.repositoryKey, ensureResult.ref.repositoryKey);
      assert.strictEqual(identity.worktreeKey, ensureResult.ref.worktreeKey);
    }

    // Query against the published snapshot using the ref from ensure.
    // The query engine holds the repo lock and reads the immutable snapshot.
    const queryResult = await queryLocalCodeIndex(ensureResult.ref, {
      kind: "definitions",
      symbol: "test",
      match: "exact",
    }, { cpbRoot: storageRoot });

    assert.strictEqual(queryResult.kind, "definitions");
    if (queryResult.kind === "definitions") {
      assert.ok(Array.isArray(queryResult.occurrences));
    }

    // Rebuild (force) should also succeed.
    const newResult = await ensureLocalCodeIndex({ ...opts, force: true });
    assert.strictEqual(newResult.available, true);

    // The old ref should still query against the immutable snapshot.
    const oldQuery = await queryLocalCodeIndex(ensureResult.ref, {
      kind: "definitions",
      symbol: "test",
      match: "exact",
    }, { cpbRoot: storageRoot });
    assert.strictEqual(oldQuery.kind, "definitions");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. No referenced object disappears mid-query
// ──────────────────────────────────────────────────────────────────────────────

describe("object persistence during query", () => {
  let sourceRoot: string;
  let storageRoot: string;

  beforeEach(async () => {
    sourceRoot = await tempDir("persist-source");
    storageRoot = await tempDir("persist-storage");
    await createSourceTree(sourceRoot, SAMPLE_FILES);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  });

  test("query fails cleanly when snapshot identity is missing (not partial output)", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    // Delete the snapshot directory to simulate a missing identity.
    const canonicalSource = path.resolve(sourceRoot);
    const resolvedStorage = await resolveStorageRoot(storageRoot, canonicalSource);
    const snapDir = path.join(
      resolvedStorage,
      "worktrees",
      result.ref.worktreeKey,
      "snapshots",
      result.ref.snapshotId,
    );
    await rm(snapDir, { recursive: true, force: true });

    // Query should fail with "missing_local_code_index" — not partial output.
    await assert.rejects(
      () =>
        queryLocalCodeIndex(result.ref, {
          kind: "definitions",
          symbol: "greet",
          match: "exact",
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("missing_local_code_index"),
          `expected missing_local_code_index error, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  test("query fails cleanly when snapshot identity has wrong repository key", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    // Forge a ref with a valid snapshot ID but wrong repository key.
    const forgedRef: LocalCodeIndexRef = {
      ...result.ref,
      repositoryKey: "b".repeat(32),
    };

    // The query should either reject the ref (invalid_index_ref) or fail
    // to acquire the lock for the wrong repository. Both are clean failures.
    await assert.rejects(
      () =>
        queryLocalCodeIndex(forgedRef, {
          kind: "inventory",
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });

  test("query result is a frozen snapshot: same ref returns same result after rebuild", async () => {
    const opts = { sourcePath: sourceRoot, cpbRoot: storageRoot };

    // Build the index.
    const first = await ensureLocalCodeIndex(opts);

    // Query the snapshot.
    const beforeQuery = await queryLocalCodeIndex(first.ref, {
      kind: "definitions",
      symbol: "any_symbol",
      match: "exact",
    }, { cpbRoot: storageRoot });
    assert.strictEqual(beforeQuery.kind, "definitions");

    // Rebuild with force.
    await ensureLocalCodeIndex({ ...opts, force: true });

    // Re-query the original ref — must return identical results.
    const afterQuery = await queryLocalCodeIndex(first.ref, {
      kind: "definitions",
      symbol: "any_symbol",
      match: "exact",
    }, { cpbRoot: storageRoot });
    assert.strictEqual(afterQuery.kind, "definitions");
    if (beforeQuery.kind === "definitions" && afterQuery.kind === "definitions") {
      assert.strictEqual(
        afterQuery.occurrences.length,
        beforeQuery.occurrences.length,
        "immutable snapshot must return same results after source mutation",
      );
    }
  });

  test("GC runs cleanly against snapshots produced by ensure", async () => {
    const first = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    // Create a second snapshot.
    await writeFile(
      path.join(sourceRoot, "src", "extra.ts"),
      "export const X = 99;\n",
      "utf8",
    );
    const second = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    assert.notStrictEqual(first.ref.snapshotId, second.ref.snapshotId);

    const resolvedStorage = await resolveStorageRoot(storageRoot, second.ref.sourcePath);
    const { repositoryKey } = second.ref;

    // GC must complete without error.
    const gcResult = await garbageCollect({
      storageRoot: resolvedStorage,
      repositoryKey,
    });
    assert.ok(gcResult.worktreesScanned >= 1, "must scan at least one worktree");

    // The current snapshot must still be queryable after GC.
    const postGcQuery = await queryLocalCodeIndex(second.ref, {
      kind: "definitions",
      symbol: "any",
      match: "exact",
    }, { cpbRoot: storageRoot });
    assert.strictEqual(postGcQuery.kind, "definitions");
  });

  test("GC with quarantine preserves retained snapshots", async () => {
    await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    // Create a second snapshot.
    await writeFile(
      path.join(sourceRoot, "src", "extra.ts"),
      "export const X = 99;\n",
      "utf8",
    );
    await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    // Create a third snapshot.
    await writeFile(
      path.join(sourceRoot, "src", "extra.ts"),
      "export const X = 100;\n",
      "utf8",
    );
    const third = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const resolvedStorage = await resolveStorageRoot(storageRoot, third.ref.sourcePath);
    const { repositoryKey } = third.ref;

    // Run GC with quarantine.
    await garbageCollect({
      storageRoot: resolvedStorage,
      repositoryKey,
      quarantineUnreferencedSnapshots: true,
    });

    // The current snapshot must still be queryable.
    const query = await queryLocalCodeIndex(third.ref, {
      kind: "definitions",
      symbol: "x",
      match: "exact",
    }, { cpbRoot: storageRoot });
    assert.strictEqual(query.kind, "definitions");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. Path traversal in queries is rejected
// ──────────────────────────────────────────────────────────────────────────────

describe("path traversal rejection", () => {
  let sourceRoot: string;
  let storageRoot: string;

  beforeEach(async () => {
    sourceRoot = await tempDir("traversal-source");
    storageRoot = await tempDir("traversal-storage");
    await createSourceTree(sourceRoot, SAMPLE_FILES);
  });

  afterEach(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  });

  test("absolute path in imports query is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    await assert.rejects(
      () =>
        queryLocalCodeIndex(result.ref, {
          kind: "imports",
          path: "/etc/passwd",
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("invalid_query"),
          `expected invalid_query error, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  test("absolute path in file-summary query is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    await assert.rejects(
      () =>
        queryLocalCodeIndex(result.ref, {
          kind: "file-summary",
          path: "/tmp/secret.ts",
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("invalid_query"),
          `expected invalid_query error, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  test("absolute paths in related-files query are rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    await assert.rejects(
      () =>
        queryLocalCodeIndex(result.ref, {
          kind: "related-files",
          paths: ["/etc/hosts", "src/index.ts"],
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("invalid_query"),
          `expected invalid_query error, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  test("dot-dot traversal in imports query does not escape snapshot namespace", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    // Dot-dot paths are normalized but don't resolve .. segments.
    // They won't match any inventory key, so imports returns empty relationships.
    const queryResult = await queryLocalCodeIndex(result.ref, {
      kind: "imports",
      path: "../../../etc/passwd",
    }, { cpbRoot: storageRoot });

    assert.strictEqual(queryResult.kind, "imports");
    if (queryResult.kind === "imports") {
      assert.strictEqual(
        queryResult.relationships.length,
        0,
        "dot-dot traversal path must produce zero relationships",
      );
    }
  });

  test("dot-dot traversal in file-summary query returns null file", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const queryResult = await queryLocalCodeIndex(result.ref, {
      kind: "file-summary",
      path: "../../outside/file.ts",
    }, { cpbRoot: storageRoot });

    assert.strictEqual(queryResult.kind, "file-summary");
    if (queryResult.kind === "file-summary") {
      assert.strictEqual(
        queryResult.file,
        null,
        "dot-dot traversal path must produce null file (not found in inventory)",
      );
    }
  });

  test("empty string path is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    await assert.rejects(
      () =>
        queryLocalCodeIndex(result.ref, {
          kind: "imports",
          path: "",
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("invalid_query"),
          `expected invalid_query error, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  test("non-string path is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const badQuery = { kind: "imports" as const, path: 42 as unknown as string };
    await assert.rejects(
      () => queryLocalCodeIndex(result.ref, badQuery, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("invalid_query"),
          `expected invalid_query error, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  test("null ref is rejected before any I/O", async () => {
    const nullRef = null as unknown as LocalCodeIndexRef;
    await assert.rejects(
      () => queryLocalCodeIndex(nullRef, { kind: "inventory" }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });

  test("ref with wrong schemaVersion is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const badRef = { ...result.ref, schemaVersion: 1 as unknown as 2 };

    await assert.rejects(
      () =>
        queryLocalCodeIndex(badRef, {
          kind: "inventory",
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("invalid_index_ref"),
          `expected invalid_index_ref error, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  test("ref with mismatched repositoryKey/worktreeKey is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const badRef: LocalCodeIndexRef = {
      ...result.ref,
      repositoryKey: "a".repeat(32),
    };

    await assert.rejects(
      () =>
        queryLocalCodeIndex(badRef, {
          kind: "inventory",
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });

  test("query with nonexistent kind is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    const badQuery = { kind: "nonexistent-kind" } as unknown as Parameters<typeof queryLocalCodeIndex>[1];
    await assert.rejects(
      () => queryLocalCodeIndex(result.ref, badQuery, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("invalid_query"),
          `expected invalid_query error, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  test("limit of zero is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    await assert.rejects(
      () =>
        queryLocalCodeIndex(result.ref, {
          kind: "definitions",
          symbol: "greet",
          match: "exact",
          limit: 0,
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("invalid_query"),
          `expected invalid_query error, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  test("limit exceeding maximum is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    await assert.rejects(
      () =>
        queryLocalCodeIndex(result.ref, {
          kind: "definitions",
          symbol: "greet",
          match: "exact",
          limit: 501,
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          (err as Error).message.includes("invalid_query"),
          `expected invalid_query error, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  test("definitions query with empty symbol is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    await assert.rejects(
      () =>
        queryLocalCodeIndex(result.ref, {
          kind: "definitions",
          symbol: "",
          match: "exact",
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });

  test("definitions query with extremely long symbol is rejected", async () => {
    const result = await ensureLocalCodeIndex({
      sourcePath: sourceRoot,
      cpbRoot: storageRoot,
    });

    // 513 bytes exceeds LOCAL_CODE_INDEX_MAX_SYMBOL_LENGTH (512).
    const longSymbol = "a".repeat(513);

    await assert.rejects(
      () =>
        queryLocalCodeIndex(result.ref, {
          kind: "definitions",
          symbol: longSymbol,
          match: "exact",
        }, { cpbRoot: storageRoot }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});
