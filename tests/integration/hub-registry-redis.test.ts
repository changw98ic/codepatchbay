import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type Socket } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import nodeTest, { type TestContext } from "node:test";

import {
  loadRegistry,
  mutateRegistry,
  registerProject,
  saveRegistry,
  updateProject,
} from "../../server/services/hub/hub-registry.js";
import { checkHubStateBackend } from "../../server/services/readiness-checks.js";
import { startHubServer } from "../../server/index.js";
import { openHubRedisStateBackend } from "../../shared/hub-state-redis.js";
import { LeaderLock, readLeaderStatus } from "../../server/orchestrator/leader-lock.js";
import { WorkerSupervisor } from "../../server/orchestrator/worker-supervisor.js";
import { claimEligible, enqueue, listQueue, updateEntry } from "../../server/services/hub/hub-queue.js";
import { WorkerStore } from "../../shared/orchestrator/worker-store.js";
import {
  AssignmentStore,
  withAssignmentStoreTestHooksForTests,
  type AssignmentStoreTestHooks,
} from "../../shared/orchestrator/assignment-store.js";
import { WorkerBrokerClient } from "../../shared/orchestrator/worker-broker-client.js";
import { Reconciler } from "../../server/orchestrator/reconciler.js";
import { acquireLease, readLease, releaseLease, renewLease } from "../../server/services/infra.js";
import { appendEvent, materializeJob, readEvents } from "../../server/services/event/event-store.js";
import { createJob, failJob, getJob, listJobs, startPhase } from "../../server/services/job/job-store.js";
import { createHubBackup, recoverInterruptedHubRestore, restoreHubBackup } from "../../server/services/hub/hub-backup.js";
import { runHubRedisRetention } from "../../server/services/hub/hub-redis-retention.js";
import { openHubAccessAudit, verifyRedisHubAccessAudit } from "../../server/services/audit/hub-access-audit.js";
import {
  exportRedisHubAccessAudit,
  verifyRedisHubAccessAuditExport,
} from "../../server/services/audit/hub-access-audit-redis-export.js";
import {
  _internalWithHubRedisMigrationTestHooksForTests,
  buildLocalRedisMigrationSnapshot,
  hubRedisMigrationJournalPath,
  migrateLocalHubToRedis,
  recoverHubRedisMigration,
} from "../../server/services/hub/hub-redis-migration.js";
import { hubMaintenanceLockPath, hubRestoreJournalPath } from "../../shared/hub-maintenance.js";
import { queueBatchAssignmentAtomically } from "../../scripts/queue-swebench-batch.js";

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

const REDIS_CONFIG_ENV = "CPB_HUB_STATE_REDIS_CONFIG_FILE";
const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const managedWorkerScript = path.join(repoRoot, "runtime", "worker", "managed-worker.js");

function codeOf(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function commandExists(command: string) {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function waitForRedis(port: number, child: ChildProcess) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`redis-server exited with code ${child.exitCode}`);
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(100);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await delay(25);
  }
  throw new Error("redis-server did not become ready");
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    delay(1_000).then(() => false),
  ]);
  if (exited || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(1_000),
  ]);
}

async function startStableRedisProxy(initialTargetPort: number) {
  let targetPort = initialTargetPort;
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port: targetPort });
    sockets.add(client);
    sockets.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    const forget = (socket: Socket) => sockets.delete(socket);
    client.once("close", () => forget(client));
    upstream.once("close", () => forget(upstream));
    client.once("error", () => upstream.destroy());
    upstream.once("error", () => client.destroy());
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
  return {
    port,
    switchTarget(nextPort: number) {
      targetPort = nextPort;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function redisFixture(t: TestContext) {
  if (!await commandExists("redis-server")) {
    t.skip("redis-server is not installed");
    return null;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-redis-"));
  const hubRoot = path.join(root, "hub");
  await mkdir(hubRoot);
  const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-redis-source-"));
  const port = await reservePort();
  const child = spawn("redis-server", [
    "--bind", "127.0.0.1",
    "--protected-mode", "yes",
    "--port", String(port),
    "--save", "",
    "--appendonly", "no",
    "--dir", root,
    "--dbfilename", "state.rdb",
    "--logfile", path.join(root, "redis.log"),
  ], { stdio: "ignore" });
  try {
    await waitForRedis(port, child);
  } catch (error) {
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
    throw error;
  }

  const configFile = path.join(root, "redis-state.json");
  await writeFile(configFile, `${JSON.stringify({
    format: "cpb-hub-state-redis/v1",
    url: `redis://127.0.0.1:${port}/0`,
    registryKey: `cpb:{test-${process.pid}-${port}}:registry`,
    topology: "stable-primary-endpoint",
    connectTimeoutMs: 1_000,
    operationTimeoutMs: 2_000,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(configFile, 0o600);

  const previous = process.env[REDIS_CONFIG_ENV];
  const previousHubRoot = process.env.CPB_HUB_ROOT;
  process.env[REDIS_CONFIG_ENV] = configFile;
  process.env.CPB_HUB_ROOT = hubRoot;
  t.after(async () => {
    if (previous === undefined) delete process.env[REDIS_CONFIG_ENV];
    else process.env[REDIS_CONFIG_ENV] = previous;
    if (previousHubRoot === undefined) delete process.env.CPB_HUB_ROOT;
    else process.env.CPB_HUB_ROOT = previousHubRoot;
    await stopChild(child);
    await rm(root, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  });

  const project = await registerProject(hubRoot, {
    id: "project",
    sourcePath,
    skipCodeGraphGate: true,
  });
  return {
    root,
    hubRoot,
    sourcePath,
    configFile,
    projectId: project.id,
    projectRuntimeRoot: project.projectRuntimeRoot,
    redisProcess: child,
    port,
  };
}

async function migrationCommitMetadataFixture(
  fixture: NonNullable<Awaited<ReturnType<typeof redisFixture>>>,
  name: string,
) {
  const cpbRoot = path.join(fixture.root, name);
  const hubRoot = path.join(cpbRoot, "hub");
  const projectsPath = path.join(hubRoot, "projects.json");
  const registry = `${JSON.stringify({
    version: 1,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: {},
  })}\n`;
  await mkdir(hubRoot, { recursive: true });
  await writeFile(projectsPath, registry, "utf8");

  const configFile = path.join(cpbRoot, "redis-migration.json");
  const baseConfig = JSON.parse(await readFile(fixture.configFile, "utf8"));
  await writeFile(configFile, `${JSON.stringify({
    ...baseConfig,
    registryKey: `cpb:{migration-${randomUUID()}}:registry`,
  })}\n`, { mode: 0o600 });
  await chmod(configFile, 0o600);

  const output = path.join(await realpath(cpbRoot), "migration-output");
  const recoveryPaths = {
    journal: hubRedisMigrationJournalPath(hubRoot),
    snapshot: path.join(output, "redis-logical-snapshot.json"),
    backup: path.join(output, "hub-backup"),
    output,
    result: path.join(output, "migration-result.json"),
  };
  return {
    cpbRoot,
    hubRoot,
    projectsPath,
    registry,
    configFile,
    output,
    recoveryPaths,
    backupSigningKey: "migration-backup-signing-key-1234567890",
  };
}

function isCommittedRedisMigrationFailure(
  error: unknown,
  expectedCode: string | null,
  recoveryPaths: Record<"journal" | "snapshot" | "backup" | "output" | "result", string>,
  committedPath: string | null = null,
) {
  if (!error || typeof error !== "object") return false;
  const typed = error as {
    code?: unknown;
    committed?: unknown;
    committedPath?: unknown;
    redisCommitted?: unknown;
    recoveryPaths?: Record<string, unknown>;
  };
  return (expectedCode === null || typed.code === expectedCode)
    && typed.committed === true
    && typed.committedPath === committedPath
    && typed.redisCommitted === true
    && Object.entries(recoveryPaths).every(([key, value]) => typed.recoveryPaths?.[key] === value);
}

async function runChild(script: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`registry child failed (${code ?? signal}): ${stderr}`));
    });
  });
}

async function runRedisCli(port: number, args: string[]) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("redis-cli", ["-h", "127.0.0.1", "-p", String(port), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`redis-cli failed: ${output}`)));
  });
}

test("Redis SWE-bench batch enqueue saga compensates project assignment and inbox on abort", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-redis-saga-source-"));
  t.after(() => rm(sourcePath, { recursive: true, force: true }));
  const abort = new AbortController();
  const input = {
    entryId: "redis-saga-entry",
    projectId: "redis-saga-project",
    task: "redis saga abort",
    sourcePath,
    workflow: "standard" as const,
    planMode: "full" as const,
    sourceContext: {},
    metadata: {},
  };

  await assert.rejects(
    () => queueBatchAssignmentAtomically({
      hubRoot: fixture.hubRoot,
      workerId: "worker-redis-saga",
      input,
      sourcePath,
      metadata: { productValidation: true },
      skipCodeGraphGate: true,
      signal: abort.signal,
      hooks: {
        afterEnqueue: () => abort.abort(new DOMException("redis saga abort", "AbortError")),
      },
    }),
    /redis saga abort/,
  );

  const registry = await loadRegistry(fixture.hubRoot);
  assert.equal(Object.hasOwn(registry.projects, "redis-saga-project"), false);
  const assignmentStore = new AssignmentStore(fixture.hubRoot);
  await assignmentStore.init();
  assert.equal(await assignmentStore.getAssignment("a-redis-saga-entry"), null);
  const workerStore = new WorkerStore(fixture.hubRoot);
  await workerStore.init();
  assert.deepEqual(await workerStore.readInbox("worker-redis-saga"), []);
});

test("Redis SWE-bench batch enqueue returns stable inbox ref without fake path", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-redis-contract-source-"));
  t.after(() => rm(sourcePath, { recursive: true, force: true }));
  const input = {
    entryId: "redis-contract-entry",
    projectId: "redis-contract-project",
    task: "redis contract enqueue",
    sourcePath,
    workflow: "standard" as const,
    planMode: "full" as const,
    sourceContext: {},
    metadata: {},
  };

  const queued = await queueBatchAssignmentAtomically({
    hubRoot: fixture.hubRoot,
    workerId: "worker-redis-contract",
    input,
    sourcePath,
    metadata: { productValidation: true },
    skipCodeGraphGate: true,
  });

  assert.equal(queued.inboxBackend, "redis");
  assert.equal(queued.inboxPath, null);
  assert.match(queued.inboxRef, /^workerInbox:/);
  const workerStore = new WorkerStore(fixture.hubRoot);
  await workerStore.init();
  const inbox = await workerStore.readInbox("worker-redis-contract");
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].assignmentId, "a-redis-contract-entry");
});

test("Redis assignment and inbox receipts normalize JSON, freeze evidence, and fence same-value successors", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  const assignmentStore = new AssignmentStore(fixture.hubRoot);
  const workerStore = new WorkerStore(fixture.hubRoot);
  await assignmentStore.init();
  await workerStore.init();

  const normalizedAssignment = await assignmentStore.enqueueWithReceipt({
    entryId: "redis-json-normalized",
    projectId: fixture.projectId,
    task: "normalize assignment",
    sourcePath: fixture.sourcePath,
    metadata: { kept: true, omitted: undefined },
  }, { workerId: "worker-redis-json", orchestratorEpoch: 1 });
  assert.equal(Object.hasOwn(normalizedAssignment.assignment.metadata as object, "omitted"), false);
  assert.equal(Object.isFrozen(normalizedAssignment), true);
  assert.equal(Object.isFrozen(normalizedAssignment.committedDocument), true);
  assert.equal(await assignmentStore.compensateEnqueueReceipt(normalizedAssignment), true);
  assert.equal(await assignmentStore.getAssignment("a-redis-json-normalized"), null);

  const fencedAssignment = await assignmentStore.enqueueWithReceipt({
    entryId: "redis-same-value",
    projectId: fixture.projectId,
    task: "same value assignment",
    sourcePath: fixture.sourcePath,
  }, { workerId: "worker-redis-json", orchestratorEpoch: 1 });
  if (fencedAssignment.writeFence.backend !== "redis") throw new Error("expected Redis assignment fence");
  const assignmentField = assignmentStore._assignmentField(fencedAssignment.assignmentId);
  const assignmentSnapshot = await backend.readStateRecord(assignmentField);
  assert.equal(assignmentSnapshot.revision, fencedAssignment.writeFence.revision);
  const assignmentSuccessor = await backend.compareAndSwapStateRecord(
    assignmentField,
    assignmentSnapshot.revision,
    assignmentSnapshot.data,
  );
  assert.equal(assignmentSuccessor.committed, true);
  await assert.rejects(
    () => assignmentStore.compensateEnqueueReceipt(fencedAssignment),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
      && error.code === "HUB_ASSIGNMENT_COMPENSATION_CONFLICT"),
  );
  assert.equal((await assignmentStore.getAssignment(fencedAssignment.assignmentId))?.task, "same value assignment");

  const normalizedInbox = await workerStore.writeInboxWithReceipt("worker-redis-json", {
    assignmentId: "a-redis-inbox-normalized",
    attempt: 1,
    attemptToken: "redis-normalized-token",
    metadata: { kept: true, omitted: undefined },
  });
  const normalizedPayload = normalizedInbox.committedRecord.payload as Record<string, unknown>;
  assert.equal(Object.hasOwn(normalizedPayload.metadata as object, "omitted"), false);
  assert.equal(Object.isFrozen(normalizedInbox), true);
  assert.equal(Object.isFrozen(normalizedPayload), true);
  assert.equal(await workerStore.compensateInboxReceipt(normalizedInbox), true);

  const fencedInbox = await workerStore.writeInboxWithReceipt("worker-redis-json", {
    assignmentId: "a-redis-inbox-same-value",
    attempt: 1,
    attemptToken: "redis-same-value-token",
  });
  if (fencedInbox.writeFence.backend !== "redis") throw new Error("expected Redis inbox fence");
  const inboxSnapshot = await backend.readStateRecord(fencedInbox.ref);
  assert.equal(inboxSnapshot.revision, fencedInbox.writeFence.revision);
  const inboxSuccessor = await backend.compareAndSwapStateRecord(
    fencedInbox.ref,
    inboxSnapshot.revision,
    inboxSnapshot.data,
  );
  assert.equal(inboxSuccessor.committed, true);
  await assert.rejects(
    () => workerStore.compensateInboxReceipt(fencedInbox),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
      && error.code === "HUB_WORKER_INBOX_COMPENSATION_CONFLICT"),
  );

  await assert.rejects(
    () => assignmentStore.enqueueWithReceipt({
      entryId: "redis-uncloneable",
      projectId: fixture.projectId,
      task: "uncloneable assignment",
      sourcePath: fixture.sourcePath,
      metadata: { callback: () => true },
    }, { workerId: "worker-redis-json", orchestratorEpoch: 1 }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
      && error.code === "HUB_ASSIGNMENT_JSON_INVALID"),
  );
  assert.equal(await assignmentStore.getAssignment("a-redis-uncloneable"), null);
  await assert.rejects(
    () => workerStore.writeInboxWithReceipt("worker-redis-json", {
      assignmentId: "a-redis-inbox-uncloneable",
      attempt: 1,
      attemptToken: "redis-uncloneable-token",
      callback: () => true,
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error
      && error.code === "HUB_WORKER_INBOX_PAYLOAD_INVALID"),
  );
  assert.equal(
    (await workerStore.readInbox("worker-redis-json")).some((entry) => entry.assignmentId === "a-redis-inbox-uncloneable"),
    false,
  );
});

