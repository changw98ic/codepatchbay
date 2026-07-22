import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { lstat, mkdir, readFile, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";

import {
  WorkerStore,
  withWorkerStoreTestHooksForTests,
  type WorkerStoreTestHooks,
} from "../shared/orchestrator/worker-store.js";
import type { ProcessIdentity } from "../core/runtime/process-tree.js";
import { tempRoot, writeJson } from "./helpers.js";

function testIdentity(pid: number, birthId = "test-birth"): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-07-20T00:00:00.000Z",
    birthIdPrecision: "exact",
  };
}

async function staleLock(
  store: WorkerStore,
  workerId: string,
  assignmentId: string,
  owner: Record<string, unknown>,
) {
  const lockDir = path.join(store.inboxDir, workerId, `${assignmentId}.lock`);
  await mkdir(lockDir, { recursive: true });
  await writeJson(path.join(lockDir, "owner.json"), {
    ownerToken: "owner-token",
    pid: 999_999_991,
    host: os.hostname(),
    acquiredAt: "2026-07-20T00:00:00.000Z",
    ...owner,
  });
  const old = new Date(Date.now() - 120_000);
  await utimes(lockDir, old, old);
  return lockDir;
}

function assignment(assignmentId = "a-1") {
  return {
    assignmentId,
    attempt: 1,
    attemptToken: `attempt-${assignmentId}`,
  };
}

const workerStoreTestHookScope = new AsyncLocalStorage<WorkerStoreTestHooks>();
const __workerStoreTestHooks = new Proxy({} as WorkerStoreTestHooks, {
  get(_target, property) {
    return Reflect.get(workerStoreTestHookScope.getStore() || {}, property);
  },
  set(_target, property, value) {
    const hooks = workerStoreTestHookScope.getStore();
    if (!hooks) throw new Error("worker store test hook mutation requires a scoped test");
    return Reflect.set(hooks, property, value);
  },
  deleteProperty(_target, property) {
    const hooks = workerStoreTestHookScope.getStore();
    if (!hooks) return true;
    return Reflect.deleteProperty(hooks, property);
  },
});

function test(name: string, fn: (context: TestContext) => void | Promise<void>) {
  return nodeTest(name, (context) => {
    const hooks: WorkerStoreTestHooks = {};
    return workerStoreTestHookScope.run(
      hooks,
      () => withWorkerStoreTestHooksForTests(hooks, () => fn(context)),
    );
  });
}

async function fileExists(filePath: string) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

test("WorkerStore test hooks remain isolated across concurrent recovery probes", async () => {
  const [firstRoot, secondRoot] = await Promise.all([
    tempRoot("cpb-worker-hook-scope-first"),
    tempRoot("cpb-worker-hook-scope-second"),
  ]);
  const first = new WorkerStore(firstRoot);
  const second = new WorkerStore(secondRoot);
  await Promise.all([first.init(), second.init()]);
  const firstIdentity = testIdentity(999_999_965, "first-scope");
  const secondIdentity = testIdentity(999_999_964, "second-scope");
  const firstLock = await staleLock(first, "worker-1", "a-first-scope", {
    pid: firstIdentity.pid,
    processIdentity: firstIdentity,
  });
  const secondLock = await staleLock(second, "worker-1", "a-second-scope", {
    pid: secondIdentity.pid,
    processIdentity: secondIdentity,
  });
  let arrivals = 0;
  let release!: () => void;
  const rendezvous = new Promise<void>((resolve) => { release = resolve; });
  const meet = async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await rendezvous;
  };
  const probe = (store: WorkerStore, lockDir: string, alive: boolean) =>
    withWorkerStoreTestHooksForTests({
      isLocalInboxProcessIdentityAlive: () => alive,
    }, async () => {
      await meet();
      return store._localInboxLockRecoveryCandidate(lockDir, path.join(lockDir, "owner.json"));
    });

  const [liveCandidate, staleCandidate] = await Promise.all([
    probe(first, firstLock, true),
    probe(second, secondLock, false),
  ]);
  assert.equal(liveCandidate, null);
  assert.equal(staleCandidate?.kind, "stale");
});

test("local worker inbox lock owner persists current process identity", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-owner");
  const store = new WorkerStore(hubRoot);
  await store.init();

  await store.writeInboxWithReceipt("worker-1", assignment());

  const owner = JSON.parse(await readFile(
    path.join(store.inboxDir, "worker-1", "a-1.lock", "owner.json"),
    "utf8",
  ));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.processIdentity.pid, process.pid);
  assert.equal(owner.processIdentity.incarnation, `${process.pid}:${owner.processIdentity.birthId}`);
  assert.equal(owner.processIdentity.birthIdPrecision, "exact");
  assert.equal(new Date(owner.processIdentity.capturedAt).toISOString(), owner.processIdentity.capturedAt);
});

test("local worker inbox lock fails closed when exact current identity is unavailable", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-owner-identity-unavailable");
  const store = new WorkerStore(hubRoot);
  await store.init();
  store._captureCurrentProcessIdentity = () => {
    throw Object.assign(new Error("exact identity unavailable"), { code: "PROCESS_IDENTITY_UNAVAILABLE" });
  };

  await assert.rejects(
    () => store.writeInboxWithReceipt("worker-1", assignment("a-no-exact-identity")),
    /exact identity unavailable/,
  );

  const workerInbox = path.join(store.inboxDir, "worker-1");
  const quarantines = (await readdir(workerInbox))
    .filter((entry) => entry.startsWith("a-no-exact-identity.lock.owner-write-failed-"));
  assert.equal(quarantines.length, 1);
  assert.deepEqual(await readdir(path.join(workerInbox, quarantines[0])), []);
});

test("worker identity persistence refuses to launder missing precision as exact", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-registry-exact-identity");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const pid = 1234;
  const captured = testIdentity(pid, "captured-with-implicit-exact-precision");
  delete captured.birthIdPrecision;

  await assert.rejects(
    store.registerWorker("worker-1", { pid, processIdentity: captured }),
    { code: "HUB_WORKER_PROCESS_IDENTITY_INVALID" },
  );
  await assert.rejects(
    readFile(path.join(store.registryDir, "worker-worker-1.json"), "utf8"),
    { code: "ENOENT" },
  );
});

