import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { FailureKind, failure, isValidFailureKind } from "../core/contracts/failure.js";
import { runJob } from "../core/engine/run-job.js";
import { registerDagWorkflow } from "../core/workflow/definition.js";
import { materializeJob } from "../server/services/event-store.js";
import { jobToPipelineState } from "../server/services/job-projection.js";
import { tempRoot } from "./helpers.js";

type AnyRecord = Record<string, any>;

process.env.CPB_PHASE_RETRY_MAX = "1";
process.env.CPB_PHASE_RETRY_BASE_DELAY_MS = "0";
process.env.CPB_PHASE_FEEDBACK_RETRY_MAX = "1";

function jsonEnvelope(data: AnyRecord) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

function phaseOutput(role: string) {
  if (role === "planner") {
    return jsonEnvelope({
      status: "ok",
      planMarkdown: [
        "## Analysis",
        "- prepare_task fixture plan.",
        "",
        "## Files to modify",
        "- README.md",
        "",
        "## Implementation Steps",
        "1. Exercise prepare_task preflight.",
        "",
        "## Testing",
        "- node:test prepare_task fixture",
        "",
        "## Risks",
        "- Fixture only.",
      ].join("\n"),
    });
  }
  if (role === "executor" || role === "security-reviewer") {
    return jsonEnvelope({
      status: "ok",
      summary: "prepare_task fixture completed and referenced README.md.",
      tests: ["tests/engine-prepare-task.test.js"],
      risks: ["No source mutation expected."],
    });
  }
  return jsonEnvelope({
    status: "ok",
    verdict: "pass",
    reason: "prepare_task fixture verified.",
    details: "The fake provider completed the phase.",
    confidence: 1,
  });
}

async function makeSourceRoot() {
  const sourcePath = await tempRoot("cpb-prepare-source");
  await writeFile(path.join(sourcePath, "README.md"), "# prepare_task fixture\n", "utf8");
  await writeFile(path.join(sourcePath, "package.json"), `${JSON.stringify({ name: "prepare-task-fixture", private: true }, null, 2)}\n`, "utf8");
  return sourcePath;
}

function mediumRiskMap() {
  return {
    riskLevel: "medium",
    domains: ["test_fixture"],
    highRiskFiles: [],
    safetyBoundaries: [],
    verificationDepth: "standard",
    adversarialRequired: false,
    adversarialFocus: [],
    confidence: "high",
  };
}

function makeServices({ events = [], starts = [], completed = [], blocked = [], failed = [], prepareTask }: AnyRecord = {}) {
  return {
    createJob: async (_cpbRoot, job) => ({
      ...job,
      jobId: job.jobId || "job-prepare-task",
      status: "running",
    }),
    ...(prepareTask === undefined ? {} : { prepareTask }),
    startPhase: async (_cpbRoot, project, jobId, { phase }) => {
      starts.push(phase);
      events.push({ type: "phase_started", project, jobId, phase });
    },
    completePhase: async (_cpbRoot, project, jobId, { phase, artifact }) => {
      completed.push(phase);
      events.push({ type: "phase_completed", project, jobId, phase, artifact });
    },
    completeJob: async (_cpbRoot, project, jobId) => {
      events.push({ type: "job_completed", project, jobId });
    },
    blockJob: async (_cpbRoot, project, jobId, block) => {
      blocked.push(block);
      events.push({ type: "job_blocked", project, jobId, ...block });
    },
    failJob: async (_cpbRoot, project, jobId, fail) => {
      failed.push(fail);
      events.push({ type: "job_failed", project, jobId, ...fail });
    },
    appendEvent: async (_cpbRoot, project, jobId, event) => {
      events.push({ project, jobId, ...event });
      return event;
    },
  };
}

function makePool({ calls = [], failWhen = null }: AnyRecord = {}) {
  return {
    async execute(agent, prompt, cwd, timeoutMs, meta) {
      const call = { agent, prompt, cwd, timeoutMs, meta };
      calls.push(call);
      if (failWhen?.({ call, calls })) {
        throw new Error("fixture forced provider failure");
      }
      return { output: phaseOutput(meta.role), providerKey: agent, variant: null };
    },
    async releaseWorktree() {
      return true;
    },
  };
}

async function runPrepareEngine({ prepareTask, includePrepareTask = true }: AnyRecord = {}) {
  const cpbRoot = await tempRoot("cpb-prepare-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events = [];
  const starts = [];
  const completed = [];
  const blocked = [];
  const calls = [];
  const services = makeServices({
    events,
    starts,
    completed,
    blocked,
    prepareTask: includePrepareTask
      ? (prepareTask || (async () => ({ riskMap: mediumRiskMap() })))
      : undefined,
  });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "prepare_task engine fixture",
    jobId: "job-prepare-task",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => makePool({ calls }),
  });

  return { result, events, starts, completed, blocked, calls };
}

