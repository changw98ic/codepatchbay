import assert from "node:assert/strict";
import { test } from "node:test";

import {
  validateVerdictEnvelope,
  classifyVerdict,
  parseVerdictEnvelope,
  formatVerdictEnvelope,
  buildRetryInputFromVerdict,
} from "../../core/workflow/verdict.js";

// ---------------------------------------------------------------------------
// validateVerdictEnvelope
// ---------------------------------------------------------------------------

test("validateVerdictEnvelope accepts a valid pass envelope", () => {
  const result = validateVerdictEnvelope({
    schemaVersion: 2,
    status: "pass",
    reason: "all checks passed",
  });
  assert.equal(result.valid, true);
});

test("validateVerdictEnvelope accepts a valid fail envelope with blocking", () => {
  const result = validateVerdictEnvelope({
    schemaVersion: 2,
    status: "fail",
    reason: "test failures",
    blocking: [{ criterion: "unit tests pass", file: "src/foo.ts" }],
  });
  assert.equal(result.valid, true);
});

test("validateVerdictEnvelope rejects non-object envelope", () => {
  const result = validateVerdictEnvelope(null as unknown as Record<string, unknown>);
  assert.equal(result.valid, false);
  assert.match((result as { valid: false; error: string }).error, /must be an object/);
});

test("validateVerdictEnvelope rejects wrong schemaVersion", () => {
  const result = validateVerdictEnvelope({
    schemaVersion: 1,
    status: "pass",
    reason: "ok",
  });
  assert.equal(result.valid, false);
  assert.match((result as { valid: false; error: string }).error, /schemaVersion must be 2/);
});

test("validateVerdictEnvelope rejects invalid status", () => {
  const result = validateVerdictEnvelope({
    schemaVersion: 2,
    status: "unknown_status",
    reason: "ok",
  });
  assert.equal(result.valid, false);
  assert.match((result as { valid: false; error: string }).error, /status must be one of/);
});

test("validateVerdictEnvelope rejects non-string reason", () => {
  const result = validateVerdictEnvelope({
    schemaVersion: 2,
    status: "pass",
    reason: 42 as unknown as string,
  });
  assert.equal(result.valid, false);
  assert.match((result as { valid: false; error: string }).error, /reason must be a string/);
});

test("validateVerdictEnvelope rejects non-array blocking", () => {
  const result = validateVerdictEnvelope({
    schemaVersion: 2,
    status: "fail",
    reason: "x",
    blocking: "not-an-array",
  });
  assert.equal(result.valid, false);
  assert.match((result as { valid: false; error: string }).error, /blocking must be an array/);
});

test("validateVerdictEnvelope rejects non-object layers", () => {
  const result = validateVerdictEnvelope({
    schemaVersion: 2,
    status: "fail",
    reason: "x",
    layers: "not-an-object",
  });
  assert.equal(result.valid, false);
  assert.match((result as { valid: false; error: string }).error, /layers must be an object/);
});

test("validateVerdictEnvelope accepts valid layers object", () => {
  const result = validateVerdictEnvelope({
    schemaVersion: 2,
    status: "fail",
    reason: "x",
    layers: {
      fast: { status: "pass", detail: "ok" },
      regression: { status: "fail", detail: "broken" },
    },
  });
  assert.equal(result.valid, true);
});

// ---------------------------------------------------------------------------
// classifyVerdict
// ---------------------------------------------------------------------------

test("classifyVerdict maps pass to pass", () => {
  assert.equal(classifyVerdict("pass"), "pass");
  assert.equal(classifyVerdict("PASS"), "pass");
  assert.equal(classifyVerdict(" Pass "), "pass");
});

test("classifyVerdict maps fail and partial to fail", () => {
  assert.equal(classifyVerdict("fail"), "fail");
  assert.equal(classifyVerdict("FAIL"), "fail");
  assert.equal(classifyVerdict("partial"), "fail");
  assert.equal(classifyVerdict("PARTIAL"), "fail");
});

test("classifyVerdict maps inconclusive and unknown to inconclusive", () => {
  assert.equal(classifyVerdict("inconclusive"), "inconclusive");
  assert.equal(classifyVerdict("unknown"), "inconclusive");
  assert.equal(classifyVerdict("UNKNOWN"), "inconclusive");
});

test("classifyVerdict maps infra_error to infra_error", () => {
  assert.equal(classifyVerdict("infra_error"), "infra_error");
  assert.equal(classifyVerdict("INFRA_ERROR"), "infra_error");
});

test("classifyVerdict maps unrecognized values to inconclusive", () => {
  assert.equal(classifyVerdict("garbage"), "inconclusive");
  assert.equal(classifyVerdict(""), "inconclusive");
});

// ---------------------------------------------------------------------------
// parseVerdictEnvelope
// ---------------------------------------------------------------------------

