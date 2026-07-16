#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveDagResumeState } from "../core/workflow/dag-executor.js";
import { materializeJob, appendEvent } from "../server/services/event/event-store.js";
import { createJob, failJob, getJob, retryJob } from "../server/services/job/job-store.js";
import { jobToPipelineState, jobToQueueRow } from "../server/services/job/job-projection.js";

const workflowDag = {
  name: "parallel-execute",
  nodes: [
    { id: "plan", phase: "plan", dependsOn: [] },
    { id: "execute_a", phase: "execute", dependsOn: ["plan"] },
    { id: "execute_b", phase: "execute", dependsOn: ["plan"] },
    { id: "verify", phase: "verify", dependsOn: ["execute_a", "execute_b"] },
  ],
};

function ts(offset = 0) {
  return new Date(Date.UTC(2026, 5, 11, 0, 0, 0, offset)).toISOString();
}

function materialize(...events) {
  return materializeJob([
    { type: "job_created", jobId: "j1", project: "p", task: "t", workflow: "standard", ts: ts(0) },
    ...events,
  ]);
}

describe("deriveDagResumeState", () => {
  it("uses concrete node ids to derive ready, failed, blocked, and resume target", () => {
    const resume = deriveDagResumeState({
      workflowDag,
      nodeStates: {
        plan: { status: "completed", phase: "plan" },
        execute_b: { status: "failed", phase: "execute", reason: "tests failed" },
      },
      phaseStates: {
        plan: "completed",
        execute: "completed",
      },
    });

    assert.deepEqual(resume.completedNodeIds, ["plan"]);
    assert.equal(resume.failedNodeId, "execute_b");
    assert.deepEqual(resume.readyNodeIds, ["execute_a", "execute_b"]);
    assert.deepEqual(resume.blockedNodeIds, ["verify"]);
    assert.deepEqual(resume.resumeTarget, { nodeId: "execute_b", phase: "execute" });
    assert.ok(!resume.completedNodeIds.includes("execute"));
  });

  it("falls back to phase names only for legacy jobs without DAG nodes", () => {
    const resume = deriveDagResumeState({
      workflowDag: null,
      nodeStates: {},
      phaseStates: {
        plan: "completed",
        execute: "failed",
        verify: "pending",
      },
    });

    assert.deepEqual(resume.completedNodeIds, ["plan"]);
    assert.equal(resume.failedNodeId, "execute");
    assert.deepEqual(resume.resumeTarget, { nodeId: "execute", phase: "execute" });
  });

  it("preserves node-state ids when workflow DAG metadata is missing", () => {
    const resume = deriveDagResumeState({
      workflowDag: null,
      nodeStates: {
        n1: { status: "completed", phase: "build" },
        n2: { status: "failed", phase: "verify", reason: "failed" },
      },
      phaseStates: {
        build: "completed",
        verify: "failed",
      },
    });

    assert.deepEqual(resume.completedNodeIds, ["n1"]);
    assert.equal(resume.failedNodeId, "n2");
    assert.deepEqual(resume.readyNodeIds, ["n2"]);
    assert.deepEqual(resume.resumeTarget, { nodeId: "n2", phase: "verify" });
    assert.ok(!resume.completedNodeIds.includes("build"));
  });
});

describe("DAG resume event materialization", () => {
  it("does not synthesize bare phase node ids when concrete node ids exist", () => {
    const state = materialize(
      { type: "workflow_dag_materialized", workflow: "standard", workflowDag, ts: ts(1) },
      { type: "phase_completed", phase: "plan", ts: ts(2) },
      { type: "phase_completed", phase: "execute", ts: ts(3) },
      { type: "dag_node_failed", nodeId: "execute_b", phase: "execute", reason: "failed", ts: ts(4) },
    );

    assert.deepEqual(state.completedPhases, ["plan", "execute"]);
    assert.deepEqual(state.dagResume.completedNodeIds, ["plan"]);
    assert.ok(!state.completedNodes.includes("execute"));
    assert.ok(!state.dagResume.completedNodeIds.includes("execute"));
    assert.equal(state.dagResume.failedNodeId, "execute_b");
    assert.deepEqual(state.dagResume.resumeTarget, { nodeId: "execute_b", phase: "execute" });
    assert.deepEqual(state.dagResume.blockedNodeIds, ["verify"]);
  });

  it("uses phase fallback for legacy jobs without workflow DAG node ids", () => {
    const state = materialize(
      { type: "phase_completed", phase: "plan", ts: ts(1) },
      { type: "phase_failed", phase: "execute", error: "boom", ts: ts(2) },
    );

    assert.deepEqual(state.dagResume.completedNodeIds, ["plan"]);
    assert.equal(state.dagResume.failedNodeId, "execute");
    assert.deepEqual(state.dagResume.resumeTarget, { nodeId: "execute", phase: "execute" });
  });

  it("preserves dag_node event ids even when workflow DAG metadata is absent", () => {
    const completedState = materialize(
      { type: "phase_completed", phase: "build", ts: ts(1) },
      { type: "dag_node_completed", nodeId: "n1", phase: "build", ts: ts(2) },
    );
    assert.deepEqual(completedState.dagResume.completedNodeIds, ["n1"]);
    assert.ok(!completedState.dagResume.completedNodeIds.includes("build"));

    const failedState = materialize(
      { type: "dag_node_failed", nodeId: "n1", phase: "build", reason: "failed", ts: ts(1) },
    );
    assert.equal(failedState.dagResume.failedNodeId, "n1");
    assert.deepEqual(failedState.dagResume.resumeTarget, { nodeId: "n1", phase: "build" });
  });

  it("treats post-terminal dag_node events as audit-only for business projection", () => {
    const beforeLateAudit = materialize(
      { type: "workflow_dag_materialized", workflow: "standard", workflowDag, ts: ts(1) },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", ts: ts(2) },
      { type: "dag_node_failed", nodeId: "execute_b", phase: "execute", reason: "failed", ts: ts(3) },
      { type: "job_failed", phase: "execute", reason: "failed", ts: ts(4) },
    );
    const afterLateAudit = materialize(
      { type: "workflow_dag_materialized", workflow: "standard", workflowDag, ts: ts(1) },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", ts: ts(2) },
      { type: "dag_node_failed", nodeId: "execute_b", phase: "execute", reason: "failed", ts: ts(3) },
      { type: "job_failed", phase: "execute", reason: "failed", ts: ts(4) },
      { type: "dag_node_completed", nodeId: "execute_b", phase: "execute", ts: ts(5) },
      { type: "dag_node_failed", nodeId: "verify", phase: "verify", reason: "late", ts: ts(6) },
    );

    assert.equal(afterLateAudit.status, "failed");
    assert.deepEqual(afterLateAudit.nodeStates, beforeLateAudit.nodeStates);
    assert.deepEqual(afterLateAudit.dagResume, beforeLateAudit.dagResume);
  });
});

