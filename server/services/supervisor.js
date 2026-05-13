import { isLeaseStale, readLease } from "./lease-manager.js";
import { listJobs } from "./job-store.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked"]);

function hasArtifact(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function nextPhaseFor(state) {
  if (!state || TERMINAL_STATUSES.has(state.status)) {
    return "";
  }

  const artifacts = state.artifacts ?? {};
  if (!hasArtifact(artifacts.plan)) {
    return "plan";
  }
  if (!hasArtifact(artifacts.execute)) {
    return "execute";
  }
  if (!hasArtifact(artifacts.verify)) {
    return "verify";
  }
  return "complete";
}

export async function recoverJobs(flowRoot, { now } = {}) {
  const jobs = await listJobs(flowRoot);
  const recoverable = [];

  for (const job of jobs) {
    if (nextPhaseFor(job) === "") {
      continue;
    }

    if (job.leaseId) {
      const lease = await readLease(flowRoot, job.leaseId);
      if (lease !== null && !isLeaseStale(lease, now)) {
        continue;
      }
    }

    recoverable.push(job);
  }

  return recoverable;
}
