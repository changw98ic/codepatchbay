import { appendFile, mkdir, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeDataRoot, runtimeDataPath } from "./runtime-root.js";
import {
  isSecretArtifact,
  isSecretContent,
  isSecretPath,
  makeSecretBlockedEvent,
  redactSecrets,
} from "./secret-policy.js";

const EVENT_LOCK_TTL_MS = 30_000;

async function withEventLock(eventFile, callback) {
  const lockDir = `${eventFile}.lock`;
  await mkdir(path.dirname(lockDir), { recursive: true });
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs >= EVENT_LOCK_TTL_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Race: someone else removed it, retry
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  if (!acquired) throw new Error(`event log lock busy: ${path.basename(eventFile)}`);
  try {
    return await callback();
  } finally {
    try { await rm(lockDir, { recursive: true, force: true }); } catch {}
  }
}

export const JOBS_EVENTS_FORMAT_VERSION = 1;

function _base(cpbRoot, opts) {
  return opts?.dataRoot || process.env.CPB_PROJECT_RUNTIME_ROOT || runtimeDataRoot(cpbRoot);
}

function validatePathComponent(name, value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value)
  ) {
    throw new Error(`invalid ${name}`);
  }
}

function serializeEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new Error("invalid event: expected a non-null object");
  }

  let serialized;
  try {
    serialized = JSON.stringify(event);
  } catch (err) {
    throw new Error(`invalid event: ${err.message}`);
  }

  if (typeof serialized !== "string") {
    throw new Error("invalid event: must serialize to JSON");
  }

  return serialized;
}

function malformedEventError(file, lineNumber, reason) {
  return new Error(`${file} at line ${lineNumber}: malformed event: ${reason}`);
}

async function truncateCorruptJsonlTail(file, raw) {
  const lastNewline = raw.lastIndexOf("\n");
  const validPrefix = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : "";
  await truncate(file, Buffer.byteLength(validPrefix, "utf8"));
}

export function eventFileFor(cpbRoot, project, jobId, opts = {}) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);

  const eventsRoot = path.join(_base(cpbRoot, opts), "events");
  const file = path.resolve(eventsRoot, project, `${jobId}.jsonl`);
  const relative = path.relative(eventsRoot, file);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("event file resolves outside events root");
  }

  return file;
}

async function _scanEventsDir(eventsRoot) {
  let projectEntries;
  try {
    projectEntries = await readdir(eventsRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const files = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) continue;
    const project = projectEntry.name;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(project)) continue;

    let jobEntries;
    try {
      jobEntries = await readdir(path.join(eventsRoot, project), { withFileTypes: true });
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }

    for (const jobEntry of jobEntries) {
      if (!jobEntry.isFile() || !jobEntry.name.endsWith(".jsonl")) continue;
      const jobId = jobEntry.name.slice(0, -".jsonl".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(jobId)) continue;
      files.push({ project, jobId, file: path.join(eventsRoot, project, jobEntry.name) });
    }
  }
  return files;
}

export async function listEventFiles(cpbRoot, opts = {}) {
  const rtRoot = opts.dataRoot ? path.join(opts.dataRoot, "events") : null;
  const legacyRoot = runtimeDataPath(cpbRoot, "events");

  const seen = new Set();
  const allFiles = [];

  if (rtRoot && rtRoot !== legacyRoot) {
    for (const f of await _scanEventsDir(rtRoot)) {
      const key = `${f.project}/${f.jobId}`;
      if (!seen.has(key)) { seen.add(key); allFiles.push(f); }
    }
  }
  for (const f of await _scanEventsDir(legacyRoot)) {
    const key = `${f.project}/${f.jobId}`;
    if (!seen.has(key)) { seen.add(key); allFiles.push(f); }
  }

  return allFiles.sort((a, b) => a.file.localeCompare(b.file));
}

export async function recoverEventFile(cpbRoot, project, jobId, opts = {}) {
  const file = eventFileFor(cpbRoot, project, jobId, opts);
  try {
    const raw = await readFile(file, "utf8");
    if (raw.endsWith("\n") || raw.length === 0) {
      return { recovered: false, removedBytes: 0 };
    }

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      await writeFile(file, "", "utf8");
      return { recovered: true, removedBytes: Buffer.byteLength(raw) };
    }

    const lastLine = lines[lines.length - 1];
    try {
      JSON.parse(lastLine);
      await writeFile(file, raw + "\n", "utf8");
      return { recovered: true, removedBytes: 0, addedNewline: true };
    } catch {
      const lastNewline = raw.lastIndexOf("\n");
      const trimmed = lastNewline === -1 ? "" : raw.substring(0, lastNewline + 1);
      const removedBytes = Buffer.byteLength(raw) - Buffer.byteLength(trimmed);
      await writeFile(file, trimmed, "utf8");
      return { recovered: true, removedBytes };
    }
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { recovered: false, removedBytes: 0 };
    }
    throw err;
  }
}

