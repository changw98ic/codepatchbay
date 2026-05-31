import { FailureKind, failure } from "../contracts/failure.js";

const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests|capacity|overloaded|ProviderQuotaError/i;
const DEFAULT_TIMEOUT_MS = 0;

/**
 * Unified agent execution with structured error categorization.
 * All ACP calls go through this — non-zero exit, timeout, rate limit,
 * signal, spawn error are classified into FailureKind.
 *
 * @param {object} opts
 * @param {string} opts.role        - planner | executor | verifier | supervisor
 * @param {string} opts.agent       - codex | claude | etc
 * @param {string} opts.project     - project ID
 * @param {string} opts.prompt      - prompt to send
 * @param {string} opts.cwd         - working directory
 * @param {object} [opts.pool]      - AcpPool instance (must have .execute())
 * @param {number} [opts.timeoutMs] - timeout in ms
 * @param {object} [opts.scope]     - agent scope for pool key
 * @param {object} [opts.env]       - environment overrides
 * @returns {Promise<{ok: boolean, agent: string, output?: string, kind?: string, ...}>}
 */
export async function runAgent({
  role,
  agent,
  variant,
  project,
  prompt,
  cwd,
  pool,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  scope,
  env,
}) {
  const startedAt = Date.now();

  try {
    const execResult = await pool.execute(agent, prompt, cwd, timeoutMs, {
      phase: role,
      role,
      bypass: false,
      projectId: project,
      variant,
      workspaceId: scope?.workspaceId,
      policyHash: scope?.policyHash,
    });
    const output = typeof execResult === "string" ? execResult : execResult.output;
    const providerKey = execResult?.providerKey || null;
    const execVariant = execResult?.variant || null;

    return {
      ok: true,
      agent,
      output: typeof output === "string" ? output.trim() : String(output).trim(),
      diagnostics: {
        elapsedMs: Date.now() - startedAt,
        agent,
        role,
        providerKey,
        variant: execVariant,
      },
    };
  } catch (err) {
    return classifyError(err, { agent, role, startedAt });
  }
}

function classifyError(err, { agent, role, startedAt }) {
  const msg = err?.message || String(err || "");
  const lowerMsg = msg.toLowerCase();
  const snippet = msg.slice(0, 500);
  const elapsedMs = Date.now() - startedAt;

  // Rate limit / ProviderQuotaError
  if (RATE_LIMIT_PATTERN.test(msg) || err?.name === "RateLimitError" || err?.name === "ProviderQuotaError") {
    const untilTs = err?.untilTs || err?.nextEligibleAt || parseResetTime(msg);
    return {
      ok: false,
      kind: FailureKind.AGENT_RATE_LIMITED,
      reason: msg,
      retryable: true,
      agent,
      cause: {
        untilTs,
        status: err?.status || null,
        providerKey: err?.providerKey || agent,
        nextEligibleAt: err?.nextEligibleAt || untilTs,
        source: err?.source || null,
        confidence: err?.confidence ?? null,
        stdout: err?.partialStdout || "",
        stderr: err?.partialStderr || "",
      },
      diagnostics: { elapsedMs, agent, role },
    };
  }

  // Timeout
  if (lowerMsg.includes("timed out") || lowerMsg.includes("timeout")) {
    return {
      ok: false,
      kind: FailureKind.TIMEOUT,
      reason: msg,
      retryable: true,
      agent,
      diagnostics: { elapsedMs, agent, role, stderrSnippet: snippet },
    };
  }

  // Signal / interrupt
  if (err?.signal || lowerMsg.includes("sigterm") || lowerMsg.includes("sigkill") || lowerMsg.includes("interrupted")) {
    return {
      ok: false,
      kind: FailureKind.RUNTIME_INTERRUPTED,
      reason: `interrupted by ${err.signal || "signal"}`,
      retryable: true,
      agent,
      signal: err.signal || null,
      diagnostics: { elapsedMs, agent, role },
    };
  }

  // Spawn error (ENOENT, child process failed to start)
  if (err?.code === "ENOENT" || lowerMsg.includes("spawn") || lowerMsg.includes("enoent")) {
    return {
      ok: false,
      kind: FailureKind.AGENT_SPAWN_ERROR,
      reason: msg,
      retryable: true,
      agent,
      diagnostics: { elapsedMs, agent, role },
    };
  }

  // Exit non-zero
  const exitMatch = msg.match(/exited?\s+(?:with\s+)?(?:code\s+)?(\d+)/i);
  if (exitMatch) {
    return {
      ok: false,
      kind: FailureKind.AGENT_EXIT_NONZERO,
      reason: msg,
      retryable: true,
      agent,
      exitCode: Number(exitMatch[1]),
      diagnostics: { elapsedMs, agent, role, stderrSnippet: snippet },
    };
  }

  // Unavailable (connection refused, agent not found)
  if (lowerMsg.includes("unavailable") || lowerMsg.includes("econnrefused") || lowerMsg.includes("not found")) {
    return {
      ok: false,
      kind: FailureKind.AGENT_UNAVAILABLE,
      reason: msg,
      retryable: true,
      agent,
      diagnostics: { elapsedMs, agent, role },
    };
  }

  // Permission denied
  if (err?.code === "EACCES" || lowerMsg.includes("permission denied")) {
    return {
      ok: false,
      kind: FailureKind.PERMISSION_DENIED,
      reason: msg,
      retryable: false,
      agent,
      diagnostics: { elapsedMs, agent, role },
    };
  }

  // Fallback
  return {
    ok: false,
    kind: FailureKind.UNKNOWN,
    reason: msg,
    retryable: false,
    agent,
    diagnostics: { elapsedMs, agent, role },
  };
}

function parseResetTime(msg) {
  const iso = msg.match(/20\d\d-\d\d-\d\d[T\s]\d\d:\d\d:\d\d/);
  if (iso) {
    const ts = Date.parse(iso[0].includes("T") ? iso[0] : iso[0].replace(" ", "T"));
    if (Number.isFinite(ts)) return ts;
  }
  return Date.now() + 60_000;
}
