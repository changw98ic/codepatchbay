import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

function configDir(cpbRoot) {
  return process.env.CPB_WORKSPACE_CONFIG_DIR || path.join(cpbRoot, "cpb-task", "workspaces");
}

function validateDescriptor(d) {
  if (!d || typeof d !== "object") return false;
  if (typeof d.name !== "string" || !d.name) return false;
  if (typeof d.command !== "string" || !d.command) return false;
  if (!d.workspace || typeof d.workspace.type !== "string") return false;
  return true;
}

export async function loadWorkspace(cpbRoot, name) {
  const dir = configDir(cpbRoot);
  const filePath = path.join(dir, `${name}.json`);

  if (!existsSync(filePath)) return null;

  try {
    const content = await readFile(filePath, "utf8");
    const descriptor = JSON.parse(content);
    if (validateDescriptor(descriptor)) {
      return descriptor;
    }
    return null;
  } catch {
    return null;
  }
}

export async function listWorkspaces(cpbRoot) {
  const dir = configDir(cpbRoot);
  const workspaces = [];

  try {
    const files = await readdir(dir);
    const workspaceFiles = files.filter((f) => f.endsWith(".json"));

    for (const f of workspaceFiles) {
      const content = await readFile(path.join(dir, f), "utf8");
      try {
        const descriptor = JSON.parse(content);
        if (validateDescriptor(descriptor)) {
          workspaces.push(descriptor);
        }
      } catch {
        // Skip invalid descriptors
      }
    }
  } catch {
    // Directory doesn't exist yet
  }

  return workspaces;
}

export async function createWorkspace(cpbRoot, descriptor) {
  if (!validateDescriptor(descriptor)) {
    throw new Error("Invalid workspace descriptor");
  }

  const dir = configDir(cpbRoot);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${descriptor.name}.json`);
  await writeFile(filePath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");

  return descriptor;
}

export async function updateWorkspace(cpbRoot, name, updates) {
  const existing = await loadWorkspace(cpbRoot, name);
  if (!existing) {
    throw new Error(`Workspace '${name}' not found`);
  }

  const updated = { ...existing, ...updates };
  if (!validateDescriptor(updated)) {
    throw new Error("Invalid workspace descriptor after update");
  }

  const dir = configDir(cpbRoot);
  const filePath = path.join(dir, `${name}.json`);
  await writeFile(filePath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");

  return updated;
}

export async function deleteWorkspace(cpbRoot, name) {
  const dir = configDir(cpbRoot);
  const filePath = path.join(dir, `${name}.json`);

  if (!existsSync(filePath)) {
    return false;
  }

  await rm(filePath);
  return true;
}

export async function getWorkspaceMetrics(cpbRoot) {
  const workspaces = await listWorkspaces(cpbRoot);
  const metrics = {
    total: workspaces.length,
    byType: { ssh: 0, devcontainer: 0 },
    byStability: { stable: 0, experimental: 0, discovered: 0 },
    details: workspaces.map((w) => ({
      name: w.name,
      displayName: w.displayName,
      type: w.workspace?.type,
      stability: w.stability,
      command: w.command,
    })),
  };

  for (const w of workspaces) {
    const type = w.workspace?.type;
    if (type && metrics.byType[type] !== undefined) {
      metrics.byType[type]++;
    }
    const stability = w.stability || "unknown";
    if (metrics.byStability[stability] !== undefined) {
      metrics.byStability[stability]++;
    }
  }

  return metrics;
}
