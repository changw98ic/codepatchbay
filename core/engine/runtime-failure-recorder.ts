import { FailureKind } from "../contracts/failure.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";

export type RuntimeFailureRef = {
  type: "poisoned_session" | "runjob_panic" | "phase_poisoned_session";
  attemptId: string | null;
  phase: string | null;
  nodeId: string | null;
  reason: string | null;
};

type CollectRuntimeFailuresInput = {
  phaseResults: unknown[];
  attemptId?: string | null;
};

type RecordRuntimeFailureEventsInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  attemptId?: string | null;
  runtimeFailures: RuntimeFailureRef[];
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  now?: () => string;
};

function stringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function poisonedReason(poisonedSession: LooseRecord): string | null {
  return Array.isArray(poisonedSession.reasons)
    ? poisonedSession.reasons.join(", ")
    : stringOrNull(poisonedSession.reason);
}

export function collectRuntimeFailures({
  phaseResults,
  attemptId = null,
}: CollectRuntimeFailuresInput): RuntimeFailureRef[] {
  const runtimeFailures: RuntimeFailureRef[] = [];
  for (const phaseResultValue of phaseResults) {
    const phaseResult = recordValue(phaseResultValue);
    const failure = recordValue(phaseResult.failure);
    if (failure.kind === FailureKind.POISONED_SESSION || failure.kind === FailureKind.RUNJOB_PANIC) {
      runtimeFailures.push({
        type: failure.kind === FailureKind.POISONED_SESSION ? "poisoned_session" : "runjob_panic",
        attemptId,
        phase: stringOrNull(phaseResult.phase),
        nodeId: null,
        reason: stringOrNull(failure.reason),
      });
    }

    const diagnostics = recordValue(phaseResult.diagnostics);
    if (diagnostics.poisonedSession) {
      const poisonedSession = recordValue(diagnostics.poisonedSession);
      if (!runtimeFailures.some((runtimeFailure) => runtimeFailure.phase === phaseResult.phase && runtimeFailure.type === "phase_poisoned_session")) {
        runtimeFailures.push({
          type: "phase_poisoned_session",
          attemptId,
          phase: stringOrNull(phaseResult.phase),
          nodeId: stringOrNull(diagnostics.nodeId),
          reason: poisonedReason(poisonedSession),
        });
      }
    }
  }
  return runtimeFailures;
}

export async function recordRuntimeFailureEvents({
  cpbRoot,
  project,
  jobId,
  attemptId = null,
  runtimeFailures,
  appendEvent,
  now = () => new Date().toISOString(),
}: RecordRuntimeFailureEventsInput): Promise<void> {
  for (const runtimeFailure of runtimeFailures) {
    await appendEvent(cpbRoot, project, jobId, {
      type: "runtime_failure_recorded",
      jobId,
      project,
      failureType: runtimeFailure.type,
      attemptId: runtimeFailure.attemptId || attemptId,
      phase: runtimeFailure.phase,
      nodeId: runtimeFailure.nodeId,
      reason: runtimeFailure.reason,
      ts: now(),
    });
  }
}
