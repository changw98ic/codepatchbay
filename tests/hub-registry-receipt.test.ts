import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  compensateProjectRegistration,
  cmdStop,
  hubRegistryCommitOutcome,
  isHubRegistryCommittedError,
  isHubRegistryCommitUnknownError,
  loadRegistry,
  mutateRegistry,
  readHubLiveness,
  registerProject,
  registerProjectWithReceipt,
  runHubControlPlaneStopSequence,
  saveRegistry,
  startHubControlPlane,
  stopOrchestratorDuringHubStop,
  stopExpectedControlPlaneProcess,
  updateProject,
  withHubRegistryTestHooks,
  type HubControlPlaneKind,
  type HubControlPlaneSpawnSpec,
  type HubControlPlaneStartOptions,
  type HubControlPlaneStartRuntime,
} from "../server/services/hub/hub-registry.js";
import { sameProcessIdentity, type ProcessIdentity, type ProcessTreeSystem } from "../core/runtime/process-tree.js";
import { recordValue } from "../shared/types.js";

async function temporaryDirectory(t: TestContext, prefix: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t: TestContext) {
  return {
    hubRoot: await temporaryDirectory(t, "cpb-hub-registry-receipt-"),
    sourcePath: await temporaryDirectory(t, "cpb-hub-registry-source-"),
  };
}

function identity(pid: number, birthId: string): ProcessIdentity {
  return {
    pid,
    birthId,
    birthIdPrecision: "exact",
    incarnation: `${pid}:${birthId}`,
    capturedAt: "2026-07-20T00:00:00.000Z",
  };
}

function fakeSystem(current: ProcessIdentity | null, killError?: NodeJS.ErrnoException): ProcessTreeSystem {
  return {
    platform: "darwin",
    spawnSync: (() => ({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 1,
      signal: null,
    })) as unknown as ProcessTreeSystem["spawnSync"],
    kill(pid: number) {
      if (killError) throw killError;
      if (!current || current.pid !== pid) {
        throw Object.assign(new Error("missing"), { code: "ESRCH" });
      }
      return true;
    },
    captureIdentity(pid: number) {
      return current && current.pid === pid ? current : null;
    },
  };
}

function startOptions(hubRoot: string, cpbRoot: string, overrides: Partial<HubControlPlaneStartOptions> = {}) {
  return {
    cpbRoot,
    executorRoot: cpbRoot,
    hubRoot,
    port: "3456",
    host: "127.0.0.1",
    hubEnv: {},
    controlEnv: {},
    readinessAttempts: 2,
    readinessIntervalMs: 0,
    hostname: "test-host",
    ...overrides,
  } satisfies HubControlPlaneStartOptions;
}

function delegateReceipt(
  processIdentity: ProcessIdentity,
  ownerToken: string,
  generation = "generation-1",
  hubRoot = "/tmp/test-hub",
) {
  return {
    pid: processIdentity.pid,
    hubRoot,
    startedAt: "2026-07-20T00:00:00.000Z",
    ownerToken,
    generation,
    processIdentity,
    incarnation: processIdentity.incarnation,
  };
}

function completeStartRuntime(
  overrides: Partial<HubControlPlaneStartRuntime> = {},
): HubControlPlaneStartRuntime {
  const identities = new Map<number, ProcessIdentity>();
  const alive = new Set<number>();
  let orchestratorSpec: HubControlPlaneSpawnSpec | null = null;
  let delegateSpec: HubControlPlaneSpawnSpec | null = null;
  const pidFor = { hub: 41001, orchestrator: 41002, "quota-delegate": 41003 } satisfies Record<HubControlPlaneKind, number>;
  const runtime: HubControlPlaneStartRuntime = {
    async spawnProcess(spec) {
      const pid = pidFor[spec.kind];
      const processIdentity = identity(pid, spec.kind);
      identities.set(pid, processIdentity);
      alive.add(pid);
      if (spec.kind === "orchestrator") orchestratorSpec = spec;
      if (spec.kind === "quota-delegate") delegateSpec = spec;
      return pid;
    },
    captureIdentity(pid) {
      return identities.get(pid) || null;
    },
    identityAlive(processIdentity) {
      return alive.has(processIdentity.pid)
        && identities.get(processIdentity.pid)?.incarnation === processIdentity.incarnation;
    },
    async stopProcess(_kind, pid) {
      alive.delete(pid);
    },
    async readHubLiveness() {
      const processIdentity = identities.get(pidFor.hub);
      return processIdentity && alive.has(pidFor.hub)
        ? { alive: true, pid: pidFor.hub, processIdentity }
        : { alive: false, reason: "process-gone" };
    },
    async readOrchestratorStatus() {
      if (!orchestratorSpec || !alive.has(pidFor.orchestrator)) return { status: "stopped" };
      const token = orchestratorSpec.env.CPB_ORCHESTRATOR_START_TOKEN;
      return {
        status: "running",
        ready: true,
        readyAt: "2026-07-20T00:00:01.000Z",
        pid: pidFor.orchestrator,
        hubId: `test-host-${pidFor.orchestrator}-${token}`,
        processIdentity: identities.get(pidFor.orchestrator),
        lockToken: "orchestrator-lock-token",
        epoch: 1,
      };
    },
    async readDelegateReceipt(hubRoot) {
      if (!delegateSpec || !alive.has(pidFor["quota-delegate"])) return null;
      const ownerIndex = delegateSpec.args.indexOf("--owner-token");
      const ownerToken = delegateSpec.args[ownerIndex + 1];
      return delegateReceipt(identities.get(pidFor["quota-delegate"])!, ownerToken, "generation-1", hubRoot);
    },
    async writeOrchestratorState() {},
    async sleep() {},
    log() {},
  };
  return { ...runtime, ...overrides };
}

