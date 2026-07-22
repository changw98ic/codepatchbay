import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open as realOpen,
  readFile,
  readdir,
  rename as realRename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  JsonAtomicDurabilityError,
  JsonWriteRecoveryError,
  withFsUtilsTestHooks,
  writeJsonAtomic,
  writeJsonOnce,
} from "../shared/fs-utils.js";

async function tempRoot() {
  return mkdtemp(path.join(tmpdir(), "cpb-fs-utils-"));
}

test("writeJsonAtomic reports rename-committed durability ambiguity when parent fsync fails", async () => {
  const root = await tempRoot();
  const target = path.join(root, "state.json");
  const fsyncFailure = Object.assign(new Error("directory fsync failed"), { code: "EIO" });

  try {
    await assert.rejects(
      withFsUtilsTestHooks({
        syncParentDirectory: async () => { throw fsyncFailure; },
      }, () => writeJsonAtomic(target, { epoch: 7 })),
      (error) => {
        assert.equal(error instanceof JsonAtomicDurabilityError, true);
        assert.equal((error as JsonAtomicDurabilityError).renameCommitted, true);
        assert.equal((error as JsonAtomicDurabilityError).committed, true);
        assert.equal((error as JsonAtomicDurabilityError).committedPath, target);
        assert.deepEqual((error as JsonAtomicDurabilityError).recoveryPaths, [target]);
        assert.equal((error as Error & { cause?: unknown }).cause, fsyncFailure);
        return true;
      },
    );

    assert.equal(await readFile(target, "utf8"), "{\n  \"epoch\": 7\n}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonAtomic preserves its isolated temporary generation when rename fails", async () => {
  const root = await tempRoot();
  const target = path.join(root, "state.json");
  const renameFailure = Object.assign(new Error("rename failed"), { code: "EIO" });
  let temporaryPath = "";

  try {
    await assert.rejects(
      withFsUtilsTestHooks({
        rename: async (source) => {
          temporaryPath = String(source);
          throw renameFailure;
        },
      }, () => writeJsonAtomic(target, { worker: "a" })),
      (error) => {
        assert.equal(error instanceof JsonWriteRecoveryError, true);
        const recovery = error as JsonWriteRecoveryError;
        assert.equal(recovery.committed, false);
        assert.equal(recovery.cause, renameFailure);
        assert.deepEqual(recovery.recoveryPaths, [temporaryPath, target]);
        return true;
      },
    );
    assert.ok(temporaryPath.startsWith(path.join(root, ".state.json.tmp-")));
    assert.equal(await readFile(temporaryPath, "utf8"), "{\n  \"worker\": \"a\"\n}\n");
    await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonAtomic recognizes a rename that commits before its hook throws", async () => {
  const root = await tempRoot();
  const target = path.join(root, "state.json");
  const renameFailure = Object.assign(new Error("rename hook failed after commit"), { code: "EIO" });
  let temporaryPath = "";

  try {
    await assert.rejects(
      withFsUtilsTestHooks({
        rename: async (source, destination) => {
          temporaryPath = String(source);
          await realRename(source, destination);
          throw renameFailure;
        },
      }, () => writeJsonAtomic(target, { epoch: 8 })),
      (error) => {
        assert.equal(error instanceof JsonAtomicDurabilityError, true);
        const durability = error as JsonAtomicDurabilityError;
        assert.equal(durability.committed, true);
        assert.equal(durability.renameCommitted, true);
        assert.equal(durability.publicationKind, "rename");
        assert.equal(durability.cause, renameFailure);
        return true;
      },
    );

    assert.equal(await readFile(target, "utf8"), "{\n  \"epoch\": 8\n}\n");
    await assert.rejects(readFile(temporaryPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonAtomic allocates a distinct exclusive temporary generation per concurrent writer", async () => {
  const root = await tempRoot();
  const target = path.join(root, "state.json");
  const temporaryPaths = new Set<string>();

  try {
    const writes = Array.from({ length: 24 }, (_, index) => withFsUtilsTestHooks({
      rename: async (source) => {
        temporaryPaths.add(String(source));
        throw Object.assign(new Error(`retain temp ${index}`), { code: "EBUSY" });
      },
    }, () => writeJsonAtomic(target, { index })));

    const results = await Promise.allSettled(writes);
    assert.equal(results.every((result) => result.status === "rejected"), true);
    assert.equal(temporaryPaths.size, writes.length);
    for (const temporaryPath of temporaryPaths) {
      assert.ok(temporaryPath.startsWith(path.join(root, ".state.json.tmp-")));
      assert.match(await readFile(temporaryPath, "utf8"), /\"index\": \d+/);
    }
    await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent direct atomic writers all complete with a valid last-writer generation", async () => {
  const root = await tempRoot();
  const target = path.join(root, "state.json");

  try {
    await Promise.all(Array.from(
      { length: 32 },
      (_, index) => writeJsonAtomic(target, { index }),
    ));

    const published = JSON.parse(await readFile(target, "utf8")) as { index?: unknown };
    assert.equal(typeof published.index, "number");
    assert.ok(Number(published.index) >= 0 && Number(published.index) < 32);
    assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".tmp-")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonAtomic opens its temp file exclusively without following symlinks", async () => {
  const root = await tempRoot();
  const target = path.join(root, "state.json");
  let observedFlags = 0;

  try {
    await withFsUtilsTestHooks({
      open: async (filePath, flags, mode) => {
        observedFlags = Number(flags);
        return realOpen(filePath, flags, mode);
      },
    }, () => writeJsonAtomic(target, { ok: true }));

    assert.notEqual(observedFlags & constants.O_EXCL, 0);
    assert.equal(typeof constants.O_NOFOLLOW, "number");
    assert.notEqual(observedFlags & constants.O_NOFOLLOW, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonOnce never unlinks a same-path successor after its generation fails", async () => {
  const root = await tempRoot();
  const target = path.join(root, "result.json");
  const predecessor = path.join(root, "result.predecessor.json");
  const successor = "successor must remain\n";
  const syncFailure = Object.assign(new Error("created generation sync failed"), { code: "EIO" });
  let replaced = false;

  try {
    await assert.rejects(
      withFsUtilsTestHooks({
        open: async (filePath, flags, mode) => {
          const handle = await realOpen(filePath, flags, mode);
          if (String(filePath) !== target) return handle;
          const originalSync = handle.sync.bind(handle);
          (handle as FileHandle & { sync: () => Promise<void> }).sync = async () => {
            await originalSync();
            if (!replaced) {
              replaced = true;
              await realRename(target, predecessor);
              await writeFile(target, successor);
            }
            throw syncFailure;
          };
          return handle;
        },
      }, () => writeJsonOnce(target, { status: "predecessor" })),
      (error) => {
        assert.equal(error instanceof JsonWriteRecoveryError, true);
        const recovery = error as JsonWriteRecoveryError;
        assert.equal(recovery.committed, false);
        assert.equal(recovery.renameCommitted, false);
        assert.equal(recovery.successorPreserved, true);
        assert.deepEqual(recovery.recoveryPaths, [target]);
        assert.equal(recovery.cause, syncFailure);
        return true;
      },
    );

    assert.equal(replaced, true);
    assert.equal(await readFile(target, "utf8"), successor);
    assert.equal(await readFile(predecessor, "utf8"), "{\n  \"status\": \"predecessor\"\n}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonOnce detects a same-path successor even when the predecessor sync succeeds", async () => {
  const root = await tempRoot();
  const target = path.join(root, "result.json");
  const predecessor = path.join(root, "result.predecessor.json");
  const successor = "successor remains canonical\n";
  let parentSyncCalls = 0;

  try {
    await assert.rejects(
      withFsUtilsTestHooks({
        open: async (filePath, flags, mode) => {
          const handle = await realOpen(filePath, flags, mode);
          if (String(filePath) !== target) return handle;
          const originalSync = handle.sync.bind(handle);
          (handle as FileHandle & { sync: () => Promise<void> }).sync = async () => {
            await originalSync();
            await realRename(target, predecessor);
            await writeFile(target, successor);
          };
          return handle;
        },
        syncParentDirectory: async () => { parentSyncCalls += 1; },
      }, () => writeJsonOnce(target, { status: "predecessor" })),
      (error) => {
        assert.equal(error instanceof JsonWriteRecoveryError, true);
        const recovery = error as JsonWriteRecoveryError;
        assert.equal(recovery.committed, false);
        assert.equal(recovery.renameCommitted, false);
        assert.equal(recovery.successorPreserved, true);
        assert.deepEqual(recovery.recoveryPaths, [target]);
        assert.equal((recovery.cause as { code?: string }).code, "CPB_JSON_GENERATION_REPLACED");
        return true;
      },
    );

    assert.equal(parentSyncCalls, 0);
    assert.equal(await readFile(target, "utf8"), successor);
    assert.equal(await readFile(predecessor, "utf8"), "{\n  \"status\": \"predecessor\"\n}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonOnce preserves recovery metadata when write and close both fail", async () => {
  const root = await tempRoot();
  const target = path.join(root, "result.json");
  const writeFailure = Object.assign(new Error("write failed"), { code: "EIO" });
  const closeFailure = Object.assign(new Error("close failed"), { code: "EIO" });

  try {
    await assert.rejects(
      withFsUtilsTestHooks({
        open: async (filePath, flags, mode) => {
          const handle = await realOpen(filePath, flags, mode);
          if (String(filePath) !== target) return handle;
          const originalClose = handle.close.bind(handle);
          Object.defineProperty(handle, "writeFile", {
            configurable: true,
            value: async () => { throw writeFailure; },
          });
          Object.defineProperty(handle, "close", {
            configurable: true,
            value: async () => {
              await originalClose();
              throw closeFailure;
            },
          });
          return handle;
        },
      }, () => writeJsonOnce(target, { status: "partial" })),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        const aggregate = error as AggregateError & {
          code?: string;
          committed?: boolean | null;
          renameCommitted?: boolean | null;
          recoveryPaths?: readonly string[];
          successorPreserved?: boolean;
        };
        assert.equal(aggregate.errors.length, 2);
        assert.equal(aggregate.errors[0] instanceof JsonWriteRecoveryError, true);
        assert.equal((aggregate.errors[0] as JsonWriteRecoveryError).cause, writeFailure);
        assert.equal(aggregate.errors[1], closeFailure);
        assert.equal(aggregate.cause, aggregate.errors[0]);
        assert.equal(aggregate.code, "CPB_JSON_WRITE_RECOVERY_REQUIRED");
        assert.equal(aggregate.committed, false);
        assert.equal(aggregate.renameCommitted, false);
        assert.deepEqual(aggregate.recoveryPaths, [target]);
        assert.equal(aggregate.successorPreserved, false);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonOnce treats EEXIST after creation as recovery, not a pre-existing result", async () => {
  const root = await tempRoot();
  const target = path.join(root, "result.json");
  const lateExistsFailure = Object.assign(new Error("late EEXIST"), { code: "EEXIST" });

  try {
    await assert.rejects(
      withFsUtilsTestHooks({
        open: async (filePath, flags, mode) => {
          const handle = await realOpen(filePath, flags, mode);
          if (String(filePath) !== target) return handle;
          const originalWrite = handle.writeFile.bind(handle) as (
            data: string,
            encoding: BufferEncoding,
          ) => Promise<void>;
          Object.defineProperty(handle, "writeFile", {
            configurable: true,
            value: async (content: string, encoding: BufferEncoding) => {
              await originalWrite(content, encoding);
              throw lateExistsFailure;
            },
          });
          return handle;
        },
      }, () => writeJsonOnce(target, { status: "partial" })),
      (error) => {
        assert.equal(error instanceof JsonWriteRecoveryError, true);
        const recovery = error as JsonWriteRecoveryError;
        assert.equal(recovery.committed, false);
        assert.equal(recovery.cause, lateExistsFailure);
        assert.deepEqual(recovery.recoveryPaths, [target]);
        return true;
      },
    );

    assert.equal(await readFile(target, "utf8"), "{\n  \"status\": \"partial\"\n}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonOnce does not mislabel a successor as committed when parent fsync throws", async () => {
  const root = await tempRoot();
  const target = path.join(root, "result.json");
  const predecessor = path.join(root, "result.predecessor.json");
  const successor = "successor after parent sync race\n";
  const fsyncFailure = Object.assign(new Error("directory fsync failed"), { code: "EIO" });

  try {
    await assert.rejects(
      withFsUtilsTestHooks({
        syncParentDirectory: async () => {
          await realRename(target, predecessor);
          await writeFile(target, successor);
          throw fsyncFailure;
        },
      }, () => writeJsonOnce(target, { status: "predecessor" })),
      (error) => {
        assert.equal(error instanceof JsonWriteRecoveryError, true);
        const recovery = error as JsonWriteRecoveryError;
        assert.equal(recovery.committed, null);
        assert.equal(recovery.renameCommitted, false);
        assert.equal(recovery.successorPreserved, true);
        assert.equal(recovery.cause, fsyncFailure);
        return true;
      },
    );

    assert.equal(await readFile(target, "utf8"), successor);
    assert.equal(await readFile(predecessor, "utf8"), "{\n  \"status\": \"predecessor\"\n}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON publication rejects a symlink parent before writing through it", async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  const linkedDirectory = path.join(root, "linked");
  const nestedDirectory = path.join(outside, "already-present");
  const atomicTarget = path.join(linkedDirectory, "already-present", "atomic.json");
  const onceTarget = path.join(linkedDirectory, "already-present", "once.json");

  try {
    await mkdir(nestedDirectory);
    await symlink(outside, linkedDirectory, "dir");
    const rejectsUnsafeDirectory = (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CPB_DIRECTORY_SYNC_UNSAFE");
      return true;
    };
    await assert.rejects(writeJsonAtomic(atomicTarget, { unsafe: true }), rejectsUnsafeDirectory);
    await assert.rejects(writeJsonOnce(onceTarget, { unsafe: true }), rejectsUnsafeDirectory);
    assert.deepEqual(await readdir(outside), ["already-present"]);
    assert.deepEqual(await readdir(nestedDirectory), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("filesystem fault hooks remain isolated across concurrent writes", async () => {
  const root = await tempRoot();
  const left = path.join(root, "left.json");
  const right = path.join(root, "right.json");
  const leftFailure = Object.assign(new Error("left-only parent sync failure"), { code: "EIO" });
  let releaseLeftRename!: () => void;
  let releaseRightOpen!: () => void;
  const leftRenameReady = new Promise<void>((resolve) => { releaseLeftRename = resolve; });
  const rightOpenReady = new Promise<void>((resolve) => { releaseRightOpen = resolve; });
  let continueLeft!: () => void;
  let continueRight!: () => void;
  const leftMayContinue = new Promise<void>((resolve) => { continueLeft = resolve; });
  const rightMayContinue = new Promise<void>((resolve) => { continueRight = resolve; });

  try {
    const leftWrite = withFsUtilsTestHooks({
      rename: async (source, destination) => {
        releaseLeftRename();
        await leftMayContinue;
        await realRename(source, destination);
      },
      syncParentDirectory: async () => { throw leftFailure; },
    }, () => writeJsonAtomic(left, { side: "left" }));

    await leftRenameReady;
    const rightWrite = withFsUtilsTestHooks({
      open: async (filePath, flags, mode) => {
        releaseRightOpen();
        await rightMayContinue;
        return realOpen(filePath, flags, mode);
      },
      syncParentDirectory: async () => {},
    }, () => writeJsonAtomic(right, { side: "right" }));

    await rightOpenReady;
    continueLeft();
    await assert.rejects(leftWrite, (error) => {
      assert.equal(error instanceof JsonAtomicDurabilityError, true);
      assert.equal((error as JsonAtomicDurabilityError).cause, leftFailure);
      return true;
    });
    continueRight();
    await rightWrite;

    assert.equal(await readFile(left, "utf8"), "{\n  \"side\": \"left\"\n}\n");
    assert.equal(await readFile(right, "utf8"), "{\n  \"side\": \"right\"\n}\n");
    assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".tmp-")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonOnce fsyncs durable result creation and still returns false for existing files", async () => {
  const root = await tempRoot();
  const target = path.join(root, "result.json");
  let syncCalls = 0;

  try {
    const written = await withFsUtilsTestHooks({
      syncParentDirectory: async () => { syncCalls += 1; },
    }, () => writeJsonOnce(target, { status: "ok" }));

    assert.equal(written, true);
    assert.equal(syncCalls, 1);
    assert.equal(await readFile(target, "utf8"), "{\n  \"status\": \"ok\"\n}\n");

    await writeFile(target, "already here");
    const second = await withFsUtilsTestHooks({
      syncParentDirectory: async () => { syncCalls += 1; },
    }, () => writeJsonOnce(target, { status: "later" }));

    assert.equal(second, false);
    assert.equal(syncCalls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent direct write-once callers publish exactly one complete generation", async () => {
  const root = await tempRoot();
  const target = path.join(root, "result.json");

  try {
    const outcomes = await Promise.all(Array.from(
      { length: 32 },
      (_, index) => writeJsonOnce(target, { index }),
    ));

    assert.equal(outcomes.filter(Boolean).length, 1);
    const published = JSON.parse(await readFile(target, "utf8")) as { index?: unknown };
    assert.equal(typeof published.index, "number");
    assert.ok(Number(published.index) >= 0 && Number(published.index) < 32);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeJsonOnce reports exclusive creation, not rename, when parent fsync fails", async () => {
  const root = await tempRoot();
  const target = path.join(root, "result.json");
  const fsyncFailure = Object.assign(new Error("directory fsync failed"), { code: "EIO" });

  try {
    await assert.rejects(
      withFsUtilsTestHooks({
        syncParentDirectory: async () => { throw fsyncFailure; },
      }, () => writeJsonOnce(target, { status: "created" })),
      (error) => {
        assert.equal(error instanceof JsonAtomicDurabilityError, true);
        const durability = error as JsonAtomicDurabilityError;
        assert.equal(durability.committed, true);
        assert.equal(durability.renameCommitted, false);
        assert.equal(durability.publicationKind, "exclusive-create");
        assert.equal(durability.committedPath, target);
        assert.deepEqual(durability.recoveryPaths, [target]);
        assert.equal(durability.cause, fsyncFailure);
        return true;
      },
    );

    assert.equal(await readFile(target, "utf8"), "{\n  \"status\": \"created\"\n}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
