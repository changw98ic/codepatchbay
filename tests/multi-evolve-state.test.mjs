import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadBacklog,
  popIssue,
  pushIssues,
} from "../server/services/multi-evolve-state.js";

test("multi-evolve backlog is isolated per project root and project id", async () => {
  const rootA = await mkdtemp(path.join(tmpdir(), "cpb-evolve-a-"));
  const rootB = await mkdtemp(path.join(tmpdir(), "cpb-evolve-b-"));

  await pushIssues(rootA, "calc-test", [{ priority: "P1", description: "fix parser" }]);
  await pushIssues(rootB, "dimension-sim", [{ priority: "P0", description: "fix physics" }]);

  assert.equal((await loadBacklog(rootA, "calc-test")).length, 1);
  assert.equal((await loadBacklog(rootA, "dimension-sim")).length, 0);
  assert.equal((await loadBacklog(rootB, "dimension-sim")).length, 1);
});

test("multi-evolve pop marks highest priority issue in progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-evolve-pop-"));
  await pushIssues(root, "calc-test", [
    { priority: "P2", description: "small cleanup" },
    { priority: "P0", description: "stop data loss" },
  ]);

  const popped = await popIssue(root, "calc-test");
  assert.equal(popped.issue.description, "stop data loss");
  assert.equal(popped.issue.status, "in_progress");
});
