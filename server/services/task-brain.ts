import { readFile } from "node:fs/promises";
import { listCandidates, updateCandidate } from "./event-source.js";
import { listProjects } from "./hub-registry.js";
import { listJobs } from "./job-store.js";
import { getAgentPerformance } from "./performance-tracker.js";

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

function classifyCategory(payload) {
  const title = (payload.title || "").toLowerCase();
  const body = (payload.body || "").toLowerCase();
  const labels = (payload.labels || []).map((l) => l.toLowerCase());
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

function isSafeAuto(category) {
  return SAFE_AUTO_CATEGORIES.includes(category);
}

function isRisky(category) {
  return RISKY_CATEGORIES.includes(category);
}

function recommendWorkflow(category) {
  if (category === "documentation") return "standard";
  if (category === "test-fix" || category === "ci-diagnosis") return "standard";
  return "standard";
}

function recommendAgent(category, _availableAgents) {
  // Default to the most stable agent for the task
  return null; // null means use default agent selection
}

function isProactiveJob(job) {
  return job?.trigger === "proactive" ||
    job?.sourceContext?.type === "proactive" ||
    job?.sourceContext?.source === "proactive";
}

/**
 * Evaluate a candidate event and produce a task recommendation.
 * Returns { candidate, recommendation } or null if not actionable.
 */
export async function evaluateCandidate(cpbRoot, candidate, { availableAgents = [] } = {}) {
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
 * Returns array of { candidate, recommendation }.
 */
export async function scanCandidates(cpbRoot, { availableAgents = [], hubRoot }: Record<string, any> = {}) {
  const pending = await listCandidates(cpbRoot, { status: "pending", hubRoot });

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
export async function checkProactiveBudget(cpbRoot, { hubRoot, logger = console }: Record<string, any> = {}) {
  const enabled = process.env.CPB_PROACTIVE === "1";
  if (!enabled) {
    return { allowed: false, reason: "proactive disabled (CPB_PROACTIVE not set to 1)" };
  }

  const dailyLimit = parseInt(process.env.CPB_PROACTIVE_DAILY_LIMIT, 10) || DEFAULT_DAILY_LIMIT;
  const failureLimit = parseInt(process.env.CPB_PROACTIVE_FAILURE_LIMIT, 10) || DEFAULT_CONSECUTIVE_FAILURE_LIMIT;

  // Rolling 24h window instead of calendar day to prevent midnight bypass
  const projects = hubRoot ? await listProjects(hubRoot) : [];
  const jobBatches = [];
  for (const project of projects) {
    const dataRoot = typeof project?.projectRuntimeRoot === "string" && project.projectRuntimeRoot.trim()
      ? project.projectRuntimeRoot
      : null;
    if (!dataRoot) {
      logger?.warn?.({ project: project?.id }, "skipping proactive budget project without projectRuntimeRoot");
      continue;
    }
    try {
      jobBatches.push(await listJobs(cpbRoot, { dataRoot, includeLegacyFallback: false }));
    } catch (err) {
      logger?.warn?.({ err, project: project.id, dataRoot }, "skipping proactive budget project with unreadable runtime root");
    }
  }
  const jobs = jobBatches.flat();
  const windowMs = 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const windowProactive = jobs.filter((j) => {
    if (!isProactiveJob(j)) return false;
    const ts = j.createdAt ? new Date(j.createdAt).getTime() : 0;
    return ts > cutoff;
  });

  if (windowProactive.length >= dailyLimit) {
    return { allowed: false, reason: `daily limit reached (${dailyLimit})` };
  }

  // Check consecutive failures (most recent first)
  const recent = [...windowProactive]
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
    .slice(0, failureLimit);

  const consecutiveFailures = recent.every((j) => j.status === "failed");
  if (consecutiveFailures && recent.length >= failureLimit) {
    return { allowed: false, reason: `consecutive failure limit reached (${failureLimit})` };
  }

  return { allowed: true, remaining: dailyLimit - windowProactive.length };
}

function buildTaskDescription(candidate) {
  const parts = [`Source: ${candidate.source}`];
  if (candidate.payload.title) parts.push(`Title: ${candidate.payload.title}`);
  if (candidate.payload.body) parts.push(candidate.payload.body.slice(0, 500));
  if (candidate.payload.labels?.length) parts.push(`Labels: ${candidate.payload.labels.join(", ")}`);
  return parts.join("\n\n");
}

/**
 * Export category classification for testing.
 */
export { classifyCategory, isSafeAuto, isRisky, SAFE_AUTO_CATEGORIES, RISKY_CATEGORIES };
