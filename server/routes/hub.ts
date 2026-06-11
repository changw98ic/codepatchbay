import path from "node:path";
import { realpath } from "node:fs/promises";
import {
  deriveWorkerStatus,
  getProject,
  heartbeatWorker,
  hubStatus,
  listProjects,
  registerProject,
  resolveHubRoot,
  updateProject,
} from "../services/hub-registry.js";
import { readProjectIndex, writeProjectIndex } from "../services/project-index.js";
import { knowledgePolicySummary, findPromotionCandidates } from "../services/knowledge-policy.js";
import { getManagedAcpPool } from "../services/acp-pool.js";
import { gatherDiagnostics } from "../services/diagnostics-bundle.js";
import { readHubConfig, writeHubConfig, isValidSchedulerMode } from "../services/agent-config.js";
import { buildObservabilitySummary } from "../services/observability.js";
import { buildTaskHistory } from "../services/task-history.js";
import { buildTaskLedger } from "../services/task-ledger.js";
import { buildAttentionProjection } from "../services/attention-projection.js";
import { listJobsAcrossRuntimeRoots } from "../services/job-store.js";
import { listSessions } from "../services/review-session.js";
import { collectRuntimeHealth } from "../services/runtime-health.js";
import { readGithubIssues, syncConfiguredGithubIssuesFromGh, syncGithubIssuesFromGh } from "../services/github-issues.js";
import { autoEnqueueSyncedIssues } from "../services/auto-enqueue.js";
import {
  claimEligible,
  enqueue,
  listQueue,
  queueStatus,
  updateEntry,
} from "../services/hub-queue.js";
import { listDispatches } from "../services/dispatch-state.js";
import { AssignmentStore } from "../../shared/orchestrator/assignment-store.js";
import {
  guardSourcePath,
  markDispatchAssigned,
  markDispatchCompleted,
  markDispatchFailed,
  recordDispatch,
} from "../services/worker-dispatch.js";
import { classifyProject, filterVisibleProjects } from "../services/project-pollution.js";

type LooseRecord = Record<string, any>;
const DASHBOARD_JOBS_CACHE_TTL_MS = 500;

async function currentGitHead(sourcePath) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: sourcePath,
    encoding: "utf8",
    timeout: 5000,
  });
  return stdout.trim();
}

async function findStaleProjectIndexBlock(hubRoot, cpbRoot, { projectId = null } = {}) {
  const pending = await listQueue(hubRoot, { status: "pending" });
  for (const entry of pending) {
    if (projectId && entry.projectId !== projectId) continue;
    const projectIdx = await readProjectIndex(hubRoot, cpbRoot, entry.projectId);
    if (!(projectIdx && projectIdx.state === "indexed" && projectIdx.gitHead && entry.sourcePath)) continue;
    try {
      const currentHead = await currentGitHead(entry.sourcePath);
      if (currentHead === projectIdx.gitHead) continue;
      await writeProjectIndex(hubRoot, cpbRoot, entry.projectId, {
        state: "merged_index_stale",
        branch: projectIdx.branch,
        gitHead: projectIdx.gitHead,
        indexedFrom: projectIdx.indexedFrom,
        timestamp: new Date().toISOString(),
        error: `HEAD drift: indexed ${projectIdx.gitHead.slice(0, 12)} but current is ${currentHead.slice(0, 12)}`,
      });
      return {
        entry,
        indexRecovery: {
          detected: "stale",
          reason: "HEAD drift detected",
          previousGitHead: projectIdx.gitHead,
          currentHead,
        },
      };
    } catch {
      // Non-git or unreachable source; let the normal claim path decide.
    }
  }
  return null;
}

function hubRoot(req) {
  return req.cpbHubRoot || resolveHubRoot(req.cpbRoot);
}

async function canonicalDir(fastify, input, label) {
  try {
    return await realpath(path.resolve(input));
  } catch {
    throw fastify.httpErrors.badRequest(`${label} is not a readable directory: ${input}`);
  }
}

