import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizedSourceContext } from "../server/orchestrator/hub-orchestrator.js";
import { buildRetrySourceContext } from "../server/orchestrator/reconciler.js";

describe("hub orchestrator source context normalization", () => {
  it("preserves flat GitHub queue metadata as sourceContext", () => {
    const context = normalizedSourceContext({
      id: "q-1",
      type: "github_issue",
      metadata: {
        source: "github",
        issueNumber: 529,
        issueUrl: "https://github.com/acme/repo/issues/529",
        repo: "acme/repo",
        issueTitle: "Fix retry context",
        actor: "chengwen",
        sourceContext: {
          correction: {
            failureKind: "verification_failed",
            failureReason: "npm test failed",
          },
        },
      },
    });

    assert.equal(context.type, "github_issue");
    assert.equal(context.queueEntryId, "q-1");
    assert.equal(context.issueNumber, 529);
    assert.equal(context.repo, "acme/repo");
    assert.equal(context.correction.failureReason, "npm test failed");
  });

  it("builds correction context for automatic retry", () => {
    const context = buildRetrySourceContext(
      {
        sourceContext: { type: "github_issue", issueNumber: 7 },
        attempts: 1,
      },
      { attempt: 1 },
      {
        jobResult: {
          jobId: "job-1",
          failure: {
            kind: "verification_failed",
            phase: "verify",
            reason: "npm test failed",
            retryable: false,
            cause: {
              hardGate: true,
              checks: [{ command: "npm test", stdoutTail: "failing test name", stderrTail: "" }],
            },
          },
        },
      },
      { action: "retry_same_worker", reason: "repairable failure", retryable: true },
    );

    assert.equal(context.type, "github_issue");
    assert.equal(context.issueNumber, 7);
    assert.equal(context.correction.failureKind, "verification_failed");
    assert.equal(context.correction.previousJobId, "job-1");
    assert.match(context.correction.previousOutput, /failing test name/);
  });
});
