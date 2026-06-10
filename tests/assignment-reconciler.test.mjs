import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import { WorkerStore } from "../shared/orchestrator/worker-store.js";
import { FailureKind } from "../core/contracts/failure.js";
import { FailureRouter } from "../server/orchestrator/failure-router.js";
import { Reconciler, buildRetrySourceContext } from "../server/orchestrator/reconciler.js";
import { enqueue, listQueue, updateEntry } from "../server/services/hub-queue.js";
import { tempRoot, oldIso, readJson, writeJson } from "./helpers.mjs";

function attemptDir(hubRoot, assignmentId, attempt = 1) {
  return path.join(hubRoot, "assignments", assignmentId, "attempts", String(attempt).padStart(3, "0"));
}

function reconciler(hubRoot, assignments, workers, failureRouter = {}, options = {}) {
  const router = typeof failureRouter?.route === "function"
    ? failureRouter
    : {
        resetBudget: () => {},
        route: async () => ({ action: "mark_failed", reason: "test failure" }),
        ...failureRouter,
      };
  return new Reconciler(hubRoot, {
    assignmentStore: assignments,
    workerStore: workers,
    leaderLock: { stillHeld: async () => true },
    failureRouter: router,
    ...options,
  });
}

test("buildRetrySourceContext carries verifier verdict into retry metadata", () => {
  const result = {
    jobResult: {
      jobId: "job-verify",
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: "acceptance failed",
        retryable: true,
        cause: {
          verdict: {
            status: "fail",
            confidence: 0.84,
            reason: "missing validation",
            summary: "The API still accepts null input.",
            layers: {
              acceptance: { status: "fail", detail: "null input was accepted" },
            },
            blocking: [
              {
                criterion: "input validation",
                file: "src/api.js",
                evidence: "null accepted",
                fix_hint: "add guard",
              },
            ],
            fix_scope: ["src/api.js"],
          },
          artifact: {
            kind: "verdict",
            id: "123456",
            name: "verdict-123456",
            path: "/tmp/verdict-123456.md",
            bytes: 321,
            sha256: "abc123",
          },
        },
      },
    },
  };

  const sourceContext = buildRetrySourceContext(
    {
      attempts: 1,
      metadata: { failureCount: 1 },
      sourceContext: { issueNumber: 42 },
    },
    { attempt: 1 },
    result,
    { action: "retry_same_worker", reason: "verification failed: acceptance failed", retryable: true },
  );

  assert.equal(sourceContext.issueNumber, 42);
  assert.equal(sourceContext.retry.failureKind, FailureKind.VERIFICATION_FAILED);
  assert.equal(sourceContext.retry.failureReason, "acceptance failed");
  assert.equal(sourceContext.retry.retryAction, "retry_same_worker");
  assert.equal(sourceContext.retry.failureCount, 2);
  assert.equal(sourceContext.retry.verification.verdict.status, "fail");
  assert.equal(sourceContext.retry.verification.verdict.reason, "missing validation");
  assert.deepEqual(sourceContext.retry.verification.retryScope, ["src/api.js"]);
  assert.equal(sourceContext.retry.verification.artifact.path, "/tmp/verdict-123456.md");
  assert.match(sourceContext.retry.previousOutput, /Verifier verdict:/);
  assert.match(sourceContext.retry.previousOutput, /src\/api\.js/);
  assert.equal(sourceContext.previousFailure.verification.verdict.status, "fail");
});

