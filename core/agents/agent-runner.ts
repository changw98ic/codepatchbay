import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { recordValue, type LooseRecord } from "../../shared/types.js";
import { FailureKind, failure } from "../contracts/failure.js";

const RATE_LIMIT_PATTERN = /\b(?:429|529)\b|rate.?limit|too many requests|capacity|overloaded|over.?capacity|ProviderQuotaError|访问量过大|模型当前访问量|当前访问量过大|temporar(?:y|ily) unavailable/i;
const DEFAULT_TIMEOUT_MS = 0;
const MUTATING_PHASES = new Set(["execute", "remediate", "executor", "remediator"]);
const VALIDATION_PHASES = new Set(["verify", "review"]);

function isReadOnlyPhase(phase: string) {
  return Boolean(phase) && !MUTATING_PHASES.has(phase);
}
const CLAUDE_COMPATIBLE_AGENT = /^(?:claude|claude-.+)$/;
const REPLAY_DENY_TOOLS = ["--disallowedTools", "Edit,Write,MultiEdit"];
const VERIFIER_DENY_TOOLS = ["--disallowedTools", "Edit,MultiEdit"];
const READ_ONLY_DENY_TOOLS = ["--disallowedTools", "Bash,Edit,Write,MultiEdit"];
const WEB_DENY_TOOLS = ["--disallowedTools", "WebSearch,WebFetch"];
const WEB_MCP_DISABLE_ARGS = ["--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}"];
const MUTATING_TOOL_TITLE = /^(?:Edit|Write|MultiEdit)\s+(.+)$/;

function mergeCommaList(...values: unknown[]) {
  const entries = values
    .flatMap((value) => typeof value === "string" ? value.split(",") : [])
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(entries)].join(",");
}

function splitArgs(value: string) {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaping = false;
  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) words.push(current);
  return words;
}

function parseArgsEnv(value: unknown) {
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
    } catch {
      return splitArgs(trimmed);
    }
  }
  return splitArgs(trimmed);
}

function takeFlagCsvValues(args: string[], flag: string) {
  const values: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flag) {
      const value = args[index + 1];
      if (value && !value.startsWith("--")) {
        values.push(value);
        index += 1;
      }
      continue;
    }
    rest.push(arg);
  }
  return { values, rest };
}

function mergeArgsEnv(current: unknown, appended: string[]) {
  const currentArgs = parseArgsEnv(current);
  const currentDisallowed = takeFlagCsvValues(currentArgs, "--disallowedTools");
  const appendedDisallowed = takeFlagCsvValues(appended, "--disallowedTools");
  const next = [...currentDisallowed.rest];
  for (const arg of appendedDisallowed.rest) {
    if (!next.includes(arg)) next.push(arg);
  }
  const disallowedTools = mergeCommaList(...currentDisallowed.values, ...appendedDisallowed.values);
  if (disallowedTools) next.push("--disallowedTools", disallowedTools);
  return JSON.stringify(next);
}

function claudeArgsEnvKey(agentName: string) {
  if (agentName === "claude") return "CPB_ACP_CLAUDE_ARGS";
  if (!agentName.startsWith("claude-")) return null;
  return `CPB_ACP_${agentName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_ARGS`;
}

function installClaudeToolDeny(env: LooseRecord, agentName: string, denyTools: string[]) {
  const key = claudeArgsEnvKey(agentName);
  if (!key) return;
  env[key] = mergeArgsEnv(env[key], denyTools);
}

function installClaudeReadOnlyToolDeny(env: LooseRecord, agentName: string) {
  installClaudeToolDeny(env, agentName, READ_ONLY_DENY_TOOLS);
}

