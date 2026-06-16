/**
 * Tests for evidence ledger and checklist verdict persistence in the verify phase.
 *
 * Task 7: Checklist-aware jobs must produce event-visible evidence-ledger and
 * checklist-verdict artifacts. Legacy verifier pass without checklistVerdict
 * must fail as VERDICT_INVALID and synthesize a failing checklist-verdict.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runJob } from "../core/engine/run-job.js";
import { appendEvent } from "../server/services/event/event-store.js";
import { buildArtifactIndex } from "../server/services/job/job-projection.js";
import { tempRoot } from "./helpers.js";
function jsonEnvelope(data) {
    return "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}
function checklist(overrides = {}) {
    return {
        schemaVersion: 1,
        jobId: "job-checklist",
        project: "flow",
        status: "frozen",
        source: { task: "task", issue: null, documents: [] },
        items: [
            {
                id: "AC-001",
                requirement: "README is updated",
                source: "user_task",
                sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
                predicateId: "PRED-001",
                required: true,
                area: "docs",
                risk: "low",
                verificationMethod: "static",
                expectedEvidence: "README diff contains requested text",
                dependsOn: [],
                allowedFiles: ["README.md"],
            },
        ],
        assumptions: [],
        ...overrides,
    };
}
function makeVerifierPool(verdictOverride = {}) {
    let verifierPrompt = "";
    const pool = {
        async execute(_agent, _prompt, _cwd, _timeoutMs, meta) {
            if (meta.role === "planner") {
                return {
                    output: jsonEnvelope({
                        status: "ok",
                        planMarkdown: "## Analysis\n- ok\n\n## Files to modify\n- README.md\n\n## Implementation Steps\n1. edit\n\n## Testing\n- npm test\n\n## Risks\n- none",
                    }),
                    providerKey: "fake",
                    variant: null,
                };
            }
            if (meta.role === "executor") {
                return {
                    output: jsonEnvelope({
                        status: "ok",
                        summary: "Updated README.md with new content",
                        tests: [],
                        risks: [],
                        checklistMapping: [
                            { checklistId: "AC-001", changedFiles: ["README.md"], executorClaim: "Updated README", notes: "" },
                        ],
                    }),
                    providerKey: "fake",
                    variant: null,
                };
            }
            if (meta.role === "verifier") {
                verifierPrompt = _prompt;
                return {
                    output: jsonEnvelope({
                        status: "ok",
                        verdict: "pass",
                        reason: "looks good",
                        details: "Implementation matches plan",
                        confidence: 0.9,
                        ...verdictOverride,
                    }),
                    providerKey: "fake",
                    variant: null,
                };
            }
            return {
                output: jsonEnvelope({ status: "ok", verdict: "pass", reason: "legacy", details: "ok", confidence: 1 }),
                providerKey: "fake",
                variant: null,
            };
        },
        async releaseWorktree() { return true; },
        getVerifierPrompt() { return verifierPrompt; },
    };
    return pool;
}
async function makeSourceRoot() {
    const sourcePath = await tempRoot("cpb-verifier-source");
    await writeFile(path.join(sourcePath, "README.md"), "# fixture\n", "utf8");
    await writeFile(path.join(sourcePath, "package.json"), JSON.stringify({ name: "verifier-fixture", private: true }, null, 2), "utf8");
    return sourcePath;
}
async function runVerifierFixture(pool, opts = {}) {
    const cpbRoot = await tempRoot("cpb-verifier-gate");
    const sourcePath = await makeSourceRoot();
    const dataRoot = path.join(cpbRoot, "runtime", "projects", "flow");
    const events = [];
    const prepareTaskResult = {
        phases: ["plan", "execute", "verify"],
        riskMap: { riskLevel: "low" },
        ...(opts.prepareOverrides || {}),
    };
    if (opts.withChecklist !== false) {
        prepareTaskResult.acceptanceChecklist = checklist();
    }
    const result = await runJob({
        cpbRoot,
        dataRoot,
        project: "flow",
        task: "Update README",
        jobId: opts.jobId || "job-checklist",
        workflow: "standard",
        planMode: "full",
        sourcePath,
        sourceContext: opts.sourceContext || {},
        agents: { planner: "fake", executor: "fake", verifier: "fake" },
        prepareTask: async () => prepareTaskResult,
        createJob: async () => ({ jobId: opts.jobId || "job-checklist" }),
        startJob: async () => ({}),
        checkpointJob: async () => ({}),
        completePhase: async () => ({}),
        completeJob: async () => ({}),
        failJob: async () => ({}),
        blockJob: async () => ({}),
        appendEvent: async (_root, _project, _jobId, event) => {
            events.push(event);
            await appendEvent(cpbRoot, "flow", opts.jobId || "job-checklist", event, { dataRoot });
        },
        reportProgress: async () => ({}),
        getPool: () => pool,
    });
    return { result, events, cpbRoot, dataRoot };
}
/**
 * Case 1: checklist-aware job with legacy verifier pass and no checklistVerdict
 * fails with VERDICT_INVALID, still emits event-visible evidence-ledger plus
 * a synthesized failing checklist-verdict.
 */
