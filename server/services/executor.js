import { listJobs } from "./job-store.js";

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

export async function getDurableTasks(flowRoot) {
  return listJobs(flowRoot);
}
