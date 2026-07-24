// Merged from: job-store.ts, job-recovery.ts, jobs-index.ts

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  checkpointJob,
  materializeJob,
  readJobProjection,
  readEvents,
  listEventFiles,
  appendEvent,
  withLockedJobProjection,
} from "../event/event-store.js";
import type { EventRecord } from "../event/event-types.js";
import { getWorkflow, isWorkflowName } from "../../../core/workflow/definition.js";
import { recordPerformance, recordQualityScore } from "../observability/observability.js";
import {
  assertValidRoutingRules,
  fallbackAgentForRole,
  resolveEffectiveRouting,
  selectAgentWithFallback,
} from "../../../core/agents/routing.js";
import { validatePolicy } from "../../../core/policy/team-policy.js";
import { runtimeDataPath, runtimeDataRoot, resolveProjectDataRoot } from "../runtime.js";
import { isRecord, type LooseRecord } from "../../../core/contracts/types.js";
import { AssignmentStore } from "../../../shared/orchestrator/assignment-store.js";
import { openPinnedHubRedisStateBackend } from "../../../shared/hub-state-redis.js";
import type { ProcessIdentity } from "../../../core/runtime/process-tree.js";
import {
  readBoundedRegularFileNoFollow,
  withDurableDirectoryLock,
} from "../../../core/runtime/durable-directory-lock.js";
import { writeJsonDurableAtomic } from "../../../shared/hub-maintenance.js";

// ──────────────────────────────────────────────────────────────────────────────
// jobs-index.ts (merged)
// ──────────────────────────────────────────────────────────────────────────────

const INDEX_VERSION = 1;
const LOCK_TTL_MS = 30_000;
const LOCK_RETRY_COUNT = 6_000;
const LOCK_RETRY_DELAY_MS = 10;
const JOBS_INDEX_MAX_BYTES = 64 * 1024 * 1024;
const JOBS_INDEX_READ_RETRIES = 3;

export type JobsIndexLockTestHooks = {
  afterRecoveryObserved?: (context: { lockDir: string; owner: LooseRecord | null }) => void | Promise<void>;
  afterQuarantineRename?: (context: { lockDir: string; quarantineDir: string; ownerToken: string | null }) => void | Promise<void>;
  captureProcessIdentity?: () => ProcessIdentity | null;
  waitMs?: number;
  afterProjectionRead?: (context: {
    project: string;
    jobId: string;
    eventCount: number;
    state: LooseRecord;
  }) => void | Promise<void>;
};

const jobsIndexLockTestHookStorage = new AsyncLocalStorage<JobsIndexLockTestHooks>();

export function withJobsIndexLockTestHooksForTests<T>(hooks: JobsIndexLockTestHooks, fn: () => T): T {
  const parent = jobsIndexLockTestHookStorage.getStore();
  return jobsIndexLockTestHookStorage.run(parent ? { ...parent, ...hooks } : hooks, fn);
}

function jobsIndexLockTestHooks() {
  return jobsIndexLockTestHookStorage.getStore() || {};
}

