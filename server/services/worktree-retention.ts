// @ts-nocheck
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { listJobs } from "./job-store.js";
import { runtimeDataPath } from "./runtime-root.js";

const COMPLETED_ACTIONS = new Set(["preserve", "delete", "archive"]);

function normalizePolicy(cpbRoot, policy = {}) {
  const completed = COMPLETED_ACTIONS.has(policy.completed) ? policy.completed : "preserve";
  return {
    completed,
    archiveRoot: path.resolve(policy.archiveRoot || runtimeDataPath(cpbRoot, "worktree-archive")),
  };
}

function archivePathFor(policy, worktree) {
  return path.join(policy.archiveRoot, path.basename(worktree));
}

function entryForJob(job, policy) {
  const base = {
    jobId: job.jobId,
    project: job.project || null,
    status: job.status || "unknown",
    worktree: job.worktree,
    branch: job.worktreeBranch || null,
    baseBranch: job.worktreeBaseBranch || null,
    action: "preserve",
    reason: "worktree retained by default",
  };

  if (job.status === "completed") {
    if (policy.completed === "delete") {
      return {
        ...base,
        action: "delete",
        reason: "completed job worktree selected by policy: delete",
      };
    }
    if (policy.completed === "archive") {
      return {
        ...base,
        action: "archive",
        archivePath: archivePathFor(policy, job.worktree),
        reason: "completed job worktree selected by policy: archive",
      };
    }
    return {
      ...base,
      reason: "completed job worktree preserved by policy",
    };
  }

  if (job.status === "failed" || job.status === "blocked") {
    return {
      ...base,
      reason: `${job.status} job worktree retained for inspection by default`,
    };
  }

  return {
    ...base,
    reason: `${job.status || "unknown"} job worktree retained because it is not completed`,
  };
}

export async function buildWorktreeRetentionPlan(cpbRoot, { policy = {}, dryRun = true } = {}) {
  const normalizedPolicy = normalizePolicy(cpbRoot, policy);
  const jobs = await listJobs(cpbRoot);
  const entries = jobs
    .filter((job) => job.jobId && job.worktree)
    .map((job) => entryForJob(job, normalizedPolicy))
    .sort((a, b) => a.worktree.localeCompare(b.worktree));

  return {
    dryRun: Boolean(dryRun),
    policy: normalizedPolicy,
    entries,
    summary: {
      total: entries.length,
      delete: entries.filter((entry) => entry.action === "delete").length,
      archive: entries.filter((entry) => entry.action === "archive").length,
      preserve: entries.filter((entry) => entry.action === "preserve").length,
    },
  };
}

export async function cleanupWorktrees(cpbRoot, { policy = {}, dryRun = true } = {}) {
  const plan = await buildWorktreeRetentionPlan(cpbRoot, { policy, dryRun });
  if (plan.dryRun) return plan;

  const results = [];
  for (const entry of plan.entries) {
    if (entry.action === "delete") {
      await rm(entry.worktree, { recursive: true, force: true });
      results.push({ ...entry, result: "deleted" });
    } else if (entry.action === "archive") {
      await mkdir(path.dirname(entry.archivePath), { recursive: true });
      await rename(entry.worktree, entry.archivePath);
      results.push({ ...entry, result: "archived" });
    } else {
      results.push({ ...entry, result: "preserved" });
    }
  }

  return { ...plan, entries: results };
}

export function formatWorktreeRetentionHuman(plan) {
  const lines = [
    plan.dryRun ? "CodePatchBay Worktree Cleanup (dry-run)" : "CodePatchBay Worktree Cleanup",
    "",
  ];

  if (plan.entries.length === 0) {
    lines.push("No job worktrees found.");
    return `${lines.join("\n")}\n`;
  }

  for (const entry of plan.entries) {
    const target = entry.action === "archive" ? ` -> ${entry.archivePath}` : "";
    lines.push(`${entry.action.toUpperCase()} ${entry.worktree}${target}`);
    lines.push(`  job: ${entry.jobId} status: ${entry.status}`);
    lines.push(`  reason: ${entry.reason}`);
  }
  return `${lines.join("\n")}\n`;
}
