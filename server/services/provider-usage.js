/**
 * Provider Usage — JSONL-based usage tracking.
 *
 * Records every provider call to {hubRoot}/providers/usage.jsonl
 * with structured metadata for observability and rollup.
 */

import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

const USAGE_FILE = "usage.jsonl";

function usageFilePath(hubRoot) {
  return path.join(hubRoot, "providers", USAGE_FILE);
}

/**
 * Append a usage record to the JSONL log.
 *
 * @param {object} record
 * @param {string} record.providerKey
 * @param {string} record.agent
 * @param {string} [record.variant]
 * @param {string} record.phase
 * @param {string} [record.role]
 * @param {string} [record.project]
 * @param {string} [record.jobId]
 * @param {string} [record.callType] - "execute" | "persistent" | "one-shot"
 * @param {string} record.status    - "ok" | "error" | "rate_limited" | "timeout"
 * @param {number} [record.tokens]
 * @param {string} [record.tokenSource] - "reported" | "estimated" | "unknown"
 * @param {number} [record.toolCalls]
 * @param {number} [record.functionCalls]
 * @param {boolean} [record.handoff]
 * @param {boolean} [record.midRunQuotaFailure]
 * @param {number} [record.durationMs]
 * @param {string} [record.errorKind]
 * @param {string} [record.errorMessage]
 */
export async function recordProviderUsage(hubRoot, record) {
  const filePath = usageFilePath(hubRoot);
  await mkdir(path.dirname(filePath), { recursive: true });

  const entry = {
    ts: new Date().toISOString(),
    providerKey: record.providerKey,
    agent: record.agent,
    variant: record.variant || null,
    phase: record.phase,
    role: record.role || null,
    project: record.project || null,
    jobId: record.jobId || null,
    callType: record.callType || null,
    status: record.status,
    tokens: record.tokens ?? null,
    tokenSource: record.tokenSource || "unknown",
    toolCalls: record.toolCalls ?? null,
    functionCalls: record.functionCalls ?? null,
    handoff: record.handoff || false,
    midRunQuotaFailure: record.midRunQuotaFailure || false,
    durationMs: record.durationMs ?? null,
    errorKind: record.errorKind || null,
    errorMessage: record.errorMessage || null,
  };

  const line = `${JSON.stringify(entry)}\n`;

  // Atomic-ish append: use appendFile (POSIX appends are atomic for small writes)
  try {
    await appendFile(filePath, line, "utf8");
  } catch {
    // File might not exist yet — create it
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, line, "utf8");
  }

  return entry;
}

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
        handoffs: 0,
        midRunQuotaFailures: 0,
        totalDurationMs: 0,
      };
    }
    const u = rollup[key];
    u.calls += 1;
    if (r.status === "ok") u.ok += 1;
    else if (r.status === "rate_limited") u.rateLimited += 1;
    else u.errors += 1;
    if (r.tokens != null) u.tokens += r.tokens;
    if (r.handoff) u.handoffs += 1;
    if (r.midRunQuotaFailure) u.midRunQuotaFailures += 1;
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
    totalHandoffs: providers.reduce((s, p) => s + p.handoffs, 0),
    totalMidRunQuotaFailures: providers.reduce((s, p) => s + p.midRunQuotaFailures, 0),
    providerCount: providers.length,
    providers: providerRollup,
  };
}
