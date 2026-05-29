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
  const task = filtered[1];
  if (!project || !task) {
    console.error("Usage: cpb plan <project> '<task>' [--agent <name>]");
    process.exit(1);
  }
  const { runSinglePhase } = await import("../../bridges/engine-bridge.js");
  return runSinglePhase("plan", { cpbRoot, project, task, agent: agent || undefined });
}
