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
import { knowledgePolicySummary } from "../services/knowledge-policy.js";
import {
  promoteKnowledge,
  writePromotionCandidate,
} from "../services/knowledge-promotion.js";
import { getManagedAcpPool } from "../services/acp-pool-runtime.js";
import { buildDiagnosticBundle } from "../services/observability.js";
import {
  dequeue as dequeueEntry,
  enqueue,
  listQueue,
  queueStatus,
  updateEntry,
} from "../services/hub-queue.js";

function hubRoot(req) {
  return req.cpbHubRoot || resolveHubRoot(req.cpbRoot);
}

export async function hubRoutes(fastify) {
  fastify.get("/hub/status", async (req) => {
    return hubStatus(hubRoot(req));
  });

  fastify.get("/hub/acp", async (req) => {
    const pool = getManagedAcpPool({ cpbRoot: req.cpbRoot, hubRoot: hubRoot(req) });
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

  fastify.post("/hub/knowledge/candidates", async (req) => {
    const candidate = await writePromotionCandidate(req.body || {});
    return { created: true, candidate };
  });

  fastify.post("/hub/knowledge/promote", async (req) => {
    const promotion = await promoteKnowledge({
      hubRoot: hubRoot(req),
      ...(req.body || {}),
    });
    return { promoted: true, promotion };
  });

  fastify.get("/hub/roots", async (req) => ({
    hubRoot: hubRoot(req),
    cpbRoot: path.resolve(req.cpbRoot),
  }));

  fastify.get("/hub/diagnostics", async (req) => buildDiagnosticBundle({
    cpbRoot: req.cpbRoot,
    hubRoot: hubRoot(req),
    acpPool: getManagedAcpPool({ cpbRoot: req.cpbRoot, hubRoot: hubRoot(req) }),
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
    return { dequeued: true, entry };
  });

  fastify.patch("/hub/queue/:entryId", async (req) => {
    const updated = await updateEntry(hubRoot(req), req.params.entryId, req.body || {});
    if (!updated) throw fastify.httpErrors.notFound(`Queue entry '${req.params.entryId}' not found`);
    return updated;
  });
}
