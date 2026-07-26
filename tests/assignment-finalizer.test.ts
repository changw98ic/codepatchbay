import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  finalizeAndWriteSuccessfulResult,
  maybeFinalizeSuccessfulAssignment,
  normalizeFinalizerResult,
  recoverAndWriteFinalizerOnlyResult,
} from "../runtime/worker/assignment-finalizer.js";
import { shouldCleanupWorkerWorktree } from "../runtime/worker/managed-worker.js";
import { recordValue, type LooseRecord } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

const execFile = promisify(execFileCallback);

type AssignmentOverrides = Record<string, unknown> & { metadata?: Record<string, unknown> };

function completedAssignment(overrides: AssignmentOverrides = {}) {
  const { metadata: metadataOverrides = {}, ...rest } = overrides;
  return {
    assignmentId: "a-finalize",
    entryId: "entry-finalize",
    projectId: "proj",
    task: "Fix issue with evidence",
    sourcePath: "/tmp/source",
    sourceContext: {
      issueNumber: 42,
      issueTitle: "Fix issue with evidence",
      repo: "owner/repo",
    },
    metadata: {
      autoFinalize: true,
      issueNumber: 42,
      repo: "owner/repo",
      issueUrl: "https://github.com/owner/repo/issues/42",
      ...metadataOverrides,
    },
    ...rest,
  };
}

function dryRunSuccess(extra: LooseRecord = {}) {
  return {
    ok: true,
    status: "dry-run",
    mode: "dry-run",
    committed: false,
    pr: { status: "dry-run" },
    ...extra,
  };
}

function completedCandidate(baseSha = "a".repeat(40), headSha = "b".repeat(40), treeHash = "c".repeat(40)) {
  const identityHash = `sha256:${"d".repeat(64)}`;
  return {
    status: "completed",
    completionGate: {
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
    },
  };
}

async function finalizerCandidateRepository(prefix: string) {
  const worktreePath = await tempRoot(prefix);
  await execFile("git", ["init", "-b", "main"], { cwd: worktreePath });
  await execFile("git", ["config", "user.email", "cpb@example.test"], { cwd: worktreePath });
  await execFile("git", ["config", "user.name", "CPB Test"], { cwd: worktreePath });
  await writeFile(path.join(worktreePath, "candidate.txt"), "candidate\n", "utf8");
  await execFile("git", ["add", "candidate.txt"], { cwd: worktreePath });
  await execFile("git", ["commit", "-m", "candidate"], { cwd: worktreePath });
  const commit = (await execFile("git", ["rev-parse", "HEAD"], { cwd: worktreePath })).stdout.trim();
  const tree = (await execFile("git", ["rev-parse", "HEAD^{tree}"], { cwd: worktreePath })).stdout.trim();
  return {
    commit,
    tree,
    result: completedCandidate(commit, commit, tree),
    worktreeInfo: {
      path: worktreePath,
      branch: "main",
      baseBranch: "main",
      baseCommit: commit,
    },
  };
}

test("maybeFinalizeSuccessfulAssignment defaults GitHub auto-finalize to dry-run without fetching push token", async () => {
  let captured: LooseRecord | null = null;
  let tokenCalls = 0;

  const result = await maybeFinalizeSuccessfulAssignment({
    cpbRoot: await tempRoot("cpb-finalizer-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-hub"),
    assignment: completedAssignment(),
    attemptNum: 1,
    jobId: "job-finalize",
    result: { status: "completed", jobId: "job-finalize", phaseResults: [] },
    worktreeInfo: { path: "/tmp/worktree", branch: "cpb/job-finalize" },
    resolveTransport: async () => ({
      mode: "app",
      createPullRequest: async () => {
        throw new Error("dry-run must not create a pull request");
      },
      getToken: async () => {
        tokenCalls += 1;
        return "ghp_should_not_be_requested_for_dry_run";
      },
    }),
    finalizeQueueEntry: async (args: LooseRecord) => {
      captured = args;
      return dryRunSuccess({ jobId: recordValue(args.job).jobId });
    },
  });

  const capturedJob = recordValue(captured?.job);
  const capturedSourceContext = recordValue(capturedJob.sourceContext);
  assert.equal(result?.status, "dry-run");
  assert.equal(captured?.mode, "dry-run");
  assert.equal(capturedJob.jobId, "job-finalize");
  assert.equal(capturedSourceContext.repo, "owner/repo");
  assert.equal(captured?.createPullRequest, null);
  assert.equal(captured?.pushToken, null);
  assert.equal(tokenCalls, 0);
});

