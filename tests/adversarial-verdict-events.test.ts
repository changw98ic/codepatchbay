import assert from "node:assert/strict";
import { test } from "node:test";

import { emitAdversarialVerdictEvent } from "../core/engine/adversarial-verdict-events.js";

test("emitAdversarialVerdictEvent writes adversarial verdict payload for adversarial_verify phases", async () => {
  const events: Record<string, unknown>[] = [];
  const verdict = {
    status: "fail",
    reason: "missing rollback proof",
    risk: "high",
  };

  const emitted = await emitAdversarialVerdictEvent({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-adv",
    phase: "adversarial_verify",
    phaseResult: {
      artifact: { name: "adversarial-verdict-1" },
      diagnostics: { verdict },
    },
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(emitted, true);
  assert.deepEqual(events, [{
    type: "adversarial_verdict",
    jobId: "job-adv",
    project: "proj",
    phase: "adversarial_verify",
    verdict,
    artifact: "adversarial-verdict-1",
    status: "fail",
    reason: "missing rollback proof",
    ts: "2026-06-22T00:00:00.000Z",
  }]);
});

test("emitAdversarialVerdictEvent skips other phases and missing verdicts", async () => {
  const events: Record<string, unknown>[] = [];
  const appendEvent = async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
    events.push(event);
  };

  const skippedPlan = await emitAdversarialVerdictEvent({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-plan",
    phase: "plan",
    phaseResult: {
      artifact: { name: "plan-1" },
      diagnostics: { verdict: { status: "pass" } },
    },
    appendEvent,
    now: () => "2026-06-22T00:00:00.000Z",
  });

  const skippedMissingVerdict = await emitAdversarialVerdictEvent({
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-missing",
    phase: "adversarial_verify",
    phaseResult: { artifact: { name: "adversarial-verdict-2" } },
    appendEvent,
    now: () => "2026-06-22T00:00:00.000Z",
  });

  assert.equal(skippedPlan, false);
  assert.equal(skippedMissingVerdict, false);
  assert.deepEqual(events, []);
});
