import { test } from "node:test";
import assert from "node:assert/strict";
import { FailureKind } from "../core/contracts/failure.js";
import { finalizeAuditTrail } from "../core/engine/run-job-lifecycle.js";
import type { JobRunResult } from "../core/engine/run-job-shared.js";

// Locks the audit-trail hygiene invariant: a job that threw before createJob
// resolved a real id must NOT persist runtime_context_snapshot / audit_finalized
// events with the literal "unknown" jobId. The panic path still RETURNS
// result.jobId === "unknown" as a public contract; finalizeAuditTrail is the
// boundary that prevents that sentinel from leaking into the durable event log.

function spyAppendEvent() {
  const calls: Array<{ jobId: unknown; type: string }> = [];
  const appendEvent = async (
    _cpbRoot: string,
    _project: string,
    jobId: string,
    event: { type: string },
  ) => {
    calls.push({ jobId, type: event.type });
  };
  return { appendEvent, calls };
}

const failedResult = (jobId: string): JobRunResult =>
  ({
    status: "failed",
    jobId,
    exitCode: 1,
    failure: {
      kind: FailureKind.RUNJOB_PANIC,
      phase: "prepare_task",
      reason: "boom",
      retryable: false,
      cause: { panicType: "Error", stack: null },
    },
  }) as unknown as JobRunResult;

test("finalizeAuditTrail writes both events for a real jobId", async () => {
  const { appendEvent, calls } = spyAppendEvent();
  await finalizeAuditTrail({
    cpbRoot: "/tmp/cpb",
    project: "p",
    jobId: "job-real-1",
    attemptId: "att-1",
    appendEvent,
    result: failedResult("job-real-1"),
    sourceContext: null,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, "runtime_context_snapshot");
  assert.equal(calls[0].jobId, "job-real-1");
  assert.equal(calls[1].type, "audit_finalized");
  assert.equal(calls[1].jobId, "job-real-1");
});

test("finalizeAuditTrail skips events when jobId is the 'unknown' sentinel", async () => {
  const { appendEvent, calls } = spyAppendEvent();
  await finalizeAuditTrail({
    cpbRoot: "/tmp/cpb",
    project: "p",
    jobId: "unknown",
    attemptId: "unknown",
    appendEvent,
    result: failedResult("unknown"),
    sourceContext: null,
  });
  assert.equal(calls.length, 0);
});

test("finalizeAuditTrail skips events when jobId is absent (null / undefined)", async () => {
  const { appendEvent: ae1, calls: calls1 } = spyAppendEvent();
  await finalizeAuditTrail({
    cpbRoot: "/tmp/cpb",
    project: "p",
    jobId: undefined,
    attemptId: undefined,
    appendEvent: ae1,
    result: failedResult("unknown"),
    sourceContext: null,
  });
  assert.equal(calls1.length, 0);

  const { appendEvent: ae2, calls: calls2 } = spyAppendEvent();
  await finalizeAuditTrail({
    cpbRoot: "/tmp/cpb",
    project: "p",
    jobId: null,
    attemptId: null,
    appendEvent: ae2,
    result: failedResult("unknown"),
    sourceContext: null,
  });
  assert.equal(calls2.length, 0);
});