test("local worker inbox lock rejects same-token successor identity during quarantine", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-successor");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const originalIdentity = testIdentity(999_999_991, "old");
  await staleLock(store, "worker-1", "a-1", { processIdentity: originalIdentity });

  __workerStoreTestHooks.afterLocalInboxLockQuarantineRename = async ({ quarantineDir }) => {
    await writeJson(path.join(quarantineDir, "owner.json"), {
      ownerToken: "owner-token",
      pid: originalIdentity.pid,
      host: os.hostname(),
      processIdentity: testIdentity(originalIdentity.pid, "successor"),
      acquiredAt: "2026-07-20T00:00:00.000Z",
    });
  };

  await assert.rejects(
    () => store.writeInboxWithReceipt("worker-1", assignment()),
    /worker inbox lock quarantine preserved; canonical restore refused/,
  );
});

test("local worker inbox lock recovers a stale exact owner", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-stale-exact-owner");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const staleIdentity = testIdentity(999_999_991, "stale-exact");
  const lockDir = await staleLock(store, "worker-1", "a-stale-exact", {
    pid: staleIdentity.pid,
    processIdentity: staleIdentity,
  });

  const receipt = await store.writeInboxWithReceipt("worker-1", assignment("a-stale-exact"));

  assert.equal(receipt.assignmentId, "a-stale-exact");
  const currentOwner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
  assert.notEqual(currentOwner.ownerToken, "owner-token");
  assert.equal(currentOwner.processIdentity.pid, process.pid);
  assert.equal(currentOwner.processIdentity.birthIdPrecision, "exact");
});

test("local worker inbox lock liveness errors preserve exact-owner evidence", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-lock-liveness-errors");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const failures = [
    Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
    Object.assign(new Error("liveness I/O failed"), { code: "EIO" }),
    new Error("unknown liveness failure"),
  ];

  for (const [index, failure] of failures.entries()) {
    const assignmentId = `a-liveness-${index}`;
    const identity = testIdentity(999_999_980 + index, `liveness-${index}`);
    const lockDir = await staleLock(store, "worker-1", assignmentId, {
      pid: identity.pid,
      processIdentity: identity,
    });
    __workerStoreTestHooks.isLocalInboxProcessIdentityAlive = () => {
      throw failure;
    };

    await assert.rejects(
      () => store._localInboxLockRecoveryCandidate(lockDir, path.join(lockDir, "owner.json")),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: unknown }).code, "HUB_WORKER_INBOX_LOCK_CONFLICT");
        assert.equal(error.cause, failure);
        return true;
      },
    );
    assert.equal(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")).ownerToken, "owner-token");
    assert.deepEqual(
      (await readdir(path.dirname(lockDir))).filter((entry) => entry.startsWith(`${assignmentId}.lock.`)),
      [],
    );
  }
});

test("local worker inbox quarantine restore never clobbers an ABA successor", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-quarantine-aba");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-quarantine-aba";
  const predecessorIdentity = testIdentity(999_999_979, "predecessor");
  const lockDir = await staleLock(store, workerId, assignmentId, {
    pid: predecessorIdentity.pid,
    processIdentity: predecessorIdentity,
  });
  const retiredDir = `${lockDir}.retired-predecessor`;
  const owner = (ownerToken: string, pid: number, birthId: string) => ({
    ownerToken,
    pid,
    host: os.hostname(),
    processIdentity: testIdentity(pid, birthId),
    acquiredAt: "2026-07-20T00:00:00.000Z",
  });

  __workerStoreTestHooks.beforeLocalInboxLockQuarantineRename = async () => {
    await rename(lockDir, retiredDir);
    await mkdir(lockDir);
    await writeJson(path.join(lockDir, "owner.json"), owner("second-owner", 999_999_978, "second"));
  };

  await assert.rejects(
    () => store.writeInboxWithReceipt(workerId, assignment(assignmentId)),
    (error: unknown) => {
      const actual = error as { code?: unknown; successorPreserved?: unknown; recoveryPaths?: { lockDir?: unknown } };
      assert.equal(actual.code, "HUB_WORKER_INBOX_LOCK_CONFLICT");
      assert.equal(actual.successorPreserved, true);
      assert.equal(actual.recoveryPaths?.lockDir, lockDir);
      return true;
    },
  );

  assert.equal(JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")).ownerToken, "second-owner");
  assert.equal(JSON.parse(await readFile(path.join(retiredDir, "owner.json"), "utf8")).ownerToken, "owner-token");
});

test("local worker inbox lock preserves a same-token successor created during quarantine", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-same-token-successor");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-same-token-successor";
  const predecessorIdentity = testIdentity(999_999_975, "predecessor");
  const successorIdentity = store._captureCurrentProcessIdentity();
  const lockDir = await staleLock(store, workerId, assignmentId, {
    ownerToken: "same-token-owner",
    pid: predecessorIdentity.pid,
    processIdentity: predecessorIdentity,
  });
  let quarantineDir = "";

  __workerStoreTestHooks.afterLocalInboxLockQuarantineRename = async (context) => {
    quarantineDir = context.quarantineDir;
    await mkdir(context.lockDir);
    await writeJson(path.join(context.lockDir, "owner.json"), {
      ownerToken: "same-token-owner",
      pid: successorIdentity.pid,
      host: os.hostname(),
      processIdentity: successorIdentity,
      acquiredAt: "2026-07-20T00:00:00.000Z",
    });
  };

  await assert.rejects(
    () => store.writeInboxWithReceipt(workerId, assignment(assignmentId)),
    (error: unknown) => {
      const actual = error as { code?: unknown; committed?: unknown; recoveryPaths?: { quarantineDir?: unknown; lockDir?: unknown } };
      assert.equal(actual.code, "HUB_WORKER_INBOX_LOCK_CONFLICT");
      assert.equal(actual.committed, true);
      assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
      assert.equal(actual.recoveryPaths?.lockDir, lockDir);
      return true;
    },
  );

  const successor = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
  assert.equal(successor.ownerToken, "same-token-owner");
  assert.equal(successor.processIdentity.incarnation, successorIdentity.incarnation);
  assert.equal(JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8")).processIdentity.birthId, "predecessor");
});

