/**
 * hub-registry.ts — merged from:
 *   server/services/hub-registry.ts
 *   server/services/hub-runtime.ts
 *   server/services/hub-cli.ts
 *   server/services/attention-projection.ts
 */

// ─── hub-registry.ts ────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultProjectRuntimeRoot, projectRuntimeRoot as resolveProjectRuntimeRoot } from "../runtime.js";
import { generateProjectCapabilityMaps } from "../project/project-index.js";

const REGISTRY_VERSION = 1;
const SAFE_ID = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const SAFE_GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SAFE_GITHUB_REPO = /^[A-Za-z0-9._-]+$/;
const REGISTRY_LOCK_TTL_MS = 30_000;


export const DEFAULT_GITHUB_TRIGGERS = [
  { event: "issues.labeled", label: "cpb", workflow: "standard" },
  { event: "issue_comment.created", command: "/cpb run", workflow: "standard" },
];

export function resolveHubRoot(cpbRoot = process.cwd()) {
  if (process.env.CPB_HUB_ROOT) return path.resolve(process.env.CPB_HUB_ROOT);
  const home = os.homedir();
  return home ? path.join(home, ".cpb") : path.join(path.resolve(cpbRoot), ".cpb", "hub");
}

export function registryPath(hubRoot: string) {
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

function slugify(value: unknown, fallback = "project") {
  const slug = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return SAFE_ID.test(slug) ? slug : fallback;
}

function pathHash(sourcePath: string) {
  return createHash("sha256").update(sourcePath).digest("hex").slice(0, 8);
}

async function writeAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

async function registryLockIsStale(lockDir: string) {
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

async function withRegistryLock(hubRoot: string, callback: () => Promise<any>) {
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

async function canonicalSourcePath(sourcePath: string) {
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

function normalizeRegistry(raw: AnyRecord) {
  const registry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : defaultRegistry();
  return {
    version: registry.version || REGISTRY_VERSION,
    updatedAt: registry.updatedAt || new Date(0).toISOString(),
    projects: registry.projects && typeof registry.projects === "object" && !Array.isArray(registry.projects)
      ? registry.projects
      : {},
  };
}

export async function loadRegistry(hubRoot: string) {
  try {
    const raw = await readFile(registryPath(hubRoot), "utf8");
    return normalizeRegistry(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === "ENOENT") return defaultRegistry();
    throw err;
  }
}

export async function saveRegistry(hubRoot: string, registry: AnyRecord) {
  const normalized = normalizeRegistry(registry);
  normalized.version = REGISTRY_VERSION;
  normalized.updatedAt = nowIso();
  await writeAtomic(registryPath(hubRoot), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function resolveProjectId(registry: AnyRecord, preferredId: string, sourcePath: string) {
  const existing = (Object.values(registry.projects) as AnyRecord[]).find((project) => project.sourcePath === sourcePath);
  if (existing?.id) return existing.id;

  const base = slugify(preferredId || path.basename(sourcePath));
  const current = registry.projects[base];
  if (!current || current.sourcePath === sourcePath) return base;
  return `${base}-${pathHash(sourcePath)}`;
}

function isPathInsideOrEqual(parentPath: string, childPath: string) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateProjectRuntimeRoot(hubRoot: string, id: string, projectRuntimeRoot: string) {
  const expectedRoot = resolveProjectRuntimeRoot(hubRoot, id);
  const resolvedRoot = path.resolve(projectRuntimeRoot);
  if (!isPathInsideOrEqual(expectedRoot, resolvedRoot)) {
    throw new Error(`invalid projectRuntimeRoot: expected path under ${expectedRoot}`);
  }
  return resolvedRoot;
}

export async function registerProject(hubRoot: string, input: AnyRecord = {}) {
  const sourcePath = await canonicalSourcePath(input.sourcePath || process.cwd());
  const generatedMetadata = input.skipCodeGraphGate
    ? {}
    : await generateProjectCapabilityMaps({
      cpbRoot: input.cpbRoot || sourcePath,
      sourcePath,
    });
  return await withRegistryLock(hubRoot, async () => {
    const registry = await loadRegistry(hubRoot);
    const id = resolveProjectId(registry, input.id || input.name, sourcePath);
    const existing = registry.projects[id] || {};
    const timestamp = nowIso();
    const projectRoot = input.projectRoot ? path.resolve(input.projectRoot) : path.join(sourcePath, "cpb-task");

    const projectRuntimeRoot = input.projectRuntimeRoot
      ? validateProjectRuntimeRoot(hubRoot, id, input.projectRuntimeRoot)
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
        ...generatedMetadata,
      },
    };

    registry.projects[id] = project;
    await saveRegistry(hubRoot, registry);
    return project;
  });
}

export async function listProjects(hubRoot: string, { enabledOnly = false }: AnyRecord = {}) {
  const registry = await loadRegistry(hubRoot);
  return (Object.values(registry.projects) as AnyRecord[])
    .filter((project) => !enabledOnly || project.enabled !== false)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function getProject(hubRoot: string, id: string) {
  const registry = await loadRegistry(hubRoot);
  return registry.projects[id] || null;
}

export function parseGithubRepo(value: string) {
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

export async function bindProjectGithub(hubRoot: string, id: string, repoFullName: string, { triggers = DEFAULT_GITHUB_TRIGGERS }: AnyRecord = {}) {
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

export async function updateProject(hubRoot: string, id: string, patch: AnyRecord = {}) {
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
      projectRuntimeRoot: patch.projectRuntimeRoot ? validateProjectRuntimeRoot(hubRoot, id, patch.projectRuntimeRoot) : existing.projectRuntimeRoot,
      updatedAt: nowIso(),
    };
    registry.projects[id] = updated;
    await saveRegistry(hubRoot, registry);
    return updated;
  });
}

export async function heartbeatWorker(hubRoot: string, id: string, worker: AnyRecord = {}) {
  const heartbeat = {
    workerId: worker.workerId || `worker-${process.pid}`,
    pid: worker.pid || process.pid,
    status: worker.status || "online",
    capabilities: Array.isArray(worker.capabilities) ? worker.capabilities : [],
    claimTimeoutMs: worker.claimTimeoutMs ?? undefined,
    lastSeenAt: nowIso(),
  };
  const project = await updateProject(hubRoot, id, { worker: heartbeat });
  const actions: AnyRecord[] = [];
  if (project && project.shutdownRequested) {
    actions.push({ action: "stop", reason: "shutdown_requested" });
  }
  return { project, actions };
}

export function deriveWorkerStatus(worker: AnyRecord) {
  const status = worker?.status || null;
  if (!status) return "offline";
  if (["online", "idle", "busy", "ready", "running", "starting"].includes(status)) return "online";
  if (["stale", "unhealthy"].includes(status)) return "stale";
  if (["offline", "exited"].includes(status)) return "offline";
  return status;
}

function summarizeProjectWorkers(projects: AnyRecord[]) {
  const summary = {
    workersOnline: 0,
    workersStale: 0,
    workersOffline: 0,
    workersUnknown: 0,
  };
  for (const project of projects) {
    if (!project.worker) continue;
    const derived = deriveWorkerStatus(project.worker);
    if (derived === "online") summary.workersOnline += 1;
    else if (derived === "stale") summary.workersStale += 1;
    else if (derived === "offline") summary.workersOffline += 1;
    else summary.workersUnknown += 1;
  }
  return summary;
}

export async function hubStatus(hubRoot: string) {
  const registry = await loadRegistry(hubRoot);
  const projects = Object.values(registry.projects) as AnyRecord[];
  return {
    hubRoot: path.resolve(hubRoot),
    registryPath: registryPath(hubRoot),
    projectCount: projects.length,
    enabledProjectCount: projects.filter((project) => project.enabled !== false).length,
    ...summarizeProjectWorkers(projects),
    updatedAt: registry.updatedAt,
  };
}

// ─── hub-runtime.ts ─────────────────────────────────────────────────────────

import { openSync, readSync, closeSync, writeSync, fstatSync } from "node:fs";
import { AnyRecord } from "../../../shared/types.js";

const RUNTIME_VERSION = "0.2.0";

const instances = new Map();

function instanceKey(cpbRoot: string, hubRoot: string) {
  return `${path.resolve(cpbRoot)}\0${path.resolve(hubRoot)}`;
}

function buildRuntimeMeta(cpbRoot: string, hubRoot: string) {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cpbRoot: path.resolve(cpbRoot),
    hubRoot: path.resolve(hubRoot),
    version: RUNTIME_VERSION,
    runtime: "node",
    health: "alive",
  };
}

function sameRuntime(a: AnyRecord, b: AnyRecord) {
  return Boolean(
    a &&
    b &&
    a.pid === b.pid &&
    a.startedAt === b.startedAt &&
    path.resolve(a.cpbRoot || "") === path.resolve(b.cpbRoot || "") &&
    path.resolve(a.hubRoot || "") === path.resolve(b.hubRoot || ""),
  );
}

export function getHubRuntime(cpbRoot: string, hubRoot: string) {
  const key = instanceKey(cpbRoot, hubRoot);
  const existing = instances.get(key);
  if (existing) return existing;

  const meta = Object.freeze(buildRuntimeMeta(cpbRoot, hubRoot));
  const statePath = path.join(path.resolve(hubRoot), "state", "hub.json");

  const runtime = {
    ...meta,
    statePath,

    async persist() {
      const current = await readRuntimeState(statePath);
      if (current && !sameRuntime(current, meta) && current.health !== "dead" && isPidAlive(current.pid)) {
        return { ...current, statePath, skipped: "live-owner-present" };
      }
      await writeAtomic(statePath, `${JSON.stringify(meta, null, 2)}\n`);
      return meta;
    },

    status() {
      return { ...meta, statePath };
    },

    async markDead() {
      const current = await readRuntimeState(statePath);
      if (current && !sameRuntime(current, meta) && current.health !== "dead" && isPidAlive(current.pid)) {
        return { ...current, statePath, skipped: "live-owner-present" };
      }
      const deadMeta = { ...meta, health: "dead", stoppedAt: new Date().toISOString() };
      await writeAtomic(statePath, `${JSON.stringify(deadMeta, null, 2)}\n`);
      return deadMeta;
    },
  };

  instances.set(key, runtime);
  return runtime;
}

async function readRuntimeState(statePath: string) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
}

function isPidAlive(pid: number) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but no permission → still alive
    if (err.code === "EPERM") return true;
    return false;
  }
}

