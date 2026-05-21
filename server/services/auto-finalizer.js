import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  MERGE_CLASSIFICATION,
  summarizeMergeFiles,
} from "./merge-steward.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("git", args, {
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

async function isGitRepo(repoPath) {
  const result = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"], {
    allowFailure: true,
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function assertClean(repoPath) {
  const status = await runGit(repoPath, ["status", "--porcelain"]);
  return status.stdout.trim() === "";
}

async function currentBranch(repoPath) {
  return (await runGit(repoPath, ["branch", "--show-current"])).stdout.trim();
}

async function revParse(repoPath, ref = "HEAD") {
  return (await runGit(repoPath, ["rev-parse", "--verify", ref])).stdout.trim();
}

async function diffFiles(repoPath, fromRef, toRef) {
  const result = await runGit(repoPath, ["diff", "--name-only", "-z", fromRef, toRef]);
  return splitNul(result.stdout);
}

async function isAncestor(repoPath, ancestor, descendant) {
  const result = await runGit(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
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

async function changedWorktreeFiles(worktreePath) {
  const [unstaged, staged, untracked] = await Promise.all([
    runGit(worktreePath, ["diff", "--name-only", "-z"]),
    runGit(worktreePath, ["diff", "--cached", "--name-only", "-z"]),
    runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
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
  entry,
  job,
  sourcePath,
  mode = "local",
  remote = "origin",
  issueCloser,
} = {}) {
  const jobId = job?.jobId || job?.id || entry?.jobId || entry?.id || "unknown";

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

  if (!(await isGitRepo(canonicalSourcePath))) {
    return reject("SOURCE_NOT_GIT_REPO", { jobId });
  }

  if (!(await assertClean(canonicalSourcePath))) {
    return reject("SOURCE_NOT_CLEAN", { jobId });
  }

  if (!(await isGitRepo(canonicalWorktreePath))) {
    return reject("WORKTREE_NOT_GIT_REPO", { jobId });
  }

  const sourceBranch = await currentBranch(canonicalSourcePath);
  if (!sourceBranch) {
    return reject("NO_SOURCE_BRANCH", { issue, jobId });
  }

  const sourceHead = await revParse(canonicalSourcePath);
  const worktreeBranch = await currentBranch(canonicalWorktreePath);
  const worktreeHead = await revParse(canonicalWorktreePath);
  const uncommittedFiles = await changedWorktreeFiles(canonicalWorktreePath);
  let committedFiles = [];
  if (worktreeHead !== sourceHead) {
    if (!(await isAncestor(canonicalWorktreePath, sourceHead, worktreeHead))) {
      return reject("WORKTREE_NOT_DESCENDANT", {
        issue,
        jobId,
        sourceHead,
        worktreeHead,
      });
    }
    committedFiles = await diffFiles(canonicalWorktreePath, sourceHead, worktreeHead);
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
    push: mode === "remote",
    closeIssue: mode === "remote",
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

  if (mode !== "local" && mode !== "remote") {
    return reject("UNSUPPORTED_MODE", { mode, jobId });
  }

  let commit = worktreeHead;
  if (uncommittedFiles.length > 0) {
    await runGit(canonicalWorktreePath, ["add", "--all"]);
    await runGit(canonicalWorktreePath, [
      "commit",
      "-m",
      commitMessage({ jobId, issueNumber: issue.number }),
    ]);
    commit = await revParse(canonicalWorktreePath);
  }

  let pushed = false;
  let closed = false;
  if (mode === "remote") {
    try {
      await runGit(canonicalWorktreePath, ["push", remote, `${commit}:refs/heads/${sourceBranch}`]);
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
      await runGit(canonicalSourcePath, ["merge", "--ff-only", commit]);
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
      await runGit(canonicalSourcePath, ["merge", "--ff-only", commit]);
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