test("Redis assignment cancellation checks abort boundaries and returns a post-commit linearization", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const store = new AssignmentStore(fixture.hubRoot);
  await store.init();
  const receipt = await store.enqueueWithReceipt({
    entryId: "redis-cancel-boundary",
    projectId: fixture.projectId,
    task: "cancel boundary",
    sourcePath: fixture.sourcePath,
  }, { workerId: "worker-redis-cancel", orchestratorEpoch: 1 });

  const preAborted = new AbortController();
  preAborted.abort(new DOMException("Redis cancel pre-abort", "AbortError"));
  await assert.rejects(
    () => store.writeCancel(receipt.assignmentId, 1, "must not persist", { signal: preAborted.signal }),
    /Redis cancel pre-abort/,
  );
  assert.equal(await store.readCancel(receipt.assignmentId, 1), null);

  const afterRead = new AbortController();
  __assignmentStoreTestHooks.afterRedisCancelRead = () => {
    afterRead.abort(new DOMException("Redis cancel after read", "AbortError"));
  };
  try {
    await assert.rejects(
      () => store.writeCancel(receipt.assignmentId, 1, "must not pass CAS", { signal: afterRead.signal }),
      /Redis cancel after read/,
    );
  } finally {
    __assignmentStoreTestHooks.afterRedisCancelRead = undefined;
  }
  assert.equal(await store.readCancel(receipt.assignmentId, 1), null);

  const postCommit = new AbortController();
  __assignmentStoreTestHooks.afterRedisCancelCommit = () => {
    postCommit.abort(new DOMException("Redis cancel post-commit", "AbortError"));
  };
  try {
    assert.equal(
      await store.writeCancel(receipt.assignmentId, 1, "persisted Redis cancellation", { signal: postCommit.signal }),
      true,
    );
  } finally {
    __assignmentStoreTestHooks.afterRedisCancelCommit = undefined;
  }
  assert.equal(postCommit.signal.aborted, true);
  assert.equal((await store.readCancel(receipt.assignmentId, 1))?.reason, "persisted Redis cancellation");
});

test("Redis registry CAS lets a successor commit while an old transaction is paused", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;

  let releaseOld!: () => void;
  const oldMayFinish = new Promise<void>((resolve) => { releaseOld = resolve; });
  let oldStarted!: () => void;
  const oldIsPaused = new Promise<void>((resolve) => { oldStarted = resolve; });
  let attempts = 0;
  const oldTransaction = mutateRegistry(fixture.hubRoot, async (registry) => {
    attempts += 1;
    if (attempts === 1) {
      oldStarted();
      await oldMayFinish;
    }
    registry.projects[fixture.projectId].metadata = {
      ...(registry.projects[fixture.projectId].metadata || {}),
      oldTransaction: true,
    };
  });
  await oldIsPaused;

  const successor = updateProject(fixture.hubRoot, fixture.projectId, {
    metadata: { successor: true },
  });
  const successorCommittedFirst = await Promise.race([
    successor.then(() => true),
    delay(750).then(() => false),
  ]);
  releaseOld();
  await Promise.all([oldTransaction, successor]);

  assert.equal(successorCommittedFirst, true, "successor was blocked by the stale owner instead of committing through CAS");
  assert.equal(attempts, 2, "stale transaction did not reload and retry after losing CAS");
  const registry = await loadRegistry(fixture.hubRoot);
  assert.equal(registry.projects[fixture.projectId].metadata?.successor, true);
  assert.equal(registry.projects[fixture.projectId].metadata?.oldTransaction, true);
  await assert.rejects(readFile(path.join(fixture.hubRoot, "projects.json")), { code: "ENOENT" });
});

test("Redis leader lease elects one owner, fences expiry, and preserves a monotonic epoch", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const first = { hubId: "hub-first", lockToken: "first-token-00000001", host: "host-a", pid: 101 };
  const contender = { hubId: "hub-contender", lockToken: "second-token-000001", host: "host-b", pid: 202 };

  const [left, right] = await Promise.all([
    backend.acquireLeader(first, 80),
    backend.acquireLeader(contender, 80),
  ]);
  assert.equal(Number(left.acquired) + Number(right.acquired), 1);
  const winner = left.acquired ? first : contender;
  const loser = left.acquired ? contender : first;
  const firstEpoch = (left.acquired ? left : right).leader.epoch;
  assert.equal((await backend.readLeader()).hubId, winner.hubId);
  assert.equal(await backend.releaseLeader({ ...loser, epoch: firstEpoch }), false);

  await delay(120);
  assert.equal((await backend.renewLeader({ ...winner, epoch: firstEpoch }, 80)).renewed, false);
  const successor = await backend.acquireLeader(loser, 1_000);
  assert.equal(successor.acquired, true);
  assert.equal(successor.leader.epoch, firstEpoch + 1);
  assert.equal(successor.leader.hubId, loser.hubId);
  assert.equal(await backend.releaseLeader({ ...winner, epoch: firstEpoch }), false);
  assert.equal(await backend.releaseLeader({ ...loser, epoch: firstEpoch + 1 }), true);

  const registry = await loadRegistry(fixture.hubRoot);
  assert.ok(registry.projects[fixture.projectId], "leader fields corrupted the colocated registry document");
});

test("LeaderLock uses Redis as the authority when shared state is configured", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const first = new LeaderLock(fixture.hubRoot);
  const second = new LeaderLock(fixture.hubRoot);
  const attempts = await Promise.allSettled([first.acquire(), second.acquire()]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
  const winner = attempts[0].status === "fulfilled" ? first : second;
  const loser = winner === first ? second : first;
  const firstEpoch = winner.getEpoch();
  assert.equal(await winner.stillHeld(), true);
  assert.equal(await loser.stillHeld(), false);
  assert.equal((await readLeaderStatus(fixture.hubRoot)).status, "running");
  assert.equal(await winner.release(), true);

  const successor = new LeaderLock(fixture.hubRoot);
  await assert.rejects(successor.acquire(), { code: "HUB_LEADER_PROCESS_RESTART_REQUIRED" });
  assert.equal((await readLeaderStatus(fixture.hubRoot)).status, "stopped");
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const remote = { hubId: "remote-next-process", lockToken: "remote-next-token-0001", host: "host-b", pid: 999 };
  const next = await backend.acquireLeader(remote, 1_000);
  assert.equal(next.acquired, true);
  assert.equal(next.leader.epoch, firstEpoch + 1);
  assert.equal(await backend.releaseLeader({ ...remote, epoch: next.leader.epoch }), true);
  await assert.rejects(readFile(path.join(fixture.hubRoot, "orchestrator", "leader.lock", "leader.json")), { code: "ENOENT" });
});

test("Redis queue CAS rejects a paused old leader after a successor takes the lease", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const old = { hubId: "old-hub", lockToken: "old-leader-token-0001", host: "host-a", pid: 301 };
  const next = { hubId: "next-hub", lockToken: "next-leader-token-001", host: "host-b", pid: 302 };
  const acquired = await backend.acquireLeader(old, 80);
  assert.equal(acquired.acquired, true);
  const pausedSnapshot = await backend.readQueue();

  await delay(120);
  const successor = await backend.acquireLeader(next, 1_000);
  assert.equal(successor.acquired, true);
  assert.equal(successor.leader.epoch, acquired.leader.epoch + 1);
  const staleCommit = await backend.compareAndSwapQueue(
    pausedSnapshot.revision,
    pausedSnapshot.revision + 1,
    JSON.stringify({ version: 1, entries: [{ id: "stale-write" }] }),
    { hubId: old.hubId, lockToken: old.lockToken, epoch: acquired.leader.epoch },
  );
  assert.deepEqual(staleCommit, { committed: false, fenced: true, revision: 0 });
  assert.equal((await backend.readQueue()).serialized, null);

  const currentCommit = await backend.compareAndSwapQueue(
    pausedSnapshot.revision,
    pausedSnapshot.revision + 1,
    JSON.stringify({ version: 1, entries: [{ id: "current-write" }] }),
    { hubId: next.hubId, lockToken: next.lockToken, epoch: successor.leader.epoch },
  );
  assert.deepEqual(currentCommit, { committed: true, fenced: false, revision: 1 });
});

test("Redis queue CAS preserves concurrent service enqueues without a host-local lock", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  await Promise.all(Array.from({ length: 16 }, (_, index) => enqueue(fixture.hubRoot, {
    projectId: fixture.projectId,
    description: `concurrent-entry-${index}`,
    priority: "P2",
    metadata: { mutating: false },
  })));
  const entries = await listQueue(fixture.hubRoot, { projectId: fixture.projectId });
  assert.equal(entries.length, 16);
  assert.deepEqual(
    entries.map((entry) => entry.description).sort(),
    Array.from({ length: 16 }, (_, index) => `concurrent-entry-${index}`).sort(),
  );
  await assert.rejects(readFile(path.join(fixture.hubRoot, "queue", "queue.json")), { code: "ENOENT" });
});

test("Redis worker inbox grants one atomic claim and preserves tombstone revisions", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const firstStore = new WorkerStore(fixture.hubRoot);
  const secondStore = new WorkerStore(fixture.hubRoot);
  await firstStore.init();
  await firstStore.registerWorker("w-shared", { projectId: fixture.projectId, status: "ready" });
  await firstStore.writeInbox("w-shared", {
    assignmentId: "a-shared",
    entryId: "q-shared",
    attempt: 1,
    attemptToken: "attempt-token",
  });

  const [left, right] = await Promise.all([
    firstStore.claimInboxEntries("w-shared"),
    secondStore.claimInboxEntries("w-shared"),
  ]);
  assert.equal(left.length + right.length, 1);
  const claim = left[0] || right[0];
  assert.equal(claim.assignment.assignmentId, "a-shared");
  assert.equal(await firstStore.completeInboxClaim("w-shared", "a-shared", "wrong-token"), false);
  assert.equal(await firstStore.hasInboxWork("w-shared"), true);
  assert.equal(await firstStore.completeInboxClaim("w-shared", "a-shared", claim.claimToken), true);
  assert.equal(await firstStore.hasInboxWork("w-shared"), false);

  await firstStore.writeInbox("w-shared", {
    assignmentId: "a-shared",
    entryId: "q-shared-retry",
    attempt: 2,
    attemptToken: "attempt-token-2",
  });
  const retried = await firstStore.claimInboxEntries("w-shared");
  assert.equal(retried.length, 1);
  assert.equal(retried[0].assignment.attempt, 2);
  assert.equal(await firstStore.completeInboxClaim("w-shared", "a-shared", retried[0].claimToken), true);
  await assert.rejects(readFile(path.join(fixture.hubRoot, "workers", "registry", "worker-w-shared.json")), { code: "ENOENT" });
});

test("Redis worker claims one assignment at a time and old completion cannot clear a new reservation", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const store = new WorkerStore(fixture.hubRoot);
  await store.init();
  await store.registerWorker("w-generation", {
    projectId: fixture.projectId,
    status: "ready",
    incarnationToken: "incarnation-1",
  });
  for (const [assignmentId, attemptToken] of [["a-one", "token-one"], ["a-two", "token-two"]]) {
    await store.writeInbox("w-generation", { assignmentId, entryId: assignmentId, attempt: 1, attemptToken });
  }
  const claims = await store.claimInboxEntries("w-generation", "incarnation-1");
  assert.equal(claims.length, 1);

  await store.updateWorkerIf("w-generation", {
    status: "assigned",
    currentAssignmentId: "a-one",
    currentAttemptToken: "token-one",
  }, { incarnationToken: "incarnation-1", status: "ready", currentAssignmentId: null });
  await store.updateWorkerIf("w-generation", {
    status: "assigned",
    currentAssignmentId: "a-two",
    currentAttemptToken: "token-two",
  }, { incarnationToken: "incarnation-1", currentAssignmentId: "a-one", currentAttemptToken: "token-one" });
  const staleTail = await store.updateWorkerIf("w-generation", {
    status: "ready",
    currentAssignmentId: null,
    currentAttemptToken: null,
  }, { incarnationToken: "incarnation-1", currentAssignmentId: "a-one", currentAttemptToken: "token-one" });
  assert.equal(staleTail, null);
  const worker = await store.getWorker("w-generation");
  assert.equal(worker?.currentAssignmentId, "a-two");
  assert.equal(worker?.currentAttemptToken, "token-two");
});

test("Redis worker and assignment health timestamps use Redis authority time", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const workers = new WorkerStore(fixture.hubRoot);
  const assignments = new AssignmentStore(fixture.hubRoot);
  await workers.init();
  await assignments.init();
  const before = await backend.serverTimeMs();
  const queued = await enqueue(fixture.hubRoot, {
    projectId: fixture.projectId,
    description: "authority time queue entry",
  });
  const afterEnqueue = await backend.serverTimeMs();
  assert.ok(Date.parse(queued.createdAt) >= before && Date.parse(queued.createdAt) <= afterEnqueue);
  assert.ok(Date.parse(queued.updatedAt) >= before && Date.parse(queued.updatedAt) <= afterEnqueue);
  const worker = await workers.registerWorker("w-authority-time", {
    projectId: fixture.projectId,
    status: "ready",
    startedAt: "2999-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2999-01-01T00:00:00.000Z",
    incarnationToken: "authority-time-incarnation",
  });
  const afterRegistration = await backend.serverTimeMs();
  assert.ok(Date.parse(String(worker.startedAt)) >= afterEnqueue && Date.parse(String(worker.startedAt)) <= afterRegistration);
  assert.ok(Date.parse(String(worker.lastHeartbeatAt)) >= afterEnqueue && Date.parse(String(worker.lastHeartbeatAt)) <= afterRegistration);

  const updated = await workers.updateWorkerIf("w-authority-time", {
    lastHeartbeatAt: "2999-01-01T00:00:00.000Z",
  }, { incarnationToken: "authority-time-incarnation", status: "ready" });
  const afterUpdate = await backend.serverTimeMs();
  assert.ok(updated);
  assert.ok(Date.parse(String(updated.lastHeartbeatAt)) >= afterRegistration
    && Date.parse(String(updated.lastHeartbeatAt)) <= afterUpdate);
  assert.equal(await workers.authorityTimeMs() >= before, true);

  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: "q-authority-time",
    projectId: fixture.projectId,
    task: "authority time",
    sourcePath: fixture.sourcePath,
    workflow: "standard",
    planMode: "full",
  });
  await assignments.createAttempt(String(assignment.assignmentId), {
    workerId: "w-authority-time",
    orchestratorEpoch: 1,
  });
  await assignments.recordHeartbeat(String(assignment.assignmentId), 1, {
    phase: "execute",
    status: "running",
    updatedAt: "2999-01-01T00:00:00.000Z",
    progressUpdatedAt: "worker-progress-marker-1",
  });
  const firstHeartbeat = (await assignments.getActiveAttempt(String(assignment.assignmentId)))?.heartbeat as Record<string, unknown> | undefined;
  assert.ok(firstHeartbeat);
  assert.notEqual(firstHeartbeat.updatedAt, "2999-01-01T00:00:00.000Z");
  assert.notEqual(firstHeartbeat.progressUpdatedAt, "worker-progress-marker-1");
  const firstProgressAt = firstHeartbeat.progressUpdatedAt;
  await assignments.recordHeartbeat(String(assignment.assignmentId), 1, {
    phase: "execute",
    status: "running",
    updatedAt: "2999-01-01T00:00:00.000Z",
    progressUpdatedAt: "worker-progress-marker-1",
  });
  const secondHeartbeat = (await assignments.getActiveAttempt(String(assignment.assignmentId)))?.heartbeat as Record<string, unknown> | undefined;
  assert.equal(secondHeartbeat?.progressUpdatedAt, firstProgressAt);
  assert.equal(secondHeartbeat?.sourceProgressUpdatedAt, "worker-progress-marker-1");
});

test("Redis terminal assignment is first-writer-wins and cannot be revived", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const assignments = new AssignmentStore(fixture.hubRoot);
  await assignments.init();
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: "q-terminal",
    projectId: fixture.projectId,
    task: "terminal race",
    sourcePath: fixture.sourcePath,
    workflow: "blocked",
    planMode: "none",
  });
  const attempt = await assignments.createAttempt(String(assignment.assignmentId), { workerId: "w-terminal", orchestratorEpoch: 1 });
  await assignments.markRunning(String(assignment.assignmentId), 1);
  assert.equal(await assignments.writeSyntheticFailure(String(assignment.assignmentId), 1, {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    status: "failed",
    jobResult: { status: "failed", failure: { kind: "worker_heartbeat_lost" } },
  }), true);
  await assert.rejects(assignments.markRunning(String(assignment.assignmentId), 1), { code: "STALE_ATTEMPT" });
  assert.equal(await assignments.completeAttemptFromExistingResult(String(assignment.assignmentId), 1, {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    attemptToken: attempt.attemptToken,
    orchestratorEpoch: attempt.orchestratorEpoch,
    status: "completed",
  }), false);
  const terminal = await assignments.getAssignment(String(assignment.assignmentId));
  assert.equal(terminal?.status, "failed");
});

