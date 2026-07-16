import assert from "node:assert/strict";
import { test } from "node:test";

import {
  _internalAppendUsageLine,
  readAgentRoutingMetrics,
  readProviderUsageRollup,
  readSystemUsageRollup,
} from "../server/services/provider-usage.js";
import { tempRoot } from "./helpers.js";

test("provider usage rollup never presents missing token or cost telemetry as zero", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-missing");
  await _internalAppendUsageLine(hubRoot, {
    providerKey: "codex",
    status: "ok",
    usage: {
      calls: 1,
      totalTokens: null,
      costUsd: null,
      tokenSource: "acp_not_reported",
    },
  });

  const providers = await readProviderUsageRollup(hubRoot);
  assert.equal(providers.codex.tokens, null);
  assert.equal(providers.codex.reportedTokens, 0);
  assert.equal(providers.codex.reportedTokenCalls, 0);
  assert.equal(providers.codex.unreportedTokenCalls, 1);
  assert.equal(providers.codex.tokenCoverage, 0);
  assert.deepEqual(providers.codex.unreportedTokenSources, ["acp_not_reported"]);
  assert.equal(providers.codex.costUsd, null);
  assert.equal(providers.codex.costCoverage, 0);

  const system = await readSystemUsageRollup(hubRoot);
  assert.equal(system.totalTokens, null);
  assert.equal(system.reportedTokens, 0);
  assert.equal(system.tokenCoverage, 0);
  assert.equal(system.totalCostUsd, null);
});

test("provider usage rollup separates exact totals from partial observations", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-partial");
  await _internalAppendUsageLine(hubRoot, {
    providerKey: "codex",
    agent: "codex",
    status: "ok",
    usage: {
      calls: 1,
      totalTokens: 120,
      costUsd: null,
      tokenSource: "codex_session_rollout_delta",
    },
  });
  await _internalAppendUsageLine(hubRoot, {
    providerKey: "codex",
    agent: "codex",
    status: "error",
    usage: {
      calls: 1,
      totalTokens: null,
      costUsd: null,
      tokenSource: "acp_not_reported",
    },
  });
  await _internalAppendUsageLine(hubRoot, {
    providerKey: "claude",
    status: "hard_gate_failed",
    usage: {
      calls: 0,
      totalTokens: null,
      costUsd: null,
      tokenSource: "hard_gate",
    },
  });

  const providers = await readProviderUsageRollup(hubRoot);
  assert.equal(providers.codex.tokens, null);
  assert.equal(providers.codex.reportedTokens, 120);
  assert.equal(providers.codex.tokenCoverage, 0.5);
  assert.equal(providers.codex.tokenSource, "codex_session_rollout_delta");
  assert.deepEqual(providers.codex.tokenSources, ["codex_session_rollout_delta"]);
  assert.deepEqual(providers.codex.unreportedTokenSources, ["acp_not_reported"]);
  assert.equal(providers.claude.llmCalls, 0);
  assert.equal(providers.claude.tokens, 0);
  assert.equal(providers.claude.tokenCoverage, null);

  const system = await readSystemUsageRollup(hubRoot);
  assert.equal(system.llmCalls, 2);
  assert.equal(system.totalTokens, null);
  assert.equal(system.reportedTokens, 120);
  assert.equal(system.reportedTokenCalls, 1);
  assert.equal(system.unreportedTokenCalls, 1);
  assert.equal(system.tokenCoverage, 0.5);
});

test("provider usage rollup returns exact totals when telemetry coverage is complete", async () => {
  const hubRoot = await tempRoot("cpb-provider-usage-complete");
  for (const totalTokens of [75, 125]) {
    await _internalAppendUsageLine(hubRoot, {
      providerKey: "codex",
      status: "ok",
      usage: {
        calls: 1,
        totalTokens,
        costUsd: 0.01,
        tokenSource: "codex_session_rollout_delta",
      },
    });
  }

  const providers = await readProviderUsageRollup(hubRoot);
  assert.equal(providers.codex.tokens, 200);
  assert.equal(providers.codex.reportedTokens, 200);
  assert.equal(providers.codex.tokenCoverage, 1);
  assert.equal(providers.codex.costUsd, 0.02);
  assert.equal(providers.codex.costCoverage, 1);

  const system = await readSystemUsageRollup(hubRoot);
  assert.equal(system.totalTokens, 200);
  assert.equal(system.tokenCoverage, 1);
  assert.equal(system.totalCostUsd, 0.02);
});

test("agent routing metrics join executor outcomes to independent verifier results without resource telemetry", async () => {
  const hubRoot = await tempRoot("cpb-agent-routing-metrics");
  for (let index = 0; index < 16; index += 1) {
    const jobId = `job-${index}`;
    await _internalAppendUsageLine(hubRoot, {
      jobId,
      taskCategory: "bugfix",
      phase: "execute",
      role: "executor",
      providerKey: "codex:gpt-5",
      agent: "codex",
      status: index === 15 ? "timeout" : "ok",
      phaseStatus: index === 15 ? "failed" : "passed",
      failureKind: index === 15 ? "timeout" : null,
      isRetry: index >= 14,
      retryCount: index >= 14 ? 1 : 0,
      durationMs: 100 + index,
      usage: { calls: 1, totalTokens: 1000, costUsd: 1 },
    });
    await _internalAppendUsageLine(hubRoot, {
      jobId,
      taskCategory: "bugfix",
      phase: index % 2 === 0 ? "verify" : "adversarial_verify",
      role: "verifier",
      providerKey: "claude:sonnet",
      agent: "claude",
      status: index >= 13 ? "error" : "ok",
      phaseStatus: index >= 13 ? "failed" : "passed",
      failureKind: index >= 13 ? "verification_failed" : null,
      usage: { calls: 1, totalTokens: 500, costUsd: 0.5 },
    });
  }

  const metrics = await readAgentRoutingMetrics(hubRoot, {
    phase: "execute",
    role: "executor",
    taskCategory: "bugfix",
  });
  const codex = metrics.agents.codex;
  assert.equal(codex.scope, "task_category_phase_role");
  assert.equal(codex.scopeConfidence, 1);
  assert.equal(codex.sampleSize, 16);
  assert.equal(codex.successes, 15);
  assert.equal(codex.retries, 2);
  assert.equal(codex.timeouts, 1);
  assert.equal(codex.verifierRuns, 16);
  assert.equal(codex.verifierPasses, 13);
  assert.equal(codex.evidenceCoverage, 1);
  assert.equal(codex.providerFamily, "codex");
  assert.deepEqual(codex.failureKinds, { timeout: 1 });
  assert.equal("tokens" in codex, false);
  assert.equal("costUsd" in codex, false);
  assert.equal("usage" in codex, false);
});

test("category-sparse routing history is explicitly confidence-discounted", async () => {
  const hubRoot = await tempRoot("cpb-agent-routing-category-sparse");
  for (let index = 0; index < 12; index += 1) {
    await _internalAppendUsageLine(hubRoot, {
      jobId: `docs-${index}`,
      taskCategory: "docs",
      phase: "execute",
      role: "executor",
      providerKey: "codex",
      agent: "codex",
      status: "ok",
      phaseStatus: "passed",
    });
  }

  const metrics = await readAgentRoutingMetrics(hubRoot, {
    phase: "execute",
    role: "executor",
    taskCategory: "security",
  });
  assert.equal(metrics.agents.codex.scope, "phase_role");
  assert.equal(metrics.agents.codex.scopeConfidence, 0.5);
});
