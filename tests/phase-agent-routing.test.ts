import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePhaseAgentRouting } from "../core/engine/phase-agent-routing.js";

test("resolvePhaseAgentRouting applies dynamic agent before routing fallback without discarding the routing decision", () => {
  const result = resolvePhaseAgentRouting({
    agents: { executor: "base-executor" },
    dynamicAgentPlan: {
      agentConfig: {
        executor: { agent: "dynamic-executor", required: true },
      },
    },
    routing: {
      executor: "routing-executor",
      fallback: { executor: "routing-fallback" },
    },
    phase: "execute",
    role: "executor",
  });

  assert.deepEqual(result.phaseAgents, { executor: "dynamic-executor" });
  assert.deepEqual(result.dynamicAgent, {
    selectedAgent: "dynamic-executor",
    required: true,
  });
  assert.equal(result.effectiveSelectedAgent, "dynamic-executor");
  assert.equal(result.phaseRoutingDecision?.selectedAgent, "dynamic-executor");
  assert.equal(result.phaseRoutingDecision?.staticSelectedAgent, "routing-executor");
  assert.equal(result.phaseRoutingDecision?.selectionSource, "dynamic_agent_plan");
});

test("resolvePhaseAgentRouting uses routing selection when no dynamic agent is selected", () => {
  const result = resolvePhaseAgentRouting({
    agents: { executor: "base-executor", verifier: "base-verifier" },
    routing: {
      executor: "routing-executor",
      fallback: { executor: "routing-fallback" },
    },
    agentAvailability: {
      "routing-executor": { available: false, reason: "rate_limited" },
      "routing-fallback": { available: true },
    },
    phase: "execute",
    role: "executor",
  });

  assert.deepEqual(result.phaseAgents, {
    executor: "routing-fallback",
    verifier: "base-verifier",
  });
  assert.equal(result.dynamicAgent, null);
  assert.equal(result.effectiveSelectedAgent, "routing-fallback");
  assert.equal(result.phaseRoutingDecision?.fallbackApplied, true);
  assert.equal(result.phaseRoutingDecision?.reason, "rate_limited");
});

test("resolvePhaseAgentRouting reads dynamic agent plan from phase source context before source context", () => {
  const result = resolvePhaseAgentRouting({
    agents: {},
    phaseSourceContext: {
      dynamicAgentPlan: {
        agentConfig: {
          verifier: { agent: "phase-source-verifier", variant: "strict" },
        },
      },
    },
    sourceContext: {
      dynamicAgentPlan: {
        agentConfig: {
          verifier: { agent: "source-context-verifier" },
        },
      },
    },
    phase: "verify",
    role: "verifier",
  });

  assert.deepEqual(result.phaseAgents, {
    verifier: { agent: "phase-source-verifier", variant: "strict" },
  });
  assert.deepEqual(result.dynamicAgent, {
    selectedAgent: { agent: "phase-source-verifier", variant: "strict" },
    required: false,
  });
  assert.deepEqual(result.effectiveSelectedAgent, { agent: "phase-source-verifier", variant: "strict" });
  assert.deepEqual(result.phaseRoutingDecision?.selectedAgent, { agent: "phase-source-verifier", variant: "strict" });
  assert.equal(result.phaseRoutingDecision?.outcomeApplied, false);
  assert.match(result.phaseRoutingDecision?.outcomeReason || "", /insufficient baseline evidence/);
});

test("resolvePhaseAgentRouting switches only on sufficiently strong outcome evidence", () => {
  const result = resolvePhaseAgentRouting({
    agents: { executor: "codex" },
    outcomeMetrics: {
      agents: {
        codex: {
          sampleSize: 20,
          successes: 12,
          retries: 5,
          timeouts: 2,
          verifierRuns: 20,
          verifierPasses: 11,
          evidenceCoverage: 1,
          providerKey: "codex",
        },
        claude: {
          sampleSize: 30,
          successes: 29,
          retries: 1,
          timeouts: 0,
          verifierRuns: 30,
          verifierPasses: 28,
          evidenceCoverage: 1,
          providerKey: "claude:sonnet",
        },
      },
    },
    taskCategory: "bugfix",
    phase: "execute",
    role: "executor",
  });

  assert.equal(result.phaseAgents.executor, "claude");
  assert.equal(result.effectiveSelectedAgent, "claude");
  assert.equal(result.phaseRoutingDecision?.outcomeApplied, true);
  assert.equal(result.phaseRoutingDecision?.taskCategory, "bugfix");
  assert.match(result.phaseRoutingDecision?.reason || "", /outcome evidence selected claude/);
});

