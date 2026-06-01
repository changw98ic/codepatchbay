import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultProjectRuntimeRoot, projectRuntimeRoot as resolveProjectRuntimeRoot } from "./runtime-root.js";

const REGISTRY_VERSION = 1;
const SAFE_ID = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const SAFE_GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SAFE_GITHUB_REPO = /^[A-Za-z0-9._-]+$/;
const REGISTRY_LOCK_TTL_MS = 30_000;

export const DEFAULT_GITHUB_TRIGGERS = [
  { event: "issues.labeled", label: "sdd", workflow: "sdd-standard", planMode: "parent" },
  { event: "issues.labeled", label: "cpb", workflow: "standard" },
  { event: "issue_comment.created", command: "/cpb run", workflow: "standard" },
];

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

async function registryLockIsStale(lockDir) {
  const now = Date.now();
  try {
    const raw = await readFile(path.join(lockDir, "lock.json"), "utf8");
    const lock = JSON.parse(raw);
    const acquiredAt = new Date(lock.acquiredAt).getTime();
    return Number.isNaN(acquiredAt) || now - acquiredAt >= REGISTRY_LOCK_TTL_MS;
  } catch {
    try {
      const info = await stat(lockDir);
      return now - info.mtimeMs >= REGISTRY_LOCK_TTL_MS;
    } catch {
      return false;
    }
  }
}

async function withRegistryLock(hubRoot, callback) {
  const file = registryPath(hubRoot);
  const lockDir = `${file}.lock`;
  await mkdir(path.dirname(file), { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, "lock.json"),
        `${JSON.stringify({ acquiredAt: nowIso(), ownerPid: process.pid }, null, 2)}\n`,
        "utf8",
      );
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      if (await registryLockIsStale(lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  if (!acquired) {
    throw new Error(`registry lock busy: ${path.basename(file)}`);
  }

  try {
    return await callback();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
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
  return await withRegistryLock(hubRoot, async () => {
    const registry = await loadRegistry(hubRoot);
    const id = resolveProjectId(registry, input.id || input.name, sourcePath);
    const existing = registry.projects[id] || {};
    const timestamp = nowIso();
    const projectRoot = input.projectRoot ? path.resolve(input.projectRoot) : path.join(sourcePath, "cpb-task");

    const projectRuntimeRoot = input.projectRuntimeRoot
      ? path.resolve(input.projectRuntimeRoot)
      : existing.projectRuntimeRoot || resolveProjectRuntimeRoot(hubRoot, id);

    const project = {
      ...existing,
      id,
      name: input.name || existing.name || id,
      sourcePath,
      projectRoot,
      projectRuntimeRoot,
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
  });
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

export function parseGithubRepo(value) {
  const input = String(value || "").trim();
  const parts = input.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("invalid GitHub repo: expected owner/repo");
  }

  const [owner, repo] = parts;
  if (!SAFE_GITHUB_OWNER.test(owner)) {
    throw new Error(`invalid GitHub repo owner: ${owner}`);
  }
  if (!SAFE_GITHUB_REPO.test(repo) || repo === "." || repo === ".." || repo.endsWith(".git")) {
    throw new Error(`invalid GitHub repo name: ${repo}`);
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

export async function bindProjectGithub(hubRoot, id, repoFullName, { triggers = DEFAULT_GITHUB_TRIGGERS } = {}) {
  if (!SAFE_ID.test(id)) throw new Error(`invalid project id: ${id}`);
  const repo = parseGithubRepo(repoFullName);
  const existing = await getProject(hubRoot, id);
  if (!existing) return null;
  return await updateProject(hubRoot, id, {
    github: {
      ...(existing.github || {}),
      owner: repo.owner,
      repo: repo.repo,
      fullName: repo.fullName,
      triggers: Array.isArray(existing.github?.triggers) ? existing.github.triggers : triggers,
      boundAt: nowIso(),
    },
  });
}

export async function updateProject(hubRoot, id, patch = {}) {
  if (!SAFE_ID.test(id)) throw new Error(`invalid project id: ${id}`);
  return await withRegistryLock(hubRoot, async () => {
    const registry = await loadRegistry(hubRoot);
    const existing = registry.projects[id];
    if (!existing) return null;
    const updated = {
      ...existing,
      ...patch,
      id,
      sourcePath: existing.sourcePath,
      projectRoot: patch.projectRoot ? path.resolve(patch.projectRoot) : existing.projectRoot,
      projectRuntimeRoot: patch.projectRuntimeRoot ? path.resolve(patch.projectRuntimeRoot) : existing.projectRuntimeRoot,
      updatedAt: nowIso(),
    };
    registry.projects[id] = updated;
    await saveRegistry(hubRoot, registry);
    return updated;
  });
}

export async function heartbeatWorker(hubRoot, id, worker = {}) {
  const heartbeat = {
    workerId: worker.workerId || `worker-${process.pid}`,
    pid: worker.pid || process.pid,
    status: worker.status || "online",
    capabilities: Array.isArray(worker.capabilities) ? worker.capabilities : [],
    claimTimeoutMs: worker.claimTimeoutMs ?? undefined,
    lastSeenAt: nowIso(),
  };
  return updateProject(hubRoot, id, { worker: heartbeat });
}

export async function hubStatus(hubRoot) {
  const registry = await loadRegistry(hubRoot);
  const projects = Object.values(registry.projects);
  return {
    hubRoot: path.resolve(hubRoot),
    registryPath: registryPath(hubRoot),
    projectCount: projects.length,
    enabledProjectCount: projects.filter((project) => project.enabled !== false).length,
    updatedAt: registry.updatedAt,
  };
}
