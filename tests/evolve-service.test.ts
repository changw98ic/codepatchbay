import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  MERGE_CLASSIFICATION,
  appendHistory,
  checkPolicy,
  classifyCategory,
  claimIssue,
  completeIssue,
  loadBacklog,
  loadProjectState,
  popIssue,
  pushIssues,
  saveProjectState,
  summarizeMergeFiles,
} from "../server/services/evolve/evolve.js";
import { tempRoot } from "./helpers.js";

type SavedState = {
  round?: number;
  status?: string;
  updatedAt?: string;
};

test("evolve policy classifies safe and high-risk issues without requiring a git repo", () => {
  const allowed = checkPolicy(
    { project: "flow", description: "Fix a README typo" },
    { allowlist: ["flow"], requireCleanWorktree: false },
  );
  assert.deepEqual(allowed, { allowed: true, reasons: [] });
  assert.equal(classifyCategory({ title: "Fix flaky test", labels: ["CI"] }), "test-fix");

  const blocked = checkPolicy(
    { project: "ops", description: "Rotate api token in auth flow" },
    { allowlist: ["flow"], requireCleanWorktree: false },
  );
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes("not in allowlist")));
  assert.ok(blocked.reasons.some((reason) => reason.includes("secrets or credentials")));
});

test("merge file summary separates shared-state and human-reviewed files", () => {
  const summary = summarizeMergeFiles([
    "src/app.ts",
    "wiki/projects/flow/state.json",
    "AGENTS.md",
    "schemas/public.schema.json",
  ]);

  assert.deepEqual(summary.counts, {
    [MERGE_CLASSIFICATION.SHARED_STATE]: 1,
    [MERGE_CLASSIFICATION.NEEDS_HUMAN]: 2,
    [MERGE_CLASSIFICATION.RESOLVABLE_CODE]: 1,
  });
  assert.deepEqual(summary.entries.map((entry) => entry.file), [
    "AGENTS.md",
    "schemas/public.schema.json",
    "src/app.ts",
    "wiki/projects/flow/state.json",
  ]);
});

test("evolve backlog preserves priority, claims, completion detail, and history", async () => {
  const root = await tempRoot("cpb-evolve-service");
  const projectRoot = path.join(root, "project");
  const options = { dataRoot: path.join(root, "data") };

  const state: SavedState = await saveProjectState(projectRoot, "flow", { round: 2, status: "running" }, options);
  assert.equal(state.round, 2);
  assert.equal(state.status, "running");
  assert.ok(state.updatedAt);
  assert.deepEqual(await loadProjectState(projectRoot, "flow", options), state);

  const pushed = await pushIssues(projectRoot, "flow", [
    { id: "slow", description: "Low priority", priority: "P2" },
    { id: "urgent", description: "High priority", priority: "P0" },
    { id: "urgent", description: "Duplicate", priority: "P0" },
  ], options);
  assert.equal(pushed.added, 2);
  assert.equal(pushed.total, 2);

  const popped = await popIssue(projectRoot, "flow", options);
  assert.equal(popped?.issue.id, "urgent");
  assert.equal(popped?.issue.status, "in_progress");

  const claimed = await claimIssue(projectRoot, "flow", "slow", options);
  assert.equal(claimed?.issue.id, "slow");
  assert.equal(claimed?.issue.status, "in_progress");
  assert.ok(claimed?.issue.claimedAt);

  const completed = await completeIssue(projectRoot, "flow", "slow", { ok: true, code: 0 }, options);
  assert.equal(completed?.issue.status, "completed");
  assert.equal(completed?.issue.detail.exitCode, 0);
  assert.equal(completed?.issue.detail.error, null);
  assert.ok(completed?.issue.detail.completedAt);

  const backlog = await loadBacklog(projectRoot, "flow", options);
  assert.deepEqual(backlog.map((issue) => [issue.id, issue.status]), [
    ["slow", "completed"],
    ["urgent", "in_progress"],
  ]);

  await appendHistory(projectRoot, "flow", { type: "completed", issueId: "slow" }, options);
  const historyPath = path.join(options.dataRoot, "evolve", "flow", "history.jsonl");
  const history = (await readFile(historyPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(history.length, 1);
  assert.equal(history[0].project, "flow");
  assert.equal(history[0].type, "completed");
  assert.ok(history[0].timestamp);
});
