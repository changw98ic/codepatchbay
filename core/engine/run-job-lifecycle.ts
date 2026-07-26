import { FailureKind } from "../contracts/failure.js";

import { recordValue } from "../contracts/types.js";
import type { RunJobPorts, RunJobState } from "./run-job-ports.js";
import { ts, type JobRunResult } from "./run-job-shared.js";

type PanicContext =
  Pick<RunJobState, "cpbRoot" | "project" | "_jobId" | "_attemptId" | "_currentPhase" | "signal">
  & Pick<RunJobPorts, "failJob" | "appendEvent">;

type FinalizeAuditTrailInput =
  Pick<RunJobState, "cpbRoot" | "project" | "sourceContext">
  & Pick<RunJobPorts, "appendEvent">
  & {
    jobId: string | null | undefined;
    attemptId: string | null | undefined;
    result: JobRunResult;
    now?: () => string;
  };

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Exit-handler-style finalization for audit closure.
 * Must run for success, failure, blocked, and panic paths.
 * Emits runtime_context_snapshot and audit_finalized events.
 * Does not let finalization mark a failed job as successful.
 */
export async function finalizeAuditTrail({
  cpbRoot,
  project,
  jobId,
  attemptId,
  appendEvent,
  result,
  sourceContext,
  now = ts,
}: FinalizeAuditTrailInput) {
  // No audit trail for a job that was never created: createJob threw before
  // resolving a real id, so the panic path carries result.jobId === "unknown"
  // as a public contract (locked by engine-run-job.test.ts). That sentinel must
  // NOT be persisted as a durable runtime_context_snapshot / audit_finalized event.
  if (!jobId || jobId === "unknown") return;
  const assignment = recordValue(sourceContext?.assignment);
  const assignmentMetadata = recordValue(assignment.metadata);
  const resultFailure = recordValue(result.failure);
  try {
    await appendEvent(cpbRoot, project, jobId, {
      type: "runtime_context_snapshot",
      jobId,
      project,
      attemptId,
      assignmentId: stringOrNull(assignment.assignmentId),
      workerId: stringOrNull(assignment.workerId),
      model: stringOrNull(assignmentMetadata.model),
      runtime: stringOrNull(assignmentMetadata.runtime) || stringOrNull(assignment.workflow),
      queueId: stringOrNull(assignment.entryId),
      queuePriority: numberOrNull(assignment.priority),
      concurrencyKey: stringOrNull(assignmentMetadata.concurrencyKey),
      rateLimitedUntil: stringOrNull(assignment.rateLimitedUntil),
      heartbeatAt: null,
      progressKind: null,
      blocker: resultFailure.kind === FailureKind.HUMAN_APPROVAL_REQUIRED ? resultFailure.reason : null,
      ts: now(),
    });
  } catch { /* best-effort */ }

  try {
    await appendEvent(cpbRoot, project, jobId, {
      type: "audit_finalized",
      jobId,
      project,
      attemptId,
      status: result.status || "failed",
      reason: resultFailure.reason || result.reason || null,
      ts: now(),
    });
  } catch { /* best-effort */ }
}

/**
 * Crash barrier handler — invoked when runJobInner() throws an unhandled
 * exception.  Best-effort fails the job so it doesn't remain stuck in
 * "running" state forever.
 */
export async function handleRunJobPanic(ctx: PanicContext, panic: unknown, now = ts): Promise<JobRunResult> {
  const { cpbRoot, project, failJob, appendEvent } = ctx;
  const jobId = ctx._jobId || "unknown";
  const phase = ctx._currentPhase || "unknown";

  // Narrow once and preserve the original normalization semantics exactly:
  //   null/undefined -> "unknown panic" / panicType "Error"
  //   string         -> the string itself / panicType "String"
  //   Error/object   -> .message / .constructor.name
  // Callers must pass the raw caught value; pre-wrapping it (e.g. as
  // { message: String(panic) }) collapses null/string and regresses recovery.
  // retain: dynamic catch-value boundary — panic is an unknown thrown value (Error/string/null/object),
  // narrowing via guard cannot model the optional-property shape without an equivalent assertion.
  const panicObj = panic as { message?: string; stack?: string; name?: string; code?: string; constructor?: { name?: string } } | null | undefined;
  const panicMessage = panicObj?.message || (panic == null ? "unknown panic" : String(panic));
  const panicType = panicObj?.constructor?.name || "Error";
  const interrupted = ctx.signal?.aborted === true
    || panicObj?.name === "AbortError"
    || panicObj?.code === "ABORT_ERR";

  if (interrupted) {
    const reason = panicMessage || "runJob aborted";
    const failPromise = (async () => {
      if (typeof failJob === "function" && jobId !== "unknown") {
        try {
          await failJob(cpbRoot, project, jobId, {
            reason,
            code: FailureKind.RUNTIME_INTERRUPTED,
            kind: FailureKind.RUNTIME_INTERRUPTED,
            phase,
            retryable: false,
            cause: {
              reason: "abort_signal",
              code: FailureKind.RUNTIME_INTERRUPTED,
            },
          });
        } catch { /* best-effort */ }
      }
      if (typeof appendEvent === "function" && jobId !== "unknown") {
        try {
          await appendEvent(cpbRoot, project, jobId, {
            type: "job_failed",
            jobId,
            phase,
            attemptId: ctx._attemptId || jobId,
            reason,
            kind: FailureKind.RUNTIME_INTERRUPTED,
            retryable: false,
            ts: now(),
          });
        } catch { /* best-effort */ }
      }
    })();

    try {
      await Promise.race([
        failPromise,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch { /* best-effort — timeout or rejection */ }

    return {
      status: "failed",
      jobId,
      exitCode: 1,
      failure: {
        kind: FailureKind.RUNTIME_INTERRUPTED,
        phase,
        reason,
        retryable: false,
        cause: {
          reason: "abort_signal",
          code: FailureKind.RUNTIME_INTERRUPTED,
        },
      },
    };
  }

  const failPromise = (async () => {
    if (typeof failJob === "function" && jobId !== "unknown") {
      try {
        await failJob(cpbRoot, project, jobId, {
          reason: `runJob panic: ${panicMessage}`,
          code: "FATAL",
          phase,
          cause: {
            kind: "runjob_panic",
            stack: panicObj?.stack?.slice(0, 4000) || null,
            panicType,
          },
        });
      } catch { /* best-effort */ }
    }
    if (typeof appendEvent === "function" && jobId !== "unknown") {
      try {
        await appendEvent(cpbRoot, project, jobId, {
          type: "job_panic",
          jobId,
          phase,
          attemptId: ctx._attemptId || jobId,
          panicType,
          reason: panicMessage,
          ts: now(),
        });
      } catch { /* best-effort */ }
    }
  })();

  try {
    await Promise.race([
      failPromise,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch { /* best-effort — timeout or rejection */ }

  return {
    status: "failed",
    jobId,
    exitCode: 1,
    failure: {
      kind: FailureKind.RUNJOB_PANIC,
      phase,
      reason: panicMessage,
      retryable: false,
      cause: { panicType, stack: panicObj?.stack?.slice(0, 2000) || null },
    },
  };
}
