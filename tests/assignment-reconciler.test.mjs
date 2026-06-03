import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { AssignmentStore } from "../server/orchestrator/assignment-store.js";
import { WorkerStore } from "../server/orchestrator/worker-store.js";
import { Reconciler } from "../server/orchestrator/reconciler.js";
import { enqueue, listQueue, updateEntry } from "../server/services/hub-queue.js";
import { tempRoot, oldIso, readJson, writeJson } from "./helpers.mjs";

function attemptDir(hubRoot, assignmentId, attempt = 1) {
  return path.join(hubRoot, "assignments", assignmentId, "attempts", String(attempt).padStart(3, "0"));
}

function reconciler(hubRoot, assignments, workers, failureRouter = {}) {
  return new Reconciler(hubRoot, {
    assignmentStore: assignments,
    workerStore: workers,
    leaderLock: { stillHeld: async () => true },
    failureRouter: {
      resetBudget: () => {},
      route: async () => ({ action: "mark_failed", reason: "test failure" }),
      ...failureRouter,
    },
  });
}

test("AssignmentStore idempotently rebuilds assignments without losing attempt history", async () => {
  const hubRoot = await tempRoot("cpb-assignment");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const first = await store.getOrCreateAssignmentForEntry({
    entryId: "q-1",
    projectId: "proj",
    task: "first task",
    sourcePath: "/tmp/source-one",
    workflow: "standard",
    planMode: "auto",
    sourceContext: { original: true },
    metadata: { old: true },
  });
  const attempt = await store.createAttempt(first.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });

  const rebuilt = await store.getOrCreateAssignmentForEntry({
    entryId: "q-1",
    projectId: "proj",
    task: "rerouted task",
    sourcePath: "/tmp/source-two",
    workflow: "complex",
    planMode: "full",
    sourceContext: { retry: true },
    metadata: { next: true },
  });

  assert.equal(rebuilt.assignmentId, first.assignmentId);
  assert.equal(rebuilt.status, "scheduled");
  assert.equal(rebuilt.task, "rerouted task");
  assert.equal(rebuilt.sourcePath, "/tmp/source-two");
  assert.equal(rebuilt.sourceContext.original, true);
  assert.equal(rebuilt.sourceContext.retry, true);
  assert.equal(rebuilt.metadata.old, true);
  assert.equal(rebuilt.metadata.next, true);

  const state = await store.getAssignment(first.assignmentId);
  assert.equal(state.attempts, 1);
  assert.equal(state.activeAttempt, 1);
  assert.equal((await store.getActiveAttempt(first.assignmentId)).attemptToken, attempt.attemptToken);
});

test("AssignmentStore rejects result files with mismatched attempt tokens", async () => {
  const hubRoot = await tempRoot("cpb-assignment-token");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: "q-token",
    projectId: "proj",
    task: "token",
  });
  await store.createAttempt(assignment.assignmentId, {
    workerId: "w-token",
    orchestratorEpoch: 1,
  });

  await assert.rejects(
    store.completeAttemptFromExistingResult(assignment.assignmentId, 1, {
      status: "completed",
      attemptToken: "wrong-token",
    }),
    /attempt token mismatch/,
  );
});

test("Reconciler advances assigned assignment from accepted file and queue claim", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-accepted");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "accept me" });
  await updateEntry(hubRoot, entry.id, { status: "scheduled", claimedBy: "w-1", workerId: "w-1" });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "accept me",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "accepted.json"), {
    attemptToken: attempt.attemptToken,
    workerId: "w-1",
  });

  await reconciler(hubRoot, assignments, workers).reconcileAssignments();

  assert.equal((await assignments.getAssignment(assignment.assignmentId)).status, "running");
  assert.equal((await listQueue(hubRoot))[0].status, "in_progress");
});

test("Reconciler finalizes completed result files into queue and worker state", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-result");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "finish me" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", {
    status: "running",
    currentAssignmentId: `a-${entry.id}`,
  });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "finish me",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"), {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    attemptToken: attempt.attemptToken,
    status: "completed",
    jobResult: { status: "completed", jobId: "job-ok" },
  });

  await reconciler(hubRoot, assignments, workers).reconcileAssignments();

  const finalAssignment = await assignments.getAssignment(assignment.assignmentId);
  assert.equal(finalAssignment.status, "completed");
  assert.ok(finalAssignment.queueFinalizedAt);
  assert.ok(finalAssignment.workerFinalizedAt);
  assert.equal((await listQueue(hubRoot))[0].status, "completed");
  const worker = await workers.getWorker("w-1");
  assert.equal(worker.status, "ready");
  assert.equal(worker.currentAssignmentId, null);
});

test("Reconciler writes synthetic failure for stale assignment heartbeat", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-heartbeat");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "stale heartbeat" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "stale heartbeat",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "heartbeat.json"), {
    updatedAt: oldIso(180_000),
  });

  await reconciler(hubRoot, assignments, workers).reconcileAssignments();

  const result = await readJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"));
  assert.equal(result.status, "failed");
  assert.equal(result.attemptToken, attempt.attemptToken);
  assert.equal(result.jobResult.failure.kind, "worker_heartbeat_lost");
  assert.equal((await assignments.getAssignment(assignment.assignmentId)).status, "failed");
  assert.equal((await listQueue(hubRoot))[0].status, "failed");
});

test("Reconciler compensates terminal assignments missing queue and worker finalization", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-compensate");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "compensate" });
  await updateEntry(hubRoot, entry.id, { status: "scheduled", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", { status: "assigned", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "compensate",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"), {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    attemptToken: attempt.attemptToken,
    status: "completed",
    jobResult: { status: "completed" },
  });
  await writeJson(path.join(hubRoot, "assignments", assignment.assignmentId, "state.json"), {
    ...(await assignments.getAssignment(assignment.assignmentId)),
    status: "completed",
    resultWrittenAt: new Date().toISOString(),
    queueFinalizedAt: null,
    workerFinalizedAt: null,
  });

  await reconciler(hubRoot, assignments, workers).reconcileAssignments();

  const finalAssignment = await assignments.getAssignment(assignment.assignmentId);
  assert.ok(finalAssignment.queueFinalizedAt);
  assert.ok(finalAssignment.workerFinalizedAt);
  assert.equal((await listQueue(hubRoot))[0].status, "completed");
  assert.equal((await workers.getWorker("w-1")).currentAssignmentId, null);
});

test("Reconciler refuses mutation when leader lock is lost", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-fence");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const rec = new Reconciler(hubRoot, {
    assignmentStore: assignments,
    workerStore: workers,
    leaderLock: { stillHeld: async () => false },
    failureRouter: { route: async () => ({ action: "mark_failed" }), resetBudget: () => {} },
  });

  await assert.rejects(rec.reconcileAssignments(), /leader lock lost/);
});
