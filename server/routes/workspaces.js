/**
 * Workspace API routes.
 *
 * CRUD + lifecycle operations for workspace configurations.
 */

import {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  prepareWorkspace,
  teardownWorkspace,
  workspaceStatus,
  backendsHealthCheck,
  supportedBackendTypes,
} from "../services/workspace-manager.js";

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export async function workspaceRoutes(fastify, opts) {
  // Validate workspace ID param
  fastify.addHook("preHandler", (req, _res, done) => {
    const { workspaceId } = req.params;
    if (workspaceId && !SAFE_ID.test(workspaceId)) {
      return done(fastify.httpErrors.badRequest("Invalid workspace ID"));
    }
    done();
  });

  // List all workspaces
  fastify.get("/workspaces", async (req) => {
    return listWorkspaces(req.cpbHubRoot);
  });

  // List available backend types
  fastify.get("/workspaces/backends", async () => {
    return { types: supportedBackendTypes() };
  });

  // Health check all backends
  fastify.get("/workspaces/health", async () => {
    return backendsHealthCheck();
  });

  // Get workspace details
  fastify.get("/workspaces/:workspaceId", async (req) => {
    const { workspaceId } = req.params;
    const workspace = await getWorkspace(req.cpbHubRoot, workspaceId);
    if (!workspace) throw fastify.httpErrors.notFound(`Workspace '${workspaceId}' not found`);
    return workspace;
  });

  // Create workspace
  fastify.post("/workspaces", async (req) => {
    const body = req.body || {};

    const config = {
      id: body.id,
      projectId: body.projectId,
      type: body.type || "local",
      // Backend-specific fields
      image: body.image,
      dockerfile: body.dockerfile,
      workdir: body.workdir,
      host: body.host,
      user: body.user,
      port: body.port,
      identityFile: body.identityFile,
      workspacePath: body.workspacePath,
      configPath: body.configPath,
      sourcePath: body.sourcePath,
      cwd: body.cwd,
      env: body.env || {},
      memory: body.memory,
      cpus: body.cpus,
      networkMode: body.networkMode,
      keepContainer: body.keepContainer || false,
      strictHostKeyChecking: body.strictHostKeyChecking,
      connectTimeout: body.connectTimeout,
      sshConfig: body.sshConfig,
    };

    const result = await createWorkspace(req.cpbHubRoot, config);
    if (result.errors.length > 0) {
      throw fastify.httpErrors.badRequest(result.errors.join("; "));
    }
    return result.workspace;
  });

  // Update workspace
  fastify.put("/workspaces/:workspaceId", async (req) => {
    const { workspaceId } = req.params;
    const body = req.body || {};

    // Don't allow ID change
    const updates = { ...body };
    delete updates.id;
    delete updates.createdAt;

    const result = await updateWorkspace(req.cpbHubRoot, workspaceId, updates);
    if (result.errors.length > 0) {
      if (result.errors[0] === "workspace not found") {
        throw fastify.httpErrors.notFound(`Workspace '${workspaceId}' not found`);
      }
      throw fastify.httpErrors.badRequest(result.errors.join("; "));
    }
    return result.workspace;
  });

  // Delete workspace
  fastify.delete("/workspaces/:workspaceId", async (req) => {
    const { workspaceId } = req.params;
    const result = await deleteWorkspace(req.cpbHubRoot, workspaceId);
    if (!result.deleted) {
      throw fastify.httpErrors.notFound(`Workspace '${workspaceId}' not found`);
    }
    return { deleted: true };
  });

  // Prepare workspace (create container / verify SSH / etc.)
  fastify.post("/workspaces/:workspaceId/prepare", async (req) => {
    const { workspaceId } = req.params;
    const body = req.body || {};
    const result = await prepareWorkspace(req.cpbHubRoot, workspaceId, {
      sourcePath: body.sourcePath,
    });
    if (result.error && result.error === "workspace not found") {
      throw fastify.httpErrors.notFound(`Workspace '${workspaceId}' not found`);
    }
    return result;
  });

  // Teardown workspace
  fastify.post("/workspaces/:workspaceId/teardown", async (req) => {
    const { workspaceId } = req.params;
    const result = await teardownWorkspace(req.cpbHubRoot, workspaceId);
    if (result.error && result.error === "workspace not found") {
      throw fastify.httpErrors.notFound(`Workspace '${workspaceId}' not found`);
    }
    return result;
  });

  // Get workspace status
  fastify.get("/workspaces/:workspaceId/status", async (req) => {
    const { workspaceId } = req.params;
    const result = await workspaceStatus(req.cpbHubRoot, workspaceId);
    if (result.error && result.error === "workspace not found") {
      throw fastify.httpErrors.notFound(`Workspace '${workspaceId}' not found`);
    }
    return result;
  });

  // Get workspace status for a project (resolve from project config)
  fastify.get("/workspaces/project/:projectName", async (req) => {
    const { projectName } = req.params;
    const workspaces = await listWorkspaces(req.cpbHubRoot);
    return workspaces.filter((w) => w.projectId === projectName);
  });
}
