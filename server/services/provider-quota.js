/**
 * Provider Quota — centralised provider availability state.
 *
 * Replaces the old per-pool rateLimitState / rate-limits.json with a
 * single source of truth for provider health, quota exhaustion, and
 * back-off scheduling.
 *
 * Durable file: {hubRoot}/providers/quotas.json
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// ─── Status Enum ────────────────────────────────────────────────────
export const QuotaStatus = Object.freeze({
  AVAILABLE: "available",
  RATE_LIMITED: "rate_limited",
  WINDOW_EXHAUSTED: "window_exhausted",
  WEEKLY_EXHAUSTED: "weekly_exhausted",
  AUTH_ERROR: "auth_error",
  UNKNOWN: "unknown",
});

const TERMINAL_STATUSES = new Set([
  QuotaStatus.WINDOW_EXHAUSTED,
  QuotaStatus.WEEKLY_EXHAUSTED,
  QuotaStatus.AUTH_ERROR,
]);

// ─── Error ──────────────────────────────────────────────────────────
export class ProviderQuotaError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {string} opts.providerKey
   * @param {string} opts.agent
   * @param {string} [opts.variant]
   * @param {string} opts.status        - one of QuotaStatus
   * @param {number} [opts.nextEligibleAt] - unix ms
   * @param {string} [opts.source]
   * @param {number} [opts.confidence]  - 0..1
   * @param {string} [opts.reason]
   * @param {string} [opts.phase]
   * @param {string} [opts.role]
   */
  constructor(message, opts) {
    super(redactSecrets(message));
    this.name = "ProviderQuotaError";
    this.providerKey = opts.providerKey;
    this.agent = opts.agent;
    this.variant = opts.variant || null;
    this.status = opts.status;
    this.nextEligibleAt = opts.nextEligibleAt ?? null;
    this.source = opts.source || "provider-quota";
    this.confidence = opts.confidence ?? 1;
    this.reason = redactSecrets(opts.reason || message);
    this.phase = opts.phase || null;
    this.role = opts.role || null;
  }
}

// ─── Secret Redaction ───────────────────────────────────────────────
export function redactSecrets(text) {
  if (!text) return "";
  return String(text)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/Authorization:\s*\S+/gi, "Authorization: [REDACTED]")
    .replace(/api[_-]?key=\S+/gi, "api_key=[REDACTED]")
    .replace(/sk-\S+/gi, "sk-[REDACTED]")
    .replace(/OPENAI_API_KEY=\S+/gi, "OPENAI_API_KEY=[REDACTED]")
    .replace(/ANTHROPIC_API_KEY=\S+/gi, "ANTHROPIC_API_KEY=[REDACTED]")
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .slice(0, 500);
}

// ─── Persistence ────────────────────────────────────────────────────
function quotasFilePath(hubRoot) {
  return path.join(hubRoot, "providers", "quotas.json");
}

export async function readProviderQuotas(hubRoot) {
  try {
    return JSON.parse(await readFile(quotasFilePath(hubRoot), "utf8"));
  } catch {
    return {};
  }
}

// In-process write queue to prevent concurrent write corruption
const _writeQueues = new Map();

export async function _internalWriteProviderQuota(hubRoot, providerKey, entry) {
  const filePath = quotasFilePath(hubRoot);
  const queueKey = filePath;
  const prev = _writeQueues.get(queueKey) || Promise.resolve();
  const next = prev.catch(() => null).then(async () => {
    // Re-read latest to avoid clobbering concurrent writes
    const current = await readProviderQuotas(hubRoot);
    current[providerKey] = {
      ...entry,
      reason: redactSecrets(entry.reason),
      providerKey,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(filePath), { recursive: true });
    const randomSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = `${filePath}.tmp-${randomSuffix}`;
    await writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    await rename(tmp, filePath);
    return current[providerKey];
  });
  _writeQueues.set(queueKey, next.catch(() => null));
  return next;
}

