import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { redactSecrets } from "../server/services/secret-policy.js";
import { githubRoutes } from "../server/routes/github.js";
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
