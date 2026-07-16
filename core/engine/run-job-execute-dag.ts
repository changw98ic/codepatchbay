import { runPhase } from "./run-phase.js";
import type { PhaseResult } from "../../shared/types.js";
import { isPhasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { legacyAgentForPhase } from "../agents/registry.js";
import { generateHandoffBundle } from "../handoff/handoff-bundle.js";
import { normalizeProviderServices, type ProviderAgents } from "./provider-handoff.js";
import { runQuotaFallbackRetry } from "./provider-quota-fallback.js";
import { runProviderPreflight } from "./provider-preflight.js";
import { finalizePhaseResult } from "./phase-finalize-events.js";
import { runPhaseRetryLoops } from "./phase-retry.js";
import { handleDagNodeFailure } from "./dag-node-failure.js";
import { evaluateExecuteScopeGuard } from "./scope-guard-runner.js";
import { runCompletionGate } from "./completion-gate-runner.js";
import { emitPhaseStartEvents } from "./phase-start-events.js";
import { handleResumeCompletedDagNode } from "./dag-node-resume.js";
import { resolvePhaseAgentRouting } from "./phase-agent-routing.js";
import { resolveAgentPhaseTimeoutMs } from "../policy/phase-budget.js";
import { resolveHighAssurancePolicy } from "../policy/high-assurance.js";
import { buildConversationKey } from "../agents/conversation-key.js";
import { classifyRoutingTaskCategory, providerFamilyFor } from "../agents/outcome-routing.js";
import {
  completionGateFailureFingerprint,
  completionGateFeedbackFromFailure,
  completionGateRepairLimit,
  completionGateRepairSourceContext,
  bindVerificationFeedbackToFrozenScope,
  isRecoverableVerificationInfrastructureFailure,
  isRepairableVerificationFailure,
  solverRepairLimit,
  solverRepairSourceContext,
  verificationInfrastructureFeedbackFromResult,
  verificationInfrastructureFailureFingerprint,
  verificationInfrastructureRetryLimit,
  verificationInfrastructureRetrySourceContext,
  verificationFeedbackFromResult,
  verificationFailureFingerprint,
} from "./solver-loop.js";
import {
  recoveredArtifactForPhase,
  recoveredVerdictForPhase,
  type WorkflowDag,
  type WorkflowDagNode,
} from "./run-job-planning.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";
import {
  reportProgress,
  ts,
  type CompleteJob,
  type CompletePhase,
  type FailJob,
  type JobRunResult,
  type ProgressReporter,
  type ProviderPool,
} from "./run-job-shared.js";

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

type ExecuteWorkflowDagContext = LooseRecord & {
  cpbRoot: string;
  hubRoot?: string;
  project: string;
  task: string;
  workflow?: string;
  planMode?: string;
  sourcePath?: string;
  sourceContext?: LooseRecord;
  dataRoot?: string;
  timeoutMin?: number;
  startPhase?: (cpbRoot: string, project: string, jobId: string, payload: LooseRecord) => Promise<unknown> | unknown;
  completePhase: CompletePhase;
  completeJob: CompleteJob;
  failJob: FailJob;
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  getPool: () => ProviderPool | null | undefined;
  onProgress?: ProgressReporter | null;
  providerServices?: unknown;
  agent?: string | null;
  agents?: ProviderAgents;
  dynamicAgentPlan?: unknown;
  routing?: LooseRecord | null;
  agentAvailability?: LooseRecord | null;
  agentHealth?: LooseRecord | null;
  teamPolicy?: LooseRecord | null;
  getArtifactIndex?: unknown;
  _currentPhase?: string | null;
};

type ExecuteWorkflowDagInput = {
  job: LooseRecord;
  jobId: string;
  attemptId: string | null | undefined;
  riskMap: unknown;
  phaseSourceContext: LooseRecord;
  dynamicAgentPlan: unknown;
  workflowDag: WorkflowDag;
  executionNodes: WorkflowDagNode[];
  dagResumeContext: { completedNodeIds: string[]; resumeTarget: LooseRecord | null };
  resumeCompletedNodes: Set<string>;
  phaseRoleMap: Record<string, string>;
};

/** Values shared across all DAG nodes within a single executeWorkflowDag run. */
type DagRunSession = {
  ctx: ExecuteWorkflowDagContext;
  cpbRoot: string;
  hubRoot?: string;
  project: string;
  task: string;
  job: LooseRecord;
  jobId: string;
  attemptId: string | null | undefined;
  riskMap: unknown;
  phaseSourceContext: LooseRecord;
  dynamicAgentPlan: unknown;
  workflow: string;
  planMode: string;
  sourcePath: string | undefined;
  dataRoot: string | undefined;
  phaseTimeout: number;
  phaseTimeouts: Record<string, number>;
  providerServices: ReturnType<typeof normalizeProviderServices>;
  pool: ProviderPool | null | undefined;
  state: LooseRecord;
  phaseResults: PhaseResult[];
  phaseRoleMap: Record<string, string>;
  resumeCompletedNodes: Set<string>;
  dagResumeContext: { completedNodeIds: string[]; resumeTarget: LooseRecord | null };
};

type DagNodeRunOutcome = {
  terminal: JobRunResult | null;
  result: PhaseResult | null;
  deferredVerificationFailure: boolean;
  phase: string;
  role: string;
  nodeId: string;
  dagNode: WorkflowDagNode;
};

type RunDagNodeOptions = {
  deferVerificationFailure?: boolean;
  ignoreResume?: boolean;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiresIndependentVerification(session: DagRunSession, phase: string, role: string): boolean {
  if (role !== "verifier" && role !== "adversarial_verifier" && phase !== "verify" && phase !== "adversarial_verify") {
    return false;
  }
  const risk = recordValue(session.riskMap);
  const plan = recordValue(session.dynamicAgentPlan);
  const assurancePolicy = resolveHighAssurancePolicy({ sourceContext: session.phaseSourceContext });
  return risk.riskLevel === "high"
    || risk.riskLevel === "critical"
    || risk.adversarialRequired === true
    || plan.independentVerifierRequired === true
    || (assurancePolicy.enabled
      && assurancePolicy.verification.required
      && assurancePolicy.verification.independent);
}

function executorProviderFamily(session: DagRunSession): string | null {
  const executeResult = [...session.phaseResults]
    .reverse()
    .find((result) => result.phase === "execute" || result.phase === "remediate");
  const diagnostics = recordValue(executeResult?.diagnostics);
  const providerKey = typeof diagnostics.providerKey === "string" ? diagnostics.providerKey : null;
  const diagnosticAgent = typeof diagnostics.agent === "string" ? diagnostics.agent : null;
  if (providerKey || diagnosticAgent) return providerFamilyFor(diagnosticAgent, providerKey);

  const planAgents = recordValue(recordValue(session.dynamicAgentPlan).agentConfig);
  const configuredExecutor = planAgents.executor || session.ctx.agents?.executor || session.ctx.agent || null;
  if (!configuredExecutor) return null;
  return providerFamilyFor(configuredExecutor);
}

async function loadOutcomeRoutingMetrics(
  session: DagRunSession,
  query: { phase: string; role: string; taskCategory: string },
): Promise<unknown> {
  const readMetrics = session.providerServices.readAgentRoutingMetrics;
  if (typeof readMetrics !== "function") {
    return { unavailableReason: "agent routing metrics service unavailable", agents: {} };
  }
  if (!session.hubRoot) {
    return { unavailableReason: "hub root unavailable for agent routing metrics", agents: {} };
  }
  try {
    return await readMetrics(session.hubRoot, query);
  } catch (error) {
    return {
      unavailableReason: error instanceof Error ? error.message : String(error),
      agents: {},
    };
  }
}

/**
 * Short-circuit a DAG node that was already completed in a prior run: replay
 * its recovered artifact/verdict into the session and emit the skip event.
 * Returns true when the node was resumed (caller should `continue`).
 */
async function tryResumeCompletedNode(
  session: DagRunSession,
  dagNode: WorkflowDagNode,
  opts: { phase: string; nodeId: string; role: string },
): Promise<boolean> {
  if (!session.resumeCompletedNodes.has(opts.nodeId)) return false;
  const { cpbRoot, project, jobId, dataRoot, phaseSourceContext, state, phaseResults, ctx, dagResumeContext } = session;
  const artifact = recoveredArtifactForPhase(phaseSourceContext, opts.phase, { cpbRoot, project, dataRoot });
  await handleResumeCompletedDagNode({
    cpbRoot,
    project,
    jobId,
    nodeId: opts.nodeId,
    phase: opts.phase,
    role: opts.role,
    dagNode,
    artifact,
    verdict: recoveredVerdictForPhase(phaseSourceContext, opts.phase),
    resumeTarget: dagResumeContext.resumeTarget,
    state,
    phaseResults,
    appendEvent: ctx.appendEvent,
    onProgress: ctx.onProgress || null,
    now: ts,
  });
  return true;
}

/**
 * Run provider preflight, then (if preflight did not already produce a result)
 * run the phase itself. Returns the PhaseResult from either source, exactly as
 * the original inline `result ||= await runPhase(...)` sequence did.
 */
async function preflightAndRunPhase(
  session: DagRunSession,
  n: {
    phase: string;
    role: string;
    nodeId: string;
    dagNode: WorkflowDagNode;
    phaseAgents: ProviderAgents;
    dynamicAgent: unknown;
    excludeProviderFamily: string | null;
    allowedAgents: string[] | null;
    handoffState: HandoffState;
  },
): Promise<PhaseResult> {
  const { ctx, hubRoot, pool, providerServices, cpbRoot, project, jobId, task, job, workflow, planMode, dataRoot, sourcePath, phaseSourceContext, state, phaseResults, attemptId, phaseTimeouts } = session;
  let result: PhaseResult | null = await runProviderPreflight({
    hubRoot, pool, providerServices, cpbRoot, project, jobId, phase: n.phase, role: n.role,
    phaseAgents: n.phaseAgents, agent: ctx.agent, dynamicAgent: n.dynamicAgent ? { required: Boolean(recordValue(n.dynamicAgent).required) } : null,
    excludeProviderFamily: n.excludeProviderFamily, allowedAgents: n.allowedAgents, handoffState: n.handoffState,
    appendEvent: ctx.appendEvent,
    reportProgress: (event) => reportProgress(ctx, event),
    now: ts,
  });

  result ||= await runPhase({
    phase: n.phase,
    role: n.role,
    nodeId: n.nodeId,
    dagNode: n.dagNode,
    project,
    task,
    jobId,
    job,
    workflow,
    planMode,
    cpbRoot,
    dataRoot,
    sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
    sourceContext: phaseSourceContext,
    pool,
    state,
    previousResults: phaseResults,
    agent: ctx.agent,
    agents: n.phaseAgents,
    attemptId,
    conversationKey: buildConversationKey({ project, jobId, attemptId, role: n.role }),
    timeouts: phaseTimeouts,
    onProgress: ctx.onProgress || null,
  });

  return result;
}

/**
 * Run quota-driven provider fallback (handoff/retry across providers), then
 * stamp any handoff count + provider attempts back onto the failure cause.
 */
async function applyQuotaFallback(
  session: DagRunSession,
  n: {
    phase: string;
    role: string;
    nodeId: string;
    dagNode: WorkflowDagNode;
    phaseAgents: ProviderAgents;
    handoffState: HandoffState;
    providerAttempts: ProviderAttempt[];
    result: PhaseResult;
    excludeProviderFamily: string | null;
    allowedAgents: string[] | null;
  },
): Promise<PhaseResult> {
  const { ctx, hubRoot, pool, project, task, jobId, job, workflow, planMode, cpbRoot, dataRoot, sourcePath, phaseSourceContext, state, phaseResults, attemptId, phaseTimeout } = session;
  let result = await runQuotaFallbackRetry({
    agent: ctx.agent,
    providerServices: ctx.providerServices,
    appendEvent: ctx.appendEvent,
    onProgress: ctx.onProgress || undefined,
  }, {
    hubRoot, pool, phase: n.phase, role: n.role, nodeId: n.nodeId, dagNode: n.dagNode, project, task, jobId, job,
    workflow, planMode, cpbRoot, dataRoot, sourcePath, phaseSourceContext,
    state, phaseResults, attemptId, phaseTimeout,
    handoffState: n.handoffState, providerAttempts: n.providerAttempts, phaseAgents: n.phaseAgents, result: n.result,
    excludeProviderFamily: n.excludeProviderFamily, allowedAgents: n.allowedAgents,
  }, {
    runPhase: runPhase,
    generateHandoffBundle,
  });

  if (n.handoffState.count > 0 && result.failure?.cause) {
    const cause = recordValue(result.failure.cause);
    result.failure.cause = { ...cause, fallbackCount: n.handoffState.count };
    if (n.providerAttempts.length > 0) {
      result.failure.cause = { ...recordValue(result.failure.cause), providerAttempts: n.providerAttempts };
    }
  }

  return result;
}

/** Run the retry/feedback-retry loops for this phase's result. */
async function applyPhaseRetryLoops(
  session: DagRunSession,
  n: {
    phase: string;
    role: string;
    nodeId: string;
    dagNode: WorkflowDagNode;
    phaseAgents: ProviderAgents;
    pool: ProviderPool | null | undefined;
    result: PhaseResult;
  },
): Promise<PhaseResult> {
  const { ctx, project, task, jobId, job, workflow, planMode, cpbRoot, dataRoot, sourcePath, phaseSourceContext, state, phaseResults, attemptId, phaseTimeout } = session;
  return runPhaseRetryLoops({
    agent: ctx.agent,
    appendEvent: ctx.appendEvent,
    onProgress: ctx.onProgress || undefined,
  }, {
    phase: n.phase, role: n.role, nodeId: n.nodeId, dagNode: n.dagNode, project, task, jobId, job,
    workflow, planMode, cpbRoot, dataRoot, sourcePath, phaseSourceContext,
    state, phaseResults, attemptId,
    conversationKey: buildConversationKey({ project, jobId, attemptId, role: n.role }),
    phaseTimeout, phaseAgents: n.phaseAgents, result: n.result, pool: n.pool,
  }, {
    runPhase: runPhase,
  });
}

/** Execute a single DAG node end-to-end. Returns a terminal JobRunResult on scope-guard/finalize failure, else null. */
async function runDagNode(
  session: DagRunSession,
  dagNode: WorkflowDagNode,
  options: RunDagNodeOptions = {},
): Promise<DagNodeRunOutcome> {
  const { ctx, jobId, attemptId, phaseSourceContext, dynamicAgentPlan, phaseRoleMap } = session;
  const phase = dagNode.phase;
  ctx._currentPhase = phase;
  const fallbackRole = phaseRoleMap[phase] || phase;
  const nodeId = dagNode.id || phase;
  const role = stringValue(dagNode.role) || fallbackRole;

  if (!options.ignoreResume && await tryResumeCompletedNode(session, dagNode, { phase, nodeId, role })) {
    return { terminal: null, result: null, deferredVerificationFailure: false, phase, role, nodeId, dagNode };
  }

  const taskCategory = classifyRoutingTaskCategory(session.task, phaseSourceContext);
  const outcomeMetrics = await loadOutcomeRoutingMetrics(session, { phase, role, taskCategory });
  const excludeProviderFamily = requiresIndependentVerification(session, phase, role)
    ? executorProviderFamily(session)
    : null;

  const {
    phaseAgents: rawPhaseAgents,
    dynamicAgent,
    phaseRoutingDecision,
    effectiveSelectedAgent,
    allowedAgents,
  } = resolvePhaseAgentRouting({
    agents: ctx.agents,
    dynamicAgentPlan,
    phaseSourceContext,
    sourceContext: ctx.sourceContext,
    routing: ctx.routing,
    agentAvailability: ctx.agentAvailability,
    agentHealth: ctx.agentHealth,
    teamPolicy: ctx.teamPolicy,
    outcomeMetrics,
    taskCategory,
    excludedProviderFamily: excludeProviderFamily,
    phase,
    role,
  });
  // retain: dynamic agent-routing boundary — resolvePhaseAgentRouting returns
  // LooseRecord (Record<string, unknown>) built from ctx.agents/dynamicAgentPlan/
  // routing decisions whose values are unknown at compile time; narrowing each
  // entry to ProviderAgent would be speculative since the runtime shape is
  // string | AgentObject | null determined by external config.
  const phaseAgents = rawPhaseAgents as ProviderAgents;

  const { cpbRoot, project } = session;
  await emitPhaseStartEvents({
    cpbRoot,
    project,
    jobId,
    phase,
    role,
    nodeId,
    dagNode,
    selectedAgent: effectiveSelectedAgent,
    attemptId,
    startPhase: ctx.startPhase,
    appendEvent: ctx.appendEvent,
    onProgress: ctx.onProgress || null,
    now: ts,
    phaseRoutingDecision,
  });

  if (phaseRoutingDecision?.agentPolicyConflict || phaseRoutingDecision?.independenceConflict) {
    const reason = phaseRoutingDecision.reason || "agent routing policy has no valid candidate";
    const result = phaseFailed({
      phase,
      failure: failure({
        kind: FailureKind.AGENT_UNAVAILABLE,
        phase,
        reason,
        retryable: false,
        cause: {
          hardGate: true,
          role,
          allowedAgents,
          excludedProviderFamily: excludeProviderFamily,
          agentPolicyConflict: phaseRoutingDecision.agentPolicyConflict === true,
          independenceConflict: phaseRoutingDecision.independenceConflict === true,
        },
      }),
    });
    const terminal = await handleDagNodeFailure({
      cpbRoot,
      project,
      jobId,
      nodeId,
      phase,
      role,
      attemptId,
      dagNode,
      phaseResult: result,
      phaseResults: session.phaseResults,
      appendEvent: ctx.appendEvent,
      failJob: ctx.failJob,
      onProgress: ctx.onProgress || null,
      now: ts,
    });
    return { terminal, result, deferredVerificationFailure: false, phase, role, nodeId, dagNode };
  }

  const handoffState: HandoffState = { count: 0, from: null, to: null, reason: null };
  const providerAttempts: ProviderAttempt[] = [];

  let result: PhaseResult = await preflightAndRunPhase(session, {
    phase, role, nodeId, dagNode, phaseAgents, dynamicAgent, excludeProviderFamily, allowedAgents, handoffState,
  });

  result = await applyQuotaFallback(session, {
    phase, role, nodeId, dagNode, phaseAgents, handoffState, providerAttempts, result, excludeProviderFamily, allowedAgents,
  });

  result = await applyPhaseRetryLoops(session, {
    phase, role, nodeId, dagNode, phaseAgents, pool: session.pool, result,
  });

  const { failJob } = ctx;
  const scopeGuardFailure = await evaluateExecuteScopeGuard({
    cpbRoot,
    project,
    jobId,
    nodeId,
    phase,
    role,
    attemptId,
    dagNode,
    phaseSourceContext,
    phaseResult: result,
    phaseResults: session.phaseResults,
    appendEvent: ctx.appendEvent,
    failJob,
    onProgress: ctx.onProgress || null,
    now: ts,
  });
  if (scopeGuardFailure) {
    return { terminal: scopeGuardFailure, result, deferredVerificationFailure: false, phase, role, nodeId, dagNode };
  }

  const { hubRoot, pool, providerServices, state, phaseResults, job, dataRoot } = session;
  const { completePhase } = ctx;
  result = await finalizePhaseResult({
    cpbRoot, project, jobId, task: session.task, phase, role, nodeId, dagNode, attemptId,
    phaseResults, state, phaseAgents, result,
    agent: ctx.agent || null, providerServices, hubRoot, pool, job, phaseSourceContext,
    handoffState, providerAttempts,
    appendEvent: ctx.appendEvent, onProgress: ctx.onProgress || null, completePhase,
    now: ts, legacyAgentForPhase, phaseRoutingDecision,
  });

  if (!isPhasePassed(result)) {
    if (
      options.deferVerificationFailure
      && (
        isRepairableVerificationFailure(result)
        || isRecoverableVerificationInfrastructureFailure(result)
      )
    ) {
      return { terminal: null, result, deferredVerificationFailure: true, phase, role, nodeId, dagNode };
    }
    const terminal = await handleDagNodeFailure({
      cpbRoot,
      project,
      jobId,
      nodeId,
      phase,
      role,
      attemptId,
      dagNode,
      phaseResult: result,
      phaseResults,
      appendEvent: ctx.appendEvent,
      failJob,
      onProgress: ctx.onProgress || null,
      now: ts,
    });
    return { terminal, result, deferredVerificationFailure: false, phase, role, nodeId, dagNode };
  }

  return { terminal: null, result, deferredVerificationFailure: false, phase, role, nodeId, dagNode };
}

async function finishDeferredVerificationFailure(
  session: DagRunSession,
  outcome: DagNodeRunOutcome,
): Promise<JobRunResult> {
  const result = outcome.result;
  if (!result) throw new Error("deferred verification failure is missing its phase result");
  return handleDagNodeFailure({
    cpbRoot: session.cpbRoot,
    project: session.project,
    jobId: session.jobId,
    nodeId: outcome.nodeId,
    phase: outcome.phase,
    role: outcome.role,
    attemptId: session.attemptId,
    dagNode: outcome.dagNode,
    phaseResult: result,
    phaseResults: session.phaseResults,
    appendEvent: session.ctx.appendEvent,
    failJob: session.ctx.failJob,
    onProgress: session.ctx.onProgress || null,
    now: ts,
  });
}

async function runVerificationRepairLoop(
  session: DagRunSession,
  executeNode: WorkflowDagNode | null,
  verificationNodes: WorkflowDagNode[],
  initialFailure: DagNodeRunOutcome,
): Promise<JobRunResult | null> {
  if (isRecoverableVerificationInfrastructureFailure(initialFailure.result)) {
    return runVerificationInfrastructureRetryLoop(
      session,
      executeNode,
      verificationNodes,
      initialFailure,
    );
  }
  if (!executeNode || verificationNodes.length === 0 || !initialFailure.result) {
    return finishDeferredVerificationFailure(session, initialFailure);
  }

  const maxRepairs = solverRepairLimit();
  const originalSourceContext = session.phaseSourceContext;
  let verificationOutcome = initialFailure;
  let previousFailureFingerprint = verificationFailureFingerprint(initialFailure.result);
  let previousCandidateId = candidateIdFromLatestExecute(session.phaseResults);
  let forceFreshDiagnosis = false;

  for (let iteration = 1; iteration <= maxRepairs; iteration += 1) {
    let feedback = verificationFeedbackFromResult(verificationOutcome.result as PhaseResult, iteration);
    const scopedFeedback = bindVerificationFeedbackToFrozenScope(originalSourceContext, feedback);
    if (scopedFeedback.ok === false) {
      const failedResult = verificationOutcome.result as PhaseResult;
      if (failedResult.failure) {
        failedResult.failure.retryable = false;
        failedResult.failure.cause = {
          ...recordValue(failedResult.failure.cause),
          counterexampleDisposition: "scope_expansion",
          requestedFixScope: scopedFeedback.requestedFixScope,
          allowedFixScope: scopedFeedback.allowedFixScope,
        };
      }
      await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
        type: "solver_repair_blocked",
        jobId: session.jobId,
        project: session.project,
        attemptId: session.attemptId || null,
        iteration,
        triggerPhase: feedback.triggerPhase,
        disposition: "scope_expansion",
        reason: scopedFeedback.reason,
        requestedFixScope: scopedFeedback.requestedFixScope,
        allowedFixScope: scopedFeedback.allowedFixScope,
        failureFingerprint: feedback.failureFingerprint,
        candidateId: previousCandidateId,
        ts: ts(),
      });
      session.phaseSourceContext = originalSourceContext;
      return finishDeferredVerificationFailure(session, verificationOutcome);
    }
    feedback = scopedFeedback.feedback;
    session.phaseSourceContext = solverRepairSourceContext(originalSourceContext, feedback);
    if (forceFreshDiagnosis) {
      const retry = recordValue(session.phaseSourceContext.retry);
      session.phaseSourceContext.retry = {
        ...retry,
        instruction: "The previous repair produced the same candidate and the same verification failure. Stop repeating the prior edit. Re-open the failing path, form a different root-cause hypothesis, inspect the real callers/entrypoints, then make a materially different repair and rerun focused validation.",
      };
    }
    await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
      type: "solver_repair_started",
      jobId: session.jobId,
      project: session.project,
      attemptId: session.attemptId || null,
      iteration,
      triggerPhase: feedback.triggerPhase,
      failureKind: feedback.failureKind,
      reason: feedback.failureReason,
      fixScope: feedback.fixScope,
      allowedFixScope: feedback.allowedFixScope,
      targetChecklistIds: feedback.targetChecklistIds,
      evidenceArtifacts: feedback.evidenceArtifacts,
      failureFingerprint: feedback.failureFingerprint,
      candidateId: previousCandidateId,
      strategy: forceFreshDiagnosis ? "fresh_diagnosis" : "targeted_repair",
      ts: ts(),
    });

    const executeOutcome = await runDagNode(session, executeNode, { ignoreResume: true });
    if (executeOutcome.terminal) {
      session.phaseSourceContext = originalSourceContext;
      return executeOutcome.terminal;
    }

    let suffixFailure: DagNodeRunOutcome | null = null;
    for (const verificationNode of verificationNodes) {
      const outcome = await runDagNode(session, verificationNode, {
        deferVerificationFailure: true,
        ignoreResume: true,
      });
      if (outcome.terminal) {
        session.phaseSourceContext = originalSourceContext;
        return outcome.terminal;
      }
      if (outcome.deferredVerificationFailure) {
        suffixFailure = outcome;
        break;
      }
    }
    if (!suffixFailure) {
      const completedCandidateId = candidateIdFromLatestExecute(session.phaseResults);
      await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
        type: "solver_repair_completed",
        jobId: session.jobId,
        project: session.project,
        attemptId: session.attemptId || null,
        iteration,
        status: "passed",
        triggerPhase: feedback.triggerPhase,
        candidateId: previousCandidateId,
        resultCandidateId: completedCandidateId,
        ts: ts(),
      });
      session.phaseSourceContext = originalSourceContext;
      return null;
    }
    verificationOutcome = suffixFailure;

    const currentFailureFingerprint = verificationFailureFingerprint(verificationOutcome.result as PhaseResult);
    const currentCandidateId = candidateIdFromLatestExecute(session.phaseResults);
    forceFreshDiagnosis = Boolean(
      currentCandidateId
      && currentCandidateId === previousCandidateId
      && currentFailureFingerprint === previousFailureFingerprint
    );
    if (forceFreshDiagnosis) {
      await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
        type: "solver_strategy_changed",
        jobId: session.jobId,
        project: session.project,
        attemptId: session.attemptId || null,
        iteration,
        fromStrategy: "targeted_repair",
        toStrategy: "fresh_diagnosis",
        failureFingerprint: currentFailureFingerprint,
        candidateId: currentCandidateId,
        reason: "repair produced no candidate or failure-fingerprint progress",
        ts: ts(),
      });
    }
    previousFailureFingerprint = currentFailureFingerprint;
    previousCandidateId = currentCandidateId;
  }

  await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
    type: "solver_attempt_exhausted",
    jobId: session.jobId,
    project: session.project,
    attemptId: session.attemptId || null,
    repairAttempts: maxRepairs,
    phase: verificationOutcome.phase,
    ts: ts(),
  });
  session.phaseSourceContext = originalSourceContext;
  if (verificationOutcome.result?.failure) {
    const cause = recordValue(verificationOutcome.result.failure.cause);
    verificationOutcome.result.failure.cause = {
      ...cause,
      solver: {
        exhausted: true,
        repairAttempts: maxRepairs,
        failureFingerprint: previousFailureFingerprint,
        candidateId: previousCandidateId,
        strategy: forceFreshDiagnosis ? "fresh_diagnosis" : "targeted_repair",
      },
    };
  }
  return finishDeferredVerificationFailure(session, verificationOutcome);
}

