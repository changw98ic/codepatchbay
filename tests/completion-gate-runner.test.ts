import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { runCompletionGate } from "../core/engine/completion-gate-runner.js";
import { captureCandidateArtifact } from "../core/engine/candidate-artifact.js";
import { createCandidateReplayBundle } from "../core/engine/candidate-replay.js";
import { buildScopeReviewRequest } from "../core/workflow/scope-amendment.js";
import { tempRoot } from "./helpers.js";

const execFile = promisify(execFileCb);

test("runCompletionGate appends a complete gate event and completes the job", async () => {
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];
  const completed: string[] = [];
  const phaseResults = [{
    phase: "verify",
    status: "passed",
    verdict: "VERDICT: PASS",
  }];

  const result = await runCompletionGate({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-complete",
    job: { workflow: "standard", planMode: "full" },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    riskMap: {},
    dynamicAgentPlan: {},
    phaseResults,
    appendEvent: async (_cpbRoot, _project, _jobId, event) => {
      events.push(event);
    },
    failJob: async () => {
      throw new Error("failJob should not be called");
    },
    completeJob: async (_cpbRoot, _project, jobId) => {
      completed.push(jobId);
    },
    onProgress: async (event) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(completed, ["job-complete"]);
  assert.equal(events.length, 1);
  assert.deepEqual({ ...events[0], ts: "<dynamic>" }, {
    type: "completion_gate_evaluated",
    jobId: "job-complete",
    project: "proj",
    attemptId: null,
    outcome: "complete",
    reason: "All required completion gates passed",
    missingGates: [],
    checklistOutcome: null,
    failedChecklistIds: [],
    uncheckedChecklistIds: [],
    missingEvidenceRefs: [],
    mismatchedEvidenceRefs: [],
    staleEvidenceRefs: [],
    poisonedEvidenceRefs: [],
    pollutedEvidenceRefs: [],
    pollutedOracleFiles: [],
    pollutedOracleFileCount: 0,
    runtimeFailureRefs: [],
    runtimeFailureCount: 0,
    unmappedChangedFiles: [],
    unmappedChangedFileCount: 0,
    ts: "<dynamic>",
  });
  assert.deepEqual(progress, [
    {
      ts: "2026-06-22T00:00:00.000Z",
      type: "completion_gate_passed",
      jobId: "job-complete",
      project: "proj",
    },
    {
      ts: "2026-06-22T00:00:00.000Z",
      type: "job_completed",
      jobId: "job-complete",
      project: "proj",
    },
  ]);
});

test("runCompletionGate fails closed when the candidate changes after verification", async () => {
  const sourcePath = await tempRoot("cpb-completion-candidate");
  await execFile("git", ["init"], { cwd: sourcePath });
  await execFile("git", ["config", "user.email", "cpb@example.invalid"], { cwd: sourcePath });
  await execFile("git", ["config", "user.name", "CPB Test"], { cwd: sourcePath });
  await writeFile(path.join(sourcePath, "target.txt"), "base\n", "utf8");
  await execFile("git", ["add", "target.txt"], { cwd: sourcePath });
  await execFile("git", ["commit", "-m", "base"], { cwd: sourcePath });
  await writeFile(path.join(sourcePath, "target.txt"), "candidate one\n", "utf8");
  const candidateArtifact = await captureCandidateArtifact({ cwd: sourcePath });
  await writeFile(path.join(sourcePath, "target.txt"), "candidate two\n", "utf8");

  const events: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  let completed = false;
  const result = await runCompletionGate({
    cpbRoot: sourcePath,
    sourcePath,
    project: "proj",
    jobId: "job-candidate-drift",
    job: { workflow: "standard", planMode: "full" },
    workflowDag: { nodes: [{ id: "execute", phase: "execute" }, { id: "verify", phase: "verify" }] },
    riskMap: {},
    phaseResults: [
      { phase: "execute", status: "passed", diagnostics: { candidateArtifact } },
      {
        phase: "verify",
        status: "passed",
        verdict: "VERDICT: PASS",
        diagnostics: { validatedCandidateIdentityHash: candidateArtifact.identityHash },
      },
    ],
    appendEvent: async (_cpbRoot, _project, _jobId, event) => { events.push(event); },
    failJob: async (_cpbRoot, _project, _jobId, failure) => { failures.push(failure); },
    completeJob: async () => { completed = true; },
  });

  assert.equal(result.status, "failed");
  assert.equal(completed, false);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0].reason), /candidate changed before completion/i);
  assert.ok(events.some((event) => event.type === "candidate_identity_checked" && event.matches === false));
});

