import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMeta, REQUIRED_EXECUTION_BOUNDARY } from "../../core/job/meta.js";
import { ensureIndexFresh } from "./index-freshness.js";
import { resolveAgentsForEntry } from "./agent-config.js";
import { getProject } from "./hub-registry.js";
import {
  DEFAULT_MAX_ACTIVE_PER_PROJECT,
  positiveInt,
  resolveHubConcurrencyLimits,
  resolveProjectConcurrencyLimits,
} from "./concurrency-limits.js";
import {
  priorityScore,
  isMutatingEntry,
  isActiveEntry,
  clearClaim,
  recoverStaleInProgressAsync,
  recoverIndexUnavailable,
} from "./queue-rules.js";


export const QUEUE_VERSION = 1;
const SAFE_ID = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function nowIso() {
  return new Date().toISOString();
}

function queuePath(hubRoot) {
  return path.join(path.resolve(hubRoot), "queue", "queue.json");
}

function defaultQueue() {
  return { version: QUEUE_VERSION, entries: [] };
}

function normalizeQueue(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return defaultQueue();
  return {
    version: raw.version || QUEUE_VERSION,
    entries: Array.isArray(raw.entries) ? raw.entries : [],
  };
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

const QUEUE_LOCK_TTL_MS = 120_000;

async function queueLockIsStale(lockDir) {
  const now = Date.now();
  try {
    const raw = await readFile(path.join(lockDir, "lock.json"), "utf8");
    const lock = JSON.parse(raw);
    const acquiredAt = new Date(lock.acquiredAt).getTime();
    return Number.isNaN(acquiredAt) || now - acquiredAt >= QUEUE_LOCK_TTL_MS;
  } catch {
    try {
      const info = await stat(lockDir);
      return now - info.mtimeMs >= QUEUE_LOCK_TTL_MS;
    } catch {
      return false;
    }
  }
}

async function queueLockOwnerPid(lockDir) {
  try {
    const raw = await readFile(path.join(lockDir, "lock.json"), "utf8");
    const lock = JSON.parse(raw);
    return lock.ownerPid || null;
  } catch {
    return null;
  }
}

async function withQueueLock(hubRoot, callback) {
  const file = queuePath(hubRoot);
  const lockDir = `${file}.lock`;
  const ownerPid = process.pid;
  await mkdir(path.dirname(file), { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, "lock.json"),
        `${JSON.stringify({ acquiredAt: nowIso(), ownerPid }, null, 2)}\n`,
        "utf8",
      );
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      if (await queueLockIsStale(lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  if (!acquired) {
    throw new Error(`queue lock busy: ${path.basename(file)}`);
  }

  const acquiredAt = nowIso();
  try {
    return await callback();
  } finally {
    // Check both PID and timestamp window to guard against PID reuse
    const currentOwner = await queueLockOwnerPid(lockDir);
    if (currentOwner === ownerPid && !(await queueLockIsStale(lockDir))) {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}

export async function loadQueue(hubRoot) {
  try {
    const raw = await readFile(queuePath(hubRoot), "utf8");
    return normalizeQueue(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === "ENOENT") return defaultQueue();
    throw err;
  }
}

async function saveQueue(hubRoot, queue) {
  const normalized = { version: QUEUE_VERSION, entries: queue.entries };
  await writeAtomic(queuePath(hubRoot), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function generateId() {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function hasIssueLink(metadata) {
  if (!metadata || typeof metadata !== "object") return false;
  return Boolean(metadata.issueNumber || metadata.issueUrl);
}

export function validateIssueLink(entry) {
  if (!entry) return { linked: false, reason: "no entry" };
  if (entry.status === "needs_issue_link") return { linked: false, reason: "awaiting issue link" };
  if (entry.status === "archived") return { linked: false, reason: "archived" };
  return { linked: hasIssueLink(entry.metadata), reason: null };
}

function entryKey(entry) {
  const lineage = entry.metadata?.queueDedupeKey || entry.metadata?.originJobId || "";
  return `${entry.projectId}::${entry.description}::${lineage}`;
}

export async function enqueue(hubRoot, input = {}) {
  if (!input.projectId) throw new Error("projectId is required");

  const meta = buildMeta(input);
  const normalizedInput = {
    ...input,
    sourcePath: meta.sourcePath,
    sessionId: meta.sessionId,
    workerId: meta.workerId,
    cwd: meta.cwd,
    executionBoundary: REQUIRED_EXECUTION_BOUNDARY,
  };
  if (!normalizedInput.metadata) normalizedInput.metadata = {};
  normalizedInput.metadata.acpProfile = normalizedInput.metadata.acpProfile || "headless";
  normalizedInput.metadata.uiLane = Boolean(normalizedInput.metadata.uiLane);
  normalizedInput.metadata.uiLaneReason = normalizedInput.metadata.uiLaneReason || "";
  if (normalizedInput.metadata.acpProfile === "ui" && !normalizedInput.metadata.uiLaneReason) {
    throw new Error("ui profile requires a non-empty uiLaneReason in queue metadata");
  }

  // Resolve agent config from hub + project + metadata overrides
  const cpbRoot = normalizedInput.cwd || process.cwd();
  const resolvedMeta = await resolveAgentsForEntry(hubRoot, cpbRoot, normalizedInput.projectId, normalizedInput.metadata);
  normalizedInput.metadata = resolvedMeta;

  // Resolve sourcePath from hub registry when not provided
  if (!meta.sourcePath && normalizedInput.projectId) {
    try {
      const project = await getProject(hubRoot, normalizedInput.projectId);
      if (project?.sourcePath) {
        meta.sourcePath = project.sourcePath;
        normalizedInput.sourcePath = project.sourcePath;
        if (!normalizedInput.cwd) normalizedInput.cwd = project.sourcePath;
      }
    } catch { /* project not found in registry — keep null */ }
  }

  return withQueueLock(hubRoot, async () => {
    const queue = await loadQueue(hubRoot);
    const key = entryKey(normalizedInput);
    const existing = queue.entries.find((e) => entryKey(e) === key && e.status === "pending");
    if (existing) return existing;

    const entry = {
      id: generateId(),
      projectId: normalizedInput.projectId,
      sourcePath: meta.sourcePath,
      sessionId: meta.sessionId,
      workerId: meta.workerId,
      cwd: meta.cwd,
      executionBoundary: REQUIRED_EXECUTION_BOUNDARY,
      type: normalizedInput.type || "candidate",
      status: "pending",
      priority: normalizedInput.priority || "P2",
      description: normalizedInput.description || "",
      metadata: normalizedInput.metadata || {},
      claimedBy: null,
      claimedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    queue.entries.push(entry);
    await saveQueue(hubRoot, queue);
    return entry;
  });
}

export async function peekQueue(hubRoot) {
  const queue = await loadQueue(hubRoot);
  const pending = queue.entries.filter((e) => e.status === "pending");
  if (pending.length === 0) return null;

  pending.sort((a, b) => priorityScore(a.priority) - priorityScore(b.priority) || a.createdAt.localeCompare(b.createdAt));
  return pending[0];
}

export async function updateEntry(hubRoot, entryId, patch = {}) {
  return withQueueLock(hubRoot, async () => {
    const queue = await loadQueue(hubRoot);
    const entry = queue.entries.find((e) => e.id === entryId);
    if (!entry) return null;

    if (patch.status !== undefined) entry.status = patch.status;
    if (patch.metadata) entry.metadata = { ...entry.metadata, ...patch.metadata };
    if (patch.claimedBy !== undefined) entry.claimedBy = patch.claimedBy;
    if (patch.claimedAt !== undefined) entry.claimedAt = patch.claimedAt;
    if (patch.workerId !== undefined) entry.workerId = patch.workerId;
    if (patch.reason !== undefined) entry.reason = patch.reason;
    if (patch.completedAt !== undefined) entry.completedAt = patch.completedAt;
    if (entry.status === "pending") clearClaim(entry);
    entry.updatedAt = nowIso();

    await saveQueue(hubRoot, queue);
    return entry;
  });
}

export async function listQueue(hubRoot, { status, projectId } = {}) {
  const queue = await loadQueue(hubRoot);
  return queue.entries.filter((e) => {
    if (status && e.status !== status) return false;
    if (projectId && e.projectId !== projectId) return false;
    return true;
  });
}

export async function syncBacklogResult(hubRoot, { projectId, description, result } = {}) {
  if (!projectId || !description) return { synced: 0, entries: [] };

  return withQueueLock(hubRoot, async () => {
    const queue = await loadQueue(hubRoot);
    const targetStatus = result.ok ? "completed" : "failed";
    const key = entryKey({ projectId, description, metadata: {} });

    const matches = queue.entries.filter(
      (e) => entryKey(e) === key && (e.status === "pending" || e.status === "in_progress"),
    );

    if (matches.length === 0) return { synced: 0, entries: [] };

    const metadata = {
      syncedFrom: "backlog",
      backlogIssueId: result.backlogIssueId || null,
      syncReason: result.ok ? "backlog_completed" : "backlog_failed",
    };
    if (result.error) metadata.error = result.error;

    for (const entry of matches) {
      entry.status = targetStatus;
      entry.metadata = { ...entry.metadata, ...metadata };
      entry.updatedAt = nowIso();
    }

    await saveQueue(hubRoot, queue);
    return { synced: matches.length, entries: matches };
  });
}

export async function queueStatus(hubRoot) {
  const queue = await loadQueue(hubRoot);
  const failedTargetStatus = summarizeFailedTargets(queue.entries);
  const counts = {
    total: queue.entries.length,
    pending: 0,
    scheduled: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    needsIssueLink: 0,
    indexUnavailable: 0,
    ...failedTargetStatus,
  };
  for (const e of queue.entries) {
    if (e.status === "pending") counts.pending++;
    else if (e.status === "scheduled") counts.scheduled++;
    else if (e.status === "in_progress") counts.inProgress++;
    else if (e.status === "completed") counts.completed++;
    else if (e.status === "failed") counts.failed++;
    else if (e.status === "blocked") counts.blocked++;
    else if (e.status === "cancelled") counts.cancelled++;
    else if (e.status === "needs_issue_link") counts.needsIssueLink++;
    else if (e.status === "index_unavailable") counts.indexUnavailable++;
  }
  const hubLimits = await resolveHubConcurrencyLimits(hubRoot);
  const projectLimits = await resolveProjectConcurrencyLimits(
    hubRoot,
    queue.entries.map((entry) => entry.projectId),
    { maxActivePerProject: hubLimits.maxActivePerProject },
  );
  counts.activeMutatingTotal = queue.entries.filter(
    (entry) => isActiveEntry(entry) && isMutatingEntry(entry),
  ).length;
  counts.projects = buildProjectQueueStatus(queue.entries, {
    maxActivePerProject: hubLimits.maxActivePerProject,
    projectLimits,
  });
  counts.activeProjects = Object.entries(counts.projects)
    .filter(([, ps]) => ps.activeMutating > 0)
    .map(([projectId, ps]) => ({ projectId, ...ps }));
  counts.eligibleQueued = 0;
  counts.eligibleProjects = [];
  for (const [pid, ps] of Object.entries(counts.projects)) {
    counts.eligibleQueued += ps.eligiblePending;
    if (ps.eligiblePending > 0) counts.eligibleProjects.push(pid);
  }
  return counts;
}

const ACTIVE_RETRY_STATUSES = new Set(["pending", "scheduled", "in_progress"]);

function failedTargetKey(entry) {
  const targetJobId = entry.type === "cli_retry"
    ? entry.metadata?.retryJobId
    : `job-${entry.id}`;
  if (!entry.projectId || !targetJobId) return null;
  return `${entry.projectId}\t${targetJobId}`;
}

function activeRetryTargetKey(entry) {
  if (entry.type !== "cli_retry" || !ACTIVE_RETRY_STATUSES.has(entry.status)) return null;
  const targetJobId = entry.metadata?.retryJobId;
  if (!entry.projectId || !targetJobId) return null;
  return `${entry.projectId}\t${targetJobId}`;
}

function completedRetryTargetKey(entry) {
  if (entry.type !== "cli_retry" || entry.status !== "completed") return null;
  const targetJobId = entry.metadata?.retryJobId;
  if (!entry.projectId || !targetJobId) return null;
  return `${entry.projectId}\t${targetJobId}`;
}

export function summarizeFailedTargets(entries = []) {
  const failedTargets = new Set();
  const activeRetryTargets = new Set();
  const completedRetryTargets = new Set();
  for (const entry of entries) {
    const activeRetry = activeRetryTargetKey(entry);
    if (activeRetry) activeRetryTargets.add(activeRetry);
    const completedRetry = completedRetryTargetKey(entry);
    if (completedRetry) completedRetryTargets.add(completedRetry);
    if (entry.status === "failed") {
      const failedTarget = failedTargetKey(entry);
      if (failedTarget) failedTargets.add(failedTarget);
    }
  }

  let retryingFailedTargets = 0;
  let retriedFailedTargets = 0;
  for (const target of failedTargets) {
    if (activeRetryTargets.has(target)) {
      retryingFailedTargets++;
    } else if (completedRetryTargets.has(target)) {
      retriedFailedTargets++;
    }
  }
  return {
    failedEntries: entries.filter((entry) => entry.status === "failed").length,
    failedTargets: failedTargets.size,
    retryingFailedTargets,
    retriedFailedTargets,
    unretriedFailedTargets: failedTargets.size - retryingFailedTargets - retriedFailedTargets,
  };
}

function limitForProject(projectLimits, projectId, fallback) {
  if (projectLimits instanceof Map) {
    return positiveInt(projectLimits.get(projectId), fallback);
  }
  return positiveInt(projectLimits?.[projectId], fallback);
}

export function buildProjectQueueStatus(entries, {
  maxActivePerProject = DEFAULT_MAX_ACTIVE_PER_PROJECT,
  projectLimits = new Map(),
} = {}) {
  const byProject = {};
  for (const e of entries) {
    if (!byProject[e.projectId]) {
      const limit = limitForProject(projectLimits, e.projectId, maxActivePerProject);
      byProject[e.projectId] = {
        pending: 0, scheduled: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0, indexUnavailable: 0,
        activeMutating: 0, busy: false, busyReason: null,
        maxActivePerProject: limit,
        claimedBy: null, claimedAt: null, workerId: null,
        activeEntryIds: [],
        eligiblePending: 0, eligibleEntryIds: [],
      };
    }
    const ps = byProject[e.projectId];
    if (e.status === "pending") ps.pending++;
    else if (e.status === "scheduled") ps.scheduled++;
    else if (e.status === "in_progress") ps.inProgress++;
    else if (e.status === "completed") ps.completed++;
    else if (e.status === "failed") ps.failed++;
    else if (e.status === "blocked") ps.blocked++;
    else if (e.status === "cancelled") ps.cancelled++;
    else if (e.status === "index_unavailable") ps.indexUnavailable++;
    if (isActiveEntry(e) && isMutatingEntry(e)) {
      ps.activeMutating++;
      ps.activeEntryIds.push(e.id);
      ps.busy = true;
      ps.busyReason = e.status === "scheduled" ? "scheduled-mutating-task" : "active-mutating-task";
      ps.claimedBy = e.claimedBy;
      ps.claimedAt = e.claimedAt;
      ps.workerId = e.workerId;
    }
  }
  for (const [projectId, ps] of Object.entries(byProject)) {
    Object.assign(
      ps,
      summarizeFailedTargets(entries.filter((entry) => entry.projectId === projectId)),
    );
  }
  // Second pass: compute eligible pending entries
  for (const e of entries) {
    if (e.status !== "pending") continue;
    const ps = byProject[e.projectId];
    if (!isMutatingEntry(e)) {
      // Non-mutating pending entries are always eligible
      ps.eligiblePending++;
      ps.eligibleEntryIds.push(e.id);
    } else if (ps.activeMutating < ps.maxActivePerProject) {
      // Mutating pending entries eligible when project not at capacity
      ps.eligiblePending++;
      ps.eligibleEntryIds.push(e.id);
    } else {
      ps.busy = true;
      ps.busyReason = "project-active-mutating-cap";
    }
  }
  return byProject;
}

export async function claimEligible(hubRoot, opts = {}) {
  const {
    workerId = `worker-${process.pid}`,
    projectId = null,
    maxActivePerProject = DEFAULT_MAX_ACTIVE_PER_PROJECT,
    claimTimeoutMs = 120_000,
    providerSlotsAvailable = true,
    requireIssueLink = false,
    getProjectFn = null,
    indexUnavailableRetryMs = 300_000,
    assignmentStore = null,
  } = opts;

  if (!providerSlotsAvailable) {
    return { entry: null, reason: "provider-slots-exhausted", recovered: [], activeProjects: [] };
  }

  return withQueueLock(hubRoot, async () => {
    const queue = await loadQueue(hubRoot);
    const { recovered, refreshed } = await recoverStaleInProgressAsync(queue.entries, { claimTimeoutMs, assignmentStore });
    const { recovered: recoveredIdx } = recoverIndexUnavailable(queue.entries, indexUnavailableRetryMs);
    if (recoveredIdx.length > 0) {
      recovered.push(...recoveredIdx);
    }
    if (recovered.length > 0 || refreshed.length > 0) {
      await saveQueue(hubRoot, queue);
    }

    const hubLimits = await resolveHubConcurrencyLimits(hubRoot, {
      maxActivePerProject,
    });

    const activeMutatingByProject = {};
    for (const e of queue.entries) {
      if (isActiveEntry(e) && isMutatingEntry(e)) {
        activeMutatingByProject[e.projectId] = (activeMutatingByProject[e.projectId] || 0) + 1;
      }
    }

    let pending = queue.entries.filter((e) => e.status === "pending");
    if (requireIssueLink) {
      pending = pending.filter((e) => hasIssueLink(e.metadata));
    }
    if (projectId) pending = pending.filter((e) => e.projectId === projectId);

    pending.sort((a, b) => {
      // Platform/architecture-fix entries get priority boost
      const aIsPlatformFix = /platform|architecture.fix/i.test(a.type || "") ? -1 : 0;
      const bIsPlatformFix = /platform|architecture.fix/i.test(b.type || "") ? -1 : 0;
      if (aIsPlatformFix !== bIsPlatformFix) return aIsPlatformFix - bIsPlatformFix;
      return priorityScore(a.priority) - priorityScore(b.priority) || a.createdAt.localeCompare(b.createdAt);
    });

    const projectLimits = await resolveProjectConcurrencyLimits(
      hubRoot,
      queue.entries.map((entry) => entry.projectId),
      { maxActivePerProject: hubLimits.maxActivePerProject, getProjectFn },
    );

    let chosen = null;
    let reason = null;
    const skippedBusy = [];
    const indexUnavailableIds = [];

    for (const candidate of pending) {
      if (isMutatingEntry(candidate)) {
        const projectLimit = limitForProject(projectLimits, candidate.projectId, maxActivePerProject);
        if ((activeMutatingByProject[candidate.projectId] || 0) >= projectLimit) {
          if (!skippedBusy.includes(candidate.projectId)) skippedBusy.push(candidate.projectId);
          continue;
        }
      }

      // Index freshness gate: when getProjectFn is provided, check freshness
      // for registered projects. Unregistered projects skip the gate.
      if (getProjectFn) {
        const project = await getProjectFn(hubRoot, candidate.projectId);
        if (project && (!project.sourcePath || !project.projectRuntimeRoot)) {
          candidate.status = "index_unavailable";
          candidate.updatedAt = nowIso();
          candidate.metadata = {
            ...candidate.metadata,
            indexFreshness: {
              available: false,
              indexDirty: true,
              indexStale: false,
              worktreeDirty: false,
              dirtyReasons: ["missing_source_or_runtime_root"],
            },
          };
          indexUnavailableIds.push(candidate.id);
          continue;
        }
        if (project?.sourcePath && project.projectRuntimeRoot) {
          const fresh = await ensureIndexFresh(project);
          if (!fresh.available) {
            candidate.status = "index_unavailable";
            candidate.updatedAt = nowIso();
            candidate.metadata = {
              ...candidate.metadata,
              indexFreshness: {
                available: false,
                indexDirty: fresh.indexDirty ?? true,
                indexStale: fresh.indexStale ?? false,
                worktreeDirty: fresh.worktreeDirty ?? false,
                dirtyReasons: fresh.dirtyReasons ?? ["index_unavailable"],
              },
            };
            indexUnavailableIds.push(candidate.id);
            continue;
          }
          candidate.indexSnapshotId = fresh.indexSnapshotId;
          candidate.metadata = {
            ...candidate.metadata,
            indexSnapshot: {
              indexSnapshotId: fresh.indexSnapshotId,
              sourceFingerprint: fresh.sourceFingerprint,
              indexFreshness: {
                available: true,
                indexDirty: false,
                indexStale: false,
                worktreeDirty: fresh.worktreeDirty ?? false,
                dirtyReasons: [],
              },
            },
          };
        }
      }

      chosen = candidate;
      break;
    }

    if (indexUnavailableIds.length > 0) {
      await saveQueue(hubRoot, queue);
    }

    if (!chosen) {
      const projectStatus = buildProjectQueueStatus(queue.entries, {
        maxActivePerProject: hubLimits.maxActivePerProject,
        projectLimits,
      });
      const activeProjects = Object.entries(projectStatus)
        .filter(([, ps]) => ps.activeMutating > 0)
        .map(([pid, ps]) => ({ projectId: pid, ...ps }));
      if (pending.length === 0 && !projectId) {
        reason = "no-pending-entries";
      } else if (pending.length === 0 && projectId) {
        reason = "no-pending-for-project";
      } else {
        reason = "all-projects-busy";
      }
      return { entry: null, reason, recovered, activeProjects, skippedBusy };
    }

    const now = nowIso();
    chosen.status = "in_progress";
    chosen.claimedBy = workerId;
    chosen.workerId = workerId;
    chosen.claimedAt = now;
    chosen.updatedAt = now;

    await saveQueue(hubRoot, queue);

    const projectStatus = buildProjectQueueStatus(queue.entries, {
      maxActivePerProject: hubLimits.maxActivePerProject,
      projectLimits,
    });
    const activeProjects = Object.entries(projectStatus)
      .filter(([, ps]) => ps.activeMutating > 0)
      .map(([pid, ps]) => ({ projectId: pid, ...ps }));

    return { entry: chosen, reason: null, recovered, activeProjects, skippedBusy };
  });
}
