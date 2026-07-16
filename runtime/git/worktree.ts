#!/usr/bin/env node
import { spawn, type SpawnOptions } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LooseRecord } from "../../core/contracts/types.js";

const REQUIRED_IGNORES = [
  ".env",
  ".env.*",
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  "cpb-task/state/",
  "cpb-task/worktrees/",
];

const WORKTREE_LOCAL_EXCLUDES = [
  ".codegraph",
  ".claude/",
  ".codex/",
  "cpb-task/",
  "node_modules",
  "node_modules/",
];

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const BASELINE_ENV = {
  GIT_AUTHOR_NAME: "CodePatchbay Supervisor",
  GIT_AUTHOR_EMAIL: "cpb-supervisor@local.invalid",
  GIT_COMMITTER_NAME: "CodePatchbay Supervisor",
  GIT_COMMITTER_EMAIL: "cpb-supervisor@local.invalid",
};
type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: unknown;
};

type WorktreeManagerArgs = LooseRecord & {
  command?: string;
  project?: string;
  "job-id"?: string;
  jobId?: string;
  slug?: string;
  "worktrees-root"?: string;
  worktreesRoot?: string;
};

type CommitOptions = {
  allowEmpty?: boolean;
};

type InitCodegraph = (worktreePath: string) => Promise<unknown>;

type WorktreeRuntimeOptions = LooseRecord & {
  initCodegraph?: InitCodegraph;
  codegraphEnabled?: boolean;
};

type CreateWorktreeOptions = WorktreeRuntimeOptions & {
  project?: string;
  jobId?: string;
  slug?: string;
  worktreesRoot?: string;
};

function usage() {
  return [
    "Usage:",
    "  worktree-manager.js bootstrap --project <project>",
    "  worktree-manager.js create --project <project> --job-id <jobId> --slug <slug> --worktrees-root <root>",
  ].join("\n");
}

