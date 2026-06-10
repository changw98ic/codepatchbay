/**
 * Engine.runJob — native phase state machine.
 *
 * Creates a job, resolves phases from workflow, runs each phase via
 * native adapters (core/phases/*.js).  Returns structured JobResult.
 *
 * All infrastructure services (createJob, appendEvent, etc.) are
 * injected via ctx — no server/ imports in core/.
 */

import { runPhase } from "./run-phase.js";
import { resolveSemanticPhases } from "./phase-policy.js";
import { isPhasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { legacyAgentForPhase } from "../agents/registry.js";
import { resolvePhaseAgentWithFallback } from "../agents/routing.js";
import { generateHandoffBundle } from "../handoff/handoff-bundle.js";
import { buildWorkflowDag, insertAdversarialVerify } from "./dag-builder.js";
import { generateDynamicAgentPlan, validateDynamicAgentPlan } from "../agents/dynamic-agent-plan.js";
import { evaluateCompletionGate, parseVerdict, completionGateEvent } from "./completion-gate.js";
import { validateScopeConstraint, stripGitStatusPrefix } from "./scope-guard.js";

const HANDOFF_MAX_PER_PHASE = Number(process.env.CPB_PROVIDER_HANDOFF_MAX_PER_PHASE || 1);
const PHASE_RETRY_MAX = Number(process.env.CPB_PHASE_RETRY_MAX || 2);
const PHASE_RETRY_BASE_DELAY_MS = Number(process.env.CPB_PHASE_RETRY_BASE_DELAY_MS || 30_000);
const PHASE_RETRYABLE_KINDS = new Set([
  FailureKind.AGENT_SPAWN_ERROR,
  FailureKind.AGENT_EXIT_NONZERO,
  FailureKind.TIMEOUT,
  FailureKind.RUNTIME_INTERRUPTED,
]);
const PHASE_FEEDBACK_RETRY_MAX = Number(process.env.CPB_PHASE_FEEDBACK_RETRY_MAX || 1);
const PHASE_FEEDBACK_RETRY_KINDS = new Set([
  FailureKind.ARTIFACT_INVALID,
  FailureKind.AGENT_CONTRACT_INVALID,
]);

function ts() {
  return new Date().toISOString();
}

function numericEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function phaseRetryBaseDelayMs() {
  return numericEnv("CPB_PHASE_RETRY_BASE_DELAY_MS", PHASE_RETRY_BASE_DELAY_MS);
}

async function reportProgress(ctx, event) {
  if (typeof ctx.onProgress !== "function") return;
  try {
    await ctx.onProgress({ ts: ts(), ...event });
  } catch {
    // Progress reporting must not change job execution outcome.
  }
}

function extractArtifactId(artifact) {
  if (!artifact?.name) return null;
  const parts = artifact.name.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : artifact.id || null;
}

function normalizePhaseUsage(usage, { hardGateFailed = false } = {}) {
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

  return {
    calls: 1,
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    costUsd: usage?.costUsd ?? null,
    tokenSource: usage?.tokenSource || "acp_not_reported",
    toolCalls: usage?.toolCalls ?? null,
    functionCalls: usage?.functionCalls ?? null,
  };
}

function retryFailureCause(fail) {
  if (fail?.kind !== FailureKind.VERIFICATION_FAILED) return undefined;
  const cause = fail.cause || {};
  return {
    verdict: cause.verdict || null,
    artifact: cause.artifact
      ? {
          kind: cause.artifact.kind || null,
          id: cause.artifact.id || null,
          name: cause.artifact.name || null,
          path: cause.artifact.path || null,
          bytes: cause.artifact.bytes ?? null,
          sha256: cause.artifact.sha256 || null,
        }
      : null,
  };
}

function normalizeProviderServices(services = {}) {
  const source = services && typeof services === "object" ? services : {};
  return {
    assertProviderAvailable:
      source.assertProviderAvailable ||
      source.providerQuota?.assertProviderAvailable ||
      null,
    getProviderAdapter:
      source.getProviderAdapter ||
      source.providerAdapters?.getProviderAdapter ||
      null,
    delegateMarkProviderUnavailable:
      source.delegateMarkProviderUnavailable ||
      source.quotaDelegate?.delegateMarkProviderUnavailable ||
      null,
    delegateEnqueueProviderUsage:
      source.delegateEnqueueProviderUsage ||
      source.quotaDelegate?.delegateEnqueueProviderUsage ||
      null,
  };
}

function normalizePrepareFailure(err) {
  const code = err?.kind || err?.code || "prepare_task_unavailable";
  const reason = err?.reason || err?.message || "prepareTask service is unavailable";
  return failure({
    kind: code === FailureKind.CODEGRAPH_UNAVAILABLE
      ? FailureKind.CODEGRAPH_UNAVAILABLE
      : FailureKind.UNKNOWN,
    phase: "prepare_task",
    reason,
    retryable: false,
    cause: {
      code,
      details: err?.details || null,
    },
  });
}

async function blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail }) {
  const reason = fail.cause?.code || fail.reason;
  if (typeof blockJob === "function") {
    await blockJob(cpbRoot, project, jobId, {
      reason,
      code: fail.kind,
      kind: fail.kind,
      cause: fail.cause,
    });
    return;
  }
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_blocked",
    jobId,
    project,
    reason,
    code: fail.kind,
    kind: fail.kind,
    cause: fail.cause,
    ts: ts(),
  });
}

function normalizeRiskMapResult(result) {
  return result?.riskMap || result?.riskmap || result;
}