test("Reconciler requeues verification failures with verifier retry context", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-verifier-retry");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "retry after verifier" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-verify", workerId: "w-verify" });
  await workers.registerWorker("w-verify", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "retry after verifier",
    metadata: { failureCount: 0 },
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-verify",
    orchestratorEpoch: 1,
  });

  await reconciler(hubRoot, assignments, workers, new FailureRouter())._finalizeQueue(assignment, attempt, {
    status: "failed",
    jobResult: {
      status: "failed",
      jobId: "job-verify",
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: "tests failed",
        retryable: true,
        cause: {
          verdict: {
            status: "fail",
            reason: "test expectation failed",
            blocking: [{ criterion: "unit test", file: "src/api.js", evidence: "expected 2 got 1" }],
            fix_scope: ["src/api.js"],
          },
          artifact: { kind: "verdict", id: "654321", name: "verdict-654321", path: "/tmp/verdict-654321.md" },
        },
      },
    },
  });

  const [queued] = await listQueue(hubRoot);
  assert.equal(queued.status, "pending");
  assert.equal(queued.metadata.lastFailureKind, FailureKind.VERIFICATION_FAILED);
  assert.equal(queued.metadata.failureCount, 1);
  assert.equal(queued.metadata.retryDecision.action, "retry_same_worker");
  assert.equal(queued.metadata.sourceContext.retry.failureKind, FailureKind.VERIFICATION_FAILED);
  assert.equal(queued.metadata.sourceContext.retry.verification.verdict.status, "fail");
  assert.deepEqual(queued.metadata.sourceContext.retry.verification.retryScope, ["src/api.js"]);
  assert.match(queued.metadata.sourceContext.retry.previousOutput, /Verifier verdict:/);
  assert.match(queued.metadata.sourceContext.retry.previousOutput, /test expectation failed/);
});

test("Reconciler marks verification failures without actionable retry scope as failed", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-verifier-no-scope");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "do not retry verifier pollution" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-verify", workerId: "w-verify" });
  await workers.registerWorker("w-verify", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "do not retry verifier pollution",
    metadata: { failureCount: 0 },
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-verify",
    orchestratorEpoch: 1,
  });

  await reconciler(hubRoot, assignments, workers, new FailureRouter())._finalizeQueue(assignment, attempt, {
    status: "failed",
    jobResult: {
      status: "failed",
      jobId: "job-verify",
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: "runtime-only files changed: .claude/settings.local.json, cpb-task/codegraph-state.json",
        retryable: true,
        cause: {
          verdict: {
            status: "fail",
            reason: "runtime-only files changed",
            blocking: [],
            fix_scope: [],
          },
          artifact: { kind: "verdict", id: "777777", name: "verdict-777777", path: "/tmp/verdict-777777.md" },
        },
      },
    },
  });

  const [queued] = await listQueue(hubRoot);
  assert.equal(queued.status, "failed");
  assert.match(queued.metadata.failureReason, /without actionable retry scope/);
});

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

test("Reconciler finalizes cancelled result files as cancelled queue entries", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-cancelled");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "cancel me" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", {
    status: "running",
    currentAssignmentId: `a-${entry.id}`,
  });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "cancel me",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });

  await reconciler(hubRoot, assignments, workers)._finalizeQueue(assignment, attempt, {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    attemptToken: attempt.attemptToken,
    status: "cancelled",
    jobResult: {
      status: "cancelled",
      failure: {
        kind: FailureKind.RUNTIME_INTERRUPTED,
        reason: "assignment cancelled: user requested",
        retryable: false,
      },
    },
  });

  const [queued] = await listQueue(hubRoot);
  assert.equal(queued.status, "cancelled");
  assert.match(queued.metadata.cancelReason, /user requested/);
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

test("Reconciler classifies staged progress delay levels before force retry", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-progress-levels");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const rec = reconciler(hubRoot, assignments, workers, {}, {
    progressForceRetryMs: 35 * 60_000,
  });
  const assignment = { assignmentId: "a-q-progress-levels", entryId: "q-progress-levels" };
  const attempt = { attempt: 1 };
  const heartbeat = (ageMs) => ({
    status: "running",
    activePhase: "plan",
    progressUpdatedAt: oldIso(ageMs),
    updatedAt: new Date().toISOString(),
  });

  assert.equal(rec._classifyProgressDelay(assignment, attempt, heartbeat(5 * 60_000 + 1_000)).level, "info");
  assert.equal(rec._classifyProgressDelay(assignment, attempt, heartbeat(15 * 60_000 + 1_000)).level, "warn");
  const errorDelay = rec._classifyProgressDelay(assignment, attempt, heartbeat(30 * 60_000 + 1_000));
  assert.equal(errorDelay.level, "error");
  assert.equal(errorDelay.shouldFail, false);
  const forceDelay = rec._classifyProgressDelay(assignment, attempt, heartbeat(35 * 60_000 + 1_000));
  assert.equal(forceDelay.level, "force");
  assert.equal(forceDelay.shouldFail, true);
});

