// ── reconcile ──
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { listRuntimeDataRoots, resolveProjectDataRoot, runtimeDataPath, runtimeDataRoot } from "../runtime.js";
import { eventFileFor, listEventFiles, readEvents, materializeJob, recoverEventFile } from "../event/event-store.js";
import { appendEvent } from "../event/event-store.js";
import { readLease, releaseLease, isLeaseStale } from "../infra.js";
import { listJobs, failJob, blockJob } from "../job/job-store.js";
import { rebuildJobsIndex, readJobsIndex } from "../job/job-store.js";
import { resolveHubRoot, loadRegistry, saveRegistry } from "../hub/hub-registry.js";
import { projectRuntimeRoot } from "../runtime.js";
import { listProcesses, classifyLiveness, removeProcess } from "../infra.js";
import { listQueue as listHubQueue, updateEntry as updateQueueEntry } from "../hub/hub-queue.js";
import { scanHubPollution, isUnderTestPath } from "../project/project-index.js";

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
    if (err.code === "EPERM") return true;
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function resolvedHubRoot(cpbRoot, options: Record<string, any> = {}) {
  return options.hubRoot ? path.resolve(options.hubRoot) : resolveHubRoot(cpbRoot);
}

async function cleanupRuntimeRoots(cpbRoot, options: Record<string, any> = {}) {
  if (options.dataRoot) {
    return [{ kind: "project", dataRoot: path.resolve(options.dataRoot), projectId: options.project || null }];
  }
  if (options.legacyOnly === true) {
    return [{ kind: "legacy", dataRoot: runtimeDataRoot(cpbRoot), projectId: null }];
  }

  const includeLegacy = options.includeLegacyFallback === true;
  const hubRoot = resolvedHubRoot(cpbRoot, options);
  try {
    return await listRuntimeDataRoots(cpbRoot, { hubRoot, includeLegacy });
  } catch {
    return [];
  }
}

async function listJobsForCleanup(cpbRoot, options: Record<string, any> = {}) {
  const roots = await cleanupRuntimeRoots(cpbRoot, options);
  const jobs = [];
  const seen = new Set();
  for (const root of roots) {
    const batch = await listJobs(cpbRoot, { dataRoot: root.dataRoot, includeLegacyFallback: false });
    for (const job of batch) {
      const key = `${job.project}/${job.jobId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({ ...job, __dataRoot: root.dataRoot });
    }
  }
  return jobs;
}

async function listProcessesForCleanup(cpbRoot, options: Record<string, any> = {}) {
  const roots = await cleanupRuntimeRoots(cpbRoot, options);
  const entries = [];
  const seen = new Set();
  for (const root of roots) {
    const batch = await listProcesses(cpbRoot, { dataRoot: root.dataRoot });
    for (const entry of batch) {
      const key = `${root.dataRoot}/${entry.jobId || entry.id || JSON.stringify(entry)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ ...entry, __dataRoot: root.dataRoot });
    }
  }
  return entries;
}

async function eventOptionsForProject(cpbRoot, project, options: Record<string, any> = {}) {
  if (options.legacyOnly === true) {
    return { ...options, legacyOnly: true };
  }
  if (options.dataRoot) {
    return { ...options, dataRoot: path.resolve(options.dataRoot), includeLegacyFallback: false };
  }
  if (options.hubRoot) {
    const dataRoot = await resolveProjectDataRoot(cpbRoot, project, { hubRoot: options.hubRoot });
    return { ...options, dataRoot, includeLegacyFallback: false };
  }
  throw new Error("dataRoot is required for project event store paths");
}

export async function validateEventStream(cpbRoot, project, jobId, { dryRun = false, ...options }: Record<string, any> = {}) {
  const events = [];
  let raw;
  const eventOptions = await eventOptionsForProject(cpbRoot, project, options);
  const file = eventFileFor(cpbRoot, project, jobId, eventOptions);

  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { valid: true, events: [], recovered: false, repaired: false, wouldRepair: false, error: null };
    }
    throw err;
  }

  if (raw.length === 0) {
    return { valid: true, events: [], recovered: false, repaired: false, wouldRepair: false, error: null };
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
            repaired: false,
            wouldRecover: true,
            wouldRepair: true,
            error: null,
          };
        }
        const recoveryResult = await recoverEventFile(cpbRoot, project, jobId, eventOptions);
        return {
          valid: true,
          events: recoveredEvents,
          recovered: true,
          repaired: true,
          wouldRepair: false,
          recoveryResult,
          error: null,
        };
      }
      return {
        valid: false,
        events: null,
        recovered: false,
        repaired: false,
        wouldRepair: false,
        error: { file, lineNumber, reason: "malformed JSON" },
      };
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      return {
        valid: false,
        events: null,
        recovered: false,
        repaired: false,
        wouldRepair: false,
        error: { file, lineNumber, reason: "event must be a non-null object" },
      };
    }
    events.push(event);
  }

  return { valid: true, events, recovered: false, repaired: false, wouldRepair: false, error: null };
}

