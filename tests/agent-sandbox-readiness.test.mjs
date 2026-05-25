import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAgentSandboxSelfTestCheck } from "../server/services/readiness-checks.js";

const tempDirs = [];

async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

describe("agent sandbox readiness", () => {
  afterEach(async () => {
    while (tempDirs.length) {
      await rm(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("skips the live sandbox self-test unless explicitly requested", async () => {
    const check = await runAgentSandboxSelfTestCheck({
      env: {},
      cwd: "/tmp/project",
    });

    assert.equal(check.id, "agent-sandbox-self-test");
    assert.equal(check.status, "skipped");
  });

  it("runs an opt-in live sandbox self-test through the configured wrapper", async () => {
    const root = await tempDir("cpb-agent-sandbox-readiness-");
    const wrapperPath = path.join(root, "sandbox-wrapper.sh");
    await writeExecutable(wrapperPath, `#!/bin/sh
printf '%s\\n' "$@" > "$CPB_ROOT/self-test-args.txt"
exec "$@"
`);

    const check = await runAgentSandboxSelfTestCheck({
      env: {
        CPB_ROOT: root,
        CPB_AGENT_SANDBOX: "required",
        CPB_AGENT_SANDBOX_COMMAND: wrapperPath,
        CPB_AGENT_SANDBOX_SELF_TEST: "1",
        PATH: process.env.PATH,
      },
      cwd: root,
    });

    assert.equal(check.id, "agent-sandbox-self-test");
    assert.equal(check.status, "ok");
    assert.equal(check.details.exitCode, 0);
    const argsText = await readFile(path.join(root, "self-test-args.txt"), "utf8");
    assert.match(argsText, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("fails the opt-in self-test when required sandboxing is unavailable", async () => {
    const check = await runAgentSandboxSelfTestCheck({
      env: {
        CPB_AGENT_SANDBOX: "required",
        CPB_AGENT_SANDBOX_SELF_TEST: "1",
      },
      cwd: "/tmp/project",
      platform: "linux",
      probe: () => false,
    });

    assert.equal(check.id, "agent-sandbox-self-test");
    assert.equal(check.status, "error");
    assert.match(check.message, /not enforceable|unavailable/);
  });
});
