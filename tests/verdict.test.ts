#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateVerdictEnvelope,
  classifyVerdict,
  normalizeRetryReason,
  buildRetryInputFromVerdict,
  parseVerdictEnvelope,
  formatVerdictEnvelope,
} from "../core/workflow/verdict.js";

// ── validateVerdictEnvelope ──────────────────────────────────

describe("validateVerdictEnvelope", () => {
  it("accepts a minimal valid envelope with status and reason", () => {
    const result = validateVerdictEnvelope({ status: "pass", reason: "all good" });
    assert.deepStrictEqual(result, { valid: true });
  });

  it("rejects null input", () => {
    const result = validateVerdictEnvelope(null);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error!.includes("must be an object"));
  });

  it("rejects non-object input (string)", () => {
    const result = validateVerdictEnvelope("not an object");
    assert.strictEqual(result.valid, false);
  });

  it("rejects invalid status value", () => {
    const result = validateVerdictEnvelope({ status: "maybe", reason: "unclear" });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error!.includes("maybe"));
  });

  it("rejects missing reason", () => {
    const result = validateVerdictEnvelope({ status: "pass" });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error!.includes("reason must be a string"));
  });

  it("accepts all four valid statuses", () => {
    for (const status of ["pass", "fail", "inconclusive", "infra_error"]) {
      const result = validateVerdictEnvelope({ status, reason: "ok" });
      assert.deepStrictEqual(result, { valid: true }, `status=${status} should be valid`);
    }
  });

  it("accepts envelope with layers object", () => {
    const result = validateVerdictEnvelope({
      status: "fail",
      reason: "test fail",
      layers: { fast: { status: "fail", detail: "timeout" } },
    });
    assert.deepStrictEqual(result, { valid: true });
  });

  it("rejects non-array blocking field", () => {
    const result = validateVerdictEnvelope({
      status: "fail",
      reason: "blocked",
      blocking: "not-array",
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error!.includes("blocking must be an array"));
  });

  it("rejects basis object missing required keys", () => {
    const result = validateVerdictEnvelope({
      status: "pass",
      reason: "incomplete",
      basis: { taskGoal: "something" },
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error!.includes("basis missing required keys"));
  });

  it("accepts envelope with complete basis and blockingMissingInputs", () => {
    const result = validateVerdictEnvelope({
      status: "fail",
      reason: "blocked",
      basis: {
        taskGoal: "g", worktreeDiff: "d", tests: "t",
        buildLogs: "b", events: "e", runtimeState: "r", executorSummary: "s",
      },
      blockingMissingInputs: ["input-a"],
    });
    assert.deepStrictEqual(result, { valid: true });
  });

  it("rejects non-array blockingMissingInputs", () => {
    const result = validateVerdictEnvelope({
      status: "pass",
      reason: "ok",
      blockingMissingInputs: 42,
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error!.includes("blockingMissingInputs must be an array"));
  });

  it("rejects non-string summary", () => {
    const result = validateVerdictEnvelope({
      status: "pass",
      reason: "ok",
      summary: 123,
    });
    assert.strictEqual(result.valid, false);
    assert.ok(result.error!.includes("summary must be a string"));
  });
});

// ── classifyVerdict ──────────────────────────────────────────

describe("classifyVerdict", () => {
  it("classifies pass", () => {
    assert.strictEqual(classifyVerdict("pass"), "pass");
  });

  it("classifies fail and partial as fail", () => {
    assert.strictEqual(classifyVerdict("fail"), "fail");
    assert.strictEqual(classifyVerdict("partial"), "fail");
  });

  it("classifies inconclusive and unknown as inconclusive", () => {
    assert.strictEqual(classifyVerdict("inconclusive"), "inconclusive");
    assert.strictEqual(classifyVerdict("unknown"), "inconclusive");
  });

  it("classifies infra_error", () => {
    assert.strictEqual(classifyVerdict("infra_error"), "infra_error");
  });

  it("classifies unrecognized input as inconclusive", () => {
    assert.strictEqual(classifyVerdict("garbage"), "inconclusive");
  });

  it("is case-insensitive and trims whitespace", () => {
    assert.strictEqual(classifyVerdict("  PASS  "), "pass");
    assert.strictEqual(classifyVerdict("Fail"), "fail");
  });
});

// ── parseVerdictEnvelope ─────────────────────────────────────

describe("parseVerdictEnvelope", () => {
  it("returns inconclusive for empty content", () => {
    const result = parseVerdictEnvelope("");
    assert.strictEqual(result.status, "inconclusive");
    assert.strictEqual(result.source, "empty");
  });

  it("returns inconclusive for null input", () => {
    const result = parseVerdictEnvelope(null as any);
    assert.strictEqual(result.status, "inconclusive");
    assert.strictEqual(result.source, "empty");
  });

  it("parses legacy VERDICT: PASS text", () => {
    const result = parseVerdictEnvelope("VERDICT: PASS\nAll tests green.");
    assert.strictEqual(result.status, "pass");
    assert.strictEqual(result.source, "legacy");
  });

  it("parses legacy VERDICT: FAIL text", () => {
    const result = parseVerdictEnvelope("VERDICT: FAIL\nBuild broken.");
    assert.strictEqual(result.status, "fail");
  });

  it("parses legacy VERDICT: PARTIAL as fail", () => {
    const result = parseVerdictEnvelope("VERDICT: PARTIAL\nSome tests failed.");
    assert.strictEqual(result.status, "fail");
  });

  it("parses bare PASS/FAIL on first line", () => {
    const result = parseVerdictEnvelope("PASS");
    assert.strictEqual(result.status, "pass");
    assert.strictEqual(result.source, "legacy");
  });

  it("parses JSON envelope inside fenced code block", () => {
    const content = "```json\n{\"status\": \"pass\", \"reason\": \"all clear\"}\n```";
    const result = parseVerdictEnvelope(content);
    assert.strictEqual(result.status, "pass");
    assert.strictEqual(result.source, "envelope");
  });

  it("parses standalone JSON envelope with status field", () => {
    const content = '{"status": "fail", "reason": "test failure", "blocking": [{"criterion": "unit tests", "file": "src/foo.ts"}]}';
    const result = parseVerdictEnvelope(content);
    assert.strictEqual(result.status, "fail");
    assert.strictEqual(result.source, "envelope");
    assert.ok(Array.isArray(result.blocking));
  });

  it("returns inconclusive for unrecognizable content", () => {
    const result = parseVerdictEnvelope("random gibberish without verdict");
    assert.strictEqual(result.status, "inconclusive");
    assert.strictEqual(result.source, "unknown");
  });

  it("backfills legacy basis from v2 structured fields", () => {
    const content = JSON.stringify({
      status: "fail",
      reason: "tests failed",
      layers: { fast: { status: "fail", detail: "2 tests failed" } },
    });
    const result = parseVerdictEnvelope(content);
    assert.strictEqual(result.status, "fail");
    assert.ok(result.basis);
    assert.strictEqual(result.basis.tests, "2 tests failed");
  });
});

// ── buildRetryInputFromVerdict ───────────────────────────────

describe("buildRetryInputFromVerdict", () => {
  it("returns shouldRetry=false for non-fail status", () => {
    const result = buildRetryInputFromVerdict({ status: "pass", reason: "ok" });
    assert.strictEqual(result.shouldRetry, false);
    assert.strictEqual(result.status, "pass");
  });

  it("returns shouldRetry=true for fail with blocking entries", () => {
    const envelope = {
      status: "fail",
      reason: "2 checks failed",
      blocking: [
        { criterion: "unit tests", file: "src/a.ts", evidence: "assert fail" },
        { criterion: "type check", file: "src/b.ts" },
      ],
    };
    const result = buildRetryInputFromVerdict(envelope);
    assert.strictEqual(result.shouldRetry, true);
    assert.strictEqual(result.status, "fail");
    assert.ok(result.failingChecks.length >= 1);
    assert.ok(result.prompt.includes("Retry 1"));
    assert.ok(result.prompt.includes("unit tests"));
  });

  it("uses previousVerdictId and previousVerdictPath in prompt", () => {
    const envelope = { status: "fail", reason: "bad" };
    const result = buildRetryInputFromVerdict(envelope, {
      retryCount: 3,
      previousVerdictId: "v-42",
      previousVerdictPath: "wiki/outputs/verdict-42.md",
    });
    assert.strictEqual(result.retryCount, 3);
    assert.strictEqual(result.previousVerdictId, "v-42");
    assert.ok(result.prompt.includes("Retry 3"));
    assert.ok(result.prompt.includes("v-42"));
    assert.ok(result.prompt.includes("verdict-42.md"));
  });

  it("respects maxItems to cap failingChecks", () => {
    const envelope = {
      status: "fail",
      reason: "many failures",
      blocking: [
        { criterion: "check 1" },
        { criterion: "check 2" },
        { criterion: "check 3" },
        { criterion: "check 4" },
      ],
    };
    const result = buildRetryInputFromVerdict(envelope, { maxItems: 2 });
    assert.strictEqual(result.failingChecks.length, 2);
  });

  it("extracts retryScope from fix_scope and blocking entries", () => {
    const envelope = {
      status: "fail",
      reason: "scope test",
      fix_scope: ["src/fixme.ts"],
      blocking: [{ file: "src/other.ts" }],
    };
    const result = buildRetryInputFromVerdict(envelope);
    assert.ok(result.retryScope.includes("src/fixme.ts"));
    assert.ok(result.retryScope.includes("src/other.ts"));
  });
});

// ── normalizeRetryReason ─────────────────────────────────────

describe("normalizeRetryReason", () => {
  it("parses raw content string and returns retry input", () => {
    const content = JSON.stringify({
      status: "fail",
      reason: "tests failed",
      blocking: [{ criterion: "lint" }],
    });
    const result = normalizeRetryReason(content);
    assert.strictEqual(result.shouldRetry, true);
    assert.ok(result.failingChecks.length >= 1);
  });

  it("handles empty content gracefully", () => {
    const result = normalizeRetryReason("");
    assert.strictEqual(result.shouldRetry, false);
    assert.strictEqual(result.status, "inconclusive");
  });

  it("passes retryCount through to buildRetryInputFromVerdict", () => {
    const content = JSON.stringify({ status: "fail", reason: "retry test" });
    const result = normalizeRetryReason(content, { retryCount: 5 });
    assert.strictEqual(result.retryCount, 5);
  });
});

// ── formatVerdictEnvelope ────────────────────────────────────

describe("formatVerdictEnvelope", () => {
  it("formats valid envelope as pretty JSON string", () => {
    const envelope = { status: "pass", reason: "all good" };
    const formatted = formatVerdictEnvelope(envelope);
    const parsed = JSON.parse(formatted);
    assert.strictEqual(parsed.status, "pass");
    assert.strictEqual(parsed.reason, "all good");
  });

  it("throws on invalid envelope", () => {
    assert.throws(
      () => formatVerdictEnvelope({ status: "bogus", reason: "nope" }),
      /invalid verdict envelope/,
    );
  });

  it("roundtrips with parseVerdictEnvelope", () => {
    const original = {
      status: "fail",
      reason: "build broken",
      blocking: [{ criterion: "compile", file: "main.ts" }],
    };
    const formatted = formatVerdictEnvelope(original);
    const parsed = parseVerdictEnvelope(formatted);
    assert.strictEqual(parsed.status, "fail");
    assert.strictEqual(parsed.source, "envelope");
    assert.strictEqual(parsed.reason, "build broken");
  });
});
