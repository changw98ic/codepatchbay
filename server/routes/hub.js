import path from "node:path";
import {
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
import { buildObservabilitySummary } from "../services/observability.js";
import { buildTaskHistory } from "../services/task-history.js";
import { buildTaskLedger } from "../services/task-ledger.js";
import { readGithubIssues, syncConfiguredGithubIssuesFromGh, syncGithubIssuesFromGh } from "../services/github-issues.js";
import { autoEnqueueSyncedIssues } from "../services/auto-enqueue.js";
import {
  claimEligible,
  dequeue as dequeueEntry,
  enqueue,
  listQueue,
  queueStatus,
  updateEntry,
} from "../services/hub-queue.js";
import { listDispatches } from "../services/dispatch-state.js";
import {
  guardSourcePath,
  markDispatchAssigned,
  markDispatchCompleted,
  markDispatchFailed,
  recordDispatch,
} from "../services/worker-dispatch.js";
import { readProjectCodeIndexStatus, refreshProjectCodeIndex } from "../services/project-code-index.js";
import { classifyProject, filterVisibleProjects } from "../services/project-pollution.js";

function hubRoot(req) {
  return req.cpbHubRoot || resolveHubRoot(req.cpbRoot);
}

export async function hubRoutes(fastify) {
  fastify.get("/hub/status", async (req) => {
    const base = await hubStatus(hubRoot(req));
    return req.hubRuntime ? { ...base, runtime: req.hubRuntime.status() } : base;
  });

  fastify.get("/hub/acp", async (req) => {
    const hr = hubRoot(req);
    const pool = getManagedAcpPool({ hubRoot: hr, cpbRoot: req.cpbRoot });
    const quotas = await pool.readDurableRateLimits();
    return {
      ...pool.status(),
      rateLimits: quotas,       // backward compat
      providerQuotas: quotas,   // new name
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
      const idx = await readProjectCodeIndexStatus(project, { hubRoot: hr });
      const entry = {
        ...project,
        indexStatus: {
          status: idx.status,
          updatedAt: idx.updatedAt,
          fileCount: idx.fileCount,
          symbolCount: idx.symbolCount,
          commandCount: idx.commandCount,
          branch: idx.branch,
          headShort: idx.headShort,
          contentHash: idx.contentHash,
        },
      };
      if (includeTest) {
        entry._pollution = classifyProject(project, { hubRoot: hr });
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
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.projectId) filter.projectId = req.query.projectId;
    return listQueue(hubRoot(req), filter);
  });

  fastify.post("/hub/queue/enqueue", async (req) => {
    const entry = await enqueue(hubRoot(req), req.body || {});
    return { enqueued: true, entry };
  });

  fastify.post("/hub/queue/dequeue", async (req) => {
    const result = await claimEligible(hubRoot(req), {
      workerId: `dequeue-${process.pid}`,
      getProjectFn: getProject,
    });
    if (!result.entry) throw fastify.httpErrors.notFound(result.reason || "No pending entries in queue");
    const entry = result.entry;
    const dispatch = await recordDispatch(hubRoot(req), {
      projectId: entry.projectId,
      sourcePath: entry.sourcePath,
      sessionId: entry.sessionId,
      queueEntryId: entry.id,
    });
    return { dequeued: true, entry, dispatch };
  });

  fastify.post("/hub/queue/claim", async (req) => {
    const body = req.body || {};
    const result = await claimEligible(hubRoot(req), {
      workerId: body.workerId,
      projectId: body.projectId || null,
      maxActivePerProject: body.maxActivePerProject ?? 2,
      maxActiveTotal: body.maxActiveTotal ?? Number(process.env.CPB_HUB_MAX_ACTIVE_TOTAL ?? 0),
      claimTimeoutMs: body.claimTimeoutMs ?? 120_000,
      providerSlotsAvailable: body.providerSlotsAvailable !== false,
      requireIssueLink: body.requireIssueLink !== false,
      getProjectFn: getProject,
    });
    if (!result.entry) {
      return { claimed: false, reason: result.reason, recovered: result.recovered, activeProjects: result.activeProjects, skippedBusy: result.skippedBusy };
    }

    // Stale index detection: check BEFORE dispatch to gate on stale HEAD drift
    let indexRepair = null;
    const projectId = result.entry.projectId;
    const projectIdx = await readProjectIndex(hubRoot(req), req.cpbRoot, projectId);
    if (projectIdx && projectIdx.state === "indexed" && projectIdx.gitHead && result.entry.sourcePath) {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
          cwd: result.entry.sourcePath,
          encoding: "utf8",
          timeout: 5000,
        });
        const currentHead = stdout.trim();
        if (currentHead !== projectIdx.gitHead) {
          await writeProjectIndex(hubRoot(req), req.cpbRoot, projectId, {
            state: "merged_index_stale",
            branch: projectIdx.branch,
            gitHead: projectIdx.gitHead,
            indexedFrom: projectIdx.indexedFrom,
            timestamp: new Date().toISOString(),
            error: `HEAD drift: indexed ${projectIdx.gitHead.slice(0, 12)} but current is ${currentHead.slice(0, 12)}`,
          });
          indexRepair = { detected: "stale", reason: "HEAD drift detected", previousGitHead: projectIdx.gitHead, currentHead };

          // Block: release claim back to pending and return without dispatching
          await updateEntry(hubRoot(req), result.entry.id, { status: "pending", workerId: null });
          return {
            claimed: false,
            reason: "project-index-stale",
            indexRepair,
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

    return { claimed: true, entry: result.entry, dispatch, recovered: result.recovered, activeProjects: result.activeProjects, skippedBusy: result.skippedBusy, indexRepair };
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
    });
  });

  fastify.get("/hub/observability", async (req) => {
    const hr = hubRoot(req);
    const summary = await buildObservabilitySummary({
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
    });
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
    const response = { synced: true, ...result };
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
      const candidates = await findPromotionCandidates(project.sourcePath);
      if (candidates.length > 0) {
        allCandidates.push({ projectId: project.id, candidates });
      }
    }
    return { candidates: allCandidates };
  });

  fastify.get("/hub/dispatches", async (req) => {
    const filter = {};
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

  // Project code index endpoints
  fastify.get("/hub/projects/:id/index", async (req) => {
    const hr = hubRoot(req);
    const project = await getProject(hr, req.params.id);
    if (!project) throw fastify.httpErrors.notFound(`Project '${req.params.id}' not found`);
    if (!project.sourcePath) throw fastify.httpErrors.badRequest(`Project '${req.params.id}' has no sourcePath`);
    return await readProjectCodeIndexStatus(project, { hubRoot: hr });
  });

  fastify.post("/hub/projects/:id/index/refresh", async (req) => {
    const hr = hubRoot(req);
    const project = await getProject(hr, req.params.id);
    if (!project) throw fastify.httpErrors.notFound(`Project '${req.params.id}' not found`);
    if (!project.sourcePath) throw fastify.httpErrors.badRequest(`Project '${req.params.id}' has no sourcePath`);
    return await refreshProjectCodeIndex(project, { hubRoot: hr });
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
    ] = await Promise.all([
      hubStatus(hr).catch(() => null),
      listProjects(hr, { enabledOnly: req.query.enabledOnly === "true" }).catch(() => []),
      (async () => {
        const pool = getManagedAcpPool({ hubRoot: hr, cpbRoot: cr });
        const durLimits = await pool.readDurableRateLimits().catch(() => ({}));
        return {
          ...pool.status(),
          rateLimits: durLimits,
        };
      })().catch(() => null),
      Promise.resolve(knowledgePolicySummary()).catch(() => null),
      queueStatus(hr).catch(() => null),
      listQueue(hr, {}).catch(() => []),
      listDispatches(hr, {}).catch(() => []),
      buildObservabilitySummary({ cpbRoot: cr, hubRoot: hr, acpPool: getManagedAcpPool({ hubRoot: hr, cpbRoot: cr }) }).catch(() => null),
      buildTaskLedger({ cpbRoot: cr, hubRoot: hr, limit: req.query.limit || 50 }).catch(() => null),
    ]);

    const visible = filterVisibleProjects(allProjects || [], { includeTest, hubRoot: hr });
    const registryProjects = [];
    for (const project of visible) {
      const idx = await readProjectCodeIndexStatus(project, { hubRoot: hr }).catch(() => ({ status: "unknown" }));
      const entry = {
        ...project,
        indexStatus: {
          status: idx.status,
          updatedAt: idx.updatedAt,
          fileCount: idx.fileCount,
          symbolCount: idx.symbolCount,
          commandCount: idx.commandCount,
          branch: idx.branch,
          headShort: idx.headShort,
          contentHash: idx.contentHash,
        },
      };
      if (includeTest) {
        entry._pollution = classifyProject(project, { hubRoot: hr });
      }
      registryProjects.push(entry);
    }

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
    };
  });
}
