import { recordValue, type LooseRecord } from "../contracts/types.js";

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
  phaseRoutingDecision?: LooseRecord | null;
};


function checklistIds(dagNode: unknown) {
  const node = recordValue(dagNode);
  return Array.isArray(node.checklistIds) ? node.checklistIds : [];
}

function stringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function agentNameOrNull(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  const agent = recordValue(value);
  const name = agent.agent || agent.name || agent.selectedAgent;
  return typeof name === "string" && name ? name : null;
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
  phaseRoutingDecision = null,
}: EmitPhaseStartEventsInput): Promise<void> {
  const agentName = agentNameOrNull(selectedAgent);
  if (typeof startPhase === "function") {
    await startPhase(cpbRoot, project, jobId, {
      phase,
      agent: agentName,
      role,
      attemptId,
    });
  } else {
    await appendEvent(cpbRoot, project, jobId, {
      type: "phase_started",
      jobId,
      project,
      phase,
      attemptId,
      agent: agentName,
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
    agent: agentName,
  }, now);

  if (phaseRoutingDecision?.role) {
    await appendEvent(cpbRoot, project, jobId, {
      type: "agent_routing_decision",
      jobId,
      project,
      phase,
      attemptId,
      role: phaseRoutingDecision.role,
      preferredAgent: phaseRoutingDecision.preferredAgent,
      selectedAgent: phaseRoutingDecision.selectedAgent,
      fallbackAgent: phaseRoutingDecision.fallbackAgent,
      fallbackAllowed: phaseRoutingDecision.fallbackAllowed,
      fallbackApplied: phaseRoutingDecision.fallbackApplied,
      reason: phaseRoutingDecision.reason,
      taskCategory: phaseRoutingDecision.taskCategory,
      selectionSource: phaseRoutingDecision.selectionSource,
      outcomeApplied: phaseRoutingDecision.outcomeApplied,
      outcomeReason: phaseRoutingDecision.outcomeReason,
      staticSelectedAgent: phaseRoutingDecision.staticSelectedAgent,
      staticReason: phaseRoutingDecision.staticReason,
      independenceApplied: phaseRoutingDecision.independenceApplied,
      independenceConflict: phaseRoutingDecision.independenceConflict,
      agentPolicyApplied: phaseRoutingDecision.agentPolicyApplied,
      agentPolicyConflict: phaseRoutingDecision.agentPolicyConflict,
      allowedAgents: phaseRoutingDecision.allowedAgents,
      excludedProviderFamily: phaseRoutingDecision.excludedProviderFamily,
      candidates: phaseRoutingDecision.candidates,
      thresholds: phaseRoutingDecision.thresholds,
      metricsUnavailableReason: phaseRoutingDecision.metricsUnavailableReason,
      ts: now(),
    });
  }
}
