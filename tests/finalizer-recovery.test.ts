import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { recoverFinalizerOnly } from "../server/services/auto-finalizer.js";
import {
  finalizerCapabilityDigest,
  finalizerMutationFenceDigest,
  validateFinalizerMutationReceipt,
} from "../server/services/finalizer-contract.js";
import {
  appendFinalizerJournal,
  finalizerJournalFinalizationId,
  readFinalizerJournal,
  type FinalizerJournalRecord,
  type FinalizerJournalSnapshot,
  type FinalizerJournalStage,
} from "../server/services/finalizer-journal.js";

const ORIGINAL_CLAIM_ID = createHash("sha256").update("claim-original").digest("hex");
const ORIGIN_JOB_ID = "job-recovery-origin";
const execFileAsync = promisify(execFile);

const capability = {
  schema: "cpb.github-remote-capability.v1" as const,
  repository: "example/disposable",
  repositoryId: "R_disposable",
  defaultBranch: "main",
  markerPath: ".cpb-disposable-target.json" as const,
  markerSha: "a".repeat(40),
  issueNumber: 17,
  automationLabel: "cpb-e2e",
  allowedBranchPrefix: "cpb-release-rehearsal/",
  permissions: {
    repositoryPush: true,
    pullRequestCreate: true,
    pullRequestMerge: true,
    issueClose: true,
  },
};

const principal = {
  kind: "github_app" as const,
  stableId: "501",
  login: "cpb-test[bot]",
  authorId: "91",
};

function mutationFence(previousClaimId: string) {
  return {
    assignmentId: "assignment-recovery",
    entryId: "entry-recovery",
    attemptToken: "attempt-recovery-token",
    orchestratorEpoch: 7,
    workerId: "worker-recovery",
    workerIncarnation: "incarnation-recovery",
    processIdentity: { pid: 1234, startTimeTicks: "777" },
    takeover: {
      kind: "explicit-handoff",
      previousClaimId,
      evidenceId: createHash("sha256").update("handoff-evidence").digest("hex"),
      observedAt: "2026-07-22T00:00:00.000Z",
    },
  };
}

function receipt(operation: string, extra: Record<string, unknown> = {}) {
  return {
    operation,
    attempted: true,
    committed: true,
    observedAt: "2026-07-22T00:00:00.000Z",
    eventId: createHash("sha256").update(operation).digest("hex"),
    ...extra,
  };
}

async function fixture() {
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-finalizer-recovery-"));
  const dataRoot = path.join(cpbRoot, "data");
  const repositoryPath = path.join(cpbRoot, "candidate-repository");
  await mkdir(repositoryPath, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "cpb-test@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "CPB Test"], { cwd: repositoryPath });
  await writeFile(path.join(repositoryPath, "candidate.txt"), "base\n", "utf8");
  await execFileAsync("git", ["add", "candidate.txt"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repositoryPath });
  const sourceHead = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
  await writeFile(path.join(repositoryPath, "candidate.txt"), "base\ncandidate\n", "utf8");
  await execFileAsync("git", ["add", "candidate.txt"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "-m", "candidate"], { cwd: repositoryPath });
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryPath })).stdout.trim();
  const tree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repositoryPath })).stdout.trim();
  const finalizationId = finalizerJournalFinalizationId({
    project: "flow",
    entryId: "entry-recovery",
    originJobId: ORIGIN_JOB_ID,
    mode: "remote",
    repository: capability.repository,
    issueNumber: capability.issueNumber,
    capabilityDigest: finalizerCapabilityDigest(capability),
    principal,
    source: { branch: "main", head: sourceHead },
    commit,
    tree,
    preRemoteHead: sourceHead,
    targetBranch: "main",
  });
  const capsulePath = path.join(dataRoot, "finalizer-journals", `${finalizationId}.bundle`);
  await mkdir(path.dirname(capsulePath), { recursive: true });
  await execFileAsync("git", ["bundle", "create", capsulePath, "HEAD"], { cwd: repositoryPath });
  await chmod(capsulePath, 0o600);
  const capsuleBytes = await readFile(capsulePath);
  const initial: FinalizerJournalRecord = {
    schema: "cpb.finalizer-mutation-receipt.v1",
    finalizationId,
    generation: 1,
    project: "flow",
    entryId: "entry-recovery",
    originJobId: ORIGIN_JOB_ID,
    mode: "remote",
    stage: "claimed",
    repository: capability.repository,
    issueNumber: capability.issueNumber,
    capabilityDigest: finalizerCapabilityDigest(capability),
    principal,
    claim: {
      claimId: ORIGINAL_CLAIM_ID,
      claimGeneration: 1,
      ownerDigest: "2".repeat(64),
    },
    source: { branch: "main", head: sourceHead },
    capsule: {
      path: capsulePath,
      sha256: createHash("sha256").update(capsuleBytes).digest("hex"),
      bytes: capsuleBytes.length,
    },
    commit,
    tree,
    preRemoteHead: sourceHead,
    targetBranch: "main",
    receipts: {},
  };
  let snapshot = await readFinalizerJournal(cpbRoot, "flow", "entry-recovery", { dataRoot });
  const assertMutationLease = async () => true;
  snapshot = await appendFinalizerJournal(cpbRoot, "flow", "entry-recovery", initial, {
    dataRoot,
    expected: snapshot,
    assertMutationLease,
  });
  return { cpbRoot, dataRoot, initial, snapshot, assertMutationLease };
}