test("Redis execution leases use shared server time and owner-token CAS", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const dataRoot = path.join(fixture.root, "project-runtime");
  await mkdir(dataRoot, { recursive: true });
  const lease = await acquireLease(fixture.root, {
    leaseId: "lease-shared",
    jobId: "job-shared",
    phase: "execute",
    ttlMs: 2_000,
    dataRoot,
  });
  assert.equal((await readLease(fixture.root, "lease-shared", { dataRoot }))?.ownerToken, lease.ownerToken);
  await assert.rejects(acquireLease(fixture.root, {
    leaseId: "lease-shared",
    jobId: "job-other",
    phase: "verify",
    ttlMs: 2_000,
    dataRoot,
  }), { code: "EEXIST" });
  await assert.rejects(renewLease(fixture.root, "lease-shared", {
    ttlMs: 2_000,
    ownerToken: "wrong-owner",
    dataRoot,
  }), /lease owner mismatch/);
  const renewed = await renewLease(fixture.root, "lease-shared", {
    ttlMs: 3_000,
    ownerToken: lease.ownerToken,
    dataRoot,
  });
  assert.ok(Number(renewed.expiresAtMs) > Number(lease.expiresAtMs));
  await releaseLease(fixture.root, "lease-shared", { ownerToken: lease.ownerToken, dataRoot });
  assert.equal(await readLease(fixture.root, "lease-shared", { dataRoot }), null);
});

test("Redis maintenance lease fences every shared-state mutation and releases only its owner", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const ownerToken = `maintenance-${randomBytes(24).toString("base64url")}`;
  const otherToken = `maintenance-${randomBytes(24).toString("base64url")}`;
  const acquired = await backend.acquireMaintenance(ownerToken, "backup", 5_000);
  assert.equal(acquired.acquired, true);
  assert.equal((await backend.acquireMaintenance(otherToken, "restore", 5_000)).acquired, false);
  const status = await backend.readMaintenance();
  assert.equal(status.active, true);
  assert.equal(status.token, ownerToken);
  assert.equal(status.operation, "backup");
  assert.equal((await backend.renewMaintenance(ownerToken, 5_000)).acquired, true);

  const registry = JSON.parse(String(await backend.readRegistry()));
  await assert.rejects(backend.compareAndSwapRegistry(
    registry.revision,
    registry.revision + 1,
    JSON.stringify({ ...registry, revision: registry.revision + 1 }),
  ), { code: "HUB_MAINTENANCE_ACTIVE" });
  const queue = await backend.readQueue();
  await assert.rejects(backend.compareAndSwapQueue(
    queue.revision,
    queue.revision + 1,
    queue.serialized || JSON.stringify({ version: 1, entries: [] }),
  ), { code: "HUB_MAINTENANCE_ACTIVE" });
  await assert.rejects(backend.compareAndSwapStateRecord("worker:w-direct-maintenance", 0, {
    workerId: "w-direct-maintenance",
  }), { code: "HUB_MAINTENANCE_ACTIVE" });
  await assert.rejects(backend.appendJobEvent("job:project:job-direct-maintenance", 0, {
    project: fixture.projectId,
    jobId: "job-direct-maintenance",
    status: "pending",
  }, JSON.stringify({
    type: "job_created",
    project: fixture.projectId,
    jobId: "job-direct-maintenance",
    ts: new Date().toISOString(),
  })), { code: "HUB_MAINTENANCE_ACTIVE" });
  await assert.rejects(backend.acquireLeader({
    hubId: "maintenance-blocked-leader",
    lockToken: "maintenance-blocked-leader-token",
    host: "host-maintenance",
    pid: 1234,
  }, 1_000), { code: "HUB_MAINTENANCE_ACTIVE" });

  await assert.rejects(updateProject(fixture.hubRoot, fixture.projectId, { name: "must-not-write" }), {
    code: "HUB_MAINTENANCE_ACTIVE",
  });
  await assert.rejects(enqueue(fixture.hubRoot, {
    projectId: fixture.projectId,
    description: "must-not-enqueue",
  }), { code: "HUB_MAINTENANCE_ACTIVE" });
  const workers = new WorkerStore(fixture.hubRoot);
  await assert.rejects(workers.registerWorker("w-maintenance", {
    projectId: fixture.projectId,
    status: "ready",
  }), { code: "HUB_MAINTENANCE_ACTIVE" });
  await assert.rejects(appendEvent(fixture.root, fixture.projectId, "job-maintenance", {
    type: "job_created",
    jobId: "job-maintenance",
    project: fixture.projectId,
    task: "must-not-write",
    ts: new Date().toISOString(),
  }, { dataRoot: fixture.projectRuntimeRoot }), { code: "HUB_MAINTENANCE_ACTIVE" });

  assert.equal(await backend.releaseMaintenance(otherToken), false);
  assert.equal((await backend.readMaintenance()).active, true);
  assert.equal(await backend.releaseMaintenance(ownerToken), true);
  assert.equal((await backend.readMaintenance()).active, false);
  await updateProject(fixture.hubRoot, fixture.projectId, { name: "writes-resumed" });
  assert.equal((await loadRegistry(fixture.hubRoot)).projects[fixture.projectId].name, "writes-resumed");
});

test("Redis logical snapshot is complete, deterministic, and excludes transient ownership", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const jobId = "job-logical-snapshot";
  await createJob(fixture.root, {
    project: fixture.projectId,
    jobId,
    task: "snapshot state",
    workflow: "standard",
    dataRoot: fixture.projectRuntimeRoot,
  });
  await appendEvent(fixture.root, fixture.projectId, jobId, {
    type: "phase_activity",
    jobId,
    project: fixture.projectId,
    phase: "plan",
    message: "snapshot event",
    ts: new Date().toISOString(),
  }, { dataRoot: fixture.projectRuntimeRoot });
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const token = `snapshot-${randomBytes(24).toString("base64url")}`;
  assert.equal((await backend.acquireMaintenance(token, "logical snapshot", 10_000)).acquired, true);
  try {
    await assert.rejects(backend.exportSnapshot(`wrong-${randomBytes(24).toString("base64url")}`), {
      code: "HUB_MAINTENANCE_ACTIVE",
    });
    const snapshot = await backend.exportSnapshot(token);
    const jobField = `job:${Buffer.from(fixture.projectId, "utf8").toString("base64url")}:${Buffer.from(jobId, "utf8").toString("base64url")}`;
    assert.equal(snapshot.format, "cpb-hub-redis-logical-snapshot/v1");
    assert.equal(snapshot.backendIdentityFingerprint, backend.identityFingerprint);
    assert.equal(snapshot.hashFields.some(([field]) => field === "revision"), true);
    assert.equal(snapshot.hashFields.some(([field]) => field === jobField), true);
    assert.equal(snapshot.hashFields.some(([field]) => field.startsWith("maintenance")), false);
    assert.equal(snapshot.hashFields.some(([field]) => field === "leaderToken"), false);
    assert.deepEqual(snapshot.hashFields.map(([field]) => field), [...snapshot.hashFields.map(([field]) => field)].sort());
    const stream = snapshot.jobStreams.find((entry) => entry.field === jobField);
    assert.ok(stream);
    assert.equal(stream.events.length, 2);
    assert.deepEqual(stream.events.map((event) => JSON.parse(event).type), ["job_created", "phase_activity"]);
    const { sha256, ...body } = snapshot;
    assert.equal(sha256, createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex"));
  } finally {
    assert.equal(await backend.releaseMaintenance(token), true);
  }
});

