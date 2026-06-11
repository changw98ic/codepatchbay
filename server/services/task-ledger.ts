// @ts-nocheck
import { listDispatches } from "./dispatch-state.js";
import { readGithubIssues } from "./github-issues.js";
import { listQueue } from "./hub-queue.js";
import { listJobs } from "./job-store.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function timestampOf(task) {
  return task.updatedAt || task.createdAt || "";
}

function statusRank(status) {
  const ranks = {
    running: 0,
    ready: 1,
    open: 2,
    failed: 3,
    archived: 4,
    cancelled: 5,
    done: 6,
    closed: 7,
  };
  return ranks[status] ?? 8;
}

function priorityRank(priority) {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  if (priority === "P3") return 3;
  return 4;
}

function firstLine(value, fallback = "") {
  const line = String(value || "").split("\n").find((part) => part.trim());
  return line ? line.trim() : fallback;
}

function truncate(value, max = 180) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

function issueKey(issue) {
  const repo = issue.repository || issue.repo || issue.repositoryFullName || "github";
  return `github:${repo}#${issue.number}`;
}

function queueIssueKey(entry) {
  const metadata = entry.metadata || {};
  if (!metadata.issueNumber) return null;
  const repo = metadata.repo || metadata.repository || metadata.repositoryFullName || "github";
  return `github:${repo}#${metadata.issueNumber}`;
}

function isClosedIssue(issue) {
  return String(issue?.state || "").toUpperCase() === "CLOSED";
}

function isTerminalQueueEntry(entry) {
  return ["completed", "failed", "cancelled"].includes(entry?.status);
}

function isArchivedQueueEntry(entry) {
  return Boolean(entry?.metadata?.finalDisposition?.startsWith("superseded"));
}

function queueActivityRank(entry) {
  if (entry?.status === "in_progress") return 0;
  if (entry?.status === "pending") return 1;
  if (entry?.status === "needs_issue_link") return 2;
  return 3;
}

function selectQueueEntry(entries = []) {
  return [...entries].sort(
    (a, b) =>
      queueActivityRank(a) - queueActivityRank(b)
      || timestampOf(b).localeCompare(timestampOf(a)),
  )[0] || null;
}

function queueTitle(entry) {
  const metadata = entry.metadata || {};
  return firstLine(metadata.issueTitle || entry.description, entry.id);
}

function queueSource(entry) {
  const metadata = entry.metadata || {};
  if (metadata.issueNumber || metadata.issueUrl) {
    return {
      kind: "github",
      label: metadata.issueNumber ? `GitHub issue #${metadata.issueNumber}` : "GitHub issue",
      url: metadata.issueUrl || null,
      issueNumber: metadata.issueNumber || null,
      repo: metadata.repo || metadata.repository || null,
    };
  }
  return {
    kind: "hub-queue",
    label: "Hub queue",
    url: null,
    queueEntryId: entry.id,
  };
}

function issueSource(issue) {
  return {
    kind: "github",
    label: `GitHub issue #${issue.number}`,
    url: issue.url || null,
    issueNumber: issue.number,
    repo: issue.repository || issue.repo || issue.repositoryFullName || null,
  };
}