test("local worker inbox lock preserves quarantine when ownership changes during recovery", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-lock-restore-fsync");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-restore-fsync";
  const predecessorIdentity = testIdentity(999_999_976, "predecessor");
  const lockDir = await staleLock(store, workerId, assignmentId, {
    pid: predecessorIdentity.pid,
    processIdentity: predecessorIdentity,
  });
  const workerDir = path.dirname(lockDir);
  let quarantineDir = "";

  __workerStoreTestHooks.afterLocalInboxLockQuarantineRename = async (context) => {
    quarantineDir = context.quarantineDir;
    await writeJson(path.join(context.quarantineDir, "owner.json"), {
      ownerToken: "changed-during-quarantine",
      pid: predecessorIdentity.pid,
      host: os.hostname(),
      processIdentity: predecessorIdentity,
      acquiredAt: "2026-07-20T00:00:00.000Z",
    });
  };

  await assert.rejects(
    () => store.writeInboxWithReceipt(workerId, assignment(assignmentId)),
    (error: unknown) => {
      const actual = error as { code?: unknown; committed?: unknown; recoveryPaths?: { lockDir?: unknown; quarantineDir?: unknown } };
      assert.equal(actual.code, "HUB_WORKER_INBOX_LOCK_CONFLICT");
      assert.equal(actual.committed, true);
      assert.equal(actual.recoveryPaths?.lockDir, lockDir);
      assert.equal(actual.recoveryPaths?.quarantineDir, quarantineDir);
      return true;
    },
  );

  assert.ok(quarantineDir);
  await assert.rejects(readFile(path.join(lockDir, "owner.json"), "utf8"), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(path.join(quarantineDir, "owner.json"), "utf8")).ownerToken, "changed-during-quarantine");
  assert.deepEqual(
    (await readdir(workerDir)).filter((entry) => entry.startsWith(`${assignmentId}.lock.`)),
    [path.basename(quarantineDir)],
  );
});

test("local worker inbox acquisition cleanup preserves a replacement empty successor", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-owner-cleanup-successor");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-cleanup-successor";
  const workerDir = path.join(store.inboxDir, workerId);
  const lockDir = path.join(workerDir, `${assignmentId}.lock`);
  const retiredDir = `${lockDir}.retired-created`;

  __workerStoreTestHooks.afterLocalInboxLockMkdir = async () => {
    await rename(lockDir, retiredDir);
    await mkdir(lockDir);
  };
  store._captureCurrentProcessIdentity = () => {
    throw Object.assign(new Error("exact identity unavailable"), { code: "PROCESS_IDENTITY_UNAVAILABLE" });
  };

  await assert.rejects(
    () => store.writeInboxWithReceipt(workerId, assignment(assignmentId)),
    (error: unknown) => error instanceof AggregateError
      && /owner write cleanup failed/.test(error.message),
  );

  assert.equal((await lstat(lockDir)).isDirectory(), true);
  assert.deepEqual(await readdir(lockDir), []);
  assert.equal((await lstat(retiredDir)).isDirectory(), true);
});

test("local worker inbox release reports false ownership instead of succeeding", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-release-owner-race");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-release-owner-race";
  const lockDir = path.join(store.inboxDir, workerId, `${assignmentId}.lock`);
  const ownerFile = path.join(lockDir, "owner.json");
  await mkdir(lockDir, { recursive: true });
  await writeJson(ownerFile, {
    ownerToken: "replacement-token",
    pid: process.pid,
    host: os.hostname(),
    processIdentity: store._captureCurrentProcessIdentity(),
    acquiredAt: new Date().toISOString(),
  });

  await assert.rejects(
    () => store._releaseLocalInboxLock(lockDir, ownerFile, "old-token"),
    /worker inbox lock owner changed before release/,
  );
  assert.equal(JSON.parse(await readFile(ownerFile, "utf8")).ownerToken, "replacement-token");
});

test("local inbox payload stays unclaimable until its write-owner fence commits", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-publish-fence");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-fenced-publish";
  const payloadPath = path.join(store.inboxDir, workerId, `${assignmentId}.json`);
  const ownerPath = `${payloadPath}.write-owner`;
  let hookObserved = false;

  __workerStoreTestHooks.afterLocalInboxWriteOwner = async ({ stagingPath }) => {
    hookObserved = true;
    assert.equal(await fileExists(ownerPath), true);
    assert.equal(await fileExists(payloadPath), false);
    assert.equal(await fileExists(stagingPath), true);
    assert.deepEqual(await store.claimInboxEntries(workerId), []);
    throw Object.assign(new Error("simulated crash before payload publish"), { code: "TEST_PUBLISH_CRASH" });
  };

  await assert.rejects(
    () => store.writeInboxWithReceipt(workerId, assignment(assignmentId)),
    /simulated crash before payload publish/,
  );
  assert.equal(hookObserved, true);
  assert.equal(await fileExists(payloadPath), false);
  assert.equal(await fileExists(ownerPath), false);
  assert.deepEqual(await store.claimInboxEntries(workerId), []);
  assert.equal(
    (await readdir(path.join(store.inboxDir, workerId))).some((entry) => entry.includes(".pending-")),
    false,
  );
});

test("legacy local inbox lock without process identity stays closed while pid is alive", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-legacy-alive");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const lockDir = await staleLock(store, "worker-1", "a-1", { pid: process.pid });

  const candidate = await store._localInboxLockRecoveryCandidate(lockDir, path.join(lockDir, "owner.json"));

  assert.equal(candidate, null);
});

test("legacy local inbox lock without process identity stays closed after ESRCH", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-legacy-esrch");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const lockDir = await staleLock(store, "worker-1", "a-1", { pid: 999_999_992 });

  const candidate = await store._localInboxLockRecoveryCandidate(lockDir, path.join(lockDir, "owner.json"));

  assert.equal(candidate, null);
  assert.equal((await lstat(lockDir)).isDirectory(), true);
  assert.equal(await fileExists(path.join(lockDir, "owner.json")), true);
});

