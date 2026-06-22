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
import { AnyRecord } from "../../shared/types.js";
import { resolveSemanticPhases } from "./phase-policy.js";
import { isPhasePassed, phaseFailed } from "../contracts/phase-result.js";
import { FailureKind, failure } from "../contracts/failure.js";
import { legacyAgentForPhase } from "../agents/registry.js";
import { generateHandoffBundle } from "../handoff/handoff-bundle.js";
import { buildWorkflowDag, insertAdversarialVerify } from "./dag-builder.js";
import { generateDynamicAgentPlan, validateDynamicAgentPlan } from "../agents/dynamic-agent-plan.js";
import { normalizeProviderServices, preflightProvider } from "./provider-handoff.js";
import { runQuotaFallbackRetry } from "./provider-quota-fallback.js";
import { recordPhaseProviderUsage } from "./provider-usage-recorder.js";
import { runPhaseRetryLoops } from "./phase-retry.js";
import { evaluatePoisonedSessionGate } from "./poisoned-session-gate.js";
import { handleDagNodeFailure } from "./dag-node-failure.js";
import { evaluateExecuteScopeGuard } from "./scope-guard-runner.js";
import { emitDiagnosticArtifactEvents, writeRuntimeArtifactEvent } from "./runtime-artifact-events.js";
import { runCompletionGate } from "./completion-gate-runner.js";
import { emitPhaseResultEvent } from "./phase-result-events.js";
import { emitPhaseStartEvents } from "./phase-start-events.js";
import { emitDagNodeCompletedEvent } from "./dag-node-lifecycle-events.js";
import { emitAdversarialVerdictEvent } from "./adversarial-verdict-events.js";
import { trackPassedPhaseArtifact } from "./phase-artifact-tracker.js";
import { handleResumeCompletedDagNode } from "./dag-node-resume.js";
import { resolveDynamicAgentPlan, resolvePhaseAgentRouting } from "./phase-agent-routing.js";
import {
  attachChecklistIdsToWorkflowDag,
  dagSequentialExecutionPlan,
  normalizeDagResumeContext,
  recoveredArtifactForPhase,
  recoveredVerdictForPhase,
} from "./run-job-planning.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import {
  buildAcceptanceChecklist,
  classifyAcceptanceRequirements,
  validateAcceptanceChecklist,
  validateChecklistSourceCoverage,
} from "../workflow/acceptance-checklist.js";
import { decomposeTaskToChecklistItems } from "../workflow/checklist-decomposer.js";


function ts() {
  return new Date().toISOString();
}

async function reportProgress(ctx: AnyRecord, event: AnyRecord) {
  if (typeof ctx.onProgress !== "function") return;
  try {
    await ctx.onProgress({ ts: ts(), ...event });
  } catch {
    // Progress reporting must not change job execution outcome.
  }
}

