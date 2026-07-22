import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { tempRoot } from "../helpers.js";
import { runAgent } from "../../core/agents/agent-runner.js";
import { FailureKind } from "../../core/contracts/failure.js";
import { AcpPool, poolClientKey, readAcpUsageFromAudit, resolvePoolWaitTimeoutMs } from "../../server/services/acp/acp-pool.js";
import { buildAcpPoolEnv, buildChildEnv } from "../../core/policy/child-env.js";
import { AcpClient, resolveAgentCommand } from "../../server/services/acp/acp-client.js";
import { recordValue } from "../../core/contracts/types.js";
import {
  codexConfiguredSandboxModeForExecution,
  codexExecutionConfigArgs,
  codexSandboxEnforcementForExecution,
  codexSandboxModeForExecution,
} from "../../core/acp/policy.js";

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

async function runNodeEval(script: string, envOverrides: Record<string, string> = {}) {
  return new Promise<ClientRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`node eval timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
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
      else reject(new Error(`node eval exited code=${code} signal=${signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function sandboxTempEnv(root: string) {
  return {
    TMPDIR: root,
    TEMP: root,
    TMP: root,
  };
}

function killProcessTree(pid: number | null | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function processAlive(pid: number | null | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPredicate(predicate: () => boolean, timeoutMs: number, message: string) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
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
    CPB_ACP_IDLE_TIMEOUT_MS: "1234",
    CPB_ACP_SESSION_UPDATE_IDLE_TIMEOUT_MS: "5678",
    CPB_ACP_TOOL_CALL_BUDGET_PLAN: "9",
    CPB_ACP_TOOL_EVENT_BUDGET_PLAN: "19",
    CPB_TASK_PHASE_BUDGET_POLICY_JSON: JSON.stringify({
      source: "task_risk_policy",
      riskLevel: "high",
      verificationDepth: "strict",
      adversarialRequired: true,
      evidenceRequirements: ["canonical_command", "real_path_trace", "adversarial_verdict"],
      phases: { plan: { toolCallBudget: 9, toolEventBudget: 19, idleTimeoutMs: 1234 } },
      reasons: ["riskLevel=high"],
    }),
  });

  assert.equal(result.stdout, "audited-response");
  const events = await readJsonl(auditPath);
  const agentLaunch = events.find((event) => event.event === "agent_launch");
  assert.equal(agentLaunch?.runtimeGuards?.promptIdleTimeoutMs, 1234);
  assert.equal(agentLaunch?.runtimeGuards?.sessionUpdateIdleTimeoutMs, 5678);
  assert.equal(agentLaunch?.runtimeGuards?.toolCallBudget, 9);
  assert.equal(agentLaunch?.runtimeGuards?.toolEventBudget, 19);
  assert.equal(agentLaunch?.runtimeGuards?.taskRiskPolicy?.riskLevel, "high");
  assert.deepEqual(agentLaunch?.runtimeGuards?.taskRiskPolicy?.evidenceRequirements, ["canonical_command", "real_path_trace", "adversarial_verdict"]);
  const sessionNewRequest = events.find((event) => event.event === "session_new_request");
  assert.deepEqual(sessionNewRequest?.mcpServers?.[0], {
    name: "codegraph",
    type: "sse",
    url: "http://localhost:43101",
    command: null,
    args: null,
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

test("ACP live-preflight audit keeps MCP identity but omits launch arguments", async () => {
  const tmp = await tempRoot("cpb-acp-live-preflight-audit-redaction");
  const auditPath = path.join(tmp, "audit.jsonl");

  const result = await runClient("preflight", ["--response", "CPB_PROVIDER_PREFLIGHT_OK"], {
    CPB_CODEGRAPH_ENABLED: "1",
    CPB_ACP_AUDIT_FILE: auditPath,
    CPB_ACP_PROJECT: "cpb-provider-live-preflight",
    CPB_ACP_JOB_ID: "provider-preflight-planner-fake-acp",
    CPB_ACP_PHASE: "plan",
    CPB_ACP_ROLE: "planner",
    CPB_PROVIDER_PREFLIGHT_NONCE: "a".repeat(32),
  });

  assert.equal(result.stdout, "CPB_PROVIDER_PREFLIGHT_OK");
  const events = await readJsonl(auditPath);
  const summaries = events.flatMap((event) => Array.isArray(event.mcpServers) ? event.mcpServers : []);
  assert.ok(summaries.some((server) => server.name === "codegraph" && server.command === "codegraph"));
  assert.ok(summaries.every((server) => !Object.hasOwn(server, "args")));
  assert.ok(events.every((event) => event.correlationNonce === "a".repeat(32)));
});

test("ACP client audits and redacts session-close request errors", async () => {
  const tmp = await tempRoot("cpb-acp-session-close-error");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: tmp,
    prompt: "",
    reuseSession: true,
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_AGENT_SANDBOX: "off",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([testAgent, "--response", "close-error-response"]),
    },
  });

  try {
    await client.start();
    await client.promptOnce("open a reusable session", tmp);
    const originalRequest = client.request.bind(client);
    client.request = async (method, params) => {
      if (method === "session/close") throw new Error("Authorization: Bearer close-secret-token");
      return originalRequest(method, params);
    };

    await client.closeActiveSession("test_close_error", 100);
    const events = await readJsonl(auditPath);
    const closeError = events.find((event) => event.event === "session_close_error");
    assert.equal(closeError?.reason, "test_close_error");
    assert.match(String(closeError?.error), /\[REDACTED\]/);
    assert.doesNotMatch(String(closeError?.error), /close-secret-token/);
  } finally {
    await client.close();
  }
});

test("ACP client does not infer a session-update timeout from task identity", () => {
  const executeClient = new AcpClient({
    agent: "claude-glm",
    cwd: repoRoot,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_PHASE: "execute",
      CPB_ACP_IDLE_TIMEOUT_MS: "4321",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });
  const planClient = new AcpClient({
    agent: "codex",
    cwd: repoRoot,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_PHASE: "plan",
      CPB_ACP_IDLE_TIMEOUT_MS: "4321",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  assert.equal(executeClient.sessionUpdateIdleTimeoutMs, 0);
  assert.equal(planClient.sessionUpdateIdleTimeoutMs, 0);
  assert.equal(executeClient.executeNoEditIdleTimeoutMs, 0);
  assert.equal(planClient.executeNoEditIdleTimeoutMs, 0);
});

test("ACP client can configure a generic execute no-edit idle timeout", () => {
  const client = new AcpClient({
    agent: "claude-glm",
    cwd: repoRoot,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_PHASE: "execute",
      CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "5",
      CPB_ACP_IDLE_TIMEOUT_MS: "4321",
      CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS: "89",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  assert.equal(client.executeNoEditIdleTimeoutMs, 89);
});

test("Codex ACP receives direct codegraph stdio config outside session mcpServers", async () => {
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

test("Codex ACP launch config grants writes only to mutating phases or disposable verifier replays", () => {
  assert.equal(codexSandboxModeForExecution({ CPB_ACP_PHASE: "execute", CPB_ACP_ROLE: "executor" }), "workspace-write");
  assert.equal(codexSandboxModeForExecution({ CPB_ACP_PHASE: "remediate", CPB_ACP_ROLE: "remediator" }), "workspace-write");
  assert.equal(codexSandboxModeForExecution({ CPB_ACP_PHASE: "plan", CPB_ACP_ROLE: "executor" }), "read-only");
  assert.equal(codexSandboxModeForExecution({ CPB_ACP_PHASE: "verify", CPB_ACP_ROLE: "verifier" }), "read-only");
  assert.equal(codexSandboxModeForExecution({
    CPB_ACP_PHASE: "verify",
    CPB_ACP_ROLE: "verifier",
    CPB_CODEX_VERIFIER_WORKSPACE_WRITE: "1",
  }), "workspace-write");
  assert.equal(codexSandboxModeForExecution({
    CPB_ACP_PHASE: "verify",
    CPB_ACP_ROLE: "verifier",
    CPB_VERIFIER_REPLAY_WORKSPACE_WRITE: "1",
  }), "workspace-write");
  assert.equal(codexSandboxModeForExecution({
    CPB_ACP_PHASE: "plan",
    CPB_ACP_ROLE: "planner",
    CPB_VERIFIER_REPLAY_WORKSPACE_WRITE: "1",
  }), "read-only");
  assert.equal(codexSandboxModeForExecution({ CPB_ACP_ROLE: "executor" }), "workspace-write");

  assert.equal(codexSandboxEnforcementForExecution({ CPB_AGENT_SANDBOX: "required" }), "cpb-outer");
  assert.equal(codexSandboxEnforcementForExecution({ CPB_AGENT_SANDBOX: "off" }), "codex-inner");
  assert.equal(
    codexConfiguredSandboxModeForExecution({ CPB_ACP_PHASE: "execute", CPB_AGENT_SANDBOX: "required" }),
    "danger-full-access",
  );
  assert.equal(
    codexConfiguredSandboxModeForExecution({ CPB_ACP_PHASE: "execute", CPB_AGENT_SANDBOX: "off" }),
    "workspace-write",
  );

  assert.deepEqual(
    codexExecutionConfigArgs("codex-acp", [], { CPB_ACP_PHASE: "execute", CPB_AGENT_SANDBOX: "off" }),
    ["-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"'],
  );
  assert.deepEqual(
    codexExecutionConfigArgs("codex-acp", [], { CPB_ACP_PHASE: "review", CPB_AGENT_SANDBOX: "off" }),
    ["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'],
  );
  assert.deepEqual(
    codexExecutionConfigArgs("codex-acp", [], {
      CPB_ACP_PHASE: "verify",
      CPB_AGENT_SANDBOX_INHERITED: "1",
      CPB_VERIFIER_REPLAY_WORKSPACE_WRITE: "1",
      CPB_ACP_WRITE_ALLOW: "/runtime/phase-io/verify/*",
    }),
    [
      "-c", 'sandbox_mode="workspace-write"',
      "-c", 'approval_policy="never"',
    ],
  );
  assert.deepEqual(codexExecutionConfigArgs("node", [], { CPB_ACP_PHASE: "execute" }), []);

  const filesystemBoundary = JSON.stringify({
    schemaVersion: 1,
    homeDenyRoot: "/Users/tester",
    projectPackageNames: ["project_pkg"],
    dependencyReadRoots: ["/opt/python/site-packages"],
    denyReadPaths: ["/opt/python/site-packages/project_pkg"],
  });
  const executeBoundaryArgs = codexExecutionConfigArgs("codex-acp", [], {
    CPB_ACP_PHASE: "execute",
    CPB_AGENT_FS_BOUNDARY_JSON: filesystemBoundary,
    HOME: "/runtime/agent-home",
    CODEX_HOME: "/runtime/agent-home/.codex",
    TMPDIR: "/runtime/agent-home/.tmp",
  });
  assert.equal(executeBoundaryArgs[1], 'default_permissions="cpb_source_boundary"');
  assert.match(executeBoundaryArgs[3], /":workspace_roots"=\{"\."="write"\}/);
  assert.match(executeBoundaryArgs[3], /"\/opt\/python\/site-packages"="read"/);
  assert.match(executeBoundaryArgs[3], /"\/opt\/python\/site-packages\/project_pkg"="deny"/);
  assert.match(executeBoundaryArgs[3], /"\/runtime\/agent-home"="write"/);
  assert.match(executeBoundaryArgs[3], /"\/runtime\/agent-home\/\.codex"="write"/);
  assert.match(executeBoundaryArgs[3], /"\/runtime\/agent-home\/\.tmp"="write"/);
  assert.equal(executeBoundaryArgs.includes('sandbox_mode="workspace-write"'), false);

  const verifyBoundaryArgs = codexExecutionConfigArgs("codex-acp", [], {
    CPB_ACP_PHASE: "verify",
    CPB_AGENT_FS_BOUNDARY_JSON: filesystemBoundary,
  });
  assert.match(verifyBoundaryArgs[3], /":workspace_roots"=\{"\."="read"\}/);
});

test("resolved Codex ACP command pins the phase sandbox after inherited args", async () => {
  const { args } = await resolveAgentCommand("codex", {
    ...process.env,
    CPB_ACP_CODEX_COMMAND: "codex-acp",
    CPB_ACP_CODEX_ARGS: JSON.stringify(["-c", 'sandbox_mode="read-only"']),
    CPB_ACP_PHASE: "execute",
    CPB_ACP_ROLE: "executor",
    CPB_AGENT_SANDBOX: "required",
    CPB_CODEGRAPH_ENABLED: "0",
  });

  assert.equal(args.at(-4), "-c");
  assert.equal(args.at(-3), 'sandbox_mode="danger-full-access"');
  assert.equal(args.at(-2), "-c");
  assert.equal(args.at(-1), 'approval_policy="never"');
});

test("explicit empty ACP write allowlist remains deny-all across context updates", () => {
  const client = new AcpClient({
    agent: "codex",
    cwd: repoRoot,
    prompt: "",
    writeAllowPaths: [],
    env: { ...process.env, CPB_AGENT_ISOLATE_HOME: "0", CPB_CODEGRAPH_ENABLED: "0" },
  });

  assert.deepEqual(client.writeAllowPaths, []);
  assert.throws(() => client.validateWritePath(path.join(repoRoot, "blocked.txt")), /write path not allowed/);
  client.setAuditContext(client.env, { writeAllowPaths: [] });
  assert.deepEqual(client.writeAllowPaths, []);
  assert.throws(() => client.validateWritePath(path.join(repoRoot, "still-blocked.txt")), /write path not allowed/);
});

test("Codex ACP codegraph config prefers current ACP cwd over stale project override", async () => {
  const stale = await tempRoot("cpb-codex-codegraph-stale");
  const current = await tempRoot("cpb-codex-codegraph-current");
  const { args } = await resolveAgentCommand("codex", {
    ...process.env,
    CPB_ACP_CODEX_COMMAND: "codex-acp",
    CPB_ACP_CODEX_ARGS: "[]",
    CPB_AGENT_ISOLATE_HOME: "0",
    CPB_CODEGRAPH_ENABLED: "1",
    CPB_PROJECT_PATH_OVERRIDE: stale,
    CPB_ACP_CWD: current,
  });

  const launchConfig = new Map();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-c" || !args[i + 1]) continue;
    const [key, ...valueParts] = args[i + 1].split("=");
    launchConfig.set(key, valueParts.join("="));
  }

  assert.deepEqual(
    JSON.parse(launchConfig.get("mcp_servers.codegraph.args")),
    ["serve", "--mcp", "--path", current],
  );
});

test("Claude-compatible variant ACP args survive child env filtering", async () => {
  const denyTools = ["--disallowedTools", "Edit,Write,MultiEdit"];
  const env = buildChildEnv({
    ...process.env,
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    CPB_ACP_CLAUDE_MIMO_COMMAND: "claude-agent-acp",
    CPB_ACP_CLAUDE_MIMO_ARGS: JSON.stringify(denyTools),
  }, {}, { agent: "claude-mimo" });

  assert.equal(env.CPB_ACP_CLAUDE_MIMO_ARGS, JSON.stringify(denyTools));
  assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, "0");

  const { args } = await resolveAgentCommand("claude-mimo", env);
  assert.deepEqual(args, denyTools);
});

test("ACP pool env preserves generic exact-test and risk policies", () => {
  const env = buildAcpPoolEnv({
    CPB_ACP_DISABLE_WEB_TOOLS: "1",
    CPB_ACP_EXACT_TEST_COMMAND_GUARD: "1",
    CPB_CANONICAL_TEST_COMMANDS_JSON: JSON.stringify(["python3 -m pytest tests/test_example.py::test_case"]),
    CPB_DIAGNOSTIC_TEST_COMMANDS_JSON: JSON.stringify(["python3 -m pytest tests/test_example.py"]),
    CPB_ACP_TOOL_CALL_BUDGET_EXECUTE: "180",
    CPB_ACP_TOOL_EVENT_BUDGET_EXECUTE: "180",
    CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "8",
    CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS: "90000",
    CPB_TASK_RISK_LEVEL: "high",
    CPB_TASK_PHASE_BUDGET_POLICY_JSON: JSON.stringify({ riskLevel: "high" }),
  });

  assert.equal(env.CPB_ACP_DISABLE_WEB_TOOLS, "1");
  assert.equal(env.CPB_ACP_EXACT_TEST_COMMAND_GUARD, "1");
  assert.equal(env.CPB_CANONICAL_TEST_COMMANDS_JSON, JSON.stringify(["python3 -m pytest tests/test_example.py::test_case"]));
  assert.equal(env.CPB_DIAGNOSTIC_TEST_COMMANDS_JSON, JSON.stringify(["python3 -m pytest tests/test_example.py"]));
  assert.equal(env.CPB_ACP_TOOL_CALL_BUDGET_EXECUTE, "180");
  assert.equal(env.CPB_ACP_TOOL_EVENT_BUDGET_EXECUTE, "180");
  assert.equal(env.CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT, "8");
  assert.equal(env.CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS, "90000");
  assert.equal(env.CPB_TASK_RISK_LEVEL, "high");
  assert.equal(env.CPB_TASK_PHASE_BUDGET_POLICY_JSON, JSON.stringify({ riskLevel: "high" }));
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
  const exit = events.find((event) => event.event === "terminal_exit");
  assert.equal(launch?.command, process.execPath);
  assert.equal(launch?.launchCommand, "rtk");
  assert.equal(launch?.rtkEnabled, true);
  assert.equal(exit?.terminalId, created.terminalId);
  assert.equal(exit?.exitCode, 0);
  assert.equal(exit?.signal, null);
  assert.match(String(exit?.outputTail || ""), /terminal-ok/);
});

test("ACP terminal exit audit bounds and redacts captured output", async () => {
  const tmp = await tempRoot("cpb-acp-terminal-exit-audit");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_RTK_ENABLED: "0",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  const created = await client.createTerminal({
    command: process.execPath,
    args: ["-e", "process.stderr.write('x'.repeat(1200) + ' api_key=test-terminal-secret-value')"],
    cwd: tmp,
    outputByteLimit: 4096,
  });
  const status = await client.waitForTerminalExit({ terminalId: created.terminalId });
  assert.deepEqual(status, { exitCode: 0, signal: null });

  const events = await readJsonl(auditPath);
  const exit = events.find((event) => event.event === "terminal_exit");
  assert.ok(exit);
  assert.ok(String(exit.outputTail).length <= 1000);
  assert.match(String(exit.outputTail), /api_key=\[REDACTED\]/);
  assert.doesNotMatch(String(exit.outputTail), /test-terminal-secret-value/);
});

test("ACP terminal denies whole-filesystem find commands", async () => {
  const tmp = await tempRoot("cpb-acp-terminal-search-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_RTK_ENABLED: "0",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await assert.rejects(
    () => client.createTerminal({
      command: "/bin/zsh",
      args: ["-c", "find / -name \"*.json\" -path \"*django-11532*\" 2>/dev/null | head -20"],
      cwd: tmp,
    }),
    /whole-filesystem find is denied/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "terminal_blocked");
  assert.equal(blocked?.reason.includes("whole-filesystem find is denied"), true);
  assert.equal(client.terminals.size, 0);

  const allowed = await client.createTerminal({
    command: process.execPath,
    args: ["-e", "process.stdout.write('scoped-search-ok')"],
    cwd: tmp,
    outputByteLimit: 4096,
  });
  const status = await client.waitForTerminalExit({ terminalId: allowed.terminalId });
  assert.deepEqual(status, { exitCode: 0, signal: null });
});

test("ACP terminal denies mutating git commands in read-only phases", async () => {
  const tmp = await tempRoot("cpb-acp-terminal-readonly-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_PHASE: "verify",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await assert.rejects(
    () => client.createTerminal({
      command: "/bin/zsh",
      args: ["-c", "git stash -- django/db/models/fields/json.py && python3 -m pytest; git stash pop"],
      cwd: tmp,
    }),
    /read-only phase "verify" cannot run mutating terminal command \(git stash\)/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "terminal_blocked");
  assert.equal(blocked?.reason.includes("git stash"), true);
  assert.equal(client.terminals.size, 0);

  const readOnlyGit = await client.createTerminal({
    command: "/bin/zsh",
    args: ["-c", "git stash list >/dev/null 2>&1 || true"],
    cwd: tmp,
    outputByteLimit: 4096,
  });
  const readOnlyGitStatus = await client.waitForTerminalExit({ terminalId: readOnlyGit.terminalId });
  assert.deepEqual(
    readOnlyGitStatus,
    { exitCode: 0, signal: null },
    client.terminalOutput({ terminalId: readOnlyGit.terminalId }).output,
  );

  const allowed = await client.createTerminal({
    command: process.execPath,
    args: ["-e", "process.stdout.write('readonly-ok')"],
    cwd: tmp,
    outputByteLimit: 4096,
  });
  const status = await client.waitForTerminalExit({ terminalId: allowed.terminalId });
  assert.deepEqual(
    status,
    { exitCode: 0, signal: null },
    client.terminalOutput({ terminalId: allowed.terminalId }).output,
  );
});

test("ACP terminal exact-test policy denies commands outside the allowlist", async () => {
  const tmp = await tempRoot("cpb-acp-terminal-swebench-test-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const canonical = "PYTHONPATH=. python3 tests/runtests.py cache || true";
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_EXACT_TEST_COMMAND_GUARD: "1",
      CPB_CANONICAL_TEST_COMMANDS_JSON: JSON.stringify([canonical]),
      CPB_ACP_RTK_ENABLED: "0",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await assert.rejects(
    () => client.createTerminal({
      command: "/bin/zsh",
      args: ["-c", "PYTHONPATH=. python3 tests/runtests.py models || true"],
      cwd: tmp,
    }),
    /broad_test_command_denied/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "terminal_blocked");
  assert.equal(blocked?.classification, "broad_test_command_denied");
  assert.equal(String(blocked?.reason).includes("tests/runtests.py models"), true);
  assert.equal(client.terminals.size, 0);

  const allowed = await client.createTerminal({
    command: "/bin/zsh",
    args: ["-c", canonical],
    cwd: tmp,
    outputByteLimit: 4096,
  });
  const status = await client.waitForTerminalExit({ terminalId: allowed.terminalId });
  assert.deepEqual(
    status,
    { exitCode: 0, signal: null },
    client.terminalOutput({ terminalId: allowed.terminalId }).output,
  );
});

test("ACP terminal exact-test policy rejects transformed test commands", async () => {
  const tmp = await tempRoot("cpb-acp-terminal-swebench-exact-test-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const canonical = "PYTHONPATH=. python3 tests/runtests.py deprecation.test_middleware_mixin.MiddlewareMixinTests.test_coroutine deprecation.test_middleware_mixin.MiddlewareMixinTests.test_deprecation";
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_EXACT_TEST_COMMAND_GUARD: "1",
      CPB_CANONICAL_TEST_COMMANDS_JSON: JSON.stringify([canonical]),
      CPB_ACP_RTK_ENABLED: "0",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  for (const command of [
    `${canonical} 2>&1 | tail -20`,
    "PYTHONPATH=. python3 tests/runtests.py deprecation.test_middleware_mixin",
    "PYTHONPATH=. python3 tests/runtests.py deprecation.test_middleware_mixin.MiddlewareMixinTests.test_coroutine",
    "python3 -m pytest tests",
  ]) {
    await assert.rejects(
      () => client.createTerminal({
        command: "/bin/zsh",
        args: ["-c", command],
        cwd: tmp,
      }),
      /broad_test_command_denied/,
    );
  }

  const events = await readJsonl(auditPath);
  const blocked = events.filter((event) => event.event === "terminal_blocked");
  assert.equal(blocked.length, 4);
  assert.ok(blocked.every((event) => event.classification === "broad_test_command_denied"));
  assert.ok(blocked.some((event) => String(event.offendingCommand).includes("tail -20")));
  assert.equal(client.terminals.size, 0);
});

test("ACP terminal exact-test policy allows listed diagnostic commands only by exact match", async () => {
  const tmp = await tempRoot("cpb-acp-terminal-swebench-diagnostic-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const canonical = "PYTHONPATH=. python3 tests/runtests.py deprecation.test_middleware_mixin.MiddlewareMixinTests.test_coroutine";
  const diagnostic = "PYTHONPATH=. python3 tests/runtests.py deprecation.test_middleware_mixin || true";
  const client = new AcpClient({
    agent: "fake-acp",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_EXACT_TEST_COMMAND_GUARD: "1",
      CPB_CANONICAL_TEST_COMMANDS_JSON: JSON.stringify([canonical]),
      CPB_DIAGNOSTIC_TEST_COMMANDS_JSON: JSON.stringify([diagnostic]),
      CPB_ACP_RTK_ENABLED: "0",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  const allowed = await client.createTerminal({
    command: "/bin/zsh",
    args: ["-c", diagnostic],
    cwd: tmp,
    outputByteLimit: 4096,
  });
  const status = await client.waitForTerminalExit({ terminalId: allowed.terminalId });
  assert.deepEqual(
    status,
    { exitCode: 0, signal: null },
    client.terminalOutput({ terminalId: allowed.terminalId }).output,
  );

  await assert.rejects(
    () => client.createTerminal({
      command: "/bin/zsh",
      args: ["-c", `${diagnostic} | tail -20`],
      cwd: tmp,
    }),
    /broad_test_command_denied/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "terminal_blocked");
  assert.equal(blocked?.classification, "broad_test_command_denied");
  assert.equal(String(blocked?.offendingCommand).includes("tail -20"), true);
  assert.equal(Array.isArray(blocked?.diagnosticCommands), true);
});

test("ACP session update fail-fast blocks disabled web tools", async () => {
  const tmp = await tempRoot("cpb-acp-session-web-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "claude-glm",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_DISABLE_WEB_TOOLS: "1",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "session-web",
      update: {
        sessionUpdate: "tool_call",
        title: "Web search",
        kind: "fetch",
        status: "pending",
        toolCallId: "call-web-search",
      },
    }),
    /PERMISSION_FAIL_FAST: web tool use is disabled/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "tool_blocked");
  assert.equal(blocked?.reason.includes("web tool use is disabled"), true);
  assert.equal(blocked?.toolCallId, "call-web-search");
});

test("ACP session update fail-fast blocks whole-filesystem search titles", async () => {
  const tmp = await tempRoot("cpb-acp-session-search-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "claude-glm",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "session-search",
      update: {
        sessionUpdate: "tool_call_update",
        title: "ls -la /opt/miniconda3/envs/ 2>/dev/null; find / -name \"activate\" -path \"*/swebench*\" 2>/dev/null | head -5",
        kind: "execute",
        status: "in_progress",
        toolCallId: "call-whole-fs-find",
      },
    }),
    /PERMISSION_FAIL_FAST: whole-filesystem find is denied/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "tool_blocked");
  assert.equal(blocked?.classification, "whole_filesystem_search_denied");
  assert.equal(blocked?.toolCallId, "call-whole-fs-find");
  assert.match(String(blocked?.reason), /whole-filesystem find is denied/);
});

test("ACP session updates allow execute terminal tools when generic policy permits them", async () => {
  const tmp = await tempRoot("cpb-acp-session-swebench-execute-terminal-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "claude-glm",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_PHASE: "execute",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await client.handleSessionUpdate({
    sessionId: "session-execute",
    update: {
      sessionUpdate: "tool_call",
      title: "grep -rn \"iscoroutinefunction\" django/core/handlers",
      kind: "execute",
      status: "pending",
      toolCallId: "call-terminal-grep",
    },
  });

  const events = await readJsonl(auditPath);
  assert.equal(events.some((event) => event.event === "tool_blocked"), false);
  assert.equal(events.some((event) => event.event === "tool_call" && event.toolCallId === "call-terminal-grep"), true);
});

test("ACP session update fail-fast blocks configured execute read/search loops without edits", async () => {
  const tmp = await tempRoot("cpb-acp-session-swebench-no-edit-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "claude-glm",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_PHASE: "execute",
      CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "2",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await client.handleSessionUpdate({
    sessionId: "session-swebench-no-edit",
    update: {
      sessionUpdate: "tool_call",
      title: "Read File",
      kind: "read",
      status: "completed",
      toolCallId: "call-read-1",
    },
  });
  await client.handleSessionUpdate({
    sessionId: "session-swebench-no-edit",
    update: {
      sessionUpdate: "tool_call",
      title: "Search _is_coroutine",
      kind: "search",
      status: "completed",
      toolCallId: "call-search-2",
    },
  });

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "session-swebench-no-edit",
      update: {
        sessionUpdate: "tool_call",
        title: "Read File",
        kind: "read",
        status: "completed",
        toolCallId: "call-read-3",
      },
    }),
    /PERMISSION_FAIL_FAST: execute_no_edit_progress/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "tool_blocked");
  assert.equal(blocked?.classification, "execute_no_edit_progress");
  assert.equal(blocked?.toolCallId, "call-read-3");
  assert.equal(blocked?.noEditToolLimit, 2);
  assert.equal(blocked?.noEditToolCount, 3);
  assert.match(String(blocked?.reason), /exceeded no-edit read\/search limit/);
});

test("ACP session update fail-fast blocks ordinary execute read/search loops without edits", async () => {
  const tmp = await tempRoot("cpb-acp-session-generic-no-edit-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "claude-glm",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_PHASE: "execute",
      CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "1",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await client.handleSessionUpdate({
    sessionId: "session-generic-no-edit",
    update: {
      sessionUpdate: "tool_call",
      title: "Read src/index.ts",
      kind: "read",
      status: "completed",
      toolCallId: "call-read-1",
    },
  });

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "session-generic-no-edit",
      update: {
        sessionUpdate: "tool_call",
        title: "Search handler",
        kind: "search",
        status: "completed",
        toolCallId: "call-search-2",
      },
    }),
    /PERMISSION_FAIL_FAST: execute_no_edit_progress/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "tool_blocked");
  assert.equal(blocked?.classification, "execute_no_edit_progress");
  assert.equal(blocked?.toolCallId, "call-search-2");
  assert.equal(blocked?.noEditToolLimit, 1);
  assert.equal(blocked?.noEditToolCount, 2);
  assert.match(String(blocked?.reason), /execute phase exceeded no-edit read\/search limit/);
});

test("ACP session update no-edit idle guard fails configured stalled execute reads", async () => {
  const tmp = await tempRoot("cpb-acp-session-swebench-no-edit-idle");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "claude-glm",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_PHASE: "execute",
      CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "5",
      CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS: "25",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  const pending = new Promise((resolve, reject) => {
    client.pending.set(123, { resolve, reject });
  });
  await client.handleSessionUpdate({
    sessionId: "session-swebench-no-edit-idle",
    update: {
      sessionUpdate: "tool_call",
      title: "Read django/utils/deprecation.py",
      kind: "read",
      status: "completed",
      toolCallId: "call-read-idle",
    },
  });
  assert.equal(client.executeNoEditIdleTimer?.hasRef(), true, "fail-fast guard must keep the request alive until it settles");

  await assert.rejects(
    () => withTimeout(pending, 500, "no-edit idle guard did not fire"),
    /execute_no_edit_progress/,
  );
  await waitForPredicate(() => {
    try {
      const events = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return events.some((event) =>
        event.event === "tool_blocked" &&
        event.classification === "execute_no_edit_progress" &&
        event.noEditIdleTimeoutMs === 25
      );
    } catch {
      return false;
    }
  }, 500, "no-edit idle audit was not recorded");
});

test("ACP session update no-edit guard stops after execute edits", async () => {
  const tmp = await tempRoot("cpb-acp-session-swebench-no-edit-after-edit");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "codex",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_PHASE: "execute",
      CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT: "2",
      CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS: "25",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });
  let idleRejected = false;
  client.pending.set(456, {
    resolve: () => {},
    reject: () => {
      idleRejected = true;
    },
  });

  await client.handleSessionUpdate({
    sessionId: "session-swebench-after-edit",
    update: {
      sessionUpdate: "tool_call",
      title: "Read deprecation.py",
      kind: "read",
      status: "completed",
      toolCallId: "call-read-1",
    },
  });
  await client.handleSessionUpdate({
    sessionId: "session-swebench-after-edit",
    update: {
      sessionUpdate: "tool_call",
      title: "Read test_middleware_mixin.py",
      kind: "read",
      status: "completed",
      toolCallId: "call-read-2",
    },
  });
  await client.handleSessionUpdate({
    sessionId: "session-swebench-after-edit",
    update: {
      sessionUpdate: "tool_call",
      title: "Edit django/utils/deprecation.py",
      kind: "edit",
      status: "completed",
      toolCallId: "call-edit-1",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(idleRejected, false, "edit should clear pending no-edit idle guard");
  client.pending.clear();

  for (const [index, title] of [
    "Read exception.py",
    "Read security.py",
    "Search MiddlewareMixin",
  ].entries()) {
    await client.handleSessionUpdate({
      sessionId: "session-swebench-after-edit",
      update: {
        sessionUpdate: "tool_call",
        title,
        kind: title.startsWith("Search") ? "search" : "read",
        status: "completed",
        toolCallId: `call-after-edit-${index}`,
      },
    });
  }

  const events = await readJsonl(auditPath);
  assert.equal(
    events.some((event) =>
      event.event === "tool_blocked" &&
      event.classification === "execute_no_edit_progress"
    ),
    false,
  );
});

test("ACP session update exact-test policy blocks non-exact test command titles", async () => {
  const tmp = await tempRoot("cpb-acp-session-swebench-test-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const canonical = "PYTHONPATH=. python3 tests/runtests.py model_fields.test_jsonfield.TestQuerying.test_key_in model_fields.test_jsonfield.TestQuerying.test_key_iregex";
  const client = new AcpClient({
    agent: "codex",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_EXACT_TEST_COMMAND_GUARD: "1",
      CPB_CANONICAL_TEST_COMMANDS_JSON: JSON.stringify([canonical]),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await client.handleSessionUpdate({
    sessionId: "session-swebench",
    update: {
      sessionUpdate: "tool_call",
      title: canonical,
      kind: "execute",
      status: "in_progress",
      toolCallId: "call-canonical",
    },
  });

  await client.handleSessionUpdate({
    sessionId: "session-swebench",
    update: {
      sessionUpdate: "tool_call",
      title: `${canonical} 2>&1`,
      kind: "execute",
      status: "completed",
      toolCallId: "call-canonical-stderr-merge",
    },
  });

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "session-swebench",
      update: {
        sessionUpdate: "tool_call",
        title: "PYTHONPATH=. python3 tests/runtests.py model_fields.test_jsonfield.TestQuerying.test_key_iregex",
        kind: "execute",
        status: "in_progress",
        toolCallId: "call-subset",
      },
    }),
    /PERMISSION_FAIL_FAST: broad_test_command_denied/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "tool_blocked");
  assert.equal(blocked?.classification, "broad_test_command_denied");
  assert.equal(blocked?.toolCallId, "call-subset");
  assert.ok(String(blocked?.reason).includes("model_fields.test_jsonfield.TestQuerying.test_key_iregex"));
  assert.ok(events.some((event) => event.event === "tool_call" && event.toolCallId === "call-canonical-stderr-merge"));
});

test("ACP session update exact-test policy blocks ad hoc test scripts", async () => {
  const tmp = await tempRoot("cpb-acp-session-swebench-adhoc-script-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const canonical = "PYTHONPATH=. python3 tests/runtests.py model_fields.test_jsonfield.TestQuerying.test_key_in model_fields.test_jsonfield.TestQuerying.test_key_iregex";
  const client = new AcpClient({
    agent: "claude-glm",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_EXACT_TEST_COMMAND_GUARD: "1",
      CPB_CANONICAL_TEST_COMMANDS_JSON: JSON.stringify([canonical]),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "session-swebench",
      update: {
        sessionUpdate: "tool_call",
        title: "cat > /tmp/test_in_lookup.py << 'EOF'\nimport django\nfrom tests.model_fields.models import NullableJSONModel\nEOF\nPYTHONPATH=. python3 /tmp/test_in_lookup.py 2>&1 | tail -15",
        kind: "execute",
        status: "in_progress",
        toolCallId: "call-adhoc-script",
      },
    }),
    /PERMISSION_FAIL_FAST: broad_test_command_denied/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "tool_blocked");
  assert.equal(blocked?.classification, "broad_test_command_denied");
  assert.equal(blocked?.toolCallId, "call-adhoc-script");
  assert.match(String(blocked?.reason), /ad hoc/i);
});

test("ACP session update exact-test policy blocks inline Python test probes", async () => {
  const tmp = await tempRoot("cpb-acp-session-swebench-inline-python-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const canonical = "PYTHONPATH=. python3 tests/runtests.py utils_tests.test_html.TestUtilsHtml.test_urlize_unchanged_inputs";
  const client = new AcpClient({
    agent: "claude-mimo",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_EXACT_TEST_COMMAND_GUARD: "1",
      CPB_CANONICAL_TEST_COMMANDS_JSON: JSON.stringify([canonical]),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "session-swebench",
      update: {
        sessionUpdate: "tool_call",
        title: "python3 -c \"from django.utils.html import urlize; assert urlize('google.com')\"",
        kind: "execute",
        status: "in_progress",
        toolCallId: "call-inline-python",
      },
    }),
    /PERMISSION_FAIL_FAST: broad_test_command_denied/,
  );

  const events = await readJsonl(auditPath);
  const blocked = events.find((event) => event.event === "tool_blocked");
  assert.equal(blocked?.classification, "broad_test_command_denied");
  assert.equal(blocked?.toolCallId, "call-inline-python");
  assert.match(String(blocked?.reason), /ad hoc/i);
});

test("ACP session update fail-fast blocks normalized tool-call budget exceed", async () => {
  const tmp = await tempRoot("cpb-acp-tool-budget-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "claude-glm",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_TOOL_CALL_BUDGET: "1",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await client.handleSessionUpdate({
    sessionId: "budget-session",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-one",
      title: "Read package.json",
      kind: "read",
    },
  });
  await client.handleSessionUpdate({
    sessionId: "budget-session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-one",
      title: "Read package.json",
      status: "completed",
      kind: "read",
    },
  });

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "budget-session",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-two",
        title: "Search project",
        kind: "search",
      },
    }),
    /PERMISSION_FAIL_FAST: tool_budget_exceeded/,
  );

  const events = await readJsonl(auditPath);
  const budgetExceeded = events.find((event) => event.event === "tool_budget_exceeded");
  assert.equal(budgetExceeded?.toolCallBudget, 1);
  assert.equal(budgetExceeded?.normalizedToolCalls, 2);
  assert.equal(budgetExceeded?.auditUpdateEvents, 3);
});

