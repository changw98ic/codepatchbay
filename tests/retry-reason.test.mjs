import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildRetryInputFromVerdict,
  classifyVerdict,
  normalizeRetryReason,
} from "../core/workflow/verdict.js";

test("retry input never retries pass inconclusive or infra_error verdicts", () => {
  assert.equal(buildRetryInputFromVerdict({ status: "pass", reason: "ok" }).shouldRetry, false);
  assert.equal(buildRetryInputFromVerdict({ status: "inconclusive", reason: "unknown" }).shouldRetry, false);
  assert.equal(buildRetryInputFromVerdict({ status: "infra_error", reason: "disk full" }).shouldRetry, false);
});

test("retry input summarizes failing checks and repair scope", () => {
  const result = buildRetryInputFromVerdict({
    status: "fail",
    reason: "tests failed",
    blocking: [
      { criterion: "input validation", file: "src/api.js", evidence: "null accepted", fix_hint: "add guard" },
      { criterion: "type safety", file: "src/types.ts" },
    ],
    fix_scope: ["src/api.js", "src/types.ts"],
    layers: { fast: { status: "fail", detail: "2 tests failed" } },
  }, { retryCount: 2, previousVerdictId: "verdict-abc" });

  assert.equal(result.shouldRetry, true);
  assert.equal(result.retryCount, 2);
  assert.equal(result.previousVerdictId, "verdict-abc");
  assert.ok(result.prompt.includes("Retry 2"));
  assert.ok(result.prompt.includes("input validation"));
  assert.ok(result.prompt.includes("src/api.js"));
  assert.ok(result.repairScope.includes("src/types.ts"));
});

test("normalizeRetryReason parses fenced and legacy verdict content", () => {
  const fenced = "```json\n" + JSON.stringify({
    status: "fail",
    reason: "missing validation",
    blocking: [{ criterion: "validation", file: "src/api.js" }],
    fix_scope: ["src/api.js"],
  }) + "\n```";
  const normalized = normalizeRetryReason(fenced, { previousVerdictId: "v-1" });
  assert.equal(normalized.shouldRetry, true);
  assert.equal(normalized.previousVerdictId, "v-1");
  assert.ok(normalized.repairScope.includes("src/api.js"));

  assert.equal(normalizeRetryReason("VERDICT: PASS\nAll good").shouldRetry, false);
  assert.equal(normalizeRetryReason("VERDICT: FAIL\nRejected").shouldRetry, true);
});

test("classifyVerdict maps partial and unknown statuses", () => {
  assert.equal(classifyVerdict("PARTIAL"), "fail");
  assert.equal(classifyVerdict("something_else"), "inconclusive");
});
