/**
 * Adversarial Round 10: Legacy VERDICT: PASS cannot complete checklist-aware job.
 *
 * Core invariant: when a job carries an acceptance-checklist artifact, the
 * checklist gate (evaluateChecklistCompletion) runs BEFORE the legacy verdict
 * gates (Gates 1-7).  A legacy parsedVerdict: { status: "pass" } is irrelevant
 * if the checklist gate rejects — the function returns early at line 151-156.
 *
 * This test asserts two adversarial scenarios:
 *
 *   A. Job WITH acceptance-checklist artifact + legacy VERDICT: PASS
 *      + NO checklistVerdict => MUST NOT complete.
 *      The checklist gate calls validateChecklistVerdict(null, ...) which
 *      returns ok:false ("verdict must be an object") → checklist_invalid.
 *
 *   B. Job WITHOUT acceptance-checklist artifact + legacy VERDICT: PASS
 *      => MUST complete via the legacy verdict fallback path (Gates 3-7).
 *
 * Additional variants:
 *   1. Checklist present, checklistVerdict null, parsedVerdict PASS → blocked
 *   2. Checklist present, checklistVerdict null, parsedVerdict null → blocked (not complete)
 *   3. Checklist present, checklistVerdict null, parsedVerdict FAIL → blocked (not complete)
 *   4. No checklist, parsedVerdict PASS → complete (legacy fallback works)
 *   5. No checklist, parsedVerdict null → not complete (artifact_invalid)
 *   6. No checklist, parsedVerdict FAIL → not complete (verification_failed)
 *   7. Checklist present, checklistVerdict undefined (not null) → blocked
 *   8. Checklist present with passing verdict + evidence but null checklistVerdict → blocked
 *      (proves the checklist gate runs regardless of how good legacy verdict looks)
 *   9. Empty checklist object ({}) treated as falsy → legacy fallback used
 *  10. Checklist present, all legacy gates PASS, but no checklistVerdict → blocked
 *      (adversarial: every legacy gate passes, but checklist gate still rejects)
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AnyRecord } from "../shared/types.js";

import { evaluateCompletionGate } from "../core/engine/completion-gate.js";


// ─── Shared fixtures ──────────────────────────────────────────────────────

function frozenChecklist() {
  return {
    schemaVersion: 1,
    jobId: "job-r10",
    project: "flow",
    status: "frozen",
    source: { task: "add dark mode toggle", issue: null, documents: [] },
    items: [
      {
        id: "AC-001",
        requirement: "Dark mode CSS applied",
        source: "user_task",
        sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
        predicateId: "PRED-001",
        required: true,
        area: "cli",
        risk: "high",
        verificationMethod: "command",
        expectedEvidence: "npm test exit 0",
        dependsOn: [],
        allowedFiles: ["src/theme.ts"],
      },
    ],
    assumptions: [],
  };
}

function completeJobGate() {
  return {
    job: {
      workflow: "standard",
      planMode: "full",
      completedPhases: ["plan", "execute", "verify"],
    },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass" as const, raw: "PASS" },
  };
}

// ─── Scenario A: Checklist-aware job with legacy PASS must NOT complete ────

test("adversarial round 10: checklist job + legacy VERDICT: PASS + no checklistVerdict => NOT complete", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    checklist: frozenChecklist(),
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });

  assert.notEqual(result.outcome, "complete",
    `checklist-aware job MUST NOT complete with only legacy PASS; got ${result.outcome}: ${result.reason}`);
  assert.strictEqual(result.missingGates.includes("checklist"), true,
    "missingGates must include 'checklist'");
  assert.strictEqual(result.outcome, "checklist_invalid",
    `outcome must be checklist_invalid; got ${result.outcome}`);
});

// ─── Variant: checklist present, parsedVerdict null, no checklistVerdict ───

test("adversarial round 10: checklist job + null parsedVerdict + no checklistVerdict => NOT complete", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    parsedVerdict: null,
    checklist: frozenChecklist(),
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });

  assert.notEqual(result.outcome, "complete",
    "checklist gate must block even when parsedVerdict is also null");
  assert.strictEqual(result.outcome, "checklist_invalid",
    `outcome must be checklist_invalid; got ${result.outcome}`);
});

// ─── Variant: checklist present, parsedVerdict FAIL, no checklistVerdict ───

test("adversarial round 10: checklist job + legacy FAIL verdict + no checklistVerdict => NOT complete", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    parsedVerdict: { status: "fail" as const, raw: "FAIL" },
    checklist: frozenChecklist(),
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });

  assert.notEqual(result.outcome, "complete",
    "checklist gate must block regardless of legacy verdict value");
});

// ─── Scenario B: No checklist, legacy PASS => complete (legacy fallback) ───

test("adversarial round 10: no checklist + legacy VERDICT: PASS => complete", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    checklist: null,
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });

  assert.strictEqual(result.outcome, "complete",
    `legacy job without checklist MUST complete with PASS; got ${result.outcome}`);
});

// ─── Variant: no checklist, parsedVerdict null => artifact_invalid ──────────

test("adversarial round 10: no checklist + null parsedVerdict => NOT complete (artifact_invalid)", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    parsedVerdict: null,
    checklist: null,
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });

  assert.strictEqual(result.outcome, "artifact_invalid",
    `legacy job without verdict must be artifact_invalid; got ${result.outcome}`);
});

// ─── Variant: no checklist, parsedVerdict FAIL => verification_failed ──────

test("adversarial round 10: no checklist + legacy FAIL => verification_failed", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    parsedVerdict: { status: "fail" as const, raw: "FAIL" },
    checklist: null,
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });

  assert.strictEqual(result.outcome, "verification_failed",
    `legacy job with FAIL verdict must be verification_failed; got ${result.outcome}`);
});

// ─── Variant: checklistVerdict undefined (not explicit null) ───────────────

test("adversarial round 10: checklist present + checklistVerdict undefined => NOT complete", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    checklist: frozenChecklist(),
    // checklistVerdict intentionally omitted (undefined)
    evidenceLedger: null,
    executionMap: null,
  });

  assert.notEqual(result.outcome, "complete",
    "undefined checklistVerdict must still be caught by checklist gate");
  assert.strictEqual(result.outcome, "checklist_invalid",
    `outcome must be checklist_invalid; got ${result.outcome}`);
});

// ─── Adversarial: perfect legacy path, but checklist gate blocks ───────────
//
// This is the most adversarial variant: every legacy gate (DAG, completed
// phases, parsedVerdict) looks perfect.  But the checklist gate still
// short-circuits because checklistVerdict is null.

test("adversarial round 10: all legacy gates green but no checklistVerdict => blocked by checklist gate", () => {
  const result = evaluateCompletionGate({
    job: {
      workflow: "standard",
      planMode: "full",
      completedPhases: ["plan", "execute", "verify", "adversarial_verify"],
    },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }, { id: "adversarial_verify", phase: "adversarial_verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    parsedAdversarialVerdict: { status: "pass", raw: "PASS" },
    riskMap: { adversarialRequired: true },
    checklist: frozenChecklist(),
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });

  assert.notEqual(result.outcome, "complete",
    "even with all legacy gates green, missing checklistVerdict must block");
  assert.strictEqual(result.outcome, "checklist_invalid",
    `outcome must be checklist_invalid; got ${result.outcome}`);
  assert.strictEqual(result.missingGates.includes("checklist"), true,
    "missingGates must include 'checklist'");
});

// ─── Empty checklist object is truthy but has no items => still enters checklist gate ─

test("adversarial round 10: truthy empty-object checklist still triggers checklist gate path", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    checklist: { schemaVersion: 1, items: [], assumptions: [] },
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });

  assert.notEqual(result.outcome, "complete",
    "even an empty-object checklist is truthy and must trigger the checklist gate");
});

// ─── Positive control: no checklist at all, adversarial PASS still works ───

test("adversarial round 10: no checklist artifact at all, adversarial PASS => complete", () => {
  const result = evaluateCompletionGate({
    job: {
      workflow: "standard",
      planMode: "full",
      completedPhases: ["plan", "execute", "verify", "adversarial_verify"],
    },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    parsedAdversarialVerdict: { status: "pass", raw: "PASS" },
    riskMap: { adversarialRequired: true },
    // No checklist at all
  });

  assert.strictEqual(result.outcome, "complete",
    "without checklist artifact, legacy verdict path must work");
});
