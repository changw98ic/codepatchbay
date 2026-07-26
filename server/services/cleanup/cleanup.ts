// ── reconcile ──
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, fstatSync, lstatSync, mkdirSync, renameSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, type FileHandle } from "node:fs/promises";
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
import { scanHubPollution } from "../project/project-index.js";
import { captureProcessIdentity, sameProcessIdentity, type ProcessIdentity } from "../../../core/runtime/process-tree.js";
import { hostname } from "node:os";
import {
  parseWorktreeOwnership,
  sameWorktreeDirectoryIdentity,
  type ReadyWorktreeOwnership,
  type WorktreeDirectoryIdentity,
} from "../../../core/contracts/worktree-ownership.js";

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
  retainedPath?: string;
  quarantinePath?: string;
  recoveryPath?: string;
};

type CleanupPollutionReport = {
  projectsRemoved: number;
  orphanDirsRemoved: number;
  sourcePathsPreserved: Array<string | undefined>;
  unsafeProjectsSkipped: PollutionSkip[];
  errors: CleanupPollutionError[];
  quarantinedRuntimeDirs: Array<LooseRecord>;
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
  worktreeOwnership?: LooseRecord | null;
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
  leaseId?: string;
  jobId?: string;
  phase?: string;
  ownerPid?: number;
  ownerHost?: string;
  ownerToken?: string;
  ownerIdentity?: ProcessIdentity;
  expiresAt?: string;
};

type StaleCause = LooseRecord & {
  failureReason?: string;
  phase?: string;
  jobId?: string;
  leaseId?: string | null;
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
  unverifiedJobs?: LooseRecord[];
  cleanupErrors?: LooseRecord[];
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

function nowIso() {
  return new Date().toISOString();
}

function processIdentityFromRecord(value: unknown, expectedPid?: number): ProcessIdentity | null {
  const candidate = isRecord(value) ? value : {};
  const pid = Number(candidate.pid);
  const capturedAt = typeof candidate.capturedAt === "string" ? candidate.capturedAt : "";
  const processGroupId = Number(candidate.processGroupId);
  if (
    !Number.isSafeInteger(pid)
    || pid <= 0
    || (expectedPid !== undefined && pid !== expectedPid)
    || typeof candidate.birthId !== "string"
    || candidate.birthId.length === 0
    || candidate.incarnation !== `${pid}:${candidate.birthId}`
    || !capturedAt
    || !Number.isFinite(Date.parse(capturedAt))
    || new Date(Date.parse(capturedAt)).toISOString() !== capturedAt
    || candidate.birthIdPrecision !== "exact"
    || (candidate.processGroupId !== undefined
      && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0))
  ) {
    return null;
  }
  return {
    pid,
    birthId: candidate.birthId,
    incarnation: candidate.incarnation,
    capturedAt,
    birthIdPrecision: "exact",
    ...(candidate.processGroupId === undefined ? {} : { processGroupId }),
  };
}

type StrictStaleVerdict =
  | { stale: true; reason: string; cause: StaleCause; artifact: string | null; unverified?: undefined }
  | { stale: false; unverified?: LooseRecord; reason?: undefined; cause?: undefined; artifact?: undefined };

function processLivenessVerdict(processEntry: ProcessEntry | null, job: CleanupJob): StrictStaleVerdict {
  if (!processEntry || processEntry.status !== "running") return { stale: false };
  let liveness: string;
  try {
    liveness = classifyLiveness(processEntry);
  } catch (error) {
    return {
      stale: false,
      unverified: {
        jobId: job.jobId,
        leaseId: processEntry.leaseId || job.leaseId || null,
        reason: "process_liveness_unverified",
        detail: errorMessage(error),
        observedAt: nowIso(),
      },
    };
  }
  const phase = processEntry.phase || job.phase || "unknown";
  if (liveness === "orphan") {
    const cause = {
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
    return {
      stale: true,
      reason: `${phase} process disappeared before terminal phase event`,
      cause,
      artifact: `process:${job.jobId}:phase:${phase}`,
    };
  }
  if (liveness === "unknown" || liveness === "identity_mismatch") {
    return {
      stale: false,
      unverified: {
        jobId: job.jobId,
        leaseId: processEntry.leaseId || job.leaseId || null,
        reason: `process_${liveness}`,
        phase,
        runnerPid: processEntry.runnerPid,
        observedAt: nowIso(),
      },
    };
  }
  return { stale: false };
}

const MAX_REJECTED_LEASE_EVIDENCE_BYTES = 1024 * 1024;

async function readRejectedLeaseEvidence(leasePath: string): Promise<LeaseRecord | null> {
  const handle = await open(
    leasePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REJECTED_LEASE_EVIDENCE_BYTES) {
      return null;
    }
    const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    return isRecord(parsed) ? parsed as LeaseRecord : null;
  } finally {
    await handle.close();
  }
}

function leaseOwnerVerdict(lease: LeaseRecord, now: Date, job: CleanupJob): StrictStaleVerdict {
  let expired = false;
  try {
    expired = isLeaseStale(lease, now);
  } catch (error) {
    return {
      stale: false,
      unverified: {
        jobId: job.jobId,
        leaseId: job.leaseId || lease.leaseId || null,
        reason: "lease_invalid",
        detail: errorMessage(error),
        observedAt: nowIso(),
      },
    };
  }
  if (!expired) return { stale: false };

  const ownerPid = Number(lease.ownerPid);
  const ownerIdentity = processIdentityFromRecord(lease.ownerIdentity, ownerPid);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !ownerIdentity || typeof lease.ownerToken !== "string" || lease.ownerToken.length === 0) {
    return {
      stale: false,
      unverified: {
        jobId: job.jobId,
        leaseId: job.leaseId || lease.leaseId || null,
        reason: "lease_owner_identity_missing",
        ownerPid: Number.isSafeInteger(ownerPid) ? ownerPid : null,
        observedAt: nowIso(),
      },
    };
  }
  if (lease.ownerHost && lease.ownerHost !== hostname()) {
    return {
      stale: false,
      unverified: {
        jobId: job.jobId,
        leaseId: job.leaseId || lease.leaseId || null,
        reason: "lease_owner_remote_unverified",
        ownerPid,
        ownerHost: lease.ownerHost,
        observedAt: nowIso(),
      },
    };
  }

  try {
    process.kill(ownerPid, 0);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") {
      return {
        stale: false,
        unverified: {
          jobId: job.jobId,
          leaseId: job.leaseId || lease.leaseId || null,
          reason: "lease_owner_liveness_unverified",
          ownerPid,
          detail: errorMessage(error),
          observedAt: nowIso(),
        },
      };
    }
    const cause = {
      kind: "stale_runtime_reconciled",
      failureReason: "lease_stale_owner_dead",
      phase: job.phase || lease.phase,
      jobId: job.jobId,
      leaseId: job.leaseId || lease.leaseId || null,
      runnerPid: ownerPid,
      leaseExpiresAt: lease.expiresAt,
      processIncarnation: ownerIdentity.incarnation,
      observedAt: nowIso(),
    };
    return {
      stale: true,
      reason: `owner process dead (pid ${ownerPid})`,
      cause,
      artifact: `lease:${job.leaseId || lease.leaseId || "unknown"}:phase:${job.phase || lease.phase || "unknown"}`,
    };
  }

  const current = captureProcessIdentity(ownerPid, { strict: true });
  if (!current || !sameProcessIdentity(ownerIdentity, current)) {
    return {
      stale: false,
      unverified: {
        jobId: job.jobId,
        leaseId: job.leaseId || lease.leaseId || null,
        reason: "lease_owner_identity_mismatch",
        ownerPid,
        expectedIncarnation: ownerIdentity.incarnation,
        observedAt: nowIso(),
      },
    };
  }
  return { stale: false };
}

