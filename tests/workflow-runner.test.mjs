import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolvePhases } from "../core/engine/workflow-runner.js";
import { defaultPlanModeForWorkflow } from "../core/triage/schema.js";
import { getWorkflow, listWorkflows, normalizeWorkflow } from "../core/workflow/definition.js";

const workflowPhaseDefinitions = {
  standard: ["plan", "execute", "verify"],
  direct: ["execute", "verify"],
  complex: ["plan", "execute", "review", "verify"],
  "sdd-standard": ["plan", "execute", "verify"],
  blocked: [],
};

describe("workflow runner phase resolution", () => {
  it("resolves full mode from the core workflow definitions", () => {
    for (const [name, expectedPhases] of Object.entries(workflowPhaseDefinitions)) {
      assert.deepEqual(getWorkflow(name).phases, expectedPhases);
      assert.deepEqual(resolvePhases(name, "full"), expectedPhases, `${name} full phases`);
    }
  });

  it("uses each workflow default plan mode when planMode is auto", () => {
    for (const name of Object.keys(workflowPhaseDefinitions)) {
      const defaultPlanMode = defaultPlanModeForWorkflow(name);
      assert.deepEqual(
        resolvePhases(name, "auto"),
        resolvePhases(name, defaultPlanMode),
        `${name} auto should resolve through ${defaultPlanMode}`,
      );
    }
  });

  it("keeps plan mode phase filters stable", () => {
    assert.deepEqual(resolvePhases("standard", "light"), ["plan", "execute"]);
    assert.deepEqual(resolvePhases("standard", "none"), ["execute", "verify"]);
    assert.deepEqual(resolvePhases("standard", "parent"), ["plan"]);

    assert.deepEqual(resolvePhases("complex", "light"), ["plan", "execute"]);
    assert.deepEqual(resolvePhases("complex", "none"), ["execute", "verify"]);
    assert.deepEqual(resolvePhases("complex", "parent"), ["plan"]);

    assert.deepEqual(resolvePhases("sdd-standard", "parent"), ["plan"]);
    assert.deepEqual(resolvePhases("direct", "none"), ["execute", "verify"]);
    assert.deepEqual(resolvePhases("blocked", "none"), []);
  });

  it("does not expose stub workflows as available workflows", () => {
    assert.deepEqual(listWorkflows().sort(), Object.keys(workflowPhaseDefinitions).sort());
  });

  it("normalizes available workflows to the same phase chain as their definitions", () => {
    for (const name of listWorkflows()) {
      const dag = normalizeWorkflow(name);
      const phases = dag.nodes.map((node) => node.phase);
      assert.deepEqual(phases, getWorkflow(name).phases, `${name} normalized phases`);
    }
  });
});