function normalizeFsPath(value: string | null | undefined, cwd = process.cwd()) {
  if (!value) return null;
  let raw = value.trim().replace(/^file:\/\//, "");
  raw = raw.replace(/^["']|["']$/g, "");
  if (!raw) return null;
  if (raw.startsWith("/private/tmp/")) raw = `/tmp/${raw.slice("/private/tmp/".length)}`;
  return path.resolve(cwd, raw);
}

function pathWithin(candidate: string, root: string) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function writeAllowRoots(writeAllow: unknown, cwd: string) {
  if (typeof writeAllow !== "string") return [];
  return writeAllow
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== "__cpb_no_worktree_writes__")
    .map((entry) => entry.includes("*") ? entry.slice(0, entry.indexOf("*")) : entry)
    .map((entry) => entry.replace(/[\\/]+$/, ""))
    .map((entry) => normalizeFsPath(entry, cwd))
    .filter((entry): entry is string => !!entry);
}

function mutatingToolPathFromTitle(title: unknown, kind = "") {
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  const match = trimmed.match(MUTATING_TOOL_TITLE);
  if (match) return match[1].trim();
  if (!["edit", "write", "multi_edit"].includes(kind)) return null;

  // Claude-compatible ACP transports report file edits in two shapes:
  // either `Edit <path>` or a mutating event whose title is the bare path.
  // Preserve fail-closed behavior for generic titles such as "Editing files".
  const bare = trimmed.replace(/^file:\/\//, "").replace(/^['"]|['"]$/g, "");
  if (/^(?:\/|\.\.?[\\/]|[A-Za-z]:[\\/])/.test(bare)) return bare;
  return null;
}

async function readOnlyMutationViolation({
  auditFile,
  phase,
  cwd,
  env,
  startedAt,
  sessionId,
}: {
  auditFile: unknown;
  phase: string;
  cwd: string;
  env: LooseRecord;
  startedAt: number;
  sessionId: unknown;
}) {
  if (!isReadOnlyPhase(phase) || typeof auditFile !== "string" || !auditFile.trim()) return null;
  let raw = "";
  try {
    raw = await readFile(auditFile, "utf8");
  } catch {
    return null;
  }
  const allowedRoots = writeAllowRoots(env.CPB_ACP_WRITE_ALLOW, cwd);
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: LooseRecord;
    try {
      event = recordValue(JSON.parse(line));
    } catch {
      continue;
    }
    if (event.phase !== phase) continue;
    const eventSessionId = typeof event.sessionId === "string" ? event.sessionId : null;
    const currentSessionId = typeof sessionId === "string" && sessionId ? sessionId : null;
    if (currentSessionId && eventSessionId && eventSessionId !== currentSessionId) continue;
    const eventTimestamp = typeof event.ts === "string" ? Date.parse(event.ts) : Number.NaN;
    if (Number.isFinite(eventTimestamp) && eventTimestamp < startedAt) continue;
    const kind = typeof event.kind === "string" ? event.kind.toLowerCase() : "";
    const titlePath = mutatingToolPathFromTitle(event.title, kind);
    if (!titlePath && kind !== "edit" && kind !== "write" && kind !== "multi_edit") continue;
    const targetPath = normalizeFsPath(titlePath, cwd);
    if (!targetPath) {
      return {
        auditFile,
        phase,
        title: typeof event.title === "string" ? event.title : undefined,
        status: typeof event.status === "string" ? event.status : undefined,
        targetPath: "<provider-did-not-report-path>",
        allowedRoots,
      };
    }
    if (allowedRoots.some((root) => pathWithin(targetPath, root))) continue;
    return {
      auditFile,
      phase,
      title: typeof event.title === "string" ? event.title : undefined,
      status: typeof event.status === "string" ? event.status : undefined,
      targetPath,
      allowedRoots,
    };
  }
  return null;
}

function readOnlyMutationFailure({
  agent,
  role,
  startedAt,
  violation,
  execRecord,
}: {
  agent: string;
  role: string;
  startedAt: number;
  violation: LooseRecord;
  execRecord: LooseRecord;
}) {
  return {
    ok: false,
    kind: FailureKind.READ_ONLY_MUTATION_DENIED,
    reason: `read-only phase attempted to modify ${violation.targetPath}`,
    retryable: false,
    agent,
    cause: {
      readOnlyMutation: violation,
    },
    diagnostics: {
      elapsedMs: Date.now() - startedAt,
      agent,
      role,
      acpAuditFile: execRecord.acpAuditFile || violation.auditFile || null,
      usage: execRecord.usage || null,
      readOnlyMutation: violation,
    },
  };
}

type AgentPool = {
  execute: (...args: unknown[]) => Promise<unknown>;
};

type ClassifyErrorContext = {
  agent: string;
  role: string;
  phase: string;
  env: LooseRecord;
  startedAt: number;
};

/**
 * Type guard: narrow an unknown caught value to a record-like error object
 * (has own/enumerable string-keyed properties) without asserting a specific shape.
 * Runtime-equivalent to the prior `err as LooseRecord` cast: the cast
 * performed no runtime conversion, only satisfied the type checker. This guard
 * additionally filters out null/primitives that could never carry `.code`/`.name`.
 */
function isErrorObject(value: unknown): value is LooseRecord {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function allowedAgentsFromEnv(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean))];
  } catch {
    return [];
  }
}

