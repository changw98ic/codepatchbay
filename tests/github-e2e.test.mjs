import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { githubRoutes } from "../server/routes/github.js";
import { normalizeGithubWebhookEvent } from "../server/services/github-events.js";
import { matchGithubTrigger } from "../server/services/github-triggers.js";
import { listQueue, claimEligible, updateEntry } from "../server/services/hub-queue.js";
import { createJob, completeJob, getJob } from "../server/services/job-store.js";
import { readEvents } from "../server/services/event-store.js";
import { saveGithubAppConfig } from "../server/services/github-app.js";
import { postGithubStatusComment, buildGithubStatusComment } from "../server/services/github-comments.js";
import { openDraftPullRequest } from "../server/services/github-pr.js";
import { finalizeSuccessfulQueueEntry } from "../server/services/auto-finalizer.js";

function githubSignature(secret, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

async function buildApp(hubRoot, routeOptions = {}) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", (req, _reply, done) => {
    req.cpbRoot = hubRoot;
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(githubRoutes, { prefix: "/api", ...routeOptions });
  return app;
}

function makeIssuePayload({ repo = "my-org/frontend", issueNumber = 42, title = "Fix login redirect", label = "cpb" } = {}) {
  return {
    action: "labeled",
    repository: { full_name: repo },
    label: { name: label },
    issue: {
      number: issueNumber,
      title,
      body: "Steps to reproduce...",
      html_url: `https://github.com/${repo}/issues/${issueNumber}`,
      labels: [{ name: "bug" }, { name: label }],
    },
    sender: { login: "octocat" },
  };
}

