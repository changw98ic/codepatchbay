export async function run(args: string[], { cpbRoot, executorRoot }: { cpbRoot: string; executorRoot: string }) {
  const project = args[0];
  const task = args[1];
  if (!project || !task) {
    console.error("Usage: cpb research <project> '<task>'");
    process.exit(1);
  }
  const { runResearch } = await import("../../server/services/evolve/evolve.js");
  const code = await runResearch({ project, task, executorRoot, cpbRoot });
  return Number.isInteger(code) ? code : 0;
}
