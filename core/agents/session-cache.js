import { mkdir, readFile, rename, writeFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const CACHE_DIR_NAME = "session-cache";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function cacheDir(cpbRoot) {
  return path.join(cpbRoot, "cpb-task", CACHE_DIR_NAME);
}

function sessionFile(cpbRoot, agent) {
  return path.join(cacheDir(cpbRoot), `${agent}.json`);
}

/**
 * Save a session ID for an agent (cached lifecycle mode).
 * Overwrites any previous cached session for this agent.
 */
export async function saveSessionId(cpbRoot, agent, sessionId, meta = {}) {
  const dir = cacheDir(cpbRoot);
  await mkdir(dir, { recursive: true });
  const data = {
    agent,
    sessionId,
    savedAt: new Date().toISOString(),
    ...meta,
  };
  const filePath = sessionFile(cpbRoot, agent);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

/**
 * Load a cached session ID for an agent.
 * Returns null if no cache exists or if the cache is expired.
 */
export async function loadSessionId(cpbRoot, agent, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const filePath = sessionFile(cpbRoot, agent);
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!data.sessionId) return null;
    const savedAt = Date.parse(data.savedAt);
    if (Number.isFinite(savedAt) && now - savedAt > maxAgeMs) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

/**
 * Remove a cached session for an agent.
 */
export async function clearSessionId(cpbRoot, agent) {
  try {
    await rm(sessionFile(cpbRoot, agent), { force: true });
  } catch {
    // ignore
  }
}

/**
 * Remove all expired cached sessions.
 * Returns the number of entries cleaned.
 */
export async function cleanupSessionCache(cpbRoot, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const dir = cacheDir(cpbRoot);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }

  let cleaned = 0;
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const info = await stat(path.join(dir, f));
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(path.join(dir, f), { force: true });
        cleaned++;
      }
    } catch {
      // skip inaccessible
    }
  }
  return cleaned;
}
