/**
 * Phase 0 characterization: DAG wave + resume/retry execution contract.
 *
 * Pins the CURRENT execution invariants that Phase 4 (runDagNode execution-chain
 * split) must preserve. These tests assert behavior of the real functions in
 * core/engine/run-job-planning.ts (dagSequentialExecutionPlan,
 * normalizeDagResumeContext, attachChecklistIdsToWorkflowDag,
 * recoveredArtifactForPhase, recoveredVerdictForPhase) and the now-exported
 * wave/resume helpers in core/engine/run-job-execute-dag.ts
 * (isParallelNodeCandidate, parallelConflictKeys, pickExecutionBatch,
 * stableReadyNodes, maxConcurrentFromDag, rerunDagFromPhase).
 *
 * Planning helpers are pure and driven directly. Wave helpers are pure over
 * (nodes, sets) and driven directly. rerunDagFromPhase is driven via fake
 * injected ports (appendEvent/failJob + an aborted AbortSignal) so runDagNode
 * returns a deterministic terminal on the first visited node without invoking
 * the real phase pipeline. The full executeWorkflowDag wave loop and the
 * ignoreResume=true span inside rerunDagFromPhase are undrivable here (see
 * concerns) because they require the full runPhase/agent harness.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachChecklistIdsToWorkflowDag,
  dagSequentialExecutionPlan,
  normalizeDagResumeContext,
  recoveredArtifactForPhase,
  recoveredVerdictForPhase,
  type WorkflowDag,
  type WorkflowDagNode,
} from "../core/engine/run-job-planning.js";

import {
  isParallelNodeCandidate,
  maxConcurrentFromDag,
  parallelConflictKeys,
  pickExecutionBatch,
  rerunDagFromPhase,
  stableReadyNodes,
} from "../core/engine/run-job-execute-dag.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function dagNode(id: string, extra: Record<string, unknown> = {}): WorkflowDagNode {
  return { id, phase: id, ...extra } as WorkflowDagNode;
}

function review(id: string, extra: Record<string, unknown> = {}): WorkflowDagNode {
  return { id, phase: "review", ...extra } as WorkflowDagNode;
}

function dag(nodes: WorkflowDagNode[], maxConcurrentNodes?: number): WorkflowDag {
  return { nodes, ...(maxConcurrentNodes === undefined ? {} : { maxConcurrentNodes }) } as WorkflowDag;
}

function idsOf(nodes: WorkflowDagNode[] | undefined): string[] {
  return (nodes || []).map((n) => n.id);
}

type RerunSession = Parameters<typeof rerunDagFromPhase>[0];

/**
 * Build a rerunDagFromPhase session whose ctx signal is already aborted.
 * runDagNode checks ctx.signal.aborted BEFORE the resume check, so every node
 * visited produces a deterministic RUNTIME_INTERRUPTED terminal via
 * handleDagNodeFailure, without invoking the real runPhase/agent pipeline.
 *
 * The first dag_node_failed event recorded by the fake appendEvent therefore
 * identifies the first node rerunDagFromPhase visited — pinning "starts at the
 * retry phase".
 */
function abortedRerunSession(record: { appendEvent: Array<Record<string, unknown>>; failJob: Array<Record<string, unknown>> }): RerunSession {
  const controller = new AbortController();
  controller.abort();
  const appendEvent = async (_cpbRoot: string, _project: string, _jobId: string, payload: Record<string, unknown>) => {
    record.appendEvent.push(payload);
    return payload;
  };
  const failJob = async (_cpbRoot: string, _project: string, _jobId: string, payload: Record<string, unknown>) => {
    record.failJob.push(payload);
    return payload;
  };
  return {
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-1",
    attemptId: "att-1",
    phaseResults: [],
    phaseRoleMap: {},
    resumeCompletedNodes: new Set<string>(),
    dagResumeContext: { completedNodeIds: [], resumeTarget: null },
    phaseSourceContext: {},
    ctx: {
      signal: controller.signal,
      appendEvent,
      failJob,
      onProgress: null,
    },
  } as unknown as RerunSession;
}

