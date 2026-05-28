import { mkdir, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import path from "node:path";

const WORKSPACE_DIR_NAME = "workspaces";
const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export function configDir(cpbRoot) {
  const envOverride = process.env.CPB_WORKSPACE_CONFIG_DIR;
  if (envOverride) return path.resolve(envOverride);
  return path.join(cpbRoot, "cpb-task", WORKSPACE_DIR_NAME);
}

export function validatePathComponent(name, value) {
  if (typeof value !== "string" || !SAFE_NAME.test(value)) {
    throw new Error(`invalid ${name}: "${value}" (must be alphanumeric with hyphens)`);
  }
}

export function validateDescriptor(d) {
  if (!d || typeof d !== "object") {
    throw new Error("descriptor must be an object");
  }
  if (typeof d.name !== "string" || !SAFE_NAME.test(d.name)) {
    throw new Error('descriptor.name must be a valid alphanumeric-hyphen string');
  }
  if (typeof d.command !== "string" || !d.command.trim()) {
    throw new Error('descriptor.command must be a non-empty string');
  }
  if (!d.workspace || typeof d.workspace !== "object") {
    throw new Error('descriptor.workspace must be an object');
  }
  if (typeof d.workspace.type !== "string" || !d.workspace.type.trim()) {
    throw new Error('descriptor.workspace.type must be a non-empty string');
  }
  return true;
}

function descriptorPath(cpbRoot, name) {
  validatePathComponent("name", name);
  const dir = configDir(cpbRoot);
  return path.resolve(dir, `${name}.json`);
}

export async function loadWorkspace(cpbRoot, name) {
  const file = descriptorPath(cpbRoot, name);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    validateDescriptor(parsed);
    return { name, ...parsed };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    // Return null for invalid JSON or validation errors
    return null;
  }
}

export async function listWorkspaces(cpbRoot) {
  const dir = configDir(cpbRoot);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  const workspaces = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const name = entry.name.slice(0, -".json".length);
    if (!SAFE_NAME.test(name)) continue;

    try {
      const workspace = await loadWorkspace(cpbRoot, name);
      if (workspace) workspaces.push(workspace);
    } catch {
      // Skip invalid descriptors
    }
  }
  return workspaces;
}

export async function createWorkspace(cpbRoot, descriptor) {
  validateDescriptor(descriptor);

  const { name } = descriptor;
  const file = descriptorPath(cpbRoot, name);

  // Check for existing workspace
  try {
    await stat(file);
    throw new Error(`workspace already exists: ${name}`);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  // Ensure directory exists
  await mkdir(path.dirname(file), { recursive: true });

  // Write descriptor (merge metadata to preserve user-provided fields)
  const toWrite = {
    ...descriptor,
    metadata: {
      createdAt: new Date().toISOString(),
      ...(descriptor.metadata || {}),
    },
  };
  await writeFile(file, JSON.stringify(toWrite, null, 2), "utf8");

  return loadWorkspace(cpbRoot, name);
}

export async function updateWorkspace(cpbRoot, name, updates) {
  const existing = await loadWorkspace(cpbRoot, name);
  if (!existing) {
    throw new Error(`workspace not found: ${name}`);
  }

  // Merge updates
  const merged = { ...existing, ...updates };
  if (updates.metadata) {
    merged.metadata = { ...existing.metadata, ...updates.metadata };
  }
  merged.metadata.updatedAt = new Date().toISOString();

  // Validate merged descriptor (name is required for validation)
  validateDescriptor(merged);

  const file = descriptorPath(cpbRoot, name);
  await writeFile(file, JSON.stringify(merged, null, 2), "utf8");

  return loadWorkspace(cpbRoot, name);
}

export async function deleteWorkspace(cpbRoot, name) {
  const file = descriptorPath(cpbRoot, name);
  // Check existence first
  const existing = await loadWorkspace(cpbRoot, name);
  if (!existing) {
    return false;
  }
  await rm(file, { force: true });
  return true;
}
