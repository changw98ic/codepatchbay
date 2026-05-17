import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { MultiEvolveController, CrossProjectPriorityQueue, parseScanResults } from "../bridges/multi-evolve.mjs";
import { registerProject } from "../server/services/hub-registry.js";
import { pushIssues, loadBacklog } from "../server/services/multi-evolve-state.js";
import { enqueue, listQueue, queueStatus } from "../server/services/hub-queue.js";

async function createFixture(hubRoot, projectName) {
  const sourcePath = await mkdtemp(path.join(tmpdir(), "cpb-bridge-src-"));
  await registerProject(hubRoot, { name: projectName, sourcePath });
  return { sourcePath, projectName };
}

describe("scan → Hub queue bridge", () => {
  test("scanProject enqueues discovered issues into Hub queue", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-bridge-hq-"));
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-bridge-cpb-"));
    const { sourcePath, projectName } = await createFixture(hubRoot, "scan-enqueue");

    const controller = new MultiEvolveController(cpbRoot, { hubRoot });
    await controller.init({ project: projectName });

    // Stub scan to return fixture issues
    process.env.CPB_MULTI_EVOLVE_SCAN_FIXTURE = [
      "[ISSUE] P0 Fix critical memory leak",
      "[ISSUE] P2 Improve error messages",
    ].join("\n");

    try {
      await controller.scanProject(controller.projects[0]);

      const hubEntries = await listQueue(hubRoot, { status: "pending" });
      assert.equal(hubEntries.length, 2);
      assert.equal(hubEntries[0].projectId, projectName);
      assert.equal(hubEntries[0].priority, "P0");
      assert.equal(hubEntries[0].description, "Fix critical memory leak");
      assert.ok(hubEntries[0].sourcePath, "sourcePath should be set");
      assert.equal(hubEntries[0].type, "candidate");

      // Backlog also has the issues
      const backlog = await loadBacklog(sourcePath, projectName);
      assert.equal(backlog.length, 2);
    } finally {
      delete process.env.CPB_MULTI_EVOLVE_SCAN_FIXTURE;
    }
  });

  test("duplicate scan does not create duplicate Hub queue entries", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-bridge-dup-"));
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-bridge-dup-cpb-"));
    const { sourcePath, projectName } = await createFixture(hubRoot, "dup-check");

    const controller = new MultiEvolveController(cpbRoot, { hubRoot });
    await controller.init({ project: projectName });

    const fixture = "[ISSUE] P1 Same issue every time";
    process.env.CPB_MULTI_EVOLVE_SCAN_FIXTURE = fixture;

    try {
      await controller.scanProject(controller.projects[0]);
      await controller.scanProject(controller.projects[0]);

      const hubEntries = await listQueue(hubRoot);
      assert.equal(hubEntries.length, 1, "hub queue should have exactly 1 entry after 2 scans of same issue");

      // Hub queue dedup is the primary duplicate protection mechanism.
      // Backlog may accumulate re-scan entries (pre-existing pushIssues behavior).
      const backlog = await loadBacklog(sourcePath, projectName);
      assert.ok(backlog.length >= 1, "backlog should have at least 1 entry");
    } finally {
      delete process.env.CPB_MULTI_EVOLVE_SCAN_FIXTURE;
    }
  });

  test("scanProject with empty results does not touch Hub queue", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-bridge-empty-"));
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-bridge-empty-cpb-"));
    const { projectName } = await createFixture(hubRoot, "empty-scan");

    const controller = new MultiEvolveController(cpbRoot, { hubRoot });
    await controller.init({ project: projectName });

    process.env.CPB_MULTI_EVOLVE_SCAN_FIXTURE = "no issues found";

    try {
      await controller.scanProject(controller.projects[0]);

      const hubEntries = await listQueue(hubRoot);
      assert.equal(hubEntries.length, 0);
    } finally {
      delete process.env.CPB_MULTI_EVOLVE_SCAN_FIXTURE;
    }
  });
});

describe("CrossProjectPriorityQueue merges backlog + Hub queue", () => {
  test("candidates includes Hub queue entries not in backlog", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-bridge-merge-"));
    const projA = { id: "proj-a", sourcePath: await mkdtemp(path.join(tmpdir(), "cpb-merge-a-")), weight: 1 };

    // Only in backlog
    await pushIssues(projA.sourcePath, projA.id, [
      { id: "bl-1", priority: "P1", description: "backlog-only issue" },
    ]);

    // Only in Hub queue (e.g. enqueued via API)
    await enqueue(hubRoot, {
      projectId: "proj-a",
      sourcePath: projA.sourcePath,
      priority: "P0",
      description: "hub-only issue",
    });

    const queue = new CrossProjectPriorityQueue([projA], hubRoot);
    const candidates = await queue.candidates();

    assert.equal(candidates.length, 2);
    // P0 hub-only should come first
    assert.equal(candidates[0].description, "hub-only issue");
    assert.equal(candidates[0]._source, "hub_queue");
    assert.equal(candidates[1].description, "backlog-only issue");
    assert.equal(candidates[1]._source, undefined);
  });

  test("candidates deduplicates when issue is in both backlog and Hub queue", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-bridge-dedup-"));
    const projA = { id: "proj-a", sourcePath: await mkdtemp(path.join(tmpdir(), "cpb-dedup-a-")), weight: 1 };

    // Same issue in both
    await pushIssues(projA.sourcePath, projA.id, [
      { id: "bl-1", priority: "P1", description: "shared issue" },
    ]);
    await enqueue(hubRoot, {
      projectId: "proj-a",
      sourcePath: projA.sourcePath,
      priority: "P1",
      description: "shared issue",
    });

    const queue = new CrossProjectPriorityQueue([projA], hubRoot);
    const candidates = await queue.candidates();

    assert.equal(candidates.length, 1, "should dedupe by projectId::description");
    // Backlog version is preferred (no _source tag)
    assert.equal(candidates[0]._source, undefined);
  });

  test("candidates without hubRoot works as before (backlog only)", async () => {
    const projA = { id: "proj-a", sourcePath: await mkdtemp(path.join(tmpdir(), "cpb-nohub-")), weight: 1 };

    await pushIssues(projA.sourcePath, projA.id, [
      { id: "bl-1", priority: "P2", description: "just backlog" },
    ]);

    const queue = new CrossProjectPriorityQueue([projA], null);
    const candidates = await queue.candidates();

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].description, "just backlog");
  });
});

describe("dry-run exposes Hub queue status", () => {
  test("runOnce dry-run includes hubQueue in response", async () => {
    const hubRoot = await mkdtemp(path.join(tmpdir(), "cpb-bridge-dry-"));
    const cpbRoot = await mkdtemp(path.join(tmpdir(), "cpb-bridge-dry-cpb-"));
    const { sourcePath, projectName } = await createFixture(hubRoot, "dry-run-hub");

    // Seed backlog + Hub queue
    await pushIssues(sourcePath, projectName, [
      { id: "i-1", priority: "P1", description: "dry run issue" },
    ]);
    await enqueue(hubRoot, {
      projectId: projectName,
      sourcePath,
      priority: "P1",
      description: "dry run issue",
    });

    const controller = new MultiEvolveController(cpbRoot, { hubRoot });
    const result = await controller.runOnce({ dryRun: true });

    assert.equal(result.dryRun, true);
    assert.ok(result.hubQueue, "dry-run response should include hubQueue");
    assert.equal(result.hubQueue.pending, 1);
    assert.equal(result.hubQueue.total, 1);
  });
});
