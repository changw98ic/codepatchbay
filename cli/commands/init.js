#!/usr/bin/env node
// init-project.mjs — Initialize project integration (Node.js, replaces init-project.sh)

import { mkdir, cp, writeFile, readFile, symlink, access, constants } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function isValidName(name) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(name);
}

function containsPath(candidate, roots) {
  const c = path.resolve(candidate);
  for (const r of roots) {
    if (!r) continue;
    const rr = path.resolve(r);
    if (c === rr || c.startsWith(rr + path.sep)) return true;
  }
  return false;
}

async function createMinimalProjectWiki(wikiDir, projectName) {
  await mkdir(wikiDir, { recursive: true });
  const files = {
    "context.md": `# ${projectName}\n\n## Context\n\n- Initialized without a project template.\n`,
    "tasks.md": `# Tasks: ${projectName}\n\n`,
    "decisions.md": `# Decisions: ${projectName}\n\n`,
    "log.md": `# Log: ${projectName}\n\n`,
  };
  await Promise.all(Object.entries(files).map(([file, content]) => {
    return writeFile(path.join(wikiDir, file), content, "utf8");
  }));
}

async function copyProjectTemplate(templateDir, wikiDir, projectName) {
  try {
    await cp(templateDir, wikiDir, { recursive: true, force: true });
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    await createMinimalProjectWiki(wikiDir, projectName);
  }
}

