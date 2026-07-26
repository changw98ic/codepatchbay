import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile, rm, readFile, rename, stat, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  validateEventStream,
  reconcileJobs,
  recoverOrphanedJobs,
  cleanupDryRun,
  cleanupJobs,
  cleanupPollution,
  withCleanupTestHooksForTests,
} from "../../server/services/cleanup/cleanup.js";
import { appendEvent } from "../../server/services/event/event-store.js";
import { createJob, failJob, completeJob } from "../../server/services/job/job-store.js";
import { acquireLease } from "../../server/services/infra.js";
import { rebuildJobsIndex, readJobsIndex } from "../../server/services/job/job-store.js";
import { registerProject } from "../../server/services/hub/hub-registry.js";
import { captureProcessIdentity } from "../../core/runtime/process-tree.js";

function mkdtemp(prefix) {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return mkdir(dir, { recursive: true }).then(() => dir);
}

async function makeCpbRoot() {
  const dir = await mkdtemp("cpb-rec-");
  return dir;
}

async function setupProjectRuntime(cpbRoot, project) {
  const hubRoot = path.join(cpbRoot, ".cpb", "hub");
  const sourcePath = path.join(cpbRoot, "sources", project);
  await mkdir(sourcePath, { recursive: true });
  const registered = await registerProject(hubRoot, {
    id: project,
    name: project,
    sourcePath,
    cpbRoot,
    skipCodeGraphGate: true,
  });
  return { hubRoot, dataRoot: registered.projectRuntimeRoot };
}

async function assertSourceCpbTaskAbsent(cpbRoot) {
  await assert.rejects(() => stat(path.join(cpbRoot, "cpb-task")), { code: "ENOENT" });
}

async function writeJsonl(filePath, lines) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, lines.join("\n") + "\n", "utf8");
}

async function fileModTime(filePath) {
  const s = await stat(filePath);
  return s.mtimeMs;
}

async function shortLivedOwner() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const close = new Promise((resolve) => child.once("close", resolve));
  const closeOwner = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1000);
    killTimer.unref?.();
    try {
      await close;
    } finally {
      clearTimeout(killTimer);
    }
  };
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    assert.ok(child.pid, "fixture child should have a pid");
    const processIdentity = captureProcessIdentity(child.pid, { strict: true });
    assert.ok(processIdentity, "fixture child should expose a process identity");
    return { pid: child.pid, processIdentity, close: closeOwner };
  } catch (error) {
    await closeOwner();
    throw error;
  }
}