async function writeHubState(hubRoot: string, record: Record<string, unknown>) {
  await mkdir(path.join(hubRoot, "state"), { recursive: true });
  await writeFile(path.join(hubRoot, "state", "hub.json"), `${JSON.stringify(record, null, 2)}\n`);
}

test("readHubLiveness distinguishes the recorded hub incarnation from a successor", async (t) => {
  const { hubRoot } = await fixture(t);
  const original = identity(12345, "original");
  const successor = identity(12345, "successor");
  await writeHubState(hubRoot, {
    pid: original.pid,
    processIdentity: original,
    startedAt: "2026-07-20T00:00:00.000Z",
    version: "test",
    runtime: "node",
    health: "alive",
  });

  const liveness = await readHubLiveness(hubRoot, { system: fakeSystem(successor) });

  assert.equal(liveness.alive, false);
  assert.equal(liveness.reason, "process-reused");
  assert.deepEqual(liveness.processIdentity, original);
  assert.deepEqual(liveness.successorIdentity, successor);
});

test("readHubLiveness fails closed on EPERM instead of classifying a hub owner as stale", async (t) => {
  const { hubRoot } = await fixture(t);
  const original = identity(23456, "original");
  await writeHubState(hubRoot, {
    pid: original.pid,
    processIdentity: original,
    startedAt: "2026-07-20T00:00:00.000Z",
    version: "test",
    runtime: "node",
    health: "alive",
  });

  const liveness = await readHubLiveness(hubRoot, {
    system: fakeSystem(original, Object.assign(new Error("permission denied"), { code: "EPERM" })),
  });

  assert.equal(liveness.alive, true);
  assert.equal(liveness.reason, "liveness-unknown");
  assert.equal(liveness.pid, original.pid);
});

test("readHubLiveness treats corrupt and symlinked hub state as unsafe live state", async (t) => {
  const { hubRoot } = await fixture(t);
  await mkdir(path.join(hubRoot, "state"), { recursive: true });
  await writeFile(path.join(hubRoot, "state", "hub.json"), "{bad json");

  const corrupt = await readHubLiveness(hubRoot, { system: fakeSystem(null) });

  assert.equal(corrupt.alive, true);
  assert.equal(corrupt.reason, "unsafe-state");

  const symlinkRoot = await temporaryDirectory(t, "cpb-hub-registry-symlink-state-");
  await mkdir(path.join(symlinkRoot, "state"), { recursive: true });
  await writeFile(path.join(symlinkRoot, "target.json"), "{}");
  await symlink(path.join(symlinkRoot, "target.json"), path.join(symlinkRoot, "state", "hub.json"));

  const unsafe = await readHubLiveness(symlinkRoot, { system: fakeSystem(null) });

  assert.equal(unsafe.alive, true);
  assert.equal(unsafe.reason, "unsafe-state");
});

test("cmdStop attempts the full shutdown sequence but refuses pid-only hub signalling", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  await writeHubState(hubRoot, {
    pid: 34567,
    startedAt: "2026-07-20T00:00:00.000Z",
    version: "legacy",
    runtime: "node",
    health: "alive",
  });
  const previousRoot = process.env.CPB_ROOT;
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  process.env.CPB_ROOT = sourcePath;
  process.env.CPB_HUB_ROOT = hubRoot;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.CPB_ROOT;
    else process.env.CPB_ROOT = previousRoot;
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
  });

  await assert.rejects(
    () => cmdStop(),
    (error: unknown) => {
      const aggregate = error as AggregateError & { code?: string };
      const hubFailure = aggregate.errors?.find((entry) => (
        (entry as { component?: string }).component === "hub"
      )) as (Error & { cause?: { code?: string } }) | undefined;
      return aggregate.code === "HUB_CONTROL_PLANE_STOP_FAILED"
        && hubFailure?.cause?.code === "HUB_CONTROL_PLANE_STATE_INVALID";
    },
  );
});