// ===========================================================================
// SECTION 1 — dagSequentialExecutionPlan: stable ready order (planning layer)
// ===========================================================================
//
// readyNodeIds is the internal basis of dagSequentialExecutionPlan; its rule
// (skip completed nodes; a node is ready when every dependsOn is completed;
// iteration follows the nodes-array order) is characterized here through the
// public plan output.

test("dagSequentialExecutionPlan returns [] for an empty workflow", () => {
  assert.deepEqual(idsOf(dagSequentialExecutionPlan(dag([]))), []);
});

test("dagSequentialExecutionPlan returns [] when nodes are absent", () => {
  assert.deepEqual(idsOf(dagSequentialExecutionPlan({})), []);
});

test("dagSequentialExecutionPlan yields a linear dependency chain in order", () => {
  const nodes = [
    dagNode("A"),
    dagNode("B", { dependsOn: ["A"] }),
    dagNode("C", { dependsOn: ["B"] }),
  ];
  assert.deepEqual(idsOf(dagSequentialExecutionPlan(dag(nodes))), ["A", "B", "C"]);
});

test("dagSequentialExecutionPlan breaks ties by nodes-array order (stable)", () => {
  // Diamond: A -> {B, C} -> D. B precedes C in the array, so B is picked first.
  const nodes = [
    dagNode("A"),
    dagNode("B", { dependsOn: ["A"] }),
    dagNode("C", { dependsOn: ["A"] }),
    dagNode("D", { dependsOn: ["B", "C"] }),
  ];
  assert.deepEqual(idsOf(dagSequentialExecutionPlan(dag(nodes))), ["A", "B", "C", "D"]);

  // Same diamond, but C precedes B in the array — order flips accordingly.
  const reordered = [nodes[0], nodes[2], nodes[1], nodes[3]];
  assert.deepEqual(idsOf(dagSequentialExecutionPlan(dag(reordered))), ["A", "C", "B", "D"]);
});

test("dagSequentialExecutionPlan throws on a cycle (no ready node can advance)", () => {
  const nodes = [
    dagNode("A", { dependsOn: ["B"] }),
    dagNode("B", { dependsOn: ["A"] }),
  ];
  assert.throws(() => dagSequentialExecutionPlan(dag(nodes)), /DAG has no ready node after 0\/2 node\(s\)/);
});

test("dagSequentialExecutionPlan throws when a dependency is never satisfied", () => {
  // A depends on X, but X is not in the workflow — A can never become ready.
  const nodes = [dagNode("A", { dependsOn: ["X"] }), dagNode("Y")];
  assert.throws(() => dagSequentialExecutionPlan(dag(nodes)), /DAG has no ready node after 1\/2 node\(s\)/);
});

test("dagSequentialExecutionPlan ignores a node's dependsOn when it is not an array", () => {
  // dependsOn as a non-array is treated as [] by readyNodeIds.
  const nodes = [dagNode("A", { dependsOn: "not-an-array" }), dagNode("B")];
  assert.deepEqual(idsOf(dagSequentialExecutionPlan(dag(nodes))), ["A", "B"]);
});

// ===========================================================================
// SECTION 2 — normalizeDagResumeContext: resume-skip dedup + merge
// ===========================================================================

test("normalizeDagResumeContext defaults to empty when source is absent or non-record", () => {
  assert.deepEqual(normalizeDagResumeContext(), { completedNodeIds: [], resumeTarget: null });
  assert.deepEqual(normalizeDagResumeContext(null), { completedNodeIds: [], resumeTarget: null });
  assert.deepEqual(normalizeDagResumeContext("nope"), { completedNodeIds: [], resumeTarget: null });
});

test("normalizeDagResumeContext merges completedNodeIds from dagResume, retry, and previousFailure", () => {
  const merged = normalizeDagResumeContext({
    dagResume: { completedNodeIds: ["a", "b"] },
    retry: { completedNodeIds: ["b", "c"] },
    previousFailure: { completedNodeIds: ["c", "d"] },
  });
  // dagResume contributes first, then retry, then previousFailure, deduped.
  assert.deepEqual(merged.completedNodeIds, ["a", "b", "c", "d"]);
});