export async function appendEvent(cpbRoot, project, jobId, event, opts = {}) {
  // Validate event structure first (throws on invalid input)
  serializeEvent(event);

  const file = eventFileFor(cpbRoot, project, jobId, opts);

  return withEventLock(file, async () => {
    // Terminal seal: reject business-state mutations on terminal job event logs.
    const existing = await readEvents(cpbRoot, project, jobId, opts);
    if (existing.length > 0) {
      const state = materializeJob(existing);
      if (TERMINAL_STATUSES.has(state.status) && !POST_TERMINAL_ALLOWED.has(event.type)) {
        console.warn(`[event-store] skipped ${event.type} on terminal job ${jobId} (status: ${state.status})`);
        return null;
      }
    }

    const writeBlocked = async (artifactName, reason) => {
      const blocked = makeSecretBlockedEvent(artifactName, reason);
      blocked.jobId = event.jobId || jobId;
      blocked.project = event.project || project;
      const serialized = serializeEvent(blocked);
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${serialized}\n`, "utf8");
      return blocked;
    };

    // Block secret-like artifacts before persisting
    if (event.artifact && isSecretPath(event.artifact)) {
      return writeBlocked(event.artifact, "secret-like artifact path blocked");
    }

    // Block events with secret-like content in artifact fields
    if (event.artifact && typeof event.artifact === "string" && isSecretArtifact(event.artifact, event.artifact)) {
      return writeBlocked(event.artifact, "secret-like artifact content blocked");
    }

    if (event.artifact && typeof event.artifact === "string") {
      const artifactPayload = [
        event.content,
        event.output,
        event.stdout,
        event.stderr,
        event.body,
      ].filter((value) => value !== undefined && value !== null);
      if (artifactPayload.some((value) => isSecretContent(typeof value === "string" ? value : JSON.stringify(value)))) {
        return writeBlocked(event.artifact, "secret-like artifact content blocked");
      }
    }

    // Redact secrets from event payload before persisting
    const redacted = redactSecrets(event);
    const serialized = JSON.stringify(redacted);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${serialized}\n`, "utf8");
    return redacted;
  });
}

async function _parseEventFileReadOnly(file) {
  try {
    const raw = await readFile(file, "utf8");
    const lines = raw
      .split("\n")
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter(({ line }) => line.trim().length > 0);

    const events = [];
    for (const { line, lineNumber } of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        throw new Error(`malformed event JSON in ${file} at line ${lineNumber}: ${err.message}`);
      }
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        throw malformedEventError(file, lineNumber, "expected a non-null object");
      }
      events.push(event);
    }
    return events;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function _parseEventFile(file) {
  try {
    return await _parseEventFileReadOnly(file);
  } catch (err) {
    if (err && err.message && err.message.includes("malformed event JSON")) {
      const raw = await readFile(file, "utf8");
      if (!raw.endsWith("\n")) {
        await truncateCorruptJsonlTail(file, raw);
        return await _parseEventFileReadOnly(file);
      }
    }
    throw err;
  }
}

export async function readEvents(cpbRoot, project, jobId, opts = {}) {
  // Try runtime root first when dataRoot is provided and differs from legacy
  if (opts.dataRoot && opts.dataRoot !== runtimeDataRoot(cpbRoot)) {
    const rtFile = eventFileFor(cpbRoot, project, jobId, opts);
    const rtEvents = await _parseEventFile(rtFile);
    if (rtEvents !== null) return rtEvents;
  }

  // Legacy path
  const file = eventFileFor(cpbRoot, project, jobId);
  const result = await _parseEventFile(file);
  return result ?? [];
}

export async function readEventsReadOnly(cpbRoot, project, jobId, opts = {}) {
  if (opts.dataRoot && opts.dataRoot !== runtimeDataRoot(cpbRoot)) {
    const rtFile = eventFileFor(cpbRoot, project, jobId, opts);
    const rtEvents = await _parseEventFileReadOnly(rtFile);
    if (rtEvents !== null) return rtEvents;
  }
  const file = eventFileFor(cpbRoot, project, jobId);
  const result = await _parseEventFileReadOnly(file);
  return result ?? [];
}

