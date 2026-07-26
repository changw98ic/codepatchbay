// Merged from: github-issues.ts, github-comments.ts, github-pr.ts, branch-names.ts

import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { lstat, mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  createTemporaryWorkspace,
  temporaryWorkspaceErrorDetails,
  type TemporaryWorkspace,
} from "../../../core/runtime/temporary-workspace.js";
import type { LooseRecord } from "../../../shared/types.js";
import { appendEvent, readEvents } from "../event/event-store.js";
import { getJob } from "../job/job-store.js";
import { buildCodePatchBayPrBody } from "../pr-body.js";
import { jobToGithubStatusUpdate } from "../job/job-projection.js";
import { listProjects } from "../hub/hub-registry.js";
import { redactSecrets } from "../secret-policy.js";
import type {
  GithubRemoteAuthorityRequest,
  GithubRemoteAuthorityValidator,
  GithubRemoteCapability,
  GithubRemoteCommitVerifier,
  GithubRemoteWriteVerification,
} from "./github-remote-capability.js";

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
  exitCode?: string | number | null;
  ok?: boolean;
  message?: string;
  status?: unknown;
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
  remoteCapability?: GithubRemoteCapability | null;
  remoteAuthorityValidator?: GithubRemoteAuthorityValidator | null;
  remoteCommitVerifier?: GithubRemoteCommitVerifier | null;
  beforeRemoteMutation?: ((operation: string, request: LooseRecord) => Promise<void>) | null;
  afterRemoteMutation?: ((operation: string, receipt: LooseRecord) => Promise<void>) | null;
};

