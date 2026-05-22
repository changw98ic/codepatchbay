import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  validateEventStream,
  reconcileJobs,
  cleanupDryRun,
  cleanupJobs,
} from "../server/services/reconcile.js";
import { appendEvent } from "../server/services/runtime-events.js";
import { createJob, failJob, completeJob, startPhase } from "../server/services/job-store.js";
import { acquireLease, readLease } from "../server/services/lease-manager.js";
import { rebuildJobsIndex, readJobsIndex } from "../server/services/jobs-index.js";
import { resolveHubRoot } from "../server/services/hub-registry.js";
import { registerProcess, getProcess, listProcesses } from "../server/services/process-registry.js";
import { enqueue, updateEntry, listQueue, loadQueue } from "../server/services/hub-queue.js";

function mkdtemp(prefix) {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return mkdir(dir, { recursive: true }).then(() => dir);
}

async function makeCpbRoot() {
  const dir = await mkdtemp("cpb-rec-");
  await mkdir(path.join(dir, "cpb-task"), { recursive: true });
  return dir;
}

async function writeJsonl(filePath, lines) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, lines.join("\n") + "\n", "utf8");
}

async function fileModTime(filePath) {
  const s = await stat(filePath);
  return s.mtimeMs;
}

describe("validateEventStream", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("returns valid for a clean JSONL file", async () => {
    const project = "testproj";
    const jobId = "job-test-clean";
    const file = path.join(cpbRoot, "cpb-task", "events", project, `${jobId}.jsonl`);
    await writeJsonl(file, [
      JSON.stringify({ type: "job_created", jobId, project, task: "test", ts: new Date().toISOString() }),
    ]);
    const result = await validateEventStream(cpbRoot, project, jobId);
    assert.equal(result.valid, true);
    assert.equal(result.events.length, 1);
    assert.equal(result.repaired, false);
  });

  it("repairs a truncated final line", async () => {
    const project = "testproj";
    const jobId = "job-test-trunc";
    const file = path.join(cpbRoot, "cpb-task", "events", project, `${jobId}.jsonl`);
    const validEvent = JSON.stringify({ type: "job_created", jobId, project, task: "test", ts: new Date().toISOString() });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, validEvent + "\n" + '{"type":"phase_started","incom', "utf8");

    const result = await validateEventStream(cpbRoot, project, jobId);
    assert.equal(result.valid, true);
    assert.equal(result.repaired, true);
    assert.equal(result.events.length, 1);

    const repaired = await readFile(file, "utf8");
    assert.ok(repaired.endsWith("\n"));
    assert.equal(repaired.trim().split("\n").length, 1);
  });

  it("fails on malformed middle line without rewriting", async () => {
    const project = "testproj";
    const jobId = "job-test-midbad";
    const file = path.join(cpbRoot, "cpb-task", "events", project, `${jobId}.jsonl`);
    const validEvent = JSON.stringify({ type: "job_created", jobId, project, task: "test", ts: new Date().toISOString() });
    const validEvent2 = JSON.stringify({ type: "phase_started", jobId, project, phase: "plan", ts: new Date().toISOString() });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, validEvent + "\nTHIS_IS_NOT_JSON\n" + validEvent2 + "\n", "utf8");

    const modBefore = await fileModTime(file);
    const result = await validateEventStream(cpbRoot, project, jobId);
    assert.equal(result.valid, false);
    assert.equal(result.repaired, false);
    assert.ok(result.error);
    assert.equal(result.error.lineNumber, 2);
    assert.match(result.error.reason, /malformed/);

    const modAfter = await fileModTime(file);
    assert.equal(modBefore, modAfter);
  });

  it("returns valid for missing file", async () => {
    const result = await validateEventStream(cpbRoot, "testproj", "job-noexist");
    assert.equal(result.valid, true);
    assert.equal(result.events.length, 0);
  });
});

