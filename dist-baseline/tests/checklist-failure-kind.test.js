import assert from "node:assert/strict";
import { test } from "node:test";
import { FailureKind, failure } from "../core/contracts/failure.js";
import { mapChecklistRoutingLabel } from "../core/workflow/acceptance-checklist.js";
import { FailureRouter } from "../server/orchestrator/failure-router.js";
test("scope violation is a valid failure kind for checklist routing", () => {
    const result = failure({
        kind: FailureKind.SCOPE_VIOLATION,
        phase: "execute",
        reason: "changed file outside fix scope",
        retryable: false,
    });
    assert.equal(result.kind, "scope_violation");
});
test("checklist routing labels map to closed failure contracts", () => {
    assert.deepEqual(mapChecklistRoutingLabel("scope_violation", {}), {
        kind: FailureKind.SCOPE_VIOLATION,
        action: "mark_failed",
        retryPhase: null,
        requiresFixScope: false,
        retryable: false,
    });
    assert.deepEqual(mapChecklistRoutingLabel("checklist_failed", { fixScope: ["cli/status.ts"] }), {
        kind: FailureKind.VERIFICATION_FAILED,
        action: "retry_same_worker",
        retryPhase: "execute",
        requiresFixScope: true,
        retryable: true,
    });
    assert.deepEqual(mapChecklistRoutingLabel("evidence_missing", { evidenceMissingCause: "probe_available_not_run", fixScope: [] }), {
        kind: FailureKind.VERIFICATION_FAILED,
        action: "retry_same_worker",
        retryPhase: "verify",
        requiresFixScope: false,
        retryable: true,
    });
    assert.deepEqual(mapChecklistRoutingLabel("evidence_missing", { evidenceMissingCause: "probe_definition_missing", fixScope: [] }), {
        kind: FailureKind.VERIFICATION_FAILED,
        action: "mark_failed",
        retryPhase: null,
        requiresFixScope: false,
        retryable: false,
    });
    assert.deepEqual(mapChecklistRoutingLabel("evidence_missing", { evidenceMissingCause: "manual_approval_missing", fixScope: [] }), {
        kind: FailureKind.HUMAN_APPROVAL_REQUIRED,
        action: "mark_blocked",
        retryPhase: null,
        requiresFixScope: false,
        retryable: false,
    });
    assert.deepEqual(mapChecklistRoutingLabel("poisoned_session", {}), {
        kind: FailureKind.POISONED_SESSION,
        action: "mark_failed",
        retryPhase: null,
        requiresFixScope: false,
        retryable: false,
    });
    assert.deepEqual(mapChecklistRoutingLabel("runjob_panic", {}), {
        kind: FailureKind.RUNJOB_PANIC,
        action: "mark_failed",
        retryPhase: null,
        requiresFixScope: false,
        retryable: false,
    });
    assert.deepEqual(mapChecklistRoutingLabel("runtime_failure_ambiguous", {}), {
        kind: FailureKind.ARTIFACT_INVALID,
        action: "mark_failed",
        retryPhase: null,
        requiresFixScope: false,
        retryable: false,
    });
    assert.equal(mapChecklistRoutingLabel("unknown_label", {}).action, "mark_failed");
});
test("failure router applies closed actions for checklist routing labels", async () => {
    const router = new FailureRouter();
    const scopeDecision = await router.route({
        assignment: { attempts: 0 },
        attempt: 1,
        result: { failure: { kind: FailureKind.SCOPE_VIOLATION, reason: "outside fix scope", retryable: false, cause: { routingLabel: "scope_violation" } } },
    });
    assert.equal(scopeDecision.action, "mark_failed");
    assert.equal(scopeDecision.retryable, false);
    const ambiguousDecision = await router.route({
        assignment: { attempts: 0 },
        attempt: 1,
        result: { failure: { kind: FailureKind.ARTIFACT_INVALID, reason: "ambiguous attempt", retryable: false, cause: { routingLabel: "runtime_failure_ambiguous" } } },
    });
    assert.equal(ambiguousDecision.action, "mark_failed");
    assert.equal(ambiguousDecision.retryable, false);
});