test("resolvePhaseAgentRouting preserves the Codex baseline when outcome evidence is insufficient", () => {
  const result = resolvePhaseAgentRouting({
    outcomeMetrics: { agents: {} },
    taskCategory: "bugfix",
    phase: "execute",
    role: "executor",
  });

  assert.equal(result.phaseAgents.executor, "codex");
  assert.equal(result.effectiveSelectedAgent, "codex");
  assert.equal(result.phaseRoutingDecision?.selectionSource, "legacy_default");
  assert.equal(result.phaseRoutingDecision?.outcomeApplied, false);
  assert.match(result.phaseRoutingDecision?.outcomeReason || "", /insufficient baseline evidence/);
});

test("resolvePhaseAgentRouting overrides a required verifier only to enforce provider-family independence", () => {
  const result = resolvePhaseAgentRouting({
    agents: { verifier: "codex" },
    phaseSourceContext: {
      agentPolicy: { allowedAgents: ["codex", "claude-glm"] },
    },
    dynamicAgentPlan: {
      agentConfig: { verifier: { agent: "codex", required: true } },
    },
    outcomeMetrics: {
      agents: {
        claude: {
          sampleSize: 50,
          successes: 50,
          verifierRuns: 50,
          verifierPasses: 50,
          providerKey: "anthropic:sonnet",
        },
      },
    },
    excludedProviderFamily: "codex",
    phase: "verify",
    role: "verifier",
  });

  assert.equal(result.phaseAgents.verifier, "claude-glm");
  assert.deepEqual(result.allowedAgents, ["codex", "claude-glm"]);
  assert.equal(result.phaseRoutingDecision?.independenceApplied, true);
  assert.equal(result.phaseRoutingDecision?.agentPolicyConflict, false);
  assert.equal(result.phaseRoutingDecision?.excludedProviderFamily, "codex");
  assert.match(result.phaseRoutingDecision?.reason || "", /independent verifier required/);
});

test("resolvePhaseAgentRouting fails closed when a required role is outside the allowed universe", () => {
  const result = resolvePhaseAgentRouting({
    agents: { verifier: "claude" },
    phaseSourceContext: {
      agentPolicy: { allowedAgents: ["codex", "claude-glm"] },
      dynamicAgentPlan: {
        agentConfig: { verifier: { agent: "claude", required: true } },
      },
    },
    phase: "verify",
    role: "verifier",
  });

  assert.equal(result.effectiveSelectedAgent, null);
  assert.equal(result.phaseRoutingDecision?.agentPolicyConflict, true);
  assert.deepEqual(result.phaseRoutingDecision?.allowedAgents, ["codex", "claude-glm"]);
});

test("high-assurance fixed roles outrank dynamic plans, static routing, and outcome metrics", () => {
  const executor = resolvePhaseAgentRouting({
    agents: { executor: "codex", verifier: "claude" },
    phaseSourceContext: {
      assurance: { mode: "high" },
      dynamicAgentPlan: { agentConfig: { executor: { agent: "dynamic-executor", required: true } } },
    },
    routing: { executor: "routing-executor" },
    outcomeMetrics: {
      agents: {
        "claude-glm": { sampleSize: 1, successes: 0, providerKey: "claude:glm" },
        codex: { sampleSize: 50, successes: 50, verifierRuns: 50, verifierPasses: 50, providerKey: "codex" },
      },
    },
    phase: "execute",
    role: "executor",
  });
  const verifier = resolvePhaseAgentRouting({
    agents: { verifier: "codex" },
    phaseSourceContext: { assurance: { mode: "high" } },
    outcomeMetrics: {
      agents: {
        codex: { sampleSize: 1, successes: 0, providerKey: "codex" },
        claude: { sampleSize: 50, successes: 50, verifierRuns: 50, verifierPasses: 50, providerKey: "anthropic:sonnet" },
      },
    },
    phase: "verify",
    role: "verifier",
  });

  assert.equal(executor.phaseAgents.executor, "claude-glm");
  assert.equal(executor.phaseRoutingDecision?.selectionSource, "high_assurance_policy");
  assert.equal(executor.phaseRoutingDecision?.outcomeApplied, false);
  assert.equal(verifier.phaseAgents.verifier, "codex");
  assert.equal(verifier.phaseRoutingDecision?.selectionSource, "high_assurance_policy");
  assert.equal(verifier.phaseRoutingDecision?.outcomeApplied, false);
});
