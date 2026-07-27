/**
 * Characterization tests for runDagNode (core/engine/run-job-execute-dag.ts:457).
 *
 * PHASE 0 contract freeze. These tests pin the CURRENT observable behavior of
 * runDagNode so that the planned Phase 4 extraction (decision /
 * attempt-runner / outcome-finalizer) cannot silently change it. Every
 * assertion reflects what the code does today — not what it "should" do.
 *
 * Drive seam: the lowest-level exported deterministic entry that exercises
 * runDagNode is executeWorkflowDag, but its DagRunSession inputs are assembled
 * by runJob from a caller-provided ctx + injected RunJobPorts (fake services
 * + fake provider pool). Existing core/engine tests (engine-run-job,
 * engine-prepare-task, engine-provider-event) all drive this seam with fake
 * ports and a fake pool whose execute() returns role-keyed JSON envelopes.
 * We reuse that proven idiom — no real ACP processes are spawned.
 *
 * The fake pool controls the only non-deterministic boundary (the agent
 * provider); every other input is either injected (ports, sourceContext,
 * riskMap) or filesystem-derived from a private temp root. Git is used only
 * for scope-guard changed-file detection, exactly as the existing
 * verification-infra test does (git init in a temp root).
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { LooseRecord, recordValue } from "../shared/types.js";

import { FailureKind } from "../core/contracts/failure.js";
import { runJob as runJobImpl } from "../core/engine/run-job.js";
import { tempRoot } from "./helpers.js";

const execFile = promisify(execFileCallback);

// Job-local env overrides for deterministic retry timing — mirrors
// tests/engine-run-job.test.ts so feedback/retry loops fire at most once.
const TEST_JOB_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  CPB_PHASE_RETRY_MAX: "1",
  CPB_PHASE_RETRY_BASE_DELAY_MS: "0",
  CPB_PHASE_FEEDBACK_RETRY_MAX: "1",
};

const runJob = (ctx: LooseRecord) => runJobImpl({
  ...ctx,
  env: ctx.env ?? TEST_JOB_ENV,
});

// ─── Shared fake fixtures (same shape as engine-run-job.test.ts) ─────

function jsonEnvelope(data: LooseRecord) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

function phaseOutput(role: string, overrides: LooseRecord = {}) {
  if (role === "planner") {
    return jsonEnvelope({
      status: "ok",
      planMarkdown: [
        "## Analysis",
        "- runDagNode characterization fixture plan.",
        "",
        "## Bounded Handoff",
        "- Real actors: runDagNode fixture and README.md",
        "- Entrypoints: standard workflow DAG execution",
        "- Bypass candidates: provider fallback and retry paths",
        "- Edit files: README.md",
        "- Verification targets: node:test fixture",
        "- Blockers: none",
        "",
        "## Files to modify",
        "- README.md",
        "",
        "## Implementation Steps",
        "1. Step one.",
        "",
        "## Testing",
        "- node:test fixture",
        "",
        "## Risks",
        "- None.",
      ].join("\n"),
      ...overrides,
    });
  }
  if (role === "executor" || role === "security-reviewer") {
    return jsonEnvelope({
      status: "ok",
      summary: "runDagNode fixture execution completed.",
      tests: ["tests/run-dag-node-characterization.test.js"],
      risks: [],
      ...overrides,
    });
  }
  // verifier / adversarial_verifier
  const verdictStatus = String(overrides.verdict || "pass").toLowerCase() === "pass" ? "pass" : "fail";
  return jsonEnvelope({
    status: "ok",
    verdict: verdictStatus,
    reason: "runDagNode fixture verified.",
    details: "Fake provider completed the phase.",
    confidence: 1,
    checklistVerdict: {
      schemaVersion: 1,
      jobId: "job-runjob-test",
      status: verdictStatus,
      items: [
        {
          checklistId: "AC-001",
          result: verdictStatus,
          evidenceRefs: verdictStatus === "pass" ? [{ ledgerId: "evidence-ledger-job-runjob-test", evidenceId: "EV-001" }] : [],
          actualResult: verdictStatus === "pass" ? "fixture verified" : "fixture failed",
          reason: verdictStatus === "pass" ? "fake verifier confirms the fixture" : "fake verifier reports fixture failure",
          fixScope: verdictStatus === "pass" ? [] : ["README.md"],
        },
      ],
      blocking: verdictStatus === "pass" ? [] : [{ checklistId: "AC-001" }],
      fixScope: verdictStatus === "pass" ? [] : ["README.md"],
      reason: verdictStatus === "pass" ? "all items passed with evidence" : "required item failed",
    },
    ...overrides,
  });
}

function decomposeOutput(overrides: LooseRecord = {}) {
  return jsonEnvelope({
    status: "ok",
    decomposedItems: [
      {
        requirement: "README is updated by the runDagNode fixture.",
        predicateId: "runjob-readme-update",
        verificationMethod: "static",
        allowedFiles: ["README.md"],
        sourceRefs: [{ kind: "task_text", locator: "task:0" }],
        expectedEvidence: "README.md is changed by the fixture execution",
      },
    ],
    ...overrides,
  });
}

function mediumRiskMap(): LooseRecord {
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

type EngineServiceOptions = {
  events?: LooseRecord[];
  starts?: string[];
  completed?: string[];
  blocked?: LooseRecord[];
  failed?: LooseRecord[];
  createJob?: (cpbRoot: string, job: LooseRecord) => Promise<LooseRecord> | LooseRecord;
  prepareTask?: (cpbRoot?: string, input?: LooseRecord) => Promise<LooseRecord> | LooseRecord;
  failJob?: (cpbRoot: string, project: string, jobId: string, fail: LooseRecord) => Promise<unknown> | unknown;
};

type EnginePoolOptions = {
  calls?: LooseRecord[];
  failWhen?: (args: { call: LooseRecord; calls: LooseRecord[] }) => boolean;
  customOutput?: (args: { call: LooseRecord; calls: LooseRecord[] }) => string | undefined;
  customResult?: (
    args: { call: LooseRecord; calls: LooseRecord[] },
  ) => Promise<LooseRecord | undefined> | LooseRecord | undefined;
};

async function makeSourceRoot(prefix = "cpb-rdn-source") {
  const sourcePath = await tempRoot(prefix);
  await writeFile(path.join(sourcePath, "README.md"), "# runDagNode fixture\n", "utf8");
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({ name: "rdn-fixture", private: true }, null, 2)}\n`,
    "utf8",
  );
  return sourcePath;
}

function makeServices(opts: EngineServiceOptions = {}) {
  const events = opts.events ?? [];
  const starts = opts.starts ?? [];
  const completed = opts.completed ?? [];
  const blocked = opts.blocked ?? [];
  const failed = opts.failed ?? [];

  return {
    createJob:
      opts.createJob ??
      (async (_cpbRoot: string, job: LooseRecord) => ({
        ...job,
        jobId: job.jobId || "job-runjob-test",
        status: "running",
      })),
    prepareTask: opts.prepareTask ?? (async () => ({ riskMap: mediumRiskMap() })),
    startPhase: async (_cpbRoot: string, _project: string, _jobId: string, payload: LooseRecord) => {
      starts.push(payload.phase);
      events.push({ type: "phase_started", phase: payload.phase, agent: payload.agent || null, role: payload.role || null });
    },
    completePhase: async (_cpbRoot: string, _project: string, _jobId: string, payload: LooseRecord) => {
      completed.push(payload.phase);
    },
    completeJob: async (_cpbRoot: string, _project: string, _jobId: string) => {
      events.push({ type: "job_completed" });
    },
    blockJob: async (_cpbRoot: string, _project: string, _jobId: string, block: LooseRecord) => {
      blocked.push(block);
    },
    failJob:
      opts.failJob ??
      (async (_cpbRoot: string, _project: string, _jobId: string, fail: LooseRecord) => {
        failed.push(fail);
      }),
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: LooseRecord) => {
      events.push(event);
      return event;
    },
  };
}

function makePool(opts: EnginePoolOptions = {}) {
  const calls = opts.calls ?? [];
  return {
    async execute(agent: string, prompt: string, cwd: string, timeoutMs: number, meta: LooseRecord) {
      const call = { agent, prompt, cwd, timeoutMs, meta };
      if (/\bdecomposedItems\b/.test(prompt)) {
        if (opts.failWhen?.({ call, calls })) {
          throw new Error("fixture forced provider failure");
        }
        const customOutput = opts.customOutput?.({ call, calls });
        return {
          output: customOutput ?? decomposeOutput(),
          providerKey: agent,
          variant: null,
        };
      }
      calls.push(call);
      if (opts.failWhen?.({ call, calls })) {
        throw new Error("fixture forced provider failure");
      }
      const customOutput = opts.customOutput?.({ call, calls });
      const customResult = await opts.customResult?.({ call, calls });
      return {
        output: customOutput ?? phaseOutput(meta.role),
        providerKey: agent,
        variant: null,
        ...customResult,
      };
    },
    async releaseWorktree() {
      return true;
    },
  };
}

interface RunEngineOpts {
  services?: LooseRecord;
  poolOpts?: LooseRecord;
  sourceContext?: LooseRecord;
  env?: NodeJS.ProcessEnv;
  workflow?: string;
  jobId?: string;
  signal?: AbortSignal;
  sourcePath?: string;
  agents?: LooseRecord;
  prepareTask?: EngineServiceOptions["prepareTask"];
}

async function runEngine(opts: RunEngineOpts = {}) {
  const cpbRoot = await tempRoot("cpb-rdn-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = opts.sourcePath ?? await makeSourceRoot();
  const events: LooseRecord[] = [];
  const calls: LooseRecord[] = [];
  const poolOpts = { calls, ...opts.poolOpts };
  const services = opts.services ?? makeServices({ events, prepareTask: opts.prepareTask });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "runDagNode characterization fixture",
    jobId: opts.jobId ?? "job-runjob-test",
    workflow: opts.workflow ?? "standard",
    planMode: "full",
    sourcePath,
    sourceContext: opts.sourceContext ?? {},
    env: opts.env,
    signal: opts.signal,
    agents: opts.agents ?? {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    ...services,
    getPool: () => makePool(poolOpts),
  });

  return { result, calls, events, cpbRoot, dataRoot, sourcePath, services };
}

// ═══════════════════════════════════════════════════════════════════════
// DECISION: phase -> role -> agent routing
//
// runDagNode resolves role = stringValue(dagNode.role) || phaseRoleMap[phase]
// || phase, then resolvePhaseAgentRouting maps role -> configured agent. The
// selected agent reaches the pool as the `agent` argument. This is the
// "decision" facet Phase 4 plans to extract.
// ═══════════════════════════════════════════════════════════════════════

test("runDagNode decision: maps each phase node to its semantic role and configured agent", async () => {
  const { result, calls, events } = await runEngine({
    agents: {
      planner: "fake-planner-agent",
      executor: "fake-executor-agent",
      verifier: "fake-verifier-agent",
    },
  });

  assert.equal(result.status, "completed", `expected completed, got: ${JSON.stringify(result.failure)}`);

  // phase -> role mapping is pinned: plan/planner, execute/executor, verify/verifier.
  assert.deepEqual(
    calls.map((c) => recordValue(c.meta).role),
    ["planner", "executor", "verifier"],
    "runDagNode must route plan->planner, execute->executor, verify->verifier",
  );

  // role -> agent mapping: each role resolves to the agent configured for it.
  assert.deepEqual(
    calls.map((c) => c.agent),
    ["fake-planner-agent", "fake-executor-agent", "fake-verifier-agent"],
    "runDagNode must pass the role-configured agent to the pool",
  );

  // nodeId defaults to the dag node id (which for a standard linear DAG equals
  // the phase name) and is stamped on every dag_node_* lifecycle event.
  const started = events.filter((e) => e.type === "dag_node_started").map((e) => `${e.nodeId}:${e.role}`);
  assert.deepEqual(started, ["plan:planner", "execute:executor", "verify:verifier"]);
});

test("runDagNode decision: high-risk map inserts adversarial_verify routed to adversarial_verifier role", async () => {
  const { result, calls } = await runEngine({
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-verifier-agent",
      adversarial_verifier: "fake-adversarial-agent",
    },
    prepareTask: async () => ({
      riskMap: {
        ...mediumRiskMap(),
        riskLevel: "high",
        adversarialRequired: true,
        adversarialFocus: ["scope boundary"],
      },
    }),
  });

  assert.equal(result.status, "completed", `expected completed, got: ${JSON.stringify(result.failure)}`);

  // The adversarial_verify node is appended after verify and routed to the
  // adversarial_verifier role.
  const adversarial = calls.filter((c) => recordValue(c.meta).role === "adversarial_verifier");
  assert.equal(adversarial.length, 1, "adversarial_verify node must run exactly once");

  // High-risk dynamic routing preserves the explicitly configured role agent
  // while enforcing provider-family independence from the executor.
  assert.equal(adversarial[0].agent, "fake-adversarial-agent");
});

// ═══════════════════════════════════════════════════════════════════════
// ATTEMPT-RUNNER: pool invocation envelope
//
// runDagNode's attempt facet composes preflightAndRunPhase -> applyQuotaFallback
// -> applyPhaseRetryLoops. The pool receives a meta envelope carrying phase,
// role, nodeId, and a conversationKey scoped to `${role}::${nodeId}`. Phase 4
// plans to extract this into a dedicated attempt-runner.
// ═══════════════════════════════════════════════════════════════════════

test("runDagNode attempt-runner: pool meta carries phase/role and a role-scoped conversationKey (nodeId encoded inside conversationKey)", async () => {
  const { result, calls } = await runEngine();

  assert.equal(result.status, "completed", `expected completed, got: ${JSON.stringify(result.failure)}`);

  const executor = calls.find((c) => recordValue(c.meta).role === "executor")!;
  const verifier = calls.find((c) => recordValue(c.meta).role === "verifier")!;
  const executorMeta = recordValue(executor.meta);
  const verifierMeta = recordValue(verifier.meta);

  // phase/role are propagated into the pool meta envelope (built by
  // core/agents/agent-runner.ts runAgent -> execPool.execute).
  assert.equal(executorMeta.phase, "execute");
  assert.equal(executorMeta.role, "executor");
  assert.equal(verifierMeta.phase, "verify");

  // CHARACTERIZATION: nodeId is NOT a direct field on the pool meta envelope.
  // runAgent's meta (agent-runner.ts) carries phase/role/projectId/jobId/
  // attemptId/conversationKey/variant/workspaceId/cwd/env/policyHash/dataRoot/
  // onProgress/signal — but NOT nodeId. The nodeId reaches the pool ONLY
  // indirectly, encoded inside conversationKey as `${role}::${nodeId}`
  // (see preflightAndRunPhase -> buildConversationKey({ role: `${n.role}::${n.nodeId}` })).
  // Pinning undefined here guards against Phase 4 accidentally leaking a
  // separate nodeId field into the pool meta during the attempt-runner split.
  assert.equal(executorMeta.nodeId, undefined, "nodeId is not a direct pool meta field today");

  // conversationKey is scoped per role::nodeId, so independent roles never
  // accidentally share an executor conversation.
  assert.equal(
    typeof executorMeta.conversationKey,
    "string",
    "attempt-runner must derive a conversationKey",
  );
  assert.notEqual(
    executorMeta.conversationKey,
    verifierMeta.conversationKey,
    "executor and verifier must use distinct conversation keys",
  );

  // The nodeId reaches the pool ONLY indirectly, URL-encoded inside the
  // conversationKey's role segment. buildConversationKey (core/agents/
  // conversation-key.ts) runs each key part through encodeURIComponent, so
  // the `role::nodeId` pair becomes `role%3A%3AnodeId` in the serialized key.
  // Decoding and checking for the `executor::execute` substring proves the
  // execute node's identity reaches the pool without claiming a top-level
  // meta field that does not exist.
  assert.ok(
    decodeURIComponent(String(executorMeta.conversationKey)).includes("executor::execute"),
    `conversationKey must encode the role::nodeId pair (URL-decoded): ${executorMeta.conversationKey}`,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// OUTCOME-FINALIZER: durable failure landing + terminal propagation
//
// When the phase result is not passed and not a deferrable verification
// failure, runDagNode calls handleDagNodeFailure which writes dag_node_failed
// + failJob, and returns a terminal JobRunResult. executeWorkflowDag then
// cancels all not-yet-executed sibling nodes. This is the "outcome-finalizer"
// facet Phase 4 plans to extract.
// ═══════════════════════════════════════════════════════════════════════

test("runDagNode outcome: non-repairable execute failure lands durable dag_node_failed + failJob and cancels downstream", async () => {
  const events: LooseRecord[] = [];
  const failed: LooseRecord[] = [];
  const services = makeServices({ events, failed });

  const { result, calls } = await runEngine({
    services,
    poolOpts: {
      customOutput: ({ call }: { call: LooseRecord }) => {
        // Executor returns unparseable output -> runExecute classifies
        // AGENT_CONTRACT_INVALID (retryable: false). A non-repairable failure
        // must NOT enter the deferred verification-repair path.
        if (recordValue(call.meta).role === "executor") {
          return "not valid json at all";
        }
        return undefined;
      },
    },
  });

  // Terminal outcome propagates as a structured failure.
  assert.equal(result.status, "failed");
  assert.equal(result.failure.kind, FailureKind.AGENT_CONTRACT_INVALID);
  assert.equal(result.failure.phase, "execute");
  assert.equal(result.failure.retryable, false);
  assert.equal(result.exitCode, 1);

  // Durable landing: a dag_node_failed event is written for the execute node
  // with the canonical failure kind stamped as `code`.
  const nodeFailed = events.find(
    (e) => e.type === "dag_node_failed" && e.nodeId === "execute",
  );
  assert.ok(nodeFailed, "dag_node_failed must be written for the failing node");
  assert.equal(nodeFailed.phase, "execute");
  assert.equal(nodeFailed.role, "executor");
  assert.equal(nodeFailed.code, FailureKind.AGENT_CONTRACT_INVALID);

  // failJob is invoked exactly once with the same canonical code.
  assert.equal(failed.length, 1);
  assert.equal(failed[0].code, FailureKind.AGENT_CONTRACT_INVALID);
  assert.equal(failed[0].phase, "execute");

  // Terminal propagation stops the DAG: the verify node never executes.
  assert.ok(
    !calls.some((c) => recordValue(c.meta).role === "verifier"),
    "downstream verify node must not run after a terminal execute failure",
  );
  // executeWorkflowDag emits a cancellation marker for each unexecuted sibling.
  assert.ok(
    events.some((e) => e.type === "dag_node_cancelled" && e.nodeId === "verify"),
    "downstream verify node must receive a cancellation event",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// OUTCOME-FINALIZER: scope-guard enforcement
//
// After a PASSING execute phase, runDagNode invokes evaluateExecuteScopeGuard.
// The scope-guard reads phaseResult.artifact.metadata.changedFiles (populated
// by the execute adapter from `git diff HEAD`) and compares them against
// phaseSourceContext.retry.fixScope. A mutation outside the frozen fix scope
// produces a terminal SCOPE_VIOLATION failure. This wiring — scope-guard only
// fires for a passing execute node and its terminal return short-circuits
// finalize — is what Phase 4 must preserve.
// ═══════════════════════════════════════════════════════════════════════

test("runDagNode outcome: execute mutation outside retry.fixScope triggers SCOPE_VIOLATION terminal", async () => {
  // Real git repo so the execute adapter's `git diff HEAD` detects the
  // out-of-scope mutation. This is the same pattern used by the existing
  // verification-infra test in engine-run-job.test.ts.
  const sourcePath = await makeSourceRoot("cpb-rdn-scope-source");
  await execFile("git", ["init", "-q"], { cwd: sourcePath });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: sourcePath });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: sourcePath });
  await execFile("git", ["add", "-A"], { cwd: sourcePath });
  await execFile("git", ["commit", "-q", "-m", "initial fixture"], { cwd: sourcePath });

  const events: LooseRecord[] = [];
  const failed: LooseRecord[] = [];
  const services = makeServices({ events, failed });

  const { result } = await runEngine({
    services,
    sourcePath,
    // retry.fixScope flows through prepare (phaseSourceContext = { ...sourceContext, ... })
    // directly into the scope-guard's retryFixScope() resolver.
    sourceContext: { retry: { fixScope: ["README.md"] } },
    poolOpts: {
      customResult: async ({ call }: { call: LooseRecord }) => {
        // Executor returns valid output (so the phase passes and the
        // scope-guard gets a chance to run) but mutates a file OUTSIDE the
        // frozen fix scope as a side effect.
        if (recordValue(call.meta).role === "executor") {
          await writeFile(path.join(sourcePath, "outside-scope.js"), "// injected\n", "utf8");
        }
        return undefined;
      },
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.kind, FailureKind.SCOPE_VIOLATION);
  assert.equal(result.failure.phase, "execute");
  assert.equal(result.failure.retryable, false);

  // The scope-guard emits its evaluated event with withinScope=false and the
  // specific violating path before converting to a terminal failure.
  const evaluated = events.find((e) => e.type === "scope_guard_evaluated");
  assert.ok(evaluated, "scope_guard_evaluated must be emitted for a passing execute node");
  assert.equal(evaluated.phase, "execute");
  assert.equal(evaluated.withinScope, false);
  assert.deepEqual(evaluated.violations, ["outside-scope.js"]);
  assert.deepEqual(evaluated.fixScope, ["README.md"]);

  // The terminal failure is recorded as a dag_node_failed with the
  // scope-guard code and failJob receives the same code.
  const nodeFailed = events.find(
    (e) => e.type === "dag_node_failed" && e.code === "scope_guard_violation",
  );
  assert.ok(nodeFailed, "scope-guard violation must land as dag_node_failed");
  assert.equal(nodeFailed.nodeId, "execute");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].code, "scope_guard_violation");
});

// ═══════════════════════════════════════════════════════════════════════
// OUTCOME-FINALIZER: deferred verification failure -> solver repair
//
// For a verify/adversarial_verify node, runDagNode does NOT immediately
// terminalize a repairable verification failure; it returns
// deferredVerificationFailure=true and executeWorkflowDag's repair loop
// re-runs the execute node (same conversation) and re-verifies. This defer
// vs. terminalize branch is core outcome-finalizer behavior.
// ═══════════════════════════════════════════════════════════════════════

test("runDagNode outcome: repairable verify failure defers (no terminal) and triggers solver repair re-execute", async () => {
  const { result, calls, events } = await runEngine({
    prepareTask: async () => ({
      riskMap: mediumRiskMap(),
      acceptanceChecklist: {
        schemaVersion: 1,
        jobId: "job-runjob-test",
        project: "flow",
        status: "frozen",
        source: { task: "runDagNode characterization fixture", issue: null, documents: [] },
        items: [{
          id: "AC-001",
          requirement: "README is updated by the runDagNode fixture.",
          source: "user_task",
          sourceRefs: [{ kind: "task_text", locator: "task:0" }],
          predicateId: "runjob-readme-update",
          required: true,
          area: "test_fixture",
          risk: "medium",
          verificationMethod: "static",
          expectedEvidence: "README.md is changed by the fixture execution",
          dependsOn: [],
          allowedFiles: ["README.md"],
        }],
        assumptions: [],
      },
    }),
    poolOpts: {
      customOutput: ({ call, calls: allCalls }: { call: LooseRecord; calls: LooseRecord[] }) => {
        const role = recordValue(call.meta).role;
        if (role !== "verifier") return undefined;
        // First verify attempt fails repairably; second passes. The first
        // failure must defer (not terminalize) so the repair loop can run.
        const attempt = allCalls.filter((entry) => recordValue(entry.meta).role === "verifier").length;
        return phaseOutput("verifier", attempt === 1 ? { verdict: "fail" } : { verdict: "pass" });
      },
    },
  });

  assert.equal(result.status, "completed", JSON.stringify(result.failure));

  // Deferred failure did NOT terminalize: the executor was re-entered once
  // for the repair turn and the verifier re-ran on the repaired candidate.
  const executors = calls.filter((c) => recordValue(c.meta).role === "executor");
  const verifiers = calls.filter((c) => recordValue(c.meta).role === "verifier");
  assert.equal(executors.length, 2, "repairable verify failure must re-enter execute once");
  assert.equal(verifiers.length, 2, "repaired candidate must be re-verified");

  // Solver repair is trace-visible — proving the deferred branch was taken
  // rather than the terminalize-on-failure branch.
  assert.ok(events.some((e) => e.type === "solver_repair_started" && e.iteration === 1));
  assert.ok(events.some((e) => e.type === "solver_repair_completed" && e.iteration === 1));
  assert.equal(events.some((e) => e.type === "job_failed"), false);
});

// NOTE on abort handling: runDagNode has a defensive `ctx.signal?.aborted`
// check at the top of its body (line ~469), but in a sequential DAG the
// executeWorkflowDag loop checks the same signal BEFORE each runDagNode
// invocation, so an already-aborted signal short-circuits at the loop level
// and runDagNode's own check is only reachable in the narrow race between the
// loop check and runDagNode entry (e.g. a parallel wave). The mid-phase abort
// path (signal aborts during a pool call) is already pinned by
// engine-run-job.test.ts ("runJob classifies post-agent AbortError as runtime
// interruption"). Driving runDagNode's own defensive check in isolation would
// require a contrived parallel-wave race and is intentionally not covered here.
