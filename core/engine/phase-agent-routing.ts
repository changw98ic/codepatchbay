import { resolvePhaseAgentWithFallback } from "../agents/routing.js";
import { resolveAllowedAgentNames, selectOutcomeAwareAgent } from "../agents/outcome-routing.js";
import { legacyAgentForPhase } from "../agents/registry.js";
import { highAssuranceAgentForRole, resolveHighAssurancePolicy } from "../policy/high-assurance.js";

import { isRecord, recordValue, type LooseRecord } from "../contracts/types.js";

type DynamicAgent = {
  selectedAgent: unknown;
  required: boolean;
};

type PhaseRoutingDecision = {
  phase?: string | null;
  role?: string | null;
  preferredAgent?: unknown;
  selectedAgent?: unknown;
  fallbackAgent?: unknown;
  fallbackAllowed?: unknown;
  fallbackApplied?: unknown;
  reason?: string | null;
  taskCategory?: string | null;
  selectionSource?: string | null;
  outcomeApplied?: boolean;
  independenceApplied?: boolean;
  independenceConflict?: boolean;
  agentPolicyApplied?: boolean;
  agentPolicyConflict?: boolean;
  allowedAgents?: string[] | null;
  excludedProviderFamily?: string | null;
  candidates?: unknown[];
  thresholds?: LooseRecord;
  metricsUnavailableReason?: string | null;
  staticSelectedAgent?: unknown;
  staticReason?: string | null;
  outcomeReason?: string | null;
};

type ResolvePhaseAgentRoutingInput = {
  agents?: LooseRecord | null;
  dynamicAgentPlan?: unknown;
  phaseSourceContext?: LooseRecord | null;
  sourceContext?: LooseRecord | null;
  routing?: LooseRecord | null;
  agentAvailability?: LooseRecord | null;
  agentHealth?: LooseRecord | null;
  teamPolicy?: LooseRecord | null;
  outcomeMetrics?: unknown;
  taskCategory?: string | null;
  excludedProviderFamily?: string | null;
  phase: string;
  role: string;
};

type ResolvePhaseAgentRoutingResult = {
  phaseAgents: LooseRecord;
  activeDynamicAgentPlan: LooseRecord | null;
  dynamicAgent: DynamicAgent | null;
  phaseRoutingDecision: PhaseRoutingDecision | null;
  effectiveSelectedAgent: unknown;
  allowedAgents: string[] | null;
};

function isPhaseRoutingDecision(value: unknown): value is PhaseRoutingDecision {
  return isRecord(value);
}

function normalizeDynamicAgentEntry(entry: unknown): DynamicAgent | null {
  if (!entry) return null;
  if (typeof entry === "string") {
    return { selectedAgent: entry, required: false };
  }
  const entryRecord = recordValue(entry);
  if (!Object.keys(entryRecord).length) return null;
  const selectedAgent = entryRecord.agent || entryRecord.name || entryRecord.selectedAgent || null;
  if (!selectedAgent) return null;
  const normalizedAgent = entryRecord.variant
    ? { agent: selectedAgent, variant: entryRecord.variant }
    : selectedAgent;
  return {
    selectedAgent: normalizedAgent,
    required: Boolean(entryRecord.required || entryRecord.requiredDynamicRole),
  };
}

export function resolveDynamicAgentPlan({
  dynamicAgentPlan,
  phaseSourceContext,
  sourceContext,
}: Pick<ResolvePhaseAgentRoutingInput, "dynamicAgentPlan" | "phaseSourceContext" | "sourceContext">): LooseRecord | null {
  const candidate = dynamicAgentPlan
    || phaseSourceContext?.dynamicAgentPlan
    || sourceContext?.dynamicAgentPlan
    || null;
  return isRecord(candidate) ? candidate : null;
}

function dynamicAgentForRole(plan: unknown, role: string, phase: string): DynamicAgent | null {
  const planRecord = recordValue(plan);
  const agentConfig = recordValue(planRecord.agentConfig || planRecord.agents);
  return normalizeDynamicAgentEntry(agentConfig[role] || agentConfig[phase]);
}

function nameOfAgent(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  const entry = recordValue(value);
  const name = entry.agent || entry.name || entry.selectedAgent;
  return typeof name === "string" && name ? name : null;
}

function routingMetricFailure(metrics: unknown): string | null {
  const value = recordValue(metrics);
  return typeof value.unavailableReason === "string" ? value.unavailableReason : null;
}

