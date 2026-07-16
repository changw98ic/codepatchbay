import { LooseRecord } from "../../shared/types.js";
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

type QueueEntryInputForScheduler = Parameters<typeof isMutatingEntry>[0];
type QueueEntryForScheduler = Parameters<typeof recoverStaleInProgressAsync>[0][number];
type QueueMetadataForScheduler = NonNullable<QueueEntryInputForScheduler["metadata"]>;

type SchedulerAgentSpec = LooseRecord & {
  agent?: string;
};

type SchedulerAgents = LooseRecord & {
  executor?: SchedulerAgentSpec;
  default?: SchedulerAgentSpec;
};

type RetryDecision = {
  untilTs?: unknown;
};

type RetryEvidence = LooseRecord & {
  retryStrategy?: unknown;
  failureFingerprint?: unknown;
  failureClass?: unknown;
};

type SchedulerMetadata = QueueMetadataForScheduler & {
  agents?: SchedulerAgents;
  dependsOn?: string[];
  retryDecision?: RetryDecision;
  sourceContext?: LooseRecord & { retry?: RetryEvidence };
  lastFailureKind?: string;
  failureCount?: number;
};

type SchedulerEntry = QueueEntryForScheduler & {
  id: string;
  projectId: string;
  status?: string;
  priority?: string;
  createdAt: string;
  claimedAt?: string | null;
  updatedAt?: string;
  reason?: string;
  indexSnapshotId?: string | null;
  metadata?: SchedulerMetadata;
};

type ProjectRecord = LooseRecord & {
  sourcePath?: string;
  projectRuntimeRoot?: string;
  cpbRoot?: string;
  metadata?: LooseRecord & { cpbRoot?: string };
};

type ProviderCapacity = {
  available: number;
  total: number;
  providerKey?: string;
};

type ProviderCapacityFn = (agentKey: string, entry: SchedulerEntry) => Promise<ProviderCapacity | boolean>;

type WorkerStoreLike = {
  findIdleWorker(projectId?: string): Promise<LooseRecord | null>;
};

type SchedulerOptions = {
  assignmentStore: AssignmentStore;
  workerStore: WorkerStoreLike;
  cpbRoot?: string | null;
  maxActivePerProject?: number;
  getProjectFn?: ((hubRoot: string, projectId: string) => Promise<ProjectRecord | null>) | null;
  providerCapacityFn?: ProviderCapacityFn | null;
};

type SmartSelectContext = {
  activeMutatingByProject: Record<string, number>;
  projectLimits: Map<string, number>;
  hubLimits: { maxActivePerProject: number };
  allEntries: SchedulerEntry[];
};

function nowIso() {
  return new Date().toISOString();
}

