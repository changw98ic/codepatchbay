import { randomBytes } from "node:crypto";
import {
  appendEvent,
  listEventFiles,
  materializeJob,
  readEvents,
} from "./event-store.js";

function nowIso() {
  return new Date().toISOString();
}

export function makeJobId(ts = nowIso(), suffix = randomBytes(3).toString("hex")) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid timestamp");
  }

  const compact = date.toISOString().replace(/[-:]/g, "");
  return `job-${compact.slice(0, 8)}-${compact.slice(9, 15)}-${suffix}`;
}

export async function createJob(
  flowRoot,
  { project, task, workflow = "standard", ts = nowIso() }
) {
  const jobId = makeJobId(ts);
  await appendEvent(flowRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task,
    workflow,
    ts,
  });
  return getJob(flowRoot, project, jobId);
}

export async function startPhase(
  flowRoot,
  project,
  jobId,
  { phase, attempt = 1, leaseId, ts = nowIso() }
) {
  await appendEvent(flowRoot, project, jobId, {
    type: "phase_started",
    jobId,
    project,
    phase,
    attempt,
    leaseId,
    ts,
  });
  return getJob(flowRoot, project, jobId);
}

export async function completePhase(
  flowRoot,
  project,
  jobId,
  { phase, artifact = "", ts = nowIso() }
) {
  await appendEvent(flowRoot, project, jobId, {
    type: "phase_completed",
    jobId,
    project,
    phase,
    artifact,
    ts,
  });
  return getJob(flowRoot, project, jobId);
}

export async function blockJob(
  flowRoot,
  project,
  jobId,
  { reason, ts = nowIso() }
) {
  await appendEvent(flowRoot, project, jobId, {
    type: "job_blocked",
    jobId,
    project,
    reason,
    ts,
  });
  return getJob(flowRoot, project, jobId);
}

export async function failJob(
  flowRoot,
  project,
  jobId,
  { reason, ts = nowIso() }
) {
  await appendEvent(flowRoot, project, jobId, {
    type: "job_failed",
    jobId,
    project,
    reason,
    ts,
  });
  return getJob(flowRoot, project, jobId);
}

export async function budgetExceeded(
  flowRoot,
  project,
  jobId,
  { reason, ts = nowIso() }
) {
  await appendEvent(flowRoot, project, jobId, {
    type: "budget_exceeded",
    jobId,
    project,
    reason,
    ts,
  });
  return getJob(flowRoot, project, jobId);
}

export async function completeJob(
  flowRoot,
  project,
  jobId,
  { ts = nowIso() } = {}
) {
  await appendEvent(flowRoot, project, jobId, {
    type: "job_completed",
    jobId,
    project,
    ts,
  });
  return getJob(flowRoot, project, jobId);
}

export async function getJob(flowRoot, project, jobId) {
  return materializeJob(await readEvents(flowRoot, project, jobId));
}

export async function listJobs(flowRoot) {
  const files = await listEventFiles(flowRoot);
  const jobs = await Promise.all(
    files.map(({ project, jobId }) => getJob(flowRoot, project, jobId))
  );

  return jobs.filter((job) => job.createdAt && job.project && job.jobId).sort((a, b) => {
    const aUpdatedAt = a.updatedAt ?? "";
    const bUpdatedAt = b.updatedAt ?? "";
    return bUpdatedAt.localeCompare(aUpdatedAt);
  });
}