type GitHubCommandResult = Omit<LooseRecord, "status"> & {
  stdout?: string;
  stderr?: string;
  code?: string | number | null;
  exitCode?: string | number | null;
  status?: string | number | null;
  ok?: boolean;
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

function detachedRemoteAuthorityRequest(request: GithubRemoteAuthorityRequest): GithubRemoteAuthorityRequest {
  const capability = recordValue(request.capability);
  return {
    ...request,
    capability: {
      ...capability,
      permissions: { ...recordValue(capability.permissions) },
      ...(isRecord(capability.pullRequest)
        ? { pullRequest: { ...recordValue(capability.pullRequest) } }
        : {}),
    },
  };
}

function commandResult(value: GitHubCommandResult | string): GitHubCommandResult {
  return typeof value === "string" ? { stdout: value, stderr: "" } : value;
}

function assertCommandSucceeded(value: GitHubCommandResult | string, operation: string) {
  const result = commandResult(value);
  const failed = result.ok === false
    || (["code", "exitCode", "status"] as const).some((field) => {
      if (!Object.prototype.hasOwnProperty.call(result, field)) return false;
      const status = result[field];
      const normalized = typeof status === "string" && status.trim() !== "" ? Number(status) : status;
      return typeof normalized !== "number" || !Number.isFinite(normalized) || normalized !== 0;
    });
  if (failed) {
    throw Object.assign(new Error(`${operation} failed${result.stderr ? `: ${result.stderr}` : ""}`), {
      code: "GITHUB_COMMAND_FAILED",
      committed: null,
      operation,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
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

function redactGithubOperationText(value: unknown, explicitSecrets: unknown[] = []) {
  let redacted = stringValue(redactSecrets(value)).replace(
    /\b(cookie|set-cookie|session(?:[_-]?key)?)\s*[:=]\s*[^\s,;]+/gi,
    "$1=[REDACTED]",
  );
  for (const candidate of explicitSecrets) {
    const secret = typeof candidate === "string" ? candidate : "";
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function redactGithubOperationValue(value: unknown, explicitSecrets: unknown[] = []): unknown {
  const redacted = redactSecrets(value);
  const replace = (entry: unknown): unknown => {
    if (typeof entry === "string") return redactGithubOperationText(entry, explicitSecrets);
    if (Array.isArray(entry)) return entry.map(replace);
    if (!isRecord(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).map(([key, nested]) => [key, replace(nested)]));
  };
  return replace(redacted);
}

function githubOperationErrorEvidence(error: unknown, explicitSecrets: unknown[] = []): LooseRecord {
  const evidence: LooseRecord = {
    message: redactGithubOperationText(errorMessage(error), explicitSecrets),
    code: errorCode(error),
  };
  if (error instanceof AggregateError) {
    evidence.errors = error.errors.map((entry) => ({
      message: redactGithubOperationText(errorMessage(entry), explicitSecrets),
      code: errorCode(entry),
    }));
  }
  if (isRecord(error) && Object.prototype.hasOwnProperty.call(error, "operationResult")) {
    evidence.operationResult = redactGithubOperationValue(error.operationResult, explicitSecrets);
  }
  const cleanup = temporaryWorkspaceErrorDetails(error);
  if (cleanup) evidence.cleanup = cleanup;
  return evidence;
}

async function withGithubTemporaryWorkspace<T>(
  prefix: string,
  operation: string,
  run: (workspace: TemporaryWorkspace) => Promise<T>,
  {
    committedOnSuccess = () => true,
  }: {
    committedOnSuccess?: (result: T) => boolean | null;
  } = {},
): Promise<T> {
  const workspace = await createTemporaryWorkspace({ prefix });
  let result: T | undefined;
  let operationCommitted: boolean | null = null;
  let primaryError: unknown;
  let operationFailed = false;
  try {
    result = await run(workspace);
    operationCommitted = committedOnSuccess(result);
  } catch (error) {
    operationFailed = true;
    primaryError = error;
  }

  try {
    await workspace.cleanup();
  } catch (cleanupError) {
    if (operationFailed) {
      throw Object.assign(
        new AggregateError(
          [primaryError, cleanupError],
          `${operation} failed and temporary workspace cleanup was not clean`,
          { cause: primaryError },
        ),
        {
          code: "GITHUB_TEMPORARY_WORKSPACE_CLEANUP_FAILED",
          committed: null,
          primaryError,
          cleanupErrors: [cleanupError],
        },
      );
    }
    throw Object.assign(
      new Error(`${operation} completed but temporary workspace cleanup was not clean`, {
        cause: cleanupError,
      }),
      {
        code: "GITHUB_TEMPORARY_WORKSPACE_CLEANUP_FAILED",
        committed: operationCommitted,
        operationResult: result,
        primaryError: null,
        cleanupErrors: [cleanupError],
      },
    );
  }

  if (operationFailed) throw primaryError;
  return result as T;
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
  return assertCommandSucceeded(result, `gh ${args[0] || "command"}`).stdout || "";
}

async function resolveRepo(repo: unknown, { cwd, execFile }: LooseRecord & { execFile?: RunCommand } = {}) {
  const repoName = stringValue(repo);
  if (repoName) return repoName;
  const stdout = await runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd: stringValue(cwd, process.cwd()), execFile });
  return stdout.trim();
}

export async function closeGithubIssueWithGh({ repo, number, body }: GitHubRecord, { runCommand = execFileAsync }: GitHubRecord & { runCommand?: RunCommand } = {}) {
  const repository = stringValue(repo).toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw Object.assign(new Error("GitHub issue close repository is invalid"), { committed: false });
  }
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw Object.assign(new Error("GitHub issue close number must be a positive safe integer"), { committed: false });
  }
  const args = ["issue", "close", String(number), "--repo", repository];
  if (body) args.push("--comment", body);
  assertCommandSucceeded(await runCommand("gh", args, { maxBuffer: 1024 * 1024 }), "gh issue close");
  let observed: GitHubRecord;
  try {
    const view = assertCommandSucceeded(await runCommand("gh", [
      "issue", "view", String(number),
      "--repo", repository,
      "--json", "number,state,url",
    ], { maxBuffer: 1024 * 1024 }), "gh issue close verification");
    observed = recordValue(JSON.parse(String(view.stdout || ""))) as GitHubRecord;
  } catch (cause) {
    throw Object.assign(new Error("issue close reply was received but the remote post-condition is unknown", { cause }), {
      code: "GITHUB_ISSUE_CLOSE_UNCONFIRMED",
      committed: null,
      operation: "issue.close",
    });
  }
  const observedUrl = typeof observed.url === "string" ? observed.url : "";
  const urlMatch = observedUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/i);
  const identityValid = typeof observed.number === "number"
    && Number.isSafeInteger(observed.number)
    && observed.number === number
    && Boolean(
      urlMatch
      && urlMatch[1].toLowerCase() === repository
      && Number(urlMatch[2]) === number
    );
  if (!identityValid) {
    throw Object.assign(new Error("GitHub issue close post-condition returned an invalid issue identity"), {
      code: "GITHUB_ISSUE_CLOSE_UNCONFIRMED",
      committed: null,
      operation: "issue.close",
    });
  }
  const closed = String(observed.state || "").toUpperCase() === "CLOSED";
  if (!closed) {
    throw Object.assign(new Error("GitHub issue remains open after close request"), {
      code: "GITHUB_ISSUE_CLOSE_NOT_COMMITTED",
      committed: false,
      operation: "issue.close",
      evidence: observed,
    });
  }
  return { ok: true, number: observed.number, state: "CLOSED", url: observedUrl };
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

export function buildPrRequest(job: GitHubRecord, routingContext: LooseRecord | null = null, agents: LooseRecord = {}, bodyContext: LooseRecord = {}): GitHubRecord {
  const sourceContext = recordValue(job.sourceContext);
  return {
    repo: stringValue(sourceContext.repo) || null,
    title: stringValue(redactSecrets(prTitle(job))),
    body: stringValue(redactSecrets(prBody(job, routingContext, agents, bodyContext))),
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
  return assertCommandSucceeded(await runCommand("git", args, opts), `git ${args[0] || "command"}`) as GitHubRecord;
}

async function createGitAskpassScript(tmpDir: string) {
  const askpass = path.join(tmpDir, "git-askpass.sh");
  const script = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "x-access-token" ;;
  *) printf '%s\\n' "$CPB_GIT_ASKPASS_TOKEN" ;;
esac
`;
  await writeFile(askpass, script, "utf8");
  await chmod(askpass, 0o700);
  return askpass;
}

export function githubTrustedGitEnv(input: NodeJS.ProcessEnv, workspaceRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (typeof input[key] === "string") env[key] = input[key];
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  env.PATH = process.platform === "win32" ? input.PATH : "/usr/bin:/bin";
  env.HOME = workspaceRoot;
  env.XDG_CONFIG_HOME = workspaceRoot;
  env.TMPDIR = workspaceRoot;
  env.TMP = workspaceRoot;
  env.TEMP = workspaceRoot;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_SYSTEM = nullDevice;
  env.GIT_CONFIG_GLOBAL = nullDevice;
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_ALLOW_PROTOCOL = "https:file";
  env.GIT_PROTOCOL_FROM_USER = "0";
  env.GIT_PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GCM_INTERACTIVE = "Never";
  const overrides: Array<[string, string]> = [
    ["core.hooksPath", nullDevice],
    ["core.fsmonitor", "false"],
    ["core.attributesFile", nullDevice],
    ["credential.helper", ""],
    ["credential.interactive", "false"],
    ["credential.useHttpPath", "true"],
    ["http.extraHeader", ""],
    ["http.proxy", ""],
    ["http.sslVerify", "true"],
    ["http.followRedirects", "false"],
    ["protocol.ext.allow", "never"],
    ["protocol.git.allow", "never"],
    ["protocol.ssh.allow", "never"],
    ["protocol.file.allow", "always"],
    ["protocol.https.allow", "always"],
  ];
  env.GIT_CONFIG_COUNT = String(overrides.length);
  for (const [index, [key, value]] of overrides.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  return env;
}

async function assertNoGitReplaceRefs(
  cwd: string,
  boundary: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
) {
  const replaceRefs = String((await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace/",
  ], { runCommand, env })).stdout || "").trim();
  if (replaceRefs) {
    throw Object.assign(new Error(`controlled GitHub push ${boundary} contains Git replacement refs`), {
      committed: false,
      attempted: false,
    });
  }
}

function unsafeLocalGitConfigNames(stdout: unknown) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => /^filter\./i.test(entry) || /^core\.fsmonitor$/i.test(entry));
}

async function gitPathExists(
  cwd: string,
  relativeGitPath: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
) {
  const resolvedByGit = String((await runGit(cwd, [
    "rev-parse", "--git-path", relativeGitPath,
  ], { runCommand, env })).stdout || "").trim();
  if (!resolvedByGit) {
    throw Object.assign(new Error(`controlled GitHub push could not resolve Git path ${relativeGitPath}`), {
      committed: false,
      attempted: false,
    });
  }
  const resolved = path.isAbsolute(resolvedByGit)
    ? resolvedByGit
    : path.resolve(cwd, resolvedByGit);
  try {
    await lstat(resolved);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertTrustedGitObjectBoundary(
  cwd: string,
  boundary: string,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
) {
  await assertNoGitReplaceRefs(cwd, boundary, runCommand, env);
  const localConfig = await runGit(cwd, ["config", "--local", "--name-only", "--list"], {
    runCommand,
    env,
  });
  const unsafeConfig = unsafeLocalGitConfigNames(localConfig.stdout);
  if (await gitPathExists(cwd, "config.worktree", runCommand, env)) {
    const worktreeConfig = await runGit(cwd, ["config", "--worktree", "--name-only", "--list"], {
      runCommand,
      env,
    });
    unsafeConfig.push(...unsafeLocalGitConfigNames(worktreeConfig.stdout));
  }
  if (unsafeConfig.length > 0) {
    throw Object.assign(new Error(`controlled GitHub push ${boundary} contains unsafe local Git configuration`), {
      committed: false,
      attempted: false,
    });
  }
  for (const gitPath of ["info/grafts", "shallow", "objects/info/alternates"]) {
    if (await gitPathExists(cwd, gitPath, runCommand, env)) {
      throw Object.assign(new Error(`controlled GitHub push ${boundary} contains unsafe Git object metadata`), {
        committed: false,
        attempted: false,
      });
    }
  }
}

export async function assertGithubTrustedGitRepository(cwd: string, {
  runCommand = execFileAsync,
  env = process.env,
  workspaceRoot = cwd,
  boundary = "Git repository",
}: {
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
  workspaceRoot?: string;
  boundary?: string;
} = {}): Promise<NodeJS.ProcessEnv> {
  const trustedEnv = githubTrustedGitEnv(env, workspaceRoot);
  await assertTrustedGitObjectBoundary(cwd, boundary, runCommand, trustedEnv);
  return trustedEnv;
}

function validGithubRepository(value: string) {
  return /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(value);
}

function validGithubBranch(value: string) {
  return /^[A-Za-z0-9._/-]+$/.test(value)
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("..")
    && !value.includes("//");
}

export async function pushGithubCommitWithControlledTransport({
  worktree,
  repository,
  commit,
  expectedTree,
  expectedRemoteHead,
  targetBranch,
  token = null,
  env = process.env,
  runCommand = execFileAsync,
  authorize = null,
  verify = null,
  beforeAttempt = null,
  afterCommitted = null,
}: {
  worktree: string;
  repository: string;
  commit: string;
  expectedTree: string;
  expectedRemoteHead: string | null;
  targetBranch: string;
  token?: string | null;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  authorize?: (() => Promise<unknown>) | null;
  verify?: (() => Promise<GithubRemoteWriteVerification>) | null;
  beforeAttempt?: (() => Promise<void>) | null;
  afterCommitted?: ((verification: GithubRemoteWriteVerification) => Promise<void>) | null;
}): Promise<GithubRemoteWriteVerification> {
  if (!worktree) throw Object.assign(new Error("controlled GitHub push requires a worktree"), { committed: false, attempted: false });
  if (!validGithubRepository(repository)) {
    throw Object.assign(new Error("controlled GitHub push repository is invalid"), { committed: false, attempted: false });
  }
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw Object.assign(new Error("controlled GitHub push commit is invalid"), { committed: false, attempted: false });
  }
  if (!/^[0-9a-f]{40,64}$/i.test(expectedTree)) {
    throw Object.assign(new Error("controlled GitHub push expected tree is invalid"), { committed: false, attempted: false });
  }
  if (expectedRemoteHead !== null && !/^[0-9a-f]{40,64}$/i.test(expectedRemoteHead)) {
    throw Object.assign(new Error("controlled GitHub push expected remote head is invalid"), { committed: false, attempted: false });
  }
  if (!validGithubBranch(targetBranch)) {
    throw Object.assign(new Error("controlled GitHub push branch is invalid"), { committed: false, attempted: false });
  }

  let pushAttempted = false;
  try {
    return await withGithubTemporaryWorkspace(
      "cpb-git-askpass-",
      "controlled GitHub branch push",
      async (workspace) => {
        const gitEnv = githubTrustedGitEnv(env, workspace.rootPath);
        const bundlePath = path.join(workspace.rootPath, "source.bundle");
        const capsulePath = path.join(workspace.rootPath, "push.git");
        await assertTrustedGitObjectBoundary(worktree, "source worktree", runCommand, gitEnv);
        const sourceHead = String((await runGit(worktree, ["rev-parse", "--verify", "HEAD^{commit}"], {
          runCommand,
          env: gitEnv,
        })).stdout || "").trim().toLowerCase();
        if (sourceHead !== commit.toLowerCase()) {
          throw Object.assign(new Error("worktree HEAD changed before controlled GitHub push"), {
            committed: false,
            attempted: false,
          });
        }
        const sourceTree = String((await runGit(worktree, [
          "rev-parse", "--verify", `${commit}^{tree}`,
        ], { runCommand, env: gitEnv })).stdout || "").trim().toLowerCase();
        if (sourceTree !== expectedTree.toLowerCase()) {
          throw Object.assign(new Error("controlled GitHub push source tree does not match the audited tree"), {
            committed: false,
            attempted: false,
          });
        }
        await runGit(worktree, ["bundle", "create", bundlePath, "HEAD"], { runCommand, env: gitEnv });
        await runGit(workspace.rootPath, ["clone", "--bare", "--no-local", bundlePath, capsulePath], {
          runCommand,
          env: gitEnv,
        });
        await assertTrustedGitObjectBoundary(capsulePath, "push capsule", runCommand, gitEnv);
        const capsuleCommit = String((await runGit(capsulePath, [
          "rev-parse", "--verify", `${commit}^{commit}`,
        ], { runCommand, env: gitEnv })).stdout || "").trim().toLowerCase();
        if (capsuleCommit !== commit.toLowerCase()) {
          throw Object.assign(new Error("controlled GitHub push capsule does not contain the bound commit"), {
            committed: false,
            attempted: false,
          });
        }
        const capsuleTree = String((await runGit(capsulePath, [
          "rev-parse", "--verify", `${commit}^{tree}`,
        ], { runCommand, env: gitEnv })).stdout || "").trim().toLowerCase();
        if (capsuleTree !== expectedTree.toLowerCase()) {
          throw Object.assign(new Error("controlled GitHub push capsule tree does not match the audited tree"), {
            committed: false,
            attempted: false,
          });
        }
        if (expectedRemoteHead !== null) {
          await runGit(capsulePath, [
            "merge-base", "--is-ancestor", expectedRemoteHead, commit,
          ], { runCommand, env: gitEnv });
        }

        const pushEnv = { ...gitEnv };
        if (token) {
          pushEnv.GIT_ASKPASS = await createGitAskpassScript(workspace.rootPath);
          pushEnv.CPB_GIT_ASKPASS_TOKEN = token;
        }
        if (authorize) await authorize();
        if (beforeAttempt) await beforeAttempt();
        pushAttempted = true;
        let transportError: unknown = null;
        try {
          await runGit(capsulePath, [
            "push",
            `--force-with-lease=refs/heads/${targetBranch}:${expectedRemoteHead || ""}`,
            `https://github.com/${repository}.git`,
            `${commit}:refs/heads/${targetBranch}`,
          ], { runCommand, env: pushEnv });
        } catch (error) {
          transportError = error;
        }
        let verification: GithubRemoteWriteVerification;
        try {
          verification = verify
            ? await verify()
            : {
                operation: "repository.push",
                committed: null,
                reason: "controlled GitHub push has no remote post-condition verifier",
              };
        } catch (error) {
          verification = {
            operation: "repository.push",
            committed: null,
            reason: `remote push post-condition verification failed: ${redactGithubOperationText(errorMessage(error), [token])}`,
          };
        }
        const observed = !transportError ? verification : {
          ...verification,
          evidence: {
            ...recordValue(verification.evidence),
            transportWarning: githubOperationErrorEvidence(transportError, [token]),
          },
          ...(!verification.reason
            ? { reason: "Git push transport reported failure; remote ref readback is authoritative" }
            : {}),
        };
        if (observed.committed === true && afterCommitted) await afterCommitted(observed);
        return observed;
      },
      { committedOnSuccess: (verification) => verification.committed },
    );
  } catch (error) {
    const record = recordValue(error);
    const safeError = error instanceof Error ? error : new Error(String(error));
    safeError.message = redactGithubOperationText(safeError.message, [token]);
    if (typeof record.stderr === "string") record.stderr = redactGithubOperationText(record.stderr, [token]);
    if (typeof record.stdout === "string") record.stdout = redactGithubOperationText(record.stdout, [token]);
    if (!Object.prototype.hasOwnProperty.call(record, "committed")) record.committed = pushAttempted ? null : false;
    if (!Object.prototype.hasOwnProperty.call(record, "attempted")) record.attempted = pushAttempted;
    throw safeError;
  }
}

