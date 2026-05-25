import path from "node:path";

export async function run(args, { cpbRoot }) {
  const sub = args[0];
  const project = args[1];
  const json = args.includes("--json");
  if (!sub || !project) {
    console.error("Usage: cpb index <status|refresh|graph|impact|context-pack> <project> [target|task] [--json]");
    process.exit(1);
  }
  const { getProject, resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const { readProjectCodeIndexStatus, refreshProjectCodeIndex } = await import("../../server/services/project-code-index.js");
  const { buildRepoGraph, ensureRepoGraph, generateContextPack, queryRepoImpact } = await import("../../server/services/repo-graph.js");
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
  } else if (sub === "graph") {
    const graph = await buildRepoGraph(proj, { hubRoot });
    const result = {
      status: "ready",
      project: proj.id,
      graphPath: graph.graphPath,
      stats: graph.stats,
      edges: graph.edges,
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("RepoGraph: ready");
      console.log(`  Path: ${graph.graphPath}`);
      console.log(`  Nodes: ${graph.stats.nodeCount}  Edges: ${graph.stats.edgeCount}`);
    }
  } else if (sub === "impact") {
    const target = args.find((arg, index) => index >= 2 && !arg.startsWith("--"));
    if (!target) {
      console.error("Usage: cpb index impact <project> <target> [--json]");
      process.exit(1);
    }
    const graph = await ensureRepoGraph(proj, { hubRoot, refresh: true });
    const impact = queryRepoImpact(graph, proj, target);
    const result = {
      status: "ready",
      project: proj.id,
      graphPath: graph.graphPath,
      ...impact,
    };
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Impact: ${impact.target}`);
      for (const file of impact.impactedFiles) console.log(`  - ${file}`);
    }
  } else if (sub === "context-pack") {
    const task = args.slice(2).filter((arg) => !arg.startsWith("--")).join(" ").trim();
    if (!task) {
      console.error("Usage: cpb index context-pack <project> \"<task>\" [--json]");
      process.exit(1);
    }
    const result = await generateContextPack(proj, { hubRoot, task });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("Context pack: ready");
      console.log(`  Path: ${result.contextPack.path}`);
      console.log(`  Files: ${result.contextPack.files.length}`);
    }
  } else {
    console.error(`Unknown index subcommand: ${sub}`);
    process.exit(1);
  }
}
