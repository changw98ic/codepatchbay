export async function run(args, { cpbRoot, executorRoot }) {
  const { runEvolveMultiCli } = await import("../../server/services/evolve-multi-cli.js");
  return runEvolveMultiCli(args, { cpbRoot, executorRoot });
}
