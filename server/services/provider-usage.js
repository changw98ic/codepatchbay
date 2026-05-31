/**
 * Provider Usage — JSONL-based phase-level usage tracking.
 *
 * Records provider usage per phase to {hubRoot}/providers/usage.jsonl.
 * Phase-level (not per-call): runJob() enqueues after each phase completes.
 *
 * Write API: enqueueProviderUsage (queue-based, in-process)
 * Read API:  readProviderUsage, readProviderUsageRollup, readSystemUsageRollup
 */

import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

const USAGE_FILE = "usage.jsonl";

function usageFilePath(hubRoot) {
  return path.join(hubRoot, "providers", USAGE_FILE);
}

// ─── In-process write queue (same pattern as provider-quota.js) ─────
const _usageWriteQueues = new Map();

/**
 * Low-level JSONL append.
 * @param {string} hubRoot
 * @param {object} record — already-normalized entry
 */
async function appendProviderUsageLine(hubRoot, record) {
  const filePath = usageFilePath(hubRoot);
  const line = `${JSON.stringify(record)}\n`;
  try {
    await appendFile(filePath, line, "utf8");
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, line, "utf8");
  }
  return record;
}

/**
 * Queue-based usage writer. Serializes concurrent writes to prevent
 * interleaved JSONL lines.
 *
 * @param {string} hubRoot
 * @param {object} record
 * @returns {Promise<object>} the normalized entry
 */
export async function enqueueProviderUsage(hubRoot, record) {
  const filePath = usageFilePath(hubRoot);
  const prev = _usageWriteQueues.get(filePath) || Promise.resolve();
  const next = prev.catch(() => null).then(async () => {
    const entry = {
      ts: new Date().toISOString(),
      project: record.project || null,
      issueNumber: record.issueNumber ?? null,
      source: record.source || null,
      attempt: record.attempt ?? null,
      phase: record.phase,
      role: record.role || null,
      providerKey: record.providerKey,
      agent: record.agent,
      variant: record.variant || null,
      providerRegion: record.providerRegion || null,
      providerAdapter: record.providerAdapter || null,
      status: record.status,
      phaseStatus: record.phaseStatus,
      durationMs: record.durationMs ?? null,
      quota: record.quota || { status: null, source: null, confidence: null, nextEligibleAt: null, retryAfterMs: null, windowResetAt: null, weeklyResetAt: null, reason: null },
      fallback: record.fallback || { used: false, fromProviderKey: null, toProviderKey: null, count: 0, reason: null },
      providerAttempts: record.providerAttempts || null,
      usage: record.usage || { calls: null, inputTokens: null, outputTokens: null, totalTokens: null, tokenSource: null, toolCalls: null, functionCalls: null },
    };
    await appendProviderUsageLine(hubRoot, entry);
    return entry;
  });
  _usageWriteQueues.set(filePath, next.catch(() => null));
  return next;
}

// ─── Read API ───────────────────────────────────────────────────────

/**
 * Read all usage records from the JSONL log.
 * @param {string} hubRoot
 * @returns {Promise<Array>}
 */
export async function readProviderUsage(hubRoot) {
  try {
    const content = await readFile(usageFilePath(hubRoot), "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Provider-level rollup: calls, successes, failures, tokens per provider.
 * @param {string} hubRoot
 * @returns {Promise<Object>} keyed by providerKey
 */
export async function readProviderUsageRollup(hubRoot) {
  const records = await readProviderUsage(hubRoot);
  const rollup = {};

  for (const r of records) {
    const key = r.providerKey;
    if (!rollup[key]) {
      rollup[key] = {
        providerKey: key,
        agent: r.agent,
        calls: 0,
        ok: 0,
        errors: 0,
        rateLimited: 0,
        tokens: 0,
        tokenSource: "unknown",
        fallbacks: 0,
        quotaEvents: 0,
        totalDurationMs: 0,
      };
    }
    const u = rollup[key];
    u.calls += 1;
    if (r.status === "ok") u.ok += 1;
    else if (r.status === "rate_limited" || r.status === "fallback") u.rateLimited += 1;
    else u.errors += 1;
    if (r.usage?.totalTokens != null) u.tokens += r.usage.totalTokens;
    else if (r.usage?.tokens != null) u.tokens += r.usage.tokens;
    if (r.fallback?.used) u.fallbacks += 1;
    if (r.quota?.status != null) u.quotaEvents += 1;
    if (r.durationMs != null) u.totalDurationMs += r.durationMs;
  }

  return rollup;
}

/**
 * System-level rollup: aggregate across all providers.
 * @param {string} hubRoot
 * @returns {Promise<object>}
 */
export async function readSystemUsageRollup(hubRoot) {
  const providerRollup = await readProviderUsageRollup(hubRoot);
  const providers = Object.values(providerRollup);

  return {
    totalCalls: providers.reduce((s, p) => s + p.calls, 0),
    totalOk: providers.reduce((s, p) => s + p.ok, 0),
    totalErrors: providers.reduce((s, p) => s + p.errors, 0),
    totalRateLimited: providers.reduce((s, p) => s + p.rateLimited, 0),
    totalTokens: providers.reduce((s, p) => s + p.tokens, 0),
    totalFallbacks: providers.reduce((s, p) => s + p.fallbacks, 0),
    totalQuotaEvents: providers.reduce((s, p) => s + p.quotaEvents, 0),
    providerCount: providers.length,
    providers: providerRollup,
  };
}
