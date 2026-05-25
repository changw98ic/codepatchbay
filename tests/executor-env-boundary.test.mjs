import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { executorEnv } from "../server/services/executor-root.js";

describe("executorEnv secret boundary", () => {
  it("adds executor locators without forwarding arbitrary parent secrets", () => {
    const env = executorEnv({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "provider-secret",
      DATABASE_URL: "postgres://user:pass@example/db",
      RANDOM_TOKEN: "leak",
      CPB_GITHUB_WEBHOOK_SECRET: "webhook-secret",
      CPB_PROJECT_RUNTIME_ROOT: "/tmp/runtime",
    }, {
      cpbRoot: "/tmp/cpb",
      executorRoot: "/tmp/executor",
    });

    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.OPENAI_API_KEY, "provider-secret");
    assert.equal(env.CPB_PROJECT_RUNTIME_ROOT, "/tmp/runtime");
    assert.equal(env.CPB_ROOT, path.resolve("/tmp/cpb"));
    assert.equal(env.CPB_EXECUTOR_ROOT, path.resolve("/tmp/executor"));
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.RANDOM_TOKEN, undefined);
    assert.equal(env.CPB_GITHUB_WEBHOOK_SECRET, undefined);
  });
});
