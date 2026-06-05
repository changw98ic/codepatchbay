import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { takeControlPlaneSnapshot } from "../server/services/control-plane-snapshot.js";
import { WorkerStore } from "../shared/orchestrator/worker-store.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function tempRoot(label) {
  const dir = path.join(repoRoot, ".test-tmp", `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

test("control-plane snapshot reports worker states correctly", async () => {
  const hubRoot = await tempRoot("snapshot-workers");
  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();

  // Register workers in different states
  await workerStore.registerWorker("w-ready", {
    projectId: "proj-a",
    pid: 1001,
    status: "ready",
  });
  await workerStore.registerWorker("w-running", {
    projectId: "proj-b",
    pid: 1002,
    status: "running",
    currentAssignmentId: "a-1",
  });
  await workerStore.registerWorker("w-exhausted", {
    projectId: "proj-a",
    pid: 1003,
    status: "exhausted",
    restartCount: 3,
  });

  const snapshot = await takeControlPlaneSnapshot({ hubRoot, workerStore });

  assert.ok(snapshot.ts, "snapshot should have timestamp");
  assert.equal(snapshot.workers.length, 3);

  const ready = snapshot.workers.find((w) => w.workerId === "w-ready");
  assert.equal(ready.status, "ready");
  assert.equal(ready.projectId, "proj-a");
  assert.equal(ready.stale, false);

  const running = snapshot.workers.find((w) => w.workerId === "w-running");
  assert.equal(running.status, "running");
  assert.equal(running.currentAssignmentId, "a-1");

  const exhausted = snapshot.workers.find((w) => w.workerId === "w-exhausted");
  assert.equal(exhausted.status, "exhausted");
  assert.equal(exhausted.restartCount, 3);

  assert.equal(snapshot.summary.totalWorkers, 3);
  assert.equal(snapshot.summary.workersByStatus.ready, 1);
  assert.equal(snapshot.summary.workersByStatus.running, 1);
  assert.equal(snapshot.summary.workersByStatus.exhausted, 1);

  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
});

test("control-plane snapshot reports assignment heartbeat state", async () => {
  const hubRoot = await tempRoot("snapshot-assignments");
  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();

  // Create assignment with heartbeat
  const assignmentId = "a-test-1";
  const attemptDir = path.join(hubRoot, "assignments", assignmentId, "attempts", "001");
  await writeJson(path.join(attemptDir, "heartbeat.json"), {
    workerId: "w-1",
    assignmentId,
    status: "running",
    phase: "execute",
    activePhase: "execute",
    activeJobId: "job-1",
    progressKind: "phase_result",
    lastProgressType: "phase_result",
    updatedAt: new Date().toISOString(),
    progressUpdatedAt: new Date().toISOString(),
  });
  await writeJson(path.join(attemptDir, "accepted.json"), {
    workerId: "w-1",
    assignmentId,
    acceptedAt: new Date().toISOString(),
  });

  // Create a stale assignment
  const staleId = "a-stale-1";
  const staleDir = path.join(hubRoot, "assignments", staleId, "attempts", "001");
  const staleTs = new Date(Date.now() - 600_000).toISOString(); // 10 min ago
  await writeJson(path.join(staleDir, "heartbeat.json"), {
    workerId: "w-2",
    assignmentId: staleId,
    status: "running",
    phase: "execute",
    updatedAt: staleTs,
    progressUpdatedAt: staleTs,
  });

  const snapshot = await takeControlPlaneSnapshot({ hubRoot, workerStore });

  assert.equal(snapshot.assignments.length, 2);

  const active = snapshot.assignments.find((a) => a.assignmentId === assignmentId);
  assert.equal(active.status, "running");
  assert.equal(active.phase, "execute");
  assert.equal(active.stale, false);

  const stale = snapshot.assignments.find((a) => a.assignmentId === staleId);
  assert.equal(stale.stale, true);
  assert.equal(stale.noProgress, true);

  assert.equal(snapshot.summary.totalAssignments, 2);
  assert.equal(snapshot.summary.staleAssignments, 1);

  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
});

test("control-plane snapshot reports queue entries", async () => {
  const hubRoot = await tempRoot("snapshot-queue");
  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();

  await writeJson(path.join(hubRoot, "queue", "queue.json"), {
    version: 1,
    entries: [
      { id: "e-1", projectId: "proj-a", status: "pending", priority: "P1", description: "fix bug", createdAt: new Date().toISOString() },
      { id: "e-2", projectId: "proj-b", status: "assigned", priority: "P2", description: "add feature", createdAt: new Date().toISOString() },
    ],
  });

  const snapshot = await takeControlPlaneSnapshot({ hubRoot, workerStore });

  assert.equal(snapshot.queue.length, 2);
  assert.equal(snapshot.queue[0].entryId, "e-1");
  assert.equal(snapshot.queue[0].status, "pending");
  assert.equal(snapshot.summary.pendingQueueEntries, 1);

  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
});

test("control-plane snapshot handles empty state gracefully", async () => {
  const hubRoot = await tempRoot("snapshot-empty");
  const workerStore = new WorkerStore(hubRoot);
  await workerStore.init();

  const snapshot = await takeControlPlaneSnapshot({ hubRoot, workerStore });

  assert.ok(snapshot.ts);
  assert.deepEqual(snapshot.workers, []);
  assert.deepEqual(snapshot.assignments, []);
  assert.deepEqual(snapshot.queue, []);
  assert.equal(snapshot.summary.totalWorkers, 0);
  assert.equal(snapshot.summary.totalAssignments, 0);
  assert.equal(snapshot.summary.pendingQueueEntries, 0);

  await rm(hubRoot, { recursive: true, force: true }).catch(() => {});
});
