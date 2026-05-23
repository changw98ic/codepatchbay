export async function run(args, { cpbRoot, executorRoot }) {
  const { runReadinessChecks, formatReadinessHuman, formatReadinessJson } = await import("../../server/services/readiness-checks.js");
  const result = await runReadinessChecks({ cpbRoot });
  if (args.includes("--json")) console.log(formatReadinessJson(result));
  else console.log(formatReadinessHuman(result));
}
