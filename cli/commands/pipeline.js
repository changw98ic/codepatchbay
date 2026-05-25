export async function run(args, { cpbRoot, executorRoot }) {
  const interactive = args[0] === "--interactive";
  if (interactive) args.shift();
  let planMode = "auto";
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--plan-mode" && args[i + 1]) {
      planMode = args[++i];
    } else {
      filtered.push(args[i]);
    }
  }
  const project = filtered[0];
  const task = filtered[1];
  const retries = parseInt(filtered[2] || "3", 10);
  if (!project || !task) {
    console.error("Usage: cpb pipeline [--interactive] [--plan-mode auto|none|light|full|parent] <project> '<task>' [retries]");
    process.exit(1);
  }
  if (interactive) {
    console.error("Interactive mode not yet implemented in Node CLI");
    process.exit(1);
  }
  const { runPipeline } = await import("../../bridges/run-pipeline.mjs");
  const code = await runPipeline({ project, task, maxRetries: retries, planMode, executorRoot, cpbRoot });
  return Number.isInteger(code) ? code : 0;
}
