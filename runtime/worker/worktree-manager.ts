// @ts-nocheck
/**
 * Worktree Manager — isolated worktree creation with retry and cleanup.
 *
 * Extracted from managed-worker.js for single-responsibility:
 * worktree lifecycle only.
 */

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import { createWorktree } from "../git/worktree.js";

const execFileAsync = promisify(_execFile);

export const WORKTREE_SLUG = "pipeline";
export const WORKTREE_CREATE_MAX_ATTEMPTS = 3;
export const WORKTREE_CREATE_RETRY_DELAY_MS = 500;

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function childPathOf(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalPath(candidate) {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function assertIsolatedWorktree({ sourcePath, worktreesRoot, worktreeInfo }) {
  if (!worktreeInfo?.path) {
    throw new Error("worktree creation returned no path");
  }

  const sourceReal = await canonicalPath(sourcePath);
  const worktreeReal = await canonicalPath(worktreeInfo.path);
  if (sourceReal === worktreeReal) {
    throw new Error("worktree path resolves to the source checkout");
  }

  if (!childPathOf(worktreesRoot, worktreeInfo.path)) {
    throw new Error(`worktree path outside managed worktrees root: ${worktreeInfo.path}`);
  }
}

export async function cleanupFailedWorktreeCreate({
  sourcePath,
  worktreePath,
  branch,
  runGit = execFileAsync,
  removePath = rm,
  log = null,
}) {
  const gitOpts = { cwd: sourcePath, maxBuffer: 10 * 1024 * 1024 };
  try {
    await runGit("git", ["worktree", "remove", "--force", worktreePath], gitOpts);
  } catch (err) {
    log?.debug?.(`worktree retry cleanup remove skipped: ${err.message}`);
  }
  try {
    await removePath(worktreePath, { recursive: true, force: true });
  } catch (err) {
    log?.debug?.(`worktree retry cleanup rm skipped: ${err.message}`);
  }
  try {
    await runGit("git", ["branch", "-D", branch], gitOpts);
  } catch (err) {
    log?.debug?.(`worktree retry cleanup branch skipped: ${err.message}`);
  }
  try {
    await runGit("git", ["worktree", "prune"], gitOpts);
  } catch (err) {
    log?.debug?.(`worktree retry cleanup prune skipped: ${err.message}`);
  }
}

export async function createIsolatedWorktreeWithRetry({
  hubRoot,
  sourcePath,
  entryId,
  slug = WORKTREE_SLUG,
  create = createWorktree,
  runGit = execFileAsync,
  removePath = rm,
  maxAttempts = WORKTREE_CREATE_MAX_ATTEMPTS,
  retryDelayMs = WORKTREE_CREATE_RETRY_DELAY_MS,
  log = null,
} = {}) {
  if (!hubRoot) throw new Error("hubRoot is required for worktree isolation");
  if (!sourcePath) throw new Error("sourcePath is required for worktree isolation");
  if (!entryId) throw new Error("entryId is required for worktree isolation");

  const worktreesRoot = path.join(hubRoot, "worktrees");
  const worktreeJobId = `job-${entryId}`;
  const branch = `cpb/${worktreeJobId}-${slug}`;
  const worktreePath = path.resolve(worktreesRoot, `${worktreeJobId}-${slug}`);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const info = await create({
        project: sourcePath,
        jobId: worktreeJobId,
        slug,
        worktreesRoot,
      });
      await assertIsolatedWorktree({ sourcePath, worktreesRoot, worktreeInfo: info });
      if (attempt > 1) {
        log?.info?.(`worktree created after retry ${attempt}/${maxAttempts}: ${info.branch} at ${info.path}`);
      }
      return info;
    } catch (err) {
      lastError = err;
      log?.warn?.(`worktree create attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      await cleanupFailedWorktreeCreate({
        sourcePath,
        worktreePath,
        branch,
        runGit,
        removePath,
        log,
      });
      if (attempt < maxAttempts) await delay(retryDelayMs);
    }
  }

  const failure = new Error(
    `worktree creation failed after ${maxAttempts} attempts; refusing to run against source checkout: ${lastError?.message || "unknown error"}`,
  );
  failure.code = "WORKTREE_UNAVAILABLE";
  throw failure;
}
