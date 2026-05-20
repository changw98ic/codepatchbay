import { randomBytes } from "node:crypto";
import {
  checkpointJob,
  materializeJob,
  readCheckpoint,
  readEvents,
} from "./event-store.js";
import { getWorkflow } from "./workflow-definition.js";
import { appendEvent } from "./runtime-events.js";
import {
  getJob as getJobRust,
  listJobs as listJobsRust,
  shouldUseRustRuntime,
} from "./runtime-cli.js";
import { listJobsFromIndex, updateJobsIndexEntry } from "./jobs-index.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function nowIso() {
  return new Date().toISOString();
}

async function requireNotTerminal(cpbRoot, project, jobId, { allowMissing = false } = {}) {
  const job = await getJob(cpbRoot, project, jobId);
  if (!job?.jobId) {
    if (allowMissing) return;
    throw new Error(`job not found: ${jobId}`);
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    throw new Error(`job is terminal: ${job.status}`);
  }
}


async function getJobAndUpdateIndex(cpbRoot, project, jobId) {
  const state = await getJob(cpbRoot, project, jobId);
  await updateJobsIndexEntry(cpbRoot, project, jobId, state).catch(() => {});
  return state;
}

export const FAILURE_CODES = Object.freeze({
  RECOVERABLE: "RECOVERABLE",
  QUALITY_FAIL: "QUALITY_FAIL",
  BLOCKED: "BLOCKED",
  FATAL: "FATAL",
});

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
  { project, task, workflow = "standard", ts = nowIso(), jobId: providedJobId, executor = null }
) {
  const jobId = providedJobId || makeJobId(ts);
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_created",
    jobId,
    project,
    task,
    workflow,
    executor,
    ts,
  });
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

export async function startPhase(
  cpbRoot,
  project,
  jobId,
  { phase, attempt = 1, leaseId, ts = nowIso() }
) {
  await requireNotTerminal(cpbRoot, project, jobId);
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_started",
    jobId,
    project,
    phase,
    attempt,
    leaseId,
    ts,
  });
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

export async function completePhase(
  cpbRoot,
  project,
  jobId,
  { phase, artifact = "", ts = nowIso() }
) {
  await requireNotTerminal(cpbRoot, project, jobId);
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_completed",
    jobId,
    project,
    phase,
    artifact,
    ts,
  });
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

export async function blockJob(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso() }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_blocked",
    jobId,
    project,
    reason,
    ts,
  });
  await checkpointJob(cpbRoot, project, jobId).catch(() => {});
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

export async function failJob(
  cpbRoot,
  project,
  jobId,
  {
    reason,
    code = FAILURE_CODES.FATAL,
    phase,
    retryable,
    retryCount,
    cause,
    ts = nowIso(),
  }
) {
  await requireNotTerminal(cpbRoot, project, jobId);
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_failed",
    jobId,
    project,
    reason,
    code,
    phase,
    retryable: retryable ?? code === FAILURE_CODES.RECOVERABLE,
    retryCount,
    cause,
    ts,
  });
  await checkpointJob(cpbRoot, project, jobId).catch(() => {});
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

function inferRetryPhase(job) {
  const workflow = getWorkflow(job.workflow);
  if (job.failurePhase && workflow.phases.includes(job.failurePhase)) {
    return job.failurePhase;
  }
  for (const phase of workflow.phases) {
    if (!job.artifacts?.[phase]) return phase;
  }
  return workflow.phases[workflow.phases.length - 1] ?? null;
}

function terminalJobLineage(job) {
  return {
    parentJobId: job.jobId,
    parentStatus: job.status ?? null,
    parentFailureCode: job.failureCode ?? null,
    parentFailurePhase: job.failurePhase ?? null,
    parentBlockedReason: job.blockedReason ?? null,
  };
}

