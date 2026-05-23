import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  topologicalSort,
  readyNodes,
  isDagComplete,
  getNode,
  validateDag,
  phasesToDag,
  scheduleReadyNodes,
} from "../core/workflow/dag-executor.js";
import {
  normalizeWorkflow,
  getDagNodes,
  listWorkflows,
  registerDagWorkflow,
} from "../core/workflow/definition.js";
import { readyNodesFor } from "../server/services/supervisor.js";
import { materializeJob } from "../server/services/event-store.js";

const PARALLEL_NODES = [
  { id: "plan", phase: "plan", dependsOn: [] },
  { id: "exec-a", phase: "execute", dependsOn: ["plan"] },
  { id: "exec-b", phase: "execute", dependsOn: ["plan"] },
  { id: "verify", phase: "verify", dependsOn: ["exec-a", "exec-b"] },
];

describe("dag-executor", () => {
  it("topologicalSort returns valid order", () => {
    const sorted = topologicalSort(PARALLEL_NODES);
    assert.ok(sorted.indexOf("plan") < sorted.indexOf("exec-a"));
    assert.ok(sorted.indexOf("plan") < sorted.indexOf("exec-b"));
    assert.ok(sorted.indexOf("exec-a") < sorted.indexOf("verify"));
    assert.ok(sorted.indexOf("exec-b") < sorted.indexOf("verify"));
    assert.equal(sorted.length, 4);
  });

  it("topologicalSort detects cycles", () => {
    const cyclic = [
      { id: "a", phase: "plan", dependsOn: ["b"] },
      { id: "b", phase: "execute", dependsOn: ["a"] },
    ];
    assert.throws(() => topologicalSort(cyclic), /cycle/i);
  });

  it("readyNodes returns initial nodes when nothing completed", () => {
    const ready = readyNodes(PARALLEL_NODES, new Set());
    assert.deepEqual(ready, ["plan"]);
  });

  it("readyNodes returns parallel nodes after plan", () => {
    const ready = readyNodes(PARALLEL_NODES, new Set(["plan"]));
    assert.deepEqual(ready.sort(), ["exec-a", "exec-b"]);
  });

  it("readyNodes excludes running nodes", () => {
    const ready = readyNodes(PARALLEL_NODES, new Set(["plan"]), new Set(["exec-a"]));
    assert.deepEqual(ready, ["exec-b"]);
  });

  it("readyNodes returns verify after both exec complete", () => {
    const ready = readyNodes(PARALLEL_NODES, new Set(["plan", "exec-a", "exec-b"]));
    assert.deepEqual(ready, ["verify"]);
  });

  it("readyNodes returns empty when all complete", () => {
    const ready = readyNodes(PARALLEL_NODES, new Set(["plan", "exec-a", "exec-b", "verify"]));
    assert.deepEqual(ready, []);
  });

  it("isDagComplete", () => {
    assert.equal(isDagComplete(PARALLEL_NODES, new Set()), false);
    assert.equal(isDagComplete(PARALLEL_NODES, new Set(["plan", "exec-a", "exec-b", "verify"])), true);
  });

  it("getNode", () => {
    assert.equal(getNode(PARALLEL_NODES, "plan")?.phase, "plan");
    assert.equal(getNode(PARALLEL_NODES, "nonexistent"), null);
  });

  it("validateDag accepts valid DAG", () => {
    const result = validateDag(PARALLEL_NODES);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it("validateDag rejects missing deps", () => {
    const bad = [{ id: "a", phase: "plan", dependsOn: ["missing"] }];
    const result = validateDag(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes("unknown"));
  });

  it("validateDag rejects duplicate IDs", () => {
    const dup = [
      { id: "a", phase: "plan", dependsOn: [] },
      { id: "a", phase: "execute", dependsOn: [] },
    ];
    const result = validateDag(dup);
    assert.equal(result.valid, false);
  });

  it("phasesToDag creates single-chain DAG", () => {
    const dag = phasesToDag(["plan", "execute", "verify"]);
    assert.equal(dag.length, 3);
    assert.deepEqual(dag[0].dependsOn, []);
    assert.deepEqual(dag[1].dependsOn, ["plan"]);
    assert.deepEqual(dag[2].dependsOn, ["execute"]);
    assert.equal(dag[0].id, "plan");
  });

  it("scheduleReadyNodes respects maxConcurrent", () => {
    const ready = scheduleReadyNodes(PARALLEL_NODES, new Set(["plan"]), new Set(), 1);
    assert.equal(ready.length, 1);
  });
});

describe("workflow DAG integration", () => {
  it("normalizeWorkflow converts standard to single-chain DAG", () => {
    const dag = normalizeWorkflow("standard");
    assert.equal(dag.isDag, true);
    assert.equal(dag.nodes.length, 3);
    assert.equal(dag.nodes[0].id, "plan");
    assert.equal(dag.maxConcurrentNodes, 1);
  });

  it("normalizeWorkflow handles blocked workflow", () => {
    const dag = normalizeWorkflow("blocked");
    assert.equal(dag.isDag, false);
    assert.equal(dag.nodes.length, 0);
  });

  it("getDagNodes returns nodes array", () => {
    const nodes = getDagNodes("complex");
    assert.equal(nodes.length, 4);
    assert.equal(nodes[0].phase, "plan");
    assert.equal(nodes[3].phase, "verify");
  });

  it("registerDagWorkflow creates custom workflow", () => {
    registerDagWorkflow("test-parallel", {
      nodes: [
        { id: "plan", phase: "plan", dependsOn: [] },
        { id: "exec-a", phase: "execute", dependsOn: ["plan"] },
        { id: "exec-b", phase: "execute", dependsOn: ["plan"] },
        { id: "verify", phase: "verify", dependsOn: ["exec-a", "exec-b"] },
      ],
      maxConcurrentNodes: 2,
    });

    assert.ok(listWorkflows().includes("test-parallel"));
    const dag = normalizeWorkflow("test-parallel");
    assert.equal(dag.nodes.length, 4);
    assert.equal(dag.maxConcurrentNodes, 2);
    assert.equal(dag.isDag, true);
  });

  it("registerDagWorkflow rejects invalid DAG", () => {
    assert.throws(() => registerDagWorkflow("bad", {
      nodes: [{ id: "a", phase: "plan", dependsOn: ["b"] }],
    }), /invalid DAG/i);
  });
});

describe("supervisor readyNodesFor", () => {
  it("returns empty for terminal state", () => {
    const result = readyNodesFor({ status: "completed", completedPhases: [] });
    assert.deepEqual(result.ready, []);
  });

  it("returns first phase for empty state", () => {
    const result = readyNodesFor({
      status: "running",
      workflow: "standard",
      completedPhases: [],
      completedNodes: [],
      runningNodes: [],
    });
    assert.equal(result.ready.length, 1);
    assert.equal(result.ready[0], "plan");
  });

  it("returns next phase after plan", () => {
    const result = readyNodesFor({
      status: "running",
      workflow: "standard",
      completedPhases: ["plan"],
      completedNodes: [],
      runningNodes: [],
    });
    assert.equal(result.ready[0], "execute");
  });
});

describe("event-store DAG node projection", () => {
  it("materializes dag_node events", () => {
    const events = [
      { type: "job_created", jobId: "j1", project: "p1", ts: "2026-01-01T00:00:00Z" },
      { type: "dag_node_started", nodeId: "plan", ts: "2026-01-01T00:01:00Z" },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", artifact: "plan-001.md", ts: "2026-01-01T00:02:00Z" },
      { type: "dag_node_started", nodeId: "execute", ts: "2026-01-01T00:03:00Z" },
    ];

    const state = materializeJob(events);
    assert.deepEqual(state.completedNodes, ["plan"]);
    assert.deepEqual(state.runningNodes, ["execute"]);
    assert.deepEqual(state.completedPhases, ["plan"]);
    assert.equal(state.artifacts.plan, "plan-001.md");
  });

  it("materializes dag_node_blocked", () => {
    const events = [
      { type: "job_created", jobId: "j1", project: "p1", ts: "2026-01-01T00:00:00Z" },
      { type: "dag_node_started", nodeId: "plan", ts: "2026-01-01T00:01:00Z" },
      { type: "dag_node_blocked", nodeId: "plan", ts: "2026-01-01T00:02:00Z" },
    ];

    const state = materializeJob(events);
    assert.deepEqual(state.blockedNodes, ["plan"]);
    assert.deepEqual(state.runningNodes, []);
  });

  it("initial state has DAG node fields", () => {
    const state = materializeJob([]);
    assert.deepEqual(state.completedNodes, []);
    assert.deepEqual(state.runningNodes, []);
    assert.deepEqual(state.blockedNodes, []);
  });
});