test("ACP session update fail-fast blocks normalized tool-event budget exceed", async () => {
  const tmp = await tempRoot("cpb-acp-tool-event-budget-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "claude-glm",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_TOOL_EVENT_BUDGET: "2",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await client.handleSessionUpdate({
    sessionId: "budget-session",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-one",
      title: "Terminal",
      kind: "execute",
    },
  });
  await client.handleSessionUpdate({
    sessionId: "budget-session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-one",
      title: "python3 tests/runtests.py",
      kind: "execute",
    },
  });

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "budget-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-one",
        status: "completed",
      },
    }),
    /PERMISSION_FAIL_FAST: tool_event_budget_exceeded/,
  );

  const events = await readJsonl(auditPath);
  const budgetExceeded = events.find((event) => event.event === "tool_event_budget_exceeded");
  assert.equal(budgetExceeded?.toolEventBudget, 2);
  assert.equal(budgetExceeded?.auditUpdateEvents, 3);
});

test("ACP tool-event budget ignores duplicate partial updates for one tool state", async () => {
  const tmp = await tempRoot("cpb-acp-tool-event-dedup");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "codex",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_TOOL_EVENT_BUDGET: "2",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await client.handleSessionUpdate({
    sessionId: "dedup-session",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-one",
      title: "python -m pytest focused_test.py -q",
      kind: "execute",
    },
  });
  for (let index = 0; index < 20; index += 1) {
    await client.handleSessionUpdate({
      sessionId: "dedup-session",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-one",
      },
    });
  }

  const events = await readJsonl(auditPath);
  assert.equal(events.some((event) => event.event === "tool_event_budget_exceeded"), false);
  assert.equal(events.filter((event) => event.event === "tool_call").length, 21);
});

