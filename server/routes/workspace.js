import {
  listWorkspaces,
  loadWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  validateDescriptor,
} from "../services/workspace-registry.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export async function workspaceRoutes(fastify, opts) {

  // List all workspaces
  fastify.get("/workspaces", async (req) => {
    const workspaces = await listWorkspaces(req.cpbRoot);
    return { workspaces, count: workspaces.length };
  });

  // Get single workspace
  fastify.get("/workspaces/:name", async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) {
      throw fastify.httpErrors.badRequest("invalid workspace name");
    }

    const workspace = await loadWorkspace(req.cpbRoot, name);
    if (!workspace) {
      throw fastify.httpErrors.notFound(`workspace not found: ${name}`);
    }

    return workspace;
  });

  // Create workspace
  fastify.post("/workspaces", async (req, reply) => {
    const body = req.body || {};

    // Validate required fields
    if (!body.name || typeof body.name !== "string") {
      throw fastify.httpErrors.badRequest("name is required");
    }
    if (!body.command || typeof body.command !== "string") {
      throw fastify.httpErrors.badRequest("command is required");
    }
    if (!body.workspace || typeof body.workspace !== "object") {
      throw fastify.httpErrors.badRequest("workspace config is required");
    }
    if (!body.workspace.type || typeof body.workspace.type !== "string") {
      throw fastify.httpErrors.badRequest("workspace.type is required");
    }

    // Validate name format
    if (!SAFE_NAME.test(body.name)) {
      throw fastify.httpErrors.badRequest("name must be alphanumeric with hyphens");
    }

    // Build descriptor
    const descriptor = {
      name: body.name,
      command: body.command,
      args: body.args || [],
      env: body.env || {},
      workspace: body.workspace,
      metadata: body.metadata || {},
    };

    try {
      validateDescriptor(descriptor);
    } catch (err) {
      throw fastify.httpErrors.badRequest(err.message);
    }

    try {
      const workspace = await createWorkspace(req.cpbRoot, descriptor);
      return reply.code(201).send(workspace);
    } catch (err) {
      if (err.message.includes("already exists")) {
        throw fastify.httpErrors.conflict(err.message);
      }
      throw fastify.httpErrors.internalServerError(err.message);
    }
  });

  // Update workspace
  fastify.patch("/workspaces/:name", async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) {
      throw fastify.httpErrors.badRequest("invalid workspace name");
    }

    const updates = req.body || {};
    // Remove immutable fields from updates
    delete updates.name;

    try {
      const workspace = await updateWorkspace(req.cpbRoot, name, updates);
      return workspace;
    } catch (err) {
      if (err.message.includes("not found")) {
        throw fastify.httpErrors.notFound(err.message);
      }
      throw fastify.httpErrors.badRequest(err.message);
    }
  });

  // Delete workspace
  fastify.delete("/workspaces/:name", async (req) => {
    const { name } = req.params;
    if (!SAFE_NAME.test(name)) {
      throw fastify.httpErrors.badRequest("invalid workspace name");
    }

    const deleted = await deleteWorkspace(req.cpbRoot, name);
    if (!deleted) {
      throw fastify.httpErrors.notFound(`workspace not found: ${name}`);
    }

    return { deleted: true, name };
  });
}