export async function readHubLiveness(hubRoot: string) {
  const statePath = path.join(path.resolve(hubRoot), "state", "hub.json");
  let meta = null;
  try {
    const raw = await readFile(statePath, "utf8");
    meta = JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") {
      return { alive: false, reason: "no-hub-json" };
    }
    return { alive: false, reason: "read-error", error: err.message };
  }

  // If hub.json claims alive, verify PID
  if (meta.health !== "dead" && meta.pid) {
    if (isPidAlive(meta.pid)) {
      return { alive: true, pid: meta.pid, startedAt: meta.startedAt, version: meta.version, runtime: meta.runtime };
    }
  }

  // Truly dead
  if (meta.health === "dead") {
    return { alive: false, reason: "shutdown", pid: meta.pid, stoppedAt: meta.stoppedAt, startedAt: meta.startedAt };
  }
  return { alive: false, reason: "process-gone", pid: meta.pid, startedAt: meta.startedAt };
}

export function resetInstances() {
  instances.clear();
}

export { RUNTIME_VERSION };

// ─── hub-cli.ts ─────────────────────────────────────────────────────────────

import { buildChildEnv, buildRuntimeEnv } from "../secret-policy.js";
import { hubConcurrencyEnv, resolveHubConcurrencyLimits } from "../infra.js";

