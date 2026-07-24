// ── evolve-policy ──
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { LooseRecord } from "../../../core/contracts/types.js";
import {
  readBoundedRegularFileNoFollow,
  withDurableDirectoryLock,
} from "../../../core/runtime/durable-directory-lock.js";
import {
  createTemporaryGitWorktree,
  createTemporaryWorkspace,
} from "../../../core/runtime/temporary-workspace.js";
import { fsyncDirectory } from "../../../shared/hub-maintenance.js";
import { allocateArtifactId } from "../artifact-locator.js";
import { listJobs } from "../job/job-store.js";

type EvolveIssue = LooseRecord & {
  id?: string;
  project?: string;
  description?: string;
  sourcePath?: string;
  priority?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  claimedAt?: string;
  detail?: LooseRecord;
};

type EvolveOptions = LooseRecord & {
  allowlist?: string[];
  requireCleanWorktree?: boolean;
  availableAgents?: string[];
  dataRoot?: string;
  projectRuntimeRoot?: string;
  hubRoot?: string;
  repoRoot?: string;
  baseRef?: string;
  candidate?: string;
};

type CandidatePayload = LooseRecord & {
  title?: string;
  body?: string;
  labels?: string[];
};

type CandidateRecord = LooseRecord & {
  id?: string;
  source?: string;
  payload?: CandidatePayload;
};

type EvolveJob = LooseRecord & {
  trigger?: string;
  sourceContext?: { type?: string };
  createdAt?: string;
  status?: string;
};

type MergeFileEntry = {
  file: string;
  classification: string;
};

type MergeSummary = {
  entries: MergeFileEntry[];
  counts: Record<string, number>;
};

type CommandError = {
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
  code?: unknown;
};

type EvolveState = LooseRecord & {
  knownGoodCommit?: string | null;
  round?: number;
  status?: string;
  enabled?: boolean;
  updatedAt?: string | number | null;
};

type CompletionResult = LooseRecord & {
  ok?: boolean;
  code?: number | null;
  error?: unknown;
};

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvolveIssue(value: unknown): value is EvolveIssue {
  return isRecord(value);
}

function toIssueList(value: unknown): EvolveIssue[] {
  return Array.isArray(value) ? value.filter(isEvolveIssue) : [];
}

