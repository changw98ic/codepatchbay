import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";
import { appendEvent } from "./event-store.js";

const EVENT_SOURCE_DIR = "event-sources";
const CANDIDATE_QUEUE_FILE = "candidates.json";

function sourceDir(cpbRoot) {
  return runtimeDataPath(cpbRoot, EVENT_SOURCE_DIR);
}

function candidateFile(cpbRoot) {
  return path.join(sourceDir(cpbRoot), CANDIDATE_QUEUE_FILE);
}

function generateId() {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeKey(source, externalId) {
  return `${source}:${externalId}`;
}

/**
 * Ingest an external event into the candidate queue.
 * Returns the created candidate entry.
 */
export async function ingestEvent(cpbRoot, event) {
  const {
    source,
    externalId,
    projectId,
    priority = "normal",
    payload = {},
    receivedAt,
  } = event;

  if (!source || !externalId) {
    throw new Error("ingestEvent requires source and externalId");
  }

  const dir = sourceDir(cpbRoot);
  await mkdir(dir, { recursive: true });

  const entry = {
    id: generateId(),
    source,
    externalId: String(externalId),
    projectId: projectId || null,
    priority,
    dedupeKey: dedupeKey(source, externalId),
    payload,
    receivedAt: receivedAt || new Date().toISOString(),
    status: "pending",
  };

  const file = candidateFile(cpbRoot);
  let queue = [];
  try {
    const raw = await readFile(file, "utf8");
    queue = JSON.parse(raw);
    if (!Array.isArray(queue)) queue = [];
  } catch {
    queue = [];
  }

  // Dedupe: skip if dedupeKey already exists
  if (queue.some((e) => e.dedupeKey === entry.dedupeKey)) {
    return { ...entry, status: "duplicate" };
  }

  queue.push(entry);
  await writeFile(file, JSON.stringify(queue, null, 2), "utf8");

  return entry;
}

/**
 * List candidate events, optionally filtered by status or source.
 */
export async function listCandidates(cpbRoot, { status, source } = {}) {
  const file = candidateFile(cpbRoot);
  let queue;
  try {
    const raw = await readFile(file, "utf8");
    queue = JSON.parse(raw);
    if (!Array.isArray(queue)) return [];
  } catch {
    return [];
  }

  return queue.filter((e) => {
    if (status && e.status !== status) return false;
    if (source && e.source !== source) return false;
    return true;
  });
}

/**
 * Update a candidate's status (pending → processed | dismissed).
 */
export async function updateCandidate(cpbRoot, candidateId, { status, reason }) {
  const file = candidateFile(cpbRoot);
  let queue;
  try {
    const raw = await readFile(file, "utf8");
    queue = JSON.parse(raw);
    if (!Array.isArray(queue)) return null;
  } catch {
    return null;
  }

  const entry = queue.find((e) => e.id === candidateId);
  if (!entry) return null;

  entry.status = status;
  if (reason) entry.statusReason = reason;
  entry.updatedAt = new Date().toISOString();

  await writeFile(file, JSON.stringify(queue, null, 2), "utf8");
  return entry;
}

/**
 * Normalize a GitHub issue into a candidate event.
 */
export function githubIssueToCandidate(issue, { projectId } = {}) {
  return {
    source: "github-issue",
    externalId: String(issue.number || issue.id),
    projectId: projectId || issue.projectId || null,
    priority: issue.labels?.some?.((l) => {
      const name = typeof l === "string" ? l : l.name;
      return name && /p0|critical|urgent|blocker/i.test(name);
    }) ? "high" : "normal",
    payload: {
      title: issue.title || `Issue #${issue.number}`,
      body: (issue.body || "").slice(0, 2000),
      labels: Array.isArray(issue.labels)
        ? issue.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean)
        : [],
      url: issue.url || null,
      state: issue.state || "OPEN",
    },
  };
}

/**
 * Normalize a CI failure into a candidate event.
 */
export function ciFailureToCandidate(failure, { projectId } = {}) {
  return {
    source: "ci-failure",
    externalId: failure.runId || failure.buildId || `ci-${Date.now()}`,
    projectId: projectId || null,
    priority: "high",
    payload: {
      workflow: failure.workflow || null,
      branch: failure.branch || null,
      commit: failure.commit || null,
      message: failure.message || "CI failure",
      url: failure.url || null,
    },
  };
}
