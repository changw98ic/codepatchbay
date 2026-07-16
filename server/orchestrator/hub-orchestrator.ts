import { recordValue, type LooseRecord } from "../../shared/types.js";
import { LeaderLock, readLeaderStatus } from "./leader-lock.js";
import { AssignmentStore } from "../../shared/orchestrator/assignment-store.js";
import { WorkerStore } from "../../shared/orchestrator/worker-store.js";
import { Scheduler } from "./scheduler.js";
import { WorkerSupervisor } from "./worker-supervisor.js";
import { Reconciler } from "./reconciler.js";
import { FailureRouter } from "./failure-router.js";
import { AcpSupervisor } from "./acp-supervisor.js";
import { createLogger } from "../../shared/logger.js";
import { resolveExecutorRoot } from "../services/setup.js";
import { resolveHubConcurrencyLimits } from "../services/infra.js";
import { getProject } from "../services/hub/hub-registry.js";
import { assertHubWritable, recoverStaleHubMaintenance } from "../../shared/hub-maintenance.js";
import os from "node:os";

const TICK_MS = 2_000;

function textOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}
const JANITOR_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function providerAgentForEntry(entry: LooseRecord) {
  const metadata = recordValue(entry.metadata);
  const agents = recordValue(metadata.agents);
  const agentSpec = recordValue(agents.executor || agents.default);
  return typeof agentSpec.agent === "string" ? agentSpec.agent : "claude";
}

export function normalizedSourceContext(candidate: LooseRecord) {
  const metadata = recordValue(candidate.metadata);
  const inherited = recordValue(metadata.sourceContext);
  const contextPack = recordValue(metadata.contextPack);
  const schedulerDecision = metadata.schedulerDecision ?? inherited.schedulerDecision ?? null;
  const queueEntryId = textOrNull(candidate?.id || inherited.queueEntryId);

  if (metadata.source === "github" || candidate?.type === "github_issue" || metadata.issueUrl) {
    return {
      ...inherited,
      type: "github_issue",
      queueEntryId,
      issueNumber: metadata.issueNumber ?? inherited.issueNumber ?? null,
      issueUrl: textOrNull(metadata.issueUrl ?? inherited.issueUrl),
      repo: textOrNull(metadata.repo ?? metadata.repository ?? metadata.repositoryFullName ?? inherited.repo),
      issueTitle: textOrNull(metadata.issueTitle ?? inherited.issueTitle),
      actor: metadata.actor ?? inherited.actor ?? null,
      delivery: textOrNull(metadata.delivery ?? inherited.delivery),
      commandText: textOrNull(metadata.commandText ?? inherited.commandText),
      triggerReason: textOrNull(metadata.triggerReason ?? inherited.triggerReason),
      failedQueueId: textOrNull(metadata.originQueueId ?? inherited.failedQueueId),
      failedJobId: textOrNull(metadata.originJobId ?? inherited.failedJobId),
      failureArtifact: textOrNull(metadata.failureArtifact ?? inherited.failureArtifact),
      taskId: textOrNull(metadata.taskId ?? inherited.taskId),
      planGroupId: textOrNull(metadata.planGroupId ?? inherited.planGroupId),
      parentPlanId: textOrNull(metadata.parentPlanId ?? inherited.parentPlanId),
      planCacheKey: textOrNull(metadata.planCacheKey ?? inherited.planCacheKey),
      contextPackPath: textOrNull(metadata.contextPackPath ?? contextPack.path ?? inherited.contextPackPath),
      contextPack: metadata.contextPack ?? inherited.contextPack ?? null,
      schedulerDecision,
    };
  }

  const channel = metadata.channel || metadata.source || inherited.channel || null;
  if (channel) {
    return {
      ...inherited,
      type: textOrNull(inherited.type || channel),
      channel: textOrNull(channel),
      queueEntryId,
      actor: metadata.actor ?? inherited.actor ?? null,
      actorName: textOrNull(metadata.actorName ?? inherited.actorName),
      teamId: textOrNull(metadata.teamId ?? inherited.teamId),
      channelId: textOrNull(metadata.channelId ?? inherited.channelId),
      channelName: textOrNull(metadata.channelName ?? inherited.channelName),
      commandText: textOrNull(metadata.commandText ?? inherited.commandText),
      triggerId: textOrNull(metadata.triggerId ?? inherited.triggerId),
      issueNumber: metadata.issueNumber ?? inherited.issueNumber ?? null,
      issueUrl: textOrNull(metadata.issueUrl ?? inherited.issueUrl),
      repo: textOrNull(metadata.repo ?? inherited.repo),
      taskId: textOrNull(metadata.taskId ?? inherited.taskId),
      planGroupId: textOrNull(metadata.planGroupId ?? inherited.planGroupId),
      parentPlanId: textOrNull(metadata.parentPlanId ?? inherited.parentPlanId),
      planCacheKey: textOrNull(metadata.planCacheKey ?? inherited.planCacheKey),
      contextPackPath: textOrNull(metadata.contextPackPath ?? contextPack.path ?? inherited.contextPackPath),
      contextPack: metadata.contextPack ?? inherited.contextPack ?? null,
      schedulerDecision,
    };
  }

  return Object.keys(inherited).length > 0
    ? { ...inherited, queueEntryId, schedulerDecision }
    : { queueEntryId, schedulerDecision };
}

