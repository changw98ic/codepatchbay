// Merged from: job-store.ts, job-recovery.ts, jobs-index.ts

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  checkpointJob,
  materializeJob,
  readCheckpoint,
  readEvents,
  listEventFiles,
  appendEvent,
} from "../event/event-store.js";
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

// ──────────────────────────────────────────────────────────────────────────────
// jobs-index.ts (merged)
// ──────────────────────────────────────────────────────────────────────────────

const INDEX_VERSION = 1;
const LOCK_TTL_MS = 30_000;
const LOCK_RETRY_COUNT = 6_000;
const LOCK_RETRY_DELAY_MS = 10;

async function withIndexLock(lockDir, callback) {
  await mkdir(path.dirname(lockDir), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs >= LOCK_TTL_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Race: someone else removed it, retry
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
    }
  }
  if (!acquired) throw new Error(`jobs-index lock busy: ${path.basename(lockDir)}`);
  try {
    return await callback();
  } finally {
    try { await rm(lockDir, { recursive: true, force: true }); } catch {}
  }
}

const _writeQueues = new Map();

function enqueueWrite(cpbRoot, opts, fn) {
  const key = indexFilePath(cpbRoot, opts);
  const lockDir = `${key}.lock`;
  const prev = _writeQueues.get(key) || Promise.resolve();
  const next = prev.then(() => withIndexLock(lockDir, fn));
  _writeQueues.set(key, next.catch(() => {}));
  return next;
}

function _base(cpbRoot, opts) {
  if (opts?.dataRoot) return path.resolve(opts.dataRoot);
  if (opts?.legacyOnly === true) return runtimeDataRoot(cpbRoot);
  throw new Error("dataRoot is required for project jobs-index paths");
}

function indexFilePath(cpbRoot, opts = {}) {
  return path.join(_base(cpbRoot, opts), "jobs-index.json");
}

function tempIndexFilePath(cpbRoot, opts = {}) {
  const suffix = `${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}`;
  return path.join(_base(cpbRoot, opts), `jobs-index.${suffix}.tmp`);
}

function compositeKey(project, jobId) {
  return `${project}/${jobId}`;
}

export async function readJobsIndex(cpbRoot, opts = {}) {
  const indexFile = indexFilePath(cpbRoot, opts);
  try {
    const raw = await readFile(indexFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed._meta?.version !== INDEX_VERSION || typeof parsed.jobs !== "object") {
      return null;
    }
    return parsed;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    return null;
  }
}

