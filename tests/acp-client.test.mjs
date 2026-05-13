#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const client = path.join(root, "bridges", "acp-client.mjs");
const fakeAgent = path.join(root, "tests", "fixtures", "fake-acp-agent.mjs");
const fakeActiveAgent = path.join(root, "tests", "fixtures", "fake-active-acp-agent.mjs");

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
      FLOW_ACP_TIMEOUT_MS: "100",
    },
    prompt: "Stay active longer than the idle timeout, then finish.\n",
  });

  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /tick-4/);
}
