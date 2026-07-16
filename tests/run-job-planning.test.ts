import assert from "node:assert/strict";
import { test } from "node:test";

import {
  attachChecklistIdsToWorkflowDag,
  dagSequentialExecutionPlan,
  normalizeDagResumeContext,
  recoveredArtifactForPhase,
  recoveredVerdictForPhase,
} from "../core/engine/run-job-planning.js";

test("dagSequentialExecutionPlan returns ready nodes in dependency order", () => {
  const dag = {
    nodes: [
      { id: "verify", phase: "verify", dependsOn: ["execute"] },
      { id: "plan", phase: "plan", dependsOn: [] },
      { id: "execute", phase: "execute", dependsOn: ["plan"] },
    ],
  };

  const planned = dagSequentialExecutionPlan(dag).map((node) => node.id);

  assert.deepEqual(planned, ["plan", "execute", "verify"]);
});

test("dagSequentialExecutionPlan fails when no ready node exists", () => {
  assert.throws(
    () => dagSequentialExecutionPlan({
      nodes: [
        { id: "a", phase: "plan", dependsOn: ["b"] },
        { id: "b", phase: "execute", dependsOn: ["a"] },
      ],
    }),
    /DAG has no ready node/,
  );
});

test("normalizeDagResumeContext merges retry, dagResume, and previousFailure node ids", () => {
  const resume = normalizeDagResumeContext({
    retry: {
      completedNodeIds: ["execute", "", "execute"],
      resumeTarget: { nodeId: "verify", phase: "verify" },
    },
    dagResume: {
      completedNodeIds: ["plan"],
      resumeTarget: { nodeId: "execute", phase: "execute" },
    },
    previousFailure: {
      completedNodeIds: ["review"],
    },
  });

  assert.deepEqual(resume.completedNodeIds, ["plan", "execute", "review"]);
  assert.deepEqual(resume.resumeTarget, { nodeId: "verify", phase: "verify" });
});

test("recoveredArtifactForPhase resolves names and recovered verdicts from retry context", () => {
  const sourceContext = {
    retry: {
      artifacts: {
        execute: "deliverable-job-123",
        verify: { name: "verdict-job-123", extra: true },
      },
      verdict: { verdict: "pass" },
      adversarialVerdict: { verdict: "fail" },
    },
  };

  const executeArtifact = recoveredArtifactForPhase(sourceContext, "execute", {
    cpbRoot: "/tmp/cpb",
    project: "flow",
    dataRoot: "/tmp/cpb-runtime",
  });
  const verifyArtifact = recoveredArtifactForPhase(sourceContext, "verify", {
    cpbRoot: "/tmp/cpb",
    project: "flow",
    dataRoot: "/tmp/cpb-runtime",
  });

  assert.equal(executeArtifact?.kind, "deliverable");
  assert.equal(executeArtifact?.name, "deliverable-job-123");
  assert.equal(executeArtifact?.path, "/tmp/cpb-runtime/wiki/outputs/deliverable-job-123.md");
  assert.deepEqual(verifyArtifact, {
    kind: "verdict",
    name: "verdict-job-123",
    extra: true,
    path: "/tmp/cpb-runtime/wiki/outputs/verdict-job-123.md",
  });
  assert.deepEqual(recoveredVerdictForPhase(sourceContext, "verify"), { verdict: "pass" });
  assert.deepEqual(recoveredVerdictForPhase(sourceContext, "adversarial_verify"), { verdict: "fail" });
});

test("attachChecklistIdsToWorkflowDag binds canonical checklist ids only to default mutating nodes", () => {
  const dag = {
    nodes: [
      { id: "plan", phase: "plan", dependsOn: [] },
      { id: "execute", phase: "execute", dependsOn: ["plan"] },
      { id: "verify", phase: "verify", dependsOn: ["execute"] },
      { id: "custom-review", phase: "review", custom: true, dependsOn: ["execute"] },
      { id: "neutral-remediate", phase: "remediate", sideEffecting: true, checklistNeutral: true, dependsOn: ["review"] },
    ],
  };

  const result = attachChecklistIdsToWorkflowDag(dag, {
    items: [
      { id: "AC-1", required: true },
      { id: "AC-2", required: false },
      { id: "AC-3", required: true },
    ],
  });

  assert.deepEqual(result.nodes[0], dag.nodes[0]);
  assert.deepEqual(result.nodes[1].checklistIds, ["AC-1", "AC-3"]);
  assert.equal(result.nodes[1].checklistBindingSource, "canonical-default");
  assert.deepEqual(result.nodes[2].checklistIds, ["AC-1", "AC-3"]);
  assert.equal(result.nodes[3].checklistIds, undefined);
  assert.deepEqual(result.nodes[4].checklistIds, []);
});
