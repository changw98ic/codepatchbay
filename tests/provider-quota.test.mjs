/**
 * Provider Quota system tests.
 * Uses Node.js built-in test runner (npm test).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  QuotaStatus,
  ProviderQuotaError,
  readProviderQuotas,
  writeProviderQuota,
  markProviderUnavailable,
  markProviderAvailable,
  assertProviderAvailable,
  classifyQuotaFailure,
  computeFixedBackoff,
  listProviderQuotas,
  parseResetTime,
  sanitizeProviderReason,
} from "../server/services/provider-quota.js";
import { getProviderAdapter, listAdapterKeys } from "../server/services/provider-adapters.js";
import {
  recordProviderUsage,
  readProviderUsage,
  readProviderUsageRollup,
  readSystemUsageRollup,
} from "../server/services/provider-usage.js";

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "pq-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── QuotaStatus ────────────────────────────────────────────────────

describe("QuotaStatus", () => {
  it("has expected values", () => {
    assert.equal(QuotaStatus.AVAILABLE, "available");
    assert.equal(QuotaStatus.RATE_LIMITED, "rate_limited");
    assert.equal(QuotaStatus.WINDOW_EXHAUSTED, "window_exhausted");
    assert.equal(QuotaStatus.WEEKLY_EXHAUSTED, "weekly_exhausted");
    assert.equal(QuotaStatus.AUTH_ERROR, "auth_error");
    assert.equal(QuotaStatus.UNKNOWN, "unknown");
  });
});

// ─── ProviderQuotaError ─────────────────────────────────────────────

describe("ProviderQuotaError", () => {
  it("stores all fields", () => {
    const err = new ProviderQuotaError("test error", {
      providerKey: "claude:kimi-k2.6",
      agent: "claude",
      variant: "kimi-k2.6",
      status: QuotaStatus.RATE_LIMITED,
      nextEligibleAt: 1000,
      source: "test",
      confidence: 0.9,
      reason: "test reason",
      phase: "execute",
      role: "executor",
    });
    assert.equal(err.name, "ProviderQuotaError");
    assert.equal(err.providerKey, "claude:kimi-k2.6");
    assert.equal(err.agent, "claude");
    assert.equal(err.variant, "kimi-k2.6");
    assert.equal(err.status, "rate_limited");
    assert.equal(err.nextEligibleAt, 1000);
    assert.equal(err.confidence, 0.9);
    assert.equal(err.phase, "execute");
  });
});

// ─── Persistence ────────────────────────────────────────────────────

describe("read/write quotas", () => {
  it("returns empty object when no file exists", async () => {
    const quotas = await readProviderQuotas(tmpDir);
    assert.deepEqual(quotas, {});
  });

  it("writes and reads quota entry", async () => {
    await writeProviderQuota(tmpDir, "claude", {
      agent: "claude",
      status: QuotaStatus.AVAILABLE,
    });
    const quotas = await readProviderQuotas(tmpDir);
    assert.equal(quotas.claude.agent, "claude");
    assert.equal(quotas.claude.status, "available");
    assert.ok(quotas.claude.updatedAt);
    assert.equal(quotas.claude.providerKey, "claude");
  });

  it("atomic write uses rename", async () => {
    await writeProviderQuota(tmpDir, "codex", { agent: "codex", status: QuotaStatus.AVAILABLE });
    const content = await readFile(path.join(tmpDir, "providers", "quotas.json"), "utf8");
    const parsed = JSON.parse(content);
    assert.ok(parsed.codex);
  });
});

// ─── markProviderUnavailable / markProviderAvailable ─────────────────

describe("markProviderUnavailable", () => {
  it("sets status and nextEligibleAt", async () => {
    const nextEligibleAt = Date.now() + 60_000;
    await markProviderUnavailable(tmpDir, {
      providerKey: "claude",
      agent: "claude",
      status: QuotaStatus.RATE_LIMITED,
      nextEligibleAt,
      reason: "429",
    });
    const quotas = await readProviderQuotas(tmpDir);
    assert.equal(quotas.claude.status, "rate_limited");
    assert.equal(quotas.claude.nextEligibleAt, nextEligibleAt);
  });

  it("rejects invalid status", async () => {
    await assert.rejects(
      () => markProviderUnavailable(tmpDir, {
        providerKey: "claude",
        agent: "claude",
        status: "available",
      }),
      /invalid unavailable status/,
    );
  });
});

describe("markProviderAvailable", () => {
  it("clears status to available", async () => {
    await markProviderUnavailable(tmpDir, {
      providerKey: "claude",
      agent: "claude",
      status: QuotaStatus.RATE_LIMITED,
      nextEligibleAt: Date.now() + 60_000,
      reason: "429",
    });
    await markProviderAvailable(tmpDir, "claude");
    const quotas = await readProviderQuotas(tmpDir);
    assert.equal(quotas.claude.status, "available");
    assert.equal(quotas.claude.nextEligibleAt, null);
  });
});

// ─── assertProviderAvailable ─────────────────────────────────────────

describe("assertProviderAvailable", () => {
  it("passes when no entry exists", async () => {
    await assert.doesNotReject(
      () => assertProviderAvailable(tmpDir, { providerKey: "claude", agent: "claude" }),
    );
  });

  it("passes when status is available", async () => {
    await markProviderAvailable(tmpDir, "claude");
    await assert.doesNotReject(
      () => assertProviderAvailable(tmpDir, { providerKey: "claude", agent: "claude" }),
    );
  });

  it("throws when rate limited and not expired", async () => {
    await markProviderUnavailable(tmpDir, {
      providerKey: "claude",
      agent: "claude",
      status: QuotaStatus.RATE_LIMITED,
      nextEligibleAt: Date.now() + 60_000,
      reason: "429",
    });
    await assert.rejects(
      () => assertProviderAvailable(tmpDir, { providerKey: "claude", agent: "claude" }),
      ProviderQuotaError,
    );
  });

  it("clears expired rate limit and passes", async () => {
    await markProviderUnavailable(tmpDir, {
      providerKey: "claude",
      agent: "claude",
      status: QuotaStatus.RATE_LIMITED,
      nextEligibleAt: Date.now() - 1000,
      reason: "429",
    });
    await assert.doesNotReject(
      () => assertProviderAvailable(tmpDir, { providerKey: "claude", agent: "claude" }),
    );
    // Should have been cleared to available
    const quotas = await readProviderQuotas(tmpDir);
    assert.equal(quotas.claude.status, "available");
  });

  it("throws for auth error (terminal)", async () => {
    await markProviderUnavailable(tmpDir, {
      providerKey: "claude",
      agent: "claude",
      status: QuotaStatus.AUTH_ERROR,
      nextEligibleAt: null,
      reason: "invalid key",
    });
    await assert.rejects(
      () => assertProviderAvailable(tmpDir, { providerKey: "claude", agent: "claude" }),
      (err) => {
        assert.ok(err instanceof ProviderQuotaError);
        assert.equal(err.status, "auth_error");
        return true;
      },
    );
  });

  it("throws for window exhaustion without nextEligibleAt", async () => {
    await markProviderUnavailable(tmpDir, {
      providerKey: "claude:kimi-k2.6",
      agent: "claude",
      variant: "kimi-k2.6",
      status: QuotaStatus.WINDOW_EXHAUSTED,
      nextEligibleAt: null,
      reason: "5h window used up",
    });
    await assert.rejects(
      () => assertProviderAvailable(tmpDir, { providerKey: "claude:kimi-k2.6", agent: "claude" }),
      (err) => {
        assert.ok(err instanceof ProviderQuotaError);
        assert.equal(err.status, "window_exhausted");
        return true;
      },
    );
  });
});

// ─── parseResetTime ─────────────────────────────────────────────────

describe("parseResetTime", () => {
  it("parses ISO date with Z timezone", () => {
    const ts = parseResetTime("rate limited until 2026-05-31T12:00:00Z", "UTC");
    assert.equal(ts, Date.parse("2026-05-31T12:00:00Z"));
  });

  it("parses ISO date with offset timezone", () => {
    const ts = parseResetTime("rate limited until 2026-05-31T12:00:00+08:00", "UTC");
    assert.equal(ts, Date.parse("2026-05-31T12:00:00+08:00"));
  });

  it("interprets naive timestamp as Asia/Shanghai", () => {
    // "2026-05-31T12:00:00" in Asia/Shanghai is UTC+8, so UTC = 04:00:00Z
    const ts = parseResetTime("retry at 2026-05-31T12:00:00", "Asia/Shanghai");
    const expected = Date.parse("2026-05-31T04:00:00Z");
    assert.equal(ts, expected);
  });

  it("interprets naive timestamp as UTC when no timezone given", () => {
    const ts = parseResetTime("retry at 2026-05-31T12:00:00", null);
    assert.equal(ts, Date.parse("2026-05-31T12:00:00Z"));
  });

  it("parses relative seconds", () => {
    const before = Date.now();
    const ts = parseResetTime("retry after 120 seconds", "UTC");
    assert.ok(ts >= before + 120_000 - 100);
    assert.ok(ts <= before + 120_000 + 100);
  });

  it("falls back to default ms", () => {
    const before = Date.now();
    const ts = parseResetTime("something happened", "UTC", 30_000);
    assert.ok(ts >= before + 30_000 - 100);
    assert.ok(ts <= before + 30_000 + 100);
  });
});

// ─── classifyQuotaFailure ───────────────────────────────────────────

describe("classifyQuotaFailure", () => {
  it("detects 429 as rate_limited", async () => {
    const result = await classifyQuotaFailure({
      providerKey: "claude",
      agent: "claude",
      error: new Error("429 too many requests"),
    });
    assert.equal(result.isQuota, true);
    assert.equal(result.status, "rate_limited");
    assert.ok(result.confidence >= 0.9);
  });

  it("detects window exhaustion", async () => {
    const result = await classifyQuotaFailure({
      providerKey: "claude:kimi-k2.6",
      agent: "claude",
      error: new Error("429 window quota exhausted"),
    });
    assert.equal(result.isQuota, true);
    assert.equal(result.status, "window_exhausted");
  });

  it("detects weekly exhaustion", async () => {
    const result = await classifyQuotaFailure({
      providerKey: "claude:kimi-k2.6",
      agent: "claude",
      error: new Error("429 weekly limit reached"),
    });
    assert.equal(result.isQuota, true);
    assert.equal(result.status, "weekly_exhausted");
  });

  it("detects auth errors", async () => {
    const result = await classifyQuotaFailure({
      providerKey: "claude",
      agent: "claude",
      error: new Error("unauthorized: invalid api key"),
    });
    assert.equal(result.isQuota, true);
    assert.equal(result.status, "auth_error");
  });

  it("returns isQuota=false for non-quota errors", async () => {
    const result = await classifyQuotaFailure({
      providerKey: "claude",
      agent: "claude",
      error: new Error("connection refused"),
    });
    assert.equal(result.isQuota, false);
  });

  it("uses adapter timezone for naive timestamps", async () => {
    const adapter = getProviderAdapter("claude:kimi-k2.6");
    const result = await classifyQuotaFailure({
      providerKey: "claude:kimi-k2.6",
      agent: "claude",
      error: new Error("429 rate limited, retry at 2026-05-31T12:00:00"),
      adapter,
    });
    assert.equal(result.isQuota, true);
    // Should be interpreted as Asia/Shanghai → UTC 04:00
    const expected = Date.parse("2026-05-31T04:00:00Z");
    assert.equal(result.nextEligibleAt, expected);
  });
});

// ─── computeFixedBackoff ────────────────────────────────────────────

describe("computeFixedBackoff", () => {
  it("uses retryAfter when provided", () => {
    const { nextEligibleAt, reason } = computeFixedBackoff({ retryAfter: 5000 });
    assert.ok(nextEligibleAt >= Date.now() + 4900);
    assert.match(reason, /retry-after/);
  });

  it("uses windowReset when provided", () => {
    const reset = Date.now() + 3_600_000;
    const { nextEligibleAt } = computeFixedBackoff({ windowReset: reset });
    assert.equal(nextEligibleAt, reset);
  });

  it("escalates ambiguous backoffs", () => {
    const { nextEligibleAt: t0 } = computeFixedBackoff({ ambiguous429Attempt: 0 });
    const { nextEligibleAt: t1 } = computeFixedBackoff({ ambiguous429Attempt: 1 });
    const { nextEligibleAt: t2 } = computeFixedBackoff({ ambiguous429Attempt: 2 });
    assert.ok(t1 > t0);
    assert.ok(t2 > t1);
  });
});

// ─── Provider Adapters ──────────────────────────────────────────────

describe("provider-adapters", () => {
  it("getProviderAdapter returns codex adapter", () => {
    const adapter = getProviderAdapter("codex");
    assert.equal(adapter.region, "global");
    assert.equal(adapter.timezone, "UTC");
  });

  it("getProviderAdapter returns claude:kimi-k2.6 adapter", () => {
    const adapter = getProviderAdapter("claude:kimi-k2.6");
    assert.equal(adapter.region, "cn");
    assert.equal(adapter.timezone, "Asia/Shanghai");
  });

  it("getProviderAdapter returns claude:mimo-v2.5pro adapter", () => {
    const adapter = getProviderAdapter("claude:mimo-v2.5pro");
    assert.equal(adapter.region, "cn");
    assert.equal(adapter.timezone, "Asia/Shanghai");
  });

  it("falls back to generic for unknown provider", () => {
    const adapter = getProviderAdapter("unknown-provider");
    assert.equal(adapter.timezone, "UTC");
  });

  it("falls back to agent-level for unknown variant", () => {
    const adapter = getProviderAdapter("claude:unknown-variant");
    assert.equal(adapter.timezone, "UTC"); // claude base is UTC
  });

  it("listAdapterKeys returns all keys", () => {
    const keys = listAdapterKeys();
    assert.ok(keys.includes("codex"));
    assert.ok(keys.includes("claude"));
    assert.ok(keys.includes("claude:kimi-k2.6"));
    assert.ok(keys.includes("claude:mimo-v2.5pro"));
    assert.ok(keys.includes("generic"));
  });

  it("kimi adapter parseLimitError detects window exhaustion", async () => {
    const adapter = getProviderAdapter("claude:kimi-k2.6");
    const result = await adapter.parseLimitError({
      error: new Error("429 window quota exhausted"),
      stderr: "",
    });
    assert.ok(result);
    assert.equal(result.isQuota, true);
    assert.equal(result.status, "window_exhausted");
  });

  it("kimi adapter parseLimitError detects weekly exhaustion", async () => {
    const adapter = getProviderAdapter("claude:kimi-k2.6");
    const result = await adapter.parseLimitError({
      error: new Error("weekly limit reached"),
      stderr: "",
    });
    assert.ok(result);
    assert.equal(result.status, "weekly_exhausted");
  });
});

// ─── sanitizeProviderReason ─────────────────────────────────────────

describe("sanitizeProviderReason", () => {
  it("strips ANSI escapes", () => {
    const result = sanitizeProviderReason("\x1B[31merror\x1B[0m");
    assert.equal(result, "error");
  });

  it("limits length to 500", () => {
    const long = "x".repeat(1000);
    const result = sanitizeProviderReason(long);
    assert.ok(result.length <= 500);
  });

  it("handles null/empty", () => {
    assert.equal(sanitizeProviderReason(null), "");
    assert.equal(sanitizeProviderReason(""), "");
  });
});

// ─── Provider Usage ─────────────────────────────────────────────────

describe("provider-usage", () => {
  it("records and reads usage", async () => {
    await recordProviderUsage(tmpDir, {
      providerKey: "claude",
      agent: "claude",
      phase: "execute",
      status: "ok",
      durationMs: 1500,
    });
    const records = await readProviderUsage(tmpDir);
    assert.equal(records.length, 1);
    assert.equal(records[0].providerKey, "claude");
    assert.equal(records[0].status, "ok");
    assert.equal(records[0].durationMs, 1500);
  });

  it("provider rollup aggregates correctly", async () => {
    await recordProviderUsage(tmpDir, { providerKey: "claude", agent: "claude", phase: "execute", status: "ok", tokens: 100 });
    await recordProviderUsage(tmpDir, { providerKey: "claude", agent: "claude", phase: "verify", status: "ok", tokens: 50 });
    await recordProviderUsage(tmpDir, { providerKey: "codex", agent: "codex", phase: "plan", status: "error" });

    const rollup = await readProviderUsageRollup(tmpDir);
    assert.equal(rollup.claude.calls, 2);
    assert.equal(rollup.claude.ok, 2);
    assert.equal(rollup.claude.tokens, 150);
    assert.equal(rollup.codex.calls, 1);
    assert.equal(rollup.codex.errors, 1);
  });

  it("system rollup aggregates all providers", async () => {
    await recordProviderUsage(tmpDir, { providerKey: "claude", agent: "claude", phase: "execute", status: "ok" });
    await recordProviderUsage(tmpDir, { providerKey: "codex", agent: "codex", phase: "plan", status: "rate_limited" });

    const system = await readSystemUsageRollup(tmpDir);
    assert.equal(system.totalCalls, 2);
    assert.equal(system.totalOk, 1);
    assert.equal(system.totalRateLimited, 1);
    assert.equal(system.providerCount, 2);
  });

  it("returns empty for no data", async () => {
    const records = await readProviderUsage(tmpDir);
    assert.deepEqual(records, []);
    const rollup = await readProviderUsageRollup(tmpDir);
    assert.deepEqual(rollup, {});
  });
});
