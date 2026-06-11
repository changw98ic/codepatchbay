// @ts-nocheck
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  getWorkflow as getCoreWorkflow,
  listWorkflows,
  nextPhase as coreNextPhase,
  registerDagWorkflow,
} from "../core/workflow/definition.js";
import { evaluateCompletionGate } from "../core/engine/completion-gate.js";
import { resolveSemanticPhases } from "../core/engine/phase-policy.js";
import { resolvePhases } from "../core/engine/workflow-runner.js";
import {
  getWorkflow as getServerWorkflow,
  nextPhase as serverNextPhase,
  bridgeForPhase as serverBridgeForPhase,
} from "../server/services/workflow-definition.js";
import { nextPhaseFor } from "../server/services/supervisor.js";
import { phaseRole } from "../server/services/phase-runner.js";

const BUILT_INS = ["standard", "direct", "complex", "sdd-standard"];

test("server workflow adapter exposes the core workflow catalog", async () => {
  const source = await readFile(new URL("../server/services/workflow-definition.js", import.meta.url), "utf8");
  assert.match(source, /core\/workflow\/definition\.js/);
  assert.doesNotMatch(source, /const\s+WORK[A-Z_]*\s*=/);

  for (const name of BUILT_INS) {
    assert.ok(listWorkflows().includes(name), `${name} must be listed by core workflow catalog`);

    const core = getCoreWorkflow(name);
    const server = getServerWorkflow(name);
    assert.equal(server.name, core.name);
    assert.deepEqual(server.phases, core.phases);
    assert.deepEqual(server.roleForPhase, core.roleForPhase);
    assert.deepEqual(server.dispatchForPhase, core.dispatchForPhase);
  }
});

test("legacy server workflow helpers remain phase-compatible", () => {
  for (const name of BUILT_INS) {
    const core = getCoreWorkflow(name);
    const server = getServerWorkflow(name);

    assert.equal(serverNextPhase(server), coreNextPhase(core));
    for (const phase of core.phases) {
      assert.equal(serverNextPhase(server, phase), coreNextPhase(core, phase));
      assert.equal(phaseRole(phase), core.roleForPhase[phase]);
      assert.equal(serverBridgeForPhase(server, phase), "run-phase.js");
    }

    assert.equal(serverNextPhase(server, core.phases.at(-1)), null);
  }
});

test("server workflow adapter exposes registered DAG node metadata", () => {
  const workflowName = "contract-dag-workflow";
  const nodes = [
    { id: "plan_node", phase: "plan", role: "planner", dependsOn: [] },
    { id: "audit_node", phase: "audit", role: "verifier", dependsOn: ["plan_node"] },
  ];
  registerDagWorkflow(workflowName, { nodes, maxConcurrentNodes: 2 });

  const server = getServerWorkflow(workflowName);
  assert.equal(server.name, workflowName);
  assert.deepEqual(server.nodes, nodes);
  assert.deepEqual(server.phases, ["plan", "audit"]);
  assert.equal(server.maxConcurrentNodes, 2);
  assert.equal(server.roleForPhase.audit, "verifier");
  assert.equal(serverBridgeForPhase(server, "audit"), "run-phase.js");
});

test("supervisor nextPhaseFor follows the unified built-in workflow phases", () => {
  for (const name of BUILT_INS) {
    const workflow = getCoreWorkflow(name);
    const emptyJob = {
      workflow: name,
      status: "running",
      completedPhases: [],
      artifacts: {},
    };
    assert.equal(nextPhaseFor(emptyJob), workflow.phases[0]);

    const completedArtifacts = Object.fromEntries(
      workflow.phases.map((phase) => [phase, `${phase}-artifact.md`])
    );
    assert.equal(
      nextPhaseFor({ ...emptyJob, artifacts: completedArtifacts }),
      "complete"
    );
  }
});

test("phase policy full mode agrees with the core built-in workflow phases", () => {
  for (const name of BUILT_INS) {
    assert.deepEqual(
      resolveSemanticPhases({ workflow: name, planMode: "full" }).phases,
      getCoreWorkflow(name).phases
    );
  }
});

test("direct light mode still requires verify before completion", () => {
  assert.deepEqual(
    resolveSemanticPhases({ workflow: "direct", planMode: "light" }).phases,
    ["execute", "verify"]
  );
  assert.deepEqual(resolvePhases("direct", "light"), ["execute", "verify"]);

  const gate = evaluateCompletionGate({
    job: { workflow: "direct", planMode: "light", completedPhases: ["execute"] },
    workflowDag: { nodes: [{ id: "execute", phase: "execute" }] },
    parsedVerdict: null,
  });

  assert.equal(gate.outcome, "policy_invalid");
  assert.equal(gate.details.isMutating, true);
});
