import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { runPhaseRetryLoops } from "../core/engine/phase-retry.js";
import { recordValue } from "../shared/types.js";

function failedResult(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    phase: "execute",
    status: "failed",
    artifact: null,
    failure: {
      kind,
      phase: "execute",
      reason: "initial failure",
      retryable: true,
      stderrSnippet: "stderr fallback",
      cause: {},
      ...overrides,
    },
    diagnostics: {},
  };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    phase: "execute",
    role: "executor",
    nodeId: "execute",
    dagNode: { id: "execute", phase: "execute" },
    project: "proj",
    task: "phase retry task",
    jobId: "job-phase-retry",
    job: { jobId: "job-phase-retry" },
    workflow: "standard",
    planMode: "full",
    cpbRoot: "/tmp/cpb",
    dataRoot: "/tmp/data",
    sourcePath: "/tmp/source",
    phaseSourceContext: { base: true },
    pool: { id: "pool" },
    state: { planId: "plan-1" },
    phaseResults: [{ phase: "plan", status: "passed" }],
    attemptId: "attempt-1",
    phaseTimeout: 1000,
    phaseAgents: { executor: "fake-acp" },
    ...overrides,
  };
}

test("runPhaseRetryLoops retries retryable transient failures after configured delay", async () => {
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];
  const delays: number[] = [];
  const runInputs: Record<string, unknown>[] = [];

  const result = await runPhaseRetryLoops({
    agent: "fake-acp",
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
  }, {
    ...baseState(),
    result: failedResult(FailureKind.TIMEOUT),
  }, {
    phaseRetryMax: 2,
    phaseFeedbackRetryMax: 1,
    retryBaseDelayMs: () => 25,
    delay: async (ms: number) => {
      delays.push(ms);
    },
    now: () => "2026-06-22T00:00:00.000Z",
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "execute",
        status: "passed",
        artifact: { name: "deliverable-1" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(delays, [25]);
  assert.equal(runInputs.length, 1);
  const sourceContext = recordValue(runInputs[0].sourceContext);
  const retry = recordValue(sourceContext.retry);
  assert.equal(sourceContext.base, true);
  assert.equal(retry.failureClass, "timeout");
  assert.match(String(retry.failureFingerprint), /^sha256:/);
  assert.equal(retry.retryStrategy, "fresh_session_with_carry_forward");
  assert.equal(retry.strategyChanged, true);
  assert.equal(retry.forceFreshSession, true);
  assert.match(String(runInputs[0].conversationKey), /fresh_session_with_carry_forward/);
  assert.equal(events[0].type, "phase_retry");
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].maxAttempts, 2);
  assert.equal(progress.some((event) => event.type === "phase_retry"), true);
});

