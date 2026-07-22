import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import { WorkerStore } from "../shared/orchestrator/worker-store.js";
import { FailureKind } from "../core/contracts/failure.js";
import { FailureRouter } from "../server/orchestrator/failure-router.js";
import {
  Reconciler,
  buildFinalizerOnlyRecoveryPlan,
  buildRetrySourceContext,
  persistedFinalizerGitReadbackValid,
  persistedFinalizerJournalValid,
  persistedFinalizerSuccessContractValid,
} from "../server/orchestrator/reconciler.js";
import { enqueue, listQueue, updateEntry } from "../server/services/hub/hub-queue.js";
import { finalizerMutationFenceDigest } from "../server/services/finalizer-contract.js";
import { recordValue } from "../shared/types.js";
import { tempRoot, oldIso, readJson, writeJson } from "./helpers.js";

const execFile = promisify(execFileCallback);

function attemptDir(hubRoot, assignmentId, attempt = 1) {
  return path.join(hubRoot, "assignments", assignmentId, "attempts", String(attempt).padStart(3, "0"));
}

function reconciler(hubRoot, assignments, workers, failureRouter: Record<string, unknown> | FailureRouter = {}, options: Record<string, unknown> = {}) {
  const router = typeof failureRouter?.route === "function"
    ? failureRouter
    : {
        resetBudget: () => {},
        route: async () => ({ action: "mark_failed", reason: "test failure" }),
        ...failureRouter,
      };
  return new Reconciler(hubRoot, {
    assignmentStore: assignments,
    workerStore: workers,
    leaderLock: { stillHeld: async () => true },
    failureRouter: router,
    ...options,
  });
}

test("buildRetrySourceContext carries verifier verdict into retry metadata", () => {
  const result = {
    jobResult: {
      jobId: "job-verify",
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: "acceptance failed",
        retryable: true,
        cause: {
          verdict: {
            status: "fail",
            confidence: 0.84,
            reason: "missing validation",
            summary: "The API still accepts null input.",
            layers: {
              acceptance: { status: "fail", detail: "null input was accepted" },
            },
            blocking: [
              {
                criterion: "input validation",
                file: "src/api.js",
                evidence: "null accepted",
                fix_hint: "add guard",
              },
            ],
            fix_scope: ["src/api.js"],
          },
          artifact: {
            kind: "verdict",
            id: "123456",
            name: "verdict-123456",
            path: "/tmp/verdict-123456.md",
            bytes: 321,
            sha256: "abc123",
          },
        },
      },
    },
  };

  const sourceContext = buildRetrySourceContext(
    {
      attempts: 1,
      metadata: { failureCount: 1 },
      sourceContext: { issueNumber: 42 },
    },
    { attempt: 1 },
    result,
    { action: "retry_same_worker", reason: "verification failed: acceptance failed", retryable: true },
  );

  const retry = recordValue(sourceContext.retry);
  const retryVerification = recordValue(retry.verification);
  const retryVerdict = recordValue(retryVerification.verdict);
  const retryArtifact = recordValue(retryVerification.artifact);
  const previousFailure = recordValue(sourceContext.previousFailure);
  const previousVerification = recordValue(previousFailure.verification);
  const previousVerdict = recordValue(previousVerification.verdict);
  assert.equal(sourceContext.issueNumber, 42);
  assert.equal(retry.failureKind, FailureKind.VERIFICATION_FAILED);
  assert.equal(retry.failureReason, "acceptance failed");
  assert.equal(retry.retryAction, "retry_same_worker");
  assert.equal(retry.failureCount, 2);
  assert.equal(retryVerdict.status, "fail");
  assert.equal(retryVerdict.reason, "missing validation");
  assert.deepEqual(retryVerification.retryScope, ["src/api.js"]);
  assert.equal(retryArtifact.path, "/tmp/verdict-123456.md");
  assert.match(String(retry.previousOutput), /Verifier verdict:/);
  assert.match(String(retry.previousOutput), /src\/api\.js/);
  assert.equal(previousVerdict.status, "fail");
});