// ─── State Transitions ──────────────────────────────────────────────
export async function _internalMarkProviderUnavailable(hubRoot, {
  providerKey,
  agent,
  variant,
  status,
  nextEligibleAt,
  source,
  confidence,
  reason,
}) {
  const validStatuses = [
    QuotaStatus.RATE_LIMITED,
    QuotaStatus.WINDOW_EXHAUSTED,
    QuotaStatus.WEEKLY_EXHAUSTED,
    QuotaStatus.AUTH_ERROR,
    QuotaStatus.UNKNOWN,
  ];
  if (!validStatuses.includes(status)) {
    throw new Error(`invalid unavailable status: ${status}`);
  }
  return _internalWriteProviderQuota(hubRoot, providerKey, {
    agent,
    variant: variant || null,
    status,
    nextEligibleAt: nextEligibleAt ?? null,
    source: source || "provider-quota",
    confidence: confidence ?? 1,
    reason: reason || "",
  });
}

export async function _internalMarkProviderAvailable(hubRoot, providerKey) {
  const current = await readProviderQuotas(hubRoot);
  const existing = current[providerKey];
  return _internalWriteProviderQuota(hubRoot, providerKey, {
    agent: existing?.agent || providerKey,
    variant: existing?.variant || null,
    status: QuotaStatus.AVAILABLE,
    nextEligibleAt: null,
    source: "mark-available",
    confidence: 1,
    reason: "",
  });
}

// ─── Gate ───────────────────────────────────────────────────────────
export async function assertProviderAvailable(hubRoot, {
  providerKey,
  agent,
  variant,
  phase,
  role,
}) {
  const quotas = await readProviderQuotas(hubRoot);
  const entry = quotas[providerKey];
  if (!entry) return; // no entry = never seen = available

  // Auth errors are terminal — don't retry until explicitly cleared
  if (entry.status === QuotaStatus.AUTH_ERROR) {
    throw new ProviderQuotaError(
      `provider ${providerKey} has auth error: ${entry.reason}`,
      {
        providerKey,
        agent,
        variant,
        status: QuotaStatus.AUTH_ERROR,
        source: entry.source,
        confidence: entry.confidence ?? 1,
        reason: entry.reason,
        phase,
        role,
      },
    );
  }

  // Check nextEligibleAt
  if (entry.nextEligibleAt != null) {
    const waitMs = entry.nextEligibleAt - Date.now();
    if (waitMs > 0) {
      throw new ProviderQuotaError(
        `provider ${providerKey} unavailable until ${new Date(entry.nextEligibleAt).toISOString()}: ${entry.reason}`,
        {
          providerKey,
          agent,
          variant,
          status: entry.status,
          nextEligibleAt: entry.nextEligibleAt,
          source: entry.source,
          confidence: entry.confidence ?? 1,
          reason: entry.reason,
          phase,
          role,
        },
      );
    }
    // Expired — treat as available (do not mutate durable state here;
    // delegate owns all writes; stale entries are reconciled by delegate or next write)
    return;
  }

  // Terminal statuses without nextEligibleAt (e.g. weekly/window with no reset)
  if (TERMINAL_STATUSES.has(entry.status) && entry.nextEligibleAt == null) {
    throw new ProviderQuotaError(
      `provider ${providerKey} is ${entry.status}: ${entry.reason}`,
      {
        providerKey,
        agent,
        variant,
        status: entry.status,
        source: entry.source,
        confidence: entry.confidence ?? 1,
        reason: entry.reason,
        phase,
        role,
      },
    );
  }
}

// ─── Quota Failure Classification ───────────────────────────────────
const HTTP_429 = /\b429\b|rate.?limit|too many requests|capacity|overloaded/i;
const RETRY_AFTER_SEC = /(?:reset|retry|after)[^0-9]*(\d+)\s*(?:s|sec|seconds?)/i;
const ISO_DATE = /20\d\d-\d\d-\d\d[T\s]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?/;
const WINDOW_EXHAUST = /window|quota|exhaust|usage.?limit|monthly.?limit|5.?hour/i;
const WEEKLY_EXHAUST = /weekly|week.?limit/i;
const AUTH_FAIL = /(?:unauthorized|invalid api key|invalid token|expired token|authentication failed|auth failed|forbidden.*api key)/i;
const TOKEN_CONTEXT = /context.?length|max.?token|output.?token|token.?limit/i;

/**
 * Parse a reset time from an error message, respecting timezone.
 *
 * @param {string} message
 * @param {string} [timezone] - IANA timezone for naive timestamps (e.g. "Asia/Shanghai")
 * @param {number} [fallbackMs] - fallback wait in ms
 * @returns {number} unix ms
 */
