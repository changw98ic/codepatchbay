/**
 * Provider Adapters — supplier-specific quota semantics.
 *
 * Each adapter knows:
 *   - region / timezone (for naive timestamp interpretation)
 *   - how to parse supplier-specific limit errors
 *   - quota policy (daily window, weekly cap, etc.)
 */

import { parseResetTime } from "./provider-quota.js";

// ─── Adapter Registry ───────────────────────────────────────────────
const adapters = new Map();

function register(key, adapter) {
  adapters.set(key, Object.freeze({ providerKeyPattern: key, ...adapter }));
}

// ─── Built-in Adapters ──────────────────────────────────────────────

register("codex", {
  region: "global",
  timezone: "UTC",
  quotaPolicy: { type: "per-minute", description: "OpenAI per-minute rate limit" },
  parseLimitError: null, // uses deterministic parser
  parseResetTime: (msg) => parseResetTime(msg, "UTC"),
});

register("claude", {
  region: "global",
  timezone: "UTC",
  quotaPolicy: { type: "per-minute", description: "Anthropic per-minute rate limit" },
  parseLimitError: null,
  parseResetTime: (msg) => parseResetTime(msg, "UTC"),
});

register("claude:kimi-k2.6", {
  region: "cn",
  timezone: "Asia/Shanghai",
  quotaPolicy: {
    type: "5h-window",
    description: "Kimi 5-hour usage window, weekly cap",
    windowHours: 5,
  },
  parseLimitError({ error, stderr }) {
    const msg = `${error?.message || ""}\n${stderr || ""}`;
    if (/weekly|week.?limit/i.test(msg)) {
      return {
        isQuota: true,
        status: "weekly_exhausted",
        confidence: 0.9,
        reason: msg.slice(0, 200),
      };
    }
    if (/window|quota|exhaust|5.?hour/i.test(msg)) {
      return {
        isQuota: true,
        status: "window_exhausted",
        confidence: 0.9,
        reason: msg.slice(0, 200),
      };
    }
    return null;
  },
  parseResetTime: (msg) => parseResetTime(msg, "Asia/Shanghai"),
});

register("claude:mimo-v2.5pro", {
  region: "cn",
  timezone: "Asia/Shanghai",
  quotaPolicy: {
    type: "5h-window",
    description: "MiMo 5-hour usage window, weekly cap",
    windowHours: 5,
  },
  parseLimitError({ error, stderr }) {
    const msg = `${error?.message || ""}\n${stderr || ""}`;
    if (/weekly|week.?limit/i.test(msg)) {
      return {
        isQuota: true,
        status: "weekly_exhausted",
        confidence: 0.9,
        reason: msg.slice(0, 200),
      };
    }
    if (/window|quota|exhaust|5.?hour/i.test(msg)) {
      return {
        isQuota: true,
        status: "window_exhausted",
        confidence: 0.9,
        reason: msg.slice(0, 200),
      };
    }
    return null;
  },
  parseResetTime: (msg) => parseResetTime(msg, "Asia/Shanghai"),
});

register("generic", {
  region: "global",
  timezone: "UTC",
  quotaPolicy: { type: "unknown", description: "default fallback" },
  parseLimitError: null,
  parseResetTime: (msg) => parseResetTime(msg, "UTC"),
});

// ─── Lookup ─────────────────────────────────────────────────────────

/**
 * Get the adapter for a provider key.
 * Tries exact match first, then falls back to "generic".
 *
 * @param {string} providerKey - e.g. "claude", "claude:kimi-k2.6", "codex"
 * @returns {object} adapter
 */
export function getProviderAdapter(providerKey) {
  if (adapters.has(providerKey)) return adapters.get(providerKey);
  // Try agent-level fallback (e.g. "claude:kimi-k2.6" → "claude")
  const agent = providerKey.split(":")[0];
  if (adapters.has(agent)) return adapters.get(agent);
  return adapters.get("generic");
}

/**
 * List all registered adapter keys.
 */
export function listAdapterKeys() {
  return [...adapters.keys()];
}
