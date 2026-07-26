import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { mkdir, readFile, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";

import {
  AssignmentStore,
  withAssignmentStoreTestHooksForTests,
  type AssignmentStoreTestHooks,
} from "../shared/orchestrator/assignment-store.js";
import { captureProcessIdentity, type ProcessIdentity } from "../core/runtime/process-tree.js";
import { tempRoot } from "./helpers.js";

const assignmentStoreTestHookScope = new AsyncLocalStorage<AssignmentStoreTestHooks>();
const __assignmentStoreTestHooks = new Proxy({} as AssignmentStoreTestHooks, {
  get(_target, property) {
    return Reflect.get(assignmentStoreTestHookScope.getStore() || {}, property);
  },
  set(_target, property, value) {
    const hooks = assignmentStoreTestHookScope.getStore();
    if (!hooks) throw new Error("assignment store test hook mutation requires a scoped test");
    return Reflect.set(hooks, property, value);
  },
  deleteProperty(_target, property) {
    const hooks = assignmentStoreTestHookScope.getStore();
    if (!hooks) return true;
    return Reflect.deleteProperty(hooks, property);
  },
});

function test(name: string, fn: (context: TestContext) => void | Promise<void>) {
  return nodeTest(name, (context) => {
    const hooks: AssignmentStoreTestHooks = {};
    return assignmentStoreTestHookScope.run(
      hooks,
      () => withAssignmentStoreTestHooksForTests(hooks, () => fn(context)),
    );
  });
}

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

async function bindLocalPort(port: number) {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port, exclusive: true });
  });
  return server;
}

async function closeServer(server: net.Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function oldSingleAssignmentFencePort(lockDir: string) {
  const digest = crypto.createHash("sha256")
    .update(`${path.resolve(lockDir)}\0assignment-lock-fence-v1`)
    .digest();
  return 40_000 + (digest.readUInt16BE(0) % 9_000);
}

function exactCurrentIdentity(): ProcessIdentity {
  const identity = captureProcessIdentity(process.pid, { strict: true });
  assert.ok(identity);
  return { ...identity, birthIdPrecision: "exact" };
}

test("AssignmentStore test hooks remain isolated across concurrent lock acquisitions", async () => {
  const [firstRoot, secondRoot] = await Promise.all([
    tempRoot("cpb-assignment-hook-scope-first"),
    tempRoot("cpb-assignment-hook-scope-second"),
  ]);
  const first = new AssignmentStore(firstRoot);
  const second = new AssignmentStore(secondRoot);
  const baseIdentity = exactCurrentIdentity();
  let arrivals = 0;
  let release!: () => void;
  const rendezvous = new Promise<void>((resolve) => { release = resolve; });
  const meet = async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await rendezvous;
  };
  const acquire = (store: AssignmentStore, label: string) => {
    const birthId = `${baseIdentity.birthId}-${label}`;
    return withAssignmentStoreTestHooksForTests({
      captureAssignmentProcessIdentity: () => ({
        ...baseIdentity,
        birthId,
        incarnation: `${process.pid}:${birthId}`,
      }),
    }, async () => {
      await meet();
      let observedBirthId = "";
      const assignmentId = `a-${label}`;
      await store._withAssignmentLock(assignmentId, async () => {
        const owner = JSON.parse(await readFile(
          path.join(store.baseDir, assignmentId, "state.lock", "owner.json"),
          "utf8",
        ));
        observedBirthId = owner.processIdentity.birthId;
      });
      return observedBirthId;
    });
  };

  const [firstBirthId, secondBirthId] = await Promise.all([
    acquire(first, "first"),
    acquire(second, "second"),
  ]);
  assert.equal(firstBirthId, `${baseIdentity.birthId}-first`);
  assert.equal(secondBirthId, `${baseIdentity.birthId}-second`);
});

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

test("AssignmentStore preserves a legacy lock without exact identity after ESRCH", async () => {
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

  assert.equal(await store._assignmentLockRecoveryKind(paths.lockDir, paths.ownerFile), null);
  assert.equal((await readOwner(paths.ownerFile)).ownerToken, "dead-token");
});