test("buildFinalizerOnlyRecoveryPlan reconciles ambiguous writes before authorizing a fenced resume", () => {
  const canonicalDigest = (value: unknown) => {
    const canonical = (nested: unknown): unknown => {
      if (Array.isArray(nested)) return nested.map(canonical);
      if (!nested || typeof nested !== "object") return nested;
      return Object.fromEntries(Object.entries(nested as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]));
    };
    return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
  };
  const recoveryAttempt = (attempt: number) => ({
    attempt,
    attemptToken: `attempt-token-${attempt}`,
    orchestratorEpoch: attempt + 5,
    workerId: `worker-${attempt}`,
    completedAt: `2026-07-22T02:0${attempt}:00.000Z`,
    heartbeat: {
      workerId: `worker-${attempt}`,
      workerIncarnation: `incarnation-${attempt}`,
      processIdentity: {
        pid: 1200 + attempt,
        startTimeTicks: `900${attempt}`,
        birthIdPrecision: "exact",
      },
    },
  });
  const recoveryResult = (attempt: ReturnType<typeof recoveryAttempt>, committed: boolean | null) => {
    const claimId = String(attempt.attempt).repeat(64);
    const ownerDigest = finalizerMutationFenceDigest({
      assignmentId: "a-finalizer",
      entryId: "entry-finalizer",
      attemptToken: attempt.attemptToken,
      orchestratorEpoch: attempt.orchestratorEpoch,
      workerId: attempt.workerId,
      workerIncarnation: attempt.heartbeat.workerIncarnation,
      processIdentity: attempt.heartbeat.processIdentity,
    });
    return {
      status: "blocked",
      jobResult: {
        status: "blocked",
        jobId: "job-finalizer",
        failure: { kind: "finalizer_failed", phase: "finalize" },
      },
      finalization: { required: true, ok: false, status: "blocked" },
      finalizeResult: {
        ok: false,
        status: "blocked",
        mode: "remote",
        jobId: "job-finalizer",
        committed,
        remoteIntent: {
          schema: "cpb.finalizer-mutation-receipt.v1",
          finalizationId: "f".repeat(64),
          generation: 1,
          project: "proj",
          entryId: "entry-finalizer",
          originJobId: "job-finalizer",
          stage: "repository.push.intent",
          source: { branch: "main", head: "a".repeat(40) },
          targetBranch: "main",
          preRemoteHead: "a".repeat(40),
          commit: "b".repeat(40),
          tree: "c".repeat(40),
          claim: { claimId, claimGeneration: 1, ownerDigest },
          receipts: {},
        },
      },
    };
  };
  const firstAttempt = recoveryAttempt(1);
  const baseResult = recoveryResult(firstAttempt, null);
  const observedResult = (attempt: ReturnType<typeof recoveryAttempt>, committed: boolean | null) => {
    const remoteIntent = recordValue(baseResult.finalizeResult).remoteIntent;
    const readback = { operation: "repository.push", committed };
    return {
      ...recoveryResult(attempt, committed),
      finalizeResult: {
        ...recordValue(recoveryResult(attempt, committed).finalizeResult),
        remoteIntent,
        ...(typeof committed === "boolean" ? {
          reconciliation: { push: readback },
          safeContinuation: {
            schema: "cpb.finalizer-safe-continuation.v1",
            finalizationId: recordValue(remoteIntent).finalizationId,
            journalDigest: canonicalDigest(remoteIntent),
            journalGeneration: recordValue(remoteIntent).generation,
            stage: "repository.push.intent",
            operation: "repository.push",
            decision: committed,
            readbackKey: "push",
            readbackDigest: canonicalDigest(readback),
          },
        } : {}),
      },
    };
  };
  const first = buildFinalizerOnlyRecoveryPlan(
    { assignmentId: "a-finalizer", entryId: "entry-finalizer", metadata: {} },
    firstAttempt,
    baseResult,
  );
  assert.equal(first?.allowMutation, false);
  assert.equal(first?.committed, null);

  const resume = buildFinalizerOnlyRecoveryPlan(
    {
      assignmentId: "a-finalizer",
      metadata: { finalizerRecovery: first },
    },
    recoveryAttempt(2),
    observedResult(recoveryAttempt(2), false),
  );
  assert.equal(resume?.allowMutation, true);
  assert.equal(resume?.generation, 2);
  assert.equal(recordValue(resume?.takeover).kind, "explicit-handoff");
  assert.equal(recordValue(resume?.takeover).previousClaimId, "1".repeat(64));
  assert.equal(recordValue(recordValue(resume?.priorAttemptProof).evidence).previousAttempt, 1);
  assert.equal(recordValue(recordValue(resume?.lastObservationProof).evidence).attempt, 2);
  assert.match(String(recordValue(resume?.takeover).evidenceId), /^[a-f0-9]{64}$/);

  assert.equal(buildFinalizerOnlyRecoveryPlan(
    {
      assignmentId: "a-finalizer",
      metadata: { finalizerRecovery: { ...first, originJobId: "job-forged-origin" } },
    },
    recoveryAttempt(2),
    observedResult(recoveryAttempt(2), false),
  ), null);

  const unsafeResume = buildFinalizerOnlyRecoveryPlan(
    {
      assignmentId: "a-finalizer",
      metadata: { finalizerRecovery: first },
    },
    recoveryAttempt(2),
    {
      ...baseResult,
      finalizeResult: {
        ...recordValue(recoveryResult(recoveryAttempt(2), false).finalizeResult),
        committed: false,
        remoteIntent: null,
      },
    },
  );
  assert.equal(unsafeResume, null);

  const stillAmbiguous = buildFinalizerOnlyRecoveryPlan(
    {
      assignmentId: "a-finalizer",
      metadata: { finalizerRecovery: first },
    },
    recoveryAttempt(2),
    observedResult(recoveryAttempt(2), null),
  );
  assert.equal(stillAmbiguous?.allowMutation, false);
  assert.equal(stillAmbiguous?.readOnlyObservations, 2);
  assert.equal(stillAmbiguous?.retryBackoffMs, 5_000);
  assert.ok(Date.parse(String(stillAmbiguous?.nextEligibleAt)) > Date.parse(String(stillAmbiguous?.requestedAt)));

  const lastObservation = buildFinalizerOnlyRecoveryPlan(
    { assignmentId: "a-finalizer", metadata: { finalizerRecovery: stillAmbiguous } },
    recoveryAttempt(3),
    observedResult(recoveryAttempt(3), null),
  );
  assert.equal(lastObservation?.allowMutation, false);
  assert.equal(lastObservation?.readOnlyObservations, 3);
  assert.equal(lastObservation?.retryBackoffMs, 10_000);
  const exhausted = buildFinalizerOnlyRecoveryPlan(
    { assignmentId: "a-finalizer", metadata: { finalizerRecovery: lastObservation } },
    recoveryAttempt(4),
    observedResult(recoveryAttempt(4), null),
  );
  assert.equal(exhausted, null);
});

test("persisted finalizer completion requires caller-bound mode/job and canonical review bundle audit", () => {
  const assignment = {
    entryId: "entry-contract",
    projectId: "proj",
    metadata: { autoFinalize: true },
  };
  assert.equal(persistedFinalizerSuccessContractValid(assignment, {
    status: "completed",
    jobResult: { status: "completed", jobId: "job-contract" },
    finalization: { required: true, ok: true },
    finalizeResult: {
      ok: true,
      status: "dry-run",
      mode: "dry-run",
      jobId: "job-contract",
      committed: false,
      pr: { status: "dry-run" },
    },
  }), true);
  assert.equal(persistedFinalizerSuccessContractValid(assignment, {
    status: "completed",
    jobResult: { status: "completed", jobId: "job-contract" },
    finalization: { required: true, ok: true },
    finalizeResult: {
      ok: true,
      status: "dry-run",
      mode: "dry-run",
      jobId: "job-forged",
      committed: false,
      pr: { status: "dry-run" },
    },
  }), false);
  assert.equal(persistedFinalizerSuccessContractValid(assignment, {
    status: "completed",
    jobResult: { status: "completed", jobId: "job-contract" },
    finalization: { required: true, ok: true },
    finalizeResult: {
      ok: true,
      status: "review_bundle",
      mode: "review_bundle",
      jobId: "job-contract",
      committed: true,
      eventRecorded: true,
      bundlePath: "/hub/review-bundles/proj/proj-job-contract-review-bundle.json",
      audit: {
        eventType: "review_bundle_created",
        jobId: "job-contract",
        project: "proj",
        bundlePath: "/hub/review-bundles/proj/proj-job-contract-review-bundle.json",
      },
    },
  }), true);
});

