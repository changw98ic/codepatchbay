#!/usr/bin/env node
// project-worker.mjs — Per-project worker that polls Hub queue and runs pipeline
// Usage: node bridges/project-worker.mjs --project <id> [--once] [--workflow standard|complex|blocked|accelerated]

import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { getProject, heartbeatWorker, resolveHubRoot } from "../../server/services/hub-registry.js";
import { claimEligible, listQueue, updateEntry } from "../../server/services/hub-queue.js";
import { getJob, recordFinalizerResult } from "../../server/services/job-store.js";
import { finalizeSuccessfulQueueEntry } from "../../server/services/auto-finalizer.js";
import {
  dispatchEnabled,
  guardSourcePath,
  markDispatchCompleted,
  markDispatchFailed,
  markDispatchStarted,
  recordDispatch,
} from "../../server/services/worker-dispatch.js";
import { executorEnv, resolveExecutorRoot } from "../../server/services/executor-root.js";
import { isWorkflowName, listWorkflows } from "../../core/workflow/definition.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPB_ROOT = path.resolve(process.env.CPB_ROOT || path.join(__dirname, ".."));
const CPB_EXECUTOR_ROOT = resolveExecutorRoot({
  fallbackRoot: path.join(__dirname, ".."),
});
const execFileAsync = promisify(execFile);
export const AGENT_OUTAGE_EXIT_CODE = 2;

function numericOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeWorktreeMode(value) {
  const mode = value || "required";
  if (mode !== "required" && mode !== "off") {
    throw new Error(`invalid worktree mode: ${mode} (valid: required, off)`);
  }
  return mode;
}

function normalizeAutoFinalizerMode(value) {
  const mode = value || "off";
  if (!["off", "dry-run", "local", "remote"].includes(mode)) {
    throw new Error(`invalid auto-finalizer mode: ${mode} (valid: off, dry-run, local, remote)`);
  }
  return mode;
}

function extractJobId(output) {
  const match = String(output || "").match(/\bjob-[A-Za-z0-9-]+\b/);
  return match ? match[0] : null;
}

function finalizerMetadata(result, mode) {
  if (!result) return null;
  const metadata = {
    ok: Boolean(result.ok),
    status: result.status || null,
    code: result.code || null,
    commit: result.commit || null,
    closed: result.closed ?? null,
    mode,
  };
  if ("jobId" in result) metadata.jobId = result.jobId ?? null;
  if ("inspectedStatus" in result) metadata.inspectedStatus = result.inspectedStatus ?? null;
  if (result.stateSource) metadata.stateSource = result.stateSource;
  if (result.acceptableSkip) metadata.acceptableSkip = true;
  return metadata;
}

function finalizerShouldFailQueue(result) {
  if (!result || result.ok || result.acceptableSkip) return false;
  return !(result.status === "skipped" && result.code === "NO_CHANGES");
}

async function defaultIssueCloser({ repo, number, jobId, commit }) {
  const comment = [
    `Closed by CodePatchbay job ${jobId}.`,
    commit ? `Commit: ${commit}` : null,
  ].filter(Boolean).join("\n");
  await execFileAsync("gh", [
    "issue",
    "close",
    String(number),
    "--repo",
    repo,
    "--comment",
    comment,
  ]);
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateOutput(output, maxLength = 2_000) {
  if (!output || output.length <= maxLength) return output || "";
  return `${output.slice(0, maxLength)}\n[truncated ${output.length - maxLength} chars]`;
}

async function runAgentSmoke({ agent, cpbRoot, executorRoot, cwd, timeoutMs }) {
  const startedAt = Date.now();

  // Apply claude variant to process.env before building child env
  if (agent === "claude") {
    try {
      const { applyVariant } = await import("../../runtime/apply-variant.js");
      applyVariant();
    } catch {}
  }

  const smokeEnv = {
    ...executorEnv(process.env, { cpbRoot, executorRoot }),
    CPB_ACP_CWD: cwd || cpbRoot,
    CPB_ACP_TIMEOUT_MS: String(timeoutMs),
  };

  const acpClient = process.env.CPB_ACP_CLIENT || path.join(executorRoot, "bridges", "acp-client.mjs");

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("node", [acpClient, "--agent", agent, "--cwd", cwd || cpbRoot], {
        cwd: cpbRoot,
        env: smokeEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return resolve({
        ok: false, agent, code: 1, error: error.message,
        elapsedMs: Date.now() - startedAt, stdout: "", stderr: "",
      });
    }

    child.stdin.write("Reply with OK only. Do not use tools.\n");
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve({
        ok: false,
        agent,
        code: null,
        timedOut: true,
        elapsedMs: Date.now() - startedAt,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        agent,
        code: 1,
        error: error.message,
        elapsedMs: Date.now() - startedAt,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        agent,
        code,
        elapsedMs: Date.now() - startedAt,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
      });
    });
  });
}

