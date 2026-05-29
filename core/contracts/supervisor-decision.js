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
      properties: {
        workflow: { type: "enum", values: ["standard", "complex", "direct", "blocked", "sdd-standard"] },
        planMode: { type: "enum", values: ["full", "light", "none", "auto", "parent"] },
      },
    },
  },
  [SupervisorAction.SWITCH_AGENT]: {
    params: {
      required: ["role", "agent"],
      properties: {
        role: { type: "enum", values: ["planner", "executor", "verifier", "reviewer", "repairer"] },
        agent: { type: "string" },
      },
    },
  },
  [SupervisorAction.WAIT_FOR_RATE_LIMIT]: {
    params: {
      required: ["untilTs"],
      properties: { untilTs: { type: "date-time" } },
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

/**
 * P1-1 fix: strict schema validation with enum, type, and additionalProperties checks.
 */
export function validateSupervisorDecision(decision) {
  if (!decision || typeof decision !== "object") {
    return { valid: false, errors: ["decision must be an object"] };
  }
  const errors = [];

  // Action must be valid
  if (!VALID_ACTIONS.has(decision.action)) {
    errors.push(`invalid action: ${decision.action} (allowed: ${[...VALID_ACTIONS].join(", ")})`);
  }

  // Reason required and must be string
  if (typeof decision.reason !== "string" || !decision.reason) {
    errors.push("reason is required and must be a string");
  }

  // Confidence must be 0-1 if present
  if (decision.confidence != null && (typeof decision.confidence !== "number" || decision.confidence < 0 || decision.confidence > 1)) {
    errors.push("confidence must be between 0 and 1");
  }

  // Validate params
  if (decision.params) {
    if (typeof decision.params !== "object" || Array.isArray(decision.params)) {
      errors.push("params must be an object");
    } else {
      const schema = ACTION_SCHEMAS[decision.action];

      // Check forbidden params
      for (const key of Object.keys(decision.params)) {
        if (FORBIDDEN_PARAMS.has(key)) {
          errors.push(`forbidden param: ${key}`);
        }
      }

      if (schema?.params) {
        // Check required params
        for (const req of schema.params.required) {
          if (!(req in decision.params)) {
            errors.push(`missing required param: ${req}`);
          }
        }

        // Check enum and type constraints for each property
        for (const [key, spec] of Object.entries(schema.params.properties)) {
          const value = decision.params[key];
          if (value === undefined) continue; // required check handles missing

          if (spec.type === "enum") {
            if (!spec.values.includes(value)) {
              errors.push(`param ${key} invalid value: "${value}" (allowed: ${spec.values.join(", ")})`);
            }
          } else if (spec.type === "string") {
            if (typeof value !== "string" || !value) {
              errors.push(`param ${key} must be a non-empty string`);
            }
          } else if (spec.type === "date-time") {
            const parsed = Date.parse(value);
            if (!Number.isFinite(parsed)) {
              errors.push(`param ${key} must be a valid ISO datetime`);
            }
          }
        }

        // additionalProperties: reject params not in schema
        const allowedKeys = new Set([...Object.keys(schema.params.properties), ...FORBIDDEN_PARAMS]);
        // Actions without explicit param schemas allow any non-forbidden param
        for (const key of Object.keys(decision.params)) {
          if (!allowedKeys.has(key)) {
            errors.push(`unexpected param for ${decision.action}: ${key}`);
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
