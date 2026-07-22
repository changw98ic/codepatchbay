import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AcpPool,
  claudeStructuredOutputCandidates,
  claudePlanningJsonSchemaForRole,
  normalizeClaudeApiRetryEvent,
  normalizeClaudeCliToolAuditEvents,
  resolveClaudePlanningMaxTurns,
} from "../server/services/acp/acp-pool.js";
import { buildPhaseAcpEnv } from "../core/phases/phase-env.js";
import { isDelegateAlive } from "../server/services/quota-delegate-client.js";
import { tempRoot } from "./helpers.js";

const FAKE_GLM_PROVIDER_ENV = {
  ZHIPU_BASE_URL: "https://glm.example.invalid/anthropic",
  ZHIPU_API_KEY: "test-only-glm-key",
  ZHIPU_MODEL: "glm-test",
};

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for quota delegate");
}

async function readAuditEvents(file: string) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

test("Claude API retry normalization locks the native 2.1.168 stream schema", () => {
  assert.deepEqual(normalizeClaudeApiRetryEvent({
    type: "system",
    subtype: "api_retry",
    attempt: 3,
    max_retries: 10,
    retry_delay_ms: 2012.9626456412584,
    error_status: 529,
    error: "overloaded",
    session_id: "session-1",
    uuid: "retry-1",
  }), {
    attempt: 3,
    maxRetries: 10,
    retryDelayMs: 2012.9626456412584,
    httpStatus: 529,
    error: "overloaded",
    sessionId: "session-1",
    uuid: "retry-1",
  });
  assert.equal(normalizeClaudeApiRetryEvent({
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 3000,
    error_status: 429,
    error: "rate_limit",
  })?.httpStatus, 429);
  assert.equal(normalizeClaudeApiRetryEvent({
    type: "system",
    subtype: "api_retry",
    attempt: 2,
    error_status: null,
    error: "connection_error",
  })?.httpStatus, null);
  assert.equal(normalizeClaudeApiRetryEvent({
    type: "system",
    subtype: "status",
    status: "requesting",
  }), null);
});

test("Claude CLI tool-use records normalize into ACP-compatible trace events", () => {
  assert.deepEqual(normalizeClaudeCliToolAuditEvents({
    type: "assistant",
    session_id: "session-1",
    message: {
      content: [{
        type: "tool_use",
        id: "call-1",
        name: "Bash",
        input: { command: "PYTHONPATH=. python -c \"assert True\"" },
      }],
    },
  }), [{
    event: "tool_call",
    toolCallId: "call-1",
    title: "PYTHONPATH=. python -c \"assert True\"",
    status: "in_progress",
    kind: "execute",
    toolName: "Bash",
    sessionId: "session-1",
  }]);
  assert.deepEqual(normalizeClaudeCliToolAuditEvents({
    type: "user",
    session_id: "session-1",
    message: {
      content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false, content: "ok" }],
    },
  }), [{
    event: "tool_call",
    toolCallId: "call-1",
    status: "completed",
    sessionId: "session-1",
  }]);
  assert.equal(normalizeClaudeCliToolAuditEvents({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "call-2", is_error: true }] },
  })[0]?.status, "failed");
});

test("Claude structured output candidates and risk-derived planning turns are deterministic", () => {
  assert.deepEqual(claudeStructuredOutputCandidates({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "target.ts" } },
        { type: "tool_use", name: "StructuredOutput", input: { status: "ok", proposal: { proposalId: "B" } } },
      ],
    },
  }), ['{"status":"ok","proposal":{"proposalId":"B"}}']);
  assert.equal(resolveClaudePlanningMaxTurns({
    repositoryDiscovery: true,
    structuredOutput: true,
    toolCallBudget: 40,
  }), 0);
  assert.equal(resolveClaudePlanningMaxTurns({
    repositoryDiscovery: true,
    structuredOutput: true,
    toolCallBudget: 60,
  }), 0);
  assert.equal(resolveClaudePlanningMaxTurns({
    configured: "7",
    repositoryDiscovery: true,
    structuredOutput: true,
    toolCallBudget: 80,
  }), 7);
  assert.equal(resolveClaudePlanningMaxTurns({
    repositoryDiscovery: false,
    structuredOutput: true,
    toolCallBudget: 80,
  }), 0);
});

test("Claude planning schemas follow plan-tournament roles and repair suffixes", () => {
  const plannerSchema = JSON.parse(JSON.stringify(claudePlanningJsonSchemaForRole("planner_b")));
  assert.match(JSON.stringify(plannerSchema), /"proposal"/);
  const plannerItemSchema = plannerSchema.properties.proposal.properties.decomposedItems.items;
  assert.ok(plannerItemSchema.required.includes("observableContract"));
  assert.deepEqual(
    plannerItemSchema.properties.observableContract.required,
    [
      "observationKind", "probeInput", "expectedObservation", "forbiddenObservations",
      "oracleSourceRefs", "candidateIndependent",
    ],
  );
  assert.deepEqual(
    plannerItemSchema.properties.observableContract.properties.observationKind.enum,
    ["exact_text", "contains_text", "state_transition", "invariant"],
  );
  assert.deepEqual(
    plannerItemSchema.properties.observableContract.properties.candidateIndependent.enum,
    [true],
  );
  assert.match(JSON.stringify(claudePlanningJsonSchemaForRole("planner_b_contract_repair_1")), /"proposalId"/);
  assert.match(JSON.stringify(claudePlanningJsonSchemaForRole("revision_a_round_1")), /"decomposedItems"/);
  assert.match(JSON.stringify(claudePlanningJsonSchemaForRole("critic_b_round_1")), /"critique"/);
  assert.match(JSON.stringify(claudePlanningJsonSchemaForRole("plan_arbiter")), /"arbitration"/);
  assert.equal(claudePlanningJsonSchemaForRole("ordinary_plan"), null);
});

