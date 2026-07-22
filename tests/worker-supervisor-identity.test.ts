import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { SpawnSyncReturns } from "node:child_process";
import { WorkerSupervisor } from "../server/orchestrator/worker-supervisor.js";
import { Reconciler } from "../server/orchestrator/reconciler.js";
import type { ProcessIdentity, ProcessTreeSystem } from "../core/runtime/process-tree.js";
import { WorkerStore } from "../shared/orchestrator/worker-store.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

function identity(pid: number, birthId: string): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: new Date().toISOString(),
    birthIdPrecision: "exact",
  };
}

async function tempRoot(label: string) {
  const dir = path.join(repoRoot, ".test-tmp", `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

function fakeSpawnSync(stdout = ""): ProcessTreeSystem["spawnSync"] {
  return ((() => ({
    pid: 0,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
  }) as SpawnSyncReturns<string>) as unknown) as ProcessTreeSystem["spawnSync"];
}

function supervisorWithSystem(hubRoot: string, workerStore: WorkerStore, system: ProcessTreeSystem) {
  return new WorkerSupervisor(hubRoot, repoRoot, {
    workerStore,
    executorRoot: repoRoot,
    processSystem: system,
    killGraceMs: 0,
    forceVerifyMs: 20,
  });
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

test("WorkerSupervisor stop refuses successor identity and leaves worker state unchanged", async () => {
  const hubRoot = await tempRoot("supervisor-successor-identity");
  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();
  const expected = identity(4242, "old");
  const successor = identity(4242, "new");
  const signals: Array<{ pid: number; signal?: string | number }> = [];
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: fakeSpawnSync(),
    captureIdentity: () => successor,
    kill(pid, signal) {
      signals.push({ pid, signal });
      return true;
    },
  };
  await workerStore.registerWorker("w-successor", {
    projectId: "p",
    pid: expected.pid,
    status: "running",
    incarnationToken: "worker-incarnation",
    processIdentity: expected,
  });
  const supervisor = supervisorWithSystem(hubRoot, workerStore, system);

  await assert.rejects(
    supervisor.stopWorker("w-successor", "restart"),
    hasCode("PROCESS_IDENTITY_MISMATCH"),
  );

  assert.deepEqual(signals, [], "successor PID must not receive any signal");
  const worker = await workerStore.getWorker("w-successor");
  assert.equal(worker?.status, "running");
  assert.equal(worker?.stopReason, undefined);
  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
});

test("WorkerSupervisor stop fails closed on EPERM and does not mark worker stopped", async () => {
  const hubRoot = await tempRoot("supervisor-eperm");
  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();
  const processIdentity = identity(5252, "birth");
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: fakeSpawnSync(),
    captureIdentity: () => processIdentity,
    kill() {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    },
  };
  await workerStore.registerWorker("w-eperm", {
    projectId: "p",
    pid: processIdentity.pid,
    status: "running",
    incarnationToken: "worker-incarnation",
    processIdentity,
  });
  const supervisor = supervisorWithSystem(hubRoot, workerStore, system);

  await assert.rejects(
    supervisor.stopWorker("w-eperm", "restart"),
    hasCode("EPERM"),
  );

  const worker = await workerStore.getWorker("w-eperm");
  assert.equal(worker?.status, "running");
  assert.equal(worker?.stopReason, undefined);
  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
});

test("WorkerSupervisor stop requires persisted process identity for legacy records", async () => {
  const hubRoot = await tempRoot("supervisor-legacy");
  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();
  await workerStore.registerWorker("w-legacy", {
    projectId: "p",
    pid: 6262,
    status: "running",
    incarnationToken: "worker-incarnation",
  });
  const supervisor = supervisorWithSystem(hubRoot, workerStore, {
    platform: "linux",
    spawnSync: fakeSpawnSync(),
    captureIdentity: () => identity(6262, "birth"),
    kill() {
      return true;
    },
  });

  await assert.rejects(
    supervisor.stopWorker("w-legacy", "restart"),
    hasCode("WORKER_PROCESS_IDENTITY_UNAVAILABLE"),
  );

  const worker = await workerStore.getWorker("w-legacy");
  assert.equal(worker?.status, "running");
  assert.equal(worker?.stopReason, undefined);
  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
});

test("WorkerSupervisor spawn identity failure preserves unverified cleanup evidence without pid re-claim", async () => {
  const hubRoot = await tempRoot("supervisor-spawn-identity-failure");
  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();
  const signals: Array<[number, string | number | undefined]> = [];
  const supervisor = supervisorWithSystem(hubRoot, workerStore, {
    platform: process.platform,
    spawnSync: fakeSpawnSync(),
    captureIdentity: () => null,
    kill(pid, signal) {
      signals.push([pid, signal]);
      return true;
    },
  });

  let spawnedPid = 0;
  try {
    await assert.rejects(
      supervisor.startWorker({ projectId: "p" }),
      (error: NodeJS.ErrnoException & { cleanupVerified?: boolean; unregisteredChildPid?: number }) => {
        spawnedPid = Number(error.unregisteredChildPid || 0);
        return error.code === "WORKER_PROCESS_IDENTITY_UNAVAILABLE"
          && error.cleanupVerified === false
          && Number.isSafeInteger(error.unregisteredChildPid)
          && Number(error.unregisteredChildPid) > 0;
      },
    );

    assert.deepEqual(signals, [], "spawn identity failure must not recapture or signal by bare pid");
    const workers = await workerStore.listWorkers();
    assert.equal(workers.length, 1);
    assert.equal(workers[0]?.status, "unhealthy");
    assert.notEqual(workers[0]?.status, "exited");
    assert.equal(workers[0]?.pid, spawnedPid);
    assert.equal(workers[0]?.processIdentity, null);
    assert.equal(workers[0]?.cleanupVerified, false);
    assert.equal(workers[0]?.recoveryError, "missing_process_identity");
  } finally {
    if (spawnedPid > 0) {
      try { process.kill(spawnedPid, "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("WorkerSupervisor refuses unsafe persisted pid and process-group identities", async () => {
  for (const variant of ["unsafe-pid", "unsafe-process-group"] as const) {
    const hubRoot = await tempRoot(`supervisor-${variant}`);
    const workerStore = new WorkerStore(hubRoot);
    await workerStore.init();
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const pid = variant === "unsafe-pid" ? unsafe : 6363;
    const processIdentity = identity(pid, variant);
    processIdentity.processGroupId = variant === "unsafe-process-group" ? unsafe : pid;
    const workerId = `w-${variant}`;
    await writeFile(path.join(workerStore.registryDir, `worker-${workerId}.json`), `${JSON.stringify({
      workerId,
      projectId: "p",
      pid,
      host: "local",
      status: "running",
      incarnationToken: "worker-incarnation",
      processIdentity,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    })}\n`, "utf8");
    const signals: Array<[number, string | number]> = [];
    const supervisor = supervisorWithSystem(hubRoot, workerStore, {
      platform: "linux",
      spawnSync: fakeSpawnSync(),
      captureIdentity: () => processIdentity,
      kill(pidValue, signal) {
        signals.push([pidValue, signal ?? 0]);
        return true;
      },
    });

    await assert.rejects(
      supervisor.stopWorker(workerId, "restart"),
      hasCode("WORKER_PROCESS_IDENTITY_UNAVAILABLE"),
    );
    assert.deepEqual(signals, []);
    assert.equal((await workerStore.getWorker(workerId))?.status, "running");
    await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test("WorkerSupervisor old child exit callback cannot overwrite successor incarnation", async () => {
  const hubRoot = await tempRoot("supervisor-stale-exit");
  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();
  const oldIdentity = identity(7272, "old");
  const newIdentity = identity(7272, "new");
  await workerStore.registerWorker("w-stale", {
    projectId: "p",
    pid: oldIdentity.pid,
    status: "running",
    incarnationToken: "old-incarnation",
    processIdentity: oldIdentity,
  });
  await workerStore.updateWorker("w-stale", {
    pid: newIdentity.pid,
    status: "running",
    incarnationToken: "new-incarnation",
    processIdentity: newIdentity,
  });
  const supervisor = supervisorWithSystem(hubRoot, workerStore, {
    platform: "linux",
    spawnSync: fakeSpawnSync(),
    captureIdentity: () => newIdentity,
    kill() {
      return true;
    },
  });

  await supervisor._handleChildExit({
    workerId: "w-stale",
    incarnationToken: "old-incarnation",
    processIdentity: oldIdentity,
    assignment: { projectId: "p" },
    code: 1,
  });

  const worker = await workerStore.getWorker("w-stale");
  assert.equal(worker?.status, "running");
  assert.equal(worker?.incarnationToken, "new-incarnation");
  assert.deepEqual(worker?.processIdentity, newIdentity);
  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
});

test("Reconciler restart stop failure is release-blocking and rethrows", async () => {
  const failure = Object.assign(new Error("identity mismatch"), { code: "PROCESS_IDENTITY_MISMATCH" });
  const reconciler = new Reconciler(repoRoot, {
    assignmentStore: {} as never,
    workerStore: {} as never,
    leaderLock: { stillHeld: async () => true },
    failureRouter: { route: async () => ({}), resetBudget: () => undefined },
    workerSupervisor: {
      stopWorker: async () => {
        throw failure;
      },
    },
  });

  await assert.rejects(
    reconciler._stopWorkerForRestart({ workerId: "w1" }, { workerId: "w1" }, "restart"),
    failure,
  );
});

test("Reconciler worker recovery treats legacy pid-only records as unhealthy, not exited", async () => {
  const hubRoot = await tempRoot("reconciler-legacy-worker");
  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();
  await workerStore.registerWorker("w-reconciler-legacy", {
    projectId: "p",
    pid: 8383,
    status: "running",
    incarnationToken: "worker-incarnation",
  });
  const reconciler = new Reconciler(hubRoot, {
    assignmentStore: {} as never,
    workerStore,
    leaderLock: { stillHeld: async () => true },
    failureRouter: { route: async () => ({}), resetBudget: () => undefined },
    workerSupervisor: null,
  });

  await reconciler.reconcileWorkers();

  const worker = await workerStore.getWorker("w-reconciler-legacy");
  assert.equal(worker?.status, "unhealthy");
  assert.equal(worker?.recoveryError, "missing_process_identity");
  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
});

test("Reconciler preserves workers whose persisted identity lacks exact precision", async () => {
  for (const precision of [undefined, "coarse"] as const) {
    const hubRoot = await tempRoot(`reconciler-${precision || "missing"}-precision-worker`);
    const workerStore = new WorkerStore(hubRoot);
    await workerStore.init();
    const processIdentity = identity(8484, `${precision || "missing"}-precision`);
    if (precision === undefined) delete processIdentity.birthIdPrecision;
    else processIdentity.birthIdPrecision = precision;
    const workerId = `w-reconciler-${precision || "missing"}`;
    await writeFile(path.join(workerStore.registryDir, `worker-${workerId}.json`), `${JSON.stringify({
      workerId,
      projectId: "p",
      pid: processIdentity.pid,
      host: "local",
      status: "running",
      incarnationToken: "worker-incarnation",
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      processIdentity,
    })}\n`, "utf8");
    const reconciler = new Reconciler(hubRoot, {
      assignmentStore: {} as never,
      workerStore,
      leaderLock: { stillHeld: async () => true },
      failureRouter: { route: async () => ({}), resetBudget: () => undefined },
      workerSupervisor: null,
    });

    await reconciler.reconcileWorkers();

    const worker = await workerStore.getWorker(workerId);
    assert.equal(worker?.status, "unhealthy");
    assert.equal(worker?.recoveryError, "missing_process_identity");
    await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
  }
});