test("normalizeDagResumeContext filters non-string / falsy entries via arrayOfStrings", () => {
  const merged = normalizeDagResumeContext({
    dagResume: { completedNodeIds: ["a", null, "", undefined, 0, "b"] },
  });
  assert.deepEqual(merged.completedNodeIds, ["a", "b"]);
});

test("normalizeDagResumeContext coerces numeric ids to strings", () => {
  const merged = normalizeDagResumeContext({
    retry: { completedNodeIds: [1, 2, 3] },
  });
  assert.deepEqual(merged.completedNodeIds, ["1", "2", "3"]);
});

test("normalizeDagResumeContext picks resumeTarget with retry > dagResume > previousFailure priority", () => {
  const retryFirst = normalizeDagResumeContext({
    retry: { resumeTarget: { phase: "verify", nodeId: "n-v" } },
    dagResume: { resumeTarget: { phase: "execute", nodeId: "n-e" } },
    previousFailure: { resumeTarget: { phase: "plan", nodeId: "n-p" } },
  });
  assert.deepEqual(retryFirst.resumeTarget, { phase: "verify", nodeId: "n-v" });

  const dagResumeNext = normalizeDagResumeContext({
    dagResume: { resumeTarget: { phase: "execute" } },
    previousFailure: { resumeTarget: { phase: "plan" } },
  });
  assert.deepEqual(dagResumeNext.resumeTarget, { phase: "execute" });

  const previousOnly = normalizeDagResumeContext({
    previousFailure: { resumeTarget: { phase: "plan" } },
  });
  assert.deepEqual(previousOnly.resumeTarget, { phase: "plan" });
});

test("normalizeDagResumeContext drops a non-record resumeTarget to null", () => {
  // A truthy but non-record resumeTarget (string) wins the || chain but fails
  // the isRecord guard and collapses to null.
  const dropped = normalizeDagResumeContext({ retry: { resumeTarget: "not-a-record" } });
  assert.equal(dropped.resumeTarget, null);
});

test("normalizeDagResumeContext shallow-copies the resumeTarget record", () => {
  const target = { phase: "verify", nodeId: "n-v" };
  const merged = normalizeDagResumeContext({ retry: { resumeTarget: target } });
  assert.notEqual(merged.resumeTarget, target);
  assert.deepEqual(merged.resumeTarget, target);
});

// ===========================================================================
// SECTION 3 — attachChecklistIdsToWorkflowDag: canonical checklist binding
// ===========================================================================

function checklistWith(items: Array<{ id?: unknown; required?: unknown }>) {
  return { items };
}

test("attachChecklistIdsToWorkflowDag leaves nodes untouched when no checklist items exist", () => {
  const nodes = [dagNode("A", { phase: "execute" }), dagNode("B", { phase: "review" })];
  const attached = attachChecklistIdsToWorkflowDag(dag(nodes), null);
  assert.deepEqual(attached.nodes.map((n) => n.checklistIds), [undefined, undefined]);
});

test("attachChecklistIdsToWorkflowDag binds required ids onto canonical execute/verify/adversarial_verify nodes", () => {
  const nodes = [
    dagNode("exec", { phase: "execute" }),
    dagNode("ver", { phase: "verify" }),
    dagNode("adv", { phase: "adversarial_verify" }),
  ];
  const attached = attachChecklistIdsToWorkflowDag(
    dag(nodes),
    checklistWith([
      { id: "AC-1", required: true },
      { id: "AC-2", required: false },
      { id: "AC-3", required: true },
    ]),
  );
  // Only required items contribute ids; order preserved.
  for (const node of attached.nodes) {
    assert.deepEqual(node.checklistIds, ["AC-1", "AC-3"]);
    assert.equal(node.checklistBindingSource, "canonical-default");
  }
});