function poolWithExecute(value: unknown): AgentPool | null {
  if (!isErrorObject(value) || typeof value.execute !== "function") return null;
  return value as AgentPool;
}

function safePathPart(value: unknown, fallback = "unknown") {
  const raw = typeof value === "string" && value ? value : fallback;
  return raw.replace(/[^A-Za-z0-9._-]/g, "-") || fallback;
}

function phaseWriteAllowOverride(
  phase: string,
  dataRoot: unknown,
  env: unknown,
  agent: unknown,
  jobId: unknown,
  cwd: unknown,
): LooseRecord {
  const baseEnv = { ...recordValue(env) };
  const agentName = typeof agent === "string" ? agent : "";
  const hasExplicitSandbox = Boolean(
    baseEnv.CPB_AGENT_SANDBOX
    || baseEnv.CPB_AGENT_SANDBOX_MODE
    || baseEnv.CPB_AGENT_SANDBOX_COMMAND
    || baseEnv.CPB_AGENT_SANDBOX_INHERITED,
  );
  if (!hasExplicitSandbox) {
    if (agentName === "codex") {
      // Codex already has a phase-aware native sandbox. Avoid nesting it in
      // CPB's outer sandbox, which changes the available toolchain and prevents
      // MCP subprocesses from matching a native Codex run. An explicit CPB
      // sandbox setting still wins when an operator requires one.
      baseEnv.CPB_AGENT_SANDBOX_INHERITED = "1";
    } else {
      baseEnv.CPB_AGENT_SANDBOX = "required";
    }
  }
  if (CLAUDE_COMPATIBLE_AGENT.test(agentName) && baseEnv.CPB_ACP_DISABLE_WEB_TOOLS === "1") {
    installClaudeToolDeny(baseEnv, agentName, [...WEB_MCP_DISABLE_ARGS, ...WEB_DENY_TOOLS]);
  }
  if (!isReadOnlyPhase(phase)) {
    // Claude CLI writes source files inside executionCwd, which its native
    // sandbox always permits. Phase results live under dataRoot, outside that
    // worktree, so explicitly add only the phase-owned output directory.
    // Without this root the executor can complete the code change but cannot
    // persist its structured handoff artifact.
    if (CLAUDE_COMPATIBLE_AGENT.test(agentName) && typeof dataRoot === "string" && dataRoot) {
      const phaseOutput = `${dataRoot}/phase-io/${phase}/*`;
      baseEnv.CPB_ACP_WRITE_ALLOW = mergeCommaList(baseEnv.CPB_ACP_WRITE_ALLOW, phaseOutput);
      baseEnv.CPB_AGENT_SANDBOX_ALLOW_WRITE = mergeCommaList(
        baseEnv.CPB_AGENT_SANDBOX_ALLOW_WRITE,
        phaseOutput,
      );
    }
    return baseEnv;
  }
  const verificationReplayWritable = (
    phase === "verify" || phase === "adversarial_verify"
  ) && (
    baseEnv.CPB_VERIFIER_REPLAY_WORKSPACE_WRITE === "1"
    || baseEnv.CPB_CODEX_VERIFIER_WORKSPACE_WRITE === "1"
  );
  if (verificationReplayWritable && typeof cwd === "string" && cwd) {
    const phaseOutput = typeof dataRoot === "string" && dataRoot
      ? `${dataRoot}/phase-io/${phase}/*`
      : "";
    const writeAllow = mergeCommaList(cwd, phaseOutput);
    baseEnv.CPB_ACP_WRITE_ALLOW = writeAllow;
    baseEnv.CPB_AGENT_SANDBOX_ALLOW_WRITE = writeAllow;
    if (typeof dataRoot === "string" && dataRoot) {
      const isolatedTemp = path.join(dataRoot, "phase-io", phase, ".tmp", safePathPart(jobId, "job"));
      baseEnv.TMPDIR = isolatedTemp;
      baseEnv.TEMP = isolatedTemp;
      baseEnv.TMP = isolatedTemp;
    }
    if (CLAUDE_COMPATIBLE_AGENT.test(agentName)) {
      installClaudeToolDeny(baseEnv, agentName, REPLAY_DENY_TOOLS);
    }
    if (!baseEnv.PYTHONDONTWRITEBYTECODE) baseEnv.PYTHONDONTWRITEBYTECODE = "1";
    return baseEnv;
  }
  const writeAllow = typeof dataRoot === "string" && dataRoot
    ? `${dataRoot}/phase-io/${phase}/*`
    : "__cpb_no_worktree_writes__";
  baseEnv.CPB_ACP_WRITE_ALLOW = writeAllow;
  baseEnv.CPB_AGENT_SANDBOX_ALLOW_WRITE = writeAllow;
  if (typeof dataRoot === "string" && dataRoot) {
    const isolatedTemp = path.join(dataRoot, "phase-io", phase, ".tmp", safePathPart(jobId, "job"));
    baseEnv.TMPDIR = isolatedTemp;
    baseEnv.TEMP = isolatedTemp;
    baseEnv.TMP = isolatedTemp;
  }
  if (CLAUDE_COMPATIBLE_AGENT.test(agentName)) {
    if (phase === "verify") installClaudeToolDeny(baseEnv, agentName, VERIFIER_DENY_TOOLS);
    else if (VALIDATION_PHASES.has(phase)) installClaudeToolDeny(baseEnv, agentName, REPLAY_DENY_TOOLS);
    else installClaudeReadOnlyToolDeny(baseEnv, agentName);
  }
  if (!baseEnv.PYTHONDONTWRITEBYTECODE) baseEnv.PYTHONDONTWRITEBYTECODE = "1";
  return baseEnv;
}

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
  phase,
  role,
  agent,
  variant,
  project,
  jobId,
  prompt,
  cwd,
  pool,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  scope,
  env,
  dataRoot = null,
  onProgress = null,
  conversationKey = null,
  attemptId = null,
  signal = null,
}: LooseRecord) {
  const startedAt = Date.now();
  const agentName = agent === undefined || agent === null ? "" : String(agent);
  const roleName = role === undefined || role === null ? "" : String(role);
  const phaseName = phase === undefined || phase === null ? roleName : String(phase);
  const executionEnv = phaseWriteAllowOverride(phaseName, dataRoot, env, agentName, jobId, cwd);
  const allowedAgents = allowedAgentsFromEnv(executionEnv.CPB_ALLOWED_AGENTS_JSON);

  if (allowedAgents !== null && !allowedAgents.includes(agentName)) {
    return {
      ok: false,
      kind: FailureKind.AGENT_UNAVAILABLE,
      reason: `agent ${agentName || "unknown"} is outside allowed agent policy`,
      retryable: false,
      agent: agentName,
      diagnostics: {
        elapsedMs: Date.now() - startedAt,
        agent: agentName,
        role: roleName,
        hardGate: true,
        allowedAgents,
      },
    };
  }

  try {
    if (isReadOnlyPhase(phaseName) && typeof executionEnv.TMPDIR === "string") {
      await mkdir(executionEnv.TMPDIR, { recursive: true });
    }
    const execPool = poolWithExecute(pool);
    if (!execPool) throw new TypeError("agent pool does not expose execute()");
    const scopeRecord = recordValue(scope);
    const execResult = await execPool.execute(agentName, prompt, cwd, timeoutMs, {
      phase: phaseName,
      role: roleName,
      bypass: false,
      projectId: project,
      jobId,
      attemptId,
      conversationKey: typeof conversationKey === "string" && conversationKey ? conversationKey : undefined,
      variant,
      workspaceId: typeof scopeRecord.workspaceId === "string" ? scopeRecord.workspaceId : undefined,
      cwd,
      env: executionEnv,
      policyHash: typeof scopeRecord.policyHash === "string" ? scopeRecord.policyHash : undefined,
      dataRoot,
      onProgress: typeof onProgress === "function" ? onProgress : undefined,
      signal,
    });
    const execRecord = recordValue(execResult);
    const output = typeof execResult === "string" ? execResult : execRecord.output;
    const providerKey = execRecord.providerKey || null;
    const execVariant = execRecord.variant || null;
    const violation = await readOnlyMutationViolation({
      auditFile: execRecord.acpAuditFile,
      phase: phaseName,
      cwd: typeof cwd === "string" ? cwd : process.cwd(),
      env: executionEnv,
      startedAt,
      sessionId: execRecord.sessionId,
    });
    if (violation) {
      return readOnlyMutationFailure({
        agent: agentName,
        role: roleName,
        startedAt,
        violation,
        execRecord,
      });
    }

    return {
      ok: true,
      agent: agentName,
      output: typeof output === "string" ? output.trim() : String(output).trim(),
      diagnostics: {
        elapsedMs: Date.now() - startedAt,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        cwd: typeof cwd === "string" ? cwd : null,
        agent: agentName,
        role: roleName,
        attemptId: attemptId || null,
        conversationKey: typeof conversationKey === "string" ? conversationKey : null,
        providerKey,
        variant: execVariant,
        acpAuditFile: execRecord.acpAuditFile || null,
        sessionId: execRecord.sessionId || null,
        usage: execRecord.usage || null,
      },
    };
  } catch (err) {
    // Let PoolExhaustedError propagate untouched so managed-worker.js
    // can detect err.code === "POOL_EXHAUSTED" in its catch block.
    if (isErrorObject(err) && (err.code === "POOL_EXHAUSTED" || err.name === "PoolExhaustedError")) {
      throw err;
    }
    return await classifyError(err, { agent: agentName, role: roleName, phase: phaseName, env: executionEnv, startedAt });
  }
}