async function writeJobsIndex(cpbRoot, index, opts = {}) {
  const target = indexFilePath(cpbRoot, opts);
  const tmp = tempIndexFilePath(cpbRoot, opts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(tmp, JSON.stringify(index) + "\n", "utf8");
  await rename(tmp, target);
}

export async function updateJobsIndexEntry(cpbRoot, project, jobId, state, opts = {}) {
  return enqueueWrite(cpbRoot, opts, async () => {
    const index = await readJobsIndex(cpbRoot, opts) || {
      _meta: { version: INDEX_VERSION, updatedAt: null, jobCount: 0 },
      jobs: {},
    };

    index.jobs[compositeKey(project, jobId)] = state;
    index._meta.updatedAt = new Date().toISOString();
    index._meta.jobCount = Object.keys(index.jobs).length;

    await writeJobsIndex(cpbRoot, index, opts);
  });
}

export async function rebuildJobsIndex(cpbRoot, opts = {}) {
  return enqueueWrite(cpbRoot, opts, async () => {
    const files = await listEventFiles(cpbRoot, opts);
    const jobs = {};

    for (const { project, jobId } of files) {
      const events = await readEvents(cpbRoot, project, jobId, opts);
      if (events.length === 0) continue;
      const state = materializeJob(events);
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
  });
}

async function mergeMissingEventStreams(cpbRoot, index, opts = {}) {
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
    const state = materializeJob(events);
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

export async function listJobsFromIndex(cpbRoot, opts = {}) {
  let index = await readJobsIndex(cpbRoot, opts);
  if (!index) {
    index = await rebuildJobsIndex(cpbRoot, opts);
  } else {
    index = await mergeMissingEventStreams(cpbRoot, index, opts);
  }

  return Object.values(index.jobs)
    .map((job) => job as Record<string, any>)
    .filter((job) => job.createdAt && job.project && job.jobId)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

// ──────────────────────────────────────────────────────────────────────────────
// job-store.ts (merged)
// ──────────────────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled"]);

async function retryUpdate(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fn();
      return;
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
}

function nowIso() {
  return new Date().toISOString();
}

async function requireNotTerminal(cpbRoot: string, project: string, jobId: string, { allowMissing = false, dataRoot }: Record<string, any> = {}) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (!job?.jobId) {
    if (allowMissing) return;
    throw new Error(`job not found: ${jobId}`);
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    throw new Error(`job is terminal: ${job.status}`);
  }
}


async function getJobAndUpdateIndex(cpbRoot: string, project: string, jobId: string, { dataRoot }: Record<string, any> = {}) {
  const state = await getJob(cpbRoot, project, jobId, { dataRoot });
  await retryUpdate(() => updateJobsIndexEntry(cpbRoot, project, jobId, state, { dataRoot }));
  return state;
}

async function extractJobExperienceBestEffort(cpbRoot: string, project: string, jobId: string, { dataRoot }: Record<string, any> = {}) {
  try {
    const { extractExperienceForJob } = await import("../event/event-source.js");
    await extractExperienceForJob(cpbRoot, project, jobId, { dataRoot } as any);
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
  }: Record<string, any>
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
    selectedWorkflow = routingSelection.workflow || selectedWorkflow;
    executorSelection = (selectAgentWithFallback as any)({
      role: "executor",
      preferredAgent: routingSelection.executor,
      fallbackAgent: fallbackAgentForRole(routingSelection, "executor"),
      agentAvailability,
      allowFallback: routingSelection.allowFallback,
      policyAllowsFallback: teamPolicy?.routing?.allowFallback !== false,
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

  const event: Record<string, any> = {
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
    event.indexSnapshotId = indexSnapshot.indexSnapshotId ?? null;
    event.sourceFingerprint = indexSnapshot.sourceFingerprint ?? null;
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
  { phase, attempt = 1, leaseId, ts = nowIso(), dataRoot, acpProfile, uiLane, uiLaneReason }: Record<string, any>
) {
  const event: Record<string, any> = {
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

async function resolveAgentForPhase(cpbRoot: string, job: any, phase: string) {
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
      const node = dag.nodes.find(n => n.id === phase || n.phase === phase);
      if (node) {
        let poolStatus = null;
        try {
          const { getManagedAcpPool } = await import("../acp/acp-pool.js");
          const pool = getManagedAcpPool({ cpbRoot, hubRoot: undefined });
          poolStatus = await pool.statusAsync().catch(() => null);
        } catch {}
        const resolved = resolveNodeAgent(node, { poolStatus });
        if (resolved) return resolved;
      }
    }
  } catch {}

  try {
    const { roleForPhase } = await import("../../../core/workflow/definition.js");
    const wf = getWorkflow(job.workflow || "standard");
    const role = roleForPhase(wf, phase) || "executor";
    const agentRegistry = await import("../../../core/agents/registry.js");
    await (agentRegistry.loadRegistry as any)().catch(() => {});
    const agent = agentRegistry.defaultAgentForRole(role);
    if (agent) return agent;
  } catch {}

  return "unknown";
}

export async function completePhase(
  cpbRoot: string,
  project: string,
  jobId: string,
  { phase, artifact = "", ts = nowIso(), dataRoot }: Record<string, any>
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
  { reason, code, kind, cause, ts = nowIso(), dataRoot }: Record<string, any>
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
  }: Record<string, any>
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

function inferRetryPhase(job) {
  const workflow = getWorkflow(job.workflow);
  if (job.failurePhase && workflow.phases.includes(job.failurePhase)) {
    return job.failurePhase;
  }
  for (const phase of workflow.phases) {
    if (!job.artifacts?.[phase]) return phase;
  }
  return workflow.phases[workflow.phases.length - 1] ?? null;
}

function terminalJobLineage(job) {
  return {
    parentJobId: job.jobId,
    parentStatus: job.status ?? null,
    parentFailureCode: job.failureCode ?? null,
    parentFailurePhase: job.failurePhase ?? null,
    parentBlockedReason: job.blockedReason ?? null,
  };
}

function truncateRecoveryText(value, maxChars = 4000) {
  const text = String(value || "");
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function recoveryPreviousOutput(job) {
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

function recoveryDagResume(job) {
  const resume = job?.dagResume;
  if (!resume || typeof resume !== "object") return null;
  return {
    failedNodeId: resume.failedNodeId ?? null,
    resumeTarget: resume.resumeTarget ? { ...resume.resumeTarget } : null,
    completedNodeIds: Array.isArray(resume.completedNodeIds) ? [...resume.completedNodeIds] : [],
  };
}

function buildRecoverySourceContext(originalJob: any, { fromPhase, trigger, recoveryReason, retryCount, maxRetries, forceFreshSession }: Record<string, any> = {}) {
  const base = originalJob?.sourceContext && typeof originalJob.sourceContext === "object"
    ? { ...originalJob.sourceContext }
    : {};
  const dagResume = recoveryDagResume(originalJob);
  const failureKind = originalJob?.failureCause?.kind || originalJob?.failureCode || "unknown";
  const failureReason = originalJob?.blockedReason || originalJob?.failureCause?.reason || recoveryReason || "recovery requested";
  const retry = {
    failureKind,
    failureReason,
    previousOutput: recoveryPreviousOutput(originalJob),
    previousJobId: originalJob?.jobId || null,
    previousPhase: fromPhase || dagResume?.resumeTarget?.phase || originalJob?.failurePhase || null,
    previousNodeId: dagResume?.failedNodeId || dagResume?.resumeTarget?.nodeId || null,
    resumeTarget: dagResume?.resumeTarget ? { ...dagResume.resumeTarget } : null,
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
      resumeTarget: retry.resumeTarget ? { ...retry.resumeTarget } : null,
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
  originalJob: any,
  { fromPhase, trigger, recoveryReason, ts, dataRoot, executor, executorSelection, retryCount, maxRetries, forceFreshSession }: Record<string, any> = {}
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

  const event: Record<string, any> = {
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
  }: Record<string, any> = {}
) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (!job?.jobId) {
    throw new Error(`job not found: ${jobId}`);
  }
  if (!["failed", "blocked", "cancelled"].includes(job.status)) {
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

  const workflow = getWorkflow(job.workflow);
  const retryPhase = fromPhase || job.dagResume?.resumeTarget?.phase || inferRetryPhase(job);
  if (!retryPhase || !workflow.phases.includes(retryPhase)) {
    throw new Error(`invalid retry phase: ${retryPhase ?? "unknown"}`);
  }

  const parentExecutor = job.executor ?? null;
  const selectedExecutor = useCurrentExecutor && currentExecutor ? currentExecutor : parentExecutor;
  const executorSelection = {
    mode: useCurrentExecutor ? "use-current" : "preserve-parent",
    override: !!useCurrentExecutor,
    parentRoot: parentExecutor?.root ?? null,
    selectedRoot: selectedExecutor?.root ?? null,
    parentReleaseId: parentExecutor?.releaseId ?? null,
    selectedReleaseId: selectedExecutor?.releaseId ?? null,
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
  { reason, ts = nowIso(), dataRoot }: Record<string, any>
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
  }: Record<string, any> = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  const event = {
    type: "pool_exhausted",
    jobId,
    project,
    reason,
    providerKey,
    agent,
    elapsedMs,
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
  { ts = nowIso(), dataRoot }: Record<string, any> = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_completed",
    jobId,
    project,
    ts,
  }, { dataRoot });

  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  const verdict = job?.verdict || job?.artifacts?.verdict || null;
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
  { worktree, branch, baseBranch = null, ts = nowIso(), dataRoot }: Record<string, any>
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "worktree_created",
    jobId,
    project,
    worktree,
    branch,
    baseBranch,
    ts,
  }, { dataRoot });
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function recordActivity(
  cpbRoot: string,
  project: string,
  jobId: string,
  { message, ts = nowIso(), dataRoot }: Record<string, any>
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
  { result, ts = nowIso(), dataRoot }: Record<string, any>
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
  { reason, ts = nowIso(), dataRoot }: Record<string, any> = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true, dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_cancel_requested",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });
  return cancelJob(cpbRoot, project, jobId, { reason, ts, dataRoot });
}

export async function cancelJob(
  cpbRoot: string,
  project: string,
  jobId: string,
  { reason, ts = nowIso(), dataRoot }: Record<string, any> = {}
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
  { instructions, reason, ts = nowIso(), dataRoot }: Record<string, any> = {}
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
  { redirectEventId, ts = nowIso(), dataRoot }: Record<string, any> = {}
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

export async function getJob(cpbRoot: string, project: string, jobId: string, { dataRoot }: Record<string, any> = {}) {
  const opts = { dataRoot };
  const checkpoint = await readCheckpoint(cpbRoot, project, jobId, opts);
  if (checkpoint) return checkpoint;
  return materializeJob(await readEvents(cpbRoot, project, jobId, opts));
}

export async function listJobs(cpbRoot: string, options: Record<string, any> = {}) {
  const { dataRoot, legacyOnly, ...rest } = options;
  if (!dataRoot && legacyOnly !== true) {
    const jobs = await listJobsAcrossRuntimeRoots(cpbRoot, rest);
    return rest.project ? jobs.filter((job) => job.project === rest.project) : jobs;
  }
  const jobs: any[] = await listJobsFromIndex(cpbRoot, { ...rest, dataRoot, legacyOnly });
  return rest.project ? jobs.filter((job) => job.project === rest.project) : jobs;
}

export async function getJobByQueueEntryId(cpbRoot: string, project: string, queueEntryId: string, { dataRoot }: Record<string, any> = {}) {
  if (!queueEntryId) return null;
  const jobs = await listJobs(cpbRoot, { project, dataRoot });
  return jobs.find((job) => job.queueEntryId === queueEntryId) || null;
}

export async function listJobsAcrossRuntimeRoots(cpbRoot: string, options: Record<string, any> = {}) {
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

export function isTerminal(job) {
  return !job?.jobId || TERMINAL_STATUSES.has(job.status);
}

export function isRecoverable(job) {
  if (!isTerminal(job)) return false;
  if (job.status === "completed") return false;
  return ["failed", "blocked", "cancelled"].includes(job.status);
}

async function resolveRecoveryRuntimeOptions(cpbRoot, project, options: Record<string, any> = {}) {
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

export async function recoverAsNewJob(cpbRoot, project, jobId, options: Record<string, any> = {}) {
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
  const executorSelection = {
    mode: useCurrentExecutor ? "use-current" : "preserve-parent",
    override: !!useCurrentExecutor,
    parentRoot: parentExecutor?.root ?? null,
    selectedRoot: selectedExecutor?.root ?? null,
    parentReleaseId: parentExecutor?.releaseId ?? null,
    selectedReleaseId: selectedExecutor?.releaseId ?? null,
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

export async function retryAsNewJob(cpbRoot, project, jobId, options: Record<string, any> = {}) {
  const { ts, fromPhase, trigger = "manual", useCurrentExecutor = false, currentExecutor = null } = options;
  const runtimeOpts = await resolveRecoveryRuntimeOptions(cpbRoot, project, options);
  const dataRoot = runtimeOpts.dataRoot;
  const original = await getJob(cpbRoot, project, jobId, runtimeOpts);
  if (!original?.jobId) {
    throw new Error(`job not found: ${jobId}`);
  }

  if (!["failed", "blocked", "cancelled"].includes(original.status)) {
    throw new Error(`job is not recoverable: ${original.status}`);
  }

  const retryReason = `retry from ${original.status} job ${jobId}`;
  const parentExecutor = original.executor ?? null;
  const selectedExecutor = useCurrentExecutor && currentExecutor ? currentExecutor : parentExecutor;
  const executorSelection = {
    mode: useCurrentExecutor ? "use-current" : "preserve-parent",
    override: !!useCurrentExecutor,
    parentRoot: parentExecutor?.root ?? null,
    selectedRoot: selectedExecutor?.root ?? null,
    parentReleaseId: parentExecutor?.releaseId ?? null,
    selectedReleaseId: selectedExecutor?.releaseId ?? null,
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

export async function verifyTerminalImmutability(cpbRoot, project, jobId, options: Record<string, any> = {}) {
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

export function getLineage(job) {
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
