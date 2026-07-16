/**
 * Completion Gate — deterministic gate evaluation before a job may complete.
 *
 * A mutating durable job MUST pass all required verification gates before
 * it is allowed to reach "completed" status.  This module is pure logic —
 * no I/O, no side effects, no external dependencies.
 */

import { evaluateChecklistCompletion } from "../workflow/acceptance-checklist.js";

const VERDICT_RE = /^VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i
type ParsedVerdict = { status: "pass" | "fail"; raw?: string } | null;
import { recordValue, type LooseRecord } from "../contracts/types.js";
type CompletionGateJob = {
  workflow?: string | null;
  planMode?: string | null;
  completedPhases?: string[];
};
type WorkflowDag = {
  nodes?: Array<{ id?: string | null; phase?: string | null }>;
};
type RiskMap = {
  adversarialRequired?: boolean;
};
type EvidenceRef = LooseRecord & {
  ledgerId?: string;
  evidenceId?: string;
  attemptId?: string;
};
type ChecklistCompletionResult = LooseRecord & {
  outcome?: string | null;
  reason?: string | null;
  attemptId?: string | null;
  failedChecklistIds?: string[];
  uncheckedChecklistIds?: string[];
  missingEvidenceRefs?: EvidenceRef[];
  mismatchedEvidenceRefs?: EvidenceRef[];
  staleEvidenceRefs?: EvidenceRef[];
  poisonedEvidenceRefs?: EvidenceRef[];
  pollutedEvidenceRefs?: EvidenceRef[];
  pollutedOracleFiles?: string[];
  runtimeFailureRefs?: EvidenceRef[];
  unmappedChangedFiles?: string[];
};
type CompletionGateDetails = LooseRecord & {
  isMutating: boolean;
  dagPhases: string[];
  completedPhases: string[];
  adversarialRequired: boolean;
  checklist?: ChecklistCompletionResult;
};
export type CompletionGateResult = {
  outcome: string;
  reason: string;
  missingGates: string[];
  details: CompletionGateDetails;
  attemptId?: string | null;
};
type CompletionGateEventInput = {
  outcome?: string;
  reason?: string;
  missingGates?: string[];
  details?: LooseRecord & { checklist?: ChecklistCompletionResult };
  attemptId?: string | null;
};
type CompletionGateEventOptions = {
  completionReport?: LooseRecord | null;
};

/**
 * Parse a verdict string looking for the canonical `VERDICT: <STATUS>` line.
 * Falls back to JSON extraction: { "verdict": "pass"|"fail" }.
 *
 * @param {string|null|undefined} verdictText
 * @returns {{ status: "pass"|"fail", raw: string }|null}
 */
export function parseVerdict(verdictText: unknown): ParsedVerdict {
  if (verdictText && typeof verdictText === "object") {
    const obj = recordValue(verdictText);
    const raw = String(obj.verdict || obj.status || "").toUpperCase()
    if (raw === "PASS") return { status: "pass", raw }
    if (raw === "FAIL" || raw === "PARTIAL") return { status: "fail", raw }
  }

  if (typeof verdictText !== "string" || !verdictText.trim()) return null

  // 1. Canonical VERDICT: <STATUS> line (first 10 lines)
  const lines = verdictText.split(/\r?\n/).slice(0, 10)
  for (const line of lines) {
    const match = line.match(VERDICT_RE)
    if (!match) continue
    const raw = match[1].toUpperCase()
    return {
      status: raw === "PASS" ? "pass" : "fail",
      raw,
    }
  }

  // 2. JSON fallback — extract { "verdict": "pass"|"fail" } from envelope
  try {
    const obj = JSON.parse(verdictText)
    const v = (obj.verdict || "").toString().toLowerCase()
    if (v === "pass" || v === "fail") {
      return { status: v, raw: v.toUpperCase() }
    }
  } catch {
    // not JSON — give up
  }

  return null
}

/**
 * Return true if the job's workflow/planMode indicates it modifies code.
 * `parent` and `none` modes are exempt — the spec says they must not
 * produce completed mutating jobs.
 *
 * @param {{ workflow?: string, planMode?: string }} job
 * @returns {boolean}
 */
