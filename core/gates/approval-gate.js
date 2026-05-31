/**
 * Approval gate — blocks until a human approves the operation.
 *
 * Checks ctx.approvalStatus:
 *   "approved"  → passed
 *   "pending"   → blocked
 *   "rejected"  → failed
 *   undefined   → passes if approval not required, blocks if required
 *
 * Context fields:
 *   approvalStatus: "approved"|"pending"|"rejected"|undefined
 *   approvalRequired: boolean (default: checks policy)
 *   actor: string (who approved/rejected)
 *   reason: string
 */

import { gatePassed, gateBlocked, gateFailed } from "./gate-result.js";

function resolveRequired(ctx) {
  if (ctx.approvalRequired !== undefined) return Boolean(ctx.approvalRequired);
  // Fall back to policy-based check if available
  if (typeof ctx.requiresApproval === "function") {
    return ctx.requiresApproval(ctx.operation || "execute");
  }
  return false;
}

const approvalGate = {
  type: "approval",
  description: "Blocks pipeline until human approval is granted",

  async evaluate(ctx) {
    const status = ctx.approvalStatus;
    const required = resolveRequired(ctx);

    if (status === "approved") {
      return gatePassed({
        gateType: "approval",
        reason: `approved by ${ctx.actor || "unknown"}`,
        metadata: { actor: ctx.actor || null },
      });
    }

    if (status === "rejected") {
      return gateFailed({
        gateType: "approval",
        reason: ctx.reason || "approval rejected",
        metadata: { actor: ctx.actor || null },
      });
    }

    if (status === "pending") {
      return gateBlocked({
        gateType: "approval",
        reason: "waiting for human approval",
        metadata: { actor: ctx.actor || null },
      });
    }

    // No explicit status — pass if not required, block if required
    if (!required) {
      return gatePassed({
        gateType: "approval",
        reason: "approval not required",
      });
    }

    return gateBlocked({
      gateType: "approval",
      reason: "approval required but not yet requested",
    });
  },
};

export default approvalGate;
