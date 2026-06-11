import { mkdir, readFile, rm, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProject } from "./hub-registry.js";

const LOCK_TTL_MS = 30_000;
const SAFE_PROJECT = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function assertProject(project) {
  if (!SAFE_PROJECT.test(project || "")) {
    throw new Error(`invalid project name: ${project}`);
  }
}

export function evolveDir(projectRoot, project) {
  assertProject(project);
  const root = resolveExplicitDataRoot({ projectRuntimeRoot: projectRoot });
  return path.join(root, "evolve", project);
}

function resolveExplicitDataRoot(opts: Record<string, any> = {}) {
  const root = opts.projectRuntimeRoot || opts.dataRoot;
  if (!root || typeof root !== "string" || !root.trim()) {
    throw new Error("projectRuntimeRoot or dataRoot is required for evolve state");
  }
  return path.resolve(root);
}

async function resolveStateDataRoot(project, opts: Record<string, any> = {}) {
  const explicit = opts.projectRuntimeRoot || opts.dataRoot;
  if (explicit) return resolveExplicitDataRoot(opts);
  if (opts.hubRoot) {
    const registered = await getProject(opts.hubRoot, project);
    if (registered?.projectRuntimeRoot) {
      return resolveExplicitDataRoot({ projectRuntimeRoot: registered.projectRuntimeRoot });
    }
  }
  throw new Error(`projectRuntimeRoot or dataRoot is required for evolve state: ${project}`);
}

function statePath(dataRoot, project, file) {
  assertProject(project);
  return path.join(path.resolve(dataRoot), "evolve", project, file);
}

async function readJSON(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    return fallback;
  }
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

export async function loadProjectState(projectRoot, project, opts: Record<string, any> = {}) {
  const dataRoot = await resolveStateDataRoot(project, opts);
  return readJSON(statePath(dataRoot, project, "state.json"), {
    knownGoodCommit: null,
    round: 0,
    status: "idle",
    enabled: true,
    updatedAt: null,
  });
}

export async function saveProjectState(projectRoot, project, state, opts: Record<string, any> = {}) {
  const dataRoot = await resolveStateDataRoot(project, opts);
  const next = { ...state, updatedAt: new Date().toISOString() };
  await writeAtomic(statePath(dataRoot, project, "state.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function loadBacklog(projectRoot, project, opts: Record<string, any> = {}) {
  const dataRoot = await resolveStateDataRoot(project, opts);
  return readJSON(statePath(dataRoot, project, "backlog.json"), []);
}

export async function saveBacklog(projectRoot, project, backlog, opts: Record<string, any> = {}) {
  const dataRoot = await resolveStateDataRoot(project, opts);
  await writeAtomic(statePath(dataRoot, project, "backlog.json"), `${JSON.stringify(backlog, null, 2)}\n`);
  return backlog;
}

async function withBacklogLock(projectRoot, project, opts, callback) {
  const dataRoot = await resolveStateDataRoot(project, opts);
  const lockDir = statePath(dataRoot, project, "backlog.json.lock");
  await mkdir(path.dirname(lockDir), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockDir, { recursive: false });
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs >= LOCK_TTL_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!acquired) throw new Error(`backlog lock busy: ${project}`);
  try {
    return await callback(dataRoot);
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function issueKey(issue) {
  return issue.id || issue.description;
}

export async function pushIssues(projectRoot, project, issues, opts: Record<string, any> = {}) {
  return withBacklogLock(projectRoot, project, opts, async (dataRoot) => {
    const backlog = await loadBacklog(projectRoot, project, { dataRoot });
    const existing = new Set(backlog.map(issueKey));
    let added = 0;
    for (const issue of issues) {
      const key = issueKey(issue);
      if (!key || existing.has(key)) continue;
      backlog.push({
        ...issue,
        id: issue.id || `issue-${Date.now()}-${added}`,
        project,
        status: issue.status || "pending",
        createdAt: issue.createdAt || new Date().toISOString(),
      });
      existing.add(key);
      added += 1;
    }
    await saveBacklog(projectRoot, project, backlog, { dataRoot });
    return { added, total: backlog.length, backlog };
  });
}

function priorityScore(priority) {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  return 3;
}

export async function popIssue(projectRoot, project, opts: Record<string, any> = {}) {
  return withBacklogLock(projectRoot, project, opts, async (dataRoot) => {
    const backlog = await loadBacklog(projectRoot, project, { dataRoot });
    const pending = backlog.filter((issue) => issue.status === "pending");
    pending.sort((a, b) => priorityScore(a.priority) - priorityScore(b.priority));
    const issue = pending[0] || null;
    if (!issue) return null;
    issue.status = "in_progress";
    issue.updatedAt = new Date().toISOString();
    await saveBacklog(projectRoot, project, backlog, { dataRoot });
    return { issue, backlog };
  });
}

function matchesIssue(issue, identity) {
  return Boolean(identity)
    && (issue.id === identity || issue.description === identity || issueKey(issue) === identity);
}

export async function updateIssueStatus(projectRoot, project, identity, status, detail = {}, opts: Record<string, any> = {}) {
  return withBacklogLock(projectRoot, project, opts, async (dataRoot) => {
    const backlog = await loadBacklog(projectRoot, project, { dataRoot });
    const issue = backlog.find((item) => matchesIssue(item, identity));
    if (!issue) return null;
    issue.status = status;
    issue.updatedAt = new Date().toISOString();
    if (detail && Object.keys(detail).length > 0) {
      issue.detail = { ...(issue.detail || {}), ...detail };
    }
    await saveBacklog(projectRoot, project, backlog, { dataRoot });
    return { issue, backlog };
  });
}

export async function claimIssue(projectRoot, project, identity, opts: Record<string, any> = {}) {
  return withBacklogLock(projectRoot, project, opts, async (dataRoot) => {
    const backlog = await loadBacklog(projectRoot, project, { dataRoot });
    const issue = backlog.find((item) => matchesIssue(item, identity) && item.status === "pending");
    if (!issue) return null;
    issue.status = "in_progress";
    issue.claimedAt = new Date().toISOString();
    issue.updatedAt = issue.claimedAt;
    await saveBacklog(projectRoot, project, backlog, { dataRoot });
    return { issue, backlog };
  });
}

export async function completeIssue(projectRoot, project, identity, result: Record<string, any> = {}, opts: Record<string, any> = {}) {
  const status = result.ok ? "completed" : "failed";
  return updateIssueStatus(projectRoot, project, identity, status, {
    exitCode: result.code ?? null,
    error: result.error || null,
    completedAt: new Date().toISOString(),
  }, opts);
}

export async function appendHistory(projectRoot, project, entry, opts: Record<string, any> = {}) {
  const dataRoot = await resolveStateDataRoot(project, opts);
  await mkdir(path.join(dataRoot, "evolve", project), { recursive: true });
  const filePath = statePath(dataRoot, project, "history.jsonl");
  const line = JSON.stringify({ ...entry, project, timestamp: new Date().toISOString() }) + "\n";
  await writeFile(filePath, line, { flag: "a", encoding: "utf8" });
}

export async function loadGlobalConfig(hubRoot) {
  return readJSON(path.join(path.resolve(hubRoot), "evolve", "global", "config.json"), { projects: {} });
}

export async function saveGlobalConfig(hubRoot, config) {
  const filePath = path.join(path.resolve(hubRoot), "evolve", "global", "config.json");
  await writeAtomic(filePath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