test("claude-glm uses the bounded Claude CLI transport instead of ACP session bootstrap", async () => {
  const root = await tempRoot("cpb-claude-glm-cli");
  const command = path.join(root, "fake-claude.mjs");
  const capture = path.join(root, "capture.json");
  const installedProject = path.join(root, "runtime-deps", "project_pkg");
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const planning = args.includes("--json-schema");
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args,
  prompt,
  maxThinkingTokens: process.env.MAX_THINKING_TOKENS,
  maxOutputTokens: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "GLM_PLAN_OK",
  ...(planning ? { structured_output: { status: "ok" } } : {}),
  session_id: "session-1",
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }
}));
setTimeout(() => {}, 30000);
`, "utf8");
  await chmod(command, 0o755);

  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      CPB_AGENT_FS_BOUNDARY_JSON: JSON.stringify({
        schemaVersion: 1,
        homeDenyRoot: path.dirname(root),
        projectPackageNames: ["project_pkg"],
        dependencyReadRoots: [path.dirname(installedProject)],
        denyReadPaths: [installedProject],
      }),
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    const request = (jobId: string) => pool.execute("claude-glm", "plan this ordinary task", root, 30_000, {
      projectId: "project-1",
      jobId,
      phase: "plan",
      role: "planner_b",
      dataRoot: path.join(root, "runtime"),
    });
    const [result, concurrentResult] = await Promise.all([request("job-1"), request("job-2")]);
    assert.equal(result.output, '{"status":"ok"}');
    assert.equal(concurrentResult.output, '{"status":"ok"}');
    const captured = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(captured.prompt, "plan this ordinary task");
    assert.ok(captured.args.includes("--bare"));
    assert.ok(captured.args.includes("dontAsk"));
    assert.ok(captured.args.includes("stream-json"));
    assert.ok(captured.args.includes("low"));
    assert.ok(!captured.args.includes("--max-turns"));
    assert.ok(captured.args.includes("--json-schema"));
    const plannerSchema = JSON.parse(captured.args[captured.args.indexOf("--json-schema") + 1]);
    assert.deepEqual(plannerSchema.required, ["status", "proposal"]);
    assert.ok(plannerSchema.properties.proposal.properties.decomposedItems);
    assert.equal(captured.args[captured.args.indexOf("--tools") + 1], "Read,Glob,Grep");
    const planningSettings = JSON.parse(captured.args[captured.args.indexOf("--settings") + 1]);
    assert.deepEqual(planningSettings.permissions.allow, ["Read", "Glob", "Grep"]);
    assert.equal(planningSettings.sandbox.enabled, true);
    assert.ok(!planningSettings.sandbox.filesystem.allowWrite.includes(root));
    assert.equal(captured.maxThinkingTokens, undefined);
    assert.equal(captured.maxOutputTokens, undefined);
    assert.ok(!captured.args.includes("claude-agent-acp"));
    assert.equal(result.usage.totalTokens, 18);
    assert.equal(result.usage.tokenSource, "acp_audit_prompt_usage:claude_cli_result");
    assert.match(
      await readFile(path.join(root, "runtime", "acp-streams", "job-1", "planner_b.jsonl"), "utf8"),
      /"type":"result"/,
    );

    await pool.execute("claude-glm", "critique the frozen plans", root, 30_000, {
      projectId: "project-1",
      jobId: "job-critic",
      phase: "plan",
      role: "critic_b_round_1",
      dataRoot: path.join(root, "runtime"),
    });
    const criticCapture = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(criticCapture.maxThinkingTokens, undefined);
    assert.equal(criticCapture.maxOutputTokens, undefined);
    assert.ok(!criticCapture.args.includes("--max-turns"));
    assert.equal(criticCapture.args[criticCapture.args.indexOf("--tools") + 1], "");
    const criticSchema = JSON.parse(criticCapture.args[criticCapture.args.indexOf("--json-schema") + 1]);
    assert.deepEqual(criticSchema.required, ["status", "critique"]);

    await pool.execute("claude-glm", "repair the critique contract", root, 30_000, {
      projectId: "project-1",
      jobId: "job-critic-repair",
      phase: "plan",
      role: "critic_b_round_1_contract_repair_1",
      dataRoot: path.join(root, "runtime"),
    });
    const criticRepairCapture = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(criticRepairCapture.maxThinkingTokens, undefined);
    assert.equal(criticRepairCapture.maxOutputTokens, undefined);

    const executeResult = await pool.execute("claude-glm", "implement this ordinary task", root, 30_000, {
      projectId: "project-1",
      jobId: "job-execute",
      phase: "execute",
      role: "executor",
      dataRoot: path.join(root, "runtime"),
    });
    assert.equal(executeResult.output, "GLM_PLAN_OK");
    const executeCapture = JSON.parse(await readFile(capture, "utf8"));
    assert.ok(executeCapture.args.includes("dontAsk"));
    assert.ok(!executeCapture.args.includes("bypassPermissions"));
    const settings = JSON.parse(executeCapture.args[executeCapture.args.indexOf("--settings") + 1]);
    assert.equal(executeCapture.args[executeCapture.args.indexOf("--setting-sources") + 1], "user");
    assert.ok(!executeCapture.args.includes("--bare"));
    assert.equal(executeCapture.args[executeCapture.args.indexOf("--tools") + 1], "Read,Edit,Write,Glob,Grep,Bash");
    assert.equal(settings.sandbox.enabled, true);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.ok(settings.sandbox.filesystem.denyRead.includes(installedProject));
    assert.ok(settings.sandbox.filesystem.allowRead.includes(root));
    assert.ok(settings.permissions.allow.includes("Bash"));
    assert.ok(!settings.permissions.deny.includes("Bash"));
    assert.ok(settings.permissions.deny.some((rule: string) => rule.includes("project_pkg")));
    assert.equal(settings.hooks.PreToolUse[0].matcher, "Read|Edit|Write|Bash");
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].args, undefined);
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /claude-path-guard\.js/);
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await pool.stop();
  }
});

test("claude-glm recovers the last complete StructuredOutput candidate when max turns ends on tool_use", async () => {
  const root = await tempRoot("cpb-claude-glm-structured-recovery");
  const command = path.join(root, "fake-claude.mjs");
  await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
const emit = (id, input) => console.log(JSON.stringify({
  type: "assistant",
  session_id: "session-recovery",
  message: { content: [{ type: "tool_use", id, name: "StructuredOutput", input }] }
}));
emit("structured-1", { status: "ok", proposal: { proposalId: "B", version: 1 } });
emit("structured-2", { status: "ok", proposal: { proposalId: "B", version: 2 } });
console.log(JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  stop_reason: "tool_use",
  num_turns: 3,
  structured_output: null,
  session_id: "session-recovery",
  total_cost_usd: 0.02,
  usage: { input_tokens: 11, cache_read_input_tokens: 2, output_tokens: 7 }
}));
`, "utf8");
  await chmod(command, 0o755);

  const runtimeRoot = path.join(root, "runtime");
  const auditFile = path.join(runtimeRoot, "acp-audit", "project-1", "job-recovery.jsonl");
  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    const result = await pool.execute("claude-glm", "return a proposal", root, 30_000, {
      projectId: "project-1",
      jobId: "job-recovery",
      phase: "plan",
      role: "planner_b",
      dataRoot: runtimeRoot,
    });
    assert.equal(result.output, '{"status":"ok","proposal":{"proposalId":"B","version":2}}');
    assert.equal(result.usage.totalTokens, 20);
    const events = await readAuditEvents(auditFile);
    const recovered = events.find((event) => event.event === "structured_output_recovered");
    assert.equal(recovered?.source, "assistant.tool_use");
    assert.equal(recovered?.structuredOutputCandidateCount, 2);
    assert.equal(recovered?.selectedCandidateIndex, 2);
    assert.equal(recovered?.resultSubtype, "error_max_turns");
    assert.equal(recovered?.stopReason, "tool_use");
    assert.equal(typeof recovered?.candidateSha256, "string");
    assert.equal(
      events.find((event) => event.event === "session_close")?.reason,
      "structured_output_recovered",
    );
  } finally {
    await pool.stop();
  }
});

