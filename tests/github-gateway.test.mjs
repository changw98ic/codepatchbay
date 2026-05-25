import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { redactSecrets } from "../server/services/secret-policy.js";
import { githubRoutes } from "../server/routes/github.js";
import { normalizeGithubWebhookEvent } from "../server/services/github-events.js";
import { matchGithubTrigger } from "../server/services/github-triggers.js";
import { createGithubIssueQueueJob, listCandidates } from "../server/services/event-source.js";
import { listQueue } from "../server/services/hub-queue.js";
import { completeJob, createJob, getJob, recordWorktreeCreated } from "../server/services/job-store.js";
import { readEvents } from "../server/services/event-store.js";
import { finalizeSuccessfulQueueEntry } from "../server/services/auto-finalizer.js";
import {
  buildGithubStatusComment,
  buildQueuedComment,
  postGithubQueuedComment,
  postGithubStatusComment,
} from "../server/services/github-comments.js";
import { openDraftPullRequest } from "../server/services/github-pr.js";
import { buildCodePatchBayPrBody } from "../server/services/pr-body.js";
import { jobToGithubStatusUpdate } from "../server/services/job-projection.js";
import {
  buildGithubAppReadiness,
  githubAppConfigPath,
  loadGithubAppConfig,
  redactGithubAppConfig,
  saveGithubAppConfig,
  validateGithubAppConfig,
} from "../server/services/github-app.js";

const execFileAsync = promisify(execFile);

function githubSignature(secret, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

async function buildGithubWebhookApp(hubRoot, routeOptions = {}) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", (req, _reply, done) => {
    req.cpbRoot = hubRoot;
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(githubRoutes, { prefix: "/api", ...routeOptions });
  return app;
}

describe("GitHub App config model", () => {
  it("loads, validates, and redacts app config without serializing webhook secret values", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-app-config-"));
    try {
      await saveGithubAppConfig(hubRoot, {
        appId: 12345,
        installationId: 67890,
        webhookSecretRef: "env:CPB_GITHUB_WEBHOOK_SECRET",
        webhookSecret: "super-secret-webhook-value",
        permissions: {
          metadata: "read",
          issues: "write",
          contents: "write",
          pullRequests: "write",
        },
      });

      const stored = await readFile(githubAppConfigPath(hubRoot), "utf8");
      assert.doesNotMatch(stored, /super-secret-webhook-value/);
      assert.match(stored, /CPB_GITHUB_WEBHOOK_SECRET/);

      const loaded = await loadGithubAppConfig(hubRoot);
      assert.equal(loaded.appId, "12345");
      assert.equal(loaded.installationId, "67890");
      assert.equal(loaded.webhookSecretRef, "env:CPB_GITHUB_WEBHOOK_SECRET");
      assert.equal(loaded.webhookSecret, undefined);
      assert.equal(loaded.permissions.issues, "write");

      const redacted = redactGithubAppConfig({
        ...loaded,
        webhookSecret: "super-secret-webhook-value",
      });
      const json = JSON.stringify(redacted);
      assert.doesNotMatch(json, /super-secret-webhook-value/);
      assert.match(json, /CPB_GITHUB_WEBHOOK_SECRET/);
      assert.equal(redacted.webhookSecret, undefined);

      assert.equal(redactSecrets({ webhookSecretRef: "env:CPB_GITHUB_WEBHOOK_SECRET" }).webhookSecretRef, "env:CPB_GITHUB_WEBHOOK_SECRET");
    } finally {
      await rm(hubRoot, { recursive: true, force: true });
    }
  });

  it("returns actionable validation errors for invalid config", () => {
    const validation = validateGithubAppConfig({
      installationId: 67890,
      webhookSecretRef: "env:CPB_GITHUB_WEBHOOK_SECRET",
      permissions: { metadata: "admin" },
    });

    assert.equal(validation.valid, false);
    assert.match(validation.errors.join("\n"), /appId is required/);
    assert.match(validation.errors.join("\n"), /permissions\.metadata/);
  });

  it("warns when installation id is missing", () => {
    const validation = validateGithubAppConfig({
      appId: 12345,
      webhookSecretRef: "env:CPB_GITHUB_WEBHOOK_SECRET",
      permissions: { metadata: "read", issues: "write" },
    });

    assert.equal(validation.valid, true);
    const checks = buildGithubAppReadiness(validation.config);
    const installation = checks.find((check) => check.id === "github-app-installation");
    assert.equal(installation.status, "warn");
    assert.match(installation.message, /installation id/i);
    assert.match(installation.recommendedAction, /cpb github connect --installation-id/);
  });
});

