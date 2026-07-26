import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNumstat,
  sumChurn,
  extractBody,
  evaluateCommitSize,
} from "../scripts/verify-commit-size.js";

const NUMSTAT_FIXTURE = [
  "53\t24\tREADME.md",
  "120\t8\tcore/engine/run-job.ts",
  "-\t-\tassets/logo.png",
  "10\t0\tscripts/verify-commit-size.ts",
  "5\t5\tdist/compiled.js",
  "45\t3\ttests/verify-commit-size.test.ts",
].join("\n");

test("parseNumstat sums rows, skips binary and excluded prefixes", () => {
  const rows = parseNumstat(NUMSTAT_FIXTURE);
  // README, run-job, verify-commit-size, tests file count; dist/ excluded, logo binary.
  assert.equal(rows.length, 4);
  const { churn, files } = sumChurn(rows);
  // 77 + 128 + 10 + 48 = 263
  assert.equal(churn, 77 + 128 + 10 + 48);
  assert.equal(files, 4);
});

test("extractBody drops subject, blank lines, and git trailers", () => {
  const message = [
    "Checkpoint durable runtime",
    "",
    "This bakes in the durable directory lock and worktree ownership.",
    "",
    "Signed-off-by: a@b.com",
    "Co-Authored-By: c@d.com",
    "",
  ].join("\n");
  assert.equal(
    extractBody(message),
    "This bakes in the durable directory lock and worktree ownership.",
  );
});

test("extractBody returns empty when only subject + trailers present", () => {
  const message = "one line subject\n\nSigned-off-by: a@b.com\n";
  assert.equal(extractBody(message), "");
});

test("extractBody preserves ordinary body lines that look like generic trailers", () => {
  const message = [
    "subject",
    "",
    "Note: this is explanatory prose, not a git trailer.",
    "Step 1: keep the checkpoint body reviewable.",
    "",
    "Signed-off-by: a@b.com",
  ].join("\n");
  assert.equal(
    extractBody(message),
    "Note: this is explanatory prose, not a git trailer.\nStep 1: keep the checkpoint body reviewable.",
  );
});

test("evaluateCommitSize passes below both thresholds", () => {
  const result = evaluateCommitSize({ churn: 100, files: 1, isMerge: false, message: "x" });
  assert.equal(result.ok, true);
  assert.equal(result.reasons.length, 0);
});

test("evaluateCommitSize fails over line limit without a body", () => {
  const result = evaluateCommitSize({
    churn: 1001,
    files: 5,
    isMerge: false,
    message: "one liner subject",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("1001 changed lines")));
  assert.ok(result.reasons.some((r) => r.includes("body")));
});

test("evaluateCommitSize passes over line limit WITH a sufficient body", () => {
  const result = evaluateCommitSize({
    churn: 5000,
    files: 5,
    isMerge: false,
    message: "subject\n\nThis explains the change in enough detail to clear the body threshold.",
  });
  assert.equal(result.ok, true);
});

test("evaluateCommitSize fails over file limit without a body", () => {
  const result = evaluateCommitSize({ churn: 50, files: 31, isMerge: false, message: "subject" });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("31 files")));
});

test("evaluateCommitSize skips merge commits regardless of size", () => {
  const result = evaluateCommitSize({
    churn: 99999,
    files: 999,
    isMerge: true,
    message: "Merge pull request #1 from branch",
  });
  assert.equal(result.ok, true);
});

test("evaluateCommitSize override bypasses loudly", () => {
  const result = evaluateCommitSize(
    { churn: 171171, files: 321, isMerge: false, message: "x" },
    { override: "durable-runtime checkpoint" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.overridden, true);
});

test("evaluateCommitSize empty override does NOT bypass", () => {
  const result = evaluateCommitSize(
    { churn: 5000, files: 5, isMerge: false, message: "x" },
    { override: "   " },
  );
  assert.equal(result.ok, false);
});

test("motivating-case scale (321 files / 171171 lines) fails without override", () => {
  const result = evaluateCommitSize({
    churn: 171171,
    files: 321,
    isMerge: false,
    message: "Checkpoint durable runtime and release hardening",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 3); // lines + files + body
});