const POST_TERMINAL_ALLOWED = new Set([
  "job_redirect_consumed", "phase_activity",
  "permission_denied",
  "external_remediation_started", "external_remediation_completed", "external_remediation_failed",
  "process_stop_skipped", "process_marked_orphan", "process_stop_requested", "process_stopped",
  "finalizer_result",
  "phase_hook_started", "phase_hook_completed", "phase_hook_failed", "phase_hook_diagnostic",
  "merge_index_status",
  "finalizer_route_guard",
  "review_bundle_created",
  "parallel_finalize_conflict",
  "pr_opened",
  "github_comment_posted", "github_comment_failed",
  "slack_message_posted", "slack_message_failed",
  "dag_node_started", "dag_node_completed", "dag_node_failed", "dag_node_blocked",
  "dag_node_retrying", "dag_node_skipped", "dag_node_cancelled",
  "approval_required", "job_approved", "approval_timed_out",
  "job_superseded",
  "review_bundle_accepted", "review_bundle_rejected",
  "completion_gate_evaluated",
]);

const NODE_STATE_DEFAULTS = {
  status: "pending",
  phase: null,
  attempt: null,
  artifact: null,
  reason: null,
  error: null,
  startedAt: null,
  completedAt: null,
  failedAt: null,
  retryingAt: null,
  skippedAt: null,
  cancelledAt: null,
  blockedAt: null,
  durationMs: null,
};

function _updateNodeState(state, nodeId, updates) {
  if (!nodeId) return;
  const prev = state.nodeStates[nodeId] || { ...NODE_STATE_DEFAULTS };
  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  );
  const next = { ...prev, ...definedUpdates };
  const terminalTs = definedUpdates.completedAt || definedUpdates.failedAt || definedUpdates.cancelledAt;
  if (terminalTs && prev.startedAt) {
    const ms = new Date(terminalTs).getTime() - new Date(prev.startedAt).getTime();
    next.durationMs = Number.isFinite(ms) ? ms : null;
  }
  state.nodeStates = { ...state.nodeStates, [nodeId]: next };
}

export function materializeJob(events) {
  const state = {
    jobId: null,
    project: null,
    task: null,
    status: null,
    phase: null,
    attempt: null,
    workflow: null,
    planMode: null,
    planDecision: null,
    executor: null,
    artifacts: {},
    completedPhases: [],
    completedNodes: [],
    runningNodes: [],
    blockedNodes: [],
    nodeStates: {},
    leaseId: null,
    worktree: null,
    worktreeBranch: null,
    worktreeBaseBranch: null,
    createdAt: null,
    updatedAt: null,
    blockedReason: null,
    failureCode: null,
    failurePhase: null,
    retryable: false,
    retryCount: 0,
    maxRetries: null,
    failureCause: null,
    cancelRequested: false,
    cancelReason: null,
    redirectContext: null,
    redirectReason: null,
    redirectEventId: null,
    consumedRedirectIds: [],
    lastActivityAt: null,
    lastActivityMessage: null,
    externalRemediationStatus: null,
    externalRemediationArtifact: null,
    externalRemediationAt: null,
    externalRemediationError: null,
    externalRepair: null,
    lineage: null,
    recoveryOf: null,
    sourceContext: null,
    queueEntryId: null,
    pr: null,
    permissionDenials: [],
    infraStatus: null,
    finalizer: null,
    mergeIndexStatus: null,
    mergeIndexBranch: null,
    mergeIndexGitHead: null,
    mergeIndexedFrom: null,
    indexSnapshotId: null,
    sourceFingerprint: null,
    indexFreshness: null,
    planCache: null,
    workflowDag: null,
    dynamicAgentPlan: null,
    adversarialVerdict: null,
    riskMap: null,
    riskLevel: null,
    riskMapGeneratedAt: null,
    verificationDepth: null,
    adversarialRequired: false,
    routingFeedback: null,
    phaseAgentSelections: [],
    approval: null,
    reviewLoop: {
      rounds: [],
      latest: null,
    },
    completionGate: null,
  };

  const ctx = { terminal: false };

  for (const event of events) {
    const isPostTerminal = ctx.terminal;
    if (isPostTerminal && !POST_TERMINAL_ALLOWED.has(event.type)) continue;

    if (event.jobId !== undefined) state.jobId = event.jobId;
    if (event.project !== undefined) state.project = event.project;
    if (!isPostTerminal && event.attempt !== undefined) state.attempt = event.attempt;
    if (!isPostTerminal && event.workflow !== undefined) state.workflow = event.workflow;
    if (!isPostTerminal && event.planMode !== undefined) state.planMode = event.planMode;
    if (event.ts !== undefined) state.updatedAt = event.ts;

    EVENT_HANDLERS[event.type]?.(state, event, ctx);
  }

  return state;
}

