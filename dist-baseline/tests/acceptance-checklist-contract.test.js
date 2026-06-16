import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRepoRelativePaths, validateAcceptanceChecklist, validateChecklistSourceCoverage, validateChecklistVerdict, evaluateChecklistCompletion, } from "../core/workflow/acceptance-checklist.js";
function checklist(overrides = {}) {
    return {
        schemaVersion: 1,
        jobId: "job-1",
        project: "flow",
        status: "frozen",
        source: { task: "add json output", issue: null, documents: [] },
        items: [
            {
                id: "AC-001",
                requirement: "cpb status supports --json",
                source: "user_task",
                sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
                predicateId: "PRED-001",
                required: true,
                area: "cli",
                risk: "medium",
                verificationMethod: "command",
                expectedEvidence: "exit 0 and JSON stdout",
                dependsOn: [],
                allowedFiles: ["cli/commands/status.ts"],
            },
        ],
        assumptions: [],
        ...overrides,
    };
}
const ledger = {
    schemaVersion: 1,
    jobId: "job-1",
    project: "flow",
    ledgerId: "evidence-ledger-001",
    attemptId: "attempt-001",
    finalWorktree: { head: "abc", diffHash: "sha256:one" },
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
            cwd: "/repo",
            stdoutSha256: "sha256:stdout",
            summary: "passed",
            worktreeHead: "abc",
            diffHash: "sha256:one",
        },
    ],
};
test("validateAcceptanceChecklist accepts a frozen required item", () => {
    assert.equal(validateAcceptanceChecklist(checklist()).ok, true);
});
test("validateAcceptanceChecklist rejects silently accepted high-risk assumptions", () => {
    const result = validateAcceptanceChecklist(checklist({
        assumptions: [{ id: "ASM-001", text: "Security behavior can change", risk: "high", acceptedForExecution: true }],
    }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /high-risk/i);
});
test("validateAcceptanceChecklist rejects assumptions that smuggle requirements", () => {
    const result = validateAcceptanceChecklist(checklist({
        assumptions: [{ id: "ASM-001", text: "Existing status output must remain unchanged", risk: "medium", acceptedForExecution: true }],
    }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /assumption/i);
});
test("validateAcceptanceChecklist rejects missing source refs and predicate ids", () => {
    const item = { ...checklist().items[0], sourceRefs: [], predicateId: "" };
    const result = validateAcceptanceChecklist(checklist({ items: [item] }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /source|predicate/i);
});
test("validateAcceptanceChecklist allows required manual items as explicit approval criteria", () => {
    const item = { ...checklist().items[0], verificationMethod: "manual", expectedEvidence: "approval artifact" };
    const result = validateAcceptanceChecklist(checklist({ items: [item] }));
    assert.equal(result.ok, true);
});
test("validateChecklistSourceCoverage rejects missing required source coverage", () => {
    const result = validateChecklistSourceCoverage({
        checklist: checklist(),
        task: "add json output and keep text output",
        requirementClassification: {
            classifiedRequirements: [
                { id: "REQ-001", locator: "task:0", acceptanceRelevant: true },
                { id: "REQ-002", locator: "task:1", acceptanceRelevant: true },
            ],
        },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not covered/i);
});
test("validateAcceptanceChecklist rejects non-normalized path fields", () => {
    const result = validateAcceptanceChecklist(checklist({
        items: [{ ...checklist().items[0], allowedFiles: ["/abs/path.ts", "../escape.ts"] }],
    }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /path/i);
});
test("validateChecklistVerdict rejects pass without evidence refs", () => {
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [], actualResult: "looks correct", reason: "not enough", fixScope: [] }],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const result = validateChecklistVerdict(verdict, checklist());
    assert.equal(result.ok, false);
    assert.match(result.reason, /evidence/i);
});
test("validateChecklistVerdict rejects top-level pass when a required item is unchecked", () => {
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [{ checklistId: "AC-001", result: "unchecked", evidenceRefs: [], actualResult: "", reason: "not run", fixScope: [] }],
        blocking: [],
        fixScope: [],
        reason: "wrong status",
    };
    const result = validateChecklistVerdict(verdict, checklist());
    assert.equal(result.ok, false);
    assert.match(result.reason, /status/i);
});
test("validateChecklistVerdict rejects duplicate item results and free-text blocking criteria", () => {
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "fail",
        items: [
            { checklistId: "AC-001", result: "unchecked", evidenceRefs: [], actualResult: "", reason: "not run", fixScope: [] },
            { checklistId: "AC-001", result: "unchecked", evidenceRefs: [], actualResult: "", reason: "duplicate", fixScope: [] },
        ],
        blocking: [{ criterion: "new verifier-authored criterion", evidence: "prose" }],
        fixScope: [],
        reason: "wrong shape",
    };
    const result = validateChecklistVerdict(verdict, checklist());
    assert.equal(result.ok, false);
});
test("normalizeRepoRelativePaths strips porcelain status and rejects unsafe paths", () => {
    assert.deepEqual(normalizeRepoRelativePaths([" M cli/status.ts", "?? tests/status.test.ts", "cli/status.ts"]), [
        "cli/status.ts",
        "tests/status.test.ts",
    ]);
    assert.throws(() => normalizeRepoRelativePaths(["/abs.ts"]));
    assert.throws(() => normalizeRepoRelativePaths(["../escape.ts"]));
    assert.throws(() => normalizeRepoRelativePaths(["dir\\file.ts"]));
});
test("evaluateChecklistCompletion blocks stale evidence", () => {
    const staleLedger = {
        ...ledger,
        evidence: [{ ...ledger.evidence[0], diffHash: "sha256:old" }],
    };
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [
            {
                checklistId: "AC-001",
                result: "pass",
                evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }],
                actualResult: "ok",
                reason: "ok",
                fixScope: [],
            },
        ],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const result = evaluateChecklistCompletion({ checklist: checklist(), verdict, evidenceLedger: staleLedger, executionMap: { unmappedChangedFiles: [] } });
    assert.equal(result.outcome, "evidence_stale");
    assert.deepEqual(result.staleEvidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
});
test("evaluateChecklistCompletion blocks missing evidence refs", () => {
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-missing" }], actualResult: "ok", reason: "ok", fixScope: [] }],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const result = evaluateChecklistCompletion({ checklist: checklist(), verdict, evidenceLedger: ledger, executionMap: { unmappedChangedFiles: [] } });
    assert.equal(result.outcome, "evidence_missing");
});
test("evaluateChecklistCompletion rejects unrelated fresh evidence claims", () => {
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "ok", reason: "ok", fixScope: [] }],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const unrelatedLedger = { ...ledger, evidence: [{ ...ledger.evidence[0], checklistId: "AC-OTHER" }] };
    const result = evaluateChecklistCompletion({ checklist: checklist(), verdict, evidenceLedger: unrelatedLedger, executionMap: { unmappedChangedFiles: [] } });
    assert.equal(result.outcome, "evidence_mismatch");
});
test("evaluateChecklistCompletion rejects runtime context as product evidence", () => {
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "runtime-context", evidenceId: "worker-ok" }], actualResult: "ok", reason: "ok", fixScope: [] }],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const result = evaluateChecklistCompletion({ checklist: checklist(), verdict, evidenceLedger: ledger, executionMap: { unmappedChangedFiles: [] } });
    assert.equal(result.outcome, "evidence_missing");
});
test("evaluateChecklistCompletion rejects manual pass without approval artifact or event", () => {
    const manualChecklist = checklist({
        items: [{ ...checklist().items[0], verificationMethod: "manual", expectedEvidence: "approval artifact with approver, timestamp, and scope" }],
    });
    const manualLedger = {
        ...ledger,
        evidence: [{ ...ledger.evidence[0], verificationMethod: "manual", summary: "approved in prose only" }],
    };
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "approved", reason: "approved", fixScope: [] }],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const result = evaluateChecklistCompletion({ checklist: manualChecklist, verdict, evidenceLedger: manualLedger, executionMap: { unmappedChangedFiles: [] }, attemptId: "attempt-001" });
    assert.equal(result.outcome, "evidence_mismatch");
});
test("evaluateChecklistCompletion accepts manual pass with durable approval evidence", () => {
    const manualChecklist = checklist({
        items: [{ ...checklist().items[0], verificationMethod: "manual", expectedEvidence: "approval artifact with approver, timestamp, and scope" }],
    });
    const manualLedger = {
        ...ledger,
        evidence: [{
                ...ledger.evidence[0],
                verificationMethod: "manual",
                approver: "owner",
                approvedAt: "2026-06-12T00:00:00Z",
                scope: ["AC-001"],
                approvalArtifactId: "manual-approval-001",
                approvalArtifactResolved: true,
                resolvedArtifactHash: "sha256:approval-artifact",
            }],
    };
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "approved", reason: "approved", fixScope: [] }],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const result = evaluateChecklistCompletion({ checklist: manualChecklist, verdict, evidenceLedger: manualLedger, executionMap: { unmappedChangedFiles: [] }, attemptId: "attempt-001" });
    assert.equal(result.outcome, "complete");
});
test("evaluateChecklistCompletion blocks poisoned runtime evidence", () => {
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "ok", reason: "ok", fixScope: [] }],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const result = evaluateChecklistCompletion({
        checklist: checklist(),
        verdict,
        evidenceLedger: { ...ledger, evidence: [{ ...ledger.evidence[0], diffHash: "sha256:old", poisonedSession: true }] },
        executionMap: { unmappedChangedFiles: [] },
    });
    assert.equal(result.outcome, "poisoned_session");
    assert.deepEqual(result.poisonedEvidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
    assert.deepEqual(result.staleEvidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
});
test("evaluateChecklistCompletion blocks unresolved runtime failure events", () => {
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "ok", reason: "ok", fixScope: [] }],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const result = evaluateChecklistCompletion({
        checklist: checklist(),
        verdict,
        evidenceLedger: ledger,
        executionMap: { unmappedChangedFiles: [] },
        runtimeFailures: [{ type: "job_panic", phase: "verify", reason: "panic while writing artifact" }],
    });
    assert.equal(result.outcome, "runjob_panic");
    assert.deepEqual(result.runtimeFailureRefs, [{ type: "job_panic", attemptId: null, phase: "verify", nodeId: null, reason: "panic while writing artifact" }]);
});
test("evaluateChecklistCompletion blocks unmapped execution changes", () => {
    const verdict = {
        schemaVersion: 1,
        jobId: "job-1",
        status: "pass",
        items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }], actualResult: "ok", reason: "ok", fixScope: [] }],
        blocking: [],
        fixScope: [],
        reason: "passed",
    };
    const result = evaluateChecklistCompletion({
        checklist: checklist(),
        verdict,
        evidenceLedger: ledger,
        executionMap: { unmappedChangedFiles: ["core/engine/run-job.ts"] },
    });
    assert.equal(result.outcome, "scope_violation");
    assert.deepEqual(result.unmappedChangedFiles, ["core/engine/run-job.ts"]);
});
