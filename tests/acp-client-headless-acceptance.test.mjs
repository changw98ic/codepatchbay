#!/usr/bin/env node
/**
 * Issue #62 acceptance tests: headless ACP profile, UI tool denial,
 * explicit UI lane, mcpServers assertion.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveAgentCommand } from "../bridges/acp-client.mjs";

const root = path.resolve(import.meta.dirname, "..");
const client = path.join(root, "bridges", "acp-client.mjs");
const fakeAgent = path.join(root, "tests", "fixtures", "fake-acp-agent.mjs");
const fakeUiToolsAgent = path.join(root, "tests", "fixtures", "fake-acp-agent-ui-tools.mjs");

// Strip permission-matrix env vars so writes to temp dirs aren't blocked
const permissionEnvKeys = [
  "CPB_EXECUTOR_ROOT", "CPB_ROOT", "CPB_ACP_CPB_ROOT",
  "CPB_ACP_ROLE", "CPB_ACP_PROJECT", "CPB_ACP_JOB_ID", "CPB_ACP_PHASE",
];

async function runClient({ env, prompt, cwd }) {
  const cleanEnv = { ...process.env };
  for (const key of permissionEnvKeys) delete cleanEnv[key];
  const child = spawn(process.execPath, [client, "--agent", "codex", "--cwd", cwd], {
    cwd: root,
    env: { ...cleanEnv, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  child.stdin.end(prompt);
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  return { exitCode, stdout, stderr };
}

// --- resolveAgentCommand appends headless config overrides for codex-acp ---
{
  const { command, args } = resolveAgentCommand("codex", {
    CPB_ACP_CODEX_COMMAND: "codex-acp",
  });
  assert.equal(command, "codex-acp");
  assert.ok(args.some((a) => a.includes("computer-use")), "headless args must include computer-use disable");
  assert.ok(args.some((a) => a.includes("browser")), "headless args must include browser disable");
  assert.ok(args.some((a) => a.includes("chrome")), "headless args must include chrome disable");
  assert.ok(args.some((a) => a.includes("notify=[]")), "headless args must include notify=[]");
}

// --- resolveAgentCommand appends headless config overrides for npx codex-acp ---
{
  const { command, args } = resolveAgentCommand("codex", {
    CPB_ACP_CODEX_COMMAND: "npx",
    CPB_ACP_CODEX_ARGS: '["-y", "@zed-industries/codex-acp"]',
  });
  assert.equal(command, "npx");
  assert.ok(args.some((a) => a.includes("computer-use")));
  assert.ok(args.some((a) => a.includes("notify=[]")));
}

// --- resolveAgentCommand skips headless args when profile is ui ---
{
  const { command, args } = resolveAgentCommand("codex", {
    CPB_ACP_CODEX_COMMAND: "codex-acp",
    CPB_ACP_LAUNCH_PROFILE: "ui",
  });
  assert.equal(command, "codex-acp");
  assert.ok(!args.some((a) => a.includes("notify=[]")), "ui profile must not append headless args");
}

// --- resolveAgentCommand skips headless args for non-codex commands ---
{
  const { command, args } = resolveAgentCommand("claude", {
    CPB_ACP_CLAUDE_COMMAND: "claude-agent-acp",
  });
  assert.equal(command, "claude-agent-acp");
  assert.ok(!args.some((a) => a.includes("computer-use")), "claude agent must not get codex headless args");
}

// --- resolveAgentCommand skips headless args for custom (fake) Node agents ---
{
  const { command, args } = resolveAgentCommand("codex", {
    CPB_ACP_CODEX_COMMAND: process.execPath,
    CPB_ACP_CODEX_ARGS: fakeAgent,
  });
  assert.equal(command, process.execPath);
  assert.ok(!args.some((a) => a.includes("computer-use")), "fake Node agent must not get headless args");
}

// --- Headless mode denies UI tool calls and allows non-UI tools ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-acp-headless-ui-"));
  const markerFile = path.join(tempDir, "ui-marker.txt");

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: fakeUiToolsAgent,
      CPB_ACP_LAUNCH_PROFILE: "headless",
      CPB_UI_TOOL_MARKER: markerFile,
    },
    prompt: "Test UI tool denial\n",
  });

  assert.equal(exitCode, 0, stderr);
  assert.ok(existsSync(markerFile), "non-UI tool must succeed in headless mode");
  const marker = await readFile(markerFile, "utf8");
  assert.equal(marker, "non-ui-tool-succeeded");
  assert.match(stdout, /AGENT_DONE/);
}

// --- UI profile mode allows UI tool calls to pass through ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-acp-ui-profile-"));
  const markerFile = path.join(tempDir, "ui-marker.txt");

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: fakeUiToolsAgent,
      CPB_ACP_LAUNCH_PROFILE: "ui",
      CPB_UI_TOOL_MARKER: markerFile,
    },
    prompt: "Test UI tool passthrough\n",
  });

  assert.equal(exitCode, 0, stderr);
  assert.ok(existsSync(markerFile), "non-UI tool must succeed in ui mode");
  assert.ok(!stderr.includes("UI tool denied"), "ui profile must not deny UI tools");
  assert.match(stdout, /AGENT_DONE/);
}

// --- session/new payload sends mcpServers: [] (validated by fake agent) ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-acp-mcp-check-"));
  const markerFile = path.join(tempDir, "ui-marker.txt");

  const { exitCode, stderr } = await runClient({
    cwd: tempDir,
    env: {
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: fakeUiToolsAgent,
      CPB_ACP_LAUNCH_PROFILE: "headless",
      CPB_UI_TOOL_MARKER: markerFile,
    },
    prompt: "Test mcpServers payload\n",
  });

  assert.equal(exitCode, 0, stderr);
}

// ============================================================
// Issue #62: Deterministic process-tree prevention evidence
// ============================================================

// --- Headless codex-acp launch via PATH records no SkyComputerUseClient mcp child ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-acp-headless-pt-"));
  const markerFile = path.join(tempDir, "headless-args-marker.txt");
  const processTreeFile = path.join(tempDir, "process-tree-marker.txt");

  // Create a wrapper script named "codex-acp" that delegates to the Node.js fake agent
  const fakeCodexPath = path.join(tempDir, "codex-acp");
  const agentScript = path.join(root, "tests", "fixtures", "fake-codex-acp-headless.mjs");
  await writeFile(fakeCodexPath, `#!/bin/bash\nexec ${process.execPath} "${agentScript}" "$@"\n`, { mode: 0o755 });

  // Build a clean env with our fake codex-acp on PATH
  const cleanEnv = { ...process.env };
  for (const key of permissionEnvKeys) delete cleanEnv[key];
  // Delete ACP command overrides so the client falls back to PATH lookup
  delete cleanEnv.CPB_ACP_CODEX_COMMAND;
  delete cleanEnv.CPB_ACP_CODEX_ARGS;
  cleanEnv.PATH = `${tempDir}:${cleanEnv.PATH || ""}`;
  cleanEnv.CPB_HEADLESS_ARGS_MARKER = markerFile;
  cleanEnv.CPB_HEADLESS_PROCESS_TREE = processTreeFile;
  cleanEnv.CPB_ACP_TIMEOUT_MS = "30000";

  const child = spawn(process.execPath, [client, "--agent", "codex", "--cwd", tempDir], {
    cwd: root,
    env: cleanEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end("Test process tree\n");
  const exitCode = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(exitCode, 0, `client must exit cleanly: ${stderr}`);

  // Read recorded args — verify all headless overrides present
  const markerContent = await readFile(markerFile, "utf8");
  const recordedArgs = JSON.parse(markerContent);
  assert.ok(recordedArgs.some((a) => a.includes("computer-use")), "headless args must include computer-use disable");
  assert.ok(recordedArgs.some((a) => a.includes("browser")), "headless args must include browser disable");
  assert.ok(recordedArgs.some((a) => a.includes("chrome")), "headless args must include chrome disable");
  assert.ok(recordedArgs.some((a) => a.includes("notify=[]")), "headless args must include notify=[]");

  // Read process-tree marker — verify no SkyComputerUseClient mcp child
  const ptContent = await readFile(processTreeFile, "utf8");
  const pt = JSON.parse(ptContent);
  assert.equal(pt.skyComputerUseClientMcp, false, "process-tree must NOT contain SkyComputerUseClient mcp child");
  assert.equal(pt.allOverridesPresent, true, "all headless overrides must be present in spawned process");
  assert.deepEqual(pt.missingOverrides, [], "no overrides should be missing");
  assert.ok(Array.isArray(pt.children) && pt.children.length === 0, "children array must be empty (no MCP servers mounted)");
}

// ============================================================
// Issue #62: Auditable headless UI denial evidence
// ============================================================

// --- Denied headless UI call persists ui-tool-denied event with full metadata ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-acp-ui-denial-"));
  const markerFile = path.join(tempDir, "ui-marker.txt");
  // Set up temp CPB root for event storage
  const cpbRoot = tempDir;
  const eventsDir = path.join(cpbRoot, "cpb-task", "events", "testproj");
  await mkdir(eventsDir, { recursive: true });

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      // ACP agent config
      CPB_ACP_CODEX_COMMAND: process.execPath,
      CPB_ACP_CODEX_ARGS: fakeUiToolsAgent,
      CPB_ACP_LAUNCH_PROFILE: "headless",
      CPB_UI_TOOL_MARKER: markerFile,
      // Permission matrix context for durable denial audit
      CPB_EXECUTOR_ROOT: root,
      CPB_ROOT: cpbRoot,
      CPB_ACP_CPB_ROOT: cpbRoot,
      CPB_ACP_ROLE: "executor",
      CPB_ACP_PROJECT: "testproj",
      CPB_ACP_JOB_ID: "job-denial-test-001",
      CPB_ACP_PHASE: "execute",
    },
    prompt: "Test UI tool denial audit\n",
  });

  assert.equal(exitCode, 0, stderr);

  // Read the event log and look for ui-tool-denied event
  const eventLogFile = path.join(eventsDir, "job-denial-test-001.jsonl");
  let logContent;
  try {
    logContent = await readFile(eventLogFile, "utf8");
  } catch {
    // Event log might not exist if denial recording was skipped
    logContent = "";
  }

  const events = logContent.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const denialEvents = events.filter((e) => e.action === "ui-tool-denied");

  assert.ok(denialEvents.length > 0, "must have at least one ui-tool-denied event in the event log");
  const first = denialEvents[0];
  assert.equal(first.action, "ui-tool-denied", "event action must be ui-tool-denied");
  assert.equal(first.jobId, "job-denial-test-001", "event must carry jobId");
  assert.equal(first.phase, "execute", "event must carry phase");
  assert.equal(first.role, "executor", "event must carry role");
  assert.ok(first.tool, "event must carry the denied tool name");
  assert.ok(first.reason.includes("headless"), "event reason must mention headless");
  assert.match(stdout, /AGENT_DONE/);
}
