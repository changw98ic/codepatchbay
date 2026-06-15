/**
 * Adversarial Round 2: Stale evidence from a previous attempt cannot
 * satisfy a new attempt's completion gate.
 *
 * Scenario: Attempt 1 ran verify and produced an evidence ledger with
 * passing evidence (EV-001).  Attempt 2 starts with a different worktree
 * head.  The completion gate for attempt 2 MUST fail because:
 *
 *   a) If the verdict references EV IDs from attempt 1's ledger but the
 *      active ledger for attempt 2 has no entries → evidence_missing.
 *   b) If attempt 1's ledger is somehow loaded (readActiveChecklistArtifacts
 *      falls back to latest when no attempt-scoped artifact exists), the
 *      evidence observations fail the attemptId check → evidence_mismatch.
 *   c) If the evidence entry matches the active attemptId but has a different
 *      worktree head than the ledger's finalWorktree → evidence_stale.
 *
 * Three attack vectors tested:
 *   1. Pure gate: attempt 2 verdict references attempt 1 ledger → evidence_missing
 *   2. Pure gate: attempt 1 ledger loaded, evidence has wrong attemptId → evidence_mismatch
 *   3. Pure gate: evidence matches attemptId but worktree differs → evidence_stale
 *   4. Integration: readActiveChecklistArtifacts returns attempt 1 artifacts as fallback
 *   5. Full gate integration: stale artifacts on disk lead to gate failure
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { evaluateCompletionGate } from "../core/engine/completion-gate.js";
import { evaluateChecklistCompletion } from "../core/workflow/acceptance-checklist.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { buildArtifactIndex } from "../server/services/job/job-projection.js";
import { readActiveChecklistArtifacts } from "../core/workflow/checklist-artifacts.js";
import { tempRoot } from "./helpers.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────

type AnyRecord = Record<string, any>;

function frozenChecklist(items: AnyRecord[] = [defaultItem()]) {
  return {
    schemaVersion: 1,
    jobId: "job-stale",
    project: "flow",
    status: "frozen",
    source: { task: "task", issue: null, documents: [] },
    items,
    assumptions: [],
  };
}

function defaultItem(overrides: AnyRecord = {}) {
  return {
    id: "AC-001",
    requirement: "required behavior",
    source: "user_task",
    sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: null }],
    predicateId: "PRED-001",
    required: true,
    area: "cli",
    risk: "medium",
    verificationMethod: "command",
    expectedEvidence: "command output",
    dependsOn: [],
    allowedFiles: [],
    ...overrides,
  };
}

/** Evidence ledger from attempt 1 with passing evidence EV-001. */
function attempt1Ledger() {
  return {
    schemaVersion: 1,
    jobId: "job-stale",
    project: "flow",
    ledgerId: "evidence-ledger-attempt1",
    attemptId: "attempt-001",
    finalWorktree: { head: "aaa111", diffHash: "sha256:attempt1" },
    evidence: [
      {
        id: "EV-001",
        type: "evidence_claim",
        observationType: "command",
        checklistId: "AC-001",
        attemptId: "attempt-001",
        verificationMethod: "command",
        predicateId: "PRED-001",
        probeId: "probe-status-json",
        result: "pass",
        command: "npm test",
        exitCode: 0,
        cwd: "/repo/work",
        stdoutSha256: "sha256:stdout-attempt1",
        summary: "passed in attempt 1",
        worktreeHead: "aaa111",
        diffHash: "sha256:attempt1",
      },
    ],
  };
}

/** Empty evidence ledger for attempt 2 (verification never ran). */
function attempt2Ledger() {
  return {
    schemaVersion: 1,
    jobId: "job-stale",
    project: "flow",
    ledgerId: "evidence-ledger-attempt2",
    attemptId: "attempt-002",
    finalWorktree: { head: "bbb222", diffHash: "sha256:attempt2" },
    evidence: [],
  };
}

/**
 * Evidence ledger for attempt 2 that has evidence entries copied from
 * attempt 1 (same EV IDs) but with stale worktree heads.
 * This simulates the attack where evidence is replayed across attempts.
 */
