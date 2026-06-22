import { FailureKind, failure } from "../contracts/failure.js";
import { isPhasePassed, phaseFailed } from "../contracts/phase-result.js";
import {
  normalizeProviderServices,
  preflightProvider as defaultPreflightProvider,
  resolveProviderKey,
  ProviderAgent,
  ProviderAgents,
  ProviderServices,
} from "./provider-handoff.js";

type LooseRecord = Record<string, unknown>;

type QuotaFailure = {
  kind?: unknown;
  phase?: unknown;
  reason?: unknown;
  retryable?: unknown;
  cause?: unknown;
};

type PhaseResult = {
  status?: string;
  failure?: QuotaFailure | null;
  [key: string]: unknown;
};

type HandoffState = {
  count: number;
  from: string | null;
  to: string | null;
  reason: string | null;
};

type ProviderAttempt = {
  providerKey: string | null;
  agent: string | null;
  variant: string | null;
  status: string;
  at: string;
};

type ProviderPool = {
  providerKey?: (agent: string | null | undefined, variant: string | null) => string | null | undefined;
  fallbackCandidates?: (agent: string, currentVariant: string | null | undefined, excludeKey: string | null | undefined) => unknown;
  [key: string]: unknown;
};

type RunQuotaFallbackContext = {
  agent?: string | null;
  providerServices?: unknown;
  appendEvent?: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: (event: LooseRecord) => Promise<unknown> | unknown;
};

type RunQuotaFallbackState = {
  hubRoot?: string | null;
  pool?: ProviderPool | null;
  phase: string;
  role: string;
  nodeId: string;
  dagNode: LooseRecord;
  project: string;
  task: string;
  jobId: string;
  job: LooseRecord;
  workflow?: string;
  planMode?: string;
  cpbRoot: string;
  dataRoot?: string | null;
  sourcePath?: string | null;
  phaseSourceContext?: LooseRecord;
  state: LooseRecord;
  phaseResults: LooseRecord[];
  attemptId?: string | null;
  phaseTimeout: number;
  handoffState: HandoffState;
  providerAttempts: ProviderAttempt[];
  phaseAgents: ProviderAgents;
  result: PhaseResult;
};

type RunQuotaFallbackDeps = {
  maxHandoffs?: number;
  now?: () => string;
  nowMs?: () => number;
  runPhase?: (input: LooseRecord) => Promise<PhaseResult>;
  generateHandoffBundle?: (input: HandoffBundleInput) => Promise<unknown>;
  preflightProvider?: typeof defaultPreflightProvider;
};

const DEFAULT_HANDOFF_MAX_PER_PHASE = Number(process.env.CPB_PROVIDER_HANDOFF_MAX_PER_PHASE || 1);

type HandoffBundleInput = {
  project: string;
  jobId: string;
  phase: string;
  task: string;
  originProvider: string | null;
  failureReason: string;
  partialStdout: string;
  partialStderr: string;
  previousResults: LooseRecord[];
  cpbRoot: string;
  sourcePath: string | null | undefined;
};

function ts(now: () => string) {
  return now();
}

function recordValue(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function agentName(value: ProviderAgent): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.agent || value.name || null;
  return null;
}

function agentVariant(value: ProviderAgent): string | null {
  return value && typeof value === "object" ? value.variant || null : null;
}

async function reportProgress(ctx: RunQuotaFallbackContext, event: LooseRecord, now: () => string) {
  if (typeof ctx.onProgress !== "function") return;
  try {
    await ctx.onProgress({ ts: ts(now), ...event });
  } catch {
    // Progress reporting must not change job execution outcome.
  }
}

async function appendRuntimeEvent(
  ctx: RunQuotaFallbackContext,
  cpbRoot: string,
  project: string,
  jobId: string,
  event: LooseRecord,
) {
  if (typeof ctx.appendEvent !== "function") return;
  await ctx.appendEvent(cpbRoot, project, jobId, event);
}

