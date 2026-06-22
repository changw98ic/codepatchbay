type LooseRecord = Record<string, unknown>;

type PhaseResult = {
  status?: unknown;
  artifact?: {
    name?: unknown;
    [key: string]: unknown;
  } | null;
  diagnostics?: unknown;
  failure?: unknown;
};

type PhaseFailure = {
  kind?: unknown;
  reason?: unknown;
  cause?: unknown;
};

type EmitPhaseResultEventInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phase: string;
  agentName: unknown;
  phaseResult: PhaseResult;
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

function recordValue(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function failurePayload(failure: unknown): LooseRecord | null {
  const fail = recordValue(failure) as PhaseFailure;
  if (!fail.kind && !fail.reason && !("cause" in fail)) return null;
  return {
    kind: fail.kind,
    reason: fail.reason,
    cause: fail.cause || null,
  };
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
  appendEvent,
  onProgress = null,
  now = () => new Date().toISOString(),
}: EmitPhaseResultEventInput): Promise<void> {
  const diagnostics = recordValue(phaseResult.diagnostics);
  const promptArtifact = recordValue(diagnostics.promptArtifact);
  const failure = failurePayload(phaseResult.failure);
  const artifactName = phaseResult.artifact?.name || null;
  const progressPayload = {
    type: "phase_result",
    jobId,
    project,
    phase,
    agent: agentName,
    status: phaseResult.status,
    artifact: artifactName,
    failure,
  };

  await appendEvent(cpbRoot, project, jobId, {
    ...progressPayload,
    promptArtifact: promptArtifact.name || null,
    acpAuditFile: diagnostics.acpAuditFile || null,
    usage: diagnostics.usage || null,
    ts: now(),
  });
  await reportProgress(onProgress, progressPayload, now);
}
