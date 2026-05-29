import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { writeJsonAtomic, writeJsonOnce } from "../services/fs-utils.js";

const ASSIGNMENTS_DIR = "assignments";

export class AssignmentStore {
  constructor(hubRoot) {
    this.baseDir = path.join(hubRoot, ASSIGNMENTS_DIR);
  }

  async init() {
    await mkdir(this.baseDir, { recursive: true });
  }

  /**
   * Idempotent: creates assignment on first call, updates mutable fields on retry/reroute.
   * Preserves attempt history (counter + attempt directories) across retries.
   */
  async getOrCreateAssignmentForEntry({ entryId, projectId, task, sourcePath, workflow, planMode, sourceContext }) {
    const id = `a-${entryId}`;
    const dir = path.join(this.baseDir, id);

    // Preserve existing assignment on retry/reroute — don't reset attempt history
    const existing = await this._readState(id);
    if (existing) {
      const updated = {
        ...existing,
        // Update mutable fields (may change on reroute)
        workflow: workflow || existing.workflow,
        planMode: planMode || existing.planMode,
        sourceContext: { ...existing.sourceContext, ...(sourceContext || {}) },
        task: task || existing.task,
        sourcePath: sourcePath || existing.sourcePath,
        // Reset scheduling state for new attempt
        status: "scheduled",
        resultWrittenAt: null,
        queueFinalizedAt: null,
        workerFinalizedAt: null,
      };
      await writeJsonAtomic(path.join(dir, "input.json"), updated);
      await this._writeState(id, updated);
      return updated;
    }

    // First creation — full initialization
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(dir, "attempts"), { recursive: true });

    const assignment = {
      assignmentId: id,
      entryId,
      projectId,
      task,
      sourcePath,
      workflow: workflow || "standard",
      planMode: planMode || "full",
      sourceContext: sourceContext || {},
      status: "scheduled",
      createdAt: new Date().toISOString(),
      // P0-3 fix: finalization tracking
      resultWrittenAt: null,
      queueFinalizedAt: null,
      workerFinalizedAt: null,
    };

    await writeJsonAtomic(path.join(dir, "input.json"), assignment);
    await writeJsonAtomic(path.join(dir, "state.json"), { ...assignment, attempts: 0 });

