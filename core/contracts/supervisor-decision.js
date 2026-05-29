export const SupervisorAction = Object.freeze({
  RETRY_SAME_WORKER: "retry_same_worker",
  RESTART_WORKER_AND_RETRY: "restart_worker_and_retry",
  REROUTE: "reroute",
  SWITCH_AGENT: "switch_agent",
  WAIT_FOR_RATE_LIMIT: "wait_for_rate_limit",
  REQUEST_HUMAN_APPROVAL: "request_human_approval",
  MARK_FAILED: "mark_failed",
  MARK_BLOCKED: "mark_blocked",
});

const VALID_ACTIONS = new Set(Object.values(SupervisorAction));

const ACTION_SCHEMAS = {
  [SupervisorAction.REROUTE]: {
    params: {
      required: ["workflow", "planMode"],
      properties: { workflow: ["standard", "complex"], planMode: ["full", "light"] },
    },
  },
  [SupervisorAction.SWITCH_AGENT]: {
    params: {
      required: ["role", "agent"],
      properties: {
        role: ["planner", "executor", "verifier"],
        agent: "string",
      },
    },
  },
  [SupervisorAction.WAIT_FOR_RATE_LIMIT]: {
    params: {
      required: ["untilTs"],
      properties: { untilTs: "date-time" },
    },
  },
};

const FORBIDDEN_PARAMS = new Set([
  "projectId", "sourcePath", "cwd", "env", "command", "shell",
  "args", "token", "secret", "writeAllowPaths", "dangerous",
]);

export function isValidSupervisorAction(action) {
  return VALID_ACTIONS.has(action);
}

export function validateSupervisorDecision(decision) {
  if (!decision || typeof decision !== "object") {
    return { valid: false, errors: ["decision must be an object"] };
  }
  const errors = [];

  if (!VALID_ACTIONS.has(decision.action)) {
    errors.push(`invalid action: ${decision.action}`);
  }
  if (typeof decision.reason !== "string" || !decision.reason) {
    errors.push("reason is required and must be a string");
  }
  if (decision.confidence != null && (typeof decision.confidence !== "number" || decision.confidence < 0 || decision.confidence > 1)) {
    errors.push("confidence must be between 0 and 1");
  }

  if (decision.params) {
    for (const key of Object.keys(decision.params)) {
      if (FORBIDDEN_PARAMS.has(key)) {
        errors.push(`forbidden param: ${key}`);
      }
    }

    const schema = ACTION_SCHEMAS[decision.action];
    if (schema?.params) {
      for (const req of schema.params.required) {
        if (!(req in decision.params)) {
          errors.push(`missing required param: ${req}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
