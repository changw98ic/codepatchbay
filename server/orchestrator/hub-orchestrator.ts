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

const TICK_MS = 2_000;
const JANITOR_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

function providerAgentForEntry(entry: any) {
  const agentSpec = entry?.metadata?.agents?.executor || entry?.metadata?.agents?.default || {};
  return agentSpec.agent || "claude";
}

export function normalizedSourceContext(candidate: any) {
  const metadata = candidate?.metadata || {};
  const inherited = metadata.sourceContext && typeof metadata.sourceContext === "object"
    ? { ...metadata.sourceContext }
    : {};
  const queueEntryId = candidate?.id || inherited.queueEntryId || null;

  if (metadata.source === "github" || candidate?.type === "github_issue" || metadata.issueUrl) {
    return {
      ...inherited,
      type: "github_issue",
      queueEntryId,
      issueNumber: metadata.issueNumber ?? inherited.issueNumber ?? null,
      issueUrl: metadata.issueUrl ?? inherited.issueUrl ?? null,
      repo: metadata.repo ?? metadata.repository ?? metadata.repositoryFullName ?? inherited.repo ?? null,
      issueTitle: metadata.issueTitle ?? inherited.issueTitle ?? null,
      actor: metadata.actor ?? inherited.actor ?? null,
      delivery: metadata.delivery ?? inherited.delivery ?? null,
      commandText: metadata.commandText ?? inherited.commandText ?? null,
      triggerReason: metadata.triggerReason ?? inherited.triggerReason ?? null,
      failedQueueId: metadata.originQueueId ?? inherited.failedQueueId ?? null,
      failedJobId: metadata.originJobId ?? inherited.failedJobId ?? null,
      failureArtifact: metadata.failureArtifact ?? inherited.failureArtifact ?? null,
      sddTrace: metadata.sddTrace ?? inherited.sddTrace ?? null,
      sddTask: metadata.sddTask ?? inherited.sddTask ?? null,
      taskId: metadata.sddTask?.id ?? metadata.taskId ?? inherited.taskId ?? null,
      planGroupId: metadata.planGroupId ?? metadata.sddTask?.planGroupId ?? inherited.planGroupId ?? null,
      parentPlanId: metadata.parentPlanId ?? metadata.sddTask?.parentPlanId ?? inherited.parentPlanId ?? null,
      planCacheKey: metadata.planCacheKey ?? metadata.sddTask?.planCacheKey ?? inherited.planCacheKey ?? null,
      contextPackPath: metadata.contextPackPath ?? metadata.contextPack?.path ?? inherited.contextPackPath ?? null,
      contextPack: metadata.contextPack ?? inherited.contextPack ?? null,
    };
  }

  const channel = metadata.channel || metadata.source || inherited.channel || null;
  if (channel) {
    return {
      ...inherited,
      type: inherited.type || channel,
      channel,
      queueEntryId,
      actor: metadata.actor ?? inherited.actor ?? null,
      actorName: metadata.actorName ?? inherited.actorName ?? null,
      teamId: metadata.teamId ?? inherited.teamId ?? null,
      channelId: metadata.channelId ?? inherited.channelId ?? null,
      channelName: metadata.channelName ?? inherited.channelName ?? null,
      commandText: metadata.commandText ?? inherited.commandText ?? null,
      triggerId: metadata.triggerId ?? inherited.triggerId ?? null,
      issueNumber: metadata.issueNumber ?? inherited.issueNumber ?? null,
      issueUrl: metadata.issueUrl ?? inherited.issueUrl ?? null,
      repo: metadata.repo ?? inherited.repo ?? null,
      sddTrace: metadata.sddTrace ?? inherited.sddTrace ?? null,
      sddTask: metadata.sddTask ?? inherited.sddTask ?? null,
      taskId: metadata.sddTask?.id ?? metadata.taskId ?? inherited.taskId ?? null,
      planGroupId: metadata.planGroupId ?? metadata.sddTask?.planGroupId ?? inherited.planGroupId ?? null,
      parentPlanId: metadata.parentPlanId ?? metadata.sddTask?.parentPlanId ?? inherited.parentPlanId ?? null,
      planCacheKey: metadata.planCacheKey ?? metadata.sddTask?.planCacheKey ?? inherited.planCacheKey ?? null,
      contextPackPath: metadata.contextPackPath ?? metadata.contextPack?.path ?? inherited.contextPackPath ?? null,
      contextPack: metadata.contextPack ?? inherited.contextPack ?? null,
    };
  }

  return Object.keys(inherited).length > 0 ? { ...inherited, queueEntryId } : { queueEntryId };
}

