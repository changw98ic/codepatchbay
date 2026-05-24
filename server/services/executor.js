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

export async function getDurableTasks(cpbRoot) {
  const jobs = await listJobsAcrossRuntimeRoots(cpbRoot);
  return jobs.map((job) => ({ ...job, ...jobToQueueRow(job) }));
}