describe("validateEventStream", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("returns valid for a clean JSONL file", async () => {
    const project = "testproj";
    const { dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const jobId = "job-test-clean";
    const file = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
    await writeJsonl(file, [
      JSON.stringify({ type: "job_created", jobId, project, task: "test", ts: new Date().toISOString() }),
    ]);
    const result = await validateEventStream(cpbRoot, project, jobId, { dataRoot });
    assert.equal(result.valid, true);
    assert.equal(result.events.length, 1);
    assert.equal(result.repaired, false);
    await assertSourceCpbTaskAbsent(cpbRoot);
  });

  it("repairs a truncated final line", async () => {
    const project = "testproj";
    const { dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const jobId = "job-test-trunc";
    const file = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
    const validEvent = JSON.stringify({ type: "job_created", jobId, project, task: "test", ts: new Date().toISOString() });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, validEvent + "\n" + '{"type":"phase_started","incom', "utf8");

    const result = await validateEventStream(cpbRoot, project, jobId, { dataRoot });
    assert.equal(result.valid, true);
    assert.equal(result.repaired, true);
    assert.equal(result.events.length, 1);

    const repaired = await readFile(file, "utf8");
    assert.ok(repaired.endsWith("\n"));
    assert.equal(repaired.trim().split("\n").length, 1);
    await assertSourceCpbTaskAbsent(cpbRoot);
  });

  it("fails on malformed middle line without rewriting", async () => {
    const project = "testproj";
    const { dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const jobId = "job-test-midbad";
    const file = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
    const validEvent = JSON.stringify({ type: "job_created", jobId, project, task: "test", ts: new Date().toISOString() });
    const validEvent2 = JSON.stringify({ type: "phase_started", jobId, project, phase: "plan", ts: new Date().toISOString() });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, validEvent + "\nTHIS_IS_NOT_JSON\n" + validEvent2 + "\n", "utf8");

    const modBefore = await fileModTime(file);
    const result = await validateEventStream(cpbRoot, project, jobId, { dataRoot });
    assert.equal(result.valid, false);
    assert.equal(result.repaired, false);
    assert.ok(result.error);
    assert.equal(result.error.lineNumber, 2);
    assert.match(result.error.reason, /malformed/);

    const modAfter = await fileModTime(file);
    assert.equal(modBefore, modAfter);
    await assertSourceCpbTaskAbsent(cpbRoot);
  });

  it("returns valid for missing file", async () => {
    const project = "testproj";
    const { dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const result = await validateEventStream(cpbRoot, project, "job-noexist", { dataRoot });
    assert.equal(result.valid, true);
    assert.equal(result.events.length, 0);
    await assertSourceCpbTaskAbsent(cpbRoot);
  });

  it("requires dataRoot unless legacy fallback is explicit", async () => {
    await assert.rejects(
      () => validateEventStream(cpbRoot, "testproj", "job-noexist"),
      /dataRoot is required/
    );

    const project = "legacytest";
    const jobId = "job-legacy-clean";
    const file = path.join(cpbRoot, "cpb-task", "events", project, `${jobId}.jsonl`);
    await writeJsonl(file, [
      JSON.stringify({ type: "job_created", jobId, project, task: "legacy", ts: new Date().toISOString() }),
    ]);

    const result = await validateEventStream(cpbRoot, project, jobId, { legacyOnly: true });
    assert.equal(result.valid, true);
    assert.equal(result.events.length, 1);
  });
});

describe("reconcileJobs - stale jobs", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("detects stale running job with expired lease and dead owner", async () => {
    const project = "rectest";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const job = await createJob(cpbRoot, { project, task: "stale test", dataRoot });
    const leaseId = `lease-${job.jobId}-plan`;
    const owner = await shortLivedOwner();

    try {
      await acquireLease(cpbRoot, {
        leaseId,
        jobId: job.jobId,
        phase: "plan",
        ttlMs: 1,
        ownerPid: owner.pid,
        dataRoot,
      });
      await appendEvent(cpbRoot, project, job.jobId, {
        type: "phase_started",
        jobId: job.jobId,
        project,
        phase: "plan",
        leaseId,
        ts: new Date().toISOString(),
      }, { dataRoot });
      await rebuildJobsIndex(cpbRoot, { dataRoot, includeLegacyFallback: false });
    } finally {
      await owner.close();
    }
    await new Promise((r) => setTimeout(r, 10));

    const report = await reconcileJobs(cpbRoot, { dryRun: true, hubRoot });
    assert.ok(report.staleJobs.length >= 1);
    const found = report.staleJobs.find((j) => j.jobId === job.jobId);
    assert.ok(found, "stale job should be detected");
    assert.match(found.reason, /owner process dead|no lease|expired/);

    // Dry-run: job should still be running
    const { listJobs } = await import("../../server/services/job/job-store.js");
    const jobs = await listJobs(cpbRoot, { dataRoot, includeLegacyFallback: false });
    const afterDryRun = jobs.find((j) => j.jobId === job.jobId);
    assert.equal(afterDryRun.status, "running");

    // Now do actual reconcile
    const report2 = await reconcileJobs(cpbRoot, { dryRun: false, hubRoot });
    const found2 = report2.staleJobs.find((j) => j.jobId === job.jobId);
    assert.ok(found2, "stale job should be reconciled");

    const jobs2 = await listJobs(cpbRoot, { dataRoot, includeLegacyFallback: false });
    const afterReconcile = jobs2.find((j) => j.jobId === job.jobId);
    assert.equal(afterReconcile.status, "failed");
    assert.match(afterReconcile.blockedReason, /stale_runtime_reconciled/);
    await assertSourceCpbTaskAbsent(cpbRoot);
  });

  it("is idempotent: running twice does not duplicate events", async () => {
    const project = "idemtest";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const job = await createJob(cpbRoot, { project, task: "idempotent test", dataRoot });
    const leaseId = `lease-${job.jobId}-plan`;
    const owner = await shortLivedOwner();

    try {
      await acquireLease(cpbRoot, {
        leaseId,
        jobId: job.jobId,
        phase: "plan",
        ttlMs: 1,
        ownerPid: owner.pid,
        dataRoot,
      });
      await appendEvent(cpbRoot, project, job.jobId, {
        type: "phase_started",
        jobId: job.jobId,
        project,
        phase: "plan",
        leaseId,
        ts: new Date().toISOString(),
      }, { dataRoot });
      await rebuildJobsIndex(cpbRoot, { dataRoot, includeLegacyFallback: false });
    } finally {
      await owner.close();
    }
    await new Promise((r) => setTimeout(r, 10));

    await reconcileJobs(cpbRoot, { dryRun: false, hubRoot });
    const report2 = await reconcileJobs(cpbRoot, { dryRun: false, hubRoot });
    const foundAgain = report2.staleJobs.find((j) => j.jobId === job.jobId);
    assert.equal(foundAgain, undefined);
    await assertSourceCpbTaskAbsent(cpbRoot);
  });
});

