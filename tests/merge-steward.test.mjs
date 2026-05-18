import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  classifyMergePath,
  MERGE_CLASSIFICATION,
  previewMerge,
  summarizeMergeFiles,
} from "../server/services/merge-steward.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return await execFileAsync("git", args, { cwd });
}

async function writeRepoFile(repoRoot, relativePath, content) {
  const filePath = path.join(repoRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function createTempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createRepo(t) {
  const repoRoot = await createTempDir(t, "cpb-merge-steward-test-");
  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.email", "test@example.com"]);
  await git(repoRoot, ["config", "user.name", "Test User"]);
  await writeRepoFile(repoRoot, "src/app.js", "export const value = 'base';\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "base"]);
  await git(repoRoot, ["branch", "base"]);
  return repoRoot;
}

async function createCandidateWorktree(t, repoRoot, branchName, startPoint = "base") {
  const worktreeParent = await mkdtemp(path.join(tmpdir(), "cpb-merge-steward-worktree-"));
  const worktreePath = path.join(worktreeParent, "worktree");
  await git(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, startPoint]);
  t.after(async () => {
    await git(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(() => {});
    await rm(worktreeParent, { recursive: true, force: true });
  });
  return worktreePath;
}

async function runCpb(args, { env = {} } = {}) {
  return await execFileAsync("./cpb", args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  });
}

test("classifyMergePath separates shared state, human-gated files, and code", () => {
  assert.equal(
    classifyMergePath("wiki/projects/flow/outputs/deliverable-001.md"),
    MERGE_CLASSIFICATION.SHARED_STATE,
  );
  assert.equal(
    classifyMergePath("cpb-task/artifacts/flow/job-1/verification-manifest.json"),
    MERGE_CLASSIFICATION.SHARED_STATE,
  );
  assert.equal(classifyMergePath("events/runtime.jsonl"), MERGE_CLASSIFICATION.SHARED_STATE);
  assert.equal(classifyMergePath("AGENTS.md"), MERGE_CLASSIFICATION.NEEDS_HUMAN);
  assert.equal(classifyMergePath("docs/guidance-schema.md"), MERGE_CLASSIFICATION.NEEDS_HUMAN);
  assert.equal(classifyMergePath("server/services/executor.js"), MERGE_CLASSIFICATION.RESOLVABLE_CODE);
});

test("summarizeMergeFiles deduplicates paths and counts classifications", () => {
  const summary = summarizeMergeFiles([
    "src/app.js",
    "src/app.js",
    "wiki/system/dashboard.md",
    "CLAUDE.md",
  ]);

  assert.deepEqual(summary.counts, {
    [MERGE_CLASSIFICATION.SHARED_STATE]: 1,
    [MERGE_CLASSIFICATION.NEEDS_HUMAN]: 1,
    [MERGE_CLASSIFICATION.RESOLVABLE_CODE]: 1,
  });
  assert.deepEqual(summary.entries.map((entry) => entry.file), [
    "CLAUDE.md",
    "src/app.js",
    "wiki/system/dashboard.md",
  ]);
});

test("previewMerge rejects clean candidate changes to shared CPB state", async (t) => {
  const repoRoot = await createRepo(t);
  await git(repoRoot, ["checkout", "-b", "candidate"]);
  await writeRepoFile(repoRoot, "wiki/projects/flow/outputs/deliverable-001.md", "evidence\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "candidate shared state"]);
  await git(repoRoot, ["checkout", "base"]);

  const result = await previewMerge({ repoRoot, candidate: "candidate" });

  assert.equal(result.mergeStatus, "clean");
  assert.equal(result.safeForSteward, false);
  assert.equal(result.abortReasons[0].code, "shared_state_changed");
  assert.deepEqual(result.abortReasons[0].files, [
    "wiki/projects/flow/outputs/deliverable-001.md",
  ]);
});

test("previewMerge rejects clean candidate changes to human-gated files", async (t) => {
  const repoRoot = await createRepo(t);
  await git(repoRoot, ["checkout", "-b", "candidate"]);
  await writeRepoFile(repoRoot, "CLAUDE.md", "project agent guidance\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "candidate governance change"]);
  await git(repoRoot, ["checkout", "base"]);

  const result = await previewMerge({ repoRoot, candidate: "candidate" });

  assert.equal(result.mergeStatus, "clean");
  assert.equal(result.safeForSteward, false);
  assert.equal(result.abortReasons[0].code, "needs_human_changed");
  assert.deepEqual(result.abortReasons[0].files, ["CLAUDE.md"]);
});

test("previewMerge allows clean code-only candidate changes", async (t) => {
  const repoRoot = await createRepo(t);
  await git(repoRoot, ["checkout", "-b", "candidate"]);
  await writeRepoFile(repoRoot, "src/feature.js", "export const feature = true;\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "candidate clean code change"]);
  await git(repoRoot, ["checkout", "base"]);

  const result = await previewMerge({ repoRoot, candidate: "candidate" });

  assert.equal(result.mergeStatus, "clean");
  assert.equal(result.safeForSteward, true);
  assert.deepEqual(result.abortReasons, []);
  assert.deepEqual(result.changedFiles, [
    {
      file: "src/feature.js",
      classification: MERGE_CLASSIFICATION.RESOLVABLE_CODE,
    },
  ]);
});

test("previewMerge resolves candidate worktree paths", async (t) => {
  const repoRoot = await createRepo(t);
  const worktreePath = await createCandidateWorktree(t, repoRoot, "candidate-worktree");
  await writeRepoFile(worktreePath, "src/worktree-feature.js", "export const fromWorktree = true;\n");
  await git(worktreePath, ["add", "."]);
  await git(worktreePath, ["commit", "-m", "candidate worktree code change"]);

  const result = await previewMerge({ repoRoot, candidate: worktreePath });

  assert.equal(result.candidate.source, "worktree");
  assert.equal(result.candidate.label, await realpath(worktreePath));
  assert.equal(result.mergeStatus, "clean");
  assert.equal(result.safeForSteward, true);
});

test("previewMerge allows code-only conflicts for merge-steward resolution", async (t) => {
  const repoRoot = await createRepo(t);
  await git(repoRoot, ["checkout", "-b", "candidate"]);
  await writeRepoFile(repoRoot, "src/app.js", "export const value = 'candidate';\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "candidate code change"]);
  await git(repoRoot, ["checkout", "base"]);
  await writeRepoFile(repoRoot, "src/app.js", "export const value = 'base branch';\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "base code change"]);

  const result = await previewMerge({ repoRoot, candidate: "candidate" });

  assert.equal(result.mergeStatus, "conflicts");
  assert.equal(result.safeForSteward, true);
  assert.deepEqual(result.conflictFiles, [
    {
      file: "src/app.js",
      classification: MERGE_CLASSIFICATION.RESOLVABLE_CODE,
    },
  ]);
});

test("cpb merge-preview reports shared-state rejection through the Hub project registry", async (t) => {
  const hubRoot = await createTempDir(t, "cpb-merge-preview-cli-hub-");
  const repoRoot = await createRepo(t);
  await git(repoRoot, ["checkout", "-b", "candidate"]);
  await writeRepoFile(repoRoot, "wiki/system/dashboard.md", "runtime status\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "candidate shared dashboard"]);
  await git(repoRoot, ["checkout", "base"]);

  await runCpb(["attach", repoRoot, "merge-preview-cli"], {
    env: { CPB_HUB_ROOT: hubRoot },
  });

  let stdout = "";
  let exitCode = 0;
  try {
    await runCpb(["merge-preview", "merge-preview-cli", "candidate", "--json"], {
      env: { CPB_HUB_ROOT: hubRoot },
    });
  } catch (err) {
    stdout = err.stdout;
    exitCode = err.code;
  }

  const result = JSON.parse(stdout);
  assert.equal(exitCode, 2);
  assert.equal(result.projectId, "merge-preview-cli");
  assert.equal(result.safeForSteward, false);
  assert.equal(result.abortReasons[0].code, "shared_state_changed");
});

test("cpb merge-preview honors a custom --base ref", async (t) => {
  const hubRoot = await createTempDir(t, "cpb-merge-preview-cli-base-hub-");
  const repoRoot = await createRepo(t);
  await git(repoRoot, ["checkout", "-b", "candidate"]);
  await writeRepoFile(repoRoot, "src/custom-base-feature.js", "export const customBase = true;\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "candidate code change"]);
  await git(repoRoot, ["checkout", "-b", "local-main", "base"]);
  await writeRepoFile(repoRoot, "CLAUDE.md", "local governance state\n");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "local governance change"]);

  await runCpb(["attach", repoRoot, "merge-preview-base-cli"], {
    env: { CPB_HUB_ROOT: hubRoot },
  });

  const { stdout } = await runCpb([
    "merge-preview",
    "merge-preview-base-cli",
    "candidate",
    "--base",
    "base",
    "--json",
  ], {
    env: { CPB_HUB_ROOT: hubRoot },
  });

  const result = JSON.parse(stdout);
  assert.equal(result.projectId, "merge-preview-base-cli");
  assert.equal(result.baseRef, "base");
  assert.equal(result.safeForSteward, true);
  assert.equal(result.mergeStatus, "clean");
});
