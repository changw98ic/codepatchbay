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
  assert.equal(result.phaseRoutingDecision?.selectedAgent, "routing-executor");
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
  assert.equal(result.phaseRoutingDecision, null);
});
