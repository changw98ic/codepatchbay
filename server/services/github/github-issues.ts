// Merged from: github-issues.ts, github-comments.ts, github-pr.ts, branch-names.ts

import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, readFile, rename, writeFile, mkdtemp, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { LooseRecord } from "../../../shared/types.js";
import { appendEvent, readEvents } from "../event/event-store.js";
import { getJob } from "../job/job-store.js";
import { buildCodePatchBayPrBody } from "../pr-body.js";
import { jobToGithubStatusUpdate } from "../job/job-projection.js";
import { listProjects } from "../hub/hub-registry.js";
import { redactSecrets } from "../secret-policy.js";

const execFileAsync = promisify(execFileCb);

type GitHubRecord = LooseRecord & {
  repository?: string;
  repo?: string | null;
  repositoryFullName?: string;
  projectId?: string;
  project?: string;
  number?: string | number;
  issueNumber?: string | number;
  issues?: GitHubRecord[];
  title?: string;
  issueTitle?: string;
  state?: string;
  url?: string;
  labels?: unknown;
  body?: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  id?: string;
  html_url?: string;
  maxBuffer?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding | string;
  cpbRoot?: string;
  github?: { fullName?: string };
  sourcePath?: string;
  count?: number;
  stdout?: string;
  stderr?: string;
  code?: string | number | null;
  message?: string;
  status?: unknown;
  ok?: boolean;
  reason?: string;
  failurePhase?: unknown;
  retryCount?: number;
  workflow?: string;
  jobId?: string;
  task?: string;
  worktree?: string;
  worktreeBranch?: string;
  worktreeBaseBranch?: string;
  head?: string | null;
  base?: string | null;
  draft?: boolean;
  sourceContext?: LooseRecord;
  payload?: LooseRecord;
  metadata?: LooseRecord;
  pr?: LooseRecord;
  job?: LooseRecord | null;
  queueEntry?: LooseRecord | null;
  projection?: LooseRecord | null;
  planner?: string;
  executor?: unknown;
  verifier?: string;
  request?: GitHubRecord;
  response?: LooseRecord;
  branchPreparation?: GitHubRecord | null;
  commit?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  jobStatus?: string;
  posted?: boolean;
  dedupeKey?: string;
  transportMode?: string | null;
  transportFallback?: boolean;
  dataRoot?: string;
  agents?: LooseRecord;
  artifacts?: LooseRecord;
  audit?: LooseRecord;
  tests?: unknown;
  completionGate?: unknown;
  verdictDetail?: LooseRecord | null;
  verdict?: unknown;
  branchPushed?: boolean;
  dryRun?: boolean;
  allowLive?: boolean;
  allowLiveFinalize?: boolean;
  pushToken?: string | null;
};

type GitHubCommandResult = LooseRecord & {
  stdout?: string;
  stderr?: string;
  code?: string | number | null;
};

type DraftPullRequestResult = GitHubRecord & {
  evidence?: LooseRecord & { reason?: string };
  error?: LooseRecord | null;
  request?: GitHubRecord;
  branchPreparation?: GitHubRecord | null;
};

type NormalizedGithubIssue = {
  repository: string | null;
  projectId: string;
  number: number;
  title: string;
  state: string;
  url: string | null;
  labels: string[];
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
};

type RunCommand = (command: string, args: string[], options?: GitHubRecord) => Promise<GitHubCommandResult | string>;
type GithubStatusJobInput = Parameters<typeof jobToGithubStatusUpdate>[0];

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): LooseRecord {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown, fallback = "") {
  return value === null || value === undefined ? fallback : String(value);
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function commandResult(value: GitHubCommandResult | string): GitHubCommandResult {
  return typeof value === "string" ? { stdout: value, stderr: "" } : value;
}

function githubStatusUpdate(projection: unknown, job: unknown): GitHubRecord | null {
  const update = isRecord(projection)
    ? projection
    : jobToGithubStatusUpdate(recordValue(job) as GithubStatusJobInput);
  if (!isRecord(update)) return null;
  const normalized = update as GitHubRecord;
  if (update.reason !== null && update.reason !== undefined) {
    normalized.reason = stringValue(update.reason);
  }
  return normalized;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : (isRecord(error) && typeof error.message === "string" ? error.message : String(error || ""));
}

function errorCode(error: unknown) {
  return isRecord(error) && (typeof error.code === "string" || typeof error.code === "number") ? String(error.code) : null;
}

// ============================================================
// branch-names.ts exports
// ============================================================

const DEFAULT_MAX_SLUG_LENGTH = 48;

function shortHash(value: unknown) {
  return createHash("sha1").update(String(value || "")).digest("hex").slice(0, 8);
}

export function slugifyBranchComponent(value: unknown, { fallback = "github-issue", maxLength = DEFAULT_MAX_SLUG_LENGTH }: { fallback?: string; maxLength?: number } = {}) {
  const raw = String(value || "").trim();
  let slug = raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!slug) slug = fallback;
  if (slug.length <= maxLength) return slug;

  const suffix = shortHash(raw);
  const prefixLength = Math.max(1, maxLength - suffix.length - 1);
  const prefix = slug.slice(0, prefixLength).replace(/-+$/g, "") || fallback.slice(0, prefixLength);
  return `${prefix}-${suffix}`;
}