test("Reconciler records staged progress delay without failing before force retry", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-progress-error-only");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "progress warning" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "progress warning",
  });
  await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "heartbeat.json"), {
    workerId: "w-1",
    assignmentId: assignment.assignmentId,
    attempt: 1,
    status: "running",
    activePhase: "execute",
    progressUpdatedAt: oldIso(30 * 60_000 + 1_000),
    updatedAt: new Date().toISOString(),
  });

  await reconciler(hubRoot, assignments, workers, {}, { progressForceRetryMs: 35 * 60_000 }).reconcileAssignments();

  await assert.rejects(
    readJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json")),
    /ENOENT/,
  );
  const probe = await readJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "progress-probe-error.json"));
  assert.equal(probe.depth, "deep");
  assert.equal(probe.waitUseful, true);
  assert.deepEqual(probe.failureSignals, []);
  assert.equal((await assignments.getAssignment(assignment.assignmentId)).status, "running");
  assert.equal((await listQueue(hubRoot))[0].status, "in_progress");
});

test("Reconciler closes stale progress early when probe proves waiting cannot recover", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-progress-early-close");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "early close" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-dead", workerId: "w-dead" });
  await workers.registerWorker("w-dead", {
    status: "exited",
    currentAssignmentId: `a-${entry.id}`,
    pid: 999999999,
  });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "early close",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-dead",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "heartbeat.json"), {
    workerId: "w-dead",
    assignmentId: assignment.assignmentId,
    attempt: 1,
    status: "running",
    activePhase: "plan",
    progressUpdatedAt: oldIso(15 * 60_000 + 1_000),
    updatedAt: new Date().toISOString(),
    pid: 999999999,
  });

  await reconciler(hubRoot, assignments, workers, new FailureRouter(), {
    progressForceRetryMs: 35 * 60_000,
  }).reconcileAssignments();

  const result = await readJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"));
  assert.equal(result.status, "failed");
  assert.equal(result.attemptToken, attempt.attemptToken);
  assert.equal(result.jobResult.failure.kind, "assignment_progress_stale");
  assert.match(result.jobResult.failure.reason, /probe confirmed waiting cannot recover/);
  assert.equal(result.jobResult.failure.cause.probe.waitUseful, false);
  assert.ok(result.jobResult.failure.cause.probe.failureSignals.includes("worker_status_exited"));
  assert.ok(result.jobResult.failure.cause.probe.failureSignals.includes("worker_pid_dead"));
  assert.equal((await listQueue(hubRoot))[0].status, "pending");
});

test("Reconciler forces retry for fresh heartbeat with stale progress past grace period", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-progress-stale");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  const stopped = [];
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "stale progress" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "stale progress",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "heartbeat.json"), {
    workerId: "w-1",
    assignmentId: assignment.assignmentId,
    attempt: 1,
    status: "running",
    phase: "plan",
    activePhase: "plan",
    activeJobId: "job-stale-progress",
    progressUpdatedAt: oldIso(300_000),
    updatedAt: new Date().toISOString(),
    worktreePath: "/tmp/worktree",
    pid: 12345,
  });

  await reconciler(hubRoot, assignments, workers, new FailureRouter(), {
    progressForceRetryMs: 120_000,
    workerSupervisor: {
      stopWorker: async (workerId, reason) => {
        stopped.push({ workerId, reason });
        await workers.updateWorker(workerId, { status: "draining", stopReason: reason });
      },
    },
  }).reconcileAssignments();

  const result = await readJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"));
  assert.equal(result.status, "failed");
  assert.equal(result.attemptToken, attempt.attemptToken);
  assert.equal(result.jobResult.failure.kind, "assignment_progress_stale");
  assert.equal(result.jobResult.failure.phase, "plan");
  assert.equal(result.jobResult.failure.cause.activeJobId, "job-stale-progress");
  assert.equal(result.jobResult.failure.cause.worktreePath, "/tmp/worktree");
  assert.equal(result.jobResult.failure.cause.forceRetryThresholdMs, 120_000);
  assert.equal((await assignments.getAssignment(assignment.assignmentId)).status, "failed");
  assert.equal((await listQueue(hubRoot))[0].status, "pending");
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].workerId, "w-1");
  assert.match(stopped[0].reason, /^assignment_progress_stale: phase plan made no progress/);
  const worker = await workers.getWorker("w-1");
  assert.equal(worker.status, "draining");
  assert.equal(worker.currentAssignmentId, null);
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
