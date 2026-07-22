#!/usr/bin/env node
import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LooseRecord } from "../../core/contracts/types.js";
import {
  WORKTREE_OWNERSHIP_VERSION,
  parseWorktreeOwnership,
  sameWorktreeDirectoryIdentity,
  type PreparedWorktreeOwnership,
  type ReadyWorktreeOwnership,
  type WorktreeDirectoryIdentity,
  type WorktreeOwnership,
} from "../../core/contracts/worktree-ownership.js";

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

type SourceBase = {
  baseBranch: string;
  baseCommit: string;
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
      throw Object.assign(
        new Error(`refusing to replace unowned worktree CodeGraph path: ${worktreeCodegraph}`),
        {
          code: "WORKTREE_CODEGRAPH_PATH_UNOWNED",
          committed: false,
          recoveryPaths: { canonical: worktreeCodegraph },
        },
      );
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
      throw Object.assign(
        new Error(`refusing unowned worktree node_modules path: ${worktreeNodeModules}`),
        {
          code: "WORKTREE_NODE_MODULES_PATH_UNOWNED",
          committed: false,
          recoveryPaths: { canonical: worktreeNodeModules },
        },
      );
    }
    try {
      const existingTarget = await realpath(worktreeNodeModules);
      if (existingTarget === sourceTarget) {
        return false;
      }
      throw Object.assign(
        new Error(`refusing to replace unowned node_modules link: ${worktreeNodeModules}`),
        {
          code: "WORKTREE_NODE_MODULES_LINK_UNOWNED",
          committed: false,
          recoveryPaths: { canonical: worktreeNodeModules, target: existingTarget },
        },
      );
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "WORKTREE_NODE_MODULES_LINK_UNOWNED") throw err;
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      throw Object.assign(
        new Error(`refusing to replace unowned dangling node_modules link: ${worktreeNodeModules}`),
        {
          code: "WORKTREE_NODE_MODULES_LINK_UNOWNED",
          committed: false,
          recoveryPaths: { canonical: worktreeNodeModules },
        },
      );
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

function worktreeBaseBindingKey(branch: string) {
  return `branch.${branch}.cpbBaseBinding`;
}

function parseWorktreeBaseBinding(raw: string, branch: string): WorktreeOwnership {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`managed branch has invalid base binding metadata: ${branch}`, { cause: error });
  }
  try {
    return parseWorktreeOwnership(parsed, { allowPrepared: true });
  } catch (error) {
    throw new Error(`managed branch has invalid base binding metadata: ${branch}`, { cause: error });
  }
}

async function readWorktreeBaseBinding(project: string, branch: string) {
  const result = await git(project, ["config", "--local", "--get", worktreeBaseBindingKey(branch)]);
  if (result.code === 1 && !result.stdout.trim() && !result.stderr.trim()) return null;
  if (result.code !== 0) {
    throw new Error(`git config base binding read failed: ${result.stderr || result.stdout}`);
  }
  return parseWorktreeBaseBinding(result.stdout.trim(), branch);
}

async function captureSourceBase(project: string): Promise<SourceBase> {
  const branchResult = await git(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.code !== 0 || !branchResult.stdout.trim()) {
    throw new Error("source checkout must have a symbolic base branch before creating a managed worktree");
  }
  const baseBranch = branchResult.stdout.trim();
  await mustGit(project, ["check-ref-format", "--branch", baseBranch]);
  const commitResult = await mustGit(project, ["rev-parse", "--verify", "HEAD"]);
  const baseCommit = commitResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) {
    throw new Error("source checkout returned an invalid base commit");
  }
  return { baseBranch, baseCommit };
}

function sameWorktreeBase(left: SourceBase, right: SourceBase) {
  return left.baseBranch === right.baseBranch
    && left.baseCommit === right.baseCommit;
}

function sameWorktreeOwnership(left: WorktreeOwnership, right: WorktreeOwnership) {
  if (
    left.version !== right.version
    || left.state !== right.state
    || left.ownerToken !== right.ownerToken
    || left.baseBranch !== right.baseBranch
    || left.baseCommit !== right.baseCommit
  ) return false;
  if (left.state === "prepared" || right.state === "prepared") return left.state === right.state;
  return sameWorktreeDirectoryIdentity(left.directory, right.directory);
}

async function persistWorktreeBaseBinding(project: string, branch: string, binding: WorktreeOwnership) {
  await mustGit(project, [
    "config",
    "--local",
    "--replace-all",
    worktreeBaseBindingKey(branch),
    JSON.stringify(binding),
  ]);
  const durable = await readWorktreeBaseBinding(project, branch);
  if (!durable || !sameWorktreeOwnership(durable, binding)) {
    throw new Error(`managed branch base binding was not persisted exactly: ${branch}`);
  }
}

