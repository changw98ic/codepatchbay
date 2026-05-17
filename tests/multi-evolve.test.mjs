import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import { MultiEvolveController } from "../bridges/multi-evolve.mjs";
import { registerProject } from "../server/services/hub-registry.js";
import { loadBacklog, pushIssues } from "../server/services/multi-evolve-state.js";
import { resetManagedAcpPoolsForTests } from "../server/services/acp-pool-runtime.js";
import { listQueue } from "../server/services/hub-queue.js";

afterEach(() => {
  resetManagedAcpPoolsForTests();
});

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

test("multi-evolve execute-once routes live mutation through project worker queue", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-worker-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-worker-cpb-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-multi-worker-src-"));
  const project = await registerProject(hubRoot, { name: "calc-test", sourcePath });
  await pushIssues(project.sourcePath, project.id, [{ id: "issue-w", priority: "P1", description: "route via worker" }]);

  const calls = [];
  const controller = new MultiEvolveController(cpbRoot, {
    hubRoot,
    workerRunner: async ({ issue, queueEntry, workflow }) => {
      calls.push({ issue, queueEntry, workflow });
      return { ok: true, code: 0, stdout: "worker ok", stderr: "" };
    },
  });

  const result = await controller.runOnce({ project: project.id, workflow: "blocked" });

  assert.equal(result.result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].issue.id, "issue-w");
  assert.equal(calls[0].queueEntry.projectId, project.id);
  assert.equal(calls[0].queueEntry.metadata.source, "multi-evolve");
  assert.equal(calls[0].workflow, "blocked");

  const backlog = await loadBacklog(project.sourcePath, project.id);
  assert.equal(backlog[0].status, "completed");

  const queue = await listQueue(hubRoot);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "completed");
  assert.equal(queue[0].metadata.syncedFrom, "backlog");
});

test("multi-evolve execute-once syncs worker failure back to Hub queue", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-worker-fail-hub-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-worker-fail-cpb-"));
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-multi-worker-fail-src-"));
  const project = await registerProject(hubRoot, { name: "calc-test", sourcePath });
  await pushIssues(project.sourcePath, project.id, [{ id: "issue-f", priority: "P0", description: "worker fails" }]);

  const controller = new MultiEvolveController(cpbRoot, {
    hubRoot,
    workerRunner: async () => ({ ok: false, code: 9, error: "worker failed" }),
  });

  const result = await controller.runOnce({ project: project.id });

  assert.equal(result.result.ok, false);
  const backlog = await loadBacklog(project.sourcePath, project.id);
  assert.equal(backlog[0].status, "failed");

  const queue = await listQueue(hubRoot);
  assert.equal(queue[0].status, "failed");
  assert.equal(queue[0].metadata.error, "worker failed");
});

test("multi-evolve default ACP pool uses the controller Hub root through the managed runtime", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-hub-pool-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-cpb-pool-"));

  const controller = new MultiEvolveController(cpbRoot, { hubRoot });

  assert.equal(controller.pool.hubRoot, hubRoot);
  assert.equal(controller.pool.status().mode, "managed-shared");
});

test("multi-evolve can opt into an isolated local ACP pool", async () => {
  const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-hub-local-pool-"));
  const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-multi-cpb-local-pool-"));

  const controller = new MultiEvolveController(cpbRoot, { hubRoot, localAcpPool: true });

  assert.equal(controller.pool.hubRoot, hubRoot);
  assert.equal(controller.pool.status().pools.codex.mode, "bounded-one-shot");
});
