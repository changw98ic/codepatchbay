#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireLease } from "../server/services/lease-manager.js";
import {
  blockJob,
  completePhase,
  completeJob,
  createJob,
  failJob,
  getJob,
  startPhase,
} from "../server/services/job-store.js";
import {
  bridgeForPhase,
  getStaleTrackerSnapshot,
  nextPhaseFor,
  recoverAndRun,
  recoverJobs,
  recoverOneJob,
} from "../server/services/supervisor.js";

// ---------------------------------------------------------------------------
// nextPhaseFor tests (unchanged from original)
// ---------------------------------------------------------------------------

const root = await mkdtemp(path.join(tmpdir(), "cpb-supervisor-"));

const job = await createJob(root, {
  project: "demo",
  task: "Add login",
  workflow: "standard",
  ts: "2026-05-13T00:00:00.000Z",
});

assert.equal(nextPhaseFor(), "");
assert.equal(nextPhaseFor({ status: "queued", artifacts: {} }), "plan");
assert.equal(nextPhaseFor({ status: "running", artifacts: { plan: "" } }), "plan");
assert.equal(nextPhaseFor({ status: "running", artifacts: { plan: "   " } }), "plan");
assert.equal(nextPhaseFor({ status: "running", artifacts: { plan: "\n" } }), "plan");
assert.equal(nextPhaseFor({ status: "running", artifacts: { plan: {} } }), "plan");
assert.equal(nextPhaseFor({ status: "running", artifacts: { plan: "plan.md" } }), "execute");
assert.equal(
  nextPhaseFor({ status: "running", artifacts: { plan: "plan.md", execute: "" } }),
  "execute"
);
assert.equal(
  nextPhaseFor({ status: "running", artifacts: { plan: "plan.md", execute: " \n " } }),
  "execute"
);
assert.equal(
  nextPhaseFor({ status: "running", artifacts: { plan: "plan.md", execute: {} } }),
  "execute"
);
assert.equal(
  nextPhaseFor({ status: "running", artifacts: { plan: "plan.md", execute: "deliverable.md" } }),
  "verify"
);
assert.equal(
  nextPhaseFor({
    status: "running",
    artifacts: { plan: "plan.md", execute: "deliverable.md", verify: "" },
  }),
  "verify"
);
assert.equal(
  nextPhaseFor({
    status: "running",
    artifacts: { plan: "plan.md", execute: "deliverable.md", verify: "\t" },
  }),
  "verify"
);
assert.equal(
  nextPhaseFor({
    status: "running",
    artifacts: { plan: "plan.md", execute: "deliverable.md", verify: {} },
  }),
  "verify"
);
assert.equal(
  nextPhaseFor({
    status: "running",
    artifacts: { plan: "plan.md", execute: "deliverable.md", verify: "verify.md" },
  }),
  "complete"
);
assert.equal(nextPhaseFor({ status: "completed", artifacts: {} }), "");
assert.equal(nextPhaseFor({ status: "failed", artifacts: {} }), "");
assert.equal(nextPhaseFor({ status: "blocked", artifacts: {} }), "");

// ---------------------------------------------------------------------------
// Setup jobs for recoverJobs tests (unchanged from original)
// ---------------------------------------------------------------------------

await startPhase(root, "demo", job.jobId, {
  phase: "plan",
  attempt: 1,
  leaseId: "missing-stale-lease",
  ts: "2026-05-13T00:01:00.000Z",
});

const completed = await createJob(root, {
  project: "demo",
  task: "Completed job",
  workflow: "standard",
  ts: "2026-05-13T00:10:00.000Z",
});
await completeJob(root, "demo", completed.jobId, {
  ts: "2026-05-13T00:11:00.000Z",
});

const failed = await createJob(root, {
  project: "demo",
  task: "Failed job",
  workflow: "standard",
  ts: "2026-05-13T00:20:00.000Z",
});
await failJob(root, "demo", failed.jobId, {
  reason: "verification failed",
  ts: "2026-05-13T00:21:00.000Z",
});

const blocked = await createJob(root, {
  project: "demo",
  task: "Blocked job",
  workflow: "standard",
  ts: "2026-05-13T00:30:00.000Z",
});
await blockJob(root, "demo", blocked.jobId, {
  reason: "needs operator input",
  ts: "2026-05-13T00:31:00.000Z",
});

// Grace period: first stale detection should NOT recover the job
const notYet = await recoverJobs(root, { now: new Date("2026-05-13T01:00:00.000Z") });
assert.equal(notYet.length, 0, "first stale detection should be within grace period");
const tracker1 = getStaleTrackerSnapshot();
assert.equal(tracker1[job.jobId]?.count, 1);