function lockErrno(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

type RuntimePathOptions = LooseRecord & {
  dataRoot?: string;
  hubRoot?: string;
  legacyOnly?: boolean;
  includeLegacyFallback?: boolean;
};

type ExecutorRefState = LooseRecord & {
  root?: string | null;
  releaseId?: string | null;
  packageName?: string | null;
};

type RetryContextState = LooseRecord & {
  failureKind?: string | null;
  failureReason?: string | null;
  previousPhase?: string | null;
  previousNodeId?: string | null;
  resumeTarget?: (LooseRecord & { phase?: string | null; nodeId?: string | null }) | null;
  retryCount?: number | null;
  maxRetries?: number | null;
  fix_scope?: unknown;
};

type RecoverySourceOptions = {
  fromPhase?: string | null;
  trigger?: string | null;
  recoveryReason?: string | null;
  retryCount?: number;
  maxRetries?: number | null;
  forceFreshSession?: boolean;
};

type SourceContextState = LooseRecord & {
  retryContext?: RetryContextState | null;
  retry?: RetryContextState | null;
  previousFailure?: RetryContextState | null;
  dagResume?: DagResumeState | null;
  queueEntryId?: string | null;
};

type FailureCauseState = LooseRecord & {
  kind?: string | null;
  reason?: string | null;
  cause?: {
    retryContext?: RetryContextState | null;
  } | null;
  stderrSnippet?: unknown;
  rawOutput?: unknown;
  stdoutTail?: unknown;
  stderrTail?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  checks?: Array<LooseRecord>;
};

type DagResumeState = LooseRecord & {
  failedNodeId?: string | null;
  resumeTarget?: (LooseRecord & { phase?: string | null; nodeId?: string | null }) | null;
  completedNodeIds?: string[];
};

type JobState = LooseRecord & {
  jobId?: string;
  project?: string;
  task?: string;
  workflow?: string;
  status?: string;
  phase?: string;
  createdAt?: string;
  updatedAt?: string;
  executor?: ExecutorRefState | null;
  executorSelection?: LooseRecord | null;
  agent?: string | null;
  leaseId?: string | null;
  queueEntryId?: string | null;
  artifacts?: LooseRecord;
  completedPhases?: string[];
  completionReport?: LooseRecord | null;
  failureCode?: string | null;
  failurePhase?: string | null;
  retryable?: boolean;
  retryCount?: number;
  maxRetries?: number | null;
  failureCause?: FailureCauseState | null;
  blockedReason?: string | null;
  sourceContext?: SourceContextState | null;
  dagResume?: DagResumeState | null;
  phaseStartedAt?: string | null;
  worktree?: string | null;
  cancelRequested?: boolean;
  cancelReason?: string | null;
  redirectEventId?: string | null;
  redirectContext?: unknown;
  redirectReason?: unknown;
  consumedRedirectIds?: string[];
  lineage?: (LooseRecord & {
    parentJobId?: string | null;
    parentStatus?: string | null;
    parentFailureCode?: string | null;
    parentFailurePhase?: string | null;
    parentBlockedReason?: unknown;
    recoveryReason?: string | null;
    trigger?: string | null;
    executorSelection?: LooseRecord | null;
  }) | null;
  recoveryOf?: string | null;
  pr?: LooseRecord | null;
  finalizer?: (LooseRecord & {
    ok?: boolean;
    status?: string;
    mode?: string;
  }) | null;
  verdict?: string | null;
  adversarialVerdict?: LooseRecord | null;
};

type JobsIndex = {
  _meta: {
    version: number;
    updatedAt: string | null;
    jobCount: number;
  };
  jobs: Record<string, JobState>;
};

type IndexOpts = RuntimePathOptions;

async function withIndexLock<T>(lockDir: string, callback: () => Promise<T>): Promise<T> {
  const testHooks = jobsIndexLockTestHooks();
  return withDurableDirectoryLock(lockDir, callback, {
    ttlMs: LOCK_TTL_MS,
    waitMs: testHooks.waitMs ?? LOCK_RETRY_COUNT * LOCK_RETRY_DELAY_MS,
    retryMs: LOCK_RETRY_DELAY_MS,
    hooks: {
      afterRecoveryObserved: ({ lockDir: observedLockDir }) => jobsIndexLockTestHooks().afterRecoveryObserved?.({
        lockDir: observedLockDir,
        owner: null,
      }),
      afterQuarantineRename: ({ lockDir: quarantinedLockDir, quarantineDir, ownerToken }) => (
        jobsIndexLockTestHooks().afterQuarantineRename?.({
          lockDir: quarantinedLockDir,
          quarantineDir,
          ownerToken,
        })
      ),
    },
    captureIdentity: testHooks.captureProcessIdentity
      ? () => jobsIndexLockTestHooks().captureProcessIdentity?.() ?? null
      : undefined,
  });
}

const _writeQueues = new Map<string, Promise<unknown>>();

function enqueueWrite<T>(cpbRoot: string, opts: IndexOpts, fn: () => Promise<T>): Promise<T> {
  const key = indexFilePath(cpbRoot, opts);
  const lockDir = `${key}.lock`;
  const prev = _writeQueues.get(key) || Promise.resolve();
  const next = prev.then(() => withIndexLock(lockDir, fn));
  const tail = next.catch(() => {});
  _writeQueues.set(key, tail);
  void tail.then(() => {
    if (_writeQueues.get(key) === tail) _writeQueues.delete(key);
  });
  return next;
}

function _base(cpbRoot: string, opts: IndexOpts) {
  if (opts?.dataRoot) return path.resolve(opts.dataRoot);
  if (opts?.legacyOnly === true) return runtimeDataRoot(cpbRoot);
  throw new Error("dataRoot is required for project jobs-index paths");
}

function indexFilePath(cpbRoot: string, opts: IndexOpts = {}) {
  return path.join(_base(cpbRoot, opts), "jobs-index.json");
}

function compositeKey(project: string, jobId: string) {
  return `${project}/${jobId}`;
}

export async function readJobsIndex(cpbRoot: string, opts: IndexOpts = {}): Promise<JobsIndex | null> {
  const indexFile = indexFilePath(cpbRoot, opts);
  let raw: string | null = null;
  for (let attempt = 0; attempt < JOBS_INDEX_READ_RETRIES; attempt += 1) {
    try {
      raw = await readBoundedRegularFileNoFollow(indexFile, { maxBytes: JOBS_INDEX_MAX_BYTES });
      break;
    } catch (cause) {
      const code = lockErrno(cause);
      if (code === "ENOENT") return null;
      if (code === "BOUNDED_FILE_CHANGED" && attempt + 1 < JOBS_INDEX_READ_RETRIES) continue;
      throw Object.assign(new Error(`jobs index could not be read safely: ${indexFile}`, { cause }), {
        code: code === "BOUNDED_FILE_CHANGED"
          ? "JOBS_INDEX_READ_RACE"
          : code === "BOUNDED_FILE_UNSAFE" || code === "BOUNDED_FILE_TOO_LARGE"
            ? "JOBS_INDEX_UNSAFE"
            : "JOBS_INDEX_READ_FAILED",
        committed: false,
        recoveryPaths: { indexFile },
      });
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw!);
  } catch (cause) {
    throw Object.assign(new Error(`jobs index contains invalid JSON: ${indexFile}`, { cause }), {
      code: "JOBS_INDEX_CORRUPT",
      committed: false,
      recoveryPaths: { indexFile },
    });
  }
  if (
    !isRecord(parsed)
    || !isRecord(parsed._meta)
    || parsed._meta.version !== INDEX_VERSION
    || (parsed._meta.updatedAt !== null && typeof parsed._meta.updatedAt !== "string")
    || typeof parsed._meta.jobCount !== "number"
    || !Number.isSafeInteger(parsed._meta.jobCount)
    || parsed._meta.jobCount < 0
    || !isRecord(parsed.jobs)
    || Object.values(parsed.jobs).some((job) => !isRecord(job))
    || parsed._meta.jobCount !== Object.keys(parsed.jobs).length
  ) {
    throw Object.assign(new Error(`jobs index has an unsupported or invalid shape: ${indexFile}`), {
      code: "JOBS_INDEX_INVALID",
      committed: false,
      recoveryPaths: { indexFile },
    });
  }
  return parsed as JobsIndex;
}

async function writeJobsIndex(cpbRoot: string, index: JobsIndex, opts: IndexOpts = {}) {
  const target = indexFilePath(cpbRoot, opts);
  await writeJsonDurableAtomic(target, index);
}

export async function updateJobsIndexEntry(cpbRoot: string, project: string, jobId: string, state: LooseRecord, opts: IndexOpts = {}) {
  return enqueueWrite(cpbRoot, opts, async () => {
    const afterProjectionRead = jobsIndexLockTestHooks().afterProjectionRead;
    if (afterProjectionRead) {
      const observed = await readJobProjection(cpbRoot, project, jobId, opts);
      await afterProjectionRead({
        project,
        jobId,
        eventCount: observed.eventCount,
        state: observed.eventCount > 0 ? observed.state : state,
      });
    }

    // Lock order is jobs-index -> event file. appendEvent never acquires the
    // jobs-index lock while holding the event lock, so publication is atomic
    // with respect to event appends without introducing a reverse lock edge.
    return withLockedJobProjection(cpbRoot, project, jobId, opts, async (projection) => {
      const authoritativeState = projection.eventCount > 0 ? projection.state : state;
      const index = await readJobsIndex(cpbRoot, opts) || {
        _meta: { version: INDEX_VERSION, updatedAt: null, jobCount: 0 },
        jobs: {},
      } satisfies JobsIndex;

      index.jobs[compositeKey(project, jobId)] = authoritativeState as JobState;
      index._meta.updatedAt = new Date().toISOString();
      index._meta.jobCount = Object.keys(index.jobs).length;

      await writeJobsIndex(cpbRoot, index, opts);
      return authoritativeState as JobState;
    });
  });
}

async function rebuildJobsIndexLocked(cpbRoot: string, opts: IndexOpts = {}) {
  const files = await listEventFiles(cpbRoot, opts);
  const jobs: Record<string, JobState> = {};

  for (const { project, jobId } of files) {
    const events = await readEvents(cpbRoot, project, jobId, opts);
    if (events.length === 0) continue;
    const state = materializeJob(events) as JobState;
    if (state.createdAt && state.project && state.jobId) {
      jobs[compositeKey(project, jobId)] = state;
    }
  }

  const index = {
    _meta: {
      version: INDEX_VERSION,
      updatedAt: new Date().toISOString(),
      jobCount: Object.keys(jobs).length,
    },
    jobs,
  };

  await writeJobsIndex(cpbRoot, index, opts);
  return index;
}

export async function rebuildJobsIndex(cpbRoot: string, opts: IndexOpts = {}) {
  return enqueueWrite(cpbRoot, opts, () => rebuildJobsIndexLocked(cpbRoot, opts));
}

async function mergeMissingEventStreams(cpbRoot: string, index: JobsIndex, opts: IndexOpts = {}) {
  const files = await listEventFiles(cpbRoot, opts);
  const validKeys = new Set(files.map(({ project, jobId }) => compositeKey(project, jobId)));
  let changed = false;

  for (const key of Object.keys(index.jobs)) {
    if (!validKeys.has(key)) {
      delete index.jobs[key];
      changed = true;
    }
  }

  for (const { project, jobId } of files) {
    const key = compositeKey(project, jobId);
    if (index.jobs[key]) continue;
    const events = await readEvents(cpbRoot, project, jobId, opts);
    if (events.length === 0) continue;
    const state = materializeJob(events) as JobState;
    if (state.createdAt && state.project && state.jobId) {
      index.jobs[key] = state;
      changed = true;
    }
  }

  if (changed) {
    index._meta.updatedAt = new Date().toISOString();
    index._meta.jobCount = Object.keys(index.jobs).length;
    await writeJobsIndex(cpbRoot, index, opts);
  }

  return index;
}

export async function listJobsFromIndex(cpbRoot: string, opts: IndexOpts = {}) {
  return enqueueWrite(cpbRoot, opts, async () => {
    let index = await readJobsIndex(cpbRoot, opts);
    if (!index) {
      index = await rebuildJobsIndexLocked(cpbRoot, opts);
    } else {
      index = await mergeMissingEventStreams(cpbRoot, index, opts);
    }

    return Object.values(index.jobs)
      .filter((job) => job.createdAt && job.project && job.jobId)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// job-store.ts (merged)
// ──────────────────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

async function redisJobBackend() {
  const hubRoot = process.env.CPB_HUB_ROOT;
  if (!hubRoot) return null;
  return await openPinnedHubRedisStateBackend({
    configFile: process.env.CPB_HUB_STATE_REDIS_CONFIG_FILE,
    hubRoot,
  });
}

function redisJobField(project: string, jobId: string) {
  const part = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `job:${part(project)}:${part(jobId)}`;
}

async function assertNoLocalJobEventFiles(cpbRoot: string, dataRoot?: string) {
  const roots = dataRoot
    ? [{ dataRoot }]
    : (await import("../runtime.js")).listRuntimeDataRoots(cpbRoot, {
        hubRoot: process.env.CPB_HUB_ROOT,
        includeLegacy: true,
      });
  for (const root of await roots) {
    const files = await listEventFiles(cpbRoot, { dataRoot: root.dataRoot, includeLegacyFallback: false });
    if (files.length > 0) {
      throw Object.assign(new Error("local job events require an explicit Redis migration"), {
        code: "HUB_JOB_MIGRATION_REQUIRED",
      });
    }
  }
}

async function retryUpdate<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) {
        const ts = new Date().toISOString();
        process.stderr.write(`${ts} [error] [job-store] index update failed after ${maxRetries} retries: ${err.message}\n`);
        throw err;
      } else {
        await new Promise(r => setTimeout(r, 100 * (i + 1)));
      }
    }
  }
  throw new Error("index update retry loop exhausted");
}

