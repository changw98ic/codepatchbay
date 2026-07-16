import assert from "node:assert/strict";
import { test } from "node:test";

import { openDraftPullRequest } from "../server/services/github/github-issues.js";

function prReadyJob() {
  return {
    status: "completed",
    jobId: "job-pr",
    task: "Fix issue",
    worktree: "/tmp/worktree",
    worktreeBranch: "cpb/job-pr",
    worktreeBaseBranch: "main",
    sourceContext: {
      repo: "owner/repo",
      issueNumber: 42,
      issueTitle: "Fix issue",
    },
  };
}

test("openDraftPullRequest defaults to dry-run and does not create or push", async () => {
  let createPullRequestCalls = 0;
  let commandCalls = 0;

  const result = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return { url: "https://github.com/owner/repo/pull/1", number: 1 };
    },
    runCommand: async () => {
      commandCalls += 1;
      throw new Error("implicit dry-run must not run git or gh");
    },
  });

  assert.equal(result.status, "dry-run");
  assert.equal(result.posted, false);
  assert.equal(result.request.repo, "owner/repo");
  assert.equal(result.request.head, "cpb/job-pr");
  assert.equal(createPullRequestCalls, 0);
  assert.equal(commandCalls, 0);
});

test("openDraftPullRequest requires explicit live opt-in before creating a PR", async () => {
  let createPullRequestCalls = 0;

  const blocked = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    dryRun: false,
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return { url: "https://github.com/owner/repo/pull/1", number: 1 };
    },
  });

  assert.equal(blocked.status, "blocked.pr");
  assert.match(blocked.evidence.reason, /requires explicit live finalization opt-in/);
  assert.equal(createPullRequestCalls, 0);

  const opened = await openDraftPullRequest({
    job: prReadyJob(),
    verdict: "PASS",
    branchPushed: true,
    dryRun: false,
    allowLive: true,
    createPullRequest: async () => {
      createPullRequestCalls += 1;
      return { url: "https://github.com/owner/repo/pull/7", number: 7 };
    },
  });

  assert.equal(opened.status, "pr.opened");
  assert.equal(opened.prNumber, 7);
  assert.equal(createPullRequestCalls, 1);
});