test("malformed or coarse local inbox lock identities fail closed without stale deletion", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-owner-invalid-identity");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const pid = 999_999_994;
  const cases: Array<[string, Record<string, unknown>]> = [
    ["coarse", { ...testIdentity(pid, "coarse"), birthIdPrecision: "coarse" }],
    ["missing-precision", {
      pid,
      birthId: "missing-precision",
      incarnation: `${pid}:missing-precision`,
      capturedAt: "2026-07-20T00:00:00.000Z",
    }],
    ["pid-mismatch", { ...testIdentity(pid + 1, "mismatch") }],
    ["noncanonical-incarnation", { ...testIdentity(pid, "wrong-incarnation"), incarnation: `${pid}:different` }],
    ["invalid-captured-at", { ...testIdentity(pid, "invalid-time"), capturedAt: "not-a-timestamp" }],
  ];

  for (const [name, processIdentity] of cases) {
    const assignmentId = `a-invalid-${name}`;
    const lockDir = await staleLock(store, "worker-1", assignmentId, { pid, processIdentity });
    await assert.rejects(
      () => store._localInboxLockRecoveryCandidate(lockDir, path.join(lockDir, "owner.json")),
      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
        && error.code === "HUB_WORKER_INBOX_LOCK_CONFLICT"),
    );
    assert.equal((await lstat(lockDir)).isDirectory(), true);
    assert.equal(await fileExists(path.join(lockDir, "owner.json")), true);
    assert.deepEqual(
      (await readdir(path.dirname(lockDir))).filter((entry) => entry.startsWith(`${assignmentId}.lock.`)),
      [],
    );
  }
});

test("local worker inbox lock owner symlink fails closed without quarantining lock", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-owner-symlink");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-owner-symlink";
  const lockDir = path.join(store.inboxDir, workerId, `${assignmentId}.lock`);
  const externalOwner = path.join(hubRoot, "external-owner.json");
  await mkdir(lockDir, { recursive: true });
  await writeJson(externalOwner, {
    ownerToken: "external-valid-owner",
    pid: 999_999_993,
    host: os.hostname(),
    processIdentity: testIdentity(999_999_993, "external"),
    acquiredAt: "2026-07-20T00:00:00.000Z",
  });
  await symlink(externalOwner, path.join(lockDir, "owner.json"));
  const old = new Date(Date.now() - 120_000);
  await utimes(lockDir, old, old);

  await assert.rejects(
    () => store._localInboxLockRecoveryCandidate(lockDir, path.join(lockDir, "owner.json")),
    (error: unknown) => error && typeof error === "object" && "code" in error
      && error.code === "HUB_WORKER_INBOX_LOCK_CONFLICT",
  );

  assert.equal((await lstat(lockDir)).isDirectory(), true);
  assert.equal((await lstat(path.join(lockDir, "owner.json"))).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(externalOwner, "utf8")).ownerToken, "external-valid-owner");
  assert.deepEqual(
    (await readdir(path.dirname(lockDir))).filter((entry) => entry.includes(`${assignmentId}.lock.`)),
    [],
  );
});

test("local worker inbox reads fail closed on symlink, oversized, and malformed payloads", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-inbox-safe-json");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerDir = path.join(store.inboxDir, "worker-1");
  await mkdir(workerDir, { recursive: true });
  const inboxPath = path.join(workerDir, "a-safe-json.json");
  const outside = path.join(hubRoot, "outside-payload.json");
  await writeJson(outside, assignment("a-safe-json"));
  await symlink(outside, inboxPath);

  await assert.rejects(
    () => store.readInbox("worker-1"),
    { code: "HUB_WORKER_INBOX_PAYLOAD_INVALID" },
  );
  assert.equal((await lstat(inboxPath)).isSymbolicLink(), true);

  await rename(inboxPath, path.join(workerDir, "a-safe-json.symlink"));
  await writeFile(inboxPath, "x".repeat(1024 * 1024 + 1), "utf8");
  await assert.rejects(
    () => store.readInbox("worker-1"),
    { code: "HUB_WORKER_INBOX_PAYLOAD_INVALID" },
  );

  await writeFile(inboxPath, "{not-json", "utf8");
  await assert.rejects(
    () => store.readInbox("worker-1"),
    (error: unknown) => error instanceof SyntaxError
      && (error as SyntaxError & { code?: unknown }).code === "HUB_WORKER_INBOX_PAYLOAD_INVALID"
      && error.cause instanceof SyntaxError,
  );
});

test("malformed local inbox claims remain explicitly removable", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-malformed-claim-removal");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-malformed-removal";
  const payloadPath = path.join(store.inboxDir, workerId, `${assignmentId}.json`);
  const ownerPath = `${payloadPath}.write-owner`;
  await mkdir(path.dirname(payloadPath), { recursive: true });
  await writeFile(payloadPath, "{not-json", "utf8");
  await writeJson(ownerPath, { ownerToken: "malformed-owner" });

  const [claim] = await store.claimInboxEntries(workerId);

  assert.equal(claim.assignmentId, assignmentId);
  assert.deepEqual(claim.assignment, { __malformedInbox: true });
  assert.equal(await fileExists(claim.claimToken), true);
  assert.equal(await fileExists(`${claim.claimToken}.write-owner`), true);
  assert.equal(await store.completeInboxClaim(workerId, assignmentId, claim.claimToken), true);
  assert.equal(await fileExists(claim.claimToken), false);
  assert.equal(await fileExists(`${claim.claimToken}.write-owner`), false);
});

test("local worker inbox lock owner reports post-rename fsync ambiguity", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-owner-ambiguity");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerDir = path.join(store.inboxDir, "worker-1");
  const lockDir = path.join(workerDir, "a-owner-ambiguity.lock");
  const ownerFile = path.join(lockDir, "owner.json");
  let failed = false;
  __workerStoreTestHooks.syncWorkerDirectory = async (directory) => {
    if (!failed && directory === lockDir) {
      failed = true;
      throw Object.assign(new Error("simulated lock dir fsync failure"), { code: "EIO" });
    }
  };

  await assert.rejects(
    () => store.writeInboxWithReceipt("worker-1", assignment("a-owner-ambiguity")),
    (error: unknown) => {
      const actual = error as {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: string[];
      };
      assert.equal(actual.code, "DURABLE_JSON_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(actual.committed, true);
      assert.equal(actual.committedPath, ownerFile);
      assert.deepEqual(actual.recoveryPaths, [ownerFile, lockDir]);
      return true;
    },
  );
  assert.equal(failed, true);
  assert.equal((await lstat(lockDir)).isDirectory(), true);
  assert.equal((await lstat(ownerFile)).isFile(), true);
});

