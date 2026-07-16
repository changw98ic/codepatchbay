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
import {
  blockPreparedJob,
  failPreparedJob,
  reportProgress,
  ts,
  type AppendEvent,
  type BlockJob,
  type FailJob,
  type JobRunResult,
  type ProgressReporter,
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

type RunJobChecklistDagContext = LooseRecord & {
  cpbRoot: string;
  project: string;
  task: string;
  workflow?: string;
  planMode?: string;
  sourceContext?: LooseRecord;
  dataRoot?: string;
  blockJob?: BlockJob;
  failJob?: FailJob;
  appendEvent: AppendEvent;
  onProgress?: ProgressReporter | null;
  _attemptId?: string;
};

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
    dataRoot,
    blockJob,
    appendEvent,
  } = ctx;

  let acceptanceChecklist: AcceptanceChecklist | null = recordValue(phaseSourceContext.acceptanceChecklist);
  if (!phaseSourceContext.acceptanceChecklist) acceptanceChecklist = null;
  const documents = Array.isArray(phaseSourceContext.documents) ? phaseSourceContext.documents : [];
  const existingRequirementClassification = recordValue(phaseSourceContext.requirementClassification);
  const requirementClassification = Object.keys(existingRequirementClassification).length > 0
    ? existingRequirementClassification
    : await classifyAcceptanceRequirements({ task, documents, riskMap });
  if (!acceptanceChecklist) {
    const assuranceTournament = recordValue(phaseSourceContext.assuranceTournament);
    const tournamentProposal = recordValue(assuranceTournament.proposal);
    const tournamentItems = Array.isArray(tournamentProposal.decomposedItems)
      ? tournamentProposal.decomposedItems
      : Array.isArray(assuranceTournament.decomposedItems)
        ? assuranceTournament.decomposedItems
        : null;
    let decomposedItems = tournamentItems || undefined;
    if (!decomposedItems && process.env.CPB_CHECKLIST_DECOMPOSE !== "0") {
      const decomposition = await decomposeTaskToChecklistItems({
        task,
        documents,
        ctx: { ...ctx, sourceContext: phaseSourceContext },
      });
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
          await failPreparedJob({ cpbRoot, project, jobId, appendEvent, failJob: ctx.failJob, failure: decompFail });
          return { kind: "failed", result: { status: "failed", jobId, exitCode: 1, failure: decompFail } };
        }
        await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: decompFail });
        return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: decompFail } };
      }
      decomposedItems = decomposition.items;
    }
    acceptanceChecklist = await buildAcceptanceChecklist({
      jobId, project, task, documents, riskMap: recordValue(riskMap), requirementClassification, decomposedItems,
    });
  }
  let acceptanceChecklistArtifact: LooseRecord | null = null;
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
      await failPreparedJob({ cpbRoot, project, jobId, appendEvent, failJob: ctx.failJob, failure: fail });
      return { kind: "failed", result: { status: "failed", jobId, exitCode: 1, failure: fail } };
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
  const workflowDag = attachChecklistIdsToWorkflowDag(buildWorkflowDag({ workflow, phases, phaseRoleMap }), acceptanceChecklist);
  const dagCoverage = validateChecklistDagCoverage(workflowDag, acceptanceChecklist);
  if (!dagCoverage.ok) {
    const fail = failure({
      kind: FailureKind.ARTIFACT_INVALID,
      phase: "prepare_task",
      reason: `acceptance checklist DAG coverage invalid: ${dagCoverage.reason}`,
      retryable: false,
      cause: { routingLabel: "needs_clarification", dagCoverage },
    });
    await blockPreparedJob({ cpbRoot, project, jobId, appendEvent, blockJob, failure: fail });
    return { kind: "blocked", result: { status: "blocked", jobId, exitCode: 2, failure: fail } };
  }
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
  const assurancePolicy = resolveHighAssurancePolicy({ sourceContext: phaseSourceContext });
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
  await appendEvent(cpbRoot, project, jobId, {
    type: "dynamic_agent_plan_generated",
    jobId,
    project,
    workflow,
    planMode,
    dynamicAgentPlan,
    riskLevel: recordValue(dynamicAgentPlan).riskLevel ?? recordValue(riskMap).riskLevel ?? null,
    adversarialRequired: recordValue(dynamicAgentPlan).adversarialRequired ?? Boolean(recordValue(riskMap).adversarialRequired),
    independentVerifierRequired: Boolean(recordValue(dynamicAgentPlan).independentVerifierRequired),
    ts: ts(),
  });
  await reportProgress(ctx, {
    type: "dynamic_agent_plan_generated",
    jobId,
    project,
    riskLevel: recordValue(dynamicAgentPlan).riskLevel ?? null,
    independentVerifierRequired: Boolean(recordValue(dynamicAgentPlan).independentVerifierRequired),
  });

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