describe("reconcileJobs - stale jobs", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("detects stale running job with expired lease and dead owner", async () => {
    const project = "rectest";
    const job = await createJob(cpbRoot, { project, task: "stale test" });
    const leaseId = `lease-${job.jobId}-plan`;

    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 1,
      ownerPid: 999999999,
    });
    await new Promise((r) => setTimeout(r, 10));

    const report = await reconcileJobs(cpbRoot, { dryRun: true });
    assert.ok(report.staleJobs.length >= 1);
    const found = report.staleJobs.find((j) => j.jobId === job.jobId);
    assert.ok(found, "stale job should be detected");
    assert.match(found.reason, /owner process dead|no lease|expired/);

    // Dry-run: job should still be running
    const { listJobs } = await import("../server/services/job-store.js");
    const jobs = await listJobs(cpbRoot);
    const afterDryRun = jobs.find((j) => j.jobId === job.jobId);
    assert.equal(afterDryRun.status, "running");

    // Now do actual reconcile
    const report2 = await reconcileJobs(cpbRoot, { dryRun: false });
    const found2 = report2.staleJobs.find((j) => j.jobId === job.jobId);
    assert.ok(found2, "stale job should be reconciled");

    const jobs2 = await listJobs(cpbRoot);
    const afterReconcile = jobs2.find((j) => j.jobId === job.jobId);
    assert.equal(afterReconcile.status, "failed");
    assert.match(afterReconcile.blockedReason, /stale_runtime_reconciled/);
  });

  it("is idempotent: running twice does not duplicate events", async () => {
    const project = "idemtest";
    const job = await createJob(cpbRoot, { project, task: "idempotent test" });
    const leaseId = `lease-${job.jobId}-plan`;

    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 1,
      ownerPid: 999999999,
    });
    await new Promise((r) => setTimeout(r, 10));

    await reconcileJobs(cpbRoot, { dryRun: false });
    const report2 = await reconcileJobs(cpbRoot, { dryRun: false });
    const foundAgain = report2.staleJobs.find((j) => j.jobId === job.jobId);
    assert.equal(foundAgain, undefined);
  });
});

describe("reconcileJobs - orphan leases", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("detects orphan lease referencing missing job", async () => {
    const leaseId = "lease-orphan-test-001";
    const leasesDir = path.join(cpbRoot, "cpb-task", "leases");
    await mkdir(leasesDir, { recursive: true });
    await writeFile(
      path.join(leasesDir, `${leaseId}.json`),
      JSON.stringify({
        leaseId,
        jobId: "job-nonexistent-999",
        phase: "plan",
        ownerPid: 999999999,
        ownerHost: "test",
        ownerToken: "test-token",
        acquiredAt: new Date(Date.now() - 600_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 600_000).toISOString(),
        expiresAt: new Date(Date.now() - 300_000).toISOString(),
      }) + "\n",
      "utf8"
    );

    const report = await reconcileJobs(cpbRoot, { dryRun: true });
    const found = report.orphanLeases.find((l) => l.leaseId === leaseId);
    assert.ok(found, "orphan lease should be detected");
    assert.equal(found.reason, "job not found");

    // Dry-run: lease file should still exist
    await assert.doesNotReject(() => stat(path.join(leasesDir, `${leaseId}.json`)));

    await reconcileJobs(cpbRoot, { dryRun: false });
    await assert.rejects(() => stat(path.join(leasesDir, `${leaseId}.json`)));
  });
});

describe("cleanupDryRun", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("reports planned cleanup without mutating state", async () => {
    const project = "cleanuptest";
    const job = await createJob(cpbRoot, { project, task: "cleanup test" });
    await completeJob(cpbRoot, project, job.jobId);

    const report = await cleanupDryRun(cpbRoot);
    assert.equal(typeof report.totalJobCount, "number");
    assert.ok(report.totalJobCount >= 1);
    assert.ok(Array.isArray(report.leasesToRemove));
    assert.ok(Array.isArray(report.worktreesPreserved));
  });

  it("preserves failed worktrees in report", async () => {
    const project = "worktreepres";
    const job = await createJob(cpbRoot, { project, task: "worktree pres test" });
    await appendEvent(cpbRoot, project, job.jobId, {
      type: "worktree_created",
      jobId: job.jobId,
      project,
      worktree: "/tmp/cpb-worktree-test-456",
      ts: new Date().toISOString(),
    });
    await failJob(cpbRoot, project, job.jobId, { reason: "test failure" });

    const report = await cleanupDryRun(cpbRoot);
    const preserved = report.worktreesPreserved.find((w) => w.jobId === job.jobId);
    assert.ok(preserved, "failed job worktree should be in preserved list");
    assert.equal(preserved.worktree, "/tmp/cpb-worktree-test-456");
    assert.equal(preserved.status, "failed");
  });
});

describe("cleanupJobs", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("removes terminal leases but preserves running job leases", async () => {
    const project = "cleanact";

    const completedJob = await createJob(cpbRoot, { project, task: "completed" });
    const completedLeaseId = `lease-${completedJob.jobId}-plan`;
    await acquireLease(cpbRoot, {
      leaseId: completedLeaseId,
      jobId: completedJob.jobId,
      phase: "plan",
      ttlMs: 600_000,
    });
    await completeJob(cpbRoot, project, completedJob.jobId);

    const runningJob = await createJob(cpbRoot, { project, task: "running" });
    const runningLeaseId = `lease-${runningJob.jobId}-plan`;
    await acquireLease(cpbRoot, {
      leaseId: runningLeaseId,
      jobId: runningJob.jobId,
      phase: "plan",
      ttlMs: 600_000,
    });

    const result = await cleanupJobs(cpbRoot);
    assert.ok(result.cleaned >= 1, "should clean at least the completed job's lease");

    const { readLease } = await import("../server/services/lease-manager.js");
    const runningLease = await readLease(cpbRoot, runningLeaseId);
    assert.ok(runningLease, "running job's lease should NOT be cleaned");

    const completedLease = await readLease(cpbRoot, completedLeaseId);
    assert.equal(completedLease, null, "completed job's lease should be cleaned");
  });
});

