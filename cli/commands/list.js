import path from "node:path";

const CYAN = "\x1b[0;36m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

export async function run(args, { cpbRoot }) {
  const { readdir, stat } = await import("node:fs/promises");
  const projectsDir = path.join(cpbRoot, "wiki/projects");
  let found = false;
  console.log(`${BOLD}CodePatchbay Projects:${NC}`);
  try {
    const entries = await readdir(projectsDir);
    for (const name of entries) {
      if (name === "_template") continue;
      const dir = path.join(projectsDir, name);
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
      found = true;
      let inbox = 0;
      let outputs = 0;
      try {
        const i = await readdir(path.join(dir, "inbox"));
        inbox = i.filter((f) => f.endsWith(".md")).length;
      } catch {}
      try {
        const o = await readdir(path.join(dir, "outputs"));
        outputs = o.filter((f) => f.endsWith(".md")).length;
      } catch {}
      let verdict = "";
      try {
        const o = await readdir(path.join(dir, "outputs"));
        const v = o.filter((f) => f.startsWith("verdict-") && f.endsWith(".md")).sort().pop();
        if (v) {
          const { readFile } = await import("node:fs/promises");
          const content = await readFile(path.join(dir, "outputs", v), "utf8");
          const match = content.match(/^VERDICT:\s*(\w+)/m);
          verdict = match?.[1] || "";
        }
      } catch {}
      console.log(`  ${CYAN}${name.padEnd(20)}${NC} inbox:${String(inbox).padEnd(3)} out:${String(outputs).padEnd(3)} ${verdict}`);
    }
  } catch {}
  if (!found) console.log("  None. Run: cpb init <path> <name>");
}