test("maybeFinalizeSuccessfulAssignment requires explicit live opt-in for PR mode", async () => {
  let captured: LooseRecord | null = null;

  await maybeFinalizeSuccessfulAssignment({
    cpbRoot: await tempRoot("cpb-finalizer-live-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-live-hub"),
    assignment: completedAssignment({ metadata: { finalizeMode: "pr" } }),
    attemptNum: 1,
    jobId: "job-live",
    result: { status: "completed", jobId: "job-live", phaseResults: [] },
    worktreeInfo: { path: "/tmp/worktree", branch: "cpb/job-live" },
    resolveTransport: async () => ({
      mode: "app",
      createPullRequest: async () => ({ url: "https://github.com/owner/repo/pull/7", number: 7 }),
      getToken: async () => "token",
    }),
    finalizeQueueEntry: async (args: LooseRecord) => {
      captured = args;
      return { ok: false, status: "blocked", code: "LIVE_FINALIZE_NOT_ALLOWED", mode: args.mode };
    },
  });

  assert.equal(captured?.mode, "dry-run");
  assert.equal(captured?.createPullRequest, null);
  assert.equal(captured?.pushToken, null);
});

test("local finalization is candidate-bound and never resolves GitHub transport", async () => {
  let transportCalls = 0;
  let captured: LooseRecord | null = null;
  const result = await maybeFinalizeSuccessfulAssignment({
    cpbRoot: await tempRoot("cpb-finalizer-local-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-local-hub"),
    assignment: completedAssignment({
      sourceContext: { sourceBranch: "main", sourceHead: "a".repeat(40) },
      metadata: { finalizeMode: "local", allowLiveFinalize: true },
    }),
    attemptNum: 1,
    jobId: "job-local",
    result: { ...completedCandidate(), jobId: "job-local" },
    worktreeInfo: {
      path: "/tmp/worktree-local",
      branch: "cpb/job-local",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
    },
    resolveTransport: async () => {
      transportCalls += 1;
      throw new Error("local mode must not resolve GitHub transport");
    },
    finalizeQueueEntry: async (options: LooseRecord) => {
      captured = options;
      return {
        ok: false,
        status: "blocked",
        code: "LOCAL_TEST_BLOCKED",
        mode: "local",
        jobId: "job-local",
        committed: false,
        retryable: false,
      };
    },
  });

  assert.equal(transportCalls, 0);
  assert.equal(captured?.transportPrincipal, null);
  assert.equal(result?.code, "LOCAL_TEST_BLOCKED");
});

test("live finalization rejects a candidate from a different managed worktree base before mutation", async () => {
  let finalizeCalls = 0;
  const result = await maybeFinalizeSuccessfulAssignment({
    cpbRoot: await tempRoot("cpb-finalizer-base-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-base-hub"),
    assignment: completedAssignment({ metadata: { finalizeMode: "local", allowLiveFinalize: true } }),
    attemptNum: 1,
    jobId: "job-base-mismatch",
    result: { ...completedCandidate("a".repeat(40)), jobId: "job-base-mismatch" },
    worktreeInfo: {
      path: "/tmp/worktree-base-mismatch",
      branch: "cpb/job-base-mismatch",
      baseBranch: "main",
      baseCommit: "f".repeat(40),
    },
    finalizeQueueEntry: async () => {
      finalizeCalls += 1;
      return {};
    },
  });
  const structured = recordValue(result);
  assert.equal(finalizeCalls, 0);
  assert.equal(structured.code, "FINALIZER_CANDIDATE_BINDING_INVALID");
  assert.equal(structured.committed, false);
});

