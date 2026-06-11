// @ts-nocheck
import {
  dispatchForPhase as coreDispatchForPhase,
  getWorkflow as getCoreWorkflow,
  isWorkflowName,
  listWorkflows,
  nextPhase as coreNextPhase,
  roleForPhase as coreRoleForPhase,
} from "../../core/workflow/definition.js";

function bridgeMapForPhases(phases = []) {
  return Object.fromEntries(phases.map((phase) => [phase, "run-phase.js"]));
}

function withServerCompatibility(workflow) {
  return {
    ...workflow,
    phases: [...(workflow.phases ?? [])],
    roleForPhase: { ...(workflow.roleForPhase ?? {}) },
    dispatchForPhase: { ...(workflow.dispatchForPhase ?? {}) },
    bridgeForPhase: bridgeMapForPhases(workflow.phases),
  };
}

export function getWorkflow(name) {
  return withServerCompatibility(getCoreWorkflow(name));
}

export function nextPhase(workflow, currentPhase) {
  return coreNextPhase(workflow, currentPhase);
}

export function bridgeForPhase(workflow, phase) {
  return workflow.bridgeForPhase?.[phase] ?? null;
}

export function dispatchForPhase(workflow, phase) {
  return coreDispatchForPhase(workflow, phase);
}

export function roleForPhase(workflow, phase) {
  return coreRoleForPhase(workflow, phase);
}

export { isWorkflowName, listWorkflows };
