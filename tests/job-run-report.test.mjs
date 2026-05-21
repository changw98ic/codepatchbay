#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildJobRunReport, formatReportHuman } from "../server/services/job-run-report.js";
import { eventFileFor } from "../server/services/event-store.js";
import {
  createJob,
  completeJob,
  failJob,
  cancelJob,
  retryJob,
} from "../server/services/job-store.js";

const project = "report-test";

// --- Empty history ---
{
  const root = await mkdtemp(path.join(tmpdir(), "cpb-report-empty-"));
  const report = await buildJobRunReport({ cpbRoot: root });
  assert.equal(report.command, "cpb jobs report");
  assert.equal(report.totalJobs, 0);
  assert.equal(report.statusCounts.running, 0);
  assert.equal(report.statusCounts.completed, 0);
  assert.equal(report.statusCounts.failed, 0);
  assert.equal(report.statusCounts.blocked, 0);
  assert.equal(report.statusCounts.cancelled, 0);
  assert.equal(report.statusCounts.unknown, 0);
  assert.deepEqual(report.phaseFailureCounts, []);
  assert.equal(report.cancellationCount, 0);
  assert.equal(report.retryRecoveryCount, 0);
  assert.deepEqual(report.recentAnomalousJobs, []);
  console.log("PASS: empty history");
}

// --- Mixed outcomes ---
{
  const root = await mkdtemp(path.join(tmpdir(), "cpb-report-mixed-"));

  const completedJob = await createJob(root, {
    project,
    task: "completed task",
    ts: "2026-05-13T01:00:00.000Z",
    jobId: "job-completed-001",
  });
  await completeJob(root, project, completedJob.jobId, { ts: "2026-05-13T01:01:00.000Z" });

  const failedJob = await createJob(root, {
    project,
    task: "failed task",
    ts: "2026-05-13T02:00:00.000Z",
    jobId: "job-failed-002",
  });
  await failJob(root, project, failedJob.jobId, {
    reason: "execution error",
    code: "RECOVERABLE",
    phase: "execute",
    ts: "2026-05-13T02:01:00.000Z",
  });

  const cancelledJob = await createJob(root, {
    project,
    task: "cancelled task",
    ts: "2026-05-13T03:00:00.000Z",
    jobId: "job-cancelled-003",
  });
  await cancelJob(root, project, cancelledJob.jobId, { ts: "2026-05-13T03:01:00.000Z" });

  const recoveryJob = await retryJob(root, project, failedJob.jobId, {
    trigger: "manual",
    ts: "2026-05-13T04:00:00.000Z",
  });

  const report = await buildJobRunReport({ cpbRoot: root });

  assert.equal(report.totalJobs, 4);
  assert.equal(report.statusCounts.completed, 1);
  assert.equal(report.statusCounts.failed, 1);
  assert.equal(report.statusCounts.cancelled, 1);
  assert.equal(report.statusCounts.running, 1);
  assert.equal(report.cancellationCount, 1);
  assert.equal(report.retryRecoveryCount, 1);

  // phase failure aggregation
  assert.equal(report.phaseFailureCounts.length, 1);
  assert.equal(report.phaseFailureCounts[0].phase, "execute");
  assert.equal(report.phaseFailureCounts[0].count, 1);
  assert.equal(report.phaseFailureCounts[0].byCode[0].code, "RECOVERABLE");

  // anomaly locators
  const failedAnomaly = report.recentAnomalousJobs.find((a) => a.jobId === "job-failed-002");
  assert.ok(failedAnomaly);
  assert.equal(failedAnomaly.project, project);
  assert.equal(failedAnomaly.status, "failed");
  assert.equal(failedAnomaly.failurePhase, "execute");
  assert.equal(failedAnomaly.failureCode, "RECOVERABLE");
  assert.ok(failedAnomaly.eventLogPath);
  assert.ok(failedAnomaly.reason);

  const cancelledAnomaly = report.recentAnomalousJobs.find((a) => a.jobId === "job-cancelled-003");
  assert.ok(cancelledAnomaly);
  assert.equal(cancelledAnomaly.status, "cancelled");
  assert.ok(cancelledAnomaly.eventLogPath);

  const recoveryAnomaly = report.recentAnomalousJobs.find((a) => a.jobId === recoveryJob.jobId);
  assert.ok(recoveryAnomaly);
  assert.equal(recoveryAnomaly.parentJobId, "job-failed-002");
  assert.ok(recoveryAnomaly.eventLogPath);

  console.log("PASS: mixed outcomes");
}

