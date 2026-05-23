export async function run(args, { cpbRoot, executorRoot }) {
  const project = args[0];
  const planId = args[1];
  if (!project || !planId) {
    console.error("Usage: cpb execute <project> <plan-id-or-job-id>");
    process.exit(1);
  }
  const { runPhase } = await import("../../bridges/run-phase.mjs");

  // When --job-id is set in pipeline context, pass it through for locator-first dispatch
  const jobId = process.env.CPB_JOB_ID || process.env.CPB_ACP_JOB_ID || null;

  const code = await runPhase("execute", {
    executorRoot,
    cpbRoot,
    project,
    planId,
    jobId,
  });
  return Number.isInteger(code) ? code : 0;
}
