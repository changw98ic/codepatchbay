import path from "node:path";

export async function run(args, { cpbRoot }) {
  const sub = args[0];
  const project = args[1];
  const json = args.includes("--json");
  if (!sub || !project) {
    console.error("Usage: cpb index <status|refresh> <project> [--json]");
    process.exit(1);
  }
  const { getProject, resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { readProjectCodeIndexStatus, refreshProjectCodeIndex } = await import("../../server/services/project-code-index.js");
  const hubRoot = resolveHubRoot(cpbRoot);
  const proj = await getProject(hubRoot, project);
  if (!proj) { console.error(`Project '${project}' not found.`); process.exit(1); }
  if (!proj.sourcePath) { console.error(`Project '${project}' has no sourcePath.`); process.exit(1); }

  if (sub === "status") {
    const status = await readProjectCodeIndexStatus(proj, { hubRoot });
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`Index: ${status.status}`);
      if (status.status === "ready") {
        console.log(`  Files: ${status.fileCount}  Symbols: ${status.symbolCount}  Commands: ${status.commandCount}`);
        if (status.branch) console.log(`  Branch: ${status.branch} (${status.headShort || "-"})`);
        console.log(`  Updated: ${status.updatedAt}`);
        console.log(`  Hash: ${status.contentHash}`);
      }
    }
  } else if (sub === "refresh") {
    const result = await refreshProjectCodeIndex(proj, { hubRoot });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Index: ${result.status}`);
      console.log(`  Files: ${result.fileCount}  Symbols: ${result.symbolCount}  Commands: ${result.commandCount}`);
      if (result.branch) console.log(`  Branch: ${result.branch} (${result.headShort || "-"})`);
      console.log(`  Hash: ${result.contentHash}`);
    }
  } else {
    console.error(`Unknown index subcommand: ${sub}`);
    process.exit(1);
  }
}
