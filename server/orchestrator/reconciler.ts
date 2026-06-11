import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FailureKind } from "../../core/contracts/failure.js";
import { writeJsonAtomic } from "../../shared/fs-utils.js";
import { createLogger } from "../../shared/logger.js";

const execFile = promisify(execFileCallback);
const HEARTBEAT_STALE_MS = 60_000;
const ASSIGN_ACCEPT_TTL_MS = 120_000;
const DEFAULT_PROGRESS_INFO_MS = 5 * 60_000;
const DEFAULT_PROGRESS_WARN_MS = 15 * 60_000;
const DEFAULT_PROGRESS_ERROR_MS = 30 * 60_000;
const DEFAULT_PROGRESS_FORCE_RETRY_MS = 35 * 60_000;
const NON_REUSABLE_WORKER_STATUSES = new Set(["dead", "exited", "unhealthy", "draining"]);
const PREVIOUS_OUTPUT_MAX = 4000;
const PROGRESS_PROBE_LOG_TAIL = 6000;
const PROGRESS_ALERT_RANK: Record<string, number> = { info: 1, warn: 2, error: 3, force: 4 };
const PROGRESS_PROBE_DEPTH: Record<string, string> = { info: "heartbeat", warn: "worker", error: "deep", force: "deep" };
const PROGRESS_PROBE_INTERVAL_MS: Record<string, number> = { info: 5 * 60_000, warn: 60_000, error: 60_000, force: 0 };
const DEEP_PROGRESS_PROBE_LEVELS = new Set(["error", "force"]);
const WAITLESS_LOG_PATTERNS = [
  /\bjob failed\b/i,
  /\bfatal\b/i,
  /\buncaught\b/i,
  /\bunhandled\b/i,
  /\bEADDRINUSE\b/,
  /\bENOENT\b/,
];

type AnyRecord = Record<string, any>;

function resolveProgressThresholdMs(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function truncateText(value: unknown, maxChars = PREVIOUS_OUTPUT_MAX) {
  const text = String(value || "");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function compactText(value: unknown, maxChars = 500) {
  if (value === undefined || value === null) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function compactStructuredValue(value: any, { maxItems = 8, maxChars = 500 }: Record<string, any> = {}): any {
  if (value === undefined || value === null) return value;
  if (typeof value === "string") return compactText(value, maxChars);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.slice(0, maxItems).map((item) => compactStructuredValue(item, { maxItems, maxChars }));
  }
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, maxItems)
      .map(([key, item]) => [key, compactStructuredValue(item, { maxItems, maxChars })]),
  );
}

function compactVerifierArtifact(artifact: any) {
  if (!artifact || typeof artifact !== "object") return null;
  return {
    kind: artifact.kind || null,
    id: artifact.id || null,
    name: artifact.name || null,
    path: artifact.path || null,
    bytes: artifact.bytes ?? null,
    sha256: artifact.sha256 || null,
  };
}

function compactVerifierVerdict(verdict: any) {
  if (!verdict || typeof verdict !== "object") return null;
  const blocking = Array.isArray(verdict.blocking)
    ? compactStructuredValue(verdict.blocking, { maxItems: 8, maxChars: 500 })
    : [];
  const retryScope = Array.isArray(verdict.fix_scope)
    ? compactStructuredValue(verdict.fix_scope, { maxItems: 8, maxChars: 500 })
    : [];
  return {
    status: verdict.status || null,
    confidence: verdict.confidence ?? null,
    reason: compactText(verdict.reason),
    summary: compactText(verdict.summary),
    taskGoal: compactText(verdict.task_goal),
    executorSummary: compactText(verdict.executor_summary),
    diffSummary: compactText(verdict.diff_summary),
    layers: verdict.layers && typeof verdict.layers === "object"
      ? compactStructuredValue(verdict.layers, { maxItems: 8, maxChars: 500 })
      : null,
    blocking,
    retryScope,
    blockingMissingInputs: Array.isArray(verdict.blockingMissingInputs)
      ? compactStructuredValue(verdict.blockingMissingInputs, { maxItems: 8, maxChars: 500 })
      : [],
  };
}

function verificationRetryContext(failure: any) {
  const cause = failure?.cause || {};
  const verdict = compactVerifierVerdict(cause.verdict || failure?.verdict);
  const artifact = compactVerifierArtifact(cause.artifact || failure?.artifact);
  if (!verdict && !artifact) return null;
  return {
    verdict,
    artifact,
    retryScope: verdict?.retryScope || [],
  };
}

