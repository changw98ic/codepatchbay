import { LeaderLock, readLeaderStatus } from "./leader-lock.js";
import { AssignmentStore } from "./assignment-store.js";
import { WorkerStore } from "./worker-store.js";
import { Scheduler } from "./scheduler.js";
import { WorkerSupervisor } from "./worker-supervisor.js";
import { Reconciler } from "./reconciler.js";
import { FailureRouter } from "./failure-router.js";
import { AcpSupervisor } from "./acp-supervisor.js";
import { createLogger } from "../services/logger.js";

const TICK_MS = 2_000;
const JANITOR_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class HubOrchestrator {
  constructor(hubRoot, cpbRoot) {
    this.hubRoot = hubRoot;
    this.cpbRoot = cpbRoot;
    this.running = false;
    this._stopped = null;
    this.log = createLogger("orchestrator");

    this.leaderLock = new LeaderLock(hubRoot);
    this.assignmentStore = new AssignmentStore(hubRoot);
    this.workerStore = new WorkerStore(hubRoot);
    this.scheduler = new Scheduler(hubRoot, {
      assignmentStore: this.assignmentStore,
      workerStore: this.workerStore,
    });
    this.workerSupervisor = new WorkerSupervisor(hubRoot, cpbRoot, {
      workerStore: this.workerStore,
    });

    // P1-2: supervisor gets lazy pool — only used when pool is actually available
    const acpSupervisor = new AcpSupervisor({ cpbRoot, hubRoot });
    const failureRouter = new FailureRouter(acpSupervisor);

    this.reconciler = new Reconciler(hubRoot, {
      assignmentStore: this.assignmentStore,
      workerStore: this.workerStore,
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

    // Try to schedule new work
    const candidate = await this.scheduler.nextCandidate();
    if (!candidate) return { idle: true };
    const sLog = this.log.child({ traceId: candidate.id });
    sLog.info(`scheduling entry ${candidate.id} for project ${candidate.projectId}`);

    // Full dispatch chain: create assignment → ensure worker → create attempt → write inbox
    // Fence: ensure lock still held before scheduling
    if (!(await this.leaderLock.stillHeld())) {
      this.log.warn("leader lock lost before schedule");
      await this.stop();
      return { stopped: true, reason: "leader lock lost" };
    }

    const assignment = await this.assignmentStore.getOrCreateAssignmentForEntry({
      entryId: candidate.id,
      projectId: candidate.projectId,
      task: candidate.description || candidate.metadata?.task || "",
      sourcePath: candidate.sourcePath || candidate.metadata?.sourcePath,
      workflow: candidate.metadata?.workflow || "standard",
      planMode: candidate.metadata?.planMode || "full",
      sourceContext: candidate.metadata?.sourceContext || {},
      metadata: candidate.metadata || {},
    });

    // Find idle worker or start a new one (P0-1 fix: always proceeds even if no idle worker)
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
      return { stopped: true, reason: "leader lock lost" };
    }

    // Write flattened inbox payload (P0-2 fix: attempt is number, attemptToken is top-level)
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
      return { stopped: true, reason: "leader lock lost" };
    }

    // Update queue entry
    const { updateEntry } = await import("../services/hub-queue.js");
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
    return { scheduled: true, assignmentId: assignment.assignmentId };
  }

  _recordError(err) {
    this.log.error(`tick error: ${err.message}`);
  }

  async reconcileQueueVsAssignments() {
    const { listQueue, updateEntry } = await import("../services/hub-queue.js");
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
      import("../services/hub-queue.js"),
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
        failed: queue.failed,
      },
      workers: {
        ready: workers.filter(w => w.status === "ready").length,
        running: workers.filter(w => w.status === "running").length,
        unhealthy: workers.filter(w => w.status === "unhealthy").length,
        exited: workers.filter(w => w.status === "exited").length,
      },
    };
  }
}
