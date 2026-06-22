type LooseRecord = Record<string, unknown>;

type EmitPhaseStartEventsInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  phase: string;
  role: string;
  nodeId: string;
  dagNode?: unknown;
  selectedAgent?: unknown;
  attemptId?: string | null;
  startPhase?: (cpbRoot: string, project: string, jobId: string, payload: LooseRecord) => Promise<unknown> | unknown;
  appendEvent: (cpbRoot: string, project: string, jobId: string, event: LooseRecord) => Promise<unknown> | unknown;
  onProgress?: ((event: LooseRecord) => Promise<unknown> | unknown) | null;
  now?: () => string;
};

function recordValue(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function checklistIds(dagNode: unknown) {
  const node = recordValue(dagNode);
  return Array.isArray(node.checklistIds) ? node.checklistIds : [];
}

async function reportProgress(
  onProgress: EmitPhaseStartEventsInput["onProgress"],
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

export async function emitPhaseStartEvents({
  cpbRoot,
  project,
  jobId,
  phase,
  role,
  nodeId,
  dagNode = {},
  selectedAgent = null,
  attemptId = null,
  startPhase,
  appendEvent,
  onProgress = null,
  now = () => new Date().toISOString(),
}: EmitPhaseStartEventsInput): Promise<void> {
  if (typeof startPhase === "function") {
    await startPhase(cpbRoot, project, jobId, {
      phase,
      agent: selectedAgent || null,
      role,
    });
  } else {
    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_started",
      jobId,
      project,
      phase,
      agent: selectedAgent || null,
      ts: now(),
    });
  }

  await appendEvent(cpbRoot, project, jobId, {
    type: "dag_node_started",
    jobId,
    project,
    nodeId,
    phase,
    role,
    attempt: 1,
    attemptId,
    checklistIds: checklistIds(dagNode),
    ts: now(),
  });
  await reportProgress(onProgress, {
    type: "phase_started",
    jobId,
    project,
    phase,
    role,
    agent: selectedAgent || null,
  }, now);
}