function normalizePrepareFailure(err: Record<string, unknown> & { message?: string }) {
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

async function blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail }: AnyRecord) {
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

function normalizeRiskMapResult(result: AnyRecord | null | undefined) {
  return result?.riskMap || result?.riskmap || result;
}

// dagForRun and phasesWithAdversarialVerify extracted to dag-builder.js
// (buildWorkflowDag and insertAdversarialVerify)

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
/**
 * Exit-handler-style finalization for audit closure.
 * Must run for success, failure, blocked, and panic paths.
 * Emits runtime_context_snapshot and audit_finalized events.
 * Does not let finalization mark a failed job as successful.
 */
async function finalizeAuditTrail({ cpbRoot, project, jobId, attemptId, appendEvent, result, sourceContext }: AnyRecord) {
  // Emit runtime context snapshot — audit context, not pass evidence.
  const assignment = sourceContext?.assignment || {};
  try {
    await appendEvent(cpbRoot, project, jobId, {
      type: "runtime_context_snapshot",
      jobId,
      project,
      attemptId,
      assignmentId: assignment.assignmentId || null,
      workerId: assignment.workerId || null,
      model: assignment.metadata?.model || null,
      runtime: assignment.metadata?.runtime || assignment.workflow || null,
      queueId: assignment.entryId || null,
      queuePriority: assignment.priority ?? null,
      concurrencyKey: assignment.metadata?.concurrencyKey || null,
      rateLimitedUntil: assignment.rateLimitedUntil || null,
      heartbeatAt: null,
      progressKind: null,
      blocker: result.failure?.kind === FailureKind.HUMAN_APPROVAL_REQUIRED ? result.failure.reason : null,
      ts: ts(),
    });
  } catch { /* best-effort */ }

  // Emit audit_finalized — terminal audit closure event.
  // This event is audit-only and does not change job status.
  try {
    await appendEvent(cpbRoot, project, jobId, {
      type: "audit_finalized",
      jobId,
      project,
      attemptId,
      status: result.status || "failed",
      reason: result.failure?.reason || result.reason || null,
      ts: ts(),
    });
  } catch { /* best-effort */ }
}

/**
 * Crash barrier wrapper — catches unhandled exceptions from runJobInner()
 * and ensures the job is failed rather than stuck in "running" forever.
 */
export async function runJob(ctx: AnyRecord) {
  ctx._jobId = "unknown";
  ctx._currentPhase = null;
  try {
    const result = await runJobInner(ctx);
    // Exit-handler-style finalization: emit runtime context and audit closure.
    // Must run for success, failure, and blocked paths. Best-effort — must not
    // turn a successful result into a panic.
    try {
      await finalizeAuditTrail({
        cpbRoot: ctx.cpbRoot,
        project: ctx.project || "unknown",
        jobId: result.jobId || ctx._jobId,
        attemptId: ctx._attemptId || result.jobId || ctx._jobId,
        appendEvent: ctx.appendEvent,
        result,
        sourceContext: ctx.sourceContext,
      });
    } catch { /* best-effort finalization must not corrupt the result */ }
    return result;
  } catch (panic) {
    const result = await handleRunJobPanic(ctx, panic);
    // Finalize even after panic recovery — best-effort
    try {
      await finalizeAuditTrail({
        cpbRoot: ctx.cpbRoot,
        project: ctx.project || "unknown",
        jobId: result.jobId || ctx._jobId,
        attemptId: ctx._attemptId || result.jobId || ctx._jobId,
        appendEvent: ctx.appendEvent,
        result,
        sourceContext: ctx.sourceContext,
      });
    } catch { /* best-effort finalization must not corrupt the result */ }
    return result;
  }
}

/**
 * Phase 1: Create the job record, derive attemptId, emit job_started, and
 * short-circuit when the workflow is operator-blocked.
 *
 * Returns a discriminated union: `{ kind: "blocked", result }` terminates the
 * job with a blocked status; `{ kind: "ok", job, jobId, attemptId }` proceeds
 * to prepareTask.
 */
async function createJobAndHandleBlocked(ctx: AnyRecord) {
  const {
    cpbRoot,
    project,
    task,
    workflow = "standard",
    planMode = "full",
    sourceContext,
    createJob,
    blockJob,
    appendEvent,
  } = ctx;

  const job = await createJob(cpbRoot, {
    project,
    task,
    workflow,
    planMode,
    jobId: ctx.jobId,
    sourceContext: sourceContext || {},
  });
  const jobId = job.jobId;
  ctx._jobId = jobId;  // Crash barrier needs jobId before runJobInner completes

  // Derive attemptId from assignment context for checklist-aware attempt scoping.
  // Direct runs without managed assignments use jobId as the compatibility attempt id.
  const activeAttempt = sourceContext?.assignment?.attemptToken
    || sourceContext?.assignment?.attempt
    || sourceContext?.attemptToken
    || sourceContext?.attempt;
  const attemptId = activeAttempt ? String(activeAttempt) : jobId;
  ctx._attemptId = attemptId;

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

  if (workflow !== "blocked") {
    return { kind: "ok", job, jobId, attemptId };
  }

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
  return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: fail } };
}

