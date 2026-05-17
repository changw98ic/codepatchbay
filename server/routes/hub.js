import path from "node:path";
import {
  getProject,
  heartbeatWorker,
  hubStatus,
  listProjects,
  registerProject,
  resolveHubRoot,
  updateProject,
  workerStatus,
} from "../services/hub-registry.js";
import { knowledgePolicySummary, findPromotionCandidates } from "../services/knowledge-policy.js";
import { getManagedAcpPool } from "../services/acp-pool-runtime.js";
import { gatherDiagnostics } from "../services/diagnostics-bundle.js";
import { buildObservabilitySummary } from "../services/observability.js";
import {
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

function hubRoot(req) {
  return req.cpbHubRoot || resolveHubRoot(req.cpbRoot);
}

export async function hubRoutes(fastify) {
  fastify.get("/hub/status", async (req) => {
    const base = await hubStatus(hubRoot(req));
    return req.hubRuntime ? { ...base, runtime: req.hubRuntime.status() } : base;
  });

  fastify.get("/hub/acp", async (req) => {
    const pool = getManagedAcpPool({ hubRoot: hubRoot(req), cpbRoot: req.cpbRoot });
    return {
      ...pool.status(),
      rateLimits: await pool.readDurableRateLimits(),
    };
  });

  fastify.get("/hub/projects", async (req) => {
    const projects = await listProjects(hubRoot(req), { enabledOnly: req.query.enabledOnly === "true" });
    return projects.map((project) => ({ ...project, workerDerivedStatus: workerStatus(project) }));
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
    return project;
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

  fastify.get("/hub/roots", async (req) => ({
    hubRoot: hubRoot(req),
    cpbRoot: path.resolve(req.cpbRoot),
  }));

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
    const entry = await dequeueEntry(hubRoot(req));
    if (!entry) throw fastify.httpErrors.notFound("No pending entries in queue");
    const dispatch = await recordDispatch(hubRoot(req), {
      projectId: entry.projectId,
      sourcePath: entry.sourcePath,
      sessionId: entry.sessionId,
      queueEntryId: entry.id,
    });
    return { dequeued: true, entry, dispatch };
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
    return buildObservabilitySummary({
      cpbRoot: req.cpbRoot,
      hubRoot: hubRoot(req),
      acpPool: getManagedAcpPool({ hubRoot: hubRoot(req), cpbRoot: req.cpbRoot }),
    });
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
}