test("maybeFinalizeSuccessfulAssignment resolves project dataRoot before finalizer evidence lookup", async () => {
  let captured: LooseRecord | null = null;

  await maybeFinalizeSuccessfulAssignment({
    cpbRoot: await tempRoot("cpb-finalizer-data-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-data-hub"),
    assignment: completedAssignment(),
    attemptNum: 1,
    jobId: "job-data-root",
    result: { status: "completed", jobId: "job-data-root", phaseResults: [] },
    worktreeInfo: { path: "/tmp/worktree", branch: "cpb/job-data-root" },
    resolveDataRoot: async () => "/tmp/project-runtime-root",
    finalizeQueueEntry: async (args: LooseRecord) => {
      captured = args;
      return dryRunSuccess();
    },
  });

  assert.equal(captured?.dataRoot, "/tmp/project-runtime-root");
});

test("managed assignment finalizer carries the exact remote capability into entry and job", async () => {
  const capability = {
    schema: "cpb.github-remote-capability.v1",
    repository: "owner/repo",
    repositoryId: "R_owner_repo",
    defaultBranch: "main",
    markerPath: ".cpb-disposable-target.json",
    markerSha: "a".repeat(40),
    issueNumber: 42,
    automationLabel: "cpb-e2e",
    allowedBranchPrefix: "cpb/",
    permissions: {
      repositoryPush: true,
      pullRequestCreate: true,
      pullRequestMerge: true,
      issueClose: true,
    },
  };
  let captured: LooseRecord | null = null;
  const principal = { kind: "gh_user", stableId: "U_owner", login: "owner" };
  const remoteAuthorityValidator = async () => ({ ok: true });
  const remoteCommitVerifier = async () => ({ ok: true, observedAt: new Date().toISOString() });

  await maybeFinalizeSuccessfulAssignment({
    cpbRoot: await tempRoot("cpb-finalizer-capability-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-capability-hub"),
    assignment: completedAssignment({
      sourceContext: {
        issueNumber: 42,
        issueTitle: "Fix issue with evidence",
        repo: "owner/repo",
        sourceBranch: "main",
        sourceHead: "a".repeat(40),
        remoteCapability: capability,
      },
      metadata: {
        finalizeMode: "remote",
        allowLiveFinalize: true,
        remoteCapability: capability,
        remoteCapabilityRequired: true,
      },
    }),
    attemptNum: 1,
    jobId: "job-capability",
    result: { ...completedCandidate(), jobId: "job-capability", phaseResults: [] },
    worktreeInfo: {
      path: "/tmp/worktree",
      branch: "cpb/job-capability",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
    },
    resolveTransport: async () => ({
      mode: "gh",
      principal,
      remoteAuthorityValidator,
      remoteCommitVerifier,
      closeIssue: async () => ({ ok: true, state: "CLOSED" }),
      getToken: async () => null,
    }),
    finalizeQueueEntry: async (args: LooseRecord) => {
      captured = args;
      return { ok: true, status: "finalized", mode: args.mode };
    },
  });

  assert.equal(captured?.mode, "remote");
  const capturedMetadata = recordValue(recordValue(captured?.entry).metadata);
  assert.deepEqual(capturedMetadata.remoteCapability, capability);
  assert.equal(capturedMetadata.remoteCapabilityRequired, true);
  assert.deepEqual(recordValue(recordValue(captured?.job).sourceContext).remoteCapability, capability);
  assert.deepEqual(captured?.transportPrincipal, principal);
  assert.equal(captured?.remoteAuthorityValidator, remoteAuthorityValidator);
  assert.equal(captured?.remoteCommitVerifier, remoteCommitVerifier);
});