function attempt2LedgerWithStaleEvidence() {
  return {
    schemaVersion: 1,
    jobId: "job-stale",
    project: "flow",
    ledgerId: "evidence-ledger-attempt2",
    attemptId: "attempt-002",
    finalWorktree: { head: "bbb222", diffHash: "sha256:attempt2" },
    evidence: [
      {
        id: "EV-001",
        type: "evidence_claim",
        observationType: "command",
        checklistId: "AC-001",
        attemptId: "attempt-002",
        verificationMethod: "command",
        predicateId: "PRED-001",
        probeId: "probe-status-json",
        result: "pass",
        command: "npm test",
        exitCode: 0,
        cwd: "/repo/work",
        stdoutSha256: "sha256:stdout-attempt1",
        summary: "passed — but worktree is stale",
        worktreeHead: "aaa111",  // stale: different from finalWorktree.head
        diffHash: "sha256:attempt1",  // stale: different from finalWorktree.diffHash
      },
    ],
  };
}

function verdictWithEvidenceRefs(ledgerId: string, evidenceId: string = "EV-001") {
  return {
    schemaVersion: 1,
    jobId: "job-stale",
    status: "pass",
    items: [{
      checklistId: "AC-001",
      result: "pass",
      evidenceRefs: [{ ledgerId, evidenceId }],
      actualResult: "ok",
      reason: "ok",
      fixScope: [],
    }],
    blocking: [],
    fixScope: [],
    reason: "passed",
  };
}

// ─── Test 1: Pure gate — verdict refs attempt 1 ledger, attempt 2 ledger is empty → evidence_missing ──

test("adversarial round 2: attempt 2 verdict references attempt 1 ledger → evidence_missing", () => {
  // Attempt 2's ledger is empty (no evidence collected). The verdict
  // references EV-001 in the attempt 1 ledger. Since the evidence ledger
  // passed to evaluateChecklistCompletion is the attempt 2 ledger,
  // the key lookup fails → evidence_missing.
  const result = evaluateChecklistCompletion({
    checklist: frozenChecklist(),
    verdict: verdictWithEvidenceRefs("evidence-ledger-attempt1", "EV-001"),
    evidenceLedger: attempt2Ledger(),
    executionMap: { unmappedChangedFiles: [] },
    attemptId: "attempt-002",
  });

  assert.equal(result.outcome, "evidence_missing",
    `expected evidence_missing but got ${result.outcome}: ${result.reason}`);
  assert.ok(result.missingEvidenceRefs.length > 0,
    "missingEvidenceRefs must be non-empty when verdict references absent EV IDs");
  assert.equal(result.missingEvidenceRefs[0].evidenceId, "EV-001");
});

// ─── Test 2: Pure gate — attempt 1 ledger loaded, wrong attemptId → evidence_mismatch ──

test("adversarial round 2: attempt 1 evidence ledger loaded, evidence has wrong attemptId → evidence_mismatch", () => {
  // An attacker loads attempt 1's ledger. The evidence entries have
  // attemptId="attempt-001" but we are evaluating for attempt-002.
  // validateEvidenceObservation checks attemptId and returns false,
  // so evidenceMatchesChecklistItem returns false → evidence_mismatch.
  const result = evaluateChecklistCompletion({
    checklist: frozenChecklist(),
    verdict: verdictWithEvidenceRefs("evidence-ledger-attempt1", "EV-001"),
    evidenceLedger: attempt1Ledger(),
    executionMap: { unmappedChangedFiles: [] },
    attemptId: "attempt-002",
  });

  assert.equal(result.outcome, "evidence_mismatch",
    `expected evidence_mismatch but got ${result.outcome}: ${result.reason}`);
  assert.ok(result.mismatchedEvidenceRefs.length > 0,
    "mismatchedEvidenceRefs must be non-empty when evidence attemptId differs");
});

// ─── Test 3: Pure gate — correct attemptId but stale worktree → evidence_stale ──

test("adversarial round 2: evidence has correct attemptId but stale worktree → evidence_stale", () => {
  // The attacker replayed evidence from attempt 1 into the attempt 2 ledger,
  // updated the attemptId to match, but forgot to update the worktree head.
  // The evidence matches the checklist item (correct attemptId, method, etc.)
  // but the worktreeHead differs from the ledger's finalWorktree → evidence_stale.
  const result = evaluateChecklistCompletion({
    checklist: frozenChecklist(),
    verdict: verdictWithEvidenceRefs("evidence-ledger-attempt2", "EV-001"),
    evidenceLedger: attempt2LedgerWithStaleEvidence(),
    executionMap: { unmappedChangedFiles: [] },
    attemptId: "attempt-002",
  });

  assert.equal(result.outcome, "evidence_stale",
    `expected evidence_stale but got ${result.outcome}: ${result.reason}`);
  assert.ok(result.staleEvidenceRefs.length > 0,
    "staleEvidenceRefs must be non-empty when evidence worktree differs");
  assert.equal(result.staleEvidenceRefs[0].evidenceId, "EV-001");
});

