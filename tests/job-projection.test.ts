import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { registerProject } from "../server/services/hub/hub-registry.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { buildJobRunReport, formatReportHuman, listProjectPipelineStates } from "../server/services/job/job-projection.js";
import { completeJob, createJob, failJob, FAILURE_CODES } from "../server/services/job/job-store.js";
import { recordValue } from "../shared/types.js";

test("project pipeline state keeps the newest non-running job instead of drifting to older history", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-projection-latest-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-projection-latest-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-job-projection-latest-src-"));
  try {
    const project = await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath,
      skipCodeGraphGate: true,
    });
    const dataRoot = project.projectRuntimeRoot;

    const oldJob = await createJob(cpbRoot, {
      project: "flow",
      task: "old completed job",
      jobId: "job-20260611-060000-old",
      ts: "2026-06-11T06:00:00.000Z",
      dataRoot,
    });
    await completeJob(cpbRoot, "flow", oldJob.jobId, { ts: "2026-06-11T06:00:10.000Z", dataRoot });

    const newJob = await createJob(cpbRoot, {
      project: "flow",
      task: "new failed job",
      jobId: "job-20260611-060100-new",
      ts: "2026-06-11T06:01:00.000Z",
      dataRoot,
    });
    await failJob(cpbRoot, "flow", newJob.jobId, {
      reason: "verification failed",
      code: FAILURE_CODES.RECOVERABLE,
      ts: "2026-06-11T06:01:10.000Z",
      dataRoot,
    });

    const states = recordValue(await listProjectPipelineStates(cpbRoot, { hubRoot, includeLegacy: false }));
    const flowState = recordValue(states.flow);

    assert.equal(flowState.jobId, newJob.jobId);
    assert.equal(flowState.status, "failed");
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  }
});

test("jobs report exposes completion and runtime policy visibility panels", async () => {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-report-panels-"));
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-job-report-panels-hub-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-job-report-panels-src-"));
  try {
    const project = await registerProject(hubRoot, {
      id: "flow",
      name: "flow",
      sourcePath,
      skipCodeGraphGate: true,
    });
    const dataRoot = project.projectRuntimeRoot;
    const job = await createJob(cpbRoot, {
      project: "flow",
      task: "visible completion report",
      jobId: "job-20260706-visible",
      ts: "2026-07-06T01:00:00.000Z",
      dataRoot,
    });

    const phaseBudgetPolicy = {
      riskLevel: "high",
      verificationDepth: "strict",
      adversarialRequired: true,
      evidenceRequirements: ["canonical_command", "real_path_trace", "adversarial_verdict"],
      phases: {
        plan: { toolCallBudget: 60, toolEventBudget: 240, idleTimeoutMs: 150000 },
        execute: { toolCallBudget: 100, toolEventBudget: 400, idleTimeoutMs: 150000, noEditToolLimit: 8 },
      },
      reasons: ["riskLevel=high", "riskSignal=high_product_surface"],
    };
    const completionReport = {
      schemaVersion: 1,
      changedFiles: ["server/services/job/job-projection.ts"],
      changedFileCount: 1,
      realActors: ["jobs report user"],
      realEntrypoints: ["cpb jobs report"],
      bypassCandidates: ["raw JSON only"],
      evidenceClasses: ["canonical_command"],
      evidenceOrigins: ["agent_regression_test"],
      commands: ["node --test dist-tests/tests/job-projection.test.js"],
      evidenceCounts: { passed: 1, failed: 0, total: 1 },
      residualRisk: { riskLevel: "high", adversarialRequired: true, notes: ["frontend panel unavailable"] },
    };

    await appendEvent(cpbRoot, "flow", job.jobId, {
      type: "riskmap_generated",
      jobId: job.jobId,
      project: "flow",
      phase: "prepare_task",
      riskMap: { riskLevel: "high", verificationDepth: "strict", adversarialRequired: true },
      riskLevel: "high",
      phaseBudgetPolicy,
      evidenceRequirements: phaseBudgetPolicy.evidenceRequirements,
      ts: "2026-07-06T01:00:01.000Z",
    }, { dataRoot });
    await appendEvent(cpbRoot, "flow", job.jobId, {
      type: "completion_gate_evaluated",
      jobId: job.jobId,
      project: "flow",
      outcome: "complete",
      reason: "all gates passed",
      completionReport,
      ts: "2026-07-06T01:00:02.000Z",
    }, { dataRoot });
    await completeJob(cpbRoot, "flow", job.jobId, { ts: "2026-07-06T01:00:03.000Z", dataRoot });

    const report = recordValue(await buildJobRunReport({ cpbRoot, hubRoot, anomalyLimit: 5 }));
    const panels = Array.isArray(report.recentJobVisibilityPanels) ? report.recentJobVisibilityPanels.map(recordValue) : [];
    assert.equal(panels.length, 1);
    const panel = panels[0];
    assert.equal(panel.jobId, job.jobId);
    assert.equal(recordValue(panel.completion).changedFileCount, 1);
    assert.deepEqual(recordValue(panel.runtimePolicy).evidenceRequirements, [
      "canonical_command",
      "real_path_trace",
      "adversarial_verdict",
    ]);

    const human = formatReportHuman(report);
    assert.match(human, /Job visibility panels/);
    assert.match(human, /completion changed:1/);
    assert.match(human, /actors:jobs report user/);
    assert.match(human, /policy risk:high depth:strict adversarial:yes/);
    assert.match(human, /requirements:canonical_command, real_path_trace, adversarial_verdict/);
  } finally {
    await rm(cpbRoot, { recursive: true, force: true });
    await rm(hubRoot, { recursive: true, force: true });
    await rm(sourcePath, { recursive: true, force: true });
  }
});
