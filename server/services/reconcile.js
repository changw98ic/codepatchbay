import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";
import { listEventFiles, readEvents, materializeJob, repairEventFile } from "./event-store.js";
import { appendEvent } from "./runtime-events.js";
import { readLease, releaseLease, isLeaseStale } from "./lease-manager.js";
import { listJobs, failJob, blockJob } from "./job-store.js";
import { rebuildJobsIndex, readJobsIndex } from "./jobs-index.js";
import { resolveHubRoot, loadRegistry } from "./hub-registry.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function isProcessAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

export async function validateEventStream(cpbRoot, project, jobId, { dryRun = false } = {}) {
  const events = [];
  let raw;
  const file = path.join(runtimeDataPath(cpbRoot, "events"), project, `${jobId}.jsonl`);

  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { valid: true, events: [], repaired: false, error: null };
    }
    throw err;
  }

  if (raw.length === 0) {
    return { valid: true, events: [], repaired: false, error: null };
  }

  const hasTrailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  const nonEmpty = lines.map((line, idx) => ({ line, lineNumber: idx + 1 }))
    .filter(({ line }) => line.trim().length > 0);

  for (let i = 0; i < nonEmpty.length; i++) {
    const { line, lineNumber } = nonEmpty[i];
    const isLast = i === nonEmpty.length - 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (isLast && !hasTrailingNewline) {
        const repairedEvents = nonEmpty.slice(0, i).map(({ line: l }) => JSON.parse(l));
        if (dryRun) {
          return {
            valid: true,
            events: repairedEvents,
            repaired: false,
            wouldRepair: true,
            error: null,
          };
        }
        const repairResult = await repairEventFile(cpbRoot, project, jobId);
        return {
          valid: true,
          events: repairedEvents,
          repaired: true,
          repairResult,
          error: null,
        };
      }
      return {
        valid: false,
        events: null,
        repaired: false,
        error: { file, lineNumber, reason: "malformed JSON" },
      };
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      return {
        valid: false,
        events: null,
        repaired: false,
        error: { file, lineNumber, reason: "event must be a non-null object" },
      };
    }
    events.push(event);
  }

  return { valid: true, events, repaired: false, error: null };
}

export async function reconcileJobs(cpbRoot, { dryRun = false } = {}) {
  const report = {
    staleJobs: [],
    orphanLeases: [],
    streamRepairs: [],
    streamErrors: [],
    indexRebuilt: false,
    workers: { stale: [] },
  };

  const jobs = await listJobs(cpbRoot);
  const now = new Date();

  // 1. Detect stale running jobs
  const runningJobs = jobs.filter(
    (j) => !TERMINAL_STATUSES.has(j.status) && j.jobId
  );

  for (const job of runningJobs) {
    let isStale = false;
    let staleReason = "";

    if (job.leaseId) {
      const lease = await readLease(cpbRoot, job.leaseId);
      if (lease === null) {
        isStale = true;
        staleReason = "lease file missing";
      } else if (isLeaseStale(lease, now)) {
        if (lease.ownerPid && !isProcessAlive(lease.ownerPid)) {
          isStale = true;
          staleReason = `owner process dead (pid ${lease.ownerPid})`;
        } else if (!lease.ownerPid) {
          isStale = true;
          staleReason = "lease expired with no owner pid";
        }
      }
    } else if (job.status === "running") {
      // Running with no lease — check lastActivityAt
      if (job.lastActivityAt) {
        const age = now.getTime() - new Date(job.lastActivityAt).getTime();
        if (age > 300_000) {
          isStale = true;
          staleReason = "no lease, no activity for 5m";
        }
      } else {
        isStale = true;
        staleReason = "no lease, no activity recorded";
      }
    }

    if (isStale) {
      report.staleJobs.push({ jobId: job.jobId, project: job.project, reason: staleReason, worktree: job.worktree || null });

      if (!dryRun) {
        await failJob(cpbRoot, job.project, job.jobId, {
          reason: `stale_runtime_reconciled: ${staleReason}`,
          code: "FATAL",
          phase: job.phase,
        });
        if (job.leaseId) {
          try { await releaseLease(cpbRoot, job.leaseId); } catch {}
        }
      }
    }
  }

  // 2. Detect orphan leases
  const activeJobIds = new Set(jobs.map((j) => j.jobId));
  const leasesDir = runtimeDataPath(cpbRoot, "leases");
  let leaseFiles;
  try {
    leaseFiles = await readdir(leasesDir);
  } catch {
    leaseFiles = [];
  }

  for (const f of leaseFiles) {
    if (!f.endsWith(".json")) continue;
    const leaseId = f.slice(0, -".json".length);

    let lease;
    try {
      const raw = await readFile(path.join(leasesDir, f), "utf8");
      lease = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!lease || !lease.jobId) continue;
    if (TERMINAL_STATUSES.has(lease.phase) && !lease.jobId) continue;

    const jobExists = activeJobIds.has(lease.jobId);
    const ownerAlive = lease.ownerPid ? isProcessAlive(lease.ownerPid) : false;
    const leaseExpired = isLeaseStale(lease, now);

    if ((!jobExists || (leaseExpired && !ownerAlive))) {
      report.orphanLeases.push({
        leaseId,
        jobId: lease.jobId || null,
        reason: !jobExists ? "job not found" : "expired with dead owner",
      });

      if (!dryRun) {
        try {
          const lockDir = path.join(leasesDir, `${leaseId}.json.lock`);
          await rm(path.join(leasesDir, f), { force: true });
          try { await rm(lockDir, { recursive: true, force: true }); } catch {}
        } catch {}
      }
    }
  }

  // 3. Detect stale workers from Hub registry
  const hubRoot = resolveHubRoot(cpbRoot);
  let registry;
  try {
    registry = await loadRegistry(hubRoot);
  } catch {
    registry = null;
  }

  if (registry && typeof registry.projects === "object" && registry.projects !== null) {
    const projectEntries = Array.isArray(registry.projects)
      ? registry.projects
      : Object.values(registry.projects);

    for (const project of projectEntries) {
      if (!project.worker || !project.worker.lastSeenAt) continue;
      const age = now.getTime() - new Date(project.worker.lastSeenAt).getTime();
      const pid = project.worker.pid;
      if (age > 300_000 && pid && !isProcessAlive(pid)) {
        report.workers.stale.push({
          project: project.id,
          workerId: project.worker.workerId,
          pid,
          lastSeenAt: project.worker.lastSeenAt,
        });
        if (!dryRun) {
          project.worker = null;
        }
      }
    }

    if (!dryRun && report.workers.stale.length > 0) {
      const { saveRegistry } = await import("./hub-registry.js");
      await saveRegistry(hubRoot, registry);
    }
  }

  // 4. Validate and repair JSONL event streams
  const eventFiles = await listEventFiles(cpbRoot);
  for (const { project, jobId } of eventFiles) {
    const result = await validateEventStream(cpbRoot, project, jobId, { dryRun });
    if (result.error) {
      report.streamErrors.push({
        project,
        jobId,
        file: result.error.file,
        lineNumber: result.error.lineNumber,
        reason: result.error.reason,
      });
    } else if (result.repaired || result.wouldRepair) {
      report.streamRepairs.push({ project, jobId, wouldRepair: result.wouldRepair || false });
    }
  }

  // 5. Rebuild jobs-index from authoritative state (only when no stream errors)
  if (!dryRun && report.streamErrors.length === 0) {
    await rebuildJobsIndex(cpbRoot);
    report.indexRebuilt = true;
  }

  return report;
}