function candidateGate(baseSha: string, headSha: string, treeHash: string) {
  const identityHash = `sha256:${"e".repeat(64)}`;
  return {
    outcome: "complete",
    completionReport: {
      candidateValidation: {
        baseSha,
        headSha,
        treeHash,
        identityHash,
        validatedCandidateIdentityHash: identityHash,
        identityMatch: true,
        cleanReplay: {
          cleanApply: true,
          baseSha,
          expectedTreeHash: treeHash,
          actualTreeHash: treeHash,
        },
      },
    },
  };
}

test("persisted local success rejects a self-consistent commit/tree that is not the durable candidate", () => {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const treeHash = "c".repeat(40);
  const assignment = {
    entryId: "entry-local",
    projectId: "proj",
    metadata: { autoFinalize: true, finalizeMode: "local", allowLiveFinalize: true },
  };
  const result = {
    status: "completed",
    cleanup: {
      worktree: { binding: { baseBranch: "main", baseCommit: baseSha } },
    },
    jobResult: { status: "completed", jobId: "job-local", completionGate: candidateGate(baseSha, headSha, treeHash) },
    finalization: { required: true, ok: true },
    finalizeResult: {
      ok: true,
      status: "finalized",
      mode: "local",
      jobId: "job-local",
      committed: true,
      commit: headSha,
      tree: treeHash,
      sourceSync: { committed: true, clean: true },
    },
  };
  assert.equal(persistedFinalizerSuccessContractValid(assignment, result), true);
  assert.equal(persistedFinalizerSuccessContractValid(assignment, {
    ...result,
    finalizeResult: {
      ...result.finalizeResult,
      commit: "d".repeat(40),
      tree: "f".repeat(40),
      sourceSync: { committed: true, clean: true, actualHead: "d".repeat(40) },
    },
  }), false);
});

test("remote completion requires the exact authoritative terminal finalizer journal", async () => {
  const assignment = {
    entryId: "entry-journal",
    projectId: "proj",
    metadata: { autoFinalize: true, finalizeMode: "remote", allowLiveFinalize: true },
  };
  const intent = {
    schema: "cpb.finalizer-mutation-receipt.v1",
    finalizationId: "f".repeat(64),
    originJobId: "job-origin",
    generation: 8,
    stage: "local.complete",
  };
  const result = { finalizeResult: { remoteIntent: intent } };
  const resolveDataRoot = async () => "/authority/project-runtime";
  const snapshot = (record: unknown, invalidReason: string | null = null) => ({
    journalJobId: "finalizer-entry-journal",
    cursor: { eventCount: 1, eventDigest: "a".repeat(64) },
    record,
    invalidReason,
  });
  const validate = (record: unknown, invalidReason: string | null = null) => persistedFinalizerJournalValid(
    "/authority/cpb",
    "/authority/hub",
    assignment,
    result,
    {
      resolveDataRoot: resolveDataRoot as any,
      readJournal: (async () => snapshot(record, invalidReason)) as any,
    },
  );
  assert.equal(await validate(intent), true);
  assert.equal(await validate(null), false);
  assert.equal(await validate(intent, "journal stream invalid"), false);
  assert.equal(await validate({ ...intent, generation: 7 }), false);
  assert.equal(await validate({ ...intent, stage: "remote.complete" }), false);
});

test("local and remote finalizer Git readback accepts root candidates and one-parent frozen commits", async () => {
  const sourcePath = await tempRoot("cpb-reconciler-finalizer-git");
  await execFile("git", ["init", "-b", "main"], { cwd: sourcePath });
  await execFile("git", ["config", "user.email", "cpb@example.test"], { cwd: sourcePath });
  await execFile("git", ["config", "user.name", "CPB Test"], { cwd: sourcePath });
  await writeFile(path.join(sourcePath, "candidate.txt"), "base\n", "utf8");
  await execFile("git", ["add", "candidate.txt"], { cwd: sourcePath });
  await execFile("git", ["commit", "-m", "base"], { cwd: sourcePath });
  const base = (await execFile("git", ["rev-parse", "HEAD"], { cwd: sourcePath })).stdout.trim();
  const baseTree = (await execFile("git", ["rev-parse", "HEAD^{tree}"], { cwd: sourcePath })).stdout.trim();
  const rootResult = {
    jobResult: { completionGate: candidateGate(base, base, baseTree) },
    finalizeResult: {
      commit: base,
      tree: baseTree,
      sourceSync: { actualBranch: "main", actualHead: base },
    },
  };
  assert.equal(await persistedFinalizerGitReadbackValid({
    sourcePath,
    metadata: { finalizeMode: "local", allowLiveFinalize: true },
  }, rootResult), true);

  await writeFile(path.join(sourcePath, "candidate.txt"), "base\nfrozen candidate\n", "utf8");
  await execFile("git", ["add", "candidate.txt"], { cwd: sourcePath });
  await execFile("git", ["commit", "-m", "frozen candidate"], { cwd: sourcePath });
  const commit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: sourcePath })).stdout.trim();
  const tree = (await execFile("git", ["rev-parse", "HEAD^{tree}"], { cwd: sourcePath })).stdout.trim();
  const dirtyCandidateResult = {
    jobResult: { completionGate: candidateGate(base, base, tree) },
    finalizeResult: {
      commit,
      tree,
      sourceSync: { actualBranch: "main", actualHead: commit },
    },
  };
  assert.equal(await persistedFinalizerGitReadbackValid({
    sourcePath,
    metadata: { finalizeMode: "remote", allowLiveFinalize: true },
  }, dirtyCandidateResult), true);
  assert.equal(await persistedFinalizerGitReadbackValid({
    sourcePath,
    metadata: { finalizeMode: "remote", allowLiveFinalize: true },
  }, {
    ...dirtyCandidateResult,
    finalizeResult: { ...dirtyCandidateResult.finalizeResult, tree: "f".repeat(40) },
  }), false);

  await execFile("git", ["commit", "--allow-empty", "-m", "unrelated second generation"], { cwd: sourcePath });
  const grandchild = (await execFile("git", ["rev-parse", "HEAD"], { cwd: sourcePath })).stdout.trim();
  assert.equal(await persistedFinalizerGitReadbackValid({
    sourcePath,
    metadata: { finalizeMode: "remote", allowLiveFinalize: true },
  }, {
    ...dirtyCandidateResult,
    finalizeResult: {
      ...dirtyCandidateResult.finalizeResult,
      commit: grandchild,
      sourceSync: { actualBranch: "main", actualHead: grandchild },
    },
  }), false, "a same-tree grandchild is not the authorized single-parent frozen commit");

  await execFile("git", ["branch", "cpb/pr-candidate", base], { cwd: sourcePath });
  const prResult = {
    jobResult: { completionGate: candidateGate(base, base, baseTree) },
    finalizeResult: {
      commit: base,
      tree: baseTree,
      remoteIntent: { targetBranch: "cpb/pr-candidate" },
    },
  };
  assert.equal(await persistedFinalizerGitReadbackValid({
    sourcePath,
    metadata: { finalizeMode: "pr", allowLiveFinalize: true },
  }, prResult), true);
  await execFile("git", ["branch", "-f", "cpb/pr-candidate", grandchild], { cwd: sourcePath });
  assert.equal(await persistedFinalizerGitReadbackValid({
    sourcePath,
    metadata: { finalizeMode: "pr", allowLiveFinalize: true },
  }, prResult), false);
});

