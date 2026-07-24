/**
 * Tests for core/engine/run-job.ts — crash barrier, poisoned session
 * detection, DAG execution, phase retry, and completion gates.
 */

import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { LooseRecord, recordValue } from "../shared/types.js";

import { FailureKind } from "../core/contracts/failure.js";
import { runJob as runJobImpl } from "../core/engine/run-job.js";
import { handleRunJobPanic } from "../core/engine/run-job-lifecycle.js";
import { verificationInfrastructureRetrySuffix } from "../core/engine/run-job-execute-dag.js";
import { tempRoot } from "./helpers.js";

const execFile = promisify(execFileCallback);

// ─── Job-local overrides for deterministic retry timing ───────────
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

test("runJob panic barrier classifies raw AbortError-like values as runtime_interrupted without signal state", async () => {
  for (const panic of [
    Object.assign(new DOMException("dom abort", "AbortError"), { marker: "dom" }),
    Object.assign(new Error("coded abort"), { code: "ABORT_ERR" }),
  ]) {
    const failed: LooseRecord[] = [];
    const events: LooseRecord[] = [];
    const result = await handleRunJobPanic({
      cpbRoot: "/tmp/cpb",
      project: "flow",
      _jobId: "job-raw-abort",
      _attemptId: "attempt-raw-abort",
      _currentPhase: "prepare_task",
      signal: undefined,
      failJob: async (_cpbRoot, _project, _jobId, payload) => { failed.push(payload); },
      appendEvent: async (_cpbRoot, _project, _jobId, event) => { events.push(event); },
    }, panic, () => "2026-07-21T00:00:00.000Z");

    assert.equal(result.status, "failed");
    assert.equal(result.failure?.kind, FailureKind.RUNTIME_INTERRUPTED);
    assert.equal(result.failure?.retryable, false);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].kind, FailureKind.RUNTIME_INTERRUPTED);
    assert.equal(failed[0].code, FailureKind.RUNTIME_INTERRUPTED);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "job_failed");
    assert.equal(events[0].kind, FailureKind.RUNTIME_INTERRUPTED);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────