test("finalizeAndWriteSuccessfulResult converts a blocked finalizer into a blocked attempt", async () => {
  const attemptDir = await tempRoot("cpb-finalizer-blocked");
  let written: LooseRecord | null = null;
  const assignment = completedAssignment({
    assignmentId: "a-blocked",
    entryId: "blocked",
    attemptToken: "token-blocked",
    orchestratorEpoch: 7,
  });

  const finalizeResult = await finalizeAndWriteSuccessfulResult({
    cpbRoot: await tempRoot("cpb-finalizer-blocked-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-blocked-hub"),
    assignment,
    attemptDir,
    assignmentId: "a-blocked",
    attemptNum: 1,
    jobId: "job-blocked",
    result: { status: "completed", jobId: "job-blocked" },
    worktreeInfo: { path: "/tmp/worktree-blocked", branch: "cpb/blocked" },
    finalizeQueueEntry: async () => ({
      ok: false,
      status: "blocked",
      code: "PR_EVIDENCE_BLOCKED",
      reason: "completion evidence is missing",
      mode: "dry-run",
      jobId: "job-blocked",
      committed: false,
      retryable: false,
    }),
    writeResult: async (_file, value) => {
      written = recordValue(value);
      return true;
    },
  });

  const jobResult = recordValue(written?.jobResult);
  const failure = recordValue(jobResult.failure);
  const recovery = recordValue(written?.recovery);
  assert.equal(finalizeResult?.ok, false);
  assert.equal(written?.status, "blocked");
  assert.equal(written?.orchestratorEpoch, 7);
  assert.equal(jobResult.status, "blocked");
  assert.equal(failure.kind, "finalizer_failed");
  assert.equal(failure.phase, "finalize");
  assert.equal(recovery.retainWorktree, true);
  assert.equal(recovery.worktreePath, "/tmp/worktree-blocked");
});

test("finalizer rejects an unstructured ok=true result and retains the worktree", async () => {
  const attemptDir = await tempRoot("cpb-finalizer-malformed-success");
  let written: LooseRecord | null = null;
  const finalizeResult = await finalizeAndWriteSuccessfulResult({
    cpbRoot: await tempRoot("cpb-finalizer-malformed-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-malformed-hub"),
    assignment: completedAssignment({ attemptToken: "token-malformed" }),
    attemptDir,
    assignmentId: "a-finalize",
    attemptNum: 1,
    jobId: "job-malformed",
    result: { status: "completed", jobId: "job-malformed" },
    worktreeInfo: { path: "/tmp/worktree-malformed", branch: "cpb/malformed" },
    finalizeQueueEntry: async () => ({ ok: true }),
    writeResult: async (_file, value) => {
      written = recordValue(value);
      return true;
    },
  });

  assert.equal(finalizeResult?.ok, false);
  assert.equal(finalizeResult?.code, "FINALIZER_RESULT_INVALID");
  assert.equal(written?.status, "failed");
  assert.equal(recordValue(written?.recovery).retainWorktree, true);
});

test("finalizer exception preserves committed=null and completed remote receipts", async () => {
  const candidate = await finalizerCandidateRepository("cpb-finalizer-null-worktree");
  const result = await maybeFinalizeSuccessfulAssignment({
    cpbRoot: await tempRoot("cpb-finalizer-null-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-null-hub"),
    assignment: completedAssignment({
      sourceContext: {
        repo: "owner/repo",
        issueNumber: 42,
        sourceBranch: "main",
        sourceHead: candidate.commit,
      },
      metadata: {
        finalizeMode: "remote",
        allowLiveFinalize: true,
        repo: "owner/repo",
        issueNumber: 42,
      },
    }),
    attemptNum: 2,
    jobId: "job-null-a2",
    result: { ...candidate.result, jobId: "job-null-a2" },
    worktreeInfo: candidate.worktreeInfo,
    resolveTransport: async () => ({ mode: "gh" }),
    finalizeQueueEntry: async () => {
      throw Object.assign(new Error("lease changed"), {
        code: "MUTATION_LEASE_LOST",
        status: "blocked",
        mode: "remote",
        jobId: "job-null-a2",
        committed: null,
        retryable: true,
        commit: candidate.commit,
        tree: candidate.tree,
        remoteWrites: {
          push: { attempted: true, committed: true },
          issueClose: { attempted: false, committed: null },
        },
        remoteIntent: {
          finalizationId: "finalization-1",
          generation: 2,
          stage: "issue.close",
        },
      });
    },
  });

  const structuredResult = recordValue(result);
  assert.equal(structuredResult.code, "MUTATION_LEASE_LOST");
  assert.equal(structuredResult.committed, null);
  assert.equal(structuredResult.retryable, true);
  assert.equal(recordValue(recordValue(structuredResult.remoteWrites).push).committed, true);
  assert.equal(recordValue(recordValue(structuredResult.remoteWrites).issueClose).committed, null);
  assert.equal(recordValue(structuredResult.remoteIntent).generation, 2);
});

