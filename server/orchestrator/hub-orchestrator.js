import { LeaderLock } from "./leader-lock.js";
import { AssignmentStore } from "./assignment-store.js";
import { WorkerStore } from "./worker-store.js";
import { Scheduler } from "./scheduler.js";
import { WorkerSupervisor } from "./worker-supervisor.js";
import { Reconciler } from "./reconciler.js";
import { FailureRouter } from "./failure-router.js";
import { AcpSupervisor } from "./acp-supervisor.js";

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

    // P1-2: create AcpSupervisor (pool loaded lazily on first use)
    const acpSupervisor = new AcpSupervisor({ cpbRoot, hubRoot, pool: null });
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
    this.leaderLock.startRenewal();

    // Init stores
    await this.assignmentStore.init();
    await this.workerStore.init();

    // Full reconciliation on startup
    await this.reconciler.recoverRuntime();

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
      } catch (err) {
        this._recordError(err);
      }
    }, JANITOR_MS);
    this._janitorTimer.unref();
  }

  async tick() {
    // Reconcile existing assignments (includes finalize for completed attempts)
    await this.reconciler.reconcileAssignments();

    // Try to schedule new work
    const candidate = await this.scheduler.nextCandidate();
    if (!candidate) return { idle: true };

    // Full dispatch chain: create assignment → ensure worker → create attempt → write inbox
    const assignment = await this.assignmentStore.createAssignment({
      entryId: candidate.id,
      projectId: candidate.projectId,
      task: candidate.description || candidate.metadata?.task || "",
      sourcePath: candidate.sourcePath || candidate.metadata?.sourcePath,
      workflow: candidate.metadata?.workflow || "standard",
      planMode: candidate.metadata?.planMode || "full",
      sourceContext: candidate.metadata?.sourceContext || {},
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
      attempt: attempt.attempt,
      attemptToken: attempt.attemptToken,
      orchestratorEpoch: attempt.orchestratorEpoch,
    });

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

    return { scheduled: true, assignmentId: assignment.assignmentId };
  }

  _recordError(err) {
    process.stderr.write(`[orchestrator] error: ${err.message}\n`);
  }

  async status() {
    const assignments = await this.assignmentStore.listAssignments();
    const workers = await this.workerStore.listWorkers();
    return {
      orchestrator: {
        status: this.running ? "running" : "stopped",
        hubId: this.leaderLock.getHubId(),
        epoch: this.leaderLock.getEpoch(),
      },
      queue: {
        scheduled: assignments.filter(a => a.status === "scheduled").length,
        running: assignments.filter(a => a.status === "running").length,
        completed: assignments.filter(a => a.status === "completed").length,
        failed: assignments.filter(a => a.status === "failed").length,
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