function normalizeDynamicAgentEntry(entry) {
  if (!entry) return null;
  if (typeof entry === "string") {
    return { selectedAgent: entry, required: false };
  }
  if (typeof entry !== "object") return null;
  const selectedAgent = entry.agent || entry.name || entry.selectedAgent || null;
  if (!selectedAgent) return null;
  const normalizedAgent = entry.variant
    ? { agent: selectedAgent, variant: entry.variant }
    : selectedAgent;
  return {
    selectedAgent: normalizedAgent,
    required: Boolean(entry.required || entry.requiredDynamicRole),
  };
}

function dynamicAgentPlanFrom(ctx, phaseSourceContext) {
  return ctx.dynamicAgentPlan
    || phaseSourceContext?.dynamicAgentPlan
    || ctx.sourceContext?.dynamicAgentPlan
    || null;
}

function dynamicAgentForRole(plan, role, phase) {
  const agentConfig = plan?.agentConfig || plan?.agents || {};
  return normalizeDynamicAgentEntry(agentConfig?.[role] || agentConfig?.[phase]);
}

// dagForRun and phasesWithAdversarialVerify extracted to dag-builder.js
// (buildWorkflowDag and insertAdversarialVerify)

/**
 * Extract fix scope from phase results and risk map for adversarial retry context.
 */
function extractFixScope(phaseResults, riskMap) {
  const adversarialResult = phaseResults.find(r => r?.phase === "adversarial_verify");
  const advCause = adversarialResult?.failure?.cause || {};
  if (Array.isArray(advCause.fix_scope) && advCause.fix_scope.length > 0) return advCause.fix_scope;
  if (Array.isArray(riskMap?.adversarialFocus) && riskMap.adversarialFocus.length > 0) return riskMap.adversarialFocus;
  if (Array.isArray(riskMap?.highRiskFiles) && riskMap.highRiskFiles.length > 0) return riskMap.highRiskFiles;
  const executeResult = phaseResults.find(r => r?.phase === "execute");
  const executeArtifact = executeResult?.artifact;
  if (executeArtifact) {
    const paths = [];
    if (executeArtifact.path) paths.push(executeArtifact.path);
    if (Array.isArray(executeArtifact.files)) paths.push(...executeArtifact.files);
    if (paths.length > 0) return paths;
  }
  return [];
}

/**
 * Build adversarial retry context from gate result, phase results, and risk map.
 */
function buildAdversarialRetryContext(gateResult, phaseResults, riskMap) {
  if (gateResult.outcome !== "adversarial_failed") return null;
  const adversarialResult = phaseResults.find(r => r?.phase === "adversarial_verify");
  const advCause = adversarialResult?.failure?.cause || {};
  const advVerdict = advCause.verdict || {};
  return {
    reason: "adversarial_verification_failed",
    adversarialFocus: Array.isArray(advCause.focus) ? advCause.focus
      : (Array.isArray(riskMap?.adversarialFocus) ? riskMap.adversarialFocus : []),
    verdictReason: advVerdict.reason || gateResult.reason,
    blockingEvidence: advVerdict.details || gateResult.reason,
    fix_scope: extractFixScope(phaseResults, riskMap),
  };
}

/**
 * @param {object} ctx
 * @param {string} ctx.cpbRoot
 * @param {string} [ctx.hubRoot]
 * @param {string} ctx.project
 * @param {string} ctx.task
 * @param {string} [ctx.workflow="standard"]
 * @param {string} [ctx.planMode="full"]
 * @param {string} [ctx.sourcePath]
 * @param {object} [ctx.sourceContext]
 * @param {number} [ctx.maxRetries]
 * @param {number} [ctx.timeoutMin]
 * @param {Function} ctx.createJob
 * @param {Function} [ctx.startPhase]
 * @param {Function} ctx.completePhase
 * @param {Function} ctx.completeJob
 * @param {Function} ctx.failJob
 * @param {Function} [ctx.blockJob]
 * @param {Function} ctx.appendEvent
 * @param {Function} ctx.getPool
 * @param {Function} ctx.prepareTask
 * @param {object} [ctx.providerServices]
 * @returns {Promise<{status: string, jobId: string, exitCode: number, failure?: object}>}
 */
