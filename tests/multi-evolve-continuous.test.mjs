import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MultiEvolveController } from "../bridges/multi-evolve.mjs";
import { RateLimitError } from "../bridges/acp-pool.mjs";
import { registerProject } from "../server/services/hub-registry.js";
import { loadBacklog, pushIssues, appendHistory } from "../server/services/multi-evolve-state.js";

// Helpers to create a multi-project test fixture
async function createFixture(hubRoot, projectName) {
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-cont-src-"));
  await registerProject(hubRoot, { name: projectName, sourcePath });
  return { sourcePath, projectName };
}

test("runContinuous defaults to dry-run — never executes issues", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-cpb-"));
  const { sourcePath, projectName } = await createFixture(hubRoot, "dry-default");

  await pushIssues(sourcePath, projectName, [
    { id: "i-1", priority: "P1", description: "should not execute" },
    { id: "i-2", priority: "P2", description: "also should not execute" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  let executeCalled = false;
  controller.executeIssue = async () => { executeCalled = true; return { ok: true, code: 0 }; };

  // Run 3 rounds of continuous dry-run
  const result = await controller.runContinuous({ maxRounds: 3, intervalMs: 0 });

  assert.equal(result.totalRounds, 3);
  assert.equal(result.dryRun, true);
  assert.equal(executeCalled, false);

  const backlog = await loadBacklog(sourcePath, projectName);
  assert.equal(backlog.every((i) => i.status === "pending"), true);
});

test("runContinuous respects maxRounds and stops", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-maxr-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-maxr-cpb-"));
  const { sourcePath, projectName } = await createFixture(hubRoot, "max-rounds");

  await pushIssues(sourcePath, projectName, [
    { id: "i-1", priority: "P1", description: "round 1" },
    { id: "i-2", priority: "P1", description: "round 2" },
    { id: "i-3", priority: "P1", description: "round 3" },
    { id: "i-4", priority: "P1", description: "should not reach" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  const executions = [];
  controller.executeIssue = async (issue) => {
    executions.push(issue.id);
    return { ok: true, code: 0 };
  };

  const result = await controller.runContinuous({ maxRounds: 2, intervalMs: 0, execute: true });

  assert.equal(result.totalRounds, 2);
  assert.equal(executions.length, 2);
});

test("runContinuous skips rate-limited projects without stopping the loop", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-rl-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-rl-cpb-"));

  const projA = await createFixture(hubRoot, "rate-limited");
  const projB = await createFixture(hubRoot, "healthy");

  await pushIssues(projA.sourcePath, projA.projectName, [
    { id: "i-a", priority: "P0", description: "rate limited project issue" },
  ]);
  await pushIssues(projB.sourcePath, projB.projectName, [
    { id: "i-b", priority: "P1", description: "healthy project issue" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  const executions = [];
  controller.executeIssue = async (issue) => {
    executions.push(issue.id);
    return { ok: true, code: 0 };
  };

  // Fully stub scanProject to avoid real ACP pool calls
  const scanCounts = {};
  controller.scanProject = async (project, opts) => {
    scanCounts[project.id] = (scanCounts[project.id] || 0) + 1;
    if (project.id === projA.projectName && scanCounts[project.id] === 1) {
      const err = new RateLimitError("codex", Date.now() + 60000, "rate limited");
      throw err;
    }
    return { project: project.id, issues: [], added: 0, total: 0 };
  };

  const result = await controller.runContinuous({
    maxRounds: 2,
    intervalMs: 0,
    scan: true,
    execute: true,
  });

  assert.equal(result.totalRounds, 2);
  // Project B's issue should have been picked up despite project A being rate-limited
  assert.ok(executions.some((id) => id === "i-b"), `expected i-b in executions, got: ${JSON.stringify(executions)}`);
  assert.equal(result.rateLimitedSkipped > 0, true);
});

test("runContinuous stops on graceful shutdown signal", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-sig-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-sig-cpb-"));
  const { sourcePath, projectName } = await createFixture(hubRoot, "signal-stop");

  // Push many issues so the loop would run indefinitely
  for (let i = 0; i < 50; i++) {
    await pushIssues(sourcePath, projectName, [
      { id: `i-${i}`, priority: "P2", description: `issue ${i}` },
    ]);
  }

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  let roundsRun = 0;
  controller.executeIssue = async () => {
    roundsRun++;
    if (roundsRun >= 3) controller.requestStop();
    return { ok: true, code: 0 };
  };

  // maxRounds high enough that signal should trigger first
  const result = await controller.runContinuous({ maxRounds: 100, intervalMs: 0, execute: true });

  assert.equal(result.stopped, true);
  assert.equal(result.totalRounds, 3);
});

test("runContinuous with execute=true actually executes issues", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-exec-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-exec-cpb-"));
  const { sourcePath, projectName } = await createFixture(hubRoot, "exec-mode");

  await pushIssues(sourcePath, projectName, [
    { id: "i-exec", priority: "P0", description: "must execute" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  let executed = false;
  controller.executeIssue = async (issue) => {
    executed = true;
    return { ok: true, code: 0 };
  };

  const result = await controller.runContinuous({ maxRounds: 1, intervalMs: 0, execute: true });

  assert.equal(executed, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.totalRounds, 1);

  const backlog = await loadBacklog(sourcePath, projectName);
  assert.equal(backlog[0].status, "completed");
});

test("runContinuous appends history for each round", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-hist-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-hist-cpb-"));
  const { sourcePath, projectName } = await createFixture(hubRoot, "hist-check");

  await pushIssues(sourcePath, projectName, [
    { id: "i-h1", priority: "P1", description: "history check 1" },
    { id: "i-h2", priority: "P2", description: "history check 2" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  controller.executeIssue = async () => ({ ok: true, code: 0 });

  await controller.runContinuous({ maxRounds: 2, intervalMs: 0, execute: true });

  // History file should exist and have entries
  const { readFile } = await import("node:fs/promises");
  const historyPath = path.join(sourcePath, "cpb-task", "evolve", projectName, "history.jsonl");
  const raw = await readFile(historyPath, "utf8");
  const entries = raw.trim().split("\n").map((l) => JSON.parse(l));
  const continuousEntries = entries.filter((e) => e.action === "continuous_round");
  assert.equal(continuousEntries.length, 2);
});

test("runContinuous with empty backlog completes gracefully", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-empty-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-empty-cpb-"));
  await createFixture(hubRoot, "empty-backlog");

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });

  const result = await controller.runContinuous({ maxRounds: 1, intervalMs: 0 });

  assert.equal(result.totalRounds, 1);
  assert.equal(result.dryRun, true);
  assert.equal(result.issuesExecuted, 0);
});

test("runContinuous preserves single-project self-evolve compatibility (project filter)", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-single-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-cont-single-cpb-"));

  const projA = await createFixture(hubRoot, "target-project");
  const projB = await createFixture(hubRoot, "other-project");

  await pushIssues(projA.sourcePath, projA.projectName, [
    { id: "i-a", priority: "P1", description: "target issue" },
  ]);
  await pushIssues(projB.sourcePath, projB.projectName, [
    { id: "i-b", priority: "P0", description: "should not touch" },
  ]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  const executions = [];
  controller.executeIssue = async (issue) => {
    executions.push(issue.id);
    return { ok: true, code: 0 };
  };

  const result = await controller.runContinuous({
    maxRounds: 1,
    intervalMs: 0,
    execute: true,
    project: projA.projectName,
  });

  assert.equal(result.totalRounds, 1);
  assert.deepEqual(executions, ["i-a"]);

  const backlogB = await loadBacklog(projB.sourcePath, projB.projectName);
  assert.equal(backlogB[0].status, "pending");
});
