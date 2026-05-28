import { getWorkspaceMetrics, listWorkspaces, loadWorkspace, createWorkspace, deleteWorkspace } from "../services/workspace-registry.js";

export function workspaceRoutes(fastify, opts, done) {
  // GET /api/workspaces — list all registered workspaces with metrics
  fastify.get("/workspaces", async (req, reply) => {
    const metrics = await getWorkspaceMetrics(req.cpbRoot);
    return metrics;
  });

  // GET /api/workspaces/:name — single workspace details
  fastify.get("/workspaces/:name", async (req, reply) => {
    const workspace = await loadWorkspace(req.cpbRoot, req.params.name);
    if (!workspace) return reply.code(404).send({ error: `Workspace '${req.params.name}' not found` });
    return workspace;
  });

  // POST /api/workspaces — create a new workspace
  fastify.post("/workspaces", async (req, reply) => {
    try {
      const descriptor = req.body;

      // Validate required fields
      if (!descriptor.name) {
        return reply.code(400).send({ error: "name is required" });
      }
      if (!descriptor.command) {
        return reply.code(400).send({ error: "command is required" });
      }
      if (!descriptor.workspace || !descriptor.workspace.type) {
        return reply.code(400).send({ error: "workspace.type is required" });
      }

      const created = await createWorkspace(req.cpbRoot, descriptor);
      return reply.code(201).send(created);
    } catch (e) {
      if (e.message.includes("Invalid")) {
        return reply.code(400).send({ error: e.message });
      }
      throw e;
    }
  });

  // DELETE /api/workspaces/:name — delete a workspace
  fastify.delete("/workspaces/:name", async (req, reply) => {
    const deleted = await deleteWorkspace(req.cpbRoot, req.params.name);
    if (!deleted) return reply.code(404).send({ error: `Workspace '${req.params.name}' not found` });
    return { deleted: true, name: req.params.name };
  });

  done();
}
