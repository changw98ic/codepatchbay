#!/usr/bin/env node
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { topologicalSort, readyNodes, isDagComplete, getNode, deriveDagResumeState, validateDag, phasesToDag, scheduleReadyNodes, executeDag, } from "../core/workflow/dag-executor.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Shorthand to build a node array. deps default to []. */
function N(id, deps = [], extra = {}) {
    return { id, dependsOn: deps, phase: id, ...extra };
}
/** Wrap node array into a DAG object shape expected by executeDag. */
function dagOf(nodes) {
    return { name: "test-dag", nodes };
}
// ---------------------------------------------------------------------------
// topologicalSort
// ---------------------------------------------------------------------------
describe("topologicalSort", () => {
    it("returns single node unchanged", () => {
        const sorted = topologicalSort([N("a")]);
        assert.deepEqual(sorted, ["a"]);
    });
    it("sorts linear chain in dependency order", () => {
        const nodes = [N("c", ["b"]), N("a"), N("b", ["a"])];
        const sorted = topologicalSort(nodes);
        assert.ok(sorted.indexOf("a") < sorted.indexOf("b"));
        assert.ok(sorted.indexOf("b") < sorted.indexOf("c"));
    });
    it("sorts diamond DAG correctly", () => {
        // a → b, a → c, b → d, c → d
        const nodes = [N("d", ["b", "c"]), N("b", ["a"]), N("c", ["a"]), N("a")];
        const sorted = topologicalSort(nodes);
        assert.ok(sorted.indexOf("a") < sorted.indexOf("b"));
        assert.ok(sorted.indexOf("a") < sorted.indexOf("c"));
        assert.ok(sorted.indexOf("b") < sorted.indexOf("d"));
        assert.ok(sorted.indexOf("c") < sorted.indexOf("d"));
    });
    it("handles independent nodes with no deps", () => {
        const nodes = [N("x"), N("y"), N("z")];
        const sorted = topologicalSort(nodes);
        assert.deepEqual(new Set(sorted), new Set(["x", "y", "z"]));
        assert.equal(sorted.length, 3);
    });
    it("throws on cycle", () => {
        const nodes = [N("a", ["b"]), N("b", ["a"])];
        assert.throws(() => topologicalSort(nodes), /cycle/i);
    });
    it("throws on self-loop", () => {
        const nodes = [N("a", ["a"])];
        assert.throws(() => topologicalSort(nodes), /cycle/i);
    });
    it("throws on larger cycle", () => {
        const nodes = [N("a", ["c"]), N("b", ["a"]), N("c", ["b"])];
        assert.throws(() => topologicalSort(nodes), /cycle/i);
    });
});
// ---------------------------------------------------------------------------
// readyNodes
// ---------------------------------------------------------------------------
describe("readyNodes", () => {
    it("returns all nodes when nothing is completed or running", () => {
        const nodes = [N("a"), N("b"), N("c")];
        assert.deepEqual(readyNodes(nodes, new Set(), new Set()), ["a", "b", "c"]);
    });
    it("excludes completed nodes", () => {
        const nodes = [N("a"), N("b")];
        assert.deepEqual(readyNodes(nodes, new Set(["a"]), new Set()), ["b"]);
    });
    it("excludes running nodes", () => {
        const nodes = [N("a"), N("b")];
        assert.deepEqual(readyNodes(nodes, new Set(), new Set(["a"])), ["b"]);
    });
    it("only returns nodes whose deps are all completed", () => {
        const nodes = [N("a"), N("b", ["a"]), N("c", ["a", "b"])];
        assert.deepEqual(readyNodes(nodes, new Set(["a"]), new Set()), ["b"]);
    });
    it("returns nothing when all deps are unfinished", () => {
        const nodes = [N("b", ["a"]), N("c", ["a"])];
        assert.deepEqual(readyNodes(nodes, new Set(), new Set()), []);
    });
});
// ---------------------------------------------------------------------------
// isDagComplete
// ---------------------------------------------------------------------------
describe("isDagComplete", () => {
    it("returns false when nothing is completed", () => {
        assert.equal(isDagComplete([N("a"), N("b")], new Set()), false);
    });
    it("returns true when all nodes are completed", () => {
        assert.equal(isDagComplete([N("a"), N("b")], new Set(["a", "b"])), true);
    });
    it("returns false when some nodes are incomplete", () => {
        assert.equal(isDagComplete([N("a"), N("b")], new Set(["a"])), false);
    });
    it("returns true for empty node list", () => {
        assert.equal(isDagComplete([], new Set()), true);
    });
});
// ---------------------------------------------------------------------------
// getNode
// ---------------------------------------------------------------------------
describe("getNode", () => {
    it("finds node by id", () => {
        const nodes = [N("a"), N("b")];
        assert.equal(getNode(nodes, "a")?.id, "a");
    });
    it("returns null for missing id", () => {
        assert.equal(getNode([N("a")], "z"), null);
    });
});
// ---------------------------------------------------------------------------
// deriveDagResumeState
// ---------------------------------------------------------------------------
describe("deriveDagResumeState", () => {
    const workflowDag = {
        name: "test",
        nodes: [
            { id: "plan", phase: "plan", dependsOn: [] },
            { id: "exec", phase: "execute", dependsOn: ["plan"] },
            { id: "verify", phase: "verify", dependsOn: ["exec"] },
        ],
    };
    it("returns empty state with no input", () => {
        const state = deriveDagResumeState();
        assert.deepEqual(state.completedNodeIds, []);
        assert.equal(state.failedNodeId, null);
        assert.equal(state.resumeTarget, null);
    });
    it("derives completed and ready from node states", () => {
        const state = deriveDagResumeState({
            workflowDag,
            nodeStates: { plan: { status: "completed" } },
        });
        assert.deepEqual(state.completedNodeIds, ["plan"]);
        assert.deepEqual(state.readyNodeIds, ["exec"]);
        assert.equal(state.failedNodeId, null);
    });
    it("identifies failed node and sets resumeTarget", () => {
        const state = deriveDagResumeState({
            workflowDag,
            nodeStates: {
                plan: { status: "completed" },
                exec: { status: "failed", phase: "execute" },
            },
        });
        assert.equal(state.failedNodeId, "exec");
        assert.equal(state.resumeTarget?.nodeId, "exec");
        assert.equal(state.resumeTarget?.phase, "execute");
    });
    it("falls back to phaseStates when no workflowDag nodes", () => {
        const state = deriveDagResumeState({
            nodeStates: {},
            phaseStates: { plan: "completed", execute: "failed" },
        });
        assert.deepEqual(state.completedNodeIds, ["plan"]);
        assert.equal(state.failedNodeId, "execute");
        assert.equal(state.resumeTarget?.phase, "execute");
    });
    it("skipped nodes count as completed", () => {
        const state = deriveDagResumeState({
            workflowDag,
            nodeStates: { plan: { status: "skipped" } },
        });
        assert.deepEqual(state.completedNodeIds, ["plan"]);
        assert.deepEqual(state.readyNodeIds, ["exec"]);
    });
    it("running nodes are excluded from ready but not failed", () => {
        const state = deriveDagResumeState({
            workflowDag,
            nodeStates: { plan: { status: "running" } },
        });
        assert.deepEqual(state.completedNodeIds, []);
        assert.deepEqual(state.readyNodeIds, []);
    });
});
// ---------------------------------------------------------------------------
// validateDag
// ---------------------------------------------------------------------------
describe("validateDag", () => {
    it("accepts a valid DAG", () => {
        const result = validateDag([N("a"), N("b", ["a"])]);
        assert.equal(result.valid, true);
    });
    it("rejects duplicate node ids", () => {
        const result = validateDag([N("a"), N("a")]);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => /duplicate/.test(e)));
    });
    it("rejects node missing id", () => {
        const result = validateDag([{ phase: "x" }]);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => /missing id/.test(e)));
    });
    it("rejects dependency on unknown node", () => {
        const result = validateDag([N("a", ["ghost"])]);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => /unknown/.test(e)));
    });
    it("rejects cyclic DAG", () => {
        const result = validateDag([N("a", ["b"]), N("b", ["a"])]);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => /cycle/i.test(e)));
    });
    it("rejects node missing phase", () => {
        const result = validateDag([{ id: "x", dependsOn: [] }]);
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => /missing phase/.test(e)));
    });
});
// ---------------------------------------------------------------------------
// phasesToDag
// ---------------------------------------------------------------------------
describe("phasesToDag", () => {
    it("converts linear phases to single-chain DAG", () => {
        const dag = phasesToDag(["plan", "execute", "verify"]);
        assert.equal(dag.length, 3);
        assert.deepEqual(dag[0].dependsOn, []);
        assert.deepEqual(dag[1].dependsOn, ["plan"]);
        assert.deepEqual(dag[2].dependsOn, ["execute"]);
    });
    it("assigns roles from roleForPhase map", () => {
        const dag = phasesToDag(["plan", "exec"], { plan: "codex" });
        assert.equal(dag[0].role, "codex");
        assert.equal(dag[1].role, null);
    });
    it("sets agent on every node when provided", () => {
        const dag = phasesToDag(["a", "b"], {}, "my-agent");
        assert.equal(dag[0].agent, "my-agent");
        assert.equal(dag[1].agent, "my-agent");
    });
    it("handles single phase", () => {
        const dag = phasesToDag(["solo"]);
        assert.equal(dag.length, 1);
        assert.deepEqual(dag[0].dependsOn, []);
    });
});
// ---------------------------------------------------------------------------
// scheduleReadyNodes
// ---------------------------------------------------------------------------
describe("scheduleReadyNodes", () => {
    it("returns ready nodes up to concurrency limit", () => {
        const nodes = [N("a"), N("b"), N("c")];
        const result = scheduleReadyNodes(nodes, new Set(), new Set(), 2);
        assert.equal(result.length, 2);
    });
    it("returns zero when maxConcurrent is reached", () => {
        const nodes = [N("a"), N("b")];
        const result = scheduleReadyNodes(nodes, new Set(), new Set(["a", "b"]), 2);
        assert.equal(result.length, 0);
    });
    it("deducts running count from available slots", () => {
        const nodes = [N("a"), N("b"), N("c")];
        const result = scheduleReadyNodes(nodes, new Set(), new Set(["a"]), 2);
        assert.equal(result.length, 1);
    });
});
// ---------------------------------------------------------------------------
// executeDag
// ---------------------------------------------------------------------------
describe("executeDag", () => {
    it("executes linear DAG calling executor for each node", async () => {
        const visited = [];
        const dag = dagOf([N("a"), N("b", ["a"]), N("c", ["b"])]);
        const result = await executeDag(dag, {
            executor: async (node) => {
                visited.push(node.id);
                return { ok: true };
            },
        });
        assert.equal(result.ok, true);
        assert.deepEqual(visited, ["a", "b", "c"]);
    });
    it("returns failure when executor fails", async () => {
        const dag = dagOf([N("a")]);
        const result = await executeDag(dag, {
            executor: async () => ({ ok: false, reason: "boom" }),
        });
        assert.equal(result.ok, false);
        assert.equal(result.failedNode, "a");
        assert.equal(result.reason, "boom");
    });
    it("stops when shouldStop returns true", async () => {
        let callCount = 0;
        const dag = dagOf([N("a"), N("b", ["a"])]);
        const result = await executeDag(dag, {
            executor: async (node) => {
                callCount++;
                return { ok: true };
            },
            shouldStop: () => callCount >= 1,
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "stopped");
        assert.equal(callCount, 1);
    });
    it("cancels when onBeforeNode returns false", async () => {
        const dag = dagOf([N("a")]);
        const result = await executeDag(dag, {
            executor: async () => ({ ok: true }),
            onBeforeNode: async () => false,
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, "cancelled");
    });
    it("calls onNodeResult for each node", async () => {
        const results = [];
        const dag = dagOf([N("a"), N("b", ["a"])]);
        await executeDag(dag, {
            executor: async (node) => ({ ok: true }),
            onNodeResult: async (nodeId) => { results.push(nodeId); },
        });
        assert.deepEqual(results, ["a", "b"]);
    });
    it("uses seedCompleted to skip already-done nodes", async () => {
        const visited = [];
        const dag = dagOf([N("a"), N("b", ["a"]), N("c", ["b"])]);
        const result = await executeDag(dag, {
            executor: async (node) => { visited.push(node.id); return { ok: true }; },
            seedCompleted: ["a", "b"],
        });
        assert.equal(result.ok, true);
        assert.deepEqual(visited, ["c"]);
    });
    it("reactivates upstream node and retries chain", async () => {
        let attempt = 0;
        const dag = dagOf([N("a"), N("b", ["a"])]);
        const result = await executeDag(dag, {
            executor: async (node, ctx) => {
                if (node.id === "a" && ctx.attempt === 1) {
                    attempt = ctx.attempt;
                    return { ok: false, reactivate: "a", reason: "need redo" };
                }
                return { ok: true };
            },
        });
        // reactivate clears completed and the node retries
        assert.equal(result.ok, true);
        assert.equal(attempt, 1);
    });
    it("retries retryable failure up to maxAttempts", async () => {
        let calls = 0;
        const dag = dagOf([{ id: "a", dependsOn: [], phase: "a", maxRetries: 3 }]);
        const result = await executeDag(dag, {
            executor: async () => {
                calls++;
                return calls < 3 ? { ok: false, retryable: true, reason: "temp" } : { ok: true };
            },
        });
        assert.equal(result.ok, true);
        assert.equal(calls, 3);
    });
});