function nowIso() {
  return new Date().toISOString();
}

function executorRef(value: unknown) {
  const record = isRecord(value) ? value : {};
  return {
    root: typeof record.root === "string" ? record.root : null,
    releaseId: typeof record.releaseId === "string" ? record.releaseId : null,
  };
}

async function requireNotTerminal(cpbRoot: string, project: string, jobId: string, { allowMissing = false, dataRoot }: RuntimePathOptions & { allowMissing?: boolean } = {}) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (!job?.jobId) {
    if (allowMissing) return;
    throw new Error(`job not found: ${jobId}`);
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    throw new Error(`job is terminal: ${job.status}`);
  }
}


async function getJobAndUpdateIndex(cpbRoot: string, project: string, jobId: string, { dataRoot }: RuntimePathOptions = {}) {
  return retryUpdate(async () => {
    const state = await getJob(cpbRoot, project, jobId, { dataRoot });
    return updateJobsIndexEntry(cpbRoot, project, jobId, state, { dataRoot });
  });
}

async function extractJobExperienceBestEffort(cpbRoot: string, project: string, jobId: string, { dataRoot }: RuntimePathOptions = {}) {
  try {
    const { extractExperienceForJob } = await import("../event/event-source.js");
    await extractExperienceForJob(cpbRoot, project, jobId, { dataRoot });
  } catch {
    // Experience extraction should never change the terminal job outcome.
  }
}

export const FAILURE_CODES = Object.freeze({
  RECOVERABLE: "RECOVERABLE",
  QUALITY_FAIL: "QUALITY_FAIL",
  BLOCKED: "BLOCKED",
  FATAL: "FATAL",
  PLAN_ARTIFACT_INVALID: "PLAN_ARTIFACT_INVALID",
  ISSUE_MISMATCH: "ISSUE_MISMATCH",
});

export function makeJobId(ts = nowIso(), suffix = randomBytes(3).toString("hex")) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid timestamp");
  }

  const compact = date.toISOString().replace(/[-:]/g, "");
  return `job-${compact.slice(0, 8)}-${compact.slice(9, 15)}-${suffix}`;
}

