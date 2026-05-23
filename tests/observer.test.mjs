import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildChainSnapshot, analyzeChainSnapshot } from "../server/services/observer.js";
import { readEvents, materializeJob } from "../server/services/event-store.js";

// Helper: write JSONL event file for a job
async function writeEventFile(cpbRoot, project, jobId, events) {
  const eventsDir = path.join(cpbRoot, "cpb-task", "events", project);
  await mkdir(eventsDir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(path.join(eventsDir, `${jobId}.jsonl`), lines, "utf8");
}

// Helper: write a lease file
async function writeLeaseFile(cpbRoot, leaseId, lease) {
  const leasesDir = path.join(cpbRoot, "cpb-task", "leases");
  await mkdir(leasesDir, { recursive: true });
  await writeFile(
    path.join(leasesDir, `${leaseId}.json`),
    JSON.stringify(lease, null, 2) + "\n",
    "utf8",
  );
}

describe("observer", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `cpb-test-observer-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("healthy chain: active lease with recent events -> continue", async () => {
    const now = new Date();
    const jobId = "job-20260523-120000-abc123";
    const leaseId = "lease-active-001";

    await writeEventFile(tmpDir, "test-proj", jobId, [
      {
        type: "job_created",
        jobId,
        project: "test-proj",
        task: "add dark mode",
        ts: now.toISOString(),
      },
      {
        type: "phase_started",
        jobId,
        project: "test-proj",
        phase: "plan",
        leaseId,
        ts: new Date(now.getTime() - 10_000).toISOString(),
      },
      {
        type: "phase_activity",
        jobId,
        project: "test-proj",
        message: "working on plan",
        ts: new Date(now.getTime() - 5_000).toISOString(),
      },
    ]);

    await writeLeaseFile(tmpDir, leaseId, {
      leaseId,
      jobId,
      phase: "plan",
      ownerPid: 12345,
      ownerHost: "test",
      ownerToken: "tok-001",
      acquiredAt: new Date(now.getTime() - 10_000).toISOString(),
      heartbeatAt: new Date(now.getTime() - 5_000).toISOString(),
      expiresAt: new Date(now.getTime() + 120_000).toISOString(),
    });

    const snapshot = await buildChainSnapshot({
      cpbRoot: tmpDir,
      hubRoot: null,
      project: "test-proj",
      jobId,
    });

    assert.ok(snapshot.job);
    assert.equal(snapshot.job.status, "running");
    assert.equal(snapshot.job.leaseId, leaseId);
    assert.ok(snapshot.lease);
    assert.equal(snapshot.eventTail.length, 3);
    assert.ok(snapshot.timestamp);

    const analysis = analyzeChainSnapshot(snapshot);
    assert.equal(analysis.recommendation, "continue");
    assert.ok(analysis.reasons.length > 0);
  });

  it("waiting chain: running job, no lease, no issues -> wait", async () => {
    const now = new Date();
    const jobId = "job-20260523-130000-def456";

    // Job is running but has no lease (between phases) and no phase set
    await writeEventFile(tmpDir, "test-proj", jobId, [
      {
        type: "job_created",
        jobId,
        project: "test-proj",
        task: "add tests",
        ts: new Date(now.getTime() - 200_000).toISOString(),
      },
      {
        type: "phase_completed",
        jobId,
        project: "test-proj",
        phase: "plan",
        ts: new Date(now.getTime() - 180_000).toISOString(),
      },
      // Between phases: no lease, status is still running
    ]);

    // No lease file — job has no leaseId after phase_completed

    const snapshot = await buildChainSnapshot({
      cpbRoot: tmpDir,
      hubRoot: null,
      project: "test-proj",
      jobId,
    });

    const analysis = analyzeChainSnapshot(snapshot);
    assert.equal(analysis.recommendation, "wait");
  });

  it("blocked chain: permission_denied event -> blocked", async () => {
    const now = new Date();
    const jobId = "job-20260523-140000-ghi789";

    await writeEventFile(tmpDir, "test-proj", jobId, [
      {
        type: "job_created",
        jobId,
        project: "test-proj",
        task: "fix build",
        ts: now.toISOString(),
      },
      {
        type: "permission_denied",
        jobId,
        project: "test-proj",
        category: "infra",
        action: "write",
        reason: "permission denied",
        ts: now.toISOString(),
      },
    ]);

    const snapshot = await buildChainSnapshot({
      cpbRoot: tmpDir,
      hubRoot: null,
      project: "test-proj",
      jobId,
    });

    const analysis = analyzeChainSnapshot(snapshot);
    assert.equal(analysis.recommendation, "blocked");
    assert.ok(
      analysis.reasons.some((r) => r.includes("permission_denied")),
    );
  });

  it("stale chain: expired lease -> stale_process", async () => {
    const now = new Date();
    const jobId = "job-20260523-150000-jkl012";
    const leaseId = "lease-stale-001";

    await writeEventFile(tmpDir, "test-proj", jobId, [
      {
        type: "job_created",
        jobId,
        project: "test-proj",
        task: "refactor auth",
        ts: new Date(now.getTime() - 500_000).toISOString(),
      },
      {
        type: "phase_started",
        jobId,
        project: "test-proj",
        phase: "execute",
        leaseId,
        ts: new Date(now.getTime() - 500_000).toISOString(),
      },
    ]);

    // Lease expired 200s ago
    await writeLeaseFile(tmpDir, leaseId, {
      leaseId,
      jobId,
      phase: "execute",
      ownerPid: 12345,
      ownerHost: "test",
      ownerToken: "tok-003",
      acquiredAt: new Date(now.getTime() - 500_000).toISOString(),
      heartbeatAt: new Date(now.getTime() - 300_000).toISOString(),
      expiresAt: new Date(now.getTime() - 200_000).toISOString(),
    });

    const snapshot = await buildChainSnapshot({
      cpbRoot: tmpDir,
      hubRoot: null,
      project: "test-proj",
      jobId,
    });

    const analysis = analyzeChainSnapshot(snapshot);
    assert.equal(analysis.recommendation, "stale_process");
    assert.ok(analysis.reasons.some((r) => r.includes("lease expired")));
  });

  it("recovery chain: terminal failed job -> recover_as_new_job", async () => {
    const now = new Date();
    const jobId = "job-20260523-160000-mno345";

    await writeEventFile(tmpDir, "test-proj", jobId, [
      {
        type: "job_created",
        jobId,
        project: "test-proj",
        task: "broken feature",
        ts: now.toISOString(),
      },
      {
        type: "job_failed",
        jobId,
        project: "test-proj",
        reason: "plan artifact missing",
        code: "FATAL",
        ts: now.toISOString(),
      },
    ]);

    const snapshot = await buildChainSnapshot({
      cpbRoot: tmpDir,
      hubRoot: null,
      project: "test-proj",
      jobId,
    });

    const analysis = analyzeChainSnapshot(snapshot);
    assert.equal(analysis.recommendation, "recover_as_new_job");
    assert.ok(analysis.reasons.some((r) => r.includes("terminal")));
    assert.equal(analysis.details.failureCode, "FATAL");
  });

  it("snapshot has all expected fields", async () => {
    const now = new Date();
    const jobId = "job-20260523-170000-pqr678";

    await writeEventFile(tmpDir, "test-proj", jobId, [
      {
        type: "job_created",
        jobId,
        project: "test-proj",
        task: "verify snapshot shape",
        ts: now.toISOString(),
      },
    ]);

    const snapshot = await buildChainSnapshot({
      cpbRoot: tmpDir,
      hubRoot: null,
      project: "test-proj",
      jobId,
    });

    // All expected top-level keys present
    assert.ok(snapshot.hasOwnProperty("job"));
    assert.ok(snapshot.hasOwnProperty("eventTail"));
    assert.ok(snapshot.hasOwnProperty("lease"));
    assert.ok(snapshot.hasOwnProperty("acpPool"));
    assert.ok(snapshot.hasOwnProperty("queueEntry"));
    assert.ok(snapshot.hasOwnProperty("inboxPending"));
    assert.ok(snapshot.hasOwnProperty("reviewSession"));
    assert.ok(snapshot.hasOwnProperty("timestamp"));

    // Job materialized correctly
    assert.ok(snapshot.job);
    assert.equal(snapshot.job.jobId, jobId);
    assert.equal(snapshot.job.status, "running");

    // eventTail has the single event
    assert.equal(snapshot.eventTail.length, 1);

    // No lease expected (job has no leaseId)
    assert.equal(snapshot.lease, null);

    // ACP pool field is present (may be null or a status object depending on env)
    assert.ok(snapshot.acpPool === null || typeof snapshot.acpPool === "object");

    // Timestamp is valid ISO
    assert.ok(!Number.isNaN(Date.parse(snapshot.timestamp)));
  });
});
