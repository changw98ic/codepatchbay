import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkflowDag,
  insertAdversarialVerify,
  validateDagForMutatingJob,
} from "../core/engine/dag-builder.js";

test("buildWorkflowDag projects workflow nodes to the requested phase list", () => {
  const dag = buildWorkflowDag({
    workflow: "complex",
    phases: ["execute", "verify"],
    phaseRoleMap: { execute: "executor", verify: "verifier" },
  });

  assert.deepEqual(dag.nodes.map((node) => node.id), ["execute", "verify"]);
  assert.deepEqual(dag.nodes.map((node) => node.role), ["executor", "verifier"]);
  assert.deepEqual(dag.edges, []);
  assert.equal(dag.source, "runtime_phase_projection");
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
