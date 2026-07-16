import { isPhasePassed } from "../contracts/phase-result.js";
import { completionGateEvent, evaluateCompletionGate, parseVerdict } from "./completion-gate.js";
import { loadCompletionChecklistArtifacts } from "./completion-checklist-artifacts.js";
import {
  buildCompletionGateFailureResult,
  handleArtifactInvalidCompletionFailure,
  handleCompletionGateFailure,
} from "./completion-failure.js";
import { buildCompletionReport, handleCompletionSuccess } from "./completion-success.js";
import { collectRuntimeFailures, recordRuntimeFailureEvents } from "./runtime-failure-recorder.js";
import {
  captureCandidateArtifact,
  verifyCandidateArtifactIdentity,
  type CandidateArtifact,
} from "./candidate-artifact.js";
import {
  replayCandidateBundleInCleanWorktree,
  replayCandidateInCleanWorktree,
  type CandidateReplayBundle,
} from "./candidate-replay.js";
import {
  applyScopeAmendment,
  buildScopeReviewRequest,
  consensusScopeAmendment,
} from "../workflow/scope-amendment.js";

import { isRecord, type LooseRecord } from "../contracts/types.js";

type CompletionGateRunnerResult = {
  status: string;
  jobId: string;
  exitCode: number;
  failure: LooseRecord | null;
  phaseResults: LooseRecord[];
  completionReport?: LooseRecord | null;
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
  sourcePath?: string;
  attemptId?: string | null;
  getArtifactIndex?: unknown;
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  failJob: (cpbRoot: string, project: string, jobId: string, failure: LooseRecord) => Promise<unknown> | unknown;
  completeJob: (cpbRoot: string, project: string, jobId: string) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
  deferRepairableFailure?: boolean;
  repairContext?: LooseRecord | null;
};

function objectValue(value: unknown): LooseRecord | null {
  return isRecord(value) ? value : null;
}

