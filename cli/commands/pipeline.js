export async function run(args, { cpbRoot, executorRoot }) {
  const interactive = args[0] === "--interactive";
  if (interactive) args.shift();
  const project = args[0];
  const task = args[1];
  const retries = parseInt(args[2] || "3", 10);
  if (!project || !task) {
    console.error("Usage: cpb pipeline [--interactive] <project> '<task>' [retries]");
    process.exit(1);
  }
  if (interactive) {
    console.error("Interactive mode not yet implemented in Node CLI");
    process.exit(1);
  }
  const { runPipeline } = await import("../../bridges/run-pipeline.mjs");
  const code = await runPipeline({ project, task, maxRetries: retries, executorRoot, cpbRoot });
  return Number.isInteger(code) ? code : 0;
}