test("buildRetrySourceContext carries checklist retry state from checklistVerdict", () => {
  const result = {
    jobResult: {
      jobId: "job-checklist-retry",
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
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

  assert.deepEqual(sourceContext.retry.targetChecklistIds, ["AC-002"]);
  assert.deepEqual(sourceContext.retry.lockedPassedChecklistIds, ["AC-001"]);
  assert.deepEqual(sourceContext.retry.previousEvidenceRefs, [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }]);
  assert.deepEqual(sourceContext.retry.fixScope, ["cli/commands/status.ts"]);
  assert.equal(sourceContext.retry.retryPhase, "execute");
  assert.equal(JSON.stringify(sourceContext.retry.fixScope).includes("AC-002"), false);
});

test("buildRetrySourceContext preserves solver exhaustion strategy and fingerprint", () => {
  const sourceContext = buildRetrySourceContext(
    { attempts: 1, sourceContext: {} },
    { attempt: 1 },
    {
      jobResult: {
        jobId: "job-solver-exhausted",
        failure: {
          kind: FailureKind.VERIFICATION_FAILED,
          phase: "verify",
          reason: "focused test still fails",
          retryable: true,
          cause: {
            solver: {
              exhausted: true,
              repairAttempts: 2,
              failureFingerprint: "sha256:fingerprint-1",
            },
          },
        },
      },
    },
    {
      action: "retry_same_worker",
      reason: "fresh diagnosis",
      retryable: true,
      retryPhase: null,
      retryStrategy: "fresh_attempt",
      failureFingerprint: "sha256:fingerprint-1",
    },
  );

  assert.equal(sourceContext.retry.retryPhase, null);
  assert.equal(sourceContext.retry.retryStrategy, "fresh_attempt");
  assert.equal(sourceContext.retry.failureFingerprint, "sha256:fingerprint-1");
  assert.match(sourceContext.retry.previousOutput, /solver exhaustion/i);
});

test("buildRetrySourceContext carries verify-only retry phase with empty fixScope", () => {
  const result = {
    jobResult: {
      jobId: "job-checklist-verify-retry",
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: "AC-003 evidence missing",
        retryable: true,
        cause: {
          routingLabel: "evidence_missing",
          evidenceMissingCause: "probe_available_not_run",
          retryPhase: "verify",
          targetChecklistIds: ["AC-003"],
          fixScope: [],
          verdict: {
            status: "fail",
            reason: "evidence missing",
            blocking: [],
            fix_scope: [],
            checklistVerdict: {
              items: [
                { checklistId: "AC-001", result: "pass", fixScope: [], evidenceRefs: [{ ledgerId: "evidence-ledger-001", evidenceId: "EV-001" }] },
                { checklistId: "AC-003", result: "unchecked", fixScope: [], evidenceRefs: [] },
              ],
              fixScope: [],
            },
          },
        },
      },
    },
  };

  const sourceContext = buildRetrySourceContext(
    { attempts: 1, metadata: { failureCount: 1 }, sourceContext: {} },
    { attempt: 1 },
    result,
    { action: "retry_same_worker", reason: "evidence missing", retryable: true, retryPhase: "verify" },
  );

  const retry = recordValue(sourceContext.retry);
  const verification = recordValue(retry.verification);
  const checklistVerdict = recordValue(verification.checklistVerdict);
  assert.deepEqual(retry.targetChecklistIds, ["AC-003"]);
  assert.equal(retry.retryPhase, "verify");
  assert.deepEqual(retry.fixScope, []);
  assert.equal(Array.isArray(checklistVerdict.targetChecklistIds) ? checklistVerdict.targetChecklistIds.length : 0, 1);
});

test("buildRetrySourceContext synthesizes a complete generic recovery contract", () => {
  const context = buildRetrySourceContext(
    { attempts: 1, sourceContext: {} },
    { attempt: 1 },
    {
      failure: {
        kind: FailureKind.TIMEOUT,
        phase: "execute",
        reason: "provider response timed out",
        retryable: true,
        cause: { code: "PROMPT_TIMEOUT" },
      },
    },
    { action: "restart_worker_and_retry", reason: "timeout recovery", retryable: true },
  );
  const retry = recordValue(context.retry);
  assert.equal(retry.failureClass, "timeout");
  assert.match(String(retry.failureFingerprint), /^sha256:/);
  assert.equal(retry.retryStrategy, "fresh_session_with_carry_forward");
  assert.equal(retry.strategyChanged, true);
  assert.equal(retry.forceFreshSession, true);
  assert.equal(retry.retryAllowed, true);
  assert.equal(recordValue(retry.failureEvidence).code, "PROMPT_TIMEOUT");
});

