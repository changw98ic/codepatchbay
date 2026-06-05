import { FailureKind } from "../../core/contracts/failure.js";

const MAX_RETRIES = {
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
const SUPERVISOR_ELIGIBLE_KINDS = new Set([
  FailureKind.AGENT_CONTRACT_INVALID,
  FailureKind.AGENT_EXIT_NONZERO,
  FailureKind.ARTIFACT_INVALID,
]);

export class FailureRouter {
  /**
   * @param {object} [supervisor] - AcpSupervisor instance (optional, P1-2)
   */
  constructor(supervisor = null) {
    this.supervisor = supervisor;
  }

  /**
   * Route a failure. For complex failures, consult AcpSupervisor if available.
   * Reads retry budget from assignment.attempts (durable, P1-4).
   */
  async route({ assignment, attempt, result }) {
    const failure = result.jobResult?.failure || result.failure || {};
    const attemptCount = assignment.attempts || 0;
    const maxRetries = MAX_RETRIES[failure.kind] ?? 0;

    // Rate limit → wait (mid-run fallback handled at engine level in run-job.js)
    if (failure.kind === FailureKind.AGENT_RATE_LIMITED) {
      return {
        action: "wait_for_rate_limit",
        reason: failure.reason,
        untilTs: failure.cause?.nextEligibleAt || failure.cause?.untilTs || Date.now() + 60_000,
        retryable: true,
      };
    }

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

    // Over retry budget → mark failed
    if (attemptCount > maxRetries) {
      return {
        action: "mark_failed",
        reason: `${failure.kind} exceeded retry budget (${attemptCount}/${maxRetries + 1}): ${failure.reason}`,
        retryable: false,
      };
    }

    // P1-2: Complex failures → consult supervisor if available
    if (this.supervisor && SUPERVISOR_ELIGIBLE_KINDS.has(failure.kind)) {
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
