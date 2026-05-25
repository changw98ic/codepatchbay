#!/usr/bin/env node
// dual-research.mjs — Dual-agent parallel research (Node.js, replaces dual-research.sh)

import { mkdir, writeFile, readFile, access, constants, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { buildChildEnv } from "../../core/policy/child-env.js";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const CYAN = "\x1b[0;36m";
const NC = "\x1b[0m";

function isValidName(name) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(name);
}

async function nextId(dir, prefix) {
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, ".cpb-id.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(dir)).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".md"));
    let last = 0;
    for (const f of files) {
      const m = f.match(new RegExp(`^${prefix}-(\\d+)\\.md$`));
      if (m) last = Math.max(last, parseInt(m[1], 10));
    }
    const newId = String(last + 1).padStart(3, "0");
    await writeFile(path.join(dir, `${prefix}-${newId}.md`), "");
    return newId;
  } finally {
    try { await rm(lockDir, { recursive: true }); } catch {}
  }
}

async function logAppend(wikiDir, msg) {
  const logFile = path.join(wikiDir, "log.md");
  const lockDir = path.join(wikiDir, ".cpb-log.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const ts = new Date().toISOString();
  try {
    await writeFile(logFile, `- **${ts}** | ${msg}\n`, { flag: "a" });
  } finally {
    try { await rm(lockDir, { recursive: true }); } catch {}
  }
}

async function buildSkillsSection(executorRoot, role) {
  const skillsDir = path.join(executorRoot, "profiles", role, "skills");
  try {
    const { readdir, readFile } = await import("node:fs/promises");
    const files = (await readdir(skillsDir)).filter((f) => f.endsWith(".md")).sort();
    const lines = ["## Available Skills"];
    let count = 0;
    for (const f of files.slice(0, 10)) {
      const content = await readFile(path.join(skillsDir, f), "utf8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const name = fmMatch[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
        const desc = fmMatch[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
        if (name) {
          lines.push(`- /${name}: ${desc || ""} → ${path.join(skillsDir, f)}`);
          count++;
        }
      }
      if (count >= 10) {
        lines.push("- ... (truncated, max 10)");
        break;
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

async function buildResearchPrompt(executorRoot, project, task) {
  const skills = await buildSkillsSection(executorRoot, "planner");
  return `You are CodePatchbay Research Agent. Analyze this task for project "${project}".

Skills: Read skill files from role profiles under ${executorRoot}/profiles/ as needed.

${skills}

## Task
${task}

## Analysis Required
Provide a structured analysis covering:

### 1. Feasibility
- Technical complexity (low/medium/high)
- Estimated effort
- Required knowledge/domains

### 2. Risks & Dependencies
- Key risks that could block or delay
- External dependencies
- Potential blockers

### 3. Suggested Approach
- High-level implementation strategy
- Key design decisions
- Alternative approaches considered

### 4. Questions & Ambiguities
- What information is missing?
- What assumptions are being made?
- What needs clarification from the user?

Be concise and evidence-based. If the task is too vague to analyze, say so explicitly and list what's needed.
`;
}

function acpRun(agent, cwd, executorRoot, cpbRoot, input) {
  const acp = path.join(executorRoot, "bridges", "acp-client.mjs");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [acp, "--agent", agent, "--cwd", cwd], {
      env: buildChildEnv(process.env, { CPB_EXECUTOR_ROOT: executorRoot, CPB_ROOT: cpbRoot }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

export async function runResearch({ project, task, executorRoot, cpbRoot }) {
  if (!isValidName(project)) {
    console.error(`${RED}Error: Invalid project name: '${project}'${NC}`);
    process.exit(1);
  }
  const wikiDir = path.join(cpbRoot, "wiki/projects", project);
  try {
    await access(wikiDir, constants.F_OK);
  } catch {
    console.error(`${RED}Error: Project '${project}' not found${NC}`);
    process.exit(1);
  }

  // Resolve project source path
  let sourcePath = "";
  try {
    const meta = JSON.parse(await readFile(path.join(wikiDir, "project.json"), "utf8"));
    sourcePath = meta.sourcePath || "";
  } catch {}
  const cwd = sourcePath || process.cwd();

  const researchId = await nextId(path.join(wikiDir, "inbox"), "research");
  const researchFile = path.join(wikiDir, "inbox", `research-${researchId}.md`);
  const tmpDir = mkdtempSync(path.join(tmpdir(), "cpb-research-"));

  const prompt = await buildResearchPrompt(executorRoot, project, task);

  console.log(`Research [${project}]: ${task}`);
  console.log("Running dual-agent research (Codex + Claude in parallel)...");

  // Run both agents in parallel
  const [codexResult, claudeResult] = await Promise.all([
    acpRun("codex", cwd, executorRoot, cpbRoot, prompt),
    acpRun("claude", cwd, executorRoot, cpbRoot, prompt),
  ]);

  const codexOk = codexResult.code === 0;
  const claudeOk = claudeResult.code === 0;
  console.log(`  Codex: ${codexOk ? "done" : `failed (exit ${codexResult.code})`}`);
  console.log(`  Claude: ${claudeOk ? "done" : `failed (exit ${claudeResult.code})`}`);

  if (!codexOk && !claudeOk) {
    console.error(`${RED}Error: Both research agents failed.${NC}`);
    process.exit(1);
  }

  // Write temp outputs
  const codexOut = path.join(tmpDir, "codex.txt");
  const claudeOut = path.join(tmpDir, "claude.txt");
  await writeFile(codexOut, codexResult.stdout);
  await writeFile(claudeOut, claudeResult.stdout);

  // Merge results
  const mergeScript = path.join(executorRoot, "bridges", "merge-research.mjs");
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      mergeScript,
      "--codex", codexOut,
      "--codex-exit", String(codexResult.code),
      "--claude", claudeOut,
      "--claude-exit", String(claudeResult.code),
      "--task", task,
      "--output", researchFile,
    ], { stdio: "inherit" });
    child.on("close", resolve);
  });

  // Log
  const status = codexOk && claudeOk ? "FULL" : "PARTIAL";
  await logAppend(wikiDir, `research | dual | research-${researchId} for: ${task} | ${status}`);

  // Cleanup
  try { await rm(tmpDir, { recursive: true }); } catch {}

  console.log("");
  console.log(`Research: ${researchFile}`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const project = args[0];
  const task = args[1];
  if (!project || !task) {
    console.error("Usage: dual-research.mjs <project> '<task>'");
    process.exit(1);
  }
  const executorRoot = path.resolve(process.env.CPB_EXECUTOR_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const cpbRoot = path.resolve(process.env.CPB_ROOT || executorRoot);
  runResearch({ project, task, executorRoot, cpbRoot });
}
