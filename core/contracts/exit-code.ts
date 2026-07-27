/**
 * Frozen process exit-code table for the `cpb fix` / `cpb task` product
 * facades.
 *
 * Two modes, each with a distinct contract:
 *
 * 1. DEFAULT (`cpb fix`, `cpb task` without `--follow`)
 *
 *    The facade accepts the request, creates a queue entry, prints the
 *    `taskId`, and EXITS. It does NOT wait for the task to run. Therefore:
 *
 *      0   = accepted into the queue (a TaskView with a taskId exists)
 *      non-0 = the request was rejected PRE-SUBMIT — no task was created.
 *              The non-zero value identifies which PreSubmitFailure category
 *              applied (see `task-view.ts`).
 *
 * 2. `--follow` (`cpb fix --follow`, `cpb task --follow`)
 *
 *    The facade blocks until the task reaches a terminal state, then exits
 *    with a verdict-driven code:
 *
 *      0   = the task reached `succeeded` AND evidence-driven verification
 *            passed. BOTH conditions are required — a task that "completed"
 *            without passing verification is NOT 0.
 *      non-0 = the task did not pass verification: failed, was canceled,
 *              blocked, needs input, or timed out. The value identifies which.
 *
 * Exit codes are part of the public contract: scripts and CI gate on them.
 * Do NOT renumber an existing constant — treat the table as append-only. A
 * new outcome gets a new, unused number; existing numbers are immutable.
 */

/**
 * The frozen exit-code table.
 *
 * `Fix*` constants apply to default (non-follow) mode; `Follow*` constants
 * apply to `--follow` mode. `FixAccepted` and `FollowCompletedVerified` are
 * both 0 because success is 0 regardless of mode.
 *
 * Numeric convention:
 *   0            success
 *   1            generic task failure (verification failed or task errored)
 *   2-5          specific non-zero --follow outcomes / fix pre-submit categories
 *   64-69        pre-submit failures, aligned with BSD sysexits.h where natural
 *                (EX_USAGE=64, EX_DATAERR=65, EX_UNAVAILABLE=69)
 */
export const ExitCode = Object.freeze({
  // ── DEFAULT MODE: cpb fix / cpb task (no --follow) ────────────────────────
  /** Request accepted; a queue entry was created and a taskId was issued. */
  FixAccepted: 0,
  /**
   * Pre-submit failure — `needs_setup`. The project/runtime is uninitialized
   * or misconfigured. No task created. Maps to PreSubmitFailure.NeedsSetup.
   */
  FixNeedsSetup: 64,
  /**
   * Pre-submit failure — `invalid_request`. The request as stated cannot be
   * accepted (empty task, bad name, disallowed scope, unknown project). No
   * task created. Maps to PreSubmitFailure.InvalidRequest.
   */
  FixInvalidRequest: 65,
  /**
   * Pre-submit failure — `runtime_unavailable`. The runtime cannot service
   * the request right now (no capacity, provider unreachable, hub I/O). No
   * task created. Maps to PreSubmitFailure.RuntimeUnavailable.
   */
  FixRuntimeUnavailable: 69,

  // ── --follow MODE: cpb fix --follow / cpb task --follow ───────────────────
  /**
   * Terminal success: the task reached `succeeded` AND evidence-driven
   * verification passed. Both conditions required.
   */
  FollowCompletedVerified: 0,
  /** Task failed verification or errored during execution. */
  FollowFailed: 1,
  /** Task was canceled (by the user, a supervisor decision, or a cancel event). */
  FollowCanceled: 2,
  /** Task is blocked on a dependency and cannot make progress. */
  FollowBlocked: 3,
  /** Task needs user input (clarification, approval) to proceed. */
  FollowNeedsInput: 4,
  /** Task exceeded its time budget (watchdog/timeout fired). */
  FollowTimeout: 5,
} as const);

export type ExitCodeValue = typeof ExitCode[keyof typeof ExitCode];

/**
 * The set of exit codes meaning "request accepted into the queue" (the ONLY
 * zero in default mode). Kept as a set so a future additive success variant
 * can be registered here without changing call sites.
 */
export const FIX_ACCEPTED_EXIT_CODES: readonly number[] = Object.freeze([
  ExitCode.FixAccepted,
]);

/**
 * Mapping from a PreSubmitFailure category (see `task-view.ts`) to the
 * default-mode exit code. The facade MUST use this table rather than choosing
 * an ad-hoc number, so the contract stays in one place.
 *
 * PreScript-signed-off: every PreSubmitFailure has exactly one exit code.
 */
export const PRE_SUBMIT_FAILURE_EXIT_CODE: Readonly<Record<string, number>> =
  Object.freeze({
    needs_setup: ExitCode.FixNeedsSetup,
    invalid_request: ExitCode.FixInvalidRequest,
    runtime_unavailable: ExitCode.FixRuntimeUnavailable,
  });

/** Default-mode exit code for a given PreSubmitFailure category string. */
export function exitCodeForPreSubmitFailure(category: string): number {
  const code = PRE_SUBMIT_FAILURE_EXIT_CODE[category];
  if (typeof code !== "number") {
    // Unknown category is treated as runtime_unavailable: fail safe, non-zero,
    // and explicitly the "we could not service this" code rather than success.
    return ExitCode.FixRuntimeUnavailable;
  }
  return code;
}

/** True iff `code` is a non-zero default-mode (pre-submit) exit code. */
export function isPreSubmitFailureExitCode(code: number): boolean {
  return (
    code === ExitCode.FixNeedsSetup
    || code === ExitCode.FixInvalidRequest
    || code === ExitCode.FixRuntimeUnavailable
  );
}

/**
 * True iff `code` is the success exit in EITHER mode. Both success constants
 * (FixAccepted and FollowCompletedVerified) are 0, so success is simply 0;
 * written against the named constants so a future renumber stays consistent.
 */
export function isSuccessExitCode(code: number): boolean {
  return code === ExitCode.FixAccepted || code === ExitCode.FollowCompletedVerified;
}
