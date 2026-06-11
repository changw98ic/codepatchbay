#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  blockJob,
  budgetExceeded,
  cancelJob,
  completeJob,
  completePhase,
  createJob,
  failJob,
  getJob,
  requestCancelJob,
  retryJob,
  startPhase,
  FAILURE_CODES,
} from "../server/services/job-store.js";
import { readEvents, materializeJob } from "../server/services/event-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-terminal-immutable-"));
const dataRoot = path.join(root, "runtime");
const P = "immu-test";
const ts = (offset) => {
  const d = new Date("2026-05-20T00:00:00.000Z");
  d.setSeconds(d.getSeconds() + offset);
  return d.toISOString();
};

describe("write-time terminal guards", () => {
  it("startPhase rejects on failed job", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "t", ts: ts(1) });
    await failJob(root, P, job.jobId, {
      reason: "boom", code: FAILURE_CODES.FATAL, ts: ts(2),
      dataRoot,
    });
    await assert.rejects(
      () => startPhase(root, P, job.jobId, { phase: "plan", dataRoot }),
      /job is terminal: failed/,
    );
  });

  it("startPhase rejects on cancelled job", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "t", ts: ts(10) });
    await requestCancelJob(root, P, job.jobId, { reason: "stop", ts: ts(11), dataRoot });
    await assert.rejects(
      () => startPhase(root, P, job.jobId, { phase: "plan", dataRoot }),
      /job is terminal: cancelled/,
    );
  });

  it("startPhase rejects on completed job", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "t", ts: ts(20) });
    await completeJob(root, P, job.jobId, { ts: ts(21), dataRoot });
    await assert.rejects(
      () => startPhase(root, P, job.jobId, { phase: "plan", dataRoot }),
      /job is terminal: completed/,
    );
  });

  it("startPhase rejects on blocked job", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "t", ts: ts(30) });
    await blockJob(root, P, job.jobId, { reason: "stuck", ts: ts(31), dataRoot });
    await assert.rejects(
      () => startPhase(root, P, job.jobId, { phase: "plan", dataRoot }),
      /job is terminal: blocked/,
    );
  });

  it("completePhase rejects on failed job", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "t", ts: ts(40) });
    await failJob(root, P, job.jobId, {
      reason: "x", code: FAILURE_CODES.FATAL, ts: ts(41),
      dataRoot,
    });
    await assert.rejects(
      () => completePhase(root, P, job.jobId, { phase: "plan", artifact: "a.md", dataRoot }),
      /job is terminal: failed/,
    );
  });

  it("completePhase rejects on cancelled job", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "t", ts: ts(50) });
    await requestCancelJob(root, P, job.jobId, { reason: "x", ts: ts(51), dataRoot });
    await assert.rejects(
      () => completePhase(root, P, job.jobId, { phase: "plan", artifact: "a.md", dataRoot }),
      /job is terminal: cancelled/,
    );
  });

  it("business-state mutations reject after terminal failure and leave event log unchanged", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "t", ts: ts(60) });
    await failJob(root, P, job.jobId, {
      reason: "original failure", code: FAILURE_CODES.RECOVERABLE, phase: "execute", ts: ts(61),
      dataRoot,
    });
    const before = await readEvents(root, P, job.jobId, { dataRoot });

    await assert.rejects(
      () => completeJob(root, P, job.jobId, { ts: ts(62), dataRoot }),
      /job is terminal: failed/,
    );
    await assert.rejects(
      () => blockJob(root, P, job.jobId, { reason: "late block", ts: ts(63), dataRoot }),
      /job is terminal: failed/,
    );
    await assert.rejects(
      () => cancelJob(root, P, job.jobId, { reason: "late cancel", ts: ts(64), dataRoot }),
      /job is terminal: failed/,
    );
    await assert.rejects(
      () => failJob(root, P, job.jobId, { reason: "late fail", code: FAILURE_CODES.FATAL, ts: ts(65), dataRoot }),
      /job is terminal: failed/,
    );
    await assert.rejects(
      () => budgetExceeded(root, P, job.jobId, { reason: "late budget", ts: ts(66), dataRoot }),
      /job is terminal: failed/,
    );
    await assert.rejects(
      () => requestCancelJob(root, P, job.jobId, { reason: "late request", ts: ts(67), dataRoot }),
      /job is terminal: failed/,
    );

    const after = await readEvents(root, P, job.jobId, { dataRoot });
    assert.equal(after.length, before.length);
    const state = await getJob(root, P, job.jobId, { dataRoot });
    assert.equal(state.status, "failed");
    assert.equal(state.blockedReason, "original failure");
    assert.equal(state.failureCode, FAILURE_CODES.RECOVERABLE);
  });
});

