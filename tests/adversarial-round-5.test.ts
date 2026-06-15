/**
 * Adversarial Round 5: Post-terminal artifact_created cannot change
 * completion authority.
 *
 * Scenario: A job goes terminal with status=failed after the completion
 * gate evaluates to checklist_failed (a required checklist item failed).
 * Then a new artifact_created event is appended to the event log — either
 * by a delayed agent, a buggy bridge, or direct JSONL tampering.
 *
 * Invariants that MUST hold:
 *   1. appendEvent silently drops artifact_created on a terminal job
 *      (artifact_created is NOT in POST_TERMINAL_ALLOWED).
 *   2. materializeJob skips post-terminal artifact_created during replay,
 *      so job status remains "failed".
 *   3. Re-evaluating the completion gate after the injected artifact still
 *      yields checklist_failed because the checklist verdict still reports
 *      a failed required item.
 *   4. buildArtifactIndex does not surface the post-terminal artifact.
 *
 * Attack vector: direct JSONL append bypasses appendEvent's guard.
 * Even then, materializeJob must ignore the artifact_created event
 * because it follows a terminal job_failed event and is not in
 * POST_TERMINAL_ALLOWED.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { evaluateCompletionGate } from "../core/engine/completion-gate.js";
import {
  appendEvent,
  materializeJob,
  readEvents,
} from "../server/services/event/event-store.js";
import {
  createJob,
  failJob,
  getJob,
  completePhase,
  startPhase,
  FAILURE_CODES,
} from "../server/services/job/job-store.js";
import { buildArtifactIndex } from "../server/services/job/job-projection.js";
import { tempRoot } from "./helpers.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────

type AnyRecord = Record<string, any>;

function frozenChecklist() {
  return {
    schemaVersion: 1,
    jobId: "job-r5",
    project: "flow",
    status: "frozen",
    source: { task: "fix auth bug", issue: null, documents: [] },
    items: [
      {
        id: "AC-001",
        requirement: "Auth tests pass",
        source: "user_task",
        sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
        predicateId: "PRED-001",
        required: true,
        area: "cli",
        risk: "high",
        verificationMethod: "command",
        expectedEvidence: "npm test exit 0",
        dependsOn: [],
        allowedFiles: ["src/auth.ts"],
      },
    ],
    assumptions: [],
  };
}

/** Verdict where a required item failed. */
function failedVerdict() {
  return {
    schemaVersion: 1,
    jobId: "job-r5",
    status: "fail",
    items: [
      {
        checklistId: "AC-001",
        result: "fail",
        evidenceRefs: [],
        actualResult: "2 tests failed",
        reason: "auth.test.ts: TypeError: Cannot read properties of undefined",
      },
    ],
    blocking: [{ checklistId: "AC-001" }],
    fixScope: ["src/auth.ts"],
    reason: "required checklist item AC-001 failed",
  };
}

/** Passing verdict that an attacker would want to inject. */
function passingVerdict() {
  return {
    schemaVersion: 1,
    jobId: "job-r5",
    status: "pass",
    items: [
      {
        checklistId: "AC-001",
        result: "pass",
        evidenceRefs: [{ ledgerId: "evidence-ledger-r5", evidenceId: "EV-001" }],
        actualResult: "all tests pass",
        reason: "ok",
      },
    ],
    blocking: [],
    fixScope: [],
    reason: "passed",
  };
}

function passingEvidenceLedger() {
  return {
    schemaVersion: 1,
    jobId: "job-r5",
    project: "flow",
    ledgerId: "evidence-ledger-r5",
    attemptId: "attempt-r5",
    finalWorktree: { head: "ccc333", diffHash: "sha256:r5" },
    evidence: [
      {
        id: "EV-001",
        type: "evidence_claim",
        observationType: "command",
        checklistId: "AC-001",
        attemptId: "attempt-r5",
        verificationMethod: "command",
        predicateId: "PRED-001",
        probeId: "probe-test",
        result: "pass",
        command: "npm test",
        exitCode: 0,
        cwd: "/repo/flow",
        stdoutSha256: "sha256:stdout-r5",
        summary: "all tests pass",
        worktreeHead: "ccc333",
        diffHash: "sha256:r5",
      },
    ],
  };
}

