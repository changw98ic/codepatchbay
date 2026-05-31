import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mergeAgentConfig, normalizeAgentSpec } from "../server/services/agent-config.js";
import { buildAgentMetadata } from "../cli/commands/run.js";

describe("agent-config: normalizeAgentSpec", () => {
  it("splits browser-agent:chatgpt into agent + variant", () => {
    const spec = normalizeAgentSpec("browser-agent:chatgpt");
    assert.deepEqual(spec, { agent: "browser-agent", variant: "chatgpt" });
  });

  it("splits colon in object.agent", () => {
    const spec = normalizeAgentSpec({ agent: "browser-agent:chatgpt" });
    assert.deepEqual(spec, { agent: "browser-agent", variant: "chatgpt" });
  });

  it("returns null for empty string", () => {
    const spec = normalizeAgentSpec("");
    assert.equal(spec, null);
  });

  it("falls back to claude for object with empty agent", () => {
    const spec = normalizeAgentSpec({ agent: "" });
    assert.deepEqual(spec, { agent: "claude", variant: null });
  });

  it("preserves variant when object.agent has no colon", () => {
    const spec = normalizeAgentSpec({ agent: "codex", variant: "mimo" });
    assert.deepEqual(spec, { agent: "codex", variant: "mimo" });
  });
});

describe("agent-config: mergeAgentConfig", () => {
  it("processes per-role metadata.agents object", () => {
    const merged = mergeAgentConfig(null, null, {
      planner: "browser-agent:chatgpt",
      verifier: "claude",
    });
    assert.deepEqual(merged.planner, { agent: "browser-agent", variant: "chatgpt" });
    assert.deepEqual(merged.verifier, { agent: "claude", variant: null });
    assert.equal(merged.executor, undefined);
    assert.equal(merged.reviewer, undefined);
  });

  it("processes per-role metadata.agents with variant-only entries", () => {
    const merged = mergeAgentConfig(null, null, {
      planner: { agent: "", variant: "mimo" },
    });
    assert.deepEqual(merged.planner, { agent: "claude", variant: "mimo" });
  });

  it("does not fall back to claude for empty string in metadata.agents (all roles empty)", () => {
    // When metadata.agents is not provided at all, mergeAgentConfig returns {}
    const merged = mergeAgentConfig(null, null, null);
    assert.deepEqual(merged, {});
  });

  it("single spec string in metadata overrides all roles", () => {
    const merged = mergeAgentConfig(null, null, "browser-agent:deepseek");
    assert.deepEqual(merged.planner, { agent: "browser-agent", variant: "deepseek" });
    assert.deepEqual(merged.executor, { agent: "browser-agent", variant: "deepseek" });
    assert.deepEqual(merged.verifier, { agent: "browser-agent", variant: "deepseek" });
    assert.deepEqual(merged.reviewer, { agent: "browser-agent", variant: "deepseek" });
  });

  it("hub config default applies to all roles", () => {
    const merged = mergeAgentConfig({ default: "codex" }, null, null);
    assert.deepEqual(merged.planner, { agent: "codex", variant: null });
    assert.deepEqual(merged.executor, { agent: "codex", variant: null });
  });

  it("project config overrides hub default", () => {
    const merged = mergeAgentConfig(
      { default: "codex" },
      { phases: { plan: "browser-agent:chatgpt" } },
      null
    );
    assert.deepEqual(merged.planner, { agent: "browser-agent", variant: "chatgpt" });
    assert.deepEqual(merged.executor, { agent: "codex", variant: null });
  });

  it("metadata single spec overrides all", () => {
    const merged = mergeAgentConfig(
      { default: "codex" },
      { phases: { plan: "browser-agent:chatgpt" } },
      "claude"
    );
    assert.deepEqual(merged.planner, { agent: "claude", variant: null });
    assert.deepEqual(merged.executor, { agent: "claude", variant: null });
  });
});

describe("agent-config: buildAgentMetadata", () => {
  it("returns undefined when no agent or variant options provided", () => {
    const meta = buildAgentMetadata({
      agent: "",
      planAgent: "",
      executeAgent: "",
      verifyAgent: "",
      reviewAgent: "",
      planVariant: "",
      executeVariant: "",
      verifyVariant: "",
      reviewVariant: "",
    });
    assert.equal(meta, undefined);
  });

  it("returns agents object when global agent is set", () => {
    const meta = buildAgentMetadata({
      agent: "browser-agent:chatgpt",
      planAgent: "",
      executeAgent: "",
      verifyAgent: "",
      reviewAgent: "",
      planVariant: "",
      executeVariant: "",
      verifyVariant: "",
      reviewVariant: "",
    });
    assert.deepEqual(meta, {
      planner: { agent: "browser-agent:chatgpt", variant: undefined },
      executor: { agent: "browser-agent:chatgpt", variant: undefined },
      verifier: { agent: "browser-agent:chatgpt", variant: undefined },
      reviewer: { agent: "browser-agent:chatgpt", variant: undefined },
    });
  });

  it("resolves --plan-agent browser-agent:chatgpt to correct spec", () => {
    const meta = buildAgentMetadata({
      agent: "",
      planAgent: "browser-agent:chatgpt",
      executeAgent: "",
      verifyAgent: "",
      reviewAgent: "",
      planVariant: "",
      executeVariant: "",
      verifyVariant: "",
      reviewVariant: "",
    });
    assert.deepEqual(meta, {
      planner: { agent: "browser-agent:chatgpt", variant: undefined },
    });
  });

  it("mixes per-role agents and variants", () => {
    const meta = buildAgentMetadata({
      agent: "",
      planAgent: "codex",
      executeAgent: "",
      verifyAgent: "browser-agent",
      reviewAgent: "",
      planVariant: "mimo",
      executeVariant: "",
      verifyVariant: "chatgpt",
      reviewVariant: "",
    });
    assert.deepEqual(meta, {
      planner: { agent: "codex", variant: "mimo" },
      verifier: { agent: "browser-agent", variant: "chatgpt" },
    });
  });
});
