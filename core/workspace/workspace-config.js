/**
 * Workspace configuration resolution.
 *
 * Reads workspace config from project settings, falls back to local.
 * Config is stored in project runtime root: {projectRoot}/workspace.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { validateWorkspaceConfig } from "./workspace-contract.js";

const CONFIG_FILENAME = "workspace.json";

export function defaultWorkspaceConfig(projectId) {
  return {
    id: `${projectId}-default`,
    projectId,
    type: "local",
    cwd: null,
    env: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function workspaceConfigPath(runtimeRoot) {
  return path.join(runtimeRoot, CONFIG_FILENAME);
}

export async function loadWorkspaceConfig(runtimeRoot) {
  const filePath = workspaceConfigPath(runtimeRoot);
  try {
    const raw = await readFile(filePath, "utf8");
    const config = JSON.parse(raw);
    const { valid, errors } = validateWorkspaceConfig(config);
    if (!valid) {
      return { config: null, errors };
    }
    return { config, errors: [] };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { config: null, errors: [] };
    }
    return { config: null, errors: [err.message] };
  }
}

export async function saveWorkspaceConfig(runtimeRoot, config) {
  const { valid, errors } = validateWorkspaceConfig(config);
  if (!valid) {
    return { saved: false, errors };
  }

  const filePath = workspaceConfigPath(runtimeRoot);
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  config.updatedAt = new Date().toISOString();
  await writeFile(filePath, JSON.stringify(config, null, 2), "utf8");
  return { saved: true, errors: [] };
}

export async function resolveWorkspaceConfig(runtimeRoot, projectId) {
  const { config } = await loadWorkspaceConfig(runtimeRoot);
  if (config) return config;

  const defaults = defaultWorkspaceConfig(projectId);
  await saveWorkspaceConfig(runtimeRoot, defaults);
  return defaults;
}

export function mergeWorkspaceEnv(baseEnv, workspaceEnv) {
  if (!workspaceEnv || typeof workspaceEnv !== "object") return baseEnv;
  return { ...baseEnv, ...workspaceEnv };
}
