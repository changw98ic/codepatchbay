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
  const jobId = filtered[1];
  if (!project || !jobId) {
    console.error("Usage: cpb repair <project> <job-id> [--agent <name>]");
    process.exit(1);
  }
  const { runPhase } = await import("../../bridges/run-phase.mjs");
  const code = await runPhase("repair", { executorRoot, cpbRoot, project, jobId, agent: agent || undefined });
  return Number.isInteger(code) ? code : 0;
}