/**
 * Phase 2: Run prepareTask to produce the risk map, dynamic agent plan, and
 * the enriched phase source context. Short-circuits to "blocked" when
 * prepareTask is unavailable or fails.
 *
 * Returns `{ kind: "blocked", result }` or
 * `{ kind: "ok", riskMap, phaseSourceContext, dynamicAgentPlan }`.
 */
async function prepareTaskAndRiskMap(ctx: AnyRecord, { job, jobId }: AnyRecord) {
  const {
    cpbRoot,
    hubRoot,
    project,
    task,
    workflow = "standard",
    planMode = "full",
    sourcePath,
    sourceContext,
    blockJob,
    appendEvent,
    prepareTask,
  } = ctx;

  let riskMap = null;
  let phaseSourceContext = sourceContext || {};
  let dynamicAgentPlan = resolveDynamicAgentPlan({
    dynamicAgentPlan: ctx.dynamicAgentPlan,
    phaseSourceContext,
    sourceContext: ctx.sourceContext,
  });
  try {
    if (typeof prepareTask !== "function") {
      const err = Object.assign(new Error("prepareTask service is unavailable"), { code: "prepare_task_unavailable" });
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
    dynamicAgentPlan = prepareResult?.dynamicAgentPlan || resolveDynamicAgentPlan({
      dynamicAgentPlan: ctx.dynamicAgentPlan,
      phaseSourceContext: { ...(sourceContext || {}), riskMap },
      sourceContext: ctx.sourceContext,
    });
    phaseSourceContext = { ...(sourceContext || {}), riskMap, ...(dynamicAgentPlan ? { dynamicAgentPlan } : {}), ...(prepareResult?.acceptanceChecklist ? { acceptanceChecklist: prepareResult.acceptanceChecklist } : {}), ...(prepareResult?.requirementClassification ? { requirementClassification: prepareResult.requirementClassification } : {}) };

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
    return { kind: "ok", riskMap, phaseSourceContext, dynamicAgentPlan };
  } catch (err) {
    const fail = normalizePrepareFailure(err);
    await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail });
    await reportProgress(ctx, {
      type: "job_blocked",
      jobId,
      project,
      phase: "prepare_task",
      reason: (fail.cause as AnyRecord | undefined)?.code || fail.reason,
      failure: { kind: fail.kind, reason: fail.reason },
    });
    return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: fail } };
  }
}

/**
 * Phase 3: Freeze the acceptance checklist (validate + coverage-check + persist),
 * materialize the workflow DAG, and generate + fail-closed validate the dynamic
 * agent plan. This is the checklist-first invariant boundary: the checklist must
 * be event-indexed before the DAG and plan are consumed.
 *
 * Inputs mutate `phaseSourceContext` / `dynamicAgentPlan`. Returns
 * `{ kind: "blocked", result }` or `{ kind: "ok", ...dagInputs }`.
 */