async function runVerificationInfrastructureRetryLoop(
  session: DagRunSession,
  executeNode: WorkflowDagNode | null,
  verificationNodes: WorkflowDagNode[],
  initialFailure: DagNodeRunOutcome,
): Promise<JobRunResult | null> {
  if (!initialFailure.result) return finishDeferredVerificationFailure(session, initialFailure);

  const maxRetries = verificationInfrastructureRetryLimit();
  const originalSourceContext = session.phaseSourceContext;
  const frozenCandidateId = candidateIdFromLatestExecute(session.phaseResults);
  let verificationOutcome = initialFailure;
  let previousFingerprint = verificationInfrastructureFailureFingerprint(initialFailure.result);

  for (let iteration = 1; iteration <= maxRetries; iteration += 1) {
    const feedback = verificationInfrastructureFeedbackFromResult(
      verificationOutcome.result as PhaseResult,
      iteration,
    );
    session.phaseSourceContext = verificationInfrastructureRetrySourceContext(
      originalSourceContext,
      feedback,
    );
    await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
      type: "verification_infrastructure_retry_started",
      jobId: session.jobId,
      project: session.project,
      attemptId: session.attemptId || null,
      iteration,
      phase: verificationOutcome.phase,
      failureFingerprint: feedback.failureFingerprint,
      candidateId: frozenCandidateId,
      candidateMutationAllowed: false,
      ts: ts(),
    });

    const retryOutcome = await runDagNode(session, verificationOutcome.dagNode, {
      deferVerificationFailure: true,
      ignoreResume: true,
    });
    if (retryOutcome.terminal) {
      session.phaseSourceContext = originalSourceContext;
      return retryOutcome.terminal;
    }

    const currentCandidateId = candidateIdFromLatestExecute(session.phaseResults);
    if (currentCandidateId !== frozenCandidateId) {
      const failedResult = retryOutcome.result || verificationOutcome.result;
      if (failedResult?.failure) {
        failedResult.failure.retryable = false;
        failedResult.failure.cause = {
          ...recordValue(failedResult.failure.cause),
          verificationInfrastructure: {
            ...recordValue(recordValue(failedResult.failure.cause).verificationInfrastructure),
            candidateMutationAllowed: false,
            candidateDrift: true,
            expectedCandidateId: frozenCandidateId,
            actualCandidateId: currentCandidateId,
          },
        };
      }
      session.phaseSourceContext = originalSourceContext;
      return finishDeferredVerificationFailure(session, {
        ...retryOutcome,
        result: failedResult,
        deferredVerificationFailure: true,
      });
    }

    if (!retryOutcome.deferredVerificationFailure) {
      await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
        type: "verification_infrastructure_retry_completed",
        jobId: session.jobId,
        project: session.project,
        attemptId: session.attemptId || null,
        iteration,
        phase: retryOutcome.phase,
        status: "passed",
        candidateId: frozenCandidateId,
        ts: ts(),
      });
      session.phaseSourceContext = originalSourceContext;
      return null;
    }

    if (!isRecoverableVerificationInfrastructureFailure(retryOutcome.result)) {
      session.phaseSourceContext = originalSourceContext;
      return runVerificationRepairLoop(
        session,
        executeNode,
        verificationNodes,
        retryOutcome,
      );
    }

    verificationOutcome = retryOutcome;
    const currentFingerprint = verificationInfrastructureFailureFingerprint(
      verificationOutcome.result as PhaseResult,
    );
    await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
      type: "verification_infrastructure_retry_failed",
      jobId: session.jobId,
      project: session.project,
      attemptId: session.attemptId || null,
      iteration,
      phase: verificationOutcome.phase,
      failureFingerprint: currentFingerprint,
      previousFailureFingerprint: previousFingerprint,
      candidateId: frozenCandidateId,
      ts: ts(),
    });
    previousFingerprint = currentFingerprint;
  }

  await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
    type: "verification_infrastructure_retry_exhausted",
    jobId: session.jobId,
    project: session.project,
    attemptId: session.attemptId || null,
    retryAttempts: maxRetries,
    phase: verificationOutcome.phase,
    failureFingerprint: previousFingerprint,
    candidateId: frozenCandidateId,
    ts: ts(),
  });
  session.phaseSourceContext = originalSourceContext;
  if (verificationOutcome.result?.failure) {
    const cause = recordValue(verificationOutcome.result.failure.cause);
    verificationOutcome.result.failure.retryable = false;
    verificationOutcome.result.failure.cause = {
      ...cause,
      verificationInfrastructure: {
        ...recordValue(cause.verificationInfrastructure),
        localRetryExhausted: true,
        retryAttempts: maxRetries,
        failureFingerprint: previousFingerprint,
      },
    };
  }
  return finishDeferredVerificationFailure(session, verificationOutcome);
}

