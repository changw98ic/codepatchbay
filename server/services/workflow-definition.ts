import { recordValue, type LooseRecord } from "../../shared/types.js";
import {
  dispatchForPhase as coreDispatchForPhase,
  getWorkflow as getCoreWorkflow,
  isWorkflowName,
  listWorkflows,
  nextPhase as coreNextPhase,
  roleForPhase as coreRoleForPhase,
} from "../../core/workflow/definition.js";

type CoreWorkflow = ReturnType<typeof getCoreWorkflow>;
type ServerWorkflow = CoreWorkflow & LooseRecord;

// --- Helpers migrated from deleted supervisor.ts ---

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function hasArtifact(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasCompletedPhase(state: LooseRecord, phase: string) {
  const completedPhases = Array.isArray(state.completedPhases) ? state.completedPhases : [];
  return completedPhases.includes(phase) || hasArtifact(recordValue(state.artifacts)[phase]);
}

// --- Job-level convenience functions ---

export function nextPhaseFor(state: LooseRecord) {
  if (!state || TERMINAL_STATUSES.has(state.status)) return "";
  if (state.cancelRequested) return "";

  const workflow = getWorkflow(state.workflow);
  if (workflow.phases.length === 0) return "";

  const artifacts = state.artifacts ?? {};
  for (const phase of workflow.phases) {
    if (!hasCompletedPhase(state, phase)) return phase;
  }
  return "complete";
}

function bridgeMapForPhases(phases: string[] = []) {
  return Object.fromEntries(phases.map((phase) => [phase, "run-phase.js"]));
}

function toServerWorkflow(workflow: CoreWorkflow): ServerWorkflow {
  return {
    ...workflow,
    phases: [...(workflow.phases ?? [])],
    roleForPhase: { ...(workflow.roleForPhase ?? {}) },
    dispatchForPhase: { ...(workflow.dispatchForPhase ?? {}) },
    bridgeForPhase: bridgeMapForPhases(workflow.phases),
  };
}

export function getWorkflow(name: string) {
  return toServerWorkflow(getCoreWorkflow(name));
}

export function nextPhase(workflow: ServerWorkflow, currentPhase?: string | null) {
  return coreNextPhase(workflow, currentPhase);
}

export function bridgeForPhase(workflow: ServerWorkflow, phase: string) {
  return workflow.bridgeForPhase?.[phase] ?? null;
}

export function dispatchForPhase(workflow: ServerWorkflow, phase: string) {
  return coreDispatchForPhase(workflow, phase);
}

export function roleForPhase(workflow: ServerWorkflow, phase: string) {
  return coreRoleForPhase(workflow, phase);
}

export { isWorkflowName, listWorkflows };
