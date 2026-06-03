import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { tempRoot } from "./helpers.mjs";
import { AcpPool, readAcpUsageFromAudit } from "../server/services/acp-pool.js";
import { buildAcpPoolEnv } from "../core/policy/child-env.js";
import { resolveAgentCommand } from "../runtime/acp-client-core.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const acpClient = path.join(repoRoot, "runtime", "acp-client.mjs");
const testAgent = path.join(repoRoot, "bridges", "test-acp-agent.mjs");

async function runClient(prompt, testAgentArgs = [], envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [acpClient, "--agent", "fake-acp", "--cwd", repoRoot], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CPB_AGENT_ISOLATE_HOME: "0",
        CPB_CODEGRAPH_ENABLED: "0",
        CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
        CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([testAgent, ...testAgentArgs]),
        ...envOverrides,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`ACP client timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ACP client exited code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
    child.stdin.end(prompt);
  });
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("configurable ACP test agent streams direct custom response", async () => {
  const result = await runClient("say something deterministic", ["--response", "deterministic-response"]);

  assert.equal(result.stdout, "deterministic-response");
  assert.equal(result.stderr, "");
});

test("configurable ACP test agent can write scenario artifacts through ACP fs tools", async () => {
  const tmp = await tempRoot("cpb-acp-test-agent");
  const outputPath = path.join(tmp, "artifact.md");
  const scenarioPath = path.join(tmp, "scenario.json");
  await writeFile(
    scenarioPath,
    JSON.stringify({
      responses: [
        {
          match: "artifact.md",
          output: "wrote artifact",
          writes: [
            {
              pathRegex: "Write artifact to:\\s*(.+)$",
              content: "# Artifact\n\nPrompt: {{prompt}}\n",
            },
          ],
        },
      ],
    }),
    "utf8",
  );

  const result = await runClient(`Write artifact to: ${outputPath}`, ["--scenario-file", scenarioPath]);

  assert.equal(result.stdout, "wrote artifact");
  assert.equal(
    await readFile(outputPath, "utf8"),
    `# Artifact\n\nPrompt: Write artifact to: ${outputPath}\n`,
  );
});

test("ACP client audits codegraph MCP injection and tool call updates", async () => {
  const tmp = await tempRoot("cpb-acp-audit");
  const auditPath = path.join(tmp, "audit.jsonl");
  const scenarioPath = path.join(tmp, "scenario.json");
  await writeFile(
    scenarioPath,
    JSON.stringify({
      responses: [
        {
          output: "audited-response",
          toolCalls: [
            {
              toolCallId: "cg-lookup-1",
              title: "mcp__codegraph__codegraph_context",
              status: "completed",
            },
          ],
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18,
          },
        },
      ],
    }),
    "utf8",
  );

  const result = await runClient("use codegraph first", ["--scenario-file", scenarioPath], {
    CPB_CODEGRAPH_ENABLED: "1",
    CPB_CODEGRAPH_PORT: "43101",
    CPB_ACP_AUDIT_FILE: auditPath,
    CPB_ACP_PROJECT: "proj",
    CPB_ACP_JOB_ID: "job-acp-audit",
    CPB_ACP_PHASE: "plan",
    CPB_ACP_ROLE: "planner",
  });

  assert.equal(result.stdout, "audited-response");
  const events = await readJsonl(auditPath);
  const sessionNewRequest = events.find((event) => event.event === "session_new_request");
  assert.deepEqual(sessionNewRequest?.mcpServers?.[0], {
    name: "codegraph",
    type: "stdio",
    url: null,
    command: "codegraph",
    args: ["serve", "--mcp", "--path", repoRoot],
  });
  assert.ok(
    events.some((event) =>
      event.event === "session_new" &&
      Array.isArray(event.mcpServerNames) &&
      event.mcpServerNames.includes("codegraph")
    ),
    "session_new audit should record codegraph MCP injection",
  );
  assert.ok(
    events.some((event) =>
      event.event === "tool_call" &&
      event.toolCallId === "cg-lookup-1" &&
      /codegraph/.test(event.title || "")
    ),
    "tool_call audit should record the codegraph tool call",
  );
  assert.ok(
    events.some((event) =>
      event.event === "token_usage" &&
      event.usage?.inputTokens === 11 &&
      event.usage?.outputTokens === 7 &&
      event.usage?.totalTokens === 18
    ),
    "token_usage audit should record ACP usage updates",
  );
  assert.ok(
    events.some((event) =>
      event.event === "prompt_usage" &&
      event.usage?.inputTokens === 11 &&
      event.usage?.outputTokens === 7 &&
      event.usage?.totalTokens === 18
    ),
    "prompt_usage audit should record per-prompt usage delta",
  );
});