test("local worker inbox publish reports committed ambiguity when payload rename fsync fails", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-publish-ambiguity");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerDir = path.join(store.inboxDir, "worker-1");
  let publishStarted = false;
  __workerStoreTestHooks.afterLocalInboxWriteOwner = async () => {
    publishStarted = true;
  };
  __workerStoreTestHooks.syncWorkerDirectory = async (directory) => {
    if (publishStarted && directory === workerDir) {
      throw Object.assign(new Error("simulated inbox dir fsync failure"), { code: "EIO" });
    }
  };

  const payloadPath = path.join(workerDir, "a-publish-ambiguity.json");
  const ownerPath = `${payloadPath}.write-owner`;

  await assert.rejects(
    () => store.writeInboxWithReceipt("worker-1", assignment("a-publish-ambiguity")),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const actual = error as AggregateError & {
        code?: string;
        committed?: boolean;
        committedPath?: string;
        recoveryPaths?: string[];
      };
      assert.equal(actual.code, "HUB_WORKER_INBOX_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(actual.committed, true);
      assert.equal(actual.committedPath, payloadPath);
      assert.deepEqual(actual.recoveryPaths, [payloadPath, ownerPath, workerDir]);
      assert.equal(
        error.errors.some((nested) => nested instanceof Error && /simulated inbox dir fsync failure/.test(nested.message)),
        true,
      );
      return true;
    },
  );
  for (const recoveryPath of [payloadPath, ownerPath, workerDir]) {
    await assert.doesNotReject(lstat(recoveryPath));
  }
});

test("pruneDead preserves exited worker when pid now belongs to a successor", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-prune-successor");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const worker = {
    workerId: "worker-1",
    pid: 1234,
    host: os.hostname(),
    status: "exited",
    processIdentity: testIdentity(1234, "old"),
  };
  await writeJson(path.join(store.registryDir, "worker-worker-1.json"), worker);
  store._captureProcessIdentity = () => testIdentity(1234, "successor");

  await assert.rejects(() => store.pruneDead(), /worker cleanup failed/);
  assert.deepEqual(JSON.parse(await readFile(path.join(store.registryDir, "worker-worker-1.json"), "utf8")), worker);
});

test("pruneDead preserves and reports workers missing process identity", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-prune-missing");
  const store = new WorkerStore(hubRoot);
  await store.init();
  await writeJson(path.join(store.registryDir, "worker-worker-1.json"), {
    workerId: "worker-1",
    pid: 1234,
    host: os.hostname(),
    status: "exited",
  });

  await assert.rejects(() => store.pruneDead(), /worker cleanup failed/);
});

test("pruneDead preserves workers with coarse or PID-mismatched persisted identity", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-prune-coarse");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const coarseWorker = {
    workerId: "worker-1",
    pid: 1234,
    host: os.hostname(),
    status: "exited",
    processIdentity: { ...testIdentity(1234, "coarse"), birthIdPrecision: "coarse" },
  };
  const mismatchedWorker = {
    workerId: "worker-2",
    pid: 2345,
    host: os.hostname(),
    status: "exited",
    processIdentity: testIdentity(3456, "wrong-pid"),
  };
  const coarseRegistryPath = path.join(store.registryDir, "worker-worker-1.json");
  const mismatchedRegistryPath = path.join(store.registryDir, "worker-worker-2.json");
  await writeJson(coarseRegistryPath, coarseWorker);
  await writeJson(mismatchedRegistryPath, mismatchedWorker);
  let probed = false;
  store._captureProcessIdentity = () => {
    probed = true;
    return null;
  };

  await assert.rejects(() => store.pruneDead(), /worker cleanup failed/);

  assert.equal(probed, false);
  assert.deepEqual(JSON.parse(await readFile(coarseRegistryPath, "utf8")), coarseWorker);
  assert.deepEqual(JSON.parse(await readFile(mismatchedRegistryPath, "utf8")), mismatchedWorker);
});

test("pruneDead reports liveness probe errors instead of deleting", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-prune-eperm");
  const store = new WorkerStore(hubRoot);
  await store.init();
  await writeJson(path.join(store.registryDir, "worker-worker-1.json"), {
    workerId: "worker-1",
    pid: 1234,
    host: os.hostname(),
    status: "exited",
    processIdentity: testIdentity(1234, "old"),
  });
  store._captureProcessIdentity = () => {
    throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
  };

  await assert.rejects(() => store.pruneDead(), /worker cleanup failed/);
});

test("pruneDead reports cleanup filesystem failures", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-prune-fs");
  const store = new WorkerStore(hubRoot);
  await store.init();
  store.listWorkers = async () => [{
    workerId: "worker-1",
    pid: 1234,
    host: os.hostname(),
    status: "exited",
    processIdentity: testIdentity(1234, "old"),
  }];
  store._captureProcessIdentity = () => null;

  await assert.rejects(() => store.pruneDead(), /worker cleanup failed/);
});

test("pruneDead keeps the local registry retryable when inbox cleanup fails", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-prune-order");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const worker = {
    workerId: "worker-1",
    pid: 1234,
    host: os.hostname(),
    status: "exited",
    processIdentity: testIdentity(1234, "old"),
  };
  const registryPath = path.join(store.registryDir, "worker-worker-1.json");
  await writeJson(registryPath, worker);
  await writeJson(path.join(store.inboxDir, "worker-1", "a-1.json"), assignment());
  store._captureProcessIdentity = () => null;
  let registryDeleteAttempted = false;
  store._removeLocalWorkerInbox = async () => {
    throw Object.assign(new Error("inbox I/O failure"), { code: "EIO" });
  };
  store._removeLocalWorkerRegistry = async () => {
    registryDeleteAttempted = true;
  };

  await assert.rejects(
    () => store.pruneDead(),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some((nested) => nested && typeof nested === "object" && "code" in nested && nested.code === "EIO"),
  );
  assert.equal(registryDeleteAttempted, false);
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), worker);
});

