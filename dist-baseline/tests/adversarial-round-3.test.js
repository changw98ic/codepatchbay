/**
 * Adversarial Round 3: Verifier cannot invent evidence IDs not in the
 * predeclared ledger.
 *
 * The checklist verdict cites evidence IDs that do not exist in the evidence
 * ledger. This is the "invented evidence" attack: a compromised verifier
 * fabricates EV IDs (e.g. EV-999) that were never produced by the observation
 * phase. The completion gate MUST reject with evidence_missing.
 *
 * Attack vectors tested:
 *   1. Pure checklist: verdict references EV-999 (invented) → evidence_missing
 *   2. Pure gate: completion gate with invented evidence → evidence_missing
 *   3. Mixed: some real EV IDs, one fabricated → evidence_missing for the fake
 *   4. Edge case: verdict references EV-000 (zero-index, never produced)
 *   5. Edge case: verdict references an empty string evidence ID
 *   6. Positive control: verdict with only legitimate EV IDs → complete
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCompletionGate } from "../core/engine/completion-gate.js";
import { evaluateChecklistCompletion } from "../core/workflow/acceptance-checklist.js";
// ─── Shared fixtures ──────────────────────────────────────────────────────
function frozenChecklist(items = [defaultItem()]) {
    return {
        schemaVersion: 1,
        jobId: "job-invented",
        project: "flow",
        status: "frozen",
        source: { task: "task", issue: null, documents: [] },
        items,
        assumptions: [],
    };
}
function defaultItem(overrides = {}) {
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
/** A legitimate evidence ledger with two real evidence entries. */
function legitimateLedger() {
    return {
        schemaVersion: 1,
        jobId: "job-invented",
        project: "flow",
        ledgerId: "evidence-ledger-legit",
        attemptId: "attempt-001",
        finalWorktree: { head: "abc123", diffHash: "sha256:legit" },
        evidence: [
            {
                id: "EV-001",
                type: "evidence_claim",
                observationType: "command",
                checklistId: "AC-001",
                attemptId: "attempt-001",
                verificationMethod: "command",
                predicateId: "PRED-001",
                probeId: "probe-test",
                result: "pass",
                command: "npm test",
                exitCode: 0,
                stdoutSha256: "sha256:stdout-1",
                cwd: "/repo/flow",
                summary: "passed",
                worktreeHead: "abc123",
                diffHash: "sha256:legit",
            },
            {
                id: "EV-002",
                type: "evidence_claim",
                observationType: "static",
                checklistId: "AC-002",
                attemptId: "attempt-001",
                verificationMethod: "static",
                predicateId: "PRED-002",
                probeId: "probe-lint",
                result: "pass",
                command: "npm run lint",
                exitCode: 0,
                stdoutSha256: "sha256:stdout-2",
                summary: "linted",
                worktreeHead: "abc123",
                diffHash: "sha256:legit",
            },
        ],
    };
}
function verdictWithEvidence(evidenceId, ledgerId = "evidence-ledger-legit") {
    return {
        schemaVersion: 1,
        jobId: "job-invented",
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
function multiItemVerdict(refs) {
    return {
        schemaVersion: 1,
        jobId: "job-invented",
        status: "pass",
        items: refs.map((ref, i) => ({
            checklistId: `AC-00${i + 1}`,
            result: "pass",
            evidenceRefs: [ref],
            actualResult: "ok",
            reason: "ok",
            fixScope: [],
        })),
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
}
// ─── Test 1: Pure checklist — EV-999 invented → evidence_missing ──────────
test("adversarial round 3: verdict cites invented EV-999 → evidence_missing", () => {
    const result = evaluateChecklistCompletion({
        checklist: frozenChecklist(),
        verdict: verdictWithEvidence("EV-999"),
        evidenceLedger: legitimateLedger(),
        executionMap: { unmappedChangedFiles: [] },
        attemptId: "attempt-001",
    });
    assert.equal(result.outcome, "evidence_missing", `expected evidence_missing but got ${result.outcome}: ${result.reason}`);
    assert.ok(result.missingEvidenceRefs.length > 0, "missingEvidenceRefs must be non-empty when verdict cites an invented EV ID");
    assert.equal(result.missingEvidenceRefs[0].evidenceId, "EV-999", "the invented EV-999 must appear in missingEvidenceRefs");
});
// ─── Test 2: Full completion gate — invented EV-999 → evidence_missing ────
test("adversarial round 3: completion gate rejects verdict with invented EV-999", () => {
    const result = evaluateCompletionGate({
        job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
        workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
        parsedVerdict: { status: "pass", raw: "PASS" },
        checklist: frozenChecklist(),
        checklistVerdict: verdictWithEvidence("EV-999"),
        evidenceLedger: legitimateLedger(),
        executionMap: { unmappedChangedFiles: [] },
        attemptId: "attempt-001",
    });
    assert.equal(result.outcome, "evidence_missing", `completion gate must yield evidence_missing for invented EV ID, got: ${result.outcome} — ${result.reason}`);
    assert.ok(result.details.checklist.missingEvidenceRefs.length > 0);
    assert.equal(result.details.checklist.missingEvidenceRefs[0].evidenceId, "EV-999");
});
// ─── Test 3: Mixed — one real EV ID, one fabricated → evidence_missing ────
test("adversarial round 3: mixed real and fabricated evidence → evidence_missing for the fake", () => {
    const checklist = frozenChecklist([
        defaultItem({ id: "AC-001", predicateId: "PRED-001" }),
        defaultItem({ id: "AC-002", predicateId: "PRED-002", verificationMethod: "static" }),
    ]);
    // AC-001 cites real EV-001, AC-002 cites fabricated EV-999
    const verdict = multiItemVerdict([
        { ledgerId: "evidence-ledger-legit", evidenceId: "EV-001" },
        { ledgerId: "evidence-ledger-legit", evidenceId: "EV-999" },
    ]);
    const result = evaluateChecklistCompletion({
        checklist,
        verdict,
        evidenceLedger: legitimateLedger(),
        executionMap: { unmappedChangedFiles: [] },
        attemptId: "attempt-001",
    });
    assert.equal(result.outcome, "evidence_missing", `expected evidence_missing for mixed case, got: ${result.outcome}`);
    assert.ok(result.missingEvidenceRefs.some((r) => r.evidenceId === "EV-999"), "EV-999 must appear in missingEvidenceRefs");
    // EV-001 should NOT be in missingEvidenceRefs — it exists in the ledger
    assert.ok(!result.missingEvidenceRefs.some((r) => r.evidenceId === "EV-001"), "EV-001 must NOT appear in missingEvidenceRefs");
});
// ─── Test 4: Edge case — EV-000 (zero-index, never produced) ──────────────
test("adversarial round 3: verdict cites EV-000 (zero-index) → evidence_missing", () => {
    const result = evaluateChecklistCompletion({
        checklist: frozenChecklist(),
        verdict: verdictWithEvidence("EV-000"),
        evidenceLedger: legitimateLedger(),
        executionMap: { unmappedChangedFiles: [] },
        attemptId: "attempt-001",
    });
    assert.equal(result.outcome, "evidence_missing", `EV-000 is not in ledger, expected evidence_missing, got: ${result.outcome}`);
    assert.equal(result.missingEvidenceRefs[0].evidenceId, "EV-000");
});
// ─── Test 5: Edge case — empty string evidence ID ─────────────────────────
test("adversarial round 3: verdict cites empty string evidence ID → evidence_missing", () => {
    const result = evaluateChecklistCompletion({
        checklist: frozenChecklist(),
        verdict: verdictWithEvidence(""),
        evidenceLedger: legitimateLedger(),
        executionMap: { unmappedChangedFiles: [] },
        attemptId: "attempt-001",
    });
    assert.equal(result.outcome, "evidence_missing", `empty evidence ID should be missing, got: ${result.outcome}`);
    assert.equal(result.missingEvidenceRefs[0].evidenceId, "");
});
// ─── Test 6: Edge case — verdict references wrong ledger ID ───────────────
test("adversarial round 3: verdict references non-existent ledger ID → evidence_missing", () => {
    // The verdict claims evidence from "evidence-ledger-fabricated" which
    // doesn't match any ledger passed to the evaluator.
    const result = evaluateChecklistCompletion({
        checklist: frozenChecklist(),
        verdict: verdictWithEvidence("EV-001", "evidence-ledger-fabricated"),
        evidenceLedger: legitimateLedger(),
        executionMap: { unmappedChangedFiles: [] },
        attemptId: "attempt-001",
    });
    assert.equal(result.outcome, "evidence_missing", `wrong ledger ID means the key lookup fails, expected evidence_missing, got: ${result.outcome}`);
    assert.equal(result.missingEvidenceRefs[0].evidenceId, "EV-001");
    assert.equal(result.missingEvidenceRefs[0].ledgerId, "evidence-ledger-fabricated");
});
// ─── Test 7: Positive control — only legitimate EV IDs → complete ─────────
test("adversarial round 3: positive control — legitimate EV IDs → complete", () => {
    const result = evaluateChecklistCompletion({
        checklist: frozenChecklist(),
        verdict: verdictWithEvidence("EV-001"),
        evidenceLedger: legitimateLedger(),
        executionMap: { unmappedChangedFiles: [] },
        attemptId: "attempt-001",
    });
    assert.equal(result.outcome, "complete", `legitimate evidence must produce complete, got: ${result.outcome} — ${result.reason}`);
    assert.equal(result.missingEvidenceRefs.length, 0, "no missing evidence refs for legitimate verdict");
});
// ─── Test 8: Large fabricated ID — EV-999999 ──────────────────────────────
test("adversarial round 3: verdict cites EV-999999 (absurdly high) → evidence_missing", () => {
    const result = evaluateChecklistCompletion({
        checklist: frozenChecklist(),
        verdict: verdictWithEvidence("EV-999999"),
        evidenceLedger: legitimateLedger(),
        executionMap: { unmappedChangedFiles: [] },
        attemptId: "attempt-001",
    });
    assert.equal(result.outcome, "evidence_missing", `expected evidence_missing for EV-999999, got: ${result.outcome}`);
    assert.equal(result.missingEvidenceRefs[0].evidenceId, "EV-999999");
});
// ─── Test 9: No evidence entries at all in ledger, verdict cites EV-001 ───
test("adversarial round 3: empty evidence ledger, verdict cites EV-001 → evidence_missing", () => {
    const emptyLedger = {
        schemaVersion: 1,
        jobId: "job-invented",
        project: "flow",
        ledgerId: "evidence-ledger-empty",
        attemptId: "attempt-001",
        finalWorktree: { head: "abc123", diffHash: "sha256:legit" },
        evidence: [],
    };
    const result = evaluateChecklistCompletion({
        checklist: frozenChecklist(),
        verdict: verdictWithEvidence("EV-001"),
        evidenceLedger: emptyLedger,
        executionMap: { unmappedChangedFiles: [] },
        attemptId: "attempt-001",
    });
    assert.equal(result.outcome, "evidence_missing", `empty ledger means any evidence ref is missing, got: ${result.outcome}`);
});
// ─── Test 10: Verdict with multiple evidence refs, all fabricated ──────────
test("adversarial round 3: all evidence refs fabricated → all reported missing", () => {
    const checklist = frozenChecklist([
        defaultItem({ id: "AC-001", predicateId: "PRED-001" }),
        defaultItem({ id: "AC-002", predicateId: "PRED-002", verificationMethod: "static" }),
    ]);
    const verdict = multiItemVerdict([
        { ledgerId: "evidence-ledger-legit", evidenceId: "EV-998" },
        { ledgerId: "evidence-ledger-legit", evidenceId: "EV-999" },
    ]);
    const result = evaluateChecklistCompletion({
        checklist,
        verdict,
        evidenceLedger: legitimateLedger(),
        executionMap: { unmappedChangedFiles: [] },
        attemptId: "attempt-001",
    });
    assert.equal(result.outcome, "evidence_missing");
    assert.equal(result.missingEvidenceRefs.length, 2, "both fabricated EV IDs must be reported missing");
    const missingIds = result.missingEvidenceRefs.map((r) => r.evidenceId).sort();
    assert.deepEqual(missingIds, ["EV-998", "EV-999"]);
});