function recordValue(value: unknown): LooseRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function providerAgentForEntry(entry: SchedulerEntry) {
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
  workers: WorkerStoreLike;
  maxActivePerProject: number;
  getProjectFn: ((hubRoot: string, projectId: string) => Promise<ProjectRecord | null>) | null;
  providerCapacityFn: ProviderCapacityFn | null;

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
  }: SchedulerOptions) {
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
    const allEntries = await listQueue(this.hubRoot) as SchedulerEntry[];
    const recoveryGuards = new Map(allEntries.map((entry) => [entry.id, {
      expectedStatus: entry.status,
      expectedClaimedAt: entry.claimedAt ?? null,
      expectedUpdatedAt: entry.updatedAt ?? null,
    }]));

    const { recovered, refreshed } = await recoverStaleInProgressAsync(allEntries, {
      claimTimeoutMs: CLAIM_TIMEOUT_MS,
      assignmentStore: this.assignments,
    });
    for (const id of recovered) {
      await updateEntry(
        this.hubRoot,
        id,
        { status: "pending", claimedBy: null, claimedAt: null },
        recoveryGuards.get(id),
      );
    }
    for (const id of refreshed) {
      const entry = allEntries.find((e) => e.id === id);
      if (entry) {
        await updateEntry(
          this.hubRoot,
          id,
          { claimedAt: entry.claimedAt },
          recoveryGuards.get(id),
        );
      }
    }

    // Recovery mutates the in-memory snapshot. Re-read so a failed CAS cannot
    // leak stale scheduler state into candidate selection.
    return await listQueue(this.hubRoot) as SchedulerEntry[];
  }

  /**
   * Filter pending entries by DAG dependencies.
   * An entry is DAG-ready when all its declared dependencies are completed.
   */
  _filterDagReady(pending: SchedulerEntry[], allEntries: SchedulerEntry[]) {
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
  _filterByProviderCapacity(pending: SchedulerEntry[]) {
    return pending;
  }

  /** Filter entries whose project already has no remaining mutating capacity. */
  _filterByProjectCapacity(pending: SchedulerEntry[], activeMutatingByProject: Record<string, number>, projectLimits: Map<string, number>, hubLimits: { maxActivePerProject: number }) {
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

  /** Reserve remaining project slots across the candidate batch. */
  _reserveProjectCapacity(pending: SchedulerEntry[], activeMutatingByProject: Record<string, number>, projectLimits: Map<string, number>, hubLimits: { maxActivePerProject: number }) {
    const reservedByProject: Record<string, number> = {};
    return pending.filter((entry) => {
      if (!isMutatingEntry(entry)) return true;
      const projectLimit = projectLimits.get(entry.projectId) ?? hubLimits.maxActivePerProject;
      if (projectLimit <= 0) return true;
      const projected = (activeMutatingByProject[entry.projectId] || 0)
        + (reservedByProject[entry.projectId] || 0);
      if (projected >= projectLimit) return false;
      reservedByProject[entry.projectId] = (reservedByProject[entry.projectId] || 0) + 1;
      return true;
    });
  }

  _filterByRetryDecisionDue(pending: SchedulerEntry[]) {
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
   * Provider capacity and per-project capacity are independent safety gates.
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

    if (pending.length === 0) return [];

    // Sort
    const mode = await this._readMode();
    if (mode === "smart") {
      pending = await this._smartRank(pending, { activeMutatingByProject, projectLimits, hubLimits, allEntries });
    } else {
      pending.sort((a, b) => {
        const pa = priorityScore(a.priority);
        const pb = priorityScore(b.priority);
        if (pa !== pb) return pa - pb;
        return a.createdAt.localeCompare(b.createdAt);
      });
    }

    if (this.providerCapacityFn) {
      pending = await this._applyProviderCapacityGate(
        pending,
        allEntries,
        Number.POSITIVE_INFINITY,
      );
    }

    pending = this._reserveProjectCapacity(
      pending,
      activeMutatingByProject,
      projectLimits,
      hubLimits,
    );

    return pending.slice(0, batchSize);
  }

  async _applyProjectReadinessGate(pending: SchedulerEntry[]) {
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
        const updated = await updateEntry(this.hubRoot, entry.id, {
          status: "blocked",
          reason: `Project '${entry.projectId}' not found`,
          metadata,
        }, {
          expectedStatus: "pending",
          expectedUpdatedAt: entry.updatedAt ?? null,
        });
        if (!updated) continue;
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
        const errorInfo = recordValue(err);
        const details = recordValue(errorInfo.details);
        const reason = String(details.reason || errorInfo.code || "codegraph_unavailable");
        await this._markCodegraphUnavailable(entry, {
          codegraphReadiness: {
            available: false,
            reason,
            details: Object.keys(details).length > 0 ? details : null,
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
      const updated = await updateEntry(this.hubRoot, entry.id, { metadata: nextMetadata }, {
        expectedStatus: "pending",
        expectedUpdatedAt: entry.updatedAt ?? null,
      });
      if (!updated) continue;
      entry.metadata = nextMetadata;
      entry.indexSnapshotId = fresh.indexSnapshotId;
      entry.updatedAt = typeof updated.updatedAt === "string" ? updated.updatedAt : entry.updatedAt;
      eligible.push(entry);
    }
    return eligible;
  }

  async _markCodegraphUnavailable(entry: SchedulerEntry, metadataPatch: SchedulerMetadata) {
    const metadata = { ...(entry.metadata || {}), ...metadataPatch };
    const { updateEntry } = await import("../services/hub/hub-queue.js");
    const updated = await updateEntry(this.hubRoot, entry.id, {
      status: "codegraph_unavailable",
      updatedAt: nowIso(),
      metadata,
    }, {
      expectedStatus: "pending",
      expectedUpdatedAt: entry.updatedAt ?? null,
    });
    if (!updated) return false;
    entry.status = "codegraph_unavailable";
    entry.updatedAt = nowIso();
    entry.metadata = metadata;
    return true;
  }

  /**
   * Apply provider capacity gate.
   * Supports the aggregate capacity contract and a per-entry boolean contract.
   * Returns up to `batchSize` eligible entries across all providers.
   */
  async _applyProviderCapacityGate(pending: SchedulerEntry[], allEntries: SchedulerEntry[], batchSize: number) {
    const first = pending[0];
    if (!first || !this.providerCapacityFn) return [];

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

    const eligible: SchedulerEntry[] = [];
    const projectedByProvider = new Map<string, number>();
    const fits = async (entry: SchedulerEntry, prechecked: ProviderCapacity | null = null) => {
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
  async _smartRank(pending: SchedulerEntry[], ctx: SmartSelectContext) {
    const now = Date.now();

    // Gather provider quota state
    let providerQuotas: LooseRecord = {};
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
      const reasons: string[] = [];
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
      const retryEvidence = meta.sourceContext?.retry || {};
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

      // A fresh attempt is useful only when it carries a concrete strategy
      // change and a stable failure fingerprint. This prevents blind retries
      // from outranking first attempts while still prioritizing actionable
      // near-complete work.
      const retryStrategy = typeof retryEvidence.retryStrategy === "string"
        ? retryEvidence.retryStrategy
        : null;
      const failureFingerprint = typeof retryEvidence.failureFingerprint === "string"
        ? retryEvidence.failureFingerprint
        : null;
      if ((retryStrategy?.startsWith("fresh_session") || retryStrategy === "fresh_attempt") && failureFingerprint) {
        score += 4;
        reasons.push(retryStrategy === "fresh_attempt" ? "evidence-backed-fresh-attempt" : "evidence-backed-fresh-session");
      } else if (retryStrategy && failureFingerprint) {
        score += 2;
        reasons.push(`evidence-backed-retry:${retryStrategy}`);
      } else if (retryStrategy || failureFingerprint) {
        score -= 3;
        reasons.push("incomplete-retry-evidence");
      }

      // 5. Provider quota/rate-limit state
      const agentSpec = meta.agents?.executor || meta.agents?.default || {};
      const providerKey = agentSpec.agent || "claude";
      const quota = recordValue(providerQuotas[providerKey]);
      if (quota && quota.status !== "available") {
        const nextEligibleAt = parseRetryUntilMs(quota.nextEligibleAt);
        if (nextEligibleAt !== null && nextEligibleAt > now) {
          score -= 10;
          reasons.push(`provider:${String(quota.status)}`);
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

    const selectedAt = new Date().toISOString();
    return scored.map(({ entry, score, reasons }, index) => {
      const retryEvidence = entry.metadata?.sourceContext?.retry || {};
      entry.metadata = {
        ...(entry.metadata || {}),
        schedulerDecision: {
          mode: "smart",
          selectedAt,
          rank: index + 1,
          score,
          reasons,
          retryStrategy: typeof retryEvidence.retryStrategy === "string" ? retryEvidence.retryStrategy : null,
          failureFingerprint: typeof retryEvidence.failureFingerprint === "string" ? retryEvidence.failureFingerprint : null,
          failureClass: typeof retryEvidence.failureClass === "string" ? retryEvidence.failureClass : null,
        },
      };
      return entry;
    });
  }

  async findIdleWorker(projectId: string) {
    return this.workers.findIdleWorker(projectId);
  }

  async #resolveProjectLimits(entries: SchedulerEntry[], maxActivePerProject: number) {
    const projectIds = [...new Set(entries.map((entry) => entry.projectId).filter(Boolean))];
    return resolveProjectConcurrencyLimits(this.hubRoot, projectIds, {
      maxActivePerProject,
      getProjectFn: this.getProjectFn,
    });
  }
}
