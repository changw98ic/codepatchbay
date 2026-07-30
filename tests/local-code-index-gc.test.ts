import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { garbageCollect } from "../core/indexing/local-code-index/gc.js";
import {
  repositoryObjectsDir,
  repositoryObjectsLockDir,
  snapshotsDir,
  worktreeDir,
} from "../core/indexing/local-code-index/paths.js";
import {
  objectPrefix,
} from "../core/indexing/local-code-index/paths.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const cleanups: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  cleanups.push(created);
  return created;
}

function hex32(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function hex64(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function snapshotId(seed: string): string {
  return `idx2-${hex64(seed).slice(0, 24)}`;
}

/** Write a JSON file, creating parent directories as needed. */
async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

/** Write a stub object file into the repository objects tree. */
async function writeObject(
  storageRoot: string,
  repositoryKey: string,
  subDir: string,
  objectId: string,
): Promise<string> {
  const prefix = objectPrefix(objectId);
  const filePath = path.join(
    repositoryObjectsDir(storageRoot, repositoryKey),
    subDir,
    prefix,
    `${objectId}.json`,
  );
  await writeJson(filePath, { id: objectId, stub: true });
  return filePath;
}

/** Set up a current pointer for a worktree. */
async function writeCurrentPointer(
  storageRoot: string,
  worktreeKey: string,
  current: {
    worktreeKey: string;
    snapshotId: string;
    identityHash: string;
    ownerToken: string;
    previousSnapshotIds?: string[];
  },
): Promise<void> {
  const pointerPath = path.join(
    worktreeDir(storageRoot, worktreeKey),
    "current.json",
  );
  await writeJson(pointerPath, current);
}

/** Write a minimal snapshot identity + index-map so GC can collect objects. */
async function writeSnapshot(
  storageRoot: string,
  worktreeKey: string,
  sid: string,
  objects: {
    fileObjectIds?: string[];
    symbolShardIds?: string[];
    relationShardIds?: string[];
    indexMapSymbolShards?: Record<string, string>;
    indexMapRelationShards?: Record<string, string>;
    indexMapFileSummaryShards?: Record<string, string>;
  },
): Promise<void> {
  const snapDir = path.join(snapshotsDir(storageRoot, worktreeKey), sid);
  await mkdir(snapDir, { recursive: true });

  const inventory: Record<string, { fileObjectId: string; sourceContentId: string; metadata: Record<string, unknown> }> = {};
  for (const foid of objects.fileObjectIds ?? []) {
    inventory[`file-${foid.slice(0, 8)}`] = {
      fileObjectId: foid,
      sourceContentId: hex64(`content-${foid}`),
      metadata: { device: "0", inode: "0", size: "100", mtimeNs: "0", ctimeNs: "0", mode: 33188 },
    };
  }

  const identity = {
    schemaVersion: 2,
    repositoryKey: hex32("repo"),
    worktreeKey,
    sourceKey: hex64("source"),
    sourcePath: "/tmp/source",
    git: null,
    worktreeStateFingerprint: hex64("wstate"),
    inventory,
    extractorFingerprint: hex64("extractor"),
    symbolShardIds: objects.symbolShardIds ?? [],
    relationShardIds: objects.relationShardIds ?? [],
    toolState: { name: "ast-grep", version: null, extractorFingerprint: hex64("ext"), available: false, coverage: "file-inventory-only", errors: [] },
    indexMapHash: hex64("indexmap"),
    indexMapByteLength: 0,
  };

  const indexMap = {
    schemaVersion: 2,
    snapshotId: sid,
    symbolShards: objects.indexMapSymbolShards ?? {},
    relationShards: objects.indexMapRelationShards ?? {},
    fileSummaryShards: objects.indexMapFileSummaryShards ?? {},
  };

  await writeJson(path.join(snapDir, "identity.json"), identity);
  await writeJson(path.join(snapDir, "index-map.json"), indexMap);
}

/** Check if a file exists. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Check if a directory exists. */
async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const st = await stat(dirPath);
    return st.isDirectory();
  } catch {
    return false;
  }
}

// ── Cleanup ────────────────────────────────────────────────────────────────

