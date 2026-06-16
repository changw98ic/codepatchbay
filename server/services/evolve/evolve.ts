// ── evolve-policy ──
import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { listJobs } from "../job/job-store.js";

const HIGH_RISK_PATTERNS = [
  { pattern: /\b(?:secret|api[_-]?key|password|token|credential)\b/i, reason: "involves secrets or credentials" },
  { pattern: /\b(?:auth(?:entication|orization)?)\b/i, reason: "modifies authentication or authorization" },
  { pattern: /\b(?:drop[_\s-]?table|delete\s+from|truncate\b|\bdestroy\b)/i, reason: "potentially destructive database operation" },
  { pattern: /\b(?:migration|schema\s+change)\b/i, reason: "database schema migration" },
  { pattern: /\b(?:public\s+api|breaking\s+change|deprecat)/i, reason: "affects public API surface" },
];

/**
 * Check whether an issue passes all guarded-run policy checks.
 */
export function checkPolicy(issue: Record<string, any>, opts: Record<string, any> = {}) {
  const reasons = [];
  const allowlist = opts.allowlist || [];
  const requireCleanWorktree = opts.requireCleanWorktree !== false;

  if (allowlist.length > 0 && !allowlist.includes(issue.project)) {
    reasons.push(`project '${issue.project}' not in allowlist`);
  }

  for (const { pattern, reason } of HIGH_RISK_PATTERNS) {
    if (pattern.test(issue.description || "")) {
      reasons.push(`high-risk description: ${reason}`);
    }
  }

  if (requireCleanWorktree && issue.sourcePath) {
    try {
      const output = execSync("git status --porcelain", {
        cwd: issue.sourcePath,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      const dirtyLines = output
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .filter((line) => {
          const filePath = line.slice(3).replace(/^"|"$/g, "");
          return !(filePath === "cpb-task" || filePath.startsWith("cpb-task/") || filePath === ".cpb" || filePath.startsWith(".cpb/"));
        });
      if (dirtyLines.length > 0) {
        reasons.push(`dirty worktree: ${dirtyLines.length} uncommitted change(s)`);
      }
    } catch {
      // Not a git repo or git unavailable - skip check
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

// ── evolve-multi-cli ──
import { spawn } from "node:child_process";
import { buildChildEnv } from "../../../core/policy/child-env.js";

export async function runEvolveMultiCli(args: string[], { cpbRoot, executorRoot, env = process.env }: { cpbRoot?: string; executorRoot?: string; env?: NodeJS.ProcessEnv } = {}) {
  const root = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const execRoot = path.resolve(executorRoot || env.CPB_EXECUTOR_ROOT || root);
  const child = spawn(process.execPath, [path.join(execRoot, "runtime", "evolve", "multi-evolve.js"), ...args], {
    stdio: "inherit",
    env: buildChildEnv(env, {
      CPB_ROOT: root,
      CPB_EXECUTOR_ROOT: execRoot,
      CPB_HUB_ROOT: env.CPB_HUB_ROOT || "",
    }),
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(Number.isInteger(code) ? code : 1));
  });
}

// ── task-brain ──
import { listCandidates, updateCandidate } from "../event/event-source.js";
import { getAgentPerformance } from "../observability/observability.js";

const SAFE_AUTO_CATEGORIES = [
  "documentation",
  "test-fix",
  "lint-fix",
  "typecheck-fix",
  "ci-diagnosis",
];

const RISKY_CATEGORIES = [
  "permission-change",
  "workflow-change",
  "file-deletion",
  "force-push",
  "release",
  "deploy",
  "large-refactor",
];

const DEFAULT_DAILY_LIMIT = 10;
const DEFAULT_CONSECUTIVE_FAILURE_LIMIT = 3;

function classifyCategory(payload: Record<string, any>) {
  const title = (payload.title || "").toLowerCase();
  const body = (payload.body || "").toLowerCase();
  const labels = (payload.labels || []).map((l: string) => l.toLowerCase());
  const combined = `${title} ${body} ${labels.join(" ")}`;

  if (/typo|docs?|readme|comment|changelog/i.test(combined)) return "documentation";
  if (/test.*fail|flaky.*test|fix.*test/i.test(combined)) return "test-fix";
  if (/lint|eslint|prettier|format/i.test(combined)) return "lint-fix";
  if (/typecheck|type.*error|ts\(/i.test(combined)) return "typecheck-fix";
  if (/ci|build.*fail|pipeline.*fail/i.test(combined)) return "ci-diagnosis";
  if (/delete|remove.*file|rm -rf/i.test(combined)) return "file-deletion";
  if (/force.push|force-push/i.test(combined)) return "force-push";
  if (/release|publish|deploy/i.test(combined)) return "release";
  if (/refactor|rewrite|restructure/i.test(combined)) return "large-refactor";

  return "general";
}

function isSafeAuto(category: string) {
  return SAFE_AUTO_CATEGORIES.includes(category);
}

function isRisky(category: string) {
  return RISKY_CATEGORIES.includes(category);
}

function recommendWorkflow(category: string) {
  if (category === "documentation") return "standard";
  if (category === "test-fix" || category === "ci-diagnosis") return "standard";
  return "standard";
}

function recommendAgent(category: string, _availableAgents: string[]) {
  return null;
}

/**
 * Evaluate a candidate event and produce a task recommendation.
 */
export async function evaluateCandidate(cpbRoot: string, candidate: Record<string, any>, { availableAgents = [] }: { availableAgents?: string[] } = {}) {
  if (!candidate || !candidate.payload) return null;

  const category = classifyCategory(candidate.payload);
  const safeAuto = isSafeAuto(category);
  const risky = isRisky(category);
  const riskLevel = risky ? "high" : safeAuto ? "low" : "medium";

  const recommendation = {
    candidateId: candidate.id,
    category,
    riskLevel,
    autoExecutable: safeAuto,
    needsHumanApproval: !safeAuto,
    recommendedWorkflow: recommendWorkflow(category),
    recommendedAgent: recommendAgent(category, availableAgents),
    taskTitle: candidate.payload.title || `Task from ${candidate.source}`,
    taskDescription: buildTaskDescription(candidate),
  };

  return { candidate, recommendation };
}

/**
 * Scan pending candidates and evaluate them for task generation.
 */
export async function scanCandidates(cpbRoot: string, { availableAgents = [], ...rootOptions }: Record<string, any> = {}) {
  const pending = await listCandidates(cpbRoot, { status: "pending", ...rootOptions });

  const results = [];
  for (const candidate of pending) {
    const evaluation = await evaluateCandidate(cpbRoot, candidate, { availableAgents });
    if (evaluation) {
      results.push(evaluation);
    }
  }

  return results;
}

/**
 * Check if proactive mode is enabled and within budget.
 */
export async function checkProactiveBudget(cpbRoot: string, options: Record<string, any> = {}) {
  const enabled = process.env.CPB_PROACTIVE === "1";
  if (!enabled) {
    return { allowed: false, reason: "proactive disabled (CPB_PROACTIVE not set to 1)" };
  }

  const dailyLimit = parseInt(process.env.CPB_PROACTIVE_DAILY_LIMIT, 10) || DEFAULT_DAILY_LIMIT;
  const failureLimit = parseInt(process.env.CPB_PROACTIVE_FAILURE_LIMIT, 10) || DEFAULT_CONSECUTIVE_FAILURE_LIMIT;

  const jobs = await listJobs(cpbRoot, { hubRoot: options.hubRoot });
  const windowMs = 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const windowProactive = jobs.filter((j: Record<string, any>) => {
    if (j.trigger !== "proactive" && j.sourceContext?.type !== "proactive") return false;
    const ts = j.createdAt ? new Date(j.createdAt).getTime() : 0;
    return ts > cutoff;
  });

  if (windowProactive.length >= dailyLimit) {
    return { allowed: false, reason: `daily limit reached (${dailyLimit})` };
  }

  const recent = [...windowProactive]
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, failureLimit);

  const consecutiveFailures = recent.every((j) => j.status === "failed");
  if (consecutiveFailures && recent.length >= failureLimit) {
    return { allowed: false, reason: `consecutive failure limit reached (${failureLimit})` };
  }

  return { allowed: true, remaining: dailyLimit - windowProactive.length };
}

function buildTaskDescription(candidate: Record<string, any>) {
  const parts = [`Source: ${candidate.source}`];
  if (candidate.payload.title) parts.push(`Title: ${candidate.payload.title}`);
  if (candidate.payload.body) parts.push(candidate.payload.body.slice(0, 500));
  if (candidate.payload.labels?.length) parts.push(`Labels: ${candidate.payload.labels.join(", ")}`);
  return parts.join("\n\n");
}

export { classifyCategory, isSafeAuto, isRisky, SAFE_AUTO_CATEGORIES, RISKY_CATEGORIES };

// ── merge-steward ──
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MERGE_CLASSIFICATION = Object.freeze({
  SHARED_STATE: "SHARED_STATE",
  NEEDS_HUMAN: "NEEDS_HUMAN",
  RESOLVABLE_CODE: "RESOLVABLE_CODE",
});

const SHARED_STATE_PREFIXES = [
  ".omx/",
  ".cpb/",
  "cpb-task/",
  "wiki/",
];

const NEEDS_HUMAN_BASENAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
]);

function splitLines(value: any) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitError(args: any, err: any) {
  const details = String(err?.stderr || err?.stdout || err?.message || "").trim();
  return new Error(`git ${args.join(" ")} failed${details ? `: ${details}` : ""}`);
}

async function runGit(cwd: any, args: any, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: 0,
    };
  } catch (err) {
    if (!allowFailure) throw gitError(args, err);
    return {
      stdout: err?.stdout || "",
      stderr: err?.stderr || err?.message || "",
      exitCode: Number.isInteger(err?.code) ? err.code : 1,
    };
  }
}