// ── Event handler lookup table ────────────────────────────
// Each handler mutates state in-place. ctx.terminal controls the post-terminal gate.
// Shared handlers use the same function reference for multiple event types.

const _handlePlanCache = (state, event) => {
  state.planCache = { ...(state.planCache || {}), ...event };
};

const _handleReviewBundle = (state, event) => {
  const round = {
    round: event.round ?? state.reviewLoop.rounds.length + 1,
    verdict: event.verdict ?? (event.type === "review_bundle_accepted" ? "accepted" : "rejected"),
    feedback: event.feedback ?? null,
    retryQueueEntryId: event.retryQueueEntryId ?? null,
    bundleId: event.bundleId ?? null,
    actor: event.actor ?? null,
    createdAt: event.ts ?? null,
  };
  state.reviewLoop = { rounds: [...state.reviewLoop.rounds, round], latest: round };
};

const EVENT_HANDLERS = {
  job_created(state, event, ctx) {
    state.task = event.task ?? state.task;
    state.executor = event.executor ?? state.executor;
    state.executorSelection = event.executorSelection ?? state.executorSelection;
    state.status = "running";
    state.createdAt = event.ts ?? state.createdAt;
    state.blockedReason = null;
    state.queueEntryId = event.queueEntryId ?? state.queueEntryId;
    if (event.sourceContext) state.sourceContext = event.sourceContext;
    if (event.indexSnapshotId !== undefined) state.indexSnapshotId = event.indexSnapshotId;
    if (event.sourceFingerprint !== undefined) state.sourceFingerprint = event.sourceFingerprint;
    if (event.indexFreshness !== undefined) state.indexFreshness = event.indexFreshness;
    if (event.planCache !== undefined) state.planCache = event.planCache;
    ctx.terminal = false;
  },
  plan_decision(state, event) {
    state.planMode = event.planMode ?? state.planMode;
    state.planDecision = {
      workflow: event.workflow ?? state.workflow,
      planMode: event.planMode ?? null,
      runPlan: event.runPlan ?? null,
      reason: event.reason ?? null,
      decidedAt: event.ts ?? null,
      parentPlanCache: event.parentPlanCache ?? null,
    };
  },
  plan_cache_decision: _handlePlanCache,
  plan_cache_updated: _handlePlanCache,
  riskmap_generated(state, event) {
    state.riskMap = event.riskMap ?? {
      riskLevel: event.riskLevel ?? null, domains: event.domains ?? [],
      highRiskFiles: event.highRiskFiles ?? [], verificationDepth: event.verificationDepth ?? null,
      adversarialRequired: Boolean(event.adversarialRequired), adversarialFocus: event.adversarialFocus ?? [],
      confidence: event.confidence ?? null,
    };
    state.riskLevel = event.riskLevel ?? state.riskMap?.riskLevel ?? null;
    state.verificationDepth = event.verificationDepth ?? state.riskMap?.verificationDepth ?? null;
    state.adversarialRequired = event.adversarialRequired ?? state.riskMap?.adversarialRequired ?? false;
    state.riskMapGeneratedAt = event.ts ?? state.riskMap?.generatedAt ?? state.riskMapGeneratedAt;
  },
  workflow_dag_materialized(state, event) {
    state.workflow = event.workflow ?? state.workflow;
    state.planMode = event.planMode ?? state.planMode;
    state.workflowDag = event.workflowDag ?? { name: event.workflow ?? state.workflow, nodes: event.nodes ?? [], edges: event.edges ?? [] };
    {
      const nodeIds = new Set((Array.isArray(state.workflowDag?.nodes) ? state.workflowDag.nodes : []).map((n) => n?.id).filter(Boolean));
      state.completedNodes = state.completedNodes.filter((id) => nodeIds.has(id));
      state.runningNodes = state.runningNodes.filter((id) => nodeIds.has(id));
      state.blockedNodes = state.blockedNodes.filter((id) => nodeIds.has(id));
    }
    for (const node of Array.isArray(state.workflowDag?.nodes) ? state.workflowDag.nodes : []) {
      if (node?.id && !state.nodeStates[node.id]) _updateNodeState(state, node.id, { status: "pending", phase: node.phase ?? node.id });
    }
  },
  dynamic_agent_plan_generated(state, event) {
    state.dynamicAgentPlan = event.dynamicAgentPlan ?? state.dynamicAgentPlan;
    state.riskLevel = event.riskLevel ?? state.dynamicAgentPlan?.riskLevel ?? state.riskLevel;
    state.adversarialRequired = event.adversarialRequired ?? state.dynamicAgentPlan?.adversarialRequired ?? state.adversarialRequired;
  },
  adversarial_verdict(state, event) {
    state.adversarialVerdict = { verdict: event.verdict ?? null, artifact: event.artifact ?? null, status: event.status ?? event.verdict?.status ?? null, reason: event.reason ?? event.verdict?.reason ?? null, at: event.ts ?? null };
  },
  executor_routing_feedback(state, event) {
    state.routingFeedback = { phase: event.phase ?? null, requested: event.requested ?? null, reason: event.reason ?? null, confidence: event.confidence ?? null, signals: event.signals ?? [], upgradedQueueEntryId: event.upgradedQueueEntryId ?? null, feedbackPath: event.feedbackPath ?? null, at: event.ts ?? null };
  },
  agent_routing_decision(state, event) {
    const selection = event.executorSelection ?? { role: event.role ?? null, category: event.category ?? null, workflow: event.workflow ?? null, preferredAgent: event.preferredAgent ?? null, selectedAgent: event.selectedAgent ?? null, fallbackAgent: event.fallbackAgent ?? null, fallbackAllowed: event.fallbackAllowed ?? null, fallbackApplied: event.fallbackApplied ?? null, reason: event.reason ?? null };
    if (event.phase) { state.phaseAgentSelections = [...state.phaseAgentSelections, { phase: event.phase, ...selection, ts: event.ts ?? null }]; return; }
    state.executorSelection = selection;
    if (event.selectedAgent !== undefined) state.executor = event.selectedAgent;
  },
  worktree_created(state, event) {
    state.worktree = event.worktree ?? event.path ?? state.worktree;
    state.worktreeBranch = event.branch ?? event.worktreeBranch ?? state.worktreeBranch;
    state.worktreeBaseBranch = event.baseBranch ?? event.worktreeBaseBranch ?? state.worktreeBaseBranch;
  },
  phase_started(state, event) {
    state.phase = event.phase ?? state.phase;
    state.leaseId = event.leaseId ?? null;
    state.status = "running";
    state.blockedReason = null;
    if (event.phase && !state.runningNodes.includes(event.phase)) state.runningNodes = [...state.runningNodes, event.phase];
  },
  phase_completed(state, event) {
    state.phase = event.phase ?? state.phase;
    state.leaseId = null;
    state.status = "running";
    if (event.phase !== undefined) {
      state.runningNodes = state.runningNodes.filter((n) => n !== event.phase);
      if (!state.completedPhases.includes(event.phase)) state.completedPhases = [...state.completedPhases, event.phase];
      if (!state.completedNodes.includes(event.phase)) state.completedNodes = [...state.completedNodes, event.phase];
    }
    if (event.phase !== undefined && event.artifact !== undefined) state.artifacts[event.phase] = event.artifact;
  },
  dag_node_started(state, event) {
    if (event.nodeId && !state.runningNodes.includes(event.nodeId)) state.runningNodes = [...state.runningNodes, event.nodeId];
    state.blockedNodes = state.blockedNodes.filter((n) => n !== event.nodeId);
    _updateNodeState(state, event.nodeId, { status: "running", phase: event.phase, attempt: event.attempt, startedAt: event.ts, completedAt: null, failedAt: null, skippedAt: null, cancelledAt: null, blockedAt: null, durationMs: null });
  },
  dag_node_completed(state, event) {
    state.runningNodes = state.runningNodes.filter((n) => n !== event.nodeId);
    if (event.nodeId && !state.completedNodes.includes(event.nodeId)) state.completedNodes = [...state.completedNodes, event.nodeId];
    if (event.phase !== undefined && event.artifact !== undefined) state.artifacts[event.phase] = event.artifact;
    if (event.phase !== undefined && !state.completedPhases.includes(event.phase)) state.completedPhases = [...state.completedPhases, event.phase];
    _updateNodeState(state, event.nodeId, { status: "completed", phase: event.phase, artifact: event.artifact, completedAt: event.ts });
  },
  dag_node_failed(state, event) {
    state.runningNodes = state.runningNodes.filter((n) => n !== event.nodeId);
    state.failureCode = event.code ?? state.failureCode;
    state.failurePhase = event.phase ?? state.failurePhase;
    _updateNodeState(state, event.nodeId, { status: "failed", phase: event.phase, error: event.error ?? event.reason, reason: event.reason, failedAt: event.ts });
  },
  dag_node_blocked(state, event) {
    state.runningNodes = state.runningNodes.filter((n) => n !== event.nodeId);
    if (event.nodeId && !state.blockedNodes.includes(event.nodeId)) state.blockedNodes = [...state.blockedNodes, event.nodeId];
    _updateNodeState(state, event.nodeId, { status: "blocked", reason: event.reason, blockedAt: event.ts });
  },
  dag_node_retrying(state, event) {
    if (event.nodeId) { state.runningNodes = state.runningNodes.filter((n) => n !== event.nodeId); state.blockedNodes = state.blockedNodes.filter((n) => n !== event.nodeId); state.completedNodes = state.completedNodes.filter((n) => n !== event.nodeId); }
    if (event.phase !== undefined) state.completedPhases = state.completedPhases.filter((p) => p !== event.phase);
    _updateNodeState(state, event.nodeId, { status: "retrying", phase: event.phase, attempt: event.attempt, artifact: null, reason: event.reason, retryingAt: event.ts, completedAt: null, failedAt: null, skippedAt: null, cancelledAt: null, blockedAt: null, durationMs: null });
  },
  dag_node_skipped(state, event) {
    if (event.nodeId) state.runningNodes = state.runningNodes.filter((n) => n !== event.nodeId);
    _updateNodeState(state, event.nodeId, { status: "skipped", phase: event.phase, reason: event.reason, skippedAt: event.ts });
  },
  dag_node_cancelled(state, event) {
    if (event.nodeId) state.runningNodes = state.runningNodes.filter((n) => n !== event.nodeId);
    _updateNodeState(state, event.nodeId, { status: "cancelled", phase: event.phase, reason: event.reason, cancelledAt: event.ts });
  },
  phase_failed(state, event, ctx) {
    state.phase = event.phase ?? state.phase;
    state.leaseId = null;
    state.status = "failed";
    state.blockedReason = event.error ?? event.reason ?? null;
    state.failureCode = event.code ?? state.failureCode;
    state.failurePhase = event.phase ?? state.failurePhase;
    state.retryable = event.retryable ?? state.retryable;
    state.retryCount = event.retryCount ?? state.retryCount;
    state.maxRetries = event.maxRetries ?? state.maxRetries;
    state.failureCause = event.cause ?? state.failureCause;
    if (event.phase !== undefined) state.runningNodes = state.runningNodes.filter((n) => n !== event.phase);
    ctx.terminal = true;
  },
  budget_exceeded(state, event, ctx) {
    state.status = "blocked";
    state.leaseId = null;
    state.blockedReason = event.reason ?? "budget exceeded";
    ctx.terminal = true;
  },
  job_blocked(state, event, ctx) {
    state.status = "blocked";
    state.leaseId = null;
    state.blockedReason = event.reason ?? event.blockedReason ?? null;
    state.failureCode = event.code ?? event.kind ?? state.failureCode;
    state.failureCause = event.cause ?? state.failureCause;
    ctx.terminal = true;
  },
  job_failed(state, event, ctx) {
    state.status = "failed";
    state.leaseId = null;
    state.blockedReason = event.reason ?? event.error ?? state.blockedReason;
    state.failureCode = event.code ?? state.failureCode;
    state.failurePhase = event.phase ?? state.failurePhase;
    state.retryable = event.retryable ?? state.retryable;
    state.retryCount = event.retryCount ?? state.retryCount;
    state.maxRetries = event.maxRetries ?? state.maxRetries;
    state.failureCause = event.cause ?? state.failureCause;
    ctx.terminal = true;
  },
  pool_exhausted(state, event, ctx) {
    state.status = "failed";
    state.leaseId = null;
    state.blockedReason = event.reason ?? "ACP pool exhausted";
    state.failureCode = "pool_exhausted";
    state.failurePhase = event.phase ?? state.phase;
    state.retryable = true;
    ctx.terminal = true;
  },
  job_superseded(state, event, ctx) {
    state.status = "superseded";
    state.blockedReason = event.reason ?? "superseded by remediation lineage";
    ctx.terminal = true;
  },
  approval_required(state, event) {
    state.status = "waiting.approval";
    state.phase = event.phase ?? state.phase;
    state.blockedReason = event.reason ?? "approval required";
    state.approval = { operation: event.operation ?? null, phase: event.phase ?? null, channels: Array.isArray(event.channels) ? event.channels : [], reason: event.reason ?? null, requestedAt: event.ts ?? null, timeoutAt: event.timeoutAt ?? null };
    if (event.phase) { state.runningNodes = state.runningNodes.filter((n) => n !== event.phase); if (!state.blockedNodes.includes(event.phase)) state.blockedNodes = [...state.blockedNodes, event.phase]; }
  },
  job_approved(state) {
    state.status = state.approval?.operation === "PR" ? "completed" : "running";
    state.blockedReason = null;
    state.approval = null;
    if (state.phase) state.blockedNodes = state.blockedNodes.filter((n) => n !== state.phase);
  },
  approval_timed_out(state, event, ctx) {
    state.status = "blocked";
    state.leaseId = null;
    state.blockedReason = event.reason ?? "approval timed out";
    state.approval = state.approval ? { ...state.approval, timedOutAt: event.ts ?? null } : null;
    ctx.terminal = true;
  },
  review_bundle_accepted: _handleReviewBundle,
  review_bundle_rejected: _handleReviewBundle,
  job_completed(state, event, ctx) {
    state.status = "completed";
    state.phase = "completed";
    state.leaseId = null;
    state.blockedReason = null;
    state.failureCode = null;
    state.failurePhase = null;
    state.retryable = false;
    state.retryCount = 0;
    state.failureCause = null;
    ctx.terminal = true;
  },
  pr_opened(state, event) {
    state.pr = { url: event.prUrl || event.pullRequestUrl || event.url || null, number: event.prNumber || event.number || null, artifact: event.artifact || null, openedAt: event.ts || null };
    if (event.artifact) state.artifacts.pr = event.artifact;
  },
  job_cancel_requested(state, event) {
    state.cancelRequested = true;
    state.cancelReason = event.reason ?? null;
  },
  job_cancelled(state, event, ctx) {
    state.cancelRequested = true;
    state.cancelReason = event.reason ?? state.cancelReason;
    state.status = "cancelled";
    state.leaseId = null;
    ctx.terminal = true;
  },
  job_retried(state, event, ctx) {
    state.status = "running";
    state.phase = event.fromPhase ?? state.phase;
    state.leaseId = null;
    state.blockedReason = null;
    state.failureCode = null;
    state.failurePhase = null;
    state.retryable = false;
    state.retryCount = event.retryCount ?? state.retryCount + 1;
    state.maxRetries = event.maxRetries ?? state.maxRetries;
    state.failureCause = null;
    for (const p of event.clearArtifacts ?? []) delete state.artifacts[p];
    ctx.terminal = false;
  },
  recovery_created(state, event) {
    state.recoveryOf = event.recoveryOf ?? null;
    state.retryCount = event.retryCount ?? state.retryCount;
    state.maxRetries = event.maxRetries ?? state.maxRetries;
    state.lineage = { parentJobId: event.lineage?.parentJobId ?? null, parentStatus: event.lineage?.parentStatus ?? null, parentFailureCode: event.lineage?.parentFailureCode ?? null, parentFailurePhase: event.lineage?.parentFailurePhase ?? null, parentBlockedReason: event.lineage?.parentBlockedReason ?? null, recoveryReason: event.recoveryReason ?? null, trigger: event.trigger ?? null, executorSelection: event.executorSelection ?? null, retryCount: event.retryCount ?? null, maxRetries: event.maxRetries ?? null };
    if (event.sourceContext) state.sourceContext = event.sourceContext;
  },
  permission_denied(state, event) {
    state.permissionDenials = [...state.permissionDenials, { category: event.category ?? "infra", phase: event.phase ?? null, role: event.role ?? null, action: event.action ?? null, deniedOperation: event.deniedOperation ?? event.action ?? null, targetPath: event.targetPath ?? "", reason: event.reason ?? "permission denied", allowedBoundary: event.allowedBoundary ?? "", recoveryGuidance: event.recoveryGuidance ?? "", ts: event.ts ?? null }];
    state.infraStatus = "blocked";
  },
  external_repair_started(state, event) { state.externalRepair = { status: "started", reason: event.reason ?? null, ts: event.ts ?? null }; },
  external_repair_completed(state, event) { state.externalRepair = { status: "completed", result: event.result ?? null, ts: event.ts ?? null }; },
  external_repair_failed(state, event) { state.externalRepair = { status: "failed", error: event.error ?? null, ts: event.ts ?? null }; },
  job_redirect_requested(state, event, ctx) {
    if (!ctx.terminal) { state.redirectContext = event.instructions ?? null; state.redirectReason = event.reason ?? null; state.redirectEventId = event.redirectEventId ?? null; }
  },
  job_redirect_consumed(state, event) {
    if (event.redirectEventId !== undefined) state.consumedRedirectIds = [...state.consumedRedirectIds, event.redirectEventId];
    if (state.redirectEventId === event.redirectEventId) { state.redirectContext = null; state.redirectReason = null; state.redirectEventId = null; }
  },
  workflow_selected(state, event) { state.workflow = event.workflow ?? state.workflow; },
  phase_activity(state, event) { state.lastActivityAt = event.ts ?? state.lastActivityAt; state.lastActivityMessage = event.message ?? state.lastActivityMessage; },
  external_remediation_started(state, event) { state.externalRemediationStatus = "STARTED"; state.externalRemediationArtifact = event.artifact ?? state.externalRemediationArtifact; state.externalRemediationAt = event.ts ?? state.externalRemediationAt; state.externalRemediationError = null; },
  external_remediation_completed(state, event) { state.externalRemediationStatus = event.remediationStatus ?? "UNKNOWN"; state.externalRemediationArtifact = event.artifact ?? state.externalRemediationArtifact; state.externalRemediationAt = event.ts ?? state.externalRemediationAt; state.externalRemediationError = null; },
  external_remediation_failed(state, event) { state.externalRemediationStatus = "FAILED"; state.externalRemediationArtifact = event.artifact ?? state.externalRemediationArtifact; state.externalRemediationAt = event.ts ?? state.externalRemediationAt; state.externalRemediationError = event.error ?? event.reason ?? null; },
  finalizer_result(state, event) { state.finalizer = { ok: Boolean(event.result?.ok), status: event.result?.status ?? null, code: event.result?.code ?? null, commit: event.result?.commit ?? null, closed: event.result?.closed ?? null, mode: event.result?.mode ?? null, ts: event.ts ?? null }; },
  merge_index_status(state, event) { state.mergeIndexStatus = event.indexState ?? event.mergeIndexStatus ?? state.mergeIndexStatus; state.mergeIndexBranch = event.branch ?? state.mergeIndexBranch; state.mergeIndexGitHead = event.gitHead ?? state.mergeIndexGitHead; state.mergeIndexedFrom = event.indexedFrom ?? state.mergeIndexedFrom; },
  completion_gate_evaluated(state, event) { state.completionGate = { outcome: event.outcome ?? null, reason: event.reason ?? null, missingGates: Array.isArray(event.missingGates) ? event.missingGates : [], evaluatedAt: event.ts ?? null }; },
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "blocked", "cancelled", "superseded"]);

