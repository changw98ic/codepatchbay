#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_IGNORES = [
  ".env",
  ".env.*",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  "flow-task/state/",
  "flow-task/worktrees/",
];

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const BASELINE_ENV = {
  GIT_AUTHOR_NAME: "Flow Supervisor",
  GIT_AUTHOR_EMAIL: "flow-supervisor@local.invalid",
  GIT_COMMITTER_NAME: "Flow Supervisor",
  GIT_COMMITTER_EMAIL: "flow-supervisor@local.invalid",
};

function usage() {
  return [
    "Usage:",
    "  worktree-manager.mjs bootstrap --project <project>",
    "  worktree-manager.mjs create --project <project> --job-id <jobId> --slug <slug> --worktrees-root <root>",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const args = { command };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
}

function validateComponent(name, value) {
  if (typeof value !== "string" || !SAFE_COMPONENT.test(value)) {
    throw new Error(`invalid ${name}`);
  }
}

function ensureInside(root, child) {
  const relative = path.relative(root, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("worktree path resolves outside worktrees root");
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function git(project, args, options = {}) {
  return await run("git", ["-C", project, ...args], options);
}

async function mustGit(project, args, options = {}) {
  const result = await git(project, args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function isGitRepo(project) {
  const result = await git(project, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) {
    return false;
  }

  const topLevel = path.resolve(result.stdout.trim());
  const projectPath = path.resolve(project);
  try {
    return (await realpath(topLevel)) === (await realpath(projectPath));
  } catch {
    return topLevel === projectPath;
  }
}

async function hasHead(project) {
  const result = await git(project, ["rev-parse", "--verify", "HEAD"]);
  return result.code === 0;
}

async function ensureGitignore(project) {
  const file = path.join(project, ".gitignore");
  let raw = "";

  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }

  const existing = new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
  const missing = REQUIRED_IGNORES.filter((pattern) => !existing.has(pattern));
  if (missing.length === 0) {
    return false;
  }

  const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  await writeFile(file, `${raw}${prefix}${missing.join("\n")}\n`, "utf8");
  return true;
}

async function removeRequiredIgnoresFromIndex(project) {
  await mustGit(project, [
    "rm",
    "--cached",
    "-r",
    "--ignore-unmatch",
    "--",
    ...REQUIRED_IGNORES,
  ]);
}

async function assertNoRequiredIgnoresInIndex(project) {
  const tracked = await git(project, ["ls-files", "--", ...REQUIRED_IGNORES]);
  if (tracked.code !== 0) {
    throw new Error(`git ls-files failed: ${tracked.stderr || tracked.stdout}`);
  }
  if (tracked.stdout.trim().length > 0) {
    throw new Error(`required ignored paths remain tracked: ${tracked.stdout.trim()}`);
  }
}

async function hasStagedChanges(project) {
  const staged = await git(project, ["diff", "--cached", "--quiet", "--exit-code"]);
  return staged.code !== 0;
}

async function stagedPaths(project) {
  const result = await git(project, ["diff", "--cached", "--name-only"]);
  if (result.code !== 0) {
    throw new Error(`git diff --cached --name-only failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isRequiredIgnoredPath(file) {
  return REQUIRED_IGNORES.some((pattern) => {
    if (pattern.endsWith("/")) {
      const directory = pattern.slice(0, -1);
      return file === directory || file.startsWith(pattern);
    }
    if (pattern.endsWith(".*")) {
      return file.startsWith(pattern.slice(0, -1));
    }
    return file === pattern;
  });
}

async function rejectPreExistingStagedChanges(project) {
  const unsafeStaged = (await stagedPaths(project)).filter(
    (file) => !isRequiredIgnoredPath(file)
  );
  if (unsafeStaged.length > 0) {
    throw new Error(
      `pre-existing staged changes must be committed or unstaged before Flow bootstrap: ${unsafeStaged.join(", ")}`
    );
  }
}

async function commitStaged(project, message, { allowEmpty = false } = {}) {
  const commitArgs = allowEmpty
    ? ["commit", "--allow-empty", "-m", message]
    : ["commit", "-m", message];
  await mustGit(project, commitArgs, {
    env: {
      ...process.env,
      ...BASELINE_ENV,
    },
  });
}

async function createBaselineCommit(project) {
  await mustGit(project, ["add", "--", "."]);
  await removeRequiredIgnoresFromIndex(project);
  await assertNoRequiredIgnoresInIndex(project);

  await commitStaged(project, "Flow protected baseline", {
    allowEmpty: !(await hasStagedChanges(project)),
  });
}

async function commitIgnoreProtection(project) {
  await mustGit(project, ["add", "--", ".gitignore"]);
  await removeRequiredIgnoresFromIndex(project);
  await assertNoRequiredIgnoresInIndex(project);

  if (await hasStagedChanges(project)) {
    await commitStaged(project, "Flow protected ignore baseline");
  }
}

export async function bootstrap(projectInput) {
  if (!projectInput) {
    throw new Error("missing --project");
  }

  const project = path.resolve(projectInput);
  await mkdir(project, { recursive: true });

  if (!(await isGitRepo(project))) {
    await mustGit(project, ["init"]);
  }

  const gitignoreChanged = await ensureGitignore(project);

  if (!(await hasHead(project))) {
    await createBaselineCommit(project);
  } else {
    await removeRequiredIgnoresFromIndex(project);
    await assertNoRequiredIgnoresInIndex(project);
    await rejectPreExistingStagedChanges(project);
    if (gitignoreChanged || (await hasStagedChanges(project))) {
      await commitIgnoreProtection(project);
    }
  }
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function samePath(left, right) {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

async function existingWorktreePath(project, branch) {
  const result = await git(project, ["worktree", "list", "--porcelain"]);
  if (result.code !== 0) {
    throw new Error(`git worktree list failed: ${result.stderr || result.stdout}`);
  }

  let currentPath = "";
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line === `branch refs/heads/${branch}` && currentPath) {
      return path.resolve(currentPath);
    }
  }

  return null;
}

export async function createWorktree({ project, jobId, slug, worktreesRoot }) {
  if (!project) throw new Error("missing --project");
  if (!worktreesRoot) throw new Error("missing --worktrees-root");
  validateComponent("job-id", jobId);
  validateComponent("slug", slug);

  await bootstrap(project);

  const branch = `flow/${jobId}-${slug}`;
  const root = path.resolve(worktreesRoot);
  const worktreePath = path.resolve(root, `${jobId}-${slug}`);
  ensureInside(root, worktreePath);
  await mkdir(root, { recursive: true });

  await mustGit(path.resolve(project), ["check-ref-format", "--branch", branch]);
  const existingPath = await existingWorktreePath(path.resolve(project), branch);
  if (existingPath !== null) {
    if ((await pathExists(worktreePath)) && (await samePath(existingPath, worktreePath))) {
      return { branch, path: worktreePath };
    }
    throw new Error(`branch already has a different worktree: ${branch}`);
  }

  await mustGit(path.resolve(project), ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);

  return { branch, path: worktreePath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "bootstrap":
      await bootstrap(args.project);
      break;
    case "create": {
      const result = await createWorktree({
        project: args.project,
        jobId: args["job-id"],
        slug: args.slug,
        worktreesRoot: args["worktrees-root"],
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      break;
    }
    default:
      throw new Error(args.command ? `unknown command: ${args.command}` : usage());
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