test("claude-glm maps max-turn planning without StructuredOutput to a traced retryable tool budget failure", async () => {
  const root = await tempRoot("cpb-claude-glm-max-turn-no-candidate");
  const command = path.join(root, "fake-claude.mjs");
  await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  stop_reason: "tool_use",
  num_turns: 5,
  structured_output: null,
  session_id: "session-no-candidate",
  usage: { input_tokens: 5, output_tokens: 1 }
}));
`, "utf8");
  await chmod(command, 0o755);

  const runtimeRoot = path.join(root, "runtime");
  const auditFile = path.join(runtimeRoot, "acp-audit", "project-1", "job-no-candidate.jsonl");
  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      CPB_CLAUDE_PLAN_MAX_TURNS: "5",
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    await assert.rejects(
      pool.execute("claude-glm", "return a proposal", root, 30_000, {
        projectId: "project-1",
        jobId: "job-no-candidate",
        phase: "plan",
        role: "planner_b",
        dataRoot: runtimeRoot,
      }),
      /tool_budget_exceeded:.*maxTurns=5.*without a recoverable StructuredOutput candidate/,
    );
    const events = await readAuditEvents(auditFile);
    const exhausted = events.find((event) => event.event === "planning_turn_budget_exhausted");
    assert.equal(exhausted?.structuredOutputCandidateCount, 0);
    assert.equal(exhausted?.recoverableCandidate, false);
    assert.equal(exhausted?.maxTurns, 5);
  } finally {
    await pool.stop();
  }
});

test("claude-glm planning enforces a local streamed-text budget when the compatible endpoint ignores output limits", async () => {
  const root = await tempRoot("cpb-claude-glm-output-budget");
  const command = path.join(root, "fake-claude.mjs");
  await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(1100) } }
}));
setTimeout(() => {}, 30000);
`, "utf8");
  await chmod(command, 0o755);

  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      CPB_CLAUDE_PLAN_MAX_TEXT_CHARS: "1000",
      CPB_CLAUDE_PLAN_MAX_THINKING_TOKENS: "1000",
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      pool.execute("claude-glm", "return JSON", root, 30_000, {
        projectId: "project-1",
        jobId: "job-budget",
        phase: "plan",
        role: "planner_b",
        dataRoot: path.join(root, "runtime"),
      }),
      /agent_output_budget_exceeded/,
    );
    assert.ok(Date.now() - startedAt < 20_000);
    assert.match(
      await readFile(path.join(root, "runtime", "acp-audit", "project-1", "job-budget.jsonl"), "utf8"),
      /"event":"output_budget_exceeded"/,
    );

    await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({
  type: "system",
  subtype: "thinking_tokens",
  estimated_tokens: 1100,
  estimated_tokens_delta: 1100
}));
setTimeout(() => {}, 30000);
`, "utf8");
    await assert.rejects(
      pool.execute("claude-glm", "return JSON", root, 30_000, {
        projectId: "project-1",
        jobId: "job-thinking-budget",
        phase: "plan",
        role: "critic_b_round_1",
        dataRoot: path.join(root, "runtime"),
      }),
      /thinkingTokens=1100\/1000/,
    );
  } finally {
    await pool.stop();
  }
});

test("claude-glm abort terminates the active Claude CLI child and rejects AbortError", async () => {
  const root = await tempRoot("cpb-claude-glm-abort");
  const command = path.join(root, "fake-claude.mjs");
  await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
setInterval(() => {}, 1000);
`, "utf8");
  await chmod(command, 0o755);

  const controller = new AbortController();
  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  let childPid: number | null = null;
  try {
    const execution = pool.execute("claude-glm", "return JSON", root, 30_000, {
      projectId: "project-1",
      jobId: "job-abort",
      phase: "plan",
      role: "planner_b",
      dataRoot: path.join(root, "runtime"),
      signal: controller.signal,
    });

    await waitFor(async () => pool.oneShotChildren.size === 1, 2_000);
    childPid = [...pool.oneShotChildren][0].pid || null;
    controller.abort();

    await assert.rejects(execution, isAbortError);
    await waitFor(async () => {
      if (!childPid) return true;
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 2_000);
    assert.equal(pool.oneShotChildren.size, 0);
  } finally {
    if (childPid) {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    await pool.stop();
  }
});

