import { isPhasePassed } from "../contracts/phase-result.js";
import { completionGateEvent, evaluateCompletionGate, parseVerdict } from "./completion-gate.js";
import { loadCompletionChecklistArtifacts } from "./completion-checklist-artifacts.js";
import { handleArtifactInvalidCompletionFailure, handleCompletionGateFailure } from "./completion-failure.js";
import { handleCompletionSuccess } from "./completion-success.js";
import { collectRuntimeFailures, recordRuntimeFailureEvents } from "./runtime-failure-recorder.js";

type LooseRecord = Record<string, unknown>;

type CompletionGateRunnerResult = {
  status: string;
  jobId: string;
  exitCode: number;
  failure: LooseRecord | null;
  phaseResults: LooseRecord[];
};

type CompletionGateRunnerInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  job: LooseRecord;
  workflowDag: LooseRecord;
  riskMap?: LooseRecord | null;
  dynamicAgentPlan?: LooseRecord | null;
  phaseResults: LooseRecord[];
  dataRoot?: string;
  attemptId?: string | null;
  getArtifactIndex?: unknown;
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  failJob: (cpbRoot: string, project: string, jobId: string, failure: LooseRecord) => Promise<unknown> | unknown;
  completeJob: (cpbRoot: string, project: string, jobId: string) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

function objectValue(value: unknown): LooseRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as LooseRecord
    : null;
}

function phaseResultNamed(phaseResults: LooseRecord[], phase: string) {
  return phaseResults.find((result) => result.phase === phase) || null;
}

function verdictTextForPhase(phaseResults: LooseRecord[], phase: string) {
  const phaseResult = phaseResultNamed(phaseResults, phase);
  const artifact = objectValue(phaseResult?.artifact);
  return phaseResult?.verdict || artifact?.content || artifact?.metadata || null;
}

function completedPhaseNames(phaseResults: LooseRecord[]) {
  return phaseResults
    .filter((result) => isPhasePassed(result))
    .map((result) => String(result.phase || ""))
    .filter(Boolean);
}

export async function runCompletionGate({
  cpbRoot,
  project,
  jobId,
  job,
  workflowDag,
  riskMap = null,
  dynamicAgentPlan = null,
  phaseResults,
  dataRoot,
  attemptId = null,
  getArtifactIndex = null,
  appendEvent,
  failJob,
  completeJob,
  onProgress = null,
  now = () => new Date().toISOString(),
}: CompletionGateRunnerInput): Promise<CompletionGateRunnerResult> {
  const parsedVerdict = parseVerdict(verdictTextForPhase(phaseResults, "verify"));
  const parsedAdversarialVerdict = parseVerdict(verdictTextForPhase(phaseResults, "adversarial_verify"));
  const jobForGate = { ...job, completedPhases: completedPhaseNames(phaseResults) };

  const { checklistArtifacts, artifactInvalidReason } = await loadCompletionChecklistArtifacts({
    cpbRoot,
    project,
    jobId,
    dataRoot,
    attemptId,
    getArtifactIndex,
  });

  const runtimeFailures = collectRuntimeFailures({ phaseResults, attemptId });
  await recordRuntimeFailureEvents({
    cpbRoot,
    project,
    jobId,
    attemptId,
    runtimeFailures,
    appendEvent,
    now,
  });

  if (artifactInvalidReason) {
    return handleArtifactInvalidCompletionFailure({
      cpbRoot,
      project,
      jobId,
      artifactInvalidReason,
      phaseResults,
      appendEvent,
      failJob,
      onProgress,
      now,
    });
  }

  const gateResult = evaluateCompletionGate({
    job: jobForGate,
    workflowDag,
    riskMap: riskMap || undefined,
    dynamicAgentPlan: dynamicAgentPlan || undefined,
    artifactIndex: undefined,
    parsedVerdict,
    parsedAdversarialVerdict,
    checklist: checklistArtifacts["acceptance-checklist"] || undefined,
    checklistVerdict: checklistArtifacts["checklist-verdict"] || undefined,
    evidenceLedger: checklistArtifacts["evidence-ledger"] || undefined,
    executionMap: checklistArtifacts["execution-map"] || undefined,
    runtimeFailures,
    attemptId: attemptId || undefined,
  });

  await appendEvent(cpbRoot, project, jobId, completionGateEvent(jobId, project, gateResult));

  if (gateResult.outcome !== "complete") {
    return handleCompletionGateFailure({
      cpbRoot,
      project,
      jobId,
      gateResult,
      phaseResults,
      riskMap,
      checklistVerdict: checklistArtifacts["checklist-verdict"] || null,
      failJob,
      onProgress,
      now,
    });
  }

  return handleCompletionSuccess({
    cpbRoot,
    project,
    jobId,
    phaseResults,
    completeJob,
    onProgress,
    now,
  });
}
