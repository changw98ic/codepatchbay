#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const client = path.join(root, "bridges", "acp-client.mjs");

function fixture(name) {
  return path.join(root, "tests", "fixtures", name);
}

async function runClient({ agentFixture, prompt, cwd }) {
  const child = spawn(
    process.execPath,
    [client, "--agent", "codex", "--cwd", cwd],
    {
      cwd: root,
      env: {
        ...process.env,
        CPB_ACP_CODEX_COMMAND: process.execPath,
        CPB_ACP_CODEX_ARGS: agentFixture,
        CPB_ACP_TIMEOUT_MS: "10000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  child.stdin.end(prompt);
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  return { exitCode, stdout, stderr };
}

// 1. Agent exits immediately (code 0) without sending any response
test("agent exits cleanly without response", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-proto-exit0-"));
  const { exitCode, stderr } = await runClient({
    agentFixture: fixture("fake-acp-agent-exit-clean.mjs"),
    cwd: tempDir,
    prompt: "do something\n",
  });

  assert.equal(exitCode, 1, "should exit with error when agent exits before responding");
  assert.match(stderr, /exited before completing requests/);
});

// 2. Agent exits with error code (code 1)
test("agent exits with error code 1", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-proto-exit1-"));
  const { exitCode, stderr } = await runClient({
    agentFixture: fixture("fake-acp-agent-exit-error.mjs"),
    cwd: tempDir,
    prompt: "do something\n",
  });

  assert.equal(exitCode, 1, "should exit with error when agent exits with code 1");
  assert.match(stderr, /exited before completing requests/);
});

// 3. Agent sends malformed JSON before valid responses
test("agent sends malformed JSON lines", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-proto-malformed-"));
  const { exitCode, stdout, stderr } = await runClient({
    agentFixture: fixture("fake-acp-agent-malformed.mjs"),
    cwd: tempDir,
    prompt: "do something\n",
  });

  assert.equal(exitCode, 0, "should complete despite malformed lines");
  assert.match(stdout, /done/);
  // Client should log the non-JSON lines to stderr
  assert.match(stderr, /non-JSON stdout/);
});

// 4. Agent sends response without id field
test("agent sends response without id field", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-proto-no-id-"));
  const { exitCode, stdout } = await runClient({
    agentFixture: fixture("fake-acp-agent-no-id.mjs"),
    cwd: tempDir,
    prompt: "do something\n",
  });

  // The id-less response is silently ignored (no matching pending request)
  assert.equal(exitCode, 0, "should complete despite response without id");
  assert.match(stdout, /done/);
});

// 5. Agent sends response with wrong (stale) id
test("agent sends response with stale id", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-proto-stale-id-"));
  const { exitCode, stdout } = await runClient({
    agentFixture: fixture("fake-acp-agent-wrong-method.mjs"),
    cwd: tempDir,
    prompt: "do something\n",
  });

  // The stale id response is silently ignored (no matching pending request)
  assert.equal(exitCode, 0, "should complete despite response with stale id");
  assert.match(stdout, /done/);
});

// 6. Large payload response (>10KB)
test("agent sends large payload (>10KB)", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-proto-large-"));
  const { exitCode, stdout } = await runClient({
    agentFixture: fixture("fake-acp-agent-large.mjs"),
    cwd: tempDir,
    prompt: "do something\n",
  });

  assert.equal(exitCode, 0, "should handle large payloads");
  // The 20KB of "A"s followed by "done"
  assert.match(stdout, /done/);
  assert.ok(stdout.length > 10 * 1024, `stdout should contain >10KB of data, got ${stdout.length} bytes`);
});

// 7. Agent sends partial response then exits
test("agent sends partial response then exits", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "cpb-proto-partial-"));
  const { exitCode, stderr } = await runClient({
    agentFixture: fixture("fake-acp-agent-partial-exit.mjs"),
    cwd: tempDir,
    prompt: "do something\n",
  });

  assert.equal(exitCode, 1, "should exit with error when agent dies mid-session");
  assert.match(stderr, /exited before completing requests/);
});
