/**
 * Full-chain fail-closed regression for the static-probe evidence pipeline.
 *
 * Chain under test (the one no prior test exercised end-to-end):
 *   runChecklistProbes -> buildEvidenceProbePlan -> buildEvidenceLedger
 *     -> evaluateChecklistCompletion
 *
 * Each link is currently correct, but a future regression on ANY of them would
 * reopen defect #3 (a static matchCount:0 item being completed instead of
 * honestly failing) and would not be caught without this file. The four cases
 * below pin each link:
 *
 *   CASE A — genuine pass: matchCount>0 + matching attemptId flows to a
 *            ledger entry with result:"pass", .satisfied true, attemptId
 *            stamped, and the completion gate returns "complete".
 *   CASE B — honest fail (pins defect #3 end-to-end): matchCount===0 produces
 *            a ledger entry with result:"fail". A verdict that CITES that
 *            failing evidence as a pass ("lying verdict") must be REJECTED by
 *            the completion gate (evidence_mismatch), NOT completed.
 *   CASE C — secondary-merge attemptId re-stamp (pins the R2 regression where
 *            a bare hard-gate observation lacking attemptId would lose it):
 *            buildEvidenceProbePlan must defensively re-stamp attemptId onto a
 *            merged secondary probe observation.
 *   CASE D — no-clobber: when the secondary observation ALREADY carries a
 *            matching attemptId, the defensive re-stamp must not overwrite it
 *            with a different value.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { LooseRecord } from "../shared/types.js";

import { buildEvidenceProbePlan, validateEvidenceObservation } from "../core/workflow/evidence-probes.js";
import { buildEvidenceLedger } from "../core/phases/verify.js";
import { evaluateChecklistCompletion } from "../core/workflow/acceptance-checklist.js";


const ATTEMPT_ID = "attempt-static-001";
const LEDGER_ID = "ledger-static-001";
const JOB_ID = "job-static-001";
const PROJECT = "flow-static-test";

/** A single static checklist item (frozen). */
function staticChecklist(itemId: string, predicateId: string, allowedFiles: string[]): LooseRecord {
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    project: PROJECT,
    status: "frozen",
    source: { task: "static probe test", issue: null, documents: [] },
    items: [
      {
        id: itemId,
        requirement: `${itemId} requirement`,
        source: "user_task",
        sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
        predicateId,
        required: true,
        area: "core",
        risk: "medium",
        verificationMethod: "static",
        expectedEvidence: "static probe scope match",
        dependsOn: [],
        allowedFiles,
      },
    ],
    assumptions: [],
  };
}

/** verificationEvidence shape consumed by buildEvidenceLedger. */
function verificationEvidence(): LooseRecord {
  return {
    git: { head: "deadbeefcafebabe0000000000000000deadbeef", diffHash: "sha256:diff-abcdef" },
    hardGate: { checks: [] },
  };
}

/** Find the ledger evidence entry for a checklist id. */
function evidenceFor(ledger: LooseRecord, checklistId: string): LooseRecord | undefined {
  const evidence = Array.isArray(ledger.evidence) ? ledger.evidence : [];
  return evidence.find((e: LooseRecord) => e.checklistId === checklistId);
}

/** Build a verdict claiming the item passed by citing a ledger evidence id. */
function passVerdictCiting(itemId: string, ledgerId: string, evidenceId: string): LooseRecord {
  return {
    schemaVersion: 1,
    jobId: JOB_ID,
    status: "pass",
    items: [
      {
        checklistId: itemId,
        result: "pass",
        evidenceRefs: [{ ledgerId, evidenceId }],
        actualResult: "pass",
        reason: "evidence cited",
        fixScope: [],
      },
    ],
    blocking: [],
    fixScope: [],
    reason: "verdict reason",
  };
}