test("local authority inventory builds a complete Redis-restorable migration snapshot", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const localRoot = path.join(fixture.root, "local-migration-source");
  const localHub = path.join(localRoot, "hub");
  const localRuntime = path.join(localHub, "projects", "local-project");
  await mkdir(path.join(localHub, "queue"), { recursive: true });
  await mkdir(path.join(localHub, "assignments", "a-migrate", "attempts", "001"), { recursive: true });
  await mkdir(path.join(localHub, "workers", "registry"), { recursive: true });
  await mkdir(path.join(localHub, "workers", "inbox", "w-migrate", "processing"), { recursive: true });
  await mkdir(path.join(localRuntime, "leases"), { recursive: true });
  await mkdir(path.join(localRuntime, "events", "local-project"), { recursive: true });
  await writeFile(path.join(localHub, "projects.json"), `${JSON.stringify({
    version: 1,
    revision: 7,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: {
      "local-project": {
        id: "local-project",
        sourcePath: localRoot,
        projectRuntimeRoot: localRuntime,
        enabled: true,
      },
    },
  })}\n`);
  await writeFile(path.join(localHub, "queue", "queue.json"), `${JSON.stringify({ version: 1, entries: [] })}\n`);
  await writeFile(path.join(localHub, "assignments", "a-migrate", "state.json"), `${JSON.stringify({
    assignmentId: "a-migrate", entryId: "migrate", projectId: "local-project",
    status: "completed", attempts: 1, activeAttempt: 1,
  })}\n`);
  await writeFile(path.join(localHub, "assignments", "a-migrate", "attempts", "001", "attempt.json"), `${JSON.stringify({
    assignmentId: "a-migrate", attempt: 1, attemptToken: "attempt-token", workerId: "w-migrate", status: "completed",
  })}\n`);
  await writeFile(path.join(localHub, "workers", "registry", "worker-w-migrate.json"), `${JSON.stringify({
    workerId: "w-migrate", status: "exited", incarnationToken: "incarnation-migrate",
  })}\n`);
  await writeFile(path.join(localHub, "workers", "inbox", "w-migrate", "processing", "a-migrate.json"), `${JSON.stringify({
    assignmentId: "a-migrate", attempt: 1, attemptToken: "attempt-token", projectId: "local-project",
  })}\n`);
  await writeFile(path.join(localRuntime, "leases", "lease-migrate.json"), `${JSON.stringify({
    leaseId: "lease-migrate", jobId: "job-migrate", phase: "verify", ownerPid: 123,
    ownerHost: "host", ownerToken: "owner-token", acquiredAt: "2026-01-01T00:00:00.000Z",
    heartbeatAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z",
  })}\n`);
  const migrationEvents = [
    { type: "job_created", project: "local-project", jobId: "job-migrate", task: "migrate", ts: "2026-01-01T00:00:00.000Z" },
    { type: "job_completed", project: "local-project", jobId: "job-migrate", ts: "2026-01-01T00:01:00.000Z" },
  ];
  await writeFile(
    path.join(localRuntime, "events", "local-project", "job-migrate.jsonl"),
    `${migrationEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );

  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: localHub });
  assert.ok(backend);
  const migration = await buildLocalRedisMigrationSnapshot({
    cpbRoot: localRoot,
    hubRoot: localHub,
    backendIdentityFingerprint: backend.identityFingerprint,
  });
  assert.deepEqual(migration.inventory, {
    projects: 1,
    queueEntries: 0,
    assignments: 1,
    attempts: 1,
    workers: 1,
    inboxEntries: 1,
    leases: 1,
    jobs: 1,
    jobEvents: 2,
    runtimeRoots: [localRuntime],
    sourcePaths: migration.inventory.sourcePaths,
  });
  assert.ok(migration.inventory.sourcePaths.length >= 6);
  const token = `migration-${randomBytes(24).toString("base64url")}`;
  assert.equal((await backend.acquireMaintenance(token, "migration snapshot test", 10_000)).acquired, true);
  try {
    const restored = await backend.restoreSnapshot(token, migration.snapshot);
    assert.equal(new Map(restored.hashFields).get("revision"), "7");
  } finally {
    assert.equal(await backend.releaseMaintenance(token), true);
  }
  assert.equal(JSON.parse(String(await backend.readRegistry())).projects["local-project"].id, "local-project");
  assert.equal((await backend.scanStateRecords("assignment:")).length, 1);
  assert.equal((await backend.scanStateRecords("worker:")).length, 1);
  const inbox = await backend.scanStateRecords("workerInbox:");
  assert.equal(inbox.length, 1);
  assert.equal((inbox[0].record.data as { status: string }).status, "pending");
  assert.equal((await backend.scanStateRecords("lease:")).length, 1);
  const jobField = `job:${Buffer.from("local-project").toString("base64url")}:${Buffer.from("job-migrate").toString("base64url")}`;
  assert.deepEqual((await backend.readJobEvents(jobField)).map((event) => JSON.parse(event).type), ["job_created", "job_completed"]);

  const migrationConfig = path.join(localRoot, "redis-migration.json");
  const baseConfig = JSON.parse(await readFile(fixture.configFile, "utf8"));
  await writeFile(migrationConfig, `${JSON.stringify({
    ...baseConfig,
    registryKey: "cpb:{migration-e2e}:registry",
  })}\n`, { mode: 0o600 });
  await chmod(migrationConfig, 0o600);
  const output = path.join(localRoot, "migration-output");
  const preview = await migrateLocalHubToRedis({
    cpbRoot: localRoot, hubRoot: localHub, configFile: migrationConfig, output,
  });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.jobs, 1);
  const migrationModule = new URL("../../server/services/hub/hub-redis-migration.js", import.meta.url).href;
  const crashScript = [
    `const { migrateLocalHubToRedis } = await import(${JSON.stringify(migrationModule)});`,
    `await migrateLocalHubToRedis({`,
    `  cpbRoot: ${JSON.stringify(localRoot)}, hubRoot: ${JSON.stringify(localHub)},`,
    `  configFile: ${JSON.stringify(migrationConfig)}, output: ${JSON.stringify(output)}, dryRun: false,`,
    `  backupSigningKey: "migration-backup-signing-key-1234567890",`,
    `  afterRedisCommit: async () => process.exit(86),`,
    `});`,
  ].join("\n");
  const migrationChild = spawn(process.execPath, ["--input-type=module", "--eval", crashScript], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const migrationStderr: Buffer[] = [];
  migrationChild.stderr.on("data", (chunk: Buffer) => migrationStderr.push(chunk));
  const migrationExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    migrationChild.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(migrationExit, { code: 86, signal: null }, Buffer.concat(migrationStderr).toString("utf8"));
  assert.equal(JSON.parse(await readFile(path.join(localHub, "projects.json"), "utf8")).projects["local-project"].id, "local-project");
  const migrated = await recoverHubRedisMigration({
    hubRoot: localHub,
    configFile: migrationConfig,
    backupSigningKey: "migration-backup-signing-key-1234567890",
  });
  assert.equal(migrated.recovered, true);
  assert.equal(await readFile(path.join(output, "migration-result.json"), "utf8").then(() => true), true);
  await assert.rejects(readFile(path.join(localHub, "projects.json"), "utf8"), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(localRuntime, "events", "local-project", "job-migrate.jsonl"), "utf8"), { code: "ENOENT" });
  const migratedBackend = await openHubRedisStateBackend({ configFile: migrationConfig, hubRoot: localHub });
  assert.ok(migratedBackend);
  assert.equal(JSON.parse(String(await migratedBackend.readRegistry())).projects["local-project"].id, "local-project");
  assert.equal((await migratedBackend.scanStateRecords("assignment:")).length, 1);
  assert.equal((await migratedBackend.readJobEvents(jobField)).length, 2);
});

test("Redis migration reports committed metadata when local authority changes after Redis commit", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const migration = await migrationCommitMetadataFixture(fixture, "migration-authority-change");
  const displacedProjects = `${migration.projectsPath}.before-commit`;

  await assert.rejects(
    migrateLocalHubToRedis({
      cpbRoot: migration.cpbRoot,
      hubRoot: migration.hubRoot,
      configFile: migration.configFile,
      output: migration.output,
      dryRun: false,
      backupSigningKey: migration.backupSigningKey,
      afterRedisCommit: async () => {
        await rename(migration.projectsPath, displacedProjects);
        await writeFile(migration.projectsPath, migration.registry, "utf8");
      },
    }),
    (error: unknown) => isCommittedRedisMigrationFailure(
      error,
      "HUB_REDIS_MIGRATION_AUTHORITY_CHANGED",
      migration.recoveryPaths,
    ),
  );
  assert.equal(await readFile(migration.projectsPath, "utf8"), migration.registry);
  assert.equal(await readFile(displacedProjects, "utf8"), migration.registry);
});

test("Redis migration preserves retirement committed path after Redis commit", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const migration = await migrationCommitMetadataFixture(fixture, "migration-retirement-durability");
  let isolatedAuthority = "";

  await assert.rejects(
    _internalWithHubRedisMigrationTestHooksForTests({
      beforeAuthorityIsolation: ({ quarantinePath }) => {
        isolatedAuthority = quarantinePath;
      },
      syncDirectory: ({ operation }) => {
        if (operation === "retirement-preserve") throw new Error("injected retirement durability failure");
      },
    }, () => migrateLocalHubToRedis({
      cpbRoot: migration.cpbRoot,
      hubRoot: migration.hubRoot,
      configFile: migration.configFile,
      output: migration.output,
      dryRun: false,
      backupSigningKey: migration.backupSigningKey,
    })),
    (error: unknown) => {
      if (!isCommittedRedisMigrationFailure(
        error,
        "HUB_REDIS_MIGRATION_COMMITTED_DURABILITY_AMBIGUOUS",
        migration.recoveryPaths,
        isolatedAuthority,
      )) return false;
      const typed = error as {
        committedPath?: unknown;
        recoveryPaths?: Record<string, unknown>;
      };
      return typed.committedPath === isolatedAuthority
        && typed.recoveryPaths?.isolatedAuthority === isolatedAuthority
        && typed.recoveryPaths?.preservedAuthority === isolatedAuthority;
    },
  );
  await assert.rejects(readFile(migration.projectsPath, "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(isolatedAuthority, "utf8"), migration.registry);
});

test("Redis migration result successor conflict retains the post-commit contract", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const migration = await migrationCommitMetadataFixture(fixture, "migration-result-successor");
  const incompatibleResult = "{\"successor\":true}\n";

  await assert.rejects(
    migrateLocalHubToRedis({
      cpbRoot: migration.cpbRoot,
      hubRoot: migration.hubRoot,
      configFile: migration.configFile,
      output: migration.output,
      dryRun: false,
      backupSigningKey: migration.backupSigningKey,
      afterRedisCommit: async () => {
        await writeFile(migration.recoveryPaths.result, incompatibleResult, "utf8");
      },
    }),
    (error: unknown) => {
      if (!isCommittedRedisMigrationFailure(
        error,
        "HUB_REDIS_MIGRATION_SUCCESSOR_PRESERVED",
        migration.recoveryPaths,
      )) return false;
      return (error as { recoveryPaths?: Record<string, unknown> }).recoveryPaths?.successor
        === migration.recoveryPaths.result;
    },
  );
  await assert.rejects(readFile(migration.projectsPath, "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(migration.recoveryPaths.result, "utf8"), incompatibleResult);
});

test("Redis migration recovery result conflict retains the post-commit contract", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const migration = await migrationCommitMetadataFixture(fixture, "migration-recovery-result-conflict");

  await assert.rejects(
    migrateLocalHubToRedis({
      cpbRoot: migration.cpbRoot,
      hubRoot: migration.hubRoot,
      configFile: migration.configFile,
      output: migration.output,
      dryRun: false,
      backupSigningKey: migration.backupSigningKey,
      afterRedisCommit: async () => {
        throw new Error("injected interruption after Redis commit");
      },
    }),
    (error: unknown) => isCommittedRedisMigrationFailure(error, null, migration.recoveryPaths),
  );
  await writeFile(migration.recoveryPaths.result, "{\"incompatible\":true}\n", "utf8");

  await assert.rejects(
    recoverHubRedisMigration({
      hubRoot: migration.hubRoot,
      configFile: migration.configFile,
      backupSigningKey: migration.backupSigningKey,
    }),
    (error: unknown) => isCommittedRedisMigrationFailure(
      error,
      "HUB_REDIS_MIGRATION_SUCCESSOR_PRESERVED",
      migration.recoveryPaths,
    ),
  );
  await assert.rejects(readFile(migration.projectsPath, "utf8"), { code: "ENOENT" });
});

test("Redis migration ignores forged committed metadata after Redis commit", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const migration = await migrationCommitMetadataFixture(fixture, "migration-forged-committed-metadata");
  const forgedPath = path.join(migration.cpbRoot, "forged");

  await assert.rejects(
    migrateLocalHubToRedis({
      cpbRoot: migration.cpbRoot,
      hubRoot: migration.hubRoot,
      configFile: migration.configFile,
      output: migration.output,
      dryRun: false,
      backupSigningKey: migration.backupSigningKey,
      afterRedisCommit: async () => {
        throw Object.assign(new Error("forged committed metadata"), {
          code: "FORGED_COMMITTED",
          committed: true,
          committedPath: forgedPath,
          recoveryPaths: { forged: forgedPath },
        });
      },
    }),
    (error: unknown) => {
      if (!isCommittedRedisMigrationFailure(error, "FORGED_COMMITTED", migration.recoveryPaths, null)) return false;
      return (error as { recoveryPaths?: Record<string, unknown> }).recoveryPaths?.forged === undefined;
    },
  );
});

test("Redis migration reports Redis maintenance finalization failure as committed", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const migration = await migrationCommitMetadataFixture(fixture, "migration-redis-maintenance-finalize");

  await assert.rejects(
    _internalWithHubRedisMigrationTestHooksForTests({
      beforeRedisMaintenanceFinalize: () => {
        throw new Error("injected Redis maintenance finalization failure");
      },
    }, () => migrateLocalHubToRedis({
      cpbRoot: migration.cpbRoot,
      hubRoot: migration.hubRoot,
      configFile: migration.configFile,
      output: migration.output,
      dryRun: false,
      backupSigningKey: migration.backupSigningKey,
    })),
    (error: unknown) => isCommittedRedisMigrationFailure(error, null, migration.recoveryPaths, null),
  );
});

test("Redis migration reports local maintenance release failure as committed", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const migration = await migrationCommitMetadataFixture(fixture, "migration-local-maintenance-release");

  await assert.rejects(
    _internalWithHubRedisMigrationTestHooksForTests({
      afterRedisRestoreCommitBoundary: async () => {
        await rm(hubMaintenanceLockPath(migration.hubRoot), { recursive: true, force: true });
      },
    }, () => migrateLocalHubToRedis({
      cpbRoot: migration.cpbRoot,
      hubRoot: migration.hubRoot,
      configFile: migration.configFile,
      output: migration.output,
      dryRun: false,
      backupSigningKey: migration.backupSigningKey,
    })),
    (error: unknown) => isCommittedRedisMigrationFailure(
      error,
      "HUB_MAINTENANCE_INVALID",
      migration.recoveryPaths,
      null,
    ),
  );
});

test("Redis migration rejects output overlapping a runtime retirement authority", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const cpbRoot = path.join(fixture.root, "migration-output-overlap");
  const hubRoot = path.join(cpbRoot, "hub");
  const runtimeRoot = path.join(cpbRoot, "runtime");
  const leasesRoot = path.join(runtimeRoot, "leases");
  await mkdir(leasesRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(path.join(leasesRoot, "lease.json"), `${JSON.stringify({
    leaseId: "lease",
    resource: "resource",
    holder: "holder",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
  })}\n`, "utf8");
  await writeFile(path.join(hubRoot, "projects.json"), `${JSON.stringify({
    version: 1,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    projects: {
      project: {
        id: "project",
        sourcePath: cpbRoot,
        projectRuntimeRoot: runtimeRoot,
      },
    },
  })}\n`, "utf8");
  const configFile = path.join(cpbRoot, "redis-migration.json");
  const baseConfig = JSON.parse(await readFile(fixture.configFile, "utf8"));
  await writeFile(configFile, `${JSON.stringify({
    ...baseConfig,
    registryKey: `cpb:{migration-${randomUUID()}}:registry`,
  })}\n`, { mode: 0o600 });
  await chmod(configFile, 0o600);

  await assert.rejects(
    () => migrateLocalHubToRedis({
      cpbRoot,
      hubRoot,
      configFile,
      output: path.join(leasesRoot, "migration-output"),
    }),
    (error: unknown) => codeOf(error) === "HUB_REDIS_MIGRATION_UNSAFE",
  );
});

test("Redis migration detects output directory ABA before result publication", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const migration = await migrationCommitMetadataFixture(fixture, "migration-output-aba");
  let swapped = false;

  await assert.rejects(
    _internalWithHubRedisMigrationTestHooksForTests({
      syncDirectory: async ({ operation }) => {
        if (!swapped && operation === "retirement-preserve") {
          swapped = true;
          await rename(migration.output, `${migration.output}.prior`);
          await mkdir(migration.output);
        }
      },
    }, () => migrateLocalHubToRedis({
      cpbRoot: migration.cpbRoot,
      hubRoot: migration.hubRoot,
      configFile: migration.configFile,
      output: migration.output,
      dryRun: false,
      backupSigningKey: migration.backupSigningKey,
    })),
    (error: unknown) => isCommittedRedisMigrationFailure(
      error,
      "HUB_REDIS_MIGRATION_AUTHORITY_CHANGED",
      migration.recoveryPaths,
      null,
    ),
  );
  assert.equal(swapped, true);
});

test("Redis logical restore atomically switches snapshots and supports rollback", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const dataRoot = fixture.projectRuntimeRoot;
  await mkdir(dataRoot, { recursive: true });
  await createJob(fixture.root, {
    project: fixture.projectId,
    jobId: "job-before-restore",
    task: "before restore",
    dataRoot,
  });
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const firstToken = `snapshot-a-${randomBytes(24).toString("base64url")}`;
  assert.equal((await backend.acquireMaintenance(firstToken, "capture A", 10_000)).acquired, true);
  const snapshotA = await backend.exportSnapshot(firstToken);
  assert.equal(await backend.releaseMaintenance(firstToken), true);

  await updateProject(fixture.hubRoot, fixture.projectId, { name: "state-b" });
  await createJob(fixture.root, {
    project: fixture.projectId,
    jobId: "job-after-snapshot",
    task: "after snapshot",
    dataRoot,
  });
  const restoreToken = `restore-${randomBytes(24).toString("base64url")}`;
  assert.equal((await backend.acquireMaintenance(restoreToken, "restore test", 20_000)).acquired, true);
  try {
    const snapshotB = await backend.exportSnapshot(restoreToken);
    const tampered = JSON.parse(JSON.stringify(snapshotA));
    tampered.hashFields[0][1] = `${tampered.hashFields[0][1]}-tampered`;
    await assert.rejects(backend.restoreSnapshot(restoreToken, tampered), { code: "HUB_REGISTRY_INVALID" });
    const unchangedB = await backend.exportSnapshot(restoreToken);
    assert.deepEqual(unchangedB.hashFields, snapshotB.hashFields);
    assert.deepEqual(unchangedB.jobStreams, snapshotB.jobStreams);

    const restoredA = await backend.restoreSnapshot(restoreToken, snapshotA);
    assert.equal((await loadRegistry(fixture.hubRoot)).projects[fixture.projectId].name, "project");
    assert.equal((await getJob(fixture.root, fixture.projectId, "job-before-restore", { dataRoot }))?.status, "running");
    assert.equal(await getJob(fixture.root, fixture.projectId, "job-after-snapshot", { dataRoot }), null);
    assert.ok(Number(new Map(restoredA.hashFields).get("leaderEpoch")) >= 1);

    const rolledBackB = await backend.restoreSnapshot(restoreToken, snapshotB);
    assert.equal((await loadRegistry(fixture.hubRoot)).projects[fixture.projectId].name, "state-b");
    assert.equal((await getJob(fixture.root, fixture.projectId, "job-after-snapshot", { dataRoot }))?.status, "running");
    assert.ok(Number(new Map(rolledBackB.hashFields).get("leaderEpoch")) > Number(new Map(restoredA.hashFields).get("leaderEpoch")));
  } finally {
    assert.equal(await backend.releaseMaintenance(restoreToken), true);
  }
});

test("Redis job event append atomically advances projection and stream", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const field = "job:cHJvamVjdA:am9iLTE";
  const firstEvent = JSON.stringify({ type: "job_created", jobId: "job-1", project: "project" });
  const first = await backend.appendJobEvent(field, 0, {
    project: "project", jobId: "job-1", status: "pending", eventCount: 1,
  }, firstEvent);
  assert.equal(first.committed, true);
  assert.equal(first.revision, 1);

  const stale = await backend.appendJobEvent(field, 0, {
    project: "project", jobId: "job-1", status: "failed", eventCount: 1,
  }, JSON.stringify({ type: "job_failed" }));
  assert.equal(stale.committed, false);
  assert.equal(stale.revision, 1);

  const secondEvent = JSON.stringify({ type: "phase_started", jobId: "job-1", phase: "plan" });
  assert.equal((await backend.appendJobEvent(field, 1, {
    project: "project", jobId: "job-1", status: "running", eventCount: 2,
  }, secondEvent)).committed, true);
  assert.deepEqual(await backend.readJobEvents(field), [firstEvent, secondEvent]);
  const projection = await backend.readStateRecord(field);
  assert.equal(projection.revision, 2);
  assert.equal((projection.data as { status?: string }).status, "running");
});

test("Redis retention atomically purges terminal job streams and expires tombstones", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const field = "job:cHJvamVjdA:am9iLXJldGVudGlvbg";
  const firstEvent = JSON.stringify({ type: "job_created", jobId: "job-retention", project: "project" });
  const terminalEvent = JSON.stringify({ type: "job_completed", jobId: "job-retention", project: "project" });
  assert.equal((await backend.appendJobEvent(field, 0, {
    project: "project", jobId: "job-retention", status: "running", eventCount: 1,
  }, firstEvent)).committed, true);
  assert.equal((await backend.appendJobEvent(field, 1, {
    project: "project", jobId: "job-retention", status: "completed", eventCount: 2,
  }, terminalEvent)).committed, true);

  const token = `retention-${randomBytes(24).toString("base64url")}`;
  await assert.rejects(backend.purgeTerminalJob(token, field, 2), { code: "HUB_MAINTENANCE_ACTIVE" });
  assert.equal((await backend.acquireMaintenance(token, "retention test", 10_000)).acquired, true);
  try {
    const purged = await backend.purgeTerminalJob(token, field, 2);
    assert.deepEqual(purged, { purged: true, terminal: true, revision: 3 });
    assert.deepEqual(await backend.readJobEvents(field), []);
    const tombstone = await backend.readStateRecord(field);
    assert.equal(tombstone.revision, 3);
    assert.equal(tombstone.data, null);
    assert.ok(Number.isSafeInteger(tombstone.deletedAtMs));
    assert.equal((await backend.scanStateRecords("job:")).some((entry) => entry.field === field), false);
    assert.equal((await backend.scanStateRecords("job:", true)).some((entry) => entry.field === field), true);

    const tooRecent = await backend.deleteExpiredTombstone(
      token, field, 3, Number(tombstone.deletedAtMs) - 1,
    );
    assert.deepEqual(tooRecent, { deleted: false, eligible: false, revision: 3 });
    const deleted = await backend.deleteExpiredTombstone(
      token, field, 3, Number(tombstone.deletedAtMs),
    );
    assert.deepEqual(deleted, { deleted: true, eligible: true, revision: 3 });
    assert.deepEqual(await backend.readStateRecord(field), { revision: 0, data: null });

  } finally {
    assert.equal(await backend.releaseMaintenance(token), true);
  }
  const delayed = await backend.appendJobEvent(field, 2, {
    project: "project", jobId: "job-retention", status: "failed", eventCount: 3,
  }, JSON.stringify({ type: "job_failed" }));
  assert.deepEqual(delayed, { committed: false, revision: 0, streamId: null });
});

test("Hub Redis retention previews by default and requires explicit execution", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const field = "job:cHJvamVjdA:am9iLXJldGVudGlvbi1zZXJ2aWNl";
  const oldTimestamp = "2020-01-01T00:00:00.000Z";
  assert.equal((await backend.appendJobEvent(field, 0, {
    project: "project",
    jobId: "job-retention-service",
    status: "completed",
    updatedAt: oldTimestamp,
  }, JSON.stringify({
    type: "job_completed", project: "project", jobId: "job-retention-service", ts: oldTimestamp,
  }))).committed, true);

  const preview = await runHubRedisRetention({
    hubRoot: fixture.hubRoot,
    before: "2021-01-01T00:00:00.000Z",
    tombstonesBefore: "2021-01-01T00:00:00.000Z",
  });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.terminalJobs.map((candidate) => candidate.field), [field]);
  assert.equal((await backend.readJobEvents(field)).length, 1);

  const executed = await runHubRedisRetention({
    hubRoot: fixture.hubRoot,
    before: "2021-01-01T00:00:00.000Z",
    tombstonesBefore: "2021-01-01T00:00:00.000Z",
    dryRun: false,
  });
  assert.equal(executed.result.jobsPurged, 1);
  assert.deepEqual(await backend.readJobEvents(field), []);
  const tombstone = await backend.readStateRecord(field);
  assert.equal(tombstone.data, null);
  assert.ok(Number.isSafeInteger(tombstone.deletedAtMs));
});

test("Redis event store preserves concurrent events and seals terminal jobs", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const dataRoot = path.join(fixture.root, "event-runtime");
  await mkdir(dataRoot, { recursive: true });
  const opts = { dataRoot };
  await appendEvent(fixture.root, "project", "job-event-store", {
    type: "job_created", jobId: "job-event-store", project: "project", task: "shared events", ts: new Date().toISOString(),
  }, opts);
  await Promise.all([
    appendEvent(fixture.root, "project", "job-event-store", {
      type: "phase_activity", jobId: "job-event-store", project: "project", phase: "plan", message: "one", ts: new Date().toISOString(),
    }, opts),
    appendEvent(fixture.root, "project", "job-event-store", {
      type: "phase_activity", jobId: "job-event-store", project: "project", phase: "plan", message: "two", ts: new Date().toISOString(),
    }, opts),
  ]);
  await appendEvent(fixture.root, "project", "job-event-store", {
    type: "job_completed", jobId: "job-event-store", project: "project", ts: new Date().toISOString(),
  }, opts);
  assert.equal(await appendEvent(fixture.root, "project", "job-event-store", {
    type: "phase_failed", jobId: "job-event-store", project: "project", phase: "verify", ts: new Date().toISOString(),
  }, opts), null);
  const events = await readEvents(fixture.root, "project", "job-event-store", opts);
  assert.equal(events.length, 4);
  assert.deepEqual(events.slice(1, 3).map((event) => event.message).sort(), ["one", "two"]);
  assert.equal(materializeJob(events).status, "completed");
  assert.equal((await getJob(fixture.root, "project", "job-event-store", { dataRoot }))?.status, "completed");
  assert.deepEqual((await listJobs(fixture.root, { project: "project", dataRoot })).map((job) => job.jobId), ["job-event-store"]);
  await assert.rejects(readFile(path.join(dataRoot, "events", "project", "job-event-store.jsonl")), { code: "ENOENT" });
});

test("Redis event cutover refuses to hide a local job event log", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const dataRoot = path.join(fixture.root, "local-event-runtime");
  const eventDir = path.join(dataRoot, "events", "project");
  await mkdir(eventDir, { recursive: true });
  await writeFile(path.join(eventDir, "job-local.jsonl"), `${JSON.stringify({ type: "job_created", jobId: "job-local", project: "project" })}\n`);
  await assert.rejects(readEvents(fixture.root, "project", "job-local", { dataRoot }), {
    code: "HUB_JOB_MIGRATION_REQUIRED",
  });
});

test("Redis job service lifecycle is visible without local indexes or event files", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const dataRoot = path.join(fixture.root, "job-service-runtime");
  await mkdir(dataRoot, { recursive: true });
  const created = await createJob(fixture.root, {
    project: "project", jobId: "job-service", task: "shared job lifecycle",
    workflow: "standard", planMode: "full", dataRoot,
  });
  assert.equal(created?.status, "running");
  await startPhase(fixture.root, "project", "job-service", { phase: "plan", attempt: 1, dataRoot });
  await failJob(fixture.root, "project", "job-service", { phase: "plan", reason: "expected failure", dataRoot });
  assert.equal((await getJob(fixture.root, "project", "job-service", { dataRoot }))?.status, "failed");
  assert.equal((await listJobs(fixture.root, { project: "project", dataRoot })).some((job) => job.jobId === "job-service"), true);
  await assert.rejects(readFile(path.join(dataRoot, "events", "project", "job-service.jsonl")), { code: "ENOENT" });
  await rm(path.join(dataRoot, "jobs-index.json"), { force: true });
  assert.equal((await listJobs(fixture.root, { project: "project", dataRoot })).some((job) => job.jobId === "job-service"), true);
});

test("Redis-aware backup and restore atomically recover filesystem and Redis state", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  await mkdir(fixture.projectRuntimeRoot, { recursive: true });
  const output = path.join(fixture.root, "backup");
  const backup = await createHubBackup({
    cpbRoot: fixture.root,
    hubRoot: fixture.hubRoot,
    output,
    allowUnsignedDev: true,
  });
  assert.equal(backup.manifest.redisSnapshot?.format, "cpb-hub-redis-logical-snapshot/v1");
  assert.equal(backup.manifest.redisSnapshot?.backendIdentityFingerprint.length, 64);
  const snapshotPath = path.join(output, "data", "roots", "hub", String(backup.manifest.redisSnapshot?.path));
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  assert.equal(snapshot.sha256, backup.manifest.redisSnapshot?.logicalSha256);
  assert.equal((await readdir(fixture.hubRoot)).some((name) => name.startsWith(".cpb-redis-logical-snapshot-")), false);
  await updateProject(fixture.hubRoot, fixture.projectId, { name: "state-after-backup" });
  await createJob(fixture.root, {
    project: fixture.projectId,
    jobId: "job-after-backup",
    task: "must disappear after restore",
    dataRoot: fixture.projectRuntimeRoot,
  });
  const restored = await restoreHubBackup({
    cpbRoot: fixture.root,
    hubRoot: fixture.hubRoot,
    input: output,
    force: true,
    allowUnsignedDev: true,
  });
  assert.equal(restored.snapshotId, backup.manifest.snapshotId);
  assert.equal((await loadRegistry(fixture.hubRoot)).projects[fixture.projectId].name, "project");
  assert.equal(await getJob(fixture.root, fixture.projectId, "job-after-backup", { dataRoot: fixture.projectRuntimeRoot }), null);
  assert.equal((await readdir(fixture.hubRoot)).some((name) => name.startsWith(".cpb-redis-logical-snapshot-")), true);
  assert.deepEqual(await recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot }), { recovered: false });
  assert.equal((await readdir(fixture.hubRoot)).some((name) => name.startsWith(".cpb-redis-logical-snapshot-")), false);
});

test("Redis-aware backup refuses non-terminal shared workers", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  await mkdir(fixture.projectRuntimeRoot, { recursive: true });
  const workers = new WorkerStore(fixture.hubRoot);
  await workers.init();
  await workers.registerWorker("w-backup-active", {
    projectId: fixture.projectId,
    status: "ready",
    incarnationToken: "backup-active-incarnation",
  });

  const output = path.join(fixture.root, "active-worker-backup");
  await assert.rejects(createHubBackup({
    cpbRoot: fixture.root,
    hubRoot: fixture.hubRoot,
    output,
    allowUnsignedDev: true,
  }), /Redis worker w-backup-active is ready/);
  await assert.rejects(readFile(output), { code: "ENOENT" });

  await workers.updateWorkerIf("w-backup-active", { status: "exited" }, {
    incarnationToken: "backup-active-incarnation",
  });
  const backup = await createHubBackup({ cpbRoot: fixture.root, hubRoot: fixture.hubRoot, output, allowUnsignedDev: true });
  assert.equal(backup.output, output);
});

test("Redis-aware restore rolls back or completes across durable crash windows", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  await mkdir(fixture.projectRuntimeRoot, { recursive: true });
  const stateDir = path.join(fixture.hubRoot, "state");
  await mkdir(stateDir, { recursive: true });
  const marker = path.join(stateDir, "restore-marker.txt");
  await writeFile(marker, "state-a\n", "utf8");
  const output = path.join(fixture.root, "crash-window-backup");
  await createHubBackup({ cpbRoot: fixture.root, hubRoot: fixture.hubRoot, output, allowUnsignedDev: true });

  await updateProject(fixture.hubRoot, fixture.projectId, { name: "state-b" });
  await writeFile(marker, "state-b\n", "utf8");
  await createJob(fixture.root, {
    project: fixture.projectId,
    jobId: "job-state-b",
    task: "rollback evidence",
    dataRoot: fixture.projectRuntimeRoot,
  });
  await assert.rejects(restoreHubBackup({
    cpbRoot: fixture.root,
    hubRoot: fixture.hubRoot,
    input: output,
    force: true,
    allowUnsignedDev: true,
    faultInjector: (phase) => {
      if (phase === "redis_after_commit") throw new Error("fault after Redis commit");
    },
  }), /fault after Redis commit/);
  assert.equal((await loadRegistry(fixture.hubRoot)).projects[fixture.projectId].name, "state-b");
  assert.equal(await readFile(marker, "utf8"), "state-b\n");
  assert.equal((await getJob(fixture.root, fixture.projectId, "job-state-b", {
    dataRoot: fixture.projectRuntimeRoot,
  }))?.status, "running");
  await assert.rejects(readFile(hubRestoreJournalPath(fixture.hubRoot), "utf8"), { code: "ENOENT" });

  const restored = await restoreHubBackup({
    cpbRoot: fixture.root,
    hubRoot: fixture.hubRoot,
    input: output,
    force: true,
    allowUnsignedDev: true,
    faultInjector: (phase) => {
      if (phase === "filesystem_after_target_rename") throw new Error("fault after target rename");
    },
  });
  assert.ok(restored.snapshotId);
  assert.equal((await loadRegistry(fixture.hubRoot)).projects[fixture.projectId].name, "project");
  assert.equal(await readFile(marker, "utf8"), "state-a\n");
  assert.equal(await getJob(fixture.root, fixture.projectId, "job-state-b", {
    dataRoot: fixture.projectRuntimeRoot,
  }), null);
  await assert.rejects(readFile(hubRestoreJournalPath(fixture.hubRoot), "utf8"), { code: "ENOENT" });
});

test("Redis restore recovery survives a hard process exit after Redis commit", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  await mkdir(fixture.projectRuntimeRoot, { recursive: true });
  const stateDir = path.join(fixture.hubRoot, "state");
  await mkdir(stateDir, { recursive: true });
  const marker = path.join(stateDir, "hard-crash-marker.txt");
  await writeFile(marker, "state-a\n", "utf8");
  const output = path.join(fixture.root, "hard-crash-backup");
  await createHubBackup({ cpbRoot: fixture.root, hubRoot: fixture.hubRoot, output, allowUnsignedDev: true });
  await updateProject(fixture.hubRoot, fixture.projectId, { name: "state-b" });
  await writeFile(marker, "state-b\n", "utf8");

  const moduleUrl = new URL("../../server/services/hub/hub-backup.js", import.meta.url).href;
  const script = `
    import { restoreHubBackup } from ${JSON.stringify(moduleUrl)};
    const [cpbRoot, hubRoot, input] = process.argv.slice(1);
    await restoreHubBackup({
      cpbRoot, hubRoot, input, force: true, allowUnsignedDev: true,
      faultInjector(phase) {
        if (phase === "redis_after_commit") process.exit(86);
      },
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, fixture.root, fixture.hubRoot, output], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const childExit = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  assert.equal(childExit, 86, stderr);
  const journal = JSON.parse(await readFile(hubRestoreJournalPath(fixture.hubRoot), "utf8"));
  assert.equal(journal.phase, "redis_restoring");
  assert.equal((await loadRegistry(fixture.hubRoot)).projects[fixture.projectId].name, "project");
  assert.equal(await readFile(marker, "utf8"), "state-b\n");

  const recovered = await recoverInterruptedHubRestore({ hubRoot: fixture.hubRoot });
  assert.equal(recovered.recovered, true);
  assert.equal("outcome" in recovered ? recovered.outcome : null, "rolled_back");
  assert.equal((await loadRegistry(fixture.hubRoot)).projects[fixture.projectId].name, "state-b");
  assert.equal(await readFile(marker, "utf8"), "state-b\n");
  await assert.rejects(readFile(hubRestoreJournalPath(fixture.hubRoot), "utf8"), { code: "ENOENT" });
});

test("Redis access audit preserves one hash chain across concurrent Hub writers", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backendA = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  const backendB = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backendA);
  assert.ok(backendB);
  const writerA = await openHubAccessAudit({ hubRoot: fixture.hubRoot, redisBackend: backendA, maxBytes: 1024 * 1024 });
  const writerB = await openHubAccessAudit({ hubRoot: fixture.hubRoot, redisBackend: backendB, maxBytes: 1024 * 1024 });
  t.after(async () => Promise.all([writerA.close(), writerB.close()]));

  await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? writerA : writerB).append({
    requestId: randomUUID(),
    method: "POST",
    path: `/api/shared-audit/${index}`,
    statusCode: 200,
    outcome: "allowed",
    principalId: `service:${index % 2}`,
    principalSource: "service-token",
    durationMs: index,
  })));

  const verified = await verifyRedisHubAccessAudit(backendA, { maxBytes: 1024 * 1024 });
  assert.equal(verified.recordCount, 40);
  await assert.rejects(
    openHubAccessAudit({ hubRoot: fixture.hubRoot, redisBackend: backendB, maxBytes: 2 * 1024 * 1024 }),
    { code: "HUB_ACCESS_AUDIT_POLICY_MISMATCH" },
  );
  const records = (await backendA.readAccessAuditRecords()).map((serialized) => JSON.parse(serialized));
  assert.deepEqual(records.map((record) => record.sequence), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.equal(records[0].previousHash, "0".repeat(64));
  assert.equal(records.at(-1).hash, verified.lastHash);

  await Promise.all([writerA.close(), writerB.close()]);
  const token = `audit-restore-${randomBytes(24).toString("base64url")}`;
  assert.equal((await backendA.acquireMaintenance(token, "audit continuity test", 10_000)).acquired, true);
  try {
    const snapshot = await backendA.exportSnapshot(token);
    assert.equal(snapshot.hashFields.some(([field]) => field.startsWith("audit")), false);
    const maintenanceWriter = await openHubAccessAudit({
      hubRoot: fixture.hubRoot, redisBackend: backendB, maxBytes: 1024 * 1024,
    });
    await maintenanceWriter.append({
      requestId: randomUUID(), method: "GET", path: "/api/during-restore",
      statusCode: 503, outcome: "error", errorCode: "HUB_MAINTENANCE_ACTIVE", durationMs: 1,
    });
    await maintenanceWriter.close();
    await backendA.restoreSnapshot(token, snapshot);
  } finally {
    assert.equal(await backendA.releaseMaintenance(token), true);
  }
  const afterRestore = await verifyRedisHubAccessAudit(backendA, { maxBytes: 1024 * 1024 });
  assert.equal(afterRestore.recordCount, 41);
  assert.notEqual(afterRestore.lastHash, verified.lastHash);
});

