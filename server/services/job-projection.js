import { listJobsAcrossRuntimeRoots } from "./job-store.js";
import { normalizeWorkflow } from "../../core/workflow/definition.js";

const STATUS_MAP = {
  pending: "pending",
  running: "running",
  completed: "completed",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

const ACTIVE_NODE_STATUSES = new Set(["running", "retrying", "blocked"]);
const GITHUB_STATUS_COMMENT_STATUSES = new Set(["blocked", "failed", "passed", "pr-opened"]);

function orderedUnique(values) {
  return [...new Set(values.filter(Boolean))];
}

function projectDagNodes(job) {
  const nodeStates = job.nodeStates ?? {};
  const ids = orderedUnique([
    ...workflowNodeIds(job),
    ...Object.keys(nodeStates),
    ...(job.completedNodes ?? []),
    ...(job.runningNodes ?? []),
    ...(job.blockedNodes ?? []),
  ]);

  return ids.map((id) => {
    const node = nodeStates[id] ?? {};
    const definition = workflowNodeById(job, id);
    let status = node.status ?? "pending";
    if (!node.status) {
      if ((job.runningNodes ?? []).includes(id)) status = "running";
      else if ((job.completedNodes ?? []).includes(id)) status = "completed";
      else if ((job.blockedNodes ?? []).includes(id)) status = "blocked";
    }

    return {
      id,
      phase: node.phase ?? definition?.phase ?? id,
      status,
      attempt: node.attempt ?? null,
      artifact: node.artifact ?? null,
      reason: node.reason ?? null,
      error: node.error ?? null,
      startedAt: node.startedAt ?? null,
      completedAt: node.completedAt ?? null,
      failedAt: node.failedAt ?? null,
      retryingAt: node.retryingAt ?? null,
      skippedAt: node.skippedAt ?? null,
      cancelledAt: node.cancelledAt ?? null,
      blockedAt: node.blockedAt ?? null,
      durationMs: node.durationMs ?? null,
    };
  });
}

function workflowNodes(job) {
  try {
    const dag = normalizeWorkflow(job.workflow);
    return dag?.nodes ?? [];
  } catch {
    return [];
  }
}

function workflowNodeIds(job) {
  return workflowNodes(job).map((node) => node.id).filter(Boolean);
}

function workflowNodeById(job, id) {
  return workflowNodes(job).find((node) => node.id === id) ?? null;
}

export function jobToPipelineState(job) {
  const retryCount = retryCountForJob(job);
  return {
    project: job.project,
    task: job.task,
    jobId: job.jobId,
    phase: job.phase,
    status: STATUS_MAP[job.status] ?? job.status,
    retryCount,
    maxRetries: null,
    started: job.createdAt,
    updated: job.updatedAt,
    lastActivityAt: job.lastActivityAt ?? null,
    lastActivityMessage: job.lastActivityMessage ?? null,
    completedNodes: job.completedNodes ?? [],
    runningNodes: job.runningNodes ?? [],
    blockedNodes: job.blockedNodes ?? [],
    nodes: projectDagNodes(job),
    workflowDag: job.workflowDag ?? null,
    riskMap: job.riskMap ?? null,
    riskLevel: job.riskLevel ?? job.riskMap?.riskLevel ?? null,
    verificationDepth: job.verificationDepth ?? job.riskMap?.verificationDepth ?? null,
    adversarialRequired: job.adversarialRequired ?? job.riskMap?.adversarialRequired ?? false,
    dynamicAgentPlan: job.dynamicAgentPlan ?? null,
    adversarialVerdict: job.adversarialVerdict ?? null,
    completionGate: job.completionGate ?? null,
  };
}

function retryCountForJob(job) {
  const nodeAttempts = Object.values(job.nodeStates ?? {})
    .map((node) => Number.isFinite(node?.attempt) ? Math.max(0, node.attempt - 1) : 0);
  return Math.max(job.retryCount ?? 0, job.attempt != null ? Math.max(0, job.attempt - 1) : 0, ...nodeAttempts);
}

function currentPhaseForJob(job) {
  const active = projectDagNodes(job).find((node) => ACTIVE_NODE_STATUSES.has(node.status));
  if (active?.phase) return active.phase;
  if (job.failurePhase) return job.failurePhase;
  if (job.phase && job.phase !== "completed") return job.phase;
  return null;
}

function sourceForJob(job) {
  const source = job.sourceContext || {};
  if (source.type === "github_issue" || source.issueNumber !== undefined) {
    return {
      type: "github_issue",
      label: source.issueNumber ? `GitHub issue #${source.issueNumber}` : "GitHub issue",
      issueNumber: source.issueNumber ?? null,
      repo: source.repo || source.repository || null,
      channel: null,
    };
  }
  if (source.type === "slack" || source.channel === "slack") {
    return {
      type: "slack",
      label: source.channelName ? `Slack ${source.channelName}` : "Slack",
      issueNumber: null,
      repo: null,
      channel: source.channelName || source.channelId || null,
    };
  }
  if (source.type === "discord" || source.channel === "discord") {
    return {
      type: "discord",
      label: source.channelName ? `Discord ${source.channelName}` : "Discord",
      issueNumber: null,
      repo: null,
      channel: source.channelName || source.channelId || null,
    };
  }
  if (source.type) {
    return {
      type: source.type,
      label: source.type.replace(/_/g, " "),
      issueNumber: null,
      repo: source.repo || null,
      channel: source.channelName || source.channelId || null,
    };
  }
  return { type: "manual", label: "Manual", issueNumber: null, repo: null, channel: null };
}

function queueStatusForJob(job) {
  if (job.pr?.url || job.pr?.number || job.artifacts?.pr) return "pr-opened";
  if (job.status === "completed") return "passed";
  return job.status || "queued";
}

function nextHumanActionForJob(job, status) {
  if (job.cancelRequested) {
    return { kind: "cancel", label: "Review cancellation request" };
  }
  if (job.redirectContext) {
    return { kind: "redirect", label: "Review redirect instructions" };
  }
  if (status === "queued") {
    return { kind: "start_worker", label: "Start a worker or wait for dispatcher" };
  }
  if (status === "blocked") {
    return { kind: "approval", label: "Review blocker or approval gate" };
  }
  if (status === "failed") {
    return { kind: "retry", label: "Review failure and retry or cancel" };
  }
  if (status === "passed") {
    return { kind: "review_patch", label: "Review verified patch" };
  }
  if (status === "pr-opened") {
    return { kind: "review_pr", label: "Review draft PR" };
  }
  return null;
}

export function jobToQueueRow(job) {
  const status = queueStatusForJob(job);
  const currentPhase = currentPhaseForJob(job);
  return {
    jobId: job.jobId,
    project: job.project,
    task: job.task,
    status,
    rawStatus: job.status || null,
    workflow: job.workflow || "standard",
    currentPhase,
    phase: currentPhase,
    retryCount: retryCountForJob(job),
    source: sourceForJob(job),
    nextHumanAction: nextHumanActionForJob(job, status),
    pr: job.pr || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    lastActivityAt: job.lastActivityAt ?? null,
    lastActivityMessage: job.lastActivityMessage ?? null,
    cancelRequested: job.cancelRequested ?? false,
    redirectContext: job.redirectContext ?? null,
    failureCode: job.failureCode ?? null,
    failurePhase: job.failurePhase ?? null,
    riskLevel: job.riskLevel ?? job.riskMap?.riskLevel ?? null,
    verificationDepth: job.verificationDepth ?? job.riskMap?.verificationDepth ?? null,
    adversarialRequired: job.adversarialRequired ?? job.riskMap?.adversarialRequired ?? false,
    completionGate: job.completionGate ?? null,
  };
}

export function githubStatusCommentDedupeKey(projection) {
  if (!projection?.jobId || !projection?.status) return null;
  const prMarker = projection.pr?.url || projection.pr?.number || "";
  return ["github-status", projection.jobId, projection.status, prMarker]
    .filter((part) => part !== null && part !== undefined && String(part).length > 0)
    .map((part) => String(part))
    .join(":");
}

export function jobToGithubStatusUpdate(job) {
  const row = jobToQueueRow(job || {});
  if (!GITHUB_STATUS_COMMENT_STATUSES.has(row.status)) return null;

  const source = row.source || {};
  if (source.type !== "github_issue") return null;

  const repo = source.repo || job?.sourceContext?.repo || job?.sourceContext?.repository || null;
  const issueNumber = source.issueNumber ?? job?.sourceContext?.issueNumber ?? null;
  if (!repo || issueNumber === null || issueNumber === undefined) return null;

  const projection = {
    jobId: row.jobId,
    project: row.project,
    task: row.task,
    status: row.status,
    rawStatus: row.rawStatus,
    workflow: row.workflow,
    repo,
    issueNumber,
    pr: row.pr,
    retryCount: row.retryCount,
    reason: job?.blockedReason || job?.failureCause?.message || job?.failureCause || row.lastActivityMessage || null,
    failureCode: row.failureCode,
    failurePhase: row.failurePhase,
    updatedAt: row.updatedAt,
  };
  return {
    ...projection,
    dedupeKey: githubStatusCommentDedupeKey(projection),
  };
}

async function allJobs(cpbRoot) {
  return listJobsAcrossRuntimeRoots(cpbRoot);
}

export async function projectPipelineState(cpbRoot, project) {
  const jobs = await allJobs(cpbRoot);
  const matching = jobs.filter((j) => j.project === project);
  if (matching.length === 0) return null;

  const running = matching.find((j) => j.status === "running");
  return jobToPipelineState(running ?? matching[0]);
}

export async function listProjectPipelineStates(cpbRoot) {
  const jobs = await allJobs(cpbRoot);
  const byProject = new Map();
  for (const job of jobs) {
    const existing = byProject.get(job.project);
    if (!existing || existing.status !== "running") {
      byProject.set(job.project, job);
    }
  }
  const result = {};
  for (const [project, job] of byProject) {
    result[project] = jobToPipelineState(job);
  }
  return result;
}
