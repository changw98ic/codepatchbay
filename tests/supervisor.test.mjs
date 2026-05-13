#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
import { recoverJobs, nextPhaseFor } from "../server/services/supervisor.js";

const root = await mkdtemp(path.join(tmpdir(), "flow-supervisor-"));

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

const recovered = await recoverJobs(root, { now: new Date("2026-05-13T01:00:00.000Z") });
assert.equal(recovered.length, 1);
assert.equal(recovered[0].jobId, job.jobId);
assert.equal(recovered[0].project, "demo");
assert.equal(nextPhaseFor(recovered[0]), "plan");

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

const leaseAwareRecovered = await recoverJobs(root, {
  now: new Date("2026-05-13T01:40:00.000Z"),
});
assert.deepEqual(
  leaseAwareRecovered.map((recoveredJob) => recoveredJob.jobId).sort(),
  [job.jobId, missingLeaseJob.jobId, staleLeaseJob.jobId].sort()
);
