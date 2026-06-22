import { resolvePhaseAgentWithFallback } from "../agents/routing.js";

type LooseRecord = Record<string, unknown>;

type DynamicAgent = {
  selectedAgent: unknown;
  required: boolean;
};

type PhaseRoutingDecision = {
  phase?: unknown;
  role?: unknown;
  preferredAgent?: unknown;
  selectedAgent?: unknown;
  fallbackAgent?: unknown;
  fallbackAllowed?: unknown;
  fallbackApplied?: unknown;
  reason?: unknown;
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
  phase: string;
  role: string;
};

type ResolvePhaseAgentRoutingResult = {
  phaseAgents: LooseRecord;
  activeDynamicAgentPlan: LooseRecord | null;
  dynamicAgent: DynamicAgent | null;
  phaseRoutingDecision: PhaseRoutingDecision | null;
  effectiveSelectedAgent: unknown;
};

function recordValue(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
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
  return (dynamicAgentPlan
    || phaseSourceContext?.dynamicAgentPlan
    || sourceContext?.dynamicAgentPlan
    || null) as LooseRecord | null;
}

function dynamicAgentForRole(plan: unknown, role: string, phase: string): DynamicAgent | null {
  const planRecord = recordValue(plan);
  const agentConfig = recordValue(planRecord.agentConfig || planRecord.agents);
  return normalizeDynamicAgentEntry(agentConfig[role] || agentConfig[phase]);
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
  phase,
  role,
}: ResolvePhaseAgentRoutingInput): ResolvePhaseAgentRoutingResult {
  const phaseAgents = { ...recordValue(agents) };
  const activeDynamicAgentPlan = resolveDynamicAgentPlan({
    dynamicAgentPlan,
    phaseSourceContext,
    sourceContext,
  });
  const dynamicAgent = dynamicAgentForRole(activeDynamicAgentPlan, role, phase);
  if (dynamicAgent?.selectedAgent) {
    phaseAgents[role] = dynamicAgent.selectedAgent;
  }

  const phaseRoutingDecision = routing
    ? resolvePhaseAgentWithFallback({
        routing,
        phase,
        role,
        agentAvailability,
        agentHealth,
        teamPolicy,
      }) as PhaseRoutingDecision
    : null;

  if (!dynamicAgent?.selectedAgent && phaseRoutingDecision?.selectedAgent) {
    phaseAgents[role] = phaseRoutingDecision.selectedAgent;
  }
  const effectiveSelectedAgent = dynamicAgent?.selectedAgent || phaseRoutingDecision?.selectedAgent || null;

  return {
    phaseAgents,
    activeDynamicAgentPlan,
    dynamicAgent,
    phaseRoutingDecision,
    effectiveSelectedAgent,
  };
}
