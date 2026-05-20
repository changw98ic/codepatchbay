import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildMeta } from "./execution-meta.js";

import {
  shouldUseRustRuntime,
  hubQueueEnqueue as _rustEnqueue,
  hubQueueDequeue as _rustDequeue,
  hubQueueList as _rustList,
  hubQueueUpdate as _rustUpdate,
  hubQueueStatus as _rustStatus,
} from "./runtime-cli.js";

const QUEUE_VERSION = 1;
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

function priorityScore(priority) {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  return 3;
}

function entryKey(entry) {
  const lineage = entry.metadata?.originJobId || "";
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
    executionBoundary: meta.executionBoundary,
  };
  if (shouldUseRustRuntime()) return _rustEnqueue(hubRoot, normalizedInput);

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
    executionBoundary: meta.executionBoundary,
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
}

export async function dequeue(hubRoot) {
  if (shouldUseRustRuntime()) return _rustDequeue(hubRoot);
  const queue = await loadQueue(hubRoot);
  const pending = queue.entries.filter((e) => e.status === "pending");
  if (pending.length === 0) return null;

  pending.sort((a, b) => priorityScore(a.priority) - priorityScore(b.priority) || a.createdAt.localeCompare(b.createdAt));
  const entry = pending[0];
  entry.status = "in_progress";
  entry.claimedAt = nowIso();
  entry.updatedAt = entry.claimedAt;
  await saveQueue(hubRoot, queue);
  return entry;
}

export async function peekQueue(hubRoot) {
  const queue = await loadQueue(hubRoot);
  const pending = queue.entries.filter((e) => e.status === "pending");
  if (pending.length === 0) return null;

  pending.sort((a, b) => priorityScore(a.priority) - priorityScore(b.priority) || a.createdAt.localeCompare(b.createdAt));
  return pending[0];
}

export async function updateEntry(hubRoot, entryId, patch = {}) {
  if (shouldUseRustRuntime()) return _rustUpdate(hubRoot, entryId, patch);
  const queue = await loadQueue(hubRoot);
  const entry = queue.entries.find((e) => e.id === entryId);
  if (!entry) return null;

  if (patch.status !== undefined) entry.status = patch.status;
  if (patch.metadata) entry.metadata = { ...entry.metadata, ...patch.metadata };
  if (patch.claimedBy !== undefined) entry.claimedBy = patch.claimedBy;
  if (patch.claimedAt !== undefined) entry.claimedAt = patch.claimedAt;
  if (patch.workerId !== undefined) entry.workerId = patch.workerId;
  entry.updatedAt = nowIso();

  await saveQueue(hubRoot, queue);
  return entry;
}

export async function listQueue(hubRoot, { status, projectId } = {}) {
  if (shouldUseRustRuntime()) return _rustList(hubRoot, { status, projectId });
  const queue = await loadQueue(hubRoot);
  return queue.entries.filter((e) => {
    if (status && e.status !== status) return false;
    if (projectId && e.projectId !== projectId) return false;
    return true;
  });
}

export async function syncBacklogResult(hubRoot, { projectId, description, result } = {}) {
  if (!projectId || !description) return { synced: 0, entries: [] };

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
}

export async function queueStatus(hubRoot) {
  if (shouldUseRustRuntime()) return _rustStatus(hubRoot);
  const queue = await loadQueue(hubRoot);
  const counts = { total: queue.entries.length, pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const e of queue.entries) {
    if (e.status === "pending") counts.pending++;
    else if (e.status === "in_progress") counts.inProgress++;
    else if (e.status === "completed") counts.completed++;
    else if (e.status === "failed") counts.failed++;
    else if (e.status === "cancelled") counts.cancelled++;
  }
  counts.projects = buildProjectQueueStatus(queue.entries);
  counts.activeProjects = Object.entries(counts.projects)
    .filter(([, ps]) => ps.activeMutating > 0)
    .map(([projectId, ps]) => ({ projectId, ...ps }));
  return counts;
}

