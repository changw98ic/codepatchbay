import { validateSupervisorDecision } from "../../core/contracts/supervisor-decision.js";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_SUPERVISOR_AGENT = "codex";
const DEFAULT_SUPERVISOR_TIMEOUT_MS = 120_000;
const SUPERVISOR_POOL_SCOPE = "control-plane";
type AnyRecord = Record<string, any>;

function resolveSupervisorAgent(env = process.env) {
  return (
    env.CPB_ACP_SUPERVISOR_AGENT ||
    env.CPB_SUPERVISOR_AGENT ||
    DEFAULT_SUPERVISOR_AGENT
  );
}

function resolveSupervisorProviderKey(agent, env = process.env) {
  return (
    env.CPB_ACP_SUPERVISOR_PROVIDER_KEY ||
    env.CPB_SUPERVISOR_PROVIDER_KEY ||
    `${agent}:${SUPERVISOR_POOL_SCOPE}`
  );
}

export class AcpSupervisor {
  cpbRoot: string;
  hubRoot: string;
  pool: any;
  supervisorAgent: string;
  supervisorProviderKey: string;
  timeoutMs: number;
  _poolPromise: Promise<any> | null;
  decisionsDir: string;
  statePath: string;
  state: AnyRecord;

  constructor({ cpbRoot, hubRoot, pool, supervisorAgent, supervisorProviderKey, timeoutMs, env = process.env }: AnyRecord) {
    this.cpbRoot = cpbRoot;
    this.hubRoot = hubRoot;
    this.pool = pool || null;
    this.supervisorAgent = supervisorAgent || resolveSupervisorAgent(env);
    this.supervisorProviderKey = supervisorProviderKey || resolveSupervisorProviderKey(this.supervisorAgent, env);
    this.timeoutMs = timeoutMs || DEFAULT_SUPERVISOR_TIMEOUT_MS;
    this._poolPromise = null;
    this.decisionsDir = path.join(hubRoot, "supervisor", "decisions");
    this.statePath = path.join(hubRoot, "supervisor", "state.json");
    this.state = this._baseState("not_started");
  }

  _baseState(status = "not_started") {
    return {
      kind: "resident_supervisor",
      status,
      healthy: status === "healthy",
      agent: this.supervisorAgent,
      providerKey: this.supervisorProviderKey,
      poolScope: SUPERVISOR_POOL_SCOPE,
      cpbRoot: this.cpbRoot,
      hubRoot: this.hubRoot,
      decisionsDir: this.decisionsDir,
      statePath: this.statePath,
    };
  }

  async _writeState(nextState: AnyRecord) {
    this.state = {
      ...this.state,
      ...nextState,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tmp, this.statePath);
    return this.state;
  }

  async _ensurePool() {
    if (this.pool) return this.pool;
    if (this._poolPromise) return this._poolPromise;
    this._poolPromise = (async () => {
      try {
        const { getManagedAcpPool } = await import("../services/acp/acp-pool.js");
        this.pool = getManagedAcpPool({ cpbRoot: this.cpbRoot, hubRoot: this.hubRoot, persistentProcesses: true });
        return this.pool;
      } catch {
        this._poolPromise = null;
        return null;
      }
    })();
    return this._poolPromise;
  }

  async start() {
    const startedAt = new Date().toISOString();
    const pool = await this._ensurePool();
    if (!pool) {
      return this._writeState({
        ...this._baseState("unavailable"),
        healthy: false,
        startedAt,
        heartbeatAt: startedAt,
        lastActivityAt: startedAt,
        lastActivity: "pool_unavailable",
        error: "managed ACP pool unavailable",
      });
    }

    try {
      if (typeof pool.start === "function") await pool.start();
      return await this.refreshAdvisoryState({ reason: "start", startedAt });
    } catch (err) {
      return this._writeState({
        ...this._baseState("degraded"),
        healthy: false,
        startedAt,
        heartbeatAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastActivity: "start_failed",
        error: err.message,
      });
    }
  }

  async refreshAdvisoryState({ reason = "refresh", startedAt = this.state.startedAt, lastDecision = null, lastFallback = null }: AnyRecord = {}) {
    const pool = await this._ensurePool();
    if (!pool) {
      return this._writeState({
        ...this._baseState("unavailable"),
        healthy: false,
        startedAt,
        heartbeatAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        lastActivity: reason,
        error: "managed ACP pool unavailable",
      });
    }

    let poolStatus = null;
    let providerQuotas = {};
    let connectionLeases = null;
    try {
      poolStatus = typeof pool.status === "function" ? pool.status() : null;
    } catch (err) {
      poolStatus = { error: err.message };
    }
    try {
      providerQuotas = typeof pool.readProviderQuotas === "function" ? await pool.readProviderQuotas() : {};
    } catch (err) {
      providerQuotas = { error: err.message };
    }
    try {
      connectionLeases = typeof pool.connectionLeaseStatus === "function" ? await pool.connectionLeaseStatus() : null;
    } catch (err) {
      connectionLeases = { error: err.message };
    }

    const providerHealth = buildProviderHealth({
      providerKey: this.supervisorProviderKey,
      poolStatus,
      providerQuotas,
      connectionLeases,
    });
    const supervisorPool = poolStatus?.pools?.[this.supervisorAgent] || null;
    const heartbeatAt = new Date().toISOString();
    return this._writeState({
      ...this._baseState("healthy"),
      healthy: true,
      startedAt,
      heartbeatAt,
      lastActivityAt: heartbeatAt,
      lastActivity: reason,
      sessionId: supervisorPool?.sessionId || null,
      providerProcessPid: supervisorPool?.providerProcessPid || null,
      providerProcessHealthy: supervisorPool?.providerProcessHealthy ?? null,
      providerHealth,
      poolStatus,
      providerQuotas,
      connectionLeases,
      ...(lastDecision ? { lastDecision } : {}),
      ...(lastFallback ? { lastFallback } : {}),
      error: null,
    });
  }

