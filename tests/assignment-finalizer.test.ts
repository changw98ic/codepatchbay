import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalizeAndWriteSuccessfulResult,
  maybeFinalizeSuccessfulAssignment,
} from "../runtime/worker/assignment-finalizer.js";
import { shouldCleanupWorkerWorktree } from "../runtime/worker/managed-worker.js";
import { recordValue, type LooseRecord } from "../shared/types.js";
import { tempRoot } from "./helpers.js";

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
      return { ok: true, status: "dry-run", mode: args.mode, jobId: recordValue(args.job).jobId };
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
      return { ok: true, status: "dry-run", mode: args.mode };
    },
  });

  assert.equal(captured?.dataRoot, "/tmp/project-runtime-root");
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
