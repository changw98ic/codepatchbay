#!/usr/bin/env node
// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createJob,
  failJob,
  blockJob,
  completeJob,
  cancelJob,
  startPhase,
  requestCancelJob,
  FAILURE_CODES,
  getJob,
} from "../server/services/job-store.js";
import {
  isTerminal,
  isRecoverable,
  recoverAsNewJob,
  retryAsNewJob,
  verifyTerminalImmutability,
  getLineage,
} from "../server/services/job-recovery.js";
import { appendEvent, readEvents } from "../server/services/event-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-job-recovery-"));
const project = "recovery-test";

// --- isTerminal ---
const running = { jobId: "j1", status: "running" };
assert.equal(isTerminal(running), false);
assert.equal(isTerminal({ jobId: "j2", status: "failed" }), true);
assert.equal(isTerminal({ jobId: "j3", status: "completed" }), true);
assert.equal(isTerminal({ jobId: "j4", status: "cancelled" }), true);
assert.equal(isTerminal({ jobId: "j5", status: "blocked" }), true);
assert.equal(isTerminal(null), true);
assert.equal(isTerminal({}), true);

// --- isRecoverable ---
assert.equal(isRecoverable({ jobId: "j1", status: "running" }), false);
assert.equal(isRecoverable({ jobId: "j2", status: "failed" }), true);
assert.equal(isRecoverable({ jobId: "j3", status: "completed" }), false);
assert.equal(isRecoverable({ jobId: "j4", status: "cancelled" }), true);
assert.equal(isRecoverable({ jobId: "j5", status: "blocked" }), true);

// --- recoverAsNewJob from failed job ---
const failedJob = await createJob(root, {
  project,
  task: "Test recovery from failure",
  workflow: "standard",
  ts: "2026-05-20T00:00:00.000Z",
});
await startPhase(root, project, failedJob.jobId, { phase: "execute", leaseId: "lease-1" });
await failJob(root, project, failedJob.jobId, {
  reason: "execute crashed",
  code: FAILURE_CODES.RECOVERABLE,
  phase: "execute",
  ts: "2026-05-20T00:05:00.000Z",
});

const originalFailedState = await getJob(root, project, failedJob.jobId);
assert.equal(originalFailedState.status, "failed");

const recovered = await recoverAsNewJob(root, project, failedJob.jobId, {
  ts: "2026-05-20T00:10:00.000Z",
  reason: "automated recovery",
});
assert.ok(recovered.jobId);
assert.notEqual(recovered.jobId, failedJob.jobId, "recovery creates a new job");
assert.equal(recovered.task, "Test recovery from failure");
assert.equal(recovered.workflow, "standard");
assert.equal(recovered.status, "running");

// Verify the original job is unchanged
const originalAfterRecovery = await getJob(root, project, failedJob.jobId);
assert.equal(originalAfterRecovery.status, "failed", "original job stays failed");
assert.equal(originalAfterRecovery.blockedReason, "execute crashed");
assert.equal(originalAfterRecovery.failureCode, FAILURE_CODES.RECOVERABLE);

// Verify lineage in new job events
const newJobEvents = await readEvents(root, project, recovered.jobId);
const recoveryEvent = newJobEvents.find((e) => e.type === "recovery_created");
assert.ok(recoveryEvent, "should have recovery_created event");
assert.equal(recoveryEvent.lineage.parentJobId, failedJob.jobId);
assert.equal(recoveryEvent.lineage.parentStatus, "failed");
assert.equal(recoveryEvent.lineage.parentFailureCode, FAILURE_CODES.RECOVERABLE);
assert.equal(recoveryEvent.lineage.parentFailurePhase, "execute");
assert.equal(recoveryEvent.recoveryReason, "automated recovery");

// --- retryAsNewJob ---
const blockedJob = await createJob(root, {
  project,
  task: "Test retry from blocked",
  workflow: "standard",
  ts: "2026-05-20T01:00:00.000Z",
});
await blockJob(root, project, blockedJob.jobId, {
  reason: "operator blocked",
  ts: "2026-05-20T01:01:00.000Z",
});

const retried = await retryAsNewJob(root, project, blockedJob.jobId, {
  ts: "2026-05-20T01:05:00.000Z",
});
assert.ok(retried.jobId);
assert.notEqual(retried.jobId, blockedJob.jobId);
assert.equal(retried.status, "running");
assert.equal(retried.task, "Test retry from blocked");

// Original stays blocked
const blockedAfterRetry = await getJob(root, project, blockedJob.jobId);
assert.equal(blockedAfterRetry.status, "blocked");