test("ACP session update fail-fast blocks read-only mutating terminal titles", async () => {
  const tmp = await tempRoot("cpb-acp-session-readonly-guard");
  const auditPath = path.join(tmp, "audit.jsonl");
  const client = new AcpClient({
    agent: "claude-mimo",
    cwd: tmp,
    prompt: "",
    env: {
      ...process.env,
      CPB_ACP_AUDIT_FILE: auditPath,
      CPB_ACP_PHASE: "verify",
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
    },
  });

  await client.handleSessionUpdate({
    sessionId: "session-readonly",
    update: {
      sessionUpdate: "tool_call",
      title: "git stash list >/dev/null 2>&1 || true",
      kind: "execute",
      status: "pending",
      toolCallId: "call-stash-list",
    },
  });

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "session-readonly",
      update: {
        sessionUpdate: "tool_call",
        title: "git stash -- django/db/models/fields/json.py && python3 -m pytest; git stash pop",
        kind: "execute",
        status: "pending",
        toolCallId: "call-stash",
      },
    }),
    /PERMISSION_FAIL_FAST: read-only phase "verify" cannot run mutating terminal command \(git stash\)/,
  );

  await assert.rejects(
    () => client.handleSessionUpdate({
      sessionId: "session-readonly",
      update: {
        sessionUpdate: "tool_call",
        title: "pip3 install asgiref sqlparse 2>&1 | tail -5",
        kind: "execute",
        status: "pending",
        toolCallId: "call-pip-install",
      },
    }),
    /PERMISSION_FAIL_FAST: read-only phase "verify" cannot run mutating terminal command \(pip install\)/,
  );

  const events = await readJsonl(auditPath);
  assert.ok(events.some((event) => event.event === "tool_call" && event.toolCallId === "call-stash-list"));
  const blocked = events.filter((event) => event.event === "tool_blocked");
  assert.ok(blocked.some((event) => event.toolCallId === "call-stash" && String(event.reason).includes("git stash")));
  assert.ok(blocked.some((event) => event.toolCallId === "call-pip-install" && String(event.reason).includes("pip install")));
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
  const progressEvents: any[] = [];
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
      onProgress: (event) => progressEvents.push(event),
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
    assert.ok(
      progressEvents.some((event) =>
        event.type === "agent_activity" &&
        event.phase === "plan" &&
        event.role === "planner" &&
        event.jobId === "job-pool-audit" &&
        event.message.includes("mcp__codegraph__codegraph_context")
      ),
      "ACP tool activity should be propagated to pool progress",
    );
  } finally {
    await pool.stop();
  }
});

