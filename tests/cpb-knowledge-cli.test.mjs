import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("cpb knowledge policy exposes knowledge write boundaries", async () => {
  const { stdout } = await execFileAsync("./cpb", ["knowledge", "policy", "--json"], {
    cwd: process.cwd(),
    env: process.env,
  });
  const policy = JSON.parse(stdout);

  assert.ok(policy.automaticWrites.includes("session"));
  assert.ok(policy.semiAutomaticWrites.includes("project-memory"));
  assert.ok(policy.explicitConfirmationWrites.includes("global-memory"));
  assert.ok(policy.forbiddenMarkdownState.includes("queue"));
});
