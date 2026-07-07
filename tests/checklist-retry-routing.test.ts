import assert from "node:assert/strict";
import { test } from "node:test";

import { FailureKind } from "../core/contracts/failure.js";
import { FailureRouter } from "../server/orchestrator/failure-router.js";

test("failure router retries checklist failure with file fix scope", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "AC-002 failed",
        cause: {
          verdict: {
            checklistVerdict: {
              items: [{ checklistId: "AC-002", result: "fail", fixScope: ["cli/commands/status.ts"] }],
              fixScope: ["cli/commands/status.ts"],
            },
          },
        },
      },
    },
  });
  assert.equal(decision.action, "retry_same_worker");
  assert.equal(decision.retryPhase, "execute");
  assert.deepEqual(decision.fixScope, ["cli/commands/status.ts"]);
  assert.equal(decision.retryable, true);
});

test("failure router routes legacy verifier failures with fix scope back to execute", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        phase: "verify",
        reason: "canonical tests failed",
        cause: {
          verdict: {
            status: "fail",
            reason: "expected literal text did not match",
            fix_scope: ["sphinx/domains/python.py"],
          },
        },
      },
    },
  });

  assert.equal(decision.action, "retry_same_worker");
  assert.equal(decision.retryPhase, "execute");
  assert.deepEqual(decision.fixScope, ["sphinx/domains/python.py"]);
  assert.equal(decision.retryable, true);
});

test("failure router does not execute-retry checklist failure without file scope", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "AC-002 failed",
        cause: { verdict: { checklistVerdict: { items: [{ checklistId: "AC-002", result: "fail", fixScope: [] }], fixScope: [] } } },
      },
    },
  });
  assert.equal(decision.action, "mark_failed");
});

test("failure router can retry verifier for missing evidence without file scope", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "AC-003 evidence missing",
        cause: {
          routingLabel: "evidence_missing",
          evidenceMissingCause: "probe_available_not_run",
          retryPhase: "verify",
          targetChecklistIds: ["AC-003"],
          fixScope: [],
        },
      },
    },
  });
  assert.equal(decision.action, "retry_same_worker");
  assert.equal(decision.retryPhase, "verify");
  assert.equal(decision.retryable, true);
});

test("failure router does not verifier-retry when evidence probe is undefined", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.VERIFICATION_FAILED,
        reason: "AC-003 has no probe definition",
        cause: {
          routingLabel: "evidence_missing",
          evidenceMissingCause: "probe_definition_missing",
          targetChecklistIds: ["AC-003"],
          fixScope: [],
        },
      },
    },
  });
  assert.equal(decision.action, "mark_failed");
});

test("failure router blocks missing manual approval instead of verifier-looping", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.HUMAN_APPROVAL_REQUIRED,
        reason: "AC-004 requires manual approval artifact",
        cause: {
          routingLabel: "evidence_missing",
          evidenceMissingCause: "manual_approval_missing",
          targetChecklistIds: ["AC-004"],
          fixScope: [],
        },
      },
    },
  });
  assert.equal(decision.action, "mark_blocked");
});

test("failure router retries verifier when a read-only verify phase attempts to mutate source", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.PERMISSION_DENIED,
        phase: "verify",
        reason: "read-only phase attempted to modify /tmp/worktree/sphinx/util/docfields.py",
        retryable: false,
        cause: {
          readOnlyMutation: { targetPath: "/tmp/worktree/sphinx/util/docfields.py" },
        },
      },
    },
  });

  assert.equal(decision.action, "retry_same_worker");
  assert.equal(decision.retryPhase, "verify");
  assert.equal(decision.retryable, true);
});

test("failure router fails closed for ambiguous runtime artifacts without retry", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.ARTIFACT_INVALID,
        reason: "runtime failure missing attempt ownership",
        cause: { routingLabel: "runtime_failure_ambiguous" },
      },
    },
  });
  assert.equal(decision.action, "mark_failed");
  assert.equal(decision.retryable, false);
});

test("failure router retries bounded handoff plan timeouts even when job wrapper is non-retryable", async () => {
  const router = new FailureRouter();
  const decision = await router.route({
    assignment: { attempts: 0 },
    attempt: 1,
    result: {
      failure: {
        kind: FailureKind.PLAN_BOUNDED_HANDOFF_TIMEOUT,
        reason: "plan timed out before producing Bounded Handoff",
        retryable: false,
        cause: {
          originalFailureKind: FailureKind.TIMEOUT,
          handoffCarryForward: { readSearchCount: 3 },
        },
      },
    },
  });

  assert.equal(decision.action, "restart_worker_and_retry");
  assert.equal(decision.retryable, true);
});