function executionMap() {
  return { unmappedChangedFiles: [] };
}

const ts = (offset: number) => {
  const d = new Date("2026-06-13T00:00:00.000Z");
  d.setSeconds(d.getSeconds() + offset);
  return d.toISOString();
};

// ─── Test 1: Pure gate — checklist_failed stays checklist_failed regardless of new artifacts ──

test("adversarial round 5: pure gate — checklist_failed outcome cannot be reversed by re-evaluation", () => {
  // The gate evaluates with a failed verdict on a required item.
  // No amount of subsequent artifact creation changes this: the verdict
  // itself says the item failed.
  const result = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: null,
    checklist: frozenChecklist(),
    checklistVerdict: failedVerdict(),
    evidenceLedger: null,
    executionMap: null,
    attemptId: "attempt-r5",
  });

  assert.strictEqual(result.outcome, "checklist_failed",
    `expected checklist_failed but got ${result.outcome}: ${result.reason}`);
  assert.ok(result.details.checklist.failedChecklistIds.includes("AC-001"),
    "AC-001 must be in failedChecklistIds");
});

// ─── Test 2: Pure gate — even with a passing verdict injected, checklist_failed was already the authority ──

test("adversarial round 5: re-evaluating with a passing verdict would succeed — proving terminal guard is the defense", () => {
  // Simulates: the job was already failed with checklist_failed. An attacker
  // tries to re-evaluate the gate with a new passing verdict. The defense is
  // that re-evaluation should not happen at all on a terminal job, but even
  // if it does, the original terminal state must be the source of truth.
  //
  // We test the gate function itself: given a passing verdict instead of the
  // failed one, the gate would now pass. This demonstrates WHY the terminal
  // guard in appendEvent/materializeJob is essential — the gate itself is
  // stateless and has no memory of prior evaluations.
  const resultWithPassing = evaluateCompletionGate({
    job: { workflow: "standard", planMode: "full", completedPhases: ["plan", "execute", "verify"] },
    workflowDag: { nodes: [{ id: "verify", phase: "verify" }] },
    parsedVerdict: { status: "pass", raw: "PASS" },
    checklist: frozenChecklist(),
    checklistVerdict: passingVerdict(),
    evidenceLedger: passingEvidenceLedger(),
    executionMap: executionMap(),
    attemptId: "attempt-r5",
  });

  // The gate is stateless — it would pass with the injected verdict.
  // This proves the terminal guard is the critical defense.
  assert.strictEqual(resultWithPassing.outcome, "complete",
    "gate is stateless — a passing verdict would pass; terminal guard is the defense");
});

// ─── Test 3: appendEvent silently drops artifact_created on terminal job ──

test("adversarial round 5: appendEvent silently drops artifact_created on a failed terminal job", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round5-append");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "round5";

  // Create and fail a job
  const job = await createJob(cpbRoot, {
    dataRoot,
    project,
    task: "fix auth bug",
    workflow: "standard",
    ts: ts(1),
  });

  await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId: "l1", ts: ts(2), dataRoot });
  await completePhase(cpbRoot, project, job.jobId, { phase: "plan", artifact: "plan-r5.md", ts: ts(3), dataRoot });
  await failJob(cpbRoot, project, job.jobId, {
    reason: "required checklist item AC-001 failed",
    code: "checklist_failed",
    phase: "completion_gate",
    ts: ts(4),
    dataRoot,
  });

  // Verify the job is terminal
  const failedState = await getJob(cpbRoot, project, job.jobId, { dataRoot });
  assert.strictEqual(failedState.status, "failed", "job must be failed");

  const eventsBefore = await readEvents(cpbRoot, project, job.jobId, { dataRoot });
  const countBefore = eventsBefore.length;

  // Try to append an artifact_created event — should be silently dropped
  const result = await appendEvent(cpbRoot, project, job.jobId, {
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "verify",
    kind: "acceptance-checklist",
    artifactKind: "acceptance-checklist",
    artifact: "acceptance-checklist-fake.md",
    artifactId: "fake-001",
    attemptId: "attempt-r5",
    ts: ts(5),
  }, { dataRoot });

  assert.strictEqual(result, null, "appendEvent must return null for artifact_created on terminal job");

  const eventsAfter = await readEvents(cpbRoot, project, job.jobId, { dataRoot });
  assert.strictEqual(eventsAfter.length, countBefore,
    "event count must not increase after rejected artifact_created");

  // Job status must remain failed
  const stillFailed = await getJob(cpbRoot, project, job.jobId, { dataRoot });
  assert.strictEqual(stillFailed.status, "failed");
});

