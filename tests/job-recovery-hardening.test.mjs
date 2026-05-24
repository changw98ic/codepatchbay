import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

  it("plans worktree retention with completed cleanup policy and failed/blocked preservation", async () => {
    const { createJob, completeJob, failJob, blockJob, recordWorktreeCreated } = await import("../server/services/job-store.js");
    const { buildWorktreeRetentionPlan } = await import("../server/services/worktree-retention.js");
    const worktreesRoot = path.join(tmpDir, "retention-worktrees");
    const completedPath = path.join(worktreesRoot, "job-retain-completed-pipeline");
    const failedPath = path.join(worktreesRoot, "job-retain-failed-pipeline");
    const blockedPath = path.join(worktreesRoot, "job-retain-blocked-pipeline");

    await mkdir(completedPath, { recursive: true });
    await mkdir(failedPath, { recursive: true });
    await mkdir(blockedPath, { recursive: true });

    await createJob(tmpDir, { project: "recovery-test", task: "completed worktree", jobId: "job-retain-completed" });
    await recordWorktreeCreated(tmpDir, "recovery-test", "job-retain-completed", {
      worktree: completedPath,
      branch: "cpb/job-retain-completed-pipeline",
      baseBranch: "main",
    });
    await completeJob(tmpDir, "recovery-test", "job-retain-completed");

    await createJob(tmpDir, { project: "recovery-test", task: "failed worktree", jobId: "job-retain-failed" });
    await recordWorktreeCreated(tmpDir, "recovery-test", "job-retain-failed", {
      worktree: failedPath,
      branch: "cpb/job-retain-failed-pipeline",
      baseBranch: "main",
    });
    await failJob(tmpDir, "recovery-test", "job-retain-failed", { reason: "verify failed", code: "RECOVERABLE" });

    await createJob(tmpDir, { project: "recovery-test", task: "blocked worktree", jobId: "job-retain-blocked" });
    await recordWorktreeCreated(tmpDir, "recovery-test", "job-retain-blocked", {
      worktree: blockedPath,
      branch: "cpb/job-retain-blocked-pipeline",
      baseBranch: "main",
    });
    await blockJob(tmpDir, "recovery-test", "job-retain-blocked", { reason: "approval required" });

    const deletePlan = await buildWorktreeRetentionPlan(tmpDir, {
      policy: { completed: "delete" },
      dryRun: true,
    });

    const completed = deletePlan.entries.find((entry) => entry.jobId === "job-retain-completed");
    const failed = deletePlan.entries.find((entry) => entry.jobId === "job-retain-failed");
    const blocked = deletePlan.entries.find((entry) => entry.jobId === "job-retain-blocked");

    assert.equal(deletePlan.dryRun, true);
    assert.equal(completed.action, "delete");
    assert.equal(completed.worktree, completedPath);
    assert.match(completed.reason, /completed.*policy/i);
    assert.equal(failed.action, "preserve");
    assert.match(failed.reason, /failed.*inspection/i);
    assert.equal(blocked.action, "preserve");
    assert.match(blocked.reason, /blocked.*inspection/i);

    const archivePlan = await buildWorktreeRetentionPlan(tmpDir, {
      policy: { completed: "archive", archiveRoot: path.join(tmpDir, "retention-archive") },
      dryRun: true,
    });
    const archived = archivePlan.entries.find((entry) => entry.jobId === "job-retain-completed");
    assert.equal(archived.action, "archive");
    assert.equal(archived.worktree, completedPath);
    assert.equal(archived.archivePath, path.join(tmpDir, "retention-archive", "job-retain-completed-pipeline"));
  });
});
