import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvidenceObservation } from "../core/workflow/evidence-probes.js";
/**
 * Defect #4 fix: runtime_event / artifact_event / dag_event / worker_lifecycle
 * validators must require a POSITIVE payload matcher (payloadMatcher +
 * matchedValue) for `satisfied`, not just structural identity. A
 * structurally-complete but self-attested observation is recorded honestly as
 * { valid: true, satisfied: false } rather than silently passing.
 *
 * Spec (docs/superpowers/specs/2026-06-12-checklist-first-task-verification-design.md:285):
 * "runtime_event, artifact_event, dag_event, and worker_lifecycle: event or
 * artifact identity, event type/kind, timestamp, active attempt id, and a
 * positive payload matcher."
 */
const ATTEMPT_ID = "att-123";
function baseStructural(verificationMethod, extra = {}) {
    switch (verificationMethod) {
        case "runtime_event":
            return { verificationMethod, eventType: "phase_started", eventId: "evt-1", observedAt: "2026-06-12T00:00:00Z", attemptId: ATTEMPT_ID, ...extra };
        case "artifact_event":
            return { verificationMethod, artifactKind: "verdict", artifactHash: "sha256:abc", observedAt: "2026-06-12T00:00:00Z", attemptId: ATTEMPT_ID, ...extra };
        case "dag_event":
            return { verificationMethod, nodeId: "dag-node-1", eventType: "node_ready", observedAt: "2026-06-12T00:00:00Z", attemptId: ATTEMPT_ID, ...extra };
        case "worker_lifecycle":
            return { verificationMethod, assignmentId: "asgn-1", lifecycleEvent: "worker_exit", observedAt: "2026-06-12T00:00:00Z", attemptId: ATTEMPT_ID, ...extra };
        default:
            throw new Error(`unknown method ${verificationMethod}`);
    }
}
const METHODS = ["runtime_event", "artifact_event", "dag_event", "worker_lifecycle"];
for (const method of METHODS) {
    test(`${method}: structural-only observation -> { valid: true, satisfied: false }`, () => {
        const entry = baseStructural(method);
        const result = validateEvidenceObservation(entry, { verificationMethod: method }, { attemptId: ATTEMPT_ID });
        assert.equal(result.valid, true, "structural identity present => valid (recorded honestly)");
        assert.equal(result.satisfied, false, "no positive payload matcher => NOT satisfied");
    });
    test(`${method}: + payloadMatcher + matchedValue -> { valid: true, satisfied: true }`, () => {
        const entry = baseStructural(method, {
            payloadMatcher: "event field status === success",
            matchedValue: "success",
        });
        const result = validateEvidenceObservation(entry, { verificationMethod: method }, { attemptId: ATTEMPT_ID });
        assert.equal(result.valid, true);
        assert.equal(result.satisfied, true, "objective positive match => satisfied");
    });
    test(`${method}: missing attemptId -> { valid: false, satisfied: false }`, () => {
        const { attemptId: _drop, ...withoutAttempt } = baseStructural(method, {
            payloadMatcher: "event field status === success",
            matchedValue: "success",
        });
        void _drop;
        const result = validateEvidenceObservation(withoutAttempt, { verificationMethod: method }, { attemptId: ATTEMPT_ID });
        assert.equal(result.valid, false, "missing attemptId => not even recordable");
        assert.equal(result.satisfied, false);
    });
}
test("payloadMatcher alone (no matchedValue) is not satisfied for runtime_event", () => {
    const entry = baseStructural("runtime_event", { payloadMatcher: "status === success" });
    const result = validateEvidenceObservation(entry, { verificationMethod: "runtime_event" }, { attemptId: ATTEMPT_ID });
    assert.equal(result.valid, true);
    assert.equal(result.satisfied, false, "matcher without the actual matched value is self-attestation");
});
test("matchedValue alone (no payloadMatcher) is not satisfied for dag_event", () => {
    const entry = baseStructural("dag_event", { matchedValue: "success" });
    const result = validateEvidenceObservation(entry, { verificationMethod: "dag_event" }, { attemptId: ATTEMPT_ID });
    assert.equal(result.valid, true);
    assert.equal(result.satisfied, false, "value without a stated matcher is self-attestation");
});
test("artifact_event without artifact identity (no hash/path/artifactId) is not valid", () => {
    const entry = {
        verificationMethod: "artifact_event",
        artifactKind: "verdict",
        observedAt: "2026-06-12T00:00:00Z",
        attemptId: ATTEMPT_ID,
        payloadMatcher: "kind === verdict",
        matchedValue: "verdict",
    };
    const result = validateEvidenceObservation(entry, { verificationMethod: "artifact_event" }, { attemptId: ATTEMPT_ID });
    assert.equal(result.valid, false, "spec requires artifact identity (hash/path/id); missing => not valid");
    assert.equal(result.satisfied, false);
});
