import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
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

test("createWorktree reuses installed dependencies without initializing a code index", async () => {
  const root = await tempRoot("cpb-worktree-local-index");
  const project = path.join(root, "project");
  const worktreesRoot = path.join(root, "worktrees");
  const sourceNodeModules = path.join(project, "node_modules");
  await mkdir(path.join(sourceNodeModules, "chokidar"), { recursive: true });
  await writeFile(path.join(sourceNodeModules, "chokidar", "package.json"), "{\"name\":\"chokidar\"}\n", "utf8");
  await writeFile(path.join(project, "README.md"), "# source\n", "utf8");
  await writeFile(path.join(project, ".env.example"), "TOKEN=example\n", "utf8");
  git(project, ["init"]);
  git(project, ["add", "README.md", ".env.example"]);
  git(project, ["commit", "-m", "Initial"]);
  const sourceHead = git(project, ["rev-parse", "HEAD"]).stdout.trim();
  const sourceBranch = git(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  const created = await createWorktree({
    project,
    jobId: "job-local-index",
    slug: "pipeline",
    worktreesRoot,
  });
  const worktreeNodeModules = path.join(created.path, "node_modules");

  assert.equal(created.baseBranch, sourceBranch);
  assert.equal(created.baseCommit, sourceHead);
  assert.equal(created.ownership.state, "ready");
  assert.equal(created.ownership.baseBranch, sourceBranch);
  assert.equal(created.ownership.baseCommit, sourceHead);
  assert.match(created.ownership.ownerToken, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    JSON.parse(git(project, [
      "config",
      "--local",
      "--get",
      `branch.${created.branch}.cpbBaseBinding`,
    ]).stdout.trim()),
    created.ownership,
  );
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
  assert.match(exclude, /^\.claude\/$/m);
  assert.match(exclude, /^\.codex\/$/m);
  assert.match(exclude, /^node_modules$/m);
  assert.match(exclude, /^node_modules\/$/m);

  await mkdir(path.join(created.path, ".claude"), { recursive: true });
  await writeFile(path.join(created.path, ".claude", "settings.local.json"), "{}\n", "utf8");
  assert.equal(git(created.path, ["status", "--short", "--untracked-files=all"]).stdout.trim(), "");
});

test("createWorktree preserves an unregistered managed branch instead of deleting recovery state", async () => {
  const root = await tempRoot("cpb-worktree-stale-branch");
  const project = path.join(root, "project");
  const worktreesRoot = path.join(root, "worktrees");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "README.md"), "# source\n", "utf8");
  git(project, ["init"]);
  git(project, ["add", "README.md"]);
  git(project, ["commit", "-m", "Initial"]);

  const branch = "cpb/job-stale-pipeline";
  git(project, ["branch", branch]);
  const retainedCommit = git(project, ["rev-parse", `refs/heads/${branch}`]).stdout.trim();

  await assert.rejects(
    createWorktree({
      project,
      jobId: "job-stale",
      slug: "pipeline",
      worktreesRoot,
    }),
    /branch exists without the exact registered worktree/i,
  );

  assert.equal(git(project, ["rev-parse", `refs/heads/${branch}`]).stdout.trim(), retainedCommit);
  assert.equal(git(project, ["worktree", "list", "--porcelain"]).stdout.includes(`branch refs/heads/${branch}`), false);
});

test("createWorktree rejects a same-path Git successor that does not match create-time ownership", async () => {
  const root = await tempRoot("cpb-worktree-owned-successor");
  const project = path.join(root, "project");
  const worktreesRoot = path.join(root, "worktrees");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "README.md"), "# source\n", "utf8");
  git(project, ["init"]);
  git(project, ["add", "README.md"]);
  git(project, ["commit", "-m", "Initial"]);

  const created = await createWorktree({
    project,
    jobId: "job-successor",
    slug: "pipeline",
    worktreesRoot,
  });
  const predecessorIdentity = created.ownership.directory;
  const retained = `${created.path}.predecessor`;
  await rename(created.path, retained);
  git(project, ["worktree", "prune", "--expire", "now"]);
  git(project, ["worktree", "add", created.path, created.branch]);
  const successor = await lstat(created.path, { bigint: true });
  assert.notEqual(String(successor.ino), predecessorIdentity.ino);

  await assert.rejects(
    createWorktree({
      project,
      jobId: "job-successor",
      slug: "pipeline",
      worktreesRoot,
    }),
    /no longer matches its durable ownership binding/i,
  );
  assert.equal((await lstat(created.path)).isDirectory(), true);
  assert.equal((await lstat(retained)).isDirectory(), true);
});
