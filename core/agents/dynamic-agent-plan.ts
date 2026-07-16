import { recordValue, type LooseRecord } from "../../shared/types.js";
const DEFAULT_DYNAMIC_VERIFIER_AGENT = process.env.CPB_DYNAMIC_VERIFIER_AGENT || "codex";

export const DYNAMIC_AGENT_PLAN_SCHEMA_VERSION = 1;

/** Roles that MUST bind to a real DAG node when marked required. */
const REQUIRED_ROLES = new Set(["verifier", "adversarial_verifier"]);

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function highRisk(riskMap: unknown = {}) {
  const risk = recordValue(riskMap);
  return risk.riskLevel === "high" || risk.riskLevel === "critical" || risk.adversarialRequired === true;
}

/**
 * Determine which agentConfig role a DAG node maps to.
 */
function matchNodeToRole(node: LooseRecord, agentConfig: LooseRecord) {
  const agents = recordValue(agentConfig);

  if (node.role === "adversarial_verifier" || node.phase === "adversarial_verify") {
    return agents.adversarial_verifier ? "adversarial_verifier" : null;
  }
  if (node.role === "verifier" || node.phase === "verify") {
    return agents.verifier ? "verifier" : null;
  }
  return null;
}

/**
 * Build per-node agent configs from a DAG, collecting which DAG node IDs
 * each required role maps to.
 */
function nodeConfigForDag(workflowDag: LooseRecord, agentConfig: LooseRecord) {
  const dag = recordValue(workflowDag);
  const agents = recordValue(agentConfig);
  const nodes = Array.isArray(dag.nodes) ? dag.nodes.map(recordValue) : [];
  const result: Record<string, LooseRecord> = {};
  const roleToNodeIds: Record<string, string[]> = {};

  for (const node of nodes) {
    const matchedRole = matchNodeToRole(node, agents);
    if (!matchedRole) continue;
    const nodeId = stringValue(node.id);
    if (!nodeId) continue;

    if (!result[nodeId]) {
      result[nodeId] = { ...recordValue(agents[matchedRole]) };
    }
    result[nodeId].nodeIds = [nodeId];

    if (!roleToNodeIds[matchedRole]) {
      roleToNodeIds[matchedRole] = [];
    }
    roleToNodeIds[matchedRole].push(nodeId);
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

export function validateDynamicAgentPlan(plan: LooseRecord, workflowDag: LooseRecord) {
  if (!plan) return { valid: true };

  const planRecord = recordValue(plan);
  const dag = recordValue(workflowDag);
  const agentConfig = recordValue(planRecord.agentConfig);
  const explicitRoleToNodeIds = recordValue(planRecord.roleToNodeIds);
  const { roleToNodeIds: computedRoleToNodeIds } = nodeConfigForDag(workflowDag, agentConfig);

  // Determine which roles have corresponding DAG nodes
  const dagPhases = Array.isArray(dag.nodes)
    ? dag.nodes.map((n) => {
      const node = recordValue(n);
      return stringValue(node.phase) || stringValue(node.id);
    })
    : [];
  const dagBoundRoles = new Set<string>();
  for (const phase of dagPhases) {
    const mappedRole = PHASE_ROLE_MAP[phase];
    if (mappedRole) dagBoundRoles.add(mappedRole);
  }

  const missingRoles: string[] = [];

  for (const role of Object.keys(agentConfig)) {
    const config = recordValue(agentConfig[role]);
    if (!config.required) continue;
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

export function generateDynamicAgentPlan(options: LooseRecord = {}) {
  const riskMap = recordValue(options.riskMap);
  const workflowDag = recordValue(options.workflowDag);
  const workflow = options.workflow ?? null;
  const planMode = options.planMode ?? null;
  const requiresIndependentVerifier = options.independentVerifierRequired === true || highRisk(riskMap);
  const generatedAt = new Date().toISOString();
  const agentConfig: LooseRecord = {};

  if (requiresIndependentVerifier) {
    agentConfig.verifier = {
      agent: DEFAULT_DYNAMIC_VERIFIER_AGENT,
      required: true,
      independent: true,
      reason: options.independentVerifierRequired === true
        ? "assurance policy requires independent verification"
        : `${stringValue(riskMap.riskLevel, "high")} risk requires independent verification`,
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
    riskLevel: stringValue(riskMap.riskLevel, "medium"),
    domains: Array.isArray(riskMap.domains) ? riskMap.domains : [],
    verificationDepth: riskMap.verificationDepth || null,
    adversarialRequired: Boolean(riskMap.adversarialRequired),
    independentVerifierRequired: requiresIndependentVerifier,
    agentConfig,
    nodeConfig,
    roleToNodeIds,
  };
}
