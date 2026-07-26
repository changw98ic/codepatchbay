import assert from "node:assert/strict";
import { test } from "node:test";

import { loadRegistry, resolveAgentEnvPrefix } from "../core/agents/registry.js";
import {
  buildMcpServers,
  resolveAgentCommand,
} from "../server/services/acp/acp-client.js";

test("ACP agent environment prefixes canonicalize legal agent ids without reading raw punctuation keys", async () => {
  assert.equal(resolveAgentEnvPrefix("fake-acp"), "CPB_ACP_FAKE_ACP");
  assert.equal(resolveAgentEnvPrefix("browser-agent"), "CPB_ACP_BROWSER_AGENT");
  assert.equal(resolveAgentEnvPrefix("custom.agent_v2"), "CPB_ACP_CUSTOM_AGENT_V2");
  assert.throws(() => resolveAgentEnvPrefix("../../PATH"), /invalid ACP agent name/i);

  const resolved = await resolveAgentCommand("custom-agent", {
    CPB_ACP_CUSTOM_AGENT_COMMAND: process.execPath,
    CPB_ACP_CUSTOM_AGENT_ARGS: JSON.stringify(["--version"]),
    "CPB_ACP_CUSTOM-AGENT_COMMAND": "must-not-be-read",
  });
  assert.deepEqual(resolved, {
    command: process.execPath,
    args: ["--version"],
  });
});

test("ACP session MCP injection follows explicit adapter capability", async () => {
  await loadRegistry("");
  const env = {
    CPB_CODEGRAPH_ENABLED: "1",
    CPB_CODEGRAPH_ROOT: "/tmp/project",
    CPB_CODEGRAPH_PORT: "43101",
  };

  assert.deepEqual(buildMcpServers("claude-glm", env), []);
  assert.deepEqual(buildMcpServers("claude-mimo", env), []);
  assert.deepEqual(buildMcpServers("claude", env), []);
  assert.deepEqual(buildMcpServers("codex", env), []);
  assert.deepEqual(buildMcpServers("custom-acp", env), [{
    name: "codegraph",
    type: "sse",
    url: "http://localhost:43101",
  }]);
});
