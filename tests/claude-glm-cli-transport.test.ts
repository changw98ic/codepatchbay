import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
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
  }), 18);
  assert.equal(resolveClaudePlanningMaxTurns({
    repositoryDiscovery: true,
    structuredOutput: true,
    toolCallBudget: 60,
  }), 24);
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
  }), 4);
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
    assert.ok(captured.args.includes("--max-turns"));
    assert.equal(captured.args[captured.args.indexOf("--max-turns") + 1], "8");
    assert.ok(captured.args.includes("--json-schema"));
    const plannerSchema = JSON.parse(captured.args[captured.args.indexOf("--json-schema") + 1]);
    assert.deepEqual(plannerSchema.required, ["status", "proposal"]);
    assert.ok(plannerSchema.properties.proposal.properties.decomposedItems);
    assert.equal(captured.args[captured.args.indexOf("--tools") + 1], "Read,Glob,Grep");
    const planningSettings = JSON.parse(captured.args[captured.args.indexOf("--settings") + 1]);
    assert.deepEqual(planningSettings.permissions.allow, ["Read", "Glob", "Grep"]);
    assert.equal(planningSettings.sandbox.enabled, true);
    assert.ok(!planningSettings.sandbox.filesystem.allowWrite.includes(root));
    assert.equal(captured.maxThinkingTokens, "12000");
    assert.equal(captured.maxOutputTokens, "20000");
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
    assert.equal(criticCapture.maxThinkingTokens, "24000");
    assert.equal(criticCapture.maxOutputTokens, "32000");
    assert.equal(criticCapture.args[criticCapture.args.indexOf("--max-turns") + 1], "4");
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
    assert.equal(criticRepairCapture.maxThinkingTokens, "24000");
    assert.equal(criticRepairCapture.maxOutputTokens, "32000");

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
