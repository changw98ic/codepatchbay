#!/usr/bin/env node

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LooseRecord } from "../shared/types.js";

import { materializeJob } from "../server/services/event/event-store.js";


function ts(offset = 0) {
  return new Date(Date.now() + offset).toISOString();
}

const JOB_CREATED = { type: "job_created", jobId: "j1", project: "p", task: "t", ts: ts(0) };

function materialize(...events: LooseRecord[]) {
  return materializeJob([JOB_CREATED, ...events]) as LooseRecord;
}

// ── Runtime context snapshot tests ──────────────────────────────────

describe("runtime_context_snapshot materialization", () => {
  it("runtime_context_snapshot materializes into runtimeContext state", () => {
    const eventTs = ts(50);
    const heartbeatTs = ts(100);
    const state = materialize(
      { type: "runtime_context_snapshot", jobId: "j1", project: "p", attemptId: "j1", assignmentId: "a-entry1", workerId: "w-abc", model: "gpt-4o", runtime: "standard", queueId: "q-1", queuePriority: 5, concurrencyKey: "ck-proj", rateLimitedUntil: null, heartbeatAt: heartbeatTs, progressKind: "phase_started", blocker: null, ts: eventTs },
    );
    assert.ok(state.runtimeContext);
    assert.equal(state.runtimeContext.assignmentId, "a-entry1");
    assert.equal(state.runtimeContext.workerId, "w-abc");
    assert.equal(state.runtimeContext.model, "gpt-4o");
    assert.equal(state.runtimeContext.runtime, "standard");
    assert.equal(state.runtimeContext.queueId, "q-1");
    assert.equal(state.runtimeContext.queuePriority, 5);
    assert.equal(state.runtimeContext.concurrencyKey, "ck-proj");
    assert.equal(state.runtimeContext.rateLimitedUntil, null);
    assert.equal(state.runtimeContext.heartbeatAt, heartbeatTs);
    assert.equal(state.runtimeContext.progressKind, "phase_started");
    assert.equal(state.runtimeContext.blocker, null);
    assert.ok(state.runtimeContext.ts);
  });

  it("runtime_context_snapshot with blocker from human approval failure", () => {
    const state = materialize(
      { type: "runtime_context_snapshot", jobId: "j1", project: "p", attemptId: "j1", assignmentId: "a-2", workerId: "w-2", model: "sonnet", runtime: "standard", queueId: null, queuePriority: null, concurrencyKey: null, rateLimitedUntil: "2026-06-12T01:00:00Z", heartbeatAt: ts(80), progressKind: null, blocker: "manual approval required for AC-004", ts: ts(90) },
    );
    assert.ok(state.runtimeContext);
    assert.equal(state.runtimeContext.blocker, "manual approval required for AC-004");
    assert.equal(state.runtimeContext.rateLimitedUntil, "2026-06-12T01:00:00Z");
  });

  it("runtime_context_snapshot is overwritten by later snapshots", () => {
    const state = materialize(
      { type: "runtime_context_snapshot", jobId: "j1", project: "p", attemptId: "j1", assignmentId: "a-1", workerId: "w-1", model: "gpt-4o", runtime: "standard", ts: ts(50) },
      { type: "runtime_context_snapshot", jobId: "j1", project: "p", attemptId: "j1", assignmentId: "a-2", workerId: "w-2", model: "opus", runtime: "standard", ts: ts(100) },
    );
    assert.equal(state.runtimeContext.model, "opus");
    assert.equal(state.runtimeContext.workerId, "w-2");
  });

  it("runtime_context_snapshot survives after terminal events", () => {
    const state = materialize(
      { type: "job_failed", jobId: "j1", project: "p", reason: "error", code: "fatal", ts: ts(100) },
      { type: "runtime_context_snapshot", jobId: "j1", project: "p", attemptId: "j1", assignmentId: "a-1", workerId: "w-1", model: "gpt-4o", runtime: "standard", ts: ts(150) },
    );
    // runtime_context_snapshot is in POST_TERMINAL_ALLOWED
    assert.ok(state.runtimeContext);
    assert.equal(state.runtimeContext.model, "gpt-4o");
  });

  it("runtimeContext defaults to null when no snapshot event exists", () => {
    const state = materialize();
    assert.equal(state.runtimeContext, null);
  });
});

