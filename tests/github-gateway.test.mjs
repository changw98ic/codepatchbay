import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { redactSecrets } from "../server/services/secret-policy.js";
import { githubRoutes } from "../server/routes/github.js";
import { normalizeGithubWebhookEvent } from "../server/services/github-events.js";
import { matchGithubTrigger } from "../server/services/github-triggers.js";
import { createGithubIssueQueueJob, listCandidates } from "../server/services/event-source.js";
import { getJob } from "../server/services/job-store.js";
import {
  buildGithubAppReadiness,
  githubAppConfigPath,
  loadGithubAppConfig,
  redactGithubAppConfig,
  saveGithubAppConfig,
  validateGithubAppConfig,
} from "../server/services/github-app.js";

function githubSignature(secret, rawBody) {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

async function buildGithubWebhookApp(hubRoot) {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", (req, _reply, done) => {
    req.cpbHubRoot = hubRoot;
    done();
  });
  await app.register(githubRoutes, { prefix: "/api" });
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
    assert.match(installation.recommendedAction, /cpb github install-app/);
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
  it("creates a queue entry and linked job from a matched GitHub issue event", async () => {
    const cpbRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-github-queue-"));
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

      const result = await createGithubIssueQueueJob(cpbRoot, event, match);

      assert.equal(result.status, "created");
      assert.equal(result.entry.source, "github-issue");
      assert.equal(result.entry.projectId, "frontend");
      assert.equal(result.entry.payload.issueNumber, 123);
      assert.equal(result.entry.payload.repo, "my-org/frontend");
      assert.equal(result.entry.payload.title, "Fix login redirect");
      assert.equal(result.entry.payload.body, "Redirect loops after login.");
      assert.equal(result.entry.payload.url, "https://github.com/my-org/frontend/issues/123");
      assert.equal(result.entry.payload.actor, "octocat");
      assert.equal(result.entry.payload.workflow, "standard");

      const job = await getJob(cpbRoot, "frontend", result.job.jobId);
      assert.equal(job.queueEntryId, result.entry.id);
      assert.equal(job.workflow, "standard");
      assert.equal(job.task, "Fix login redirect");
      assert.equal(job.sourceContext.queueEntryId, result.entry.id);
      assert.equal(job.sourceContext.issueNumber, 123);
      assert.equal(job.sourceContext.repo, "my-org/frontend");
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
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
      assert.equal(candidates.length, 1);
    } finally {
      await rm(cpbRoot, { recursive: true, force: true });
    }
  });
});
