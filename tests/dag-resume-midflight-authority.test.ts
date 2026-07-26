#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { materializeJob, appendEvent } from "../server/services/event/event-store.js";
import { createJob, getJob } from "../server/services/job/job-store.js";

// Locks the invariant that the (refuted) "split-brain" P0 brief attacked.
//
// For a NON-terminal mid-flight job there is no checkpoint (checkpoints are
// terminal-only — checkpointJob returns null unless TERMINAL_STATUSES.has).
// Therefore dagResume MUST be rebuilt purely from the event log on every read,
// via event-materializer._syncDagResume -> deriveDagResumeState. A future
// change that re-introduces a second, stale resume store must turn these red.
//
// The existing dag-resume-contract.test.ts covers the TERMINAL (failJob'd) read
// path and the retry propagation. This file pins the NON-terminal mid-flight
// case, which is the exact scenario the brief weaponized.

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

function materialize(...events: Array<Record<string, unknown>>) {
  return materializeJob([
    { type: "job_created", jobId: "j1", project: "p", task: "t", workflow: "standard", ts: ts(0) },
    ...events,
  ]);
}

describe("mid-flight DAG resume authority (single source = event log)", () => {
  it("rebuilds dagResume from the event log for a NON-terminal job (no checkpoint)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cpb-midflight-"));
    const dataRoot = path.join(root, "runtime");
    const project = "midflight-authority";
    try {
      const job = await createJob(root, {
        project,
        task: "mid-flight crash scenario",
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
      // Two nodes completed and OBSERVED in the event log before the crash.
      await appendEvent(root, project, job.jobId, {
        type: "dag_node_completed",
        jobId: job.jobId,
        project,
        nodeId: "plan",
        phase: "plan",
        ts: ts(3),
      }, { dataRoot });
      await appendEvent(root, project, job.jobId, {
        type: "dag_node_completed",
        jobId: job.jobId,
        project,
        nodeId: "execute_a",
        phase: "execute",
        ts: ts(4),
      }, { dataRoot });

      // Job is NON-terminal (no failJob/completeJob) — simulates a mid-flight
      // crash. No checkpoint file can exist for a non-terminal job, so the
      // resume authority must be the event log alone.
      const observed = await getJob(root, project, job.jobId, { dataRoot });
      assert.deepEqual(
        observed.dagResume.completedNodeIds,
        ["plan", "execute_a"],
        "completedNodeIds must be rebuilt from dag_node_completed events",
      );
      assert.ok(!observed.dagResume.completedNodeIds.includes("execute_b"));
      assert.ok(!observed.dagResume.completedNodeIds.includes("verify"));

      // Determinism: re-reading the same non-terminal log yields an identical
      // dagResume (no second mutable store, no time-dependent drift).
      const replayed = await getJob(root, project, job.jobId, { dataRoot });
      assert.deepEqual(replayed.dagResume, observed.dagResume);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializeJob derives dagResume from events on the non-terminal path (no checkpoint consulted)", () => {
    // Guards the terminal-only checkpoint design choice directly: a
    // non-terminal job's dagResume comes from materializeJob(events), never
    // from a checkpoint read. This is the feature that makes mid-flight resume
    // correct, and it must not be accidentally widened to consult a checkpoint.
    const state = materialize(
      { type: "workflow_dag_materialized", workflow: "standard", workflowDag, ts: ts(1) },
      { type: "dag_node_completed", nodeId: "plan", phase: "plan", ts: ts(2) },
      { type: "dag_node_completed", nodeId: "execute_a", phase: "execute", ts: ts(3) },
    );
    assert.deepEqual(state.dagResume.completedNodeIds, ["plan", "execute_a"]);
    assert.notEqual(state.status, "failed");
    assert.notEqual(state.status, "completed");
  });
});