export function buildGithubIssueBranchParts({ issueNumber, title, jobId, maxSlugLength = DEFAULT_MAX_SLUG_LENGTH }: LooseRecord = {}) {
  const number = Number.parseInt(String(issueNumber), 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error("issueNumber is required for GitHub issue branch naming");
  }
  const jobComponent = `issue-${number}`;
  const slug = slugifyBranchComponent(String(title || jobId || jobComponent), { maxLength: numberValue(maxSlugLength) ?? DEFAULT_MAX_SLUG_LENGTH });
  const worktreeName = `${jobComponent}-${slug}`;
  return {
    jobComponent,
    slug,
    worktreeName,
    branch: `cpb/${worktreeName}`,
  };
}

// ============================================================
// github-issues.ts exports
// ============================================================

const CACHE_VERSION = 1;

function cachePath(hubRoot: string) {
  return path.join(path.resolve(hubRoot), "github", "issues.json");
}

async function writeAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

function normalizeLabel(label: string | { name?: string }) {
  if (typeof label === "string") return label;
  return label?.name || null;
}

export function normalizeGithubLabels(labels: unknown) {
  return Array.isArray(labels) ? labels.map(normalizeLabel).filter(Boolean) : [];
}

export function normalizeGithubIssue(issue: LooseRecord = {}, { repo, projectId }: LooseRecord = {}): NormalizedGithubIssue {
  const repository = issue.repository || issue.repo || issue.repositoryFullName || repo || null;
  return {
    repository: repository === null ? null : String(repository),
    projectId: stringValue(issue.projectId || projectId || "flow"),
    number: Number(issue.number),
    title: stringValue(issue.title || `Issue #${issue.number}`),
    state: String(issue.state || "OPEN").toUpperCase(),
    url: issue.url === undefined || issue.url === null ? null : String(issue.url),
    labels: normalizeGithubLabels(issue.labels),
    body: stringValue(issue.body),
    createdAt: issue.createdAt === undefined || issue.createdAt === null ? null : String(issue.createdAt),
    updatedAt: (issue.updatedAt || issue.createdAt) === undefined || (issue.updatedAt || issue.createdAt) === null ? null : String(issue.updatedAt || issue.createdAt),
    closedAt: issue.closedAt === undefined || issue.closedAt === null ? null : String(issue.closedAt),
  };
}

export async function readGithubIssues(hubRoot: string) {
  try {
    const parsed = JSON.parse(await readFile(cachePath(hubRoot), "utf8"));
    const issues = Array.isArray(parsed) ? parsed : parsed.issues;
    if (!Array.isArray(issues)) return [];
    return issues.map((issue) => normalizeGithubIssue(issue));
  } catch (err) {
    if (recordValue(err).code === "ENOENT") return [];
    throw err;
  }
}

