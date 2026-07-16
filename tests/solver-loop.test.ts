import test from "node:test";
import assert from "node:assert/strict";

import { FailureKind } from "../core/contracts/failure.js";
import { buildConversationKey } from "../core/agents/conversation-key.js";
import {
  bindVerificationFeedbackToFrozenScope,
  completionGateFailureFingerprint,
  completionGateFeedbackFromFailure,
  completionGateRepairSourceContext,
  isRecoverableVerificationInfrastructureFailure,
  isRepairableVerificationFailure,
  solverRepairSourceContext,
  verificationInfrastructureFeedbackFromResult,
  verificationInfrastructureRetryLimit,
  verificationInfrastructureRetrySourceContext,
  verificationFeedbackFromResult,
} from "../core/engine/solver-loop.js";

test("conversation keys isolate attempts and roles while remaining stable across iterations", () => {
  const executor = buildConversationKey({ project: "demo", jobId: "job-1", attemptId: "a1", role: "executor" });
  assert.equal(executor, buildConversationKey({ project: "demo", jobId: "job-1", attemptId: "a1", role: "executor" }));
  assert.notEqual(executor, buildConversationKey({ project: "demo", jobId: "job-1", attemptId: "a2", role: "executor" }));
  assert.notEqual(executor, buildConversationKey({ project: "demo", jobId: "job-1", attemptId: "a1", role: "verifier" }));
});

test("verification feedback preserves actionable evidence for the same solver attempt", () => {
  const result = {
    schemaVersion: 1,
    phase: "verify",
    status: "failed",
    artifact: null,
    failure: {
      kind: FailureKind.VERIFICATION_FAILED,
      phase: "verify",
      reason: "focused test failed",
      retryable: true,
      cause: {
        verdict: { status: "fail", fixScope: ["src/parser.ts"] },
        artifact: { id: "verdict-1", kind: "verdict", path: "/tmp/verdict.md", sha256: "abc" },
      },
    },
    diagnostics: {
      rawAgentOutputArtifact: { id: "raw-1", kind: "agent-output", path: "/tmp/raw.txt", sha256: "def" },
    },
    createdAt: new Date().toISOString(),
  } as const;

  assert.equal(isRepairableVerificationFailure(result), true);
  const feedback = verificationFeedbackFromResult(result, 1);
  assert.match(feedback.failureFingerprint, /^sha256:/);
  assert.equal(feedback.triggerPhase, "verify");
  assert.deepEqual(feedback.fixScope, ["src/parser.ts"]);
  assert.equal(feedback.artifact?.sha256, "abc");
  assert.equal(feedback.evidenceArtifacts[0]?.id, "raw-1");

  const sourceContext = solverRepairSourceContext({ original: true }, feedback);
  assert.equal(sourceContext.original, true);
  assert.equal(sourceContext.retry.retryClass, "verification_feedback");
  assert.equal(sourceContext.retry.failureFingerprint, feedback.failureFingerprint);
  assert.equal(sourceContext.solver.iteration, 1);
});

test("adversarial counterexamples preserve structured repair targets", () => {
  const result = {
    schemaVersion: 1,
    phase: "adversarial_verify",
    status: "failed",
    artifact: null,
    failure: {
      kind: FailureKind.VERIFICATION_FAILED,
      phase: "adversarial_verify",
      reason: "warning names an unspecified future release",
      retryable: true,
      cause: {
        verdict: {
          status: "fail",
          expected: "warning names version 5.2",
          observed: "warning says in the future",
          fix_scope: ["src/warnings.ts"],
          targetChecklistIds: ["AC-005"],
        },
      },
    },
    diagnostics: {},
    createdAt: new Date().toISOString(),
  } as const;

  assert.equal(isRepairableVerificationFailure(result), true);
  const feedback = verificationFeedbackFromResult(result, 1);
  assert.equal(feedback.triggerPhase, "adversarial_verify");
  assert.deepEqual(feedback.fixScope, ["src/warnings.ts"]);
  assert.deepEqual(feedback.targetChecklistIds, ["AC-005"]);
  assert.deepEqual(feedback.verdict, result.failure.cause.verdict);
});

test("verification feedback is bound to frozen checklist scope before mutation", () => {
  const baseFeedback = {
    schemaVersion: 1 as const,
    iteration: 1,
    triggerPhase: "adversarial_verify" as const,
    failureKind: FailureKind.VERIFICATION_FAILED,
    failureReason: "counterexample",
    failureFingerprint: "sha256:test",
    fixScope: [] as string[],
    allowedFixScope: [] as string[],
    targetChecklistIds: ["AC-005"],
    verdict: null,
    artifact: null,
    evidenceArtifacts: [],
  };
  const sourceContext = {
    acceptanceChecklist: {
      items: [{ id: "AC-005", allowedFiles: ["src/warnings.ts", "tests/warnings/"] }],
    },
  };

  const derived = bindVerificationFeedbackToFrozenScope(sourceContext, baseFeedback);
  assert.equal(derived.ok, true);
  if (derived.ok) {
    assert.deepEqual(derived.feedback.fixScope, ["src/warnings.ts", "tests/warnings/"]);
    assert.deepEqual(derived.feedback.allowedFixScope, ["src/warnings.ts", "tests/warnings/"]);
  }

  const outside = bindVerificationFeedbackToFrozenScope(sourceContext, {
    ...baseFeedback,
    fixScope: ["src/unrelated.ts"],
  });
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.match(outside.reason, /outside the frozen acceptance contract/);
});