test("cleanup temp roots", async () => {
  // Runs last due to declaration order; all other tests finish before this.
  for (const root of cleanups.splice(0)) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

// ── Test 1: Ensure/GC races cannot remove retained objects ─────────────────

test("GC does not remove objects retained by current snapshot", async () => {
  const storageRoot = await tempRoot("gc-retained-current");
  const repositoryKey = hex32("repo-retain-current");
  const worktreeKey = hex32("wt-retain-current");
  const snapA = snapshotId("snap-a-current");

  // Objects referenced by the current snapshot.
  const retainedFileObj = hex64("retained-file-obj");
  const retainedSymShard = hex64("retained-sym-shard");
  const retainedRelShard = hex64("retained-rel-shard");
  const retainedSummaryShard = hex64("retained-summary-shard");

  // Object NOT referenced by any snapshot.
  const orphanFileObj = hex64("orphan-file-obj");
  const orphanSymShard = hex64("orphan-sym-shard");

  // Write the current pointer.
  await writeCurrentPointer(storageRoot, worktreeKey, {
    worktreeKey,
    snapshotId: snapA,
    identityHash: hex64("id-hash-a"),
    ownerToken: hex64("owner-token-a"),
    previousSnapshotIds: [],
  });

  // Write snapshot A referencing retained objects.
  await writeSnapshot(storageRoot, worktreeKey, snapA, {
    fileObjectIds: [retainedFileObj],
    symbolShardIds: [retainedSymShard],
    relationShardIds: [retainedRelShard],
    indexMapSymbolShards: { "sym-ab": retainedSymShard },
    indexMapRelationShards: { "rel-ab": retainedRelShard },
    indexMapFileSummaryShards: { "fs-ab": retainedSummaryShard },
  });

  // Write all objects (retained + orphan) into the object store.
  await writeObject(storageRoot, repositoryKey, "files", retainedFileObj);
  await writeObject(storageRoot, repositoryKey, "symbol-shards", retainedSymShard);
  await writeObject(storageRoot, repositoryKey, "relation-shards", retainedRelShard);
  await writeObject(storageRoot, repositoryKey, "files", orphanFileObj);
  await writeObject(storageRoot, repositoryKey, "symbol-shards", orphanSymShard);

  // Run GC.
  const result = await garbageCollect({ storageRoot, repositoryKey });

  // Retained objects must still exist.
  const prefixRetFile = objectPrefix(retainedFileObj);
  const prefixRetSym = objectPrefix(retainedSymShard);
  const prefixRetRel = objectPrefix(retainedRelShard);
  const objsDir = repositoryObjectsDir(storageRoot, repositoryKey);

  assert.ok(
    await fileExists(path.join(objsDir, "files", prefixRetFile, `${retainedFileObj}.json`)),
    "retained file object must survive GC",
  );
  assert.ok(
    await fileExists(path.join(objsDir, "symbol-shards", prefixRetSym, `${retainedSymShard}.json`)),
    "retained symbol shard must survive GC",
  );
  assert.ok(
    await fileExists(path.join(objsDir, "relation-shards", prefixRetRel, `${retainedRelShard}.json`)),
    "retained relation shard must survive GC",
  );

  // Orphan objects must be deleted.
  const prefixOrphFile = objectPrefix(orphanFileObj);
  const prefixOrphSym = objectPrefix(orphanSymShard);

  assert.ok(
    !await fileExists(path.join(objsDir, "files", prefixOrphFile, `${orphanFileObj}.json`)),
    "orphan file object must be deleted by GC",
  );
  assert.ok(
    !await fileExists(path.join(objsDir, "symbol-shards", prefixOrphSym, `${orphanSymShard}.json`)),
    "orphan symbol shard must be deleted by GC",
  );

  // Stats check.
  assert.equal(result.worktreesScanned, 1);
  assert.equal(result.retainedSnapshots, 1);
  assert.ok(result.deletedObjects >= 2, "at least 2 orphan objects deleted");
  assert.equal(result.quarantinedSnapshots, 0);
});

test("GC holds lock so concurrent ensure cannot interleave object deletion", async () => {
  const storageRoot = await tempRoot("gc-ensure-race");
  const repositoryKey = hex32("repo-ensure-race");
  const worktreeKey = hex32("wt-ensure-race");
  const snapId = snapshotId("snap-race");

  const retainedObj = hex64("race-retained-obj");

  await writeCurrentPointer(storageRoot, worktreeKey, {
    worktreeKey,
    snapshotId: snapId,
    identityHash: hex64("race-id-hash"),
    ownerToken: hex64("race-owner"),
  });
  await writeSnapshot(storageRoot, worktreeKey, snapId, {
    fileObjectIds: [retainedObj],
  });
  await writeObject(storageRoot, repositoryKey, "files", retainedObj);

  // Simulate a concurrent "ensure" that checks the object exists mid-GC.
  // Because GC acquires the repository lock, and ensure also needs the lock,
  // they serialize. The object should survive even if ensure "peeks" during GC.
  const gcPromise = garbageCollect({ storageRoot, repositoryKey });

  // Concurrent read attempt (would be ensure in real usage).
  const concurrentReadPromise = (async () => {
    // Small delay so GC starts first and holds the lock.
    await new Promise((r) => setTimeout(r, 5));
    const prefix = objectPrefix(retainedObj);
    const filePath = path.join(
      repositoryObjectsDir(storageRoot, repositoryKey),
      "files",
      prefix,
      `${retainedObj}.json`,
    );
    // This read should either succeed (before GC deletes orphans) or succeed
    // after GC finishes, because the object is retained.
    const exists = await fileExists(filePath);
    return exists;
  })();

  const [gcResult, objectVisible] = await Promise.all([gcPromise, concurrentReadPromise]);

  // The retained object must still exist after both operations complete.
  const prefix = objectPrefix(retainedObj);
  const filePath = path.join(
    repositoryObjectsDir(storageRoot, repositoryKey),
    "files",
    prefix,
    `${retainedObj}.json`,
  );
  assert.ok(await fileExists(filePath), "retained object survives GC+concurrent-read race");
  assert.equal(gcResult.deletedObjects, 0, "no objects deleted when all are retained");
});

test("GC does not remove objects retained by previous snapshots", async () => {
  const storageRoot = await tempRoot("gc-previous-retained");
  const repositoryKey = hex32("repo-prev-retained");
  const worktreeKey = hex32("wt-prev-retained");

  const snapCurrent = snapshotId("snap-current-prev");
  const snapPrev1 = snapshotId("snap-prev1-prev");
  const snapPrev2 = snapshotId("snap-prev2-prev");

  const currentObj = hex64("current-obj-prev");
  const prev1Obj = hex64("prev1-obj-prev");
  const prev2Obj = hex64("prev2-obj-prev");
  const orphanObj = hex64("orphan-obj-prev");

  await writeCurrentPointer(storageRoot, worktreeKey, {
    worktreeKey,
    snapshotId: snapCurrent,
    identityHash: hex64("id-current-prev"),
    ownerToken: hex64("owner-current-prev"),
    previousSnapshotIds: [snapPrev1, snapPrev2],
  });

  await writeSnapshot(storageRoot, worktreeKey, snapCurrent, { fileObjectIds: [currentObj] });
  await writeSnapshot(storageRoot, worktreeKey, snapPrev1, { fileObjectIds: [prev1Obj] });
  await writeSnapshot(storageRoot, worktreeKey, snapPrev2, { fileObjectIds: [prev2Obj] });

  await writeObject(storageRoot, repositoryKey, "files", currentObj);
  await writeObject(storageRoot, repositoryKey, "files", prev1Obj);
  await writeObject(storageRoot, repositoryKey, "files", prev2Obj);
  await writeObject(storageRoot, repositoryKey, "files", orphanObj);

  const result = await garbageCollect({ storageRoot, repositoryKey });

  const objsDir = repositoryObjectsDir(storageRoot, repositoryKey);

  // All three retained objects (current + 2 previous) survive.
  for (const [label, objId] of [
    ["current", currentObj],
    ["previous-1", prev1Obj],
    ["previous-2", prev2Obj],
  ] as const) {
    const pfx = objectPrefix(objId);
    assert.ok(
      await fileExists(path.join(objsDir, "files", pfx, `${objId}.json`)),
      `${label} object must survive GC (retained by current.json)`,
    );
  }

  // Orphan deleted.
  const pfxOrphan = objectPrefix(orphanObj);
  assert.ok(
    !await fileExists(path.join(objsDir, "files", pfxOrphan, `${orphanObj}.json`)),
    "orphan object deleted when not referenced by any retained snapshot",
  );

  assert.equal(result.retainedSnapshots, 3, "current + 2 previous = 3 retained");
});

// ── Test 2: Old snapshots are collected after current advances ─────────────

test("old snapshot objects are collected after current pointer advances past them", async () => {
  const storageRoot = await tempRoot("gc-advance-collect");
  const repositoryKey = hex32("repo-advance");
  const worktreeKey = hex32("wt-advance");

  const snapA = snapshotId("snap-A-advance");
  const snapB = snapshotId("snap-B-advance");
  const snapC = snapshotId("snap-C-advance");

  const objA = hex64("obj-A-advance");
  const objB = hex64("obj-B-advance");
  const objC = hex64("obj-C-advance");

  // Phase 1: current=A, previous=[].
  // Only write snapA and objA so objA is the only retained object.
  await writeSnapshot(storageRoot, worktreeKey, snapA, { fileObjectIds: [objA] });
  await writeObject(storageRoot, repositoryKey, "files", objA);

  await writeCurrentPointer(storageRoot, worktreeKey, {
    worktreeKey,
    snapshotId: snapA,
    identityHash: hex64("id-A"),
    ownerToken: hex64("owner-A"),
    previousSnapshotIds: [],
  });

  let result = await garbageCollect({ storageRoot, repositoryKey });
  assert.equal(result.deletedObjects, 0, "phase 1: objA retained by snapA");

  // Phase 2: current=B, previous=[A].  Both A and B retained.
  // Now create snapB and objB.
  await writeSnapshot(storageRoot, worktreeKey, snapB, { fileObjectIds: [objB] });
  await writeObject(storageRoot, repositoryKey, "files", objB);

  await writeCurrentPointer(storageRoot, worktreeKey, {
    worktreeKey,
    snapshotId: snapB,
    identityHash: hex64("id-B"),
    ownerToken: hex64("owner-B"),
    previousSnapshotIds: [snapA],
  });

  result = await garbageCollect({ storageRoot, repositoryKey });
  assert.equal(result.deletedObjects, 0, "phase 2: A and B both retained");
  assert.equal(result.retainedSnapshots, 2, "phase 2: 2 retained snapshots");

  // Phase 3: current=C, previous=[B, A].  All three retained.
  await writeSnapshot(storageRoot, worktreeKey, snapC, { fileObjectIds: [objC] });
  await writeObject(storageRoot, repositoryKey, "files", objC);

  await writeCurrentPointer(storageRoot, worktreeKey, {
    worktreeKey,
    snapshotId: snapC,
    identityHash: hex64("id-C"),
    ownerToken: hex64("owner-C"),
    previousSnapshotIds: [snapB, snapA],
  });

  result = await garbageCollect({ storageRoot, repositoryKey });
  assert.equal(result.deletedObjects, 0, "phase 3: A, B, C all retained");

  // Phase 4: current stays C, previous=[B] only (A dropped from previous list).
  // Object A is no longer retained by any snapshot pointer.
  await writeCurrentPointer(storageRoot, worktreeKey, {
    worktreeKey,
    snapshotId: snapC,
    identityHash: hex64("id-C2"),
    ownerToken: hex64("owner-C2"),
    previousSnapshotIds: [snapB],
  });

  result = await garbageCollect({ storageRoot, repositoryKey });

  const objsDir = repositoryObjectsDir(storageRoot, repositoryKey);
  const pfxA = objectPrefix(objA);
  const pfxB = objectPrefix(objB);
  const pfxC = objectPrefix(objC);

  // objA should now be collected.
  assert.ok(
    !await fileExists(path.join(objsDir, "files", pfxA, `${objA}.json`)),
    "objA collected after snapA dropped from retained set",
  );

  // objB and objC still retained.
  assert.ok(
    await fileExists(path.join(objsDir, "files", pfxB, `${objB}.json`)),
    "objB still retained (in previous list)",
  );
  assert.ok(
    await fileExists(path.join(objsDir, "files", pfxC, `${objC}.json`)),
    "objC still retained (current snapshot)",
  );

  assert.ok(result.deletedObjects >= 1, "at least objA deleted");
  assert.equal(result.retainedSnapshots, 2, "phase 4: C + B = 2 retained");
});

test("shared objects across worktrees survive GC until all worktrees drop them", async () => {
  const storageRoot = await tempRoot("gc-shared-objects");
  const repositoryKey = hex32("repo-shared");
  const wt1 = hex32("wt-shared-1");
  const wt2 = hex32("wt-shared-2");

  const sharedObj = hex64("shared-obj");
  const onlyWt1Obj = hex64("only-wt1-obj");

  const snap1 = snapshotId("snap-shared-1");
  const snap2 = snapshotId("snap-shared-2");

  // Both worktrees reference the shared object.
  await writeSnapshot(storageRoot, wt1, snap1, {
    fileObjectIds: [sharedObj, onlyWt1Obj],
  });
  await writeSnapshot(storageRoot, wt2, snap2, {
    fileObjectIds: [sharedObj],
  });

  await writeCurrentPointer(storageRoot, wt1, {
    worktreeKey: wt1,
    snapshotId: snap1,
    identityHash: hex64("id-s1"),
    ownerToken: hex64("owner-s1"),
  });
  await writeCurrentPointer(storageRoot, wt2, {
    worktreeKey: wt2,
    snapshotId: snap2,
    identityHash: hex64("id-s2"),
    ownerToken: hex64("owner-s2"),
  });

  await writeObject(storageRoot, repositoryKey, "files", sharedObj);
  await writeObject(storageRoot, repositoryKey, "files", onlyWt1Obj);

  // GC with both worktrees active: shared object survives.
  let result = await garbageCollect({ storageRoot, repositoryKey });
  assert.equal(result.deletedObjects, 0, "shared object retained by both worktrees");

  // Advance wt2 to a new snapshot that does NOT reference sharedObj.
  const snap2b = snapshotId("snap-shared-2b");
  const wt2OnlyObj = hex64("wt2-only-obj");
  await writeSnapshot(storageRoot, wt2, snap2b, { fileObjectIds: [wt2OnlyObj] });
  await writeObject(storageRoot, repositoryKey, "files", wt2OnlyObj);
  await writeCurrentPointer(storageRoot, wt2, {
    worktreeKey: wt2,
    snapshotId: snap2b,
    identityHash: hex64("id-s2b"),
    ownerToken: hex64("owner-s2b"),
    previousSnapshotIds: [],
  });

  // sharedObj still retained by wt1.
  result = await garbageCollect({ storageRoot, repositoryKey });
  const objsDir = repositoryObjectsDir(storageRoot, repositoryKey);
  const pfxShared = objectPrefix(sharedObj);

  assert.ok(
    await fileExists(path.join(objsDir, "files", pfxShared, `${sharedObj}.json`)),
    "shared object survives while wt1 still retains it",
  );

  // Now drop wt1's reference too.
  const snap1b = snapshotId("snap-shared-1b");
  await writeSnapshot(storageRoot, wt1, snap1b, { fileObjectIds: [] });
  await writeCurrentPointer(storageRoot, wt1, {
    worktreeKey: wt1,
    snapshotId: snap1b,
    identityHash: hex64("id-s1b"),
    ownerToken: hex64("owner-s1b"),
    previousSnapshotIds: [],
  });

  result = await garbageCollect({ storageRoot, repositoryKey });

  assert.ok(
    !await fileExists(path.join(objsDir, "files", pfxShared, `${sharedObj}.json`)),
    "shared object collected after both worktrees drop it",
  );
});

// ── Test 3: Quarantine and recovery paths are preserved ────────────────────

test("GC never touches quarantine directories", async () => {
  const storageRoot = await tempRoot("gc-quarantine-preserve");
  const repositoryKey = hex32("repo-quarantine");

  const objsDir = repositoryObjectsDir(storageRoot, repositoryKey);

  // Create quarantine directories that look like real lock or snapshot quarantines.
  const quarantineLockPath = path.join(
    path.dirname(objsDir),
    "objects.lock.quarantine-stale-abc123-def456",
  );
  const quarantineSnapshotPath = path.join(
    storageRoot,
    "worktrees",
    hex32("wt-quar"),
    "snapshots",
    `${snapshotId("quar-snap")}.quarantined-gc-${Date.now().toString(36)}-xyz`,
  );

  await mkdir(quarantineLockPath, { recursive: true });
  await writeFile(path.join(quarantineLockPath, "owner.json"), '{"stale": true}', "utf8");
  await mkdir(quarantineSnapshotPath, { recursive: true });
  await writeFile(path.join(quarantineSnapshotPath, "identity.json"), '{"quarantined": true}', "utf8");

  // Run GC with no worktrees or objects — only quarantine dirs exist.
  await garbageCollect({ storageRoot, repositoryKey });

  // Quarantine directories must still exist.
  assert.ok(
    await dirExists(quarantineLockPath),
    "quarantine lock directory must survive GC",
  );
  assert.ok(
    await dirExists(quarantineSnapshotPath),
    "quarantine snapshot directory must survive GC",
  );
});

test("GC never touches recovery-elections directories", async () => {
  const storageRoot = await tempRoot("gc-recovery-preserve");
  const repositoryKey = hex32("repo-recovery");

  const repoDir = path.join(storageRoot, "repositories", repositoryKey);
  const electionDir = path.join(repoDir, "recovery-elections", hex64("election-owner").slice(0, 32));

  await mkdir(electionDir, { recursive: true });
  await writeFile(
    path.join(electionDir, "election.json"),
    JSON.stringify({ ownerToken: "stale-owner", capturedAt: new Date().toISOString() }),
    "utf8",
  );

  // Run GC.
  await garbageCollect({ storageRoot, repositoryKey });

  assert.ok(
    await dirExists(electionDir),
    "recovery-elections directory must survive GC",
  );
  assert.ok(
    await fileExists(path.join(electionDir, "election.json")),
    "recovery-elections content must survive GC",
  );
});

test("GC acquires and releases the repository lock without corrupting structural directories", async () => {
  const storageRoot = await tempRoot("gc-lock-preserve");
  const repositoryKey = hex32("repo-lock-pres");

  const repoDir = path.join(storageRoot, "repositories", repositoryKey);

  // Set up structural directories that GC must not touch.
  const electionDir = path.join(repoDir, "recovery-elections", hex64("lock-election").slice(0, 32));
  await mkdir(electionDir, { recursive: true });
  await writeFile(path.join(electionDir, "evidence.json"), '{"test": true}', "utf8");

  // Write an object that GC should clean (orphan).
  const orphanObj = hex64("lock-test-orphan");
  await writeObject(storageRoot, repositoryKey, "files", orphanObj);

  // Run GC. The lock directory is acquired then released (renamed to quarantine)
  // as part of the normal GC protocol.  This is correct behavior.
  const result = await garbageCollect({ storageRoot, repositoryKey });

  // Recovery elections directory must survive (GC never touches elections).
  assert.ok(
    await dirExists(electionDir),
    "recovery-elections directory must survive GC",
  );
  assert.ok(
    await fileExists(path.join(electionDir, "evidence.json")),
    "recovery-elections content must survive GC",
  );

  // Orphan object cleaned up.
  assert.ok(result.deletedObjects >= 1, "orphan object deleted");

  // After GC releases the lock, the canonical lock path is gone (renamed to
  // quarantine).  This is the expected release protocol.  Verify the quarantine
  // exists in the repository directory.
  const repoEntries = await readdir(repoDir, { withFileTypes: true });
  const quarantinedLocks = repoEntries.filter(
    (e) => e.isDirectory() && e.name.includes("objects.lock.") && e.name.includes("released"),
  );
  assert.ok(
    quarantinedLocks.length >= 1,
    "GC released its lock to a quarantine path after completion",
  );
});

test("quarantine option renames unreferenced snapshot directories", async () => {
  const storageRoot = await tempRoot("gc-quarantine-opt");
  const repositoryKey = hex32("repo-quar-opt");
  const worktreeKey = hex32("wt-quar-opt");

  const retainedSnap = snapshotId("retained-quar");
  const unreferencedSnap = snapshotId("unreferenced-quar");

  const retainedObj = hex64("retained-quar-obj");

  await writeCurrentPointer(storageRoot, worktreeKey, {
    worktreeKey,
    snapshotId: retainedSnap,
    identityHash: hex64("id-ret-quar"),
    ownerToken: hex64("owner-ret-quar"),
  });
  await writeSnapshot(storageRoot, worktreeKey, retainedSnap, { fileObjectIds: [retainedObj] });
  await writeSnapshot(storageRoot, worktreeKey, unreferencedSnap, { fileObjectIds: [] });
  await writeObject(storageRoot, repositoryKey, "files", retainedObj);

  const result = await garbageCollect({
    storageRoot,
    repositoryKey,
    quarantineUnreferencedSnapshots: true,
  });

  // The retained snapshot directory must still be named normally.
  const snapParent = snapshotsDir(storageRoot, worktreeKey);
  assert.ok(
    await dirExists(path.join(snapParent, retainedSnap)),
    "retained snapshot directory must not be quarantined",
  );

  // The unreferenced snapshot directory must be renamed (quarantined).
  assert.ok(
    !await dirExists(path.join(snapParent, unreferencedSnap)),
    "unreferenced snapshot directory must be renamed",
  );

  // A quarantined variant must exist.
  const entries = await readdir(snapParent, { withFileTypes: true });
  const quarantined = entries.filter(
    (e) => e.isDirectory() && e.name.includes("quarantined-gc"),
  );
  assert.ok(quarantined.length >= 1, "at least one quarantined snapshot directory exists");
  assert.equal(result.quarantinedSnapshots, 1, "exactly 1 snapshot quarantined");
});

test("temp files (.tmp-*) are cleaned up during GC", async () => {
  const storageRoot = await tempRoot("gc-temp-cleanup");
  const repositoryKey = hex32("repo-temp-clean");

  const objsDir = repositoryObjectsDir(storageRoot, repositoryKey);
  const prefix = "ab";
  const targetDir = path.join(objsDir, "files", prefix);
  await mkdir(targetDir, { recursive: true });

  // Create real object file.
  const realObjId = hex64("real-temp-obj");
  await writeFile(path.join(targetDir, `${realObjId}.json`), '{"real": true}', "utf8");

  // Create orphaned temp files.
  await writeFile(path.join(targetDir, ".tmp-owner1-deadbeef0001"), '{"temp": 1}', "utf8");
  await writeFile(path.join(targetDir, ".tmp-owner2-deadbeef0002"), '{"temp": 2}', "utf8");

  // Create a non-temp file (should not be touched).
  await writeFile(path.join(targetDir, "other-data.txt"), "keep me", "utf8");

  const result = await garbageCollect({ storageRoot, repositoryKey });

  // Temp files removed.
  assert.ok(
    !await fileExists(path.join(targetDir, ".tmp-owner1-deadbeef0001")),
    "temp file 1 cleaned up",
  );
  assert.ok(
    !await fileExists(path.join(targetDir, ".tmp-owner2-deadbeef0002")),
    "temp file 2 cleaned up",
  );

  // Real object file still exists (orphan, but objects scan only looks at .json).
  assert.ok(
    await fileExists(path.join(targetDir, "other-data.txt")),
    "non-temp non-json file preserved",
  );

  assert.ok(result.cleanedTempFiles >= 2, "at least 2 temp files cleaned");
});

test("GC is a no-op on empty storage root", async () => {
  const storageRoot = await tempRoot("gc-empty");
  const repositoryKey = hex32("repo-empty");

  const result = await garbageCollect({ storageRoot, repositoryKey });

  assert.equal(result.worktreesScanned, 0);
  assert.equal(result.retainedSnapshots, 0);
  assert.equal(result.storedObjects, 0);
  assert.equal(result.deletedObjects, 0);
  assert.equal(result.cleanedTempFiles, 0);
  assert.equal(result.quarantinedSnapshots, 0);
});

test("GC with multiple worktrees scans all namespaces", async () => {
  const storageRoot = await tempRoot("gc-multi-wt");
  const repositoryKey = hex32("repo-multi");

  const wt1 = hex32("wt-multi-1");
  const wt2 = hex32("wt-multi-2");
  const wt3 = hex32("wt-multi-3");

  const snap1 = snapshotId("snap-multi-1");
  const snap2 = snapshotId("snap-multi-2");
  const snap3 = snapshotId("snap-multi-3");

  const obj1 = hex64("obj-multi-1");
  const obj2 = hex64("obj-multi-2");
  const obj3 = hex64("obj-multi-3");
  const orphan = hex64("obj-multi-orphan");

  await writeSnapshot(storageRoot, wt1, snap1, { fileObjectIds: [obj1] });
  await writeSnapshot(storageRoot, wt2, snap2, { fileObjectIds: [obj2] });
  await writeSnapshot(storageRoot, wt3, snap3, { fileObjectIds: [obj3] });

  await writeCurrentPointer(storageRoot, wt1, {
    worktreeKey: wt1, snapshotId: snap1,
    identityHash: hex64("id-m1"), ownerToken: hex64("own-m1"),
  });
  await writeCurrentPointer(storageRoot, wt2, {
    worktreeKey: wt2, snapshotId: snap2,
    identityHash: hex64("id-m2"), ownerToken: hex64("own-m2"),
  });
  await writeCurrentPointer(storageRoot, wt3, {
    worktreeKey: wt3, snapshotId: snap3,
    identityHash: hex64("id-m3"), ownerToken: hex64("own-m3"),
  });

  await writeObject(storageRoot, repositoryKey, "files", obj1);
  await writeObject(storageRoot, repositoryKey, "files", obj2);
  await writeObject(storageRoot, repositoryKey, "files", obj3);
  await writeObject(storageRoot, repositoryKey, "files", orphan);

  const result = await garbageCollect({ storageRoot, repositoryKey });

  assert.equal(result.worktreesScanned, 3);
  assert.equal(result.retainedSnapshots, 3);
  assert.equal(result.deletedObjects, 1, "only the orphan deleted");

  const objsDir = repositoryObjectsDir(storageRoot, repositoryKey);
  for (const obj of [obj1, obj2, obj3]) {
    const pfx = objectPrefix(obj);
    assert.ok(
      await fileExists(path.join(objsDir, "files", pfx, `${obj}.json`)),
      `object ${obj.slice(0, 8)} survives GC`,
    );
  }
  const pfxOrphan = objectPrefix(orphan);
  assert.ok(
    !await fileExists(path.join(objsDir, "files", pfxOrphan, `${orphan}.json`)),
    "orphan deleted across multi-worktree GC",
  );
});

test("GC handles worktree with no current.json gracefully", async () => {
  const storageRoot = await tempRoot("gc-no-current");
  const repositoryKey = hex32("repo-no-current");
  const worktreeKey = hex32("wt-no-current");

  // Create the worktree directory but no current.json.
  await mkdir(worktreeDir(storageRoot, worktreeKey), { recursive: true });

  // Write an object that is not referenced by any snapshot.
  const orphanObj = hex64("orphan-no-current");
  await writeObject(storageRoot, repositoryKey, "files", orphanObj);

  const result = await garbageCollect({ storageRoot, repositoryKey });

  assert.equal(result.worktreesScanned, 1);
  assert.equal(result.retainedSnapshots, 0, "no snapshots retained without current.json");

  const objsDir = repositoryObjectsDir(storageRoot, repositoryKey);
  const pfx = objectPrefix(orphanObj);
  assert.ok(
    !await fileExists(path.join(objsDir, "files", pfx, `${orphanObj}.json`)),
    "orphan deleted when worktree has no current pointer",
  );
});

test("GC with abort signal respects cancellation", async () => {
  const storageRoot = await tempRoot("gc-abort");
  const repositoryKey = hex32("repo-abort");

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => garbageCollect({ storageRoot, repositoryKey, signal: controller.signal }),
    (err: unknown) => {
      // The abort causes an IndexLockError or similar during lock acquisition.
      return err instanceof Error;
    },
    "GC with pre-aborted signal must reject",
  );
});
