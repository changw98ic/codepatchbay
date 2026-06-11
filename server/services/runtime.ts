// ── runtime-root ──
// Server-facing runtime path facade over core/paths.js.
// Keep the exported surface explicit so boundary checks can reason about it.
export {
  runtimeDataRoot,
  runtimeDataPath,
  cpbHome,
  defaultProjectRuntimeRoot,
  projectRuntimeRoot,
  projectRuntimePath,
  resolveDataRoot,
  dataPath,
} from "../../core/paths.js";

// ── runtime-context ──
import path from "node:path";
import { runtimeDataRoot } from "../../core/paths.js";
import { getProject, listProjects, resolveHubRoot } from "./hub/hub-registry.js";

type RuntimeRootEntry = { kind: string; dataRoot: string; projectId: string | null };

function uniqueRoots(entries: RuntimeRootEntry[]) {
  const seen = new Set<string>();
  const result: RuntimeRootEntry[] = [];
  for (const entry of entries) {
    if (!entry?.dataRoot) continue;
    const dataRoot = path.resolve(entry.dataRoot);
    if (seen.has(dataRoot)) continue;
    seen.add(dataRoot);
    result.push({ ...entry, dataRoot });
  }
  return result;
}

export async function resolveProjectDataRoot(cpbRoot: string, project: string, { hubRoot, dataRoot }: { hubRoot?: string; dataRoot?: string } = {}) {
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  const registered = await getProject(resolvedHubRoot, project);
  if (registered?.projectRuntimeRoot) {
    const registeredRoot = path.resolve(registered.projectRuntimeRoot);
    if (dataRoot && path.resolve(dataRoot) !== registeredRoot) {
      throw new Error(`CPB_PROJECT_RUNTIME_ROOT does not match Hub registry for project '${project}'`);
    }
    return registeredRoot;
  }
  throw new Error(`project runtime root required for project '${project}'`);
}

export async function listRuntimeDataRoots(cpbRoot: string, { hubRoot, includeHubProjects = true, includeLegacy = false }: { hubRoot?: string; includeHubProjects?: boolean; includeLegacy?: boolean } = {}) {
  const entries: RuntimeRootEntry[] = [];
  if (includeLegacy) {
    entries.push({ kind: "legacy", dataRoot: path.join(path.resolve(cpbRoot), "cpb-task"), projectId: null });
  }
  if (!includeHubProjects) return uniqueRoots(entries);
  const resolvedHubRoot = hubRoot ? path.resolve(hubRoot) : resolveHubRoot(cpbRoot);
  const projects = await listProjects(resolvedHubRoot) as Array<{ id: string; projectRuntimeRoot?: string }>;
  for (const project of projects) {
    if (project.projectRuntimeRoot) {
      entries.push({
        kind: "project",
        projectId: project.id,
        dataRoot: project.projectRuntimeRoot,
      });
    }
  }
  return uniqueRoots(entries);
}

// ── runtime-health ──
import { readFile } from "node:fs/promises";
import { inspectCurrentRelease } from "./release/release-store.js";
import { loadQueue } from "./hub/hub-queue.js";
import { readLeaderStatus } from "../orchestrator/leader-lock.js";
import { readJobsIndex } from "./job/job-store.js";
import { listEventFiles, materializeJob, readEventsReadOnly } from "./event/event-store.js";
import { readLease, isLeaseStale } from "./infra.js";

type AnyRecord = Record<string, any>;
type RuntimeJob = AnyRecord & {
  jobId?: string;
  project?: string;
  status?: string;
  leaseId?: string;
  lastActivityAt?: string;
  updatedAt?: string;
  createdAt?: string;
};

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

async function probeValue(probes: AnyRecord, key: string, fallback: () => any) {
  if (Object.prototype.hasOwnProperty.call(probes, key)) {
    const value = probes[key];
    return typeof value === "function" ? await value() : value;
  }
  return fallback();
}

