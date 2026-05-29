import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function appendJobEvent(cpbRoot, project, jobId, event) {
  const eventsDir = path.join(cpbRoot, "cpb-task", "events", project);
  await mkdir(eventsDir, { recursive: true });
  const line = JSON.stringify({ ...event, jobId, project, ts: event.ts || new Date().toISOString() }) + "\n";
  await appendFile(path.join(eventsDir, `${jobId}.jsonl`), line, "utf8");
}

export function jobStartedEvent({ task, workflow, planMode }) {
  return { type: "job_started", task, workflow, planMode };
}

export function phaseStartedEvent(phase) {
  return { type: "phase_started", phase };
}

export function phaseResultEvent(phase, result) {
  return { type: "phase_result", phase, status: result.status, artifact: result.artifact?.name || null };
}

export function jobCompletedEvent(artifact) {
  return { type: "job_completed", artifact: artifact?.name || null };
}

export function jobFailedEvent({ reason, code, phase, cause }) {
  return { type: "job_failed", reason, code, phase, cause: cause || {} };
}