describe("reconcileJobs - orphan leases", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("preserves orphan lease when owner identity is missing", async () => {
    const project = "orphanleasetest";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const leaseId = "lease-orphan-test-001";
    const leasesDir = path.join(dataRoot, "leases");
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

    const report = await reconcileJobs(cpbRoot, { dryRun: true, hubRoot });
    assert.equal(report.orphanLeases.find((l) => l.leaseId === leaseId), undefined);
    const unverified = report.unverifiedJobs.find((entry) => entry.leaseId === leaseId);
    assert.ok(unverified, "orphan lease without owner identity should be reported as unverified");
    assert.equal(unverified.reason, "orphan_lease_owner_unverified");

    // Dry-run: lease file should still exist
    await assert.doesNotReject(() => stat(path.join(leasesDir, `${leaseId}.json`)));

    await reconcileJobs(cpbRoot, { dryRun: false, hubRoot });
    await assert.doesNotReject(() => stat(path.join(leasesDir, `${leaseId}.json`)));
    await assertSourceCpbTaskAbsent(cpbRoot);
  });

  it("releases orphan lease only when the expired owner incarnation is dead", async () => {
    const project = "orphanleaseproof";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const leaseId = "lease-orphan-proof-001";
    const owner = await shortLivedOwner();
    try {
      await acquireLease(cpbRoot, {
        leaseId,
        jobId: "job-nonexistent-proof",
        phase: "plan",
        ttlMs: 1,
        ownerPid: owner.pid,
        dataRoot,
      });
    } finally {
      await owner.close();
    }
    await new Promise((r) => setTimeout(r, 10));

    const report = await reconcileJobs(cpbRoot, { dryRun: true, hubRoot });
    const found = report.orphanLeases.find((l) => l.leaseId === leaseId);
    assert.ok(found, "orphan lease with dead owner identity should be detected");
    assert.equal(found.reason, "job not found and owner dead");

    await reconcileJobs(cpbRoot, { dryRun: false, hubRoot });
    await assert.rejects(() => stat(path.join(dataRoot, "leases", `${leaseId}.json`)));
    await assertSourceCpbTaskAbsent(cpbRoot);
  });
});