async function defaultAgentHealth({ cpbRoot, executorRoot, cwd, timeoutMs }) {
  const [codex, claude] = await Promise.all([
    runAgentSmoke({ agent: "codex", cpbRoot, executorRoot, cwd, timeoutMs }),
    runAgentSmoke({ agent: "claude", cpbRoot, executorRoot, cwd, timeoutMs }),
  ]);
  return {
    codex: codex.ok,
    claude: claude.ok,
    checks: { codex, claude },
  };
}

function priorityScore(p) {
  if (p === "P0") return 0;
  if (p === "P1") return 1;
  if (p === "P2") return 2;
  return 3;
}

export function parseArgs(argv) {
  const opts = {
    project: null,
    pool: false,
    once: false,
    heartbeatMs: 30_000,
    pollMs: 5_000,
    claimTimeoutMs: 120_000,
    maxActivePerProject: 1,
    agentPreflightRetries: numericOption(process.env.CPB_AGENT_PREFLIGHT_RETRIES, 3),
    agentPreflightBackoffMs: numericOption(process.env.CPB_AGENT_PREFLIGHT_BACKOFF_MS, 30_000),
    agentPreflightTimeoutMs: numericOption(process.env.CPB_AGENT_PREFLIGHT_TIMEOUT_MS, 60_000),
    workflow: process.env.CPB_WORKER_WORKFLOW || "standard",
    worktreeMode: normalizeWorktreeMode(process.env.CPB_WORKER_WORKTREE_MODE || "required"),
    autoFinalizerMode: process.env.CPB_AUTOFINALIZER_MODE || null,
    cpbRoot: CPB_ROOT,
    executorRoot: CPB_EXECUTOR_ROOT,
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
    else if (arg === "--pool") opts.pool = true;
    else if (arg === "--once") opts.once = true;
    else if (arg === "--heartbeat-ms") opts.heartbeatMs = Number(valueAfter(i++, "--heartbeat-ms"));
    else if (arg === "--poll-ms") opts.pollMs = Number(valueAfter(i++, "--poll-ms"));
    else if (arg === "--claim-timeout-ms") opts.claimTimeoutMs = Number(valueAfter(i++, "--claim-timeout-ms"));
    else if (arg === "--max-active-per-project") opts.maxActivePerProject = Number(valueAfter(i++, "--max-active-per-project"));
    else if (arg === "--agent-preflight-retries") opts.agentPreflightRetries = Number(valueAfter(i++, "--agent-preflight-retries"));
    else if (arg === "--agent-preflight-backoff-ms") opts.agentPreflightBackoffMs = Number(valueAfter(i++, "--agent-preflight-backoff-ms"));
    else if (arg === "--agent-preflight-timeout-ms") opts.agentPreflightTimeoutMs = Number(valueAfter(i++, "--agent-preflight-timeout-ms"));
    else if (arg === "--workflow") opts.workflow = valueAfter(i++, "--workflow");
    else if (arg === "--worktree-mode") opts.worktreeMode = normalizeWorktreeMode(valueAfter(i++, "--worktree-mode"));
    else if (arg === "--auto-finalizer-mode") opts.autoFinalizerMode = normalizeAutoFinalizerMode(valueAfter(i++, "--auto-finalizer-mode"));
    else if (arg === "--cpb-root") opts.cpbRoot = valueAfter(i++, "--cpb-root");
    else if (arg === "--executor-root") opts.executorRoot = valueAfter(i++, "--executor-root");
    else if (arg === "--hub-root") opts.hubRoot = valueAfter(i++, "--hub-root");
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!isWorkflowName(opts.workflow)) {
    throw new Error(`invalid workflow: ${opts.workflow} (valid: ${listWorkflows().join(", ")})`);
  }
  opts.worktreeMode = normalizeWorktreeMode(opts.worktreeMode);
  if (opts.autoFinalizerMode !== null) {
    opts.autoFinalizerMode = normalizeAutoFinalizerMode(opts.autoFinalizerMode);
  }
  return opts;
}

