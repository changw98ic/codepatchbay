// @ts-nocheck
import { listJobsAcrossRuntimeRoots } from "./job-store.js";
import { jobToQueueRow } from "./job-projection.js";

const runningTasks = new Map();

export function registerTask(taskId, project, script, pid) {
  runningTasks.set(taskId, { project, script, pid, started: Date.now() });
}

export function unregisterTask(taskId) {
  runningTasks.delete(taskId);
}

export function getRunningTasks() {
  return Array.from(runningTasks.entries()).map(([id, task]) => ({
    id,
    ...task,
    duration: Date.now() - task.started,
  }));
}

export async function getDurableTasks(cpbRoot, { hubRoot } = {}) {
  const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, {
    hubRoot,
    includeHubProjects: Boolean(hubRoot),
  });
  return jobs.map((job) => ({ ...job, ...jobToQueueRow(job) }));
}
