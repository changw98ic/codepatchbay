import { PhaseResult } from "../../shared/types.js";
import { isPhasePassed } from "../contracts/phase-result.js";
import { emitDiagnosticArtifactEvents } from "./runtime-artifact-events.js";
import { evaluatePoisonedSessionGate } from "./poisoned-session-gate.js";
import { trackPassedPhaseArtifact } from "./phase-artifact-tracker.js";
import { emitDagNodeCompletedEvent } from "./dag-node-lifecycle-events.js";
import { emitAdversarialVerdictEvent } from "./adversarial-verdict-events.js";
import { emitPhaseResultEvent } from "./phase-result-events.js";
import { recordPhaseProviderUsage } from "./provider-usage-recorder.js";
import { preflightProvider, type ProviderAgents } from "./provider-handoff.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";

type PreflightProviderServices = Parameters<typeof preflightProvider>[0]["providerServices"];
type PreflightPool = Parameters<typeof preflightProvider>[0]["pool"];

/**
 * Narrows a value to LooseRecord. Mirrors the prior
 * `typeof rawAgent === "object" && rawAgent !== null` test exactly (arrays still
 * match) so the agent-name resolution branch keeps identical runtime behaviour.
 */
function isRecordValue(value: unknown): value is LooseRecord {
  return value !== null && typeof value === "object";
}

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

type CompletePhase = (
  cpbRoot: string,
  project: string,
  jobId: string,
  payload: { phase: string; artifact: unknown },
) => Promise<unknown> | unknown;

type FinalizePhaseResultInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  task: string;
  phase: string;
  role: string;
  nodeId: string;
  dagNode: LooseRecord;
  attemptId: string | null | undefined;
  phaseResults: PhaseResult[];
  state: LooseRecord;
  phaseAgents: ProviderAgents;
  result: PhaseResult;
  agent: string | null;
  providerServices: PreflightProviderServices;
  hubRoot: string | null | undefined;
  pool: PreflightPool;
  job: LooseRecord;
  phaseSourceContext: LooseRecord;
  handoffState: HandoffState;
  providerAttempts: ProviderAttempt[];
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  completePhase: CompletePhase;
  now: () => string;
  legacyAgentForPhase: (phase: string) => string;
  phaseRoutingDecision?: LooseRecord | null;
  readArtifactFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
};

/**
 * Phase finalization: push result, emit diagnostic/adversarial/result
 * events, re-evaluate poisoned-session gate (re-assigning `result`),
 * track passed artifact, emit DAG-node-completed event, and record
 * provider usage.
 *
 * Returns the (possibly poisoned-gate-updated) result. Caller retains the
 * post-finalize control-flow decisions (isPhasePassed -> handleDagNodeFailure).
 *
 * Extracted verbatim from runJobInner — no behavioural changes.
 */
export async function finalizePhaseResult(input: FinalizePhaseResultInput): Promise<PhaseResult> {
  const {
    cpbRoot, project, jobId, task, phase, role, nodeId, dagNode, attemptId,
    phaseResults, state, phaseAgents, result: inResult,
    agent, providerServices, hubRoot, pool, job, phaseSourceContext,
    handoffState, providerAttempts, appendEvent, onProgress, completePhase,
    now, legacyAgentForPhase, phaseRoutingDecision = null, readArtifactFile,
  } = input;

  let result: PhaseResult = inResult;

  phaseResults.push(result);
  const phaseResultIndex = phaseResults.length - 1;

  await emitDiagnosticArtifactEvents({
    cpbRoot,
    project,
    jobId,
    phase,
    phaseResult: result,
    appendEvent,
    attemptId,
    now,
  });

  // Resolve agent name for this phase (use potentially handoff-modified phaseAgents)
  const rawAgent = phaseAgents[role] || agent || legacyAgentForPhase(phase);
  const agentName = isRecordValue(rawAgent)
    ? String(rawAgent.agent || rawAgent.name || legacyAgentForPhase(phase))
    : String(rawAgent || legacyAgentForPhase(phase));

  result = await evaluatePoisonedSessionGate({
    cpbRoot, project, jobId, phase, nodeId, attemptId, result, appendEvent,
    ...(readArtifactFile ? { readFile: readArtifactFile } : {}),
    now,
  });
  phaseResults[phaseResultIndex] = result;

  await trackPassedPhaseArtifact({
    cpbRoot,
    project,
    jobId,
    phase,
    state,
    phaseResult: result,
    completePhase,
  });

  if (isPhasePassed(result)) {
    await emitDagNodeCompletedEvent({
      cpbRoot,
      jobId,
      project,
      nodeId,
      phase,
      role,
      attemptId,
      artifactName: result.artifact?.name || null,
      dagNode,
      appendEvent,
      now,
    });
  }

  await emitAdversarialVerdictEvent({
    cpbRoot,
    project,
    jobId,
    phase,
    phaseResult: result,
    appendEvent,
    now,
  });

  await emitPhaseResultEvent({
    cpbRoot,
    project,
    jobId,
    phase,
    agentName,
    phaseResult: result,
    attemptId: attemptId || null,
    appendEvent,
    onProgress,
    now,
  });

  await recordPhaseProviderUsage({
    providerServices,
    hubRoot,
    pool,
    agent,
    phaseAgents,
    project,
    job,
    jobId,
    attemptId: attemptId || null,
    task,
    phaseSourceContext,
    phase,
    role,
    result,
    handoffState,
    providerAttempts,
  });

  if (phaseRoutingDecision) {
    const diagnostics = recordValue(result.diagnostics);
    const phaseAgentFallback = recordValue(diagnostics.phaseAgentFallback);
    const phaseAgentFallbackCount = Number.isFinite(Number(phaseAgentFallback.count))
      ? Math.max(0, Number(phaseAgentFallback.count))
      : 0;
    await appendEvent(cpbRoot, project, jobId, {
      type: "agent_routing_result",
      jobId,
      project,
      phase,
      role,
      attemptId: attemptId || null,
      preferredAgent: phaseRoutingDecision.preferredAgent,
      selectedAgent: phaseRoutingDecision.selectedAgent,
      finalAgent: diagnostics.agent || agentName,
      providerKey: diagnostics.providerKey || null,
      status: result.status,
      failureKind: result.failure?.kind || null,
      fallbackApplied: handoffState.count > 0
        || phaseAgentFallback.applied === true
        || phaseRoutingDecision.fallbackApplied === true,
      fallbackCount: handoffState.count + phaseAgentFallbackCount,
      fallbackFromAgent: phaseAgentFallback.fromAgent || handoffState.from || null,
      fallbackToAgent: phaseAgentFallback.toAgent || handoffState.to || null,
      fallbackReason: phaseAgentFallback.reason || handoffState.reason || null,
      routingReason: phaseRoutingDecision.reason || null,
      allowedAgents: phaseRoutingDecision.allowedAgents || null,
      agentPolicyConflict: phaseRoutingDecision.agentPolicyConflict === true,
      independenceConflict: phaseRoutingDecision.independenceConflict === true,
      ts: now(),
    });
  }

  return result;
}
