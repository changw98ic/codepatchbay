import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  resolveParentPlan,
  writeParentPlanCache,
  parentPlanCacheIdentity,
} from "../server/services/plan-cache.js";
import { resolvePhases as resolvePlanDecision } from "../core/engine/workflow-runner.js";

/**
 * Helpers for setting up test fixtures inside a temp cpbRoot.
 *
 * Layout conventions (mirrors production):
 *   <cpbRoot>/wiki/projects/<project>/inbox/plan-<id>.md   — plan artifacts
 *   <cpbRoot>/cpb-task/jobs-index.json                       — jobs index
 *   <cpbRoot>/cpb-task/plan-cache/<project>/<key>.json       — cache records
 */

const PROJECT = "test-project";

async function makeCpbRoot() {
  return mkdtemp(path.join(os.tmpdir(), "cpb-plan-resolver-"));
}

async function writePlanFile(cpbRoot, project, planId) {
  const planPath = path.join(
    cpbRoot, "wiki", "projects", project, "inbox", `plan-${planId}.md`,
  );
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, `# Plan ${planId}\n\nTest plan content.\n`, "utf8");
  return planPath;
}

async function writeJobsIndex(cpbRoot, jobs) {
  // jobs is an array of job objects; we build the keyed map the index expects
  const index = {
    _meta: { version: 1, updatedAt: new Date().toISOString(), jobCount: jobs.length },
    jobs: {},
  };
  for (const j of jobs) {
    const key = `${j.project}/${j.jobId}`;
    index.jobs[key] = j;
  }
  const indexPath = path.join(cpbRoot, "cpb-task", "jobs-index.json");
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, JSON.stringify(index) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveParentPlan", () => {
  let cpbRoot;

  beforeEach(async () => {
    cpbRoot = await makeCpbRoot();
  });

  afterEach(async () => {
    await rm(cpbRoot, { recursive: true, force: true });
  });

  // 1. Explicit parentPlanId hit ------------------------------------------------
  it("returns cacheHit=true with source=explicit when parentPlanId points to existing plan", async () => {
    const planId = "abc123";
    await writePlanFile(cpbRoot, PROJECT, planId);

    const result = await resolveParentPlan(cpbRoot, {
      project: PROJECT,
      task: "do something",
      sourceContext: { parentPlanId: planId },
    });

    assert.equal(result.cacheHit, true);
    assert.equal(result.source, "explicit");
    assert.equal(result.parentPlanId, planId);
    assert.equal(result.reusedPlanId, planId);
    assert.equal(result.reusedPlanArtifact, `plan-${planId}`);
  });

  // 2. Cache record hit --------------------------------------------------------
  it("returns cacheHit=true with source=cache when plan-cache record exists", async () => {
    const planId = "cached-plan-001";
    await writePlanFile(cpbRoot, PROJECT, planId);

    // Write cache record via the public API
    const written = await writeParentPlanCache(cpbRoot, {
      project: PROJECT,
      task: "implement feature X",
      sourceContext: { repo: "org/repo" },
      planId,
    });
    assert.equal(written.cacheHit, true, "writeParentPlanCache should report cacheHit");

    const result = await resolveParentPlan(cpbRoot, {
      project: PROJECT,
      task: "implement feature X",
      sourceContext: { repo: "org/repo" },
    });

    assert.equal(result.cacheHit, true);
    assert.equal(result.source, "cache");
    assert.equal(result.parentPlanId, planId);
  });

  // 3. Same issue hit ----------------------------------------------------------
  it("returns cacheHit=true with source=same_issue when jobs index has matching issueNumber", async () => {
    const planId = "issue-plan-42";
    await writePlanFile(cpbRoot, PROJECT, planId);

    const jobId = "job-001";
    const now = new Date().toISOString();
    await writeJobsIndex(cpbRoot, [
      {
        project: PROJECT,
        projectId: PROJECT,
        jobId,
        status: "completed",
        task: "fix the login bug",
        workflow: "pipeline",
        completedPhases: ["plan", "execute"],
        artifacts: { plan: `plan-${planId}` },
        sourceContext: { issueNumber: 42 },
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await resolveParentPlan(cpbRoot, {
      project: PROJECT,
      task: "fix the login bug again",
      sourceContext: { issueNumber: 42 },
    });

    assert.equal(result.cacheHit, true);
    assert.equal(result.source, "same_issue");
    assert.equal(result.parentPlanId, planId);
    assert.equal(result.parentJobId, jobId);
  });

  // 4. Task overlap hit --------------------------------------------------------
  it("returns cacheHit=true with source=task_overlap when task text overlaps >= 50%", async () => {
    const planId = "overlap-plan-99";
    await writePlanFile(cpbRoot, PROJECT, planId);

    const previousTask = "Add dark mode toggle to the settings page with persistence";
    const newTask = "Add dark mode toggle to the settings page with local storage";

    const jobId = "job-002";
    const now = new Date().toISOString();
    await writeJobsIndex(cpbRoot, [
      {
        project: PROJECT,
        projectId: PROJECT,
        jobId,
        status: "completed",
        task: previousTask,
        workflow: "pipeline",
        completedPhases: ["plan", "execute"],
        artifacts: { plan: `plan-${planId}` },
        sourceContext: { issueNumber: 999 },
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await resolveParentPlan(cpbRoot, {
      project: PROJECT,
      task: newTask,
      sourceContext: { issueNumber: 500 },
    });

    assert.equal(result.cacheHit, true);
    assert.equal(result.source, "task_overlap");
    assert.equal(result.parentPlanId, planId);
    assert.equal(result.parentJobId, jobId);
  });

  // 5. Miss then write cache then hit ------------------------------------------
  it("returns miss, then after writeParentPlanCache returns cache hit", async () => {
    const planId = "fresh-plan-777";
    await writePlanFile(cpbRoot, PROJECT, planId);

    const task = "build the notification system";
    const sourceContext = { repo: "org/notifs" };

    // First call: no cache, no jobs index, no explicit id -> miss
    const miss = await resolveParentPlan(cpbRoot, {
      project: PROJECT,
      task,
      sourceContext,
    });

    assert.equal(miss.cacheHit, false);
    assert.equal(miss.source, null);
    assert.equal(miss.parentPlanId, null);

    // Write cache
    const written = await writeParentPlanCache(cpbRoot, {
      project: PROJECT,
      task,
      sourceContext,
      planId,
    });
    assert.equal(written.cacheHit, true);

    // Second call: should hit the cache
    const hit = await resolveParentPlan(cpbRoot, {
      project: PROJECT,
      task,
      sourceContext,
    });

    assert.equal(hit.cacheHit, true);
    assert.equal(hit.source, "cache");
    assert.equal(hit.parentPlanId, planId);
  });

  // 6. Stale cache → miss ------------------------------------------------------
  it("returns cacheHit=false with stale=true when cache record exists but plan artifact is deleted", async () => {
    const planId = "stale-plan-888";
    await writePlanFile(cpbRoot, PROJECT, planId);

    await writeParentPlanCache(cpbRoot, {
      project: PROJECT,
      task: "stale feature",
      sourceContext: { repo: "org/stale" },
      planId,
    });

    // Delete the plan file to simulate staleness
    const planPath = path.join(cpbRoot, "wiki", "projects", PROJECT, "inbox", `plan-${planId}.md`);
    await rm(planPath);

    const result = await resolveParentPlan(cpbRoot, {
      project: PROJECT,
      task: "stale feature",
      sourceContext: { repo: "org/stale" },
    });

    assert.equal(result.cacheHit, false);
    assert.equal(result.source, null);
    assert.equal(result.stale, true);
  });

  // 7. Cache hit → skip plan (resolvePlanDecision integration) ----------------
  it("skips plan generation when resolvePlanDecision receives a cache hit", async () => {
    const planId = "skip-plan-999";
    await writePlanFile(cpbRoot, PROJECT, planId);

    const hit = await resolveParentPlan(cpbRoot, {
      project: PROJECT,
      task: "skip plan test",
      sourceContext: { parentPlanId: planId },
    });

    assert.equal(hit.cacheHit, true);
    assert.equal(hit.source, "explicit");

    const decision = resolvePlanDecision(
      { phases: ["plan", "execute", "verify"] },
      { planMode: "parent", parentPlanResult: hit },
    );

    assert.equal(decision.runPlan, false);
    assert.equal(decision.planMode, "parent");
    assert.equal(decision.planId, planId);
  });
});
