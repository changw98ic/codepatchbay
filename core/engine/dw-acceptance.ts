// @ts-nocheck
/**
 * DW Acceptance Harness — validates that the Dynamic Workflow Strict
 * Completion spec's Definition of Done is met against real job artifacts.
 *
 * Pure logic module: no I/O, no side effects, no external dependencies.
 *
 * @module core/engine/dw-acceptance
 */

// ─── Individual checks ────────────────────────────────────────────────

/**
 * Q1: Was codegraph readiness confirmed before execution?
 */
function checkCodeGraphReady(events) {
  const ready = Array.isArray(events) && events.some(
    (e) => e.type === "codegraph_ready" || e.type === "codegraph_index_ok",
  );
  return {
    question: "Was codegraph readiness confirmed before execution?",
    answer: ready ? "Yes — codegraph_ready event found" : "No — no codegraph readiness event",
    passed: ready,
  };
}

/**
 * Q2: Was a risk map generated during prepare_task?
 */
function checkRiskMapGenerated(riskMap) {
  const present = riskMap != null && typeof riskMap === "object";
  const hasLevel = present && riskMap.riskLevel != null;
  return {
    question: "Was a risk map generated during prepare_task?",
    answer: hasLevel
      ? `Yes — riskLevel=${riskMap.riskLevel}`
      : present ? "Partial — riskMap present but no riskLevel" : "No — riskMap is null",
    passed: hasLevel,
    details: present ? { riskLevel: riskMap.riskLevel, adversarialRequired: Boolean(riskMap.adversarialRequired) } : undefined,
  };
}

/**
 * Q3: Were the required DAG nodes present in the workflow DAG?
 */
function checkDagNodesRequired(workflowDag) {
  const nodes = Array.isArray(workflowDag?.nodes) ? workflowDag.nodes : [];
  const phaseIds = new Set(nodes.map((n) => n.phase || n.id));
  const hasExecute = phaseIds.has("execute");
  const hasVerify = phaseIds.has("verify");
  const passed = hasExecute && hasVerify;
  return {
    question: "Did the workflow DAG include execute and verify nodes?",
    answer: passed
      ? `Yes — DAG has ${nodes.length} nodes including execute and verify`
      : `No — DAG has ${nodes.length} nodes, execute=${hasExecute}, verify=${hasVerify}`,
    passed,
    details: { nodeCount: nodes.length, phases: [...phaseIds] },
  };
}

/**
 * Q4: Did all DAG nodes actually run to completion?
 */
function checkDagNodesRan(job) {
  const dagPhases = Array.isArray(job?.workflowDag?.nodes)
    ? job.workflowDag.nodes.map((n) => n.phase || n.id)
    : [];
  const completed = new Set(job?.completedPhases || []);
  const missing = dagPhases.filter((p) => !completed.has(p));
  const passed = dagPhases.length > 0 && missing.length === 0;
  return {
    question: "Did all DAG nodes run to completion?",
    answer: passed
      ? `Yes — all ${dagPhases.length} DAG phases completed`
      : `No — missing phases: ${missing.join(", ") || "no DAG phases defined"}`,
    passed,
    details: { dagPhases, completedPhases: [...completed], missing },
  };
}

/**
 * Q5: Were the required agents in the dynamic agent plan?
 */
function checkAgentsRequired(dynamicAgentPlan) {
  const plan = dynamicAgentPlan;
  const agentConfig = plan?.agentConfig;
  const valid = plan != null && typeof plan === "object" && agentConfig != null;
  const agentCount = valid ? Object.keys(agentConfig).length : 0;
  const passed = valid && agentCount > 0;
  return {
    question: "Was a dynamic agent plan generated with at least one agent?",
    answer: passed
      ? `Yes — ${agentCount} agent role(s) in plan`
      : "No — dynamic agent plan is missing or empty",
    passed,
    details: valid ? { agentCount, version: plan.schemaVersion } : undefined,
  };
}

/**
 * Q6: Did the ordinary verify phase pass (VERDICT: PASS)?
 */
function checkOrdinaryVerifyPassed(job, gateResult) {
  const completed = new Set(job?.completedPhases || []);
  const verifyRan = completed.has("verify");
  const gatePassed = gateResult?.outcome === "complete";
  // Gate passed + verify ran is sufficient evidence; parsedVerdictStatus is not
  // projected by the gate (it stores parsed result internally), so we infer from
  // the gate outcome combined with phase completion.
  const verdictPass = gatePassed && verifyRan;
  return {
    question: "Did the ordinary verify phase pass (VERDICT: PASS)?",
    answer: verdictPass
      ? "Yes — verify passed"
      : verifyRan ? "No — verify ran but gate did not pass" : "No — verify phase did not run",
    passed: verdictPass,
  };
}

/**
 * Q7: Was adversarial verification required by the risk map?
 */
function checkAdversarialRequired(riskMap) {
  const required = riskMap?.adversarialRequired === true;
  return {
    question: "Was adversarial verification required?",
    answer: required ? "Yes — riskMap.adversarialRequired=true" : "No — adversarial not required",
    passed: true, // This is informational, not a pass/fail check
    details: { adversarialRequired: required },
  };
}