test("runJob blocks before phases when prepareTask service is missing", async () => {
  const { result, starts, calls } = await runPrepareEngine({ includePrepareTask: false });

  assert.equal(result.status, "blocked");
  assert.equal(result.failure.phase, "prepare_task");
  assert.ok(isValidFailureKind(result.failure.kind), "prepare_task block should use a current FailureKind");
  assert.match(result.failure.reason, /prepareTask|prepare_task/i);
  assert.deepEqual(starts, []);
  assert.equal(calls.length, 0);
});

test("runJob blocks codegraph_unavailable from prepareTask before provider phase work", async () => {
  const prepareTask = async () => {
    throw failure({
      kind: FailureKind.CODEGRAPH_UNAVAILABLE,
      phase: "prepare_task",
      reason: "CodeGraph is unavailable for this project",
      retryable: true,
      cause: { dirtyReasons: ["codegraph_unavailable"] },
    });
  };

  const { result, starts, blocked, calls } = await runPrepareEngine({ prepareTask });

  assert.equal(result.status, "blocked");
  assert.equal(result.exitCode, 2);
  assert.equal(result.failure.kind, FailureKind.CODEGRAPH_UNAVAILABLE);
  assert.equal(result.failure.phase, "prepare_task");
  assert.equal(blocked[0].code || blocked[0].kind, FailureKind.CODEGRAPH_UNAVAILABLE);
  assert.deepEqual(starts, []);
  assert.equal(calls.length, 0);
});

test("runJob emits and materializes riskmap_generated before normal phases", async () => {
  const riskMap = {
    ...mediumRiskMap(),
    domains: ["scheduler", "provider_pool"],
    highRiskFiles: ["server/orchestrator/scheduler.js"],
  };

  const { result, events, starts, calls } = await runPrepareEngine({
    prepareTask: async () => ({ riskMap }),
  });

  assert.equal(result.status, "completed", JSON.stringify(result.failure || result, null, 2));
  assert.deepEqual(starts, ["plan", "execute", "verify"]);
  assert.deepEqual(calls.map((call) => call.meta.role), ["planner", "executor", "verifier"]);

  const riskEventIndex = events.findIndex((event) => event.type === "riskmap_generated");
  const firstPhaseIndex = events.findIndex((event) => event.type === "phase_started" && event.phase !== "prepare_task");
  assert.notEqual(riskEventIndex, -1, "riskmap_generated event should be emitted");
  assert.ok(riskEventIndex < firstPhaseIndex, "riskmap_generated should be emitted before normal phases");

  const riskEvent = events[riskEventIndex];
  assert.equal(riskEvent.phase, "prepare_task");
  assert.deepEqual(riskEvent.riskMap, riskMap);
  assert.equal(riskEvent.riskLevel, "medium");
  assert.equal(riskEvent.verificationDepth, "standard");
  assert.equal(riskEvent.adversarialRequired, false);

  const materialized = materializeJob(events) as AnyRecord;
  assert.deepEqual(materialized.riskMap, riskMap);
});

test("runJob materializes workflow DAG and emits node transitions for phases", async () => {
  const { result, events } = await runPrepareEngine();

  assert.equal(result.status, "completed", JSON.stringify(result.failure || result, null, 2));

  const dagEvent = events.find((event) => event.type === "workflow_dag_materialized");
  assert.ok(dagEvent, "workflow_dag_materialized event should be emitted");
  assert.equal(dagEvent.workflow, "standard");
  assert.deepEqual(dagEvent.workflowDag.nodes.map((node) => node.id), ["plan", "execute", "verify"]);
  assert.deepEqual(dagEvent.workflowDag.nodes.find((node) => node.id === "verify").dependsOn, ["execute"]);

  const nodeTransitions = events
    .filter((event) => event.type?.startsWith("dag_node_"))
    .map((event) => `${event.type}:${event.nodeId}`);
  assert.deepEqual(nodeTransitions, [
    "dag_node_started:plan",
    "dag_node_completed:plan",
    "dag_node_started:execute",
    "dag_node_completed:execute",
    "dag_node_started:verify",
    "dag_node_completed:verify",
  ]);

  const materialized = materializeJob(events) as AnyRecord;
  assert.deepEqual(materialized.workflowDag.nodes.map((node) => node.id), ["plan", "execute", "verify"]);
  assert.deepEqual(materialized.completedNodes, ["plan", "execute", "verify"]);
  assert.equal(materialized.nodeStates.verify.status, "completed");
  assert.equal(materialized.nodeStates.verify.phase, "verify");
});