describe("jobs-index rebuild", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("rebuilds index from event streams", async () => {
    const project = "indextest";
    const job = await createJob(cpbRoot, { project, task: "index rebuild" });
    await completeJob(cpbRoot, project, job.jobId);

    const index = await rebuildJobsIndex(cpbRoot);
    assert.ok(index._meta);
    assert.ok(index.jobs[`${project}/${job.jobId}`]);

    const state = index.jobs[`${project}/${job.jobId}`];
    assert.equal(state.status, "completed");
  });
});

describe("validateEventStream - dry-run", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("does not mutate truncated JSONL in dry-run mode", async () => {
    const project = "dryrunproj";
    const jobId = "job-dryrun-trunc";
    const file = path.join(cpbRoot, "cpb-task", "events", project, `${jobId}.jsonl`);
    const validEvent = JSON.stringify({ type: "job_created", jobId, project, task: "test", ts: new Date().toISOString() });
    await mkdir(path.dirname(file), { recursive: true });
    const originalContent = validEvent + "\n" + '{"type":"phase_started","incom';
    await writeFile(file, originalContent, "utf8");

    const modBefore = await fileModTime(file);
    const result = await validateEventStream(cpbRoot, project, jobId, { dryRun: true });
    assert.equal(result.valid, true);
    assert.equal(result.wouldRepair, true);
    assert.equal(result.repaired, false);
    assert.equal(result.events.length, 1);

    // File must NOT be modified
    const contentAfter = await readFile(file, "utf8");
    assert.equal(contentAfter, originalContent);
    const modAfter = await fileModTime(file);
    assert.equal(modBefore, modAfter);
  });
});

describe("reconcileJobs - dry-run event stream safety", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("does not repair truncated JSONL when dryRun is true", async () => {
    const project = "recdryrun";
    const job = await createJob(cpbRoot, { project, task: "dry-run reconcile" });
    const eventFile = path.join(cpbRoot, "cpb-task", "events", project, `${job.jobId}.jsonl`);

    // Append a truncated line
    await appendEvent(cpbRoot, project, job.jobId, {
      type: "phase_activity", jobId: job.jobId, project, message: "activity", ts: new Date().toISOString(),
    });
    const raw = await readFile(eventFile, "utf8");
    await writeFile(eventFile, raw + '{"type":"phase_started","incom', "utf8");

    const modBefore = await fileModTime(eventFile);
    const report = await reconcileJobs(cpbRoot, { dryRun: true });

    // Should report a would-repair but not actually modify
    assert.ok(report.streamRepairs.length >= 1);
    assert.ok(report.streamRepairs[0].wouldRepair);
    assert.equal(report.indexRebuilt, false);

    // File must be unchanged
    const modAfter = await fileModTime(eventFile);
    assert.equal(modBefore, modAfter);
  });

  it("does not rebuild index when stream errors exist", async () => {
    const project = "streamerr";
    const job = await createJob(cpbRoot, { project, task: "stream error test" });
    await completeJob(cpbRoot, project, job.jobId);

    // Build a valid index first
    await rebuildJobsIndex(cpbRoot);
    const indexBefore = await readJobsIndex(cpbRoot);
    assert.ok(indexBefore);

    // Now corrupt the event stream with a malformed middle line
    const eventFile = path.join(cpbRoot, "cpb-task", "events", project, `${job.jobId}.jsonl`);
    const validEvent = JSON.stringify({ type: "job_created", jobId: job.jobId, project, task: "test", ts: new Date().toISOString() });
    const validEvent2 = JSON.stringify({ type: "phase_started", jobId: job.jobId, project, phase: "plan", ts: new Date().toISOString() });
    await mkdir(path.dirname(eventFile), { recursive: true });
    await writeFile(eventFile, validEvent + "\nTHIS_IS_NOT_JSON\n" + validEvent2 + "\n", "utf8");

    const report = await reconcileJobs(cpbRoot, { dryRun: false });
    assert.ok(report.streamErrors.length >= 1);
    assert.equal(report.indexRebuilt, false);

    // Index should not have been rebuilt (same _meta timestamp)
    const indexAfter = await readJobsIndex(cpbRoot);
    assert.equal(indexBefore._meta.updatedAt, indexAfter._meta.updatedAt);
  });
});

