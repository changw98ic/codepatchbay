import assert from "node:assert/strict";
import { test } from "node:test";

import { maybeFinalizeSuccessfulAssignment } from "../runtime/worker/assignment-finalizer.js";
import { tempRoot } from "./helpers.js";

function completedAssignment(overrides: Record<string, any> = {}) {
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
  let captured: Record<string, any> | null = null;
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
    finalizeQueueEntry: async (args: Record<string, any>) => {
      captured = args;
      return { ok: true, status: "dry-run", mode: args.mode, jobId: args.job?.jobId };
    },
  });

  assert.equal(result?.status, "dry-run");
  assert.equal(captured?.mode, "dry-run");
  assert.equal(captured?.job?.jobId, "job-finalize");
  assert.equal(captured?.job?.sourceContext?.repo, "owner/repo");
  assert.equal(captured?.createPullRequest, null);
  assert.equal(captured?.pushToken, null);
  assert.equal(tokenCalls, 0);
});

test("maybeFinalizeSuccessfulAssignment requires explicit live opt-in for PR mode", async () => {
  let captured: Record<string, any> | null = null;

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
    finalizeQueueEntry: async (args: Record<string, any>) => {
      captured = args;
      return { ok: false, status: "blocked", code: "LIVE_FINALIZE_NOT_ALLOWED", mode: args.mode };
    },
  });

  assert.equal(captured?.mode, "dry-run");
  assert.equal(captured?.createPullRequest, null);
  assert.equal(captured?.pushToken, null);
});

test("maybeFinalizeSuccessfulAssignment resolves project dataRoot before finalizer evidence lookup", async () => {
  let captured: Record<string, any> | null = null;

  await maybeFinalizeSuccessfulAssignment({
    cpbRoot: await tempRoot("cpb-finalizer-data-cpb"),
    hubRoot: await tempRoot("cpb-finalizer-data-hub"),
    assignment: completedAssignment(),
    attemptNum: 1,
    jobId: "job-data-root",
    result: { status: "completed", jobId: "job-data-root", phaseResults: [] },
    worktreeInfo: { path: "/tmp/worktree", branch: "cpb/job-data-root" },
    resolveDataRoot: async () => "/tmp/project-runtime-root",
    finalizeQueueEntry: async (args: Record<string, any>) => {
      captured = args;
      return { ok: true, status: "dry-run", mode: args.mode };
    },
  });

  assert.equal(captured?.dataRoot, "/tmp/project-runtime-root");
});
