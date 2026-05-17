import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MultiEvolveController } from "../bridges/multi-evolve.mjs";
import { registerProject } from "../server/services/hub-registry.js";
import { loadBacklog, pushIssues } from "../server/services/multi-evolve-state.js";

test("multi-evolve execute-once claims and completes a pending issue", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-cpb-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-multi-project-"));
  const project = await registerProject(hubRoot, { name: "calc-test", sourcePath });
  await pushIssues(project.sourcePath, project.id, [{ id: "issue-1", priority: "P1", description: "fix one thing" }]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  controller.executeIssue = async (issue) => ({ ok: true, code: 0, issue: issue.id });
  const result = await controller.runOnce({ project: project.id });

  assert.equal(result.result.ok, true);
  const backlog = await loadBacklog(project.sourcePath, project.id);
  assert.equal(backlog[0].status, "completed");
  assert.equal(backlog[0].detail.exitCode, 0);
});

test("multi-evolve execute-once marks failed execution and removes it from pending queue", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-hub-fail-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-cpb-fail-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-multi-project-fail-"));
  const project = await registerProject(hubRoot, { name: "calc-test", sourcePath });
  await pushIssues(project.sourcePath, project.id, [{ id: "issue-2", priority: "P0", description: "fix risky thing" }]);

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });
  controller.executeIssue = async () => ({ ok: false, code: 7, error: "boom" });
  const result = await controller.runOnce({ project: project.id });

  assert.equal(result.result.ok, false);
  const backlog = await loadBacklog(project.sourcePath, project.id);
  assert.equal(backlog[0].status, "failed");
  assert.equal(backlog.filter((issue) => issue.status === "pending").length, 0);
});

test("multi-evolve default ACP pool uses the controller Hub root", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-hub-pool-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-cpb-pool-"));

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });

  assert.equal(controller.pool.hubRoot, hubRoot);
});
