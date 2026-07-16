import { recordValue, type LooseRecord } from "../../../core/contracts/types.js";

type TraceDefaults = {
  project: string;
  jobId: string;
};

function cleanPart(value: unknown, fallback: string) {
  const text = String(value || fallback).trim();
  return text.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;
}

function phaseFor(event: LooseRecord) {
  return cleanPart(event.phase || "job", "job");
}

const RETRY_EVENT_TYPES = new Set([
  "retry_decision",
  "phase_retry",
  "phase_feedback_retry",
  "phase_quality_retry",
  "phase_agent_fallback",
  "dag_node_retrying",
]);

function optionalPart(value: unknown) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return cleanPart(value, "unknown");
}

function identitySuffix(event: LooseRecord, { includeIteration = true, includeCandidate = true } = {}) {
  const parts: string[] = [];
  const assignmentId = optionalPart(event.assignmentId);
  const attemptId = optionalPart(event.attemptId);
  const iteration = includeIteration ? optionalPart(event.iteration) : null;
  const candidateId = includeCandidate ? optionalPart(event.candidateId) : null;
  if (assignmentId) parts.push("assignment", assignmentId);
  if (attemptId) parts.push("attempt", attemptId);
  if (iteration) parts.push("iteration", iteration);
  if (candidateId) parts.push("candidate", candidateId);
  return parts.length > 0 ? `:${parts.join(":")}` : "";
}

function phaseSpanId(event: LooseRecord) {
  return `phase:${phaseFor(event)}${identitySuffix(event, { includeIteration: false, includeCandidate: false })}`;
}

function retrySpanId(event: LooseRecord) {
  const type = String(event.type || "retry_decision");
  const phase = phaseFor(event);
  if (type === "retry_decision" && !identitySuffix(event) && event.iteration === undefined && event.attempt === undefined) {
    const retryPhase = cleanPart(event.retryPhase || event.fromPhase || event.action || "retry", "retry");
    return `retry:${phase}:${retryPhase}`;
  }

  let suffix = identitySuffix(event);
  if (event.iteration === undefined) {
    const iteration = optionalPart(event.attempt ?? event.retryCount);
    if (iteration) suffix += `:iteration:${iteration}`;
  }
  if (!suffix && type === "phase_agent_fallback") {
    const handoff = optionalPart(`${event.fromAgent || "unknown"}-${event.toAgent || "unknown"}`);
    if (handoff) suffix = `:candidate:${handoff}`;
  }
  return `retry:${phase}:${cleanPart(type, "retry")}${suffix}`;
}

function solverSpanId(event: LooseRecord) {
  const type = String(event.type || "solver");
  const operation = type.replace(/_(?:started|completed|failed|blocked|cancelled|result)$/, "");
  return `solver:${phaseFor(event)}:${cleanPart(operation, "solver")}${identitySuffix(event)}`;
}

function providerHandoffSpanId(event: LooseRecord) {
  const phase = phaseFor(event);
  const from = cleanPart(event.from || "unknown", "unknown");
  const to = cleanPart(event.to || "unknown", "unknown");
  let suffix = identitySuffix(event, { includeIteration: false });
  const handoffAttempt = optionalPart(event.attempt);
  if (handoffAttempt) suffix += `:iteration:${handoffAttempt}`;
  return `provider:handoff:${phase}:${from}:${to}${suffix}`;
}

