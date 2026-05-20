import path from "node:path";
import { hubStatus, listProjects } from "./hub-registry.js";
import { queueStatus } from "./hub-queue.js";
import { knowledgePolicySummary } from "./knowledge-policy.js";
import { listJobs } from "./job-store.js";
import { redactSecrets as sharedRedactSecrets } from "./secret-policy.js";

function redactSecrets(obj) {
  return sharedRedactSecrets(obj);
}

function jobSummary(job) {
  return {
    jobId: job.jobId,
    project: job.project,
    status: job.status,
    workflow: job.workflow,
    task: job.task,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    currentPhase: job.currentPhase || null,
    failureCode: job.failureCode || null,
    retryCount: job.retryCount || 0,
  };
}

export async function gatherDiagnostics({
  cpbRoot,
  hubRoot,
  recentJobsLimit = 5,
  acpPool = null,
} = {}) {
  const errors = [];
  let hub;
  try {
    hub = await hubStatus(hubRoot);
  } catch (e) {
    errors.push({ source: "hub-status", message: e.message });
    hub = { hubRoot: path.resolve(hubRoot), projectCount: 0, enabledProjectCount: 0, workersOnline: 0, workersStale: 0, workersOffline: 0 };
  }

  let projects = [];
  try {
    projects = await listProjects(hubRoot);
  } catch (e) {
    errors.push({ source: "projects", message: e.message });
  }

  let queue;
  try {
    queue = await queueStatus(hubRoot);
  } catch (e) {
    errors.push({ source: "queue", message: e.message });
    queue = { total: 0, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 };
  }

  let acp;
  try {
    if (acpPool) {
      acp = { ...acpPool.status(), rateLimits: await acpPool.readDurableRateLimits() };
    } else {
      const { AcpPool } = await import("../../bridges/acp-pool.mjs");
      const pool = new AcpPool({ cpbRoot, hubRoot });
      acp = { ...pool.status(), rateLimits: await pool.readDurableRateLimits() };
    }
  } catch (e) {
    errors.push({ source: "acp-pool", message: e.message });
    acp = { pools: {}, rateLimits: {} };
  }

  let knowledgePolicy;
  try {
    knowledgePolicy = knowledgePolicySummary();
  } catch (e) {
    errors.push({ source: "knowledge-policy", message: e.message });
    knowledgePolicy = null;
  }

  let recentJobs = [];
  try {
    const allJobs = await listJobs(cpbRoot);
    recentJobs = allJobs.slice(0, recentJobsLimit).map(jobSummary);
  } catch (e) {
    errors.push({ source: "jobs", message: e.message });
  }

  const result = {
    gatheredAt: new Date().toISOString(),
    cpbRoot: path.resolve(cpbRoot),
    roots: {
      executorRoot: path.resolve(cpbRoot),
      hubRoot: path.resolve(hubRoot),
      projectRuntimeRoots: projects.reduce((acc, p) => {
        if (p.projectRuntimeRoot) acc[p.id] = p.projectRuntimeRoot;
        return acc;
      }, {}),
    },
    hub: {
      hubRoot: hub.hubRoot,
      projectCount: hub.projectCount,
      enabledProjectCount: hub.enabledProjectCount,
      workersOnline: hub.workersOnline,
      workersStale: hub.workersStale,
      workersOffline: hub.workersOffline,
      updatedAt: hub.updatedAt,
    },
    projectIds: projects.map((p) => p.id),
    queue,
    acp,
    knowledgePolicy,
    recentJobs,
    errors: errors.length ? errors : undefined,
  };

  return redactSecrets(result);
}

export { redactSecrets };
