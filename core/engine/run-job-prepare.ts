import { FailureKind, failure } from "../contracts/failure.js";
import { resolveDynamicAgentPlan } from "./phase-agent-routing.js";
import { derivePhaseBudgetPolicy } from "../policy/phase-budget.js";

import { isRecord, recordValue, type LooseRecord } from "../contracts/types.js";
import { parseManagedWorktreeContext } from "../contracts/worktree-ownership.js";
import type { RunJobPorts, RunJobState } from "./run-job-ports.js";
import {
  blockPreparedJob,
  reportProgress,
  ts,
  type JobRecord,
  type JobRunResult,
} from "./run-job-shared.js";

type RunJobPrepareContext =
  Pick<RunJobState,
    | "cpbRoot"
    | "hubRoot"
    | "project"
    | "task"
    | "jobId"
    | "workflow"
    | "planMode"
    | "sourcePath"
    | "managedWorktree"
    | "sourceContext"
    | "dynamicAgentPlan"
    | "_jobId"
    | "_attemptId"
  >
  & Pick<RunJobPorts,
    | "createJob"
    | "blockJob"
    | "appendEvent"
    | "prepareTask"
    | "onProgress"
  >;

function normalizePrepareFailure(err: unknown) {
  // Accept the raw caught value. Pre-wrapping non-objects as
  // { message: String(err) } collapses null/undefined into reason "null"/"undefined";
  // normalize here so null/undefined fall back to the default reason.
  const errObj = isRecord(err) ? err : null;
  const code = errObj?.kind || errObj?.code || "prepare_task_unavailable";
  const reason = errObj?.reason
    || errObj?.message
    || (typeof err === "string" && err.length > 0 ? err : "prepareTask service is unavailable");
  return failure({
    kind: code === FailureKind.CODEGRAPH_UNAVAILABLE
      ? FailureKind.CODEGRAPH_UNAVAILABLE
      : FailureKind.UNKNOWN,
    phase: "prepare_task",
    reason,
    retryable: false,
    cause: {
      code,
      details: errObj?.details || null,
    },
  });
}

function normalizeRiskMapResult(result: LooseRecord | null | undefined) {
  return result?.riskMap || result?.riskmap || result || null;
}

/**
 * Phase 1: Create the job record, derive attemptId, emit job_started, and
 * short-circuit when the workflow is operator-blocked.
 *
 * Returns a discriminated union: `{ kind: "blocked", result }` terminates the
 * job with a blocked status; `{ kind: "ok", job, jobId, attemptId }` proceeds
 * to prepareTask.
 */
export async function createJobAndHandleBlocked(ctx: RunJobPrepareContext): Promise<
  | { kind: "ok"; job: JobRecord; jobId: string; attemptId: string }
  | { kind: "blocked"; result: JobRunResult }
> {
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
  const managedWorktree = ctx.managedWorktree === undefined || ctx.managedWorktree === null
    ? null
    : parseManagedWorktreeContext(ctx.managedWorktree);
  if (managedWorktree && ctx.sourcePath !== managedWorktree.path) {
    throw Object.assign(new Error("managed worktree path does not match the run sourcePath"), {
      code: "WORKTREE_OWNERSHIP_CONTRACT_INVALID",
    });
  }

  const job = await createJob(cpbRoot, {
    project,
    task,
    workflow,
    planMode,
    jobId: ctx.jobId,
    sourceContext: sourceContext || {},
  });
  const jobId = job.jobId;
  ctx._jobId = jobId;

  // Derive attemptId from assignment context for checklist-aware attempt scoping.
  // Direct runs without managed assignments use jobId as the compatibility attempt id.
  const source = recordValue(sourceContext);
  const assignment = recordValue(source.assignment);
  const activeAttempt = assignment.attemptToken
    || assignment.attempt
    || source.attemptToken
    || source.attempt;
  const attemptId = activeAttempt ? String(activeAttempt) : jobId;
  ctx._attemptId = attemptId;

  await appendEvent(cpbRoot, project, jobId, {
    type: "job_started",
    jobId,
    project,
    attemptId,
    task,
    workflow,
    planMode,
    ts: ts(),
  });
  if (managedWorktree) {
    await appendEvent(cpbRoot, project, jobId, {
      type: "worktree_created",
      jobId,
      project,
      worktree: managedWorktree.path,
      branch: managedWorktree.branch,
      baseBranch: managedWorktree.baseBranch,
      baseCommit: managedWorktree.baseCommit,
      worktreeOwnership: managedWorktree.ownership,
      ts: ts(),
    });
  }
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
export async function prepareTaskAndRiskMap(
  ctx: RunJobPrepareContext,
  { jobId }: { job: JobRecord; jobId: string },
): Promise<
  | { kind: "ok"; riskMap: unknown; phaseSourceContext: LooseRecord; dynamicAgentPlan: unknown }
  | { kind: "blocked"; result: JobRunResult }
> {
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

  let riskMap: unknown = null;
  let phaseSourceContext: LooseRecord = sourceContext || {};
  let dynamicAgentPlan: unknown = resolveDynamicAgentPlan({
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
    const prepareRecord = recordValue(prepareResult);
    dynamicAgentPlan = prepareRecord.dynamicAgentPlan || resolveDynamicAgentPlan({
      dynamicAgentPlan: ctx.dynamicAgentPlan,
      phaseSourceContext: { ...(sourceContext || {}), riskMap },
      sourceContext: ctx.sourceContext,
    });
    const phaseBudgetPolicy = derivePhaseBudgetPolicy({
      workflow,
      planMode,
      sourceContext: { ...(sourceContext || {}), riskMap },
    });
    phaseSourceContext = { ...(sourceContext || {}), riskMap, phaseBudgetPolicy, ...(dynamicAgentPlan ? { dynamicAgentPlan } : {}), ...(prepareRecord.acceptanceChecklist ? { acceptanceChecklist: prepareRecord.acceptanceChecklist } : {}), ...(prepareRecord.requirementClassification ? { requirementClassification: prepareRecord.requirementClassification } : {}) };

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
      riskLevel: recordValue(riskMap).riskLevel ?? null,
      domains: recordValue(riskMap).domains ?? [],
      highRiskFiles: recordValue(riskMap).highRiskFiles ?? [],
      verificationDepth: recordValue(riskMap).verificationDepth ?? null,
      adversarialRequired: Boolean(recordValue(riskMap).adversarialRequired),
      adversarialFocus: recordValue(riskMap).adversarialFocus ?? [],
      phaseBudgetPolicy,
      evidenceRequirements: phaseBudgetPolicy.evidenceRequirements,
      confidence: recordValue(riskMap).confidence ?? null,
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
      riskLevel: recordValue(riskMap).riskLevel ?? null,
      verificationDepth: recordValue(riskMap).verificationDepth ?? null,
      adversarialRequired: Boolean(recordValue(riskMap).adversarialRequired),
      phaseBudgetPolicy,
      evidenceRequirements: phaseBudgetPolicy.evidenceRequirements,
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
      reason: (() => {
        const code = recordValue(fail.cause).code;
        return code === undefined || code === null ? fail.reason : String(code);
      })(),
      failure: { kind: fail.kind, reason: fail.reason },
    });
    return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: fail } };
  }
}
