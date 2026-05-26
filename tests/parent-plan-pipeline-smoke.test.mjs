import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolvePlanDecision } from "../bridges/run-pipeline.mjs";
import { resolveParentPlan, writeParentPlanCache } from "../server/services/plan-cache.js";

describe("parent plan pipeline smoke", () => {
  let tmpDir = null;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-parent-smoke-"));
  });

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setupProject(project, { planFile = null, issueNumber = null, task = "update login form" } = {}) {
    const wikiDir = path.join(tmpDir, "wiki", "projects", project);
    const inboxDir = path.join(wikiDir, "inbox");
    await mkdir(inboxDir, { recursive: true });

    if (planFile) {
      await writeFile(path.join(inboxDir, planFile), "# Plan\n\nImplementation plan.\n", "utf8");
    }

    const sourceContext = {};
    if (issueNumber) {
      sourceContext.issueNumber = issueNumber;
      sourceContext.repo = "org/repo";
    }

    return { sourceContext, task };
  }

  it("first parent miss falls back to full plan, write cache, second hit reuses", async () => {
    const project = "smoke-miss-write-hit";
    const { sourceContext, task } = await setupProject(project, { issueNumber: 42 });

    // Step 1: first resolve → miss
    const first = await resolveParentPlan(tmpDir, { project, task, sourceContext });
    assert.equal(first.cacheHit, false);
    assert.equal(first.source, null);
    assert.ok(first.planGroupId);
    assert.ok(first.planCacheKey);

    // Step 2: resolvePlanDecision uses miss → full plan fallback
    const planDecision = resolvePlanDecision(
      { phases: ["plan", "execute", "verify"] },
      { planMode: "parent", parentPlanResult: first },
    );
    assert.equal(planDecision.requestedPlanMode, "parent");
    assert.equal(planDecision.planMode, "full");
    assert.equal(planDecision.runPlan, true);

    // Step 3: simulate plan generation → write cache
    await mkdir(path.join(tmpDir, "wiki", "projects", project, "inbox"), { recursive: true });
    await writeFile(
      path.join(tmpDir, "wiki", "projects", project, "inbox", "plan-001.md"),
      "# Plan\n\nDo the thing.\n",
      "utf8",
    );
    const written = await writeParentPlanCache(tmpDir, {
      ...first,
      project,
      task,
      sourceContext,
      planId: "001",
      planArtifact: "plan-001",
    });
    assert.equal(written.cacheHit, true);
    assert.equal(written.reusedPlanId, "001");

    // Step 4: second resolve → hit from cache
    const second = await resolveParentPlan(tmpDir, { project, task, sourceContext });
    assert.equal(second.cacheHit, true);
    assert.equal(second.source, "cache");
    assert.equal(second.reusedPlanId, "001");

    // Step 5: resolvePlanDecision uses hit → parent reuse
    const reuseDecision = resolvePlanDecision(
      { phases: ["plan", "execute", "verify"] },
      { planMode: "parent", parentPlanResult: second },
    );
    assert.equal(reuseDecision.requestedPlanMode, "parent");
    assert.equal(reuseDecision.planMode, "parent");
    assert.equal(reuseDecision.runPlan, false);
    assert.equal(reuseDecision.planId, "001");
  });

  it("same issue second task shares cache via planGroupId", async () => {
    const project = "smoke-sdd-shared";
    const sharedGroupId = "sdd-plan-group-shared123";

    // Task 1: writes plan
    const { sourceContext: sc1 } = await setupProject(project, { issueNumber: 99 });
    sc1.planGroupId = sharedGroupId;
    const task1 = "implement auth module";

    await mkdir(path.join(tmpDir, "wiki", "projects", project, "inbox"), { recursive: true });
    await writeFile(
      path.join(tmpDir, "wiki", "projects", project, "inbox", "plan-100.md"),
      "# Plan\n\nAuth plan.\n",
      "utf8",
    );

    const first = await resolveParentPlan(tmpDir, { project, task: task1, sourceContext: sc1 });
    assert.equal(first.cacheHit, false);
    assert.ok(first.planGroupId);
    assert.ok(first.planCacheKey);
    const sharedPlanGroupId = first.planGroupId;
    const sharedPlanCacheKey = first.planCacheKey;

    await writeParentPlanCache(tmpDir, {
      ...first,
      project,
      task: task1,
      sourceContext: sc1,
      planId: "100",
      planArtifact: "plan-100",
    });

    // Task 2: different task text, same planGroupId → should hit same cache
    const { sourceContext: sc2 } = await setupProject(project, { issueNumber: 99 });
    sc2.planGroupId = sharedGroupId;
    const task2 = "write tests for auth";

    const second = await resolveParentPlan(tmpDir, { project, task: task2, sourceContext: sc2 });
    assert.equal(second.cacheHit, true);
    assert.equal(second.source, "cache");
    assert.equal(second.reusedPlanId, "100");
    assert.equal(second.planGroupId, sharedPlanGroupId);
    assert.equal(second.planCacheKey, sharedPlanCacheKey);
  });

  it("explicit parentPlanId skips cache lookup", async () => {
    const project = "smoke-explicit";

    await mkdir(path.join(tmpDir, "wiki", "projects", project, "inbox"), { recursive: true });
    await writeFile(
      path.join(tmpDir, "wiki", "projects", project, "inbox", "plan-200.md"),
      "# Plan\n\nExplicit plan.\n",
      "utf8",
    );

    const sourceContext = { parentPlanId: "200" };
    const result = await resolveParentPlan(tmpDir, { project, task: "fix bug", sourceContext });
    assert.equal(result.cacheHit, true);
    assert.equal(result.source, "explicit");
    assert.equal(result.parentPlanId, "200");
  });
});
