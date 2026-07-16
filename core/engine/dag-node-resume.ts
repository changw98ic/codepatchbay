import { emitDagNodeSkippedEvent } from "./dag-node-lifecycle-events.js";
import { extractPhaseArtifactId } from "./phase-artifact-tracker.js";

import { isRecord, type LooseRecord } from "../contracts/types.js";
import type { PhaseArtifact } from "../../shared/types.js";

type HandleResumeCompletedDagNodeInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  nodeId: string;
  phase: string;
  role: string;
  dagNode?: unknown;
  artifact?: PhaseArtifact | null;
  verdict?: unknown;
  resumeTarget?: unknown;
  state: LooseRecord;
  phaseResults: LooseRecord[];
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

export async function handleResumeCompletedDagNode({
  cpbRoot,
  project,
  jobId,
  nodeId,
  phase,
  role,
  dagNode = {},
  artifact = null,
  verdict = null,
  resumeTarget = null,
  state,
  phaseResults,
  appendEvent,
  onProgress = null,
  now = () => new Date().toISOString(),
}: HandleResumeCompletedDagNodeInput): Promise<void> {
  if (artifact) {
    const artifactId = extractPhaseArtifactId(artifact);
    if (phase === "plan") state.planId = artifactId;
    if (phase === "execute") state.deliverableId = artifactId;
  }

  const normalizedVerdict = typeof verdict === "string" || isRecord(verdict) ? verdict : null;
  const normalizedResumeTarget = typeof resumeTarget === "string" || isRecord(resumeTarget) ? resumeTarget : null;
  phaseResults.push({
    schemaVersion: 1,
    phase,
    status: "passed",
    artifact,
    verdict: normalizedVerdict,
    failure: null,
    diagnostics: {
      skipped: true,
      reason: "resume_completed_node",
      nodeId,
      resumeTarget: normalizedResumeTarget,
    },
    createdAt: now(),
  });

  await emitDagNodeSkippedEvent({
    cpbRoot,
    project,
    jobId,
    nodeId,
    phase,
    role,
    dagNode,
    resumeTarget: normalizedResumeTarget,
    appendEvent,
    onProgress,
    now,
  });
}
