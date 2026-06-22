import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { handleDagNodeFailure } from "../core/engine/dag-node-failure.js";

test("handleDagNodeFailure records DAG failure, fails the job, reports progress, and returns retry verdict cause", async () => {
  const events: Record<string, any>[] = [];
  const failures: Record<string, any>[] = [];
  const progress: Record<string, any>[] = [];
  const phaseResults = [{ phase: "plan", status: "passed" }];

  const result = await handleDagNodeFailure({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-1",
    nodeId: "verify",
    phase: "verify",
    role: "verifier",
    attemptId: "attempt-1",
    dagNode: { checklistIds: ["item-1", "item-2"] },
    phaseResult: {
      status: "failed",
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "VERDICT: FAIL",
        retryable: true,
        cause: {
          verdict: { status: "fail", reason: "missing tests" },
          artifact: {
            kind: "verdict",
            id: "artifact-1",
            name: "verdict-1",
            path: "/tmp/verdict.md",
            bytes: 123,
            sha256: "abc123",
          },
          rawOutput: "ignored in retry cause",
        },
      },
    },
    phaseResults,
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, any>) => {
      events.push(event);
    },
    failJob: async (_cpbRoot: string, _project: string, _jobId: string, failure: Record<string, any>) => {
      failures.push(failure);
    },
    onProgress: async (event: Record<string, any>) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(events, [{
    type: "dag_node_failed",
    jobId: "job-1",
    project: "proj",
    nodeId: "verify",
    phase: "verify",
    role: "verifier",
    attemptId: "attempt-1",
    code: FailureKind.VERIFICATION_FAILED,
    reason: "VERDICT: FAIL",
    error: "VERDICT: FAIL",
    checklistIds: ["item-1", "item-2"],
    ts: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(failures, [{
    reason: "VERDICT: FAIL",
    code: FailureKind.VERIFICATION_FAILED,
    phase: "verify",
    cause: {
      kind: FailureKind.VERIFICATION_FAILED,
      reason: "VERDICT: FAIL",
      retryable: true,
      cause: {
        verdict: { status: "fail", reason: "missing tests" },
        artifact: {
          kind: "verdict",
          id: "artifact-1",
          name: "verdict-1",
          path: "/tmp/verdict.md",
          bytes: 123,
          sha256: "abc123",
        },
        rawOutput: "ignored in retry cause",
      },
      nodeId: "verify",
    },
  }]);
  assert.deepEqual(progress, [{
    ts: "2026-06-22T00:00:00.000Z",
    type: "job_failed",
    jobId: "job-1",
    project: "proj",
    phase: "verify",
    failureKind: FailureKind.VERIFICATION_FAILED,
    reason: "VERDICT: FAIL",
  }]);
  assert.deepEqual(result, {
    status: "failed",
    jobId: "job-1",
    exitCode: 1,
    failure: {
      kind: FailureKind.VERIFICATION_FAILED,
      phase: "verify",
      nodeId: "verify",
      reason: "VERDICT: FAIL",
      retryable: true,
      cause: {
        verdict: { status: "fail", reason: "missing tests" },
        artifact: {
          kind: "verdict",
          id: "artifact-1",
          name: "verdict-1",
          path: "/tmp/verdict.md",
          bytes: 123,
          sha256: "abc123",
        },
      },
    },
    phaseResults,
  });
});

test("handleDagNodeFailure uses fatal defaults for malformed failed phase results", async () => {
  const events: Record<string, any>[] = [];
  const failures: Record<string, any>[] = [];

  const result = await handleDagNodeFailure({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-2",
    nodeId: "execute",
    phase: "execute",
    role: "executor",
    attemptId: null,
    dagNode: {},
    phaseResult: { status: "failed" },
    phaseResults: [],
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, any>) => {
      events.push(event);
    },
    failJob: async (_cpbRoot: string, _project: string, _jobId: string, failure: Record<string, any>) => {
      failures.push(failure);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(events[0].code, "fatal");
  assert.equal(events[0].reason, "execute phase failed");
  assert.deepEqual(events[0].checklistIds, []);
  assert.deepEqual(failures[0], {
    reason: "execute phase failed",
    code: "fatal",
    phase: "execute",
    cause: { nodeId: "execute" },
  });
  assert.deepEqual(result.failure, {
    kind: undefined,
    phase: "execute",
    nodeId: "execute",
    reason: undefined,
    retryable: undefined,
  });
});
