import assert from "node:assert/strict";
import { mkdir, readFile, rename, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import { tempRoot } from "./helpers.js";

function lockPaths(store: AssignmentStore, assignmentId: string) {
  const assignmentDir = path.join(store.baseDir, assignmentId);
  const lockDir = path.join(assignmentDir, "state.lock");
  return { assignmentDir, lockDir, ownerFile: path.join(lockDir, "owner.json") };
}

async function writeOwner(ownerFile: string, owner: Record<string, unknown>) {
  await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, "utf8");
}

async function readOwner(ownerFile: string) {
  return JSON.parse(await readFile(ownerFile, "utf8"));
}

test("AssignmentStore does not steal an old lock from a live local owner", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-live");
  const store = new AssignmentStore(hubRoot);
  const paths = lockPaths(store, "a-live");
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    ownerToken: "live-token",
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  assert.equal(await store._assignmentLockRecoveryKind(paths.lockDir, paths.ownerFile), null);
});

test("AssignmentStore recovers an old lock whose owner process is gone", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-stale");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-stale";
  const paths = lockPaths(store, assignmentId);
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    ownerToken: "dead-token",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  let entered = false;
  await store._withAssignmentLock(assignmentId, async () => {
    entered = true;
  });
  assert.equal(entered, true);
});

test("AssignmentStore release cannot overwrite or delete a replacement lock", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-release-race");
  const store = new AssignmentStore(hubRoot);
  const paths = lockPaths(store, "a-release-race");
  await mkdir(paths.lockDir, { recursive: true });
  const oldOwner = {
    ownerToken: "old-token",
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  await writeOwner(paths.ownerFile, oldOwner);

  const replacement = {
    ownerToken: "replacement-token",
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  const originalRead = store._readAssignmentLockOwner.bind(store);
  let reads = 0;
  store._readAssignmentLockOwner = async (ownerFile) => {
    reads += 1;
    if (reads === 2) {
      await rename(paths.lockDir, `${paths.lockDir}.old`);
      await mkdir(paths.lockDir);
      await writeOwner(paths.ownerFile, replacement);
    }
    return originalRead(ownerFile);
  };

  assert.equal(await store._releaseAssignmentLock(paths.ownerFile, oldOwner.ownerToken), false);
  assert.deepEqual(await readOwner(paths.ownerFile), replacement);
});

test("AssignmentStore released locks are immediately reusable", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-reuse");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-reuse";
  const paths = lockPaths(store, assignmentId);
  let calls = 0;

  await store._withAssignmentLock(assignmentId, async () => { calls += 1; });
  assert.ok((await readOwner(paths.ownerFile)).releasedAt);
  await store._withAssignmentLock(assignmentId, async () => { calls += 1; });

  assert.equal(calls, 2);
  assert.ok((await readOwner(paths.ownerFile)).releasedAt);
});