async function readPackageVersion(root: string) {
  try {
    const raw = await readFile(path.join(path.resolve(root), "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed.version || null;
  } catch {
    return null;
  }
}

async function readLauncherReleaseVersion(executorRoot: string) {
  try {
    const raw = await readFile(path.join(path.resolve(executorRoot), "release", "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed.codeVersion || null;
  } catch {
    return null;
  }
}

async function readActiveRelease(env: NodeJS.ProcessEnv) {
  const current = await inspectCurrentRelease({ env });
  return {
    initialized: Boolean(current),
    version: current?.metadata?.codeVersion || null,
  };
}

function countQueueBlockers(entries: AnyRecord[]) {
  const counts = {
    codegraph_unavailable: 0,
    agent_rate_limited: 0,
  };
  for (const entry of entries || []) {
    const status = entry?.status || "";
    const reason = entry?.metadata?.lastFailure || entry?.metadata?.failureKind || entry?.failure?.kind || "";
    if (status === "codegraph_unavailable" || reason === "codegraph_unavailable") {
      counts.codegraph_unavailable += 1;
    }
    if (status === "agent_rate_limited" || reason === "agent_rate_limited") {
      counts.agent_rate_limited += 1;
    }
  }
  return counts;
}

function runtimeOpts(dataRoot: string) {
  return { dataRoot, includeLegacyFallback: false };
}

async function countJobsIndexDivergence(cpbRoot: string, hubRoot: string) {
  const roots = await listRuntimeDataRoots(cpbRoot, { hubRoot, includeLegacy: false });
  let totalDiverged = 0;
  for (const root of roots) {
    totalDiverged += await countJobsIndexDivergenceForRoot(cpbRoot, root.dataRoot);
  }
  return totalDiverged;
}

async function countJobsIndexDivergenceForRoot(cpbRoot: string, dataRoot: string) {
  let index;
  try {
    index = await readJobsIndex(cpbRoot, runtimeOpts(dataRoot));
  } catch {
    index = null;
  }
  const indexJobs = index?.jobs || {};
  const indexKeys = new Set(Object.keys(indexJobs));

  let eventFiles = [];
  try {
    eventFiles = await listEventFiles(cpbRoot, runtimeOpts(dataRoot));
  } catch {
    return 0;
  }

  let diverged = 0;
  for (const { project, jobId } of eventFiles) {
    const key = `${project}/${jobId}`;
    if (!indexKeys.has(key)) {
      diverged += 1;
      continue;
    }
    try {
      const events = await readEventsReadOnly(cpbRoot, project, jobId, runtimeOpts(dataRoot));
      const actual = materializeJob(events);
      const indexed = indexJobs[key];
      if (actual?.status !== indexed?.status) diverged += 1;
    } catch {
      diverged += 1;
    }
  }

  for (const key of indexKeys) {
    const [project, jobId] = key.split("/");
    const found = eventFiles.some((entry) => entry.project === project && entry.jobId === jobId);
    if (!found) diverged += 1;
  }

  return diverged;
}

async function findStaleJobs(cpbRoot: string, hubRoot: string) {
  const roots = await listRuntimeDataRoots(cpbRoot, { hubRoot, includeLegacy: false });
  const stale = [];
  const now = new Date();

  for (const root of roots) {
    const index = await readJobsIndex(cpbRoot, runtimeOpts(root.dataRoot));
    const jobs = Object.values((index as AnyRecord)?.jobs || {}) as RuntimeJob[];
    for (const job of jobs) {
      if (!job?.jobId || TERMINAL_JOB_STATUSES.has(job.status)) continue;
      if (!job.leaseId) {
        const lastActivityAt = job.lastActivityAt || job.updatedAt || job.createdAt;
        const age = lastActivityAt ? now.getTime() - new Date(lastActivityAt).getTime() : Infinity;
        if (!Number.isFinite(age) || age > 300_000) {
          stale.push({ jobId: job.jobId, project: job.project || null, reason: "no active lease" });
        }
        continue;
      }
      try {
        const lease = await readLease(cpbRoot, job.leaseId, runtimeOpts(root.dataRoot));
        if (lease === null || isLeaseStale(lease, now)) {
          stale.push({ jobId: job.jobId, project: job.project || null, reason: lease === null ? "missing lease" : "stale lease" });
        }
      } catch {
        stale.push({ jobId: job.jobId, project: job.project || null, reason: "lease read error" });
      }
    }
  }

  return stale;
}

function hasPriorDivergence(history, count) {
  return (history || []).some((entry) => {
    const prior = entry?.jobsIndexDivergence;
    return prior && prior.count > 0 && count > 0;
  });
}

function hasFailedReconcileEvidence(evidence, count) {
  if (!evidence || count <= 0) return false;
  if (Array.isArray(evidence)) {
    return evidence.some((entry) => hasFailedReconcileEvidence(entry, count));
  }
  return evidence.attempted === true && evidence.success === false;
}

export function classifyJobsIndexDivergence(count, { history = [], reconcileEvidence = null } = {}) {
  if (count <= 0) return "ok";
  if (hasPriorDivergence(history, count) || hasFailedReconcileEvidence(reconcileEvidence, count)) {
    return "blocker";
  }
  return "warning";
}

export async function collectRuntimeHealth({
  cpbRoot = process.cwd(),
  executorRoot = cpbRoot,
  env = process.env,
  probes = {},
  history = [],
} = {}) {
  const resolvedCpbRoot = path.resolve(cpbRoot);
  const resolvedExecutorRoot = path.resolve(executorRoot || cpbRoot);
  const hubRoot = resolveHubRoot(resolvedCpbRoot);

  const activeRelease = await readActiveRelease(env).catch(() => ({ initialized: false, version: null }));
  const [
    sourceVersion,
    activeReleaseVersion,
    launcherReleaseVersion,
    initialized,
    hubOrchestratorStatus,
    queueEntries,
    divergenceCount,
    staleJobs,
    reconcileEvidence,
  ] = await Promise.all([
    probeValue(probes, "sourceVersion", () => readPackageVersion(resolvedCpbRoot)),
    probeValue(probes, "activeReleaseVersion", () => activeRelease.version),
    probeValue(probes, "launcherReleaseVersion", () => readLauncherReleaseVersion(resolvedExecutorRoot)),
    probeValue(probes, "initialized", () => activeRelease.initialized),
    probeValue(probes, "hubOrchestratorStatus", async () => {
      try {
        return (await readLeaderStatus(hubRoot)).status || null;
      } catch {
        return null;
      }
    }),
    probeValue(probes, "queueEntries", async () => {
      try {
        return (await loadQueue(hubRoot)).entries || [];
      } catch {
        return [];
      }
    }),
    probeValue(probes, "jobsIndexDivergenceCount", () => countJobsIndexDivergence(resolvedCpbRoot, hubRoot)),
    probeValue(probes, "staleJobs", () => findStaleJobs(resolvedCpbRoot, hubRoot)),
    probeValue(probes, "reconcileEvidence", () => null),
  ]);

  const blockers = [];
  const warnings = [];
  const queueBlockingCounts = countQueueBlockers(queueEntries);
  const jobsIndexSeverity = classifyJobsIndexDivergence(Number(divergenceCount) || 0, {
    history,
    reconcileEvidence,
  });

  if (!initialized) {
    warnings.push({
      code: "release_uninitialized",
      message: "No active CPB release is selected",
    });
  } else if (!activeReleaseVersion) {
    warnings.push({
      code: "active_release_unknown",
      message: "Active release metadata is not available",
    });
  } else if (sourceVersion && activeReleaseVersion && sourceVersion !== activeReleaseVersion) {
    blockers.push({
      code: "release_version_mismatch",
      message: "Active release differs from source",
      expected: sourceVersion,
      actual: activeReleaseVersion,
    });
  }

  if (launcherReleaseVersion == null) {
    warnings.push({
      code: "launcher_release_unknown",
      message: "Launcher release metadata is not available",
    });
  }

  if (queueBlockingCounts.codegraph_unavailable > 0) {
    blockers.push({
      code: "codegraph_unavailable",
      message: `${queueBlockingCounts.codegraph_unavailable} queue entr${queueBlockingCounts.codegraph_unavailable === 1 ? "y is" : "ies are"} blocked by CodeGraph readiness`,
      count: queueBlockingCounts.codegraph_unavailable,
    });
  }
  if (queueBlockingCounts.agent_rate_limited > 0) {
    warnings.push({
      code: "agent_rate_limited",
      message: `${queueBlockingCounts.agent_rate_limited} queue entr${queueBlockingCounts.agent_rate_limited === 1 ? "y is" : "ies are"} rate limited`,
      count: queueBlockingCounts.agent_rate_limited,
    });
  }

  const staleJobList = Array.isArray(staleJobs) ? staleJobs : [];
  if (staleJobList.length > 0) {
    blockers.push({
      code: "stale_jobs",
      message: `${staleJobList.length} stale job${staleJobList.length === 1 ? "" : "s"} detected`,
      count: staleJobList.length,
    });
  }

  if (jobsIndexSeverity === "warning") {
    warnings.push({
      code: "jobs_index_needs_reconcile",
      message: "Jobs index differs from event log",
      count: Number(divergenceCount) || 0,
    });
  } else if (jobsIndexSeverity === "blocker") {
    blockers.push({
      code: "jobs_index_divergent",
      message: "Jobs index still differs from event log after explicit reconcile evidence",
      count: Number(divergenceCount) || 0,
    });
  }

  return {
    ok: blockers.length === 0,
    sourceVersion,
    activeReleaseVersion: activeReleaseVersion || null,
    launcherReleaseVersion: launcherReleaseVersion || null,
    initialized: Boolean(initialized),
    hubOrchestratorStatus,
    queueBlockingCounts,
    staleJobs: staleJobList.length,
    jobsIndexDivergence: {
      count: Number(divergenceCount) || 0,
      severity: jobsIndexSeverity,
    },
    blockers,
    warnings,
  };
}
