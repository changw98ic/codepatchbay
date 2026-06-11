// @ts-nocheck
import path from "node:path";

const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

export async function run(args, { cpbRoot }) {
  const project = args[0];
  if (!project) {
    console.error("Usage: cpb outputs <project>");
    process.exit(1);
  }
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = path.join(cpbRoot, "wiki/projects", project, "outputs");
  console.log(`${BOLD}Outputs: ${project}${NC}`);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    for (const f of files) {
      const name = f.replace(/\.md$/, "");
      let type = "other";
      if (name.startsWith("verdict-")) type = "verdict";
      else if (name.startsWith("deliverable-")) type = "deliverable";
      let verdict = "";
      if (type === "verdict") {
        const content = await readFile(path.join(dir, f), "utf8");
        const match = content.match(/^VERDICT:\s*(\w+)/m);
        verdict = match?.[1] || "";
      }
      console.log(`  ${name.padEnd(18)} ${type.padEnd(12)} ${verdict}`);
    }
  } catch {
    console.log("  (empty)");
  }
}
