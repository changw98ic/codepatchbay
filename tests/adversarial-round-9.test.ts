/**
 * Adversarial Round 9: Assumptions smuggling acceptance criteria are rejected.
 *
 * Scenario: The validateAcceptanceChecklist function guards against two
 * adversarial assumption patterns:
 *
 *   1. Smuggled requirements: assumption text containing normative keywords
 *      ("must", "should", "required", "remain unchanged", "non-regression")
 *      that secretly encode acceptance criteria the agent must satisfy.
 *      These bypass the normal acceptance-checklist item flow (source coverage,
 *      evidence validation, verdict cross-check) and would be invisible to
 *      the evaluator if accepted.
 *
 *   2. Silently-accepted high-risk assumptions: an assumption with risk="high"
 *      and acceptedForExecution=true means the agent declared a high-stakes
 *      assumption AND self-approved it for execution, with no human_approval
 *      gate.  This is a classic escalation: declare the assumption risky
 *      (admitting it matters), then silently accept it anyway.
 *
 * Both checks are in validateAcceptanceChecklist (acceptance-checklist.ts:134-139).
 * They fire BEFORE any item-level validation, so a smuggled assumption blocks
 * the entire checklist regardless of how perfect the items are.
 *
 * Variants tested:
 *   1. "must remain unchanged" → rejected (exact spec text)
 *   2. "must" alone in assumption text → rejected
 *   3. "should" in assumption text → rejected
 *   4. "required" in assumption text → rejected
 *   5. "non-regression" in assumption text → rejected
 *   6. High-risk + acceptedForExecution=true → rejected (no human_approval)
 *   7. High-risk + acceptedForExecution=false → allowed (not self-approved)
 *   8. Medium-risk + smuggled text → rejected (smuggling check is risk-independent)
 *   9. Low-risk + acceptedForExecution=true + clean text → allowed
 *  10. Multiple assumptions: one smuggled poisons the whole checklist
 *  11. Smuggled assumption through completion gate → checklist_invalid
 *  12. Case-insensitive smuggling: "MUST" → rejected
 *  13. Positive control: clean assumption text, medium risk, not accepted → allowed
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { LooseRecord } from "../shared/types.js";

import {
  validateAcceptanceChecklist,
  evaluateChecklistCompletion,
} from "../core/workflow/acceptance-checklist.js";
import { evaluateCompletionGate } from "../core/engine/completion-gate.js";


// ─── Shared fixtures ──────────────────────────────────────────────────────

function baseChecklist(assumptions: LooseRecord[] = []) {
  return {
    schemaVersion: 1,
    jobId: "job-r9",
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
    assumptions,
  };
}

function validEvidence(evidenceId = "EV-001") {
  return {
    id: evidenceId,
    type: "evidence_claim",
    observationType: "command",
    checklistId: "AC-001",
    attemptId: "attempt-r9-a1",
    verificationMethod: "command",
    predicateId: "PRED-001",
    probeId: `probe-${evidenceId}`,
    result: "pass",
    command: "npm test",
    exitCode: 0,
    stdoutSha256: `sha256:stdout-${evidenceId}`,
    worktreeHead: "eee333",
    diffHash: "sha256:r9-diff",
  };
}

function passingLedger(evidence: LooseRecord[] = [validEvidence()]) {
  return {
    schemaVersion: 1,
    ledgerId: "evidence-ledger-r9",
    attemptId: "attempt-r9-a1",
    finalWorktree: { head: "eee333", diffHash: "sha256:r9-diff" },
    evidence,
  };
}

function passingVerdict() {
  return {
    schemaVersion: 1,
    jobId: "job-r9",
    status: "pass",
    items: [{
      checklistId: "AC-001",
      result: "pass",
      evidenceRefs: [{ ledgerId: "evidence-ledger-r9", evidenceId: "EV-001" }],
      actualResult: "ok",
      reason: "ok",
      fixScope: [],
    }],
    blocking: [],
    fixScope: [],
    reason: "passed",
  };
}

// ─── Test 1: "must remain unchanged" → rejected ────────────────────────────

test("adversarial round 9: assumption 'must remain unchanged' is rejected as smuggled requirement", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Existing status output must remain unchanged", risk: "medium", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, false, "must reject smuggled 'must remain unchanged'");
  assert.match(result.reason, /assumptions\[0\]/, "reason must identify the assumption index");
  assert.match(result.reason, /acceptance requirement/i, "reason must say acceptance requirement");
});

// ─── Test 2: "must" alone → rejected ───────────────────────────────────────

test("adversarial round 9: assumption with 'must' is rejected", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "The API contract must not change", risk: "low", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, false, "must reject assumption containing 'must'");
  assert.match(result.reason, /assumptions\[0\]/);
});

// ─── Test 3: "should" → rejected ───────────────────────────────────────────

test("adversarial round 9: assumption with 'should' is rejected", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Error messages should be preserved", risk: "medium", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, false, "must reject assumption containing 'should'");
  assert.match(result.reason, /assumptions\[0\]/);
});

// ─── Test 4: "required" → rejected ────────────────────────────────────────

test("adversarial round 9: assumption with 'required' is rejected", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Backward compatibility is required", risk: "low", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, false, "must reject assumption containing 'required'");
  assert.match(result.reason, /assumptions\[0\]/);
});

// ─── Test 5: "non-regression" → rejected ───────────────────────────────────

test("adversarial round 9: assumption with 'non-regression' is rejected", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Non-regression of existing CLI output format", risk: "medium", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, false, "must reject assumption containing 'non-regression'");
  assert.match(result.reason, /assumptions\[0\]/);
});

// ─── Test 6: high-risk + acceptedForExecution=true → rejected ──────────────

test("adversarial round 9: high-risk assumption with acceptedForExecution=true is rejected", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Database schema may be altered", risk: "high", acceptedForExecution: true },
  ]));

  assert.strictEqual(result.ok, false, "must reject silently-accepted high-risk assumption");
  assert.match(result.reason, /high-risk/i, "reason must mention high-risk");
  assert.match(result.reason, /silently accepted/i, "reason must mention silent acceptance");
});

// ─── Test 7: high-risk + acceptedForExecution=false → allowed ──────────────

test("adversarial round 9: high-risk assumption not accepted for execution is allowed", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Database schema may be altered", risk: "high", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, true, "high-risk assumption that is NOT self-approved should be allowed");
});

// ─── Test 8: medium-risk + smuggled text → rejected (risk-independent) ─────

test("adversarial round 9: medium-risk assumption with smuggled text is still rejected", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "The login flow must work as before", risk: "medium", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, false,
    "smuggling check is risk-independent; medium-risk smuggled text must still be rejected");
  assert.match(result.reason, /acceptance requirement/i);
});

// ─── Test 9: low-risk + acceptedForExecution=true + clean text → allowed ───

test("adversarial round 9: low-risk accepted assumption with clean text is allowed", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Node.js version is 20.x", risk: "low", acceptedForExecution: true },
  ]));

  assert.strictEqual(result.ok, true,
    "low-risk assumption with clean text and self-acceptance should be allowed");
});

// ─── Test 10: multiple assumptions, one smuggled poisons the whole checklist ─

test("adversarial round 9: one smuggled assumption among several poisons the whole checklist", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Node.js version is 20.x", risk: "low", acceptedForExecution: true },
    { id: "ASM-002", text: "Existing auth flow must remain unchanged", risk: "medium", acceptedForExecution: false },
    { id: "ASM-003", text: "Test coverage above 80%", risk: "low", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, false, "one smuggled assumption must reject the entire checklist");
  assert.match(result.reason, /assumptions\[1\]/, "reason must identify the smuggled assumption index");
});

// ─── Test 11: smuggled assumption through completion gate → checklist_invalid ─

test("adversarial round 9: checklist with smuggled assumption produces checklist_invalid at completion gate", () => {
  const checklist = baseChecklist([
    { id: "ASM-001", text: "Existing CLI output must remain unchanged", risk: "medium", acceptedForExecution: false },
  ]);

  const result = evaluateCompletionGate({
    job: {
      workflow: "standard",
      planMode: "full",
      completedPhases: ["plan", "execute", "verify"],
    },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    checklist,
    checklistVerdict: passingVerdict(),
    evidenceLedger: passingLedger(),
    executionMap: { unmappedChangedFiles: [] },
  });

  assert.strictEqual(result.outcome, "checklist_invalid",
    `completion gate must produce checklist_invalid for smuggled assumption, got ${result.outcome}`);
  assert.ok(result.missingGates.includes("checklist"),
    "missingGates must include 'checklist'");
});

// ─── Test 12: case-insensitive smuggling: "MUST" → rejected ────────────────

test("adversarial round 9: uppercase 'MUST' in assumption text is rejected (case-insensitive)", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "The API contract MUST NOT change", risk: "medium", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, false, "must reject uppercase MUST (case-insensitive regex)");
  assert.match(result.reason, /assumptions\[0\]/);
});

// ─── Test 13: positive control: clean text, medium risk, not accepted → allowed ─

test("adversarial round 9: clean assumption with no smuggling keywords is allowed (positive control)", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Project uses TypeScript strict mode", risk: "medium", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, true,
    "clean assumption without smuggling keywords should be allowed");
});

// ─── Test 14: evaluateChecklistCompletion also rejects smuggled assumptions ─

test("adversarial round 9: evaluateChecklistCompletion rejects checklist with smuggled assumption even with perfect evidence", () => {
  const checklist = baseChecklist([
    { id: "ASM-001", text: "The config file must remain unchanged after migration", risk: "high", acceptedForExecution: true },
  ]);

  // Even with perfect evidence and passing verdict, the smuggled checklist is invalid
  const result = evaluateChecklistCompletion({
    checklist,
    verdict: passingVerdict(),
    evidenceLedger: passingLedger(),
    executionMap: { unmappedChangedFiles: [] },
  });

  assert.strictEqual(result.outcome, "checklist_invalid",
    `evaluateChecklistCompletion must reject smuggled assumption checklist, got ${result.outcome}: ${result.reason}`);
});

// ─── Test 15: high-risk accepted blocks even without smuggling keywords ─────

test("adversarial round 9: high-risk accepted assumption blocks checklist regardless of text content", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Database credentials may rotate", risk: "high", acceptedForExecution: true },
  ]));

  assert.strictEqual(result.ok, false,
    "high-risk + acceptedForExecution=true must be rejected regardless of text");
  assert.match(result.reason, /high-risk/i);
});

// ─── Test 16: "Remain Unchanged" mixed case → rejected ─────────────────────

test("adversarial round 9: mixed-case 'Remain Unchanged' in assumption is rejected", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "User experience should Remain Unchanged", risk: "low", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, false,
    "mixed-case 'Remain Unchanged' must still be caught by case-insensitive regex");
  assert.match(result.reason, /assumptions\[0\]/);
});

// ─── Test 17: smuggled keyword embedded in longer word → allowed (word boundary) ─

test("adversarial round 9: smuggled keyword as substring of longer word is NOT rejected (word boundary)", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "The assumption is reasonable", risk: "medium", acceptedForExecution: false },
  ]));

  // "reason" does not match /\b(required)\b/ — the regex uses word boundaries
  // "must" does not appear, "should" does not appear, etc.
  // "assumption" contains no trigger words
  assert.strictEqual(result.ok, true,
    "the word 'reasonable' should not trigger the smuggling regex (word boundary check)");
});

// ─── Test 18: smuggled keyword in second assumption, clean first ────────────

test("adversarial round 9: smuggling in second assumption is caught with correct index", () => {
  const result = validateAcceptanceChecklist(baseChecklist([
    { id: "ASM-001", text: "Node.js version is 20.x", risk: "low", acceptedForExecution: true },
    { id: "ASM-002", text: "Clean text here", risk: "medium", acceptedForExecution: false },
    { id: "ASM-003", text: "All tests are required to pass", risk: "low", acceptedForExecution: false },
  ]));

  assert.strictEqual(result.ok, false, "third assumption smuggles 'required'");
  assert.match(result.reason, /assumptions\[2\]/, "must identify assumptions[2] as the smuggler");
});