export class HubOrchestrator {
  hubRoot: string;
  cpbRoot: string;
  executorRoot: string;
  running: boolean;
  _stopped: Promise<void> | null;
  _resolveStopped?: () => void;
  log: ReturnType<typeof createLogger>;
  leaderLock: LeaderLock;
  assignmentStore: AssignmentStore;
  workerStore: WorkerStore;
  scheduler: Scheduler;
  workerSupervisor: WorkerSupervisor;
  acpSupervisor: AcpSupervisor | null;
  reconciler: Reconciler;
  failureRouter: FailureRouter;
  _tickTimer: NodeJS.Timeout | null;
  _janitorTimer: NodeJS.Timeout | null;
  _backoff: number;
  _consecutiveErrors: number;

  constructor(hubRoot: string, cpbRoot: string, { executorRoot, acpSupervisor = null }: { executorRoot?: string; acpSupervisor?: AcpSupervisor | null } = {}) {
    this.hubRoot = hubRoot;
    this.cpbRoot = cpbRoot;
    this.executorRoot = executorRoot || resolveExecutorRoot({ env: process.env, fallbackRoot: cpbRoot });
    this.running = false;
    this._stopped = null;
    this.log = createLogger("orchestrator");

    this.leaderLock = new LeaderLock(hubRoot);
    this.assignmentStore = new AssignmentStore(hubRoot);
    this.workerStore = new WorkerStore(hubRoot);
    this.scheduler = new Scheduler(hubRoot, {
      assignmentStore: this.assignmentStore,
      workerStore: this.workerStore,
      cpbRoot,
      getProjectFn: getProject,
      providerCapacityFn: (agentKey: string, entry: LooseRecord) => this._providerCapacity(agentKey, entry),
    });
    this.workerSupervisor = new WorkerSupervisor(hubRoot, cpbRoot, {
      workerStore: this.workerStore,
      executorRoot: this.executorRoot,
    });

    this.acpSupervisor = acpSupervisor || new AcpSupervisor({ cpbRoot, hubRoot });
    const readModeFn = async () => {
      const { readHubConfig: rhc, readSchedulerConfig: rsc } = await import("../services/agent/agent-config.js");
      return rsc(await rhc(hubRoot)).mode;
    };
    const failureRouter = new FailureRouter(this.acpSupervisor, { readModeFn });

    this.reconciler = new Reconciler(hubRoot, {
      assignmentStore: this.assignmentStore,
      workerStore: this.workerStore,
      workerSupervisor: this.workerSupervisor,
      leaderLock: this.leaderLock,
      failureRouter,
      hubRoot,
    });
    this.failureRouter = failureRouter;

    this._tickTimer = null;
    this._janitorTimer = null;
    this._backoff = BACKOFF_BASE_MS;
    this._consecutiveErrors = 0;
  }