test("Reconciler requeues verification failures with verifier retry context", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-verifier-retry");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "retry after verifier" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-verify", workerId: "w-verify" });
  await workers.registerWorker("w-verify", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "retry after verifier",
    metadata: { failureCount: 0 },
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-verify",
    orchestratorEpoch: 1,
  });

  await reconciler(hubRoot, assignments, workers, new FailureRouter())._finalizeQueue(assignment, attempt, {
    status: "failed",
    jobResult: {
      status: "failed",
      jobId: "job-verify",
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: "tests failed",
        retryable: true,
        cause: {
          verdict: {
            status: "fail",
            reason: "test expectation failed",
            blocking: [{ criterion: "unit test", file: "src/api.js", evidence: "expected 2 got 1" }],
            fix_scope: ["src/api.js"],
          },
          artifact: { kind: "verdict", id: "654321", name: "verdict-654321", path: "/tmp/verdict-654321.md" },
        },
      },
    },
  });

  const [queued] = await listQueue(hubRoot);
  const queuedMetadata = recordValue(queued.metadata);
  const queuedSourceContext = recordValue(queuedMetadata.sourceContext);
  const queuedRetry = recordValue(queuedSourceContext.retry);
  const queuedVerification = recordValue(queuedRetry.verification);
  const queuedVerdict = recordValue(queuedVerification.verdict);
  assert.equal(queued.status, "pending");
  assert.equal(queuedMetadata.lastFailureKind, FailureKind.VERIFICATION_FAILED);
  assert.equal(queuedMetadata.failureCount, 1);
  assert.equal(recordValue(queuedMetadata.retryDecision).action, "retry_same_worker");
  assert.equal(queuedRetry.failureKind, FailureKind.VERIFICATION_FAILED);
  assert.equal(queuedVerdict.status, "fail");
  assert.deepEqual(queuedVerification.retryScope, ["src/api.js"]);
  assert.match(String(queuedRetry.previousOutput), /Verifier verdict:/);
  assert.match(String(queuedRetry.previousOutput), /test expectation failed/);
});

test("Reconciler marks verification failures without actionable retry scope as failed", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-verifier-no-scope");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "do not retry verifier pollution" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-verify", workerId: "w-verify" });
  await workers.registerWorker("w-verify", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "do not retry verifier pollution",
    metadata: { failureCount: 0 },
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-verify",
    orchestratorEpoch: 1,
  });

  await reconciler(hubRoot, assignments, workers, new FailureRouter())._finalizeQueue(assignment, attempt, {
    status: "failed",
    jobResult: {
      status: "failed",
      jobId: "job-verify",
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: "runtime-only files changed: .claude/settings.local.json, cpb-task/codegraph-state.json",
        retryable: true,
        cause: {
          verdict: {
            status: "fail",
            reason: "runtime-only files changed",
            blocking: [],
            fix_scope: [],
          },
          artifact: { kind: "verdict", id: "777777", name: "verdict-777777", path: "/tmp/verdict-777777.md" },
        },
      },
    },
  });

  const [queued] = await listQueue(hubRoot);
  assert.equal(queued.status, "failed");
  assert.match(queued.metadata.failureReason, /without actionable retry scope/);
});

test("AssignmentStore idempotently rebuilds assignments without losing attempt history", async () => {
  const hubRoot = await tempRoot("cpb-assignment");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const first = await store.getOrCreateAssignmentForEntry({
    entryId: "q-1",
    projectId: "proj",
    task: "first task",
    sourcePath: "/tmp/source-one",
    workflow: "standard",
    planMode: "auto",
    sourceContext: { original: true },
    metadata: { old: true },
  });
  const attempt = await store.createAttempt(first.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });

  const rebuilt = await store.getOrCreateAssignmentForEntry({
    entryId: "q-1",
    projectId: "proj",
    task: "rerouted task",
    sourcePath: "/tmp/source-two",
    workflow: "complex",
    planMode: "full",
    sourceContext: { retry: true },
    metadata: { next: true },
  });

  assert.equal(rebuilt.assignmentId, first.assignmentId);
  assert.equal(rebuilt.status, "scheduled");
  assert.equal(rebuilt.task, "rerouted task");
  assert.equal(rebuilt.sourcePath, "/tmp/source-two");
  assert.equal(rebuilt.sourceContext.original, true);
  assert.equal(rebuilt.sourceContext.retry, true);
  assert.equal(rebuilt.metadata.old, true);
  assert.equal(rebuilt.metadata.next, true);

  const state = await store.getAssignment(first.assignmentId);
  assert.equal(state.attempts, 1);
  assert.equal(state.activeAttempt, 1);
  assert.equal((await store.getActiveAttempt(first.assignmentId)).attemptToken, attempt.attemptToken);
});

test("AssignmentStore rejects result files with mismatched attempt tokens", async () => {
  const hubRoot = await tempRoot("cpb-assignment-token");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: "q-token",
    projectId: "proj",
    task: "token",
  });
  const attempt = await store.createAttempt(assignment.assignmentId, {
    workerId: "w-token",
    orchestratorEpoch: 1,
  });

  await assert.rejects(
    store.completeAttemptFromExistingResult(assignment.assignmentId, 1, {
      assignmentId: assignment.assignmentId,
      attempt: 1,
      orchestratorEpoch: 1,
      status: "completed",
      attemptToken: "wrong-token",
    }),
    /attempt token mismatch/,
  );
  assert.equal((await store.getActiveAttempt(assignment.assignmentId)).attemptToken, attempt.attemptToken);
});

test("AssignmentStore rejects results missing the active orchestrator epoch", async () => {
  const hubRoot = await tempRoot("cpb-assignment-epoch");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: "q-epoch",
    projectId: "proj",
    task: "epoch",
  });
  const attempt = await store.createAttempt(assignment.assignmentId, {
    workerId: "w-epoch",
    orchestratorEpoch: 4,
  });

  await assert.rejects(
    store.completeAttemptFromExistingResult(assignment.assignmentId, 1, {
      assignmentId: assignment.assignmentId,
      attempt: 1,
      attemptToken: attempt.attemptToken,
      status: "completed",
    }),
    /missing orchestrator epoch/,
  );
  assert.equal((await store.getAssignment(assignment.assignmentId)).status, "assigned");
});

