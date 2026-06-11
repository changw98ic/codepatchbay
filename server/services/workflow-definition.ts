import {
  dispatchForPhase as coreDispatchForPhase,
  getWorkflow as getCoreWorkflow,
  isWorkflowName,
  listWorkflows,
  nextPhase as coreNextPhase,
  roleForPhase as coreRoleForPhase,
} from "../../core/workflow/definition.js";

type AnyRecord = Record<string, any>;
type CoreWorkflow = ReturnType<typeof getCoreWorkflow>;
type ServerWorkflow = CoreWorkflow & AnyRecord;

function bridgeMapForPhases(phases: string[] = []) {
  return Object.fromEntries(phases.map((phase) => [phase, "run-phase.js"]));
}

function withServerCompatibility(workflow: CoreWorkflow): ServerWorkflow {
  return {
    ...workflow,
    phases: [...(workflow.phases ?? [])],
    roleForPhase: { ...(workflow.roleForPhase ?? {}) },
    dispatchForPhase: { ...(workflow.dispatchForPhase ?? {}) },
    bridgeForPhase: bridgeMapForPhases(workflow.phases),
  };
}

export function getWorkflow(name: string) {
  return withServerCompatibility(getCoreWorkflow(name));
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
