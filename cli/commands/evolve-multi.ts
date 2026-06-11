export async function run(args: string[], { cpbRoot, executorRoot }: { cpbRoot?: string; executorRoot?: string }) {
  const { runEvolveMultiCli } = await import("../../server/services/evolve/evolve.js");
  return runEvolveMultiCli(args, { cpbRoot, executorRoot });
}
