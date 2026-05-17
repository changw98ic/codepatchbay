import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_BLOCKED_KEYWORDS = [
  "secret",
  "token",
  "auth",
  "credential",
  "destructive",
  "migration",
  "public api",
  "breaking",
  "delete",
];

export const DEFAULT_EVOLVE_POLICY = Object.freeze({
  allowProjects: [],
  maxConcurrentRepairs: 1,
  maxRepairsPerRun: 1,
  maxFailuresPerRun: 1,
  maxFilesChanged: 12,
  maxPatchBytes: 60_000,
  requireCleanWorktree: true,
  blockedPriorities: ["P0", "P1"],
  blockedKeywords: DEFAULT_BLOCKED_KEYWORDS,
});

function splitList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export function normalizeEvolvePolicy(input = {}) {
  return {
    ...DEFAULT_EVOLVE_POLICY,
    ...input,
    allowProjects: splitList(input.allowProjects ?? process.env.CPB_EVOLVE_ALLOW_PROJECTS),
    blockedPriorities: splitList(input.blockedPriorities ?? DEFAULT_EVOLVE_POLICY.blockedPriorities),
    blockedKeywords: splitList(input.blockedKeywords ?? DEFAULT_EVOLVE_POLICY.blockedKeywords).map((item) => item.toLowerCase()),
    maxConcurrentRepairs: Number(input.maxConcurrentRepairs ?? DEFAULT_EVOLVE_POLICY.maxConcurrentRepairs),
    maxRepairsPerRun: Number(input.maxRepairsPerRun ?? DEFAULT_EVOLVE_POLICY.maxRepairsPerRun),
    maxFailuresPerRun: Number(input.maxFailuresPerRun ?? DEFAULT_EVOLVE_POLICY.maxFailuresPerRun),
    maxFilesChanged: Number(input.maxFilesChanged ?? DEFAULT_EVOLVE_POLICY.maxFilesChanged),
    maxPatchBytes: Number(input.maxPatchBytes ?? DEFAULT_EVOLVE_POLICY.maxPatchBytes),
    requireCleanWorktree: input.requireCleanWorktree ?? DEFAULT_EVOLVE_POLICY.requireCleanWorktree,
  };
}

export async function loadEvolvePolicy(hubRoot) {
  const filePath = path.join(path.resolve(hubRoot), "evolve", "policy.json");
  try {
    return normalizeEvolvePolicy(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return normalizeEvolvePolicy();
  }
}

export function isProjectAllowed(project, policy = DEFAULT_EVOLVE_POLICY) {
  const allow = new Set(policy.allowProjects || []);
  return allow.has("*") || allow.has(project.id) || allow.has(project.name);
}

export function classifyRepairRisk(issue = {}, policy = DEFAULT_EVOLVE_POLICY) {
  const priority = String(issue.priority || "P3").toUpperCase();
  if ((policy.blockedPriorities || []).includes(priority)) {
    return { blocked: true, reason: `${priority} issues require human review` };
  }

  const description = String(issue.description || "").toLowerCase();
  const keyword = (policy.blockedKeywords || []).find((item) => item && description.includes(item));
  if (keyword) {
    return { blocked: true, reason: `issue mentions high-risk keyword '${keyword}'` };
  }

  return { blocked: false, reason: null };
}

function statusLinePath(line) {
  const rawPath = line.slice(3).trim();
  return rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
}

function isCpbRuntimeStatusLine(line) {
  const statusPath = statusLinePath(line);
  return statusPath === "cpb-task"
    || statusPath.startsWith("cpb-task/")
    || statusPath === ".cpb"
    || statusPath.startsWith(".cpb/");
}

export async function worktreeCleanStatus(sourcePath) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: path.resolve(sourcePath),
      timeout: 10_000,
    });
    const dirty = stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .filter((line) => !isCpbRuntimeStatusLine(line));
    return { clean: dirty.length === 0, reason: dirty.length > 0 ? "source worktree is dirty" : null };
  } catch {
    return { clean: false, reason: "sourcePath is not a readable git worktree" };
  }
}

export async function evaluateGuardedRepair({ project, issue, policy, cleanStatus } = {}) {
  const normalized = normalizeEvolvePolicy(policy);
  if (!project) return { allowed: false, reason: "project is required", policy: normalized };
  if (!issue) return { allowed: false, reason: "issue is required", policy: normalized };

  if (!isProjectAllowed(project, normalized)) {
    return { allowed: false, reason: `project '${project.id || project.name}' is not allowlisted`, policy: normalized };
  }

  const risk = classifyRepairRisk(issue, normalized);
  if (risk.blocked) {
    return { allowed: false, reason: risk.reason, policy: normalized };
  }

  if (normalized.requireCleanWorktree) {
    const status = cleanStatus || await worktreeCleanStatus(project.sourcePath);
    if (!status.clean) {
      return { allowed: false, reason: status.reason || "source worktree is not clean", policy: normalized };
    }
  }

  return { allowed: true, reason: null, policy: normalized };
}
