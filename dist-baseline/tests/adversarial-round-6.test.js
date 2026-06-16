/**
 * Adversarial Round 6: Runtime context cannot be used as pass evidence
 * for command/static checklist items.
 *
 * Scenario: A checklist item requires verificationMethod: "command"
 * (meaning: evidence must prove a command ran and exited 0 with a
 * stdout hash).  An attacker (or buggy bridge) submits an evidence
 * ledger whose entry claims result: "pass" and verificationMethod:
 * "command", but whose observation fields are runtime-context data
 * (worker heartbeat, eventType, workerId, assignmentId, observedAt)
 * instead of command output (command, exitCode, stdoutSha256).
 *
 * The validateCommandObservation function requires command text,
 * integer exitCode === 0, and stdoutSha256.  Runtime context fields
 * provide none of these, so the evidence does NOT match the checklist
 * item.  evaluateChecklistCompletion must classify this as
 * evidence_mismatch.
 *
 * Variants tested:
 *   1. Pure gate — command item + runtime-context evidence → evidence_mismatch
 *   2. Pure gate — command item + evidence that has exitCode=0 but no command
 *      text → still evidence_mismatch
 *   3. Pure gate — static item + runtime-context evidence → evidence_mismatch
 *   4. Mixed: one item passes (real command evidence), one item fails
 *      (runtime context) → evidence_mismatch
 *   5. Runtime-context evidence with verificationMethod mismatch at
 *      the base level (entry says "runtime_event" but checklist says
 *      "command") → evidence_mismatch via base match failure
 *   6. Worker heartbeat evidence against a test-method checklist item
 *      → evidence_mismatch
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCompletionGate } from "../core/engine/completion-gate.js";
import { evaluateChecklistCompletion, } from "../core/workflow/acceptance-checklist.js";
import { validateEvidenceObservation, } from "../core/workflow/evidence-probes.js";
// ─── Shared fixtures ──────────────────────────────────────────────────────
function checklistWithCommandItem() {
    return {
        schemaVersion: 1,
        jobId: "job-r6",
        project: "flow",
        status: "frozen",
        source: { task: "add dark mode", issue: null, documents: [] },
        items: [
            {
                id: "AC-001",
                requirement: "Unit tests pass",
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
function checklistWithStaticItem() {
    return {
        schemaVersion: 1,
        jobId: "job-r6",
        project: "flow",
        status: "frozen",
        source: { task: "type safety", issue: null, documents: [] },
        items: [
            {
                id: "AC-002",
                requirement: "No any types in production code",
                source: "user_task",
                sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
                predicateId: "PRED-002",
                required: true,
                area: "cli",
                risk: "medium",
                verificationMethod: "static",
                expectedEvidence: "grep -c ': any' src/**/*.ts returns 0",
                dependsOn: [],
                allowedFiles: ["src/"],
            },
        ],
        assumptions: [],
    };
}
function checklistWithTestItem() {
    return {
        schemaVersion: 1,
        jobId: "job-r6",
        project: "flow",
        status: "frozen",
        source: { task: "integration tests", issue: null, documents: [] },
        items: [
            {
                id: "AC-003",
                requirement: "Integration tests pass",
                source: "user_task",
                sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
                predicateId: "PRED-003",
                required: true,
                area: "cli",
                risk: "high",
                verificationMethod: "test",
                expectedEvidence: "npm run test:integration exit 0",
                dependsOn: [],
                allowedFiles: ["tests/"],
            },
        ],
        assumptions: [],
    };
}
function checklistWithMixedItems() {
    return {
        schemaVersion: 1,
        jobId: "job-r6",
        project: "flow",
        status: "frozen",
        source: { task: "add dark mode with tests", issue: null, documents: [] },
        items: [
            {
                id: "AC-001",
                requirement: "Unit tests pass",
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
                id: "AC-004",
                requirement: "Build succeeds",
                source: "user_task",
                sourceRefs: [{ kind: "task_text", locator: "task:1", sha256: "sha256:task2" }],
                predicateId: "PRED-004",
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
/** Evidence entry that contains worker-heartbeat-style runtime context. */
function workerHeartbeatEvidence() {
    return {
        id: "EV-HEARTBEAT",
        type: "evidence_claim",
        observationType: "command", // liar: claims to be command
        checklistId: "AC-001",
        attemptId: "attempt-r6",
        verificationMethod: "command", // matches checklist
        predicateId: "PRED-001", // matches checklist
        probeId: "probe-heartbeat",
        result: "pass", // claims pass
        // ── But the observation fields are runtime context, NOT command output ──
        eventType: "worker_heartbeat",
        workerId: "worker-01",
        assignmentId: "assign-42",
        observedAt: "2026-06-13T00:05:00.000Z",
        lastActivityAt: "2026-06-13T00:04:58.000Z",
        leaseId: "lease-abc",
        // Missing: command, exitCode, stdoutSha256
        worktreeHead: "ddd444",
        diffHash: "sha256:r6",
    };
}
/** Evidence entry with exitCode=0 but no command text — still invalid for command method. */
function exitCodeOnlyEvidence() {
    return {
        id: "EV-EXITCODE-ONLY",
        type: "evidence_claim",
        observationType: "command",
        checklistId: "AC-001",
        attemptId: "attempt-r6",
        verificationMethod: "command",
        predicateId: "PRED-001",
        probeId: "probe-exitcode",
        result: "pass",
        // Has exitCode but no command text or stdout hash
        exitCode: 0,
        // Missing: command, stdoutSha256
        worktreeHead: "ddd444",
        diffHash: "sha256:r6",
    };
}
/** Proper command evidence that WOULD pass validateCommandObservation.
 * Spec-compliant: command identity + cwd/repo root + integer exitCode === 0 +
 * output digest + worktree identity. cwd + worktreeHead are required so the
 * positive control passes for the RIGHT reason (not the old loose rule). */
function validCommandEvidence(checklistId = "AC-001", predId = "PRED-001", evId = "EV-VALID") {
    return {
        id: evId,
        type: "evidence_claim",
        observationType: "command",
        checklistId,
        attemptId: "attempt-r6",
        verificationMethod: "command",
        predicateId: predId,
        probeId: "probe-valid",
        result: "pass",
        command: "npm test",
        exitCode: 0,
        stdoutSha256: "sha256:valid-stdout",
        cwd: "/repo/flow", // spec: command must declare WHERE it ran
        worktreeHead: "ddd444", // spec: result must tie to the declared worktree
        diffHash: "sha256:r6",
    };
}
/** Runtime context evidence targeting the static checklist item. */
function runtimeContextForStaticItem() {
    return {
        id: "EV-STATIC-RUNTIME",
        type: "evidence_claim",
        observationType: "static",
        checklistId: "AC-002",
        attemptId: "attempt-r6",
        verificationMethod: "static",
        predicateId: "PRED-002",
        probeId: "probe-static-runtime",
        result: "pass",
        // Runtime context fields instead of static analysis fields
        eventType: "worker_heartbeat",
        workerId: "worker-01",
        assignmentId: "assign-99",
        observedAt: "2026-06-13T00:05:00.000Z",
        // Missing: the fields validateStaticObservation requires
        worktreeHead: "ddd444",
        diffHash: "sha256:r6",
    };
}
/** Verdict claiming all items passed with runtime-context evidence. */
function passingVerdictWithRuntimeEvidence(checklistId = "AC-001", evId = "EV-HEARTBEAT", ledgerId = "evidence-ledger-r6") {
    return {
        schemaVersion: 1,
        jobId: "job-r6",
        status: "pass",
        items: [
            {
                checklistId,
                result: "pass",
                evidenceRefs: [{ ledgerId, evidenceId: evId }],
                actualResult: "worker heartbeat received",
                reason: "ok",
            },
        ],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
}
function evidenceLedger(evidence, ledgerId = "evidence-ledger-r6") {
    return {
        schemaVersion: 1,
        jobId: "job-r6",
        project: "flow",
        ledgerId,
        attemptId: "attempt-r6",
        finalWorktree: { head: "ddd444", diffHash: "sha256:r6" },
        evidence,
    };
}
function executionMap() {
    return { unmappedChangedFiles: [] };
}
// ─── Test 1: Pure gate — command item + worker heartbeat evidence → evidence_mismatch ──
test("adversarial round 6: command checklist item rejects worker heartbeat evidence (evidence_mismatch)", () => {
    const checklist = checklistWithCommandItem();
    const ledger = evidenceLedger([workerHeartbeatEvidence()]);
    const verdict = passingVerdictWithRuntimeEvidence();
    const result = evaluateChecklistCompletion({
        checklist,
        verdict,
        evidenceLedger: ledger,
        executionMap: executionMap(),
        runtimeFailures: [],
        attemptId: "attempt-r6",
    });
    assert.strictEqual(result.outcome, "evidence_mismatch", `expected evidence_mismatch but got ${result.outcome}: ${result.reason}`);
    assert.ok(result.mismatchedEvidenceRefs.length > 0, "mismatchedEvidenceRefs must contain the heartbeat evidence ref");
});
// ─── Test 2: Pure gate — command item + exitCode-only evidence → evidence_mismatch ──
test("adversarial round 6: command checklist item rejects exitCode-only evidence (missing command text)", () => {
    const checklist = checklistWithCommandItem();
    const ledger = evidenceLedger([exitCodeOnlyEvidence()]);
    const verdict = passingVerdictWithRuntimeEvidence("AC-001", "EV-EXITCODE-ONLY");
    const result = evaluateChecklistCompletion({
        checklist,
        verdict,
        evidenceLedger: ledger,
        executionMap: executionMap(),
        runtimeFailures: [],
        attemptId: "attempt-r6",
    });
    assert.strictEqual(result.outcome, "evidence_mismatch", `expected evidence_mismatch but got ${result.outcome}: ${result.reason}`);
});
// ─── Test 3: Pure gate — static item + runtime context evidence → evidence_mismatch ──
test("adversarial round 6: static checklist item rejects runtime context evidence (evidence_mismatch)", () => {
    const checklist = checklistWithStaticItem();
    const ledger = evidenceLedger([runtimeContextForStaticItem()]);
    const verdict = passingVerdictWithRuntimeEvidence("AC-002", "EV-STATIC-RUNTIME");
    const result = evaluateChecklistCompletion({
        checklist,
        verdict,
        evidenceLedger: ledger,
        executionMap: executionMap(),
        runtimeFailures: [],
        attemptId: "attempt-r6",
    });
    assert.strictEqual(result.outcome, "evidence_mismatch", `expected evidence_mismatch but got ${result.outcome}: ${result.reason}`);
});
// ─── Test 4: Mixed items — one real command evidence, one runtime context → evidence_mismatch ──
test("adversarial round 6: mixed checklist — valid command evidence + runtime context → evidence_mismatch", () => {
    const checklist = checklistWithMixedItems();
    const ledger = evidenceLedger([
        validCommandEvidence("AC-001", "PRED-001", "EV-VALID-1"),
        workerHeartbeatEvidence(), // targets AC-001 — will be the mismatch
    ]);
    // Verdict claims AC-004 passed with runtime evidence, but heartbeat targets AC-001
    // Let's build a proper mixed verdict: AC-001 with real evidence, AC-004 with heartbeat
    const heartbeatForBuild = {
        ...workerHeartbeatEvidence(),
        id: "EV-HEARTBEAT-BUILD",
        checklistId: "AC-004",
        predicateId: "PRED-004",
    };
    const ledger2 = evidenceLedger([
        validCommandEvidence("AC-001", "PRED-001", "EV-VALID-1"),
        heartbeatForBuild,
    ]);
    const mixedVerdict = {
        schemaVersion: 1,
        jobId: "job-r6",
        status: "pass",
        items: [
            {
                checklistId: "AC-001",
                result: "pass",
                evidenceRefs: [{ ledgerId: "evidence-ledger-r6", evidenceId: "EV-VALID-1" }],
                actualResult: "all tests pass",
                reason: "ok",
            },
            {
                checklistId: "AC-004",
                result: "pass",
                evidenceRefs: [{ ledgerId: "evidence-ledger-r6", evidenceId: "EV-HEARTBEAT-BUILD" }],
                actualResult: "worker heartbeat received",
                reason: "ok",
            },
        ],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const result = evaluateChecklistCompletion({
        checklist,
        verdict: mixedVerdict,
        evidenceLedger: ledger2,
        executionMap: executionMap(),
        runtimeFailures: [],
        attemptId: "attempt-r6",
    });
    assert.strictEqual(result.outcome, "evidence_mismatch", `expected evidence_mismatch but got ${result.outcome}: ${result.reason}`);
    // Only the heartbeat evidence should be mismatched
    assert.strictEqual(result.mismatchedEvidenceRefs.length, 1, "exactly one evidence ref should be mismatched");
});
// ─── Test 5: Base-level verificationMethod mismatch ──
test("adversarial round 6: evidence with verificationMethod runtime_event cannot satisfy command checklist item", () => {
    // The evidence claims verificationMethod "runtime_event" while the checklist
    // requires "command". The base match in evidenceMatchesChecklistItem checks
    // entry.verificationMethod === checklistItem.verificationMethod, so this
    // fails at the base match level.
    const runtimeEventEvidence = {
        id: "EV-RUNTIME-EVENT",
        type: "evidence_claim",
        observationType: "runtime_event",
        checklistId: "AC-001",
        attemptId: "attempt-r6",
        verificationMethod: "runtime_event", // does NOT match checklist's "command"
        predicateId: "PRED-001",
        probeId: "probe-runtime",
        result: "pass",
        eventType: "phase_completed",
        eventId: "evt-123",
        observedAt: "2026-06-13T00:05:00.000Z",
        worktreeHead: "ddd444",
        diffHash: "sha256:r6",
    };
    const checklist = checklistWithCommandItem();
    const ledger = evidenceLedger([runtimeEventEvidence]);
    const verdict = passingVerdictWithRuntimeEvidence("AC-001", "EV-RUNTIME-EVENT");
    const result = evaluateChecklistCompletion({
        checklist,
        verdict,
        evidenceLedger: ledger,
        executionMap: executionMap(),
        runtimeFailures: [],
        attemptId: "attempt-r6",
    });
    assert.strictEqual(result.outcome, "evidence_mismatch", `expected evidence_mismatch but got ${result.outcome}: ${result.reason}`);
});
// ─── Test 6: Worker heartbeat against test-method checklist item ──
test("adversarial round 6: worker heartbeat evidence cannot satisfy test-method checklist item", () => {
    const heartbeatForTest = {
        ...workerHeartbeatEvidence(),
        id: "EV-HEARTBEAT-TEST",
        checklistId: "AC-003",
        predicateId: "PRED-003",
    };
    const checklist = checklistWithTestItem();
    const ledger = evidenceLedger([heartbeatForTest]);
    const verdict = passingVerdictWithRuntimeEvidence("AC-003", "EV-HEARTBEAT-TEST");
    const result = evaluateChecklistCompletion({
        checklist,
        verdict,
        evidenceLedger: ledger,
        executionMap: executionMap(),
        runtimeFailures: [],
        attemptId: "attempt-r6",
    });
    assert.strictEqual(result.outcome, "evidence_mismatch", `expected evidence_mismatch but got ${result.outcome}: ${result.reason}`);
});
// ─── Test 7: validateEvidenceObservation directly — runtime context does not pass command validation ──
test("adversarial round 6: validateEvidenceObservation rejects runtime context for command method", () => {
    const checklistItem = checklistWithCommandItem().items[0];
    const entry = workerHeartbeatEvidence();
    // Direct call: should not be valid (record-gate) nor satisfied (result-gate)
    const result = validateEvidenceObservation(entry, checklistItem, {
        attemptId: "attempt-r6",
        finalWorktree: { head: "ddd444", diffHash: "sha256:r6" },
    });
    assert.strictEqual(result.valid, false, "validateEvidenceObservation must reject runtime context for command method");
    assert.strictEqual(result.satisfied, false, "validateEvidenceObservation must not be satisfied for runtime context for command method");
});
// ─── Test 8: validateEvidenceObservation — exitCode-only also fails ──
test("adversarial round 6: validateEvidenceObservation rejects exitCode-only (no command text) for command method", () => {
    const checklistItem = checklistWithCommandItem().items[0];
    const entry = exitCodeOnlyEvidence();
    const result = validateEvidenceObservation(entry, checklistItem, {
        attemptId: "attempt-r6",
        finalWorktree: { head: "ddd444", diffHash: "sha256:r6" },
    });
    assert.strictEqual(result.valid, false, "validateEvidenceObservation must reject exitCode-only for command method (missing command text)");
    assert.strictEqual(result.satisfied, false, "validateEvidenceObservation must not be satisfied for exitCode-only for command method");
});
// ─── Test 9: Full completion gate — runtime context evidence causes evidence_mismatch gate result ──
test("adversarial round 6: full completion gate rejects job with runtime context evidence", () => {
    const checklist = checklistWithCommandItem();
    const ledger = evidenceLedger([workerHeartbeatEvidence()]);
    const verdict = passingVerdictWithRuntimeEvidence();
    const result = evaluateCompletionGate({
        job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
        workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
        parsedVerdict: { status: "pass", raw: "PASS" },
        checklist,
        checklistVerdict: verdict,
        evidenceLedger: ledger,
        executionMap: executionMap(),
        attemptId: "attempt-r6",
    });
    assert.strictEqual(result.outcome, "evidence_mismatch", `completion gate must return evidence_mismatch but got ${result.outcome}: ${result.reason}`);
    assert.strictEqual(result.missingGates[0], "checklist", "missing gates must include 'checklist'");
});
// ─── Test 10: Valid command evidence DOES pass (positive control) ──
test("adversarial round 6: valid command evidence passes (positive control)", () => {
    const checklist = checklistWithCommandItem();
    const ledger = evidenceLedger([validCommandEvidence()]);
    const verdict = passingVerdictWithRuntimeEvidence("AC-001", "EV-VALID");
    const result = evaluateChecklistCompletion({
        checklist,
        verdict,
        evidenceLedger: ledger,
        executionMap: executionMap(),
        runtimeFailures: [],
        attemptId: "attempt-r6",
    });
    assert.strictEqual(result.outcome, "complete", `positive control: valid command evidence must pass, got ${result.outcome}: ${result.reason}`);
});