test("AssignmentStore recovers a stale lock after PID reuse is proven by process identity", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-pid-reuse");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-pid-reuse";
  const paths = lockPaths(store, assignmentId);
  const currentIdentity = exactCurrentIdentity();
  const reusedBirthId = `${currentIdentity.birthId}-predecessor`;
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    ownerToken: "predecessor-token",
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    processIdentity: {
      ...currentIdentity,
      birthId: reusedBirthId,
      incarnation: `${process.pid}:${reusedBirthId}`,
    },
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  let entered = false;
  await store._withAssignmentLock(assignmentId, async () => {
    entered = true;
  });

  assert.equal(entered, true);
  assert.equal((await readOwner(paths.ownerFile)).processIdentity.incarnation, currentIdentity.incarnation);
  assert.equal((await readOwner(paths.ownerFile)).processIdentity.birthIdPrecision, "exact");
});

test("AssignmentStore writes only strict exact lock identities", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-strict-write");
  const store = new AssignmentStore(hubRoot);
  const paths = lockPaths(store, "a-strict-write");

  const exact = exactCurrentIdentity();
  const missingPrecision = { ...exact };
  delete missingPrecision.birthIdPrecision;
  for (const captured of [null, missingPrecision, { ...exact, birthIdPrecision: "coarse" as const }]) {
    __assignmentStoreTestHooks.captureAssignmentProcessIdentity = () => captured;
    try {
      await assert.rejects(
        store._withAssignmentLock("a-strict-write", async () => {}),
        /assignment lock process identity unavailable/,
      );
    } finally {
      delete __assignmentStoreTestHooks.captureAssignmentProcessIdentity;
    }
  }

  await store._withAssignmentLock("a-strict-write", async () => {});
  const owner = await readOwner(paths.ownerFile);
  assert.equal(owner.schemaVersion, 2);
  assert.equal(owner.processIdentity.pid, process.pid);
  assert.equal(owner.processIdentity.birthIdPrecision, "exact");
  assert.equal(owner.processIdentity.incarnation, `${process.pid}:${owner.processIdentity.birthId}`);
  assert.ok(Number.isFinite(Date.parse(owner.processIdentity.capturedAt)));
});

test("AssignmentStore does not recover current-format locks with missing identity", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-missing-identity");
  const store = new AssignmentStore(hubRoot);
  const paths = lockPaths(store, "a-missing-identity");
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    schemaVersion: 2,
    ownerToken: "missing-identity-token",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  await assert.rejects(
    store._withAssignmentLock("a-missing-identity", async () => {}),
    /process identity is missing/,
  );
  assert.equal((await readOwner(paths.ownerFile)).ownerToken, "missing-identity-token");
});

test("AssignmentStore does not recover current-format locks with coarse identity", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-coarse-identity");
  const store = new AssignmentStore(hubRoot);
  const paths = lockPaths(store, "a-coarse-identity");
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    schemaVersion: 2,
    ownerToken: "coarse-identity-token",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "ps-lstart:old",
      birthIdPrecision: "coarse",
      incarnation: "999999:ps-lstart:old",
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  await assert.rejects(
    store._withAssignmentLock("a-coarse-identity", async () => {}),
    /process identity is malformed/,
  );
  assert.equal((await readOwner(paths.ownerFile)).ownerToken, "coarse-identity-token");
});

test("AssignmentStore does not recover current-format locks with malformed identity", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-malformed-identity");
  const store = new AssignmentStore(hubRoot);
  const paths = lockPaths(store, "a-malformed-identity");
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    schemaVersion: 2,
    ownerToken: "malformed-identity-token",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "linux-proc-starttime:old",
      birthIdPrecision: "exact",
      incarnation: "999999:wrong",
      capturedAt: "not-a-date",
    },
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  await assert.rejects(
    store._withAssignmentLock("a-malformed-identity", async () => {}),
    /process identity is malformed/,
  );
  assert.equal((await readOwner(paths.ownerFile)).ownerToken, "malformed-identity-token");
});

