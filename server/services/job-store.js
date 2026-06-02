import { randomBytes } from "node:crypto";
import {
  checkpointJob,
  materializeJob,
  readCheckpoint,
  readEvents,
} from "./event-store.js";
import { getWorkflow, isWorkflowName } from "../../core/workflow/definition.js";
import { appendEvent } from "./event-store.js";
import { listJobsFromIndex, updateJobsIndexEntry } from "./jobs-index.js";
import { recordPerformance } from "./performance-tracker.js";
import { recordQualityScore } from "./performance-tracker.js";
import {
  assertValidRoutingRules,
  fallbackAgentForRole,
  resolveEffectiveRouting,
  selectAgentWithFallback,
} from "../../core/agents/routing.js";
import { validatePolicy } from "../../core/policy/team-policy.js";

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

async function requireNotTerminal(cpbRoot, project, jobId, { allowMissing = false, dataRoot } = {}) {
  const job = await getJob(cpbRoot, project, jobId, { dataRoot });
  if (!job?.jobId) {
    if (allowMissing) return;
    throw new Error(`job not found: ${jobId}`);
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    throw new Error(`job is terminal: ${job.status}`);
  }
}


async function getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot } = {}) {
  const state = await getJob(cpbRoot, project, jobId, { dataRoot });
  await retryUpdate(() => updateJobsIndexEntry(cpbRoot, project, jobId, state, { dataRoot }));
  return state;
}

