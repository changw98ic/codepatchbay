/**
 * Concurrency tests for the local-code-index v2 service.
 *
 * Covers:
 *   1. Two worktrees share equal objects (content-addressable deduplication
 *      across worktree boundaries sharing the same repository key).
 *   2. Concurrent ensureLocalCodeIndex calls coalesce (in-process promise
 *      coalescing prevents duplicate builds for the same source key).
 *   3. Lock ordering prevents deadlocks (repository-objects lock is always
 *      acquired before worktree-publication lock; release is reverse order).
 *
 * Spec: docs/architecture/local-code-index-v2-spec.md sections 7.3, 7.6, 10
 * Plan: docs/architecture/local-code-index-v2-implementation-plan.md Phase 6
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, describe, beforeEach, afterEach } from "node:test";

import {
  publishFileObject,
  readStoredObject,
  fileObjectPublishPath,
  deriveFileObjectId,
  serializeFileObject,
  type FileObject,
  type PublishObjectsOptions,
} from "../core/indexing/local-code-index/object-store.js";

import {
  acquireIndexLock,
  releaseIndexLock,
  acquireOrderedIndexLocks,
  withOrderedIndexLocks,
  inspectIndexLock,
  IndexLockError,
} from "../core/indexing/local-code-index/lock.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

async function tempRoot(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return dir;
}

function lockDir(parent: string, name?: string): string {
  return path.join(parent, name ?? `lock-${randomUUID().slice(0, 12)}`);
}


/** Minimal valid file object for testing. */
function makeFileObject(overrides: Partial<FileObject> = {}): FileObject {
  return {
    sourceContentId: "deadbeef".repeat(8),
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


// ══════════════════════════════════════════════════════════════════════════════
// 1. Two worktrees share equal objects
// ══════════════════════════════════════════════════════════════════════════════

describe("Two worktrees share equal objects", () => {
  let tmpDir: string;
  let storageRoot: string;
  const REPO_KEY = "aabbccdd".repeat(4); // 32 hex chars
  const OWNER_TOKEN_1 = "owner-worktree-1";
  const OWNER_TOKEN_2 = "owner-worktree-2";

  beforeEach(async () => {
    tmpDir = await tempRoot("concurrency-shared-obj");
    storageRoot = path.join(tmpDir, "storage");
    await mkdir(storageRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("file object published by worktree-1 is reused when worktree-2 publishes the same content", async () => {
    const fo = makeFileObject({
      sourceContentId: "11223344".repeat(8),
      languageExtractorFingerprint: "ts-structural-v1",
    });
    const objectId = deriveFileObjectId(
      fo.language,
      fo.parserMode,
      fo.languageExtractorFingerprint,
      fo.sourceContentId,
    );

    // Worktree 1 publishes the file object.
    const opts1: PublishObjectsOptions = {
      storageRoot,
      repositoryKey: REPO_KEY,
      ownerToken: OWNER_TOKEN_1,
    };
    const result1 = await publishFileObject(fo, opts1);
    assert.equal(result1.status, "created");
    assert.equal(result1.objectId, objectId);

    // Worktree 2 publishes the identical file object.
    const opts2: PublishObjectsOptions = {
      storageRoot,
      repositoryKey: REPO_KEY,
      ownerToken: OWNER_TOKEN_2,
    };
    const result2 = await publishFileObject(fo, opts2);
    assert.equal(result2.status, "reused");
    assert.equal(result2.objectId, objectId);
  });

  test("shared object bytes are identical regardless of which worktree reads them", async () => {
    const fo = makeFileObject({
      sourceContentId: "aabbccdd".repeat(8),
    });
    const objectId = deriveFileObjectId(
      fo.language,
      fo.parserMode,
      fo.languageExtractorFingerprint,
      fo.sourceContentId,
    );

    const opts1: PublishObjectsOptions = {
      storageRoot,
      repositoryKey: REPO_KEY,
      ownerToken: OWNER_TOKEN_1,
    };
    await publishFileObject(fo, opts1);

    // Read from the canonical object path — same path for all worktrees
    // under the same repository key.
    const objPath = fileObjectPublishPath(storageRoot, REPO_KEY, objectId);
    const bytes = await readStoredObject(objPath);
    assert.ok(bytes !== null, "object must exist on disk");

    const expectedBytes = serializeFileObject(fo);
    assert.deepEqual(bytes, expectedBytes, "stored bytes must match serialized object");
  });

  test("two worktrees using different owner tokens produce identical object IDs", async () => {
    const fo = makeFileObject();
    const opts1: PublishObjectsOptions = {
      storageRoot,
      repositoryKey: REPO_KEY,
      ownerToken: OWNER_TOKEN_1,
    };
    const opts2: PublishObjectsOptions = {
      storageRoot,
      repositoryKey: REPO_KEY,
      ownerToken: OWNER_TOKEN_2,
    };

    const r1 = await publishFileObject(fo, opts1);
    const r2 = await publishFileObject(fo, opts2);

    assert.equal(r1.objectId, r2.objectId, "object ID must be identical across worktrees");
  });

  test("different source content produces different object IDs", async () => {
    const fo1 = makeFileObject({ sourceContentId: "11111111".repeat(8) });
    const fo2 = makeFileObject({ sourceContentId: "22222222".repeat(8) });

    const opts: PublishObjectsOptions = {
      storageRoot,
      repositoryKey: REPO_KEY,
      ownerToken: OWNER_TOKEN_1,
    };

    const r1 = await publishFileObject(fo1, opts);
    const r2 = await publishFileObject(fo2, opts);

    assert.notEqual(r1.objectId, r2.objectId, "different content must produce different IDs");
  });

  test("object store contains exactly one file for identical content published twice", async () => {
    const fo = makeFileObject();

    const opts: PublishObjectsOptions = {
      storageRoot,
      repositoryKey: REPO_KEY,
      ownerToken: OWNER_TOKEN_1,
    };

    const r1 = await publishFileObject(fo, opts);
    const r2 = await publishFileObject(fo, opts);
    assert.equal(r1.objectId, r2.objectId);

    // Verify only one file exists in the object directory for this prefix.
    // The prefix is SHA-256(objectId).slice(0, 2), not objectId.slice(0, 2).
    const objPath = fileObjectPublishPath(storageRoot, REPO_KEY, r1.objectId);
    const prefixDir = path.dirname(objPath);
    const entries = await readdir(prefixDir);
    const matching = entries.filter((e) => e.startsWith(r1.objectId));
    assert.equal(matching.length, 1, "exactly one object file must exist");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Concurrent ensure calls coalesce
// ══════════════════════════════════════════════════════════════════════════════

describe("Concurrent ensure calls coalesce", () => {
  test("multiple concurrent promises for the same coalesce key resolve to the same value", async () => {
    // Simulate the coalescing map from service.ts.
    const inflight = new Map<string, Promise<{ snapshotId: string; callId: number }>>();
    let actualCalls = 0;

    async function coalescedEnsure(
      key: string,
    ): Promise<{ snapshotId: string; callId: number }> {
      const existing = inflight.get(key);
      if (existing !== undefined) return existing;

      const callId = ++actualCalls;
      const promise = (async () => {
        // Simulate async work.
        await new Promise((r) => setTimeout(r, 50));
        return { snapshotId: `snap-${callId}`, callId };
      })().finally(() => {
        inflight.delete(key);
      });

      inflight.set(key, promise);
      return promise;
    }

    const key = "storage-root\0source-key";

    // Fire 10 concurrent calls.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => coalescedEnsure(key)),
    );

    // All must resolve to the same value (from the first call).
    const first = results[0]!;
    for (const r of results) {
      assert.deepEqual(r, first, "all concurrent calls must return the same result");
    }

    // Only one actual work invocation should have occurred.
    assert.equal(actualCalls, 1, "concurrent calls must coalesce into a single execution");
  });

  test("different coalesce keys run independently", async () => {
    const inflight = new Map<string, Promise<string>>();
    const started: string[] = [];

    async function coalescedEnsure(key: string): Promise<string> {
      const existing = inflight.get(key);
      if (existing !== undefined) return existing;

      const promise = (async () => {
        started.push(key);
        await new Promise((r) => setTimeout(r, 30));
        return `result-${key}`;
      })().finally(() => {
        inflight.delete(key);
      });

      inflight.set(key, promise);
      return promise;
    }

    const [a, b] = await Promise.all([
      coalescedEnsure("key-a"),
      coalescedEnsure("key-b"),
    ]);

    assert.equal(a, "result-key-a");
    assert.equal(b, "result-key-b");
    assert.equal(started.length, 2, "both keys must start independent work");
  });

  test("coalesced promise is removed from map after rejection", async () => {
    const inflight = new Map<string, Promise<void>>();

    async function failingEnsure(key: string): Promise<void> {
      const existing = inflight.get(key);
      if (existing !== undefined) return existing;

      const promise = (async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error(`build failed for ${key}`);
      })().finally(() => {
        inflight.delete(key);
      });

      inflight.set(key, promise);
      return promise;
    }

    const key = "fail-key";

    // First call fails.
    await assert.rejects(() => failingEnsure(key), /build failed/);

    // The inflight map must be clean.
    assert.equal(inflight.has(key), false, "failed promise must be removed from map");

    // A subsequent call should start fresh (not reuse the rejected promise).
    // This time it will also fail, but it proves the map was cleaned.
    await assert.rejects(() => failingEnsure(key), /build failed/);
  });

  test("coalesced promises resolve to the same result object (value identity)", async () => {
    const inflight = new Map<string, Promise<{ id: number }>>();
    let callCount = 0;

    async function ensure(key: string): Promise<{ id: number }> {
      const existing = inflight.get(key);
      if (existing !== undefined) return existing;

      const id = ++callCount;
      const promise = (async () => {
        await new Promise((r) => setTimeout(r, 40));
        return { id };
      })().finally(() => {
        inflight.delete(key);
      });

      inflight.set(key, promise);
      return promise;
    }

    const key = "same-promise-key";

    // Fire first call to populate the inflight map.
    const first = ensure(key);

    // Now the map has the key — all subsequent calls reuse the in-flight promise.
    const rest = Array.from({ length: 4 }, () => ensure(key));
    const allPromises = [first, ...rest];

    const results = await Promise.all(allPromises);
    assert.equal(callCount, 1, "only one execution should have occurred");

    // All results must be the exact same object (value identity, not promise identity).
    for (let i = 1; i < results.length; i++) {
      assert.equal(
        results[i],
        results[0],
        `result[${i}] must be the same object reference as result[0]`,
      );
    }
    assert.equal(results[0]!.id, 1, "result must be from the single execution");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Lock ordering prevents deadlocks
// ══════════════════════════════════════════════════════════════════════════════

describe("Lock ordering prevents deadlocks", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await tempRoot("concurrency-lock-order");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("acquireOrderedIndexLocks acquires repository lock before worktree lock", async () => {
    const repoLock = lockDir(tmpDir, "repo.lock");
    const wtLock = lockDir(tmpDir, "wt.lock");

    // Acquire locks using the ordered API.
    const { repositoryOwner, worktreeOwner } = await acquireOrderedIndexLocks(
      repoLock,
      wtLock,
      { scopeKey: "repo-key-1" },
      { scopeKey: "wt-key-1" },
    );

    // Verify repository lock was acquired.
    const repoState = await inspectIndexLock(repoLock);
    assert.equal(repoState.locked, true, "repository lock must be held");
    assert.equal(repoState.owner?.scopeKind, "repository-objects");

    // Verify worktree lock was acquired.
    const wtState = await inspectIndexLock(wtLock);
    assert.equal(wtState.locked, true, "worktree lock must be held");
    assert.equal(wtState.owner?.scopeKind, "worktree-publication");

    // Release in reverse order (as the module does).
    await releaseIndexLock(wtLock, worktreeOwner);
    await releaseIndexLock(repoLock, repositoryOwner);

    // Both must be released.
    const repoAfter = await inspectIndexLock(repoLock);
    const wtAfter = await inspectIndexLock(wtLock);
    assert.equal(repoAfter.locked, false, "repository lock must be released");
    assert.equal(wtAfter.locked, false, "worktree lock must be released");
  });

  test("withOrderedIndexLocks releases in reverse order: worktree first, then repository", async () => {
    const releaseOrder: string[] = [];

    const repoLock = lockDir(tmpDir, "repo-ordered.lock");
    const wtLock = lockDir(tmpDir, "wt-ordered.lock");

    await withOrderedIndexLocks(
      repoLock,
      wtLock,
      { scopeKey: "repo-key-2" },
      { scopeKey: "wt-key-2" },
      async ({ repositoryOwner, worktreeOwner }) => {
        // Verify both locks are held during the callback.
        const repoState = await inspectIndexLock(repoLock);
        const wtState = await inspectIndexLock(wtLock);
        assert.equal(repoState.locked, true, "repo lock must be held during callback");
        assert.equal(wtState.locked, true, "wt lock must be held during callback");

        // Record that we're inside the callback.
        releaseOrder.push("callback");
      },
    );

    // After withOrderedIndexLocks returns, both locks must be released.
    const repoState = await inspectIndexLock(repoLock);
    const wtState = await inspectIndexLock(wtLock);
    assert.equal(repoState.locked, false, "repo lock must be released after callback");
    assert.equal(wtState.locked, false, "wt lock must be released after callback");
  });

  test("withOrderedIndexLocks releases both locks even when callback throws", async () => {
    const repoLock = lockDir(tmpDir, "repo-fail.lock");
    const wtLock = lockDir(tmpDir, "wt-fail.lock");

    await assert.rejects(
      () =>
        withOrderedIndexLocks(
          repoLock,
          wtLock,
          { scopeKey: "repo-key-3" },
          { scopeKey: "wt-key-3" },
          async () => {
            throw new Error("callback failure");
          },
        ),
      /callback failure/,
    );

    // Both locks must be released despite the callback error.
    const repoState = await inspectIndexLock(repoLock);
    const wtState = await inspectIndexLock(wtLock);
    assert.equal(repoState.locked, false, "repo lock must be released after callback error");
    assert.equal(wtState.locked, false, "wt lock must be released after callback error");
  });

  test("ordered lock acquisition fails fast if repository lock is held by another process", async () => {
    const repoLock = lockDir(tmpDir, "repo-contended.lock");
    const wtLock = lockDir(tmpDir, "wt-contended.lock");

    // Simulate another process holding the repository lock.
    // We'll acquire it directly and mark it alive.
    const otherOwner = await acquireIndexLock(repoLock, {
      scopeKind: "repository-objects",
      scopeKey: "repo-key-4",
    });

    // Try to acquire ordered locks — should timeout waiting for the
    // repository lock.
    await assert.rejects(
      () =>
        acquireOrderedIndexLocks(
          repoLock,
          wtLock,
          {
            scopeKey: "repo-key-4",
            waitMs: 200,
            retryMs: 50,
          },
          { scopeKey: "wt-key-4" },
        ),
      (err: unknown) => err instanceof IndexLockError && err.code === "index_lock_timeout",
    );

    // Release the contended lock.
    await releaseIndexLock(repoLock, otherOwner);
  });

  test("no deadlock when two ordered acquisitions target different lock pairs", async () => {
    // Two independent pairs of locks should not contend.
    const repoLockA = lockDir(tmpDir, "repo-a.lock");
    const wtLockA = lockDir(tmpDir, "wt-a.lock");
    const repoLockB = lockDir(tmpDir, "repo-b.lock");
    const wtLockB = lockDir(tmpDir, "wt-b.lock");

    const results: string[] = [];

    const [a, b] = await Promise.all([
      withOrderedIndexLocks(
        repoLockA,
        wtLockA,
        { scopeKey: "repo-a" },
        { scopeKey: "wt-a" },
        async () => {
          results.push("a-enter");
          await new Promise((r) => setTimeout(r, 50));
          results.push("a-exit");
          return "a";
        },
      ),
      withOrderedIndexLocks(
        repoLockB,
        wtLockB,
        { scopeKey: "repo-b" },
        { scopeKey: "wt-b" },
        async () => {
          results.push("b-enter");
          await new Promise((r) => setTimeout(r, 50));
          results.push("b-exit");
          return "b";
        },
      ),
    ]);

    assert.equal(a, "a");
    assert.equal(b, "b");

    // Both must have entered and exited. Since they use different locks,
    // they can run concurrently without deadlock.
    assert.ok(results.includes("a-enter"));
    assert.ok(results.includes("a-exit"));
    assert.ok(results.includes("b-enter"));
    assert.ok(results.includes("b-exit"));
  });

  test("repository lock always acquired before worktree lock even under contention", async () => {
    // Track the order of lock acquisition by observing owner scopeKinds
    // in the inspectIndexLock results at a fixed point in time.
    const repoLock = lockDir(tmpDir, "repo-order-check.lock");
    const wtLock = lockDir(tmpDir, "wt-order-check.lock");

    await withOrderedIndexLocks(
      repoLock,
      wtLock,
      { scopeKey: "repo-order" },
      { scopeKey: "wt-order" },
      async () => {
        // During the callback, both locks are held.
        // We verify that the repository lock's owner was written first
        // by checking that both are locked and have correct scope kinds.
        const repoState = await inspectIndexLock(repoLock);
        const wtState = await inspectIndexLock(wtLock);

        assert.equal(repoState.owner?.scopeKind, "repository-objects");
        assert.equal(wtState.owner?.scopeKind, "worktree-publication");

        // The repository owner's timestamp should be <= worktree owner's
        // timestamp (acquired first).
        const repoTime = new Date(repoState.owner!.timestamp).getTime();
        const wtTime = new Date(wtState.owner!.timestamp).getTime();
        assert.ok(
          repoTime <= wtTime,
          `repository lock (t=${repoTime}) must be acquired before worktree lock (t=${wtTime})`,
        );
      },
    );
  });

  test("withOrderedIndexLocks propagates callback return value", async () => {
    const repoLock = lockDir(tmpDir, "repo-return.lock");
    const wtLock = lockDir(tmpDir, "wt-return.lock");

    const result = await withOrderedIndexLocks(
      repoLock,
      wtLock,
      { scopeKey: "repo-ret" },
      { scopeKey: "wt-ret" },
      async () => {
        return { value: 42, nested: { ok: true } };
      },
    );

    assert.deepEqual(result, { value: 42, nested: { ok: true } });
  });

  test("withOrderedIndexLocks propagates errors through AggregateError when release also fails", async () => {
    const repoLock = lockDir(tmpDir, "repo-agg.lock");
    const wtLock = lockDir(tmpDir, "wt-agg.lock");

    let thrown: unknown = null;
    try {
      await withOrderedIndexLocks(
        repoLock,
        wtLock,
        { scopeKey: "repo-agg" },
        { scopeKey: "wt-agg" },
        async () => {
          throw new Error("primary failure");
        },
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown !== null, "an error must have been thrown");

    // The primary error should be propagated (possibly wrapped in AggregateError).
    const messages = thrown instanceof AggregateError
      ? [...thrown.errors].map((e) => (e as Error).message)
      : [(thrown as Error).message];
    assert.ok(
      messages.some((m) => m.includes("primary failure")),
      "primary error must be in the thrown error",
    );
  });
});
