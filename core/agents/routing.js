import {
  defaultAgentForRole,
  getDescriptor,
} from "./registry.js";

export const ROUTING_TASK_CATEGORIES = Object.freeze([
  "bugfix",
  "test",
  "docs",
  "security",
  "frontend",
  "backend",
  "infra",
  "research",
  "review",
]);

export const ROUTING_PHASE_ROLES = Object.freeze({
  plan: "planner",
  execute: "executor",
  verify: "verifier",
  review: "reviewer",
});

const ROUTING_AGENT_ROLES = Object.freeze([
  "planner",
  "executor",
  "verifier",
  "reviewer",
]);

const BUILTIN_AGENT_NAMES = new Set(["codex", "claude"]);
const CATEGORY_SET = new Set(ROUTING_TASK_CATEGORIES);

function routingRules(routing) {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) return {};
  if (routing.rules && typeof routing.rules === "object" && !Array.isArray(routing.rules)) {
    return routing.rules;
  }
  return routing;
}

function defaultAgent(role) {
  try {
    return defaultAgentForRole(role);
  } catch {
    if (role === "executor") return "claude";
    return "codex";
  }
}

function isKnownAgent(name) {
  if (!name) return true;
  try {
    return Boolean(getDescriptor(name));
  } catch {
    return BUILTIN_AGENT_NAMES.has(name);
  }
}

function normalizeCategory(category) {
  const value = String(category || "").trim().toLowerCase();
  return CATEGORY_SET.has(value) ? value : null;
}

export function resolveRoutingForCategory(category, routing) {
  const normalized = normalizeCategory(category);
  if (!normalized) return null;
  const rules = routingRules(routing);
  const rule = rules[normalized];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
  return {
    category: normalized,
    workflow: rule.workflow || null,
    planner: rule.planner || null,
    executor: rule.executor || null,
    verifier: rule.verifier || null,
    reviewer: rule.reviewer || null,
    fallback: rule.fallback || null,
  };
}

export function defaultRoutingForCategory(category, { workflow = "standard" } = {}) {
  const normalized = normalizeCategory(category);
  return {
    category: normalized,
    workflow,
    planner: defaultAgent("planner"),
    executor: defaultAgent("executor"),
    verifier: defaultAgent("verifier"),
    reviewer: defaultAgent("reviewer"),
    fallback: null,
  };
}

export function resolveEffectiveRouting(category, routing, { workflow = "standard" } = {}) {
  const resolved = resolveRoutingForCategory(category, routing);
  const defaults = defaultRoutingForCategory(category, { workflow });
  if (!resolved) return defaults;
  return {
    ...defaults,
    ...resolved,
    workflow: resolved.workflow || defaults.workflow,
    planner: resolved.planner || defaults.planner,
    executor: resolved.executor || defaults.executor,
    verifier: resolved.verifier || defaults.verifier,
    reviewer: resolved.reviewer || defaults.reviewer,
  };
}

export function agentForRoutingPhase(routing, phase, role = null) {
  const resolvedRole = role || ROUTING_PHASE_ROLES[phase];
  return resolvedRole ? routing?.[resolvedRole] || null : null;
}

export function validateRoutingRules(routing, { isWorkflowName } = {}) {
  const errors = [];
  const rules = routingRules(routing);

  for (const [category, rule] of Object.entries(rules)) {
    if (!CATEGORY_SET.has(category)) {
      errors.push(`unknown routing category: ${category}`);
      continue;
    }
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      errors.push(`routing rule for ${category} must be an object`);
      continue;
    }

    if (rule.workflow && isWorkflowName && !isWorkflowName(rule.workflow)) {
      errors.push(`routing rule ${category} references unknown workflow: ${rule.workflow}`);
    }

    for (const role of ROUTING_AGENT_ROLES) {
      const agent = rule[role];
      if (agent && !isKnownAgent(agent)) {
        errors.push(`routing rule ${category}.${role} references unknown agent: ${agent}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidRoutingRules(routing, options = {}) {
  const result = validateRoutingRules(routing, options);
  if (!result.valid) {
    throw new Error(`invalid routing rules: ${result.errors.join("; ")}`);
  }
  return result;
}
