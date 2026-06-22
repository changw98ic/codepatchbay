import { legacyAgentForPhase } from "../agents/registry.js";

type AgentObject = {
  agent?: string | null;
  name?: string | null;
  variant?: string | null;
};

export type ProviderAgent = string | AgentObject | null | undefined;
export type ProviderAgents = Record<string, ProviderAgent>;

type ProviderPool = {
  providerKey?: (agent: string | null | undefined, variant: string | null) => string | null | undefined;
  fallbackCandidates?: (
    agent: string,
    currentVariant: string | null | undefined,
    excludeKey: string | null | undefined
  ) => unknown;
};

type ProviderAvailabilityPayload = {
  providerKey: string | null;
  agent: string;
  variant: string | null;
  phase: string;
  role: string;
};

export type ProviderServices = {
  assertProviderAvailable?: ((hubRoot: string, payload: ProviderAvailabilityPayload) => Promise<unknown> | unknown) | null;
  getProviderAdapter?: ((providerKey: string | null) => unknown) | null;
  delegateMarkProviderUnavailable?: ((hubRoot: string, payload: Record<string, unknown>) => Promise<unknown> | unknown) | null;
  delegateEnqueueProviderUsage?: ((hubRoot: string, payload: Record<string, unknown>) => Promise<unknown> | unknown) | null;
};

type FallbackCandidate = {
  providerKey: string;
  agent: string;
  variant?: string | null;
};

export type ProviderPreflightResult = {
  available: boolean;
  switched: boolean;
  selectedAgent: ProviderAgent;
  selectedProviderKey: string | null;
  reason: string | null;
  from: string | null;
};

export function resolveRawAgent(
  agents: ProviderAgents | null | undefined,
  agent: string | null | undefined,
  role: string,
  phase: string,
): { agent: string; variant: string | null } {
  const raw = agents?.[role] || agent || legacyAgentForPhase(phase);
  if (typeof raw === "object" && raw !== null) {
    return {
      agent: raw.agent || raw.name || legacyAgentForPhase(phase),
      variant: raw.variant || null,
    };
  }
  return { agent: typeof raw === "string" ? raw : legacyAgentForPhase(phase), variant: null };
}

export function resolveProviderKey(
  pool: ProviderPool | null | undefined,
  rawAgent: ProviderAgent,
  defaultAgent: string | null | undefined,
): string | null {
  let selectedAgent: string | null | undefined;
  let variant: string | null;
  if (typeof rawAgent === "object" && rawAgent !== null) {
    selectedAgent = rawAgent.agent || defaultAgent;
    variant = rawAgent.variant || null;
  } else {
    selectedAgent = typeof rawAgent === "string" ? rawAgent : defaultAgent;
    variant = null;
  }
  if (pool?.providerKey) return pool.providerKey(selectedAgent, variant) || null;
  if (variant && selectedAgent === "claude") return `claude:${variant}`;
  return selectedAgent || null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function normalizeProviderServices(services: unknown = {}): ProviderServices {
  const source = recordValue(services);
  const providerQuota = recordValue(source.providerQuota);
  const providerAdapters = recordValue(source.providerAdapters);
  const quotaDelegate = recordValue(source.quotaDelegate);
  return {
    assertProviderAvailable:
      (typeof source.assertProviderAvailable === "function" ? source.assertProviderAvailable : null) as ProviderServices["assertProviderAvailable"] ||
      (typeof providerQuota.assertProviderAvailable === "function" ? providerQuota.assertProviderAvailable : null) as ProviderServices["assertProviderAvailable"],
    getProviderAdapter:
      (typeof source.getProviderAdapter === "function" ? source.getProviderAdapter : null) as ProviderServices["getProviderAdapter"] ||
      (typeof providerAdapters.getProviderAdapter === "function" ? providerAdapters.getProviderAdapter : null) as ProviderServices["getProviderAdapter"],
    delegateMarkProviderUnavailable:
      (typeof source.delegateMarkProviderUnavailable === "function" ? source.delegateMarkProviderUnavailable : null) as ProviderServices["delegateMarkProviderUnavailable"] ||
      (typeof quotaDelegate.delegateMarkProviderUnavailable === "function" ? quotaDelegate.delegateMarkProviderUnavailable : null) as ProviderServices["delegateMarkProviderUnavailable"],
    delegateEnqueueProviderUsage:
      (typeof source.delegateEnqueueProviderUsage === "function" ? source.delegateEnqueueProviderUsage : null) as ProviderServices["delegateEnqueueProviderUsage"] ||
      (typeof quotaDelegate.delegateEnqueueProviderUsage === "function" ? quotaDelegate.delegateEnqueueProviderUsage : null) as ProviderServices["delegateEnqueueProviderUsage"],
  };
}

export async function preflightProvider({
  providerServices,
  hubRoot,
  pool,
  phase,
  role,
  agents,
  agent,
  excludeProvider = null,
}: {
  providerServices?: ProviderServices | null;
  hubRoot?: string | null;
  pool?: ProviderPool | null;
  phase: string;
  role: string;
  agents?: ProviderAgents | null;
  agent?: string | null;
  excludeProvider?: string | null;
}): Promise<ProviderPreflightResult | null> {
  const assertProviderAvailable = providerServices?.assertProviderAvailable;
  if (typeof assertProviderAvailable !== "function" || !hubRoot) return null;

  const { agent: resolvedAgent, variant } = resolveRawAgent(agents, agent, role, phase);
  const providerKey = resolveProviderKey(pool, agents?.[role], agent);

  // Check preferred provider.
  if (providerKey !== excludeProvider) {
    try {
      await assertProviderAvailable(hubRoot, {
        providerKey,
        agent: resolvedAgent,
        variant,
        phase,
        role,
      });
      return {
        available: true,
        switched: false,
        selectedAgent: agents?.[role] || agent,
        selectedProviderKey: providerKey,
        reason: null,
        from: providerKey,
      };
    } catch {
      // Preferred is unavailable; try fallbacks below.
    }
  }

  for (const candidate of getFallbackCandidates(pool, resolvedAgent, variant, excludeProvider || providerKey)) {
    try {
      await assertProviderAvailable(hubRoot, {
        providerKey: candidate.providerKey,
        agent: candidate.agent,
        variant: candidate.variant || null,
        phase,
        role,
      });
      const selectedAgent = candidate.variant
        ? { agent: candidate.agent, variant: candidate.variant }
        : candidate.agent;
      return {
        available: true,
        switched: candidate.providerKey !== providerKey,
        selectedAgent,
        selectedProviderKey: candidate.providerKey,
        reason: `fallback from ${providerKey}`,
        from: providerKey,
      };
    } catch {
      continue;
    }
  }

  return {
    available: false,
    switched: false,
    selectedAgent: null,
    selectedProviderKey: null,
    reason: `all providers unavailable for ${role}`,
    from: providerKey,
  };
}

function getFallbackCandidates(
  pool: ProviderPool | null | undefined,
  agent: string,
  currentVariant: string | null | undefined,
  excludeKey: string | null | undefined,
) {
  if (pool?.fallbackCandidates) {
    try {
      const poolCandidates = pool.fallbackCandidates(agent, currentVariant, excludeKey);
      return Array.isArray(poolCandidates) ? poolCandidates as FallbackCandidate[] : [];
    } catch {
      return [];
    }
  }
  return [];
}