test("AssignmentStore preserves current-format locks with noncanonical timestamps", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-noncanonical-time");
  const store = new AssignmentStore(hubRoot);
  const paths = lockPaths(store, "a-noncanonical-time");
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    schemaVersion: 2,
    ownerToken: "noncanonical-time-token",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: "2026-01-01T00:00:00Z",
    processIdentity: {
      pid: 999_999,
      birthId: "linux-proc-starttime:old",
      birthIdPrecision: "exact",
      incarnation: "999999:linux-proc-starttime:old",
      capturedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  const old = new Date(0);
  await utimes(paths.lockDir, old, old);

  await assert.rejects(
    store._withAssignmentLock("a-noncanonical-time", async () => {}),
    /owner is malformed/,
  );
  assert.equal((await readOwner(paths.ownerFile)).ownerToken, "noncanonical-time-token");
});

test("AssignmentStore rejects a symbolic-link assignment lock directory without touching its target", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-dir-symlink");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-lock-dir-symlink";
  const paths = lockPaths(store, assignmentId);
  const target = path.join(hubRoot, "outside-lock-target");
  await mkdir(paths.assignmentDir, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeOwner(path.join(target, "owner.json"), {
    schemaVersion: 2,
    ownerToken: "outside-owner",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "outside-owner",
      birthIdPrecision: "exact",
      incarnation: "999999:outside-owner",
      capturedAt: new Date(0).toISOString(),
    },
  });
  await symlink(target, paths.lockDir, "dir");

  await assert.rejects(
    () => store._withAssignmentLock(assignmentId, async () => {}),
    /assignment lock path is not a real directory|cannot be inspected safely/,
  );
  assert.equal((await readOwner(path.join(target, "owner.json"))).ownerToken, "outside-owner");
});

test("AssignmentStore rejects same-inode assignment lock metadata changes before quarantine", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-metadata-aba");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-metadata-aba";
  const paths = lockPaths(store, assignmentId);
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    schemaVersion: 2,
    ownerToken: "dead-predecessor",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "dead-predecessor-metadata",
      birthIdPrecision: "exact",
      incarnation: "999999:dead-predecessor-metadata",
      capturedAt: new Date(0).toISOString(),
    },
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  __assignmentStoreTestHooks.afterAssignmentLockRecoveryObserved = async ({ lockDir }) => {
    const newer = new Date(Date.now() - 45_000);
    await utimes(lockDir, newer, newer);
  };
  try {
    await assert.rejects(
      () => store._withAssignmentLock(assignmentId, async () => {}),
      (error: unknown) => {
        const actual = error as { code?: unknown; successorPreserved?: unknown; recoveryPaths?: { lockDir?: unknown } };
        assert.equal(actual.code, "HUB_ASSIGNMENT_LOCK_CONFLICT");
        assert.equal(actual.successorPreserved, true);
        assert.equal(actual.recoveryPaths?.lockDir, paths.lockDir);
        return true;
      },
    );
  } finally {
    delete __assignmentStoreTestHooks.afterAssignmentLockRecoveryObserved;
  }

  assert.equal((await readOwner(paths.ownerFile)).ownerToken, "dead-predecessor");
});

test("AssignmentStore preserves replacement lock when quarantine observes an ABA successor", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-aba-preserve");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-aba-preserve";
  const paths = lockPaths(store, assignmentId);
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    schemaVersion: 2,
    ownerToken: "dead-predecessor",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "dead-predecessor-aba",
      birthIdPrecision: "exact",
      incarnation: "999999:dead-predecessor-aba",
      capturedAt: new Date(0).toISOString(),
    },
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  __assignmentStoreTestHooks.afterAssignmentLockQuarantineRename = async ({ lockDir }) => {
    await mkdir(lockDir);
    await writeOwner(path.join(lockDir, "owner.json"), {
      schemaVersion: 2,
      ownerToken: "successor-token",
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
      processIdentity: exactCurrentIdentity(),
    });
  };
  try {
    await assert.rejects(
      store._withAssignmentLock(assignmentId, async () => {}),
      /successor preserved while quarantine remains/,
    );
    assert.equal((await readOwner(paths.ownerFile)).ownerToken, "successor-token");
  } finally {
    delete __assignmentStoreTestHooks.afterAssignmentLockQuarantineRename;
  }
});

