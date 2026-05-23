export async function run(args, { cpbRoot, executorRoot }) {
  const project = args[0];
  const deliverableId = args[1];
  if (!project || !deliverableId) {
    console.error("Usage: cpb verify <project> <deliverable-id>");
    process.exit(1);
  }
  const { runPhase } = await import("../../bridges/run-phase.mjs");
  const code = await runPhase("verify", { executorRoot, cpbRoot, project, deliverableId });
  return Number.isInteger(code) ? code : 0;
}
