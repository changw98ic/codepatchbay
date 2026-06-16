/**
 * Tests for binding checklist IDs to DAG events.
 *
 * Task 11: dag_node_started, dag_node_completed, and dag_node_failed events
 * must include checklistIds from the DAG node. Custom mutating nodes without
 * checklistIds/checklistNeutral and verify nodes not depending on execute
 * nodes covering the same ids must fail with dag_uncovered.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runJob } from "../core/engine/run-job.js";
import { validateChecklistDagCoverage } from "../core/workflow/acceptance-checklist.js";
import { tempRoot } from "./helpers.js";
function jsonEnvelope(data) {
    return "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}
function checklist() {
    return {
        schemaVersion: 1,
        jobId: "job-dag-bind",
        project: "flow",
        status: "frozen",
        source: { task: "task", issue: null, documents: [] },
        items: [
            {
                id: "AC-001",
                requirement: "README is updated",
                source: "user_task",
                sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
                predicateId: "PRED-001",
                required: true,
                area: "docs",
                risk: "low",
                verificationMethod: "static",
                expectedEvidence: "README diff contains requested text",
                dependsOn: [],
                allowedFiles: ["README.md"],
            },
        ],
        assumptions: [],
    };
}
async function makeSourceRoot() {
    const sourcePath = await tempRoot("cpb-dag-bind-source");
    await writeFile(path.join(sourcePath, "README.md"), "# fixture\n", "utf8");
    await writeFile(path.join(sourcePath, "package.json"), JSON.stringify({ name: "dag-bind-fixture", private: true }, null, 2), "utf8");
    return sourcePath;
}
test("dag_node_started and dag_node_completed include checklistIds from DAG node", async () => {
    const cpbRoot = await tempRoot("cpb-dag-bind-events");
    const sourcePath = await makeSourceRoot();
    const dataRoot = path.join(cpbRoot, "runtime");
    const events = [];
    const pool = {
        async execute(_agent, _prompt, _cwd, _timeoutMs, meta) {
            if (meta.role === "planner")
                return { output: jsonEnvelope({ status: "ok", planMarkdown: "## Analysis\n- ok\n\n## Files to modify\n- README.md\n\n## Implementation Steps\n1. edit\n\n## Testing\n- npm test\n\n## Risks\n- none" }), providerKey: "fake", variant: null };
            if (meta.role === "executor")
                return { output: jsonEnvelope({ status: "ok", summary: "done", tests: [], risks: [], checklistMapping: [] }), providerKey: "fake", variant: null };
            return { output: jsonEnvelope({ status: "ok", verdict: "pass", reason: "legacy", details: "ok", confidence: 1 }), providerKey: "fake", variant: null };
        },
        async releaseWorktree() { return true; },
    };
    await runJob({
        cpbRoot,
        dataRoot,
        project: "flow",
        task: "task",
        jobId: "job-dag-bind",
        workflow: "standard",
        planMode: "full",
        sourcePath,
        sourceContext: {},
        agents: { planner: "fake", executor: "fake", verifier: "fake" },
        prepareTask: async () => ({ phases: ["plan", "execute", "verify"], riskMap: { riskLevel: "low" }, acceptanceChecklist: checklist() }),
        createJob: async () => ({ jobId: "job-dag-bind" }),
        startJob: async () => ({}),
        checkpointJob: async () => ({}),
        completePhase: async () => ({}),
        completeJob: async () => ({}),
        failJob: async () => ({}),
        blockJob: async () => ({}),
        appendEvent: async (_root, _project, _jobId, event) => { events.push(event); },
        reportProgress: async () => ({}),
        getPool: () => pool,
    });
    const dagEvent = events.find((event) => event.type === "workflow_dag_materialized");
    assert.ok(dagEvent, "workflow_dag_materialized event should exist");
    assert.deepEqual(dagEvent.workflowDag.nodes.find((node) => node.phase === "execute").checklistIds, ["AC-001"]);
    // dag_node_started for execute carries checklistIds
    const dagNodeStarted = events.find((event) => event.type === "dag_node_started" && event.phase === "execute");
    assert.ok(dagNodeStarted, "dag_node_started for execute should exist");
    assert.deepEqual(dagNodeStarted.checklistIds, ["AC-001"], "dag_node_started for execute must carry checklistIds");
    // dag_node_completed for plan carries checklistIds (empty for plan phase)
    const planCompleted = events.find((event) => event.type === "dag_node_completed" && event.phase === "plan");
    assert.ok(planCompleted, "dag_node_completed for plan should exist");
    assert.ok(Array.isArray(planCompleted.checklistIds), "dag_node_completed for plan must have checklistIds array");
    // dag_node_failed for execute carries checklistIds (execute fails with fixture executor)
    const executeFailed = events.find((event) => event.type === "dag_node_failed" && event.phase === "execute");
    assert.ok(executeFailed, "dag_node_failed for execute should exist");
    assert.deepEqual(executeFailed.checklistIds, ["AC-001"], "dag_node_failed for execute must carry checklistIds");
    // dag_node_started for plan has checklistIds array
    const planStarted = events.find((event) => event.type === "dag_node_started" && event.phase === "plan");
    assert.ok(planStarted, "dag_node_started for plan should exist");
    assert.ok(Array.isArray(planStarted.checklistIds), "dag_node_started for plan must have checklistIds array");
});
test("dag_node_failed includes checklistIds from DAG node", async () => {
    const cpbRoot = await tempRoot("cpb-dag-bind-failed");
    const sourcePath = await makeSourceRoot();
    const dataRoot = path.join(cpbRoot, "runtime");
    const events = [];
    const pool = {
        async execute(_agent, _prompt, _cwd, _timeoutMs, meta) {
            if (meta.role === "planner")
                return { output: jsonEnvelope({ status: "ok", planMarkdown: "## Analysis\n- ok\n\n## Files to modify\n- README.md\n\n## Implementation Steps\n1. edit\n\n## Testing\n- npm test\n\n## Risks\n- none" }), providerKey: "fake", variant: null };
            if (meta.role === "executor")
                return { output: "not json", providerKey: "fake", variant: null };
            return { output: jsonEnvelope({ status: "ok", verdict: "pass", reason: "legacy", details: "ok", confidence: 1 }), providerKey: "fake", variant: null };
        },
        async releaseWorktree() { return true; },
    };
    await runJob({
        cpbRoot,
        dataRoot,
        project: "flow",
        task: "task",
        jobId: "job-dag-bind-fail",
        workflow: "standard",
        planMode: "full",
        sourcePath,
        sourceContext: {},
        agents: { planner: "fake", executor: "fake", verifier: "fake" },
        prepareTask: async () => ({ phases: ["plan", "execute", "verify"], riskMap: { riskLevel: "low" }, acceptanceChecklist: checklist() }),
        createJob: async () => ({ jobId: "job-dag-bind-fail" }),
        startJob: async () => ({}),
        checkpointJob: async () => ({}),
        completePhase: async () => ({}),
        completeJob: async () => ({}),
        failJob: async () => ({}),
        blockJob: async () => ({}),
        appendEvent: async (_root, _project, _jobId, event) => { events.push(event); },
        reportProgress: async () => ({}),
        getPool: () => pool,
    });
    const dagNodeFailed = events.find((event) => event.type === "dag_node_failed" && event.phase === "execute");
    assert.ok(dagNodeFailed, "dag_node_failed for execute should exist");
    assert.deepEqual(dagNodeFailed.checklistIds, ["AC-001"], "dag_node_failed for execute must carry checklistIds");
});
test("validateChecklistDagCoverage rejects custom mutating node without checklistIds or checklistNeutral", () => {
    const workflowDag = {
        nodes: [
            { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
            { id: "execute", phase: "execute", role: "executor", checklistIds: ["AC-001"], checklistBindingSource: "canonical-default", dependsOn: ["plan"] },
            { id: "custom-mutate", phase: "execute", role: "executor", custom: true, dependsOn: ["plan"] },
            { id: "verify", phase: "verify", role: "verifier", checklistIds: ["AC-001"], dependsOn: ["execute"] },
        ],
    };
    const acceptanceChecklist = checklist();
    const result = validateChecklistDagCoverage(workflowDag, acceptanceChecklist);
    assert.equal(result.ok, false, "should reject custom mutating node without checklistIds or checklistNeutral");
    assert.equal(result.outcome, "dag_uncovered");
    assert.ok(result.violations.length > 0, "should report violations");
    assert.ok(result.violations.some((v) => v.nodeId === "custom-mutate"), "violation should mention custom-mutate node");
});
test("validateChecklistDagCoverage accepts custom node with checklistNeutral", () => {
    const workflowDag = {
        nodes: [
            { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
            { id: "execute", phase: "execute", role: "executor", checklistIds: ["AC-001"], checklistBindingSource: "canonical-default", dependsOn: ["plan"] },
            { id: "side-effect", phase: "review", role: "reviewer", sideEffecting: true, checklistNeutral: true, dependsOn: ["execute"] },
            { id: "verify", phase: "verify", role: "verifier", checklistIds: ["AC-001"], dependsOn: ["execute"] },
        ],
    };
    const acceptanceChecklist = checklist();
    const result = validateChecklistDagCoverage(workflowDag, acceptanceChecklist);
    assert.equal(result.ok, true, "should accept side-effecting node with checklistNeutral");
});
test("validateChecklistDagCoverage rejects verify node not depending on execute node covering same ids", () => {
    const workflowDag = {
        nodes: [
            { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
            { id: "execute", phase: "execute", role: "executor", checklistIds: ["AC-001"], checklistBindingSource: "canonical-default", dependsOn: ["plan"] },
            { id: "verify", phase: "verify", role: "verifier", checklistIds: ["AC-001"], dependsOn: [] },
        ],
    };
    const acceptanceChecklist = checklist();
    const result = validateChecklistDagCoverage(workflowDag, acceptanceChecklist);
    assert.equal(result.ok, false, "should reject verify node that does not depend on execute covering same ids");
    assert.equal(result.outcome, "dag_uncovered");
    assert.ok(result.violations.some((v) => v.nodeId === "verify" && v.reason.includes("must depend on")), "violation should mention missing dependency");
});
test("validateChecklistDagCoverage accepts valid DAG with execute and verify covering same ids", () => {
    const workflowDag = {
        nodes: [
            { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
            { id: "execute", phase: "execute", role: "executor", checklistIds: ["AC-001"], checklistBindingSource: "canonical-default", dependsOn: ["plan"] },
            { id: "verify", phase: "verify", role: "verifier", checklistIds: ["AC-001"], dependsOn: ["execute"] },
        ],
    };
    const acceptanceChecklist = checklist();
    const result = validateChecklistDagCoverage(workflowDag, acceptanceChecklist);
    assert.equal(result.ok, true, "should accept valid DAG");
});
test("validateChecklistDagCoverage returns ok for null checklist (legacy jobs)", () => {
    const workflowDag = {
        nodes: [
            { id: "plan", phase: "plan", dependsOn: [] },
            { id: "execute", phase: "execute", dependsOn: ["plan"] },
            { id: "verify", phase: "verify", dependsOn: ["execute"] },
        ],
    };
    const result = validateChecklistDagCoverage(workflowDag, null);
    assert.equal(result.ok, true, "should accept DAG without checklist");
});
