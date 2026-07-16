import assert from "node:assert/strict";
import { test } from "node:test";

import {
  highAssuranceAgentPolicyViolations,
  highAssuranceAgentForRole,
  resolveHighAssurancePolicy,
} from "../core/policy/high-assurance.js";
import { generateDynamicAgentPlan } from "../core/agents/dynamic-agent-plan.js";

test("high assurance defaults to Codex plus GLM planning, GLM execution, and blind Codex verification", () => {
  const policy = resolveHighAssurancePolicy({ sourceContext: { assurance: { mode: "high" } } });

  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.planning.candidates, ["codex", "claude-glm"]);
  assert.equal(policy.planning.arbiter, "codex");
  assert.equal(policy.execution.agent, "claude-glm");
  assert.equal(policy.verification.agent, "codex");
  assert.equal(policy.verification.blind, true);
  assert.equal(policy.verification.independent, true);
  assert.deepEqual(highAssuranceAgentForRole(policy, "executor"), {
    selectedAgent: "claude-glm",
    required: true,
  });
  assert.deepEqual(highAssuranceAgentForRole(policy, "verifier"), {
    selectedAgent: "codex",
    required: true,
  });
});

test("high assurance can force independent verification for a medium-risk task", () => {
  const plan = generateDynamicAgentPlan({
    riskMap: { riskLevel: "medium", adversarialRequired: false },
    workflow: "standard",
    planMode: "full",
    workflowDag: {
      nodes: [{ id: "verify", phase: "verify", role: "verifier" }],
    },
    independentVerifierRequired: true,
  });

  assert.equal(plan.independentVerifierRequired, true);
  assert.equal((plan.agentConfig as Record<string, Record<string, unknown>>).verifier.independent, true);
  assert.match(String((plan.agentConfig as Record<string, Record<string, unknown>>).verifier.reason), /assurance policy/);
});

test("high assurance validates every planning, execution, and verification agent against the allowed universe", () => {
  const policy = resolveHighAssurancePolicy({
    sourceContext: {
      assurance: {
        mode: "high",
        planning: { candidates: ["codex", "claude"], arbiter: "codex" },
        execution: { agent: "claude-glm" },
        verification: { agent: "codex" },
      },
    },
  });

  assert.deepEqual(
    highAssuranceAgentPolicyViolations(policy, ["codex", "claude-glm"]),
    ["planning.candidateB:claude"],
  );
  assert.deepEqual(highAssuranceAgentPolicyViolations(policy, null), []);
});

test("high assurance bounds critique rounds and accepts explicit role variants", () => {
  const policy = resolveHighAssurancePolicy({
    sourceContext: {
      assurance: {
        mode: "quality-first",
        planning: {
          candidates: [{ agent: "codex", variant: "deep" }, "claude-glm"],
          critiqueRounds: 99,
        },
        execution: { agent: { agent: "claude-glm", variant: "glm-5" } },
      },
    },
  });

  assert.equal(policy.enabled, true);
  assert.equal(policy.planning.critiqueRounds, 2);
  assert.deepEqual(policy.planning.candidates[0], { agent: "codex", variant: "deep" });
  assert.deepEqual(policy.execution.agent, { agent: "claude-glm", variant: "glm-5" });
});
