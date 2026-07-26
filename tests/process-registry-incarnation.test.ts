import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { access, link, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test as nodeTest, type TestContext } from "node:test";

import {
  addChildPid,
  getProcess,
  listProcesses,
  PROCESS_REGISTRY_FORMAT_VERSION,
  registerProcess,
  removeProcess,
  runFakeAcpSmoke,
  stopProcess,
  updateHeartbeat,
  withInfraLockTestHooksForTests,
  type InfraLockTestHooks,
} from "../server/services/infra.js";
import type { ProcessIdentity, ProcessTreeSystem } from "../core/runtime/process-tree.js";
import {
  _internalWithTemporaryWorkspaceHooks,
  temporaryWorkspaceErrorDetails,
} from "../core/runtime/temporary-workspace.js";
import { tempRoot } from "./helpers.js";

const infraTestHookScope = new AsyncLocalStorage<InfraLockTestHooks>();

function infraTestHooks() {
  const hooks = infraTestHookScope.getStore();
  if (!hooks) throw new Error("infra hooks require a scoped test");
  return hooks;
}

function test(name: string, fn: (context: TestContext) => void | Promise<void>) {
  return nodeTest(name, (context) => {
    const hooks: InfraLockTestHooks = {};
    return infraTestHookScope.run(
      hooks,
      () => withInfraLockTestHooksForTests(hooks, () => fn(context)),
    );
  });
}

function identity(pid: number, birthId: string): ProcessIdentity {
  return {
    pid,
    birthId,
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-01-01T00:00:00.000Z",
    birthIdPrecision: "exact",
  };
}

function fakeProcessSystem(initial: ProcessIdentity) {
  let current: ProcessIdentity | null = initial;
  let denyLiveness = false;
  const deliveredSignals: Array<{ pid: number; signal: number | NodeJS.Signals }> = [];
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => ({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    })) as unknown as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => current?.pid === pid ? current : null,
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        if (denyLiveness) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        if (!current || Math.abs(pid) !== current.pid) {
          throw Object.assign(new Error("missing"), { code: "ESRCH" });
        }
        return true;
      }
      deliveredSignals.push({ pid, signal: signal || "SIGTERM" });
      if (current && Math.abs(pid) === current.pid) current = null;
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  return {
    system,
    deliveredSignals,
    setCurrent(next: ProcessIdentity | null) {
      current = next;
    },
    setDenyLiveness(value: boolean) {
      denyLiveness = value;
    },
  };
}

async function registerFixture(system: ProcessTreeSystem) {
  const root = await tempRoot("cpb-process-registry-incarnation");
  const dataRoot = path.join(root, "runtime");
  await registerProcess(root, {
    jobId: "job-1",
    project: "project-1",
    runnerPid: 7001,
    dataRoot,
    processSystem: system,
  });
  return { root, dataRoot: await realpath(dataRoot) };
}

async function withDurabilityFault<T>(fault: string, callback: () => Promise<T>) {
  const hooks = infraTestHookScope.getStore();
  if (!hooks) throw new Error("infra durability fault requires a scoped test");
  const previous = hooks.durabilityFault;
  hooks.durabilityFault = fault;
  try { return await callback(); } finally { hooks.durabilityFault = previous; }
}

test("process registry persists the captured runner incarnation and verifies cleanup before stop", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);

  const registered = await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot });
  assert.deepEqual(registered?.processIdentity, original);

  const result = await stopProcess(fixture.root, "job-1", {
    dataRoot: fixture.dataRoot,
    processSystem: fixtureSystem.system,
    graceMs: 0,
    forceVerifyMs: 0,
  });
  assert.equal(result.stopped, true);
  assert.ok(fixtureSystem.deliveredSignals.length > 0);
  assert.equal((await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }))?.status, "stopped");
});

