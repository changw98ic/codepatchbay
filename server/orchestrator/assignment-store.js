import { mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const ASSIGNMENTS_DIR = "assignments";

export class AssignmentStore {
  constructor(hubRoot) {
    this.baseDir = path.join(hubRoot, ASSIGNMENTS_DIR);
  }

  async init() {
    await mkdir(this.baseDir, { recursive: true });
  }

  async createAssignment({ entryId, projectId, task, sourcePath, workflow, planMode, sourceContext }) {
    const id = `a-${entryId}`;
    const dir = path.join(this.baseDir, id);
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
    };

    await writeFile(path.join(dir, "input.json"), JSON.stringify(assignment, null, 2) + "\n", "utf8");
    await writeFile(path.join(dir, "state.json"), JSON.stringify({ ...assignment, attempts: 0 }, null, 2) + "\n", "utf8");

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

    await writeFile(path.join(attemptDir, "attempt.json"), JSON.stringify(attempt, null, 2) + "\n", "utf8");

    // Update assignment state
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
    await writeFile(
      path.join(dir, "heartbeat.json"),
      JSON.stringify({ ...heartbeat, updatedAt: new Date().toISOString() }, null, 2) + "\n",
      "utf8",
    );
  }

  async completeAttempt(assignmentId, attemptNum, result) {
    const attempt = await this._readAttempt(assignmentId, attemptNum);
    // Validate attempt token
    if (result.attemptToken && result.attemptToken !== attempt.attemptToken) {
      throw new Error(`attempt token mismatch for ${assignmentId} attempt ${attemptNum}`);
    }

    attempt.status = result.status === "completed" ? "completed" : "failed";
    attempt.completedAt = new Date().toISOString();

    const dir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"));
    await writeFile(path.join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
    await this._writeAttempt(assignmentId, attemptNum, attempt);

    // Update assignment state
    const state = await this._readState(assignmentId);
    state.status = result.status === "completed" ? "completed" : "failed";
    state.completedAt = new Date().toISOString();
    await this._writeState(assignmentId, state);
  }

  async writeCancel(assignmentId, attemptNum, reason) {
    const dir = path.join(this.baseDir, assignmentId, "attempts", String(attemptNum).padStart(3, "0"), "control");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "cancel.json"), JSON.stringify({
      reason,
      requestedAt: new Date().toISOString(),
      requestedBy: "hub",
    }, null, 2) + "\n", "utf8");
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
    await writeFile(path.join(this.baseDir, assignmentId, "state.json"), JSON.stringify(state, null, 2) + "\n", "utf8");
  }

  async _readAttempt(assignmentId, attemptNum) {
    const dir = String(attemptNum).padStart(3, "0");
    return JSON.parse(await readFile(path.join(this.baseDir, assignmentId, "attempts", dir, "attempt.json"), "utf8"));
  }

  async _writeAttempt(assignmentId, attemptNum, attempt) {
    const dir = String(attemptNum).padStart(3, "0");
    await writeFile(path.join(this.baseDir, assignmentId, "attempts", dir, "attempt.json"), JSON.stringify(attempt, null, 2) + "\n", "utf8");
  }
}