test("AssignmentStore preserves recovered quarantine instead of recursively deleting it", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-quarantine-preserved");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-quarantine-preserved";
  const paths = lockPaths(store, assignmentId);
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    schemaVersion: 2,
    ownerToken: "dead-predecessor",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "dead-predecessor-cleanup",
      birthIdPrecision: "exact",
      incarnation: "999999:dead-predecessor-cleanup",
      capturedAt: new Date(0).toISOString(),
    },
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  let quarantineDir = "";
  __assignmentStoreTestHooks.afterAssignmentLockQuarantineRename = async (context) => {
    quarantineDir = context.quarantineDir;
  };
  try {
    let entered = false;
    await store._withAssignmentLock(assignmentId, async () => {
      entered = true;
    });
    assert.equal(entered, true);
  } finally {
    delete __assignmentStoreTestHooks.afterAssignmentLockQuarantineRename;
  }
  assert.ok(quarantineDir);
  assert.equal((await readOwner(path.join(quarantineDir, "owner.json"))).ownerToken, "dead-predecessor");
  assert.ok((await readOwner(paths.ownerFile)).releasedAt);
});

test("AssignmentStore preserves a same-token successor created during quarantine", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-same-token-successor");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-same-token-successor";
  const paths = lockPaths(store, assignmentId);
  const predecessor = {
    schemaVersion: 2,
    ownerToken: "same-token-owner",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "dead-predecessor-same-token",
      birthIdPrecision: "exact" as const,
      incarnation: "999999:dead-predecessor-same-token",
      capturedAt: new Date(0).toISOString(),
    },
  };
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, predecessor);
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);
  let quarantineDir = "";

  __assignmentStoreTestHooks.afterAssignmentLockQuarantineRename = async (context) => {
    quarantineDir = context.quarantineDir;
    await mkdir(context.lockDir);
    await writeOwner(path.join(context.lockDir, "owner.json"), {
      ...predecessor,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      processIdentity: exactCurrentIdentity(),
    });
  };
  try {
    await assert.rejects(
      store._withAssignmentLock(assignmentId, async () => {}),
      (error: unknown) => {
        const actual = error as { code?: unknown; committed?: unknown; recoveryPaths?: { quarantineDir?: unknown; lockDir?: unknown } };
        assert.equal(actual.code, "HUB_ASSIGNMENT_LOCK_CONFLICT");
        assert.equal(actual.committed, false);
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        assert.equal(actual.recoveryPaths?.lockDir, paths.lockDir);
        return true;
      },
    );
  } finally {
    delete __assignmentStoreTestHooks.afterAssignmentLockQuarantineRename;
  }

  const successor = await readOwner(paths.ownerFile);
  assert.equal(successor.ownerToken, "same-token-owner");
  assert.equal(successor.pid, process.pid);
  assert.equal((await readOwner(path.join(quarantineDir, "owner.json"))).pid, predecessor.pid);
});

