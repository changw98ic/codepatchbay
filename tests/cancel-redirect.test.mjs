#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { materializeJob } from "../server/services/event-store.js";
import {
  createJob,
  startPhase,
  requestCancelJob,
  cancelJob,
  requestRedirectJob,
  consumeRedirect,
  getJob,
} from "../server/services/job-store.js";

const baseEvents = [
  {
    type: "job_created",
    jobId: "job-20260513-000001",
    project: "demo",
    task: "Add login",
    ts: "2026-05-13T00:00:00.000Z",
  },
  {
    type: "phase_started",
    jobId: "job-20260513-000001",
    phase: "plan",
    leaseId: "lease-1",
    ts: "2026-05-13T00:01:00.000Z",
  },
];

// --- materialization tests (pure function, no I/O) ---

{
  // cancel_requested sets cancelRequested=true but does NOT change status
  const state = materializeJob([
    ...baseEvents,
    {
      type: "job_cancel_requested",
      jobId: "job-20260513-000001",
      reason: "wrong branch",
      ts: "2026-05-13T00:02:00.000Z",
    },
  ]);
  assert.equal(state.cancelRequested, true);
  assert.equal(state.cancelReason, "wrong branch");
  assert.equal(state.status, "running", "cancel_requested should NOT change status");
}

{
  // cancelled sets status=cancelled
  const state = materializeJob([
    ...baseEvents,
    {
      type: "job_cancelled",
      jobId: "job-20260513-000001",
      reason: "wrong branch",
      ts: "2026-05-13T00:02:00.000Z",
    },
  ]);
  assert.equal(state.cancelRequested, true);
  assert.equal(state.status, "cancelled");
  assert.equal(state.leaseId, null);
}

{
  // redirect_requested sets pending redirect
  const state = materializeJob([
    ...baseEvents,
    {
      type: "job_redirect_requested",
      jobId: "job-20260513-000001",
      instructions: "Focus on error handling instead",
      reason: "scope change",
      redirectEventId: "re-1",
      ts: "2026-05-13T00:02:00.000Z",
    },
  ]);
  assert.equal(state.redirectContext, "Focus on error handling instead");
  assert.equal(state.redirectReason, "scope change");
  assert.equal(state.redirectEventId, "re-1");
  assert.equal(state.status, "running", "redirect_requested should NOT change status");
  assert.deepEqual(state.consumedRedirectIds, []);
}

{
  // redirect_consumed clears pending redirect, adds to consumedRedirectIds
  const state = materializeJob([
    ...baseEvents,
    {
      type: "job_redirect_requested",
      jobId: "job-20260513-000001",
      instructions: "Focus on error handling instead",
      reason: "scope change",
      redirectEventId: "re-1",
      ts: "2026-05-13T00:02:00.000Z",
    },
    {
      type: "job_redirect_consumed",
      jobId: "job-20260513-000001",
      redirectEventId: "re-1",
      ts: "2026-05-13T00:03:00.000Z",
    },
  ]);
  assert.equal(state.redirectContext, null, "consumed redirect should clear context");
  assert.equal(state.redirectReason, null, "consumed redirect should clear reason");
  assert.equal(state.redirectEventId, null, "consumed redirect should clear eventId");
  assert.deepEqual(state.consumedRedirectIds, ["re-1"]);
}

{
  // redirect consumed once, not repeated after recovery (re-materialization)
  // Simulate: redirect_requested -> redirect_consumed -> second consume of same ID
  const state = materializeJob([
    ...baseEvents,
    {
      type: "job_redirect_requested",
      jobId: "job-20260513-000001",
      instructions: "Change direction",
      reason: "pivot",
      redirectEventId: "re-2",
      ts: "2026-05-13T00:02:00.000Z",
    },
    {
      type: "job_redirect_consumed",
      jobId: "job-20260513-000001",
      redirectEventId: "re-2",
      ts: "2026-05-13T00:03:00.000Z",
    },
    // Duplicate consume event (e.g. recovery replay)
    {
      type: "job_redirect_consumed",
      jobId: "job-20260513-000001",
      redirectEventId: "re-2",
      ts: "2026-05-13T00:04:00.000Z",
    },
  ]);
  assert.deepEqual(state.consumedRedirectIds, ["re-2", "re-2"],
    "duplicate consume events should both be recorded");
  assert.equal(state.redirectContext, null, "redirect stays cleared after duplicate consume");
  assert.equal(state.redirectEventId, null);
}

{
  // redirect_consumed for a different eventId does not clear current redirect
  const state = materializeJob([
    ...baseEvents,
    {
      type: "job_redirect_requested",
      jobId: "job-20260513-000001",
      instructions: "First redirect",
      reason: "reason1",
      redirectEventId: "re-a",
      ts: "2026-05-13T00:02:00.000Z",
    },
    {
      type: "job_redirect_consumed",
      jobId: "job-20260513-000001",
      redirectEventId: "re-b",
      ts: "2026-05-13T00:03:00.000Z",
    },
  ]);
  assert.equal(state.redirectContext, "First redirect",
    "consuming a different redirectEventId should NOT clear current redirect");
  assert.deepEqual(state.consumedRedirectIds, ["re-b"]);
}

// --- job-store integration tests (I/O) ---

const root = await mkdtemp(path.join(tmpdir(), "cpb-cancel-redirect-"));
const project = "demo";

try {
  // Create a job and request cancel
  const created = await createJob(root, {
    project,
    task: "Cancel me",
    ts: "2026-05-13T10:00:00.000Z",
  });

  const cancelled = await requestCancelJob(root, project, created.jobId, {
    reason: "wrong task",
    ts: "2026-05-13T10:01:00.000Z",
  });
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.cancelReason, "wrong task");
  assert.equal(cancelled.status, "running", "requestCancel should not change status");

  // Full cancel
  const fullyCancelled = await cancelJob(root, project, created.jobId, {
    reason: "confirmed cancel",
    ts: "2026-05-13T10:02:00.000Z",
  });
  assert.equal(fullyCancelled.status, "cancelled");
  assert.equal(fullyCancelled.cancelRequested, true);

  // Redirect cpb
  const job2 = await createJob(root, {
    project,
    task: "Redirect me",
    ts: "2026-05-13T11:00:00.000Z",
  });
  await startPhase(root, project, job2.jobId, {
    phase: "execute",
    leaseId: "lease-2",
    ts: "2026-05-13T11:01:00.000Z",
  });

  const redirected = await requestRedirectJob(root, project, job2.jobId, {
    instructions: "Focus on tests only",
    reason: "scope reduction",
    ts: "2026-05-13T11:02:00.000Z",
  });
  assert.equal(redirected.redirectContext, "Focus on tests only");
  assert.equal(redirected.redirectReason, "scope reduction");
  assert.ok(redirected.redirectEventId, "should have a redirectEventId");
  assert.equal(redirected.status, "running");

  // Consume the redirect
  const consumed = await consumeRedirect(root, project, job2.jobId, {
    redirectEventId: redirected.redirectEventId,
    ts: "2026-05-13T11:03:00.000Z",
  });
  assert.equal(consumed.redirectContext, null, "consume should clear redirect context");
  assert.equal(consumed.redirectReason, null);
  assert.equal(consumed.redirectEventId, null);
  assert.deepEqual(consumed.consumedRedirectIds, [redirected.redirectEventId]);

  // Re-read from disk to verify persistence
  const reloaded = await getJob(root, project, job2.jobId);
  assert.equal(reloaded.redirectContext, null);
  assert.deepEqual(reloaded.consumedRedirectIds, [redirected.redirectEventId]);
} finally {
  await rm(root, { recursive: true });
}