test("Codex ACP receives direct codegraph stdio config instead of shared SSE bridge", async () => {
  const tmp = await tempRoot("cpb-codex-codegraph-direct");
  const { args } = await resolveAgentCommand("codex", {
    ...process.env,
    CPB_ACP_CODEX_COMMAND: "codex-acp",
    CPB_ACP_CODEX_ARGS: "[]",
    CPB_AGENT_ISOLATE_HOME: "0",
    CPB_CODEGRAPH_ENABLED: "1",
    CPB_PROJECT_PATH_OVERRIDE: tmp,
  });

  const launchConfig = new Map();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-c" || !args[i + 1]) continue;
    const [key, ...valueParts] = args[i + 1].split("=");
    launchConfig.set(key, valueParts.join("="));
  }

  assert.equal(launchConfig.get("mcp_servers.codegraph.command"), JSON.stringify("codegraph"));
  assert.deepEqual(
    JSON.parse(launchConfig.get("mcp_servers.codegraph.args")),
    ["serve", "--mcp", "--path", tmp],
  );
  assert.ok(!args.some((arg) => /supergateway|--sse/.test(String(arg))));
});

test("AcpPool passes job metadata and reports the automatic ACP audit file", async () => {
  const tmp = await tempRoot("cpb-acp-pool-audit");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const scenarioPath = path.join(tmp, "scenario.json");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({
      responses: [
        {
          output: "pool-audited-response",
          toolCalls: [
            {
              toolCallId: "cg-pool-lookup",
              title: "mcp__codegraph__codegraph_context",
              status: "completed",
            },
          ],
          usage: {
            inputTokens: 13,
            cachedInputTokens: 2,
            outputTokens: 5,
            totalTokens: 18,
          },
        },
      ],
    }),
    "utf8",
  );

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "1",
      CPB_CODEGRAPH_PORT: "43101",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([testAgent, "--scenario-file", scenarioPath]),
    },
  });

  try {
    const result = await pool.execute("fake-acp", "use codegraph first", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-pool-audit",
      phase: "plan",
      role: "planner",
    });

    assert.equal(result.output, "pool-audited-response");
    assert.equal(result.usage.inputTokens, 13);
    assert.equal(result.usage.cachedInputTokens, 2);
    assert.equal(result.usage.outputTokens, 5);
    assert.equal(result.usage.totalTokens, 18);
    assert.equal(result.usage.toolCalls, 1);
    assert.match(result.acpAuditFile, /job-pool-audit\.jsonl$/);
    const events = await readJsonl(result.acpAuditFile);
    assert.ok(events.every((event) => event.project === "proj" && event.jobId === "job-pool-audit"));
    assert.ok(events.some((event) => event.event === "session_new" && event.mcpServerNames.includes("codegraph")));
    assert.ok(events.some((event) => event.event === "tool_call" && event.toolCallId === "cg-pool-lookup"));
  } finally {
    await pool.stop();
  }
});

