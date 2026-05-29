import { appendEvent, readEvents, materializeJob } from "./event-store.js";
import { getJob, listJobs } from "./job-store.js";

function nowIso() {
  return new Date().toISOString();
}

export async function requestApprovalGate(
  cpbRoot,
  project,
  jobId,
  { operation, phase, channels = [], reason = "approval required", timeoutAt = null, ts = nowIso(), dataRoot } = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "approval_required",
    jobId,
    project,
    operation,
    phase,
    channels,
    reason,
    timeoutAt,
    ts,
  }, { dataRoot });
  return getJob(cpbRoot, project, jobId, { dataRoot });
}

export async function approveGate(
  cpbRoot,
  project,
  jobId,
  { actor = null, action = null, ts = nowIso(), dataRoot } = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_approved",
    jobId,
    project,
    actor,
    action,
    ts,
  }, { dataRoot });
  return getJob(cpbRoot, project, jobId, { dataRoot });
}

export async function timeoutApprovalGate(
  cpbRoot,
  project,
  jobId,
  { reason = "approval timed out", ts = nowIso(), dataRoot } = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "approval_timed_out",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });
  return getJob(cpbRoot, project, jobId, { dataRoot });
}

export async function listPendingGates(cpbRoot, { project, dataRoot } = {}) {
  const jobs = await listJobs(cpbRoot, { project, dataRoot });
  const pendingGates = [];

  for (const job of jobs) {
    if (job.status === "waiting.approval" && job.approval) {
      pendingGates.push({
        jobId: job.jobId,
        project: job.project,
        operation: job.approval.operation,
        phase: job.approval.phase,
        channels: job.approval.channels,
        reason: job.approval.reason,
        requestedAt: job.approval.requestedAt,
        timeoutAt: job.approval.timeoutAt,
        task: job.task,
      });
    }
  }

  return pendingGates.sort((a, b) => (b.requestedAt ?? "").localeCompare(a.requestedAt ?? ""));
}

export async function getJobGateStatus(cpbRoot, project, jobId, { dataRoot } = {}) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });

  if (!job || !job.jobId) {
    return { error: "job not found" };
  }

  if (!job.approval) {
    const approvedEvent = (await readEvents(cpbRoot, project, jobId, { dataRoot }))
      .find((e) => e.type === "job_approved");

    if (approvedEvent) {
      return {
        jobId,
        project,
        status: "approved",
        approvedAt: approvedEvent.ts,
        actor: approvedEvent.actor,
        action: approvedEvent.action,
      };
    }

    const timeoutEvent = (await readEvents(cpbRoot, project, jobId, { dataRoot }))
      .find((e) => e.type === "approval_timed_out");

    if (timeoutEvent) {
      return {
        jobId,
        project,
        status: "timed_out",
        timedOutAt: timeoutEvent.ts,
        reason: timeoutEvent.reason,
      };
    }

    return {
      jobId,
      project,
      status: "none",
      jobStatus: job.status,
    };
  }

  return {
    jobId,
    project,
    status: "pending",
    operation: job.approval.operation,
    phase: job.approval.phase,
    channels: job.approval.channels,
    reason: job.approval.reason,
    requestedAt: job.approval.requestedAt,
    timeoutAt: job.approval.timeoutAt,
  };
}
