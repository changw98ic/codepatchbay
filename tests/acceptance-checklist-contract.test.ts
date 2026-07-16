import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeRepoRelativePaths,
  validateAcceptanceChecklist,
  validateDecomposedItems,
  validateChecklistSourceCoverage,
  validateChecklistVerdict,
  evaluateChecklistCompletion,
  classifyAcceptanceRequirements,
  buildAcceptanceChecklist,
  extractTaskRequirementSlices,
} from "../core/workflow/acceptance-checklist.js";

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

test("acceptance checklist freezes and hashes pre-execution observable contracts", async () => {
  const built = await buildAcceptanceChecklist({
    jobId: "job-observable",
    project: "flow",
    task: "Fix the user-visible diagnostic message",
    decomposedItems: [{
      requirement: "The diagnostic names the missing values",
      predicateId: "diagnostic-values",
      verificationMethod: "static",
      allowedFiles: ["src/diagnostic.ts"],
      sourceRefs: [{ kind: "task_text", locator: "task:0" }],
      expectedEvidence: "The diagnostic preserves collection boundaries",
      observableContract: {
        observationKind: "contains_text",
        probeInput: "Trigger the mismatch for expected [a,b] and found [a]",
        expectedObservation: "expected [a,b] but found [a]",
        forbiddenObservations: ["expected '[a,b]' but found '[a]'"],
        oracleSourceRefs: [{ kind: "task_text", locator: "task:0" }],
        candidateIndependent: true,
      },
    }],
  });
  const builtItems = (built as unknown as { items: Array<Record<string, unknown>> }).items;
  const contract = builtItems[0].observableContract as Record<string, unknown>;
  assert.equal(contract.contractId, "OBS-001");
  assert.equal(contract.frozenBeforeExecution, true);
  assert.match(String(contract.contractSha256), /^sha256:[a-f0-9]{64}$/);
  assert.equal(validateAcceptanceChecklist(built).ok, true);

  const tampered = structuredClone(built) as unknown as { items: Array<Record<string, unknown>> };
  (tampered.items[0].observableContract as Record<string, unknown>).expectedObservation = "candidate-derived output";
  const tamperedValidation = validateAcceptanceChecklist(tampered);
  assert.equal(tamperedValidation.ok, false);
  assert.match(tamperedValidation.reason, /does not match the frozen contract/);
});

