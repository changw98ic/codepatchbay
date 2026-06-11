// @ts-nocheck
/**
 * Single source of truth for queue claim / stale-recovery rules.
 * Scheduler, claimEligible API, and any future caller all go through here.
 */

export function priorityScore(priority) {
  if (priority === "P0") return 0;
  if (priority === "P1") return 1;
  if (priority === "P2") return 2;
  return 3;
}

export function isMutatingEntry(entry) {
  return entry.metadata?.mutating !== false;
}

export function isActiveEntry(entry) {
  return entry.status === "in_progress" || entry.status === "scheduled";
}

export function clearClaim(entry) {
  entry.claimedBy = null;
  entry.claimedAt = null;
  entry.workerId = null;
}

function nowIso() {
  return new Date().toISOString();
}

export function isCodegraphUnavailableStatus(status) {
  return status === "codegraph_unavailable" || status === "index_unavailable";
}

/**
 * Recover stale in_progress / scheduled entries (sync variant).
 *
 * Requires an assignmentStore — entries with an active assignment
 * (status "running" or "assigned") get their claimedAt refreshed
 * instead of being reset to pending.
 *
 * @param {Array} entries  — mutable queue entries array
 * @param {object} opts
 * @param {number} opts.claimTimeoutMs
 * @param {import("../../shared/orchestrator/assignment-store.js").AssignmentStore} opts.assignmentStore
 * @returns {{ recovered: string[], refreshed: string[] }}
 */
export function recoverStaleInProgress(entries, opts) {
  const { claimTimeoutMs, assignmentStore } = opts;
  if (!claimTimeoutMs || claimTimeoutMs <= 0) return { recovered: [], refreshed: [] };
  if (!assignmentStore) throw new Error("recoverStaleInProgress requires assignmentStore");

  const now = Date.now();
  const recovered = [];
  const refreshed = [];

  for (const e of entries) {
    if (e.status !== "in_progress" && e.status !== "scheduled") continue;
    const claimedAt = e.claimedAt ? new Date(e.claimedAt).getTime() : 0;
    if (!Number.isFinite(claimedAt) || now - claimedAt < claimTimeoutMs) continue;

    const assignmentId = `a-${e.id}`;
    const assignment = assignmentStore.getAssignmentSync
      ? assignmentStore.getAssignmentSync(assignmentId)
      : null;
    if (assignment && (assignment.status === "running" || assignment.status === "assigned")) {
      e.claimedAt = nowIso();
      e.updatedAt = nowIso();
      refreshed.push(e.id);
      continue;
    }

    // No active assignment — safe to reset
    e.status = "pending";
    clearClaim(e);
    e.updatedAt = nowIso();
    recovered.push(e.id);
  }
  return { recovered, refreshed };
}

/**
 * Async variant for callers that have an AssignmentStore with async getAssignment().
 * Used by Scheduler and claimEligible.  assignmentStore is required.
 */
export async function recoverStaleInProgressAsync(entries, opts) {
  const { claimTimeoutMs, assignmentStore } = opts;
  if (!claimTimeoutMs || claimTimeoutMs <= 0) return { recovered: [], refreshed: [] };
  if (!assignmentStore) throw new Error("recoverStaleInProgressAsync requires assignmentStore");

  const now = Date.now();
  const recovered = [];
  const refreshed = [];

  for (const e of entries) {
    if (e.status !== "in_progress" && e.status !== "scheduled") continue;
    const claimedAt = e.claimedAt ? new Date(e.claimedAt).getTime() : 0;
    if (!Number.isFinite(claimedAt) || now - claimedAt < claimTimeoutMs) continue;

    const assignment = await assignmentStore.getAssignment(`a-${e.id}`);
    if (assignment && (assignment.status === "running" || assignment.status === "assigned")) {
      // Active assignment — refresh claimedAt so next tick doesn't re-trigger
      e.claimedAt = nowIso();
      e.updatedAt = nowIso();
      refreshed.push(e.id);
      continue;
    }

    // No active assignment — safe to reset
    e.status = "pending";
    clearClaim(e);
    e.updatedAt = nowIso();
    recovered.push(e.id);
  }
  return { recovered, refreshed };
}

/**
 * Recover codegraph_unavailable entries whose retry window has elapsed.
 */
export function recoverCodegraphUnavailable(entries, retryMs) {
  if (!retryMs || retryMs <= 0) return { recovered: [] };
  const now = Date.now();
  const recovered = [];
  for (const e of entries) {
    if (!isCodegraphUnavailableStatus(e.status)) continue;
    const updatedAt = e.updatedAt ? new Date(e.updatedAt).getTime() : 0;
    if (!Number.isFinite(updatedAt) || now - updatedAt < retryMs) continue;
    e.status = "pending";
    e.updatedAt = nowIso();
    if (e.metadata) delete e.metadata.indexFreshness;
    recovered.push(e.id);
  }
  return { recovered };
}
