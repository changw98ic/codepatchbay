// @ts-nocheck
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile, rm, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  validateEventStream,
  reconcileJobs,
  cleanupDryRun,
  cleanupJobs,
} from "../../server/services/reconcile.js";
import { appendEvent } from "../../server/services/event-store.js";
import { createJob, failJob, completeJob } from "../../server/services/job-store.js";
import { acquireLease } from "../../server/services/lease-manager.js";
import { rebuildJobsIndex, readJobsIndex } from "../../server/services/jobs-index.js";
import { resolveHubRoot } from "../../server/services/hub-registry.js";

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
    const { listJobs } = await import("../../server/services/job-store.js");
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

    const { readLease } = await import("../../server/services/lease-manager.js");
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

    // Long-running executable that ignores the phase argument job-runner prepends.
    const waitScriptPath = path.join(cpbRoot, "wait-script.js");
    await writeFile(waitScriptPath, "#!/usr/bin/env node\nsetTimeout(function(){}, 10000);\n", "utf8");
    await chmod(waitScriptPath, 0o755);

    const bridgePath = path.resolve(
      path.join(import.meta.dirname, "..", "..", "bridges", "job-runner.js")
    );

    const child = spawn(process.execPath, [
      bridgePath,
      "--cpb-root", cpbRoot,
      "--project", project,
      "--job-id", job.jobId,
      "--phase", "execute",
      "--script", waitScriptPath,
      "--",
    ], {
      cwd: cpbRoot,
      env: { ...process.env, CPB_ROOT: cpbRoot, CPB_HUB_ROOT: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Register close listener immediately before awaits that might throw.
    const closePromise = new Promise((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    try {
      // Wait for phase_started event with generous timeout for slow CI
      const deadline = Date.now() + 15_000;
      let started = false;
      while (Date.now() < deadline) {
        try {
          const raw = await readFile(eventFile, "utf8");
          if (raw.includes("phase_started")) { started = true; break; }
        } catch { /* not created yet */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(started, "timed out waiting for phase_started event");

      child.kill("SIGINT");

      let timeout = null;
      const exitCode = await Promise.race([
        closePromise,
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            child.kill("SIGKILL");
            resolve(null);
          }, 5_000);
        }),
      ]);
      clearTimeout(timeout);

      // Exit code 130 = 128 + SIGINT(2), null = SIGKILL fallback on slow CI
      assert.ok(
        exitCode === 130 || exitCode === 1 || exitCode === null,
        `expected exit 130 or 1 (signal race), got ${exitCode}`
      );

      // Check event stream for interrupted evidence
      const events = await readFile(eventFile, "utf8");
      assert.match(events, /interrupted by SIGINT/, `event stream should contain SIGINT evidence. Got: ${events}`);
    } finally {
      // Always ensure child is dead and reaped
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      await closePromise.catch(() => {});
    }
  });
});
