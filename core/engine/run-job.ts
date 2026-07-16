/**
 * Engine.runJob — native phase state machine.
 *
 * Creates a job, resolves phases from workflow, runs each phase via
 * native adapters (core/phases/*.js).  Returns structured JobResult.
 *
 * All infrastructure services (createJob, appendEvent, etc.) are
 * injected via ctx — no server/ imports in core/.
 */

import type { ProviderAgents } from "./provider-handoff.js";
import { finalizeAuditTrail, handleRunJobPanic } from "./run-job-lifecycle.js";
import { freezeChecklistAndMaterializeDag } from "./run-job-checklist-dag.js";
import { createJobAndHandleBlocked, prepareTaskAndRiskMap } from "./run-job-prepare.js";
import { executeWorkflowDag } from "./run-job-execute-dag.js";
import { runHighAssurancePlanning } from "./run-job-assurance.js";
import { resolveAgentPhaseTimeoutMs } from "../policy/phase-budget.js";

import { isRecord, recordValue, type LooseRecord } from "../contracts/types.js";
import {
  type CompleteJob,
  type CompletePhase,
  type FailJob,
  type JobRecord,
  type JobRunResult,
  type ProgressReporter,
  type ProviderPool,
} from "./run-job-shared.js";

type RunJobContext = LooseRecord & {
  cpbRoot: string;
  hubRoot?: string;
  project: string;
  task: string;
  workflow?: string;
  planMode?: string;
  sourcePath?: string;
  sourceContext?: LooseRecord;
  dataRoot?: string;
  maxRetries?: number;
  timeoutMin?: number;
  createJob: (cpbRoot: string, input: LooseRecord) => Promise<JobRecord> | JobRecord;
  startPhase?: (cpbRoot: string, project: string, jobId: string, payload: LooseRecord) => Promise<unknown> | unknown;
  completePhase: CompletePhase;
  completeJob: CompleteJob;
  failJob: FailJob;
  blockJob?: (cpbRoot: string, project: string, jobId: string, payload: LooseRecord) => Promise<unknown> | unknown;
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  getPool: () => ProviderPool | null | undefined;
  prepareTask?: (cpbRoot: string, input: LooseRecord) => Promise<LooseRecord> | LooseRecord;
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
  _jobId?: string;
  _attemptId?: string;
  _currentPhase?: string | null;
};

function resolveRunJobPhaseTimeout(ctx: RunJobContext) {
  return resolveAgentPhaseTimeoutMs({ timeoutMin: ctx.timeoutMin });
}