async function classifyError(err: unknown, { agent, role, phase, env, startedAt }: ClassifyErrorContext) {
  const errorRecord = recordValue(err);
  const msg = typeof errorRecord.message === "string" ? errorRecord.message : String(err || "");
  const lowerMsg = msg.toLowerCase();
  const snippet = msg.slice(0, 500);
  const elapsedMs = Date.now() - startedAt;
  const diagnostics = (extra = {}) => ({
    elapsedMs,
    agent,
    role,
    acpAuditFile: errorRecord.acpAuditFile || null,
    usage: errorRecord.usage || null,
    ...extra,
  });

  const hardConstraintKind = hardConstraintFailureKind(msg);
  if (hardConstraintKind) {
    return {
      ok: false,
      kind: hardConstraintKind,
      reason: msg,
      retryable: true,
      agent,
      diagnostics: diagnostics({ stderrSnippet: snippet }),
    };
  }

  const executeIdleNoEditKind = await executeIdleNoEditFailureKind(msg, phase, env, errorRecord);
  if (executeIdleNoEditKind) {
    return {
      ok: false,
      kind: executeIdleNoEditKind,
      reason: msg,
      retryable: true,
      agent,
      diagnostics: diagnostics({ stderrSnippet: snippet }),
    };
  }

  // Rate limit / ProviderQuotaError
  if (RATE_LIMIT_PATTERN.test(msg) || errorRecord.name === "RateLimitError" || errorRecord.name === "ProviderQuotaError") {
    const untilTs = errorRecord.untilTs || errorRecord.nextEligibleAt || parseResetTime(msg);
    return {
      ok: false,
      kind: FailureKind.AGENT_RATE_LIMITED,
      reason: msg,
      retryable: true,
      agent,
      cause: {
        untilTs,
        status: errorRecord.status || null,
        providerKey: errorRecord.providerKey || agent,
        nextEligibleAt: errorRecord.nextEligibleAt || untilTs,
        source: errorRecord.source || null,
        confidence: errorRecord.confidence ?? null,
        stdout: errorRecord.partialStdout || "",
        stderr: errorRecord.partialStderr || "",
      },
      diagnostics: diagnostics(),
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
      diagnostics: diagnostics({ stderrSnippet: snippet }),
    };
  }

  // Provider transport disconnected after the ACP process started. This is
  // operationally retryable and must not be collapsed into UNKNOWN merely
  // because the adapter did not attach an OS error code.
  if (
    lowerMsg.includes("stream disconnected")
    || lowerMsg.includes("disconnected before completion")
    || lowerMsg.includes("error sending request")
    || lowerMsg.includes("econnreset")
    || lowerMsg.includes("connection reset")
    || lowerMsg.includes("fetch failed")
    || lowerMsg.includes("stdin is closed")
    || lowerMsg.includes("transport is not reusable")
  ) {
    return {
      ok: false,
      kind: FailureKind.AGENT_UNAVAILABLE,
      reason: msg,
      retryable: true,
      agent,
      diagnostics: diagnostics({ stderrSnippet: snippet, transportFailure: true }),
    };
  }

  // Signal / interrupt
  const aborted = errorRecord.name === "AbortError" || errorRecord.code === "ABORT_ERR";
  if (aborted) {
    return {
      ok: false,
      kind: FailureKind.RUNTIME_INTERRUPTED,
      reason: "interrupted by abort signal",
      retryable: false,
      agent,
      signal: errorRecord.signal || null,
      diagnostics: diagnostics({
        exitCode: typeof errorRecord.exitCode === "number" ? errorRecord.exitCode : null,
        signal: errorRecord.signal || null,
        cancelled: true,
      }),
    };
  }
  if (errorRecord.signal || lowerMsg.includes("sigterm") || lowerMsg.includes("sigkill") || lowerMsg.includes("interrupted")) {
    return {
      ok: false,
      kind: FailureKind.RUNTIME_INTERRUPTED,
      reason: `interrupted by ${errorRecord.signal || "signal"}`,
      retryable: true,
      agent,
      signal: errorRecord.signal || null,
      diagnostics: diagnostics({ exitCode: typeof errorRecord.exitCode === "number" ? errorRecord.exitCode : null, signal: errorRecord.signal || null }),
    };
  }

  // Spawn error (ENOENT, child process failed to start)
  if (errorRecord.code === "ENOENT" || lowerMsg.includes("spawn") || lowerMsg.includes("enoent")) {
    return {
      ok: false,
      kind: FailureKind.AGENT_SPAWN_ERROR,
      reason: msg,
      retryable: true,
      agent,
      diagnostics: diagnostics(),
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
      diagnostics: diagnostics({ stderrSnippet: snippet, exitCode: Number(exitMatch[1]), signal: errorRecord.signal || null }),
    };
  }

  // Some child-process adapters report `code=null` when the process vanished
  // before a normal close record was available. This is an abnormal transport
  // termination, not a semantic UNKNOWN failure and not a successful exit.
  if (/\bexited?\s+(?:with\s+)?(?:code\s+)?(?:null|undefined)\b/i.test(msg)) {
    return {
      ok: false,
      kind: FailureKind.AGENT_UNAVAILABLE,
      reason: msg,
      retryable: true,
      agent,
      exitCode: null,
      diagnostics: diagnostics({ stderrSnippet: snippet, transportFailure: true, abnormalExitCode: null }),
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
      diagnostics: diagnostics(),
    };
  }

  // Permission denied
  if (errorRecord.code === "EACCES" || lowerMsg.includes("permission denied")) {
    return {
      ok: false,
      kind: FailureKind.PERMISSION_DENIED,
      reason: msg,
      retryable: false,
      agent,
      diagnostics: diagnostics(),
    };
  }

  // Fallback
  return {
    ok: false,
    kind: FailureKind.UNKNOWN,
    reason: msg,
    retryable: false,
    agent,
    diagnostics: diagnostics(),
  };
}