test("explicit task bullets become separate fail-closed requirement slices", async () => {
  const task = `Migrate the storage behavior:\n- Warn callers during the transition.\n- Remove the legacy conversion in version 2.`;
  assert.deepEqual(extractTaskRequirementSlices(task).map((entry) => entry.locator), [
    "task:0",
    "task:bullet:1",
    "task:bullet:2",
  ]);
  const classification = await classifyAcceptanceRequirements({ task });
  assert.deepEqual(classification.classifiedRequirements.map((entry) => entry.locator), [
    "task:0",
    "task:bullet:1",
    "task:bullet:2",
  ]);

  const result = validateChecklistSourceCoverage({
    checklist: checklist({
      source: { task, issue: null, documents: [] },
      items: [{
        ...checklist().items[0],
        sourceRefs: [
          { kind: "task_text", locator: "task:0" },
          { kind: "task_text", locator: "task:bullet:1" },
        ],
      }],
    }),
    task,
    requirementClassification: classification,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /task:bullet:2/);
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

test("checklist validation rejects unsatisfiable real-path evidence contracts", () => {
  for (const item of [
    {
      ...checklist().items[0],
      verificationMethod: "static",
      requiresRealPathEvidence: true,
      evidenceOrigin: "deterministic_probe",
    },
    {
      ...checklist().items[0],
      verificationMethod: "command",
      requiresRealPathEvidence: true,
      evidenceOrigin: "agent_written",
    },
  ]) {
    const result = validateAcceptanceChecklist(checklist({ items: [item] }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /cannot be satisfied/);
  }
});

test("decomposed checklist rejects real-path requirements that available evidence cannot satisfy", () => {
  const result = validateDecomposedItems([{
    requirement: "real endpoint returns JSON",
    predicateId: "real-endpoint-json",
    verificationMethod: "static",
    allowedFiles: ["server/route.ts"],
    evidenceOrigin: "agent_written",
    requiresRealPathEvidence: true,
  }]);

  assert.equal(result.ok, false);
  assert.match(result.reason, /cannot be satisfied/);
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

test("validateChecklistSourceCoverage accepts repo-local document refs within item scope", () => {
  const item = {
    ...checklist().items[0],
    sourceRefs: [{ kind: "document", locator: "cli/commands/status.ts:42" }],
  };
  const result = validateChecklistSourceCoverage({
    checklist: checklist({ items: [item] }),
    task: "add json output",
  });
  assert.equal(result.ok, true);
});

test("validateChecklistSourceCoverage accepts repo file aliases with line locators within item scope", () => {
  const item = {
    ...checklist().items[0],
    sourceRefs: [
      { kind: "task_text", locator: "task:0" },
      { kind: "repo", locator: "cli/commands/status.ts:42" },
    ],
  };
  const result = validateChecklistSourceCoverage({
    checklist: checklist({ items: [item] }),
    task: "add json output",
  });
  assert.equal(result.ok, true);
});

test("validateChecklistSourceCoverage accepts repository_path aliases within item scope", () => {
  const item = {
    ...checklist().items[0],
    sourceRefs: [
      { kind: "task_text", locator: "task:0" },
      { kind: "repository_path", locator: "cli/commands/status.ts" },
    ],
  };
  const result = validateChecklistSourceCoverage({
    checklist: checklist({ items: [item] }),
    task: "add json output",
  });
  assert.equal(result.ok, true, result.reason);
});

test("validateChecklistSourceCoverage accepts repository aliases with line locators within item scope", () => {
  const item = {
    ...checklist().items[0],
    sourceRefs: [
      { kind: "task_text", locator: "task:0" },
      { kind: "repository", locator: "cli/commands/status.ts:42" },
    ],
  };
  const result = validateChecklistSourceCoverage({
    checklist: checklist({ items: [item] }),
    task: "add json output",
  });
  assert.equal(result.ok, true, result.reason);
});

test("validateChecklistSourceCoverage accepts colon-style line ranges within item scope", () => {
  const item = {
    ...checklist().items[0],
    sourceRefs: [
      { kind: "task_text", locator: "task:0" },
      { kind: "repo_file", locator: "cli/commands/status.ts:42-90" },
    ],
  };
  const result = validateChecklistSourceCoverage({
    checklist: checklist({ items: [item] }),
    task: "add json output",
  });
  assert.equal(result.ok, true, result.reason);
});

test("validateChecklistSourceCoverage rejects repo-local document refs outside item scope", () => {
  const item = {
    ...checklist().items[0],
    sourceRefs: [{ kind: "document", locator: "server/routes/status.ts:42" }],
  };
  const result = validateChecklistSourceCoverage({
    checklist: checklist({ items: [item] }),
    task: "add json output",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing checklist source ref/);
});

test("validateChecklistSourceCoverage accepts read-only repository evidence outside edit scope when frozen", () => {
  const item = {
    ...checklist().items[0],
    sourceRefs: [
      { kind: "task_text", locator: "task:0" },
      { kind: "repo_file", locator: "src/caller.ts:42" },
    ],
    allowedFiles: ["src/target.ts"],
  };
  const result = validateChecklistSourceCoverage({
    checklist: checklist({ items: [item] }),
    task: "Fix target behavior",
    evidenceLocators: ["src/caller.ts:42"],
  });
  assert.equal(result.ok, true, result.reason);
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
  assert.equal(result.evidenceMissingCause, "probe_available_not_run");
});

test("evaluateChecklistCompletion derives implementation repair scope from the frozen checklist", () => {
  const failedLedger = {
    ...ledger,
    evidence: [{ ...ledger.evidence[0], result: "fail", exitCode: 1 }],
  };
  const verdict = {
    schemaVersion: 1,
    jobId: "job-1",
    status: "fail",
    items: [{
      checklistId: "AC-001",
      result: "unchecked",
      evidenceRefs: [],
      actualResult: "probe failed",
      reason: "objective command failed",
      fixScope: [],
    }],
    blocking: [{ checklistId: "AC-001" }],
    fixScope: [],
    reason: "not satisfied",
  };
  const result = evaluateChecklistCompletion({
    checklist: checklist(),
    verdict,
    evidenceLedger: failedLedger,
    executionMap: { unmappedChangedFiles: [] },
  });

  assert.equal(result.outcome, "checklist_incomplete");
  assert.equal(result.evidenceMissingCause, "implementation_gap");
  assert.deepEqual(result.failedFixScope, ["cli/commands/status.ts"]);
});

test("evaluateChecklistCompletion distinguishes missing probe definitions from implementation failures", () => {
  const noProbeLedger = {
    ...ledger,
    evidence: [{
      ...ledger.evidence[0],
      result: "fail",
      command: undefined,
      exitCode: undefined,
      note: "command checklist item has no trusted structured probe at HEAD",
    }],
  };
  const verdict = {
    schemaVersion: 1,
    jobId: "job-1",
    status: "pass",
    items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-missing" }], actualResult: "claimed", reason: "claimed", fixScope: [] }],
    blocking: [],
    fixScope: [],
    reason: "claimed pass",
  };
  const result = evaluateChecklistCompletion({ checklist: checklist(), verdict, evidenceLedger: noProbeLedger, executionMap: { unmappedChangedFiles: [] } });
  assert.equal(result.outcome, "evidence_missing");
  assert.equal(result.evidenceMissingCause, "probe_definition_missing");
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

test("evaluateChecklistCompletion blocks external oracle evidence from executor-modified acceptance files", () => {
  const oracleChecklist = checklist({
    items: [{
      ...checklist().items[0],
      sourceRefs: [{ kind: "document", locator: "tests/status.acceptance.test.ts:1" }],
      requiredEvidenceOrigin: "user_required",
      expectedEvidence: "node --test tests/status.acceptance.test.ts",
    }],
  });
  const oracleLedger = {
    ...ledger,
    evidence: [{
      ...ledger.evidence[0],
      evidenceOrigin: "user_required",
      command: "node --test tests/status.acceptance.test.ts",
      changedFilesInScope: ["cli/commands/status.ts"],
    }],
  };
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
    checklist: oracleChecklist,
    verdict,
    evidenceLedger: oracleLedger,
    executionMap: {
      changedFiles: ["cli/commands/status.ts", "tests/status.acceptance.test.ts"],
      unmappedChangedFiles: [],
    },
  });

  assert.equal(result.outcome, "oracle_polluted");
  assert.deepEqual(result.pollutedEvidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
  assert.deepEqual(result.pollutedOracleFiles, ["tests/status.acceptance.test.ts"]);
});

test("evaluateChecklistCompletion accepts external oracle evidence with clean replay provenance", () => {
  const oracleChecklist = checklist({
    items: [{
      ...checklist().items[0],
      requiredEvidenceOrigin: "user_required",
      expectedEvidence: "node --test tests/status.acceptance.test.ts",
    }],
  });
  const oracleLedger = {
    ...ledger,
    evidence: [{
      ...ledger.evidence[0],
      evidenceOrigin: "user_required",
      command: "node --test tests/status.acceptance.test.ts",
      cleanOracleReplayPassed: true,
      changedFilesInScope: ["cli/commands/status.ts"],
    }],
  };
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
    checklist: oracleChecklist,
    verdict,
    evidenceLedger: oracleLedger,
    executionMap: {
      changedFiles: ["cli/commands/status.ts", "tests/status.acceptance.test.ts"],
      unmappedChangedFiles: [],
    },
  });

  assert.equal(result.outcome, "complete");
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
