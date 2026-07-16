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
  const phaseAgents: Record<string, unknown> = { executor: "primary" };
  const handoffState = { count: 0, from: null, to: null, reason: null };
  const providerAttempts: Array<{ providerKey: string | null; agent: string | null; variant: string | null; status: string; at: string }> = [];

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
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
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
    phaseTimeout: 1000,
    handoffState,
    providerAttempts,
    phaseAgents,
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
