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

    // Experience layer structure checks
    try {
      await access(path.join(cpbRoot, "wiki", "experience"), constants.F_OK);
      for (const subdir of ["failures", "patterns", "gotchas"]) {
        try {
          await access(path.join(cpbRoot, "wiki", "experience", subdir), constants.F_OK);
        } catch {
          console.log(`  Missing: experience/${subdir}/`);
          issues++;
        }
      }
      try {
        await access(path.join(cpbRoot, "wiki", "experience", "index.md"), constants.F_OK);
      } catch {
        console.log("  Missing: experience/index.md");
        issues++;
      }
    } catch {
      console.log("  Missing: experience/ directory");
      issues++;
    }

    if (issues === 0) {
      console.log(`  ${GREEN}All checks passed.${NC}`);
    } else {
      console.log(`  ${RED}${issues} issue(s)${NC}`);
    }
  } else if (sub === "experience") {
    const expSub = args[1] || "list";
    const {
      extractExperienceFromVerdict,
      rebuildExperienceIndex,
    } = await import("../../server/services/experience-extractor.js");
    const { readFile, readdir } = await import("node:fs/promises");

    if (expSub === "list") {
      const category = getArg(args, "--category");
      const tag = getArg(args, "--tag");
      const project = getArg(args, "--project");
      await listExperiences(cpbRoot, { category, tag, project });
    } else if (expSub === "search") {
      const keyword = args[2];
      if (!keyword) { console.error("Usage: cpb wiki experience search <keyword>"); process.exit(1); }
      const category = getArg(args, "--category");
      const project = getArg(args, "--project");
      await searchExperiences(cpbRoot, keyword, { category, project });
    } else if (expSub === "rebuild-index") {
      await rebuildExperienceIndex(cpbRoot);
      console.log(`${GREEN}Experience index rebuilt.${NC}`);
    } else if (expSub === "backfill") {
      const project = getArg(args, "--project");
      const force = args.includes("--force");
      await backfillExperiences(cpbRoot, { project, force });
    } else {
      console.error("Usage: cpb wiki experience [list|search|rebuild-index|backfill]");
      process.exit(1);
    }
  } else {
    console.error("Usage: cpb wiki [list|lint|experience ...]");
    process.exit(1);
  }
}

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

async function listExperiences(cpbRoot, { category, tag, project } = {}) {
  const { readFile, readdir } = await import("node:fs/promises");
  const expDir = path.join(cpbRoot, "wiki", "experience");
  const categories = category ? [category] : ["failures", "patterns", "gotchas"];
  const entries = [];

  for (const cat of categories) {
    const dir = path.join(expDir, cat);
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".md") || file === ".gitkeep") continue;
        const content = await readFile(path.join(dir, file), "utf8");
        const meta = parseFrontmatter(content);
        if (project && meta.project !== project) continue;
        if (tag) {
          const tags = Array.isArray(meta.tags) ? meta.tags : [];
          if (!tags.some((t) => t.includes(tag))) continue;
        }
        const title = extractTitle(content);
        entries.push({ cat, date: meta.date || "?", severity: meta.severity || "?", title });
      }
    } catch { /* dir doesn't exist */ }
  }

  entries.sort((a, b) => b.date.localeCompare(a.date));
  for (const e of entries) {
    console.log(`  [${e.cat}] ${e.date} ${e.severity} — ${e.title}`);
  }
  if (entries.length === 0) console.log("  (no experiences found)");
}

async function searchExperiences(cpbRoot, keyword, { category, project } = {}) {
  const { readFile, readdir } = await import("node:fs/promises");
  const expDir = path.join(cpbRoot, "wiki", "experience");
  const categories = category ? [category] : ["failures", "patterns", "gotchas"];
  const kw = keyword.toLowerCase();
  let count = 0;

  for (const cat of categories) {
    const dir = path.join(expDir, cat);
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".md") || file === ".gitkeep") continue;
        const content = await readFile(path.join(dir, file), "utf8");
        if (!content.toLowerCase().includes(kw)) continue;
        const meta = parseFrontmatter(content);
        if (project && meta.project !== project) continue;
        const title = extractTitle(content);
        console.log(`  [${cat}] ${meta.date || "?"} — ${title} (${file})`);
        count++;
      }
    } catch { /* dir doesn't exist */ }
  }

  if (count === 0) console.log(`  (no experiences matching "${keyword}")`);
}

async function backfillExperiences(cpbRoot, { project, force } = {}) {
  const { readdir } = await import("node:fs/promises");
  const { listEventFiles, readEvents } = await import("../../server/services/event-store.js");
  const wikiDir = path.join(cpbRoot, "wiki", "projects");

  let projects;
  try {
    projects = await readdir(wikiDir);
  } catch {
    console.log("  No wiki/projects directory found.");
    return;
  }

  // Build artifact→jobId map from event logs for all relevant projects
  const verdictToJob = new Map(); // key: `${project}/${artifactBasename}`, value: jobId
  const allEventFiles = await listEventFiles(cpbRoot);
  for (const ef of allEventFiles) {
    if (project && ef.project !== project) continue;
    try {
      const events = await readEvents(cpbRoot, ef.project, ef.jobId);
      for (const ev of events) {
        if (typeof ev.artifact === "string" && ev.artifact.startsWith("verdict-")) {
          const key = `${ef.project}/${ev.artifact.replace(/\.(?:md|patch|diff|txt|json)$/i, "")}`;
          if (!verdictToJob.has(key)) verdictToJob.set(key, ef.jobId);
        }
      }
    } catch { /* skip unreadable event logs */ }
  }

  let extracted = 0;
  let skipped = 0;
  let unmapped = 0;

  for (const proj of projects) {
    if (project && proj !== project) continue;
    const outputsDir = path.join(wikiDir, proj, "outputs");
    try {
      const files = await readdir(outputsDir);
      const verdictFiles = files.filter((f) => f.startsWith("verdict-") && f.endsWith(".md"));
      for (const vf of verdictFiles) {
        const artifactPath = path.join(outputsDir, vf);
        const artifactId = vf.replace(".md", "");
        const realJobId = verdictToJob.get(`${proj}/${artifactId}`);
        if (!realJobId) {
          unmapped++;
          continue;
        }
        try {
          const result = await extractExperienceFromVerdict(cpbRoot, proj, realJobId, artifactPath, { force });
          if (result) { extracted++; console.log(`  Extracted: ${proj}/${vf} (job ${realJobId})`); }
          else { skipped++; }
        } catch (err) {
          console.error(`  Error processing ${proj}/${vf}: ${err.message}`);
        }
      }
    } catch { /* no outputs dir */ }
  }

  const { rebuildExperienceIndex } = await import("../../server/services/experience-extractor.js");
  await rebuildExperienceIndex(cpbRoot);

  console.log(`\nBackfill complete: ${extracted} extracted, ${skipped} skipped, ${unmapped} unmapped (no event log).`);
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)/);
    if (kv) {
      let val = kv[2].trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        val = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      }
      meta[kv[1]] = val;
    }
  }
  return meta;
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "untitled";
}
