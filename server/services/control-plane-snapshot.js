/**
 * Control Plane Snapshot — read-only view of worker/provider/assignment state.
 *
 * Aggregates data from WorkerStore, assignment directories, and queue to
 * produce a single snapshot object explaining current runtime state.
 * No side effects; purely observational.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const HEARTBEAT_STALE_MS = 60_000;
const ASSIGNMENT_STALE_MS = 300_000; // 5 min no heartbeat update → stale

function nowMs() {
  return Date.now();
}

function age(isoStr) {
  if (!isoStr) return null;
  const ms = nowMs() - new Date(isoStr).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function classifyWorker(worker) {
  const hbAge = age(worker.lastHeartbeatAt);
  const status = worker.status || "unknown";
  const stale = hbAge !== null && hbAge > HEARTBEAT_STALE_MS;
  return {
    workerId: worker.workerId,
    status,
    pid: worker.pid || null,
    projectId: worker.projectId || null,
    currentAssignmentId: worker.currentAssignmentId || null,
    restartCount: worker.restartCount || 0,
    startedAt: worker.startedAt || null,
    lastHeartbeatAt: worker.lastHeartbeatAt || null,
    heartbeatAgeMs: hbAge,
    stale,
    stopReason: worker.stopReason || null,
    exitCode: worker.exitCode ?? null,
  };
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Scan assignments dir for active attempts and their heartbeat state.
 */
async function scanAssignments(hubRoot) {
  const assignmentsDir = path.join(hubRoot, "assignments");
  let assignmentDirs;
  try {
    assignmentDirs = await readdir(assignmentsDir);
  } catch {
    return [];
  }

  const results = [];
  for (const assignmentId of assignmentDirs) {
    if (assignmentId.startsWith(".")) continue;
    const attemptsDir = path.join(assignmentsDir, assignmentId, "attempts");
    let attemptDirs;
    try {
      attemptDirs = await readdir(attemptsDir);
    } catch {
      continue;
    }

    for (const attemptName of attemptDirs.sort().reverse()) {
      const attemptDir = path.join(attemptsDir, attemptName);
      const heartbeat = await readJsonSafe(path.join(attemptDir, "heartbeat.json"));
      const result = await readJsonSafe(path.join(attemptDir, "result.json"));
      const accepted = await readJsonSafe(path.join(attemptDir, "accepted.json"));
      const worktree = await readJsonSafe(path.join(attemptDir, "worktree.json"));

      const hbAge = heartbeat ? age(heartbeat.updatedAt) : null;
      const progressAge = heartbeat ? age(heartbeat.progressUpdatedAt) : null;
      const isStale = hbAge !== null && hbAge > ASSIGNMENT_STALE_MS;
      const isNoProgress = progressAge !== null && progressAge > ASSIGNMENT_STALE_MS;

      results.push({
        assignmentId,
        attempt: parseInt(attemptName, 10) || attemptName,
        status: result?.status || heartbeat?.status || accepted?.status || "unknown",
        workerId: heartbeat?.workerId || accepted?.workerId || null,
        phase: heartbeat?.phase || null,
        activePhase: heartbeat?.activePhase || null,
        activeJobId: heartbeat?.activeJobId || null,
        progressKind: heartbeat?.progressKind || null,
        lastProgressType: heartbeat?.lastProgressType || null,
        heartbeatAgeMs: hbAge,
        progressAgeMs: progressAge,
        stale: isStale,
        noProgress: isNoProgress,
        worktreePath: worktree?.worktreePath || heartbeat?.worktreePath || null,
        acceptedAt: accepted?.acceptedAt || null,
        hasResult: Boolean(result),
      });

      // Only report the latest attempt
      break;
    }
  }

  return results;
}

/**
 * Read the queue to get pending entries.
 */
async function scanQueue(hubRoot) {
  const queueFile = path.join(hubRoot, "queue", "queue.json");
  const queue = await readJsonSafe(queueFile);
  if (!queue?.entries) return [];

  return queue.entries.map((entry) => ({
    entryId: entry.id,
    projectId: entry.projectId,
    status: entry.status || "pending",
    priority: entry.priority || null,
    description: entry.description || null,
    type: entry.type || null,
    createdAt: entry.createdAt || null,
  }));
}

/**
 * Produce a full control-plane snapshot.
 *
 * @param {object} opts
 * @param {string} opts.hubRoot - path to hub data root
 * @param {import("../../shared/orchestrator/worker-store.js").WorkerStore} opts.workerStore
 * @returns {Promise<{ts: string, workers: object[], assignments: object[], queue: object[], summary: object}>}
 */
export async function takeControlPlaneSnapshot({ hubRoot, workerStore } = {}) {
  if (!hubRoot) throw new Error("hubRoot is required");
  if (!workerStore) throw new Error("workerStore is required");

  const [rawWorkers, assignments, queue] = await Promise.all([
    workerStore.listWorkers(),
    scanAssignments(hubRoot),
    scanQueue(hubRoot),
  ]);

  const workers = rawWorkers.map(classifyWorker);

  const summary = {
    totalWorkers: workers.length,
    workersByStatus: {},
    staleWorkers: workers.filter((w) => w.stale).length,
    totalAssignments: assignments.length,
    activeAssignments: assignments.filter((a) => a.status === "running" || a.status === "starting").length,
    staleAssignments: assignments.filter((a) => a.stale).length,
    noProgressAssignments: assignments.filter((a) => a.noProgress).length,
    pendingQueueEntries: queue.filter((e) => e.status === "pending" || e.status === "ready").length,
  };

  for (const w of workers) {
    summary.workersByStatus[w.status] = (summary.workersByStatus[w.status] || 0) + 1;
  }

  return {
    ts: new Date().toISOString(),
    workers,
    assignments,
    queue,
    summary,
  };
}
