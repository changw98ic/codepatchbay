export function phaseExecutionContract(
  phase: string,
  options: { flexibleToolChoice?: boolean } = {},
) {
  const phaseBoundary = {
    plan: "Plan the smallest file-scoped path that satisfies the task; do not design unrelated product surface.",
    execute: "Implement only the scoped plan or job request; do not broaden into unrelated refactors.",
    verify: "Verify task-specific acceptance probes before broad regression; generic test success alone is insufficient.",
  }[phase] || "Stay inside this phase boundary.";

  const lookupGuidance = options.flexibleToolChoice
    ? "- Choose the narrowest available repository lookup that fits the task. Use indexed CodeGraph for broad or ambiguous discovery; direct focused file/symbol lookup is valid for small explicit scopes."
    : "- Start with CodeGraph lookup when available; otherwise use focused rg/rg --files.\n- If a CodeGraph MCP tool is available, call it first (for example codegraph_context or mcp__codegraph__codegraph_context) before shell/file fallback.";

  return `## Execution Intensity Contract
${phaseBoundary}
${lookupGuidance}
- Inspect as many relevant files and symbols as needed to establish the exact scope and acceptance probes; do not stop discovery because of an arbitrary lookup count.
- Prefer relevant loaded skills/profile guidance when available, and mention the index/skill path used in your JSON summary.
- Define 2-5 task-specific acceptance probes from the request before running broad regression.
- Stop after producing this phase's JSON envelope; do not continue into the next phase.`;
}