describe("cleanupDryRun - jobId matching", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("reports lease for removal when its jobId matches a terminal job", async () => {
    const project = "jobidmatch";
    const job = await createJob(cpbRoot, { project, task: "jobId match test" });
    await failJob(cpbRoot, project, job.jobId, { reason: "test failure" });

    // Create a lease file whose filename is NOT the job's leaseId,
    // but whose JSON payload has the terminal job's jobId
    const orphanLeaseId = "lease-orphan-by-jobid-001";
    const leasesDir = path.join(cpbRoot, "cpb-task", "leases");
    await mkdir(leasesDir, { recursive: true });
    await writeFile(
      path.join(leasesDir, `${orphanLeaseId}.json`),
      JSON.stringify({
        leaseId: orphanLeaseId,
        jobId: job.jobId,
        phase: "plan",
        acquiredAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }) + "\n",
      "utf8"
    );

    const report = await cleanupDryRun(cpbRoot);
    assert.ok(report.leasesToRemove.includes(orphanLeaseId),
      `cleanupDryRun should report lease ${orphanLeaseId} for removal because its jobId matches terminal job ${job.jobId}`);
  });

  it("cleanupDryRun is mutation-free", async () => {
    const project = "mutationfree";
    const job = await createJob(cpbRoot, { project, task: "mutation test" });
    const leaseId = `lease-${job.jobId}-plan`;
    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 600_000,
    });
    await completeJob(cpbRoot, project, job.jobId);

    const leasesDir = path.join(cpbRoot, "cpb-task", "leases");
    const leaseFile = path.join(leasesDir, `${leaseId}.json`);
    const modBefore = await fileModTime(leaseFile);

    await cleanupDryRun(cpbRoot);

    // Lease file must still exist and be unchanged
    await assert.doesNotReject(() => stat(leaseFile));
    const modAfter = await fileModTime(leaseFile);
    assert.equal(modBefore, modAfter);
  });
});

describe("reconcileJobs - stale workers", () => {
  let cpbRoot;
  let originalHubRoot;
  before(async () => {
    cpbRoot = await makeCpbRoot();
    originalHubRoot = process.env.CPB_HUB_ROOT;
    // Point hub root into our temp dir
    const hubDir = path.join(cpbRoot, ".cpb", "hub");
    await mkdir(hubDir, { recursive: true });
    process.env.CPB_HUB_ROOT = hubDir;

    // Write registry with a stale worker (dead PID, old lastSeenAt)
    // Registry uses projects as object keyed by id, matching normalizeRegistry output
    const registry = {
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        "stale-worker-project": {
          id: "stale-worker-project",
          sourcePath: "/tmp/fake-project",
          enabled: true,
          worker: {
            workerId: "cli-999999999",
            pid: 999999999,
            status: "online",
            lastSeenAt: new Date(Date.now() - 600_000).toISOString(),
          },
        },
      },
    };
    await writeFile(path.join(hubDir, "projects.json"), JSON.stringify(registry) + "\n", "utf8");
  });
  after(async () => {
    if (originalHubRoot !== undefined) process.env.CPB_HUB_ROOT = originalHubRoot;
    else delete process.env.CPB_HUB_ROOT;
    if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true });
  });

  it("detects stale worker with dead PID and old heartbeat", async () => {
    const report = await reconcileJobs(cpbRoot, { dryRun: true });
    assert.ok(report.workers.stale.length >= 1);
    const found = report.workers.stale.find((w) => w.project === "stale-worker-project");
    assert.ok(found, "stale worker should be detected");
    assert.equal(found.pid, 999999999);
  });

  it("dry-run does not modify registry", async () => {
    const hubDir = process.env.CPB_HUB_ROOT;
    const regFile = path.join(hubDir, "projects.json");
    const modBefore = await fileModTime(regFile);

    await reconcileJobs(cpbRoot, { dryRun: true });

    const modAfter = await fileModTime(regFile);
    assert.equal(modBefore, modAfter, "registry should not be modified in dry-run");
  });
});

