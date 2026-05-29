import { AssignmentStore } from "./assignment-store.js";
import { WorkerStore } from "./worker-store.js";

export class Scheduler {
  constructor(hubRoot, { assignmentStore, workerStore }) {
    this.hubRoot = hubRoot;
    this.assignments = assignmentStore;
    this.workers = workerStore;
  }

  async nextAssignment() {
    const { listQueue, updateEntry } = await import("../services/hub-queue.js");
    const queue = await listQueue(this.hubRoot, { status: "pending" });
    if (queue.length === 0) return null;

    // Sort by priority (P0 > P1 > P2 > P3), then by createdAt
    queue.sort((a, b) => {
      const pa = priorityScore(a.priority);
      const pb = priorityScore(b.priority);
      if (pa !== pb) return pa - pb;
      return a.createdAt.localeCompare(b.createdAt);
    });

    const candidate = queue[0];
    const worker = await this.workers.findIdleWorker(candidate.projectId);
    if (!worker) return null;

    // Create assignment
    const assignment = await this.assignments.createAssignment({
      entryId: candidate.id,
      projectId: candidate.projectId,
      task: candidate.description || candidate.metadata?.task || "",
      sourcePath: candidate.sourcePath || candidate.metadata?.sourcePath,
      workflow: candidate.metadata?.workflow || "standard",
      planMode: candidate.metadata?.planMode || "full",
      sourceContext: candidate.metadata?.sourceContext || {},
    });

    // Create attempt and assign to worker
    const attempt = await this.assignments.createAttempt(assignment.assignmentId, {
      workerId: worker.workerId,
      orchestratorEpoch: 0, // Will be set by orchestrator
    });

    // Write to worker inbox
    await this.workers.writeInbox(worker.workerId, { ...assignment, attempt });

    // Update queue entry
    await updateEntry(this.hubRoot, candidate.id, {
      status: "scheduled",
      claimedBy: worker.workerId,
      claimedAt: new Date().toISOString(),
    });

    // Update worker
    await this.workers.updateWorker(worker.workerId, {
      status: "assigned",
      currentAssignmentId: assignment.assignmentId,
    });

    return { assignment, attempt, worker };
  }
}

function priorityScore(p) {
  const map = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return map[p] ?? 2;
}
