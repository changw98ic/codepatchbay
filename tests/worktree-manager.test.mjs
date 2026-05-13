#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnFile } from "./helpers/spawn-file.mjs";

const manager = path.resolve("bridges/worktree-manager.mjs");

async function runManager(args) {
  return await spawnFile(process.execPath, [manager, ...args], {
    cwd: process.cwd(),
  });
}

async function runGit(args, cwd) {
  return await spawnFile("git", args, { cwd });
}

async function mustGit(args, cwd) {
  const result = await spawnFile("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  assert.equal(result.code, 0, `git ${args.join(" ")} failed\n${result.stderr}`);
  return result;
}

const project = await mkdtemp(path.join(tmpdir(), "flow-worktree-project-"));
await writeFile(path.join(project, "README.md"), "# Demo\n", "utf8");
await writeFile(path.join(project, ".env"), "SECRET=do-not-stage\n", "utf8");

const bootstrap = await runManager(["bootstrap", "--project", project]);
assert.equal(
  bootstrap.code,
  0,
  `bootstrap failed\nstdout:\n${bootstrap.stdout}\nstderr:\n${bootstrap.stderr}`
);

const head = await runGit(["rev-parse", "--verify", "HEAD"], project);
assert.equal(head.code, 0, `expected bootstrap to create HEAD\n${head.stderr}`);

const ignoredEnv = await runGit(["check-ignore", ".env"], project);
assert.equal(ignoredEnv.code, 0, "expected .env to be ignored");

const trackedEnv = await runGit(["ls-files", ".env"], project);
assert.equal(trackedEnv.stdout.trim(), "", "bootstrap must not stage ignored .env");

const gitignore = await readFile(path.join(project, ".gitignore"), "utf8");
for (const pattern of [
  ".env",
  ".env.*",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".omc/state/",
  ".omc/worktrees/",
  ".omx/state/",
]) {
  assert.match(gitignore, new RegExp(`(^|\\n)${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\n|$)`));
}

const worktreesRoot = await mkdtemp(path.join(tmpdir(), "flow-worktrees-"));
const create = await runManager([
  "create",
  "--project",
  project,
  "--job-id",
  "job-1",
  "--slug",
  "demo",
  "--worktrees-root",
  worktreesRoot,
]);
assert.equal(create.code, 0, `create failed\nstdout:\n${create.stdout}\nstderr:\n${create.stderr}`);

const created = JSON.parse(create.stdout);
assert.equal(created.branch, "flow/job-1-demo");
assert.equal(created.path, path.join(worktreesRoot, "job-1-demo"));
assert.equal(await readFile(path.join(created.path, "README.md"), "utf8"), "# Demo\n");

const retryCreate = await runManager([
  "create",
  "--project",
  project,
  "--job-id",
  "job-1",
  "--slug",
  "demo",
  "--worktrees-root",
  worktreesRoot,
]);
assert.equal(
  retryCreate.code,
  0,
  `retry create failed\nstdout:\n${retryCreate.stdout}\nstderr:\n${retryCreate.stderr}`
);
assert.deepEqual(JSON.parse(retryCreate.stdout), created);

for (const args of [
  ["create", "--project", project, "--job-id", "../bad", "--slug", "demo", "--worktrees-root", worktreesRoot],
  ["create", "--project", project, "--job-id", "job-1", "--slug", "../bad", "--worktrees-root", worktreesRoot],
]) {
  const unsafe = await runManager(args);
  assert.notEqual(unsafe.code, 0, "expected unsafe path component to fail");
  assert.match(unsafe.stderr, /invalid (job-id|slug)/i);
}

const existingRepo = await mkdtemp(path.join(tmpdir(), "flow-existing-repo-"));
await writeFile(path.join(existingRepo, "README.md"), "# Existing\n", "utf8");
await writeFile(path.join(existingRepo, ".env"), "SECRET=existing\n", "utf8");
await mustGit(["init"], existingRepo);
await mustGit(["add", "README.md"], existingRepo);
await mustGit(["commit", "-m", "Initial"], existingRepo);

const existingWorktreesRoot = await mkdtemp(path.join(tmpdir(), "flow-existing-worktrees-"));
const existingCreate = await runManager([
  "create",
  "--project",
  existingRepo,
  "--job-id",
  "job-2",
  "--slug",
  "demo",
  "--worktrees-root",
  existingWorktreesRoot,
]);
assert.equal(
  existingCreate.code,
  0,
  `existing repo create failed\nstdout:\n${existingCreate.stdout}\nstderr:\n${existingCreate.stderr}`
);
const existingCreated = JSON.parse(existingCreate.stdout);
const existingWorktreeIgnore = await runGit(["check-ignore", ".env"], existingCreated.path);
assert.equal(
  existingWorktreeIgnore.code,
  0,
  "expected required ignores to be committed into existing repo worktrees"
);

const stagedFeatureRepo = await mkdtemp(path.join(tmpdir(), "flow-staged-feature-"));
await writeFile(path.join(stagedFeatureRepo, "README.md"), "# Staged Feature\n", "utf8");
await mustGit(["init"], stagedFeatureRepo);
await mustGit(["add", "README.md"], stagedFeatureRepo);
await mustGit(["commit", "-m", "Initial"], stagedFeatureRepo);
await writeFile(path.join(stagedFeatureRepo, "feature.txt"), "user staged work\n", "utf8");
await mustGit(["add", "feature.txt"], stagedFeatureRepo);
const stagedFeatureBootstrap = await runManager(["bootstrap", "--project", stagedFeatureRepo]);
assert.notEqual(
  stagedFeatureBootstrap.code,
  0,
  "bootstrap must reject pre-existing staged non-ignored files"
);
assert.match(stagedFeatureBootstrap.stderr, /pre-existing staged changes/i);
assert.match(stagedFeatureBootstrap.stderr, /feature\.txt/);
const stagedFeatureIndex = await runGit(["diff", "--cached", "--name-only"], stagedFeatureRepo);
assert.equal(stagedFeatureIndex.stdout.trim(), "feature.txt");
const stagedFeatureLog = await runGit(["log", "--format=%s"], stagedFeatureRepo);
assert.deepEqual(stagedFeatureLog.stdout.trim().split("\n"), ["Initial"]);

const stagedSecretRepo = await mkdtemp(path.join(tmpdir(), "flow-staged-secret-"));
await writeFile(path.join(stagedSecretRepo, "README.md"), "# Staged Secret\n", "utf8");
await writeFile(path.join(stagedSecretRepo, ".env"), "SECRET=staged\n", "utf8");
await mustGit(["init"], stagedSecretRepo);
await mustGit(["add", ".env"], stagedSecretRepo);
const stagedBootstrap = await runManager(["bootstrap", "--project", stagedSecretRepo]);
assert.equal(
  stagedBootstrap.code,
  0,
  `staged secret bootstrap failed\nstdout:\n${stagedBootstrap.stdout}\nstderr:\n${stagedBootstrap.stderr}`
);
const stagedTrackedEnv = await runGit(["ls-files", ".env"], stagedSecretRepo);
assert.equal(stagedTrackedEnv.stdout.trim(), "", "bootstrap must unstage required ignored paths");
const stagedIndex = await runGit(["diff", "--cached", "--name-only"], stagedSecretRepo);
assert.equal(stagedIndex.stdout.trim(), "", "bootstrap must not leave required ignored paths staged");

const outerRepo = await mkdtemp(path.join(tmpdir(), "flow-outer-repo-"));
await writeFile(path.join(outerRepo, "README.md"), "# Outer\n", "utf8");
await mustGit(["init"], outerRepo);
await mustGit(["add", "README.md"], outerRepo);
await mustGit(["commit", "-m", "Outer initial"], outerRepo);
const nestedProject = path.join(outerRepo, "nested", "project");
await mkdir(nestedProject, { recursive: true });
await writeFile(path.join(nestedProject, "README.md"), "# Nested\n", "utf8");
const nestedBootstrap = await runManager(["bootstrap", "--project", nestedProject]);
assert.equal(
  nestedBootstrap.code,
  0,
  `nested bootstrap failed\nstdout:\n${nestedBootstrap.stdout}\nstderr:\n${nestedBootstrap.stderr}`
);
const nestedTopLevel = await runGit(["rev-parse", "--show-toplevel"], nestedProject);
assert.equal(await realpath(nestedTopLevel.stdout.trim()), await realpath(nestedProject));
