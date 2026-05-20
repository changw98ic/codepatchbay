#!/usr/bin/env node
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
import { readEvents } from "../server/services/event-store.js";

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
await cancelJob(root, project, cancelledJob.jobId, { reason: "user cancel" });
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

console.log("job-recovery: all tests passed");
