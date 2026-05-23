export async function run(args, { cpbRoot, executorRoot }) {
  const filtered = [];
  let agent = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) {
      agent = args[++i];
    } else {
      filtered.push(args[i]);
    }
  }
  const project = filtered[0];
  const planId = filtered[1];
  if (!project || !planId) {
    console.error("Usage: cpb execute <project> <plan-id-or-job-id> [--agent <name>]");
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
    agent: agent || undefined,
  });
  return Number.isInteger(code) ? code : 0;
}
