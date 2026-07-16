import { readFile } from "node:fs/promises";
import { isRecord, recordValue, type LooseRecord } from "../../../core/contracts/types.js";
import { readEvents } from "../event/event-store.js";
import type { EventRecord } from "../event/event-types.js";
import { withTraceContext } from "./trace-context.js";

export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: string;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  attributes: LooseRecord;
  events: EventRecord[];
  children: TraceSpan[];
};

export type JobTrace = {
  traceId: string;
  project: string;
  jobId: string;
  root: TraceSpan;
  spans: TraceSpan[];
};

type BuildJobTraceInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  dataRoot?: string | null;
};

type AuditReference = {
  file: string;
  phase: string | null;
  role: string | null;
  fallbackTs: string | null;
  assignmentId: string | null;
  attemptId: string | null;
  iteration: unknown;
  candidateId: unknown;
};

function text(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function stringOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function millisBetween(start: string | null, end: string | null) {
  if (!start || !end) return null;
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

function eventStatus(event: EventRecord) {
  const type = text(event.type);
  if (event.status) return text(event.status);
  if (type.endsWith("_failed")) return "failed";
  if (type.endsWith("_completed")) return "passed";
  if (type.endsWith("_blocked")) return "blocked";
  return null;
}

function isEndEvent(event: EventRecord) {
  const type = text(event.type);
  if (type === "tool_call" && event.status) return true;
  return type.endsWith("_result") ||
    type.endsWith("_completed") ||
    type.endsWith("_failed") ||
    type.endsWith("_blocked") ||
    type.endsWith("_cancelled");
}

function spanName(event: EventRecord) {
  const type = text(event.type);
  if (type.startsWith("job_")) return `job ${event.jobId || ""}`.trim();
  if (type === "retry_decision") return `retry ${event.phase || "unknown"} -> ${event.retryPhase || event.action || "unknown"}`;
  if (["phase_retry", "phase_feedback_retry", "phase_quality_retry", "phase_agent_fallback", "dag_node_retrying"].includes(type)) {
    const iteration = event.iteration ?? event.attempt ?? event.retryCount;
    return `retry ${event.phase || "unknown"} ${type}${iteration === undefined ? "" : ` #${iteration}`}`;
  }
  if (type.startsWith("solver_")) return `solver ${type.replace(/^solver_/, "")}`;
  if (type.startsWith("phase_")) return `phase ${event.phase || "unknown"}`;
  if (type.startsWith("dag_node_")) return `dag ${event.nodeId || event.phase || "unknown"}`;
  if (type.startsWith("agent_routing_")) return `routing ${event.phase || "unknown"}`;
  if (type === "scheduler_decision_applied") return "scheduler decision";
  if (type === "provider_handoff") return `provider handoff ${event.from || "unknown"} -> ${event.to || "unknown"}`;
  if (type === "external_evaluation_recorded") return `external evaluation ${event.evaluator || "unknown"}`;
  if (type === "candidate_clean_replay") return "candidate clean replay";
  if (type === "candidate_identity_checked") return "candidate identity check";
  if (type === "agent_execution_policy") return `execution policy ${event.phase || "unknown"}`;
  if (type === "tool_call") return `tool ${event.title || event.toolName || event.toolCallId || event.kind || "unknown"}`;
  if (type === "completion_gate_evaluated") return "completion gate";
  if (type === "artifact_created") return `artifact ${event.artifactKind || event.kind || "unknown"}`;
  return type || "event";
}

function spanKind(event: EventRecord) {
  const type = text(event.type);
  if (type.startsWith("job_")) return "job";
  if (type === "retry_decision" || ["phase_retry", "phase_feedback_retry", "phase_quality_retry", "phase_agent_fallback", "dag_node_retrying"].includes(type)) return "retry";
  if (type.startsWith("solver_")) return "solver";
  if (type.startsWith("phase_")) return "phase";
  if (type.startsWith("dag_node_")) return "dag_node";
  if (type.startsWith("agent_routing_")) return "routing";
  if (type === "scheduler_decision_applied") return "scheduler";
  if (type === "provider_handoff") return "provider_handoff";
  if (type === "external_evaluation_recorded") return "external_evaluation";
  if (type === "candidate_clean_replay" || type === "candidate_identity_checked") return "candidate";
  if (type === "agent_execution_policy") return "execution_policy";
  if (type === "tool_call") return "tool";
  if (type === "completion_gate_evaluated") return "guardrail";
  if (type === "artifact_created") return "artifact";
  if (type === "permission_denied" || type === "runtime_failure") return "runtime";
  return "event";
}

function eventAttributes(event: EventRecord) {
  const attrs: LooseRecord = {};
  const usage = recordValue(event.usage);
  const failure = recordValue(event.failure);
  const executionPolicy = recordValue(event.executionPolicy);

  if (event.project) attrs["project"] = event.project;
  if (event.jobId) attrs["job.id"] = event.jobId;
  if (event.task) attrs["task"] = event.task;
  if (event.assignmentId) attrs["assignment.id"] = event.assignmentId;
  if (event.attemptId) attrs["attempt.id"] = event.attemptId;
  if (event.attempt !== undefined) attrs["attempt.number"] = event.attempt;
  if (event.iteration !== undefined) attrs["iteration"] = event.iteration;
  if (event.candidateId !== undefined) attrs["candidate.id"] = event.candidateId;
  if (event.phase) attrs["phase"] = event.phase;
  if (event.role) attrs["role"] = event.role;
  if (event.agent) attrs["llm.agent"] = event.agent;
  if (event.promptArtifact) attrs["prompt.artifact"] = event.promptArtifact;
  if (event.acpAuditFile) attrs["acp.audit_file"] = event.acpAuditFile;
  if (event.artifact) attrs["artifact"] = event.artifact;
  if (event.toolCallId) attrs["tool.id"] = event.toolCallId;
  if (event.title || event.toolName) attrs["tool.name"] = event.title || event.toolName;
  if (event.kind) attrs["tool.kind"] = event.kind;
  if (event.serverName) attrs["tool.server"] = event.serverName;
  if (event.sessionId) attrs["acp.session.id"] = event.sessionId;
  if (event.auditIndex !== undefined) attrs["acp.audit_index"] = event.auditIndex;
  if (Object.keys(executionPolicy).length > 0) {
    attrs["execution.codex_sandbox_mode"] = executionPolicy.codexSandboxMode ?? null;
    attrs["execution.effective_sandbox_mode"] = executionPolicy.effectiveSandboxMode ?? null;
    attrs["execution.sandbox_enforcement"] = executionPolicy.sandboxEnforcement ?? null;
    attrs["execution.codex_approval_policy"] = executionPolicy.codexApprovalPolicy ?? null;
    attrs["execution.outer_sandbox_mode"] = executionPolicy.outerSandboxMode ?? null;
    attrs["execution.outer_sandbox_provider"] = executionPolicy.outerSandboxProvider ?? null;
    attrs["execution.outer_workspace_writable"] = executionPolicy.outerWorkspaceWritable ?? null;
    attrs["execution.outer_write_root_count"] = executionPolicy.outerWriteRootCount ?? null;
  }
  if (event.action) attrs["action"] = event.action;
  if (event.reason) attrs["reason"] = event.reason;
  if (event.retryPhase) attrs["retry.phase"] = event.retryPhase;
  if (event.failureFingerprint) attrs["failure.fingerprint"] = event.failureFingerprint;
  if (event.failureClass) attrs["failure.class"] = event.failureClass;
  if (event.failureEvidence) attrs["failure.evidence"] = event.failureEvidence;
  if (event.retryStrategy) attrs["retry.strategy"] = event.retryStrategy;
  if (event.strategyChanged !== undefined) attrs["retry.strategy_changed"] = event.strategyChanged === true;
  if (event.forceFreshSession !== undefined) attrs["retry.force_fresh_session"] = event.forceFreshSession === true;
  if (event.failureKind) attrs["failure.kind"] = event.failureKind;
  if (event.gateOutcome) attrs["completion.outcome"] = event.gateOutcome;
  if (event.targetChecklistIds) attrs["checklist.targets"] = event.targetChecklistIds;
  if (event.fixScope) attrs["fix.scope"] = event.fixScope;
  if (event.strategy) attrs["retry.strategy"] = event.strategy;
  if (event.resultCandidateId) attrs["candidate.result_id"] = event.resultCandidateId;
  if (event.identityHash) attrs["candidate.identity_hash"] = event.identityHash;
  if (event.patchHash) attrs["candidate.patch_hash"] = event.patchHash;
  if (event.expectedTreeHash) attrs["candidate.expected_tree_hash"] = event.expectedTreeHash;
  if (event.actualTreeHash) attrs["candidate.actual_tree_hash"] = event.actualTreeHash;
  if (event.expectedIdentityHash) attrs["candidate.expected_identity_hash"] = event.expectedIdentityHash;
  if (event.actualIdentityHash) attrs["candidate.actual_identity_hash"] = event.actualIdentityHash;
  if (event.bundleHash) attrs["candidate.bundle_hash"] = event.bundleHash;
  if (event.patchSha256) attrs["candidate.patch_sha256"] = event.patchSha256;
  if (event.replayMethod) attrs["candidate.replay_method"] = event.replayMethod;
  if (event.cleanApply !== undefined) attrs["candidate.clean_apply"] = event.cleanApply === true;
  if (event.matches !== undefined) attrs["candidate.identity_matches"] = event.matches === true;
  if (event.type === "retry_decision") attrs["retry.action"] = event.action || null;
  if (event.type === "scheduler_decision_applied") {
    attrs["scheduler.mode"] = event.mode || null;
    attrs["scheduler.rank"] = event.rank ?? null;
    attrs["scheduler.score"] = event.score ?? null;
    attrs["scheduler.reasons"] = Array.isArray(event.reasons) ? event.reasons : [];
    attrs["retry.strategy"] = event.retryStrategy || null;
    attrs["failure.fingerprint"] = event.failureFingerprint || null;
  }
  if (event.type === "provider_handoff") {
    attrs["provider.from"] = event.from || null;
    attrs["provider.to"] = event.to || null;
    attrs["provider.handoff_kind"] = event.handoffKind || null;
    attrs["provider.status"] = event.status || null;
    attrs["provider.mid_run"] = event.midRun === true;
  }
  if (event.type === "external_evaluation_recorded") {
    attrs["external.evaluator"] = event.evaluator || null;
    attrs["external.status"] = event.status || null;
    attrs["external.candidate_identity_hash"] = event.candidateIdentityHash || null;
    attrs["external.summary"] = event.summary || null;
    attrs["external.checks"] = Array.isArray(event.checks) ? event.checks : [];
  }
  if (event.type === "completion_gate_evaluated") {
    const completionReport = recordValue(event.completionReport);
    const candidateValidation = recordValue(completionReport.candidateValidation);
    attrs["completion.missing_gates"] = Array.isArray(event.missingGates) ? event.missingGates : [];
    attrs["completion.commands"] = Array.isArray(completionReport.commands) ? completionReport.commands : [];
    attrs["completion.changed_files"] = Array.isArray(completionReport.changedFiles) ? completionReport.changedFiles : [];
    if (candidateValidation.identityHash) attrs["candidate.identity_hash"] = candidateValidation.identityHash;
    if (candidateValidation.patchHash) attrs["candidate.patch_hash"] = candidateValidation.patchHash;
    if (candidateValidation.treeHash) attrs["candidate.expected_tree_hash"] = candidateValidation.treeHash;
    const cleanReplay = recordValue(candidateValidation.cleanReplay);
    if (cleanReplay.replayMethod) attrs["candidate.replay_method"] = cleanReplay.replayMethod;
    if (cleanReplay.cleanApply !== undefined) attrs["candidate.clean_apply"] = cleanReplay.cleanApply === true;
  }
  if (text(event.type).startsWith("agent_routing_")) {
    if (event.preferredAgent !== undefined) attrs["routing.preferred_agent"] = event.preferredAgent ?? null;
    if (event.selectedAgent !== undefined) attrs["routing.selected_agent"] = event.selectedAgent ?? null;
    if (event.finalAgent !== undefined) attrs["routing.final_agent"] = event.finalAgent ?? null;
    if (event.providerKey !== undefined) attrs["routing.provider_key"] = event.providerKey ?? null;
    if (event.taskCategory !== undefined) attrs["routing.task_category"] = event.taskCategory ?? null;
    if (event.selectionSource !== undefined) attrs["routing.selection_source"] = event.selectionSource ?? null;
    if (event.outcomeApplied !== undefined) attrs["routing.outcome_applied"] = event.outcomeApplied === true;
    if (event.outcomeReason !== undefined) attrs["routing.outcome_reason"] = event.outcomeReason ?? null;
    if (event.fallbackApplied !== undefined) attrs["routing.fallback_applied"] = event.fallbackApplied === true;
    if (event.fallbackCount !== undefined) attrs["routing.fallback_count"] = event.fallbackCount ?? 0;
    if (event.independenceApplied !== undefined) attrs["routing.independence_applied"] = event.independenceApplied === true;
    if (event.independenceConflict !== undefined) attrs["routing.independence_conflict"] = event.independenceConflict === true;
    if (event.excludedProviderFamily !== undefined) attrs["routing.excluded_provider_family"] = event.excludedProviderFamily ?? null;
    if (event.metricsUnavailableReason !== undefined) attrs["routing.metrics_unavailable_reason"] = event.metricsUnavailableReason ?? null;
    if (event.candidates !== undefined) attrs["routing.candidates"] = Array.isArray(event.candidates) ? event.candidates : [];
    if (event.thresholds !== undefined) attrs["routing.thresholds"] = recordValue(event.thresholds);
    if (event.failureKind !== undefined) attrs["routing.failure_kind"] = event.failureKind ?? null;
    if (event.status !== undefined) attrs["routing.final_status"] = event.status ?? null;
  }
  if (usage.inputTokens !== undefined) attrs["llm.usage.input_tokens"] = usage.inputTokens;
  if (usage.cachedInputTokens !== undefined) attrs["llm.usage.cached_input_tokens"] = usage.cachedInputTokens;
  if (usage.outputTokens !== undefined) attrs["llm.usage.output_tokens"] = usage.outputTokens;
  if (usage.reasoningOutputTokens !== undefined) attrs["llm.usage.reasoning_output_tokens"] = usage.reasoningOutputTokens;
  if (usage.totalTokens !== undefined) attrs["llm.usage.total_tokens"] = usage.totalTokens;
  if (usage.tokenSource !== undefined) attrs["llm.usage.token_source"] = usage.tokenSource;
  if (usage.toolCalls !== undefined) attrs["llm.usage.tool_calls"] = usage.toolCalls;
  if (usage.functionCalls !== undefined) attrs["llm.usage.function_calls"] = usage.functionCalls;
  if (usage.costUsd !== undefined) attrs["llm.cost_usd"] = usage.costUsd;
  if (failure.kind) attrs["failure.kind"] = failure.kind;
  if (failure.reason) attrs["failure.reason"] = failure.reason;
  return attrs;
}

function createSpan(event: EventRecord): TraceSpan {
  return {
    traceId: text(event.traceId),
    spanId: text(event.spanId),
    parentSpanId: stringOrNull(event.parentSpanId),
    name: spanName(event),
    kind: spanKind(event),
    status: eventStatus(event),
    startedAt: stringOrNull(event.ts),
    endedAt: isEndEvent(event) ? stringOrNull(event.ts) : null,
    durationMs: null,
    attributes: eventAttributes(event),
    events: [event],
    children: [],
  };
}

function mergeSpan(span: TraceSpan, event: EventRecord) {
  span.events.push(event);
  span.name = spanName(event) || span.name;
  span.kind = span.kind || spanKind(event);
  span.attributes = { ...span.attributes, ...eventAttributes(event) };
  const status = eventStatus(event);
  if (status) span.status = status;
  const eventTs = stringOrNull(event.ts);
  if (eventTs && (!span.startedAt || eventTs < span.startedAt)) span.startedAt = eventTs;
  if (eventTs && isEndEvent(event) && (!span.endedAt || eventTs > span.endedAt)) span.endedAt = eventTs;
  span.durationMs = millisBetween(span.startedAt, span.endedAt);
}

function absorbEvent(spansById: Map<string, TraceSpan>, event: EventRecord) {
  const spanId = text(event.spanId);
  if (!spanId) return;
  const current = spansById.get(spanId);
  if (current) mergeSpan(current, event);
  else spansById.set(spanId, createSpan(event));
}

function rememberAuditReference(
  references: Map<string, AuditReference>,
  event: EventRecord,
) {
  const file = text(event.acpAuditFile).trim();
  if (!file) return;
  const phase = stringOrNull(event.phase);
  const role = stringOrNull(event.role);
  const fallbackTs = stringOrNull(event.ts);
  const assignmentId = stringOrNull(event.assignmentId);
  const attemptId = stringOrNull(event.attemptId);
  const iteration = event.iteration ?? null;
  const candidateId = event.candidateId ?? null;
  const key = `${file}\0${phase || ""}\0${assignmentId || ""}\0${attemptId || ""}\0${text(iteration)}\0${text(candidateId)}`;
  if (!references.has(key)) {
    references.set(key, { file, phase, role, fallbackTs, assignmentId, attemptId, iteration, candidateId });
  }
}

async function readAuditTraceEvents(
  reference: AuditReference,
  defaults: { project: string; jobId: string },
): Promise<EventRecord[]> {
  let raw: string;
  try {
    raw = await readFile(reference.file, "utf8");
  } catch {
    return [];
  }

  const events: EventRecord[] = [];
  let toolIndex = 0;
  const toolDetails = new Map<string, LooseRecord>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    if (parsed.event === "agent_launch") {
      const phase = stringOrNull(parsed.phase) || reference.phase;
      events.push(withTraceContext({
        type: "agent_execution_policy",
        project: stringOrNull(parsed.project) || defaults.project,
        jobId: stringOrNull(parsed.jobId) || defaults.jobId,
        phase,
        role: stringOrNull(parsed.role) || reference.role,
        agent: parsed.agent,
        assignmentId: parsed.assignmentId ?? reference.assignmentId,
        attemptId: parsed.attemptId ?? reference.attemptId,
        iteration: parsed.iteration ?? reference.iteration,
        candidateId: parsed.candidateId ?? reference.candidateId,
        executionPolicy: parsed.executionPolicy,
        acpAuditFile: reference.file,
        auditIndex: 0,
        ts: stringOrNull(parsed.ts) || reference.fallbackTs,
      }, defaults) as EventRecord);
      continue;
    }
    if (parsed.event !== "tool_call") continue;

    toolIndex += 1;
    const phase = stringOrNull(parsed.phase) || reference.phase;
    const toolCallId = stringOrNull(parsed.toolCallId) || `audit-tool-${toolIndex}`;
    const prior = toolDetails.get(toolCallId) || {};
    const resolved = {
      title: stringOrNull(parsed.title) || stringOrNull(prior.title) || null,
      kind: stringOrNull(parsed.kind) || stringOrNull(prior.kind) || null,
      serverName: stringOrNull(parsed.serverName) || stringOrNull(prior.serverName) || null,
      toolName: stringOrNull(parsed.toolName) || stringOrNull(prior.toolName) || null,
    };
    toolDetails.set(toolCallId, resolved);
    const title = resolved.title || resolved.toolName || toolCallId || "tool";
    events.push(withTraceContext({
      ...parsed,
      type: "tool_call",
      project: stringOrNull(parsed.project) || defaults.project,
      jobId: stringOrNull(parsed.jobId) || defaults.jobId,
      phase,
      role: stringOrNull(parsed.role) || reference.role,
      assignmentId: parsed.assignmentId ?? reference.assignmentId,
      attemptId: parsed.attemptId ?? reference.attemptId,
      iteration: parsed.iteration ?? reference.iteration,
      candidateId: parsed.candidateId ?? reference.candidateId,
      toolCallId,
      title,
      kind: resolved.kind,
      serverName: resolved.serverName,
      toolName: resolved.toolName,
      acpAuditFile: reference.file,
      auditIndex: toolIndex,
      ts: stringOrNull(parsed.ts) || reference.fallbackTs,
    }, defaults) as EventRecord);
  }
  return events;
}

function sortSpans(spans: TraceSpan[]) {
  return spans.sort((a, b) => {
    const left = a.startedAt || "";
    const right = b.startedAt || "";
    if (left !== right) return left.localeCompare(right);
    return a.spanId.localeCompare(b.spanId);
  });
}

export async function buildJobTrace({ cpbRoot, project, jobId, dataRoot = null }: BuildJobTraceInput): Promise<JobTrace> {
  const readOptions = dataRoot ? { dataRoot, includeLegacyFallback: false } : {};
  const rawEvents = await readEvents(cpbRoot, project, jobId, readOptions);
  const spansById = new Map<string, TraceSpan>();
  const auditReferences = new Map<string, AuditReference>();

  for (const [eventIndex, rawEvent] of rawEvents.entries()) {
    const event = withTraceContext({ ...rawEvent, traceSequence: eventIndex + 1 }, { project, jobId }) as EventRecord;
    rememberAuditReference(auditReferences, event);
    absorbEvent(spansById, event);
  }

  for (const reference of auditReferences.values()) {
    const auditEvents = await readAuditTraceEvents(reference, { project, jobId });
    for (const event of auditEvents) absorbEvent(spansById, event);
  }

  const rootSpanId = `job:${jobId}`;
  if (!spansById.has(rootSpanId)) {
    spansById.set(rootSpanId, {
      traceId: jobId,
      spanId: rootSpanId,
      parentSpanId: null,
      name: `job ${jobId}`,
      kind: "job",
      status: null,
      startedAt: null,
      endedAt: null,
      durationMs: null,
      attributes: { project, "job.id": jobId },
      events: [],
      children: [],
    });
  }

  const spans = sortSpans([...spansById.values()]);
  for (const span of spans) span.children = [];
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    const parent = spansById.get(span.parentSpanId);
    if (parent) parent.children.push(span);
  }
  for (const span of spans) sortSpans(span.children);

  return {
    traceId: jobId,
    project,
    jobId,
    root: spansById.get(rootSpanId)!,
    spans,
  };
}

function formatDuration(durationMs: number | null) {
  return durationMs === null ? "" : ` ${durationMs}ms`;
}

function formatSpan(span: TraceSpan, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  const status = span.status ? ` ${span.status}` : "";
  const correlations = [
    ["assignment", span.attributes["assignment.id"]],
    ["attempt", span.attributes["attempt.id"] ?? span.attributes["attempt.number"]],
    ["iteration", span.attributes["iteration"]],
    ["candidate", span.attributes["candidate.id"]],
  ].filter((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== "");
  const correlationText = correlations.length > 0
    ? ` [${correlations.map(([key, value]) => `${key}=${String(value)}`).join(" ")}]`
    : "";
  const line = `${indent}- ${span.name}${status}${formatDuration(numberOrNull(span.durationMs))}${correlationText}`;
  return [line, ...span.children.flatMap((child) => formatSpan(child, depth + 1))];
}

export function formatTraceHuman(trace: JobTrace) {
  return [
    `Trace ${trace.traceId} project=${trace.project} job=${trace.jobId}`,
    ...formatSpan(trace.root),
  ].join("\n");
}