const retryEvents = await readEvents(root, project, retried.jobId);
const retryLineage = retryEvents.find((e) => e.type === "recovery_created");
assert.ok(retryLineage);
assert.equal(retryLineage.lineage.parentJobId, blockedJob.jobId);
assert.equal(retryLineage.lineage.parentStatus, "blocked");

// --- cannot recover a running job ---
const runningJob = await createJob(root, {
  project,
  task: "Test cannot recover running",
  ts: "2026-05-20T02:00:00.000Z",
});
await assert.rejects(
  () => recoverAsNewJob(root, project, runningJob.jobId),
  /not terminal/
);

// --- cannot recover a completed job ---
const completedJob = await createJob(root, {
  project,
  task: "Test cannot recover completed",
  ts: "2026-05-20T02:00:00.000Z",
});
await completeJob(root, project, completedJob.jobId, { ts: "2026-05-20T02:01:00.000Z" });
await assert.rejects(
  () => recoverAsNewJob(root, project, completedJob.jobId),
  /completed job does not need recovery/
);

// --- cannot retry a completed job ---
await assert.rejects(
  () => retryAsNewJob(root, project, completedJob.jobId),
  /not recoverable/
);

// --- cancelled jobs recover as fresh jobs when explicitly retried ---
const cancelledJob = await createJob(root, {
  project,
  task: "Test fresh retry for cancelled",
  ts: "2026-05-20T03:00:00.000Z",
});
await requestCancelJob(root, project, cancelledJob.jobId, { reason: "user cancel" });
const cancelledRetry = await retryAsNewJob(root, project, cancelledJob.jobId);
assert.notEqual(cancelledRetry.jobId, cancelledJob.jobId);
assert.equal(cancelledRetry.task, "Test fresh retry for cancelled");

// --- verifyTerminalImmutability ---
const immutableResult = await verifyTerminalImmutability(root, project, completedJob.jobId);
assert.equal(immutableResult.immutable, true);

const notFound = await verifyTerminalImmutability(root, project, "nonexistent");
assert.equal(notFound.immutable, false);

const runningImmutable = await verifyTerminalImmutability(root, project, runningJob.jobId);
assert.equal(runningImmutable.immutable, false);

// --- getLineage ---
const jobWithLineage = await getJob(root, project, recovered.jobId);
const lineage = getLineage(jobWithLineage);
assert.equal(lineage.parentJobId, failedJob.jobId);
assert.equal(lineage.parentStatus, "failed");
assert.equal(lineage.parentFailureCode, FAILURE_CODES.RECOVERABLE);

const noLineage = getLineage(null);
assert.equal(noLineage, null);

// --- executor pinning: recoverAsNewJob preserves parent executor ---
const oldExecutor = {
  root: "/tmp/cpb-old",
  packageName: "codepatchbay",
  version: "0.1.0",
  releaseId: "old-rel",
  codeVersion: "0.1.0",
  stateFormatVersions: { queue: 1 },
};
const currentExecutor = {
  root: "/tmp/cpb-new",
  packageName: "codepatchbay",
  version: "0.2.0",
  releaseId: "new-rel",
  codeVersion: "0.2.0",
  stateFormatVersions: { queue: 2 },
};

const parentWithExecutor = await createJob(root, {
  project,
  task: "Executor pinning parent",
  workflow: "standard",
  executor: oldExecutor,
  ts: "2026-05-20T10:00:00.000Z",
});
await failJob(root, project, parentWithExecutor.jobId, {
  reason: "boom", code: FAILURE_CODES.RECOVERABLE, phase: "execute",
  ts: "2026-05-20T10:01:00.000Z",
});

const preservedRecovery = await recoverAsNewJob(root, project, parentWithExecutor.jobId, {
  ts: "2026-05-20T10:05:00.000Z",
});
assert.deepEqual(preservedRecovery.executor, oldExecutor,
  "recoverAsNewJob preserves parent executor by default");

const overrideRecovery = await recoverAsNewJob(root, project, parentWithExecutor.jobId, {
  ts: "2026-05-20T10:10:00.000Z",
  useCurrentExecutor: true,
  currentExecutor,
});
assert.deepEqual(overrideRecovery.executor, currentExecutor,
  "recoverAsNewJob uses current executor when override is explicit");

// Audit metadata on recoverAsNewJob
const preservedEvents = await readEvents(root, project, preservedRecovery.jobId);
const preservedAudit = preservedEvents.find((e) => e.type === "recovery_created");
assert.ok(preservedAudit.executorSelection);
assert.equal(preservedAudit.executorSelection.mode, "preserve-parent");
assert.equal(preservedAudit.executorSelection.override, false);
assert.equal(preservedAudit.executorSelection.parentRoot, "/tmp/cpb-old");
assert.equal(preservedAudit.executorSelection.selectedRoot, "/tmp/cpb-old");

