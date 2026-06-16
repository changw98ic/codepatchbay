import assert from "node:assert/strict";
import { test } from "node:test";
import { FailureKind } from "../core/contracts/failure.js";
import { FailureRouter } from "../server/orchestrator/failure-router.js";
test("failure router retries checklist failure with file fix scope", async () => {
    const router = new FailureRouter();
    const decision = await router.route({
        assignment: { attempts: 0 },
        attempt: 1,
        result: {
            failure: {
                kind: FailureKind.VERIFICATION_FAILED,
                reason: "AC-002 failed",
                cause: {
                    verdict: {
                        checklistVerdict: {
                            items: [{ checklistId: "AC-002", result: "fail", fixScope: ["cli/commands/status.ts"] }],
                            fixScope: ["cli/commands/status.ts"],
                        },
                    },
                },
            },
        },
    });
    assert.equal(decision.action, "retry_same_worker");
    assert.equal(decision.retryable, true);
});
test("failure router does not execute-retry checklist failure without file scope", async () => {
    const router = new FailureRouter();
    const decision = await router.route({
        assignment: { attempts: 0 },
        attempt: 1,
        result: {
            failure: {
                kind: FailureKind.VERIFICATION_FAILED,
                reason: "AC-002 failed",
                cause: { verdict: { checklistVerdict: { items: [{ checklistId: "AC-002", result: "fail", fixScope: [] }], fixScope: [] } } },
            },
        },
    });
    assert.equal(decision.action, "mark_failed");
});
test("failure router can retry verifier for missing evidence without file scope", async () => {
    const router = new FailureRouter();
    const decision = await router.route({
        assignment: { attempts: 0 },
        attempt: 1,
        result: {
            failure: {
                kind: FailureKind.VERIFICATION_FAILED,
                reason: "AC-003 evidence missing",
                cause: {
                    routingLabel: "evidence_missing",
                    evidenceMissingCause: "probe_available_not_run",
                    retryPhase: "verify",
                    targetChecklistIds: ["AC-003"],
                    fixScope: [],
                },
            },
        },
    });
    assert.equal(decision.action, "retry_same_worker");
    assert.equal(decision.retryPhase, "verify");
    assert.equal(decision.retryable, true);
});
test("failure router does not verifier-retry when evidence probe is undefined", async () => {
    const router = new FailureRouter();
    const decision = await router.route({
        assignment: { attempts: 0 },
        attempt: 1,
        result: {
            failure: {
                kind: FailureKind.VERIFICATION_FAILED,
                reason: "AC-003 has no probe definition",
                cause: {
                    routingLabel: "evidence_missing",
                    evidenceMissingCause: "probe_definition_missing",
                    targetChecklistIds: ["AC-003"],
                    fixScope: [],
                },
            },
        },
    });
    assert.equal(decision.action, "mark_failed");
});
test("failure router blocks missing manual approval instead of verifier-looping", async () => {
    const router = new FailureRouter();
    const decision = await router.route({
        assignment: { attempts: 0 },
        attempt: 1,
        result: {
            failure: {
                kind: FailureKind.HUMAN_APPROVAL_REQUIRED,
                reason: "AC-004 requires manual approval artifact",
                cause: {
                    routingLabel: "evidence_missing",
                    evidenceMissingCause: "manual_approval_missing",
                    targetChecklistIds: ["AC-004"],
                    fixScope: [],
                },
            },
        },
    });
    assert.equal(decision.action, "mark_blocked");
});
test("failure router fails closed for ambiguous runtime artifacts without retry", async () => {
    const router = new FailureRouter();
    const decision = await router.route({
        assignment: { attempts: 0 },
        attempt: 1,
        result: {
            failure: {
                kind: FailureKind.ARTIFACT_INVALID,
                reason: "runtime failure missing attempt ownership",
                cause: { routingLabel: "runtime_failure_ambiguous" },
            },
        },
    });
    assert.equal(decision.action, "mark_failed");
    assert.equal(decision.retryable, false);
});
