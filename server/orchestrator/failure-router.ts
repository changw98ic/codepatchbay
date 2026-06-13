import { FailureKind } from "../../core/contracts/failure.js";
import { mapChecklistRoutingLabel } from "../../core/workflow/acceptance-checklist.js";

type AnyRecord = Record<string, any>;

const MAX_RETRIES: Record<string, number> = {
  runtime_interrupted: 2,
  timeout: 1,
  agent_contract_invalid: 1,
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

function collectVerificationRetryScope(failure: AnyRecord = {}) {
  const verdict = failure.cause?.verdict || {};
  const scope = new Set<string>();
  const add = (value: any) => {
    if (typeof value === "string" && value.trim()) scope.add(value.trim());
  };
  const addMany = (values: any) => {
    if (Array.isArray(values)) values.forEach(add);
  };

  addMany(verdict.fix_scope);
  addMany(verdict.fixScope);
  for (const blocking of Array.isArray(verdict.blocking) ? verdict.blocking : []) {
    add(blocking?.file);
    add(blocking?.path);
    addMany(blocking?.files);
    addMany(blocking?.paths);
  }
  // Extract file-only scope from checklistVerdict — do NOT add checklist ids
  const checklistVerdict = verdict.checklistVerdict || failure.cause?.checklistVerdict || {};
  addMany(checklistVerdict.fixScope);
  for (const item of Array.isArray(checklistVerdict.items) ? checklistVerdict.items : []) {
    addMany(item?.fixScope);
  }
  return [...scope];
}

export class FailureRouter {
  supervisor: any;
  readModeFn: (() => Promise<string> | string) | null;

  /**
   * @param {object} [supervisor] - AcpSupervisor instance (optional, P1-2)
   * @param {object} [opts]
   * @param {Function} [opts.readModeFn] - async () => "default"|"smart"
   */
  constructor(supervisor: any = null, opts: AnyRecord = {}) {
    this.supervisor = supervisor;
    this.readModeFn = opts.readModeFn || null;
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
  async route({ assignment, attempt, result }: AnyRecord) {
    const failure = result.jobResult?.failure || result.failure || {};
    const attemptCount = assignment.attempts || 0;
    const maxRetries = MAX_RETRIES[failure.kind] ?? 0;

    if (
      failure.retryable === false &&
      failure.kind !== FailureKind.PERMISSION_DENIED &&
      failure.kind !== FailureKind.HUMAN_APPROVAL_REQUIRED
    ) {
      return {
        action: "mark_failed",
        reason: `${failure.kind} is non-retryable: ${failure.reason}`,
        retryable: false,
      };
    }

    // Rate limit → wait (mid-run fallback handled at engine level in run-job.js)
    if (failure.kind === FailureKind.AGENT_RATE_LIMITED) {
      return {
        action: "wait_for_rate_limit",
        reason: failure.reason,
        untilTs: failure.cause?.nextEligibleAt || failure.cause?.untilTs || Date.now() + 60_000,
        retryable: true,
      };
    }

    // ARTIFACT_INVALID with checklist routing labels that demand fail-closed
    // must not enter the general ARTIFACT_INVALID → restart_worker_and_retry path.
    if (failure.kind === FailureKind.ARTIFACT_INVALID) {
      return {
        action: "mark_failed",
        reason: `${failure.kind}: ${failure.reason}`,
        retryable: false,
      };
    }

    if (failure.kind === FailureKind.VERIFICATION_FAILED) {
      const retryScope = collectVerificationRetryScope(failure);
      // Checklist-aware routing: map routing labels from completion gate
      // to correct retry action, phase, and fixScope.
      const routing = failure.cause?.routingLabel
        ? mapChecklistRoutingLabel(failure.cause.routingLabel, {
            ...failure.cause,
            fixScope: retryScope.length > 0 ? retryScope : (failure.cause?.fixScope || []),
          })
        : null;
      if (routing?.action === "retry_same_worker" && routing.retryPhase) {
        return {
          action: "retry_same_worker",
          reason: failure.reason,
          retryable: true,
          retryPhase: routing.retryPhase,
          ...(routing.requiresFixScope && retryScope.length > 0 ? { fixScope: retryScope } : {}),
        };
      }
      // Non-retryable routing (e.g. scope_violation, missing evidence without probe)
      if (routing && !routing.retryable) {
        return {
          action: "mark_failed",
          reason: `${routing.kind}: ${failure.reason}`,
          retryable: false,
        };
      }
      // Human approval required
      if (routing?.action === "mark_blocked") {
        return {
          action: "mark_blocked",
          reason: failure.reason,
          retryable: false,
        };
      }
      if (retryScope.length === 0) {
        return {
          action: "mark_failed",
          reason: `verification failed without actionable retry scope: ${failure.reason}`,
          retryable: false,
        };
      }
    }

    // Over retry budget → mark failed
    if (attemptCount > maxRetries) {
      return {
        action: "mark_failed",
        reason: `${failure.kind} exceeded retry budget (${attemptCount}/${maxRetries + 1}): ${failure.reason}`,
        retryable: false,
      };
    }

    // P1-2: Complex failures → consult supervisor if available
    if (await this._shouldConsultSupervisor(failure.kind)) {
      try {
        const decision = await this.supervisor.diagnoseFailure({ assignment, attempt, result });
        if (decision && typeof decision.action === "string") {
          return decision;
        }
      } catch {
        // Supervisor failed — fall through to deterministic routing
      }
    }

    // Deterministic routing by failure kind
    switch (failure.kind) {
      case FailureKind.RUNTIME_INTERRUPTED:
      case FailureKind.WORKER_CRASHED:
      case FailureKind.WORKER_HEARTBEAT_LOST:
      case FailureKind.ASSIGNMENT_PROGRESS_STALE:
        return {
          action: "restart_worker_and_retry",
          reason: `${failure.kind}: ${failure.reason}`,
          retryable: true,
        };

      case FailureKind.TIMEOUT:
        return {
          action: "restart_worker_and_retry",
          reason: `timeout: ${failure.reason}`,
          retryable: true,
        };

      case FailureKind.VERIFICATION_FAILED:
        return {
          action: "retry_same_worker",
          reason: `verification failed: ${failure.reason}`,
          retryable: true,
        };

      case FailureKind.AGENT_CONTRACT_INVALID:
      case FailureKind.AGENT_EXIT_NONZERO:
      case FailureKind.ARTIFACT_INVALID:
        return {
          action: "restart_worker_and_retry",
          reason: `${failure.kind}: ${failure.reason}`,
          retryable: true,
        };

      case FailureKind.PERMISSION_DENIED:
      case FailureKind.HUMAN_APPROVAL_REQUIRED:
        return {
          action: "mark_blocked",
          reason: `${failure.kind}: ${failure.reason}`,
          retryable: false,
        };

      case FailureKind.SCOPE_VIOLATION:
        return {
          action: "mark_failed",
          reason: `scope violation: ${failure.reason}`,
          retryable: false,
        };

      default:
        return {
          action: "mark_failed",
          reason: `unhandled failure kind ${failure.kind}: ${failure.reason}`,
          retryable: false,
        };
    }
  }

  resetBudget(_entryId) {
    // Budget derived from assignment.attempts — auto-resets on new assignment
  }
}