describe("job-runner - signal handling", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("records interrupted evidence on SIGINT", async () => {
    const project = "sigtest";
    const job = await createJob(cpbRoot, { project, task: "signal test" });
    const eventFile = path.join(cpbRoot, "cpb-task", "events", project, `${job.jobId}.jsonl`);

    // Long-running script that just waits
    const waitScript = "setTimeout(function(){},10000)";

    const bridgePath = path.resolve(
      path.join(import.meta.dirname, "..", "bridges", "job-runner.mjs")
    );

    const child = spawn(process.execPath, [
      bridgePath,
      "--cpb-root", cpbRoot,
      "--project", project,
      "--job-id", job.jobId,
      "--phase", "execute",
      "--script", process.execPath,
      "--", "-e", waitScript,
    ], {
      cwd: cpbRoot,
      env: { ...process.env, CPB_ROOT: cpbRoot, CPB_HUB_ROOT: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait for an observable startup marker before sending SIGINT,
    // so the signal arrives after the handler is installed.
    const waitForPhaseStarted = async () => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        try {
          const raw = await readFile(eventFile, "utf8");
          if (raw.includes("phase_started")) return;
        } catch { /* not created yet */ }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("timed out waiting for phase_started event");
    };
    await waitForPhaseStarted();
    child.kill("SIGINT");

    const exitCode = await new Promise((resolve) => {
      child.on("close", (code, signal) => resolve(code));
    });

    // Exit code 130 = 128 + SIGINT(2)
    assert.ok(
      exitCode === 130 || exitCode === 1,
      `expected exit 130 or 1 (signal race), got ${exitCode}`
    );

    // Check event stream for interrupted evidence
    const events = await readFile(eventFile, "utf8");
    assert.match(events, /interrupted by SIGINT/, `event stream should contain SIGINT evidence. Got: ${events}`);
  });
});

// --- Issue #71: Vanished process reconciliation ---

describe("reconcileJobs - vanished planner process", () => {
  let cpbRoot;
  let origHubRoot;

  before(async () => {
    cpbRoot = await makeCpbRoot();
    origHubRoot = process.env.CPB_HUB_ROOT;
    const hubDir = path.join(cpbRoot, ".cpb", "hub");
    await mkdir(hubDir, { recursive: true });
    process.env.CPB_HUB_ROOT = hubDir;
  });
  after(async () => {
    if (origHubRoot !== undefined) process.env.CPB_HUB_ROOT = origHubRoot;
    else delete process.env.CPB_HUB_ROOT;
    if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true });
  });

  it("emits durable job_failed when planner process PID is dead", async () => {
    const project = "vanish-plan";
    const task = "vanished planner test";
    const job = await createJob(cpbRoot, { project, task });
    const leaseId = `lease-${job.jobId}-plan`;

    await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId });
    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 600_000,
      ownerPid: 999999999,
    });
    await registerProcess(cpbRoot, {
      jobId: job.jobId,
      project,
      phase: "plan",
      runnerPid: 999999999,
      leaseId,
    });

    const hubDir = process.env.CPB_HUB_ROOT;
    const qEntry = await enqueue(hubDir, {
      projectId: project,
      description: task,
      metadata: { jobId: job.jobId },
    });
    await updateEntry(hubDir, qEntry.id, { status: "in_progress" });

    const report = await reconcileJobs(cpbRoot, { dryRun: false });

    const found = report.staleJobs.find((j) => j.jobId === job.jobId);
    assert.ok(found, "should detect vanished planner process");
    assert.equal(found.failureReason, "stale_pid_disappeared");
    assert.match(found.failureArtifact, /^process:.*:phase:plan$/);

    const { listJobs } = await import("../server/services/job-store.js");
    const jobs = await listJobs(cpbRoot);
    const reconciled = jobs.find((j) => j.jobId === job.jobId);
    assert.equal(reconciled.status, "failed");
    assert.ok(reconciled.failureCause);
    assert.equal(reconciled.failureCause.kind, "stale_runtime_reconciled");
    assert.equal(reconciled.failureCause.failureReason, "stale_pid_disappeared");
    assert.equal(reconciled.failureCause.phase, "plan");
    assert.equal(reconciled.leaseId, null);

    // Queue entry marked failed with metadata
    assert.ok(report.reconciledQueueEntries.length >= 1, "should have reconciled queue entry");
    const qRec = report.reconciledQueueEntries.find((r) => r.jobId === job.jobId);
    assert.ok(qRec, "should have queue reconciliation record");

    const hubRoot = process.env.CPB_HUB_ROOT;
    const qAfter = await listQueue(hubRoot);
    const failedEntry = qAfter.find((e) => e.id === qEntry.id);
    assert.equal(failedEntry.status, "failed");
    assert.equal(failedEntry.metadata.failureCode, "FATAL");
    assert.equal(failedEntry.metadata.failureReason, "stale_pid_disappeared");
    assert.equal(failedEntry.metadata.reconciledJobId, job.jobId);
    assert.ok(failedEntry.metadata.failureCause);
    assert.equal(failedEntry.metadata.failureCause.kind, "stale_runtime_reconciled");

    // Process record removed
    assert.ok(report.reconciledProcesses.length >= 1, "should have reconciled process");
    const procAfter = await getProcess(cpbRoot, job.jobId);
    assert.equal(procAfter, null, "process record should be removed");

    // Lease cleaned
    const leaseAfter = await readLease(cpbRoot, leaseId);
    assert.equal(leaseAfter, null, "lease should be cleaned");
  });
});

