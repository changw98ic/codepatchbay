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
import { readHubConfig, readSchedulerConfig } from "../services/agent-config.js";

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

  async _readMode() {
    const hubConfig = await readHubConfig(this.hubRoot);
    return readSchedulerConfig(hubConfig).mode;
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

    const mode = await this._readMode();

    if (mode === "smart") {
      return this._smartSelect(pending, { activeMutatingByProject, projectLimits, hubLimits, allEntries });
    }

    // Default mode: sort by priority, then by creation time
    pending.sort((a, b) => {
      const pa = priorityScore(a.priority);
      const pb = priorityScore(b.priority);
      if (pa !== pb) return pa - pb;
      return a.createdAt.localeCompare(b.createdAt);
    });

    return pending[0];
  }

  /**
   * Smart scheduler: deterministic local scoring over eligible pending entries.
   * Considers priority, queue age/starvation, project pressure, failure metadata,
   * and provider quota state.
   */
  async _smartSelect(pending, ctx) {
    const now = Date.now();

    // Gather provider quota state
    let providerQuotas = {};
    try {
      const { readProviderQuotas } = await import("../services/provider-quota.js");
      providerQuotas = await readProviderQuotas(this.hubRoot);
    } catch { /* quotas unavailable — treat as all-available */ }

    // Count entries per project for pressure calculation
    const pendingByProject = {};
    for (const e of ctx.allEntries) {
      if (e.status === "pending") {
        pendingByProject[e.projectId] = (pendingByProject[e.projectId] || 0) + 1;
      }
    }

    const scored = pending.map(entry => {
      const reasons = [];
      let score = 0;

      // 1. Priority (lower = more urgent)
      const pScore = priorityScore(entry.priority);
      const priorityWeight = (3 - pScore) * 30;
      score += priorityWeight;
      if (pScore < 2) reasons.push(`priority:${entry.priority}`);

      // 2. Queue age / starvation — older entries score higher
      const createdMs = new Date(entry.createdAt).getTime();
      const ageMinutes = Math.max(0, (now - createdMs) / 60_000);
      const ageWeight = Math.min(ageMinutes * 2, 40);
      score += ageWeight;
      if (ageMinutes > 5) reasons.push(`age:${Math.round(ageMinutes)}m`);

      // 3. Active project pressure — prefer projects with fewer active tasks
      const activeForProject = ctx.activeMutatingByProject[entry.projectId] || 0;
      const projectLimit = (ctx.projectLimits.get(entry.projectId) ?? ctx.hubLimits.maxActivePerProject);
      const pressureRatio = projectLimit > 0 ? activeForProject / projectLimit : 0;
      const pressureWeight = Math.round((1 - pressureRatio) * 15);
      score += pressureWeight;
      if (pressureRatio === 0) reasons.push("no-active-pressure");

      // 4. Recent retry / failure metadata
      const meta = entry.metadata || {};
      const lastFailure = meta.lastFailureKind || "";
      if (lastFailure === "verification_failed") {
        score += 5;
        reasons.push("verification_failed-boost");
      } else if (lastFailure === "assignment_progress_stale") {
        score += 5;
        reasons.push("progress_stale-boost");
      } else if (lastFailure === "timeout") {
        score += 3;
        reasons.push("timeout-boost");
      }

      // Previous failure count penalty — avoid thrashing
      const failureCount = meta.failureCount || 0;
      if (failureCount > 0) {
        score -= Math.min(failureCount * 4, 20);
        reasons.push(`failures:${failureCount}`);
      }

      // 5. Provider quota/rate-limit state
      const agentSpec = meta.agents?.executor || meta.agents?.default || {};
      const providerKey = agentSpec.agent || "claude";
      const quota = providerQuotas[providerKey];
      if (quota && quota.status !== "available") {
        if (quota.nextEligibleAt && quota.nextEligibleAt > now) {
          score -= 10;
          reasons.push(`provider:${quota.status}`);
        }
      }

      // 6. Phase agent info — entries with configured agents are slightly preferred
      if (meta.agents && Object.keys(meta.agents).length > 0) {
        score += 2;
      }

      return { entry, score, reasons };
    });

    // Sort by score descending, break ties by createdAt ascending
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.entry.createdAt.localeCompare(b.entry.createdAt);
    });

    const winner = scored[0];
    if (!winner) return null;

    // Attach scheduler decision metadata
    winner.entry.metadata = {
      ...(winner.entry.metadata || {}),
      schedulerDecision: {
        mode: "smart",
        selectedAt: new Date().toISOString(),
        score: winner.score,
        reasons: winner.reasons,
      },
    };

    return winner.entry;
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
