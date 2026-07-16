import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { LooseRecord } from "../../shared/types.js";
import { runtimeDataPath } from "../paths.js";

const CACHE_DIR_NAME = "session-cache";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOCK_TTL_MS = 10_000;

function finiteNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cacheDir(cpbRoot: string) {
  return runtimeDataPath(cpbRoot, CACHE_DIR_NAME);
}

function normalizeConversationKey(value: unknown) {
  return typeof value === "string" && value ? value : "";
}

function cacheEntryName(agent: string, conversationKey = "") {
  if (!conversationKey) return agent;
  const digest = createHash("sha256").update(conversationKey).digest("hex");
  return `${agent}--conversation-${digest}`;
}

function sessionFile(cpbRoot: string, agent: string, conversationKey = "") {
  return path.join(cacheDir(cpbRoot), `${cacheEntryName(agent, conversationKey)}.json`);
}

function lockDir(cpbRoot: string, agent: string, conversationKey = "") {
  return path.join(cacheDir(cpbRoot), `${cacheEntryName(agent, conversationKey)}.lock`);
}

async function acquireLock(cpbRoot: string, agent: string, conversationKey = "") {
  const dir = lockDir(cpbRoot, agent, conversationKey);
  await mkdir(path.dirname(dir), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(dir);
      return true;
    } catch (err) {
      // retain: dynamic — err is an unknown FS error from mkdir(); narrowing to
      // LooseRecord | null | undefined preserves the !caught guard
      // against `throw null`/`throw undefined`, matching agent-runner.ts sibling.
      const caught = err as LooseRecord | null | undefined;
      if (!caught || caught.code !== "EEXIST") throw err;
      try {
        const info = await stat(dir);
        if (Date.now() - info.mtimeMs >= LOCK_TTL_MS) {
          await rm(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Race condition
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return false;
}

async function releaseLock(cpbRoot: string, agent: string, conversationKey = "") {
  try {
    await rm(lockDir(cpbRoot, agent, conversationKey), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

/**
 * Save a session ID for an agent (cached lifecycle mode).
 * Explicit conversation keys receive independent durable entries; calls without
 * a key retain the legacy agent-level cache entry.
 */
export async function saveSessionId(cpbRoot: string, agent: string, sessionId: string, meta: LooseRecord = {}) {
  const conversationKey = normalizeConversationKey(meta.conversationKey);
  const dir = cacheDir(cpbRoot);
  await mkdir(dir, { recursive: true });
  const data = {
    agent,
    sessionId,
    savedAt: new Date().toISOString(),
    ...meta,
    ...(conversationKey ? { conversationKey } : {}),
  };
  const filePath = sessionFile(cpbRoot, agent, conversationKey);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  
  const locked = await acquireLock(cpbRoot, agent, conversationKey);
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
  } finally {
    if (locked) await releaseLock(cpbRoot, agent, conversationKey);
  }
}

/**
 * Load a cached session ID for an agent.
 * Returns null if no cache exists or if the cache is expired.
 */
export async function loadSessionId(cpbRoot: string, agent: string, {
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
  conversationKey: requestedConversationKey = "",
}: LooseRecord = {}) {
  const conversationKey = normalizeConversationKey(requestedConversationKey);
  const effectiveMaxAgeMs = finiteNumber(maxAgeMs, DEFAULT_MAX_AGE_MS);
  const effectiveNow = finiteNumber(now, Date.now());
  const filePath = sessionFile(cpbRoot, agent, conversationKey);
  const locked = await acquireLock(cpbRoot, agent, conversationKey);
  try {
    const raw = await readFile(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!data.sessionId) return null;
    const cachedConversationKey = normalizeConversationKey(data.conversationKey);
    if (cachedConversationKey !== conversationKey) return null;
    const savedAt = Date.parse(data.savedAt);
    if (Number.isFinite(savedAt) && effectiveNow - savedAt > effectiveMaxAgeMs) {
      return null;
    }
    return data;
  } catch {
    return null;
  } finally {
    if (locked) await releaseLock(cpbRoot, agent, conversationKey);
  }
}

/**
 * Remove a cached session for an agent.
 */
export async function clearSessionId(cpbRoot: string, agent: string, { conversationKey: requestedConversationKey = "" }: LooseRecord = {}) {
  const conversationKey = normalizeConversationKey(requestedConversationKey);
  const locked = await acquireLock(cpbRoot, agent, conversationKey);
  try {
    await rm(sessionFile(cpbRoot, agent, conversationKey), { force: true });
  } catch {
    // ignore
  } finally {
    if (locked) await releaseLock(cpbRoot, agent, conversationKey);
  }
}

/**
 * Remove all expired cached sessions.
 * Returns the number of entries cleaned.
 */
export async function cleanupSessionCache(cpbRoot: string, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() }: LooseRecord = {}) {
  const effectiveMaxAgeMs = finiteNumber(maxAgeMs, DEFAULT_MAX_AGE_MS);
  const effectiveNow = finiteNumber(now, Date.now());
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
      if (effectiveNow - info.mtimeMs > effectiveMaxAgeMs) {
        await rm(path.join(dir, f), { force: true });
        cleaned++;
      }
    } catch {
      // skip inaccessible
    }
  }
  return cleaned;
}
