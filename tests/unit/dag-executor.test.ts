import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  topologicalSort,
  readyNodes,
  isDagComplete,
  getNode,
  validateDag,
  scheduleReadyNodes,
  deriveDagResumeState,
  executeDag,
} from "../../core/workflow/dag-executor.js";

// --- topologicalSort ---

describe("topologicalSort", () => {
  test("sorts linear chain a → b → c", () => {
    const nodes = [
      { id: "a", phase: "plan", dependsOn: [] },
      { id: "b", phase: "execute", dependsOn: ["a"] },
      { id: "c", phase: "verify", dependsOn: ["b"] },
    ];
    const sorted = topologicalSort(nodes);
    assert.deepEqual(sorted, ["a", "b", "c"]);
  });

  test("sorts diamond DAG", () => {
    const nodes = [
      { id: "a", phase: "plan", dependsOn: [] },
      { id: "b", phase: "execute", dependsOn: ["a"] },
      { id: "c", phase: "review", dependsOn: ["a"] },
      { id: "d", phase: "verify", dependsOn: ["b", "c"] },
    ];
    const sorted = topologicalSort(nodes);
    assert.equal(sorted.indexOf("a"), 0);
    assert.ok(sorted.indexOf("b") < sorted.indexOf("d"));
    assert.ok(sorted.indexOf("c") < sorted.indexOf("d"));
  });

  test("handles single node", () => {
    const nodes = [{ id: "solo", phase: "plan", dependsOn: [] }];
    assert.deepEqual(topologicalSort(nodes), ["solo"]);
  });

  test("handles empty array", () => {
    assert.deepEqual(topologicalSort([]), []);
  });

  test("throws on cycle", () => {
    const nodes = [
      { id: "a", phase: "plan", dependsOn: ["b"] },
      { id: "b", phase: "execute", dependsOn: ["a"] },
    ];
    assert.throws(() => topologicalSort(nodes), /cycle/i);
  });
});

// --- readyNodes ---

describe("readyNodes", () => {
  const nodes = [
    { id: "a", phase: "plan", dependsOn: [] },
    { id: "b", phase: "execute", dependsOn: ["a"] },
    { id: "c", phase: "verify", dependsOn: ["a"] },
    { id: "d", phase: "review", dependsOn: ["b", "c"] },
  ];

  test("returns root nodes when nothing completed", () => {
    const ready = readyNodes(nodes, new Set());
    assert.deepEqual(ready, ["a"]);
  });

  test("returns nodes whose deps are all met", () => {
    const ready = readyNodes(nodes, new Set(["a"]));
    assert.deepEqual(ready, ["b", "c"]);
  });

  test("excludes completed nodes", () => {
    const ready = readyNodes(nodes, new Set(["a", "b"]));
    assert.deepEqual(ready, ["c"]);
  });

  test("excludes running nodes", () => {
    const ready = readyNodes(nodes, new Set(["a"]), new Set(["b"]));
    assert.deepEqual(ready, ["c"]);
  });

  test("returns empty when all complete", () => {
    const ready = readyNodes(nodes, new Set(["a", "b", "c", "d"]));
    assert.deepEqual(ready, []);
  });

  test("returns empty when no deps met", () => {
    const ready = readyNodes(nodes, new Set(), new Set());
    assert.deepEqual(ready, ["a"]);
  });
});

// --- isDagComplete ---

describe("isDagComplete", () => {
  const nodes = [
    { id: "a", phase: "plan", dependsOn: [] },
    { id: "b", phase: "execute", dependsOn: ["a"] },
  ];

  test("returns false when incomplete", () => {
    assert.equal(isDagComplete(nodes, new Set(["a"])), false);
  });

  test("returns true when all completed", () => {
    assert.equal(isDagComplete(nodes, new Set(["a", "b"])), true);
  });

  test("returns true for empty nodes", () => {
    assert.equal(isDagComplete([], new Set()), true);
  });
});

// --- getNode ---

describe("getNode", () => {
  const nodes = [
    { id: "a", phase: "plan" },
    { id: "b", phase: "execute" },
  ];

  test("returns node by id", () => {
    const node = getNode(nodes, "b");
    assert.equal(node?.id, "b");
  });

  test("returns null for missing id", () => {
    assert.equal(getNode(nodes, "z"), null);
  });
});

