#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const client = path.join(root, "bridges", "acp-client.mjs");
const fakeAgent = path.join(root, "tests", "fixtures", "fake-acp-agent.mjs");
const fakeActiveAgent = path.join(root, "tests", "fixtures", "fake-active-acp-agent.mjs");
const fakeHandoffAgent = path.join(root, "tests", "fixtures", "fake-acp-agent-handoff.mjs");
const fakeBadHandoffAgent = path.join(root, "tests", "fixtures", "fake-acp-agent-bad-handoff.mjs");
const fakeTerminalAgent = path.join(root, "tests", "fixtures", "fake-acp-agent-terminal.mjs");

async function runClient({ env, prompt, cwd }) {
  const child = spawn(process.execPath, [client, "--agent", "codex", "--cwd", cwd], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.end(prompt);
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  return { exitCode, stdout, stderr };
}

{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-client-"));
  const outputFile = path.join(tempDir, "plan-001.md");

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeAgent,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /Written through ACP fs\/write_text_file/);
  assert.match(stdout, /done/);
}

{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-active-"));
  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeActiveAgent,
      FLOW_ACP_TIMEOUT_MS: "30000",
      FLOW_TEST_ACTIVE_TICK_MS: "7500",
      FLOW_TEST_ACTIVE_TICKS: "5",
    },
    prompt: "Stay active longer than the idle timeout, then finish.\n",
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /tick-5/);
}

// --- Atomic write: no leftover temp files ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-atomic-"));
  const outputFile = path.join(tempDir, "output.txt");

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeAgent,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);

  // File was written via atomic rename (target exists with correct content)
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /Written through ACP fs\/write_text_file/);

  // No leftover temp files in the directory
  const files = await readdir(tempDir);
  const tmpFiles = files.filter((f) => f.startsWith(".flow-tmp-"));
  assert.equal(tmpFiles.length, 0, `leftover temp files: ${tmpFiles.join(", ")}`);
}

// --- Non-handoff file (non-wiki path) skips validation ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-no-handoff-"));
  const outputFile = path.join(tempDir, "plan-001.md");

  // Uses default fake agent which writes content WITHOUT handoff markers.
  // Path does not match wiki/projects/*/inbox/* so validation is skipped.
  const { exitCode, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeAgent,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /Written through ACP fs\/write_text_file/);
}

// --- Valid handoff file (wiki path + valid content) passes validation ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-handoff-ok-"));
  const wikiDir = path.join(tempDir, "wiki", "projects", "testproj", "inbox");
  const outputFile = path.join(wikiDir, "plan-001.md");

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeHandoffAgent,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /## Handoff/);
  assert.match(output, /## Acceptance-Criteria/);
  assert.match(stdout, /done/);
}

// --- Missing handoff markers on wiki path fails validation ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-handoff-bad-"));
  const wikiDir = path.join(tempDir, "wiki", "projects", "testproj", "inbox");
  const outputFile = path.join(wikiDir, "plan-001.md");

  const { exitCode, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeBadHandoffAgent,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${outputFile}\n`,
  });

  // The validation error is caught by handleClientRequest and sent back as a
  // JSON-RPC error response to the agent. The client process itself exits 0.
  // The key observable: the target file must NOT exist because the write was
  // rejected before writeFile was called.
  assert.equal(exitCode, 0, "client exits cleanly even when agent write is rejected");
  let fileExists = false;
  try { await readFile(outputFile, "utf8"); fileExists = true; } catch { /* expected */ }
  assert.equal(fileExists, false, "file must not exist when handoff validation fails");
}

// --- Wiki deliverable path also validates ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-deliverable-ok-"));
  const wikiDir = path.join(tempDir, "wiki", "projects", "testproj", "outputs");
  const outputFile = path.join(wikiDir, "deliverable-001.md");

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeHandoffAgent,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /## Handoff/);
  assert.match(output, /## Acceptance-Criteria/);
  assert.match(stdout, /done/);
}

// --- writeAllowPaths blocks write to disallowed path ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-write-blocked-"));
  const allowedDir = path.join(tempDir, "wiki", "projects", "myproj", "inbox");
  const blockedFile = path.join(tempDir, "etc", "passwd");

  const { exitCode } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeAgent,
      FLOW_ACP_WRITE_ALLOW: `${allowedDir}/*`,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${blockedFile}\n`,
  });

  assert.equal(exitCode, 0, "client exits cleanly even when write is blocked");
  let fileExists = false;
  try { await readFile(blockedFile, "utf8"); fileExists = true; } catch { /* expected */ }
  assert.equal(fileExists, false, "blocked file must not exist");
}

// --- writeAllowPaths allows write to matched path ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-write-allowed-"));
  const allowedDir = path.join(tempDir, "wiki", "projects", "myproj", "inbox");
  const allowedFile = path.join(allowedDir, "plan-001.md");

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeHandoffAgent,
      FLOW_ACP_WRITE_ALLOW: `${allowedDir}/*`,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${allowedFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(allowedFile, "utf8");
  assert.match(output, /## Handoff/);
  assert.match(output, /## Acceptance-Criteria/);
  assert.match(stdout, /done/);
}

// --- null writeAllowPaths allows all writes (backward compatible) ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-write-norestrict-"));
  const outputFile = path.join(tempDir, "anywhere", "output.txt");

  // No FLOW_ACP_WRITE_ALLOW set — null by default, all writes allowed
  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeAgent,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /Written through ACP fs\/write_text_file/);
  assert.match(stdout, /done/);
}