/**
 * Recover orphaned (stuck-running) jobs — Phase 1 of reconcile extracted
 * for standalone use (e.g. worker startup).  Three-tier cascade:
 *   1. Process registry orphan (PID dead)
 *   2. Lease missing / expired with dead owner
 *   3. Activity timestamp fallback (no lease, no activity for 5 min)
 *
 * Returns { recovered: [{jobId, reason}], failed: [{jobId, error}] }
 */
export async function recoverOrphanedJobs(cpbRoot, options: Record<string, any> = {}) {
  const dryRun = options.dryRun || false;
  const recovered = [];
  const failed = [];

  const jobs = await listJobsForCleanup(cpbRoot, options);
  const processEntries = await listProcessesForCleanup(cpbRoot, options);
  const processByJobId = new Map();
  for (const pe of processEntries) {
    if (pe.jobId) processByJobId.set(pe.jobId, pe);
  }

  const hubRoot = resolvedHubRoot(cpbRoot, options);
  let queueEntries = [];
  try { queueEntries = await listHubQueue(hubRoot); } catch {}

  const now = new Date();
  const runningJobs = jobs.filter(
    (j) => !TERMINAL_STATUSES.has(j.status) && j.jobId
  );

  for (const job of runningJobs) {
    let isStale = false;
    let staleReason = "";
    let cause = null;
    const processEntry = processByJobId.get(job.jobId) || null;

    // Tier 1: Process registry orphan
    if (processEntry && processEntry.status === "running") {
      const liveness = classifyLiveness(processEntry);
      if (liveness === "orphan") {
        const phase = processEntry.phase || job.phase || "unknown";
        isStale = true;
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
      }
    }

    // Tier 2: Lease-based detection
    if (!isStale && job.leaseId) {
      let lease;
      try {
        lease = await readLease(cpbRoot, job.leaseId, { dataRoot: job.__dataRoot });
      } catch {
        // Corrupt or unreadable lease — treat as stale (lease is meaningless if unreadable)
        isStale = true;
        staleReason = "lease file unreadable (corrupt or I/O error)";
        cause = { kind: "stale_runtime_reconciled", failureReason: "lease_unreadable", phase: job.phase, jobId: job.jobId, leaseId: job.leaseId, observedAt: nowIso() };
      }
      if (!isStale && lease === null) {
        isStale = true;
        staleReason = "lease file missing";
        cause = { kind: "stale_runtime_reconciled", failureReason: "lease_missing", phase: job.phase, jobId: job.jobId, leaseId: job.leaseId, observedAt: nowIso() };
      } else if (isLeaseStale(lease, now)) {
        if (lease.ownerPid && !isProcessAlive(lease.ownerPid)) {
          isStale = true;
          staleReason = `owner process dead (pid ${lease.ownerPid})`;
          cause = { kind: "stale_runtime_reconciled", failureReason: "lease_stale_owner_dead", phase: job.phase, jobId: job.jobId, leaseId: job.leaseId, runnerPid: lease.ownerPid, leaseExpiresAt: lease.expiresAt, observedAt: nowIso() };
        } else if (!lease.ownerPid) {
          isStale = true;
          staleReason = "lease expired with no owner pid";
          cause = { kind: "stale_runtime_reconciled", failureReason: "lease_expired_owner_pid_missing", phase: job.phase, jobId: job.jobId, leaseId: job.leaseId, leaseExpiresAt: lease.expiresAt, observedAt: nowIso() };
        }
      }
    }

    // Tier 3: Activity fallback
    if (!isStale && job.status === "running") {
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

    if (!isStale) continue;

    // Attach session pin from process registry
    if (processEntry?.sessionPin) {
      cause = cause || {};
      cause.sessionPin = processEntry.sessionPin;
    }

    if (dryRun) {
      recovered.push({ jobId: job.jobId, project: job.project, reason: staleReason, dryRun: true });
      continue;
    }

    try {
      await failJob(cpbRoot, job.project, job.jobId, {
        reason: `stale_runtime_reconciled: ${staleReason}`,
        code: "FATAL",
        phase: cause?.phase || job.phase,
        cause,
        dataRoot: job.__dataRoot,
      });
      recovered.push({ jobId: job.jobId, project: job.project, reason: staleReason });

      // Clean up queue entry
      const matched = findMatchingQueueEntry(queueEntries, job);
      if (matched) {
        try {
          await updateQueueEntry(hubRoot, matched.id, {
            status: "failed",
            claimedBy: null,
            claimedAt: null,
            workerId: null,
            metadata: { failureCode: "FATAL", failureReason: cause?.failureReason, reconciledJobId: job.jobId },
          });
        } catch { /* best-effort */ }
      }

      // Clean up process entry
      if (processEntry) {
        try { await removeProcess(cpbRoot, job.jobId, { dataRoot: processEntry.__dataRoot || job.__dataRoot }); } catch { /* best-effort */ }
      }

      // Clean up lease file
      if (job.leaseId) {
        try {
          const leasesDir = path.join(job.__dataRoot, "leases");
          await rm(path.join(leasesDir, `${job.leaseId}.json`), { force: true });
          try { await rm(path.join(leasesDir, `${job.leaseId}.json.lock`), { recursive: true, force: true }); } catch {}
        } catch { /* best-effort */ }
      }
    } catch (err) {
      failed.push({ jobId: job.jobId, project: job.project, error: err.message });
    }
  }

  return { recovered, failed };
}

export async function reconcileJobs(cpbRoot, { dryRun = false, ...options }: Record<string, any> = {}) {
  const streamRecoveries = [];
  const report: Record<string, any> = {
    staleJobs: [],
    orphanLeases: [],
    streamRecoveries,
    streamRepairs: streamRecoveries,
    streamErrors: [],
    indexRebuilt: false,
    workers: { stale: [] },
    reconciledProcesses: [],
    reconciledQueueEntries: [],
  };

  const roots = await cleanupRuntimeRoots(cpbRoot, options);
  const jobs = await listJobsForCleanup(cpbRoot, options);
  const now = new Date();

  const processEntries = await listProcessesForCleanup(cpbRoot, options);
  const processByJobId = new Map();
  for (const pe of processEntries) {
    if (pe.jobId) processByJobId.set(pe.jobId, pe);
  }

  const hubRoot = resolvedHubRoot(cpbRoot, options);
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
      const lease = await readLease(cpbRoot, job.leaseId, { dataRoot: job.__dataRoot });
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
      const jobReport: Record<string, any> = {
        jobId: job.jobId,
        project: job.project,
        reason: staleReason,
        worktree: job.worktree || null,
        dataRoot: job.__dataRoot || null,
      };
      if (cause) {
        jobReport.failureReason = cause.failureReason;
        jobReport.failureArtifact = failureArtifact;
      }
      // Attach session pin from process registry for retry consumption
      if (processEntry && processEntry.sessionPin) {
        cause = cause || {};
        cause.sessionPin = processEntry.sessionPin;
        jobReport.sessionPin = processEntry.sessionPin;
      }
      report.staleJobs.push(jobReport);

      if (dryRun) {
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
            dataRoot: job.__dataRoot || null,
          });
        }
      } else {
        try {
          await failJob(cpbRoot, job.project, job.jobId, {
            reason: `stale_runtime_reconciled: ${staleReason}`,
            code: "FATAL",
            phase: cause?.phase || job.phase,
            cause,
            dataRoot: job.__dataRoot,
          });
        } catch (err) {
          if (err.message?.includes("job is terminal") || err.message?.includes("job not found")) {
            jobReport.skipped = true;
            jobReport.skipReason = err.message;
          } else {
            throw err;
          }
        }

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

        if (processEntry) {
          try {
            await removeProcess(cpbRoot, job.jobId, { dataRoot: processEntry.__dataRoot || job.__dataRoot });
            report.reconciledProcesses.push({ jobId: job.jobId, removed: true });
          } catch {
            report.reconciledProcesses.push({ jobId: job.jobId, removed: false, error: "cleanup failed" });
          }
        }

        if (job.leaseId) {
          try {
            const leasesDir = path.join(job.__dataRoot, "leases");
            await rm(path.join(leasesDir, `${job.leaseId}.json`), { force: true });
            try { await rm(path.join(leasesDir, `${job.leaseId}.json.lock`), { recursive: true, force: true }); } catch {}
          } catch {}
        }
      }
    }
  }

  // 2. Detect orphan leases
  const activeJobIds = new Set(jobs.map((j) => j.jobId));
  for (const root of roots) {
    const leasesDir = path.join(root.dataRoot, "leases");
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
          dataRoot: root.dataRoot,
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
      const { saveRegistry } = await import("../hub/hub-registry.js");
      await saveRegistry(hubRoot, registry);
    }
  }

  // 3b. Prune exited workers from registry
  try {
    const { WorkerStore } = await import("../../../shared/orchestrator/worker-store.js");
    const store = new WorkerStore(hubRoot);
    await store.init();
    const pruned = dryRun ? 0 : await store.pruneDead();
    if (pruned > 0) {
      report.workers.pruned = pruned;
    }
  } catch { /* hub not initialized */ }

  // 4. Validate and recover JSONL event streams
  for (const root of roots) {
    const eventFiles = await listEventFiles(cpbRoot, { dataRoot: root.dataRoot, includeLegacyFallback: false });
    for (const { project, jobId } of eventFiles) {
      const result = await validateEventStream(cpbRoot, project, jobId, { dryRun, dataRoot: root.dataRoot });
      if (result.error) {
        report.streamErrors.push({
          project,
          jobId,
          file: result.error.file,
          lineNumber: result.error.lineNumber,
          reason: result.error.reason,
        });
      } else if (result.recovered || result.wouldRecover || result.wouldRepair) {
        report.streamRecoveries.push({
          project,
          jobId,
          wouldRecover: result.wouldRecover || false,
          wouldRepair: result.wouldRepair || false,
          repaired: result.repaired || false,
        });
      }
    }
  }

  // 5. Rebuild jobs-index from authoritative state (only when no stream errors)
  if (!dryRun && report.streamErrors.length === 0) {
    for (const root of roots) {
      await rebuildJobsIndex(cpbRoot, { dataRoot: root.dataRoot, includeLegacyFallback: false });
      report.indexRebuilt = true;
    }
  }

  // 6. Clean up test/fixture pollution and orphan runtime dirs
  if (dryRun) {
    try {
      const preview = await cleanupDryRun(cpbRoot, options);
      report.pollutionPreview = {
        testProjectsToRemove: preview.testProjectsToRemove?.length || 0,
        orphanRuntimeDirsToRemove: preview.orphanRuntimeDirsToRemove?.length || 0,
        candidates: preview.testProjectsToRemove,
        orphanDirs: preview.orphanRuntimeDirsToRemove,
      };
    } catch {}
  } else if (options.cleanupPollution === true) {
    try {
      report.pollution = await cleanupPollution(cpbRoot, options);
    } catch {}
  }

  return report;
}

