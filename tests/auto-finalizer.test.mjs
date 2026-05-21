import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { finalizeSuccessfulQueueEntry } from "../server/services/auto-finalizer.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
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

async function createRepoWithWorktree(t, { remote = false } = {}) {
  const root = await createTempDir(t, "cpb-auto-finalizer-");
  const source = path.join(root, "source");
  const bare = path.join(root, "remote.git");

  await mkdir(source, { recursive: true });
  await git(source, ["init", "-b", "main"]);
  await git(source, ["config", "user.email", "test@example.invalid"]);
  await git(source, ["config", "user.name", "Test User"]);
  await writeRepoFile(source, "src/app.js", "export const value = 'base';\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "base"]);

  if (remote) {
    await git(root, ["init", "--bare", bare]);
    await git(source, ["remote", "add", "origin", bare]);
    await git(source, ["push", "-u", "origin", "main"]);
  }

  const worktree = path.join(root, "worktree");
  await git(source, ["worktree", "add", "-b", "cpb/job-58", worktree, "main"]);
  await git(worktree, ["config", "user.email", "test@example.invalid"]);
  await git(worktree, ["config", "user.name", "Test User"]);

  return { source, worktree, bare };
}

function completedJob(worktree, overrides = {}) {
  return {
    id: "job-58",
    status: "completed",
    worktree,
    ...overrides,
  };
}

function linkedEntry(overrides = {}) {
  return {
    id: "entry-58",
    metadata: {
      issueNumber: 58,
      repositoryFullName: "owner/repo",
      ...overrides,
    },
  };
}

async function logSubjects(repoRoot) {
  const result = await git(repoRoot, ["log", "--format=%s"]);
  return result.stdout.trim().split("\n").filter(Boolean);
}

async function head(repoRoot) {
  return (await git(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
}

test("local success commits worktree changes and merges them into source", async (t) => {
  const { source, worktree } = await createRepoWithWorktree(t);
  await writeRepoFile(worktree, "src/feature.js", "export const feature = true;\n");

  const result = await finalizeSuccessfulQueueEntry({
    entry: linkedEntry(),
    job: completedJob(worktree),
    sourcePath: source,
    mode: "local",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "finalized");
  assert.equal(result.pushed, false);
  assert.equal(result.closed, false);
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(result.files.map((entry) => entry.file), ["src/feature.js"]);

  const sourceHead = (await git(source, ["rev-parse", "HEAD"])).stdout.trim();
  assert.equal(sourceHead, result.commit);
  const subjects = await logSubjects(source);
  assert.equal(subjects[0], "Finalize CPB job job-58 for issue #58");
});

test("missing issue link is rejected", async (t) => {
  const { source, worktree } = await createRepoWithWorktree(t);
  await writeRepoFile(worktree, "src/feature.js", "export const feature = true;\n");

  const result = await finalizeSuccessfulQueueEntry({
    entry: { id: "entry-58", metadata: {} },
    job: completedJob(worktree),
    sourcePath: source,
  });

  assert.deepEqual(result, {
    ok: false,
    status: "rejected",
    code: "NO_ISSUE_LINK",
    jobId: "job-58",
  });
  assert.deepEqual(await logSubjects(source), ["base"]);
});

test("shared wiki and cpb-task changes are rejected", async (t) => {
  const { source, worktree } = await createRepoWithWorktree(t);
  await writeRepoFile(worktree, "wiki/projects/flow/notes.md", "shared state\n");
  await writeRepoFile(worktree, "cpb-task/artifacts/job-58/manifest.json", "{}\n");

  const result = await finalizeSuccessfulQueueEntry({
    entry: linkedEntry({ issueUrl: "https://github.com/owner/repo/issues/58" }),
    job: completedJob(worktree),
    sourcePath: source,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "UNSAFE_WORKTREE_CHANGES");
  assert.deepEqual(result.unsafeFiles.map((entry) => entry.file), [
    "cpb-task/artifacts/job-58/manifest.json",
    "wiki/projects/flow/notes.md",
  ]);
  assert.deepEqual(await logSubjects(source), ["base"]);
});

test("remote success pushes and calls injected issue closer", async (t) => {
  const { source, worktree, bare } = await createRepoWithWorktree(t, { remote: true });
  await writeRepoFile(worktree, "src/remote-feature.js", "export const remoteFeature = true;\n");
  const closerCalls = [];

  const result = await finalizeSuccessfulQueueEntry({
    entry: linkedEntry({ issueUrl: "https://github.com/owner/repo/issues/58" }),
    job: completedJob(worktree),
    sourcePath: source,
    mode: "remote",
    issueCloser: async (payload) => {
      closerCalls.push(payload);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.pushed, true);
  assert.equal(result.closed, true);
  assert.deepEqual(closerCalls, [{
    repo: "owner/repo",
    number: 58,
    url: "https://github.com/owner/repo/issues/58",
    jobId: "job-58",
    commit: result.commit,
  }]);

  const remoteHead = (await git(bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
  assert.equal(remoteHead, result.commit);
});

test("remote push failure keeps source branch unchanged and does not close issue", async (t) => {
  const { source, worktree, bare } = await createRepoWithWorktree(t, { remote: true });
  await writeRepoFile(worktree, "src/push-failure.js", "export const pushFailure = true;\n");
  const beforeSourceHead = await head(source);
  const issueCalls = [];

  const result = await finalizeSuccessfulQueueEntry({
    entry: linkedEntry({ issueUrl: "https://github.com/owner/repo/issues/58" }),
    job: completedJob(worktree),
    sourcePath: source,
    mode: "remote",
    remote: "missing",
    issueCloser: async (payload) => {
      issueCalls.push(payload);
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "REMOTE_FINALIZE_FAILED");
  assert.equal(result.pushed, false);
  assert.equal(result.closed, false);
  assert.deepEqual(issueCalls, []);
  assert.equal(await head(source), beforeSourceHead);

  const remoteHead = (await git(bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
  assert.equal(remoteHead, beforeSourceHead);
});

test("issue close failure leaves source branch unchanged after remote push", async (t) => {
  const { source, worktree, bare } = await createRepoWithWorktree(t, { remote: true });
  await writeRepoFile(worktree, "src/close-failure.js", "export const closeFailure = true;\n");
  const beforeSourceHead = await head(source);

  const result = await finalizeSuccessfulQueueEntry({
    entry: linkedEntry({ issueUrl: "https://github.com/owner/repo/issues/58" }),
    job: completedJob(worktree),
    sourcePath: source,
    mode: "remote",
    issueCloser: async () => {
      throw new Error("issue close failed");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "rejected");
  assert.equal(result.code, "REMOTE_FINALIZE_FAILED");
  assert.equal(result.pushed, true);
  assert.equal(result.closed, false);
  assert.match(result.commit, /^[0-9a-f]{40}$/);
  assert.equal(await head(source), beforeSourceHead);

  const remoteHead = (await git(bare, ["rev-parse", "refs/heads/main"])).stdout.trim();
  assert.equal(remoteHead, result.commit);
});

test("job that is not completed is skipped", async (t) => {
  const { source, worktree } = await createRepoWithWorktree(t);
  await writeRepoFile(worktree, "src/feature.js", "export const feature = true;\n");

  const result = await finalizeSuccessfulQueueEntry({
    entry: linkedEntry(),
    job: completedJob(worktree, { status: "running" }),
    sourcePath: source,
  });

  assert.deepEqual(result, {
    ok: false,
    status: "skipped",
    code: "JOB_NOT_COMPLETED",
    jobId: "job-58",
  });
  assert.deepEqual(await logSubjects(source), ["base"]);
});

test("dry-run reports planned work without creating a commit", async (t) => {
  const { source, worktree } = await createRepoWithWorktree(t);
  await writeRepoFile(worktree, "src/dry-run.js", "export const dryRun = true;\n");
  const beforeHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();

  const result = await finalizeSuccessfulQueueEntry({
    entry: linkedEntry(),
    job: completedJob(worktree),
    sourcePath: source,
    mode: "dry-run",
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "dry-run");
  assert.deepEqual(result.planned, {
    commit: true,
    merge: false,
    push: false,
    closeIssue: false,
  });
  assert.deepEqual(result.files.map((entry) => entry.file), ["src/dry-run.js"]);

  const afterHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  assert.equal(afterHead, beforeHead);
  assert.deepEqual(await logSubjects(source), ["base"]);
});
