import { FailureKind } from "../contracts/failure.js";
import { createHash } from "node:crypto";
import { recordValue, type LooseRecord } from "../contracts/types.js";
import type { PhaseResult } from "../../shared/types.js";

export type VerificationFeedback = {
  schemaVersion: 1;
  iteration: number;
  triggerPhase: "verify" | "adversarial_verify";
  failureKind: string;
  failureReason: string;
  failureFingerprint: string;
  fixScope: string[];
  allowedFixScope: string[];
  targetChecklistIds: string[];
  verdict: unknown;
  artifact: LooseRecord | null;
  evidenceArtifacts: LooseRecord[];
};

export type CompletionGateFeedback = {
  schemaVersion: 1;
  iteration: number;
  failureKind: string;
  failureReason: string;
  failureFingerprint: string;
  gateOutcome: string;
  retryPhase: string;
  fixScope: string[];
  targetChecklistIds: string[];
  missingGates: string[];
  details: unknown;
};

export type VerificationInfrastructureFeedback = {
  schemaVersion: 1;
  iteration: number;
  triggerPhase: "verify" | "adversarial_verify";
  failureKind: string;
  failureReason: string;
  failureFingerprint: string;
  candidateMutationAllowed: false;
  infrastructure: LooseRecord;
};

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(String).map((item) => item.trim()).filter(Boolean)
    : [];
}

function artifactRef(value: unknown): LooseRecord | null {
  const artifact = recordValue(value);
  if (Object.keys(artifact).length === 0) return null;
  return {
    id: artifact.id || null,
    kind: artifact.kind || null,
    name: artifact.name || null,
    path: artifact.path || null,
    sha256: artifact.sha256 || null,
    bytes: artifact.bytes ?? null,
  };
}

function scopePathMatches(candidate: string, allowed: string) {
  const requestedPath = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
  const allowedPath = allowed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  return Boolean(requestedPath && allowedPath)
    && (requestedPath === allowedPath || requestedPath.startsWith(`${allowedPath}/`));
}

export function bindVerificationFeedbackToFrozenScope(
  sourceContext: LooseRecord,
  feedback: VerificationFeedback,
): { ok: true; feedback: VerificationFeedback } | { ok: false; reason: string; requestedFixScope: string[]; allowedFixScope: string[] } {
  const checklist = recordValue(sourceContext.acceptanceChecklist);
  const items = Array.isArray(checklist.items) ? checklist.items.map(recordValue) : [];
  const requestedIds = feedback.targetChecklistIds;
  const selectedItems = requestedIds.length > 0
    ? requestedIds.map((id) => items.find((item) => String(item.id || "") === id)).filter(Boolean).map(recordValue)
    : items;
  if (requestedIds.length > 0 && selectedItems.length !== requestedIds.length) {
    return {
      ok: false,
      reason: "verification counterexample references a checklist item outside the frozen acceptance contract",
      requestedFixScope: feedback.fixScope,
      allowedFixScope: [],
    };
  }
  const allowedFixScope = selectedItems
    .flatMap((item) => stringArray(item.allowedFiles))
    .filter((value, index, all) => all.indexOf(value) === index);
  // An empty legacy scope is not an explicit deny-all contract. The normal
  // execute scope guard still constrains mutations, but there is no frozen
  // path boundary here against which a counterexample can be classified as a
  // scope expansion.
  const outsideScope = allowedFixScope.length > 0
    ? feedback.fixScope.filter(
        (candidate) => !allowedFixScope.some((allowed) => scopePathMatches(candidate, allowed)),
      )
    : [];
  if (outsideScope.length > 0) {
    return {
      ok: false,
      reason: `verification counterexample requests scope outside the frozen acceptance contract: ${outsideScope.join(", ")}`,
      requestedFixScope: feedback.fixScope,
      allowedFixScope,
    };
  }
  return {
    ok: true,
    feedback: {
      ...feedback,
      allowedFixScope,
      fixScope: feedback.fixScope.length > 0
        ? feedback.fixScope
        : requestedIds.length > 0
          ? allowedFixScope
          : [],
    },
  };
}