function parseArgs(argv: string[]) {
  const [command, ...tokens] = argv;
  const args: WorktreeManagerArgs = { command };

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

function validateComponent(name: string, value: unknown) {
  if (typeof value !== "string" || !SAFE_COMPONENT.test(value)) {
    throw new Error(`invalid ${name}`);
  }
}

function ensureInside(root: string, child: string) {
  const relative = path.relative(root, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("worktree path resolves outside worktrees root");
  }
}

function run(command: string, args: string[], options: SpawnOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    let stdout = "";
    let stderr = "";
    try {
      child = spawn(command, args, {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      finish({ code: null, stdout, stderr: err instanceof Error ? err.message : String(err), error: err });
      return;
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish({ code: null, stdout, stderr: stderr || err?.message || String(err), error: err });
    });
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

async function git(project: string, args: string[], options: SpawnOptions = {}) {
  return await run("git", ["-C", project, ...args], options);
}

async function mustGit(project: string, args: string[], options: SpawnOptions = {}) {
  const result = await git(project, args, options);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function isGitRepo(project: string) {
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

async function hasHead(project: string) {
  const result = await git(project, ["rev-parse", "--verify", "HEAD"]);
  return result.code === 0;
}

async function ensureGitignore(project: string) {
  const file = path.join(project, ".gitignore");
  let raw = "";

  try {
    raw = await readFile(file, "utf8");
  } catch (err: unknown) {
    if (!err || (err as NodeJS.ErrnoException).code !== "ENOENT") {
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

async function removeRequiredIgnoresFromIndex(project: string) {
  await mustGit(project, [
    "rm",
    "--cached",
    "-r",
    "--ignore-unmatch",
    "--",
    ...REQUIRED_IGNORES,
  ]);
}

async function assertNoRequiredIgnoresInIndex(project: string) {
  const tracked = await git(project, ["ls-files", "--", ...REQUIRED_IGNORES]);
  if (tracked.code !== 0) {
    throw new Error(`git ls-files failed: ${tracked.stderr || tracked.stdout}`);
  }
  if (tracked.stdout.trim().length > 0) {
    throw new Error(`required ignored paths remain tracked: ${tracked.stdout.trim()}`);
  }
}

async function hasStagedChanges(project: string) {
  const staged = await git(project, ["diff", "--cached", "--quiet", "--exit-code"]);
  return staged.code !== 0;
}

async function stagedPaths(project: string) {
  const result = await git(project, ["diff", "--cached", "--name-only"]);
  if (result.code !== 0) {
    throw new Error(`git diff --cached --name-only failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isRequiredIgnoredPath(file: string) {
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

async function rejectPreExistingStagedChanges(project: string) {
  const unsafeStaged = (await stagedPaths(project)).filter(
    (file) => !isRequiredIgnoredPath(file)
  );
  if (unsafeStaged.length > 0) {
    throw new Error(
      `pre-existing staged changes must be committed or unstaged before CodePatchbay bootstrap: ${unsafeStaged.join(", ")}`
    );
  }
}

async function commitStaged(project: string, message: string, { allowEmpty = false }: CommitOptions = {}) {
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

async function createBaselineCommit(project: string) {
  await mustGit(project, ["add", "--", "."]);
  await removeRequiredIgnoresFromIndex(project);
  await assertNoRequiredIgnoresInIndex(project);

  await commitStaged(project, "CodePatchbay protected baseline", {
    allowEmpty: !(await hasStagedChanges(project)),
  });
}

export async function bootstrap(projectInput: string) {
  if (!projectInput) {
    throw new Error("missing --project");
  }

  const project = path.resolve(projectInput);
  await mkdir(project, { recursive: true });

  const existingRepository = await isGitRepo(project);
  if (!existingRepository) {
    await mustGit(project, ["init"]);
  }

  if (!(await hasHead(project))) {
    await ensureGitignore(project);
    await createBaselineCommit(project);
  } else {
    // Existing repositories are user/product state. Runtime protection belongs
    // in Git's local exclude file so worktree creation never changes HEAD, the
    // index, or a tracked .gitignore merely to host CPB metadata.
    await ensureProjectLocalExcludes(project);
    await rejectPreExistingStagedChanges(project);
  }
}

async function pathExists(target: string) {
  try {
    await stat(target);
    return true;
  } catch (err: unknown) {
    if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

async function ensureLocalGitExclude(worktreePath: string, pattern: string) {
  const result = await git(worktreePath, ["rev-parse", "--git-path", "info/exclude"]);
  if (result.code !== 0) {
    throw new Error(`git rev-parse --git-path info/exclude failed: ${result.stderr || result.stdout}`);
  }

  const rawPath = result.stdout.trim();
  const excludePath = path.isAbsolute(rawPath) ? rawPath : path.join(worktreePath, rawPath);
  let raw = "";
  try {
    raw = await readFile(excludePath, "utf8");
  } catch (err: unknown) {
    if (!err || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const existing = new Set(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
  if (existing.has(pattern)) {
    return false;
  }

  const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  await mkdir(path.dirname(excludePath), { recursive: true });
  await writeFile(excludePath, `${raw}${prefix}${pattern}\n`, "utf8");
  return true;
}

async function ensureWorktreeLocalExcludes(worktreePath: string) {
  for (const pattern of WORKTREE_LOCAL_EXCLUDES) {
    await ensureLocalGitExclude(worktreePath, pattern);
  }
}

async function ensureProjectLocalExcludes(project: string) {
  for (const pattern of REQUIRED_IGNORES) {
    await ensureLocalGitExclude(project, pattern);
  }
}

function commandFailureMessage(command: string, args: string[], result: RunResult) {
  const output = `${result.stderr || ""}${result.stdout || ""}`.trim();
  const suffix = output.length > 0 ? `: ${output}` : "";
  return `${command} ${args.join(" ")} failed${suffix}`;
}

async function initCodegraphIndex(worktreePath: string, runCommand = run) {
  const args = ["init", worktreePath];
  const result = await runCommand("codegraph", args, { cwd: worktreePath });
  if (result.code !== 0) {
    throw new Error(commandFailureMessage("codegraph", args, result));
  }
  return true;
}

async function ensureIsolatedCodegraph(worktreePath: string, { initCodegraph = initCodegraphIndex }: WorktreeRuntimeOptions = {}) {
  const worktreeCodegraph = path.join(worktreePath, ".codegraph");
  let resetCodegraph = false;

  try {
    const existing = await lstat(worktreeCodegraph);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      await rm(worktreeCodegraph, { force: true });
      resetCodegraph = true;
    }
  } catch (err: unknown) {
    if (!err || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    resetCodegraph = true;
  }

  await initCodegraph(worktreePath);

  return resetCodegraph;
}

async function ensureSharedNodeModules(project: string, worktreePath: string) {
  const sourceNodeModules = path.join(path.resolve(project), "node_modules");
  const worktreeNodeModules = path.join(worktreePath, "node_modules");

  try {
    const sourceStats = await stat(sourceNodeModules);
    if (!sourceStats.isDirectory()) return false;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }

  const sourceTarget = await realpath(sourceNodeModules);
  try {
    const existing = await lstat(worktreeNodeModules);
    if (!existing.isSymbolicLink()) {
      return false;
    }
    try {
      const existingTarget = await realpath(worktreeNodeModules);
      if (existingTarget === sourceTarget) {
        return false;
      }
      return false;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      await rm(worktreeNodeModules, { force: true });
    }
  } catch (err: unknown) {
    if (!err || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  await symlink(sourceTarget, worktreeNodeModules, "dir");
  return true;
}

async function prepareWorktreeRuntime(project: string, worktreePath: string, options: WorktreeRuntimeOptions = {}) {
  const codegraphEnabled = options.codegraphEnabled ?? (process.env.CPB_CODEGRAPH_ENABLED !== "0");
  await ensureWorktreeLocalExcludes(worktreePath);
  if (codegraphEnabled) {
    await ensureIsolatedCodegraph(worktreePath, options);
  }
  await ensureSharedNodeModules(project, worktreePath);
}

async function samePath(left: string, right: string) {
  try {
    return (await realpath(left)) === (await realpath(right));
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

async function existingWorktreePath(project: string, branch: string) {
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

export async function createWorktree({ project, jobId, slug, worktreesRoot, initCodegraph, codegraphEnabled }: CreateWorktreeOptions = {}) {
  if (!project) throw new Error("missing --project");
  if (!worktreesRoot) throw new Error("missing --worktrees-root");
  validateComponent("job-id", jobId);
  validateComponent("slug", slug);

  await bootstrap(project);

  const branch = `cpb/${jobId}-${slug}`;
  const root = path.resolve(worktreesRoot);
  const worktreePath = path.resolve(root, `${jobId}-${slug}`);
  ensureInside(root, worktreePath);
  await mkdir(root, { recursive: true });

  await mustGit(path.resolve(project), ["check-ref-format", "--branch", branch]);
  const existingPath = await existingWorktreePath(path.resolve(project), branch);
  if (existingPath !== null) {
    if ((await pathExists(worktreePath)) && (await samePath(existingPath, worktreePath))) {
      await prepareWorktreeRuntime(project, worktreePath, { initCodegraph, codegraphEnabled });
      return { branch, path: worktreePath };
    }
    throw new Error(`branch already has a different worktree: ${branch}`);
  }

  // If branch exists but worktree was removed (stale branch), clean it up first
  const branchCheck = await git(path.resolve(project), ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (branchCheck.code === 0) {
    await mustGit(path.resolve(project), ["branch", "-D", branch]);
  }

  await mustGit(path.resolve(project), ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
  await prepareWorktreeRuntime(project, worktreePath, {
    initCodegraph,
    codegraphEnabled,
  });

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
