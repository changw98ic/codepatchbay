import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { tempRoot } from "../helpers.js";
import { createWorktree } from "../../runtime/git/worktree.js";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CodePatchbay Test",
      GIT_AUTHOR_EMAIL: "cpb-test@local.invalid",
      GIT_COMMITTER_NAME: "CodePatchbay Test",
      GIT_COMMITTER_EMAIL: "cpb-test@local.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test("createWorktree initializes isolated codegraph while reusing installed dependencies", async () => {
  const root = await tempRoot("cpb-worktree-codegraph");
  const project = path.join(root, "project");
  const worktreesRoot = path.join(root, "worktrees");
  const sourceNodeModules = path.join(project, "node_modules");
  const initCalls = [];
  await mkdir(path.join(project, ".codegraph"), { recursive: true });
  await mkdir(path.join(sourceNodeModules, "chokidar"), { recursive: true });
  await writeFile(path.join(sourceNodeModules, "chokidar", "package.json"), "{\"name\":\"chokidar\"}\n", "utf8");
  await writeFile(path.join(project, "README.md"), "# source\n", "utf8");
  await writeFile(path.join(project, ".env.example"), "TOKEN=example\n", "utf8");
  git(project, ["init"]);
  git(project, ["add", "README.md", ".env.example"]);
  git(project, ["commit", "-m", "Initial"]);
  const sourceHead = git(project, ["rev-parse", "HEAD"]).stdout.trim();
  const initCodegraph = async (worktreePath) => {
    initCalls.push(worktreePath);
    await mkdir(path.join(worktreePath, ".codegraph"), { recursive: true });
    await writeFile(path.join(worktreePath, ".codegraph", "index.sqlite"), "", "utf8");
  };

  const created = await createWorktree({
    project,
    jobId: "job-codegraph",
    slug: "pipeline",
    worktreesRoot,
    initCodegraph,
  });
  const worktreeCodegraph = path.join(created.path, ".codegraph");
  const worktreeNodeModules = path.join(created.path, "node_modules");

  assert.deepEqual(initCalls, [created.path]);
  assert.equal((await lstat(worktreeCodegraph)).isDirectory(), true);
  assert.notEqual(await realpath(worktreeCodegraph), await realpath(path.join(project, ".codegraph")));
  assert.equal((await lstat(worktreeNodeModules)).isSymbolicLink(), true);
  assert.equal(await realpath(worktreeNodeModules), await realpath(sourceNodeModules));
  assert.equal(git(project, ["rev-parse", "HEAD"]).stdout.trim(), sourceHead);
  assert.equal(git(project, ["diff", "--exit-code", "HEAD"]).stdout.trim(), "");
  assert.equal(git(project, ["ls-files", "--error-unmatch", ".env.example"]).stdout.trim(), ".env.example");
  await assert.rejects(readFile(path.join(project, ".gitignore"), "utf8"), { code: "ENOENT" });

  const excludePathResult = git(created.path, ["rev-parse", "--git-path", "info/exclude"]);
  const excludePath = path.isAbsolute(excludePathResult.stdout.trim())
    ? excludePathResult.stdout.trim()
    : path.join(created.path, excludePathResult.stdout.trim());
  const exclude = await readFile(excludePath, "utf8");
  assert.match(exclude, /^\.codegraph$/m);
  assert.match(exclude, /^\.claude\/$/m);
  assert.match(exclude, /^\.codex\/$/m);
  assert.match(exclude, /^cpb-task\/$/m);
  assert.match(exclude, /^node_modules$/m);
  assert.match(exclude, /^node_modules\/$/m);

  await mkdir(path.join(created.path, ".claude"), { recursive: true });
  await mkdir(path.join(created.path, "cpb-task"), { recursive: true });
  await writeFile(path.join(created.path, ".claude", "settings.local.json"), "{}\n", "utf8");
  await writeFile(path.join(created.path, "cpb-task", "codegraph-state.json"), "{}\n", "utf8");
  assert.equal(git(created.path, ["status", "--short", "--untracked-files=all"]).stdout.trim(), "");

  await rm(worktreeCodegraph, { recursive: true, force: true });
  await symlink(path.join(project, ".codegraph"), worktreeCodegraph, "dir");
  const reused = await createWorktree({
    project,
    jobId: "job-codegraph",
    slug: "pipeline",
    worktreesRoot,
    initCodegraph,
  });

  assert.equal(reused.path, created.path);
  assert.deepEqual(initCalls, [created.path, created.path]);
  assert.equal((await lstat(worktreeCodegraph)).isDirectory(), true);
  assert.notEqual(await realpath(worktreeCodegraph), await realpath(path.join(project, ".codegraph")));
  assert.equal((await lstat(worktreeNodeModules)).isSymbolicLink(), true);
  assert.equal(await realpath(worktreeNodeModules), await realpath(sourceNodeModules));

  const reusedExistingIndex = await createWorktree({
    project,
    jobId: "job-codegraph",
    slug: "pipeline",
    worktreesRoot,
    initCodegraph,
  });

  assert.equal(reusedExistingIndex.path, created.path);
  assert.deepEqual(initCalls, [created.path, created.path, created.path]);

  const skippedCodegraph = await createWorktree({
    project,
    jobId: "job-no-codegraph",
    slug: "pipeline",
    worktreesRoot,
    initCodegraph: async () => {
      throw new Error("codegraph init should be skipped");
    },
    codegraphEnabled: false,
  });

  assert.deepEqual(initCalls, [created.path, created.path, created.path]);
  await assert.rejects(lstat(path.join(skippedCodegraph.path, ".codegraph")), { code: "ENOENT" });
  assert.equal((await lstat(path.join(skippedCodegraph.path, "node_modules"))).isSymbolicLink(), true);
});

test("worktree setup never fabricates CodeGraph readiness with a detached sentinel", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "..", "..", "..", "runtime", "git", "worktree.ts"), "utf8");
  assert.doesNotMatch(source, /cpb_worktree_readiness_sentinel/);
  assert.doesNotMatch(source, /setInterval\(\(\) => \{\}, 2147483647\)/);
});