test("claude-glm yields an overloaded provider to CPB after a bounded number of CLI-internal retries", async (t) => {
  const root = await tempRoot("cpb-claude-glm-api-retry-budget");
  const hubRoot = path.join(root, "hub");
  const delegateScript = fileURLToPath(new URL("../server/services/quota-delegate.js", import.meta.url));
  let delegateOutput = "";
  const delegate = spawn(process.execPath, [delegateScript, "--hub-root", hubRoot], {
    cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url)), ".."),
    env: { ...process.env, CPB_HUB_ROOT: hubRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  delegate.stdout.on("data", (chunk) => { delegateOutput += String(chunk); });
  delegate.stderr.on("data", (chunk) => { delegateOutput += String(chunk); });
  t.after(() => {
    if (delegate.pid) delegate.kill("SIGTERM");
  });
  await waitFor(async () => {
    if (delegate.exitCode !== null) {
      throw new Error(`quota delegate exited early with ${delegate.exitCode}: ${delegateOutput}`);
    }
    return isDelegateAlive(hubRoot);
  });
  const command = path.join(root, "fake-claude.mjs");
  await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({
  type: "system",
  subtype: "status",
  status: "requesting"
}));
console.log(JSON.stringify({
  type: "system",
  subtype: "api_retry",
  error_status: 529,
  error: "overloaded",
  attempt: 1,
  max_retries: 10,
  retry_delay_ms: 500,
  session_id: "session-1",
  uuid: "retry-1"
}));
console.log(JSON.stringify({
  type: "system",
  subtype: "api_retry",
  error_status: 529,
  error: "overloaded",
  attempt: 2,
  max_retries: 10,
  retry_delay_ms: 1000,
  session_id: "session-1",
  uuid: "retry-2"
}));
setTimeout(() => {}, 30000);
`, "utf8");
  await chmod(command, 0o755);

  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot,
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      CPB_CLAUDE_MAX_INTERNAL_API_RETRIES: "2",
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    const startedAt = Date.now();
    await assert.rejects(
      pool.execute("claude-glm", "return JSON", root, 30_000, {
        projectId: "project-1",
        jobId: "job-api-retry-budget",
        phase: "plan",
        role: "planner_b",
        dataRoot: path.join(root, "runtime"),
      }),
      /529|rate limit|quota/i,
    );
    assert.ok(Date.now() - startedAt < 20_000);
    assert.match(
      await readFile(path.join(root, "runtime", "acp-audit", "project-1", "job-api-retry-budget.jsonl"), "utf8"),
      /"event":"provider_retry_exhausted"/,
    );
    assert.match(
      await readFile(path.join(root, "runtime", "acp-audit", "project-1", "job-api-retry-budget.jsonl"), "utf8"),
      /"event":"provider_api_retry".*"providerMaxRetries":10/,
    );
  } finally {
    await pool.stop();
  }
});

test("claude-glm execute stops after the frozen no-edit read/search limit", async () => {
  const root = await tempRoot("cpb-claude-glm-no-edit-limit");
  const command = path.join(root, "fake-claude.mjs");
  await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
for (let index = 1; index <= 9; index += 1) {
  console.log(JSON.stringify({
    type: "assistant",
    session_id: "session-no-edit",
    message: {
      content: [{
        type: "tool_use",
        id: \`read-\${index}\`,
        name: index % 2 === 0 ? "Grep" : "Read",
        input: index % 2 === 0
          ? { pattern: \`pattern-\${index}\`, path: "." }
          : { file_path: \`file-\${index}.ts\` }
      }]
    }
  }));
}
setInterval(() => console.log(JSON.stringify({ type: "system", subtype: "status", status: "working" })), 10);
`, "utf8");
  await chmod(command, 0o755);

  const runtimeRoot = path.join(root, "runtime");
  const auditFile = path.join(runtimeRoot, "acp-audit", "project-1", "job-no-edit-limit.jsonl");
  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "8",
      CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS: "5000",
      CPB_ACP_TOOL_CALL_BUDGET_EXECUTE: "50",
      CPB_ACP_TOOL_EVENT_BUDGET_EXECUTE: "100",
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    await assert.rejects(
      pool.execute("claude-glm", "implement the task", root, 3_000, {
        projectId: "project-1",
        jobId: "job-no-edit-limit",
        phase: "execute",
        role: "executor",
        dataRoot: runtimeRoot,
      }),
      /execute_no_edit_progress.*limit 8/,
    );
    const events = await readAuditEvents(auditFile);
    const launch = events.find((event) => event.event === "agent_launch");
    const runtimeGuards = launch?.runtimeGuards as Record<string, unknown>;
    assert.equal(runtimeGuards.executeNoEditToolLimit, 8);
    assert.equal(runtimeGuards.toolCallBudget, 50);
    assert.equal(runtimeGuards.toolEventBudget, 100);
    const blocked = events.find((event) => event.event === "tool_blocked");
    assert.equal(blocked?.classification, "execute_no_edit_progress");
    assert.equal(blocked?.noEditToolCount, 9);
  } finally {
    await pool.stop();
  }
});