test("AcpPool agent launch audit records isolated HOME under project runtime root", async () => {
  const tmp = await tempRoot("cpb-acp-isolated-home-audit");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const dataRoot = path.join(tmp, "project-runtime");
  const scenarioPath = path.join(tmp, "scenario.json");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({ responses: [{ output: "isolated-home-response" }] }),
    "utf8",
  );

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_PROJECT_RUNTIME_ROOT: dataRoot,
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([testAgent, "--scenario-file", scenarioPath]),
    },
  });

  try {
    const result = await pool.execute("fake-acp", "record isolated home", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-isolated-audit",
      phase: "plan",
      role: "planner",
    });

    assert.equal(result.output, "isolated-home-response");
    const events = await readJsonl(result.acpAuditFile);
    const launch = events.find((event) => event.event === "agent_launch");
    const expectedHome = path.join(dataRoot, "agent-homes", "fake-acp", "job-isolated-audit");
    assert.equal(launch?.agentHome?.isolated, true);
    assert.equal(launch?.agentHome?.home, expectedHome);
    assert.equal(launch?.agentHome?.xdgConfigHome, path.join(expectedHome, ".config"));
  } finally {
    await pool.stop();
  }
});

test("AcpPool runs fake-acp even when the inherited outer sandbox is required", async () => {
  const tmp = await tempRoot("cpb-acp-required-outer-sandbox");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const scenarioPath = path.join(tmp, "scenario.json");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({ responses: [{ output: "required-sandbox-response" }] }),
    "utf8",
  );

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_AGENT_SANDBOX: "required",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([testAgent, "--scenario-file", scenarioPath]),
    },
  });

  try {
    const result = await pool.execute("fake-acp", "run under required outer sandbox", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-required-sandbox",
      phase: "plan",
      role: "planner",
    });

    assert.equal(result.output, "required-sandbox-response");
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

test("buildAcpPoolEnv preserves GLM Claude-compatible provider credentials", () => {
  const env = buildAcpPoolEnv({
    PATH: process.env.PATH,
    HTTPS_PROXY: "http://127.0.0.1:7890",
    http_proxy: "http://127.0.0.1:7890",
    ZHIPU_BASE_URL: "https://example.invalid/zhipu",
    ZHIPU_API_KEY: "redacted-zhipu",
    ZHIPU_MODEL: "glm-test-model",
    GLM_BASE_URL: "https://example.invalid/glm",
    GLM_API_KEY: "redacted-glm",
    GLM_MODEL: "glm-test-model-alt",
  });

  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.http_proxy, "http://127.0.0.1:7890");
  assert.equal(env.ZHIPU_BASE_URL, "https://example.invalid/zhipu");
  assert.equal(env.ZHIPU_API_KEY, "redacted-zhipu");
  assert.equal(env.ZHIPU_MODEL, "glm-test-model");
  assert.equal(env.GLM_BASE_URL, "https://example.invalid/glm");
  assert.equal(env.GLM_API_KEY, "redacted-glm");
  assert.equal(env.GLM_MODEL, "glm-test-model-alt");
});

test("buildAcpPoolEnv preserves the shared lease root without exposing it to providers", () => {
  const leaseRoot = path.join(process.cwd(), ".tmp-shared-acp-leases");
  const env = buildAcpPoolEnv({
    CPB_ACP_POOL_LEASE_ROOT: leaseRoot,
    CPB_ACP_POOL_PROVIDER_MAX: "2",
  });
  assert.equal(env.CPB_ACP_POOL_LEASE_ROOT, leaseRoot);
  assert.equal(buildChildEnv(env, { agent: "codex" }).CPB_ACP_POOL_LEASE_ROOT, undefined);
});