describe("reconcileJobs - vanished executor and verifier processes", () => {
  const phases = ["plan", "execute", "verify"];

  let cpbRoot;
  let origHubRoot;

  before(async () => {
    cpbRoot = await makeCpbRoot();
    origHubRoot = process.env.CPB_HUB_ROOT;
    const hubDir = path.join(cpbRoot, ".cpb", "hub");
    await mkdir(hubDir, { recursive: true });
    process.env.CPB_HUB_ROOT = hubDir;
  });
  after(async () => {
    if (origHubRoot !== undefined) process.env.CPB_HUB_ROOT = origHubRoot;
    else delete process.env.CPB_HUB_ROOT;
    if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true });
  });

  for (const phase of phases) {
    it(`detects vanished ${phase} process and emits job_failed with phase=${phase}`, async () => {
      const project = `vanish-${phase}`;
      const task = `vanished ${phase} test`;
      const job = await createJob(cpbRoot, { project, task });
      const leaseId = `lease-${job.jobId}-${phase}`;

      await startPhase(cpbRoot, project, job.jobId, { phase, leaseId });
      await acquireLease(cpbRoot, {
        leaseId,
        jobId: job.jobId,
        phase,
        ttlMs: 600_000,
        ownerPid: 999999999,
      });
      await registerProcess(cpbRoot, {
        jobId: job.jobId,
        project,
        phase,
        runnerPid: 999999999,
        leaseId,
      });

      const report = await reconcileJobs(cpbRoot, { dryRun: false });

      const found = report.staleJobs.find((j) => j.jobId === job.jobId);
      assert.ok(found, `should detect vanished ${phase} process`);
      assert.equal(found.failureReason, "stale_pid_disappeared");
      assert.match(found.failureArtifact, new RegExp(`^process:.*:phase:${phase}$`));

      const { listJobs } = await import("../server/services/job-store.js");
      const jobs = await listJobs(cpbRoot);
      const reconciled = jobs.find((j) => j.jobId === job.jobId);
      assert.equal(reconciled.status, "failed");
      assert.equal(reconciled.failureCause.phase, phase);
    });
  }
});

describe("reconcileJobs - live process not reconciled", () => {
  let cpbRoot;
  let origHubRoot;

  before(async () => {
    cpbRoot = await makeCpbRoot();
    origHubRoot = process.env.CPB_HUB_ROOT;
    const hubDir = path.join(cpbRoot, ".cpb", "hub");
    await mkdir(hubDir, { recursive: true });
    process.env.CPB_HUB_ROOT = hubDir;
  });
  after(async () => {
    if (origHubRoot !== undefined) process.env.CPB_HUB_ROOT = origHubRoot;
    else delete process.env.CPB_HUB_ROOT;
    if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true });
  });

  it("does NOT fail a job whose process runner PID is still alive", async () => {
    const project = "alive-proc";
    const task = "live process test";
    const job = await createJob(cpbRoot, { project, task });
    const leaseId = `lease-${job.jobId}-plan`;

    await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId });
    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 600_000,
      ownerPid: process.pid,
    });
    await registerProcess(cpbRoot, {
      jobId: job.jobId,
      project,
      phase: "plan",
      runnerPid: process.pid,
      leaseId,
    });

    const report = await reconcileJobs(cpbRoot, { dryRun: false });

    const found = report.staleJobs.find((j) => j.jobId === job.jobId);
    assert.equal(found, undefined, "live process job should NOT be stale");

    const { listJobs } = await import("../server/services/job-store.js");
    const jobs = await listJobs(cpbRoot);
    const after = jobs.find((j) => j.jobId === job.jobId);
    assert.equal(after.status, "running");
    assert.equal(after.failureCause, null);

    const procAfter = await getProcess(cpbRoot, job.jobId);
    assert.ok(procAfter, "process record should still exist");
  });
});