export async function runQuotaFallbackRetry(
  ctx: RunQuotaFallbackContext,
  n: RunQuotaFallbackState,
  deps: RunQuotaFallbackDeps = {},
) {
  const {
    hubRoot, pool, phase, role, nodeId, dagNode, project, task, jobId, job,
    workflow, planMode, cpbRoot, dataRoot, sourcePath, phaseSourceContext = {},
    state, phaseResults, attemptId, phaseTimeout,
    handoffState, providerAttempts, phaseAgents,
  } = n;
  const providerServices = normalizeProviderServices(ctx.providerServices);
  const preflightProvider = deps.preflightProvider || defaultPreflightProvider;
  const now = deps.now || (() => new Date().toISOString());
  const nowMs = deps.nowMs || Date.now;
  const maxHandoffs = deps.maxHandoffs ?? DEFAULT_HANDOFF_MAX_PER_PHASE;
  let { result } = n;

  while (shouldAttemptQuotaFallback(result, handoffState, hubRoot, maxHandoffs)) {
    handoffState.count += 1;
    const fail = recordValue(result.failure);
    const quotaCause = recordValue(fail.cause);
    const quotaProviderKey = stringValue(quotaCause.providerKey);
    handoffState.from = handoffState.from || quotaProviderKey;
    handoffState.to = null;

    const activeAgent = phaseAgents[role];
    const failedProviderKey = quotaProviderKey || resolveProviderKey(pool, activeAgent, ctx.agent || null);
    const failedAgent = agentName(activeAgent);
    const failedVariant = agentVariant(activeAgent);
    let delegateFailure: unknown = null;
    try {
      if (typeof providerServices.delegateMarkProviderUnavailable !== "function") {
        throw Object.assign(new Error("quota delegate client unavailable; provider state not recorded"), {
          code: "QUOTA_DELEGATE_CLIENT_UNAVAILABLE",
        });
      }
      await providerServices.delegateMarkProviderUnavailable(hubRoot || "", {
        providerKey: failedProviderKey,
        agent: failedAgent,
        variant: failedVariant,
        status: stringValue(quotaCause.status) || "rate_limited",
        nextEligibleAt: typeof quotaCause.nextEligibleAt === "number" ? quotaCause.nextEligibleAt : nowMs() + 60_000,
        source: stringValue(quotaCause.source) || "run-job-handoff",
        confidence: typeof quotaCause.confidence === "number" ? quotaCause.confidence : 0.8,
        reason: String(fail.reason || ""),
      });
    } catch (err) {
      delegateFailure = err;
    }

    if (delegateFailure) {
      const err = delegateFailure as Error & { code?: string };
      result = phaseFailed({
        phase,
        failure: failure({
          kind: FailureKind.RUNTIME_INTERRUPTED,
          phase,
          reason: `quota delegate failure: ${err.message}`,
          retryable: true,
          cause: {
            code: err.code || "QUOTA_DELEGATE_WRITE_FAILED",
            providerKey: failedProviderKey,
            fallbackCount: handoffState.count,
            providerAttempts: providerAttempts.length > 0 ? providerAttempts : null,
          },
        }),
      }) as PhaseResult;
      break;
    }

    providerAttempts.push({
      providerKey: failedProviderKey,
      agent: failedAgent,
      variant: failedVariant,
      status: stringValue(quotaCause.status) || "rate_limited",
      at: ts(now),
    });

    const fallback = await preflightProvider({
      providerServices,
      hubRoot,
      pool,
      phase,
      role,
      agents: phaseAgents,
      agent: ctx.agent || null,
      excludeProvider: quotaProviderKey,
    }).catch((): null => null);

    if (!fallback || !fallback.available) {
      if (result.failure) {
        const nextCause = {
          ...recordValue(result.failure.cause),
          fallbackCount: handoffState.count,
          ...(providerAttempts.length > 0 ? { providerAttempts } : {}),
        };
        result.failure.cause = nextCause;
      }
      await appendRuntimeEvent(ctx, cpbRoot, project, jobId, {
        type: "provider_quota_blocked",
        jobId,
        project,
        phase,
        role,
        reason: "all fallback providers unavailable",
        ts: ts(now),
      });
      await reportProgress(ctx, {
        type: "provider_quota_blocked",
        jobId,
        project,
        phase,
        role,
        reason: "all fallback providers unavailable",
      }, now);
      break;
    }

    phaseAgents[role] = fallback.selectedAgent;
    handoffState.to = fallback.selectedProviderKey;
    handoffState.reason = String(fail.reason || "");
    result.failure!.cause = { ...recordValue(result.failure?.cause), fallbackCount: handoffState.count };

    await appendRuntimeEvent(ctx, cpbRoot, project, jobId, {
      type: "provider_handoff",
      jobId,
      project,
      phase,
      role,
      from: quotaProviderKey,
      to: fallback.selectedProviderKey,
      reason: String(fail.reason || ""),
      midRun: true,
      attempt: handoffState.count,
      ts: ts(now),
    });
    await reportProgress(ctx, {
      type: "provider_handoff",
      jobId,
      project,
      phase,
      role,
      from: quotaProviderKey,
      to: fallback.selectedProviderKey,
      reason: String(fail.reason || ""),
    }, now);

    let continuationContext: unknown = null;
    if (phase === "execute" && deps.generateHandoffBundle) {
      try {
        continuationContext = await deps.generateHandoffBundle({
          project,
          jobId,
          phase,
          task,
          originProvider: quotaProviderKey,
          failureReason: String(fail.reason || ""),
          partialStdout: String(quotaCause.stdout || ""),
          partialStderr: String(quotaCause.stderr || ""),
          previousResults: phaseResults,
          cpbRoot,
          sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
        });
      } catch {
        // Handoff bundle generation is best-effort.
      }
    }

    if (!deps.runPhase) {
      throw new Error("runPhase dependency is required for quota fallback retry");
    }
    result = await deps.runPhase({
      phase,
      role,
      nodeId,
      dagNode,
      project,
      task,
      jobId,
      job,
      workflow,
      planMode,
      cpbRoot,
      dataRoot,
      sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
      sourceContext: continuationContext
        ? { ...phaseSourceContext, handoff: continuationContext }
        : phaseSourceContext,
      pool,
      state,
      previousResults: phaseResults,
      agent: ctx.agent,
      agents: phaseAgents,
      attemptId,
      timeouts: {
        plan: phaseTimeout,
        execute: phaseTimeout,
        verify: phaseTimeout,
        adversarial_verify: phaseTimeout,
        review: phaseTimeout,
        remediate: phaseTimeout,
      },
    });
  }

  return result;
}

function shouldAttemptQuotaFallback(
  result: PhaseResult,
  handoffState: HandoffState,
  hubRoot: string | null | undefined,
  maxHandoffs: number,
) {
  return Boolean(
    hubRoot &&
    !isPhasePassed(result) &&
    result.failure?.kind === FailureKind.AGENT_RATE_LIMITED &&
    result.failure?.retryable &&
    recordValue(result.failure?.cause).hardGate !== true &&
    handoffState.count < maxHandoffs
  );
}