function bodySummary(body, fallback) {
  const goalMatch = String(body || "").match(/##\s+Goal\s+([\s\S]*?)(?:\n##\s+|$)/i);
  const content = goalMatch ? goalMatch[1] : body;
  return truncate(firstLine(content, fallback), 220);
}

function progressFor({ queueEntry, issue } = {}) {
  const finalDisposition = queueEntry?.metadata?.finalDisposition || null;
  if (finalDisposition?.startsWith("superseded")) {
    return {
      stage: "archived",
      label: "Archived",
      detail: finalDisposition,
      percent: 100,
    };
  }

  if (issue?.state === "CLOSED" || issue?.state === "closed") {
    return { stage: "closed", label: "Closed", detail: "Closed in GitHub", percent: 100 };
  }

  if (queueEntry?.status === "pending") {
    return { stage: "ready", label: "Ready to run", detail: "Queued in Hub", percent: 10 };
  }
  if (queueEntry?.status === "needs_issue_link") {
    return { stage: "open", label: "Needs issue link", detail: "Awaiting GitHub issue metadata", percent: 0 };
  }
  if (queueEntry?.status === "in_progress") {
    return { stage: "running", label: "Running", detail: "Claimed by worker", percent: 50 };
  }
  if (queueEntry?.status === "completed") {
    return { stage: "done", label: "Done", detail: "Queue item completed", percent: 100 };
  }
  if (queueEntry?.status === "failed") {
    return { stage: "failed", label: "Failed", detail: "Queue item failed", percent: 100 };
  }
  if (queueEntry?.status === "cancelled") {
    return { stage: "cancelled", label: "Cancelled", detail: "Queue item cancelled", percent: 100 };
  }

  return { stage: "open", label: "Open, not queued", detail: "Known from source ledger only", percent: 0 };
}

function humanNextAction(progress, queueEntry) {
  if (progress.stage === "ready") return "Start a CPB worker or let the queue dispatcher pick it up.";
  if (progress.label === "Needs issue link") return "Link a GitHub issue to this task before it can be claimed for execution.";
  if (progress.stage === "open") return "Import or queue this issue before expecting CPB to execute it.";
  if (progress.stage === "failed") return "Inspect the latest run evidence, then create a fresh recovery task if still needed.";
  if (progress.stage === "archived") return "Do not retry this item directly; follow the replacement task links.";
  if (progress.stage === "running") return "Watch the current worker and run evidence.";
  if (progress.stage === "done" && queueEntry?.metadata?.finalDisposition) return "No action; this item has a final disposition.";
  if (progress.stage === "done" || progress.stage === "closed") return "No action needed unless follow-up acceptance gaps remain.";
  return "Review task details and choose the next execution path.";
}

function evidenceFor({ queueEntry, jobs = [], dispatches = [] }) {
  const evidence = [];
  const queueEntries = Array.isArray(queueEntry) ? queueEntry : [queueEntry].filter(Boolean);
  for (const entry of queueEntries.slice(0, 10)) {
    evidence.push({
      kind: "queue",
      id: entry.id,
      status: entry.status,
      updatedAt: entry.updatedAt || entry.createdAt || null,
    });
  }
  for (const dispatch of dispatches.slice(0, 5)) {
    evidence.push({
      kind: "dispatch",
      id: dispatch.dispatchId,
      status: dispatch.status,
      updatedAt: dispatch.updatedAt || dispatch.createdAt || null,
      workerId: dispatch.workerId || null,
    });
  }
  for (const job of jobs.slice(0, 5)) {
    evidence.push({
      kind: "job",
      id: job.jobId,
      status: job.status,
      phase: job.phase || null,
      updatedAt: job.updatedAt || job.createdAt || null,
      reason: job.blockedReason || job.failureCause || null,
    });
  }
  return evidence;
}

function matchingJobs(queueEntries, jobs) {
  const entries = Array.isArray(queueEntries) ? queueEntries : [queueEntries].filter(Boolean);
  if (entries.length === 0) return [];
  const descriptions = new Set(entries.map((entry) => entry.description || ""));
  const projects = new Set(entries.map((entry) => entry.projectId));
  return jobs
    .filter((job) => projects.has(job.project) && descriptions.has(job.task))
    .sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)));
}

function matchingDispatches(queueEntries, dispatches) {
  const entries = Array.isArray(queueEntries) ? queueEntries : [queueEntries].filter(Boolean);
  if (entries.length === 0) return [];
  const entryIds = new Set(entries.map((entry) => entry.id));
  return dispatches
    .filter((dispatch) => entryIds.has(dispatch.queueEntryId))
    .sort((a, b) => timestampOf(b).localeCompare(timestampOf(a)));
}

