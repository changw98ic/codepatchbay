import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateExecuteScopeGuard } from "../core/engine/scope-guard-runner.js";

function baseInput(overrides: Record<string, any> = {}) {
  const events: Record<string, any>[] = [];
  const failures: Record<string, any>[] = [];
  const progress: Record<string, any>[] = [];
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
    appendEvent: async (_cpbRoot: string, _project: string, _jobId: string, event: Record<string, any>) => {
      events.push(event);
    },
    failJob: async (_cpbRoot: string, _project: string, _jobId: string, failure: Record<string, any>) => {
      failures.push(failure);
    },
    onProgress: async (event: Record<string, any>) => {
      progress.push(event);
    },
    now: () => "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
  return { input, events, failures, progress, phaseResults };
}

test("evaluateExecuteScopeGuard records a violation, fails the job, and returns scope violation result", async () => {
  const { input, events, failures, progress, phaseResults } = baseInput();

  const outcome = await evaluateExecuteScopeGuard(input);

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
  }, {
    type: "dag_node_failed",
    jobId: "job-scope",
    project: "proj",
    nodeId: "execute",
    phase: "execute",
    role: "executor",
    attemptId: "attempt-1",
    code: "scope_guard_violation",
    reason: "Scope guard violation: changed files outside fix_scope: src/outside.ts",
    error: "Scope guard violation: src/outside.ts",
    checklistIds: ["item-1"],
    ts: "2026-06-22T00:00:00.000Z",
  }]);
  assert.deepEqual(failures, [{
    reason: "Scope guard violation: changed files outside fix_scope: src/outside.ts",
    code: "scope_guard_violation",
    phase: "execute",
    cause: {
      violations: ["src/outside.ts"],
      fixScope: ["src/allowed.ts"],
    },
  }]);
  assert.deepEqual(progress, [{
    ts: "2026-06-22T00:00:00.000Z",
    type: "scope_guard_violation",
    jobId: "job-scope",
    project: "proj",
    phase: "execute",
    violations: ["src/outside.ts"],
    fixScope: ["src/allowed.ts"],
  }, {
    ts: "2026-06-22T00:00:00.000Z",
    type: "job_failed",
    jobId: "job-scope",
    project: "proj",
    phase: "execute",
    failureKind: "scope_violation",
    reason: "Scope guard violation: src/outside.ts",
  }]);
  assert.deepEqual(outcome, {
    status: "failed",
    jobId: "job-scope",
    exitCode: 1,
    failure: {
      kind: "scope_violation",
      phase: "execute",
      nodeId: "execute",
      reason: "Changed files outside fix_scope: src/outside.ts",
      retryable: false,
      cause: {
        routingLabel: "scope_violation",
        violations: ["src/outside.ts"],
        fixScope: ["src/allowed.ts"],
      },
    },
    phaseResults,
  });
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