// ─── Test 4: Full completion gate — stale worktree evidence ──────────────

test("adversarial round 2: completion gate rejects stale worktree evidence", () => {
  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    checklist: frozenChecklist(),
    checklistVerdict: verdictWithEvidenceRefs("evidence-ledger-attempt2", "EV-001"),
    evidenceLedger: attempt2LedgerWithStaleEvidence(),
    executionMap: { unmappedChangedFiles: [] },
    attemptId: "attempt-002",
  });

  assert.equal(result.outcome, "evidence_stale",
    `completion gate must yield evidence_stale, got: ${result.outcome} — ${result.reason}`);
  assert.ok(result.details.checklist.staleEvidenceRefs.length > 0);
});

// ─── Test 5: Full completion gate — missing evidence ──────────────────────

test("adversarial round 2: completion gate rejects when evidence ledger is empty", () => {
  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    checklist: frozenChecklist(),
    checklistVerdict: verdictWithEvidenceRefs("evidence-ledger-attempt1", "EV-001"),
    evidenceLedger: attempt2Ledger(),
    executionMap: { unmappedChangedFiles: [] },
    attemptId: "attempt-002",
  });

  assert.equal(result.outcome, "evidence_missing",
    `completion gate must yield evidence_missing, got: ${result.outcome} — ${result.reason}`);
  assert.ok(result.details.checklist.missingEvidenceRefs.length > 0);
});

// ─── Test 6: Full completion gate — mismatched attemptId ──────────────────

test("adversarial round 2: completion gate rejects evidence with wrong attemptId", () => {
  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    checklist: frozenChecklist(),
    checklistVerdict: verdictWithEvidenceRefs("evidence-ledger-attempt1", "EV-001"),
    evidenceLedger: attempt1Ledger(),
    executionMap: { unmappedChangedFiles: [] },
    attemptId: "attempt-002",
  });

  assert.equal(result.outcome, "evidence_mismatch",
    `completion gate must yield evidence_mismatch (wrong attemptId), got: ${result.outcome} — ${result.reason}`);
  assert.ok(result.details.checklist.mismatchedEvidenceRefs.length > 0);
});

// ─── Test 7: Integration — readActiveChecklistArtifacts fails closed on attempt mismatch ──

test("adversarial round 2: readActiveChecklistArtifacts fails closed when no artifact matches attemptId", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round2");
  const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
  const outputs = path.join(dataRoot, "wiki", "outputs");
  await mkdir(outputs, { recursive: true });

  // Write attempt 1's evidence ledger to disk
  await writeFile(
    path.join(outputs, "evidence-ledger-001.md"),
    JSON.stringify(attempt1Ledger(), null, 2),
    "utf8",
  );

  // Register it as belonging to attempt-001
  await appendEvent(cpbRoot, "flow", "job-stale", {
    type: "artifact_created",
    jobId: "job-stale",
    project: "flow",
    phase: "verify",
    kind: "evidence-ledger",
    artifactKind: "evidence-ledger",
    artifact: "evidence-ledger-001",
    artifactId: "001",
    attemptId: "attempt-001",
    ts: "2026-06-13T00:00:00Z",
  }, { dataRoot });

  // Query for attempt-002 artifacts — only attempt-001 exists
  const artifactIndex = await buildArtifactIndex(cpbRoot, "flow", "job-stale", { dataRoot });
  const artifacts = await readActiveChecklistArtifacts({
    artifactIndex,
    attemptId: "attempt-002",
    requiredKinds: ["evidence-ledger"],
  });

  // Fail-closed: when no artifact matches the requested attemptId,
  // readActiveChecklistArtifacts returns ok=false with artifact_invalid
  // instead of silently falling back to a stale artifact.
  assert.equal(artifacts.ok, false,
    "readActiveChecklistArtifacts must return ok=false when attemptId has no match");
  assert.equal(artifacts.outcome, "artifact_invalid",
    `expected artifact_invalid, got: ${artifacts.outcome}`);
  assert.ok(artifacts.reason.includes("attempt-002"),
    `reason must mention the missing attemptId: ${artifacts.reason}`);
});