describe("reconcileJobs - vanished process dry-run safety", () => {
  let cpbRoot;
  let origHubRoot;

  before(async () => {
    cpbRoot = await makeCpbRoot();
    origHubRoot = process.env.CPB_HUB_ROOT;
    const hubDir = path.join(cpbRoot, ".cpb", "hub");
    await mkdir(hubDir, { recursive: true });
    process.env.CPB_HUB_ROOT = hubDir;
  });
  after(async () => {
    if (origHubRoot !== undefined) process.env.CPB_HUB_ROOT = origHubRoot;
    else delete process.env.CPB_HUB_ROOT;
    if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true });
  });

  it("dry-run reports stale job but does not mutate events, queue, process, or lease", async () => {
    const project = "dryrun-vanish";
    const task = "dry-run vanish test";
    const job = await createJob(cpbRoot, { project, task });
    const leaseId = `lease-${job.jobId}-plan`;

    await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId });
    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 600_000,
      ownerPid: 999999999,
    });
    await registerProcess(cpbRoot, {
      jobId: job.jobId,
      project,
      phase: "plan",
      runnerPid: 999999999,
      leaseId,
    });

    const hubDir = process.env.CPB_HUB_ROOT;
    const qEntry = await enqueue(hubDir, {
      projectId: project,
      description: task,
      metadata: { jobId: job.jobId },
    });
    await updateEntry(hubDir, qEntry.id, { status: "in_progress" });

    const report = await reconcileJobs(cpbRoot, { dryRun: true });

    const found = report.staleJobs.find((j) => j.jobId === job.jobId);
    assert.ok(found, "dry-run should report stale job");
    assert.equal(found.failureReason, "stale_pid_disappeared");

    // Job should still be running
    const { listJobs } = await import("../server/services/job-store.js");
    const jobs = await listJobs(cpbRoot);
    const after = jobs.find((j) => j.jobId === job.jobId);
    assert.equal(after.status, "running", "dry-run should not change job status");

    // Process record should still exist
    const procAfter = await getProcess(cpbRoot, job.jobId);
    assert.ok(procAfter, "dry-run should not remove process record");

    // Lease should still exist
    const leaseAfter = await readLease(cpbRoot, leaseId);
    assert.ok(leaseAfter, "dry-run should not remove lease");

    // Queue entry should still be in_progress
    const hubRoot = process.env.CPB_HUB_ROOT;
    const qAfter = await listQueue(hubRoot);
    const qCheck = qAfter.find((e) => e.id === qEntry.id);
    assert.equal(qCheck.status, "in_progress", "dry-run should not change queue status");
    assert.equal(qCheck.metadata.failureCode, undefined, "dry-run should not add failure metadata");

    // Dry-run should report intended actions
    assert.ok(report.reconciledQueueEntries.length >= 1, "dry-run should report would-be queue reconciliation");
    const qWouldRec = report.reconciledQueueEntries.find((r) => r.jobId === job.jobId);
    assert.ok(qWouldRec, "dry-run should report would-be queue entry for this job");
    assert.equal(qWouldRec.wouldReconcile, true);
    assert.equal(qWouldRec.queueEntryId, qEntry.id);

    assert.ok(report.reconciledProcesses.length >= 1, "dry-run should report would-be process cleanup");
    const procWouldRec = report.reconciledProcesses.find((r) => r.jobId === job.jobId);
    assert.ok(procWouldRec, "dry-run should report would-be process removal");
    assert.equal(procWouldRec.wouldRemove, true);

    const leaseWouldClean = report.orphanLeases.find((l) => l.leaseId === leaseId);
    assert.ok(leaseWouldClean, "dry-run should report would-be lease cleanup for process-orphan case");
  });
});

describe("reconcileJobs - vanished process idempotency", () => {
  let cpbRoot;
  let origHubRoot;

  before(async () => {
    cpbRoot = await makeCpbRoot();
    origHubRoot = process.env.CPB_HUB_ROOT;
    const hubDir = path.join(cpbRoot, ".cpb", "hub");
    await mkdir(hubDir, { recursive: true });
    process.env.CPB_HUB_ROOT = hubDir;
  });
  after(async () => {
    if (origHubRoot !== undefined) process.env.CPB_HUB_ROOT = origHubRoot;
    else delete process.env.CPB_HUB_ROOT;
    if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true });
  });

  it("reconciling twice does not emit duplicate job_failed events", async () => {
    const project = "idem-vanish";
    const task = "idempotent vanish test";
    const job = await createJob(cpbRoot, { project, task });
    const leaseId = `lease-${job.jobId}-plan`;

    await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId });
    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 600_000,
      ownerPid: 999999999,
    });
    await registerProcess(cpbRoot, {
      jobId: job.jobId,
      project,
      phase: "plan",
      runnerPid: 999999999,
      leaseId,
    });

    await reconcileJobs(cpbRoot, { dryRun: false });

    // Second run: job is now terminal, should not be detected again
    const report2 = await reconcileJobs(cpbRoot, { dryRun: false });
    const foundAgain = report2.staleJobs.find((j) => j.jobId === job.jobId);
    assert.equal(foundAgain, undefined, "terminal job should not appear in second reconcile");

    const { listJobs } = await import("../server/services/job-store.js");
    const jobs = await listJobs(cpbRoot);
    const after = jobs.find((j) => j.jobId === job.jobId);
    assert.equal(after.status, "failed");
    assert.equal(after.failureCause.kind, "stale_runtime_reconciled");
  });
});