test("runJob preserves explicit workflow DAG dependencies and concurrency", async () => {
  registerDagWorkflow("explicit-dag-fixture", {
    maxConcurrentNodes: 3,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute_a", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "execute_b", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute_a", "execute_b"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-explicit-dag-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events = [];
  const services = makeServices({
    events,
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
  });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "explicit DAG fixture",
    jobId: "job-explicit-dag",
    workflow: "explicit-dag-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => makePool(),
  });

  assert.equal(result.status, "completed", JSON.stringify(result.failure || result, null, 2));
  const dagEvent = events.find((event) => event.type === "workflow_dag_materialized");
  assert.equal(dagEvent.workflowDag.maxConcurrentNodes, 3);
  assert.deepEqual(
    dagEvent.workflowDag.nodes.map((node) => [node.id, node.dependsOn]),
    [
      ["plan", []],
      ["execute_a", ["plan"]],
      ["execute_b", ["plan"]],
      ["verify", ["execute_a", "execute_b"]],
    ],
  );
});

test("runJob executes same-phase DAG nodes after their dependencies regardless of declaration order", async () => {
  registerDagWorkflow("same-phase-dependency-order-fixture", {
    maxConcurrentNodes: 1,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute_dependent", phase: "execute", role: "security-reviewer", dependsOn: ["execute_dependency"] },
      { id: "execute_dependency", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute_dependent"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-same-phase-dag-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events = [];
  const calls = [];
  const services = makeServices({
    events,
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
  });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "same-phase DAG dependency fixture",
    jobId: "job-same-phase-dag",
    workflow: "same-phase-dependency-order-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      "security-reviewer": "fake-security",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => makePool({ calls }),
  });

  assert.equal(result.status, "completed");
  const dagEvent = events.find((event) => event.type === "workflow_dag_materialized");
  assert.equal(dagEvent.executionMode, "node_first_sequential");
  assert.equal(dagEvent.dagNodeFirstSequentialReady, true);
  assert.equal(dagEvent.dagParallelExecutionReady, false);
  assert.deepEqual(
    events
      .filter((event) => event.type === "dag_node_started")
      .map((event) => event.nodeId),
    ["plan", "execute_dependency", "execute_dependent", "verify"],
  );
  assert.deepEqual(calls.map((call) => call.meta.role), ["planner", "executor", "security-reviewer", "verifier"]);
});

test("runJob failed same-phase DAG node records node-aware resume target", async () => {
  registerDagWorkflow("same-phase-node-failure-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute_a", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "execute_b", phase: "execute", role: "executor", dependsOn: ["execute_a"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute_b"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-node-failure-dag-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events = [];
  const calls = [];
  const services = makeServices({
    events,
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
  });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "same phase node failure fixture",
    jobId: "job-node-failure-dag",
    workflow: "same-phase-node-failure-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => makePool({
      calls,
      failWhen: ({ call, calls: allCalls }) =>
        call.meta.role === "executor"
        && allCalls.filter((entry) => entry.meta.role === "executor").length >= 2,
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal((result.failure as AnyRecord).nodeId, "execute_b");
  const materialized = materializeJob(events) as AnyRecord;
  assert.equal(materialized.dagResume.failedNodeId, "execute_b");
  assert.deepEqual(materialized.dagResume.resumeTarget, { nodeId: "execute_b", phase: "execute" });
  assert.deepEqual(materialized.dagResume.completedNodeIds, ["plan", "execute_a"]);
});

test("runJob resumes DAG retries without rerunning completed nodes", async () => {
  registerDagWorkflow("resume-completed-node-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute_a", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "execute_b", phase: "execute", role: "security-reviewer", dependsOn: ["execute_a"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute_b"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-resume-dag-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const planPath = path.join(dataRoot, "wiki", "inbox", "plan-001.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, "# Recovered Plan\n\nContinue from execute_b.\n", "utf8");
  const events = [];
  const calls = [];
  const services = makeServices({
    events,
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
  });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "resume completed DAG nodes fixture",
    jobId: "job-resume-dag",
    workflow: "resume-completed-node-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {
      retry: {
        completedNodeIds: ["plan", "execute_a"],
        resumeTarget: { nodeId: "execute_b", phase: "execute" },
        artifacts: {
          plan: "plan-001",
          execute: "deliverable-001",
        },
      },
    },
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      "security-reviewer": "fake-security",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => makePool({ calls }),
  });

  assert.equal(result.status, "completed", JSON.stringify(result.failure || result, null, 2));
  assert.deepEqual(calls.map((call) => call.meta.role), ["security-reviewer", "verifier"]);
  assert.deepEqual(
    events
      .filter((event) => event.type === "dag_node_skipped")
      .map((event) => [event.nodeId, event.reason]),
    [
      ["plan", "resume_completed_node"],
      ["execute_a", "resume_completed_node"],
    ],
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === "dag_node_started")
      .map((event) => event.nodeId),
    ["execute_b", "verify"],
  );
  const materialized = materializeJob(events) as AnyRecord;
  assert.deepEqual(materialized.completedNodes, ["plan", "execute_a", "execute_b", "verify"]);
  assert.equal(materialized.nodeStates.plan.status, "skipped");
  assert.equal(materialized.nodeStates.execute_a.status, "skipped");
});