test("buildAcpPoolEnv preserves ACP pool timeout controls", () => {
  const env = buildAcpPoolEnv({
    CPB_ACP_POOL_TIMEOUT_MS: "12345",
    CPB_ACP_POOL_WAIT_TIMEOUT_MS: "67890",
  });

  assert.equal(env.CPB_ACP_POOL_TIMEOUT_MS, "12345");
  assert.equal(env.CPB_ACP_POOL_WAIT_TIMEOUT_MS, "67890");
});

test("buildAcpPoolEnv keeps provider fallback policy in the pool boundary", () => {
  const env = buildAcpPoolEnv({
    CPB_ACP_PROVIDER_FALLBACKS: JSON.stringify({ "claude:glm": [] }),
  });
  assert.equal(env.CPB_ACP_PROVIDER_FALLBACKS, JSON.stringify({ "claude:glm": [] }));
  assert.equal(buildChildEnv(env, { agent: "claude-glm" }).CPB_ACP_PROVIDER_FALLBACKS, undefined);
});

test("AcpPool exposes MiMo as the GLM provider fallback without relabelling the provider", () => {
  const pool = new AcpPool({
    cpbRoot: path.join(process.cwd(), ".tmp-cpb-mimo-fallback"),
    hubRoot: path.join(process.cwd(), ".tmp-cpb-mimo-fallback-hub"),
  });

  assert.deepEqual(pool.fallbackCandidates("claude-glm", null, "claude:glm"), [{
    providerKey: "claude:mimo-v2.5pro",
    agent: "claude-mimo",
    variant: "mimo-v2.5pro",
    providerFallback: true,
  }]);
  assert.deepEqual(pool.fallbackCandidates("claude-mimo", null, "claude:mimo-v2.5pro"), []);
  assert.deepEqual(pool.status().providerFallbacks, {
    "claude:glm": [{
      providerKey: "claude:mimo-v2.5pro",
      agent: "claude-mimo",
      variant: "mimo-v2.5pro",
    }],
  });
});

test("AcpPool provider fallback configuration can disable or replace the built-in MiMo handoff", () => {
  const pool = new AcpPool({
    providerFallbacks: {
      "claude:glm": [],
      "fake:primary": [{ agent: "fake-secondary", providerKey: "fake:secondary", variant: null }],
    },
  });

  assert.deepEqual(pool.fallbackCandidates("claude-glm"), []);
  assert.deepEqual(pool.fallbackCandidates("fake", "primary"), [{
    agent: "fake-secondary",
    providerKey: "fake:secondary",
    variant: null,
    providerFallback: true,
  }]);
});

test("AcpPool coordinates provider leases across isolated Hub roots", async () => {
  const tmp = await tempRoot("cpb-acp-shared-lease-root");
  const sharedLeaseRoot = path.join(tmp, "shared-leases");
  const poolRoots = [0, 1].map((index) => ({
    cpbRoot: path.join(tmp, `cpb-${index}`),
    hubRoot: path.join(tmp, `hub-${index}`),
  }));
  let runnerStarts = 0;
  let releaseFirst: (() => void) | null = null;
  let firstStarted: (() => void) | null = null;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  const runner = async () => {
    runnerStarts += 1;
    if (runnerStarts === 1) {
      firstStarted?.();
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    }
    return `response-${runnerStarts}`;
  };
  const pools = poolRoots.map(({ cpbRoot, hubRoot }) => new AcpPool({
    cpbRoot,
    hubRoot,
    leaseRoot: sharedLeaseRoot,
    providerConnectionLimit: 1,
    runner,
  }));

  try {
    const first = pools[0].execute("codex", "first", repoRoot, 10_000);
    await firstStartedPromise;
    const second = pools[1].execute("codex", "second", repoRoot, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(runnerStarts, 1, "the second pool must wait on the shared file lease");
    releaseFirst?.();
    assert.equal((await first).output, "response-1");
    assert.equal((await second).output, "response-2");
  } finally {
    releaseFirst?.();
    await Promise.all(pools.map((pool) => pool.stop()));
  }
});

test("AcpPool one-shot creates runtime roots before spawning the ACP client", async () => {
  const tmp = await tempRoot("cpb-acp-oneshot-roots");
  const cpbRoot = path.join(tmp, "missing-cpb-root");
  const hubRoot = path.join(tmp, "missing-hub-root");
  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([testAgent, "--response", "one-shot-ok"]),
    },
    persistentProcesses: false,
  });

  try {
    const result = await pool.execute("fake-acp", "root creation smoke", repoRoot, 10_000, {
      phase: "plan",
      role: "planner",
    });

    assert.equal(result.output, "one-shot-ok");
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

test("AcpPool explicit empty env does not inherit ambient pool timeout defaults", async () => {
  const tmp = await tempRoot("cpb-acp-pool-empty-env");
  const modulePath = path.join(repoRoot, "server", "services", "acp", "acp-pool.js");
  const script = String.raw`
    import { mkdir } from "node:fs/promises";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const { AcpPool } = await import(pathToFileURL(process.env.CPB_TEST_ACP_POOL_MODULE).href);
    const tmp = process.env.CPB_TEST_TMP;
    const cpbRoot = path.join(tmp, "cpb");
    const hubRoot = path.join(tmp, "hub");
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(hubRoot, { recursive: true });

    let observedTimeoutMs = null;
    const pool = new AcpPool({
      cpbRoot,
      hubRoot,
      env: {},
      providerConnectionLimit: 1,
      runner: async ({ timeoutMs }) => {
        observedTimeoutMs = timeoutMs;
        return "ok";
      },
    });

    const result = await pool.execute("codex", "prompt", cpbRoot);
    const first = await pool.acquire("codex");
    const second = pool.acquire("codex");
    const earlyState = await Promise.race([
      second.then(() => "acquired", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("queued"), 35)),
    ]);
    first.release();
    if (earlyState === "queued") {
      const acquired = await second;
      acquired.release();
    }
    await pool.stop();
    console.log(JSON.stringify({ output: result.output, observedTimeoutMs, earlyState }));
  `;

  const result = await runNodeEval(script, {
    CPB_TEST_ACP_POOL_MODULE: modulePath,
    CPB_TEST_TMP: tmp,
    CPB_ACP_POOL_TIMEOUT_MS: "9876",
    CPB_ACP_POOL_WAIT_TIMEOUT_MS: "10",
  });
  const observed = JSON.parse(result.stdout.trim());

  assert.equal(observed.output, "ok");
  assert.equal(observed.observedTimeoutMs, 0);
  assert.equal(observed.earlyState, "queued");
});

test("AcpPool still inherits ambient pool timeout defaults when env is omitted", async () => {
  const tmp = await tempRoot("cpb-acp-pool-ambient-env");
  const modulePath = path.join(repoRoot, "server", "services", "acp", "acp-pool.js");
  const script = String.raw`
    import { mkdir } from "node:fs/promises";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const { AcpPool } = await import(pathToFileURL(process.env.CPB_TEST_ACP_POOL_MODULE).href);
    const tmp = process.env.CPB_TEST_TMP;
    const cpbRoot = path.join(tmp, "cpb");
    const hubRoot = path.join(tmp, "hub");
    await mkdir(cpbRoot, { recursive: true });
    await mkdir(hubRoot, { recursive: true });

    let observedTimeoutMs = null;
    const pool = new AcpPool({
      cpbRoot,
      hubRoot,
      providerConnectionLimit: 1,
      runner: async ({ timeoutMs }) => {
        observedTimeoutMs = timeoutMs;
        return "ok";
      },
    });

    const result = await pool.execute("codex", "prompt", cpbRoot);
    const first = await pool.acquire("codex");
    const second = pool.acquire("codex");
    const earlyState = await Promise.race([
      second.then(() => "acquired", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("queued"), 35)),
    ]);
    first.release();
    if (earlyState === "queued") {
      const acquired = await second;
      acquired.release();
    }
    await pool.stop();
    console.log(JSON.stringify({ output: result.output, observedTimeoutMs, earlyState }));
  `;

  const result = await runNodeEval(script, {
    CPB_TEST_ACP_POOL_MODULE: modulePath,
    CPB_TEST_TMP: tmp,
    CPB_ACP_POOL_TIMEOUT_MS: "2468",
    CPB_ACP_POOL_WAIT_TIMEOUT_MS: "10",
  });
  const observed = JSON.parse(result.stdout.trim());

  assert.equal(observed.output, "ok");
  assert.equal(observed.observedTimeoutMs, 2468);
  assert.equal(observed.earlyState, "rejected");
});

test("AcpPool derives default execute and wait timeouts from explicit pool env", async () => {
  const tmp = await tempRoot("cpb-acp-pool-explicit-env");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });

  let observedTimeoutMs: number | null = null;
  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      CPB_ACP_POOL_TIMEOUT_MS: "1234",
      CPB_ACP_POOL_WAIT_TIMEOUT_MS: "10",
    },
    providerConnectionLimit: 1,
    runner: async ({ timeoutMs }) => {
      observedTimeoutMs = timeoutMs;
      return "ok";
    },
  });

  try {
    const result = await pool.execute("codex", "prompt", cpbRoot);
    assert.equal(result.output, "ok");
    assert.equal(observedTimeoutMs, 1234);
    const first = await pool.acquire("codex");
    try {
      await assert.rejects(
        pool.acquire("codex"),
        /ACP pool exhausted: codex\/codex waited/,
      );
    } finally {
      first.release();
    }
  } finally {
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
  let observed: any = null;
  const onProgress = () => {};
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
    onProgress,
  });

  assert.equal(result.ok, true);
  assert.equal(observed.execCwd, cwd);
  assert.equal(observed.options.cwd, cwd);
  assert.equal(observed.options.onProgress, onProgress);
  assert.equal(
    poolClientKey("fake-acp", { role: "executor", projectId: "proj", cwd: "/tmp/worktree-a" }),
    poolClientKey("fake-acp", { role: "executor", projectId: "proj", cwd: "/tmp/worktree-b" }),
  );
  assert.notEqual(
    poolClientKey("codex", { projectId: "proj", cwd: "/tmp/worktree-a", processCwd: "/tmp/worktree-a" }),
    poolClientKey("codex", { projectId: "proj", cwd: "/tmp/worktree-b", processCwd: "/tmp/worktree-b" }),
  );
  assert.notEqual(
    poolClientKey("codex", { projectId: "proj", launchPermissionLane: "read-only" }),
    poolClientKey("codex", { projectId: "proj", launchPermissionLane: "workspace-write" }),
  );
});