describe("event log immutability after recovery", () => {
  it("failed job event count is unchanged after retryJob", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "t", ts: ts(100) });
    await startPhase(root, P, job.jobId, { phase: "plan", leaseId: "l1", ts: ts(101), dataRoot });
    await completePhase(root, P, job.jobId, {
      phase: "plan", artifact: "plan-001.md", ts: ts(102),
      dataRoot,
    });
    await failJob(root, P, job.jobId, {
      reason: "verify crash", code: FAILURE_CODES.RECOVERABLE, phase: "verify", ts: ts(103),
      dataRoot,
    });

    const eventsBefore = await readEvents(root, P, job.jobId, { dataRoot });
    const countBefore = eventsBefore.length;

    await retryJob(root, P, job.jobId, { ts: ts(110), dataRoot });

    const eventsAfter = await readEvents(root, P, job.jobId, { dataRoot });
    assert.equal(eventsAfter.length, countBefore, "original job event log must not grow after retry");

    const stateAfter = await getJob(root, P, job.jobId, { dataRoot });
    assert.equal(stateAfter.status, "failed");
    assert.equal(stateAfter.failureCode, FAILURE_CODES.RECOVERABLE);
    assert.equal(stateAfter.failurePhase, "verify");
    assert.equal(stateAfter.artifacts.plan, "plan-001.md");
  });

  it("cancelled job event log unchanged after retryJob with force", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "t", ts: ts(200) });
    await startPhase(root, P, job.jobId, { phase: "plan", leaseId: "l2", ts: ts(201), dataRoot });
    await requestCancelJob(root, P, job.jobId, { reason: "user", ts: ts(202), dataRoot });

    const eventsBefore = await readEvents(root, P, job.jobId, { dataRoot });
    const countBefore = eventsBefore.length;

    await retryJob(root, P, job.jobId, { force: true, ts: ts(210), dataRoot });

    const eventsAfter = await readEvents(root, P, job.jobId, { dataRoot });
    assert.equal(eventsAfter.length, countBefore);
  });
});

describe("recovery chain — multi-level lineage", () => {
  it("grandchild links to parent, not grandparent directly", async () => {
    // Level 1: original job fails
    const grandparent = await createJob(root, { dataRoot, project: P, task: "chain-test", ts: ts(300) });
    await startPhase(root, P, grandparent.jobId, { phase: "plan", leaseId: "l10", ts: ts(301), dataRoot });
    await failJob(root, P, grandparent.jobId, {
      reason: "L1 fail", code: FAILURE_CODES.RECOVERABLE, phase: "plan", ts: ts(302),
      dataRoot,
    });

    // Level 2: first recovery (parent)
    const parent = await retryJob(root, P, grandparent.jobId, { ts: ts(310), dataRoot });
    assert.notEqual(parent.jobId, grandparent.jobId);
    assert.equal(parent.lineage.parentJobId, grandparent.jobId);
    assert.equal(parent.lineage.parentStatus, "failed");

    // Fail the parent too
    await startPhase(root, P, parent.jobId, { phase: "plan", leaseId: "l11", ts: ts(311), dataRoot });
    await failJob(root, P, parent.jobId, {
      reason: "L2 fail", code: FAILURE_CODES.RECOVERABLE, phase: "plan", ts: ts(312),
      dataRoot,
    });

    // Level 3: second recovery (child)
    const child = await retryJob(root, P, parent.jobId, { ts: ts(320), dataRoot });
    assert.notEqual(child.jobId, parent.jobId);
    assert.notEqual(child.jobId, grandparent.jobId);
    assert.equal(child.lineage.parentJobId, parent.jobId, "child links to parent, not grandparent");
    assert.equal(child.lineage.parentStatus, "failed");

    // Grandparent untouched
    const gpState = await getJob(root, P, grandparent.jobId, { dataRoot });
    assert.equal(gpState.status, "failed");

    // Parent untouched
    const pParent = await getJob(root, P, parent.jobId, { dataRoot });
    assert.equal(pParent.status, "failed");
  });
});

