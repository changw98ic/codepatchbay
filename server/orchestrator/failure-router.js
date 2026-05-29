import { FailureKind } from "../../core/contracts/failure.js";

const MAX_RETRIES = {
  runtime_interrupted: 2,
  timeout: 1,
  agent_contract_invalid: 1,
  worker_crashed: 2,
  worker_heartbeat_lost: 2,
  agent_rate_limited: 0, // Handled by wait
  verification_failed: 2,
};

export class FailureRouter {
  constructor() {
    this._attemptCounts = new Map(); // entryId → { count, lastFailureAt }
  }

  async route({ assignment, attempt, result }) {
    const failure = result.jobResult?.failure || result.failure || {};
    const entryId = assignment.entryId;

    // Track attempts
    const track = this._attemptCounts.get(entryId) || { count: 0, lastFailureAt: 0 };
    track.count += 1;
    track.lastFailureAt = Date.now();
    this._attemptCounts.set(entryId, track);

    const maxRetries = MAX_RETRIES[failure.kind] ?? 0;

    // Rate limit → wait
    if (failure.kind === FailureKind.AGENT_RATE_LIMITED) {
      return {
        action: "wait_for_rate_limit",
        reason: failure.reason,
        untilTs: failure.cause?.untilTs || Date.now() + 60_000,
        retryable: true,
      };
    }

    // Over retry budget → mark failed
    if (track.count > maxRetries) {
      return {
        action: "mark_failed",
        reason: `${failure.kind} exceeded retry budget (${track.count}/${maxRetries + 1}): ${failure.reason}`,
        retryable: false,
      };
    }

    // Deterministic routing by failure kind
    switch (failure.kind) {
      case FailureKind.RUNTIME_INTERRUPTED:
      case FailureKind.WORKER_CRASHED:
      case FailureKind.WORKER_HEARTBEAT_LOST:
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
        // Complex failure — for now, route to retry
        // Milestone 4 will add ACP Supervisor here
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

  resetBudget(entryId) {
    this._attemptCounts.delete(entryId);
  }
}