  async start() {
    const { recoverInterruptedHubRestore } = await import("../services/hub/hub-backup.js");
    await recoverInterruptedHubRestore({
      hubRoot: this.hubRoot,
      signingKey: process.env.CPB_HUB_BACKUP_SIGNING_KEY,
    });
    await recoverStaleHubMaintenance(this.hubRoot);
    await assertHubWritable(this.hubRoot);
    this.running = true;
    this._stopped = new Promise((resolve) => { this._resolveStopped = resolve; });

    // Acquire leader lock
    const leader = await this.leaderLock.acquire();
    this.leaderLock.startRenewal(() => {
      this.log.warn("leader lock renewal failed; stopping hub");
      this.stop().catch(() => {});
    });
    try {
      // Init stores
      await this.assignmentStore.init();
      await this.workerStore.init();
      await this._startSupervisor();

      // Full reconciliation on startup
      await this.reconciler.recoverRuntime();
      await this.reconcileQueueVsAssignments();

      // Start main tick loop (NOT unref'd — this keeps the process alive)
      this._scheduleTick();
      // Janitor can be unref'd — tick loop is the keepalive
      this._scheduleJanitor();
    } catch (error) {
      // Do not leave a failed initialization holding the shared lease for its
      // full TTL. stop() also disarms renewal while the retained stale process
      // fence keeps any tail callback fail-closed.
      await this.stop();
      throw error;
    }
  }

  async stop() {
    this.running = false;
    if (this._tickTimer) { clearTimeout(this._tickTimer); this._tickTimer = null; }
    if (this._janitorTimer) { clearInterval(this._janitorTimer); this._janitorTimer = null; }
    await this.leaderLock.release();
    if (this._resolveStopped) this._resolveStopped();
  }

  /**
   * Block until stop() is called. Used by CLI to keep process alive.
   */
  async waitUntilStopped() {
    if (this._stopped) await this._stopped;
  }

  async _startSupervisor() {
    if (!this.acpSupervisor || typeof this.acpSupervisor.start !== "function") return null;
    try {
      return await this.acpSupervisor.start();
    } catch (err) {
      this.log.warn(`resident supervisor start failed: ${err.message}`);
      return null;
    }
  }