describe("pipeline retry starts fresh from current phase", () => {
  it("retry from execute-failed job infers fromPhase=execute, carries no artifacts", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "pipeline-test", workflow: "standard", ts: ts(400) });
    await startPhase(root, P, job.jobId, { phase: "plan", leaseId: "l20", ts: ts(401), dataRoot });
    await completePhase(root, P, job.jobId, {
      phase: "plan", artifact: "plan-050.md", ts: ts(402),
      dataRoot,
    });
    await startPhase(root, P, job.jobId, { phase: "execute", leaseId: "l21", ts: ts(403), dataRoot });
    await failJob(root, P, job.jobId, {
      reason: "execute bombed", code: FAILURE_CODES.RECOVERABLE, phase: "execute", ts: ts(404),
      dataRoot,
    });

    const recovered = await retryJob(root, P, job.jobId, { ts: ts(410), dataRoot });
    assert.equal(recovered.status, "running");
    assert.equal(recovered.task, "pipeline-test");

    // Fresh job has no artifacts from the original
    assert.deepEqual(recovered.artifacts, {});

    // recovery_created event has correct fromPhase
    const events = await readEvents(root, P, recovered.jobId, { dataRoot });
    const recoveryEvent = events.find((e) => e.type === "recovery_created");
    assert.ok(recoveryEvent);
    assert.equal(recoveryEvent.fromPhase, "execute", "retry should restart from execute");
    assert.equal(recoveryEvent.lineage.parentJobId, job.jobId);
    assert.equal(recoveryEvent.lineage.parentFailurePhase, "execute");
  });

  it("retry with explicit fromPhase overrides inference", async () => {
    const job = await createJob(root, { dataRoot, project: P, task: "explicit-phase", workflow: "standard", ts: ts(500) });
    await startPhase(root, P, job.jobId, { phase: "plan", leaseId: "l30", ts: ts(501), dataRoot });
    await completePhase(root, P, job.jobId, {
      phase: "plan", artifact: "plan-060.md", ts: ts(502),
      dataRoot,
    });
    await startPhase(root, P, job.jobId, { phase: "execute", leaseId: "l31", ts: ts(503), dataRoot });
    await completePhase(root, P, job.jobId, {
      phase: "execute", artifact: "deliverable-060.md", ts: ts(504),
      dataRoot,
    });
    await startPhase(root, P, job.jobId, { phase: "verify", leaseId: "l32", ts: ts(505), dataRoot });
    await failJob(root, P, job.jobId, {
      reason: "verify rejected", code: FAILURE_CODES.QUALITY_FAIL, phase: "verify", ts: ts(506),
      dataRoot,
    });

    const recovered = await retryJob(root, P, job.jobId, { fromPhase: "plan", force: true, ts: ts(510), dataRoot });
    const events = await readEvents(root, P, recovered.jobId, { dataRoot });
    const recoveryEvent = events.find((e) => e.type === "recovery_created");
    assert.equal(recoveryEvent.fromPhase, "plan", "explicit fromPhase overrides inference");
  });
});

