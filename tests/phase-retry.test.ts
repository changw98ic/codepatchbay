import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { runPhaseRetryLoops } from "../core/engine/phase-retry.js";

function failedResult(kind: string, overrides: Record<string, any> = {}) {
  return {
    schemaVersion: 1,
    phase: "execute",
    status: "failed",
    artifact: null,
    failure: {
      kind,
      phase: "execute",
      reason: "initial failure",
      retryable: true,
      stderrSnippet: "stderr fallback",
      cause: {},
      ...overrides,
    },
    diagnostics: {},
  };
}

function baseState(overrides: Record<string, any> = {}) {
  return {
    phase: "execute",
    role: "executor",
    nodeId: "execute",
    dagNode: { id: "execute", phase: "execute" },
    project: "proj",
    task: "phase retry task",
    jobId: "job-phase-retry",
    job: { jobId: "job-phase-retry" },
    workflow: "standard",
    planMode: "full",
    cpbRoot: "/tmp/cpb",
    dataRoot: "/tmp/data",
    sourcePath: "/tmp/source",
    phaseSourceContext: { base: true },
    pool: { id: "pool" },
    state: { planId: "plan-1" },
    phaseResults: [{ phase: "plan", status: "passed" }],
    attemptId: "attempt-1",
    phaseTimeout: 1000,
    phaseAgents: { executor: "fake-acp" },
    ...overrides,
  };
}

test("runPhaseRetryLoops retries retryable transient failures after configured delay", async () => {
  const events: Record<string, any>[] = [];
  const progress: Record<string, any>[] = [];
  const delays: number[] = [];
  const runInputs: Record<string, any>[] = [];

  const result = await runPhaseRetryLoops({
    agent: "fake-acp",
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, any>) => {
      events.push(event);
    },
    onProgress: async (event: Record<string, any>) => {
      progress.push(event);
    },
  }, {
    ...baseState(),
    result: failedResult(FailureKind.TIMEOUT),
  }, {
    phaseRetryMax: 2,
    phaseFeedbackRetryMax: 1,
    retryBaseDelayMs: () => 25,
    delay: async (ms: number) => {
      delays.push(ms);
    },
    now: () => "2026-06-22T00:00:00.000Z",
    runPhase: async (input: Record<string, any>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "execute",
        status: "passed",
        artifact: { name: "deliverable-1" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(delays, [25]);
  assert.equal(runInputs.length, 1);
  assert.deepEqual(runInputs[0].sourceContext, { base: true });
  assert.equal(events[0].type, "phase_retry");
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].maxAttempts, 2);
  assert.equal(progress.some((event) => event.type === "phase_retry"), true);
});

test("runPhaseRetryLoops appends feedback context for artifact validation failures", async () => {
  const events: Record<string, any>[] = [];
  const runInputs: Record<string, any>[] = [];

  const result = await runPhaseRetryLoops({
    agent: "fake-acp",
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, any>) => {
      events.push(event);
    },
  }, {
    ...baseState(),
    result: failedResult(FailureKind.ARTIFACT_INVALID, {
      retryable: false,
      reason: "artifact missing field",
      cause: { rawOutput: "raw invalid artifact" },
    }),
  }, {
    phaseRetryMax: 0,
    phaseFeedbackRetryMax: 1,
    now: () => "2026-06-22T00:00:00.000Z",
    runPhase: async (input: Record<string, any>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "execute",
        status: "passed",
        artifact: { name: "deliverable-2" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(events[0].type, "phase_feedback_retry");
  assert.equal(events[0].failureKind, FailureKind.ARTIFACT_INVALID);
  assert.deepEqual(runInputs[0].sourceContext.retry, {
    failureKind: FailureKind.ARTIFACT_INVALID,
    failureReason: "artifact missing field",
    previousOutput: "stderr fallback",
    attempt: 1,
  });
});

test("runPhaseRetryLoops does not retry quota delegate write failures", async () => {
  let runCalls = 0;
  const result = await runPhaseRetryLoops({}, {
    ...baseState(),
    result: failedResult(FailureKind.RUNTIME_INTERRUPTED, {
      reason: "quota delegate failure",
      cause: { code: "QUOTA_DELEGATE_CLIENT_UNAVAILABLE" },
    }),
  }, {
    phaseRetryMax: 2,
    phaseFeedbackRetryMax: 1,
    runPhase: async () => {
      runCalls += 1;
      throw new Error("quota delegate failures must not be retried here");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(runCalls, 0);
});