test("runAgent classifies AbortError as a runtime interruption", async () => {
  const abortError = Object.assign(new Error("ACP pool request aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
  const result = await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "fake-acp",
    project: "proj",
    jobId: "job-run-agent-abort",
    prompt: "verify",
    cwd: repoRoot,
    pool: {
      async execute() {
        throw abortError;
      },
    },
    env: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, FailureKind.RUNTIME_INTERRUPTED);
  assert.equal(result.retryable, false);
  assert.equal(recordValue(result.diagnostics).cancelled, true);
});

test("runAgent restricts read-only phases to phase output paths by default", async () => {
  const dataRoot = path.join(await tempRoot("cpb-run-agent-readonly-env"), "runtime", "projects", "flow");
  const observed: any[] = [];
  const pool = {
    async execute(agent, prompt, execCwd, timeoutMs, options) {
      observed.push({ agent, prompt, execCwd, timeoutMs, options });
      return { output: "ok", providerKey: "fake-acp", variant: null };
    },
  };

  await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "fake-acp",
    project: "proj",
    jobId: "job-readonly-verify",
    prompt: "verify",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: {},
  });

  assert.equal(observed[0].options.env.CPB_ACP_WRITE_ALLOW, `${dataRoot}/phase-io/verify/*`);
  assert.equal(observed[0].options.env.CPB_AGENT_SANDBOX, "required");
  assert.equal(observed[0].options.env.TMPDIR, `${dataRoot}/phase-io/verify/.tmp/job-readonly-verify`);
  assert.equal(observed[0].options.env.TEMP, observed[0].options.env.TMPDIR);
  assert.equal(observed[0].options.env.TMP, observed[0].options.env.TMPDIR);

  await runAgent({
    phase: "adversarial_verify",
    role: "adversarial_verifier",
    agent: "fake-acp",
    project: "proj",
    jobId: "job-readonly-adversarial",
    prompt: "verify",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: {},
  });

  assert.equal(
    observed[1].options.env.CPB_ACP_WRITE_ALLOW,
    `${dataRoot}/phase-io/adversarial_verify/*`,
  );

  await runAgent({
    phase: "execute",
    role: "executor",
    agent: "fake-acp",
    project: "proj",
    jobId: "job-execute",
    prompt: "execute",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: {},
  });

  assert.equal(observed[2].options.env.CPB_ACP_WRITE_ALLOW, undefined);
  assert.equal(observed[2].options.env.CPB_AGENT_SANDBOX, "required");

  await runAgent({
    phase: "execute",
    role: "executor",
    agent: "codex",
    project: "proj",
    jobId: "job-codex-native-sandbox",
    prompt: "execute",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: {},
  });

  assert.equal(observed[3].options.env.CPB_AGENT_SANDBOX, undefined);
  assert.equal(observed[3].options.env.CPB_AGENT_SANDBOX_INHERITED, "1");

  await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "codex",
    project: "proj",
    jobId: "job-codex-outer-readonly",
    prompt: "verify",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: {},
  });

  assert.equal(observed[4].options.env.CPB_AGENT_SANDBOX, undefined);
  assert.equal(observed[4].options.env.CPB_AGENT_SANDBOX_INHERITED, "1");
  assert.equal(observed[4].options.env.CPB_CODEX_VERIFIER_WORKSPACE_WRITE, undefined);

  await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "fake-acp",
    project: "proj",
    jobId: "job-explicit-allow",
    prompt: "verify",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: { CPB_ACP_WRITE_ALLOW: "/custom/phase-output/*" },
  });

  assert.equal(observed[5].options.env.CPB_ACP_WRITE_ALLOW, `${dataRoot}/phase-io/verify/*`);

  await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "claude-mimo",
    project: "proj",
    jobId: "job-claude-readonly",
    prompt: "verify",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: {},
  });

  assert.equal(observed[6].options.env.CPB_ACP_WRITE_ALLOW, `${dataRoot}/phase-io/verify/*`);
  assert.equal(observed[6].options.env.CPB_AGENT_SANDBOX, "required");
  assert.deepEqual(JSON.parse(observed[6].options.env.CPB_ACP_CLAUDE_MIMO_ARGS), [
    "--disallowedTools",
    "Edit,MultiEdit",
  ]);

  await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "claude-mimo",
    project: "proj",
    jobId: "job-claude-readonly-existing-deny-tools",
    prompt: "verify",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: {
      CPB_ACP_CLAUDE_MIMO_ARGS: JSON.stringify(["--disallowedTools", "WebSearch,WebFetch"]),
    },
  });

  assert.deepEqual(JSON.parse(observed[7].options.env.CPB_ACP_CLAUDE_MIMO_ARGS), [
    "--disallowedTools",
    "WebSearch,WebFetch,Edit,MultiEdit",
  ]);

  for (const phase of ["plan", "review"]) {
    await runAgent({
      phase,
      role: phase === "plan" ? "planner" : "reviewer",
      agent: "fake-acp",
      project: "proj",
      jobId: `job-readonly-${phase}`,
      prompt: phase,
      cwd: "/tmp/worktree",
      pool,
      dataRoot,
      env: {},
    });
  }
  assert.equal(observed[8].options.env.CPB_ACP_WRITE_ALLOW, `${dataRoot}/phase-io/plan/*`);
  assert.equal(observed[9].options.env.CPB_ACP_WRITE_ALLOW, `${dataRoot}/phase-io/review/*`);
});

test("runAgent allows Bash while denying edit tools for writable Claude verifier replays", async () => {
  const dataRoot = path.join(await tempRoot("cpb-run-agent-claude-replay-env"), "runtime", "projects", "flow");
  const observed: any[] = [];
  const pool = {
    async execute(agent, prompt, execCwd, timeoutMs, options) {
      observed.push({ agent, prompt, execCwd, timeoutMs, options });
      return { output: "ok", providerKey: "fake-acp", variant: null };
    },
  };

  await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "claude-mimo",
    project: "proj",
    jobId: "job-claude-writable-replay",
    prompt: "verify",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: {
      CPB_VERIFIER_REPLAY_WORKSPACE_WRITE: "1",
      CPB_ACP_WRITE_ALLOW: "/unrelated/write-root/*",
    },
  });

  assert.deepEqual(JSON.parse(observed[0].options.env.CPB_ACP_CLAUDE_MIMO_ARGS), [
    "--disallowedTools",
    "Edit,Write,MultiEdit",
  ]);
  assert.equal(
    observed[0].options.env.CPB_ACP_WRITE_ALLOW,
    `/tmp/worktree,${dataRoot}/phase-io/verify/*`,
  );
});

test("runAgent keeps adversarial verification evidence-only despite inherited write roots", async () => {
  const dataRoot = path.join(await tempRoot("cpb-run-agent-adversarial-env"), "runtime", "projects", "flow");
  const observed: any[] = [];
  const pool = {
    async execute(agent, prompt, execCwd, timeoutMs, options) {
      observed.push({ agent, prompt, execCwd, timeoutMs, options });
      return { output: "ok", providerKey: "fake-acp", variant: null };
    },
  };

  await runAgent({
    phase: "adversarial_verify",
    role: "adversarial_verifier",
    agent: "claude-glm",
    project: "proj",
    jobId: "job-claude-adversarial-readonly",
    prompt: "verify",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: { CPB_ACP_WRITE_ALLOW: "/tmp/worktree,/unrelated/write-root/*" },
  });

  assert.equal(
    observed[0].options.env.CPB_ACP_WRITE_ALLOW,
    `${dataRoot}/phase-io/adversarial_verify/*`,
  );
  assert.equal(
    observed[0].options.env.CPB_AGENT_SANDBOX_ALLOW_WRITE,
    `${dataRoot}/phase-io/adversarial_verify/*`,
  );
  assert.deepEqual(JSON.parse(observed[0].options.env.CPB_ACP_CLAUDE_GLM_ARGS), [
    "--disallowedTools",
    "Bash,Edit,Write,MultiEdit",
  ]);
});

test("runAgent can disable Claude web tools without weakening read-only path denial", async () => {
  const dataRoot = path.join(await tempRoot("cpb-run-agent-no-web-env"), "runtime", "projects", "flow");
  const observed: any[] = [];
  const pool = {
    async execute(agent, prompt, execCwd, timeoutMs, options) {
      observed.push({ agent, prompt, execCwd, timeoutMs, options });
      return { output: "ok", providerKey: "fake-acp", variant: null };
    },
  };

  await runAgent({
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    project: "proj",
    jobId: "job-claude-execute-no-web",
    prompt: "execute",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: { CPB_ACP_DISABLE_WEB_TOOLS: "1" },
  });

  assert.deepEqual(JSON.parse(observed[0].options.env.CPB_ACP_CLAUDE_GLM_ARGS), [
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--disallowedTools",
    "WebSearch,WebFetch",
  ]);
  assert.equal(
    observed[0].options.env.CPB_ACP_WRITE_ALLOW,
    `${dataRoot}/phase-io/execute/*`,
  );
  assert.equal(
    observed[0].options.env.CPB_AGENT_SANDBOX_ALLOW_WRITE,
    `${dataRoot}/phase-io/execute/*`,
  );

  await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "claude-mimo",
    project: "proj",
    jobId: "job-claude-verify-no-web",
    prompt: "verify",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: { CPB_ACP_DISABLE_WEB_TOOLS: "1" },
  });

  assert.deepEqual(JSON.parse(observed[1].options.env.CPB_ACP_CLAUDE_MIMO_ARGS), [
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--disallowedTools",
    "WebSearch,WebFetch,Edit,MultiEdit",
  ]);
});

test("runAgent does not disable Claude terminal tools based on task identity", async () => {
  const dataRoot = path.join(await tempRoot("cpb-run-agent-swebench-execute-env"), "runtime", "projects", "flow");
  const observed: any[] = [];
  const pool = {
    async execute(agent, prompt, execCwd, timeoutMs, options) {
      observed.push({ agent, prompt, execCwd, timeoutMs, options });
      return { output: "ok", providerKey: "fake-acp", variant: null };
    },
  };

  await runAgent({
    phase: "execute",
    role: "executor",
    agent: "claude-glm",
    project: "proj",
    jobId: "job-swebench-execute",
    prompt: "execute",
    cwd: "/tmp/worktree",
    pool,
    dataRoot,
    env: {
      CPB_ACP_CLAUDE_GLM_ARGS: JSON.stringify(["--disallowedTools", "WebSearch,WebFetch"]),
    },
  });

  assert.deepEqual(JSON.parse(observed[0].options.env.CPB_ACP_CLAUDE_GLM_ARGS), [
    "--disallowedTools",
    "WebSearch,WebFetch",
  ]);
});

test("runAgent fails read-only phases when ACP audit shows worktree edits", async () => {
  const tmp = await tempRoot("cpb-run-agent-readonly-audit");
  const dataRoot = path.join(tmp, "runtime", "projects", "flow");
  const worktreeRoot = path.join(tmp, "worktree");
  const auditPath = path.join(dataRoot, "acp-audit", "proj", "job-readonly-audit.jsonl");
  await mkdir(path.dirname(auditPath), { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });

  const pool = {
    async execute() {
      return { output: "ok", providerKey: "fake-acp", variant: null, acpAuditFile: auditPath };
    },
  };

  await writeFile(
    auditPath,
    JSON.stringify({
      event: "tool_call",
      phase: "verify",
      kind: "edit",
      // Claude-compatible ACP reports the allowed verdict write as a bare
      // absolute path rather than `Edit <path>`.
      title: path.join(dataRoot, "phase-io", "verify", "verdict.json"),
      status: "completed",
    }) + "\n",
    "utf8",
  );

  const allowed = await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "fake-acp",
    project: "proj",
    jobId: "job-readonly-audit",
    prompt: "verify",
    cwd: worktreeRoot,
    pool,
    dataRoot,
    env: {},
  });

  assert.equal(allowed.ok, true);

  await writeFile(
    auditPath,
    JSON.stringify({
      event: "tool_call",
      phase: "adversarial_verify",
      kind: "edit",
      title: `Edit ${path.join(worktreeRoot, "django", "urls", "resolvers.py").replace(/^\/tmp\//, "/private/tmp/")}`,
      status: "completed",
    }) + "\n",
    "utf8",
  );

  const blocked = await runAgent({
    phase: "adversarial_verify",
    role: "adversarial_verifier",
    agent: "claude-mimo",
    project: "proj",
    jobId: "job-readonly-audit",
    prompt: "adversarial verify",
    cwd: worktreeRoot,
    pool,
    dataRoot,
    env: {},
  });

  const blockedRecord = blocked as {
    kind?: unknown;
    reason?: unknown;
    cause?: {
      readOnlyMutation?: {
        targetPath?: unknown;
      };
    };
    diagnostics?: {
      readOnlyMutation?: {
        targetPath?: unknown;
      };
    };
  };
  assert.equal(blocked.ok, false);
  assert.equal(blockedRecord.kind, "read_only_mutation_denied");
  assert.match(String(blockedRecord.reason), /read-only phase attempted to modify/);
  assert.equal(
    blockedRecord.cause?.readOnlyMutation?.targetPath,
    path.join(worktreeRoot, "django", "urls", "resolvers.py"),
  );
  assert.equal(
    blockedRecord.diagnostics?.readOnlyMutation?.targetPath,
    path.join(worktreeRoot, "django", "urls", "resolvers.py"),
  );
});