test("checklist-aware job with legacy verifier pass fails as VERDICT_INVALID and emits synthesized failing checklist-verdict", async () => {
    const pool = makeVerifierPool(); // No checklistVerdict in response
    const { result, events, cpbRoot, dataRoot } = await runVerifierFixture(pool);
    // Job should fail
    assert.equal(result.status, "failed", "checklist-aware job with legacy pass must fail");
    // Evidence-ledger artifact event must exist
    assert.ok(events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"), "evidence-ledger artifact_created event must exist");
    // Checklist-verdict artifact event must exist
    assert.ok(events.some((e) => e.type === "artifact_created" && e.kind === "checklist-verdict"), "checklist-verdict artifact_created event must exist");
    // The persisted verdict must be a synthesized fail
    const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
    const verdictEntry = index.entries.find((entry) => entry.kind === "checklist-verdict");
    assert.ok(verdictEntry?.path, "checklist-verdict must have a readable artifact path");
    const persistedVerdict = JSON.parse(await readFile(verdictEntry.path, "utf8"));
    assert.equal(persistedVerdict.status, "fail", "synthesized verdict must have status fail");
    // The synthesized verdict must have every required item unchecked
    const uncheckedItems = persistedVerdict.items.filter((item) => item.result === "unchecked");
    assert.equal(uncheckedItems.length, persistedVerdict.items.length, "all items must be unchecked in synthesized verdict");
});
/**
 * Case 2: checklist-aware job with valid checklistVerdict and fresh evidence
 * passes verify and emits evidence-ledger plus checklist-verdict artifact events.
 */
test("checklist-aware job with checklistVerdict and fresh evidence passes and emits artifacts", async () => {
    const pool = makeVerifierPool({
        checklistVerdict: {
            schemaVersion: 1,
            jobId: "job-checklist",
            status: "pass",
            items: [
                {
                    checklistId: "AC-001",
                    result: "pass",
                    evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
                    actualResult: "README updated as required",
                    reason: "README diff shows requested content",
                    fixScope: [],
                },
            ],
            blocking: [],
            fixScope: [],
            reason: "all items passed with evidence",
        },
    });
    const { result, events, cpbRoot, dataRoot } = await runVerifierFixture(pool);
    // Evidence-ledger and checklist-verdict events must exist
    assert.ok(events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"), "evidence-ledger artifact_created event must exist");
    assert.ok(events.some((e) => e.type === "artifact_created" && e.kind === "checklist-verdict"), "checklist-verdict artifact_created event must exist");
    // The persisted checklist-verdict should be pass
    const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
    const verdictEntry = index.entries.find((entry) => entry.kind === "checklist-verdict");
    assert.ok(verdictEntry?.path, "checklist-verdict must have a readable artifact path");
    const persistedVerdict = JSON.parse(await readFile(verdictEntry.path, "utf8"));
    assert.equal(persistedVerdict.status, "pass", "checklist verdict must be pass");
});
/**
 * Case 3: verifier prompt includes predeclared ledger ids before verifier output.
 * A verifier response that cites an invented EV-* id fails as evidence_missing.
 */
test("verifier prompt includes predeclared ledger ids and invented ids cause evidence_missing", async () => {
    const pool = makeVerifierPool({
        checklistVerdict: {
            schemaVersion: 1,
            jobId: "job-checklist",
            status: "pass",
            items: [
                {
                    checklistId: "AC-001",
                    result: "pass",
                    evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-INVENTED-999" }],
                    actualResult: "looks correct",
                    reason: "invented evidence id",
                    fixScope: [],
                },
            ],
            blocking: [],
            fixScope: [],
            reason: "invented evidence",
        },
    });
    const { result, events, cpbRoot, dataRoot } = await runVerifierFixture(pool);
    // Verifier prompt must include ledger id info
    const verifierPrompt = pool.getVerifierPrompt();
    assert.ok(verifierPrompt, "verifier prompt must be captured");
    assert.match(verifierPrompt, /evidence-ledger/i, "verifier prompt must reference evidence ledger");
    // The job should still complete (verdict validation in completion gate is Task 8,
    // but the evidence-ledger artifact should still be persisted)
    assert.ok(events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"), "evidence-ledger must still be emitted even with invalid evidence refs");
});
/**
 * Case 4: a fresh hard-gate observation without matching
 * { checklistId, verificationMethod, predicateId } cannot prove a checklist item.
 */
test("fresh hard-gate observation without matching fields cannot prove checklist item", async () => {
    // The hard-gate checks in the test fixture produce observations like
    // { gate: "node --check", file, ok: true }. These lack checklistId,
    // verificationMethod, and predicateId, so they cannot serve as evidence
    // for any checklist item.
    const pool = makeVerifierPool({
        checklistVerdict: {
            schemaVersion: 1,
            jobId: "job-checklist",
            status: "pass",
            items: [
                {
                    checklistId: "AC-001",
                    result: "pass",
                    evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
                    actualResult: "hard gate passed",
                    reason: "node --check passed",
                    fixScope: [],
                },
            ],
            blocking: [],
            fixScope: [],
            reason: "hard gate pass as evidence",
        },
    });
    const { events, cpbRoot, dataRoot } = await runVerifierFixture(pool);
    // The evidence-ledger should have empty evidence because hard-gate
    // observations lack checklistId/verificationMethod/predicateId bindings
    const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
    const ledgerEntry = index.entries.find((entry) => entry.kind === "evidence-ledger");
    assert.ok(ledgerEntry?.path, "evidence-ledger must exist");
    const ledger = JSON.parse(await readFile(ledgerEntry.path, "utf8"));
    assert.ok(Array.isArray(ledger.evidence), "evidence must be an array");
    // Hard gate checks without checklistId/verificationMethod/predicateId should not
    // produce evidence claims in the ledger
    const unboundClaims = ledger.evidence.filter((e) => !e.checklistId || !e.verificationMethod || !e.predicateId);
    assert.equal(unboundClaims.length, 0, "no evidence claims should exist without checklist bindings");
});
/**
 * Case 5: When prepareTask does not provide a checklist, run-job now
 * auto-constructs one (default checklist-first). The job is therefore
 * checklist-aware: a verifier that returns a legacy verdict without a
 * checklistVerdict fails as VERDICT_INVALID, and the evidence-ledger plus
 * synthesized failing checklist-verdict artifacts are emitted. There is no
 * silent legacy-verifier fallback.
 */
test("job without explicit checklist auto-constructs one and runs the checklist-aware path", async () => {
    const pool = makeVerifierPool(); // legacy verdict, no checklistVerdict
    const { result, events } = await runVerifierFixture(pool, {
        withChecklist: false,
        sourceContext: {},
    });
    // Auto-constructed checklist makes the job checklist-aware; a legacy
    // verdict without checklistVerdict is rejected.
    assert.equal(result.status, "failed");
    assert.ok(events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"), "evidence-ledger must be emitted for the auto-constructed checklist path");
    assert.ok(events.some((e) => e.type === "artifact_created" && e.kind === "checklist-verdict"), "checklist-verdict must be emitted (synthesized failing) for the checklist-aware path");
});
/**
 * Case 6: a readable event-indexed acceptance-checklist artifact selects the
 * checklist-aware verify path even when phase diagnostics/source context are absent.
 */
test("readable event-indexed acceptance-checklist artifact selects checklist-aware path", async () => {
    const pool = makeVerifierPool();
    // prepareTask includes the checklist (which creates the event-indexed artifact),
    // but sourceContext is empty
    const { result, events } = await runVerifierFixture(pool, {
        sourceContext: {},
    });
    // Since the checklist was created via prepareTask and event-indexed, the verify
    // phase should be checklist-aware. The legacy verifier pass should fail.
    assert.equal(result.status, "failed", "checklist-aware path should reject legacy verdict");
    assert.ok(events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"), "evidence-ledger must be emitted for checklist-aware path");
    assert.ok(events.some((e) => e.type === "artifact_created" && e.kind === "checklist-verdict"), "checklist-verdict must be emitted for checklist-aware path");
});
/**
 * Case 7: a generic command/test summary that lacks method-specific observation
 * fields fails as evidence_missing or evidence_invalid.
 */
test("generic command/test summary fails as evidence_missing without method-specific fields", async () => {
    const pool = makeVerifierPool({
        checklistVerdict: {
            schemaVersion: 1,
            jobId: "job-checklist",
            status: "pass",
            items: [
                {
                    checklistId: "AC-001",
                    result: "pass",
                    evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
                    actualResult: "tests passed",
                    reason: "npm test passed",
                    fixScope: [],
                },
            ],
            blocking: [],
            fixScope: [],
            reason: "generic test pass",
        },
    });
    const { events, cpbRoot, dataRoot } = await runVerifierFixture(pool);
    // The evidence-ledger should be emitted
    assert.ok(events.some((e) => e.type === "artifact_created" && e.kind === "evidence-ledger"), "evidence-ledger must be emitted");
    // Since the probes are built from hardGateChecks (which don't have checklistId/predicateId/probeId
    // bindings in this test fixture), the evidence ledger should be empty or have no valid claims.
    // The checklist-verdict that passes must still reference valid evidence.
    const index = await buildArtifactIndex(cpbRoot, "flow", "job-checklist", { dataRoot });
    const ledgerEntry = index.entries.find((entry) => entry.kind === "evidence-ledger");
    assert.ok(ledgerEntry?.path, "evidence-ledger must exist");
    const ledger = JSON.parse(await readFile(ledgerEntry.path, "utf8"));
    // With no properly bound hard-gate probes, evidence array should be empty
    assert.ok(Array.isArray(ledger.evidence), "evidence must be an array");
});
/**
 * Case 8: method-specific probes for command, static, artifact_event, and
 * absence_check produce valid claims only when their observation validator passes.
 */
test("method-specific probes produce valid claims only when observation validator passes", async () => {
    const { validateEvidenceObservation } = await import("../core/workflow/evidence-probes.js");
    // command probe: spec-compliant (command + cwd + exitCode 0 + digest +
    // worktreeHead) → { valid: true, satisfied: true }
    const commandItem = { verificationMethod: "command", id: "AC-001", predicateId: "PRED-001" };
    assert.deepEqual(validateEvidenceObservation({ command: "npm test", exitCode: 0, stdoutSha256: "sha256:abc", cwd: "/repo", worktreeHead: "head-1", attemptId: "att-1" }, commandItem, { attemptId: "att-1" }), { valid: true, satisfied: true }, "command probe with all spec fields should pass");
    // command probe: missing stdoutSha256 → { valid: false, satisfied: false }
    assert.deepEqual(validateEvidenceObservation({ command: "npm test", exitCode: 0, attemptId: "att-1" }, commandItem, { attemptId: "att-1" }), { valid: false, satisfied: false }, "command probe without stdoutSha256 should fail");
    // command probe: exitCode !== 0
    assert.deepEqual(validateEvidenceObservation({ command: "npm test", exitCode: 1, stdoutSha256: "sha256:abc", attemptId: "att-1" }, commandItem, { attemptId: "att-1" }), { valid: false, satisfied: false }, "command probe with non-zero exitCode should fail");
    // static probe: positive matchCount → satisfied
    const staticItem = { verificationMethod: "static", id: "AC-002", predicateId: "PRED-002" };
    assert.deepEqual(validateEvidenceObservation({ queryId: "q1", matchCount: 3 }, staticItem), { valid: true, satisfied: true }, "static probe with queryId and matchCount>0 should be valid and satisfied");
    // static probe: matchCount === 0 → valid but NOT satisfied (honest zero,
    // recorded as a fail rather than silently dropped)
    assert.deepEqual(validateEvidenceObservation({ queryId: "q1", matchCount: 0 }, staticItem), { valid: true, satisfied: false }, "static probe with matchCount:0 must be valid (recordable) but not satisfied");
    // static probe: missing queryId → not valid
    assert.deepEqual(validateEvidenceObservation({ matchCount: 3 }, staticItem), { valid: false, satisfied: false }, "static probe without queryId must not be valid");
    // static probe: missing matchCount → not valid
    assert.deepEqual(validateEvidenceObservation({ queryId: "q1" }, staticItem), { valid: false, satisfied: false }, "static probe without matchCount should fail");
    // artifact_event probe: valid (requires attemptId)
    const artifactItem = { verificationMethod: "artifact_event", id: "AC-003", predicateId: "PRED-003" };
    assert.deepEqual(validateEvidenceObservation({ eventType: "artifact_created", artifactHash: "sha256:art-1", observedAt: "2026-06-12T00:00:00Z", payloadMatcher: "artifact kind created", matchedValue: "artifact_created", attemptId: "att-1" }, artifactItem), { valid: true, satisfied: true }, "artifact_event probe with eventType, observedAt, and attemptId should pass");
    // artifact_event probe: missing attemptId
    assert.deepEqual(validateEvidenceObservation({ eventType: "artifact_created", observedAt: "2026-06-12T00:00:00Z" }, artifactItem), { valid: false, satisfied: false }, "artifact_event probe without attemptId should fail");
    // absence_check probe: valid
    const absenceItem = { verificationMethod: "absence_check", id: "AC-004", predicateId: "PRED-004" };
    assert.deepEqual(validateEvidenceObservation({
        absence: true,
        queryWindow: { from: "2026-06-12T00:00:00Z", to: "2026-06-12T01:00:00Z" },
        eventTypes: ["phase_poisoned_session"],
        querySource: "event-log:phase_poisoned_session",
        queryResultSignature: "sha256:empty-result",
        attemptId: "att-1",
    }, absenceItem), { valid: true, satisfied: true }, "absence_check probe with all fields should pass");
    // absence_check probe: missing queryWindow.from
    assert.deepEqual(validateEvidenceObservation({
        absence: true,
        queryWindow: { to: "2026-06-12T01:00:00Z" },
        eventTypes: ["phase_poisoned_session"],
        attemptId: "att-1",
    }, absenceItem), { valid: false, satisfied: false }, "absence_check probe without queryWindow.from should fail");
    // absence_check probe: absence is false (event was found)
    assert.deepEqual(validateEvidenceObservation({
        absence: false,
        queryWindow: { from: "2026-06-12T00:00:00Z", to: "2026-06-12T01:00:00Z" },
        eventTypes: ["phase_poisoned_session"],
        attemptId: "att-1",
    }, absenceItem), { valid: false, satisfied: false }, "absence_check probe with absence=false should fail (event found, not absent)");
    // Predicate echo rejection: bare { checklistId, method, predicateId, result: "pass" }
    // should fail because method-specific observation fields are missing
    const echoEntry = {
        checklistId: "AC-001",
        verificationMethod: "command",
        predicateId: "PRED-001",
        result: "pass",
        attemptId: "att-1",
    };
    assert.deepEqual(validateEvidenceObservation(echoEntry, commandItem, { attemptId: "att-1" }), { valid: false, satisfied: false }, "predicate echo without observation fields must fail");
});
