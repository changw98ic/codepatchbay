import { listDispatches } from "./dispatch-state.js";
import { listQueue, queueStatus } from "./hub-queue.js";
import { listJobs } from "./job-store.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function timestampOf(item) {
  return item.updatedAt || item.createdAt || "";
}

function countByStatus(items) {
  return items.reduce((acc, item) => {
    const status = item.status || "unknown";
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

function firstLine(value, fallback) {
  const line = String(value || "").split("\n").find((part) => part.trim());
  return line ? line.trim() : fallback;
}

function truncate(value, max = 160) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function githubIssueLink(metadata = {}) {
  if (!metadata.issueNumber && !metadata.issueUrl) return null;
  return {
    kind: "github-issue",
    label: metadata.issueNumber ? `#${metadata.issueNumber}` : "GitHub issue",
    url: metadata.issueUrl || null,
    issueNumber: metadata.issueNumber || null,
  };
}

function queueItem(entry) {
  const metadata = entry.metadata || {};
  const links = [githubIssueLink(metadata)].filter(Boolean);
  const supersededByIssues = Array.isArray(metadata.supersededByIssues)
    ? metadata.supersededByIssues
    : [];

  return {
    id: `queue:${entry.id}`,
    kind: "queue",
    title: truncate(firstLine(metadata.issueTitle || entry.description, entry.id)),
    status: entry.status || "unknown",
    projectId: entry.projectId || null,
    priority: entry.priority || null,
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || entry.createdAt || null,
    source: metadata.source || entry.type || "queue",
    queueEntryId: entry.id,
    executionBoundary: entry.executionBoundary || null,
    issueNumber: metadata.issueNumber || null,
    finalDisposition: metadata.finalDisposition || null,
    reason: metadata.cleanupReason || metadata.syncReason || metadata.error || null,
    links,
    relations: {
      supersedesQueueEntryId: metadata.supersedesQueueEntryId || null,
      supersededByIssues,
      originQueueEntryId: metadata.originQueueEntryId || null,
      originJobId: metadata.originJobId || null,
    },
  };
}

function dispatchItem(dispatch) {
  return {
    id: `dispatch:${dispatch.dispatchId}`,
    kind: "dispatch",
    title: dispatch.queueEntryId
      ? `Dispatch for ${dispatch.queueEntryId}`
      : `Dispatch ${dispatch.dispatchId}`,
    status: dispatch.status || "unknown",
    projectId: dispatch.projectId || null,
    priority: null,
    createdAt: dispatch.createdAt || null,
    updatedAt: dispatch.updatedAt || dispatch.createdAt || null,
    source: "hub-dispatch",
    dispatchId: dispatch.dispatchId,
    queueEntryId: dispatch.queueEntryId || null,
    workerId: dispatch.workerId || null,
    relations: {
      queueEntryId: dispatch.queueEntryId || null,
    },
  };
}

function jobItem(job) {
  return {
    id: `job:${job.jobId}`,
    kind: "job",
    title: truncate(firstLine(job.task, job.jobId)),
    status: job.status || "unknown",
    projectId: job.project || null,
    priority: null,
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || job.createdAt || null,
    source: "durable-job",
    jobId: job.jobId,
    workflow: job.workflow || null,
    executor: job.executor || null,
    phase: job.phase || null,
    failurePhase: job.failurePhase || null,
    failureCode: job.failureCode || null,
    reason: job.blockedReason || job.failureCause || job.cancelReason || null,
    relations: {
      parentJobId: job.lineage?.parentJobId || null,
      parentStatus: job.lineage?.parentStatus || null,
      recoveryReason: job.lineage?.recoveryReason || null,
      trigger: job.lineage?.trigger || null,
    },
  };
}

function applyFilters(items, { projectId, kinds } = {}) {
  const kindSet = kinds?.length ? new Set(kinds) : null;
  return items.filter((item) => {
    if (projectId && item.projectId !== projectId) return false;
    if (kindSet && !kindSet.has(item.kind)) return false;
    return true;
  });
}

export async function buildTaskHistory({ cpbRoot, hubRoot, limit = DEFAULT_LIMIT, projectId, kinds } = {}) {
  const [queueEntries, dispatches, jobs, qStatus] = await Promise.all([
    listQueue(hubRoot),
    listDispatches(hubRoot),
    listJobs(cpbRoot),
    queueStatus(hubRoot),
  ]);

  const allItems = [
    ...queueEntries.map(queueItem),
    ...dispatches.map(dispatchItem),
    ...jobs.map(jobItem),
  ];
  const filtered = applyFilters(allItems, { projectId, kinds });
  const sorted = filtered.sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)));
  const itemLimit = clampLimit(limit);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalItems: filtered.length,
      visibleItems: Math.min(filtered.length, itemLimit),
      queue: qStatus,
      queueByStatus: countByStatus(queueEntries),
      dispatchByStatus: countByStatus(dispatches),
      jobByStatus: countByStatus(jobs),
      byKind: {
        queue: queueEntries.length,
        dispatch: dispatches.length,
        job: jobs.length,
      },
    },
    items: sorted.slice(0, itemLimit),
  };
}