export async function createJob(
  cpbRoot: string,
  {
    project,
    task,
    workflow = "standard",
    planMode = null,
    ts = nowIso(),
    jobId: providedJobId,
    executor = null,
    dataRoot,
    sourceContext,
    queueEntryId = null,
    indexSnapshot = null,
    indexFreshness = null,
    planCache = null,
    routingCategory = null,
    routing = null,
    agentAvailability = null,
    teamPolicy = null,
  }: RuntimePathOptions & {
    project?: string;
    task?: string;
    workflow?: string;
    planMode?: string | null;
    ts?: string;
    jobId?: string;
    executor?: string | LooseRecord | null;
    sourceContext?: LooseRecord | string | null;
    queueEntryId?: string | null;
    indexSnapshot?: LooseRecord | null;
    indexFreshness?: LooseRecord | null;
    planCache?: LooseRecord | null;
    routingCategory?: string | null;
    routing?: LooseRecord | null;
    agentAvailability?: LooseRecord | null;
    teamPolicy?: LooseRecord | null;
  }
) {
  if (teamPolicy != null) {
    const { valid, errors } = validatePolicy(teamPolicy);
    if (!valid) {
      throw new Error(`invalid team policy: ${errors.join("; ")}`);
    }
  }

  const jobId = providedJobId || makeJobId(ts);
  let selectedWorkflow = workflow;
  let selectedExecutor = executor;
  let executorSelection = null;

  if (!selectedExecutor && (routingCategory || routing)) {
    assertValidRoutingRules(routing, { isWorkflowName });
    const routingSelection = resolveEffectiveRouting(routingCategory, routing, { workflow });
    const preferredAgent = typeof routingSelection.executor === "string" ? routingSelection.executor : null;
    const allowFallback = typeof routingSelection.allowFallback === "boolean" ? routingSelection.allowFallback : undefined;
    selectedWorkflow = routingSelection.workflow || selectedWorkflow;
    executorSelection = selectAgentWithFallback({
      role: "executor",
      preferredAgent,
      fallbackAgent: fallbackAgentForRole(routingSelection, "executor"),
      agentAvailability,
      allowFallback,
      policyAllowsFallback: (isRecord(teamPolicy?.routing) ? teamPolicy.routing.allowFallback : undefined) !== false,
    });
    selectedExecutor = executorSelection.selectedAgent || null;
    executorSelection = {
      ...executorSelection,
      category: routingSelection.category || routingCategory || null,
      workflow: selectedWorkflow,
    };
  }

  // Guard: reject creation with an existing job id
  if (providedJobId) {
    const existing = await getJob(cpbRoot, project, providedJobId, { dataRoot });
    if (existing?.jobId) {
      if (TERMINAL_STATUSES.has(existing.status)) {
        throw new Error(`job is terminal: ${existing.status}`);
      }
      throw new Error(`job already exists: ${providedJobId}`);
    }
  }

  if (queueEntryId) {
    const existingForQueue = await getJobByQueueEntryId(cpbRoot, project, queueEntryId, { dataRoot });
    if (existingForQueue) {
      return existingForQueue;
    }
  }

  const event: EventRecord = {
    type: "job_created",
    jobId,
    project,
    task,
    workflow: selectedWorkflow,
    planMode,
    executor: selectedExecutor,
    queueEntryId,
    ts,
  };
  if (executorSelection) event.executorSelection = executorSelection;
  if (sourceContext && typeof sourceContext === "object") {
    event.sourceContext = sourceContext;
  }
  if (indexSnapshot) {
    event.indexSnapshotId = typeof indexSnapshot.indexSnapshotId === "string" ? indexSnapshot.indexSnapshotId : null;
    event.sourceFingerprint = typeof indexSnapshot.sourceFingerprint === "string" ? indexSnapshot.sourceFingerprint : null;
  }
  if (indexFreshness) {
    event.indexFreshness = indexFreshness;
  }
  if (planCache) {
    event.planCache = planCache;
  }
  await appendEvent(cpbRoot, project, jobId, event, { dataRoot });
  if (executorSelection) {
    await appendEvent(cpbRoot, project, jobId, {
      type: "agent_routing_decision",
      jobId,
      project,
      role: "executor",
      category: executorSelection.category,
      workflow: selectedWorkflow,
      preferredAgent: executorSelection.preferredAgent,
      selectedAgent: executorSelection.selectedAgent,
      fallbackAgent: executorSelection.fallbackAgent,
      fallbackAllowed: executorSelection.fallbackAllowed,
      fallbackApplied: executorSelection.fallbackApplied,
      reason: executorSelection.reason,
      executorSelection,
      ts,
    }, { dataRoot });
  }
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function startPhase(
  cpbRoot: string,
  project: string,
  jobId: string,
  { phase, attempt = 1, leaseId, ts = nowIso(), dataRoot, acpProfile, uiLane, uiLaneReason }: RuntimePathOptions & {
    phase?: string;
    attempt?: number;
    leaseId?: string | null;
    ts?: string;
    acpProfile?: string | null;
    uiLane?: string | null;
    uiLaneReason?: string | null;
  }
) {
  const event: EventRecord = {
    type: "phase_started",
    jobId,
    project,
    phase,
    attempt,
    leaseId,
    ts,
  };
  if (acpProfile !== undefined) event.acpProfile = acpProfile;
  if (uiLane !== undefined) event.uiLane = uiLane;
  if (uiLaneReason !== undefined) event.uiLaneReason = uiLaneReason;
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, event, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

async function resolveAgentForPhase(cpbRoot: string, job: JobState | null | undefined, phase: string) {
  if (job?.agent && typeof job.agent === "string") {
    return job.agent;
  }
  if (job?.executor && typeof job.executor === "string") {
    return job.executor;
  }
  if (job?.executor && typeof job.executor === "object" && job.executor.packageName) {
    return job.executor.packageName;
  }

  try {
    const { normalizeWorkflow, resolveNodeAgent } = await import("../../../core/workflow/definition.js");
    const dag = normalizeWorkflow(job.workflow || "standard");
    if (dag && dag.nodes) {
        const node = dag.nodes.find((n: LooseRecord) => n.id === phase || n.phase === phase);
        if (node && typeof node.id === "string" && typeof node.phase === "string") {
          const workflowNode = { ...node, id: node.id, phase: node.phase };
          let poolStatus = null;
        try {
          const { getManagedAcpPool } = await import("../acp/acp-pool.js");
          const pool = getManagedAcpPool({ cpbRoot, hubRoot: undefined });
          poolStatus = await pool.statusAsync().catch(() => null);
        } catch {}
          const resolved = resolveNodeAgent(workflowNode, { poolStatus });
        if (resolved) return resolved;
      }
    }
  } catch {}

  try {
    const { roleForPhase } = await import("../../../core/workflow/definition.js");
    const wf = getWorkflow(job.workflow || "standard");
    const role = roleForPhase(wf, phase) || "executor";
    const agentRegistry = await import("../../../core/agents/registry.js");
    await (agentRegistry.loadRegistry as (configDir?: string) => Promise<void>)().catch(() => {});
    const agent = agentRegistry.defaultAgentForRole(role);
    if (agent) return agent;
  } catch {}

  return "unknown";
}

export async function completePhase(
  cpbRoot: string,
  project: string,
  jobId: string,
  { phase, artifact = "", ts = nowIso(), dataRoot }: RuntimePathOptions & {
    phase?: string;
    artifact?: string;
    ts?: string;
  }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_completed",
    jobId,
    project,
    phase,
    artifact,
    ts,
  }, { dataRoot });

  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  const agent = await resolveAgentForPhase(cpbRoot, job, phase);
  const role = job?.workflow ? getWorkflow(job.workflow).roleForPhase?.[phase] : null;
  await recordPerformance(cpbRoot, project, jobId, {
    agent,
    role,
    phase,
    status: "completed",
    durationMs: job?.phaseStartedAt ? (Date.now() - new Date(job.phaseStartedAt).getTime()) : null,
    ts,
  }).catch(() => {});

  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function blockJob(
  cpbRoot: string,
  project: string,
  jobId: string,
  { reason, code, kind, cause, ts = nowIso(), dataRoot }: RuntimePathOptions & {
    reason?: string;
    code?: string;
    kind?: string;
    cause?: unknown;
    ts?: string;
  }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true, dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_blocked",
    jobId,
    project,
    reason,
    code,
    kind,
    cause,
    ts,
  }, { dataRoot });
  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function failJob(
  cpbRoot: string,
  project: string,
  jobId: string,
  {
    reason,
    code = FAILURE_CODES.FATAL,
    phase,
    retryable,
    retryCount,
    cause,
    ts = nowIso(),
    dataRoot,
  }: RuntimePathOptions & {
    reason?: string;
    code?: string;
    phase?: string;
    retryable?: boolean;
    retryCount?: number;
    cause?: unknown;
    ts?: string;
  }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_failed",
    jobId,
    project,
    reason,
    code,
    phase,
    retryable: retryable ?? code === FAILURE_CODES.RECOVERABLE,
    retryCount,
    cause,
    ts,
  }, { dataRoot });
  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});

  await extractJobExperienceBestEffort(cpbRoot, project, jobId, { dataRoot });

  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

