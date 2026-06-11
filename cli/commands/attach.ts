import path from "node:path";

export async function run(args: string[], { cpbRoot }: { cpbRoot: string; executorRoot?: string }) {
  const { registerProject, resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const sourcePath = path.resolve(args[0] || process.cwd());
  const name = args[1] || path.basename(sourcePath);
  const hubRoot = resolveHubRoot(cpbRoot);
  const project = await registerProject(hubRoot, { name, sourcePath, skipCodeGraphGate: true });
  console.log(JSON.stringify({ attached: true, hubRoot, project }, null, 2));
}