describe("DAG resume projection and recovery lineage", () => {
  it("projects workflowDag and dagResume into pipeline state", () => {
    const job = materialize(
      { type: "workflow_dag_materialized", workflow: "standard", workflowDag, ts: ts(1) },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", ts: ts(2) },
      { type: "dag_node_failed", nodeId: "execute_b", phase: "execute", reason: "failed", ts: ts(3) },
    );
    const pipeline = jobToPipelineState(job);

    assert.deepEqual(pipeline.workflowDag, workflowDag);
    assert.deepEqual(pipeline.dagResume, job.dagResume);
    assert.equal(pipeline.dagResume.failedNodeId, "execute_b");
  });

  it("projects completion report and runtime policy fields for Hub consumers", () => {
    const completionReport = {
      changedFiles: ["core/engine/run-job.ts"],
      realActors: ["Engine.runJob"],
      evidenceClasses: ["canonical_command"],
      residualRisk: ["manual review still required"],
    };
    const phaseBudgetPolicy = {
      riskLevel: "high",
      phases: {
        plan: { maxToolCalls: 40 },
        execute: { noEditToolLimit: 5 },
      },
    };
    const job = {
      jobId: "j1",
      project: "p",
      task: "render report",
      status: "completed",
      completionGate: { outcome: "complete" },
      completionReport,
      phaseBudgetPolicy,
      evidenceRequirements: ["canonical_command", "real_path_trace"],
    };

    const pipeline = jobToPipelineState(job);
    const row = jobToQueueRow(job);

    assert.deepEqual(pipeline.completionReport, completionReport);
    assert.deepEqual(pipeline.phaseBudgetPolicy, phaseBudgetPolicy);
    assert.deepEqual(pipeline.evidenceRequirements, ["canonical_command", "real_path_trace"]);
    assert.deepEqual(row.completionReport, completionReport);
    assert.deepEqual(row.phaseBudgetPolicy, phaseBudgetPolicy);
    assert.deepEqual(row.evidenceRequirements, ["canonical_command", "real_path_trace"]);
  });

  it("preserves failed node resume context when retrying as a new recovery job", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-dag-resume-"));
    const dataRoot = path.join(root, "runtime");
    const project = "dag-resume";
    const job = await createJob(root, {
      project,
      task: "node-aware retry",
      workflow: "standard",
      ts: ts(1),
      dataRoot,
    });
    await appendEvent(root, project, job.jobId, {
      type: "workflow_dag_materialized",
      jobId: job.jobId,
      project,
      workflow: "standard",
      workflowDag,
      ts: ts(2),
    }, { dataRoot });
    await appendEvent(root, project, job.jobId, {
      type: "dag_node_completed",
      jobId: job.jobId,
      project,
      nodeId: "plan",
      phase: "plan",
      ts: ts(3),
    }, { dataRoot });
    await appendEvent(root, project, job.jobId, {
      type: "dag_node_failed",
      jobId: job.jobId,
      project,
      nodeId: "execute_b",
      phase: "execute",
      reason: "node failed",
      ts: ts(4),
    }, { dataRoot });
    await failJob(root, project, job.jobId, {
      reason: "node failed",
      phase: "execute",
      retryable: true,
      ts: ts(5),
      dataRoot,
    });

    const failed = await getJob(root, project, job.jobId, { dataRoot });
    assert.equal(failed.dagResume.failedNodeId, "execute_b");

    const retried = await retryJob(root, project, job.jobId, {
      force: true,
      ts: ts(6),
      dataRoot,
    });

    assert.deepEqual(retried.sourceContext.dagResume, {
      failedNodeId: "execute_b",
      resumeTarget: { nodeId: "execute_b", phase: "execute" },
      completedNodeIds: ["plan"],
    });
    assert.equal(retried.sourceContext.retry.previousNodeId, "execute_b");
    assert.deepEqual(retried.sourceContext.retry.resumeTarget, { nodeId: "execute_b", phase: "execute" });
    assert.deepEqual(retried.sourceContext.retry.completedNodeIds, ["plan"]);
  });
});