test("process stop never reports a naturally exited candidate as signaled", async () => {
  const original = identity(7001, "natural-exit");
  let livenessChecks = 0;
  const deliveredSignals: Array<{ pid: number; signal: number | NodeJS.Signals }> = [];
  const system: ProcessTreeSystem = {
    platform: "linux",
    spawnSync: (() => ({ status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null })) as unknown as ProcessTreeSystem["spawnSync"],
    captureIdentity: (pid) => pid === original.pid ? original : null,
    kill: ((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        livenessChecks += 1;
        if (livenessChecks >= 3) throw Object.assign(new Error("natural exit"), { code: "ESRCH" });
        return true;
      }
      deliveredSignals.push({ pid, signal: signal ?? "SIGTERM" });
      return true;
    }) as ProcessTreeSystem["kill"],
  };
  const fixture = await registerFixture(system);

  const result = await stopProcess(fixture.root, "job-1", {
    dataRoot: fixture.dataRoot,
    processSystem: system,
    graceMs: 0,
    forceVerifyMs: 0,
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(result.candidatePids, [original.pid]);
  assert.deepEqual(result.attemptedPids, []);
  assert.deepEqual(result.signaledPids, []);
  assert.deepEqual(result.verifiedStoppedPids, [original.pid]);
  assert.deepEqual(result.signalOutcomeUnknownPids, []);
  assert.deepEqual(deliveredSignals, []);
});

test("process registry refuses a recycled runner PID without changing durable status", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  fixtureSystem.setCurrent(identity(7001, "successor"));

  await assert.rejects(
    stopProcess(fixture.root, "job-1", {
      dataRoot: fixture.dataRoot,
      processSystem: fixtureSystem.system,
      graceMs: 0,
      forceVerifyMs: 0,
    }),
    (error: NodeJS.ErrnoException) => error.code === "PROCESS_IDENTITY_MISMATCH",
  );
  assert.deepEqual(fixtureSystem.deliveredSignals, []);
  assert.equal((await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }))?.status, "running");
});

test("process registry refuses persisted coarse identities without signaling", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  const processFile = path.join(fixture.dataRoot, "processes", "job-1.json");
  const entry = JSON.parse(await readFile(processFile, "utf8"));
  entry.processIdentity = {
    ...entry.processIdentity,
    birthIdPrecision: "coarse",
  };
  await writeFile(processFile, `${JSON.stringify(entry, null, 2)}\n`, "utf8");

  await assert.rejects(
    stopProcess(fixture.root, "job-1", {
      dataRoot: fixture.dataRoot,
      processSystem: fixtureSystem.system,
      graceMs: 0,
      forceVerifyMs: 0,
    }),
    (error: NodeJS.ErrnoException) => error.code === "EPROCESSREGISTRYINVALID",
  );
  assert.deepEqual(fixtureSystem.deliveredSignals, []);
  assert.equal(JSON.parse(await readFile(processFile, "utf8")).status, "running");
});

test("process registry serializes heartbeat and child registration without lost RMW updates", async () => {
  const original = identity(7001, "original");
  const child = identity(7002, "child");
  const fixtureSystem = fakeProcessSystem(original);
  const system: ProcessTreeSystem = {
    ...fixtureSystem.system,
    captureIdentity(pid) {
      if (pid === original.pid) return original;
      if (pid === child.pid) return child;
      return null;
    },
  };
  const fixture = await registerFixture(system);
  const before = (await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }))?.lastHeartbeat;

  await Promise.all([
    updateHeartbeat(fixture.root, "job-1", { dataRoot: fixture.dataRoot }),
    addChildPid(fixture.root, "job-1", child.pid, { dataRoot: fixture.dataRoot, processSystem: system }),
  ]);

  const entry = await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot });
  assert.notEqual(entry?.lastHeartbeat, before);
  assert.deepEqual(entry?.childPids, [child.pid]);
  assert.deepEqual(entry?.childIdentities, [child]);
  assert.equal(entry?.status, "running");
});

