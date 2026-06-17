import { AnyRecord } from "../../shared/types.js";
import { AssignmentStore } from "../../shared/orchestrator/assignment-store.js";
import {
  DEFAULT_MAX_ACTIVE_PER_PROJECT,
  positiveInt,
  resolveHubConcurrencyLimits,
  resolveProjectConcurrencyLimits,
} from "../services/infra.js";
import {
  priorityScore,
  isMutatingEntry,
  isActiveEntry,
  recoverStaleInProgressAsync,
} from "../services/hub/hub-queue.js";
import { readHubConfig, readSchedulerConfig } from "../services/agent/agent-config.js";
import { ensureIndexFresh } from "../services/infra.js";
import { projectCapabilityMapGate } from "../services/project/project-index.js";
import { checkCodeGraphReady } from "../services/infra.js";

const CLAIM_TIMEOUT_MS = 120_000;

function nowIso() {
  return new Date().toISOString();
}

function providerAgentForEntry(entry: AnyRecord) {
  const agentSpec = entry.metadata?.agents?.executor || entry.metadata?.agents?.default || {};
  return agentSpec.agent || "claude";
}

function parseRetryUntilMs(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export class Scheduler {
  hubRoot: string;
  cpbRoot: string | null;
  assignments: AssignmentStore;
  workers: Record<string, any>; // any: worker store interface varies
  maxActivePerProject: number;
  getProjectFn: ((hubRoot: string, projectId: string) => Promise<AnyRecord | null>) | null;
  providerCapacityFn: ((agentKey: string, entry: AnyRecord) => Promise<{ available: number; total: number; providerKey?: string } | boolean>) | null;

  /**
   * @param {string} hubRoot
   * @param {object} opts
   * @param {object} opts.assignmentStore
   * @param {object} opts.workerStore
   * @param {string} [opts.cpbRoot]
   * @param {number} [opts.maxActivePerProject]
   * @param {Function} [opts.getProjectFn]
   * @param {Function} [opts.providerCapacityFn] - async (agentKey?, entry?) => { available: number, total: number } | boolean
   *   Object return values apply aggregate provider capacity; boolean return values filter per entry/provider.
   */
  constructor(hubRoot: string, {
    assignmentStore,
    workerStore,
    cpbRoot = null,
    maxActivePerProject = DEFAULT_MAX_ACTIVE_PER_PROJECT,
    getProjectFn = null,
    providerCapacityFn = null,
  }: AnyRecord) {
    this.hubRoot = hubRoot;
    this.cpbRoot = cpbRoot;
    this.assignments = assignmentStore;
    this.workers = workerStore;
    this.maxActivePerProject = positiveInt(maxActivePerProject, DEFAULT_MAX_ACTIVE_PER_PROJECT);
    this.getProjectFn = getProjectFn;
    this.providerCapacityFn = providerCapacityFn;
  }

  async _readMode() {
    const hubConfig = await readHubConfig(this.hubRoot);
    return readSchedulerConfig(hubConfig).mode;
  }

  /**
   * Recover stale entries and collect the pending pool.
   * Shared by nextCandidate() and nextCandidates().
   */
  async _preparePendingPool() {
    const { listQueue, updateEntry } = await import("../services/hub/hub-queue.js");
    const allEntries = await listQueue(this.hubRoot);

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

    return allEntries;
  }

  /**
   * Filter pending entries by DAG dependencies.
   * An entry is DAG-ready when all its declared dependencies are completed.
   */
  _filterDagReady(pending: AnyRecord[], allEntries: AnyRecord[]) {
    const completedIds = new Set(
      allEntries.filter(e => e.status === "completed").map(e => e.id),
    );
    return pending.filter(entry => {
      const deps = entry.metadata?.dependsOn;
      if (!deps || !Array.isArray(deps) || deps.length === 0) return true;
      return deps.every(depId => completedIds.has(depId));
    });
  }

  /**
   * Filter by provider capacity when providerCapacityFn is configured.
   * Returns entries that fit within remaining provider slots.
   * When provider is full, returns empty — queue, don't fail.
   */
  _filterByProviderCapacity(pending: AnyRecord[]) {
    return pending;
  }

  /**
   * Filter by per-project limits when NOT using provider-only capacity.
   */
  _filterByProjectCapacity(pending: AnyRecord[], activeMutatingByProject: Record<string, number>, projectLimits: Map<string, number>, hubLimits: AnyRecord) {
    return pending.filter(e => {
      if (isMutatingEntry(e)) {
        const projectLimit = projectLimits.get(e.projectId) ?? hubLimits.maxActivePerProject;
        if (projectLimit > 0 && (activeMutatingByProject[e.projectId] || 0) >= projectLimit) {
          return false;
        }
      }
      return true;
    });
  }

  _filterByRetryDecisionDue(pending: AnyRecord[]) {
    const now = Date.now();
    return pending.filter((entry) => {
      const untilMs = parseRetryUntilMs(entry.metadata?.retryDecision?.untilTs);
      return untilMs === null || untilMs <= now;
    });
  }

  /**
   * Find the next eligible pending queue entry.
   * Stale recovery goes through shared queue-rules (assignment-aware).
   */
  async nextCandidate() {
    const candidates = await this.nextCandidates(1);
    return candidates[0] || null;
  }

  /**
   * Find up to `batchSize` eligible pending queue entries.
   * DAG-ready: entries with unmet dependencies are excluded.
   * Provider-only capacity: when providerCapacityFn is set, scheduling
   * is gated by provider slots, not per-project caps.
   */
  async nextCandidates(batchSize = Infinity) {
    const allEntries = await this._preparePendingPool();
    let pending = allEntries.filter(e => e.status === "pending");

    pending = this._filterByRetryDecisionDue(pending);
    if (pending.length === 0) return [];

    // DAG dependency gate
    pending = this._filterDagReady(pending, allEntries);
    if (pending.length === 0) return [];

    pending = await this._applyProjectReadinessGate(pending);
    if (pending.length === 0) return [];

    if (!this.providerCapacityFn) {
      const hubLimits = await resolveHubConcurrencyLimits(this.hubRoot, {
        maxActivePerProject: this.maxActivePerProject,
      });
      const activeMutatingByProject: Record<string, number> = {};
      for (const entry of allEntries) {
        if (isActiveEntry(entry) && isMutatingEntry(entry)) {
          activeMutatingByProject[entry.projectId] = (activeMutatingByProject[entry.projectId] || 0) + 1;
        }
      }
      const projectLimits = await this.#resolveProjectLimits(allEntries, hubLimits.maxActivePerProject);
      pending = this._filterByProjectCapacity(pending, activeMutatingByProject, projectLimits, hubLimits);
    }

    if (pending.length === 0) return [];

    // Sort
    const mode = await this._readMode();
    if (mode === "smart") {
      const hubLimits = await resolveHubConcurrencyLimits(this.hubRoot, {
        maxActivePerProject: this.maxActivePerProject,
      });
      const activeMutatingByProject: Record<string, number> = {};
      for (const entry of allEntries) {
        if (isActiveEntry(entry) && isMutatingEntry(entry)) {
          activeMutatingByProject[entry.projectId] = (activeMutatingByProject[entry.projectId] || 0) + 1;
        }
      }
      const projectLimits = await this.#resolveProjectLimits(allEntries, hubLimits.maxActivePerProject);
      const selected = await this._smartSelect(pending, { activeMutatingByProject, projectLimits, hubLimits, allEntries });
      pending = selected ? [selected] : [];
    } else {
      pending.sort((a, b) => {
        const pa = priorityScore(a.priority);
        const pb = priorityScore(b.priority);
        if (pa !== pb) return pa - pb;
        return a.createdAt.localeCompare(b.createdAt);
      });
    }

    if (this.providerCapacityFn) {
      pending = await this._applyProviderCapacityGate(pending, allEntries, batchSize);
    }

    return pending.slice(0, batchSize);
  }

  async _applyProjectReadinessGate(pending: AnyRecord[]) {
    if (!this.getProjectFn) return pending;
    const eligible = [];
    for (const entry of pending) {
      const project = await this.getProjectFn(this.hubRoot, entry.projectId);
      if (!project) {
        const { updateEntry } = await import("../services/hub/hub-queue.js");
        const metadata = {
          ...(entry.metadata || {}),
          projectReadiness: {
            available: false,
            reason: "project_not_found",
          },
        };
        await updateEntry(this.hubRoot, entry.id, {
          status: "blocked",
          reason: `Project '${entry.projectId}' not found`,
          metadata,
        });
        entry.status = "blocked";
        entry.reason = `Project '${entry.projectId}' not found`;
        entry.metadata = metadata;
        continue;
      }

      if (!project.sourcePath || !project.projectRuntimeRoot) {
        await this._markCodegraphUnavailable(entry, {
          indexFreshness: {
            available: false,
            indexDirty: true,
            indexStale: false,
            worktreeDirty: false,
            dirtyReasons: ["missing_source_or_runtime_root"],
          },
        });
        continue;
      }

      const capabilityGate = projectCapabilityMapGate(project);
      if (!capabilityGate.available) {
        await this._markCodegraphUnavailable(entry, {
          capabilityMap: capabilityGate,
          indexFreshness: {
            available: false,
            indexDirty: true,
            indexStale: false,
            worktreeDirty: false,
            dirtyReasons: [capabilityGate.reason],
          },
        });
        continue;
      }

      let codegraphReadiness;
      try {
        codegraphReadiness = await checkCodeGraphReady({
          cpbRoot: this.cpbRoot || project.cpbRoot || project.metadata?.cpbRoot || project.sourcePath,
          sourcePath: project.sourcePath,
        });
      } catch (err) {
        const reason = err?.details?.reason || err?.code || "codegraph_unavailable";
        await this._markCodegraphUnavailable(entry, {
          codegraphReadiness: {
            available: false,
            reason,
            details: err?.details || null,
          },
          indexFreshness: {
            available: false,
            indexDirty: true,
            indexStale: false,
            worktreeDirty: false,
            dirtyReasons: [reason],
          },
        });
        continue;
      }

      const fresh = await ensureIndexFresh(project);
      if (!fresh.available) {
        await this._markCodegraphUnavailable(entry, {
          indexFreshness: {
            available: false,
            indexDirty: fresh.indexDirty ?? true,
            indexStale: fresh.indexStale ?? false,
            worktreeDirty: fresh.worktreeDirty ?? false,
            dirtyReasons: fresh.dirtyReasons ?? ["codegraph_unavailable"],
          },
        });
        continue;
      }

      const nextMetadata = {
        ...entry.metadata,
        codegraphReadiness: {
          available: true,
          sourcePath: codegraphReadiness.sourcePath,
          indexFile: codegraphReadiness.indexFile,
        },
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
      const { updateEntry } = await import("../services/hub/hub-queue.js");
      await updateEntry(this.hubRoot, entry.id, { metadata: nextMetadata });
      entry.metadata = nextMetadata;
      entry.indexSnapshotId = fresh.indexSnapshotId;
      eligible.push(entry);
    }
    return eligible;
  }

  async _markCodegraphUnavailable(entry: AnyRecord, metadataPatch: AnyRecord) {
    const metadata = { ...(entry.metadata || {}), ...metadataPatch };
    const { updateEntry } = await import("../services/hub/hub-queue.js");
    await updateEntry(this.hubRoot, entry.id, {
      status: "codegraph_unavailable",
      updatedAt: nowIso(),
      metadata,
    });
    entry.status = "codegraph_unavailable";
    entry.updatedAt = nowIso();
    entry.metadata = metadata;
  }

  /**
   * Apply provider capacity gate.
   * Supports the aggregate capacity contract and a per-entry boolean contract.
   * Returns up to `batchSize` eligible entries across all providers.
   */
  async _applyProviderCapacityGate(pending: AnyRecord[], allEntries: AnyRecord[], batchSize: number) {
    const first = pending[0];
    if (!first) return [];

    const capacity = await this.providerCapacityFn(providerAgentForEntry(first), first);
    if (typeof capacity === "boolean") {
      const eligible = [];
      if (capacity) eligible.push(first);
      for (const entry of pending.slice(1)) {
        if (eligible.length >= batchSize) break;
        if (await this.providerCapacityFn(providerAgentForEntry(entry), entry)) {
          eligible.push(entry);
        }
      }
      return eligible.slice(0, batchSize);
    }

    const eligible: AnyRecord[] = [];
    const projectedByProvider = new Map<string, number>();
    const fits = async (entry: AnyRecord, prechecked: { available: number; total: number; providerKey?: string } | null = null) => {
      const provider = providerAgentForEntry(entry);
      const cap = prechecked || await this.providerCapacityFn(provider, entry);
      if (!cap || typeof cap !== "object") return false;
      const providerKey = cap.providerKey || provider;
      const available = Number(cap.available ?? cap.total ?? 0);
      const total = Number(cap.total ?? available);
      const projected = projectedByProvider.get(providerKey) || 0;
      const remaining = Math.min(available, total) - projected;
      if (remaining <= 0) return false;
      projectedByProvider.set(providerKey, projected + 1);
      return true;
    };

    if (await fits(first, capacity)) eligible.push(first);
    for (const entry of pending.slice(1)) {
      if (eligible.length >= batchSize) break;
      if (await fits(entry)) eligible.push(entry);
    }
    return eligible.slice(0, batchSize);
  }

  /**
   * Smart scheduler: deterministic local scoring over eligible pending entries.
   * Considers priority, queue age/starvation, project pressure, failure metadata,
   * and provider quota state.
   */
  async _smartSelect(pending: AnyRecord[], ctx: AnyRecord) {
    const now = Date.now();

    // Gather provider quota state
    let providerQuotas: AnyRecord = {};
    try {
      const { readProviderQuotas } = await import("../services/provider-quota.js");
      providerQuotas = await readProviderQuotas(this.hubRoot);
    } catch { /* quotas unavailable — treat as all-available */ }

    // Count entries per project for pressure calculation
    const pendingByProject: Record<string, number> = {};
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

  async findIdleWorker(projectId: string) {
    return this.workers.findIdleWorker(projectId);
  }

  async #resolveProjectLimits(entries: AnyRecord[], maxActivePerProject: number) {
    const projectIds = [...new Set(entries.map((entry) => entry.projectId).filter(Boolean))];
    return resolveProjectConcurrencyLimits(this.hubRoot, projectIds, {
      maxActivePerProject,
      getProjectFn: this.getProjectFn,
    });
  }
}
