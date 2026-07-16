import { readFile } from "node:fs/promises";

import { isRecord, recordValue, type LooseRecord } from "../../../core/contracts/types.js";
import {
  validateCandidateReplayBundle,
  type CandidateReplayBundle,
} from "../../../core/engine/candidate-replay.js";
import { appendEvent } from "../event/event-store.js";
import { buildArtifactIndex } from "../job/job-projection.js";
import { buildJobTrace, type JobTrace, type TraceSpan } from "./trace-log.js";

export type ExternalEvaluationStatus = "passed" | "failed" | "inconclusive";

export type ExternalEvaluationInput = {
  evaluator: string;
  status: ExternalEvaluationStatus;
  candidateIdentityHash?: string | null;
  summary?: string | null;
  checks?: LooseRecord[];
};

type BuildJobReplayInput = {
  cpbRoot: string;
  project: string;
  jobId: string;
  dataRoot?: string | null;
  includePatch?: boolean;
};

function text(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function boundedText(value: unknown, maxChars: number) {
  return text(value).slice(0, maxChars);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
}

function normalizedChecks(value: unknown): LooseRecord[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).filter(isRecord).map((check) => ({
    name: boundedText(check.name || check.id || check.command, 500) || null,
    command: boundedText(check.command, 2000) || null,
    status: boundedText(check.status || check.result, 100) || null,
    reason: boundedText(check.reason || check.message || check.stderrTail, 4000) || null,
  }));
}

function validateExternalEvaluation(input: ExternalEvaluationInput) {
  const evaluator = boundedText(input.evaluator, 200);
  if (!evaluator) throw new Error("external evaluation requires a non-empty evaluator");
  if (!["passed", "failed", "inconclusive"].includes(input.status)) {
    throw new Error(`invalid external evaluation status: ${JSON.stringify(input.status)}`);
  }
  const candidateIdentityHash = text(input.candidateIdentityHash) || null;
  if (candidateIdentityHash && !/^sha256:[0-9a-f]{64}$/i.test(candidateIdentityHash)) {
    throw new Error("external evaluation candidateIdentityHash must be a sha256 digest");
  }
  return {
    evaluator,
    status: input.status,
    candidateIdentityHash,
    summary: boundedText(input.summary, 4000) || null,
    checks: normalizedChecks(input.checks),
  };
}

/**
 * Persist a post-completion evaluator result as audit evidence only. The
 * event is deliberately outside job materialization, routing, retry, prompt,
 * and completion-gate inputs so an external oracle cannot influence solving.
 */
export async function recordExternalEvaluation({
  cpbRoot,
  project,
  jobId,
  dataRoot = null,
  evaluation,
  now = () => new Date().toISOString(),
}: {
  cpbRoot: string;
  project: string;
  jobId: string;
  dataRoot?: string | null;
  evaluation: ExternalEvaluationInput;
  now?: () => string;
}) {
  const normalized = validateExternalEvaluation(evaluation);
  return appendEvent(cpbRoot, project, jobId, {
    type: "external_evaluation_recorded",
    jobId,
    project,
    ...normalized,
    ts: now(),
  }, dataRoot ? { dataRoot, includeLegacyFallback: false } : {});
}

function timelineFromTrace(trace: JobTrace) {
  const seen = new Set<string>();
  const timeline: LooseRecord[] = [];
  for (const span of trace.spans) {
    span.events.forEach((event, eventIndex) => {
      const key = [
        span.spanId,
        event.eventId,
        event.type,
        event.ts,
        event.auditIndex,
        eventIndex,
      ].map(text).join("|");
      if (seen.has(key)) return;
      seen.add(key);
      timeline.push({
        ts: event.ts || span.startedAt || null,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        kind: span.kind,
        type: event.type || null,
        status: event.status || span.status,
        phase: event.phase || span.attributes.phase || null,
        attemptId: text(event.attemptId || span.attributes["attempt.id"]) || null,
        iteration: event.iteration ?? span.attributes.iteration ?? null,
        candidateId: text(event.candidateId || span.attributes["candidate.id"]) || null,
        eventSequence: typeof event.traceSequence === "number" ? event.traceSequence : null,
        attributes: span.attributes,
        event,
      });
    });
  }
  return timeline.sort((left, right) => {
    const tsOrder = text(left.ts).localeCompare(text(right.ts));
    if (tsOrder !== 0) return tsOrder;
    return text(left.spanId).localeCompare(text(right.spanId));
  }).map((entry, sequence) => ({ sequence: sequence + 1, ...entry }));
}

