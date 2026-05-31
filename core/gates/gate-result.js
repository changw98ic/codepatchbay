/**
 * Gate result contract — mirrors phase-result.js pattern.
 *
 * A gate evaluation returns one of:
 *   - passed:  condition satisfied, proceed
 *   - blocked: waiting for external resolution (e.g. human approval)
 *   - failed:  condition violated, abort or escalate
 */

const VALID_STATUSES = new Set(["passed", "blocked", "failed"]);

export function gatePassed({ gateType, reason = null, metadata = {} }) {
  return {
    schemaVersion: 1,
    gateType,
    status: "passed",
    reason,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

export function gateBlocked({ gateType, reason, metadata = {} }) {
  return {
    schemaVersion: 1,
    gateType,
    status: "blocked",
    reason: String(reason),
    metadata,
    createdAt: new Date().toISOString(),
  };
}

export function gateFailed({ gateType, reason, metadata = {} }) {
  return {
    schemaVersion: 1,
    gateType,
    status: "failed",
    reason: String(reason),
    metadata,
    createdAt: new Date().toISOString(),
  };
}

export function isGatePassed(result) {
  return result?.status === "passed";
}

export function isGateBlocked(result) {
  return result?.status === "blocked";
}

export function isGateFailed(result) {
  return result?.status === "failed";
}

export function isValidGateStatus(status) {
  return VALID_STATUSES.has(status);
}