test("runJob uses explicit workflow DAG node roles for phase execution", async () => {
  registerDagWorkflow("explicit-role-dag-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute_security", phase: "execute", role: "security-reviewer", dependsOn: ["plan"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute_security"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-explicit-role-dag-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events = [];
  const calls = [];
  const services = makeServices({
    events,
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
  });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "explicit DAG role fixture",
    jobId: "job-explicit-role-dag",
    workflow: "explicit-role-dag-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      "security-reviewer": "fake-security",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => makePool({ calls }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => call.meta.role), ["planner", "security-reviewer", "verifier"]);
  assert.deepEqual(calls.map((call) => call.agent), ["fake-primary", "fake-security", "fake-primary"]);
  const securityStarted = events.find((event) => event.type === "dag_node_started" && event.nodeId === "execute_security");
  assert.equal(securityStarted.role, "security-reviewer");
});

test("runJob emits and materializes dynamic agent plan from prepare_task", async () => {
  const dynamicAgentPlan = {
    schemaVersion: 1,
    riskLevel: "high",
    generatedAt: "2026-06-08T00:00:00.000Z",
    agentConfig: {
      verifier: { agent: "fake-secondary", required: true, independent: true },
      adversarial_verifier: { agent: "fake-secondary", required: true, independent: true },
    },
  };

  const { result, events } = await runPrepareEngine({
    prepareTask: async () => ({ riskMap: { ...mediumRiskMap(), riskLevel: "high", adversarialRequired: true }, dynamicAgentPlan }),
  });

  assert.equal(result.status, "completed");
  const planEvent = events.find((event) => event.type === "dynamic_agent_plan_generated");
  assert.ok(planEvent, "dynamic_agent_plan_generated event should be emitted");
  assert.deepEqual(planEvent.dynamicAgentPlan, dynamicAgentPlan);

  const materialized = materializeJob(events) as AnyRecord;
  assert.deepEqual(materialized.dynamicAgentPlan, dynamicAgentPlan);
});

test("runJob inserts adversarial_verify after verify for high-risk RiskMap", async () => {
  const { result, events, starts, calls } = await runPrepareEngine({
    prepareTask: async () => ({
      riskMap: {
        ...mediumRiskMap(),
        riskLevel: "high",
        domains: ["scheduler"],
        verificationDepth: "strict",
        adversarialRequired: true,
        adversarialFocus: ["ready-node ordering"],
      },
    }),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(starts, ["plan", "execute", "verify", "adversarial_verify"]);
  assert.deepEqual(calls.map((call) => call.meta.role), ["planner", "executor", "verifier", "adversarial_verifier"]);

  const transitions = events
    .filter((event) => event.type?.startsWith("dag_node_"))
    .map((event) => `${event.type}:${event.nodeId}`);
  assert.ok(transitions.includes("dag_node_started:adversarial_verify"));
  assert.ok(transitions.includes("dag_node_completed:adversarial_verify"));

  const materialized = materializeJob(events) as AnyRecord;
  assert.equal(materialized.nodeStates.adversarial_verify.status, "completed");
  assert.ok(materialized.completedNodes.includes("adversarial_verify"));

  const projection = jobToPipelineState(materialized);
  assert.equal(projection.riskLevel, "high");
  assert.equal(projection.adversarialRequired, true);
  assert.equal(projection.verificationDepth, "strict");
  assert.equal(projection.dynamicAgentPlan.riskLevel, "high");
  assert.equal(projection.adversarialVerdict.status, "pass");
  assert.deepEqual(projection.workflowDag.nodes.map((node) => node.id), ["plan", "execute", "verify", "adversarial_verify"]);
});