test("attachChecklistIdsToWorkflowDag leaves plan nodes untouched", () => {
  const nodes = [dagNode("plan", { phase: "plan" })];
  const attached = attachChecklistIdsToWorkflowDag(
    dag(nodes),
    checklistWith([{ id: "AC-1", required: true }]),
  );
  assert.equal(attached.nodes[0].checklistIds, undefined);
  assert.equal(attached.nodes[0].checklistBindingSource, undefined);
});

test("attachChecklistIdsToWorkflowDag leaves custom / sideEffecting / remediate / review nodes untouched unless checklistNeutral", () => {
  const nodes = [
    dagNode("custom-exec", { phase: "execute", custom: true }),
    dagNode("side-exec", { phase: "execute", sideEffecting: true }),
    dagNode("rem", { phase: "remediate" }),
    dagNode("rev", { phase: "review" }),
    dagNode("rev-neutral", { phase: "review", checklistNeutral: true }),
  ];
  const attached = attachChecklistIdsToWorkflowDag(
    dag(nodes),
    checklistWith([{ id: "AC-1", required: true }]),
  );
  // Non-neutral mutation/repair/owning nodes keep their original (absent) ids.
  assert.equal(attached.nodes[0].checklistIds, undefined);
  assert.equal(attached.nodes[1].checklistIds, undefined);
  assert.equal(attached.nodes[2].checklistIds, undefined);
  assert.equal(attached.nodes[3].checklistIds, undefined);
  // A checklistNeutral node is forced to an empty binding (explicitly non-bound).
  assert.deepEqual(attached.nodes[4].checklistIds, []);
});

// ===========================================================================
// SECTION 4 — recoveredArtifactForPhase / recoveredVerdictForPhase: resume artifact recovery
// ===========================================================================

test("recoveredArtifactForPhase returns null when no retry/previousFailure artifact exists", () => {
  assert.equal(recoveredArtifactForPhase({}, "review", {}), null);
  assert.equal(recoveredArtifactForPhase({ retry: {} }, "review", {}), null);
});

test("recoveredArtifactForPhase prefers retry.artifacts over previousFailure.artifacts", () => {
  const out = recoveredArtifactForPhase(
    { retry: { artifacts: { review: "/abs/retry.md" } }, previousFailure: { artifacts: { review: "/abs/prev.md" } } },
    "review",
    {},
  );
  assert.equal(out?.name, "/abs/retry.md");
  assert.equal(out?.path, "/abs/retry.md");
});

test("recoveredArtifactForPhase maps artifact kind by phase", () => {
  const cases: Array<{ phase: string; kind: string }> = [
    { phase: "plan", kind: "plan" },
    { phase: "execute", kind: "deliverable" },
    { phase: "remediate", kind: "deliverable" },
    { phase: "verify", kind: "verdict" },
    { phase: "adversarial_verify", kind: "verdict" },
    { phase: "review", kind: "review" },
    { phase: "custom-phase", kind: "custom-phase" },
  ];
  for (const { phase, kind } of cases) {
    const out = recoveredArtifactForPhase(
      { previousFailure: { artifacts: { [phase]: "/abs/x.md" } } },
      phase,
      {},
    );
    assert.equal(out?.kind, kind, `kind for phase ${phase}`);
  }
});

test("recoveredArtifactForPhase accepts a record artifact payload, preserving explicit path", () => {
  const out = recoveredArtifactForPhase(
    { retry: { artifacts: { execute: { name: "deliverable-001", path: "/abs/d-001.md" } } } },
    "execute",
    {},
  );
  assert.equal(out?.kind, "deliverable");
  assert.equal(out?.name, "deliverable-001");
  assert.equal(out?.path, "/abs/d-001.md");
});

test("recoveredVerdictForPhase returns retry verdict first, then previousFailure, for verify-family phases", () => {
  assert.deepEqual(
    recoveredVerdictForPhase({ retry: { verdict: { pass: true } }, previousFailure: { verdict: { pass: false } } }, "verify"),
    { pass: true },
  );
  assert.deepEqual(
    recoveredVerdictForPhase({ previousFailure: { verdict: { pass: false } } }, "verify"),
    { pass: false },
  );
  assert.deepEqual(
    recoveredVerdictForPhase({ retry: { adversarialVerdict: { kind: "ok" } } }, "adversarial_verify"),
    { kind: "ok" },
  );
  assert.equal(recoveredVerdictForPhase({ retry: { verdict: {} } }, "execute"), null);
});

