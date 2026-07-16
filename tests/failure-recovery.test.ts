import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import {
  FailureClass,
  classifyFailure,
  failureEvidence,
  selectFailureRecovery,
  stableFailureFingerprint,
} from "../core/contracts/failure-recovery.js";

test("failure taxonomy covers the requested semantic recovery classes", () => {
  assert.equal(classifyFailure({ kind: FailureKind.ISSUE_MISMATCH }), FailureClass.TASK_UNDERSTANDING);
  assert.equal(classifyFailure({ kind: FailureKind.SCOPE_VIOLATION }), FailureClass.LOCATION);
  assert.equal(classifyFailure({ kind: FailureKind.VERIFICATION_FAILED }), FailureClass.IMPLEMENTATION);
  assert.equal(classifyFailure({ kind: FailureKind.BROAD_TEST_COMMAND_DENIED }), FailureClass.TEST_SELECTION);
  assert.equal(classifyFailure({ kind: FailureKind.RUNTIME_INTERRUPTED }), FailureClass.ENVIRONMENT);
  assert.equal(classifyFailure({ kind: FailureKind.AGENT_SPAWN_ERROR }), FailureClass.ENVIRONMENT);
  assert.equal(classifyFailure({ kind: FailureKind.AGENT_EXIT_NONZERO }), FailureClass.PROVIDER_TRANSPORT);
  assert.equal(classifyFailure({ kind: FailureKind.TIMEOUT }), FailureClass.TIMEOUT);
  assert.equal(classifyFailure({ kind: FailureKind.EXECUTE_NO_EDIT_PROGRESS }), FailureClass.NO_PROGRESS);
  assert.equal(classifyFailure({ kind: FailureKind.VERDICT_INVALID }), FailureClass.EVIDENCE_INSUFFICIENT);
});

test("routing evidence refines verification failures into evidence or implementation classes", () => {
  assert.equal(classifyFailure({
    kind: FailureKind.VERIFICATION_FAILED,
    cause: { routingLabel: "evidence_missing" },
  }), FailureClass.EVIDENCE_INSUFFICIENT);
  assert.equal(classifyFailure({
    kind: FailureKind.VERIFICATION_FAILED,
    cause: { routingLabel: "checklist_failed" },
  }), FailureClass.IMPLEMENTATION);
});

test("failure fingerprint is stable across timestamps, pids, attempts, and temp paths", () => {
  const first = {
    kind: FailureKind.TIMEOUT,
    phase: "execute",
    reason: "attempt 1 timed out at 2026-07-12T00:00:00.000Z pid=123",
    stderrSnippet: "failed in /tmp/cpb-one/run.log",
  };
  const second = {
    ...first,
    reason: "attempt 2 timed out at 2026-07-13T01:02:03.000Z pid=999",
    stderrSnippet: "failed in /tmp/cpb-two/run.log",
  };
  assert.equal(stableFailureFingerprint(first), stableFailureFingerprint(second));
});

test("same fingerprint must advance to a distinct strategy and then stop when exhausted", () => {
  const failure = {
    kind: FailureKind.VERIFICATION_FAILED,
    phase: "verify",
    reason: "AC-002 behavior still fails",
    cause: { routingLabel: "checklist_failed", fixScope: ["src/parser.ts"] },
  };
  const first = selectFailureRecovery({ failure, scope: "queue" });
  assert.equal(first.retryStrategy, "targeted_repair");
  assert.equal(first.strategyChanged, true);

  const second = selectFailureRecovery({
    failure,
    previousFingerprint: first.failureFingerprint,
    previousStrategy: first.retryStrategy,
    scope: "queue",
  });
  assert.equal(second.retryStrategy, "fresh_session_diagnosis");
  assert.equal(second.strategyChanged, true);
  assert.equal(second.forceFreshSession, true);

  const exhausted = selectFailureRecovery({
    failure,
    previousFingerprint: second.failureFingerprint,
    previousStrategy: second.retryStrategy,
    scope: "queue",
  });
  assert.equal(exhausted.retryStrategy, null);
  assert.match(exhausted.stopReason || "", /exhausted distinct queue recovery strategies/);

  const cannotResetToEarlierStrategy = selectFailureRecovery({
    failure,
    previousFingerprint: second.failureFingerprint,
    previousStrategy: second.retryStrategy,
    preferredStrategy: "targeted_repair",
    scope: "queue",
  });
  assert.equal(cannotResetToEarlierStrategy.retryStrategy, null);
});

test("failure evidence excludes resource telemetry and retains actionable checks", () => {
  const evidence = failureEvidence({
    kind: FailureKind.VERIFICATION_FAILED,
    reason: "tests failed",
    cause: {
      checks: [{ command: "npm test", exitCode: 1, stderrTail: "assertion failed" }],
      usage: { totalTokens: 1000, costUsd: 2 },
    },
  });
  assert.deepEqual(evidence.checks, [{
    gate: "npm test",
    exitCode: 1,
    timedOut: false,
    status: null,
    message: "assertion failed",
  }]);
  assert.equal("usage" in evidence, false);
  assert.equal(JSON.stringify(evidence).includes("costUsd"), false);
});