describe("GitHub E2E: webhook → queue → pipeline mock → status comment → PR dry-run", () => {
  it("covers the full lifecycle from webhook receipt to terminal status comment and PR dry-run", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-"));
    const hubRoot = path.join(cpbRoot, "hub");
    const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-e2e-src-"));
    const previousSecret = process.env.CPB_E2E_WEBHOOK_SECRET;
    const postedComments = [];

    const app = await buildApp(hubRoot, {
      githubPostComment: async (request) => {
        postedComments.push(request);
        return { id: 100, html_url: `https://github.com/${request.repo}/issues/${request.issueNumber}#issuecomment-100` };
      },
    });

    try {
      process.env.CPB_E2E_WEBHOOK_SECRET = "e2e-webhook-secret";

      // Step 1: Register project + bind GitHub repo + save app config
      const { registerProject, bindProjectGithub } = await import("../server/services/hub-registry.js");
      await registerProject(hubRoot, { id: "frontend", sourcePath });
      await bindProjectGithub(hubRoot, "frontend", "my-org/frontend");
      await saveGithubAppConfig(hubRoot, {
        appId: 99999,
        installationId: 11111,
        webhookSecretRef: "env:CPB_E2E_WEBHOOK_SECRET",
      });

      // Step 2: Send fake GitHub webhook → POST /api/github/webhook
      const payload = makeIssuePayload();
      const rawBody = JSON.stringify(payload);
      const response = await app.inject({
        method: "POST",
        url: "/api/github/webhook",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "delivery-e2e-1",
          "x-hub-signature-256": githubSignature("e2e-webhook-secret", rawBody),
        },
        payload: rawBody,
      });

      assert.equal(response.statusCode, 202);
      const body = JSON.parse(response.body);
      assert.equal(body.accepted, true);
      assert.equal(body.projectId, "frontend");
      assert.equal(body.match.matched, true);
      assert.equal(body.queue.status, "created");
      const queueEntryId = body.queue.queueEntryId;
      assert.match(queueEntryId, /^q-/);

      // Verify queued comment was posted
      assert.equal(body.comment.status, "posted");
      assert.equal(postedComments.length, 1);
      assert.match(postedComments[0].body, /queued this issue/);

      // Step 3: Verify Hub Queue entry was created
      const queued = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(queued.length, 1);
      assert.equal(queued[0].id, queueEntryId);
      assert.equal(queued[0].status, "pending");
      assert.equal(queued[0].metadata.issueNumber, 42);
      assert.equal(queued[0].metadata.repo, "my-org/frontend");

      // Step 4: Worker claims the queue entry
      const claimResult = await claimEligible(hubRoot, { projectId: "frontend", workerId: "worker-e2e" });
      assert.ok(claimResult.entry, "claimEligible should return an entry");
      assert.equal(claimResult.entry.id, queueEntryId);
      assert.equal(claimResult.entry.status, "in_progress");
      const entry = claimResult.entry;

      // Step 5: Simulate pipeline creating a job (as run-pipeline.mjs would do)
      const job = await createJob(cpbRoot, {
        project: "frontend",
        task: entry.description,
        workflow: entry.metadata.workflow || "standard",
        sourceContext: {
          type: "github_issue",
          repo: entry.metadata.repo,
          issueNumber: entry.metadata.issueNumber,
          issueTitle: entry.description,
          issueUrl: entry.metadata.issueUrl,
          queueEntryId: entry.id,
        },
      });
      assert.ok(job.jobId);

      // Step 6: Simulate CPB_JOB_CREATED write-back (as project-worker does)
      await updateEntry(hubRoot, entry.id, { metadata: { jobId: job.jobId } });
      const afterWriteback = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(afterWriteback[0].metadata.jobId, job.jobId);

      // Step 7: Complete the job (simulating pipeline success)
      const completed = await completeJob(cpbRoot, "frontend", job.jobId);
      assert.equal(completed.status, "completed");

      // Step 8: Post terminal status comment (mocked transport)
      const statusComments = [];
      const statusResult = await postGithubStatusComment({
        cpbRoot,
        project: "frontend",
        job: completed,
        postComment: async (request) => {
          statusComments.push(request);
          return { id: 200, html_url: `https://github.com/${request.repo}/issues/${request.issueNumber}#issuecomment-200` };
        },
      });

      assert.equal(statusResult.status, "posted");
      assert.equal(statusComments.length, 1);
      assert.match(statusComments[0].body, /Verified patch ready/);
      assert.match(statusComments[0].body, /Job: .*job-/);

      // Verify audit event was written
      const events = await readEvents(cpbRoot, "frontend", job.jobId);
      const commentEvents = events.filter((e) => e.type === "github_comment_posted");
      assert.equal(commentEvents.length, 1);
      assert.equal(commentEvents[0].commentKind, "terminal-status");

      // Step 9: Open draft PR in dry-run mode
      const prResult = await openDraftPullRequest({
        job: {
          ...completed,
          worktreeBranch: "cpb/issue-42-fix-login-redirect",
          worktreeBaseBranch: "main",
        },
        verdict: "PASS",
        branchPushed: true,
        dryRun: true,
      });

      assert.equal(prResult.status, "dry-run");
      assert.equal(prResult.request.repo, "my-org/frontend");
      assert.equal(prResult.request.head, "cpb/issue-42-fix-login-redirect");
      assert.equal(prResult.request.base, "main");
      assert.equal(prResult.request.draft, true);
      assert.match(prResult.request.title, /Fix login redirect/);

      // Step 10: Finalize the queue entry (mark completed)
      await updateEntry(hubRoot, entry.id, {
        status: "completed",
        metadata: {
          jobId: job.jobId,
          finalStatus: "passed",
        },
      });

      const finalEntries = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(finalEntries[0].status, "completed");
      assert.equal(finalEntries[0].metadata.jobId, job.jobId);
    } finally {
      if (previousSecret === undefined) delete process.env.CPB_E2E_WEBHOOK_SECRET;
      else process.env.CPB_E2E_WEBHOOK_SECRET = previousSecret;
      await app.close();
      await rm(cpbRoot, { recursive: true, force: true });
      await rm(sourcePath, { recursive: true, force: true });
    }
  });
});