// ===========================================================================
// SECTION 5 — isParallelNodeCandidate: ONLY review safe-candidate rule
// ===========================================================================

test("isParallelNodeCandidate only accepts non-resumed canonical review nodes", () => {
  const resumed = new Set<string>(["rev-resumed"]);
  assert.equal(isParallelNodeCandidate(review("rev"), resumed), true);

  // Every non-review canonical phase is excluded by construction.
  assert.equal(isParallelNodeCandidate(dagNode("e", { phase: "execute" }), resumed), false);
  assert.equal(isParallelNodeCandidate(dagNode("v", { phase: "verify" }), resumed), false);
  assert.equal(isParallelNodeCandidate(dagNode("av", { phase: "adversarial_verify" }), resumed), false);
  assert.equal(isParallelNodeCandidate(dagNode("p", { phase: "plan" }), resumed), false);
  assert.equal(isParallelNodeCandidate(dagNode("rem", { phase: "remediate" }), resumed), false);
});

test("isParallelNodeCandidate excludes custom, sideEffecting, parallelSafe:false, and resumed review nodes", () => {
  const resumed = new Set<string>(["rev-resumed"]);
  assert.equal(isParallelNodeCandidate(review("rev-resumed"), resumed), false);
  assert.equal(isParallelNodeCandidate(review("c", { custom: true }), resumed), false);
  assert.equal(isParallelNodeCandidate(review("s", { sideEffecting: true }), resumed), false);
  assert.equal(isParallelNodeCandidate(review("u", { parallelSafe: false }), resumed), false);
});

// ===========================================================================
// SECTION 6 — parallelConflictKeys: merge conflictKey + conflictKeys, deduped
// ===========================================================================

test("parallelConflictKeys merges conflictKey ahead of conflictKeys and dedupes", () => {
  assert.deepEqual(parallelConflictKeys(review("r")), []);
  assert.deepEqual(parallelConflictKeys(review("r", { conflictKey: "a" })), ["a"]);
  assert.deepEqual(parallelConflictKeys(review("r", { conflictKeys: ["b", "c"] })), ["b", "c"]);
  // conflictKey is unshifted to the front, then deduped (insertion-order stable).
  assert.deepEqual(parallelConflictKeys(review("r", { conflictKey: "a", conflictKeys: ["b", "a"] })), ["a", "b"]);
  // Non-array conflictKeys is ignored; only conflictKey contributes.
  assert.deepEqual(parallelConflictKeys(review("r", { conflictKeys: "nope", conflictKey: "k" })), ["k"]);
  // CURRENT BEHAVIOR (characterization): only EMPTY-STRING entries are filtered —
  // conflictKeys is String()-coerced BEFORE the Boolean filter, so null -> "null"
  // (truthy) SURVIVES (same for undefined -> "undefined", 0 -> "0"). Phase 4's
  // extraction of this helper may tighten the filter; until then this pins the quirk.
  assert.deepEqual(parallelConflictKeys(review("r", { conflictKeys: ["", "k", null as unknown as string] })), ["k", "null"]);
});

// ===========================================================================
// SECTION 7 — pickExecutionBatch: capacity clamp + conflict-key batching
// ===========================================================================

test("pickExecutionBatch returns [] for an empty ready set", () => {
  assert.deepEqual(pickExecutionBatch([], 4, new Set<string>()), []);
});

test("pickExecutionBatch collapses to a single first node when capacity is <= 1", () => {
  const ready = [review("r1"), review("r2"), review("r3")];
  // capacity 1 → single first node, even if all are parallel candidates.
  assert.deepEqual(idsOf(pickExecutionBatch(ready, 1, new Set<string>())), ["r1"]);
  // Non-finite capacity also collapses to 1.
  assert.deepEqual(idsOf(pickExecutionBatch(ready, Number.NaN, new Set<string>())), ["r1"]);
});

