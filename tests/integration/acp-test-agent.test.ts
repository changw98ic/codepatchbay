import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { tempRoot } from "../helpers.js";
import { runAgent } from "../../core/agents/agent-runner.js";
import { AcpPool, poolClientKey, readAcpUsageFromAudit, resolvePoolWaitTimeoutMs } from "../../server/services/acp/acp-pool.js";
import { buildAcpPoolEnv } from "../../core/policy/child-env.js";
import { AcpClient, resolveAgentCommand } from "../../server/services/acp/acp-client.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const acpClient = path.join(repoRoot, "server", "services", "acp", "acp-client.js");
const testAgent = path.join(repoRoot, "tests", "fixtures", "test-acp-agent.js");

type ClientRunResult = {
  stdout: string;
  stderr: string;
};

type ProcessExitStatus = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

async function runClient(prompt, testAgentArgs = [], envOverrides = {}) {
  return new Promise<ClientRunResult>((resolve, reject) => {
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

test("ACP terminal commands launch through RTK when available", async () => {
  const tmp = await tempRoot("cpb-acp-rtk-terminal");
  const binDir = path.join(tmp, "bin");
  const rtkPath = path.join(binDir, "rtk");
  const auditPath = path.join(tmp, "audit.jsonl");
  await mkdir(binDir, { recursive: true });
  await symlink("/bin/echo", rtkPath);

  const client = new AcpClient({
    agent: "fake-acp",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || ""}`,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_RTK_ENABLED: "1",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  const created = await client.createTerminal({
    command: process.execPath,
    args: ["-e", "process.stdout.write('terminal-ok')"],
    cwd: tmp,
    outputByteLimit: 4096,
  });
  const exitStatus = await client.waitForTerminalExit({ terminalId: created.terminalId });
  assert.deepEqual(exitStatus, { exitCode: 0, signal: null });
  assert.equal(
    client.terminalOutput({ terminalId: created.terminalId }).output.trim(),
    `${process.execPath} -e process.stdout.write('terminal-ok')`,
  );

  const events = await readJsonl(auditPath);
  const launch = events.find((event) => event.event === "terminal_launch");
  assert.equal(launch?.command, process.execPath);
  assert.equal(launch?.launchCommand, "rtk");
  assert.equal(launch?.rtkEnabled, true);
});

test("ACP client close terminates registered terminal processes", async () => {
  const tmp = await tempRoot("cpb-acp-terminal-cleanup");
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_RTK_ENABLED: "0",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  const created = await client.createTerminal({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: tmp,
    outputByteLimit: 4096,
  });
  const terminal = client.terminals.get(created.terminalId);
  const exited = new Promise<ProcessExitStatus>((resolve) => {
    terminal.child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  await client.close();
  const exitStatus = await Promise.race([
    exited,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("terminal did not exit after client close")), 2_000);
      timer.unref();
    }),
  ]);

  assert.equal(client.terminals.has(created.terminalId), false);
  assert.ok(["SIGTERM", "SIGKILL"].includes(exitStatus.signal), JSON.stringify(exitStatus));
});

test("AcpPool passes job metadata and reports the automatic ACP audit file", async () => {
  const tmp = await tempRoot("cpb-acp-pool-audit");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const dataRoot = path.join(tmp, "project-runtime");
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
      CPB_PROJECT_RUNTIME_ROOT: dataRoot,
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

test("AcpPool waits indefinitely for provider slots by default", async () => {
  const tmp = await tempRoot("cpb-acp-pool-wait-default");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });

  assert.equal(resolvePoolWaitTimeoutMs(undefined), 0);
  assert.equal(resolvePoolWaitTimeoutMs(""), 0);
  assert.equal(resolvePoolWaitTimeoutMs("1200"), 1200);

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    providerConnectionLimit: 1,
  });

  const first = await pool.acquire("codex");
  const second = pool.acquire("codex");

  try {
    const stillQueued = await Promise.race([
      second.then(() => false, () => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 25)),
    ]);
    assert.equal(stillQueued, true);

    first.release();
    const acquired = await second;
    acquired.release();
  } finally {
    first.release();
    await pool.stop();
  }
});

test("AcpPool still honors explicit provider slot wait timeouts", async () => {
  const tmp = await tempRoot("cpb-acp-pool-wait-timeout");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    providerConnectionLimit: 1,
  });

  const first = await pool.acquire("codex");
  try {
    await assert.rejects(
      pool.acquire("codex", { waitTimeoutMs: 10 }),
      /ACP pool exhausted: codex\/codex waited/,
    );
  } finally {
    first.release();
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

test("runAgent passes cwd while persistent ACP process keys stay reusable", async () => {
  const cwd = path.join(repoRoot, ".tmp-worktree");
  let observed = null;
  const pool = {
    async execute(agent, prompt, execCwd, timeoutMs, options) {
      observed = { agent, prompt, execCwd, timeoutMs, options };
      return { output: "ok", providerKey: "fake-acp", variant: null };
    },
  };

  const result = await runAgent({
    role: "executor",
    agent: "fake-acp",
    variant: null,
    project: "proj",
    jobId: "job-run-agent-cwd",
    prompt: "hello",
    cwd,
    pool,
    timeoutMs: 123,
    scope: { workspaceId: "workspace-a", policyHash: "policy-a" },
    env: {},
  });

  assert.equal(result.ok, true);
  assert.equal(observed.execCwd, cwd);
  assert.equal(observed.options.cwd, cwd);
  assert.equal(
    poolClientKey("fake-acp", { role: "executor", projectId: "proj", cwd: "/tmp/worktree-a" }),
    poolClientKey("fake-acp", { role: "executor", projectId: "proj", cwd: "/tmp/worktree-b" }),
  );
  assert.notEqual(
    poolClientKey("codex", { projectId: "proj", cwd: "/tmp/worktree-a", processCwd: "/tmp/worktree-a" }),
    poolClientKey("codex", { projectId: "proj", cwd: "/tmp/worktree-b", processCwd: "/tmp/worktree-b" }),
  );
});

test("AcpPool persistent ACP reuses one provider process while keeping per-job audit files", async () => {
  const tmp = await tempRoot("cpb-acp-persistent");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const dataRoot = path.join(tmp, "project-runtime");
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
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "1",
      CPB_PROJECT_RUNTIME_ROOT: dataRoot,
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

test("AcpPool closeProvider worktree release frees persistent provider lease", async () => {
  const tmp = await tempRoot("cpb-acp-persistent-phase-release");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const worktree = path.join(tmp, "worktree");
  const scenarioPath = path.join(tmp, "scenario.json");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({
      responses: [
        { match: "first phase", output: "first-phase-response" },
        { match: "second phase", output: "second-phase-response" },
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
      CPB_ACP_RTK_ENABLED: "0",
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
    const first = await pool.execute("fake-acp", "first phase", worktree, 10_000, {
      projectId: "proj",
      jobId: "job-phase-one",
      phase: "plan",
      role: "planner",
    });

    assert.equal(first.output, "first-phase-response");
    assert.equal(pool.persistentClients.size, 1);

    const released = await pool.releaseWorktree(worktree, "phase_plan_complete", { closeProvider: true });
    assert.equal(released, true);
    assert.equal(pool.persistentClients.size, 0);
    assert.equal(pool.activeProviders.get("fake-acp") || 0, 0);

    const second = await pool.execute("fake-acp", "second phase", worktree, 10_000, {
      projectId: "proj",
      jobId: "job-phase-two",
      phase: "execute",
      role: "executor",
    });

    assert.equal(second.output, "second-phase-response");
    const transcript = await readJsonl(transcriptPath);
    assert.equal(transcript.filter((event) => event.event === "initialize").length, 2);
    assert.equal(transcript.filter((event) => event.event === "session/new").length, 2);
  } finally {
    await pool.stop();
  }
});

test("AcpPool persistent ACP reuses the provider process across isolated worktrees", async () => {
  const tmp = await tempRoot("cpb-acp-persistent-cwd");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const dataRoot = path.join(tmp, "project-runtime");
  const firstWorktree = path.join(tmp, "worktree-a");
  const secondWorktree = path.join(tmp, "worktree-b");
  const scenarioPath = path.join(tmp, "scenario.json");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await mkdir(firstWorktree, { recursive: true });
  await mkdir(secondWorktree, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({
      responses: [
        { match: "first worktree", output: "first-cwd-response" },
        { match: "second worktree", output: "second-cwd-response" },
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
      CPB_PROJECT_RUNTIME_ROOT: dataRoot,
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
    const first = await pool.execute("fake-acp", "first worktree prompt", firstWorktree, 10_000, {
      projectId: "proj",
      jobId: "job-cwd-one",
      phase: "execute",
      role: "executor",
    });
    const persistent = [...pool.persistentClients.values()][0];
    const createdTerminal = await persistent.client.createTerminal({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: firstWorktree,
      outputByteLimit: 4096,
    });
    const terminal = persistent.client.terminals.get(createdTerminal.terminalId);
    const terminalExited = new Promise<ProcessExitStatus>((resolve) => {
      terminal.child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const released = await pool.releaseWorktree(firstWorktree);
    const second = await pool.execute("fake-acp", "second worktree prompt", secondWorktree, 10_000, {
      projectId: "proj",
      jobId: "job-cwd-two",
      phase: "execute",
      role: "executor",
    });

    assert.equal(first.output, "first-cwd-response");
    assert.equal(released, true);
    assert.equal(persistent.client.terminals.has(createdTerminal.terminalId), false);
    const terminalExitStatus = await Promise.race([
      terminalExited,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("terminal node did not exit after worktree release")), 2_000);
        timer.unref();
      }),
    ]);
    assert.ok(["SIGTERM", "SIGKILL"].includes(terminalExitStatus.signal), JSON.stringify(terminalExitStatus));
    assert.equal(second.output, "second-cwd-response");

    const transcript = await readJsonl(transcriptPath);
    assert.equal(transcript.filter((event) => event.event === "initialize").length, 1);
    assert.equal(transcript.filter((event) => event.event === "session/new").length, 2);
    assert.equal(transcript.filter((event) => event.event === "session/close").length, 1);
    assert.equal(transcript.filter((event) => event.event === "session/prompt").length, 2);

    const firstAudit = await readJsonl(first.acpAuditFile);
    const secondAudit = await readJsonl(second.acpAuditFile);
    assert.ok(firstAudit.some((event) => event.event === "session_close" && event.reason === "worktree_release"));
    assert.ok(firstAudit.some((event) => event.event === "terminal_cleanup" && event.reason === "worktree_release"));
    assert.ok(secondAudit.some((event) => event.event === "session_new"));
    assert.ok(secondAudit.every((event) => event.event !== "session_reuse"));
  } finally {
    await pool.stop();
  }
});
