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
import { readEvents } from "../server/services/event-store.js";

const root = await mkdtemp(path.join(tmpdir(), "cpb-terminal-immutable-"));
const P = "immu-test";
const ts = (offset) => {
  const d = new Date("2026-05-20T00:00:00.000Z");
  d.setSeconds(d.getSeconds() + offset);
  return d.toISOString();
};

describe("write-time terminal guards", () => {
  it("startPhase rejects on failed job", async () => {
    const job = await createJob(root, { project: P, task: "t", ts: ts(1) });
    await failJob(root, P, job.jobId, {
      reason: "boom", code: FAILURE_CODES.FATAL, ts: ts(2),
    });
    await assert.rejects(
      () => startPhase(root, P, job.jobId, { phase: "plan" }),
      /job is terminal: failed/,
    );
  });

  it("startPhase rejects on cancelled job", async () => {
    const job = await createJob(root, { project: P, task: "t", ts: ts(10) });
    await requestCancelJob(root, P, job.jobId, { reason: "stop", ts: ts(11) });
    await cancelJob(root, P, job.jobId, { reason: "stop", ts: ts(12) });
    await assert.rejects(
      () => startPhase(root, P, job.jobId, { phase: "plan" }),
      /job is terminal: cancelled/,
    );
  });

  it("startPhase rejects on completed job", async () => {
    const job = await createJob(root, { project: P, task: "t", ts: ts(20) });
    await completeJob(root, P, job.jobId, { ts: ts(21) });
    await assert.rejects(
      () => startPhase(root, P, job.jobId, { phase: "plan" }),
      /job is terminal: completed/,
    );
  });

  it("startPhase rejects on blocked job", async () => {
    const job = await createJob(root, { project: P, task: "t", ts: ts(30) });
    await blockJob(root, P, job.jobId, { reason: "stuck", ts: ts(31) });
    await assert.rejects(
      () => startPhase(root, P, job.jobId, { phase: "plan" }),
      /job is terminal: blocked/,
    );
  });

  it("completePhase rejects on failed job", async () => {
    const job = await createJob(root, { project: P, task: "t", ts: ts(40) });
    await failJob(root, P, job.jobId, {
      reason: "x", code: FAILURE_CODES.FATAL, ts: ts(41),
    });
    await assert.rejects(
      () => completePhase(root, P, job.jobId, { phase: "plan", artifact: "a.md" }),
      /job is terminal: failed/,
    );
  });

  it("completePhase rejects on cancelled job", async () => {
    const job = await createJob(root, { project: P, task: "t", ts: ts(50) });
    await requestCancelJob(root, P, job.jobId, { reason: "x", ts: ts(51) });
    await cancelJob(root, P, job.jobId, { reason: "x", ts: ts(52) });
    await assert.rejects(
      () => completePhase(root, P, job.jobId, { phase: "plan", artifact: "a.md" }),
      /job is terminal: cancelled/,
    );
  });

  it("business-state mutations reject after terminal failure and leave event log unchanged", async () => {
    const job = await createJob(root, { project: P, task: "t", ts: ts(60) });
    await failJob(root, P, job.jobId, {
      reason: "original failure", code: FAILURE_CODES.RECOVERABLE, phase: "execute", ts: ts(61),
    });
    const before = await readEvents(root, P, job.jobId);

    await assert.rejects(
      () => completeJob(root, P, job.jobId, { ts: ts(62) }),
      /job is terminal: failed/,
    );
    await assert.rejects(
      () => blockJob(root, P, job.jobId, { reason: "late block", ts: ts(63) }),
      /job is terminal: failed/,
    );
    await assert.rejects(
      () => cancelJob(root, P, job.jobId, { reason: "late cancel", ts: ts(64) }),
      /job is terminal: failed/,
    );
    await assert.rejects(
      () => failJob(root, P, job.jobId, { reason: "late fail", code: FAILURE_CODES.FATAL, ts: ts(65) }),
      /job is terminal: failed/,
    );
    await assert.rejects(
      () => budgetExceeded(root, P, job.jobId, { reason: "late budget", ts: ts(66) }),
      /job is terminal: failed/,
    );
    await assert.rejects(
      () => requestCancelJob(root, P, job.jobId, { reason: "late request", ts: ts(67) }),
      /job is terminal: failed/,
    );

    const after = await readEvents(root, P, job.jobId);
    assert.equal(after.length, before.length);
    const state = await getJob(root, P, job.jobId);
    assert.equal(state.status, "failed");
    assert.equal(state.blockedReason, "original failure");
    assert.equal(state.failureCode, FAILURE_CODES.RECOVERABLE);
  });
});

describe("event log immutability after recovery", () => {
  it("failed job event count is unchanged after retryJob", async () => {
    const job = await createJob(root, { project: P, task: "t", ts: ts(100) });
    await startPhase(root, P, job.jobId, { phase: "plan", leaseId: "l1", ts: ts(101) });
    await completePhase(root, P, job.jobId, {
      phase: "plan", artifact: "plan-001.md", ts: ts(102),
    });
    await failJob(root, P, job.jobId, {
      reason: "verify crash", code: FAILURE_CODES.RECOVERABLE, phase: "verify", ts: ts(103),
    });

    const eventsBefore = await readEvents(root, P, job.jobId);
    const countBefore = eventsBefore.length;

    await retryJob(root, P, job.jobId, { ts: ts(110) });

    const eventsAfter = await readEvents(root, P, job.jobId);
    assert.equal(eventsAfter.length, countBefore, "original job event log must not grow after retry");

    const stateAfter = await getJob(root, P, job.jobId);
    assert.equal(stateAfter.status, "failed");
    assert.equal(stateAfter.failureCode, FAILURE_CODES.RECOVERABLE);
    assert.equal(stateAfter.failurePhase, "verify");
    assert.equal(stateAfter.artifacts.plan, "plan-001.md");
  });

  it("cancelled job event log unchanged after retryJob with force", async () => {
    const job = await createJob(root, { project: P, task: "t", ts: ts(200) });
    await startPhase(root, P, job.jobId, { phase: "plan", leaseId: "l2", ts: ts(201) });
    await requestCancelJob(root, P, job.jobId, { reason: "user", ts: ts(202) });
    await cancelJob(root, P, job.jobId, { reason: "user", ts: ts(203) });

    const eventsBefore = await readEvents(root, P, job.jobId);
    const countBefore = eventsBefore.length;

    await retryJob(root, P, job.jobId, { force: true, ts: ts(210) });

    const eventsAfter = await readEvents(root, P, job.jobId);
    assert.equal(eventsAfter.length, countBefore);
  });
});