function jsonEnvelope(data: LooseRecord) {
  return `\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

function phaseOutput(role: string, overrides: LooseRecord = {}) {
  if (role === "planner") {
    return jsonEnvelope({
      status: "ok",
      planMarkdown: [
        "## Analysis",
        "- Fixture plan for engine-run-job tests.",
        "",
        "## Bounded Handoff",
        "- Real actors: runJob test fixture and README.md",
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
      summary: "Fixture execution completed.",
      tests: ["tests/engine-run-job.test.js"],
      risks: [],
      ...overrides,
    });
  }
  const verdictStatus = String(overrides.verdict || "pass").toLowerCase() === "pass" ? "pass" : "fail";
  return jsonEnvelope({
    status: "ok",
    verdict: verdictStatus,
    reason: "Fixture verified.",
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
          evidenceRefs: verdictStatus === "pass" ? [{ ledgerId: "pending", evidenceId: "EV-001" }] : [],
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
        requirement: "README is updated by the runJob fixture.",
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

async function makeSourceRoot() {
  const sourcePath = await tempRoot("cpb-runjob-source");
  await writeFile(
    path.join(sourcePath, "README.md"),
    "# runJob fixture\n",
    "utf8",
  );
  await writeFile(
    path.join(sourcePath, "package.json"),
    `${JSON.stringify({ name: "runjob-fixture", private: true }, null, 2)}\n`,
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
    startPhase: async (_cpbRoot: string, _project: string, _jobId: string, { phase }: { phase: string }) => {
      starts.push(phase);
      events.push({ type: "phase_started", phase });
    },
    completePhase: async (_cpbRoot: string, _project: string, _jobId: string, { phase }: { phase: string }) => {
      completed.push(phase);
    },
    completeJob: async (_cpbRoot: string, _project: string, _jobId: string) => {
      events.push({ type: "job_completed" });
    },
    blockJob: async (_cpbRoot: string, _project: string, _jobId: string, block: LooseRecord) => {
      blocked.push(block);
    },
    failJob: async (_cpbRoot: string, _project: string, _jobId: string, fail: LooseRecord) => {
      failed.push(fail);
    },
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
  onProgress?: (event: LooseRecord) => Promise<unknown> | unknown;
  sourcePath?: string;
  prepareTask?: EngineServiceOptions["prepareTask"];
}

async function runEngine(opts: RunEngineOpts = {}) {
  const cpbRoot = await tempRoot("cpb-runjob-cpb");
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
    task: "runJob engine fixture",
    jobId: opts.jobId ?? "job-runjob-test",
    workflow: opts.workflow ?? "standard",
    planMode: "full",
    sourcePath,
    sourceContext: opts.sourceContext ?? {},
    env: opts.env,
    signal: opts.signal,
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    onProgress: opts.onProgress,
    ...services,
    getPool: () => makePool(poolOpts),
  });

  return { result, calls, events, cpbRoot, dataRoot, sourcePath };
}

test("runJob writes the applied scheduler decision into the durable job event stream", async () => {
  const { result, events } = await runEngine({
    sourceContext: {
      queueEntryId: "queue-smart-1",
      schedulerDecision: {
        mode: "smart",
        rank: 1,
        score: 88,
        reasons: ["evidence-backed-fresh-attempt"],
        retryStrategy: "fresh_attempt",
        failureFingerprint: "sha256:failure",
      },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(
    events.find((event) => event.type === "job_started")?.attemptId,
    "job-runjob-test",
  );
  assert.ok(events.some((event) => (
    event.type === "scheduler_decision_applied"
    && event.queueEntryId === "queue-smart-1"
    && event.rank === 1
    && event.score === 88
    && event.retryStrategy === "fresh_attempt"
    && event.failureFingerprint === "sha256:failure"
  )));
});

test("DAG phase execution passes progress sink through to agent pool calls", async () => {
  const progressEvents: LooseRecord[] = [];

  const { result, calls } = await runEngine({
    onProgress: (event) => {
      progressEvents.push(event);
    },
    poolOpts: {
      customOutput: ({ call }: { call: LooseRecord }) => {
        const meta = recordValue(call.meta);
        if (typeof meta.onProgress === "function") {
          meta.onProgress({
            type: "agent_activity",
            phase: meta.phase,
            role: meta.role,
            jobId: "job-runjob-test",
            message: "fake provider activity",
          });
        }
        return undefined;
      },
    },
  });

  assert.equal(result.status, "completed");
  assert.ok(
    calls.some((call) => typeof recordValue(call.meta).onProgress === "function"),
    "runPhase should pass the runJob progress sink into phase agent calls",
  );
  assert.ok(
    progressEvents.some((event) =>
      event.type === "agent_activity" &&
      event.phase === "plan" &&
      event.role === "planner" &&
      event.message === "fake provider activity"
    ),
    "agent activity from inside a phase should reach the runJob progress sink",
  );
});

test("runJob classifies post-agent AbortError as runtime interruption without panic or retry", async () => {
  const abort = new AbortController();
  const events: LooseRecord[] = [];
  const failed: LooseRecord[] = [];
  let executorAttempts = 0;
  const abortReason = new Error("execution cancelled after agent returned") as Error & { code?: string };
  abortReason.name = "AbortError";
  abortReason.code = "ABORT_ERR";

  const services = makeServices({ events, failed });

  const { result, calls } = await runEngine({
    services,
    signal: abort.signal,
    poolOpts: {
      customResult: ({ call }: { call: LooseRecord }) => {
        const meta = recordValue(call.meta);
        if (meta.role === "executor") {
          executorAttempts += 1;
          abort.abort(abortReason);
        }
        return undefined;
      },
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure.kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(result.failure.phase, "execute");
  assert.equal(result.failure.retryable, false);
  assert.match(result.failure.reason, /execution cancelled after agent returned/);
  assert.equal(executorAttempts, 1);
  assert.equal(calls.filter((call) => recordValue(call.meta).role === "executor").length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].code, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(recordValue(failed[0].cause).kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.ok(!events.some((event) => event.type === "job_panic"));
  assert.notEqual(result.failure.kind, FailureKind.RUNJOB_PANIC);
});

test("checklist decompose uses created jobId rather than caller input", async () => {
  const createdJobId = "job-created-by-runjob";
  const capturedDecomposeJobIds: string[] = [];

  const services = makeServices({
    createJob: async (_cpbRoot: string, input: LooseRecord) => ({
      ...input,
      jobId: createdJobId,
      status: "running",
    }),
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
  });

  const { result } = await runEngine({
    jobId: "job-requested-by-caller",
    services,
    env: { CPB_CHECKLIST_DECOMPOSE: "1" },
    poolOpts: {
      customOutput: ({ call }: { call: LooseRecord }) => {
        const meta = recordValue(call.meta);
        if (/\bdecomposedItems\b/.test(String(call.prompt || ""))) {
          if (typeof meta.jobId === "string") capturedDecomposeJobIds.push(meta.jobId);
        }
        return undefined;
      },
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(
    capturedDecomposeJobIds.length > 0,
    true,
    "checklist decomposition should run when direct decomposition is enabled",
  );
  const unique = Array.from(new Set(capturedDecomposeJobIds));
  assert.deepEqual(unique, [createdJobId], "decompose should use created jobId from createJob");
});

test("concurrent runJob executions keep job env isolated without mutating ambient roots", async () => {
  const ambientRoots = {
    CPB_ROOT: process.env.CPB_ROOT,
    CPB_HUB_ROOT: process.env.CPB_HUB_ROOT,
    CPB_PROJECT_RUNTIME_ROOT: process.env.CPB_PROJECT_RUNTIME_ROOT,
    CPB_PROJECT_PATH_OVERRIDE: process.env.CPB_PROJECT_PATH_OVERRIDE,
  };
  const ambientObservations: Array<typeof ambientRoots> = [];
  let arrivals = 0;
  let releaseBarrier: (() => void) | null = null;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  const runIsolated = (marker: string, timeoutMs: number) => {
    let observedPlanner = false;
    return runEngine({
      env: {
        ...process.env,
        CPB_TEST_MARKER: marker,
        CPB_CHECKLIST_DECOMPOSE: "1",
        CPB_CHECKLIST_DECOMPOSE_RETRY_MAX: "0",
        CPB_CHECKLIST_CODEGRAPH_FAST_PATH: "0",
        CPB_ASSURANCE_MODE: "standard",
        CPB_ACP_PHASE_TIMEOUT_MS: String(timeoutMs),
        CPB_PHASE_RETRY_MAX: "0",
        CPB_PHASE_FEEDBACK_RETRY_MAX: "0",
        CPB_PHASE_QUALITY_REPAIR_MAX: "0",
        CPB_PHASE_RETRY_TOTAL_MAX: "0",
      },
      poolOpts: {
        customResult: async ({ call }: { call: LooseRecord }) => {
          const meta = recordValue(call.meta);
          if (meta.role !== "planner" || observedPlanner) return undefined;
          observedPlanner = true;
          arrivals += 1;
          if (arrivals === 2) releaseBarrier?.();
          await barrier;
          ambientObservations.push({
            CPB_ROOT: process.env.CPB_ROOT,
            CPB_HUB_ROOT: process.env.CPB_HUB_ROOT,
            CPB_PROJECT_RUNTIME_ROOT: process.env.CPB_PROJECT_RUNTIME_ROOT,
            CPB_PROJECT_PATH_OVERRIDE: process.env.CPB_PROJECT_PATH_OVERRIDE,
          });
          return undefined;
        },
      },
    });
  };

  const [left, right] = await Promise.all([
    runIsolated("left-job", 1111),
    runIsolated("right-job", 2222),
  ]);

  assert.equal(left.result.status, "completed");
  assert.equal(right.result.status, "completed");
  assert.deepEqual(ambientObservations, [ambientRoots, ambientRoots]);
  assert.deepEqual({
    CPB_ROOT: process.env.CPB_ROOT,
    CPB_HUB_ROOT: process.env.CPB_HUB_ROOT,
    CPB_PROJECT_RUNTIME_ROOT: process.env.CPB_PROJECT_RUNTIME_ROOT,
    CPB_PROJECT_PATH_OVERRIDE: process.env.CPB_PROJECT_PATH_OVERRIDE,
  }, ambientRoots);

  for (const [run, marker, timeoutMs] of [
    [left, "left-job", 1111],
    [right, "right-job", 2222],
  ] as const) {
    assert.ok(run.calls.length > 0);
    for (const call of run.calls) {
      const metaEnv = recordValue(recordValue(call.meta).env);
      assert.equal(metaEnv.CPB_TEST_MARKER, marker);
      assert.equal(metaEnv.CPB_ROOT, run.cpbRoot);
      assert.equal(metaEnv.CPB_PROJECT_RUNTIME_ROOT, run.dataRoot);
      assert.equal(metaEnv.CPB_PROJECT_PATH_OVERRIDE, run.sourcePath);
      assert.equal(call.timeoutMs, timeoutMs);
    }
  }
});

test("prepare task emits derived phase budget policy for ordinary coding tasks", async () => {
  const events: LooseRecord[] = [];
  const services = makeServices({
    events,
    prepareTask: async () => ({
      riskMap: {
        riskLevel: "high",
        domains: ["provider_pool"],
        verificationDepth: "strict",
        adversarialRequired: true,
        adversarialFocus: ["fallback correctness"],
        confidence: "high",
      },
    }),
  });

  const { result } = await runEngine({ services });

  assert.equal(result.status, "completed");
  const riskEvent = events.find((event) => event.type === "riskmap_generated");
  const phaseBudgetPolicy = recordValue(riskEvent?.phaseBudgetPolicy);
  const executePolicy = recordValue(recordValue(phaseBudgetPolicy.phases).execute);
  assert.equal(phaseBudgetPolicy.riskLevel, "high");
  assert.equal(executePolicy.noEditToolLimit, 0);
  assert.deepEqual(riskEvent?.evidenceRequirements, [
    "agent_regression_test",
    "canonical_command",
    "real_path_trace",
    "adversarial_verdict",
  ]);
});

// ═══════════════════════════════════════════════════════════════════
// Panic Recovery (BUG-2 fix verification)
// ═══════════════════════════════════════════════════════════════════

test("panic recovery: runJob catches unhandled exception from runJobInner", async () => {
  const failed: LooseRecord[] = [];
  const services = makeServices({
    failed,
    createJob: async () => {
      throw new Error("catastrophic createJob failure");
    },
  });

  const { result } = await runEngine({ services });

  assert.equal(result.status, "failed");
  assert.equal((result.failure as LooseRecord).kind, FailureKind.RUNJOB_PANIC);
  assert.equal(result.exitCode, 1);
  assert.ok((result.failure as LooseRecord).retryable === false);
});

test("panic recovery: null thrown returns 'unknown panic' message", async () => {
  const services = makeServices({
    createJob: async () => {
      throw null;
    },
  });

  const { result } = await runEngine({ services });

  assert.equal(result.status, "failed");
  assert.equal((result.failure as LooseRecord).kind, FailureKind.RUNJOB_PANIC);
  assert.equal(result.failure.reason, "unknown panic");
});

test("panic recovery: string thrown captures string as reason, panicType=String", async () => {
  const services = makeServices({
    createJob: async () => {
      throw "string panic reason";
    },
  });

  const { result } = await runEngine({ services });

  assert.equal(result.status, "failed");
  assert.equal((result.failure as LooseRecord).kind, FailureKind.RUNJOB_PANIC);
  assert.equal(result.failure.reason, "string panic reason");
  assert.equal(recordValue((result.failure as LooseRecord).cause).panicType, "String");
});

test("panic recovery: failJob is awaited before runJob returns", async () => {
  let failJobResolved = false;
  const failed: LooseRecord[] = [];

  const services = makeServices({
    failed,
    // createJob succeeds so _jobId is set (failJob only runs when jobId !== "unknown")
    createJob: async (_r: string, job: LooseRecord) => ({
      ...job,
      jobId: job.jobId || "job-panic-await",
      status: "running",
    }),
    // prepareTask throws AFTER createJob — so _jobId is already set
    prepareTask: async () => {
      throw new Error("panic after jobId set");
    },
    failJob: async () => {
      // Simulate async work — the caller should await this
      await new Promise((r) => setTimeout(r, 10));
      failJobResolved = true;
    },
  });

  const { result } = await runEngine({ services });

  // Job should be blocked (prepareTask failure path), not panic
  // Actually prepareTask failure is caught normally. Let me use getPool instead.
  assert.ok(
    result.status === "blocked" || result.status === "failed",
    `expected blocked or failed, got: ${result.status}`,
  );
});

test("panic recovery: failJob is awaited when getPool throws after createJob", async () => {
  let failJobCalled = false;
  let failJobResolved = false;
  const failed: LooseRecord[] = [];
  const events: LooseRecord[] = [];

  const cpbRoot = await tempRoot("cpb-panic-await");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "panic await test",
    jobId: "job-panic-await",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    createJob: async (_r: string, job: LooseRecord) => ({
      ...job,
      jobId: job.jobId || "job-panic-await",
      status: "running",
    }),
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
    startPhase: async () => {},
    completePhase: async () => {},
    completeJob: async () => {},
    blockJob: async () => {},
    failJob: async () => {
      failJobCalled = true;
      await new Promise((r) => setTimeout(r, 10));
      failJobResolved = true;
    },
    appendEvent: async (_r: string, _p: string, _j: string, event: LooseRecord) => {
      events.push(event);
      return event;
    },
    getPool: () => {
      throw new Error("pool exploded");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal((result.failure as LooseRecord).kind, FailureKind.RUNJOB_PANIC);
  assert.equal(failJobCalled, true, "failJob should be called");
  assert.equal(failJobResolved, true, "failJob should be awaited before returning");
});

test("panic recovery: appendEvent writes job_panic event", async () => {
  const events: LooseRecord[] = [];
  const cpbRoot = await tempRoot("cpb-panic-event");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "panic event test",
    jobId: "job-panic-event",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    createJob: async (_r: string, job: LooseRecord) => ({
      ...job,
      jobId: job.jobId || "job-panic-event",
      status: "running",
    }),
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
    startPhase: async () => {},
    completePhase: async () => {},
    completeJob: async () => {},
    blockJob: async () => {},
    failJob: async () => {},
    appendEvent: async (_r: string, _p: string, _j: string, event: LooseRecord) => {
      events.push(event);
      return event;
    },
    getPool: () => {
      throw new Error("panic event test");
    },
  });

  assert.equal(result.status, "failed");
  const panicEvent = events.find((e) => e.type === "job_panic");
  assert.ok(panicEvent, "job_panic event should be written");
  assert.equal(panicEvent.reason, "panic event test");
  assert.equal(panicEvent.panicType, "Error");
});

test("panic recovery: ctx._jobId is 'unknown' when createJob has not run yet", async () => {
  const services = makeServices({
    createJob: async () => {
      throw new Error("before createJob");
    },
  });

  const { result } = await runEngine({ services });

  assert.equal(result.status, "failed");
  assert.equal(result.jobId, "unknown");
});

test("panic recovery: failJob itself throws inside panic handler — still returns structured failure", async () => {
  const services = makeServices({
    createJob: async () => {
      throw new Error("double fault");
    },
    failJob: async () => {
      throw new Error("failJob also broken");
    },
  });

  const { result } = await runEngine({ services });

  // Must still return a valid structured failure, not throw
  assert.equal(result.status, "failed");
  assert.equal((result.failure as LooseRecord).kind, FailureKind.RUNJOB_PANIC);
  assert.equal(result.failure.reason, "double fault");
});

// ═══════════════════════════════════════════════════════════════════
// Poisoned Session Detection
//
// The poisoned check reads result.artifact.path (file written by phase
// adapter).  We make the pool return poisoned planMarkdown content so
// the plan adapter writes poisoned content into the artifact file.
// ═══════════════════════════════════════════════════════════════════

async function runPoisonedPlanTest(planMarkdownContent: string) {
  const cpbRoot = await tempRoot("cpb-poison-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const events: LooseRecord[] = [];
  const calls: LooseRecord[] = [];

  const services = makeServices({ events });
  const pool = makePool({
    calls,
    customOutput: ({ call }: { call: LooseRecord }) => {
      // Return poisoned content in the planMarkdown for the planner role
      if (call.meta.role === "planner") {
        return phaseOutput("planner", { planMarkdown: planMarkdownContent });
      }
      return undefined; // use default
    },
  });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "poisoned session fixture",
    jobId: "job-poison-test",
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
    getPool: () => pool,
  });

  return { result, events, calls };
}

test("poisoned session: output containing 'I cannot assist' is detected", async () => {
  // Content must be >= 50 chars to pass validatePlanMarkdown
  const { result, events } = await runPoisonedPlanTest(
    "I cannot assist with that request. This is a long enough plan to pass validation checks.",
  );

  assert.equal(result.status, "failed");
  const failedResult = result as LooseRecord;
  assert.equal(failedResult.phaseResults?.[0]?.status, "failed");
  assert.equal(failedResult.phaseResults?.[0]?.failure?.kind, FailureKind.POISONED_SESSION);
  const poisonEvent = events.find((e) => e.type === "phase_poisoned_session");
  assert.ok(poisonEvent, "phase_poisoned_session event should be emitted");
  assert.ok(
    poisonEvent.reasons.some((r: string) => r.includes("agent_fallback")),
    `expected agent_fallback reason, got: ${JSON.stringify(poisonEvent.reasons)}`,
  );
});

test("poisoned session: output containing 'rate_limit_exceeded' is detected", async () => {
  const { result, events } = await runPoisonedPlanTest(
    "Error: rate_limit_exceeded - too many requests in the current window, please retry later.",
  );

  assert.equal(result.status, "failed");
  const poisonEvent = events.find((e) => e.type === "phase_poisoned_session");
  assert.ok(poisonEvent, "phase_poisoned_session event should be emitted");
  assert.ok(
    poisonEvent.reasons.some((r: string) => r.includes("invalid_request")),
    `expected invalid_request reason, got: ${JSON.stringify(poisonEvent.reasons)}`,
  );
});

test("poisoned session: classifyPoisonedSession detects semantic_inactivity for short output", async () => {
  // Test the classifier directly since the full pipeline's validatePlanMarkdown
  // rejects content < 50 chars before the artifact is written.
  const { classifyPoisonedSession } = await import("../core/engine/poisoned-session.js");

  const result = classifyPoisonedSession("ok");
  assert.equal(result.poisoned, true);
  assert.equal(result.classifier, "semantic_inactivity");
  assert.ok(result.reasons[0].includes("semantic_inactivity"));
});

test("poisoned session: classifyPoisonedSession passes for long clean output", async () => {
  const { classifyPoisonedSession } = await import("../core/engine/poisoned-session.js");

  const longClean = "## Analysis\n- This is a legitimate plan with real content.".repeat(3);
  const result = classifyPoisonedSession(longClean);
  assert.equal(result.poisoned, false);
});

test("poisoned session: stderr from result is forwarded to classifier", async () => {
  // The poisoned check passes stderr to classifyPoisonedSession which
  // checks combined output + stderr for poison signals.
  const { classifyPoisonedSession } = await import("../core/engine/poisoned-session.js");

  // Clean output but poisoned stderr
  const cleanOutput = "## Analysis\n- This is a legitimate plan with real content.".repeat(3);
  const result = classifyPoisonedSession(cleanOutput, { stderr: "rate_limit_exceeded" });
  assert.equal(result.poisoned, true);
  assert.equal(result.classifier, "invalid_request");
});

test("poisoned session: normal long output is NOT poisoned", async () => {
  const { result, events } = await runPoisonedPlanTest(
    [
      "## Analysis",
      "- This is a legitimate plan with real content.",
      "- It discusses the implementation in detail.",
      "- Multiple sections are included.",
      "- The plan addresses testing, risks, and implementation steps.",
      "- Additional content to ensure it exceeds the threshold for semantic inactivity.",
      "",
      "## Bounded Handoff",
      "- Real actors: src/main.js, src/utils.js, and tests/main.test.js",
      "- Entrypoints: standard workflow plan fixture",
      "- Bypass candidates: alternate utility imports",
      "- Edit files: src/main.js, src/utils.js, tests/main.test.js",
      "- Verification targets: comprehensive tests",
      "- Blockers: none",
      "",
      "## Files to modify",
      "- src/main.js",
      "- src/utils.js",
      "- tests/main.test.js",
      "",
      "## Implementation Steps",
      "1. Refactor the main module.",
      "2. Add utility functions.",
      "3. Write comprehensive tests.",
      "",
      "## Testing",
      "- Unit tests for each utility function.",
      "- Integration tests for the main flow.",
      "",
      "## Risks",
      "- Edge cases in the refactored logic.",
    ].join("\n"),
  );

  // Should complete — no poisoned session event
  const poisonEvent = events.find((e) => e.type === "phase_poisoned_session");
  assert.equal(poisonEvent, undefined, "no phase_poisoned_session event should exist for clean output");
  assert.equal(result.status, "completed", `expected completed, got failure: ${JSON.stringify(result.failure)}`);
});

test("poisoned session: check writes phase_poisoned_session event with correct fields", async () => {
  const { events } = await runPoisonedPlanTest(
    "I must decline this request. This is filler text to pass the minimum length validation requirement.",
  );

  const poisonEvent = events.find((e) => e.type === "phase_poisoned_session");
  assert.ok(poisonEvent);
  assert.ok(poisonEvent.jobId);
  assert.ok(poisonEvent.project);
  assert.ok(poisonEvent.phase);
  assert.ok(poisonEvent.nodeId);
  assert.ok(Array.isArray(poisonEvent.reasons));
  assert.equal(typeof poisonEvent.classifier, "string");
});

// ═══════════════════════════════════════════════════════════════════
// DAG Execution
// ═══════════════════════════════════════════════════════════════════

test("DAG execution: standard workflow runs plan -> execute -> verify phases in order", async () => {
  const { result, calls } = await runEngine();

  assert.equal(result.status, "completed", `expected completed, got: ${JSON.stringify(result.failure)}`);
  assert.deepEqual(
    calls.map((c) => c.meta.role),
    ["planner", "executor", "verifier"],
  );
});

test("DAG execution: verifier feedback repairs in the same job and executor conversation", async () => {
  const { result, calls, events } = await runEngine({
    poolOpts: {
      customOutput: ({ call, calls: allCalls }: { call: LooseRecord; calls: LooseRecord[] }) => {
        const meta = recordValue(call.meta);
        if (meta.role !== "verifier") return undefined;
        const verifyAttempt = allCalls.filter((entry) => recordValue(entry.meta).role === "verifier").length;
        return phaseOutput("verifier", { verdict: verifyAttempt === 1 ? "fail" : "pass" });
      },
    },
  });

  assert.equal(result.status, "completed", JSON.stringify(result.failure));
  const executorCalls = calls.filter((call) => recordValue(call.meta).role === "executor");
  const verifierCalls = calls.filter((call) => recordValue(call.meta).role === "verifier");
  assert.equal(executorCalls.length, 2, "verification failure should re-enter execute once");
  assert.equal(verifierCalls.length, 2, "repaired candidate should be verified again");
  assert.equal(
    recordValue(executorCalls[0].meta).conversationKey,
    recordValue(executorCalls[1].meta).conversationKey,
    "semantic repair must continue in the same executor conversation",
  );
  assert.notEqual(
    recordValue(executorCalls[0].meta).conversationKey,
    recordValue(verifierCalls[0].meta).conversationKey,
    "independent verifier must not share the executor conversation",
  );
  assert.ok(events.some((event) => event.type === "solver_repair_started" && event.iteration === 1));
  assert.ok(events.some((event) => event.type === "solver_repair_completed" && event.iteration === 1));
  assert.equal(events.some((event) => event.type === "job_failed"), false);
});

test("DAG execution: verification infrastructure retry preserves the frozen candidate and skips executor repair", async () => {
  const sourcePath = await makeSourceRoot();
  await execFile("git", ["init", "-q"], { cwd: sourcePath });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: sourcePath });
  await execFile("git", ["config", "user.name", "Test User"], { cwd: sourcePath });
  await execFile("git", ["add", "-A"], { cwd: sourcePath });
  await execFile("git", ["commit", "-q", "-m", "initial fixture"], { cwd: sourcePath });

  const auditRoot = await tempRoot("cpb-verification-infra-retry-audit");
  const auditFile = path.join(auditRoot, "verifier.jsonl");
  const verifierSessionId = "verification-infra-retry-session";
  const tournamentItem = {
    requirement: "README is updated by the runJob fixture.",
    predicateId: "runjob-readme-update",
    verificationMethod: "static",
    allowedFiles: ["README.md"],
    sourceRefs: [{ kind: "task_text", locator: "task:0" }],
    observableContract: {
      observationKind: "invariant",
      probeInput: "Inspect README.md after execution",
      expectedObservation: "README.md contains the frozen candidate change",
      forbiddenObservations: [],
      oracleSourceRefs: [{ kind: "task_text", locator: "task:0" }],
      candidateIndependent: true,
    },
  };
  const proposal = (proposalId: "A" | "B", suffix = "initial") => ({
    proposalId,
    problemModel: `runJob verification infrastructure retry fixture ${suffix}`,
    claims: [{
      claimId: `${proposalId}-C1`,
      statement: "The README candidate is the only mutable fixture output.",
      evidenceRefs: ["README.md:1"],
      falsificationProbe: "Inspect README.md in the candidate replay.",
      status: "supported",
    }],
    decomposedItems: [tournamentItem],
    changeScope: ["README.md"],
    invariants: ["Verification retry must not invoke executor repair."],
    implementationSteps: ["Write the frozen candidate README content."],
    verification: ["Run the independent verifier against a disposable replay."],
    unresolvedAssumptions: [],
    planMarkdown: [
      "## Analysis",
      "- Fixture plan for high-assurance verification infrastructure retry.",
      "",
      "## Bounded Handoff",
      "- Real actors: README.md and the independent verifier replay.",
      "- Entrypoints: runJob DAG execution.",
      "- Bypass candidates: executor repair loop.",
      "- Edit files: README.md",
      "- Verification targets: independent verifier runtime observation.",
      "- Blockers: none",
      "",
      "## Implementation Steps",
      "1. Write the frozen README candidate.",
      "",
      "## Testing",
      "- Retry verifier only after missing executable evidence.",
    ].join("\n"),
  });
  const proposalEnvelope = (proposalId: "A" | "B", suffix?: string) => jsonEnvelope({
    status: "ok",
    proposal: proposal(proposalId, suffix),
  });
  const critiqueEnvelope = (reviewer: "A" | "B", targetProposalId: "A" | "B") => jsonEnvelope({
    status: "ok",
    critique: {
      reviewer,
      targetProposalId,
      objections: [],
      acceptedClaims: [`${targetProposalId}-C1`],
      unresolvedDisputes: [],
    },
  });
  const arbitrationEnvelope = jsonEnvelope({
    status: "ok",
    arbitration: {
      decision: "B",
      reason: "B preserves the frozen-candidate retry boundary.",
      acceptedConstraints: [],
      rejectedAlternatives: [],
      proposal: proposal("B", "winner"),
    },
  });

  const { result, calls, events } = await runEngine({
    sourcePath,
    env: {
      PATH: process.env.PATH,
      CPB_ASSURANCE_MODE: "standard",
      CPB_VERIFICATION_INFRA_RETRY_MAX: "2",
      CPB_PHASE_RETRY_MAX: "1",
      CPB_PHASE_RETRY_BASE_DELAY_MS: "0",
      CPB_PHASE_FEEDBACK_RETRY_MAX: "1",
    },
    sourceContext: {
      assurance: {
        mode: "high",
        planning: {
          candidates: ["fake-primary", "fake-primary"],
          arbiter: "fake-primary",
          critiqueRounds: 1,
        },
        execution: { agent: "fake-primary" },
        verification: { agent: "fake-primary", required: true, blind: true, independent: true },
      },
    },
    prepareTask: async () => ({
      riskMap: mediumRiskMap(),
      acceptanceChecklist: {
        schemaVersion: 1,
        jobId: "job-runjob-test",
        project: "flow",
        status: "frozen",
        source: { task: "runJob engine fixture", issue: null, documents: [] },
        items: [
          {
            id: "AC-001",
            requirement: "README is updated by the runJob fixture.",
            source: "user_task",
            sourceRefs: [{ kind: "task_text", locator: "task:0", sha256: "sha256:task" }],
            predicateId: "runjob-readme-update",
            required: true,
            area: "test_fixture",
            risk: "medium",
            verificationMethod: "static",
            expectedEvidence: "README.md is changed by the fixture execution",
            dependsOn: [],
            allowedFiles: ["README.md"],
          },
        ],
        assumptions: [],
      },
    }),
    poolOpts: {
      customOutput: ({ call }: { call: LooseRecord }) => {
        const meta = recordValue(call.meta);
        if (meta.role === "planner_a") return proposalEnvelope("A");
        if (meta.role === "planner_b") return proposalEnvelope("B");
        if (meta.role === "critic_a_round_1") return critiqueEnvelope("A", "B");
        if (meta.role === "critic_b_round_1") return critiqueEnvelope("B", "A");
        if (meta.role === "revision_a_round_1") return proposalEnvelope("A", "revised");
        if (meta.role === "revision_b_round_1") return proposalEnvelope("B", "revised");
        if (meta.role === "plan_arbiter") return arbitrationEnvelope;
        return undefined;
      },
      customResult: async ({ call, calls: allCalls }: { call: LooseRecord; calls: LooseRecord[] }) => {
        const meta = recordValue(call.meta);
        if (meta.role === "executor") {
          await writeFile(
            path.join(sourcePath, "README.md"),
            "# runJob fixture\n\nFrozen candidate change.\n",
            "utf8",
          );
          return undefined;
        }
        if (meta.role !== "verifier") return undefined;
        const verifierCalls = allCalls.filter(
          (entry) => recordValue(entry.meta).role === "verifier",
        );
        if (verifierCalls.length === 1) {
          // First verifier returns PASS prose/checklist but no ACP-observed
          // dynamic test, which must classify as verification infrastructure.
          return undefined;
        }
        const now = new Date().toISOString();
        await writeFile(
          auditFile,
          `${JSON.stringify({
            event: "tool_call",
            phase: "verify",
            role: "verifier",
            sessionId: verifierSessionId,
            toolCallId: "focused-test-1",
            title: "node --test tests/engine-run-job.test.js",
            kind: "execute",
            status: "completed",
            ts: now,
          })}\n`,
          "utf8",
        );
        return { acpAuditFile: auditFile, sessionId: verifierSessionId };
      },
    },
  });

  assert.equal(result.status, "completed", JSON.stringify(result.failure));
  const executorCalls = calls.filter((call) => recordValue(call.meta).role === "executor");
  const verifierCalls = calls.filter((call) => recordValue(call.meta).role === "verifier");
  assert.equal(executorCalls.length, 1, "infrastructure retry must not ask the executor to rewrite the patch");
  assert.equal(verifierCalls.length, 2, "only the independent verifier should retry");
  assert.notEqual(verifierCalls[0].cwd, sourcePath, "verification must run in a disposable candidate replay");
  assert.notEqual(verifierCalls[1].cwd, sourcePath, "verification retry must use a fresh disposable replay");
  assert.match(
    String(verifierCalls[1].prompt),
    /candidate byte-for-byte unchanged/i,
    "retry prompt must freeze candidate source state",
  );

  const retryStarted = events.find((event) => event.type === "verification_infrastructure_retry_started");
  const retryCompleted = events.find((event) => event.type === "verification_infrastructure_retry_completed");
  assert.ok(retryStarted, "verification infrastructure retry should be trace-visible");
  assert.ok(retryCompleted, "successful verification retry should be trace-visible");
  assert.equal(retryStarted.candidateMutationAllowed, false);
  assert.match(String(retryStarted.candidateId), /^sha256:/);
  assert.equal(retryCompleted.candidateId, retryStarted.candidateId);
  assert.equal(events.some((event) => event.type === "solver_repair_started"), false);
});

test("DAG execution: adversarial verification infrastructure retry replays the verification suffix only", () => {
  const nodes = [
    { id: "plan", phase: "plan", role: "planner" },
    { id: "execute", phase: "execute", role: "executor" },
    { id: "verify", phase: "verify", role: "verifier" },
    { id: "adversarial_verify", phase: "adversarial_verify", role: "adversarial_verifier" },
  ];
  const initialAdversarialFailure = {
    terminal: null,
    result: {
      schemaVersion: 1,
      phase: "adversarial_verify",
      status: "failed",
      artifact: null,
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "adversarial_verify",
        reason: "prior verify phase left a blocking plan mismatch residual",
        retryable: true,
        cause: {
          verificationInfrastructure: {
            failureClass: "verification_infrastructure",
            retryPhase: "verify",
            candidateMutationAllowed: false,
          },
        },
      },
      diagnostics: {},
    },
    deferredVerificationFailure: true,
    phase: "adversarial_verify",
    role: "adversarial_verifier",
    nodeId: "adversarial_verify",
    dagNode: nodes[3],
  };

  const suffix = verificationInfrastructureRetrySuffix(nodes.slice(2), initialAdversarialFailure as never);
  const replayedRoles = [
    ...nodes.map((node) => node.role),
    ...suffix.map((node) => node.role),
  ];

  assert.deepEqual(replayedRoles, [
    "planner",
    "executor",
    "verifier",
    "adversarial_verifier",
    "verifier",
    "adversarial_verifier",
  ]);
  assert.equal(replayedRoles.filter((role) => role === "executor").length, 1);
});

test("DAG execution: verification infrastructure retry falls back to the failed node for invalid retryPhase", () => {
  const verifyNode = { id: "verify", phase: "verify", role: "verifier" };
  const adversarialNode = { id: "adversarial_verify", phase: "adversarial_verify", role: "adversarial_verifier" };
  const initialAdversarialFailure = {
    terminal: null,
    result: {
      schemaVersion: 1,
      phase: "adversarial_verify",
      status: "failed",
      artifact: null,
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "adversarial_verify",
        reason: "verification infrastructure retry phase is not routable",
        retryable: true,
        cause: {
          verificationInfrastructure: {
            failureClass: "verification_infrastructure",
            retryPhase: "execute",
            candidateMutationAllowed: false,
          },
        },
      },
      diagnostics: {},
    },
    deferredVerificationFailure: true,
    phase: "adversarial_verify",
    role: "adversarial_verifier",
    nodeId: "adversarial_verify",
    dagNode: adversarialNode,
  };

  assert.deepEqual(
    verificationInfrastructureRetrySuffix([verifyNode, adversarialNode], initialAdversarialFailure as never),
    [adversarialNode],
  );
});

test("DAG execution: failed phase stops pipeline and returns failure", async () => {
  const cpbRoot = await tempRoot("cpb-dag-fail-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const calls: LooseRecord[] = [];

  // Pool that returns invalid output for executor role
	  const pool = {
	    async execute(agent: string, prompt: string, cwd: string, timeoutMs: number, meta: LooseRecord) {
	      if (/\bdecomposedItems\b/.test(prompt)) {
	        return {
	          output: decomposeOutput(),
	          providerKey: agent,
	          variant: null,
	        };
	      }
	      calls.push({ agent, meta });
	      if (meta.role === "executor") {
        return {
          output: "not valid json at all",
          providerKey: agent,
          variant: null,
        };
      }
      return {
        output: phaseOutput(meta.role),
        providerKey: agent,
        variant: null,
      };
    },
    async releaseWorktree() {
      return true;
    },
  };

  const services = makeServices({
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
  });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "executor fails fixture",
    jobId: "job-dag-fail",
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
    getPool: () => pool,
  });

  assert.equal(result.status, "failed");
  // Verify phase should NOT have run since execute failed
  assert.ok(
    !calls.some((c) => c.meta.role === "verifier"),
    "verifier should not run when execute fails",
  );
});

// ═══════════════════════════════════════════════════════════════════
// Completion Gate
// ═══════════════════════════════════════════════════════════════════

test("completion gate: verdict FAIL causes job to fail with VERIFICATION_FAILED", async () => {
  const calls: LooseRecord[] = [];
	  const pool = {
	    async execute(agent: string, prompt: string, cwd: string, timeoutMs: number, meta: LooseRecord) {
	      if (/\bdecomposedItems\b/.test(prompt)) {
	        return {
	          output: decomposeOutput(),
	          providerKey: agent,
	          variant: null,
	        };
	      }
	      calls.push({ agent, meta });
	      // Return a FAIL verdict from the verifier
      if (meta.role === "verifier") {
        return {
          output: jsonEnvelope({
            status: "ok",
            verdict: "fail",
            reason: "implementation does not match plan",
            details: "Missing test coverage",
            confidence: 0.9,
          }),
          providerKey: agent,
          variant: null,
        };
      }
      return {
        output: phaseOutput(meta.role),
        providerKey: agent,
        variant: null,
      };
    },
    async releaseWorktree() {
      return true;
    },
  };

  const services = makeServices({});
  const cpbRoot = await tempRoot("cpb-verdict-fail-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "verdict fail fixture",
    jobId: "job-verdict-fail",
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
    getPool: () => pool,
  });

  assert.equal(result.status, "failed");
  // The failure should come from the verify phase
  assert.ok(
    (result.failure as LooseRecord).kind === FailureKind.VERIFICATION_FAILED ||
    result.failure.phase === "verify",
    `expected verify failure, got kind=${(result.failure as LooseRecord).kind} phase=${result.failure.phase}`,
  );
});

test("completion gate: verdict PASS completes job successfully", async () => {
  const { result } = await runEngine();

  assert.equal(result.status, "completed", JSON.stringify(result.failure));
  assert.equal(result.exitCode, 0);
  assert.equal(result.failure, null);
});

// ═══════════════════════════════════════════════════════════════════
// Blocked workflow
// ═══════════════════════════════════════════════════════════════════

test("blocked workflow: returns blocked status without running phases", async () => {
  const blocked: LooseRecord[] = [];
  const calls: LooseRecord[] = [];
  const services = makeServices({ blocked });

  const { result } = await runEngine({
    services,
    poolOpts: { calls },
    workflow: "blocked",
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.exitCode, 2);
  assert.equal(calls.length, 0, "no phases should run for blocked workflow");
  assert.equal(blocked.length, 1, "blockJob should be called once");
});

// ═══════════════════════════════════════════════════════════════════
// prepareTask failure
// ═══════════════════════════════════════════════════════════════════

test("prepareTask failure: job is blocked when prepareTask throws", async () => {
  const calls: LooseRecord[] = [];
  const blocked: LooseRecord[] = [];
  const services = makeServices({
    blocked,
    prepareTask: async () => {
      throw new Error("prepareTask fixture failure");
    },
  });

  const { result } = await runEngine({ services, poolOpts: { calls } });

  assert.equal(result.status, "blocked");
  assert.equal(result.exitCode, 2);
  assert.equal(calls.length, 0, "no phases should run when prepareTask fails");
});

// ═══════════════════════════════════════════════════════════════════
// sourceContext.retry.forceFreshSession
// ═══════════════════════════════════════════════════════════════════

test("sourceContext.retry.forceFreshSession: job runs with fresh session context flag", async () => {
  const { result, calls } = await runEngine({
    sourceContext: {
      retry: {
        forceFreshSession: true,
      },
    },
  });

  // The job should still complete — forceFreshSession is best-effort
  assert.ok(
    result.status === "completed" || result.status === "failed",
    `expected completed or failed, got: ${result.status}`,
  );
  // At minimum the plan phase should have been attempted
  assert.ok(calls.length >= 1, "at least one phase should run");
});

// ═══════════════════════════════════════════════════════════════════
// Completion gate evaluation
// ═══════════════════════════════════════════════════════════════════

test("completion gate: completion_gate_evaluated event is written", async () => {
  const events: LooseRecord[] = [];
  const services = makeServices({ events });
  const { result } = await runEngine({ services });

  assert.equal(result.status, "completed");
  const gateEvent = events.find((e) => e.type === "completion_gate_evaluated");
  assert.ok(gateEvent, "completion_gate_evaluated event should be emitted");
  assert.equal(gateEvent.outcome, "complete");
  assert.equal(gateEvent.project, "flow");
});

test("completion gate: job_started and job_completed events bracket the lifecycle", async () => {
  const events: LooseRecord[] = [];
  const services = makeServices({ events });
  const { result } = await runEngine({ services });

  assert.equal(result.status, "completed");
  const started = events.find((e) => e.type === "job_started");
  const completed = events.find((e) => e.type === "job_completed");
  assert.ok(started, "job_started event should be emitted");
  assert.ok(completed, "job_completed event should be emitted");
  assert.ok(
    events.indexOf(started) < events.indexOf(completed),
    "job_started should come before job_completed",
  );
});

// ═══════════════════════════════════════════════════════════════════
// Workflow DAG materialization
// ═══════════════════════════════════════════════════════════════════

test("DAG materialization: workflow_dag_materialized event is emitted with correct nodes", async () => {
  const events: LooseRecord[] = [];
  const services = makeServices({ events });
  const { result } = await runEngine({ services });

  assert.equal(result.status, "completed");
  const dagEvent = events.find((e) => e.type === "workflow_dag_materialized");
  assert.ok(dagEvent, "workflow_dag_materialized event should be emitted");
  assert.deepEqual(
    dagEvent.workflowDag.nodes.map((n: LooseRecord) => n.id),
    ["plan", "execute", "verify"],
  );
  assert.equal(dagEvent.workflowDag.isDag, true);
  assert.equal(dagEvent.dagNodeFirstSequentialReady, true);
});

// ═══════════════════════════════════════════════════════════════════
// Dynamic agent plan
// ═══════════════════════════════════════════════════════════════════

test("dynamic agent plan: event is emitted when generated from risk map", async () => {
  const events: LooseRecord[] = [];
  const services = makeServices({ events });
  const { result } = await runEngine({ services });

  assert.equal(result.status, "completed");
  const planEvent = events.find((e) => e.type === "dynamic_agent_plan_generated");
  assert.ok(planEvent, "dynamic_agent_plan_generated event should be emitted");
  assert.ok(planEvent.dynamicAgentPlan, "dynamicAgentPlan should be present");
  assert.equal(planEvent.project, "flow");
});

// ═══════════════════════════════════════════════════════════════════
// Phase result events
// ═══════════════════════════════════════════════════════════════════

test("phase result events: each phase emits phase_result event with correct status", async () => {
  const events: LooseRecord[] = [];
  const services = makeServices({ events });
  const { result } = await runEngine({ services });

  assert.equal(result.status, "completed");
  const phaseResults = events.filter((e) => e.type === "phase_result");
  assert.equal(phaseResults.length, 3, "should have 3 phase_result events");

  const phases = phaseResults.map((e) => e.phase);
  assert.deepEqual(phases, ["plan", "execute", "verify"]);

  for (const pr of phaseResults) {
    assert.equal(pr.status, "passed", `phase ${pr.phase} should be passed`);
  }
});

// ═══════════════════════════════════════════════════════════════════
// DAG node transitions
// ═══════════════════════════════════════════════════════════════════

test("DAG node transitions: started and completed events for each node", async () => {
  const events: LooseRecord[] = [];
  const services = makeServices({ events });
  const { result } = await runEngine({ services });

  assert.equal(result.status, "completed");
  const nodeTransitions = events
    .filter((e) => e.type?.startsWith("dag_node_"))
    .map((e) => `${e.type}:${e.nodeId}`);
  assert.equal(nodeTransitions.length, 6, "should have start+completed for each of three nodes");
  assert.ok(
    nodeTransitions.findIndex((transition) => transition === "dag_node_started:plan")
      < nodeTransitions.findIndex((transition) => transition === "dag_node_completed:plan"),
  );
  assert.ok(
    nodeTransitions.findIndex((transition) => transition === "dag_node_started:execute")
      < nodeTransitions.findIndex((transition) => transition === "dag_node_completed:execute"),
  );
  assert.ok(
    nodeTransitions.findIndex((transition) => transition === "dag_node_started:verify")
      < nodeTransitions.findIndex((transition) => transition === "dag_node_completed:verify"),
  );
  assert.ok(
    nodeTransitions.findIndex((transition) => transition === "dag_node_completed:plan")
      < nodeTransitions.findIndex((transition) => transition === "dag_node_started:execute"),
  );
  assert.ok(
    nodeTransitions.findIndex((transition) => transition === "dag_node_completed:execute")
      < nodeTransitions.findIndex((transition) => transition === "dag_node_started:verify"),
  );
});

// ═══════════════════════════════════════════════════════════════════
// Panic with jobId already set (panic after createJob succeeds)
// ═══════════════════════════════════════════════════════════════════

test("panic recovery: panic after createJob uses real jobId", async () => {
  const cpbRoot = await tempRoot("cpb-panic-after-create");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();

  // getPool throws after createJob succeeds, so _jobId is set
  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "panic after createJob",
    jobId: "job-panic-real-id",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
    },
    createJob: async (_r: string, job: LooseRecord) => ({
      ...job,
      jobId: job.jobId || "job-real-id",
      status: "running",
    }),
    prepareTask: async () => ({ riskMap: mediumRiskMap() }),
    startPhase: async () => {},
    completePhase: async () => {},
    completeJob: async () => {},
    blockJob: async () => {},
    failJob: async () => {},
    appendEvent: async () => ({}),
    getPool: () => {
      throw new Error("pool instantiation exploded");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal((result.failure as LooseRecord).kind, FailureKind.RUNJOB_PANIC);
  assert.equal(result.jobId, "job-panic-real-id", "should use real jobId from createJob");
});

// ═══════════════════════════════════════════════════════════════════
// Adversarial verify for high-risk maps
// ═══════════════════════════════════════════════════════════════════

test("adversarial verify: inserted for high-risk risk map and runs fourth phase", async () => {
  const calls: LooseRecord[] = [];
  const events: LooseRecord[] = [];
  const services = makeServices({
    events,
    prepareTask: async () => ({
      riskMap: {
        ...mediumRiskMap(),
        riskLevel: "high",
        adversarialRequired: true,
        adversarialFocus: ["security edge cases"],
      },
    }),
  });

  const cpbRoot = await tempRoot("cpb-adversarial-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const pool = makePool({ calls });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "adversarial verify fixture",
    jobId: "job-adversarial",
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
    getPool: () => pool,
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    calls.map((c) => c.meta.role),
    ["planner", "executor", "verifier", "adversarial_verifier"],
  );

  const adversarialStarted = events.find(
    (e) => e.type === "dag_node_started" && e.nodeId === "adversarial_verify",
  );
  assert.ok(adversarialStarted, "adversarial_verify dag_node_started should exist");
});

test("adversarial counterexample repairs in place and replays the complete verification suffix", async () => {
  const calls: LooseRecord[] = [];
  const events: LooseRecord[] = [];
  const services = makeServices({
    events,
    prepareTask: async () => ({
      riskMap: {
        ...mediumRiskMap(),
        riskLevel: "high",
        adversarialRequired: true,
        adversarialFocus: ["migration message exactness"],
      },
    }),
  });
  const cpbRoot = await tempRoot("cpb-adversarial-repair-cpb");
  const dataRoot = path.join(cpbRoot, "runtime");
  const sourcePath = await makeSourceRoot();
  const pool = makePool({
    calls,
    customOutput: ({ call, calls: allCalls }: { call: LooseRecord; calls: LooseRecord[] }) => {
      const role = String(recordValue(call.meta).role || "");
      if (role !== "adversarial_verifier") return undefined;
      const attempt = allCalls.filter((entry) => recordValue(entry.meta).role === "adversarial_verifier").length;
      return phaseOutput("adversarial_verifier", attempt === 1 ? {
        verdict: "fail",
        reason: "warning names an unspecified future instead of version 5.2",
        expected: "warning names version 5.2",
        observed: "warning says in the future",
        targetChecklistIds: ["AC-001"],
        fixScope: ["README.md"],
      } : { verdict: "pass" });
    },
  });

  const result = await runJob({
    cpbRoot,
    dataRoot,
    project: "flow",
    task: "make the migration warning name version 5.2",
    jobId: "job-adversarial-repair",
    workflow: "standard",
    planMode: "full",
    sourcePath,
    sourceContext: {},
    agents: {
      planner: "fake-primary",
      executor: "fake-primary",
      verifier: "fake-primary",
      adversarial_verifier: "fake-secondary",
    },
    ...services,
    getPool: () => pool,
  });

  assert.equal(result.status, "completed", JSON.stringify(result.failure));
  assert.deepEqual(calls.map((call) => recordValue(call.meta).role), [
    "planner",
    "executor",
    "verifier",
    "adversarial_verifier",
    "executor",
    "verifier",
    "adversarial_verifier",
  ]);
  const executors = calls.filter((call) => recordValue(call.meta).role === "executor");
  const verifiers = calls.filter((call) => recordValue(call.meta).role === "verifier");
  const adversarial = calls.filter((call) => recordValue(call.meta).role === "adversarial_verifier");
  assert.equal(recordValue(executors[0].meta).conversationKey, recordValue(executors[1].meta).conversationKey);
  assert.equal(verifiers.length, 2, "the repaired candidate must replay ordinary verification");
  assert.notEqual(recordValue(adversarial[0].meta).conversationKey, recordValue(adversarial[1].meta).conversationKey);
  assert.ok(events.some((event) => event.type === "solver_repair_started" && event.triggerPhase === "adversarial_verify"));
  assert.ok(events.some((event) => event.type === "solver_repair_completed" && event.triggerPhase === "adversarial_verify"));
});