export function isMutatingEntry(entry) {
  return entry.metadata?.mutating !== false;
}

export function buildProjectQueueStatus(entries) {
  const byProject = {};
  for (const e of entries) {
    if (!byProject[e.projectId]) {
      byProject[e.projectId] = {
        pending: 0, inProgress: 0, completed: 0, failed: 0, cancelled: 0,
        activeMutating: 0, busy: false, busyReason: null,
        claimedBy: null, claimedAt: null, workerId: null,
        activeEntryIds: [],
      };
    }
    const ps = byProject[e.projectId];
    if (e.status === "pending") ps.pending++;
    else if (e.status === "in_progress") ps.inProgress++;
    else if (e.status === "completed") ps.completed++;
    else if (e.status === "failed") ps.failed++;
    else if (e.status === "cancelled") ps.cancelled++;
    if (e.status === "in_progress" && isMutatingEntry(e)) {
      ps.activeMutating++;
      ps.activeEntryIds.push(e.id);
      ps.busy = true;
      ps.busyReason = "active-mutating-task";
      ps.claimedBy = e.claimedBy;
      ps.claimedAt = e.claimedAt;
      ps.workerId = e.workerId;
    }
  }
  return byProject;
}

function recoverStaleInProgress(entries, claimTimeoutMs) {
  if (!claimTimeoutMs || claimTimeoutMs <= 0) return { recovered: [] };
  const now = Date.now();
  const recovered = [];
  for (const e of entries) {
    if (e.status !== "in_progress") continue;
    const claimedAt = e.claimedAt ? new Date(e.claimedAt).getTime() : 0;
    if (!Number.isFinite(claimedAt) || now - claimedAt < claimTimeoutMs) continue;
    e.status = "pending";
    e.claimedBy = null;
    e.claimedAt = null;
    e.workerId = null;
    e.updatedAt = nowIso();
    recovered.push(e.id);
  }
  return { recovered };
}

export async function claimEligible(hubRoot, opts = {}) {
  const {
    workerId = `worker-${process.pid}`,
    projectId = null,
    maxActivePerProject = 1,
    claimTimeoutMs = 120_000,
    providerSlotsAvailable = true,
  } = opts;

  if (!providerSlotsAvailable) {
    return { entry: null, reason: "provider-slots-exhausted", recovered: [], activeProjects: [] };
  }

  const queue = await loadQueue(hubRoot);
  const { recovered } = recoverStaleInProgress(queue.entries, claimTimeoutMs);

  const activeMutatingByProject = {};
  for (const e of queue.entries) {
    if (e.status === "in_progress" && isMutatingEntry(e)) {
      activeMutatingByProject[e.projectId] = (activeMutatingByProject[e.projectId] || 0) + 1;
    }
  }

  let pending = queue.entries.filter((e) => e.status === "pending");
  if (projectId) pending = pending.filter((e) => e.projectId === projectId);

  pending.sort((a, b) => priorityScore(a.priority) - priorityScore(b.priority) || a.createdAt.localeCompare(b.createdAt));

  let chosen = null;
  let reason = null;
  const skippedBusy = [];

  for (const candidate of pending) {
    if (isMutatingEntry(candidate) && (activeMutatingByProject[candidate.projectId] || 0) >= maxActivePerProject) {
      if (!skippedBusy.includes(candidate.projectId)) skippedBusy.push(candidate.projectId);
      continue;
    }
    chosen = candidate;
    break;
  }

  if (!chosen) {
    const projectStatus = buildProjectQueueStatus(queue.entries);
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

  const projectStatus = buildProjectQueueStatus(queue.entries);
  const activeProjects = Object.entries(projectStatus)
    .filter(([, ps]) => ps.activeMutating > 0)
    .map(([pid, ps]) => ({ projectId: pid, ...ps }));

  return { entry: chosen, reason: null, recovered, activeProjects, skippedBusy };
}