export class ProjectWorker {
  constructor(opts = {}) {
    this.cpbRoot = path.resolve(opts.cpbRoot || CPB_ROOT);
    this.executorRoot = path.resolve(opts.executorRoot || CPB_EXECUTOR_ROOT);
    this.hubRoot = path.resolve(opts.hubRoot || resolveHubRoot(this.cpbRoot));
    this.projectId = opts.projectId || null;
    this.pool = opts.pool || false;
    this.workerId = opts.workerId || `worker-${process.pid}`;
    this.once = opts.once || false;
    this.heartbeatMs = opts.heartbeatMs || 30_000;
    this.pollMs = opts.pollMs || 5_000;
    this.claimTimeoutMs = opts.claimTimeoutMs ?? 120_000;
    this.maxActivePerProject = opts.maxActivePerProject ?? 1;
    this.agentPreflightRetries = numericOption(opts.agentPreflightRetries, 3);
    this.agentPreflightBackoffMs = numericOption(opts.agentPreflightBackoffMs, 30_000);
    this.agentPreflightTimeoutMs = numericOption(opts.agentPreflightTimeoutMs, 60_000);
    this.workflow = opts.workflow || "standard";
    this.worktreeMode = normalizeWorktreeMode(opts.worktreeMode || process.env.CPB_WORKER_WORKTREE_MODE || "required");
    this.requireIssueLink = opts.requireIssueLink === true;
    this.autoFinalizerMode = normalizeAutoFinalizerMode(
      opts.autoFinalizerMode
        || process.env.CPB_AUTOFINALIZER_MODE
        || (this.requireIssueLink ? "remote" : "off"),
    );
    this._getProjectFn = opts.getProjectFn || null;
    this._runPipelineFn = opts.runPipelineFn || null;
    this._finalizerFn = opts.finalizerFn || finalizeSuccessfulQueueEntry;
    this._issueCloser = opts.issueCloser || defaultIssueCloser;
    this._agentHealthFn = opts.agentHealthFn || (opts.runPipelineFn
      ? async () => ({ codex: true, claude: true, checks: {} })
      : defaultAgentHealth);
    this._heartbeatTimer = null;
    this._stopRequested = false;
    this._activeEntryId = null;
    this.project = null;
  }

  requestStop() {
    this._stopRequested = true;
  }

  async init() {
    if (this.pool) {
      this.project = null;
      return null;
    }
    this.project = await getProject(this.hubRoot, this.projectId);
    if (!this.project) throw new Error(`project not found: ${this.projectId}`);
    return this.project;
  }