function attachPreDagTimeouts(ctx: RunJobContext) {
  const phaseTimeout = resolveRunJobPhaseTimeout(ctx);
  const existing = recordValue(ctx.timeouts);
  ctx.timeouts = {
    plan: phaseTimeout,
    decompose: phaseTimeout,
    execute: phaseTimeout,
    verify: phaseTimeout,
    adversarial_verify: phaseTimeout,
    review: phaseTimeout,
    remediate: phaseTimeout,
    ...existing,
  };
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
 * Crash barrier wrapper — catches unhandled exceptions from runJobInner()
 * and ensures the job is failed rather than stuck in "running" forever.
 */
export async function runJob(ctxInput: unknown): Promise<JobRunResult> {
  if (!isRecord(ctxInput)) {
    throw new TypeError("runJob context must be an object");
  }
  // retain: dynamic JSON boundary — isRecord narrows to LooseRecord, but RunJobContext
  // requires typed service members (createJob/appendEvent/getPool/...) the guard cannot verify.
  const ctx = ctxInput as RunJobContext;
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
        jobId: result?.jobId || ctx._jobId,
        attemptId: ctx._attemptId || result?.jobId || ctx._jobId,
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

async function runJobInner(ctx: RunJobContext): Promise<JobRunResult> {
  const {
    cpbRoot,
    hubRoot,
    sourcePath,
    sourceContext,
    dataRoot,
  } = ctx;

  const previousEnv = {
    CPB_ROOT: process.env.CPB_ROOT,
    CPB_HUB_ROOT: process.env.CPB_HUB_ROOT,
    CPB_PROJECT_RUNTIME_ROOT: process.env.CPB_PROJECT_RUNTIME_ROOT,
    CPB_PROJECT_PATH_OVERRIDE: process.env.CPB_PROJECT_PATH_OVERRIDE,
  };
  process.env.CPB_ROOT = cpbRoot;
  if (hubRoot) process.env.CPB_HUB_ROOT = hubRoot;
  else delete process.env.CPB_HUB_ROOT;
  if (dataRoot) process.env.CPB_PROJECT_RUNTIME_ROOT = dataRoot;
  else delete process.env.CPB_PROJECT_RUNTIME_ROOT;
  if (sourcePath) process.env.CPB_PROJECT_PATH_OVERRIDE = sourcePath;
  else delete process.env.CPB_PROJECT_PATH_OVERRIDE;

  try {
    attachPreDagTimeouts(ctx);

    // 1. Create job (+ operator-blocked short-circuit)
    const created = await createJobAndHandleBlocked(ctx);
    if (created.kind === "blocked") return created.result;
    const { job, jobId, attemptId } = created;

    const schedulerDecision = recordValue(sourceContext?.schedulerDecision);
    if (Object.keys(schedulerDecision).length > 0) {
      await ctx.appendEvent(cpbRoot, ctx.project, jobId, {
        type: "scheduler_decision_applied",
        jobId,
        project: ctx.project,
        attemptId,
        queueEntryId: sourceContext?.queueEntryId || null,
        mode: typeof schedulerDecision.mode === "string" ? schedulerDecision.mode : undefined,
        rank: schedulerDecision.rank ?? null,
        score: schedulerDecision.score ?? null,
        reasons: Array.isArray(schedulerDecision.reasons) ? schedulerDecision.reasons : [],
        retryStrategy: schedulerDecision.retryStrategy || null,
        failureFingerprint: schedulerDecision.failureFingerprint || null,
        failureClass: schedulerDecision.failureClass || null,
        ts: new Date().toISOString(),
      });
    }

    // 2. prepareTask -> risk map + dynamic agent plan + enriched source context
    const prepared = await prepareTaskAndRiskMap(ctx, { job, jobId });
    if (prepared.kind === "blocked") return prepared.result;
    let { riskMap, phaseSourceContext, dynamicAgentPlan } = prepared;

    // High-assurance planning runs before checklist scope is frozen. Two
    // independent planners, cross-critiques, revisions, and arbitration
    // produce the only proposal/checklist scope downstream phases may consume.
    const assurance = await runHighAssurancePlanning(ctx, { jobId, phaseSourceContext });
    if (assurance.kind !== "ok" && assurance.kind !== "skipped") return assurance.result;
    phaseSourceContext = assurance.phaseSourceContext;

    // 3. Freeze acceptance checklist, materialize workflow DAG, generate +
    //    validate dynamic agent plan. Short-circuits to "blocked" on any
    //    checklist/coverage/plan-validation failure (fail-closed invariant).
    const materialized = await freezeChecklistAndMaterializeDag(ctx, {
      jobId, riskMap, phaseSourceContext, dynamicAgentPlan,
    });
    if (materialized.kind === "blocked") return materialized.result;
    if (materialized.kind === "failed") return materialized.result;
    phaseSourceContext = materialized.phaseSourceContext;
    dynamicAgentPlan = materialized.dynamicAgentPlan;

    // 2.5. Clear session cache if forceFreshSession is requested (rerun vs retry)
    if (recordValue(sourceContext?.retry).forceFreshSession && cpbRoot) {
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

    return executeWorkflowDag(ctx, {
      job,
      jobId,
      attemptId,
      riskMap,
      phaseSourceContext,
      dynamicAgentPlan,
      workflowDag: materialized.workflowDag,
      executionNodes: materialized.executionNodes,
      dagResumeContext: materialized.dagResumeContext,
      resumeCompletedNodes: materialized.resumeCompletedNodes,
      phaseRoleMap: materialized.phaseRoleMap,
    });
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