async function pathExists(targetPath: any) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function normalizeMergePath(filePath: any) {
  return String(filePath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

export function classifyMergePath(filePath: any) {
  const normalized = normalizeMergePath(filePath);
  const basename = path.posix.basename(normalized);

  if (!normalized) return MERGE_CLASSIFICATION.RESOLVABLE_CODE;
  if (normalized.endsWith(".jsonl")) return MERGE_CLASSIFICATION.SHARED_STATE;
  if (normalized.includes("/leases/") || normalized.startsWith("leases/")) {
    return MERGE_CLASSIFICATION.SHARED_STATE;
  }
  if (SHARED_STATE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return MERGE_CLASSIFICATION.SHARED_STATE;
  }

  if (NEEDS_HUMAN_BASENAMES.has(basename)) return MERGE_CLASSIFICATION.NEEDS_HUMAN;
  if (normalized.includes("guidance-schema")) return MERGE_CLASSIFICATION.NEEDS_HUMAN;
  if (normalized.includes("/schema/") || normalized.includes("/schemas/")) {
    return MERGE_CLASSIFICATION.NEEDS_HUMAN;
  }
  if (/schema\.(json|ya?ml)$/i.test(normalized)) return MERGE_CLASSIFICATION.NEEDS_HUMAN;

  return MERGE_CLASSIFICATION.RESOLVABLE_CODE;
}

export function summarizeMergeFiles(files: any = []) {
  const entries = [...new Set(files.map(normalizeMergePath).filter(Boolean))]
    .sort((a: any, b: any) => a.localeCompare(b))
    .map((file) => ({
      file,
      classification: classifyMergePath(file),
    }));

  const counts = Object.fromEntries(
    Object.values(MERGE_CLASSIFICATION).map((classification) => [classification, 0]),
  );
  for (const entry of entries) counts[entry.classification] += 1;

  return { entries, counts };
}

async function resolveCandidateCommit(repoRoot: any, candidate: any) {
  const refResult = await runGit(repoRoot, ["rev-parse", "--verify", `${candidate}^{commit}`], {
    allowFailure: true,
  });
  if (refResult.exitCode === 0) {
    return {
      commit: refResult.stdout.trim(),
      source: "ref",
      label: candidate,
    };
  }

  const candidatePath = path.resolve(repoRoot, candidate);
  if (await pathExists(candidatePath)) {
    const canonicalPath = await realpath(candidatePath);
    const pathResult = await runGit(canonicalPath, ["rev-parse", "--verify", "HEAD"], {
      allowFailure: true,
    });
    if (pathResult.exitCode === 0) {
      return {
        commit: pathResult.stdout.trim(),
        source: "worktree",
        label: canonicalPath,
      };
    }
  }

  throw new Error(`candidate is not a git ref or worktree: ${candidate}`);
}

function abortReasonsForSummary(changedSummary: any, conflictSummary: any, mergeStatus: any) {
  const reasons = [];

  if (changedSummary.counts[MERGE_CLASSIFICATION.SHARED_STATE] > 0) {
    reasons.push({
      code: "shared_state_changed",
      message: "candidate changes CPB/shared-state files; merge steward must not touch them",
      files: changedSummary.entries
        .filter((entry: any) => entry.classification === MERGE_CLASSIFICATION.SHARED_STATE)
        .map((entry: any) => entry.file),
    });
  }

  if (changedSummary.counts[MERGE_CLASSIFICATION.NEEDS_HUMAN] > 0) {
    reasons.push({
      code: "needs_human_changed",
      message: "candidate changes governance/config/schema files that need human review",
      files: changedSummary.entries
        .filter((entry: any) => entry.classification === MERGE_CLASSIFICATION.NEEDS_HUMAN)
        .map((entry: any) => entry.file),
    });
  }

  if (mergeStatus === "failed" && conflictSummary.entries.length === 0) {
    reasons.push({
      code: "merge_preview_failed",
      message: "git merge preview failed without reporting resolvable conflict files",
      files: [],
    });
  }

  return reasons;
}

export async function previewMerge({ repoRoot = process.cwd(), baseRef = "HEAD", candidate }: Record<string, any> = {}) {
  if (!candidate) throw new Error("candidate is required");

  const canonicalRepoRoot = await realpath(path.resolve(repoRoot));
  const baseHead = (await runGit(canonicalRepoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
  const candidateInfo = await resolveCandidateCommit(canonicalRepoRoot, candidate);
  const mergeBase = (await runGit(canonicalRepoRoot, ["merge-base", baseHead, candidateInfo.commit])).stdout.trim();
  const changedFiles = splitLines(
    (await runGit(canonicalRepoRoot, ["diff", "--name-only", baseHead, candidateInfo.commit])).stdout,
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-merge-preview-"));
  const worktreePath = path.join(tempRoot, "worktree");
  let mergeResult = { exitCode: 1, stdout: "", stderr: "" };
  let conflictFiles = [];

  try {
    await runGit(canonicalRepoRoot, ["worktree", "add", "--detach", worktreePath, baseHead]);
    mergeResult = await runGit(worktreePath, ["merge", "--no-commit", "--no-ff", candidateInfo.commit], {
      allowFailure: true,
    });
    conflictFiles = splitLines(
      (await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"], {
        allowFailure: true,
      })).stdout,
    );
    await runGit(worktreePath, ["merge", "--abort"], { allowFailure: true });
  } finally {
    await runGit(canonicalRepoRoot, ["worktree", "remove", "--force", worktreePath], {
      allowFailure: true,
    });
    await rm(tempRoot, { recursive: true, force: true });
  }

  const changedSummary = summarizeMergeFiles(changedFiles);
  const conflictSummary = summarizeMergeFiles(conflictFiles);
  const mergeStatus = mergeResult.exitCode === 0
    ? "clean"
    : conflictFiles.length > 0
      ? "conflicts"
      : "failed";
  const abortReasons = abortReasonsForSummary(changedSummary, conflictSummary, mergeStatus);

  return {
    repoRoot: canonicalRepoRoot,
    baseRef,
    baseHead,
    candidate: {
      input: candidate,
      ...candidateInfo,
    },
    mergeBase,
    mergeStatus,
    mergeExitCode: mergeResult.exitCode,
    changedFiles: changedSummary.entries,
    changedCounts: changedSummary.counts,
    conflictFiles: conflictSummary.entries,
    conflictCounts: conflictSummary.counts,
    abortReasons,
    safeForSteward: abortReasons.length === 0,
  };
}

// ── merge-research ──
// CLI tool: merge-research.js --codex <file> --codex-exit <n> --claude <file> --claude-exit <n> --task <str> --output <file>
// This is a standalone CLI script. When used as a module, the main logic is in the
// runResearch function in dual-research.ts which calls this via child_process.

// ── dual-research ──
import { mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const CYAN = "\x1b[0;36m";
const NC = "\x1b[0m";

function isValidName(name: any) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(name);
}

async function nextId(dir: any, prefix: any) {
  await mkdir(dir, { recursive: true });
  const lockDir = path.join(dir, ".cpb-id.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if ((err as any).code !== "EEXIST") throw err;
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

async function logAppend(wikiDir: any, msg: any) {
  const logFile = path.join(wikiDir, "log.md");
  const lockDir = path.join(wikiDir, ".cpb-log.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if ((err as any).code !== "EEXIST") throw err;
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

async function buildSkillsSection(executorRoot: any, role: any) {
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
          lines.push(`- /${name}: ${desc || ""} -> ${path.join(skillsDir, f)}`);
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

async function buildResearchPrompt(executorRoot: any, project: any, task: any) {
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

function acpRun(agent: string, cwd: string, executorRoot: string, cpbRoot: string, input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const acp = path.join(executorRoot, "server", "services", "acp", "acp-client.js");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [acp, "--agent", agent, "--cwd", cwd], {
      env: buildChildEnv(process.env, { CPB_EXECUTOR_ROOT: executorRoot, CPB_ROOT: cpbRoot }, { agent }),
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
    await access(wikiDir, fsConstants.F_OK);
  } catch {
    console.error(`${RED}Error: Project '${project}' not found${NC}`);
    process.exit(1);
  }

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

  const codexOut = path.join(tmpDir, "codex.txt");
  const claudeOut = path.join(tmpDir, "claude.txt");
  await writeFile(codexOut, codexResult.stdout);
  await writeFile(claudeOut, claudeResult.stdout);

  const mergeScript = path.join(executorRoot, "server", "services", "merge-research.js");
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

  const status = codexOk && claudeOk ? "FULL" : "PARTIAL";
  await logAppend(wikiDir, `research | dual | research-${researchId} for: ${task} | ${status}`);

  try { await rm(tmpDir, { recursive: true }); } catch {}

  console.log("");
  console.log(`Research: ${researchFile}`);
}

// ── multi-evolve-state ──
const EVOLVE_LOCK_TTL_MS = 30_000;
const SAFE_PROJECT = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function assertProject(project: any) {
  if (!SAFE_PROJECT.test(project || "")) {
    throw new Error(`invalid project name: ${project}`);
  }
}

export function evolveDir(projectRoot: any, project: any, options: Record<string, any> = {}) {
  assertProject(project);
  const dataRoot = options.dataRoot || options.projectRuntimeRoot;
  return path.join(path.resolve(dataRoot || path.join(projectRoot, "cpb-task")), "evolve", project);
}

function statePath(projectRoot: any, project: any, file: any, options: Record<string, any> = {}) {
  return path.join(evolveDir(projectRoot, project, options), file);
}

async function readJSON(filePath: any, fallback: any) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") return fallback;
    return fallback;
  }
}

async function writeAtomic(filePath: any, content: any) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

export async function loadProjectState(projectRoot: any, project: any, options: Record<string, any> = {}) {
  return readJSON(statePath(projectRoot, project, "state.json", options), {
    knownGoodCommit: null,
    round: 0,
    status: "idle",
    enabled: true,
    updatedAt: null,
  });
}

export async function saveProjectState(projectRoot: any, project: any, state: any, options: Record<string, any> = {}) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  await writeAtomic(statePath(projectRoot, project, "state.json", options), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function loadBacklog(projectRoot: any, project: any, options: Record<string, any> = {}) {
  return readJSON(statePath(projectRoot, project, "backlog.json", options), []);
}

export async function saveBacklog(projectRoot: any, project: any, backlog: any, options: Record<string, any> = {}) {
  await writeAtomic(statePath(projectRoot, project, "backlog.json", options), `${JSON.stringify(backlog, null, 2)}\n`);
  return backlog;
}

async function withBacklogLock(projectRoot: any, project: any, callback: any, options: Record<string, any> = {}) {
  const lockDir = statePath(projectRoot, project, "backlog.json.lock", options);
  await mkdir(path.dirname(lockDir), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await mkdir(lockDir, { recursive: false });
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs >= EVOLVE_LOCK_TTL_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!acquired) throw new Error(`backlog lock busy: ${project}`);
  try {
    return await callback();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function issueKeyFn2(issue: any) {
  return issue.id || issue.description;
}

export async function pushIssues(projectRoot: any, project: any, issues: any, options: Record<string, any> = {}) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project, options);
    const existing = new Set(backlog.map(issueKeyFn2));
    let added = 0;
    for (const issue of issues) {
      const key = issueKeyFn2(issue);
      if (!key || existing.has(key)) continue;
      backlog.push({
        ...issue,
        id: issue.id || `issue-${Date.now()}-${added}`,
        project,
        status: issue.status || "pending",
        createdAt: issue.createdAt || new Date().toISOString(),
      });
      existing.add(key);
      added += 1;
    }
    await saveBacklog(projectRoot, project, backlog, options);
    return { added, total: backlog.length, backlog };
  }, options);
}

function priorityScore(priority: any) {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  return 3;
}

export async function popIssue(projectRoot: any, project: any, options: Record<string, any> = {}) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project, options);
    const pending = backlog.filter((issue: any) => issue.status === "pending");
    pending.sort((a: any, b: any) => priorityScore(a.priority) - priorityScore(b.priority));
    const issue = pending[0] || null;
    if (!issue) return null;
    issue.status = "in_progress";
    issue.updatedAt = new Date().toISOString();
    await saveBacklog(projectRoot, project, backlog, options);
    return { issue, backlog };
  }, options);
}

function matchesIssue(issue: any, identity: any) {
  return Boolean(identity)
    && (issue.id === identity || issue.description === identity || issueKeyFn2(issue) === identity);
}

export async function updateIssueStatus(projectRoot: any, project: any, identity: any, status: any, detail = {}, options: Record<string, any> = {}) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project, options);
    const issue = backlog.find((item: any) => matchesIssue(item, identity));
    if (!issue) return null;
    issue.status = status;
    issue.updatedAt = new Date().toISOString();
    if (detail && Object.keys(detail).length > 0) {
      issue.detail = { ...(issue.detail || {}), ...detail };
    }
    await saveBacklog(projectRoot, project, backlog, options);
    return { issue, backlog };
  }, options);
}

