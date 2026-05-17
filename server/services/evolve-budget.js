export function createEvolveBudget(policy = {}) {
  return {
    maxRepairsPerRun: Number(policy.maxRepairsPerRun ?? 1),
    maxFailuresPerRun: Number(policy.maxFailuresPerRun ?? 1),
    repairsStarted: 0,
    failures: 0,
    stopReason: null,
  };
}

export function assertRepairBudget(budget) {
  if (budget.stopReason) {
    return { allowed: false, reason: budget.stopReason };
  }
  if (budget.repairsStarted >= budget.maxRepairsPerRun) {
    budget.stopReason = "repair budget exhausted";
    return { allowed: false, reason: budget.stopReason };
  }
  if (budget.failures >= budget.maxFailuresPerRun) {
    budget.stopReason = "failure budget exhausted";
    return { allowed: false, reason: budget.stopReason };
  }
  return { allowed: true, reason: null };
}

export function recordRepairStart(budget) {
  budget.repairsStarted += 1;
  if (budget.repairsStarted >= budget.maxRepairsPerRun) {
    budget.stopReason = "repair budget exhausted";
  }
  return budget;
}

export function recordRepairResult(budget, result = {}) {
  if (!result.ok) {
    budget.failures += 1;
    if (budget.failures >= budget.maxFailuresPerRun) {
      budget.stopReason = "failure budget exhausted";
    }
  }
  return budget;
}
