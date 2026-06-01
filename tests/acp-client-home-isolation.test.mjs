import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { shouldIsolateAgentHome } from "../runtime/acp-client-core.mjs";

describe("ACP client HOME isolation", () => {
  it("does not isolate browser-agent so it can reuse the logged-in browser profile", () => {
    assert.equal(shouldIsolateAgentHome("browser-agent", {}), false);
  });

  it("keeps HOME isolation for other ACP agents by default", () => {
    assert.equal(shouldIsolateAgentHome("claude", {}), true);
    assert.equal(shouldIsolateAgentHome("codex", {}), true);
  });

  it("honors the global isolation opt-out", () => {
    assert.equal(shouldIsolateAgentHome("claude", { CPB_AGENT_ISOLATE_HOME: "0" }), false);
  });
});