function candidateIdFromLatestExecute(phaseResults: PhaseResult[]) {
  for (let index = phaseResults.length - 1; index >= 0; index -= 1) {
    const result = phaseResults[index];
    if (result.phase !== "execute") continue;
    const candidate = recordValue(recordValue(result.diagnostics).candidateArtifact);
    if (typeof candidate.identityHash === "string") return candidate.identityHash;
  }
  return null;
}

function completionRetryPhase(result: JobRunResult) {
  const failure = recordValue(result.failure);
  const cause = recordValue(failure.cause);
  return typeof cause.routingRetryPhase === "string" ? cause.routingRetryPhase : null;
}

function completionGateArgs(
  session: DagRunSession,
  workflowDag: WorkflowDag,
  options: { deferRepairableFailure: boolean; repairContext?: LooseRecord | null },
) {
  return {
    cpbRoot: session.cpbRoot,
    project: session.project,
    jobId: session.jobId,
    job: session.job,
    workflowDag,
    riskMap: session.riskMap ? recordValue(session.riskMap) : null,
    dynamicAgentPlan: session.dynamicAgentPlan ? recordValue(session.dynamicAgentPlan) : null,
    phaseResults: session.phaseResults,
    dataRoot: session.dataRoot,
    sourcePath: session.sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
    attemptId: session.attemptId,
    getArtifactIndex: session.ctx.getArtifactIndex,
    appendEvent: session.ctx.appendEvent,
    failJob: session.ctx.failJob,
    completeJob: session.ctx.completeJob,
    onProgress: session.ctx.onProgress || null,
    now: ts,
    deferRepairableFailure: options.deferRepairableFailure,
    repairContext: options.repairContext || null,
  };
}