test("pickExecutionBatch keeps a non-review first node exclusive (no parallel fan-out)", () => {
  // Even with capacity 4, a leading execute node yields a single-node batch.
  const ready: WorkflowDagNode[] = [dagNode("e", { phase: "execute" }), review("r1"), review("r2")];
  assert.deepEqual(idsOf(pickExecutionBatch(ready, 4, new Set<string>())), ["e"]);
});

test("pickExecutionBatch batches parallel-safe review nodes up to capacity", () => {
  const ready = [review("r1"), review("r2"), review("r3"), review("r4")];
  assert.deepEqual(idsOf(pickExecutionBatch(ready, 3, new Set<string>())), ["r1", "r2", "r3"]);
  assert.deepEqual(idsOf(pickExecutionBatch(ready, 2, new Set<string>())), ["r1", "r2"]);
});

test("pickExecutionBatch stops the batch at the first conflict-key collision", () => {
  // r1 (no conflict) + r2 holds "k"; r3 also wants "k" → collision, batch stops.
  const ready = [
    review("r1"),
    review("r2", { conflictKeys: ["k"] }),
    review("r3", { conflictKeys: ["k"] }),
    review("r4", { conflictKeys: ["k2"] }),
  ];
  assert.deepEqual(idsOf(pickExecutionBatch(ready, 4, new Set<string>())), ["r1", "r2"]);
});

test("pickExecutionBatch stops the batch at the first non-parallel-candidate review node", () => {
  // r2 is parallelSafe:false → isParallelNodeCandidate false → batch stops at r1.
  const ready = [review("r1"), review("r2", { parallelSafe: false }), review("r3")];
  assert.deepEqual(idsOf(pickExecutionBatch(ready, 4, new Set<string>())), ["r1"]);
});

test("pickExecutionBatch stops the batch when a resumed review node is the first ready node", () => {
  // r1 is in resumeCompletedNodes → not a parallel candidate. Because it is the
  // FIRST ready node, the whole batch collapses to [r1] (the main loop will then
  // resume r1 rather than re-run it).
  const ready = [review("r1"), review("r2"), review("r3")];
  assert.deepEqual(idsOf(pickExecutionBatch(ready, 4, new Set(["r1"]))), ["r1"]);
});

test("pickExecutionBatch accumulates held conflict keys across the batch", () => {
  // r1 holds "a", r2 holds "b", r3 wants "a" again → collision after r1+r2.
  const ready = [
    review("r1", { conflictKeys: ["a"] }),
    review("r2", { conflictKeys: ["b"] }),
    review("r3", { conflictKeys: ["a"] }),
  ];
  assert.deepEqual(idsOf(pickExecutionBatch(ready, 4, new Set<string>())), ["r1", "r2"]);
});

// ===========================================================================
// SECTION 8 — stableReadyNodes: execute-time ready rule (executed vs completed)
// ===========================================================================

test("stableReadyNodes treats a node as ready only when its deps are all completed", () => {
  const nodes = [dagNode("A"), dagNode("B", { dependsOn: ["A"] })];
  assert.deepEqual(idsOf(stableReadyNodes(nodes, new Set<string>(), new Set<string>())), ["A"]);
  assert.deepEqual(idsOf(stableReadyNodes(nodes, new Set(["A"]), new Set<string>())), ["A", "B"]);
});

test("stableReadyNodes skips executedNodeIds but NOT completedNodeIds", () => {
  // A node that is completed-but-not-executed remains "ready" (re-ready); this
  // is why executeWorkflowDag adds completed nodes to executedNodeIds too.
  const nodes = [dagNode("A"), dagNode("B", { dependsOn: ["A"] })];
  assert.deepEqual(idsOf(stableReadyNodes(nodes, new Set(["A"]), new Set(["A"]))), ["B"]);
  assert.deepEqual(idsOf(stableReadyNodes(nodes, new Set(["A", "B"]), new Set(["A", "B"]))), []);
});

