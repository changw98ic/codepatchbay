import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGithubStatusComment,
  buildQueuedComment,
  buildSddApprovedComment,
  postGithubCommentWithGh,
  postGithubQueuedComment,
} from "../server/services/github-comments.js";

test("queued GitHub comment includes job id workflow agents and queue id", () => {
  const body = buildQueuedComment({
    job: { jobId: "job-abc", workflow: "standard" },
    queueEntry: { id: "q-xyz" },
    agents: { planner: "codex", executor: "claude", verifier: "codex" },
  });
  assert.match(body, /job-abc/);
  assert.match(body, /q-xyz/);
  assert.match(body, /standard/);
  assert.match(body, /claude/);
});

test("GitHub queued comment dry-run does not call transport", async () => {
  let called = false;
  const result = await postGithubQueuedComment({
    repo: "owner/repo",
    issueNumber: 42,
    job: { jobId: "job-dry", workflow: "standard" },
    dryRun: true,
    postComment: async () => { called = true; },
  });
  assert.equal(result.status, "dry-run");
  assert.equal(result.posted, false);
  assert.equal(called, false);
  assert.match(result.body, /job-dry/);
});

test("GitHub queued comment returns failed status without throwing on transport error", async () => {
  const result = await postGithubQueuedComment({
    repo: "owner/repo",
    issueNumber: 42,
    job: { jobId: "job-fail" },
    postComment: async () => { throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }); },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.posted, false);
  assert.equal(result.error.code, "ECONNREFUSED");
});

test("GitHub SDD approval comments include approval actor and child count", () => {
  const queued = buildQueuedComment({
    queueEntry: {
      id: "q-sdd",
      status: "waiting.approval",
      metadata: {
        workflow: "sdd-standard",
        sddApproval: { requiresApproval: true, status: "waiting_approval" },
        sddBootstrap: { files: { spec: { path: "/tmp/sdd/spec.md" }, design: { path: "/tmp/sdd/design.md" }, tasks: { path: "/tmp/sdd/tasks.md" } } },
        sddTasks: ["one", "two"],
      },
    },
  });
  assert.match(queued, /SDD Draft Requires Approval/);
  assert.match(queued, /sdd\/spec\.md/);
  assert.match(queued, /2/);

  const approved = buildSddApprovedComment({ actor: "alice", childCount: 3 });
  assert.match(approved, /@alice/);
  assert.match(approved, /3 child task/);
});

test("GitHub gh comment transport receives exact issue comment args", async () => {
  const calls = [];
  await postGithubCommentWithGh({
    repo: "owner/repo",
    issueNumber: 1,
    body: "hello",
  }, {
    runCommand: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "", stderr: "" };
    },
  });
  assert.equal(calls[0].cmd, "gh");
  assert.deepEqual(calls[0].args, ["issue", "comment", "1", "--repo", "owner/repo", "--body", "hello"]);
});

test("GitHub terminal status comment formats major states", () => {
  assert.match(buildGithubStatusComment({ projection: { status: "passed", jobId: "job-pass", issueNumber: 7, workflow: "standard", retryCount: 0 } }), /Verified patch ready/);
  assert.match(buildGithubStatusComment({ projection: { status: "failed", jobId: "job-fail", issueNumber: 3, failurePhase: "execute", reason: "agent exited 1" } }), /agent exited 1/);
  assert.match(buildGithubStatusComment({ projection: { status: "blocked", jobId: "job-block", issueNumber: 4, reason: "manual review" } }), /manual review/);
  assert.match(buildGithubStatusComment({ projection: { status: "pr-opened", jobId: "job-pr", issueNumber: 5, pr: { number: 22, url: "https://github.com/o/r/pull/22" } } }), /Draft PR opened/);
});