// --- validateDag ---

describe("validateDag", () => {
  test("validates a correct DAG", () => {
    const nodes = [
      { id: "a", phase: "plan", dependsOn: [] },
      { id: "b", phase: "execute", dependsOn: ["a"] },
    ];
    const result = validateDag(nodes);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  test("rejects node missing id", () => {
    const nodes = [{ phase: "plan" }];
    const result = validateDag(nodes);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("missing id")));
  });

  test("rejects duplicate id", () => {
    const nodes = [
      { id: "a", phase: "plan" },
      { id: "a", phase: "execute" },
    ];
    const result = validateDag(nodes);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("duplicate")));
  });

  test("rejects missing phase", () => {
    const nodes = [{ id: "a" }];
    const result = validateDag(nodes);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("missing phase")));
  });

  test("rejects unknown dependency", () => {
    const nodes = [{ id: "a", phase: "plan", dependsOn: ["z"] }];
    const result = validateDag(nodes);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("unknown node")));
  });

  test("rejects cycle", () => {
    const nodes = [
      { id: "a", phase: "plan", dependsOn: ["b"] },
      { id: "b", phase: "execute", dependsOn: ["a"] },
    ];
    const result = validateDag(nodes);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("cycle")));
  });
});

// --- scheduleReadyNodes ---

describe("scheduleReadyNodes", () => {
  const nodes = [
    { id: "a", phase: "plan", dependsOn: [] },
    { id: "b", phase: "execute", dependsOn: ["a"] },
    { id: "c", phase: "review", dependsOn: ["a"] },
  ];

  test("respects maxConcurrent", () => {
    const ready = scheduleReadyNodes(nodes, new Set(), new Set(), 1);
    assert.equal(ready.length, 1);
  });

  test("returns empty when at capacity", () => {
    const ready = scheduleReadyNodes(nodes, new Set(), new Set(["a"]), 1);
    assert.equal(ready.length, 0);
  });

  test("returns all ready when under capacity", () => {
    const ready = scheduleReadyNodes(nodes, new Set(["a"]), new Set(), 5);
    assert.equal(ready.length, 2);
  });

  test("respects provider capacity", () => {
    const ready = scheduleReadyNodes(nodes, new Set(["a"]), new Set(), 5, {
      providerCapacity: () => 0,
      providerKeyForNode: () => "codex",
    });
    assert.deepEqual(ready, []);
  });
});

// --- deriveDagResumeState ---

describe("deriveDagResumeState", () => {
  test("derives from nodeStates with failed node", () => {
    const result = deriveDagResumeState({
      workflowDag: {
        nodes: [
          { id: "a", phase: "plan" },
          { id: "b", phase: "execute", dependsOn: ["a"] },
        ],
      },
      nodeStates: {
        a: { status: "completed" },
        b: { status: "failed", phase: "execute" },
      },
    });
    assert.deepEqual(result.completedNodeIds, ["a"]);
    assert.equal(result.failedNodeId, "b");
    assert.deepEqual(result.readyNodeIds, ["b"]);
    assert.deepEqual(result.resumeTarget, { nodeId: "b", phase: "execute" });
  });

  test("derives from phaseStates fallback", () => {
    const result = deriveDagResumeState({
      phaseStates: {
        plan: { status: "completed" },
        execute: { status: "failed" },
      },
    });
    assert.deepEqual(result.completedNodeIds, ["plan"]);
    assert.equal(result.failedNodeId, "execute");
    assert.deepEqual(result.readyNodeIds, ["execute"]);
  });

  test("returns empty for no state", () => {
    const result = deriveDagResumeState({});
    assert.deepEqual(result.completedNodeIds, []);
    assert.equal(result.failedNodeId, null);
    assert.deepEqual(result.readyNodeIds, []);
  });
});

// --- executeDag ---