function parseResetTime(msg: string) {
  const iso = msg.match(/20\d\d-\d\d-\d\d[T\s]\d\d:\d\d:\d\d/);
  if (iso) {
    const ts = Date.parse(iso[0].includes("T") ? iso[0] : iso[0].replace(" ", "T"));
    if (Number.isFinite(ts)) return ts;
  }
  return Date.now() + 60_000;
}

function hardConstraintFailureKind(message: string) {
  if (/agent_output_budget_exceeded/i.test(message)) return FailureKind.AGENT_CONTRACT_INVALID;
  if (/tool(?:_event)?_budget_exceeded/i.test(message)) return FailureKind.TOOL_BUDGET_EXCEEDED;
  if (/broad_test_command_denied/i.test(message)) return FailureKind.BROAD_TEST_COMMAND_DENIED;
  if (/\bexecute_no_edit_progress\b|execute phase exceeded no-edit read\/search limit/i.test(message)) return FailureKind.EXECUTE_NO_EDIT_PROGRESS;
  if (/whole-filesystem find is denied|whole_filesystem_search_denied/i.test(message)) return FailureKind.WHOLE_FILESYSTEM_SEARCH_DENIED;
  if (/read-only phase .*cannot run mutating terminal command/i.test(message)) return FailureKind.READ_ONLY_MUTATION_DENIED;
  if (/web tool use is disabled/i.test(message)) return FailureKind.WEB_TOOL_DENIED;
  return null;
}

function positiveNumberEnv(env: LooseRecord, name: string) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function executeNoEditGuardEnabled(env: LooseRecord) {
  return positiveNumberEnv(env, "CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT") > 0;
}

async function acpAuditHasMutation(auditFile: unknown) {
  if (typeof auditFile !== "string" || !auditFile) return false;
  try {
    const text = await readFile(auditFile, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        try {
          const event = recordValue(JSON.parse(line));
          const title = stringValue(event.title);
          const kind = stringValue(event.kind).toLowerCase();
          return MUTATING_TOOL_TITLE.test(title) || ["edit", "write", "multiedit"].includes(kind);
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

async function executeIdleNoEditFailureKind(
  message: string,
  phase: string,
  env: LooseRecord,
  errorRecord: LooseRecord,
) {
  if (phase !== "execute") return null;
  if (!executeNoEditGuardEnabled(env)) return null;
  if (!/ACP (?:session update|prompt) idle timed out after \d+ms without (?:session updates|activity)/i.test(message)) return null;
  if (await acpAuditHasMutation(errorRecord.acpAuditFile)) return null;
  return FailureKind.EXECUTE_NO_EDIT_PROGRESS;
}
