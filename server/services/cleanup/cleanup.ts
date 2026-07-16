// ── reconcile ──
import { lstat, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord, recordValue, type LooseRecord } from "../../../core/contracts/types.js";
import { listRuntimeDataRoots, resolveProjectDataRoot, runtimeDataPath, runtimeDataRoot } from "../runtime.js";
import { eventFileFor, listEventFiles, readEvents, materializeJob, recoverEventFile } from "../event/event-store.js";
import { appendEvent } from "../event/event-store.js";
import { readLease, releaseLease, isLeaseStale } from "../infra.js";
import { listJobs, failJob, blockJob } from "../job/job-store.js";
import { rebuildJobsIndex, readJobsIndex } from "../job/job-store.js";
import { resolveHubRoot, loadRegistry, mutateRegistry } from "../hub/hub-registry.js";
import { projectRuntimeRoot } from "../runtime.js";
import { listProcesses, classifyLiveness, removeProcess } from "../infra.js";
import { listQueue as listHubQueue, updateEntry as updateQueueEntry } from "../hub/hub-queue.js";
import { scanHubPollution, isUnderTestPath } from "../project/project-index.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "");
}

function stringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

type CleanupOptions = LooseRecord & {
  hubRoot?: string;
  dataRoot?: string;
  project?: string | null;
  legacyOnly?: boolean;
  includeLegacyFallback?: boolean;
  cleanupPollution?: boolean;
};

type CleanupProject = LooseRecord & {
  id?: string;
  sourcePath?: string;
  projectRuntimeRoot?: string;
};

type CleanupRegistry = LooseRecord & {
  projects: Record<string, CleanupProject>;
};

type PollutionRuntimeTargetInput = {
  hubRoot: string;
  project: CleanupProject;
  projectId?: string;
  registry: CleanupRegistry;
};

type PollutionSkip = {
  projectId: string;
  attemptedRoot: string | null;
  reason: string;
};

type CleanupPollutionError = {
  kind?: string;
  projectId?: string;
  dir?: string;
  phase?: string;
  message: string;
};

type CleanupPollutionReport = {
  projectsRemoved: number;
  orphanDirsRemoved: number;
  sourcePathsPreserved: Array<string | undefined>;
  unsafeProjectsSkipped: PollutionSkip[];
  errors: CleanupPollutionError[];
};

type RuntimeRootEntry = LooseRecord & {
  kind?: string;
  dataRoot: string;
  projectId?: string | null;
};

type CleanupJob = LooseRecord & {
  jobId?: string;
  project?: string;
  task?: string;
  status?: string;
  phase?: string;
  leaseId?: string;
  worktree?: string;
  worktreeBranch?: string | null;
  worktreeBaseBranch?: string | null;
  workflow?: string | null;
  lastActivityAt?: string | null;
  sourceContext?: LooseRecord | null;
  __dataRoot?: string;
};

type ProcessEntry = LooseRecord & {
  id?: string;
  jobId?: string;
  status?: string;
  phase?: string;
  leaseId?: string;
  runnerPid?: number;
  lastHeartbeat?: string;
  sessionPin?: LooseRecord & {
    sessionId?: string;
    phase?: string;
  };
  __dataRoot?: string;
};

type QueueEntry = LooseRecord & {
  id?: string;
  status?: string;
  projectId?: string;
  description?: string;
  updatedAt?: string;
  createdAt?: string;
  metadata?: LooseRecord;
};

type LeaseRecord = LooseRecord & {
  jobId?: string;
  phase?: string;
  ownerPid?: number;
  expiresAt?: string;
};

type StaleCause = LooseRecord & {
  failureReason?: string;
  phase?: string;
  jobId?: string;
  leaseId?: string;
  observedAt?: string;
  sessionPin?: unknown;
};

type EventValidationResult = {
  valid: boolean;
  events: LooseRecord[] | null;
  recovered: boolean;
  repaired: boolean;
  wouldRecover?: boolean;
  wouldRepair: boolean;
  recoveryResult?: unknown;
  error: { file: string; lineNumber: number; reason: string } | null;
};

