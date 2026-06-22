import { completionGateEvent } from "./completion-gate.js";
import { mapChecklistRoutingLabel } from "../workflow/acceptance-checklist.js";

type LooseRecord = Record<string, unknown>;

type FailedJobResult = {
  status: "failed";
  jobId: string;
  exitCode: 1;
  failure: LooseRecord;
  phaseResults: LooseRecord[];
};

type CompletionFailureInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  artifactInvalidReason: string;
  phaseResults: LooseRecord[];
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  failJob: (cpbRoot: string, project: string, jobId: string, failure: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

type CompletionGateFailureInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  gateResult: {
    outcome: string;
    reason: string;
    missingGates?: string[];
    details?: LooseRecord;
  };
  phaseResults: LooseRecord[];
  riskMap?: LooseRecord | null;
  checklistVerdict?: LooseRecord | null;
  failJob: (cpbRoot: string, project: string, jobId: string, failure: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

function objectValue(value: unknown): LooseRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as LooseRecord
    : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item || "")).filter(Boolean) : [];
}

function phaseResultNamed(phaseResults: LooseRecord[], phase: string) {
  return phaseResults.find((result) => result.phase === phase) || null;
}

function extractFixScope(phaseResults: LooseRecord[], riskMap: LooseRecord | null | undefined) {
  const adversarialResult = phaseResultNamed(phaseResults, "adversarial_verify");
  const adversarialFailure = objectValue(adversarialResult?.failure);
  const adversarialCause = objectValue(adversarialFailure?.cause) || {};
  const causeFixScope = stringArray(adversarialCause.fix_scope);
  if (causeFixScope.length > 0) return causeFixScope;

  const adversarialFocus = stringArray(riskMap?.adversarialFocus);
  if (adversarialFocus.length > 0) return adversarialFocus;

  const highRiskFiles = stringArray(riskMap?.highRiskFiles);
  if (highRiskFiles.length > 0) return highRiskFiles;

  const executeResult = phaseResultNamed(phaseResults, "execute");
  const executeArtifact = objectValue(executeResult?.artifact);
  if (!executeArtifact) return [];

  const paths = [];
  if (typeof executeArtifact.path === "string" && executeArtifact.path) paths.push(executeArtifact.path);
  paths.push(...stringArray(executeArtifact.files));
  return paths;
}

function buildAdversarialRetryContext(
  gateResult: CompletionGateFailureInput["gateResult"],
  phaseResults: LooseRecord[],
  riskMap: LooseRecord | null | undefined,
) {
  if (gateResult.outcome !== "adversarial_failed") return null;
  const adversarialResult = phaseResultNamed(phaseResults, "adversarial_verify");
  const adversarialFailure = objectValue(adversarialResult?.failure);
  const adversarialCause = objectValue(adversarialFailure?.cause) || {};
  const adversarialVerdict = objectValue(adversarialCause.verdict) || {};
  const causeFocus = stringArray(adversarialCause.focus);
  const riskFocus = stringArray(riskMap?.adversarialFocus);
  return {
    reason: "adversarial_verification_failed",
    adversarialFocus: causeFocus.length > 0 ? causeFocus : riskFocus,
    verdictReason: adversarialVerdict.reason || gateResult.reason,
    blockingEvidence: adversarialVerdict.details || gateResult.reason,
    fix_scope: extractFixScope(phaseResults, riskMap),
  };
}

async function reportProgress(
  onProgress: CompletionFailureInput["onProgress"],
  event: LooseRecord,
  now: () => string,
) {
  if (typeof onProgress !== "function") return;
  try {
    await onProgress({ ts: now(), ...event });
  } catch {
    // Progress reporting must not change job execution outcome.
  }
}

export async function handleArtifactInvalidCompletionFailure({
  cpbRoot,
  project,
  jobId,
  artifactInvalidReason,
  phaseResults,
  appendEvent,
  failJob,
  onProgress = null,
  now = () => new Date().toISOString(),
}: CompletionFailureInput): Promise<FailedJobResult> {
  const failCause = { artifactInvalidReason };
  await appendEvent(cpbRoot, project, jobId, completionGateEvent(jobId, project, {
    outcome: "artifact_invalid",
    reason: artifactInvalidReason,
    missingGates: ["artifact_index"],
    details: failCause,
  }));
  await reportProgress(onProgress, {
    type: "completion_gate_blocked",
    jobId,
    project,
    outcome: "artifact_invalid",
    reason: artifactInvalidReason,
  }, now);
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
    failure: {
      kind: "artifact_invalid",
      phase: "completion_gate",
      reason: artifactInvalidReason,
      cause: failCause,
    },
    phaseResults,
  };
}

export async function handleCompletionGateFailure({
  cpbRoot,
  project,
  jobId,
  gateResult,
  phaseResults,
  riskMap = null,
  checklistVerdict = null,
  failJob,
  onProgress = null,
  now = () => new Date().toISOString(),
}: CompletionGateFailureInput): Promise<FailedJobResult> {
  const adversarialRetryContext = buildAdversarialRetryContext(gateResult, phaseResults, riskMap);
  const gateDetails = objectValue(gateResult.details);
  const checklistResult = objectValue(gateDetails?.checklist);
  const checklistFixScope = stringArray(checklistResult?.failedFixScope);
  const targetChecklistIds = [
    ...stringArray(checklistResult?.failedChecklistIds),
    ...stringArray(checklistResult?.uncheckedChecklistIds),
  ];
  const routing = mapChecklistRoutingLabel(gateResult.outcome, {
    fixScope: checklistFixScope,
    targetChecklistIds,
    evidenceMissingCause: checklistResult?.evidenceMissingCause || null,
  });
  const failCause: LooseRecord = {
    gateOutcome: gateResult.outcome,
    missingGates: gateResult.missingGates,
    details: gateResult.details,
    routingLabel: gateResult.outcome,
    routingAction: routing.action,
    routingRetryPhase: routing.retryPhase,
    fixScope: checklistFixScope,
    checklistVerdict,
    targetChecklistIds,
  };
  if (adversarialRetryContext) {
    failCause.retryContext = adversarialRetryContext;
  }

  await reportProgress(onProgress, {
    type: "completion_gate_blocked",
    jobId,
    project,
    outcome: gateResult.outcome,
    reason: gateResult.reason,
  }, now);
  await failJob(cpbRoot, project, jobId, {
    reason: gateResult.reason,
    code: routing.kind,
    phase: "completion_gate",
    cause: failCause,
  });
  return {
    status: "failed",
    jobId,
    exitCode: 1,
    failure: {
      kind: routing.kind,
      phase: "completion_gate",
      reason: gateResult.reason,
      retryable: routing.retryable,
      cause: failCause,
    },
    phaseResults,
  };
}