test("Redis access audit cutover refuses to hide a non-empty local chain", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const auditDirectory = path.join(fixture.hubRoot, "audit");
  await mkdir(auditDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(auditDirectory, "http-access.jsonl"), "legacy-audit\n", { mode: 0o600 });
  await assert.rejects(
    openHubAccessAudit({ hubRoot: fixture.hubRoot, redisBackend: backend }),
    { code: "HUB_ACCESS_AUDIT_MIGRATION_REQUIRED" },
  );
});

test("Redis access audit shares one fail-closed capacity without corrupting its chain", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const maxBytes = 64 * 1024;
  const writer = await openHubAccessAudit({ hubRoot: fixture.hubRoot, redisBackend: backend, maxBytes });
  t.after(() => writer.close());
  let exhausted = false;
  for (let index = 0; index < 100; index += 1) {
    try {
      await writer.append({
        requestId: randomUUID(), method: "GET", path: `/${"x".repeat(4_000)}-${index}`,
        statusCode: 200, outcome: "allowed", durationMs: 1,
      });
    } catch (error) {
      assert.equal((error as { code?: string }).code, "HUB_ACCESS_AUDIT_CAPACITY_EXHAUSTED");
      exhausted = true;
      break;
    }
  }
  assert.equal(exhausted, true);
  const verified = await verifyRedisHubAccessAudit(backend, { maxBytes });
  assert.ok(verified.recordCount > 0);
  assert.ok(verified.sizeBytes <= maxBytes);
  assert.equal((await backend.readAccessAuditRecords()).length, verified.recordCount);
});

test("Redis access audit exports a signed independently verifiable chain", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const writer = await openHubAccessAudit({ hubRoot: fixture.hubRoot, redisBackend: backend, maxBytes: 1024 * 1024 });
  for (let index = 0; index < 3; index += 1) {
    await writer.append({
      requestId: randomUUID(), method: "GET", path: `/api/export/${index}`,
      statusCode: 200, outcome: "allowed", durationMs: index,
    });
  }
  await writer.close();
  const output = path.join(fixture.root, "redis-audit-export");
  const key = "redis-audit-export-signing-key-1234567890";
  const exported = await exportRedisHubAccessAudit({
    backend, hubRoot: fixture.hubRoot, output, maxBytes: 1024 * 1024, signingKey: key,
  });
  assert.equal(exported.manifest.recordCount, 3);
  const verified = await verifyRedisHubAccessAuditExport({ input: output, signingKey: key, requireSignature: true });
  assert.equal(verified.signatureVerified, true);
  assert.equal(verified.manifest.lastHash, exported.manifest.lastHash);

  await writeFile(path.join(output, "http-access.jsonl"), "tampered\n", { flag: "a" });
  await assert.rejects(
    verifyRedisHubAccessAuditExport({ input: output, signingKey: key, requireSignature: true }),
    { code: "HUB_ACCESS_AUDIT_EXPORT_INVALID" },
  );
});

