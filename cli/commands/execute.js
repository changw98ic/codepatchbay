export async function run(args, { cpbRoot, executorRoot }) {
  const project = args[0];
  const planId = args[1];
  if (!project || !planId) {
    console.error("Usage: cpb execute <project> <plan-id>");
    process.exit(1);
  }
  const { runPhase } = await import("../../bridges/run-phase.mjs");
  const code = await runPhase("execute", { executorRoot, cpbRoot, project, planId });
  return Number.isInteger(code) ? code : 0;
}
