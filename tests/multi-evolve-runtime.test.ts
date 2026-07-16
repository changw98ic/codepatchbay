import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { CrossProjectPriorityQueue, parseScanResults } from "../runtime/evolve/multi-evolve.js";
import { pushIssues } from "../server/services/evolve/evolve.js";
import { tempRoot } from "./helpers.js";

test("parseScanResults accepts bracketed and plain priorities", () => {
  assert.deepEqual(parseScanResults([
    "[ISSUE] P1 Fix stale queue lease handling",
    "[ISSUE] [P2] Tighten docs around runtime setup",
    "noise",
  ].join("\n")), [
    { priority: "P1", description: "Fix stale queue lease handling", status: "pending" },
    { priority: "P2", description: "Tighten docs around runtime setup", status: "pending" },
  ]);
});

test("CrossProjectPriorityQueue returns pending backlog issues with project runtime roots", async () => {
  const root = await tempRoot("cpb-multi-evolve-runtime");
  const sourceA = path.join(root, "source-a");
  const sourceB = path.join(root, "source-b");
  const runtimeA = path.join(root, "runtime-a");
  const runtimeB = path.join(root, "runtime-b");
  await mkdir(sourceA, { recursive: true });
  await mkdir(sourceB, { recursive: true });

  await pushIssues(sourceA, "alpha", [
    { id: "alpha-low", description: "Alpha low", priority: "P2", status: "pending" },
    { id: "alpha-done", description: "Alpha done", priority: "P0", status: "completed" },
  ], { projectRuntimeRoot: runtimeA });
  await pushIssues(sourceB, "beta", [
    { id: "beta-high", description: "Beta high", priority: "P1", status: "pending" },
  ], { projectRuntimeRoot: runtimeB });

  const queue = new CrossProjectPriorityQueue([
    { id: "alpha", sourcePath: sourceA, projectRuntimeRoot: runtimeA, weight: 1 },
    { id: "beta", sourcePath: sourceB, projectRuntimeRoot: runtimeB, weight: 3 },
  ]);
  const candidates = await queue.candidates();

  assert.deepEqual(candidates.map((issue) => issue.id), ["beta-high", "alpha-low"]);
  assert.equal(candidates[0].project, "beta");
  assert.equal(candidates[0].sourcePath, sourceB);
  assert.equal(candidates[0].projectRuntimeRoot, runtimeB);
  assert.equal(candidates[0].dataRoot, runtimeB);
  assert.equal(candidates[0].weight, 3);
});
