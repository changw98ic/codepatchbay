import { AssignmentStore } from "../../shared/orchestrator/assignment-store.js";
import {
  DEFAULT_MAX_ACTIVE_PER_PROJECT,
  positiveInt,
  resolveHubConcurrencyLimits,
  resolveProjectConcurrencyLimits,
} from "../services/concurrency-limits.js";
import {
  priorityScore,
  isMutatingEntry,
  isActiveEntry,
  recoverStaleInProgressAsync,
} from "../services/queue-rules.js";

const CLAIM_TIMEOUT_MS = 120_000;

export class Scheduler {
  constructor(hubRoot, {
    assignmentStore,
    workerStore,
    maxActivePerProject = DEFAULT_MAX_ACTIVE_PER_PROJECT,
    getProjectFn = null,
  }) {
    this.hubRoot = hubRoot;
    this.assignments = assignmentStore;
    this.workers = workerStore;
    this.maxActivePerProject = positiveInt(maxActivePerProject, DEFAULT_MAX_ACTIVE_PER_PROJECT);
    this.getProjectFn = getProjectFn;
  }

  /**
   * Find the next eligible pending queue entry.
   * Stale recovery goes through shared queue-rules (assignment-aware).
   */
  async nextCandidate() {
    const { listQueue, updateEntry } = await import("../services/hub-queue.js");
    const allEntries = await listQueue(this.hubRoot);

    // Recover stale entries — shared rule checks assignment state before resetting
    const { recovered, refreshed } = await recoverStaleInProgressAsync(allEntries, {
      claimTimeoutMs: CLAIM_TIMEOUT_MS,
      assignmentStore: this.assignments,
    });
    for (const id of recovered) {
      await updateEntry(this.hubRoot, id, { status: "pending", claimedBy: null, claimedAt: null });
    }
    for (const id of refreshed) {
      const entry = allEntries.find((e) => e.id === id);
      if (entry) await updateEntry(this.hubRoot, id, { claimedAt: entry.claimedAt });
    }

    const hubLimits = await resolveHubConcurrencyLimits(this.hubRoot, {
      maxActivePerProject: this.maxActivePerProject,
    });

    // Compute active mutating count per project
    const activeMutatingByProject = {};
    for (const entry of allEntries) {
      if (isActiveEntry(entry) && isMutatingEntry(entry)) {
        activeMutatingByProject[entry.projectId] = (activeMutatingByProject[entry.projectId] || 0) + 1;
      }
    }

    const projectLimits = await this.#resolveProjectLimits(allEntries, hubLimits.maxActivePerProject);

    // Filter eligible pending entries
    const pending = allEntries
      .filter(e => e.status === "pending")
      .filter(e => {
        if (isMutatingEntry(e)) {
          const projectLimit = projectLimits.get(e.projectId) ?? hubLimits.maxActivePerProject;
          if (projectLimit > 0 && (activeMutatingByProject[e.projectId] || 0) >= projectLimit) {
            return false;
          }
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

  async findIdleWorker(projectId) {
    return this.workers.findIdleWorker(projectId);
  }

  async #resolveProjectLimits(entries, maxActivePerProject) {
    const projectIds = [...new Set(entries.map((entry) => entry.projectId).filter(Boolean))];
    return resolveProjectConcurrencyLimits(this.hubRoot, projectIds, {
      maxActivePerProject,
      getProjectFn: this.getProjectFn,
    });
  }
}