test("AssignmentStore prevents a late attempt from overwriting the active attempt", async () => {
  const hubRoot = await tempRoot("cpb-assignment-stale-result");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: "q-stale-result",
    projectId: "proj",
    task: "stale result",
  });
  const firstAttempt = await store.createAttempt(assignment.assignmentId, {
    workerId: "w-old",
    orchestratorEpoch: 4,
  });
  await store.getOrCreateAssignmentForEntry({
    entryId: "q-stale-result",
    projectId: "proj",
    task: "retry stale result",
  });
  const secondAttempt = await store.createAttempt(assignment.assignmentId, {
    workerId: "w-new",
    orchestratorEpoch: 5,
  });

  await assert.rejects(
    store.completeAttemptFromExistingResult(assignment.assignmentId, 1, {
      assignmentId: assignment.assignmentId,
      attempt: 1,
      orchestratorEpoch: firstAttempt.orchestratorEpoch,
      attemptToken: firstAttempt.attemptToken,
      status: "completed",
    }),
    /stale attempt.*active attempt is 2/,
  );

  const state = await store.getAssignment(assignment.assignmentId);
  assert.equal(state.activeAttempt, 2);
  assert.equal(state.status, "assigned");
  assert.equal((await store.getActiveAttempt(assignment.assignmentId)).attemptToken, secondAttempt.attemptToken);
});

test("AssignmentStore prevents stale synthetic failures from creating results", async () => {
  const hubRoot = await tempRoot("cpb-assignment-stale-synthetic");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: "q-stale-synthetic",
    projectId: "proj",
    task: "stale synthetic",
  });
  const firstAttempt = await store.createAttempt(assignment.assignmentId, {
    workerId: "w-old",
    orchestratorEpoch: 8,
  });
  await store.getOrCreateAssignmentForEntry({
    entryId: "q-stale-synthetic",
    projectId: "proj",
    task: "retry stale synthetic",
  });
  await store.createAttempt(assignment.assignmentId, {
    workerId: "w-new",
    orchestratorEpoch: 9,
  });

  await assert.rejects(
    store.writeSyntheticFailure(assignment.assignmentId, 1, {
      assignmentId: assignment.assignmentId,
      attempt: 1,
      orchestratorEpoch: firstAttempt.orchestratorEpoch,
      attemptToken: firstAttempt.attemptToken,
      status: "failed",
      jobResult: { status: "failed", failure: { kind: "worker_crashed" } },
    }),
    /stale attempt.*active attempt is 2/,
  );
  await assert.rejects(
    readJson(path.join(attemptDir(hubRoot, assignment.assignmentId, 1), "result.json")),
    /ENOENT/,
  );
  const state = await store.getAssignment(assignment.assignmentId);
  assert.equal(state.activeAttempt, 2);
  assert.equal(state.status, "assigned");
});

test("AssignmentStore returns null for a missing active attempt and rejects stale cancellation", async () => {
  const hubRoot = await tempRoot("cpb-assignment-stale-cancel");
  const store = new AssignmentStore(hubRoot);
  await store.init();
  assert.equal(await store.getActiveAttempt("a-missing"), null);

  const assignment = await store.getOrCreateAssignmentForEntry({
    entryId: "q-stale-cancel",
    projectId: "proj",
    task: "stale cancel",
  });
  await store.createAttempt(assignment.assignmentId, {
    workerId: "w-old",
    orchestratorEpoch: 1,
  });
  await store.getOrCreateAssignmentForEntry({
    entryId: "q-stale-cancel",
    projectId: "proj",
    task: "retry stale cancel",
  });
  await store.createAttempt(assignment.assignmentId, {
    workerId: "w-new",
    orchestratorEpoch: 2,
  });

  await assert.rejects(
    store.writeCancel(assignment.assignmentId, 1, "late cancel"),
    /stale attempt.*active attempt is 2/,
  );
  await assert.rejects(
    readJson(path.join(attemptDir(hubRoot, assignment.assignmentId, 1), "control", "cancel.json")),
    /ENOENT/,
  );
});

test("Reconciler advances assigned assignment from accepted file and queue claim", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-accepted");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "accept me" });
  await updateEntry(hubRoot, entry.id, { status: "scheduled", claimedBy: "w-1", workerId: "w-1" });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "accept me",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "accepted.json"), {
    attemptToken: attempt.attemptToken,
    workerId: "w-1",
  });

  await reconciler(hubRoot, assignments, workers).reconcileAssignments();

  assert.equal((await assignments.getAssignment(assignment.assignmentId)).status, "running");
  assert.equal((await listQueue(hubRoot))[0].status, "in_progress");
});

test("Reconciler ignores an uncommitted result file and finalizes only after assignment-store acceptance", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-result");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "finish me" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", {
    status: "running",
    currentAssignmentId: `a-${entry.id}`,
  });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "finish me",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  const result = {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    orchestratorEpoch: attempt.orchestratorEpoch,
    attemptToken: attempt.attemptToken,
    status: "completed",
    jobResult: { status: "completed", jobId: "job-ok" },
  };
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"), result);

  await reconciler(hubRoot, assignments, workers).reconcileAssignments();

  assert.equal((await assignments.getAssignment(assignment.assignmentId)).status, "running");
  assert.equal((await listQueue(hubRoot))[0].status, "in_progress");

  await assignments.completeAttemptFromExistingResult(assignment.assignmentId, 1, result);
  await reconciler(hubRoot, assignments, workers).reconcileAssignments();

  const finalAssignment = await assignments.getAssignment(assignment.assignmentId);
  assert.equal(finalAssignment.status, "completed");
  assert.ok(finalAssignment.queueFinalizedAt);
  assert.ok(finalAssignment.workerFinalizedAt);
  assert.equal((await listQueue(hubRoot))[0].status, "completed");
  const worker = await workers.getWorker("w-1");
  assert.equal(worker.status, "ready");
  assert.equal(worker.currentAssignmentId, null);
});

test("Reconciler finalizes cancelled result files as cancelled queue entries", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-cancelled");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "cancel me" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", {
    status: "running",
    currentAssignmentId: `a-${entry.id}`,
  });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "cancel me",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });

  await reconciler(hubRoot, assignments, workers)._finalizeQueue(assignment, attempt, {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    attemptToken: attempt.attemptToken,
    status: "cancelled",
    jobResult: {
      status: "cancelled",
      failure: {
        kind: FailureKind.RUNTIME_INTERRUPTED,
        reason: "assignment cancelled: user requested",
        retryable: false,
      },
    },
  });

  const [queued] = await listQueue(hubRoot);
  assert.equal(queued.status, "cancelled");
  assert.match(queued.metadata.cancelReason, /user requested/);
});