function checkpointFileFor(cpbRoot, project, jobId, opts = {}) {
  validatePathComponent("project", project);
  validatePathComponent("jobId", jobId);
  const checkpointsRoot = path.join(_base(cpbRoot, opts), "checkpoints");
  return path.resolve(checkpointsRoot, project, `${jobId}.json`);
}

export async function writeCheckpoint(cpbRoot, project, jobId, state, opts = {}) {
  const file = checkpointFileFor(cpbRoot, project, jobId, opts);
  await mkdir(path.dirname(file), { recursive: true });
  const checkpoint = {
    _meta: { version: JOBS_EVENTS_FORMAT_VERSION, writtenAt: new Date().toISOString(), eventCount: null },
    state,
  };
  await writeFile(file, JSON.stringify(checkpoint) + "\n", "utf8");
  return file;
}

export async function readCheckpoint(cpbRoot, project, jobId, opts = {}) {
  // Try runtime root first
  if (opts.dataRoot && opts.dataRoot !== runtimeDataRoot(cpbRoot)) {
    const rtFile = checkpointFileFor(cpbRoot, project, jobId, opts);
    try {
      const raw = await readFile(rtFile, "utf8");
      const parsed = JSON.parse(raw);
      return parsed.state ?? null;
    } catch {}
  }
  const file = checkpointFileFor(cpbRoot, project, jobId);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.state ?? null;
  } catch {
    return null;
  }
}

export async function deleteCheckpoint(cpbRoot, project, jobId, opts = {}) {
  const file = checkpointFileFor(cpbRoot, project, jobId, opts);
  await rm(file, { force: true });
}

export async function checkpointJob(cpbRoot, project, jobId, opts = {}) {
  const events = await readEvents(cpbRoot, project, jobId, opts);
  if (events.length === 0) return null;
  const state = materializeJob(events);
  if (!TERMINAL_STATUSES.has(state.status)) return null;
  await writeCheckpoint(cpbRoot, project, jobId, state, opts);
  return state;
}
