import { validatePolicy, defaultPolicy, approvalOperations, requiresApproval } from "../../core/policy/team-policy.js";
import { getPhasePolicy } from "../services/permission-matrix.js";
import { knowledgePolicySummary } from "../services/knowledge-policy.js";

const VALID_ROLES = new Set(["planner", "executor", "verifier", "repairer", "reviewer"]);

export async function policyRoutes(fastify) {

  // Get effective phase policy for a role
  fastify.get("/policy/phase", async (req) => {
    const { role = "executor", project = "default" } = req.query || {};
    if (!VALID_ROLES.has(role)) {
      throw fastify.httpErrors.badRequest(`Invalid role: ${role}. Must be one of: ${[...VALID_ROLES].join(", ")}`);
    }
    return getPhasePolicy(role, req.cpbRoot, project);
  });

  // Validate a team policy JSON payload
  fastify.post("/policy/validate", async (req) => {
    const policy = req.body;
    if (!policy || typeof policy !== "object") {
      throw fastify.httpErrors.badRequest("Request body must be a policy object");
    }
    const result = validatePolicy(policy);
    if (result.valid) {
      const ops = approvalOperations();
      const required = ops.filter(op => requiresApproval(policy, op));
      return { valid: true, errors: [], approvalRequiredFor: required };
    }
    return { valid: false, errors: result.errors, approvalRequiredFor: [] };
  });

  // Get default team policy
  fastify.get("/policy/defaults", async () => {
    return defaultPolicy();
  });

  // Get knowledge write policy
  fastify.get("/policy/knowledge", async () => {
    return knowledgePolicySummary();
  });

  // List all roles and their policies
  fastify.get("/policy/roles", async (req) => {
    const { project = "default" } = req.query || {};
    const roles = [...VALID_ROLES];
    const policies = {};
    for (const role of roles) {
      policies[role] = getPhasePolicy(role, req.cpbRoot, project);
    }
    return { roles, policies };
  });
}