describe("reconcileJobs - queue entry matching strategies", () => {
  let cpbRoot;
  let origHubRoot;

  before(async () => {
    cpbRoot = await makeCpbRoot();
    origHubRoot = process.env.CPB_HUB_ROOT;
    const hubDir = path.join(cpbRoot, ".cpb", "hub");
    await mkdir(hubDir, { recursive: true });
    process.env.CPB_HUB_ROOT = hubDir;
  });
  after(async () => {
    if (origHubRoot !== undefined) process.env.CPB_HUB_ROOT = origHubRoot;
    else delete process.env.CPB_HUB_ROOT;
    if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true });
  });

  it("matches queue entry by metadata.originJobId when metadata.jobId is absent", async () => {
    const project = "q-origin-match";
    const task = "origin job match test";
    const job = await createJob(cpbRoot, { project, task });
    const leaseId = `lease-${job.jobId}-plan`;

    await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId });
    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 600_000,
      ownerPid: 999999999,
    });
    await registerProcess(cpbRoot, {
      jobId: job.jobId,
      project,
      phase: "plan",
      runnerPid: 999999999,
      leaseId,
    });

    const hubDir = process.env.CPB_HUB_ROOT;
    const qEntry = await enqueue(hubDir, {
      projectId: project,
      description: task,
      metadata: { originJobId: job.jobId },
    });
    await updateEntry(hubDir, qEntry.id, { status: "in_progress" });

    const report = await reconcileJobs(cpbRoot, { dryRun: false });
    assert.ok(report.reconciledQueueEntries.length >= 1);

    const hubRoot = process.env.CPB_HUB_ROOT;
    const qAfter = await listQueue(hubRoot);
    const failedEntry = qAfter.find((e) => e.id === qEntry.id);
    assert.equal(failedEntry.status, "failed");
    assert.equal(failedEntry.metadata.reconciledJobId, job.jobId);
  });

  it("matches queue entry by projectId + description when unique", async () => {
    const project = "q-task-match";
    const task = "task desc match test";
    const job = await createJob(cpbRoot, { project, task });
    const leaseId = `lease-${job.jobId}-plan`;

    await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId });
    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 600_000,
      ownerPid: 999999999,
    });
    await registerProcess(cpbRoot, {
      jobId: job.jobId,
      project,
      phase: "plan",
      runnerPid: 999999999,
      leaseId,
    });

    const hubDir = process.env.CPB_HUB_ROOT;
    // No jobId or originJobId in metadata — falls back to projectId + description match
    const qEntry = await enqueue(hubDir, {
      projectId: project,
      description: task,
      metadata: {},
    });
    await updateEntry(hubDir, qEntry.id, { status: "in_progress" });

    const report = await reconcileJobs(cpbRoot, { dryRun: false });
    assert.ok(report.reconciledQueueEntries.length >= 1);

    const hubRoot = process.env.CPB_HUB_ROOT;
    const qAfter = await listQueue(hubRoot);
    const failedEntry = qAfter.find((e) => e.id === qEntry.id);
    assert.equal(failedEntry.status, "failed");
  });

  it("does NOT match queue entry when multiple in-progress entries share same description", async () => {
    const project = "q-ambiguous";
    const task = "ambiguous task test";
    const job = await createJob(cpbRoot, { project, task });
    const leaseId = `lease-${job.jobId}-plan`;

    await startPhase(cpbRoot, project, job.jobId, { phase: "plan", leaseId });
    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 600_000,
      ownerPid: 999999999,
    });
    await registerProcess(cpbRoot, {
      jobId: job.jobId,
      project,
      phase: "plan",
      runnerPid: 999999999,
      leaseId,
    });

    const hubDir = process.env.CPB_HUB_ROOT;
    const q1 = await enqueue(hubDir, {
      projectId: project,
      description: task,
      metadata: {},
    });
    await updateEntry(hubDir, q1.id, { status: "in_progress" });
    const q2 = await enqueue(hubDir, {
      projectId: project,
      description: task,
      metadata: {},
    });
    await updateEntry(hubDir, q2.id, { status: "in_progress" });

    const report = await reconcileJobs(cpbRoot, { dryRun: false });

    // Job should still be failed
    const found = report.staleJobs.find((j) => j.jobId === job.jobId);
    assert.ok(found, "should still detect vanished process");

    // But no queue entry should be reconciled (ambiguous match)
    const qRec = report.reconciledQueueEntries.find((r) => r.jobId === job.jobId);
    assert.equal(qRec, undefined, "should not match ambiguous queue entries");

    // Queue entries should remain in_progress
    const hubRoot = process.env.CPB_HUB_ROOT;
    const qAfter = await listQueue(hubRoot);
    const q1After = qAfter.find((e) => e.id === q1.id);
    const q2After = qAfter.find((e) => e.id === q2.id);
    assert.equal(q1After.status, "in_progress");
    assert.equal(q2After.status, "in_progress");
  });
});
