type LooseRecord = Record<string, unknown>;

type AppendEvent = (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
type ProgressSink = ((event: LooseRecord) => Promise<unknown> | unknown) | null;

type DagNodeLifecycleInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  nodeId: string;
  phase: string;
  role: string;
  dagNode?: unknown;
  appendEvent: AppendEvent;
  now?: () => string;
};

type EmitDagNodeSkippedEventInput = DagNodeLifecycleInput & {
  reason?: string;
  resumeTarget?: unknown;
  onProgress?: ProgressSink;
};

type EmitDagNodeCompletedEventInput = DagNodeLifecycleInput & {
  attemptId?: string | null;
  artifactName?: unknown;
};

function recordValue(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function checklistIds(dagNode: unknown) {
  const node = recordValue(dagNode);
  return Array.isArray(node.checklistIds) ? node.checklistIds : [];
}

async function reportProgress(
  onProgress: ProgressSink | undefined,
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

export async function emitDagNodeSkippedEvent({
  cpbRoot,
  project,
  jobId,
  nodeId,
  phase,
  role,
  dagNode = {},
  reason = "resume_completed_node",
  resumeTarget = null,
  appendEvent,
  onProgress = null,
  now = () => new Date().toISOString(),
}: EmitDagNodeSkippedEventInput): Promise<void> {
  await appendEvent(cpbRoot, project, jobId, {
    type: "dag_node_skipped",
    jobId,
    project,
    nodeId,
    phase,
    role,
    reason,
    resumeTarget,
    checklistIds: checklistIds(dagNode),
    ts: now(),
  });
  await reportProgress(onProgress, {
    type: "dag_node_skipped",
    jobId,
    project,
    nodeId,
    phase,
    role,
    reason,
  }, now);
}

export async function emitDagNodeCompletedEvent({
  cpbRoot,
  project,
  jobId,
  nodeId,
  phase,
  role,
  attemptId = null,
  artifactName = null,
  dagNode = {},
  appendEvent,
  now = () => new Date().toISOString(),
}: EmitDagNodeCompletedEventInput): Promise<void> {
  await appendEvent(cpbRoot, project, jobId, {
    type: "dag_node_completed",
    jobId,
    project,
    nodeId,
    phase,
    role,
    attemptId,
    artifact: artifactName || null,
    checklistIds: checklistIds(dagNode),
    ts: now(),
  });
}