describe("GitHub webhook signature verification", () => {
  it("accepts a valid X-Hub-Signature-256 computed from the raw request body", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-webhook-valid-"));
    const app = await buildGithubWebhookApp(hubRoot);
    const previousSecret = process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET;
    try {
      process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET = "webhook-test-secret";
      await saveGithubAppConfig(hubRoot, {
        appId: 12345,
        installationId: 67890,
        webhookSecretRef: "env:CPB_TEST_GITHUB_WEBHOOK_SECRET",
      });
      const rawBody = '{ "action": "opened", "issue": { "number": 42 } }\n';
      const response = await app.inject({
        method: "POST",
        url: "/api/github/webhook",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "delivery-1",
          "x-hub-signature-256": githubSignature("webhook-test-secret", rawBody),
        },
        payload: rawBody,
      });

      assert.equal(response.statusCode, 202);
      assert.deepEqual(JSON.parse(response.body), {
        accepted: true,
        event: "issues",
        delivery: "delivery-1",
        action: "opened",
      });
    } finally {
      if (previousSecret === undefined) delete process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET;
      else process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET = previousSecret;
      await app.close();
      await rm(hubRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid and missing webhook signatures", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-webhook-invalid-"));
    const app = await buildGithubWebhookApp(hubRoot);
    const previousSecret = process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET;
    try {
      process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET = "webhook-test-secret";
      await saveGithubAppConfig(hubRoot, {
        appId: 12345,
        installationId: 67890,
        webhookSecretRef: "env:CPB_TEST_GITHUB_WEBHOOK_SECRET",
      });
      const rawBody = '{"action":"opened"}';
      const invalid = await app.inject({
        method: "POST",
        url: "/api/github/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": githubSignature("wrong-secret", rawBody),
        },
        payload: rawBody,
      });
      const missing = await app.inject({
        method: "POST",
        url: "/api/github/webhook",
        headers: { "content-type": "application/json" },
        payload: rawBody,
      });

      assert.equal(invalid.statusCode, 401);
      assert.equal(missing.statusCode, 401);
    } finally {
      if (previousSecret === undefined) delete process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET;
      else process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET = previousSecret;
      await app.close();
      await rm(hubRoot, { recursive: true, force: true });
    }
  });
});

describe("GitHub webhook queue glue", () => {
  it("normalizes a signed issue event, matches a bound project trigger, enqueues Hub Queue work, and comments queued", async () => {
    const hubRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-webhook-glue-"));
    const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-github-source-"));
    const previousSecret = process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET;
    const posted = [];
    const app = await buildGithubWebhookApp(hubRoot, {
      githubPostComment: async (request) => {
        posted.push(request);
        return { id: 123, html_url: `https://github.com/${request.repo}/issues/${request.issueNumber}#issuecomment-123` };
      },
    });
    try {
      process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET = "webhook-test-secret";
      const { registerProject, bindProjectGithub } = await import("../server/services/hub-registry.js");
      await registerProject(hubRoot, { id: "frontend", sourcePath });
      await bindProjectGithub(hubRoot, "frontend", "my-org/frontend");
      await saveGithubAppConfig(hubRoot, {
        appId: 12345,
        installationId: 67890,
        webhookSecretRef: "env:CPB_TEST_GITHUB_WEBHOOK_SECRET",
      });

      const rawBody = JSON.stringify({
        action: "labeled",
        repository: { full_name: "my-org/frontend" },
        label: { name: "cpb" },
        issue: {
          number: 42,
          title: "Fix login redirect",
          body: "Redirect loops after login.",
          html_url: "https://github.com/my-org/frontend/issues/42",
          labels: [{ name: "bug" }, { name: "cpb" }],
        },
        sender: { login: "octocat" },
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/github/webhook",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "delivery-glue-1",
          "x-hub-signature-256": githubSignature("webhook-test-secret", rawBody),
        },
        payload: rawBody,
      });

      assert.equal(response.statusCode, 202);
      const body = JSON.parse(response.body);
      assert.equal(body.accepted, true);
      assert.equal(body.normalized.status, "ok");
      assert.equal(body.projectId, "frontend");
      assert.equal(body.match.matched, true);
      assert.equal(body.queue.status, "created");
      assert.equal(body.queue.jobId, null);
      assert.match(body.queue.queueEntryId, /^q-/);
      assert.equal(body.hubQueue.id, body.queue.queueEntryId);
      assert.equal(body.comment.status, "posted");

      const candidates = await listCandidates(hubRoot, { source: "github-issue" });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].status, "queued");
      assert.equal(candidates[0].payload.issueNumber, 42);
      assert.equal(candidates[0].payload.repo, "my-org/frontend");

      const queued = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(queued.length, 1);
      assert.equal(queued[0].id, body.queue.queueEntryId);
      assert.equal(queued[0].description, "Fix login redirect");
      assert.equal(queued[0].metadata.repo, "my-org/frontend");
      assert.equal(queued[0].metadata.issueNumber, 42);
      assert.equal(posted.length, 1);
      assert.equal(posted[0].repo, "my-org/frontend");
      assert.equal(posted[0].issueNumber, 42);
      assert.match(posted[0].body, /Job: pending/);
      assert.match(posted[0].body, new RegExp(`Queue: ${body.queue.queueEntryId}`));
    } finally {
      if (previousSecret === undefined) delete process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET;
      else process.env.CPB_TEST_GITHUB_WEBHOOK_SECRET = previousSecret;
      await app.close();
      await rm(hubRoot, { recursive: true, force: true });
      await rm(sourcePath, { recursive: true, force: true });
    }
  });
});

