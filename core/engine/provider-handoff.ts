import type { LooseRecord } from "../../shared/types.js";
import { legacyAgentForPhase } from "../agents/registry.js";
import { recordValue } from "../contracts/types.js";
import { normalizeAllowedAgentNames, providerFamilyFor } from "../agents/outcome-routing.js";

type AgentObject = {
  agent?: string | null;
  name?: string | null;
  variant?: string | null;
};

export type ProviderAgent = string | AgentObject | null | undefined;
export type ProviderAgents = Record<string, ProviderAgent>;

export type ProviderPool = {
  execute?: (
    agent: string,
    prompt: string,
    cwd: string,
    timeoutMs: number,
    meta: LooseRecord,
  ) => Promise<unknown> | unknown;
  releaseWorktree?: (cwd: string, reason: string, options?: LooseRecord) => Promise<unknown> | unknown;
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

export type ProviderUnavailablePayload = {
  providerKey: string | null;
  agent: string | null;
  variant: string | null;
  status: string;
  nextEligibleAt: number;
  source: string;
  confidence: number;
  reason: string;
};

export type ProviderUsagePayload = {
  project: string | null;
  jobId: string | null;
  attemptId: string | null;
  taskCategory: string;
  issueNumber: string | number | null;
  source: string | null;
  attempt: unknown;
  retryCount: number;
  jobRetryCount: number;
  phaseRetryCount: number;
  isRetry: boolean;
  phase: string;
  role: string;
  providerKey: unknown;
  agent: string;
  variant: unknown;
  providerRegion: unknown;
  providerAdapter: unknown;
  status: string;
  phaseStatus: "passed" | "failed";
  failureKind: string | null;
  durationMs: unknown;
  quota: {
    status: unknown;
    source: unknown;
    confidence: unknown;
    nextEligibleAt: unknown;
    retryAfterMs: unknown;
    windowResetAt: unknown;
    weeklyResetAt: unknown;
    reason: unknown;
  };
  fallback: {
    used: boolean;
    fromProviderKey: unknown;
    toProviderKey: unknown;
    count: number;
    reason: unknown;
  };
  providerAttempts: unknown[] | null;
  usage: {
    calls: number;
    inputTokens: unknown;
    cachedInputTokens: unknown;
    outputTokens: unknown;
    reasoningOutputTokens: unknown;
    totalTokens: unknown;
    costUsd: unknown;
    tokenSource: unknown;
    toolCalls: unknown;
    functionCalls: unknown;
  };
};

export type ProviderServices = {
  assertProviderAvailable?: ((hubRoot: string, payload: ProviderAvailabilityPayload) => Promise<unknown> | unknown) | null;
  getProviderAdapter?: ((providerKey: string | null) => unknown) | null;
  delegateMarkProviderUnavailable?: ((hubRoot: string, payload: ProviderUnavailablePayload) => Promise<unknown> | unknown) | null;
  delegateEnqueueProviderUsage?: ((hubRoot: string, payload: ProviderUsagePayload) => Promise<unknown> | unknown) | null;
  readAgentRoutingMetrics?: ((hubRoot: string, query: LooseRecord) => Promise<unknown> | unknown) | null;
};

type FallbackCandidate = {
  providerKey: string;
  agent: string;
  variant?: string | null;
  providerFallback?: boolean;
};

export type ProviderPreflightResult = {
  available: boolean;
  switched: boolean;
  providerFallback?: boolean;
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

export function normalizeProviderServices(services: unknown = {}): ProviderServices {
  const source = recordValue(services);
  const providerQuota = recordValue(source.providerQuota);
  const providerAdapters = recordValue(source.providerAdapters);
  const quotaDelegate = recordValue(source.quotaDelegate);
  // retain: dynamic JSON boundary (services: unknown). `typeof === "function"` narrows to
  // `Function`, which TS cannot match to these specific call signatures; narrowing without `as`
  // would require a generic guard with `any` params (contravariant) — banned, any < as here.
  return {
    assertProviderAvailable:
      (typeof source.assertProviderAvailable === "function" ? source.assertProviderAvailable : null) as ProviderServices["assertProviderAvailable"] ||
      (typeof providerQuota.assertProviderAvailable === "function" ? providerQuota.assertProviderAvailable : null) as ProviderServices["assertProviderAvailable"],
    getProviderAdapter:
      (typeof source.getProviderAdapter === "function" ? source.getProviderAdapter : null) as ProviderServices["getProviderAdapter"] ||
      (typeof providerAdapters.getProviderAdapter === "function" ? providerAdapters.getProviderAdapter : null) as ProviderServices["getProviderAdapter"],
    delegateMarkProviderUnavailable:
      (typeof source.delegateMarkProviderUnavailable === "function" ? source.delegateMarkProviderUnavailable : undefined) as ProviderServices["delegateMarkProviderUnavailable"] ||
      (typeof quotaDelegate.delegateMarkProviderUnavailable === "function" ? quotaDelegate.delegateMarkProviderUnavailable : undefined) as ProviderServices["delegateMarkProviderUnavailable"],
    delegateEnqueueProviderUsage:
      (typeof source.delegateEnqueueProviderUsage === "function" ? source.delegateEnqueueProviderUsage : undefined) as ProviderServices["delegateEnqueueProviderUsage"] ||
      (typeof quotaDelegate.delegateEnqueueProviderUsage === "function" ? quotaDelegate.delegateEnqueueProviderUsage : undefined) as ProviderServices["delegateEnqueueProviderUsage"],
    readAgentRoutingMetrics:
      (typeof source.readAgentRoutingMetrics === "function" ? source.readAgentRoutingMetrics : null) as ProviderServices["readAgentRoutingMetrics"],
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
  excludeProviderFamily = null,
  allowedAgents = null,
}: {
  providerServices?: ProviderServices | null;
  hubRoot?: string | null;
  pool?: ProviderPool | null;
  phase: string;
  role: string;
  agents?: ProviderAgents | null;
  agent?: string | null;
  excludeProvider?: string | null;
  excludeProviderFamily?: string | null;
  allowedAgents?: unknown;
}): Promise<ProviderPreflightResult | null> {
  const assertProviderAvailable = providerServices?.assertProviderAvailable;
  if (typeof assertProviderAvailable !== "function" || !hubRoot) return null;

  const { agent: resolvedAgent, variant } = resolveRawAgent(agents, agent, role, phase);
  const providerKey = resolveProviderKey(pool, agents?.[role], agent);
  const normalizedAllowedAgents = normalizeAllowedAgentNames(allowedAgents);
  const allowedSet = normalizedAllowedAgents === null ? null : new Set(normalizedAllowedAgents);

  // Check preferred provider.
  const preferredFamily = providerFamilyFor(resolvedAgent, providerKey);
  if (
    (allowedSet === null || allowedSet.has(resolvedAgent))
    && providerKey !== excludeProvider
    && preferredFamily !== excludeProviderFamily
  ) {
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
        providerFallback: false,
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
    if (allowedSet !== null && !allowedSet.has(candidate.agent)) continue;
    if (excludeProviderFamily && providerFamilyFor(candidate.agent, candidate.providerKey) === excludeProviderFamily) {
      continue;
    }
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
        providerFallback: candidate.providerFallback === true,
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
    providerFallback: false,
    selectedAgent: null,
    selectedProviderKey: null,
    reason: normalizedAllowedAgents !== null
      ? `all allowed providers unavailable for ${role}; allowed agents ${normalizedAllowedAgents.join(",") || "none"}`
      : excludeProviderFamily
      ? `all independent providers unavailable for ${role}; excluded provider family ${excludeProviderFamily}`
      : `all providers unavailable for ${role}`,
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
      // retain: dynamic external pool callback returns unknown; only Array.isArray is checked here
      // and element shape is trusted (validated downstream by assertProviderAvailable). A deep-shape
      // guard would change runtime behavior by rejecting partial shapes, breaking parity.
      return Array.isArray(poolCandidates) ? poolCandidates as FallbackCandidate[] : [];
    } catch {
      return [];
    }
  }
  return [];
}