test("AssignmentStore preserves quarantine when ownership changes during recovery", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-restore-fsync");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-restore-fsync";
  const paths = lockPaths(store, assignmentId);
  const predecessor = {
    schemaVersion: 2,
    ownerToken: "dead-predecessor",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "dead-predecessor-restore-fsync",
      birthIdPrecision: "exact" as const,
      incarnation: "999999:dead-predecessor-restore-fsync",
      capturedAt: new Date(0).toISOString(),
    },
  };
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, predecessor);
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  let quarantineDir = "";
  __assignmentStoreTestHooks.afterAssignmentLockQuarantineRename = async (context) => {
    quarantineDir = context.quarantineDir;
    await writeOwner(path.join(context.quarantineDir, "owner.json"), {
      ...predecessor,
      ownerToken: "changed-during-quarantine",
    });
  };
  try {
    await assert.rejects(
      store._withAssignmentLock(assignmentId, async () => {}),
      (error: unknown) => {
        const actual = error as { code?: unknown; committed?: unknown; recoveryPaths?: { lockDir?: unknown; quarantineDir?: unknown } };
        assert.equal(actual.code, "HUB_ASSIGNMENT_LOCK_CONFLICT");
        assert.equal(actual.committed, false);
        assert.equal(actual.recoveryPaths?.lockDir, paths.lockDir);
        assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
        return true;
      },
    );
  } finally {
    delete __assignmentStoreTestHooks.afterAssignmentLockQuarantineRename;
  }

  assert.ok(quarantineDir);
  await assert.rejects(readFile(paths.ownerFile, "utf8"), { code: "ENOENT" });
  assert.equal((await readOwner(path.join(quarantineDir, "owner.json"))).ownerToken, "changed-during-quarantine");
  assert.deepEqual(
    (await readdir(paths.assignmentDir)).filter((entry) => entry.startsWith("state.lock.")),
    [path.basename(quarantineDir)],
  );
});

test("AssignmentStore serializes stale recovery and a third contender behind the kernel fence", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-three-party");
  const first = new AssignmentStore(hubRoot);
  const second = new AssignmentStore(hubRoot);
  const assignmentId = "a-three-party";
  const paths = lockPaths(first, assignmentId);
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, {
    schemaVersion: 2,
    ownerToken: "dead-predecessor",
    pid: 999_999,
    host: os.hostname(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    processIdentity: {
      pid: 999_999,
      birthId: "dead-predecessor-three-party",
      birthIdPrecision: "exact",
      incarnation: "999999:dead-predecessor-three-party",
      capturedAt: new Date(0).toISOString(),
    },
  });
  const old = new Date(Date.now() - 60_000);
  await utimes(paths.lockDir, old, old);

  let observedResolve!: () => void;
  const observed = new Promise<void>((resolve) => { observedResolve = resolve; });
  let resumeRecovery!: () => void;
  const recoveryMayContinue = new Promise<void>((resolve) => { resumeRecovery = resolve; });
  let paused = false;
  let activeCallbacks = 0;
  let maxActiveCallbacks = 0;
  const enter = async () => {
    activeCallbacks += 1;
    maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeCallbacks -= 1;
  };

  __assignmentStoreTestHooks.afterAssignmentLockRecoveryObserved = async () => {
    if (paused) return;
    paused = true;
    observedResolve();
    await recoveryMayContinue;
  };
  try {
    const firstOperation = first._withAssignmentLock(assignmentId, enter);
    await observed;
    let secondEntered = false;
    const secondOperation = second._withAssignmentLock(assignmentId, async () => {
      secondEntered = true;
      await enter();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondEntered, false, "third contender must remain behind the recovery fence");
    resumeRecovery();
    await Promise.all([firstOperation, secondOperation]);
    assert.equal(maxActiveCallbacks, 1, "assignment callbacks must never overlap");
    assert.ok((await readOwner(paths.ownerFile)).releasedAt);
  } finally {
    delete __assignmentStoreTestHooks.afterAssignmentLockRecoveryObserved;
    resumeRecovery?.();
  }
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

  await assert.rejects(
    store._releaseAssignmentLock(paths.ownerFile, oldOwner.ownerToken),
    /assignment lock owner changed during release/,
  );
  assert.deepEqual(await readOwner(paths.ownerFile), replacement);
});