export function parseResetTime(message, timezone, fallbackMs = 60_000) {
  const text = String(message || "");
  const isoMatch = text.match(ISO_DATE);
  if (isoMatch) {
    let normalized = isoMatch[0].includes("T") ? isoMatch[0] : isoMatch[0].replace(" ", "T");
    const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(normalized);
    if (hasTz) {
      // Explicit timezone — parse directly
      const parsed = Date.parse(normalized);
      if (Number.isFinite(parsed)) return parsed;
    } else if (timezone) {
      // Naive timestamp with known timezone — interpret as local time in that zone
      const parsed = parseNaiveTimestamp(normalized, timezone);
      if (Number.isFinite(parsed)) return parsed;
    } else {
      // No timezone, no zone hint — treat as UTC (legacy behavior)
      const parsed = Date.parse(`${normalized}Z`);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  const seconds = text.match(RETRY_AFTER_SEC);
  if (seconds) return Date.now() + Number(seconds[1]) * 1000;
  return Date.now() + fallbackMs;
}

/**
 * Interpret a naive ISO timestamp as local time in the given IANA timezone,
 * then return the equivalent UTC unix ms.
 *
 * e.g. "2026-05-31T12:00:00" in "Asia/Shanghai" → 2026-05-31T04:00:00Z
 */
function parseNaiveTimestamp(isoLocal, timezone) {
  // Use Intl to get the UTC offset for the given timezone at that point in time.
  // We try: parse as UTC, then adjust by the offset difference.
  const utcGuess = Date.parse(isoLocal.endsWith("Z") ? isoLocal : `${isoLocal}Z`);
  if (!Number.isFinite(utcGuess)) return NaN;

  // Get the offset in minutes for the target timezone at that UTC moment
  const offsetMinutes = getTimezoneOffsetMinutes(utcGuess, timezone);
  if (offsetMinutes == null) return NaN;

  // The naive time is interpreted as (UTC - offsetMinutes)
  // So UTC = naiveUTC + offsetMinutes * 60_000
  // But we parsed it as UTC, so: realUTC = utcGuess - offsetMinutes * 60_000
  return utcGuess - offsetMinutes * 60_000;
}

function getTimezoneOffsetMinutes(utcMs, timezone) {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (type) => Number(parts.find((p) => p.type === type)?.value);
    const localMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    // offset = local - utc (positive for east of Greenwich)
    return (localMs - utcMs) / 60_000;
  } catch {
    return null;
  }
}

// ─── Classifier ─────────────────────────────────────────────────────
/**
 * Classify an ACP execution error as a quota failure or not.
 *
 * Pipeline:
 *   1. Deterministic parser (message patterns)
 *   2. Provider adapter parser (adapter.parseLimitError)
 *   3. Non-fault classifier (heuristic)
 *   4. Fixed backoff fallback
 *
 * @param {object} opts
 * @param {string} opts.providerKey
 * @param {string} opts.agent
 * @param {string} [opts.variant]
 * @param {Error} opts.error
 * @param {string} [opts.stdout]
 * @param {string} [opts.stderr]
 * @param {object} [opts.adapter] - provider adapter (optional)
 * @returns {Promise<{isQuota: boolean, status?: string, nextEligibleAt?: number, confidence?: number, reason?: string}>}
 */
export async function classifyQuotaFailure({ providerKey, agent, variant, error, stdout, stderr, adapter }) {
  const msg = error?.message || String(error || "");
  const combined = `${msg}\n${stderr || ""}\n${stdout || ""}`;

  // ── Layer 1: Deterministic parser ────────────────────────────────
  if (HTTP_429.test(combined)) {
    const timezone = adapter?.timezone || null;
    const nextEligibleAt = parseResetTime(combined, timezone);

    // Check for window / weekly exhaustion
    if (WEEKLY_EXHAUST.test(combined)) {
      return {
        isQuota: true,
        status: QuotaStatus.WEEKLY_EXHAUSTED,
        nextEligibleAt,
        confidence: 0.95,
        reason: `weekly quota exhausted: ${msg.slice(0, 200)}`,
      };
    }
    if (WINDOW_EXHAUST.test(combined)) {
      return {
        isQuota: true,
        status: QuotaStatus.WINDOW_EXHAUSTED,
        nextEligibleAt,
        confidence: 0.95,
        reason: `window quota exhausted: ${msg.slice(0, 200)}`,
      };
    }
    return {
      isQuota: true,
      status: QuotaStatus.RATE_LIMITED,
      nextEligibleAt,
      confidence: 0.9,
      reason: `rate limited: ${msg.slice(0, 200)}`,
    };
  }

  // Auth errors (exclude token/context-length false positives)
  if (AUTH_FAIL.test(msg) && !TOKEN_CONTEXT.test(msg)) {
    return {
      isQuota: true,
      status: QuotaStatus.AUTH_ERROR,
      nextEligibleAt: null,
      confidence: 0.85,
      reason: `auth error: ${msg.slice(0, 200)}`,
    };
  }

  // ── Layer 2: Adapter parser ──────────────────────────────────────
  if (adapter?.parseLimitError) {
    try {
      const adapterResult = await adapter.parseLimitError({ error, stdout, stderr });
      if (adapterResult?.isQuota) {
        return {
          isQuota: true,
          status: adapterResult.status || QuotaStatus.RATE_LIMITED,
          nextEligibleAt: adapterResult.nextEligibleAt ?? parseResetTime(combined, adapter.timezone),
          confidence: adapterResult.confidence ?? 0.8,
          reason: adapterResult.reason || `adapter detected quota: ${msg.slice(0, 200)}`,
        };
      }
    } catch {
      // Adapter parser failed — continue to next layer
    }
  }

  // ── Layer 3: Non-fault heuristic ─────────────────────────────────
  // Exhaustion keywords without explicit 429
  if (WINDOW_EXHAUST.test(combined)) {
    return {
      isQuota: true,
      status: QuotaStatus.WINDOW_EXHAUSTED,
      nextEligibleAt: Date.now() + 5 * 60 * 60 * 1000, // 5h default
      confidence: 0.6,
      reason: `possible window exhaustion: ${msg.slice(0, 200)}`,
    };
  }

  // ── Layer 4: Not a quota failure ─────────────────────────────────
  return { isQuota: false };
}

// ─── Fixed Backoff ──────────────────────────────────────────────────
const AMBIGUOUS_BACKOFFS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

/**
 * Compute backoff when all providers are unavailable.
 *
 * @param {object} opts
 * @param {number} [opts.retryAfter]     - explicit Retry-After ms
 * @param {number} [opts.windowReset]    - window reset unix ms
 * @param {number} [opts.weeklyReset]    - weekly reset unix ms
 * @param {number} [opts.ambiguous429Attempt] - 0-indexed attempt for ambiguous 429
 * @returns {{nextEligibleAt: number, reason: string}}
 */
export function computeFixedBackoff({ retryAfter, windowReset, weeklyReset, ambiguous429Attempt = 0 }) {
  if (retryAfter != null && retryAfter > 0) {
    return { nextEligibleAt: Date.now() + retryAfter, reason: `retry-after ${retryAfter}ms` };
  }
  if (windowReset != null && windowReset > Date.now()) {
    return { nextEligibleAt: windowReset, reason: `window reset at ${new Date(windowReset).toISOString()}` };
  }
  if (weeklyReset != null && weeklyReset > Date.now()) {
    return { nextEligibleAt: weeklyReset, reason: `weekly reset at ${new Date(weeklyReset).toISOString()}` };
  }
  const idx = Math.min(ambiguous429Attempt, AMBIGUOUS_BACKOFFS.length - 1);
  const ms = AMBIGUOUS_BACKOFFS[idx];
  return { nextEligibleAt: Date.now() + ms, reason: `ambiguous backoff attempt ${ambiguous429Attempt}: ${ms}ms` };
}

// ─── List ───────────────────────────────────────────────────────────
export async function listProviderQuotas(hubRoot) {
  const quotas = await readProviderQuotas(hubRoot);
  return Object.values(quotas);
}

// ─── Sanitize ───────────────────────────────────────────────────────
export function sanitizeProviderReason(reason) {
  if (!reason) return "";
  // Strip ANSI escapes, control chars, and limit length
  return String(reason)
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .slice(0, 500);
}