test("finalizer exception cannot replace caller-bound mode/job identity and redacts logs", async () => {
  const warnings: string[] = [];
  const result = await maybeFinalizeSuccessfulAssignment({
    cpbRoot: await tempRoot("cpb-finalizer-bound-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-bound-hub"),
    assignment: completedAssignment({
      sourceContext: { repo: "owner/repo", issueNumber: 42, sourceBranch: "main", sourceHead: "a".repeat(40) },
      metadata: {
        finalizeMode: "remote",
        allowLiveFinalize: true,
        repo: "owner/repo",
        issueNumber: 42,
      },
    }),
    attemptNum: 1,
    jobId: "job-bound",
    result: { ...completedCandidate(), jobId: "job-bound" },
    worktreeInfo: {
      path: "/tmp/worktree-bound",
      branch: "cpb/bound",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
    },
    resolveTransport: async () => ({ mode: "gh" }),
    finalizeQueueEntry: async () => {
      throw Object.assign(new Error("Bearer leaked-finalizer-token"), {
        code: "MUTATION_LEASE_LOST",
        status: "blocked",
        mode: "dry-run",
        jobId: "job-forged",
        committed: null,
        retryable: true,
      });
    },
    log: { warn: (message) => warnings.push(message) },
  });

  const structured = recordValue(result);
  assert.equal(structured.mode, "remote");
  assert.equal(structured.jobId, "job-bound");
  assert.deepEqual(structured.reportedIdentity, { mode: "dry-run", jobId: "job-forged" });
  assert.equal(structured.reason, "Bearer [REDACTED]");
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /leaked-finalizer-token/);
  assert.match(warnings[0], /Bearer \[REDACTED\]/);
});

test("ambiguous cancellation preserves partial remote receipts in the blocked terminal result", async () => {
  const candidate = await finalizerCandidateRepository("cpb-finalizer-cancel-worktree");
  let written: LooseRecord | null = null;
  const assignment = completedAssignment({
    assignmentId: "a-cancel-partial",
    entryId: "cancel-partial",
    attemptToken: "token-cancel-partial",
    orchestratorEpoch: 11,
    sourceContext: { repo: "owner/repo", issueNumber: 42, sourceBranch: "main", sourceHead: candidate.commit },
    metadata: {
      autoFinalize: true,
      finalizeMode: "remote",
      allowLiveFinalize: true,
      repo: "owner/repo",
      issueNumber: 42,
    },
  });

  const finalizeResult = await finalizeAndWriteSuccessfulResult({
    cpbRoot: await tempRoot("cpb-finalizer-cancel-partial-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-cancel-partial-hub"),
    assignment,
    attemptDir: await tempRoot("cpb-finalizer-cancel-partial-attempt"),
    assignmentId: "a-cancel-partial",
    attemptNum: 1,
    jobId: "job-cancel-partial",
    result: { ...candidate.result, jobId: "job-cancel-partial" },
    worktreeInfo: candidate.worktreeInfo,
    resolveTransport: async () => ({ mode: "gh" }),
    finalizeQueueEntry: async () => {
      throw Object.assign(new Error("assignment cancelled after push"), {
        code: "ASSIGNMENT_CANCELLED",
        status: "blocked",
        mode: "remote",
        jobId: "job-cancel-partial",
        committed: null,
        retryable: true,
        commit: candidate.commit,
        tree: candidate.tree,
        remoteWrites: {
          push: { attempted: true, committed: true },
          issueClose: { attempted: false, committed: null },
        },
        remoteIntent: {
          finalizationId: "f".repeat(64),
          generation: 1,
          stage: "issue.close",
        },
      });
    },
    writeResult: async (_file, value) => {
      written = recordValue(value);
      return true;
    },
  });

  const structuredFinalizeResult = recordValue(finalizeResult);
  assert.equal(structuredFinalizeResult.committed, null);
  assert.equal(recordValue(recordValue(structuredFinalizeResult.remoteWrites).push).committed, true);
  assert.equal(written?.status, "blocked");
  assert.equal(recordValue(written?.finalizeResult).committed, null);
  assert.equal(recordValue(recordValue(recordValue(written?.finalizeResult).remoteWrites).push).committed, true);
  assert.equal(recordValue(written?.recovery).reason, "finalization_blocked");
});

