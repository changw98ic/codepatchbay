import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { getWorkflow, isWorkflowName, listWorkflows } from "../core/workflow/definition.js";
import { snapshotForJob } from "../server/services/index-freshness.js";

const RUNBOOK_URL = new URL("../docs/product/dw08-migration-runbook.md", import.meta.url);

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

test("getWorkflow returns correct phases for all built-in workflows", () => {
  const standard = getWorkflow("standard");
  const direct = getWorkflow("direct");
  const complex = getWorkflow("complex");
  assert.equal(standard.phases.length, 3);
  assert.equal(direct.phases.length, 2);
  assert.equal(complex.phases.length, 4);
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

test("DW08 migration runbook covers dynamic workflow operational acceptance", async () => {
  const runbook = await readFile(RUNBOOK_URL, "utf8");
  for (const required of [
    "project_capability_map",
    "workflow_dag_materialized",
    "dag_node_started",
    "dag_node_completed",
    "riskmap_generated",
    "dynamic_agent_plan_generated",
    "adversarial_verify",
    "adversarial_verdict",
    "riskMap",
    "dynamicAgentPlan",
    "adversarialVerdict",
    "node --test tests/dw-codegraph-gate.test.mjs tests/riskmap-service.test.mjs tests/engine-prepare-task.test.mjs",
    "node --test tests/queue-orchestrator.test.mjs tests/scheduler-dag-provider.test.mjs",
  ]) {
    assert.match(runbook, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `runbook missing ${required}`);
  }
});
