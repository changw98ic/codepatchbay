const WORKCPBS = {
  standard: {
    name: "standard",
    phases: ["plan", "execute", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    bridgeForPhase: {
      plan: "planner.sh",
      execute: "executor.sh",
      verify: "verifier.sh",
    },
  },
  complex: {
    name: "complex",
    phases: ["plan", "execute", "review", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", review: "reviewer", verify: "verifier" },
    bridgeForPhase: {
      plan: "planner.sh",
      execute: "executor.sh",
      review: "reviewer.sh",
      verify: "verifier.sh",
    },
  },
  blocked: {
    name: "blocked",
    phases: [],
    roleForPhase: {},
    bridgeForPhase: {},
  },
  accelerated: {
    name: "accelerated",
    phases: ["plan", "execute", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    bridgeForPhase: {
      plan: "planner.sh",
      execute: "executor.sh",
      verify: "verifier.sh",
    },
    requireSubagents: { plan: true, execute: true, verify: true, repair: true },
    subagentConfig: { maxConcurrency: 3 },
    verificationLayers: ["fast", "changed", "regression", "acceptance"],
  },
};

export function getWorkflow(name) {
  return WORKCPBS[name] ?? WORKCPBS.standard;
}

export function nextPhase(workflow, currentPhase) {
  const phases = workflow.phases;
  if (phases.length === 0) return null;
  if (currentPhase === null || currentPhase === undefined) return phases[0];
  const idx = phases.indexOf(currentPhase);
  if (idx === -1 || idx >= phases.length - 1) return null;
  return phases[idx + 1];
}

export function bridgeForPhase(workflow, phase) {
  return workflow.bridgeForPhase[phase] ?? null;
}

export function roleForPhase(workflow, phase) {
  return workflow.roleForPhase[phase] ?? null;
}

export function phaseRequiresSubagents(workflow, phase) {
  return workflow.requireSubagents?.[phase] === true;
}

export function getVerificationLayers(workflow) {
  return workflow.verificationLayers ?? null;
}

export function getSubagentConfig(workflow) {
  return workflow.subagentConfig ?? null;
}

export function listWorkflows() {
  return Object.keys(WORKCPBS);
}

export function isWorkflowName(name) {
  return Object.hasOwn(WORKCPBS, name);
}
