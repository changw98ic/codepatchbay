import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getWorkflow, normalizeWorkflow, listWorkflows } from "../core/workflow/definition.js";
import { normalizeDispatchFeedback, ROUTING_FEEDBACK_EXIT_CODE } from "../core/workflow/dispatch-feedback.js";
import { classifyRoute } from "../core/workflow/triage.js";
import { buildExecuteScriptArgs, findParentPlan, resolvePlanDecision } from "../bridges/run-pipeline.mjs";

describe("direct workflow and planMode routing", () => {
  it("defines direct as execute -> verify without a plan phase", () => {
    assert.ok(listWorkflows().includes("direct"));

    const workflow = getWorkflow("direct");
    assert.deepEqual(workflow.phases, ["execute", "verify"]);

    const dag = normalizeWorkflow("direct");
    assert.deepEqual(dag.nodes.map((node) => node.id), ["execute", "verify"]);
    assert.deepEqual(dag.nodes.find((node) => node.id === "execute").dependsOn, []);
    assert.deepEqual(dag.nodes.find((node) => node.id === "verify").dependsOn, ["execute"]);
  });

  it("skips planning when workflow has no plan or planMode is none", () => {
    assert.deepEqual(resolvePlanDecision(getWorkflow("direct"), { planMode: "auto" }), {
      requestedPlanMode: "auto",
      planMode: "none",
      runPlan: false,
      reason: "workflow has no plan phase",
    });
    assert.deepEqual(resolvePlanDecision(getWorkflow("standard"), { planMode: "none" }), {
      requestedPlanMode: "none",
      planMode: "none",
      runPlan: false,
      reason: "planMode=none",
    });
    assert.deepEqual(resolvePlanDecision(getWorkflow("standard"), { planMode: "light" }), {
      requestedPlanMode: "light",
      planMode: "light",
      runPlan: true,
      reason: "plan phase enabled",
    });
  });

  it("resolves parent planMode to reuse or fallback", () => {
    const workflow = getWorkflow("standard");
    assert.deepEqual(
      resolvePlanDecision(workflow, {
        planMode: "parent",
        parentPlanResult: { planId: "007", parentJobId: "job-20260525-120000-aaaaaa", reason: "reused" },
      }),
      {
        requestedPlanMode: "parent",
        planMode: "parent",
        runPlan: false,
        planId: "007",
        parentJobId: "job-20260525-120000-aaaaaa",
        reason: "reused",
      }
    );

    assert.deepEqual(resolvePlanDecision(workflow, { planMode: "parent", parentPlanResult: null }), {
      requestedPlanMode: "parent",
      planMode: "full",
      runPlan: true,
      reason: "parent plan not found, fallback to full",
    });
  });

  it("passes job id before plan id so execute uses locator-first mode", () => {
    assert.deepEqual(buildExecuteScriptArgs({
      project: "frontend",
      planId: "042",
      jobId: "job-20260525-120000-aaaaaa",
    }), [
      "execute",
      "--project",
      "frontend",
      "--job-id",
      "job-20260525-120000-aaaaaa",
      "--plan-id",
      "042",
    ]);
  });

  it("classifies deterministic route defaults", () => {
    assert.deepEqual(classifyRoute({
      labels: ["docs"],
      title: "Update README examples",
      actor: "octocat",
      trustedActors: ["octocat"],
    }).effective, {
      workflow: "direct",
      planMode: "none",
    });

    const protectedRoute = classifyRoute({
      labels: ["backend"],
      title: "Fix payment auth token rotation",
      actor: "dependabot[bot]",
    });
    assert.equal(protectedRoute.effective.workflow, "complex");
    assert.equal(protectedRoute.effective.planMode, "full");
    assert.equal(protectedRoute.requested.reviewer, true);
    assert.equal(protectedRoute.protectedUpgrade, true);
    assert.equal(protectedRoute.actorTrust.trusted, false);
    assert.equal(protectedRoute.actorTrust.level, "bot");

    assert.deepEqual(classifyRoute({ labels: ["sdd"], title: "Add checkout flow spec" }).effective, {
      workflow: "sdd-standard",
      planMode: "parent",
    });

    assert.deepEqual(classifyRoute({ labels: ["feature"], title: "Improve dashboard loading" }).effective, {
      workflow: "standard",
      planMode: "light",
    });
  });

  it("normalizes executor routing feedback for upgrade dispatch", () => {
    assert.equal(ROUTING_FEEDBACK_EXIT_CODE, 42);
    assert.deepEqual(normalizeDispatchFeedback({
      requested: { workflow: "complex", planMode: "full" },
      reason: "touches auth and database migrations",
      confidence: 0.9,
      signals: ["auth", "db"],
    }, { jobId: "job-20260525-120000-bbbbbb", project: "frontend" }), {
      schemaVersion: 1,
      jobId: "job-20260525-120000-bbbbbb",
      project: "frontend",
      phase: "execute",
      requested: { workflow: "complex", planMode: "full", reviewer: true },
      reason: "touches auth and database migrations",
      confidence: 0.9,
      signals: ["auth", "db"],
    });
  });

  it("rejects executor routing feedback that asks for a weaker no-plan route", () => {
    assert.throws(
      () => normalizeDispatchFeedback({
        requested: { workflow: "direct", planMode: "none" },
        reason: "executor should never downgrade itself",
      }),
      /only request stronger workflows/,
    );

    assert.throws(
      () => normalizeDispatchFeedback({
        requested: { workflow: "standard", planMode: "none" },
        reason: "no-plan feedback would bypass planner",
      }),
      /only request stronger plan modes/,
    );
  });
});
