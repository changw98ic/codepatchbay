import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("job-recovery hardening", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-recovery-test-"));
  });

  after(async () => {
    try { await rm(tmpDir, { recursive: true }); } catch {}
  });

  // Use cpbRoot=tmpDir WITHOUT dataRoot so all functions resolve through
  // the same runtimeDataRoot path (tmpDir/cpb-task/).

  async function createFailedJob(jobId) {
    const { createJob, failJob } = await import("../server/services/job-store.js");

    await createJob(tmpDir, {
      project: "recovery-test",
      task: "test recovery",
      jobId,
      ts: new Date().toISOString(),
    });

    return failJob(tmpDir, "recovery-test", jobId, {
      reason: "induced failure",
      code: "RECOVERABLE",
      ts: new Date().toISOString(),
    });
  }

  async function createBlockedJob(jobId) {
    const { createJob, blockJob } = await import("../server/services/job-store.js");

    await createJob(tmpDir, {
      project: "recovery-test",
      task: "test blocked recovery",
      jobId,
      ts: new Date().toISOString(),
    });

    return blockJob(tmpDir, "recovery-test", jobId, {
      reason: "budget exceeded",
      ts: new Date().toISOString(),
    });
  }

  async function createCompletedJob(jobId) {
    const { createJob, completeJob } = await import("../server/services/job-store.js");

    await createJob(tmpDir, {
      project: "recovery-test",
      task: "test completed",
      jobId,
      ts: new Date().toISOString(),
    });

    return completeJob(tmpDir, "recovery-test", jobId, {
      ts: new Date().toISOString(),
    });
  }

  // --- recoverAsNewJob ---

  it("recoverAsNewJob creates new job with lineage pointing to original", async () => {
    const { recoverAsNewJob, getLineage } = await import("../server/services/job-recovery.js");
    const { getJob } = await import("../server/services/job-store.js");

    const original = await createFailedJob("job-recover-001");
    assert.equal(original.status, "failed");

    const recovered = await recoverAsNewJob(tmpDir, "recovery-test", "job-recover-001", {
      reason: "test recovery",
    });

    assert.ok(recovered.jobId, "recovery job must have an ID");
    assert.notEqual(recovered.jobId, "job-recover-001", "recovery job must be a new job");

    // Lineage must point back to the original
    const lineage = getLineage(recovered);
    assert.equal(lineage.parentJobId, "job-recover-001");
    assert.equal(lineage.parentStatus, "failed");
    assert.equal(lineage.parentFailureCode, "RECOVERABLE");
    assert.ok(lineage.recoveryReason);

    // recoveryOf on the job state
    const job = await getJob(tmpDir, "recovery-test", recovered.jobId);
    assert.equal(job.recoveryOf, "job-recover-001");
  });

  // --- retryAsNewJob ---

  it("retryAsNewJob creates new job with lineage pointing to original", async () => {
    const { retryAsNewJob, getLineage } = await import("../server/services/job-recovery.js");

    const original = await createFailedJob("job-retry-001");
    assert.equal(original.status, "failed");

    const retried = await retryAsNewJob(tmpDir, "recovery-test", "job-retry-001", {
      fromPhase: "plan",
    });

    assert.ok(retried.jobId);
    assert.notEqual(retried.jobId, "job-retry-001");

    const lineage = getLineage(retried);
    assert.equal(lineage.parentJobId, "job-retry-001");
    assert.equal(lineage.parentStatus, "failed");
  });

  it("retryAsNewJob works for blocked job", async () => {
    const { retryAsNewJob, getLineage } = await import("../server/services/job-recovery.js");

    await createBlockedJob("job-retry-blocked-001");

    const retried = await retryAsNewJob(tmpDir, "recovery-test", "job-retry-blocked-001");
    assert.ok(retried.jobId);

    const lineage = getLineage(retried);
    assert.equal(lineage.parentJobId, "job-retry-blocked-001");
    assert.equal(lineage.parentStatus, "blocked");
  });

  // --- original immutability ---

  it("original terminal job remains unchanged after recovery", async () => {
    const { recoverAsNewJob } = await import("../server/services/job-recovery.js");
    const { getJob } = await import("../server/services/job-store.js");

    await createFailedJob("job-immutable-001");

    // Snapshot original state
    const before = await getJob(tmpDir, "recovery-test", "job-immutable-001");
    assert.equal(before.status, "failed");
    assert.equal(before.failureCode, "RECOVERABLE");

    // Create recovery
    await recoverAsNewJob(tmpDir, "recovery-test", "job-immutable-001", {
      reason: "immutability test",
    });

    // Re-read original — must be identical
    const after = await getJob(tmpDir, "recovery-test", "job-immutable-001");
    assert.equal(after.status, before.status);
    assert.equal(after.failureCode, before.failureCode);
    assert.equal(after.failurePhase, before.failurePhase);
    assert.equal(after.blockedReason, before.blockedReason);
    assert.equal(after.jobId, before.jobId);
  });

  it("verifyTerminalImmutability returns immutable true for failed job", async () => {
    const { verifyTerminalImmutability } = await import("../server/services/job-recovery.js");

    await createFailedJob("job-verify-imm-001");

    const result = await verifyTerminalImmutability(tmpDir, "recovery-test", "job-verify-imm-001");
    assert.equal(result.immutable, true);
  });

  it("verifyTerminalImmutability returns immutable true for completed job", async () => {
    const { verifyTerminalImmutability } = await import("../server/services/job-recovery.js");

    await createCompletedJob("job-verify-imm-comp-001");

    const result = await verifyTerminalImmutability(tmpDir, "recovery-test", "job-verify-imm-comp-001");
    assert.equal(result.immutable, true);
  });

  it("verifyTerminalImmutability returns false for non-terminal job", async () => {
    const { verifyTerminalImmutability } = await import("../server/services/job-recovery.js");
    const { createJob } = await import("../server/services/job-store.js");

    await createJob(tmpDir, {
      project: "recovery-test",
      task: "running job",
      jobId: "job-verify-running-001",
      ts: new Date().toISOString(),
    });

    const result = await verifyTerminalImmutability(tmpDir, "recovery-test", "job-verify-running-001");
    assert.equal(result.immutable, false);
    assert.ok(result.reason.includes("not terminal"));
  });

  // --- completed job not recoverable ---

  it("recoverAsNewJob rejects completed job", async () => {
    const { recoverAsNewJob } = await import("../server/services/job-recovery.js");

    await createCompletedJob("job-comp-norec-001");

    await assert.rejects(
      () => recoverAsNewJob(tmpDir, "recovery-test", "job-comp-norec-001"),
      /completed job does not need recovery/
    );
  });

  it("retryAsNewJob rejects completed job", async () => {
    const { retryAsNewJob } = await import("../server/services/job-recovery.js");

    await createCompletedJob("job-comp-noretry-001");

    await assert.rejects(
      () => retryAsNewJob(tmpDir, "recovery-test", "job-comp-noretry-001"),
      /not recoverable/
    );
  });

  it("isRecoverable returns false for completed job", async () => {
    const { isRecoverable } = await import("../server/services/job-recovery.js");

    await createCompletedJob("job-isrec-comp-001");
    const { getJob } = await import("../server/services/job-store.js");
    const job = await getJob(tmpDir, "recovery-test", "job-isrec-comp-001");

    assert.equal(isRecoverable(job), false);
  });

  it("isRecoverable returns true for failed job", async () => {
    const { isRecoverable } = await import("../server/services/job-recovery.js");
    const { getJob } = await import("../server/services/job-store.js");

    await createFailedJob("job-isrec-fail-001");
    const job = await getJob(tmpDir, "recovery-test", "job-isrec-fail-001");

    assert.equal(isRecoverable(job), true);
  });
});
