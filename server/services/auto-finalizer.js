import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  MERGE_CLASSIFICATION,
  summarizeMergeFiles,
} from "./merge-steward.js";
import { appendEvent } from "./event-store.js";
import { openDraftPullRequest } from "./github-pr.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd, args, { allowFailure = false, runCommand = execFileAsync } = {}) {
  try {
    const result = await runCommand("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: 0,
    };
  } catch (err) {
    if (!allowFailure) throw err;
    return {
      stdout: err?.stdout || "",
      stderr: err?.stderr || err?.message || "",
      exitCode: Number.isInteger(err?.code) ? err.code : 1,
    };
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(repoPath, { runCommand } = {}) {
  const result = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"], {
    allowFailure: true,
    runCommand,
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function assertClean(repoPath, { runCommand } = {}) {
  const status = await runGit(repoPath, ["status", "--porcelain"], { runCommand });
  return status.stdout.trim() === "";
}

async function currentBranch(repoPath, { runCommand } = {}) {
  return (await runGit(repoPath, ["branch", "--show-current"], { runCommand })).stdout.trim();
}

async function revParse(repoPath, ref = "HEAD", { runCommand } = {}) {
  return (await runGit(repoPath, ["rev-parse", "--verify", ref], { runCommand })).stdout.trim();
}

async function diffFiles(repoPath, fromRef, toRef, { runCommand } = {}) {
  const result = await runGit(repoPath, ["diff", "--name-only", "-z", fromRef, toRef], { runCommand });
  return splitNul(result.stdout);
}

async function isAncestor(repoPath, ancestor, descendant, { runCommand } = {}) {
  const result = await runGit(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
    runCommand,
  });
  return result.exitCode === 0;
}

function reject(code, details = {}) {
  return {
    ok: false,
    status: "rejected",
    code,
    jobId: details.jobId ?? null,
    ...details,
  };
}

function skipped(code, details = {}) {
  return {
    ok: false,
    status: "skipped",
    code,
    jobId: details.jobId ?? null,
    ...details,
  };
}

function parseIssueUrl(issueUrl) {
  if (!issueUrl) return null;
  const match = String(issueUrl).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/);
  if (!match) return null;
  return {
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
    url: `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`,
  };
}

function resolveIssue(metadata = {}) {
  const number = Number(metadata.issueNumber);
  const repo = metadata.repo || metadata.repository || metadata.repositoryFullName;
  if (Number.isInteger(number) && number > 0 && typeof repo === "string" && repo.includes("/")) {
    return {
      repo,
      number,
      url: metadata.issueUrl || `https://github.com/${repo}/issues/${number}`,
    };
  }

  return parseIssueUrl(metadata.issueUrl);
}

function splitNul(value) {
  return String(value || "").split("\0").filter(Boolean);
}

async function changedWorktreeFiles(worktreePath, { runCommand } = {}) {
  const [unstaged, staged, untracked] = await Promise.all([
    runGit(worktreePath, ["diff", "--name-only", "-z"], { runCommand }),
    runGit(worktreePath, ["diff", "--cached", "--name-only", "-z"], { runCommand }),
    runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], { runCommand }),
  ]);
  return [...new Set([
    ...splitNul(unstaged.stdout),
    ...splitNul(staged.stdout),
    ...splitNul(untracked.stdout),
  ])];
}

function hasUnsafeChanges(summary) {
  return (
    summary.counts[MERGE_CLASSIFICATION.SHARED_STATE] > 0
    || summary.counts[MERGE_CLASSIFICATION.NEEDS_HUMAN] > 0
  );
}

function unsafeFiles(summary) {
  return summary.entries.filter((entry) => (
    entry.classification === MERGE_CLASSIFICATION.SHARED_STATE
    || entry.classification === MERGE_CLASSIFICATION.NEEDS_HUMAN
  ));
}

