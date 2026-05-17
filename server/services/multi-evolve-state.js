import { mkdir, readFile, rm, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCK_TTL_MS = 30_000;
const SAFE_PROJECT = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function assertProject(project) {
  if (!SAFE_PROJECT.test(project || "")) {
    throw new Error(`invalid project name: ${project}`);
  }
}

export function evolveDir(projectRoot, project) {
  assertProject(project);
  return path.join(path.resolve(projectRoot), "cpb-task", "evolve", project);
}

function statePath(projectRoot, project, file) {
  return path.join(evolveDir(projectRoot, project), file);
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

export async function loadProjectState(projectRoot, project) {
  return readJSON(statePath(projectRoot, project, "state.json"), {
    knownGoodCommit: null,
    round: 0,
    status: "idle",
    enabled: true,
    updatedAt: null,
  });
}

export async function saveProjectState(projectRoot, project, state) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  await writeAtomic(statePath(projectRoot, project, "state.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function loadBacklog(projectRoot, project) {
  return readJSON(statePath(projectRoot, project, "backlog.json"), []);
}

export async function saveBacklog(projectRoot, project, backlog) {
  await writeAtomic(statePath(projectRoot, project, "backlog.json"), `${JSON.stringify(backlog, null, 2)}\n`);
  return backlog;
}

async function withBacklogLock(projectRoot, project, callback) {
  const lockDir = statePath(projectRoot, project, "backlog.json.lock");
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
    return await callback();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function issueKey(issue) {
  return issue.id || issue.description;
}

export async function pushIssues(projectRoot, project, issues) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project);
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
    await saveBacklog(projectRoot, project, backlog);
    return { added, total: backlog.length, backlog };
  });
}

function priorityScore(priority) {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  return 3;
}

export async function popIssue(projectRoot, project) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project);
    const pending = backlog.filter((issue) => issue.status === "pending");
    pending.sort((a, b) => priorityScore(a.priority) - priorityScore(b.priority));
    const issue = pending[0] || null;
    if (!issue) return null;
    issue.status = "in_progress";
    issue.updatedAt = new Date().toISOString();
    await saveBacklog(projectRoot, project, backlog);
    return { issue, backlog };
  });
}

function matchesIssue(issue, identity) {
  return Boolean(identity)
    && (issue.id === identity || issue.description === identity || issueKey(issue) === identity);
}

export async function updateIssueStatus(projectRoot, project, identity, status, detail = {}) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project);
    const issue = backlog.find((item) => matchesIssue(item, identity));
    if (!issue) return null;
    issue.status = status;
    issue.updatedAt = new Date().toISOString();
    if (detail && Object.keys(detail).length > 0) {
      issue.detail = { ...(issue.detail || {}), ...detail };
    }
    await saveBacklog(projectRoot, project, backlog);
    return { issue, backlog };
  });
}

export async function claimIssue(projectRoot, project, identity) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project);
    const issue = backlog.find((item) => matchesIssue(item, identity) && item.status === "pending");
    if (!issue) return null;
    issue.status = "in_progress";
    issue.claimedAt = new Date().toISOString();
    issue.updatedAt = issue.claimedAt;
    await saveBacklog(projectRoot, project, backlog);
    return { issue, backlog };
  });
}

export async function completeIssue(projectRoot, project, identity, result = {}) {
  const status = result.ok ? "completed" : "failed";
  return updateIssueStatus(projectRoot, project, identity, status, {
    exitCode: result.code ?? null,
    error: result.error || null,
    completedAt: new Date().toISOString(),
  });
}

export async function appendHistory(projectRoot, project, entry) {
  await mkdir(evolveDir(projectRoot, project), { recursive: true });
  const filePath = statePath(projectRoot, project, "history.jsonl");
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
