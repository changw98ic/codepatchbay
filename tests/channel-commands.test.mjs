import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseChannelCommand } from "../server/services/channel-commands.js";

describe("parseChannelCommand job actions", () => {
  it("accepts supported job action commands", () => {
    for (const action of ["approve", "cancel", "retry", "status", "logs"]) {
      const parsed = parseChannelCommand(`/cpb ${action} job-q-abc123-def4 extra words`);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.type, action);
      assert.equal(parsed.job, "job-q-abc123-def4");
    }
  });

  it("rejects unknown commands", () => {
    const parsed = parseChannelCommand("/cpb deny job-q-abc123-def4");
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "UNKNOWN_COMMAND");
  });
});