test("hub startup aggregates identity-capture and awaited cleanup failures", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  let cleanupAttempted = false;
  const runtime = completeStartRuntime({
    async spawnProcess() {
      return 42001;
    },
    captureIdentity() {
      return null;
    },
    async stopProcess(kind, pid) {
      cleanupAttempted = true;
      assert.equal(kind, "hub");
      assert.equal(pid, 42001);
      throw Object.assign(new Error("injected cleanup failure"), { code: "EIO" });
    },
  });

  let failure: unknown;
  await startHubControlPlane(startOptions(hubRoot, sourcePath), runtime)
    .catch((error: unknown) => { failure = error; });

  assert.equal(cleanupAttempted, true);
  assert.ok(failure instanceof AggregateError);
  assert.equal((failure as { code?: string }).code, "HUB_START_AND_CLEANUP_FAILED");
  assert.equal(((failure as AggregateError).errors[0] as { code?: string }).code, "HUB_START_IDENTITY_UNAVAILABLE");
  assert.equal(((failure as AggregateError).errors[1] as { code?: string }).code, "EIO");
});

test("hub control-plane launcher uses the existing nested orchestrator route", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const base = completeStartRuntime();
  let orchestratorSpec: HubControlPlaneSpawnSpec | null = null;
  const runtime: HubControlPlaneStartRuntime = {
    ...base,
    async spawnProcess(spec) {
      if (spec.kind === "orchestrator") orchestratorSpec = spec;
      return await base.spawnProcess(spec);
    },
  };

  await startHubControlPlane(startOptions(hubRoot, sourcePath), runtime);

  assert.ok(orchestratorSpec);
  assert.deepEqual(orchestratorSpec.args, [
    path.join(sourcePath, "cli", "cpb.js"),
    "hub",
    "orch",
    "start",
  ]);
  assert.match(orchestratorSpec.env.CPB_ORCHESTRATOR_START_TOKEN || "", /^[0-9a-f-]{36}$/i);
});

test("orchestrator identity-capture failure cleans raw child and hub without suppressing cleanup errors", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const base = completeStartRuntime();
  const stopped: HubControlPlaneKind[] = [];
  const runtime = completeStartRuntime({
    spawnProcess: base.spawnProcess,
    captureIdentity(pid) {
      return pid === 41002 ? null : base.captureIdentity(pid);
    },
    identityAlive: base.identityAlive,
    readHubLiveness: base.readHubLiveness,
    async stopProcess(kind, pid, processIdentity) {
      stopped.push(kind);
      if (kind === "orchestrator") {
        assert.equal(processIdentity, undefined, "failed capture must still clean the raw spawned pid");
        throw Object.assign(new Error("raw orchestrator cleanup failed"), { code: "EIO" });
      }
      await base.stopProcess(kind, pid, processIdentity);
    },
  });

  let failure: unknown;
  await startHubControlPlane(startOptions(hubRoot, sourcePath), runtime)
    .catch((error: unknown) => { failure = error; });

  assert.deepEqual(stopped, ["orchestrator", "hub"]);
  assert.ok(failure instanceof AggregateError);
  assert.equal(((failure as AggregateError).errors[0] as { code?: string }).code, "HUB_START_IDENTITY_UNAVAILABLE");
  assert.equal(((failure as AggregateError).errors[1] as { code?: string }).code, "EIO");
});

test("hub startup timeout awaits exact-incarnation cleanup before rejecting", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const hubIdentity = identity(43001, "hub-timeout");
  let cleanupFinished = false;
  const runtime = completeStartRuntime({
    async spawnProcess(spec) {
      assert.equal(spec.kind, "hub");
      return hubIdentity.pid;
    },
    captureIdentity(pid) {
      return pid === hubIdentity.pid ? hubIdentity : null;
    },
    identityAlive(processIdentity) {
      return processIdentity.incarnation === hubIdentity.incarnation;
    },
    async readHubLiveness() {
      return { alive: false, reason: "no-hub-json" };
    },
    async stopProcess(kind, pid, processIdentity) {
      assert.equal(kind, "hub");
      assert.equal(pid, hubIdentity.pid);
      assert.deepEqual(processIdentity, hubIdentity);
      await Promise.resolve();
      cleanupFinished = true;
    },
  });

  await assert.rejects(
    () => startHubControlPlane(startOptions(hubRoot, sourcePath, { readinessAttempts: 1 }), runtime),
    (error: unknown) => {
      assert.equal(cleanupFinished, true, "startup must await teardown before rejection");
      return (error as { code?: string }).code === "HUB_START_TIMEOUT";
    },
  );
});