export async function runJob(ctx) {
  const {
    cpbRoot,
    hubRoot,
    project,
    task,
    workflow = "standard",
    planMode = "full",
    sourcePath,
    sourceContext,
    maxRetries,
    timeoutMin,
    // Injected services
    createJob,
    startPhase,
    completePhase,
    completeJob,
    failJob,
    blockJob,
    appendEvent,
    getPool,
    prepareTask,
  } = ctx;
  const providerServices = normalizeProviderServices(ctx.providerServices);

  process.env.CPB_ROOT = cpbRoot;
  if (hubRoot) process.env.CPB_HUB_ROOT = hubRoot;
  if (sourcePath) process.env.CPB_PROJECT_PATH_OVERRIDE = sourcePath;

  // 1. Create job
  const job = await createJob(cpbRoot, {
    project,
    task,
    workflow,
    planMode,
    jobId: ctx.jobId,
    sourceContext: sourceContext || {},
  });
  const jobId = job.jobId;

  await appendEvent(cpbRoot, project, jobId, {
    type: "job_started",
    jobId,
    project,
    task,
    workflow,
    planMode,
    ts: ts(),
  });
  await reportProgress(ctx, { type: "job_started", jobId, project, workflow, planMode });

  if (workflow === "blocked") {
    await appendEvent(cpbRoot, project, jobId, {
      type: "workflow_selected",
      jobId,
      project,
      workflow,
      default: false,
      reason: "blocked by operator",
      ts: ts(),
    });
    const fail = failure({
      kind: FailureKind.UNKNOWN,
      phase: "workflow",
      reason: "blocked by operator",
      retryable: false,
      cause: { code: "workflow_blocked" },
    });
    await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail });
    await reportProgress(ctx, {
      type: "job_blocked",
      jobId,
      project,
      phase: "workflow",
      reason: "blocked by operator",
      failure: { kind: fail.kind, reason: fail.reason },
    });
    return { status: "blocked", jobId, exitCode: 2, failure: fail };
  }

  let riskMap = null;
  let phaseSourceContext = sourceContext || {};
  let dynamicAgentPlan = dynamicAgentPlanFrom(ctx, phaseSourceContext);
  try {
    if (typeof prepareTask !== "function") {
      const err = new Error("prepareTask service is unavailable");
      err.code = "prepare_task_unavailable";
      throw err;
    }

    const prepareResult = await prepareTask(cpbRoot, {
      hubRoot,
      project,
      task,
      jobId,
      sourcePath,
      sourceContext: sourceContext || {},
      workflow,
      planMode,
    });
    riskMap = normalizeRiskMapResult(prepareResult);
    dynamicAgentPlan = prepareResult?.dynamicAgentPlan || dynamicAgentPlanFrom(ctx, { ...(sourceContext || {}), riskMap });
    phaseSourceContext = { ...(sourceContext || {}), riskMap, ...(dynamicAgentPlan ? { dynamicAgentPlan } : {}) };

    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_started",
      jobId,
      project,
      phase: "prepare_task",
      ts: ts(),
    });
    await appendEvent(cpbRoot, project, jobId, {
      type: "riskmap_generated",
      jobId,
      project,
      phase: "prepare_task",
      riskMap,
      riskLevel: riskMap?.riskLevel ?? null,
      domains: riskMap?.domains ?? [],
      highRiskFiles: riskMap?.highRiskFiles ?? [],
      verificationDepth: riskMap?.verificationDepth ?? null,
      adversarialRequired: Boolean(riskMap?.adversarialRequired),
      adversarialFocus: riskMap?.adversarialFocus ?? [],
      confidence: riskMap?.confidence ?? null,
      ts: ts(),
    });
    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_completed",
      jobId,
      project,
      phase: "prepare_task",
      artifact: "riskmap_generated",
      ts: ts(),
    });
    await reportProgress(ctx, {
      type: "riskmap_generated",
      jobId,
      project,
      phase: "prepare_task",
      riskLevel: riskMap?.riskLevel ?? null,
      verificationDepth: riskMap?.verificationDepth ?? null,
      adversarialRequired: Boolean(riskMap?.adversarialRequired),
    });
  } catch (err) {
    const fail = normalizePrepareFailure(err);
    await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail });
    await reportProgress(ctx, {
      type: "job_blocked",
      jobId,
      project,
      phase: "prepare_task",
      reason: fail.cause?.code || fail.reason,
      failure: { kind: fail.kind, reason: fail.reason },
    });
    return { status: "blocked", jobId, exitCode: 2, failure: fail };
  }

  const phaseRoleMap = {
    plan: "planner",
    execute: "executor",
    verify: "verifier",
    adversarial_verify: "adversarial_verifier",
    review: "reviewer",
    remediate: "remediator",
  };

  // 2. Resolve phases and materialize a DAG for this run.
  const { phases: resolvedPhases } = resolveSemanticPhases({ workflow, planMode });
  const phases = insertAdversarialVerify(resolvedPhases, riskMap);
  const workflowDag = buildWorkflowDag({ workflow, phases, phaseRoleMap });
  const dagNodesByPhase = new Map();
  for (const node of workflowDag.nodes) {
    const list = dagNodesByPhase.get(node.phase) || [];
    list.push(node);
    dagNodesByPhase.set(node.phase, list);
  }
  const dagNodeCursorByPhase = new Map();
  await appendEvent(cpbRoot, project, jobId, {
    type: "workflow_dag_materialized",
    jobId,
    project,
    workflow,
    planMode,
    workflowDag,
    nodes: workflowDag.nodes,
    edges: workflowDag.edges,
    ts: ts(),
  });
  await reportProgress(ctx, {
    type: "workflow_dag_materialized",
    jobId,
    project,
    workflow,
    planMode,
    nodeCount: workflowDag.nodes.length,
  });
  if (!dynamicAgentPlan) {
    dynamicAgentPlan = generateDynamicAgentPlan({ riskMap, workflowDag, workflow, planMode });
    phaseSourceContext = { ...phaseSourceContext, dynamicAgentPlan };
  }
  await appendEvent(cpbRoot, project, jobId, {
    type: "dynamic_agent_plan_generated",
    jobId,
    project,
    workflow,
    planMode,
    dynamicAgentPlan,
    riskLevel: dynamicAgentPlan?.riskLevel ?? riskMap?.riskLevel ?? null,
    adversarialRequired: dynamicAgentPlan?.adversarialRequired ?? Boolean(riskMap?.adversarialRequired),
    independentVerifierRequired: Boolean(dynamicAgentPlan?.independentVerifierRequired),
    ts: ts(),
  });
  await reportProgress(ctx, {
    type: "dynamic_agent_plan_generated",
    jobId,
    project,
    riskLevel: dynamicAgentPlan?.riskLevel ?? null,
    independentVerifierRequired: Boolean(dynamicAgentPlan?.independentVerifierRequired),
  });


  // Fail closed: validate dynamic agent plan before execution
  const planValidation = validateDynamicAgentPlan(dynamicAgentPlan, workflowDag);
  if (!planValidation.valid) {
    const blockFail = failure({
      kind: FailureKind.AGENT_CONTRACT_INVALID,
      phase: "dynamic_agent_plan",
      reason: planValidation.reason,
      retryable: false,
      cause: {
        code: "dynamic_agent_plan_validation_failed",
        missingRoles: planValidation.missingRoles,
        planSource: dynamicAgentPlan?.source || null,
      },
    });
    await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: blockFail });
    await appendEvent(cpbRoot, project, jobId, {
      type: "dynamic_agent_plan_invalid",
      jobId,
      project,
      reason: planValidation.reason,
      missingRoles: planValidation.missingRoles,
      ts: ts(),
    });
    await reportProgress(ctx, {
      type: "job_blocked",
      jobId,
      project,
      phase: "dynamic_agent_plan",
      reason: planValidation.reason,
      failure: { kind: blockFail.kind, reason: blockFail.reason },
    });
    return { status: "blocked", jobId, exitCode: 2, failure: blockFail };
  }
  // 3. Get ACP pool
  const pool = getPool();

  // 4. Execute phases sequentially
  const phaseResults = [];
  const state = { planId: null, deliverableId: null, riskMap };

  const envTimeout = Number(process.env.CPB_ACP_POOL_TIMEOUT_MS) || 0;
  // Explicit timeoutMin takes priority, then env var, then disabled
  const phaseTimeout = timeoutMin != null ? (timeoutMin > 0 ? timeoutMin * 60_000 : 0) : envTimeout;

  for (const phase of phases) {
    const fallbackRole = phaseRoleMap[phase] || phase;
    const dagNodes = dagNodesByPhase.get(phase) || [];
    const dagNodeCursor = dagNodeCursorByPhase.get(phase) || 0;
    const dagNode = dagNodes[dagNodeCursor] || dagNodes[dagNodes.length - 1] || { id: phase, phase, role: fallbackRole };
    dagNodeCursorByPhase.set(phase, dagNodeCursor + 1);
    const nodeId = dagNode.id || phase;
    const role = dagNode.role || fallbackRole;
    const phaseAgents = { ...(ctx.agents || {}) };
    const activeDynamicAgentPlan = dynamicAgentPlanFrom(ctx, phaseSourceContext);
    const dynamicAgent = dynamicAgentForRole(activeDynamicAgentPlan, role, phase);
    if (dynamicAgent?.selectedAgent) {
      phaseAgents[role] = dynamicAgent.selectedAgent;
    }
    const phaseRoutingDecision = ctx.routing
      ? resolvePhaseAgentWithFallback({
        routing: ctx.routing,
        phase,
        role,
        agentAvailability: ctx.agentAvailability,
        agentHealth: ctx.agentHealth,
        teamPolicy: ctx.teamPolicy,
      })
      : null;

    if (!dynamicAgent?.selectedAgent && phaseRoutingDecision?.selectedAgent) {
      phaseAgents[role] = phaseRoutingDecision.selectedAgent;
    }

    if (typeof startPhase === "function") {
      await startPhase(cpbRoot, project, jobId, {
        phase,
        agent: phaseRoutingDecision?.selectedAgent || null,
        role,
      });
    } else {
      await appendEvent(cpbRoot, project, jobId, {
        type: "phase_started",
        jobId,
        project,
        phase,
        agent: phaseRoutingDecision?.selectedAgent || null,
        ts: ts(),
      });
    }
    await appendEvent(cpbRoot, project, jobId, {
      type: "dag_node_started",
      jobId,
      project,
      nodeId,
      phase,
      role,
      attempt: 1,
      ts: ts(),
    });
    await reportProgress(ctx, {
      type: "phase_started",
      jobId,
      project,
      phase,
      role,
      agent: phaseRoutingDecision?.selectedAgent || null,
    });

    if (phaseRoutingDecision?.role) {
      await appendEvent(cpbRoot, project, jobId, {
        type: "agent_routing_decision",
        jobId,
        project,
        phase,
        role: phaseRoutingDecision.role,
        preferredAgent: phaseRoutingDecision.preferredAgent,
        selectedAgent: phaseRoutingDecision.selectedAgent,
        fallbackAgent: phaseRoutingDecision.fallbackAgent,
        fallbackAllowed: phaseRoutingDecision.fallbackAllowed,
        fallbackApplied: phaseRoutingDecision.fallbackApplied,
        reason: phaseRoutingDecision.reason,
        ts: ts(),
      });
    }

    // Provider selection + fallback for this phase — consolidated handoff state
    const handoffState = { count: 0, from: null, to: null, reason: null };
    const providerAttempts = [];
    let result = null;

    // Pre-flight: check if preferred provider is available
    if (hubRoot && pool) {
      const preflight = await preflightProvider({
        providerServices, hubRoot, pool, phase, role, agents: phaseAgents, agent: ctx.agent,
      }).catch(() => null);
      if (preflight?.switched) {
        if (dynamicAgent?.required) {
          result = phaseFailed({
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
            reason: result.failure.reason,
            ts: ts(),
          });
          await reportProgress(ctx, {
            type: "provider_quota_blocked",
            jobId,
            project,
            phase,
            role,
            reason: result.failure.reason,
        });
      } else {
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
            ts: ts(),
          });
          await reportProgress(ctx, {
            type: "provider_handoff",
            jobId,
            project,
            phase,
            role,
            from: preflight.from,
            to: preflight.selectedProviderKey,
            reason: preflight.reason,
          });
        }
      } else if (preflight && preflight.available === false) {
        const unavailableKind = dynamicAgent?.required
          ? FailureKind.AGENT_UNAVAILABLE
          : FailureKind.AGENT_RATE_LIMITED;
        result = phaseFailed({
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
          ts: ts(),
        });
        await reportProgress(ctx, {
          type: "provider_quota_blocked",
          jobId,
          project,
          phase,
          role,
          reason: preflight.reason,
        });
      }
    }

    // Run phase (with mid-run quota fallback)
    result ||= await runPhase({
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
      sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
      sourceContext: phaseSourceContext,
      pool,
      state,
      previousResults: phaseResults,
      agent: ctx.agent,
      agents: phaseAgents,
      timeouts: {
        plan: phaseTimeout,
        execute: phaseTimeout,
        verify: phaseTimeout,
        adversarial_verify: phaseTimeout,
        review: phaseTimeout,
        remediate: phaseTimeout,
      },
    });

    // Mid-run quota fallback: retry with different provider on AGENT_RATE_LIMITED
    while (
      hubRoot &&
      !isPhasePassed(result) &&
      result.failure?.kind === FailureKind.AGENT_RATE_LIMITED &&
      result.failure?.retryable &&
      result.failure?.cause?.hardGate !== true &&
      handoffState.count < HANDOFF_MAX_PER_PHASE
    ) {
      handoffState.count += 1;
      const quotaCause = result.failure.cause || {};
      handoffState.from = handoffState.from || quotaCause.providerKey;
      handoffState.to = null; // reset; set below when fallback applied

      // Mark the failed provider as unavailable (via delegate client, fail closed)
      const failedProviderKey = quotaCause.providerKey || resolveProviderKey(pool, phaseAgents[role], ctx.agent);
      const failedAgent = typeof phaseAgents[role] === "object" ? phaseAgents[role]?.agent : phaseAgents[role];
      const failedVariant = typeof phaseAgents[role] === "object" ? phaseAgents[role]?.variant : null;
      // Mark failed provider unavailable via delegate (fail closed)
      let delegateFailure = null;
      try {
        if (typeof providerServices.delegateMarkProviderUnavailable !== "function") {
          const err = new Error("quota delegate client unavailable; provider state not recorded");
          err.code = "QUOTA_DELEGATE_CLIENT_UNAVAILABLE";
          throw err;
        }
        await providerServices.delegateMarkProviderUnavailable(hubRoot, {
          providerKey: failedProviderKey,
          agent: failedAgent,
          variant: failedVariant,
          status: quotaCause.status || "rate_limited",
          nextEligibleAt: quotaCause.nextEligibleAt || Date.now() + 60_000,
          source: quotaCause.source || "run-job-handoff",
          confidence: quotaCause.confidence ?? 0.8,
          reason: result.failure.reason,
        });
      } catch (err) {
        delegateFailure = err;
      }

      // Delegate failure → structured phase failure (don't let runJob() bare-throw)
      if (delegateFailure) {
        result = phaseFailed({
          phase,
          failure: failure({
            kind: FailureKind.RUNTIME_INTERRUPTED,
            phase,
            reason: `quota delegate failure: ${delegateFailure.message}`,
            retryable: true,
            cause: {
              code: delegateFailure.code || "QUOTA_DELEGATE_WRITE_FAILED",
              providerKey: failedProviderKey,
              fallbackCount: handoffState.count,
              providerAttempts: providerAttempts.length > 0 ? providerAttempts : null,
            },
          }),
        });
        break;
      }

      // Track provider attempt for history chain
      providerAttempts.push({
        providerKey: failedProviderKey,
        agent: failedAgent,
        variant: failedVariant,
        status: quotaCause.status || "rate_limited",
        at: new Date().toISOString(),
      });

      // Select fallback provider
      const fallback = await preflightProvider({
        providerServices, hubRoot, pool, phase, role, agents: phaseAgents, agent: ctx.agent,
        excludeProvider: quotaCause.providerKey,
      }).catch(() => null);

      if (!fallback || !fallback.available) {
        // Ensure fallbackCount is in failure cause before breaking
        if (result.failure?.cause) {
          result.failure.cause.fallbackCount = handoffState.count;
          if (providerAttempts.length > 0) {
            result.failure.cause.providerAttempts = providerAttempts;
          }
        }
        await appendEvent(cpbRoot, project, jobId, {
          type: "provider_quota_blocked",
          jobId,
          project,
          phase,
          role,
          reason: "all fallback providers unavailable",
          ts: ts(),
        });
        await reportProgress(ctx, {
          type: "provider_quota_blocked",
          jobId,
          project,
          phase,
          role,
          reason: "all fallback providers unavailable",
        });
        break;
      }

      // Apply fallback agent and update handoff tracking
      phaseAgents[role] = fallback.selectedAgent;
      handoffState.to = fallback.selectedProviderKey;
      handoffState.reason = result.failure.reason;

      // Write fallbackCount into failure cause for orchestrator consumption
      result.failure.cause = { ...result.failure.cause, fallbackCount: handoffState.count };

      await appendEvent(cpbRoot, project, jobId, {
        type: "provider_handoff",
        jobId,
        project,
        phase,
        role,
        from: quotaCause.providerKey,
        to: fallback.selectedProviderKey,
        reason: result.failure.reason,
        midRun: true,
        attempt: handoffState.count,
        ts: ts(),
      });
      await reportProgress(ctx, {
        type: "provider_handoff",
        jobId,
        project,
        phase,
        role,
        from: quotaCause.providerKey,
        to: fallback.selectedProviderKey,
        reason: result.failure.reason,
      });

      // Generate handoff context for continuation prompt (execute phase only)
      let continuationContext = null;
      if (phase === "execute") {
        try {
          continuationContext = await generateHandoffBundle({
            project, jobId, phase, task,
            originProvider: quotaCause.providerKey,
            failureReason: result.failure.reason,
            partialStdout: quotaCause.stdout || "",
            partialStderr: quotaCause.stderr || "",
            previousResults: phaseResults,
            cpbRoot,
            sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
          });
        } catch { /* handoff bundle generation is best-effort */ }
      }

      // Retry the phase with fallback provider
      result = await runPhase({
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
        sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
        sourceContext: continuationContext
          ? { ...phaseSourceContext, handoff: continuationContext }
          : phaseSourceContext,
        pool,
        state,
        previousResults: phaseResults,
        agent: ctx.agent,
        agents: phaseAgents,
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

    // Ensure fallbackCount and providerAttempts are in the failure cause
    if (handoffState.count > 0 && result.failure?.cause) {
      result.failure.cause.fallbackCount = handoffState.count;
      if (providerAttempts.length > 0) {
        result.failure.cause.providerAttempts = providerAttempts;
      }
    }

    // Phase retry: transient/validation failures get a second chance
    const quotaDelegateFailure = String(result.failure?.cause?.code || "").startsWith("QUOTA_DELEGATE_");
    if (!quotaDelegateFailure && !isPhasePassed(result) && PHASE_RETRY_MAX > 0) {
      const isRetryable = result.failure?.retryable || PHASE_RETRYABLE_KINDS.has(result.failure?.kind);
      if (isRetryable) {
        for (let phaseRetry = 1; phaseRetry <= PHASE_RETRY_MAX; phaseRetry++) {
          await appendEvent(cpbRoot, project, jobId, {
            type: "phase_retry",
            jobId,
            project,
            phase,
            attempt: phaseRetry,
            maxAttempts: PHASE_RETRY_MAX,
            failureKind: result.failure?.kind,
            reason: result.failure?.reason,
            ts: ts(),
          });
          await reportProgress(ctx, {
            type: "phase_retry",
            jobId,
            project,
            phase,
            attempt: phaseRetry,
            maxAttempts: PHASE_RETRY_MAX,
            failureKind: result.failure?.kind,
            reason: result.failure?.reason,
          });
          await new Promise((r) => setTimeout(r, phaseRetryBaseDelayMs() * phaseRetry));
          result = await runPhase({
            phase,
            role,
            nodeId,
            dagNode,
            project,
            task,
            jobId,
            job,
            cpbRoot,
            sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
            sourceContext: phaseSourceContext,
            pool,
            state,
            previousResults: phaseResults,
            agent: ctx.agent,
            agents: phaseAgents,
            timeouts: {
              plan: phaseTimeout,
              execute: phaseTimeout,
              verify: phaseTimeout,
              adversarial_verify: phaseTimeout,
              review: phaseTimeout,
              remediate: phaseTimeout,
            },
          });
          if (isPhasePassed(result)) break;
        }
      }
    }

    // Phase feedback retry: validation failures retry with error feedback appended
    if (!isPhasePassed(result) && PHASE_FEEDBACK_RETRY_MAX > 0 && PHASE_FEEDBACK_RETRY_KINDS.has(result.failure?.kind)) {
      for (let retryAttempt = 1; retryAttempt <= PHASE_FEEDBACK_RETRY_MAX; retryAttempt++) {
        const retry = {
          failureKind: result.failure.kind,
          failureReason: result.failure.reason,
          previousOutput: result.failure.stderrSnippet || result.failure.cause?.rawOutput || "",
          attempt: retryAttempt,
        };
        await appendEvent(cpbRoot, project, jobId, {
          type: "phase_feedback_retry",
          jobId,
          project,
          phase,
          attempt: retryAttempt,
          maxAttempts: PHASE_FEEDBACK_RETRY_MAX,
          failureKind: retry.failureKind,
          reason: retry.failureReason,
          ts: ts(),
        });
        await reportProgress(ctx, {
          type: "phase_feedback_retry",
          jobId,
          project,
          phase,
          attempt: retryAttempt,
          maxAttempts: PHASE_FEEDBACK_RETRY_MAX,
          failureKind: retry.failureKind,
          reason: retry.failureReason,
        });
        result = await runPhase({
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
          sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
          sourceContext: { ...phaseSourceContext, retry },
          pool,
          state,
          previousResults: phaseResults,
          agent: ctx.agent,
          agents: phaseAgents,
          timeouts: {
            plan: phaseTimeout,
            execute: phaseTimeout,
            verify: phaseTimeout,
            adversarial_verify: phaseTimeout,
            review: phaseTimeout,
            remediate: phaseTimeout,
          },
        });
        if (isPhasePassed(result)) break;
      }
    }

    // Scope guard: evaluate changed files against fix_scope in retry scenarios
    if (phase === "execute" && isPhasePassed(result)) {
      const retryFixScope = phaseSourceContext?.retryContext?.fix_scope
        || phaseSourceContext?.retry?.fix_scope
        || null;
      if (Array.isArray(retryFixScope) && retryFixScope.length > 0) {
        const rawChangedFiles = result.artifact?.metadata?.changedFiles
          || result.artifact?.files
          || [];
        const cleanPaths = rawChangedFiles
          .map(f => stripGitStatusPrefix(String(f)))
          .filter(Boolean);
        const scopeResult = validateScopeConstraint({
          diffPaths: cleanPaths,
          fixScope: retryFixScope,
        });
        await appendEvent(cpbRoot, project, jobId, {
          type: "scope_guard_evaluated",
          jobId,
          project,
          phase,
          withinScope: scopeResult.withinScope,
          violations: scopeResult.violations,
          fixScope: retryFixScope,
          changedFiles: cleanPaths,
          ts: ts(),
        });
        if (!scopeResult.withinScope) {
          await reportProgress(ctx, {
            type: "scope_guard_violation",
            jobId,
            project,
            phase,
            violations: scopeResult.violations,
            fixScope: retryFixScope,
          });
          await appendEvent(cpbRoot, project, jobId, {
            type: "dag_node_failed",
            jobId,
            project,
            nodeId,
            phase,
            role,
            code: "scope_guard_violation",
            reason: `Scope guard violation: changed files outside fix_scope: ${scopeResult.violations.join(", ")}`,
            error: `Scope guard violation: ${scopeResult.violations.join(", ")}`,
            ts: ts(),
          });
          await failJob(cpbRoot, project, jobId, {
            reason: `Scope guard violation: changed files outside fix_scope: ${scopeResult.violations.join(", ")}`,
            code: "scope_guard_violation",
            phase,
            cause: { violations: scopeResult.violations, fixScope: retryFixScope },
          });
          await reportProgress(ctx, {
            type: "job_failed",
            jobId,
            project,
            phase,
            failureKind: "scope_guard_violation",
            reason: `Scope guard violation: ${scopeResult.violations.join(", ")}`,
          });
          return {
            status: "failed",
            jobId,
            exitCode: 1,
            failure: {
              kind: "scope_guard_violation",
              phase,
              nodeId,
              reason: `Changed files outside fix_scope: ${scopeResult.violations.join(", ")}`,
              violations: scopeResult.violations,
              fixScope: retryFixScope,
            },
            phaseResults,
          };
        }
      }
    }

    phaseResults.push(result);

    // Resolve agent name for this phase (use potentially handoff-modified phaseAgents)
    const rawAgent = phaseAgents[role] || ctx.agent || legacyAgentForPhase(phase);
    const agentName = typeof rawAgent === "object" && rawAgent !== null
      ? (rawAgent.agent || rawAgent.name || legacyAgentForPhase(phase))
      : (rawAgent || legacyAgentForPhase(phase));

    // Track artifacts for subsequent phases
    if (isPhasePassed(result) && result.artifact) {
      const artifactId = extractArtifactId(result.artifact);
      if (phase === "plan") state.planId = artifactId;
      if (phase === "execute") state.deliverableId = artifactId;

      await completePhase(cpbRoot, project, jobId, {
        phase,
        artifact: result.artifact.name,
      });
    }

    if (isPhasePassed(result)) {
      await appendEvent(cpbRoot, project, jobId, {
        type: "dag_node_completed",
        jobId,
        project,
        nodeId,
        phase,
        role,
        artifact: result.artifact?.name || null,
        ts: ts(),
      });
    }

    if (phase === "adversarial_verify" && result.diagnostics?.verdict) {
      await appendEvent(cpbRoot, project, jobId, {
        type: "adversarial_verdict",
        jobId,
        project,
        phase,
        verdict: result.diagnostics.verdict,
        artifact: result.artifact?.name || null,
        status: result.diagnostics.verdict.status || null,
        reason: result.diagnostics.verdict.reason || null,
        ts: ts(),
      });
    }

    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_result",
      jobId,
      project,
      phase,
      agent: agentName,
      status: result.status,
      artifact: result.artifact?.name || null,
      promptArtifact: result.diagnostics?.promptArtifact?.name || null,
      acpAuditFile: result.diagnostics?.acpAuditFile || null,
      usage: result.diagnostics?.usage || null,
      failure: result.failure
        ? { kind: result.failure.kind, reason: result.failure.reason, cause: result.failure.cause || null }
        : null,
      ts: ts(),
    });
    await reportProgress(ctx, {
      type: "phase_result",
      jobId,
      project,
      phase,
      agent: agentName,
      status: result.status,
      artifact: result.artifact?.name || null,
      failure: result.failure
        ? { kind: result.failure.kind, reason: result.failure.reason, cause: result.failure.cause || null }
        : null,
    });

    // Enqueue phase-level provider usage (via delegate client, best-effort)
    if (hubRoot) {
      try {
        if (typeof providerServices.delegateEnqueueProviderUsage === "function") {
          const { agent: resolvedAgent, variant } = resolveRawAgent(phaseAgents, ctx.agent, role, phase);
          const providerKey = resolveProviderKey(pool, phaseAgents[role], ctx.agent);
          const adapter = typeof providerServices.getProviderAdapter === "function"
            ? providerServices.getProviderAdapter(providerKey)
            : null;
          const failCause = result.failure?.cause || {};
          const diag = result.diagnostics || {};

          const hardGateFailed = result.failure?.cause?.hardGate === true;
          let usageStatus = "ok";
          if (!isPhasePassed(result)) {
            if (hardGateFailed) {
              usageStatus = "hard_gate_failed";
            } else if (result.failure?.kind === FailureKind.AGENT_RATE_LIMITED) {
              usageStatus = handoffState.count > 0 ? "fallback" : "rate_limited";
            } else if (result.failure?.kind === FailureKind.TIMEOUT) {
              usageStatus = "timeout";
            } else {
              usageStatus = "error";
            }
          }

          await providerServices.delegateEnqueueProviderUsage(hubRoot, {
            project,
            issueNumber: phaseSourceContext?.issueNumber ?? phaseSourceContext?.github?.issueNumber ?? job?.issueNumber ?? null,
            source: phaseSourceContext?.source || null,
            attempt: phaseSourceContext?.attempt ?? null,
            phase,
            role,
            providerKey: diag.providerKey || providerKey,
            agent: diag.agent || resolvedAgent,
            variant: diag.variant || variant,
            providerRegion: adapter?.region || null,
            providerAdapter: adapter?.providerKeyPattern || null,
            status: usageStatus,
            phaseStatus: isPhasePassed(result) ? "passed" : "failed",
            durationMs: diag.elapsedMs ?? null,
            quota: {
              status: failCause.status || null,
              source: failCause.source || null,
              confidence: failCause.confidence ?? null,
              nextEligibleAt: failCause.nextEligibleAt ?? null,
              retryAfterMs: failCause.retryAfterMs ?? null,
              windowResetAt: failCause.windowResetAt ?? null,
              weeklyResetAt: failCause.weeklyResetAt ?? null,
              reason: failCause.reason || null,
            },
            fallback: handoffState.count > 0 ? {
              used: true,
              fromProviderKey: handoffState.from || failCause.providerKey || null,
              toProviderKey: handoffState.to || diag.providerKey || providerKey,
              count: handoffState.count,
              reason: handoffState.reason || result.failure?.reason || null,
            } : { used: false, fromProviderKey: null, toProviderKey: null, count: 0, reason: null },
            providerAttempts: providerAttempts.length > 0 ? providerAttempts : null,
            usage: normalizePhaseUsage(diag.usage, { hardGateFailed }),
          }).catch(() => null);
        }
      } catch { /* usage tracking is best-effort */ }
    }

    if (!isPhasePassed(result)) {
      const fail = result.failure || {};
      const retryCause = retryFailureCause(fail);
      await appendEvent(cpbRoot, project, jobId, {
        type: "dag_node_failed",
        jobId,
        project,
        nodeId,
        phase,
        role,
        code: fail.kind || "fatal",
        reason: fail.reason || `${phase} phase failed`,
        error: fail.reason || `${phase} phase failed`,
        ts: ts(),
      });
      await failJob(cpbRoot, project, jobId, {
        reason: fail.reason || `${phase} phase failed`,
        code: fail.kind || "fatal",
        phase,
        cause: { ...fail, nodeId },
      });
      await reportProgress(ctx, {
        type: "job_failed",
        jobId,
        project,
        phase,
        failureKind: fail.kind || null,
        reason: fail.reason || `${phase} phase failed`,
      });

      return {
        status: "failed",
        jobId,
        exitCode: 1,
        failure: {
          kind: fail.kind,
          phase,
          nodeId,
          reason: fail.reason,
          retryable: fail.retryable,
          ...(retryCause || fail.cause ? { cause: retryCause || fail.cause } : {}),
        },
        phaseResults,
      };
    }
  }

  // 5. Evaluate completion gate before completing
  const verifyResult = phaseResults.find(r => r?.phase === "verify");
  const adversarialResult = phaseResults.find(r => r?.phase === "adversarial_verify");
  const verdictText = verifyResult?.verdict || verifyResult?.artifact?.content || verifyResult?.artifact?.metadata || null;
  const adversarialVerdictText = adversarialResult?.verdict || adversarialResult?.artifact?.content || adversarialResult?.artifact?.metadata || null;
  const parsedVerdict = parseVerdict(verdictText);
  const parsedAdversarialVerdict = parseVerdict(adversarialVerdictText);

  const completedPhases = phaseResults.filter(r => r && isPhasePassed(r)).map(r => r.phase);
  const jobForGate = { ...job, completedPhases };

  const gateResult = evaluateCompletionGate({
    job: jobForGate,
    workflowDag,
    riskMap,
    dynamicAgentPlan,
    artifactIndex: null,
    parsedVerdict,
    parsedAdversarialVerdict,
  });

  await appendEvent(cpbRoot, project, jobId, completionGateEvent(jobId, project, gateResult));

  if (gateResult.outcome !== "complete") {
    const adversarialRetryContext = buildAdversarialRetryContext(gateResult, phaseResults, riskMap);
    const failCause = {
      gateOutcome: gateResult.outcome,
      missingGates: gateResult.missingGates,
      details: gateResult.details,
    };
    if (adversarialRetryContext) {
      failCause.retryContext = adversarialRetryContext;
    }

    await reportProgress(ctx, {
      type: "completion_gate_blocked",
      jobId,
      project,
      outcome: gateResult.outcome,
      reason: gateResult.reason,
    });
    await failJob(cpbRoot, project, jobId, {
      reason: gateResult.reason,
      code: gateResult.outcome,
      phase: "completion_gate",
      cause: failCause,
    });
    return {
      status: "failed",
      jobId,
      exitCode: 1,
      failure: { kind: gateResult.outcome, phase: "completion_gate", reason: gateResult.reason, details: gateResult.details },
      phaseResults,
    };
  }

  await reportProgress(ctx, { type: "completion_gate_passed", jobId, project });

  // 6. Complete job
  await completeJob(cpbRoot, project, jobId);
  await reportProgress(ctx, { type: "job_completed", jobId, project });

  return {
    status: "completed",
    jobId,
    exitCode: 0,
    failure: null,
    phaseResults,
  };
}

