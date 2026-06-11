import path from "node:path";

const CYAN = "\x1b[0;36m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

export async function run(_args: string[], { cpbRoot }: { cpbRoot: string }) {
  const { listProjects, resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);
  const projects = await listProjects(hubRoot) as Array<Record<string, any>>;

  console.log(`${BOLD}CodePatchbay Projects:${NC}`);
  if (projects.length === 0) {
    console.log("  None. Run: cpb attach <path> [name]");
    return;
  }

  for (const project of projects) {
    const tag = project.enabled === false ? "-" : " ";
    const src = project.sourcePath || "?";
    let verdict = "";
    try {
      const { readFile, readdir } = await import("node:fs/promises");
      const outDir = path.join(src, "wiki/projects", project.id, "outputs");
      const files = await readdir(outDir);
      const v = files.filter((f) => f.startsWith("verdict-") && f.endsWith(".md")).sort().pop();
      if (v) {
        const content = await readFile(path.join(outDir, v), "utf8");
        const match = content.match(/^VERDICT:\s*(\w+)/m);
        verdict = match?.[1] || "";
      }
    } catch {}
    console.log(` ${tag} ${CYAN}${project.id.padEnd(20)}${NC} ${src} ${verdict}`);
  }
}
