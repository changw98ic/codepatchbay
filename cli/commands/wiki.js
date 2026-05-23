import path from "node:path";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const BOLD = "\x1b[1m";
const NC = "\x1b[0m";

export async function run(args, { cpbRoot, executorRoot }) {
  const sub = args[0] || "list";
  if (sub === "list") {
    const { readdir } = await import("node:fs/promises");
    const wikiDir = path.join(cpbRoot, "wiki");
    const files = [];
    async function walk(dir, prefix = "") {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
        else if (e.name.endsWith(".md")) files.push(rel);
      }
    }
    await walk(wikiDir);
    console.log(`${BOLD}Wiki:${NC}`);
    for (const f of files.sort()) console.log(`  ${f}`);
  } else if (sub === "lint") {
    const { readdir, readFile, access, constants, stat } = await import("node:fs/promises");
    let issues = 0;
    console.log("Wiki health check...");

    // System files
    const systemFiles = [
      "schema.md",
      "system/handshake-protocol.md",
      "system/memory-routing.md",
      "system/skill-registry.md",
      "system/team-prd.md",
      "system/team-architecture.md",
      "system/dashboard.md",
      "system/unattended-supervisor.md",
    ];
    for (const f of systemFiles) {
      try {
        await access(path.join(cpbRoot, "wiki", f), constants.F_OK);
      } catch {
        console.log(`  Missing: ${f}`);
        issues++;
      }
    }

    // ACP client
    try {
      await access(path.join(executorRoot, "bridges", "acp-client.mjs"), constants.X_OK);
    } catch {
      console.log("  acp-client.mjs not executable");
      issues++;
    }

    // Per-project checks
    const projectsDir = path.join(cpbRoot, "wiki/projects");
    try {
      const entries = await readdir(projectsDir);
      for (const name of entries) {
        if (name === "_template") continue;
        const dir = path.join(projectsDir, name);
        const s = await stat(dir);
        if (!s.isDirectory()) continue;

        // Boundary violations
        try {
          const inboxFiles = (await readdir(path.join(dir, "inbox"))).filter((f) => f.startsWith("deliverable-"));
          if (inboxFiles.length > 0) {
            console.log(`  ${name}: deliverable in inbox`);
            issues++;
          }
        } catch {}
        try {
          const outputFiles = (await readdir(path.join(dir, "outputs"))).filter((f) => f.startsWith("plan-"));
          if (outputFiles.length > 0) {
            console.log(`  ${name}: plan in outputs`);
            issues++;
          }
        } catch {}

        // Incomplete handoffs
        for (const subdir of ["inbox", "outputs"]) {
          try {
            const files = (await readdir(path.join(dir, subdir))).filter((f) => f.endsWith(".md"));
            for (const f of files) {
              const content = await readFile(path.join(dir, subdir, f), "utf8");
              if (!content.match(/Acceptance[- ]Criteria|Next-Action/i)) {
                console.log(`  ${name}: incomplete handoff ${f}`);
                issues++;
              }
            }
          } catch {}
        }

        // Stale files (older than 7 days in inbox)
        try {
          const files = (await readdir(path.join(dir, "inbox"))).filter((f) => f.endsWith(".md"));
          const now = Date.now();
          for (const f of files) {
            const s = await stat(path.join(dir, "inbox", f));
            const ageDays = (now - s.mtimeMs) / (1000 * 60 * 60 * 24);
            if (ageDays > 7) {
              console.log(`  ${name}: stale inbox file ${f} (>7 days)`);
              issues++;
            }
          }
        } catch {}
      }
    } catch {}

    if (issues === 0) {
      console.log(`  ${GREEN}All checks passed.${NC}`);
    } else {
      console.log(`  ${RED}${issues} issue(s)${NC}`);
    }
  } else {
    console.error("Usage: cpb wiki [list|lint]");
    process.exit(1);
  }
}