function phaseResultNamed(phaseResults: LooseRecord[], phase: string) {
  for (let index = phaseResults.length - 1; index >= 0; index -= 1) {
    if (phaseResults[index].phase === phase) return phaseResults[index];
  }
  return null;
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

function candidateFromLatestExecute(phaseResults: LooseRecord[]): CandidateArtifact | null {
  const executeResult = phaseResultNamed(phaseResults, "execute");
  const diagnostics = objectValue(executeResult?.diagnostics);
  const candidate = objectValue(diagnostics?.candidateArtifact);
  if (!candidate || candidate.schemaVersion !== 1 || typeof candidate.identityHash !== "string") return null;
  return candidate as CandidateArtifact;
}

function replayBundleFromLatestExecute(phaseResults: LooseRecord[]): CandidateReplayBundle | null {
  const executeResult = phaseResultNamed(phaseResults, "execute");
  const diagnostics = objectValue(executeResult?.diagnostics);
  const bundle = objectValue(diagnostics?.candidateReplayBundle);
  if (
    !bundle
    || bundle.schemaVersion !== 1
    || typeof bundle.baseSha !== "string"
    || typeof bundle.expectedTreeHash !== "string"
    || typeof bundle.candidateIdentityHash !== "string"
    || typeof bundle.patchSha256 !== "string"
    || typeof bundle.patchBytes !== "number"
    || typeof bundle.bundleHash !== "string"
    || typeof bundle.patch !== "string"
  ) return null;
  return bundle as CandidateReplayBundle;
}

function validatedCandidateHashFromLatestVerify(phaseResults: LooseRecord[]) {
  const verifyResult = phaseResultNamed(phaseResults, "verify");
  const diagnostics = objectValue(verifyResult?.diagnostics);
  return typeof diagnostics?.validatedCandidateIdentityHash === "string"
    ? diagnostics.validatedCandidateIdentityHash
    : null;
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
  sourcePath,
  attemptId = null,
  getArtifactIndex = null,
  appendEvent,
  failJob,
  completeJob,
  onProgress = null,
  now = () => new Date().toISOString(),
  deferRepairableFailure = false,
  repairContext = null,
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

  let candidateValidation: LooseRecord | null = null;
  const expectedCandidate = candidateFromLatestExecute(phaseResults);
  if (expectedCandidate) {
    const replayBundle = replayBundleFromLatestExecute(phaseResults);
    if (replayBundle && replayBundle.candidateIdentityHash !== expectedCandidate.identityHash) {
      return handleArtifactInvalidCompletionFailure({
        cpbRoot,
        project,
        jobId,
        artifactInvalidReason: `candidate replay bundle identity does not match frozen candidate (expected ${expectedCandidate.identityHash}, got ${replayBundle.candidateIdentityHash})`,
        phaseResults,
        appendEvent,
        failJob,
        onProgress,
        now,
      });
    }
    const validatedCandidateHash = validatedCandidateHashFromLatestVerify(phaseResults);
    if (validatedCandidateHash !== expectedCandidate.identityHash) {
      return handleArtifactInvalidCompletionFailure({
        cpbRoot,
        project,
        jobId,
        artifactInvalidReason: `verify did not validate the completion candidate identity (expected ${expectedCandidate.identityHash}, got ${validatedCandidateHash || "none"})`,
        phaseResults,
        appendEvent,
        failJob,
        onProgress,
        now,
      });
    }
    const candidateReplay = replayBundle
      ? await replayCandidateBundleInCleanWorktree({
          cwd: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE || cpbRoot,
          bundle: replayBundle,
          replayedAt: now(),
        })
      : await replayCandidateInCleanWorktree({
          cwd: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE || cpbRoot,
          candidate: expectedCandidate,
          replayedAt: now(),
        });
    await appendEvent(cpbRoot, project, jobId, {
      type: "candidate_clean_replay",
      jobId,
      project,
      attemptId,
      candidateId: expectedCandidate.identityHash,
      identityHash: expectedCandidate.identityHash,
      patchHash: expectedCandidate.patchHash,
      ...candidateReplay,
      ts: now(),
    });
    if (!candidateReplay.cleanApply) {
      return handleArtifactInvalidCompletionFailure({
        cpbRoot,
        project,
        jobId,
        artifactInvalidReason: `candidate cannot be reconstructed from its clean base: ${candidateReplay.reason || "tree mismatch"}`,
        phaseResults,
        appendEvent,
        failJob,
        onProgress,
        now,
      });
    }
    try {
      const actualCandidate = await captureCandidateArtifact({
        cwd: sourcePath || process.env.CPB_PROJECT_PATH_OVERRIDE || cpbRoot,
        base: expectedCandidate.baseSha,
      });
      const candidateVerification = verifyCandidateArtifactIdentity(expectedCandidate, actualCandidate, {
        verifiedAt: now(),
      });
      await appendEvent(cpbRoot, project, jobId, {
        type: "candidate_identity_checked",
        jobId,
        project,
        attemptId,
        expectedIdentityHash: candidateVerification.expectedIdentityHash,
        actualIdentityHash: candidateVerification.actualIdentityHash,
        matches: candidateVerification.matches,
        mismatches: candidateVerification.mismatches,
        ts: now(),
      });
      if (!candidateVerification.matches) {
        return handleArtifactInvalidCompletionFailure({
          cpbRoot,
          project,
          jobId,
          artifactInvalidReason: `validated candidate changed before completion: ${candidateVerification.mismatches.map((item) => item.field).join(", ")}`,
          phaseResults,
          appendEvent,
          failJob,
          onProgress,
          now,
        });
      }
      candidateValidation = {
        schemaVersion: 1,
        baseSha: expectedCandidate.baseSha,
        headSha: expectedCandidate.headSha,
        treeHash: expectedCandidate.treeHash,
        patchHash: expectedCandidate.patchHash,
        identityHash: expectedCandidate.identityHash,
        validatedCandidateIdentityHash: validatedCandidateHash,
        identityMatch: true,
        changedFiles: expectedCandidate.changedFiles,
        replayBundle: replayBundle ? {
          bundleHash: replayBundle.bundleHash,
          patchSha256: replayBundle.patchSha256,
          patchBytes: replayBundle.patchBytes,
        } : null,
        cleanReplay: candidateReplay,
        verifiedAt: candidateVerification.verifiedAt,
      };
    } catch (err) {
      return handleArtifactInvalidCompletionFailure({
        cpbRoot,
        project,
        jobId,
        artifactInvalidReason: `unable to verify candidate identity before completion: ${err instanceof Error ? err.message : String(err)}`,
        phaseResults,
        appendEvent,
        failJob,
        onProgress,
        now,
      });
    }
  }

  let effectiveChecklistArtifacts = { ...checklistArtifacts };
  const scopeReviewRequest = buildScopeReviewRequest({
    executionMap: objectValue(checklistArtifacts["execution-map"]),
    checklist: objectValue(checklistArtifacts["acceptance-checklist"]),
    candidateId: expectedCandidate?.identityHash || null,
  });
  const scopeConsensus = consensusScopeAmendment({ phaseResults, request: scopeReviewRequest });
  if (scopeReviewRequest) {
    if (scopeConsensus.approved === true) {
      const amendment = objectValue(scopeConsensus.amendment) || {};
      const originalExecutionMap = objectValue(checklistArtifacts["execution-map"]) || {};
      effectiveChecklistArtifacts = {
        ...effectiveChecklistArtifacts,
        "execution-map": applyScopeAmendment(originalExecutionMap, amendment),
        "scope-amendment": amendment,
      };
      await appendEvent(cpbRoot, project, jobId, {
        type: "scope_amendment_approved",
        jobId,
        project,
        attemptId,
        candidateId: scopeReviewRequest.candidateId,
        requestHash: scopeReviewRequest.requestHash,
        amendmentHash: amendment.amendmentHash || null,
        unmappedFiles: scopeReviewRequest.unmappedFiles,
        mappings: amendment.mappings || [],
        approvals: amendment.approvals || null,
        ts: now(),
      });
    } else {
      await appendEvent(cpbRoot, project, jobId, {
        type: "scope_amendment_rejected",
        jobId,
        project,
        attemptId,
        candidateId: scopeReviewRequest.candidateId,
        requestHash: scopeReviewRequest.requestHash,
        unmappedFiles: scopeReviewRequest.unmappedFiles,
        reason: scopeConsensus.reason || "independent scope review did not reach approval consensus",
        ts: now(),
      });
    }
  }

  const gateResult = evaluateCompletionGate({
    job: jobForGate,
    workflowDag,
    riskMap: riskMap || undefined,
    dynamicAgentPlan: dynamicAgentPlan || undefined,
    artifactIndex: undefined,
    parsedVerdict,
    parsedAdversarialVerdict,
    checklist: effectiveChecklistArtifacts["acceptance-checklist"] || undefined,
    checklistVerdict: effectiveChecklistArtifacts["checklist-verdict"] || undefined,
    evidenceLedger: effectiveChecklistArtifacts["evidence-ledger"] || undefined,
    executionMap: effectiveChecklistArtifacts["execution-map"] || undefined,
    runtimeFailures,
    attemptId: attemptId || undefined,
  });

  const completionReport = gateResult.outcome === "complete"
    ? buildCompletionReport({
        project,
        jobId,
        checklistArtifacts: effectiveChecklistArtifacts,
        riskMap,
        phaseResults,
        candidateValidation,
      })
    : null;

  await appendEvent(cpbRoot, project, jobId, completionGateEvent(jobId, project, gateResult, { completionReport }));

  if (gateResult.outcome === "complete" && repairContext) {
    await appendEvent(cpbRoot, project, jobId, {
      type: "solver_completion_gate_repair_completed",
      jobId,
      project,
      attemptId,
      ...repairContext,
      status: "passed",
      ts: now(),
    });
  }

  if (gateResult.outcome !== "complete") {
    const deferredResult = buildCompletionGateFailureResult({
      project,
      jobId,
      gateResult,
      phaseResults,
      riskMap,
      checklistVerdict: effectiveChecklistArtifacts["checklist-verdict"] || null,
    });
    const deferredCause = objectValue(deferredResult.failure.cause);
    const retryPhase = typeof deferredCause?.routingRetryPhase === "string"
      ? deferredCause.routingRetryPhase
      : null;
    if (deferRepairableFailure && deferredResult.failure.retryable === true && retryPhase) {
      await appendEvent(cpbRoot, project, jobId, {
        type: "completion_gate_repair_deferred",
        jobId,
        project,
        attemptId,
        outcome: gateResult.outcome,
        reason: gateResult.reason,
        retryPhase,
        fixScope: deferredCause?.fixScope || [],
        targetChecklistIds: deferredCause?.targetChecklistIds || [],
        ts: now(),
      });
      if (typeof onProgress === "function") {
        try {
          await onProgress({
            ts: now(),
            type: "completion_gate_repair_deferred",
            jobId,
            project,
            outcome: gateResult.outcome,
            reason: gateResult.reason,
            retryPhase,
          });
        } catch {
          // Progress reporting must not change job execution outcome.
        }
      }
      return {
        ...deferredResult,
        status: "repairable",
        exitCode: 0,
      };
    }
    return handleCompletionGateFailure({
      cpbRoot,
      project,
      jobId,
      gateResult,
      phaseResults,
      riskMap,
      checklistVerdict: effectiveChecklistArtifacts["checklist-verdict"] || null,
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
    completionReport,
    completeJob,
    onProgress,
    now,
  });
}
