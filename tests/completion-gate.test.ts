import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseVerdict,
  isMutatingJob,
  evaluateCompletionGate,
  completionGateEvent,
} from "../core/engine/completion-gate.js";

// ─── parseVerdict ──────────────────────────────────────────────────────────

test("parseVerdict: PASS from canonical JSON", () => {
  const result = parseVerdict(JSON.stringify({ schemaVersion: 2, status: "pass", reason: "All good" }));
  assert.deepStrictEqual(result, { status: "pass", raw: "PASS" });
});

test("parseVerdict: FAIL from canonical JSON", () => {
  const result = parseVerdict(JSON.stringify({ schemaVersion: 2, status: "fail", reason: "Tests broke" }));
  assert.deepStrictEqual(result, { status: "fail", raw: "FAIL" });
});

test("parseVerdict: inconclusive is a failed gate", () => {
  const result = parseVerdict(JSON.stringify({ schemaVersion: 2, status: "inconclusive", reason: "Insufficient evidence" }));
  assert.deepStrictEqual(result, { status: "fail", raw: "INCONCLUSIVE" });
});

test("parseVerdict: rejects non-canonical status casing", () => {
  assert.strictEqual(parseVerdict(JSON.stringify({ schemaVersion: 2, status: "PASS", reason: "ok" })), null);
});

test("parseVerdict: null for null input", () => {
  assert.strictEqual(parseVerdict(null), null);
});

test("parseVerdict: null for empty string", () => {
  assert.strictEqual(parseVerdict(""), null);
});

test("parseVerdict: null for whitespace-only string", () => {
  assert.strictEqual(parseVerdict("   \n\t  "), null);
});

test("parseVerdict: null for text with no verdict line", () => {
  assert.strictEqual(parseVerdict("Just some random output\nNo verdict here"), null);
});

test("parseVerdict: accepts JSON surrounding whitespace", () => {
  const result = parseVerdict(`  ${JSON.stringify({ schemaVersion: 2, status: "pass", reason: "ok" })}  `);
  assert.deepStrictEqual(result, { status: "pass", raw: "PASS" });
});

test("parseVerdict: rejects prose around canonical JSON", () => {
  const text = `before\n${JSON.stringify({ schemaVersion: 2, status: "pass", reason: "ok" })}`;
  assert.strictEqual(parseVerdict(text), null);
});

test("parseVerdict: only scans first 10 lines", () => {
  const filler = Array(11).fill("noise").join("\n");
  assert.strictEqual(parseVerdict(filler + "\nVERDICT: PASS"), null);
});

test("parseVerdict: rejects JSON without schemaVersion 2", () => {
  assert.strictEqual(parseVerdict('{"verdict":"pass"}'), null);
});

test("parseVerdict: rejects JSON without canonical status", () => {
  assert.strictEqual(parseVerdict(JSON.stringify({ schemaVersion: 2, verdict: "fail", reason: "old shape" })), null);
});

test("parseVerdict: accepts canonical object input", () => {
  const result = parseVerdict({ schemaVersion: 2, status: "pass", reason: "ok" });
  assert.deepStrictEqual(result, { status: "pass", raw: "PASS" });
});

test("parseVerdict: rejects object input without schemaVersion 2", () => {
  assert.strictEqual(parseVerdict({ status: "fail", reason: "old shape" }), null);
});

test("parseVerdict: rejects unsupported partial status", () => {
  assert.strictEqual(parseVerdict({ schemaVersion: 2, status: "partial", reason: "old status" }), null);
});

test("parseVerdict: object with unrecognized value returns null", () => {
  assert.strictEqual(parseVerdict({ verdict: "unknown" }), null);
});

// ─── isMutatingJob ─────────────────────────────────────────────────────────

test("isMutatingJob: null returns false", () => {
  assert.strictEqual(isMutatingJob(null), false);
});

test("isMutatingJob: undefined returns false", () => {
  assert.strictEqual(isMutatingJob(undefined), false);
});

test("isMutatingJob: empty object returns true (default mutating)", () => {
  assert.strictEqual(isMutatingJob({}), true);
});

test("isMutatingJob: planMode 'parent' exempt", () => {
  assert.strictEqual(isMutatingJob({ planMode: "parent" }), false);
});

test("isMutatingJob: planMode 'none' exempt", () => {
  assert.strictEqual(isMutatingJob({ planMode: "none" }), false);
});

test("isMutatingJob: workflow 'docs' exempt", () => {
  assert.strictEqual(isMutatingJob({ workflow: "docs" }), false);
});

test("isMutatingJob: workflow 'readonly' exempt", () => {
  assert.strictEqual(isMutatingJob({ workflow: "readonly" }), false);
});

test("isMutatingJob: planMode 'full' is mutating", () => {
  assert.strictEqual(isMutatingJob({ planMode: "full" }), true);
});

test("isMutatingJob: workflow 'standard' is mutating", () => {
  assert.strictEqual(isMutatingJob({ workflow: "standard" }), true);
});

// ─── evaluateCompletionGate ────────────────────────────────────────────────

test("evaluateCompletionGate: non-mutating job passes all gates", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "none", completedPhases: [] },
  });
  assert.strictEqual(result.outcome, "complete");
  assert.strictEqual(result.details.isMutating, false);
});

