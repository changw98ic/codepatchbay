import { listJobsAcrossRuntimeRoots } from "./job-store.js";
import { normalizeWorkflow } from "../../core/workflow/definition.js";

const STATUS_MAP = {
  running: "EXECUTING",
  completed: "DONE",
  failed: "FAILED",
  blocked: "BLOCKED",
};

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
  return {
    project: job.project,
    task: job.task,
    jobId: job.jobId,
    phase: job.phase,
    status: STATUS_MAP[job.status] ?? job.status,
    retryCount: job.attempt != null ? job.attempt - 1 : null,
    maxRetries: null,
    started: job.createdAt,
    updated: job.updatedAt,
    lastActivityAt: job.lastActivityAt ?? null,
    lastActivityMessage: job.lastActivityMessage ?? null,
    completedNodes: job.completedNodes ?? [],
    runningNodes: job.runningNodes ?? [],
    blockedNodes: job.blockedNodes ?? [],
    nodes: projectDagNodes(job),
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
