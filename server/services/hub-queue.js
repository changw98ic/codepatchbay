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
  return `${entry.projectId}::${entry.description}`;
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
  const key = `${projectId}::${description}`;

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
  return counts;
}