test("evaluateCompletionGate: mutating job without verify in DAG fails policy_invalid", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "full", completedPhases: [] },
    workflowDag: { nodes: [{ phase: "execute" }] },
  });
  assert.strictEqual(result.outcome, "policy_invalid");
  assert.ok(result.reason.includes("no verify node"));
  assert.ok(result.missingGates.includes("verify"));
});

test("evaluateCompletionGate: mutating job with verify DAG but phase not completed → verification_incomplete", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "full", completedPhases: ["execute"] },
    workflowDag: { nodes: [{ phase: "execute" }, { phase: "verify" }] },
  });
  assert.strictEqual(result.outcome, "verification_incomplete");
});

test("evaluateCompletionGate: mutating job with null verdict → artifact_invalid", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "full", completedPhases: ["execute", "verify"] },
    workflowDag: { nodes: [{ phase: "verify" }] },
    parsedVerdict: null,
  });
  assert.strictEqual(result.outcome, "artifact_invalid");
  assert.ok(result.missingGates.includes("verdict_artifact"));
});

test("evaluateCompletionGate: mutating job with fail verdict → verification_failed", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "full", completedPhases: ["execute", "verify"] },
    workflowDag: { nodes: [{ phase: "verify" }] },
    parsedVerdict: { status: "fail", raw: "FAIL" },
  });
  assert.strictEqual(result.outcome, "verification_failed");
  assert.ok(result.reason.includes("fail"));
});

test("evaluateCompletionGate: mutating job with PASS verdict → complete", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "full", completedPhases: ["execute", "verify"] },
    workflowDag: { nodes: [{ phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
  });
  assert.strictEqual(result.outcome, "complete");
  assert.deepStrictEqual(result.missingGates, []);
});

test("evaluateCompletionGate: adversarial required but not completed → adversarial_incomplete", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "full", completedPhases: ["execute", "verify"] },
    workflowDag: { nodes: [{ phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    riskMap: { adversarialRequired: true },
  });
  assert.strictEqual(result.outcome, "adversarial_incomplete");
  assert.ok(result.missingGates.includes("adversarial_verify"));
});

test("evaluateCompletionGate: adversarial required, completed, but no verdict → artifact_invalid", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "full", completedPhases: ["execute", "verify", "adversarial_verify"] },
    workflowDag: { nodes: [{ phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    riskMap: { adversarialRequired: true },
    parsedAdversarialVerdict: null,
  });
  assert.strictEqual(result.outcome, "artifact_invalid");
  assert.ok(result.reason.includes("Adversarial"));
});

test("evaluateCompletionGate: adversarial required with fail verdict → adversarial_failed", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "full", completedPhases: ["execute", "verify", "adversarial_verify"] },
    workflowDag: { nodes: [{ phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    riskMap: { adversarialRequired: true },
    parsedAdversarialVerdict: { status: "fail", raw: "FAIL" },
  });
  assert.strictEqual(result.outcome, "adversarial_failed");
});

test("evaluateCompletionGate: adversarial required with pass verdict → complete", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "full", completedPhases: ["execute", "verify", "adversarial_verify"] },
    workflowDag: { nodes: [{ phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    riskMap: { adversarialRequired: true },
    parsedAdversarialVerdict: { status: "pass", raw: "PASS" },
  });
  assert.strictEqual(result.outcome, "complete");
});

test("evaluateCompletionGate: empty args defaults to complete (no job = non-mutating)", () => {
  const result = evaluateCompletionGate();
  assert.strictEqual(result.outcome, "complete");
});

test("evaluateCompletionGate: details contains expected fields", () => {
  const result = evaluateCompletionGate({
    job: { planMode: "full", completedPhases: ["execute", "verify"] },
    workflowDag: { nodes: [{ phase: "verify" }, { phase: "execute" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    riskMap: { adversarialRequired: false },
  });
  assert.strictEqual(result.details.isMutating, true);
  assert.ok(result.details.completedPhases.includes("verify"));
  assert.ok(result.details.dagPhases.includes("verify"));
  assert.strictEqual(result.details.adversarialRequired, false);
});

// ─── completionGateEvent ───────────────────────────────────────────────────

test("completionGateEvent: builds correct structure", () => {
  const gate = {
    outcome: "complete",
    reason: "All required completion gates passed",
    missingGates: [],
    details: { isMutating: true },
  };
  const event = completionGateEvent("job-123", "my-project", gate);
  assert.strictEqual(event.type, "completion_gate_evaluated");
  assert.strictEqual(event.jobId, "job-123");
  assert.strictEqual(event.project, "my-project");
  assert.strictEqual(event.outcome, "complete");
  assert.strictEqual(event.reason, "All required completion gates passed");
  assert.deepStrictEqual(event.missingGates, []);
  // ts must be a valid ISO string
  assert.ok(!isNaN(Date.parse(event.ts)), "ts should be a valid ISO date");
});

test("completionGateEvent: includes missing gates on failure", () => {
  const gate = {
    outcome: "verification_incomplete",
    reason: "Verify phase has not completed",
    missingGates: ["verify"],
    details: {},
  };
  const event = completionGateEvent("job-456", "test-proj", gate);
  assert.strictEqual(event.outcome, "verification_incomplete");
  assert.deepStrictEqual(event.missingGates, ["verify"]);
});
