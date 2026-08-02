import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVerdict,
  isMutatingJob,
  evaluateCompletionGate,
  completionGateEvent,
} from "../../core/engine/completion-gate.js";

// --- parseVerdict ---

describe("parseVerdict", () => {
  test("parses valid pass verdict", () => {
    const result = parseVerdict(JSON.stringify({ schemaVersion: 2, status: "pass" }));
    assert.deepEqual(result, { status: "pass", raw: "PASS" });
  });

  test("parses valid fail verdict", () => {
    const result = parseVerdict(JSON.stringify({ schemaVersion: 2, status: "fail" }));
    assert.deepEqual(result, { status: "fail", raw: "FAIL" });
  });

  test("parses inconclusive as fail", () => {
    const result = parseVerdict(JSON.stringify({ schemaVersion: 2, status: "inconclusive" }));
    assert.deepEqual(result, { status: "fail", raw: "INCONCLUSIVE" });
  });

  test("parses infra_error as fail", () => {
    const result = parseVerdict(JSON.stringify({ schemaVersion: 2, status: "infra_error" }));
    assert.deepEqual(result, { status: "fail", raw: "INFRA_ERROR" });
  });

  test("rejects wrong schemaVersion", () => {
    assert.equal(parseVerdict(JSON.stringify({ schemaVersion: 1, status: "pass" })), null);
  });

  test("rejects invalid JSON string", () => {
    assert.equal(parseVerdict("not json"), null);
  });

  test("rejects null", () => {
    assert.equal(parseVerdict(null), null);
  });

  test("rejects undefined", () => {
    assert.equal(parseVerdict(undefined), null);
  });

  test("rejects empty string", () => {
    assert.equal(parseVerdict(""), null);
  });

  test("rejects unknown status", () => {
    assert.equal(parseVerdict(JSON.stringify({ schemaVersion: 2, status: "unknown" })), null);
  });

  test("accepts object with schemaVersion=2", () => {
    const result = parseVerdict({ schemaVersion: 2, status: "pass" });
    assert.deepEqual(result, { status: "pass", raw: "PASS" });
  });
});

// --- isMutatingJob ---

describe("isMutatingJob", () => {
  test("returns false for null", () => {
    assert.equal(isMutatingJob(null), false);
  });

  test("returns false for undefined", () => {
    assert.equal(isMutatingJob(undefined), false);
  });

  test("returns false for planMode parent", () => {
    assert.equal(isMutatingJob({ planMode: "parent" }), false);
  });

  test("returns false for planMode none", () => {
    assert.equal(isMutatingJob({ planMode: "none" }), false);
  });

  test("returns false for workflow docs", () => {
    assert.equal(isMutatingJob({ workflow: "docs" }), false);
  });

  test("returns false for workflow readonly", () => {
    assert.equal(isMutatingJob({ workflow: "readonly" }), false);
  });

  test("returns true for normal job", () => {
    assert.equal(isMutatingJob({ workflow: "standard" }), true);
  });

  test("returns true for job with no workflow/planMode", () => {
    assert.equal(isMutatingJob({}), true);
  });
});

// --- evaluateCompletionGate ---

