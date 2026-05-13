#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const client = path.join(root, "bridges", "acp-client.mjs");
const fakeAgent = path.join(root, "tests", "fixtures", "fake-acp-agent.mjs");
const fakeActiveAgent = path.join(root, "tests", "fixtures", "fake-active-acp-agent.mjs");
const fakeHandoffAgent = path.join(root, "tests", "fixtures", "fake-acp-agent-handoff.mjs");
const fakeBadHandoffAgent = path.join(root, "tests", "fixtures", "fake-acp-agent-bad-handoff.mjs");

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