function commandError(value: unknown): CommandError {
  return isRecord(value) ? value : {};
}

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
export function checkPolicy(issue: EvolveIssue, opts: EvolveOptions = {}) {
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
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reasons.push(`worktree cleanliness check failed: ${detail}`);
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

// ── evolve-multi-cli ──
import { buildChildEnv } from "../../../core/policy/child-env.js";
import { runCommandTree } from "../../../core/runtime/process-tree.js";

export async function runEvolveMultiCli(args: string[], { cpbRoot, executorRoot, env = process.env, signal, timeoutMs }: { cpbRoot?: string; executorRoot?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number } = {}) {
  const root = path.resolve(cpbRoot || env.CPB_ROOT || process.cwd());
  const execRoot = path.resolve(executorRoot || env.CPB_EXECUTOR_ROOT || root);
  const result = await runCommandTree(process.execPath, [path.join(execRoot, "runtime", "evolve", "multi-evolve.js"), ...args], {
    cwd: root,
    env: buildChildEnv(env, {
      CPB_ROOT: root,
      CPB_EXECUTOR_ROOT: execRoot,
      CPB_HUB_ROOT: env.CPB_HUB_ROOT || "",
    }),
    signal,
    timeoutMs,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  return result.exitCode;
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

function classifyCategory(payload: CandidatePayload) {
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
export async function evaluateCandidate(cpbRoot: string, candidate: CandidateRecord | null | undefined, { availableAgents = [] }: { availableAgents?: string[] } = {}) {
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
export async function scanCandidates(cpbRoot: string, { availableAgents = [], ...rootOptions }: EvolveOptions = {}) {
  const pending = await listCandidates(cpbRoot, {
    status: "pending",
    source: typeof rootOptions.source === "string" ? rootOptions.source : undefined,
  });

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
export async function checkProactiveBudget(cpbRoot: string, options: EvolveOptions = {}) {
  const enabled = process.env.CPB_PROACTIVE === "1";
  if (!enabled) {
    return { allowed: false, reason: "proactive disabled (CPB_PROACTIVE not set to 1)" };
  }

  const dailyLimit = parseInt(process.env.CPB_PROACTIVE_DAILY_LIMIT, 10) || DEFAULT_DAILY_LIMIT;
  const failureLimit = parseInt(process.env.CPB_PROACTIVE_FAILURE_LIMIT, 10) || DEFAULT_CONSECUTIVE_FAILURE_LIMIT;

  const jobs = await listJobs(cpbRoot, { hubRoot: options.hubRoot });
  const windowMs = 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const windowProactive = jobs.filter((j: EvolveJob) => {
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

function buildTaskDescription(candidate: CandidateRecord) {
  const parts = [`Source: ${candidate.source}`];
  if (candidate.payload.title) parts.push(`Title: ${candidate.payload.title}`);
  if (candidate.payload.body) parts.push(candidate.payload.body.slice(0, 500));
  if (candidate.payload.labels?.length) parts.push(`Labels: ${candidate.payload.labels.join(", ")}`);
  return parts.join("\n\n");
}

export { classifyCategory, isSafeAuto, isRisky, SAFE_AUTO_CATEGORIES, RISKY_CATEGORIES };

// ── merge-steward ──
import { execFile } from "node:child_process";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { access, realpath } from "node:fs/promises";
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

function splitLines(value: string | null | undefined) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitError(args: string[], err: unknown) {
  const commandErr = commandError(err);
  const details = String(commandErr.stderr || commandErr.stdout || commandErr.message || "").trim();
  return new Error(`git ${args.join(" ")} failed${details ? `: ${details}` : ""}`);
}

async function runGit(cwd: string, args: string[], { allowFailure = false } = {}) {
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
    const commandErr = commandError(err);
    return {
      stdout: String(commandErr.stdout || ""),
      stderr: String(commandErr.stderr || commandErr.message || ""),
      exitCode: typeof commandErr.code === "number" && Number.isInteger(commandErr.code) ? commandErr.code : 1,
    };
  }
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException).code || ""))) return false;
    throw error;
  }
}

export function normalizeMergePath(filePath: string | null | undefined) {
  return String(filePath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

export function classifyMergePath(filePath: string | null | undefined) {
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

export function summarizeMergeFiles(files: string[] = []) {
  const entries = [...new Set(files.map(normalizeMergePath).filter(Boolean))]
    .sort((a: string, b: string) => a.localeCompare(b))
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

async function resolveCandidateCommit(repoRoot: string, candidate: string) {
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

function abortReasonsForSummary(changedSummary: MergeSummary, conflictSummary: MergeSummary, mergeStatus: string) {
  const reasons = [];

  if (changedSummary.counts[MERGE_CLASSIFICATION.SHARED_STATE] > 0) {
    reasons.push({
      code: "shared_state_changed",
      message: "candidate changes CPB/shared-state files; merge steward must not touch them",
      files: changedSummary.entries
        .filter((entry) => entry.classification === MERGE_CLASSIFICATION.SHARED_STATE)
        .map((entry) => entry.file),
    });
  }

  if (changedSummary.counts[MERGE_CLASSIFICATION.NEEDS_HUMAN] > 0) {
    reasons.push({
      code: "needs_human_changed",
      message: "candidate changes governance/config/schema files that need human review",
      files: changedSummary.entries
        .filter((entry) => entry.classification === MERGE_CLASSIFICATION.NEEDS_HUMAN)
        .map((entry) => entry.file),
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

export async function previewMerge({ repoRoot = process.cwd(), baseRef = "HEAD", candidate }: EvolveOptions = {}) {
  if (!candidate) throw new Error("candidate is required");

  const canonicalRepoRoot = await realpath(path.resolve(repoRoot));
  const baseHead = (await runGit(canonicalRepoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
  const candidateInfo = await resolveCandidateCommit(canonicalRepoRoot, candidate);
  const mergeBase = (await runGit(canonicalRepoRoot, ["merge-base", baseHead, candidateInfo.commit])).stdout.trim();
  const changedFiles = splitLines(
    (await runGit(canonicalRepoRoot, ["diff", "--name-only", baseHead, candidateInfo.commit])).stdout,
  );

  const temporaryWorktree = await createTemporaryGitWorktree({
    sourcePath: canonicalRepoRoot,
    revision: baseHead,
    prefix: "cpb-merge-preview-",
  });
  const worktreePath = temporaryWorktree.worktreePath;
  let mergeResult = { exitCode: 1, stdout: "", stderr: "" };
  let conflictFiles = [];
  let primaryError: unknown = null;

  try {
    mergeResult = await runGit(worktreePath, ["merge", "--no-commit", "--no-ff", candidateInfo.commit], {
      allowFailure: true,
    });
    conflictFiles = splitLines(
      (await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"], {
        allowFailure: true,
      })).stdout,
    );
    await runGit(worktreePath, ["merge", "--abort"], { allowFailure: true });
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown = null;
  try {
    await temporaryWorktree.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw Object.assign(new AggregateError(
      [primaryError, cleanupError],
      "merge preview and temporary worktree cleanup both failed",
      { cause: primaryError },
    ), {
      code: "EVOLVE_MERGE_PREVIEW_CLEANUP_FAILED",
      primaryError,
      cleanupError,
    });
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;

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
import { fileURLToPath } from "node:url";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const CYAN = "\x1b[0;36m";
const NC = "\x1b[0m";

function isValidName(name: string) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(name);
}

async function nextId(dir: string, prefix: string) {
  return allocateArtifactId(dir, prefix);
}

async function logAppend(wikiDir: string, msg: string, { signal }: { signal?: AbortSignal } = {}) {
  const logFile = path.join(wikiDir, "log.md");
  const lockDir = path.join(wikiDir, ".cpb-log.lock");
  const ts = new Date().toISOString();
  const entry = `- **${ts}** | ${msg}\n`;
  return withDurableDirectoryLock(lockDir, async () => {
    throwIfAborted(signal);
    const previous = await readTextIfExists(logFile, "", 64 * 1024 * 1024);
    await writeAtomic(logFile, `${previous}${entry}`);
    if (!signal?.aborted) return entry;
    const cancellation = abortError();
    try {
      await writeAtomic(logFile, previous);
    } catch (rollbackError) {
      throw new AggregateError(
        [cancellation, rollbackError],
        `research log cancellation and rollback both failed: ${logFile}`,
        { cause: cancellation },
      );
    }
    throw cancellation;
  }, { signal, ttlMs: 30_000, waitMs: 3_000, retryMs: 50 });
}

async function buildSkillsSection(executorRoot: string, role: string) {
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
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function buildResearchPrompt(executorRoot: string, project: string, task: string) {
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

function abortError() {
  const err = new Error("operation aborted");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

type ResearchOptions = {
  project: string;
  task: string;
  executorRoot: string;
  cpbRoot: string;
  signal?: AbortSignal;
  acpTimeoutMs?: number;
  mergeTimeoutMs?: number;
};

async function acpRun(agent: string, cwd: string, executorRoot: string, cpbRoot: string, input: string, { signal, timeoutMs }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string; aborted: boolean; timedOut: boolean }> {
  const acp = path.join(executorRoot, "server", "services", "acp", "acp-client.js");
  const result = await runCommandTree(process.execPath, [acp, "--agent", agent, "--cwd", cwd], {
    cwd,
    env: buildChildEnv(process.env, { CPB_EXECUTOR_ROOT: executorRoot, CPB_ROOT: cpbRoot }, { agent }),
    input,
    signal,
    timeoutMs,
  });
  return {
    code: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    aborted: result.aborted,
    timedOut: result.timedOut,
  };
}

export async function runResearch({ project, task, executorRoot, cpbRoot, signal, acpTimeoutMs, mergeTimeoutMs }: ResearchOptions) {
  throwIfAborted(signal);
  if (!isValidName(project)) {
    throw Object.assign(new Error(`Invalid project name: '${project}'`), {
      code: "EVOLVE_PROJECT_INVALID",
      project,
    });
  }
  const wikiDir = path.join(cpbRoot, "wiki/projects", project);
  try {
    const info = await lstat(wikiDir);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw Object.assign(new Error(`Unsafe project wiki directory: '${wikiDir}'`), {
        code: "EVOLVE_PROJECT_UNSAFE",
        project,
      });
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
    throw Object.assign(new Error(`Project '${project}' not found`, { cause: error }), {
      code: "EVOLVE_PROJECT_NOT_FOUND",
      project,
    });
  }

  const meta = await readJSON(path.join(wikiDir, "project.json"), {});
  if (!isRecord(meta) || (meta.sourcePath !== undefined && typeof meta.sourcePath !== "string")) {
    throw Object.assign(new Error(`Invalid project metadata for '${project}'`), {
      code: "EVOLVE_STATE_INVALID",
      project,
    });
  }
  const sourcePath = typeof meta.sourcePath === "string" ? meta.sourcePath : "";
  const cwd = sourcePath || process.cwd();

  const temporaryWorkspace = await createTemporaryWorkspace({ prefix: "cpb-research-" });
  const tmpDir = temporaryWorkspace.rootPath;
  let researchFile: string | null = null;
  let researchPublished = false;
  let completed = false;
  let primaryError: unknown = null;

  try {
    const prompt = await buildResearchPrompt(executorRoot, project, task);
    throwIfAborted(signal);

    console.log(`Research [${project}]: ${task}`);
    console.log("Running dual-agent research (Codex + Claude in parallel)...");

    const [codexResult, claudeResult] = await Promise.all([
      acpRun("codex", cwd, executorRoot, cpbRoot, prompt, { signal, timeoutMs: acpTimeoutMs }),
      acpRun("claude", cwd, executorRoot, cpbRoot, prompt, { signal, timeoutMs: acpTimeoutMs }),
    ]);

    if (codexResult.aborted || claudeResult.aborted || signal?.aborted) {
      throw abortError();
    }

    const codexOk = codexResult.code === 0;
    const claudeOk = claudeResult.code === 0;
    console.log(`  Codex: ${codexOk ? "done" : `failed (exit ${codexResult.code})`}`);
    console.log(`  Claude: ${claudeOk ? "done" : `failed (exit ${claudeResult.code})`}`);

    if (!codexOk && !claudeOk) {
      throw Object.assign(new Error("Both research agents failed"), {
        code: "EVOLVE_RESEARCH_PROVIDERS_FAILED",
        codexExitCode: codexResult.code,
        claudeExitCode: claudeResult.code,
      });
    }

    const researchId = await nextId(path.join(wikiDir, "inbox"), "research");
    researchFile = path.join(wikiDir, "inbox", `research-${researchId}.md`);
    const codexOut = path.join(tmpDir, "codex.txt");
    const claudeOut = path.join(tmpDir, "claude.txt");
    const mergeOut = path.join(tmpDir, "merged.md");
    await writeFile(codexOut, codexResult.stdout);
    await writeFile(claudeOut, claudeResult.stdout);
    throwIfAborted(signal);

    const mergeScript = path.join(executorRoot, "server", "services", "merge-research.js");
    const mergeResult = await runCommandTree(process.execPath, [
      mergeScript,
      "--codex", codexOut,
      "--codex-exit", String(codexResult.code),
      "--claude", claudeOut,
      "--claude-exit", String(claudeResult.code),
      "--task", task,
      "--output", mergeOut,
    ], {
      cwd,
      signal,
      timeoutMs: mergeTimeoutMs,
      onStdout: (chunk) => process.stdout.write(chunk),
      onStderr: (chunk) => process.stderr.write(chunk),
    });
    if (mergeResult.aborted || signal?.aborted) {
      throw abortError();
    }
    if (mergeResult.exitCode !== 0) {
      throw Object.assign(new Error(`Research merge failed with exit ${mergeResult.exitCode}`), {
        code: "EVOLVE_RESEARCH_MERGE_FAILED",
        exitCode: mergeResult.exitCode,
        stderr: mergeResult.stderr,
      });
    }
    const merged = await readTextFile(mergeOut, 64 * 1024 * 1024);
    throwIfAborted(signal);
    await writeAtomic(researchFile, merged);
    researchPublished = true;

    const status = codexOk && claudeOk ? "FULL" : "PARTIAL";
    await logAppend(wikiDir, `research | dual | research-${researchId} for: ${task} | ${status}`, { signal });
    completed = true;

    console.log("");
    console.log(`Research: ${researchFile}`);
  } catch (error) {
    primaryError = error;
    if (error && typeof error === "object" && (error as { committed?: unknown }).committed === true) {
      researchPublished = true;
    }
  }

  const cleanupErrors: unknown[] = [];
  try {
    await temporaryWorkspace.cleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (primaryError) {
    if (researchPublished && researchFile) {
      const evidence = {
        committed: true,
        researchFile,
        recoveryPaths: { publishedResearch: researchFile },
      };
      if (primaryError && typeof primaryError === "object") Object.assign(primaryError, evidence);
      if (cleanupErrors.length === 0) throw primaryError;
      const aggregate = Object.assign(new AggregateError(
        [primaryError, ...cleanupErrors],
        "research artifact was published and temporary cleanup also failed",
        { cause: primaryError },
      ), {
        ...evidence,
        code: String((primaryError as NodeJS.ErrnoException | undefined)?.code || "EVOLVE_RESEARCH_PUBLISHED_FOLLOWUP_FAILED"),
        primaryError,
        cleanupErrors,
      });
      if (primaryError instanceof Error && primaryError.name === "AbortError") aggregate.name = "AbortError";
      throw aggregate;
    }
    if (cleanupErrors.length === 0) throw primaryError;
    throw Object.assign(new AggregateError(
      [primaryError, ...cleanupErrors],
      "research operation and cleanup both failed",
      { cause: primaryError },
    ), {
      code: String((primaryError as NodeJS.ErrnoException | undefined)?.code || "EVOLVE_RESEARCH_FAILED"),
      primaryError,
      cleanupErrors,
      researchFile,
    });
  }
  if (cleanupErrors.length > 0) {
    throw Object.assign(new AggregateError(cleanupErrors, "research committed but temporary cleanup failed"), {
      code: "EVOLVE_RESEARCH_COMMITTED_CLEANUP_FAILED",
      committed: completed,
      researchFile,
      cleanupErrors,
    });
  }
}

// ── multi-evolve-state ──
const EVOLVE_LOCK_TTL_MS = 30_000;
const SAFE_PROJECT = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  if (err === null || typeof err !== "object") return false;
  const candidate = err as LooseRecord;
  return typeof candidate.code === "string";
}

function assertProject(project: string) {
  if (!SAFE_PROJECT.test(project || "")) {
    throw new Error(`invalid project name: ${project}`);
  }
}

export function evolveDir(projectRoot: string, project: string, options: EvolveOptions = {}) {
  assertProject(project);
  const dataRoot = options.dataRoot || options.projectRuntimeRoot;
  return path.join(path.resolve(dataRoot || path.join(projectRoot, "cpb-task")), "evolve", project);
}

function statePath(projectRoot: string, project: string, file: string, options: EvolveOptions = {}) {
  return path.join(evolveDir(projectRoot, project, options), file);
}

async function readJSON(filePath: string, fallback: unknown) {
  let raw: string;
  try {
    raw = await readTextFile(filePath, 16 * 1024 * 1024);
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`invalid evolve JSON: ${filePath}`, { cause: error }), {
      code: "EVOLVE_STATE_INVALID",
      filePath,
    });
  }
}

async function readTextFile(filePath: string, maxBytes: number) {
  try {
    return await readBoundedRegularFileNoFollow(filePath, { maxBytes });
  } catch (error) {
    const code = isErrnoException(error) ? error.code : "";
    if (code === "ENOENT") throw error;
    if (code === "BOUNDED_FILE_TOO_LARGE") {
      throw Object.assign(new Error(`evolve state file exceeds ${maxBytes} bytes: ${filePath}`, { cause: error }), {
        code: "EVOLVE_STATE_TOO_LARGE",
        filePath,
      });
    }
    if (["BOUNDED_FILE_UNSAFE", "BOUNDED_FILE_CHANGED", "BOUNDED_FILE_READ_FAILED"].includes(code)) {
      throw Object.assign(new Error(`unsafe or unstable evolve state file: ${filePath}`, { cause: error }), {
        code: "EVOLVE_STATE_UNSAFE",
        filePath,
      });
    }
    throw error;
  }
}

async function readTextIfExists(filePath: string, fallback: string, maxBytes: number) {
  try {
    return await readTextFile(filePath, maxBytes);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return fallback;
    throw error;
  }
}

type EvolveTemporaryGeneration = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
};

function evolveTemporaryGeneration(info: BigIntStats): EvolveTemporaryGeneration {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    birthtimeNs: info.birthtimeNs,
  };
}

function sameEvolveTemporaryGeneration(expected: EvolveTemporaryGeneration, current: BigIntStats) {
  return expected.dev === current.dev
    && expected.ino === current.ino
    && expected.mode === current.mode
    && expected.uid === current.uid
    && expected.gid === current.gid
    && expected.size === current.size
    && expected.mtimeNs === current.mtimeNs
    && expected.ctimeNs === current.ctimeNs
    && expected.birthtimeNs === current.birthtimeNs;
}

async function writeAtomic(filePath: string, content: string) {
  const parent = path.dirname(filePath);
  await mkdir(parent, { recursive: true });
  const tmp = path.join(parent, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let temporaryCreated = false;
  let temporaryGeneration: EvolveTemporaryGeneration | null = null;
  let renamed = false;
  let primaryError: unknown = null;
  try {
    handle = await open(tmp, "wx", 0o600);
    temporaryCreated = true;
    await handle.writeFile(content, "utf8");
    await handle.sync();
    const temporaryInfo = await handle.stat({ bigint: true });
    if (!temporaryInfo.isFile()) {
      throw Object.assign(new Error(`evolve atomic temporary is not a regular file: ${tmp}`), {
        code: "EVOLVE_WRITE_TEMP_UNSAFE",
      });
    }
    temporaryGeneration = evolveTemporaryGeneration(temporaryInfo);
    await handle.close();
    handle = null;
    await rename(tmp, filePath);
    renamed = true;
    await fsyncDirectory(parent);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (handle) {
    try {
      await handle.close();
      handle = null;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!primaryError && cleanupErrors.length === 0) return;

  if (renamed) {
    const errors = [primaryError, ...cleanupErrors].filter((error) => error !== null);
    const cause = errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `evolve atomic write and cleanup failed: ${filePath}`, {
        cause: primaryError ?? errors[0],
      });
    throw Object.assign(new Error(`evolve state committed with ambiguous durability: ${filePath}`, { cause }), {
      code: "EVOLVE_WRITE_COMMITTED_DURABILITY_AMBIGUOUS",
      committed: true,
      filePath,
    });
  }
  let temporaryPreserved = false;
  let successorPreserved = false;
  if (temporaryCreated && temporaryGeneration) {
    try {
      const current = await lstat(tmp, { bigint: true });
      temporaryPreserved = current.isFile()
        && !current.isSymbolicLink()
        && sameEvolveTemporaryGeneration(temporaryGeneration, current);
      successorPreserved = !temporaryPreserved;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") cleanupErrors.push(error);
    }
  }
  const errors = [primaryError, ...cleanupErrors].filter((error) => error !== null);
  const cause = errors.length === 1
    ? errors[0]
    : new AggregateError(errors, `evolve atomic write and recovery inspection failed: ${filePath}`, {
      cause: primaryError ?? errors[0],
    });
  throw Object.assign(new Error(`evolve atomic write failed before publication: ${filePath}`, { cause }), {
    code: String((primaryError as NodeJS.ErrnoException | undefined)?.code || "EVOLVE_WRITE_RECOVERY_REQUIRED"),
    committed: false,
    cleanupDeferred: true,
    temporaryCreated,
    temporaryPreserved,
    successorPreserved,
    recoveryPaths: temporaryPreserved
      ? { destination: filePath, temporary: tmp }
      : { destination: filePath },
    attemptedPaths: temporaryPreserved ? undefined : { temporary: tmp },
    primaryError,
    cleanupErrors,
  });
}

export async function loadProjectState(projectRoot: string, project: string, options: EvolveOptions = {}): Promise<EvolveState> {
  const state = await readJSON(statePath(projectRoot, project, "state.json", options), {
    knownGoodCommit: null,
    round: 0,
    status: "idle",
    enabled: true,
    updatedAt: null,
  });
  if (!isRecord(state)) {
    throw Object.assign(new Error(`invalid evolve project state for ${project}`), {
      code: "EVOLVE_STATE_INVALID",
      project,
    });
  }
  return state;
}

export async function saveProjectState(projectRoot: string, project: string, state: EvolveState, options: EvolveOptions = {}) {
  const next = { ...state, updatedAt: new Date().toISOString() };
  const filePath = statePath(projectRoot, project, "state.json", options);
  await withDurableDirectoryLock(
    `${filePath}.lock`,
    () => writeAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`),
    { ttlMs: EVOLVE_LOCK_TTL_MS, waitMs: 5_000, retryMs: 25 },
  );
  return next;
}

export async function loadBacklog(projectRoot: string, project: string, options: EvolveOptions = {}) {
  const value = await readJSON(statePath(projectRoot, project, "backlog.json", options), []);
  if (!Array.isArray(value) || value.some((item) => !isEvolveIssue(item))) {
    throw Object.assign(new Error(`invalid evolve backlog for ${project}`), {
      code: "EVOLVE_STATE_INVALID",
      project,
    });
  }
  return value as EvolveIssue[];
}

async function saveBacklogUnlocked(projectRoot: string, project: string, backlog: EvolveIssue[], options: EvolveOptions = {}) {
  await writeAtomic(statePath(projectRoot, project, "backlog.json", options), `${JSON.stringify(backlog, null, 2)}\n`);
  return backlog;
}

export async function saveBacklog(projectRoot: string, project: string, backlog: EvolveIssue[], options: EvolveOptions = {}) {
  return withBacklogLock(projectRoot, project, () => saveBacklogUnlocked(projectRoot, project, backlog, options), options);
}

async function withBacklogLock<T>(projectRoot: string, project: string, callback: () => Promise<T>, options: EvolveOptions = {}): Promise<T> {
  const lockDir = statePath(projectRoot, project, "backlog.json.lock", options);
  return withDurableDirectoryLock(lockDir, callback, {
    ttlMs: EVOLVE_LOCK_TTL_MS,
    waitMs: 5_000,
    retryMs: 25,
  });
}

function issueKeyFn2(issue: EvolveIssue) {
  return issue.id || issue.description;
}

export async function pushIssues(projectRoot: string, project: string, issues: EvolveIssue[], options: EvolveOptions = {}) {
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
    await saveBacklogUnlocked(projectRoot, project, backlog, options);
    return { added, total: backlog.length, backlog };
  }, options);
}

function priorityScore(priority: string) {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  return 3;
}

export async function popIssue(projectRoot: string, project: string, options: EvolveOptions = {}) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project, options);
    const pending = backlog.filter((issue) => issue.status === "pending");
    pending.sort((a, b) => priorityScore(a.priority) - priorityScore(b.priority));
    const issue = pending[0] || null;
    if (!issue) return null;
    issue.status = "in_progress";
    issue.updatedAt = new Date().toISOString();
    await saveBacklogUnlocked(projectRoot, project, backlog, options);
    return { issue, backlog };
  }, options);
}

function matchesIssue(issue: EvolveIssue, identity: string) {
  return Boolean(identity)
    && (issue.id === identity || issue.description === identity || issueKeyFn2(issue) === identity);
}

export async function updateIssueStatus(projectRoot: string, project: string, identity: string, status: string, detail: LooseRecord = {}, options: EvolveOptions = {}) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project, options);
    const issue = backlog.find((item) => matchesIssue(item, identity));
    if (!issue) return null;
    issue.status = status;
    issue.updatedAt = new Date().toISOString();
    if (detail && Object.keys(detail).length > 0) {
      issue.detail = { ...(issue.detail || {}), ...detail };
    }
    await saveBacklogUnlocked(projectRoot, project, backlog, options);
    return { issue, backlog };
  }, options);
}

export async function claimIssue(projectRoot: string, project: string, identity: string, options: EvolveOptions = {}) {
  return withBacklogLock(projectRoot, project, async () => {
    const backlog = await loadBacklog(projectRoot, project, options);
    const issue = backlog.find((item) => matchesIssue(item, identity) && item.status === "pending");
    if (!issue) return null;
    issue.status = "in_progress";
    issue.claimedAt = new Date().toISOString();
    issue.updatedAt = issue.claimedAt;
    await saveBacklogUnlocked(projectRoot, project, backlog, options);
    return { issue, backlog };
  }, options);
}

export async function completeIssue(projectRoot: string, project: string, identity: string, result: CompletionResult = {}, options: EvolveOptions = {}) {
  const status = result.ok ? "completed" : "failed";
  return updateIssueStatus(projectRoot, project, identity, status, {
    exitCode: result.code ?? null,
    error: result.error || null,
    completedAt: new Date().toISOString(),
  }, options);
}

export async function appendHistory(projectRoot: string, project: string, entry: LooseRecord, options: EvolveOptions = {}) {
  const filePath = statePath(projectRoot, project, "history.jsonl", options);
  const line = JSON.stringify({ ...entry, project, timestamp: new Date().toISOString() }) + "\n";
  await withDurableDirectoryLock(`${filePath}.lock`, async () => {
    const previous = await readTextIfExists(filePath, "", 64 * 1024 * 1024);
    await writeAtomic(filePath, `${previous}${line}`);
  }, { ttlMs: EVOLVE_LOCK_TTL_MS, waitMs: 5_000, retryMs: 25 });
}

export async function loadGlobalConfig(hubRoot: string) {
  const config = await readJSON(path.join(path.resolve(hubRoot), "evolve", "global", "config.json"), { projects: {} });
  if (!isRecord(config)) {
    throw Object.assign(new Error("invalid global evolve config"), { code: "EVOLVE_STATE_INVALID" });
  }
  return config;
}

export async function saveGlobalConfig(hubRoot: string, config: LooseRecord) {
  const filePath = path.join(path.resolve(hubRoot), "evolve", "global", "config.json");
  await withDurableDirectoryLock(
    `${filePath}.lock`,
    () => writeAtomic(filePath, `${JSON.stringify(config, null, 2)}\n`),
    { ttlMs: EVOLVE_LOCK_TTL_MS, waitMs: 5_000, retryMs: 25 },
  );
  return config;
}