test("finalizer-only recovery uses the durable journal service and publishes under the active fence", async () => {
  const principal = { kind: "gh_user", stableId: "U_owner", login: "owner" };
  const capability = {
    schema: "cpb.github-remote-capability.v1",
    repository: "owner/repo",
    repositoryId: "R_owner_repo",
    defaultBranch: "main",
    markerPath: ".cpb-disposable-target.json",
    markerSha: "a".repeat(40),
    issueNumber: 42,
    automationLabel: "cpb-e2e",
    allowedBranchPrefix: "cpb/",
    permissions: {
      repositoryPush: true,
      pullRequestCreate: true,
      pullRequestMerge: true,
      issueClose: true,
    },
  };
  const assignment = completedAssignment({
    assignmentId: "a-recover",
    entryId: "recover",
    attemptToken: "attempt-recover",
    orchestratorEpoch: 12,
    sourceContext: {
      repo: "owner/repo",
      issueNumber: 42,
      sourceBranch: "main",
      sourceHead: "a".repeat(40),
      remoteCapability: capability,
    },
    metadata: {
      autoFinalize: true,
      finalizeMode: "remote",
      allowLiveFinalize: true,
      remoteCapability: capability,
      finalizerRecovery: {
        schema: "cpb.finalizer-recovery.v1",
        required: true,
        generation: 1,
        allowMutation: false,
      },
    },
  });
  const mutationFence = {
    assignmentId: "a-recover",
    entryId: "recover",
    attemptToken: "attempt-recover",
    orchestratorEpoch: 12,
    workerId: "w-recover",
    workerIncarnation: "inc-recover",
    processIdentity: { pid: 123, startTimeTicks: "456" },
  };
  const commit = "b".repeat(40);
  const tree = "c".repeat(40);
  let recoveryOptions: LooseRecord | null = null;
  let written: LooseRecord | null = null;
  const leaseOperations: string[] = [];

  const finalizeResult = await recoverAndWriteFinalizerOnlyResult({
    cpbRoot: await tempRoot("cpb-finalizer-only-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-only-hub"),
    dataRoot: await tempRoot("cpb-finalizer-only-data"),
    assignment,
    attemptDir: await tempRoot("cpb-finalizer-only-attempt"),
    assignmentId: "a-recover",
    attemptNum: 2,
    jobId: "job-recover-a2",
    resolveTransport: async () => ({
      mode: "gh",
      principal,
      remoteAuthorityValidator: async () => ({ ok: true }),
      remoteCommitVerifier: async () => ({ committed: true }),
    }),
    recoverFinalizerOnly: async (options) => {
      recoveryOptions = options;
      return {
        ok: true,
        status: "finalized",
        mode: "remote",
        jobId: "job-recover-a2",
        commit,
        tree,
        pushed: true,
        closed: true,
        localSynced: true,
        committed: true,
        sourceSync: {
          committed: true,
          clean: true,
          expectedBranch: "main",
          previousHead: "a".repeat(40),
          expectedHead: commit,
          actualBranch: "main",
          actualHead: commit,
        },
        remoteWrites: {
          push: { attempted: true, committed: true },
          issueClose: { attempted: true, committed: true },
        },
        principal,
        remoteIntent: {
          finalizationId: "f".repeat(64),
          generation: 2,
          stage: "local.complete",
        },
      };
    },
    validateMutationReceipt: (value) => ({ ok: true, receipt: recordValue(value) }),
    mutationFence,
    verifiedPriorAttempt: {
      ownerDigest: "d".repeat(64),
      source: { branch: "main", head: "a".repeat(40) },
      targetBranch: "main",
      preRemoteHead: "a".repeat(40),
      originJobId: "job-recover-origin",
      candidate: {
        baseSha: "a".repeat(40),
        headSha: commit,
        treeHash: tree,
        identityHash: `sha256:${"e".repeat(64)}`,
        cleanReplay: {
          cleanApply: true,
          baseSha: "a".repeat(40),
          expectedTreeHash: tree,
          actualTreeHash: tree,
        },
      },
      completionGate: {
        outcome: "complete",
        completionReport: {
          candidateValidation: {
            baseSha: "a".repeat(40),
            headSha: commit,
            treeHash: tree,
            identityHash: `sha256:${"e".repeat(64)}`,
            validatedCandidateIdentityHash: `sha256:${"e".repeat(64)}`,
            identityMatch: true,
            cleanReplay: {
              cleanApply: true,
              baseSha: "a".repeat(40),
              expectedTreeHash: tree,
              actualTreeHash: tree,
            },
          },
        },
      },
    },
    assertMutationLease: async (context) => {
      leaseOperations.push(context.operation);
      return true;
    },
    writeResult: async (_file, value) => {
      written = recordValue(value);
      return true;
    },
  });

  assert.equal(recoveryOptions?.allowMutation, false);
  assert.equal(recoveryOptions?.originJobId, "job-recover-origin");
  assert.deepEqual(recoveryOptions?.transportPrincipal, principal);
  assert.equal(recoveryOptions?.transportMode, "gh");
  assert.equal(typeof recoveryOptions?.remoteAuthorityValidator, "function");
  assert.deepEqual(recoveryOptions?.mutationFence, mutationFence);
  assert.equal(finalizeResult.ok, true);
  assert.equal(written?.status, "completed");
  assert.equal(recordValue(written?.finalization).recoveryOnly, true);
  assert.deepEqual(leaseOperations, ["result.publish"]);
});