export async function cleanupDryRun(cpbRoot) {
  const report = {
    leasesToRemove: [],
    worktreesPreserved: [],
    totalLeaseFiles: 0,
    totalJobCount: 0,
  };

  const jobs = await listJobs(cpbRoot);
  report.totalJobCount = jobs.length;

  const terminalLeaseIds = new Set(
    jobs.filter((j) => TERMINAL_STATUSES.has(j.status) && j.leaseId).map((j) => j.leaseId)
  );
  const terminalJobIds = new Set(
    jobs.filter((j) => TERMINAL_STATUSES.has(j.status)).map((j) => j.jobId)
  );

  const leasesDir = runtimeDataPath(cpbRoot, "leases");
  let leaseFiles;
  try {
    leaseFiles = await readdir(leasesDir);
  } catch {
    leaseFiles = [];
  }
  report.totalLeaseFiles = leaseFiles.filter((f) => f.endsWith(".json")).length;

  for (const f of leaseFiles) {
    if (!f.endsWith(".json")) continue;
    const leaseId = f.slice(0, -".json".length);

    let leaseJobId = null;
    try {
      const raw = await readFile(path.join(leasesDir, f), "utf8");
      const lease = JSON.parse(raw);
      leaseJobId = lease.jobId || null;
    } catch {}

    const shouldClean = terminalLeaseIds.has(leaseId) ||
      (leaseJobId && terminalJobIds.has(leaseJobId));
    if (shouldClean) {
      report.leasesToRemove.push(leaseId);
    }
  }

  // Report worktrees that would be preserved
  for (const job of jobs) {
    if (job.worktree && job.status !== "completed") {
      report.worktreesPreserved.push({
        jobId: job.jobId,
        worktree: job.worktree,
        status: job.status,
      });
    }
  }

  return report;
}

export async function cleanupJobs(cpbRoot) {
  const jobs = await listJobs(cpbRoot);
  const terminal = new Set(["completed", "failed", "blocked", "cancelled"]);
  const terminalJobIds = new Set(
    jobs.filter((j) => terminal.has(j.status)).map((j) => j.jobId)
  );
  // Also match by leaseId from job state (for jobs where leaseId survived)
  const terminalLeaseIds = new Set(
    jobs.filter((j) => terminal.has(j.status) && j.leaseId).map((j) => j.leaseId)
  );

  const leasesDir = runtimeDataPath(cpbRoot, "leases");
  let cleaned = 0;
  try {
    const files = await readdir(leasesDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const leaseId = f.slice(0, -".json".length);

      let leaseJobId = null;
      try {
        const raw = await readFile(path.join(leasesDir, f), "utf8");
        const lease = JSON.parse(raw);
        leaseJobId = lease.jobId || null;
      } catch {}

      const shouldClean = terminalLeaseIds.has(leaseId) ||
        (leaseJobId && terminalJobIds.has(leaseJobId));
      if (shouldClean) {
        await rm(path.join(leasesDir, f), { force: true });
        try {
          await rm(path.join(leasesDir, `${leaseId}.json.lock`), { recursive: true, force: true });
        } catch {}
        cleaned++;
      }
    }
  } catch {}

  return { cleaned };
}