function commitMessage({ jobId, issueNumber }) {
  return [
    `Finalize CPB job ${jobId} for issue #${issueNumber}`,
    "",
    `CPB-Job: ${jobId}`,
    `Issue: #${issueNumber}`,
  ].join("\n");
}

export async function finalizeSuccessfulQueueEntry({
  cpbRoot,
  project,
  entry,
  job,
  sourcePath,
  mode = "local",
  remote = "origin",
  issueCloser,
  runCommand = execFileAsync,
  createPullRequest,
  pushToken = null,
  dataRoot,
} = {}) {
  const jobId = job?.jobId || job?.id || entry?.jobId || entry?.id || "unknown";
  const projectId = project || job?.project || entry?.projectId || null;

  if (job?.status !== "completed") {
    return skipped("JOB_NOT_COMPLETED", { jobId });
  }

  const issue = resolveIssue(entry?.metadata);
  if (!issue) {
    return reject("NO_ISSUE_LINK", { jobId });
  }

  if (!job?.worktree || !(await pathExists(job.worktree))) {
    return reject("NO_WORKTREE", { jobId });
  }

  if (!sourcePath || !(await pathExists(sourcePath))) {
    return reject("NO_SOURCE_PATH", { jobId });
  }

  const canonicalSourcePath = await realpath(path.resolve(sourcePath));
  const canonicalWorktreePath = await realpath(path.resolve(job.worktree));

  if (!(await isGitRepo(canonicalSourcePath, { runCommand }))) {
    return reject("SOURCE_NOT_GIT_REPO", { jobId });
  }

  if (!(await assertClean(canonicalSourcePath, { runCommand }))) {
    return reject("SOURCE_NOT_CLEAN", { jobId });
  }

  if (!(await isGitRepo(canonicalWorktreePath, { runCommand }))) {
    return reject("WORKTREE_NOT_GIT_REPO", { jobId });
  }

  const sourceBranch = await currentBranch(canonicalSourcePath, { runCommand });
  if (!sourceBranch) {
    return reject("NO_SOURCE_BRANCH", { issue, jobId });
  }

  const sourceHead = await revParse(canonicalSourcePath, "HEAD", { runCommand });
  const worktreeBranch = await currentBranch(canonicalWorktreePath, { runCommand });
  const worktreeHead = await revParse(canonicalWorktreePath, "HEAD", { runCommand });
  const uncommittedFiles = await changedWorktreeFiles(canonicalWorktreePath, { runCommand });
  let committedFiles = [];
  if (worktreeHead !== sourceHead) {
    if (!(await isAncestor(canonicalWorktreePath, sourceHead, worktreeHead, { runCommand }))) {
      return reject("WORKTREE_NOT_DESCENDANT", {
        issue,
        jobId,
        sourceHead,
        worktreeHead,
      });
    }
    committedFiles = await diffFiles(canonicalWorktreePath, sourceHead, worktreeHead, { runCommand });
  }

  const files = [...new Set([...committedFiles, ...uncommittedFiles])];
  if (files.length === 0) {
    return skipped("NO_CHANGES", { issue, jobId });
  }

  const summary = summarizeMergeFiles(files);
  if (hasUnsafeChanges(summary)) {
    return reject("UNSAFE_WORKTREE_CHANGES", {
      issue,
      jobId,
      files: summary.entries,
      unsafeFiles: unsafeFiles(summary),
    });
  }

  const planned = {
    commit: uncommittedFiles.length > 0,
    merge: mode === "local" || mode === "remote",
    push: mode === "remote" || mode === "pr",
    closeIssue: mode === "remote",
    pullRequest: mode === "pr",
  };

  if (mode === "dry-run") {
    return {
      ok: true,
      status: "dry-run",
      issue,
      mode,
      sourcePath: canonicalSourcePath,
      worktreePath: canonicalWorktreePath,
      sourceBranch,
      worktreeBranch,
      sourceHead,
      worktreeHead,
      files: summary.entries,
      planned,
    };
  }

  if (mode !== "local" && mode !== "remote" && mode !== "pr") {
    return reject("UNSUPPORTED_MODE", { mode, jobId });
  }

  if (mode === "pr") {
    if (!cpbRoot || !projectId || !job?.jobId) {
      return reject("PR_FINALIZE_REQUIRES_JOB_STORE", { issue, jobId });
    }
    const prJob = {
      ...job,
      worktree: canonicalWorktreePath,
      worktreeBranch: job.worktreeBranch || worktreeBranch,
      worktreeBaseBranch: job.worktreeBaseBranch || sourceBranch,
      sourceContext: {
        ...(job.sourceContext || {}),
        type: "github_issue",
        repo: issue.repo,
        issueNumber: issue.number,
        issueTitle: job.sourceContext?.issueTitle || entry?.metadata?.issueTitle || job.task || null,
      },
    };
    const pr = await openDraftPullRequest({
      job: prJob,
      verdict: "PASS",
      branchPushed: false,
      createPullRequest,
      runCommand,
      pushToken,
    });
    if (pr.status !== "pr.opened") {
      return reject("PR_FINALIZE_FAILED", {
        issue,
        jobId,
        pr,
      }, pr.error || null);
    }

    await appendEvent(cpbRoot, projectId, job.jobId, {
      type: "pr_opened",
      jobId: job.jobId,
      project: projectId,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      artifact: pr.request?.body ? { type: "github_pr", url: pr.prUrl, number: pr.prNumber } : null,
      ts: new Date().toISOString(),
    }, { dataRoot });

    const commit = pr.branchPreparation?.commit || await revParse(canonicalWorktreePath, "HEAD", { runCommand });
    return {
      ok: true,
      status: "pr.opened",
      mode,
      issue,
      jobId,
      commit,
      sourcePath: canonicalSourcePath,
      worktreePath: canonicalWorktreePath,
      sourceBranch,
      worktreeBranch: pr.request?.head || prJob.worktreeBranch,
      sourceHead,
      files: summary.entries,
      pushed: true,
      closed: false,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      pr,
    };
  }

  let commit = worktreeHead;
  if (uncommittedFiles.length > 0) {
    await runGit(canonicalWorktreePath, ["add", "--all"], { runCommand });
    await runGit(canonicalWorktreePath, [
      "commit",
      "-m",
      commitMessage({ jobId, issueNumber: issue.number }),
    ], { runCommand });
    commit = await revParse(canonicalWorktreePath, "HEAD", { runCommand });
  }

  let pushed = false;
  let closed = false;
  if (mode === "remote") {
    try {
      await runGit(canonicalWorktreePath, ["push", remote, `${commit}:refs/heads/${sourceBranch}`], { runCommand });
      pushed = true;
      if (issueCloser) {
        await issueCloser({
          repo: issue.repo,
          number: issue.number,
          url: issue.url,
          jobId,
          commit,
        });
        closed = true;
      }
      await runGit(canonicalSourcePath, ["merge", "--ff-only", commit], { runCommand });
    } catch (err) {
      return reject("REMOTE_FINALIZE_FAILED", {
        issue,
        jobId,
        commit,
        pushed,
        closed,
        message: String(err?.stderr || err?.stdout || err?.message || "").trim(),
      });
    }
  } else {
    try {
      await runGit(canonicalSourcePath, ["merge", "--ff-only", commit], { runCommand });
    } catch (err) {
      return reject("MERGE_FAILED", {
        issue,
        jobId,
        commit,
        message: String(err?.stderr || err?.stdout || err?.message || "").trim(),
      });
    }
  }

  return {
    ok: true,
    status: "finalized",
    mode,
    issue,
    jobId,
    commit,
    sourcePath: canonicalSourcePath,
    worktreePath: canonicalWorktreePath,
    sourceBranch,
    worktreeBranch,
    sourceHead,
    files: summary.entries,
    pushed,
    closed,
  };
}
