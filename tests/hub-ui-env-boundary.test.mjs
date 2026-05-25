import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildUiDevServerEnv, buildUiServerEnv } from "../cli/commands/ui.js";
import { buildHubInstallEnv, buildHubServerEnv } from "../server/services/hub-cli.js";

describe("Hub/UI server environment boundary", () => {
  it("scrubs arbitrary parent secrets before starting the Hub server", () => {
    const env = buildHubServerEnv({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "provider-secret",
      DATABASE_URL: "postgres://user:pass@example/db",
      RANDOM_TOKEN: "leak",
      CPB_GITHUB_WEBHOOK_SECRET: "webhook-secret",
    }, {
      cpbRoot: "/tmp/cpb",
      executorRoot: "/tmp/executor",
      hubRoot: "/tmp/hub",
      port: "4567",
      host: "127.0.0.1",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.OPENAI_API_KEY, "provider-secret");
    assert.equal(env.CPB_ROOT, "/tmp/cpb");
    assert.equal(env.CPB_EXECUTOR_ROOT, "/tmp/executor");
    assert.equal(env.CPB_HUB_ROOT, "/tmp/hub");
    assert.equal(env.CPB_PORT, "4567");
    assert.equal(env.CPB_HOST, "127.0.0.1");
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.RANDOM_TOKEN, undefined);
    assert.equal(env.CPB_GITHUB_WEBHOOK_SECRET, undefined);
  });

  it("uses runtime-only env for Hub dependency installation", () => {
    const env = buildHubInstallEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      OPENAI_API_KEY: "provider-secret",
      DATABASE_URL: "postgres://user:pass@example/db",
      RANDOM_TOKEN: "leak",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/tmp/home");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.RANDOM_TOKEN, undefined);
  });

  it("scrubs arbitrary parent secrets before starting the UI backend server", () => {
    const env = buildUiServerEnv({
      PATH: "/usr/bin",
      ANTHROPIC_AUTH_TOKEN: "provider-secret",
      DATABASE_URL: "postgres://user:pass@example/db",
      RANDOM_TOKEN: "leak",
      CPB_GITHUB_WEBHOOK_SECRET: "webhook-secret",
    }, {
      cpbRoot: "/tmp/cpb",
      executorRoot: "/tmp/executor",
      port: "6789",
      host: "127.0.0.1",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "provider-secret");
    assert.equal(env.CPB_ROOT, "/tmp/cpb");
    assert.equal(env.CPB_EXECUTOR_ROOT, "/tmp/executor");
    assert.equal(env.CPB_PORT, "6789");
    assert.equal(env.CPB_HOST, "127.0.0.1");
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.RANDOM_TOKEN, undefined);
    assert.equal(env.CPB_GITHUB_WEBHOOK_SECRET, undefined);
  });

  it("uses runtime-only env for the Vite dev server", () => {
    const env = buildUiDevServerEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      OPENAI_API_KEY: "provider-secret",
      ANTHROPIC_AUTH_TOKEN: "provider-secret",
      DATABASE_URL: "postgres://user:pass@example/db",
      RANDOM_TOKEN: "leak",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/tmp/home");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.RANDOM_TOKEN, undefined);
  });
});