async function rerunDagFromPhase(
  session: DagRunSession,
  executionNodes: WorkflowDagNode[],
  retryPhase: string,
): Promise<JobRunResult | null> {
  const startIndex = executionNodes.findIndex((node) => node.phase === retryPhase);
  if (startIndex < 0) return null;

  for (let nodeIndex = startIndex; nodeIndex < executionNodes.length; nodeIndex += 1) {
    const dagNode = executionNodes[nodeIndex];
    const outcome = await runDagNode(session, dagNode, {
      deferVerificationFailure: dagNode.phase === "verify" || dagNode.phase === "adversarial_verify",
      ignoreResume: true,
    });
    if (outcome.terminal) return outcome.terminal;
    if (!outcome.deferredVerificationFailure) continue;

    const executeNode = executionNodes
      .slice(0, nodeIndex)
      .reverse()
      .find((candidate) => candidate.phase === "execute") || null;
    const verificationNodes = executionNodes
      .slice(executeNode ? executionNodes.indexOf(executeNode) + 1 : 0, nodeIndex + 1)
      .filter((candidate) => candidate.phase === "verify" || candidate.phase === "adversarial_verify");
    const terminal = await runVerificationRepairLoop(session, executeNode, verificationNodes, outcome);
    if (terminal) return terminal;
  }
  return null;
}

