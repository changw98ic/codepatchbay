import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  envForAgent,
  providerKeyForAgent,
  resetManagedAcpPoolsForTests,
} from "../server/services/acp-pool.js";

describe("plumbing-variant: browser-agent variant env and key mapping", () => {
  it("envForAgent sets CPB_ACP_AGENT_VARIANT for browser-agent:chatgpt", () => {
    const base = { CPB_ROOT: "/tmp/cpb" };
    const result = envForAgent("browser-agent", base, "chatgpt");
    assert.equal(result.CPB_ACP_AGENT_VARIANT, "chatgpt");
    assert.equal(result.CPB_ACP_BROWSER_AGENT_VARIANT, "chatgpt");
  });

  it("envForAgent sets variant-specific env key", () => {
    const base = {};
    const result = envForAgent("browser-agent", base, "deepseek");
    assert.equal(result.CPB_ACP_BROWSER_AGENT_VARIANT, "deepseek");
    assert.equal(result.CPB_ACP_AGENT_VARIANT, "deepseek");
  });

  it("providerKeyForAgent returns 'browser-agent:chatgpt' with variant", () => {
    const key = providerKeyForAgent("browser-agent", {}, "chatgpt");
    assert.equal(key, "browser-agent:chatgpt");
  });

  it("providerKeyForAgent returns bare agent when no variant", () => {
    const key = providerKeyForAgent("browser-agent", {}, null);
    assert.equal(key, "browser-agent");
  });

  it("providerKeyForAgent handles claude variant config", () => {
    const env = { CPB_CLAUDE_VARIANT: "kimi-k2.6", KIMI_BASE_URL: "http://localhost:9999", KIMI_API_KEY: "test-key" };
    const key = providerKeyForAgent("claude", env, null);
    assert.equal(key, "claude:kimi-k2.6");
  });

  it("providerKeyForAgent returns bare claude when variant is none", () => {
    const key = providerKeyForAgent("claude", { CPB_CLAUDE_VARIANT: "none" }, null);
    assert.equal(key, "claude");
  });

  it("envForAgent for claude sets CPB_CLAUDE_VARIANT", () => {
    const base = { KIMI_BASE_URL: "http://localhost:9999", KIMI_API_KEY: "test-key" };
    const result = envForAgent("claude", base, "kimi-k2.6");
    assert.equal(result.CPB_CLAUDE_VARIANT, "kimi-k2.6");
    assert.equal(result.CPB_ACP_AGENT_VARIANT, "kimi-k2.6");
  });

  it("envForAgent merges without mutating original env", () => {
    const base = { FOO: "bar" };
    const result = envForAgent("browser-agent", base, "chatgpt");
    assert.equal(base.FOO, "bar");
    assert.equal(result.FOO, "bar");
    assert.equal(base.CPB_ACP_BROWSER_AGENT_PROVIDER, undefined);
  });
});