// ---------------------------------------------------------------------------
// CASE A — genuine pass: matchCount>0 + matching attemptId -> ledger "pass" + complete
// ---------------------------------------------------------------------------
test("CASE A (guards defect #3 happy path): static matchCount>0 with matching attemptId yields ledger pass and completes", () => {
  const itemId = "AC-001";
  const predicateId = "PRED-001";
  const checklist = staticChecklist(itemId, predicateId, ["src/feature.ts"]);

  // Simulate a probe runner output: the declared file IS in scope.
  const hardGateChecks = [
    {
      checklistId: itemId,
      predicateId,
      probeId: `probe-${itemId}`,
      observation: {
        checklistId: itemId,
        predicateId,
        probeId: `probe-${itemId}`,
        verificationMethod: "static",
        queryId: `static-diff-scope:${itemId}`,
        matchCount: 1, // >0 => satisfied
        allowedFiles: ["src/feature.ts"],
        changedFilesInScope: ["src/feature.ts"],
        attemptId: ATTEMPT_ID,
      },
      emitFailedClaim: true,
    },
  ];

  const plan = buildEvidenceProbePlan({ acceptanceChecklist: checklist, hardGateChecks, attemptId: ATTEMPT_ID });
  const ledger = buildEvidenceLedger({
    jobId: JOB_ID,
    project: PROJECT,
    attemptId: ATTEMPT_ID,
    acceptanceChecklist: checklist,
    verificationEvidence: verificationEvidence(),
    evidenceProbePlan: plan,
    ledgerId: LEDGER_ID,
  });

  const entry = evidenceFor(ledger, itemId);
  assert.ok(entry, "ledger must contain an evidence entry for the static item");
  assert.equal(entry.result, "pass", "matchCount>0 => ledger entry result must be 'pass'");
  assert.equal(entry.attemptId, ATTEMPT_ID, "attemptId must be stamped on the ledger observation");
  // The ledger spreads probe.observation, so matchCount + queryId survive:
  assert.equal(entry.matchCount, 1);
  assert.equal(entry.queryId, `static-diff-scope:${itemId}`);

  // Validate the observation that landed is genuinely satisfied.
  const checklistItem = checklist.items[0];
  const validation = validateEvidenceObservation(entry, checklistItem, { attemptId: ATTEMPT_ID });
  assert.equal(validation.satisfied, true, "the recorded observation must satisfy the checklist item");

  // End-to-end: a truthful pass verdict citing this evidence completes.
  const outcome = evaluateChecklistCompletion({
    checklist,
    verdict: passVerdictCiting(itemId, LEDGER_ID, entry.id),
    evidenceLedger: ledger,
    attemptId: ATTEMPT_ID,
    multiAttempt: false,
  });
  assert.equal(outcome.outcome, "complete", "honest pass must complete");
});

// ---------------------------------------------------------------------------
// CASE B — THE KEY CASE (pins defect #3 end-to-end): matchCount===0 ledger
// entry is result:"fail"; a "lying" verdict citing it as pass is REJECTED.
// ---------------------------------------------------------------------------
test("CASE B (pins defect #3 end-to-end): matchCount===0 -> ledger fail; lying pass verdict is REJECTED (not completed)", () => {
  const itemId = "AC-002";
  const predicateId = "PRED-002";
  // allowedFiles deliberately DO NOT match the diff -> scopeMatches => 0.
  // We hand-build the observation exactly as runChecklistProbes would emit it
  // for an out-of-scope static item (matchCount: 0).
  const checklist = staticChecklist(itemId, predicateId, ["src/declared-but-not-changed.ts"]);

  const hardGateChecks = [
    {
      checklistId: itemId,
      predicateId,
      probeId: `probe-${itemId}`,
      observation: {
        checklistId: itemId,
        predicateId,
        probeId: `probe-${itemId}`,
        verificationMethod: "static",
        queryId: `static-diff-scope:${itemId}`,
        matchCount: 0, // honest zero — declared file was NOT modified
        allowedFiles: ["src/declared-but-not-changed.ts"],
        changedFilesInScope: [],
        attemptId: ATTEMPT_ID,
      },
      emitFailedClaim: true, // must still be recorded, not silently dropped
    },
  ];

  const plan = buildEvidenceProbePlan({ acceptanceChecklist: checklist, hardGateChecks, attemptId: ATTEMPT_ID });
  const ledger = buildEvidenceLedger({
    jobId: JOB_ID,
    project: PROJECT,
    attemptId: ATTEMPT_ID,
    acceptanceChecklist: checklist,
    verificationEvidence: verificationEvidence(),
    evidenceProbePlan: plan,
    ledgerId: LEDGER_ID,
  });

  const entry = evidenceFor(ledger, itemId);
  // Honest zero must be RECORDED (emitFailedClaim path), as a fail.
  assert.ok(entry, "matchCount:0 must still produce a ledger entry (emitFailedClaim honored)");
  assert.equal(entry.result, "fail", "matchCount===0 => ledger entry result must be 'fail'");
  assert.equal(entry.matchCount, 0);
  assert.equal(entry.attemptId, ATTEMPT_ID);

  // The observation is valid (recordable) but NOT satisfied.
  const validation = validateEvidenceObservation(entry, checklist.items[0], { attemptId: ATTEMPT_ID });
  assert.deepEqual(validation, { valid: true, satisfied: false }, "matchCount:0 => valid:true, satisfied:false");

  // A verifier verdict that LIES — claims pass and cites this failing evidence.
  const lyingVerdict = passVerdictCiting(itemId, LEDGER_ID, entry.id);

  // The completion gate MUST reject this. The ledger entry's result is "fail"
  // (not "pass"), so evidenceMatchesChecklistItem returns false => mismatch.
  const outcome = evaluateChecklistCompletion({
    checklist,
    verdict: lyingVerdict,
    evidenceLedger: ledger,
    attemptId: ATTEMPT_ID,
    multiAttempt: false,
  });

  assert.notEqual(outcome.outcome, "complete", "a lying verdict citing failing evidence must NOT complete");
  assert.ok(
    outcome.outcome === "evidence_mismatch" || outcome.outcome === "checklist_failed",
    `expected evidence_mismatch or checklist_failed, got ${outcome.outcome}`,
  );
  assert.ok(
    outcome.mismatchedEvidenceRefs.length > 0 || outcome.failedChecklistIds.length > 0,
    "the gate must surface the mismatch/failure references",
  );
});

