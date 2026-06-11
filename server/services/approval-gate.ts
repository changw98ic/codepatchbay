import { appendEvent } from "./event-store.js";
import { getJob } from "./job-store.js";

function nowIso() {
  return new Date().toISOString();
}

export async function requestApprovalGate(
  cpbRoot: string,
  project: string,
  jobId: string,
  { operation, phase, channels = [], reason = "approval required", timeoutAt = null, ts = nowIso(), dataRoot }: Record<string, any> = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "approval_required",
    jobId,
    project,
    operation,
    phase,
    channels,
    reason,
    timeoutAt,
    ts,
  }, { dataRoot });
  return getJob(cpbRoot, project, jobId, { dataRoot });
}

export async function approveGate(
  cpbRoot: string,
  project: string,
  jobId: string,
  { actor = null, action = null, ts = nowIso(), dataRoot }: Record<string, any> = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_approved",
    jobId,
    project,
    actor,
    action,
    ts,
  }, { dataRoot });
  return getJob(cpbRoot, project, jobId, { dataRoot });
}

export async function timeoutApprovalGate(
  cpbRoot: string,
  project: string,
  jobId: string,
  { reason = "approval timed out", ts = nowIso(), dataRoot }: Record<string, any> = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "approval_timed_out",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });

  const { extractExperienceFromTerminalState } = await import("./experience-extractor.js");
  const state = await getJob(cpbRoot, project, jobId, { dataRoot });
  await extractExperienceFromTerminalState(cpbRoot, project, jobId, state, "approval_timed_out").catch(() => {});

  return state;
}