test("Reconciler schedules finalizer-only read-only recovery without rerunning job execution", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-finalizer-blocked");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "blocked finalize" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "blocked finalize",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 6,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  const heartbeat = {
    workerId: "w-1",
    workerIncarnation: "incarnation-1",
    processIdentity: {
      pid: 1201,
      startTimeTicks: "9001",
      birthIdPrecision: "exact",
    },
  };
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "heartbeat.json"), heartbeat);
  await assignments.recordHeartbeat(assignment.assignmentId, 1, heartbeat);
  const ownerDigest = finalizerMutationFenceDigest({
    assignmentId: assignment.assignmentId,
    entryId: assignment.entryId,
    attemptToken: attempt.attemptToken,
    orchestratorEpoch: attempt.orchestratorEpoch,
    workerId: "w-1",
    workerIncarnation: "incarnation-1",
    processIdentity: { pid: 1201, startTimeTicks: "9001" },
  });
  const blockedResult = {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    orchestratorEpoch: attempt.orchestratorEpoch,
    attemptToken: attempt.attemptToken,
    status: "blocked",
    jobResult: {
      status: "blocked",
      jobId: "job-finalizer",
      failure: {
        kind: "finalizer_failed",
        phase: "finalize",
        reason: "PR evidence blocked",
        retryable: false,
      },
    },
    finalizeResult: {
      ok: false,
      status: "blocked",
      code: "REMOTE_WRITE_AMBIGUOUS",
      mode: "remote",
      jobId: "job-finalizer",
      committed: null,
      retryable: true,
      remoteIntent: {
        schema: "cpb.finalizer-mutation-receipt.v1",
        finalizationId: "f".repeat(64),
        generation: 1,
        project: "proj",
        entryId: assignment.entryId,
        originJobId: "job-finalizer",
        mode: "remote",
        stage: "repository.push.intent",
        source: { branch: "main", head: "a".repeat(40) },
        targetBranch: "main",
        preRemoteHead: "a".repeat(40),
        commit: "b".repeat(40),
        tree: "c".repeat(40),
        claim: {
          claimId: "d".repeat(64),
          claimGeneration: 1,
          ownerDigest,
        },
        receipts: {},
      },
    },
    finalization: { required: true, ok: false, status: "blocked" },
  };
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"), blockedResult);
  await assignments.completeAttemptFromExistingResult(assignment.assignmentId, 1, blockedResult);

  await reconciler(hubRoot, assignments, workers).reconcileAssignments();

  const [queued] = await listQueue(hubRoot);
  assert.equal(queued.status, "pending");
  const recovery = recordValue(queued.metadata.finalizerRecovery);
  assert.equal(recovery.schema, "cpb.finalizer-recovery.v1");
  assert.equal(recovery.allowMutation, false);
  assert.equal(recovery.originJobId, "job-finalizer");
  assert.equal(recordValue(recovery.priorAttemptProof).acceptedOwnerDigest, ownerDigest);
  assert.equal(recordValue(recordValue(recovery.lastObservationProof).evidence).journalDigest,
    recordValue(recordValue(recovery.priorAttemptProof).evidence).journalDigest);
  assert.equal((await assignments.getAssignment(assignment.assignmentId)).status, "blocked");
});

test("Reconciler writes synthetic failure for stale assignment heartbeat", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-heartbeat");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "stale heartbeat" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "stale heartbeat",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "heartbeat.json"), {
    updatedAt: oldIso(180_000),
  });

  await reconciler(hubRoot, assignments, workers).reconcileAssignments();

  const result = await readJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"));
  assert.equal(result.status, "failed");
  assert.equal(result.attemptToken, attempt.attemptToken);
  assert.equal(result.jobResult.failure.kind, "worker_heartbeat_lost");
  assert.equal((await assignments.getAssignment(assignment.assignmentId)).status, "failed");
  assert.equal((await listQueue(hubRoot))[0].status, "failed");
});

test("Reconciler classifies staged progress delay levels before force retry", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-progress-levels");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const rec = reconciler(hubRoot, assignments, workers, {}, {
    progressForceRetryMs: 35 * 60_000,
  });
  const assignment = { assignmentId: "a-q-progress-levels", entryId: "q-progress-levels" };
  const attempt = { attempt: 1 };
  const heartbeat = (ageMs) => ({
    status: "running",
    activePhase: "plan",
    progressUpdatedAt: oldIso(ageMs),
    updatedAt: new Date().toISOString(),
  });

  assert.equal(rec._classifyProgressDelay(assignment, attempt, heartbeat(5 * 60_000 + 1_000)).level, "info");
  assert.equal(rec._classifyProgressDelay(assignment, attempt, heartbeat(15 * 60_000 + 1_000)).level, "warn");
  const errorDelay = rec._classifyProgressDelay(assignment, attempt, heartbeat(30 * 60_000 + 1_000));
  assert.equal(errorDelay.level, "error");
  assert.equal(errorDelay.shouldFail, false);
  const forceDelay = rec._classifyProgressDelay(assignment, attempt, heartbeat(35 * 60_000 + 1_000));
  assert.equal(forceDelay.level, "force");
  assert.equal(forceDelay.shouldFail, true);
});

test("Reconciler records staged progress delay without failing before force retry", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-progress-error-only");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "progress warning" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "progress warning",
  });
  await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "heartbeat.json"), {
    workerId: "w-1",
    assignmentId: assignment.assignmentId,
    attempt: 1,
    status: "running",
    activePhase: "execute",
    progressUpdatedAt: oldIso(30 * 60_000 + 1_000),
    updatedAt: new Date().toISOString(),
  });

  await reconciler(hubRoot, assignments, workers, {}, { progressForceRetryMs: 35 * 60_000 }).reconcileAssignments();

  await assert.rejects(
    readJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json")),
    /ENOENT/,
  );
  const probe = await readJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "progress-probe-error.json"));
  assert.equal(probe.depth, "deep");
  assert.equal(probe.waitUseful, true);
  assert.deepEqual(probe.failureSignals, []);
  assert.equal((await assignments.getAssignment(assignment.assignmentId)).status, "running");
  assert.equal((await listQueue(hubRoot))[0].status, "in_progress");
});

