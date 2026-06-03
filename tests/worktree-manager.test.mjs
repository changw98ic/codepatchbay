import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { tempRoot } from "./helpers.mjs";
import { createWorktree } from "../runtime/git/worktree.js";

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

async function missing(filePath) {
  try {
    await lstat(filePath);
    return false;
  } catch (err) {
    if (err?.code === "ENOENT") return true;
    throw err;
  }
}

test("createWorktree isolates codegraph while reusing installed dependencies", async () => {
  const root = await tempRoot("cpb-worktree-codegraph");
  const project = path.join(root, "project");
  const worktreesRoot = path.join(root, "worktrees");
  const sourceNodeModules = path.join(project, "node_modules");
  await mkdir(path.join(project, ".codegraph"), { recursive: true });
  await mkdir(path.join(sourceNodeModules, "chokidar"), { recursive: true });
  await writeFile(path.join(sourceNodeModules, "chokidar", "package.json"), "{\"name\":\"chokidar\"}\n", "utf8");
  await writeFile(path.join(project, "README.md"), "# source\n", "utf8");
  git(project, ["init"]);
  git(project, ["add", "README.md"]);
  git(project, ["commit", "-m", "Initial"]);

  const created = await createWorktree({
    project,
    jobId: "job-codegraph",
    slug: "pipeline",
    worktreesRoot,
  });
  const worktreeCodegraph = path.join(created.path, ".codegraph");
  const worktreeNodeModules = path.join(created.path, "node_modules");

  assert.equal(await missing(worktreeCodegraph), true);
  assert.equal((await lstat(worktreeNodeModules)).isSymbolicLink(), true);
  assert.equal(await realpath(worktreeNodeModules), await realpath(sourceNodeModules));

  await symlink(path.join(project, ".codegraph"), worktreeCodegraph, "dir");
  const reused = await createWorktree({
    project,
    jobId: "job-codegraph",
    slug: "pipeline",
    worktreesRoot,
  });

  assert.equal(reused.path, created.path);
  assert.equal(await missing(worktreeCodegraph), true);
  assert.equal((await lstat(worktreeNodeModules)).isSymbolicLink(), true);
  assert.equal(await realpath(worktreeNodeModules), await realpath(sourceNodeModules));
});
