import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../services/logger.js";

const HEARTBEAT_STALE_MS = 60_000;
const ASSIGN_ACCEPT_TTL_MS = 120_000;

export class Reconciler {
  constructor(hubRoot, { assignmentStore, workerStore, leaderLock, failureRouter, hubRoot: _hr }) {
    this.hubRoot = hubRoot;
    this.assignments = assignmentStore;
    this.workers = workerStore;
    this.leaderLock = leaderLock;
    this.failureRouter = failureRouter;
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
            const { updateEntry } = await import("../services/hub-queue.js");
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
            const { updateEntry } = await import("../services/hub-queue.js");
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
            const { listQueue } = await import("../services/hub-queue.js");
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
    const { updateEntry } = await import("../services/hub-queue.js");

    if (result && result.status === "completed") {
      this.log.info(`entry ${assignment.entryId} completed`);
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
        case "wait_for_rate_limit": {
          this.log.info(`entry ${assignment.entryId} retrying (${decision.action}: ${decision.reason})`);
          // Don't retry if the worker is dead (exited/unhealthy)
          const workerId = attempt?.workerId || assignment.workerId;
          if (workerId) {
            const workers = await this.workers.listWorkers();
            const worker = workers.find((w) => w.workerId === workerId);
            if (worker && worker.status !== "online" && worker.status !== "ready" && worker.status !== "running" && worker.status !== "assigned") {
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
          await updateEntry(this.hubRoot, assignment.entryId, {
            status: "pending",
            claimedBy: null,
            claimedAt: null,
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

  async _finalizeWorker(assignment, attempt) {
    await this._guardLeader();
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
    await this._guardLeader();
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
