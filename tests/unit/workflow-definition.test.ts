import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getWorkflow,
  nextPhase,
  dispatchForPhase,
  roleForPhase,
  isWorkflowName,
  listWorkflows,
  normalizeWorkflow,
} from "../../core/workflow/definition.js";

// ---------------------------------------------------------------------------
// getWorkflow
// ---------------------------------------------------------------------------

test("getWorkflow returns standard workflow by default for unknown names", () => {
  const wf = getWorkflow("nonexistent-workflow");
  assert.equal(wf.name, "standard");
});

test("getWorkflow returns the standard workflow", () => {
  const wf = getWorkflow("standard");
  assert.equal(wf.name, "standard");
  assert.deepEqual(wf.phases, ["plan", "execute", "verify"]);
});

test("getWorkflow returns the direct workflow", () => {
  const wf = getWorkflow("direct");
  assert.equal(wf.name, "direct");
  assert.deepEqual(wf.phases, ["execute", "verify"]);
});

test("getWorkflow returns the complex workflow with review phase", () => {
  const wf = getWorkflow("complex");
  assert.equal(wf.name, "complex");
  assert.deepEqual(wf.phases, ["plan", "execute", "review", "verify"]);
});

test("getWorkflow returns the blocked workflow with empty phases", () => {
  const wf = getWorkflow("blocked");
  assert.equal(wf.name, "blocked");
  assert.deepEqual(wf.phases, []);
});

// ---------------------------------------------------------------------------
// nextPhase
// ---------------------------------------------------------------------------

test("nextPhase returns first phase when currentPhase is null", () => {
  const wf = getWorkflow("standard");
  assert.equal(nextPhase(wf, null), "plan");
});

test("nextPhase returns first phase when currentPhase is undefined", () => {
  const wf = getWorkflow("standard");
  assert.equal(nextPhase(wf, undefined), "plan");
});

test("nextPhase returns next phase in sequence", () => {
  const wf = getWorkflow("standard");
  assert.equal(nextPhase(wf, "plan"), "execute");
  assert.equal(nextPhase(wf, "execute"), "verify");
});

test("nextPhase returns null after last phase", () => {
  const wf = getWorkflow("standard");
  assert.equal(nextPhase(wf, "verify"), null);
});

test("nextPhase returns null for unknown phase", () => {
  const wf = getWorkflow("standard");
  assert.equal(nextPhase(wf, "nonexistent"), null);
});

test("nextPhase returns null for empty workflow", () => {
  const wf = getWorkflow("blocked");
  assert.equal(nextPhase(wf, null), null);
});

// ---------------------------------------------------------------------------
// dispatchForPhase
// ---------------------------------------------------------------------------

test("dispatchForPhase returns correct role for known phases", () => {
  const wf = getWorkflow("standard");
  assert.equal(dispatchForPhase(wf, "plan"), "planner");
  assert.equal(dispatchForPhase(wf, "execute"), "executor");
  assert.equal(dispatchForPhase(wf, "verify"), "verifier");
});

test("dispatchForPhase returns null for unknown phase", () => {
  const wf = getWorkflow("standard");
  assert.equal(dispatchForPhase(wf, "nonexistent"), null);
});

// ---------------------------------------------------------------------------
// roleForPhase
// ---------------------------------------------------------------------------

test("roleForPhase returns correct role for known phases", () => {
  const wf = getWorkflow("standard");
  assert.equal(roleForPhase(wf, "plan"), "planner");
  assert.equal(roleForPhase(wf, "execute"), "executor");
  assert.equal(roleForPhase(wf, "verify"), "verifier");
});

test("roleForPhase includes reviewer for complex workflow", () => {
  const wf = getWorkflow("complex");
  assert.equal(roleForPhase(wf, "review"), "reviewer");
});

test("roleForPhase returns null for unknown phase", () => {
  const wf = getWorkflow("standard");
  assert.equal(roleForPhase(wf, "review"), null);
});

// ---------------------------------------------------------------------------
// isWorkflowName
// ---------------------------------------------------------------------------

test("isWorkflowName returns true for built-in workflows", () => {
  assert.equal(isWorkflowName("standard"), true);
  assert.equal(isWorkflowName("direct"), true);
  assert.equal(isWorkflowName("complex"), true);
  assert.equal(isWorkflowName("blocked"), true);
});

test("isWorkflowName returns false for unknown workflows", () => {
  assert.equal(isWorkflowName("nonexistent"), false);
  assert.equal(isWorkflowName(""), false);
});

test("isWorkflowName returns false for stub workflows", () => {
  // accelerated is marked as stub: true
  assert.equal(isWorkflowName("accelerated"), false);
});

// ---------------------------------------------------------------------------
// listWorkflows
// ---------------------------------------------------------------------------

test("listWorkflows returns built-in non-stub workflow names", () => {
  const workflows = listWorkflows();
  assert.ok(workflows.includes("standard"));
  assert.ok(workflows.includes("direct"));
  assert.ok(workflows.includes("complex"));
  assert.ok(workflows.includes("blocked"));
});

test("listWorkflows excludes stub workflows", () => {
  const workflows = listWorkflows();
  assert.ok(!workflows.includes("accelerated"));
});

// ---------------------------------------------------------------------------
// normalizeWorkflow
// ---------------------------------------------------------------------------

test("normalizeWorkflow produces a valid DAG for standard workflow", () => {
  const dag = normalizeWorkflow("standard");
  assert.equal(dag.name, "standard");
  assert.equal(dag.isDag, true);
  assert.ok(Array.isArray(dag.nodes));
  assert.ok(dag.nodes.length > 0);
  assert.ok(Array.isArray(dag.edges));
});

test("normalizeWorkflow includes correct edges for standard workflow", () => {
  const dag = normalizeWorkflow("standard");
  // standard: plan -> execute -> verify
  const edgeStrings = dag.edges.map((e: { from: string; to: string }) => `${e.from}->${e.to}`);
  assert.ok(edgeStrings.includes("plan->execute"));
  assert.ok(edgeStrings.includes("execute->verify"));
});

test("normalizeWorkflow includes correct edges for complex workflow", () => {
  const dag = normalizeWorkflow("complex");
  const edgeStrings = dag.edges.map((e: { from: string; to: string }) => `${e.from}->${e.to}`);
  assert.ok(edgeStrings.includes("plan->execute"));
  assert.ok(edgeStrings.includes("execute->review"));
  assert.ok(edgeStrings.includes("review->verify"));
});

test("normalizeWorkflow produces empty nodes for blocked workflow", () => {
  const dag = normalizeWorkflow("blocked");
  assert.equal(dag.name, "blocked");
  assert.deepEqual(dag.nodes, []);
  assert.deepEqual(dag.edges, []);
});

test("normalizeWorkflow returns equivalent results on repeated calls", () => {
  const dag1 = normalizeWorkflow("standard");
  const dag2 = normalizeWorkflow("standard");
  // Same input must produce equivalent output (deterministic, not identity)
  assert.deepEqual(dag1, dag2);
});
