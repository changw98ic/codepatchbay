import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mergeAgentConfig, normalizeAgentSpec } from "../server/services/agent-config.js";
import { resolvePhases } from "../core/engine/workflow-runner.js";

// ── Unit: normalizeAgentSpec with browser-agent ──

describe("browser-agent pipeline: normalizeAgentSpec", () => {
  it("resolves browser-agent:chatgpt to agent + variant", () => {
    const spec = normalizeAgentSpec("browser-agent:chatgpt");
    assert.deepEqual(spec, { agent: "browser-agent", variant: "chatgpt" });
  });

  it("resolves plain browser-agent without variant", () => {
    const spec = normalizeAgentSpec("browser-agent");
    assert.deepEqual(spec, { agent: "browser-agent", variant: null });
  });

  it("resolves object { agent: 'browser-agent' } correctly", () => {
    const spec = normalizeAgentSpec({ agent: "browser-agent" });
    assert.deepEqual(spec, { agent: "browser-agent", variant: null });
  });
});

// ── Unit: mergeAgentConfig for browser-agent plan + claude verify ──

describe("browser-agent pipeline: agent routing config", () => {
  it("routes planner→browser-agent, verifier→claude from metadata", () => {
    const merged = mergeAgentConfig(null, null, {
      planner: "browser-agent:chatgpt",
      verifier: "claude",
    });
    assert.deepEqual(merged.planner, { agent: "browser-agent", variant: "chatgpt" });
    assert.equal(merged.executor, undefined);
    assert.deepEqual(merged.verifier, { agent: "claude", variant: null });
  });

  it("routes planner→browser-agent, executor→claude, verifier→claude", () => {
    const merged = mergeAgentConfig(null, null, {
      planner: { agent: "browser-agent" },
      executor: { agent: "claude" },
      verifier: { agent: "claude" },
    });
    assert.deepEqual(merged.planner, { agent: "browser-agent", variant: null });
    assert.deepEqual(merged.executor, { agent: "claude", variant: null });
    assert.deepEqual(merged.verifier, { agent: "claude", variant: null });
  });

  it("project config defines browser-agent as default, metadata overrides verifier", () => {
    const merged = mergeAgentConfig(
      null,
      { default: "browser-agent" },
      { verifier: "claude" },
    );
    assert.deepEqual(merged.planner, { agent: "browser-agent", variant: null });
    assert.deepEqual(merged.executor, { agent: "browser-agent", variant: null });
    assert.deepEqual(merged.verifier, { agent: "claude", variant: null });
  });

  it("hub default codex + project browser-agent for plan + metadata claude for verify", () => {
    const merged = mergeAgentConfig(
      { default: "codex" },
      { phases: { plan: "browser-agent" } },
      { verifier: "claude" },
    );
    assert.deepEqual(merged.planner, { agent: "browser-agent", variant: null });
    assert.deepEqual(merged.executor, { agent: "codex", variant: null });
    assert.deepEqual(merged.verifier, { agent: "claude", variant: null });
  });
});

// ── Unit: phase resolution for standard workflow ──

describe("browser-agent pipeline: workflow phases", () => {
  it("standard workflow resolves plan→execute→verify", () => {
    const phases = resolvePhases("standard", "full");
    assert.deepEqual(phases, ["plan", "execute", "verify"]);
  });

  it("standard light mode skips verify", () => {
    const phases = resolvePhases("standard", "light");
    assert.deepEqual(phases, ["plan", "execute"]);
  });
});

// ── Integration: resolveAgent in plan.js and verify.js ──
// Simulates the internal resolveAgent() logic from each phase module

describe("browser-agent pipeline: phase-level agent resolution", () => {
  function resolvePlanAgent(ctx) {
    const raw = ctx.agents?.planner || ctx.agent || "codex";
    if (typeof raw === "object" && raw !== null) return { agent: raw.agent || "codex", variant: raw.variant || null };
    return { agent: raw, variant: null };
  }

  function resolveVerifyAgent(ctx) {
    const raw = ctx.agents?.verifier || ctx.agent || "codex";
    if (typeof raw === "object" && raw !== null) return { agent: raw.agent || "codex", variant: raw.variant || null };
    return { agent: raw, variant: null };
  }

  function resolveExecuteAgent(ctx) {
    const raw = ctx.agents?.executor || ctx.agent || "claude";
    if (typeof raw === "object" && raw !== null) return { agent: raw.agent || "claude", variant: raw.variant || null };
    return { agent: raw, variant: null };
  }

  it("resolves plan→browser-agent with variant from merged agents", () => {
    const merged = mergeAgentConfig(null, null, {
      planner: "browser-agent:chatgpt",
      verifier: "claude",
    });
    const ctx = { agents: merged };
    assert.deepEqual(resolvePlanAgent(ctx), { agent: "browser-agent", variant: "chatgpt" });
  });

  it("resolves verify→claude from merged agents", () => {
    const merged = mergeAgentConfig(null, null, {
      planner: "browser-agent:chatgpt",
      verifier: "claude",
    });
    const ctx = { agents: merged };
    assert.deepEqual(resolveVerifyAgent(ctx), { agent: "claude", variant: null });
  });

  it("resolves execute→claude (default) when not overridden", () => {
    const merged = mergeAgentConfig(null, null, {
      planner: "browser-agent:chatgpt",
      verifier: "claude",
    });
    const ctx = { agents: merged };
    assert.deepEqual(resolveExecuteAgent(ctx), { agent: "claude", variant: null });
  });

  it("falls back to ctx.agent when agents map has no role entry", () => {
    const ctx = { agents: { planner: "browser-agent" }, agent: "codex" };
    assert.deepEqual(resolveVerifyAgent(ctx), { agent: "codex", variant: null });
  });

  it("falls back to hardcoded default when neither agents nor agent is set", () => {
    const ctx = {};
    assert.deepEqual(resolvePlanAgent(ctx), { agent: "codex", variant: null });
    assert.deepEqual(resolveVerifyAgent(ctx), { agent: "codex", variant: null });
    assert.deepEqual(resolveExecuteAgent(ctx), { agent: "claude", variant: null });
  });

  it("handles full browser-agent plan + claude execute + claude verify scenario", () => {
    const merged = mergeAgentConfig(null, null, {
      planner: { agent: "browser-agent" },
      executor: { agent: "claude" },
      verifier: { agent: "claude" },
    });
    const ctx = { agents: merged };
    assert.deepEqual(resolvePlanAgent(ctx), { agent: "browser-agent", variant: null });
    assert.deepEqual(resolveExecuteAgent(ctx), { agent: "claude", variant: null });
    assert.deepEqual(resolveVerifyAgent(ctx), { agent: "claude", variant: null });
  });
});