function inferRetryPhase(job: JobState) {
  const workflow = getWorkflow(job.workflow);
  if (job.failurePhase && workflow.phases.includes(job.failurePhase)) {
    return job.failurePhase;
  }
  for (const phase of workflow.phases) {
    if (!job.artifacts?.[phase]) return phase;
  }
  return workflow.phases[workflow.phases.length - 1] ?? null;
}

function terminalJobLineage(job: JobState) {
  return {
    parentJobId: job.jobId,
    parentStatus: job.status ?? null,
    parentFailureCode: job.failureCode ?? null,
    parentFailurePhase: job.failurePhase ?? null,
    parentBlockedReason: job.blockedReason ?? null,
  };
}

function truncateRecoveryText(value: unknown, maxChars = 4000) {
  const text = String(value || "");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function recoveryPreviousOutput(job: JobState) {
  const cause = job?.failureCause || {};
  const chunks = [];
  if (cause.stderrSnippet) chunks.push(`stderr snippet:\n${cause.stderrSnippet}`);
  if (cause.rawOutput) chunks.push(`raw output:\n${cause.rawOutput}`);
  if (cause.stdoutTail) chunks.push(`stdout tail:\n${cause.stdoutTail}`);
  if (cause.stderrTail) chunks.push(`stderr tail:\n${cause.stderrTail}`);
  if (cause.stdout) chunks.push(`stdout:\n${cause.stdout}`);
  if (cause.stderr) chunks.push(`stderr:\n${cause.stderr}`);
  if (Array.isArray(cause.checks)) {
    for (const check of cause.checks) {
      if (check?.stdoutTail) chunks.push(`${check.command || check.gate || "check"} stdout tail:\n${check.stdoutTail}`);
      if (check?.stderrTail) chunks.push(`${check.command || check.gate || "check"} stderr tail:\n${check.stderrTail}`);
      if (check?.message && !check?.stdoutTail && !check?.stderrTail) chunks.push(`${check.command || check.gate || "check"} message:\n${check.message}`);
    }
  }
  return truncateRecoveryText(chunks.filter(Boolean).join("\n\n"));
}

function recoveryDagResume(job: JobState) {
  const resume = job?.dagResume;
  if (!resume || typeof resume !== "object") return null;
  const rawResumeTarget = resume.resumeTarget;
  const resumeTarget = isRecord(rawResumeTarget) ? Object.assign({}, rawResumeTarget) : null;
  return {
    failedNodeId: resume.failedNodeId ?? null,
    resumeTarget,
    completedNodeIds: Array.isArray(resume.completedNodeIds) ? [...resume.completedNodeIds] : [],
  };
}

function buildRecoverySourceContext(originalJob: JobState, { fromPhase, trigger, recoveryReason, retryCount, maxRetries, forceFreshSession }: RecoverySourceOptions = {}): SourceContextState {
  const base: SourceContextState = originalJob?.sourceContext && typeof originalJob.sourceContext === "object"
    ? { ...originalJob.sourceContext }
    : {};
  const dagResume = recoveryDagResume(originalJob);
  const failureKind = originalJob?.failureCause?.kind || originalJob?.failureCode || "unknown";
  const failureReason = (originalJob?.blockedReason || originalJob?.failureCause?.reason || recoveryReason || "recovery requested") as string;
  const retry: RetryContextState = {
    failureKind,
    failureReason,
    previousOutput: recoveryPreviousOutput(originalJob),
    previousJobId: originalJob?.jobId || null,
    previousPhase: fromPhase || dagResume?.resumeTarget?.phase || originalJob?.failurePhase || null,
    previousNodeId: dagResume?.failedNodeId || dagResume?.resumeTarget?.nodeId || null,
    resumeTarget: dagResume?.resumeTarget ? Object.assign({}, dagResume.resumeTarget) : null,
    completedNodeIds: dagResume?.completedNodeIds ? [...dagResume.completedNodeIds] : [],
    previousQueueEntryId: originalJob?.queueEntryId || base.queueEntryId || null,
    retryCount: retryCount ?? originalJob?.retryCount ?? null,
    maxRetries: maxRetries ?? originalJob?.maxRetries ?? null,
    trigger: trigger || "manual",
    artifacts: originalJob?.artifacts || {},
    verdict: originalJob?.verdict || null,
    adversarialVerdict: originalJob?.adversarialVerdict || null,
    ...(forceFreshSession ? { forceFreshSession: true } : {}),
  };
  return {
    ...base,
    ...(dagResume ? { dagResume } : {}),
    retry,
    previousFailure: {
      kind: failureKind,
      reason: failureReason,
      jobId: originalJob?.jobId || null,
      phase: retry.previousPhase,
      nodeId: retry.previousNodeId,
      resumeTarget: retry.resumeTarget ? Object.assign({}, retry.resumeTarget) : null,
      completedNodeIds: [...retry.completedNodeIds],
      verdict: retry.verdict,
      adversarialVerdict: retry.adversarialVerdict,
      retryCount: retry.retryCount,
      maxRetries: retry.maxRetries,
    },
  };
}

export async function createRecoveryJob(
  cpbRoot: string,
  project: string,
  originalJob: JobState,
  { fromPhase, trigger, recoveryReason, ts, dataRoot, executor, executorSelection, retryCount, maxRetries, forceFreshSession }: RuntimePathOptions & {
    fromPhase?: string | null;
    trigger?: string | null;
    recoveryReason?: string | null;
    ts?: string;
    executor?: string | LooseRecord | null;
    executorSelection?: LooseRecord | null;
    retryCount?: number;
    maxRetries?: number;
    forceFreshSession?: boolean;
  } = {}
) {
  const lineage = terminalJobLineage(originalJob);
  const now = ts || nowIso();
  const selectedExecutor = executor === undefined ? originalJob.executor ?? null : executor;
  const recoverySourceContext = buildRecoverySourceContext(originalJob, {
    fromPhase,
    trigger,
    recoveryReason,
    retryCount,
    maxRetries,
    forceFreshSession,
  });

  const newJob = await createJob(cpbRoot, {
    project,
    task: originalJob.task,
    workflow: originalJob.workflow,
    ts: now,
    executor: selectedExecutor,
    dataRoot,
    sourceContext: recoverySourceContext,
  });

  const event: EventRecord = {
    type: "recovery_created",
    jobId: newJob.jobId,
    project,
    recoveryOf: originalJob.jobId,
    lineage,
    recoveryReason: recoveryReason || `fresh recovery from ${originalJob.status} job ${originalJob.jobId}`,
    trigger: trigger || "manual",
    fromPhase: fromPhase || null,
    ts: now,
  };
  if (recoverySourceContext) event.sourceContext = recoverySourceContext;
  if (executorSelection) event.executorSelection = executorSelection;
  if (retryCount !== undefined) event.retryCount = retryCount;
  if (maxRetries !== undefined) event.maxRetries = maxRetries;
  await appendEvent(cpbRoot, project, newJob.jobId, event, { dataRoot });

  return getJobAndUpdateIndex(cpbRoot, project, newJob.jobId, { dataRoot });
}

export async function retryJob(
  cpbRoot: string,
  project: string,
  jobId: string,
  {
    fromPhase,
    force = false,
    trigger = "manual",
    maxRetries,
    ts = nowIso(),
    dataRoot,
    useCurrentExecutor = false,
    currentExecutor = null,
    forceFreshSession = false,
  }: RuntimePathOptions & {
    fromPhase?: string;
    force?: boolean;
    trigger?: string;
    maxRetries?: number;
    useCurrentExecutor?: boolean;
    currentExecutor?: string | LooseRecord | null;
    forceFreshSession?: boolean;
    ts?: string;
  } = {}
) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (!job?.jobId) {
    throw new Error(`job not found: ${jobId}`);
  }
  if (typeof job.status !== "string" || !["failed", "blocked", "cancelled"].includes(job.status)) {
    throw new Error(`job is not recoverable: ${job.status ?? "unknown"}`);
  }
  if (job.status === "cancelled" && !force) {
    throw new Error("cancelled job requires --force to recover");
  }

  const code = job.failureCode ?? FAILURE_CODES.FATAL;
  if (job.status === "failed" && code === FAILURE_CODES.FATAL && !force) {
    throw new Error(`fatal job is not retryable: ${job.blockedReason ?? "unknown failure"}`);
  }
  if (job.status === "failed" && !job.retryable && !force) {
    throw new Error(`job requires --force to retry: ${code}`);
  }

  const effectiveMaxRetries = maxRetries ?? job.maxRetries ?? 3;
  const retryCount = (job.retryCount ?? 0) + 1;
  if (retryCount > effectiveMaxRetries) {
    throw new Error(`retry limit exceeded: ${retryCount}/${effectiveMaxRetries}`);
  }

  const workflow = getWorkflow(job.workflow || "standard");
  const retryPhase = fromPhase || job.dagResume?.resumeTarget?.phase || inferRetryPhase(job);
  if (!retryPhase || !workflow.phases.includes(retryPhase)) {
    throw new Error(`invalid retry phase: ${retryPhase ?? "unknown"}`);
  }

  const parentExecutor = job.executor ?? null;
  const selectedExecutor = useCurrentExecutor && currentExecutor ? currentExecutor : parentExecutor;
  const parentExecutorRef = executorRef(parentExecutor);
  const selectedExecutorRef = executorRef(selectedExecutor);
  const executorSelection = {
    mode: useCurrentExecutor ? "use-current" : "preserve-parent",
    override: !!useCurrentExecutor,
    parentRoot: parentExecutorRef.root,
    selectedRoot: selectedExecutorRef.root,
    parentReleaseId: parentExecutorRef.releaseId,
    selectedReleaseId: selectedExecutorRef.releaseId,
  };

  return createRecoveryJob(cpbRoot, project, job, {
    fromPhase: retryPhase,
    trigger,
    recoveryReason: `fresh recovery from ${job.status} job ${jobId}`,
    ts,
    dataRoot,
    executor: selectedExecutor,
    executorSelection,
    retryCount,
    maxRetries: effectiveMaxRetries,
    forceFreshSession,
  });
}

