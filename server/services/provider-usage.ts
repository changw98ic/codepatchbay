/**
 * Provider Usage — JSONL-based phase-level usage tracking.
 *
 * Records provider usage per phase to {hubRoot}/providers/usage.jsonl.
 * Phase-level (not per-call): runJob() enqueues after each phase completes.
 *
 * Write: _internalAppendUsageLine (delegate + tests only — production callers use quota-delegate-client.js)
 * Read:  readProviderUsage, readProviderUsageRollup, readSystemUsageRollup
 */

import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LooseRecord } from "../../shared/types.js";
import { providerFamilyFor } from "../../core/agents/outcome-routing.js";

const USAGE_FILE = "usage.jsonl";

type UsageRecord = LooseRecord & {
  providerKey?: string;
  agent?: string;
  jobId?: string | null;
  taskCategory?: string | null;
  phase?: string | null;
  role?: string | null;
  phaseStatus?: string | null;
  failureKind?: string | null;
  retryCount?: number | null;
  phaseRetryCount?: number | null;
  jobRetryCount?: number | null;
  isRetry?: boolean | null;
  recordedAt?: string | null;
  status?: string;
  usage?: {
    calls?: number | null;
    totalTokens?: number | null;
    tokens?: number | null;
    costUsd?: number | null;
    tokenSource?: string | null;
  };
  fallback?: {
    used?: boolean;
  };
  quota?: {
    status?: string;
  };
  durationMs?: number;
};

type JsonRecord = {
  [key: string]: unknown;
};

type ProviderRollup = JsonRecord & {
  providerKey: string;
  calls: number;
  ok: number;
  errors: number;
  rateLimited: number;
  llmCalls: number;
  tokens: number | null;
  reportedTokens: number;
  reportedTokenCalls: number;
  unreportedTokenCalls: number;
  tokenCoverage: number | null;
  tokenSource: string | null;
  tokenSources: string[];
  unreportedTokenSources: string[];
  costUsd: number | null;
  reportedCostUsd: number;
  reportedCostCalls: number;
  unreportedCostCalls: number;
  costCoverage: number | null;
  fallbacks: number;
  quotaEvents: number;
  totalDurationMs: number;
};

function usageRecord(value: unknown): UsageRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UsageRecord : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? Math.floor(number) : fallback;
}

function coverage(reported: number, total: number): number | null {
  return total > 0 ? reported / total : null;
}