function summarizeBlockingForRetry(blocking: any) {
  if (!Array.isArray(blocking) || blocking.length === 0) return [];
  return blocking.map((entry) => {
    if (typeof entry === "string") return `- ${entry}`;
    if (!entry || typeof entry !== "object") return `- ${String(entry)}`;
    const parts = [];
    if (entry.criterion) parts.push(entry.criterion);
    if (entry.file) parts.push(`file: ${entry.file}`);
    if (entry.evidence) parts.push(`evidence: ${entry.evidence}`);
    if (entry.fix_hint || entry.fixHint) parts.push(`hint: ${entry.fix_hint || entry.fixHint}`);
    return `- ${parts.join(" | ") || JSON.stringify(entry)}`;
  });
}

function verifierRetryOutputChunk(failure: any) {
  const verification = verificationRetryContext(failure);
  if (!verification) return "";
  const verdict: AnyRecord = verification.verdict || {};
  const lines = [
    "Verifier verdict:",
    verdict.status ? `status: ${verdict.status}` : "",
    verdict.reason ? `reason: ${verdict.reason}` : "",
    verdict.summary ? `summary: ${verdict.summary}` : "",
  ];
  const blocking = summarizeBlockingForRetry(verdict.blocking);
  if (blocking.length) lines.push("blocking:", ...blocking);
  if (verification.retryScope.length) lines.push("retry scope:", ...verification.retryScope.map((scope) => `- ${scope}`));
  if (verification.artifact?.path) lines.push(`verdict artifact: ${verification.artifact.path}`);
  return lines.filter(Boolean).join("\n");
}

function extractPreviousOutput(failure: any) {
  const cause = failure?.cause || {};
  const chunks = [];
  const verifierChunk = verifierRetryOutputChunk(failure);
  if (verifierChunk) chunks.push(verifierChunk);
  if (failure?.stderrSnippet) chunks.push(`stderr snippet:\n${failure.stderrSnippet}`);
  if (cause.rawOutput) chunks.push(`raw output:\n${cause.rawOutput}`);
  if (cause.stdoutTail) chunks.push(`stdout tail:\n${cause.stdoutTail}`);
  if (cause.stderrTail) chunks.push(`stderr tail:\n${cause.stderrTail}`);
  if (cause.stdout) chunks.push(`stdout:\n${cause.stdout}`);
  if (cause.stderr) chunks.push(`stderr:\n${cause.stderr}`);
  if (Array.isArray(cause.checks)) {
    for (const check of cause.checks) {
      if (check?.stdoutTail) chunks.push(`${check.command || check.gate || "check"} stdout tail:\n${check.stdoutTail}`);
      if (check?.stderrTail) chunks.push(`${check.command || check.gate || "check"} stderr tail:\n${check.stderrTail}`);
      if (check?.message && !check?.stdoutTail && !check?.stderrTail) chunks.push(`${check.command || check.gate || "check"} message:\n${check.message}`);
    }
  }
  return truncateText(chunks.filter(Boolean).join("\n\n"));
}