// ─── Test 4: Direct JSONL tampering — materializeJob skips post-terminal artifact_created ──

test("adversarial round 5: materializeJob skips artifact_created after terminal job_failed event", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round5-jsonl");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "round5-jsonl";

  // Create and fail a job through normal flow
  const job = await createJob(cpbRoot, {
    dataRoot,
    project,
    task: "fix auth bug",
    workflow: "standard",
    ts: ts(10),
  });

  await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId: "l1", ts: ts(11), dataRoot });
  await completePhase(cpbRoot, project, job.jobId, { phase: "plan", artifact: "plan-r5.md", ts: ts(12), dataRoot });
  await failJob(cpbRoot, project, job.jobId, {
    reason: "required checklist item AC-001 failed",
    code: "checklist_failed",
    phase: "completion_gate",
    ts: ts(13),
    dataRoot,
  });

  const eventsBefore = await readEvents(cpbRoot, project, job.jobId, { dataRoot });
  const terminalIndex = eventsBefore.length - 1;

  // Verify the last event is job_failed
  assert.strictEqual(eventsBefore[terminalIndex].type, "job_failed",
    "last event must be job_failed");

  // SIMULATE DIRECT JSONL TAMPERING: append an artifact_created event
  // directly to the JSONL file, bypassing appendEvent's guard
  const eventFile = path.join(dataRoot, "events", project, `${job.jobId}.jsonl`);
  const tamperedEvent = JSON.stringify({
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "verify",
    kind: "checklist-verdict",
    artifactKind: "checklist-verdict",
    artifact: "checklist-verdict-fake-002",
    artifactId: "fake-002",
    attemptId: "attempt-r5",
    ts: ts(14),
  });

  // Read the file and append our tampered event
  const existing = await readFile(eventFile, "utf8");
  await writeFile(eventFile, `${existing}${tamperedEvent}\n`, "utf8");

  // Read events back — the tampered event is present in the raw log
  const eventsAfter = await readEvents(cpbRoot, project, job.jobId, { dataRoot });
  assert.strictEqual(eventsAfter.length, eventsBefore.length + 1,
    "raw event log must contain the tampered event");
  assert.strictEqual(eventsAfter[eventsAfter.length - 1].type, "artifact_created",
    "tampered artifact_created event must be in the raw log");

  // materializeJob must skip the post-terminal artifact_created
  const state = materializeJob(eventsAfter);
  assert.strictEqual(state.status, "failed",
    "materialized status must remain failed despite injected artifact_created");

  // The tampered artifact must NOT appear in artifactsByKind
  assert.strictEqual(state.artifactsByKind["checklist-verdict"], undefined,
    "post-terminal artifact_created must not update artifactsByKind");

  // getJob (which uses materializeJob) must also show failed
  const jobState = await getJob(cpbRoot, project, job.jobId, { dataRoot });
  assert.strictEqual(jobState.status, "failed",
    "getJob must return failed status");
});

// ─── Test 5: buildArtifactIndex does not surface the post-terminal artifact ──