test("process registry does not publish stopped when process cleanup cannot be verified", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const stubbornSystem: ProcessTreeSystem = {
    ...fixtureSystem.system,
    kill(pid, signal) {
      if (signal === 0) return fixtureSystem.system.kill(pid, signal);
      fixtureSystem.deliveredSignals.push({ pid, signal: (signal ?? "SIGTERM") as number | NodeJS.Signals });
      return true;
    },
  };
  const fixture = await registerFixture(stubbornSystem);

  await assert.rejects(
    stopProcess(fixture.root, "job-1", {
      dataRoot: fixture.dataRoot,
      processSystem: stubbornSystem,
      graceMs: 0,
      forceVerifyMs: 0,
    }),
    (error: NodeJS.ErrnoException & {
      candidatePids?: unknown;
      attemptedPids?: unknown;
      signaledPids?: unknown;
      verifiedStoppedPids?: unknown;
      signalOutcomeUnknownPids?: unknown;
      statusCommitState?: unknown;
    }) => {
      assert.equal(error.code, "PROCESS_CLEANUP_UNVERIFIED");
      assert.deepEqual(error.candidatePids, [original.pid]);
      assert.deepEqual(error.attemptedPids, [original.pid]);
      assert.deepEqual(error.signaledPids, [original.pid]);
      assert.deepEqual(error.verifiedStoppedPids, []);
      assert.deepEqual(error.signalOutcomeUnknownPids, [original.pid]);
      assert.equal(error.statusCommitState, "not_committed");
      return true;
    },
  );
  assert.equal((await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }))?.status, "running");
});

test("process registry propagates EPERM and never publishes a false stopped outcome", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  fixtureSystem.setDenyLiveness(true);

  await assert.rejects(
    stopProcess(fixture.root, "job-1", {
      dataRoot: fixture.dataRoot,
      processSystem: fixtureSystem.system,
      graceMs: 0,
      forceVerifyMs: 0,
    }),
    (error: NodeJS.ErrnoException) => error.code === "EPERM",
  );
  assert.deepEqual(fixtureSystem.deliveredSignals, []);
  assert.equal((await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }))?.status, "running");
});

test("process registry write reports committed durability ambiguity after publish", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const root = await tempRoot("cpb-process-registry-write-ambiguity");
  const dataRoot = path.join(root, "runtime");

  await assert.rejects(
    withDurabilityFault("after-json-rename:job-1.json", () => registerProcess(root, {
      jobId: "job-1",
      project: "project-1",
      runnerPid: 7001,
      dataRoot,
      processSystem: fixtureSystem.system,
    })),
    (error: NodeJS.ErrnoException) => error.code === "DURABLE_PROCESS_REGISTRY_COMMITTED_DURABILITY_AMBIGUOUS",
  );

  const raw = JSON.parse(await readFile(path.join(dataRoot, "processes", "job-1.json"), "utf8"));
  assert.equal(raw.jobId, "job-1");
  assert.deepEqual(raw.processIdentity, original);
});