async function advance(
  state: Awaited<ReturnType<typeof fixture>>,
  stage: FinalizerJournalStage,
  receiptUpdates: Record<string, unknown> = {},
) {
  const current = state.snapshot.record as FinalizerJournalRecord;
  const next: FinalizerJournalRecord = {
    ...current,
    generation: current.generation + 1,
    stage,
    receipts: { ...current.receipts, ...receiptUpdates },
  };
  state.snapshot = await appendFinalizerJournal(
    state.cpbRoot,
    "flow",
    "entry-recovery",
    next,
    {
      dataRoot: state.dataRoot,
      expected: state.snapshot as FinalizerJournalSnapshot,
      assertMutationLease: state.assertMutationLease,
    },
  );
}

test("finalizer recovery takes a fenced claim but never blindly resends an ambiguous push", async () => {
  const state = await fixture();
  let issueCloseCalls = 0;
  let prCreateCalls = 0;
  try {
    await advance(state, "repository.push.intent");
    const fence = mutationFence(ORIGINAL_CLAIM_ID);
    const leaseOperations: string[] = [];
    const result = await recoverFinalizerOnly({
      cpbRoot: state.cpbRoot,
      dataRoot: state.dataRoot,
      project: "flow",
      entryId: "entry-recovery",
      jobId: "job-recovery-a2",
      originJobId: ORIGIN_JOB_ID,
      remoteCapability: capability,
      transportPrincipal: principal,
      remoteCommitVerifier: async (request) => ({
        operation: request.operation,
        committed: null,
        reason: "remote truth remains unknown",
        principal,
      }),
      issueCloser: async () => { issueCloseCalls += 1; },
      createPullRequest: async () => { prCreateCalls += 1; return {}; },
      assertMutationLease: async (context) => {
        leaseOperations.push(String(context.operation));
        return true;
      },
      mutationFence: fence,
      allowMutation: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "REMOTE_PUSH_RECONCILIATION_UNRESOLVED", JSON.stringify(result));
    assert.equal(issueCloseCalls, 0);
    assert.equal(prCreateCalls, 0);
    assert.deepEqual(leaseOperations, ["journal.claim"]);
    const observed = await readFinalizerJournal(state.cpbRoot, "flow", "entry-recovery", { dataRoot: state.dataRoot });
    assert.equal(observed.record?.stage, "repository.push.intent");
    assert.equal(observed.record?.generation, 3);
    assert.equal(observed.record?.claim.ownerDigest, finalizerMutationFenceDigest(fence));
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});

test("completed finalizer recovery publishes a canonical receipt owned by the fresh fence", async () => {
  const state = await fixture();
  try {
    await advance(state, "repository.push.intent");
    await advance(state, "repository.push.receipt", {
      push: receipt("repository.push", {
        repository: capability.repository,
        issueNumber: capability.issueNumber,
        commit: state.initial.commit,
        tree: state.initial.tree,
        targetBranch: state.initial.targetBranch,
        preRemoteHead: state.initial.preRemoteHead,
        verification: {
          operation: "repository.push",
          committed: true,
          principal,
          evidence: {
            targetBranch: state.initial.targetBranch,
            expectedRef: `refs/heads/${state.initial.targetBranch}`,
            actualRef: `refs/heads/${state.initial.targetBranch}`,
            expectedCommit: state.initial.commit,
            actualCommit: state.initial.commit,
          },
        },
      }),
    });
    await advance(state, "issue.close.intent");
    await advance(state, "issue.close.receipt", {
      issueClose: receipt("issue.close", {
        repository: capability.repository,
        issueNumber: capability.issueNumber,
        commit: state.initial.commit,
        verification: {
          operation: "issue.close",
          committed: true,
          principal,
          evidence: {
            number: capability.issueNumber,
            state: "CLOSED",
            url: `https://github.com/${capability.repository}/issues/${capability.issueNumber}`,
          },
        },
      }),
    });
    await advance(state, "remote.complete");
    await advance(state, "local.complete", {
      sourceSync: receipt("source.sync", {
        clean: true,
        expectedBranch: "main",
        previousHead: state.initial.source.head,
        expectedHead: state.initial.commit,
        actualBranch: "main",
        actualHead: state.initial.commit,
      }),
    });
    const fence = mutationFence(ORIGINAL_CLAIM_ID);
    const result = await recoverFinalizerOnly({
      cpbRoot: state.cpbRoot,
      dataRoot: state.dataRoot,
      project: "flow",
      entryId: "entry-recovery",
      jobId: "job-recovery-a2",
      originJobId: ORIGIN_JOB_ID,
      remoteCapability: capability,
      transportPrincipal: principal,
      assertMutationLease: async () => true,
      mutationFence: fence,
      allowMutation: true,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "finalized");
    assert.equal(result.jobId, "job-recovery-a2");
    assert.equal(result.committed, true);
    assert.ok(result.remoteIntent && typeof result.remoteIntent === "object");
    const recoveredIntent = result.remoteIntent as FinalizerJournalRecord;
    assert.equal(recoveredIntent.claim.ownerDigest, finalizerMutationFenceDigest(fence));
    assert.equal(recoveredIntent.originJobId, ORIGIN_JOB_ID);
    const validated = validateFinalizerMutationReceipt(result, {
      mode: "remote",
      binding: {
        project: "flow",
        entryId: "entry-recovery",
        jobId: "job-recovery-a2",
        originJobId: ORIGIN_JOB_ID,
        capability,
        principal,
        source: state.initial.source,
        targetBranch: state.initial.targetBranch,
        preRemoteHead: state.initial.preRemoteHead,
        mutationFence: fence,
        candidate: {
          baseSha: state.initial.source.head,
          headSha: state.initial.commit,
          treeHash: state.initial.tree,
          identityHash: `sha256:${"e".repeat(64)}`,
          cleanReplay: {
            cleanApply: true,
            baseSha: state.initial.source.head,
            expectedTreeHash: state.initial.tree,
            actualTreeHash: state.initial.tree,
          },
        },
      },
    });
    if ("reason" in validated) assert.fail(validated.reason);
    const mismatchedBase = validateFinalizerMutationReceipt(result, {
      mode: "remote",
      binding: {
        project: "flow",
        entryId: "entry-recovery",
        jobId: "job-recovery-a2",
        originJobId: ORIGIN_JOB_ID,
        capability,
        principal,
        source: state.initial.source,
        targetBranch: state.initial.targetBranch,
        preRemoteHead: state.initial.preRemoteHead,
        mutationFence: fence,
        candidate: {
          baseSha: "f".repeat(40),
          headSha: state.initial.commit,
          treeHash: state.initial.tree,
          identityHash: `sha256:${"e".repeat(64)}`,
          cleanReplay: {
            cleanApply: true,
            baseSha: "f".repeat(40),
            expectedTreeHash: state.initial.tree,
            actualTreeHash: state.initial.tree,
          },
        },
      },
    });
    assert.equal(mismatchedBase.ok, false);
  } finally {
    await rm(state.cpbRoot, { recursive: true, force: true });
  }
});
