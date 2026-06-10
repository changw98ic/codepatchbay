const WORKCPBS = {
  standard: {
    name: "standard",
    phases: ["plan", "execute", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    dispatchForPhase: { plan: "planner", execute: "executor", verify: "verifier" },
    bridgeForPhase: {
      plan: "run-phase.mjs",
      execute: "run-phase.mjs",
      verify: "run-phase.mjs",
    },
  },
  complex: {
    name: "complex",
    phases: ["plan", "execute", "review", "verify"],
    roleForPhase: { plan: "planner", execute: "executor", review: "reviewer", verify: "verifier" },
    dispatchForPhase: { plan: "planner", execute: "executor", review: "reviewer", verify: "verifier" },
    bridgeForPhase: {
      plan: "run-phase.mjs",
      execute: "run-phase.mjs",
      review: "run-phase.mjs",
      verify: "run-phase.mjs",
    },
  },
  blocked: {
    name: "blocked",
    phases: [],
    roleForPhase: {},
    dispatchForPhase: {},
    bridgeForPhase: {},
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

export function dispatchForPhase(workflow, phase) {
  return workflow.dispatchForPhase[phase] ?? null;
}

export function roleForPhase(workflow, phase) {
  return workflow.roleForPhase[phase] ?? null;
}
