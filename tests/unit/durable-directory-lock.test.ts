import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { withDurableDirectoryLock } from "../../shared/primitives/durable-directory-lock.js";

test("fenced directory locks acquire and release without process identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-lock-fenced-"));
  const lockPath = path.join(root, "runtime.lock");
  try {
    let ownerRaw = "";
    const value = await withDurableDirectoryLock(
      lockPath,
      async () => {
        ownerRaw = await readFile(path.join(lockPath, "owner.json"), "utf8");
        return "acquired";
      },
      {
        captureIdentity: () => null,
        waitMs: 500,
      },
    );

    assert.equal(value, "acquired");
    const owner = JSON.parse(ownerRaw) as {
      processIdentity?: unknown;
    };
    assert.equal(owner.processIdentity, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fenced directory locks never reclaim an existing lock by age", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-lock-fenced-busy-"));
  const lockPath = path.join(root, "runtime.lock");
  let releaseCallback!: () => void;
  let callbackStarted!: () => void;
  const callbackReady = new Promise<void>((resolve) => { callbackStarted = resolve; });
  const callbackRelease = new Promise<void>((resolve) => { releaseCallback = resolve; });

  try {
    const first = withDurableDirectoryLock(
      lockPath,
      async () => {
        callbackStarted();
        await callbackRelease;
        return "first";
      },
      {
        captureIdentity: () => null,
        ttlMs: 0,
        waitMs: 1_000,
      },
    );
    await callbackReady;

    await assert.rejects(
      withDurableDirectoryLock(
        lockPath,
        async () => "second",
        {
          captureIdentity: () => null,
          ttlMs: 0,
          waitMs: 75,
          retryMs: 5,
        },
      ),
      (error: unknown) => ["DIRECTORY_LOCK_BUSY", "DIRECTORY_LOCK_FENCE_FAILED"].includes(
        String((error as NodeJS.ErrnoException).code || ""),
      ),
    );

    releaseCallback();
    assert.equal(await first, "first");
  } finally {
    releaseCallback?.();
    await rm(root, { recursive: true, force: true });
  }
});