test("process stop reports unknown durable status when its committed pathname lineage is lost", async () => {
  const original = identity(7001, "publication-lineage");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  const file = path.join(fixture.dataRoot, "processes", "job-1.json");
  const preserved = path.join(fixture.root, "published-stopped-predecessor.json");
  infraTestHooks().afterJsonPublishRename = async ({ file: publishedFile }) => {
    if (publishedFile !== file) return;
    infraTestHooks().afterJsonPublishRename = undefined;
    const published = JSON.parse(await readFile(publishedFile, "utf8"));
    await rename(publishedFile, preserved);
    await writeFile(publishedFile, `${JSON.stringify({ ...published, status: "running", exitCode: null }, null, 2)}\n`, "utf8");
  };
  try {
    await assert.rejects(
      stopProcess(fixture.root, "job-1", {
        dataRoot: fixture.dataRoot,
        processSystem: fixtureSystem.system,
        graceMs: 0,
        forceVerifyMs: 0,
      }),
      (error: NodeJS.ErrnoException & {
        committed?: unknown;
        committedPath?: unknown;
        lineageLost?: unknown;
        statusCommitted?: unknown;
        statusCommitState?: unknown;
        durableStatus?: unknown;
        signaledPids?: unknown;
        verifiedStoppedPids?: unknown;
      }) => {
        assert.equal(error.committed, true);
        assert.equal(error.committedPath, null);
        assert.equal(error.lineageLost, true);
        assert.equal(error.statusCommitted, null);
        assert.equal(error.statusCommitState, "unknown");
        assert.equal(error.durableStatus, null);
        assert.deepEqual(error.signaledPids, [original.pid]);
        assert.deepEqual(error.verifiedStoppedPids, [original.pid]);
        return true;
      },
    );
  } finally {
    infraTestHooks().afterJsonPublishRename = undefined;
  }
  assert.equal(JSON.parse(await readFile(file, "utf8")).status, "running");
  assert.equal(JSON.parse(await readFile(preserved, "utf8")).status, "stopped");
});

test("process registry removal reports committed durability ambiguity with preserved evidence", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);

  let committedPath = "";
  await assert.rejects(
    withDurabilityFault("after-process-remove:job-1.json", () => removeProcess(fixture.root, "job-1", {
      dataRoot: fixture.dataRoot,
    })),
    (error: NodeJS.ErrnoException & {
      committed?: unknown;
      committedPath?: unknown;
      recoveryPaths?: { quarantine?: unknown };
    }) => {
      assert.equal(error.code, "DURABLE_PROCESS_REGISTRY_REMOVE_COMMITTED_DURABILITY_AMBIGUOUS");
      assert.equal(error.committed, true);
      committedPath = String(error.committedPath);
      assert.equal(error.recoveryPaths?.quarantine, committedPath);
      return true;
    },
  );

  assert.equal(await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }), null);
  assert.equal(JSON.parse(await readFile(committedPath, "utf8")).jobId, "job-1");
});

test("process registry rejects hard-linked entries without modifying either name", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  const file = path.join(fixture.dataRoot, "processes", "job-1.json");
  const alias = path.join(fixture.root, "process-alias.json");
  await link(file, alias);

  await assert.rejects(
    getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "EPROCESSREGISTRYINVALID",
  );
  assert.equal(JSON.parse(await readFile(file, "utf8")).jobId, "job-1");
  assert.equal(JSON.parse(await readFile(alias, "utf8")).jobId, "job-1");
});

test("process registry read rejects a same-job successor swapped after lstat", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  const file = path.join(fixture.dataRoot, "processes", "job-1.json");
  const predecessor = path.join(fixture.root, "process-predecessor.json");
  infraTestHooks().afterProcessEntryLstat = async ({ processFile }) => {
    infraTestHooks().afterProcessEntryLstat = undefined;
    const entry = JSON.parse(await readFile(processFile, "utf8"));
    await rename(processFile, predecessor);
    await writeFile(processFile, `${JSON.stringify({ ...entry, status: "successor" }, null, 2)}\n`, "utf8");
  };
  try {
    await assert.rejects(
      getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }),
      (error: NodeJS.ErrnoException) => error.code === "EPROCESSREGISTRYINVALID",
    );
  } finally {
    infraTestHooks().afterProcessEntryLstat = undefined;
  }
  assert.equal(JSON.parse(await readFile(file, "utf8")).status, "successor");
  assert.equal(JSON.parse(await readFile(predecessor, "utf8")).status, "running");
});