const overrideEvents = await readEvents(root, project, overrideRecovery.jobId);
const overrideAudit = overrideEvents.find((e) => e.type === "recovery_created");
assert.ok(overrideAudit.executorSelection);
assert.equal(overrideAudit.executorSelection.mode, "use-current");
assert.equal(overrideAudit.executorSelection.override, true);
assert.equal(overrideAudit.executorSelection.parentRoot, "/tmp/cpb-old");
assert.equal(overrideAudit.executorSelection.selectedRoot, "/tmp/cpb-new");
assert.equal(overrideAudit.executorSelection.parentReleaseId, "old-rel");
assert.equal(overrideAudit.executorSelection.selectedReleaseId, "new-rel");

// executor pinning: retryAsNewJob preserves parent executor
const blockedWithExecutor = await createJob(root, {
  project,
  task: "Retry executor pinning",
  workflow: "standard",
  executor: oldExecutor,
  ts: "2026-05-20T11:00:00.000Z",
});
await blockJob(root, project, blockedWithExecutor.jobId, {
  reason: "stuck", ts: "2026-05-20T11:01:00.000Z",
});

const preservedRetry = await retryAsNewJob(root, project, blockedWithExecutor.jobId, {
  ts: "2026-05-20T11:05:00.000Z",
});
assert.deepEqual(preservedRetry.executor, oldExecutor,
  "retryAsNewJob preserves parent executor by default");

const overrideRetry = await retryAsNewJob(root, project, blockedWithExecutor.jobId, {
  ts: "2026-05-20T11:10:00.000Z",
  useCurrentExecutor: true,
  currentExecutor,
});
assert.deepEqual(overrideRetry.executor, currentExecutor,
  "retryAsNewJob uses current executor when override is explicit");

// Materialized lineage includes executorSelection
const lineageJob = await getJob(root, project, preservedRecovery.jobId);
assert.ok(lineageJob.lineage.executorSelection);
assert.equal(lineageJob.lineage.executorSelection.mode, "preserve-parent");

// --- node-aware recovery lineage ---
const nodeAwareDag = {
  name: "node-aware",
  nodes: [
    { id: "plan", phase: "plan", dependsOn: [] },
    { id: "execute_a", phase: "execute", dependsOn: ["plan"] },
    { id: "execute_b", phase: "execute", dependsOn: ["plan"] },
    { id: "verify", phase: "verify", dependsOn: ["execute_a", "execute_b"] },
  ],
};
const nodeAwareParent = await createJob(root, {
  project,
  task: "Node-aware retry lineage",
  workflow: "standard",
  ts: "2026-05-20T12:00:00.000Z",
});
await appendEvent(root, project, nodeAwareParent.jobId, {
  type: "workflow_dag_materialized",
  jobId: nodeAwareParent.jobId,
  project,
  workflow: "standard",
  workflowDag: nodeAwareDag,
  ts: "2026-05-20T12:00:01.000Z",
});
await appendEvent(root, project, nodeAwareParent.jobId, {
  type: "dag_node_completed",
  jobId: nodeAwareParent.jobId,
  project,
  nodeId: "plan",
  phase: "plan",
  ts: "2026-05-20T12:00:02.000Z",
});
await appendEvent(root, project, nodeAwareParent.jobId, {
  type: "dag_node_failed",
  jobId: nodeAwareParent.jobId,
  project,
  nodeId: "execute_b",
  phase: "execute",
  reason: "node failed",
  ts: "2026-05-20T12:00:03.000Z",
});
await failJob(root, project, nodeAwareParent.jobId, {
  reason: "node failed",
  code: FAILURE_CODES.RECOVERABLE,
  phase: "execute",
  ts: "2026-05-20T12:00:04.000Z",
});

const nodeAwareRetry = await retryAsNewJob(root, project, nodeAwareParent.jobId, {
  ts: "2026-05-20T12:05:00.000Z",
});
assert.equal(nodeAwareRetry.sourceContext.dagResume.failedNodeId, "execute_b");
assert.deepEqual(nodeAwareRetry.sourceContext.dagResume.resumeTarget, {
  nodeId: "execute_b",
  phase: "execute",
});
assert.deepEqual(nodeAwareRetry.sourceContext.dagResume.completedNodeIds, ["plan"]);

console.log("job-recovery: all tests passed");
