import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkflowDag,
  insertAdversarialVerify,
  validateDagForMutatingJob,
} from "../core/engine/dag-builder.js";
import { registerDagWorkflow } from "../core/workflow/definition.js";

test("buildWorkflowDag projects workflow nodes to the requested phase list", () => {
  const dag = buildWorkflowDag({
    workflow: "direct",
    phases: ["execute", "verify"],
    phaseRoleMap: { execute: "executor", verify: "verifier" },
  });

  assert.deepEqual(dag.nodes.map((node) => node.id), ["execute", "verify"]);
  assert.deepEqual(dag.nodes.map((node) => node.role), ["executor", "verifier"]);
  assert.deepEqual(dag.edges, [{ from: "execute", to: "verify" }]);
  assert.equal(dag.source, "runtime_phase_projection");
});

test("buildWorkflowDag reconnects dependencies through filtered workflow phases", () => {
  const standardLight = buildWorkflowDag({
    workflow: "standard",
    phases: ["execute", "verify"],
    phaseRoleMap: { execute: "executor", verify: "verifier" },
  });
  assert.deepEqual(standardLight.nodes.map((node) => [node.id, node.dependsOn]), [
    ["execute", []],
    ["verify", ["execute"]],
  ]);
  assert.deepEqual(standardLight.edges, [{ from: "execute", to: "verify" }]);

  const complexLight = buildWorkflowDag({
    workflow: "complex",
    phases: ["execute", "verify"],
    phaseRoleMap: { execute: "executor", verify: "verifier" },
  });
  assert.deepEqual(complexLight.nodes.map((node) => [node.id, node.dependsOn]), [
    ["execute", []],
    ["verify", ["execute"]],
  ]);
  assert.deepEqual(complexLight.edges, [{ from: "execute", to: "verify" }]);
});

test("buildWorkflowDag throws when fallback planning introduces duplicate node IDs", () => {
  registerDagWorkflow("dup-fallback-dag-fixture", {
    nodes: [{ id: "execute_2", phase: "execute", role: "executor", dependsOn: [] }],
    maxConcurrentNodes: 1,
  });

  assert.throws(
    () =>
      buildWorkflowDag({
        workflow: "dup-fallback-dag-fixture",
        phases: ["execute", "execute", "execute"],
        phaseRoleMap: { execute: "executor" },
      }),
    /workflow dup-fallback-dag-fixture has duplicate node id: execute_2/,
  );
});

test("buildWorkflowDag appends fallback linear nodes for unknown phases", () => {
  const dag = buildWorkflowDag({
    workflow: "standard",
    phases: ["plan", "execute", "verify", "adversarial_verify"],
    phaseRoleMap: {
      plan: "planner",
      execute: "executor",
      verify: "verifier",
      adversarial_verify: "verifier",
    },
  });

  assert.deepEqual(dag.nodes.map((node) => node.id), [
    "plan",
    "execute",
    "verify",
    "adversarial_verify",
  ]);
  assert.deepEqual(dag.nodes.at(-1), {
    id: "adversarial_verify",
    phase: "adversarial_verify",
    role: "verifier",
    dependsOn: ["verify"],
  });
});

test("insertAdversarialVerify inserts once after verify only when required", () => {
  assert.deepEqual(
    insertAdversarialVerify(["plan", "execute", "verify"], { adversarialRequired: true }),
    ["plan", "execute", "verify", "adversarial_verify"],
  );
  assert.deepEqual(
    insertAdversarialVerify(["execute", "verify", "adversarial_verify"], { adversarialRequired: true }),
    ["execute", "verify", "adversarial_verify"],
  );
  assert.deepEqual(
    insertAdversarialVerify(["execute", "verify"], { adversarialRequired: false }),
    ["execute", "verify"],
  );
});

test("validateDagForMutatingJob requires a verify node", () => {
  assert.deepEqual(validateDagForMutatingJob({ nodes: [{ phase: "execute" }] }), {
    valid: false,
    reason: "Mutating job requires a verify phase in the DAG",
  });
  assert.deepEqual(validateDagForMutatingJob({ nodes: [{ phase: "execute" }, { phase: "verify" }] }), {
    valid: true,
  });
});