  status() {
    return { ...this.state };
  }

  async diagnoseFailure({ assignment, attempt, result }: AnyRecord) {
    const pool = await this._ensurePool();
    if (!pool) {
      return null; // Return null so FailureRouter falls through to deterministic routing
    }

    const prompt = buildDiagnosisPrompt({ assignment, attempt, result });

    try {
      const { output } = await pool.execute(
        this.supervisorAgent,
        prompt,
        this.cpbRoot,
        this.timeoutMs,
        {
          phase: "supervisor_diagnose",
          role: "supervisor",
          poolScope: SUPERVISOR_POOL_SCOPE,
          controlPlane: true,
          providerKey: this.supervisorProviderKey,
          workspaceId: SUPERVISOR_POOL_SCOPE,
          projectId: assignment.projectId,
          jobId: `supervisor-${assignment.entryId || assignment.assignmentId || Date.now()}`,
        },
      );

      const parsed = parseDecisionOutput(output);
      const rawDecision = parsed.decision || {
        action: null,
        reason: parsed.error || "invalid supervisor output",
        params: {},
      };
      const validation = parsed.decision
        ? validateSupervisorDecision(rawDecision)
        : { valid: false, errors: [parsed.error || "invalid supervisor output"] };

      // Save decision for audit
      await this.saveDecision(assignment, rawDecision, validation);

      if (!validation.valid) {
        await this.refreshAdvisoryState({
          reason: "diagnose_fallback",
          lastFallback: {
            reason: `invalid supervisor decision: ${validation.errors.join("; ")}`,
            assignmentId: assignment.assignmentId,
            entryId: assignment.entryId,
            at: new Date().toISOString(),
          },
        }).catch(() => {});
        return null;
      }

      await this.refreshAdvisoryState({
        reason: "diagnose_decision",
        lastDecision: {
          action: rawDecision.action,
          reason: rawDecision.reason,
          confidence: rawDecision.confidence ?? null,
          assignmentId: assignment.assignmentId,
          entryId: assignment.entryId,
          at: new Date().toISOString(),
        },
      }).catch(() => {});
      return rawDecision;
    } catch (err) {
      await this.saveDecision(
        assignment,
        { action: null, reason: `supervisor failed: ${err.message}`, params: {} },
        { valid: false, errors: [`supervisor failed: ${err.message}`] },
      ).catch(() => {});
      await this.refreshAdvisoryState({
        reason: "diagnose_fallback",
        lastFallback: {
          reason: `supervisor failed: ${err.message}`,
          assignmentId: assignment.assignmentId,
          entryId: assignment.entryId,
          at: new Date().toISOString(),
        },
      }).catch(() => {});
      return null;
    }
  }

  async saveDecision(assignment: AnyRecord, rawDecision: AnyRecord, validation: AnyRecord) {
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

function buildProviderHealth({ providerKey, poolStatus, providerQuotas, connectionLeases }: AnyRecord) {
  const health: AnyRecord = {};
  const pools = poolStatus?.pools && typeof poolStatus.pools === "object" ? poolStatus.pools : {};
  for (const [agent, state] of Object.entries(pools) as [string, AnyRecord][]) {
    const key = state.providerKey || agent;
    health[key] = {
      providerKey: key,
      status: "available",
      active: state.active ?? 0,
      limit: state.limit ?? null,
      queued: state.queued ?? 0,
      sessionId: state.sessionId || null,
      providerProcessHealthy: state.providerProcessHealthy ?? null,
      source: "acp-pool",
    };
  }
  if (providerQuotas && typeof providerQuotas === "object" && !providerQuotas.error) {
    for (const [key, quota] of Object.entries(providerQuotas) as [string, AnyRecord][]) {
      health[key] = {
        ...(health[key] || { providerKey: key }),
        status: quota.status || health[key]?.status || "unknown",
        nextEligibleAt: quota.nextEligibleAt ?? null,
        reason: quota.reason || "",
        source: quota.source || health[key]?.source || "provider-quota",
        updatedAt: quota.updatedAt || null,
      };
    }
  }
  if (connectionLeases?.providers && typeof connectionLeases.providers === "object") {
    for (const [key, count] of Object.entries(connectionLeases.providers)) {
      health[key] = {
        ...(health[key] || { providerKey: key, status: "unknown" }),
        activeLeases: count,
      };
    }
  }
  if (!health[providerKey]) {
    health[providerKey] = {
      providerKey,
      status: "unknown",
      source: "resident-supervisor",
    };
  }
  return health;
}

function buildDiagnosisPrompt({ assignment, attempt, result }: AnyRecord) {
  const failure = result.jobResult?.failure || result.failure || {};
  return `You are the CPB Supervisor Agent. Diagnose this failure and recommend an action.

## Assignment
- Project: ${assignment.projectId}
- Task: ${(assignment.task || "").slice(0, 200)}
- Workflow: ${assignment.workflow} / ${assignment.planMode}

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
    return { decision: null, error: "empty supervisor output" };
  }
  try {
    const match = output.match(/```json\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = match ? match[1].trim() : output.trim();
    return { decision: JSON.parse(jsonStr), error: null };
  } catch {
    return { decision: null, error: "supervisor output not valid JSON" };
  }
}
