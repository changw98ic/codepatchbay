import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runAgent } from "../core/agents/agent-runner.js";
import { FailureKind } from "../core/contracts/failure.js";

describe("runAgent error classification", () => {
  it("classifies Claude 529 overload as retryable rate limit", async () => {
    const pool = {
      async execute() {
        const err = new Error("API Error 529: 该模型当前访问量过大");
        err.code = 529;
        throw err;
      },
    };

    const result = await runAgent({
      role: "executor",
      agent: "claude",
      project: "proj",
      prompt: "do work",
      cwd: process.cwd(),
      pool,
    });

    assert.equal(result.ok, false);
    assert.equal(result.kind, FailureKind.AGENT_RATE_LIMITED);
    assert.equal(result.retryable, true);
    assert.equal(result.cause.providerKey, "claude");
    assert.ok(result.cause.nextEligibleAt > Date.now());
  });
});