function localIdentityGone(identity: ProcessIdentity): { gone: true; unverified?: undefined } | { gone: false; unverified?: LooseRecord } {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") return { gone: true };
    return {
      gone: false,
      unverified: {
        reason: "process_liveness_unverified",
        pid: identity.pid,
        detail: errorMessage(error),
        observedAt: nowIso(),
      },
    };
  }
  const current = captureProcessIdentity(identity.pid, { strict: true });
  if (!current || !sameProcessIdentity(identity, current)) {
    return {
      gone: false,
      unverified: {
        reason: "process_identity_mismatch",
        pid: identity.pid,
        expectedIncarnation: identity.incarnation,
        observedAt: nowIso(),
      },
    };
  }
  return { gone: false };
}

async function strictStaleJobVerdict(
  cpbRoot: string,
  job: CleanupJob,
  processEntry: ProcessEntry | null,
  now: Date,
): Promise<StrictStaleVerdict> {
  const processVerdict = processLivenessVerdict(processEntry, job);
  if (processVerdict.stale || processVerdict.unverified) return processVerdict;

  if (!job.leaseId) {
    return {
      stale: false,
      unverified: {
        jobId: job.jobId,
        reason: "lease_missing_from_job",
        observedAt: nowIso(),
      },
    };
  }

  let lease: LeaseRecord | null = null;
  try {
    lease = await readLease(cpbRoot, job.leaseId, { dataRoot: job.__dataRoot });
  } catch (error) {
    return {
      stale: false,
      unverified: {
        jobId: job.jobId,
        leaseId: job.leaseId,
        reason: "lease_read_unverified",
        detail: errorMessage(error),
        observedAt: nowIso(),
      },
    };
  }
  if (lease === null) {
    return {
      stale: false,
      unverified: {
        jobId: job.jobId,
        leaseId: job.leaseId,
        reason: "lease_missing",
        observedAt: nowIso(),
      },
    };
  }
  return leaseOwnerVerdict(lease, now, job);
}