function issueTask(issue, { queueEntry, queueEntries = [], jobs, dispatches }) {
  const labels = normalizeLabels(issue.labels);
  const progress = progressFor({ queueEntry, issue });
  const source = issueSource(issue);
  const title = issue.title || queueTitle(queueEntry) || `Issue #${issue.number}`;
  const body = issue.body || "";
  const linkedEntries = queueEntries.length > 0 ? queueEntries : [queueEntry].filter(Boolean);
  const jobsForEntry = matchingJobs(linkedEntries, jobs);
  const dispatchesForEntry = matchingDispatches(linkedEntries, dispatches);
  const latestJob = jobsForEntry[0] || null;
  const latestDispatch = dispatchesForEntry[0] || null;
  const evidence = evidenceFor({
    queueEntry: linkedEntries,
    jobs: jobsForEntry,
    dispatches: dispatchesForEntry,
  });

  return {
    id: issueKey(issue),
    title,
    projectId: queueEntry?.projectId || issue.projectId || "flow",
    priority: queueEntry?.priority || labels.find((label) => /^P[0-3]$/i.test(label)) || null,
    status: progress.stage,
    progress,
    source,
    labels,
    createdAt: issue.createdAt || queueEntry?.createdAt || null,
    updatedAt: issue.updatedAt || queueEntry?.updatedAt || issue.createdAt || null,
    human: {
      summary: bodySummary(body, title),
      progress: `${progress.label}${progress.detail ? ` · ${progress.detail}` : ""}`,
      source: source.label,
      nextAction: humanNextAction(progress, queueEntry),
      description: truncate(body || queueEntry?.description || title, 900),
    },
    agent: {
      objective: body || queueEntry?.description || title,
      status: {
        stage: progress.stage,
        queueStatus: queueEntry?.status || null,
        githubState: issue.state || null,
        finalDisposition: queueEntry?.metadata?.finalDisposition || null,
      },
      source: {
        kind: source.kind,
        url: source.url,
        repo: source.repo,
        issueNumber: issue.number,
      },
      execution: {
        queueEntryId: queueEntry?.id || null,
        projectId: queueEntry?.projectId || null,
        priority: queueEntry?.priority || null,
        executionBoundary: queueEntry?.executionBoundary || null,
        supersedesQueueEntryId: queueEntry?.metadata?.supersedesQueueEntryId || null,
        supersededByIssues: queueEntry?.metadata?.supersededByIssues || [],
        workerId: queueEntry?.workerId || latestDispatch?.workerId || null,
        jobId: latestJob?.jobId || null,
        dispatchId: latestDispatch?.dispatchId || null,
        executor: latestJob?.executor || null,
        releaseSnapshot: queueEntry?.metadata?.releaseSnapshot || null,
        indexSnapshot: queueEntry?.metadata?.indexSnapshot || null,
        acpProfile: queueEntry?.metadata?.acpProfile || "headless",
        uiLane: Boolean(queueEntry?.metadata?.uiLane),
        uiLaneReason: queueEntry?.metadata?.uiLaneReason || "",
      },
      evidence,
    },
  };
}

function queueTask(entry, { jobs, dispatches }) {
  const progress = progressFor({ queueEntry: entry });
  const source = queueSource(entry);
  const title = queueTitle(entry);
  const jobsForEntry = matchingJobs(entry, jobs);
  const dispatchesForEntry = matchingDispatches(entry, dispatches);
  const latestJob = jobsForEntry[0] || null;
  const latestDispatch = dispatchesForEntry[0] || null;
  const evidence = evidenceFor({
    queueEntry: entry,
    jobs: jobsForEntry,
    dispatches: dispatchesForEntry,
  });

  return {
    id: `queue:${entry.id}`,
    title,
    projectId: entry.projectId || null,
    priority: entry.priority || null,
    status: progress.stage,
    progress,
    source,
    labels: [],
    createdAt: entry.createdAt || null,
    updatedAt: entry.updatedAt || entry.createdAt || null,
    human: {
      summary: title,
      progress: `${progress.label}${progress.detail ? ` · ${progress.detail}` : ""}`,
      source: source.label,
      nextAction: humanNextAction(progress, entry),
      description: truncate(entry.description || title, 900),
    },
    agent: {
      objective: entry.description || title,
      status: {
        stage: progress.stage,
        queueStatus: entry.status || null,
        finalDisposition: entry.metadata?.finalDisposition || null,
      },
      source,
      execution: {
        queueEntryId: entry.id,
        projectId: entry.projectId || null,
        priority: entry.priority || null,
        executionBoundary: entry.executionBoundary || null,
        supersedesQueueEntryId: entry.metadata?.supersedesQueueEntryId || null,
        supersededByIssues: entry.metadata?.supersededByIssues || [],
        workerId: entry.workerId || latestDispatch?.workerId || null,
        jobId: latestJob?.jobId || null,
        dispatchId: latestDispatch?.dispatchId || null,
        executor: latestJob?.executor || null,
        releaseSnapshot: entry.metadata?.releaseSnapshot || null,
        indexSnapshot: entry.metadata?.indexSnapshot || null,
        acpProfile: entry.metadata?.acpProfile || "headless",
        uiLane: Boolean(entry.metadata?.uiLane),
        uiLaneReason: entry.metadata?.uiLaneReason || "",
      },
      evidence,
    },
  };
}

