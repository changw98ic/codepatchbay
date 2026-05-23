export async function run(args, { cpbRoot, executorRoot }) {
  const project = args[0];
  const jobId = args[1];
  if (!project || !jobId) {
    console.error("Usage: cpb repair <project> <job-id>");
    process.exit(1);
  }
  const { runPhase } = await import("../../bridges/run-phase.mjs");
  const code = await runPhase("repair", { executorRoot, cpbRoot, project, jobId });
  return Number.isInteger(code) ? code : 0;
}