function resolveRoots() {
  const cpbRoot = path.resolve(process.env.CPB_ROOT || ".");
  const executorRoot = path.resolve(process.env.CPB_EXECUTOR_ROOT || cpbRoot);
  const hubRoot = resolveHubRoot(cpbRoot);
  return { cpbRoot, executorRoot, hubRoot };
}

export function buildHubServerEnv(parentEnv = process.env, { cpbRoot, executorRoot, hubRoot, port, host }: AnyRecord = {}) {
  return buildChildEnv(parentEnv, {
    CPB_ROOT: cpbRoot,
    CPB_EXECUTOR_ROOT: executorRoot,
    CPB_HUB_ROOT: hubRoot,
    CPB_PORT: port,
    CPB_HOST: host,
  });
}

export function buildHubInstallEnv(parentEnv = process.env) {
  return buildRuntimeEnv(parentEnv);
}

/**
 * Rotate a log file if it exceeds maxSize by keeping only the last keepSize bytes.
 * Truncates at the first newline boundary to avoid partial lines.
 */
function rotateLogIfNeeded(filePath: string, maxSize = 10 * 1024 * 1024, keepSize = 1024 * 1024) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const info = fstatSync(fd);
    if (info.size <= maxSize) { closeSync(fd); return; }
    const buf = Buffer.alloc(keepSize);
    readSync(fd, buf, 0, keepSize, info.size - keepSize);
    closeSync(fd);
    fd = undefined;
    // Find first newline to avoid partial lines
    const nlIdx = buf.indexOf("\n");
    const trimmed = nlIdx >= 0 ? buf.slice(nlIdx + 1) : buf;
    const wfd = openSync(filePath, "w");
    writeSync(wfd, trimmed);
    closeSync(wfd);
  } catch {
    // File doesn't exist yet or can't be read — that's fine
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

export async function cmdStart() {
  const { cpbRoot, executorRoot, hubRoot } = resolveRoots();

  const liveness = await readHubLiveness(hubRoot);
  if (liveness.alive) {
    console.log(`Hub is already running (pid: ${liveness.pid}).`);
    return;
  }

  try {
    await stat(path.join(executorRoot, "server", "node_modules"));
  } catch {
    console.log("Installing server deps...");
    const { execSync } = await import("node:child_process");
    execSync("npm install --silent", {
      cwd: path.join(executorRoot, "server"),
      env: buildHubInstallEnv(process.env),
      stdio: "pipe",
    });
  }

  const port = process.env.CPB_PORT || "3456";
  const host = process.env.CPB_HOST || "127.0.0.1";
  const configuredEnv = hubConcurrencyEnv(await resolveHubConcurrencyLimits(hubRoot, {
    maxActivePerProject: process.env.CPB_HUB_MAX_ACTIVE_PER_PROJECT,
    acpProviderMax: process.env.CPB_ACP_POOL_PROVIDER_MAX,
  }));
  const hubProcessEnv = { ...process.env, ...configuredEnv };
  await mkdir(hubRoot, { recursive: true });

  const { spawn } = await import("node:child_process");
  rotateLogIfNeeded(path.join(hubRoot, "hub.log"));
  // Rotate worker logs (keep last 5MB)
  try {
    const logsDir = path.join(hubRoot, "logs");
    const logEntries = await readdir(logsDir);
    for (const e of logEntries) {
      if (e.endsWith(".log")) rotateLogIfNeeded(path.join(logsDir, e), 10 * 1024 * 1024, 5 * 1024 * 1024);
    }
  } catch {}
  const logFd = openSync(path.join(hubRoot, "hub.log"), "a");
  const child = spawn(process.execPath, [path.join(executorRoot, "server", "index.js")], {
    cwd: cpbRoot,
    env: buildHubServerEnv(hubProcessEnv, { cpbRoot, executorRoot, hubRoot, port, host }),
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();

  const runtime = getHubRuntime(cpbRoot, hubRoot);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const check = await readHubLiveness(hubRoot);
    if (check.alive) {
      console.log(`Hub started on http://${host}:${port} (pid: ${check.pid})`);
      // Auto-start Hub Orchestrator
      try {
        rotateLogIfNeeded(path.join(hubRoot, "orchestrator.log"));
        const orchLogFd = openSync(path.join(hubRoot, "orchestrator.log"), "a");
        const orchChild = spawn(process.execPath, [
          path.join(executorRoot, "cli", "cpb.js"), "hub-orch", "start",
        ], {
          cwd: cpbRoot,
          env: buildHubServerEnv(hubProcessEnv, { cpbRoot, executorRoot, hubRoot, port, host }),
          detached: true,
          stdio: ["ignore", orchLogFd, orchLogFd],
        });
        orchChild.unref();
        // Persist orchestrator PID for clean shutdown
        await mkdir(path.join(hubRoot, "state"), { recursive: true });
        await writeFile(
          path.join(hubRoot, "state", "orchestrator.json"),
          JSON.stringify({ pid: orchChild.pid, startedAt: new Date().toISOString() }, null, 2) + "\n",
        );
        console.log(`Orchestrator started (pid: ${orchChild.pid})`);
      } catch (e) {
        console.error(`Orchestrator start failed: ${e.message}`);
      }
      // Auto-start Quota Delegate (skip if already running)
      try {
        const { isDelegateAlive } = await import("../quota-delegate-client.js");
        if (await isDelegateAlive(hubRoot)) {
          console.log("Quota delegate already running, skipping start");
        } else {
        rotateLogIfNeeded(path.join(hubRoot, "quota-delegate.log"));
        const delegateLogFd = openSync(path.join(hubRoot, "quota-delegate.log"), "a");
        const delegateChild = spawn(process.execPath, [
          path.join(executorRoot, "server", "services", "quota-delegate.js"),
          "--hub-root", hubRoot,
        ], {
          cwd: cpbRoot,
          env: buildHubServerEnv(hubProcessEnv, { cpbRoot, executorRoot, hubRoot }),
          detached: true,
          stdio: ["ignore", delegateLogFd, delegateLogFd],
        });
        delegateChild.unref();
        console.log(`Quota delegate started (pid: ${delegateChild.pid})`);
        }
      } catch (e) {
        console.error(`Quota delegate start failed: ${e.message}`);
      }
      // CodeGraph auto-start removed (codegraph CLI command removed)
      return;
    }
  }
  console.error(`Hub failed to start within 5 seconds. Check ${path.join(hubRoot, "hub.log")}`);
  process.exit(1);
}

export async function cmdStop() {
  const { cpbRoot, hubRoot } = resolveRoots();

  const liveness = await readHubLiveness(hubRoot);
  if (!liveness.alive) {
    if (liveness.reason === "shutdown") {
      console.log("Hub is not running (graceful shutdown recorded).");
    } else if (liveness.reason === "no-hub-json") {
      console.log("Hub is not running (no state file).");
    } else {
      console.log(`Hub process ${liveness.pid} is not running.`);
    }
    return;
  }

  process.kill(liveness.pid, "SIGTERM");

  // Stop managed workers (from WorkerStore)
  try {
    const { WorkerStore } = await import("../../../shared/orchestrator/worker-store.js");
    const store = new WorkerStore(hubRoot);
    const workers = await store.listWorkers();
    const liveWorkers = workers.filter((w) => w.pid && w.status !== "exited");
    let stopped = 0;
    for (const w of liveWorkers) {
      try { process.kill(w.pid, "SIGTERM"); stopped++; } catch {
        // Process already dead — mark exited immediately
        await store.updateWorker(w.workerId, { status: "exited" });
      }
    }
    if (stopped > 0) console.log(`Managed workers stopped (${stopped})`);

    // Wait for workers to exit (up to 5s), then force-mark stragglers
    if (stopped > 0) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        let allGone = true;
        for (const w of liveWorkers) {
          const cur = await store.getWorker(w.workerId);
          if (cur && cur.status === "exited") continue;
          try { process.kill(w.pid, 0); allGone = false; } catch {
            await store.updateWorker(w.workerId, { status: "exited" });
          }
        }
        if (allGone) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // Mark any stragglers as exited and prune dead workers from registry
    for (const w of liveWorkers) {
      const current = await store.getWorker(w.workerId);
      if (current && current.status !== "exited") {
        try { process.kill(w.pid, 9); } catch {}
        await store.updateWorker(w.workerId, { status: "exited" });
      }
    }
    await store.pruneDead();
  } catch {}

  // Release in_progress queue entries back to failed (workers are gone)
  try {
    const { loadQueue, updateEntry } = await import("../hub/hub-queue.js");
    const queue = await loadQueue(hubRoot);
    let released = 0;
    for (const e of queue.entries) {
      if (e.status === "in_progress") {
        await updateEntry(hubRoot, e.id, {
          status: "failed",
          updatedAt: new Date().toISOString(),
        });
        released++;
      }
    }
    if (released > 0) console.log(`Queue entries released (${released})`);
  } catch {}

  // Flush jobs-index (rebuild from event logs to ensure consistency)
  try {
    const { rebuildJobsIndex } = await import("../job/job-store.js");
    await rebuildJobsIndex(cpbRoot);
    console.log("Jobs index flushed");
  } catch (err) {
    console.error(`Jobs index flush failed: ${err.message}`);
  }

  // Stop orchestrator process by PID (direct SIGTERM, not just lock release)
  try {
    const orchStatePath = path.join(hubRoot, "state", "orchestrator.json");
    const orchState = JSON.parse(await readFile(orchStatePath, "utf8"));
    if (orchState.pid) {
      try { process.kill(orchState.pid, "SIGTERM"); } catch {}
      // Also release leader lock for graceful cleanup
      const { cpbRoot: r1, hubRoot: h1 } = resolveRoots();
      const { HubOrchestrator } = await import("../../orchestrator/hub-orchestrator.js");
      const orch = new HubOrchestrator(h1, r1);
      await orch.stop();
      console.log(`Orchestrator stopped (pid: ${orchState.pid})`);
    }
    await rm(orchStatePath, { force: true });
  } catch {}

  // Stop quota delegate process by PID (from delegate.lock)
  try {
    const delegateLockPath = path.join(hubRoot, "providers", "delegate", "delegate.lock");
    const delegateLock = JSON.parse(await readFile(delegateLockPath, "utf8"));
    if (delegateLock.pid) {
      try { process.kill(delegateLock.pid, "SIGTERM"); } catch {}
      console.log(`Quota delegate stopping (pid: ${delegateLock.pid})`);

      // Wait for process to actually exit (up to 5s)
      const deadline = Date.now() + 5000;
      let exited = false;
      while (Date.now() < deadline) {
        try {
          process.kill(delegateLock.pid, 0);
          await new Promise((r) => setTimeout(r, 100));
        } catch {
          exited = true;
          break;
        }
      }

      if (exited) {
        // Process exited; delegate should have cleaned its lock. Remove if stale.
        await rm(delegateLockPath, { force: true });
        console.log(`Quota delegate stopped (pid: ${delegateLock.pid})`);
      } else {
        console.error(`Quota delegate did not exit within timeout; leaving lock in place`);
      }
    }
  } catch {}

  // CodeGraph auto-stop removed (codegraph CLI command removed)

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(liveness.pid, 0);
    } catch (err) {
      // EPERM: process still alive (just no permission to signal) — keep waiting
      if (err.code === "EPERM") continue;
      console.log(`Hub stopped (was pid: ${liveness.pid}).`);
      return;
    }
  }
  try {
    process.kill(liveness.pid, 9);
  } catch {}
  console.log(`Hub force-stopped (was pid: ${liveness.pid}).`);
}