test("Redis prune keeps the registry retryable until inbox deletion verifies", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-redis-prune-order");
  const store = new WorkerStore(hubRoot);
  const inboxField = store._inboxField("worker-1", "a-1", 1, "attempt-a-1");
  let registryDeleteAttempted = false;
  store._redisBackend = {
    identityFingerprint: "test-worker-cleanup",
    scanStateRecords: async (prefix: string) => prefix === store._inboxPrefix("worker-1")
      ? [{ field: inboxField, record: { revision: 1, data: { assignmentId: "a-1" } } }]
      : [],
    readStateRecord: async (field: string) => ({
      revision: 1,
      data: field === inboxField ? { assignmentId: "a-1" } : { workerId: "worker-1" },
    }),
    compareAndSwapStateRecord: async (field: string) => {
      if (field !== inboxField) registryDeleteAttempted = true;
      return { committed: true, fenced: false, revision: 2 };
    },
  } as never;
  store.listWorkers = async () => [{
    workerId: "worker-1",
    pid: 1234,
    host: os.hostname(),
    status: "exited",
    processIdentity: testIdentity(1234, "old"),
  }];
  store._captureProcessIdentity = () => null;

  await assert.rejects(() => store.pruneDead(), /worker cleanup failed/);
  assert.equal(registryDeleteAttempted, false);
});

test("local inbox deletion propagates I/O errors and removes write-owner sidecars", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-delete-errors");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";

  const clearReceipt = await store.writeInboxWithReceipt(workerId, assignment("a-clear"));
  const clearPath = String(clearReceipt.path);
  const clearOwnerPath = `${clearPath}.write-owner`;
  const unlinkLocalInboxPath = store._unlinkLocalInboxPath.bind(store);
  store._unlinkLocalInboxPath = async (filePath) => {
    if (filePath === clearPath) throw Object.assign(new Error("clear EIO"), { code: "EIO" });
    return unlinkLocalInboxPath(filePath);
  };
  await assert.rejects(
    () => store.clearInboxEntry(workerId, "a-clear"),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "EIO"),
  );
  assert.equal(await fileExists(clearPath), true);
  assert.equal(await fileExists(clearOwnerPath), true);
  store._unlinkLocalInboxPath = unlinkLocalInboxPath;
  await store.clearInboxEntry(workerId, "a-clear");
  assert.equal(await fileExists(clearPath), false);
  assert.equal(await fileExists(clearOwnerPath), false);

  const completeReceipt = await store.writeInboxWithReceipt(workerId, assignment("a-complete"));
  const [claim] = await store.claimInboxEntries(workerId);
  assert.equal(claim.assignmentId, "a-complete");
  const claimedOwnerPath = `${claim.claimToken}.write-owner`;
  assert.equal(await fileExists(String(completeReceipt.path)), false);
  assert.equal(await fileExists(claimedOwnerPath), true);
  const unlinkClaimPath = store._unlinkLocalInboxPath.bind(store);
  store._unlinkLocalInboxPath = async (filePath) => {
    if (filePath === claim.claimToken) throw Object.assign(new Error("complete EPERM"), { code: "EPERM" });
    return unlinkClaimPath(filePath);
  };
  await assert.rejects(
    () => store.completeInboxClaim(workerId, claim.assignmentId, claim.claimToken),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM"),
  );
  assert.equal(await fileExists(claim.claimToken), true);
  assert.equal(await fileExists(claimedOwnerPath), true);
  store._unlinkLocalInboxPath = unlinkClaimPath;
  assert.equal(await store.completeInboxClaim(workerId, claim.assignmentId, claim.claimToken), true);
  assert.equal(await fileExists(claim.claimToken), false);
  assert.equal(await fileExists(claimedOwnerPath), false);

  await store.clearInboxEntry(workerId, "already-missing");
  assert.equal(
    await store.completeInboxClaim(
      workerId,
      "already-missing",
      path.join(store.inboxDir, workerId, "processing", "already-missing.json"),
    ),
    false,
  );
});

test("local inbox lock rejects same-inode metadata changes before quarantine", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-lock-same-inode");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-lock-same-inode";
  const identity = testIdentity(999_999_970, "same-inode-lock");
  const lockDir = await staleLock(store, workerId, assignmentId, {
    pid: identity.pid,
    processIdentity: identity,
  });
  const before = await lstat(lockDir);

  __workerStoreTestHooks.beforeLocalInboxLockQuarantineRename = async () => {
    const changed = new Date();
    await utimes(lockDir, changed, changed);
  };

  await assert.rejects(
    () => store.writeInboxWithReceipt(workerId, assignment(assignmentId)),
    (error: unknown) => {
      const actual = error as {
        code?: unknown;
        committed?: unknown;
        successorPreserved?: unknown;
      };
      assert.equal(actual.code, "HUB_WORKER_INBOX_LOCK_CONFLICT");
      assert.equal(actual.committed, false);
      assert.equal(actual.successorPreserved, true);
      return true;
    },
  );

  const after = await lstat(lockDir);
  assert.equal(String(after.dev), String(before.dev));
  assert.equal(String(after.ino), String(before.ino));
  assert.notEqual(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(
    (await readdir(path.dirname(lockDir))).filter((entry) => entry.startsWith(`${assignmentId}.lock.stale-`)),
    [],
  );
});

test("local inbox cleanup rejects symlinks without touching their targets", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-cleanup-symlink");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-cleanup-symlink";
  const receipt = await store.writeInboxWithReceipt(workerId, assignment(assignmentId));
  const payloadPath = String(receipt.path);
  const retiredPath = `${payloadPath}.retired`;
  const targetPath = path.join(hubRoot, "cleanup-symlink-target.json");
  const targetContent = "target-must-survive\n";
  await writeFile(targetPath, targetContent, "utf8");
  await rename(payloadPath, retiredPath);
  await symlink(targetPath, payloadPath);

  await assert.rejects(
    () => store.clearInboxEntry(workerId, assignmentId),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "HUB_WORKER_PATH_UNSAFE"
    ),
  );

  assert.equal((await lstat(payloadPath)).isSymbolicLink(), true);
  assert.equal(await readFile(targetPath, "utf8"), targetContent);
  assert.deepEqual(JSON.parse(await readFile(retiredPath, "utf8")), assignment(assignmentId));
});

