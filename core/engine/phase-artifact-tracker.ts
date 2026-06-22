type LooseRecord = Record<string, unknown>;

type PhaseArtifact = {
  name?: string;
  id?: unknown;
  [key: string]: unknown;
};

type PhaseResult = {
  status?: unknown;
  artifact?: PhaseArtifact | null;
};

type TrackPassedPhaseArtifactInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phase: string;
  state: LooseRecord;
  phaseResult: PhaseResult;
  completePhase: (
    cpbRoot: string,
    project: string,
    jobId: string,
    payload: { phase: string; artifact: unknown },
  ) => Promise<unknown> | unknown;
};

export function extractPhaseArtifactId(artifact: PhaseArtifact | null | undefined) {
  if (!artifact?.name) return null;
  const parts = artifact.name.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : artifact.id || null;
}

export async function trackPassedPhaseArtifact({
  cpbRoot,
  project,
  jobId,
  phase,
  state,
  phaseResult,
  completePhase,
}: TrackPassedPhaseArtifactInput): Promise<boolean> {
  if (phaseResult.status !== "passed" || !phaseResult.artifact) return false;

  const artifactId = extractPhaseArtifactId(phaseResult.artifact);
  if (phase === "plan") state.planId = artifactId;
  if (phase === "execute") state.deliverableId = artifactId;

  await completePhase(cpbRoot, project, jobId, {
    phase,
    artifact: phaseResult.artifact.name,
  });
  return true;
}
