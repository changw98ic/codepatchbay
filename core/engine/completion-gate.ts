// @ts-nocheck
/**
 * Completion Gate — deterministic gate evaluation before a job may complete.
 *
 * A mutating durable job MUST pass all required verification gates before
 * it is allowed to reach "completed" status.  This module is pure logic —
 * no I/O, no side effects, no external dependencies.
 */

const VERDICT_RE = /^VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i

/**
 * Parse a verdict string looking for the canonical `VERDICT: <STATUS>` line.
 * Falls back to JSON extraction: { "verdict": "pass"|"fail" }.
 *
 * @param {string|null|undefined} verdictText
 * @returns {{ status: "pass"|"fail", raw: string }|null}
 */
export function parseVerdict(verdictText) {
  if (verdictText && typeof verdictText === "object") {
    const raw = (verdictText.verdict || verdictText.status || "").toString().toUpperCase()
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
export function isMutatingJob(job) {
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
} = {}) {
  const completedPhases = new Set(job?.completedPhases || [])
  const dagNodes = Array.isArray(workflowDag?.nodes) ? workflowDag.nodes : []
  const dagPhases = new Set(dagNodes.map((n) => n.phase || n.id))
  const details = {
    isMutating: isMutatingJob(job),
    dagPhases: [...dagPhases],
    completedPhases: [...completedPhases],
    adversarialRequired: Boolean(riskMap?.adversarialRequired),
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
export function completionGateEvent(jobId, project, gateResult) {
  return {
    type: "completion_gate_evaluated",
    jobId,
    project,
    outcome: gateResult.outcome,
    reason: gateResult.reason,
    missingGates: gateResult.missingGates,
    ts: new Date().toISOString(),
  }
}

// ─── Internal ─────────────────────────────────────────────────────────

function gateResult(outcome, reason, missingGates, details) {
  return { outcome, reason, missingGates, details }
}
