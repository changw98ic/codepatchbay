import { FailureKind } from "../contracts/failure.js";

type LooseRecord = Record<string, unknown>;

export type RuntimeFailureRef = {
  type: "poisoned_session" | "runjob_panic" | "phase_poisoned_session";
  attemptId: unknown;
  phase: unknown;
  nodeId: unknown;
  reason: unknown;
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

function recordValue(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function poisonedReason(poisonedSession: LooseRecord) {
  return Array.isArray(poisonedSession.reasons)
    ? poisonedSession.reasons.join(", ")
    : poisonedSession.reason || null;
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
        phase: phaseResult.phase || null,
        nodeId: null,
        reason: failure.reason || null,
      });
    }

    const diagnostics = recordValue(phaseResult.diagnostics);
    if (diagnostics.poisonedSession) {
      const poisonedSession = recordValue(diagnostics.poisonedSession);
      if (!runtimeFailures.some((runtimeFailure) => runtimeFailure.phase === phaseResult.phase && runtimeFailure.type === "phase_poisoned_session")) {
        runtimeFailures.push({
          type: "phase_poisoned_session",
          attemptId,
          phase: phaseResult.phase || null,
          nodeId: diagnostics.nodeId || null,
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