function spanSummary(span: TraceSpan) {
  return {
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    status: span.status,
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    attributes: span.attributes,
  };
}

async function loadReplayBundle({
  cpbRoot,
  project,
  jobId,
  dataRoot,
  includePatch,
}: BuildJobReplayInput) {
  const index = await buildArtifactIndex(cpbRoot, project, jobId, dataRoot ? { dataRoot } : {});
  const entries = Array.isArray(index.entries) ? index.entries : [];
  const entry = [...entries].reverse().find((candidate) => (
    candidate.kind === "candidate-replay-bundle" && candidate.exists !== false && text(candidate.path)
  ));
  if (!entry?.path) return null;
  try {
    const parsed: unknown = JSON.parse(await readFile(entry.path, "utf8"));
    if (!isRecord(parsed)) return { artifact: entry, valid: false, reason: "candidate replay bundle is not an object" };
    const bundle = parsed as CandidateReplayBundle;
    const schemaValid = bundle.schemaVersion === 1
      && typeof bundle.baseSha === "string"
      && typeof bundle.expectedTreeHash === "string"
      && typeof bundle.candidateIdentityHash === "string"
      && typeof bundle.patchSha256 === "string"
      && typeof bundle.patchBytes === "number"
      && typeof bundle.bundleHash === "string"
      && typeof bundle.patch === "string";
    const validationReason = schemaValid ? validateCandidateReplayBundle(bundle) : "candidate replay bundle schema is invalid";
    const valid = validationReason === null;
    return {
      artifact: entry,
      valid,
      reason: validationReason,
      schemaVersion: bundle.schemaVersion ?? null,
      baseSha: bundle.baseSha ?? null,
      expectedTreeHash: bundle.expectedTreeHash ?? null,
      candidateIdentityHash: bundle.candidateIdentityHash ?? null,
      patchSha256: bundle.patchSha256 ?? null,
      patchBytes: bundle.patchBytes ?? null,
      bundleHash: bundle.bundleHash ?? null,
      ...(includePatch && valid ? { patch: bundle.patch } : {}),
    };
  } catch (error) {
    return {
      artifact: entry,
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function latestEvent(timeline: LooseRecord[], type: string) {
  const matches = timeline.filter((entry) => entry.type === type);
  if (matches.length === 0) return null;
  const latest = matches.reduce((current, candidate) => {
    const currentSequence = typeof current.eventSequence === "number" ? current.eventSequence : -1;
    const candidateSequence = typeof candidate.eventSequence === "number" ? candidate.eventSequence : -1;
    if (candidateSequence !== currentSequence) return candidateSequence > currentSequence ? candidate : current;
    return Number(candidate.sequence || 0) > Number(current.sequence || 0) ? candidate : current;
  });
  return recordValue(latest.event);
}

function looksLikeTestCommand(value: unknown) {
  const command = text(value).toLowerCase();
  if (!command) return false;
  return [
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/,
    /^(?:node|deno)\s+--test(?:\s|$)/,
    /^(?:python(?:\d+(?:\.\d+)*)?\s+-m\s+)?pytest(?:\s|$)/,
    /^(?:python(?:\d+(?:\.\d+)*)?\s+)?[^\s]*tests?\/runtests\.py(?:\s|$)/,
    /^(?:cargo|go|dotnet|mix|rake)\s+test(?:\s|$)/,
    /^(?:mvn|gradle|\.\/gradlew)\b.*\btest\b/,
  ].some((pattern) => pattern.test(command));
}

function traceHasTestExecution(trace: JobTrace) {
  return trace.spans.some((span) => {
    if (span.kind !== "tool") return false;
    const toolKind = text(span.attributes["tool.kind"]).toLowerCase();
    if (toolKind !== "terminal" && toolKind !== "execute") return false;
    return looksLikeTestCommand(span.attributes["tool.name"]);
  });
}

function evaluateDecisionBoundary(timeline: LooseRecord[]) {
  const completion = latestEvent(timeline, "completion_gate_evaluated");
  const external = latestEvent(timeline, "external_evaluation_recorded");
  const report = recordValue(completion?.completionReport);
  const candidate = recordValue(report.candidateValidation);
  const externalStatus = text(external?.status);
  const completionOutcome = text(completion?.outcome);
  if (!external) {
    return {
      classification: "external_evaluation_missing",
      boundary: null,
      reason: "no post-completion external evaluation is recorded",
      internalOutcome: completionOutcome || null,
      externalOutcome: null,
    };
  }

  const internalIdentity = text(candidate.identityHash) || null;
  const externalIdentity = text(external.candidateIdentityHash) || null;
  if (!completion) {
    return {
      classification: "internal_completion_missing",
      boundary: "completion_gate",
      reason: "an external evaluation exists but no internal completion decision is recorded",
      internalOutcome: null,
      externalOutcome: externalStatus || null,
    };
  }
  if (internalIdentity && externalIdentity && internalIdentity !== externalIdentity) {
    return {
      classification: "evaluation_lineage_mismatch",
      boundary: "candidate_identity",
      reason: "the external evaluator scored a different candidate identity",
      internalOutcome: completionOutcome || null,
      externalOutcome: externalStatus || null,
      internalCandidateIdentityHash: internalIdentity,
      externalCandidateIdentityHash: externalIdentity,
    };
  }

  if (completionOutcome === "complete" && externalStatus === "failed") {
    const internalCommands = stringList(report.commands);
    const externalChecks = normalizedChecks(external.checks);
    const missingExternalChecks = externalChecks
      .map((check) => text(check.command || check.name))
      .filter((check) => check && !internalCommands.includes(check));
    return {
      classification: missingExternalChecks.length > 0 ? "test_selection_gap" : "completion_false_positive",
      boundary: missingExternalChecks.length > 0 ? "verification_coverage" : "completion_gate",
      reason: missingExternalChecks.length > 0
        ? "external failing checks were absent from CPB verification evidence"
        : "CPB declared completion for the same candidate that the external evaluator rejected",
      internalOutcome: completionOutcome,
      externalOutcome: externalStatus,
      internalCandidateIdentityHash: internalIdentity,
      externalCandidateIdentityHash: externalIdentity,
      missingExternalChecks,
    };
  }
  if (completionOutcome !== "complete" && externalStatus === "passed") {
    return {
      classification: "completion_false_negative",
      boundary: "completion_gate",
      reason: "the external evaluator accepted a candidate that CPB did not complete",
      internalOutcome: completionOutcome || null,
      externalOutcome: externalStatus,
    };
  }
  return {
    classification: "decision_aligned",
    boundary: null,
    reason: "internal completion and external evaluation do not contradict each other",
    internalOutcome: completionOutcome || null,
    externalOutcome: externalStatus || null,
  };
}

function traceCoverage(trace: JobTrace, candidateBundle: LooseRecord | null) {
  const completion = trace.spans.find((span) => span.kind === "guardrail") || null;
  const hasPhase = trace.spans.some((span) => span.kind === "phase");
  const hasRepair = trace.spans.some((span) => span.kind === "retry" || span.kind === "solver");
  const completionCommands = completion && Array.isArray(completion.attributes["completion.commands"])
    ? completion.attributes["completion.commands"]
    : [];
  const stages = {
    task: { required: true, present: Boolean(trace.root.attributes.task) },
    routing: { required: hasPhase, present: trace.spans.some((span) => span.kind === "routing") },
    prompt: { required: hasPhase, present: trace.spans.some((span) => Boolean(span.attributes["prompt.artifact"])) },
    executionPolicy: {
      required: false,
      present: trace.spans.some((span) => span.kind === "execution_policy"),
    },
    toolCalls: {
      required: hasPhase,
      present: trace.spans.some((span) => span.kind === "tool")
        || trace.spans.some((span) => Boolean(span.attributes["acp.audit_file"])),
    },
    editsAndCandidate: {
      required: Boolean(completion),
      present: trace.spans.some((span) => span.kind === "candidate")
        || Boolean(completion?.attributes["candidate.identity_hash"])
        || Boolean(candidateBundle?.candidateIdentityHash),
    },
    tests: {
      required: Boolean(completion),
      present: completionCommands.length > 0
        || traceHasTestExecution(trace),
    },
    verifier: {
      required: Boolean(completion),
      present: trace.spans.some((span) => span.kind === "phase" && ["verify", "adversarial_verify"].includes(text(span.attributes.phase))),
    },
    repair: { required: hasRepair, present: hasRepair },
    completionGate: { required: true, present: Boolean(completion) },
    finalPatch: { required: Boolean(completion), present: candidateBundle?.valid === true },
  };
  const missing = Object.entries(stages)
    .filter(([, stage]) => stage.required && !stage.present)
    .map(([name]) => name);
  return { complete: missing.length === 0, missing, stages };
}

export async function buildJobReplay(input: BuildJobReplayInput) {
  const trace = await buildJobTrace(input);
  const timeline = timelineFromTrace(trace);
  const candidateBundle = await loadReplayBundle(input);
  return {
    schemaVersion: 1,
    traceId: trace.traceId,
    project: trace.project,
    jobId: trace.jobId,
    timeline,
    decisions: {
      routing: trace.spans.filter((span) => span.kind === "routing").map(spanSummary),
      retries: trace.spans.filter((span) => span.kind === "retry").map(spanSummary),
      providerHandoffs: trace.spans.filter((span) => span.kind === "provider_handoff").map(spanSummary),
      verification: trace.spans.filter((span) => span.kind === "phase" && ["verify", "adversarial_verify"].includes(text(span.attributes.phase))).map(spanSummary),
      completion: trace.spans.filter((span) => span.kind === "guardrail").map(spanSummary),
      externalEvaluations: trace.spans.filter((span) => span.kind === "external_evaluation").map(spanSummary),
    },
    candidateBundle,
    coverage: traceCoverage(trace, candidateBundle),
    decisionBoundary: evaluateDecisionBoundary(timeline),
  };
}

export function formatJobReplayHuman(replay: LooseRecord) {
  const boundary = recordValue(replay.decisionBoundary);
  const bundle = recordValue(replay.candidateBundle);
  const timeline = Array.isArray(replay.timeline) ? replay.timeline : [];
  const lines = [
    `Replay ${text(replay.traceId)} project=${text(replay.project)} job=${text(replay.jobId)}`,
    `Decision boundary: ${text(boundary.classification) || "unknown"}${boundary.boundary ? ` at ${text(boundary.boundary)}` : ""}`,
    `Reason: ${text(boundary.reason) || "none"}`,
  ];
  if (Object.keys(bundle).length > 0) {
    lines.push(`Candidate bundle: ${text(bundle.bundleHash) || "invalid"} patch=${text(bundle.patchSha256) || "unknown"} bytes=${String(bundle.patchBytes ?? "unknown")}`);
  }
  lines.push("Timeline:");
  for (const entryValue of timeline) {
    const entry = recordValue(entryValue);
    lines.push(`- #${String(entry.sequence ?? "?")} ${text(entry.ts) || "unknown-time"} ${text(entry.type) || text(entry.kind) || "event"}${entry.status ? ` ${text(entry.status)}` : ""}`);
  }
  return lines.join("\n");
}
