import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  validateGithubAppConfig,
  redactGithubAppConfig,
  saveGithubAppConfig,
  loadGithubAppConfig,
  buildGithubAppReadiness,
  githubAppConfigPath,
  DEFAULT_GITHUB_APP_PERMISSIONS,
} from "../server/services/github-app.js";
import { redactSecrets } from "../server/services/secret-policy.js";
import { tempRoot } from "./helpers.mjs";

// --- Acceptance: Config can be loaded, validated, and redacted ---

test("validateGithubAppConfig accepts valid full config", () => {
  const result = validateGithubAppConfig({
    appId: "12345",
    installationId: "67890",
    webhookSecretRef: "env:MY_WEBHOOK_SECRET",
    privateKeyRef: "env:MY_PRIVATE_KEY",
    permissions: { issues: "write", contents: "read" },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.config.appId, "12345");
  assert.equal(result.config.installationId, "67890");
  assert.equal(result.config.webhookSecretRef, "env:MY_WEBHOOK_SECRET");
  assert.equal(result.config.privateKeyRef, "env:MY_PRIVATE_KEY");
  assert.equal(result.config.permissions.issues, "write");
  assert.equal(result.config.permissions.contents, "read");
  assert.equal(result.config.schemaVersion, 1);
});

test("validateGithubAppConfig accepts minimal config without installation id", () => {
  const result = validateGithubAppConfig({
    appId: "99",
    webhookSecretRef: "env:WEBHOOK_SECRET",
  });
  assert.equal(result.valid, true);
  assert.equal(result.config.appId, "99");
  assert.equal(result.config.installationId, null);
  assert.equal(result.config.privateKeyRef, null);
});

test("validateGithubAppConfig rejects missing appId", () => {
  const result = validateGithubAppConfig({
    webhookSecretRef: "env:WEBHOOK_SECRET",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("appId")));
  assert.equal(result.config, null);
});

test("validateGithubAppConfig rejects invalid appId format", () => {
  const result = validateGithubAppConfig({
    appId: "abc",
    webhookSecretRef: "env:WEBHOOK_SECRET",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("appId") && e.includes("positive integer")));
});

test("validateGithubAppConfig rejects missing webhookSecretRef", () => {
  const result = validateGithubAppConfig({
    appId: "1",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("webhookSecretRef")));
});

test("validateGithubAppConfig rejects unsupported webhookSecretRef prefix", () => {
  const result = validateGithubAppConfig({
    appId: "1",
    webhookSecretRef: "literal:my-secret-value",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("webhookSecretRef") && e.includes("prefix")));
});

test("validateGithubAppConfig accepts supported webhookSecretRef prefixes", () => {
  for (const prefix of ["env", "keychain", "credential-manager", "libsecret", "vault"]) {
    const result = validateGithubAppConfig({
      appId: "1",
      webhookSecretRef: `${prefix}:MY_SECRET`,
    });
    assert.equal(result.valid, true, `prefix ${prefix} should be valid`);
  }
});

test("validateGithubAppConfig rejects invalid privateKeyRef prefix", () => {
  const result = validateGithubAppConfig({
    appId: "1",
    webhookSecretRef: "env:WEBHOOK_SECRET",
    privateKeyRef: "aws:my-key",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("privateKeyRef")));
});

test("validateGithubAppConfig rejects invalid permission levels", () => {
  const result = validateGithubAppConfig({
    appId: "1",
    webhookSecretRef: "env:WEBHOOK_SECRET",
    permissions: { issues: "admin" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("permissions.issues")));
});

test("validateGithubAppConfig merges defaults for permissions", () => {
  const result = validateGithubAppConfig({
    appId: "1",
    webhookSecretRef: "env:WEBHOOK_SECRET",
  });
  assert.equal(result.valid, true);
  assert.equal(result.config.permissions.issues, DEFAULT_GITHUB_APP_PERMISSIONS.issues);
  assert.equal(result.config.permissions.contents, DEFAULT_GITHUB_APP_PERMISSIONS.contents);
});

test("save and load round-trip persists config", async () => {
  const hubRoot = await tempRoot("cpb-github-roundtrip");
  const saved = await saveGithubAppConfig(hubRoot, {
    appId: "42",
    installationId: "99",
    webhookSecretRef: "env:CPB_WEBHOOK_SECRET",
    privateKeyRef: "file:/tmp/key.pem",
  });
  assert.equal(saved.appId, "42");
  assert.equal(saved.installationId, "99");
  assert.equal(saved.webhookSecretRef, "env:CPB_WEBHOOK_SECRET");
  assert.equal(saved.privateKeyRef, "file:/tmp/key.pem");
  assert.ok(saved.updatedAt);

  const loaded = await loadGithubAppConfig(hubRoot);
  assert.equal(loaded.appId, "42");
  assert.equal(loaded.installationId, "99");
  assert.equal(loaded.webhookSecretRef, "env:CPB_WEBHOOK_SECRET");
  assert.equal(loaded.privateKeyRef, "file:/tmp/key.pem");
});

test("loadGithubAppConfig returns null when no config file exists", async () => {
  const hubRoot = await tempRoot("cpb-github-missing");
  const loaded = await loadGithubAppConfig(hubRoot);
  assert.equal(loaded, null);
});

test("loadGithubAppConfig throws on invalid persisted config", async () => {
  const nodePath = await import("node:path");
  const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import("node:fs/promises");
  const hubRoot = await tempRoot("cpb-github-bad-persist");
  const configPath = githubAppConfigPath(hubRoot);
  await mkdirAsync(nodePath.dirname(configPath), { recursive: true });
  await writeFileAsync(configPath, JSON.stringify({ bad: true }), "utf8");
  await assert.rejects(() => loadGithubAppConfig(hubRoot), /invalid GitHub App config/);
});

test("saveGithubAppConfig throws on invalid input", async () => {
  const hubRoot = await tempRoot("cpb-github-save-invalid");
  await assert.rejects(
    () => saveGithubAppConfig(hubRoot, { appId: "not-a-number" }),
    /invalid GitHub App config/,
  );
});

// --- Acceptance: Webhook secret value is never serialized in JSON output ---

test("redactGithubAppConfig strips webhookSecret value", () => {
  const config = {
    appId: "1",
    installationId: "2",
    webhookSecretRef: "env:SECRET",
    webhookSecret: "this-should-never-appear",
    privateKeyRef: "env:KEY",
    privateKey: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
    privateKeyPem: "secret-pem-data",
    permissions: DEFAULT_GITHUB_APP_PERMISSIONS,
    schemaVersion: 1,
    updatedAt: null,
  };
  const redacted = redactGithubAppConfig(config);
  assert.equal(redacted.webhookSecret, undefined);
  assert.equal(redacted.privateKey, undefined);
  assert.equal(redacted.privateKeyPem, undefined);
  assert.equal(redacted.appId, "1");
  assert.equal(redacted.webhookSecretRef, "env:SECRET");
});

test("redactGithubAppConfig returns null for null input", () => {
  assert.equal(redactGithubAppConfig(null), null);
});

test("saved config file on disk never contains webhookSecret value", async () => {
  const hubRoot = await tempRoot("cpb-github-no-secret");
  await saveGithubAppConfig(hubRoot, {
    appId: "7",
    webhookSecretRef: "env:MY_SECRET",
  });
  const diskContent = await readFile(githubAppConfigPath(hubRoot), "utf8");
  const parsed = JSON.parse(diskContent);
  assert.equal(parsed.webhookSecret, undefined);
  assert.equal(parsed.webhookSecretRef, "env:MY_SECRET");
  assert.ok(!diskContent.includes("MY_SECRET_VALUE"));
});

test("redactSecrets redacts keys matching webhook and secret patterns", () => {
  const input = {
    appId: "1",
    webhookSecret: "secret-value",
    token: "ghp_ABCDEFGHIJKLMNOP",
    safeField: "normal-value",
    webhookSecretRef: "env:REF",
    privateKeyRef: "env:KEY_REF",
  };
  const output = redactSecrets(input);
  assert.equal(output.webhookSecret, "[REDACTED]");
  assert.equal(output.token, "[REDACTED]");
  assert.equal(output.safeField, "normal-value");
  assert.equal(output.webhookSecretRef, "env:REF");
  assert.equal(output.privateKeyRef, "env:KEY_REF");
});

test("JSON.stringify of redacted config never leaks secret values", () => {
  const config = {
    appId: "1",
    webhookSecret: "super-secret-webhook-value",
    webhookSecretRef: "env:WEBHOOK_SECRET",
  };
  const redacted = redactGithubAppConfig(config);
  const json = JSON.stringify(redacted);
  assert.ok(!json.includes("super-secret-webhook-value"));
  assert.ok(json.includes("env:WEBHOOK_SECRET"));
  assert.equal(redacted.appId, "1");
});

// --- Acceptance: Missing installation id produces actionable readiness warning ---

test("buildGithubAppReadiness warns when config is null", () => {
  const checks = buildGithubAppReadiness(null);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "warn");
  assert.equal(checks[0].id, "github-app-config");
  assert.ok(checks[0].recommendedAction);
  assert.match(checks[0].recommendedAction, /cpb github connect/);
});

test("buildGithubAppReadiness warns when installationId is missing", () => {
  const checks = buildGithubAppReadiness({
    appId: "1",
    installationId: null,
    webhookSecretRef: "env:SECRET",
    privateKeyRef: null,
  });
  const installCheck = checks.find((c) => c.id === "github-app-installation");
  assert.equal(installCheck.status, "warn");
  assert.equal(installCheck.severity, "important");
  assert.ok(installCheck.recommendedAction);
  assert.match(installCheck.recommendedAction, /installation-id/);
});

test("buildGithubAppReadiness shows ok when installationId is present", () => {
  const checks = buildGithubAppReadiness({
    appId: "1",
    installationId: "42",
    webhookSecretRef: "env:SECRET",
    privateKeyRef: null,
  });
  const installCheck = checks.find((c) => c.id === "github-app-installation");
  assert.equal(installCheck.status, "ok");
  assert.equal(installCheck.recommendedAction, null);
});

test("buildGithubAppReadiness warns about missing private key", () => {
  const checks = buildGithubAppReadiness({
    appId: "1",
    installationId: "42",
    webhookSecretRef: "env:SECRET",
    privateKeyRef: null,
  });
  const keyCheck = checks.find((c) => c.id === "github-app-private-key");
  assert.equal(keyCheck.status, "warn");
  assert.ok(keyCheck.recommendedAction);
  assert.match(keyCheck.recommendedAction, /private-key-ref/);
});

test("buildGithubAppReadiness shows ok with full config", () => {
  const checks = buildGithubAppReadiness({
    appId: "1",
    installationId: "42",
    webhookSecretRef: "env:SECRET",
    privateKeyRef: "env:PRIVATE_KEY",
  });
  assert.equal(checks.every((c) => c.status === "ok"), true);
});

// --- githubAppConfigPath ---

test("githubAppConfigPath returns path under github/ directory", () => {
  const p = githubAppConfigPath("/tmp/hub");
  assert.ok(p.endsWith("github/app.json"));
});