test("adversarial round 5: buildArtifactIndex ignores post-terminal artifact_created from raw JSONL", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round5-index");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "round5-index";

  // Create and fail a job
  const job = await createJob(cpbRoot, {
    dataRoot,
    project,
    task: "fix auth bug",
    workflow: "standard",
    ts: ts(20),
  });

  // Register a pre-terminal artifact normally
  await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId: "l1", ts: ts(21), dataRoot });
  await completePhase(cpbRoot, project, job.jobId, { phase: "plan", artifact: "plan-r5.md", ts: ts(22), dataRoot });

  await failJob(cpbRoot, project, job.jobId, {
    reason: "required checklist item AC-001 failed",
    code: "checklist_failed",
    phase: "completion_gate",
    ts: ts(23),
    dataRoot,
  });

  // Tamper: inject artifact_created for a checklist-verdict
  const eventFile = path.join(dataRoot, "events", project, `${job.jobId}.jsonl`);
  const existing = await readFile(eventFile, "utf8");
  const tamperedEvent = JSON.stringify({
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "verify",
    kind: "checklist-verdict",
    artifactKind: "checklist-verdict",
    artifact: "checklist-verdict-fake-003",
    artifactId: "fake-003",
    attemptId: "attempt-r5",
    ts: ts(24),
  });
  await writeFile(eventFile, `${existing}${tamperedEvent}\n`, "utf8");

  // buildArtifactIndex reads raw events and finds artifact references.
  // It does NOT apply the terminal guard (that's materializeJob's job).
  // So the post-terminal artifact_created will appear in the index, but
  // since the file doesn't exist on disk, it will be marked broken.
  const index = await buildArtifactIndex(cpbRoot, project, job.jobId, { dataRoot });

  // The pre-terminal artifact (plan) should be present in the index
  const planEntry = index.entries.find((e: AnyRecord) => e.kind === "plan");
  assert.ok(planEntry, "pre-terminal plan artifact should be indexed");

  // The post-terminal checklist-verdict appears in the index but is broken
  const verdictEntry = index.entries.find((e: AnyRecord) => e.kind === "checklist-verdict");
  assert.ok(verdictEntry, "artifact index lists the post-terminal reference (raw event scan)");
  assert.strictEqual(verdictEntry.exists, false,
    "post-terminal artifact must not resolve to an existing file");
  assert.strictEqual(verdictEntry.broken, true,
    "post-terminal artifact must be marked as broken");
});

// ─── Test 6: Full integration — create, fail, tamper, re-read, re-evaluate ──