test("AcpPool ignores removed total connection cap and only reports provider limits", async () => {
  const tmp = await tempRoot("cpb-acp-provider-only");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const removedPoolTotalKey = ["CPB_ACP_POOL", "TOTAL"].join("_");
  const removedPoolTotalOption = ["totalConnection", "Limit"].join("");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });

  const env = buildAcpPoolEnv({
    ...process.env,
    [removedPoolTotalKey]: "1",
    CPB_ACP_POOL_PROVIDER_MAX: "7",
  });
  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env,
    [removedPoolTotalOption]: 1,
  });

  try {
    const status = pool.status();
    assert.equal(Object.hasOwn(env, removedPoolTotalKey), false);
    assert.equal(Object.hasOwn(status.connectionLimits, "total"), false);
    assert.equal(status.connectionLimits.providerDefault, 7);
  } finally {
    await pool.stop();
  }
});

test("ACP audit usage rollup can be scoped to a single phase", async () => {
  const tmp = await tempRoot("cpb-acp-usage-scope");
  const auditPath = path.join(tmp, "audit.jsonl");
  await writeFile(
    auditPath,
    [
      { event: "prompt_usage", phase: "planner", role: "planner", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, tokenSource: "usage", events: 1 } },
      { event: "prompt_usage", phase: "executor", role: "executor", usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28, tokenSource: "usage", events: 1 } },
      { event: "prompt_usage", phase: "verifier", role: "verifier", usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42, tokenSource: "usage", events: 1 } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );

  const executorUsage = await readAcpUsageFromAudit(auditPath, {
    phase: "executor",
    role: "executor",
  });

  assert.equal(executorUsage.inputTokens, 20);
  assert.equal(executorUsage.outputTokens, 8);
  assert.equal(executorUsage.totalTokens, 28);
  assert.equal(executorUsage.events, 1);
});

test("AcpPool persistent ACP reuses one provider process while keeping per-job audit files", async () => {
  const tmp = await tempRoot("cpb-acp-persistent");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const scenarioPath = path.join(tmp, "scenario.json");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({
      responses: [
        {
          output: "persistent-response",
          toolCalls: [
            {
              title: "mcp__codegraph__codegraph_context",
              status: "completed",
            },
          ],
          usage: {
            inputTokens: 17,
            outputTokens: 3,
            totalTokens: 20,
          },
        },
      ],
    }),
    "utf8",
  );

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "1",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgent,
        "--scenario-file",
        scenarioPath,
        "--transcript-file",
        transcriptPath,
      ]),
    },
  });

  try {
    const first = await pool.execute("fake-acp", "first persistent prompt", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-persistent-one",
      phase: "execute",
      role: "executor",
    });
    const second = await pool.execute("fake-acp", "second persistent prompt", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-persistent-two",
      phase: "execute",
      role: "executor",
    });

    assert.equal(first.output, "persistent-response");
    assert.equal(second.output, "persistent-response");
    assert.equal(first.usage.totalTokens, 20);
    assert.equal(second.usage.totalTokens, 20);
    assert.match(first.acpAuditFile, /job-persistent-one\.jsonl$/);
    assert.match(second.acpAuditFile, /job-persistent-two\.jsonl$/);

    const transcript = await readJsonl(transcriptPath);
    assert.equal(transcript.filter((event) => event.event === "initialize").length, 1);
    assert.equal(transcript.filter((event) => event.event === "session/new").length, 1);
    assert.equal(transcript.filter((event) => event.event === "session/prompt").length, 2);

    const firstAudit = await readJsonl(first.acpAuditFile);
    const secondAudit = await readJsonl(second.acpAuditFile);
    assert.ok(firstAudit.some((event) => event.event === "agent_launch"));
    assert.ok(firstAudit.some((event) => event.event === "session_new"));
    assert.ok(firstAudit.every((event) => event.jobId === "job-persistent-one"));
    assert.ok(secondAudit.some((event) => event.event === "session_reuse"));
    assert.ok(secondAudit.every((event) => event.event !== "session_new"));
    assert.ok(secondAudit.every((event) => event.jobId === "job-persistent-two"));
  } finally {
    await pool.stop();
  }
});