async function captureWorktreeDirectoryIdentity(worktreePath: string): Promise<WorktreeDirectoryIdentity> {
  const info = await lstat(worktreePath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`managed worktree is not a real directory: ${worktreePath}`);
  }
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
    mode: String(info.mode),
    uid: String(info.uid),
    gid: String(info.gid),
  };
}

async function assertOwnedWorktreeDirectory(worktreePath: string, ownership: ReadyWorktreeOwnership) {
  const current = await captureWorktreeDirectoryIdentity(worktreePath);
  if (!sameWorktreeDirectoryIdentity(current, ownership.directory)) {
    throw new Error(`managed worktree directory no longer matches its durable ownership binding: ${worktreePath}`);
  }
}

function worktreeContext(branch: string, worktreePath: string, ownership: ReadyWorktreeOwnership) {
  return {
    branch,
    path: worktreePath,
    baseBranch: ownership.baseBranch,
    baseCommit: ownership.baseCommit,
    ownership,
  };
}

export async function createWorktree({ project, jobId, slug, worktreesRoot, initCodegraph, codegraphEnabled }: CreateWorktreeOptions = {}) {
  if (!project) throw new Error("missing --project");
  if (!worktreesRoot) throw new Error("missing --worktrees-root");
  validateComponent("job-id", jobId);
  validateComponent("slug", slug);

  await bootstrap(project);

  const source = path.resolve(project);
  const currentBase = await captureSourceBase(source);

  const branch = `cpb/${jobId}-${slug}`;
  const root = path.resolve(worktreesRoot);
  const worktreePath = path.resolve(root, `${jobId}-${slug}`);
  ensureInside(root, worktreePath);
  await mkdir(root, { recursive: true });

  await mustGit(source, ["check-ref-format", "--branch", branch]);
  const existingPath = await existingWorktreePath(source, branch);
  if (existingPath !== null) {
    if ((await pathExists(worktreePath)) && (await samePath(existingPath, worktreePath))) {
      const binding = await readWorktreeBaseBinding(source, branch);
      if (!binding) {
        throw new Error(`managed branch is missing durable base binding metadata: ${branch}`);
      }
      if (binding.state !== "ready") {
        throw new Error(`managed branch ownership binding is not ready: ${branch}`);
      }
      if (!sameWorktreeBase(binding, currentBase)) {
        throw new Error(`source checkout no longer matches the managed branch base binding: ${branch}`);
      }
      await assertOwnedWorktreeDirectory(worktreePath, binding);
      await prepareWorktreeRuntime(project, worktreePath, { initCodegraph, codegraphEnabled });
      await assertOwnedWorktreeDirectory(worktreePath, binding);
      return worktreeContext(branch, worktreePath, binding);
    }
    throw new Error(`branch already has a different worktree: ${branch}`);
  }

  // A branch without its exact registered worktree is recovery state. Never
  // delete it implicitly: target-scoped ownership cannot be reconstructed from
  // the ref alone.
  const branchCheck = await git(source, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (branchCheck.code === 0) {
    throw new Error(`managed branch exists without the exact registered worktree; preserving recovery state: ${branch}`);
  }
  if (branchCheck.code !== 1 && branchCheck.code !== 128) {
    throw new Error(`managed branch existence check failed: ${branchCheck.stderr || branchCheck.stdout}`);
  }

  const existingBinding = await readWorktreeBaseBinding(source, branch);
  if (existingBinding && !sameWorktreeBase(existingBinding, currentBase)) {
    throw new Error(`source checkout no longer matches preserved base binding metadata: ${branch}`);
  }
  if (existingBinding?.state === "ready") {
    throw new Error(`ready managed worktree ownership exists without its branch; preserving recovery state: ${branch}`);
  }
  const prepared: PreparedWorktreeOwnership = existingBinding || {
    version: WORKTREE_OWNERSHIP_VERSION,
    state: "prepared",
    ownerToken: randomUUID(),
    baseBranch: currentBase.baseBranch,
    baseCommit: currentBase.baseCommit,
  };
  if (!existingBinding) await persistWorktreeBaseBinding(source, branch, prepared);

  await mustGit(source, ["worktree", "add", "-b", branch, worktreePath, prepared.baseCommit]);
  const binding: ReadyWorktreeOwnership = {
    ...prepared,
    state: "ready",
    directory: await captureWorktreeDirectoryIdentity(worktreePath),
  };
  await persistWorktreeBaseBinding(source, branch, binding);
  await prepareWorktreeRuntime(project, worktreePath, {
    initCodegraph,
    codegraphEnabled,
  });
  await assertOwnedWorktreeDirectory(worktreePath, binding);

  return worktreeContext(branch, worktreePath, binding);
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