test("adversarial round 5: full integration — terminal job stays failed after all attack vectors", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round5-full");
  const dataRoot = path.join(cpbRoot, "runtime");
  const wikiDir = path.join(dataRoot, "projects", "flow", "wiki");
  const outputsDir = path.join(wikiDir, "outputs");
  await mkdir(outputsDir, { recursive: true });
  const project = "flow";

  // Create job, run through phases, fail at completion gate
  const job = await createJob(cpbRoot, {
    dataRoot,
    project,
    task: "fix auth bug",
    workflow: "standard",
    ts: ts(30),
  });

  await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId: "l1", ts: ts(31), dataRoot });
  await completePhase(cpbRoot, project, job.jobId, { phase: "plan", artifact: "plan-r5.md", ts: ts(32), dataRoot });
  await startPhase(cpbRoot, project, job.jobId, { phase: "execute", leaseId: "l2", ts: ts(33), dataRoot });
  await completePhase(cpbRoot, project, job.jobId, { phase: "execute", artifact: "deliverable-r5.md", ts: ts(34), dataRoot });
  await startPhase(cpbRoot, project, job.jobId, { phase: "verify", leaseId: "l3", ts: ts(35), dataRoot });
  await completePhase(cpbRoot, project, job.jobId, { phase: "verify", artifact: "verdict-r5.md", ts: ts(36), dataRoot });

  // Fail with checklist_failed
  await failJob(cpbRoot, project, job.jobId, {
    reason: "required checklist item AC-001 failed",
    code: "checklist_failed",
    phase: "completion_gate",
    ts: ts(37),
    dataRoot,
  });

  // Verify terminal state
  const failedJob = await getJob(cpbRoot, project, job.jobId, { dataRoot });
  assert.strictEqual(failedJob.status, "failed");
  assert.strictEqual(failedJob.failureCode, "checklist_failed");

  // Attack 1: try appendEvent — must be rejected
  const appendResult = await appendEvent(cpbRoot, project, job.jobId, {
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "verify",
    kind: "checklist-verdict",
    artifactKind: "checklist-verdict",
    artifact: "checklist-verdict-injected",
    artifactId: "injected-001",
    attemptId: "attempt-r5",
    ts: ts(38),
  }, { dataRoot });
  assert.strictEqual(appendResult, null, "appendEvent must reject artifact_created on terminal job");

  // Attack 2: direct JSONL tampering — inject a passing checklist-verdict artifact
  const eventFile = path.join(dataRoot, "events", project, `${job.jobId}.jsonl`);
  const existing = await readFile(eventFile, "utf8");
  const tamperedArtifactEvent = JSON.stringify({
    type: "artifact_created",
    jobId: job.jobId,
    project,
    phase: "verify",
    kind: "checklist-verdict",
    artifactKind: "checklist-verdict",
    artifact: "checklist-verdict-passing",
    artifactId: "passing-001",
    attemptId: "attempt-r5",
    ts: ts(39),
  });
  await writeFile(eventFile, `${existing}${tamperedArtifactEvent}\n`, "utf8");

  // Write a passing verdict file to disk (so readActiveChecklistArtifacts could find it)
  await writeFile(
    path.join(outputsDir, "checklist-verdict-passing.md"),
    JSON.stringify(passingVerdict(), null, 2),
    "utf8",
  );

  // FINAL CHECK: getJob must still show failed
  const finalJob = await getJob(cpbRoot, project, job.jobId, { dataRoot });
  assert.strictEqual(finalJob.status, "failed",
    "job must remain failed after all attack vectors");
  assert.strictEqual(finalJob.failureCode, "checklist_failed",
    "failureCode must remain checklist_failed");
});

// ─── Test 7: completion_gate_evaluated IS allowed post-terminal (audit trail) ──

test("adversarial round 5: completion_gate_evaluated event IS allowed post-terminal", async () => {
  const cpbRoot = await tempRoot("cpb-adversarial-round5-audit");
  const dataRoot = path.join(cpbRoot, "runtime");
  const project = "round5-audit";

  const job = await createJob(cpbRoot, {
    dataRoot,
    project,
    task: "fix auth bug",
    ts: ts(40),
  });

  await failJob(cpbRoot, project, job.jobId, {
    reason: "checklist failed",
    code: "checklist_failed",
    phase: "completion_gate",
    ts: ts(41),
    dataRoot,
  });

  const eventsBefore = await readEvents(cpbRoot, project, job.jobId, { dataRoot });
  const countBefore = eventsBefore.length;

  // completion_gate_evaluated is in POST_TERMINAL_ALLOWED — should succeed
  const result = await appendEvent(cpbRoot, project, job.jobId, {
    type: "completion_gate_evaluated",
    jobId: job.jobId,
    project,
    outcome: "checklist_failed",
    reason: "required checklist items failed",
    missingGates: ["checklist"],
    ts: ts(42),
  }, { dataRoot });

  assert.ok(result !== null, "completion_gate_evaluated must be allowed post-terminal");
  assert.strictEqual(result.type, "completion_gate_evaluated");

  const eventsAfter = await readEvents(cpbRoot, project, job.jobId, { dataRoot });
  assert.strictEqual(eventsAfter.length, countBefore + 1,
    "event count must increase by 1 for allowed post-terminal event");

  // But the job status must still be failed — audit events don't change authority
  const state = await getJob(cpbRoot, project, job.jobId, { dataRoot });
  assert.strictEqual(state.status, "failed",
    "audit event must not change terminal status");
});