export function isMutatingJob(job: CompletionGateJob | null | undefined): boolean {
  if (!job) return false
  const mode = job.planMode
  if (mode === "parent" || mode === "none") return false
  // Explicitly non-mutating workflows (docs-only, read-only) skip verify gate
  const workflow = job.workflow
  if (workflow === "docs" || workflow === "readonly") return false
  return true
}

/**
 * Evaluate all completion gates for a job and return the first failing
 * outcome, or `"complete"` if every required gate passed.
 *
 * Gate evaluation order (first failure short-circuits):
 *   1. policy_invalid          — mutating DAG missing verify node
 *   2. verification_incomplete — verify phase never ran
 *   3. artifact_invalid        — verdict artifact absent / unparseable
 *   4. verification_failed     — verdict status ≠ pass
 *   5. adversarial_incomplete  — adversarial required but never ran
 *   6. adversarial_failed      — adversarial verdict status ≠ pass
 *   7. complete                — all gates passed
 *
 * @param {object} args
 * @param {object}          args.job               — job record (workflow, planMode, completedPhases)
 * @param {object}          [args.workflowDag]     — resolved DAG for this run
 * @param {object}          [args.riskMap]         — risk-map from prepare_task
 * @param {object}          [args.dynamicAgentPlan]
 * @param {object}          [args.artifactIndex]   — artifacts collected during run
 * @param {object|null}     [args.parsedVerdict]          — pre-parsed verify verdict
 * @param {object|null}     [args.parsedAdversarialVerdict] — pre-parsed adversarial verdict
 * @returns {{ outcome: string, reason: string, missingGates: string[], details: object }}
 */
export function evaluateCompletionGate({
  job,
  workflowDag,
  riskMap,
  dynamicAgentPlan,
  artifactIndex,
  parsedVerdict,
  parsedAdversarialVerdict,
  checklist,
  checklistVerdict,
  evidenceLedger,
  executionMap,
  runtimeFailures,
  attemptId,
  multiAttempt,
}: {
  job?: CompletionGateJob;
  workflowDag?: WorkflowDag;
  riskMap?: RiskMap;
  dynamicAgentPlan?: LooseRecord;
  artifactIndex?: LooseRecord;
  parsedVerdict?: ParsedVerdict;
  parsedAdversarialVerdict?: ParsedVerdict;
  checklist?: LooseRecord;
  checklistVerdict?: LooseRecord;
  evidenceLedger?: LooseRecord;
  executionMap?: LooseRecord;
  runtimeFailures?: LooseRecord[];
  attemptId?: string;
  multiAttempt?: boolean;
} = {}): CompletionGateResult {
  const completedPhases = new Set(job?.completedPhases || [])
  const dagNodes = Array.isArray(workflowDag?.nodes) ? workflowDag.nodes : []
  const dagPhases = new Set(dagNodes.map((n) => n.phase || n.id).filter((phase): phase is string => Boolean(phase)))
  const details: CompletionGateDetails = {
    isMutating: isMutatingJob(job),
    dagPhases: [...dagPhases],
    completedPhases: [...completedPhases],
    adversarialRequired: Boolean(riskMap?.adversarialRequired),
  }

  // Checklist gate — evaluate before legacy verdict gates when checklist artifacts exist.
  // Legacy verdict fallback is only for jobs without an acceptance-checklist artifact.
  if (checklist) {
    const checklistResult = evaluateChecklistCompletion({
      checklist,
      verdict: checklistVerdict,
      evidenceLedger,
      executionMap,
      runtimeFailures,
      attemptId,
      multiAttempt,
    });
    if (checklistResult.outcome !== "complete") {
      return gateResult(checklistResult.outcome || "checklist_invalid", checklistResult.reason || "checklist completion failed", ["checklist"], {
        ...details,
        checklist: checklistResult,
      });
    }
  }

  // Gate 1 — policy: mutating job MUST have verify in DAG
  if (details.isMutating && !dagPhases.has("verify")) {
    return gateResult(
      "policy_invalid",
      "Mutating durable job has no verify node in its DAG",
      ["verify"],
      details,
    )
  }

  // Gate 2 — verify phase must have completed
  if (details.isMutating && !completedPhases.has("verify")) {
    return gateResult(
      "verification_incomplete",
      "Verify phase has not completed",
      ["verify"],
      details,
    )
  }

  // Gate 3 — verdict artifact must be parseable (only when verify is required)
  if (details.isMutating && parsedVerdict == null) {
    return gateResult(
      "artifact_invalid",
      "Verdict artifact is missing or unparseable",
      ["verdict_artifact"],
      details,
    )
  }

  // Gate 4 — verdict status must be pass
  if (details.isMutating && parsedVerdict?.status !== "pass") {
    return gateResult(
      "verification_failed",
      `Verify verdict is '${parsedVerdict?.status || "unknown"}', expected 'pass'`,
      [],
      details,
    )
  }

  // Gate 5 — adversarial verify must have run when required
  if (riskMap?.adversarialRequired === true && !completedPhases.has("adversarial_verify")) {
    return gateResult(
      "adversarial_incomplete",
      "Adversarial verify was required but has not completed",
      ["adversarial_verify"],
      details,
    )
  }

  // Gate 6 — adversarial verdict must be pass
  if (riskMap?.adversarialRequired === true && completedPhases.has("adversarial_verify")) {
    if (parsedAdversarialVerdict == null) {
      return gateResult(
        "artifact_invalid",
        "Adversarial verdict artifact is missing or unparseable",
        ["adversarial_verdict_artifact"],
        details,
      )
    }
    if (parsedAdversarialVerdict.status !== "pass") {
      return gateResult(
        "adversarial_failed",
        `Adversarial verdict is '${parsedAdversarialVerdict.status}', expected 'pass'`,
        [],
        details,
      )
    }
  }

  // Gate 7 — all clear
  return gateResult(
    "complete",
    "All required completion gates passed",
    [],
    details,
  )
}