describe("GitHub event normalization", () => {
  it("normalizes issues and issue_comment events into trigger-ready envelopes", () => {
    const issueEvent = normalizeGithubWebhookEvent({
      event: "issues",
      delivery: "delivery-issue-1",
      projectId: "frontend",
      payload: {
        action: "labeled",
        repository: { full_name: "my-org/frontend" },
        label: { name: "cpb" },
        issue: {
          number: 123,
          title: "Fix login redirect",
          body: "Redirect loops after login.",
          html_url: "https://github.com/my-org/frontend/issues/123",
          labels: [{ name: "bug" }, { name: "cpb" }],
        },
        sender: { login: "octocat" },
      },
    });

    assert.equal(issueEvent.status, "ok");
    assert.equal(issueEvent.type, "github_issue");
    assert.equal(issueEvent.repo, "my-org/frontend");
    assert.equal(issueEvent.projectId, "frontend");
    assert.equal(issueEvent.issueNumber, 123);
    assert.equal(issueEvent.actor, "octocat");
    assert.equal(issueEvent.action, "labeled");
    assert.equal(issueEvent.commandText, null);
    assert.deepEqual(issueEvent.labels, ["bug", "cpb"]);
    assert.equal(issueEvent.url, "https://github.com/my-org/frontend/issues/123");

    const commentEvent = normalizeGithubWebhookEvent({
      event: "issue_comment",
      delivery: "delivery-comment-1",
      projectId: "frontend",
      payload: {
        action: "created",
        repository: { full_name: "my-org/frontend" },
        issue: {
          number: 123,
          title: "Fix login redirect",
          html_url: "https://github.com/my-org/frontend/issues/123",
          labels: [{ name: "bug" }],
        },
        comment: {
          body: "/cpb run",
          html_url: "https://github.com/my-org/frontend/issues/123#issuecomment-1",
        },
        sender: { login: "maintainer" },
      },
    });

    assert.equal(commentEvent.status, "ok");
    assert.equal(commentEvent.type, "github_issue_comment");
    assert.equal(commentEvent.commandText, "/cpb run");
    assert.equal(commentEvent.actor, "maintainer");
    assert.equal(commentEvent.url, "https://github.com/my-org/frontend/issues/123#issuecomment-1");
    assert.deepEqual(commentEvent.labels, ["bug"]);
  });

  it("normalizes installation events and ignores unsupported events with a reason", () => {
    const installation = normalizeGithubWebhookEvent({
      event: "installation",
      delivery: "delivery-installation-1",
      payload: {
        action: "created",
        installation: { id: 98765 },
        repositories: [{ full_name: "my-org/frontend" }],
        sender: { login: "admin" },
      },
    });

    assert.equal(installation.status, "ok");
    assert.equal(installation.type, "github_installation");
    assert.equal(installation.installationId, 98765);
    assert.equal(installation.actor, "admin");
    assert.deepEqual(installation.repositories, ["my-org/frontend"]);
    assert.equal(installation.issueNumber, null);
    assert.deepEqual(installation.labels, []);

    const ignored = normalizeGithubWebhookEvent({
      event: "push",
      delivery: "delivery-push-1",
      payload: { action: "created" },
    });

    assert.equal(ignored.status, "ignored");
    assert.match(ignored.reason, /unsupported event/i);
  });
});

