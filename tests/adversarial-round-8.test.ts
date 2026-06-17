/**
 * Adversarial Round 8: Multi-attempt ambiguity fails closed.
 *
 * Scenario: A multi-attempt job collects runtime failure events from the
 * event log.  Each failure MUST carry an attemptId so the evaluator can
 * attribute it to the correct attempt.  If any runtime failure event is
 * missing its attemptId, the evaluator cannot safely determine which
 * attempt the failure belongs to — so it must fail closed with outcome
 * runtime_failure_ambiguous.
 *
 * This is the ambiguity-bomb: even if everything else is perfect (passing
 * evidence, fresh worktree, empty unmappedChangedFiles), a single
 * attemptId-less runtime failure event poisons the entire evaluation.
 * An attacker who can inject a runtime_failure event without an attemptId
 * can force a denial-of-completion without attribution.
 *
 * The runtime_failure_ambiguous outcome maps to ARTIFACT_INVALID in the
 * routing table (mark_failed, non-retryable) — the hardest possible fail.
 *
 * Variants tested:
 *   1. 2 attempts, one runtime failure missing attemptId → runtime_failure_ambiguous
 *   2. 2 attempts, multiple runtime failures all missing attemptId → runtime_failure_ambiguous
 *   3. 2 attempts, runtime failure with wrong attemptId (not active) → filtered, not ambiguous
 *   4. 2 attempts, mixed: one failure with attemptId, one without → ambiguous (fails closed)
 *   5. 2 attempts, all runtime failures have correct attemptId → poisoned_session (not ambiguous)
 *   6. runtime_failure_ambiguous with perfect evidence → still ambiguous (priority over complete)
 *   7. runtime_failure_ambiguous with unmappedChangedFiles → ambiguous (priority over scope_violation)
 *   8. single-attempt (multiAttempt=false) ignores missing attemptId → poisoned_session
 *   9. Full completion gate with ambiguous runtime failures → runtime_failure_ambiguous
 *  10. Positive control: no runtime failures, multiAttempt=true → complete
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AnyRecord } from "../shared/types.js";

import { evaluateCompletionGate } from "../core/engine/completion-gate.js";
import {
  evaluateChecklistCompletion,
} from "../core/workflow/acceptance-checklist.js";


// ─── Shared fixtures ──────────────────────────────────────────────────────

function baseChecklist() {
  return {
    schemaVersion: 1,
    jobId: "job-r8",
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

function validCommandEvidence(
  checklistId: string,
  predicateId: string,
  evidenceId: string,
  attemptId = "attempt-r8-a1",
) {
  return {
    id: evidenceId,
    type: "evidence_claim",
    observationType: "command",
    checklistId,
    attemptId,
    verificationMethod: "command",
    predicateId,
    probeId: `probe-${evidenceId}`,
    result: "pass",
    command: "npm test",
    cwd: "/repo/flow",
    exitCode: 0,
    stdoutSha256: `sha256:stdout-${evidenceId}`,
    worktreeHead: "eee222",
    diffHash: "sha256:r8-diff",
  };
}

function passingVerdict(
  items: Array<{ checklistId: string; evidenceId: string }>,
) {
  return {
    schemaVersion: 1,
    jobId: "job-r8",
    status: "pass",
    items: items.map(({ checklistId, evidenceId }) => ({
      checklistId,
      result: "pass",
      evidenceRefs: [{ ledgerId: "evidence-ledger-r8", evidenceId }],
      actualResult: "ok",
      reason: "ok",
      fixScope: [],
    })),
    blocking: [],
    fixScope: [],
    reason: "passed",
  };
}

function evidenceLedger(evidence: AnyRecord[]) {
  return {
    schemaVersion: 1,
    ledgerId: "evidence-ledger-r8",
    attemptId: "attempt-r8-a1",
    finalWorktree: { head: "eee222", diffHash: "sha256:r8-diff" },
    evidence,
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

// ─── Test 1: 2 attempts, one runtime failure missing attemptId → ambiguous ─

test("adversarial round 8: single runtime failure without attemptId in multi-attempt → runtime_failure_ambiguous", () => {
  const checklist = baseChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: "",  // missing — empty string
      phase: "verify",
      nodeId: "verify",
      reason: "provider output was poisoned",
    }],
    attemptId: "attempt-r8-a1",
    multiAttempt: true,
  });

  assert.strictEqual(result.outcome, "runtime_failure_ambiguous",
    `expected runtime_failure_ambiguous but got ${result.outcome}: ${result.reason}`);
  assert.ok(
    Array.isArray(result.runtimeFailureRefs) && result.runtimeFailureRefs.length > 0,
    "runtimeFailureRefs must contain the ambiguous failure",
  );
});

// ─── Test 2: multiple failures all missing attemptId → ambiguous ────────────

test("adversarial round 8: multiple runtime failures without attemptId → runtime_failure_ambiguous with all refs", () => {
  const checklist = baseChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [
      { type: "phase_poisoned_session", attemptId: null, phase: "execute", nodeId: "execute", reason: "poisoned exec" },
      { type: "phase_poisoned_session", attemptId: undefined, phase: "verify", nodeId: "verify", reason: "poisoned verify" },
    ],
    attemptId: "attempt-r8-a1",
    multiAttempt: true,
  });

  assert.strictEqual(result.outcome, "runtime_failure_ambiguous",
    `expected runtime_failure_ambiguous but got ${result.outcome}: ${result.reason}`);
  // Both failures should be in the refs (null and undefined both → text() → "")
  assert.ok(
    result.runtimeFailureRefs.length >= 1,
    "runtimeFailureRefs must contain ambiguous failure entries",
  );
});

// ─── Test 3: wrong attemptId (not active) → filtered, not ambiguous ────────

test("adversarial round 8: runtime failure with wrong attemptId is filtered out, not ambiguous", () => {
  const checklist = baseChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: "attempt-r8-a0",  // different attempt — filtered out
      phase: "verify",
      nodeId: "verify",
      reason: "stale failure from previous attempt",
    }],
    attemptId: "attempt-r8-a1",
    multiAttempt: true,
  });

  // The failure belongs to a different attempt, so it's filtered.
  // No failures for the active attempt → complete
  assert.strictEqual(result.outcome, "complete",
    `wrong-attempt failure should be filtered, got ${result.outcome}: ${result.reason}`);
});

// ─── Test 4: mixed: one failure with attemptId, one without → ambiguous ────

test("adversarial round 8: one failure with attemptId + one without → ambiguous (fails closed)", () => {
  const checklist = baseChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [
      { type: "phase_poisoned_session", attemptId: "attempt-r8-a1", phase: "verify", nodeId: "verify", reason: "attributed failure" },
      { type: "phase_poisoned_session", attemptId: "", phase: "execute", nodeId: "execute", reason: "unattributed failure" },
    ],
    attemptId: "attempt-r8-a1",
    multiAttempt: true,
  });

  assert.strictEqual(result.outcome, "runtime_failure_ambiguous",
    `mixed failures should fail closed as ambiguous, got ${result.outcome}: ${result.reason}`);
});

// ─── Test 5: all failures have correct attemptId → poisoned_session (not ambiguous) ──

test("adversarial round 8: all runtime failures attributed correctly → poisoned_session, not ambiguous", () => {
  const checklist = baseChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: "attempt-r8-a1",
      phase: "verify",
      nodeId: "verify",
      reason: "properly attributed",
    }],
    attemptId: "attempt-r8-a1",
    multiAttempt: true,
  });

  assert.strictEqual(result.outcome, "poisoned_session",
    `attributed failure should be poisoned_session, got ${result.outcome}: ${result.reason}`);
});

// ─── Test 6: ambiguous with perfect evidence → still ambiguous (highest priority) ──

test("adversarial round 8: ambiguous runtime failure overrides perfect evidence", () => {
  const checklist = baseChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: null,
      phase: "verify",
      nodeId: "verify",
      reason: "unattributed",
    }],
    attemptId: "attempt-r8-a1",
    multiAttempt: true,
  });

  // Ambiguity check is FIRST in evaluateChecklistCompletion — before verdict
  // validation, before unmappedChangedFiles, before evidence checks.
  assert.strictEqual(result.outcome, "runtime_failure_ambiguous",
    `ambiguity must override all other checks, got ${result.outcome}: ${result.reason}`);
});

// ─── Test 7: ambiguous with unmappedChangedFiles → ambiguous (priority over scope_violation) ──

test("adversarial round 8: ambiguous runtime failure overrides scope_violation", () => {
  const checklist = baseChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: ["core/engine/run-job.ts"] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: null,
      phase: "verify",
      nodeId: "verify",
      reason: "unattributed",
    }],
    attemptId: "attempt-r8-a1",
    multiAttempt: true,
  });

  // Ambiguity check fires before unmappedChangedFiles check
  assert.strictEqual(result.outcome, "runtime_failure_ambiguous",
    `ambiguity must override scope_violation, got ${result.outcome}: ${result.reason}`);
});

// ─── Test 8: single-attempt ignores missing attemptId → poisoned_session ───

test("adversarial round 8: single-attempt (multiAttempt=false) with missing attemptId → poisoned_session", () => {
  const checklist = baseChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: null,
      phase: "verify",
      nodeId: "verify",
      reason: "no attemptId but single-attempt mode",
    }],
    attemptId: "attempt-r8-a1",
    multiAttempt: false,  // NOT multi-attempt → ambiguity check skipped
  });

  // Without multiAttempt, the missing attemptId doesn't trigger ambiguity.
  // The failure is treated as attributed to this attempt.
  assert.strictEqual(result.outcome, "poisoned_session",
    `single-attempt should not trigger ambiguity, got ${result.outcome}: ${result.reason}`);
});

// ─── Test 9: Full completion gate with ambiguous runtime failures ───────────

test("adversarial round 8: completion gate returns runtime_failure_ambiguous", () => {
  const checklist = baseChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = {
    ...evidenceLedger(evidence),
    schemaVersion: 1,
    jobId: "job-r8",
    project: "flow",
  };
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateCompletionGate({
    ...completeJobGate(),
    attemptId: "attempt-r8-a1",
    multiAttempt: true,
    checklist,
    checklistVerdict: verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: "",
      phase: "verify",
      nodeId: "verify",
      reason: "unattributed failure",
    }],
  });

  assert.strictEqual(result.outcome, "runtime_failure_ambiguous",
    `completion gate must return runtime_failure_ambiguous, got ${result.outcome}: ${result.reason}`);
  assert.ok(result.missingGates.includes("checklist"),
    "missingGates must include 'checklist'");
});

// ─── Test 10: Positive control: no runtime failures, multiAttempt → complete ─

test("adversarial round 8: no runtime failures in multi-attempt → complete (positive control)", () => {
  const checklist = baseChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [],
    attemptId: "attempt-r8-a1",
    multiAttempt: true,
  });

  assert.strictEqual(result.outcome, "complete",
    `positive control: expected complete but got ${result.outcome}: ${result.reason}`);
});
