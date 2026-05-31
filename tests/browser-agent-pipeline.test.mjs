import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { mergeAgentConfig, normalizeAgentSpec } from "../server/services/agent-config.js";
import { resolvePhases } from "../core/engine/workflow-runner.js";
import {
  getWorkflow,
  nextPhase,
  bridgeForPhase,
  roleForPhase,
  isWorkflowName,
  listWorkflows,
  getDefaultAgentsForWorkflow,
  normalizeWorkflow,
} from "../core/workflow/definition.js";
import { resolveRoutingForCategory, defaultRoutingForCategory, resolveEffectiveRouting } from "../core/agents/routing.js";

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

// ── Unit: phase resolution for standard + browser-verify workflows ──

describe("browser-agent pipeline: workflow phases", () => {
  it("standard workflow resolves plan→execute→verify", () => {
    const phases = resolvePhases("standard", "full");
    assert.deepEqual(phases, ["plan", "execute", "verify"]);
  });

  it("standard light mode skips verify", () => {
    const phases = resolvePhases("standard", "light");
    assert.deepEqual(phases, ["plan", "execute"]);
  });

  it("browser-verify workflow resolves plan→execute→verify", () => {
    const phases = resolvePhases("browser-verify", "full");
    assert.deepEqual(phases, ["plan", "execute", "verify"]);
  });

  it("browser-verify light mode resolves plan→execute", () => {
    const phases = resolvePhases("browser-verify", "light");
    assert.deepEqual(phases, ["plan", "execute"]);
  });

  it("browser-verify none mode resolves execute→verify", () => {
    const phases = resolvePhases("browser-verify", "none");
    assert.deepEqual(phases, ["execute", "verify"]);
  });
});

// ── Unit: workflow definition for browser-verify ──