describe("GitHub trigger rule matcher", () => {
  it("matches cpb labels and cpb run comments to the standard workflow", () => {
    const rules = [
      { event: "issues.labeled", label: "cpb", workflow: "standard" },
      { event: "issue_comment.created", command: "/cpb run", workflow: "standard" },
    ];
    const labeled = normalizeGithubWebhookEvent({
      event: "issues",
      projectId: "frontend",
      payload: {
        action: "labeled",
        repository: { full_name: "my-org/frontend" },
        label: { name: "cpb" },
        issue: {
          number: 123,
          title: "Fix login redirect",
          html_url: "https://github.com/my-org/frontend/issues/123",
          labels: [{ name: "bug" }, { name: "cpb" }],
        },
        sender: { login: "octocat" },
      },
    });
    const commented = normalizeGithubWebhookEvent({
      event: "issue_comment",
      projectId: "frontend",
      payload: {
        action: "created",
        repository: { full_name: "my-org/frontend" },
        issue: {
          number: 123,
          title: "Fix login redirect",
          html_url: "https://github.com/my-org/frontend/issues/123",
          labels: [{ name: "bug" }],
        },
        comment: { body: "/cpb run", html_url: "https://github.com/my-org/frontend/issues/123#issuecomment-1" },
        sender: { login: "maintainer" },
      },
    });

    assert.deepEqual(matchGithubTrigger(labeled, rules), {
      matched: true,
      workflow: "standard",
      rule: rules[0],
      reason: "matched label cpb",
    });
    assert.deepEqual(matchGithubTrigger(commented, rules), {
      matched: true,
      workflow: "standard",
      rule: rules[1],
      reason: "matched command /cpb run",
    });
  });

  it("does not match unrelated labels or comments", () => {
    const rules = [
      { event: "issues.labeled", label: "cpb", workflow: "standard" },
      { event: "issue_comment.created", command: "/cpb run", workflow: "standard" },
    ];
    const unrelatedLabel = normalizeGithubWebhookEvent({
      event: "issues",
      payload: {
        action: "labeled",
        repository: { full_name: "my-org/frontend" },
        label: { name: "triage" },
        issue: {
          number: 123,
          title: "Fix login redirect",
          labels: [{ name: "triage" }],
        },
      },
    });
    const unrelatedComment = normalizeGithubWebhookEvent({
      event: "issue_comment",
      payload: {
        action: "created",
        repository: { full_name: "my-org/frontend" },
        issue: { number: 123, title: "Fix login redirect" },
        comment: { body: "Looks good to me" },
      },
    });

    assert.equal(matchGithubTrigger(unrelatedLabel, rules).matched, false);
    assert.match(matchGithubTrigger(unrelatedLabel, rules).reason, /no trigger rule/i);
    assert.equal(matchGithubTrigger(unrelatedComment, rules).matched, false);
    assert.match(matchGithubTrigger(unrelatedComment, rules).reason, /no trigger rule/i);
  });
});