test("stableReadyNodes ignores a non-array dependsOn", () => {
  const nodes = [dagNode("A", { dependsOn: "nope" })];
  assert.deepEqual(idsOf(stableReadyNodes(nodes, new Set<string>(), new Set<string>())), ["A"]);
});

// ===========================================================================
// SECTION 9 — maxConcurrentFromDag: capacity fallback to 1
// ===========================================================================

test("maxConcurrentFromDag floors finite values and floors to a minimum of 1", () => {
  assert.equal(maxConcurrentFromDag(dag([])), 1); // undefined
  assert.equal(maxConcurrentFromDag(dag([], 4)), 4);
  assert.equal(maxConcurrentFromDag(dag([], 2.9)), 2);
  assert.equal(maxConcurrentFromDag(dag([], 0)), 1); // 0 floors up to 1
  assert.equal(maxConcurrentFromDag(dag([], -3)), 1); // negatives floor up to 1
  assert.equal(maxConcurrentFromDag(dag([], Number.NaN)), 1);
  assert.equal(maxConcurrentFromDag(dag([], "not-a-number" as unknown as number)), 1);
});

// ===========================================================================
// SECTION 10 — rerunDagFromPhase: starts at the retry phase, never earlier
// ===========================================================================
//
// Driven via fake injected ports (appendEvent/failJob) plus an aborted signal
// so runDagNode produces a deterministic terminal for the FIRST visited node
// without invoking the real runPhase/agent pipeline.

test("rerunDagFromPhase returns null when the retry phase is absent from executionNodes", async () => {
  const record = { appendEvent: [] as Array<Record<string, unknown>>, failJob: [] as Array<Record<string, unknown>> };
  const session = abortedRerunSession(record);
  const executionNodes = [
    dagNode("n-plan", { phase: "plan" }),
    dagNode("n-exec", { phase: "execute" }),
  ];
  const result = await rerunDagFromPhase(session, executionNodes, "verify");
  assert.equal(result, null);
  assert.equal(record.appendEvent.length, 0, "no node is touched when the retry phase is absent");
  assert.equal(record.failJob.length, 0);
});

test("rerunDagFromPhase starts at the first node whose phase === retryPhase and never visits earlier nodes", async () => {
  const record = { appendEvent: [] as Array<Record<string, unknown>>, failJob: [] as Array<Record<string, unknown>> };
  const session = abortedRerunSession(record);
  const executionNodes = [
    dagNode("n-plan", { phase: "plan" }),
    dagNode("n-exec", { phase: "execute" }),
    dagNode("n-verify", { phase: "verify" }),
    dagNode("n-review", { phase: "review" }),
  ];
  const result = await rerunDagFromPhase(session, executionNodes, "verify");
  assert.ok(result, "an aborted-signal run returns a terminal for the retry-phase node");
  // The single recorded dag_node_failed event is for the retry-phase node, NOT
  // any earlier (already-completed) node — pinning "does not re-run nodes
  // before the retry phase".
  assert.equal(record.appendEvent.length, 1);
  assert.equal(record.appendEvent[0].nodeId, "n-verify");
  assert.equal(record.appendEvent[0].phase, "verify");
  const failure = (result as { failure?: Record<string, unknown> }).failure;
  assert.equal(failure?.phase, "verify");
  assert.equal(failure?.nodeId, "n-verify");
});

test("rerunDagFromPhase starts at the FIRST matching phase when several share it", async () => {
  const record = { appendEvent: [] as Array<Record<string, unknown>>, failJob: [] as Array<Record<string, unknown>> };
  const session = abortedRerunSession(record);
  const executionNodes = [
    dagNode("verify-1", { phase: "verify" }),
    dagNode("verify-2", { phase: "verify" }),
  ];
  const result = await rerunDagFromPhase(session, executionNodes, "verify");
  assert.ok(result);
  assert.equal(record.appendEvent[0].nodeId, "verify-1");
  assert.equal((result as { failure?: Record<string, unknown> }).failure?.nodeId, "verify-1");
});