describe("evaluateCompletionGate", () => {
  test("returns complete for non-mutating job", () => {
    const result = evaluateCompletionGate({
      job: { workflow: "docs", completedPhases: [] },
    });
    assert.equal(result.outcome, "complete");
  });

  test("fails with policy_invalid when mutating DAG has no verify node", () => {
    const result = evaluateCompletionGate({
      job: { workflow: "standard", completedPhases: ["plan", "execute"] },
      workflowDag: {
        nodes: [
          { id: "plan", phase: "plan" },
          { id: "execute", phase: "execute" },
        ],
      },
    });
    assert.equal(result.outcome, "policy_invalid");
    assert.ok(result.reason.includes("no verify node"));
  });

  test("fails with verification_incomplete when verify not completed", () => {
    const result = evaluateCompletionGate({
      job: { workflow: "standard", completedPhases: ["plan", "execute"] },
      workflowDag: {
        nodes: [
          { id: "plan", phase: "plan" },
          { id: "execute", phase: "execute" },
          { id: "verify", phase: "verify" },
        ],
      },
    });
    assert.equal(result.outcome, "verification_incomplete");
  });

  test("fails with artifact_invalid when verdict is null", () => {
    const result = evaluateCompletionGate({
      job: { workflow: "standard", completedPhases: ["plan", "execute", "verify"] },
      workflowDag: {
        nodes: [
          { id: "plan", phase: "plan" },
          { id: "execute", phase: "execute" },
          { id: "verify", phase: "verify" },
        ],
      },
      parsedVerdict: null,
    });
    assert.equal(result.outcome, "artifact_invalid");
  });

  test("fails with verification_failed when verdict is fail", () => {
    const result = evaluateCompletionGate({
      job: { workflow: "standard", completedPhases: ["plan", "execute", "verify"] },
      workflowDag: {
        nodes: [
          { id: "plan", phase: "plan" },
          { id: "execute", phase: "execute" },
          { id: "verify", phase: "verify" },
        ],
      },
      parsedVerdict: { status: "fail", raw: "FAIL" },
    });
    assert.equal(result.outcome, "verification_failed");
  });

  test("fails with adversarial_incomplete when required but not completed", () => {
    const result = evaluateCompletionGate({
      job: { workflow: "standard", completedPhases: ["plan", "execute", "verify"] },
      workflowDag: {
        nodes: [
          { id: "plan", phase: "plan" },
          { id: "execute", phase: "execute" },
          { id: "verify", phase: "verify" },
          { id: "adversarial_verify", phase: "adversarial_verify" },
        ],
      },
      parsedVerdict: { status: "pass", raw: "PASS" },
      riskMap: { adversarialRequired: true },
    });
    assert.equal(result.outcome, "adversarial_incomplete");
  });

  test("fails with adversarial_failed when adversarial verdict is fail", () => {
    const result = evaluateCompletionGate({
      job: {
        workflow: "standard",
        completedPhases: ["plan", "execute", "verify", "adversarial_verify"],
      },
      workflowDag: {
        nodes: [
          { id: "plan", phase: "plan" },
          { id: "execute", phase: "execute" },
          { id: "verify", phase: "verify" },
          { id: "adversarial_verify", phase: "adversarial_verify" },
        ],
      },
      parsedVerdict: { status: "pass", raw: "PASS" },
      parsedAdversarialVerdict: { status: "fail", raw: "FAIL" },
      riskMap: { adversarialRequired: true },
    });
    assert.equal(result.outcome, "adversarial_failed");
  });

  test("returns complete when all gates pass", () => {
    const result = evaluateCompletionGate({
      job: {
        workflow: "standard",
        completedPhases: ["plan", "execute", "verify"],
      },
      workflowDag: {
        nodes: [
          { id: "plan", phase: "plan" },
          { id: "execute", phase: "execute" },
          { id: "verify", phase: "verify" },
        ],
      },
      parsedVerdict: { status: "pass", raw: "PASS" },
    });
    assert.equal(result.outcome, "complete");
  });

  test("returns complete when adversarial required and passed", () => {
    const result = evaluateCompletionGate({
      job: {
        workflow: "standard",
        completedPhases: ["plan", "execute", "verify", "adversarial_verify"],
      },
      workflowDag: {
        nodes: [
          { id: "plan", phase: "plan" },
          { id: "execute", phase: "execute" },
          { id: "verify", phase: "verify" },
          { id: "adversarial_verify", phase: "adversarial_verify" },
        ],
      },
      parsedVerdict: { status: "pass", raw: "PASS" },
      parsedAdversarialVerdict: { status: "pass", raw: "PASS" },
      riskMap: { adversarialRequired: true },
    });
    assert.equal(result.outcome, "complete");
  });
});

// --- completionGateEvent ---

describe("completionGateEvent", () => {
  test("builds event with correct fields", () => {
    const event = completionGateEvent("job-1", "my-project", {
      outcome: "complete",
      reason: "All gates passed",
      missingGates: [],
      details: { isMutating: true, dagPhases: [], completedPhases: [], adversarialRequired: false },
    });
    assert.equal(event.type, "completion_gate_evaluated");
    assert.equal(event.jobId, "job-1");
    assert.equal(event.project, "my-project");
    assert.equal(event.outcome, "complete");
  });
});
