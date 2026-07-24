#!/usr/bin/env node
// project-worker.js — Per-project worker that polls Hub queue and runs pipeline
// Usage: node bridges/project-worker.js --project <id> [--once] [--workflow blocked]

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LooseRecord } from "../core/contracts/types.js";

import { getProject, heartbeatWorker, resolveHubRoot } from "../server/services/hub/hub-registry.js";
import { claimEligible, listQueue, updateEntry } from "../server/services/hub/hub-queue.js";
import {
  dispatchEnabled,
  guardSourcePath,
  markDispatchCompleted,
  markDispatchFailed,
  markDispatchStarted,
  recordDispatch,
} from "../server/services/dispatch/dispatch.js";
import { executorEnv, resolveExecutorRoot } from "../server/services/executor-root.js";
import { AssignmentStore } from "../shared/orchestrator/assignment-store.js";
import { recoverOrphanedJobs } from "../server/services/cleanup/cleanup.js";
import {
  captureProcessIdentity,
  killTree,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../core/runtime/process-tree.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CPB_ROOT = path.resolve(process.env.CPB_ROOT || path.join(__dirname, ".."));
const CPB_EXECUTOR_ROOT = resolveExecutorRoot({
  fallbackRoot: path.join(__dirname, ".."),
});
export const AGENT_OUTAGE_EXIT_CODE = 2;

function numericOption(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateOutput(output: string, maxLength = 2_000) {
  if (!output || output.length <= maxLength) return output || "";
  return `${output.slice(0, maxLength)}\n[truncated ${output.length - maxLength} chars]`;
}

type AgentSmokeResult = {
  ok: boolean;
  agent: string;
  code: number | null;
  timedOut?: boolean;
  error?: string;
  elapsedMs: number;
  stdout: string;
  stderr: string;
};

type AgentSmokeOptions = {
  agent: string;
  cpbRoot: string;
  executorRoot: string;
  cwd: string;
  timeoutMs: number;
  termGraceMs?: number;
  forceVerifyMs?: number;
  closeGraceMs?: number;
  /** Test seam for identity capture and tree signaling. */
  processTreeSystem?: ProcessTreeSystem;
  spawnSpec?: {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  };
};

type ChildCloseRecord = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
};

function childLifecycleError(message: string, code: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function monitorChildClose(child: ChildProcess) {
  let processError: Error | null = null;
  const closed = new Promise<ChildCloseRecord>((resolve) => {
    child.once("error", (error) => { processError = error; });
    child.once("close", (code, signal) => resolve({ code, signal, error: processError }));
  });
  return closed;
}

async function waitForChildCloseBounded(
  closed: Promise<ChildCloseRecord>,
  timeoutMs: number,
  label: string,
) {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(childLifecycleError(
          `${label} did not emit close after verified teardown`,
          "CHILD_CLOSE_TIMEOUT",
        )), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateSmokeChild(
  child: ChildProcess,
  identity: ProcessIdentity | null,
  { termGraceMs, forceVerifyMs }: Required<Pick<AgentSmokeOptions, "termGraceMs" | "forceVerifyMs">>,
  system?: ProcessTreeSystem,
) {
  if (!child.pid || !identity) {
    throw childLifecycleError(
      child.pid
        ? `smoke child ${child.pid} has no verified process identity; refusing to signal`
        : "smoke child did not expose a pid; refusing to signal",
      "CHILD_PROCESS_IDENTITY_UNAVAILABLE",
    );
  }
  await killTree(child.pid, termGraceMs, {
    requireDescendantScan: true,
    forceVerifyMs,
    expectedRootIdentity: identity,
    ...(system ? { system } : {}),
  });
}

function aggregateChildFailure(label: string, primary: Error, cleanupErrors: unknown[]) {
  const normalized = cleanupErrors.map((error) => error instanceof Error ? error : new Error(String(error)));
  return Object.assign(
    new AggregateError([primary, ...normalized], `${label} failed and child cleanup was not clean`, { cause: primary }),
    { code: "CHILD_LIFECYCLE_CLEANUP_FAILED", primaryError: primary, cleanupErrors: normalized },
  );
}

export async function runAgentSmoke({
  agent,
  cpbRoot,
  executorRoot,
  cwd,
  timeoutMs,
  termGraceMs = 1_000,
  forceVerifyMs = 1_000,
  closeGraceMs = 1_000,
  processTreeSystem,
  spawnSpec,
}: AgentSmokeOptions): Promise<AgentSmokeResult> {
  const startedAt = Date.now();
  const script = [
    'export CPB_EXECUTOR_ROOT="$1"',
    'export CPB_ROOT="$2"',
    'source "$CPB_EXECUTOR_ROOT/bridges/common.sh"',
    'printf "%s" "$CPB_AGENT_PREFLIGHT_PROMPT" | CPB_ACP_TIMEOUT_MS="$CPB_AGENT_PREFLIGHT_TIMEOUT_MS" acp_run "$CPB_AGENT_PREFLIGHT_AGENT"',
  ].join("; ");
  let child: ChildProcess;
  try {
    child = spawn(spawnSpec?.command || "bash", spawnSpec?.args || ["-lc", script, "cpb-agent-smoke", executorRoot, cpbRoot], {
      cwd: cpbRoot,
      env: spawnSpec?.env || {
        ...executorEnv(process.env, { cpbRoot, executorRoot }),
        CPB_ACP_CWD: cwd || cpbRoot,
        CPB_AGENT_PREFLIGHT_AGENT: agent,
        CPB_AGENT_PREFLIGHT_TIMEOUT_MS: String(timeoutMs),
        CPB_AGENT_PREFLIGHT_PROMPT: "Reply with OK only. Do not use tools.\n",
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      ok: false,
      agent,
      code: 1,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
      stdout: "",
      stderr: "",
    };
  }

  const closed = monitorChildClose(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });

  let identity: ProcessIdentity | null = null;
  let identityError: Error | null = null;
  if (!child.pid) {
    identityError = childLifecycleError("smoke child did not expose a pid", "CHILD_PROCESS_IDENTITY_UNAVAILABLE");
  } else {
    try {
      identity = captureProcessIdentity(child.pid, {
        strict: true,
        ...(processTreeSystem ? { system: processTreeSystem } : {}),
      });
      if (!identity) {
        identityError = childLifecycleError(
          `smoke child ${child.pid} exited before its process identity was captured`,
          "CHILD_PROCESS_IDENTITY_UNAVAILABLE",
        );
      }
    } catch (error) {
      identityError = childLifecycleError(
        `smoke child ${child.pid} process identity could not be captured`,
        "CHILD_PROCESS_IDENTITY_UNAVAILABLE",
        error,
      );
    }
  }

  const timeoutMarker = Symbol("agent-smoke-timeout");
  let timeout: NodeJS.Timeout | null = null;
  const first = identityError
    ? identityError
    : await Promise.race([
      closed,
      new Promise<typeof timeoutMarker>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutMarker), Math.max(0, timeoutMs));
      }),
    ]);
  if (timeout) clearTimeout(timeout);

  if (typeof first === "object" && !(first instanceof Error)) {
    return {
      ok: first.code === 0 && !first.error,
      agent,
      code: first.code,
      ...(first.error ? { error: first.error.message } : {}),
      elapsedMs: Date.now() - startedAt,
      stdout: truncateOutput(stdout),
      stderr: truncateOutput(stderr),
    };
  }

  let primary = first instanceof Error
    ? first
    : childLifecycleError(`agent ${agent} smoke check timed out after ${timeoutMs}ms`, "AGENT_SMOKE_TIMEOUT");
  const cleanupErrors: unknown[] = [];
  try {
    await terminateSmokeChild(child, identity, { termGraceMs, forceVerifyMs }, processTreeSystem);
  } catch (error) {
    cleanupErrors.push(error);
  }

  let closeRecord: ChildCloseRecord | null = null;
  try {
    closeRecord = await waitForChildCloseBounded(closed, closeGraceMs, `agent ${agent} smoke child`);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (!child.pid && closeRecord?.error) primary = closeRecord.error;
  else if (closeRecord?.error && closeRecord.error !== primary) cleanupErrors.push(closeRecord.error);
  if (cleanupErrors.length > 0) throw aggregateChildFailure(`agent ${agent} smoke check`, primary, cleanupErrors);

  return {
    ok: false,
    agent,
    code: closeRecord?.code ?? null,
    ...(first === timeoutMarker ? { timedOut: true } : { error: primary.message }),
    elapsedMs: Date.now() - startedAt,
    stdout: truncateOutput(stdout),
    stderr: truncateOutput(stderr),
  };
}

async function defaultAgentHealth({ cpbRoot, executorRoot, cwd, timeoutMs }: { cpbRoot: string; executorRoot: string; cwd: string; timeoutMs: number }) {
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

function priorityScore(p: unknown): number {
  if (p === "P0") return 0;
  if (p === "P1") return 1;
  if (p === "P2") return 2;
  return 3;
}

type ProjectWorkerArgs = {
  project: string | null;
  pool: boolean;
  once: boolean;
  heartbeatMs: number;
  pollMs: number;
  claimTimeoutMs: number;
  maxActivePerProject: number;
  requireIssueLink: boolean;
  agentPreflightRetries: number;
  agentPreflightBackoffMs: number;
  agentPreflightTimeoutMs: number;
  workflow: string;
  cpbRoot: string;
  executorRoot: string;
  hubRoot: string | null;
  help?: boolean;
};

type ProjectRecord = LooseRecord & {
  id: string;
  sourcePath?: string;
  projectRuntimeRoot?: string;
};

type QueueEntry = LooseRecord & {
  id?: string;
  projectId?: string;
  sourcePath?: string | null;
  sessionId?: string | null;
  description?: string;
  priority?: unknown;
  createdAt?: string;
  claimedAt?: string | null;
  claimedBy?: string | null;
};

type QueueListFilter = NonNullable<Parameters<typeof listQueue>[1]>;

type PipelineResult = {
  ok?: boolean;
  code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  agentOutage?: boolean;
  preflight?: AgentAvailabilityResult;
};

type PipelineRunner = (
  entry: QueueEntry,
  sourcePath: string | null,
  dispatchId: string | null,
  overrideProjectId: string,
) => Promise<PipelineResult>;

type AgentHealth = {
  codex?: boolean;
  claude?: boolean;
  checks?: {
    codex?: AgentSmokeResult;
    claude?: AgentSmokeResult;
  } | LooseRecord;
};

type AgentHealthFn = (opts: {
  cpbRoot: string;
  executorRoot: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<AgentHealth>;

type AgentAvailabilityResult = {
  available: boolean;
  attempt: number;
  attempts: number;
  health: AgentHealth | null;
};

type WorkerRunResult = {
  idle?: boolean;
  stopped?: boolean;
  reason?: string;
  entry?: QueueEntry;
  result?: PipelineResult;
  preflight?: AgentAvailabilityResult;
};

function queueListFilter(status: string, projectId?: string | null): QueueListFilter {
  const filter: QueueListFilter = { status };
  if (projectId) filter.projectId = projectId;
  return filter;
}

export function parseArgs(argv: string[]): ProjectWorkerArgs {
  const opts: ProjectWorkerArgs = {
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
  const valueAfter = (i: number, flag: string): string => {
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

interface ProjectWorkerOpts {
  projectId?: string | null;
  pool?: boolean;
  workerId?: string;
  once?: boolean;
  heartbeatMs?: number;
  pollMs?: number;
  claimTimeoutMs?: number;
  maxActivePerProject?: number;
  requireIssueLink?: boolean;
  agentPreflightRetries?: unknown;
  agentPreflightBackoffMs?: unknown;
  agentPreflightTimeoutMs?: unknown;
  workflow?: string;
  assignmentStore?: AssignmentStore | null;
  runPipelineFn?: PipelineRunner | null;
  agentHealthFn?: AgentHealthFn;
  cpbRoot?: string;
  executorRoot?: string;
  hubRoot?: string;
}

export class ProjectWorker {
  cpbRoot: string;
  executorRoot: string;
  hubRoot: string;
  projectId: string;
  pool: boolean;
  workerId: string;
  once: boolean;
  heartbeatMs: number;
  pollMs: number;
  claimTimeoutMs: number;
  maxActivePerProject: number;
  requireIssueLink: boolean;
  agentPreflightRetries: number;
  agentPreflightBackoffMs: number;
  agentPreflightTimeoutMs: number;
  workflow: string;
  assignmentStore: AssignmentStore | null;
  _runPipelineFn: PipelineRunner | null;
  _agentHealthFn: AgentHealthFn;
  _heartbeatTimer: NodeJS.Timeout | null;
  _stopRequested: boolean;
  _activeEntryId: string | null;
  project: ProjectRecord | null;

  constructor(opts: ProjectWorkerOpts = {}) {
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
      const response = await heartbeatWorker(this.hubRoot, this.project.id, {
        workerId: this.workerId,
        pid: process.pid,
        status: "online",
        capabilities: ["scan", "execute", "pipeline"],
        claimTimeoutMs: this.claimTimeoutMs,
      });
      if (response && Array.isArray(response.actions) && response.actions.length > 0) {
        for (const directive of response.actions) {
          if (directive.action === "stop") {
            process.stderr.write(`[project-worker] stop directive received: ${directive.reason || "unknown"}\n`);
            this.requestStop();
          } else if (directive.action === "reload_project") {
            const refreshed = await getProject(this.hubRoot, this.project.id);
            if (refreshed) this.project = refreshed;
          }
        }
      }
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
    const filter = queueListFilter("in_progress", !this.pool && this.project ? this.project.id : null);
    const inProgress = await listQueue(this.hubRoot, filter);
    const now = Date.now();
    const recovered: Array<LooseRecord & { id: string; action: string }> = [];
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

  async recoverOrphanedJobsStartup() {
    try {
      const result = await recoverOrphanedJobs(this.cpbRoot, {
        hubRoot: this.hubRoot,
        dataRoot: this.project?.projectRuntimeRoot,
        project: this.pool ? null : this.project?.id,
      });
      if (result.recovered?.length > 0 || result.failed?.length > 0) {
        process.stderr.write(
          `[project-worker] orphan job recovery: ${result.recovered.length} recovered, ${result.failed.length} failed\n`
        );
      }
      return result;
    } catch (err) {
      process.stderr.write(`[project-worker] orphan job recovery error: ${err.message}\n`);
      return { recovered: [], failed: [] };
    }
  }

  async releaseOwnEntries() {
    const filter = queueListFilter("in_progress", !this.pool && this.project ? this.project.id : null);
    const inProgress = await listQueue(this.hubRoot, filter);
    const released: string[] = [];
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
    const filter = queueListFilter("pending", !this.pool && this.project ? this.project.id : null);
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

  async executeEntry(entry: QueueEntry): Promise<PipelineResult> {
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

  async runPipeline(entry: QueueEntry, sourcePath: string | null, dispatchId: string | null, overrideProjectId: string): Promise<PipelineResult> {
    if (this._runPipelineFn) return this._runPipelineFn(entry, sourcePath, dispatchId, overrideProjectId);

    const projectId = overrideProjectId || entry?.projectId || this.project?.id;
    const project = projectId ? await getProject(this.hubRoot, projectId) : null;
    const projectRuntimeRoot = project?.projectRuntimeRoot ? path.resolve(project.projectRuntimeRoot) : null;
    if (!projectId || !project || !projectRuntimeRoot) {
      const error = `projectRuntimeRoot missing for project: ${projectId || "unknown"}`;
      return { ok: false, code: 1, error, stdout: "", stderr: error };
    }

    return new Promise((resolve) => {
      const args = [
        path.join(this.executorRoot, "bridges", "run-pipeline.js"),
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
          CPB_PROJECT_RUNTIME_ROOT: projectRuntimeRoot,
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

  async poll(): Promise<WorkerRunResult> {
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

  async run(): Promise<WorkerRunResult> {
    await this.init();
    this.startHeartbeat();

    try {
      await this.recoverOrphanedJobsStartup();
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
  return `Usage: node bridges/project-worker.js --project <id> [options]
       node bridges/project-worker.js --pool [options]

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

  const onSignal = (sig: string) => {
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
