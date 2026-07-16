import type { LooseRecord } from "../../shared/types.js";
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

export const ROUTING_PHASE_ROLES: Record<string, string> = Object.freeze({
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

type AgentSelectionOptions = {
  role?: string;
  preferredAgent?: string | null;
  fallbackAgent?: string | null;
  agentAvailability?: LooseRecord | null;
  allowFallback?: boolean;
  policyAllowsFallback?: boolean;
};

type PhaseAgentOptions = {
  routing?: LooseRecord | null;
  phase?: string;
  role?: string | null;
  agentAvailability?: LooseRecord | null;
  agentHealth?: LooseRecord | null;
  teamPolicy?: LooseRecord | null;
};

type RoutingValidationOptions = {
  isWorkflowName?: (workflow: string) => boolean;
};

function isRecord(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function routingRules(routing: LooseRecord): LooseRecord {
  if (!isRecord(routing)) return {};
  if (isRecord(routing.rules)) {
    return routing.rules;
  }
  return routing;
}

function defaultAgent(role: string): string {
  try {
    return defaultAgentForRole(role);
  } catch {
    return "codex";
  }
}

function isKnownAgent(name: string): boolean {
  if (!name) return true;
  try {
    return Boolean(getDescriptor(name));
  } catch {
    return BUILTIN_AGENT_NAMES.has(name);
  }
}

function normalizeCategory(category: string): string | null {
  const value = String(category || "").trim().toLowerCase();
  return CATEGORY_SET.has(value) ? value : null;
}

export function resolveRoutingForCategory(category: string, routing: LooseRecord): LooseRecord | null {
  const normalized = normalizeCategory(category);
  if (!normalized) return null;
  const rules = routingRules(routing);
  const rule = rules[normalized];
  if (!isRecord(rule)) return null;
  return {
    category: normalized,
    workflow: stringOrNull(rule.workflow),
    planner: stringOrNull(rule.planner),
    executor: stringOrNull(rule.executor),
    verifier: stringOrNull(rule.verifier),
    reviewer: stringOrNull(rule.reviewer),
    fallback: rule.fallback || null,
    allowFallback: rule.allowFallback !== false,
  };
}

export function defaultRoutingForCategory(category: string, { workflow = "standard" }: { workflow?: string } = {}): LooseRecord {
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

export function resolveEffectiveRouting(category: string, routing: LooseRecord, { workflow = "standard" }: LooseRecord = {}): LooseRecord {
  const resolved = resolveRoutingForCategory(category, routing);
  const workflowName = stringOrNull(workflow) || "standard";
  const defaults = defaultRoutingForCategory(category, { workflow: workflowName });
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

export function agentForRoutingPhase(routing: LooseRecord, phase: string, role: string | null = null): string | null {
  const resolvedRole = role || ROUTING_PHASE_ROLES[phase];
  return resolvedRole ? stringOrNull(routing?.[resolvedRole]) : null;
}

export function fallbackAgentForRole(routing: LooseRecord, role: string): string | null {
  const fallback = routing?.fallback;
  if (!fallback) return null;
  if (typeof fallback === "string") return fallback;
  if (isRecord(fallback)) {
    return stringOrNull(fallback[role]);
  }
  return null;
}

function availabilityFor(agentAvailability: LooseRecord | null, agent: string | null): LooseRecord {
  if (!agent || !isRecord(agentAvailability)) {
    return { available: true, reason: null };
  }
  const entry = agentAvailability[agent];
  if (entry === undefined) return { available: true, reason: null };
  if (entry === false) return { available: false, reason: "unavailable" };
  if (entry === true) return { available: true, reason: null };
  if (isRecord(entry)) {
    const status = typeof entry.status === "string" ? entry.status : "";
    return {
      available: entry.available !== false && !["unavailable", "rate_limited", "offline"].includes(status),
      reason: stringOrNull(entry.reason) || status || null,
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
}: AgentSelectionOptions = {}) {
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

export function healthToAvailability(agentHealth: LooseRecord | null): LooseRecord | null {
  if (!isRecord(agentHealth)) return null;
  const result: LooseRecord = {};
  for (const [agent, health] of Object.entries(agentHealth)) {
    if (health === true) {
      result[agent] = { available: true };
    } else if (health === false) {
      result[agent] = { available: false, status: "unavailable", reason: "health check failed" };
    } else if (isRecord(health)) {
      const healthRecord = health;
      const status = typeof healthRecord.status === "string" ? healthRecord.status : "";
      const unavailable = healthRecord.healthy === false
        || ["unavailable", "offline", "rate_limited"].includes(status);
      result[agent] = unavailable
        ? { available: false, status: status || "unavailable", reason: stringOrNull(healthRecord.reason) }
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
}: PhaseAgentOptions = {}) {
  const phaseName = phase || "";
  const effectiveRole = role || ROUTING_PHASE_ROLES[phaseName];
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
    ? { ...(agentAvailability || {}), ...(healthToAvailability(agentHealth) || {}) }
    : agentAvailability;
  const teamRouting = isRecord(teamPolicy?.routing) ? teamPolicy.routing : {};

  const selection = selectAgentWithFallback({
    role: effectiveRole,
    preferredAgent: routing ? agentForRoutingPhase(routing, phaseName, effectiveRole) : null,
    fallbackAgent: routing ? fallbackAgentForRole(routing, effectiveRole) : null,
    agentAvailability: availability,
    allowFallback: routing?.allowFallback !== false,
    policyAllowsFallback: teamRouting.allowFallback !== false,
  });

  return { ...selection, phase: phaseName };
}

export function validateRoutingRules(routing: LooseRecord, { isWorkflowName }: RoutingValidationOptions = {}) {
  const errors: string[] = [];
  const rules = routingRules(routing);

  for (const [category, rawRule] of Object.entries(rules)) {
    if (!CATEGORY_SET.has(category)) {
      errors.push(`unknown routing category: ${category}`);
      continue;
    }
    if (!isRecord(rawRule)) {
      errors.push(`routing rule for ${category} must be an object`);
      continue;
    }
    const rule = rawRule;

    const workflow = stringOrNull(rule.workflow);
    if (workflow && isWorkflowName && !isWorkflowName(workflow)) {
      errors.push(`routing rule ${category} references unknown workflow: ${rule.workflow}`);
    }

    for (const role of ROUTING_AGENT_ROLES) {
      const agent = stringOrNull(rule[role]);
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

export function assertValidRoutingRules(routing: LooseRecord, options: RoutingValidationOptions = {}) {
  const result = validateRoutingRules(routing, options);
  if (!result.valid) {
    throw new Error(`invalid routing rules: ${result.errors.join("; ")}`);
  }
  return result;
}