// --- terminalPolicy 'deny' blocks terminal creation ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-terminal-deny-"));

  const { exitCode } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeTerminalAgent,
      FLOW_ACP_TERMINAL: "deny",
    },
    prompt: `Run command: echo hello\n`,
  });

  assert.equal(exitCode, 0, "client exits cleanly even when terminal is denied");
}

// --- terminalPolicy 'allow' (default) allows terminal creation ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-terminal-allow-"));

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeTerminalAgent,
      // FLOW_ACP_TERMINAL not set — defaults to "allow"
    },
    prompt: `Run command: echo hello\n`,
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /done/);
}

// --- FLOW_ACP_WRITE_ALLOW env var with glob patterns is parsed correctly ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-write-envvar-"));
  const inboxDir = path.join(tempDir, "wiki", "projects", "proj", "inbox");
  const outputsDir = path.join(tempDir, "wiki", "projects", "proj", "outputs");

  // Set two glob patterns via env var, use handoff agent for wiki paths
  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeHandoffAgent,
      FLOW_ACP_WRITE_ALLOW: `${inboxDir}/*,${outputsDir}/*`,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${inboxDir}/plan-001.md\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(path.join(inboxDir, "plan-001.md"), "utf8");
  assert.match(output, /## Handoff/);
  assert.match(stdout, /done/);

  // Verify a path outside both patterns is blocked
  const blockedDir = await mkdtemp(path.join(tmpdir(), "flow-acp-write-envvar-blocked-"));
  const blockedFile = path.join(blockedDir, "etc", "shadow");

  const { exitCode: exitCode2 } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeAgent,
      FLOW_ACP_WRITE_ALLOW: `${inboxDir}/*,${outputsDir}/*`,
    },
    prompt: `Generate a plan.\nWrite the plan to: ${blockedFile}\n`,
  });

  assert.equal(exitCode2, 0);
  let blockedExists = false;
  try { await readFile(blockedFile, "utf8"); blockedExists = true; } catch { /* expected */ }
  assert.equal(blockedExists, false, "blocked file must not exist");
}

// ============================================================
// Per-tool ACP policy tests
// ============================================================

const fakeToolPolicyAgent = path.join(root, "tests", "fixtures", "fake-acp-agent-tool-policy.mjs");

// --- FLOW_ACP_DENY_TOOLS blocks denied tools ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-deny-tools-"));
  const outputFile = path.join(tempDir, "output.txt");

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_DENY_TOOLS: "fs/write_text_file,terminal/create",
    },
    prompt: `ACTION: write_file\nACTION: terminal\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  // The write was denied, so the file must not exist
  let fileExists = false;
  try { await readFile(outputFile, "utf8"); fileExists = true; } catch { /* expected */ }
  assert.equal(fileExists, false, "denied tool: file must not exist");
  assert.match(stdout, /done/);
}

// --- FLOW_ACP_DENY_TOOLS blocks terminal/create ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-deny-terminal-"));

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_DENY_TOOLS: "terminal/create",
    },
    prompt: `ACTION: terminal\n`,
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /done/);
}

// --- FLOW_ACP_ALLOW_TOOLS overrides FLOW_ACP_DENY_TOOLS for same tool ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-allow-override-"));
  const outputFile = path.join(tempDir, "output.txt");

  // fs/write_text_file appears in both DENY and ALLOW — ALLOW takes precedence
  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_DENY_TOOLS: "fs/write_text_file,terminal/create",
      FLOW_ACP_ALLOW_TOOLS: "fs/write_text_file",
    },
    prompt: `ACTION: write_file\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  // write was allowed (ALLOW overrides DENY for same tool)
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /Written by tool-policy agent/);
  assert.match(stdout, /done/);
}

// --- JSON policy file loads and enforces correctly ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-policy-file-"));
  const outputFile = path.join(tempDir, "output.txt");
  const policyFile = path.join(tempDir, "policy.json");

  await writeFile(policyFile, JSON.stringify({
    "fs/write_text_file": "deny",
    "terminal/create": "deny",
    "fs/read_text_file": "allow",
  }));

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_TOOL_POLICY_FILE: policyFile,
    },
    prompt: `ACTION: write_file\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  let fileExists = false;
  try { await readFile(outputFile, "utf8"); fileExists = true; } catch { /* expected */ }
  assert.equal(fileExists, false, "policy file: denied write must not create file");
  assert.match(stdout, /done/);
}

// --- JSON policy file allows explicitly allowed tools ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-policy-file-allow-"));
  const outputFile = path.join(tempDir, "output.txt");
  const policyFile = path.join(tempDir, "policy.json");

  await writeFile(policyFile, JSON.stringify({
    "fs/write_text_file": "allow",
  }));

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_TOOL_POLICY_FILE: policyFile,
    },
    prompt: `ACTION: write_file\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /Written by tool-policy agent/);
  assert.match(stdout, /done/);
}

