import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { normalizePhaseUsage, recordPhaseProviderUsage } from "../core/engine/provider-usage-recorder.js";

test("normalizePhaseUsage records hard gate failures as zero-call usage", () => {
  assert.deepEqual(normalizePhaseUsage({ inputTokens: 10 }, { hardGateFailed: true }), {
    calls: 0,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    costUsd: null,
    tokenSource: "hard_gate",
    toolCalls: null,
    functionCalls: null,
  });
});

test("recordPhaseProviderUsage skips unavailable delegate paths without throwing", async () => {
  await recordPhaseProviderUsage({
    providerServices: {},
    hubRoot: "/tmp/hub",
    pool: null,
    agent: "codex",
    phaseAgents: {},
    project: "proj",
    job: {},
    phaseSourceContext: {},
    phase: "execute",
    role: "executor",
    result: { status: "passed", diagnostics: {} },
    handoffState: { count: 0, from: null, to: null, reason: null },
    providerAttempts: [],
  });

  await recordPhaseProviderUsage({
    providerServices: {
      delegateEnqueueProviderUsage() {
        throw new Error("should not be called without hub root");
      },
    },
    hubRoot: null,
    pool: null,
    agent: "codex",
    phaseAgents: {},
    project: "proj",
    job: {},
    phaseSourceContext: {},
    phase: "execute",
    role: "executor",
    result: { status: "passed", diagnostics: {} },
    handoffState: { count: 0, from: null, to: null, reason: null },
    providerAttempts: [],
  });
});

test("recordPhaseProviderUsage enqueues passed phase usage with provider metadata", async () => {
  const writes: Array<{ hubRoot: string; payload: Record<string, any> }> = [];
  const adapterLookups: Array<string | null> = [];

  await recordPhaseProviderUsage({
    providerServices: {
      getProviderAdapter(providerKey: string | null) {
        adapterLookups.push(providerKey);
        return { region: "us-east-1", providerKeyPattern: "claude:*" };
      },
      async delegateEnqueueProviderUsage(hubRoot: string, payload: Record<string, any>) {
        writes.push({ hubRoot, payload });
      },
    },
    hubRoot: "/tmp/hub",
    pool: {
      providerKey(agent: string | null | undefined, variant: string | null) {
        return variant ? `${agent}:${variant}` : agent;
      },
    },
    agent: "codex",
    phaseAgents: { executor: { agent: "claude", variant: "sonnet" } },
    project: "proj",
    job: { issueNumber: 7 },
    phaseSourceContext: {
      issueNumber: 42,
      source: "github_issue",
      attempt: "attempt-2",
    },
    phase: "execute",
    role: "executor",
    result: {
      status: "passed",
      diagnostics: {
        providerKey: "diag-provider",
        agent: "diag-agent",
        variant: "diag-variant",
        elapsedMs: 321,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 3,
          outputTokens: 4,
          reasoningOutputTokens: 1,
          totalTokens: 15,
          costUsd: 0.12,
          tokenSource: "acp_reported",
          toolCalls: 2,
          functionCalls: 1,
        },
      },
    },
    handoffState: { count: 0, from: null, to: null, reason: null },
    providerAttempts: [],
  });

  assert.deepEqual(adapterLookups, ["claude:sonnet"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].hubRoot, "/tmp/hub");
  assert.deepEqual(writes[0].payload, {
    project: "proj",
    issueNumber: 42,
    source: "github_issue",
    attempt: "attempt-2",
    phase: "execute",
    role: "executor",
    providerKey: "diag-provider",
    agent: "diag-agent",
    variant: "diag-variant",
    providerRegion: "us-east-1",
    providerAdapter: "claude:*",
    status: "ok",
    phaseStatus: "passed",
    durationMs: 321,
    quota: {
      status: null,
      source: null,
      confidence: null,
      nextEligibleAt: null,
      retryAfterMs: null,
      windowResetAt: null,
      weeklyResetAt: null,
      reason: null,
    },
    fallback: {
      used: false,
      fromProviderKey: null,
      toProviderKey: null,
      count: 0,
      reason: null,
    },
    providerAttempts: null,
    usage: {
      calls: 1,
      inputTokens: 10,
      cachedInputTokens: 3,
      outputTokens: 4,
      reasoningOutputTokens: 1,
      totalTokens: 15,
      costUsd: 0.12,
      tokenSource: "acp_reported",
      toolCalls: 2,
      functionCalls: 1,
    },
  });
});

