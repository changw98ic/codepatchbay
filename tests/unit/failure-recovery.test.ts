import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FailureClass,
  selectFailureRecovery,
  stableFailureFingerprint,
} from "../../core/contracts/failure-recovery.js";
import { FailureKind } from "../../core/contracts/failure.js";

const providerFailure = {
  kind: FailureKind.AGENT_EXIT_NONZERO,
  phase: "execute",
  reason: "provider process exited before returning a result",
};

test("a provider transport failure first hands the task to another provider", () => {
  const decision = selectFailureRecovery({ failure: providerFailure });

  assert.deepEqual(
    { failureClass: decision.failureClass, retryStrategy: decision.retryStrategy },
    {
      failureClass: FailureClass.PROVIDER_TRANSPORT,
      retryStrategy: "provider_handoff",
    },
  );
});

test("the same provider failure advances to a fresh-session retry", () => {
  const first = selectFailureRecovery({ failure: providerFailure });
  const second = selectFailureRecovery({
    failure: providerFailure,
    previousFingerprint: first.failureFingerprint,
    previousStrategy: first.retryStrategy,
  });

  assert.equal(second.retryStrategy, "fresh_session_provider_retry");
});

test("phase-local recovery never hands work to a different provider", () => {
  const decision = selectFailureRecovery({
    failure: providerFailure,
    scope: "phase",
  });

  assert.equal(decision.retryStrategy, "fresh_session_provider_retry");
});

test("volatile timestamps, process ids, and temporary paths do not change a failure fingerprint", () => {
  const first = stableFailureFingerprint({
    kind: FailureKind.TIMEOUT,
    reason: "failed at 2026-08-02T01:02:03.000Z pid=12 in /tmp/run-one/result.json",
  });
  const second = stableFailureFingerprint({
    kind: FailureKind.TIMEOUT,
    reason: "failed at 2026-08-03T04:05:06.000Z pid=98 in /tmp/run-two/result.json",
  });

  assert.equal(first, second);
});
