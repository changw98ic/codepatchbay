const WORKFLOWS = {
  standard: {
    name: "standard",
    phases: ["plan", "execute", "verify"],
    roleForPhase: { plan: "codex", execute: "claude", verify: "codex" },
    bridgeForPhase: {
      plan: "codex-plan.sh",
      execute: "claude-execute.sh",
      verify: "codex-verify.sh",
    },
  },
  blocked: {
    name: "blocked",
    phases: [],
    roleForPhase: {},
    bridgeForPhase: {},
  },
};

export function getWorkflow(name) {
  return WORKFLOWS[name] ?? WORKFLOWS.standard;
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