// ─── Provider Selection Helpers ─────────────────────────────────────

function resolveRawAgent(agents, agent, role, phase) {
  const raw = agents?.[role] || agent || legacyAgentForPhase(phase);
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || raw.name || legacyAgentForPhase(phase), variant: raw.variant || null };
  return { agent: raw, variant: null };
}

function resolveProviderKey(pool, rawAgent, defaultAgent) {
  const { agent, variant } = typeof rawAgent === "object" && rawAgent !== null
    ? { agent: rawAgent.agent || defaultAgent, variant: rawAgent.variant || null }
    : { agent: rawAgent || defaultAgent, variant: null };
  if (pool?.providerKey) return pool.providerKey(agent, variant);
  if (variant && agent === "claude") return `claude:${variant}`;
  return agent;
}

/**
 * Pre-flight provider availability check.
 * Returns { available, switched, selectedAgent, selectedProviderKey, reason, from } or null.
 */
async function preflightProvider({ providerServices, hubRoot, pool, phase, role, agents, agent, excludeProvider = null }) {
  const assertProviderAvailable = providerServices?.assertProviderAvailable;
  if (typeof assertProviderAvailable !== "function" || !hubRoot) return null;

  const { agent: resolvedAgent, variant } = resolveRawAgent(agents, agent, role, phase);
  const providerKey = resolveProviderKey(pool, agents?.[role], agent);

  // Check preferred provider
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
      // Preferred is unavailable — try fallbacks
    }
  }

  // Try fallback candidates supplied by the runtime pool/configuration.
  const fallbackCandidates = getFallbackCandidates(pool, resolvedAgent, variant, excludeProvider || providerKey);
  for (const candidate of fallbackCandidates) {
    try {
      await assertProviderAvailable(hubRoot, {
        providerKey: candidate.providerKey,
        agent: candidate.agent,
        variant: candidate.variant,
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

function getFallbackCandidates(pool, agent, currentVariant, excludeKey) {
  if (pool?.fallbackCandidates) {
    try {
      const poolCandidates = pool.fallbackCandidates(agent, currentVariant, excludeKey);
      return Array.isArray(poolCandidates) ? poolCandidates : [];
    } catch {
      return [];
    }
  }
  return [];
}
