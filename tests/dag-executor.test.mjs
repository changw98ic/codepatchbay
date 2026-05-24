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
  executeDag,
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

describe("readyNodesFor fan-out DAG crash/no-duplicate", () => {
  const WORKFLOW = "fan-out-crash-test";

  // Register: plan -> exec-a + exec-b -> verify
  const dagNodes = [
    { id: "plan", phase: "plan", dependsOn: [] },
    { id: "exec-a", phase: "execute", dependsOn: ["plan"] },
    { id: "exec-b", phase: "execute", dependsOn: ["plan"] },
    { id: "verify", phase: "verify", dependsOn: ["exec-a", "exec-b"] },
  ];

  registerDagWorkflow(WORKFLOW, { nodes: dagNodes, maxConcurrentNodes: 2 });

  it("returns both exec nodes after plan completes, not plan itself", () => {
    const result = readyNodesFor({
      status: "running",
      workflow: WORKFLOW,
      completedNodes: ["plan"],
      runningNodes: [],
    });
    assert.ok(result.isDag);
    assert.deepEqual(result.ready.sort(), ["exec-a", "exec-b"]);
    assert.equal(result.ready.includes("plan"), false);
  });

  it("does not duplicate exec-a or return verify when exec-a done and exec-b running", () => {
    const result = readyNodesFor({
      status: "running",
      workflow: WORKFLOW,
      completedNodes: ["plan", "exec-a"],
      runningNodes: ["exec-b"],
    });
    assert.equal(result.ready.includes("exec-a"), false);
    assert.equal(result.ready.includes("verify"), false);
    assert.equal(result.ready.length, 0);
  });

  it("returns verify exactly once after both exec nodes complete", () => {
    const result = readyNodesFor({
      status: "running",
      workflow: WORKFLOW,
      completedNodes: ["plan", "exec-a", "exec-b"],
      runningNodes: [],
    });
    assert.equal(result.ready.length, 1);
    assert.equal(result.ready[0], "verify");
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
    assert.deepEqual(state.nodeStates, {});
  });
});

