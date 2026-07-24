import { FailureKind, failure, isValidFailureKind } from "../contracts/failure.js";
import { generateDynamicAgentPlan, validateDynamicAgentPlan } from "../agents/dynamic-agent-plan.js";
import { writeArtifact } from "../artifacts/artifact-store.js";
import {
  buildAcceptanceChecklist,
  classifyAcceptanceRequirements,
  validateAcceptanceChecklist,
  validateChecklistDagCoverage,
  validateChecklistSourceCoverage,
} from "../workflow/acceptance-checklist.js";
import type { AcceptanceChecklist } from "../workflow/checklist-shared.js";
import { decomposeTaskToChecklistItems } from "../workflow/checklist-decomposer.js";
import { buildWorkflowDag, insertAdversarialVerify } from "./dag-builder.js";
import { resolveSemanticPhases } from "./phase-policy.js";
import { resolveHighAssurancePolicy } from "../policy/high-assurance.js";
import { writeRuntimeArtifactEvent } from "./runtime-artifact-events.js";
import {
  attachChecklistIdsToWorkflowDag,
  dagSequentialExecutionPlan,
  normalizeDagResumeContext,
  type WorkflowDag,
  type WorkflowDagNode,
} from "./run-job-planning.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";
import type { RunJobPorts, RunJobState } from "./run-job-ports.js";
import {
  blockPreparedJob,
  failPreparedJob,
  reportProgress,
  ts,
  type JobRunResult,
} from "./run-job-shared.js";

type PhaseRoleMap = {
  plan: string;
  execute: string;
  verify: string;
  adversarial_verify: string;
  review: string;
  remediate: string;
  [phase: string]: string;
};

type RunJobChecklistDagContext =
  Pick<RunJobState,
    | "cpbRoot"
    | "project"
    | "task"
    | "workflow"
    | "planMode"
    | "sourcePath"
    | "sourceContext"
    | "dataRoot"
    | "timeouts"
    | "env"
    | "scope"
    | "signal"
    | "agent"
    | "agents"
    | "_attemptId"
  >
  & Pick<RunJobPorts,
    | "blockJob"
    | "failJob"
    | "appendEvent"
    | "onProgress"
    | "getPool"
  >;

type FreezeChecklistAndMaterializeDagInput = {
  jobId: string;
  riskMap: unknown;
  phaseSourceContext: LooseRecord;
  dynamicAgentPlan: unknown;
};

type FreezeChecklistAndMaterializeDagResult =
  | { kind: "blocked"; result: JobRunResult }
  | { kind: "failed"; result: JobRunResult }
  | {
      kind: "ok";
      phaseSourceContext: LooseRecord;
      dynamicAgentPlan: unknown;
      workflowDag: WorkflowDag;
      executionNodes: WorkflowDagNode[];
      dagResumeContext: { completedNodeIds: string[]; resumeTarget: LooseRecord | null };
      resumeCompletedNodes: Set<string>;
      phaseRoleMap: PhaseRoleMap;
      acceptanceChecklist: AcceptanceChecklist | null;
    };

function checklistAbortError(signal?: AbortSignal, message = "checklist DAG preparation aborted") {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return Object.assign(
    new Error(reason instanceof Error ? reason.message : (typeof reason === "string" && reason) ? reason : message),
    { name: "AbortError", code: "ABORT_ERR" },
  );
}

function throwIfChecklistAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw checklistAbortError(signal);
}

/**
 * Freeze the acceptance checklist (validate + coverage-check + persist),
 * materialize the workflow DAG, and generate + fail-closed validate the dynamic
 * agent plan. This is the checklist-first invariant boundary: the checklist must
 * be event-indexed before the DAG and plan are consumed.
 */