test("recordPhaseProviderUsage records fallback and hard gate failure status", async () => {
  const writes: Array<Record<string, any>> = [];

  await recordPhaseProviderUsage({
    providerServices: {
      async delegateEnqueueProviderUsage(_hubRoot: string, payload: Record<string, any>) {
        writes.push(payload);
      },
    },
    hubRoot: "/tmp/hub",
    pool: {
      providerKey(agent: string | null | undefined) {
        return agent;
      },
    },
    agent: "codex",
    phaseAgents: { executor: "secondary" },
    project: "proj",
    job: {},
    phaseSourceContext: {
      github: { issueNumber: 99 },
    },
    phase: "execute",
    role: "executor",
    result: {
      status: "failed",
      diagnostics: {
        providerKey: "secondary",
        elapsedMs: 600,
        usage: { inputTokens: 20 },
      },
      failure: {
        kind: FailureKind.AGENT_RATE_LIMITED,
        reason: "primary rate limited",
        cause: {
          providerKey: "primary",
          status: "rate_limited",
          source: "acp",
          confidence: 0.8,
          nextEligibleAt: 123,
          retryAfterMs: 456,
          windowResetAt: 789,
          weeklyResetAt: 101_112,
          reason: "quota exhausted",
        },
      },
    },
    handoffState: {
      count: 1,
      from: "primary",
      to: "secondary",
      reason: "fallback selected",
    },
    providerAttempts: [{
      providerKey: "primary",
      agent: "codex",
      variant: null,
      status: "rate_limited",
      at: "2026-06-22T00:00:00.000Z",
    }],
  });

  await recordPhaseProviderUsage({
    providerServices: {
      async delegateEnqueueProviderUsage(_hubRoot: string, payload: Record<string, any>) {
        writes.push(payload);
      },
    },
    hubRoot: "/tmp/hub",
    pool: null,
    agent: "codex",
    phaseAgents: {},
    project: "proj",
    job: { issueNumber: 5 },
    phaseSourceContext: {},
    phase: "verify",
    role: "verifier",
    result: {
      status: "failed",
      diagnostics: {
        usage: { inputTokens: 20 },
      },
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "completion gate failed",
        cause: {
          hardGate: true,
        },
      },
    },
    handoffState: { count: 0, from: null, to: null, reason: null },
    providerAttempts: [],
  });

  assert.equal(writes.length, 2);
  assert.equal(writes[0].status, "fallback");
  assert.equal(writes[0].phaseStatus, "failed");
  assert.equal(writes[0].issueNumber, 99);
  assert.deepEqual(writes[0].quota, {
    status: "rate_limited",
    source: "acp",
    confidence: 0.8,
    nextEligibleAt: 123,
    retryAfterMs: 456,
    windowResetAt: 789,
    weeklyResetAt: 101112,
    reason: "quota exhausted",
  });
  assert.deepEqual(writes[0].fallback, {
    used: true,
    fromProviderKey: "primary",
    toProviderKey: "secondary",
    count: 1,
    reason: "fallback selected",
  });
  assert.deepEqual(writes[0].providerAttempts, [{
    providerKey: "primary",
    agent: "codex",
    variant: null,
    status: "rate_limited",
    at: "2026-06-22T00:00:00.000Z",
  }]);

  assert.equal(writes[1].status, "hard_gate_failed");
  assert.deepEqual(writes[1].usage, {
    calls: 0,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
    costUsd: null,
    tokenSource: "hard_gate",
    toolCalls: null,
    functionCalls: null,
  });
});

test("recordPhaseProviderUsage swallows delegate write failures", async () => {
  await recordPhaseProviderUsage({
    providerServices: {
      async delegateEnqueueProviderUsage() {
        throw new Error("delegate unavailable");
      },
    },
    hubRoot: "/tmp/hub",
    pool: null,
    agent: "codex",
    phaseAgents: {},
    project: "proj",
    job: {},
    phaseSourceContext: {},
    phase: "execute",
    role: "executor",
    result: { status: "passed", diagnostics: {} },
    handoffState: { count: 0, from: null, to: null, reason: null },
    providerAttempts: [],
  });
});