describe("browser-verify workflow: definition", () => {
  it("is a recognized workflow name", () => {
    assert.equal(isWorkflowName("browser-verify"), true);
  });

  it("appears in workflow list", () => {
    const names = listWorkflows();
    assert.ok(names.includes("browser-verify"), `expected browser-verify in ${names}`);
  });

  it("has 3 phases: plan, execute, verify", () => {
    const wf = getWorkflow("browser-verify");
    assert.deepEqual(wf.phases, ["plan", "execute", "verify"]);
  });

  it("maps plan→planner, execute→executor, verify→verifier", () => {
    const wf = getWorkflow("browser-verify");
    assert.equal(roleForPhase(wf, "plan"), "planner");
    assert.equal(roleForPhase(wf, "execute"), "executor");
    assert.equal(roleForPhase(wf, "verify"), "verifier");
  });

  it("uses run-phase.mjs for all phases", () => {
    const wf = getWorkflow("browser-verify");
    assert.equal(bridgeForPhase(wf, "plan"), "run-phase.mjs");
    assert.equal(bridgeForPhase(wf, "execute"), "run-phase.mjs");
    assert.equal(bridgeForPhase(wf, "verify"), "run-phase.mjs");
  });

  it("has defaultAgents: planner→browser-agent, executor→claude, verifier→claude", () => {
    const defaults = getDefaultAgentsForWorkflow("browser-verify");
    assert.deepEqual(defaults, {
      planner: "browser-agent",
      executor: "claude",
      verifier: "claude",
    });
  });

  it("normalizes to a DAG with 3 sequential nodes", () => {
    const dag = normalizeWorkflow("browser-verify");
    assert.equal(dag.isDag, true);
    assert.equal(dag.nodes.length, 3);
    assert.equal(dag.nodes[0].phase, "plan");
    assert.equal(dag.nodes[1].phase, "execute");
    assert.equal(dag.nodes[2].phase, "verify");
  });

  it("nextPhase advances correctly: null→plan→execute→verify→null", () => {
    const wf = getWorkflow("browser-verify");
    assert.equal(nextPhase(wf, null), "plan");
    assert.equal(nextPhase(wf, "plan"), "execute");
    assert.equal(nextPhase(wf, "execute"), "verify");
    assert.equal(nextPhase(wf, "verify"), null);
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

// ── Integration: browser-verify workflow default agents resolution ──

describe("browser-verify workflow: default agent resolution with workflow", () => {
  function resolveAgentsForBrowserVerify() {
    const defaults = getDefaultAgentsForWorkflow("browser-verify");
    if (!defaults) return null;
    return mergeAgentConfig(null, null, {
      planner: defaults.planner,
      executor: defaults.executor,
      verifier: defaults.verifier,
    });
  }

  it("resolves all roles from workflow defaultAgents", () => {
    const agents = resolveAgentsForBrowserVerify();
    assert.ok(agents);
    assert.deepEqual(agents.planner, { agent: "browser-agent", variant: null });
    assert.deepEqual(agents.executor, { agent: "claude", variant: null });
    assert.deepEqual(agents.verifier, { agent: "claude", variant: null });
  });

  it("allows metadata override of browser-agent variant", () => {
    const defaults = getDefaultAgentsForWorkflow("browser-verify");
    const merged = mergeAgentConfig(null, null, {
      planner: `${defaults.planner}:chatgpt`,
      executor: defaults.executor,
      verifier: defaults.verifier,
    });
    assert.deepEqual(merged.planner, { agent: "browser-agent", variant: "chatgpt" });
    assert.deepEqual(merged.verifier, { agent: "claude", variant: null });
  });

  it("preserves workflow defaults when only verifier is overridden", () => {
    const defaults = getDefaultAgentsForWorkflow("browser-verify");
    const merged = mergeAgentConfig(null, null, {
      planner: defaults.planner,
      verifier: "codex",
    });
    assert.deepEqual(merged.planner, { agent: "browser-agent", variant: null });
    assert.equal(merged.executor, undefined);
    assert.deepEqual(merged.verifier, { agent: "codex", variant: null });
  });
});

// ── Integration: routing integration for browser-agent plan + claude verify ──

describe("browser-agent pipeline: routing integration", () => {
  it("routes research category to browser-agent planner + claude verifier via custom routing", () => {
    const routing = {
      rules: {
        research: {
          workflow: "browser-verify",
          planner: "browser-agent",
          verifier: "claude",
        },
      },
    };
    const resolved = resolveEffectiveRouting("research", routing);
    assert.equal(resolved.workflow, "browser-verify");
    assert.equal(resolved.planner, "browser-agent");
    assert.equal(resolved.verifier, "claude");
  });

  it("routes frontend category with browser-agent variant via custom routing", () => {
    const routing = {
      rules: {
        frontend: {
          planner: "browser-agent:chatgpt",
          executor: "claude",
          verifier: "claude",
        },
      },
    };
    const resolved = resolveEffectiveRouting("frontend", routing);
    assert.equal(resolved.planner, "browser-agent:chatgpt");
    assert.equal(resolved.executor, "claude");
    assert.equal(resolved.verifier, "claude");
  });

  it("falls back to codex for planner when no routing rule matches", () => {
    const resolved = resolveEffectiveRouting("backend", null);
    assert.equal(resolved.planner, "codex");
    assert.equal(resolved.verifier, "codex");
  });
});

// ── Integration: end-to-end pipeline simulation ──

describe("browser-agent pipeline: end-to-end pipeline simulation", () => {
  function simulatePipeline({ workflow, planMode, hubAgents, projectAgents, metadataAgents }) {
    const phases = resolvePhases(workflow, planMode);
    const merged = mergeAgentConfig(hubAgents, projectAgents, metadataAgents);
    const phaseRoleMap = { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer" };

    return phases.map((phase) => {
      const role = phaseRoleMap[phase];
      const raw = merged[role] || "codex";
      const agent = typeof raw === "object" ? raw.agent : raw;
      const variant = typeof raw === "object" ? raw.variant : null;
      return { phase, role, agent, variant };
    });
  }

  it("browser-verify full pipeline: plan(browser-agent) → execute(claude) → verify(claude)", () => {
    const defaults = getDefaultAgentsForWorkflow("browser-verify");
    const steps = simulatePipeline({
      workflow: "browser-verify",
      planMode: "full",
      hubAgents: null,
      projectAgents: null,
      metadataAgents: {
        planner: defaults.planner,
        executor: defaults.executor,
        verifier: defaults.verifier,
      },
    });
    assert.equal(steps.length, 3);
    assert.equal(steps[0].phase, "plan");
    assert.equal(steps[0].agent, "browser-agent");
    assert.equal(steps[1].phase, "execute");
    assert.equal(steps[1].agent, "claude");
    assert.equal(steps[2].phase, "verify");
    assert.equal(steps[2].agent, "claude");
  });

  it("browser-verify with chatgpt variant for plan", () => {
    const steps = simulatePipeline({
      workflow: "browser-verify",
      planMode: "full",
      hubAgents: null,
      projectAgents: null,
      metadataAgents: {
        planner: "browser-agent:chatgpt",
        executor: "claude",
        verifier: "claude",
      },
    });
    assert.equal(steps[0].agent, "browser-agent");
    assert.equal(steps[0].variant, "chatgpt");
    assert.equal(steps[2].agent, "claude");
  });

  it("standard workflow with no overrides: merged agents defaults to codex for all roles", () => {
    const steps = simulatePipeline({
      workflow: "standard",
      planMode: "full",
      hubAgents: null,
      projectAgents: null,
      metadataAgents: null,
    });
    assert.equal(steps.length, 3);
    assert.equal(steps[0].phase, "plan");
    assert.equal(steps[1].phase, "execute");
    assert.equal(steps[2].phase, "verify");
  });

  it("hub + project + metadata merge with browser-agent plan override", () => {
    const steps = simulatePipeline({
      workflow: "browser-verify",
      planMode: "full",
      hubAgents: { default: "codex" },
      projectAgents: { phases: { plan: "browser-agent" } },
      metadataAgents: { verifier: "claude" },
    });
    assert.equal(steps[0].agent, "browser-agent");
    assert.equal(steps[1].agent, "codex");
    assert.equal(steps[2].agent, "claude");
  });

  it("browser-verify light mode skips verify phase", () => {
    const defaults = getDefaultAgentsForWorkflow("browser-verify");
    const steps = simulatePipeline({
      workflow: "browser-verify",
      planMode: "light",
      hubAgents: null,
      projectAgents: null,
      metadataAgents: {
        planner: defaults.planner,
        executor: defaults.executor,
        verifier: defaults.verifier,
      },
    });
    assert.equal(steps.length, 2);
    assert.equal(steps[0].phase, "plan");
    assert.equal(steps[0].agent, "browser-agent");
    assert.equal(steps[1].phase, "execute");
    assert.equal(steps[1].agent, "claude");
  });
});