describe("GitHub issue queue entry creation", () => {
  it("creates a candidate and Hub Queue entry from a matched GitHub issue event without pre-creating a job", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-queue-"));
    const hubRoot = path.join(cpbRoot, "hub");
    const sourcePath = await mkdtemp(path.join(os.tmpdir(), "cpb-github-source-"));
    try {
      const event = normalizeGithubWebhookEvent({
        event: "issues",
        delivery: "delivery-queue-1",
        projectId: "frontend",
        payload: {
          action: "labeled",
          repository: { full_name: "my-org/frontend" },
          label: { name: "cpb" },
          issue: {
            number: 123,
            title: "Fix login redirect",
            body: "Redirect loops after login.",
            html_url: "https://github.com/my-org/frontend/issues/123",
            labels: [{ name: "bug" }, { name: "cpb" }],
          },
          sender: { login: "octocat" },
        },
      });
      const match = matchGithubTrigger(event);

      const result = await createGithubIssueQueueJob(cpbRoot, event, match, { hubRoot, sourcePath });

      assert.equal(result.status, "created");
      assert.equal(result.job, null);
      assert.equal(result.entry.source, "github-issue");
      assert.equal(result.entry.status, "queued");
      assert.equal(result.entry.projectId, "frontend");
      assert.equal(result.entry.payload.issueNumber, 123);
      assert.equal(result.entry.payload.repo, "my-org/frontend");
      assert.equal(result.entry.payload.title, "Fix login redirect");
      assert.equal(result.entry.payload.body, "Redirect loops after login.");
      assert.equal(result.entry.payload.url, "https://github.com/my-org/frontend/issues/123");
      assert.equal(result.entry.payload.actor, "octocat");
      assert.equal(result.entry.payload.workflow, "standard");

      assert.match(result.queueEntry.id, /^q-/);
      assert.equal(result.queueEntry.status, "pending");
      assert.equal(result.queueEntry.projectId, "frontend");
      assert.equal(result.queueEntry.sourcePath, sourcePath);
      assert.equal(result.queueEntry.description, "Fix login redirect");
      assert.equal(result.queueEntry.type, "github_issue");
      assert.equal(result.queueEntry.metadata.candidateEntryId, result.entry.id);
      assert.equal(result.queueEntry.metadata.issueNumber, 123);
      assert.equal(result.queueEntry.metadata.repo, "my-org/frontend");
      assert.equal(result.queueEntry.metadata.workflow, "standard");
      assert.equal(result.queueEntry.metadata.autoFinalize, true);

      const hubQueue = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(hubQueue.length, 1);
      assert.equal(hubQueue[0].id, result.queueEntry.id);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
      await rm(sourcePath, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated GitHub webhook deliveries without creating another queue entry", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-queue-dup-"));
    try {
      const event = normalizeGithubWebhookEvent({
        event: "issue_comment",
        delivery: "delivery-queue-dup-1",
        projectId: "frontend",
        payload: {
          action: "created",
          repository: { full_name: "my-org/frontend" },
          issue: { number: 123, title: "Fix login redirect", labels: [] },
          comment: { body: "/cpb run", html_url: "https://github.com/my-org/frontend/issues/123#issuecomment-1" },
          sender: { login: "maintainer" },
        },
      });
      const match = matchGithubTrigger(event);

      const first = await createGithubIssueQueueJob(cpbRoot, event, match);
      const second = await createGithubIssueQueueJob(cpbRoot, event, match);
      const candidates = await listCandidates(cpbRoot, { source: "github-issue" });

      assert.equal(first.status, "created");
      assert.equal(second.status, "duplicate");
      assert.equal(second.entry.id, first.entry.id);
      assert.equal(second.job, null);
      assert.equal(second.queueEntry, null);
      assert.equal(candidates.length, 1);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });

  it("keeps distinct GitHub deliveries with the same title as separate Hub Queue entries", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-queue-distinct-"));
    const hubRoot = path.join(cpbRoot, "hub");
    try {
      const makeEvent = (delivery, issueNumber) => normalizeGithubWebhookEvent({
        event: "issues",
        delivery,
        projectId: "frontend",
        payload: {
          action: "labeled",
          repository: { full_name: "my-org/frontend" },
          label: { name: "cpb" },
          issue: {
            number: issueNumber,
            title: "Fix login redirect",
            labels: [{ name: "cpb" }],
          },
          sender: { login: "octocat" },
        },
      });

      await createGithubIssueQueueJob(cpbRoot, makeEvent("delivery-distinct-1", 123), matchGithubTrigger(makeEvent("delivery-distinct-1", 123)), { hubRoot });
      await createGithubIssueQueueJob(cpbRoot, makeEvent("delivery-distinct-2", 124), matchGithubTrigger(makeEvent("delivery-distinct-2", 124)), { hubRoot });

      const queued = await listQueue(hubRoot, { projectId: "frontend" });
      assert.equal(queued.length, 2);
      assert.deepEqual(queued.map((entry) => entry.metadata.issueNumber).sort(), [123, 124]);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("GitHub queued status comment", () => {
  it("builds a queued comment with job id, workflow, and selected agents", () => {
    const body = buildQueuedComment({
      job: { jobId: "job-20260524-153011-a13f9c", workflow: "standard" },
      agents: { planner: "codex", executor: "claude", verifier: "codex" },
    });

    assert.match(body, /CodePatchBay queued this issue/);
    assert.match(body, /job-20260524-153011-a13f9c/);
    assert.match(body, /Workflow: standard/);
    assert.match(body, /Planner: codex/);
    assert.match(body, /Executor: claude/);
    assert.match(body, /Verifier: codex/);
  });

  it("supports dry-run and reports network failure without throwing", async () => {
    let called = false;
    const dryRun = await postGithubQueuedComment({
      repo: "my-org/frontend",
      issueNumber: 123,
      job: { jobId: "job-dry-run", workflow: "standard" },
      agents: { planner: "codex", executor: "claude", verifier: "codex" },
      dryRun: true,
      postComment: async () => {
        called = true;
      },
    });

    assert.equal(dryRun.status, "dry-run");
    assert.equal(dryRun.posted, false);
    assert.equal(called, false);
    assert.match(dryRun.body, /job-dry-run/);

    const failed = await postGithubQueuedComment({
      repo: "my-org/frontend",
      issueNumber: 123,
      job: { jobId: "job-network-fail", workflow: "standard" },
      agents: { planner: "codex", executor: "claude", verifier: "codex" },
      postComment: async () => {
        throw new Error("network unavailable");
      },
    });

    assert.equal(failed.status, "failed");
    assert.equal(failed.posted, false);
    assert.match(failed.error.message, /network unavailable/);
    assert.match(failed.body, /job-network-fail/);
  });
});

describe("GitHub terminal status comments", () => {
  const baseJob = {
    jobId: "job-terminal-status",
    project: "frontend",
    task: "Fix login redirect",
    workflow: "standard",
    sourceContext: {
      type: "github_issue",
      repo: "my-org/frontend",
      issueNumber: 123,
    },
  };

  it("builds concise comments for blocked, failed, passed, and PR-opened terminal states", () => {
    const cases = [
      {
        status: "blocked",
        job: { ...baseJob, status: "blocked", blockedReason: "approval required" },
        heading: /CodePatchBay blocked this run/,
        detail: /Reason: approval required/,
      },
      {
        status: "failed",
        job: { ...baseJob, status: "failed", blockedReason: "verifier rejected patch", failurePhase: "verify" },
        heading: /CodePatchBay failed this run/,
        detail: /Phase: verify/,
      },
      {
        status: "passed",
        job: { ...baseJob, status: "completed" },
        heading: /Verified patch ready/,
        detail: /Workflow: standard/,
      },
      {
        status: "pr-opened",
        job: {
          ...baseJob,
          status: "completed",
          pr: { url: "https://github.com/my-org/frontend/pull/456", number: 456 },
        },
        heading: /Draft PR opened/,
        detail: /PR: #456/,
      },
    ];

    for (const testCase of cases) {
      const projection = jobToGithubStatusUpdate(testCase.job);
      assert.equal(projection.status, testCase.status);
      const body = buildGithubStatusComment({ projection, job: testCase.job });

      assert.match(body, testCase.heading);
      assert.match(body, /Job: job-terminal-status/);
      assert.match(body, /Issue: #123/);
      assert.match(body, testCase.detail);
      assert.ok(body.length < 800, `${testCase.status} comment should stay concise`);
    }
  });

  it("posts each terminal projection once and records the comment event in the audit log", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-status-comment-"));
    try {
      const job = await createJob(cpbRoot, {
        project: "frontend",
        task: "Fix login redirect",
        workflow: "standard",
        jobId: "job-status-dedupe",
        sourceContext: {
          type: "github_issue",
          repo: "my-org/frontend",
          issueNumber: 123,
        },
      });
      await completeJob(cpbRoot, "frontend", job.jobId);
      const completed = await getJob(cpbRoot, "frontend", job.jobId);

      let postCount = 0;
      const postComment = async (request) => {
        postCount += 1;
        return {
          id: 987,
          html_url: `https://github.com/${request.repo}/issues/${request.issueNumber}#issuecomment-987`,
        };
      };

      const first = await postGithubStatusComment({
        cpbRoot,
        project: "frontend",
        job: completed,
        postComment,
      });
      const second = await postGithubStatusComment({
        cpbRoot,
        project: "frontend",
        job: completed,
        postComment,
      });

      assert.equal(first.status, "posted");
      assert.equal(second.status, "duplicate");
      assert.equal(postCount, 1);
      assert.equal(first.dedupeKey, second.dedupeKey);

      const events = await readEvents(cpbRoot, "frontend", job.jobId);
      const commentEvents = events.filter((event) => event.type === "github_comment_posted");
      assert.equal(commentEvents.length, 1);
      assert.equal(commentEvents[0].commentKind, "terminal-status");
      assert.equal(commentEvents[0].dedupeKey, first.dedupeKey);
      assert.match(commentEvents[0].bodyHash, /^[a-f0-9]{64}$/);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});

describe("GitHub draft PR creation", () => {
  const passedJob = {
    jobId: "job-pr-ready",
    status: "completed",
    task: "Fix login redirect",
    workflow: "standard",
    worktreeBranch: "cpb/issue-123-fix-login-redirect",
    worktreeBaseBranch: "main",
    sourceContext: {
      type: "github_issue",
      repo: "my-org/frontend",
      issueNumber: 123,
      url: "https://github.com/my-org/frontend/issues/123",
    },
  };

  it("requires a PASS verdict and pushed branch readiness", async () => {
    const notPass = await openDraftPullRequest({
      job: passedJob,
      verdict: "FAIL",
      branchPushed: true,
      dryRun: true,
    });
    const notPushed = await openDraftPullRequest({
      job: passedJob,
      verdict: "PASS",
      branchPushed: false,
    });

    assert.equal(notPass.status, "skipped");
    assert.match(notPass.reason, /PASS verdict/);
    assert.equal(notPushed.status, "blocked.pr");
    assert.equal(notPushed.jobStatus, "passed");
    assert.match(notPushed.evidence.reason, /branch has not been pushed/);
  });

  it("returns a draft PR request in dry-run without calling network transport", async () => {
    let called = false;
    const result = await openDraftPullRequest({
      job: passedJob,
      verdict: "PASS",
      branchPushed: true,
      dryRun: true,
      createPullRequest: async () => {
        called = true;
      },
    });

    assert.equal(result.status, "dry-run");
    assert.equal(called, false);
    assert.equal(result.request.repo, "my-org/frontend");
    assert.equal(result.request.head, "cpb/issue-123-fix-login-redirect");
    assert.equal(result.request.base, "main");
    assert.equal(result.request.draft, true);
    assert.match(result.request.title, /Fix login redirect/);
    assert.match(result.request.body, /Issue: #123/);
  });

  it("returns blocked.pr evidence when PR transport fails", async () => {
    const result = await openDraftPullRequest({
      job: passedJob,
      verdict: "PASS",
      branchPushed: true,
      createPullRequest: async () => {
        throw new Error("GitHub unavailable");
      },
    });

    assert.equal(result.status, "blocked.pr");
    assert.equal(result.jobStatus, "passed");
    assert.match(result.error.message, /GitHub unavailable/);
    assert.equal(result.evidence.head, "cpb/issue-123-fix-login-redirect");
    assert.equal(result.evidence.base, "main");
  });

  it("uses gh CLI as the default draft PR transport", async () => {
    const calls = [];
    const result = await openDraftPullRequest({
      job: passedJob,
      verdict: "PASS",
      branchPushed: true,
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        assert.equal(command, "gh");
        assert.deepEqual(args.slice(0, 3), ["pr", "create", "--draft"]);
        assert.ok(args.includes("--body-file"));
        return {
          stdout: "https://github.com/my-org/frontend/pull/456\n",
          stderr: "",
        };
      },
    });

    assert.equal(result.status, "pr.opened");
    assert.equal(result.prUrl, "https://github.com/my-org/frontend/pull/456");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[calls[0].args.indexOf("--repo") + 1], "my-org/frontend");
    assert.equal(calls[0].args[calls[0].args.indexOf("--head") + 1], "cpb/issue-123-fix-login-redirect");
    assert.equal(calls[0].args[calls[0].args.indexOf("--base") + 1], "main");
  });

  it("prepares an unpushed worktree branch before opening the draft PR", async () => {
    const calls = [];
    const result = await openDraftPullRequest({
      job: { ...passedJob, worktree: "/tmp/cpb-worktree" },
      verdict: "PASS",
      branchPushed: false,
      runCommand: async (command, args, options) => {
        calls.push({ command, args, options });
        if (command === "git" && args[0] === "status") return { stdout: "M src/login.js\n", stderr: "" };
        if (command === "git" && args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
        if (command === "gh") return { stdout: "https://github.com/my-org/frontend/pull/789\n", stderr: "" };
        return { stdout: "", stderr: "" };
      },
    });

    assert.equal(result.status, "pr.opened");
    assert.equal(result.prUrl, "https://github.com/my-org/frontend/pull/789");
    assert.equal(result.branchPreparation.committed, true);
    assert.deepEqual(calls.map((call) => [call.command, call.args[0], call.args[1]]), [
      ["git", "add", "--all"],
      ["git", "status", "--porcelain"],
      ["git", "commit", "-m"],
      ["git", "rev-parse", "HEAD"],
      ["git", "push", "origin"],
      ["gh", "pr", "create"],
    ]);
    const pushCall = calls.find((call) => call.command === "git" && call.args[0] === "push");
    assert.equal(pushCall.options.cwd, "/tmp/cpb-worktree");
    assert.equal(pushCall.args[2], "HEAD:refs/heads/cpb/issue-123-fix-login-redirect");
  });

  it("uses pr auto-finalizer mode to push the worktree branch, open a draft PR, and append pr_opened", async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-pr-finalizer-"));
    const cpbRoot = path.join(tmpRoot, "cpb");
    const sourcePath = path.join(tmpRoot, "source");
    const remotePath = path.join(tmpRoot, "remote.git");
    const worktreePath = path.join(tmpRoot, "worktree");
    const branch = "cpb/issue-123-fix-login-redirect";
    const git = (cwd, args) => execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });

    try {
      await mkdir(sourcePath, { recursive: true });
      await execFileAsync("git", ["init", "--bare", remotePath]);
      await git(sourcePath, ["init", "-b", "main"]);
      await git(sourcePath, ["config", "user.email", "cpb@example.invalid"]);
      await git(sourcePath, ["config", "user.name", "CodePatchBay Test"]);
      await writeFile(path.join(sourcePath, "README.md"), "hello\n", "utf8");
      await git(sourcePath, ["add", "README.md"]);
      await git(sourcePath, ["commit", "-m", "initial"]);
      await git(sourcePath, ["remote", "add", "origin", remotePath]);
      await git(sourcePath, ["push", "-u", "origin", "main"]);
      await git(sourcePath, ["worktree", "add", "-b", branch, worktreePath]);
      await writeFile(path.join(worktreePath, "README.md"), "hello from cpb\n", "utf8");

      const created = await createJob(cpbRoot, {
        project: "frontend",
        task: "Fix login redirect",
        workflow: "standard",
        sourceContext: {
          type: "github_issue",
          repo: "my-org/frontend",
          issueNumber: 123,
          issueTitle: "Fix login redirect",
        },
      });
      await recordWorktreeCreated(cpbRoot, "frontend", created.jobId, {
        worktree: worktreePath,
        branch,
        baseBranch: "main",
      });
      const completed = await completeJob(cpbRoot, "frontend", created.jobId);
      const calls = [];

      const result = await finalizeSuccessfulQueueEntry({
        cpbRoot,
        project: "frontend",
        entry: {
          id: "q-pr-finalizer",
          metadata: {
            issueNumber: 123,
            issueUrl: "https://github.com/my-org/frontend/issues/123",
            repo: "my-org/frontend",
          },
        },
        job: completed,
        sourcePath,
        mode: "pr",
        runCommand: async (command, args, options) => {
          calls.push({ command, args, options });
          if (command === "gh") {
            return { stdout: "https://github.com/my-org/frontend/pull/456\n", stderr: "" };
          }
          return execFileAsync(command, args, { ...options, maxBuffer: 1024 * 1024 });
        },
      });

      assert.equal(result.ok, true);
      assert.equal(result.status, "pr.opened");
      assert.equal(result.mode, "pr");
      assert.equal(result.prUrl, "https://github.com/my-org/frontend/pull/456");
      assert.equal(result.prNumber, 456);
      assert.equal(result.pushed, true);
      assert.match(result.commit, /^[a-f0-9]{40}$/);
      assert.ok(calls.some((call) => call.command === "git" && call.args[0] === "commit"));
      assert.ok(calls.some((call) => call.command === "git" && call.args[0] === "push" && call.args[2] === `HEAD:refs/heads/${branch}`));
      assert.ok(calls.some((call) => call.command === "gh" && call.args.slice(0, 3).join(" ") === "pr create --draft"));

      const events = await readEvents(cpbRoot, "frontend", created.jobId);
      const prEvents = events.filter((event) => event.type === "pr_opened");
      assert.equal(prEvents.length, 1);
      assert.equal(prEvents[0].prUrl, "https://github.com/my-org/frontend/pull/456");
      assert.equal(prEvents[0].prNumber, 456);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("CodePatchBay PR body", () => {
  it("includes run, plan, tests, verification, and audit sections with unavailable artifacts", () => {
    const body = buildCodePatchBayPrBody({
      job: {
        jobId: "job-pr-body",
        project: "frontend",
        workflow: "standard",
        retryCount: 1,
        sourceContext: { issueNumber: 123, repo: "my-org/frontend" },
      },
      agents: { planner: "codex", executor: "claude", verifier: "codex" },
      artifacts: {
        plan: { id: "plan-001", path: "/tmp/plan-001.md" },
        deliverable: { id: "deliverable-001", path: "/tmp/deliverable-001.md" },
        verdict: { id: "verdict-001", path: "/tmp/verdict-001.md" },
      },
      tests: ["npm test: pass", "npm run lint: pass"],
      verdict: { status: "pass", confidence: 0.86, reason: "Focused and regression tests passed.", blockingCount: 0 },
      audit: { eventLog: "/tmp/events.jsonl" },
    });

    assert.match(body, /## CodePatchBay Run/);
    assert.match(body, /## Plan/);
    assert.match(body, /## Tests/);
    assert.match(body, /## Verification/);
    assert.match(body, /## Audit/);
    assert.match(body, /Job: job-pr-body/);
    assert.match(body, /Planner: codex/);
    assert.match(body, /npm test: pass/);
    assert.match(body, /Status: pass/);
    assert.match(body, /Diff: unavailable/);
    assert.match(body, /Review: unavailable/);
  });

  it("is deterministic for the same job projection", async () => {
    const job = {
      jobId: "job-pr-deterministic",
      project: "frontend",
      task: "Fix login redirect",
      workflow: "standard",
      worktreeBranch: "cpb/issue-123-fix-login-redirect",
      worktreeBaseBranch: "main",
      sourceContext: { type: "github_issue", repo: "my-org/frontend", issueNumber: 123 },
    };

    const first = buildCodePatchBayPrBody({ job });
    const second = buildCodePatchBayPrBody({ job });
    assert.equal(first, second);

    const pr = await openDraftPullRequest({
      job,
      verdict: "PASS",
      branchPushed: true,
      dryRun: true,
    });
    assert.match(pr.request.body, /## CodePatchBay Run/);
    assert.match(pr.request.body, /## Verification/);
    assert.equal(pr.request.body, buildCodePatchBayPrBody({ job, verdict: { status: "pass" } }));
  });
});