// Second stale detection: still within grace
const notYet2 = await recoverJobs(root, { now: new Date("2026-05-13T01:00:30.000Z") });
assert.equal(notYet2.length, 0, "second stale detection still within grace");
const tracker2 = getStaleTrackerSnapshot();
assert.equal(tracker2[job.jobId]?.count, 2);

// Third stale detection: grace exhausted — now recoverable
const recovered = await recoverJobs(root, { now: new Date("2026-05-13T01:01:00.000Z") });
assert.equal(recovered.length, 1);
assert.equal(recovered[0].jobId, job.jobId);
assert.equal(recovered[0].project, "demo");
assert.equal(nextPhaseFor(recovered[0]), "plan");
assert.equal(getStaleTrackerSnapshot()[job.jobId], undefined, "tracker cleaned up after recovery");

const state = await getJob(root, "demo", job.jobId);
assert.equal(state.status, "running");

const activeLeaseJob = await createJob(root, {
  project: "demo",
  task: "Active lease job",
  workflow: "standard",
  ts: "2026-05-13T01:10:00.000Z",
});
await startPhase(root, "demo", activeLeaseJob.jobId, {
  phase: "plan",
  attempt: 1,
  leaseId: "lease-active-plan",
  ts: "2026-05-13T01:11:00.000Z",
});
await acquireLease(root, {
  leaseId: "lease-active-plan",
  jobId: activeLeaseJob.jobId,
  phase: "plan",
  ttlMs: 60 * 60_000,
  now: new Date("2026-05-13T01:11:00.000Z"),
  ownerPid: 111,
});
assert.equal((await getJob(root, "demo", activeLeaseJob.jobId)).leaseId, "lease-active-plan");

const missingLeaseJob = await createJob(root, {
  project: "demo",
  task: "Missing lease job",
  workflow: "standard",
  ts: "2026-05-13T01:20:00.000Z",
});
await completePhase(root, "demo", missingLeaseJob.jobId, {
  phase: "plan",
  artifact: "plan.md",
  ts: "2026-05-13T01:21:00.000Z",
});
await startPhase(root, "demo", missingLeaseJob.jobId, {
  phase: "execute",
  attempt: 1,
  leaseId: "lease-missing-execute",
  ts: "2026-05-13T01:22:00.000Z",
});
assert.equal((await getJob(root, "demo", missingLeaseJob.jobId)).leaseId, "lease-missing-execute");

const staleLeaseJob = await createJob(root, {
  project: "demo",
  task: "Stale lease job",
  workflow: "standard",
  ts: "2026-05-13T01:30:00.000Z",
});
await completePhase(root, "demo", staleLeaseJob.jobId, {
  phase: "plan",
  artifact: "plan.md",
  ts: "2026-05-13T01:31:00.000Z",
});
await completePhase(root, "demo", staleLeaseJob.jobId, {
  phase: "execute",
  artifact: "deliverable.md",
  ts: "2026-05-13T01:32:00.000Z",
});
await startPhase(root, "demo", staleLeaseJob.jobId, {
  phase: "verify",
  attempt: 1,
  leaseId: "lease-stale-verify",
  ts: "2026-05-13T01:33:00.000Z",
});
await acquireLease(root, {
  leaseId: "lease-stale-verify",
  jobId: staleLeaseJob.jobId,
  phase: "verify",
  ttlMs: 1_000,
  now: new Date("2026-05-13T01:33:00.000Z"),
  ownerPid: 222,
});
assert.equal((await getJob(root, "demo", staleLeaseJob.jobId)).leaseId, "lease-stale-verify");

// Grace period for missingLeaseJob + staleLeaseJob (+ job still stale from earlier)
const leaseGrace1 = await recoverJobs(root, { now: new Date("2026-05-13T01:40:00.000Z") });
assert.equal(leaseGrace1.length, 0, "grace period call 1 — not yet");
const leaseGrace2 = await recoverJobs(root, { now: new Date("2026-05-13T01:40:30.000Z") });
assert.equal(leaseGrace2.length, 0, "grace period call 2 — not yet");
const leaseAwareRecovered = await recoverJobs(root, { now: new Date("2026-05-13T01:41:00.000Z") });
assert.deepEqual(
  leaseAwareRecovered.map((recoveredJob) => recoveredJob.jobId).sort(),
  [job.jobId, missingLeaseJob.jobId, staleLeaseJob.jobId].sort()
);

// ---------------------------------------------------------------------------
// bridgeForPhase tests
// ---------------------------------------------------------------------------

assert.deepEqual(bridgeForPhase("plan", "myapp", { task: "do stuff" }), {
  script: path.join("bridges", "codex-plan.sh"),
  args: ["myapp", "do stuff"],
});

