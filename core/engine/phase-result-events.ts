import type { PhaseResult, PhaseFailure } from "../../shared/types.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";

type EmitPhaseResultEventInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phase: string;
  agentName: unknown;
  phaseResult: PhaseResult;
  attemptId?: string | null;
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

function failurePayload(failure: unknown): LooseRecord | null {
  const fail: PhaseFailure = recordValue(failure);
  if (!fail.kind && !fail.reason && !("cause" in fail)) return null;
  return {
    kind: fail.kind,
    reason: fail.reason,
    cause: fail.cause || null,
  };
}

function stringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

async function reportProgress(
  onProgress: EmitPhaseResultEventInput["onProgress"],
  event: LooseRecord,
  now: () => string,
) {
  if (typeof onProgress !== "function") return;
  try {
    await onProgress({ ts: now(), ...event });
  } catch {
    // Progress reporting must not change job execution outcome.
  }
}

export async function emitPhaseResultEvent({
  cpbRoot,
  project,
  jobId,
  phase,
  agentName,
  phaseResult,
  attemptId = null,
  appendEvent,
  onProgress = null,
  now = () => new Date().toISOString(),
}: EmitPhaseResultEventInput): Promise<void> {
  const agent = stringOrNull(agentName);
  const diagnostics = recordValue(phaseResult.diagnostics);
  const promptArtifact = recordValue(diagnostics.promptArtifact);
  const candidateArtifact = recordValue(diagnostics.candidateArtifact);
  const candidateId = stringOrNull(candidateArtifact.identityHash || diagnostics.validatedCandidateIdentityHash);
  const failure = failurePayload(phaseResult.failure);
  const artifactName = phaseResult.artifact?.name || null;
  const progressPayload = {
    type: "phase_result",
    jobId,
    project,
    phase,
    agent,
    status: phaseResult.status,
    artifact: artifactName,
    failure,
  };

  await appendEvent(cpbRoot, project, jobId, {
    ...progressPayload,
    promptArtifact: promptArtifact.name || null,
    acpAuditFile: diagnostics.acpAuditFile || null,
    usage: diagnostics.usage || null,
    ...(attemptId ? { attemptId } : {}),
    ...(candidateId ? { candidateId } : {}),
    ts: now(),
  });
  await reportProgress(onProgress, progressPayload, now);
}