// ─── Test 8: Multi-item checklist — mixed missing and stale evidence ──────

test("adversarial round 2: multi-item checklist with stale and missing evidence", () => {
  const checklist = frozenChecklist([
    defaultItem({ id: "AC-001", predicateId: "PRED-001" }),
    defaultItem({ id: "AC-002", predicateId: "PRED-002", verificationMethod: "static" }),
  ]);

  // Attempt 2 ledger has stale evidence for AC-001, no evidence for AC-002
  const ledger = {
    schemaVersion: 1,
    jobId: "job-stale",
    project: "flow",
    ledgerId: "evidence-ledger-attempt2",
    attemptId: "attempt-002",
    finalWorktree: { head: "bbb222", diffHash: "sha256:attempt2" },
    evidence: [
      {
        id: "EV-001",
        type: "evidence_claim",
        observationType: "command",
        checklistId: "AC-001",
        attemptId: "attempt-002",
        verificationMethod: "command",
        predicateId: "PRED-001",
        probeId: "probe-status-json",
        result: "pass",
        command: "npm test",
        exitCode: 0,
        cwd: "/repo/work",
        stdoutSha256: "sha256:stdout",
        summary: "passed",
        worktreeHead: "aaa111", // stale
        diffHash: "sha256:attempt1", // stale
      },
    ],
  };

  const verdict = {
    schemaVersion: 1,
    jobId: "job-stale",
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "evidence-ledger-attempt2", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
      {
        checklistId: "AC-002",
        result: "pass",
        evidenceRefs: [{ ledgerId: "evidence-ledger-attempt2", evidenceId: "EV-002" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
    ],
    blocking: [],
    fixScope: [],
    reason: "passed",
  };

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    attemptId: "attempt-002",
  });

  // EV-001 exists but worktree is stale; EV-002 is absent.
  // Gate checks: missing before stale. So outcome is evidence_missing.
  assert.equal(result.outcome, "evidence_missing",
    `expected evidence_missing, got: ${result.outcome}`);
  assert.ok(result.missingEvidenceRefs.some((r: AnyRecord) => r.evidenceId === "EV-002"),
    "EV-002 should be in missingEvidenceRefs");
  // EV-001 should appear in staleEvidenceRefs (it was found but stale)
  assert.ok(result.staleEvidenceRefs.some((r: AnyRecord) => r.evidenceId === "EV-001"),
    "EV-001 should be in staleEvidenceRefs");
});

// ─── Test 9: Positive — same worktree head across attempts is NOT stale ──

test("adversarial round 2: evidence with matching worktree head is NOT stale", () => {
  // A re-verify without code changes: evidence matches the active worktree.
  const ledger = {
    schemaVersion: 1,
    jobId: "job-stale",
    project: "flow",
    ledgerId: "evidence-ledger-attempt2",
    attemptId: "attempt-002",
    finalWorktree: { head: "bbb222", diffHash: "sha256:attempt2" },
    evidence: [{
      id: "EV-001",
      type: "evidence_claim",
      observationType: "command",
      checklistId: "AC-001",
      attemptId: "attempt-002",
      verificationMethod: "command",
      predicateId: "PRED-001",
      probeId: "probe-status-json",
      result: "pass",
      command: "npm test",
      exitCode: 0,
      cwd: "/repo/work",
      stdoutSha256: "sha256:stdout",
      summary: "passed",
      worktreeHead: "bbb222",       // matches finalWorktree.head
      diffHash: "sha256:attempt2",  // matches finalWorktree.diffHash
    }],
  };

  const result = evaluateChecklistCompletion({
    checklist: frozenChecklist(),
    verdict: verdictWithEvidenceRefs("evidence-ledger-attempt2", "EV-001"),
    evidenceLedger: ledger,
    executionMap: { unmappedChangedFiles: [] },
    attemptId: "attempt-002",
  });

  assert.equal(result.outcome, "complete",
    `matching worktree should not be stale, got: ${result.outcome} — ${result.reason}`);
});