describe("cleanupDryRun", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("reports planned cleanup without mutating state", async () => {
    const project = "cleanuptest";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const job = await createJob(cpbRoot, { project, task: "cleanup test", dataRoot });
    await completeJob(cpbRoot, project, job.jobId, { dataRoot });

    const report = await cleanupDryRun(cpbRoot, { hubRoot });
    assert.equal(typeof report.totalJobCount, "number");
    assert.ok(report.totalJobCount >= 1);
    assert.ok(Array.isArray(report.leasesToRemove));
    assert.ok(Array.isArray(report.worktreesPreserved));
    await assertSourceCpbTaskAbsent(cpbRoot);
  });

  it("preserves failed worktrees in report", async () => {
    const project = "worktreepres";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const job = await createJob(cpbRoot, { project, task: "worktree pres test", dataRoot });
    await appendEvent(cpbRoot, project, job.jobId, {
      type: "worktree_created",
      jobId: job.jobId,
      project,
      worktree: "/tmp/cpb-worktree-test-456",
      ts: new Date().toISOString(),
    }, { dataRoot });
    await failJob(cpbRoot, project, job.jobId, { reason: "test failure", dataRoot });

    const report = await cleanupDryRun(cpbRoot, { hubRoot });
    const preserved = report.worktreesPreserved.find((w) => w.jobId === job.jobId);
    assert.ok(preserved, "failed job worktree should be in preserved list");
    assert.equal(preserved.worktree, "/tmp/cpb-worktree-test-456");
    assert.equal(preserved.status, "failed");
    await assertSourceCpbTaskAbsent(cpbRoot);
  });
});

describe("cleanupJobs", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("removes terminal leases but preserves running job leases", async () => {
    const project = "cleanact";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);

    const completedJob = await createJob(cpbRoot, { project, task: "completed", dataRoot });
    const completedLeaseId = `lease-${completedJob.jobId}-plan`;
    await acquireLease(cpbRoot, {
      leaseId: completedLeaseId,
      jobId: completedJob.jobId,
      phase: "plan",
      ttlMs: 600_000,
      dataRoot,
    });
    await completeJob(cpbRoot, project, completedJob.jobId, { dataRoot });

    const runningJob = await createJob(cpbRoot, { project, task: "running", dataRoot });
    const runningLeaseId = `lease-${runningJob.jobId}-plan`;
    await acquireLease(cpbRoot, {
      leaseId: runningLeaseId,
      jobId: runningJob.jobId,
      phase: "plan",
      ttlMs: 600_000,
      dataRoot,
    });

    const result = await cleanupJobs(cpbRoot, { hubRoot });
    assert.ok(result.cleaned >= 1, "should clean at least the completed job's lease");

    const { readLease } = await import("../../server/services/infra.js");
    const runningLease = await readLease(cpbRoot, runningLeaseId, { dataRoot });
    assert.ok(runningLease, "running job's lease should NOT be cleaned");

    const completedLease = await readLease(cpbRoot, completedLeaseId, { dataRoot });
    assert.equal(completedLease, null, "completed job's lease should be cleaned");
    await assertSourceCpbTaskAbsent(cpbRoot);
  });

  it("fails closed and preserves unsafe lock state for terminal lease cleanup", async () => {
    const project = "cleanlockrace";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);

    const completedJob = await createJob(cpbRoot, { project, task: "completed lock race", dataRoot });
    const leaseId = `lease-${completedJob.jobId}-plan`;
    await acquireLease(cpbRoot, {
      leaseId,
      jobId: completedJob.jobId,
      phase: "plan",
      ttlMs: 600_000,
      dataRoot,
    });
    await completeJob(cpbRoot, project, completedJob.jobId, { dataRoot });

    const leaseFile = path.join(dataRoot, "leases", `${leaseId}.json`);
    const lockDir = `${leaseFile}.lock`;
    const successorTarget = path.join(dataRoot, "leases", "successor-lock-target");
    await mkdir(successorTarget, { recursive: true });
    await symlink(successorTarget, lockDir, "dir");

    await cleanupJobs(cpbRoot, { hubRoot });

    await assert.doesNotReject(() => stat(leaseFile));
    await assert.doesNotReject(() => stat(lockDir));
    await rm(lockDir, { recursive: true, force: true });
    await assertSourceCpbTaskAbsent(cpbRoot);
  });
});