export async function budgetExceeded(
  cpbRoot: string,
  project: string,
  jobId: string,
  { reason, ts = nowIso(), dataRoot }: RuntimePathOptions & { reason: string; ts?: string }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "budget_exceeded",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });

  await extractJobExperienceBestEffort(cpbRoot, project, jobId, { dataRoot });

  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function poolExhaustedJob(
  cpbRoot: string,
  project: string,
  jobId: string,
  {
    reason,
    providerKey,
    agent,
    elapsedMs,
    phase,
    ts = nowIso(),
    dataRoot,
  }: RuntimePathOptions & {
    reason?: string;
    providerKey?: unknown;
    agent?: unknown;
    elapsedMs?: unknown;
    phase?: string;
    ts?: string;
  } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  const event = {
    type: "pool_exhausted",
    jobId,
    project,
    reason,
    providerKey: providerKey as string,
    agent: agent as string,
    elapsedMs: elapsedMs as number,
    phase,
    ts,
  };
  await appendEvent(cpbRoot, project, jobId, event, { dataRoot });
  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});

  await extractJobExperienceBestEffort(cpbRoot, project, jobId, { dataRoot });

  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function completeJob(
  cpbRoot: string,
  project: string,
  jobId: string,
  { ts = nowIso(), dataRoot }: RuntimePathOptions & { ts?: string } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_completed",
    jobId,
    project,
    ts,
  }, { dataRoot });

  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  const verdictValue = job?.verdict || job?.artifacts?.verdict || null;
  const verdict = typeof verdictValue === "string" ? verdictValue : null;
  if (verdict) {
    const agent = await resolveAgentForPhase(cpbRoot, job, "verify");
    await recordQualityScore(cpbRoot, project, jobId, {
      agent,
      phase: "verify",
      verdict: verdict.toUpperCase(),
      ts,
    }).catch(() => {});
  }

  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});

  await extractJobExperienceBestEffort(cpbRoot, project, jobId, { dataRoot });

  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function recordWorktreeCreated(
  cpbRoot: string,
  project: string,
  jobId: string,
  {
    worktree,
    branch,
    baseBranch = null,
    baseCommit = null,
    worktreeOwnership = null,
    ts = nowIso(),
    dataRoot,
  }: RuntimePathOptions & {
    worktree: string;
    branch: string;
    baseBranch?: string | null;
    baseCommit?: string | null;
    worktreeOwnership?: LooseRecord | null;
    ts?: string;
  }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "worktree_created",
    jobId,
    project,
    worktree,
    branch,
    baseBranch,
    baseCommit,
    ...(worktreeOwnership ? { worktreeOwnership } : {}),
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function recordActivity(
  cpbRoot: string,
  project: string,
  jobId: string,
  { message, ts = nowIso(), dataRoot }: RuntimePathOptions & { message: string; ts?: string }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "phase_activity",
    jobId,
    project,
    message,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function recordFinalizerResult(
  cpbRoot: string,
  project: string,
  jobId: string,
  { result, ts = nowIso(), dataRoot }: RuntimePathOptions & { result: LooseRecord | null; ts?: string }
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "finalizer_result",
    jobId,
    project,
    result,
    ts,
  }, { dataRoot });
  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function requestCancelJob(
  cpbRoot: string,
  project: string,
  jobId: string,
  { reason, ts = nowIso(), dataRoot, hubRoot }: RuntimePathOptions & { reason?: string; ts?: string } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true, dataRoot });
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  const assignmentCancel = hubRoot && job?.jobId
    ? await signalActiveAssignmentCancel(hubRoot, job, reason || "user cancel")
    : null;
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_cancel_requested",
    jobId,
    project,
    reason,
    assignmentCancel,
    ts,
  }, { dataRoot });
  return cancelJob(cpbRoot, project, jobId, { reason, ts, dataRoot });
}

