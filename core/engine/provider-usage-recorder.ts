import { FailureKind } from "../contracts/failure.js";
import { isPhasePassed } from "../contracts/phase-result.js";
import {
  normalizeProviderServices,
  resolveProviderKey,
  resolveRawAgent,
  type ProviderAgents,
} from "./provider-handoff.js";

type ProviderPool = Parameters<typeof resolveProviderKey>[0];

type PhaseUsageOptions = {
  hardGateFailed?: boolean;
};

type PhaseUsageRecord = {
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

type PhaseFailure = {
  kind?: unknown;
  reason?: unknown;
  cause?: unknown;
};

type PhaseResult = {
  status?: string;
  diagnostics?: unknown;
  failure?: PhaseFailure | null;
};

type ProviderHandoffState = {
  count?: number | null;
  from?: string | null;
  to?: string | null;
  reason?: string | null;
};

type RecordPhaseProviderUsageInput = {
  providerServices?: unknown;
  hubRoot?: string | null;
  pool?: ProviderPool | null;
  agent?: string | null;
  phaseAgents?: ProviderAgents | null;
  project?: unknown;
  job?: unknown;
  phaseSourceContext?: unknown;
  phase: string;
  role: string;
  result: PhaseResult;
  handoffState?: ProviderHandoffState | null;
  providerAttempts?: unknown[] | null;
};

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function truthyOrNull(value: unknown) {
  return value || null;
}

function nullishOrNull(value: unknown) {
  return value ?? null;
}

function handoffCount(state: ProviderHandoffState | null | undefined) {
  return typeof state?.count === "number" ? state.count : 0;
}

export function normalizePhaseUsage(
  usage: unknown,
  { hardGateFailed = false }: PhaseUsageOptions = {},
): PhaseUsageRecord {
  if (hardGateFailed) {
    return {
      calls: 0,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      costUsd: null,
      tokenSource: "hard_gate",
      toolCalls: null,
      functionCalls: null,
    };
  }

  const usageRecord = recordValue(usage);
  return {
    calls: 1,
    inputTokens: nullishOrNull(usageRecord.inputTokens),
    cachedInputTokens: nullishOrNull(usageRecord.cachedInputTokens),
    outputTokens: nullishOrNull(usageRecord.outputTokens),
    reasoningOutputTokens: nullishOrNull(usageRecord.reasoningOutputTokens),
    totalTokens: nullishOrNull(usageRecord.totalTokens),
    costUsd: nullishOrNull(usageRecord.costUsd),
    tokenSource: usageRecord.tokenSource || "acp_not_reported",
    toolCalls: nullishOrNull(usageRecord.toolCalls),
    functionCalls: nullishOrNull(usageRecord.functionCalls),
  };
}

function usageStatusFor(result: PhaseResult, hardGateFailed: boolean, handoffUsed: boolean) {
  if (isPhasePassed(result)) return "ok";
  if (hardGateFailed) return "hard_gate_failed";
  if (result.failure?.kind === FailureKind.AGENT_RATE_LIMITED) return handoffUsed ? "fallback" : "rate_limited";
  if (result.failure?.kind === FailureKind.TIMEOUT) return "timeout";
  return "error";
}

function issueNumberFor(phaseSourceContext: unknown, job: unknown) {
  const sourceContext = recordValue(phaseSourceContext);
  const github = recordValue(sourceContext.github);
  const jobRecord = recordValue(job);
  return sourceContext.issueNumber ?? github.issueNumber ?? jobRecord.issueNumber ?? null;
}

export async function recordPhaseProviderUsage({
  providerServices: rawProviderServices,
  hubRoot,
  pool,
  agent,
  phaseAgents,
  project,
  job,
  phaseSourceContext,
  phase,
  role,
  result,
  handoffState,
  providerAttempts,
}: RecordPhaseProviderUsageInput): Promise<void> {
  if (!hubRoot) return;

  try {
    const providerServices = normalizeProviderServices(rawProviderServices);
    if (typeof providerServices.delegateEnqueueProviderUsage !== "function") return;

    const agents = phaseAgents || {};
    const { agent: resolvedAgent, variant } = resolveRawAgent(agents, agent, role, phase);
    const providerKey = resolveProviderKey(pool, agents[role], agent);
    const adapter = typeof providerServices.getProviderAdapter === "function"
      ? recordValue(providerServices.getProviderAdapter(providerKey))
      : {};
    const diag = recordValue(result.diagnostics);
    const failCause = recordValue(result.failure?.cause);
    const hardGateFailed = failCause.hardGate === true;
    const count = handoffCount(handoffState);
    const handoffUsed = count > 0;

    await providerServices.delegateEnqueueProviderUsage(hubRoot, {
      project: nullishOrNull(project),
      issueNumber: issueNumberFor(phaseSourceContext, job),
      source: truthyOrNull(recordValue(phaseSourceContext).source),
      attempt: nullishOrNull(recordValue(phaseSourceContext).attempt),
      phase,
      role,
      providerKey: diag.providerKey || providerKey,
      agent: diag.agent || resolvedAgent,
      variant: diag.variant || variant,
      providerRegion: truthyOrNull(adapter.region),
      providerAdapter: truthyOrNull(adapter.providerKeyPattern),
      status: usageStatusFor(result, hardGateFailed, handoffUsed),
      phaseStatus: isPhasePassed(result) ? "passed" : "failed",
      durationMs: nullishOrNull(diag.elapsedMs),
      quota: {
        status: truthyOrNull(failCause.status),
        source: truthyOrNull(failCause.source),
        confidence: nullishOrNull(failCause.confidence),
        nextEligibleAt: nullishOrNull(failCause.nextEligibleAt),
        retryAfterMs: nullishOrNull(failCause.retryAfterMs),
        windowResetAt: nullishOrNull(failCause.windowResetAt),
        weeklyResetAt: nullishOrNull(failCause.weeklyResetAt),
        reason: truthyOrNull(failCause.reason),
      },
      fallback: handoffUsed ? {
        used: true,
        fromProviderKey: handoffState?.from || failCause.providerKey || null,
        toProviderKey: handoffState?.to || diag.providerKey || providerKey,
        count,
        reason: handoffState?.reason || result.failure?.reason || null,
      } : {
        used: false,
        fromProviderKey: null,
        toProviderKey: null,
        count: 0,
        reason: null,
      },
      providerAttempts: Array.isArray(providerAttempts) && providerAttempts.length > 0 ? providerAttempts : null,
      usage: normalizePhaseUsage(diag.usage, { hardGateFailed }),
    });
  } catch {
    // Usage tracking is best-effort and must not change phase outcome.
  }
}