test("Redis access audit survives concurrent processes and a hard writer exit", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const stateModule = new URL("../../shared/hub-state-redis.js", import.meta.url).href;
  const auditModule = new URL("../../server/services/audit/hub-access-audit.js", import.meta.url).href;
  const childScript = (count: number, delayMs: number) => [
    `const { randomUUID } = await import("node:crypto");`,
    `const { setTimeout: delay } = await import("node:timers/promises");`,
    `const { openHubRedisStateBackend } = await import(${JSON.stringify(stateModule)});`,
    `const { openHubAccessAudit } = await import(${JSON.stringify(auditModule)});`,
    `const backend = await openHubRedisStateBackend({ configFile: ${JSON.stringify(fixture.configFile)}, hubRoot: ${JSON.stringify(fixture.hubRoot)} });`,
    `const writer = await openHubAccessAudit({ hubRoot: ${JSON.stringify(fixture.hubRoot)}, redisBackend: backend, maxBytes: 1048576 });`,
    `for (let index = 0; index < ${count}; index += 1) {`,
    `  await writer.append({ requestId: randomUUID(), method: "POST", path: "/child/" + process.pid + "/" + index, statusCode: 200, outcome: "allowed", durationMs: 1 });`,
    `  process.stdout.write("ok\\n");`,
    delayMs > 0 ? `  await delay(${delayMs});` : "",
    `}`,
    `await writer.close();`,
  ].filter(Boolean).join("\n");
  const runChild = async (count: number) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript(count, 0)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, { code: 0, signal: null }, Buffer.concat(stderr).toString("utf8"));
  };
  await Promise.all([runChild(20), runChild(20)]);
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  assert.equal((await verifyRedisHubAccessAudit(backend, { maxBytes: 1024 * 1024 })).recordCount, 40);

  const doomed = spawn(process.execPath, ["--input-type=module", "--eval", childScript(1_000, 2)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let acknowledged = 0;
  let stdout = "";
  doomed.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    acknowledged = stdout.split("\n").length - 1;
    if (acknowledged >= 5 && doomed.exitCode === null) doomed.kill("SIGKILL");
  });
  const killed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    doomed.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(killed.signal, "SIGKILL");
  assert.ok(acknowledged >= 5);
  const afterCrash = await verifyRedisHubAccessAudit(backend, { maxBytes: 1024 * 1024 });
  assert.ok(afterCrash.recordCount >= 45);

  const successor = await openHubAccessAudit({ hubRoot: fixture.hubRoot, redisBackend: backend, maxBytes: 1024 * 1024 });
  await successor.append({
    requestId: randomUUID(), method: "POST", path: "/successor",
    statusCode: 200, outcome: "allowed", durationMs: 1,
  });
  await successor.close();
  const final = await verifyRedisHubAccessAudit(backend, { maxBytes: 1024 * 1024 });
  assert.equal(final.recordCount, afterCrash.recordCount + 1);
});

test("Redis access audit recovers after a stable endpoint outage without restarting Hub", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const writer = await openHubAccessAudit({ hubRoot: fixture.hubRoot, redisBackend: backend, maxBytes: 1024 * 1024 });
  await writer.append({
    requestId: randomUUID(), method: "GET", path: "/before-failover",
    statusCode: 200, outcome: "allowed", durationMs: 1,
  });
  await runRedisCli(fixture.port, ["SAVE"]);
  await stopChild(fixture.redisProcess);
  await assert.rejects(writer.append({
    requestId: randomUUID(), method: "GET", path: "/during-failover",
    statusCode: 503, outcome: "error", durationMs: 1,
  }), { code: "HUB_STATE_BACKEND_UNAVAILABLE" });
  assert.equal(writer.status().healthy, true);

  const replacement = spawn("redis-server", [
    "--bind", "127.0.0.1",
    "--protected-mode", "yes",
    "--port", String(fixture.port),
    "--save", "",
    "--appendonly", "no",
    "--dir", fixture.root,
    "--dbfilename", "state.rdb",
    "--logfile", path.join(fixture.root, "redis-replacement.log"),
  ], { stdio: "ignore" });
  t.after(() => stopChild(replacement));
  await waitForRedis(fixture.port, replacement);
  await writer.append({
    requestId: randomUUID(), method: "GET", path: "/after-failover",
    statusCode: 200, outcome: "allowed", durationMs: 1,
  });
  await writer.close();
  const verified = await verifyRedisHubAccessAudit(backend, { maxBytes: 1024 * 1024 });
  assert.equal(verified.recordCount, 2);
});

test("Redis shared state and audit recover through a stable endpoint after replica promotion", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  if (!await commandExists("redis-cli")) {
    t.skip("redis-cli is not installed");
    return;
  }
  await runRedisCli(fixture.port, ["CONFIG", "SET", "repl-diskless-sync-delay", "0"]);

  const replicaRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-redis-promoted-replica-"));
  const replicaPort = await reservePort();
  const replica = spawn("redis-server", [
    "--bind", "127.0.0.1",
    "--protected-mode", "yes",
    "--port", String(replicaPort),
    "--save", "",
    "--appendonly", "no",
    "--dir", replicaRoot,
    "--dbfilename", "state.rdb",
    "--logfile", path.join(replicaRoot, "redis.log"),
    "--replicaof", "127.0.0.1", String(fixture.port),
  ], { stdio: "ignore" });
  t.after(async () => {
    await stopChild(replica);
    await rm(replicaRoot, { recursive: true, force: true });
  });
  await waitForRedis(replicaPort, replica);

  const proxy = await startStableRedisProxy(fixture.port);
  t.after(() => proxy.close());
  const baseConfig = JSON.parse(await readFile(fixture.configFile, "utf8"));
  const stableConfig = path.join(fixture.root, "redis-stable-endpoint.json");
  await writeFile(stableConfig, `${JSON.stringify({
    ...baseConfig,
    url: `redis://127.0.0.1:${proxy.port}/0`,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(stableConfig, 0o600);
  const replicaConfig = path.join(replicaRoot, "redis-state.json");
  await writeFile(replicaConfig, `${JSON.stringify({
    ...baseConfig,
    url: `redis://127.0.0.1:${replicaPort}/0`,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(replicaConfig, 0o600);

  const backend = await openHubRedisStateBackend({ configFile: stableConfig, hubRoot: fixture.hubRoot });
  const replicaBackend = await openHubRedisStateBackend({ configFile: replicaConfig, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  assert.ok(replicaBackend);
  await backend.preflight();
  const initialRegistry = await backend.readRegistry();
  assert.ok(initialRegistry);
  const writer = await openHubAccessAudit({
    hubRoot: fixture.hubRoot,
    redisBackend: backend,
    maxBytes: 1024 * 1024,
  });
  await writer.append({
    requestId: randomUUID(), method: "GET", path: "/before-promotion",
    statusCode: 200, outcome: "allowed", durationMs: 1,
  });

  let replicaCaughtUp = false;
  let replicaRegistry: string | null = null;
  let replicaAuditCount: number | null = null;
  let replicaAuditError: string | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    replicaRegistry = await replicaBackend.readRegistry().catch(() => null);
    const audit = await verifyRedisHubAccessAudit(replicaBackend, { maxBytes: 1024 * 1024 }).catch((error) => {
      replicaAuditError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return null;
    });
    replicaAuditCount = audit?.recordCount ?? null;
    if (replicaRegistry === initialRegistry && replicaAuditCount === 1) {
      replicaCaughtUp = true;
      break;
    }
    await delay(25);
  }
  if (!replicaCaughtUp) {
    const replicationInfo = await runRedisCli(replicaPort, ["INFO", "replication"]);
    assert.fail(`replica did not receive registry and audit state before promotion: ${JSON.stringify({
      registryMatches: replicaRegistry === initialRegistry,
      auditCount: replicaAuditCount,
      auditError: replicaAuditError,
      replicationInfo,
    })}`);
  }

  await runRedisCli(replicaPort, ["REPLICAOF", "NO", "ONE"]);
  let promoted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await replicaBackend.preflight();
      promoted = true;
      break;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
      if (code !== "HUB_STATE_BACKEND_NOT_PRIMARY") throw error;
      await delay(25);
    }
  }
  assert.equal(promoted, true, "replica was not promoted to a writable primary");
  proxy.switchTarget(replicaPort);
  await stopChild(fixture.redisProcess);

  let registryCommitted = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const serialized = await backend.readRegistry();
      assert.ok(serialized);
      const registry = JSON.parse(serialized);
      const expectedRevision = Number(registry.revision);
      registry.revision = expectedRevision + 1;
      registry.projects[fixture.projectId].metadata = {
        ...(registry.projects[fixture.projectId].metadata || {}),
        promotedPrimary: true,
      };
      const result = await backend.compareAndSwapRegistry(
        expectedRevision,
        registry.revision,
        `${JSON.stringify(registry, null, 2)}\n`,
      );
      if (result.committed) {
        registryCommitted = true;
        break;
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
      if (code !== "HUB_STATE_BACKEND_UNAVAILABLE") throw error;
    }
    await delay(25);
  }
  assert.equal(registryCommitted, true, "stable endpoint did not recover registry writes after promotion");

  await writer.append({
    requestId: randomUUID(), method: "GET", path: "/after-promotion",
    statusCode: 200, outcome: "allowed", durationMs: 1,
  });
  await writer.close();
  const verified = await verifyRedisHubAccessAudit(backend, { maxBytes: 1024 * 1024 });
  assert.equal(verified.recordCount, 2);
  const recoveredRegistry = JSON.parse(String(await backend.readRegistry()));
  assert.equal(recoveredRegistry.projects[fixture.projectId].metadata.promotedPrimary, true);
  const readiness = await checkHubStateBackend(fixture.hubRoot, {
    CPB_HUB_STATE_REDIS_CONFIG_FILE: stableConfig,
    CPB_HUB_WORKER_BROKER_URL: "http://127.0.0.1:1",
  });
  assert.equal(readiness.status, "warn");
  assert.equal((readiness.details as { topology: string }).topology, "stable-primary-endpoint");
});

test("two Redis-backed Hub API nodes preserve service and audit continuity across a rolling stop", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const first = await startHubServer({
    cpbRoot: fixture.root, hubRoot: fixture.hubRoot, host: "127.0.0.1", port: 0, allowAnonymousDev: true,
  });
  const second = await startHubServer({
    cpbRoot: fixture.root, hubRoot: fixture.hubRoot, host: "127.0.0.1", port: 0, allowAnonymousDev: true,
  });
  let firstClosed = false;
  let secondClosed = false;
  t.after(async () => {
    if (!firstClosed) await first.close().catch(() => {});
    if (!secondClosed) await second.close().catch(() => {});
  });
  const responses = await Promise.all(Array.from({ length: 40 }, (_, index) => fetch(
    `${index % 2 === 0 ? first.url : second.url}/api/projects`,
  )));
  assert.ok(responses.every((response) => response.status === 200));
  await first.close();
  firstClosed = true;
  assert.equal((await fetch(`${second.url}/api/projects`)).status, 200);
  await second.close();
  secondClosed = true;

  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const verified = await verifyRedisHubAccessAudit(backend);
  assert.equal(verified.recordCount, 41);
});

test("worker state broker binds a high-entropy token to worker incarnation and allowed operations", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const workers = new WorkerStore(fixture.hubRoot);
  await workers.init();
  await workers.registerWorker("w-broker", {
    projectId: fixture.projectId,
    status: "ready",
    incarnationToken: "broker-incarnation",
    brokerTokenHash: tokenHash,
  });
  const server = await startHubServer({
    cpbRoot: fixture.root,
    hubRoot: fixture.hubRoot,
    host: "127.0.0.1",
    port: 0,
    bearerToken: "hub-admin-token-that-is-long-enough-1234567890",
  });
  t.after(() => server.close());
  const request = async (authToken: string, op: string, incarnationToken = "broker-incarnation", args: Record<string, unknown> = {}) => {
    return await fetch(`${server.url}/internal/worker-state`, {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ workerId: "w-broker", incarnationToken, op, args }),
    });
  };
  const allowed = await request(token, "worker.hasInbox");
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).result, false);
  const auditBackend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(auditBackend);
  const auditRecords = (await auditBackend.readAccessAuditRecords()).map((line) => JSON.parse(line));
  assert.equal(auditRecords[0].principalId, "worker:w-broker");
  assert.equal(auditRecords[0].principalSource, "worker-broker");
  assert.equal(auditRecords[0].path, "/internal/worker-state/worker.hasInbox");
  assert.equal((await request(randomBytes(32).toString("base64url"), "worker.hasInbox")).status, 401);
  assert.equal((await request(token, "worker.hasInbox", "wrong-incarnation")).status, 401);
  assert.equal((await request(token, "registry.write")).status, 403);
  const replacementHash = createHash("sha256").update("replacement", "utf8").digest("hex");
  const registration = await request(token, "worker.register", "broker-incarnation", {
    meta: { brokerTokenHash: replacementHash, projectId: "other-project", status: "ready" },
  });
  assert.equal(registration.status, 200);
  const registrationRequestId = registration.headers.get("x-cpb-request-id");
  assert.ok(registrationRequestId);
  const registrationAudit = (await auditBackend.readAccessAuditRecords()).map((line) => JSON.parse(line))
    .filter((record) => record.requestId === registrationRequestId);
  assert.deepEqual(registrationAudit.map((record) => record.outcome), ["mutation_intent", "allowed"]);
  assert.ok(registrationAudit.every((record) => record.path === "/internal/worker-state/worker.register"));
  assert.ok(registrationAudit.every((record) => record.principalId === "worker:w-broker"));
  const deniedMutation = await request(randomBytes(32).toString("base64url"), "worker.update", "broker-incarnation", {
    updates: { status: "exited" },
  });
  assert.equal(deniedMutation.status, 401);
  const deniedRequestId = deniedMutation.headers.get("x-cpb-request-id");
  const deniedAudit = (await auditBackend.readAccessAuditRecords()).map((line) => JSON.parse(line))
    .filter((record) => record.requestId === deniedRequestId);
  assert.deepEqual(deniedAudit.map((record) => record.outcome), ["authentication_denied"]);
  assert.equal((await workers.getWorker("w-broker"))?.brokerTokenHash, tokenHash);
  assert.equal((await workers.getWorker("w-broker"))?.projectId, fixture.projectId);
  assert.equal((await request(token, "assignment.assert", "broker-incarnation", {
    assignmentId: "a-not-owned", attempt: 1, identity: {},
  })).status, 403);
  await workers.updateWorkerIf("w-broker", { status: "exited" }, { incarnationToken: "broker-incarnation" });
  assert.equal((await request(token, "worker.hasInbox")).status, 401);
});