test("parseVerdictEnvelope parses valid JSON envelope", () => {
  const envelope = {
    schemaVersion: 2,
    status: "pass",
    reason: "all good",
  };
  const result = parseVerdictEnvelope(JSON.stringify(envelope));
  assert.equal(result.status, "pass");
  assert.equal(result.reason, "all good");
  assert.equal(result.source, "json");
});

test("parseVerdictEnvelope returns inconclusive for empty content", () => {
  const result = parseVerdictEnvelope("");
  assert.equal(result.status, "inconclusive");
  assert.equal(result.source, "invalid");
  assert.match(result.reason, /empty/);
});

test("parseVerdictEnvelope returns inconclusive for invalid JSON", () => {
  const result = parseVerdictEnvelope("{not valid json");
  assert.equal(result.status, "inconclusive");
  assert.equal(result.source, "invalid");
  assert.match(result.reason, /not canonical JSON/);
});

test("parseVerdictEnvelope returns inconclusive for invalid envelope schema", () => {
  const result = parseVerdictEnvelope(JSON.stringify({ schemaVersion: 1, status: "pass", reason: "ok" }));
  assert.equal(result.status, "inconclusive");
  assert.equal(result.source, "invalid");
  assert.match(result.reason, /invalid verdict envelope/);
});

// ---------------------------------------------------------------------------
// formatVerdictEnvelope
// ---------------------------------------------------------------------------

test("formatVerdictEnvelope produces formatted JSON for valid envelope", () => {
  const envelope = { schemaVersion: 2, status: "pass", reason: "ok" };
  const formatted = formatVerdictEnvelope(envelope);
  const parsed = JSON.parse(formatted);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.status, "pass");
});

test("formatVerdictEnvelope throws for invalid envelope", () => {
  assert.throws(
    () => formatVerdictEnvelope({ schemaVersion: 1, status: "pass", reason: "ok" }),
    (error: unknown) => (error as Error).message.includes("invalid verdict envelope"),
  );
});

// ---------------------------------------------------------------------------
// buildRetryInputFromVerdict
// ---------------------------------------------------------------------------

test("buildRetryInputFromVerdict returns shouldRetry=false for pass status", () => {
  const result = buildRetryInputFromVerdict({
    schemaVersion: 2,
    status: "pass",
    reason: "all good",
  });
  assert.equal(result.shouldRetry, false);
  assert.equal(result.status, "pass");
});

test("buildRetryInputFromVerdict returns shouldRetry=true for fail status", () => {
  const result = buildRetryInputFromVerdict({
    schemaVersion: 2,
    status: "fail",
    reason: "test failures",
  });
  assert.equal(result.shouldRetry, true);
  assert.equal(result.status, "fail");
  assert.ok((result.prompt as string).length > 0);
  assert.match(result.prompt as string, /Retry 1/);
});

test("buildRetryInputFromVerdict includes blocking checks in prompt", () => {
  const result = buildRetryInputFromVerdict({
    schemaVersion: 2,
    status: "fail",
    reason: "verifier rejected",
    blocking: [
      { criterion: "unit tests pass", file: "src/foo.ts", evidence: "3 failures" },
    ],
  });
  assert.equal(result.shouldRetry, true);
  assert.ok((result.failingChecks as string[]).length > 0);
  assert.match(result.prompt as string, /unit tests pass/);
});

test("buildRetryInputFromVerdict includes retryScope from fix_scope", () => {
  const result = buildRetryInputFromVerdict({
    schemaVersion: 2,
    status: "fail",
    reason: "broken",
    fix_scope: ["src/foo.ts", "src/bar.ts"],
  });
  assert.equal(result.shouldRetry, true);
  assert.deepEqual(result.retryScope, ["src/foo.ts", "src/bar.ts"]);
});

test("buildRetryInputFromVerdict extracts retryScope from blocking file entries", () => {
  const result = buildRetryInputFromVerdict({
    schemaVersion: 2,
    status: "fail",
    reason: "broken",
    blocking: [{ criterion: "test", file: "src/a.ts" }, { criterion: "test2", path: "src/b.ts" }],
  });
  assert.ok((result.retryScope as string[]).includes("src/a.ts"));
  assert.ok((result.retryScope as string[]).includes("src/b.ts"));
});

test("buildRetryInputFromVerdict respects retryCount", () => {
  const result = buildRetryInputFromVerdict(
    { schemaVersion: 2, status: "fail", reason: "x" },
    { retryCount: 3 },
  );
  assert.equal(result.retryCount, 3);
  assert.match(result.prompt as string, /Retry 3/);
});

test("buildRetryInputFromVerdict caps failingChecks and retryScope to maxItems", () => {
  const blocking = Array.from({ length: 20 }, (_, i) => ({ criterion: `check-${i}` }));
  const result = buildRetryInputFromVerdict(
    { schemaVersion: 2, status: "fail", reason: "x", blocking },
    { maxItems: 3 },
  );
  assert.ok((result.failingChecks as string[]).length <= 3);
});