export async function preparePullRequestBranchWithGit(request: GitHubRecord, job: GitHubRecord, {
  runCommand = execFileAsync,
  remote = "origin",
  token = null,
  env = process.env,
  remoteCapability = null,
  remoteAuthorityValidator = null,
  remoteCommitVerifier = null,
  beforeRemoteMutation = null,
  afterRemoteMutation = null,
}: GitHubRecord & { runCommand?: RunCommand; remote?: string; token?: string | null } = {}) {
  if (!job?.worktree) {
    return {
      ok: false,
      reason: "branch has not been pushed",
      evidence: { worktree: null as string | null },
    };
  }
  if (!remoteCapability || !remoteAuthorityValidator || !remoteCommitVerifier) {
    return {
      ok: false,
      reason: "live PR branch preparation requires a remote capability and authority boundary",
      evidence: {
        worktree: job.worktree,
        remote,
        head: request.head,
        committed: false,
      },
    };
  }

  let pushAttempted = false;

  try {
    const sourceContext = recordValue(job.sourceContext);
    const authorityRequestForCommit = (commit: string): GithubRemoteAuthorityRequest => ({
      capability: remoteCapability,
      operation: "repository.push",
      repository: stringValue(request.repo),
      issueNumber: sourceContext.issueNumber as string | number,
      targetBranch: stringValue(request.head),
      pushKind: "pull-request-branch",
      headBranch: stringValue(request.head),
      baseBranch: stringValue(request.base),
      commit,
    });
    const initialRev = await runGit(job.worktree, ["rev-parse", "--verify", "HEAD^{commit}"], { runCommand });
    const initialCommit = String(initialRev.stdout || "").trim().toLowerCase();
    if (!initialCommit) throw Object.assign(new Error("PR branch HEAD could not be resolved before capability preflight"), { committed: false });
    const initialTree = String((await runGit(job.worktree, ["rev-parse", "--verify", "HEAD^{tree}"], { runCommand })).stdout || "").trim().toLowerCase();
    const expectedCommit = stringValue(job.auditedCommit || job.commit || initialCommit).toLowerCase();
    const expectedTree = stringValue(job.auditedTree || initialTree).toLowerCase();
    if (
      !/^[0-9a-f]{40,64}$/.test(expectedCommit)
      || !/^[0-9a-f]{40,64}$/.test(expectedTree)
      || initialCommit !== expectedCommit
      || initialTree !== expectedTree
    ) {
      throw Object.assign(new Error("PR worktree HEAD or tree does not match the audited generation"), { committed: false });
    }
    const initialStatus = await runGit(job.worktree, ["status", "--porcelain"], { runCommand });
    if (String(initialStatus.stdout || "").trim()) {
      throw Object.assign(new Error("live PR worktree must be clean at the audited generation"), { committed: false });
    }
    await remoteAuthorityValidator(detachedRemoteAuthorityRequest(authorityRequestForCommit(initialCommit)));

    const commit = initialCommit;

    const authorityRequest = authorityRequestForCommit(commit);
    await remoteAuthorityValidator(detachedRemoteAuthorityRequest(authorityRequest));
    const finalCommit = String((await runGit(job.worktree, ["rev-parse", "--verify", "HEAD^{commit}"], { runCommand })).stdout || "").trim().toLowerCase();
    const finalTree = String((await runGit(job.worktree, ["rev-parse", "--verify", "HEAD^{tree}"], { runCommand })).stdout || "").trim().toLowerCase();
    const finalStatus = await runGit(job.worktree, ["status", "--porcelain"], { runCommand });
    if (
      finalCommit !== expectedCommit
      || finalTree !== expectedTree
      || String(finalStatus.stdout || "").trim()
    ) {
      throw Object.assign(new Error("PR worktree changed after the audited authority check"), { committed: false });
    }
    const remoteVerification = await pushGithubCommitWithControlledTransport({
      worktree: stringValue(job.worktree),
      repository: remoteCapability.repository,
      commit,
      expectedTree,
      expectedRemoteHead: null,
      targetBranch: stringValue(request.head),
      token,
      env,
      runCommand,
      authorize: () => remoteAuthorityValidator(detachedRemoteAuthorityRequest(authorityRequest)),
      verify: () => remoteCommitVerifier(detachedRemoteAuthorityRequest(authorityRequest)),
      beforeAttempt: beforeRemoteMutation
        ? () => beforeRemoteMutation("pull_request.push", detachedRemoteAuthorityRequest(authorityRequest) as unknown as LooseRecord)
        : null,
      afterCommitted: afterRemoteMutation
        ? (verification) => afterRemoteMutation("pull_request.push", {
            request: detachedRemoteAuthorityRequest(authorityRequest) as unknown as LooseRecord,
            verification,
          })
        : null,
    });
    if (remoteVerification.committed !== true) {
      pushAttempted = true;
      return {
        ok: false,
        reason: "PR branch push was not confirmed",
        evidence: {
          worktree: job.worktree,
          remote,
          head: request.head,
          committed: remoteVerification?.committed ?? null,
          verification: remoteVerification,
        },
      };
    }
    pushAttempted = true;

    return {
      ok: true,
      committed: true,
      localCommitCreated: false,
      commit,
      remote: `https://github.com/${remoteCapability.repository}.git`,
      head: request.head,
      worktree: job.worktree,
      verification: remoteVerification,
    };
  } catch (error) {
    const errorRecord = recordValue(error);
    const effectiveAttempted = errorRecord.attempted === true || pushAttempted;
    const committed = typeof errorRecord.committed === "boolean" || errorRecord.committed === null
      ? errorRecord.committed
      : effectiveAttempted ? null : false;
    return {
      ok: false,
      reason: "failed to prepare PR branch",
      evidence: {
        worktree: job.worktree,
        remote,
        head: request.head,
        committed,
      },
      error: githubOperationErrorEvidence(error, [token]),
    };
  }
}

