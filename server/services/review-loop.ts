import { readEventsReadOnly, materializeJob, appendEvent, checkpointJob } from "./event-store.js";
import { enqueue, updateEntry } from "./hub-queue.js";
import { buildReviewBundle } from "./review-bundle.js";
import { updateJobsIndexEntry } from "./jobs-index.js";

type AnyRecord = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function trimText(value, maxChars = 6000) {
  const text = String(value || "").trim();
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function bundleIdFor(project, jobId) {
  return `rb-${project}-${jobId}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

const REVIEWABLE_TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "superseded"]);

export class ReviewLoopError extends Error {
  code: string;
  statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = "ReviewLoopError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isReviewLoopError(error: any) {
  return error instanceof ReviewLoopError || Boolean(error?.code && error?.statusCode);
}

function reviewLoopError(message, code, statusCode) {
  return new ReviewLoopError(message, code, statusCode);
}

function assertReviewableJob(job) {
  if (!REVIEWABLE_TERMINAL_STATUSES.has(job?.status)) {
    throw reviewLoopError(
      `review bundle can only be accepted or rejected after the job is terminal; current status: ${job?.status || "unknown"}`,
      "REVIEW_JOB_NOT_TERMINAL",
      409,
    );
  }
}

function assertReviewNotFinalized(loop) {
  const latestVerdict = loop?.latest?.verdict;
  if (latestVerdict === "accepted" || latestVerdict === "rejected") {
    throw reviewLoopError(
      `review bundle already ${latestVerdict}`,
      "REVIEW_BUNDLE_ALREADY_REVIEWED",
      409,
    );
  }
}

async function refreshJobIndex(cpbRoot, project, jobId, { dataRoot }: AnyRecord = {}) {
  const job = await checkpointJob(cpbRoot, project, jobId, { dataRoot })
    || materializeJob(await readEventsReadOnly(cpbRoot, project, jobId, { dataRoot }));
  await updateJobsIndexEntry(cpbRoot, project, jobId, job, { dataRoot });
  return job;
}

function reviewLoopState(events) {
  const rounds = [];
  for (const event of events) {
    if (event.type === "review_bundle_accepted" || event.type === "review_bundle_rejected") {
      rounds.push({
        round: event.round ?? rounds.length + 1,
        verdict: event.verdict ?? (event.type === "review_bundle_accepted" ? "accepted" : "rejected"),
        feedback: event.feedback ?? null,
        retryQueueEntryId: event.retryQueueEntryId ?? null,
        bundleId: event.bundleId ?? null,
        actor: event.actor ?? null,
        createdAt: event.ts ?? null,
      });
    }
  }
  return { rounds, nextRound: rounds.length + 1, latest: rounds[rounds.length - 1] ?? null };
}

function retryPreviousOutput(bundle) {
  const chunks = [];
  if (bundle?.evidence?.verdict) {
    chunks.push(`Previous verdict:\n${typeof bundle.evidence.verdict === "string" ? bundle.evidence.verdict : JSON.stringify(bundle.evidence.verdict, null, 2)}`);
  }
  if (bundle?.evidence?.deliverable?.content) {
    chunks.push(`Previous deliverable:\n${bundle.evidence.deliverable.content}`);
  }
  if (bundle?.evidence?.plan?.content) {
    chunks.push(`Previous plan:\n${bundle.evidence.plan.content}`);
  }
  if (bundle?.evidence?.diffStat) {
    chunks.push(`Previous diff stat:\n${bundle.evidence.diffStat}`);
  }
  return trimText(chunks.join("\n\n"), 8000);
}

function buildRetrySourceContext(job, bundle, { round, feedback, actor, ts, retryQueueEntryId }: AnyRecord) {
  const base = job?.sourceContext && typeof job.sourceContext === "object" ? { ...job.sourceContext } : {};
  const dagResume = job?.dagResume && typeof job.dagResume === "object"
    ? {
        failedNodeId: job.dagResume.failedNodeId ?? null,
        resumeTarget: job.dagResume.resumeTarget ? { ...job.dagResume.resumeTarget } : null,
        completedNodeIds: Array.isArray(job.dagResume.completedNodeIds) ? [...job.dagResume.completedNodeIds] : [],
      }
    : base.dagResume && typeof base.dagResume === "object"
      ? {
          failedNodeId: base.dagResume.failedNodeId ?? null,
          resumeTarget: base.dagResume.resumeTarget ? { ...base.dagResume.resumeTarget } : null,
          completedNodeIds: Array.isArray(base.dagResume.completedNodeIds) ? [...base.dagResume.completedNodeIds] : [],
        }
      : null;
  const bundleId = bundleIdFor(job.project, job.jobId);
  const retry = {
    failureKind: "human_rejected_review_bundle",
    failureReason: feedback,
    previousOutput: retryPreviousOutput(bundle),
    previousJobId: job.jobId,
    previousPhase: dagResume?.resumeTarget?.phase || job.failurePhase || job.phase || null,
    previousNodeId: dagResume?.failedNodeId || dagResume?.resumeTarget?.nodeId || null,
    resumeTarget: dagResume?.resumeTarget ? { ...dagResume.resumeTarget } : null,
    completedNodeIds: dagResume?.completedNodeIds ? [...dagResume.completedNodeIds] : [],
    previousQueueEntryId: job.queueEntryId || base.queueEntryId || null,
    originalBundleId: bundleId,
    reviewRound: round,
    trigger: "review_bundle_rejected",
    actor,
    rejectedAt: ts,
    retryQueueEntryId,
    artifacts: job.artifacts || {},
  };
  return {
    ...base,
    ...(dagResume ? { dagResume } : {}),
    type: base.type || "review_bundle_retry",
    retry,
    reviewLoop: {
      originalJobId: job.jobId,
      originalBundleId: bundleId,
      round,
      retryQueueEntryId,
    },
    previousFailure: {
      kind: retry.failureKind,
      reason: retry.failureReason,
      jobId: job.jobId,
      phase: retry.previousPhase,
      nodeId: retry.previousNodeId,
      resumeTarget: retry.resumeTarget ? { ...retry.resumeTarget } : null,
      completedNodeIds: [...retry.completedNodeIds],
    },
  };
}

export async function getReviewLoop(cpbRoot, project, jobId, { dataRoot }: AnyRecord = {}) {
  const events = await readEventsReadOnly(cpbRoot, project, jobId, { dataRoot });
  return reviewLoopState(events);
}

export async function acceptReviewBundle(cpbRoot, project, jobId, {
  actor = null,
  feedback = "",
  ts = nowIso(),
  dataRoot,
}: AnyRecord = {}) {
  const events = await readEventsReadOnly(cpbRoot, project, jobId, { dataRoot });
  const job = materializeJob(events);
  if (!job?.jobId) throw reviewLoopError(`job not found: ${jobId}`, "REVIEW_JOB_NOT_FOUND", 404);
  assertReviewableJob(job);

  const loop = reviewLoopState(events);
  assertReviewNotFinalized(loop);
  const round = loop.nextRound;
  const event = await appendEvent(cpbRoot, project, jobId, {
    type: "review_bundle_accepted",
    jobId,
    project,
    bundleId: bundleIdFor(project, jobId),
    round,
    verdict: "accepted",
    feedback: trimText(feedback),
    actor,
    ts,
  }, { dataRoot });
  await refreshJobIndex(cpbRoot, project, jobId, { dataRoot });

  return {
    accepted: true,
    jobId,
    project,
    round,
    bundleId: bundleIdFor(project, jobId),
    event,
  };
}

export async function rejectReviewBundle(cpbRoot, project, jobId, {
  feedback,
  actor = null,
  hubRoot,
  sourcePath = null,
  priority = "P0",
  ts = nowIso(),
  dataRoot,
}: AnyRecord = {}) {
  const normalizedFeedback = trimText(feedback);
  if (!normalizedFeedback) throw reviewLoopError("feedback required", "REVIEW_FEEDBACK_REQUIRED", 400);
  if (!hubRoot) throw reviewLoopError("hubRoot required", "REVIEW_HUB_ROOT_REQUIRED", 400);

  const events = await readEventsReadOnly(cpbRoot, project, jobId, { dataRoot });
  const job = materializeJob(events);
  if (!job?.jobId) throw reviewLoopError(`job not found: ${jobId}`, "REVIEW_JOB_NOT_FOUND", 404);
  assertReviewableJob(job);

  const bundle = await buildReviewBundle(cpbRoot, project, jobId, {
    dataRoot,
    sourcePath,
    worktreePath: job.worktree || null,
  });
  const loop = reviewLoopState(events);
  assertReviewNotFinalized(loop);
  const round = loop.nextRound;
  const bundleId = bundleIdFor(project, jobId);
  const queueDedupeKey = `review-loop:${project}:${jobId}:${round}`;

  const sourceContext = buildRetrySourceContext(job, bundle, {
    round,
    feedback: normalizedFeedback,
    actor,
    ts,
    retryQueueEntryId: null,
  });

  const entry = await enqueue(hubRoot, {
    projectId: project,
    sourcePath,
    priority,
    description: job.task || bundle.request?.task || `Retry rejected review bundle ${jobId}`,
    type: "review_bundle_retry",
    metadata: {
      source: "review_bundle_rejection",
      sourceType: "review_bundle_rejection",
      workflow: job.workflow || bundle.request?.workflow || "standard",
      planMode: job.planMode || bundle.request?.planMode || "full",
      actor,
      originJobId: jobId,
      originalJobId: jobId,
      originalBundleId: bundleId,
      reviewRound: round,
      userFeedback: normalizedFeedback,
      requestedAt: ts,
      queueDedupeKey,
      sourceContext,
    },
  });

  sourceContext.reviewLoop.retryQueueEntryId = entry.id;
  sourceContext.retry.retryQueueEntryId = entry.id;
  const updatedEntry = await updateEntry(hubRoot, entry.id, {
    metadata: { sourceContext },
  });

  await appendEvent(cpbRoot, project, jobId, {
    type: "review_bundle_rejected",
    jobId,
    project,
    bundleId,
    round,
    verdict: "rejected",
    feedback: normalizedFeedback,
    actor,
    retryQueueEntryId: entry.id,
    ts,
  }, { dataRoot });
  await refreshJobIndex(cpbRoot, project, jobId, { dataRoot });

  return {
    rejected: true,
    jobId,
    project,
    round,
    bundleId,
    retryQueueEntry: updatedEntry || entry,
  };
}
