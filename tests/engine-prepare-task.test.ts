import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { recordValue, type LooseRecord } from "../shared/types.js";

import { FailureKind, failure, isValidFailureKind } from "../core/contracts/failure.js";
import { withArtifactStoreTestHooks } from "../core/artifacts/artifact-store.js";
import { runJob } from "../core/engine/run-job.js";
import { registerDagWorkflow } from "../core/workflow/definition.js";
import { materializeJob } from "../server/services/event/event-store.js";
import { jobToPipelineState } from "../server/services/job/job-projection.js";
import { tempRoot } from "./helpers.js";


process.env.CPB_PHASE_RETRY_MAX = "1";
process.env.CPB_PHASE_RETRY_BASE_DELAY_MS = "0";
process.env.CPB_PHASE_FEEDBACK_RETRY_MAX = "1";

function jsonEnvelope(data: LooseRecord) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, message: string) {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function reviewArtifactFiles(dataRoot: string) {
  try {
    const entries = await readdir(path.join(dataRoot, "wiki", "outputs"));
    return entries.filter((entry) => entry.startsWith("review-") && entry.endsWith(".md"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function outputArtifactEntries(dataRoot: string) {
  try {
    return await readdir(path.join(dataRoot, "wiki", "outputs"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function flushAsyncWork(iterations = 10) {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function reviewOutput(summary: string) {
  return jsonEnvelope({
    status: "ok",
    verdict: "approved",
    summary,
    comments: [],
  });
}

function phaseOutput(role: string) {
  if (role === "planner") {
    return jsonEnvelope({
      status: "ok",
      planMarkdown: [
        "## Analysis",
        "- prepare_task fixture plan.",
        "",
        "## Bounded Handoff",
        "- Real actors: prepare_task fixture and README.md",
        "- Entrypoints: prepare_task preflight workflow",
        "- Bypass candidates: DAG materialization paths",
        "- Edit files: README.md",
        "- Verification targets: node:test prepare_task fixture",
        "- Blockers: none",
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
    // Default checklist construction makes every job checklist-aware, so verify
    // requires a checklistVerdict covering the frozen item. The deterministic
    // probe runner supplies a valid static observation for AC-001 (the single
    // item produced for a task with no documents), yielding EV-001 in the
    // evidence ledger.
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-prepare-task",
      status: "pass",
      items: [
        {
          checklistId: "AC-001",
          result: "pass",
          evidenceRefs: [{ ledgerId: "pending", evidenceId: "EV-001" }],
          actualResult: "fixture exercised",
          reason: "fake verifier confirms the prepare_task fixture",
          fixScope: [],
        },
      ],
      blocking: [],
      fixScope: [],
      reason: "all items passed with evidence",
    },
  });
}

function decomposeOutput(overrides: LooseRecord = {}) {
  return jsonEnvelope({
    status: "ok",
    decomposedItems: [
      {
        requirement: "README is updated by the prepare_task fixture.",
        predicateId: "prepare-readme-update",
        verificationMethod: "static",
        allowedFiles: ["README.md"],
        sourceRefs: [{ kind: "task_text", locator: "task:0" }],
        expectedEvidence: "README.md is changed by the fixture execution",
      },
    ],
    ...overrides,
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

type PrepareServiceOptions = {
  events?: LooseRecord[];
  starts?: string[];
  completed?: string[];
  blocked?: LooseRecord[];
  failed?: LooseRecord[];
  prepareTask?: (cpbRoot?: string, input?: LooseRecord) => Promise<LooseRecord> | LooseRecord;
};

type PreparePoolOptions = {
  calls?: LooseRecord[];
  failWhen?: ((args: { call: LooseRecord; calls: LooseRecord[] }) => boolean) | null;
};

type RunPrepareEngineOptions = {
  prepareTask?: PrepareServiceOptions["prepareTask"];
  includePrepareTask?: boolean;
};

function makeServices({ events = [], starts = [], completed = [], blocked = [], failed = [], prepareTask }: PrepareServiceOptions = {}) {
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

function makePool({ calls = [], failWhen = null }: PreparePoolOptions = {}) {
  return {
    async execute(agent, prompt, cwd, timeoutMs, meta) {
      const call = { agent, prompt, cwd, timeoutMs, meta };
      if (/\bdecomposedItems\b/.test(prompt)) {
        if (failWhen?.({ call, calls })) {
          throw new Error("fixture forced provider failure");
        }
        return { output: decomposeOutput(), providerKey: agent, variant: null };
      }
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

async function runPrepareEngine({ prepareTask, includePrepareTask = true }: RunPrepareEngineOptions = {}) {
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
  assert.match(String(result.failure.reason), /prepareTask|prepare_task/i);
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

  const materialized = materializeJob(events) as LooseRecord;
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
  assert.equal(nodeTransitions.length, 6, "should have start+completed for each of three nodes");
  assert.deepEqual(
    nodeTransitions.filter((transition) => transition.endsWith(":plan")),
    ["dag_node_started:plan", "dag_node_completed:plan"],
  );
  assert.ok(
    nodeTransitions.findIndex((transition) => transition === "dag_node_started:plan")
    < nodeTransitions.findIndex((transition) => transition === "dag_node_completed:plan"),
    "plan start should precede plan completion",
  );
  assert.ok(
    nodeTransitions.findIndex((transition) => transition === "dag_node_started:execute")
    < nodeTransitions.findIndex((transition) => transition === "dag_node_completed:execute"),
    "execute start should precede execute completion",
  );
  assert.ok(
    nodeTransitions.findIndex((transition) => transition === "dag_node_started:verify")
    < nodeTransitions.findIndex((transition) => transition === "dag_node_completed:verify"),
    "verify start should precede verify completion",
  );
  assert.ok(
    nodeTransitions.findIndex((transition) => transition === "dag_node_completed:plan")
    < nodeTransitions.findIndex((transition) => transition === "dag_node_started:execute"),
    "execute cannot start before plan completes",
  );
  assert.ok(
    nodeTransitions.findIndex((transition) => transition === "dag_node_completed:execute")
    < nodeTransitions.findIndex((transition) => transition === "dag_node_started:verify"),
    "verify cannot start before execute completes",
  );

  const materialized = materializeJob(events) as LooseRecord;
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
  const started = events
    .filter((event) => event.type === "dag_node_started")
    .map((event) => event.nodeId);
  const verifyStartedIndex = started.indexOf("verify");
  assert.ok(verifyStartedIndex > 0, "verify should start after execute nodes");
  assert.deepEqual(started.slice(0, 1), ["plan"]);
  assert.ok(started.includes("execute_a") && started.includes("execute_b"), "both execute nodes should start");
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

test("runJob overlaps read-only reviews and commits their durable events in DAG order", async () => {
  registerDagWorkflow("parallel-review-dag-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "review_security", phase: "review", role: "security-reviewer", dependsOn: ["execute"], checklistNeutral: true, parallelSafe: true },
      { id: "review_quality", phase: "review", role: "reviewer", dependsOn: ["execute"], checklistNeutral: true, parallelSafe: true },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["review_security", "review_quality"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-parallel-review-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events: LooseRecord[] = [];
  const services = makeServices({ events, prepareTask: async () => ({ riskMap: mediumRiskMap() }) });
  const reviewReleases = new Map<string, ReturnType<typeof deferred>>();
  const reviewStarted: string[] = [];
  const actualReviewCompletion: string[] = [];
  let inFlightReviews = 0;
  let maxInFlightReviews = 0;

  const run = runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "parallel read-only review DAG fixture",
    jobId: "job-parallel-review-dag",
    workflow: "parallel-review-dag-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      "security-reviewer": "fake-security",
      reviewer: "fake-reviewer",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => ({
      async execute(agent, prompt, _cwd, _timeoutMs, meta) {
        if (/\bdecomposedItems\b/.test(prompt)) {
          return { output: decomposeOutput(), providerKey: agent, variant: null };
        }
        if (meta.phase === "review") {
          const role = String(meta.role);
          const release = deferred();
          reviewReleases.set(role, release);
          reviewStarted.push(role);
          inFlightReviews += 1;
          maxInFlightReviews = Math.max(maxInFlightReviews, inFlightReviews);
          await release.promise;
          actualReviewCompletion.push(role);
          inFlightReviews -= 1;
          return { output: reviewOutput(`${role} approved the candidate.`), providerKey: agent, variant: null };
        }
        return { output: phaseOutput(String(meta.role)), providerKey: agent, variant: null };
      },
      async releaseWorktree() {
        return true;
      },
    }),
  });

  try {
    await waitFor(() => reviewStarted.length === 2, "both independent reviews should start before either completes");
    assert.equal(maxInFlightReviews, 2);
    reviewReleases.get("reviewer")?.resolve(undefined);
    await waitFor(() => actualReviewCompletion.includes("reviewer"), "quality review should finish first");
    reviewReleases.get("security-reviewer")?.resolve(undefined);

    const result = await run;
    assert.equal(result.status, "completed", JSON.stringify(result.failure || result, null, 2));
    assert.deepEqual(actualReviewCompletion, ["reviewer", "security-reviewer"]);
    const reviewArtifacts = events
      .filter((event) => event.type === "phase_completed" && event.phase === "review")
      .map((event) => String(event.artifact));
    assert.equal(reviewArtifacts.length, 2);
    assert.equal(new Set(reviewArtifacts).size, 2, "parallel reviews must retain distinct artifacts");
    assert.equal((await reviewArtifactFiles(dataRoot)).length, 2, "successful parallel reviews must commit both files");
    assert.deepEqual(
      events
        .filter((event) => event.type === "dag_node_started" || event.type === "dag_node_completed")
        .filter((event) => event.nodeId === "review_security" || event.nodeId === "review_quality")
        .map((event) => `${event.type}:${event.nodeId}`),
      [
        "dag_node_started:review_security",
        "dag_node_completed:review_security",
        "dag_node_started:review_quality",
        "dag_node_completed:review_quality",
      ],
    );
    const dagEvent = events.find((event) => event.type === "workflow_dag_materialized");
    assert.equal(dagEvent?.executionMode, "bounded_dependency_parallel");
    assert.equal(dagEvent?.dagParallelExecutionReady, true);
    assert.equal(dagEvent?.dagParallelExecutionEnabled, true);
  } finally {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      for (const release of reviewReleases.values()) release.resolve(undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await run.catch(() => undefined);
  }
});

test("runJob keeps independent mutating execute nodes exclusive", async () => {
  registerDagWorkflow("exclusive-execute-dag-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute_a", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "execute_b", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute_a", "execute_b"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-exclusive-execute-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events: LooseRecord[] = [];
  const services = makeServices({ events, prepareTask: async () => ({ riskMap: mediumRiskMap() }) });
  const executeReleases: Array<ReturnType<typeof deferred>> = [];
  let executeStarted = 0;
  let inFlightExecute = 0;
  let maxInFlightExecute = 0;

  const run = runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "exclusive mutating execute DAG fixture",
    jobId: "job-exclusive-execute-dag",
    workflow: "exclusive-execute-dag-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: { planner: "fake-primary", executor: "fake-primary", verifier: "fake-primary" },
    ...services,
    getPool: () => ({
      async execute(agent, prompt, _cwd, _timeoutMs, meta) {
        if (/\bdecomposedItems\b/.test(prompt)) {
          return { output: decomposeOutput(), providerKey: agent, variant: null };
        }
        if (meta.phase === "execute") {
          const release = deferred();
          executeReleases.push(release);
          executeStarted += 1;
          inFlightExecute += 1;
          maxInFlightExecute = Math.max(maxInFlightExecute, inFlightExecute);
          await release.promise;
          inFlightExecute -= 1;
        }
        return { output: phaseOutput(String(meta.role)), providerKey: agent, variant: null };
      },
      async releaseWorktree() {
        return true;
      },
    }),
  });

  try {
    await waitFor(() => executeStarted === 1, "first execute node should start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(executeStarted, 1, "second mutating node must not overlap the first");
    executeReleases[0].resolve(undefined);
    await waitFor(() => executeStarted === 2, "second execute node should start after the first completes");
    executeReleases[1].resolve(undefined);
    const result = await run;
    assert.equal(result.status, "completed", JSON.stringify(result.failure || result, null, 2));
    assert.equal(maxInFlightExecute, 1);
  } finally {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      for (const release of executeReleases) release.resolve(undefined);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await run.catch(() => undefined);
  }
});

test("runJob serializes otherwise-safe review nodes that share a conflict key", async () => {
  registerDagWorkflow("conflicting-review-dag-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "review_a", phase: "review", role: "security-reviewer", dependsOn: ["execute"], checklistNeutral: true, conflictKey: "shared-audit" },
      { id: "review_b", phase: "review", role: "reviewer", dependsOn: ["execute"], checklistNeutral: true, conflictKey: "shared-audit" },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["review_a", "review_b"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-conflicting-review-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const services = makeServices({ prepareTask: async () => ({ riskMap: mediumRiskMap() }) });
  const firstRelease = deferred();
  let reviewStarted = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const run = runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "conflicting review DAG fixture",
    jobId: "job-conflicting-review-dag",
    workflow: "conflicting-review-dag-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      "security-reviewer": "fake-security",
      reviewer: "fake-reviewer",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => ({
      async execute(agent, prompt, _cwd, _timeoutMs, meta) {
        if (/\bdecomposedItems\b/.test(prompt)) {
          return { output: decomposeOutput(), providerKey: agent, variant: null };
        }
        if (meta.phase === "review") {
          reviewStarted += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (reviewStarted === 1) await firstRelease.promise;
          inFlight -= 1;
          return { output: reviewOutput("conflict-key review approved"), providerKey: agent, variant: null };
        }
        return { output: phaseOutput(String(meta.role)), providerKey: agent, variant: null };
      },
      async releaseWorktree() {
        return true;
      },
    }),
  });

  try {
    await waitFor(() => reviewStarted === 1, "first conflicting review should start");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(reviewStarted, 1, "same conflict key must serialize ready review nodes");
    firstRelease.resolve(undefined);
    const result = await run;
    assert.equal(result.status, "completed", JSON.stringify(result.failure || result, null, 2));
    assert.equal(reviewStarted, 2);
    assert.equal(maxInFlight, 1);
  } finally {
    firstRelease.resolve(undefined);
    await run.catch(() => undefined);
  }
});

test("runJob cancels an active parallel review wave and all downstream nodes", async () => {
  registerDagWorkflow("cancelled-review-dag-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "review_a", phase: "review", role: "security-reviewer", dependsOn: ["execute"], checklistNeutral: true },
      { id: "review_b", phase: "review", role: "reviewer", dependsOn: ["execute"], checklistNeutral: true },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["review_a", "review_b"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-cancelled-review-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events: LooseRecord[] = [];
  const failed: LooseRecord[] = [];
  const services = makeServices({ events, failed, prepareTask: async () => ({ riskMap: mediumRiskMap() }) });
  const controller = new AbortController();
  const releases: Array<ReturnType<typeof deferred>> = [];
  let reviewStarted = 0;

  const run = runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "cancelled parallel review DAG fixture",
    jobId: "job-cancelled-review-dag",
    workflow: "cancelled-review-dag-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    signal: controller.signal,
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      "security-reviewer": "fake-security",
      reviewer: "fake-reviewer",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => ({
      async execute(agent, prompt, _cwd, _timeoutMs, meta) {
        if (/\bdecomposedItems\b/.test(prompt)) {
          return { output: decomposeOutput(), providerKey: agent, variant: null };
        }
        if (meta.phase === "review") {
          const release = deferred();
          releases.push(release);
          reviewStarted += 1;
          await release.promise;
          return { output: reviewOutput("cancelled review result must not commit"), providerKey: agent, variant: null };
        }
        return { output: phaseOutput(String(meta.role)), providerKey: agent, variant: null };
      },
      async releaseWorktree() {
        return true;
      },
    }),
  });

  try {
    await waitFor(() => reviewStarted === 2, "both reviews should be active before cancellation");
    controller.abort();
    const result = await settleWithin(
      run,
      250,
      "abort must return without waiting for non-cooperative parallel reviews",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.kind, FailureKind.RUNTIME_INTERRUPTED);
    assert.equal(failed.length, 1, "job failure must be persisted exactly once");
    assert.deepEqual(
      events.filter((event) => event.type === "dag_node_cancelled").map((event) => event.nodeId),
      ["review_a", "review_b", "verify"],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "dag_node_completed")
        .filter((event) => event.nodeId === "review_a" || event.nodeId === "review_b"),
      [],
      "cancelled parallel results must not enter durable completion state",
    );
    assert.deepEqual(
      events.filter((event) => event.type === "phase_completed" && event.phase === "review"),
      [],
    );
    assert.deepEqual(await reviewArtifactFiles(dataRoot), [], "cancelled review artifacts must not be written");
    for (const release of releases) release.resolve(undefined);
    await flushAsyncWork();
    assert.deepEqual(await reviewArtifactFiles(dataRoot), [], "late cancelled reviews must remain discarded");
  } finally {
    controller.abort();
    for (const release of releases) release.resolve(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

test("runJob reports runtime_interrupted when checklist artifact commit is aborted mid-write", async () => {
  const cpbRoot = await tempRoot("cpb-checklist-mid-write-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events: LooseRecord[] = [];
  const failed: LooseRecord[] = [];
  const calls: LooseRecord[] = [];
  const services = makeServices({
    events,
    failed,
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
  });
  const controller = new AbortController();
  let hookCalls = 0;
  const result = await withArtifactStoreTestHooks({
    afterTempWrite: async ({ path: committedPath }) => {
      if (path.basename(committedPath).startsWith("acceptance-checklist-")) {
        hookCalls += 1;
        controller.abort();
      }
    },
  }, () => runJob({
      cpbRoot,
      dataRoot,
      project: "flow",
      task: "prepare_task mid-write abort fixture",
      jobId: "job-checklist-mid-write-abort",
      workflow: "standard",
      planMode: "full",
      sourcePath,
      sourceContext: {},
      signal: controller.signal,
      agents: {
        planner: "fake-primary",
        executor: "fake-primary",
        verifier: "fake-primary",
      },
      ...services,
      getPool: () => makePool({ calls }),
    }));

  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(result.failure?.retryable, false);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(failed[0].retryable, false);
  assert.equal(hookCalls, 1);
  assert.deepEqual(await outputArtifactEntries(dataRoot), []);
  assert.deepEqual(
    events.filter((event) => event.type === "artifact_created"),
    [],
    "aborted checklist artifact must not be event-indexed",
  );
});

test("runJob fails fast and discards sibling artifacts when one parallel review fails", async () => {
  registerDagWorkflow("failed-parallel-review-dag-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "review_security", phase: "review", role: "security-reviewer", dependsOn: ["execute"], checklistNeutral: true },
      { id: "review_quality", phase: "review", role: "reviewer", dependsOn: ["execute"], checklistNeutral: true },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["review_security", "review_quality"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-failed-parallel-review-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events: LooseRecord[] = [];
  const failed: LooseRecord[] = [];
  const services = makeServices({ events, failed, prepareTask: async () => ({ riskMap: mediumRiskMap() }) });
  const qualityRelease = deferred();
  const qualityStarted = deferred();
  let qualityCalls = 0;

  const run = runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "failed parallel review DAG fixture",
    jobId: "job-failed-parallel-review-dag",
    workflow: "failed-parallel-review-dag-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      "security-reviewer": "fake-security",
      reviewer: "fake-reviewer",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => ({
      async execute(agent, prompt, _cwd, _timeoutMs, meta) {
        if (/\bdecomposedItems\b/.test(prompt)) {
          return { output: decomposeOutput(), providerKey: agent, variant: null };
        }
        if (meta.phase === "review" && meta.role === "reviewer") {
          qualityCalls += 1;
          qualityStarted.resolve(undefined);
          await qualityRelease.promise;
          return { output: reviewOutput("discarded sibling result"), providerKey: agent, variant: null };
        }
        if (meta.phase === "review") {
          await qualityStarted.promise;
          return { output: "not a review JSON envelope", providerKey: agent, variant: null };
        }
        return { output: phaseOutput(String(meta.role)), providerKey: agent, variant: null };
      },
      async releaseWorktree() {
        return true;
      },
    }),
  });

  try {
    const result = await settleWithin(
      run,
      500,
      "terminal review failure must not wait for a non-cooperative sibling",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.nodeId, "review_security");
    assert.equal(failed.length, 1, "parallel terminal failure must persist exactly one job failure");
    assert.ok(qualityCalls > 0, "the sibling review must have been active");
    assert.deepEqual(
      events.filter((event) => event.type === "dag_node_failed").map((event) => event.nodeId),
      ["review_security"],
    );
    assert.deepEqual(
      events.filter((event) => event.type === "dag_node_cancelled").map((event) => event.nodeId),
      ["review_quality", "verify"],
    );
    assert.deepEqual(
      events
        .filter((event) => event.type === "dag_node_completed")
        .filter((event) => event.nodeId === "review_security" || event.nodeId === "review_quality"),
      [],
    );
    assert.deepEqual(
      events.filter((event) => event.type === "phase_completed" && event.phase === "review"),
      [],
    );
    assert.deepEqual(await reviewArtifactFiles(dataRoot), [], "failed wave must not commit sibling review files");
    qualityRelease.resolve(undefined);
    await flushAsyncWork();
    assert.deepEqual(await reviewArtifactFiles(dataRoot), [], "late sibling completion must remain discarded");
  } finally {
    qualityRelease.resolve(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

test("runJob converts a thrown parallel review into one deterministic DAG failure", async () => {
  registerDagWorkflow("thrown-parallel-review-dag-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "review_security", phase: "review", role: "security-reviewer", dependsOn: ["execute"], checklistNeutral: true },
      { id: "review_quality", phase: "review", role: "reviewer", dependsOn: ["execute"], checklistNeutral: true },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["review_security", "review_quality"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-thrown-parallel-review-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events: LooseRecord[] = [];
  const failed: LooseRecord[] = [];
  const services = makeServices({ events, failed, prepareTask: async () => ({ riskMap: mediumRiskMap() }) });
  const qualityRelease = deferred();
  const qualityStarted = deferred();
  const providerCause = Object.assign(new Error("upstream quota service refused the request"), {
    code: "UPSTREAM_QUOTA_REFUSED",
  });

  const run = runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "thrown parallel review DAG fixture",
    jobId: "job-thrown-parallel-review-dag",
    workflow: "thrown-parallel-review-dag-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      "security-reviewer": "fake-security",
      reviewer: "fake-reviewer",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => ({
      async execute(agent, prompt, _cwd, _timeoutMs, meta) {
        if (/\bdecomposedItems\b/.test(prompt)) {
          return { output: decomposeOutput(), providerKey: agent, variant: null };
        }
        if (meta.phase === "review" && meta.role === "reviewer") {
          qualityStarted.resolve(undefined);
          await qualityRelease.promise;
          return { output: reviewOutput("discarded thrown-error sibling result"), providerKey: agent, variant: null };
        }
        if (meta.phase === "review") {
          await qualityStarted.promise;
          const error = new Error("fixture provider pool exhausted");
          error.name = "PoolExhaustedError";
          Object.assign(error, { code: "POOL_EXHAUSTED", cause: providerCause });
          throw error;
        }
        return { output: phaseOutput(String(meta.role)), providerKey: agent, variant: null };
      },
      async releaseWorktree() {
        return true;
      },
    }),
  });

  try {
    const result = await settleWithin(
      run,
      500,
      "thrown parallel node must not wait for a non-cooperative sibling",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.kind, FailureKind.AGENT_UNAVAILABLE);
    assert.equal(result.failure?.nodeId, "review_security");
    assert.deepEqual((result.failure?.cause as LooseRecord | undefined)?.exceptionCause, {
      name: "Error",
      message: providerCause.message,
      code: providerCause.code,
    });
    assert.equal(failed.length, 1, "thrown node must persist exactly one structured job failure");
    assert.equal(events.some((event) => event.type === "job_panic"), false, "parallel rejection must not escape to panic recovery");
    assert.deepEqual(
      events.filter((event) => event.type === "dag_node_failed").map((event) => event.nodeId),
      ["review_security"],
    );
    assert.deepEqual(
      events.filter((event) => event.type === "dag_node_cancelled").map((event) => event.nodeId),
      ["review_quality", "verify"],
    );
    assert.deepEqual(await reviewArtifactFiles(dataRoot), []);
    qualityRelease.resolve(undefined);
    await flushAsyncWork();
    assert.deepEqual(await reviewArtifactFiles(dataRoot), [], "late sibling result must not escape a sealed buffer");
  } finally {
    qualityRelease.resolve(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

test("runJob treats abort-like parallel rejection as runtime_interrupted before DAG failure persistence", async () => {
  registerDagWorkflow("abort-rejection-parallel-review-dag-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "review_abort", phase: "review", role: "security-reviewer", dependsOn: ["execute"], checklistNeutral: true },
      { id: "review_late", phase: "review", role: "reviewer", dependsOn: ["execute"], checklistNeutral: true },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["review_abort", "review_late"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-abort-rejection-parallel-review-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events: LooseRecord[] = [];
  const failed: LooseRecord[] = [];
  const services = makeServices({ events, failed, prepareTask: async () => ({ riskMap: mediumRiskMap() }) });
  const controller = new AbortController();
  const lateRelease = deferred();
  const lateStarted = deferred();
  let abortingNodeStarted = false;
  let lateCalls = 0;

  const run = runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "abort-like parallel review rejection fixture",
    jobId: "job-abort-rejection-parallel-review-dag",
    workflow: "abort-rejection-parallel-review-dag-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    signal: controller.signal,
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      "security-reviewer": "fake-security",
      reviewer: "fake-reviewer",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => ({
      async execute(agent, prompt, _cwd, _timeoutMs, meta) {
        if (/\bdecomposedItems\b/.test(prompt)) {
          return { output: decomposeOutput(), providerKey: agent, variant: null };
        }
        if (meta.phase === "review" && meta.role === "reviewer") {
          lateCalls += 1;
          lateStarted.resolve(undefined);
          await lateRelease.promise;
          return { output: reviewOutput("late sibling result must not commit"), providerKey: agent, variant: null };
        }
        if (meta.phase === "review") {
          abortingNodeStarted = true;
          await lateStarted.promise;
          setImmediate(() => controller.abort());
          const error = new Error("fixture parallel provider abort");
          error.name = "PoolExhaustedError";
          Object.assign(error, { code: "ABORT_ERR" });
          throw error;
        }
        return { output: phaseOutput(String(meta.role)), providerKey: agent, variant: null };
      },
      async releaseWorktree() {
        return true;
      },
    }),
  });

  try {
    await waitFor(() => abortingNodeStarted && lateCalls > 0, "both parallel reviews should be active");
    const result = await settleWithin(
      run,
      500,
      "abort-like parallel rejection must not wait for a non-cooperative sibling",
    );
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.kind, FailureKind.RUNTIME_INTERRUPTED);
    assert.equal(result.failure?.retryable, false);
    assert.equal(failed.length, 1, "abort-like parallel rejection must persist exactly one runtime interruption");
    assert.equal(failed[0].code, FailureKind.RUNTIME_INTERRUPTED);
    assert.equal(events.some((event) => event.type === "job_panic"), false, "abort-like rejection must not escape to panic recovery");
    assert.deepEqual(
      events.filter((event) => event.type === "dag_node_failed").map((event) => event.nodeId),
      [],
      "abort-like rejection must not be persisted as a DAG node failure",
    );
    assert.deepEqual(
      events.filter((event) => event.type === "job_failed" && event.code === FailureKind.UNKNOWN),
      [],
      "abort-like rejection must not be misclassified as UNKNOWN",
    );
    assert.deepEqual(await reviewArtifactFiles(dataRoot), []);
    lateRelease.resolve(undefined);
    await flushAsyncWork();
    const reviewEntries = (await outputArtifactEntries(dataRoot)).filter((entry) => entry.includes("review"));
    assert.deepEqual(reviewEntries, [], "late sibling review reservations and artifacts must remain discarded");
  } finally {
    controller.abort();
    lateRelease.resolve(undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

test("workflow registration fails when a DAG node depends on removed node", () => {
  assert.throws(() => {
    registerDagWorkflow("materialize-invalid-dependency-fixture", {
    nodes: [
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute"] },
    ],
    maxConcurrentNodes: 1,
  });
  }, /invalid DAG: node execute depends on unknown node/);
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
  assert.equal(dagEvent.executionMode, "bounded_dependency_parallel");
  assert.equal(dagEvent.dagNodeFirstSequentialReady, true);
  assert.equal(dagEvent.dagParallelExecutionReady, true);
  assert.equal(dagEvent.dagParallelExecutionEnabled, false);
  assert.equal(dagEvent.attemptId, "job-same-phase-dag");
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
  assert.equal((result.failure as LooseRecord).nodeId, "execute_b");
  const materialized = materializeJob(events) as LooseRecord;
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
  const materialized = materializeJob(events) as LooseRecord;
  assert.deepEqual(materialized.completedNodes, ["plan", "execute_a", "execute_b", "verify"]);
  assert.equal(materialized.nodeStates.plan.status, "skipped");
  assert.equal(materialized.nodeStates.execute_a.status, "skipped");
});

test("runJob never cancels resume-completed DAG nodes when execution is already aborted", async () => {
  registerDagWorkflow("resume-completed-abort-fixture", {
    maxConcurrentNodes: 1,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["execute"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-resume-abort-dag-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const planPath = path.join(dataRoot, "wiki", "inbox", "plan-001.md");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, "# Recovered Plan\n\nContinue from execute.\n", "utf8");
  const events: LooseRecord[] = [{
    type: "dag_node_completed",
    project: "flow",
    jobId: "job-resume-abort-dag",
    nodeId: "plan",
    phase: "plan",
    role: "planner",
    ts: "2026-07-20T00:00:00.000Z",
  }];
  const failed: LooseRecord[] = [];
  const services = makeServices({
    events,
    failed,
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
  });
  const controller = new AbortController();
  controller.abort();

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "resume completed node abort fixture",
    jobId: "job-resume-abort-dag",
    workflow: "resume-completed-abort-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {
      retry: {
        completedNodeIds: ["plan"],
        resumeTarget: { nodeId: "execute", phase: "execute" },
        artifacts: { plan: "plan-001" },
      },
    },
    signal: controller.signal,
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => makePool(),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(failed.length, 1);
  assert.deepEqual(
    events.filter((event) => event.type === "dag_node_cancelled").map((event) => event.nodeId),
    ["execute", "verify"],
  );
  const materialized = materializeJob(events) as LooseRecord;
  assert.equal(materialized.nodeStates.plan.status, "completed");
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

test("parallel replay failure preserves published effects and discards every unpublished reservation", async () => {
  registerDagWorkflow("parallel-replay-failure-fixture", {
    maxConcurrentNodes: 2,
    nodes: [
      { id: "plan", phase: "plan", role: "planner", dependsOn: [] },
      { id: "execute", phase: "execute", role: "executor", dependsOn: ["plan"] },
      { id: "review_a", phase: "review", role: "security-reviewer", dependsOn: ["execute"], checklistNeutral: true },
      { id: "review_b", phase: "review", role: "reviewer", dependsOn: ["execute"], checklistNeutral: true },
      { id: "verify", phase: "verify", role: "verifier", dependsOn: ["review_a", "review_b"] },
    ],
  });
  const cpbRoot = await tempRoot("cpb-parallel-replay-failure");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events: LooseRecord[] = [];
  const failed: LooseRecord[] = [];
  const services = makeServices({ events, failed, prepareTask: async () => ({ riskMap: mediumRiskMap() }) });
  const replayFailure = new Error("durable review event replay failed");
  let injected = false;

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "parallel replay cleanup fixture",
    jobId: "job-parallel-replay-failure",
    workflow: "parallel-replay-failure-fixture",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      "security-reviewer": "fake-security",
      reviewer: "fake-reviewer",
      verifier: "fake-primary",
    },
    ...services,
    appendEvent: async (root, project, jobId, event) => {
      if (!injected && event.type === "dag_node_completed" && event.phase === "review") {
        injected = true;
        throw replayFailure;
      }
      return services.appendEvent(root, project, jobId, event);
    },
    getPool: () => makePool(),
  });

  assert.equal(result.status, "failed");
  assert.equal(injected, true);
  assert.equal(
    (await reviewArtifactFiles(dataRoot)).length,
    1,
    "the artifact published before replay failed remains durable; the sibling reservation is discarded",
  );
  assert.deepEqual(
    (await outputArtifactEntries(dataRoot)).filter((entry) => entry.startsWith(".lock-") || entry.endsWith(".tmp")),
    [],
    "all published and unpublished reservations must reach a cleanup terminal state",
  );
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
    // Reference the auto-constructed checklist so this externally injected plan
    // survives the freeze-stage rebuild guard (plans not bound to the frozen
    // checklist are regenerated from the risk map).
    acceptanceChecklistArtifact: { id: "stub", name: "acceptance-checklist-stub" },
  };

  const { result, events } = await runPrepareEngine({
    prepareTask: async () => ({ riskMap: { ...mediumRiskMap(), riskLevel: "high", adversarialRequired: true }, dynamicAgentPlan }),
  });

  assert.equal(result.status, "completed");
  const planEvent = events.find((event) => event.type === "dynamic_agent_plan_generated");
  assert.ok(planEvent, "dynamic_agent_plan_generated event should be emitted");
  assert.deepEqual(planEvent.dynamicAgentPlan, dynamicAgentPlan);

  const materialized = materializeJob(events) as LooseRecord;
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

  const materialized = materializeJob(events) as LooseRecord;
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