export async function writeGithubIssues(hubRoot: string, { repo, projectId = "flow", issues, syncedAt = new Date().toISOString() }: GitHubRecord = {}) {
  const sourceIssues = Array.isArray(issues) ? issues.map(recordValue) : [];
  const normalized = sourceIssues
    .map((issue) => normalizeGithubIssue(issue, { repo, projectId }))
    .filter((issue) => Number.isFinite(issue.number));
  const existing = await readGithubIssues(hubRoot);
  const retained = existing.filter((issue) => !issueBelongsToSyncScope(recordValue(issue), { repo, projectId }));
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

function issueBelongsToSyncScope(issue: LooseRecord, { repo, projectId }: LooseRecord = {}) {
  const normalized = normalizeGithubIssue(issue);
  if (projectId && normalized.projectId === projectId) return true;
  if (!repo) return false;
  if (normalized.repository !== repo) return false;
  return !projectId || !normalized.projectId || normalized.projectId === "flow";
}

async function runGh(args: string[], { cwd, execFile = execFileAsync }: LooseRecord & { execFile?: RunCommand } = {}) {
  const result = await execFile("gh", args, {
    cwd: stringValue(cwd, process.cwd()),
    maxBuffer: 20 * 1024 * 1024,
    encoding: "utf8",
  });
  return commandResult(result).stdout || "";
}

async function resolveRepo(repo: unknown, { cwd, execFile }: LooseRecord & { execFile?: RunCommand } = {}) {
  const repoName = stringValue(repo);
  if (repoName) return repoName;
  const stdout = await runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: stringValue(cwd, process.cwd()), execFile });
  return stdout.trim();
}

export async function closeGithubIssueWithGh({ repo, number, body }: GitHubRecord, { runCommand = execFileAsync }: GitHubRecord & { runCommand?: RunCommand } = {}) {
  const args = ["issue", "close", String(number), "--repo", stringValue(repo)];
  if (body) args.push("--comment", body);
  await runCommand("gh", args, { maxBuffer: 1024 * 1024 });
  return { ok: true };
}

export async function syncGithubIssuesFromGh(hubRoot: string, {
  repo,
  projectId = "flow",
  state = "open",
  limit = 1000,
  cwd = process.cwd(),
  execFile,
}: LooseRecord & { execFile?: RunCommand } = {}) {
  const cwdPath = stringValue(cwd, process.cwd());
  const resolvedRepo = await resolveRepo(repo, { cwd: cwdPath, execFile });
  const normalizedState = ["open", "closed", "all"].includes(String(state).toLowerCase())
    ? String(state).toLowerCase()
    : "open";
  const normalizedLimit = Math.max(1, Math.min(Number.parseInt(String(limit), 10) || 1000, 1000));
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
  ], { cwd: cwdPath, execFile });
  const issues = JSON.parse(stdout);
  return writeGithubIssues(hubRoot, {
    repo: resolvedRepo,
    projectId: stringValue(projectId, "flow"),
    issues,
  });
}