test("process registry removal preserves a successor installed before isolation", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  const file = path.join(fixture.dataRoot, "processes", "job-1.json");
  const predecessor = path.join(fixture.root, "process-predecessor.json");
  infraTestHooks().beforeDurableRemoveRename = async ({ target }) => {
    infraTestHooks().beforeDurableRemoveRename = undefined;
    const entry = JSON.parse(await readFile(target, "utf8"));
    await rename(target, predecessor);
    await writeFile(target, `${JSON.stringify({ ...entry, status: "successor" }, null, 2)}\n`, "utf8");
  };
  try {
    await assert.rejects(
      removeProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }),
      (error: NodeJS.ErrnoException & { successorPreserved?: unknown }) => {
        assert.equal(error.code, "DURABLE_REMOVE_SUCCESSOR_PRESERVED");
        assert.equal(error.successorPreserved, true);
        return true;
      },
    );
  } finally {
    infraTestHooks().beforeDurableRemoveRename = undefined;
  }
  assert.equal(JSON.parse(await readFile(file, "utf8")).status, "successor");
  assert.equal(JSON.parse(await readFile(predecessor, "utf8")).status, "running");
});

test("process registry rejects a symlinked processes directory", async () => {
  const root = await tempRoot("cpb-process-parent-symlink");
  const dataRoot = path.join(root, "runtime");
  const external = path.join(root, "external-processes");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(path.join(external, "job-1.json"), `${JSON.stringify({
    jobId: "job-1",
    status: "external",
  })}\n`, "utf8");
  await symlink(external, path.join(dataRoot, "processes"), "dir");

  await assert.rejects(
    listProcesses(root, { dataRoot }),
    (error: NodeJS.ErrnoException) => error.code === "EPROCESSREGISTRYINVALID",
  );
  assert.equal(JSON.parse(await readFile(path.join(external, "job-1.json"), "utf8")).status, "external");
});

test("process registry rejects a symlink in the supplied dataRoot ancestor chain", async () => {
  const root = await tempRoot("cpb-process-data-root-ancestor");
  const external = path.join(root, "external");
  await mkdir(external, { recursive: true });
  await symlink(external, path.join(root, "linked"), "dir");

  await assert.rejects(
    listProcesses(root, { dataRoot: path.join(root, "linked", "runtime") }),
    (error: NodeJS.ErrnoException) => error.code === "EPROCESSREGISTRYINVALID",
  );
  await assert.rejects(readFile(path.join(external, "runtime", "processes", "job-1.json"), "utf8"));
});

test("process registration rejects invalid explicit runner PIDs before capture or filesystem mutation", async () => {
  const root = await tempRoot("cpb-process-runner-pid-validation");
  const dataRoot = path.join(root, "runtime");
  const original = identity(7001, "runner-pid-validation");
  let captureCalls = 0;
  const fixtureSystem = fakeProcessSystem(original);
  const system: ProcessTreeSystem = {
    ...fixtureSystem.system,
    captureIdentity(pid) {
      captureCalls += 1;
      return pid === original.pid ? original : null;
    },
  };

  for (const runnerPid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "7001", true, null]) {
    await assert.rejects(
      registerProcess(root, {
        jobId: "job-invalid-runner-pid",
        project: "project-1",
        runnerPid: runnerPid as number,
        dataRoot,
        processSystem: system,
      }),
      (error: NodeJS.ErrnoException) => error.code === "PROCESS_PID_INVALID",
    );
  }
  assert.equal(captureCalls, 0);
  assert.deepEqual(fixtureSystem.deliveredSignals, []);
  await assert.rejects(access(dataRoot));
});