async function signalActiveAssignmentCancel(hubRoot: string, job: JobState, reason: string) {
  const sourceContext = isRecord(job.sourceContext) ? job.sourceContext : {};
  const queueEntryId = typeof job.queueEntryId === "string" && job.queueEntryId
    ? job.queueEntryId
    : (typeof sourceContext.queueEntryId === "string" ? sourceContext.queueEntryId : null);
  if (!queueEntryId) return null;

  const assignments = new AssignmentStore(hubRoot);
  const assignmentId = `a-${queueEntryId}`;
  for (let retry = 0; retry < 2; retry += 1) {
    const [assignment, attempt] = await Promise.all([
      assignments.getAssignment(assignmentId),
      assignments.getActiveAttempt(assignmentId),
    ]);
    if (!assignment || !attempt) return null;
    if (assignment.projectId && assignment.projectId !== job.project) return null;
    if (["completed", "failed", "cancelled", "blocked"].includes(String(assignment.status || ""))) return null;

    try {
      const written = await assignments.writeCancel(assignmentId, attempt.attempt, reason);
      if (!written) return null;
      return {
        assignmentId,
        attempt: attempt.attempt,
        workerId: attempt.workerId || assignment.workerId || null,
        signalled: true,
      };
    } catch (error) {
      if (retry === 0 && isRecord(error) && error.code === "STALE_ATTEMPT") continue;
      throw error;
    }
  }
  return null;
}

export async function cancelJob(
  cpbRoot: string,
  project: string,
  jobId: string,
  { reason, ts = nowIso(), dataRoot }: RuntimePathOptions & { reason?: string; ts?: string } = {}
) {
  const existing = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (!existing?.jobId) {
    throw new Error(`job not found: ${jobId}`);
  }
  if (existing.status === "cancelled") {
    return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
  }
  if (TERMINAL_STATUSES.has(existing.status)) {
    throw new Error(`job is terminal: ${existing.status}`);
  }
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_cancelled",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });
  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});

  await extractJobExperienceBestEffort(cpbRoot, project, jobId, { dataRoot });

  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function requestRedirectJob(
  cpbRoot: string,
  project: string,
  jobId: string,
  { instructions, reason, ts = nowIso(), dataRoot }: RuntimePathOptions & {
    instructions?: string;
    reason?: string;
    ts?: string;
  } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true, dataRoot });
  const redirectEventId = `${jobId}-redirect-${Date.now()}`;
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_redirect_requested",
    jobId,
    project,
    instructions,
    reason,
    redirectEventId,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function consumeRedirect(
  cpbRoot: string,
  project: string,
  jobId: string,
  { redirectEventId, ts = nowIso(), dataRoot }: RuntimePathOptions & { redirectEventId?: string; ts?: string } = {}
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_redirect_consumed",
    jobId,
    project,
    redirectEventId,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function getJob(cpbRoot: string, project: string, jobId: string, { dataRoot }: RuntimePathOptions = {}): Promise<JobState | null> {
  const redis = await redisJobBackend();
  if (redis) {
    await assertNoLocalJobEventFiles(cpbRoot, dataRoot);
    const record = await redis.readStateRecord(redisJobField(project, jobId));
    if (record.data === null) return null;
    if (!isRecord(record.data) || record.data.project !== project || record.data.jobId !== jobId) {
      throw Object.assign(new Error(`invalid Redis job projection: ${project}/${jobId}`), { code: "HUB_STATE_RECORD_INVALID" });
    }
    return record.data as JobState;
  }
  const opts = { dataRoot };
  return (await readJobProjection(cpbRoot, project, jobId, opts)).state as JobState;
}

export async function listJobs(cpbRoot: string, options: RuntimePathOptions & { project?: string } = {}): Promise<JobState[]> {
  const { dataRoot, legacyOnly, ...rest } = options;
  const redis = await redisJobBackend();
  if (redis) {
    await assertNoLocalJobEventFiles(cpbRoot, dataRoot);
    const records = await redis.scanStateRecords("job:");
    return records.flatMap(({ record }) => {
      if (!isRecord(record.data) || !record.data.project || !record.data.jobId) {
        throw Object.assign(new Error("invalid Redis job projection"), { code: "HUB_STATE_RECORD_INVALID" });
      }
      if (rest.project && record.data.project !== rest.project) return [];
      return [record.data as JobState];
    }).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }
  if (!dataRoot && legacyOnly !== true) {
    const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, rest);
    return rest.project ? jobs.filter((job: JobState) => job.project === rest.project) : jobs;
  }
  const jobs: JobState[] = await listJobsFromIndex(cpbRoot, { ...rest, dataRoot, legacyOnly });
  return rest.project ? jobs.filter((job: JobState) => job.project === rest.project) : jobs;
}

export async function getJobByQueueEntryId(cpbRoot: string, project: string, queueEntryId: string, { dataRoot }: RuntimePathOptions = {}) {
  if (!queueEntryId) return null;
  const jobs = await listJobs(cpbRoot, { project, dataRoot });
  return jobs.find((job: JobState) => job.queueEntryId === queueEntryId) || null;
}

