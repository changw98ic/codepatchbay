import { randomBytes } from "node:crypto";
import {
  checkpointJob,
  materializeJob,
  readCheckpoint,
  readEvents,
} from "./event-store.js";
import { getWorkflow } from "./workflow-definition.js";
import { appendEvent } from "./runtime-events.js";
import { listJobsFromIndex, updateJobsIndexEntry } from "./jobs-index.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function nowIso() {
  return new Date().toISOString();
}

async function requireNotTerminal(cpbRoot, project, jobId, { allowMissing = false, dataRoot } = {}) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (!job?.jobId) {
    if (allowMissing) return;
    throw new Error(`job not found: ${jobId}`);
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    throw new Error(`job is terminal: ${job.status}`);
  }
}


async function getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot } = {}) {
  const state = await getJob(cpbRoot, project, jobId, { dataRoot });
  await updateJobsIndexEntry(cpbRoot, project, jobId, state, { dataRoot }).catch(() => {});
  return state;
}

export const FAILURE_CODES = Object.freeze({
  RECOVERABLE: "RECOVERABLE",
  QUALITY_FAIL: "QUALITY_FAIL",
  BLOCKED: "BLOCKED",
  FATAL: "FATAL",
  PLAN_ARTIFACT_INVALID: "PLAN_ARTIFACT_INVALID",
  ISSUE_MISMATCH: "ISSUE_MISMATCH",
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
  { project, task, workflow = "standard", ts = nowIso(), jobId: providedJobId, executor = null, dataRoot, sourceContext }
) {
  const jobId = providedJobId || makeJobId(ts);

  // Guard: reject creation with an existing job id
  if (providedJobId) {
    const existing = await getJob(cpbRoot, project, providedJobId, { dataRoot });
    if (existing?.jobId) {
      if (TERMINAL_STATUSES.has(existing.status)) {
        throw new Error(`job is terminal: ${existing.status}`);
      }
      throw new Error(`job already exists: ${providedJobId}`);
    }
  }

  const event = {
    type: "job_created",
    jobId,
    project,
    task,
    workflow,
    executor,
    ts,
  };
  if (sourceContext && typeof sourceContext === "object") {
    event.sourceContext = sourceContext;
  }
  await appendEvent(cpbRoot, project, jobId, event, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function startPhase(
  cpbRoot,
  project,
  jobId,
  { phase, attempt = 1, leaseId, ts = nowIso(), dataRoot, acpProfile, uiLane, uiLaneReason }
) {
  const event = {
    type: "phase_started",
    jobId,
    project,
    phase,
    attempt,
    leaseId,
    ts,
  };
  if (acpProfile !== undefined) event.acpProfile = acpProfile;
  if (uiLane !== undefined) event.uiLane = uiLane;
  if (uiLaneReason !== undefined) event.uiLaneReason = uiLaneReason;
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, event, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function completePhase(
  cpbRoot,
  project,
  jobId,
  { phase, artifact = "", ts = nowIso(), dataRoot }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_completed",
    jobId,
    project,
    phase,
    artifact,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function blockJob(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso(), dataRoot }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true, dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_blocked",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });
  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
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
    dataRoot,
  }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
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
  }, { dataRoot });
  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
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

export async function createRecoveryJob(
  cpbRoot,
  project,
  originalJob,
  { fromPhase, trigger, recoveryReason, ts, dataRoot, executor, executorSelection, retryCount, maxRetries } = {}
) {
  const lineage = terminalJobLineage(originalJob);
  const now = ts || nowIso();
  const selectedExecutor = executor === undefined ? originalJob.executor ?? null : executor;

  const newJob = await createJob(cpbRoot, {
    project,
    task: originalJob.task,
    workflow: originalJob.workflow,
    ts: now,
    executor: selectedExecutor,
    dataRoot,
    sourceContext: originalJob.sourceContext ?? null,
  });

  const event = {
    type: "recovery_created",
    jobId: newJob.jobId,
    project,
    recoveryOf: originalJob.jobId,
    lineage,
    recoveryReason: recoveryReason || `fresh recovery from ${originalJob.status} job ${originalJob.jobId}`,
    trigger: trigger || "manual",
    fromPhase: fromPhase || null,
    ts: now,
  };
  if (originalJob.sourceContext) event.sourceContext = originalJob.sourceContext;
  if (executorSelection) event.executorSelection = executorSelection;
  if (retryCount !== undefined) event.retryCount = retryCount;
  if (maxRetries !== undefined) event.maxRetries = maxRetries;
  await appendEvent(cpbRoot, project, newJob.jobId, event, { dataRoot });

  return getJobAndUpdateIndex(cpbRoot, project, newJob.jobId, { dataRoot });
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
    dataRoot,
    useCurrentExecutor = false,
    currentExecutor = null,
  } = {}
) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
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

  const parentExecutor = job.executor ?? null;
  const selectedExecutor = useCurrentExecutor && currentExecutor ? currentExecutor : parentExecutor;
  const executorSelection = {
    mode: useCurrentExecutor ? "use-current" : "preserve-parent",
    override: !!useCurrentExecutor,
    parentRoot: parentExecutor?.root ?? null,
    selectedRoot: selectedExecutor?.root ?? null,
    parentReleaseId: parentExecutor?.releaseId ?? null,
    selectedReleaseId: selectedExecutor?.releaseId ?? null,
  };

  return createRecoveryJob(cpbRoot, project, job, {
    fromPhase: retryPhase,
    trigger,
    recoveryReason: `fresh recovery from ${job.status} job ${jobId}`,
    ts,
    dataRoot,
    executor: selectedExecutor,
    executorSelection,
    retryCount,
    maxRetries,
  });
}

export async function budgetExceeded(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso(), dataRoot }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "budget_exceeded",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function completeJob(
  cpbRoot,
  project,
  jobId,
  { ts = nowIso(), dataRoot } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_completed",
    jobId,
    project,
    ts,
  }, { dataRoot });
  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function recordActivity(
  cpbRoot,
  project,
  jobId,
  { message, ts = nowIso(), dataRoot }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_activity",
    jobId,
    project,
    message,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function recordFinalizerResult(
  cpbRoot,
  project,
  jobId,
  { result, ts = nowIso(), dataRoot }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "finalizer_result",
    jobId,
    project,
    result,
    ts,
  }, { dataRoot });
  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function requestCancelJob(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso(), dataRoot } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true, dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_cancel_requested",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function cancelJob(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso(), dataRoot } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_cancelled",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function requestRedirectJob(
  cpbRoot,
  project,
  jobId,
  { instructions, reason, ts = nowIso(), dataRoot } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true, dataRoot });
  const redirectEventId = `${jobId}-redirect-${Date.now()}`;
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_redirect_requested",
    jobId,
    project,
    instructions,
    reason,
    redirectEventId,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function consumeRedirect(
  cpbRoot,
  project,
  jobId,
  { redirectEventId, ts = nowIso(), dataRoot } = {}
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_redirect_consumed",
    jobId,
    project,
    redirectEventId,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function getJob(cpbRoot, project, jobId, { dataRoot } = {}) {
  const opts = { dataRoot };
  const checkpoint = await readCheckpoint(cpbRoot, project, jobId, opts);
  if (checkpoint) return checkpoint;
  return materializeJob(await readEvents(cpbRoot, project, jobId, opts));
}

export async function listJobs(cpbRoot, options = {}) {
  const { dataRoot, ...rest } = options;
  const jobs = await listJobsFromIndex(cpbRoot, { dataRoot });
  return rest.project ? jobs.filter((job) => job.project === rest.project) : jobs;
}
