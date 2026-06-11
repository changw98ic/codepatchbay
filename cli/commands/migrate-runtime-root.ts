import { resolveHubRoot } from "../../server/services/hub/hub-registry.js";
import { migrateRuntimeRoot, migrateToProjectRuntimeRoots, printReport } from "../../server/services/runtime-root-migration.js";

export async function run(args: string[], { cpbRoot }: { cpbRoot: string }) {
  const dryRun = !args.includes("--execute") || args.includes("--dry-run");
  const quarantineNonCodePatchbay = args.includes("--quarantine-non-cpb");
  const legacyOnly = args.includes("--legacy-omc-only");
  const hubRootIndex = args.indexOf("--hub-root");
  const hubRoot = hubRootIndex >= 0 && args[hubRootIndex + 1]
    ? args[hubRootIndex + 1]
    : resolveHubRoot(cpbRoot);

  if (args.includes("--help") || args.includes("-h")) {
    console.log([
      "Usage: cpb migrate-runtime-root [--execute] [--dry-run] [--hub-root <path>] [--legacy-omc-only]",
      "",
      "Migrates legacy runtime data into Hub project runtime roots.",
      "Defaults to dry-run. Use --execute for the breaking one-time migration.",
    ].join("\n"));
    return 0;
  }

  if (dryRun) {
    console.log("=== DRY RUN: No files will be moved or deleted ===\n");
  }

  const report = legacyOnly
    ? await migrateRuntimeRoot(cpbRoot, { dryRun, quarantineNonCodePatchbay })
    : await migrateToProjectRuntimeRoots(cpbRoot, hubRoot, { dryRun, quarantineNonCodePatchbay });
  printReport(report);
  return report.conflicts.length > 0 || report.retained.length > 0 ? 2 : 0;
}