export async function listJobsAcrossRuntimeRoots(cpbRoot: string, options: RuntimePathOptions & { project?: string; hubRoot?: string } = {}): Promise<JobState[]> {
  const { listRuntimeDataRoots } = await import("../runtime.js");
  const roots = await listRuntimeDataRoots(cpbRoot, options);
  const seen = new Set();
  const jobs = [];
  for (const root of roots) {
    const runtimeOptions = root.kind === "legacy"
      ? { legacyOnly: true, includeLegacyFallback: true }
      : { dataRoot: root.dataRoot, includeLegacyFallback: false };
    const batch = await listJobs(cpbRoot, runtimeOptions);
    for (const job of batch) {
      const key = `${job.project}/${job.jobId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
  }
  return jobs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

// ──────────────────────────────────────────────────────────────────────────────
// job-recovery.ts (merged)
// ──────────────────────────────────────────────────────────────────────────────

type TerminalStatusProbe = {
  jobId?: unknown;
  status?: string | null;
};

export function isTerminal(job: TerminalStatusProbe | null | undefined) {
  return !job?.jobId || TERMINAL_STATUSES.has(job.status || "");
}

export function isRecoverable(job: TerminalStatusProbe | null | undefined) {
  if (!isTerminal(job)) return false;
  if (job.status === "completed") return false;
  return ["failed", "blocked", "cancelled"].includes(job.status);
}

async function resolveRecoveryRuntimeOptions(cpbRoot: string, project: string, options: RuntimePathOptions & { hubRoot?: string } = {}) {
  if (options.dataRoot) {
    return { dataRoot: options.dataRoot, includeLegacyFallback: false };
  }
  if (options.hubRoot || process.env.CPB_HUB_ROOT) {
    const dataRoot = await resolveProjectDataRoot(cpbRoot, project, {
      hubRoot: options.hubRoot || process.env.CPB_HUB_ROOT,
      dataRoot: process.env.CPB_PROJECT_RUNTIME_ROOT,
    });
    return { dataRoot, includeLegacyFallback: false };
  }
  return {};
}

export async function recoverAsNewJob(cpbRoot: string, project: string, jobId: string, options: RuntimePathOptions & {
  ts?: string;
  reason?: string;
  trigger?: string;
  useCurrentExecutor?: boolean;
  currentExecutor?: string | LooseRecord | null;
  hubRoot?: string;
} = {}) {
  const { ts, reason, trigger = "recovery", useCurrentExecutor = false, currentExecutor = null } = options;
  const runtimeOpts = await resolveRecoveryRuntimeOptions(cpbRoot, project, options);
  const dataRoot = runtimeOpts.dataRoot;
  const original = await getJob(cpbRoot, project, jobId, runtimeOpts);
  if (!original?.jobId) {
    throw new Error(`job not found: ${jobId}`);
  }

  if (!isTerminal(original)) {
    throw new Error(`job is not terminal: ${original.status}`);
  }

  if (original.status === "completed") {
    throw new Error(`completed job does not need recovery: ${jobId}`);
  }

  const recoveryReason = reason || `recovery from ${original.status} job ${jobId}`;
  const parentExecutor = original.executor ?? null;
  const selectedExecutor = useCurrentExecutor && currentExecutor ? currentExecutor : parentExecutor;
  const parentExecutorRef = executorRef(parentExecutor);
  const selectedExecutorRef = executorRef(selectedExecutor);
  const executorSelection = {
    mode: useCurrentExecutor ? "use-current" : "preserve-parent",
    override: !!useCurrentExecutor,
    parentRoot: parentExecutorRef.root,
    selectedRoot: selectedExecutorRef.root,
    parentReleaseId: parentExecutorRef.releaseId,
    selectedReleaseId: selectedExecutorRef.releaseId,
  };

  return createRecoveryJob(cpbRoot, project, original, {
    trigger,
    recoveryReason,
    ts,
    executor: selectedExecutor,
    executorSelection,
    dataRoot,
  });
}

export async function retryAsNewJob(cpbRoot: string, project: string, jobId: string, options: RuntimePathOptions & {
  ts?: string;
  reason?: string;
  trigger?: string;
  fromPhase?: string;
  force?: boolean;
  useCurrentExecutor?: boolean;
  currentExecutor?: string | LooseRecord | null;
  hubRoot?: string;
} = {}) {
  const { ts, fromPhase, trigger = "manual", useCurrentExecutor = false, currentExecutor = null } = options;
  const runtimeOpts = await resolveRecoveryRuntimeOptions(cpbRoot, project, options);
  const dataRoot = runtimeOpts.dataRoot;
  const original = await getJob(cpbRoot, project, jobId, runtimeOpts);
  if (!original?.jobId) {
    throw new Error(`job not found: ${jobId}`);
  }

  if (typeof original.status !== "string" || !["failed", "blocked", "cancelled"].includes(original.status)) {
    throw new Error(`job is not recoverable: ${original.status}`);
  }

  const retryReason = `retry from ${original.status} job ${jobId}`;
  const parentExecutor = original.executor ?? null;
  const selectedExecutor = useCurrentExecutor && currentExecutor ? currentExecutor : parentExecutor;
  const parentExecutorRef = executorRef(parentExecutor);
  const selectedExecutorRef = executorRef(selectedExecutor);
  const executorSelection = {
    mode: useCurrentExecutor ? "use-current" : "preserve-parent",
    override: !!useCurrentExecutor,
    parentRoot: parentExecutorRef.root,
    selectedRoot: selectedExecutorRef.root,
    parentReleaseId: parentExecutorRef.releaseId,
    selectedReleaseId: selectedExecutorRef.releaseId,
  };

  return createRecoveryJob(cpbRoot, project, original, {
    fromPhase,
    trigger,
    recoveryReason: retryReason,
    ts,
    executor: selectedExecutor,
    executorSelection,
    dataRoot,
  });
}

export async function verifyTerminalImmutability(cpbRoot: string, project: string, jobId: string, options: RuntimePathOptions = {}) {
  const runtimeOpts = await resolveRecoveryRuntimeOptions(cpbRoot, project, options);
  const before = await getJob(cpbRoot, project, jobId, runtimeOpts);
  if (!before?.jobId) return { immutable: false, reason: "job not found" };

  if (!TERMINAL_STATUSES.has(before.status)) {
    return { immutable: false, reason: `job is not terminal: ${before.status}` };
  }

  const after = await getJob(cpbRoot, project, jobId, runtimeOpts);
  const fields = ["status", "phase", "blockedReason", "failureCode", "failurePhase", "retryCount"];
  for (const field of fields) {
    if (before[field] !== after[field]) {
      return { immutable: false, reason: `field ${field} changed` };
    }
  }

  return { immutable: true };
}

export function getLineage(job: JobState | null | undefined) {
  if (!job?.jobId) return null;

  return {
    parentJobId: job.lineage?.parentJobId || null,
    parentStatus: job.lineage?.parentStatus || null,
    parentFailureCode: job.lineage?.parentFailureCode || null,
    parentFailurePhase: job.lineage?.parentFailurePhase || null,
    parentBlockedReason: job.lineage?.parentBlockedReason || null,
    recoveryReason: job.lineage?.recoveryReason || null,
    trigger: job.lineage?.trigger || null,
    executorSelection: job.lineage?.executorSelection || null,
  };
}
