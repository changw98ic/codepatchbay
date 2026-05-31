/**
 * Policy gate — enforces team policy compliance before proceeding.
 *
 * Checks ctx.policy against ctx.operation. If the policy requires
 * approval for the operation, and no approval is present, the gate fails.
 *
 * Context fields:
 *   policy: object (team-policy shape)
 *   operation: string (write|shell|network|push|PR|merge)
 *   approvalStatus: "approved"|"pending"|"rejected"|undefined
 */

import { gatePassed, gateFailed } from "./gate-result.js";

const VALID_OPERATIONS = new Set(["write", "shell", "network", "push", "PR", "merge"]);

const policyGate = {
  type: "policy",
  description: "Enforces team policy compliance for operations",

  async evaluate(ctx) {
    const policy = ctx.policy;
    const operation = ctx.operation;

    if (!policy) {
      return gatePassed({
        gateType: "policy",
        reason: "no policy configured",
      });
    }

    if (!operation) {
      return gatePassed({
        gateType: "policy",
        reason: "no operation specified",
      });
    }

    const approvals = policy.approvals;
    if (!approvals || typeof approvals !== "object") {
      return gatePassed({
        gateType: "policy",
        reason: "policy has no approvals section",
      });
    }

    const rule = approvals[operation];
    if (!rule) {
      return gatePassed({
        gateType: "policy",
        reason: `no policy rule for operation "${operation}"`,
      });
    }

    if (!rule.required) {
      return gatePassed({
        gateType: "policy",
        reason: `operation "${operation}" does not require approval`,
        metadata: { operation },
      });
    }

    // Approval required — check if granted
    if (ctx.approvalStatus === "approved") {
      return gatePassed({
        gateType: "policy",
        reason: `approval granted for "${operation}"`,
        metadata: { operation, minReviewers: rule.minReviewers || null },
      });
    }

    return gateFailed({
      gateType: "policy",
      reason: `operation "${operation}" requires approval (policy: ${JSON.stringify(rule)})`,
      metadata: {
        operation,
        required: true,
        channels: rule.channels || [],
        minReviewers: rule.minReviewers || null,
      },
    });
  },
};

export default policyGate;