export async function freezeChecklistAndMaterializeDag(
  ctx: RunJobChecklistDagContext,
  { jobId, riskMap, phaseSourceContext, dynamicAgentPlan }: FreezeChecklistAndMaterializeDagInput,
): Promise<FreezeChecklistAndMaterializeDagResult> {
  const {
    cpbRoot,
    project,
    task,
    workflow = "standard",
    planMode = "full",
    sourceContext,
    blockJob,
    appendEvent,
  } = ctx;
  const dataRoot = ctx.dataRoot ?? undefined;
  const runtimeEnv = ctx.env ?? process.env;
  const signalAlreadyAborted = ctx.signal?.aborted === true;
  const throwIfNewlyAborted = () => {
    if (!signalAlreadyAborted) throwIfChecklistAborted(ctx.signal);
  };

  let acceptanceChecklist: AcceptanceChecklist | null = recordValue(phaseSourceContext.acceptanceChecklist);
  if (!phaseSourceContext.acceptanceChecklist) acceptanceChecklist = null;
  const documents = Array.isArray(phaseSourceContext.documents) ? phaseSourceContext.documents : [];
  const existingRequirementClassification = recordValue(phaseSourceContext.requirementClassification);
  const requirementClassification = signalAlreadyAborted
    ? existingRequirementClassification
    : Object.keys(existingRequirementClassification).length > 0
      ? existingRequirementClassification
      : await classifyAcceptanceRequirements({ task, documents, riskMap });
  throwIfNewlyAborted();
  if (!acceptanceChecklist && !signalAlreadyAborted) {
    const assuranceTournament = recordValue(phaseSourceContext.assuranceTournament);
    const tournamentProposal = recordValue(assuranceTournament.proposal);
    const tournamentItems = Array.isArray(tournamentProposal.decomposedItems)
      ? tournamentProposal.decomposedItems
      : Array.isArray(assuranceTournament.decomposedItems)
        ? assuranceTournament.decomposedItems
        : null;
    let decomposedItems = tournamentItems || undefined;
    if (!decomposedItems && runtimeEnv.CPB_CHECKLIST_DECOMPOSE !== "0") {
      const decomposition = await decomposeTaskToChecklistItems({
        task,
        documents,
        ctx: {
          cpbRoot,
          project,
          jobId,
          planMode,
          sourcePath: ctx.sourcePath,
          sourceContext: phaseSourceContext,
          dataRoot,
          timeouts: ctx.timeouts,
          env: ctx.env,
          scope: ctx.scope,
          signal: ctx.signal,
          agent: ctx.agent,
          agents: ctx.agents,
          getPool: ctx.getPool,
        },
      });
      throwIfNewlyAborted();
      if (!decomposition.ok) {
        const rawDecompKind = typeof decomposition.kind === "string" ? decomposition.kind : "";
        const decompKind = isValidFailureKind(rawDecompKind) ? rawDecompKind : FailureKind.ARTIFACT_INVALID;
        const retryable = Boolean(decomposition.retryable);
        const decompFail = failure({
          kind: decompKind,
          phase: "prepare_task",
          reason: `checklist decomposition failed: ${decomposition.reason}`,
          retryable,
          cause: {
            decomposition,
            ...(retryable ? { routingLabel: "infra_error" } : {}),
          },
        });
        if (retryable) {
          throwIfNewlyAborted();
          await failPreparedJob({ cpbRoot, project, jobId, appendEvent, failJob: ctx.failJob, failure: decompFail });
          return { kind: "failed", result: { status: "failed", jobId, exitCode: 1, failure: decompFail } };
        }
        throwIfNewlyAborted();
        await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: decompFail });
        return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: decompFail } };
      }
      decomposedItems = decomposition.items;
    }
    acceptanceChecklist = await buildAcceptanceChecklist({
      jobId, project, task, documents, riskMap: recordValue(riskMap), requirementClassification, decomposedItems,
    });
    throwIfNewlyAborted();
  }
  let acceptanceChecklistArtifact: LooseRecord | null = null;
  if (acceptanceChecklist && !signalAlreadyAborted) {
    const validation = validateAcceptanceChecklist(acceptanceChecklist);
    if (!validation.ok) {
      const fail = failure({
        kind: FailureKind.ARTIFACT_INVALID,
        phase: "prepare_task",
        reason: `acceptance checklist invalid: ${validation.reason}`,
        retryable: false,
        cause: { acceptanceChecklist },
      });
      throwIfNewlyAborted();
      await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail });
      return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: fail } };
    }
    const rawEvidenceLocators = recordValue(phaseSourceContext.assuranceTournament).evidenceLocators;
    const coverage = validateChecklistSourceCoverage({
      checklist: acceptanceChecklist,
      task,
      documents,
      requirementClassification,
      evidenceLocators: Array.isArray(rawEvidenceLocators)
        ? rawEvidenceLocators.map(String)
        : [],
    });
    if (!coverage.ok) {
      const fail = failure({
        kind: FailureKind.ARTIFACT_INVALID,
        phase: "prepare_task",
        reason: `acceptance checklist source coverage incomplete: ${coverage.reason}`,
        retryable: true,
        cause: { routingLabel: "infra_error", coverage, generatedArtifact: true },
      });
      throwIfNewlyAborted();
      await failPreparedJob({ cpbRoot, project, jobId, appendEvent, failJob: ctx.failJob, failure: fail });
      return { kind: "failed", result: { status: "failed", jobId, exitCode: 1, failure: fail } };
    }
    throwIfNewlyAborted();
    acceptanceChecklistArtifact = await writeArtifact(cpbRoot, {
      project,
      jobId,
      kind: "acceptance-checklist",
      content: JSON.stringify(acceptanceChecklist, null, 2),
      dataRoot,
      signal: ctx.signal,
      metadata: acceptanceChecklist,
    });
    throwIfNewlyAborted();
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
    throwIfNewlyAborted();
    phaseSourceContext = { ...phaseSourceContext, acceptanceChecklist, acceptanceChecklistArtifact };

    const dynamicAgentPlanRecord = recordValue(dynamicAgentPlan);
    if (dynamicAgentPlan && !dynamicAgentPlanRecord.acceptanceChecklistArtifactId && !dynamicAgentPlanRecord.acceptanceChecklistArtifact) {
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

	  const { phases: resolvedPhases } = resolveSemanticPhases({ workflow, planMode });
	  const phases = insertAdversarialVerify(resolvedPhases, recordValue(riskMap));
  throwIfNewlyAborted();
	  let workflowDag;
	  try {
    workflowDag = attachChecklistIdsToWorkflowDag(buildWorkflowDag({ workflow, phases, phaseRoleMap }), acceptanceChecklist);
  } catch (err) {
    const dagMaterializationError = err instanceof Error ? err.message : String(err);
    const fail = failure({
      kind: FailureKind.ARTIFACT_INVALID,
      phase: "prepare_task",
      reason: `Failed to materialize workflow DAG: ${dagMaterializationError}`,
      retryable: false,
      cause: { routingLabel: "dag_materialization_failed", workflow, phases, error: dagMaterializationError },
	    });
    throwIfNewlyAborted();
	    await failPreparedJob({
      cpbRoot,
      project,
      jobId,
      appendEvent,
      failJob: ctx.failJob,
      failure: fail,
	    });
	    return { kind: "failed", result: { status: "failed", jobId, exitCode: 1, failure: fail } };
	  }
  throwIfNewlyAborted();
	  const dagCoverage = validateChecklistDagCoverage(workflowDag, acceptanceChecklist);
	  if (!dagCoverage.ok) {
    const fail = failure({
      kind: FailureKind.ARTIFACT_INVALID,
      phase: "prepare_task",
      reason: `acceptance checklist DAG coverage invalid: ${dagCoverage.reason}`,
      retryable: false,
      cause: { routingLabel: "needs_clarification", dagCoverage },
	    });
    throwIfNewlyAborted();
	    await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail });
	    return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: fail } };
	  }
  const executionNodes = dagSequentialExecutionPlan(workflowDag);
  const dagResumeContext = normalizeDagResumeContext(sourceContext || {});
  const resumeCompletedNodes = new Set(dagResumeContext.completedNodeIds);
  const requestedConcurrency = typeof workflowDag.maxConcurrentNodes === "number"
    ? workflowDag.maxConcurrentNodes
    : Number(workflowDag.maxConcurrentNodes);
	  const dagParallelExecutionEnabled = Number.isFinite(requestedConcurrency)
	    ? Math.floor(requestedConcurrency) > 1
	    : false;
  throwIfNewlyAborted();
  if (!signalAlreadyAborted) {
	    await appendEvent(cpbRoot, project, jobId, {
	      type: "workflow_dag_materialized",
	      jobId,
	      project,
	      workflow,
	      planMode,
	      attemptId: ctx._attemptId || null,
	      workflowDag,
	      nodes: workflowDag.nodes,
	      edges: workflowDag.edges,
	      executionMode: "bounded_dependency_parallel",
	      dagMetadataReady: true,
	      dagNodeFirstSequentialReady: true,
	      dagParallelExecutionReady: true,
	      dagParallelExecutionEnabled,
	      dagParallelSafePhases: ["review"],
	      dagUnsafeNodePolicy: "exclusive",
	      dagConflictPolicy: "stable_prefix_serialization",
	      dagDurableCommitOrder: "stable_topological_node_order",
	      ts: ts(),
	    });
    throwIfNewlyAborted();
	    await reportProgress(ctx, {
	      type: "workflow_dag_materialized",
	      jobId,
	      project,
	      workflow,
	      planMode,
	      nodeCount: workflowDag.nodes.length,
	    });
  }
  const assurancePolicy = resolveHighAssurancePolicy({
    sourceContext: phaseSourceContext,
    env: ctx.env,
  });
  const assuranceRequiresIndependentVerifier = assurancePolicy.enabled
    && assurancePolicy.verification.required
    && assurancePolicy.verification.independent;
	  if (!dynamicAgentPlan) {
    dynamicAgentPlan = generateDynamicAgentPlan({
      riskMap: recordValue(riskMap),
      workflowDag,
      workflow,
      planMode,
      independentVerifierRequired: assuranceRequiresIndependentVerifier,
    });
  } else if (assuranceRequiresIndependentVerifier && recordValue(dynamicAgentPlan).independentVerifierRequired !== true) {
    dynamicAgentPlan = {
      ...recordValue(dynamicAgentPlan),
      independentVerifierRequired: true,
      independentVerifierSource: "high_assurance_policy",
    };
	  }
	  phaseSourceContext = { ...phaseSourceContext, dynamicAgentPlan };
  throwIfNewlyAborted();
  if (!signalAlreadyAborted) {
	    await appendEvent(cpbRoot, project, jobId, {
	      type: "dynamic_agent_plan_generated",
	      jobId,
	      project,
	      workflow,
	      planMode,
	      attemptId: ctx._attemptId || null,
	      dynamicAgentPlan,
	      riskLevel: recordValue(dynamicAgentPlan).riskLevel ?? recordValue(riskMap).riskLevel ?? null,
	      adversarialRequired: recordValue(dynamicAgentPlan).adversarialRequired ?? Boolean(recordValue(riskMap).adversarialRequired),
	      independentVerifierRequired: Boolean(recordValue(dynamicAgentPlan).independentVerifierRequired),
	      ts: ts(),
	    });
    throwIfNewlyAborted();
	    await reportProgress(ctx, {
	      type: "dynamic_agent_plan_generated",
	      jobId,
	      project,
	      riskLevel: recordValue(dynamicAgentPlan).riskLevel ?? null,
	      independentVerifierRequired: Boolean(recordValue(dynamicAgentPlan).independentVerifierRequired),
	    });
  }

	  const planValidation = validateDynamicAgentPlan(recordValue(dynamicAgentPlan), workflowDag);
	  if (!planValidation.valid) {
    const blockFail = failure({
      kind: FailureKind.AGENT_CONTRACT_INVALID,
      phase: "dynamic_agent_plan",
      reason: planValidation.reason,
      retryable: false,
      cause: {
        code: "dynamic_agent_plan_validation_failed",
        missingRoles: planValidation.missingRoles,
        planSource: recordValue(dynamicAgentPlan).source || null,
      },
	    });
    throwIfNewlyAborted();
	    await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: blockFail });
    throwIfNewlyAborted();
	    await appendEvent(cpbRoot, project, jobId, {
      type: "dynamic_agent_plan_invalid",
      jobId,
      project,
      reason: planValidation.reason,
      missingRoles: planValidation.missingRoles,
	      ts: ts(),
	    });
    throwIfNewlyAborted();
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