/**
 * Q8: If adversarial was required, did it pass?
 */
function checkAdversarialPassed(riskMap, job, gateResult) {
  const required = riskMap?.adversarialRequired === true;
  if (!required) {
    return {
      question: "If adversarial was required, did it pass?",
      answer: "N/A — adversarial verification was not required",
      passed: true,
    };
  }
  const completed = new Set(job?.completedPhases || []);
  const ran = completed.has("adversarial_verify");
  const gatePassed = gateResult?.outcome === "complete";
  return {
    question: "If adversarial was required, did it pass?",
    answer: gatePassed && ran
      ? "Yes — adversarial verify completed and passed"
      : ran ? "No — adversarial verify ran but did not pass" : "No — adversarial verify was required but did not run",
    passed: gatePassed && ran,
  };
}

/**
 * Q9: On failure, was retry scope limited (not full pipeline)?
 */
function checkRetryScopeOnFailure(gateResult) {
  const outcome = gateResult?.outcome;
  if (outcome === "complete") {
    return {
      question: "On failure, was retry scope limited?",
      answer: "N/A — job completed successfully, no retry needed",
      passed: true,
    };
  }
  const hasRetryScope = gateResult?.details?.retryScope != null;
  return {
    question: "On failure, was retry scope limited (not full pipeline)?",
    answer: hasRetryScope
      ? `Yes — retryScope=${gateResult.details.retryScope}`
      : "No retry scope information available",
    passed: hasRetryScope,
  };
}

/**
 * Q10: Was the official benchmark run and passed?
 * (Informational — only applicable when a benchmark target exists.)
 */
function checkOfficialBenchmark(events) {
  const benchmarkEvents = Array.isArray(events)
    ? events.filter((e) => e.type === "benchmark_result")
    : [];
  const passed = benchmarkEvents.some((e) => e.passed === true);
  return {
    question: "Was the official benchmark run and passed?",
    answer: benchmarkEvents.length === 0
      ? "N/A — no benchmark events found"
      : passed ? "Yes — at least one benchmark passed" : "No — benchmark ran but did not pass",
    passed: benchmarkEvents.length === 0 || passed,
    details: { benchmarkCount: benchmarkEvents.length },
  };
}

/**
 * Q11: Did CPB enforce the workflow (no skipped phases)?
 */
function checkCpbEnforcedWorkflow(job, gateResult) {
  const outcome = gateResult?.outcome;
  const isComplete = outcome === "complete";
  const completedPhases = new Set(job?.completedPhases || []);
  const phases = Array.isArray(job?.phases) ? job.phases : [];
  const skipped = phases.filter((p) => !completedPhases.has(p));
  return {
    question: "Did CPB enforce the workflow (no skipped phases)?",
    answer: isComplete && skipped.length === 0
      ? `Yes — all ${phases.length} phases completed, gate passed`
      : `No — skipped phases: ${skipped.join(", ") || "none"}, gate=${outcome || "unknown"}`,
    passed: isComplete && skipped.length === 0,
    details: { totalPhases: phases.length, skipped },
  };
}

// ─── Main evaluator ───────────────────────────────────────────────────

/**
 * Evaluate DW acceptance against real job artifacts.
 * Returns a structured report answering all 11 DoD questions.
 *
 * @param {object} params
 * @param {object}   params.job               — Job record
 * @param {object[]} [params.events]           — Event log entries
 * @param {object}   [params.reviewBundle]     — Review bundle (unused, reserved)
 * @param {object}   [params.riskMap]          — Risk map from prepare_task
 * @param {object}   [params.workflowDag]      — Resolved DAG for this run
 * @param {object}   [params.dynamicAgentPlan] — Dynamic agent plan
 * @param {object}   [params.gateResult]       — Completion gate evaluation result
 * @returns {{ schemaVersion: string, timestamp: string, overall: string, score: string, checks: object[], dodQuestions: object[] }}
 */
export function evaluateDwAcceptance({
  job,
  events,
  reviewBundle,
  riskMap,
  workflowDag,
  dynamicAgentPlan,
  gateResult,
} = {}) {
  const checks = [
    checkCodeGraphReady(events),
    checkRiskMapGenerated(riskMap),
    checkDagNodesRequired(workflowDag),
    checkDagNodesRan(job),
    checkAgentsRequired(dynamicAgentPlan),
    checkOrdinaryVerifyPassed(job, gateResult),
    checkAdversarialRequired(riskMap),
    checkAdversarialPassed(riskMap, job, gateResult),
    checkRetryScopeOnFailure(gateResult),
    checkOfficialBenchmark(events),
    checkCpbEnforcedWorkflow(job, gateResult),
  ];

  const passed = checks.filter((c) => c.passed).length;
  const total = checks.length;

  return {
    schemaVersion: "dw-acceptance-1",
    timestamp: new Date().toISOString(),
    overall: passed === total ? "pass" : "incomplete",
    score: `${passed}/${total}`,
    checks,
    dodQuestions: checks.map((c) => ({
      question: c.question,
      answer: c.answer,
      passed: c.passed,
    })),
  };
}