test("local inbox cleanup preserves an ABA successor before isolation", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-cleanup-aba");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-cleanup-aba";
  const receipt = await store.writeInboxWithReceipt(workerId, assignment(assignmentId));
  const payloadPath = String(receipt.path);
  const retiredPath = `${payloadPath}.retired`;
  const successor = { ...assignment(assignmentId), successor: "must-survive" };
  let swapped = false;

  __workerStoreTestHooks.beforeWorkerPathIsolationRename = async ({ filePath, reason }) => {
    if (swapped || filePath !== payloadPath || reason !== "local-inbox-entry-cleanup") return;
    swapped = true;
    await rename(payloadPath, retiredPath);
    await writeJson(payloadPath, successor);
  };

  await assert.rejects(
    () => store.clearInboxEntry(workerId, assignmentId),
    (error: unknown) => {
      const actual = error as {
        code?: unknown;
        committed?: unknown;
        successorPreserved?: unknown;
      };
      assert.equal(actual.code, "HUB_WORKER_PATH_GENERATION_CONFLICT");
      assert.equal(actual.committed, false);
      assert.equal(actual.successorPreserved, true);
      return true;
    },
  );

  assert.equal(swapped, true);
  assert.deepEqual(JSON.parse(await readFile(payloadPath, "utf8")), successor);
  assert.deepEqual(JSON.parse(await readFile(retiredPath, "utf8")), assignment(assignmentId));
});

test("local inbox cleanup reports committed quarantine when parent fsync fails", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-cleanup-durability");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-cleanup-durability";
  const receipt = await store.writeInboxWithReceipt(workerId, assignment(assignmentId));
  const payloadPath = String(receipt.path);
  const workerDir = path.dirname(payloadPath);
  let quarantinePath = "";
  let failIsolationSync = false;

  __workerStoreTestHooks.afterWorkerPathIsolationRename = ({ filePath, quarantinePath: movedPath }) => {
    if (filePath !== payloadPath) return;
    quarantinePath = movedPath;
    failIsolationSync = true;
  };
  __workerStoreTestHooks.syncWorkerDirectory = async (directory) => {
    if (failIsolationSync && directory === workerDir) {
      failIsolationSync = false;
      throw Object.assign(new Error("simulated cleanup parent fsync failure"), { code: "EIO" });
    }
  };

  await assert.rejects(
    () => store.clearInboxEntry(workerId, assignmentId),
    (error: unknown) => {
      const actual = error as {
        code?: unknown;
        committed?: unknown;
        committedPath?: unknown;
        recoveryPaths?: unknown;
        successorPreserved?: unknown;
      };
      assert.equal(actual.code, "HUB_WORKER_PATH_ISOLATION_COMMITTED_AMBIGUOUS");
      assert.equal(actual.committed, true);
      assert.equal(actual.committedPath, quarantinePath);
      assert.equal(Array.isArray(actual.recoveryPaths), true);
      assert.equal((actual.recoveryPaths as string[]).includes(payloadPath), true);
      assert.equal((actual.recoveryPaths as string[]).includes(quarantinePath), true);
      assert.equal(actual.successorPreserved, false);
      return true;
    },
  );

  assert.notEqual(quarantinePath, "");
  await assert.rejects(lstat(payloadPath), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(quarantinePath, "utf8")), assignment(assignmentId));
  assert.equal(await fileExists(`${payloadPath}.write-owner`), true);
});

test("local inbox rollback preserves a successor written before compensation", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-rollback-successor");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-rollback-successor";
  const first = await store.writeInboxWithReceipt(workerId, assignment(assignmentId));
  const payloadPath = String(first.path);
  const retiredPath = `${payloadPath}.rollback-predecessor`;
  const successor = { ...assignment(assignmentId), successor: "external-writer" };
  let injected = false;

  __workerStoreTestHooks.afterLocalInboxWriteOwner = async () => {
    if (injected) return;
    injected = true;
    await rename(payloadPath, retiredPath);
    await writeJson(payloadPath, successor);
    throw Object.assign(new Error("simulated publish interruption"), { code: "EIO" });
  };

  await assert.rejects(
    () => store.writeInboxWithReceipt(workerId, {
      ...assignment(assignmentId),
      replacement: "this-write-must-not-clobber-successor",
    }),
    /worker inbox write rollback failed/,
  );

  assert.equal(injected, true);
  assert.deepEqual(JSON.parse(await readFile(payloadPath, "utf8")), successor);
  assert.deepEqual(JSON.parse(await readFile(retiredPath, "utf8")), assignment(assignmentId));
});

test("pruneDead isolates exact worker inbox and registry generations", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-prune-quarantine");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const worker = {
    workerId,
    pid: 1234,
    host: os.hostname(),
    status: "exited",
    incarnationToken: "old-worker-incarnation",
    processIdentity: testIdentity(1234, "old-worker-process"),
  };
  const registryPath = path.join(store.registryDir, `worker-${workerId}.json`);
  const inboxPath = path.join(store.inboxDir, workerId);
  await writeJson(registryPath, worker);
  await writeJson(path.join(inboxPath, "a-1.json"), assignment());
  store._captureProcessIdentity = () => null;

  assert.equal(await store.pruneDead(), 1);
  await assert.rejects(lstat(registryPath), { code: "ENOENT" });
  await assert.rejects(lstat(inboxPath), { code: "ENOENT" });

  const registryQuarantines = (await readdir(store.registryDir))
    .filter((entry) => entry.startsWith(".worker-cleanup-"));
  const inboxQuarantines = (await readdir(store.inboxDir))
    .filter((entry) => entry.startsWith(".worker-cleanup-"));
  assert.equal(registryQuarantines.length, 1);
  assert.equal(inboxQuarantines.length, 1);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(store.registryDir, registryQuarantines[0]), "utf8")),
    worker,
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(store.inboxDir, inboxQuarantines[0], "a-1.json"), "utf8")),
    assignment(),
  );
  assert.equal(await store.pruneDead(), 0);
});

test("pruneDead preserves an ABA registry successor", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-prune-registry-aba");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const predecessor = {
    workerId,
    pid: 1234,
    host: os.hostname(),
    status: "exited",
    incarnationToken: "predecessor",
    processIdentity: testIdentity(1234, "predecessor"),
  };
  const successor = {
    ...predecessor,
    status: "ready",
    incarnationToken: "successor",
    processIdentity: testIdentity(1234, "successor"),
  };
  const registryPath = path.join(store.registryDir, `worker-${workerId}.json`);
  const retiredPath = `${registryPath}.retired`;
  await writeJson(registryPath, predecessor);
  store._captureProcessIdentity = () => null;
  let swapped = false;
  __workerStoreTestHooks.beforeWorkerPathIsolationRename = async ({ filePath, reason }) => {
    if (swapped || filePath !== registryPath || reason !== "dead-worker-registry-cleanup") return;
    swapped = true;
    await rename(registryPath, retiredPath);
    await writeJson(registryPath, successor);
  };

  await assert.rejects(
    () => store.pruneDead(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      const conflict = error.errors.find((nested) => nested && typeof nested === "object"
        && "code" in nested && nested.code === "HUB_WORKER_PATH_GENERATION_CONFLICT") as
        | { committed?: unknown; successorPreserved?: unknown }
        | undefined;
      assert.ok(conflict);
      assert.equal(conflict.committed, false);
      assert.equal(conflict.successorPreserved, true);
      return true;
    },
  );

  assert.equal(swapped, true);
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), successor);
  assert.deepEqual(JSON.parse(await readFile(retiredPath, "utf8")), predecessor);
});

