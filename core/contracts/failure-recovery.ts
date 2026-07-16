import { createHash } from "node:crypto";

import { FailureKind } from "./failure.js";
import { recordValue, type LooseRecord } from "./types.js";

export const FailureClass = Object.freeze({
  TASK_UNDERSTANDING: "task_understanding_error",
  LOCATION: "location_error",
  IMPLEMENTATION: "implementation_error",
  TEST_SELECTION: "test_selection_error",
  ENVIRONMENT: "environment_error",
  PROVIDER_TRANSPORT: "provider_transport_error",
  TIMEOUT: "timeout",
  NO_PROGRESS: "no_progress",
  EVIDENCE_INSUFFICIENT: "evidence_insufficient",
  CONTRACT: "contract_error",
  PERMISSION: "permission_error",
  UNKNOWN: "unknown",
});

export type FailureClassValue = typeof FailureClass[keyof typeof FailureClass];
export type RecoveryScope = "phase" | "queue";

export type FailureRecoveryDecision = {
  failureClass: FailureClassValue;
  failureFingerprint: string;
  failureEvidence: LooseRecord;
  retryStrategy: string | null;
  strategyChanged: boolean;
  forceFreshSession: boolean;
  stopReason: string | null;
};

const VALID_CLASSES = new Set<string>(Object.values(FailureClass));

const ROUTING_CLASS: Record<string, FailureClassValue> = {
  needs_clarification: FailureClass.TASK_UNDERSTANDING,
  scope_violation: FailureClass.LOCATION,
  checklist_failed: FailureClass.IMPLEMENTATION,
  evidence_mismatch: FailureClass.IMPLEMENTATION,
  evidence_stale: FailureClass.IMPLEMENTATION,
  evidence_missing: FailureClass.EVIDENCE_INSUFFICIENT,
  checklist_incomplete: FailureClass.EVIDENCE_INSUFFICIENT,
  verdict_invalid: FailureClass.EVIDENCE_INSUFFICIENT,
  checklist_invalid: FailureClass.EVIDENCE_INSUFFICIENT,
  artifact_invalid: FailureClass.CONTRACT,
  dag_uncovered: FailureClass.CONTRACT,
  infra_error: FailureClass.ENVIRONMENT,
  poisoned_session: FailureClass.NO_PROGRESS,
};

const KIND_CLASS: Record<string, FailureClassValue> = {
  [FailureKind.ISSUE_MISMATCH]: FailureClass.TASK_UNDERSTANDING,
  [FailureKind.SCOPE_VIOLATION]: FailureClass.LOCATION,
  [FailureKind.VERIFICATION_FAILED]: FailureClass.IMPLEMENTATION,
  [FailureKind.BROAD_TEST_COMMAND_DENIED]: FailureClass.TEST_SELECTION,
  [FailureKind.CODEGRAPH_UNAVAILABLE]: FailureClass.ENVIRONMENT,
  [FailureKind.RUNTIME_INTERRUPTED]: FailureClass.ENVIRONMENT,
  [FailureKind.WORKER_CRASHED]: FailureClass.ENVIRONMENT,
  [FailureKind.WORKER_HEARTBEAT_LOST]: FailureClass.ENVIRONMENT,
  [FailureKind.RUNJOB_PANIC]: FailureClass.ENVIRONMENT,
  [FailureKind.AGENT_UNAVAILABLE]: FailureClass.PROVIDER_TRANSPORT,
  [FailureKind.AGENT_RATE_LIMITED]: FailureClass.PROVIDER_TRANSPORT,
  [FailureKind.AGENT_SPAWN_ERROR]: FailureClass.ENVIRONMENT,
  [FailureKind.AGENT_EXIT_NONZERO]: FailureClass.PROVIDER_TRANSPORT,
  [FailureKind.TIMEOUT]: FailureClass.TIMEOUT,
  [FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT]: FailureClass.TIMEOUT,
  [FailureKind.ASSIGNMENT_PROGRESS_STALE]: FailureClass.NO_PROGRESS,
  [FailureKind.EXECUTE_NO_EDIT_PROGRESS]: FailureClass.NO_PROGRESS,
  [FailureKind.TOOL_BUDGET_EXCEEDED]: FailureClass.NO_PROGRESS,
  [FailureKind.POISONED_SESSION]: FailureClass.NO_PROGRESS,
  [FailureKind.ARTIFACT_INVALID]: FailureClass.CONTRACT,
  [FailureKind.AGENT_CONTRACT_INVALID]: FailureClass.CONTRACT,
  [FailureKind.VERDICT_INVALID]: FailureClass.EVIDENCE_INSUFFICIENT,
  [FailureKind.READ_ONLY_MUTATION_DENIED]: FailureClass.PERMISSION,
  [FailureKind.WEB_TOOL_DENIED]: FailureClass.PERMISSION,
  [FailureKind.WHOLE_FILESYSTEM_SEARCH_DENIED]: FailureClass.PERMISSION,
  [FailureKind.PERMISSION_DENIED]: FailureClass.PERMISSION,
  [FailureKind.HUMAN_APPROVAL_REQUIRED]: FailureClass.PERMISSION,
};

