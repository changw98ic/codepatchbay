import { copyFile, lstat, mkdir, rm, readdir, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runtimeDataPath } from "../paths.js";

const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
type StringRecord = Record<string, any>;
const CODEX_SHARED_CONFIG_FILES = ["auth.json", "config.toml"];
const CLAUDE_SHARED_HOME_FILES = [".claude.json"];
const CLAUDE_SHARED_CONFIG_FILES = [".credentials.json", "credentials.json", "auth.json"];

function resolveSourceCodexHome(parentEnv: StringRecord = {}) {
  if (parentEnv.CODEX_HOME) return path.resolve(parentEnv.CODEX_HOME);
  const home = parentEnv.HOME || os.homedir();
  return home ? path.join(home, ".codex") : null;
}

function resolveSourceHome(parentEnv: StringRecord = {}) {
  return parentEnv.HOME || os.homedir() || null;
}

async function maybeLinkOrCopyFile(source: string, target: string) {
  let sourceInfo;
  try {
    sourceInfo = await lstat(source);
  } catch {
    return false;
  }
  if (!sourceInfo.isFile() && !sourceInfo.isSymbolicLink()) return false;

  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(target), { recursive: true });
  try {
    await symlink(source, target);
  } catch (error) {
    if (error.code === "EEXIST") return true;
    await copyFile(source, target);
  }
  return true;
}

async function inheritCodexConfig(targetHome: string, parentEnv: StringRecord = {}) {
  const sourceCodexHome = resolveSourceCodexHome(parentEnv);
  const targetCodexHome = path.join(targetHome, ".codex");
  await mkdir(targetCodexHome, { recursive: true });
  if (!sourceCodexHome) return targetCodexHome;

  await Promise.all(CODEX_SHARED_CONFIG_FILES.map((fileName) =>
    maybeLinkOrCopyFile(
      path.join(sourceCodexHome, fileName),
      path.join(targetCodexHome, fileName),
    )
  ));
  return targetCodexHome;
}

async function inheritClaudeConfig(targetHome: string, parentEnv: StringRecord = {}) {
  const sourceHome = resolveSourceHome(parentEnv);
  const targetClaudeHome = path.join(targetHome, ".claude");
  await mkdir(targetClaudeHome, { recursive: true });
  if (!sourceHome) return targetClaudeHome;

  await Promise.all([
    ...CLAUDE_SHARED_HOME_FILES.map((fileName) =>
      maybeLinkOrCopyFile(
        path.join(sourceHome, fileName),
        path.join(targetHome, fileName),
      )
    ),
    ...CLAUDE_SHARED_CONFIG_FILES.map((fileName) =>
      maybeLinkOrCopyFile(
        path.join(sourceHome, ".claude", fileName),
        path.join(targetClaudeHome, fileName),
      )
    ),
  ]);
  return targetClaudeHome;
}

function hasProjectJobContext(parentEnv: StringRecord = {}) {
  return Boolean(
    (parentEnv.CPB_ACP_PROJECT || parentEnv.CPB_PROJECT) &&
    (parentEnv.CPB_ACP_JOB_ID || parentEnv.CPB_JOB_ID)
  );
}

function resolveAgentHomeRoot(cpbRoot: string, { dataRoot, parentEnv = {} }: { dataRoot?: string | null; parentEnv?: StringRecord } = {}) {
  const root = dataRoot || parentEnv.CPB_PROJECT_RUNTIME_ROOT;
  if (root) return path.resolve(root);
  if (hasProjectJobContext(parentEnv)) {
    throw new Error("CPB_PROJECT_RUNTIME_ROOT is required for isolated agent HOME in project job context");
  }
  return runtimeDataPath(cpbRoot);
}

/**
 * Create an isolated HOME directory for an agent process.
 * Prevents concurrent agents of the same type from interfering
 * with each other's ~/.claude, ~/.codex, etc.
 *
 * Returns env vars to spread into the child process environment.
 * Codex and Claude receive isolated homes with only provider auth/config files
 * linked from the user's agent home, so ACP adapters can reuse login without
 * sharing mutable session state.
 */
export async function createAgentHome(cpbRoot: string, agentName: string, jobId: string, { parentEnv = {}, dataRoot = null }: { parentEnv?: StringRecord; dataRoot?: string | null } = {}) {
  const baseDir = path.join(resolveAgentHomeRoot(cpbRoot, { dataRoot, parentEnv }), "agent-homes", agentName, jobId || "default");
  await mkdir(baseDir, { recursive: true });

  const configDir = path.join(baseDir, ".config");
  const dataDir = path.join(baseDir, ".local", "share");
  const cacheDir = path.join(baseDir, ".cache");

  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  const env: StringRecord = {
    HOME: baseDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
  };
  if (agentName === "codex" && !parentEnv.CODEX_HOME) {
    env.CODEX_HOME = await inheritCodexConfig(baseDir, parentEnv);
  } else if (agentName === "claude") {
    await inheritClaudeConfig(baseDir, parentEnv);
  }
  return env;
}

/**
 * Clean up agent home directories older than CLEANUP_AGE_MS.
 * Safe to call periodically; skips directories that are still in use
 * (checked via the presence of active leases).
 *
 * @param {Function} [opts.isLeaseActive] - Async (jobId) => boolean.
 *   Returns true if the job has a non-stale lease. When provided,
 *   directories with active leases are never deleted regardless of age.
 */
export async function cleanupAgentHomes(cpbRoot: string, { maxAgeMs = CLEANUP_AGE_MS, now = Date.now(), isLeaseActive, dataRoot }: StringRecord = {}) {
  const homesRoot = path.join(resolveAgentHomeRoot(cpbRoot, { dataRoot, parentEnv: process.env }), "agent-homes");
  let agents;
  try {
    agents = await readdir(homesRoot);
  } catch {
    return 0;
  }

  const activeCheck = isLeaseActive || (() => false);

  let cleaned = 0;
  for (const agentName of agents) {
    const agentDir = path.join(homesRoot, agentName);
    let jobs;
    try {
      jobs = await readdir(agentDir);
    } catch {
      continue;
    }
    for (const jobId of jobs) {
      const jobDir = path.join(agentDir, jobId);
      try {
        const info = await stat(jobDir);
        if (now - info.mtimeMs <= maxAgeMs) continue;

        // Check lease status before deleting
        const active = await activeCheck(jobId);
        if (active) continue;

        await rm(jobDir, { recursive: true, force: true });
        cleaned++;
      } catch {
        // Skip inaccessible directories
      }
    }
  }
  return cleaned;
}
