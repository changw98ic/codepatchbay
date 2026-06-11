import { listJobsAcrossRuntimeRoots } from "./job-store.js";
import { jobToQueueRow } from "./job-projection.js";

const runningTasks = new Map<string, { project: string; script: string; pid: number; started: number }>();

export function registerTask(taskId: string, project: string, script: string, pid: number) {
  runningTasks.set(taskId, { project, script, pid, started: Date.now() });
}

export function unregisterTask(taskId: string) {
  runningTasks.delete(taskId);
}

export function getRunningTasks() {
  return Array.from(runningTasks.entries()).map(([id, task]) => ({
    id,
    ...task,
    duration: Date.now() - task.started,
  }));
}

export async function getDurableTasks(cpbRoot: string, { hubRoot, cacheTtlMs }: { hubRoot?: string; cacheTtlMs?: number } = {}) {
  const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, {
    hubRoot,
    cacheTtlMs,
    includeHubProjects: Boolean(hubRoot),
  });
  return (jobs as Array<Record<string, any>>).map((job) => ({ ...job, ...jobToQueueRow(job) }));
}