test("claude-glm execute disarms the no-edit guard after an edit tool starts", async () => {
  const root = await tempRoot("cpb-claude-glm-no-edit-satisfied");
  const command = path.join(root, "fake-claude.mjs");
  await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
const emitTool = (id, name, input) => console.log(JSON.stringify({
  type: "assistant",
  session_id: "session-edited",
  message: { content: [{ type: "tool_use", id, name, input }] }
}));
for (let index = 1; index <= 8; index += 1) emitTool(\`read-before-\${index}\`, "Read", { file_path: \`before-\${index}.ts\` });
emitTool("edit-1", "Edit", { file_path: "target.ts", old_string: "old", new_string: "new" });
for (let index = 1; index <= 9; index += 1) emitTool(\`read-after-\${index}\`, "Read", { file_path: \`after-\${index}.ts\` });
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "EDITED_OK",
  session_id: "session-edited",
  usage: { input_tokens: 1, output_tokens: 1 }
}));
`, "utf8");
  await chmod(command, 0o755);

  const runtimeRoot = path.join(root, "runtime");
  const auditFile = path.join(runtimeRoot, "acp-audit", "project-1", "job-edited.jsonl");
  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "8",
      CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS: "100",
      CPB_ACP_TOOL_CALL_BUDGET_EXECUTE: "30",
      CPB_ACP_TOOL_EVENT_BUDGET_EXECUTE: "60",
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    const result = await pool.execute("claude-glm", "implement the task", root, 30_000, {
      projectId: "project-1",
      jobId: "job-edited",
      phase: "execute",
      role: "executor",
      dataRoot: runtimeRoot,
    });
    assert.equal(result.output, "EDITED_OK");
    const events = await readAuditEvents(auditFile);
    assert.equal(events.some((event) => event.event === "tool_blocked"), false);
  } finally {
    await pool.stop();
  }
});