describe("cleanupPollution", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  async function writePollutedProject(projectId) {
    const hubRoot = path.join(cpbRoot, ".cpb", "hub");
    const runtimeRoot = path.join(hubRoot, "projects", projectId);
    const sourcePath = path.join(cpbRoot, "sources", projectId);
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(sourcePath, { recursive: true });
    await writeFile(path.join(runtimeRoot, "marker.txt"), "runtime data", "utf8");
    await writeFile(path.join(hubRoot, "projects.json"), JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      projects: {
        [projectId]: {
          id: projectId,
          name: projectId,
          sourcePath,
          projectRuntimeRoot: runtimeRoot,
          enabled: true,
          metadata: { visibility: "test" },
        },
      },
    }) + "\n", "utf8");
    return { hubRoot, runtimeRoot, sourcePath };
  }

  it("quarantines polluted runtime and retains a registry recovery record", async () => {
    const projectId = "polluted-test";
    const { hubRoot, runtimeRoot, sourcePath } = await writePollutedProject(projectId);

    const report = await cleanupPollution(cpbRoot, { hubRoot });

    assert.equal(report.projectsRemoved, 0);
    assert.equal(report.errors.length, 0);
    assert.equal(report.sourcePathsPreserved[0], sourcePath);
    const quarantined = report.quarantinedRuntimeDirs.find((entry) => entry.projectId === projectId);
    assert.ok(quarantined, "quarantine path must be reported");
    const quarantinePath = quarantined.quarantinePath;
    if (typeof quarantinePath !== "string") throw new Error("quarantinePath must be a string");
    await assert.rejects(() => stat(path.join(runtimeRoot, "marker.txt")));
    assert.equal(await readFile(path.join(quarantinePath, "marker.txt"), "utf8"), "runtime data");
    const registry = JSON.parse(await readFile(path.join(hubRoot, "projects.json"), "utf8"));
    assert.equal(registry.projects[projectId].projectRuntimeRoot, runtimeRoot);
    assert.equal(registry.projects[projectId].metadata.visibility, "test");
    assert.equal(registry.projects[projectId].metadata.cleanupRecovery.status, "quarantined");
    assert.equal(registry.projects[projectId].metadata.cleanupRecovery.recoveryPath, quarantinePath);
  });

  it("rejects a symlinked managed projects root before quarantining", async () => {
    if (process.platform === "win32") return;
    const projectId = "polluted-linked-projects";
    const { hubRoot, runtimeRoot } = await writePollutedProject(projectId);
    const projectsRoot = path.join(hubRoot, "projects");
    const displacedProjectsRoot = path.join(hubRoot, "projects-original");
    await rename(projectsRoot, displacedProjectsRoot);
    await symlink(displacedProjectsRoot, projectsRoot, "dir");

    let report;
    try {
      report = await cleanupPollution(cpbRoot, { hubRoot });
    } finally {
      await rm(projectsRoot, { force: true });
      await rename(displacedProjectsRoot, projectsRoot);
    }

    assert.equal(report.projectsRemoved, 0);
    assert.equal(report.quarantinedRuntimeDirs.length, 0);
    const error = report.errors.find((entry) => entry.phase === "hub-root-validation");
    assert.ok(error, "symlinked projects root must fail closed");
    assert.match(error.message, /hub projects root.*real directory/);
    assert.equal(await readFile(path.join(runtimeRoot, "marker.txt"), "utf8"), "runtime data");
    const registry = JSON.parse(await readFile(path.join(hubRoot, "projects.json"), "utf8"));
    assert.equal(registry.projects[projectId].projectRuntimeRoot, runtimeRoot);
  });

  it("does not unregister a same-path successor published after quarantine", async () => {
    const projectId = "polluted-race-test";
    const { hubRoot, runtimeRoot } = await writePollutedProject(projectId);

    const report = await withCleanupTestHooksForTests({
      beforePollutionRegistryMutation: async () => {
        await mkdir(runtimeRoot, { recursive: true });
        await writeFile(path.join(runtimeRoot, "successor.txt"), "successor data", "utf8");
        await writeFile(path.join(hubRoot, "projects.json"), JSON.stringify({
          version: 1,
          updatedAt: new Date().toISOString(),
          projects: {
            [projectId]: {
              id: projectId,
              name: projectId,
              sourcePath: path.join(cpbRoot, "sources", projectId),
              projectRuntimeRoot: runtimeRoot,
              enabled: true,
              metadata: { visibility: "successor" },
            },
          },
        }) + "\n", "utf8");
      },
    }, () => cleanupPollution(cpbRoot, { hubRoot }));

    assert.equal(report.projectsRemoved, 0);
    assert.equal(report.errors.length, 0);
    const quarantined = report.quarantinedRuntimeDirs.find((entry) => entry.projectId === projectId);
    assert.ok(quarantined, "quarantine path must be reported");
    const quarantinePath = quarantined.quarantinePath;
    if (typeof quarantinePath !== "string") throw new Error("quarantinePath must be a string");
    assert.equal(await readFile(path.join(quarantinePath, "marker.txt"), "utf8"), "runtime data");
    assert.equal(await readFile(path.join(runtimeRoot, "successor.txt"), "utf8"), "successor data");
    const registry = JSON.parse(await readFile(path.join(hubRoot, "projects.json"), "utf8"));
    assert.equal(registry.projects[projectId].projectRuntimeRoot, runtimeRoot);
    assert.equal(registry.projects[projectId].metadata.visibility, "successor");
    assert.equal(registry.projects[projectId].metadata.cleanupRecovery.status, "quarantined");
    assert.equal(registry.projects[projectId].metadata.cleanupRecovery.recoveryPath, quarantinePath);
  });

  it("reconcile exposes pollution cleanup errors in the report", async () => {
    const projectId = "polluted-reconcile-test";
    const { hubRoot } = await writePollutedProject(projectId);

    const report = await withCleanupTestHooksForTests({
      beforePollutionRegistryMutation: () => {
        throw new Error("forced registry failure");
      },
    }, () => reconcileJobs(cpbRoot, { dryRun: false, hubRoot, cleanupPollution: true }));

    const pollution = report.pollution;
    if (!pollution || typeof pollution !== "object" || !("errors" in pollution) || !Array.isArray(pollution.errors)) {
      throw new Error("reconcile report must include pollution cleanup errors");
    }
    const error = pollution.errors.find((entry) => entry.projectId === projectId && entry.phase === "registry-recovery");
    assert.ok(error, "pollution cleanup error must not be swallowed");
    assert.match(error.message, /forced registry failure/);
    assert.ok(error.quarantinePath);
    if (typeof error.quarantinePath !== "string") throw new Error("quarantinePath must be a string");
    const registry = JSON.parse(await readFile(path.join(hubRoot, "projects.json"), "utf8"));
    assert.equal(registry.projects[projectId].metadata.cleanupRecovery.recoveryPath, error.quarantinePath);
  });
});