// ─── attention-projection.ts ────────────────────────────────────────────────

const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const KIND_RANK = {
  jobs_index_divergent: 0,
  stale_runtime: 1,
  codegraph_unavailable: 2,
  agent_rate_limited: 3,
  workflow_failed: 4,
  dag_node_failed: 5,
  waiting_approval: 6,
  review_ready: 7,
};
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };

const CODEGRAPH_CODES = new Set(["codegraph_unavailable", "missing_codegraph_state", "missing_codegraph_index"]);
const RATE_LIMIT_CODES = new Set(["agent_rate_limited", "rate_limited"]);

function priorityRank(priority: string) {
  return (PRIORITY_RANK as Record<string, number>)[priority] ?? 9;
}

function normalizeStatus(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[.\s-]+/g, "_");
}

function normalizeText(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function uniqueKeys(keys: any[]) {
  return [...new Set(keys.filter(Boolean))];
}

function scopedKey(project: string, kind: string, scope: string, id: string) {
  const value = normalizeText(id);
  return value ? `${project || "system"}:${kind}:${scope}:${value}` : null;
}

function workKey(project: string, kind: string, title: string) {
  return scopedKey(project, kind, "work", title);
}

function queueContextIds(sourceContext: AnyRecord) {
  if (!sourceContext || typeof sourceContext !== "object") return [];
  return [
    sourceContext.queueEntryId,
    sourceContext.entryId,
    sourceContext.queue?.entryId,
    sourceContext.previousQueueEntryId,
    sourceContext.retry?.previousQueueEntryId,
    sourceContext.retry?.retryQueueEntryId,
    sourceContext.reviewLoop?.previousQueueEntryId,
    sourceContext.reviewLoop?.retryQueueEntryId,
  ];
}

function queueDedupeKeys(entry: AnyRecord, kind: string, project: string, title: string) {
  const metadata = entry.metadata || {};
  return uniqueKeys([
    scopedKey(project, kind, "queue", entry.id),
    scopedKey(project, kind, "job", metadata.originJobId),
    scopedKey(project, kind, "job", metadata.retryJobId),
    ...queueContextIds(metadata.sourceContext).map((id) => scopedKey(project, kind, "queue", id)),
    workKey(project, kind, title),
  ]);
}

function jobDedupeKeys(job: AnyRecord, kind: string, project: string, title: string) {
  return uniqueKeys([
    scopedKey(project, kind, "job", job.jobId),
    scopedKey(project, kind, "queue", job.queueEntryId),
    ...queueContextIds(job.sourceContext).map((id) => scopedKey(project, kind, "queue", id)),
    workKey(project, kind, title),
  ]);
}

function toIso(value: unknown) {
  if (!value) return null;
  const date = new Date(value as any);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ageMs(updatedAt: unknown) {
  if (!updatedAt) return null;
  const time = new Date(updatedAt as any).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Date.now() - time);
}

function evidence(type: string, id: string, path: string | null = null) {
  return {
    type,
    id: String(id),
    ...(path ? { path } : {}),
  };
}

function text(value: unknown, fallback: string): string {
  const str = String(value || "").trim();
  return str || fallback;
}

function jobReason(job: AnyRecord) {
  return text(
    job.blockedReason || job.failureCause?.reason || job.failureCause?.message || job.lastActivityMessage || job.failureCode,
    "Workflow needs operator attention",
  );
}

function codeForJob(job: AnyRecord) {
  return normalizeStatus(job.failureCode || job.failureCause?.kind || job.failureCause?.code || job.failureCause?.status);
}

function attentionItem({
  kind,
  severity,
  project = null,
  title,
  reason,
  impact,
  updatedAt = null,
  priority = null,
  nextHumanAction,
  primaryEvidenceId,
  dedupeKeys = null,
  evidence: evidenceList,
}: AnyRecord) {
  const normalizedUpdatedAt = toIso(updatedAt);
  return {
    id: `${project || "system"}:${kind}:${primaryEvidenceId}`,
    severity,
    kind,
    project,
    title,
    reason,
    impact,
    ageMs: ageMs(normalizedUpdatedAt),
    updatedAt: normalizedUpdatedAt,
    nextHumanAction,
    evidence: evidenceList,
    _priority: priority || null,
    _primaryEvidenceId: String(primaryEvidenceId),
    _dedupeKeys: uniqueKeys(dedupeKeys || [`${project || "system"}:${kind}:evidence:${primaryEvidenceId}`]),
  };
}

function queueItem(entry: AnyRecord, kind: string, severity: string) {
  const project = entry.projectId || entry.project || null;
  const title = text(entry.description || entry.metadata?.task, "Queued work needs attention");
  const reason = kind === "codegraph_unavailable"
    ? text(entry.metadata?.codegraphReadiness?.reason || entry.metadata?.indexFreshness?.dirtyReasons?.[0], "CodeGraph is unavailable for this queued work")
    : text(entry.metadata?.rateLimitReason || entry.metadata?.reason, "Agent provider rate limit is blocking this queued work");
  const action = kind === "codegraph_unavailable"
    ? { kind: "repair_runtime", label: "Repair runtime", href: "/hub/queue" }
    : { kind: "retry", label: "Retry when capacity is available", href: "/hub/queue" };
  return attentionItem({
    kind,
    severity,
    project,
    title,
    reason,
    impact: "The dispatcher cannot safely start this work until the blocker clears.",
    updatedAt: entry.updatedAt || entry.createdAt,
    priority: entry.priority,
    nextHumanAction: action,
    primaryEvidenceId: entry.id,
    dedupeKeys: queueDedupeKeys(entry, kind, project, title),
    evidence: [evidence("queue", entry.id)],
  });
}

function jobBlockerItem(job: AnyRecord, kind: string, severity: string) {
  const project = job.project || null;
  const title = text(job.task, "Workflow needs attention");
  const action = kind === "codegraph_unavailable"
    ? { kind: "repair_runtime", label: "Repair runtime", href: `/inbox/${job.jobId}` }
    : kind === "agent_rate_limited"
      ? { kind: "retry", label: "Retry when capacity is available", href: `/inbox/${job.jobId}` }
      : { kind: "approve", label: "Review approval gate", href: `/inbox/${job.jobId}` };
  return attentionItem({
    kind,
    severity,
    project,
    title,
    reason: jobReason(job),
    impact: "The workflow cannot continue until this blocker is resolved.",
    updatedAt: job.updatedAt || job.createdAt,
    priority: job.priority,
    nextHumanAction: action,
    primaryEvidenceId: job.jobId,
    dedupeKeys: jobDedupeKeys(job, kind, project, title),
    evidence: [evidence("job", job.jobId, job.eventLogPath)],
  });
}

function workflowFailedItem(job: AnyRecord) {
  return attentionItem({
    kind: "workflow_failed",
    severity: "warning",
    project: job.project || null,
    title: text(job.task, "Workflow failed"),
    reason: jobReason(job),
    impact: "The requested work is stopped until someone reviews the failure and chooses a recovery path.",
    updatedAt: job.updatedAt || job.createdAt,
    priority: job.priority,
    nextHumanAction: { kind: "retry", label: "Review failure and retry or cancel", href: `/inbox/${job.jobId}` },
    primaryEvidenceId: job.jobId,
    evidence: [evidence("job", job.jobId, job.eventLogPath)],
  });
}

function dagNodeFailedItems(job: AnyRecord) {
  const nodeStates = (job.nodeStates || {}) as Record<string, AnyRecord>;
  return Object.entries(nodeStates)
    .filter(([, node]) => node?.status === "failed")
    .map(([nodeId, node]) => attentionItem({
      kind: "dag_node_failed",
      severity: "warning",
      project: job.project || null,
      title: `${text(job.task, "Workflow")} failed at ${node.phase || nodeId}`,
      reason: text(node.reason || node.error || jobReason(job), "DAG node failed"),
      impact: "Downstream workflow nodes are blocked until this node is recovered.",
      updatedAt: node.failedAt || job.updatedAt || job.createdAt,
      priority: job.priority,
      nextHumanAction: { kind: "retry", label: "Review failed node and retry", href: `/inbox/${job.jobId}` },
      primaryEvidenceId: `${job.jobId}:${nodeId}`,
      evidence: [evidence("job", `${job.jobId}:${nodeId}`, job.eventLogPath)],
    }));
}

function reviewReadyItem(session: AnyRecord) {
  return attentionItem({
    kind: "review_ready",
    severity: "info",
    project: session.project || null,
    title: text(session.intent, "Review ready"),
    reason: "A review session is waiting for user review.",
    impact: "The review loop is paused until the patch is approved or rejected.",
    updatedAt: session.updatedAt || session.createdAt,
    priority: session.priority || "P0",
    nextHumanAction: { kind: "approve", label: "Review and approve or reject", href: `/review/${session.sessionId}` },
    primaryEvidenceId: session.sessionId,
    evidence: [evidence("review", session.sessionId)],
  });
}

function runtimeItems(runtimeHealth: AnyRecord) {
  if (!runtimeHealth) return [];
  const items = [];
  const divergence = runtimeHealth.jobsIndexDivergence || {};
  if ((divergence.count || 0) > 0 || ["warning", "blocker"].includes(divergence.severity)) {
    const severity = divergence.severity === "blocker" ? "critical" : "warning";
    items.push(attentionItem({
      kind: "jobs_index_divergent",
      severity,
      title: "Jobs index differs from event log",
      reason: text(divergence.message, `Jobs index divergence count is ${divergence.count ?? "unknown"}.`),
      impact: "Inbox and runtime status can be incomplete until the index is reconciled.",
      nextHumanAction: { kind: "repair_runtime", label: "Reconcile jobs index", href: "/hub/runtime" },
      primaryEvidenceId: "jobs-index",
      evidence: [evidence("runtime_health", "jobs-index")],
    }));
  }

  const staleRuntimeIssue = (runtimeHealth.staleJobs || 0) > 0
    || (runtimeHealth.blockers || []).some((blocker: AnyRecord) => ["release_version_mismatch", "stale_jobs"].includes(blocker?.code));
  if (staleRuntimeIssue) {
    const detail = (runtimeHealth.blockers || []).find((blocker: AnyRecord) => ["release_version_mismatch", "stale_jobs"].includes(blocker?.code));
    items.push(attentionItem({
      kind: "stale_runtime",
      severity: "critical",
      title: "Runtime state needs attention",
      reason: text(detail?.message, `${runtimeHealth.staleJobs || 0} stale runtime job(s) detected.`),
      impact: "Runtime actions may target stale state until the environment is refreshed or repaired.",
      nextHumanAction: { kind: "repair_runtime", label: "Inspect runtime health", href: "/hub/runtime" },
      primaryEvidenceId: "runtime",
      evidence: [evidence("runtime_health", "runtime")],
    }));
  }

  const codegraphCount = runtimeHealth.queueBlockingCounts?.codegraph_unavailable || runtimeHealth.queueBlockingCounts?.codegraphUnavailable || 0;
  if (codegraphCount > 0) {
    items.push(attentionItem({
      kind: "codegraph_unavailable",
      severity: "warning",
      title: "CodeGraph unavailable",
      reason: `${codegraphCount} queued item(s) are blocked by CodeGraph readiness.`,
      impact: "Workers cannot start affected queue entries until CodeGraph is available.",
      nextHumanAction: { kind: "repair_runtime", label: "Repair CodeGraph", href: "/hub/queue" },
      primaryEvidenceId: "codegraph",
      evidence: [evidence("runtime_health", "codegraph")],
    }));
  }

  const rateCount = runtimeHealth.queueBlockingCounts?.agent_rate_limited || runtimeHealth.queueBlockingCounts?.agentRateLimited || 0;
  if (rateCount > 0) {
    items.push(attentionItem({
      kind: "agent_rate_limited",
      severity: "warning",
      title: "Agent provider rate limited",
      reason: `${rateCount} queued item(s) are blocked by provider rate limits.`,
      impact: "Automation will remain delayed until capacity returns or routing changes.",
      nextHumanAction: { kind: "retry", label: "Retry when capacity returns", href: "/hub/queue" },
      primaryEvidenceId: "agent-rate-limit",
      evidence: [evidence("runtime_health", "agent-rate-limit")],
    }));
  }

  return items;
}

function addDeduped(map: Map<string, AnyRecord>, candidate: AnyRecord) {
  const keys = candidate._dedupeKeys?.length ? candidate._dedupeKeys : [candidate.id];
  const key = keys.find((candidateKey: string) => map.has(candidateKey)) || keys[0];
  const existing = map.get(key);
  if (!existing) {
    for (const candidateKey of keys) map.set(candidateKey, candidate);
    return;
  }

  for (const candidateKey of keys) map.set(candidateKey, existing);

  const evidenceKeys = new Set(existing.evidence.map((entry: AnyRecord) => `${entry.type}:${entry.id}:${entry.path || ""}`));
  for (const entry of candidate.evidence) {
    const evidenceKey = `${entry.type}:${entry.id}:${entry.path || ""}`;
    if (!evidenceKeys.has(evidenceKey)) {
      existing.evidence.push(entry);
      evidenceKeys.add(evidenceKey);
    }
  }

  if (candidate.evidence.length > existing.evidence.length) {
    Object.assign(existing, {
      title: candidate.title,
      reason: candidate.reason,
      impact: candidate.impact,
      nextHumanAction: candidate.nextHumanAction,
    });
  }
  if ((SEVERITY_RANK[candidate.severity] ?? 9) < (SEVERITY_RANK[existing.severity] ?? 9)) {
    existing.severity = candidate.severity;
  }
  existing._priority = priorityRank(candidate._priority) < priorityRank(existing._priority)
    ? candidate._priority
    : existing._priority;
}

function sortAttention(a: AnyRecord, b: AnyRecord) {
  const severity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  if (severity !== 0) return severity;
  const kind = (KIND_RANK[a.kind] ?? 99) - (KIND_RANK[b.kind] ?? 99);
  if (kind !== 0) return kind;
  const at = a.updatedAt ? new Date(a.updatedAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  const priority = priorityRank(a._priority) - priorityRank(b._priority);
  if (priority !== 0) return priority;
  return a.id.localeCompare(b.id);
}

function publicItem(attentionItem: AnyRecord) {
  const { _priority, _primaryEvidenceId, _dedupeKeys, ...publicFields } = attentionItem;
  return publicFields;
}

export function buildAttentionProjection({
  jobs = [],
  queueEntries = [],
  reviews = [],
  runtimeHealth = null,
} = {}) {
  const deduped = new Map();

  for (const runtimeItem of runtimeItems(runtimeHealth)) addDeduped(deduped, runtimeItem);

  for (const entry of queueEntries || []) {
    if (!entry?.id) continue;
    const status = normalizeStatus(entry.status);
    const approvalStatus = normalizeStatus(entry.metadata?.approval?.status);
    if (status === "codegraph_unavailable" || status === "index_unavailable") {
      addDeduped(deduped, queueItem(entry, "codegraph_unavailable", "warning"));
    } else if (status === "agent_rate_limited" || status === "rate_limited") {
      addDeduped(deduped, queueItem(entry, "agent_rate_limited", "warning"));
    } else if (status === "waiting_approval" || approvalStatus === "waiting_approval") {
      addDeduped(deduped, queueItem(entry, "waiting_approval", "warning"));
    }
  }

  for (const job of jobs || []) {
    if (!job?.jobId) continue;
    const code = codeForJob(job);
    const status = normalizeStatus(job.status);
    if (CODEGRAPH_CODES.has(code)) {
      addDeduped(deduped, jobBlockerItem(job, "codegraph_unavailable", "critical"));
    } else if (RATE_LIMIT_CODES.has(code) || status === "agent_rate_limited") {
      addDeduped(deduped, jobBlockerItem(job, "agent_rate_limited", "warning"));
    } else if (status === "waiting_approval" || code === "waiting_approval" || code === "approval_required") {
      addDeduped(deduped, jobBlockerItem(job, "waiting_approval", "warning"));
    } else if (status === "failed") {
      addDeduped(deduped, workflowFailedItem(job));
    }

    for (const dagItem of dagNodeFailedItems(job)) addDeduped(deduped, dagItem);
  }

  for (const session of reviews || []) {
    if (session?.sessionId && session.status === "user_review") {
      addDeduped(deduped, reviewReadyItem(session));
    }
  }

  return [...new Set(deduped.values())].sort(sortAttention).map(publicItem);
}
