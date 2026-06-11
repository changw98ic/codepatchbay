// @ts-nocheck
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };
const KIND_RANK = {
  jobs_index_divergent: 0,
  stale_runtime: 1,
  codegraph_unavailable: 2,
  agent_rate_limited: 3,
  workflow_failed: 4,
  dag_node_failed: 5,
  waiting_approval: 6,
  review_ready: 7,
};
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2 };

const CODEGRAPH_CODES = new Set(["codegraph_unavailable", "missing_codegraph_state", "missing_codegraph_index"]);
const RATE_LIMIT_CODES = new Set(["agent_rate_limited", "rate_limited"]);

function priorityRank(priority) {
  return PRIORITY_RANK[priority] ?? 9;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/[.\s-]+/g, "_");
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function uniqueKeys(keys) {
  return [...new Set(keys.filter(Boolean))];
}

function scopedKey(project, kind, scope, id) {
  const value = normalizeText(id);
  return value ? `${project || "system"}:${kind}:${scope}:${value}` : null;
}

function workKey(project, kind, title) {
  return scopedKey(project, kind, "work", title);
}

function queueContextIds(sourceContext) {
  if (!sourceContext || typeof sourceContext !== "object") return [];
  return [
    sourceContext.queueEntryId,
    sourceContext.entryId,
    sourceContext.queue?.entryId,
    sourceContext.previousQueueEntryId,
    sourceContext.retry?.previousQueueEntryId,
    sourceContext.retry?.retryQueueEntryId,
    sourceContext.reviewLoop?.previousQueueEntryId,
    sourceContext.reviewLoop?.retryQueueEntryId,
  ];
}

function queueDedupeKeys(entry, kind, project, title) {
  const metadata = entry.metadata || {};
  return uniqueKeys([
    scopedKey(project, kind, "queue", entry.id),
    scopedKey(project, kind, "job", metadata.originJobId),
    scopedKey(project, kind, "job", metadata.retryJobId),
    ...queueContextIds(metadata.sourceContext).map((id) => scopedKey(project, kind, "queue", id)),
    workKey(project, kind, title),
  ]);
}

function jobDedupeKeys(job, kind, project, title) {
  return uniqueKeys([
    scopedKey(project, kind, "job", job.jobId),
    scopedKey(project, kind, "queue", job.queueEntryId),
    ...queueContextIds(job.sourceContext).map((id) => scopedKey(project, kind, "queue", id)),
    workKey(project, kind, title),
  ]);
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function ageMs(updatedAt) {
  if (!updatedAt) return null;
  const time = new Date(updatedAt).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Date.now() - time);
}

function evidence(type, id, path) {
  return {
    type,
    id: String(id),
    ...(path ? { path } : {}),
  };
}

function text(value, fallback) {
  const str = String(value || "").trim();
  return str || fallback;
}

function jobReason(job) {
  return text(
    job.blockedReason || job.failureCause?.reason || job.failureCause?.message || job.lastActivityMessage || job.failureCode,
    "Workflow needs operator attention",
  );
}

function codeForJob(job) {
  return normalizeStatus(job.failureCode || job.failureCause?.kind || job.failureCause?.code || job.failureCause?.status);
}

function item({
  kind,
  severity,
  project = null,
  title,
  reason,
  impact,
  updatedAt = null,
  priority = null,
  nextHumanAction,
  primaryEvidenceId,
  dedupeKeys = null,
  evidence: evidenceList,
}) {
  const normalizedUpdatedAt = toIso(updatedAt);
  return {
    id: `${project || "system"}:${kind}:${primaryEvidenceId}`,
    severity,
    kind,
    project,
    title,
    reason,
    impact,
    ageMs: ageMs(normalizedUpdatedAt),
    updatedAt: normalizedUpdatedAt,
    nextHumanAction,
    evidence: evidenceList,
    _priority: priority || null,
    _primaryEvidenceId: String(primaryEvidenceId),
    _dedupeKeys: uniqueKeys(dedupeKeys || [`${project || "system"}:${kind}:evidence:${primaryEvidenceId}`]),
  };
}

