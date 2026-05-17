import assert from "node:assert/strict";
import test from "node:test";

import { closeBudget, consume, createBudget } from "../server/services/evolve-budget.js";

test("createBudget with zero maxIssues means unlimited", () => {
  const b = createBudget();
  assert.equal(b.maxIssues, 0);
  assert.equal(b.remaining, Infinity);
  assert.equal(b.stopReason, null);
});

test("createBudget with explicit maxIssues sets remaining", () => {
  const b = createBudget({ maxIssues: 5 });
  assert.equal(b.maxIssues, 5);
  assert.equal(b.remaining, 5);
});

test("consume decrements remaining on unlimited budget", () => {
  let b = createBudget({ maxIssues: 0 });
  const r = consume(b);
  assert.equal(r.ok, true);
  assert.equal(r.budget.used, 1);
  assert.equal(r.budget.remaining, Infinity);
});

test("consume decrements remaining on capped budget", () => {
  let b = createBudget({ maxIssues: 2 });
  const r1 = consume(b);
  assert.equal(r1.ok, true);
  assert.equal(r1.budget.used, 1);
  assert.equal(r1.budget.remaining, 1);
});

test("consume rejects when budget is exhausted", () => {
  let b = createBudget({ maxIssues: 1 });
  const r1 = consume(b);
  assert.equal(r1.ok, true);
  const r2 = consume(r1.budget);
  assert.equal(r2.ok, false);
  assert.equal(r2.budget.stopReason, "budget_exhausted");
  assert.equal(r2.budget.used, 1);
});

test("closeBudget sets stopReason when not already set", () => {
  const b = createBudget({ maxIssues: 3 });
  const closed = closeBudget(b, "backlog_empty");
  assert.equal(closed.stopReason, "backlog_empty");
});

test("closeBudget preserves existing stopReason", () => {
  const b = { ...createBudget({ maxIssues: 1 }), stopReason: "budget_exhausted" };
  const closed = closeBudget(b, "backlog_empty");
  assert.equal(closed.stopReason, "budget_exhausted");
});

test("full budget lifecycle: consume until exhaustion", () => {
  let b = createBudget({ maxIssues: 3 });
  for (let i = 0; i < 3; i++) {
    const r = consume(b);
    assert.equal(r.ok, true);
    b = r.budget;
  }
  assert.equal(b.used, 3);
  assert.equal(b.remaining, 0);
  const r = consume(b);
  assert.equal(r.ok, false);
  const closed = closeBudget(r.budget, "done");
  assert.equal(closed.stopReason, "budget_exhausted");
});