async function freezeChecklistAndMaterializeDag(ctx: AnyRecord, {
  jobId, riskMap, phaseSourceContext, dynamicAgentPlan,
}: AnyRecord) {
  const {
    cpbRoot,
    project,
    task,
    workflow = "standard",
    planMode = "full",
    sourceContext,
    dataRoot,
    blockJob,
    appendEvent,
  } = ctx;

  // ── Checklist generation, validation, and persistence ────────────
  // The acceptance checklist is auto-constructed for every job (task +
  // documents + riskMap) unless the caller provides one. Both paths feed
  // the same validate → persist → event-index pipeline; the verify phase's
  // deterministic probe runner supplies objective scope evidence for these
  // items, so there is no silent legacy-verifier fallback.
  let acceptanceChecklist: AnyRecord | null = phaseSourceContext?.acceptanceChecklist || null;
  const documents = phaseSourceContext?.documents || [];
  const requirementClassification = phaseSourceContext?.requirementClassification
    || await classifyAcceptanceRequirements({ task, documents, riskMap });
  if (!acceptanceChecklist) {
    // LLM decomposition: break the task into items carrying allowedFiles scope so
    // the probe runner matches >0 and the default checklist closes in production.
    // Default-on; CPB_CHECKLIST_DECOMPOSE=0 disables it for debugging. Fail-closed
    // ARTIFACT_INVALID on any failure — never silently drop through to the
    // deterministic []-scope builder, or production stays broken.
    let decomposedItems;
    if (process.env.CPB_CHECKLIST_DECOMPOSE !== "0") {
      const decomposition = await decomposeTaskToChecklistItems({ task, documents, ctx });
      if (!decomposition.ok) {
        const decompFail = failure({
          kind: FailureKind.ARTIFACT_INVALID,
          phase: "prepare_task",
          reason: `checklist decomposition failed: ${decomposition.reason}`,
          retryable: false,
          cause: { decomposition },
        });
        await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: decompFail });
        return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: decompFail } };
      }
      decomposedItems = decomposition.items;
    }
    acceptanceChecklist = await buildAcceptanceChecklist({
      jobId, project, task, documents, riskMap, requirementClassification, decomposedItems,
    });
  }
  let acceptanceChecklistArtifact: AnyRecord | null = null;
  if (acceptanceChecklist) {
    const validation = validateAcceptanceChecklist(acceptanceChecklist);
    if (!validation.ok) {
      const fail = failure({
        kind: FailureKind.ARTIFACT_INVALID,
        phase: "prepare_task",
        reason: `acceptance checklist invalid: ${validation.reason}`,
        retryable: false,
        cause: { acceptanceChecklist },
      });
      await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail });
      return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: fail } };
    }
    const coverage = validateChecklistSourceCoverage({
      checklist: acceptanceChecklist,
      task,
      documents,
      requirementClassification,
    });
    if (!coverage.ok) {
      const fail = failure({
        kind: FailureKind.HUMAN_APPROVAL_REQUIRED,
        phase: "prepare_task",
        reason: `acceptance checklist source coverage incomplete: ${coverage.reason}`,
        retryable: false,
        cause: { routingLabel: "needs_clarification", coverage },
      });
      await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail });
      return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: fail } };
    }
    acceptanceChecklistArtifact = await writeArtifact(cpbRoot, {
      project,
      jobId,
      kind: "acceptance-checklist",
      content: JSON.stringify(acceptanceChecklist, null, 2),
      dataRoot,
      metadata: acceptanceChecklist,
    });
    await writeRuntimeArtifactEvent({
      cpbRoot,
      project,
      jobId,
      phase: "prepare_task",
      artifact: acceptanceChecklistArtifact,
      appendEvent,
      attemptId: ctx._attemptId,
      now: ts,
    });
    phaseSourceContext = { ...phaseSourceContext, acceptanceChecklist, acceptanceChecklistArtifact };

    // If a prebuilt dynamicAgentPlan does not reference the frozen checklist,
    // rebuild it so phases consume the artifact-indexed checklist.
    if (dynamicAgentPlan && !dynamicAgentPlan.acceptanceChecklistArtifactId && !dynamicAgentPlan.acceptanceChecklistArtifact) {
      dynamicAgentPlan = null;
    }
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
  const workflowDag = attachChecklistIdsToWorkflowDag(buildWorkflowDag({ workflow, phases, phaseRoleMap }), acceptanceChecklist);
  const executionNodes = dagSequentialExecutionPlan(workflowDag);
  const dagResumeContext = normalizeDagResumeContext(sourceContext || {});
  const resumeCompletedNodes = new Set(dagResumeContext.completedNodeIds);
  await appendEvent(cpbRoot, project, jobId, {
    type: "workflow_dag_materialized",
    jobId,
    project,
    workflow,
    planMode,
    workflowDag,
    nodes: workflowDag.nodes,
    edges: workflowDag.edges,
    executionMode: "node_first_sequential",
    dagMetadataReady: true,
    dagNodeFirstSequentialReady: true,
    dagParallelExecutionReady: false,
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
    return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: blockFail } };
  }

  return {
    kind: "ok",
    phaseSourceContext,
    dynamicAgentPlan,
    workflowDag,
    executionNodes,
    dagResumeContext,
    resumeCompletedNodes,
    phaseRoleMap,
    acceptanceChecklist,
  };
}