test("orchestrator readiness is mandatory and rollback attempts every started process", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const stopped: HubControlPlaneKind[] = [];
  const base = completeStartRuntime();
  const runtime = completeStartRuntime({
    async readOrchestratorStatus() {
      return { status: "stopped" };
    },
    async stopProcess(kind, pid, processIdentity) {
      stopped.push(kind);
      if (kind === "hub") throw Object.assign(new Error("hub cleanup failed"), { code: "EIO" });
      await base.stopProcess(kind, pid, processIdentity);
    },
  });

  let failure: unknown;
  await startHubControlPlane(
    startOptions(hubRoot, sourcePath, { readinessAttempts: 1 }),
    runtime,
  ).catch((error: unknown) => { failure = error; });

  assert.deepEqual(stopped, ["orchestrator", "hub"]);
  assert.ok(failure instanceof AggregateError);
  assert.equal((failure as { code?: string }).code, "HUB_START_AND_CLEANUP_FAILED");
  assert.equal(((failure as AggregateError).errors[0] as { code?: string }).code, "HUB_ORCHESTRATOR_START_TIMEOUT");
  assert.equal(((failure as AggregateError).errors[1] as { code?: string }).code, "EIO");
});

test("an acquired orchestrator lease is not ready until the initialization receipt is published", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const base = completeStartRuntime();
  let orchestratorSpec: HubControlPlaneSpawnSpec | null = null;
  const runtime: HubControlPlaneStartRuntime = {
    ...base,
    async spawnProcess(spec) {
      if (spec.kind === "orchestrator") orchestratorSpec = spec;
      return await base.spawnProcess(spec);
    },
    async readOrchestratorStatus() {
      const processIdentity = base.captureIdentity(41002);
      if (!processIdentity || !base.identityAlive(processIdentity)) return { status: "stopped" };
      assert.ok(orchestratorSpec);
      return {
        status: "running",
        ready: false,
        pid: processIdentity.pid,
        processIdentity,
        hubId: `test-host-${processIdentity.pid}-${orchestratorSpec.env.CPB_ORCHESTRATOR_START_TOKEN}`,
        lockToken: "lease-only-token",
        epoch: 1,
      };
    },
  };

  await assert.rejects(
    () => startHubControlPlane(
      startOptions(hubRoot, sourcePath, { readinessAttempts: 1 }),
      runtime,
    ),
    { code: "HUB_ORCHESTRATOR_START_TIMEOUT" },
  );
});

test("quota delegate readiness is bound to spawned identity, owner token, and generation", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const base = completeStartRuntime();
  const wrongIdentity = identity(44004, "stale-delegate");
  let delegateReads = 0;
  let delegateSpec: HubControlPlaneSpawnSpec | null = null;
  const runtime = completeStartRuntime({
    async spawnProcess(spec) {
      if (spec.kind === "quota-delegate") delegateSpec = spec;
      return await base.spawnProcess(spec);
    },
    captureIdentity: base.captureIdentity,
    identityAlive(processIdentity) {
      if (sameProcessIdentity(processIdentity, wrongIdentity)) return false;
      return base.identityAlive(processIdentity);
    },
    readHubLiveness: base.readHubLiveness,
    readOrchestratorStatus: base.readOrchestratorStatus,
    async readDelegateReceipt(root) {
      delegateReads += 1;
      if (delegateReads === 1) return null;
      if (delegateReads === 2) return delegateReceipt(wrongIdentity, "stale-owner", "stale-generation", root);
      assert.ok(delegateSpec);
      const ownerIndex = delegateSpec.args.indexOf("--owner-token");
      const ownerToken = delegateSpec.args[ownerIndex + 1];
      const spawned = base.captureIdentity(41003)!;
      return delegateReceipt(spawned, ownerToken, "spawned-generation", root);
    },
  });

  const result = await startHubControlPlane(startOptions(hubRoot, sourcePath), runtime);

  assert.equal(result.delegateReceipt.generation, "spawned-generation");
  assert.equal(result.delegateReceipt.processIdentity.incarnation, "41003:quota-delegate");
  assert.equal(delegateSpec?.args.includes("--owner-token"), true);
});

test("quota delegate readiness timeout fails startup and rolls back all new control processes", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const base = completeStartRuntime();
  const stopped: HubControlPlaneKind[] = [];
  const runtime: HubControlPlaneStartRuntime = {
    ...base,
    async readDelegateReceipt() {
      return null;
    },
    async stopProcess(kind, pid, processIdentity) {
      stopped.push(kind);
      await base.stopProcess(kind, pid, processIdentity);
    },
  };

  await assert.rejects(
    () => startHubControlPlane(
      startOptions(hubRoot, sourcePath, { readinessAttempts: 1 }),
      runtime,
    ),
    { code: "HUB_QUOTA_DELEGATE_START_TIMEOUT" },
  );
  assert.deepEqual(stopped, ["quota-delegate", "orchestrator", "hub"]);
});

