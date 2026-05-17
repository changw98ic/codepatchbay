import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRepairBudget,
  createEvolveBudget,
  recordRepairResult,
  recordRepairStart,
} from "../server/services/evolve-budget.js";

test("evolve repair budget stops after the configured repair count", () => {
  const budget = createEvolveBudget({ maxRepairsPerRun: 1, maxFailuresPerRun: 3 });

  assert.deepEqual(assertRepairBudget(budget), { allowed: true, reason: null });
  recordRepairStart(budget);

  assert.equal(assertRepairBudget(budget).allowed, false);
  assert.equal(budget.stopReason, "repair budget exhausted");
});

test("evolve repair budget stops after configured failures", () => {
  const budget = createEvolveBudget({ maxRepairsPerRun: 3, maxFailuresPerRun: 1 });

  recordRepairResult(budget, { ok: false });

  assert.equal(assertRepairBudget(budget).allowed, false);
  assert.equal(budget.stopReason, "failure budget exhausted");
});