const STRATEGIES: Record<FailureClassValue, string[]> = {
  [FailureClass.TASK_UNDERSTANDING]: ["replan_from_failure_evidence", "fresh_session_replan"],
  [FailureClass.LOCATION]: ["relocalize_from_failure_evidence", "fresh_session_relocalize"],
  [FailureClass.IMPLEMENTATION]: ["targeted_repair", "fresh_session_diagnosis"],
  [FailureClass.TEST_SELECTION]: ["correct_test_selection", "fresh_session_test_diagnosis"],
  [FailureClass.ENVIRONMENT]: ["fresh_session_environment_retry", "restart_worker_clean_environment"],
  [FailureClass.PROVIDER_TRANSPORT]: ["provider_handoff", "fresh_session_provider_retry"],
  [FailureClass.TIMEOUT]: ["fresh_session_with_carry_forward", "restart_worker_with_carry_forward"],
  [FailureClass.NO_PROGRESS]: ["fresh_session_alternate_approach", "restart_worker_replan"],
  [FailureClass.EVIDENCE_INSUFFICIENT]: ["rebuild_evidence", "fresh_session_evidence_rebuild"],
  [FailureClass.CONTRACT]: ["contract_repair", "fresh_session_contract_repair"],
  [FailureClass.PERMISSION]: ["correct_permission_strategy", "fresh_session_permission_repair"],
  [FailureClass.UNKNOWN]: [],
};

const PHASE_UNSUPPORTED_PREFIXES = ["restart_worker", "fresh_worker"];

