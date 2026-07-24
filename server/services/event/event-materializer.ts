import { isRecord, recordValue, type LooseRecord } from "../../../core/contracts/types.js";
import {
  parseWorktreeOwnership,
  type ReadyWorktreeOwnership,
} from "../../../core/contracts/worktree-ownership.js";
import { deriveDagResumeState } from "../../../core/workflow/dag-executor.js";
import type { EventRecord } from "./event-types.js";

type WorkflowDag = LooseRecord & {
  name?: string | null;
  nodes?: LooseRecord[];
  edges?: unknown[];
};

type DagResumeState = LooseRecord & {
  completedNodeIds: string[];
  failedNodeId?: string | null;
  readyNodeIds?: string[];
  blockedNodeIds?: string[];
  resumeTarget?: (LooseRecord & { nodeId?: string | null; phase?: string | null }) | null;
};

type NodeState = LooseRecord & {
  status?: string | null;
  phase?: string | null;
  attempt?: unknown;
  artifact?: unknown;
  reason?: unknown;
  error?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
  failedAt?: unknown;
  retryingAt?: unknown;
  skippedAt?: unknown;
  cancelledAt?: unknown;
  blockedAt?: unknown;
  durationMs?: number | null;
};

type ReviewLoop = {
  rounds: LooseRecord[];
  latest: LooseRecord | null;
};

type ApprovalState = LooseRecord & {
  operation?: string | null;
};

type RiskMapState = LooseRecord & {
  riskLevel?: unknown;
  verificationDepth?: unknown;
  adversarialRequired?: boolean;
  generatedAt?: unknown;
};

type DynamicAgentPlanState = LooseRecord & {
  riskLevel?: unknown;
  adversarialRequired?: boolean;
};

type SourceContextState = LooseRecord & {
  dagResume?: DagResumeState | LooseRecord | null;
  retry?: LooseRecord;
};

export type MaterializedJobState = LooseRecord & {
  jobId: string | null;
  project: string | null;
  task: string | null;
  status: string | null;
  phase: string | null;
  attempt: unknown;
  workflow: string | null;
  planMode: string | null;
  planDecision: LooseRecord | null;
  executor: unknown;
  executorSelection?: LooseRecord | null;
  artifacts: LooseRecord;
  artifactsByKind: Record<string, LooseRecord>;
  artifactHistoryByKind: Record<string, LooseRecord[]>;
  completedPhases: string[];
  completedNodes: string[];
  runningNodes: string[];
  blockedNodes: string[];
  consumedRedirectIds: string[];
  nodeStates: Record<string, NodeState>;
  leaseId: string | null;
  worktree: string | null;
  worktreeBranch: string | null;
  worktreeBaseBranch: string | null;
  worktreeBaseCommit: string | null;
  worktreeOwnership: ReadyWorktreeOwnership | null;
  createdAt: string | null;
  updatedAt: string | null;
  phaseStartedAt?: string | null;
  blockedReason: unknown;
  failureCode: string | null;
  failurePhase: string | null;
  retryable: boolean;
  retryCount: number;
  maxRetries: number | null;
  failureCause: unknown;
  cancelRequested: boolean;
  cancelReason: unknown;
  redirectContext: unknown;
  redirectReason: unknown;
  redirectEventId: string | null;
  lastActivityAt: string | null;
  lastActivityMessage: unknown;
  externalRemediationStatus: unknown;
  externalRemediationArtifact: unknown;
  externalRemediationAt: string | null;
  externalRemediationError: unknown;
  externalRepair: LooseRecord | null;
  lineage: (LooseRecord & { executorSelection?: LooseRecord | null }) | null;
  recoveryOf: unknown;
  sourceContext: SourceContextState | null;
  queueEntryId: string | null;
  pr: LooseRecord | null;
  permissionDenials: LooseRecord[];
  infraStatus: unknown;
  finalizer: (LooseRecord & { verdict?: unknown }) | null;
  mergeIndexStatus: unknown;
  mergeIndexBranch: unknown;
  mergeIndexGitHead: unknown;
  mergeIndexedFrom: unknown;
  indexSnapshotId: string | null;
  sourceFingerprint: string | null;
  indexFreshness: unknown;
  planCache: LooseRecord | null;
  workflowDag: WorkflowDag | null;
  dagResume: DagResumeState | null;
  dynamicAgentPlan: DynamicAgentPlanState | null;
  adversarialVerdict: LooseRecord | null;
  riskMap: RiskMapState | null;
  phaseBudgetPolicy: LooseRecord | null;
  evidenceRequirements: unknown[];
  riskLevel: unknown;
  riskMapGeneratedAt: unknown;
  verificationDepth: unknown;
  adversarialRequired: boolean;
  routingFeedback: LooseRecord | null;
  phaseAgentSelections: LooseRecord[];
  approval: ApprovalState | null;
  reviewLoop: ReviewLoop;
  completionGate: LooseRecord | null;
  completionReport: LooseRecord | null;
  auditFinalized: LooseRecord | null;
  runtimeContext: LooseRecord | null;
  runtimeFailures: LooseRecord[];
  verdict?: string | null;
};

