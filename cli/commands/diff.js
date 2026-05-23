import path from "node:path";

export async function run(args, { cpbRoot }) {
  const project = args[0];
  if (!project) {
    console.error("Usage: cpb diff <project>");
    process.exit(1);
  }
  const { getProject, resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);
  const registered = await getProject(hubRoot, project);
  if (!registered?.sourcePath) {
    console.error(`Project source path not found: ${project}`);
    process.exit(1);
  }
  const src = registered.sourcePath;
  const { spawn } = await import("node:child_process");
  const git = spawn("git", ["-C", src, "diff", "--stat"], { stdio: "inherit" });
  await new Promise((resolve) => git.on("close", resolve));
  console.log("");
  const git2 = spawn("git", ["-C", src, "diff"], { stdio: "inherit" });
  await new Promise((resolve) => git2.on("close", resolve));
}