function text(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

function normalizedText(value: unknown, maxChars = 2000): string {
  return text(value)
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b(pid|attempt|iteration|retry)\s*[=: #]?\s*\d+\b/gi, "$1=<n>")
    .replace(/\b(?:again|repeated|unchanged)\b/gi, "")
    .replace(/\/tmp\/[^\s'"`]+/g, "/tmp/<path>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<digest>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => normalizedText(entry, 500)).filter(Boolean))].sort()
    : [];
}

function compactChecks(value: unknown): LooseRecord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((entry) => {
    const check = recordValue(entry);
    return {
      gate: normalizedText(check.gate || check.command || check.name, 500) || null,
      exitCode: typeof check.exitCode === "number" ? check.exitCode : null,
      timedOut: check.timedOut === true,
      status: normalizedText(check.status, 100) || null,
      message: normalizedText(check.message || check.stderrTail || check.stdoutTail, 1000) || null,
    };
  });
}

export function classifyFailure(failureValue: unknown): FailureClassValue {
  const failure = recordValue(failureValue);
  const cause = recordValue(failure.cause);
  const explicit = text(failure.failureClass || cause.failureClass);
  if (VALID_CLASSES.has(explicit)) return explicit as FailureClassValue;

  const routingLabel = text(cause.routingLabel || cause.gateOutcome);
  if (ROUTING_CLASS[routingLabel]) return ROUTING_CLASS[routingLabel];

  const kind = text(failure.kind);
  return KIND_CLASS[kind] || FailureClass.UNKNOWN;
}

export function failureEvidence(failureValue: unknown): LooseRecord {
  const failure = recordValue(failureValue);
  const cause = recordValue(failure.cause);
  const solver = recordValue(cause.solver);
  const details = recordValue(cause.details);
  const checklist = recordValue(details.checklist);
  return {
    kind: text(failure.kind) || FailureKind.UNKNOWN,
    failureClass: classifyFailure(failure),
    phase: text(failure.phase) || null,
    reason: normalizedText(failure.reason),
    exitCode: typeof failure.exitCode === "number" ? failure.exitCode : null,
    signal: normalizedText(failure.signal, 100) || null,
    code: normalizedText(cause.code, 200) || null,
    providerKey: normalizedText(cause.providerKey, 200) || null,
    providerStatus: normalizedText(cause.status, 200) || null,
    routingLabel: normalizedText(cause.routingLabel, 200) || null,
    gateOutcome: normalizedText(cause.gateOutcome, 200) || null,
    fixScope: sortedStrings(cause.fixScope || cause.fix_scope || checklist.failedFixScope),
    targetChecklistIds: sortedStrings(cause.targetChecklistIds || checklist.failedChecklistIds),
    missingGates: sortedStrings(cause.missingGates),
    checks: compactChecks(cause.checks),
    stderr: normalizedText(failure.stderrSnippet || cause.stderrTail || cause.stderr, 1000) || null,
    stdout: normalizedText(failure.stdoutSnippet || cause.stdoutTail || cause.stdout, 1000) || null,
    upstreamFingerprint: normalizedText(
      failure.failureFingerprint || cause.failureFingerprint || solver.failureFingerprint,
      200,
    ) || null,
  };
}

export function stableFailureFingerprint(failureValue: unknown): string {
  const encoded = JSON.stringify(failureEvidence(failureValue));
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

function availableStrategies(failureClass: FailureClassValue, scope: RecoveryScope): string[] {
  const strategies = STRATEGIES[failureClass] || [];
  if (scope === "queue") return strategies;
  return strategies.filter((strategy) =>
    strategy !== "provider_handoff"
    && !PHASE_UNSUPPORTED_PREFIXES.some((prefix) => strategy.startsWith(prefix)),
  );
}

export function selectFailureRecovery({
  failure,
  previousFingerprint = null,
  previousStrategy = null,
  preferredStrategy = null,
  scope = "queue",
}: {
  failure: unknown;
  previousFingerprint?: string | null;
  previousStrategy?: string | null;
  preferredStrategy?: string | null;
  scope?: RecoveryScope;
}): FailureRecoveryDecision {
  const failureClass = classifyFailure(failure);
  const failureFingerprint = stableFailureFingerprint(failure);
  const failureEvidenceValue = failureEvidence(failure);
  const repeated = previousFingerprint === failureFingerprint;
  const candidates = availableStrategies(failureClass, scope);
  let retryStrategy: string | null = null;

  if (!repeated) {
    retryStrategy = preferredStrategy || candidates[0] || null;
  } else {
    const previousIndex = previousStrategy ? candidates.indexOf(previousStrategy) : -1;
    const preferredIndex = preferredStrategy ? candidates.indexOf(preferredStrategy) : -1;
    if (preferredIndex > previousIndex && previousIndex >= 0) {
      retryStrategy = preferredStrategy;
    } else {
      retryStrategy = previousIndex >= 0
        ? candidates[previousIndex + 1] || null
        : candidates.find((strategy) => strategy !== previousStrategy) || null;
    }
  }

  const strategyChanged = Boolean(retryStrategy) && (
    previousFingerprint !== failureFingerprint || previousStrategy !== retryStrategy
  );
  const stopReason = retryStrategy
    ? null
    : repeated
      ? `repeated failure ${failureFingerprint} exhausted distinct ${scope} recovery strategies`
      : `failure class ${failureClass} has no ${scope} recovery strategy`;

  return {
    failureClass,
    failureFingerprint,
    failureEvidence: failureEvidenceValue,
    retryStrategy,
    strategyChanged,
    forceFreshSession: Boolean(retryStrategy?.startsWith("fresh_session")),
    stopReason,
  };
}

export function recoveryInstruction(strategy: string | null): string {
  switch (strategy) {
    case "replan_from_failure_evidence": return "Re-read the original task and failure evidence, correct the task interpretation, and produce a bounded revised plan before editing.";
    case "fresh_session_replan": return "Start a fresh diagnosis from the original task plus failure evidence; do not reuse the rejected interpretation.";
    case "relocalize_from_failure_evidence": return "Use the failure evidence to locate the actual implementation boundary and avoid repeating the previous file or symbol selection.";
    case "fresh_session_relocalize": return "Use a fresh session to locate the root cause from repository evidence before modifying code.";
    case "targeted_repair": return "Repair only the cited failing behavior and fix scope, then run focused validation that directly exercises it.";
    case "fresh_session_diagnosis": return "Start a fresh diagnosis, form a different root-cause hypothesis, and produce a materially different candidate.";
    case "correct_test_selection": return "Use the canonical project test entrypoint relevant to the changed behavior; do not repeat the rejected test command.";
    case "fresh_session_test_diagnosis": return "In a fresh session, reconstruct the correct test selection from project configuration and changed behavior.";
    case "fresh_session_environment_retry": return "Retry once in a fresh provider session while preserving concrete environment failure evidence.";
    case "restart_worker_clean_environment": return "Restart the worker with a clean runtime while preserving the failure evidence and worktree identity.";
    case "provider_handoff": return "Change provider execution path and carry forward the exact transport failure evidence; do not replay the same provider request unchanged.";
    case "fresh_session_provider_retry": return "Use a fresh provider session and preserve the exact transport failure evidence.";
    case "fresh_session_with_carry_forward": return "Use a fresh session with bounded carry-forward evidence; do not restart broad exploration.";
    case "restart_worker_with_carry_forward": return "Restart the worker and reuse bounded evidence from the timed-out attempt.";
    case "fresh_session_alternate_approach": return "Use a fresh session and a different bounded approach instead of repeating the no-progress path.";
    case "restart_worker_replan": return "Restart the worker and require a different bounded execution strategy.";
    case "rebuild_evidence": return "Keep the candidate stable, rerun the required objective probes, and cite only current evidence ledger entries.";
    case "fresh_session_evidence_rebuild": return "Use a fresh verifier session to rebuild evidence against the current candidate identity.";
    case "contract_repair": return "Correct the structured output or artifact contract using the validation error and preserve valid prior work.";
    case "fresh_session_contract_repair": return "Use a fresh session to reconstruct the required output contract without copying the rejected envelope.";
    case "correct_permission_strategy": return "Use only operations allowed for this phase and replace the denied action with an allowed equivalent.";
    case "fresh_session_permission_repair": return "Use a fresh session with the phase permission boundary explicit; do not repeat the denied action.";
    default: return "Use the recorded failure evidence and make a materially different recovery attempt.";
  }
}