function previousFailureCount(assignment: any, base: any) {
  const candidates = [
    assignment?.metadata?.failureCount,
    assignment?.failureCount,
    base?.retry?.failureCount,
    base?.previousFailure?.retryCount,
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

export function buildRetrySourceContext(assignment: any, attempt: any, result: any, decision: any) {
  const failure = result?.jobResult?.failure || result?.failure || {};
  const base = assignment.sourceContext && typeof assignment.sourceContext === "object"
    ? { ...assignment.sourceContext }
    : {};
  const previousOutput = extractPreviousOutput(failure);
  const retryCount = previousFailureCount(assignment, base) + 1;
  const retry = {
    failureKind: failure.kind || "unknown",
    failureReason: failure.reason || decision?.reason || "retry requested",
    previousOutput,
    previousJobId: result?.jobResult?.jobId || result?.jobId || base.previousJobId || null,
    previousAttempt: attempt?.attempt ?? assignment?.attempts ?? null,
    previousPhase: failure.phase || result?.jobResult?.failure?.phase || null,
    retryAction: decision?.action || null,
    retryReason: decision?.reason || null,
    retryable: decision?.retryable ?? failure.retryable ?? null,
    retryCount,
    failureCount: retryCount,
    retryQueuedAt: new Date().toISOString(),
    verification: verificationRetryContext(failure),
  };
  return {
    ...base,
    retry,
    previousFailure: {
      kind: retry.failureKind,
      reason: retry.failureReason,
      jobId: retry.previousJobId,
      phase: retry.previousPhase,
      attempt: retry.previousAttempt,
      retryCount,
      verification: retry.verification,
    },
  };
}

export class Reconciler {
  hubRoot: string;
  assignments: any;
  workers: any;
  workerSupervisor: any;
  leaderLock: any;
  failureRouter: any;
  progressInfoMs: number;
  progressWarnMs: number;
  progressErrorMs: number;
  progressForceRetryMs: number;
  progressAlertLevels: Map<any, any>;
  progressProbeCheckedAt: Map<any, any>;
  log: any;

  constructor(hubRoot: string, {
    assignmentStore,
    workerStore,
    workerSupervisor,
    leaderLock,
    failureRouter,
    hubRoot: _hr,
    progressInfoMs,
    progressWarnMs,
    progressErrorMs,
    progressForceRetryMs,
    progressStaleMs,
  }: Record<string, any>) {
    this.hubRoot = hubRoot;
    this.assignments = assignmentStore;
    this.workers = workerStore;
    this.workerSupervisor = workerSupervisor || null;
    this.leaderLock = leaderLock;
    this.failureRouter = failureRouter;
    this.progressInfoMs = resolveProgressThresholdMs(
      progressInfoMs ?? process.env.CPB_ASSIGNMENT_PROGRESS_INFO_MS,
      DEFAULT_PROGRESS_INFO_MS,
    );
    this.progressWarnMs = resolveProgressThresholdMs(
      progressWarnMs ?? process.env.CPB_ASSIGNMENT_PROGRESS_WARNING_MS ?? process.env.CPB_ASSIGNMENT_PROGRESS_WARN_MS,
      DEFAULT_PROGRESS_WARN_MS,
    );
    this.progressErrorMs = resolveProgressThresholdMs(
      progressErrorMs ?? process.env.CPB_ASSIGNMENT_PROGRESS_ERROR_MS,
      DEFAULT_PROGRESS_ERROR_MS,
    );
    this.progressForceRetryMs = resolveProgressThresholdMs(
      progressForceRetryMs ?? progressStaleMs ?? process.env.CPB_ASSIGNMENT_PROGRESS_FORCE_RETRY_MS ?? process.env.CPB_ASSIGNMENT_PROGRESS_STALE_MS,
      DEFAULT_PROGRESS_FORCE_RETRY_MS,
    );
    this.progressAlertLevels = new Map();
    this.progressProbeCheckedAt = new Map();
    this.log = createLogger("reconciler");
  }

  /**
   * Fencing: refuse to mutate orchestrator state if leader lock is lost.
   */
  async _guardLeader() {
    if (!(await this.leaderLock.stillHeld())) {
      throw new Error("leader lock lost; refusing to mutate orchestrator state");
    }
  }

  async recoverRuntime() {
    await this.reconcileWorkers();
    await this.reconcileAssignments();
    await this.reconcileQueue();
  }

  async reconcileWorkers() {
    await this._guardLeader();
    const workers = await this.workers.listWorkers();
    const now = Date.now();

    for (const worker of workers) {
      if (worker.status === "exited") continue;

      if (worker.pid) {
        try { process.kill(worker.pid, 0); } catch {
          this.log.info(`worker ${worker.workerId} pid ${worker.pid} marked exited (dead PID)`);
          await this.workers.updateWorker(worker.workerId, { status: "exited" });
          continue;
        }
      }

      const lastHb = worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).getTime() : 0;
      if (now - lastHb > HEARTBEAT_STALE_MS * 2) {
        this.log.warn(`worker ${worker.workerId} marked unhealthy (stale heartbeat)`);
        await this.workers.updateWorker(worker.workerId, { status: "unhealthy" });
      }
    }
  }

  async reconcileAssignments() {
    await this._guardLeader();
    const assignments = await this.assignments.listAssignments();

    for (const assignment of assignments) {
      const aLog = this.log.child({ traceId: assignment.assignmentId });
      switch (assignment.status) {
        case "scheduled": {
          const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);
          if (!attempt) break;
          const accepted = await this._readAccepted(assignment.assignmentId, attempt.attempt);
          if (accepted) {
            aLog.info(`assignment ${assignment.assignmentId} accepted by worker, markRunning`);
            await this.assignments.markRunning(assignment.assignmentId, attempt.attempt);
            // Update queue to in_progress so scheduler doesn't reset it
            const { updateEntry } = await import("../services/hub/hub-queue.js");
            await updateEntry(this.hubRoot, assignment.entryId, {
              status: "in_progress",
              claimedAt: new Date().toISOString(),
            });
          }
          break;
        }

        case "assigned": {
          const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);
          if (!attempt) break;

          // Check accepted.json first
          const accepted = await this._readAccepted(assignment.assignmentId, attempt.attempt);
          if (accepted) {
            aLog.info(`assignment ${assignment.assignmentId} accepted by worker, markRunning`);
            await this.assignments.markRunning(assignment.assignmentId, attempt.attempt);
            const { updateEntry } = await import("../services/hub/hub-queue.js");
            await updateEntry(this.hubRoot, assignment.entryId, {
              status: "in_progress",
              claimedAt: new Date().toISOString(),
            });
            break;
          }

          // Check if worker claimed queue entry directly (claimEligible) without
          // writing accepted.json — the dual-path race.  If the queue entry is
          // in_progress with a fresh claim, treat it as accepted.
          {
            const { listQueue } = await import("../services/hub/hub-queue.js");
            const claimed = await listQueue(this.hubRoot, { status: "in_progress", projectId: assignment.projectId });
            const match = claimed.find((e) => e.id === assignment.entryId);
            if (match?.claimedAt) {
              const claimedAtMs = new Date(match.claimedAt).getTime();
              if (Date.now() - claimedAtMs < ASSIGN_ACCEPT_TTL_MS) {
                await this.assignments.markRunning(assignment.assignmentId, attempt.attempt);
                break;
              }
            }
          }

          const assignedAt = attempt.createdAt ? new Date(attempt.createdAt).getTime() : 0;
          if (Date.now() - assignedAt > ASSIGN_ACCEPT_TTL_MS) {
            aLog.warn(`assignment ${assignment.assignmentId} not accepted within TTL, writing synthetic failure`);
            // P0-4 fix: use writeSyntheticFailure for reconciler-created failures
            const result = {
              status: "failed",
              jobResult: { status: "failed", failure: { kind: "worker_heartbeat_lost", reason: "assignment not accepted within TTL" } },
              attemptToken: attempt.attemptToken,
            };
            await this.assignments.writeSyntheticFailure(assignment.assignmentId, attempt.attempt, result);
            await this._finalizeAssignment(assignment, attempt, result);
          }
          break;
        }

        case "running": {
          const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);
          if (!attempt) break;

          // Check result.json → validate + finalize (P0-4: worker wrote, store validates)
          const result = await this._readAttemptResult(assignment.assignmentId, attempt.attempt);
          if (result) {
            aLog.info(`assignment ${assignment.assignmentId} completed`);
            await this.assignments.completeAttemptFromExistingResult(assignment.assignmentId, attempt.attempt, result);
            await this._finalizeAssignment(assignment, attempt, result);
            break;
          }

          // Check heartbeat
          const hb = await this._readHeartbeat(assignment.assignmentId, attempt.attempt);
          if (hb) {
            const lastHb = new Date(hb.updatedAt).getTime();
            if (Date.now() - lastHb > HEARTBEAT_STALE_MS * 2) {
              aLog.warn(`assignment ${assignment.assignmentId} heartbeat stale for ${Math.round((Date.now() - lastHb) / 1000)}s`);
              const result = {
                status: "failed",
                jobResult: { status: "failed", failure: { kind: "worker_heartbeat_lost", reason: `heartbeat stale for ${Math.round((Date.now() - lastHb) / 1000)}s` } },
                attemptToken: attempt.attemptToken,
              };
              await this.assignments.writeSyntheticFailure(assignment.assignmentId, attempt.attempt, result);
              await this._finalizeAssignment(assignment, attempt, result);
              break;
            }

            const progressDelay = this._classifyProgressDelay(assignment, attempt, hb);
            if (progressDelay) {
              const probe = await this._maybeProbeProgressDelay(assignment, attempt, hb, progressDelay);
              if (probe) progressDelay.cause.probe = probe;
              this._logProgressDelay(aLog, assignment, attempt, progressDelay);
              const shouldFail = progressDelay.shouldFail || probe?.waitUseful === false;
              if (!shouldFail) break;
              if (probe?.waitUseful === false && !progressDelay.shouldFail) {
                aLog.error(`assignment ${assignment.assignmentId} progress probe closed early: ${probe.reason}`);
              }
              const reason = probe?.waitUseful === false
                ? `${progressDelay.reason}; probe confirmed waiting cannot recover: ${probe.reason}`
                : progressDelay.reason;
              const result = {
                status: "failed",
                jobResult: {
                  status: "failed",
                  failure: {
                    kind: FailureKind.ASSIGNMENT_PROGRESS_STALE,
                    phase: progressDelay.phase,
                    reason,
                    retryable: true,
                    cause: progressDelay.cause,
                  },
                },
                attemptToken: attempt.attemptToken,
              };
              await this.assignments.writeSyntheticFailure(assignment.assignmentId, attempt.attempt, result);
              await this._finalizeAssignment(assignment, attempt, result);
              break;
            }
          }
          break;
        }

        case "completed":
        case "failed":
          // P0-3 fix: terminal != finalized — compensate incomplete finalization
          await this._compensateFinalization(assignment);
          break;
      }
    }
  }

  _classifyProgressDelay(assignment, attempt, heartbeat) {
    if (!this.progressForceRetryMs) return null;
    if (!heartbeat || heartbeat.status !== "running") return null;

    const progressAt = heartbeat.progressUpdatedAt || heartbeat.lastProgressAt || heartbeat.phaseUpdatedAt;
    if (!progressAt) return null;

    const progressMs = new Date(progressAt).getTime();
    if (!Number.isFinite(progressMs)) return null;

    const ageMs = Date.now() - progressMs;
    if (ageMs < 0) return null;

    let level = null;
    let thresholdMs = 0;
    if (ageMs >= this.progressForceRetryMs) {
      level = "force";
      thresholdMs = this.progressForceRetryMs;
    } else if (this.progressErrorMs && ageMs >= this.progressErrorMs) {
      level = "error";
      thresholdMs = this.progressErrorMs;
    } else if (this.progressWarnMs && ageMs >= this.progressWarnMs) {
      level = "warn";
      thresholdMs = this.progressWarnMs;
    } else if (this.progressInfoMs && ageMs >= this.progressInfoMs) {
      level = "info";
      thresholdMs = this.progressInfoMs;
    }
    if (!level) return null;

    const phase = heartbeat.activePhase || heartbeat.phase || null;
    const phaseLabel = phase ? `phase ${phase}` : "active phase";
    const ageSec = Math.round(ageMs / 1000);
    const thresholdSec = Math.round(thresholdMs / 1000);
    const forceSec = Math.round(this.progressForceRetryMs / 1000);
    const detail = level === "force"
      ? `force retry threshold ${forceSec}s`
      : `${level} threshold ${thresholdSec}s; force retry at ${forceSec}s`;
    const cause: AnyRecord = {
      assignmentId: assignment.assignmentId,
      entryId: assignment.entryId,
      attempt: attempt?.attempt ?? null,
      activeJobId: heartbeat.activeJobId || null,
      activePhase: heartbeat.activePhase || null,
      lastProgressAt: progressAt,
      lastProgressType: heartbeat.lastProgressType || heartbeat.progressKind || null,
      heartbeatAt: heartbeat.updatedAt || null,
      worktreePath: heartbeat.worktreePath || null,
      workerPid: heartbeat.pid || null,
      ageMs,
      infoThresholdMs: this.progressInfoMs,
      warnThresholdMs: this.progressWarnMs,
      errorThresholdMs: this.progressErrorMs,
      forceRetryThresholdMs: this.progressForceRetryMs,
    };
    return {
      level,
      shouldFail: level === "force",
      phase,
      reason: `${phaseLabel} made no progress for ${ageSec}s (${detail})`,
      cause,
    };
  }

  _logProgressDelay(aLog, assignment, attempt, progressDelay) {
    const key = `${assignment.assignmentId}:${attempt?.attempt ?? "unknown"}`;
    const rank = PROGRESS_ALERT_RANK[progressDelay.level] || 0;
    const previousRank = this.progressAlertLevels.get(key) || 0;
    if (rank <= previousRank) return;

    this.progressAlertLevels.set(key, rank);
    const logLevel = progressDelay.level === "force" ? "error" : progressDelay.level;
    aLog[logLevel](`assignment ${assignment.assignmentId} progress ${progressDelay.level}: ${progressDelay.reason}`);
  }

  async _maybeProbeProgressDelay(assignment, attempt, heartbeat, progressDelay) {
    const key = `${assignment.assignmentId}:${attempt?.attempt ?? "unknown"}:${progressDelay.level}`;
    const intervalMs = PROGRESS_PROBE_INTERVAL_MS[progressDelay.level] ?? 60_000;
    const now = Date.now();
    const lastCheckedAt = this.progressProbeCheckedAt.get(key) || 0;
    if (intervalMs && now - lastCheckedAt < intervalMs) return null;

    this.progressProbeCheckedAt.set(key, now);
    const probe = await this._probeProgressDelay(assignment, attempt, heartbeat, progressDelay);
    await this._writeProgressProbe(assignment.assignmentId, attempt.attempt, progressDelay.level, probe);
    return probe;
  }

  async _probeProgressDelay(assignment, attempt, heartbeat, progressDelay) {
    const depth = PROGRESS_PROBE_DEPTH[progressDelay.level] || "heartbeat";
    const workerId = attempt?.workerId || assignment.workerId || heartbeat.workerId || null;
    const probe = {
      checkedAt: new Date().toISOString(),
      level: progressDelay.level,
      depth,
      waitUseful: true,
      reason: null,
      failureSignals: [],
      heartbeat: {
        status: heartbeat.status || null,
        updatedAt: heartbeat.updatedAt || null,
        progressUpdatedAt: heartbeat.progressUpdatedAt || heartbeat.lastProgressAt || heartbeat.phaseUpdatedAt || null,
        progressKind: heartbeat.progressKind || null,
        lastProgressType: heartbeat.lastProgressType || null,
        activePhase: heartbeat.activePhase || heartbeat.phase || null,
        activeJobId: heartbeat.activeJobId || null,
        worktreePath: heartbeat.worktreePath || null,
      },
      worker: null,
      attemptFiles: null,
      workerLog: null,
      worktree: null,
    };

    if (depth === "heartbeat") return probe;

    const worker = workerId ? await this.workers.getWorker(workerId) : null;
    const pid = heartbeat.pid || worker?.pid || null;
    const pidAlive = this._pidAlive(pid);
    probe.worker = {
      workerId,
      found: Boolean(worker),
      status: worker?.status || null,
      pid,
      pidAlive,
      currentAssignmentId: worker?.currentAssignmentId || null,
      lastHeartbeatAt: worker?.lastHeartbeatAt || null,
    };

    if (!worker) {
      this._addProbeFailure(probe, "worker_registry_missing");
    } else {
      if (NON_REUSABLE_WORKER_STATUSES.has(worker.status)) {
        this._addProbeFailure(probe, `worker_status_${worker.status}`);
      }
      if (worker.currentAssignmentId && worker.currentAssignmentId !== assignment.assignmentId) {
        this._addProbeFailure(probe, "worker_assignment_mismatch");
      }
    }
    if (pid && pidAlive === false) {
      this._addProbeFailure(probe, "worker_pid_dead");
    }

    if (!DEEP_PROGRESS_PROBE_LEVELS.has(progressDelay.level)) {
      this._finishProbe(probe);
      return probe;
    }

    const attemptDir = this._attemptDir(assignment.assignmentId, attempt.attempt);
    const resultPath = path.join(attemptDir, "result.json");
    const resultExists = await this._pathExists(resultPath);
    probe.attemptFiles = {
      acceptedExists: await this._pathExists(path.join(attemptDir, "accepted.json")),
      heartbeatExists: await this._pathExists(path.join(attemptDir, "heartbeat.json")),
      resultExists,
      resultReadable: resultExists ? Boolean(await this._readAttemptResult(assignment.assignmentId, attempt.attempt)) : null,
    };
    if (probe.attemptFiles.resultExists && probe.attemptFiles.resultReadable === false) {
      this._addProbeFailure(probe, "result_file_unreadable");
    }

    probe.workerLog = await this._probeWorkerLog(workerId, resultExists);
    if (probe.workerLog?.indicatesFailedJob) {
      this._addProbeFailure(probe, "worker_log_failed_without_result");
    }

    probe.worktree = await this._probeWorktree(heartbeat.worktreePath);
    if (probe.worktree?.path && probe.worktree.exists === false) {
      this._addProbeFailure(probe, "worktree_missing");
    }

    this._finishProbe(probe);
    return probe;
  }

  _addProbeFailure(probe, signal) {
    if (!probe.failureSignals.includes(signal)) probe.failureSignals.push(signal);
  }

  _finishProbe(probe) {
    if (probe.failureSignals.length === 0) return;
    probe.waitUseful = false;
    probe.reason = probe.failureSignals.join(", ");
  }

  _pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async _probeWorkerLog(workerId, resultExists) {
    if (!workerId) return null;
    const logPath = path.join(this.hubRoot, "logs", `worker-${workerId}.log`);
    try {
      const logTail = truncateText(await readFile(logPath, "utf8"), PROGRESS_PROBE_LOG_TAIL);
      const indicatesFailedJob = !resultExists && WAITLESS_LOG_PATTERNS.some((pattern) => pattern.test(logTail));
      return { path: logPath, exists: true, tail: logTail, indicatesFailedJob };
    } catch {
      return { path: logPath, exists: false, tail: "", indicatesFailedJob: false };
    }
  }

  async _probeWorktree(worktreePath) {
    if (!worktreePath) return null;
    const info: AnyRecord = { path: worktreePath, exists: false, gitStatus: null };
    try {
      const pathStat = await stat(worktreePath);
      info.exists = pathStat.isDirectory();
    } catch {
      return info;
    }
    if (!info.exists) return info;
    try {
      const { stdout } = await execFile("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        timeout: 3000,
        maxBuffer: 64 * 1024,
      });
      info.gitStatus = truncateText(stdout, 2000);
    } catch (err) {
      info.gitStatusError = err.message;
    }
    return info;
  }

  async _writeProgressProbe(assignmentId, attemptNum, level, probe) {
    try {
      await writeJsonAtomic(path.join(this._attemptDir(assignmentId, attemptNum), `progress-probe-${level}.json`), probe);
    } catch {
      // Probe persistence is diagnostic only; reconciliation must continue.
    }
  }

  /**
   * P0-3 fix: compensate incomplete finalization steps.
   * terminal assignment may still need queue/worker finalization.
   */
  async _compensateFinalization(assignment) {
    const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);

    if (!assignment.queueFinalizedAt) {
      if (!attempt) {
        // No attempt info — cannot finalize queue, skip
        return;
      }
      const result = await this._readAttemptResult(assignment.assignmentId, attempt.attempt);
      if (!result) {
        // No result — cannot finalize queue, skip (worker may still be writing)
        return;
      }
      await this._finalizeQueue(assignment, attempt, result);
    }
    if (!assignment.workerFinalizedAt) {
      await this._finalizeWorker(assignment, attempt);
    }
  }

  async _finalizeAssignment(assignment, attempt, result) {
    await this._finalizeQueue(assignment, attempt, result);
    await this._finalizeWorker(assignment, attempt);
  }

  async _finalizeQueue(assignment, attempt, result) {
    await this._guardLeader();
    const { updateEntry } = await import("../services/hub/hub-queue.js");

    if (result && result.status === "completed") {
      this.log.info(`entry ${assignment.entryId} completed`);
      await updateEntry(this.hubRoot, assignment.entryId, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      this.failureRouter.resetBudget(assignment.entryId);
    } else if (result && result.status === "cancelled") {
      const reason = result.jobResult?.failure?.reason || result.failure?.reason || "assignment cancelled";
      this.log.info(`entry ${assignment.entryId} cancelled`);
      await updateEntry(this.hubRoot, assignment.entryId, {
        status: "cancelled",
        completedAt: new Date().toISOString(),
        metadata: {
          cancelReason: reason,
          cancelledAt: new Date().toISOString(),
        },
      });
      this.failureRouter.resetBudget(assignment.entryId);
    } else if (result) {
      const decision = await this.failureRouter.route({ assignment, attempt, result });

      switch (decision.action) {
        case "restart_worker_and_retry":
        case "retry_same_worker":
        case "wait_for_rate_limit": {
          this.log.info(`entry ${assignment.entryId} retrying (${decision.action}: ${decision.reason})`);
          // Don't retry if the worker is dead (exited/unhealthy)
          const workerId = attempt?.workerId || assignment.workerId;
          if (workerId) {
            const workers = await this.workers.listWorkers();
            const worker = workers.find((w) => w.workerId === workerId);
            if (
              decision.action !== "restart_worker_and_retry" &&
              worker &&
              worker.status !== "online" &&
              worker.status !== "ready" &&
              worker.status !== "running" &&
              worker.status !== "assigned"
            ) {
              await updateEntry(this.hubRoot, assignment.entryId, {
                status: "failed",
                metadata: {
                  failureReason: `worker ${workerId} is ${worker.status}: ${decision.reason}`,
                  failedAt: new Date().toISOString(),
                },
              });
              break;
            }
          }
          if (decision.action === "restart_worker_and_retry") {
            await this._stopWorkerForRestart(assignment, attempt, decision.reason);
          }
          const retrySourceContext = buildRetrySourceContext(assignment, attempt, result, decision);
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "pending",
            claimedBy: null,
            claimedAt: null,
            workerId: null,
            metadata: {
              sourceContext: retrySourceContext,
              lastFailureKind: retrySourceContext.retry?.failureKind || "unknown",
              failureCount: retrySourceContext.retry?.failureCount || 1,
              retryDecision: {
                action: decision.action,
                reason: decision.reason,
                retryable: decision.retryable ?? null,
                retryAt: new Date().toISOString(),
                untilTs: decision.untilTs ?? null,
              },
            },
          });
          break;
        }

        case "mark_blocked":
          this.log.warn(`entry ${assignment.entryId} blocked: ${decision.reason}`);
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "blocked",
            reason: decision.reason,
          });
          break;

        case "reroute":
          this.log.info(`entry ${assignment.entryId} reroute: ${decision.reason}`);
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "pending",
            claimedBy: null,
            claimedAt: null,
            workerId: null,
            metadata: {
              ...(assignment.sourceContext || {}),
              workflow: decision.params?.workflow || assignment.workflow,
              planMode: decision.params?.planMode || assignment.planMode,
              supervisorDecision: {
                action: decision.action,
                reason: decision.reason,
                reroutedAt: new Date().toISOString(),
              },
            },
          });
          break;

        case "switch_agent":
          this.log.info(`entry ${assignment.entryId} switch_agent: ${decision.reason}`);
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "pending",
            claimedBy: null,
            claimedAt: null,
            workerId: null,
            metadata: {
              ...(assignment.sourceContext || {}),
              agentsOverride: decision.params || {},
              supervisorDecision: {
                action: decision.action,
                reason: decision.reason,
                switchedAt: new Date().toISOString(),
              },
            },
          });
          break;

        case "request_human_approval":
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "blocked",
            reason: decision.reason || "human approval requested by supervisor",
            metadata: {
              ...(assignment.sourceContext || {}),
              supervisorDecision: {
                action: decision.action,
                reason: decision.reason,
                blockedAt: new Date().toISOString(),
              },
            },
          });
          break;

        case "mark_failed":
        default:
          this.log.warn(`entry ${assignment.entryId} marked failed: ${decision.reason || "reconciler mark_failed"}`);
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "failed",
            metadata: {
              failureReason: decision.reason || "reconciler mark_failed",
              failedAt: new Date().toISOString(),
            },
          });
          break;
      }
    }

    await this.assignments.markFinalized(assignment.assignmentId, "queue");
  }

  async _stopWorkerForRestart(assignment, attempt, reason) {
    const workerId = attempt?.workerId || assignment.workerId;
    if (!workerId || !this.workerSupervisor?.stopWorker) return;
    try {
      await this.workerSupervisor.stopWorker(workerId, reason || "restart_worker_and_retry");
    } catch (err) {
      this.log.warn(`worker ${workerId} restart stop failed: ${err.message}`);
    }
  }

  async _finalizeWorker(assignment, attempt) {
    await this._guardLeader();
    const workerId = attempt?.workerId || assignment.workerId;
    if (workerId) {
      const worker = await this.workers.getWorker(workerId);
      const updates: AnyRecord = { currentAssignmentId: null };
      if (!NON_REUSABLE_WORKER_STATUSES.has(worker?.status)) {
        updates.status = "ready";
      }
      await this.workers.updateWorker(workerId, updates);
    }
    await this.assignments.markFinalized(assignment.assignmentId, "worker");
  }

  async reconcileQueue() {
    await this._guardLeader();
    const { listQueue, updateEntry } = await import("../services/hub/hub-queue.js");
    const assignments = await this.assignments.listAssignments();

    const byEntry = new Map();
    for (const a of assignments) {
      byEntry.set(a.entryId, a);
    }

    const scheduled = await listQueue(this.hubRoot, { status: "scheduled" });
    for (const entry of scheduled) {
      const assignment = byEntry.get(entry.id);
      if (!assignment || assignment.status === "completed" || assignment.status === "failed") {
        const finalStatus = assignment?.status === "completed" ? "completed" : "failed";
        this.log.warn(`orphaned scheduled entry ${entry.id} → ${finalStatus}`);
        await updateEntry(this.hubRoot, entry.id, {
          status: finalStatus,
          ...(finalStatus === "failed" ? { reason: "orphaned_queue_state" } : {}),
        });
      }
    }
  }

  async _readAccepted(assignmentId, attemptNum) {
    try {
      return JSON.parse(await readFile(
        path.join(this._attemptDir(assignmentId, attemptNum), "accepted.json"),
        "utf8",
      ));
    } catch { return null; }
  }

  async _readAttemptResult(assignmentId, attemptNum) {
    try {
      return JSON.parse(await readFile(
        path.join(this._attemptDir(assignmentId, attemptNum), "result.json"),
        "utf8",
      ));
    } catch { return null; }
  }

  async _readHeartbeat(assignmentId, attemptNum) {
    try {
      return JSON.parse(await readFile(
        path.join(this._attemptDir(assignmentId, attemptNum), "heartbeat.json"),
        "utf8",
      ));
    } catch { return null; }
  }

  _attemptDir(assignmentId, attemptNum) {
    return path.join(this.hubRoot, "assignments", assignmentId, "attempts", String(attemptNum).padStart(3, "0"));
  }

  async _pathExists(filePath) {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
