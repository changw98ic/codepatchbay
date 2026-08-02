import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  acquireIndexLock,
  releaseIndexLock,
} from "../../core/indexing/local-code-index/lock.js";

test("fenced local index locks acquire and release without process identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-index-lock-fenced-"));
  const lockPath = path.join(root, "repository.lock");
  try {
    const owner = await acquireIndexLock(lockPath, {
      scopeKind: "repository-objects",
      scopeKey: "repository-a",
      captureIdentity: () => null,
      waitMs: 500,
    });

    assert.equal(owner.processIdentity, null);
    await releaseIndexLock(lockPath, owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fenced local index locks do not reclaim an existing lock by age", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-index-lock-fenced-busy-"));
  const lockPath = path.join(root, "repository.lock");
  try {
    const owner = await acquireIndexLock(lockPath, {
      scopeKind: "repository-objects",
      scopeKey: "repository-a",
      captureIdentity: () => null,
      waitMs: 500,
    });

    await assert.rejects(
      acquireIndexLock(lockPath, {
        scopeKind: "repository-objects",
        scopeKey: "repository-a",
        captureIdentity: () => null,
        waitMs: 50,
        retryMs: 5,
      }),
      (error: unknown) => (error as { code?: string }).code === "index_lock_timeout",
    );

    await releaseIndexLock(lockPath, owner);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
