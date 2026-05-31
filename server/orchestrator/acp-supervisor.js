import { validateSupervisorDecision } from "../../core/contracts/supervisor-decision.js";
import { classifyRisk, buildSupervisorContext } from "../../core/policy/high-risk-approval.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export class AcpSupervisor {
  constructor({ cpbRoot, hubRoot, pool }) {
    this.cpbRoot = cpbRoot;
    this.hubRoot = hubRoot;
    this.pool = pool || null;
    this._poolPromise = null;
    this.decisionsDir = path.join(hubRoot, "supervisor", "decisions");
  }

  async _ensurePool() {
    if (this.pool) return this.pool;
    if (this._poolPromise) return this._poolPromise;
    this._poolPromise = (async () => {
      try {
        const { getManagedAcpPool } = await import("../services/acp-pool.js");
        this.pool = getManagedAcpPool({ cpbRoot: this.cpbRoot, hubRoot: this.hubRoot, persistentProcesses: true });
        return this.pool;
      } catch {
        this._poolPromise = null;
        return null;
      }
    })();
    return this._poolPromise;
  }

  async diagnoseFailure({ assignment, attempt, result }) {
    const pool = await this._ensurePool();
    if (!pool) {
      return null; // Return null so FailureRouter falls through to deterministic routing
    }

    // Build supervisor context from risk classification
    const task = assignment.task || "";
    const risk = classifyRisk(task, {
      workflow: assignment.workflow,
      planMode: assignment.planMode,
    });
    const supervisorCtx = buildSupervisorContext(risk, { failurePhase: result?.jobResult?.failure?.phase });

    const prompt = buildDiagnosisPrompt({ assignment, attempt, result, supervisorCtx });

    try {
      const output = await pool.execute(
        "supervisor",
        prompt,
        this.cpbRoot,
        120_000,
        { phase: "diagnose", role: "supervisor" },
      );

      const rawDecision = parseDecisionOutput(output);
      const validation = validateSupervisorDecision(rawDecision);

      // Save decision for audit
      await this.saveDecision(assignment, rawDecision, validation);

      if (!validation.valid) {
        return { action: "mark_failed", reason: `supervisor decision invalid: ${validation.errors.join("; ")}`, params: {} };
      }

      return rawDecision;
    } catch (err) {
      return { action: "mark_failed", reason: `supervisor failed: ${err.message}`, params: {} };
    }
  }

  async saveDecision(assignment, rawDecision, validation) {
    await mkdir(this.decisionsDir, { recursive: true });
    const ts = Date.now();
    const file = path.join(this.decisionsDir, `${assignment.entryId}-${assignment.assignmentId}-${ts}.json`);
    await writeFile(file, JSON.stringify({
      rawDecision,
      validation,
      assignmentId: assignment.assignmentId,
      entryId: assignment.entryId,
      createdAt: new Date().toISOString(),
    }, null, 2) + "\n", "utf8");
  }
}

function buildDiagnosisPrompt({ assignment, attempt, result, supervisorCtx }) {
  const failure = result.jobResult?.failure || result.failure || {};

  // Build supervisor context section if risk is elevated
  let supervisorCtxSection = "";
  if (supervisorCtx && supervisorCtx.riskLevel !== "low") {
    const hints = supervisorCtx.supervisorHints.map((h) => `- ${h}`).join("\n");
    supervisorCtxSection = `
## Supervisor Context Policy (MANDATORY — this is a ${supervisorCtx.riskLevel}-risk task)
Risk reasons: ${supervisorCtx.riskReasons.join("; ")}
Matched patterns: ${supervisorCtx.matchedPatterns.join(", ")}
${hints}
`;
  }

  return `You are the CPB Supervisor Agent. Diagnose this failure and recommend an action.

## Assignment
- Project: ${assignment.projectId}
- Task: ${(assignment.task || "").slice(0, 200)}
- Workflow: ${assignment.workflow} / ${assignment.planMode}
${supervisorCtxSection}
## Failure
- Kind: ${failure.kind}
- Phase: ${failure.phase || "unknown"}
- Reason: ${(failure.reason || "").slice(0, 500)}
- Retryable: ${failure.retryable}
- Exit code: ${failure.exitCode || "N/A"}
- Signal: ${failure.signal || "N/A"}

## Stdout snippet
\`\`\`
${(failure.stdoutSnippet || "").slice(0, 300)}
\`\`\`

## Stderr snippet
\`\`\`
${(failure.stderrSnippet || "").slice(0, 300)}
\`\`\`

Respond with a JSON decision:
\`\`\`json
{
  "action": "<action from whitelist>",
  "reason": "<explanation>",
  "confidence": 0.0-1.0,
  "params": {}
}
\`\`\`

Allowed actions: retry_same_worker, restart_worker_and_retry, reroute, switch_agent, wait_for_rate_limit, request_human_approval, mark_failed, mark_blocked

For reroute, params must include: { "workflow": "standard"|"complex", "planMode": "full"|"light" }
For switch_agent, params must include: { "role": "planner"|"executor"|"verifier", "agent": "<name>" }
For wait_for_rate_limit, params must include: { "untilTs": "<ISO datetime>" }`;
}

function parseDecisionOutput(output) {
  if (!output || typeof output !== "string") {
    return { action: "mark_failed", reason: "empty supervisor output" };
  }
  try {
    const match = output.match(/```json\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = match ? match[1].trim() : output.trim();
    return JSON.parse(jsonStr);
  } catch {
    return { action: "mark_failed", reason: "supervisor output not valid JSON" };
  }
}