  async heartbeat() {
    if (!this.project) return;
    try {
      await heartbeatWorker(this.hubRoot, this.project.id, {
        workerId: this.workerId,
        pid: process.pid,
        status: "online",
        capabilities: ["scan", "execute", "pipeline"],
        claimTimeoutMs: this.claimTimeoutMs,
      });
    } catch {
      // Transient heartbeat failure — worker continues, next heartbeat
      // will refresh the registry.
    }
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
    if (this.claimTimeoutMs <= 0) return [];
    const filter = { status: "in_progress" };
    if (!this.pool && this.project) filter.projectId = this.project.id;
    const inProgress = await listQueue(this.hubRoot, filter);
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
    const filter = { status: "in_progress" };
    if (!this.pool && this.project) filter.projectId = this.project.id;
    const inProgress = await listQueue(this.hubRoot, filter);
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
    const result = await claimEligible(this.hubRoot, {
      workerId: this.workerId,
      projectId: this.pool ? null : this.project?.id || null,
      maxActivePerProject: this.maxActivePerProject,
      claimTimeoutMs: this.claimTimeoutMs,
      requireIssueLink: this.requireIssueLink,
      getProjectFn: this._getProjectFn || getProject,
    });
    return result.entry;
  }

  async peekNext() {
    const filter = { status: "pending" };
    if (!this.pool && this.project) filter.projectId = this.project.id;
    const pending = await listQueue(this.hubRoot, filter);
    if (pending.length === 0) return null;

    pending.sort(
      (a, b) => priorityScore(a.priority) - priorityScore(b.priority) || a.createdAt.localeCompare(b.createdAt),
    );
    return pending[0];
  }

  async checkAgentHealth() {
    return this._agentHealthFn({
      cpbRoot: this.cpbRoot,
      executorRoot: this.executorRoot,
      cwd: this.project?.sourcePath || this.cpbRoot,
      timeoutMs: this.agentPreflightTimeoutMs,
    });
  }

  async waitForAgentAvailability() {
    const attempts = Math.max(1, this.agentPreflightRetries);
    let lastHealth = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      lastHealth = await this.checkAgentHealth();
      if (lastHealth?.codex || lastHealth?.claude) {
        return { available: true, attempt, attempts, health: lastHealth };
      }

      if (attempt < attempts) {
        process.stderr.write(
          `[project-worker] both agents unavailable; retrying preflight ${attempt + 1}/${attempts}\n`,
        );
        await sleep(this.agentPreflightBackoffMs);
      }
    }

