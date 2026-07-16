import { recordValue, type LooseRecord } from "../../shared/types.js";
import { FailureKind } from "../../core/contracts/failure.js";
import { mapChecklistRoutingLabel } from "../../core/workflow/acceptance-checklist.js";
import { selectFailureRecovery } from "../../core/contracts/failure-recovery.js";


const MAX_RETRIES: Record<string, number> = {
  runtime_interrupted: 2,
  timeout: 1,
  [FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT]: 2,
  agent_contract_invalid: 1,
  [FailureKind.PERMISSION_DENIED]: 1,
  worker_crashed: 2,
  worker_heartbeat_lost: 2,
  assignment_progress_stale: 2,
  agent_rate_limited: 0,
  verification_failed: 2,
};

// Complex failures that benefit from supervisor diagnosis (P1-2)
const SUPERVISOR_ELIGIBLE_KINDS = new Set<string>([
  FailureKind.AGENT_CONTRACT_INVALID,
  FailureKind.AGENT_EXIT_NONZERO,
  FailureKind.ARTIFACT_INVALID,
]);

// Additional kinds eligible for supervisor diagnosis in smart mode
const SMART_MODE_SUPERVISOR_KINDS = new Set<string>([
  FailureKind.VERIFICATION_FAILED,
  FailureKind.ASSIGNMENT_PROGRESS_STALE,
  FailureKind.TIMEOUT,
]);

function collectVerificationRetryScope(failure: LooseRecord = {}) {
  const cause = recordValue(failure.cause);
  const verdict = recordValue(cause.verdict);
  const scope = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) scope.add(value.trim());
  };
  const addMany = (values: unknown) => {
    if (Array.isArray(values)) values.forEach(add);
  };

  addMany(cause.fix_scope);
  addMany(cause.fixScope);
  addMany(verdict.fix_scope);
  addMany(verdict.fixScope);
  for (const blocking of Array.isArray(verdict.blocking) ? verdict.blocking : []) {
    const blockingRecord = recordValue(blocking);
    add(blockingRecord.file);
    add(blockingRecord.path);
    addMany(blockingRecord.files);
    addMany(blockingRecord.paths);
  }
  // Extract file-only scope from checklistVerdict — do NOT add checklist ids
  const checklistVerdict = recordValue(verdict.checklistVerdict || cause.checklistVerdict);
  addMany(checklistVerdict.fixScope);
  for (const item of Array.isArray(checklistVerdict.items) ? checklistVerdict.items : []) {
    addMany(recordValue(item).fixScope);
  }
  return [...scope];
}

function isVerifierReadOnlyMutation(failure: LooseRecord) {
  const phase = String(failure.phase || "");
  const reason = String(failure.reason || "");
  if (!/(^|_)verify$/.test(phase)) return false;
  return /read-only phase attempted to modify/i.test(reason) ||
    /read-only phase .*cannot run mutating terminal command/i.test(reason) ||
    Boolean(recordValue(failure.cause).readOnlyMutation);
}

export class FailureRouter {
  supervisor: { diagnoseFailure: (ctx: LooseRecord) => Promise<LooseRecord> } | null;
  readModeFn: (() => Promise<string> | string) | null;

  /**
   * @param {object} [supervisor] - AcpSupervisor instance (optional, P1-2)
   * @param {object} [opts]
   * @param {Function} [opts.readModeFn] - async () => "default"|"smart"
   */
  constructor(supervisor: { diagnoseFailure: (ctx: LooseRecord) => Promise<LooseRecord> } | null = null, opts: { readModeFn?: (() => Promise<string> | string) | null } = {}) {
    this.supervisor = supervisor;
    this.readModeFn = typeof opts.readModeFn === "function" ? opts.readModeFn : null;
  }

  async _shouldConsultSupervisor(failureKind: string) {
    if (!this.supervisor) return false;
    if (SUPERVISOR_ELIGIBLE_KINDS.has(failureKind)) return true;
    // Smart mode extends eligibility
    if (this.readModeFn) {
      const mode = await this.readModeFn();
      if (mode === "smart" && SMART_MODE_SUPERVISOR_KINDS.has(failureKind)) return true;
    }
    return false;
  }

