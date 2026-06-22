import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { evaluatePoisonedSessionGate } from "../core/engine/poisoned-session-gate.js";

function passedResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    phase: "execute",
    status: "passed",
    artifact: { name: "deliverable-1", path: "/tmp/artifact.md" },
    failure: null,
    diagnostics: {},
    ...overrides,
  };
}

function baseContext(overrides: Record<string, unknown> = {}) {
  const events: Record<string, unknown>[] = [];
  const context = {
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-poison",
    phase: "execute",
    nodeId: "execute",
    attemptId: "attempt-1",
    result: passedResult(),
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
  return { context, events };
}

test("evaluatePoisonedSessionGate skips non-passed results and artifacts without paths", async () => {
  let readCalls = 0;
  const failed = passedResult({ status: "failed", artifact: { name: "deliverable-1", path: "/tmp/artifact.md" } });
  const failedOutcome = await evaluatePoisonedSessionGate({
    ...baseContext({ result: failed }).context,
    readFile: async () => {
      readCalls += 1;
      return "";
    },
  });
  assert.equal(failedOutcome, failed);

  const noPath = passedResult({ artifact: { name: "deliverable-1" } });
  const noPathOutcome = await evaluatePoisonedSessionGate({
    ...baseContext({ result: noPath }).context,
    readFile: async () => {
      readCalls += 1;
      return "";
    },
  });
  assert.equal(noPathOutcome, noPath);
  assert.equal(readCalls, 0);
});

test("evaluatePoisonedSessionGate emits event and returns failed phase result for poisoned output", async () => {
  const { context, events } = baseContext({
    result: passedResult({ stderr: "invalid_request_error: context window exceeded" }),
  });

  const outcome = await evaluatePoisonedSessionGate({
    ...context,
    readFile: async () => "This artifact looks long enough to avoid semantic inactivity. ".repeat(60),
  });

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.phase, "execute");
  const failure = outcome.failure as {
    kind?: unknown;
    phase?: unknown;
    reason?: unknown;
    cause?: unknown;
  };
  assert.equal(failure.kind, FailureKind.POISONED_SESSION);
  assert.equal(failure.phase, "execute");
  assert.match(String(failure.reason || ""), /poisoned session: invalid_request:/);
  assert.deepEqual(failure.cause, {
    reasons: ["invalid_request:invalid_request_error", "invalid_request:context window exceeded"],
    classifier: "invalid_request",
  });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "phase_poisoned_session",
    jobId: "job-poison",
    project: "proj",
    phase: "execute",
    nodeId: "execute",
    attemptId: "attempt-1",
    reasons: ["invalid_request:invalid_request_error", "invalid_request:context window exceeded"],
    classifier: "invalid_request",
    ts: "2026-06-22T00:00:00.000Z",
  });
});

test("evaluatePoisonedSessionGate fails closed when artifact read is missing", async () => {
  const source = passedResult();
  const error = Object.assign(new Error("missing artifact"), { code: "ENOENT" });
  const { context, events } = baseContext({ result: source });

  const outcome = await evaluatePoisonedSessionGate({
    ...context,
    readFile: async () => {
      throw error;
    },
  });

  assert.equal(outcome.status, "failed");
  const failure = outcome.failure as { kind?: unknown; cause?: { classifier?: unknown } };
  assert.equal(failure.kind, FailureKind.POISONED_SESSION);
  assert.equal(failure.cause?.classifier, "semantic_inactivity");
  assert.deepEqual(events.map((event) => event.type), ["phase_poisoned_session"]);
});
