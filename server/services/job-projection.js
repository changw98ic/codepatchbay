import { listJobs } from "./job-store.js";

const STATUS_MAP = {
  running: "EXECUTING",
  completed: "DONE",
  failed: "FAILED",
  blocked: "BLOCKED",
};

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
  };
}

export async function projectPipelineState(flowRoot, project) {
  const jobs = await listJobs(flowRoot);
  const matching = jobs.filter((j) => j.project === project);
  if (matching.length === 0) return null;

  const running = matching.find((j) => j.status === "running");
  return jobToPipelineState(running ?? matching[0]);
}

export async function listProjectPipelineStates(flowRoot) {
  const jobs = await listJobs(flowRoot);
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