async function runJobInner(ctx: AnyRecord) {
  const {
    cpbRoot,
    hubRoot,
    project,
    task,
    workflow = "standard",
    planMode = "full",
    sourcePath,
    sourceContext,
    dataRoot,
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
  if (dataRoot) process.env.CPB_PROJECT_RUNTIME_ROOT = dataRoot;
  if (sourcePath) process.env.CPB_PROJECT_PATH_OVERRIDE = sourcePath;

  // 1. Create job (+ operator-blocked short-circuit)
  const created = await createJobAndHandleBlocked(ctx);
  if (created.kind === "blocked") return created.result;
  const { job, jobId, attemptId } = created;

  // 2. prepareTask → risk map + dynamic agent plan + enriched source context
  const prepared = await prepareTaskAndRiskMap(ctx, { job, jobId });
  if (prepared.kind === "blocked") return prepared.result;
  let { riskMap, phaseSourceContext, dynamicAgentPlan } = prepared;

  // Declared here (not const) because the checklist/DAG phase rebinds them.
  let workflowDag: AnyRecord;
  let executionNodes: AnyRecord[];
  let dagResumeContext: AnyRecord;
  let resumeCompletedNodes: Set<string>;
  let phaseRoleMap: AnyRecord;
  let acceptanceChecklist: AnyRecord | null;

  // 3. Freeze acceptance checklist, materialize workflow DAG, generate +
  //    validate dynamic agent plan. Short-circuits to "blocked" on any
  //    checklist/coverage/plan-validation failure (fail-closed invariant).
  const materialized = await freezeChecklistAndMaterializeDag(ctx, {
    jobId, riskMap, phaseSourceContext, dynamicAgentPlan,
  });
  if (materialized.kind === "blocked") return materialized.result;
  ({
    phaseSourceContext,
    dynamicAgentPlan,
    workflowDag,
    executionNodes,
    dagResumeContext,
    resumeCompletedNodes,
    phaseRoleMap,
    acceptanceChecklist,
  } = materialized);

  // 2.5. Clear session cache if forceFreshSession is requested (rerun vs retry)
  if (sourceContext?.retry?.forceFreshSession && cpbRoot) {
    try {
      const { clearSessionId } = await import("../agents/session-cache.js");
      await Promise.allSettled([
        clearSessionId(cpbRoot, "codex"),
        clearSessionId(cpbRoot, "claude"),
      ]);
    } catch {
      // Session cache clearing is best-effort.
    }
  }

  // 3. Get ACP pool
  const pool = getPool();

  // 4. Execute phases sequentially
  const phaseResults: AnyRecord[] = [];
  const state: AnyRecord = { planId: null, deliverableId: null, riskMap };

  const envTimeout = Number(process.env.CPB_ACP_POOL_TIMEOUT_MS) || 0;
  // Explicit timeoutMin takes priority, then env var, then disabled
  const phaseTimeout = timeoutMin != null ? (timeoutMin > 0 ? timeoutMin * 60_000 : 0) : envTimeout;

  for (const dagNode of executionNodes) {
    const phase = dagNode.phase;
    ctx._currentPhase = phase;  // Crash barrier tracking
    const fallbackRole = phaseRoleMap[phase] || phase;
    const nodeId = dagNode.id || phase;
    const role = dagNode.role || fallbackRole;
    if (resumeCompletedNodes.has(nodeId)) {
      const artifact = recoveredArtifactForPhase(phaseSourceContext, phase, { cpbRoot, project, dataRoot });
      await handleResumeCompletedDagNode({
        cpbRoot,
        project,
        jobId,
        nodeId,
        phase,
        role,
        dagNode,
        artifact,
        verdict: recoveredVerdictForPhase(phaseSourceContext, phase),
        resumeTarget: dagResumeContext.resumeTarget,
        state,
        phaseResults,
        appendEvent,
        onProgress: ctx.onProgress,
        now: ts,
      });
      continue;
    }
    const {
      phaseAgents,
      dynamicAgent,
      phaseRoutingDecision,
      effectiveSelectedAgent,
    } = resolvePhaseAgentRouting({
      agents: ctx.agents,
      dynamicAgentPlan: ctx.dynamicAgentPlan,
      phaseSourceContext,
      sourceContext: ctx.sourceContext,
      routing: ctx.routing,
      agentAvailability: ctx.agentAvailability,
      agentHealth: ctx.agentHealth,
      teamPolicy: ctx.teamPolicy,
      phase,
      role,
    });

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
      startPhase,
      appendEvent,
      onProgress: ctx.onProgress,
      now: ts,
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
    const handoffState: { count: number; from: string | null; to: string | null; reason: string | null } = {
      count: 0,
      from: null,
      to: null,
      reason: null,
    };
    const providerAttempts: Array<{ providerKey: string | null; agent: string | null; variant: string | null; status: string; at: string }> = [];
    let result: AnyRecord | null = null;

    // Pre-flight: check if preferred provider is available
    if (hubRoot && pool) {
      const preflight = await preflightProvider({
        providerServices, hubRoot, pool, phase, role, agents: phaseAgents, agent: ctx.agent,
      }).catch((): null => null);
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
      dataRoot,
      sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
      sourceContext: phaseSourceContext,
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

    // Mid-run quota fallback: retry with different provider on AGENT_RATE_LIMITED.
    // runQuotaFallbackRetry mutates nodeCtx (handoffState/providerAttempts/phaseAgents)
    // and returns the latest phase result.
    result = await runQuotaFallbackRetry(ctx, {
      hubRoot, pool, phase, role, nodeId, dagNode, project, task, jobId, job,
      workflow, planMode, cpbRoot, dataRoot, sourcePath, phaseSourceContext,
      state, phaseResults, attemptId, phaseTimeout,
      handoffState, providerAttempts, phaseAgents, result,
    }, {
      runPhase,
      generateHandoffBundle,
    });

    // Ensure fallbackCount and providerAttempts are in the failure cause
    if (handoffState.count > 0 && result.failure?.cause) {
      result.failure.cause.fallbackCount = handoffState.count;
      if (providerAttempts.length > 0) {
        result.failure.cause.providerAttempts = providerAttempts;
      }
    }

    // Phase retry + feedback retry: transient failures get a second chance, then
    // validation failures retry with error feedback appended. Skipped entirely
    // when the failure was a quota-delegate write problem.
    result = await runPhaseRetryLoops(ctx, {
      phase, role, nodeId, dagNode, project, task, jobId, job,
      workflow, planMode, cpbRoot, dataRoot, sourcePath, phaseSourceContext,
      state, phaseResults, attemptId, phaseTimeout, phaseAgents, result, pool,
    }, {
      runPhase,
    });

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
      phaseResults,
      appendEvent,
      failJob,
      onProgress: ctx.onProgress,
      now: ts,
    });
    if (scopeGuardFailure) return scopeGuardFailure;

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
      now: ts,
    });

    // Resolve agent name for this phase (use potentially handoff-modified phaseAgents)
    const rawAgent = phaseAgents[role] || ctx.agent || legacyAgentForPhase(phase);
    const agentName = typeof rawAgent === "object" && rawAgent !== null
      ? (rawAgent.agent || rawAgent.name || legacyAgentForPhase(phase))
      : (rawAgent || legacyAgentForPhase(phase));

    result = await evaluatePoisonedSessionGate({
      cpbRoot, project, jobId, phase, nodeId, attemptId, result, appendEvent,
      now: ts,
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
        now: ts,
      });
    }

    await emitAdversarialVerdictEvent({
      cpbRoot,
      project,
      jobId,
      phase,
      phaseResult: result,
      appendEvent,
      now: ts,
    });

    await emitPhaseResultEvent({
      cpbRoot,
      project,
      jobId,
      phase,
      agentName,
      phaseResult: result,
      appendEvent,
      onProgress: ctx.onProgress,
      now: ts,
    });

    await recordPhaseProviderUsage({
      providerServices,
      hubRoot,
      pool,
      agent: ctx.agent,
      phaseAgents,
      project,
      job,
      phaseSourceContext,
      phase,
      role,
      result,
      handoffState,
      providerAttempts,
    });

    if (!isPhasePassed(result)) {
      return handleDagNodeFailure({
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
        appendEvent,
        failJob,
        onProgress: ctx.onProgress,
        now: ts,
      });
    }
  }

  // 5. Evaluate completion gate before completing
  return runCompletionGate({
    cpbRoot,
    project,
    jobId,
    job,
    workflowDag,
    riskMap,
    dynamicAgentPlan,
    phaseResults,
    dataRoot,
    attemptId,
    getArtifactIndex: ctx.getArtifactIndex,
    appendEvent,
    failJob,
    completeJob,
    onProgress: ctx.onProgress,
    now: ts,
  });
}

