import { AssignmentStore } from "./assignment-store.js";

const DEFAULT_MAX_ACTIVE_PER_PROJECT = 1;
const CLAIM_TIMEOUT_MS = 120_000;

export class Scheduler {
  constructor(hubRoot, { assignmentStore, workerStore }) {
    this.hubRoot = hubRoot;
    this.assignments = assignmentStore;
    this.workers = workerStore;
  }

  /**
   * Find the next eligible pending queue entry.
   * Ports key gates from claimEligible (P1-9 fix):
   *  - Concurrency: max active mutating tasks per project
   *  - Stale recovery: reset in_progress entries past claim timeout
   *  - Priority sorting: P0 > P1 > P2 > P3, then by creation time
   */
  async nextCandidate() {
    const { listQueue, updateEntry } = await import("../services/hub-queue.js");
    const allEntries = await listQueue(this.hubRoot);

    // Recover stale in_progress entries
    const now = Date.now();
    for (const entry of allEntries) {
      if (entry.status !== "in_progress" && entry.status !== "scheduled") continue;
      const claimedAt = entry.claimedAt ? new Date(entry.claimedAt).getTime() : 0;
      if (claimedAt > 0 && now - claimedAt > CLAIM_TIMEOUT_MS) {
        await updateEntry(this.hubRoot, entry.id, {
          status: "pending",
          claimedBy: null,
          claimedAt: null,
        });
        entry.status = "pending";
      }
    }

    // Compute active mutating count per project
    const activeMutatingByProject = {};
    for (const entry of allEntries) {
      if ((entry.status === "in_progress" || entry.status === "scheduled") && isMutatingEntry(entry)) {
        activeMutatingByProject[entry.projectId] = (activeMutatingByProject[entry.projectId] || 0) + 1;
      }
    }

    // Filter eligible pending entries
    const pending = allEntries
      .filter(e => e.status === "pending")
      .filter(e => {
        // Concurrency gate: skip if project already at capacity
        if (isMutatingEntry(e) && (activeMutatingByProject[e.projectId] || 0) >= DEFAULT_MAX_ACTIVE_PER_PROJECT) {
          return false;
        }
        return true;
      });

    if (pending.length === 0) return null;

    // Sort by priority, then by creation time
    pending.sort((a, b) => {
      const pa = priorityScore(a.priority);
      const pb = priorityScore(b.priority);
      if (pa !== pb) return pa - pb;
      return a.createdAt.localeCompare(b.createdAt);
    });

    return pending[0];
  }

  /**
   * Check if an idle worker exists for the given project.
   */
  async findIdleWorker(projectId) {
    return this.workers.findIdleWorker(projectId);
  }
}

function priorityScore(p) {
  const map = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return map[p] ?? 2;
}

function isMutatingEntry(entry) {
  return entry.metadata?.mutating !== false;
}