async function extractJobExperienceBestEffort(cpbRoot, project, jobId, { dataRoot } = {}) {
  try {
    const { extractExperienceForJob } = await import("./experience-extractor.js");
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
  cpbRoot,
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
    selectedWorkflow = routingSelection.workflow || selectedWorkflow;
    executorSelection = selectAgentWithFallback({
      role: "executor",
      preferredAgent: routingSelection.executor,
      fallbackAgent: fallbackAgentForRole(routingSelection, "executor"),
      agentAvailability,
      allowFallback: routingSelection.allowFallback,
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

  const event = {
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
  cpbRoot,
  project,
  jobId,
  { phase, attempt = 1, leaseId, ts = nowIso(), dataRoot, acpProfile, uiLane, uiLaneReason }
) {
  const event = {
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

async function resolveAgentForPhase(cpbRoot, job, phase) {
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
    const { normalizeWorkflow, resolveNodeAgent } = await import("../../core/workflow/definition.js");
    const dag = normalizeWorkflow(job.workflow || "standard");
    if (dag && dag.nodes) {
      const node = dag.nodes.find(n => n.id === phase || n.phase === phase);
      if (node) {
        let poolStatus = null;
        try {
          const { getManagedAcpPool } = await import("./acp-pool.js");
          const pool = getManagedAcpPool({ cpbRoot, hubRoot: undefined });
          poolStatus = await pool.statusAsync().catch(() => null);
        } catch {}
        const resolved = resolveNodeAgent(node, { poolStatus });
        if (resolved) return resolved;
      }
    }
  } catch {}

  try {
    const { roleForPhase } = await import("../../core/workflow/definition.js");
    const wf = getWorkflow(job.workflow || "standard");
    const role = roleForPhase(wf, phase) || "executor";
    const agentRegistry = await import("../../core/agents/registry.js");
    await agentRegistry.loadRegistry().catch(() => {});
    const agent = agentRegistry.defaultAgentForRole(role);
    if (agent) return agent;
  } catch {}

  return "unknown";
}

export async function completePhase(
  cpbRoot,
  project,
  jobId,
  { phase, artifact = "", ts = nowIso(), dataRoot }
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
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso(), dataRoot }
) {
  await requireNotTerminal(cpbRoot, project, jobId, { allowMissing: true, dataRoot });
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_blocked",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });
  await checkpointJob(cpbRoot, project, jobId, { dataRoot }).catch(() => {});
  return getJobAndUpdateIndex(cpbRoot, project, jobId, { dataRoot });
}

export async function failJob(
  cpbRoot,
  project,
  jobId,
  {
    reason,
    code = FAILURE_CODES.FATAL,
    phase,
    retryable,
    retryCount,
    cause,
    ts = nowIso(),
    dataRoot,
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

function buildRecoverySourceContext(originalJob, { fromPhase, trigger, recoveryReason, retryCount, maxRetries } = {}) {
  const base = originalJob?.sourceContext && typeof originalJob.sourceContext === "object"
    ? { ...originalJob.sourceContext }
    : {};
  const failureKind = originalJob?.failureCause?.kind || originalJob?.failureCode || "unknown";
  const failureReason = originalJob?.blockedReason || originalJob?.failureCause?.reason || recoveryReason || "recovery requested";
  const correction = {
    failureKind,
    failureReason,
    previousOutput: recoveryPreviousOutput(originalJob),
    previousJobId: originalJob?.jobId || null,
    previousPhase: fromPhase || originalJob?.failurePhase || null,
    previousQueueEntryId: originalJob?.queueEntryId || base.queueEntryId || null,
    retryCount: retryCount ?? originalJob?.retryCount ?? null,
    maxRetries: maxRetries ?? originalJob?.maxRetries ?? null,
    trigger: trigger || "manual",
    artifacts: originalJob?.artifacts || {},
  };
  return {
    ...base,
    correction,
    previousFailure: {
      kind: failureKind,
      reason: failureReason,
      jobId: originalJob?.jobId || null,
      phase: correction.previousPhase,
      retryCount: correction.retryCount,
      maxRetries: correction.maxRetries,
    },
  };
}

export async function createRecoveryJob(
  cpbRoot,
  project,
  originalJob,
  { fromPhase, trigger, recoveryReason, ts, dataRoot, executor, executorSelection, retryCount, maxRetries } = {}
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

  const event = {
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
  cpbRoot,
  project,
  jobId,
  {
    fromPhase,
    force = false,
    trigger = "manual",
    maxRetries,
    ts = nowIso(),
    dataRoot,
    useCurrentExecutor = false,
    currentExecutor = null,
  } = {}
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
  const retryPhase = fromPhase || inferRetryPhase(job);
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
  });
}

export async function budgetExceeded(
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso(), dataRoot }
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
  cpbRoot,
  project,
  jobId,
  {
    reason,
    providerKey,
    agent,
    elapsedMs,
    phase,
    ts = nowIso(),
    dataRoot,
  } = {}
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
  cpbRoot,
  project,
  jobId,
  { ts = nowIso(), dataRoot } = {}
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
  cpbRoot,
  project,
  jobId,
  { worktree, branch, baseBranch = null, ts = nowIso(), dataRoot }
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
  cpbRoot,
  project,
  jobId,
  { message, ts = nowIso(), dataRoot }
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
  cpbRoot,
  project,
  jobId,
  { result, ts = nowIso(), dataRoot }
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
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso(), dataRoot } = {}
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
  cpbRoot,
  project,
  jobId,
  { reason, ts = nowIso(), dataRoot } = {}
) {
  await requireNotTerminal(cpbRoot, project, jobId, { dataRoot });
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
  cpbRoot,
  project,
  jobId,
  { instructions, reason, ts = nowIso(), dataRoot } = {}
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
  cpbRoot,
  project,
  jobId,
  { redirectEventId, ts = nowIso(), dataRoot } = {}
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

export async function getJob(cpbRoot, project, jobId, { dataRoot } = {}) {
  const opts = { dataRoot };
  const checkpoint = await readCheckpoint(cpbRoot, project, jobId, opts);
  if (checkpoint) return checkpoint;
  return materializeJob(await readEvents(cpbRoot, project, jobId, opts));
}

export async function listJobs(cpbRoot, options = {}) {
  const { dataRoot, ...rest } = options;
  const jobs = await listJobsFromIndex(cpbRoot, { dataRoot });
  return rest.project ? jobs.filter((job) => job.project === rest.project) : jobs;
}

export async function listJobsAcrossRuntimeRoots(cpbRoot, options = {}) {
  const { listRuntimeDataRoots } = await import("./runtime-context.js");
  const roots = await listRuntimeDataRoots(cpbRoot, options);
  const seen = new Set();
  const jobs = [];
  for (const root of roots) {
    const batch = await listJobs(cpbRoot, { dataRoot: root.kind === "legacy" ? undefined : root.dataRoot });
    for (const job of batch) {
      const key = `${job.project}/${job.jobId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
  }
  return jobs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