// ─── Panic Recovery ──────────────────────────────────────────────────

/**
 * Crash barrier handler — invoked when runJobInner() throws an unhandled
 * exception.  Best-effort fails the job so it doesn't remain stuck in
 * "running" state forever.
 */
async function handleRunJobPanic(ctx: AnyRecord, panic: Error | { message?: string; stack?: string }) {
  const { cpbRoot, project, failJob, appendEvent } = ctx;
  const jobId = ctx._jobId || "unknown";
  const phase = ctx._currentPhase || "unknown";

  const panicMessage = panic?.message || (panic == null ? "unknown panic" : String(panic));
  const panicType = panic?.constructor?.name || "Error";

  // Best-effort: fail the job and write a terminal event.
  // Both operations are fire-and-forget — if they fail we still return
  // a structured result so the caller can handle it.
  const failPromise = (async () => {
    if (typeof failJob === "function" && jobId !== "unknown") {
      try {
        await failJob(cpbRoot, project, jobId, {
          reason: `runJob panic: ${panicMessage}`,
          code: "FATAL",
          phase,
          cause: {
            kind: "runjob_panic",
            stack: panic?.stack?.slice(0, 4000) || null,
            panicType,
          },
        });
      } catch { /* best-effort */ }
    }
    if (typeof appendEvent === "function" && jobId !== "unknown") {
      try {
        await appendEvent(cpbRoot, project, jobId, {
          type: "job_panic",
          jobId,
          phase,
          attemptId: ctx._attemptId || jobId,
          panicType,
          reason: panicMessage,
          ts: ts(),
        });
      } catch { /* best-effort */ }
    }
  })();

  // Await with timeout — ensures failJob/appendEvent execute before returning.
  // If failPromise itself hangs (3s budget), we still return the structured failure.
  try {
    await Promise.race([
      failPromise,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch { /* best-effort — timeout or rejection */ }

  return {
    status: "failed",
    jobId,
    exitCode: 1,
    failure: {
      kind: FailureKind.RUNJOB_PANIC,
      phase,
      reason: panicMessage,
      retryable: false,
      cause: { panicType, stack: panic?.stack?.slice(0, 2000) || null },
    },
  };
}

export function runJobExecutionContract() {
  return {
    usesPhasePolicy: true,
    callsCompletionGate: true,
    scopeGuardBlocksOnViolation: true,
    passesDagToPlanValidation: true,
    dagNodeFirstSequentialReady: true,
    dagParallelExecutionReady: false,
  };
}
