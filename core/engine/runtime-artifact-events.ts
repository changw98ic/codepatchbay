import type { PhaseResult } from "../../shared/types.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";

type RuntimeArtifact = {
  kind?: unknown;
  name?: unknown;
  id?: unknown;
  sha256?: unknown;
};

type AppendEvent = (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;

type WriteRuntimeArtifactEventInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phase: string;
  artifact: RuntimeArtifact;
  appendEvent: AppendEvent;
  attemptId?: string | null;
  now?: () => string;
};

type EmitDiagnosticArtifactEventsInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phase: string;
  phaseResult: PhaseResult;
  appendEvent: AppendEvent;
  attemptId?: string | null;
  now?: () => string;
};

function artifactValue(value: unknown): RuntimeArtifact | null {
  const record = recordValue(value);
  return record.kind && record.name ? record : null;
}

function stringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function isRuntimeArtifact(value: RuntimeArtifact | null): value is RuntimeArtifact {
  return value !== null;
}

export async function writeRuntimeArtifactEvent({
  cpbRoot,
  project,
  jobId,
  phase,
  artifact,
  appendEvent,
  attemptId = null,
  now = () => new Date().toISOString(),
}: WriteRuntimeArtifactEventInput): Promise<void> {
  await appendEvent(cpbRoot, project, jobId, {
    type: "artifact_created",
    jobId,
    project,
    phase,
    kind: stringOrNull(artifact.kind),
    artifactKind: stringOrNull(artifact.kind),
    artifact: stringOrNull(artifact.name),
    artifactId: stringOrNull(artifact.id),
    attemptId: attemptId || null,
    sha256: artifact.sha256 || null,
    ts: now(),
  });
}

export async function emitDiagnosticArtifactEvents({
  cpbRoot,
  project,
  jobId,
  phase,
  phaseResult,
  appendEvent,
  attemptId = null,
  now = () => new Date().toISOString(),
}: EmitDiagnosticArtifactEventsInput): Promise<void> {
  const primaryArtifactName = phaseResult.artifact?.name;
  for (const artifact of Object.values(recordValue(phaseResult.diagnostics)).map(artifactValue).filter(isRuntimeArtifact)) {
    if (artifact.name === primaryArtifactName) continue;
    await writeRuntimeArtifactEvent({
      cpbRoot,
      project,
      jobId,
      phase,
      artifact,
      appendEvent,
      attemptId,
      now,
    });
  }
}
