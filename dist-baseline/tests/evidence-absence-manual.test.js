import { test } from "node:test";
import assert from "node:assert/strict";
import { validateEvidenceObservation } from "../core/workflow/evidence-probes.js";
const manualItem = { id: "AC-MANUAL", verificationMethod: "manual", predicateId: "p.approved" };
const absenceItem = { id: "AC-ABSENCE", verificationMethod: "absence_check", predicateId: "p.absent" };
test("manual: satisfied when structural gate passes AND resolvedArtifactHash present", () => {
    const entry = {
        verificationMethod: "manual",
        approver: "alice@example.com",
        approvedAt: "2026-06-15T00:00:00Z",
        scope: ["AC-MANUAL"],
        approvalArtifactId: "approval-1",
        approvalArtifactResolved: true,
        resolvedArtifactHash: "sha256:deadbeef",
        attemptId: "att-1",
    };
    const r = validateEvidenceObservation(entry, manualItem, { attemptId: "att-1" });
    assert.equal(r.valid, true);
    assert.equal(r.satisfied, true);
});
test("manual: valid but NOT satisfied when resolvedArtifactHash missing (self-attested flag only)", () => {
    // approvalArtifactResolved===true set by agent, but no objective hash backing it.
    const entry = {
        verificationMethod: "manual",
        approver: "alice@example.com",
        approvedAt: "2026-06-15T00:00:00Z",
        scope: ["AC-MANUAL"],
        approvalArtifactId: "approval-1",
        approvalArtifactResolved: true,
        attemptId: "att-1",
    };
    const r = validateEvidenceObservation(entry, manualItem, { attemptId: "att-1" });
    assert.equal(r.valid, true, "structurally recordable");
    assert.equal(r.satisfied, false, "self-attested flag without hash is not proof");
});
test("manual: NOT valid when scope does not cover checklist id", () => {
    const entry = {
        verificationMethod: "manual",
        approver: "alice@example.com",
        approvedAt: "2026-06-15T00:00:00Z",
        scope: ["AC-OTHER"],
        approvalArtifactId: "approval-1",
        approvalArtifactResolved: true,
        resolvedArtifactHash: "sha256:deadbeef",
        attemptId: "att-1",
    };
    const r = validateEvidenceObservation(entry, manualItem, { attemptId: "att-1" });
    assert.equal(r.valid, false);
    assert.equal(r.satisfied, false);
});
test("manual: NOT valid when approval not resolved (flag false)", () => {
    const entry = {
        verificationMethod: "manual",
        approver: "alice@example.com",
        approvedAt: "2026-06-15T00:00:00Z",
        scope: ["AC-MANUAL"],
        approvalArtifactId: "approval-1",
        approvalArtifactResolved: false,
        resolvedArtifactHash: "sha256:deadbeef",
        attemptId: "att-1",
    };
    const r = validateEvidenceObservation(entry, manualItem, { attemptId: "att-1" });
    assert.equal(r.valid, false);
    assert.equal(r.satisfied, false);
});
test("absence_check: satisfied when structural gate passes AND querySource + queryResultSignature present", () => {
    const entry = {
        verificationMethod: "absence_check",
        absence: true,
        queryWindow: { from: "2026-06-14T00:00:00Z", to: "2026-06-15T00:00:00Z" },
        eventTypes: ["runtime_error", "panic"],
        querySource: "cpb-task/events/proj/job.jsonl",
        queryResultSignature: "grep -c panic => 0 | sha256:cafef00d",
        attemptId: "att-1",
    };
    const r = validateEvidenceObservation(entry, absenceItem, { attemptId: "att-1" });
    assert.equal(r.valid, true);
    assert.equal(r.satisfied, true);
});
test("absence_check: valid but NOT satisfied when querySource + queryResultSignature missing (bare absence:true)", () => {
    const entry = {
        verificationMethod: "absence_check",
        absence: true,
        queryWindow: { from: "2026-06-14T00:00:00Z", to: "2026-06-15T00:00:00Z" },
        eventTypes: ["runtime_error"],
        attemptId: "att-1",
    };
    const r = validateEvidenceObservation(entry, absenceItem, { attemptId: "att-1" });
    assert.equal(r.valid, true, "structurally recordable");
    assert.equal(r.satisfied, false, "bare absence boolean without query signature is not proof");
});
test("absence_check: valid but NOT satisfied when only querySource present (signature missing)", () => {
    const entry = {
        verificationMethod: "absence_check",
        absence: true,
        queryWindow: { from: "2026-06-14T00:00:00Z", to: "2026-06-15T00:00:00Z" },
        eventTypes: ["runtime_error"],
        querySource: "cpb-task/events/proj/job.jsonl",
        attemptId: "att-1",
    };
    const r = validateEvidenceObservation(entry, absenceItem, { attemptId: "att-1" });
    assert.equal(r.valid, true);
    assert.equal(r.satisfied, false);
});
test("absence_check: NOT valid when absence is false (positive result, not a negative query)", () => {
    const entry = {
        verificationMethod: "absence_check",
        absence: false,
        queryWindow: { from: "2026-06-14T00:00:00Z", to: "2026-06-15T00:00:00Z" },
        eventTypes: ["runtime_error"],
        querySource: "cpb-task/events/proj/job.jsonl",
        queryResultSignature: "sha256:1234",
        attemptId: "att-1",
    };
    const r = validateEvidenceObservation(entry, absenceItem, { attemptId: "att-1" });
    assert.equal(r.valid, false);
    assert.equal(r.satisfied, false);
});
test("absence_check: NOT valid when queryWindow unbounded (missing to)", () => {
    const entry = {
        verificationMethod: "absence_check",
        absence: true,
        queryWindow: { from: "2026-06-14T00:00:00Z" },
        eventTypes: ["runtime_error"],
        querySource: "cpb-task/events/proj/job.jsonl",
        queryResultSignature: "sha256:1234",
        attemptId: "att-1",
    };
    const r = validateEvidenceObservation(entry, absenceItem, { attemptId: "att-1" });
    assert.equal(r.valid, false);
    assert.equal(r.satisfied, false);
});