// --- Invalid JSON policy file: fail closed ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-policy-bad-json-"));
  const policyFile = path.join(tempDir, "policy.json");

  await writeFile(policyFile, "{ this is not valid JSON }}}");

  const { exitCode, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_TOOL_POLICY_FILE: policyFile,
    },
    prompt: "should not matter\n",
  });

  assert.equal(exitCode, 1, "must exit with error on invalid JSON");
  assert.match(stderr, /invalid JSON/);
}

// --- Non-existent policy file: fail closed ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-policy-no-file-"));

  const { exitCode, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_TOOL_POLICY_FILE: "/tmp/nonexistent-flow-policy-xyz.json",
    },
    prompt: "should not matter\n",
  });

  assert.equal(exitCode, 1, "must exit with error on missing policy file");
  assert.match(stderr, /failed to read/);
}

// --- Policy file with invalid action: fail closed ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-policy-bad-action-"));
  const policyFile = path.join(tempDir, "policy.json");

  await writeFile(policyFile, JSON.stringify({ "fs/write_text_file": "maybe" }));

  const { exitCode, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_TOOL_POLICY_FILE: policyFile,
    },
    prompt: "should not matter\n",
  });

  assert.equal(exitCode, 1, "must exit with error on invalid action");
  assert.match(stderr, /invalid action/);
}

// --- Policy file with array instead of object: fail closed ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-policy-array-"));
  const policyFile = path.join(tempDir, "policy.json");

  await writeFile(policyFile, JSON.stringify(["fs/write_text_file"]));

  const { exitCode, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_TOOL_POLICY_FILE: policyFile,
    },
    prompt: "should not matter\n",
  });

  assert.equal(exitCode, 1, "must exit with error on array policy");
  assert.match(stderr, /expected a JSON object/);
}

// --- Backward compat: FLOW_ACP_TERMINAL=deny still works ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-terminal-backcompat-"));

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_TERMINAL: "deny",
    },
    prompt: `ACTION: terminal\n`,
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /done/);
}

// --- Backward compat: FLOW_ACP_TERMINAL=deny does NOT block fs/write_text_file ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-terminal-write-ok-"));
  const outputFile = path.join(tempDir, "output.txt");

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_TERMINAL: "deny",
    },
    prompt: `ACTION: write_file\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /Written by tool-policy agent/);
  assert.match(stdout, /done/);
}

// --- Priority: TOOL_POLICY_FILE overrides FLOW_ACP_DENY_TOOLS ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-priority-file-"));
  const outputFile = path.join(tempDir, "output.txt");
  const policyFile = path.join(tempDir, "policy.json");

  // Policy file says "allow" for write, env says "deny" — file wins
  await writeFile(policyFile, JSON.stringify({ "fs/write_text_file": "allow" }));

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_TOOL_POLICY_FILE: policyFile,
      FLOW_ACP_DENY_TOOLS: "fs/write_text_file",
    },
    prompt: `ACTION: write_file\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /Written by tool-policy agent/);
  assert.match(stdout, /done/);
}

// --- Priority: DENY_TOOLS overrides FLOW_ACP_TERMINAL ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-priority-env-"));
  const outputFile = path.join(tempDir, "output.txt");

  // FLOW_ACP_TERMINAL=deny but DENY_TOOLS allows terminal/create — DENY_TOOLS wins
  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_DENY_TOOLS: "fs/write_text_file",
      FLOW_ACP_ALLOW_TOOLS: "terminal/create",
      FLOW_ACP_TERMINAL: "deny",
    },
    prompt: `ACTION: terminal\n`,
  });

  // terminal/create should be allowed (ALLOW_TOOLS overrides legacy TERMINAL=deny)
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /done/);
}

// --- No policy set: all tools allowed (default behavior) ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-no-policy-"));
  const outputFile = path.join(tempDir, "output.txt");

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
    },
    prompt: `ACTION: write_file\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /Written by tool-policy agent/);
  assert.match(stdout, /done/);
}

// --- Tools not in policy are allowed through ---
{
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-acp-policy-passthrough-"));
  const outputFile = path.join(tempDir, "output.txt");
  const policyFile = path.join(tempDir, "policy.json");

  // Only deny terminal/create; fs/write_text_file has no entry → allowed
  await writeFile(policyFile, JSON.stringify({ "terminal/create": "deny" }));

  const { exitCode, stdout, stderr } = await runClient({
    cwd: tempDir,
    env: {
      FLOW_ACP_CODEX_COMMAND: process.execPath,
      FLOW_ACP_CODEX_ARGS: fakeToolPolicyAgent,
      FLOW_ACP_TOOL_POLICY_FILE: policyFile,
    },
    prompt: `ACTION: write_file\nWrite the plan to: ${outputFile}\n`,
  });

  assert.equal(exitCode, 0, stderr);
  const output = await readFile(outputFile, "utf8");
  assert.match(output, /Written by tool-policy agent/);
  assert.match(stdout, /done/);
}
