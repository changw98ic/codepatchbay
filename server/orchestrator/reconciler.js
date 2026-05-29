import { readFile } from "node:fs/promises";
import path from "node:path";

const HEARTBEAT_STALE_MS = 60_000;

export class Reconciler {
  constructor(hubRoot, { assignmentStore, workerStore, leaderLock }) {
    this.hubRoot = hubRoot;
    this.assignments = assignmentStore;
    this.workers = workerStore;
    this.leaderLock = leaderLock;
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

      // Check if pid alive
      if (worker.pid) {
        try { process.kill(worker.pid, 0); } catch {
          await this.workers.updateWorker(worker.workerId, { status: "exited" });
          continue;
        }
      }

      // Check heartbeat stale
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
        case "scheduled":
          // No worker picked it up yet — will be reassigned by scheduler
          break;

        case "assigned": {
          const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);
          if (!attempt) break;
          const assignedAt = attempt.createdAt ? new Date(attempt.createdAt).getTime() : 0;
          if (Date.now() - assignedAt > 120_000) {
            // Worker didn't accept within 2 min — mark orphaned, scheduler will reassign
            await this.assignments.completeAttempt(assignment.assignmentId, attempt.attempt, {
              status: "failed",
              jobResult: { status: "failed", failure: { kind: "worker_heartbeat_lost", reason: "assignment not accepted within TTL" } },
              attemptToken: attempt.attemptToken,
            });
          }
          break;
        }

        case "running": {
          const attempt = await this.assignments.getActiveAttempt(assignment.assignmentId);
          if (!attempt) break;

          // Check if result.json exists
          const result = await this._readAttemptResult(assignment.assignmentId, attempt.attempt);
          if (result) {
            // Result written but not finalized — finalize now
            await this.assignments.completeAttempt(assignment.assignmentId, attempt.attempt, result);
            break;
          }

          // Check heartbeat
          const hb = await this._readHeartbeat(assignment.assignmentId, attempt.attempt);
          if (hb) {
            const lastHb = new Date(hb.updatedAt).getTime();
            if (Date.now() - lastHb > HEARTBEAT_STALE_MS * 2) {
              await this.assignments.completeAttempt(assignment.assignmentId, attempt.attempt, {
                status: "failed",
                jobResult: { status: "failed", failure: { kind: "worker_heartbeat_lost", reason: `heartbeat stale for ${Math.round((Date.now() - lastHb) / 1000)}s` } },
                attemptToken: attempt.attemptToken,
              });
            }
          }
          break;
        }

        case "completed":
        case "failed":
          // Terminal — nothing to reconcile
          break;
      }
    }
  }

  async reconcileQueue() {
    const { listQueue, updateEntry } = await import("../services/hub-queue.js");
    const assignments = await this.assignments.listAssignments();

    // Build assignment lookup by entryId
    const byEntry = new Map();
    for (const a of assignments) {
      byEntry.set(a.entryId, a);
    }

    // Check running queue entries without assignments
    const running = await listQueue(this.hubRoot, { status: "scheduled" });
    for (const entry of running) {
      const assignment = byEntry.get(entry.id);
      if (!assignment || assignment.status === "completed" || assignment.status === "failed") {
        // Queue says scheduled but assignment is done or missing
        const finalStatus = assignment?.status === "completed" ? "completed" : "failed";
        await updateEntry(this.hubRoot, entry.id, {
          status: finalStatus,
          ...(finalStatus === "failed" ? { reason: "orphaned_queue_state" } : {}),
        });
      }
    }
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
