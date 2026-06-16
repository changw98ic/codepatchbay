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
import { readFile as _readFile } from "node:fs/promises";
import path from "node:path";
import { AnyRecord } from "../../shared/types.js";
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
import { readyNodes, getNode } from "../workflow/dag-executor.js";
import { resolveArtifactPath, resolveArtifactPathForRoot } from "../artifacts/artifact-paths.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import {
  buildAcceptanceChecklist,
  classifyAcceptanceRequirements,
  validateAcceptanceChecklist,
  validateChecklistSourceCoverage,
  normalizeFixScope,
  mapChecklistRoutingLabel,
} from "../workflow/acceptance-checklist.js";
import { decomposeTaskToChecklistItems } from "../workflow/checklist-decomposer.js";
import { readActiveChecklistArtifacts } from "../workflow/checklist-artifacts.js";


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

function numericEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function phaseRetryBaseDelayMs() {
  return numericEnv("CPB_PHASE_RETRY_BASE_DELAY_MS", PHASE_RETRY_BASE_DELAY_MS);
}

function dagSequentialExecutionPlan(workflowDag: AnyRecord) {
  const nodes = Array.isArray(workflowDag?.nodes) ? workflowDag.nodes : [];
  const completed = new Set<string>();
  const planned = [];

  while (planned.length < nodes.length) {
    const [nodeId] = readyNodes(nodes, completed);
    if (!nodeId) {
      throw new Error(`DAG has no ready node after ${planned.length}/${nodes.length} node(s)`);
    }
    const node = getNode(nodes, nodeId);
    if (!node) {
      throw new Error(`DAG ready node is missing from workflow: ${nodeId}`);
    }
    planned.push(node);
    completed.add(nodeId);
  }

  return planned;
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function normalizeDagResumeContext(sourceContext: AnyRecord = {}) {
  const retry = sourceContext?.retry && typeof sourceContext.retry === "object" ? sourceContext.retry : {};
  const dagResume = sourceContext?.dagResume && typeof sourceContext.dagResume === "object" ? sourceContext.dagResume : {};
  const previousFailure = sourceContext?.previousFailure && typeof sourceContext.previousFailure === "object" ? sourceContext.previousFailure : {};
  const completedNodeIds = [
    ...arrayOfStrings(dagResume.completedNodeIds),
    ...arrayOfStrings(retry.completedNodeIds),
    ...arrayOfStrings(previousFailure.completedNodeIds),
  ];
  const resumeTarget = retry.resumeTarget || dagResume.resumeTarget || previousFailure.resumeTarget || null;
  return {
    completedNodeIds: [...new Set(completedNodeIds)],
    resumeTarget: resumeTarget && typeof resumeTarget === "object" ? { ...resumeTarget } : null,
  };
}

function artifactKindForPhase(phase: string) {
  if (phase === "plan") return "plan";
  if (phase === "execute" || phase === "remediate") return "deliverable";
  if (phase === "verify" || phase === "adversarial_verify") return "verdict";
  if (phase === "review") return "review";
  return phase || "artifact";
}

function artifactPathFromName({ cpbRoot, project, kind, value, dataRoot }: AnyRecord) {
  if (!value || typeof value !== "string") return null;
  if (path.isAbsolute(value)) return value;
  if (value.includes("/") || value.includes("\\")) return path.resolve(cpbRoot, value);
  const base = value.endsWith(".md") ? value.slice(0, -3) : value;
  const prefix = `${kind}-`;
  if (!base.startsWith(prefix)) return null;
  return dataRoot
    ? resolveArtifactPathForRoot(dataRoot, kind, base.slice(prefix.length))
    : resolveArtifactPath(cpbRoot, project, kind, base.slice(prefix.length));
}

function recoveredArtifactForPhase(sourceContext: AnyRecord = {}, phase: string, { cpbRoot, project, dataRoot }: AnyRecord = {}) {
  const raw = sourceContext?.retry?.artifacts?.[phase] || sourceContext?.previousFailure?.artifacts?.[phase] || null;
  if (!raw) return null;
  const kind = artifactKindForPhase(phase);
  if (typeof raw === "string") {
    return { kind, name: raw, path: artifactPathFromName({ cpbRoot, project, kind, value: raw, dataRoot }) };
  }
  if (typeof raw === "object") {
    const name = raw.name || raw.path || `${phase}-recovered`;
    return {
      kind,
      ...raw,
      name,
      path: raw.path || artifactPathFromName({ cpbRoot, project, kind, value: raw.name, dataRoot }),
    };
  }
  return null;
}

function recoveredVerdictForPhase(sourceContext: AnyRecord = {}, phase: string) {
  if (phase === "verify") return sourceContext?.retry?.verdict || sourceContext?.previousFailure?.verdict || null;
  if (phase === "adversarial_verify") return sourceContext?.retry?.adversarialVerdict || sourceContext?.previousFailure?.adversarialVerdict || null;
  return null;
}

async function reportProgress(ctx: AnyRecord, event: AnyRecord) {
  if (typeof ctx.onProgress !== "function") return;
  try {
    await ctx.onProgress({ ts: ts(), ...event });
  } catch {
    // Progress reporting must not change job execution outcome.
  }
}

function extractArtifactId(artifact: AnyRecord | null | undefined) {
  if (!artifact?.name) return null;
  const parts = artifact.name.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : artifact.id || null;
}

function normalizePhaseUsage(usage: AnyRecord | null | undefined, { hardGateFailed = false }: AnyRecord = {}) {
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

function retryFailureCause(fail: AnyRecord | null | undefined) {
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

function normalizeProviderServices(services: AnyRecord = {}) {
  const source: AnyRecord = services && typeof services === "object" ? services : {};
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

function normalizePrepareFailure(err: any) {
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

function normalizeDynamicAgentEntry(entry: AnyRecord | string | null | undefined) {
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

function dynamicAgentPlanFrom(ctx: AnyRecord, phaseSourceContext: AnyRecord | null | undefined) {
  return ctx.dynamicAgentPlan
    || phaseSourceContext?.dynamicAgentPlan
    || ctx.sourceContext?.dynamicAgentPlan
    || null;
}

function dynamicAgentForRole(plan: AnyRecord | null | undefined, role: string, phase: string) {
  const agentConfig = plan?.agentConfig || plan?.agents || {};
  return normalizeDynamicAgentEntry(agentConfig?.[role] || agentConfig?.[phase]);
}

// dagForRun and phasesWithAdversarialVerify extracted to dag-builder.js
// (buildWorkflowDag and insertAdversarialVerify)

/**
 * Extract fix scope from phase results and risk map for adversarial retry context.
 */
function extractFixScope(phaseResults: AnyRecord[], riskMap: AnyRecord | null | undefined) {
  const adversarialResult = phaseResults.find((r: AnyRecord) => r?.phase === "adversarial_verify");
  const advCause = adversarialResult?.failure?.cause || {};
  if (Array.isArray(advCause.fix_scope) && advCause.fix_scope.length > 0) return advCause.fix_scope;
  if (Array.isArray(riskMap?.adversarialFocus) && riskMap.adversarialFocus.length > 0) return riskMap.adversarialFocus;
  if (Array.isArray(riskMap?.highRiskFiles) && riskMap.highRiskFiles.length > 0) return riskMap.highRiskFiles;
  const executeResult = phaseResults.find((r: AnyRecord) => r?.phase === "execute");
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
function buildAdversarialRetryContext(gateResult: AnyRecord, phaseResults: AnyRecord[], riskMap: AnyRecord | null | undefined) {
  if (gateResult.outcome !== "adversarial_failed") return null;
  const adversarialResult = phaseResults.find((r: AnyRecord) => r?.phase === "adversarial_verify");
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
async function writeRuntimeArtifactEvent({ cpbRoot, project, jobId, dataRoot, phase, artifact, appendEvent, attemptId }: AnyRecord) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "artifact_created",
    jobId,
    project,
    phase,
    kind: artifact.kind,
    artifactKind: artifact.kind,
    artifact: artifact.name,
    artifactId: artifact.id,
    attemptId: attemptId || null,
    sha256: artifact.sha256 || null,
    ts: ts(),
  });
}

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

function attachChecklistIdsToWorkflowDag(workflowDag: AnyRecord, acceptanceChecklist: AnyRecord | null) {
  if (!acceptanceChecklist?.items?.length) return workflowDag;
  const requiredIds = acceptanceChecklist.items.filter((item: AnyRecord) => item.required).map((item: AnyRecord) => item.id);
  return {
    ...workflowDag,
    nodes: workflowDag.nodes.map((node: AnyRecord) => {
      if ((node.phase === "execute" || node.phase === "verify" || node.phase === "adversarial_verify") && !node.custom && !node.sideEffecting) {
        return { ...node, checklistIds: requiredIds, checklistBindingSource: "canonical-default" };
      }
      if (node.sideEffecting || node.custom || node.phase === "remediate" || node.phase === "review") {
        return node.checklistNeutral ? { ...node, checklistIds: [] } : node;
      }
      return node;
    }),
  };
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
  let dynamicAgentPlan = dynamicAgentPlanFrom(ctx, phaseSourceContext);
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
    dynamicAgentPlan = prepareResult?.dynamicAgentPlan || dynamicAgentPlanFrom(ctx, { ...(sourceContext || {}), riskMap });
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
    await writeRuntimeArtifactEvent({ cpbRoot, project, jobId, dataRoot, phase: "prepare_task", artifact: acceptanceChecklistArtifact, appendEvent, attemptId: ctx._attemptId });
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

/**
 * Mid-run quota fallback loop: when a phase fails with a retryable
 * AGENT_RATE_LIMITED (no hard gate), mark the provider unavailable and retry
 * with a fallback provider, up to HANDOFF_MAX_PER_PHASE times.
 *
 * Mutates the passed-in `handoffState`, `providerAttempts`, and `phaseAgents`
 * in place so the outer loop observes handoff/usage telemetry. Returns the
 * latest phase `result`.
 */
async function runQuotaFallbackRetry(ctx: AnyRecord, n: AnyRecord) {
  const {
    hubRoot, pool, phase, role, nodeId, dagNode, project, task, jobId, job,
    workflow, planMode, cpbRoot, dataRoot, sourcePath, phaseSourceContext,
    state, phaseResults, attemptId, phaseTimeout,
    handoffState, providerAttempts, phaseAgents,
  } = n;
  const { appendEvent } = ctx;
  const providerServices = normalizeProviderServices(ctx.providerServices);
  let { result } = n;

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
        const err = Object.assign(new Error("quota delegate client unavailable; provider state not recorded"), { code: "QUOTA_DELEGATE_CLIENT_UNAVAILABLE" });
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
    }).catch((): null => null);

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

/**
 * Phase retry loops: first gives transient/validation failures a second chance
 * (up to PHASE_RETRY_MAX), then retries validation failures with error
 * feedback appended (up to PHASE_FEEDBACK_RETRY_MAX). Quota-delegate write
 * failures are never retried here. Returns the latest phase `result`.
 */
async function runPhaseRetryLoops(ctx: AnyRecord, n: AnyRecord) {
  const {
    phase, role, nodeId, dagNode, project, task, jobId, job,
    workflow, planMode, cpbRoot, dataRoot, sourcePath, phaseSourceContext,
    state, phaseResults, attemptId, phaseTimeout, phaseAgents,
  } = n;
  const { appendEvent } = ctx;
  let { result } = n;

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
          dataRoot,
          sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
          sourceContext: phaseSourceContext,
          pool: n.pool,
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
        dataRoot,
        sourcePath: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE,
        sourceContext: { ...phaseSourceContext, retry },
        pool: n.pool,
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
      if (isPhasePassed(result)) break;
    }
  }

  return result;
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
      if (artifact) {
        const artifactId = extractArtifactId(artifact);
        if (phase === "plan") state.planId = artifactId;
        if (phase === "execute") state.deliverableId = artifactId;
      }
      phaseResults.push({
        schemaVersion: 1,
        phase,
        status: "passed",
        artifact,
        verdict: recoveredVerdictForPhase(phaseSourceContext, phase),
        failure: null,
        diagnostics: {
          skipped: true,
          reason: "resume_completed_node",
          nodeId,
          resumeTarget: dagResumeContext.resumeTarget,
        },
        createdAt: ts(),
      });
      await appendEvent(cpbRoot, project, jobId, {
        type: "dag_node_skipped",
        jobId,
        project,
        nodeId,
        phase,
        role,
        reason: "resume_completed_node",
        resumeTarget: dagResumeContext.resumeTarget,
        checklistIds: Array.isArray(dagNode.checklistIds) ? dagNode.checklistIds : [],
        ts: ts(),
      });
      await reportProgress(ctx, {
        type: "dag_node_skipped",
        jobId,
        project,
        nodeId,
        phase,
        role,
        reason: "resume_completed_node",
      });
      continue;
    }
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
      attemptId,
      checklistIds: Array.isArray(dagNode.checklistIds) ? dagNode.checklistIds : [],
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
    const handoffState: AnyRecord = { count: 0, from: null, to: null, reason: null };
    const providerAttempts: AnyRecord[] = [];
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
    });

    // Scope guard: evaluate changed files against fix_scope in retry scenarios
    if (phase === "execute" && isPhasePassed(result)) {
      // Normalize legacy retry fields into canonical fixScope
      const retryFixScope =
        normalizeFixScope(
          phaseSourceContext?.retryContext?.fixScope
          || phaseSourceContext?.retry?.fixScope
          || phaseSourceContext?.retryContext?.fix_scope
          || phaseSourceContext?.retry?.fix_scope
          || phaseSourceContext?.retry?.verification?.retryScope
          || []
        )
        || [];
      if (Array.isArray(retryFixScope) && retryFixScope.length > 0) {
        const rawChangedFiles = result.artifact?.metadata?.changedFiles
          || result.artifact?.files
          || [];
        const cleanPaths = rawChangedFiles
          .map((f: string) => stripGitStatusPrefix(String(f)))
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
            attemptId,
            code: "scope_guard_violation",
            reason: `Scope guard violation: changed files outside fix_scope: ${scopeResult.violations.join(", ")}`,
            error: `Scope guard violation: ${scopeResult.violations.join(", ")}`,
            checklistIds: Array.isArray(dagNode.checklistIds) ? dagNode.checklistIds : [],
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
            failureKind: FailureKind.SCOPE_VIOLATION,
            reason: `Scope guard violation: ${scopeResult.violations.join(", ")}`,
          });
          return {
            status: "failed",
            jobId,
            exitCode: 1,
            failure: {
              kind: FailureKind.SCOPE_VIOLATION,
              phase,
              nodeId,
              reason: `Changed files outside fix_scope: ${scopeResult.violations.join(", ")}`,
              retryable: false,
              cause: { routingLabel: "scope_violation", violations: scopeResult.violations, fixScope: retryFixScope },
            },
            phaseResults,
          };
        }
      }
    }

    phaseResults.push(result);

    // Emit side artifact events from phase diagnostics (execution-map, etc.)
    // These must be event-indexed before the phase result event so completion
    // and audit can discover them through artifact events, not diagnostics.
    for (const artifact of (Object.values(result.diagnostics || {}) as AnyRecord[]).filter((value) => value?.kind && value?.name)) {
      if (artifact.name === result.artifact?.name) continue;
      await writeRuntimeArtifactEvent({ cpbRoot, project, jobId, dataRoot, phase, artifact, appendEvent, attemptId });
    }

    // Resolve agent name for this phase (use potentially handoff-modified phaseAgents)
    const rawAgent = phaseAgents[role] || ctx.agent || legacyAgentForPhase(phase);
    const agentName = typeof rawAgent === "object" && rawAgent !== null
      ? (rawAgent.agent || rawAgent.name || legacyAgentForPhase(phase))
      : (rawAgent || legacyAgentForPhase(phase));

    // Poisoned session check — detect fallback/error output that slipped through phase validation
    if (isPhasePassed(result) && result.artifact?.path) {
      try {
        const { classifyPoisonedSession } = await import("./poisoned-session.js");
        const raw = await _readFile(result.artifact.path, "utf8").catch(() => "");
        const head = raw.slice(0, 2000);
        const poisonCheck = classifyPoisonedSession(head, {
          stderr: result.stderr || result.stderrSnippet || "",
        });
        if (poisonCheck.poisoned) {
          await appendEvent(cpbRoot, project, jobId, {
            type: "phase_poisoned_session",
            jobId,
            project,
            phase,
            nodeId,
            attemptId,
            reasons: poisonCheck.reasons,
            classifier: poisonCheck.classifier,
            ts: ts(),
          });
          result = phaseFailed({
            phase,
            failure: failure({
              kind: FailureKind.POISONED_SESSION,
              phase,
              reason: `poisoned session: ${poisonCheck.reasons.join(", ")}`,
              retryable: false,
              cause: { reasons: poisonCheck.reasons, classifier: poisonCheck.classifier },
            }),
          });
        }
      } catch (err) {
        // best-effort — transient FS errors (EACCES, EMFILE) are logged but don't break execution
        if (err?.code && err.code !== "ENOENT" && err.code !== "ENOTDIR") {
          process.stderr.write(`[run-job] poisoned session check error: ${err.message}\n`);
        }
      }
    }

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
        attemptId,
        artifact: result.artifact?.name || null,
        checklistIds: Array.isArray(dagNode.checklistIds) ? dagNode.checklistIds : [],
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
          }).catch((): null => null);
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
        attemptId,
        code: fail.kind || "fatal",
        reason: fail.reason || `${phase} phase failed`,
        error: fail.reason || `${phase} phase failed`,
        checklistIds: Array.isArray(dagNode.checklistIds) ? dagNode.checklistIds : [],
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

  // Load checklist gate inputs from event-visible artifact JSON only.
  // Use the shared active-attempt helper; do not read from sourceContext/diagnostics.
  let checklistArtifacts: AnyRecord = {};
  let artifactInvalidReason: string | null = null;
  try {
    const artifactIndex = typeof ctx.getArtifactIndex === "function"
      ? await ctx.getArtifactIndex(cpbRoot, project, jobId, { dataRoot })
      : null;
    if (artifactIndex) {
      // Checklist-first jobs emit an acceptance-checklist as the gate anchor.
      // Legacy jobs (never entered the checklist-first flow) produce none at
      // all; for those we skip the checklist gate entirely and let the
      // completion gate fall back to the legacy verdict gates. This is the
      // only correct place to make that distinction — readActiveChecklistArtifacts
      // stays pure fail-closed, not "absent anchor = ok".
      const hasChecklistAnchor = (artifactIndex.entries || []).some(
        (e: AnyRecord) => e.kind === "acceptance-checklist",
      );
      if (hasChecklistAnchor) {
        checklistArtifacts = await readActiveChecklistArtifacts({
          artifactIndex,
          attemptId,
          requiredKinds: ["acceptance-checklist", "execution-map", "evidence-ledger", "checklist-verdict"],
        });
        // Fail-closed: if artifact loading returned an error, block completion
        if (checklistArtifacts.ok === false) {
          artifactInvalidReason = checklistArtifacts.reason || "artifact loading failed";
        }
      }
    }
  } catch (err) {
    // Artifact index may not exist for legacy jobs; proceed without checklist
    // But if it exists and threw, that's a hard error
    if (typeof ctx.getArtifactIndex === "function") {
      artifactInvalidReason = `artifact index read failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Read runtime failures from phase results (poisoned session detection, panics)
  // and persist each as a runtime_failure_recorded event so the event-replay /
  // recovery path can reconstruct them from materialized state.
  //
  // DATA SOURCE STRATEGY:
  //   Active run:  phaseResults → runtimeFailures array → emit events → pass to gate
  //   Recovery:    event log → materializeJob → completionGate event in materialized state
  //   Audit:       event log → collectRuntimeFailureRefs → materialized.runtimeFailures
  //
  // The in-memory array is the authoritative input during an active run because
  // it is collected BEFORE events are emitted. After events are persisted, the
  // audit/recovery path reads from the event log — which is the long-term
  // source of truth. If ctx exposes readEventsReadOnly in the future, the gate
  // should prefer event-replayed failures over the in-memory array.
  const runtimeFailures: AnyRecord[] = [];
  for (const pr of phaseResults) {
    if (pr?.failure?.kind === "poisoned_session" || pr?.failure?.kind === "runjob_panic") {
      runtimeFailures.push({
        type: pr.failure.kind === "poisoned_session" ? "poisoned_session" : "runjob_panic",
        attemptId,
        phase: pr.phase || null,
        nodeId: null,
        reason: pr.failure.reason || null,
      });
    }
    // Also check diagnostics for poisoned session info
    if (pr?.diagnostics?.poisonedSession) {
      const ps = pr.diagnostics.poisonedSession;
      if (!runtimeFailures.some(rf => rf.phase === pr.phase && rf.type === "phase_poisoned_session")) {
        runtimeFailures.push({
          type: "phase_poisoned_session",
          attemptId,
          phase: pr.phase || null,
          nodeId: pr.diagnostics.nodeId || null,
          reason: Array.isArray(ps.reasons) ? ps.reasons.join(", ") : (ps.reason || null),
        });
      }
    }
  }

  // Emit runtime_failure_recorded events so the event log is the source of truth.
  // The audit export (readiness-checks) reads these from materialized state.
  for (const rf of runtimeFailures) {
    await appendEvent(cpbRoot, project, jobId, {
      type: "runtime_failure_recorded",
      jobId,
      project,
      failureType: rf.type,
      attemptId: rf.attemptId || attemptId,
      phase: rf.phase,
      nodeId: rf.nodeId,
      reason: rf.reason,
      ts: new Date().toISOString(),
    });
  }

  // Fail-closed early: if artifact loading reported invalid data, block immediately
  // before evaluating any gates. This catches broken/unreadable/mismatched artifacts
  // that readActiveChecklistArtifacts detected.
  if (artifactInvalidReason) {
    const failCause: AnyRecord = { artifactInvalidReason };
    await appendEvent(cpbRoot, project, jobId, completionGateEvent(jobId, project, {
      outcome: "artifact_invalid",
      reason: artifactInvalidReason,
      missingGates: ["artifact_index"],
      details: failCause,
    }));
    await reportProgress(ctx, {
      type: "completion_gate_blocked",
      jobId,
      project,
      outcome: "artifact_invalid",
      reason: artifactInvalidReason,
    });
    await failJob(cpbRoot, project, jobId, {
      reason: artifactInvalidReason,
      code: "artifact_invalid",
      phase: "completion_gate",
      cause: failCause,
    });
    return {
      status: "failed",
      jobId,
      exitCode: 1,
      failure: { kind: "artifact_invalid", phase: "completion_gate", reason: artifactInvalidReason, cause: failCause },
      phaseResults,
    };
  }

  const gateResult = evaluateCompletionGate({
    job: jobForGate,
    workflowDag,
    riskMap,
    dynamicAgentPlan,
    artifactIndex: null,
    parsedVerdict,
    parsedAdversarialVerdict,
    checklist: checklistArtifacts["acceptance-checklist"] || null,
    checklistVerdict: checklistArtifacts["checklist-verdict"] || null,
    evidenceLedger: checklistArtifacts["evidence-ledger"] || null,
    executionMap: checklistArtifacts["execution-map"] || null,
    runtimeFailures,
    attemptId,
  });

  await appendEvent(cpbRoot, project, jobId, completionGateEvent(jobId, project, gateResult));

  if (gateResult.outcome !== "complete") {
    const adversarialRetryContext = buildAdversarialRetryContext(gateResult, phaseResults, riskMap);
    // Map checklist routing labels to valid FailureKind + routing metadata.
    // gateResult.outcome may be a checklist-specific label (evidence_missing,
    // checklist_failed, etc.) that is NOT a valid FailureKind. The routing
    // label determines the correct FailureKind, action, retryPhase, and fixScope.
    const checklistResult = gateResult.details?.checklist;
    const routing = mapChecklistRoutingLabel(gateResult.outcome, {
      fixScope: checklistResult?.failedFixScope || [],
      targetChecklistIds: checklistResult?.failedChecklistIds || checklistResult?.uncheckedChecklistIds || [],
      evidenceMissingCause: checklistResult?.evidenceMissingCause || null,
    });
    const failureKind = routing.kind;
    // Carry the checklist retry scope on the failure cause so downstream
    // consumers can rebuild the retry plan from the persisted failure:
    //   - reconciler.verificationRetryContext reads cause.checklistVerdict
    //     (the raw verdict artifact with .items) to derive failed/unchecked/
    //     locked ids + fixScope.
    //   - failure-router reads cause.fixScope directly to route retry vs fail.
    // Without these, a gate failure loses its checklist retry scope and the
    // reconciler cannot reconstruct what to retry.
    const checklistFixScope = checklistResult?.failedFixScope || [];
    const failCause: AnyRecord = {
      gateOutcome: gateResult.outcome,
      missingGates: gateResult.missingGates,
      details: gateResult.details,
      routingLabel: gateResult.outcome,
      routingAction: routing.action,
      routingRetryPhase: routing.retryPhase,
      fixScope: checklistFixScope,
      checklistVerdict: checklistArtifacts["checklist-verdict"] || null,
      targetChecklistIds: checklistResult?.failedChecklistIds || checklistResult?.uncheckedChecklistIds || [],
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
      code: failureKind,
      phase: "completion_gate",
      cause: failCause,
    });
    return {
      status: "failed",
      jobId,
      exitCode: 1,
      failure: { kind: failureKind, phase: "completion_gate", reason: gateResult.reason, retryable: routing.retryable, cause: failCause },
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

// ─── Panic Recovery ──────────────────────────────────────────────────

/**
 * Crash barrier handler — invoked when runJobInner() throws an unhandled
 * exception.  Best-effort fails the job so it doesn't remain stuck in
 * "running" state forever.
 */
async function handleRunJobPanic(ctx: AnyRecord, panic: any) {
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

// ─── Provider Selection Helpers ─────────────────────────────────────

function resolveRawAgent(agents: AnyRecord | null | undefined, agent: string | null | undefined, role: string, phase: string) {
  const raw = agents?.[role] || agent || legacyAgentForPhase(phase);
  if (typeof raw === "object" && raw !== null) return { agent: raw.agent || raw.name || legacyAgentForPhase(phase), variant: raw.variant || null };
  return { agent: raw, variant: null };
}

function resolveProviderKey(pool: AnyRecord | null | undefined, rawAgent: any, defaultAgent: string | null | undefined) {
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
async function preflightProvider({ providerServices, hubRoot, pool, phase, role, agents, agent, excludeProvider = null }: AnyRecord) {
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

function getFallbackCandidates(pool: AnyRecord | null | undefined, agent: string, currentVariant: string | null | undefined, excludeKey: string | null | undefined) {
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