test("worker broker scopes job and event writes to the active assignment runtime", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const cpbRoot = path.join(fixture.root, "broker-job-cpb");
  await mkdir(cpbRoot, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const workerId = "w-broker-job";
  const incarnationToken = "broker-job-incarnation";
  const workers = new WorkerStore(fixture.hubRoot);
  const assignments = new AssignmentStore(fixture.hubRoot);
  await workers.init();
  await assignments.init();
  await workers.registerWorker(workerId, {
    projectId: fixture.projectId,
    status: "ready",
    incarnationToken,
    brokerTokenHash: tokenHash,
  });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: "q-broker-job",
    projectId: fixture.projectId,
    task: "broker-scoped job",
    sourcePath: fixture.sourcePath,
    workflow: "standard",
    planMode: "full",
  });
  const attempt = await assignments.createAttempt(String(assignment.assignmentId), { workerId, orchestratorEpoch: 1 });
  await workers.updateWorkerIf(workerId, {
    status: "running",
    currentAssignmentId: assignment.assignmentId,
    currentAttemptToken: attempt.attemptToken,
  }, { incarnationToken, status: "ready", currentAssignmentId: null });
  const server = await startHubServer({ cpbRoot, hubRoot: fixture.hubRoot, host: "127.0.0.1", port: 0, allowAnonymousDev: true });
  t.after(() => server.close());
  const client = new WorkerBrokerClient({ url: server.url, token, workerId, incarnationToken });
  const jobId = `job-${assignment.entryId}`;
  const untrustedDataRoot = path.join(fixture.root, "caller-selected-runtime");
  assert.equal((await client.getProject(fixture.projectId)).projectRuntimeRoot, fixture.projectRuntimeRoot);
  await client.createJob(cpbRoot, {
    project: fixture.projectId,
    jobId,
    task: "caller must not replace assignment task",
    dataRoot: untrustedDataRoot,
  });
  await client.startPhase(cpbRoot, fixture.projectId, jobId, { phase: "plan", dataRoot: untrustedDataRoot });
  await client.appendEvent(cpbRoot, fixture.projectId, jobId, {
    type: "phase_activity",
    jobId: "job-forged",
    project: "project-forged",
    phase: "plan",
    message: "scoped",
    ts: new Date().toISOString(),
  });
  await client.completePhase(cpbRoot, fixture.projectId, jobId, { phase: "plan", artifact: "plan-1", dataRoot: untrustedDataRoot });
  await client.completeJob(cpbRoot, fixture.projectId, jobId, { dataRoot: untrustedDataRoot });

  const job = await getJob(cpbRoot, fixture.projectId, jobId, { dataRoot: fixture.projectRuntimeRoot });
  assert.equal(job?.status, "completed");
  assert.equal(job?.task, assignment.task);
  const events = await readEvents(cpbRoot, fixture.projectId, jobId, { dataRoot: fixture.projectRuntimeRoot });
  assert.ok(events.every((event) => event.jobId === jobId));
  assert.ok(events.every((event) => !event.project || event.project === fixture.projectId));
  await assert.rejects(
    readFile(path.join(untrustedDataRoot, "events", fixture.projectId, `${jobId}.jsonl`)),
    { code: "ENOENT" },
  );
});

test("Redis lease cutover refuses to hide local lease files", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const dataRoot = path.join(fixture.root, "local-lease-runtime");
  const leaseDir = path.join(dataRoot, "leases");
  await mkdir(leaseDir, { recursive: true });
  await writeFile(path.join(leaseDir, "legacy.json"), `${JSON.stringify({ leaseId: "legacy" })}\n`);
  await assert.rejects(readLease(fixture.root, "legacy", { dataRoot }), {
    code: "HUB_LEASE_MIGRATION_REQUIRED",
  });
});

test("real Redis managed worker creates diagnostics and atomically commits terminal result with inbox ack", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const cpbRoot = path.join(fixture.root, "cpb");
  await mkdir(cpbRoot, { recursive: true });
  const assignments = new AssignmentStore(fixture.hubRoot);
  const workers = new WorkerStore(fixture.hubRoot);
  await assignments.init();
  await workers.init();
  const workerId = "w-real-redis";
  const incarnationToken = "real-redis-incarnation";
  const brokerToken = randomBytes(32).toString("base64url");
  const brokerTokenHash = createHash("sha256").update(brokerToken, "utf8").digest("hex");
  await workers.registerWorker(workerId, {
    projectId: fixture.projectId,
    status: "ready",
    incarnationToken,
    brokerTokenHash,
  });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: "q-real-redis",
    projectId: fixture.projectId,
    task: "blocked Redis worker e2e",
    sourcePath: fixture.sourcePath,
    workflow: "blocked",
    planMode: "none",
  });
  const attempt = await assignments.createAttempt(String(assignment.assignmentId), { workerId, orchestratorEpoch: 1 });
  await workers.updateWorkerIf(workerId, {
    status: "assigned",
    currentAssignmentId: assignment.assignmentId,
    currentAttemptToken: attempt.attemptToken,
  }, { incarnationToken, status: "ready", currentAssignmentId: null });
  await workers.writeInbox(workerId, {
    ...assignment,
    attempt: attempt.attempt,
    attemptToken: attempt.attemptToken,
    orchestratorEpoch: attempt.orchestratorEpoch,
  });
  const brokerServer = await startHubServer({
    cpbRoot,
    hubRoot: fixture.hubRoot,
    host: "127.0.0.1",
    port: 0,
    bearerToken: "hub-admin-token-that-is-long-enough-1234567890",
  });
  t.after(() => brokerServer.close());
  const brokerRequest = async (op: string, args: Record<string, unknown>) => await fetch(`${brokerServer.url}/internal/worker-state`, {
    method: "POST",
    headers: { authorization: `Bearer ${brokerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ workerId, incarnationToken, op, args }),
  });
  assert.equal((await brokerRequest("project.get", { projectId: fixture.projectId })).status, 200);
  assert.equal((await brokerRequest("job.create", {
    project: fixture.projectId,
    jobId: "job-outside-assignment",
    input: { project: fixture.projectId, jobId: "job-outside-assignment" },
  })).status, 403);

  const child = spawn(process.execPath, [
    managedWorkerScript,
    "--worker-id", workerId,
    "--hub-root", fixture.hubRoot,
    "--cpb-root", cpbRoot,
    "--once",
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CPB_ROOT: cpbRoot,
      CPB_HUB_ROOT: fixture.hubRoot,
      CPB_EXECUTOR_ROOT: repoRoot,
      CPB_PROJECT_ROOTS: fixture.root,
      CPB_WORKER_INCARNATION_TOKEN: incarnationToken,
      CPB_HUB_WORKER_BROKER_URL: brokerServer.url,
      CPB_HUB_WORKER_BROKER_TOKEN: brokerToken,
      CPB_HUB_STATE_REDIS_CONFIG_FILE: undefined,
      CPB_CODEGRAPH_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  let workerTimeout: NodeJS.Timeout | null = null;
  const exit = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    new Promise<never>((_resolve, reject) => {
      workerTimeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Redis managed worker timed out: ${stderr}`));
      }, 30_000);
    }),
  ]).finally(() => {
    if (workerTimeout) clearTimeout(workerTimeout);
  });
  assert.equal(exit.code, 0, stderr);
  const terminal = await assignments.getAssignment(String(assignment.assignmentId));
  const completedAttempt = await assignments.getActiveAttempt(String(assignment.assignmentId));
  assert.equal(terminal?.status, "blocked", JSON.stringify(completedAttempt?.result));
  assert.equal(await workers.hasInboxWork(workerId), false);
  const jobId = `job-${assignment.entryId}`;
  assert.equal((await getJob(cpbRoot, fixture.projectId, jobId, {
    dataRoot: fixture.projectRuntimeRoot,
  }))?.status, "blocked");
  await assert.rejects(
    readFile(path.join(fixture.projectRuntimeRoot, "events", fixture.projectId, `${jobId}.jsonl`)),
    { code: "ENOENT" },
  );
  const attemptDir = path.join(fixture.hubRoot, "assignments", String(assignment.assignmentId), "attempts", "001");
  assert.equal(JSON.parse(await readFile(path.join(attemptDir, "accepted.json"), "utf8")).attemptToken, attempt.attemptToken);
});

test("Redis WorkerSupervisor pre-registers broker capability and stops without restart", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const cpbRoot = path.join(fixture.root, "supervised-cpb");
  await mkdir(cpbRoot, { recursive: true });
  const brokerServer = await startHubServer({
    cpbRoot,
    hubRoot: fixture.hubRoot,
    host: "127.0.0.1",
    port: 0,
    bearerToken: "hub-admin-token-that-is-long-enough-1234567890",
  });
  t.after(() => brokerServer.close());
  const previousBrokerUrl = process.env.CPB_HUB_WORKER_BROKER_URL;
  process.env.CPB_HUB_WORKER_BROKER_URL = brokerServer.url;
  const supervisor = new WorkerSupervisor(fixture.hubRoot, cpbRoot, { executorRoot: repoRoot });
  let workerId = "";
  t.after(async () => {
    if (workerId) await supervisor.stopWorker(workerId, "test cleanup").catch(() => {});
    if (previousBrokerUrl === undefined) delete process.env.CPB_HUB_WORKER_BROKER_URL;
    else process.env.CPB_HUB_WORKER_BROKER_URL = previousBrokerUrl;
  });

  const worker = await supervisor.startWorker({ projectId: fixture.projectId });
  workerId = String(worker.workerId);
  const workers = new WorkerStore(fixture.hubRoot);
  const readyDeadline = Date.now() + 5_000;
  let current = await workers.getWorker(workerId);
  while (current?.status !== "ready" && Date.now() < readyDeadline) {
    await delay(25);
    current = await workers.getWorker(workerId);
  }
  assert.equal(current?.status, "ready", JSON.stringify(current));
  assert.equal(typeof current?.brokerTokenHash, "string");

  await supervisor.stopWorker(workerId, "test complete");
  const exitDeadline = Date.now() + 5_000;
  while (!(["exited", "draining"].includes(String(current?.status))) && Date.now() < exitDeadline) {
    await delay(25);
    current = await workers.getWorker(workerId);
  }
  await delay(100);
  current = await workers.getWorker(workerId);
  assert.equal(current?.status, "exited");
  assert.equal(current?.brokerTokenHash, null);
  assert.equal((current?.restartCount as number) || 0, 0);
});

test("released leaders cannot create Redis worker inbox records after failover", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const store = new WorkerStore(fixture.hubRoot);
  await store.init();
  await store.registerWorker("w-fenced", { projectId: fixture.projectId, status: "ready" });
  const oldLeader = new LeaderLock(fixture.hubRoot);
  await oldLeader.acquire();
  const oldEpoch = oldLeader.getEpoch();
  assert.equal(await oldLeader.release(), true);
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const remote = { hubId: "worker-inbox-successor", lockToken: "worker-inbox-successor-token", host: "host-b", pid: 777 };
  const successor = await backend.acquireLeader(remote, 1_000);
  assert.equal(successor.acquired, true);
  assert.equal(successor.leader.epoch, oldEpoch + 1);

  await assert.rejects(store.writeInbox("w-fenced", {
    assignmentId: "a-stale-dispatch",
    entryId: "q-stale-dispatch",
    attempt: 1,
    attemptToken: "stale-token",
  }), { code: "HUB_LEADER_FENCED" });
  assert.equal(await store.hasInboxWork("w-fenced"), false);
  await backend.releaseLeader({ ...remote, epoch: successor.leader.epoch });
});

test("Redis assignments share attempts, heartbeat, cancellation, and terminal result state", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const firstStore = new AssignmentStore(fixture.hubRoot);
  const secondStore = new AssignmentStore(fixture.hubRoot);
  await firstStore.init();
  const assignment = await firstStore.getOrCreateAssignmentForEntry({
    entryId: "q-assignment-shared",
    projectId: fixture.projectId,
    task: "shared assignment state",
    workflow: "standard",
    planMode: "full",
  });
  const attempt = await firstStore.createAttempt(String(assignment.assignmentId), {
    workerId: "w-assignment-shared",
    orchestratorEpoch: 42,
  });
  assert.equal((await secondStore.getAssignment(String(assignment.assignmentId)))?.status, "assigned");
  assert.equal((await secondStore.getActiveAttempt(String(assignment.assignmentId)))?.attemptToken, attempt.attemptToken);

  await secondStore.markRunning(String(assignment.assignmentId), 1);
  await secondStore.recordHeartbeat(String(assignment.assignmentId), 1, { phase: "execute", workerId: "w-assignment-shared" });
  assert.equal(await firstStore.writeCancel(String(assignment.assignmentId), 1, "operator requested"), true);
  assert.equal((await secondStore.readCancel(String(assignment.assignmentId), 1))?.reason, "operator requested");
  await secondStore.completeAttemptFromExistingResult(String(assignment.assignmentId), 1, {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    attemptToken: attempt.attemptToken,
    orchestratorEpoch: 42,
    status: "completed",
    jobResult: { status: "completed" },
  });
  assert.equal((await firstStore.getAssignment(String(assignment.assignmentId)))?.status, "completed");
  const completedAttempt = await firstStore.getActiveAttempt(String(assignment.assignmentId));
  assert.equal(completedAttempt?.status, "completed");
  assert.equal((completedAttempt?.heartbeat as { phase?: string } | undefined)?.phase, "execute");
  assert.equal((completedAttempt?.result as { status?: string } | undefined)?.status, "completed");
  await assert.rejects(
    readFile(path.join(fixture.hubRoot, "assignments", String(assignment.assignmentId), "state.json")),
    { code: "ENOENT" },
  );
});

test("released leaders cannot create Redis assignment attempts after failover", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const store = new AssignmentStore(fixture.hubRoot);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: "q-stale-assignment",
    projectId: fixture.projectId,
    task: "must remain undispatched",
  });
  const oldLeader = new LeaderLock(fixture.hubRoot);
  await oldLeader.acquire();
  const oldEpoch = oldLeader.getEpoch();
  assert.equal(await oldLeader.release(), true);
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const remote = { hubId: "assignment-successor", lockToken: "assignment-successor-token", host: "host-b", pid: 778 };
  const successor = await backend.acquireLeader(remote, 1_000);
  assert.equal(successor.acquired, true);
  assert.equal(successor.leader.epoch, oldEpoch + 1);

  await assert.rejects(store.createAttempt(String(assignment.assignmentId), {
    workerId: "w-stale",
    orchestratorEpoch: oldEpoch,
  }), { code: "HUB_LEADER_FENCED" });
  assert.equal((await store.getAssignment(String(assignment.assignmentId)))?.attempts, 0);
  await backend.releaseLeader({ ...remote, epoch: successor.leader.epoch });
});

test("a successor reconciler finalizes a Redis assignment without predecessor filesystem artifacts", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const entry = await enqueue(fixture.hubRoot, {
    projectId: fixture.projectId,
    description: "cross-node terminal assignment",
  });
  await updateEntry(fixture.hubRoot, String(entry.id), { status: "in_progress" });
  const assignments = new AssignmentStore(fixture.hubRoot);
  const workers = new WorkerStore(fixture.hubRoot);
  await Promise.all([assignments.init(), workers.init()]);
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: fixture.projectId,
    task: entry.description,
  });
  const attempt = await assignments.createAttempt(String(assignment.assignmentId), {
    workerId: "w-cross-node",
    orchestratorEpoch: 7,
  });
  await workers.registerWorker("w-cross-node", {
    projectId: fixture.projectId,
    status: "running",
    currentAssignmentId: assignment.assignmentId,
    currentAttemptToken: attempt.attemptToken,
  });
  await assignments.markRunning(String(assignment.assignmentId), 1);
  await assignments.completeAttemptFromExistingResult(String(assignment.assignmentId), 1, {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    attemptToken: attempt.attemptToken,
    orchestratorEpoch: 7,
    status: "completed",
    jobResult: { status: "completed" },
  });

  const reconciler = new Reconciler(fixture.hubRoot, {
    assignmentStore: assignments,
    workerStore: workers,
    leaderLock: { stillHeld: async () => true },
    failureRouter: { route: async () => ({ action: "mark_failed" }), resetBudget: () => {} },
  });
  await reconciler.reconcileAssignments();
  const current = (await listQueue(fixture.hubRoot)).find((candidate) => candidate.id === entry.id);
  assert.equal(current?.status, "completed");
  assert.ok((await assignments.getAssignment(String(assignment.assignmentId)))?.queueFinalizedAt);
  assert.ok((await assignments.getAssignment(String(assignment.assignmentId)))?.workerFinalizedAt);
  assert.equal((await workers.getWorker("w-cross-node"))?.status, "ready");
});

test("Redis assignment and worker cutover refuses to hide existing local runtime state", async (t) => {
  const assignmentFixture = await redisFixture(t);
  if (!assignmentFixture) return;
  const seededAssignments = new AssignmentStore(assignmentFixture.hubRoot);
  await seededAssignments.init();
  await seededAssignments.getOrCreateAssignmentForEntry({
    entryId: "q-redis-existing",
    projectId: assignmentFixture.projectId,
    task: "existing Redis assignment",
  });
  const assignmentDir = path.join(assignmentFixture.hubRoot, "assignments", "a-local");
  await mkdir(assignmentDir, { recursive: true });
  await writeFile(path.join(assignmentDir, "state.json"), `${JSON.stringify({ assignmentId: "a-local", status: "running" })}\n`);
  await assert.rejects(new AssignmentStore(assignmentFixture.hubRoot).init(), {
    code: "HUB_ASSIGNMENT_MIGRATION_REQUIRED",
  });

  const workerFixture = await redisFixture(t);
  if (!workerFixture) return;
  const seededWorkers = new WorkerStore(workerFixture.hubRoot);
  await seededWorkers.init();
  await seededWorkers.registerWorker("w-redis-existing", { status: "ready" });
  const registryDir = path.join(workerFixture.hubRoot, "workers", "registry");
  await mkdir(registryDir, { recursive: true });
  await writeFile(path.join(registryDir, "worker-local.json"), `${JSON.stringify({ workerId: "local", status: "running" })}\n`);
  await assert.rejects(new WorkerStore(workerFixture.hubRoot).init(), {
    code: "HUB_WORKER_MIGRATION_REQUIRED",
  });
});

