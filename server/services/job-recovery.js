import { getJob, createJob, startPhase } from "./job-store.js";
import { appendEvent } from "./runtime-events.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

export function isTerminal(job) {
  return !job?.jobId || TERMINAL_STATUSES.has(job.status);
}

export function isRecoverable(job) {
  if (!isTerminal(job)) return false;
  if (job.status === "completed") return false;
  return ["failed", "blocked", "cancelled"].includes(job.status);
}

export async function recoverAsNewJob(cpbRoot, project, jobId, { ts, reason, trigger = "recovery" } = {}) {
  const original = await getJob(cpbRoot, project, jobId);
  if (!original?.jobId) {
    throw new Error(`job not found: ${jobId}`);
  }

  if (!isTerminal(original)) {
    throw new Error(`job is not terminal: ${original.status}`);
  }

  if (original.status === "completed") {
    throw new Error(`completed job does not need recovery: ${jobId}`);
  }

  const now = ts || new Date().toISOString();
  const recoveryReason = reason || `recovery from ${original.status} job ${jobId}`;

  const newJob = await createJob(cpbRoot, {
    project,
    task: original.task,
    workflow: original.workflow,
    ts: now,
  });

  await appendEvent(cpbRoot, project, newJob.jobId, {
    type: "recovery_created",
    jobId: newJob.jobId,
    project,
    lineage: {
      parentJobId: jobId,
      parentStatus: original.status,
      parentFailureCode: original.failureCode || null,
      parentFailurePhase: original.failurePhase || null,
      parentBlockedReason: original.blockedReason || null,
    },
    recoveryReason,
    trigger,
    ts: now,
  });

  return newJob;
}

export async function retryAsNewJob(cpbRoot, project, jobId, { ts, fromPhase, trigger = "manual" } = {}) {
  const original = await getJob(cpbRoot, project, jobId);
  if (!original?.jobId) {
    throw new Error(`job not found: ${jobId}`);
  }

  if (!["failed", "blocked", "cancelled"].includes(original.status)) {
    throw new Error(`job is not recoverable: ${original.status}`);
  }

  const now = ts || new Date().toISOString();
  const retryReason = `retry from ${original.status} job ${jobId}`;

  const newJob = await createJob(cpbRoot, {
    project,
    task: original.task,
    workflow: original.workflow,
    ts: now,
  });

  await appendEvent(cpbRoot, project, newJob.jobId, {
    type: "recovery_created",
    jobId: newJob.jobId,
    project,
    lineage: {
      parentJobId: jobId,
      parentStatus: original.status,
      parentFailureCode: original.failureCode || null,
      parentFailurePhase: original.failurePhase || null,
      parentBlockedReason: original.blockedReason || null,
    },
    recoveryReason: retryReason,
    trigger,
    ts: now,
  });

  return newJob;
}

export async function verifyTerminalImmutability(cpbRoot, project, jobId) {
  const before = await getJob(cpbRoot, project, jobId);
  if (!before?.jobId) return { immutable: false, reason: "job not found" };

  if (!TERMINAL_STATUSES.has(before.status)) {
    return { immutable: false, reason: `job is not terminal: ${before.status}` };
  }

  const after = await getJob(cpbRoot, project, jobId);
  const fields = ["status", "phase", "blockedReason", "failureCode", "failurePhase", "retryCount"];
  for (const field of fields) {
    if (before[field] !== after[field]) {
      return { immutable: false, reason: `field ${field} changed` };
    }
  }

  return { immutable: true };
}

export function getLineage(job) {
  if (!job?.jobId) return null;

  return {
    parentJobId: job.lineage?.parentJobId || null,
    parentStatus: job.lineage?.parentStatus || null,
    parentFailureCode: job.lineage?.parentFailureCode || null,
    recoveryReason: job.lineage?.recoveryReason || null,
  };
}
