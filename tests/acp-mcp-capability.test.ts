import assert from "node:assert/strict";
import { test } from "node:test";

import { loadRegistry } from "../core/agents/registry.js";
import { buildMcpServers } from "../server/services/acp/acp-client.js";

test("ACP session MCP injection follows explicit adapter capability", async () => {
  await loadRegistry("");
  const env = {
    CPB_CODEGRAPH_ENABLED: "1",
    CPB_CODEGRAPH_ROOT: "/tmp/project",
    CPB_CODEGRAPH_PORT: "43101",
  };

  assert.deepEqual(buildMcpServers("claude-glm", env), []);
  assert.deepEqual(buildMcpServers("claude", env), []);
  assert.deepEqual(buildMcpServers("codex", env), []);
  assert.deepEqual(buildMcpServers("custom-acp", env), [{
    name: "codegraph",
    type: "sse",
    url: "http://localhost:43101",
  }]);
});
