import type { PhaseResult } from "../../shared/types.js";
import { phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { preflightProvider, type ProviderAgents } from "./provider-handoff.js";

type HandoffState = {
  count: number;
  from: string | null;
  to: string | null;
  reason: string | null;
};

import type { LooseRecord } from "../contracts/types.js";

type PreflightProviderServices = Parameters<typeof preflightProvider>[0]["providerServices"];
type PreflightPool = Parameters<typeof preflightProvider>[0]["pool"];

type RunProviderPreflightInput = {
  hubRoot: string | null | undefined;
  pool: PreflightPool;
  providerServices: PreflightProviderServices;
  cpbRoot: string;
  project: string;
  jobId: string;
  phase: string;
  role: string;
  phaseAgents: ProviderAgents;
  agent?: string | null;
  dynamicAgent: { required?: boolean } | null | undefined;
  excludeProviderFamily?: string | null;
  allowedAgents?: string[] | null;
  handoffState: HandoffState;
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  reportProgress: (event: LooseRecord) => Promise<void> | void;
  now: () => string;
};

/**
 * Provider pre-flight: check if preferred provider is available before
 * running the phase. May mutate `phaseAgents` (handoff), `handoffState`,
 * and emit provider_handoff / provider_quota_blocked events + progress.
 *
 * Returns null when pre-flight did not decide a result (caller runs the
 * phase). Returns a failed PhaseResult (AGENT_UNAVAILABLE or
 * AGENT_RATE_LIMITED) when pre-flight hard-blocks the provider.
 *
 * Extracted verbatim from runJobInner — no behavioural changes.
 */
export async function runProviderPreflight(input: RunProviderPreflightInput): Promise<PhaseResult | null> {
  const {
    hubRoot, pool, providerServices, cpbRoot, project, jobId, phase, role,
    phaseAgents, agent, dynamicAgent, excludeProviderFamily = null, allowedAgents = null,
    handoffState, appendEvent, reportProgress, now,
  } = input;

  if (!hubRoot || !pool) return null;

  const preflight = await preflightProvider({
    providerServices, hubRoot, pool, phase, role, agents: phaseAgents, agent,
    excludeProviderFamily,
    allowedAgents,
  }).catch((): null => null);
  if (preflight?.switched) {
    if (dynamicAgent?.required) {
      const result = phaseFailed({
        phase,
        failure: failure({
          kind: FailureKind.AGENT_UNAVAILABLE,
          phase,
          reason: `required dynamic agent unavailable for ${role}`,
          retryable: false,
          cause: {
            providerKey: preflight.from,
            selectedFallbackProviderKey: preflight.selectedProviderKey,
            role,
            phase,
            requiredDynamicRole: true,
            dynamicAgentPlan: true,
          },
        }),
      });
      await appendEvent(cpbRoot, project, jobId, {
        type: "provider_quota_blocked",
        jobId,
        project,
        phase,
        role,
        reason: result.failure!.reason,
        ts: now(),
      });
      await reportProgress({
        type: "provider_quota_blocked",
        jobId,
        project,
        phase,
        role,
        reason: result.failure!.reason,
      });
      return result;
    }
    phaseAgents[role] = preflight.selectedAgent;
    handoffState.count += 1;
    handoffState.from = preflight.from;
    handoffState.to = preflight.selectedProviderKey;
    handoffState.reason = preflight.reason;
    await appendEvent(cpbRoot, project, jobId, {
      type: "provider_handoff",
      jobId,
      project,
      phase,
      role,
      from: preflight.from,
      to: preflight.selectedProviderKey,
      reason: preflight.reason,
      ts: now(),
    });
    await reportProgress({
      type: "provider_handoff",
      jobId,
      project,
      phase,
      role,
      from: preflight.from,
      to: preflight.selectedProviderKey,
      reason: preflight.reason,
    });
    return null;
  }
  if (preflight && preflight.available === false) {
    const unavailableKind = dynamicAgent?.required
      ? FailureKind.AGENT_UNAVAILABLE
      : FailureKind.AGENT_RATE_LIMITED;
    const result = phaseFailed({
      phase,
      failure: failure({
        kind: unavailableKind,
        phase,
        reason: preflight.reason,
        retryable: false,
        cause: {
          providerKey: preflight.from,
          hardGate: true,
          role,
          requiredDynamicRole: Boolean(dynamicAgent?.required),
          dynamicAgentPlan: Boolean(dynamicAgent),
        },
      }),
    });
    await appendEvent(cpbRoot, project, jobId, {
      type: "provider_quota_blocked",
      jobId,
      project,
      phase,
      role,
      reason: preflight.reason,
      ts: now(),
    });
    await reportProgress({
      type: "provider_quota_blocked",
      jobId,
      project,
      phase,
      role,
      reason: preflight.reason,
    });
    return result;
  }
  return null;
}