describe("jobs-index rebuild", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("rebuilds index from event streams", async () => {
    const project = "indextest";
    const { dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const job = await createJob(cpbRoot, { project, task: "index rebuild", dataRoot });
    await completeJob(cpbRoot, project, job.jobId, { dataRoot });

    const index = await rebuildJobsIndex(cpbRoot, { dataRoot, includeLegacyFallback: false });
    assert.ok(index._meta);
    assert.ok(index.jobs[`${project}/${job.jobId}`]);

    const state = index.jobs[`${project}/${job.jobId}`];
    assert.equal(state.status, "completed");
    await assertSourceCpbTaskAbsent(cpbRoot);
  });
});

describe("validateEventStream - dry-run", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("does not mutate truncated JSONL in dry-run mode", async () => {
    const project = "dryrunproj";
    const { dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const jobId = "job-dryrun-trunc";
    const file = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
    const validEvent = JSON.stringify({ type: "job_created", jobId, project, task: "test", ts: new Date().toISOString() });
    await mkdir(path.dirname(file), { recursive: true });
    const originalContent = validEvent + "\n" + '{"type":"phase_started","incom';
    await writeFile(file, originalContent, "utf8");

    const modBefore = await fileModTime(file);
    const result = await validateEventStream(cpbRoot, project, jobId, { dryRun: true, dataRoot });
    assert.equal(result.valid, true);
    assert.equal(result.wouldRepair, true);
    assert.equal(result.repaired, false);
    assert.equal(result.events.length, 1);

    // File must NOT be modified
    const contentAfter = await readFile(file, "utf8");
    assert.equal(contentAfter, originalContent);
    const modAfter = await fileModTime(file);
    assert.equal(modBefore, modAfter);
    await assertSourceCpbTaskAbsent(cpbRoot);
  });
});