export async function syncConfiguredGithubIssuesFromGh(hubRoot: string, {
  projectId = null,
  state = "open",
  limit = 1000,
  cwd = process.cwd(),
  execFile,
  listProjectsFn = listProjects,
  syncProjectFn = syncGithubIssuesFromGh,
}: GitHubRecord & { execFile?: RunCommand; listProjectsFn?: typeof listProjects; syncProjectFn?: typeof syncGithubIssuesFromGh } = {}) {
  const projects = (await listProjectsFn(hubRoot, { enabledOnly: true })) as GitHubRecord[];
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
      projectId: stringValue(project.id),
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

// ============================================================
// github-comments.ts exports
// ============================================================

function agentLine(label: string, value: string) {
  return `- ${label}: ${value || "not selected"}`;
}

function hashBody(body: string) {
  return createHash("sha256").update(body || "", "utf8").digest("hex");
}

function responseSummary(response: LooseRecord | null | undefined) {
  if (!response || typeof response !== "object") return null;
  return {
    id: response.id ?? null,
    url: response.html_url || response.url || null,
  };
}

export async function postGithubCommentWithGh({ repo, issueNumber, body }: GitHubRecord, { runCommand = execFileAsync }: GitHubRecord & { runCommand?: RunCommand } = {}) {
  const result = commandResult(await runCommand("gh", [
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    stringValue(repo),
    "--body",
    stringValue(body),
  ], { maxBuffer: 1024 * 1024 }));
  return {
    url: null as string | null,
    html_url: null as string | null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function statusHeading(status: unknown) {
  status = String(status || "");
  if (status === "blocked") return "CodePatchBay blocked this run.";
  if (status === "failed") return "CodePatchBay failed this run.";
  if (status === "passed") return "Verified patch ready.";
  if (status === "pr-opened") return "Draft PR opened.";
  return "CodePatchBay updated this run.";
}

function statusDetailLines(projection: GitHubRecord) {
  if (projection.status === "blocked") {
    return [`- Reason: ${projection.reason || "approval or manual review required"}`];
  }
  if (projection.status === "failed") {
    return [
      `- Phase: ${projection.failurePhase || "unknown"}`,
      `- Reason: ${projection.reason || "run failed before verification completed"}`,
    ];
  }
  if (projection.status === "passed") {
    return [
      `- Workflow: ${projection.workflow || "standard"}`,
      `- Retries: ${projection.retryCount ?? 0}`,
    ];
  }
  if (projection.status === "pr-opened") {
    const pr = recordValue(projection.pr);
    const prLabel = pr.number ? `#${pr.number}` : pr.url || "created";
    return [
      `- PR: ${prLabel}`,
      `- URL: ${pr.url || "unavailable"}`,
    ];
  }
  return [`- Status: ${projection.status || "unknown"}`];
}

export function buildQueuedComment({ job = {}, queueEntry = null, agents = {} }: GitHubRecord = {}) {
  const normalizedJob = recordValue(job);
  const normalizedQueueEntry = recordValue(queueEntry);
  const payload = recordValue(normalizedQueueEntry.payload);
  const metadata = recordValue(normalizedQueueEntry.metadata);
  const normalizedAgents = recordValue(agents);
  const workflow = normalizedJob.workflow || payload.workflow || metadata.workflow || "standard";
  return [
    "CodePatchBay queued this issue.",
    "",
    `- Job: ${normalizedJob.jobId || "pending"}`,
    normalizedQueueEntry.id ? `- Queue: ${normalizedQueueEntry.id}` : null,
    `- Workflow: ${workflow}`,
    agentLine("Planner", stringValue(normalizedAgents.planner)),
    agentLine("Executor", stringValue(normalizedAgents.executor)),
    agentLine("Verifier", stringValue(normalizedAgents.verifier)),
    "",
    "I'll post updates here.",
    "",
  ].filter((line) => line !== null).join("\n");
}

export async function postGithubQueuedComment({
  repo,
  issueNumber,
  job,
  queueEntry,
  agents,
  dryRun = false,
  postComment,
  transportMode = null,
}: GitHubRecord & { postComment?: (request: GitHubRecord) => Promise<GitHubRecord> } = {}) {
  const body = buildQueuedComment({ job, queueEntry, agents });
  const request = {
    repo,
    issueNumber,
    body,
  };

  if (dryRun) {
    return {
      status: "dry-run",
      posted: false,
      request,
      body,
      transportMode,
    };
  }

  try {
    if (typeof postComment !== "function") {
      throw new Error("GitHub comment transport not configured");
    }
    const response = await postComment(request);
    return {
      status: "posted",
      posted: true,
      request,
      body,
      response,
      transportMode,
    };
  } catch (error) {
    return {
      status: "failed",
      posted: false,
      request,
      body,
      error: {
        message: errorMessage(error),
        code: errorCode(error),
      },
      transportMode,
    };
  }
}

export function buildGithubStatusComment({ projection, job }: GitHubRecord = {}) {
  const update = githubStatusUpdate(projection, job);
  if (!update) {
    throw new Error("GitHub terminal status projection is required");
  }

  return [
    statusHeading(update.status),
    "",
    `- Job: ${update.jobId || "unknown"}`,
    `- Issue: #${update.issueNumber}`,
    ...statusDetailLines(update),
    "",
  ].join("\n");
}

async function alreadyPostedStatusComment(cpbRoot: string, project: string, jobId: string, dedupeKey: string, { dataRoot }: GitHubRecord = {}) {
  if (!cpbRoot || !project || !jobId || !dedupeKey) return false;
  const events = await readEvents(cpbRoot, project, jobId, { dataRoot });
  return events.some((event) => (
    event.type === "github_comment_posted" &&
    event.commentKind === "terminal-status" &&
    event.dedupeKey === dedupeKey
  ));
}

export async function postGithubStatusComment({
  cpbRoot,
  project,
  job,
  projection,
  dryRun = false,
  postComment,
  dataRoot,
  transportMode = null,
}: GitHubRecord & { postComment?: (request: GitHubRecord) => Promise<GitHubRecord> } = {}) {
  const update = githubStatusUpdate(projection, job);
  if (!update) {
    return {
      status: "skipped",
      posted: false,
      reason: "job is not a terminal GitHub issue status update",
    };
  }

  const auditProject = stringValue(project || update.project);
  const updateJobId = stringValue(update.jobId);
  const updateStatus = stringValue(update.status);
  const body = buildGithubStatusComment({ projection: update, job });
  const request = {
    repo: update.repo,
    issueNumber: update.issueNumber,
    body,
  };
  const dedupeKey = stringValue(update.dedupeKey);

  if (await alreadyPostedStatusComment(stringValue(cpbRoot), auditProject, updateJobId, dedupeKey, { dataRoot })) {
    return {
      status: "duplicate",
      posted: false,
      dedupeKey,
      request,
      body,
    };
  }

  if (dryRun) {
    return {
      status: "dry-run",
      posted: false,
      dedupeKey,
      request,
      body,
    };
  }

  try {
    if (typeof postComment !== "function") {
      throw new Error("GitHub comment transport not configured");
    }
    const response = await postComment(request);
    await appendEvent(stringValue(cpbRoot), auditProject, updateJobId, {
      type: "github_comment_posted",
      jobId: updateJobId,
      project: auditProject,
      commentKind: "terminal-status",
      status: updateStatus,
      dedupeKey,
      repo: update.repo,
      issueNumber: update.issueNumber,
      bodyHash: hashBody(body),
      response: responseSummary(response),
      transportMode,
      transportFallback: transportMode === "gh",
      ts: new Date().toISOString(),
    }, { dataRoot });

    return {
      status: "posted",
      posted: true,
      dedupeKey,
      request,
      body,
      response,
    };
  } catch (error) {
    if (cpbRoot && auditProject && updateJobId) {
      await appendEvent(stringValue(cpbRoot), auditProject, updateJobId, {
        type: "github_comment_failed",
        jobId: updateJobId,
        project: auditProject,
        commentKind: "terminal-status",
        status: updateStatus,
        dedupeKey,
        repo: update.repo,
        issueNumber: update.issueNumber,
        bodyHash: hashBody(body),
        error: {
          message: errorMessage(error),
          code: errorCode(error),
        },
        transportMode,
        transportFallback: transportMode === "gh",
        ts: new Date().toISOString(),
      }, { dataRoot }).catch(() => {});
    }
    return {
      status: "failed",
      posted: false,
      dedupeKey,
      request,
      body,
      error: {
        message: errorMessage(error),
        code: errorCode(error),
      },
    };
  }
}

// ============================================================
// github-pr.ts exports
// ============================================================

function isPass(verdict: unknown) {
  return String(verdict || "").toUpperCase() === "PASS";
}

function prTitle(job: GitHubRecord) {
  const sourceContext = recordValue(job.sourceContext);
  const title = job.task || sourceContext.issueTitle || `Issue #${sourceContext.issueNumber || job.jobId}`;
  return `[cpb] ${title}`;
}

function verdictForBody(verdict: unknown, verdictDetail: LooseRecord | null) {
  if (verdictDetail && typeof verdictDetail === "object") return verdictDetail;
  const status = String(verdict || "").toLowerCase();
  return { status: status || "unavailable" };
}

function prBody(job: GitHubRecord, routingContext: LooseRecord | null = null, agents: LooseRecord = {}, bodyContext: LooseRecord = {}) {
  const {
    artifacts = {},
    tests = [],
    audit = {},
    verdict = { status: "pass" },
    completionGate = null,
  } = bodyContext || {};
  const sourceContext = recordValue(job.sourceContext);
  return buildCodePatchBayPrBody({
    job: {
      jobId: stringValue(job.jobId) || null,
      project: stringValue(job.project) || null,
      workflow: stringValue(job.workflow) || null,
      retryCount: numberValue(job.retryCount),
      sourceContext: {
        issueNumber: sourceContext.issueNumber ?? null,
        repo: stringValue(sourceContext.repo || sourceContext.repository) || null,
      },
    },
    verdict: recordValue(verdict),
    completionGate: recordValue(completionGate),
    routingContext: routingContext ? recordValue(routingContext) : null,
    agents: recordValue(agents),
    artifacts: recordValue(artifacts),
    tests: Array.isArray(tests) ? tests : [],
    audit: recordValue(audit),
  });
}

function buildPrRequest(job: GitHubRecord, routingContext: LooseRecord | null = null, agents: LooseRecord = {}, bodyContext: LooseRecord = {}): GitHubRecord {
  const sourceContext = recordValue(job.sourceContext);
  return {
    repo: stringValue(sourceContext.repo) || null,
    title: prTitle(job),
    body: prBody(job, routingContext, agents, bodyContext),
    head: job.worktreeBranch || null,
    base: job.worktreeBaseBranch || "main",
    draft: true,
  };
}

function prepareCommitMessage(job: GitHubRecord) {
  const sourceContext = recordValue(job?.sourceContext);
  return [
    `Finalize CPB job ${job?.jobId || "unknown"}`,
    "",
    sourceContext.issueNumber ? `Issue: #${sourceContext.issueNumber}` : null,
    `CPB-Job: ${job?.jobId || "unknown"}`,
  ].filter(Boolean).join("\n");
}

function blocked(reason: string, evidence: GitHubRecord = {}, error: LooseRecord | null = null): DraftPullRequestResult {
  return {
    status: "blocked.pr",
    jobStatus: "passed",
    evidence: {
      reason,
      ...evidence,
    },
    error,
  };
}

function parseGhPrUrl(stdout: string) {
  const match = String(stdout || "").match(/https:\/\/github\.com\/[^\s]+\/pull\/([0-9]+)/);
  if (!match) return { url: null, number: null };
  return { url: match[0], number: Number.parseInt(match[1], 10) };
}

async function runGit(cwd: string, args: string[], { runCommand = execFileAsync, env }: GitHubRecord & { runCommand?: RunCommand; env?: NodeJS.ProcessEnv } = {}) {
  const opts: GitHubRecord = { cwd, maxBuffer: 1024 * 1024 };
  if (env) opts.env = env;
  return await runCommand("git", args, opts) as GitHubRecord;
}

async function createGitAskpassScript(tmpDir: string, token: string) {
  const askpass = path.join(tmpDir, "git-askpass.sh");
  const script = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "x-access-token" ;;
  *) printf '%s\\n' "${token}" ;;
esac
`;
  await writeFile(askpass, script, "utf8");
  await chmod(askpass, 0o700);
  return askpass;
}

export async function preparePullRequestBranchWithGit(request: GitHubRecord, job: GitHubRecord, {
  runCommand = execFileAsync,
  remote = "origin",
  token = null,
}: GitHubRecord & { runCommand?: RunCommand; remote?: string; token?: string | null } = {}) {
  if (!job?.worktree) {
    return {
      ok: false,
      reason: "branch has not been pushed",
      evidence: { worktree: null as string | null },
    };
  }

  let tmpDir = null;
  let askpass = null;

  try {
    await runGit(job.worktree, ["add", "--all"], { runCommand });
    const status = await runGit(job.worktree, ["status", "--porcelain"], { runCommand });
    const hasChanges = Boolean(String(status.stdout || "").trim());
    let commit = null;
    if (hasChanges) {
      await runGit(job.worktree, ["commit", "-m", prepareCommitMessage(job)], { runCommand });
      const rev = await runGit(job.worktree, ["rev-parse", "HEAD"], { runCommand });
      commit = String(rev.stdout || "").trim() || null;
    }

    if (token && request.repo) {
      tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-git-askpass-"));
      askpass = await createGitAskpassScript(tmpDir, token);
      const pushEnv = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: askpass,
      };
      await runGit(job.worktree, [
        "push",
        `https://github.com/${request.repo}.git`,
        `HEAD:refs/heads/${request.head}`,
      ], { runCommand, env: pushEnv });
    } else {
      await runGit(job.worktree, ["push", remote, `HEAD:refs/heads/${request.head}`], { runCommand });
    }

    return {
      ok: true,
      committed: hasChanges,
      commit,
      remote,
      head: request.head,
      worktree: job.worktree,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "failed to prepare PR branch",
      evidence: {
        worktree: job.worktree,
        remote,
        head: request.head,
      },
      error: {
        message: redactSecrets(errorMessage(error)),
        code: errorCode(error),
      },
    };
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function createPullRequestWithGh(request: GitHubRecord, { runCommand = execFileAsync }: GitHubRecord & { runCommand?: RunCommand } = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-pr-body-"));
  const bodyFile = path.join(tmpDir, "body.md");
  try {
    await writeFile(bodyFile, request.body || "", "utf8");
    const args = [
      "pr", "create",
      "--title", stringValue(request.title),
      "--body-file", bodyFile,
      "--repo", stringValue(request.repo),
      "--head", stringValue(request.head),
      "--base", stringValue(request.base),
    ];
    if (request.draft) args.push("--draft");
    const result = commandResult(await runCommand("gh", args, { maxBuffer: 1024 * 1024 }));
    const parsed = parseGhPrUrl(result.stdout);
    return {
      url: parsed.url,
      html_url: parsed.url,
      number: parsed.number,
      stdout: result.stdout || "",
      stderr: stringValue(redactSecrets(result.stderr || "")),
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function openDraftPullRequest({
  job,
  verdict,
  branchPushed = false,
  dryRun = true,
  allowLive = false,
  createPullRequest,
  runCommand,
  pushToken = null,
  agents = {},
  routingContext = null,
  artifacts = {},
  tests = [],
  audit = {},
  verdictDetail = null,
  completionGate = null,
}: GitHubRecord & { createPullRequest?: ((request: LooseRecord) => Promise<LooseRecord>); runCommand?: RunCommand } = {}): Promise<DraftPullRequestResult> {
  const normalizedJob = recordValue(job) as GitHubRecord;
  const normalizedAgents = recordValue(agents);
  const normalizedRoutingContext = isRecord(routingContext) ? routingContext : null;
  if (!isPass(verdict)) {
    return {
      status: "skipped",
      reason: "draft PR creation requires a PASS verdict",
      jobStatus: stringValue(normalizedJob.status, "unknown"),
    };
  }

  const request = buildPrRequest(normalizedJob, normalizedRoutingContext, normalizedAgents, {
    artifacts,
    tests,
    audit,
    verdict: verdictForBody(verdict, verdictDetail),
    completionGate,
  });
  const evidence = {
    repo: request.repo,
    head: request.head,
    base: request.base,
    draft: request.draft,
  };

  if (!request.repo || !request.head || !request.base) {
    return blocked("PR request is missing repo, head, or base", evidence);
  }

  if (dryRun) {
    return {
      status: "dry-run",
      jobStatus: "passed",
      request,
      posted: false,
    };
  }

  if (!allowLive) {
    return blocked("draft PR creation requires explicit live finalization opt-in", evidence);
  }

  let branchPreparation = null;
  if (!branchPushed) {
    branchPreparation = await preparePullRequestBranchWithGit(request, normalizedJob, { runCommand, token: pushToken });
    if (!branchPreparation.ok) {
      return blocked(branchPreparation.reason || "branch has not been pushed", {
        ...evidence,
        ...(branchPreparation.evidence || {}),
      }, branchPreparation.error || null);
    }
  }

  try {
    const transport = typeof createPullRequest === "function"
      ? (req: GitHubRecord) => createPullRequest(req) as Promise<GitHubRecord>
      : (req: GitHubRecord) => createPullRequestWithGh(req, { runCommand });
    const response = recordValue(await transport(request));
    return {
      status: "pr.opened",
      jobStatus: "passed",
      request,
      response,
      prUrl: stringValue(response?.url || response?.html_url) || null,
      prNumber: numberValue(response?.number),
      branchPreparation,
    };
  } catch (error) {
    return blocked("failed to open draft PR", evidence, {
      message: stringValue(redactSecrets(errorMessage(error))),
      code: errorCode(error),
    });
  }
}

export async function maybeOpenDraftPrAfterPass(cpbRoot: string, project: string, jobId: string, options: GitHubRecord & { createPullRequest?: (request: LooseRecord) => Promise<LooseRecord>; runCommand?: RunCommand } = {}) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot: options.dataRoot });
  const result = await openDraftPullRequest({
    job,
    verdict: options.verdict,
    branchPushed: options.branchPushed,
    dryRun: options.dryRun,
    allowLive: Boolean(options.allowLive || options.allowLiveFinalize),
    createPullRequest: options.createPullRequest,
    runCommand: options.runCommand,
    pushToken: options.pushToken,
    agents: options.agents || {},
    routingContext: options.routingContext || null,
    artifacts: options.artifacts || {},
    tests: options.tests || [],
    audit: options.audit || {},
    verdictDetail: options.verdictDetail || null,
    completionGate: options.completionGate || null,
  });

  if (result.status === "pr.opened") {
    await appendEvent(cpbRoot, project, jobId, {
      type: "pr_opened",
      jobId,
      project,
      prUrl: result.prUrl,
      prNumber: result.prNumber,
      artifact: options.artifact || null,
      transportMode: options.transportMode || null,
      transportFallback: options.transportMode === "gh",
      ts: new Date().toISOString(),
    }, { dataRoot: options.dataRoot });
  }

  return result;
}