function queueItem(entry, kind, severity) {
  const project = entry.projectId || entry.project || null;
  const title = text(entry.description || entry.metadata?.task, "Queued work needs attention");
  const reason = kind === "codegraph_unavailable"
    ? text(entry.metadata?.codegraphReadiness?.reason || entry.metadata?.indexFreshness?.dirtyReasons?.[0], "CodeGraph is unavailable for this queued work")
    : text(entry.metadata?.rateLimitReason || entry.metadata?.reason, "Agent provider rate limit is blocking this queued work");
  const action = kind === "codegraph_unavailable"
    ? { kind: "repair_runtime", label: "Repair runtime", href: "/hub/queue" }
    : { kind: "retry", label: "Retry when capacity is available", href: "/hub/queue" };
  return item({
    kind,
    severity,
    project,
    title,
    reason,
    impact: "The dispatcher cannot safely start this work until the blocker clears.",
    updatedAt: entry.updatedAt || entry.createdAt,
    priority: entry.priority,
    nextHumanAction: action,
    primaryEvidenceId: entry.id,
    dedupeKeys: queueDedupeKeys(entry, kind, project, title),
    evidence: [evidence("queue", entry.id)],
  });
}

function jobBlockerItem(job, kind, severity) {
  const project = job.project || null;
  const title = text(job.task, "Workflow needs attention");
  const action = kind === "codegraph_unavailable"
    ? { kind: "repair_runtime", label: "Repair runtime", href: `/inbox/${job.jobId}` }
    : kind === "agent_rate_limited"
      ? { kind: "retry", label: "Retry when capacity is available", href: `/inbox/${job.jobId}` }
      : { kind: "approve", label: "Review approval gate", href: `/inbox/${job.jobId}` };
  return item({
    kind,
    severity,
    project,
    title,
    reason: jobReason(job),
    impact: "The workflow cannot continue until this blocker is resolved.",
    updatedAt: job.updatedAt || job.createdAt,
    priority: job.priority,
    nextHumanAction: action,
    primaryEvidenceId: job.jobId,
    dedupeKeys: jobDedupeKeys(job, kind, project, title),
    evidence: [evidence("job", job.jobId, job.eventLogPath)],
  });
}

function workflowFailedItem(job) {
  return item({
    kind: "workflow_failed",
    severity: "warning",
    project: job.project || null,
    title: text(job.task, "Workflow failed"),
    reason: jobReason(job),
    impact: "The requested work is stopped until someone reviews the failure and chooses a recovery path.",
    updatedAt: job.updatedAt || job.createdAt,
    priority: job.priority,
    nextHumanAction: { kind: "retry", label: "Review failure and retry or cancel", href: `/inbox/${job.jobId}` },
    primaryEvidenceId: job.jobId,
    evidence: [evidence("job", job.jobId, job.eventLogPath)],
  });
}

function dagNodeFailedItems(job) {
  const nodeStates = job.nodeStates || {};
  return Object.entries(nodeStates)
    .filter(([, node]) => node?.status === "failed")
    .map(([nodeId, node]) => item({
      kind: "dag_node_failed",
      severity: "warning",
      project: job.project || null,
      title: `${text(job.task, "Workflow")} failed at ${node.phase || nodeId}`,
      reason: text(node.reason || node.error || jobReason(job), "DAG node failed"),
      impact: "Downstream workflow nodes are blocked until this node is recovered.",
      updatedAt: node.failedAt || job.updatedAt || job.createdAt,
      priority: job.priority,
      nextHumanAction: { kind: "retry", label: "Review failed node and retry", href: `/inbox/${job.jobId}` },
      primaryEvidenceId: `${job.jobId}:${nodeId}`,
      evidence: [evidence("job", `${job.jobId}:${nodeId}`, job.eventLogPath)],
    }));
}