describe("reconcileJobs - dry-run event stream safety", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("does not repair truncated JSONL when dryRun is true", async () => {
    const project = "recdryrun";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const job = await createJob(cpbRoot, { project, task: "dry-run reconcile", dataRoot });
    const eventFile = path.join(dataRoot, "events", project, `${job.jobId}.jsonl`);

    // Append a truncated line
    await appendEvent(cpbRoot, project, job.jobId, {
      type: "phase_activity", jobId: job.jobId, project, message: "activity", ts: new Date().toISOString(),
    }, { dataRoot });
    const raw = await readFile(eventFile, "utf8");
    await writeFile(eventFile, raw + '{"type":"phase_started","incom', "utf8");

    const modBefore = await fileModTime(eventFile);
    const report = await reconcileJobs(cpbRoot, { dryRun: true, hubRoot });

    // Should report a would-repair but not actually modify
    assert.ok(report.streamRepairs.length >= 1);
    assert.ok(report.streamRepairs[0].wouldRepair);
    assert.equal(report.indexRebuilt, false);

    // File must be unchanged
    const modAfter = await fileModTime(eventFile);
    assert.equal(modBefore, modAfter);
    await assertSourceCpbTaskAbsent(cpbRoot);
  });

  it("does not rebuild index when stream errors exist", async () => {
    const project = "streamerr";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const job = await createJob(cpbRoot, { project, task: "stream error test", dataRoot });
    await completeJob(cpbRoot, project, job.jobId, { dataRoot });

    // Build a valid index first
    await rebuildJobsIndex(cpbRoot, { dataRoot, includeLegacyFallback: false });
    const indexBefore = await readJobsIndex(cpbRoot, { dataRoot });
    assert.ok(indexBefore);

    // Now corrupt the event stream with a malformed middle line
    const eventFile = path.join(dataRoot, "events", project, `${job.jobId}.jsonl`);
    const validEvent = JSON.stringify({ type: "job_created", jobId: job.jobId, project, task: "test", ts: new Date().toISOString() });
    const validEvent2 = JSON.stringify({ type: "phase_started", jobId: job.jobId, project, phase: "plan", ts: new Date().toISOString() });
    await mkdir(path.dirname(eventFile), { recursive: true });
    await writeFile(eventFile, validEvent + "\nTHIS_IS_NOT_JSON\n" + validEvent2 + "\n", "utf8");

    const report = await reconcileJobs(cpbRoot, { dryRun: false, hubRoot });
    assert.ok(report.streamErrors.length >= 1);
    assert.equal(report.indexRebuilt, false);

    // Index should not have been rebuilt (same _meta timestamp)
    const indexAfter = await readJobsIndex(cpbRoot, { dataRoot });
    assert.equal(indexBefore._meta.updatedAt, indexAfter._meta.updatedAt);
    await assertSourceCpbTaskAbsent(cpbRoot);
  });
});