test("a paused queue claim keeps its original process fence and cannot commit after failover", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const entry = await enqueue(fixture.hubRoot, {
    projectId: fixture.projectId,
    description: "paused-claim",
    priority: "P0",
    metadata: { mutating: false },
  });
  const oldLeader = new LeaderLock(fixture.hubRoot);
  await oldLeader.acquire();

  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let entered!: () => void;
  const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
  const claim = claimEligible(fixture.hubRoot, {
    workerId: "paused-worker",
    getProjectFn: async () => {
      entered();
      await blocked;
      return null;
    },
    assignmentStore: { getAssignment: async () => null },
  });
  await callbackEntered;

  const oldEpoch = oldLeader.getEpoch();
  assert.equal(await oldLeader.release(), true);
  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const remote = { hubId: "paused-claim-successor", lockToken: "paused-successor-token", host: "host-b", pid: 401 };
  const successor = await backend.acquireLeader(remote, 1_000);
  assert.equal(successor.acquired, true);
  assert.equal(successor.leader.epoch, oldEpoch + 1);
  unblock();
  await assert.rejects(claim, { code: "HUB_LEADER_FENCED" });
  const current = (await listQueue(fixture.hubRoot)).find((candidate) => candidate.id === entry.id);
  assert.equal(current?.status, "pending");
  assert.equal(current?.claimedBy, null);
  await backend.releaseLeader({ ...remote, epoch: successor.leader.epoch });
});

test("released leader processes keep a stale fence so tail callbacks cannot downgrade to unfenced writes", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const entry = await enqueue(fixture.hubRoot, {
    projectId: fixture.projectId,
    description: "tail-callback-after-release",
  });
  const oldLeader = new LeaderLock(fixture.hubRoot);
  await oldLeader.acquire();
  const oldEpoch = oldLeader.getEpoch();
  assert.equal(await oldLeader.release(), true);

  const backend = await openHubRedisStateBackend({ configFile: fixture.configFile, hubRoot: fixture.hubRoot });
  assert.ok(backend);
  const next = { hubId: "remote-successor", lockToken: "remote-successor-token", host: "host-b", pid: 402 };
  const successor = await backend.acquireLeader(next, 1_000);
  assert.equal(successor.acquired, true);
  assert.equal(successor.leader.epoch, oldEpoch + 1);

  await assert.rejects(updateEntry(fixture.hubRoot, entry.id, { status: "scheduled" }), {
    code: "HUB_LEADER_FENCED",
  });
  const current = (await listQueue(fixture.hubRoot)).find((candidate) => candidate.id === entry.id);
  assert.equal(current?.status, "pending");
  await backend.releaseLeader({ ...next, epoch: successor.leader.epoch });
});

test("Redis queue cutover fails closed when a non-empty local queue still exists", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  await enqueue(fixture.hubRoot, {
    projectId: fixture.projectId,
    description: "existing Redis queue entry",
  });
  const queueDir = path.join(fixture.hubRoot, "queue");
  await mkdir(queueDir, { recursive: true });
  await writeFile(path.join(queueDir, "queue.json"), `${JSON.stringify({
    version: 1,
    entries: [{ id: "local-only", projectId: fixture.projectId, status: "pending" }],
  })}\n`);
  await assert.rejects(listQueue(fixture.hubRoot), { code: "HUB_QUEUE_MIGRATION_REQUIRED" });
  await assert.rejects(enqueue(fixture.hubRoot, {
    projectId: fixture.projectId,
    description: "must-not-hide-local-work",
  }), { code: "HUB_QUEUE_MIGRATION_REQUIRED" });
});

test("Redis queue reads reject malformed stored envelopes instead of normalizing them to empty", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  if (!await commandExists("redis-cli")) {
    t.skip("redis-cli is not installed");
    return;
  }
  const config = JSON.parse(await readFile(fixture.configFile, "utf8"));
  await runRedisCli(fixture.port, [
    "HSET", config.registryKey,
    "queueRevision", "1",
    "queueData", JSON.stringify({ version: 1, entries: [null] }),
  ]);
  const readiness = await checkHubStateBackend(fixture.hubRoot, {
    CPB_HUB_STATE_REDIS_CONFIG_FILE: fixture.configFile,
  });
  assert.equal(readiness.status, "error");
  assert.equal((readiness.details as { code: string }).code, "HUB_QUEUE_INVALID");
  await assert.rejects(listQueue(fixture.hubRoot), { code: "HUB_QUEUE_INVALID" });
});

test("Redis readiness rejects semantically malformed leader state", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  if (!await commandExists("redis-cli")) {
    t.skip("redis-cli is not installed");
    return;
  }
  const config = JSON.parse(await readFile(fixture.configFile, "utf8"));
  await runRedisCli(fixture.port, ["HSET", config.registryKey, "leaderEpoch", "not-an-integer"]);
  const readiness = await checkHubStateBackend(fixture.hubRoot, {
    CPB_HUB_STATE_REDIS_CONFIG_FILE: fixture.configFile,
  });
  assert.equal(readiness.status, "error");
  assert.equal((readiness.details as { code: string }).code, "HUB_LEADER_INVALID");
});

test("Redis registry preserves every update from competing Node processes", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const moduleUrl = new URL("../../server/services/hub/hub-registry.js", import.meta.url).href;
  const script = `
    import { mutateRegistry } from ${JSON.stringify(moduleUrl)};
    const [hubRoot, projectId, iterationsText] = process.argv.slice(1);
    for (let index = 0; index < Number(iterationsText); index += 1) {
      await mutateRegistry(hubRoot, async (registry) => {
        const project = registry.projects[projectId];
        const metadata = project.metadata || {};
        const counter = Number(metadata.redisProcessCounter || 0);
        await new Promise((resolve) => setTimeout(resolve, 2));
        project.metadata = { ...metadata, redisProcessCounter: counter + 1 };
      });
    }
  `;

  await Promise.all(Array.from({ length: 4 }, () => runChild(script, [fixture.hubRoot, fixture.projectId, "8"])));
  const registry = await loadRegistry(fixture.hubRoot);
  assert.equal(registry.projects[fixture.projectId].metadata?.redisProcessCounter, 32);
  assert.equal(registry.revision, 33);
});

test("Redis registry rejects stale save snapshots", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const first = await loadRegistry(fixture.hubRoot);
  const stale = await loadRegistry(fixture.hubRoot);
  first.projects[fixture.projectId].metadata = { committed: true };
  await saveRegistry(fixture.hubRoot, first);

  stale.projects[fixture.projectId].metadata = { staleOverwrite: true };
  await assert.rejects(saveRegistry(fixture.hubRoot, stale), { code: "HUB_REGISTRY_CONFLICT" });
  const registry = await loadRegistry(fixture.hubRoot);
  assert.equal(registry.projects[fixture.projectId].metadata?.committed, true);
  assert.equal(registry.projects[fixture.projectId].metadata?.staleOverwrite, undefined);
});

test("Redis registry readiness preflights the backend without disclosing its endpoint", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const result = await checkHubStateBackend(fixture.hubRoot, {
    CPB_HUB_STATE_REDIS_CONFIG_FILE: fixture.configFile,
    CPB_HUB_WORKER_BROKER_URL: "http://127.0.0.1:1",
  });
  assert.equal(result.status, "warn");
  assert.deepEqual(result.details, {
    mode: "redis-cas",
    topology: "stable-primary-endpoint",
    multiNodeSafe: true,
    activeActiveSafe: false,
    sharedStores: ["registry", "leader", "queue", "assignments", "workers", "workerInbox", "leases", "jobs", "jobEvents", "accessAudit"],
    remainingLocalStores: [],
    accessAudit: { sequence: 0, sizeBytes: 0 },
    workerCredentialIsolation: "worker/incarnation-scoped broker; Redis credential retained by Hub only",
  });
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|redis-state\.json|registryKey|test-/);
});

test("Redis readiness rejects a stable endpoint connected to a replica", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const replicaRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-redis-replica-"));
  const replicaPort = await reservePort();
  const replica = spawn("redis-server", [
    "--bind", "127.0.0.1",
    "--protected-mode", "yes",
    "--port", String(replicaPort),
    "--save", "",
    "--appendonly", "no",
    "--dir", replicaRoot,
    "--dbfilename", "state.rdb",
    "--logfile", path.join(replicaRoot, "redis.log"),
    "--replicaof", "127.0.0.1", String(fixture.port),
  ], { stdio: "ignore" });
  t.after(async () => {
    await stopChild(replica);
    await rm(replicaRoot, { recursive: true, force: true });
  });
  await waitForRedis(replicaPort, replica);

  const config = JSON.parse(await readFile(fixture.configFile, "utf8"));
  const replicaConfig = path.join(replicaRoot, "redis-state.json");
  await writeFile(replicaConfig, `${JSON.stringify({
    ...config,
    url: `redis://127.0.0.1:${replicaPort}/0`,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(replicaConfig, 0o600);

  const backend = await openHubRedisStateBackend({
    configFile: replicaConfig,
    hubRoot: fixture.hubRoot,
  });
  assert.ok(backend);
  await assert.rejects(backend.preflight(), { code: "HUB_STATE_BACKEND_NOT_PRIMARY" });
  const readiness = await checkHubStateBackend(fixture.hubRoot, {
    CPB_HUB_STATE_REDIS_CONFIG_FILE: replicaConfig,
    CPB_HUB_WORKER_BROKER_URL: "http://127.0.0.1:1",
  });
  assert.equal(readiness.status, "error");
  assert.deepEqual(readiness.details, { code: "HUB_STATE_BACKEND_NOT_PRIMARY" });
});

test("Redis readiness fails closed when the managed-worker broker is missing", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const result = await checkHubStateBackend(fixture.hubRoot, {
    CPB_HUB_STATE_REDIS_CONFIG_FILE: fixture.configFile,
  });
  assert.equal(result.status, "error");
  assert.deepEqual(result.details, { code: "HUB_WORKER_BROKER_REQUIRED", mode: "redis-cas" });
});

test("Redis readiness rejects an ACL principal that can ping but cannot commit CAS", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  if (!await commandExists("redis-cli")) {
    t.skip("redis-cli is not installed");
    return;
  }
  const config = JSON.parse(await readFile(fixture.configFile, "utf8"));
  await runRedisCli(fixture.port, [
    "ACL", "SETUSER", "readiness-probe", "reset", "on", ">probe-secret",
    `~${config.registryKey}`, "+ping", "+eval", "+hmget", "+hget", "-hset",
  ]);
  const replacement = `${fixture.configFile}.next`;
  await writeFile(replacement, `${JSON.stringify({
    ...config,
    url: `redis://readiness-probe:probe-secret@127.0.0.1:${fixture.port}/0`,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(replacement, 0o600);
  await rename(replacement, fixture.configFile);

  const result = await checkHubStateBackend(fixture.hubRoot, {
    CPB_HUB_STATE_REDIS_CONFIG_FILE: fixture.configFile,
  });
  assert.equal(result.status, "error");
  assert.equal((result.details as { code: string }).code, "HUB_STATE_BACKEND_UNAVAILABLE");
  const readable = await loadRegistry(fixture.hubRoot);
  assert.ok(readable.projects[fixture.projectId]);
  await assert.rejects(
    updateProject(fixture.hubRoot, fixture.projectId, { name: "must-not-commit" }),
    { code: "HUB_STATE_BACKEND_UNAVAILABLE" },
  );
  assert.doesNotMatch(JSON.stringify(result), /probe-secret|readiness-probe|127\.0\.0\.1/);
});

test("Redis registry atomically reloads non-identity backend config changes", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const original = JSON.parse(await readFile(fixture.configFile, "utf8"));
  const replacement = `${fixture.configFile}.next`;
  await writeFile(replacement, `${JSON.stringify({
    ...original,
    operationTimeoutMs: 3_000,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(replacement, 0o600);
  await rename(replacement, fixture.configFile);

  const reloaded = await loadRegistry(fixture.hubRoot);
  assert.ok(reloaded.projects[fixture.projectId]);
  assert.equal(reloaded.revision, 1);

  await writeFile(replacement, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
  await chmod(replacement, 0o600);
  await rename(replacement, fixture.configFile);
  const restored = await loadRegistry(fixture.hubRoot);
  assert.ok(restored.projects[fixture.projectId]);
  assert.equal(restored.revision, 1);
});

test("Redis registry rejects a live backend identity switch without splitting paused transactions", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const original = JSON.parse(await readFile(fixture.configFile, "utf8"));

  let releaseOld!: () => void;
  const oldMayFinish = new Promise<void>((resolve) => { releaseOld = resolve; });
  let oldStarted!: () => void;
  const oldIsPaused = new Promise<void>((resolve) => { oldStarted = resolve; });
  const oldTransaction = mutateRegistry(fixture.hubRoot, async (registry) => {
    oldStarted();
    await oldMayFinish;
    registry.projects[fixture.projectId].metadata = {
      ...(registry.projects[fixture.projectId].metadata || {}),
      oldTransaction: true,
    };
  });
  await oldIsPaused;

  const replacement = `${fixture.configFile}.next`;
  await writeFile(replacement, `${JSON.stringify({
    ...original,
    registryKey: `${original.registryKey}:new-authority`,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(replacement, 0o600);
  await rename(replacement, fixture.configFile);
  const hubRootAlias = path.join(fixture.root, "hub-alias");
  await symlink(fixture.hubRoot, hubRootAlias, "dir");
  await assert.rejects(
    updateProject(hubRootAlias, fixture.projectId, { metadata: { successor: true } }),
    { code: "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE" },
  );

  releaseOld();
  await oldTransaction;
  await writeFile(replacement, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
  await chmod(replacement, 0o600);
  await rename(replacement, fixture.configFile);
  const registry = await loadRegistry(fixture.hubRoot);
  assert.equal(registry.projects[fixture.projectId].metadata?.oldTransaction, true);
  assert.equal(registry.projects[fixture.projectId].metadata?.successor, undefined);
  assert.equal(registry.revision, 2);
});

test("Hub fails closed with a redacted audit error when shared Redis fails after startup", async (t) => {
  const fixture = await redisFixture(t);
  if (!fixture) return;
  const hub = await startHubServer({
    cpbRoot: fixture.root,
    hubRoot: fixture.hubRoot,
    host: "127.0.0.1",
    port: 0,
    allowAnonymousDev: true,
  });
  t.after(() => hub.close().catch(() => {}));

  fixture.redisProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (fixture.redisProcess.exitCode !== null) resolve();
    else fixture.redisProcess.once("exit", () => resolve());
  });
  const response = await fetch(`${hub.url}/api/projects`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, "HUB_ACCESS_AUDIT_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(body), /127\.0\.0\.1|redis-state\.json|registryKey|test-/);
});

test("Redis state config must be private and errors do not disclose credentials", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cpb-hub-redis-config-"));
  const configFile = path.join(root, "redis-state.json");
  await writeFile(configFile, `${JSON.stringify({
    format: "cpb-hub-state-redis/v1",
    url: "redis://:never-disclose-this@127.0.0.1:1/0",
    registryKey: "cpb:{config-test}:registry",
    connectTimeoutMs: 100,
    operationTimeoutMs: 100,
  })}\n`, { mode: 0o644 });
  const previous = process.env[REDIS_CONFIG_ENV];
  process.env[REDIS_CONFIG_ENV] = configFile;
  t.after(async () => {
    if (previous === undefined) delete process.env[REDIS_CONFIG_ENV];
    else process.env[REDIS_CONFIG_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(loadRegistry(path.join(root, "hub")), (error: unknown) => {
    const value = error as NodeJS.ErrnoException;
    assert.equal(value.code, "HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE");
    assert.doesNotMatch(value.message, /never-disclose-this/);
    return true;
  });

  await chmod(configFile, 0o600);
  await assert.rejects(loadRegistry(path.join(root, "hub")), (error: unknown) => {
    const value = error as NodeJS.ErrnoException;
    assert.equal(value.code, "HUB_STATE_BACKEND_UNAVAILABLE");
    assert.doesNotMatch(value.message, /never-disclose-this/);
    return true;
  });
});
