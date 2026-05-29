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

  // Strip prefix if user passes plan-XXX or just XXX
  const cleanPlanId = planId.replace(/^plan-/, "");

  const { runSinglePhase } = await import("../../bridges/engine-bridge.js");
  return runSinglePhase("execute", {
    cpbRoot,
    project,
    planId: cleanPlanId,
    agent: agent || undefined,
  });
}