test("runCompletionGate returns candidate identity and clean replay evidence on success", async () => {
  const sourcePath = await tempRoot("cpb-completion-candidate-report");
  try {
    await execFile("git", ["init"], { cwd: sourcePath });
    await execFile("git", ["config", "user.email", "cpb@example.invalid"], { cwd: sourcePath });
    await execFile("git", ["config", "user.name", "CPB Test"], { cwd: sourcePath });
    await writeFile(path.join(sourcePath, "target.txt"), "base\n", "utf8");
    await execFile("git", ["add", "target.txt"], { cwd: sourcePath });
    await execFile("git", ["commit", "-m", "base"], { cwd: sourcePath });
    await writeFile(path.join(sourcePath, "target.txt"), "validated candidate\n", "utf8");
    const candidateArtifact = await captureCandidateArtifact({ cwd: sourcePath });
    const candidateReplayBundle = await createCandidateReplayBundle({ cwd: sourcePath, candidate: candidateArtifact });
    const events: Record<string, unknown>[] = [];

    const result = await runCompletionGate({
      cpbRoot: sourcePath,
      sourcePath,
      project: "proj",
      jobId: "job-candidate-report",
      job: { workflow: "standard", planMode: "full" },
      workflowDag: { nodes: [{ id: "execute", phase: "execute" }, { id: "verify", phase: "verify" }] },
      riskMap: {},
      phaseResults: [
        { phase: "execute", status: "passed", diagnostics: { candidateArtifact, candidateReplayBundle } },
        {
          phase: "verify",
          status: "passed",
          verdict: "VERDICT: PASS",
          diagnostics: { validatedCandidateIdentityHash: candidateArtifact.identityHash },
        },
      ],
      appendEvent: async (_cpbRoot, _project, _jobId, event) => { events.push(event); },
      failJob: async () => { throw new Error("failJob should not be called"); },
      completeJob: async () => {},
    });

    assert.equal(result.status, "completed");
    const report = result.completionReport as Record<string, unknown>;
    const validation = report.candidateValidation as Record<string, unknown>;
    assert.equal(validation.identityHash, candidateArtifact.identityHash);
    assert.equal(validation.patchHash, candidateArtifact.patchHash);
    assert.equal(validation.treeHash, candidateArtifact.treeHash);
    assert.equal(validation.validatedCandidateIdentityHash, candidateArtifact.identityHash);
    assert.equal(validation.identityMatch, true);
    assert.equal((validation.cleanReplay as Record<string, unknown>).cleanApply, true);
    assert.equal((validation.cleanReplay as Record<string, unknown>).replayMethod, "persisted_patch_bundle");
    assert.deepEqual(validation.replayBundle, {
      bundleHash: candidateReplayBundle.bundleHash,
      patchSha256: candidateReplayBundle.patchSha256,
      patchBytes: candidateReplayBundle.patchBytes,
    });
    assert.ok(events.some((event) => (
      event.type === "candidate_clean_replay"
      && event.cleanApply === true
      && event.replayMethod === "persisted_patch_bundle"
      && event.candidateId === candidateArtifact.identityHash
      && event.bundleHash === candidateReplayBundle.bundleHash
    )));
    assert.ok(events.some((event) => event.type === "candidate_identity_checked" && event.matches === true));
  } finally {
    await rm(sourcePath, { recursive: true, force: true });
  }
});

