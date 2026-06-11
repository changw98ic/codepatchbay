// @ts-nocheck
import { execFile as execFileCb } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { listProjects } from "./hub-registry.js";

const execFileAsync = promisify(execFileCb);
const CACHE_VERSION = 1;

function cachePath(hubRoot) {
  return path.join(path.resolve(hubRoot), "github", "issues.json");
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

function normalizeLabel(label) {
  if (typeof label === "string") return label;
  return label?.name || null;
}

export function normalizeGithubLabels(labels) {
  return Array.isArray(labels) ? labels.map(normalizeLabel).filter(Boolean) : [];
}

export function normalizeGithubIssue(issue = {}, { repo, projectId } = {}) {
  return {
    repository: issue.repository || issue.repo || issue.repositoryFullName || repo || null,
    projectId: issue.projectId || projectId || "flow",
    number: Number(issue.number),
    title: issue.title || `Issue #${issue.number}`,
    state: String(issue.state || "OPEN").toUpperCase(),
    url: issue.url || null,
    labels: normalizeGithubLabels(issue.labels),
    body: issue.body || "",
    createdAt: issue.createdAt || null,
    updatedAt: issue.updatedAt || issue.createdAt || null,
    closedAt: issue.closedAt || null,
  };
}

export async function readGithubIssues(hubRoot) {
  try {
    const parsed = JSON.parse(await readFile(cachePath(hubRoot), "utf8"));
    const issues = Array.isArray(parsed) ? parsed : parsed.issues;
    if (!Array.isArray(issues)) return [];
    return issues.map((issue) => normalizeGithubIssue(issue));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function writeGithubIssues(hubRoot, { repo, projectId = "flow", issues, syncedAt = new Date().toISOString() } = {}) {
  const normalized = (issues || [])
    .map((issue) => normalizeGithubIssue(issue, { repo, projectId }))
    .filter((issue) => Number.isFinite(issue.number));
  const existing = await readGithubIssues(hubRoot);
  const retained = existing.filter((issue) => !issueBelongsToSyncScope(issue, { repo, projectId }));
  const merged = [...retained, ...normalized];
  const payload = {
    version: CACHE_VERSION,
    repo: repo || null,
    projectId,
    syncedAt,
    count: normalized.length,
    totalCount: merged.length,
    issues: merged,
  };
  await writeAtomic(cachePath(hubRoot), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function issueBelongsToSyncScope(issue, { repo, projectId } = {}) {
  const normalized = normalizeGithubIssue(issue);
  if (projectId && normalized.projectId === projectId) return true;
  if (!repo) return false;
  if (normalized.repository !== repo) return false;
  return !projectId || !normalized.projectId || normalized.projectId === "flow";
}

async function runGh(args, { cwd, execFile = execFileAsync } = {}) {
  const result = await execFile("gh", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    encoding: "utf8",
  });
  return typeof result === "string" ? result : result.stdout;
}

async function resolveRepo(repo, { cwd, execFile } = {}) {
  if (repo) return repo;
  const stdout = await runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd, execFile });
  return stdout.trim();
}

export async function closeGithubIssueWithGh({ repo, number, body }, { runCommand = execFileAsync } = {}) {
  const args = ["issue", "close", String(number), "--repo", repo];
  if (body) args.push("--comment", body);
  await runCommand("gh", args, { maxBuffer: 1024 * 1024 });
  return { ok: true };
}

export async function syncGithubIssuesFromGh(hubRoot, {
  repo,
  projectId = "flow",
  state = "open",
  limit = 1000,
  cwd = process.cwd(),
  execFile,
} = {}) {
  const resolvedRepo = await resolveRepo(repo, { cwd, execFile });
  const normalizedState = ["open", "closed", "all"].includes(String(state).toLowerCase())
    ? String(state).toLowerCase()
    : "open";
  const normalizedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 1000));
  const stdout = await runGh([
    "issue",
    "list",
    "--repo",
    resolvedRepo,
    "--state",
    normalizedState,
    "--limit",
    String(normalizedLimit),
    "--json",
    "number,title,body,url,state,labels,createdAt,updatedAt,closedAt",
  ], { cwd, execFile });
  const issues = JSON.parse(stdout);
  return writeGithubIssues(hubRoot, {
    repo: resolvedRepo,
    projectId,
    issues,
  });
}

export async function syncConfiguredGithubIssuesFromGh(hubRoot, {
  projectId = null,
  state = "open",
  limit = 1000,
  cwd = process.cwd(),
  execFile,
  listProjectsFn = listProjects,
  syncProjectFn = syncGithubIssuesFromGh,
} = {}) {
  const projects = await listProjectsFn(hubRoot, { enabledOnly: true });
  const selected = projectId ? projects.filter((project) => project.id === projectId) : projects;
  if (projectId && selected.length === 0) {
    throw new Error(`project not found or disabled: ${projectId}`);
  }

  const syncedProjects = [];
  const skipped = [];

  for (const project of selected) {
    const repo = project.github?.fullName;
    if (!repo) {
      skipped.push({ projectId: project.id, reason: "no GitHub binding" });
      continue;
    }

    const projectCwd = project.sourcePath || cwd;
    const result = await syncProjectFn(hubRoot, {
      repo,
      projectId: project.id,
      state,
      limit,
      cwd: projectCwd,
      execFile,
    });
    syncedProjects.push({
      projectId: project.id,
      repo,
      cwd: projectCwd,
      count: result.count || 0,
    });
  }

  return {
    synced: true,
    count: syncedProjects.reduce((total, project) => total + project.count, 0),
    projectCount: syncedProjects.length,
    projects: syncedProjects,
    skipped,
  };
}