describe("recovery chain — multi-level lineage", () => {
  it("grandchild links to parent, not grandparent directly", async () => {
    // Level 1: original job fails
    const grandparent = await createJob(root, { project: P, task: "chain-test", ts: ts(300) });
    await startPhase(root, P, grandparent.jobId, { phase: "plan", leaseId: "l10", ts: ts(301) });
    await failJob(root, P, grandparent.jobId, {
      reason: "L1 fail", code: FAILURE_CODES.RECOVERABLE, phase: "plan", ts: ts(302),
    });

    // Level 2: first recovery (parent)
    const parent = await retryJob(root, P, grandparent.jobId, { ts: ts(310) });
    assert.notEqual(parent.jobId, grandparent.jobId);
    assert.equal(parent.lineage.parentJobId, grandparent.jobId);
    assert.equal(parent.lineage.parentStatus, "failed");

    // Fail the parent too
    await startPhase(root, P, parent.jobId, { phase: "plan", leaseId: "l11", ts: ts(311) });
    await failJob(root, P, parent.jobId, {
      reason: "L2 fail", code: FAILURE_CODES.RECOVERABLE, phase: "plan", ts: ts(312),
    });

    // Level 3: second recovery (child)
    const child = await retryJob(root, P, parent.jobId, { ts: ts(320) });
    assert.notEqual(child.jobId, parent.jobId);
    assert.notEqual(child.jobId, grandparent.jobId);
    assert.equal(child.lineage.parentJobId, parent.jobId, "child links to parent, not grandparent");
    assert.equal(child.lineage.parentStatus, "failed");

    // Grandparent untouched
    const gpState = await getJob(root, P, grandparent.jobId);
    assert.equal(gpState.status, "failed");

    // Parent untouched
    const pParent = await getJob(root, P, parent.jobId);
    assert.equal(pParent.status, "failed");
  });
});

describe("pipeline retry starts fresh from current phase", () => {
  it("retry from execute-failed job infers fromPhase=execute, carries no artifacts", async () => {
    const job = await createJob(root, { project: P, task: "pipeline-test", workflow: "standard", ts: ts(400) });
    await startPhase(root, P, job.jobId, { phase: "plan", leaseId: "l20", ts: ts(401) });
    await completePhase(root, P, job.jobId, {
      phase: "plan", artifact: "plan-050.md", ts: ts(402),
    });
    await startPhase(root, P, job.jobId, { phase: "execute", leaseId: "l21", ts: ts(403) });
    await failJob(root, P, job.jobId, {
      reason: "execute bombed", code: FAILURE_CODES.RECOVERABLE, phase: "execute", ts: ts(404),
    });

    const recovered = await retryJob(root, P, job.jobId, { ts: ts(410) });
    assert.equal(recovered.status, "running");
    assert.equal(recovered.task, "pipeline-test");

    // Fresh job has no artifacts from the original
    assert.deepEqual(recovered.artifacts, {});

    // recovery_created event has correct fromPhase
    const events = await readEvents(root, P, recovered.jobId);
    const recoveryEvent = events.find((e) => e.type === "recovery_created");
    assert.ok(recoveryEvent);
    assert.equal(recoveryEvent.fromPhase, "execute", "retry should restart from execute");
    assert.equal(recoveryEvent.lineage.parentJobId, job.jobId);
    assert.equal(recoveryEvent.lineage.parentFailurePhase, "execute");
  });

  it("retry with explicit fromPhase overrides inference", async () => {
    const job = await createJob(root, { project: P, task: "explicit-phase", workflow: "standard", ts: ts(500) });
    await startPhase(root, P, job.jobId, { phase: "plan", leaseId: "l30", ts: ts(501) });
    await completePhase(root, P, job.jobId, {
      phase: "plan", artifact: "plan-060.md", ts: ts(502),
    });
    await startPhase(root, P, job.jobId, { phase: "execute", leaseId: "l31", ts: ts(503) });
    await completePhase(root, P, job.jobId, {
      phase: "execute", artifact: "deliverable-060.md", ts: ts(504),
    });
    await startPhase(root, P, job.jobId, { phase: "verify", leaseId: "l32", ts: ts(505) });
    await failJob(root, P, job.jobId, {
      reason: "verify rejected", code: FAILURE_CODES.QUALITY_FAIL, phase: "verify", ts: ts(506),
    });

    const recovered = await retryJob(root, P, job.jobId, { fromPhase: "plan", force: true, ts: ts(510) });
    const events = await readEvents(root, P, recovered.jobId);
    const recoveryEvent = events.find((e) => e.type === "recovery_created");
    assert.equal(recoveryEvent.fromPhase, "plan", "explicit fromPhase overrides inference");
  });
});
