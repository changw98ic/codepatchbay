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
    allowFallback: rule.allowFallback !== false,
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
    allowFallback: true,
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

export function fallbackAgentForRole(routing, role) {
  const fallback = routing?.fallback;
  if (!fallback) return null;
  if (typeof fallback === "string") return fallback;
  if (typeof fallback === "object" && !Array.isArray(fallback)) {
    return fallback[role] || null;
  }
  return null;
}

function availabilityFor(agentAvailability, agent) {
  if (!agent || !agentAvailability || typeof agentAvailability !== "object") {
    return { available: true, reason: null };
  }
  const entry = agentAvailability[agent];
  if (entry === undefined) return { available: true, reason: null };
  if (entry === false) return { available: false, reason: "unavailable" };
  if (entry === true) return { available: true, reason: null };
  if (typeof entry === "object" && entry) {
    return {
      available: entry.available !== false && !["unavailable", "rate_limited", "offline"].includes(entry.status),
      reason: entry.reason || entry.status || null,
    };
  }
  return { available: Boolean(entry), reason: null };
}

export function selectAgentWithFallback({
  role,
  preferredAgent,
  fallbackAgent = null,
  agentAvailability = null,
  allowFallback = true,
  policyAllowsFallback = true,
} = {}) {
  const preferred = preferredAgent || null;
  const fallback = fallbackAgent || null;
  const fallbackPermitted = allowFallback !== false && policyAllowsFallback !== false;
  const preferredStatus = availabilityFor(agentAvailability, preferred);

  if (!preferred || preferredStatus.available) {
    return {
      role,
      preferredAgent: preferred,
      selectedAgent: preferred,
      fallbackAgent: fallback,
      fallbackAllowed: fallbackPermitted,
      fallbackApplied: false,
      reason: preferred ? "preferred agent available" : "no preferred agent",
    };
  }

  if (!fallbackPermitted) {
    return {
      role,
      preferredAgent: preferred,
      selectedAgent: preferred,
      fallbackAgent: fallback,
      fallbackAllowed: false,
      fallbackApplied: false,
      reason: `preferred unavailable: ${preferredStatus.reason || "unknown"}; fallback forbidden by policy`,
    };
  }

  const fallbackStatus = availabilityFor(agentAvailability, fallback);
  if (fallback && fallbackStatus.available) {
    return {
      role,
      preferredAgent: preferred,
      selectedAgent: fallback,
      fallbackAgent: fallback,
      fallbackAllowed: true,
      fallbackApplied: true,
      reason: preferredStatus.reason || "preferred unavailable",
    };
  }

  return {
    role,
    preferredAgent: preferred,
    selectedAgent: preferred,
    fallbackAgent: fallback,
    fallbackAllowed: true,
    fallbackApplied: false,
    reason: `preferred unavailable: ${preferredStatus.reason || "unknown"}; fallback unavailable: ${fallbackStatus.reason || "missing"}`,
  };
}

export function healthToAvailability(agentHealth) {
  if (!agentHealth || typeof agentHealth !== "object") return null;
  const result = {};
  for (const [agent, health] of Object.entries(agentHealth)) {
    if (health === true) {
      result[agent] = { available: true };
    } else if (health === false) {
      result[agent] = { available: false, status: "unavailable", reason: "health check failed" };
    } else if (health && typeof health === "object") {
      const unavailable = health.healthy === false
        || ["unavailable", "offline", "rate_limited"].includes(health.status);
      result[agent] = unavailable
        ? { available: false, status: health.status || "unavailable", reason: health.reason || null }
        : { available: true };
    } else {
      result[agent] = { available: true };
    }
  }
  return result;
}

export function resolvePhaseAgentWithFallback({
  routing,
  phase,
  role,
  agentAvailability = null,
  agentHealth = null,
  teamPolicy = null,
}) {
  const effectiveRole = role || ROUTING_PHASE_ROLES[phase];
  if (!effectiveRole) {
    return {
      phase,
      role: null,
      preferredAgent: null,
      selectedAgent: null,
      fallbackAgent: null,
      fallbackAllowed: false,
      fallbackApplied: false,
      reason: "unknown phase or role",
    };
  }

  const availability = agentHealth
    ? { ...(agentAvailability || {}), ...healthToAvailability(agentHealth) }
    : agentAvailability;

  const selection = selectAgentWithFallback({
    role: effectiveRole,
    preferredAgent: agentForRoutingPhase(routing, phase, effectiveRole),
    fallbackAgent: fallbackAgentForRole(routing, effectiveRole),
    agentAvailability: availability,
    allowFallback: routing?.allowFallback !== false,
    policyAllowsFallback: teamPolicy?.routing?.allowFallback !== false,
  });

  return { ...selection, phase };
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
      const fallbackAgent = fallbackAgentForRole(rule, role);
      if (fallbackAgent && !isKnownAgent(fallbackAgent)) {
        errors.push(`routing rule ${category}.fallback.${role} references unknown agent: ${fallbackAgent}`);
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