export function resolvePhaseAgentRouting({
  agents = {},
  dynamicAgentPlan = null,
  phaseSourceContext = null,
  sourceContext = null,
  routing = null,
  agentAvailability = null,
  agentHealth = null,
  teamPolicy = null,
  outcomeMetrics = {},
  taskCategory = null,
  excludedProviderFamily = null,
  phase,
  role,
}: ResolvePhaseAgentRoutingInput): ResolvePhaseAgentRoutingResult {
  const phaseAgents = { ...recordValue(agents) };
  const allowedAgents = resolveAllowedAgentNames(phaseSourceContext, sourceContext);
  const activeDynamicAgentPlan = resolveDynamicAgentPlan({
    dynamicAgentPlan,
    phaseSourceContext,
    sourceContext,
  });
  const assurancePolicy = resolveHighAssurancePolicy({
    agents,
    sourceContext: phaseSourceContext || sourceContext || {},
  });
  const assuranceAgent = highAssuranceAgentForRole(assurancePolicy, role);
  const dynamicAgent = assuranceAgent || dynamicAgentForRole(activeDynamicAgentPlan, role, phase);
  if (dynamicAgent?.selectedAgent) {
    phaseAgents[role] = dynamicAgent.selectedAgent;
  }

  const routingResult = routing
    ? resolvePhaseAgentWithFallback({
        routing,
        phase,
        role,
        agentAvailability,
        agentHealth,
        teamPolicy,
      })
    : null;
  const staticRoutingDecision = routingResult && isPhaseRoutingDecision(routingResult)
    ? {
        ...routingResult,
        phase: typeof routingResult.phase === "string" ? routingResult.phase : phase,
        role: typeof routingResult.role === "string" ? routingResult.role : role,
        reason: routingResult.reason === undefined || routingResult.reason === null ? null : String(routingResult.reason),
      }
    : null;

  if (!dynamicAgent?.selectedAgent && staticRoutingDecision?.selectedAgent) {
    phaseAgents[role] = staticRoutingDecision.selectedAgent;
  }

  const configuredAgent = phaseAgents[role] || legacyAgentForPhase(phase);
  const outcomePreferredAgent = dynamicAgent?.selectedAgent || staticRoutingDecision?.selectedAgent || configuredAgent;
  const tracePreferredAgent = staticRoutingDecision?.preferredAgent || outcomePreferredAgent;
  const selectionSource = assuranceAgent?.selectedAgent
    ? "high_assurance_policy"
    : dynamicAgent?.selectedAgent
    ? "dynamic_agent_plan"
    : staticRoutingDecision?.selectedAgent
      ? "static_routing"
      : phaseAgents[role]
        ? "configured_agent"
        : "legacy_default";
  const routingCandidates = [
    staticRoutingDecision?.fallbackAgent,
    phaseAgents[role],
    "codex",
    ...(role === "verifier" || role === "adversarial_verifier" ? ["claude"] : []),
    ...(allowedAgents || []),
  ];
  const outcomeDecision = selectOutcomeAwareAgent({
    preferredAgent: outcomePreferredAgent,
    candidateAgents: routingCandidates,
    allowedAgents,
    metrics: outcomeMetrics,
    role,
    locked: Boolean(dynamicAgent?.required),
    excludedProviderFamily,
  });
  const preferredName = nameOfAgent(outcomePreferredAgent);
  const selectedAgent = outcomeDecision.selectedAgent === preferredName
    ? outcomePreferredAgent
    : outcomeDecision.selectedAgent;
  if (selectedAgent) phaseAgents[role] = selectedAgent;
  else if (outcomeDecision.agentPolicyConflict) delete phaseAgents[role];

  const phaseRoutingDecision: PhaseRoutingDecision = {
    ...(staticRoutingDecision || {}),
    phase,
    role,
    preferredAgent: tracePreferredAgent,
    selectedAgent,
    fallbackAgent: staticRoutingDecision?.fallbackAgent || null,
    fallbackAllowed: staticRoutingDecision?.fallbackAllowed ?? null,
    fallbackApplied: staticRoutingDecision?.fallbackApplied ?? false,
    reason: outcomeDecision.applied || outcomeDecision.independenceApplied
      ? outcomeDecision.reason
      : staticRoutingDecision?.reason || outcomeDecision.reason,
    taskCategory,
    selectionSource,
    outcomeApplied: outcomeDecision.applied,
    independenceApplied: outcomeDecision.independenceApplied,
    independenceConflict: outcomeDecision.independenceConflict,
    agentPolicyApplied: outcomeDecision.agentPolicyApplied,
    agentPolicyConflict: outcomeDecision.agentPolicyConflict,
    allowedAgents,
    excludedProviderFamily: outcomeDecision.excludedProviderFamily,
    candidates: outcomeDecision.candidates,
    thresholds: outcomeDecision.thresholds,
    metricsUnavailableReason: routingMetricFailure(outcomeMetrics),
    staticSelectedAgent: staticRoutingDecision?.selectedAgent || null,
    staticReason: staticRoutingDecision?.reason || null,
    outcomeReason: outcomeDecision.reason,
  };
  const effectiveSelectedAgent = selectedAgent;

  return {
    phaseAgents,
    activeDynamicAgentPlan,
    dynamicAgent,
    phaseRoutingDecision,
    effectiveSelectedAgent,
    allowedAgents,
  };
}