test("AssignmentStore guarded owner release reports post-rename fsync ambiguity", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-release-fsync");
  const store = new AssignmentStore(hubRoot);
  const paths = lockPaths(store, "a-release-fsync");
  const owner = {
    schemaVersion: 2,
    ownerToken: "owner-token",
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    processIdentity: exactCurrentIdentity(),
  };
  await mkdir(paths.lockDir, { recursive: true });
  await writeOwner(paths.ownerFile, owner);

  __assignmentStoreTestHooks.syncAssignmentDirectory = async (directory) => {
    if (directory === paths.lockDir) {
      throw Object.assign(new Error("simulated lock dir fsync failure"), { code: "EIO" });
    }
  };
  try {
    await assert.rejects(
      store._releaseAssignmentLock(paths.ownerFile, owner.ownerToken),
      (error: unknown) => {
        const actual = error as { code?: unknown; committed?: unknown; recoveryPaths?: { ownerFile?: unknown } };
        assert.equal(actual.code, "HUB_ASSIGNMENT_LOCK_CONFLICT");
        assert.equal(actual.committed, true);
        assert.equal(actual.recoveryPaths?.ownerFile, paths.ownerFile);
        return true;
      },
    );
  } finally {
    delete __assignmentStoreTestHooks.syncAssignmentDirectory;
  }

  assert.equal((await readOwner(paths.ownerFile)).releasedAt !== undefined, true);
});

test("AssignmentStore preserves callback and release failures together", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-error-aggregation");
  const store = new AssignmentStore(hubRoot);
  const callbackError = new Error("assignment mutation failed");
  const releaseError = new Error("assignment release failed");
  store._releaseAssignmentLock = async () => {
    throw releaseError;
  };

  await assert.rejects(
    store._withAssignmentLock("a-error-aggregation", async () => {
      throw callbackError;
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, callbackError);
      assert.deepEqual(error.errors, [callbackError, releaseError]);
      return true;
    },
  );
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

test("AssignmentStore does not let an unrelated legacy single-port occupant block the process fence", async (t) => {
  const hubRoot = await tempRoot("cpb-assignment-lock-fence-unrelated-port");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-fence-unrelated";
  const paths = lockPaths(store, assignmentId);
  let server: net.Server | null = null;
  try {
    server = await bindLocalPort(oldSingleAssignmentFencePort(paths.lockDir));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
      t.skip("legacy single-port fence port already occupied by the environment");
      return;
    }
    throw error;
  }
  try {
    let entered = false;
    await store._withAssignmentLock(assignmentId, async () => {
      entered = true;
    });
    assert.equal(entered, true);
  } finally {
    await closeServer(server);
  }
});