async function runCompletionRepairLoop(
  session: DagRunSession,
  executionNodes: WorkflowDagNode[],
  workflowDag: WorkflowDag,
): Promise<JobRunResult> {
  let gateResult = await runCompletionGate(completionGateArgs(session, workflowDag, {
    deferRepairableFailure: true,
  }));
  if (gateResult.status !== "repairable") return gateResult;

  const originalSourceContext = session.phaseSourceContext;
  const maxRepairs = completionGateRepairLimit();
  let previousFingerprint = completionGateFailureFingerprint(gateResult.failure);
  let previousCandidateId = candidateIdFromLatestExecute(session.phaseResults);
  let forceFreshDiagnosis = false;

  for (let iteration = 1; iteration <= maxRepairs; iteration += 1) {
    const retryPhase = completionRetryPhase(gateResult);
    if (!retryPhase || !executionNodes.some((node) => node.phase === retryPhase)) break;

    const feedback = completionGateFeedbackFromFailure(gateResult.failure, iteration);
    session.phaseSourceContext = completionGateRepairSourceContext(originalSourceContext, feedback);
    if (forceFreshDiagnosis) {
      const retry = recordValue(session.phaseSourceContext.retry);
      session.phaseSourceContext.retry = {
        ...retry,
        instruction: retryPhase === "verify"
          ? "The same candidate produced the same gate failure again. Rebuild the evidence ledger from current objective probes, inspect the exact rejected evidence references, and emit a fresh verdict that cites only satisfying current-ledger evidence."
          : "The previous completion repair produced the same candidate and gate fingerprint. Stop repeating the prior edit, form a different root-cause hypothesis for the named checklist items, inspect their real entrypoints, and make a materially different repair.",
      };
    }

    await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
      type: "solver_completion_gate_repair_started",
      jobId: session.jobId,
      project: session.project,
      attemptId: session.attemptId || null,
      phase: retryPhase,
      iteration,
      gateOutcome: feedback.gateOutcome,
      failureKind: feedback.failureKind,
      reason: feedback.failureReason,
      fixScope: feedback.fixScope,
      targetChecklistIds: feedback.targetChecklistIds,
      failureFingerprint: feedback.failureFingerprint,
      candidateId: previousCandidateId,
      strategy: forceFreshDiagnosis ? "fresh_diagnosis" : "targeted_repair",
      ts: ts(),
    });

    const terminal = await rerunDagFromPhase(session, executionNodes, retryPhase);
    if (terminal) {
      session.phaseSourceContext = originalSourceContext;
      return terminal;
    }

    const strategy = forceFreshDiagnosis ? "fresh_diagnosis" : "targeted_repair";
    gateResult = await runCompletionGate(completionGateArgs(session, workflowDag, {
      deferRepairableFailure: true,
      repairContext: {
        phase: retryPhase,
        iteration,
        failureFingerprint: feedback.failureFingerprint,
        candidateId: previousCandidateId,
        resultCandidateId: candidateIdFromLatestExecute(session.phaseResults),
        strategy,
      },
    }));
    if (gateResult.status !== "repairable") {
      session.phaseSourceContext = originalSourceContext;
      return gateResult;
    }

    const currentFingerprint = completionGateFailureFingerprint(gateResult.failure);
    const currentCandidateId = candidateIdFromLatestExecute(session.phaseResults);
    forceFreshDiagnosis = currentFingerprint === previousFingerprint
      && currentCandidateId === previousCandidateId;
    if (forceFreshDiagnosis) {
      await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
        type: "solver_completion_gate_strategy_changed",
        jobId: session.jobId,
        project: session.project,
        attemptId: session.attemptId || null,
        phase: retryPhase,
        iteration,
        fromStrategy: "targeted_repair",
        toStrategy: "fresh_diagnosis",
        failureFingerprint: currentFingerprint,
        candidateId: currentCandidateId,
        reason: "completion repair produced no candidate or gate-fingerprint progress",
        ts: ts(),
      });
    }
    previousFingerprint = currentFingerprint;
    previousCandidateId = currentCandidateId;
  }

  await session.ctx.appendEvent(session.cpbRoot, session.project, session.jobId, {
    type: "solver_completion_gate_repair_exhausted",
    jobId: session.jobId,
    project: session.project,
    attemptId: session.attemptId || null,
    phase: completionRetryPhase(gateResult) || "completion_gate",
    repairAttempts: maxRepairs,
    failureFingerprint: previousFingerprint,
    candidateId: previousCandidateId,
    ts: ts(),
  });
  session.phaseSourceContext = originalSourceContext;
  return runCompletionGate(completionGateArgs(session, workflowDag, {
    deferRepairableFailure: false,
  }));
}

