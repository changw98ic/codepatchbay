import { readFile } from "node:fs/promises";
import path from "node:path";

const HEARTBEAT_STALE_MS = 60_000;
const ASSIGN_ACCEPT_TTL_MS = 120_000;

export class Reconciler {
  constructor(hubRoot, { assignmentStore, workerStore, leaderLock, failureRouter, hubRoot: _hr }) {
    this.hubRoot = hubRoot;
    this.assignments = assignmentStore;
    this.workers = workerStore;
    this.leaderLock = leaderLock;
    this.failureRouter = failureRouter;
  }

  async recoverRuntime() {
    await this.reconcileWorkers();
    await this.reconcileAssignments();
    await this.reconcileQueue();
  }

  async reconcileWorkers() {
    const workers = await this.workers.listWorkers();
    const now = Date.now();

    for (const worker of workers) {
      if (worker.status === "exited") continue;

      if (worker.pid) {
        try { process.kill(worker.pid, 0); } catch {
          await this.workers.updateWorker(worker.workerId, { status: "exited" });
          continue;
        }
      }

      const lastHb = worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).getTime() : 0;
      if (now - lastHb > HEARTBEAT_STALE_MS * 2) {
        await this.workers.updateWorker(worker.workerId, { status: "unhealthy" });
      }
    }
  }

  async reconcileAssignments() {
    const assignments = await this.assignments.listAssignments();

    for (const assignment of assignments) {
      switch (assignment.status) {
        case "scheduled": {
          const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);
          if (!attempt) break;
          const accepted = await this._readAccepted(assignment.assignmentId, attempt.attempt);
          if (accepted) {
            await this.assignments.markRunning(assignment.assignmentId, attempt.attempt);
            // Update queue to in_progress so scheduler doesn't reset it
            const { updateEntry } = await import("../services/hub-queue.js");
            await updateEntry(this.hubRoot, assignment.entryId, {
              status: "in_progress",
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
            await this.assignments.markRunning(assignment.assignmentId, attempt.attempt);
            const { updateEntry } = await import("../services/hub-queue.js");
            await updateEntry(this.hubRoot, assignment.entryId, {
              status: "in_progress",
            });
            break;
          }

          const assignedAt = attempt.createdAt ? new Date(attempt.createdAt).getTime() : 0;
          if (Date.now() - assignedAt > ASSIGN_ACCEPT_TTL_MS) {
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
            await this.assignments.completeAttemptFromExistingResult(assignment.assignmentId, attempt.attempt, result);
            await this._finalizeAssignment(assignment, attempt, result);
            break;
          }

          // Check heartbeat
          const hb = await this._readHeartbeat(assignment.assignmentId, attempt.attempt);
          if (hb) {
            const lastHb = new Date(hb.updatedAt).getTime();
            if (Date.now() - lastHb > HEARTBEAT_STALE_MS * 2) {
              const result = {
                status: "failed",
                jobResult: { status: "failed", failure: { kind: "worker_heartbeat_lost", reason: `heartbeat stale for ${Math.round((Date.now() - lastHb) / 1000)}s` } },
                attemptToken: attempt.attemptToken,
              };
              await this.assignments.writeSyntheticFailure(assignment.assignmentId, attempt.attempt, result);
              await this._finalizeAssignment(assignment, attempt, result);
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

  /**
   * P0-3 fix: compensate incomplete finalization steps.
   * terminal assignment may still need queue/worker finalization.
   */
  async _compensateFinalization(assignment) {
    if (!assignment.queueFinalizedAt) {
      await this._finalizeQueue(assignment);
    }
    if (!assignment.workerFinalizedAt) {
      await this._finalizeWorker(assignment);
    }
  }

  async _finalizeAssignment(assignment, attempt, result) {
    await this._finalizeQueue(assignment, attempt, result);
    await this._finalizeWorker(assignment, attempt);
  }

  async _finalizeQueue(assignment, attempt, result) {
    const { updateEntry } = await import("../services/hub-queue.js");

    if (result && result.status === "completed") {
      await updateEntry(this.hubRoot, assignment.entryId, {
        status: "completed",
        completedAt: new Date().toISOString(),
      });
      this.failureRouter.resetBudget(assignment.entryId);
    } else if (result) {
      const decision = await this.failureRouter.route({ assignment, attempt, result });

      switch (decision.action) {
        case "restart_worker_and_retry":
        case "retry_same_worker":
        case "wait_for_rate_limit":
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "pending",
            claimedBy: null,
            claimedAt: null,
          });
          break;

        case "mark_blocked":
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "blocked",
            reason: decision.reason,
          });
          break;

        case "mark_failed":
        default:
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "failed",
            reason: decision.reason,
          });
          break;
      }
    }

    await this.assignments.markFinalized(assignment.assignmentId, "queue");
  }

  async _finalizeWorker(assignment, attempt) {
    const workerId = attempt?.workerId || assignment.workerId;
    if (workerId) {
      await this.workers.updateWorker(workerId, {
        status: "ready",
        currentAssignmentId: null,
      });
    }
    await this.assignments.markFinalized(assignment.assignmentId, "worker");
  }

  async reconcileQueue() {
    const { listQueue, updateEntry } = await import("../services/hub-queue.js");
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
        await updateEntry(this.hubRoot, entry.id, {
          status: finalStatus,
          ...(finalStatus === "failed" ? { reason: "orphaned_queue_state" } : {}),
        });
      }
    }
  }

  async _readAccepted(assignmentId, attemptNum) {
    try {
      const dir = String(attemptNum).padStart(3, "0");
      return JSON.parse(await readFile(
        path.join(this.hubRoot, "assignments", assignmentId, "attempts", dir, "accepted.json"),
        "utf8",
      ));
    } catch { return null; }
  }

  async _readAttemptResult(assignmentId, attemptNum) {
    try {
      const dir = String(attemptNum).padStart(3, "0");
      return JSON.parse(await readFile(
        path.join(this.hubRoot, "assignments", assignmentId, "attempts", dir, "result.json"),
        "utf8",
      ));
    } catch { return null; }
  }

  async _readHeartbeat(assignmentId, attemptNum) {
    try {
      const dir = String(attemptNum).padStart(3, "0");
      return JSON.parse(await readFile(
        path.join(this.hubRoot, "assignments", assignmentId, "attempts", dir, "heartbeat.json"),
        "utf8",
      ));
    } catch { return null; }
  }
}