test("child registration rejects invalid PIDs before capture, locking, or record mutation", async () => {
  const original = identity(7001, "child-pid-validation");
  const fixtureSystem = fakeProcessSystem(original);
  let captureCalls = 0;
  const system: ProcessTreeSystem = {
    ...fixtureSystem.system,
    captureIdentity(pid) {
      captureCalls += 1;
      return pid === original.pid ? original : null;
    },
  };
  const fixture = await registerFixture(system);
  captureCalls = 0;
  const file = path.join(fixture.dataRoot, "processes", "job-1.json");
  const before = await readFile(file, "utf8");

  for (const childPid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, "7002", true, null]) {
    await assert.rejects(
      addChildPid(fixture.root, "job-1", childPid as number, {
        dataRoot: fixture.dataRoot,
        processSystem: system,
      }),
      (error: NodeJS.ErrnoException) => error.code === "PROCESS_PID_INVALID",
    );
  }
  assert.equal(captureCalls, 0);
  assert.equal(await readFile(file, "utf8"), before);
  assert.deepEqual(fixtureSystem.deliveredSignals, []);
});

test("process stop timing rejects infinite, negative, fractional, and oversized waits before signaling", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  const invalidOptions = [
    { graceMs: Number.POSITIVE_INFINITY, forceVerifyMs: 0 },
    { graceMs: -1, forceVerifyMs: 0 },
    { graceMs: 1.5, forceVerifyMs: 0 },
    { graceMs: 0, forceVerifyMs: Number.NaN },
    { graceMs: 0, forceVerifyMs: 300_001 },
  ];

  for (const timing of invalidOptions) {
    await assert.rejects(
      stopProcess(fixture.root, "job-1", {
        dataRoot: fixture.dataRoot,
        processSystem: fixtureSystem.system,
        ...timing,
      }),
      (error: NodeJS.ErrnoException) => error.code === "PROCESS_STOP_TIMING_INVALID",
    );
  }
  assert.deepEqual(fixtureSystem.deliveredSignals, []);
  assert.equal((await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }))?.status, "running");
});

test("process stop refuses to signal when the required audit path is unsafe", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  await writeFile(path.join(fixture.dataRoot, "events"), "not a directory", "utf8");

  await assert.rejects(
    stopProcess(fixture.root, "job-1", {
      dataRoot: fixture.dataRoot,
      processSystem: fixtureSystem.system,
      graceMs: 0,
      forceVerifyMs: 0,
    }),
    (error: NodeJS.ErrnoException & {
      auditType?: unknown;
      statusCommitted?: unknown;
      signaledPids?: unknown;
    }) => {
      assert.equal(error.code, "PROCESS_STOP_AUDIT_FAILED");
      assert.equal(error.auditType, "process_stop_requested");
      assert.equal(error.statusCommitted, false);
      assert.deepEqual(error.signaledPids, []);
      return true;
    },
  );
  assert.deepEqual(fixtureSystem.deliveredSignals, []);
  assert.equal((await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }))?.status, "running");
});

test("post-stop audit failure reports the already committed signal and durable status truth", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  infraTestHooks().beforeProcessAudit = ({ type }) => {
    if (type === "process_stopped") throw new Error("injected final audit failure");
  };
  try {
    await assert.rejects(
      stopProcess(fixture.root, "job-1", {
        dataRoot: fixture.dataRoot,
        processSystem: fixtureSystem.system,
        graceMs: 0,
        forceVerifyMs: 0,
      }),
      (error: NodeJS.ErrnoException & {
        auditType?: unknown;
        statusCommitted?: unknown;
        durableStatus?: unknown;
        signaledPids?: unknown;
      }) => {
        assert.equal(error.code, "PROCESS_STOP_AUDIT_FAILED");
        assert.equal(error.auditType, "process_stopped");
        assert.equal(error.statusCommitted, true);
        assert.equal(error.durableStatus, "stopped");
        assert.deepEqual(error.signaledPids, [original.pid]);
        return true;
      },
    );
  } finally {
    infraTestHooks().beforeProcessAudit = undefined;
  }
  assert.ok(fixtureSystem.deliveredSignals.length > 0);
  assert.equal((await getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }))?.status, "stopped");
});