function summarize(tasks) {
  const summary = {
    total: tasks.length,
    ready: 0,
    running: 0,
    open: 0,
    done: 0,
    failed: 0,
    archived: 0,
    closed: 0,
    bySource: {},
  };
  for (const task of tasks) {
    if (summary[task.status] !== undefined) summary[task.status] += 1;
    else summary[task.status] = 1;
    const sourceKind = task.source?.kind || "unknown";
    summary.bySource[sourceKind] = (summary.bySource[sourceKind] || 0) + 1;
  }
  return summary;
}

export async function buildTaskLedger({
  cpbRoot,
  hubRoot,
  limit = DEFAULT_LIMIT,
  projectId,
  includeQueueOnly = false,
  includeArchived = false,
} = {}) {
  const [queueEntries, githubIssues, jobs, dispatches] = await Promise.all([
    listQueue(hubRoot),
    readGithubIssues(hubRoot),
    listJobs(cpbRoot),
    listDispatches(hubRoot),
  ]);

  const visibleGithubIssues = githubIssues.filter((issue) => !isClosedIssue(issue));
  const issueKeys = new Set(visibleGithubIssues.map(issueKey));
  const queuesByIssue = new Map();
  for (const entry of queueEntries) {
    const key = queueIssueKey(entry);
    if (!key) continue;
    const entries = queuesByIssue.get(key) || [];
    entries.push(entry);
    queuesByIssue.set(key, entries);
  }

  const consumedQueueIds = new Set();
  const tasks = [];
  for (const issue of visibleGithubIssues) {
    if (!issue?.number) continue;
    const key = issueKey(issue);
    const linkedEntries = queuesByIssue.get(key) || [];
    const queueEntry = selectQueueEntry(linkedEntries);
    for (const entry of linkedEntries) consumedQueueIds.add(entry.id);
    tasks.push(issueTask(issue, { queueEntry, queueEntries: linkedEntries, jobs, dispatches }));
  }

  for (const entry of queueEntries) {
    if (consumedQueueIds.has(entry.id)) continue;
    if (!includeQueueOnly) continue;
    if (isArchivedQueueEntry(entry) && !includeArchived) continue;
    if (isTerminalQueueEntry(entry) && !isArchivedQueueEntry(entry)) continue;
    const key = queueIssueKey(entry);
    if (key && issueKeys.has(key)) continue;
    tasks.push(queueTask(entry, { jobs, dispatches }));
  }

  const filtered = projectId ? tasks.filter((task) => task.projectId === projectId) : tasks;
  const sorted = filtered.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status)
      || priorityRank(a.priority) - priorityRank(b.priority)
      || timestampOf(b).localeCompare(timestampOf(a)),
  );
  const itemLimit = clampLimit(limit);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      ...summarize(filtered),
      visible: Math.min(filtered.length, itemLimit),
    },
    tasks: sorted.slice(0, itemLimit),
  };
}