assert.deepEqual(
  bridgeForPhase("execute", "myapp", { artifacts: { plan: "plan-001" } }),
  {
    script: path.join("bridges", "claude-execute.sh"),
    args: ["myapp", "001"],
  }
);

assert.deepEqual(
  bridgeForPhase("verify", "myapp", { artifacts: { execute: "deliverable-002" } }),
  {
    script: path.join("bridges", "codex-verify.sh"),
    args: ["myapp", "002"],
  }
);

assert.equal(bridgeForPhase("complete", "myapp", {}), null);
assert.equal(bridgeForPhase("unknown", "myapp", {}), null);

// ---------------------------------------------------------------------------
// recoverOneJob: "complete" phase marks job as completed
// ---------------------------------------------------------------------------

const readyToComplete = await createJob(root, {
  project: "demo",
  task: "Ready to complete",
  workflow: "standard",
  ts: "2026-05-13T02:00:00.000Z",
});
await completePhase(root, "demo", readyToComplete.jobId, {
  phase: "plan",
  artifact: "plan-done.md",
  ts: "2026-05-13T02:01:00.000Z",
});
await completePhase(root, "demo", readyToComplete.jobId, {
  phase: "execute",
  artifact: "deliverable-done.md",
  ts: "2026-05-13T02:02:00.000Z",
});
await completePhase(root, "demo", readyToComplete.jobId, {
  phase: "verify",
  artifact: "verdict-done.md",
  ts: "2026-05-13T02:03:00.000Z",
});

// Re-fetch the job state after all phase completions.
const readyToCompleteState = await getJob(root, "demo", readyToComplete.jobId);
const completeResult = await recoverOneJob(root, readyToCompleteState);
assert.equal(completeResult.phase, "complete");
assert.equal(completeResult.exitCode, 0);
assert.equal(completeResult.jobId, readyToComplete.jobId);

const completedState = await getJob(root, "demo", readyToComplete.jobId);
assert.equal(completedState.status, "completed");

// ---------------------------------------------------------------------------
// recoverOneJob: terminal jobs are skipped
// ---------------------------------------------------------------------------

const skipResult = await recoverOneJob(root, completedState);
assert.equal(skipResult.phase, "skipped");
assert.equal(skipResult.exitCode, 0);

// ---------------------------------------------------------------------------
// recoverOneJob: bridge spawn failure (script does not exist)
// ---------------------------------------------------------------------------

const noBridgeResult = await recoverOneJob(root, {
  jobId: "fake",
  project: "demo",
  status: "running",
  artifacts: {},
  task: "test",
});
// The plan bridge script will fail because the project doesn't have the
// required wiki directory. We just verify it returns a result without
// throwing.
assert.equal(noBridgeResult.jobId, "fake");
assert.equal(noBridgeResult.phase, "plan");
assert.ok(typeof noBridgeResult.exitCode === "number");

// ---------------------------------------------------------------------------
// recoverAndRun: full cycle with the "complete" job
// ---------------------------------------------------------------------------

// Create a job that has all artifacts (ready to complete).
const autoComplete = await createJob(root, {
  project: "demo",
  task: "Auto-complete test",
  workflow: "standard",
  ts: "2026-05-13T03:00:00.000Z",
});
await completePhase(root, "demo", autoComplete.jobId, {
  phase: "plan",
  artifact: "plan-auto.md",
  ts: "2026-05-13T03:01:00.000Z",
});
await completePhase(root, "demo", autoComplete.jobId, {
  phase: "execute",
  artifact: "deliverable-auto.md",
  ts: "2026-05-13T03:02:00.000Z",
});
await completePhase(root, "demo", autoComplete.jobId, {
  phase: "verify",
  artifact: "verdict-auto.md",
  ts: "2026-05-13T03:03:00.000Z",
});

const runResults = await recoverAndRun(root, {
  now: new Date("2026-05-13T03:10:00.000Z"),
  maxConcurrent: 2,
});

// autoComplete should be among results with phase "complete".
const autoResult = runResults.find((r) => r.jobId === autoComplete.jobId);
assert.ok(autoResult, "autoComplete job should appear in recoverAndRun results");
assert.equal(autoResult.phase, "complete");
assert.equal(autoResult.exitCode, 0);

// Verify the job is now completed in the store.
const autoState = await getJob(root, "demo", autoComplete.jobId);
assert.equal(autoState.status, "completed");

// ---------------------------------------------------------------------------
// recoverAndRun with empty root (no jobs at all)
// ---------------------------------------------------------------------------

const emptyRoot = await mkdtemp(path.join(tmpdir(), "cpb-supervisor-empty-"));
const emptyResults = await recoverAndRun(emptyRoot);
assert.deepEqual(emptyResults, []);

console.log("All supervisor tests passed.");
