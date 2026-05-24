const VALID_OPERATIONS = Object.freeze(["write", "shell", "network", "push", "PR", "merge"]);
const VALID_TOP_LEVEL = new Set(["approvals", "routing", "channels", "protectedOperations"]);

export function approvalOperations() {
  return [...VALID_OPERATIONS];
}

export function defaultPolicy() {
  const approvals = {};
  for (const op of VALID_OPERATIONS) {
    approvals[op] = { required: false };
  }
  return { approvals };
}

export function validatePolicy(policy) {
  if (policy === null || policy === undefined || typeof policy !== "object" || Array.isArray(policy)) {
    return { valid: false, errors: ["policy must be a non-null object"] };
  }

  const errors = [];

  for (const key of Reflect.ownKeys(policy)) {
    if (typeof key !== "string" || !VALID_TOP_LEVEL.has(key)) {
      errors.push(`unknown top-level key: ${String(key)}`);
    }
  }

  if ("approvals" in policy) {
    const approvals = policy.approvals;
    if (typeof approvals !== "object" || approvals === null || Array.isArray(approvals)) {
      errors.push("approvals must be an object");
    } else {
      for (const key of Reflect.ownKeys(approvals)) {
        if (typeof key !== "string" || !VALID_OPERATIONS.includes(key)) {
          errors.push(`invalid approval operation: ${String(key)}`);
          continue;
        }
        const entry = approvals[key];
        if (typeof entry !== "object" || entry === null) {
          errors.push(`approval entry for ${key} must be an object`);
          continue;
        }
        if (!("required" in entry)) {
          errors.push(`approval entry for ${key} missing required field`);
        } else if (typeof entry.required !== "boolean") {
          errors.push(`approval entry for ${key}.required must be boolean`);
        }
        if ("channels" in entry && !Array.isArray(entry.channels)) {
          errors.push(`approval entry for ${key}.channels must be an array`);
        }
        if ("minReviewers" in entry && typeof entry.minReviewers !== "number") {
          errors.push(`approval entry for ${key}.minReviewers must be a number`);
        }
      }
    }
  }

  if ("routing" in policy) {
    if (typeof policy.routing !== "object" || policy.routing === null || Array.isArray(policy.routing)) {
      errors.push("routing must be an object");
    } else if ("defaultAgent" in policy.routing && typeof policy.routing.defaultAgent !== "string") {
      errors.push("routing.defaultAgent must be a string");
    }
  }

  if ("channels" in policy) {
    const channels = policy.channels;
    if (typeof channels !== "object" || channels === null || Array.isArray(channels)) {
      errors.push("channels must be an object");
    } else {
      for (const [name, cfg] of Object.entries(channels)) {
        if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) {
          errors.push(`channels.${name} must be an object`);
          continue;
        }
        if ("enabled" in cfg && typeof cfg.enabled !== "boolean") {
          errors.push(`channels.${name}.enabled must be boolean`);
        }
        if ("allowedActions" in cfg) {
          if (!Array.isArray(cfg.allowedActions)) {
            errors.push(`channels.${name}.allowedActions must be an array`);
          } else {
            for (const a of cfg.allowedActions) {
              if (typeof a !== "string") {
                errors.push(`channels.${name}.allowedActions must contain only strings`);
                break;
              }
            }
          }
        }
        if ("requireSignedRequests" in cfg && typeof cfg.requireSignedRequests !== "boolean") {
          errors.push(`channels.${name}.requireSignedRequests must be boolean`);
        }
      }
    }
  }

  if ("protectedOperations" in policy) {
    if (!Array.isArray(policy.protectedOperations)) {
      errors.push("protectedOperations must be an array");
    } else {
      for (const op of policy.protectedOperations) {
        if (typeof op !== "string" || !VALID_OPERATIONS.includes(op)) {
          errors.push(`invalid protectedOperation: ${String(op)}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function requiresApproval(policy, operation) {
  return policy?.approvals?.[operation]?.required === true;
}
