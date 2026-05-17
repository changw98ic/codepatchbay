import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

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

  const queue = await loadQueue(hubRoot);
  const key = entryKey(input);
  const existing = queue.entries.find((e) => entryKey(e) === key && e.status === "pending");
  if (existing) return existing;

  const entry = {
    id: generateId(),
    projectId: input.projectId,
    sourcePath: input.sourcePath || "",
    sessionId: input.sessionId || "",
    executionBoundary: input.executionBoundary || "source",
    type: input.type || "candidate",
    status: "pending",
    priority: input.priority || "P2",
    description: input.description || "",
    metadata: input.metadata || {},
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
  const queue = await loadQueue(hubRoot);
  const entry = queue.entries.find((e) => e.id === entryId);
  if (!entry) return null;

  if (patch.status !== undefined) entry.status = patch.status;
  if (patch.metadata) entry.metadata = { ...entry.metadata, ...patch.metadata };
  if (patch.claimedBy !== undefined) entry.claimedBy = patch.claimedBy;
  entry.updatedAt = nowIso();

  await saveQueue(hubRoot, queue);
  return entry;
}

export async function listQueue(hubRoot, { status, projectId } = {}) {
  const queue = await loadQueue(hubRoot);
  return queue.entries.filter((e) => {
    if (status && e.status !== status) return false;
    if (projectId && e.projectId !== projectId) return false;
    return true;
  });
}

export async function queueStatus(hubRoot) {
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
