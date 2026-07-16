import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyScopeAmendment,
  buildScopeReviewRequest,
  consensusScopeAmendment,
  validateScopeReview,
} from "../core/workflow/scope-amendment.js";

const checklist = {
  items: [
    { id: "AC-001", requirement: "preserve warning behavior", allowedFiles: ["src/table.py"], required: true, risk: "medium" },
    { id: "AC-002", requirement: "preserve repository tests", allowedFiles: ["tests/"], required: true, risk: "high" },
  ],
};

const executionMap = {
  changedFiles: ["src/table.py", "setup.cfg"],
  unmappedChangedFiles: ["setup.cfg"],
  mappings: [{ checklistId: "AC-001", changedFiles: ["src/table.py"] }],
};

function request() {
  const value = buildScopeReviewRequest({ executionMap, checklist, candidateId: "sha256:candidate" });
  assert.ok(value);
  return value;
}

function review(overrides: Record<string, unknown> = {}) {
  const frozen = request();
  return {
    candidateId: frozen.candidateId,
    requestHash: frozen.requestHash,
    decision: "approve",
    unmappedFiles: frozen.unmappedFiles,
    mappings: [{
      file: "setup.cfg",
      checklistIds: ["AC-001"],
      necessity: "The repository warning policy must ignore this exact compatibility warning.",
      risk: "The ignore is message- and module-scoped to avoid hiding unrelated warnings.",
      evidence: ["Inspected exact setup.cfg diff and warning-as-error test path."],
    }],
    ...overrides,
  };
}

test("scope review is absent when the candidate has no unmapped files", () => {
  const frozen = buildScopeReviewRequest({
    executionMap: { ...executionMap, unmappedChangedFiles: [] },
    checklist,
    candidateId: "sha256:candidate",
  });
  assert.equal(frozen, null);
  assert.deepEqual(validateScopeReview(null, frozen), {
    required: false,
    ok: true,
    reason: "candidate has no unmapped changed files",
  });
});

test("scope review validates exact candidate, file set, checklist ids, and evidence", () => {
  const validation = validateScopeReview(review(), request());
  assert.equal(validation.ok, true);
  assert.equal(validation.decision, "approve");
  assert.deepEqual(validation.canonicalMappings, [{ file: "setup.cfg", checklistIds: ["AC-001"] }]);
});

test("scope review fails closed on identity, scope, authority, and rationale mismatches", () => {
  const frozen = request();
  const cases = [
    review({ candidateId: "sha256:other" }),
    review({ requestHash: "sha256:other" }),
    review({ unmappedFiles: ["setup.cfg", "tox.ini"] }),
    review({ mappings: [{ ...review().mappings[0], checklistIds: ["AC-999"] }] }),
    review({ mappings: [review().mappings[0], review().mappings[0]] }),
    review({ mappings: [{ ...review().mappings[0], necessity: "" }] }),
    review({ mappings: [{ ...review().mappings[0], risk: "" }] }),
    review({ mappings: [{ ...review().mappings[0], evidence: [] }] }),
  ];
  for (const candidate of cases) assert.equal(validateScopeReview(candidate, frozen).ok, false);
});

test("scope review converts unsafe agent paths into invalid verdicts instead of throwing", () => {
  const frozen = request();
  for (const candidate of [
    review({ unmappedFiles: ["../setup.cfg"] }),
    review({ mappings: [{ ...review().mappings[0], file: "../setup.cfg" }] }),
    review({ mappings: [{ ...review().mappings[0], file: "/tmp/setup.cfg" }] }),
  ]) {
    assert.doesNotThrow(() => validateScopeReview(candidate, frozen));
    assert.equal(validateScopeReview(candidate, frozen).ok, false);
  }
});

test("identical passing verifier reviews produce a durable amendment without mutating the original map", () => {
  const frozen = request();
  const approval = review();
  const consensus = consensusScopeAmendment({
    request: frozen,
    phaseResults: [
      { phase: "verify", status: "passed", diagnostics: { verdict: { scopeReview: approval } } },
      { phase: "adversarial_verify", status: "passed", diagnostics: { verdict: { scopeReview: approval } } },
    ],
  });
  assert.equal(consensus.approved, true);
  assert.match(String(consensus.amendment?.amendmentHash), /^sha256:/);
  const amended = applyScopeAmendment(executionMap, consensus.amendment || {});
  assert.deepEqual(amended.unmappedChangedFiles, []);
  assert.deepEqual(executionMap.unmappedChangedFiles, ["setup.cfg"]);
  assert.ok((amended.mappings as Record<string, unknown>[]).some((entry) => (
    entry.source === "dual_verifier_scope_amendment"
    && (entry.changedFiles as string[]).includes("setup.cfg")
  )));
});

test("scope amendment requires two passing verifiers with identical mappings", () => {
  const frozen = request();
  const approval = review();
  const variants = [
    [{ phase: "verify", status: "passed", diagnostics: { verdict: { scopeReview: approval } } }],
    [
      { phase: "verify", status: "passed", diagnostics: { verdict: { scopeReview: approval } } },
      { phase: "adversarial_verify", status: "failed", diagnostics: { verdict: { scopeReview: approval } } },
    ],
    [
      { phase: "verify", status: "passed", diagnostics: { verdict: { scopeReview: approval } } },
      { phase: "adversarial_verify", status: "passed", diagnostics: { verdict: { scopeReview: review({ decision: "deny", mappings: [] }) } } },
    ],
    [
      { phase: "verify", status: "passed", diagnostics: { verdict: { scopeReview: approval } } },
      { phase: "adversarial_verify", status: "passed", diagnostics: { verdict: { scopeReview: review({
        mappings: [{ ...review().mappings[0], checklistIds: ["AC-002"] }],
      }) } } },
    ],
  ];
  for (const phaseResults of variants) {
    assert.equal(consensusScopeAmendment({ request: frozen, phaseResults }).approved, false);
  }
});
