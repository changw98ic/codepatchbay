import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCompletionReport, handleCompletionSuccess } from "../core/engine/completion-success.js";

test("buildCompletionReport summarizes changed files, real-path evidence, commands, and residual risk", () => {
  const report = buildCompletionReport({
    project: "proj",
    jobId: "job-report",
    riskMap: { riskLevel: "high", adversarialRequired: true, residualRisks: ["manual smoke not run"] },
    phaseResults: [{ phase: "execute", artifact: { metadata: { residualRisks: ["browser check skipped"] } } }],
    checklistArtifacts: {
      "acceptance-checklist": {
        items: [{
          id: "AC-001",
          requirement: "real API route handles JSON",
          verificationMethod: "command",
          required: true,
          realActors: ["ApiController"],
          realEntrypoints: ["/api/status"],
          bypassCandidates: ["cache path"],
          requiredEvidenceClass: "real_path_probe",
          requiredEvidenceOrigin: "user_required",
        }],
        assumptions: [{ text: "manual deploy validation remains out of scope" }],
      },
      "execution-map": { changedFiles: ["server/routes/status.ts", "tests/status.test.ts"] },
      "evidence-ledger": {
        evidence: [{
          evidenceClass: "real_path_probe",
          evidenceOrigin: "user_required",
          verificationMethod: "command",
          command: "npm test -- status",
          result: "pass",
        }],
      },
      "checklist-verdict": { items: [{ checklistId: "AC-001", result: "pass", reason: "ok" }] },
    },
  });

  assert.equal(report?.schemaVersion, 1);
  assert.deepEqual(report?.changedFiles, ["server/routes/status.ts", "tests/status.test.ts"]);
  assert.deepEqual(report?.realActors, ["ApiController"]);
  assert.deepEqual(report?.realEntrypoints, ["/api/status"]);
  assert.deepEqual(report?.bypassCandidates, ["cache path"]);
  assert.deepEqual(report?.evidenceClasses, ["real_path_probe"]);
  assert.deepEqual(report?.evidenceOrigins, ["user_required"]);
  assert.deepEqual(report?.commands, ["npm test -- status"]);
  assert.deepEqual(report?.residualRisk, {
    riskLevel: "high",
    adversarialRequired: true,
    assumptions: ["manual deploy validation remains out of scope"],
    failedOrUncheckedChecklist: [],
    notes: ["browser check skipped", "manual smoke not run"],
  });
});

test("buildCompletionReport preserves exact candidate validation even without checklist artifacts", () => {
  const candidateValidation = {
    schemaVersion: 1,
    identityHash: "sha256:identity",
    patchHash: "sha256:patch",
    treeHash: "tree",
    identityMatch: true,
    cleanReplay: { cleanApply: true, actualTreeHash: "tree" },
  };

  const report = buildCompletionReport({
    project: "proj",
    jobId: "job-candidate-report",
    candidateValidation,
  });

  assert.equal(report?.schemaVersion, 1);
  assert.deepEqual(report?.candidateValidation, candidateValidation);
});

test("handleCompletionSuccess reports gate pass, completes job, reports completion, and returns success", async () => {
  const calls: Array<{
    type: string;
    payload?: Record<string, unknown>;
  }> = [];
  const phaseResults = [{ phase: "verify", status: "passed" }];

  const result = await handleCompletionSuccess({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-success",
    phaseResults,
    completeJob: async (cpbRoot: string, project: string, jobId: string) => {
      calls.push({ type: "completeJob", payload: { cpbRoot, project, jobId } });
    },
    onProgress: async (event: Record<string, unknown>) => {
      calls.push({ type: "progress", payload: event });
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.deepEqual(calls, [
    {
      type: "progress",
      payload: {
        ts: "2026-06-22T00:00:00.000Z",
        type: "completion_gate_passed",
        jobId: "job-success",
        project: "proj",
      },
    },
    {
      type: "completeJob",
      payload: {
        cpbRoot: "/tmp/cpb",
        project: "proj",
        jobId: "job-success",
      },
    },
    {
      type: "progress",
      payload: {
        ts: "2026-06-22T00:00:00.000Z",
        type: "job_completed",
        jobId: "job-success",
        project: "proj",
      },
    },
  ]);
  assert.deepEqual(result, {
    status: "completed",
    jobId: "job-success",
    exitCode: 0,
    failure: null,
    phaseResults,
  });
});

test("handleCompletionSuccess includes completion report in progress events and result", async () => {
  const progress: Record<string, unknown>[] = [];
  const completionReport = { schemaVersion: 1, changedFiles: ["README.md"] };

  const result = await handleCompletionSuccess({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-report",
    phaseResults: [],
    completionReport,
    completeJob: async () => {},
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(progress[0].completionReport, completionReport);
  assert.equal(progress[1].completionReport, completionReport);
  assert.equal(result.completionReport, completionReport);
});

test("handleCompletionSuccess ignores progress callback failures without skipping completeJob", async () => {
  const completed: string[] = [];

  const result = await handleCompletionSuccess({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-progress-failure",
    phaseResults: [],
    completeJob: async (_cpbRoot: string, _project: string, jobId: string) => {
      completed.push(jobId);
    },
    onProgress: async () => {
      throw new Error("progress sink unavailable");
    },
  });

  assert.deepEqual(completed, ["job-progress-failure"]);
  assert.equal(result.status, "completed");
});
