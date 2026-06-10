import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { getWorkflow, isWorkflowName, listWorkflows } from "../core/workflow/definition.js";
import { snapshotForJob } from "../server/services/index-freshness.js";

test("FailureKind exports codegraph_unavailable", () => {
  assert.equal(FailureKind.CODEGRAPH_UNAVAILABLE, "codegraph_unavailable");
});

test("no stale INDEX_UNAVAILABLE in FailureKind", () => {
  assert.equal(FailureKind.INDEX_UNAVAILABLE, undefined);
});

test("WORKFLOWS-backed definition preserves standard workflow behavior", () => {
  const wf = getWorkflow("standard");
  assert.equal(wf.name, "standard");
  assert.deepEqual(wf.phases, ["plan", "execute", "verify"]);
});

test("snapshotForJob uses codegraph_unavailable fallback", () => {
  const snap = snapshotForJob(null);
  assert.deepEqual(snap.indexFreshness.dirtyReasons, ["codegraph_unavailable"]);
});

test("snapshotForJob with available result", () => {
  const snap = snapshotForJob({
    available: true,
    indexSnapshotId: "snap-1",
    sourceFingerprint: "fp-1",
    indexDirty: false,
    indexStale: false,
    worktreeDirty: false,
    dirtyReasons: [],
  });
  assert.equal(snap.indexFreshness.available, true);
});

test("listWorkflows returns standard workflows", () => {
  const names = listWorkflows();
  assert.ok(names.includes("standard"));
  assert.ok(names.includes("direct"));
  assert.ok(names.includes("complex"));
});

test("isWorkflowName validates correctly", () => {
  assert.equal(isWorkflowName("standard"), true);
  assert.equal(isWorkflowName("nonexistent"), false);
});

test("getWorkflow returns standard as default for unknown names", () => {
  const wf = getWorkflow("unknown_workflow");
  assert.equal(wf.name, "standard");
});

