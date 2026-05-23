export async function run(args, { cpbRoot, executorRoot }) {
  const project = args[0];
  const task = args[1];
  if (!project || !task) {
    console.error("Usage: cpb plan <project> '<task>'");
    process.exit(1);
  }
  const { runPhase } = await import("../../bridges/run-phase.mjs");
  const code = await runPhase("plan", { executorRoot, cpbRoot, project, task });
  return Number.isInteger(code) ? code : 0;
}