export class HubOrchestrator {
  hubRoot: string;
  cpbRoot: string;
  executorRoot: string;
  running: boolean;
  _stopped: Promise<void> | null;
  _resolveStopped?: () => void;
  log: any;
  leaderLock: any;
  assignmentStore: any;
  workerStore: any;
  scheduler: any;
  workerSupervisor: any;
  acpSupervisor: any;
  reconciler: any;
  failureRouter: any;
  _tickTimer: NodeJS.Timeout | null;
  _janitorTimer: NodeJS.Timeout | null;
  _backoff: number;
  _consecutiveErrors: number;

  constructor(hubRoot: string, cpbRoot: string, { executorRoot, acpSupervisor = null }: Record<string, any> = {}) {
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
      providerCapacityFn: (agentKey, entry) => this._providerCapacity(agentKey, entry),
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
    this.running = true;
    this._stopped = new Promise((resolve) => { this._resolveStopped = resolve; });

    // Acquire leader lock
    const leader = await this.leaderLock.acquire();
    this.leaderLock.startRenewal(() => {
      this.log.warn("leader lock renewal failed; stopping hub");
      this.stop().catch(() => {});
    });

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

      try {
        // Fence: ensure lock still held before scheduling
        if (!(await this.leaderLock.stillHeld())) {
          this.log.warn("leader lock lost before schedule");
          await this.stop();
          return { stopped: true, reason: "leader lock lost", dispatched };
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
        const epoch = this.leaderLock.getEpoch();
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

        // Fence: ensure lock still held before updating queue
        if (!(await this.leaderLock.stillHeld())) {
          this.log.warn("leader lock lost before queue update");
          await this.stop();
          return { stopped: true, reason: "leader lock lost", dispatched };
        }

        // Update queue entry
        const { updateEntry } = await import("../services/hub/hub-queue.js");
        await updateEntry(this.hubRoot, candidate.id, {
          status: "scheduled",
          claimedBy: worker.workerId,
          claimedAt: new Date().toISOString(),
        });

        // Update worker
        await this.workerStore.updateWorker(worker.workerId, {
          status: "assigned",
          currentAssignmentId: assignment.assignmentId,
        });

        sLog.info(`dispatched ${assignment.assignmentId} to worker ${worker.workerId}`);
        dispatched.push({ entryId: candidate.id, assignmentId: assignment.assignmentId });
      } catch (err) {
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
          await updateEntry(this.hubRoot, candidate.id, {
            metadata: {
              dispatchFailure: {
                error: err.message,
                retryable: true,
                timestamp: new Date().toISOString(),
              },
            },
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
  async _providerCapacity(agentKey, entry = null) {
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

  _recordError(err) {
    this.log.error(`tick error: ${err.message}`);
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
        if (worker && worker.pid) {
          try { process.kill(worker.pid, 0); } catch {
            eLog.warn(`startup: ${entry.id} worker ${assignment.workerId} PID ${worker.pid} is dead, writing synthetic failure`);
            const attemptNum = assignment.activeAttempt || 1;
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
        ready: workers.filter(w => w.status === "ready").length,
        running: workers.filter(w => w.status === "running").length,
        unhealthy: workers.filter(w => w.status === "unhealthy").length,
        exited: workers.filter(w => w.status === "exited").length,
      },
      supervisor: this.acpSupervisor && typeof this.acpSupervisor.status === "function"
        ? this.acpSupervisor.status()
        : null,
    };
  }
}