  _scheduleTick() {
    this._tickTimer = setTimeout(async () => {
      if (!this.running) return;
      try {
        await this.tick();
        this._backoff = BACKOFF_BASE_MS;
        this._consecutiveErrors = 0;
      } catch (err) {
        this._consecutiveErrors++;
        this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX_MS);
        this._recordError(err);
      }
      this._scheduleTick();
    }, this._consecutiveErrors > 3 ? this._backoff : TICK_MS);
    // Do NOT unref — this timer is the process keepalive (P0-4 fix)
  }

  _scheduleJanitor() {
    this._janitorTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.workerSupervisor.checkHealth();
        await this.reconcileQueueVsAssignments();
      } catch (err) {
        this._recordError(err);
      }
    }, JANITOR_MS);
    this._janitorTimer.unref();
  }

  async tick() {
    try {
      await assertHubWritable(this.hubRoot);
    } catch (error) {
      this.log.warn(error instanceof Error ? error.message : String(error));
      await this.stop();
      return { stopped: true, reason: "Hub maintenance became active" };
    }
    // Fencing: stop hub if leader lock is lost
    if (!(await this.leaderLock.stillHeld())) {
      this.log.warn("leader lock lost; stopping hub");
      await this.stop();
      return { stopped: true, reason: "leader lock lost" };
    }

    // Reconcile existing assignments (includes finalize for completed attempts)
    await this.reconciler.reconcileAssignments();

    // Try to schedule new work — batch of candidates for parallel dispatch
    const candidates = await this.scheduler.nextCandidates(Infinity);
    if (candidates.length === 0) return { idle: true };

    const dispatched = [];
    const dispatchFailures = [];

    for (const candidate of candidates) {
      const sLog = this.log.child({ traceId: candidate.id });
      sLog.info(`scheduling entry ${candidate.id} for project ${candidate.projectId}`);
      let reservation: LooseRecord | null = null;
      let inboxWritten = false;
      let workerReservation: { workerId: string; incarnationToken?: string; assignmentId: string; attemptToken: string } | null = null;

      try {
        // Fence: ensure lock still held before scheduling
        if (!(await this.leaderLock.stillHeld())) {
          this.log.warn("leader lock lost before schedule");
          await this.stop();
          return { stopped: true, reason: "leader lock lost", dispatched };
        }

        const epoch = this.leaderLock.getEpoch();
        const { updateEntry } = await import("../services/hub/hub-queue.js");
        reservation = await updateEntry(this.hubRoot, candidate.id, {
          status: "scheduled",
          claimedBy: `orchestrator:${epoch}`,
          claimedAt: new Date().toISOString(),
          // Persist the exact smart-scheduler score/rank/evidence that led to
          // dispatch. Keeping this only on the in-memory candidate made the
          // decision disappear on a leader crash before assignment creation.
          metadata: candidate.metadata,
        }, {
          expectedStatus: "pending",
          expectedUpdatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : null,
        });
        if (!reservation) {
          sLog.info(`skipping ${candidate.id}: queue state changed before dispatch reservation`);
          continue;
        }

        const assignment = await this.assignmentStore.getOrCreateAssignmentForEntry({
          entryId: candidate.id,
          projectId: candidate.projectId,
          task: candidate.description || candidate.metadata?.task || "",
          sourcePath: candidate.sourcePath || candidate.metadata?.sourcePath,
          workflow: candidate.metadata?.workflow || "standard",
          planMode: candidate.metadata?.planMode || "full",
          sourceContext: normalizedSourceContext(candidate),
          metadata: candidate.metadata || {},
        });

        // Find idle worker or start a new one
        const existingWorker = await this.scheduler.findIdleWorker(candidate.projectId);
        const worker = await this.workerSupervisor.ensureWorkerFor(assignment, existingWorker);

        // Create attempt with real epoch
        const attempt = await this.assignmentStore.createAttempt(assignment.assignmentId, {
          workerId: worker.workerId,
          orchestratorEpoch: epoch,
        });

        // Fence: ensure lock still held before writing inbox
        if (!(await this.leaderLock.stillHeld())) {
          this.log.warn("leader lock lost before write inbox");
          await this.stop();
          return { stopped: true, reason: "leader lock lost", dispatched };
        }

        // Reserve the worker before publishing the inbox record. Otherwise a
        // fast worker can claim the message while it still appears idle.
        const expectedWorker: Record<string, unknown> = {
          currentAssignmentId: null,
          currentAttemptToken: null,
          status: "ready",
        };
        if (typeof worker.incarnationToken === "string") {
          expectedWorker.incarnationToken = worker.incarnationToken;
        }
        const reservedWorker = await this.workerStore.updateWorkerIf(worker.workerId, {
          status: "assigned",
          currentAssignmentId: assignment.assignmentId,
          currentAttemptToken: attempt.attemptToken,
        }, expectedWorker);
        if (!reservedWorker) throw new Error(`worker reservation lost before dispatch: ${worker.workerId}`);
        workerReservation = {
          workerId: worker.workerId,
          incarnationToken: typeof worker.incarnationToken === "string" ? worker.incarnationToken : undefined,
          assignmentId: assignment.assignmentId,
          attemptToken: String(attempt.attemptToken),
        };

        // Write flattened inbox payload
        await this.workerStore.writeInbox(worker.workerId, {
          assignmentId: assignment.assignmentId,
          entryId: assignment.entryId,
          projectId: assignment.projectId,
          task: assignment.task,
          sourcePath: assignment.sourcePath,
          workflow: assignment.workflow,
          planMode: assignment.planMode,
          sourceContext: assignment.sourceContext,
          metadata: assignment.metadata || {},
          attempt: attempt.attempt,
          attemptToken: attempt.attemptToken,
          orchestratorEpoch: attempt.orchestratorEpoch,
        });
        inboxWritten = true;

        // Fence: ensure lock still held before updating queue
        if (!(await this.leaderLock.stillHeld())) {
          this.log.warn("leader lock lost before queue update");
          await this.stop();
          return { stopped: true, reason: "leader lock lost", dispatched };
        }

        // Update queue entry
        const claimed = await updateEntry(this.hubRoot, candidate.id, {
          status: "scheduled",
          claimedBy: worker.workerId,
          claimedAt: new Date().toISOString(),
        }, {
          expectedStatus: "scheduled",
          expectedUpdatedAt: typeof reservation.updatedAt === "string" ? reservation.updatedAt : null,
        });
        if (!claimed) throw new Error(`queue reservation lost before dispatch: ${candidate.id}`);

        sLog.info(`dispatched ${assignment.assignmentId} to worker ${worker.workerId}`);
        dispatched.push({ entryId: candidate.id, assignmentId: assignment.assignmentId });
      } catch (err) {
        if (workerReservation && !inboxWritten) {
          await this.workerStore.updateWorkerIf(workerReservation.workerId, {
            status: "ready",
            currentAssignmentId: null,
            currentAttemptToken: null,
          }, {
            incarnationToken: workerReservation.incarnationToken,
            currentAssignmentId: workerReservation.assignmentId,
            currentAttemptToken: workerReservation.attemptToken,
            status: "assigned",
          }).catch(() => null);
        }
        sLog.error(`dispatch failed for ${candidate.id}: ${err.message}`);
        dispatchFailures.push({
          entryId: candidate.id,
          error: err.message,
          retryable: true,
          timestamp: new Date().toISOString(),
        });
        // Attach dispatch failure metadata to the entry so it's visible
        try {
          const { updateEntry } = await import("../services/hub/hub-queue.js");
          const patch = inboxWritten ? {} : {
            status: "pending",
            claimedBy: null,
            claimedAt: null,
          };
          await updateEntry(this.hubRoot, candidate.id, {
            ...patch,
            metadata: {
              dispatchFailure: {
                error: err.message,
                retryable: true,
                timestamp: new Date().toISOString(),
              },
            },
          }, reservation ? {
            expectedStatus: "scheduled",
            expectedUpdatedAt: typeof reservation.updatedAt === "string" ? reservation.updatedAt : null,
          } : {
            expectedStatus: "pending",
            expectedUpdatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : null,
          });
        } catch { /* best-effort metadata write */ }
      }
    }

    if (dispatched.length > 0) {
      return { scheduled: true, dispatched, dispatchFailures };
    }
    if (dispatchFailures.length > 0) {
      return { scheduled: false, dispatched: [], dispatchFailures };
    }
    return { idle: true };
  }

  /**
   * Provider capacity for one candidate provider.
   * Returns provider-scoped slots so Scheduler can project same-tick
   * dispatches before queue status writes make capacity visible.
   */
  async _providerCapacity(agentKey: string, entry: LooseRecord | null = null) {
    const providerKey = agentKey || providerAgentForEntry(entry);
    const hubLimits = await resolveHubConcurrencyLimits(this.hubRoot);
    const total = hubLimits.acpProviderMax;
    const { listQueue } = await import("../services/hub/hub-queue.js");
    const entries = await listQueue(this.hubRoot);
    const active = entries.filter((e) => (
      (e.status === "in_progress" || e.status === "scheduled") &&
      providerAgentForEntry(e) === providerKey
    )).length;
    return {
      providerKey,
      active,
      total,
      available: Math.max(0, total - active),
    };
  }

  _recordError(err: unknown) {
    this.log.error(`tick error: ${err instanceof Error ? err.message : String(err)}`);
  }

  async reconcileQueueVsAssignments() {
    const { listQueue, updateEntry } = await import("../services/hub/hub-queue.js");
    const entries = await listQueue(this.hubRoot, { status: "in_progress" });
    const scheduled = await listQueue(this.hubRoot, { status: "scheduled" });
    const allEntries = [...entries, ...scheduled];

    for (const entry of allEntries) {
      const assignmentId = `a-${entry.id}`;
      const assignment = await this.assignmentStore.getAssignment(assignmentId);
      const eLog = this.log.child({ traceId: entry.id });

      if (!assignment) {
        eLog.warn(`startup: ${entry.id} has no assignment, resetting to pending`);
        await updateEntry(this.hubRoot, entry.id, { status: "pending", claimedBy: null, claimedAt: null });
        continue;
      }

      if (assignment.status === "completed" || assignment.status === "failed") {
        const finalStatus = assignment.status === "completed" ? "completed" : "failed";
        eLog.warn(`startup: ${entry.id} assignment is ${assignment.status} but queue is ${entry.status}, aligning`);
        await updateEntry(this.hubRoot, entry.id, {
          status: finalStatus,
          ...(finalStatus === "failed" ? { metadata: { failureReason: "assignment terminal on startup", failedAt: new Date().toISOString() } } : {}),
        });
        continue;
      }

      if (assignment.workerId) {
        const worker = await this.workerStore.getWorker(assignment.workerId);
        if (worker && worker.pid && (worker.host === "local" || worker.host === os.hostname())) {
          try { process.kill(worker.pid, 0); } catch {
            eLog.warn(`startup: ${entry.id} worker ${assignment.workerId} PID ${worker.pid} is dead, writing synthetic failure`);
            const attemptNum = typeof assignment.activeAttempt === "number" ? assignment.activeAttempt : Number(assignment.activeAttempt || 1);
            await this.assignmentStore.writeSyntheticFailure(assignment.assignmentId, attemptNum, {
              assignmentId: assignment.assignmentId,
              attempt: attemptNum,
              status: "failed",
              jobResult: { status: "failed", failure: { kind: "worker_heartbeat_lost", reason: `worker PID ${worker.pid} dead on startup` } },
              writtenAt: new Date().toISOString(),
            });
            await updateEntry(this.hubRoot, entry.id, {
              status: "failed",
              metadata: { failureReason: "worker dead on startup", failedAt: new Date().toISOString() },
            });
            await this.workerStore.updateWorker(assignment.workerId, { status: "exited" });
          }
        }
      }
    }
  }

  async status() {
    const [{ queueStatus }, workers, leaderStatus] = await Promise.all([
      import("../services/hub/hub-queue.js"),
      this.workerStore.listWorkers(),
      readLeaderStatus(this.hubRoot),
    ]);
    const queue = await queueStatus(this.hubRoot);
    return {
      orchestrator: leaderStatus,
      queue: {
        scheduled: queue.scheduled,
        running: queue.inProgress,
        completed: queue.completed,
        blocked: queue.blocked,
        failed: queue.failed,
      },
      workers: {
        ready: workers.filter((w: LooseRecord) => w.status === "ready").length,
        running: workers.filter((w: LooseRecord) => w.status === "running").length,
        unhealthy: workers.filter((w: LooseRecord) => w.status === "unhealthy").length,
        exited: workers.filter((w: LooseRecord) => w.status === "exited").length,
      },
      supervisor: this.acpSupervisor && typeof this.acpSupervisor.status === "function"
        ? this.acpSupervisor.status()
        : null,
    };
  }
}