export async function createPullRequestWithGh(request: GitHubRecord, { runCommand = execFileAsync }: GitHubRecord & { runCommand?: RunCommand } = {}) {
  return withGithubTemporaryWorkspace(
    "cpb-pr-body-",
    "GitHub pull request creation",
    async (workspace) => {
      const bodyFile = path.join(workspace.rootPath, "body.md");
      await writeFile(bodyFile, request.body || "", { encoding: "utf8", mode: 0o600 });
      const args = [
        "pr", "create",
        "--title", stringValue(request.title),
        "--body-file", bodyFile,
        "--repo", stringValue(request.repo),
        "--head", stringValue(request.head),
        "--base", stringValue(request.base),
      ];
      if (request.draft) args.push("--draft");
      const result = assertCommandSucceeded(
        await runCommand("gh", args, { maxBuffer: 1024 * 1024 }),
        "gh pr create",
      );
      const parsed = parseGhPrUrl(result.stdout);
      if (!parsed.url || !parsed.number) {
        throw Object.assign(new Error("gh pr create returned no verifiable pull request identity"), {
          code: "GITHUB_PR_CREATE_UNCONFIRMED",
          committed: null,
          operation: "pull_request.create",
        });
      }
      return {
        url: parsed.url,
        html_url: parsed.url,
        number: parsed.number,
        stdout: result.stdout || "",
        stderr: stringValue(redactSecrets(result.stderr || "")),
      };
    },
  );
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
  remoteCapability = null,
  remoteAuthorityValidator = null,
  remoteCommitVerifier = null,
  beforeRemoteMutation = null,
  afterRemoteMutation = null,
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
  if (!remoteCapability || !remoteAuthorityValidator || !remoteCommitVerifier) {
    return blocked("live draft PR creation requires a remote capability and authority boundary", {
      ...evidence,
      committed: false,
    });
  }

  let branchPreparation = null;
  if (!branchPushed) {
    branchPreparation = await preparePullRequestBranchWithGit(request, normalizedJob, {
      runCommand,
      token: pushToken,
      remoteCapability,
      remoteAuthorityValidator,
      remoteCommitVerifier,
      beforeRemoteMutation: beforeRemoteMutation
        ? (operation, authorityRequest) => beforeRemoteMutation(operation, {
            ...authorityRequest,
            pullRequestPlan: {
              repo: request.repo,
              head: request.head,
              base: request.base,
              title: request.title,
              body: request.body,
              draft: request.draft,
            },
          })
        : null,
      afterRemoteMutation,
    });
    if (!branchPreparation.ok) {
      return blocked(branchPreparation.reason || "branch has not been pushed", {
        ...evidence,
        ...(branchPreparation.evidence || {}),
      }, branchPreparation.error || null);
    }
  }

  const expectedHeadCommit = stringValue(branchPreparation?.commit || normalizedJob.commit).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedHeadCommit)) {
    return blocked("live draft PR creation requires the exact pushed head commit", {
      ...evidence,
      committed: false,
    });
  }

  const sourceContext = recordValue(normalizedJob.sourceContext);
  const createAuthorityRequest: GithubRemoteAuthorityRequest = {
    capability: remoteCapability,
    operation: "pull_request.create",
    repository: stringValue(request.repo),
    issueNumber: sourceContext.issueNumber as string | number,
    headBranch: stringValue(request.head),
    baseBranch: stringValue(request.base),
    commit: expectedHeadCommit,
    title: stringValue(request.title),
    body: stringValue(request.body),
    draft: request.draft === true,
  };

  let createAttempted = false;
  let boundCreateRequest: GithubRemoteAuthorityRequest | null = null;
  try {
    const authority = recordValue(await remoteAuthorityValidator(detachedRemoteAuthorityRequest(createAuthorityRequest)));
    const authorLogin = stringValue(authority.authorLogin).toLowerCase();
    const authorId = stringValue(authority.authorId);
    if (!authorLogin || !authorId) {
      return blocked("pull request authority did not bind the authenticated author", {
        ...evidence,
        committed: false,
      });
    }
    boundCreateRequest = {
      ...createAuthorityRequest,
      authorLogin,
      authorId,
    };
    const transport = typeof createPullRequest === "function"
      ? (req: GitHubRecord) => createPullRequest(req) as Promise<GitHubRecord>
      : (req: GitHubRecord) => createPullRequestWithGh(req, { runCommand });
    if (beforeRemoteMutation) {
      await beforeRemoteMutation("pull_request.create", boundCreateRequest as unknown as LooseRecord);
    }
    createAttempted = true;
    const response = recordValue(await transport(request));
    const safeResponse = recordValue(redactGithubOperationValue(response, [pushToken]));
    if (response.ok === false) {
      throw Object.assign(new Error("pull request transport returned ok=false"), {
        code: "GITHUB_PR_CREATE_TRANSPORT_REJECTED",
        committed: null,
        response: safeResponse,
      });
    }
    const prUrl = stringValue(response.url || response.html_url) || null;
    const safePrUrl = stringValue(safeResponse.url || safeResponse.html_url) || null;
    const prNumber = numberValue(response.number);
    if (!prUrl || !prNumber) {
      throw Object.assign(new Error("pull request creation returned no verifiable identity"), {
        code: "GITHUB_PR_CREATE_UNCONFIRMED",
        committed: null,
        response: safeResponse,
      });
    }
    const responseMatch = prUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/i);
    if (
      !responseMatch
      || responseMatch[1].toLowerCase() !== stringValue(request.repo).toLowerCase()
      || Number(responseMatch[2]) !== prNumber
    ) {
      return blocked("pull request creation returned an identity outside the authorized repository", {
        ...evidence,
        committed: true,
        response: safeResponse,
        partialMutation: {
          operation: "pull_request.create",
          created: true,
          preserved: true,
          repository: stringValue(request.repo),
          responseUrl: safePrUrl,
          responseNumber: prNumber,
          reason: "creation response identity did not match the authorized repository",
        },
      });
    }
    const verification = await remoteCommitVerifier(detachedRemoteAuthorityRequest({
      ...boundCreateRequest,
      pullRequestNumber: prNumber,
    }));
    const safeVerification = recordValue(redactGithubOperationValue(verification, [pushToken]));
    if (verification.committed !== true) {
      return blocked("pull request creation was not confirmed", {
        ...evidence,
        committed: true,
        postConditionCommitted: verification.committed,
        verification: safeVerification,
        response: safeResponse,
        partialMutation: {
          operation: "pull_request.create",
          created: true,
          preserved: true,
          repository: stringValue(request.repo),
          number: prNumber,
          url: prUrl,
          expectedHeadCommit,
          reason: stringValue(safeVerification.reason) || "created pull request did not match the bound post-condition",
        },
      });
    }
    if (afterRemoteMutation) {
      await afterRemoteMutation("pull_request.create", {
        request: boundCreateRequest as unknown as LooseRecord,
        prUrl,
        prNumber,
        verification,
      });
    }
    return {
      status: "pr.opened",
      jobStatus: "passed",
      request,
      response: safeResponse,
      prUrl,
      prNumber,
      committed: true,
      branchPreparation,
      verification: safeVerification,
      remoteWrites: {
        pullRequestCreate: {
          attempted: true,
          committed: true,
          verification: safeVerification,
        },
      },
    };
  } catch (error) {
    const errorRecord = recordValue(error);
    if (!createAttempted || !boundCreateRequest) {
      const committed = typeof errorRecord.committed === "boolean" || errorRecord.committed === null
        ? errorRecord.committed
        : false;
      return blocked("failed to open draft PR", { ...evidence, committed }, githubOperationErrorEvidence(error, [pushToken]));
    }

    const operationResult = recordValue(errorRecord.operationResult);
    const safeOperationResult = recordValue(redactGithubOperationValue(operationResult, [pushToken]));
    const operationResultNumber = numberValue(operationResult.number);
    const operationResultUrl = stringValue(operationResult.url || operationResult.html_url) || null;
    const operationResultUrlMatch = operationResultUrl?.match(
      /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/i,
    ) || null;
    const operationIdentityKnown = Boolean(
      operationResultNumber
      && operationResultUrlMatch
      && operationResultUrlMatch[1].toLowerCase() === stringValue(request.repo).toLowerCase()
      && Number(operationResultUrlMatch[2]) === operationResultNumber
    );
    if ((operationResultNumber || operationResultUrl) && !operationIdentityKnown) {
      return blocked("pull request transport preserved an identity outside the authorized repository", {
        ...evidence,
        committed: true,
        partialMutation: {
          operation: "pull_request.create",
          created: true,
          preserved: true,
          repository: stringValue(request.repo),
          responseUrl: stringValue(safeOperationResult.url || safeOperationResult.html_url) || null,
          responseNumber: operationResultNumber,
          reason: "transport error identity did not match the authorized repository",
        },
        remoteWrites: {
          pullRequestCreate: {
            attempted: true,
            committed: true,
            transportWarning: githubOperationErrorEvidence(error, [pushToken]),
          },
        },
      }, githubOperationErrorEvidence(error, [pushToken]));
    }

    let discovery: GithubRemoteWriteVerification;
    try {
      discovery = await remoteCommitVerifier(detachedRemoteAuthorityRequest({
        ...boundCreateRequest,
        ...(operationIdentityKnown ? { pullRequestNumber: operationResultNumber } : {}),
      }));
    } catch (discoveryError) {
      discovery = {
        operation: "pull_request.create",
        committed: null,
        reason: `pull request creation discovery failed: ${errorMessage(discoveryError)}`,
      };
    }
    const discoveryEvidence = recordValue(discovery.evidence);
    const discoveredPullRequest = recordValue(discoveryEvidence.pullRequest);
    const discoveredNumber = numberValue(discoveredPullRequest.number);
    const discoveredUrl = stringValue(discoveredPullRequest.url) || null;
    const discoveredUrlMatch = discoveredUrl?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/i) || null;
    const discoveredIdentityValid = Boolean(
      discoveredNumber
      && discoveredUrlMatch
      && discoveredUrlMatch[1].toLowerCase() === stringValue(request.repo).toLowerCase()
      && Number(discoveredUrlMatch[2]) === discoveredNumber
    );
    const safeDiscovery = recordValue(redactGithubOperationValue(discovery, [pushToken]));
    const transportWarning = githubOperationErrorEvidence(error, [pushToken]);
    if (discovery.committed === true && discoveredIdentityValid) {
      const response = {
        url: discoveredUrl,
        html_url: discoveredUrl,
        number: discoveredNumber,
        recoveredByExactGenerationDiscovery: true,
      };
      if (afterRemoteMutation) {
        await afterRemoteMutation("pull_request.create", {
          request: boundCreateRequest as unknown as LooseRecord,
          prUrl: discoveredUrl,
          prNumber: discoveredNumber,
          verification: discovery,
          recovered: true,
        });
      }
      return {
        status: "pr.opened",
        jobStatus: "passed",
        request,
        response,
        prUrl: discoveredUrl,
        prNumber: discoveredNumber,
        committed: true,
        branchPreparation,
        verification: safeDiscovery,
        transportWarning,
        remoteWrites: {
          pullRequestCreate: {
            attempted: true,
            committed: true,
            verification: safeDiscovery,
            transportWarning,
          },
        },
      };
    }

    const committed = operationIdentityKnown ? true : discovery.committed === false ? false : null;
    return blocked("pull request creation transport was ambiguous and exact discovery did not confirm one PR", {
      ...evidence,
      committed,
      ...(operationIdentityKnown ? { postConditionCommitted: discovery.committed } : {}),
      verification: safeDiscovery,
      remoteWrites: {
        pullRequestCreate: {
          attempted: true,
          committed,
          verification: safeDiscovery,
          transportWarning,
        },
      },
      ...(committed === null || operationIdentityKnown
        ? {
            partialMutation: {
              operation: "pull_request.create",
              created: operationIdentityKnown ? true : null,
              preserved: true,
              repository: stringValue(request.repo),
              expectedHeadCommit,
              ...(operationIdentityKnown
                ? { number: operationResultNumber, url: operationResultUrl }
                : {}),
              reason: stringValue(safeDiscovery.reason) || "exact pull request identity could not be recovered uniquely",
            },
          }
        : {}),
    }, transportWarning);
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
    remoteCapability: options.remoteCapability || null,
    remoteAuthorityValidator: options.remoteAuthorityValidator || null,
    remoteCommitVerifier: options.remoteCommitVerifier || null,
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