describe("event-store nodeStates projection", () => {
  it("projects per-node status with timestamps and duration", () => {
    const events = [
      { type: "job_created", jobId: "j1", project: "p1", ts: "2026-01-01T00:00:00Z" },
      { type: "dag_node_started", nodeId: "plan", phase: "plan", ts: "2026-01-01T00:01:00Z" },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", artifact: "plan-001.md", ts: "2026-01-01T00:02:30Z" },
    ];
    const state = materializeJob(events);
    assert.equal(state.nodeStates.plan.status, "completed");
    assert.equal(state.nodeStates.plan.phase, "plan");
    assert.equal(state.nodeStates.plan.artifact, "plan-001.md");
    assert.equal(state.nodeStates.plan.startedAt, "2026-01-01T00:01:00Z");
    assert.equal(state.nodeStates.plan.completedAt, "2026-01-01T00:02:30Z");
    assert.equal(state.nodeStates.plan.durationMs, 90_000);
    assert.deepEqual(state.completedNodes, ["plan"]);
    assert.deepEqual(state.runningNodes, []);
  });

  it("projects failed node with error and duration", () => {
    const events = [
      { type: "dag_node_started", nodeId: "execute", phase: "execute", ts: "2026-01-01T00:01:00Z" },
      { type: "dag_node_failed", nodeId: "execute", phase: "execute", reason: "spawn error", ts: "2026-01-01T00:04:00Z" },
    ];
    const state = materializeJob(events);
    assert.equal(state.nodeStates.execute.status, "failed");
    assert.equal(state.nodeStates.execute.error, "spawn error");
    assert.equal(state.nodeStates.execute.failedAt, "2026-01-01T00:04:00Z");
    assert.equal(state.nodeStates.execute.durationMs, 180_000);
  });

  it("projects retrying node and tracks attempt progression", () => {
    const events = [
      { type: "dag_node_started", nodeId: "execute", phase: "execute", attempt: 1, ts: "T1" },
      { type: "dag_node_retrying", nodeId: "execute", phase: "execute", reason: "timeout", attempt: 2, ts: "T2" },
      { type: "dag_node_started", nodeId: "execute", phase: "execute", attempt: 2, ts: "T3" },
      { type: "dag_node_completed", nodeId: "execute", phase: "execute", ts: "T4" },
    ];
    const state = materializeJob(events);
    assert.equal(state.nodeStates.execute.status, "completed");
    assert.equal(state.nodeStates.execute.attempt, 2);
    assert.equal(state.nodeStates.execute.retryingAt, "T2");
  });

  it("removes retrying nodes from active and completed compatibility arrays", () => {
    const events = [
      { type: "dag_node_started", nodeId: "execute", phase: "execute", attempt: 1, ts: "T1" },
      { type: "dag_node_completed", nodeId: "execute", phase: "execute", ts: "T2" },
      { type: "dag_node_retrying", nodeId: "execute", phase: "execute", reason: "verify failed", attempt: 2, ts: "T3" },
    ];
    const state = materializeJob(events);
    assert.equal(state.nodeStates.execute.status, "retrying");
    assert.deepEqual(state.runningNodes, []);
    assert.deepEqual(state.completedNodes, []);
    assert.deepEqual(state.completedPhases, []);
  });

  it("preserves previous optional fields when later node events omit them", () => {
    const events = [
      { type: "dag_node_started", nodeId: "execute", phase: "execute", attempt: 2, ts: "T1" },
      { type: "dag_node_completed", nodeId: "execute", ts: "T2" },
    ];
    const state = materializeJob(events);
    assert.equal(state.nodeStates.execute.status, "completed");
    assert.equal(state.nodeStates.execute.phase, "execute");
    assert.equal(state.nodeStates.execute.attempt, 2);
  });

  it("projects skipped node", () => {
    const events = [
      { type: "dag_node_skipped", nodeId: "review", phase: "review", reason: "no deliverable", ts: "T1" },
    ];
    const state = materializeJob(events);
    assert.equal(state.nodeStates.review.status, "skipped");
    assert.equal(state.nodeStates.review.reason, "no deliverable");
    assert.equal(state.nodeStates.review.skippedAt, "T1");
  });

  it("projects cancelled node", () => {
    const events = [
      { type: "dag_node_started", nodeId: "verify", phase: "verify", ts: "T1" },
      { type: "dag_node_cancelled", nodeId: "verify", phase: "verify", reason: "cancelled by user", ts: "T2" },
    ];
    const state = materializeJob(events);
    assert.equal(state.nodeStates.verify.status, "cancelled");
    assert.equal(state.nodeStates.verify.reason, "cancelled by user");
    assert.equal(state.nodeStates.verify.cancelledAt, "T2");
    assert.equal(state.nodeStates.verify.durationMs, null);
  });

  it("projects blocked node with timestamp", () => {
    const events = [
      { type: "dag_node_started", nodeId: "plan", ts: "T1" },
      { type: "dag_node_blocked", nodeId: "plan", reason: "waiting for approval", ts: "T2" },
    ];
    const state = materializeJob(events);
    assert.equal(state.nodeStates.plan.status, "blocked");
    assert.equal(state.nodeStates.plan.reason, "waiting for approval");
    assert.equal(state.nodeStates.plan.blockedAt, "T2");
    assert.deepEqual(state.blockedNodes, ["plan"]);
  });

  it("preserves legacy arrays alongside nodeStates", () => {
    const events = [
      { type: "dag_node_started", nodeId: "plan", ts: "T1" },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", ts: "T2" },
      { type: "dag_node_started", nodeId: "execute", ts: "T3" },
      { type: "dag_node_failed", nodeId: "execute", phase: "execute", reason: "error", ts: "T4" },
      { type: "dag_node_blocked", nodeId: "verify", ts: "T5" },
    ];
    const state = materializeJob(events);
    assert.deepEqual(state.completedNodes, ["plan"]);
    assert.deepEqual(state.runningNodes, []);
    assert.deepEqual(state.blockedNodes, ["verify"]);
    assert.equal(state.nodeStates.plan.status, "completed");
    assert.equal(state.nodeStates.execute.status, "failed");
    assert.equal(state.nodeStates.verify.status, "blocked");
  });

  it("reconstructs DAG from events without duplicate completed nodes", () => {
    const events = [
      { type: "dag_node_started", nodeId: "plan", phase: "plan", attempt: 1, ts: "T1" },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", ts: "T2" },
      { type: "dag_node_started", nodeId: "execute", phase: "execute", attempt: 1, ts: "T3" },
      { type: "dag_node_retrying", nodeId: "execute", phase: "execute", reason: "timeout", attempt: 2, ts: "T4" },
      { type: "dag_node_started", nodeId: "execute", phase: "execute", attempt: 2, ts: "T5" },
      { type: "dag_node_completed", nodeId: "execute", phase: "execute", ts: "T6" },
      { type: "dag_node_started", nodeId: "verify", phase: "verify", attempt: 1, ts: "T7" },
      { type: "dag_node_completed", nodeId: "verify", phase: "verify", ts: "T8" },
    ];
    const state = materializeJob(events);
    assert.deepEqual(state.completedNodes, ["plan", "execute", "verify"]);
    assert.equal(state.nodeStates.plan.status, "completed");
    assert.equal(state.nodeStates.execute.status, "completed");
    assert.equal(state.nodeStates.execute.attempt, 2);
    assert.equal(state.nodeStates.verify.status, "completed");
    assert.equal(state.runningNodes.length, 0);
  });
});

