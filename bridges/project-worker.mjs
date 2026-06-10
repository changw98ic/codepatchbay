#!/usr/bin/env node
// project-worker.mjs — Per-project worker that polls Hub queue and runs pipeline
// Usage: node bridges/project-worker.mjs --project <id> [--once] [--workflow blocked]

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getProject, heartbeatWorker, resolveHubRoot } from "../server/services/hub-registry.js";
import { claimEligible, listQueue, updateEntry } from "../server/services/hub-queue.js";
import {
  dispatchEnabled,
  guardSourcePath,
  markDispatchCompleted,
  markDispatchFailed,
  markDispatchStarted,
  recordDispatch,
} from "../server/services/worker-dispatch.js";
import { executorEnv, resolveExecutorRoot } from "../server/services/executor-root.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPB_ROOT = path.resolve(process.env.CPB_ROOT || path.join(__dirname, ".."));
const CPB_EXECUTOR_ROOT = resolveExecutorRoot({
  fallbackRoot: path.join(__dirname, ".."),
});
export const AGENT_OUTAGE_EXIT_CODE = 2;

function numericOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateOutput(output, maxLength = 2_000) {
  if (!output || output.length <= maxLength) return output || "";
  return `${output.slice(0, maxLength)}\n[truncated ${output.length - maxLength} chars]`;
}

function runAgentSmoke({ agent, cpbRoot, executorRoot, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const script = [
      'source "$CPB_EXECUTOR_ROOT/bridges/common.sh"',
      'printf "%s" "$CPB_AGENT_PREFLIGHT_PROMPT" | CPB_ACP_TIMEOUT_MS="$CPB_AGENT_PREFLIGHT_TIMEOUT_MS" acp_run "$CPB_AGENT_PREFLIGHT_AGENT"',
    ].join("; ");
    const child = spawn("bash", ["-lc", script], {
      cwd: cpbRoot,
      env: {
        ...executorEnv(process.env, { cpbRoot, executorRoot }),
        CPB_ACP_CWD: cwd || cpbRoot,
        CPB_AGENT_PREFLIGHT_AGENT: agent,
        CPB_AGENT_PREFLIGHT_TIMEOUT_MS: String(timeoutMs),
        CPB_AGENT_PREFLIGHT_PROMPT: "Reply with OK only. Do not use tools.\n",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

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
    requireIssueLink: process.env.CPB_WORKER_REQUIRE_ISSUE_LINK === "1",
    agentPreflightRetries: numericOption(process.env.CPB_AGENT_PREFLIGHT_RETRIES, 3),
    agentPreflightBackoffMs: numericOption(process.env.CPB_AGENT_PREFLIGHT_BACKOFF_MS, 30_000),
    agentPreflightTimeoutMs: numericOption(process.env.CPB_AGENT_PREFLIGHT_TIMEOUT_MS, 60_000),
    workflow: process.env.CPB_WORKER_WORKFLOW || "standard",
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
    else if (arg === "--require-issue-link") opts.requireIssueLink = true;
    else if (arg === "--agent-preflight-retries") opts.agentPreflightRetries = Number(valueAfter(i++, "--agent-preflight-retries"));
    else if (arg === "--agent-preflight-backoff-ms") opts.agentPreflightBackoffMs = Number(valueAfter(i++, "--agent-preflight-backoff-ms"));
    else if (arg === "--agent-preflight-timeout-ms") opts.agentPreflightTimeoutMs = Number(valueAfter(i++, "--agent-preflight-timeout-ms"));
    else if (arg === "--workflow") opts.workflow = valueAfter(i++, "--workflow");
    else if (arg === "--cpb-root") opts.cpbRoot = valueAfter(i++, "--cpb-root");
    else if (arg === "--executor-root") opts.executorRoot = valueAfter(i++, "--executor-root");
    else if (arg === "--hub-root") opts.hubRoot = valueAfter(i++, "--hub-root");
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
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
    this.requireIssueLink = opts.requireIssueLink ?? false;
    this.agentPreflightRetries = numericOption(opts.agentPreflightRetries, 3);
    this.agentPreflightBackoffMs = numericOption(opts.agentPreflightBackoffMs, 30_000);
    this.agentPreflightTimeoutMs = numericOption(opts.agentPreflightTimeoutMs, 60_000);
    this.workflow = opts.workflow || "standard";
    this.assignmentStore = opts.assignmentStore || null;
    this._runPipelineFn = opts.runPipelineFn || null;
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
    if (!this.assignmentStore) {
      this.assignmentStore = new AssignmentStore(this.hubRoot);
      await this.assignmentStore.init();
    }
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
      assignmentStore: this.assignmentStore,
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

    const availability = await this.waitForAgentAvailability();
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

    if (dispatchEnabled() && dispatchId) {
      const fn = result.ok ? markDispatchCompleted : markDispatchFailed;
      await fn(this.hubRoot, dispatchId).catch(() => {});
    }

    return result;
  }

  async runPipeline(entry, sourcePath, dispatchId, overrideProjectId) {
    if (this._runPipelineFn) return this._runPipelineFn(entry, sourcePath, dispatchId, overrideProjectId);

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

      const child = spawn(process.execPath, args, {
        cwd: this.cpbRoot,
        env: {
          ...executorEnv(process.env, {
            cpbRoot: this.cpbRoot,
            executorRoot: this.executorRoot,
          }),
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
  --require-issue-link       Only claim entries linked to a GitHub issue
  --agent-preflight-retries <n>    Agent health retries before shutdown (default: 3)
  --agent-preflight-backoff-ms <n> Backoff between failed health retries (default: 30000)
  --agent-preflight-timeout-ms <n> Per-agent smoke timeout (default: 60000)
  --workflow <type>          Pipeline workflow: standard|blocked (default: standard)
  --cpb-root <path>          CPB root directory
  --executor-root <path>     CPB executor/release root directory
  --hub-root <path>          Hub root directory`;
}

async function main() {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main().catch((error) => {
    console.error(error.message);
    return 1;
  });
}
