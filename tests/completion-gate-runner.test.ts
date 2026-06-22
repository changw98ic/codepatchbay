import assert from "node:assert/strict";
import { test } from "node:test";

import { runCompletionGate } from "../core/engine/completion-gate-runner.js";

test("runCompletionGate appends a complete gate event and completes the job", async () => {
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];
  const completed: string[] = [];
  const phaseResults = [{
    phase: "verify",
    status: "passed",
    verdict: "VERDICT: PASS",
  }];

  const result = await runCompletionGate({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-complete",
    job: { workflow: "standard", planMode: "full" },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    riskMap: {},
    dynamicAgentPlan: {},
    phaseResults,
    appendEvent: async (_cpbRoot, _project, _jobId, event) => {
      events.push(event);
    },
    failJob: async () => {
      throw new Error("failJob should not be called");
    },
    completeJob: async (_cpbRoot, _project, jobId) => {
      completed.push(jobId);
    },
    onProgress: async (event) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(completed, ["job-complete"]);
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0], ts: "<dynamic>" }, {
    type: "completion_gate_evaluated",
    jobId: "job-complete",
    project: "proj",
    attemptId: null,
    outcome: "complete",
    reason: "All required completion gates passed",
    missingGates: [],
    checklistOutcome: null,
    failedChecklistIds: [],
    uncheckedChecklistIds: [],
    missingEvidenceRefs: [],
    mismatchedEvidenceRefs: [],
    staleEvidenceRefs: [],
    poisonedEvidenceRefs: [],
    runtimeFailureRefs: [],
    runtimeFailureCount: 0,
    unmappedChangedFiles: [],
    unmappedChangedFileCount: 0,
    ts: "<dynamic>",
  });
  assert.deepEqual(progress, [
    {
      ts: "2026-06-22T00:00:00.000Z",
      type: "completion_gate_passed",
      jobId: "job-complete",
      project: "proj",
    },
    {
      ts: "2026-06-22T00:00:00.000Z",
      type: "job_completed",
      jobId: "job-complete",
      project: "proj",
    },
  ]);
});

test("runCompletionGate records runtime failures before evaluating the gate", async () => {
  const events: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];

  const result = await runCompletionGate({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-runtime-failure",
    job: { workflow: "standard", planMode: "full" },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    riskMap: {},
    phaseResults: [{
      phase: "verify",
      status: "failed",
      failure: {
        kind: "poisoned_session",
        reason: "agent refused task",
      },
    }],
    attemptId: "attempt-1",
    appendEvent: async (_cpbRoot, _project, _jobId, event) => {
      events.push(event);
    },
    failJob: async (_cpbRoot, _project, _jobId, failure) => {
      failures.push(failure);
    },
    completeJob: async () => {
      throw new Error("completeJob should not be called");
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(events[0].type, "runtime_failure_recorded");
  assert.equal(events[0].failureType, "poisoned_session");
  assert.equal(events[1].type, "completion_gate_evaluated");
  assert.equal(events[1].outcome, "verification_incomplete");
  assert.equal(failures[0].reason, "Verify phase has not completed");
});
