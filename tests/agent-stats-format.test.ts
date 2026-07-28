import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeAgentStats, formatAgentStatsHuman } from "../server/services/trace/agent-stats-format.js";

test("summarizeAgentStats rolls up per-agent success rate from routing metrics", () => {
  const routingMetrics = [
    { agent: "codex", role: "verifier", successes: 18, retries: 2 },
    { agent: "codex", role: "planner", successes: 9, retries: 1 },
    { agent: "claude", role: "executor", successes: 7, retries: 3 },
  ];
  const summary = summarizeAgentStats({ routingMetrics, usageRollup: {} });
  // 按 agent 聚合:codex 27 成功/3 重试;claude 7/3
  const codex = summary.agents.find((a) => a.agent === "codex");
  assert.equal(codex.successes, 27);
  assert.equal(codex.retries, 3);
  const claude = summary.agents.find((a) => a.agent === "claude");
  assert.equal(claude.successes, 7);
});

test("formatAgentStatsHuman emits one line per agent with success rate", () => {
  const summary = summarizeAgentStats({
    routingMetrics: [{ agent: "codex", successes: 9, retries: 1 }],
    usageRollup: {},
  });
  const text = formatAgentStatsHuman(summary);
  assert.match(text, /codex/);
  assert.match(text, /9/); // successes 出现
});

test("empty metrics → empty summary, no throw", () => {
  const summary = summarizeAgentStats({ routingMetrics: [], usageRollup: {} });
  assert.deepEqual(summary.agents, []);
  assert.equal(formatAgentStatsHuman(summary).trim(), "");
});