describe("cleanupDryRun - jobId matching", () => {
  let cpbRoot;
  before(async () => { cpbRoot = await makeCpbRoot(); });
  after(async () => { if (cpbRoot) await rm(cpbRoot, { recursive: true, force: true }); });

  it("reports lease for removal when its jobId matches a terminal job", async () => {
    const project = "jobidmatch";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const job = await createJob(cpbRoot, { project, task: "jobId match test", dataRoot });
    await failJob(cpbRoot, project, job.jobId, { reason: "test failure", dataRoot });

    // Create a lease file whose filename is NOT the job's leaseId,
    // but whose JSON payload has the terminal job's jobId
    const orphanLeaseId = "lease-orphan-by-jobid-001";
    const leasesDir = path.join(dataRoot, "leases");
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

    const report = await cleanupDryRun(cpbRoot, { hubRoot });
    assert.ok(report.leasesToRemove.includes(orphanLeaseId),
      `cleanupDryRun should report lease ${orphanLeaseId} for removal because its jobId matches terminal job ${job.jobId}`);
    await assertSourceCpbTaskAbsent(cpbRoot);
  });

  it("cleanupDryRun is mutation-free", async () => {
    const project = "mutationfree";
    const { hubRoot, dataRoot } = await setupProjectRuntime(cpbRoot, project);
    const job = await createJob(cpbRoot, { project, task: "mutation test", dataRoot });
    const leaseId = `lease-${job.jobId}-plan`;
    await acquireLease(cpbRoot, {
      leaseId,
      jobId: job.jobId,
      phase: "plan",
      ttlMs: 600_000,
      dataRoot,
    });
    await completeJob(cpbRoot, project, job.jobId, { dataRoot });

    const leasesDir = path.join(dataRoot, "leases");
    const leaseFile = path.join(leasesDir, `${leaseId}.json`);
    const modBefore = await fileModTime(leaseFile);

    await cleanupDryRun(cpbRoot, { hubRoot });

    // Lease file must still exist and be unchanged
    await assert.doesNotReject(() => stat(leaseFile));
    const modAfter = await fileModTime(leaseFile);
    assert.equal(modBefore, modAfter);
    await assertSourceCpbTaskAbsent(cpbRoot);
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

    const workerOwner = await shortLivedOwner();
    await workerOwner.close();

    // Write registry with a stale worker (dead incarnation, old lastSeenAt)
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
            workerId: `cli-${workerOwner.pid}`,
            pid: workerOwner.pid,
            processIdentity: workerOwner.processIdentity,
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
    assert.ok(found.processIncarnation);
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

  it("requires an explicit runtime data root", async () => {
    const bridgePath = path.resolve(
      path.join(import.meta.dirname, "..", "..", "bridges", "job-runner.js")
    );
    const child = spawn(process.execPath, [
      bridgePath,
      "--cpb-root", cpbRoot,
      "--project", "sigtest",
      "--job-id", "job-20260611-000000-missing",
      "--phase", "execute",
      "--script", "/bin/true",
      "--",
    ], {
      cwd: cpbRoot,
      env: { ...process.env, CPB_PROJECT_RUNTIME_ROOT: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const exitCode = await new Promise((resolve) => {
      child.once("close", (code) => resolve(code));
    });

    assert.equal(exitCode, 2);
    assert.match(stderr, /missing required runtime data root/);
  });

  it("records interrupted evidence on SIGINT", async () => {
    const project = "sigtest";
    const dataRoot = path.join(cpbRoot, "runtime");
    const job = await createJob(cpbRoot, { project, task: "signal test", dataRoot });
    const eventFile = path.join(dataRoot, "events", project, `${job.jobId}.jsonl`);

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
      "--data-root", dataRoot,
      "--",
    ], {
      cwd: cpbRoot,
      env: { ...process.env, CPB_ROOT: cpbRoot, CPB_HUB_ROOT: "", CPB_PROJECT_RUNTIME_ROOT: "" },
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
