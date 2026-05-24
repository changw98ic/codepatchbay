import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentCommand } from "../runtime/acp-client-core.mjs";

test("resolveAgentCommand returns a Promise (must be awaited)", async () => {
  // Regression: resolveAgentCommand does dynamic import, so it is async.
  // If AcpClient.start() forgets to await it, command/args become a Promise
  // object and spawn() fails with a confusing error.
  const result = resolveAgentCommand("codex", { ...process.env });
  assert.ok(result instanceof Promise, "resolveAgentCommand must return a Promise");
  // Actually await to ensure it resolves cleanly
  const resolved = await result;
  assert.ok(resolved, "resolved value must be truthy");
  assert.equal(typeof resolved.command, "string", "resolved.command must be a string");
  assert.ok(Array.isArray(resolved.args), "resolved.args must be an array");
});

test("resolveAgentCommand for unknown agent rejects", async () => {
  await assert.rejects(
    () => resolveAgentCommand("nonexistent-agent-xyz", { ...process.env }),
    /Unknown agent/
  );
});