test("process registry parser requires its versioned exact schema and one-to-one child identities", async () => {
  const original = identity(7001, "original");
  const fixtureSystem = fakeProcessSystem(original);
  const fixture = await registerFixture(fixtureSystem.system);
  const file = path.join(fixture.dataRoot, "processes", "job-1.json");
  const valid = JSON.parse(await readFile(file, "utf8"));
  assert.equal(valid.formatVersion, PROCESS_REGISTRY_FORMAT_VERSION);
  const invalidEntries = [
    { ...valid, formatVersion: undefined },
    { ...valid, formatVersion: PROCESS_REGISTRY_FORMAT_VERSION + 1 },
    { ...valid, processIdentity: undefined },
    { ...valid, runnerPid: String(valid.runnerPid) },
    { ...valid, processIdentity: { ...valid.processIdentity, injected: true } },
    { ...valid, injected: true },
    { ...valid, project: "" },
    { ...valid, status: "mystery" },
    { ...valid, exitCode: 1 },
    { ...valid, childPids: [7002], childIdentities: [] },
    { ...valid, childPids: ["7002"], childIdentities: [identity(7002, "child")] },
    { ...valid, childPids: [7002, 7002], childIdentities: [identity(7002, "child"), identity(7002, "child")] },
    {
      ...valid,
      sessionPin: {
        sessionId: "session-1",
        phase: "execute",
        agentPid: 7003,
        pinnedAt: "2026-01-01T00:00:00.000Z",
        injected: true,
      },
    },
    {
      ...valid,
      sessionPin: {
        sessionId: "session-1",
        phase: "execute",
        agentPid: "7003",
        pinnedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  ];

  for (const invalid of invalidEntries) {
    await writeFile(file, `${JSON.stringify(invalid, null, 2)}\n`, "utf8");
    await assert.rejects(
      getProcess(fixture.root, "job-1", { dataRoot: fixture.dataRoot }),
      (error: NodeJS.ErrnoException) => error.code === "EPROCESSREGISTRYINVALID",
    );
  }
});

test("fake ACP smoke cleanup preserves a hostile same-path workspace successor", async () => {
  let originalRoot = "";
  let successorRoot = "";
  let failure: unknown;
  try {
    await assert.rejects(
      _internalWithTemporaryWorkspaceHooks({
        async afterOwnershipValidated({ rootPath }) {
          if (!path.basename(rootPath).startsWith("cpb-local-smoke-")) return;
          successorRoot = rootPath;
          originalRoot = `${rootPath}.owned-predecessor`;
          await rename(rootPath, originalRoot);
          await mkdir(rootPath);
          await writeFile(path.join(rootPath, "successor-marker.txt"), "preserve successor\n", "utf8");
        },
      }, () => runFakeAcpSmoke()),
      (error: unknown) => {
        failure = error;
        return true;
      },
    );

    const details = temporaryWorkspaceErrorDetails(failure);
    assert.equal(details?.code, "TEMPORARY_WORKSPACE_OWNERSHIP_CONFLICT");
    assert.equal(details?.committed, false);
    assert.equal(details?.disposition, "retained");
    assert.equal(details?.successorPreserved, true);
    assert.equal(details?.recoveryPaths.canonicalRoot, successorRoot);
    assert.equal(
      await readFile(path.join(successorRoot, "successor-marker.txt"), "utf8"),
      "preserve successor\n",
    );

    const outputs = await readdir(path.join(
      originalRoot,
      "hub",
      "projects",
      "local-smoke",
      "wiki",
      "outputs",
    ));
    assert.equal(outputs.some((entry) => /^deliverable-\d+\.md$/.test(entry)), true);
    assert.equal(outputs.some((entry) => /^review-\d+\.md$/.test(entry)), true);
    assert.equal(outputs.some((entry) => /^verdict-\d+\.md$/.test(entry)), true);
  } finally {
    if (successorRoot) await rm(successorRoot, { recursive: true, force: true });
    if (originalRoot) await rm(originalRoot, { recursive: true, force: true });
  }
});