test("claude-glm no-edit idle timeout is independent of provider thinking activity", async () => {
  const root = await tempRoot("cpb-claude-glm-no-edit-idle");
  const command = path.join(root, "fake-claude.mjs");
  await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
console.log(JSON.stringify({
  type: "assistant",
  session_id: "session-idle",
  message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "target.ts" } }] }
}));
setInterval(() => console.log(JSON.stringify({ type: "system", subtype: "thinking_tokens", estimated_tokens: 1 })), 10);
`, "utf8");
  await chmod(command, 0o755);

  const runtimeRoot = path.join(root, "runtime");
  const auditFile = path.join(runtimeRoot, "acp-audit", "project-1", "job-no-edit-idle.jsonl");
  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      CPB_ACP_IDLE_TIMEOUT_MS: "1000",
      CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "8",
      CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS: "75",
      CPB_ACP_TOOL_CALL_BUDGET_EXECUTE: "50",
      CPB_ACP_TOOL_EVENT_BUDGET_EXECUTE: "100",
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    await assert.rejects(
      pool.execute("claude-glm", "implement the task", root, 3_000, {
        projectId: "project-1",
        jobId: "job-no-edit-idle",
        phase: "execute",
        role: "executor",
        dataRoot: runtimeRoot,
      }),
      /execute_no_edit_progress.*idle for 75ms/,
    );
    const events = await readAuditEvents(auditFile);
    const blocked = events.find((event) => event.event === "tool_blocked");
    assert.equal(blocked?.noEditIdleTimeoutMs, 75);
    assert.equal(blocked?.noEditToolCount, 1);
  } finally {
    await pool.stop();
  }
});

test("claude-glm execute enforces normalized tool-call and tool-event budgets", async () => {
  for (const budgetKind of ["call", "event"] as const) {
    const root = await tempRoot(`cpb-claude-glm-${budgetKind}-budget`);
    const command = path.join(root, "fake-claude.mjs");
    await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
const emitTool = (id) => console.log(JSON.stringify({
  type: "assistant",
  session_id: "session-budget",
  message: { content: [{ type: "tool_use", id, name: "Grep", input: { pattern: id, path: "." } }] }
}));
emitTool("grep-1");
${budgetKind === "call" ? "emitTool(\"grep-2\");" : `console.log(JSON.stringify({
  type: "user",
  session_id: "session-budget",
  message: { content: [{ type: "tool_result", tool_use_id: "grep-1", is_error: false, content: "ok" }] }
}));`}
setInterval(() => {}, 1000);
`, "utf8");
    await chmod(command, 0o755);

    const runtimeRoot = path.join(root, "runtime");
    const jobId = `job-${budgetKind}-budget`;
    const auditFile = path.join(runtimeRoot, "acp-audit", "project-1", `${jobId}.jsonl`);
    const pool = new AcpPool({
      cpbRoot: path.join(root, "cpb"),
      hubRoot: path.join(root, "hub"),
      env: {
        ...process.env,
        CPB_AGENT_SANDBOX: "off",
        CPB_AGENT_ISOLATE_HOME: "0",
        CPB_CLAUDE_CLI_COMMAND: command,
        CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "0",
        CPB_ACP_TOOL_CALL_BUDGET_EXECUTE: budgetKind === "call" ? "1" : "10",
        CPB_ACP_TOOL_EVENT_BUDGET_EXECUTE: budgetKind === "call" ? "10" : "1",
        ...FAKE_GLM_PROVIDER_ENV,
      },
    });
    try {
      await assert.rejects(
        pool.execute("claude-glm", "implement the task", root, 3_000, {
          projectId: "project-1",
          jobId,
          phase: "execute",
          role: "executor",
          dataRoot: runtimeRoot,
        }),
        budgetKind === "call" ? /tool_budget_exceeded/ : /tool_event_budget_exceeded/,
      );
      const events = await readAuditEvents(auditFile);
      assert.equal(
        events.some((event) => event.event === (budgetKind === "call" ? "tool_budget_exceeded" : "tool_event_budget_exceeded")),
        true,
      );
    } finally {
      await pool.stop();
    }
  }
});

test("claude-glm adversarial_verify terminates when phase tool-call budget is exceeded", async () => {
  const root = await tempRoot("cpb-claude-glm-adversarial-budget");
  const command = path.join(root, "fake-claude.mjs");
  await writeFile(command, `#!/usr/bin/env node
for await (const _chunk of process.stdin) {}
const emitTool = (id) => console.log(JSON.stringify({
  type: "assistant",
  session_id: "session-adversarial-budget",
  message: { content: [{ type: "tool_use", id, name: "Grep", input: { pattern: id, path: "." } }] }
}));
emitTool("grep-1");
emitTool("grep-2");
setInterval(() => {}, 1000);
`, "utf8");
  await chmod(command, 0o755);

  const runtimeRoot = path.join(root, "runtime");
  const jobId = "job-adversarial-budget";
  const auditFile = path.join(runtimeRoot, "acp-audit", "project-1", `${jobId}.jsonl`);
  const adversarialEnv = buildPhaseAcpEnv({
    env: {
      CPB_ACP_TOOL_CALL_BUDGET_ADVERSARIAL_VERIFY: "1",
      CPB_ACP_TOOL_EVENT_BUDGET_ADVERSARIAL_VERIFY: "10",
    },
    sourceContext: {
      riskMap: {
        riskLevel: "medium",
        adversarialRequired: true,
      },
    },
  }, "adversarial_verify");
  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    await assert.rejects(
      pool.execute("claude-glm", "attack the frozen evidence", root, 3_000, {
        projectId: "project-1",
        jobId,
        phase: "adversarial_verify",
        role: "adversarial_verifier",
        dataRoot: runtimeRoot,
        env: adversarialEnv,
      }),
      /tool_budget_exceeded/,
    );
    const events = await readAuditEvents(auditFile);
    const launch = events.find((event) => event.event === "agent_launch");
    const runtimeGuards = launch?.runtimeGuards as Record<string, unknown>;
    assert.equal(runtimeGuards.toolCallBudget, 1);
    assert.equal(runtimeGuards.toolEventBudget, 10);
    const blocked = events.find((event) => event.event === "tool_budget_exceeded");
    assert.equal(blocked?.toolCallBudget, 1);
    assert.equal(blocked?.normalizedToolCalls, 2);
  } finally {
    await pool.stop();
  }
});

