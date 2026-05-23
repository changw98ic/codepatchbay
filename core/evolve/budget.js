/**
 * Per-run budget tracker for guarded-repair mode.
 *
 * Tracks issue count against a configurable ceiling.  The tracker is a
 * plain object so it can be serialized into history entries and result
 * payloads without any class instance overhead.
 */

/**
 * Create a fresh budget tracker.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxIssues=0] - Max issues allowed (0 = unlimited)
 * @returns {{ maxIssues: number, used: number, remaining: number, stopReason: string|null }}
 */
export function createBudget(opts = {}) {
  const maxIssues = opts.maxIssues || 0;
  return { maxIssues, used: 0, remaining: maxIssues > 0 ? maxIssues : Infinity, stopReason: null };
}

/**
 * Try to consume one budget slot.
 *
 * @param {object} budget - Tracker returned by createBudget
 * @returns {{ ok: boolean, budget: object }}
 */
export function consume(budget) {
  if (budget.maxIssues > 0 && budget.used >= budget.maxIssues) {
    return { ok: false, budget: { ...budget, stopReason: "budget_exhausted" } };
  }
  const next = { ...budget, used: budget.used + 1 };
  next.remaining = budget.maxIssues > 0 ? budget.maxIssues - next.used : Infinity;
  return { ok: true, budget: next };
}

/**
 * Attach stop-reason metadata when the loop exits.
 *
 * @param {object} budget
 * @param {string} reason
 * @returns {object} budget copy with stopReason set
 */
export function closeBudget(budget, reason) {
  return { ...budget, stopReason: budget.stopReason || reason };
}