  /**
   * Route a failure. For complex failures, consult AcpSupervisor if available.
   * Reads retry budget from assignment.attempts (durable, P1-4).
   */
  async route({ assignment, attempt, result }: LooseRecord): Promise<LooseRecord> {
    const assignmentRecord = recordValue(assignment);
    const resultRecord = recordValue(result);
    const jobResult = recordValue(resultRecord.jobResult);
    const failure = recordValue(jobResult.failure || resultRecord.failure);
    const failureCause = recordValue(failure.cause);
    const solverFailure = recordValue(failureCause.solver);
    const failureKind = String(failure.kind || "");
    const attemptCount = typeof assignmentRecord.attempts === "number" ? assignmentRecord.attempts : 0;
    const maxRetries = MAX_RETRIES[failureKind] ?? 0;
    const sourceContext = recordValue(assignmentRecord.sourceContext || recordValue(assignmentRecord.metadata).sourceContext);
    const previousRetry = recordValue(sourceContext.retry);
    const previousFingerprint = typeof previousRetry.failureFingerprint === "string" ? previousRetry.failureFingerprint : null;
    const previousStrategy = typeof previousRetry.retryStrategy === "string" ? previousRetry.retryStrategy : null;
    const initialRecovery = selectFailureRecovery({ failure, scope: "queue" });
    const upstreamFingerprint = typeof solverFailure.failureFingerprint === "string"
      ? solverFailure.failureFingerprint
      : typeof failureCause.failureFingerprint === "string" ? failureCause.failureFingerprint : null;
    const fingerprintRepeated = previousFingerprint === initialRecovery.failureFingerprint
      || Boolean(upstreamFingerprint && previousFingerprint === upstreamFingerprint);
    const normalizedPreviousFingerprint = fingerprintRepeated
      ? initialRecovery.failureFingerprint
      : previousFingerprint;
    const recoveryFor = (preferredStrategy: string | null = null) => selectFailureRecovery({
      failure,
      previousFingerprint: normalizedPreviousFingerprint,
      previousStrategy,
      preferredStrategy,
      scope: "queue",
    });
    const failureRecovery = recoveryFor(
      solverFailure.exhausted === true ? "fresh_session_diagnosis" : null,
    );
    const failureMetadata = {
      failureClass: failureRecovery.failureClass,
      failureFingerprint: failureRecovery.failureFingerprint,
      failureEvidence: failureRecovery.failureEvidence,
    };
    const retryDecision = (decision: LooseRecord, preferredStrategy: string | null = null): LooseRecord => {
      if (fingerprintRepeated && !previousStrategy) {
        return {
          action: "mark_failed",
          reason: `repeated unchanged failure ${initialRecovery.failureFingerprint} has no recorded prior strategy; blind retry denied`,
          retryable: false,
          ...failureMetadata,
          retryStrategy: null,
          strategyChanged: false,
        };
      }
      const recovery = recoveryFor(preferredStrategy || (typeof decision.retryStrategy === "string" ? decision.retryStrategy : null));
      if (!recovery.retryStrategy || !recovery.strategyChanged) {
        return {
          action: "mark_failed",
          reason: recovery.stopReason || `retry strategy did not change for ${recovery.failureFingerprint}`,
          retryable: false,
          ...failureMetadata,
          retryStrategy: recovery.retryStrategy,
          strategyChanged: recovery.strategyChanged,
        };
      }
      return {
        ...decision,
        failureClass: recovery.failureClass,
        failureFingerprint: recovery.failureFingerprint,
        failureEvidence: recovery.failureEvidence,
        retryStrategy: recovery.retryStrategy,
        strategyChanged: recovery.strategyChanged,
        forceFreshSession: recovery.forceFreshSession,
      };
    };

    if (
      failure.retryable === false &&
      failure.kind !== FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT &&
      failure.kind !== FailureKind.PERMISSION_DENIED &&
      failure.kind !== FailureKind.HUMAN_APPROVAL_REQUIRED
    ) {
      return {
        action: "mark_failed",
        reason: `${failure.kind} is non-retryable: ${failure.reason}`,
        retryable: false,
        ...failureMetadata,
      };
    }

    // Rate limit → wait (mid-run fallback handled at engine level in run-job.js)
    if (failure.kind === FailureKind.AGENT_RATE_LIMITED) {
      return {
        action: "wait_for_rate_limit",
        reason: failure.reason,
        untilTs: failureCause.nextEligibleAt || failureCause.untilTs || Date.now() + 60_000,
        retryable: true,
        ...failureMetadata,
        retryStrategy: "wait_for_rate_limit_window",
        strategyChanged: previousStrategy !== "wait_for_rate_limit_window",
      };
    }

    // ARTIFACT_INVALID with checklist routing labels that demand fail-closed
    // must not enter the general ARTIFACT_INVALID → restart_worker_and_retry path.
    if (failure.kind === FailureKind.ARTIFACT_INVALID) {
      return {
        action: "mark_failed",
        reason: `${failure.kind}: ${failure.reason}`,
        retryable: false,
        ...failureMetadata,
      };
    }

    let verificationRetryScope: string[] = [];
    if (failure.kind === FailureKind.VERIFICATION_FAILED) {
      verificationRetryScope = collectVerificationRetryScope(failure);
      // Checklist-aware routing: map routing labels from completion gate
      // to correct retry action, phase, and fixScope.
      const routingLabel = typeof failureCause.routingLabel === "string" ? failureCause.routingLabel : "";
      const routing = routingLabel
        ? mapChecklistRoutingLabel(routingLabel, {
            ...failureCause,
            fixScope: verificationRetryScope.length > 0 ? verificationRetryScope : (Array.isArray(failureCause.fixScope) ? failureCause.fixScope : []),
          })
        : null;
      if (routing?.action === "retry_same_worker" && routing.retryPhase) {
        return retryDecision({
          action: "retry_same_worker",
          reason: failure.reason,
          retryable: true,
          retryPhase: routing.retryPhase,
          ...(routing.requiresFixScope && verificationRetryScope.length > 0 ? { fixScope: verificationRetryScope } : {}),
        }, routing.retryPhase === "verify" ? "rebuild_evidence" : "targeted_repair");
      }
      // Non-retryable routing (e.g. scope_violation, missing evidence without probe)
      if (routing && !routing.retryable) {
        return {
          action: "mark_failed",
          reason: `${routing.kind}: ${failure.reason}`,
          retryable: false,
          ...failureMetadata,
        };
      }
      // Human approval required
      if (routing?.action === "mark_blocked") {
        return {
          action: "mark_blocked",
          reason: failure.reason,
          retryable: false,
          ...failureMetadata,
        };
      }
      if (verificationRetryScope.length === 0 && solverFailure.exhausted !== true) {
        return {
          action: "mark_failed",
          reason: `verification failed without actionable retry scope: ${failure.reason}`,
          retryable: false,
          ...failureMetadata,
        };
      }
    }

    // Over retry budget → mark failed
    if (attemptCount > maxRetries) {
      return {
        action: "mark_failed",
        reason: `${failure.kind} exceeded retry budget (${attemptCount}/${maxRetries + 1}): ${failure.reason}`,
        retryable: false,
        ...failureMetadata,
      };
    }

    // P1-2: Complex failures → consult supervisor if available
    if (await this._shouldConsultSupervisor(failureKind)) {
      try {
        const decision = await this.supervisor.diagnoseFailure({ assignment, attempt, result });
        if (decision && typeof decision.action === "string") {
          if (["retry_same_worker", "restart_worker_and_retry", "reroute", "switch_agent"].includes(decision.action)) {
            return retryDecision(decision);
          }
          return { ...decision, ...failureMetadata };
        }
      } catch {
        // Supervisor failed — fall through to deterministic routing
      }
    }

    // Deterministic routing by failure kind
    switch (failureKind) {
      case FailureKind.RUNTIME_INTERRUPTED:
      case FailureKind.WORKER_CRASHED:
      case FailureKind.WORKER_HEARTBEAT_LOST:
      case FailureKind.ASSIGNMENT_PROGRESS_STALE:
        return retryDecision({
          action: "restart_worker_and_retry",
          reason: `${failure.kind}: ${failure.reason}`,
          retryable: true,
        });

      case FailureKind.TIMEOUT:
      case FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT:
        return retryDecision({
          action: "restart_worker_and_retry",
          reason: `${failure.kind}: ${failure.reason}`,
          retryable: true,
        });

      case FailureKind.VERIFICATION_FAILED:
        return retryDecision({
          action: "retry_same_worker",
          reason: solverFailure.exhausted === true
            ? `in-attempt solver exhausted; start one fresh diagnosis attempt: ${failure.reason}`
            : `verification failed: ${failure.reason}`,
          retryable: true,
          retryPhase: solverFailure.exhausted === true ? null : "execute",
          retryStrategy: solverFailure.exhausted === true ? "fresh_session_diagnosis" : "targeted_repair",
          ...(verificationRetryScope.length > 0 ? { fixScope: verificationRetryScope } : {}),
        }, solverFailure.exhausted === true ? "fresh_session_diagnosis" : "targeted_repair");

      case FailureKind.AGENT_CONTRACT_INVALID:
      case FailureKind.AGENT_EXIT_NONZERO:
      case FailureKind.ARTIFACT_INVALID:
        return retryDecision({
          action: "restart_worker_and_retry",
          reason: `${failure.kind}: ${failure.reason}`,
          retryable: true,
        });

      case FailureKind.PERMISSION_DENIED:
        if (isVerifierReadOnlyMutation(failure)) {
          return retryDecision({
            action: "retry_same_worker",
            reason: `verifier read-only mutation denied: ${failure.reason}`,
            retryable: true,
            retryPhase: "verify",
          }, "correct_permission_strategy");
        }
      // fall through
      case FailureKind.HUMAN_APPROVAL_REQUIRED:
        return {
          action: "mark_blocked",
          reason: `${failure.kind}: ${failure.reason}`,
          retryable: false,
          ...failureMetadata,
        };

      case FailureKind.SCOPE_VIOLATION:
        return {
          action: "mark_failed",
          reason: `scope violation: ${failure.reason}`,
          retryable: false,
          ...failureMetadata,
        };

      default:
        return {
          action: "mark_failed",
          reason: `unhandled failure kind ${failure.kind}: ${failure.reason}`,
          retryable: false,
          ...failureMetadata,
        };
    }
  }

  resetBudget(_entryId: string) {
    // Budget derived from assignment.attempts — auto-resets on new assignment
  }
}