async function cleanupReconciledJobArtifacts(
  cpbRoot: string,
  hubRoot: string,
  job: CleanupJob,
  processEntry: ProcessEntry | null,
  queueEntries: QueueEntry[],
  cause: StaleCause | null,
  failureArtifact: string | null,
) {
  const tasks: Array<Promise<unknown>> = [];
  const matched = findMatchingQueueEntry(queueEntries, job);
  if (matched && cause) {
    tasks.push(updateQueueEntry(hubRoot, matched.id, {
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
    }));
  }
  if (processEntry) {
    tasks.push(removeProcess(cpbRoot, job.jobId, { dataRoot: processEntry.__dataRoot || job.__dataRoot }));
  }
  if (job.leaseId) {
    tasks.push((async () => {
      const lease = await readLease(cpbRoot, job.leaseId!, { dataRoot: job.__dataRoot });
      await releaseLease(cpbRoot, job.leaseId!, {
        dataRoot: job.__dataRoot,
        ownerToken: typeof lease?.ownerToken === "string" ? lease.ownerToken : undefined,
      });
    })());
  }
  const settled = await Promise.allSettled(tasks);
  const rejected = settled
    .map((result, index) => ({ result, index }))
    .filter((entry): entry is { result: PromiseRejectedResult; index: number } => entry.result.status === "rejected");
  if (rejected.length > 0) {
    throw new AggregateError(
      rejected.map((entry) => entry.result.reason),
      `stale job cleanup failed for ${job.jobId}`,
    );
  }
  return {
    queueEntryId: matched?.id || null,
    processRemoved: Boolean(processEntry),
    leaseReleased: Boolean(job.leaseId),
  };
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
  const unverified: LooseRecord[] = [];

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
    const processEntry = processByJobId.get(job.jobId) || null;
    const verdict = await strictStaleJobVerdict(cpbRoot, job, processEntry, now);
    if (!verdict.stale) {
      if (verdict.unverified) unverified.push({ project: job.project, dataRoot: job.__dataRoot || null, ...verdict.unverified });
      continue;
    }
    const staleReason = verdict.reason;
    const cause: StaleCause = verdict.cause;

    // Attach session pin from process registry
    if (processEntry?.sessionPin) {
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

      await cleanupReconciledJobArtifacts(cpbRoot, hubRoot, job, processEntry, queueEntries, cause, verdict.artifact);
    } catch (err) {
      failed.push({ jobId: job.jobId, project: job.project, error: errorMessage(err) });
    }
  }

  return { recovered, failed, unverified };
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
    unverifiedJobs: [],
    cleanupErrors: [],
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
    const processEntry = processByJobId.get(job.jobId) || null;
    const verdict = await strictStaleJobVerdict(cpbRoot, job, processEntry, now);
    if (!verdict.stale) {
      if (verdict.unverified) {
        report.unverifiedJobs!.push({ project: job.project, dataRoot: job.__dataRoot || null, ...verdict.unverified });
      }
      continue;
    }
    const staleReason = verdict.reason;
    let cause: StaleCause = verdict.cause;
    const failureArtifact = verdict.artifact;
    const staleViaProcessOrphan = cause.failureReason === "stale_pid_disappeared";
    {
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
        cause.sessionPin = processEntry.sessionPin;
        jobReport.sessionPin = processEntry.sessionPin;
      }
      report.staleJobs.push(jobReport);

      if (dryRun) {
        const matched = findMatchingQueueEntry(queueEntries, job);
        if (matched) {
          report.reconciledQueueEntries.push({
            queueEntryId: matched.id,
            jobId: job.jobId,
            wouldReconcile: true,
          });
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
            phase: cause.phase || job.phase,
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

        try {
          const cleanup = await cleanupReconciledJobArtifacts(cpbRoot, hubRoot, job, processEntry, queueEntries, cause, failureArtifact);
          if (cleanup.queueEntryId) {
            report.reconciledQueueEntries.push({ queueEntryId: cleanup.queueEntryId, jobId: job.jobId });
          }
          if (cleanup.processRemoved) {
            report.reconciledProcesses.push({ jobId: job.jobId, removed: true });
          }
          if (cleanup.leaseReleased) {
            report.orphanLeases.push({
              leaseId: job.leaseId,
              jobId: job.jobId,
              reason: "released with reconciled stale job",
              dataRoot: job.__dataRoot || null,
            });
          }
        } catch (error) {
          const cleanupError = { jobId: job.jobId, project: job.project, error: errorMessage(error) };
          report.cleanupErrors!.push(cleanupError);
          throw error;
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

      let lease: LeaseRecord | null = null;
      let strictReadError: unknown = null;
      try {
        lease = await readLease(cpbRoot, leaseId, {
          dataRoot: root.dataRoot,
          includeLegacyFallback: false,
        });
      } catch (error) {
        strictReadError = error;
        try {
          lease = await readRejectedLeaseEvidence(path.join(leasesDir, f));
        } catch {
          lease = null;
        }
      }

      if (!lease || typeof lease.jobId !== "string" || lease.jobId.length === 0) {
        if (strictReadError) {
          report.unverifiedJobs!.push({
            jobId: null,
            leaseId,
            dataRoot: root.dataRoot,
            reason: "lease_unreadable",
            detail: errorMessage(strictReadError),
          });
        }
        continue;
      }
      if (TERMINAL_STATUSES.has(lease.phase) && !lease.jobId) continue;

      const jobExists = activeJobIds.has(lease.jobId);
      if (strictReadError) {
        report.unverifiedJobs!.push({
          jobId: lease.jobId,
          leaseId,
          dataRoot: root.dataRoot,
          reason: !jobExists ? "orphan_lease_owner_unverified" : "lease_invalid",
          detail: {
            code: errorCode(strictReadError),
            message: errorMessage(strictReadError),
          },
        });
        continue;
      }
      const ownerVerdict = leaseOwnerVerdict(lease, now, {
        jobId: lease.jobId,
        project: null,
        phase: lease.phase,
        leaseId,
        __dataRoot: root.dataRoot,
      });

      if ((!jobExists || ownerVerdict.stale) && ownerVerdict.stale) {
        report.orphanLeases.push({
          leaseId,
          jobId: lease.jobId || null,
          reason: !jobExists ? "job not found and owner dead" : "expired with dead owner",
          dataRoot: root.dataRoot,
        });

        if (!dryRun) {
          try {
            await releaseLease(cpbRoot, leaseId, {
              dataRoot: root.dataRoot,
              ownerToken: typeof lease.ownerToken === "string" ? lease.ownerToken : undefined,
            });
          } catch (error) {
            const cleanupError = { leaseId, jobId: lease.jobId || null, error: errorMessage(error) };
            report.cleanupErrors!.push(cleanupError);
            throw error;
          }
        }
      } else if (!ownerVerdict.stale && ownerVerdict.unverified) {
        report.unverifiedJobs!.push({
          jobId: lease.jobId || null,
          leaseId,
          dataRoot: root.dataRoot,
          reason: !jobExists ? "orphan_lease_owner_unverified" : ownerVerdict.unverified.reason,
          detail: ownerVerdict.unverified,
        });
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
      if (age <= 300_000 || !pid) continue;
      const identity = processIdentityFromRecord(project.worker.processIdentity || project.worker.ownerIdentity, Number(pid));
      if (!identity) {
        report.unverifiedJobs!.push({
          project: project.id,
          workerId: project.worker.workerId,
          pid,
          reason: "worker_identity_missing",
          observedAt: nowIso(),
        });
        continue;
      }
      const gone = localIdentityGone(identity);
      if (gone.gone) {
        report.workers.stale.push({
          project: project.id,
          workerId: project.worker.workerId,
          pid,
          lastSeenAt: project.worker.lastSeenAt,
          processIncarnation: identity.incarnation,
        });
      } else if (gone.unverified) {
        report.unverifiedJobs!.push({
          project: project.id,
          workerId: project.worker.workerId,
          ...gone.unverified,
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
    } catch (error) {
      report.cleanupErrors!.push({
        phase: "cleanup-pollution",
        error: errorMessage(error),
      });
    }
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

      let leaseJobId: string | null = null;
      try {
        const lease = await readLease(cpbRoot, leaseId, {
          dataRoot: root.dataRoot,
          includeLegacyFallback: false,
        });
        leaseJobId = typeof lease?.jobId === "string" ? lease.jobId : null;
      } catch {
        try {
          const evidence = await readRejectedLeaseEvidence(path.join(leasesDir, f));
          leaseJobId = typeof evidence?.jobId === "string" ? evidence.jobId : null;
        } catch {
          leaseJobId = null;
        }
      }

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
      let leaseOwnerToken: string | undefined;
      try {
        const lease = await readLease(cpbRoot, leaseId, {
          dataRoot: root.dataRoot,
          includeLegacyFallback: false,
        });
        leaseJobId = lease?.jobId || null;
        leaseOwnerToken = typeof lease?.ownerToken === "string" ? lease.ownerToken : undefined;
      } catch {}

      const shouldClean = terminalLeaseIds.has(leaseId) ||
        (leaseJobId && terminalJobIds.has(leaseJobId));
      if (shouldClean) {
        await releaseLease(cpbRoot, leaseId, {
          dataRoot: root.dataRoot,
          ownerToken: leaseOwnerToken,
          includeLegacyFallback: false,
        });
        cleaned++;
      }
    }
  }

  return { cleaned };
}

/**
 * Determine whether a polluted project's runtime directory can be safely quarantined.
 * Only allows a move when the target is the project's exact direct managed runtime root.
 * Rejects hubRoot, <hubRoot>/projects,
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

  const projectsRoot = path.join(hubResolved, "projects");
  if (path.dirname(targetResolved) !== projectsRoot) {
    return { canDelete: false, reason: "runtime-root-not-direct-managed-child" };
  }

  if (targetResolved === expectedRoot) {
    return { canDelete: true, reason: "exact-expected-root" };
  }

  return { canDelete: false, reason: "unsafe-runtime-root" };
}

function isPathWithinOrEqual(anchor: string, target: string) {
  const relative = path.relative(path.resolve(anchor), path.resolve(target));
  return relative === ""
    || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function assertRealDirectoryLineage(anchor: string, target: string, label: string) {
  const resolvedAnchor = path.resolve(anchor);
  const resolvedTarget = path.resolve(target);
  if (!isPathWithinOrEqual(resolvedAnchor, resolvedTarget)) {
    throw Object.assign(new Error(`${label} is outside its declared anchor: ${resolvedTarget}`), {
      code: "ECLEANUP_DECLARED_ROOT_ESCAPE",
    });
  }
  const relative = path.relative(resolvedAnchor, resolvedTarget);
  const paths = [resolvedAnchor];
  let current = resolvedAnchor;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    paths.push(current);
  }
  for (const candidate of paths) {
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw Object.assign(new Error(`${label} is not a real directory: ${candidate}`), {
        code: "ECLEANUP_DECLARED_ROOT_SYMLINK",
      });
    }
  }
}

async function assertDeclaredHubRootLineage(cpbRoot: string, hubRoot: string) {
  const resolvedCpbRoot = path.resolve(cpbRoot);
  const resolvedHubRoot = path.resolve(hubRoot);
  const anchor = isPathWithinOrEqual(resolvedCpbRoot, resolvedHubRoot)
    ? resolvedCpbRoot
    : resolvedHubRoot;
  await assertRealDirectoryLineage(anchor, resolvedHubRoot, "cleanup hub root");
}

async function assertDeclaredManagedRootLineage(
  cpbRoot: string,
  hubRoot: string,
  managedRoot: string,
) {
  const resolvedCpbRoot = path.resolve(cpbRoot);
  const resolvedHubRoot = path.resolve(hubRoot);
  const anchor = isPathWithinOrEqual(resolvedCpbRoot, managedRoot)
    ? resolvedCpbRoot
    : isPathWithinOrEqual(resolvedHubRoot, managedRoot)
      ? resolvedHubRoot
      : managedRoot;
  await assertRealDirectoryLineage(anchor, managedRoot, "cleanup declared root");
}

type DirectoryGeneration = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
  nlink: bigint;
};

type DirectoryAuthority = {
  path: string;
  generation: DirectoryGeneration;
  handle: FileHandle;
};

function directoryGeneration(info: {
  dev: number | bigint;
  ino: number | bigint;
  mode: number | bigint;
  ctimeNs?: bigint;
  ctimeMs?: number | bigint;
  birthtimeNs?: bigint;
  birthtimeMs?: number | bigint;
  nlink: number | bigint;
}): DirectoryGeneration {
  const ctimeMs = typeof info.ctimeMs === "bigint" ? Number(info.ctimeMs) : info.ctimeMs;
  const birthtimeMs = typeof info.birthtimeMs === "bigint" ? Number(info.birthtimeMs) : info.birthtimeMs;
  return {
    dev: BigInt(info.dev),
    ino: BigInt(info.ino),
    mode: BigInt(info.mode),
    ctimeNs: info.ctimeNs ?? BigInt(Math.trunc((ctimeMs || 0) * 1_000_000)),
    birthtimeNs: info.birthtimeNs ?? BigInt(Math.trunc((birthtimeMs || 0) * 1_000_000)),
    nlink: BigInt(info.nlink),
  };
}

function sameDirectoryGeneration(a: DirectoryGeneration, b: DirectoryGeneration) {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.mode === b.mode
    && a.ctimeNs === b.ctimeNs
    && a.birthtimeNs === b.birthtimeNs
    && a.nlink === b.nlink;
}

function sameDirectoryIdentity(a: DirectoryGeneration, b: DirectoryGeneration) {
  return a.dev === b.dev
    && a.ino === b.ino
    && a.mode === b.mode
    && a.birthtimeNs === b.birthtimeNs;
}

async function openRealDirectoryAuthority(dir: string): Promise<DirectoryAuthority> {
  const resolved = path.resolve(dir);
  const handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`expected real directory: ${resolved}`);
    }
    return { path: resolved, generation: directoryGeneration(info), handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function closeAuthority(authority: DirectoryAuthority | null) {
  if (!authority) return;
  await authority.handle.close();
}

function assertUnchangedDirectorySync(target: string, handle: FileHandle, expected: DirectoryGeneration, label: string) {
  const descriptor = directoryGeneration(fstatSync(handle.fd, { bigint: true }));
  const current = lstatSync(target, { bigint: true });
  if (
    !current.isDirectory()
    || current.isSymbolicLink()
    || !sameDirectoryGeneration(expected, descriptor)
    || !sameDirectoryGeneration(expected, directoryGeneration(current))
  ) {
    throw Object.assign(new Error(`${label} changed before cleanup rename: ${target}`), { code: "ECLEANUP_GENERATION_CHANGED" });
  }
}

function assertUnchangedDirectoryIdentitySync(
  target: string,
  handle: FileHandle,
  expected: DirectoryGeneration,
  label: string,
) {
  const descriptor = directoryGeneration(fstatSync(handle.fd, { bigint: true }));
  const currentInfo = lstatSync(target, { bigint: true });
  const current = directoryGeneration(currentInfo);
  if (
    !currentInfo.isDirectory()
    || currentInfo.isSymbolicLink()
    || !sameDirectoryIdentity(expected, descriptor)
    || !sameDirectoryIdentity(expected, current)
    || !sameDirectoryIdentity(descriptor, current)
  ) {
    throw Object.assign(new Error(`${label} changed before cleanup rename: ${target}`), {
      code: "ECLEANUP_GENERATION_CHANGED",
    });
  }
}

function recaptureOwnedDirectoryMutationSync(authority: DirectoryAuthority, label: string) {
  const descriptor = directoryGeneration(fstatSync(authority.handle.fd, { bigint: true }));
  const currentInfo = lstatSync(authority.path, { bigint: true });
  const current = directoryGeneration(currentInfo);
  if (
    !currentInfo.isDirectory()
    || currentInfo.isSymbolicLink()
    || !sameDirectoryIdentity(authority.generation, descriptor)
    || !sameDirectoryGeneration(descriptor, current)
  ) {
    throw Object.assign(new Error(`${label} changed during cleanup-owned mutation: ${authority.path}`), {
      code: "ECLEANUP_GENERATION_CHANGED",
    });
  }
  authority.generation = current;
}

function recaptureMatchingAuthorities(
  authorities: Array<DirectoryAuthority | null>,
  mutatedDirectory: string,
  label: string,
) {
  const target = path.resolve(mutatedDirectory);
  const seen = new Set<DirectoryAuthority>();
  for (const authority of authorities) {
    if (!authority || authority.path !== target || seen.has(authority)) continue;
    seen.add(authority);
    recaptureOwnedDirectoryMutationSync(authority, label);
  }
}

function assertDestinationAbsentSync(destination: string) {
  try {
    lstatSync(destination, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw Object.assign(new Error(`cleanup destination already exists: ${destination}`), { code: "EEXIST" });
}

function reserveDirectorySync(destination: string, label: string) {
  try {
    mkdirSync(destination, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw Object.assign(new Error(`cleanup ${label} already exists: ${destination}`), { code: "EEXIST" });
    }
    throw error;
  }
}

const CLEANUP_QUARANTINE_PREFIX = ".cpb-cleanup-quarantine-";

function randomSiblingQuarantinePath(source: string) {
  return path.join(path.dirname(path.resolve(source)), `${CLEANUP_QUARANTINE_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}-${path.basename(source)}`);
}

async function assertNoSymlinkAncestorChain(target: string) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw Object.assign(new Error(`cleanup destination ancestor is not a real directory: ${current}`), { code: "ECLEANUP_DESTINATION_ANCESTOR" });
    }
  }
}

async function assertExistingArchiveAncestorChain(target: string) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean);
  let current = parsed.root;
  let missing = false;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    if (missing) continue;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        missing = true;
        continue;
      }
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw Object.assign(new Error(`cleanup destination ancestor is not a real directory: ${current}`), {
        code: "ECLEANUP_DESTINATION_ANCESTOR",
      });
    }
  }
}

async function canonicalRealDirectory(target: string, label: string) {
  const resolved = path.resolve(target);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Object.assign(new Error(`${label} is not a real directory: ${resolved}`), {
      code: "ECLEANUP_DIRECTORY_UNSAFE",
    });
  }
  return realpath(resolved);
}

async function prepareArchiveDestination(destination: string) {
  const resolved = path.resolve(destination);
  await assertExistingArchiveAncestorChain(resolved);
  await mkdir(path.dirname(resolved), { recursive: true });
  await assertNoSymlinkAncestorChain(resolved);
  const canonicalParent = await realpath(path.dirname(resolved));
  if (canonicalParent !== path.dirname(resolved)) {
    throw Object.assign(new Error(`cleanup destination ancestor resolved through a symlink: ${path.dirname(resolved)}`), {
      code: "ECLEANUP_DESTINATION_ANCESTOR",
    });
  }
  return path.join(canonicalParent, path.basename(resolved));
}

async function openAncestorAuthorities(target: string) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  const segments = path.relative(parsed.root, resolved).split(path.sep).filter(Boolean);
  const authorities: DirectoryAuthority[] = [];
  let current = parsed.root;
  try {
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      authorities.push(await openRealDirectoryAuthority(current));
    }
    return authorities;
  } catch (error) {
    await closeAuthorities(authorities);
    throw error;
  }
}

function assertAncestorAuthoritiesUnchanged(authorities: DirectoryAuthority[], label: string) {
  for (const authority of authorities) {
    assertUnchangedDirectoryIdentitySync(authority.path, authority.handle, authority.generation, label);
  }
}

async function closeAuthorities(authorities: DirectoryAuthority[]) {
  await Promise.allSettled(authorities.map((authority) => authority.handle.close()));
}

async function durableRenameDirectory({
  source,
  destination,
  action,
}: {
  source: string;
  destination: string;
  action: "delete" | "archive" | "pollution";
}) {
  const lexicalSource = path.resolve(source);
  let resolvedSource = lexicalSource;
  let resolvedDestination = path.resolve(destination);
  let parentAuthority: DirectoryAuthority | null = null;
  let sourceAuthority: DirectoryAuthority | null = null;
  let destinationParentAuthority: DirectoryAuthority | null = null;
  let reservationAuthority: DirectoryAuthority | null = null;
  let payloadAuthority: DirectoryAuthority | null = null;
  let movedAuthority: DirectoryAuthority | null = null;
  let sourceAncestorAuthorities: DirectoryAuthority[] = [];
  let destinationAncestorAuthorities: DirectoryAuthority[] = [];
  let reservationCreated = false;
  let payloadPath: string | null = null;
  let sourceMoved = false;
  try {
    resolvedSource = await canonicalRealDirectory(lexicalSource, "cleanup source");
    if (action === "archive") {
      resolvedDestination = await prepareArchiveDestination(resolvedDestination);
      if (isPathWithinOrEqual(resolvedSource, resolvedDestination)) {
        throw Object.assign(new Error("cleanup archive destination must not be inside the source directory"), {
          code: "ECLEANUP_ARCHIVE_DESCENDANT",
        });
      }
    } else {
      if (path.dirname(resolvedDestination) !== path.dirname(lexicalSource)) {
        throw Object.assign(new Error("cleanup quarantine must be a same-parent sibling"), { code: "ECLEANUP_QUARANTINE_PARENT" });
      }
      resolvedDestination = path.join(path.dirname(resolvedSource), path.basename(resolvedDestination));
    }
    await assertNoSymlinkAncestorChain(resolvedSource);
    await assertNoSymlinkAncestorChain(resolvedDestination);
    sourceAncestorAuthorities = await openAncestorAuthorities(resolvedSource);
    destinationAncestorAuthorities = await openAncestorAuthorities(resolvedDestination);
    parentAuthority = await openRealDirectoryAuthority(path.dirname(resolvedSource));
    sourceAuthority = await openRealDirectoryAuthority(resolvedSource);
    destinationParentAuthority = path.dirname(resolvedDestination) === parentAuthority.path
      ? parentAuthority
      : await openRealDirectoryAuthority(path.dirname(resolvedDestination));

    await cleanupTestHooks().beforeWorktreeRename?.({
      action: action === "archive" ? "archive" : "delete",
      worktree: resolvedSource,
      destination: resolvedDestination,
    });
    assertAncestorAuthoritiesUnchanged(sourceAncestorAuthorities, "cleanup source ancestor");
    assertUnchangedDirectorySync(parentAuthority.path, parentAuthority.handle, parentAuthority.generation, "cleanup parent");
    assertUnchangedDirectorySync(resolvedSource, sourceAuthority.handle, sourceAuthority.generation, "cleanup target");
    assertAncestorAuthoritiesUnchanged(destinationAncestorAuthorities, "cleanup destination ancestor");
    assertUnchangedDirectorySync(destinationParentAuthority.path, destinationParentAuthority.handle, destinationParentAuthority.generation, "cleanup destination parent");
    assertDestinationAbsentSync(resolvedDestination);
    if (action === "archive") {
      await cleanupTestHooks().afterArchiveDestinationCheck?.({
        worktree: resolvedSource,
        destination: resolvedDestination,
      });
    }
    reserveDirectorySync(resolvedDestination, "destination");
    reservationCreated = true;
    await destinationParentAuthority.handle.sync();
    const allParentAuthorities = [
      ...sourceAncestorAuthorities,
      ...destinationAncestorAuthorities,
      parentAuthority,
      destinationParentAuthority,
    ];
    recaptureMatchingAuthorities(allParentAuthorities, path.dirname(resolvedDestination), "cleanup destination parent");

    reservationAuthority = await openRealDirectoryAuthority(resolvedDestination);
    payloadPath = path.join(resolvedDestination, `.cpb-cleanup-payload-${randomUUID()}`);
    reserveDirectorySync(payloadPath, "payload reservation");
    await reservationAuthority.handle.sync();
    recaptureOwnedDirectoryMutationSync(reservationAuthority, "cleanup destination reservation");
    payloadAuthority = await openRealDirectoryAuthority(payloadPath);

    assertAncestorAuthoritiesUnchanged(sourceAncestorAuthorities, "cleanup source ancestor");
    assertUnchangedDirectorySync(parentAuthority.path, parentAuthority.handle, parentAuthority.generation, "cleanup parent");
    assertUnchangedDirectorySync(resolvedSource, sourceAuthority.handle, sourceAuthority.generation, "cleanup target");
    assertAncestorAuthoritiesUnchanged(destinationAncestorAuthorities, "cleanup destination ancestor");
    assertUnchangedDirectorySync(destinationParentAuthority.path, destinationParentAuthority.handle, destinationParentAuthority.generation, "cleanup destination parent");
    assertUnchangedDirectorySync(resolvedDestination, reservationAuthority.handle, reservationAuthority.generation, "cleanup destination reservation");
    assertUnchangedDirectorySync(payloadPath, payloadAuthority.handle, payloadAuthority.generation, "cleanup payload reservation");

    renameSync(resolvedSource, payloadPath);
    sourceMoved = true;
    await parentAuthority.handle.sync();
    await reservationAuthority.handle.sync();
    movedAuthority = await openRealDirectoryAuthority(payloadPath);
    const sourceAfterRenameGeneration = directoryGeneration(fstatSync(sourceAuthority.handle.fd, { bigint: true }));
    if (!sameDirectoryGeneration(sourceAfterRenameGeneration, movedAuthority.generation)) {
      throw Object.assign(new Error(`cleanup destination generation mismatch: ${payloadPath}`), {
        code: "ECLEANUP_DESTINATION_GENERATION_MISMATCH",
      });
    }
    try {
      lstatSync(resolvedSource, { bigint: true });
      throw Object.assign(new Error(`cleanup source still exists after rename: ${resolvedSource}`), {
        code: "ECLEANUP_SOURCE_RETAINED",
      });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return payloadPath;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(errorMessage(error));
    throw Object.assign(failure, {
      ...(sourceMoved ? {} : { retainedPath: resolvedSource }),
      ...(sourceMoved && payloadPath ? { recoveryPath: payloadPath } : {}),
      ...(reservationCreated ? { reservationPath: resolvedDestination } : {}),
      ...(action === "archive" && reservationCreated ? { archiveContainerPath: resolvedDestination } : {}),
      ...(action === "archive" && sourceMoved && payloadPath ? { archivePath: payloadPath } : {}),
      ...(action !== "archive" && sourceMoved && payloadPath ? { quarantinePath: payloadPath } : {}),
    });
  } finally {
    await closeAuthority(movedAuthority);
    await closeAuthority(payloadAuthority);
    await closeAuthority(reservationAuthority);
    await closeAuthority(sourceAuthority);
    await closeAuthority(parentAuthority);
    if (destinationParentAuthority !== parentAuthority) await closeAuthority(destinationParentAuthority);
    await closeAuthorities(sourceAncestorAuthorities);
    await closeAuthorities(destinationAncestorAuthorities);
  }
}

async function recordPollutionRecoveryMetadata(
  hubRoot: string,
  projectId: string,
  recovery: LooseRecord,
) {
  try {
    return Boolean(await mutateRegistry(hubRoot, async (registry) => {
      const project = registry.projects[projectId];
      if (!project) return false;
      project.metadata = isRecord(project.metadata) ? project.metadata : {};
      project.metadata.cleanupRecovery = {
        ...recovery,
        recordedAt: nowIso(),
      };
      return true;
    }));
  } catch {
    // The caller already reports the primary registry publication failure.
    return false;
  }
}

export async function cleanupPollution(cpbRoot: string, options: CleanupOptions = {}): Promise<CleanupPollutionReport> {
  const hubRoot = resolvedHubRoot(cpbRoot, options);
  const projectsRemoved = 0;
  let orphanDirsRemoved = 0;
  const sourcePathsPreserved: Array<string | undefined> = [];
  const unsafeProjectsSkipped: PollutionSkip[] = [];
  const errors: CleanupPollutionError[] = [];
  const quarantinedRuntimeDirs: Array<LooseRecord> = [];

  try {
    await assertDeclaredHubRootLineage(cpbRoot, hubRoot);
    await assertRealDirectoryLineage(hubRoot, path.join(hubRoot, "projects"), "cleanup hub projects root");
  } catch (error) {
    errors.push({
      kind: "hub-root",
      phase: "hub-root-validation",
      retainedPath: hubRoot,
      message: errorMessage(error),
    });
    return { projectsRemoved, orphanDirsRemoved, sourcePathsPreserved, unsafeProjectsSkipped, errors, quarantinedRuntimeDirs };
  }

  const pollution = await scanHubPollution(hubRoot);

  if (pollution.candidates.length > 0) {
    for (const candidate of pollution.candidates) {
      const registry = await loadRegistry(hubRoot);
      const project = registry.projects[candidate.projectId];
      if (!project) continue;

      const safety = safePollutionRuntimeTarget({
        hubRoot,
        project,
        projectId: candidate.projectId,
        registry,
      });

      if (!safety.canDelete) {
        unsafeProjectsSkipped.push({
          projectId: candidate.projectId,
          attemptedRoot: project.projectRuntimeRoot || null,
          reason: safety.reason,
        });
        continue;
      }

      const runtimeRoot = path.resolve(project.projectRuntimeRoot);
      let quarantinePath: string;
      try {
        quarantinePath = await durableRenameDirectory({
          source: runtimeRoot,
          destination: randomSiblingQuarantinePath(runtimeRoot),
          action: "pollution",
        });
        quarantinedRuntimeDirs.push({ projectId: candidate.projectId, runtimeRoot, quarantinePath });
      } catch (err) {
        const details = isRecord(err) ? err : {};
        const retainedPath = stringOrNull(details.retainedPath);
        const recoveryPath = stringOrNull(details.recoveryPath);
        const quarantinePath = stringOrNull(details.quarantinePath) || recoveryPath;
        if (recoveryPath && quarantinePath) {
          quarantinedRuntimeDirs.push({
            projectId: candidate.projectId,
            runtimeRoot,
            quarantinePath,
            partial: true,
          });
          await recordPollutionRecoveryMetadata(hubRoot, candidate.projectId, {
            status: "quarantined-unverified",
            phase: "runtime-quarantine-verification",
            runtimeRoot,
            quarantinePath,
            recoveryPath,
            message: errorMessage(err),
          });
        }
        errors.push({
          projectId: candidate.projectId,
          phase: "runtime-quarantine",
          ...(retainedPath ? { retainedPath } : {}),
          ...(quarantinePath ? { quarantinePath } : {}),
          ...(recoveryPath ? { recoveryPath } : {}),
          message: errorMessage(err),
        });
        continue;
      }

      const recovery = {
        status: "quarantined",
        phase: "runtime-quarantine",
        runtimeRoot,
        quarantinePath,
        recoveryPath: quarantinePath,
      };
      try {
        await cleanupTestHooks().beforePollutionRegistryMutation?.({
          projectId: candidate.projectId,
          runtimeRoot,
          quarantinePath,
        });
        const recorded = await mutateRegistry(hubRoot, async (current) => {
          const currentProject = current.projects[candidate.projectId];
          if (!currentProject) return false;
          currentProject.metadata = isRecord(currentProject.metadata) ? currentProject.metadata : {};
          currentProject.metadata.cleanupRecovery = {
            ...recovery,
            recordedAt: nowIso(),
          };
          return true;
        });
        if (!recorded) {
          throw new Error("polluted project registry entry disappeared before recovery metadata publication");
        }
        sourcePathsPreserved.push(project.sourcePath);
      } catch (err) {
        const recoveryRecorded = await recordPollutionRecoveryMetadata(hubRoot, candidate.projectId, {
          ...recovery,
          message: errorMessage(err),
        });
        errors.push({
          projectId: candidate.projectId,
          phase: "registry-recovery",
          quarantinePath,
          recoveryPath: quarantinePath,
          message: recoveryRecorded
            ? errorMessage(err)
            : `${errorMessage(err)}; recovery metadata could not be committed`,
        });
      }
    }
  }

  for (const orphan of pollution.orphanRuntimeDirs) {
    const runtimeDir = stringOrNull(orphan.runtimeDir);
    if (!runtimeDir) continue;
    if (path.basename(runtimeDir).startsWith(CLEANUP_QUARANTINE_PREFIX)) continue;
    const resolvedRuntimeDir = path.resolve(runtimeDir);
    const projectsRoot = path.join(path.resolve(hubRoot), "projects");
    if (path.dirname(resolvedRuntimeDir) !== projectsRoot) {
      errors.push({
        kind: "orphan-runtime-dir",
        dir: runtimeDir,
        retainedPath: runtimeDir,
        message: "orphan runtime dir is not a direct managed child",
      });
      continue;
    }
    try {
      const quarantinePath = await durableRenameDirectory({
        source: resolvedRuntimeDir,
        destination: randomSiblingQuarantinePath(resolvedRuntimeDir),
        action: "pollution",
      });
      quarantinedRuntimeDirs.push({
        kind: "orphan-runtime-dir",
        dir: resolvedRuntimeDir,
        quarantinePath,
      });
      orphanDirsRemoved++;
    } catch (err) {
      const details = isRecord(err) ? err : {};
      const retainedPath = stringOrNull(details.retainedPath);
      const recoveryPath = stringOrNull(details.recoveryPath);
      const quarantinePath = stringOrNull(details.quarantinePath) || recoveryPath;
      if (quarantinePath) {
        quarantinedRuntimeDirs.push({
          kind: "orphan-runtime-dir",
          dir: resolvedRuntimeDir,
          quarantinePath,
          partial: true,
        });
      }
      errors.push({
        kind: "orphan-runtime-dir",
        dir: runtimeDir,
        ...(retainedPath ? { retainedPath } : {}),
        ...(quarantinePath ? { quarantinePath } : {}),
        ...(recoveryPath ? { recoveryPath } : {}),
        message: errorMessage(err),
      });
    }
  }

  return { projectsRemoved, orphanDirsRemoved, sourcePathsPreserved, unsafeProjectsSkipped, errors, quarantinedRuntimeDirs };
}

// ── worktree-retention ──

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
  quarantinePath?: string;
  retainedPath?: string;
  worktreeDirectoryIdentity?: WorktreeDirectoryIdentity;
  result?: "quarantined" | "archived" | "preserved";
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

type CleanupTestHooks = {
  beforeWorktreeAction?: (context: { entry: WorktreeRetentionEntry }) => void | Promise<void>;
  beforeWorktreeRename?: (context: {
    action: "delete" | "archive";
    worktree: string;
    destination: string;
  }) => void | Promise<void>;
  afterArchiveDestinationCheck?: (context: {
    worktree: string;
    destination: string;
  }) => void | Promise<void>;
  beforePollutionRegistryMutation?: (context: {
    projectId?: string;
    runtimeRoot: string;
    quarantinePath: string;
  }) => void | Promise<void>;
};

const cleanupTestHookStorage = new AsyncLocalStorage<CleanupTestHooks>();

function cleanupTestHooks() {
  return cleanupTestHookStorage.getStore() || {};
}

export function withCleanupTestHooksForTests<T>(hooks: CleanupTestHooks, callback: () => T): T {
  const parent = cleanupTestHookStorage.getStore();
  return cleanupTestHookStorage.run(parent ? { ...parent, ...hooks } : hooks, callback);
}

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

async function inspectManagedWorktreePath(
  worktree: string,
  roots: string[],
  cpbRoot: string,
  options: CleanupOptions,
) {
  const root = directManagedWorktreeRoot(worktree, roots);
  if (!root) return { safe: false as const, reason: "worktree is outside managed worktree roots" };
  try {
    await assertDeclaredManagedRootLineage(cpbRoot, resolvedHubRoot(cpbRoot, options), root);
    const [rootInfo, worktreeInfo] = await Promise.all([
      lstat(root, { bigint: true }),
      lstat(path.resolve(worktree), { bigint: true }),
    ]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
      || !worktreeInfo.isDirectory() || worktreeInfo.isSymbolicLink()) {
      return { safe: false as const, reason: "unsafe managed worktree path: expected real directories" };
    }
    const [canonicalRoot, canonicalWorktree] = await Promise.all([realpath(root), realpath(path.resolve(worktree))]);
    if (path.dirname(canonicalWorktree) !== canonicalRoot) {
      return { safe: false as const, reason: "unsafe managed worktree path: canonical path escaped its root" };
    }
    return {
      safe: true as const,
      root,
      worktree: canonicalWorktree,
      directoryIdentity: cleanupWorktreeDirectoryIdentity(worktreeInfo),
    };
  } catch (error) {
    return {
      safe: false as const,
      reason: `unsafe managed worktree path: ${errorCode(error) === "ENOENT" ? "path does not exist" : errorMessage(error)}`,
    };
  }
}

function cleanupWorktreeDirectoryIdentity(info: BigIntStats): WorktreeDirectoryIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
    mode: String(info.mode),
    uid: String(info.uid),
    gid: String(info.gid),
  };
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

  let boundDirectory = safety.directoryIdentity;
  if (job.worktreeOwnership !== undefined && job.worktreeOwnership !== null) {
    let ownership: ReadyWorktreeOwnership;
    try {
      ownership = parseWorktreeOwnership(job.worktreeOwnership) as ReadyWorktreeOwnership;
    } catch (error) {
      return {
        ...base,
        reason: `worktree ownership is invalid; refusing cleanup: ${errorMessage(error)}`,
      };
    }
    if (!sameWorktreeDirectoryIdentity(ownership.directory, safety.directoryIdentity)) {
      return {
        ...base,
        reason: "worktree path no longer matches its durable ownership identity",
      };
    }
    boundDirectory = ownership.directory;
  }
  const boundBase = { ...base, worktreeDirectoryIdentity: boundDirectory };

  // Determine action: explicit policy.completed overrides workflow-aware defaults
  const status = job.status || "unknown";
  if (status === "completed") {
    // policy.completed is null when not explicitly set -> use workflow-aware lookup
    const action = policy.completed || resolveRetentionPolicy(workflow, status);

    if (action === "delete") {
      return { ...boundBase, action: "delete", reason: `completed job worktree (workflow: ${workflow || "unknown"}) selected by policy: delete` };
    }
    if (action === "archive") {
      return { ...boundBase, action: "archive", archivePath: archivePathFor(policy, job.worktree), reason: `completed job worktree (workflow: ${workflow || "unknown"}) selected by policy: archive` };
    }
    return { ...boundBase, reason: `completed job worktree (workflow: ${workflow || "unknown"}) preserved by policy` };
  }

  if (status === "failed" || status === "blocked") {
    return { ...boundBase, reason: `${status} job worktree retained for inspection by default` };
  }

  return { ...boundBase, reason: `${status} job worktree retained because it is not completed` };
}

export async function buildWorktreeRetentionPlan(cpbRoot: string, { policy = {}, dryRun = true, ...options }: WorktreeRetentionOptions = {}): Promise<WorktreeRetentionPlan> {
  const normalizedPolicy = normalizePolicy(cpbRoot, policy);
  const jobs = await listJobsForCleanup(cpbRoot, options);
  const managedRoots = managedWorktreeRoots(cpbRoot, options);

  // Build a set of worktree paths that have associated jobs
  const worktreeByPath = new Map<string, CleanupJob>();
  const durableOwnedDirectories: WorktreeDirectoryIdentity[] = [];
  for (const job of jobs) {
    if (job.jobId && job.worktree && directManagedWorktreeRoot(job.worktree, managedRoots)) {
      worktreeByPath.set(path.resolve(job.worktree), job);
    }
    if (job.worktreeOwnership !== undefined && job.worktreeOwnership !== null) {
      try {
        const ownership = parseWorktreeOwnership(job.worktreeOwnership) as ReadyWorktreeOwnership;
        durableOwnedDirectories.push(ownership.directory);
      } catch {
        // The projected job entry is preserved by entryForJob; an invalid
        // ownership record must never authorize orphan cleanup.
      }
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
      if (entry.name.startsWith(CLEANUP_QUARANTINE_PREFIX)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidatePath = path.join(root, entry.name);
      const resolved = path.resolve(candidatePath);
      if (!worktreeByPath.has(resolved)) {
        const safety = await inspectManagedWorktreePath(candidatePath, managedRoots, cpbRoot, options);
        const durableRecovery = safety.safe && durableOwnedDirectories.some((owned) => (
          sameWorktreeDirectoryIdentity(owned, safety.directoryIdentity)
        ));
        orphans.push({
          project: null,
          status: "unknown",
          workflow: null,
          worktree: candidatePath,
          branch: null,
          baseBranch: null,
          action: "preserve",
          reason: durableRecovery
            ? "orphan pathname contains a durable worktree recovery generation; preserved"
            : safety.safe
              ? "unassociated worktree preserved: absence of a published job is not cleanup authorization"
              : `orphan worktree preserved: ${safety.reason}`,
          ...(safety.safe ? { worktreeDirectoryIdentity: safety.directoryIdentity } : {}),
        });
      }
    }
  }

  // Build entries from jobs with worktrees
  const entries = (await Promise.all(jobs
    .filter((job) => job.jobId && job.worktree)
    .map(async (job) => entryForJob(
      job,
      normalizedPolicy,
      await inspectManagedWorktreePath(job.worktree as string, managedRoots, cpbRoot, options),
    ))))
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
  let hubRootValidationError: string | null = null;
  try {
    await assertDeclaredHubRootLineage(cpbRoot, resolvedHubRoot(cpbRoot, options));
  } catch (error) {
    hubRootValidationError = errorMessage(error);
  }
  const results = [];
  for (const entry of plan.entries) {
    if (hubRootValidationError && entry.action !== "preserve") {
      results.push({
        ...entry,
        action: "preserve",
        retainedPath: entry.worktree,
        reason: `cleanup preserved worktree: ${hubRootValidationError}`,
        result: "preserved",
      });
      continue;
    }
    if (entry.action === "delete") {
      await cleanupTestHooks().beforeWorktreeAction?.({ entry });
      const safety = await inspectManagedWorktreePath(entry.worktree, managedRoots, cpbRoot, options);
      if (!safety.safe) {
        results.push({ ...entry, action: "preserve", reason: safety.reason, result: "preserved" });
        continue;
      }
      if (
        !entry.worktreeDirectoryIdentity
        || !sameWorktreeDirectoryIdentity(entry.worktreeDirectoryIdentity, safety.directoryIdentity)
      ) {
        results.push({
          ...entry,
          action: "preserve",
          retainedPath: safety.worktree,
          reason: "cleanup preserved a worktree whose directory identity changed after planning",
          result: "preserved",
        });
        continue;
      }
      try {
        const quarantinePath = await durableRenameDirectory({
          source: safety.worktree,
          destination: randomSiblingQuarantinePath(safety.worktree),
          action: "delete",
        });
        results.push({
          ...entry,
          worktree: safety.worktree,
          quarantineContainerPath: path.dirname(quarantinePath),
          quarantinePath,
          result: "quarantined",
          reason: `${entry.reason}; moved to cleanup quarantine`,
        });
      } catch (error) {
        const details = isRecord(error) ? error : {};
        const retainedPath = stringOrNull(details.retainedPath);
        const recoveryPath = stringOrNull(details.recoveryPath);
        const quarantinePath = stringOrNull(details.quarantinePath);
        const reservationPath = stringOrNull(details.reservationPath);
        results.push({
          ...entry,
          action: "preserve",
          ...(retainedPath ? { retainedPath } : {}),
          ...(recoveryPath ? { recoveryPath } : {}),
          ...(quarantinePath ? { quarantinePath } : {}),
          ...(reservationPath ? { reservationPath } : {}),
          reason: `cleanup preserved worktree: ${errorMessage(error)}`,
          result: "preserved",
        });
      }
    } else if (entry.action === "archive") {
      await cleanupTestHooks().beforeWorktreeAction?.({ entry });
      const safety = await inspectManagedWorktreePath(entry.worktree, managedRoots, cpbRoot, options);
      if (!safety.safe) {
        results.push({ ...entry, action: "preserve", reason: safety.reason, result: "preserved" });
        continue;
      }
      if (
        !entry.worktreeDirectoryIdentity
        || !sameWorktreeDirectoryIdentity(entry.worktreeDirectoryIdentity, safety.directoryIdentity)
      ) {
        results.push({
          ...entry,
          action: "preserve",
          retainedPath: safety.worktree,
          reason: "cleanup preserved a worktree whose directory identity changed after planning",
          result: "preserved",
        });
        continue;
      }
      try {
        const archiveContainerPath = entry.archivePath!;
        const archivePath = await durableRenameDirectory({
          source: safety.worktree,
          destination: archiveContainerPath,
          action: "archive",
        });
        results.push({ ...entry, worktree: safety.worktree, archiveContainerPath, archivePath, result: "archived" });
      } catch (error) {
        const details = isRecord(error) ? error : {};
        const retainedPath = stringOrNull(details.retainedPath);
        const recoveryPath = stringOrNull(details.recoveryPath);
        const actualArchivePath = stringOrNull(details.archivePath);
        const archiveContainerPath = stringOrNull(details.archiveContainerPath);
        const reservationPath = stringOrNull(details.reservationPath);
        results.push({
          ...entry,
          action: "preserve",
          ...(retainedPath ? { retainedPath } : {}),
          ...(recoveryPath ? { recoveryPath } : {}),
          ...(actualArchivePath ? { archivePath: actualArchivePath } : {}),
          ...(archiveContainerPath ? { archiveContainerPath } : {}),
          ...(reservationPath ? { reservationPath } : {}),
          reason: `archive preserved worktree: ${errorMessage(error)}`,
          result: "preserved",
        });
      }
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
