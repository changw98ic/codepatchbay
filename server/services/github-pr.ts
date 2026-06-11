import { appendEvent } from "./event-store.js";
import { getJob } from "./job-store.js";
import { buildCodePatchBayPrBody } from "./pr-body.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "./secret-policy.js";

const execFileAsync = promisify(execFile);

type AnyRecord = Record<string, any>;

function isPass(verdict) {
  return String(verdict || "").toUpperCase() === "PASS";
}

function prTitle(job: AnyRecord) {
  const title = job.task || job.sourceContext?.issueTitle || `Issue #${job.sourceContext?.issueNumber || job.jobId}`;
  return `[cpb] ${title}`;
}

function verdictForBody(verdict, verdictDetail) {
  if (verdictDetail && typeof verdictDetail === "object") return verdictDetail;
  const status = String(verdict || "").toLowerCase();
  return { status: status || "unavailable" };
}

function prBody(job, routingContext = null, agents = {}, bodyContext: AnyRecord = {}) {
  const {
    artifacts = {},
    tests = [],
    audit = {},
    verdict = { status: "pass" },
    sddTrace = null,
  } = bodyContext || {};
  return buildCodePatchBayPrBody({
    job,
    verdict,
    routingContext,
    agents,
    artifacts,
    tests,
    audit,
    sddTrace,
  });
}

function buildRequest(job: AnyRecord, routingContext = null, agents = {}, bodyContext: AnyRecord = {}) {
  return {
    repo: job.sourceContext?.repo || null,
    title: prTitle(job),
    body: prBody(job, routingContext, agents, bodyContext),
    head: job.worktreeBranch || null,
    base: job.worktreeBaseBranch || "main",
    draft: true,
  };
}

function prepareCommitMessage(job: AnyRecord) {
  return [
    `Finalize CPB job ${job?.jobId || "unknown"}`,
    "",
    job?.sourceContext?.issueNumber ? `Issue: #${job.sourceContext.issueNumber}` : null,
    `CPB-Job: ${job?.jobId || "unknown"}`,
  ].filter(Boolean).join("\n");
}

function blocked(reason, evidence = {}, error = null) {
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

function parseGhPrUrl(stdout) {
  const match = String(stdout || "").match(/https:\/\/github\.com\/[^\s]+\/pull\/([0-9]+)/);
  if (!match) return { url: null, number: null };
  return { url: match[0], number: Number.parseInt(match[1], 10) };
}

async function runGit(cwd, args, { runCommand = execFileAsync, env }: AnyRecord = {}) {
  const opts: AnyRecord = { cwd, maxBuffer: 1024 * 1024 };
  if (env) opts.env = env;
  return runCommand("git", args, opts);
}

async function createGitAskpassScript(tmpDir, token) {
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

export async function preparePullRequestBranchWithGit(request: AnyRecord, job: AnyRecord, {
  runCommand = execFileAsync,
  remote = "origin",
  token = null,
}: AnyRecord = {}) {
  if (!job?.worktree) {
    return {
      ok: false,
      reason: "branch has not been pushed",
      evidence: { worktree: null },
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
        message: redactSecrets(error.message),
        code: error.code || null,
      },
    };
  } finally {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function createPullRequestWithGh(request: AnyRecord, { runCommand = execFileAsync }: AnyRecord = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-pr-body-"));
  const bodyFile = path.join(tmpDir, "body.md");
  try {
    await writeFile(bodyFile, request.body || "", "utf8");
    const args = [
      "pr", "create",
      "--title", request.title,
      "--body-file", bodyFile,
      "--repo", request.repo,
      "--head", request.head,
      "--base", request.base,
    ];
    if (request.draft) args.push("--draft");
    const result = await runCommand("gh", args, { maxBuffer: 1024 * 1024 });
    const parsed = parseGhPrUrl(result.stdout);
    return {
      url: parsed.url,
      html_url: parsed.url,
      number: parsed.number,
      stdout: result.stdout || "",
      stderr: redactSecrets(result.stderr || ""),
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

export async function openDraftPullRequest({
  job,
  verdict,
  branchPushed = false,
  dryRun = false,
  createPullRequest,
  runCommand,
  pushToken = null,
  agents = {},
  routingContext = null,
  artifacts = {},
  tests = [],
  audit = {},
  verdictDetail = null,
  sddTrace = null,
}: AnyRecord = {}): Promise<AnyRecord> {
  if (!isPass(verdict)) {
    return {
      status: "skipped",
      reason: "draft PR creation requires a PASS verdict",
      jobStatus: job?.status || null,
    };
  }

  const request = buildRequest(job || {}, routingContext, agents, {
    artifacts,
    tests,
    audit,
    verdict: verdictForBody(verdict, verdictDetail),
    sddTrace,
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

  let branchPreparation = null;
  if (!branchPushed) {
    branchPreparation = await preparePullRequestBranchWithGit(request, job, { runCommand, token: pushToken });
    if (!branchPreparation.ok) {
      return blocked(branchPreparation.reason || "branch has not been pushed", {
        ...evidence,
        ...(branchPreparation.evidence || {}),
      }, branchPreparation.error || null);
    }
  }

  try {
    const transport = typeof createPullRequest === "function"
      ? createPullRequest
      : (req) => createPullRequestWithGh(req, { runCommand });
    const response = await transport(request);
    return {
      status: "pr.opened",
      jobStatus: "passed",
      request,
      response,
      prUrl: response?.url || response?.html_url || null,
      prNumber: response?.number || null,
      branchPreparation,
    };
  } catch (error) {
    return blocked("failed to open draft PR", evidence, {
      message: redactSecrets(error.message),
      code: error.code || null,
    });
  }
}

export async function maybeOpenDraftPrAfterPass(cpbRoot, project, jobId, options: AnyRecord = {}) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot: options.dataRoot });
  const result = await openDraftPullRequest({
    job,
    verdict: options.verdict,
    branchPushed: options.branchPushed,
    dryRun: options.dryRun,
    createPullRequest: options.createPullRequest,
    runCommand: options.runCommand,
    pushToken: options.pushToken,
    agents: options.agents || {},
    routingContext: options.routingContext || null,
    artifacts: options.artifacts || {},
    tests: options.tests || [],
    audit: options.audit || {},
    verdictDetail: options.verdictDetail || null,
    sddTrace: options.sddTrace || null,
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
