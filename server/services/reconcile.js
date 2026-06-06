import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";
import { listEventFiles, readEvents, materializeJob, recoverEventFile } from "./event-store.js";
import { appendEvent } from "./event-store.js";
import { readLease, releaseLease, isLeaseStale } from "./lease-manager.js";
import { listJobs, failJob, blockJob } from "./job-store.js";
import { rebuildJobsIndex, readJobsIndex } from "./jobs-index.js";
import { resolveHubRoot, loadRegistry, saveRegistry } from "./hub-registry.js";
import { projectRuntimeRoot } from "./runtime-root.js";
import { listProcesses, classifyLiveness, removeProcess } from "./process-registry.js";
import { listQueue as listHubQueue, updateEntry as updateQueueEntry } from "./hub-queue.js";
import { scanHubPollution, isUnderTestPath } from "./project-pollution.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function findMatchingQueueEntry(queueEntries, job) {
  const inProgress = queueEntries.filter((e) => e.status === "in_progress");
  let match = inProgress.find((e) => e.metadata?.jobId === job.jobId);
  if (match) return match;
  match = inProgress.find((e) => e.metadata?.originJobId === job.jobId);
  if (match) return match;
  const byTask = inProgress.filter(
    (e) => e.projectId === job.project && e.description === job.task
  );
  if (byTask.length === 1) return byTask[0];
  return null;
}

function isProcessAlive(pid) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: process exists but no permission → still alive
    if (err.code === "EPERM") return true;
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
      return { valid: true, events: [], recovered: false, error: null };
    }
    throw err;
  }

  if (raw.length === 0) {
    return { valid: true, events: [], recovered: false, error: null };
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
        const recoveredEvents = nonEmpty.slice(0, i).map(({ line: l }) => JSON.parse(l));
        if (dryRun) {
          return {
            valid: true,
            events: recoveredEvents,
            recovered: false,
            wouldRecover: true,
            error: null,
          };
        }
        const recoveryResult = await recoverEventFile(cpbRoot, project, jobId);
        return {
          valid: true,
          events: recoveredEvents,
          recovered: true,
          recoveryResult,
          error: null,
        };
      }
      return {
        valid: false,
        events: null,
        recovered: false,
        error: { file, lineNumber, reason: "malformed JSON" },
      };
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      return {
        valid: false,
        events: null,
        recovered: false,
        error: { file, lineNumber, reason: "event must be a non-null object" },
      };
    }
    events.push(event);
  }

  return { valid: true, events, recovered: false, error: null };
}