// --- Deterministic phase aggregation ---
{
  const root = await mkdtemp(path.join(tmpdir(), "cpb-report-phases-"));

  const job1 = await createJob(root, {
    project,
    task: "phase test 1",
    ts: "2026-05-13T05:00:00.000Z",
    jobId: "job-phase-001",
  });
  await failJob(root, project, job1.jobId, {
    reason: "plan error",
    code: "FATAL",
    phase: "plan",
    ts: "2026-05-13T05:01:00.000Z",
  });

  const job2 = await createJob(root, {
    project,
    task: "phase test 2",
    ts: "2026-05-13T06:00:00.000Z",
    jobId: "job-phase-002",
  });
  await failJob(root, project, job2.jobId, {
    reason: "execute error",
    code: "RECOVERABLE",
    phase: "execute",
    ts: "2026-05-13T06:01:00.000Z",
  });

  const job3 = await createJob(root, {
    project,
    task: "phase test 3",
    ts: "2026-05-13T07:00:00.000Z",
    jobId: "job-phase-003",
  });
  await failJob(root, project, job3.jobId, {
    reason: "plan quality",
    code: "QUALITY_FAIL",
    phase: "plan",
    ts: "2026-05-13T07:01:00.000Z",
  });

  const report = await buildJobRunReport({ cpbRoot: root });

  assert.equal(report.phaseFailureCounts.length, 2);

  assert.equal(report.phaseFailureCounts[0].phase, "execute");
  assert.equal(report.phaseFailureCounts[0].count, 1);
  assert.equal(report.phaseFailureCounts[0].byCode[0].code, "RECOVERABLE");

  assert.equal(report.phaseFailureCounts[1].phase, "plan");
  assert.equal(report.phaseFailureCounts[1].count, 2);
  assert.equal(report.phaseFailureCounts[1].byCode[0].code, "FATAL");
  assert.equal(report.phaseFailureCounts[1].byCode[1].code, "QUALITY_FAIL");

  console.log("PASS: deterministic phase aggregation");
}

// --- Corrupt stream propagation ---
{
  const root = await mkdtemp(path.join(tmpdir(), "cpb-report-corrupt-"));

  await createJob(root, {
    project,
    task: "valid before corrupt",
    ts: "2026-05-13T08:00:00.000Z",
    jobId: "job-valid-001",
  });

  const corruptFile = eventFileFor(root, project, "job-corrupt-bad");
  await mkdir(path.dirname(corruptFile), { recursive: true });
  const corruptContent = '{"type":"job_created","jobId":"job-corrupt-bad","project":"report-test","task":"bad","ts":"2026-05-13T09:00:00.000Z"}\n{invalid json\n';
  await writeFile(corruptFile, corruptContent, "utf8");

  await assert.rejects(
    () => buildJobRunReport({ cpbRoot: root }),
    /malformed event JSON/
  );

  const afterContent = await readFile(corruptFile, "utf8");
  assert.equal(afterContent, corruptContent, "corrupt file must be unchanged after report attempt");

  console.log("PASS: corrupt stream propagation and read-only verification");
}

// --- Human format ---
{
  const root = await mkdtemp(path.join(tmpdir(), "cpb-report-format-"));

  const job = await createJob(root, {
    project,
    task: "format test",
    ts: "2026-05-13T10:00:00.000Z",
    jobId: "job-fmt-001",
  });
  await failJob(root, project, job.jobId, {
    reason: "test failure",
    code: "FATAL",
    phase: "execute",
    ts: "2026-05-13T10:01:00.000Z",
  });

  const report = await buildJobRunReport({ cpbRoot: root });
  const human = formatReportHuman(report);
  assert.ok(human.includes("Job run report"));
  assert.ok(human.includes("Total jobs: 1"));
  assert.ok(human.includes("failed: 1"));
  assert.ok(human.includes("Cancellations: 0"));
  assert.ok(human.includes("Phase failures:"));
  assert.ok(human.includes("execute: 1"));
  assert.ok(human.includes("Recent anomalies"));

  console.log("PASS: human format output");
}

console.log("\nAll job-run-report tests passed.");