test("Reconciler closes stale progress early when probe proves waiting cannot recover", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-progress-early-close");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "early close" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-dead", workerId: "w-dead" });
  await workers.registerWorker("w-dead", {
    status: "exited",
    currentAssignmentId: `a-${entry.id}`,
    pid: 999999999,
  });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "early close",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-dead",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "heartbeat.json"), {
    workerId: "w-dead",
    assignmentId: assignment.assignmentId,
    attempt: 1,
    status: "running",
    activePhase: "plan",
    progressUpdatedAt: oldIso(15 * 60_000 + 1_000),
    updatedAt: new Date().toISOString(),
    pid: 999999999,
  });

  await reconciler(hubRoot, assignments, workers, new FailureRouter(), {
    progressForceRetryMs: 35 * 60_000,
  }).reconcileAssignments();

  const result = await readJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"));
  assert.equal(result.status, "failed");
  assert.equal(result.attemptToken, attempt.attemptToken);
  assert.equal(result.jobResult.failure.kind, "assignment_progress_stale");
  assert.match(result.jobResult.failure.reason, /probe confirmed waiting cannot recover/);
  assert.equal(result.jobResult.failure.cause.probe.waitUseful, false);
  assert.ok(result.jobResult.failure.cause.probe.failureSignals.includes("worker_status_exited"));
  assert.ok(result.jobResult.failure.cause.probe.failureSignals.includes("worker_process_identity_missing"));
  assert.equal((await listQueue(hubRoot))[0].status, "pending");
});

test("Reconciler forces retry for fresh heartbeat with stale progress past grace period", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-progress-stale");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  const stopped = [];
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "stale progress" });
  await updateEntry(hubRoot, entry.id, { status: "in_progress", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", { status: "running", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "stale progress",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await assignments.markRunning(assignment.assignmentId, 1);
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "heartbeat.json"), {
    workerId: "w-1",
    assignmentId: assignment.assignmentId,
    attempt: 1,
    status: "running",
    phase: "plan",
    activePhase: "plan",
    activeJobId: "job-stale-progress",
    progressUpdatedAt: oldIso(300_000),
    updatedAt: new Date().toISOString(),
    worktreePath: "/tmp/worktree",
    pid: 12345,
  });

  await reconciler(hubRoot, assignments, workers, new FailureRouter(), {
    progressForceRetryMs: 120_000,
    workerSupervisor: {
      stopWorker: async (workerId, reason) => {
        stopped.push({ workerId, reason });
        await workers.updateWorker(workerId, { status: "draining", stopReason: reason });
      },
    },
  }).reconcileAssignments();

  const result = await readJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"));
  assert.equal(result.status, "failed");
  assert.equal(result.attemptToken, attempt.attemptToken);
  assert.equal(result.jobResult.failure.kind, "assignment_progress_stale");
  assert.equal(result.jobResult.failure.phase, "plan");
  assert.equal(result.jobResult.failure.cause.activeJobId, "job-stale-progress");
  assert.equal(result.jobResult.failure.cause.worktreePath, "/tmp/worktree");
  assert.equal(result.jobResult.failure.cause.forceRetryThresholdMs, 120_000);
  assert.equal((await assignments.getAssignment(assignment.assignmentId)).status, "failed");
  assert.equal((await listQueue(hubRoot))[0].status, "pending");
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].workerId, "w-1");
  assert.match(stopped[0].reason, /^assignment_progress_stale: phase plan made no progress/);
  const worker = await workers.getWorker("w-1");
  assert.equal(worker.status, "draining");
  assert.equal(worker.currentAssignmentId, null);
});

test("Reconciler compensates terminal assignments missing queue and worker finalization", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-compensate");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const entry = await enqueue(hubRoot, { projectId: "proj", description: "compensate" });
  await updateEntry(hubRoot, entry.id, { status: "scheduled", claimedBy: "w-1", workerId: "w-1" });
  await workers.registerWorker("w-1", { status: "assigned", currentAssignmentId: `a-${entry.id}` });
  const assignment = await assignments.getOrCreateAssignmentForEntry({
    entryId: entry.id,
    projectId: "proj",
    task: "compensate",
  });
  const attempt = await assignments.createAttempt(assignment.assignmentId, {
    workerId: "w-1",
    orchestratorEpoch: 1,
  });
  await writeJson(path.join(attemptDir(hubRoot, assignment.assignmentId), "result.json"), {
    assignmentId: assignment.assignmentId,
    attempt: 1,
    orchestratorEpoch: attempt.orchestratorEpoch,
    attemptToken: attempt.attemptToken,
    status: "completed",
    jobResult: { status: "completed" },
  });
  await writeJson(path.join(hubRoot, "assignments", assignment.assignmentId, "state.json"), {
    ...(await assignments.getAssignment(assignment.assignmentId)),
    status: "completed",
    resultWrittenAt: new Date().toISOString(),
    queueFinalizedAt: null,
    workerFinalizedAt: null,
  });

  await reconciler(hubRoot, assignments, workers).reconcileAssignments();

  const finalAssignment = await assignments.getAssignment(assignment.assignmentId);
  assert.ok(finalAssignment.queueFinalizedAt);
  assert.ok(finalAssignment.workerFinalizedAt);
  assert.equal((await listQueue(hubRoot))[0].status, "completed");
  assert.equal((await workers.getWorker("w-1")).currentAssignmentId, null);
});

test("Reconciler refuses mutation when leader lock is lost", async () => {
  const hubRoot = await tempRoot("cpb-reconciler-fence");
  const assignments = new AssignmentStore(hubRoot);
  const workers = new WorkerStore(hubRoot);
  await assignments.init();
  await workers.init();
  const rec = new Reconciler(hubRoot, {
    assignmentStore: assignments,
    workerStore: workers,
    leaderLock: { stillHeld: async () => false },
    failureRouter: { route: async () => ({ action: "mark_failed" }), resetBudget: () => {} },
  });

  await assert.rejects(rec.reconcileAssignments(), /leader lock lost/);
});