    return assignment;
  }

  async createAttempt(assignmentId, { workerId, orchestratorEpoch }) {
    const state = await this._readState(assignmentId);
    const attemptNum = (state.attempts || 0) + 1;
    const attemptDir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"));
    await mkdir(attemptDir, { recursive: true });
    await mkdir(path.join(attemptDir, "control"), { recursive: true });

    const attemptToken = crypto.randomBytes(16).toString("hex");
    const attempt = {
      assignmentId,
      attempt: attemptNum,
      entryId: state.entryId,
      projectId: state.projectId,
      workerId,
      status: "assigned",
      orchestratorEpoch,
      attemptToken,
      createdAt: new Date().toISOString(),
    };

    await writeJsonAtomic(path.join(attemptDir, "attempt.json"), attempt);

    state.attempts = attemptNum;
    state.activeAttempt = attemptNum;
    state.status = "assigned";
    state.assignedAt = new Date().toISOString();
    state.workerId = workerId;
    await this._writeState(assignmentId, state);

    return attempt;
  }

  async markRunning(assignmentId, attemptNum) {
    const state = await this._readState(assignmentId);
    state.status = "running";
    state.startedAt = new Date().toISOString();

    const attempt = await this._readAttempt(assignmentId, attemptNum);
    attempt.status = "running";
    attempt.acceptedAt = new Date().toISOString();

    await this._writeAttempt(assignmentId, attemptNum, attempt);
    await this._writeState(assignmentId, state);
  }

  async recordHeartbeat(assignmentId, attemptNum, heartbeat) {
    const dir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"));
    await writeJsonAtomic(
      path.join(dir, "heartbeat.json"),
      { ...heartbeat, updatedAt: new Date().toISOString() },
    );
  }

  /**
   * P0-4 fix: Validate a worker-written result and update assignment/attempt state.
   * Does NOT write result.json — worker already wrote it.
   */
  async completeAttemptFromExistingResult(assignmentId, attemptNum, result) {
    const attempt = await this._readAttempt(assignmentId, attemptNum);
    if (!result.attemptToken) {
      throw new Error(`missing attempt token for ${assignmentId} attempt ${attemptNum}`);
    }
    if (result.attemptToken !== attempt.attemptToken) {
      throw new Error(`attempt token mismatch for ${assignmentId} attempt ${attemptNum}`);
    }

    attempt.status = result.status === "completed" ? "completed" : "failed";
    attempt.completedAt = new Date().toISOString();
    await this._writeAttempt(assignmentId, attemptNum, attempt);

    const state = await this._readState(assignmentId);
    state.status = result.status === "completed" ? "completed" : "failed";
    state.completedAt = new Date().toISOString();
    state.resultWrittenAt = new Date().toISOString();
    // P0-3: reset finalization tracking — reconciler will finalize
    state.queueFinalizedAt = null;
    state.workerFinalizedAt = null;
    await this._writeState(assignmentId, state);
  }

  /**
   * Write a synthetic failure result (for reconciler-created failures like heartbeat lost).
   * Uses writeJsonOnce to prevent overwriting worker results.
   */
  async writeSyntheticFailure(assignmentId, attemptNum, result) {
    const attempt = await this._readAttempt(assignmentId, attemptNum);
    if (result.attemptToken && result.attemptToken !== attempt.attemptToken) {
      throw new Error(`attempt token mismatch for ${assignmentId} attempt ${attemptNum}`);
    }

    const dir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"));
    const resultPath = path.join(dir, "result.json");
    const written = await writeJsonOnce(resultPath, result);
    if (!written) {
      // Worker already wrote result — use that instead
      return false;
    }

    attempt.status = "failed";
    attempt.completedAt = new Date().toISOString();
    await this._writeAttempt(assignmentId, attemptNum, attempt);

    const state = await this._readState(assignmentId);
    state.status = "failed";
    state.completedAt = new Date().toISOString();
    state.resultWrittenAt = new Date().toISOString();
    state.queueFinalizedAt = null;
    state.workerFinalizedAt = null;
    await this._writeState(assignmentId, state);
    return true;
  }

  /**
   * P0-3 fix: Mark finalization steps complete. Idempotent.
   */
  async markFinalized(assignmentId, step) {
    const state = await this._readState(assignmentId);
    if (!state) return;
    const key = `${step}FinalizedAt`;
    if (!state[key]) {
      state[key] = new Date().toISOString();
      await this._writeState(assignmentId, state);
    }
  }

  async writeCancel(assignmentId, attemptNum, reason) {
    const dir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"), "control");
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(path.join(dir, "cancel.json"), {
      reason,
      requestedAt: new Date().toISOString(),
      requestedBy: "hub",
    });
  }

  async readCancel(assignmentId, attemptNum) {
    try {
      return JSON.parse(await readFile(
        path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"), "control", "cancel.json"),
        "utf8",
      ));
    } catch { return null; }
  }

  async getAssignment(assignmentId) {
    return this._readState(assignmentId);
  }

  async getActiveAttempt(assignmentId) {
    const state = await this._readState(assignmentId);
    if (!state.activeAttempt) return null;
    return this._readAttempt(assignmentId, state.activeAttempt);
  }

  async listAssignments(filter = {}) {
    const entries = [];
    try {
      const dirs = await readdir(this.baseDir);
      for (const dir of dirs) {
        if (!dir.startsWith("a-")) continue;
        const state = await this._readState(dir);
        if (!state) continue;
        if (filter.status && state.status !== filter.status) continue;
        if (filter.projectId && state.projectId !== filter.projectId) continue;
        entries.push(state);
      }
    } catch { /* no assignments yet */ }
    return entries;
  }

  async _readState(assignmentId) {
    try {
      return JSON.parse(await readFile(path.join(this.baseDir, assignmentId, "state.json"), "utf8"));
    } catch { return null; }
  }

  async _writeState(assignmentId, state) {
    await writeJsonAtomic(path.join(this.baseDir, assignmentId, "state.json"), state);
  }

  async _readAttempt(assignmentId, attemptNum) {
    const dir = String(attemptNum).padStart(3, "0");
    return JSON.parse(await readFile(path.join(this.baseDir, assignmentId, "attempts", dir, "attempt.json"), "utf8"));
  }

  async _writeAttempt(assignmentId, attemptNum, attempt) {
    const dir = String(attemptNum).padStart(3, "0");
    await writeJsonAtomic(path.join(this.baseDir, assignmentId, "attempts", dir, "attempt.json"), attempt);
  }
}