export async function cleanupDryRun(cpbRoot, options: Record<string, any> = {}) {
  const report = {
    leasesToRemove: [],
    worktreesPreserved: [],
    totalLeaseFiles: 0,
    totalJobCount: 0,
    testProjectsToRemove: [],
    pollutedProjectsToRemove: [],
    orphanRuntimeDirsToRemove: [],
  };

  const roots = await cleanupRuntimeRoots(cpbRoot, options);
  const jobs = await listJobsForCleanup(cpbRoot, options);
  report.totalJobCount = jobs.length;

  const terminalLeaseIds = new Set(
    jobs.filter((j) => TERMINAL_STATUSES.has(j.status) && j.leaseId).map((j) => j.leaseId)
  );
  const terminalJobIds = new Set(
    jobs.filter((j) => TERMINAL_STATUSES.has(j.status)).map((j) => j.jobId)
  );

  for (const root of roots) {
    const leasesDir = path.join(root.dataRoot, "leases");
    let leaseFiles;
    try {
      leaseFiles = await readdir(leasesDir);
    } catch {
      leaseFiles = [];
    }
    report.totalLeaseFiles += leaseFiles.filter((f) => f.endsWith(".json")).length;

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
  const hubRoot = resolvedHubRoot(cpbRoot, options);
  try {
    const pollution = await scanHubPollution(hubRoot);
    report.testProjectsToRemove = pollution.candidates;
    report.orphanRuntimeDirsToRemove = pollution.orphanRuntimeDirs;
  } catch {}

  return report;
}

export async function cleanupJobs(cpbRoot, options: Record<string, any> = {}) {
  const roots = await cleanupRuntimeRoots(cpbRoot, options);
  const jobs = await listJobsForCleanup(cpbRoot, options);
  const terminal = new Set(["completed", "failed", "blocked", "cancelled"]);
  const terminalJobIds = new Set(
    jobs.filter((j) => terminal.has(j.status)).map((j) => j.jobId)
  );
  const terminalLeaseIds = new Set(
    jobs.filter((j) => terminal.has(j.status) && j.leaseId).map((j) => j.leaseId)
  );

  let cleaned = 0;
  for (const root of roots) {
    const leasesDir = path.join(root.dataRoot, "leases");
    let files;
    try {
      files = await readdir(leasesDir);
    } catch {
      files = [];
    }
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
  }

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

  if (targetResolved === hubResolved) {
    return { canDelete: false, reason: "hub-root" };
  }
  if (targetResolved === hubProjectsResolved) {
    return { canDelete: false, reason: "hub-projects-root" };
  }
  if (sourceResolved && targetResolved === sourceResolved) {
    return { canDelete: false, reason: "source-path-preserved" };
  }
  if (sourceResolved && targetResolved !== sourceResolved &&
      sourceResolved.startsWith(targetResolved + path.sep)) {
    return { canDelete: false, reason: "source-path-ancestor" };
  }

  const pid = projectId || project.id;
  if (!pid) return { canDelete: false, reason: "no-project-id" };
  const expectedRoot = projectRuntimeRoot(hubRoot, pid);

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

  if (targetResolved === expectedRoot) {
    return { canDelete: true, reason: "exact-expected-root" };
  }
  if (targetResolved.startsWith(expectedRoot + path.sep)) {
    return { canDelete: true, reason: "child-of-expected-root" };
  }

  return { canDelete: false, reason: "unsafe-runtime-root" };
}

export async function cleanupPollution(cpbRoot, options: Record<string, any> = {}) {
  const hubRoot = resolvedHubRoot(cpbRoot, options);
  let projectsRemoved = 0;
  let orphanDirsRemoved = 0;
  const sourcePathsPreserved = [];
  const unsafeProjectsSkipped = [];
  const errors = [];

  const pollution = await scanHubPollution(hubRoot);
  const registry = await loadRegistry(hubRoot);

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

// ── worktree-retention ──
import { mkdir, rename } from "node:fs/promises";

const COMPLETED_ACTIONS = new Set(["preserve", "delete", "archive"]);

// ── Workflow-aware retention policies ──
// Maps workflow names to per-status retention actions.
// Unrecognized workflows fall through to DEFAULT_WORKFLOW_RETENTION.
const DEFAULT_WORKFLOW_RETENTION: Record<string, string> = {
  completed: "preserve",
  failed: "preserve",
  blocked: "preserve",
  cancelled: "preserve",
};

const WORKFLOW_RETENTION_POLICIES: Record<string, Record<string, string>> = {
  standard: { completed: "preserve", failed: "preserve" },
  pipeline: { completed: "delete", failed: "preserve" },
  research: { completed: "archive", failed: "preserve" },
  "multi-evolve": { completed: "delete", failed: "preserve" },
  "dual-research": { completed: "archive", failed: "preserve" },
};

export function resolveRetentionPolicy(workflow: string | null | undefined, status: string): string {
  const policies = (workflow && WORKFLOW_RETENTION_POLICIES[workflow]) || null;
  const action = policies?.[status];
  if (action && COMPLETED_ACTIONS.has(action)) return action;
  return DEFAULT_WORKFLOW_RETENTION[status] || "preserve";
}

function normalizePolicy(cpbRoot, policy: Record<string, any> = {}) {
  // completed: null means "not specified, use workflow-aware default"
  const completed = policy.completed != null && COMPLETED_ACTIONS.has(policy.completed)
    ? policy.completed
    : null;
  return {
    completed,
    archiveRoot: path.resolve(policy.archiveRoot || runtimeDataPath(cpbRoot, "worktree-archive")),
  };
}

function archivePathFor(policy, worktree) {
  return path.join(policy.archiveRoot, path.basename(worktree));
}

function entryForJob(job, policy): Record<string, any> {
  const workflow = job.workflow || null;
  const base: Record<string, any> = {
    jobId: job.jobId,
    project: job.project || null,
    status: job.status || "unknown",
    workflow,
    worktree: job.worktree,
    branch: job.worktreeBranch || null,
    baseBranch: job.worktreeBaseBranch || null,
    action: "preserve",
    reason: "worktree retained by default",
  };

  // Determine action: explicit policy.completed overrides workflow-aware defaults
  const status = job.status || "unknown";
  if (status === "completed") {
    // policy.completed is null when not explicitly set -> use workflow-aware lookup
    const action = policy.completed || resolveRetentionPolicy(workflow, status);

    if (action === "delete") {
      return { ...base, action: "delete", reason: `completed job worktree (workflow: ${workflow || "unknown"}) selected by policy: delete` };
    }
    if (action === "archive") {
      return { ...base, action: "archive", archivePath: archivePathFor(policy, job.worktree), reason: `completed job worktree (workflow: ${workflow || "unknown"}) selected by policy: archive` };
    }
    return { ...base, reason: `completed job worktree (workflow: ${workflow || "unknown"}) preserved by policy` };
  }

  if (status === "failed" || status === "blocked") {
    return { ...base, reason: `${status} job worktree retained for inspection by default` };
  }

  return { ...base, reason: `${status} job worktree retained because it is not completed` };
}

export async function buildWorktreeRetentionPlan(cpbRoot, { policy = {}, dryRun = true, ...options }: Record<string, any> = {}) {
  const normalizedPolicy = normalizePolicy(cpbRoot, policy);
  const jobs = await listJobsForCleanup(cpbRoot, options);

  // Build a set of worktree paths that have associated jobs
  const worktreeByPath = new Map<string, any>();
  for (const job of jobs) {
    if (job.jobId && job.worktree) {
      worktreeByPath.set(path.resolve(job.worktree), job);
    }
  }

  // Orphan detection: scan worktrees directory for dirs not associated with any job
  const orphans: Record<string, any>[] = [];
  for (const job of jobs) {
    // Derive the worktrees parent directory from any known worktree path
    if (!job.worktree) continue;
    const parentDir = path.dirname(job.worktree);
    let subdirs: string[];
    try {
      subdirs = await readdir(parentDir);
    } catch {
      continue;
    }
    for (const subdir of subdirs) {
      const candidatePath = path.join(parentDir, subdir);
      let isDir: boolean;
      try {
        isDir = (await stat(candidatePath)).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const resolved = path.resolve(candidatePath);
      if (!worktreeByPath.has(resolved)) {
        orphans.push({
          worktree: candidatePath,
          action: "delete",
          reason: "orphan worktree: no associated job found",
        });
      }
    }
    // Only scan the first valid parent directory to avoid redundant scans
    break;
  }

  // Build entries from jobs with worktrees
  const entries = jobs
    .filter((job) => job.jobId && job.worktree)
    .map((job) => entryForJob(job, normalizedPolicy))
    .sort((a, b) => a.worktree.localeCompare(b.worktree)) as Array<Record<string, any>>;

  // Append orphan entries
  const orphanEntries = orphans.sort((a, b) => a.worktree.localeCompare(b.worktree));
  const allEntries = [...entries, ...orphanEntries];

  return {
    dryRun: Boolean(dryRun),
    policy: normalizedPolicy,
    entries: allEntries,
    orphans: orphanEntries,
    summary: {
      total: allEntries.length,
      delete: allEntries.filter((entry) => entry.action === "delete").length,
      archive: allEntries.filter((entry) => entry.action === "archive").length,
      preserve: allEntries.filter((entry) => entry.action === "preserve").length,
      orphanCount: orphanEntries.length,
    },
  };
}

export async function cleanupWorktrees(cpbRoot, { policy = {}, dryRun = true, ...options }: Record<string, any> = {}) {
  const plan = await buildWorktreeRetentionPlan(cpbRoot, { policy, dryRun, ...options });
  if (plan.dryRun) return plan;

  const results = [];
  for (const entry of plan.entries) {
    if (entry.action === "delete") {
      await rm(entry.worktree, { recursive: true, force: true });
      results.push({ ...entry, result: "deleted" });
    } else if (entry.action === "archive") {
      await mkdir(path.dirname(entry.archivePath), { recursive: true });
      await rename(entry.worktree, entry.archivePath);
      results.push({ ...entry, result: "archived" });
    } else {
      results.push({ ...entry, result: "preserved" });
    }
  }

  return { ...plan, entries: results };
}

export function formatWorktreeRetentionHuman(plan) {
  const lines = [
    plan.dryRun ? "CodePatchBay Worktree Cleanup (dry-run)" : "CodePatchBay Worktree Cleanup",
    "",
  ];

  if (plan.entries.length === 0) {
    lines.push("No job worktrees found.");
    return `${lines.join("\n")}\n`;
  }

  for (const entry of plan.entries) {
    const target = entry.action === "archive" ? ` -> ${entry.archivePath}` : "";
    lines.push(`${entry.action.toUpperCase()} ${entry.worktree}${target}`);
    lines.push(`  job: ${entry.jobId} status: ${entry.status}`);
    lines.push(`  reason: ${entry.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

// ── backlog-hygiene ──
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HYGIENE_TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "superseded"]);

function isTerminalJob(job) {
  return HYGIENE_TERMINAL_STATUSES.has(job.status);
}

function issueKey(repo, number) {
  return `${repo}#${number}`;
}

function isStale(timestamp) {
  if (!timestamp) return false;
  return Date.now() - new Date(timestamp).getTime() > STALE_THRESHOLD_MS;
}

async function runGh(args, { runCommand = execFileAsync } = {}) {
  const result = await runCommand("gh", args, {
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
  });
  return typeof result === "string" ? result : result.stdout;
}

async function listIssueComments({ repo, issueNumber }, { runCommand = execFileAsync } = {}) {
  const stdout = await runGh([
    "issue", "view", String(issueNumber),
    "--repo", repo,
    "--json", "comments",
    "--jq", ".comments[] | {id: .id, author: .author.login, body: .body, createdAt: .createdAt}",
  ], { runCommand });
  try {
    return JSON.parse(`[${stdout.trim().split("\n").filter(Boolean).join(",")}]`);
  } catch {
    return [];
  }
}

export function isCpbComment(body) {
  if (!body) return false;
  return body.includes("CodePatchBay queued this issue.")
    || body.includes("CodePatchBay failed this run.")
    || body.includes("CodePatchBay blocked this run.")
    || body.includes("CodePatchBay updated this run.")
    || body.includes("Verified patch ready.")
    || body.includes("Draft PR opened.")
    || body.includes("<!-- cpb-stale-marker -->");
}

export function parseCpbCommentMeta(body) {
  const meta = { kind: null, jobId: null, status: null };
  if (!body) return meta;

  const jobMatch = body.match(/- Job:\s*(\S+)/);
  if (jobMatch) meta.jobId = jobMatch[1];

  if (body.includes("CodePatchBay queued this issue.")) {
    meta.kind = "queued";
  } else if (body.includes("CodePatchBay failed this run.")) {
    meta.kind = "terminal";
    meta.status = "failed";
  } else if (body.includes("CodePatchBay blocked this run.")) {
    meta.kind = "terminal";
    meta.status = "blocked";
  } else if (body.includes("Verified patch ready.")) {
    meta.kind = "terminal";
    meta.status = "passed";
  } else if (body.includes("Draft PR opened.")) {
    meta.kind = "terminal";
    meta.status = "pr-opened";
  } else if (body.includes("CodePatchBay updated this run.")) {
    meta.kind = "update";
  } else if (body.includes("<!-- cpb-stale-marker -->")) {
    meta.kind = "already-marked";
  }

  return meta;
}

export function buildStaleMarkerComment({ jobId, supersededBy, reason }) {
  const lines = [
    "<!-- cpb-stale-marker -->",
    "> **CPB run superseded**",
    "",
  ];
  if (jobId) lines.push(`> Original job: \`${jobId}\``);
  if (supersededBy) lines.push(`> Superseded by: \`${supersededBy}\``);
  if (reason) lines.push(`> Reason: ${reason}`);
  lines.push("", "This run's outcome is no longer current. See the latest CPB comment on this issue for the active run.");
  return lines.join("\n");
}

export function buildSupersededIssueCloseComment({ queueEntryId, supersededByQueueEntryId, reason }) {
  return [
    "### Issue superseded by newer CPB run",
    "",
    `This issue has been superseded. ${reason || "A newer run has replaced the original task."}`,
    "",
    supersededByQueueEntryId ? `- Replacement queue entry: \`${supersededByQueueEntryId}\`` : null,
    queueEntryId ? `- Original queue entry: \`${queueEntryId}\`` : null,
    "",
    "Closing to reduce backlog noise. If this was closed in error, re-open with a new `/cpb run` command.",
    "",
  ].filter((line) => line !== null).join("\n");
}

export async function scanStaleComments(cpbRoot, hubRoot, { dryRun = false, repo = null, runCommand = execFileAsync } = {}) {
  const jobs = await listJobsForCleanup(cpbRoot, { hubRoot });
  const queueEntries = await listHubQueue(hubRoot);
  const { readGithubIssues } = await import("../github/github-issues.js");
  const githubIssues = await readGithubIssues(hubRoot);

  const jobsByIssue = new Map();
  for (const job of jobs) {
    if (!isTerminalJob(job)) continue;
    const source = job.sourceContext || {};
    if (source.type !== "github_issue" && source.issueNumber === undefined) continue;
    const r = source.repo || source.repository;
    const n = source.issueNumber;
    if (!r || n === undefined || n === null) continue;
    const key = issueKey(r, n);
    const list = jobsByIssue.get(key) || [];
    list.push(job);
    jobsByIssue.set(key, list);
  }

  const queueByJobId = new Map();
  const supersededEntries = [];
  for (const entry of queueEntries) {
    const m = entry.metadata || {};
    if (m.jobId) queueByJobId.set(m.jobId, entry);
    if (m.originJobId) queueByJobId.set(m.originJobId, entry);
    if (m.finalDisposition?.startsWith("superseded") || m.finalDisposition?.startsWith("rejected")) {
      supersededEntries.push(entry);
    }
  }

  const report = {
    issuesScanned: 0,
    staleComments: [],
    supersededIssues: [],
    errors: [],
  };

  const targetIssues = repo
    ? githubIssues.filter((i) => (i.repository || (i as Record<string, any>).repo) === repo && i.state !== "CLOSED")
    : githubIssues.filter((i) => i.state !== "CLOSED");

  for (const issue of targetIssues) {
    const r = issue.repository || (issue as Record<string, any>).repo;
    const n = issue.number;
    if (!r || !n) continue;

    report.issuesScanned++;
    const key = issueKey(r, n);
    const issueJobs = jobsByIssue.get(key) || [];

    if (issueJobs.length === 0) continue;
    const hasActiveRun = issueJobs.some((j) => !isTerminalJob(j));
    if (hasActiveRun) continue;

    let comments;
    try {
      comments = await listIssueComments({ repo: r, issueNumber: n }, { runCommand });
    } catch (err) {
      report.errors.push({ repo: r, issueNumber: n, phase: "fetch_comments", message: err.message });
      continue;
    }

    const cpbComments = comments
      .map((c) => ({ ...c, meta: parseCpbCommentMeta(c.body) }))
      .filter((c) => isCpbComment(c.body) || c.meta.kind === "already-marked");

    if (cpbComments.length === 0) continue;

    const terminalComments = cpbComments.filter((c) => c.meta.kind === "terminal");
    const latestTerminal = terminalComments.length > 0
      ? terminalComments[terminalComments.length - 1]
      : null;

    const alreadyMarkedIds = new Set(
      cpbComments.filter((c) => c.meta.kind === "already-marked").map((c) => c.id),
    );

    const staleCandidates = cpbComments.filter((c) => {
      if (c.meta.kind === "already-marked") return false;
      if (alreadyMarkedIds.has(c.id)) return false;
      if (c.meta.kind === "queued" && terminalComments.length > 0) return true;
      if (c.meta.kind === "terminal" && latestTerminal && c.id !== latestTerminal.id) return true;
      return false;
    });

    for (const stale of staleCandidates) {
      const supersededBy = latestTerminal?.meta?.jobId || null;
      const reason = latestTerminal
        ? `Superseded by ${latestTerminal.meta.status} run`
        : "Run no longer active";

      report.staleComments.push({
        repo: r,
        issueNumber: n,
        commentId: stale.id,
        commentKind: stale.meta.kind,
        jobId: stale.meta.jobId,
        supersededByJobId: supersededBy,
        reason,
      });

      if (!dryRun) {
        try {
          const body = buildStaleMarkerComment({
            jobId: stale.meta.jobId,
            supersededBy,
            reason,
          });
          await runGh([
            "issue", "comment", String(n),
            "--repo", r,
            "--body", body,
          ], { runCommand });
        } catch (err) {
          report.errors.push({
            repo: r,
            issueNumber: n,
            phase: "mark_stale_comment",
            commentId: stale.id,
            message: err.message,
          });
        }
      }
    }

    const matchingSuperseded = supersededEntries.filter((entry) => {
      const m = entry.metadata || {};
      return m.repo === r && Number(m.issueNumber) === n;
    });

    for (const entry of matchingSuperseded) {
      const m = entry.metadata || {};
      const supersededByQueueId = m.supersededByQueueEntryId || m.supersededByJobId || null;
      const reason = m.finalDisposition || "superseded";

      if (!isStale(entry.updatedAt || entry.createdAt)) continue;

      report.supersededIssues.push({
        repo: r,
        issueNumber: n,
        queueEntryId: entry.id,
        supersededByQueueEntryId: supersededByQueueId,
        reason,
      });

      if (!dryRun) {
        try {
          const { closeGithubIssueWithGh } = await import("../github/github-issues.js");
          const body = buildSupersededIssueCloseComment({
            queueEntryId: entry.id,
            supersededByQueueEntryId: supersededByQueueId,
            reason,
          });
          await closeGithubIssueWithGh({ repo: r, number: n, body }, { runCommand });
        } catch (err) {
          report.errors.push({
            repo: r,
            issueNumber: n,
            phase: "close_superseded_issue",
            message: err.message,
          });
        }
      }
    }
  }

  return report;
}

export async function runBacklogHygiene(cpbRoot, { dryRun = false, repo = null, runCommand = execFileAsync } = {}) {
  const hubRoot = resolvedHubRoot(cpbRoot);
  return scanStaleComments(cpbRoot, hubRoot, { dryRun, repo, runCommand });
}