test("claude-glm adversarial_verify reads the frozen phase snapshot without workspace write shortcuts", async () => {
  const root = await tempRoot("cpb-claude-glm-adversarial-snapshot-guard");
  const runtimeRoot = path.join(root, "runtime");
  const snapshotPath = path.join(runtimeRoot, "phase-io", "adversarial_verify", "snapshot.json");
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, JSON.stringify({ snapshot: true }), "utf8");
  const command = path.join(root, "fake-claude.mjs");
  const capture = path.join(root, "capture.json");
  await writeFile(command, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const snapshot = readFileSync(${JSON.stringify(snapshotPath)}, "utf8");
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args,
  settings,
  snapshot,
  providerArgs: process.env.CPB_ACP_CLAUDE_GLM_ARGS,
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ADVERSARIAL_SNAPSHOT_OK",
  session_id: "session-adversarial-snapshot",
}));
setTimeout(() => {}, 30000);
`, "utf8");
  await chmod(command, 0o755);

  const phaseSnapshotGlob = `${runtimeRoot}/phase-io/adversarial_verify/*`;
  const installedProject = path.join(root, "runtime-deps", "project_pkg");
  const adversarialEnv = buildPhaseAcpEnv({
    env: {
      CPB_ACP_WRITE_ALLOW: phaseSnapshotGlob,
      CPB_ACP_CLAUDE_GLM_ARGS: JSON.stringify(["--disallowedTools", "Bash,Edit,Write,MultiEdit"]),
      CPB_AGENT_FS_BOUNDARY_JSON: JSON.stringify({
        schemaVersion: 1,
        homeDenyRoot: path.dirname(root),
        projectPackageNames: ["project_pkg"],
        dependencyReadRoots: [path.dirname(installedProject)],
        denyReadPaths: [installedProject],
      }),
    },
    sourceContext: {
      riskMap: {
        riskLevel: "medium",
        adversarialRequired: true,
      },
    },
  }, "adversarial_verify");
  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    const result = await pool.execute("claude-glm", "read the frozen evidence snapshot", root, 3_000, {
      projectId: "project-1",
      jobId: "job-adversarial-snapshot",
      phase: "adversarial_verify",
      role: "adversarial_verifier",
      dataRoot: runtimeRoot,
      env: adversarialEnv,
    });
    assert.equal(result.output, "ADVERSARIAL_SNAPSHOT_OK");
    const captured = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(captured.snapshot, "{\"snapshot\":true}");
    assert.ok(captured.settings.sandbox.filesystem.allowWrite.some((entry: string) => entry.includes("phase-io/adversarial_verify")));
    assert.ok(captured.settings.sandbox.filesystem.allowRead.some((entry: string) => entry.includes("phase-io/adversarial_verify")));
    assert.ok(!captured.settings.permissions.allow.includes("Bash"));
    assert.ok(!captured.settings.permissions.allow.includes("Write"));
    assert.ok(!captured.settings.permissions.allow.includes("Edit"));
    assert.ok(captured.settings.permissions.deny.includes("Bash"));
    assert.ok(captured.settings.permissions.deny.includes("Write"));
    assert.ok(captured.settings.permissions.deny.includes("Edit"));
    assert.match(captured.providerArgs, /--disallowedTools/);
    assert.match(captured.providerArgs, /Bash,Edit,Write,MultiEdit/);
    assert.ok(!captured.settings.sandbox.filesystem.allowWrite.includes(root));
  } finally {
    await pool.stop();
  }
});

test("claude-glm writable verifier replay allows sandboxed Bash but denies direct mutation tools", async () => {
  const root = await tempRoot("cpb-claude-glm-verifier-replay-guard");
  const command = path.join(root, "fake-claude.mjs");
  const capture = path.join(root, "capture.json");
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args,
  settings: JSON.parse(args[args.indexOf("--settings") + 1]),
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "VERIFIER_REPLAY_GUARD_OK",
  session_id: "session-verifier-replay-guard",
}));
setTimeout(() => {}, 30000);
`, "utf8");
  await chmod(command, 0o755);

  const runtimeRoot = path.join(root, "runtime");
  const phaseOutputGlob = `${runtimeRoot}/phase-io/verify/*`;
  const replayEnv = buildPhaseAcpEnv({
    env: {
      CPB_ACP_WRITE_ALLOW: `${root},${phaseOutputGlob}`,
      CPB_VERIFIER_REPLAY_WORKSPACE_WRITE: "1",
      CPB_CODEX_VERIFIER_WORKSPACE_WRITE: "1",
      CPB_AGENT_FS_BOUNDARY_JSON: JSON.stringify({
        schemaVersion: 1,
        homeDenyRoot: path.dirname(root),
        projectPackageNames: [],
        dependencyReadRoots: [],
        denyReadPaths: [],
      }),
    },
    sourceContext: { riskMap: { riskLevel: "medium" } },
  }, "verify");
  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    const result = await pool.execute("claude-glm", "verify the disposable replay", root, 3_000, {
      projectId: "project-1",
      jobId: "job-verifier-replay-guard",
      phase: "verify",
      role: "verifier",
      dataRoot: runtimeRoot,
      env: replayEnv,
    });
    assert.equal(result.output, "VERIFIER_REPLAY_GUARD_OK");
    const captured = JSON.parse(await readFile(capture, "utf8"));
    const tools = captured.args[captured.args.indexOf("--tools") + 1];
    assert.equal(tools, "Read,Glob,Grep,Bash");
    assert.ok(captured.settings.permissions.allow.includes("Bash"));
    assert.ok(captured.settings.permissions.deny.includes("Edit"));
    assert.ok(captured.settings.permissions.deny.includes("Write"));
    assert.ok(captured.settings.permissions.deny.includes("MultiEdit"));
    assert.ok(!captured.settings.permissions.allow.includes("Edit"));
    assert.ok(!captured.settings.permissions.allow.includes("Write"));
    assert.ok(captured.settings.sandbox.filesystem.allowWrite.includes(root));
    assert.ok(captured.settings.sandbox.filesystem.allowWrite.some((entry: string) => entry.includes("phase-io/verify")));
  } finally {
    await pool.stop();
  }
});

test("claude-glm validation lanes preserve bounded commands and phase-only output writes", async () => {
  const root = await tempRoot("cpb-claude-glm-validation-guard");
  const command = path.join(root, "fake-claude.mjs");
  const capture = path.join(root, "capture.json");
  await writeFile(command, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
for await (const _chunk of process.stdin) {}
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  args,
  settings: JSON.parse(args[args.indexOf("--settings") + 1]),
}));
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "VALIDATION_GUARD_OK",
  session_id: "session-validation-guard",
}));
setTimeout(() => {}, 30000);
`, "utf8");
  await chmod(command, 0o755);

  const runtimeRoot = path.join(root, "runtime");
  const boundary = JSON.stringify({
    schemaVersion: 1,
    homeDenyRoot: path.dirname(root),
    projectPackageNames: [],
    dependencyReadRoots: [],
    denyReadPaths: [],
  });
  const pool = new AcpPool({
    cpbRoot: path.join(root, "cpb"),
    hubRoot: path.join(root, "hub"),
    env: {
      ...process.env,
      CPB_AGENT_SANDBOX: "off",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CLAUDE_CLI_COMMAND: command,
      ...FAKE_GLM_PROVIDER_ENV,
    },
  });
  try {
    const verifyRoot = `${runtimeRoot}/phase-io/verify/*`;
    const verifyEnv = buildPhaseAcpEnv({
      env: {
        CPB_ACP_WRITE_ALLOW: verifyRoot,
        CPB_AGENT_FS_BOUNDARY_JSON: boundary,
      },
      sourceContext: { riskMap: { riskLevel: "medium" } },
    }, "verify");
    const verifyResult = await pool.execute("claude-glm", "verify", root, 3_000, {
      projectId: "project-1",
      jobId: "job-validation-verify",
      phase: "verify",
      role: "verifier",
      dataRoot: runtimeRoot,
      env: verifyEnv,
    });
    assert.equal(verifyResult.output, "VALIDATION_GUARD_OK");
    const verifyCapture = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(verifyCapture.args[verifyCapture.args.indexOf("--tools") + 1], "Read,Write,Glob,Grep,Bash");
    assert.ok(verifyCapture.settings.permissions.allow.includes("Write"));
    assert.ok(verifyCapture.settings.permissions.allow.includes("Bash"));
    assert.ok(verifyCapture.settings.permissions.deny.includes("Edit"));
    assert.ok(verifyCapture.settings.permissions.deny.includes("MultiEdit"));
    assert.ok(!verifyCapture.settings.sandbox.filesystem.allowWrite.includes(root));
    assert.ok(verifyCapture.settings.sandbox.filesystem.allowWrite.some((entry: string) => entry.includes("phase-io/verify")));

    const reviewRoot = `${runtimeRoot}/phase-io/review/*`;
    const reviewEnv = buildPhaseAcpEnv({
      env: {
        CPB_ACP_WRITE_ALLOW: reviewRoot,
        CPB_AGENT_FS_BOUNDARY_JSON: boundary,
      },
      sourceContext: { riskMap: { riskLevel: "medium" } },
    }, "review");
    const reviewResult = await pool.execute("claude-glm", "review", root, 3_000, {
      projectId: "project-1",
      jobId: "job-validation-review",
      phase: "review",
      role: "reviewer",
      dataRoot: runtimeRoot,
      env: reviewEnv,
    });
    assert.equal(reviewResult.output, "VALIDATION_GUARD_OK");
    const reviewCapture = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(reviewCapture.args[reviewCapture.args.indexOf("--tools") + 1], "Read,Glob,Grep,Bash");
    assert.ok(reviewCapture.settings.permissions.allow.includes("Bash"));
    assert.ok(reviewCapture.settings.permissions.deny.includes("Write"));
    assert.ok(reviewCapture.settings.permissions.deny.includes("Edit"));
    assert.ok(!reviewCapture.settings.sandbox.filesystem.allowWrite.includes(root));
  } finally {
    await pool.stop();
  }
});
