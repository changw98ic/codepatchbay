import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { runQuotaFallbackRetry } from "../core/engine/provider-quota-fallback.js";

test("runQuotaFallbackRetry marks failed provider unavailable and retries with fallback agent", async () => {
  const events: Record<string, any>[] = [];
  const progress: Record<string, any>[] = [];
  const delegateWrites: Record<string, any>[] = [];
  let retryInput: Record<string, any> | null = null;
  let handoffInput: Record<string, any> | null = null;
  const phaseAgents: Record<string, any> = { executor: "primary" };
  const handoffState = { count: 0, from: null, to: null, reason: null };
  const providerAttempts: Array<{ providerKey: string | null; agent: string | null; variant: string | null; status: string; at: string }> = [];

  const result = await runQuotaFallbackRetry({
    agent: "primary",
    providerServices: {
      async delegateMarkProviderUnavailable(_hubRoot: string, payload: Record<string, any>) {
        delegateWrites.push(payload);
      },
      async assertProviderAvailable(_hubRoot: string, payload: Record<string, any>) {
        if (payload.providerKey !== "secondary") {
          throw new Error("primary unavailable");
        }
      },
    },
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, any>) => {
      events.push(event);
    },
    onProgress: async (event: Record<string, any>) => {
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
    generateHandoffBundle: async (input: Record<string, any>) => {
      handoffInput = input;
      return { kind: "handoff", originProvider: input.originProvider };
    },
    runPhase: async (input: Record<string, any>) => {
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
  assert.equal(retryInput?.agents.executor, "secondary");
  assert.deepEqual(retryInput?.sourceContext.handoff, { kind: "handoff", originProvider: "primary" });
});