describe("executeDag lifecycle event emission", () => {
  it("fires onBeforeNode and onNodeResult in order for success path", async () => {
    const emitted = [];
    const dag = normalizeWorkflow("standard");
    await executeDag(dag, {
      seedCompleted: ["plan"],
      executor: async (node) => {
        emitted.push({ cb: "executor", nodeId: node.id });
        return { ok: true };
      },
      onBeforeNode: async (nodeId) => {
        emitted.push({ cb: "onBeforeNode", nodeId });
      },
      onNodeResult: async (nodeId, result) => {
        emitted.push({ cb: "onNodeResult", nodeId, ok: result.ok });
      },
    });
    // execute → verify (plan is seed-completed)
    const ids = emitted.map((e) => `${e.cb}:${e.nodeId}`);
    assert.ok(ids.indexOf("onBeforeNode:execute") >= 0);
    assert.ok(ids.indexOf("onNodeResult:execute") >= 0);
    assert.ok(ids.indexOf("onBeforeNode:verify") >= 0);
    assert.ok(ids.indexOf("onNodeResult:verify") >= 0);
    // onBeforeNode fires before executor for each node
    const execIdx = ids.indexOf("executor:execute");
    const beforeIdx = ids.indexOf("onBeforeNode:execute");
    assert.ok(beforeIdx < execIdx);
  });

  it("proves retryable result triggers re-execution via callbacks", async () => {
    const emitted = [];
    const dag = normalizeWorkflow("standard");
    let verifyAttempt = 0;
    await executeDag(dag, {
      seedCompleted: ["plan"],
      executor: async (node) => {
        emitted.push({ cb: "executor", nodeId: node.id });
        if (node.phase === "execute") return { ok: true };
        verifyAttempt++;
        if (verifyAttempt === 1) {
          return { ok: false, reason: "flaky", retryable: true };
        }
        return { ok: true };
      },
      onNodeResult: async (nodeId, result) => {
        emitted.push({ cb: "onNodeResult", nodeId, ok: result.ok, retryable: result.retryable });
      },
    });
    // verify was retried
    const verifyResults = emitted.filter((e) => e.nodeId === "verify" && e.cb === "onNodeResult");
    assert.equal(verifyResults.length, 2);
    assert.equal(verifyResults[0].ok, false);
    assert.equal(verifyResults[0].retryable, true);
    assert.equal(verifyResults[1].ok, true);
  });

  it("passes attempt context to lifecycle callbacks", async () => {
    const contexts = [];
    const dag = normalizeWorkflow("standard");
    let verifyAttempt = 0;
    await executeDag(dag, {
      seedCompleted: ["plan", "execute"],
      executor: async () => {
        verifyAttempt++;
        if (verifyAttempt === 1) return { ok: false, retryable: true, reason: "flaky" };
        return { ok: true };
      },
      onBeforeNode: async (nodeId, ctx) => {
        contexts.push({ cb: "before", nodeId, attempt: ctx.attempt, maxAttempts: ctx.maxAttempts });
      },
      onNodeResult: async (nodeId, result, ctx) => {
        contexts.push({ cb: "result", nodeId, ok: result.ok, attempt: ctx.attempt, maxAttempts: ctx.maxAttempts });
      },
    });
    assert.deepEqual(
      contexts.map((entry) => [entry.cb, entry.nodeId, entry.attempt, entry.maxAttempts]),
      [
        ["before", "verify", 1, 3],
        ["result", "verify", 1, 3],
        ["before", "verify", 2, 3],
        ["result", "verify", 2, 3],
      ],
    );
  });

  it("simulates a complete DAG success scenario from events", () => {
    const events = [
      { type: "dag_node_started", nodeId: "plan", phase: "plan", attempt: 1, ts: "2026-01-01T00:00:00Z" },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", artifact: "plan-001.md", ts: "2026-01-01T00:01:00Z" },
      { type: "dag_node_started", nodeId: "execute", phase: "execute", attempt: 1, ts: "2026-01-01T00:02:00Z" },
      { type: "dag_node_completed", nodeId: "execute", phase: "execute", ts: "2026-01-01T00:05:00Z" },
      { type: "dag_node_started", nodeId: "verify", phase: "verify", attempt: 1, ts: "2026-01-01T00:06:00Z" },
      { type: "dag_node_completed", nodeId: "verify", phase: "verify", ts: "2026-01-01T00:08:00Z" },
    ];
    const state = materializeJob(events);
    assert.deepEqual(state.completedNodes, ["plan", "execute", "verify"]);
    assert.equal(state.nodeStates.plan.status, "completed");
    assert.equal(state.nodeStates.plan.durationMs, 60_000);
    assert.equal(state.nodeStates.execute.status, "completed");
    assert.equal(state.nodeStates.execute.durationMs, 180_000);
    assert.equal(state.nodeStates.verify.status, "completed");
    assert.equal(state.nodeStates.verify.durationMs, 120_000);
    assert.deepEqual(state.runningNodes, []);
  });

  it("simulates retry scenario with failure then success", () => {
    const events = [
      { type: "dag_node_started", nodeId: "plan", phase: "plan", attempt: 1, ts: "T0" },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", ts: "T1" },
      { type: "dag_node_started", nodeId: "execute", phase: "execute", attempt: 1, ts: "T2" },
      { type: "dag_node_retrying", nodeId: "execute", phase: "execute", reason: "timeout", attempt: 2, ts: "T3" },
      { type: "dag_node_started", nodeId: "execute", phase: "execute", attempt: 2, ts: "T4" },
      { type: "dag_node_completed", nodeId: "execute", phase: "execute", ts: "T5" },
      { type: "dag_node_started", nodeId: "verify", phase: "verify", attempt: 1, ts: "T6" },
      { type: "dag_node_completed", nodeId: "verify", phase: "verify", ts: "T7" },
    ];
    const state = materializeJob(events);
    assert.deepEqual(state.completedNodes, ["plan", "execute", "verify"]);
    // No duplicate execute in completedNodes
    assert.equal(state.completedNodes.filter((n) => n === "execute").length, 1);
    assert.equal(state.nodeStates.execute.status, "completed");
    assert.equal(state.nodeStates.execute.attempt, 2);
    assert.equal(state.nodeStates.execute.retryingAt, "T3");
  });

  it("reconstructs a reactivate path without leaving stale running nodes", () => {
    const events = [
      { type: "dag_node_started", nodeId: "plan", phase: "plan", attempt: 1, ts: "T0" },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", ts: "T1" },
      { type: "dag_node_started", nodeId: "execute", phase: "execute", attempt: 1, ts: "T2" },
      { type: "dag_node_completed", nodeId: "execute", phase: "execute", artifact: "deliverable-1", ts: "T3" },
      { type: "dag_node_started", nodeId: "verify", phase: "verify", attempt: 1, ts: "T4" },
      { type: "dag_node_failed", nodeId: "verify", phase: "verify", reason: "quality failed", ts: "T5" },
      { type: "dag_node_retrying", nodeId: "execute", phase: "execute", reason: "reactivated by verify", ts: "T6" },
    ];
    const state = materializeJob(events);
    assert.equal(state.nodeStates.verify.status, "failed");
    assert.equal(state.nodeStates.execute.status, "retrying");
    assert.deepEqual(state.runningNodes, []);
    assert.deepEqual(state.completedNodes, ["plan"]);
    assert.deepEqual(state.completedPhases, ["plan"]);
  });
});