export async function retryJob(
  cpbRoot,
  project,
  jobId,
  {
    fromPhase,
    force = false,
    trigger = "manual",
    maxRetries = 3,
    ts = nowIso(),
  } = {}
) {
  const job = await getJob(cpbRoot, project, jobId);
  if (!job?.jobId) {
    throw new Error(`job not found: ${jobId}`);
  }
  if (!["failed", "blocked", "cancelled"].includes(job.status)) {
    throw new Error(`job is not recoverable: ${job.status ?? "unknown"}`);
  }
  if (job.status === "cancelled" && !force) {
    throw new Error("cancelled job requires --force to recover");
  }

  const code = job.failureCode ?? FAILURE_CODES.FATAL;
  if (job.status === "failed" && code === FAILURE_CODES.FATAL && !force) {
    throw new Error(`fatal job is not retryable: ${job.blockedReason ?? "unknown failure"}`);
  }
  if (job.status === "failed" && !job.retryable && !force) {
    throw new Error(`job requires --force to retry: ${code}`);
  }

  const retryCount = (job.retryCount ?? 0) + 1;
  if (retryCount > maxRetries) {
    throw new Error(`retry limit exceeded: ${retryCount}/${maxRetries}`);
  }

  const workflow = getWorkflow(job.workflow);
  const retryPhase = fromPhase || inferRetryPhase(job);
  if (!retryPhase || !workflow.phases.includes(retryPhase)) {
    throw new Error(`invalid retry phase: ${retryPhase ?? "unknown"}`);
  }

  const recovered = await createJob(cpbRoot, {
    project,
    task: job.task,
    workflow: job.workflow,
    ts,
    executor: job.executor ?? null,
  });

  await appendEvent(cpbRoot, project, recovered.jobId, {
    type: "recovery_created",
    jobId: recovered.jobId,
    project,
    lineage: terminalJobLineage(job),
    recoveryReason: `fresh recovery from ${job.status} job ${jobId}`,
    trigger,
    fromPhase: retryPhase,
    retryCount,
    maxRetries,
    ts,
  });

  return getJobAndUpdateIndex(cpbRoot, project, recovered.jobId);
}

export async function budgetExceeded(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso() }
) {
  await requireNotTerminal(cpbRoot, project, jobId);
  await appendEvent(cpbRoot, project, jobId, {
    type: "budget_exceeded",
    jobId,
    project,
    reason,
    ts,
  });
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

export async function completeJob(
  cpbRoot,
  project,
  jobId,
  { ts = nowIso() } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId);
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_completed",
    jobId,
    project,
    ts,
  });
  await checkpointJob(cpbRoot, project, jobId).catch(() => {});
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

export async function recordActivity(
  cpbRoot,
  project,
  jobId,
  { message, ts = nowIso() }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_activity",
    jobId,
    project,
    message,
    ts,
  });
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

export async function requestCancelJob(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso() } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_cancel_requested",
    jobId,
    project,
    reason,
    ts,
  });
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

export async function cancelJob(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso() } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId);
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_cancelled",
    jobId,
    project,
    reason,
    ts,
  });
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

export async function requestRedirectJob(
  cpbRoot,
  project,
  jobId,
  { instructions, reason, ts = nowIso() } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true });
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
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
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
  return getJobAndUpdateIndex(cpbRoot, project, jobId);
}

export async function getJob(cpbRoot, project, jobId) {
  if (shouldUseRustRuntime()) {
    return await getJobRust(cpbRoot, project, jobId);
  }
  const checkpoint = await readCheckpoint(cpbRoot, project, jobId);
  if (checkpoint) return checkpoint;
  return materializeJob(await readEvents(cpbRoot, project, jobId));
}

export async function listJobs(cpbRoot, options = {}) {
  if (shouldUseRustRuntime()) {
    return await listJobsRust(cpbRoot, options);
  }
  const jobs = await listJobsFromIndex(cpbRoot);
  return options.project ? jobs.filter((job) => job.project === options.project) : jobs;
}