function sortedStrings(values: Set<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function usageFilePath(hubRoot: string) {
  return path.join(hubRoot, "providers", USAGE_FILE);
}

/**
 * Low-level JSONL append. Internal — only quota-delegate.js and tests should call.
 * Production callers must use quota-delegate-client.delegateEnqueueProviderUsage().
 * @param {string} hubRoot
 * @param {object} record — already-normalized entry
 */
export async function _internalAppendUsageLine(hubRoot: string, record: LooseRecord) {
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

// ─── Read API ───────────────────────────────────────────────────────

/**
 * Read all usage records from the JSONL log.
 * @param {string} hubRoot
 * @returns {Promise<Array>}
 */
export async function readProviderUsage(hubRoot: string): Promise<UsageRecord[]> {
  try {
    const content = await readFile(usageFilePath(hubRoot), "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return usageRecord(JSON.parse(line)); } catch { return null; }
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
export async function readProviderUsageRollup(hubRoot: string): Promise<Record<string, ProviderRollup>> {
  const records = await readProviderUsage(hubRoot);
  const rollup: Record<string, ProviderRollup> = {};
  const sourcesByProvider = new Map<string, Set<string>>();
  const missingSourcesByProvider = new Map<string, Set<string>>();

  for (const r of records) {
    const key = r.providerKey || "unknown";
    if (!rollup[key]) {
      rollup[key] = {
        providerKey: key,
        agent: r.agent,
        calls: 0,
        ok: 0,
        errors: 0,
        rateLimited: 0,
        llmCalls: 0,
        tokens: 0,
        reportedTokens: 0,
        reportedTokenCalls: 0,
        unreportedTokenCalls: 0,
        tokenCoverage: null,
        tokenSource: null,
        tokenSources: [],
        unreportedTokenSources: [],
        costUsd: 0,
        reportedCostUsd: 0,
        reportedCostCalls: 0,
        unreportedCostCalls: 0,
        costCoverage: null,
        fallbacks: 0,
        quotaEvents: 0,
        totalDurationMs: 0,
      };
      sourcesByProvider.set(key, new Set());
      missingSourcesByProvider.set(key, new Set());
    }
    const u = rollup[key];
    u.calls += 1;
    if (r.status === "ok") u.ok += 1;
    else if (r.status === "rate_limited" || r.status === "fallback") u.rateLimited += 1;
    else u.errors += 1;
    const llmCalls = nonNegativeInt(r.usage?.calls, 1);
    const totalTokens = finiteNumber(r.usage?.totalTokens) ?? finiteNumber(r.usage?.tokens);
    const costUsd = finiteNumber(r.usage?.costUsd);
    const tokenSource = typeof r.usage?.tokenSource === "string" && r.usage.tokenSource.trim()
      ? r.usage.tokenSource.trim()
      : "unspecified";
    u.llmCalls += llmCalls;
    if (llmCalls > 0 && totalTokens !== null) {
      u.reportedTokens += totalTokens;
      u.reportedTokenCalls += llmCalls;
      sourcesByProvider.get(key)?.add(tokenSource);
    } else if (llmCalls > 0) {
      u.unreportedTokenCalls += llmCalls;
      missingSourcesByProvider.get(key)?.add(tokenSource);
    }
    if (llmCalls > 0 && costUsd !== null) {
      u.reportedCostUsd += costUsd;
      u.reportedCostCalls += llmCalls;
    } else if (llmCalls > 0) {
      u.unreportedCostCalls += llmCalls;
    }
    if (r.fallback?.used) u.fallbacks += 1;
    if (r.quota?.status != null) u.quotaEvents += 1;
    const durationMs = finiteNumber(r.durationMs);
    if (durationMs !== null) u.totalDurationMs += durationMs;
  }

  for (const [key, provider] of Object.entries(rollup)) {
    provider.tokenCoverage = coverage(provider.reportedTokenCalls, provider.llmCalls);
    provider.costCoverage = coverage(provider.reportedCostCalls, provider.llmCalls);
    provider.tokens = provider.unreportedTokenCalls === 0 ? provider.reportedTokens : null;
    provider.costUsd = provider.unreportedCostCalls === 0 ? provider.reportedCostUsd : null;
    provider.tokenSources = sortedStrings(sourcesByProvider.get(key) || new Set());
    provider.unreportedTokenSources = sortedStrings(missingSourcesByProvider.get(key) || new Set());
    provider.tokenSource = provider.tokenSources.length === 1
      ? provider.tokenSources[0]
      : provider.tokenSources.length > 1 ? "mixed" : null;
  }

  return rollup;
}

/**
 * System-level rollup: aggregate across all providers.
 * @param {string} hubRoot
 * @returns {Promise<object>}
 */
export async function readSystemUsageRollup(hubRoot: string) {
  const providerRollup = await readProviderUsageRollup(hubRoot);
  const providers = Object.values(providerRollup);

  const llmCalls = providers.reduce((sum, provider) => sum + provider.llmCalls, 0);
  const reportedTokenCalls = providers.reduce((sum, provider) => sum + provider.reportedTokenCalls, 0);
  const unreportedTokenCalls = providers.reduce((sum, provider) => sum + provider.unreportedTokenCalls, 0);
  const reportedTokens = providers.reduce((sum, provider) => sum + provider.reportedTokens, 0);
  const reportedCostCalls = providers.reduce((sum, provider) => sum + provider.reportedCostCalls, 0);
  const unreportedCostCalls = providers.reduce((sum, provider) => sum + provider.unreportedCostCalls, 0);
  const reportedCostUsd = providers.reduce((sum, provider) => sum + provider.reportedCostUsd, 0);

  return {
    totalCalls: providers.reduce((s, p) => s + p.calls, 0),
    totalOk: providers.reduce((s, p) => s + p.ok, 0),
    totalErrors: providers.reduce((s, p) => s + p.errors, 0),
    totalRateLimited: providers.reduce((s, p) => s + p.rateLimited, 0),
    llmCalls,
    totalTokens: unreportedTokenCalls === 0 ? reportedTokens : null,
    reportedTokens,
    reportedTokenCalls,
    unreportedTokenCalls,
    tokenCoverage: coverage(reportedTokenCalls, llmCalls),
    totalCostUsd: unreportedCostCalls === 0 ? reportedCostUsd : null,
    reportedCostUsd,
    reportedCostCalls,
    unreportedCostCalls,
    costCoverage: coverage(reportedCostCalls, llmCalls),
    totalFallbacks: providers.reduce((s, p) => s + p.fallbacks, 0),
    totalQuotaEvents: providers.reduce((s, p) => s + p.quotaEvents, 0),
    providerCount: providers.length,
    providers: providerRollup,
  };
}

/**
 * Outcome metrics for agent routing. This intentionally excludes token and
 * cost data: resource telemetry must not become a proxy for solution quality.
 * Executor verification quality is joined by jobId against the verifier phase.
 */
export async function readAgentRoutingMetrics(hubRoot: string, query: LooseRecord = {}) {
  const records = await readProviderUsage(hubRoot);
  const phase = typeof query.phase === "string" ? query.phase : null;
  const role = typeof query.role === "string" ? query.role : null;
  const taskCategory = typeof query.taskCategory === "string" ? query.taskCategory : "unknown";
  const scoped = records.filter((record) =>
    (!phase || record.phase === phase) && (!role || record.role === role),
  );
  const verifierByJob = new Map<string, boolean>();
  for (const record of records) {
    if (!record.jobId || record.role !== "verifier") continue;
    const passed = record.phaseStatus === "passed" || record.status === "ok";
    verifierByJob.set(record.jobId, (verifierByJob.get(record.jobId) ?? true) && passed);
  }

  const byAgent = new Map<string, UsageRecord[]>();
  for (const record of scoped) {
    const agent = typeof record.agent === "string" && record.agent ? record.agent : null;
    if (!agent) continue;
    const entries = byAgent.get(agent) || [];
    entries.push(record);
    byAgent.set(agent, entries);
  }

  const agents: Record<string, LooseRecord> = {};
  for (const [agent, allEntries] of byAgent) {
    const exactEntries = allEntries.filter((entry) => entry.taskCategory === taskCategory);
    const entries = (exactEntries.length >= 8 ? exactEntries : allEntries).slice(-100);
    const scope = exactEntries.length >= 8 ? "task_category_phase_role" : "phase_role";
    const scopeConfidence = scope === "task_category_phase_role" || taskCategory === "unknown" ? 1 : 0.5;
    let successes = 0;
    let retries = 0;
    let timeouts = 0;
    let verifierRuns = 0;
    let verifierPasses = 0;
    let totalDurationMs = 0;
    const failureKinds: Record<string, number> = {};
    const providerCounts = new Map<string, number>();

    for (const entry of entries) {
      const passed = entry.phaseStatus === "passed" || entry.status === "ok";
      if (passed) successes += 1;
      if (entry.isRetry === true || (finiteNumber(entry.retryCount) ?? 0) > 0) retries += 1;
      if (entry.status === "timeout" || entry.failureKind === "timeout") timeouts += 1;
      const duration = finiteNumber(entry.durationMs);
      if (duration !== null) totalDurationMs += duration;
      if (entry.failureKind) failureKinds[entry.failureKind] = (failureKinds[entry.failureKind] || 0) + 1;
      if (entry.providerKey) providerCounts.set(entry.providerKey, (providerCounts.get(entry.providerKey) || 0) + 1);

      if (role === "executor" && entry.jobId && verifierByJob.has(entry.jobId)) {
        verifierRuns += 1;
        if (verifierByJob.get(entry.jobId)) verifierPasses += 1;
      } else if (role === "verifier") {
        verifierRuns += 1;
        if (passed) verifierPasses += 1;
      }
    }

    const providerKey = [...providerCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || null;
    agents[agent] = {
      agent,
      providerKey,
      providerFamily: providerFamilyFor(agent, providerKey),
      phase,
      role,
      taskCategory,
      scope,
      scopeConfidence,
      sampleSize: entries.length,
      successes,
      retries,
      timeouts,
      verifierRuns,
      verifierPasses,
      evidenceCoverage: role === "executor"
        ? coverage(verifierRuns, entries.length) ?? 0
        : 1,
      totalDurationMs,
      failureKinds,
    };
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    query: { phase, role, taskCategory },
    historyLimitPerAgent: 100,
    agents,
  };
}