function reviewReadyItem(session) {
  return item({
    kind: "review_ready",
    severity: "info",
    project: session.project || null,
    title: text(session.intent, "Review ready"),
    reason: "A review session is waiting for user review.",
    impact: "The review loop is paused until the patch is approved or rejected.",
    updatedAt: session.updatedAt || session.createdAt,
    priority: session.priority || "P0",
    nextHumanAction: { kind: "approve", label: "Review and approve or reject", href: `/review/${session.sessionId}` },
    primaryEvidenceId: session.sessionId,
    evidence: [evidence("review", session.sessionId)],
  });
}

function runtimeItems(runtimeHealth) {
  if (!runtimeHealth) return [];
  const items = [];
  const divergence = runtimeHealth.jobsIndexDivergence || {};
  if ((divergence.count || 0) > 0 || ["warning", "blocker"].includes(divergence.severity)) {
    const severity = divergence.severity === "blocker" ? "critical" : "warning";
    items.push(item({
      kind: "jobs_index_divergent",
      severity,
      title: "Jobs index differs from event log",
      reason: text(divergence.message, `Jobs index divergence count is ${divergence.count ?? "unknown"}.`),
      impact: "Inbox and runtime status can be incomplete until the index is reconciled.",
      nextHumanAction: { kind: "repair_runtime", label: "Reconcile jobs index", href: "/hub/runtime" },
      primaryEvidenceId: "jobs-index",
      evidence: [evidence("runtime_health", "jobs-index")],
    }));
  }

  const staleRuntimeIssue = (runtimeHealth.staleJobs || 0) > 0
    || (runtimeHealth.blockers || []).some((blocker) => ["release_version_mismatch", "stale_jobs"].includes(blocker?.code));
  if (staleRuntimeIssue) {
    const detail = (runtimeHealth.blockers || []).find((blocker) => ["release_version_mismatch", "stale_jobs"].includes(blocker?.code));
    items.push(item({
      kind: "stale_runtime",
      severity: "critical",
      title: "Runtime state needs attention",
      reason: text(detail?.message, `${runtimeHealth.staleJobs || 0} stale runtime job(s) detected.`),
      impact: "Runtime actions may target stale state until the environment is refreshed or repaired.",
      nextHumanAction: { kind: "repair_runtime", label: "Inspect runtime health", href: "/hub/runtime" },
      primaryEvidenceId: "runtime",
      evidence: [evidence("runtime_health", "runtime")],
    }));
  }

  const codegraphCount = runtimeHealth.queueBlockingCounts?.codegraph_unavailable || runtimeHealth.queueBlockingCounts?.codegraphUnavailable || 0;
  if (codegraphCount > 0) {
    items.push(item({
      kind: "codegraph_unavailable",
      severity: "warning",
      title: "CodeGraph unavailable",
      reason: `${codegraphCount} queued item(s) are blocked by CodeGraph readiness.`,
      impact: "Workers cannot start affected queue entries until CodeGraph is available.",
      nextHumanAction: { kind: "repair_runtime", label: "Repair CodeGraph", href: "/hub/queue" },
      primaryEvidenceId: "codegraph",
      evidence: [evidence("runtime_health", "codegraph")],
    }));
  }

  const rateCount = runtimeHealth.queueBlockingCounts?.agent_rate_limited || runtimeHealth.queueBlockingCounts?.agentRateLimited || 0;
  if (rateCount > 0) {
    items.push(item({
      kind: "agent_rate_limited",
      severity: "warning",
      title: "Agent provider rate limited",
      reason: `${rateCount} queued item(s) are blocked by provider rate limits.`,
      impact: "Automation will remain delayed until capacity returns or routing changes.",
      nextHumanAction: { kind: "retry", label: "Retry when capacity returns", href: "/hub/queue" },
      primaryEvidenceId: "agent-rate-limit",
      evidence: [evidence("runtime_health", "agent-rate-limit")],
    }));
  }

  return items;
}