function stableHash(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function completionGateFailureFingerprint(failureValue: unknown) {
  const failure = recordValue(failureValue);
  const cause = recordValue(failure.cause);
  return stableHash({
    kind: failure.kind || FailureKind.VERIFICATION_FAILED,
    reason: String(failure.reason || "").replace(/\s+/g, " ").trim(),
    gateOutcome: cause.gateOutcome || null,
    retryPhase: cause.routingRetryPhase || null,
    fixScope: stringArray(cause.fixScope).sort(),
    targetChecklistIds: stringArray(cause.targetChecklistIds).sort(),
    missingGates: stringArray(cause.missingGates).sort(),
  });
}

export function completionGateFeedbackFromFailure(
  failureValue: unknown,
  iteration: number,
): CompletionGateFeedback {
  const failure = recordValue(failureValue);
  const cause = recordValue(failure.cause);
  return {
    schemaVersion: 1,
    iteration,
    failureKind: String(failure.kind || FailureKind.VERIFICATION_FAILED),
    failureReason: String(failure.reason || "completion gate failed"),
    failureFingerprint: completionGateFailureFingerprint(failure),
    gateOutcome: String(cause.gateOutcome || "unknown"),
    retryPhase: String(cause.routingRetryPhase || ""),
    fixScope: stringArray(cause.fixScope),
    targetChecklistIds: stringArray(cause.targetChecklistIds),
    missingGates: stringArray(cause.missingGates),
    details: cause.details || null,
  };
}

export function completionGateRepairSourceContext(
  sourceContext: LooseRecord,
  feedback: CompletionGateFeedback,
) {
  const verifyOnly = feedback.retryPhase === "verify";
  const instruction = verifyOnly
    ? "Keep the candidate unchanged. Rerun the objective probes and verification path, cite only evidence IDs that exist in the current ledger, and produce a fresh verdict bound to the current candidate."
    : "Continue in the existing worktree and executor conversation. Repair the implementation for the named checklist items and fix scope, run focused validation, and produce a materially improved candidate before independent verification.";
  return {
    ...sourceContext,
    solver: {
      iteration: feedback.iteration,
      completionGateFeedback: feedback,
      failureFingerprint: feedback.failureFingerprint,
    },
    retry: {
      failureKind: feedback.failureKind,
      failureReason: feedback.failureReason,
      failureFingerprint: feedback.failureFingerprint,
      retryClass: "completion_gate_feedback",
      retryPhase: feedback.retryPhase,
      targetChecklistIds: feedback.targetChecklistIds,
      fixScope: feedback.fixScope,
      attempt: feedback.iteration,
      instruction,
      previousOutput: JSON.stringify(feedback, null, 2),
    },
  };
}

export function verificationFailureFingerprint(result: PhaseResult) {
  const failure = recordValue(result.failure);
  const cause = recordValue(failure.cause);
  const verdict = recordValue(cause.verdict || cause.checklistVerdict);
  const blocking = Array.isArray(verdict.blocking)
    ? verdict.blocking.map((entry) => {
        const item = recordValue(entry);
        return item.checklistId || item.id || item.file || item.path || String(entry);
      }).sort()
    : [];
  return stableHash({
    kind: failure.kind || FailureKind.VERIFICATION_FAILED,
    phase: result.phase,
    reason: String(failure.reason || "").replace(/\s+/g, " ").trim(),
    status: verdict.status || null,
    fixScope: [...stringArray(verdict.fixScope), ...stringArray(cause.fixScope)].sort(),
    blocking,
  });
}

export function isRepairableVerificationFailure(result: PhaseResult | null | undefined) {
  const cause = recordValue(result?.failure?.cause);
  return result?.status === "failed"
    && (result.phase === "verify" || result.phase === "adversarial_verify")
    && result.failure?.kind === FailureKind.VERIFICATION_FAILED
    && result.failure?.retryable === true
    && Object.keys(recordValue(cause.verificationInfrastructure)).length === 0;
}

export function isRecoverableVerificationInfrastructureFailure(
  result: PhaseResult | null | undefined,
) {
  const failure = recordValue(result?.failure);
  const cause = recordValue(failure.cause);
  const infrastructure = recordValue(cause.verificationInfrastructure);
  return result?.status === "failed"
    && (result.phase === "verify" || result.phase === "adversarial_verify")
    && failure.kind === FailureKind.VERIFICATION_FAILED
    && failure.retryable === true
    && infrastructure.failureClass === "verification_infrastructure"
    && infrastructure.candidateMutationAllowed === false;
}

export function verificationInfrastructureFailureFingerprint(result: PhaseResult) {
  const failure = recordValue(result.failure);
  const cause = recordValue(failure.cause);
  const infrastructure = recordValue(cause.verificationInfrastructure);
  const executableEvidence = recordValue(infrastructure.executableEvidence);
  const independentExecutions = recordValue(executableEvidence.independentVerifierExecutions);
  return stableHash({
    kind: failure.kind || FailureKind.VERIFICATION_FAILED,
    phase: result.phase,
    reason: String(failure.reason || "").replace(/\s+/g, " ").trim(),
    retryPhase: infrastructure.retryPhase || result.phase,
    failureClass: infrastructure.failureClass || null,
    candidateMutationAllowed: infrastructure.candidateMutationAllowed,
    executionReason: independentExecutions.reason || null,
  });
}

export function verificationInfrastructureFeedbackFromResult(
  result: PhaseResult,
  iteration: number,
): VerificationInfrastructureFeedback {
  const failure = recordValue(result.failure);
  const cause = recordValue(failure.cause);
  const infrastructure = recordValue(cause.verificationInfrastructure);
  return {
    schemaVersion: 1,
    iteration,
    triggerPhase: result.phase === "adversarial_verify" ? "adversarial_verify" : "verify",
    failureKind: String(failure.kind || FailureKind.VERIFICATION_FAILED),
    failureReason: String(failure.reason || "verification infrastructure failed"),
    failureFingerprint: verificationInfrastructureFailureFingerprint(result),
    candidateMutationAllowed: false,
    infrastructure,
  };
}

export function verificationInfrastructureRetrySourceContext(
  sourceContext: LooseRecord,
  feedback: VerificationInfrastructureFeedback,
) {
  const instruction = [
    "Keep the candidate byte-for-byte unchanged. This is a verification-infrastructure recovery, not an implementation repair.",
    "Run a fresh independent candidate-relevant test or inline runtime behavior probe in the disposable verification replay.",
    "When the frozen checklist contains exact_text or contains_text observable contracts, the inline probe must assert the frozen expectedObservation and reject every forbiddenObservations literal. Do not derive or copy expected values from the candidate, executor-authored tests, or the prior verifier output.",
    "If the canonical command is blocked by missing build, dependency, or toolchain support, diagnose that blocker and use a different repository-appropriate executable path such as an out-of-tree build, an available installed runtime, or a minimal probe that loads the real changed module and exercises the changed entrypoint.",
    "Static inspection, git diff --check, syntax-only checks, and executor self-reports do not satisfy the dynamic evidence gate.",
    "Do not edit source files or tests.",
  ].join(" ");
  return {
    ...sourceContext,
    solver: {
      iteration: feedback.iteration,
      verificationInfrastructureFeedback: feedback,
      failureFingerprint: feedback.failureFingerprint,
    },
    retry: {
      failureKind: feedback.failureKind,
      failureReason: feedback.failureReason,
      failureClass: "verification_infrastructure",
      failureFingerprint: feedback.failureFingerprint,
      retryClass: "verification_infrastructure",
      retryPhase: feedback.triggerPhase,
      candidateMutationAllowed: false,
      attempt: feedback.iteration,
      instruction,
      previousOutput: JSON.stringify(feedback, null, 2),
    },
  };
}

export function verificationFeedbackFromResult(
  result: PhaseResult,
  iteration: number,
): VerificationFeedback {
  const failure = recordValue(result.failure);
  const cause = recordValue(failure.cause);
  const verdict = recordValue(cause.verdict);
  const checklistVerdict = recordValue(cause.checklistVerdict);
  const diagnostics = recordValue(result.diagnostics);
  const evidenceArtifacts = [
    diagnostics.rawAgentOutputArtifact,
    diagnostics.evidenceLedgerArtifact,
    diagnostics.checklistVerdictArtifact,
    diagnostics.promptArtifact,
  ].map(artifactRef).filter((value): value is LooseRecord => Boolean(value));

  const fixScope = [
    ...stringArray(verdict.fixScope),
    ...stringArray(verdict.fix_scope),
    ...stringArray(checklistVerdict.fixScope),
    ...stringArray(checklistVerdict.fix_scope),
    ...stringArray(cause.fixScope),
    ...stringArray(cause.fix_scope),
  ].filter((value, index, all) => all.indexOf(value) === index);
  const targetChecklistIds = [
    ...stringArray(verdict.targetChecklistIds),
    ...stringArray(verdict.target_checklist_ids),
    ...stringArray(checklistVerdict.targetChecklistIds),
    ...stringArray(cause.targetChecklistIds),
  ].filter((value, index, all) => all.indexOf(value) === index);

  return {
    schemaVersion: 1,
    iteration,
    triggerPhase: result.phase === "adversarial_verify" ? "adversarial_verify" : "verify",
    failureKind: String(failure.kind || FailureKind.VERIFICATION_FAILED),
    failureReason: String(failure.reason || "verification failed"),
    failureFingerprint: verificationFailureFingerprint(result),
    fixScope,
    allowedFixScope: [],
    targetChecklistIds,
    verdict: cause.verdict || cause.checklistVerdict || null,
    artifact: artifactRef(cause.artifact),
    evidenceArtifacts,
  };
}

export function solverRepairSourceContext(
  sourceContext: LooseRecord,
  feedback: VerificationFeedback,
) {
  return {
    ...sourceContext,
    solver: {
      iteration: feedback.iteration,
      verificationFeedback: feedback,
      failureFingerprint: feedback.failureFingerprint,
    },
    retry: {
      failureKind: feedback.failureKind,
      failureReason: feedback.failureReason,
      failureFingerprint: feedback.failureFingerprint,
      retryClass: "verification_feedback",
      triggerPhase: feedback.triggerPhase,
      targetChecklistIds: feedback.targetChecklistIds,
      fixScope: feedback.fixScope,
      allowedFixScope: feedback.allowedFixScope,
      attempt: feedback.iteration,
      instruction: `Continue in the existing worktree and executor conversation. Repair the exact ${feedback.triggerPhase} counterexample using the cited evidence, run focused validation, and return a new candidate. The repaired candidate must pass the complete verification suffix again.`,
      previousOutput: JSON.stringify(feedback, null, 2),
    },
  };
}

export function solverRepairLimit(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.CPB_SOLVER_REPAIR_MAX ?? 2);
  if (!Number.isInteger(value) || value < 0) return 2;
  return Math.min(value, 10);
}

export function completionGateRepairLimit(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.CPB_COMPLETION_GATE_REPAIR_MAX ?? 2);
  if (!Number.isInteger(value) || value < 0) return 2;
  return Math.min(value, 10);
}

export function verificationInfrastructureRetryLimit(env: NodeJS.ProcessEnv = process.env) {
  const value = Number(env.CPB_VERIFICATION_INFRA_RETRY_MAX ?? 2);
  if (!Number.isInteger(value) || value < 0) return 2;
  return Math.min(value, 10);
}