test("pruneDead detects same-inode registry metadata changes", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-prune-registry-same-inode");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const predecessor = {
    workerId,
    pid: 1234,
    host: os.hostname(),
    status: "exited",
    incarnationToken: "same-inode-predecessor",
    processIdentity: testIdentity(1234, "same-inode-predecessor"),
  };
  const successor = {
    ...predecessor,
    incarnationToken: "same-inode-successor-with-different-size",
  };
  const registryPath = path.join(store.registryDir, `worker-${workerId}.json`);
  await writeJson(registryPath, predecessor);
  const before = await lstat(registryPath);
  let changed = false;
  store._captureProcessIdentity = () => null;
  __workerStoreTestHooks.beforeWorkerPathIsolationRename = async ({ filePath, reason }) => {
    if (changed || filePath !== registryPath || reason !== "dead-worker-registry-cleanup") return;
    changed = true;
    await writeFile(registryPath, `${JSON.stringify(successor)}\n`, "utf8");
  };

  await assert.rejects(
    () => store.pruneDead(),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some((nested) => nested && typeof nested === "object"
        && "code" in nested && nested.code === "HUB_WORKER_PATH_GENERATION_CONFLICT"),
  );

  const after = await lstat(registryPath);
  assert.equal(changed, true);
  assert.equal(String(after.dev), String(before.dev));
  assert.equal(String(after.ino), String(before.ino));
  assert.notEqual(after.size, before.size);
  assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), successor);
});

test("local worker directory authorities reject symlink substitutions", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-directory-symlink");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const registryTarget = path.join(store.baseDir, "registry-target");
  await rename(store.registryDir, registryTarget);
  const targetRecord = {
    workerId: "target-worker",
    status: "ready",
  };
  await writeJson(path.join(registryTarget, "worker-target-worker.json"), targetRecord);
  await symlink(registryTarget, store.registryDir, "dir");

  await assert.rejects(
    () => store.listWorkers(),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "HUB_WORKER_PATH_UNSAFE"
    ),
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(registryTarget, "worker-target-worker.json"), "utf8")),
    targetRecord,
  );

  const inboxTarget = path.join(store.baseDir, "inbox-target");
  await writeJson(path.join(inboxTarget, "visible.json"), assignment("visible"));
  const workerInboxPath = path.join(store.inboxDir, "worker-link");
  await symlink(inboxTarget, workerInboxPath, "dir");
  await assert.rejects(
    () => store.hasInboxWork("worker-link"),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "HUB_WORKER_PATH_UNSAFE"
    ),
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(inboxTarget, "visible.json"), "utf8")),
    assignment("visible"),
  );
});

test("concurrent local inbox cleanup preserves quarantines and reports committed races", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-cleanup-concurrent");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-cleanup-concurrent";
  const receipt = await store.writeInboxWithReceipt(workerId, assignment(assignmentId));
  const payloadPath = String(receipt.path);
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => store.clearInboxEntry(workerId, assignmentId)),
  );

  assert.equal(results.some((result) => result.status === "fulfilled"), true);
  for (const result of results) {
    if (result.status === "fulfilled") continue;
    const error = result.reason as {
      code?: unknown;
      committed?: unknown;
      quarantinePreserved?: unknown;
    };
    assert.equal(error.code, "HUB_WORKER_INBOX_LOCK_CONFLICT");
    assert.equal(error.committed, true);
    assert.notEqual(error.quarantinePreserved, false);
  }
  assert.equal(await fileExists(payloadPath), false);
  assert.equal(await fileExists(`${payloadPath}.write-owner`), false);
  assert.deepEqual(await store.readInbox(workerId), []);
  assert.equal(
    (await readdir(path.dirname(payloadPath))).some((entry) => entry.startsWith(".worker-cleanup-")),
    true,
  );
});

test("local inbox compensation preserves same-value generation successors", async () => {
  const hubRoot = await tempRoot("cpb-worker-store-compensation-generation");
  const store = new WorkerStore(hubRoot);
  await store.init();
  const workerId = "worker-1";
  const assignmentId = "a-compensation-generation";
  const receipt = await store.writeInboxWithReceipt(workerId, assignment(assignmentId));
  if (receipt.writeFence.backend !== "local") throw new Error("expected local write fence");
  const payloadPath = String(receipt.path);
  const ownerPath = `${payloadPath}.write-owner`;
  const retiredPayload = `${payloadPath}.retired-generation`;
  const retiredOwner = `${ownerPath}.retired-generation`;
  await rename(payloadPath, retiredPayload);
  await writeJson(payloadPath, receipt.committedRecord);
  await rename(ownerPath, retiredOwner);
  await writeJson(ownerPath, receipt.writeFence.committedOwner);

  await assert.rejects(
    () => store.compensateInboxReceipt(receipt),
    (error: unknown) => Boolean(
      error && typeof error === "object"
      && "code" in error && error.code === "HUB_WORKER_INBOX_COMPENSATION_CONFLICT"
      && "successorPreserved" in error && error.successorPreserved === true
    ),
  );

  assert.deepEqual(JSON.parse(await readFile(payloadPath, "utf8")), receipt.committedRecord);
  assert.deepEqual(JSON.parse(await readFile(ownerPath, "utf8")), receipt.writeFence.committedOwner);
  assert.deepEqual(JSON.parse(await readFile(retiredPayload, "utf8")), receipt.committedRecord);
  assert.deepEqual(JSON.parse(await readFile(retiredOwner, "utf8")), receipt.writeFence.committedOwner);
});
