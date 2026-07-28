import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDynamicAgentPlan, validateDynamicAgentPlan } from "../core/agents/dynamic-agent-plan.js";

type VerifierConfig = { agent?: string; required?: boolean; independent?: boolean };

test("low-risk plan: no required verifier, schemaVersion=1, source=riskmap", () => {
  const plan = generateDynamicAgentPlan({ riskMap: { riskLevel: "low" }, workflowDag: { nodes: [] } });
  assert.equal(plan.independentVerifierRequired, false);
  assert.equal(plan.agentConfig.verifier, undefined);
  assert.equal(plan.agentConfig.adversarial_verifier, undefined);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.source, "riskmap");
});

test("high-risk plan forces required independent verifier + adversarial_verifier", () => {
  const plan = generateDynamicAgentPlan({ riskMap: { riskLevel: "high" }, workflowDag: { nodes: [] } });
  const verifier = plan.agentConfig.verifier as VerifierConfig;
  const adversarial = plan.agentConfig.adversarial_verifier as VerifierConfig;
  assert.equal(plan.independentVerifierRequired, true);
  assert.equal(verifier.required, true);
  assert.equal(verifier.independent, true);
  assert.equal(adversarial.required, true);
});

test("critical risk and adversarialRequired both trigger independent verifier", () => {
  for (const riskMap of [{ riskLevel: "critical" }, { adversarialRequired: true }]) {
    const plan = generateDynamicAgentPlan({ riskMap, workflowDag: { nodes: [] } });
    assert.equal(plan.independentVerifierRequired, true, JSON.stringify(riskMap));
  }
});

test("verifier agent defaults to codex; overridable via options", () => {
  const a = generateDynamicAgentPlan({ riskMap: { riskLevel: "high" }, workflowDag: { nodes: [] } });
  assert.equal((a.agentConfig.verifier as VerifierConfig).agent, "codex");
  const b = generateDynamicAgentPlan({
    riskMap: { riskLevel: "high" },
    workflowDag: { nodes: [] },
    verifierAgent: "claude",
    adversarialVerifierAgent: "claude-glm",
  });
  assert.equal((b.agentConfig.verifier as VerifierConfig).agent, "claude");
  assert.equal((b.agentConfig.adversarial_verifier as VerifierConfig).agent, "claude-glm");
});

test("validateDynamicAgentPlan: required verifier with bound verify node is valid", () => {
  const workflowDag = { nodes: [{ id: "v1", phase: "verify" }] };
  const plan = generateDynamicAgentPlan({ riskMap: { riskLevel: "high" }, workflowDag });
  const result = validateDynamicAgentPlan(plan, workflowDag);
  assert.equal(result.valid, true);
});

test("validateDynamicAgentPlan: required verifier with verify node but no id binding is invalid", () => {
  // node has phase=verify but no id → nodeConfigForDag skips it → computed binding empty
  const workflowDag = { nodes: [{ phase: "verify" }] };
  const plan = { agentConfig: { verifier: { required: true } }, roleToNodeIds: {} };
  const result = validateDynamicAgentPlan(plan, workflowDag);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingRoles, ["verifier"]);
});
