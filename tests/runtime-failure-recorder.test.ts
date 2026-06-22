import assert from "node:assert/strict";
import { test } from "node:test";

import { collectRuntimeFailures, recordRuntimeFailureEvents } from "../core/engine/runtime-failure-recorder.js";

test("collectRuntimeFailures extracts poisoned sessions, panics, and diagnostic poisoned sessions", () => {
  const failures = collectRuntimeFailures({
    attemptId: "attempt-1",
    phaseResults: [{
      phase: "execute",
      failure: {
        kind: "poisoned_session",
        reason: "poisoned session: refusal",
      },
    }, {
      phase: "plan",
      failure: {
        kind: "runjob_panic",
        reason: "panic: boom",
      },
    }, {
      phase: "verify",
      diagnostics: {
        nodeId: "verify-node",
        poisonedSession: {
          reasons: ["invalid_request", "context window exceeded"],
        },
      },
    }, {
      phase: "verify",
      diagnostics: {
        nodeId: "duplicate-node",
        poisonedSession: {
          reason: "duplicate diagnostic must not produce a second phase_poisoned_session",
        },
      },
    }, {
      phase: "review",
      failure: {
        kind: "verification_failed",
        reason: "not a runtime failure",
      },
    }],
  });

  assert.deepEqual(failures, [{
    type: "poisoned_session",
    attemptId: "attempt-1",
    phase: "execute",
    nodeId: null,
    reason: "poisoned session: refusal",
  }, {
    type: "runjob_panic",
    attemptId: "attempt-1",
    phase: "plan",
    nodeId: null,
    reason: "panic: boom",
  }, {
    type: "phase_poisoned_session",
    attemptId: "attempt-1",
    phase: "verify",
    nodeId: "verify-node",
    reason: "invalid_request, context window exceeded",
  }]);
});

test("recordRuntimeFailureEvents emits runtime_failure_recorded events with fallback attempt id", async () => {
  const events: Record<string, any>[] = [];

  await recordRuntimeFailureEvents({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-runtime",
    attemptId: "active-attempt",
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: null,
      phase: "verify",
      nodeId: "verify-node",
      reason: "invalid_request",
    }, {
      type: "runjob_panic",
      attemptId: "panic-attempt",
      phase: "execute",
      nodeId: null,
      reason: "panic: boom",
    }],
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, any>) => {
      events.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(events, [{
    type: "runtime_failure_recorded",
    jobId: "job-runtime",
    project: "proj",
    failureType: "phase_poisoned_session",
    attemptId: "active-attempt",
    phase: "verify",
    nodeId: "verify-node",
    reason: "invalid_request",
    ts: "2026-06-22T00:00:00.000Z",
  }, {
    type: "runtime_failure_recorded",
    jobId: "job-runtime",
    project: "proj",
    failureType: "runjob_panic",
    attemptId: "panic-attempt",
    phase: "execute",
    nodeId: null,
    reason: "panic: boom",
    ts: "2026-06-22T00:00:00.000Z",
  }]);
});