function spanForEvent(event: LooseRecord, defaults: TraceDefaults) {
  const type = String(event.type || "event");
  const phase = phaseFor(event);
  const scopedPhaseSpanId = phaseSpanId(event);
  const fullIdentitySuffix = identitySuffix(event);
  const nodeId = cleanPart(event.nodeId || phase, phase);
  const role = cleanPart(event.role || event.agent || "agent", "agent");
  const artifactKind = cleanPart(event.artifactKind || event.kind || "artifact", "artifact");
  const artifactId = cleanPart(event.artifactId || event.artifact || event.promptArtifact || type, type);
  const toolId = cleanPart(event.toolCallId || event.toolName || event.title || "tool", "tool");

  if (type.startsWith("job_")) {
    return { spanId: `job:${defaults.jobId}`, parentSpanId: null };
  }
  if (RETRY_EVENT_TYPES.has(type)) {
    return { spanId: retrySpanId(event), parentSpanId: scopedPhaseSpanId };
  }
  if (type.startsWith("solver_")) {
    return { spanId: solverSpanId(event), parentSpanId: event.phase ? scopedPhaseSpanId : `job:${defaults.jobId}` };
  }
  if (type.startsWith("phase_")) {
    return { spanId: scopedPhaseSpanId, parentSpanId: `job:${defaults.jobId}` };
  }
  if (type.startsWith("dag_node_")) {
    return { spanId: `dag:${nodeId}${fullIdentitySuffix}`, parentSpanId: scopedPhaseSpanId };
  }
  if (type.startsWith("agent_routing_")) {
    return { spanId: `routing:${phase}:${role}${fullIdentitySuffix}`, parentSpanId: scopedPhaseSpanId };
  }
  if (type === "scheduler_decision_applied") {
    return { spanId: `scheduler:decision${fullIdentitySuffix}`, parentSpanId: `job:${defaults.jobId}` };
  }
  if (type === "provider_handoff") {
    return { spanId: providerHandoffSpanId(event), parentSpanId: scopedPhaseSpanId };
  }
  if (type === "external_evaluation_recorded") {
    const evaluator = cleanPart(event.evaluator || "external", "external");
    const candidate = cleanPart(event.candidateIdentityHash || "unknown", "unknown");
    return { spanId: `external:evaluation:${evaluator}:${candidate}`, parentSpanId: `job:${defaults.jobId}` };
  }
  if (type === "candidate_clean_replay" || type === "candidate_identity_checked") {
    const operation = cleanPart(type.replace(/^candidate_/, ""), "candidate");
    const candidate = cleanPart(event.candidateId || event.identityHash || event.expectedIdentityHash || "unknown", "unknown");
    return { spanId: `candidate:${operation}:${candidate}${fullIdentitySuffix}`, parentSpanId: `job:${defaults.jobId}` };
  }
  if (type === "tool_call") {
    return { spanId: `tool:${phase}:${toolId}${fullIdentitySuffix}`, parentSpanId: scopedPhaseSpanId };
  }
  if (type === "agent_execution_policy") {
    return { spanId: `policy:${phase}${fullIdentitySuffix}`, parentSpanId: scopedPhaseSpanId };
  }
  if (type === "artifact_created") {
    return { spanId: `artifact:${artifactKind}:${artifactId}${fullIdentitySuffix}`, parentSpanId: event.phase ? scopedPhaseSpanId : `job:${defaults.jobId}` };
  }
  if (type === "completion_gate_evaluated") {
    return { spanId: `guardrail:completion_gate${fullIdentitySuffix}`, parentSpanId: `job:${defaults.jobId}` };
  }
  if (type === "runtime_failure" || type === "phase_poisoned_session" || type === "permission_denied") {
    return { spanId: `runtime:${type}:${phase}${fullIdentitySuffix}`, parentSpanId: event.phase ? scopedPhaseSpanId : `job:${defaults.jobId}` };
  }
  return { spanId: `event:${cleanPart(type, "event")}${fullIdentitySuffix}`, parentSpanId: event.phase ? scopedPhaseSpanId : `job:${defaults.jobId}` };
}

export function withTraceContext(event: unknown, defaults: TraceDefaults): LooseRecord {
  const record = recordValue(event);
  const traceId = typeof record.traceId === "string" && record.traceId.trim()
    ? record.traceId.trim()
    : defaults.jobId;
  const span = spanForEvent(record, defaults);
  return {
    ...record,
    traceId,
    spanId: typeof record.spanId === "string" && record.spanId.trim() ? record.spanId.trim() : span.spanId,
    parentSpanId: record.parentSpanId === undefined ? span.parentSpanId : record.parentSpanId,
  };
}
