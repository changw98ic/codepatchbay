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
  const deliverableId = filtered[1];
  if (!project || !deliverableId) {
    console.error("Usage: cpb verify <project> <deliverable-id-or-job-id> [--agent <name>]");
    process.exit(1);
  }

  // Strip prefix if user passes deliverable-XXX or just XXX
  const cleanDeliverableId = deliverableId.replace(/^deliverable-/, "");

  const { runSinglePhase } = await import("../../bridges/engine-bridge.js");
  return runSinglePhase("verify", {
    cpbRoot,
    project,
    deliverableId: cleanDeliverableId,
    agent: agent || undefined,
  });
}
