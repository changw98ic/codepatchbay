/**
 * Workspace manager service.
 *
 * Manages workspace configurations and lifecycle.
 * Integrates with the hub registry for project-level workspace settings.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  validateWorkspaceConfig,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  resolveWorkspaceConfig,
  defaultWorkspaceConfig,
} from "../../core/workspace/index.js";
import { getBackend, resolveBackend, healthCheckAll, supportedBackendTypes } from "../../core/workspace/index.js";
import { broadcast } from "./ws-broadcast.js";

// In-memory cache of prepared workspaces
const preparedWorkspaces = new Map();

export function workspacesPath(hubRoot) {
  return path.join(hubRoot, "workspaces");
}

export function workspacePath(hubRoot, workspaceId) {
  return path.join(workspacesPath(hubRoot), `${workspaceId}.json`);
}

export async function listWorkspaces(hubRoot) {
  const dir = workspacesPath(hubRoot);
  try {
    const entries = await readFile(path.join(dir, "index.json"), "utf8");
    return JSON.parse(entries);
  } catch {
    return [];
  }
}

async function writeWorkspaceIndex(hubRoot, workspaces) {
  const dir = workspacesPath(hubRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.json"), JSON.stringify(workspaces, null, 2), "utf8");
}

export async function getWorkspace(hubRoot, workspaceId) {
  const filePath = workspacePath(hubRoot, workspaceId);
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function createWorkspace(hubRoot, config) {
  const { valid, errors } = validateWorkspaceConfig(config);
  if (!valid) return { workspace: null, errors };

  const dir = workspacesPath(hubRoot);
  await mkdir(dir, { recursive: true });

  config.createdAt = new Date().toISOString();
  config.updatedAt = config.createdAt;

  await writeFile(workspacePath(hubRoot, config.id), JSON.stringify(config, null, 2), "utf8");

  const workspaces = await listWorkspaces(hubRoot);
  workspaces.push({
    id: config.id,
    projectId: config.projectId,
    type: config.type,
    createdAt: config.createdAt,
  });
  await writeWorkspaceIndex(hubRoot, workspaces);

  broadcast({ type: "workspace_created", workspace: config });
  return { workspace: config, errors: [] };
}

export async function updateWorkspace(hubRoot, workspaceId, updates) {
  const existing = await getWorkspace(hubRoot, workspaceId);
  if (!existing) return { workspace: null, errors: ["workspace not found"] };

  const merged = { ...existing, ...updates, id: existing.id, updatedAt: new Date().toISOString() };
  const { valid, errors } = validateWorkspaceConfig(merged);
  if (!valid) return { workspace: null, errors };

  await writeFile(workspacePath(hubRoot, workspaceId), JSON.stringify(merged, null, 2), "utf8");

  // Update index
  const workspaces = await listWorkspaces(hubRoot);
  const idx = workspaces.findIndex((w) => w.id === workspaceId);
  if (idx >= 0) {
    workspaces[idx] = { id: merged.id, projectId: merged.projectId, type: merged.type, createdAt: merged.createdAt };
    await writeWorkspaceIndex(hubRoot, workspaces);
  }

  broadcast({ type: "workspace_updated", workspace: merged });
  return { workspace: merged, errors: [] };
}

export async function deleteWorkspace(hubRoot, workspaceId) {
  const existing = await getWorkspace(hubRoot, workspaceId);
  if (!existing) return { deleted: false, errors: ["workspace not found"] };

  // Teardown if prepared
  if (preparedWorkspaces.has(workspaceId)) {
    await teardownWorkspace(hubRoot, workspaceId);
  }

  await rm(workspacePath(hubRoot, workspaceId)).catch(() => {});

  const workspaces = await listWorkspaces(hubRoot);
  const filtered = workspaces.filter((w) => w.id !== workspaceId);
  await writeWorkspaceIndex(hubRoot, filtered);

  broadcast({ type: "workspace_deleted", workspaceId });
  return { deleted: true, errors: [] };
}

export async function prepareWorkspace(hubRoot, workspaceId, { sourcePath } = {}) {
  const config = await getWorkspace(hubRoot, workspaceId);
  if (!config) return { status: "error", error: "workspace not found" };

  const backend = await resolveBackend(config);

  // Tear down previous preparation if exists
  if (preparedWorkspaces.has(workspaceId)) {
    await backend.teardown(config, preparedWorkspaces.get(workspaceId)).catch(() => {});
  }

  broadcast({ type: "workspace_preparing", workspaceId });
  const result = await backend.prepare(config, { sourcePath });

  if (result.status === "ready") {
    preparedWorkspaces.set(workspaceId, result);
    broadcast({ type: "workspace_prepared", workspaceId, result });
  } else {
    broadcast({ type: "workspace_failed", workspaceId, error: result.meta?.error });
  }

  return result;
}

export async function teardownWorkspace(hubRoot, workspaceId) {
  const config = await getWorkspace(hubRoot, workspaceId);
  if (!config) return { status: "error", error: "workspace not found" };

  const prepared = preparedWorkspaces.get(workspaceId);
  if (!prepared) return { status: "not_prepared" };

  const backend = await resolveBackend(config);
  const result = await backend.teardown(config, prepared);
  preparedWorkspaces.delete(workspaceId);

  broadcast({ type: "workspace_teardown", workspaceId });
  return result;
}

export async function workspaceStatus(hubRoot, workspaceId) {
  const config = await getWorkspace(hubRoot, workspaceId);
  if (!config) return { status: "error", error: "workspace not found" };

  const backend = await resolveBackend(config);
  return backend.status(config);
}

export function getPreparedWorkspace(workspaceId) {
  return preparedWorkspaces.get(workspaceId) || null;
}

export async function backendsHealthCheck() {
  return healthCheckAll();
}

export { supportedBackendTypes };