describe("executeDag", () => {
  const linearDag = {
    nodes: [
      { id: "a", phase: "plan", dependsOn: [] },
      { id: "b", phase: "execute", dependsOn: ["a"] },
      { id: "c", phase: "verify", dependsOn: ["b"] },
    ],
  };

  test("executes single-node DAG successfully", async () => {
    const dag = { nodes: [{ id: "a", phase: "plan", dependsOn: [] }] };
    const result = await executeDag(dag, {
      executor: async () => ({ ok: true }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.results.get("a")?.ok, true);
  });

  test("executes linear chain in order", async () => {
    const order: string[] = [];
    const result = await executeDag(linearDag, {
      executor: async (node) => {
        order.push(node.id);
        return { ok: true };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(order, ["a", "b", "c"]);
  });

  test("returns failedNode on fatal failure", async () => {
    const result = await executeDag(linearDag, {
      executor: async (node) => {
        if (node.id === "b") return { ok: false, reason: "broke" };
        return { ok: true };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failedNode, "b");
    assert.equal(result.reason, "broke");
  });

  test("retries retryable failure", async () => {
    let attempts = 0;
    const dag = { nodes: [{ id: "a", phase: "plan", dependsOn: [], maxRetries: 3 }] };
    const result = await executeDag(dag, {
      executor: async () => {
        attempts++;
        if (attempts < 3) return { ok: false, retryable: true, reason: "transient" };
        return { ok: true };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(attempts, 3);
  });

  test("gives up after maxRetries exhausted", async () => {
    const dag = { nodes: [{ id: "a", phase: "plan", dependsOn: [], maxRetries: 2 }] };
    const result = await executeDag(dag, {
      executor: async () => ({ ok: false, retryable: true, reason: "always fails" }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failedNode, "a");
  });

  test("reactivates downstream on reactivate signal", async () => {
    let aAttempts = 0;
    let bAttempts = 0;
    const dag = {
      nodes: [
        { id: "a", phase: "plan", dependsOn: [] },
        { id: "b", phase: "execute", dependsOn: ["a"] },
        { id: "c", phase: "verify", dependsOn: ["b"] },
      ],
    };
    const result = await executeDag(dag, {
      executor: async (node) => {
        if (node.id === "a") { aAttempts++; return { ok: true }; }
        if (node.id === "b") {
          bAttempts++;
          // First run: reactivate a — clears a+b+c, forces re-execution
          if (bAttempts === 1) return { ok: false, reactivate: "a", reason: "re-evaluate" };
          return { ok: true };
        }
        return { ok: true };
      },
    });
    // a ran twice (original + after reactivate), b ran twice
    assert.equal(result.ok, true);
    assert.equal(aAttempts, 2);
    assert.equal(bAttempts, 2);
  });

  test("stops when shouldStop returns true", async () => {
    let calls = 0;
    const result = await executeDag(linearDag, {
      executor: async () => { calls++; return { ok: true }; },
      shouldStop: () => calls >= 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "stopped");
  });

  test("stops when signal is aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await executeDag(linearDag, {
      executor: async () => ({ ok: true }),
      signal: ac.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "aborted");
  });

  test("cancels when onBeforeNode returns false", async () => {
    const result = await executeDag(linearDag, {
      executor: async () => ({ ok: true }),
      onBeforeNode: (nodeId) => nodeId !== "b",
    });
    assert.equal(result.ok, false);
    assert.equal(result.failedNode, "b");
    assert.equal(result.reason, "cancelled");
  });

  test("seeds pre-completed nodes", async () => {
    const executed: string[] = [];
    const result = await executeDag(linearDag, {
      executor: async (node) => { executed.push(node.id); return { ok: true }; },
      seedCompleted: ["a"],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(executed, ["b", "c"]);
  });

  test("handles executor exception", async () => {
    const dag = { nodes: [{ id: "a", phase: "plan", dependsOn: [] }] };
    const result = await executeDag(dag, {
      executor: async () => { throw new Error("kaboom"); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failedNode, "a");
    assert.equal(result.results.get("a")?.ok, false);
    assert.ok(result.results.get("a")?.failure?.kind === "executor_exception");
  });

  test("throws when executor callback is missing", async () => {
    const dag = { nodes: [{ id: "a", phase: "plan", dependsOn: [] }] };
    await assert.rejects(() => executeDag(dag, {}), /executor/);
  });

  test("throws on invalid DAG", async () => {
    const dag = { nodes: [{ id: "a", phase: "plan", dependsOn: ["z"] }] };
    await assert.rejects(() => executeDag(dag, { executor: async () => ({ ok: true }) }), /invalid DAG/);
  });
});
