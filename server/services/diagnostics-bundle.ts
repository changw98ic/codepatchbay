import path from "node:path";
import { hubStatus, listProjects } from "./hub-registry.js";
import { queueStatus } from "./hub-queue.js";
import { knowledgePolicySummary } from "./knowledge-policy.js";
import { listJobs } from "./job-store.js";
import { redactSecrets as sharedRedactSecrets } from "./secret-policy.js";
import { WorkerStore, summarizeWorkers } from "../../shared/orchestrator/worker-store.js";

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
}: Record<string, any> = {}) {
  const errors = [];
  let hub;
  try {
    hub = await hubStatus(hubRoot);
  } catch (e) {
    errors.push({ source: "hub-status", message: e.message });
    hub = { hubRoot: path.resolve(hubRoot), projectCount: 0, enabledProjectCount: 0 };
  }

  let managedWorkers = [];
  try {
    const workerStore = new WorkerStore(hubRoot);
    managedWorkers = await workerStore.listWorkers();
  } catch (e) {
    errors.push({ source: "workers", message: e.message });
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
      const providerQuotas = await acpPool.readProviderQuotas();
      acp = { ...acpPool.status(), providerQuotas, rateLimits: providerQuotas };
    } else {
      const { AcpPool } = await import("./acp-pool.js");
      const pool = new AcpPool({ cpbRoot, hubRoot });
      const providerQuotas = await pool.readProviderQuotas();
      acp = { ...pool.status(), providerQuotas, rateLimits: providerQuotas };
    }
  } catch (e) {
    errors.push({ source: "acp-pool", message: e.message });
    acp = { pools: {}, providerQuotas: {}, rateLimits: {} };
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
      updatedAt: hub.updatedAt,
    },
    workers: {
      ...summarizeWorkers(managedWorkers),
      details: managedWorkers,
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
