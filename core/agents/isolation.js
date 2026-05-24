import { mkdir, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "../paths.js";

const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Create an isolated HOME directory for an agent process.
 * Prevents concurrent agents of the same type from interfering
 * with each other's ~/.claude, ~/.codex, etc.
 *
 * Returns env vars to spread into the child process environment.
 * Only effective when CPB_AGENT_ISOLATE_HOME=1.
 */
export async function createAgentHome(cpbRoot, agentName, jobId) {
  const baseDir = runtimeDataPath(cpbRoot, "agent-homes", agentName, jobId || "default");
  await mkdir(baseDir, { recursive: true });

  const configDir = path.join(baseDir, ".config");
  const dataDir = path.join(baseDir, ".local", "share");
  const cacheDir = path.join(baseDir, ".cache");

  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  return {
    HOME: baseDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
  };
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
export async function cleanupAgentHomes(cpbRoot, { maxAgeMs = CLEANUP_AGE_MS, now = Date.now(), isLeaseActive } = {}) {
  const homesRoot = runtimeDataPath(cpbRoot, "agent-homes");
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
