import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, realpath, rename, symlink, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { captureCurrentProcessIdentity } from "../core/runtime/process-tree.js";
import {
  readBoundedRegularFileNoFollow,
  withDirectoryProcessFence,
  withDurableDirectoryLock,
} from "../core/runtime/durable-directory-lock.js";
import { tempRoot } from "./helpers.js";

async function writeOwner(lockDir: string, owner: Record<string, unknown>) {
  await writeFile(path.join(lockDir, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
}

function privateVarAlias(filePath: string) {
  if (filePath.startsWith("/private/var/")) return `/var/${filePath.slice("/private/var/".length)}`;
  if (filePath.startsWith("/var/")) return `/private/var/${filePath.slice("/var/".length)}`;
  return null;
}

function ownerRecord(lockDir: string, ownerToken: string, identity = captureCurrentProcessIdentity()) {
  assert.ok(identity);
  const canonicalLockDir = path.join(realpathSync(path.dirname(lockDir)), path.basename(lockDir));
  return {
    format: "cpb-directory-lock/v1",
    ownerToken,
    lockPath: canonicalLockDir,
    pid: identity.pid,
    host: os.hostname(),
    acquiredAt: new Date(0).toISOString(),
    processIdentity: identity,
  };
}

async function installStalePredecessor(lockDir: string, ownerToken: string) {
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-${ownerToken}-predecessor`;
  const owner = ownerRecord(lockDir, ownerToken, {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  });
  await mkdir(lockDir);
  await writeOwner(lockDir, owner);
  const epoch = new Date(0);
  await utimes(lockDir, epoch, epoch);
  return { current, owner };
}

test("bounded no-follow reader rejects growth after opening the pinned descriptor", async () => {
  const root = await tempRoot("cpb-bounded-lock-metadata-growth");
  const file = path.join(root, "owner.json");
  await writeFile(file, "12345678", "utf8");

  await assert.rejects(
    readBoundedRegularFileNoFollow(file, {
      maxBytes: 16,
      hooks: {
        afterOpen: async () => appendFile(file, "abcdefghijklmnopqrstuvwxyz", "utf8"),
      },
    }),
    { code: "BOUNDED_FILE_TOO_LARGE" },
  );
});

test("bounded no-follow reader rejects a path replacement after the descriptor read", async () => {
  const root = await tempRoot("cpb-bounded-lock-metadata-replacement");
  const file = path.join(root, "owner.json");
  const displaced = path.join(root, "owner.displaced.json");
  await writeFile(file, "original", "utf8");

  await assert.rejects(
    readBoundedRegularFileNoFollow(file, {
      maxBytes: 64,
      hooks: {
        beforePathGenerationCheck: async () => {
          await rename(file, displaced);
          await writeFile(file, "successor", "utf8");
        },
      },
    }),
    { code: "BOUNDED_FILE_CHANGED" },
  );
  assert.equal(await readFile(file, "utf8"), "successor");
  assert.equal(await readFile(displaced, "utf8"), "original");
});

test("bounded no-follow reader rejects a path replacement after opening the pinned descriptor", async () => {
  const root = await tempRoot("cpb-bounded-lock-metadata-open-replacement");
  const file = path.join(root, "owner.json");
  const displaced = path.join(root, "owner.displaced.json");
  await writeFile(file, "same-size", "utf8");

  await assert.rejects(
    readBoundedRegularFileNoFollow(file, {
      maxBytes: 64,
      hooks: {
        async afterOpen() {
          await rename(file, displaced);
          await writeFile(file, "same-size", "utf8");
        },
      },
    }),
    { code: "BOUNDED_FILE_CHANGED" },
  );
  assert.equal(await readFile(file, "utf8"), "same-size");
  assert.equal(await readFile(displaced, "utf8"), "same-size");
});

test("durable directory lock serializes concurrent callbacks", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-serial");
  const lockDir = path.join(root, "state.lock");
  let active = 0;
  let maxActive = 0;
  let completed = 0;

  await Promise.all(Array.from({ length: 8 }, () => withDurableDirectoryLock(lockDir, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    completed += 1;
    active -= 1;
  })));

  assert.equal(completed, 8);
  assert.equal(maxActive, 1);
});

test("durable directory lock preserves committed owner evidence when owner directory sync is ambiguous", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-owner-sync-ambiguity");
  const lockDir = path.join(root, "state.lock");
  const ownerFile = path.join(lockDir, "owner.json");
  const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
  const canonicalOwnerFile = path.join(canonicalLockDir, "owner.json");
  let entered = false;

  await assert.rejects(
    withDurableDirectoryLock(lockDir, async () => {
      entered = true;
    }, {
      hooks: {
        beforeOwnerDirectorySync(context) {
          if (context.phase === "owner-publish") throw new Error("simulated owner directory sync failure");
        },
      },
    }),
    (error: unknown) => {
      const ambiguity = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: { lockDir: string; ownerFile: string };
      };
      assert.equal(ambiguity.code, "DIRECTORY_LOCK_OWNER_COMMITTED_AMBIGUOUS");
      assert.equal(ambiguity.committed, true);
      assert.equal(ambiguity.committedPath, canonicalOwnerFile);
      assert.deepEqual(ambiguity.recoveryPaths, {
        lockDir: canonicalLockDir,
        ownerFile: canonicalOwnerFile,
      });
      assert.match(String(ambiguity.cause), /simulated owner directory sync failure/);
      return true;
    },
  );

  assert.equal(entered, false);
  const owner = JSON.parse(await readFile(ownerFile, "utf8")) as { lockPath?: string; ownerToken?: string };
  assert.equal(owner.lockPath, canonicalLockDir);
  assert.equal(typeof owner.ownerToken, "string");
  assert.ok(owner.ownerToken);
});

test("durable directory lock fails closed when strict directory flags are unavailable", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-directory-flags");
  const lockDir = path.join(root, "state.lock");
  const ownerFile = path.join(lockDir, "owner.json");
  const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
  const canonicalOwnerFile = path.join(canonicalLockDir, "owner.json");

  await assert.rejects(
    withDurableDirectoryLock(lockDir, async () => undefined, {
      hooks: {
        resolveDirectoryOpenFlags: () => undefined,
      },
    }),
    (error: unknown) => {
      const failure = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        cause?: Error & { code?: string };
      };
      assert.equal(failure.code, "DIRECTORY_LOCK_OWNER_COMMITTED_AMBIGUOUS");
      assert.equal(failure.committed, true);
      assert.equal(failure.committedPath, canonicalOwnerFile);
      assert.equal(failure.cause?.code, "DIRECTORY_LOCK_DIRECTORY_UNSAFE");
      return true;
    },
  );
  assert.equal(JSON.parse(await readFile(ownerFile, "utf8")).format, "cpb-directory-lock/v1");
});

test("durable directory lock rejects hook-provided directory flags missing either strict bit", async () => {
  const cases = [
    ["no-follow", constants.O_RDONLY | constants.O_DIRECTORY],
    ["directory", constants.O_RDONLY | constants.O_NOFOLLOW],
  ] as const;

  for (const [missingBit, flags] of cases) {
    const root = await tempRoot(`cpb-durable-directory-lock-missing-${missingBit}`);
    const lockDir = path.join(root, "state.lock");
    const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
    const canonicalOwnerFile = path.join(canonicalLockDir, "owner.json");

    await assert.rejects(
      withDurableDirectoryLock(lockDir, async () => undefined, {
        hooks: {
          resolveDirectoryOpenFlags: () => flags,
        },
      }),
      (error: unknown) => {
        const failure = error as Error & {
          code?: string;
          committed?: boolean;
          committedPath?: string;
          cause?: Error & { code?: string };
        };
        assert.equal(failure.code, "DIRECTORY_LOCK_OWNER_COMMITTED_AMBIGUOUS");
        assert.equal(failure.committed, true);
        assert.equal(failure.committedPath, canonicalOwnerFile);
        assert.equal(failure.cause?.code, "DIRECTORY_LOCK_DIRECTORY_UNSAFE");
        return true;
      },
    );
  }
});

test("durable directory lock preserves an owner temp generation after pre-publication failure", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-owner-temp");
  const lockDir = path.join(root, "state.lock");
  let tempPath = "";
  let failure: unknown;

  await withDurableDirectoryLock(lockDir, async () => undefined, {
    hooks: {
      beforeOwnerPublish(context) {
        tempPath = context.tempPath;
        throw Object.assign(new Error("stop before owner publication"), { code: "EIO" });
      },
    },
  }).catch((error: unknown) => { failure = error; });

  const recovery = failure as Error & {
    code?: string;
    committed?: boolean;
    cleanupCommitted?: boolean;
    cleanupCommittedPath?: string;
    recoveryPaths?: {
      lockDir: string;
      ownerFile: string;
      tempPath: string;
      quarantineDir?: string;
    };
  };
  assert.equal(recovery.code, "DIRECTORY_LOCK_OWNER_RECOVERY_REQUIRED");
  assert.equal(recovery.committed, false);
  assert.equal(recovery.cleanupCommitted, true);
  assert.ok(recovery.cleanupCommittedPath);
  assert.equal(recovery.recoveryPaths?.quarantineDir, recovery.cleanupCommittedPath);
  assert.equal(path.basename(recovery.recoveryPaths!.tempPath), path.basename(tempPath));
  assert.equal(
    JSON.parse(await readFile(path.join(recovery.cleanupCommittedPath!, path.basename(tempPath)), "utf8")).ownerToken.length > 0,
    true,
  );
  assert.deepEqual((await readdir(root)).filter((entry) => entry === "state.lock"), []);
  assert.equal(
    Number(constants.O_NOFOLLOW) > 0 && Number(constants.O_DIRECTORY) > 0,
    true,
    "the supported test platform must expose the strict directory flags used by the production path",
  );
});

test("durable directory lock preserves committed evidence when lock parent sync is ambiguous", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-parent-sync-ambiguity");
  const lockDir = path.join(root, "state.lock");
  const ownerFile = path.join(lockDir, "owner.json");
  const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
  const canonicalOwnerFile = path.join(canonicalLockDir, "owner.json");

  await assert.rejects(
    withDurableDirectoryLock(lockDir, async () => undefined, {
      hooks: {
        beforeOwnerDirectorySync(context) {
          if (context.phase === "lock-directory-publish") throw new Error("simulated lock parent sync failure");
        },
      },
    }),
    (error: unknown) => {
      const ambiguity = error as Error & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: { lockDir: string; ownerFile: string };
      };
      assert.equal(ambiguity.code, "DIRECTORY_LOCK_ACQUIRE_COMMITTED_AMBIGUOUS");
      assert.equal(ambiguity.committed, true);
      assert.equal(ambiguity.committedPath, canonicalOwnerFile);
      assert.deepEqual(ambiguity.recoveryPaths, {
        lockDir: canonicalLockDir,
        ownerFile: canonicalOwnerFile,
      });
      assert.match(String(ambiguity.cause), /simulated lock parent sync failure/);
      return true;
    },
  );

  const owner = JSON.parse(await readFile(ownerFile, "utf8")) as { lockPath?: string; ownerToken?: string };
  assert.equal(owner.lockPath, canonicalLockDir);
  assert.equal(typeof owner.ownerToken, "string");
  assert.ok(owner.ownerToken);
});

test("durable directory lock recovers a predecessor after PID reuse", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-pid-reuse");
  const lockDir = path.join(root, "state.lock");
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-predecessor`;
  await mkdir(lockDir);
  await writeOwner(lockDir, ownerRecord(lockDir, "predecessor", {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  }));
  const old = new Date(0);
  await utimes(lockDir, old, old);

  let entered = false;
  await withDurableDirectoryLock(lockDir, async () => {
    entered = true;
  }, { ttlMs: 0 });

  assert.equal(entered, true);
});

test("durable directory lock accepts owner lockPath aliases for the same canonical parent", async (t) => {
  const root = await tempRoot("cpb-durable-directory-lock-path-alias");
  const lockDir = path.join(root, "state.lock");
  const alias = privateVarAlias(path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir)));
  if (!alias) {
    t.skip("no /var and /private/var alias is available for this temp path");
    return;
  }
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-predecessor`;
  await mkdir(lockDir);
  await writeOwner(lockDir, {
    ...ownerRecord(lockDir, "alias-predecessor", {
      ...current,
      birthId: predecessorBirthId,
      incarnation: `${current.pid}:${predecessorBirthId}`,
    }),
    lockPath: alias,
  });
  const old = new Date(0);
  await utimes(lockDir, old, old);

  let entered = false;
  await withDurableDirectoryLock(lockDir, async () => {
    entered = true;
  }, { ttlMs: 0 });

  assert.equal(entered, true);
});

test("durable directory lock recovery fences a third contender", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-three-party");
  const lockDir = path.join(root, "state.lock");
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const predecessorBirthId = `${current.birthId}-predecessor`;
  await mkdir(lockDir);
  await writeOwner(lockDir, ownerRecord(lockDir, "dead-predecessor", {
    ...current,
    birthId: predecessorBirthId,
    incarnation: `${current.pid}:${predecessorBirthId}`,
  }));
  const old = new Date(0);
  await utimes(lockDir, old, old);

  let observedResolve!: () => void;
  const observed = new Promise<void>((resolve) => { observedResolve = resolve; });
  let resumeResolve!: () => void;
  const resume = new Promise<void>((resolve) => { resumeResolve = resolve; });
  let active = 0;
  let maxActive = 0;
  const callback = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
  };

  const first = withDurableDirectoryLock(lockDir, callback, {
    ttlMs: 0,
    hooks: {
      async afterRecoveryObserved() {
        observedResolve();
        await resume;
      },
    },
  });
  await observed;
  let secondEntered = false;
  const second = withDurableDirectoryLock(lockDir, async () => {
    secondEntered = true;
    await callback();
  }, { ttlMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondEntered, false);
  resumeResolve();
  await Promise.all([first, second]);
  assert.equal(maxActive, 1);
});

test("durable directory lock preserves a successor moved by an ABA race before quarantine rename", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-quarantine-aba");
  const lockDir = path.join(root, "state.lock");
  const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
  const predecessorEvidence = path.join(root, "observed-predecessor.lock");
  const { current, owner: predecessor } = await installStalePredecessor(lockDir, "observed-predecessor");
  const successor = ownerRecord(lockDir, "real-successor", current);
  let failure: unknown;

  await withDurableDirectoryLock(lockDir, async () => {
    assert.fail("ABA recovery must not enter the callback");
  }, {
    ttlMs: 0,
    hooks: {
      async beforeQuarantineRename() {
        await rename(lockDir, predecessorEvidence);
        await mkdir(lockDir);
        await writeOwner(lockDir, successor);
      },
    },
  }).catch((error: unknown) => { failure = error; });

  const conflict = failure as Error & {
    code?: string;
    committed?: boolean;
    renameCommitted?: boolean;
    removalCommitted?: boolean;
    phase?: string;
    lockDir?: string;
    quarantineDir?: string;
    recoveryPaths?: { canonical: string; quarantine: string };
    committedPath?: string;
    quarantinePreserved?: boolean;
    successorPreserved?: boolean;
  };
  assert.equal(conflict.code, "DIRECTORY_LOCK_GENERATION_CONFLICT");
  assert.equal(conflict.committed, true);
  assert.equal(conflict.renameCommitted, true);
  assert.equal(conflict.removalCommitted, false);
  assert.equal(conflict.phase, "post-quarantine-rename");
  assert.equal(conflict.lockDir, canonicalLockDir);
  assert.equal(conflict.recoveryPaths?.canonical, canonicalLockDir);
  assert.equal(conflict.recoveryPaths?.quarantine, conflict.quarantineDir);
  assert.equal(conflict.committedPath, conflict.quarantineDir);
  assert.equal(conflict.quarantinePreserved, true);
  assert.equal(conflict.successorPreserved, true);
  assert.equal(JSON.parse(await readFile(path.join(predecessorEvidence, "owner.json"), "utf8")).ownerToken, predecessor.ownerToken);
  assert.equal(JSON.parse(await readFile(path.join(conflict.quarantineDir!, "owner.json"), "utf8")).ownerToken, successor.ownerToken);
  await assert.rejects(readFile(path.join(lockDir, "owner.json"), "utf8"), { code: "ENOENT" });
});

test("durable directory lock treats observed owner metadata mutation as a generation change", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-owner-generation");
  const lockDir = path.join(root, "state.lock");
  const { owner } = await installStalePredecessor(lockDir, "observed-owner");
  const changedOwner = {
    ...owner,
    acquiredAt: new Date(1).toISOString(),
  };
  let failure: unknown;

  await withDurableDirectoryLock(lockDir, async () => {
    assert.fail("mutated owner generation must not enter the callback");
  }, {
    ttlMs: 0,
    hooks: {
      async beforeQuarantineRename() {
        await writeOwner(lockDir, changedOwner);
      },
    },
  }).catch((error: unknown) => { failure = error; });

  const conflict = failure as Error & {
    code?: string;
    phase?: string;
    quarantineDir?: string;
    quarantinePreserved?: boolean;
  };
  assert.equal(conflict.code, "DIRECTORY_LOCK_GENERATION_CONFLICT");
  assert.equal(conflict.phase, "post-quarantine-rename");
  assert.equal(conflict.quarantinePreserved, true);
  const preservedOwner = JSON.parse(await readFile(path.join(conflict.quarantineDir!, "owner.json"), "utf8"));
  assert.equal(preservedOwner.ownerToken, owner.ownerToken);
  assert.equal(preservedOwner.acquiredAt, changedOwner.acquiredAt);
  await assert.rejects(readFile(path.join(lockDir, "owner.json"), "utf8"), { code: "ENOENT" });
});

test("durable directory lock reports committed ambiguity when quarantine rename fsync is unsupported", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-rename-fsync");
  for (const syncCode of ["EINVAL", "EISDIR"] as const) {
    const lockDir = path.join(root, `${syncCode.toLowerCase()}.lock`);
    const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
    const { owner } = await installStalePredecessor(lockDir, `${syncCode.toLowerCase()}-predecessor`);
    let failure: unknown;

    await withDurableDirectoryLock(lockDir, async () => {
      assert.fail("ambiguous quarantine rename must not enter the callback");
    }, {
      ttlMs: 0,
      hooks: {
        beforeDirectorySync({ phase }) {
          if (phase === "quarantine-rename") {
            throw Object.assign(new Error("synthetic directory fsync unsupported after rename"), { code: syncCode });
          }
        },
      },
    }).catch((error: unknown) => { failure = error; });

    const ambiguity = failure as Error & {
      code?: string;
      committed?: boolean;
      renameCommitted?: boolean;
      removalCommitted?: boolean;
      phase?: string;
      lockDir?: string;
      quarantineDir?: string;
      recoveryPaths?: { canonical: string; quarantine: string };
      committedPath?: string;
      quarantinePreserved?: boolean;
    };
    assert.equal(ambiguity.code, "DIRECTORY_LOCK_QUARANTINE_RENAME_COMMITTED_AMBIGUOUS");
    assert.equal(ambiguity.committed, true);
    assert.equal(ambiguity.renameCommitted, true);
    assert.equal(ambiguity.removalCommitted, false);
    assert.equal(ambiguity.phase, "quarantine-rename-durability");
    assert.equal(ambiguity.recoveryPaths?.canonical, canonicalLockDir);
    assert.equal(ambiguity.recoveryPaths?.quarantine, ambiguity.quarantineDir);
    assert.equal(ambiguity.committedPath, ambiguity.quarantineDir);
    assert.equal(ambiguity.quarantinePreserved, true);
    assert.equal(JSON.parse(await readFile(path.join(ambiguity.quarantineDir!, "owner.json"), "utf8")).ownerToken, owner.ownerToken);
    await assert.rejects(readFile(path.join(lockDir, "owner.json"), "utf8"), { code: "ENOENT" });
  }
});

test("durable directory lock retains verified stale quarantine without attempting pathname removal", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-retained-quarantine");
  const lockDir = path.join(root, "state.lock");
  await installStalePredecessor(lockDir, "remove-fsync-predecessor");
  let removalSyncAttempted = false;
  let quarantineDir = "";
  let entered = false;

  await withDurableDirectoryLock(lockDir, async () => {
    entered = true;
  }, {
    ttlMs: 0,
    hooks: {
      afterQuarantineRename(context) {
        if (context.kind === "stale") quarantineDir = context.quarantineDir;
      },
      beforeDirectorySync({ phase }) {
        if (phase === "quarantine-remove") {
          removalSyncAttempted = true;
        }
      },
    },
  });

  assert.equal(entered, true);
  assert.equal(removalSyncAttempted, false);
  assert.ok(quarantineDir);
  assert.equal(JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8")).ownerToken, "remove-fsync-predecessor");
  await assert.rejects(readFile(path.join(lockDir, "owner.json"), "utf8"), { code: "ENOENT" });
});

test("durable directory lock fails closed on an unsafe symlink", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-symlink");
  const external = await tempRoot("cpb-durable-directory-lock-target");
  const sentinel = path.join(external, "sentinel.txt");
  await writeFile(sentinel, "preserve\n");
  const lockDir = path.join(root, "state.lock");
  await symlink(external, lockDir);

  await assert.rejects(
    withDurableDirectoryLock(lockDir, async () => undefined, { ttlMs: 0 }),
    { code: "DIRECTORY_LOCK_UNSAFE" },
  );
  assert.equal(await readFile(sentinel, "utf8"), "preserve\n");
});

test("durable directory lock fails closed when liveness probing is indeterminate", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-eperm");
  const lockDir = path.join(root, "state.lock");
  await mkdir(lockDir);
  await writeOwner(lockDir, ownerRecord(lockDir, "indeterminate"));
  const old = new Date(0);
  await utimes(lockDir, old, old);

  await assert.rejects(
    withDurableDirectoryLock(lockDir, async () => undefined, {
      ttlMs: 0,
      identityAlive() {
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      },
    }),
    { code: "DIRECTORY_LOCK_UNSAFE" },
  );
  assert.equal(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")).ownerToken, "indeterminate");
});

test("durable directory lock refuses to launder a captured identity with missing precision", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-capture-missing-precision");
  const lockDir = path.join(root, "state.lock");
  const identity = captureCurrentProcessIdentity();
  assert.ok(identity);
  const { birthIdPrecision: _precision, ...missingPrecision } = identity;

  await assert.rejects(
    withDurableDirectoryLock(lockDir, async () => undefined, {
      captureIdentity: () => missingPrecision,
    }),
    { code: "DIRECTORY_LOCK_IDENTITY_UNAVAILABLE" },
  );
  await assert.rejects(readFile(path.join(lockDir, "owner.json")), { code: "ENOENT" });
});

test("durable directory lock preserves stale owners without explicit exact identity", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-owner-missing-precision");
  const lockDir = path.join(root, "state.lock");
  const identity = captureCurrentProcessIdentity();
  assert.ok(identity);
  const owner = ownerRecord(lockDir, "missing-precision", identity);
  delete (owner.processIdentity as { birthIdPrecision?: string }).birthIdPrecision;
  await mkdir(lockDir);
  await writeOwner(lockDir, owner);
  const old = new Date(0);
  await utimes(lockDir, old, old);

  await assert.rejects(
    withDurableDirectoryLock(lockDir, async () => undefined, { ttlMs: 0 }),
    { code: "DIRECTORY_LOCK_UNSAFE" },
  );
  assert.equal(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")).ownerToken, "missing-precision");
});

test("durable directory lock release preserves a successor owner", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-successor");
  const lockDir = path.join(root, "state.lock");
  await assert.rejects(
    withDurableDirectoryLock(lockDir, async () => undefined, {
      hooks: {
        async beforeRelease() {
          const ownerFile = path.join(lockDir, "owner.json");
          const current = JSON.parse(await readFile(ownerFile, "utf8"));
          await writeFile(ownerFile, `${JSON.stringify({ ...current, ownerToken: "successor" }, null, 2)}\n`);
        },
      },
    }),
    { code: "DIRECTORY_LOCK_RELEASE_FAILED" },
  );
  assert.equal(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")).ownerToken, "successor");
});

test("durable directory lock release preserves both released quarantine and a prompt successor", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-release-successor");
  const lockDir = path.join(root, "state.lock");
  const current = captureCurrentProcessIdentity();
  assert.ok(current);
  const successor = ownerRecord(lockDir, "prompt-successor", current);
  let entered = false;
  let releaseQuarantineDir = "";
  let releaseOwnerToken = "";

  await withDurableDirectoryLock(lockDir, async () => {
    entered = true;
  }, {
    hooks: {
      async afterQuarantineRename({ kind, quarantineDir, ownerToken }) {
        if (kind !== "released") return;
        releaseQuarantineDir = quarantineDir;
        releaseOwnerToken = ownerToken || "";
        await mkdir(lockDir);
        await writeOwner(lockDir, successor);
      },
    },
  });

  assert.equal(entered, true);
  assert.ok(releaseQuarantineDir);
  assert.ok(releaseOwnerToken);
  assert.equal(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")).ownerToken, successor.ownerToken);
  assert.equal(JSON.parse(await readFile(path.join(releaseQuarantineDir, "owner.json"), "utf8")).ownerToken, releaseOwnerToken);
});

test("durable directory lock preserves a quarantined predecessor when recovery validation fails", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-quarantine-preserved");
  const lockDir = path.join(root, "state.lock");
  const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
  const { owner } = await installStalePredecessor(lockDir, "predecessor");
  const validationError = new Error("quarantine validation failed");
  let failure: unknown;

  await withDurableDirectoryLock(lockDir, async () => undefined, {
    ttlMs: 0,
    hooks: {
      afterQuarantineRename() {
        throw validationError;
      },
    },
  }).catch((error: unknown) => { failure = error; });

  const preserved = failure as Error & {
    code?: string;
    committed?: boolean;
    renameCommitted?: boolean;
    removalCommitted?: boolean;
    phase?: string;
    quarantineDir?: string;
    recoveryPaths?: { canonical: string; quarantine: string };
    quarantinePreserved?: boolean;
    successorPreserved?: boolean;
  };
  assert.equal(preserved.code, "DIRECTORY_LOCK_QUARANTINE_PRESERVED");
  assert.equal(preserved.cause, validationError);
  assert.equal(preserved.committed, true);
  assert.equal(preserved.renameCommitted, true);
  assert.equal(preserved.removalCommitted, false);
  assert.equal(preserved.phase, "quarantine-preserved");
  assert.equal(preserved.recoveryPaths?.canonical, canonicalLockDir);
  assert.equal(preserved.recoveryPaths?.quarantine, preserved.quarantineDir);
  assert.equal(preserved.quarantinePreserved, true);
  assert.equal(preserved.successorPreserved, false);
  assert.equal(JSON.parse(await readFile(path.join(preserved.quarantineDir!, "owner.json"), "utf8")).ownerToken, owner.ownerToken);
  await assert.rejects(readFile(path.join(lockDir, "owner.json"), "utf8"), { code: "ENOENT" });
});

test("durable directory lock preserves a successor created during quarantine without a hook failure", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-successor-during-quarantine");
  const lockDir = path.join(root, "state.lock");
  const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
  const { current, owner } = await installStalePredecessor(lockDir, "predecessor");
  const successor = ownerRecord(lockDir, "successor", current);
  let failure: unknown;

  await withDurableDirectoryLock(lockDir, async () => {
    assert.fail("successor appearance must fail closed before removing quarantine");
  }, {
    ttlMs: 0,
    waitMs: 500,
    hooks: {
      async afterQuarantineRename() {
        await mkdir(lockDir);
        await writeOwner(lockDir, successor);
      },
    },
  }).catch((error: unknown) => { failure = error; });

  const preserved = failure as Error & {
    code?: string;
    committed?: boolean;
    removalCommitted?: boolean;
    phase?: string;
    quarantineDir?: string;
    recoveryPaths?: { canonical: string; quarantine: string };
    quarantinePreserved?: boolean;
    successorPreserved?: boolean;
  };
  assert.equal(preserved.code, "DIRECTORY_LOCK_SUCCESSOR_PRESERVED");
  assert.equal(preserved.committed, true);
  assert.equal(preserved.removalCommitted, false);
  assert.equal(preserved.phase, "quarantine-preserved");
  assert.equal(preserved.recoveryPaths?.canonical, canonicalLockDir);
  assert.equal(preserved.recoveryPaths?.quarantine, preserved.quarantineDir);
  assert.equal(preserved.quarantinePreserved, true);
  assert.equal(preserved.successorPreserved, true);
  assert.equal(JSON.parse(await readFile(path.join(preserved.quarantineDir!, "owner.json"), "utf8")).ownerToken, owner.ownerToken);
  assert.equal(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")).ownerToken, successor.ownerToken);
});

test("durable directory lock skips an unrelated listener on its first fence port", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-fence-collision");
  const lockDir = path.join(root, "state.lock");
  const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
  const fenceKey = createHash("sha256")
    .update(`${canonicalLockDir}\0durable-directory-lock-fence-v2`)
    .digest("hex");
  const digest = createHash("sha256").update(`${fenceKey}\u0000${0}`).digest();
  const firstPort = 20_000 + (digest.readUInt16BE(0) % 40_000);
  const unrelated = net.createServer((socket) => socket.end("unrelated-listener\n"));
  await new Promise<void>((resolve, reject) => {
    unrelated.once("error", reject);
    unrelated.listen({ host: "127.0.0.1", port: firstPort, exclusive: true }, resolve);
  });

  try {
    let entered = false;
    await withDurableDirectoryLock(lockDir, async () => {
      entered = true;
    });
    assert.equal(entered, true);
  } finally {
    await new Promise<void>((resolve, reject) => unrelated.close((error) => error ? reject(error) : resolve()));
  }
});

test("durable directory lock fails closed on an indeterminate listener on a fence port", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-fence-indeterminate");
  const lockDir = path.join(root, "state.lock");
  const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
  const fenceKey = createHash("sha256")
    .update(`${canonicalLockDir}\0durable-directory-lock-fence-v2`)
    .digest("hex");
  const digest = createHash("sha256").update(`${fenceKey}\u0000${0}`).digest();
  const firstPort = 20_000 + (digest.readUInt16BE(0) % 40_000);
  const sockets = new Set<net.Socket>();
  const indeterminate = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    indeterminate.once("error", reject);
    indeterminate.listen({ host: "127.0.0.1", port: firstPort, exclusive: true }, resolve);
  });

  try {
    await assert.rejects(
      withDurableDirectoryLock(lockDir, async () => undefined, { waitMs: 80 }),
      { code: "DIRECTORY_LOCK_BUSY" },
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => indeterminate.close((error) => error ? reject(error) : resolve()));
  }
});

test("durable directory lock fails closed when a fence listener resets without protocol proof", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-fence-reset");
  const lockDir = path.join(root, "state.lock");
  const canonicalLockDir = path.join(await realpath(path.dirname(lockDir)), path.basename(lockDir));
  const fenceKey = createHash("sha256")
    .update(`${canonicalLockDir}\0durable-directory-lock-fence-v2`)
    .digest("hex");
  const digest = createHash("sha256").update(`${fenceKey}\u0000${0}`).digest();
  const firstPort = 20_000 + (digest.readUInt16BE(0) % 40_000);
  const resetting = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    resetting.once("error", reject);
    resetting.listen({ host: "127.0.0.1", port: firstPort, exclusive: true }, resolve);
  });

  try {
    await assert.rejects(
      withDurableDirectoryLock(lockDir, async () => undefined, { waitMs: 80 }),
      { code: "DIRECTORY_LOCK_BUSY" },
    );
  } finally {
    await new Promise<void>((resolve, reject) => resetting.close((error) => error ? reject(error) : resolve()));
  }
});

test("standalone process fence canonicalizes symlink aliases to the same key", async () => {
  const root = await tempRoot("cpb-directory-process-fence-alias");
  const canonicalParent = path.join(root, "canonical");
  const aliasParent = path.join(root, "alias");
  await mkdir(canonicalParent);
  await symlink(canonicalParent, aliasParent, "dir");
  const canonicalLock = path.join(canonicalParent, "state.lock");
  const aliasLock = path.join(aliasParent, "state.lock");
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstEntered!: () => void;
  const firstEntry = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  let secondEntered = false;

  const first = withDirectoryProcessFence(canonicalLock, async () => {
    firstEntered();
    await firstGate;
  });
  await firstEntry;
  const second = withDirectoryProcessFence(aliasLock, async () => {
    secondEntered = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondEntered, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondEntered, true);
});

test("durable directory lock aggregates callback and release failures", async () => {
  const root = await tempRoot("cpb-durable-directory-lock-errors");
  const lockDir = path.join(root, "state.lock");
  const callbackError = new Error("callback failed");
  const releaseError = new Error("release failed");

  await assert.rejects(
    withDurableDirectoryLock(lockDir, async () => {
      throw callbackError;
    }, {
      hooks: {
        beforeRelease() {
          throw releaseError;
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, callbackError);
      assert.deepEqual(error.errors, [callbackError, releaseError]);
      return true;
    },
  );
});
