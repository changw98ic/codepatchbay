/**
 * Task 8: Checklist completion gate tests.
 *
 * Tests for evaluateCompletionGate checklist-aware path,
 * completionGateEvent checklist field preservation, and
 * materialized state reducer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AnyRecord } from "../shared/types.js";

import { evaluateCompletionGate, completionGateEvent } from "../core/engine/completion-gate.js";
import { materializeJob } from "../server/services/event/event-store.js";


function ts(offset = 0) {
  return new Date(Date.now() + offset).toISOString();
}

// ── Shared fixtures ─────────────────────────────────────

function frozenChecklist() {
  return {
    schemaVersion: 1,
    jobId: "job-1",
    project: "flow",
    status: "frozen",
    source: { task: "task", issue: null, documents: [] },
    items: [{
      id: "AC-001",
      requirement: "required behavior",
      source: "user_task",
      sourceRefs: [{ kind: "task_text", locator: "task:0" }],
      predicateId: "PRED-001",
      required: true,
      area: "cli",
      risk: "medium",
      verificationMethod: "command",
      expectedEvidence: "command output",
      dependsOn: [],
      allowedFiles: [],
    }],
    assumptions: [],
  };
}

function passingChecklistVerdict() {
  return {
    schemaVersion: 1,
    jobId: "job-1",
    status: "pass",
    items: [{
      checklistId: "AC-001",
      result: "pass",
      evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }],
      actualResult: "ok",
      reason: "ok",
      fixScope: [],
    }],
    blocking: [],
    fixScope: [],
    reason: "ok",
  };
}

function freshEvidenceLedger(attemptId: string = "attempt-001") {
  return {
    ledgerId: "evidence-ledger-001",
    attemptId,
    finalWorktree: { head: "abc", diffHash: "sha256:new" },
    evidence: [{
      id: "EV-001",
      type: "evidence_claim",
      checklistId: "AC-001",
      verificationMethod: "command",
      predicateId: "PRED-001",
      attemptId,
      result: "pass",
      worktreeHead: "abc",
      diffHash: "sha256:new",
      command: "npm test",
      exitCode: 0,
      stdoutSha256: "sha256:stdout",
      cwd: "/repo",
    }],
  };
}

function cleanExecutionMap() {
  return {
    schemaVersion: 1,
    mappings: [{ checklistId: "AC-001", changedFiles: ["cli/commands/status.ts"] }],
    changedFiles: ["cli/commands/status.ts"],
    unmappedChangedFiles: [],
  };
}

function completeJobGate() {
  return {
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass" as const, raw: "PASS" },
  };
}

// ── Pure gate tests ─────────────────────────────────────

test("completion gate blocks stale checklist evidence", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    checklist: frozenChecklist(),
    checklistVerdict: passingChecklistVerdict(),
    evidenceLedger: {
      ledgerId: "evidence-ledger-001",
      finalWorktree: { head: "abc", diffHash: "sha256:new" },
      evidence: [{
        id: "EV-001",
        type: "evidence_claim",
        checklistId: "AC-001",
        verificationMethod: "command",
        predicateId: "PRED-001",
        result: "pass",
        worktreeHead: "abc",
        diffHash: "sha256:old",
        command: "npm test",
        exitCode: 0,
        stdoutSha256: "sha256:stdout",
        cwd: "/repo",
      }],
    },
    executionMap: cleanExecutionMap(),
  });
  assert.equal(result.outcome, "evidence_stale");
});

test("completion gate blocks unresolved runtime failures", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    attemptId: "attempt-002",
    checklist: frozenChecklist(),
    checklistVerdict: passingChecklistVerdict(),
    evidenceLedger: {
      ledgerId: "evidence-ledger-001",
      finalWorktree: { head: "abc", diffHash: "sha256:one" },
      evidence: [{
        id: "EV-001",
        type: "evidence_claim",
        checklistId: "AC-001",
        verificationMethod: "command",
        predicateId: "PRED-001",
        result: "pass",
        worktreeHead: "abc",
        diffHash: "sha256:one",
      }],
    },
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: "attempt-002",
      phase: "verify",
      nodeId: "verify",
      reason: "provider output was poisoned",
    }],
  });
  assert.equal(result.outcome, "poisoned_session");
  assert.equal((result.details as AnyRecord).checklist.runtimeFailureRefs[0].type, "phase_poisoned_session");
});

// ── Materialized state test ─────────────────────────────

test("completion gate event preserves checklist fields in materialized state", () => {
  const event = completionGateEvent("job-1", "flow", {
    outcome: "checklist_failed",
    reason: "required checklist items failed",
    attemptId: "attempt-002",
    missingGates: ["checklist"],
    details: {
      checklist: {
        outcome: "checklist_failed",
        failedChecklistIds: ["AC-002"],
        uncheckedChecklistIds: [],
        missingEvidenceRefs: [],
        mismatchedEvidenceRefs: [],
        staleEvidenceRefs: [],
        poisonedEvidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }],
        runtimeFailureRefs: [{
          type: "phase_poisoned_session",
          attemptId: "attempt-002",
          phase: "verify",
          nodeId: "verify",
          reason: "provider output was poisoned",
        }],
        unmappedChangedFiles: [],
      },
    },
  } as AnyRecord);
  const state = materializeJob([event]);
  assert.equal(state.completionGate.attemptId, "attempt-002");
  assert.equal(state.completionGate.checklistOutcome, "checklist_failed");
  assert.deepEqual(state.completionGate.failedChecklistIds, ["AC-002"]);
  assert.equal(state.completionGate.runtimeFailureCount, 1);
});

// ── Integration-style negative cases ────────────────────

test("checklist-aware job with legacy VERDICT: PASS but no checklist-verdict must not complete", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    checklist: frozenChecklist(),
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });
  // Without checklistVerdict, evaluateChecklistCompletion should fail
  assert.notEqual(result.outcome, "complete");
});

test("execution-map unmapped changed files blocks completion even with passing checklist", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    checklist: frozenChecklist(),
    checklistVerdict: passingChecklistVerdict(),
    evidenceLedger: freshEvidenceLedger(),
    executionMap: {
      schemaVersion: 1,
      mappings: [{ checklistId: "AC-001", changedFiles: ["cli/commands/status.ts"] }],
      changedFiles: ["cli/commands/status.ts", "core/engine/run-job.ts"],
      unmappedChangedFiles: ["core/engine/run-job.ts"],
    },
  });
  assert.equal(result.outcome, "scope_violation");
});

test("unresolved phase_poisoned_session blocks completion even with valid artifacts", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    attemptId: "attempt-001",
    checklist: frozenChecklist(),
    checklistVerdict: passingChecklistVerdict(),
    evidenceLedger: freshEvidenceLedger(),
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: "attempt-001",
      phase: "verify",
      nodeId: "verify",
      reason: "provider output was poisoned",
    }],
  });
  assert.equal(result.outcome, "poisoned_session");
});

test("runtime failure from previous attempt does not block active attempt", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    attemptId: "attempt-002",
    checklist: frozenChecklist(),
    checklistVerdict: passingChecklistVerdict(),
    evidenceLedger: freshEvidenceLedger("attempt-002"),
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      attemptId: "attempt-001",
      phase: "verify",
      nodeId: "verify",
      reason: "old failure from previous attempt",
    }],
  });
  // The failure is from a different attempt, so checklist gate should pass,
  // but the legacy verdict gate still applies — result should be complete
  assert.equal(result.outcome, "complete");
});

test("multi-attempt job with runtime failures missing attemptId fails closed", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    attemptId: "attempt-002",
    checklist: frozenChecklist(),
    checklistVerdict: passingChecklistVerdict(),
    evidenceLedger: freshEvidenceLedger(),
    executionMap: { unmappedChangedFiles: [] },
    runtimeFailures: [{
      type: "phase_poisoned_session",
      phase: "verify",
      nodeId: "verify",
      reason: "ambiguous failure without attempt ownership",
    }],
    multiAttempt: true,
  });
  assert.equal(result.outcome, "runtime_failure_ambiguous");
});

// ── Happy path ──────────────────────────────────────────

test("happy path: all checklist artifacts valid and fresh, no runtime failures, completes", () => {
  const result = evaluateCompletionGate({
    ...completeJobGate(),
    attemptId: "attempt-001",
    checklist: frozenChecklist(),
    checklistVerdict: passingChecklistVerdict(),
    evidenceLedger: freshEvidenceLedger("attempt-001"),
    executionMap: cleanExecutionMap(),
  });
  assert.equal(result.outcome, "complete");
});

// ── Legacy fallback ─────────────────────────────────────

test("legacy job without checklist uses verdict gate fallback", () => {
  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass" as const, raw: "PASS" },
    checklist: null,
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });
  assert.equal(result.outcome, "complete");
});

test("legacy job with failing verdict fails normally", () => {
  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "fail" as const, raw: "FAIL" },
    checklist: null,
    checklistVerdict: null,
    evidenceLedger: null,
    executionMap: null,
  });
  assert.equal(result.outcome, "verification_failed");
});

// ── completionGateEvent preserves all checklist fields ──

test("completionGateEvent includes all checklist fields", () => {
  const event = completionGateEvent("job-1", "flow", {
    outcome: "evidence_stale",
    reason: "stale evidence",
    attemptId: "attempt-003",
    missingGates: ["checklist"],
    details: {
      checklist: {
        outcome: "evidence_stale",
        failedChecklistIds: [],
        uncheckedChecklistIds: [],
        missingEvidenceRefs: [],
        mismatchedEvidenceRefs: [],
        staleEvidenceRefs: [{ ledgerId: "el-001", evidenceId: "EV-001" }],
        poisonedEvidenceRefs: [],
        runtimeFailureRefs: [],
        unmappedChangedFiles: ["core/extra.ts"],
      },
    },
  } as AnyRecord);

  assert.equal(event.type, "completion_gate_evaluated");
  assert.equal(event.jobId, "job-1");
  assert.equal(event.project, "flow");
  assert.equal(event.outcome, "evidence_stale");
  assert.equal(event.attemptId, "attempt-003");
  assert.equal(event.checklistOutcome, "evidence_stale");
  assert.deepEqual(event.staleEvidenceRefs, [{ ledgerId: "el-001", evidenceId: "EV-001" }]);
  assert.deepEqual(event.unmappedChangedFiles, ["core/extra.ts"]);
  assert.equal(event.unmappedChangedFileCount, 1);
  assert.equal(event.runtimeFailureCount, 0);
});

test("completionGateEvent handles missing checklist details gracefully", () => {
  const event = completionGateEvent("job-2", "flow", {
    outcome: "complete",
    reason: "all gates passed",
    missingGates: [],
  } as AnyRecord);

  assert.equal(event.checklistOutcome, null);
  assert.deepEqual(event.failedChecklistIds, []);
  assert.deepEqual(event.staleEvidenceRefs, []);
  assert.equal(event.runtimeFailureCount, 0);
  assert.equal(event.unmappedChangedFileCount, 0);
});

// ── Materialized state preserves all checklist fields ───

test("completion_gate_evaluated reducer preserves all checklist fields", () => {
  const state = materializeJob([{
    type: "completion_gate_evaluated",
    jobId: "job-1",
    project: "flow",
    outcome: "evidence_missing",
    reason: "missing evidence",
    attemptId: "attempt-004",
    missingGates: ["checklist"],
    checklistOutcome: "evidence_missing",
    failedChecklistIds: ["AC-001"],
    uncheckedChecklistIds: ["AC-002"],
    missingEvidenceRefs: [{ ledgerId: "el-001", evidenceId: "EV-001" }],
    mismatchedEvidenceRefs: [],
    staleEvidenceRefs: [{ ledgerId: "el-001", evidenceId: "EV-002" }],
    poisonedEvidenceRefs: [],
    runtimeFailureRefs: [],
    runtimeFailureCount: 0,
    unmappedChangedFiles: [],
    unmappedChangedFileCount: 0,
    ts: ts(100),
  }]);

  assert.ok(state.completionGate);
  assert.equal(state.completionGate.outcome, "evidence_missing");
  assert.equal(state.completionGate.attemptId, "attempt-004");
  assert.equal(state.completionGate.checklistOutcome, "evidence_missing");
  assert.deepEqual(state.completionGate.failedChecklistIds, ["AC-001"]);
  assert.deepEqual(state.completionGate.uncheckedChecklistIds, ["AC-002"]);
  assert.deepEqual(state.completionGate.missingEvidenceRefs, [{ ledgerId: "el-001", evidenceId: "EV-001" }]);
  assert.deepEqual(state.completionGate.staleEvidenceRefs, [{ ledgerId: "el-001", evidenceId: "EV-002" }]);
  assert.equal(state.completionGate.runtimeFailureCount, 0);
  assert.equal(state.completionGate.unmappedChangedFileCount, 0);
});
