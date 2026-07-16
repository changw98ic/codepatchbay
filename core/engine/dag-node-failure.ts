import { FailureKind } from "../contracts/failure.js";
import type { PhaseResult } from "../../shared/types.js";

import { recordValue, type LooseRecord } from "../contracts/types.js";

type HandleDagNodeFailureInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  nodeId: string;
  phase: string;
  role: string;
  attemptId?: string | null;
  dagNode?: unknown;
  phaseResult: PhaseResult;
  phaseResults: LooseRecord[];
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  failJob: (cpbRoot: string, project: string, jobId: string, failure: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

type FailedJobResult = {
  status: "failed";
  jobId: string;
  exitCode: 1;
  failure: LooseRecord;
  phaseResults: LooseRecord[];
};

function messageOrFallback(value: unknown, fallback: string) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function checklistIds(dagNode: unknown) {
  const node = recordValue(dagNode);
  return Array.isArray(node.checklistIds) ? node.checklistIds : [];
}

function retryFailureCause(fail: LooseRecord) {
  if (fail.kind !== FailureKind.VERIFICATION_FAILED) return undefined;
  const cause = recordValue(fail.cause);
  const rawArtifact = cause.artifact;
  const artifact = recordValue(rawArtifact);
  return {
    verdict: cause.verdict || null,
    ...(cause.checklistVerdict ? { checklistVerdict: cause.checklistVerdict } : {}),
    ...(cause.counterexampleDisposition
      ? { counterexampleDisposition: cause.counterexampleDisposition }
      : {}),
    ...(Array.isArray(cause.requestedFixScope)
      ? { requestedFixScope: cause.requestedFixScope }
      : {}),
    ...(Array.isArray(cause.allowedFixScope)
      ? { allowedFixScope: cause.allowedFixScope }
      : {}),
    ...(Array.isArray(cause.targetChecklistIds)
      ? { targetChecklistIds: cause.targetChecklistIds }
      : {}),
    ...(cause.expected !== undefined ? { expected: cause.expected } : {}),
    ...(cause.observed !== undefined ? { observed: cause.observed } : {}),
    ...(cause.verificationInfrastructure
      ? { verificationInfrastructure: cause.verificationInfrastructure }
      : {}),
    artifact: rawArtifact
      ? {
          kind: artifact.kind || null,
          id: artifact.id || null,
          name: artifact.name || null,
          path: artifact.path || null,
          bytes: artifact.bytes ?? null,
          sha256: artifact.sha256 || null,
        }
      : null,
  };
}

async function reportProgress(
  onProgress: HandleDagNodeFailureInput["onProgress"],
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

export async function handleDagNodeFailure({
  cpbRoot,
  project,
  jobId,
  nodeId,
  phase,
  role,
  attemptId = null,
  dagNode = {},
  phaseResult,
  phaseResults,
  appendEvent,
  failJob,
  onProgress = null,
  now = () => new Date().toISOString(),
}: HandleDagNodeFailureInput): Promise<FailedJobResult> {
  const fail = recordValue(phaseResult.failure);
  const reason = messageOrFallback(fail.reason, `${phase} phase failed`);
  const code = messageOrFallback(fail.kind, "fatal");
  const retryCause = retryFailureCause(fail);

  await appendEvent(cpbRoot, project, jobId, {
    type: "dag_node_failed",
    jobId,
    project,
    nodeId,
    phase,
    role,
    attemptId,
    code,
    reason,
    error: reason,
    checklistIds: checklistIds(dagNode),
    ts: now(),
  });
  await failJob(cpbRoot, project, jobId, {
    reason,
    code,
    phase,
    cause: { ...fail, nodeId },
  });
  await reportProgress(onProgress, {
    type: "job_failed",
    jobId,
    project,
    phase,
    failureKind: fail.kind || null,
    reason,
  }, now);

  return {
    status: "failed",
    jobId,
    exitCode: 1,
    failure: {
      kind: fail.kind,
      phase,
      nodeId,
      reason: fail.reason,
      retryable: fail.retryable,
      ...(retryCause || fail.cause ? { cause: retryCause || fail.cause } : {}),
    },
    phaseResults,
  };
}