test("runAgent scopes read-only mutation audit to the current execution window", async () => {
  const tmp = await tempRoot("cpb-run-agent-readonly-audit-window");
  const dataRoot = path.join(tmp, "runtime", "projects", "flow");
  const worktreeRoot = path.join(tmp, "worktree");
  const auditPath = path.join(dataRoot, "acp-audit", "proj", "job-readonly-audit-window.jsonl");
  await mkdir(path.dirname(auditPath), { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });

  await writeFile(
    auditPath,
    JSON.stringify({
      ts: new Date(Date.now() - 60_000).toISOString(),
      event: "tool_blocked",
      phase: "verify",
      sessionId: "stale-verifier-session",
      kind: "edit",
      title: "Editing files",
      status: "in_progress",
      reason: "read-only phase \"verify\" cannot use a mutating edit tool",
    }) + "\n",
    "utf8",
  );

  const pool = {
    async execute() {
      return {
        output: "ok",
        providerKey: "fake-acp",
        variant: null,
        acpAuditFile: auditPath,
        sessionId: "fresh-verifier-session",
      };
    },
  };

  const result = await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "fake-acp",
    project: "proj",
    jobId: "job-readonly-audit-window",
    prompt: "verify",
    cwd: worktreeRoot,
    pool,
    dataRoot,
    env: {},
  });

  assert.equal(result.ok, true);
});

test("runAgent still rejects a read-only mutation from the current session", async () => {
  const tmp = await tempRoot("cpb-run-agent-readonly-audit-current");
  const dataRoot = path.join(tmp, "runtime", "projects", "flow");
  const worktreeRoot = path.join(tmp, "worktree");
  const auditPath = path.join(dataRoot, "acp-audit", "proj", "job-readonly-audit-current.jsonl");
  await mkdir(path.dirname(auditPath), { recursive: true });
  await mkdir(worktreeRoot, { recursive: true });

  const pool = {
    async execute() {
      await writeFile(
        auditPath,
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "tool_blocked",
          phase: "verify",
          sessionId: "current-verifier-session",
          kind: "edit",
          title: "Editing files",
          status: "in_progress",
          reason: "read-only phase \"verify\" cannot use a mutating edit tool",
        }) + "\n",
        "utf8",
      );
      return {
        output: "ok",
        providerKey: "fake-acp",
        variant: null,
        acpAuditFile: auditPath,
        sessionId: "current-verifier-session",
      };
    },
  };

  const result = await runAgent({
    phase: "verify",
    role: "verifier",
    agent: "fake-acp",
    project: "proj",
    jobId: "job-readonly-audit-current",
    prompt: "verify",
    cwd: worktreeRoot,
    pool,
    dataRoot,
    env: {},
  });

  const resultRecord = result as { kind?: unknown; reason?: unknown };
  assert.equal(result.ok, false);
  assert.equal(resultRecord.kind, "read_only_mutation_denied");
  assert.match(String(resultRecord.reason), /provider-did-not-report-path/);
});

test("persistent verifier ACP requests cannot write worktree files", async () => {
  const tmp = await tempRoot("cpb-acp-persistent-readonly");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const dataRoot = path.join(tmp, "project-runtime");
  const worktreeRoot = path.join(tmp, "worktree");
  const sourcePath = path.join(worktreeRoot, "source.txt");
  const phaseOutputPath = path.join(dataRoot, "phase-io", "verify", "verdict.json");
  const scenarioPath = path.join(tmp, "scenario.json");
  await mkdir(worktreeRoot, { recursive: true });
  await writeFile(sourcePath, "original-source\n", "utf8");
  await writeFile(
    scenarioPath,
    JSON.stringify({
      responses: [
        {
          output: "verify-output",
          writes: [
            { path: phaseOutputPath, content: "{\"status\":\"accepted\"}\n" },
            { path: sourcePath, content: "verifier-mutated-source\n" },
          ],
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
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([testAgent, "--scenario-file", scenarioPath]),
    },
  });

  try {
    const result = await runAgent({
      phase: "verify",
      role: "verifier",
      agent: "fake-acp",
      project: "proj",
      jobId: "job-persistent-readonly",
      prompt: "verify",
      cwd: worktreeRoot,
      pool,
      dataRoot,
      // This case exercises the ACP fs permission boundary itself. OS-level
      // phase-output/worktree isolation is covered separately by agent-sandbox.test.
      env: { CPB_AGENT_SANDBOX: "off", CPB_AGENT_SANDBOX_ALLOW_READ: tmp },
    });

    assert.equal(result.ok, true);
    assert.equal(await readFile(phaseOutputPath, "utf8"), "{\"status\":\"accepted\"}\n");
    assert.equal(await readFile(sourcePath, "utf8"), "original-source\n");
  } finally {
    await pool.stop();
  }
});

test("AcpPool never reuses a Codex process across effective permission lanes", async () => {
  const tmp = await tempRoot("cpb-codex-permission-lanes");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const dataRoot = path.join(tmp, "project-runtime");
  const scenarioPath = path.join(tmp, "scenario.json");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({ responses: [{ output: "permission-lane-response" }] }),
    "utf8",
  );

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_AGENT_SANDBOX: "off",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "1",
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: JSON.stringify([
        testAgent,
        "--scenario-file",
        scenarioPath,
        "--transcript-file",
        transcriptPath,
      ]),
    },
  });

  try {
    const plan = await runAgent({
      phase: "plan",
      role: "planner",
      agent: "codex",
      project: "proj",
      jobId: "job-codex-plan-lane",
      prompt: "plan",
      cwd: cpbRoot,
      pool,
      dataRoot,
      env: { CPB_AGENT_SANDBOX: "off" },
    });
    const execute = await runAgent({
      phase: "execute",
      role: "executor",
      agent: "codex",
      project: "proj",
      jobId: "job-codex-execute-lane",
      prompt: "execute",
      cwd: cpbRoot,
      pool,
      dataRoot,
      env: { CPB_AGENT_SANDBOX: "off" },
    });

    assert.equal(plan.ok, true);
    assert.equal(execute.ok, true);
    const transcript = await readJsonl(transcriptPath);
    assert.equal(transcript.filter((event) => event.event === "initialize").length, 2);
    assert.equal(transcript.filter((event) => event.event === "session/new").length, 2);
    assert.equal(transcript.filter((event) => event.event === "session/prompt").length, 2);
  } finally {
    await pool.stop();
  }
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
      ...sandboxTempEnv(tmp),
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
      ...sandboxTempEnv(tmp),
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

test("AcpPool job release closes every conversation across replay worktrees", async () => {
  const tmp = await tempRoot("cpb-acp-persistent-job-release");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const dataRoot = path.join(tmp, "project-runtime");
  const sourceWorktree = path.join(tmp, "source-worktree");
  const verifierReplay = path.join(tmp, "verifier-replay");
  const scenarioPath = path.join(tmp, "scenario.json");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(sourceWorktree, { recursive: true });
  await mkdir(verifierReplay, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({ responses: [{ output: "job-release-response" }] }),
    "utf8",
  );

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
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
    const first = await pool.execute("fake-acp", "source execution", sourceWorktree, 10_000, {
      projectId: "proj",
      jobId: "job-release",
      phase: "execute",
      role: "executor",
      conversationKey: "cpb:proj:job-release:attempt-1:executor",
    });
    await pool.execute("fake-acp", "independent verification", verifierReplay, 10_000, {
      projectId: "proj",
      jobId: "job-release",
      phase: "verify",
      role: "verifier",
      conversationKey: "cpb:proj:job-release:attempt-1:verifier",
    });

    assert.equal(pool.persistentClients.size, 2);
    assert.equal(await pool.releaseJob("proj", "job-release", "attempt_complete"), true);
    assert.equal(pool.persistentClients.size, 0);

    const transcript = await readJsonl(transcriptPath);
    assert.equal(transcript.filter((event) => event.event === "session/close").length, 2);
    const audit = await readJsonl(first.acpAuditFile);
    assert.equal(audit.filter((event) => event.event === "session_close").length, 2);
    const launches = audit.filter((event) => event.event === "agent_launch");
    assert.equal(launches.length, 2);
    assert.notEqual(launches[0]?.agentHome?.home, launches[1]?.agentHome?.home);
    for (const launch of launches) {
      assert.match(
        String(launch?.agentHome?.home || ""),
        new RegExp(`${path.join(dataRoot, "agent-homes", "fake-acp", "job-release").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/conversation-[a-f0-9]{16}$`),
      );
    }
  } finally {
    await pool.stop();
  }
});

test("AcpPool one-shot ACP scopes isolated homes per conversation", async () => {
  const tmp = await tempRoot("cpb-acp-oneshot-conversation-homes");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const dataRoot = path.join(tmp, "project-runtime");
  const sourceWorktree = path.join(tmp, "source-worktree");
  const verifierReplay = path.join(tmp, "verifier-replay");
  await mkdir(sourceWorktree, { recursive: true });
  await mkdir(verifierReplay, { recursive: true });

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    persistentProcesses: false,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_PROJECT_RUNTIME_ROOT: dataRoot,
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([testAgent, "--response", "one-shot-response"]),
    },
  });

  try {
    const first = await pool.execute("fake-acp", "source execution", sourceWorktree, 10_000, {
      projectId: "proj",
      jobId: "job-one-shot-homes",
      phase: "execute",
      role: "executor",
      conversationKey: "cpb:proj:job-one-shot-homes:attempt-1:executor",
    });
    await pool.execute("fake-acp", "independent verification", verifierReplay, 10_000, {
      projectId: "proj",
      jobId: "job-one-shot-homes",
      phase: "verify",
      role: "verifier",
      conversationKey: "cpb:proj:job-one-shot-homes:attempt-1:verifier",
    });

    const launches = (await readJsonl(first.acpAuditFile)).filter((event) => event.event === "agent_launch");
    assert.equal(launches.length, 2);
    assert.notEqual(launches[0]?.agentHome?.home, launches[1]?.agentHome?.home);
    for (const launch of launches) {
      assert.match(String(launch?.agentHome?.home || ""), /\/job-one-shot-homes\/conversation-[a-f0-9]{16}$/);
    }
  } finally {
    await pool.stop();
  }
});

test("AcpPool stop terminates persistent provider when session close hangs", async () => {
  const tmp = await tempRoot("cpb-acp-persistent-close-hang");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const scenarioPath = path.join(tmp, "scenario.json");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(
    scenarioPath,
    JSON.stringify({ responses: [{ output: "close-hang-response" }] }),
    "utf8",
  );

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "1",
      CPB_ACP_CLOSE_SESSION_TIMEOUT_MS: "100",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgent,
        "--scenario-file",
        scenarioPath,
        "--transcript-file",
        transcriptPath,
        "--hang-on-close",
      ]),
    },
  });

  let childPid: number | null = null;
  let stopped = false;
  try {
    const result = await pool.execute("fake-acp", "prompt before hung close", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-close-hang",
      phase: "execute",
      role: "executor",
    });
    assert.equal(result.output, "close-hang-response");

    const persistent = [...pool.persistentClients.values()][0];
    childPid = persistent.client.child?.pid || null;

    await withTimeout(pool.stop(), 1_500, "pool.stop timed out while provider ignored session/close");
    stopped = true;
    assert.equal(pool.persistentClients.size, 0);

    const transcript = await readJsonl(transcriptPath);
    assert.ok(transcript.some((event) => event.event === "session/close"));
  } finally {
    if (!stopped) killProcessTree(childPid);
  }
});

