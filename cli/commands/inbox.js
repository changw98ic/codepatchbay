import path from "node:path";

const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

export async function run(args, { cpbRoot }) {
  const project = args[0];
  if (!project) {
    console.error("Usage: cpb inbox <project>");
    process.exit(1);
  }
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = path.join(cpbRoot, "wiki/projects", project, "inbox");
  console.log(`${BOLD}Inbox: ${project}${NC}`);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    for (const f of files) {
      const content = await readFile(path.join(dir, f), "utf8");
      const title = content.split("\n")[0]?.replace(/^#*\s*/, "") || "(no title)";
      console.log(`  ${f.replace(/\.md$/, "").padEnd(14)} ${title}`);
    }
  } catch {
    console.log("  (empty)");
  }
}
