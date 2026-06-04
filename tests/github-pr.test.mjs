import assert from "node:assert/strict";
import { test } from "node:test";

import { createPullRequestWithGh, openDraftPullRequest } from "../server/services/github-pr.js";

function makeJob(overrides = {}) {
  return {
    jobId: "job-pr-test",
    project: "proj",
    task: "Add dark mode",
    status: "completed",
    worktreeBranch: "cpb/issue-42-dark-mode",
    worktreeBaseBranch: "main",
    sourceContext: { repo: "owner/repo", issueNumber: 42, issueTitle: "Add dark mode" },
    ...overrides,
  };
}

test("openDraftPullRequest only accepts PASS verdicts", async () => {
  assert.equal((await openDraftPullRequest({ job: makeJob(), verdict: "FAIL" })).status, "skipped");
  assert.equal((await openDraftPullRequest({ job: makeJob(), verdict: "PARTIAL" })).status, "skipped");
  assert.equal((await openDraftPullRequest({ job: makeJob(), verdict: "pass", branchPushed: true, dryRun: true })).status, "dry-run");
});

test("openDraftPullRequest dry-run returns draft request shape", async () => {
  const result = await openDraftPullRequest({
    job: makeJob(),
    verdict: "PASS",
    branchPushed: true,
    dryRun: true,
  });
  assert.equal(result.status, "dry-run");
  assert.equal(result.request.repo, "owner/repo");
  assert.equal(result.request.head, "cpb/issue-42-dark-mode");
  assert.equal(result.request.base, "main");
  assert.equal(result.request.draft, true);
  assert.match(result.request.title, /\[cpb\] Add dark mode/);
});

test("createPullRequestWithGh passes --draft for draft requests", async () => {
  const calls = [];
  const result = await createPullRequestWithGh({
    repo: "owner/repo",
    title: "[cpb] title",
    body: "body",
    head: "cpb/head",
    base: "main",
    draft: true,
  }, {
    runCommand: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "https://github.com/owner/repo/pull/7\n", stderr: "" };
    },
  });
  assert.equal(result.number, 7);
  assert.equal(calls[0].cmd, "gh");
  assert.ok(calls[0].args.includes("--draft"));
});

test("openDraftPullRequest returns blocked.pr when request lacks repo or head", async () => {
  const result = await openDraftPullRequest({
    job: makeJob({ sourceContext: { issueNumber: 42 }, worktreeBranch: null }),
    verdict: "PASS",
    branchPushed: true,
  });
  assert.equal(result.status, "blocked.pr");
  assert.match(result.evidence.reason, /missing repo, head, or base/);
});
