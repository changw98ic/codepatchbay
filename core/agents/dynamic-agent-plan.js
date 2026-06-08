const DEFAULT_DYNAMIC_VERIFIER_AGENT = process.env.CPB_DYNAMIC_VERIFIER_AGENT || "codex";

export const DYNAMIC_AGENT_PLAN_SCHEMA_VERSION = 1;

function highRisk(riskMap = {}) {
  return riskMap.riskLevel === "high" || riskMap.riskLevel === "critical" || riskMap.adversarialRequired === true;
}

function nodeConfigForDag(workflowDag, config) {
  const result = {};
  for (const node of Array.isArray(workflowDag?.nodes) ? workflowDag.nodes : []) {
    if (node.role === "verifier" || node.phase === "verify") {
      result[node.id] = { ...config.verifier };
    }
  }
  return result;
}

export function generateDynamicAgentPlan({ riskMap = {}, workflowDag = null, workflow = null, planMode = null } = {}) {
  const requiresIndependentVerifier = highRisk(riskMap);
  const generatedAt = new Date().toISOString();
  const agentConfig = {};

  if (requiresIndependentVerifier) {
    agentConfig.verifier = {
      agent: DEFAULT_DYNAMIC_VERIFIER_AGENT,
      required: true,
      independent: true,
      reason: `${riskMap.riskLevel || "high"} risk requires independent verification`,
    };
    agentConfig.adversarial_verifier = {
      agent: DEFAULT_DYNAMIC_VERIFIER_AGENT,
      required: true,
      independent: true,
      reason: "RiskMap requires adversarial verification",
    };
  }

  return {
    schemaVersion: DYNAMIC_AGENT_PLAN_SCHEMA_VERSION,
    source: "riskmap",
    generatedAt,
    workflow,
    planMode,
    riskLevel: riskMap.riskLevel || "medium",
    domains: Array.isArray(riskMap.domains) ? riskMap.domains : [],
    verificationDepth: riskMap.verificationDepth || null,
    adversarialRequired: Boolean(riskMap.adversarialRequired),
    independentVerifierRequired: requiresIndependentVerifier,
    agentConfig,
    nodeConfig: nodeConfigForDag(workflowDag, agentConfig),
  };
}