// ── Audit finalized tests ───────────────────────────────────────────

describe("audit_finalized event materialization", () => {
  it("audit_finalized materializes into auditFinalized state", () => {
    const state = materialize(
      { type: "job_completed", jobId: "j1", project: "p", ts: ts(100) },
      { type: "audit_finalized", jobId: "j1", project: "p", attemptId: "j1", status: "completed", reason: null, ts: ts(200) },
    );
    assert.ok(state.auditFinalized);
    assert.equal(state.auditFinalized.attemptId, "j1");
    assert.equal(state.auditFinalized.status, "completed");
    assert.equal(state.auditFinalized.reason, null);
    assert.ok(state.auditFinalized.ts, "auditFinalized.ts must be a valid timestamp");
  });

  it("audit_finalized after job_failed preserves failed status", () => {
    const state = materialize(
      { type: "job_failed", jobId: "j1", project: "p", reason: "verify failed", code: "verification_failed", ts: ts(100) },
      { type: "audit_finalized", jobId: "j1", project: "p", attemptId: "j1", status: "failed", reason: "verify failed", ts: ts(200) },
    );
    assert.equal(state.status, "failed");
    assert.ok(state.auditFinalized);
    assert.equal(state.auditFinalized.status, "failed");
    assert.equal(state.auditFinalized.reason, "verify failed");
  });

  it("audit_finalized does not change job status from failed to completed", () => {
    const state = materialize(
      { type: "job_failed", jobId: "j1", project: "p", reason: "error", code: "fatal", ts: ts(100) },
      { type: "audit_finalized", jobId: "j1", project: "p", attemptId: "j1", status: "completed", reason: null, ts: ts(200) },
    );
    // audit_finalized is audit-only; it cannot mark a failed job as successful
    assert.equal(state.status, "failed");
    assert.ok(state.auditFinalized);
    assert.equal(state.auditFinalized.status, "completed");
  });

  it("audit_finalized after job_blocked preserves blocked status", () => {
    const state = materialize(
      { type: "job_blocked", jobId: "j1", project: "p", reason: "needs clarification", code: "needs_clarification", ts: ts(100) },
      { type: "audit_finalized", jobId: "j1", project: "p", attemptId: "j1", status: "blocked", reason: "needs clarification", ts: ts(200) },
    );
    assert.equal(state.status, "blocked");
    assert.ok(state.auditFinalized);
    assert.equal(state.auditFinalized.status, "blocked");
  });

  it("auditFinalized defaults to null when no event exists", () => {
    const state = materialize();
    assert.equal(state.auditFinalized, null);
  });

  it("audit_finalized preserves attemptId from multi-attempt job", () => {
    const state = materialize(
      { type: "job_failed", jobId: "j1", project: "p", reason: "error", code: "fatal", ts: ts(100) },
      { type: "audit_finalized", jobId: "j1", project: "p", attemptId: "attempt-003", status: "failed", reason: "final attempt failed", ts: ts(200) },
    );
    assert.equal(state.auditFinalized.attemptId, "attempt-003");
  });

  it("audit_finalized survives after terminal job_failed event", () => {
    // This proves audit_finalized is in POST_TERMINAL_ALLOWED
    const state = materialize(
      { type: "job_failed", jobId: "j1", project: "p", reason: "panic", code: "runjob_panic", ts: ts(100) },
      { type: "audit_finalized", jobId: "j1", project: "p", attemptId: "j1", status: "failed", reason: "panic recovery", ts: ts(200) },
    );
    assert.equal(state.status, "failed");
    assert.ok(state.auditFinalized);
    assert.equal(state.auditFinalized.reason, "panic recovery");
  });
});
