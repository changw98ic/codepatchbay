/**
 * High-risk approval and supervisor context policy.
 *
 * Centralizes risk classification for task descriptions, determines when
 * human approval is required, and builds supervisor context packets that
 * give the ACP supervisor richer signals when diagnosing failures on
 * high-risk jobs.
 */

const HIGH_RISK_PATTERNS = Object.freeze([
  { id: "secrets", pattern: /\b(?:secret|api[_-]?key|password|token|credential)\b/i, reason: "involves secrets or credentials" },
  { id: "auth", pattern: /\b(?:auth(?:entication|orization)?)\b/i, reason: "modifies authentication or authorization" },
  { id: "destructive_db", pattern: /\b(?:drop[_\s-]?table|delete\s+from|truncate\b|\bdestroy\b)/i, reason: "potentially destructive database operation" },
  { id: "migration", pattern: /\b(?:migration|schema\s+change)\b/i, reason: "database schema migration" },
  { id: "public_api", pattern: /\b(?:public\s+api|breaking\s+change|deprecat)/i, reason: "affects public API surface" },
  { id: "infra", pattern: /\b(?:infrastructure|deploy(?:ment)?|release|production|prod)\b/i, reason: "touches infrastructure or deployment" },
  { id: "security", pattern: /\b(?:security|vulnerability|cve|exploit|xss|injection|csrf|rbac)\b/i, reason: "security-sensitive change" },
]);

const RISK_LEVELS = Object.freeze(["low", "medium", "high"]);

/**
 * Classify a task's risk level based on its description and optional metadata.
 *
 * @param {string} task - Task description text
 * @param {object} [metadata] - Optional metadata with extra signals
 * @param {string[]} [metadata.labels] - Issue/command labels
 * @param {string} [metadata.workflow] - Assigned workflow
 * @param {string} [metadata.planMode] - Plan mode
 * @param {string} [metadata.source] - Event source (github, channel, etc.)
 * @returns {{ level: "low"|"medium"|"high", reasons: string[], matchedPatterns: string[] }}
 */
export function classifyRisk(task, metadata = {}) {
  const reasons = [];
  const matchedPatterns = [];
  const text = task || "";

  for (const { id, pattern, reason } of HIGH_RISK_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push(reason);
      matchedPatterns.push(id);
    }
  }

  // Label-based elevation
  const labels = metadata.labels || [];
  const hasCriticalLabel = labels.some((l) => {
    const name = typeof l === "string" ? l : l.name;
    return /p0|critical|urgent|blocker/i.test(name || "");
  });
  if (hasCriticalLabel && !reasons.includes("critical priority label")) {
    reasons.push("critical priority label");
    matchedPatterns.push("critical_label");
  }

  // Workflow-based elevation: complex workflow with full plan is already high
  if (metadata.workflow === "complex" && metadata.planMode === "full" && !matchedPatterns.includes("complex_workflow")) {
    reasons.push("complex workflow with full plan");
    matchedPatterns.push("complex_workflow");
  }

  const level = reasons.length >= 2 ? "high" : reasons.length === 1 ? "medium" : "low";

  return { level, reasons, matchedPatterns };
}

/**
 * Determine if a job phase requires human approval based on risk and team policy.
 *
 * @param {{ level: string, reasons: string[] }} risk - Output of classifyRisk()
 * @param {object} [teamPolicy] - Team policy from core/policy/team-policy.js
 * @param {string} [phase] - Current phase (plan, execute, verify, review)
 * @returns {{ required: boolean, reason: string|null, timeoutMinutes: number }}
 */
export function requiresApproval(risk, teamPolicy = null, phase = null) {
  // Explicit team policy override
  if (teamPolicy?.approvals) {
    const phaseOps = phaseToOperations(phase);
    for (const op of phaseOps) {
      if (teamPolicy.approvals[op]?.required) {
        return {
          required: true,
          reason: `team policy requires approval for ${op}`,
          timeoutMinutes: teamPolicy.approvals[op].timeoutMinutes || 60,
        };
      }
    }
  }

  // High-risk always requires approval for execute and later phases
  if (risk.level === "high") {
    return {
      required: true,
      reason: `high-risk task: ${risk.reasons.join("; ")}`,
      timeoutMinutes: 60,
    };
  }

  // Medium risk requires approval only on execute phase (plan is safe)
  if (risk.level === "medium" && phase === "execute") {
    return {
      required: true,
      reason: `medium-risk execution: ${risk.reasons.join("; ")}`,
      timeoutMinutes: 30,
    };
  }

  return { required: false, reason: null, timeoutMinutes: 0 };
}

/**
 * Build a context packet for the ACP supervisor when diagnosing failures
 * on high-risk jobs. This gives the supervisor richer signals so it can
 * make better decisions (e.g., prefer request_human_approval over blind retry).
 *
 * @param {{ level: string, reasons: string[], matchedPatterns: string[] }} risk
 * @param {object} job - Materialized job state
 * @returns {{ riskLevel: string, riskReasons: string[], supervisorHints: string[], phaseHistory: object }}
 */
export function buildSupervisorContext(risk, job) {
  const supervisorHints = [];

  if (risk.level === "high") {
    supervisorHints.push("PREFER request_human_approval over retry — this is a high-risk task");
    supervisorHints.push("DO NOT suggest switch_agent for auth/security tasks without explicit approval");
    supervisorHints.push("Prefer mark_blocked over mark_failed if uncertain — human review is safer");
  }

  if (risk.matchedPatterns.includes("secrets") || risk.matchedPatterns.includes("auth")) {
    supervisorHints.push("Secrets/auth failure may indicate credential rotation — recommend request_human_approval");
  }

  if (risk.matchedPatterns.includes("destructive_db") || risk.matchedPatterns.includes("migration")) {
    supervisorHints.push("Database failure may require manual rollback — recommend mark_blocked over retry");
  }

  if (risk.matchedPatterns.includes("public_api")) {
    supervisorHints.push("Public API changes need careful review — do not auto-retry without verification");
  }

  // Build phase history summary from job state
  const phaseHistory = {
    completedPhases: job.completedPhases || [],
    failureCode: job.failureCode || null,
    failurePhase: job.failurePhase || null,
    retryCount: job.retryCount || 0,
    blockedReason: job.blockedReason || null,
  };

  return {
    riskLevel: risk.level,
    riskReasons: risk.reasons,
    matchedPatterns: risk.matchedPatterns,
    supervisorHints,
    phaseHistory,
  };
}

/**
 * Build a risk summary string for inclusion in phase context packets.
 *
 * @param {{ level: string, reasons: string[], matchedPatterns: string[] }} risk
 * @returns {string}
 */
export function riskSummary(risk) {
  if (risk.level === "low") return "low-risk";
  return `${risk.level}-risk: ${risk.reasons.join("; ")}`;
}

/**
 * Export patterns for reuse by evolve-policy and other consumers.
 */
export { HIGH_RISK_PATTERNS };

function phaseToOperations(phase) {
  if (!phase) return [];
  switch (phase) {
    case "plan": return ["write"];
    case "execute":
    case "repair": return ["write", "shell", "network"];
    case "verify":
    case "review": return ["shell"];
    default: return [];
  }
}
