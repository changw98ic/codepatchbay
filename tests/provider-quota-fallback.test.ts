import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { runQuotaFallbackRetry } from "../core/engine/provider-quota-fallback.js";
import { recordValue } from "../shared/types.js";

test("runQuotaFallbackRetry marks failed provider unavailable and retries with fallback agent", async () => {
  const events: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];
  const delegateWrites: Record<string, unknown>[] = [];
  let retryInput: Record<string, unknown> | null = null;
  let handoffInput: Record<string, unknown> | null = null;
  const scope = { allowedFiles: ["README.md"] };
  const signal = new AbortController().signal;
  const processHooks = { registerChild: async (_pid: number) => {} };
  const conversationKey = "cpb:proj:job-quota:attempt-1:executor";
  const onProgress = async (event: Record<string, unknown>) => {
    progress.push(event);
  };
  const phaseAgents: Record<string, unknown> = { executor: "primary" };
  const handoffState = { count: 0, from: null, to: null, reason: null };
  const providerAttempts: Array<{ providerKey: string | null; agent: string | null; variant: string | null; status: string; at: string }> = [];
  const env = { ...process.env, CPB_PROVIDER_HANDOFF_MAX_PER_PHASE: "1" };

  const result = await runQuotaFallbackRetry({
    agent: "primary",
    providerServices: {
      async delegateMarkProviderUnavailable(_hubRoot: string, payload: Record<string, unknown>) {
        delegateWrites.push(payload);
      },
      async assertProviderAvailable(_hubRoot: string, payload: Record<string, unknown>) {
        if (payload.providerKey !== "secondary") {
          throw new Error("primary unavailable");
        }
      },
    },
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    onProgress,
  }, {
    hubRoot: "/tmp/hub",
    pool: {
      providerKey(agent: string) {
        return agent;
      },
      fallbackCandidates() {
        return [{ providerKey: "secondary", agent: "secondary", variant: null }];
      },
    },
    phase: "execute",
    role: "executor",
    nodeId: "execute",
    dagNode: { id: "execute", phase: "execute" },
    project: "proj",
    task: "quota fallback task",
    jobId: "job-quota",
    job: { jobId: "job-quota" },
    workflow: "standard",
    planMode: "full",
    cpbRoot: "/tmp/cpb",
    dataRoot: "/tmp/data",
    sourcePath: "/tmp/source",
    phaseSourceContext: { existing: true },
    state: { planId: "plan-1" },
    phaseResults: [{ phase: "plan", status: "passed" }],
    attemptId: "attempt-1",
    scope,
    signal,
    processHooks,
    conversationKey,
    phaseTimeout: 1000,
    handoffState,
    providerAttempts,
    phaseAgents,
    env,
    result: {
      schemaVersion: 1,
      phase: "execute",
      status: "failed",
      failure: {
        kind: FailureKind.AGENT_RATE_LIMITED,
        phase: "execute",
        reason: "primary rate limited",
        retryable: true,
        cause: {
          providerKey: "primary",
          status: "rate_limited",
          stdout: "partial out",
          stderr: "partial err",
        },
      },
    },
  }, {
    now: () => "2026-06-22T00:00:00.000Z",
    nowMs: () => 0,
    generateHandoffBundle: async (input: Record<string, unknown>) => {
      handoffInput = input;
      return { kind: "handoff", originProvider: input.originProvider };
    },
    runPhase: async (input: Record<string, unknown>) => {
      retryInput = input;
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
  assert.deepEqual(delegateWrites, [{
    providerKey: "primary",
    agent: "primary",
    variant: null,
    status: "rate_limited",
    nextEligibleAt: 60_000,
    source: "run-job-handoff",
    confidence: 0.8,
    reason: "primary rate limited",
  }]);
  assert.deepEqual(providerAttempts, [{
    providerKey: "primary",
    agent: "primary",
    variant: null,
    status: "rate_limited",
    at: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(handoffState, {
    count: 1,
    from: "primary",
    to: "secondary",
    reason: "primary rate limited",
  });
  assert.equal(phaseAgents.executor, "secondary");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "provider_handoff");
  assert.equal(events[0].midRun, true);
  assert.equal(progress.some((event) => event.type === "provider_handoff"), true);
  assert.equal(handoffInput?.originProvider, "primary");
  assert.equal(handoffInput?.partialStdout, "partial out");
  assert.equal(handoffInput?.partialStderr, "partial err");
  const retryAgents = recordValue(retryInput?.agents);
  const retrySourceContext = recordValue(retryInput?.sourceContext);
  assert.equal(retryAgents.executor, "secondary");
  assert.deepEqual(retrySourceContext.handoff, { kind: "handoff", originProvider: "primary" });
  assert.equal(retryInput?.scope, scope);
  assert.equal(retryInput?.signal, signal);
  assert.equal(retryInput?.processHooks, processHooks);
  assert.equal(retryInput?.conversationKey, conversationKey);
  assert.equal(retryInput?.onProgress, onProgress);
  assert.equal(retryInput?.env, env);
});

test("runQuotaFallbackRetry resolves handoff limits and source path from job env before ambient env", async () => {
  const jobEnv = {
    ...process.env,
    CPB_PROVIDER_HANDOFF_MAX_PER_PHASE: "2",
    CPB_PROJECT_PATH_OVERRIDE: "/tmp/job-source",
  };
  const phaseAgents: Record<string, unknown> = { executor: "primary" };
  const handoffInputs: Record<string, unknown>[] = [];
  const runInputs: Record<string, unknown>[] = [];
  let fallbackIndex = 0;

  const result = await runQuotaFallbackRetry({
    agent: "primary",
    providerServices: {
      async delegateMarkProviderUnavailable() {},
    },
  }, {
      hubRoot: "/tmp/hub",
      pool: { providerKey(agent: string) { return agent; } },
      phase: "execute",
      role: "executor",
      nodeId: "execute",
      dagNode: { id: "execute", phase: "execute" },
      project: "proj",
      task: "quota fallback env task",
      jobId: "job-quota-env",
      job: {},
      cpbRoot: "/tmp/cpb",
      state: {},
      phaseResults: [],
      phaseTimeout: 1000,
      handoffState: { count: 0, from: null, to: null, reason: null },
      providerAttempts: [],
      phaseAgents,
      env: jobEnv,
      result: {
        schemaVersion: 1,
        phase: "execute",
        status: "failed",
        failure: {
          kind: FailureKind.AGENT_RATE_LIMITED,
          phase: "execute",
          reason: "primary rate limited",
          retryable: true,
          cause: { providerKey: "primary", status: "rate_limited" },
        },
        diagnostics: {},
      },
    }, {
      now: () => "2026-06-22T00:00:00.000Z",
      preflightProvider: async () => {
        fallbackIndex += 1;
        return {
          available: true,
          switched: true,
          selectedAgent: fallbackIndex === 1 ? "secondary" : "tertiary",
          selectedProviderKey: fallbackIndex === 1 ? "secondary" : "tertiary",
          reason: "fallback",
          from: fallbackIndex === 1 ? "primary" : "secondary",
        };
      },
      generateHandoffBundle: async (input: Record<string, unknown>) => {
        handoffInputs.push(input);
        return { sourcePath: input.sourcePath };
      },
      runPhase: async (input: Record<string, unknown>) => {
        runInputs.push(input);
        if (runInputs.length === 1) {
          return {
            schemaVersion: 1,
            phase: "execute",
            status: "failed",
            failure: {
              kind: FailureKind.AGENT_RATE_LIMITED,
              phase: "execute",
              reason: "secondary rate limited",
              retryable: true,
              cause: { providerKey: "secondary", status: "rate_limited" },
            },
            diagnostics: {},
          };
        }
        return {
          schemaVersion: 1,
          phase: "execute",
          status: "passed",
          diagnostics: {},
        };
      },
    });

  assert.equal(result.status, "passed");
  assert.equal(runInputs.length, 2);
  assert.deepEqual(handoffInputs.map((input) => input.sourcePath), ["/tmp/job-source", "/tmp/job-source"]);
  assert.deepEqual(runInputs.map((input) => input.sourcePath), ["/tmp/job-source", "/tmp/job-source"]);
  assert.deepEqual(runInputs.map((input) => input.env), [jobEnv, jobEnv]);
  assert.equal(phaseAgents.executor, "tertiary");
});

test("runQuotaFallbackRetry keeps concurrent job env and source path isolated", async () => {
  async function runScenario(config: {
    jobId: string;
    marker: string;
    sourcePath: string;
    maxHandoffs: string;
    fallbackAgents: string[];
  }) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CPB_PROVIDER_HANDOFF_MAX_PER_PHASE: config.maxHandoffs,
      CPB_PROJECT_PATH_OVERRIDE: config.sourcePath,
      CPB_PROVIDER_FALLBACK_TEST_MARKER: config.marker,
    };
    const phaseAgents: Record<string, unknown> = { executor: `${config.marker}-primary` };
    const handoffState = { count: 0, from: null, to: null, reason: null };
    const handoffInputs: Record<string, unknown>[] = [];
    const runInputs: Record<string, unknown>[] = [];
    let fallbackIndex = 0;

    const result = await runQuotaFallbackRetry({
      agent: `${config.marker}-primary`,
      providerServices: {
        async delegateMarkProviderUnavailable() {
          await Promise.resolve();
        },
      },
    }, {
      hubRoot: "/tmp/hub",
      pool: { providerKey(agent: string) { return agent; } },
      phase: "execute",
      role: "executor",
      nodeId: "execute",
      dagNode: { id: "execute", phase: "execute" },
      project: "proj",
      task: `quota fallback ${config.marker}`,
      jobId: config.jobId,
      job: {},
      cpbRoot: "/tmp/cpb",
      state: {},
      phaseResults: [],
      phaseTimeout: 1000,
      handoffState,
      providerAttempts: [],
      phaseAgents,
      env,
      result: {
        schemaVersion: 1,
        phase: "execute",
        status: "failed",
        failure: {
          kind: FailureKind.AGENT_RATE_LIMITED,
          phase: "execute",
          reason: `${config.marker}-primary rate limited`,
          retryable: true,
          cause: { providerKey: `${config.marker}-primary`, status: "rate_limited" },
        },
        diagnostics: {},
      },
    }, {
      now: () => "2026-06-22T00:00:00.000Z",
      preflightProvider: async () => {
        await Promise.resolve();
        const selectedAgent = config.fallbackAgents[fallbackIndex];
        fallbackIndex += 1;
        return {
          available: true,
          switched: true,
          selectedAgent,
          selectedProviderKey: selectedAgent,
          reason: `fallback ${config.marker}`,
          from: String(phaseAgents.executor),
        };
      },
      generateHandoffBundle: async (input: Record<string, unknown>) => {
        await Promise.resolve();
        handoffInputs.push(input);
        return {
          marker: config.marker,
          sourcePath: input.sourcePath,
        };
      },
      runPhase: async (input: Record<string, unknown>) => {
        await Promise.resolve();
        runInputs.push(input);
        if (runInputs.length < config.fallbackAgents.length) {
          const failedAgent = config.fallbackAgents[runInputs.length - 1];
          return {
            schemaVersion: 1,
            phase: "execute",
            status: "failed",
            failure: {
              kind: FailureKind.AGENT_RATE_LIMITED,
              phase: "execute",
              reason: `${failedAgent} rate limited`,
              retryable: true,
              cause: { providerKey: failedAgent, status: "rate_limited" },
            },
            diagnostics: {},
          };
        }
        return {
          schemaVersion: 1,
          phase: "execute",
          status: "passed",
          diagnostics: {},
        };
      },
    });

    return { result, env, handoffState, handoffInputs, runInputs };
  }

  const [oneHandoff, twoHandoffs] = await Promise.all([
    runScenario({
      jobId: "job-concurrent-one",
      marker: "one",
      sourcePath: "/tmp/job-one-source",
      maxHandoffs: "1",
      fallbackAgents: ["one-secondary"],
    }),
    runScenario({
      jobId: "job-concurrent-two",
      marker: "two",
      sourcePath: "/tmp/job-two-source",
      maxHandoffs: "2",
      fallbackAgents: ["two-secondary", "two-tertiary"],
    }),
  ]);

  assert.equal(oneHandoff.result.status, "passed");
  assert.equal(twoHandoffs.result.status, "passed");
  assert.equal(oneHandoff.handoffState.count, 1);
  assert.equal(twoHandoffs.handoffState.count, 2);
  assert.deepEqual(oneHandoff.handoffInputs.map((input) => input.sourcePath), ["/tmp/job-one-source"]);
  assert.deepEqual(twoHandoffs.handoffInputs.map((input) => input.sourcePath), ["/tmp/job-two-source", "/tmp/job-two-source"]);
  assert.deepEqual(oneHandoff.runInputs.map((input) => input.sourcePath), ["/tmp/job-one-source"]);
  assert.deepEqual(twoHandoffs.runInputs.map((input) => input.sourcePath), ["/tmp/job-two-source", "/tmp/job-two-source"]);
  assert.deepEqual(oneHandoff.runInputs.map((input) => input.env), [oneHandoff.env]);
  assert.deepEqual(twoHandoffs.runInputs.map((input) => input.env), [twoHandoffs.env, twoHandoffs.env]);
  assert.deepEqual(oneHandoff.runInputs.map((input) => recordValue(input.env).CPB_PROVIDER_FALLBACK_TEST_MARKER), ["one"]);
  assert.deepEqual(twoHandoffs.runInputs.map((input) => recordValue(input.env).CPB_PROVIDER_FALLBACK_TEST_MARKER), ["two", "two"]);
});

test("runQuotaFallbackRetry preserves the executor-family exclusion during mid-run verifier handoff", async () => {
  let observedExcludedFamily: string | null | undefined;
  let observedAllowedAgents: unknown;
  const phaseAgents: Record<string, unknown> = { verifier: "claude" };
  const result = await runQuotaFallbackRetry({
    agent: "claude",
    providerServices: {
      async delegateMarkProviderUnavailable() {},
    },
  }, {
    hubRoot: "/tmp/hub",
    pool: {
      providerKey(agent: string) { return agent; },
      fallbackCandidates() { return []; },
    },
    phase: "verify",
    role: "verifier",
    nodeId: "verify",
    dagNode: { id: "verify", phase: "verify" },
    project: "proj",
    task: "verify high-risk change",
    jobId: "job-independent-fallback",
    job: {},
    cpbRoot: "/tmp/cpb",
    state: {},
    phaseResults: [],
    phaseTimeout: 1000,
    handoffState: { count: 0, from: null, to: null, reason: null },
    providerAttempts: [],
    phaseAgents,
    allowedAgents: ["codex", "claude-glm"],
    excludeProviderFamily: "codex",
    result: {
      phase: "verify",
      status: "failed",
      failure: {
        kind: FailureKind.AGENT_RATE_LIMITED,
        phase: "verify",
        reason: "claude quota exhausted",
        retryable: true,
        cause: { providerKey: "claude", status: "rate_limited" },
      },
    },
  }, {
    preflightProvider: async (input) => {
      observedExcludedFamily = input.excludeProviderFamily;
      observedAllowedAgents = input.allowedAgents;
      return {
        available: true,
        switched: true,
        selectedAgent: "claude-secondary",
        selectedProviderKey: "claude:secondary",
        reason: "fallback from claude",
        from: "claude",
      };
    },
    runPhase: async () => ({ phase: "verify", status: "passed", diagnostics: {} }),
  });

  assert.equal(observedExcludedFamily, "codex");
  assert.deepEqual(observedAllowedAgents, ["codex", "claude-glm"]);
  assert.equal(phaseAgents.verifier, "claude-secondary");
  assert.equal(result.status, "passed");
});

test("runQuotaFallbackRetry hands explicit provider transport disconnects to another provider", async () => {
  const writes: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let runCalls = 0;
  const phaseAgents: Record<string, unknown> = { executor: "codex" };
  const result = await runQuotaFallbackRetry({
    agent: "codex",
    providerServices: {
      async delegateMarkProviderUnavailable(_hubRoot: string, payload: Record<string, unknown>) {
        writes.push(payload);
      },
    },
    appendEvent: async (_root: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
  }, {
    hubRoot: "/tmp/hub",
    pool: { providerKey(agent: string) { return agent; } },
    phase: "execute",
    role: "executor",
    nodeId: "execute",
    dagNode: { id: "execute", phase: "execute" },
    project: "proj",
    task: "fix parser state",
    jobId: "job-transport-handoff",
    job: {},
    cpbRoot: "/tmp/cpb",
    state: {},
    phaseResults: [],
    phaseTimeout: 1000,
    handoffState: { count: 0, from: null, to: null, reason: null },
    providerAttempts: [],
    phaseAgents,
    result: {
      phase: "execute",
      status: "failed",
      failure: {
        kind: FailureKind.AGENT_UNAVAILABLE,
        phase: "execute",
        reason: "stream disconnected before completion",
        retryable: true,
        cause: { providerKey: "codex" },
      },
      diagnostics: { transportFailure: true },
    },
  }, {
    preflightProvider: async () => ({
      available: true,
      switched: true,
      selectedAgent: "claude",
      selectedProviderKey: "claude",
      reason: "fallback from codex",
      from: "codex",
    }),
    runPhase: async () => {
      runCalls += 1;
      return { phase: "execute", status: "passed", diagnostics: { providerKey: "claude" } };
    },
  });

  assert.equal(result.status, "passed");
  assert.equal(runCalls, 1);
  assert.equal(phaseAgents.executor, "claude");
  assert.equal(writes[0].providerKey, "codex");
  assert.equal(writes[0].status, "unknown");
  assert.equal(writes[0].source, "provider-transport-handoff");
  assert.ok(events.some((event) => event.type === "provider_handoff" && event.from === "codex" && event.to === "claude"));
});