test("runCompletionGate applies only identical dual-verifier scope approvals", async () => {
  const sourcePath = await tempRoot("cpb-completion-scope-amendment");
  const artifactRoot = await tempRoot("cpb-completion-scope-artifacts");
  try {
    await execFile("git", ["init"], { cwd: sourcePath });
    await execFile("git", ["config", "user.email", "cpb@example.invalid"], { cwd: sourcePath });
    await execFile("git", ["config", "user.name", "CPB Test"], { cwd: sourcePath });
    await writeFile(path.join(sourcePath, "target.txt"), "base\n", "utf8");
    await writeFile(path.join(sourcePath, "setup.cfg"), "strict = false\n", "utf8");
    await execFile("git", ["add", "-A"], { cwd: sourcePath });
    await execFile("git", ["commit", "-m", "base"], { cwd: sourcePath });
    await writeFile(path.join(sourcePath, "target.txt"), "candidate\n", "utf8");
    await writeFile(path.join(sourcePath, "setup.cfg"), "strict = true\n", "utf8");
    const candidateArtifact = await captureCandidateArtifact({ cwd: sourcePath });
    const candidateReplayBundle = await createCandidateReplayBundle({ cwd: sourcePath, candidate: candidateArtifact });
    const acceptanceChecklist = {
      schemaVersion: 1,
      jobId: "job-scope-amendment",
      project: "proj",
      status: "frozen",
      items: [{
        id: "AC-001",
        requirement: "preserve strict repository behavior",
        source: "user_task",
        sourceRefs: [{ kind: "task_text", locator: "task:0" }],
        verificationMethod: "command",
        predicateId: "PRED-001",
        required: true,
        area: "runtime",
        risk: "high",
        expectedEvidence: "focused strict behavior test",
        allowedFiles: ["target.txt"],
        dependsOn: [],
        realActors: ["strict behavior"],
        realEntrypoints: ["target.txt"],
        bypassCandidates: ["repository warning policy"],
        requiredEvidenceClass: "real_path_probe",
        requiredEvidenceOrigin: "user_required",
      }],
      assumptions: [],
    };
    const executionMap = {
      changedFiles: ["target.txt", "setup.cfg"],
      unmappedChangedFiles: ["setup.cfg"],
      mappings: [{ checklistId: "AC-001", changedFiles: ["target.txt"] }],
    };
    const scopeRequest = buildScopeReviewRequest({
      executionMap,
      checklist: acceptanceChecklist,
      candidateId: candidateArtifact.identityHash,
    });
    assert.ok(scopeRequest);
    const scopeReview = {
      candidateId: scopeRequest.candidateId,
      requestHash: scopeRequest.requestHash,
      decision: "approve",
      unmappedFiles: scopeRequest.unmappedFiles,
      mappings: [{
        file: "setup.cfg",
        checklistIds: ["AC-001"],
        necessity: "The existing strict behavior requirement needs the repository policy change.",
        risk: "The configuration change was checked for overbroad effects.",
        evidence: ["Exact setup.cfg diff and focused strict behavior evidence inspected."],
      }],
    };
    const artifact = async (kind: string, content: Record<string, unknown>) => {
      const file = path.join(artifactRoot, `${kind}.json`);
      await writeFile(file, JSON.stringify(content), "utf8");
      return { kind, id: kind, exists: true, path: file, createdAt: "2026-07-14T00:00:00.000Z" };
    };
    const entries = [
      await artifact("acceptance-checklist", acceptanceChecklist),
      await artifact("execution-map", executionMap),
      await artifact("evidence-ledger", {
        ledgerId: "ledger-1",
        finalWorktree: { head: "abc", diffHash: "sha256:diff" },
        evidence: [{
          id: "EV-001",
          type: "evidence_claim",
          checklistId: "AC-001",
          verificationMethod: "command",
          predicateId: "PRED-001",
          result: "pass",
          evidenceClass: "real_path_probe",
          evidenceOrigin: "user_required",
          command: "focused strict behavior test",
          exitCode: 0,
          stdoutSha256: "sha256:stdout",
          cwd: sourcePath,
          worktreeHead: "abc",
          diffHash: "sha256:diff",
          changedFilesInScope: ["target.txt"],
        }],
      }),
      await artifact("checklist-verdict", {
        schemaVersion: 1,
        jobId: "job-scope-amendment",
        status: "pass",
        items: [{
          checklistId: "AC-001",
          result: "pass",
          evidenceRefs: [{ ledgerId: "ledger-1", evidenceId: "EV-001" }],
          reason: "focused evidence passed",
          fixScope: [],
        }],
        blocking: [],
        fixScope: [],
        reason: "all requirements passed",
      }),
    ];
    const events: Record<string, unknown>[] = [];
    let completed = false;
    const result = await runCompletionGate({
      cpbRoot: sourcePath,
      sourcePath,
      project: "proj",
      jobId: "job-scope-amendment",
      job: { workflow: "standard", planMode: "full" },
      workflowDag: { nodes: [
        { id: "execute", phase: "execute" },
        { id: "verify", phase: "verify" },
        { id: "adversarial_verify", phase: "adversarial_verify" },
      ] },
      riskMap: { adversarialRequired: true },
      phaseResults: [
        { phase: "execute", status: "passed", diagnostics: { candidateArtifact, candidateReplayBundle } },
        {
          phase: "verify",
          status: "passed",
          verdict: "VERDICT: PASS",
          diagnostics: { validatedCandidateIdentityHash: candidateArtifact.identityHash, verdict: { scopeReview } },
        },
        {
          phase: "adversarial_verify",
          status: "passed",
          verdict: "VERDICT: PASS",
          diagnostics: { verdict: { scopeReview } },
        },
      ],
      getArtifactIndex: async () => ({ entries }),
      appendEvent: async (_cpbRoot, _project, _jobId, event) => { events.push(event); },
      failJob: async () => { throw new Error("failJob should not be called"); },
      completeJob: async () => { completed = true; },
    });

    assert.equal(result.status, "completed", result.failure?.reason);
    assert.equal(completed, true);
    const approvalEvent = events.find((event) => event.type === "scope_amendment_approved");
    assert.ok(approvalEvent);
    assert.equal(approvalEvent.candidateId, candidateArtifact.identityHash);
    assert.equal(approvalEvent.requestHash, scopeRequest.requestHash);
    assert.match(String(approvalEvent.amendmentHash), /^sha256:/);
    assert.equal(events.find((event) => event.type === "completion_gate_evaluated")?.outcome, "complete");
    assert.equal((result.completionReport?.scopeAmendment as Record<string, unknown>).candidateId, candidateArtifact.identityHash);
  } finally {
    await rm(sourcePath, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("runCompletionGate persists completion report from checklist artifacts", async () => {
  const dir = path.join(await import("node:os").then((m) => m.tmpdir()), `completion-report-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  await mkdir(dir, { recursive: true });
  try {
    const artifact = async (kind: string, content: Record<string, unknown>) => {
      const file = path.join(dir, `${kind}.json`);
      await writeFile(file, JSON.stringify(content), "utf8");
      return { kind, id: kind, exists: true, path: file, createdAt: "2026-06-22T00:00:00.000Z" };
    };
    const entries = [
      await artifact("acceptance-checklist", {
        schemaVersion: 1,
        jobId: "job-complete-report",
        project: "proj",
        status: "frozen",
        items: [{
          id: "AC-001",
          requirement: "status route returns JSON",
          source: "user_task",
          sourceRefs: [{ kind: "task_text", locator: "task:0" }],
          verificationMethod: "command",
          predicateId: "PRED-001",
          required: true,
          area: "api",
          risk: "medium",
          expectedEvidence: "npm test -- status",
          allowedFiles: ["server/routes/status.ts"],
          dependsOn: [],
          realActors: ["StatusRoute"],
          realEntrypoints: ["/status"],
          bypassCandidates: ["text output path"],
          requiredEvidenceClass: "real_path_probe",
          requiredEvidenceOrigin: "user_required",
        }],
        assumptions: [{ text: "manual browser check omitted in this run" }],
      }),
      await artifact("execution-map", {
        changedFiles: ["server/routes/status.ts", "tests/status.test.ts"],
        unmappedChangedFiles: [],
      }),
      await artifact("evidence-ledger", {
        ledgerId: "ledger-1",
        finalWorktree: { head: "abc", diffHash: "sha256:diff" },
        evidence: [{
          id: "EV-001",
          type: "evidence_claim",
          checklistId: "AC-001",
          verificationMethod: "command",
          predicateId: "PRED-001",
          result: "pass",
          evidenceClass: "real_path_probe",
          evidenceOrigin: "user_required",
          command: "npm test -- status",
          exitCode: 0,
          stdoutSha256: "sha256:stdout",
          cwd: "/repo",
          worktreeHead: "abc",
          diffHash: "sha256:diff",
        }],
      }),
      await artifact("checklist-verdict", {
        schemaVersion: 1,
        jobId: "job-complete-report",
        status: "pass",
        items: [{
          checklistId: "AC-001",
          result: "pass",
          evidenceRefs: [{ ledgerId: "ledger-1", evidenceId: "EV-001" }],
          reason: "ok",
          fixScope: [],
        }],
        blocking: [],
        fixScope: [],
        reason: "ok",
      }),
    ];
    const events: Record<string, unknown>[] = [];
    const progress: Record<string, unknown>[] = [];

    const result = await runCompletionGate({
      cpbRoot: "/tmp/cpb",
      project: "proj",
      jobId: "job-complete-report",
      job: { workflow: "standard", planMode: "full" },
      workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
      riskMap: { riskLevel: "medium", adversarialRequired: false },
      phaseResults: [{ phase: "verify", status: "passed", verdict: "VERDICT: PASS" }],
      getArtifactIndex: async () => ({ entries }),
      appendEvent: async (_cpbRoot, _project, _jobId, event) => {
        events.push(event);
      },
      failJob: async () => {
        throw new Error("failJob should not be called");
      },
      completeJob: async () => {},
      onProgress: async (event) => {
        progress.push(event);
      },
    });

    const report = result.completionReport as Record<string, unknown>;
    assert.deepEqual(report.changedFiles, ["server/routes/status.ts", "tests/status.test.ts"]);
    assert.deepEqual(report.realActors, ["StatusRoute"]);
    assert.deepEqual(report.realEntrypoints, ["/status"]);
    assert.deepEqual(report.bypassCandidates, ["text output path"]);
    assert.deepEqual(report.evidenceClasses, ["real_path_probe"]);
    assert.deepEqual(report.evidenceOrigins, ["user_required"]);
    assert.deepEqual(report.commands, ["npm test -- status"]);
    assert.deepEqual((events[0] as Record<string, unknown>).completionReport, report);
    assert.deepEqual(progress[0].completionReport, report);
    assert.deepEqual(progress[1].completionReport, report);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCompletionGate can defer a repairable evidence mismatch without terminally failing the job", async () => {
  const dir = path.join(await import("node:os").then((m) => m.tmpdir()), `completion-repair-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
  await mkdir(dir, { recursive: true });
  try {
    const artifact = async (kind: string, content: Record<string, unknown>) => {
      const file = path.join(dir, `${kind}.json`);
      await writeFile(file, JSON.stringify(content), "utf8");
      return { kind, id: kind, exists: true, path: file, createdAt: "2026-07-12T00:00:00.000Z" };
    };
    const checklistItem = {
      id: "AC-001",
      requirement: "status route returns JSON",
      source: "user_task",
      sourceRefs: [{ kind: "task_text", locator: "task:0" }],
      verificationMethod: "command",
      predicateId: "PRED-001",
      required: true,
      area: "api",
      risk: "medium",
      expectedEvidence: "npm test -- status",
      allowedFiles: ["server/routes/status.ts"],
      dependsOn: [],
      realActors: ["StatusRoute"],
      realEntrypoints: ["/status"],
      bypassCandidates: ["text output path"],
      requiredEvidenceClass: "real_path_probe",
      requiredEvidenceOrigin: "user_required",
    };
    const entries = [
      await artifact("acceptance-checklist", {
        schemaVersion: 1,
        jobId: "job-deferred-repair",
        project: "proj",
        status: "frozen",
        items: [checklistItem],
        assumptions: [],
      }),
      await artifact("execution-map", { changedFiles: ["server/routes/status.ts"], unmappedChangedFiles: [] }),
      await artifact("evidence-ledger", {
        ledgerId: "ledger-1",
        finalWorktree: { head: "abc", diffHash: "sha256:diff" },
        evidence: [{
          id: "EV-001",
          type: "evidence_claim",
          checklistId: "AC-001",
          verificationMethod: "command",
          predicateId: "WRONG-PREDICATE",
          result: "pass",
          evidenceClass: "real_path_probe",
          evidenceOrigin: "user_required",
          command: "npm test -- status",
          exitCode: 0,
          stdoutSha256: "sha256:stdout",
          cwd: "/repo",
          worktreeHead: "abc",
          diffHash: "sha256:diff",
        }],
      }),
      await artifact("checklist-verdict", {
        schemaVersion: 1,
        jobId: "job-deferred-repair",
        status: "pass",
        items: [{
          checklistId: "AC-001",
          result: "pass",
          evidenceRefs: [{ ledgerId: "ledger-1", evidenceId: "EV-001" }],
          reason: "claimed pass",
          fixScope: [],
        }],
        blocking: [],
        fixScope: [],
        reason: "claimed pass",
      }),
    ];
    const events: Record<string, unknown>[] = [];
    const failures: Record<string, unknown>[] = [];

    const result = await runCompletionGate({
      cpbRoot: "/tmp/cpb",
      project: "proj",
      jobId: "job-deferred-repair",
      job: { workflow: "standard", planMode: "full" },
      workflowDag: { nodes: [{ id: "execute", phase: "execute" }, { id: "verify", phase: "verify" }] },
      riskMap: {},
      phaseResults: [{ phase: "execute", status: "passed" }, { phase: "verify", status: "passed", verdict: "VERDICT: PASS" }],
      getArtifactIndex: async () => ({ entries }),
      appendEvent: async (_cpbRoot, _project, _jobId, event) => { events.push(event); },
      failJob: async (_cpbRoot, _project, _jobId, failure) => { failures.push(failure); },
      completeJob: async () => { throw new Error("completeJob should not be called"); },
      deferRepairableFailure: true,
    });

    assert.equal(result.status, "repairable");
    assert.equal(result.exitCode, 0);
    assert.equal(failures.length, 0, "deferred repair must not terminally fail the job");
    assert.equal((result.failure?.cause as Record<string, unknown>).routingRetryPhase, "execute");
    assert.deepEqual((result.failure?.cause as Record<string, unknown>).targetChecklistIds, ["AC-001"]);
    assert.ok(events.some((event) => event.type === "completion_gate_repair_deferred" && event.retryPhase === "execute"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCompletionGate records runtime failures before evaluating the gate", async () => {
  const events: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];

  const result = await runCompletionGate({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-runtime-failure",
    job: { workflow: "standard", planMode: "full" },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    riskMap: {},
    phaseResults: [{
      phase: "verify",
      status: "failed",
      failure: {
        kind: "poisoned_session",
        reason: "agent refused task",
      },
    }],
    attemptId: "attempt-1",
    appendEvent: async (_cpbRoot, _project, _jobId, event) => {
      events.push(event);
    },
    failJob: async (_cpbRoot, _project, _jobId, failure) => {
      failures.push(failure);
    },
    completeJob: async () => {
      throw new Error("completeJob should not be called");
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(result.status, "failed");
  assert.equal(events[0].type, "runtime_failure_recorded");
  assert.equal(events[0].failureType, "poisoned_session");
  assert.equal(events[1].type, "completion_gate_evaluated");
  assert.equal(events[1].outcome, "verification_incomplete");
  assert.equal(failures[0].reason, "Verify phase has not completed");
});
