/**
 * validateAuditExportObservation: { valid, satisfied } regression.
 *
 * Pins spec line 283 — `audit_export` evidence must carry an objective
 * observed value digest, not just the export's invocation identity. An agent
 * that self-attests "I exported section X" without a content digest is
 * structurally recordable (honest, not silently dropped) but does not SATISFY
 * the item — there is no proof of what the export actually contained.
 *
 *   CASE A — full proof: identity + sectionPath + attemptId + valueDigest
 *            → { valid: true, satisfied: true }.
 *   CASE B — honest half-proof: identity + sectionPath + attemptId, NO digest
 *            → { valid: true, satisfied: false } (recorded honestly, fails).
 *   CASE C — missing sectionPath → { valid: false, satisfied: false } (dropped).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { validateEvidenceObservation } from "../core/workflow/evidence-probes.js";

type AnyRecord = Record<string, any>;

const ATTEMPT_ID = "attempt-audit-001";

const AUDIT_ITEM: AnyRecord = {
  id: "cl-audit-1",
  verificationMethod: "audit_export",
  predicateId: "audit.section-exported",
};

test("audit_export CASE A: identity + sectionPath + attemptId + valueDigest -> satisfied", () => {
  const entry: AnyRecord = {
    exportId: "export-001",
    sectionPath: "build/reports/audit.json#sectionX",
    attemptId: ATTEMPT_ID,
    valueDigest: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  };
  const result = validateEvidenceObservation(entry, AUDIT_ITEM, { attemptId: ATTEMPT_ID });
  assert.equal(result.valid, true, "valid: structurally recordable");
  assert.equal(result.satisfied, true, "satisfied: objective digest proves the export content");
});

test("audit_export CASE B: no valueDigest -> valid (honest), satisfied false", () => {
  const entry: AnyRecord = {
    invocationId: "inv-002",
    sectionPath: "build/reports/audit.json#sectionY",
    attemptId: ATTEMPT_ID,
    // valueDigest intentionally absent — self-attested export, no content proof
  };
  const result = validateEvidenceObservation(entry, AUDIT_ITEM, { attemptId: ATTEMPT_ID });
  assert.equal(result.valid, true, "valid: still recordable honestly, not silently dropped");
  assert.equal(result.satisfied, false, "satisfied: a bare self-attestation is not positive proof");
});

test("audit_export CASE C: missing sectionPath -> invalid (dropped)", () => {
  const entry: AnyRecord = {
    exportId: "export-003",
    // sectionPath intentionally absent
    attemptId: ATTEMPT_ID,
    valueDigest: "sha256:abc",
  };
  const result = validateEvidenceObservation(entry, AUDIT_ITEM, { attemptId: ATTEMPT_ID });
  assert.equal(result.valid, false, "valid: sectionPath is a required structural identity field");
  assert.equal(result.satisfied, false, "satisfied: cannot be satisfied when invalid");
});

test("audit_export: missing attemptId -> invalid", () => {
  const entry: AnyRecord = {
    exportId: "export-004",
    sectionPath: "build/reports/audit.json#sectionZ",
    valueDigest: "sha256:def",
  };
  const result = validateEvidenceObservation(entry, AUDIT_ITEM, { attemptId: ATTEMPT_ID });
  assert.equal(result.valid, false, "valid: attemptId required by record-gate");
  assert.equal(result.satisfied, false);
});

test("audit_export: identity via probeId also satisfies structural gate", () => {
  const entry: AnyRecord = {
    probeId: "probe-cl-audit-1",
    sectionPath: "build/reports/audit.json#sectionW",
    attemptId: ATTEMPT_ID,
    valueDigest: "sha256:deadbeef",
  };
  const result = validateEvidenceObservation(entry, AUDIT_ITEM, { attemptId: ATTEMPT_ID });
  assert.equal(result.valid, true);
  assert.equal(result.satisfied, true);
});