test("result publication is rejected when its mutation fence is lost", async () => {
  let writes = 0;
  await assert.rejects(
    finalizeAndWriteSuccessfulResult({
      cpbRoot: await tempRoot("cpb-finalizer-publish-cpb"),
      hubRoot: await tempRoot("cpb-finalizer-publish-hub"),
      assignment: completedAssignment({ attemptToken: "token-publish" }),
      attemptDir: await tempRoot("cpb-finalizer-publish-attempt"),
      assignmentId: "a-finalize",
      attemptNum: 1,
      jobId: "job-publish",
      result: { status: "completed", jobId: "job-publish" },
      worktreeInfo: { path: "/tmp/worktree-publish", branch: "cpb/publish" },
      finalizeQueueEntry: async () => dryRunSuccess(),
      assertMutationLease: async (context) => context.operation === "result.publish" ? false : true,
      writeResult: async () => {
        writes += 1;
        return true;
      },
    }),
    (error: unknown) => Boolean(
      error && typeof error === "object" && "code" in error && error.code === "MUTATION_LEASE_LOST",
    ),
  );
  assert.equal(writes, 0);
});

test("failed live finalizer preserves committed partial truth and journal receipts", async () => {
  const result = await normalizeFinalizerResult({
    ok: false,
    status: "blocked",
    code: "PR_EVENT_RECORD_FAILED",
    mode: "pr",
    jobId: "job-partial-pr",
    committed: true,
    retryable: true,
    remoteIntent: {
      schema: "cpb.finalizer-mutation-receipt.v1",
      stage: "pull_request.create.receipt",
      receipts: {
        pullRequestCreate: {
          operation: "pull_request.create",
          attempted: true,
          committed: true,
        },
      },
    },
    remoteWrites: {
      pullRequestCreate: { attempted: true, committed: true },
    },
  }, {
    mode: "pr",
    jobId: "job-partial-pr",
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed, true);
  assert.equal(result.retryable, true);
  assert.equal(recordValue(result.remoteIntent).stage, "pull_request.create.receipt");
  assert.equal(recordValue(recordValue(result.remoteWrites).pullRequestCreate).committed, true);
});

test("canonical no-issue review bundle requires a durable owner-bound file and audit receipt", async () => {
  const hubRoot = await realpath(await tempRoot("cpb-finalizer-review-bundle"));
  const project = "proj";
  const jobId = "job-review-bundle";
  const bundleDir = path.join(hubRoot, "review-bundles", project);
  const bundlePath = path.join(bundleDir, `${project}-${jobId}-review-bundle.json`);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(bundlePath, "{}\n", "utf8");
  const bundleSha256 = createHash("sha256").update("{}\n", "utf8").digest("hex");

  const missingReceipt = await normalizeFinalizerResult({
    ok: true,
    status: "review_bundle",
    mode: "review_bundle",
    jobId,
    bundlePath,
    committed: true,
    eventRecorded: true,
    audit: { eventType: "review_bundle_created", jobId, project, bundlePath },
  }, { mode: "dry-run", jobId, hubRoot, project });
  assert.equal(missingReceipt.ok, false);
  assert.equal(missingReceipt.code, "FINALIZER_RESULT_INVALID");

  const result = await normalizeFinalizerResult({
    ok: true,
    status: "review_bundle",
    mode: "review_bundle",
    jobId,
    bundlePath,
    bundleBytes: 3,
    bundleSha256,
    committed: true,
    eventRecorded: true,
    audit: {
      eventType: "review_bundle_created",
      jobId,
      project,
      bundlePath,
    },
  }, {
    mode: "dry-run",
    jobId,
    hubRoot,
    project,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "review_bundle");
});

test("review bundle event failure preserves committed local bundle truth", async () => {
  const hubRoot = await realpath(await tempRoot("cpb-finalizer-review-bundle-failed"));
  const project = "proj";
  const jobId = "job-review-bundle-failed";
  const bundleDir = path.join(hubRoot, "review-bundles", project);
  const bundlePath = path.join(bundleDir, `${project}-${jobId}-review-bundle.json`);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(bundlePath, "{}\n", "utf8");
  const bundleSha256 = createHash("sha256").update("{}\n", "utf8").digest("hex");

  const result = await normalizeFinalizerResult({
    ok: false,
    status: "blocked",
    code: "REVIEW_BUNDLE_EVENT_RECORD_FAILED",
    mode: "review_bundle",
    jobId,
    bundlePath,
    bundleBytes: 3,
    bundleSha256,
    committed: true,
    eventRecorded: false,
    retryable: true,
  }, {
    mode: "dry-run",
    jobId,
    hubRoot,
    project,
  });

  assert.equal(result.ok, false);
  assert.equal(result.committed, true);
  assert.equal(result.retryable, true);
  assert.equal(result.bundlePath, bundlePath);
});

test("finalizeAndWriteSuccessfulResult converts a missing finalizer result into a failed attempt", async () => {
  const attemptDir = await tempRoot("cpb-finalizer-missing");
  let written: LooseRecord | null = null;

  const finalizeResult = await finalizeAndWriteSuccessfulResult({
    cpbRoot: await tempRoot("cpb-finalizer-missing-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-missing-hub"),
    assignment: completedAssignment({
      assignmentId: "a-missing",
      entryId: "missing",
      attemptToken: "token-missing",
      orchestratorEpoch: 9,
    }),
    attemptDir,
    assignmentId: "a-missing",
    attemptNum: 1,
    jobId: "job-missing",
    result: { status: "completed", jobId: "job-missing" },
    worktreeInfo: { path: "/tmp/worktree-missing", branch: "cpb/missing" },
    finalizeQueueEntry: async () => null as never,
    writeResult: async (_file, value) => {
      written = recordValue(value);
      return true;
    },
  });

  const jobResult = recordValue(written?.jobResult);
  const failure = recordValue(jobResult.failure);
  assert.equal(finalizeResult?.ok, false);
  assert.equal(finalizeResult?.code, "FINALIZER_RESULT_MISSING");
  assert.equal(written?.status, "failed");
  assert.equal(jobResult.status, "failed");
  assert.equal(failure.kind, "finalizer_failed");
  assert.equal(recordValue(written?.recovery).retainWorktree, true);
});

test("worker worktree cleanup is allowed only for a completed attempt without retention override", () => {
  assert.equal(shouldCleanupWorkerWorktree({ status: "completed" }, {}), true);
  assert.equal(shouldCleanupWorkerWorktree({ status: "cancelled" }, {}), true);
  assert.equal(shouldCleanupWorkerWorktree({ status: "failed" }, {}), false);
  assert.equal(shouldCleanupWorkerWorktree({ status: "blocked" }, {}), false);
  assert.equal(shouldCleanupWorkerWorktree(null, {}), false);
  assert.equal(shouldCleanupWorkerWorktree(
    { status: "completed" },
    { CPB_PRODUCT_VALIDATION_KEEP_WORKTREE: "1" },
  ), false);
});