test("runPhaseRetryLoops leaves verification failures for cross-phase repair routing", async () => {
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];
  let runCalls = 0;

  const failedVerification = {
    ...failedResult(FailureKind.VERIFICATION_FAILED, {
      phase: "verify",
      reason: "AC-002 failed",
      retryable: true,
      cause: {
        verdict: {
          status: "fail",
          fix_scope: ["sphinx/domains/python.py"],
          checklistVerdict: {
            items: [{ checklistId: "AC-002", result: "fail", fixScope: ["sphinx/domains/python.py"] }],
            fixScope: ["sphinx/domains/python.py"],
          },
        },
      },
    }),
    phase: "verify",
  };

  const result = await runPhaseRetryLoops({
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
  }, {
    ...baseState({
      phase: "verify",
      role: "verifier",
      nodeId: "verify",
      dagNode: { id: "verify", phase: "verify" },
      phaseAgents: { verifier: "fake-acp" },
    }),
    result: failedVerification,
  }, {
    phaseRetryMax: 2,
    retryBaseDelayMs: () => 0,
    delay: async () => {},
    runPhase: async () => {
      runCalls += 1;
      return {
        schemaVersion: 1,
        phase: "verify",
        status: "passed",
        artifact: { name: "incorrect-verify-rerun" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.failure?.kind, FailureKind.VERIFICATION_FAILED);
  assert.equal(runCalls, 0);
  assert.equal(events.some((event) => event.type === "phase_retry"), false);
  assert.equal(progress.some((event) => event.type === "phase_retry"), false);
});

test("runPhaseRetryLoops carries bounded handoff evidence into plan timeout retries", async () => {
  const events: Record<string, unknown>[] = [];
  const runInputs: Record<string, unknown>[] = [];
  const carryForward = {
    readSearchCount: 2,
    toolCalls: [{ event: "tool_call", title: "Read src/router.ts", kind: "read" }],
  };

  const result = await runPhaseRetryLoops({
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
  }, {
    ...baseState({
      phase: "plan",
      role: "planner",
      nodeId: "plan",
      dagNode: { id: "plan", phase: "plan" },
      phaseResults: [],
      phaseAgents: { planner: "fake-acp" },
    }),
    result: {
      ...failedResult(FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT, {
        phase: "plan",
        reason: "plan_bounded_handoff_timeout: timed out before Bounded Handoff",
        cause: { handoffCarryForward: carryForward },
      }),
      phase: "plan",
    },
  }, {
    phaseRetryMax: 1,
    retryBaseDelayMs: () => 0,
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "plan",
        status: "passed",
        artifact: { name: "plan-retry" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  assert.equal(result.status, "passed");
  const retry = recordValue(recordValue(runInputs[0].sourceContext).retry);
  assert.equal(retry.failureKind, FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT);
  assert.equal(retry.retryClass, "bounded_handoff_timeout");
  assert.deepEqual(retry.handoffCarryForward, carryForward);
  assert.match(String(retry.instruction), /reuse the carry-forward static evidence/i);
  assert.equal(events.find((event) => event.type === "phase_retry")?.carryForward, true);
});

test("runPhaseRetryLoops appends feedback context for artifact validation failures", async () => {
  const events: Record<string, unknown>[] = [];
  const runInputs: Record<string, unknown>[] = [];

  const result = await runPhaseRetryLoops({
    agent: "fake-acp",
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
  }, {
    ...baseState(),
    result: failedResult(FailureKind.ARTIFACT_INVALID, {
      retryable: false,
      reason: "artifact missing field",
      cause: { rawOutput: "raw invalid artifact" },
    }),
  }, {
    phaseRetryMax: 0,
    phaseFeedbackRetryMax: 1,
    now: () => "2026-06-22T00:00:00.000Z",
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "execute",
        status: "passed",
        artifact: { name: "deliverable-2" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(events[0].type, "phase_feedback_retry");
  assert.equal(events[0].failureKind, FailureKind.ARTIFACT_INVALID);
  const retryContext = recordValue(recordValue(runInputs[0].sourceContext).retry);
  assert.equal(retryContext.failureKind, FailureKind.ARTIFACT_INVALID);
  assert.equal(retryContext.failureReason, "artifact missing field");
  assert.equal(retryContext.failureClass, "contract_error");
  assert.match(String(retryContext.failureFingerprint), /^sha256:/);
  assert.equal(retryContext.retryStrategy, "contract_repair");
  assert.equal(retryContext.strategyChanged, true);
  assert.equal(retryContext.previousOutput, "stderr fallback");
  assert.equal(retryContext.attempt, 1);
});

test("runPhaseRetryLoops repairs an invalid verifier checklist contract before failing the job", async () => {
  const events: Record<string, unknown>[] = [];
  const runInputs: Record<string, unknown>[] = [];

  const result = await runPhaseRetryLoops({
    agent: "codex",
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
  }, {
    ...baseState({ phase: "verify", role: "verifier" }),
    result: failedResult(FailureKind.VERDICT_INVALID, {
      retryable: false,
      reason: "blocking[0].checklistId must reference the frozen checklist",
    }),
  }, {
    phaseRetryMax: 0,
    phaseFeedbackRetryMax: 1,
    now: () => "2026-07-16T00:00:00.000Z",
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "verify",
        status: "passed",
        artifact: { name: "verdict-repaired" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(events[0].type, "phase_feedback_retry");
  assert.equal(events[0].failureKind, FailureKind.VERDICT_INVALID);
  const retry = recordValue(recordValue(runInputs[0].sourceContext).retry);
  assert.equal(retry.retryStrategy, "rebuild_evidence");
  assert.match(String(retry.instruction), /reference only frozen checklist ids/i);
  assert.match(String(retry.instruction), /blocking\[0\]\.checklistId/);
});

test("runPhaseRetryLoops repairs hard-constraint interceptions without consuming phase retry attempts", async () => {
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];
  const delays: number[] = [];
  const runInputs: Record<string, unknown>[] = [];

  const result = await runPhaseRetryLoops({
    agent: "fake-acp",
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
  }, {
    ...baseState({
      phaseAgents: { executor: "codex" },
    }),
    result: failedResult(FailureKind.BROAD_TEST_COMMAND_DENIED, {
      retryable: true,
      reason: "broad_test_command_denied: use the exact canonical command",
      stderrSnippet: "python3 tests/runtests.py",
    }),
  }, {
    phaseRetryMax: 3,
    phaseQualityRepairMax: 2,
    retryBaseDelayMs: () => 25,
    delay: async (ms: number) => {
      delays.push(ms);
    },
    now: () => "2026-06-22T00:00:00.000Z",
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "execute",
        status: "passed",
        artifact: { name: "deliverable-quality-repair" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(delays, [], "quality repair should not use phase retry backoff");
  assert.equal(runInputs.length, 1);
  assert.equal(events.some((event) => event.type === "phase_retry"), false);
  assert.equal(events[0].type, "phase_quality_retry");
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].maxAttempts, 2);
  assert.equal(progress.some((event) => event.type === "phase_quality_retry"), true);
  const retryContext = recordValue(recordValue(runInputs[0].sourceContext).retry);
  assert.equal(retryContext.failureKind, FailureKind.BROAD_TEST_COMMAND_DENIED);
  assert.equal(retryContext.retryClass, "quality_interception");
  assert.equal(retryContext.attempt, 1);
  assert.match(String(retryContext.instruction), /execute phase/i);
  assert.match(String(retryContext.instruction), /do not run tests/i);
  assert.match(String(retryContext.instruction), /python -c probes/i);
});

test("runPhaseRetryLoops keeps canonical command repair guidance for verify broad-test interceptions", async () => {
  const runInputs: Record<string, unknown>[] = [];

  await runPhaseRetryLoops({}, {
    ...baseState({
      phase: "verify",
      role: "verifier",
      nodeId: "verify",
      dagNode: { id: "verify", phase: "verify" },
      phaseAgents: { verifier: "fake-acp" },
    }),
    result: {
      ...failedResult(FailureKind.BROAD_TEST_COMMAND_DENIED, {
        reason: "broad_test_command_denied: canonical command was wrapped",
      }),
      phase: "verify",
      failure: {
        ...failedResult(FailureKind.BROAD_TEST_COMMAND_DENIED).failure,
        kind: FailureKind.BROAD_TEST_COMMAND_DENIED,
        phase: "verify",
        reason: "broad_test_command_denied: canonical command was wrapped",
        retryable: true,
      },
    },
  }, {
    phaseQualityRepairMax: 1,
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "verify",
        status: "passed",
        artifact: { name: "verify-quality-repair" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  const retryContext = recordValue(recordValue(runInputs[0].sourceContext).retry);
  assert.match(String(retryContext.instruction), /exact canonical or explicitly listed diagnostic command/i);
  assert.doesNotMatch(String(retryContext.instruction), /execute phase/i);
});

test("runPhaseRetryLoops tells ordinary execute retries to stop no-edit exploration", async () => {
  const runInputs: Record<string, unknown>[] = [];

  await runPhaseRetryLoops({}, {
    ...baseState(),
    result: failedResult(FailureKind.EXECUTE_NO_EDIT_PROGRESS, {
      retryable: true,
      reason: "execute_no_edit_progress: exceeded no-edit read/search limit",
    }),
  }, {
    phaseQualityRepairMax: 1,
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "execute",
        status: "passed",
        artifact: { name: "execute-generic-no-edit-repair" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  const retryContext = recordValue(recordValue(runInputs[0].sourceContext).retry);
  assert.equal(retryContext.failureKind, FailureKind.EXECUTE_NO_EDIT_PROGRESS);
  assert.match(String(retryContext.instruction), /This is the execute phase/i);
  assert.match(String(retryContext.instruction), /Stop re-reading and searching/i);
  assert.match(String(retryContext.instruction), /concrete blocker/i);
});

test("runPhaseRetryLoops discards mutating verifier evidence and retries in a fresh session", async () => {
  const events: Record<string, unknown>[] = [];
  const runInputs: Record<string, unknown>[] = [];

  const result = await runPhaseRetryLoops({
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
  }, {
    ...baseState({
      phase: "verify",
      role: "verifier",
      nodeId: "verify",
      dagNode: { id: "verify", phase: "verify" },
      conversationKey: "cpb:proj:job-phase-retry:verifier:candidate:sha256-frozen:round:1",
      phaseAgents: { verifier: "claude-glm" },
    }),
    result: {
      ...failedResult(FailureKind.READ_ONLY_MUTATION_DENIED),
      phase: "verify",
      failure: {
        ...failedResult(FailureKind.READ_ONLY_MUTATION_DENIED).failure,
        kind: FailureKind.READ_ONLY_MUTATION_DENIED,
        phase: "verify",
        reason: "read-only phase attempted to modify <provider-did-not-report-path>",
        retryable: false,
        cause: {
          readOnlyMutation: { targetPath: "<provider-did-not-report-path>" },
        },
      },
    },
  }, {
    phaseQualityRepairMax: 1,
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "verify",
        status: "passed",
        artifact: { name: "fresh-read-only-verdict" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(runInputs.length, 1);
  const retry = recordValue(recordValue(runInputs[0].sourceContext).retry);
  assert.equal(retry.failureKind, FailureKind.READ_ONLY_MUTATION_DENIED);
  assert.equal(retry.retryClass, "quality_interception");
  assert.equal(retry.retryStrategy, "fresh_session_permission_repair");
  assert.equal(retry.forceFreshSession, true);
  assert.match(String(runInputs[0].conversationKey), /fresh_session_permission_repair/);
  assert.match(String(retry.instruction), /Discard the prior verifier verdict/i);
  assert.match(String(retry.instruction), /fresh disposable replay/i);
  assert.match(String(retry.instruction), /byte-for-byte unchanged/i);
  assert.match(String(retry.instruction), /verification infrastructure unavailable/i);
  assert.equal(events.some((event) =>
    event.type === "phase_quality_retry"
    && event.failureKind === FailureKind.READ_ONLY_MUTATION_DENIED
    && event.forceFreshSession === true
  ), true);
});

test("runPhaseRetryLoops immediately falls back execute hard-constraint failures to Codex", async () => {
  const events: Record<string, unknown>[] = [];
  const runInputs: Record<string, unknown>[] = [];
  const phaseAgents = { executor: "claude-glm" };

  const result = await runPhaseRetryLoops({
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
  }, {
    ...baseState({
      phaseAgents,
      phaseSourceContext: {
        agentPolicy: { allowedAgents: ["codex", "claude-glm"] },
      },
    }),
    result: failedResult(FailureKind.EXECUTE_NO_EDIT_PROGRESS, {
      retryable: true,
      reason: "execute_no_edit_progress: exceeded no-edit read/search limit",
    }),
  }, {
    phaseRetryMax: 3,
    phaseQualityRepairMax: 1,
    phaseFeedbackRetryMax: 0,
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      const agents = recordValue(input.agents);
      if (agents.executor === "codex") {
        return {
          schemaVersion: 1,
          phase: "execute",
          status: "passed",
          artifact: { name: "execute-codex-fallback" },
          failure: null,
          diagnostics: {},
        };
      }
      return failedResult(FailureKind.EXECUTE_NO_EDIT_PROGRESS, {
        retryable: true,
        reason: "execute_no_edit_progress: repeated no-edit read/search limit",
      });
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(runInputs.length, 1);
  assert.equal(recordValue(runInputs[0].agents).executor, "codex");
  assert.equal(phaseAgents.executor, "codex");
  assert.deepEqual(recordValue(result.diagnostics?.phaseAgentFallback), {
    applied: true,
    count: 1,
    fromAgent: "claude-glm",
    toAgent: "codex",
    failureKind: FailureKind.EXECUTE_NO_EDIT_PROGRESS,
    reason: "execute_no_edit_progress: exceeded no-edit read/search limit",
  });
  assert.equal(events.some((event) => event.type === "phase_quality_retry"), false);
  const fallbackEvent = events.find((event) => event.type === "phase_agent_fallback");
  assert.ok(fallbackEvent);
  assert.equal(fallbackEvent.fromAgent, "claude-glm");
  assert.equal(fallbackEvent.toAgent, "codex");
  assert.equal(fallbackEvent.failureKind, FailureKind.EXECUTE_NO_EDIT_PROGRESS);
  const fallbackRetry = recordValue(recordValue(runInputs[0].sourceContext).retry);
  assert.equal(fallbackRetry.retryClass, "agent_fallback");
  assert.match(String(fallbackRetry.instruction), /Switch the execute actor to codex/i);
});

test("runPhaseRetryLoops never uses a hard-constraint fallback outside the allowed universe", async () => {
  const events: Record<string, unknown>[] = [];
  const runInputs: Record<string, unknown>[] = [];
  const phaseAgents = { executor: "claude-glm" };

  const result = await runPhaseRetryLoops({
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
  }, {
    ...baseState({
      phaseAgents,
      phaseSourceContext: {
        agentPolicy: { allowedAgents: ["claude-glm"] },
      },
    }),
    result: failedResult(FailureKind.EXECUTE_NO_EDIT_PROGRESS, {
      retryable: true,
      reason: "execute_no_edit_progress: exceeded no-edit read/search limit",
    }),
  }, {
    phaseRetryMax: 0,
    phaseQualityRepairMax: 1,
    phaseFeedbackRetryMax: 0,
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "execute",
        status: "passed",
        artifact: { name: "execute-same-agent-repair" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(recordValue(runInputs[0].agents).executor, "claude-glm");
  assert.equal(phaseAgents.executor, "claude-glm");
  assert.equal(events.some((event) => event.type === "phase_agent_fallback"), false);
  assert.equal(events.some((event) => event.type === "phase_agent_fallback_blocked"), true);
});

test("runPhaseRetryLoops tells plan retries to avoid dynamic probes after broad-test interceptions", async () => {
  const runInputs: Record<string, unknown>[] = [];

  await runPhaseRetryLoops({}, {
    ...baseState({
      phase: "plan",
      role: "planner",
      nodeId: "plan",
      dagNode: { id: "plan", phase: "plan" },
      phaseAgents: { planner: "fake-acp" },
    }),
    result: {
      ...failedResult(FailureKind.BROAD_TEST_COMMAND_DENIED, {
        reason: "broad_test_command_denied: inline Python probe was blocked",
      }),
      phase: "plan",
      failure: {
        ...failedResult(FailureKind.BROAD_TEST_COMMAND_DENIED).failure,
        kind: FailureKind.BROAD_TEST_COMMAND_DENIED,
        phase: "plan",
        reason: "broad_test_command_denied: inline Python probe was blocked",
        retryable: true,
      },
    },
  }, {
    phaseQualityRepairMax: 1,
    runPhase: async (input: Record<string, unknown>) => {
      runInputs.push(input);
      return {
        schemaVersion: 1,
        phase: "plan",
        status: "passed",
        artifact: { name: "plan-quality-repair" },
        failure: null,
        diagnostics: {},
      };
    },
  });

  const retryContext = recordValue(recordValue(runInputs[0].sourceContext).retry);
  assert.match(String(retryContext.instruction), /plan phase/i);
  assert.match(String(retryContext.instruction), /do not run tests/i);
  assert.match(String(retryContext.instruction), /heredoc scripts/i);
  assert.doesNotMatch(String(retryContext.instruction), /exact canonical/i);
});

test("runPhaseRetryLoops does not retry quota delegate write failures", async () => {
  let runCalls = 0;
  const result = await runPhaseRetryLoops({}, {
    ...baseState(),
    result: failedResult(FailureKind.RUNTIME_INTERRUPTED, {
      reason: "quota delegate failure",
      cause: { code: "QUOTA_DELEGATE_CLIENT_UNAVAILABLE" },
    }),
  }, {
    phaseRetryMax: 2,
    phaseFeedbackRetryMax: 1,
    runPhase: async () => {
      runCalls += 1;
      throw new Error("quota delegate failures must not be retried here");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(runCalls, 0);
});

test("runPhaseRetryLoops stops after repeated hard-constraint quality repair attempts", async () => {
  let runCalls = 0;
  const events: Record<string, unknown>[] = [];
  const result = await runPhaseRetryLoops({
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
  }, {
    ...baseState({
      phaseAgents: { executor: "codex" },
    }),
    result: failedResult(FailureKind.WEB_TOOL_DENIED, {
      reason: "web denied",
      retryable: true,
    }),
  }, {
    phaseRetryMax: 3,
    phaseQualityRepairMax: 2,
    phaseFeedbackRetryMax: 0,
    retryBaseDelayMs: () => 0,
    delay: async () => {},
    runPhase: async () => {
      runCalls += 1;
      return failedResult(FailureKind.WEB_TOOL_DENIED, {
        reason: "web denied again",
        retryable: true,
      });
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(runCalls, 2);
  assert.equal(result.failure?.kind, FailureKind.WEB_TOOL_DENIED);
  assert.equal(events.length, 2);
  assert.equal(events.every((event) => event.type === "phase_quality_retry"), true);
  assert.equal(events.some((event) => event.type === "phase_retry"), false);
  assert.equal(events[0].retryStrategy, "correct_permission_strategy");
  assert.equal(events[1].retryStrategy, "fresh_session_permission_repair");
  assert.notEqual(events[0].retryStrategy, events[1].retryStrategy);
});

test("runPhaseRetryLoops stops a repeated fingerprint when no distinct phase strategy remains", async () => {
  let runCalls = 0;
  const events: Record<string, unknown>[] = [];
  const timeout = failedResult(FailureKind.TIMEOUT, {
    reason: "provider response timed out attempt 1",
  });
  const result = await runPhaseRetryLoops({
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
  }, {
    ...baseState(),
    result: timeout,
  }, {
    phaseRetryMax: 3,
    phaseRetryTotalMax: 3,
    retryBaseDelayMs: () => 0,
    delay: async () => {},
    runPhase: async () => {
      runCalls += 1;
      return failedResult(FailureKind.TIMEOUT, {
        reason: "provider response timed out attempt 2",
      });
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(runCalls, 1);
  const retryEvent = events.find((event) => event.type === "phase_retry");
  assert.equal(retryEvent?.retryStrategy, "fresh_session_with_carry_forward");
  const stopped = events.find((event) => event.type === "retry_decision");
  assert.equal(stopped?.action, "stop_repeated_failure");
  assert.equal(stopped?.failureFingerprint, retryEvent?.failureFingerprint);
  assert.match(String(stopped?.reason), /exhausted distinct phase recovery strategies/);
});
