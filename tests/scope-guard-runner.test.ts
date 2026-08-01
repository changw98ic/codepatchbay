import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateExecuteScopeGuard } from "../core/engine/scope-guard-runner.js";

function baseInput(overrides: Record<string, unknown> = {}) {
  const events: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  const progress: Record<string, unknown>[] = [];
  const phaseResults = [{ phase: "plan", status: "passed" }];
  const input = {
    cpbRoot: "/tmp/cpb",
    project: "proj",
    jobId: "job-scope",
    nodeId: "execute",
    phase: "execute",
    role: "executor",
    attemptId: "attempt-1",
    dagNode: { checklistIds: ["item-1"] },
    phaseSourceContext: {
      retry: {
        fix_scope: ["src/allowed.ts"],
      },
    },
    phaseResult: {
      status: "passed",
      artifact: {
        name: "deliverable-1",
        metadata: {
          changedFiles: [" M src/allowed.ts", "?? src/outside.ts"],
        },
      },
    },
    phaseResults,
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, unknown>) => {
      events.push(event);
    },
    failJob: async (_cpbRoot: string, _project: string, _jobId: string, failure: Record<string, unknown>) => {
      failures.push(failure);
    },
    onProgress: async (event: Record<string, unknown>) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
  return { input, events, failures, progress, phaseResults };
}

test("evaluateExecuteScopeGuard records scope drift but allows a new supporting file", async () => {
  const { input, events, failures, progress } = baseInput();

  const outcome = await evaluateExecuteScopeGuard(input);

  assert.equal(outcome, null);
  assert.deepEqual(events, [{
    type: "scope_guard_evaluated",
    jobId: "job-scope",
    project: "proj",
    phase: "execute",
    withinScope: false,
    violations: ["src/outside.ts"],
    fixScope: ["src/allowed.ts"],
    changedFiles: ["src/allowed.ts", "src/outside.ts"],
    ts: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(failures, []);
  assert.deepEqual(progress, []);
});

test("evaluateExecuteScopeGuard records a pass and returns null without failing the job", async () => {
  const { input, events, failures, progress } = baseInput({
    phaseResult: {
      status: "passed",
      artifact: {
        files: ["src/allowed.ts"],
      },
    },
  });

  const outcome = await evaluateExecuteScopeGuard(input);

  assert.equal(outcome, null);
  assert.deepEqual(events, [{
    type: "scope_guard_evaluated",
    jobId: "job-scope",
    project: "proj",
    phase: "execute",
    withinScope: true,
    violations: [],
    fixScope: ["src/allowed.ts"],
    changedFiles: ["src/allowed.ts"],
    ts: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(failures, []);
  assert.deepEqual(progress, []);
});

test("evaluateExecuteScopeGuard skips non-execute phases and retries without fix scope", async () => {
  const nonExecute = baseInput({ phase: "verify" });
  assert.equal(await evaluateExecuteScopeGuard(nonExecute.input), null);
  assert.deepEqual(nonExecute.events, []);

  const noScope = baseInput({ phaseSourceContext: { retry: {} } });
  assert.equal(await evaluateExecuteScopeGuard(noScope.input), null);
  assert.deepEqual(noScope.events, []);
});

test("evaluateExecuteScopeGuard uses the frozen allowed scope for verification repairs", async () => {
  const { input, events, failures } = baseInput({
    phaseSourceContext: {
      retry: {
        fixScope: ["src/core.ts"],
        allowedFixScope: ["src/core.ts", "tests"],
      },
    },
    phaseResult: {
      status: "passed",
      artifact: {
        metadata: {
          changedFiles: ["src/core.ts", "tests/regression.test.ts"],
        },
      },
    },
  });

  const outcome = await evaluateExecuteScopeGuard(input);

  assert.equal(outcome, null);
  assert.deepEqual(events, [{
    type: "scope_guard_evaluated",
    jobId: "job-scope",
    project: "proj",
    phase: "execute",
    withinScope: true,
    violations: [],
    fixScope: ["src/core.ts", "tests"],
    changedFiles: ["src/core.ts", "tests/regression.test.ts"],
    ts: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(failures, []);
});

test("evaluateExecuteScopeGuard keeps requested scope as advisory when the frozen allowed scope is empty", async () => {
  const { input, events } = baseInput({
    phaseSourceContext: {
      retry: {
        fixScope: ["src/core.ts"],
        allowedFixScope: [],
      },
    },
    phaseResult: {
      status: "passed",
      artifact: {
        metadata: {
          changedFiles: ["src/core.ts", "src/outside.ts"],
        },
      },
    },
  });

  const outcome = await evaluateExecuteScopeGuard(input);

  assert.equal(outcome, null);
  assert.deepEqual(events[0], {
    type: "scope_guard_evaluated",
    jobId: "job-scope",
    project: "proj",
    phase: "execute",
    withinScope: false,
    violations: ["src/outside.ts"],
    fixScope: ["src/core.ts"],
    changedFiles: ["src/core.ts", "src/outside.ts"],
    ts: "2026-06-22T00:00:00.000Z",
  });
});
