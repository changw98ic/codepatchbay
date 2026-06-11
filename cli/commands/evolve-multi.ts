export async function run(args: string[], { cpbRoot, executorRoot }: { cpbRoot?: string; executorRoot?: string }) {
  const { runEvolveMultiCli } = await import("../../server/services/evolve-multi-cli.js");
  return runEvolveMultiCli(args, { cpbRoot, executorRoot });
}