/**
 * Execute the materialized workflow DAG node-by-node, including provider
 * preflight/fallback, phase retries, scope guards, finalization events, and
 * the completion gate. Extracted from runJobInner to keep the entrypoint focused
 * on preparation/materialization while preserving the sequential DAG contract.
 */
export async function executeWorkflowDag(
  ctx: ExecuteWorkflowDagContext,
  input: ExecuteWorkflowDagInput,
): Promise<JobRunResult> {
  const {
    cpbRoot,
    hubRoot,
    project,
    task,
    workflow = "standard",
    planMode = "full",
    sourcePath,
    dataRoot,
    timeoutMin,
  } = ctx;
  const {
    job,
    jobId,
    attemptId,
    riskMap,
    phaseSourceContext,
    dynamicAgentPlan,
    workflowDag,
    executionNodes,
  } = input;

  const providerServices = normalizeProviderServices(ctx.providerServices);
  const pool = ctx.getPool();
  const phaseResults: PhaseResult[] = [];
  const state: LooseRecord = { planId: null, deliverableId: null, riskMap };
  const phaseTimeout = resolveAgentPhaseTimeoutMs({ timeoutMin });
  const phaseTimeouts = {
    plan: phaseTimeout,
    execute: phaseTimeout,
    verify: phaseTimeout,
    adversarial_verify: phaseTimeout,
    review: phaseTimeout,
    remediate: phaseTimeout,
  };

  const session: DagRunSession = {
    ctx,
    cpbRoot,
    hubRoot,
    project,
    task,
    job,
    jobId,
    attemptId,
    riskMap,
    phaseSourceContext,
    dynamicAgentPlan,
    workflow,
    planMode,
    sourcePath,
    dataRoot,
    phaseTimeout,
    phaseTimeouts,
    providerServices,
    pool,
    state,
    phaseResults,
    phaseRoleMap: input.phaseRoleMap,
    resumeCompletedNodes: input.resumeCompletedNodes,
    dagResumeContext: input.dagResumeContext,
  };

  for (let nodeIndex = 0; nodeIndex < executionNodes.length; nodeIndex += 1) {
    const dagNode = executionNodes[nodeIndex];
    const outcome = await runDagNode(session, dagNode, {
      deferVerificationFailure: dagNode.phase === "verify" || dagNode.phase === "adversarial_verify",
    });
    if (outcome.terminal) return outcome.terminal;
    if (outcome.deferredVerificationFailure) {
      const executeNode = executionNodes
        .slice(0, nodeIndex)
        .reverse()
        .find((candidate) => candidate.phase === "execute") || null;
      const verificationNodes = executionNodes
        .slice(executeNode ? executionNodes.indexOf(executeNode) + 1 : 0, nodeIndex + 1)
        .filter((candidate) => candidate.phase === "verify" || candidate.phase === "adversarial_verify");
      const terminal = await runVerificationRepairLoop(session, executeNode, verificationNodes, outcome);
      if (terminal) return terminal;
    }
  }

  return runCompletionRepairLoop(session, executionNodes, workflowDag);
}