type ReconcileStaleJobReport = LooseRecord & {
  jobId?: string;
  project?: string;
  reason: string;
};

type ReconcileReport = LooseRecord & {
  staleJobs: ReconcileStaleJobReport[];
  orphanLeases: LooseRecord[];
  streamRecoveries: LooseRecord[];
  streamRepairs: LooseRecord[];
  streamErrors: LooseRecord[];
  indexRebuilt: boolean;
  workers: LooseRecord & { stale: LooseRecord[]; pruned?: number };
  reconciledProcesses: LooseRecord[];
  reconciledQueueEntries: LooseRecord[];
  pollutionPreview?: LooseRecord;
  pollution?: unknown;
};

type CleanupDryRunReport = LooseRecord & {
  leasesToRemove: string[];
  worktreesPreserved: LooseRecord[];
  totalLeaseFiles: number;
  totalJobCount: number;
  testProjectsToRemove: unknown[];
  pollutedProjectsToRemove: unknown[];
  orphanRuntimeDirsToRemove: unknown[];
};

function findMatchingQueueEntry(queueEntries: QueueEntry[], job: CleanupJob) {
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

function isProcessAlive(pid: number) {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (errorCode(err) === "EPERM") return true;
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function resolvedHubRoot(cpbRoot: string, options: CleanupOptions = {}) {
  return options.hubRoot ? path.resolve(options.hubRoot) : resolveHubRoot(cpbRoot);
}

async function cleanupRuntimeRoots(cpbRoot: string, options: CleanupOptions = {}): Promise<RuntimeRootEntry[]> {
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

async function listJobsForCleanup(cpbRoot: string, options: CleanupOptions = {}): Promise<CleanupJob[]> {
  const roots = await cleanupRuntimeRoots(cpbRoot, options);
  const jobs: CleanupJob[] = [];
  const seen = new Set<string>();
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

async function listProcessesForCleanup(cpbRoot: string, options: CleanupOptions = {}): Promise<ProcessEntry[]> {
  const roots = await cleanupRuntimeRoots(cpbRoot, options);
  const entries: ProcessEntry[] = [];
  const seen = new Set<string>();
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

async function eventOptionsForProject(cpbRoot: string, project: string, options: CleanupOptions = {}) {
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

export async function validateEventStream(cpbRoot: string, project: string, jobId: string, { dryRun = false, ...options }: CleanupOptions & { dryRun?: boolean } = {}): Promise<EventValidationResult> {
  const events: LooseRecord[] = [];
  let raw;
  const eventOptions = await eventOptionsForProject(cpbRoot, project, options);
  const file = eventFileFor(cpbRoot, project, jobId, eventOptions);

  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return { valid: true, events: [], recovered: false, repaired: false, wouldRepair: false, error: null };
    }
    throw err;
  }

  if (raw.length === 0) {
    return { valid: true, events: [], recovered: false, repaired: false, wouldRepair: false, error: null };
  }

  const hasTrailingNewline = raw.endsWith("\n");
  const lines = raw.split("\n");
  const nonEmpty = lines.map((line: string, idx: number) => ({ line, lineNumber: idx + 1 }))
    .filter(({ line }: { line: string }) => line.trim().length > 0);

  for (let i = 0; i < nonEmpty.length; i++) {
    const { line, lineNumber } = nonEmpty[i];
    const isLast = i === nonEmpty.length - 1;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      if (isLast && !hasTrailingNewline) {
        const recoveredEvents = nonEmpty.slice(0, i).map(({ line: l }: { line: string }) => JSON.parse(l));
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
    if (!isRecord(event)) {
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
export async function recoverOrphanedJobs(cpbRoot: string, options: CleanupOptions & { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun || false;
  const recovered: LooseRecord[] = [];
  const failed: LooseRecord[] = [];

  const jobs = await listJobsForCleanup(cpbRoot, options);
  const processEntries = await listProcessesForCleanup(cpbRoot, options);
  const processByJobId = new Map<string, ProcessEntry>();
  for (const pe of processEntries) {
    if (pe.jobId) processByJobId.set(pe.jobId, pe);
  }

  const hubRoot = resolvedHubRoot(cpbRoot, options);
  let queueEntries: QueueEntry[] = [];
  try { queueEntries = await listHubQueue(hubRoot); } catch {}

  const now = new Date();
  const runningJobs = jobs.filter(
    (j) => !TERMINAL_STATUSES.has(j.status || "") && j.jobId
  );

  for (const job of runningJobs) {
    let isStale = false;
    let staleReason = "";
    let cause: StaleCause | null = null;
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
      let lease: LeaseRecord | null = null;
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
      failed.push({ jobId: job.jobId, project: job.project, error: errorMessage(err) });
    }
  }

  return { recovered, failed };
}

export async function reconcileJobs(cpbRoot: string, { dryRun = false, ...options }: CleanupOptions & { dryRun?: boolean } = {}) {
  const streamRecoveries: LooseRecord[] = [];
  const report: ReconcileReport = {
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
  const processByJobId = new Map<string, ProcessEntry>();
  for (const pe of processEntries) {
    if (pe.jobId) processByJobId.set(pe.jobId, pe);
  }

  const hubRoot = resolvedHubRoot(cpbRoot, options);
  let queueEntries: QueueEntry[] = [];
  try { queueEntries = await listHubQueue(hubRoot); } catch {}

  // 1. Detect stale running jobs
  const runningJobs = jobs.filter(
    (j) => !TERMINAL_STATUSES.has(j.status || "") && j.jobId
  );

  for (const job of runningJobs) {
    let isStale = false;
    let staleViaProcessOrphan = false;
    let staleReason = "";
    let cause: StaleCause | null = null;
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
      const jobReport: ReconcileStaleJobReport = {
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
    let leaseFiles: string[];
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
      }
    }

    if (!dryRun && report.workers.stale.length > 0) {
      await mutateRegistry(hubRoot, (currentRegistry) => {
        for (const stale of report.workers.stale) {
          const project = currentRegistry.projects[stale.project];
          const worker = project?.worker;
          if (
            worker?.workerId === stale.workerId
            && worker.pid === stale.pid
            && worker.lastSeenAt === stale.lastSeenAt
          ) {
            project.worker = null;
          }
        }
      });
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

export async function cleanupDryRun(cpbRoot: string, options: CleanupOptions = {}) {
  const report: CleanupDryRunReport = {
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
    let leaseFiles: string[];
    try {
      leaseFiles = await readdir(leasesDir);
    } catch {
      leaseFiles = [];
    }
    report.totalLeaseFiles += leaseFiles.filter((f: string) => f.endsWith(".json")).length;

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

export async function cleanupJobs(cpbRoot: string, options: CleanupOptions = {}) {
  const roots = await cleanupRuntimeRoots(cpbRoot, options);
  const jobs = await listJobsForCleanup(cpbRoot, options);
  const terminal = new Set(["completed", "failed", "blocked", "cancelled"]);
  const terminalJobIds = new Set(
    jobs.filter((j) => terminal.has(j.status || "")).map((j) => j.jobId)
  );
  const terminalLeaseIds = new Set(
    jobs.filter((j) => terminal.has(j.status || "") && j.leaseId).map((j) => j.leaseId)
  );

  let cleaned = 0;
  for (const root of roots) {
    const leasesDir = path.join(root.dataRoot, "leases");
    let files: string[];
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
function safePollutionRuntimeTarget({ hubRoot, project, projectId, registry }: PollutionRuntimeTargetInput) {
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
      const otherId = isRecord(other) && typeof other.id === "string" ? other.id : null;
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

export async function cleanupPollution(cpbRoot: string, options: CleanupOptions = {}): Promise<CleanupPollutionReport> {
  const hubRoot = resolvedHubRoot(cpbRoot, options);
  let projectsRemoved = 0;
  let orphanDirsRemoved = 0;
  const sourcePathsPreserved: Array<string | undefined> = [];
  const unsafeProjectsSkipped: PollutionSkip[] = [];
  const errors: CleanupPollutionError[] = [];
  const runtimeTargets: Array<{ projectId: string; runtimeRoot: string }> = [];

  const pollution = await scanHubPollution(hubRoot);

  if (pollution.candidates.length > 0) {
    projectsRemoved = await mutateRegistry(hubRoot, async (registry) => {
      let removed = 0;
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
            removed++;
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
        removed++;

        if (project.projectRuntimeRoot) {
          runtimeTargets.push({
            projectId: candidate.projectId,
            runtimeRoot: path.resolve(project.projectRuntimeRoot),
          });
        }
      }
      return removed;
    });
  }

  if (runtimeTargets.length > 0) {
    await mutateRegistry(hubRoot, async (registry) => {
      for (const target of runtimeTargets) {
        if (registry.projects[target.projectId]) continue;
        try {
          await rm(target.runtimeRoot, { recursive: true, force: true });
        } catch (err) {
          errors.push({ projectId: target.projectId, phase: "runtime-rm", message: errorMessage(err) });
        }
      }
    });
  }

  for (const orphan of pollution.orphanRuntimeDirs) {
    const runtimeDir = stringOrNull(orphan.runtimeDir);
    if (!runtimeDir) continue;
    try {
      await rm(runtimeDir, { recursive: true, force: true });
      orphanDirsRemoved++;
    } catch (err) {
      errors.push({ kind: "orphan-runtime-dir", dir: runtimeDir, message: errorMessage(err) });
    }
  }

  return { projectsRemoved, orphanDirsRemoved, sourcePathsPreserved, unsafeProjectsSkipped, errors };
}

// ── worktree-retention ──
import { mkdir, rename } from "node:fs/promises";

type RetentionAction = "preserve" | "delete" | "archive";

type WorktreeRetentionPolicy = LooseRecord & {
  completed?: unknown;
  archiveRoot?: unknown;
};

type NormalizedWorktreeRetentionPolicy = {
  completed: RetentionAction | null;
  archiveRoot: string;
};

type WorktreeRetentionEntry = LooseRecord & {
  jobId?: string;
  project: string | null;
  status: string;
  workflow: string | null;
  worktree: string;
  branch: string | null;
  baseBranch: string | null;
  action: RetentionAction;
  reason: string;
  archivePath?: string;
  result?: "deleted" | "archived" | "preserved";
};

type WorktreeRetentionPlan = {
  dryRun: boolean;
  policy: NormalizedWorktreeRetentionPolicy;
  entries: WorktreeRetentionEntry[];
  orphans: WorktreeRetentionEntry[];
  summary: {
    total: number;
    delete: number;
    archive: number;
    preserve: number;
    orphanCount: number;
  };
};

type WorktreeRetentionOptions = CleanupOptions & {
  policy?: WorktreeRetentionPolicy;
  dryRun?: boolean;
};

type WorktreeRetentionPrintableEntry = LooseRecord & {
  action: string;
  worktree: string;
  archivePath?: string;
  jobId?: string;
  status?: string;
  reason?: string;
};

type WorktreeRetentionPrintablePlan = LooseRecord & {
  dryRun?: boolean;
  entries: WorktreeRetentionPrintableEntry[];
};

type CommandResult = string | { stdout?: string; stderr?: string; code?: string | number };
type CommandRunner = (
  command: string,
  args: string[],
  options: { maxBuffer?: number; encoding?: BufferEncoding },
) => Promise<CommandResult>;

type BacklogHygieneOptions = CleanupOptions & {
  dryRun?: boolean;
  repo?: string | null;
  runCommand?: CommandRunner;
};

type IssueCommentQuery = {
  repo: string;
  issueNumber: string | number;
};

type CpbCommentMeta = {
  kind: string | null;
  jobId: string | null;
  status: string | null;
};

type IssueComment = LooseRecord & {
  id?: string | number;
  body: string;
  meta?: CpbCommentMeta;
};

type CpbIssueComment = IssueComment & {
  meta: CpbCommentMeta;
};

type GithubIssueForCleanup = LooseRecord & {
  repository?: string | null;
  repo?: string | null;
  state?: string;
  number?: string | number;
};

type StaleCommentsReport = {
  issuesScanned: number;
  staleComments: LooseRecord[];
  supersededIssues: LooseRecord[];
  errors: LooseRecord[];
};

const COMPLETED_ACTIONS = new Set<RetentionAction>(["preserve", "delete", "archive"]);

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
  if (isRetentionAction(action)) return action;
  return DEFAULT_WORKFLOW_RETENTION[status] || "preserve";
}

function isRetentionAction(value: unknown): value is RetentionAction {
  return typeof value === "string" && COMPLETED_ACTIONS.has(value as RetentionAction);
}

function normalizePolicy(cpbRoot: string, policy: WorktreeRetentionPolicy = {}): NormalizedWorktreeRetentionPolicy {
  // completed: null means "not specified, use workflow-aware default"
  const completed = policy.completed != null && isRetentionAction(policy.completed)
    ? policy.completed
    : null;
  return {
    completed,
    archiveRoot: path.resolve(typeof policy.archiveRoot === "string" ? policy.archiveRoot : runtimeDataPath(cpbRoot, "worktree-archive")),
  };
}

function archivePathFor(policy: NormalizedWorktreeRetentionPolicy, worktree: string) {
  return path.join(policy.archiveRoot, path.basename(worktree));
}

function managedWorktreeRoots(cpbRoot: string, options: CleanupOptions) {
  return [...new Set([
    path.resolve(resolvedHubRoot(cpbRoot, options), "worktrees"),
    path.resolve(cpbRoot, "worktrees"),
    path.resolve(cpbRoot, "cpb-task", "worktrees"),
  ])];
}

function directManagedWorktreeRoot(worktree: string, roots: string[]) {
  const candidate = path.resolve(worktree);
  return roots.find((root) => {
    const relative = path.relative(root, candidate);
    return relative !== ""
      && !path.isAbsolute(relative)
      && relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !relative.includes(path.sep);
  }) || null;
}

async function inspectManagedWorktreePath(worktree: string, roots: string[]) {
  const root = directManagedWorktreeRoot(worktree, roots);
  if (!root) return { safe: false as const, reason: "worktree is outside managed worktree roots" };
  try {
    const [rootInfo, worktreeInfo] = await Promise.all([lstat(root), lstat(path.resolve(worktree))]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || !worktreeInfo.isDirectory() || worktreeInfo.isSymbolicLink()) {
      return { safe: false as const, reason: "unsafe managed worktree path: expected real directories" };
    }
    const [canonicalRoot, canonicalWorktree] = await Promise.all([realpath(root), realpath(path.resolve(worktree))]);
    if (path.dirname(canonicalWorktree) !== canonicalRoot) {
      return { safe: false as const, reason: "unsafe managed worktree path: canonical path escaped its root" };
    }
    return { safe: true as const, root, worktree: canonicalWorktree };
  } catch (error) {
    return {
      safe: false as const,
      reason: `unsafe managed worktree path: ${errorCode(error) === "ENOENT" ? "path does not exist" : errorMessage(error)}`,
    };
  }
}

function entryForJob(
  job: CleanupJob,
  policy: NormalizedWorktreeRetentionPolicy,
  safety: Awaited<ReturnType<typeof inspectManagedWorktreePath>>,
): WorktreeRetentionEntry {
  const workflow = job.workflow || null;
  const base: WorktreeRetentionEntry = {
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

  if (!safety.safe) return { ...base, reason: safety.reason };

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

export async function buildWorktreeRetentionPlan(cpbRoot: string, { policy = {}, dryRun = true, ...options }: WorktreeRetentionOptions = {}): Promise<WorktreeRetentionPlan> {
  const normalizedPolicy = normalizePolicy(cpbRoot, policy);
  const jobs = await listJobsForCleanup(cpbRoot, options);
  const managedRoots = managedWorktreeRoots(cpbRoot, options);

  // Build a set of worktree paths that have associated jobs
  const worktreeByPath = new Map<string, CleanupJob>();
  for (const job of jobs) {
    if (job.jobId && job.worktree && directManagedWorktreeRoot(job.worktree, managedRoots)) {
      worktreeByPath.set(path.resolve(job.worktree), job);
    }
  }

  // Orphan detection only scans declared managed roots. Job projections are
  // untrusted inputs and must never select an arbitrary parent directory.
  const orphans: WorktreeRetentionEntry[] = [];
  for (const root of managedRoots) {
    let entries;
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidatePath = path.join(root, entry.name);
      const resolved = path.resolve(candidatePath);
      if (!worktreeByPath.has(resolved)) {
        orphans.push({
          project: null,
          status: "unknown",
          workflow: null,
          worktree: candidatePath,
          branch: null,
          baseBranch: null,
          action: "delete",
          reason: "orphan worktree: no associated job found",
        });
      }
    }
  }

  // Build entries from jobs with worktrees
  const entries = (await Promise.all(jobs
    .filter((job) => job.jobId && job.worktree)
    .map(async (job) => entryForJob(job, normalizedPolicy, await inspectManagedWorktreePath(job.worktree as string, managedRoots)))))
    .sort((a, b) => a.worktree.localeCompare(b.worktree));

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

export async function cleanupWorktrees(cpbRoot: string, { policy = {}, dryRun = true, ...options }: WorktreeRetentionOptions = {}) {
  const plan = await buildWorktreeRetentionPlan(cpbRoot, { policy, dryRun, ...options });
  if (plan.dryRun) return plan;

  const managedRoots = managedWorktreeRoots(cpbRoot, options);
  const results = [];
  for (const entry of plan.entries) {
    if (entry.action === "delete") {
      const safety = await inspectManagedWorktreePath(entry.worktree, managedRoots);
      if (!safety.safe) {
        results.push({ ...entry, action: "preserve", reason: safety.reason, result: "preserved" });
        continue;
      }
      await rm(entry.worktree, { recursive: true, force: true });
      results.push({ ...entry, result: "deleted" });
    } else if (entry.action === "archive") {
      const safety = await inspectManagedWorktreePath(entry.worktree, managedRoots);
      if (!safety.safe) {
        results.push({ ...entry, action: "preserve", reason: safety.reason, result: "preserved" });
        continue;
      }
      await mkdir(path.dirname(entry.archivePath), { recursive: true });
      await rename(entry.worktree, entry.archivePath);
      results.push({ ...entry, result: "archived" });
    } else {
      results.push({ ...entry, result: "preserved" });
    }
  }

  return { ...plan, entries: results };
}

export function formatWorktreeRetentionHuman(plan: WorktreeRetentionPrintablePlan) {
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
const defaultRunCommand: CommandRunner = async (command, args, options) => {
  const result = await execFileAsync(command, args, options);
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
};
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const HYGIENE_TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "superseded"]);

function isTerminalJob(job: CleanupJob) {
  return HYGIENE_TERMINAL_STATUSES.has(job.status);
}

function issueKey(repo: string, number: string | number) {
  return `${repo}#${number}`;
}

function isStale(timestamp: string) {
  if (!timestamp) return false;
  return Date.now() - new Date(timestamp).getTime() > STALE_THRESHOLD_MS;
}

async function runGh(args: string[], { runCommand = defaultRunCommand }: BacklogHygieneOptions = {}) {
  const result = await runCommand("gh", args, {
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf8",
  });
  return typeof result === "string" ? result : String(result.stdout ?? "");
}

async function listIssueComments({ repo, issueNumber }: IssueCommentQuery, { runCommand = defaultRunCommand }: BacklogHygieneOptions = {}): Promise<IssueComment[]> {
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

export function isCpbComment(body: string) {
  if (!body) return false;
  return body.includes("CodePatchBay queued this issue.")
    || body.includes("CodePatchBay failed this run.")
    || body.includes("CodePatchBay blocked this run.")
    || body.includes("CodePatchBay updated this run.")
    || body.includes("Verified patch ready.")
    || body.includes("Draft PR opened.")
    || body.includes("<!-- cpb-stale-marker -->");
}

export function parseCpbCommentMeta(body: string) {
  const meta: CpbCommentMeta = { kind: null, jobId: null, status: null };
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

export function buildStaleMarkerComment({ jobId, supersededBy, reason }: LooseRecord) {
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

export function buildSupersededIssueCloseComment({ queueEntryId, supersededByQueueEntryId, reason }: LooseRecord) {
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

export async function scanStaleComments(cpbRoot: string, hubRoot: string, { dryRun = false, repo = null, runCommand = defaultRunCommand }: BacklogHygieneOptions = {}): Promise<StaleCommentsReport> {
  const jobs = await listJobsForCleanup(cpbRoot, { hubRoot });
  const queueEntries = await listHubQueue(hubRoot);
  const { readGithubIssues } = await import("../github/github-issues.js");
  const githubIssues = await readGithubIssues(hubRoot);

  const jobsByIssue = new Map<string, CleanupJob[]>();
  for (const job of jobs) {
    if (!isTerminalJob(job)) continue;
    const source = job.sourceContext || {};
    if (source.type !== "github_issue" && source.issueNumber === undefined) continue;
    const r = source.repo || source.repository;
    const n = source.issueNumber;
    if (typeof r !== "string" || (typeof n !== "string" && typeof n !== "number")) continue;
    const key = issueKey(r, n);
    const list = jobsByIssue.get(key) || [];
    list.push(job);
    jobsByIssue.set(key, list);
  }

  const queueByJobId = new Map<string, QueueEntry>();
  const supersededEntries: QueueEntry[] = [];
  for (const entry of queueEntries) {
    const m = entry.metadata || {};
    const jobId = typeof m.jobId === "string" ? m.jobId : null;
    const originJobId = typeof m.originJobId === "string" ? m.originJobId : null;
    const finalDisposition = typeof m.finalDisposition === "string" ? m.finalDisposition : "";
    if (jobId) queueByJobId.set(jobId, entry);
    if (originJobId) queueByJobId.set(originJobId, entry);
    if (finalDisposition.startsWith("superseded") || finalDisposition.startsWith("rejected")) {
      supersededEntries.push(entry);
    }
  }

  const report: StaleCommentsReport = {
    issuesScanned: 0,
    staleComments: [],
    supersededIssues: [],
    errors: [],
  };

  const normalizedIssues = githubIssues as GithubIssueForCleanup[];
  const targetIssues = repo
    ? normalizedIssues.filter((i) => (i.repository || i.repo) === repo && i.state !== "CLOSED")
    : normalizedIssues.filter((i) => i.state !== "CLOSED");

  for (const issue of targetIssues) {
    const r = issue.repository || issue.repo;
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
      report.errors.push({ repo: r, issueNumber: n, phase: "fetch_comments", message: errorMessage(err) });
      continue;
    }

    const cpbComments = comments
      .map((c): CpbIssueComment => ({ ...c, meta: parseCpbCommentMeta(c.body) }))
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
            message: errorMessage(err),
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
      const supersededByQueueId = stringOrNull(m.supersededByQueueEntryId || m.supersededByJobId);
      const reason = stringOrNull(m.finalDisposition) || "superseded";

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
            message: errorMessage(err),
          });
        }
      }
    }
  }

  return report;
}

export async function runBacklogHygiene(cpbRoot: string, { dryRun = false, repo = null, runCommand = defaultRunCommand }: BacklogHygieneOptions = {}) {
  const hubRoot = resolvedHubRoot(cpbRoot);
  return scanStaleComments(cpbRoot, hubRoot, { dryRun, repo, runCommand });
}