export async function claimIssue(projectRoot: any, project: any, identity: any, options: Record<string, any> = {}) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project, options);
    const issue = backlog.find((item: any) => matchesIssue(item, identity) && item.status === "pending");
    if (!issue) return null;
    issue.status = "in_progress";
    issue.claimedAt = new Date().toISOString();
    issue.updatedAt = issue.claimedAt;
    await saveBacklog(projectRoot, project, backlog, options);
    return { issue, backlog };
  }, options);
}

export async function completeIssue(projectRoot: any, project: any, identity: any, result: Record<string, any> = {}, options: Record<string, any> = {}) {
  const status = result.ok ? "completed" : "failed";
  return updateIssueStatus(projectRoot, project, identity, status, {
    exitCode: result.code ?? null,
    error: result.error || null,
    completedAt: new Date().toISOString(),
  }, options);
}

export async function appendHistory(projectRoot: any, project: any, entry: any, options: Record<string, any> = {}) {
  await mkdir(evolveDir(projectRoot, project, options), { recursive: true });
  const filePath = statePath(projectRoot, project, "history.jsonl", options);
  const line = JSON.stringify({ ...entry, project, timestamp: new Date().toISOString() }) + "\n";
  await writeFile(filePath, line, { flag: "a", encoding: "utf8" });
}

export async function loadGlobalConfig(hubRoot: any) {
  return readJSON(path.join(path.resolve(hubRoot), "evolve", "global", "config.json"), { projects: {} });
}

export async function saveGlobalConfig(hubRoot: any, config: any) {
  const filePath = path.join(path.resolve(hubRoot), "evolve", "global", "config.json");
  await writeAtomic(filePath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