async function validateQueueProjectBoundary(fastify, req, input) {
  if (!input.projectId) {
    throw fastify.httpErrors.badRequest("projectId is required");
  }

  const project = await getProject(hubRoot(req), input.projectId);
  if (!project) {
    throw fastify.httpErrors.badRequest(`Project '${input.projectId}' not found`);
  }

  const registeredSourcePath = await canonicalDir(fastify, project.sourcePath, "registered sourcePath");
  if (input.sourcePath) {
    const requestedSourcePath = await canonicalDir(fastify, input.sourcePath, "sourcePath");
    if (requestedSourcePath !== registeredSourcePath) {
      throw fastify.httpErrors.badRequest(`sourcePath must match registered project '${input.projectId}' sourcePath`);
    }
  }

  return {
    ...input,
    sourcePath: registeredSourcePath,
    cwd: registeredSourcePath,
  };
}

export async function hubRoutes(fastify) {
  fastify.get("/hub/status", async (req) => {
    const base = await hubStatus(hubRoot(req));
    return req.hubRuntime ? { ...base, runtime: req.hubRuntime.status() } : base;
  });

  // ── Scheduler config ──
  fastify.get("/hub/scheduler", async (req) => {
    const config = await readHubConfig(hubRoot(req));
    return { mode: config.scheduler?.mode || "default" };
  });

  fastify.patch("/hub/scheduler", async (req) => {
    const body = req.body || {};
    if (!body.mode || !isValidSchedulerMode(body.mode)) {
      throw fastify.httpErrors.badRequest("mode must be 'default' or 'smart'");
    }
    const hr = hubRoot(req);
    const config = await readHubConfig(hr);
    config.scheduler = { ...(config.scheduler || {}), mode: body.mode };
    await writeHubConfig(hr, config);
    return { mode: body.mode };
  });

  fastify.get("/hub/acp", async (req) => {
    const hr = hubRoot(req);
    const pool = getManagedAcpPool({ hubRoot: hr, cpbRoot: req.cpbRoot });
    const quotas = await pool.readProviderQuotas();
    return {
      ...pool.status(),
      providerQuotas: quotas,
      rateLimits: quotas,
    };
  });

  fastify.get("/hub/projects", async (req) => {
    const hr = hubRoot(req);
    const allProjects = await listProjects(hr, { enabledOnly: req.query.enabledOnly === "true" });
    const includeTest = ["true", "1"].includes(req.query.includeTest) ||
      ["true", "1"].includes(req.query.diagnostics);
    const visible = filterVisibleProjects(allProjects, { includeTest, hubRoot: hr });
    const results = [];
    for (const project of visible) {
      const entry: LooseRecord = {
        ...project,
        workerDerivedStatus: deriveWorkerStatus(project.worker),
      };
      if (includeTest) {
        entry._pollution = classifyProject(project, { hubRoot: hr } as LooseRecord);
      }
      results.push(entry);
    }
    return results;
  });

  fastify.post("/hub/projects/attach", async (req) => {
    const body = req.body || {};
    const sourcePath = body.sourcePath || body.path || process.cwd();
    const project = await registerProject(hubRoot(req), {
      id: body.id,
      name: body.name,
      sourcePath,
      enabled: body.enabled,
      weight: body.weight,
      metadata: body.metadata,
      skipCodeGraphGate: body.skipCodeGraphGate !== false,
    });
    return { attached: true, project };
  });

  fastify.get("/hub/projects/:id", async (req) => {
    const project = await getProject(hubRoot(req), req.params.id);
    if (!project) throw fastify.httpErrors.notFound(`Project '${req.params.id}' not found`);
    const projectIndex = await readProjectIndex(hubRoot(req), req.cpbRoot, req.params.id);
    return { ...project, projectIndex };
  });

  fastify.patch("/hub/projects/:id", async (req) => {
    const updated = await updateProject(hubRoot(req), req.params.id, req.body || {});
    if (!updated) throw fastify.httpErrors.notFound(`Project '${req.params.id}' not found`);
    return updated;
  });

  fastify.post("/hub/projects/:id/heartbeat", async (req) => {
    const updated = await heartbeatWorker(hubRoot(req), req.params.id, req.body || {});
    if (!updated) throw fastify.httpErrors.notFound(`Project '${req.params.id}' not found`);
    return { ok: true, project: updated };
  });

  fastify.get("/hub/knowledge-policy", async () => knowledgePolicySummary());

  fastify.get("/hub/roots", async (req) => {
    const projects = await listProjects(hubRoot(req));
    const projectRoots = {};
    for (const p of projects) {
      projectRoots[p.id] = p.projectRuntimeRoot || null;
    }
    return {
      executorRoot: path.resolve(req.cpbRoot),
      hubRoot: hubRoot(req),
      projectRuntimeRoots: projectRoots,
    };
  });

  fastify.get("/hub/queue/status", async (req) => queueStatus(hubRoot(req)));

  fastify.get("/hub/queue", async (req) => {
    const filter: LooseRecord = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.projectId) filter.projectId = req.query.projectId;
    return listQueue(hubRoot(req), filter);
  });

  fastify.post("/hub/queue/enqueue", async (req) => {
    const input = await validateQueueProjectBoundary(fastify, req, req.body || {});
    const entry = await enqueue(hubRoot(req), input);
    return { enqueued: true, entry };
  });

  fastify.post("/hub/queue/claim", async (req) => {
    const body = req.body || {};
    const hr = hubRoot(req);
    const staleBlock = await findStaleProjectIndexBlock(hr, req.cpbRoot, {
      projectId: body.projectId || null,
    });
    if (staleBlock) {
      return {
        claimed: false,
        reason: "project-index-stale",
        indexRecovery: staleBlock.indexRecovery,
        blockedEntryId: staleBlock.entry.id,
        recovered: [],
        activeProjects: [],
        skippedBusy: [],
      };
    }

    const assignmentStore = new AssignmentStore(hr);
    await assignmentStore.init();
    const result = await claimEligible(hr, {
      workerId: body.workerId,
      projectId: body.projectId || null,
      maxActivePerProject: body.maxActivePerProject ?? 2,
      claimTimeoutMs: body.claimTimeoutMs ?? 120_000,
      providerSlotsAvailable: body.providerSlotsAvailable !== false,
      requireIssueLink: body.requireIssueLink === true,
      getProjectFn: getProject,
      assignmentStore,
    });
    if (!result.entry) {
      return { claimed: false, reason: result.reason, recovered: result.recovered, activeProjects: result.activeProjects, skippedBusy: result.skippedBusy };
    }

    // Stale index detection: check BEFORE dispatch to gate on stale HEAD drift
    let indexRecovery = null;
    const projectId = result.entry.projectId;
    const projectIdx = await readProjectIndex(hubRoot(req), req.cpbRoot, projectId);
    if (projectIdx && projectIdx.state === "indexed" && projectIdx.gitHead && result.entry.sourcePath) {
      try {
        const currentHead = await currentGitHead(result.entry.sourcePath);
        if (currentHead !== projectIdx.gitHead) {
          await writeProjectIndex(hubRoot(req), req.cpbRoot, projectId, {
            state: "merged_index_stale",
            branch: projectIdx.branch,
            gitHead: projectIdx.gitHead,
            indexedFrom: projectIdx.indexedFrom,
            timestamp: new Date().toISOString(),
            error: `HEAD drift: indexed ${projectIdx.gitHead.slice(0, 12)} but current is ${currentHead.slice(0, 12)}`,
          });
          indexRecovery = { detected: "stale", reason: "HEAD drift detected", previousGitHead: projectIdx.gitHead, currentHead };

          // Block: release claim back to pending and return without dispatching
          await updateEntry(hubRoot(req), result.entry.id, { status: "pending", workerId: null });
          return {
            claimed: false,
            reason: "project-index-stale",
            indexRecovery,
            blockedEntryId: result.entry.id,
            recovered: result.recovered,
            activeProjects: result.activeProjects,
            skippedBusy: result.skippedBusy,
          };
        }
      } catch { /* non-git source or unreachable */ }
    }

    // Only dispatch after stale gate passes
    let dispatch = null;
    if (result.entry.sourcePath) {
      dispatch = await recordDispatch(hubRoot(req), {
        projectId: result.entry.projectId,
        sourcePath: result.entry.sourcePath,
        sessionId: result.entry.sessionId,
        workerId: result.entry.workerId,
        queueEntryId: result.entry.id,
      });
    }

    return { claimed: true, entry: result.entry, dispatch, recovered: result.recovered, activeProjects: result.activeProjects, skippedBusy: result.skippedBusy, indexRecovery };
  });

  fastify.patch("/hub/queue/:entryId", async (req) => {
    const updated = await updateEntry(hubRoot(req), req.params.entryId, req.body || {});
    if (!updated) throw fastify.httpErrors.notFound(`Queue entry '${req.params.entryId}' not found`);
    return updated;
  });

  fastify.get("/hub/diagnostics", async (req) => {
    return gatherDiagnostics({
      cpbRoot: req.cpbRoot,
      hubRoot: hubRoot(req),
      acpPool: getManagedAcpPool({ hubRoot: hubRoot(req), cpbRoot: req.cpbRoot }),
    } as LooseRecord);
  });

  fastify.get("/hub/observability", async (req) => {
    const hr = hubRoot(req);
    const summary: LooseRecord = await buildObservabilitySummary({
      cpbRoot: req.cpbRoot,
      hubRoot: hr,
      acpPool: getManagedAcpPool({ hubRoot: hr, cpbRoot: req.cpbRoot }),
    });
    // Extend with provider quota/usage summary
    try {
      const { listProviderQuotas } = await import("../services/provider-quota.js");
      const { readSystemUsageRollup } = await import("../services/provider-usage.js");
      const [quotas, usage] = await Promise.all([
        listProviderQuotas(hr).catch(() => []),
        readSystemUsageRollup(hr).catch(() => null),
      ]);
      summary.providerQuotas = quotas;
      summary.providerUsage = usage;
    } catch { /* optional enhancement */ }
    return summary;
  });

  fastify.get("/hub/provider-quotas", async (req) => {
    const { listProviderQuotas } = await import("../services/provider-quota.js");
    return listProviderQuotas(hubRoot(req));
  });

  fastify.get("/hub/provider-usage", async (req) => {
    const { readProviderUsageRollup, readSystemUsageRollup } = await import("../services/provider-usage.js");
    const hr = hubRoot(req);
    const rollup = req.query.system === "true"
      ? await readSystemUsageRollup(hr)
      : await readProviderUsageRollup(hr);
    return rollup;
  });

  fastify.get("/hub/task-history", async (req) => {
    const kinds = typeof req.query.kinds === "string"
      ? req.query.kinds.split(",").map((kind) => kind.trim()).filter(Boolean)
      : undefined;
    return buildTaskHistory({
      cpbRoot: req.cpbRoot,
      hubRoot: hubRoot(req),
      limit: req.query.limit,
      projectId: req.query.projectId,
      kinds,
    });
  });

  fastify.get("/hub/task-ledger", async (req) => {
    return buildTaskLedger({
      cpbRoot: req.cpbRoot,
      hubRoot: hubRoot(req),
      limit: req.query.limit,
      projectId: req.query.projectId,
      includeQueueOnly: req.query.includeQueueOnly === "true",
      includeArchived: req.query.includeArchived === "true",
    } as LooseRecord);
  });

  fastify.get("/hub/github/issues", async (req) => {
    const issues = await readGithubIssues(hubRoot(req));
    return {
      count: issues.length,
      open: issues.filter((issue) => String(issue.state || "").toUpperCase() !== "CLOSED").length,
      issues,
    };
  });

  fastify.post("/hub/github/issues/sync", async (req) => {
    const body = req.body || {};
    if (!body.projectId && !body.repo) {
      return syncConfiguredGithubIssuesFromGh(hubRoot(req), {
        state: body.state,
        limit: body.limit,
        cwd: req.cpbRoot,
      });
    }

    let cwd = req.cpbRoot;
    let repo = body.repo;
    if (body.projectId) {
      const project = await getProject(hubRoot(req), body.projectId);
      if (project?.sourcePath) cwd = project.sourcePath;
      if (!repo) repo = project?.github?.fullName;
    }
    const result = await syncGithubIssuesFromGh(hubRoot(req), {
      repo,
      projectId: body.projectId,
      state: body.state,
      limit: body.limit,
      cwd,
    });
    const response: LooseRecord = { synced: true, ...result };
    if (body.autoEnqueue && body.projectId) {
      const eqResult = await autoEnqueueSyncedIssues(hubRoot(req), req.cpbRoot, body.projectId);
      response.autoEnqueue = eqResult;
    }
    return response;
  });

  fastify.post("/hub/github/issues/auto-enqueue", async (req) => {
    const body = req.body || {};
    const projectId = body.projectId;
    if (!projectId) return { error: "projectId required" };
    const dryRun = body.dryRun === true;
    const result = await autoEnqueueSyncedIssues(hubRoot(req), req.cpbRoot, projectId, { dryRun });
    return { enqueued: true, ...result };
  });

  fastify.get("/hub/knowledge/promotion-candidates", async (req) => {
    const projects = await listProjects(hubRoot(req));
    const allCandidates = [];
    for (const project of projects) {
      const candidates = await findPromotionCandidates(project.sourcePath, {
        projectRuntimeRoot: project.projectRuntimeRoot,
      });
      if (candidates.length > 0) {
        allCandidates.push({ projectId: project.id, candidates });
      }
    }
    return { candidates: allCandidates };
  });

  fastify.get("/hub/dispatches", async (req) => {
    const filter: LooseRecord = {};
    if (req.query.projectId) filter.projectId = req.query.projectId;
    if (req.query.status) filter.status = req.query.status;
    return listDispatches(hubRoot(req), filter);
  });

  fastify.post("/hub/dispatches/record", async (req) => {
    const body = req.body || {};
    const dispatch = await recordDispatch(hubRoot(req), {
      projectId: body.projectId,
      sourcePath: body.sourcePath,
      sessionId: body.sessionId,
      workerId: body.workerId,
      queueEntryId: body.queueEntryId,
    });
    if (!dispatch) throw fastify.httpErrors.badRequest("dispatch recording is not enabled");
    return { recorded: true, dispatch };
  });

  fastify.post("/hub/dispatches/:dispatchId/assign", async (req) => {
    const body = req.body || {};
    const dispatch = await markDispatchAssigned(hubRoot(req), req.params.dispatchId, {
      workerId: body.workerId,
    });
    if (!dispatch) throw fastify.httpErrors.notFound(`Dispatch '${req.params.dispatchId}' not found or dispatch not enabled`);
    return { assigned: true, dispatch };
  });

  fastify.post("/hub/dispatches/:dispatchId/start", async (req) => {
    const { lookupDispatch, markDispatchStarted: start } = await import("../services/worker-dispatch.js");
    const dispatch = await lookupDispatch(hubRoot(req), req.params.dispatchId);
    if (!dispatch) throw fastify.httpErrors.notFound(`Dispatch '${req.params.dispatchId}' not found`);
    if (dispatch.sourcePath) {
      await guardSourcePath(hubRoot(req), dispatch.projectId, dispatch.sourcePath);
    }
    const updated = await start(hubRoot(req), req.params.dispatchId);
    return { started: true, dispatch: updated };
  });

  fastify.post("/hub/dispatches/:dispatchId/complete", async (req) => {
    const dispatch = await markDispatchCompleted(hubRoot(req), req.params.dispatchId);
    if (!dispatch) throw fastify.httpErrors.notFound(`Dispatch '${req.params.dispatchId}' not found or dispatch not enabled`);
    return { completed: true, dispatch };
  });

  fastify.post("/hub/dispatches/:dispatchId/fail", async (req) => {
    const dispatch = await markDispatchFailed(hubRoot(req), req.params.dispatchId);
    if (!dispatch) throw fastify.httpErrors.notFound(`Dispatch '${req.params.dispatchId}' not found or dispatch not enabled`);
    return { failed: true, dispatch };
  });

  fastify.get("/hub/dashboard-summary", async (req) => {
    const hr = hubRoot(req);
    const cr = req.cpbRoot;
    const includeTest = ["true", "1"].includes(req.query.includeTest) ||
      ["true", "1"].includes(req.query.diagnostics);
      
    const [
      status,
      allProjects,
      acpPool,
      policy,
      qStatus,
      queue,
      dispatches,
      obs,
      ledger,
      jobs,
      reviews,
      runtimeHealth,
    ] = await Promise.all([
      hubStatus(hr).catch(() => null),
      listProjects(hr, { enabledOnly: req.query.enabledOnly === "true" }).catch(() => []),
      (async () => {
        const pool = getManagedAcpPool({ hubRoot: hr, cpbRoot: cr });
        const providerQuotas = await pool.readProviderQuotas().catch(() => ({}));
        return {
          ...pool.status(),
          providerQuotas,
          rateLimits: providerQuotas,
        };
      })().catch(() => null),
      Promise.resolve(knowledgePolicySummary()).catch(() => null),
      queueStatus(hr).catch(() => null),
      listQueue(hr, {}).catch(() => []),
      listDispatches(hr, {}).catch(() => []),
      buildObservabilitySummary({ cpbRoot: cr, hubRoot: hr, acpPool: getManagedAcpPool({ hubRoot: hr, cpbRoot: cr }) }).catch(() => null),
      buildTaskLedger({ cpbRoot: cr, hubRoot: hr, limit: req.query.limit || 50 } as LooseRecord).catch(() => null),
      listJobsAcrossRuntimeRoots(cr, { hubRoot: hr, cacheTtlMs: DASHBOARD_JOBS_CACHE_TTL_MS }).catch(() => []),
      listSessions(cr, { hubRoot: hr }).catch(() => []),
      resolveRuntimeHealth(req, cr),
    ]);

    const visible = filterVisibleProjects(allProjects || [], { includeTest, hubRoot: hr });
    const registryProjects = [];
    for (const project of visible) {
      const entry: LooseRecord = {
        ...project,
        workerDerivedStatus: deriveWorkerStatus(project.worker),
      };
      if (includeTest) {
        entry._pollution = classifyProject(project, { hubRoot: hr } as LooseRecord);
      }
      registryProjects.push(entry);
    }
    const attentionItems = buildAttentionProjection({
      jobs,
      queueEntries: queue,
      reviews,
      runtimeHealth,
    });

    return {
      status,
      registryProjects,
      acp: acpPool,
      knowledgePolicy: policy,
      queueStatus: qStatus,
      queueEntries: queue,
      dispatches,
      observability: obs,
      taskLedger: ledger,
      attention: attentionSummary(attentionItems, req.query.limit),
    };
  });
}

function attentionSummary(items, limit) {
  const maxLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 5));
  const countsBySeverity = { critical: 0, warning: 0, info: 0 };
  const countsByKind = {};
  for (const item of items) {
    countsBySeverity[item.severity] = (countsBySeverity[item.severity] || 0) + 1;
    countsByKind[item.kind] = (countsByKind[item.kind] || 0) + 1;
  }
  return {
    items: items.slice(0, maxLimit),
    total: items.length,
    countsBySeverity,
    countsByKind,
  };
}

async function resolveRuntimeHealth(req, cpbRoot) {
  if (req.runtimeHealth) return req.runtimeHealth;
  return collectRuntimeHealth({
    cpbRoot,
    executorRoot: req.cpbExecutorRoot || cpbRoot,
  }).catch(() => null);
}