/**
 * Build a structured event suitable for appending to the event store.
 *
 * @param {string} jobId
 * @param {string} project
 * @param {{ outcome: string, reason: string, missingGates: string[] }} gateResult
 * @returns {object}
 */
export function completionGateEvent(
  jobId: string,
  project: string,
  gateResult: CompletionGateEventInput,
  { completionReport = null }: CompletionGateEventOptions = {},
) {
  const checklist = gateResult.details?.checklist || {};
  const event = {
    type: "completion_gate_evaluated",
    jobId,
    project,
    attemptId: gateResult.attemptId || checklist.attemptId || null,
    outcome: gateResult.outcome,
    reason: gateResult.reason,
    missingGates: gateResult.missingGates,
    checklistOutcome: checklist.outcome || null,
    failedChecklistIds: checklist.failedChecklistIds || [],
    uncheckedChecklistIds: checklist.uncheckedChecklistIds || [],
    missingEvidenceRefs: checklist.missingEvidenceRefs || [],
    mismatchedEvidenceRefs: checklist.mismatchedEvidenceRefs || [],
    staleEvidenceRefs: checklist.staleEvidenceRefs || [],
    poisonedEvidenceRefs: checklist.poisonedEvidenceRefs || [],
    pollutedEvidenceRefs: checklist.pollutedEvidenceRefs || [],
    pollutedOracleFiles: checklist.pollutedOracleFiles || [],
    pollutedOracleFileCount: Array.isArray(checklist.pollutedOracleFiles) ? checklist.pollutedOracleFiles.length : 0,
    runtimeFailureRefs: checklist.runtimeFailureRefs || [],
    runtimeFailureCount: Array.isArray(checklist.runtimeFailureRefs) ? checklist.runtimeFailureRefs.length : 0,
    unmappedChangedFiles: checklist.unmappedChangedFiles || [],
    unmappedChangedFileCount: Array.isArray(checklist.unmappedChangedFiles) ? checklist.unmappedChangedFiles.length : 0,
    ts: new Date().toISOString(),
  };
  return completionReport ? { ...event, completionReport } : event;
}

// ─── Internal ─────────────────────────────────────────────────────────

function gateResult(outcome: string, reason: string, missingGates: string[], details: CompletionGateDetails): CompletionGateResult {
  return { outcome, reason, missingGates, details }
}