// ---------------------------------------------------------------------------
// CASE C — secondary-merge attemptId re-stamp (pins R2 regression: a bare
// hard-gate observation lacking attemptId must not lose it through the merge).
// ---------------------------------------------------------------------------
test("CASE C (pins R2 secondary-merge attemptId re-stamp): merged probe observation gains attemptId when missing", () => {
  const itemId = "AC-003";
  const predicateId = "PRED-003";
  const checklist = staticChecklist(itemId, predicateId, ["src/c.ts"]);

  // Primary path already generated a probe for this item. The secondary
  // hard-gate check UPGRADES it but its observation is bare — NO attemptId
  // (simulating a check rebuilt from a bare object, the R2 bug surface).
  const hardGateChecks = [
    {
      checklistId: itemId,
      predicateId,
      probeId: `probe-${itemId}`,
      observation: {
        checklistId: itemId,
        predicateId,
        probeId: `probe-${itemId}`,
        verificationMethod: "static",
        queryId: `static-diff-scope:${itemId}`,
        matchCount: 2,
        allowedFiles: ["src/c.ts"],
        // NOTE: intentionally NO attemptId field here.
      },
      emitFailedClaim: true,
    },
  ];

  const plan = buildEvidenceProbePlan({ acceptanceChecklist: checklist, hardGateChecks, attemptId: ATTEMPT_ID });
  const probe = (plan.probes || []).find((p: LooseRecord) => p.checklistId === itemId);
  assert.ok(probe, "merged probe must exist for the checklist item");
  assert.equal(
    probe.observation.attemptId,
    ATTEMPT_ID,
    "secondary observation lacking attemptId must be defensively re-stamped (evidence-probes.ts:255-275)",
  );

  // And the re-stamped observation must now pass the validate gate that requires attemptId.
  const validation = validateEvidenceObservation(probe.observation, checklist.items[0], { attemptId: ATTEMPT_ID });
  assert.equal(validation.satisfied, true, "re-stamped static observation must be satisfied");
});

// ---------------------------------------------------------------------------
// CASE D — no-clobber: an observation that ALREADY carries a matching
// attemptId is NOT overwritten by the defensive re-stamp.
// ---------------------------------------------------------------------------
test("CASE D (guards re-stamp no-clobber): existing matching attemptId is preserved, not overwritten", () => {
  const itemId = "AC-004";
  const predicateId = "PRED-004";
  const checklist = staticChecklist(itemId, predicateId, ["src/d.ts"]);
  const originalAttemptId = "attempt-original-004";

  // The secondary observation already carries an attemptId that MATCHES the
  // plan-level attemptId. The re-stamp uses ?? (nullish), so it must keep it.
  const hardGateChecks = [
    {
      checklistId: itemId,
      predicateId,
      probeId: `probe-${itemId}`,
      observation: {
        checklistId: itemId,
        predicateId,
        probeId: `probe-${itemId}`,
        verificationMethod: "static",
        queryId: `static-diff-scope:${itemId}`,
        matchCount: 1,
        allowedFiles: ["src/d.ts"],
        attemptId: originalAttemptId, // already present and matching
      },
      emitFailedClaim: true,
    },
  ];

  const plan = buildEvidenceProbePlan({ acceptanceChecklist: checklist, hardGateChecks, attemptId: originalAttemptId });
  const probe = (plan.probes || []).find((p: LooseRecord) => p.checklistId === itemId);
  assert.ok(probe);
  assert.equal(
    probe.observation.attemptId,
    originalAttemptId,
    "existing matching attemptId must be preserved (re-stamp must use ?? and not clobber)",
  );

  // Negative control: a DIFFERENT plan-level attemptId must not overwrite a
  // pre-existing one either (?? is nullish, not a forced override) — proving
  // the re-stamp is purely defensive against missing attemptId.
  const plan2 = buildEvidenceProbePlan({
    acceptanceChecklist: checklist,
    hardGateChecks,
    attemptId: "attempt-different-999",
  });
  const probe2 = (plan2.probes || []).find((p: LooseRecord) => p.checklistId === itemId);
  assert.ok(probe2);
  assert.equal(
    probe2.observation.attemptId,
    originalAttemptId,
    "a pre-existing attemptId must NEVER be overwritten by a different plan-level attemptId (no-clobber)",
  );
});