    return { available: false, attempt: attempts, attempts, health: lastHealth };
  }

  async executeEntry(entry) {
    const projectId = this.pool ? entry.projectId : this.project.id;
    const sourcePath = entry.sourcePath || this.project?.sourcePath;

    let dispatchId = null;
    if (dispatchEnabled() && sourcePath) {
      try {
        await guardSourcePath(this.hubRoot, projectId, sourcePath);
      } catch (err) {
        return { ok: false, error: `sourcePath guard: ${err.message}` };
      }
    }

    // Blocked workflow does not launch agents — skip preflight check
    const availability = this.workflow === "blocked"
      ? { available: true, attempt: 0, attempts: 0, health: { codex: true, claude: true, checks: {} } }
      : await this.waitForAgentAvailability();
    if (!availability.available) {
      return {
        ok: false,
        code: AGENT_OUTAGE_EXIT_CODE,
        agentOutage: true,
        error: "agents_unavailable",
        preflight: availability,
      };
    }

    if (dispatchEnabled() && sourcePath) {
      const dispatch = await recordDispatch(this.hubRoot, {
        projectId,
        sourcePath,
        sessionId: entry.sessionId || null,
        workerId: this.workerId,
        queueEntryId: entry.id,
      });
      dispatchId = dispatch ? dispatch.dispatchId : null;
      if (dispatchId) await markDispatchStarted(this.hubRoot, dispatchId).catch(() => {});
    }

    const result = await this.runPipeline(entry, sourcePath, dispatchId, projectId);

    if (result.ok && this.autoFinalizerMode !== "off" && entry.metadata?.autoFinalize !== false) {
      const finalizer = await this.finalizeEntry({ entry, sourcePath, projectId, result });
      result.finalizer = finalizer;
      if (finalizerShouldFailQueue(finalizer)) {
        result.ok = false;
        result.code = result.code || 1;
        result.error = `finalizer rejected: ${finalizer.code || finalizer.status || "unknown"}`;
      }
    }

    if (dispatchEnabled() && dispatchId) {
      const fn = result.ok ? markDispatchCompleted : markDispatchFailed;
      await fn(this.hubRoot, dispatchId).catch(() => {});
    }

    return result;
  }

  async resolveCompletedJob(projectId, result) {
    if (result.job) return { job: result.job, stateSource: "pipeline-result" };
    const jobId = result.jobId || extractJobId(result.stdout) || extractJobId(result.stderr);
    if (!jobId) return null;
    const job = await getJob(this.cpbRoot, projectId, jobId);
    return job?.jobId ? { job, stateSource: "job-store" } : null;
  }

  async finalizeEntry({ entry, sourcePath, projectId, result }) {
    const resolved = await this.resolveCompletedJob(projectId, result);
    const job = resolved?.job || null;
    if (!job) {
      return {
        ok: false,
        status: "skipped",
        code: "JOB_NOT_FOUND",
        jobId: result.jobId || extractJobId(result.stdout) || extractJobId(result.stderr) || null,
        inspectedStatus: null,
        stateSource: "missing",
      };
    }

    const finalizer = await this._finalizerFn({
      entry,
      job,
      sourcePath,
      mode: this.autoFinalizerMode,
      issueCloser: this._issueCloser,
    });
    return {
      ...finalizer,
      jobId: finalizer?.jobId ?? job.jobId ?? null,
      inspectedStatus: finalizer?.inspectedStatus ?? job.status ?? null,
      stateSource: finalizer?.stateSource ?? resolved.stateSource,
    };
  }

  async runPipeline(entry, sourcePath, dispatchId, overrideProjectId) {
    const useWorktree = Boolean(sourcePath && this.worktreeMode !== "off");
    const worktree = { worktreeMode: this.worktreeMode, useWorktree };
    if (this._runPipelineFn) return this._runPipelineFn(entry, sourcePath, dispatchId, overrideProjectId, worktree);

    const projectId = overrideProjectId || this.project?.id;
    return new Promise((resolve) => {
      const args = [
        path.join(this.executorRoot, "bridges", "run-pipeline.mjs"),
        "--project", projectId,
        "--task", entry.description || entry.id,
        "--workflow", this.workflow,
      ];
      if (sourcePath) args.push("--source-path", sourcePath);
      if (dispatchId) args.push("--dispatch-id", dispatchId);
      const metadata = entry.metadata || {};
      if (metadata.acpProfile) args.push("--acp-profile", metadata.acpProfile);
      if (metadata.uiLaneReason) args.push("--ui-lane-reason", metadata.uiLaneReason);

      const env = {
        ...executorEnv(process.env, {
          cpbRoot: this.cpbRoot,
          executorRoot: this.executorRoot,
        }),
        CPB_PROJECT_PATH_OVERRIDE: sourcePath || "",
        CPB_ACP_CWD: sourcePath || "",
        CPB_SESSION_ID: entry.sessionId || "",
        CPB_WORKER_ID: this.workerId,
        CPB_QUEUE_ENTRY_ID: entry.id || "",
        CPB_ISSUE_NUMBER: String(entry.metadata?.issueNumber ?? ""),
        CPB_ISSUE_URL: entry.metadata?.issueUrl ?? "",
        CPB_ISSUE_REPO: entry.metadata?.repo ?? "",
        CPB_ISSUE_TITLE: (entry.metadata?.issueTitle ?? "").slice(0, 200),
        CPB_FAILED_QUEUE_ID: entry.metadata?.originQueueId ?? "",
        CPB_FAILED_JOB_ID: entry.metadata?.originJobId ?? "",
        CPB_FAILURE_ARTIFACT: entry.metadata?.failureArtifact ?? "",
        CPB_INDEX_SNAPSHOT_JSON: entry.metadata?.indexSnapshot
          ? JSON.stringify(entry.metadata.indexSnapshot)
          : "",
      };
      if (useWorktree) env.CPB_USE_WORKTREE = "1";
      else delete env.CPB_USE_WORKTREE;

      const child = spawn(process.execPath, args, {
        cwd: this.cpbRoot,
        env,
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
    let result;
    try {
      result = await this.executeEntry(entry);
    } finally {
      this._activeEntryId = null;
    }

    if (result.agentOutage) {
      await updateEntry(this.hubRoot, entry.id, {
        status: "pending",
        claimedBy: null,
        claimedAt: null,
        workerId: null,
        metadata: {
          agentPreflight: {
            status: "unavailable",
            attempts: result.preflight?.attempts ?? null,
            checkedAt: new Date().toISOString(),
          },
        },
      }).catch(() => {});
      this.requestStop();
      return {
        stopped: true,
        reason: "agents_unavailable",
        entry,
        preflight: result.preflight,
      };
    }

    const finalStatus = result.ok ? "completed" : "failed";
    const patch = { status: finalStatus };
    if (result.finalizer) {
      patch.metadata = {
        finalizer: finalizerMetadata(result.finalizer, this.autoFinalizerMode),
      };
      const jobId = result.finalizer.jobId || result.job?.jobId || result.jobId || extractJobId(result.stdout) || extractJobId(result.stderr);
      if (jobId) {
        await recordFinalizerResult(this.cpbRoot, entry.projectId, jobId, {
          result: patch.metadata.finalizer,
        }).catch(() => {});
      }
    }
    await updateEntry(this.hubRoot, entry.id, patch).catch(() => {});

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
        try {
          const result = await this.poll();
          if (result.idle) {
            await new Promise((resolve) => setTimeout(resolve, this.pollMs));
          }
        } catch (err) {
          process.stderr.write(`[project-worker] poll error: ${err.message}\n`);
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
       node bridges/project-worker.mjs --pool [options]

Options:
  --project <id>             Project ID to serve (required, unless --pool)
  --pool                     Serve all eligible projects (no --project required)
  --once                     Process one entry then exit
  --heartbeat-ms <n>         Heartbeat interval in ms (default: 30000)
  --poll-ms <n>              Queue poll interval in ms (default: 5000)
  --claim-timeout-ms <n>     Stale claim timeout in ms (default: 120000, 0 to disable)
  --max-active-per-project <n> Max concurrent mutating tasks per project (default: 1)
  --agent-preflight-retries <n>    Agent health retries before shutdown (default: 3)
  --agent-preflight-backoff-ms <n> Backoff between failed health retries (default: 30000)
  --agent-preflight-timeout-ms <n> Per-agent smoke timeout (default: 60000)
  --workflow <type>          Pipeline workflow: standard|complex|blocked|accelerated (default: standard)
  --worktree-mode <mode>     Worker source isolation mode: required|off (default: required)
  --auto-finalizer-mode <mode> Successful queue finalization: off|dry-run|local|remote (default: remote for issue-linked CLI workers)
  --cpb-root <path>          CPB root directory
  --executor-root <path>     CPB executor/release root directory
  --hub-root <path>          Hub root directory`;
}

export async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (!opts.project && !opts.pool) throw new Error("--project is required (or use --pool, see --help)");

  const worker = new ProjectWorker({
    projectId: opts.project,
    pool: opts.pool,
    once: opts.once,
    heartbeatMs: opts.heartbeatMs,
    pollMs: opts.pollMs,
    claimTimeoutMs: opts.claimTimeoutMs,
    maxActivePerProject: opts.maxActivePerProject,
    agentPreflightRetries: opts.agentPreflightRetries,
    agentPreflightBackoffMs: opts.agentPreflightBackoffMs,
    agentPreflightTimeoutMs: opts.agentPreflightTimeoutMs,
    workflow: opts.workflow,
    worktreeMode: opts.worktreeMode,
    autoFinalizerMode: opts.autoFinalizerMode,
    requireIssueLink: true,
    cpbRoot: opts.cpbRoot,
    executorRoot: opts.executorRoot,
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
  if (result.reason === "agents_unavailable") return AGENT_OUTAGE_EXIT_CODE;
  return result.result && !result.result.ok ? 1 : 0;
}

import { realpathSync } from "node:fs";

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  process.exitCode = await main().catch((error) => {
    console.error(error.message);
    return 1;
  });
}
