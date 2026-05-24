import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { redactSecrets } from "../server/services/secret-policy.js";
import {
  buildGithubAppReadiness,
  githubAppConfigPath,
  loadGithubAppConfig,
  redactGithubAppConfig,
  saveGithubAppConfig,
  validateGithubAppConfig,
} from "../server/services/github-app.js";

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
