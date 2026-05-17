import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  shouldUseRustRuntime,
  upsertRegistryProject,
} from "./runtime-cli.js";

const REGISTRY_VERSION = 1;
const SAFE_ID = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export function resolveHubRoot(cpbRoot = process.cwd()) {
  if (process.env.CPB_HUB_ROOT) return path.resolve(process.env.CPB_HUB_ROOT);
  const home = os.homedir();
  return home ? path.join(home, ".cpb") : path.join(path.resolve(cpbRoot), ".cpb", "hub");
}

export function registryPath(hubRoot) {
  return path.join(path.resolve(hubRoot), "projects.json");
}

export function defaultRegistry() {
  return {
    version: REGISTRY_VERSION,
    updatedAt: new Date(0).toISOString(),
    projects: {},
  };
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(value, fallback = "project") {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return SAFE_ID.test(slug) ? slug : fallback;
}

function pathHash(sourcePath) {
  return createHash("sha256").update(sourcePath).digest("hex").slice(0, 8);
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

async function canonicalSourcePath(sourcePath) {
  if (!sourcePath || typeof sourcePath !== "string") {
    throw new Error("sourcePath is required");
  }
  const resolved = path.resolve(sourcePath);
  const canonical = await realpath(resolved);
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new Error(`sourcePath is not a directory: ${sourcePath}`);
  }
  return canonical;
}

function normalizeRegistry(raw) {
  const registry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : defaultRegistry();
  return {
    version: registry.version || REGISTRY_VERSION,
    updatedAt: registry.updatedAt || new Date(0).toISOString(),
    projects: registry.projects && typeof registry.projects === "object" && !Array.isArray(registry.projects)
      ? registry.projects
      : {},
  };
}

export async function loadRegistry(hubRoot) {
  try {
    const raw = await readFile(registryPath(hubRoot), "utf8");
    return normalizeRegistry(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === "ENOENT") return defaultRegistry();
    throw err;
  }
}

export async function saveRegistry(hubRoot, registry) {
  const normalized = normalizeRegistry(registry);
  normalized.version = REGISTRY_VERSION;
  normalized.updatedAt = nowIso();
  if (shouldUseRustRuntime()) {
    try {
      for (const project of Object.values(normalized.projects)) {
        await upsertRegistryProject(hubRoot, project);
      }
      return await loadRegistry(hubRoot);
    } catch {
      // Fall back to the JS writer. Rust runtime is opt-in during migration and
      // must not strand users if the local binary is missing or stale.
    }
  }
  await writeAtomic(registryPath(hubRoot), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function resolveProjectId(registry, preferredId, sourcePath) {
  const existing = Object.values(registry.projects).find((project) => project.sourcePath === sourcePath);
  if (existing?.id) return existing.id;

  const base = slugify(preferredId || path.basename(sourcePath));
  const current = registry.projects[base];
  if (!current || current.sourcePath === sourcePath) return base;
  return `${base}-${pathHash(sourcePath)}`;
}

export async function registerProject(hubRoot, input = {}) {
  const sourcePath = await canonicalSourcePath(input.sourcePath || process.cwd());
  const registry = await loadRegistry(hubRoot);
  const id = resolveProjectId(registry, input.id || input.name, sourcePath);
  const existing = registry.projects[id] || {};
  const timestamp = nowIso();
  const projectRoot = input.projectRoot ? path.resolve(input.projectRoot) : path.join(sourcePath, "cpb-task");

  const project = {
    ...existing,
    id,
    name: input.name || existing.name || id,
    sourcePath,
    projectRoot,
    enabled: input.enabled ?? existing.enabled ?? true,
    weight: Number.isFinite(Number(input.weight)) ? Number(input.weight) : existing.weight ?? 1,
    createdAt: existing.createdAt || timestamp,
    updatedAt: timestamp,
    metadata: {
      ...(existing.metadata || {}),
      ...(input.metadata || {}),
    },
  };

  registry.projects[id] = project;
  await saveRegistry(hubRoot, registry);
  return project;
}

export async function listProjects(hubRoot, { enabledOnly = false } = {}) {
  const registry = await loadRegistry(hubRoot);
  return Object.values(registry.projects)
    .filter((project) => !enabledOnly || project.enabled !== false)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getProject(hubRoot, id) {
  const registry = await loadRegistry(hubRoot);
  return registry.projects[id] || null;
}

export async function updateProject(hubRoot, id, patch = {}) {
  if (!SAFE_ID.test(id)) throw new Error(`invalid project id: ${id}`);
  const registry = await loadRegistry(hubRoot);
  const existing = registry.projects[id];
  if (!existing) return null;
  const updated = {
    ...existing,
    ...patch,
    id,
    sourcePath: existing.sourcePath,
    projectRoot: patch.projectRoot ? path.resolve(patch.projectRoot) : existing.projectRoot,
    updatedAt: nowIso(),
  };
  registry.projects[id] = updated;
  await saveRegistry(hubRoot, registry);
  return updated;
}

const DEFAULT_WORKER_TTL = 120_000;

export function workerStatus(project, ttlMs = DEFAULT_WORKER_TTL) {
  if (!project.worker || !project.worker.lastSeenAt) return "offline";
  const age = Date.now() - new Date(project.worker.lastSeenAt).getTime();
  return age <= ttlMs ? "online" : "stale";
}

export async function heartbeatWorker(hubRoot, id, worker = {}) {
  const heartbeat = {
    workerId: worker.workerId || `worker-${process.pid}`,
    pid: worker.pid || process.pid,
    status: worker.status || "online",
    capabilities: Array.isArray(worker.capabilities) ? worker.capabilities : [],
    lastSeenAt: nowIso(),
  };
  return updateProject(hubRoot, id, { worker: heartbeat });
}

export async function hubStatus(hubRoot, { workerTtl = DEFAULT_WORKER_TTL } = {}) {
  const registry = await loadRegistry(hubRoot);
  const projects = Object.values(registry.projects);
  const statusCounts = { online: 0, stale: 0, offline: 0 };
  for (const project of projects) {
    statusCounts[workerStatus(project, workerTtl)]++;
  }
  return {
    hubRoot: path.resolve(hubRoot),
    registryPath: registryPath(hubRoot),
    projectCount: projects.length,
    enabledProjectCount: projects.filter((project) => project.enabled !== false).length,
    workersOnline: statusCounts.online,
    workersStale: statusCounts.stale,
    workersOffline: statusCounts.offline,
    workerCount: statusCounts.online,
    updatedAt: registry.updatedAt,
  };
}