test("AssignmentStore process fence stays exclusive and releases after callback failure", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-fence-release");
  const first = new AssignmentStore(hubRoot);
  const second = new AssignmentStore(hubRoot);
  const assignmentId = "a-fence-release";
  let firstMayFail!: () => void;
  let firstEntered!: () => void;
  const firstReady = new Promise<void>((resolve) => { firstEntered = resolve; });
  const unblockFirst = new Promise<void>((resolve) => { firstMayFail = resolve; });

  const firstOperation = first._withAssignmentLock(assignmentId, async () => {
    firstEntered();
    await unblockFirst;
    throw Object.assign(new Error("simulated callback failure"), { code: "TEST_CALLBACK_FAILED" });
  });
  await firstReady;

  let secondEntered = false;
  const secondOperation = second._withAssignmentLock(assignmentId, async () => {
    secondEntered = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(secondEntered, false, "same lock-path fence must keep the second contender out");
  firstMayFail();
  await assert.rejects(firstOperation, /simulated callback failure/);
  await secondOperation;
  assert.equal(secondEntered, true, "callback failure must still release the fence and lock");
});

test("AssignmentStore local document reads fail closed on symlink, oversized, and malformed JSON", async () => {
  const hubRoot = await tempRoot("cpb-assignment-safe-json");
  const store = new AssignmentStore(hubRoot);
  const assignmentDir = path.join(store.baseDir, "a-safe-json");
  await mkdir(assignmentDir, { recursive: true });

  const outside = path.join(hubRoot, "outside-state.json");
  await writeFile(outside, "{}\n", "utf8");
  await symlink(outside, path.join(assignmentDir, "state.json"));
  await assert.rejects(
    () => store._readState("a-safe-json"),
    { code: "HUB_ASSIGNMENT_DOCUMENT_INVALID" },
  );

  await rename(path.join(assignmentDir, "state.json"), path.join(assignmentDir, "state-symlink"));
  await writeFile(path.join(assignmentDir, "state.json"), "x".repeat(1024 * 1024 + 1), "utf8");
  await assert.rejects(
    () => store._readState("a-safe-json"),
    { code: "HUB_ASSIGNMENT_DOCUMENT_INVALID" },
  );

  await writeFile(path.join(assignmentDir, "state.json"), "{not-json", "utf8");
  await assert.rejects(
    () => store._readState("a-safe-json"),
    { code: "HUB_ASSIGNMENT_DOCUMENT_INVALID" },
  );
});

test("AssignmentStore lock owner preserves real recovery paths after committed fsync ambiguity", async () => {
  const hubRoot = await tempRoot("cpb-assignment-lock-owner-ambiguity");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-lock-owner-ambiguity";
  const paths = lockPaths(store, assignmentId);
  let failed = false;
  __assignmentStoreTestHooks.syncAssignmentDirectory = async (directory) => {
    if (!failed && directory === paths.lockDir) {
      failed = true;
      throw Object.assign(new Error("simulated lock owner directory fsync failure"), { code: "EIO" });
    }
  };
  try {
    await assert.rejects(
      () => store._withAssignmentLock(assignmentId, async () => {}),
      (error: unknown) => {
        const actual = error as {
          code?: string;
          committed?: boolean;
          committedPath?: string;
          recoveryPaths?: string[];
        };
        assert.equal(actual.code, "DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS");
        assert.equal(actual.committed, true);
        assert.equal(actual.committedPath, paths.ownerFile);
        assert.deepEqual(actual.recoveryPaths, [paths.ownerFile, paths.lockDir]);
        return true;
      },
    );
  } finally {
    delete __assignmentStoreTestHooks.syncAssignmentDirectory;
  }

  assert.equal(failed, true);
  assert.ok((await readdir(paths.lockDir)).includes(path.basename(paths.ownerFile)));
  assert.equal(typeof (await readOwner(paths.ownerFile)).ownerToken, "string");
});

test("AssignmentStore durable mutation owner reports post-rename fsync ambiguity", async () => {
  const hubRoot = await tempRoot("cpb-assignment-mutation-owner-ambiguity");
  const store = new AssignmentStore(hubRoot);
  const assignmentId = "a-mutation-ambiguity";
  const assignmentDir = path.join(store.baseDir, assignmentId);
  const mutationOwnerPath = path.join(assignmentDir, "mutation-owner.json");
  let assignmentDirSyncs = 0;
  __assignmentStoreTestHooks.syncAssignmentDirectory = async (directory) => {
    if (directory === assignmentDir) {
      assignmentDirSyncs += 1;
      if (assignmentDirSyncs === 2) {
        throw Object.assign(new Error("simulated assignment dir fsync failure"), { code: "EIO" });
      }
    }
  };
  try {
    await assert.rejects(
      () => store._withAssignmentLock(assignmentId, async () => {}),
      (error: unknown) => {
        const actual = error as {
          code?: string;
          committed?: boolean;
          committedPath?: string;
          recoveryPaths?: string[];
        };
        assert.equal(actual.code, "DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS");
        assert.equal(actual.committed, true);
        assert.equal(actual.committedPath, mutationOwnerPath);
        assert.deepEqual(actual.recoveryPaths, [mutationOwnerPath, assignmentDir]);
        return true;
      },
    );
    assert.ok((await readdir(assignmentDir)).includes(path.basename(mutationOwnerPath)));
  } finally {
    delete __assignmentStoreTestHooks.syncAssignmentDirectory;
  }
});