test("hub stop sequence runs orchestrator first, hub last, and aggregates every component failure", async () => {
  const order: string[] = [];
  let failure: unknown;
  await runHubControlPlaneStopSequence([
    { name: "orchestrator", code: "ORCH", run: async () => { order.push("orchestrator"); throw new Error("orch failed"); } },
    { name: "workers", code: "WORKERS", run: async () => { order.push("workers"); } },
    { name: "queue", code: "QUEUE", run: async () => { order.push("queue"); throw new Error("queue failed"); } },
    { name: "jobs-index", code: "INDEX", run: async () => { order.push("jobs-index"); throw new Error("index failed"); } },
    { name: "delegate", code: "DELEGATE", run: async () => { order.push("delegate"); } },
    { name: "hub", code: "HUB", run: async () => { order.push("hub"); } },
  ]).catch((error: unknown) => { failure = error; });

  assert.deepEqual(order, ["orchestrator", "workers", "queue", "jobs-index", "delegate", "hub"]);
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(
    (failure as AggregateError).errors.map((error) => (error as { code?: string }).code),
    ["ORCH", "QUEUE", "INDEX"],
  );
});

test("orchestrator stop preserves a successor runtime state published during cleanup", async (t) => {
  const { hubRoot } = await fixture(t);
  const original = identity(44501, "original-orchestrator");
  const successor = identity(44502, "successor-orchestrator");
  const statePath = path.join(hubRoot, "state", "orchestrator.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({
    pid: original.pid,
    processIdentity: original,
    hubId: "original-hub-id",
    startupToken: "original-token",
  })}\n`);

  await stopOrchestratorDuringHubStop(hubRoot, {
    async stopExpected(_label, processIdentity) {
      assert.deepEqual(processIdentity, original);
      await writeFile(statePath, `${JSON.stringify({
        pid: successor.pid,
        processIdentity: successor,
        hubId: "successor-hub-id",
        startupToken: "successor-token",
      })}\n`);
      return true;
    },
    async readStatus() {
      return {
        status: "running",
        pid: successor.pid,
        hubId: "successor-hub-id",
        processIdentity: successor,
      };
    },
    async sleep() {},
  });

  const preserved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(preserved.hubId, "successor-hub-id");
  assert.deepEqual(preserved.processIdentity, successor);
});

test("exact-incarnation stop preserves a PID successor and propagates EPERM", async () => {
  const original = identity(45001, "original");
  const successor = identity(45001, "successor");
  const successorSignals: Array<string | number> = [];
  const successorSystem = fakeSystem(successor);
  successorSystem.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    successorSignals.push(signal ?? 0);
    if (pid !== successor.pid) throw Object.assign(new Error("missing"), { code: "ESRCH" });
    return true;
  }) as typeof process.kill;

  assert.equal(await stopExpectedControlPlaneProcess("hub", original, { system: successorSystem }), false);
  assert.deepEqual(successorSignals, [0], "successor must only receive the liveness probe, never a stop signal");

  const epermSignals: Array<string | number> = [];
  const epermSystem = fakeSystem(original);
  epermSystem.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    epermSignals.push(signal ?? 0);
    throw Object.assign(new Error(`permission denied for ${pid}`), { code: "EPERM" });
  }) as typeof process.kill;
  await assert.rejects(
    () => stopExpectedControlPlaneProcess("hub", original, { system: epermSystem }),
    { code: "EPERM" },
  );
  assert.deepEqual(epermSignals, [0]);
});

test("project registration receipt is JSON-normalized, immutable, and generation fenced", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const metadata = {
    nested: { label: "committed" },
    list: ["kept", undefined],
    dropMe: undefined,
  };
  const result = await registerProjectWithReceipt(hubRoot, {
    id: "receipt-new",
    sourcePath,
    metadata,
    skipCodeGraphGate: true,
  });

  metadata.nested.label = "input-mutated";
  recordValue(recordValue(result.project.metadata).nested).label = "project-mutated";
  assert.throws(() => {
    recordValue(recordValue(result.receipt.committedProject.metadata).nested).label = "receipt-mutated";
  }, TypeError);

  const registry = await loadRegistry(hubRoot);
  const committedMetadata = recordValue(registry.projects["receipt-new"].metadata);
  assert.deepEqual(result.commitWarnings, []);
  assert.equal(result.receipt.committedProjectRevision, registry.projectRevisions["receipt-new"]);
  assert.equal(recordValue(committedMetadata.nested).label, "committed");
  assert.equal(Object.hasOwn(committedMetadata, "dropMe"), false);
  assert.deepEqual(committedMetadata.list, ["kept", null]);
  assert.deepEqual(recordValue(result.receipt.committedProject.metadata).list, ["kept", null]);

  await compensateProjectRegistration(hubRoot, result.receipt);
  const compensated = await loadRegistry(hubRoot);
  assert.equal(Object.hasOwn(compensated.projects, "receipt-new"), false);
  assert.equal(
    compensated.projectRevisions["receipt-new"],
    result.receipt.committedProjectRevision + 1,
    "deletion must retain an advanced project tombstone revision",
  );
});

test("project registration compensation restores a cloned previous project", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  await registerProjectWithReceipt(hubRoot, {
    id: "receipt-existing",
    sourcePath,
    metadata: { nested: { label: "previous" }, stable: true },
    skipCodeGraphGate: true,
  });

  const updateMetadata = { nested: { label: "updated" }, added: { value: "new" } };
  const update = await registerProjectWithReceipt(hubRoot, {
    id: "receipt-existing",
    sourcePath,
    metadata: updateMetadata,
    skipCodeGraphGate: true,
  });

  updateMetadata.nested.label = "input-mutated";
  recordValue(recordValue(update.project.metadata).nested).label = "project-mutated";
  assert.throws(() => {
    recordValue(recordValue(update.receipt.previousProject?.metadata).nested).label = "previous-mutated";
  }, TypeError);

  await compensateProjectRegistration(hubRoot, update.receipt);
  const registry = await loadRegistry(hubRoot);
  const restoredMetadata = recordValue(registry.projects["receipt-existing"].metadata);
  assert.equal(recordValue(restoredMetadata.nested).label, "previous");
  assert.equal(restoredMetadata.stable, true);
  assert.equal(Object.hasOwn(restoredMetadata, "added"), false);
  assert.equal(registry.projectRevisions["receipt-existing"], update.receipt.committedProjectRevision + 1);
});

test("an unrelated project update does not block registration compensation", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const otherSource = await temporaryDirectory(t, "cpb-hub-registry-other-source-");
  const registration = await registerProjectWithReceipt(hubRoot, {
    id: "compensated-project",
    sourcePath,
    skipCodeGraphGate: true,
  });
  await registerProjectWithReceipt(hubRoot, {
    id: "unrelated-project",
    sourcePath: otherSource,
    skipCodeGraphGate: true,
  });
  await updateProject(hubRoot, "unrelated-project", { metadata: { advanced: true } });

  const beforeCompensation = await loadRegistry(hubRoot);
  assert.ok(beforeCompensation.revision > registration.receipt.committedProjectRevision);
  assert.equal(
    beforeCompensation.projectRevisions["compensated-project"],
    registration.receipt.committedProjectRevision,
  );

  await compensateProjectRegistration(hubRoot, registration.receipt);
  const afterCompensation = await loadRegistry(hubRoot);
  assert.equal(afterCompensation.projects["compensated-project"], undefined);
  assert.equal(afterCompensation.projects["unrelated-project"].metadata?.advanced, true);
});

test("saveRegistry advances only project revisions whose values changed", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const otherSource = await temporaryDirectory(t, "cpb-hub-registry-save-source-");
  await registerProjectWithReceipt(hubRoot, {
    id: "saved-project",
    sourcePath,
    skipCodeGraphGate: true,
  });
  await registerProjectWithReceipt(hubRoot, {
    id: "saved-unrelated",
    sourcePath: otherSource,
    skipCodeGraphGate: true,
  });
  const snapshot = await loadRegistry(hubRoot);
  const changedRevision = snapshot.projectRevisions["saved-project"];
  const unrelatedRevision = snapshot.projectRevisions["saved-unrelated"];
  snapshot.projects["saved-project"].metadata = { saved: true };
  await saveRegistry(hubRoot, snapshot);

  const persisted = await loadRegistry(hubRoot);
  assert.equal(persisted.projectRevisions["saved-project"], changedRevision + 1);
  assert.equal(persisted.projectRevisions["saved-unrelated"], unrelatedRevision);
});

test("post-rename durability failure returns a blocking committed warning and typed outcome", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  let injected = false;
  const result = await withHubRegistryTestHooks({
    afterAtomicRename(filePath) {
      if (path.basename(filePath) !== "projects.json" || injected) return;
      injected = true;
      throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
    },
  }, () => registerProjectWithReceipt(hubRoot, {
    id: "post-rename",
    sourcePath,
    metadata: { nested: { label: "committed" } },
    skipCodeGraphGate: true,
  }));

  assert.equal(result.commitWarnings.length, 1);
  assert.equal(result.commitWarnings[0].requiresAction, "fail-or-compensate");
  assert.equal(result.commitWarnings[0].committedRegistry.mutationId, result.commitWarnings[0].mutationId);
  assert.doesNotThrow(() => JSON.stringify(result.commitWarnings));
  const registry = await loadRegistry(hubRoot);
  assert.equal(recordValue(registry.projects["post-rename"].metadata?.nested).label, "committed");
  assert.equal(result.receipt.committedProjectRevision, registry.projectRevisions["post-rename"]);

  const ordinarySource = await temporaryDirectory(t, "cpb-hub-registry-ordinary-source-");
  let ordinaryInjected = false;
  let failure: unknown;
  await withHubRegistryTestHooks({
    afterAtomicRename(filePath) {
      if (path.basename(filePath) !== "projects.json" || ordinaryInjected) return;
      ordinaryInjected = true;
      throw new Error("ordinary registration durability warning");
    },
  }, () => registerProject(hubRoot, {
    id: "ordinary-warning",
    sourcePath: ordinarySource,
    skipCodeGraphGate: true,
  })).catch((error: unknown) => { failure = error; });

  assert.equal(isHubRegistryCommittedError(failure), true);
  assert.equal(hubRegistryCommitOutcome(failure)?.status, "committed");
  assert.equal((failure as { receipt?: { projectId?: string } }).receipt?.projectId, "ordinary-warning");
});

test("lock release failure returns a blocking warning and does not block the next owner", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const result = await withHubRegistryTestHooks({
    beforeLockReleaseRemove() {
      throw Object.assign(new Error("injected lock release failure"), { code: "EIO" });
    },
  }, () => registerProjectWithReceipt(hubRoot, {
    id: "release-failed",
    sourcePath,
    metadata: { release: "committed" },
    skipCodeGraphGate: true,
  }));

  assert.equal(result.commitWarnings.length, 1);
  assert.equal(result.commitWarnings[0].requiresAction, "fail-or-compensate");
  await assert.rejects(access(path.join(hubRoot, "projects.json.lock")), { code: "ENOENT" });

  const successorSource = await temporaryDirectory(t, "cpb-hub-registry-successor-source-");
  const successor = await registerProjectWithReceipt(hubRoot, {
    id: "release-successor",
    sourcePath: successorSource,
    skipCodeGraphGate: true,
  });
  assert.deepEqual(successor.commitWarnings, []);
  assert.ok((await loadRegistry(hubRoot)).projects["release-successor"]);
});

test("failed release cleanup never removes a successor lock token", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const successorToken = "successor-owner-token";
  const result = await withHubRegistryTestHooks({
    async beforeLockReleaseRemove(lockDir) {
      const lockPath = path.join(lockDir, "lock.json");
      const current = JSON.parse(await readFile(lockPath, "utf8"));
      await writeFile(lockPath, `${JSON.stringify({ ...current, ownerToken: successorToken }, null, 2)}\n`);
      throw new Error("release raced with successor ownership");
    },
  }, () => registerProjectWithReceipt(hubRoot, {
    id: "release-successor-fence",
    sourcePath,
    skipCodeGraphGate: true,
  }));

  assert.equal(result.commitWarnings.length, 1);
  const successor = JSON.parse(await readFile(path.join(hubRoot, "projects.json.lock", "lock.json"), "utf8"));
  assert.equal(successor.ownerToken, successorToken);
});

test("same-value successor write advances the project revision and blocks stale compensation", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  const result = await registerProjectWithReceipt(hubRoot, {
    id: "same-value",
    sourcePath,
    metadata: { stable: true },
    skipCodeGraphGate: true,
  });

  await mutateRegistry(hubRoot, (registry) => {
    registry.projects["same-value"] = JSON.parse(JSON.stringify(result.receipt.committedProject));
  });
  const successor = await loadRegistry(hubRoot);
  assert.equal(
    successor.projectRevisions["same-value"],
    result.receipt.committedProjectRevision + 1,
  );
  assert.deepEqual(successor.projects["same-value"], result.receipt.committedProject);

  await assert.rejects(
    compensateProjectRegistration(hubRoot, result.receipt),
    { code: "HUB_REGISTRY_COMPENSATION_CONFLICT" },
  );
  assert.deepEqual((await loadRegistry(hubRoot)).projects["same-value"], result.receipt.committedProject);
});

test("callback and lock release failures are aggregated while the lock remains recoverable", async (t) => {
  const { hubRoot } = await fixture(t);
  const callbackFailure = new Error("callback failed");
  let failure: unknown;
  await withHubRegistryTestHooks({
    beforeLockReleaseRemove() {
      throw new Error("release failed");
    },
  }, () => mutateRegistry(hubRoot, () => {
    throw callbackFailure;
  })).catch((error: unknown) => { failure = error; });

  assert.ok(failure instanceof AggregateError);
  assert.equal((failure as { code?: string }).code, "HUB_REGISTRY_CALLBACK_AND_RELEASE_FAILED");
  assert.equal((failure as AggregateError).errors[0], callbackFailure);
  assert.equal(((failure as AggregateError).errors[1] as { code?: string }).code, "HUB_REGISTRY_LOCK_RELEASE_FAILED");
  await assert.rejects(access(path.join(hubRoot, "projects.json.lock")), { code: "ENOENT" });
  assert.equal(await mutateRegistry(hubRoot, () => "next-owner"), "next-owner");
});

test("fault hooks are isolated between concurrent async operations", async (t) => {
  const left = await fixture(t);
  const right = await fixture(t);
  let leftRegistryWrites = 0;
  let rightRegistryWrites = 0;
  const [leftResult, rightResult] = await Promise.all([
    withHubRegistryTestHooks({
      afterAtomicRename(filePath) {
        if (path.basename(filePath) !== "projects.json") return;
        assert.equal(filePath.startsWith(left.hubRoot), true);
        leftRegistryWrites += 1;
        throw new Error("left-only post-rename failure");
      },
    }, () => registerProjectWithReceipt(left.hubRoot, {
      id: "left-project",
      sourcePath: left.sourcePath,
      skipCodeGraphGate: true,
    })),
    withHubRegistryTestHooks({
      afterAtomicRename(filePath) {
        if (path.basename(filePath) !== "projects.json") return;
        assert.equal(filePath.startsWith(right.hubRoot), true);
        rightRegistryWrites += 1;
      },
    }, () => registerProjectWithReceipt(right.hubRoot, {
      id: "right-project",
      sourcePath: right.sourcePath,
      skipCodeGraphGate: true,
    })),
  ]);

  assert.equal(leftRegistryWrites, 1);
  assert.equal(rightRegistryWrites, 1);
  assert.equal(leftResult.commitWarnings.length, 1);
  assert.deepEqual(rightResult.commitWarnings, []);
});

test("Redis response loss is confirmed by the persisted mutation id", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  let serialized: string | null = null;
  let compareCalls = 0;
  let readCalls = 0;
  const comparedMutationIds: string[] = [];
  const backend = {
    async readRegistry() {
      readCalls += 1;
      if (readCalls === 2) {
        throw Object.assign(new Error("first confirmation read was lost"), { code: "HUB_STATE_BACKEND_UNAVAILABLE" });
      }
      return serialized;
    },
    async compareAndSwapRegistry(
      expectedRevision: number,
      nextRevision: number,
      nextSerialized: string,
      mutationId = "",
    ) {
      compareCalls += 1;
      comparedMutationIds.push(mutationId);
      const currentRevision = serialized === null ? 0 : Number(JSON.parse(serialized).revision);
      if (currentRevision !== expectedRevision) {
        const currentMutationId = serialized === null ? null : JSON.parse(serialized).mutationId;
        return { committed: currentMutationId === mutationId, revision: currentRevision };
      }
      serialized = nextSerialized;
      return { committed: true, revision: nextRevision };
    },
  };
  const result = await withHubRegistryTestHooks({
    registryBackend: backend,
    afterRedisCompareAndSwap() {
      throw new Error("injected lost Redis CAS response");
    },
  }, async () => {
    const registered = await registerProjectWithReceipt(hubRoot, {
      id: "redis-response-lost",
      sourcePath,
      skipCodeGraphGate: true,
    });
    return { registered, registry: await loadRegistry(hubRoot) };
  });

  assert.equal(compareCalls, 2, "a lost confirmation read should retry the same idempotent mutation");
  assert.equal(comparedMutationIds[0], comparedMutationIds[1]);
  assert.equal(result.registered.commitWarnings.length, 1);
  assert.equal(result.registered.commitWarnings[0].requiresAction, "fail-or-compensate");
  assert.equal(result.registry.mutationId, result.registered.commitWarnings[0].mutationId);
  assert.equal(
    result.registry.projectRevisions["redis-response-lost"],
    result.registered.receipt.committedProjectRevision,
  );
});

test("unconfirmable Redis response loss throws an explicit unknown outcome", async (t) => {
  const { hubRoot, sourcePath } = await fixture(t);
  let reads = 0;
  const backend = {
    async readRegistry() {
      reads += 1;
      if (reads === 1) return null;
      throw Object.assign(new Error("confirmation unavailable"), { code: "HUB_STATE_BACKEND_UNAVAILABLE" });
    },
    async compareAndSwapRegistry() {
      throw Object.assign(new Error("response unavailable"), {
        code: "HUB_STATE_BACKEND_UNAVAILABLE",
        commitOutcome: "unknown",
      });
    },
  };
  let failure: unknown;
  await withHubRegistryTestHooks({ registryBackend: backend }, () => registerProjectWithReceipt(hubRoot, {
    id: "redis-unknown",
    sourcePath,
    skipCodeGraphGate: true,
  })).catch((error: unknown) => { failure = error; });

  assert.equal(isHubRegistryCommitUnknownError(failure), true);
  assert.equal(hubRegistryCommitOutcome(failure)?.status, "unknown");
  assert.equal((failure as { receipt?: { projectId?: string } }).receipt?.projectId, "redis-unknown");
});
