const DEFAULT_DYNAMIC_VERIFIER_AGENT = process.env.CPB_DYNAMIC_VERIFIER_AGENT || "codex";

export const DYNAMIC_AGENT_PLAN_SCHEMA_VERSION = 1;

/** Roles that MUST bind to a real DAG node when marked required. */
const REQUIRED_ROLES = new Set(["verifier", "adversarial_verifier"]);

function highRisk(riskMap: Record<string, any> = {}) {
  return riskMap.riskLevel === "high" || riskMap.riskLevel === "critical" || riskMap.adversarialRequired === true;
}

/**
 * Determine which agentConfig role a DAG node maps to.
 */
function matchNodeToRole(node: Record<string, any>, agentConfig: Record<string, any>) {
  if (!agentConfig) return null;

  if (node.role === "adversarial_verifier" || node.phase === "adversarial_verify") {
    return agentConfig.adversarial_verifier ? "adversarial_verifier" : null;
  }
  if (node.role === "verifier" || node.phase === "verify") {
    return agentConfig.verifier ? "verifier" : null;
  }
  return null;
}

/**
 * Build per-node agent configs from a DAG, collecting which DAG node IDs
 * each required role maps to.
 */
function nodeConfigForDag(workflowDag: Record<string, any>, agentConfig: Record<string, any>) {
  const nodes = Array.isArray(workflowDag?.nodes) ? workflowDag.nodes : [];
  const result: Record<string, any> = {};
  const roleToNodeIds: Record<string, any> = {};

  for (const node of nodes) {
    const matchedRole = matchNodeToRole(node, agentConfig);
    if (!matchedRole) continue;

    if (!result[node.id]) {
      result[node.id] = { ...agentConfig[matchedRole] };
    }
    result[node.id].nodeIds = [node.id];

    if (!roleToNodeIds[matchedRole]) {
      roleToNodeIds[matchedRole] = [];
    }
    roleToNodeIds[matchedRole].push(node.id);
  }

  return { config: result, roleToNodeIds };
}

/**
 * Validate that every required role in agentConfig binds to at least one
 * DAG node. Returns { valid: true } or
 * { valid: false, reason, missingRoles }.
 */
/**
 * Map DAG node phases to the agent config roles they would bind to.
 * Only roles that have a corresponding DAG node should be validated.
 */
const PHASE_ROLE_MAP: Record<string, string> = {
  verify: "verifier",
  adversarial_verify: "adversarial_verifier",
};

export function validateDynamicAgentPlan(plan: Record<string, any>, workflowDag: Record<string, any>) {
  if (!plan) return { valid: true };

  const agentConfig = (plan.agentConfig || {}) as Record<string, any>;
  const explicitRoleToNodeIds = (plan.roleToNodeIds || {}) as Record<string, any>;
  const { roleToNodeIds: computedRoleToNodeIds } = nodeConfigForDag(workflowDag, agentConfig);

  // Determine which roles have corresponding DAG nodes
  const dagPhases = Array.isArray(workflowDag?.nodes)
    ? workflowDag.nodes.map((n: Record<string, any>) => n.phase || n.id)
    : [];
  const dagBoundRoles = new Set();
  for (const phase of dagPhases) {
    const mappedRole = PHASE_ROLE_MAP[phase];
    if (mappedRole) dagBoundRoles.add(mappedRole);
  }

  const missingRoles = [];

  for (const role of Object.keys(agentConfig)) {
    if (!agentConfig[role]?.required) continue;
    if (!REQUIRED_ROLES.has(role)) continue;
    // Skip validation for roles whose phase is not in the DAG
    if (!dagBoundRoles.has(role)) continue;

    const bound = Array.isArray(explicitRoleToNodeIds[role]) && explicitRoleToNodeIds[role].length > 0
      ? explicitRoleToNodeIds[role]
      : computedRoleToNodeIds[role];
    if (!bound || bound.length === 0) {
      missingRoles.push(role);
    }
  }

  if (missingRoles.length === 0) return { valid: true };

  const roleList = missingRoles.join(", ");
  return {
    valid: false,
    reason: `Required role(s) ${roleList} have no DAG node binding`,
    missingRoles,
  };
}

export function generateDynamicAgentPlan(options: Record<string, any> = {}) {
  const { riskMap: rawRiskMap = {}, workflowDag = null, workflow = null, planMode = null } = options;
  const riskMap = rawRiskMap as Record<string, any>;
  const requiresIndependentVerifier = highRisk(riskMap);
  const generatedAt = new Date().toISOString();
  const agentConfig: Record<string, any> = {};

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

  const { config: nodeConfig, roleToNodeIds } = nodeConfigForDag(workflowDag, agentConfig);

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
    nodeConfig,
    roleToNodeIds,
  };
}
