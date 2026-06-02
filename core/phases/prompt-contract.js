export function phaseExecutionContract(phase) {
  const phaseBoundary = {
    plan: "Plan the smallest file-scoped path that satisfies the task; do not design unrelated product surface.",
    execute: "Implement only the scoped plan or job request; do not broaden into unrelated refactors.",
    verify: "Verify task-specific acceptance probes before broad regression; generic test success alone is insufficient.",
  }[phase] || "Stay inside this phase boundary.";

  return `## Execution Intensity Contract
${phaseBoundary}
- Start with indexed lookup: use codegraph, project code index, or context pack if available; otherwise use focused rg/rg --files.
- First-pass inspection budget: max 5 files or 3 symbol/index lookups before naming the exact files you will modify or verify.
- Prefer relevant loaded skills/profile guidance when available, and mention the index/skill path used in your JSON summary.
- Define 2-5 task-specific acceptance probes from the request before running broad regression.
- Stop after producing this phase's JSON envelope; do not continue into the next phase.`;
}
