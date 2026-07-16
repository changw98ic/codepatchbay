import assert from "node:assert/strict";
import { test } from "node:test";

import {
  handleArtifactInvalidCompletionFailure,
  handleCompletionGateFailure,
} from "../core/engine/completion-failure.js";

test("handleArtifactInvalidCompletionFailure records gate event, progress, failJob payload, and failed result", async () => {
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  const phaseResults = [{ phase: "plan", status: "passed" }];

  const result = await handleArtifactInvalidCompletionFailure({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-artifact-invalid",
    artifactInvalidReason: "artifact index read failed: missing checklist",
    phaseResults,
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    failJob: async (_cpbRoot: string, _project: string, _jobId: string, failure: Record<string, unknown>) => {
      failures.push(failure);
    },
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(events.length, 1);
  assert.equal(typeof events[0].ts, "string");
  assert.deepEqual({ ...events[0], ts: "<dynamic>" }, {
    type: "completion_gate_evaluated",
    jobId: "job-artifact-invalid",
    project: "proj",
    attemptId: null,
    outcome: "artifact_invalid",
    reason: "artifact index read failed: missing checklist",
    missingGates: ["artifact_index"],
    checklistOutcome: null,
    failedChecklistIds: [],
    uncheckedChecklistIds: [],
    missingEvidenceRefs: [],
    mismatchedEvidenceRefs: [],
    staleEvidenceRefs: [],
    poisonedEvidenceRefs: [],
    pollutedEvidenceRefs: [],
    pollutedOracleFiles: [],
    pollutedOracleFileCount: 0,
    runtimeFailureRefs: [],
    runtimeFailureCount: 0,
    unmappedChangedFiles: [],
    unmappedChangedFileCount: 0,
    ts: "<dynamic>",
  });
  assert.deepEqual(progress, [{
    ts: "2026-06-22T00:00:00.000Z",
    type: "completion_gate_blocked",
    jobId: "job-artifact-invalid",
    project: "proj",
    outcome: "artifact_invalid",
    reason: "artifact index read failed: missing checklist",
  }]);
  assert.deepEqual(failures, [{
    reason: "artifact index read failed: missing checklist",
    code: "artifact_invalid",
    phase: "completion_gate",
    cause: { artifactInvalidReason: "artifact index read failed: missing checklist" },
  }]);
  assert.deepEqual(result, {
    status: "failed",
    jobId: "job-artifact-invalid",
    exitCode: 1,
    failure: {
      kind: "artifact_invalid",
      phase: "completion_gate",
      reason: "artifact index read failed: missing checklist",
      cause: { artifactInvalidReason: "artifact index read failed: missing checklist" },
    },
    phaseResults,
  });
});

test("handleArtifactInvalidCompletionFailure ignores progress callback failures", async () => {
  const failures: Record<string, unknown>[] = [];

  const result = await handleArtifactInvalidCompletionFailure({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-progress-failure",
    artifactInvalidReason: "artifact loading failed",
    phaseResults: [],
    appendEvent: async () => {},
    failJob: async (_cpbRoot: string, _project: string, _jobId: string, failure: Record<string, unknown>) => {
      failures.push(failure);
    },
    onProgress: async () => {
      throw new Error("progress sink unavailable");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(failures.length, 1);
});

test("handleCompletionGateFailure records checklist routing metadata and failed result", async () => {
  const progress: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  const checklistVerdict = {
    items: [{ id: "item-1", status: "fail" }],
  };
  const phaseResults = [{ phase: "execute", status: "passed" }];
  const gateResult = {
    outcome: "checklist_failed",
    reason: "Required checklist item failed",
    missingGates: ["checklist"],
    details: {
      checklist: {
        failedFixScope: ["core/engine/run-job.ts"],
        failedChecklistIds: ["item-1"],
      },
    },
  };

  const result = await handleCompletionGateFailure({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-checklist-failed",
    gateResult,
    phaseResults,
    riskMap: null,
    checklistVerdict,
    failJob: async (_cpbRoot: string, _project: string, _jobId: string, failure: Record<string, unknown>) => {
      failures.push(failure);
    },
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  const expectedCause = {
    gateOutcome: "checklist_failed",
    missingGates: ["checklist"],
    details: gateResult.details,
    routingLabel: "checklist_failed",
    routingAction: "retry_same_worker",
    routingRetryPhase: "execute",
    fixScope: ["core/engine/run-job.ts"],
    checklistVerdict,
    targetChecklistIds: ["item-1"],
  };

  assert.deepEqual(progress, [{
    ts: "2026-06-22T00:00:00.000Z",
    type: "completion_gate_blocked",
    jobId: "job-checklist-failed",
    project: "proj",
    outcome: "checklist_failed",
    reason: "Required checklist item failed",
  }]);
  assert.deepEqual(failures, [{
    reason: "Required checklist item failed",
    code: "verification_failed",
    phase: "completion_gate",
    cause: expectedCause,
  }]);
  assert.deepEqual(result, {
    status: "failed",
    jobId: "job-checklist-failed",
    exitCode: 1,
    failure: {
      kind: "verification_failed",
      phase: "completion_gate",
      reason: "Required checklist item failed",
      retryable: true,
      cause: expectedCause,
    },
    phaseResults,
  });
});

test("handleCompletionGateFailure routes mismatched evidence back to execute by checklist id", async () => {
  const failures: Record<string, unknown>[] = [];
  const checklistVerdict = {
    schemaVersion: 1,
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-1", evidenceId: "EV-001" }],
        reason: "ok",
        fixScope: [],
      },
      {
        checklistId: "AC-002",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-1", evidenceId: "EV-002" }],
        reason: "claimed ok",
        fixScope: [],
      },
    ],
    blocking: [],
    fixScope: [],
    reason: "claimed pass",
  };
  const gateResult = {
    outcome: "evidence_mismatch",
    reason: "pass verdict references evidence that does not prove the checklist item",
    missingGates: ["checklist"],
    details: {
      checklist: {
        failedChecklistIds: [],
        uncheckedChecklistIds: [],
        failedFixScope: [],
        mismatchedEvidenceRefs: [{ ledgerId: "ledger-1", evidenceId: "EV-002" }],
      },
    },
  };

  const result = await handleCompletionGateFailure({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-evidence-mismatch",
    gateResult,
    phaseResults: [{ phase: "execute", status: "passed" }, { phase: "verify", status: "passed" }],
    riskMap: null,
    checklistVerdict,
    failJob: async (_cpbRoot: string, _project: string, _jobId: string, failure: Record<string, unknown>) => {
      failures.push(failure);
    },
    onProgress: null,
  });

  const cause = result.failure.cause as {
    routingAction?: unknown;
    routingRetryPhase?: unknown;
    targetChecklistIds?: unknown;
    fixScope?: unknown;
  };
  assert.equal(result.failure.kind, "verification_failed");
  assert.equal(result.failure.retryable, true);
  assert.equal(cause.routingAction, "retry_same_worker");
  assert.equal(cause.routingRetryPhase, "execute");
  assert.deepEqual(cause.targetChecklistIds, ["AC-002"]);
  assert.deepEqual(cause.fixScope, []);
  assert.equal(failures[0].code, "verification_failed");
});

test("handleCompletionGateFailure preserves adversarial retry context", async () => {
  const failures: Record<string, unknown>[] = [];
  const phaseResults = [
    {
      phase: "adversarial_verify",
      status: "failed",
      failure: {
        cause: {
          focus: ["src/stale-focus.ts"],
          verdict: { reason: "stale failure", details: { file: "src/stale-focus.ts" } },
        },
      },
    },
    {
      phase: "execute",
      status: "passed",
      artifact: { path: "src/changed.ts" },
    },
    {
      phase: "adversarial_verify",
      status: "failed",
      failure: {
        cause: {
          focus: ["src/high-risk.ts"],
          verdict: {
            reason: "mutation escaped scope",
            details: { file: "src/high-risk.ts" },
          },
        },
      },
    },
  ];
  const gateResult = {
    outcome: "adversarial_failed",
    reason: "Adversarial verification failed",
    missingGates: ["adversarial_verdict"],
    details: {
      adversarialRequired: true,
    },
  };

  const result = await handleCompletionGateFailure({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-adversarial-failed",
    gateResult,
    phaseResults,
    riskMap: {
      adversarialFocus: ["src/fallback-focus.ts"],
      highRiskFiles: ["src/fallback-risk.ts"],
    },
    checklistVerdict: null,
    failJob: async (_cpbRoot: string, _project: string, _jobId: string, failure: Record<string, unknown>) => {
      failures.push(failure);
    },
    onProgress: null,
  });

  assert.equal(result.status, "failed");
  assert.equal(failures.length, 1);
  assert.deepEqual((failures[0].cause as Record<string, unknown>).retryContext, {
    reason: "adversarial_verification_failed",
    adversarialFocus: ["src/high-risk.ts"],
    verdictReason: "mutation escaped scope",
    blockingEvidence: { file: "src/high-risk.ts" },
    fix_scope: ["src/fallback-focus.ts"],
  });
});