function addDeduped(map, candidate) {
  const keys = candidate._dedupeKeys?.length ? candidate._dedupeKeys : [candidate.id];
  const key = keys.find((candidateKey) => map.has(candidateKey)) || keys[0];
  const existing = map.get(key);
  if (!existing) {
    for (const candidateKey of keys) map.set(candidateKey, candidate);
    return;
  }

  for (const candidateKey of keys) map.set(candidateKey, existing);

  const evidenceKeys = new Set(existing.evidence.map((entry) => `${entry.type}:${entry.id}:${entry.path || ""}`));
  for (const entry of candidate.evidence) {
    const evidenceKey = `${entry.type}:${entry.id}:${entry.path || ""}`;
    if (!evidenceKeys.has(evidenceKey)) {
      existing.evidence.push(entry);
      evidenceKeys.add(evidenceKey);
    }
  }

  if (candidate.evidence.length > existing.evidence.length) {
    Object.assign(existing, {
      title: candidate.title,
      reason: candidate.reason,
      impact: candidate.impact,
      nextHumanAction: candidate.nextHumanAction,
    });
  }
  if ((SEVERITY_RANK[candidate.severity] ?? 9) < (SEVERITY_RANK[existing.severity] ?? 9)) {
    existing.severity = candidate.severity;
  }
  existing._priority = priorityRank(candidate._priority) < priorityRank(existing._priority)
    ? candidate._priority
    : existing._priority;
}

function sortAttention(a, b) {
  const severity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  if (severity !== 0) return severity;
  const kind = (KIND_RANK[a.kind] ?? 99) - (KIND_RANK[b.kind] ?? 99);
  if (kind !== 0) return kind;
  const at = a.updatedAt ? new Date(a.updatedAt).getTime() : Number.MAX_SAFE_INTEGER;
  const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  const priority = priorityRank(a._priority) - priorityRank(b._priority);
  if (priority !== 0) return priority;
  return a.id.localeCompare(b.id);
}

function publicItem(attentionItem) {
  const { _priority, _primaryEvidenceId, _dedupeKeys, ...publicFields } = attentionItem;
  return publicFields;
}

export function buildAttentionProjection({
  jobs = [],
  queueEntries = [],
  reviews = [],
  runtimeHealth = null,
} = {}) {
  const deduped = new Map();

  for (const runtimeItem of runtimeItems(runtimeHealth)) addDeduped(deduped, runtimeItem);

  for (const entry of queueEntries || []) {
    if (!entry?.id) continue;
    const status = normalizeStatus(entry.status);
    const approvalStatus = normalizeStatus(entry.metadata?.approval?.status);
    if (status === "codegraph_unavailable" || status === "index_unavailable") {
      addDeduped(deduped, queueItem(entry, "codegraph_unavailable", "warning"));
    } else if (status === "agent_rate_limited" || status === "rate_limited") {
      addDeduped(deduped, queueItem(entry, "agent_rate_limited", "warning"));
    } else if (status === "waiting_approval" || approvalStatus === "waiting_approval") {
      addDeduped(deduped, queueItem(entry, "waiting_approval", "warning"));
    }
  }

  for (const job of jobs || []) {
    if (!job?.jobId) continue;
    const code = codeForJob(job);
    const status = normalizeStatus(job.status);
    if (CODEGRAPH_CODES.has(code)) {
      addDeduped(deduped, jobBlockerItem(job, "codegraph_unavailable", "critical"));
    } else if (RATE_LIMIT_CODES.has(code) || status === "agent_rate_limited") {
      addDeduped(deduped, jobBlockerItem(job, "agent_rate_limited", "warning"));
    } else if (status === "waiting_approval" || code === "waiting_approval" || code === "approval_required") {
      addDeduped(deduped, jobBlockerItem(job, "waiting_approval", "warning"));
    } else if (status === "failed") {
      addDeduped(deduped, workflowFailedItem(job));
    }

    for (const dagItem of dagNodeFailedItems(job)) addDeduped(deduped, dagItem);
  }

  for (const session of reviews || []) {
    if (session?.sessionId && session.status === "user_review") {
      addDeduped(deduped, reviewReadyItem(session));
    }
  }

  return [...new Set(deduped.values())].sort(sortAttention).map(publicItem);
}