test("AcpPool queued acquire abort removes the waiter and rejects AbortError", async () => {
  const tmp = await tempRoot("cpb-acp-queued-acquire-abort");
  const pool = new AcpPool({
    cpbRoot: path.join(tmp, "cpb"),
    hubRoot: path.join(tmp, "hub"),
    providerConnectionLimit: 1,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
    },
  });
  const controller = new AbortController();
  const providerKey = pool.providerKey("fake-acp");
  const active = await pool.acquire("fake-acp");
  try {
    const queued = pool.acquire("fake-acp", { signal: controller.signal });
    assert.equal(pool.pending.get(`provider:${providerKey}`)?.length, 1);

    controller.abort();

    await assert.rejects(
      withTimeout(queued, 500, "queued acquire did not reject promptly after abort"),
      isAbortError,
    );
    assert.equal(pool.pending.get(`provider:${providerKey}`)?.length || 0, 0);
  } finally {
    active.release();
    await pool.stop();
  }
});

test("AcpPool stop terminates active one-shot provider child", async () => {
  const tmp = await tempRoot("cpb-acp-oneshot-stop");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "0",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgent,
        "--transcript-file",
        transcriptPath,
        "--stall-on-prompt",
      ]),
    },
  });

  let childPid: number | null = null;
  let stopped = false;
  const execution = pool.execute("fake-acp", "prompt that will hang", repoRoot, 10_000, {
    projectId: "proj",
    jobId: "job-oneshot-stop",
    phase: "plan",
    role: "planner",
  });
  const observedExecution = execution.then(
    () => null,
    (error) => error as Error,
  );

  try {
    await waitForPredicate(() => pool.oneShotChildren.size === 1, 2_000, "one-shot child was not tracked");
    childPid = [...pool.oneShotChildren][0].pid || null;
    await withTimeout(pool.stop(), 2_000, "pool.stop timed out with active one-shot child");
    stopped = true;
    assert.equal(pool.oneShotChildren.size, 0);

    const executionError = await withTimeout(observedExecution, 1_000, "active one-shot execution did not reject after stop");
    assert.ok(executionError, "execution should reject when pool.stop terminates its provider child");
  } finally {
    if (!stopped) killProcessTree(childPid);
  }
});

test("AcpPool one-shot abort terminates the provider child and rejects AbortError", async () => {
  const tmp = await tempRoot("cpb-acp-oneshot-abort");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });

  const controller = new AbortController();
  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "0",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgent,
        "--transcript-file",
        transcriptPath,
        "--stall-on-prompt",
      ]),
    },
  });

  let childPid: number | null = null;
  try {
    const execution = pool.execute("fake-acp", "prompt that will abort", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-oneshot-abort",
      phase: "plan",
      role: "planner",
      signal: controller.signal,
    });

    await waitForPredicate(() => pool.oneShotChildren.size === 1, 2_000, "one-shot child was not tracked");
    childPid = [...pool.oneShotChildren][0].pid || null;
    controller.abort();

    await assert.rejects(
      withTimeout(execution, 1_000, "one-shot execution did not reject promptly after abort"),
      isAbortError,
    );
    await waitForPredicate(() => !processAlive(childPid), 2_000, "aborted one-shot provider child was not cleaned up");
    assert.equal(pool.oneShotChildren.size, 0);
  } finally {
    killProcessTree(childPid);
    await pool.stop().catch(() => null);
  }
});

test("AcpPool persistent request abort closes the reusable client and rejects AbortError", async () => {
  const tmp = await tempRoot("cpb-acp-persistent-abort");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });

  const controller = new AbortController();
  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "1",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgent,
        "--transcript-file",
        transcriptPath,
        "--stall-on-prompt",
      ]),
    },
  });

  let childPid: number | null = null;
  try {
    const execution = pool.execute("fake-acp", "persistent prompt that will abort", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-persistent-abort",
      phase: "execute",
      role: "executor",
      signal: controller.signal,
    });

    await waitForPredicate(() => pool.persistentClients.size === 1, 2_000, "persistent client was not started");
    childPid = [...pool.persistentClients.values()][0].client.child?.pid || null;
    controller.abort();

    await assert.rejects(
      withTimeout(execution, 1_000, "persistent execution did not reject promptly after abort"),
      isAbortError,
    );
    await waitForPredicate(() => !processAlive(childPid), 2_000, "aborted persistent provider child was not cleaned up");
    assert.equal(pool.persistentClients.size, 0);
  } finally {
    killProcessTree(childPid);
    await pool.stop().catch(() => null);
  }
});

test("AcpPool persistent abort cannot lose to a prompt that resolves during cancellation", async () => {
  const tmp = await tempRoot("cpb-acp-persistent-abort-race");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "1",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([testAgent, "--response", "warmup"]),
    },
  });

  let childPid: number | null = null;
  try {
    await pool.execute("fake-acp", "warmup", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-persistent-abort-race",
      phase: "execute",
      role: "executor",
    });
    const persistent = [...pool.persistentClients.values()][0];
    assert.ok(persistent);
    childPid = persistent.client.child?.pid || null;

    const controller = new AbortController();
    persistent.client.promptOnce = async () => {
      controller.abort();
      return "late-success-session";
    };

    await assert.rejects(
      pool.execute("fake-acp", "must abort", repoRoot, 10_000, {
        projectId: "proj",
        jobId: "job-persistent-abort-race",
        phase: "execute",
        role: "executor",
        signal: controller.signal,
      }),
      isAbortError,
    );
    await waitForPredicate(() => !processAlive(childPid), 2_000, "race-aborted persistent provider child was not cleaned up");
    assert.equal(pool.persistentClients.size, 0);
  } finally {
    killProcessTree(childPid);
    await pool.stop().catch(() => null);
  }
});

test("AcpPool one-shot uses ACP idle timeout before total phase timeout", async () => {
  const tmp = await tempRoot("cpb-acp-oneshot-idle-timeout");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "0",
      CPB_ACP_IDLE_TIMEOUT_MS: "300",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgent,
        "--transcript-file",
        transcriptPath,
        "--stall-on-prompt",
      ]),
    },
  });

  let childPid: number | null = null;
  try {
    const execution = pool.execute("fake-acp", "prompt that will idle", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-oneshot-idle-timeout",
      phase: "plan",
      role: "planner",
    });
    const observedExecution = execution.then(
      () => null,
      (error) => error as Error,
    );

    await waitForPredicate(() => pool.oneShotChildren.size === 1, 2_000, "one-shot child was not tracked");
    childPid = [...pool.oneShotChildren][0].pid || null;

    const executionError = await withTimeout(observedExecution, 3_000, "ACP idle timeout did not settle");
    assert.match(executionError?.message || "", /ACP prompt idle timed out after 300ms without activity/);
    await waitForPredicate(() => !processAlive(childPid), 2_000, "idle-timed-out provider child was not cleaned up");
  } finally {
    killProcessTree(childPid);
    await pool.stop().catch(() => null);
  }
});

test("AcpPool one-shot uses session-update idle timeout despite provider stderr activity", async () => {
  const tmp = await tempRoot("cpb-acp-oneshot-session-update-idle-timeout");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const transcriptPath = path.join(tmp, "transcript.jsonl");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_RTK_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "0",
      CPB_ACP_IDLE_TIMEOUT_MS: "5000",
      CPB_ACP_SESSION_UPDATE_IDLE_TIMEOUT_MS: "300",
      CPB_ACP_FAKE_ACP_COMMAND: process.execPath,
      CPB_ACP_FAKE_ACP_ARGS: JSON.stringify([
        testAgent,
        "--transcript-file",
        transcriptPath,
        "--stall-on-prompt",
        "--stderr-heartbeat-ms",
        "50",
      ]),
    },
  });

  let childPid: number | null = null;
  try {
    const execution = pool.execute("fake-acp", "prompt that will send stderr but no session updates", repoRoot, 10_000, {
      projectId: "proj",
      jobId: "job-oneshot-session-update-idle-timeout",
      phase: "execute",
      role: "executor",
    });
    const observedExecution = execution.then(
      () => null,
      (error) => error as Error,
    );

    await waitForPredicate(() => pool.oneShotChildren.size === 1, 2_000, "one-shot child was not tracked");
    childPid = [...pool.oneShotChildren][0].pid || null;

    const executionError = await withTimeout(observedExecution, 3_000, "ACP session-update idle timeout did not settle");
    assert.match(executionError?.message || "", /ACP session update idle timed out after 300ms without session updates/);
    await waitForPredicate(() => !processAlive(childPid), 2_000, "session-update-idle-timed-out provider child was not cleaned up");
  } finally {
    killProcessTree(childPid);
    await pool.stop().catch(() => null);
  }
});

test("AcpPool one-shot timeout gives wrapper enough time to clean detached provider", async () => {
  const tmp = await tempRoot("cpb-acp-oneshot-timeout-cleanup");
  const cpbRoot = path.join(tmp, "cpb");
  const hubRoot = path.join(tmp, "hub");
  const customClient = path.join(tmp, "slow-cleaning-client.mjs");
  const childPidFile = path.join(tmp, "provider.pid");
  await mkdir(cpbRoot, { recursive: true });
  await mkdir(hubRoot, { recursive: true });
  await writeFile(customClient, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "ignore",
});
writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
child.unref();

let shuttingDown = false;
process.on("SIGTERM", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => {
    try { process.kill(-child.pid, "SIGTERM"); } catch {
      try { process.kill(child.pid, "SIGTERM"); } catch {}
    }
    process.exit(143);
  }, 1200);
});

process.stdin.resume();
setInterval(() => {}, 1000);
`, "utf8");
  await chmod(customClient, 0o755);

  const pool = new AcpPool({
    cpbRoot,
    hubRoot,
    env: {
      ...process.env,
      ...sandboxTempEnv(tmp),
      CPB_AGENT_ISOLATE_HOME: "0",
      CPB_CODEGRAPH_ENABLED: "0",
      CPB_ACP_PERSISTENT_PROCESS: "0",
      CPB_ACP_CLIENT: customClient,
    },
  });

  let providerPid: number | null = null;
  try {
    const timeoutMs = 5_000;
    const execution = pool.execute("fake-acp", "prompt that times out", repoRoot, timeoutMs, {
      projectId: "proj",
      jobId: "job-oneshot-timeout-cleanup",
      phase: "plan",
      role: "planner",
    });
    const observedExecution = execution.then(
      () => null,
      (error) => error as Error,
    );
    await waitForPredicate(() => {
      try {
        providerPid = Number.parseInt(String(readFileSync(childPidFile, "utf8")), 10);
        return Number.isFinite(providerPid) && processAlive(providerPid);
      } catch {
        return false;
      }
    }, 5_000, "detached provider child was not started");

    const executionError = await withTimeout(observedExecution, 10_000, "one-shot timeout did not settle");
    assert.match(executionError?.message || "", new RegExp(`fake-acp timed out after ${timeoutMs}ms`));
    await waitForPredicate(() => !processAlive(providerPid), 2_000, "detached provider child was not cleaned up");
  } finally {
    killProcessTree(providerPid);
    await pool.stop().catch(() => null);
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
      ...sandboxTempEnv(tmp),
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
