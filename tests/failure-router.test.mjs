import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FailureKind, failure } from "../core/contracts/failure.js";
import { FailureRouter } from "../server/orchestrator/failure-router.js";

describe("FailureRouter", () => {
  it("does not retry non-retryable verification failures", async () => {
    const router = new FailureRouter();

    const decision = await router.route({
      assignment: { attempts: 0 },
      attempt: { attempt: 1 },
      result: {
        jobResult: {
          failure: failure({
            kind: FailureKind.VERIFICATION_FAILED,
            phase: "verify",
            reason: "focused hard gate failed",
            retryable: false,
            cause: { hardGate: true },
          }),
        },
      },
    });

    assert.equal(decision.action, "mark_failed");
    assert.equal(decision.retryable, false);
    assert.match(decision.reason, /non-retryable/);
  });

  it("still retries retryable verifier verdict failures", async () => {
    const router = new FailureRouter();

    const decision = await router.route({
      assignment: { attempts: 0 },
      attempt: { attempt: 1 },
      result: {
        jobResult: {
          failure: failure({
            kind: FailureKind.VERIFICATION_FAILED,
            phase: "verify",
            reason: "acceptance probe failed",
            retryable: true,
          }),
        },
      },
    });

    assert.equal(decision.action, "retry_same_worker");
    assert.equal(decision.retryable, true);
  });
});
