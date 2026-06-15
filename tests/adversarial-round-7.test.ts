/**
 * Adversarial Round 7: unmappedChangedFiles blocks completion even when
 * all items pass with fresh evidence.
 *
 * Scenario: An executor completes a task with perfect evidence — every
 * checklist item has a matching, fresh evidence entry with the correct
 * verificationMethod, command output, and attempt ID.  However the
 * execution map shows unmappedChangedFiles: ["core/engine/run-job.ts"],
 * meaning the executor touched a production file that no checklist item
 * covers.  evaluateChecklistCompletion must return scope_violation
 * regardless of evidence quality.
 *
 * This tests the ordering guarantee: the unmappedChangedFiles gate fires
 * BEFORE evidence freshness/mismatch checks.  An attacker (or buggy
 * bridge) cannot bypass scope enforcement by submitting perfect evidence.
 *
 * Variants tested:
 *   1. Single item passes, one unmapped file → scope_violation
 *   2. Multiple items all pass, one unmapped file → scope_violation
 *   3. Multiple unmapped files → scope_violation with full list
 *   4. Unmapped file + stale evidence → scope_violation (not evidence_stale)
 *   5. Unmapped file + mismatched evidence → scope_violation (not evidence_mismatch)
 *   6. Unmapped file + poisoned session → poisoned_session wins (runtime first)
 *   7. Empty unmappedChangedFiles with passing evidence → complete (positive control)
 *   8. Full completion gate with unmapped file → scope_violation
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateCompletionGate } from "../core/engine/completion-gate.js";
import {
  evaluateChecklistCompletion,
} from "../core/workflow/acceptance-checklist.js";

type AnyRecord = Record<string, any>;

// ─── Shared fixtures ──────────────────────────────────────────────────────

function singleItemChecklist() {
  return {
    schemaVersion: 1,
    jobId: "job-r7",
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

function multiItemChecklist() {
  return {
    schemaVersion: 1,
    jobId: "job-r7",
    project: "flow",
    status: "frozen",
    source: { task: "add dark mode with tests", issue: null, documents: [] },
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
      {
        id: "AC-002",
        requirement: "Build succeeds",
        source: "user_task",
        sourceRefs: [{ kind: "task_text", locator: "task:1", sha256: "sha256:task2" }],
        predicateId: "PRED-002",
        required: true,
        area: "cli",
        risk: "medium",
        verificationMethod: "command",
        expectedEvidence: "npm run build exit 0",
        dependsOn: [],
        allowedFiles: ["src/"],
      },
    ],
    assumptions: [],
  };
}

function validCommandEvidence(
  checklistId: string,
  predicateId: string,
  evidenceId: string,
  attemptId = "attempt-r7",
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
    exitCode: 0,
    cwd: "/repo",
    stdoutSha256: `sha256:stdout-${evidenceId}`,
    worktreeHead: "eee111",
    diffHash: "sha256:r7-diff",
  };
}

function passingVerdict(
  items: Array<{ checklistId: string; evidenceId: string }>,
) {
  return {
    schemaVersion: 1,
    jobId: "job-r7",
    status: "pass",
    items: items.map(({ checklistId, evidenceId }) => ({
      checklistId,
      result: "pass",
      evidenceRefs: [{ ledgerId: "evidence-ledger-r7", evidenceId }],
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
    ledgerId: "evidence-ledger-r7",
    attemptId: "attempt-r7",
    finalWorktree: { head: "eee111", diffHash: "sha256:r7-diff" },
    evidence,
  };
}

function executionMapWithUnmapped(unmappedFiles: string[]) {
  return {
    schemaVersion: 1,
    mappings: [
      { checklistId: "AC-001", changedFiles: ["src/theme.ts"] },
    ],
    changedFiles: ["src/theme.ts", ...unmappedFiles],
    unmappedChangedFiles: unmappedFiles,
  };
}

function cleanExecutionMap() {
  return { unmappedChangedFiles: [] };
}

function completeJobGate() {
  return {
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass" as const, raw: "PASS" },
  };
}

// ─── Test 1: Single item passes, one unmapped file → scope_violation ──────

test("adversarial round 7: single passing item with unmappedChangedFile → scope_violation", () => {
  const checklist = singleItemChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);
  const executionMap = executionMapWithUnmapped(["core/engine/run-job.ts"]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap,
    runtimeFailures: [],
    attemptId: "attempt-r7",
  });

  assert.strictEqual(result.outcome, "scope_violation",
    `expected scope_violation but got ${result.outcome}: ${result.reason}`);
  assert.ok(
    Array.isArray(result.unmappedChangedFiles)
      && result.unmappedChangedFiles.includes("core/engine/run-job.ts"),
    "unmappedChangedFiles must contain the unmapped file",
  );
});

// ─── Test 2: Multiple items all pass, one unmapped file → scope_violation ─

test("adversarial round 7: all items pass but unmappedChangedFiles present → scope_violation", () => {
  const checklist = multiItemChecklist();
  const evidence = [
    validCommandEvidence("AC-001", "PRED-001", "EV-001"),
    validCommandEvidence("AC-002", "PRED-002", "EV-002"),
  ];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([
    { checklistId: "AC-001", evidenceId: "EV-001" },
    { checklistId: "AC-002", evidenceId: "EV-002" },
  ]);
  const executionMap = executionMapWithUnmapped(["core/engine/run-job.ts"]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap,
    runtimeFailures: [],
    attemptId: "attempt-r7",
  });

  assert.strictEqual(result.outcome, "scope_violation",
    `expected scope_violation but got ${result.outcome}: ${result.reason}`);
});

// ─── Test 3: Multiple unmapped files → scope_violation with full list ─────

test("adversarial round 7: multiple unmapped files all reported in scope_violation", () => {
  const checklist = singleItemChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);
  const unmapped = ["core/engine/run-job.ts", "server/routes/tasks.js"];
  const executionMap = executionMapWithUnmapped(unmapped);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap,
    runtimeFailures: [],
    attemptId: "attempt-r7",
  });

  assert.strictEqual(result.outcome, "scope_violation",
    `expected scope_violation but got ${result.outcome}: ${result.reason}`);
  assert.deepEqual(
    result.unmappedChangedFiles.sort(),
    unmapped.sort(),
    "all unmapped files must be reported",
  );
});

// ─── Test 4: Unmapped file + stale evidence → scope_violation (not evidence_stale) ──

test("adversarial round 7: unmappedChangedFiles takes priority over stale evidence", () => {
  const checklist = singleItemChecklist();
  // Stale evidence: diffHash differs from ledger finalWorktree
  const staleEvidence = {
    ...validCommandEvidence("AC-001", "PRED-001", "EV-STALE"),
    worktreeHead: "old_head",
    diffHash: "sha256:stale-diff",
  };
  const ledger = {
    ...evidenceLedger([staleEvidence]),
    finalWorktree: { head: "new_head", diffHash: "sha256:new-diff" },
  };
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-STALE" }]);
  const executionMap = executionMapWithUnmapped(["core/engine/run-job.ts"]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap,
    runtimeFailures: [],
    attemptId: "attempt-r7",
  });

  // scope_violation fires before evidence_stale check in the code path
  assert.strictEqual(result.outcome, "scope_violation",
    `expected scope_violation but got ${result.outcome}: ${result.reason}`);
});

// ─── Test 5: Unmapped file + mismatched evidence → scope_violation (not evidence_mismatch) ──

test("adversarial round 7: unmappedChangedFiles takes priority over evidence mismatch", () => {
  const checklist = singleItemChecklist();
  // Mismatched evidence: verificationMethod doesn't match checklist
  const mismatchedEvidence = {
    id: "EV-MISMATCH",
    type: "evidence_claim",
    observationType: "static",
    checklistId: "AC-001",
    attemptId: "attempt-r7",
    verificationMethod: "static",   // checklist requires "command"
    predicateId: "PRED-001",
    probeId: "probe-mismatch",
    result: "pass",
    // static fields, not command fields
    worktreeHead: "eee111",
    diffHash: "sha256:r7-diff",
  };
  const ledger = evidenceLedger([mismatchedEvidence]);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-MISMATCH" }]);
  const executionMap = executionMapWithUnmapped(["core/engine/run-job.ts"]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap,
    runtimeFailures: [],
    attemptId: "attempt-r7",
  });

  // scope_violation fires before evidence mismatch check
  assert.strictEqual(result.outcome, "scope_violation",
    `expected scope_violation but got ${result.outcome}: ${result.reason}`);
});

// ─── Test 6: Unmapped file + poisoned session → poisoned_session wins ────

test("adversarial round 7: poisoned_session takes priority over scope_violation (runtime first)", () => {
  const checklist = singleItemChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);
  const executionMap = executionMapWithUnmapped(["core/engine/run-job.ts"]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap,
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: "attempt-r7",
      phase: "verify",
      nodeId: "verify",
      reason: "provider output was poisoned",
    }],
    attemptId: "attempt-r7",
  });

  // Runtime failures are checked before unmapped files in the code path
  assert.strictEqual(result.outcome, "poisoned_session",
    `expected poisoned_session but got ${result.outcome}: ${result.reason}`);
});

// ─── Test 7: Empty unmappedChangedFiles with passing evidence → complete (positive control) ──

test("adversarial round 7: empty unmappedChangedFiles with valid evidence → complete (positive control)", () => {
  const checklist = singleItemChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: cleanExecutionMap(),
    runtimeFailures: [],
    attemptId: "attempt-r7",
  });

  assert.strictEqual(result.outcome, "complete",
    `positive control: expected complete but got ${result.outcome}: ${result.reason}`);
});

// ─── Test 8: Full completion gate with unmapped file → scope_violation ────

test("adversarial round 7: full completion gate returns scope_violation for unmapped files", () => {
  const checklist = singleItemChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = {
    ...evidenceLedger(evidence),
    schemaVersion: 1,
    jobId: "job-r7",
    project: "flow",
  };
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);
  const executionMap = executionMapWithUnmapped(["core/engine/run-job.ts"]);

  const result = evaluateCompletionGate({
    ...completeJobGate(),
    attemptId: "attempt-r7",
    checklist,
    checklistVerdict: verdict,
    evidenceLedger: ledger,
    executionMap,
  });

  assert.strictEqual(result.outcome, "scope_violation",
    `completion gate must return scope_violation but got ${result.outcome}: ${result.reason}`);
  assert.ok(result.missingGates.includes("checklist"),
    "missing gates must include 'checklist'");
});

// ─── Test 9: null executionMap is treated as no unmapped files ─────────────

test("adversarial round 7: null executionMap does not trigger scope_violation", () => {
  const checklist = singleItemChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: null,
    runtimeFailures: [],
    attemptId: "attempt-r7",
  });

  // null executionMap → unmappedChangedFiles defaults to [] → no scope violation
  assert.strictEqual(result.outcome, "complete",
    `null executionMap should not cause scope_violation, got ${result.outcome}: ${result.reason}`);
});

// ─── Test 10: executionMap with empty unmappedChangedFiles array explicitly ──

test("adversarial round 7: explicit empty unmappedChangedFiles array does not block", () => {
  const checklist = singleItemChecklist();
  const evidence = [validCommandEvidence("AC-001", "PRED-001", "EV-001")];
  const ledger = evidenceLedger(evidence);
  const verdict = passingVerdict([{ checklistId: "AC-001", evidenceId: "EV-001" }]);

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [], changedFiles: ["src/theme.ts"] },
    runtimeFailures: [],
    attemptId: "attempt-r7",
  });

  assert.strictEqual(result.outcome, "complete",
    `explicit empty unmappedChangedFiles should pass, got ${result.outcome}: ${result.reason}`);
});