type MaterializerContext = {
  terminal: boolean;
};

type EventHandler = (
  state: MaterializedJobState,
  event: EventRecord,
  ctx: MaterializerContext,
) => void;

function isDateInput(value: unknown): value is string | number | Date {
  return typeof value === "string" || typeof value === "number" || value instanceof Date;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringishValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function sourceContextValue(value: unknown): SourceContextState | null {
  return isRecord(value) ? value : null;
}

function recordList(value: unknown): LooseRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export const POST_TERMINAL_ALLOWED = new Set([
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
  "audit_finalized",
  "runtime_context_snapshot",
  "runtime_failure_recorded",
  "external_evaluation_recorded",
]);

const NODE_STATE_DEFAULTS: NodeState = {
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

function _updateNodeState(state: MaterializedJobState, nodeId: string | undefined | null, updates: LooseRecord) {
  if (!nodeId) return;
  const prev = state.nodeStates[nodeId] || { ...NODE_STATE_DEFAULTS };
  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  );
  const next = { ...prev, ...definedUpdates };
  const terminalTs = definedUpdates.completedAt || definedUpdates.failedAt || definedUpdates.cancelledAt;
  if (isDateInput(terminalTs) && isDateInput(prev.startedAt)) {
    const ms = new Date(terminalTs).getTime() - new Date(prev.startedAt).getTime();
    next.durationMs = Number.isFinite(ms) ? ms : null;
  }
  state.nodeStates = { ...state.nodeStates, [nodeId]: next };
}

function _workflowNodes(state: MaterializedJobState): LooseRecord[] {
  return recordList(state.workflowDag?.nodes);
}

function _workflowNodeIds(state: MaterializedJobState): Set<string> {
  return new Set(
    _workflowNodes(state)
      .map((node) => stringValue(node.id))
      .filter((id): id is string => Boolean(id)),
  );
}

function _workflowHasNodeId(state: MaterializedJobState, nodeId: string | undefined | null): boolean {
  return _workflowNodeIds(state).has(nodeId);
}

function _syncDagResume(state: MaterializedJobState) {
  const phaseStates: { [phase: string]: string } = {};
  for (const phase of state.completedPhases) phaseStates[phase] = "completed";
  if (state.failurePhase) phaseStates[state.failurePhase] = state.status === "blocked" ? "blocked" : "failed";
  state.dagResume = deriveDagResumeState({
    workflowDag: state.workflowDag,
    nodeStates: state.nodeStates,
    phaseStates,
  });
  state.completedNodes = state.dagResume.completedNodeIds;
}

export function materializeJob(events: EventRecord[]): MaterializedJobState {
  const state: MaterializedJobState = {
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
    worktreeBaseCommit: null,
    worktreeOwnership: null,
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
    dagResume: null,
    dynamicAgentPlan: null,
    adversarialVerdict: null,
    riskMap: null,
    phaseBudgetPolicy: null,
    evidenceRequirements: [],
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
    completionReport: null,
    auditFinalized: null,
    runtimeContext: null,
    artifactsByKind: {},
    artifactHistoryByKind: {},
    runtimeFailures: [],
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
    if (!isPostTerminal && event.ts !== undefined) state.updatedAt = event.ts;

    if (!(isPostTerminal && event.type?.startsWith("dag_node_"))) {
      EVENT_HANDLERS[event.type]?.(state, event, ctx);
    }
  }

  _syncDagResume(state);
  return state;
}

export function advanceMaterializedJob(current: MaterializedJobState, event: EventRecord): MaterializedJobState {
  const state = structuredClone(current);
  const ctx = { terminal: TERMINAL_STATUSES.has(state.status) };
  const isPostTerminal = ctx.terminal;
  if (isPostTerminal && !POST_TERMINAL_ALLOWED.has(event.type)) return state;
  if (event.jobId !== undefined) state.jobId = event.jobId;
  if (event.project !== undefined) state.project = event.project;
  if (!isPostTerminal && event.attempt !== undefined) state.attempt = event.attempt;
  if (!isPostTerminal && event.workflow !== undefined) state.workflow = event.workflow;
  if (!isPostTerminal && event.planMode !== undefined) state.planMode = event.planMode;
  if (!isPostTerminal && event.ts !== undefined) state.updatedAt = event.ts;
  if (!(isPostTerminal && event.type?.startsWith("dag_node_"))) {
    EVENT_HANDLERS[event.type]?.(state, event, ctx);
  }
  _syncDagResume(state);
  return state;
}

// ── Event handler lookup table ────────────────────────────
// Each handler mutates state in-place. ctx.terminal controls the post-terminal gate.
// Shared handlers use the same function reference for multiple event types.

const _handlePlanCache = (state: MaterializedJobState, event: EventRecord) => {
  state.planCache = { ...(state.planCache || {}), ...event };
};

const _handleReviewBundle = (state: MaterializedJobState, event: EventRecord) => {
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

const EVENT_HANDLERS: Record<string, EventHandler> = {
  job_created(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
    state.task = event.task ?? state.task;
    state.executor = event.executor ?? state.executor;
    state.executorSelection = event.executorSelection ?? state.executorSelection;
    state.status = "running";
    state.createdAt = event.ts ?? state.createdAt;
    state.blockedReason = null;
    state.queueEntryId = event.queueEntryId ?? state.queueEntryId;
    if (event.sourceContext) state.sourceContext = sourceContextValue(event.sourceContext);
    if (event.indexSnapshotId !== undefined) state.indexSnapshotId = event.indexSnapshotId;
    if (event.sourceFingerprint !== undefined) state.sourceFingerprint = event.sourceFingerprint;
    if (event.indexFreshness !== undefined) state.indexFreshness = event.indexFreshness;
    if (event.planCache !== undefined) state.planCache = event.planCache;
    ctx.terminal = false;
  },
  plan_decision(state: MaterializedJobState, event: EventRecord) {
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
  riskmap_generated(state: MaterializedJobState, event: EventRecord) {
    state.riskMap = event.riskMap ?? {
      riskLevel: event.riskLevel ?? null, domains: event.domains ?? [],
      highRiskFiles: event.highRiskFiles ?? [], verificationDepth: event.verificationDepth ?? null,
      adversarialRequired: Boolean(event.adversarialRequired), adversarialFocus: event.adversarialFocus ?? [],
      confidence: event.confidence ?? null,
    };
    state.riskLevel = event.riskLevel ?? state.riskMap?.riskLevel ?? null;
    state.verificationDepth = event.verificationDepth ?? state.riskMap?.verificationDepth ?? null;
    state.adversarialRequired = event.adversarialRequired ?? state.riskMap?.adversarialRequired ?? false;
    if (event.phaseBudgetPolicy !== undefined) state.phaseBudgetPolicy = recordValue(event.phaseBudgetPolicy);
    state.evidenceRequirements = Array.isArray(event.evidenceRequirements) ? event.evidenceRequirements : state.evidenceRequirements;
    state.riskMapGeneratedAt = event.ts ?? state.riskMap?.generatedAt ?? state.riskMapGeneratedAt;
  },
  workflow_dag_materialized(state: MaterializedJobState, event: EventRecord) {
    state.workflow = event.workflow ?? state.workflow;
    state.planMode = event.planMode ?? state.planMode;
    state.workflowDag = event.workflowDag ?? { name: event.workflow ?? state.workflow, nodes: event.nodes ?? [], edges: event.edges ?? [] };
    {
      const nodeIds = _workflowNodeIds(state);
      state.completedNodes = state.completedNodes.filter((id: string) => nodeIds.has(id));
      state.runningNodes = state.runningNodes.filter((id: string) => nodeIds.has(id));
      state.blockedNodes = state.blockedNodes.filter((id: string) => nodeIds.has(id));
    }
    for (const node of _workflowNodes(state)) {
      const nodeId = stringValue(node.id);
      if (nodeId && !state.nodeStates[nodeId]) _updateNodeState(state, nodeId, { status: "pending", phase: stringValue(node.phase) ?? nodeId });
    }
  },
  dynamic_agent_plan_generated(state: MaterializedJobState, event: EventRecord) {
    state.dynamicAgentPlan = event.dynamicAgentPlan ?? state.dynamicAgentPlan;
    state.riskLevel = event.riskLevel ?? state.dynamicAgentPlan?.riskLevel ?? state.riskLevel;
    state.adversarialRequired = event.adversarialRequired ?? state.dynamicAgentPlan?.adversarialRequired ?? state.adversarialRequired;
  },
  adversarial_verdict(state: MaterializedJobState, event: EventRecord) {
    const verdict = recordValue(event.verdict);
    state.adversarialVerdict = { verdict: event.verdict ?? null, artifact: event.artifact ?? null, status: event.status ?? verdict.status ?? null, reason: event.reason ?? verdict.reason ?? null, at: event.ts ?? null };
  },
  executor_routing_feedback(state: MaterializedJobState, event: EventRecord) {
    state.routingFeedback = { phase: event.phase ?? null, requested: event.requested ?? null, reason: event.reason ?? null, confidence: event.confidence ?? null, signals: event.signals ?? [], upgradedQueueEntryId: event.upgradedQueueEntryId ?? null, feedbackPath: event.feedbackPath ?? null, at: event.ts ?? null };
  },
  agent_routing_decision(state: MaterializedJobState, event: EventRecord) {
    const selection = event.executorSelection ?? { role: event.role ?? null, category: event.category ?? null, workflow: event.workflow ?? null, preferredAgent: event.preferredAgent ?? null, selectedAgent: event.selectedAgent ?? null, fallbackAgent: event.fallbackAgent ?? null, fallbackAllowed: event.fallbackAllowed ?? null, fallbackApplied: event.fallbackApplied ?? null, reason: event.reason ?? null };
    if (event.phase) { state.phaseAgentSelections = [...state.phaseAgentSelections, { phase: event.phase, ...selection, ts: event.ts ?? null }]; return; }
    state.executorSelection = selection;
    if (event.selectedAgent !== undefined) state.executor = event.selectedAgent;
  },
  agent_routing_result(state: MaterializedJobState, event: EventRecord) {
    for (let index = state.phaseAgentSelections.length - 1; index >= 0; index -= 1) {
      const selection = state.phaseAgentSelections[index];
      if (selection.phase !== event.phase || selection.role !== event.role) continue;
      state.phaseAgentSelections[index] = {
        ...selection,
        finalAgent: event.finalAgent ?? null,
        providerKey: event.providerKey ?? null,
        finalStatus: event.status ?? null,
        failureKind: event.failureKind ?? null,
        fallbackApplied: event.fallbackApplied ?? selection.fallbackApplied ?? null,
        fallbackCount: event.fallbackCount ?? 0,
        completedAt: event.ts ?? null,
      };
      return;
    }
  },
  worktree_created(state: MaterializedJobState, event: EventRecord) {
    state.worktree = stringValue(event.worktree) ?? stringValue(event.path) ?? state.worktree;
    state.worktreeBranch = event.branch ?? event.worktreeBranch ?? state.worktreeBranch;
    state.worktreeBaseBranch = event.baseBranch ?? event.worktreeBaseBranch ?? state.worktreeBaseBranch;
    state.worktreeBaseCommit = event.baseCommit ?? event.worktreeBaseCommit ?? state.worktreeBaseCommit;
    if (event.worktreeOwnership !== undefined) {
      state.worktreeOwnership = parseWorktreeOwnership(event.worktreeOwnership) as ReadyWorktreeOwnership;
    }
  },
  phase_started(state: MaterializedJobState, event: EventRecord) {
    state.phase = event.phase ?? state.phase;
    state.leaseId = event.leaseId ?? null;
    state.status = "running";
    state.blockedReason = null;
    if (event.phase && !state.runningNodes.includes(event.phase)) state.runningNodes = [...state.runningNodes, event.phase];
  },
  phase_completed(state: MaterializedJobState, event: EventRecord) {
    state.phase = event.phase ?? state.phase;
    state.leaseId = null;
    state.status = "running";
    if (event.phase !== undefined) {
      state.runningNodes = state.runningNodes.filter((n: string) => n !== event.phase);
      if (!state.completedPhases.includes(event.phase)) state.completedPhases = [...state.completedPhases, event.phase];
      if (!state.workflowDag && !state.completedNodes.includes(event.phase)) {
        state.completedNodes = [...state.completedNodes, event.phase];
      } else if (_workflowHasNodeId(state, event.phase)) {
        state.runningNodes = state.runningNodes.filter((n: string) => n !== event.phase);
        if (!state.completedNodes.includes(event.phase)) state.completedNodes = [...state.completedNodes, event.phase];
        _updateNodeState(state, event.phase, { status: "completed", phase: event.phase, artifact: event.artifact, completedAt: event.ts });
      }
    }
    if (event.phase !== undefined && event.artifact !== undefined) state.artifacts[event.phase] = event.artifact;
  },
  dag_node_started(state: MaterializedJobState, event: EventRecord) {
    if (event.nodeId && !state.runningNodes.includes(event.nodeId)) state.runningNodes = [...state.runningNodes, event.nodeId];
    state.blockedNodes = state.blockedNodes.filter((n: string) => n !== event.nodeId);
    _updateNodeState(state, event.nodeId, { status: "running", phase: event.phase, attempt: event.attempt, startedAt: event.ts, completedAt: null, failedAt: null, skippedAt: null, cancelledAt: null, blockedAt: null, durationMs: null });
  },
  dag_node_completed(state: MaterializedJobState, event: EventRecord) {
    state.runningNodes = state.runningNodes.filter((n: string) => n !== event.nodeId);
    if (event.nodeId && !state.completedNodes.includes(event.nodeId)) state.completedNodes = [...state.completedNodes, event.nodeId];
    if (event.phase !== undefined && event.artifact !== undefined) state.artifacts[event.phase] = event.artifact;
    if (event.phase !== undefined && !state.completedPhases.includes(event.phase)) state.completedPhases = [...state.completedPhases, event.phase];
    _updateNodeState(state, event.nodeId, { status: "completed", phase: event.phase, artifact: event.artifact, completedAt: event.ts });
  },
  dag_node_failed(state: MaterializedJobState, event: EventRecord) {
    state.runningNodes = state.runningNodes.filter((n: string) => n !== event.nodeId);
    state.failureCode = stringishValue(event.code) ?? state.failureCode;
    state.failurePhase = event.phase ?? state.failurePhase;
    _updateNodeState(state, event.nodeId, { status: "failed", phase: event.phase, error: event.error ?? event.reason, reason: event.reason, failedAt: event.ts });
  },
  dag_node_blocked(state: MaterializedJobState, event: EventRecord) {
    state.runningNodes = state.runningNodes.filter((n: string) => n !== event.nodeId);
    if (event.nodeId && !state.blockedNodes.includes(event.nodeId)) state.blockedNodes = [...state.blockedNodes, event.nodeId];
    _updateNodeState(state, event.nodeId, { status: "blocked", reason: event.reason, blockedAt: event.ts });
  },
  dag_node_retrying(state: MaterializedJobState, event: EventRecord) {
    if (event.nodeId) { state.runningNodes = state.runningNodes.filter((n: string) => n !== event.nodeId); state.blockedNodes = state.blockedNodes.filter((n: string) => n !== event.nodeId); state.completedNodes = state.completedNodes.filter((n: string) => n !== event.nodeId); }
    if (event.phase !== undefined) state.completedPhases = state.completedPhases.filter((p: string) => p !== event.phase);
    _updateNodeState(state, event.nodeId, { status: "retrying", phase: event.phase, attempt: event.attempt, artifact: null, reason: event.reason, retryingAt: event.ts, completedAt: null, failedAt: null, skippedAt: null, cancelledAt: null, blockedAt: null, durationMs: null });
  },
  dag_node_skipped(state: MaterializedJobState, event: EventRecord) {
    if (event.nodeId) state.runningNodes = state.runningNodes.filter((n: string) => n !== event.nodeId);
    if (event.nodeId && !state.completedNodes.includes(event.nodeId)) state.completedNodes = [...state.completedNodes, event.nodeId];
    if (event.phase !== undefined && !state.completedPhases.includes(event.phase)) state.completedPhases = [...state.completedPhases, event.phase];
    _updateNodeState(state, event.nodeId, { status: "skipped", phase: event.phase, reason: event.reason, skippedAt: event.ts });
  },
  dag_node_cancelled(state: MaterializedJobState, event: EventRecord) {
    if (event.nodeId) state.runningNodes = state.runningNodes.filter((n: string) => n !== event.nodeId);
    _updateNodeState(state, event.nodeId, { status: "cancelled", phase: event.phase, reason: event.reason, cancelledAt: event.ts });
  },
  phase_failed(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
    state.phase = event.phase ?? state.phase;
    state.leaseId = null;
    state.status = "failed";
    state.blockedReason = event.error ?? event.reason ?? null;
    state.failureCode = stringishValue(event.code) ?? state.failureCode;
    state.failurePhase = event.phase ?? state.failurePhase;
    state.retryable = event.retryable ?? state.retryable;
    state.retryCount = event.retryCount ?? state.retryCount;
    state.maxRetries = event.maxRetries ?? state.maxRetries;
    state.failureCause = event.cause ?? state.failureCause;
    if (event.phase !== undefined) state.runningNodes = state.runningNodes.filter((n: string) => n !== event.phase);
    ctx.terminal = true;
  },
  budget_exceeded(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
    state.status = "blocked";
    state.leaseId = null;
    state.blockedReason = event.reason ?? "budget exceeded";
    ctx.terminal = true;
  },
  job_blocked(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
    state.status = "blocked";
    state.leaseId = null;
    state.blockedReason = event.reason ?? event.blockedReason ?? null;
    state.failureCode = stringishValue(event.code) ?? event.kind ?? state.failureCode;
    state.failureCause = event.cause ?? state.failureCause;
    ctx.terminal = true;
  },
  job_failed(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
    state.status = "failed";
    state.leaseId = null;
    state.blockedReason = event.reason ?? event.error ?? state.blockedReason;
    state.failureCode = stringishValue(event.code) ?? state.failureCode;
    state.failurePhase = event.phase ?? state.failurePhase;
    state.retryable = event.retryable ?? state.retryable;
    state.retryCount = event.retryCount ?? state.retryCount;
    state.maxRetries = event.maxRetries ?? state.maxRetries;
    state.failureCause = event.cause ?? state.failureCause;
    ctx.terminal = true;
  },
  pool_exhausted(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
    state.status = "failed";
    state.leaseId = null;
    state.blockedReason = event.reason ?? "ACP pool exhausted";
    state.failureCode = "pool_exhausted";
    state.failurePhase = event.phase ?? state.phase;
    state.retryable = true;
    ctx.terminal = true;
  },
  job_superseded(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
    state.status = "superseded";
    state.blockedReason = event.reason ?? "superseded by remediation lineage";
    ctx.terminal = true;
  },
  approval_required(state: MaterializedJobState, event: EventRecord) {
    state.status = "waiting.approval";
    state.phase = event.phase ?? state.phase;
    state.blockedReason = event.reason ?? "approval required";
    state.approval = { operation: event.operation ?? null, phase: event.phase ?? null, channels: Array.isArray(event.channels) ? event.channels : [], reason: event.reason ?? null, requestedAt: event.ts ?? null, timeoutAt: event.timeoutAt ?? null };
    if (event.phase) { state.runningNodes = state.runningNodes.filter((n: string) => n !== event.phase); if (!state.blockedNodes.includes(event.phase)) state.blockedNodes = [...state.blockedNodes, event.phase]; }
  },
  job_approved(state: MaterializedJobState) {
    state.status = state.approval?.operation === "PR" ? "completed" : "running";
    state.blockedReason = null;
    state.approval = null;
    if (state.phase) state.blockedNodes = state.blockedNodes.filter((n: string) => n !== state.phase);
  },
  approval_timed_out(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
    state.status = "blocked";
    state.leaseId = null;
    state.blockedReason = event.reason ?? "approval timed out";
    state.approval = state.approval ? { ...state.approval, timedOutAt: event.ts ?? null } : null;
    ctx.terminal = true;
  },
  review_bundle_accepted: _handleReviewBundle,
  review_bundle_rejected: _handleReviewBundle,
  job_completed(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
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
  pr_opened(state: MaterializedJobState, event: EventRecord) {
    state.pr = { url: event.prUrl || event.pullRequestUrl || event.url || null, number: event.prNumber || event.number || null, artifact: event.artifact || null, openedAt: event.ts || null };
    if (event.artifact) state.artifacts.pr = event.artifact;
  },
  job_cancel_requested(state: MaterializedJobState, event: EventRecord) {
    state.cancelRequested = true;
    state.cancelReason = event.reason ?? null;
  },
  job_cancelled(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
    state.cancelRequested = true;
    state.cancelReason = event.reason ?? state.cancelReason;
    state.status = "cancelled";
    state.leaseId = null;
    ctx.terminal = true;
  },
  job_retried(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
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
  recovery_created(state: MaterializedJobState, event: EventRecord) {
    state.recoveryOf = event.recoveryOf ?? null;
    state.retryCount = event.retryCount ?? state.retryCount;
    state.maxRetries = event.maxRetries ?? state.maxRetries;
    state.lineage = { parentJobId: event.lineage?.parentJobId ?? null, parentStatus: event.lineage?.parentStatus ?? null, parentFailureCode: event.lineage?.parentFailureCode ?? null, parentFailurePhase: event.lineage?.parentFailurePhase ?? null, parentBlockedReason: event.lineage?.parentBlockedReason ?? null, recoveryReason: event.recoveryReason ?? null, trigger: event.trigger ?? null, executorSelection: event.executorSelection ?? null, retryCount: event.retryCount ?? null, maxRetries: event.maxRetries ?? null };
    if (event.sourceContext) state.sourceContext = sourceContextValue(event.sourceContext);
  },
  permission_denied(state: MaterializedJobState, event: EventRecord) {
    state.permissionDenials = [...state.permissionDenials, { category: event.category ?? "infra", phase: event.phase ?? null, role: event.role ?? null, action: event.action ?? null, deniedOperation: event.deniedOperation ?? event.action ?? null, targetPath: event.targetPath ?? "", reason: event.reason ?? "permission denied", allowedBoundary: event.allowedBoundary ?? "", recoveryGuidance: event.recoveryGuidance ?? "", ts: event.ts ?? null }];
    state.infraStatus = "blocked";
  },
  external_repair_started(state: MaterializedJobState, event: EventRecord) { state.externalRepair = { status: "started", reason: event.reason ?? null, ts: event.ts ?? null }; },
  external_repair_completed(state: MaterializedJobState, event: EventRecord) { state.externalRepair = { status: "completed", result: event.result ?? null, ts: event.ts ?? null }; },
  external_repair_failed(state: MaterializedJobState, event: EventRecord) { state.externalRepair = { status: "failed", error: event.error ?? null, ts: event.ts ?? null }; },
  job_redirect_requested(state: MaterializedJobState, event: EventRecord, ctx: MaterializerContext) {
    if (!ctx.terminal) { state.redirectContext = event.instructions ?? null; state.redirectReason = event.reason ?? null; state.redirectEventId = event.redirectEventId ?? null; }
  },
  job_redirect_consumed(state: MaterializedJobState, event: EventRecord) {
    if (event.redirectEventId !== undefined) state.consumedRedirectIds = [...state.consumedRedirectIds, event.redirectEventId];
    if (state.redirectEventId === event.redirectEventId) { state.redirectContext = null; state.redirectReason = null; state.redirectEventId = null; }
  },
  workflow_selected(state: MaterializedJobState, event: EventRecord) { state.workflow = event.workflow ?? state.workflow; },
  phase_activity(state: MaterializedJobState, event: EventRecord) { state.lastActivityAt = event.ts ?? state.lastActivityAt; state.lastActivityMessage = event.message ?? state.lastActivityMessage; },
  external_remediation_started(state: MaterializedJobState, event: EventRecord) { state.externalRemediationStatus = "STARTED"; state.externalRemediationArtifact = event.artifact ?? state.externalRemediationArtifact; state.externalRemediationAt = event.ts ?? state.externalRemediationAt; state.externalRemediationError = null; },
  external_remediation_completed(state: MaterializedJobState, event: EventRecord) { state.externalRemediationStatus = event.remediationStatus ?? "UNKNOWN"; state.externalRemediationArtifact = event.artifact ?? state.externalRemediationArtifact; state.externalRemediationAt = event.ts ?? state.externalRemediationAt; state.externalRemediationError = null; },
  external_remediation_failed(state: MaterializedJobState, event: EventRecord) { state.externalRemediationStatus = "FAILED"; state.externalRemediationArtifact = event.artifact ?? state.externalRemediationArtifact; state.externalRemediationAt = event.ts ?? state.externalRemediationAt; state.externalRemediationError = event.error ?? event.reason ?? null; },
  finalizer_result(state: MaterializedJobState, event: EventRecord) {
    const result = recordValue(event.result);
    state.finalizer = { ok: Boolean(result.ok), status: result.status ?? null, code: result.code ?? null, commit: result.commit ?? null, closed: result.closed ?? null, mode: result.mode ?? null, ts: event.ts ?? null };
  },
  merge_index_status(state: MaterializedJobState, event: EventRecord) { state.mergeIndexStatus = event.indexState ?? event.mergeIndexStatus ?? state.mergeIndexStatus; state.mergeIndexBranch = event.branch ?? state.mergeIndexBranch; state.mergeIndexGitHead = event.gitHead ?? state.mergeIndexGitHead; state.mergeIndexedFrom = event.indexedFrom ?? state.mergeIndexedFrom; },
  completion_gate_evaluated(state: MaterializedJobState, event: EventRecord) { const completionReport = event.completionReport && typeof event.completionReport === "object" && !Array.isArray(event.completionReport) ? event.completionReport : null; state.completionReport = completionReport; state.completionGate = { outcome: event.outcome ?? null, attemptId: event.attemptId ?? null, reason: event.reason ?? null, missingGates: Array.isArray(event.missingGates) ? event.missingGates : [], checklistOutcome: event.checklistOutcome ?? null, failedChecklistIds: Array.isArray(event.failedChecklistIds) ? event.failedChecklistIds : [], uncheckedChecklistIds: Array.isArray(event.uncheckedChecklistIds) ? event.uncheckedChecklistIds : [], missingEvidenceRefs: Array.isArray(event.missingEvidenceRefs) ? event.missingEvidenceRefs : [], mismatchedEvidenceRefs: Array.isArray(event.mismatchedEvidenceRefs) ? event.mismatchedEvidenceRefs : [], staleEvidenceRefs: Array.isArray(event.staleEvidenceRefs) ? event.staleEvidenceRefs : [], poisonedEvidenceRefs: Array.isArray(event.poisonedEvidenceRefs) ? event.poisonedEvidenceRefs : [], pollutedEvidenceRefs: Array.isArray(event.pollutedEvidenceRefs) ? event.pollutedEvidenceRefs : [], pollutedOracleFiles: Array.isArray(event.pollutedOracleFiles) ? event.pollutedOracleFiles : [], pollutedOracleFileCount: Number.isFinite(event.pollutedOracleFileCount) ? event.pollutedOracleFileCount : 0, completionReport, runtimeFailureRefs: Array.isArray(event.runtimeFailureRefs) ? event.runtimeFailureRefs : [], runtimeFailureCount: Number.isFinite(event.runtimeFailureCount) ? event.runtimeFailureCount : 0, unmappedChangedFiles: Array.isArray(event.unmappedChangedFiles) ? event.unmappedChangedFiles : [], unmappedChangedFileCount: Number.isFinite(event.unmappedChangedFileCount) ? event.unmappedChangedFileCount : 0, evaluatedAt: event.ts ?? null }; },
  artifact_created(state: MaterializedJobState, event: EventRecord) {
    const kind = event.kind || event.artifactKind;
    if (!kind || !event.artifact) return;
    const entry = {
      kind,
      name: stringValue(event.artifact) ?? stringValue(event.artifactId) ?? kind,
      id: stringValue(event.artifactId) ?? undefined,
      attemptId: stringValue(event.attemptId) ?? stringValue(event.jobId) ?? undefined,
      phase: event.phase || null,
      sha256: event.sha256 || null,
      ts: event.ts || null,
      eventId: stringValue(event.eventId) ?? undefined,
    };
    state.artifactsByKind = {
      ...(state.artifactsByKind || {}),
      [kind]: entry,
    };
    state.artifactHistoryByKind = {
      ...(state.artifactHistoryByKind || {}),
      [kind]: [...(state.artifactHistoryByKind?.[kind] || []), entry],
    };
  },
  audit_finalized(state: MaterializedJobState, event: EventRecord) {
    state.auditFinalized = {
      attemptId: event.attemptId || null,
      status: event.status || null,
      reason: event.reason || null,
      ts: event.ts || null,
    };
  },
  runtime_context_snapshot(state: MaterializedJobState, event: EventRecord) {
    state.runtimeContext = {
      attemptId: event.attemptId || null,
      assignmentId: event.assignmentId || null,
      workerId: event.workerId || null,
      model: event.model || null,
      runtime: event.runtime || null,
      queueId: event.queueId || null,
      queuePriority: event.queuePriority ?? null,
      concurrencyKey: event.concurrencyKey || null,
      rateLimitedUntil: event.rateLimitedUntil || null,
      heartbeatAt: event.heartbeatAt || null,
      progressKind: event.progressKind || null,
      blocker: event.blocker || null,
      ts: event.ts || null,
    };
  },
  runtime_failure_recorded(state: MaterializedJobState, event: EventRecord) {
    state.runtimeFailures = [...state.runtimeFailures, {
      type: event.failureType || null,
      attemptId: event.attemptId || null,
      phase: event.phase || null,
      nodeId: event.nodeId || null,
      reason: event.reason || null,
      ts: event.ts || null,
    }];
  },
};

export const TERMINAL_STATUSES: ReadonlySet<string | null> = new Set(["completed", "failed", "blocked", "cancelled", "superseded"]);
