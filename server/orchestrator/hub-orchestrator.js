import { LeaderLock } from "./leader-lock.js";
import { AssignmentStore } from "./assignment-store.js";
import { WorkerStore } from "./worker-store.js";
import { Scheduler } from "./scheduler.js";
import { WorkerSupervisor } from "./worker-supervisor.js";
import { Reconciler } from "./reconciler.js";
import { FailureRouter } from "./failure-router.js";

const TICK_MS = 2_000; // Main reconciliation tick
const JANITOR_MS = 30_000; // Cleanup stale resources
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class HubOrchestrator {
  constructor(hubRoot, cpbRoot) {
    this.hubRoot = hubRoot;
    this.cpbRoot = cpbRoot;
    this.running = false;

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
    this.reconciler = new Reconciler(hubRoot, {
      assignmentStore: this.assignmentStore,
      workerStore: this.workerStore,
      leaderLock: this.leaderLock,
    });
    this.failureRouter = new FailureRouter();

    this._tickTimer = null;
    this._janitorTimer = null;
    this._backoff = BACKOFF_BASE_MS;
    this._consecutiveErrors = 0;
  }

  async start() {
    this.running = true;

    // Acquire leader lock
    const leader = await this.leaderLock.acquire();
    this.leaderLock.startRenewal();

    // Init stores
    await this.assignmentStore.init();
    await this.workerStore.init();

    // Full reconciliation on startup
    await this.reconciler.recoverRuntime();

    // Start main tick loop
    this._scheduleTick();
    this._scheduleJanitor();
  }

  async stop() {
    this.running = false;
    if (this._tickTimer) { clearTimeout(this._tickTimer); this._tickTimer = null; }
    if (this._janitorTimer) { clearInterval(this._janitorTimer); this._janitorTimer = null; }
    await this.leaderLock.release();
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
    this._tickTimer.unref();
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
    // Reconcile existing assignments first
    await this.reconciler.reconcileAssignments();

    // Try to schedule new work
    const scheduled = await this.scheduler.nextAssignment();
    if (!scheduled) return { idle: true };

    // Start worker for the assignment if needed
    const { assignment, attempt, worker } = scheduled;
    await this.workerSupervisor.ensureWorkerFor(assignment, worker);

    return { scheduled: true, assignmentId: assignment.assignmentId };
  }

  async handleAssignmentResult(assignment, worker, result) {
    if (result.status === "completed") {
      // Idempotent finalize
      const { updateEntry } = await import("../services/hub-queue.js");
      await updateEntry(this.hubRoot, assignment.entryId, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      await this.workerStore.updateWorker(worker.workerId, {
        status: "ready",
        currentAssignmentId: null,
      });
      this.failureRouter.resetBudget(assignment.entryId);
      return;
    }

    // Failure path
    const decision = await this.failureRouter.route({ assignment, attempt: {}, result });
    const { updateEntry } = await import("../services/hub-queue.js");

    switch (decision.action) {
      case "restart_worker_and_retry":
      case "retry_same_worker":
        // Reset queue entry to pending for retry
        await updateEntry(this.hubRoot, assignment.entryId, {
          status: "pending",
          claimedBy: null,
          claimedAt: null,
        });
        await this.workerStore.updateWorker(worker.workerId, {
          status: "ready",
          currentAssignmentId: null,
        });
        break;

      case "wait_for_rate_limit":
        // Reset queue entry to pending, will be picked up later
        await updateEntry(this.hubRoot, assignment.entryId, {
          status: "pending",
          claimedBy: null,
          claimedAt: null,
        });
        await this.workerStore.updateWorker(worker.workerId, {
          status: "ready",
          currentAssignmentId: null,
        });
        break;

      case "mark_blocked":
        await updateEntry(this.hubRoot, assignment.entryId, {
          status: "blocked",
          reason: decision.reason,
        });
        await this.workerStore.updateWorker(worker.workerId, {
          status: "ready",
          currentAssignmentId: null,
        });
        break;

      case "mark_failed":
      default:
        await updateEntry(this.hubRoot, assignment.entryId, {
          status: "failed",
          reason: decision.reason,
        });
        await this.workerStore.updateWorker(worker.workerId, {
          status: "ready",
          currentAssignmentId: null,
        });
        break;
    }
  }

  _recordError(err) {
    // Could log to file, for now stderr
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
