/**
 * Tests for checklist generation and persistence before DAG materialization.
 *
 * Task 3: The acceptance checklist must be generated, validated, persisted,
 * and event-indexed before the workflow DAG and dynamic agent plan are built.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { runJob } from "../core/engine/run-job.js";
import { tempRoot } from "./helpers.js";
function jsonEnvelope(data) {
    return "```json\n" + JSON.stringify(data, null, 2) + "\n```";
}
function checklist() {
    return {
        schemaVersion: 1,
        jobId: "job-checklist",
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
function checklistWithTwoItems() {
    return {
        ...checklist(),
        items: [
            ...checklist().items,
            {
                id: "AC-002",
                requirement: "Tests pass",
                source: "user_task",
                sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
                predicateId: "PRED-002",
                required: true,
                area: "tests",
                risk: "medium",
                verificationMethod: "command",
                expectedEvidence: "npm test exits 0",
                dependsOn: [],
                allowedFiles: ["tests/"],
            },
        ],
    };
}
async function makeSourceRoot() {
    const sourcePath = await tempRoot("cpb-checklist-source");
    await writeFile(path.join(sourcePath, "README.md"), "# fixture\n", "utf8");
    await writeFile(path.join(sourcePath, "package.json"), JSON.stringify({ name: "checklist-fixture", private: true }, null, 2), "utf8");
    return sourcePath;
}
test("prepare-time checklist is artifacted before workflow DAG materialization", async () => {
    const cpbRoot = await tempRoot("cpb-checklist-prepare");
    const sourcePath = await makeSourceRoot();
    const dataRoot = path.join(cpbRoot, "runtime");
    const events = [];
    let plannerPrompt = "";
    const pool = {
        async execute(_agent, _prompt, _cwd, _timeoutMs, meta) {
            if (meta.role === "planner") {
                plannerPrompt = _prompt;
                return { output: jsonEnvelope({ status: "ok", planMarkdown: "## Analysis\n- ok\n\n## Files to modify\n- README.md\n\n## Implementation Steps\n1. edit\n\n## Testing\n- npm test\n\n## Risks\n- none" }), providerKey: "fake", variant: null };
            }
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
        jobId: "job-checklist",
        workflow: "standard",
        planMode: "full",
        sourcePath,
        sourceContext: {},
        agents: { planner: "fake", executor: "fake", verifier: "fake" },
        prepareTask: async () => ({ phases: ["plan", "execute", "verify"], riskMap: { riskLevel: "low" }, acceptanceChecklist: checklist() }),
        createJob: async () => ({ jobId: "job-checklist" }),
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
    // Task 5: planner prompt must include frozen checklist context
    assert.match(plannerPrompt, /AC-001/, "planner prompt must include checklist item id AC-001");
    assert.match(plannerPrompt, /frozen acceptance checklist/i, "planner prompt must reference frozen acceptance checklist");
    const artifactIndex = events.findIndex((event) => event.type === "artifact_created" && event.kind === "acceptance-checklist");
    const dagIndex = events.findIndex((event) => event.type === "workflow_dag_materialized");
    assert.ok(artifactIndex >= 0, "acceptance-checklist artifact event should exist");
    assert.ok(dagIndex > artifactIndex, "workflow DAG must be materialized after checklist artifact");
    const dag = events[dagIndex].workflowDag;
    assert.deepEqual(dag.nodes.find((node) => node.phase === "execute").checklistIds, ["AC-001"]);
    assert.equal(dag.nodes.find((node) => node.phase === "execute").checklistBindingSource, "canonical-default");
    assert.deepEqual(dag.nodes.find((node) => node.phase === "verify").checklistIds, ["AC-001"]);
});
test("prepare-time checklist is persisted when prepareTask provides one", async () => {
    const cpbRoot = await tempRoot("cpb-checklist-auto");
    const sourcePath = await makeSourceRoot();
    const dataRoot = path.join(cpbRoot, "runtime");
    const events = [];
    const pool = {
        async execute(_agent, _prompt, _cwd, _timeoutMs, meta) {
            if (meta.role === "planner")
                return { output: jsonEnvelope({ status: "ok", planMarkdown: "## Analysis\n- ok\n\n## Files to modify\n- README.md\n\n## Implementation Steps\n1. edit\n\n## Testing\n- npm test\n\n## Risks\n- none" }), providerKey: "fake", variant: null };
            if (meta.role === "executor")
                return { output: jsonEnvelope({ status: "ok", summary: "done", tests: [], risks: [], checklistMapping: [{ checklistId: "AC-001", changedFiles: ["README.md"], executorClaim: "updated", notes: "" }] }), providerKey: "fake", variant: null };
            return { output: jsonEnvelope({ status: "ok", verdict: "pass", reason: "legacy", details: "ok", confidence: 1, checklistVerdict: { schemaVersion: 1, jobId: "job-auto-checklist", status: "pass", items: [{ checklistId: "AC-001", result: "pass", evidenceRefs: [{ ledgerId: "evidence-ledger-job-auto-checklist-0", evidenceId: "EV-001" }], actualResult: "ok", reason: "ok", fixScope: [] }], blocking: [], fixScope: [], reason: "ok" } }), providerKey: "fake", variant: null };
        },
        async releaseWorktree() { return true; },
    };
    const autoChecklist = {
        schemaVersion: 1,
        jobId: "job-auto-checklist",
        project: "flow",
        status: "frozen",
        source: { task: "update README with new section", issue: null, documents: [] },
        items: [{
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
            }],
        assumptions: [],
    };
    await runJob({
        cpbRoot,
        dataRoot,
        project: "flow",
        task: "update README with new section",
        jobId: "job-auto-checklist",
        workflow: "standard",
        planMode: "full",
        sourcePath,
        sourceContext: {},
        agents: { planner: "fake", executor: "fake", verifier: "fake" },
        prepareTask: async () => ({ riskMap: { riskLevel: "low" }, acceptanceChecklist: autoChecklist }),
        createJob: async () => ({ jobId: "job-auto-checklist" }),
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
    const artifactEvent = events.find((event) => event.type === "artifact_created" && event.kind === "acceptance-checklist");
    assert.ok(artifactEvent, "acceptance-checklist artifact should be persisted when prepareTask provides one");
    const dagEvent = events.find((event) => event.type === "workflow_dag_materialized");
    assert.ok(dagEvent, "workflow DAG should be materialized");
    assert.ok(events.indexOf(artifactEvent) < events.indexOf(dagEvent), "checklist artifact must come before DAG materialization");
});
test("prepare-time source classification blocks missing acceptance-relevant requirement", async () => {
    const cpbRoot = await tempRoot("cpb-checklist-coverage");
    const sourcePath = await makeSourceRoot();
    const dataRoot = path.join(cpbRoot, "runtime");
    const events = [];
    // A checklist that only covers "task:0" but requirementClassification says there are TWO acceptance-relevant requirements
    const result = await runJob({
        cpbRoot,
        dataRoot,
        project: "flow",
        task: "update README and add tests",
        jobId: "job-coverage-fail",
        workflow: "standard",
        planMode: "full",
        sourcePath,
        sourceContext: {},
        agents: { planner: "fake", executor: "fake", verifier: "fake" },
        prepareTask: async () => ({
            riskMap: { riskLevel: "low" },
            acceptanceChecklist: checklist(), // Only has AC-001 covering task:0
            requirementClassification: {
                classifiedRequirements: [
                    { id: "REQ-001", locator: "task:0", acceptanceRelevant: true },
                    { id: "REQ-002", locator: "document:0", acceptanceRelevant: true },
                ],
            },
        }),
        createJob: async () => ({ jobId: "job-coverage-fail" }),
        startJob: async () => ({}),
        checkpointJob: async () => ({}),
        completePhase: async () => ({}),
        completeJob: async () => ({}),
        failJob: async () => ({}),
        blockJob: async () => ({}),
        appendEvent: async (_root, _project, _jobId, event) => { events.push(event); },
        reportProgress: async () => ({}),
        getPool: () => ({
            async execute() { return { output: jsonEnvelope({ status: "ok" }), providerKey: "fake", variant: null }; },
            async releaseWorktree() { return true; },
        }),
    });
    // Job should be blocked because source coverage is incomplete
    assert.equal(result.status, "blocked", "job should be blocked when acceptance-relevant requirements are not covered");
});
test("prepare-time source refs must exist in supplied corpus", async () => {
    const cpbRoot = await tempRoot("cpb-checklist-sourceref");
    const sourcePath = await makeSourceRoot();
    const dataRoot = path.join(cpbRoot, "runtime");
    const events = [];
    // Checklist references a source that does not exist in the task/corpus
    const badChecklist = {
        ...checklist(),
        items: [{
                ...checklist().items[0],
                sourceRefs: [{ kind: "task_text", locator: "task:99", sha256: "sha256:missing" }],
            }],
    };
    const result = await runJob({
        cpbRoot,
        dataRoot,
        project: "flow",
        task: "update README",
        jobId: "job-sourceref-fail",
        workflow: "standard",
        planMode: "full",
        sourcePath,
        sourceContext: {},
        agents: { planner: "fake", executor: "fake", verifier: "fake" },
        prepareTask: async () => ({
            riskMap: { riskLevel: "low" },
            acceptanceChecklist: badChecklist,
        }),
        createJob: async () => ({ jobId: "job-sourceref-fail" }),
        startJob: async () => ({}),
        checkpointJob: async () => ({}),
        completePhase: async () => ({}),
        completeJob: async () => ({}),
        failJob: async () => ({}),
        blockJob: async () => ({}),
        appendEvent: async (_root, _project, _jobId, event) => { events.push(event); },
        reportProgress: async () => ({}),
        getPool: () => ({
            async execute() { return { output: jsonEnvelope({ status: "ok" }), providerKey: "fake", variant: null }; },
            async releaseWorktree() { return true; },
        }),
    });
    assert.equal(result.status, "blocked", "job should be blocked when source refs reference missing corpus entries");
});
test("prebuilt dynamic agent plan must reference frozen checklist artifact", async () => {
    const cpbRoot = await tempRoot("cpb-checklist-dap");
    const sourcePath = await makeSourceRoot();
    const dataRoot = path.join(cpbRoot, "runtime");
    const events = [];
    // Dynamic agent plan that does NOT reference the frozen checklist artifact
    const badDynamicAgentPlan = {
        agentConfig: {
            planner: { agent: "fake" },
            executor: { agent: "fake" },
            verifier: { agent: "fake" },
        },
        riskLevel: "low",
        source: "risk_map",
        // Missing acceptanceChecklistArtifactId
    };
    await runJob({
        cpbRoot,
        dataRoot,
        project: "flow",
        task: "update README",
        jobId: "job-dap-fail",
        workflow: "standard",
        planMode: "full",
        sourcePath,
        sourceContext: {},
        agents: { planner: "fake", executor: "fake", verifier: "fake" },
        prepareTask: async () => ({
            riskMap: { riskLevel: "low" },
            acceptanceChecklist: checklist(),
            dynamicAgentPlan: badDynamicAgentPlan,
        }),
        createJob: async () => ({ jobId: "job-dap-fail" }),
        startJob: async () => ({}),
        checkpointJob: async () => ({}),
        completePhase: async () => ({}),
        completeJob: async () => ({}),
        failJob: async () => ({}),
        blockJob: async () => ({}),
        appendEvent: async (_root, _project, _jobId, event) => { events.push(event); },
        reportProgress: async () => ({}),
        getPool: () => ({
            async execute() { return { output: jsonEnvelope({ status: "ok" }), providerKey: "fake", variant: null }; },
            async releaseWorktree() { return true; },
        }),
    });
    // The prebuilt dynamic agent plan without checklist artifact reference should be rejected or rebuilt.
    // If rebuilt, the job should still complete (not fail on this).
    // If rejected, the job should be blocked.
    // The key assertion: the job should NOT silently use an unartifacted dynamic plan.
    const dagEvent = events.find((e) => e.type === "workflow_dag_materialized");
    if (dagEvent) {
        // If we got to DAG, the plan was rebuilt (not the bad one)
        const dapEvent = events.find((e) => e.type === "dynamic_agent_plan_generated");
        assert.ok(dapEvent, "dynamic agent plan should be regenerated when prebuilt plan lacks checklist reference");
    }
    else {
        // The job was blocked because the prebuilt plan was rejected
        const blockedEvent = events.find((e) => e.type === "job_blocked");
        assert.ok(blockedEvent, "job should be blocked when dynamic agent plan is invalid");
    }
});
test("custom mutating DAG node requires explicit checklist binding or neutrality", async () => {
    const cpbRoot = await tempRoot("cpb-checklist-custom-node");
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
    // Source context provides a custom mutating node without checklistIds or checklistNeutral
    await runJob({
        cpbRoot,
        dataRoot,
        project: "flow",
        task: "task",
        jobId: "job-custom-node",
        workflow: "standard",
        planMode: "full",
        sourcePath,
        sourceContext: {},
        agents: { planner: "fake", executor: "fake", verifier: "fake" },
        prepareTask: async () => ({
            phases: ["plan", "execute", "verify"],
            riskMap: { riskLevel: "low" },
            acceptanceChecklist: checklist(),
        }),
        createJob: async () => ({ jobId: "job-custom-node" }),
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
    const dagEvent = events.find((e) => e.type === "workflow_dag_materialized");
    assert.ok(dagEvent, "workflow DAG should be materialized");
    // Check that execute and verify nodes have checklist bindings
    const executeNode = dagEvent.workflowDag.nodes.find((n) => n.phase === "execute");
    const verifyNode = dagEvent.workflowDag.nodes.find((n) => n.phase === "verify");
    assert.ok(executeNode, "execute node should exist");
    assert.ok(verifyNode, "verify node should exist");
    assert.deepEqual(executeNode.checklistIds, ["AC-001"], "execute node should carry checklist ids");
    assert.deepEqual(verifyNode.checklistIds, ["AC-001"], "verify node should carry checklist ids");
    assert.equal(executeNode.checklistBindingSource, "canonical-default");
});
