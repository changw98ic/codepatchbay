/**
 * Task 4 — response-parser checklist fields.
 *
 * Verifies that parseExecutorJson preserves `checklistMapping` and
 * parseVerifierJson preserves `checklistVerdict` from agent JSON output.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseExecutorJson,
  parseVerifierJson,
} from "../core/agents/response-parser.js";

// ─── parseExecutorJson ─────────────────────────────────────────────────────

test("parseExecutorJson: preserves checklistMapping array from executor output", () => {
  const output = JSON.stringify({
    status: "ok",
    summary: "implemented feature X",
    tests: ["test A passes"],
    risks: [],
    checklistMapping: [
      { checklistId: "AC-001", files: ["src/foo.ts"], covered: true },
      { checklistId: "AC-002", files: ["src/bar.ts"], covered: false },
    ],
  });

  const result = parseExecutorJson(output) as any;
  assert.ok(result.ok, `expected ok, got reason: ${result.reason}`);
  assert.ok(Array.isArray(result.checklistMapping), "checklistMapping must be an array");
  assert.strictEqual(result.checklistMapping.length, 2);
  assert.strictEqual(result.checklistMapping[0].checklistId, "AC-001");
  assert.strictEqual(result.checklistMapping[0].covered, true);
  assert.strictEqual(result.checklistMapping[1].checklistId, "AC-002");
  assert.strictEqual(result.checklistMapping[1].covered, false);
});

test("parseExecutorJson: defaults to empty array when checklistMapping is absent", () => {
  const output = JSON.stringify({
    status: "ok",
    summary: "did stuff",
  });

  const result = parseExecutorJson(output) as any;
  assert.ok(result.ok);
  assert.ok(Array.isArray(result.checklistMapping));
  assert.strictEqual(result.checklistMapping.length, 0);
});

test("parseExecutorJson: defaults to empty array when checklistMapping is not an array", () => {
  const output = JSON.stringify({
    status: "ok",
    summary: "did stuff",
    checklistMapping: "oops-not-array",
  });

  const result = parseExecutorJson(output) as any;
  assert.ok(result.ok);
  assert.ok(Array.isArray(result.checklistMapping));
  assert.strictEqual(result.checklistMapping.length, 0);
});

test("parseExecutorJson: accepts resolved executor file envelope", () => {
  const output = JSON.stringify({
    status: "resolved",
    summary: "Fixed the issue and verified the targeted tests.",
    verification: {
      fail_to_pass: ["mail.tests.MailTests.test_non_ascii_dns_non_unicode_email"],
      pass_to_pass: ["mail.tests.PythonGlobalState.test_7bit"],
      all_passed: true,
    },
  });

  const result = parseExecutorJson(output) as any;
  assert.ok(result.ok, `expected ok, got reason: ${result.reason}`);
  assert.strictEqual(result.summary, "Fixed the issue and verified the targeted tests.");
  assert.deepStrictEqual(result.tests, [
    "fail_to_pass: mail.tests.MailTests.test_non_ascii_dns_non_unicode_email",
    "pass_to_pass: mail.tests.PythonGlobalState.test_7bit",
  ]);
});

test("parseExecutorJson: preserves structured status failure reason", () => {
  const output = JSON.stringify({
    status: "rejected",
    summary: "not done",
  });

  const result = parseExecutorJson(output) as any;
  assert.ok(!result.ok);
  assert.match(result.reason, /non-success status: rejected/);
});

// ─── parseVerifierJson ─────────────────────────────────────────────────────

test("parseVerifierJson: preserves checklistVerdict object from verifier output", () => {
  const checklistVerdict = {
    schemaVersion: 1,
    jobId: "job-1",
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-1", evidenceId: "EV-001" }],
        actualResult: "all tests pass",
        reason: "confirmed",
        fixScope: [],
      },
    ],
    blocking: [],
    fixScope: [],
    reason: "all items pass",
  };

  const output = JSON.stringify({
    status: "ok",
    verdict: "pass",
    reason: "verified",
    checklistVerdict,
  });

  const result = parseVerifierJson(output) as any;
  assert.ok(result.ok, `expected ok, got reason: ${result.reason}`);
  assert.strictEqual(result.status, "pass");
  assert.ok(result.checklistVerdict, "checklistVerdict must be present");
  assert.strictEqual(result.checklistVerdict.status, "pass");
  assert.strictEqual(result.checklistVerdict.items.length, 1);
  assert.strictEqual(result.checklistVerdict.items[0].checklistId, "AC-001");
  assert.strictEqual(result.checklistVerdict.items[0].result, "pass");
  assert.deepStrictEqual(
    result.checklistVerdict.items[0].evidenceRefs,
    [{ ledgerId: "ledger-1", evidenceId: "EV-001" }],
  );
});

test("parseVerifierJson: defaults checklistVerdict to null when absent", () => {
  const output = JSON.stringify({
    status: "ok",
    verdict: "pass",
    reason: "legacy verdict without checklist",
  });

  const result = parseVerifierJson(output) as any;
  assert.ok(result.ok);
  assert.strictEqual(result.checklistVerdict, null);
});

test("parseVerifierJson: recovers a structured checklistVerdict nested in details", () => {
  const nestedChecklistVerdict = {
    schemaVersion: 1,
    jobId: "job-nested",
    status: "fail",
    items: [
      {
        checklistId: "AC-001",
        result: "fail",
        evidenceRefs: [{ ledgerId: "ledger-1", evidenceId: "EV-001" }],
        actualResult: "runtime evidence unavailable",
        reason: "required probe did not run",
        fixScope: ["src/foo.ts"],
      },
    ],
    blocking: ["AC-001"],
    fixScope: ["src/foo.ts"],
    reason: "AC-001 failed",
  };
  const output = JSON.stringify({
    status: "ok",
    verdict: "fail",
    reason: "verification failed",
    details: {
      summary: "static review passed but runtime evidence did not",
      checklistVerdict: nestedChecklistVerdict,
    },
    confidence: 0.86,
  });

  const result = parseVerifierJson(output) as any;
  assert.ok(result.ok, `expected ok, got reason: ${result.reason}`);
  assert.strictEqual(result.status, "fail");
  assert.deepStrictEqual(result.checklistVerdict, nestedChecklistVerdict);
  assert.strictEqual(result.details.summary, "static review passed but runtime evidence did not");
});

test("parseVerifierJson: accepts raw verifier file object with status pass", () => {
  const output = JSON.stringify({
    schemaVersion: 1,
    jobId: "job-raw-verdict",
    status: "pass",
    verdict: "pass",
    reason: "Verifier wrote raw JSON to VERIFIER_JSON_OUTPUT_FILE.",
    details: "The file is valid JSON but omits the status: ok envelope.",
    confidence: 0.9,
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-raw-verdict",
      status: "pass",
      items: [],
      blocking: [],
      fixScope: [],
      reason: "all good",
    },
  });

  const result = parseVerifierJson(output) as any;
  assert.ok(result.ok, `expected ok, got reason: ${result.reason}`);
  assert.strictEqual(result.status, "pass");
  assert.strictEqual(result.reason, "Verifier wrote raw JSON to VERIFIER_JSON_OUTPUT_FILE.");
  assert.strictEqual(result.checklistVerdict.jobId, "job-raw-verdict");
});

test("parseVerifierJson: preserves checklistVerdict with partial/fail status", () => {
  const output = JSON.stringify({
    status: "ok",
    verdict: "fail",
    reason: "some items failed",
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-2",
      status: "fail",
      items: [
        { checklistId: "AC-001", result: "pass", evidenceRefs: [], actualResult: "", reason: "", fixScope: [] },
        { checklistId: "AC-002", result: "fail", evidenceRefs: [], actualResult: "", reason: "missing", fixScope: ["src/bar.ts"] },
      ],
      blocking: ["AC-002"],
      fixScope: ["src/bar.ts"],
      reason: "AC-002 failed",
    },
  });

  const result = parseVerifierJson(output) as any;
  assert.ok(result.ok);
  assert.strictEqual(result.status, "fail");
  assert.strictEqual(result.checklistVerdict.status, "fail");
  assert.strictEqual(result.checklistVerdict.items[1].result, "fail");
  assert.deepStrictEqual(result.checklistVerdict.blocking, ["AC-002"]);
  assert.deepStrictEqual(result.checklistVerdict.fixScope, ["src/bar.ts"]);
});

// ─── code-block wrapped output (parseAgentJson strategy 1) ─────────────────

test("parseExecutorJson: extracts checklistMapping from markdown code block", () => {
  const inner = JSON.stringify({
    status: "ok",
    summary: "wrapped in code block",
    checklistMapping: [{ checklistId: "AC-003", files: [], covered: true }],
  });
  const output = "Here's my result:\n```json\n" + inner + "\n```\nDone.";

  const result = parseExecutorJson(output) as any;
  assert.ok(result.ok);
  assert.strictEqual(result.checklistMapping.length, 1);
  assert.strictEqual(result.checklistMapping[0].checklistId, "AC-003");
});

test("parseVerifierJson: extracts checklistVerdict from markdown code block", () => {
  const inner = JSON.stringify({
    status: "ok",
    verdict: "partial",
    reason: "some pass some fail",
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-cb",
      status: "partial",
      items: [],
      blocking: [],
      fixScope: [],
      reason: "partial",
    },
  });
  const output = "```json\n" + inner + "\n```";

  const result = parseVerifierJson(output) as any;
  assert.ok(result.ok);
  assert.strictEqual(result.status, "partial");
  assert.strictEqual(result.checklistVerdict.status, "partial");
});

test("parseVerifierJson: skips non-json code blocks and parses the final verifier envelope", () => {
  const checklistVerdict = {
    schemaVersion: 1,
    jobId: "job-cb-last",
    status: "pass",
    items: [],
    blocking: [],
    fixScope: [],
    reason: "all good",
  };
  const output = [
    "I checked the logs first.",
    "```json",
    JSON.stringify({ command: "PYTHONPATH=. python3 tests/runtests.py forms_tests", exitCode: 0 }, null, 2),
    "```",
    "Final verdict:",
    "```json",
    JSON.stringify({
      status: "ok",
      verdict: "pass",
      reason: "verified",
      details: "final JSON envelope after other fenced output",
      confidence: 0.95,
      checklistVerdict,
    }, null, 2),
    "```",
  ].join("\n");

  const result = parseVerifierJson(output) as any;
  assert.ok(result.ok, `expected ok, got reason: ${result.reason}`);
  assert.strictEqual(result.status, "pass");
  assert.strictEqual(result.checklistVerdict.jobId, "job-cb-last");
});

// ─── malformed input ───────────────────────────────────────────────────────

test("parseExecutorJson: returns not-ok for non-JSON output", () => {
  const result = parseExecutorJson("this is not json at all") as any;
  assert.ok(!result.ok);
});

test("parseVerifierJson: returns not-ok for invalid verdict value", () => {
  const output = JSON.stringify({ status: "ok", verdict: "unknown" });
  const result = parseVerifierJson(output) as any;
  assert.ok(!result.ok);
  assert.ok(result.reason.includes("invalid verdict"));
});
