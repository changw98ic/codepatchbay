/**
 * Adversarial Round 4: fixScope must contain ONLY file paths, never checklist IDs.
 *
 * The checklist verdict's fixScope field is meant to list repo-relative file paths
 * that the executor touched or should touch. A compromised verifier could inject
 * checklist IDs (e.g. "AC-002") into fixScope — these pass isRepoRelativePosixPath
 * validation (non-empty, no leading /, no backslash, no ..) but are semantically
 * wrong. Checklist IDs belong in targetChecklistIds, not fixScope.
 *
 * This test asserts:
 *   1. validateChecklistVerdict rejects verdict.fixScope containing /^AC-\d+$/
 *   2. validateChecklistVerdict rejects item-level fixScope containing /^AC-\d+$/
 *   3. evaluateChecklistCompletion rejects verdicts with checklist IDs in fixScope
 *   4. buildRetrySourceContext keeps targetChecklistIds and fixScope separate
 *   5. Positive control: legitimate file paths in fixScope pass validation
 *
 * Attack vectors tested:
 *   1. Top-level verdict.fixScope contains "AC-002" → verdict_invalid
 *   2. Item-level item.fixScope contains "AC-003" → verdict_invalid
 *   3. Mixed: real file path + checklist ID in fixScope → verdict_invalid
 *   4. Exactly the AC-\\d+ pattern with zero padding → verdict_invalid
 *   5. Positive control: only file paths → passes validation
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { LooseRecord } from "../shared/types.js";

import { validateChecklistVerdict } from "../core/workflow/acceptance-checklist.js";
import { evaluateChecklistCompletion } from "../core/workflow/acceptance-checklist.js";
import { buildRetrySourceContext } from "../server/orchestrator/reconciler.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────


function frozenChecklist(items: LooseRecord[] = [defaultItem()]) {
  return {
    schemaVersion: 1,
    jobId: "job-fixscope",
    project: "flow",
    status: "frozen",
    source: { task: "task", issue: null, documents: [] },
    items,
    assumptions: [],
  };
}

function defaultItem(overrides: LooseRecord = {}) {
  return {
    id: "AC-001",
    requirement: "required behavior",
    source: "user_task",
    sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: null }],
    predicateId: "PRED-001",
    required: true,
    area: "cli",
    risk: "medium",
    verificationMethod: "command",
    expectedEvidence: "command output",
    dependsOn: [],
    allowedFiles: [],
    ...overrides,
  };
}

function passingVerdict(overrides: LooseRecord = {}) {
  return {
    schemaVersion: 1,
    jobId: "job-fixscope",
    status: "pass",
    items: [{
      checklistId: "AC-001",
      result: "pass",
      evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
      actualResult: "ok",
      reason: "ok",
      fixScope: [],
    }],
    blocking: [],
    fixScope: [],
    reason: "passed",
    ...overrides,
  };
}

function legitimateEvidenceLedger() {
  return {
    schemaVersion: 1,
    jobId: "job-fixscope",
    project: "flow",
    ledgerId: "ledger-001",
    attemptId: "attempt-001",
    finalWorktree: { head: "abc123", diffHash: "sha256:legit" },
    evidence: [
      {
        id: "EV-001",
        type: "evidence_claim",
        observationType: "command",
        checklistId: "AC-001",
        attemptId: "attempt-001",
        verificationMethod: "command",
        predicateId: "PRED-001",
        probeId: "probe-test",
        result: "pass",
        command: "npm test",
        exitCode: 0,
        stdoutSha256: "sha256:stdout-1",
        summary: "passed",
        worktreeHead: "abc123",
        diffHash: "sha256:legit",
      },
    ],
  };
}

// ─── Test 1: Top-level verdict.fixScope contains "AC-002" → rejected ──────

test("adversarial round 4: verdict.fixScope containing AC-002 checklist ID → verdict_invalid", () => {
  const checklist = frozenChecklist([
    defaultItem({ id: "AC-001" }),
    defaultItem({ id: "AC-002", predicateId: "PRED-002" }),
  ]);

  const verdict = passingVerdict({
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
      {
        checklistId: "AC-002",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
    ],
    fixScope: ["AC-002"],
  });

  const result = validateChecklistVerdict(verdict, checklist);

  assert.equal(result.ok, false, "verdict with AC-002 in fixScope must be rejected");
  assert.ok(
    result.reason.toLowerCase().includes("fixscope"),
    `rejection reason must mention fixScope, got: ${result.reason}`,
  );
  assert.ok(
    /AC-\d+/.test(result.reason) || result.reason.includes("checklist"),
    `rejection reason should reference the checklist ID pattern, got: ${result.reason}`,
  );
});

// ─── Test 2: Item-level fixScope contains "AC-003" → rejected ─────────────

test("adversarial round 4: item.fixScope containing AC-003 checklist ID → verdict_invalid", () => {
  const checklist = frozenChecklist([
    defaultItem({ id: "AC-001" }),
    defaultItem({ id: "AC-003", predicateId: "PRED-003" }),
  ]);

  const verdict = passingVerdict({
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
      {
        checklistId: "AC-003",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: ["AC-003"],
      },
    ],
    fixScope: [],
  });

  const result = validateChecklistVerdict(verdict, checklist);

  assert.equal(result.ok, false, "item-level fixScope with AC-003 must be rejected");
  assert.ok(
    result.reason.includes("fixScope"),
    `rejection reason must mention fixScope, got: ${result.reason}`,
  );
});

// ─── Test 3: Mixed real file path + checklist ID in fixScope → rejected ───

test("adversarial round 4: mix of real path and AC-002 in fixScope → verdict_invalid", () => {
  const checklist = frozenChecklist([
    defaultItem({ id: "AC-001" }),
    defaultItem({ id: "AC-002", predicateId: "PRED-002" }),
  ]);

  const verdict = passingVerdict({
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
      {
        checklistId: "AC-002",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
    ],
    // A real file path mixed with a checklist ID
    fixScope: ["cli/commands/status.ts", "AC-002"],
  });

  const result = validateChecklistVerdict(verdict, checklist);

  assert.equal(result.ok, false, "fixScope mixing file paths and checklist IDs must be rejected");
  assert.ok(
    result.reason.includes("fixScope"),
    `rejection reason must mention fixScope, got: ${result.reason}`,
  );
});

// ─── Test 4: Various AC-\\d+ patterns → all rejected ─────────────────────

test("adversarial round 4: AC-001 pattern in fixScope → rejected", () => {
  const verdict = passingVerdict({ fixScope: ["AC-001"] });
  const checklist = frozenChecklist();
  const result = validateChecklistVerdict(verdict, checklist);

  assert.equal(result.ok, false, "AC-001 in fixScope must be rejected");
});

test("adversarial round 4: AC-999 pattern in fixScope → rejected", () => {
  const verdict = passingVerdict({ fixScope: ["AC-999"] });
  const checklist = frozenChecklist();
  const result = validateChecklistVerdict(verdict, checklist);

  assert.equal(result.ok, false, "AC-999 in fixScope must be rejected");
});

test("adversarial round 4: AC-1000 (large number) pattern in fixScope → rejected", () => {
  const verdict = passingVerdict({ fixScope: ["AC-1000"] });
  const checklist = frozenChecklist();
  const result = validateChecklistVerdict(verdict, checklist);

  assert.equal(result.ok, false, "AC-1000 in fixScope must be rejected");
});

// ─── Test 5: Positive control — legitimate file paths in fixScope → passes ─

test("adversarial round 4: positive control — file paths in fixScope pass validation", () => {
  const checklist = frozenChecklist();
  const verdict = passingVerdict({
    fixScope: ["cli/commands/status.ts", "core/engine/run-job.ts", "src/"],
  });

  const result = validateChecklistVerdict(verdict, checklist);

  assert.equal(result.ok, true, `legitimate file paths in fixScope must pass, got: ${result.reason}`);
});

// ─── Test 6: evaluateChecklistCompletion also rejects fixScope with checklist IDs

test("adversarial round 4: evaluateChecklistCompletion rejects fixScope with AC-002", () => {
  const checklist = frozenChecklist([
    defaultItem({ id: "AC-001" }),
    defaultItem({ id: "AC-002", predicateId: "PRED-002" }),
  ]);

  const verdict = {
    schemaVersion: 1,
    jobId: "job-fixscope",
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
      {
        checklistId: "AC-002",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
    ],
    blocking: [],
    fixScope: ["AC-002"],
    reason: "passed",
  };

  const result = evaluateChecklistCompletion({
    checklist,
    verdict,
    evidenceLedger: legitimateEvidenceLedger(),
    executionMap: { unmappedChangedFiles: [] },
    attemptId: "attempt-001",
  });

  assert.equal(result.outcome, "checklist_invalid",
    `expected checklist_invalid for checklist ID in fixScope, got: ${result.outcome} — ${result.reason}`);
});

// ─── Test 7: buildRetrySourceContext keeps targetChecklistIds and fixScope separate

test("adversarial round 4: buildRetrySourceContext targetChecklistIds has AC-002 but fixScope does not", () => {
  const result = {
    jobResult: {
      jobId: "job-fixscope-retry",
      failure: {
        kind: "verification_failed",
        phase: "verify",
        reason: "AC-002 failed",
        retryable: true,
        cause: {
          verdict: {
            status: "fail",
            reason: "checklist item failed",
            blocking: [],
            fix_scope: ["cli/commands/status.ts"],
            checklistVerdict: {
              items: [
                { checklistId: "AC-001", result: "pass", fixScope: [], evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }] },
                { checklistId: "AC-002", result: "fail", fixScope: ["cli/commands/status.ts"], evidenceRefs: [] },
              ],
              fixScope: ["cli/commands/status.ts"],
            },
          },
          artifact: {
            kind: "verdict",
            id: "123456",
            name: "verdict-123456",
            path: "/tmp/verdict-123456.md",
          },
        },
      },
    },
  };

  const sourceContext = buildRetrySourceContext(
    { attempts: 1, metadata: { failureCount: 1 }, sourceContext: {} },
    { attempt: 1 },
    result,
    { action: "retry_same_worker", reason: "verification failed: AC-002 failed", retryable: true, retryPhase: "execute" },
  );

  // targetChecklistIds MUST contain "AC-002"
  assert.ok(
    sourceContext.retry.targetChecklistIds.includes("AC-002"),
    `targetChecklistIds must contain AC-002, got: ${JSON.stringify(sourceContext.retry.targetChecklistIds)}`,
  );

  // fixScope must NOT contain any AC-\\d+ pattern
  const fixScopeHasChecklistId = sourceContext.retry.fixScope.some(
    (entry: string) => /^AC-\d+$/.test(entry),
  );
  assert.equal(
    fixScopeHasChecklistId,
    false,
    `fixScope must not contain checklist IDs, got: ${JSON.stringify(sourceContext.retry.fixScope)}`,
  );

  // fixScope should contain only file paths
  assert.deepEqual(
    sourceContext.retry.fixScope,
    ["cli/commands/status.ts"],
    "fixScope should contain only the file path",
  );
});

// ─── Test 8: Edge case — fixScope is entirely checklist IDs → rejected ────

test("adversarial round 4: fixScope with only checklist IDs → rejected", () => {
  const checklist = frozenChecklist([
    defaultItem({ id: "AC-001" }),
    defaultItem({ id: "AC-002", predicateId: "PRED-002" }),
  ]);

  const verdict = passingVerdict({
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
      {
        checklistId: "AC-002",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: [],
      },
    ],
    fixScope: ["AC-001", "AC-002"],
  });

  const result = validateChecklistVerdict(verdict, checklist);

  assert.equal(result.ok, false, "fixScope with only checklist IDs must be rejected");
});

// ─── Test 9: Item-level fixScope with checklist ID while top-level is clean ─

test("adversarial round 4: item fixScope with AC-001, top-level fixScope clean → rejected", () => {
  const checklist = frozenChecklist();
  const verdict = passingVerdict({
    items: [{
      checklistId: "AC-001",
      result: "pass",
      evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
      actualResult: "ok",
      reason: "ok",
      fixScope: ["AC-001"],
    }],
    fixScope: ["cli/commands/status.ts"],
  });

  const result = validateChecklistVerdict(verdict, checklist);

  assert.equal(result.ok, false, "item-level fixScope with checklist ID must be rejected even when top-level is clean");
  assert.ok(result.reason.includes("fixScope"), `reason must mention fixScope, got: ${result.reason}`);
});

// ─── Test 10: No element of fixScope matches /^AC-\d+$/ — explicit assertion

test("adversarial round 4: no element of fixScope matches /^AC-\\d+$/ pattern", () => {
  const checklist = frozenChecklist([
    defaultItem({ id: "AC-001" }),
    defaultItem({ id: "AC-002", predicateId: "PRED-002" }),
  ]);

  const verdict = passingVerdict({
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: ["src/index.ts"],
      },
      {
        checklistId: "AC-002",
        result: "pass",
        evidenceRefs: [{ ledgerId: "ledger-001", evidenceId: "EV-001" }],
        actualResult: "ok",
        reason: "ok",
        fixScope: ["lib/utils.ts"],
      },
    ],
    fixScope: ["src/index.ts", "lib/utils.ts"],
  });

  const result = validateChecklistVerdict(verdict, checklist);

  // First verify it passes with legitimate paths
  assert.equal(result.ok, true, `legitimate fixScope should pass, got: ${result.reason}`);

  // Explicitly assert no element matches the checklist ID pattern
  const allFixScopes = [
    ...verdict.fixScope,
    ...verdict.items.flatMap((item: LooseRecord) => item.fixScope || []),
  ];
  for (const entry of allFixScopes) {
    assert.equal(
      /^AC-\d+$/.test(entry),
      false,
      `fixScope entry "${entry}" must not match checklist ID pattern /^AC-\\d+$/`,
    );
  }
});