export async function reconcileJobs(cpbRoot, { dryRun = false } = {}) {
  const report = {
    staleJobs: [],
    orphanLeases: [],
    streamRecoveries: [],
    streamErrors: [],
    indexRebuilt: false,
    workers: { stale: [] },
    reconciledProcesses: [],
    reconciledQueueEntries: [],
  };

  const jobs = await listJobs(cpbRoot);
  const now = new Date();

  const processEntries = await listProcesses(cpbRoot);
  const processByJobId = new Map();
  for (const pe of processEntries) {
    if (pe.jobId) processByJobId.set(pe.jobId, pe);
  }

  const hubRoot = resolveHubRoot(cpbRoot);
  let queueEntries = [];
  try { queueEntries = await listHubQueue(hubRoot); } catch {}

  // 1. Detect stale running jobs
  const runningJobs = jobs.filter(
    (j) => !TERMINAL_STATUSES.has(j.status) && j.jobId
  );

  for (const job of runningJobs) {
    let isStale = false;
    let staleViaProcessOrphan = false;
    let staleReason = "";
    let cause = null;
    let failureArtifact = null;
    const processEntry = processByJobId.get(job.jobId) || null;

    // Check process registry first (concrete evidence of vanished phase runner)
    if (processEntry && processEntry.status === "running") {
      const liveness = classifyLiveness(processEntry);
      if (liveness === "orphan") {
        const phase = processEntry.phase || job.phase || "unknown";
        isStale = true;
        staleViaProcessOrphan = true;
        staleReason = `${phase} process disappeared before terminal phase event`;
        cause = {
          kind: "stale_runtime_reconciled",
          failureReason: "stale_pid_disappeared",
          phase,
          jobId: job.jobId,
          leaseId: processEntry.leaseId || job.leaseId || null,
          runnerPid: processEntry.runnerPid,
          processStatus: processEntry.status,
          lastHeartbeat: processEntry.lastHeartbeat,
          observedAt: nowIso(),
        };
        failureArtifact = `process:${job.jobId}:phase:${phase}`;
      }
    }

    // Fall back to lease-based detection
    if (!isStale && job.leaseId) {
      const lease = await readLease(cpbRoot, job.leaseId);
      if (lease === null) {
        isStale = true;
        staleReason = "lease file missing";
        cause = {
          kind: "stale_runtime_reconciled",
          failureReason: "lease_missing",
          phase: job.phase,
          jobId: job.jobId,
          leaseId: job.leaseId,
          observedAt: nowIso(),
        };
        failureArtifact = `lease:${job.leaseId}:phase:${job.phase || "unknown"}`;
      } else if (isLeaseStale(lease, now)) {
        if (lease.ownerPid && !isProcessAlive(lease.ownerPid)) {
          isStale = true;
          staleReason = `owner process dead (pid ${lease.ownerPid})`;
          cause = {
            kind: "stale_runtime_reconciled",
            failureReason: "lease_stale_owner_dead",
            phase: job.phase,
            jobId: job.jobId,
            leaseId: job.leaseId,
            runnerPid: lease.ownerPid,
            leaseExpiresAt: lease.expiresAt,
            observedAt: nowIso(),
          };
          failureArtifact = `lease:${job.leaseId}:phase:${job.phase || "unknown"}`;
          if (processEntry) {
            cause.processStatus = processEntry.status;
            cause.lastHeartbeat = processEntry.lastHeartbeat;
          }
        } else if (!lease.ownerPid) {
          isStale = true;
          staleReason = "lease expired with no owner pid";
          cause = {
            kind: "stale_runtime_reconciled",
            failureReason: "lease_expired_owner_pid_missing",
            phase: job.phase,
            jobId: job.jobId,
            leaseId: job.leaseId,
            leaseExpiresAt: lease.expiresAt,
            observedAt: nowIso(),
          };
          failureArtifact = `lease:${job.leaseId}:phase:${job.phase || "unknown"}`;
        }
      }
    } else if (!isStale && job.status === "running") {
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
      const jobReport = {
        jobId: job.jobId,
        project: job.project,
        reason: staleReason,
        worktree: job.worktree || null,
      };
      if (cause) {
        jobReport.failureReason = cause.failureReason;
        jobReport.failureArtifact = failureArtifact;
      }
      report.staleJobs.push(jobReport);

      if (dryRun) {
        // Report intended actions without mutating files
        if (cause) {
          const matched = findMatchingQueueEntry(queueEntries, job);
          if (matched) {
            report.reconciledQueueEntries.push({
              queueEntryId: matched.id,
              jobId: job.jobId,
              wouldReconcile: true,
            });
          }
        }
        if (processEntry) {
          report.reconciledProcesses.push({
            jobId: job.jobId,
            wouldRemove: true,
          });
        }
        if (staleViaProcessOrphan && job.leaseId) {
          report.orphanLeases.push({
            leaseId: job.leaseId,
            jobId: job.jobId,
            reason: "would clean with reconciled stale job",
          });
        }
      } else {
        try {
          await failJob(cpbRoot, job.project, job.jobId, {
            reason: `stale_runtime_reconciled: ${staleReason}`,
            code: "FATAL",
            phase: cause?.phase || job.phase,
            cause,
          });
        } catch (err) {
          if (err.message?.includes("job is terminal") || err.message?.includes("job not found")) {
            jobReport.skipped = true;
            jobReport.skipReason = err.message;
          } else {
            throw err;
          }
        }

        // Mark matching queue entry failed with failure metadata
        if (cause) {
          const matched = findMatchingQueueEntry(queueEntries, job);
          if (matched) {
            try {
              await updateQueueEntry(hubRoot, matched.id, {
                status: "failed",
                claimedBy: null,
                claimedAt: null,
                workerId: null,
                metadata: {
                  failureCode: "FATAL",
                  failureReason: cause.failureReason,
                  failureCause: cause,
                  failureArtifact,
                  reconciledJobId: job.jobId,
                  reconciledAt: cause.observedAt,
                },
              });
              report.reconciledQueueEntries.push({
                queueEntryId: matched.id,
                jobId: job.jobId,
              });
            } catch {}
          }
        }

        // Clean stale process registry record
        if (processEntry) {
          try {
            await removeProcess(cpbRoot, job.jobId);
            report.reconciledProcesses.push({ jobId: job.jobId, removed: true });
          } catch {
            report.reconciledProcesses.push({ jobId: job.jobId, removed: false, error: "cleanup failed" });
          }
        }

        // Clean stale lease (direct removal to bypass owner-token checks)
        if (job.leaseId) {
          try {
            const leasesDir = runtimeDataPath(cpbRoot, "leases");
            await rm(path.join(leasesDir, `${job.leaseId}.json`), { force: true });
            try { await rm(path.join(leasesDir, `${job.leaseId}.json.lock`), { recursive: true, force: true }); } catch {}
          } catch {}
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

  // 3b. Prune exited workers from registry
  try {
    const { WorkerStore } = await import("../../shared/orchestrator/worker-store.js");
    const store = new WorkerStore(hubRoot);
    await store.init();
    const pruned = dryRun ? 0 : await store.pruneDead();
    if (pruned > 0) {
      report.workers.pruned = pruned;
    }
  } catch { /* hub not initialized */ }

  // 4. Validate and recover JSONL event streams
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
    } else if (result.recovered || result.wouldRecover) {
      report.streamRecoveries.push({ project, jobId, wouldRecover: result.wouldRecover || false });
    }
  }

  // 5. Rebuild jobs-index from authoritative state (only when no stream errors)
  if (!dryRun && report.streamErrors.length === 0) {
    await rebuildJobsIndex(cpbRoot);
    report.indexRebuilt = true;
  }

  // 6. Clean up test/fixture pollution and orphan runtime dirs
  if (dryRun) {
    try {
      const preview = await cleanupDryRun(cpbRoot);
      report.pollutionPreview = {
        testProjectsToRemove: preview.testProjectsToRemove?.length || 0,
        orphanRuntimeDirsToRemove: preview.orphanRuntimeDirsToRemove?.length || 0,
        candidates: preview.testProjectsToRemove,
        orphanDirs: preview.orphanRuntimeDirsToRemove,
      };
    } catch {}
  } else {
    try {
      report.pollution = await cleanupPollution(cpbRoot);
    } catch {}
  }

  return report;
}

export async function cleanupDryRun(cpbRoot) {
  const report = {
    leasesToRemove: [],
    worktreesPreserved: [],
    totalLeaseFiles: 0,
    totalJobCount: 0,
    testProjectsToRemove: [],
    pollutedProjectsToRemove: [],
    orphanRuntimeDirsToRemove: [],
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

  // Scan for test/polluted projects and orphan runtime dirs
  const hubRoot = resolveHubRoot(cpbRoot);
  try {
    const pollution = await scanHubPollution(hubRoot);
    report.testProjectsToRemove = pollution.candidates;
    report.orphanRuntimeDirsToRemove = pollution.orphanRuntimeDirs;
  } catch {}

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

/**
 * Determine whether a polluted project's runtime directory can be safely deleted.
 * Only allows deletion when the target is exactly the expected runtime root for that
 * project, or a child path under that expected root. Rejects hubRoot, <hubRoot>/projects,
 * another registered project's expected root, sourcePath, and ancestors of sourcePath.
 */
function safePollutionRuntimeTarget({ hubRoot, project, projectId, registry }) {
  const hubResolved = path.resolve(hubRoot);
  const hubProjectsResolved = path.join(hubResolved, "projects");
  const targetRaw = project.projectRuntimeRoot;
  if (!targetRaw) return { canDelete: false, reason: "no-runtime-root" };

  const targetResolved = path.resolve(targetRaw);
  const sourceResolved = project.sourcePath ? path.resolve(project.sourcePath) : null;

  // Never delete hubRoot itself
  if (targetResolved === hubResolved) {
    return { canDelete: false, reason: "hub-root" };
  }
  // Never delete <hubRoot>/projects (shared directory)
  if (targetResolved === hubProjectsResolved) {
    return { canDelete: false, reason: "hub-projects-root" };
  }
  // Never delete sourcePath
  if (sourceResolved && targetResolved === sourceResolved) {
    return { canDelete: false, reason: "source-path-preserved" };
  }
  // Never delete an ancestor of sourcePath
  if (sourceResolved && targetResolved !== sourceResolved &&
      sourceResolved.startsWith(targetResolved + path.sep)) {
    return { canDelete: false, reason: "source-path-ancestor" };
  }

  // Compute the expected runtime root for this specific project
  const pid = projectId || project.id;
  if (!pid) return { canDelete: false, reason: "no-project-id" };
  const expectedRoot = projectRuntimeRoot(hubRoot, pid);

  // Never delete another registered project's expected runtime root
  if (registry && typeof registry.projects === "object" && registry.projects !== null) {
    const entries = Array.isArray(registry.projects)
      ? registry.projects
      : Object.values(registry.projects);
    for (const other of entries) {
      const otherId = other.id;
      if (!otherId || otherId === pid) continue;
      const otherExpected = projectRuntimeRoot(hubRoot, otherId);
      if (targetResolved === otherExpected) {
        return { canDelete: false, reason: "other-project-runtime-root" };
      }
    }
  }

  // Only allow deletion when target is exactly the expected root or a child of it
  if (targetResolved === expectedRoot) {
    return { canDelete: true, reason: "exact-expected-root" };
  }
  if (targetResolved.startsWith(expectedRoot + path.sep)) {
    return { canDelete: true, reason: "child-of-expected-root" };
  }

  // Target is outside the expected root — unsafe
  return { canDelete: false, reason: "unsafe-runtime-root" };
}

export async function cleanupPollution(cpbRoot) {
  const hubRoot = resolveHubRoot(cpbRoot);
  let projectsRemoved = 0;
  let orphanDirsRemoved = 0;
  const sourcePathsPreserved = [];
  const unsafeProjectsSkipped = [];
  const errors = [];

  const pollution = await scanHubPollution(hubRoot);
  const registry = await loadRegistry(hubRoot);

  // Remove registry entries classified as pollution
  for (const candidate of pollution.candidates) {
    const project = registry.projects[candidate.projectId];
    if (!project) continue;

    const safety = safePollutionRuntimeTarget({
      hubRoot,
      project,
      projectId: candidate.projectId,
      registry,
    });

    if (!safety.canDelete) {
      // Source under tmpdir — safe to remove registry entry, skip runtime dir
      if (isUnderTestPath(project.sourcePath)) {
        delete registry.projects[candidate.projectId];
        projectsRemoved++;
        continue;
      }
      unsafeProjectsSkipped.push({
        projectId: candidate.projectId,
        attemptedRoot: project.projectRuntimeRoot || null,
        reason: safety.reason,
      });
      continue;
    }

    sourcePathsPreserved.push(project.sourcePath);
    delete registry.projects[candidate.projectId];
    projectsRemoved++;

    if (project.projectRuntimeRoot) {
      try {
        const resolved = path.resolve(project.projectRuntimeRoot);
        await rm(resolved, { recursive: true, force: true });
      } catch (err) {
        errors.push({ projectId: candidate.projectId, phase: "runtime-rm", message: err.message });
      }
    }
  }

  // Remove orphan runtime directories
  for (const orphan of pollution.orphanRuntimeDirs) {
    try {
      await rm(orphan.runtimeDir, { recursive: true, force: true });
      orphanDirsRemoved++;
    } catch (err) {
      errors.push({ kind: "orphan-runtime-dir", dir: orphan.runtimeDir, message: err.message });
    }
  }

  if (projectsRemoved > 0) {
    await saveRegistry(hubRoot, registry);
  }

  return { projectsRemoved, orphanDirsRemoved, sourcePathsPreserved, unsafeProjectsSkipped, errors };
}