test("legacy checklists without a declared file scope do not create a false scope expansion", () => {
  const feedback = {
    schemaVersion: 1 as const,
    iteration: 1,
    triggerPhase: "adversarial_verify" as const,
    failureKind: FailureKind.VERIFICATION_FAILED,
    failureReason: "counterexample",
    failureFingerprint: "sha256:test",
    fixScope: ["README.md"],
    allowedFixScope: [] as string[],
    targetChecklistIds: ["AC-001"],
    verdict: null,
    artifact: null,
    evidenceArtifacts: [],
  };

  const bound = bindVerificationFeedbackToFrozenScope({
    acceptanceChecklist: { items: [{ id: "AC-001", allowedFiles: [] }] },
  }, feedback);

  assert.equal(bound.ok, true);
  if (bound.ok) {
    assert.deepEqual(bound.feedback.fixScope, ["README.md"]);
    assert.deepEqual(bound.feedback.allowedFixScope, []);
  }
});

test("non-verification and explicitly non-retryable failures do not enter semantic repair", () => {
  const failure = (phase: string, retryable: boolean) => ({
    schemaVersion: 1,
    phase,
    status: "failed",
    artifact: null,
    failure: {
      kind: FailureKind.VERIFICATION_FAILED,
      phase,
      reason: "failed",
      retryable,
    },
    diagnostics: {},
    createdAt: new Date().toISOString(),
  });
  assert.equal(isRepairableVerificationFailure(failure("execute", true) as never), false);
  assert.equal(isRepairableVerificationFailure(failure("verify", false) as never), false);
});

test("verification infrastructure failures never mutate the frozen candidate", () => {
  const result = {
    schemaVersion: 1,
    phase: "verify",
    status: "failed",
    artifact: null,
    failure: {
      kind: FailureKind.VERIFICATION_FAILED,
      phase: "verify",
      reason: "independent evidence unavailable",
      retryable: true,
      cause: {
        verificationInfrastructure: {
          failureClass: "verification_infrastructure",
          candidateMutationAllowed: false,
        },
      },
    },
    diagnostics: {},
    createdAt: new Date().toISOString(),
  };
  assert.equal(isRepairableVerificationFailure(result as never), false);
  assert.equal(isRecoverableVerificationInfrastructureFailure(result as never), true);

  const feedback = verificationInfrastructureFeedbackFromResult(result as never, 1);
  assert.equal(feedback.candidateMutationAllowed, false);
  assert.match(feedback.failureFingerprint, /^sha256:/);
  const context = verificationInfrastructureRetrySourceContext({ frozen: true }, feedback);
  assert.equal((context as Record<string, unknown>).frozen, true);
  assert.equal(context.retry.retryClass, "verification_infrastructure");
  assert.equal(context.retry.candidateMutationAllowed, false);
  assert.match(String(context.retry.instruction), /Keep the candidate byte-for-byte unchanged/);
  assert.match(String(context.retry.instruction), /dynamic evidence gate/);
});

test("verification infrastructure retry budget is bounded and configurable", () => {
  assert.equal(verificationInfrastructureRetryLimit({}), 2);
  assert.equal(verificationInfrastructureRetryLimit({ CPB_VERIFICATION_INFRA_RETRY_MAX: "4" }), 4);
  assert.equal(verificationInfrastructureRetryLimit({ CPB_VERIFICATION_INFRA_RETRY_MAX: "99" }), 10);
  assert.equal(verificationInfrastructureRetryLimit({ CPB_VERIFICATION_INFRA_RETRY_MAX: "invalid" }), 2);
});

test("completion gate feedback preserves exact repair targets and chooses phase-specific instructions", () => {
  const failure = {
    kind: FailureKind.VERIFICATION_FAILED,
    phase: "completion_gate",
    reason: "pass verdict references stale evidence",
    retryable: true,
    cause: {
      gateOutcome: "evidence_stale",
      routingRetryPhase: "verify",
      fixScope: ["src/parser.ts"],
      targetChecklistIds: ["AC-002"],
      missingGates: ["checklist"],
      details: { checklist: { staleEvidenceRefs: [{ evidenceId: "EV-002" }] } },
    },
  };

  const feedback = completionGateFeedbackFromFailure(failure, 2);
  assert.equal(feedback.failureFingerprint, completionGateFailureFingerprint(failure));
  assert.equal(feedback.retryPhase, "verify");
  assert.deepEqual(feedback.fixScope, ["src/parser.ts"]);
  assert.deepEqual(feedback.targetChecklistIds, ["AC-002"]);

  const context = completionGateRepairSourceContext({ original: true }, feedback);
  assert.equal(context.original, true);
  assert.equal(context.retry.retryClass, "completion_gate_feedback");
  assert.match(String(context.retry.instruction), /Keep the candidate unchanged/);
  assert.equal(context.solver.iteration, 2);
});
