#!/usr/bin/env node
// project-worker.mjs — Per-project worker that polls Hub queue and runs pipeline
// Usage: node bridges/project-worker.mjs --project <id> [--once] [--workflow blocked]

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getProject, heartbeatWorker, resolveHubRoot } from "../server/services/hub-registry.js";
import { listQueue, updateEntry } from "../server/services/hub-queue.js";
import {
  dispatchEnabled,
  guardSourcePath,
  markDispatchCompleted,
  markDispatchFailed,
  markDispatchStarted,
  recordDispatch,
} from "../server/services/worker-dispatch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPB_ROOT = path.resolve(process.env.CPB_ROOT || path.join(__dirname, ".."));

function priorityScore(p) {
  if (p === "P0") return 0;
  if (p === "P1") return 1;
  if (p === "P2") return 2;
  return 3;
}

export function parseArgs(argv) {
  const opts = {
    project: null,
    once: false,
    heartbeatMs: 30_000,
    pollMs: 5_000,
    claimTimeoutMs: 120_000,
    workflow: process.env.CPB_WORKER_WORKFLOW || "standard",
    cpbRoot: CPB_ROOT,
    hubRoot: null,
  };
  const args = argv.slice(2);
  const valueAfter = (i, flag) => {
    const v = args[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`missing value for ${flag}`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project") opts.project = valueAfter(i++, "--project");
    else if (arg === "--once") opts.once = true;
    else if (arg === "--heartbeat-ms") opts.heartbeatMs = Number(valueAfter(i++, "--heartbeat-ms"));
    else if (arg === "--poll-ms") opts.pollMs = Number(valueAfter(i++, "--poll-ms"));
    else if (arg === "--claim-timeout-ms") opts.claimTimeoutMs = Number(valueAfter(i++, "--claim-timeout-ms"));
    else if (arg === "--workflow") opts.workflow = valueAfter(i++, "--workflow");
    else if (arg === "--cpb-root") opts.cpbRoot = valueAfter(i++, "--cpb-root");
    else if (arg === "--hub-root") opts.hubRoot = valueAfter(i++, "--hub-root");
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

export class ProjectWorker {
  constructor(opts = {}) {
    this.cpbRoot = path.resolve(opts.cpbRoot || CPB_ROOT);
    this.hubRoot = path.resolve(opts.hubRoot || resolveHubRoot(this.cpbRoot));
    this.projectId = opts.projectId;
    this.workerId = opts.workerId || `worker-${process.pid}`;
    this.once = opts.once || false;
    this.heartbeatMs = opts.heartbeatMs || 30_000;
    this.pollMs = opts.pollMs || 5_000;
    this.claimTimeoutMs = opts.claimTimeoutMs ?? 120_000;
    this.workflow = opts.workflow || "standard";
    this._runPipelineFn = opts.runPipelineFn || null;
    this._heartbeatTimer = null;
    this._stopRequested = false;
    this._activeEntryId = null;
    this.project = null;
  }

  requestStop() {
    this._stopRequested = true;
  }

  async init() {
    this.project = await getProject(this.hubRoot, this.projectId);
    if (!this.project) throw new Error(`project not found: ${this.projectId}`);
    return this.project;
  }

  async heartbeat() {
    if (!this.project) return;
    await heartbeatWorker(this.hubRoot, this.project.id, {
      workerId: this.workerId,
      pid: process.pid,
      status: "online",
      capabilities: ["scan", "execute", "pipeline"],
      claimTimeoutMs: this.claimTimeoutMs,
    });
  }

  startHeartbeat() {
    this.heartbeat();
    this._heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
  }

  stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  async recoverStaleEntries() {
    if (!this.project || this.claimTimeoutMs <= 0) return [];
    const inProgress = await listQueue(this.hubRoot, { status: "in_progress", projectId: this.project.id });
    const now = Date.now();
    const recovered = [];
    for (const entry of inProgress) {
      const claimedAt = entry.claimedAt ? new Date(entry.claimedAt).getTime() : 0;
      if (!Number.isFinite(claimedAt) || now - claimedAt < this.claimTimeoutMs) continue;

      if (entry.claimedBy === this.workerId) {
        const patch = { claimedAt: new Date().toISOString() };
        await updateEntry(this.hubRoot, entry.id, patch);
        recovered.push({ id: entry.id, action: "reclaimed" });
      } else {
        await updateEntry(this.hubRoot, entry.id, {
          status: "pending",
          claimedBy: null,
          claimedAt: null,
          workerId: null,
        });
        recovered.push({ id: entry.id, action: "reset" });
      }
    }
    return recovered;
  }

  async releaseOwnEntries() {
    if (!this.project) return [];
    const inProgress = await listQueue(this.hubRoot, { status: "in_progress", projectId: this.project.id });
    const released = [];
    for (const entry of inProgress) {
      if (entry.claimedBy !== this.workerId || entry.id === this._activeEntryId) continue;
      await updateEntry(this.hubRoot, entry.id, {
        status: "pending",
        claimedBy: null,
        claimedAt: null,
        workerId: null,
      });
      released.push(entry.id);
    }
    return released;
  }

  async claimNext() {
    const pending = await listQueue(this.hubRoot, { status: "pending", projectId: this.project.id });
    if (pending.length === 0) return null;

    pending.sort(
      (a, b) => priorityScore(a.priority) - priorityScore(b.priority) || a.createdAt.localeCompare(b.createdAt),
    );
    const entry = pending[0];
    const now = new Date().toISOString();
    return updateEntry(this.hubRoot, entry.id, {
      status: "in_progress",
      claimedBy: this.workerId,
      workerId: this.workerId,
      claimedAt: now,
    });
  }

  async executeEntry(entry) {
    const sourcePath = entry.sourcePath || this.project.sourcePath;

    let dispatchId = null;
    if (dispatchEnabled() && sourcePath) {
      try {
        await guardSourcePath(this.hubRoot, this.project.id, sourcePath);
      } catch (err) {
        return { ok: false, error: `sourcePath guard: ${err.message}` };
      }
      const dispatch = await recordDispatch(this.hubRoot, {
        projectId: this.project.id,
        sourcePath,
        sessionId: entry.sessionId || null,
        workerId: this.workerId,
        queueEntryId: entry.id,
      });
      dispatchId = dispatch ? dispatch.dispatchId : null;
      if (dispatchId) await markDispatchStarted(this.hubRoot, dispatchId).catch(() => {});
    }

    const result = await this.runPipeline(entry, sourcePath, dispatchId);

    if (dispatchEnabled() && dispatchId) {
      const fn = result.ok ? markDispatchCompleted : markDispatchFailed;
      await fn(this.hubRoot, dispatchId).catch(() => {});
    }

    return result;
  }

  async runPipeline(entry, sourcePath, dispatchId) {
    if (this._runPipelineFn) return this._runPipelineFn(entry, sourcePath, dispatchId);

    return new Promise((resolve) => {
      const args = [
        path.join(this.cpbRoot, "bridges", "run-pipeline.mjs"),
        "--project", this.project.id,
        "--task", entry.description || entry.id,
        "--workflow", this.workflow,
      ];
      if (sourcePath) args.push("--source-path", sourcePath);
      if (dispatchId) args.push("--dispatch-id", dispatchId);

      const child = spawn(process.execPath, args, {
        cwd: this.cpbRoot,
        env: {
          ...process.env,
          CPB_ROOT: this.cpbRoot,
          CPB_PROJECT_PATH_OVERRIDE: sourcePath || "",
          CPB_ACP_CWD: sourcePath || "",
          CPB_SESSION_ID: entry.sessionId || "",
          CPB_WORKER_ID: this.workerId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
      child.on("error", (error) => resolve({ ok: false, code: 1, error: error.message, stdout, stderr }));
    });
  }

  async poll() {
    const entry = await this.claimNext();
    if (!entry) return { idle: true };

    this._activeEntryId = entry.id;
    const result = await this.executeEntry(entry);
    this._activeEntryId = null;
    const finalStatus = result.ok ? "completed" : "failed";
    await updateEntry(this.hubRoot, entry.id, { status: finalStatus }).catch(() => {});

    return { entry, result };
  }

  async run() {
    await this.init();
    this.startHeartbeat();

    try {
      await this.recoverStaleEntries();

      if (this.once) {
        return await this.poll();
      }

      while (!this._stopRequested) {
        const result = await this.poll();
        if (result.idle) {
          await new Promise((resolve) => setTimeout(resolve, this.pollMs));
        }
      }

      await this.releaseOwnEntries();
      return { stopped: true };
    } finally {
      this.stopHeartbeat();
    }
  }
}

function usage() {
  return `Usage: node bridges/project-worker.mjs --project <id> [options]

Options:
  --project <id>             Project ID to serve (required)
  --once                     Process one entry then exit
  --heartbeat-ms <n>         Heartbeat interval in ms (default: 30000)
  --poll-ms <n>              Queue poll interval in ms (default: 5000)
  --claim-timeout-ms <n>     Stale claim timeout in ms (default: 120000, 0 to disable)
  --workflow <type>          Pipeline workflow: standard|blocked (default: standard)
  --cpb-root <path>          CPB root directory
  --hub-root <path>          Hub root directory`;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (!opts.project) throw new Error("--project is required (see --help)");

  const worker = new ProjectWorker({
    projectId: opts.project,
    once: opts.once,
    heartbeatMs: opts.heartbeatMs,
    pollMs: opts.pollMs,
    claimTimeoutMs: opts.claimTimeoutMs,
    workflow: opts.workflow,
    cpbRoot: opts.cpbRoot,
    hubRoot: opts.hubRoot,
  });

  const onSignal = (sig) => {
    process.stderr.write(`[project-worker] ${sig} received, stopping\n`);
    worker.requestStop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const result = await worker.run();
  console.log(JSON.stringify(result, null, 2));
  return result.result && !result.result.ok ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main().catch((error) => {
    console.error(error.message);
    return 1;
  });
}
