import { randomBytes } from "node:crypto";
import {
  appendEvent,
  checkpointJob,
  listEventFiles,
  materializeJob,
  readCheckpoint,
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
  cpbRoot,
  { project, task, workflow = "standard", ts = nowIso() }
) {
  const jobId = makeJobId(ts);
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task,
    workflow,
    ts,
  });
  return getJob(cpbRoot, project, jobId);
}

export async function startPhase(
  cpbRoot,
  project,
  jobId,
  { phase, attempt = 1, leaseId, ts = nowIso() }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_started",
    jobId,
    project,
    phase,
    attempt,
    leaseId,
    ts,
  });
  return getJob(cpbRoot, project, jobId);
}

export async function completePhase(
  cpbRoot,
  project,
  jobId,
  { phase, artifact = "", ts = nowIso() }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_completed",
    jobId,
    project,
    phase,
    artifact,
    ts,
  });
  return getJob(cpbRoot, project, jobId);
}

export async function blockJob(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso() }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_blocked",
    jobId,
    project,
    reason,
    ts,
  });
  await checkpointJob(cpbRoot, project, jobId).catch(() => {});
  return getJob(cpbRoot, project, jobId);
}

export async function failJob(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso() }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_failed",
    jobId,
    project,
    reason,
    ts,
  });
  await checkpointJob(cpbRoot, project, jobId).catch(() => {});
  return getJob(cpbRoot, project, jobId);
}

export async function budgetExceeded(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso() }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "budget_exceeded",
    jobId,
    project,
    reason,
    ts,
  });
  return getJob(cpbRoot, project, jobId);
}

export async function completeJob(
  cpbRoot,
  project,
  jobId,
  { ts = nowIso() } = {}
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_completed",
    jobId,
    project,
    ts,
  });
  await checkpointJob(cpbRoot, project, jobId).catch(() => {});
  return getJob(cpbRoot, project, jobId);
}

export async function requestCancelJob(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso() } = {}
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_cancel_requested",
    jobId,
    project,
    reason,
    ts,
  });
  return getJob(cpbRoot, project, jobId);
}

export async function cancelJob(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso() } = {}
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_cancelled",
    jobId,
    project,
    reason,
    ts,
  });
  return getJob(cpbRoot, project, jobId);
}

export async function requestRedirectJob(
  cpbRoot,
  project,
  jobId,
  { instructions, reason, ts = nowIso() } = {}
) {
  const redirectEventId = `${jobId}-redirect-${Date.now()}`;
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_redirect_requested",
    jobId,
    project,
    instructions,
    reason,
    redirectEventId,
    ts,
  });
  return getJob(cpbRoot, project, jobId);
}

export async function consumeRedirect(
  cpbRoot,
  project,
  jobId,
  { redirectEventId, ts = nowIso() } = {}
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_redirect_consumed",
    jobId,
    project,
    redirectEventId,
    ts,
  });
  return getJob(cpbRoot, project, jobId);
}

export async function getJob(cpbRoot, project, jobId) {
  const checkpoint = await readCheckpoint(cpbRoot, project, jobId);
  if (checkpoint) return checkpoint;
  return materializeJob(await readEvents(cpbRoot, project, jobId));
}

export async function listJobs(cpbRoot) {
  const files = await listEventFiles(cpbRoot);
  const jobs = await Promise.all(
    files.map(({ project, jobId }) => getJob(cpbRoot, project, jobId))
  );

  return jobs.filter((job) => job.createdAt && job.project && job.jobId).sort((a, b) => {
    const aUpdatedAt = a.updatedAt ?? "";
    const bUpdatedAt = b.updatedAt ?? "";
    return bUpdatedAt.localeCompare(aUpdatedAt);
  });
}
