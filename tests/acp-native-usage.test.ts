import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  captureNativeUsageCursor,
  readNativeUsageDelta,
} from "../server/services/acp/native-usage.js";
import { readAcpUsageFromAudit } from "../server/services/acp/acp-pool.js";
import { tempRoot } from "./helpers.js";

function tokenCount({
  input,
  cached,
  output,
  reasoning,
  total,
}: {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}) {
  return JSON.stringify({
    timestamp: "2026-07-12T00:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: total,
        },
      },
    },
  });
}

test("Codex native usage fallback reports the exact cumulative rollout delta", async () => {
  const home = await tempRoot("cpb-native-usage-home");
  const sessions = path.join(home, ".codex", "sessions", "2026", "07", "12");
  const rollout = path.join(sessions, "rollout-test.jsonl");
  await mkdir(sessions, { recursive: true });
  await writeFile(rollout, `${tokenCount({ input: 100, cached: 60, output: 20, reasoning: 4, total: 120 })}\n`, "utf8");

  const cursor = await captureNativeUsageCursor("codex", { HOME: home, CODEX_HOME: path.join(home, ".codex") });
  await appendFile(rollout, `${tokenCount({ input: 150, cached: 90, output: 35, reasoning: 7, total: 185 })}\n`, "utf8");
  const usage = await readNativeUsageDelta(cursor);

  assert.deepEqual(usage, {
    inputTokens: 50,
    cachedInputTokens: 30,
    outputTokens: 15,
    reasoningOutputTokens: 3,
    totalTokens: 65,
    costUsd: null,
    toolCalls: null,
    functionCalls: null,
    events: 1,
    tokenSource: "codex_session_rollout_delta",
  });
});

test("Codex native usage fallback handles a session created after the prompt cursor", async () => {
  const home = await tempRoot("cpb-native-usage-new-session");
  const cursor = await captureNativeUsageCursor("codex", { HOME: home, CODEX_HOME: path.join(home, ".codex") });
  const sessions = path.join(home, ".codex", "sessions", "2026", "07", "12");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    path.join(sessions, "rollout-new.jsonl"),
    `${tokenCount({ input: 42, cached: 10, output: 8, reasoning: 2, total: 50 })}\n`,
    "utf8",
  );

  const usage = await readNativeUsageDelta(cursor);
  assert.equal(usage?.inputTokens, 42);
  assert.equal(usage?.outputTokens, 8);
  assert.equal(usage?.totalTokens, 50);
  assert.equal(usage?.tokenSource, "codex_session_rollout_delta");
});

test("native usage fallback refuses to inspect a shared CODEX_HOME outside isolated HOME", async () => {
  const home = await tempRoot("cpb-native-usage-isolated");
  const shared = await tempRoot("cpb-native-usage-shared");
  const cursor = await captureNativeUsageCursor("codex", { HOME: home, CODEX_HOME: shared });
  assert.equal(cursor, null);
  assert.equal(await captureNativeUsageCursor("claude", { HOME: home }), null);
});

test("ACP usage rollup preserves unavailable cost as null instead of fabricating zero", async () => {
  const root = await tempRoot("cpb-native-usage-audit");
  const audit = path.join(root, "audit.jsonl");
  await writeFile(audit, `${JSON.stringify({
    event: "prompt_usage",
    phase: "verify",
    role: "verifier",
    usage: {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
      reasoningOutputTokens: 2,
      totalTokens: 110,
      costUsd: null,
      toolCalls: null,
      functionCalls: null,
      events: 1,
      tokenSource: "codex_session_rollout_delta",
    },
  })}\n`, "utf8");

  const usage = await readAcpUsageFromAudit(audit, { phase: "verify", role: "verifier" });
  assert.equal(usage?.totalTokens, 110);
  assert.equal(usage?.costUsd, null);
  assert.equal(usage?.functionCalls, null);
  assert.equal(usage?.toolCalls, 0);
  assert.equal(usage?.tokenSource, "acp_audit_prompt_usage:codex_session_rollout_delta");
});