export async function initProject(args, { cpbRoot, executorRoot }) {
  const projectPathRaw = args[0];
  let projectName = args[1];
  if (!projectPathRaw || !projectName) {
    console.error("Usage: cpb init <path> <name>");
    process.exit(1);
  }

  const safeName = sanitizeName(projectName);
  if (safeName !== projectName) {
    console.log(`${YELLOW}Warning: Project name sanitized: '${projectName}' -> '${safeName}'${NC}`);
    projectName = safeName;
  }

  if (!isValidName(projectName)) {
    console.error(`${RED}Error: Invalid project name: '${projectName}'${NC}`);
    process.exit(1);
  }

  const resolvedPath = path.resolve(projectPathRaw);
  try {
    const s = await access(resolvedPath, constants.F_OK);
  } catch {
    console.error(`${RED}Error: '${projectPathRaw}' does not exist${NC}`);
    process.exit(1);
  }

  // Path scope validation
  const tempRoots = [process.env.TMPDIR || "/tmp", "/tmp", "/private/tmp", "/var/folders"];
  const isTemp = containsPath(resolvedPath, tempRoots);

  // Block system-critical directories
  const blocked = ["/etc", "/usr", "/bin", "/sbin", "/var", "/sys", "/proc", "/dev", "/boot", "/lib", "/lib64", "/snap"];
  for (const b of blocked) {
    if (resolvedPath === b || resolvedPath.startsWith(b + path.sep)) {
      if (!isTemp) {
        console.error(`${RED}Error: Cannot initialize project in a system directory${NC}`);
        process.exit(1);
      }
    }
  }

  // Block paths inside CPB_ROOT
  const root = path.resolve(cpbRoot);
  if (resolvedPath === root || resolvedPath.startsWith(root + path.sep)) {
    console.error(`${RED}Error: Cannot initialize project inside CPB installation directory${NC}`);
    process.exit(1);
  }

  // Verify containment within allowed project roots
  const allowedRoots = (process.env.CPB_PROJECT_ROOTS || `${process.env.HOME || ""}:${tempRoots.join(":")}`).split(":").filter(Boolean);
  if (allowedRoots.length === 0) {
    console.error(`${RED}Error: No project roots configured (set CPB_PROJECT_ROOTS env var)${NC}`);
    process.exit(1);
  }
  if (!containsPath(resolvedPath, allowedRoots)) {
    console.error(`${RED}Error: Project path outside allowed scope${NC}`);
    process.exit(1);
  }

  const wikiDir = path.join(cpbRoot, "wiki/projects", projectName);
  try {
    await access(wikiDir, constants.F_OK);
    console.error(`${RED}Error: '${projectName}' already exists${NC}`);
    process.exit(1);
  } catch {}

  // 1. Create from template
  const templateDir = path.join(executorRoot, "wiki/projects/_template");
  await copyProjectTemplate(templateDir, wikiDir, projectName);
  await mkdir(path.join(wikiDir, "inbox"), { recursive: true });
  await mkdir(path.join(wikiDir, "outputs"), { recursive: true });
  console.log(`Created: ${wikiDir}`);

  // 1.5 Store metadata
  const meta = {
    sourcePath: resolvedPath,
    name: projectName,
    initAt: new Date().toISOString(),
  };
  await writeFile(path.join(wikiDir, "project.json"), JSON.stringify(meta, null, 2));

  // 2. Replace placeholders
  for (const f of ["context.md", "tasks.md", "decisions.md", "log.md"]) {
    const fp = path.join(wikiDir, f);
    try {
      const content = await readFile(fp, "utf8");
      await writeFile(fp, content.replace(/{项目名}/g, projectName));
    } catch {}
  }

  // 3. Auto-detect tech stack
  const ctxPath = path.join(wikiDir, "context.md");
  let ctxLines = [];
  try {
    ctxLines = (await readFile(ctxPath, "utf8")).split("\n");
  } catch {}

  try {
    const pkgPath = path.join(resolvedPath, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    if (pkg.name) ctxLines.push(`- **Package**: ${pkg.name}`);
    if (pkg.description) ctxLines.push(`- **Description**: ${pkg.description}`);
  } catch {}

  const detectors = [
    ["tsconfig.json", "TypeScript"],
    ["vue.config.js", "Vue.js"],
    ["next.config.js", "Next.js"],
    ["vite.config.ts", "Vite"],
    ["nuxt.config.ts", "Nuxt"],
    ["Cargo.toml", "Rust"],
    ["go.mod", "Go"],
    ["pubspec.yaml", "Flutter"],
    ["uni.scss", "uni-app"],
  ];
  for (const [file, label] of detectors) {
    try {
      await access(path.join(resolvedPath, file), constants.F_OK);
      ctxLines.push(`- **Detected**: ${label}`);
    } catch {}
  }

  if (ctxLines.length > 0) {
    await writeFile(ctxPath, ctxLines.join("\n") + "\n");
  }

  // 4. Relative symlink
  const omcWiki = path.join(resolvedPath, ".omc/wiki");
  await mkdir(omcWiki, { recursive: true });
  const relPath = path.relative(omcWiki, wikiDir);
  const linkPath = path.join(omcWiki, "cpb");
  try {
    await access(linkPath, constants.F_OK);
  } catch {
    await symlink(relPath, linkPath);
    console.log(`Symlink: ${linkPath} -> ${relPath}`);
  }

  // 5. CPB.md
  const cpbMd = `# CodePatchbay Configuration
cpb:
  project: ${projectName}
  codex_agent: planner
  claude_agent: executor
  wiki_root: .omc/wiki/cpb/
  phases:
    plan: { agent: planner, model: auto }
    execute: { agent: executor, model: auto }
    verify: { agent: verifier, model: auto }
`;
  await writeFile(path.join(resolvedPath, "CPB.md"), cpbMd);
  console.log(`Created: ${path.join(resolvedPath, "CPB.md")}`);
  console.log("");
  console.log(`Project '${projectName}' ready.`);
  console.log(`Wiki: ${wikiDir}`);

  // 6. Auto-register with Hub (if hub root exists)
  try {
    const { registerProject, resolveHubRoot } = await import("../../server/services/hub-registry.js");
    const hubRoot = resolveHubRoot(cpbRoot);
    await registerProject(hubRoot, { name: projectName, sourcePath: resolvedPath });
    console.log(`Registered with Hub.`);
  } catch (err) {
    console.log(`Hub registration skipped (${err.message}). Run: cpb attach ${resolvedPath} ${projectName}`);
  }

  console.log("");
  console.log(`Next: cpb plan ${projectName} "<task>"`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const executorRoot = path.resolve(process.env.CPB_EXECUTOR_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const cpbRoot = path.resolve(process.env.CPB_ROOT || executorRoot);
  initProject(args, { cpbRoot, executorRoot });
}

export async function run(args, context) {
  await initProject(args, context);
  return 0;
}