describe("executor pinning across retry", () => {
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

  it("retryJob preserves parent executor by default", async () => {
    const job = await createJob(root, {
      dataRoot,
      project: P, task: "executor-pin-default", executor: oldExecutor, ts: ts(600),
    });
    await failJob(root, P, job.jobId, {
      reason: "boom", code: FAILURE_CODES.RECOVERABLE, phase: "execute", ts: ts(601),
      dataRoot,
    });
    const parentEvents = await readEvents(root, P, job.jobId, { dataRoot });

    const child = await retryJob(root, P, job.jobId, { ts: ts(610), dataRoot });

    assert.deepEqual(child.executor, oldExecutor);

    const afterParentEvents = await readEvents(root, P, job.jobId, { dataRoot });
    assert.equal(afterParentEvents.length, parentEvents.length);
  });

  it("retryJob uses current executor when override is explicit", async () => {
    const job = await createJob(root, {
      dataRoot,
      project: P, task: "executor-pin-override", executor: oldExecutor, ts: ts(700),
    });
    await failJob(root, P, job.jobId, {
      reason: "boom", code: FAILURE_CODES.RECOVERABLE, phase: "execute", ts: ts(701),
      dataRoot,
    });

    const child = await retryJob(root, P, job.jobId, {
      ts: ts(710), useCurrentExecutor: true, currentExecutor,
      dataRoot,
    });

    assert.deepEqual(child.executor, currentExecutor);
  });

  it("recovery_created records executorSelection audit (preserve-parent)", async () => {
    const job = await createJob(root, {
      dataRoot,
      project: P, task: "audit-preserve", executor: oldExecutor, ts: ts(800),
    });
    await failJob(root, P, job.jobId, {
      reason: "boom", code: FAILURE_CODES.RECOVERABLE, phase: "execute", ts: ts(801),
      dataRoot,
    });

    const child = await retryJob(root, P, job.jobId, { ts: ts(810), dataRoot });
    const events = await readEvents(root, P, child.jobId, { dataRoot });
    const recovery = events.find((e) => e.type === "recovery_created");

    assert.ok(recovery.executorSelection);
    assert.equal(recovery.executorSelection.mode, "preserve-parent");
    assert.equal(recovery.executorSelection.override, false);
    assert.equal(recovery.executorSelection.parentRoot, "/tmp/cpb-old");
    assert.equal(recovery.executorSelection.selectedRoot, "/tmp/cpb-old");
    assert.equal(recovery.executorSelection.parentReleaseId, "old-rel");
    assert.equal(recovery.executorSelection.selectedReleaseId, "old-rel");

    assert.ok(child.lineage.executorSelection);
    assert.equal(child.lineage.executorSelection.mode, "preserve-parent");
  });

  it("recovery_created records executorSelection audit (use-current)", async () => {
    const job = await createJob(root, {
      dataRoot,
      project: P, task: "audit-override", executor: oldExecutor, ts: ts(900),
    });
    await failJob(root, P, job.jobId, {
      reason: "boom", code: FAILURE_CODES.RECOVERABLE, phase: "execute", ts: ts(901),
      dataRoot,
    });

    const child = await retryJob(root, P, job.jobId, {
      ts: ts(910), useCurrentExecutor: true, currentExecutor,
      dataRoot,
    });
    const events = await readEvents(root, P, child.jobId, { dataRoot });
    const recovery = events.find((e) => e.type === "recovery_created");

    assert.ok(recovery.executorSelection);
    assert.equal(recovery.executorSelection.mode, "use-current");
    assert.equal(recovery.executorSelection.override, true);
    assert.equal(recovery.executorSelection.parentRoot, "/tmp/cpb-old");
    assert.equal(recovery.executorSelection.selectedRoot, "/tmp/cpb-new");
    assert.equal(recovery.executorSelection.parentReleaseId, "old-rel");
    assert.equal(recovery.executorSelection.selectedReleaseId, "new-rel");

    assert.ok(child.lineage.executorSelection);
    assert.equal(child.lineage.executorSelection.mode, "use-current");
  });
});
