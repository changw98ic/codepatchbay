import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { LooseRecord } from "../../../core/contracts/types.js";
import {
  checkPermission,
  classifyDeleteRisk,
  evaluatePermissionDecision,
  formatDeleteBlockedMessage,
  logDeleteBlock,
  recordPermissionDenial,
} from "../permission-matrix.js";
import { createAgentHome } from "../../../core/agents/isolation.js";
import { getDescriptor } from "../../../core/agents/registry.js";
import {
  codexConfiguredSandboxModeForExecution,
  codexExecutionConfigArgs,
  codexSandboxEnforcementForExecution,
  codexSandboxModeForExecution,
  headlessCodexConfigArgs,
  classifyUiToolRequest,
  mergeHeadlessDenyTools,
} from "../../../core/acp/policy.js";
import { buildChildEnv } from "../../../core/policy/child-env.js";
import { buildAgentSandboxLaunch } from "../../../core/policy/agent-sandbox.js";
import { redactSecrets } from "../secret-policy.js";
import { captureNativeUsageCursor, readNativeUsageDelta } from "./native-usage.js";

type PermissionDecision = LooseRecord & {
  allowed?: boolean;
  reason?: string;
  classification?: string;
  recoveryGuidance?: string;
  allowedBoundary?: string;
};

type PermissionContext = {
  role: string;
  project: string;
  jobId: string | null;
  phase: string | null;
  cpbRoot: string;
  sourcePath: string | null;
  dataRoot: string | null;
};

type PermissionDenial = {
  targetPath: string;
  action: string;
  ts: number;
  classification?: string;
};

type AgentCommand = {
  command: string;
  args: string[];
  rtkEnabled?: boolean;
};

type McpServerConfig = LooseRecord & {
  name?: string | null;
  type?: string | null;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
};

type McpServerSummary = {
  name: string | null;
  type: string | null;
  url: string | null;
  command: string | null;
  args: string[] | null;
};

type UsageRecord = LooseRecord & {
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  reasoningOutputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  toolCalls?: number | null;
  functionCalls?: number | null;
  events?: number;
  tokenSource?: string | null;
};

const USAGE_METRIC_KEYS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "costUsd",
  "toolCalls",
  "functionCalls",
] as const;
const ACP_STDERR_TAIL_LIMIT = 4000;
const ACP_TERMINAL_AUDIT_TAIL_LIMIT = 1000;

type UsageMetricKey = typeof USAGE_METRIC_KEYS[number];
type UsageMetricCounts = Record<UsageMetricKey, number>;

type JsonRpcErrorEnvelope = {
  code: number;
  message: string;
  data?: unknown;
};

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  [key: string]: unknown;
  id?: JsonRpcId;
  method?: string;
  params?: LooseRecord;
  result?: unknown;
  error?: JsonRpcErrorEnvelope;
};

type AcpInitializeResult = LooseRecord & {
  agentCapabilities?: {
    sessionCapabilities?: {
      close?: boolean;
    };
  };
};

type SessionUpdate = LooseRecord & {
  sessionUpdate?: string;
  content?: {
    type?: string;
    text?: string;
  };
  entries?: Array<{
    status?: string;
    content?: string;
  }>;
  title?: string;
  toolCallId?: string;
  status?: string;
};

type SessionUpdateParams = LooseRecord & {
  update?: SessionUpdate;
  sessionId?: string | null;
};

type ReadTextFileParams = LooseRecord & {
  path: string;
  line?: number;
  limit?: number;
};

type WriteTextFileParams = LooseRecord & {
  path: string;
  content: string;
};

type PermissionOption = LooseRecord & {
  kind?: string;
  optionId?: string;
};

type PermissionRequestParams = LooseRecord & {
  options?: PermissionOption[];
};

type TerminalEnvItem = {
  name?: string;
  value?: string;
};

type TerminalCreateParams = LooseRecord & {
  cwd?: string;
  command: string;
  args?: string[];
  env?: TerminalEnvItem[];
  outputByteLimit?: number;
};

type TerminalIdParams = LooseRecord & {
  terminalId: string;
};

type TerminalExitStatus = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type TerminalEntry = {
  child: ChildProcess;
  cwd: string;
  detached: boolean;
  output: string;
  truncated: boolean;
  outputByteLimit: number;
  exitStatus: TerminalExitStatus | null;
  exitAudit: Promise<void> | null;
  waiters: Array<(status: TerminalExitStatus) => void>;
};

type AuditTarget = {
  file: string | null;
  env: NodeJS.ProcessEnv;
};

type AuditContextOptions = {
  cwd?: string | null;
  writeAllowPaths?: string[] | null;
};


// Permission matrix integration (Stage 3 / #13)
let _permCheck: ((...args: Parameters<typeof checkPermission>) => PermissionDecision) | null = checkPermission;
let _permEvaluate: ((...args: Parameters<typeof evaluatePermissionDecision>) => PermissionDecision) | null = evaluatePermissionDecision;
let _permRecord: ((...args: Parameters<typeof recordPermissionDenial>) => Promise<void>) | null = recordPermissionDenial;
const DENIAL_HISTORY_MAX = 50;
const denialHistory: PermissionDenial[] = [];

function buildPermissionEnv(env: NodeJS.ProcessEnv = process.env): PermissionContext | null {
  const permEnv = {
    role: env.CPB_ACP_ROLE || null,
    project: env.CPB_ACP_PROJECT || null,
    jobId: env.CPB_ACP_JOB_ID || null,
    phase: env.CPB_ACP_PHASE || null,
    cpbRoot: env.CPB_ACP_CPB_ROOT || env.CPB_ROOT || null,
    sourcePath: env.CPB_PROJECT_PATH_OVERRIDE || env.CPB_ACP_CWD || null,
    dataRoot: env.CPB_PROJECT_RUNTIME_ROOT || null,
  };
  if (!permEnv.role || !permEnv.project || !permEnv.cpbRoot) return null;
  return {
    role: permEnv.role,
    project: permEnv.project,
    jobId: permEnv.jobId,
    phase: permEnv.phase,
    cpbRoot: permEnv.cpbRoot,
    sourcePath: permEnv.sourcePath,
    dataRoot: permEnv.dataRoot,
  };
}

function loadPermissionModules(env: NodeJS.ProcessEnv = process.env): PermissionContext | null {
  if (!env.CPB_EXECUTOR_ROOT) return null;
  return buildPermissionEnv(env);
}

function isRepeatedDenial(targetPath: string, action: string) {
  const recent = denialHistory.slice(-3);
  let identicalCount = 0;
  for (const d of recent) {
    if (d.targetPath === targetPath && d.action === action) identicalCount++;
  }
  return identicalCount >= 3;
}

async function enforcePermission(action: string, targetPath: string, env: NodeJS.ProcessEnv = process.env): Promise<PermissionDecision> {
  if (env.CPB_PERMISSION_MODE === "off") return { allowed: true };
  const permEnv = await loadPermissionModules(env);
  if (!_permCheck || !permEnv) return { allowed: true };

  // Use ReAct-style decision envelope when available
  if (_permEvaluate) {
    const decision = _permEvaluate(
      permEnv.role, permEnv.phase, action, targetPath,
      permEnv.cpbRoot, permEnv.project,
      { sourcePath: permEnv.sourcePath, dataRoot: permEnv.dataRoot }
    );

    if (decision.allowed) return decision;

    // Record denial event with classification context
    denialHistory.push({ targetPath, action, ts: Date.now(), classification: decision.classification });
    if (denialHistory.length > DENIAL_HISTORY_MAX) denialHistory.shift();

    if (_permRecord && permEnv.jobId) {
      await _permRecord(permEnv.cpbRoot, permEnv.project, permEnv.jobId, {
        role: permEnv.role,
        action,
        targetPath,
        reason: decision.reason || "action denied by permission matrix",
        phase: permEnv.phase,
        allowedBoundary: "",
        recoveryGuidance: decision.recoveryGuidance || "",
        dataRoot: permEnv.dataRoot,
      }).catch(() => {});
    }

    return decision;
  }

  // Fallback to legacy checkPermission
  const result = _permCheck(permEnv.role, action, targetPath, permEnv.cpbRoot, permEnv.project, {
    sourcePath: permEnv.sourcePath,
    jobId: permEnv.jobId,
    dataRoot: permEnv.dataRoot,
  });

  if (result.allowed) return result;

  denialHistory.push({ targetPath, action, ts: Date.now() });
  if (denialHistory.length > DENIAL_HISTORY_MAX) denialHistory.shift();

  if (_permRecord && permEnv.jobId) {
    await _permRecord(permEnv.cpbRoot, permEnv.project, permEnv.jobId, {
      role: permEnv.role,
      action,
      targetPath,
      reason: result.reason || "write denied by permission matrix",
      phase: permEnv.phase,
      allowedBoundary: result.allowedBoundary || "",
      recoveryGuidance: result.recoveryGuidance || "",
      dataRoot: permEnv.dataRoot,
    }).catch(() => {});
  }

  return result;
}

function enforcePermissionSync(action: string, target: string, env: NodeJS.ProcessEnv = process.env): PermissionDecision {
  if (env.CPB_PERMISSION_MODE === "off") return { allowed: true };
  const permEnv = buildPermissionEnv(env);
  if (!_permCheck || !permEnv) return { allowed: true };

  // Use ReAct-style decision envelope when available
  if (_permEvaluate) {
    const decision = _permEvaluate(
      permEnv.role, permEnv.phase, action, target,
      permEnv.cpbRoot, permEnv.project,
      { sourcePath: permEnv.sourcePath, dataRoot: permEnv.dataRoot }
    );
    if (decision.allowed) return decision;

    denialHistory.push({ targetPath: target, action, ts: Date.now(), classification: decision.classification });
    if (denialHistory.length > DENIAL_HISTORY_MAX) denialHistory.shift();
    if (_permRecord && permEnv.jobId) {
      _permRecord(permEnv.cpbRoot, permEnv.project, permEnv.jobId, {
        role: permEnv.role,
        action,
        targetPath: target,
        reason: decision.reason || "action denied by permission matrix",
        phase: permEnv.phase,
        recoveryGuidance: decision.recoveryGuidance || "",
        dataRoot: permEnv.dataRoot,
      }).catch(() => {});
    }
    return decision;
  }

  // Legacy path
  const result = _permCheck(permEnv.role, action, target, permEnv.cpbRoot, permEnv.project, {
    sourcePath: permEnv.sourcePath,
    jobId: permEnv.jobId,
    dataRoot: permEnv.dataRoot,
  });
  if (result.allowed) return result;
  denialHistory.push({ targetPath: target, action, ts: Date.now() });
  if (denialHistory.length > DENIAL_HISTORY_MAX) denialHistory.shift();
  if (_permRecord && permEnv.jobId) {
    _permRecord(permEnv.cpbRoot, permEnv.project, permEnv.jobId, {
      role: permEnv.role,
      action,
      targetPath: target,
      reason: result.reason || "action denied by permission matrix",
      phase: permEnv.phase,
      dataRoot: permEnv.dataRoot,
    }).catch(() => {});
  }
  return result;
}

const PROTOCOL_VERSION = 1;
const DEFAULT_CLOSE_SESSION_TIMEOUT_MS = 500;

function nonNegativeInteger(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function parseToolPolicy(env: NodeJS.ProcessEnv = process.env): Promise<Map<string, string> | null> {
  const policyFilePath = env.CPB_ACP_TOOL_POLICY_FILE;

  // 1. Highest priority: JSON policy file
  if (policyFilePath) {
    let content;
    try {
      content = await readFile(path.resolve(policyFilePath), "utf8");
    } catch (error) {
      throw new Error(`CPB_ACP_TOOL_POLICY_FILE: failed to read "${policyFilePath}": ${error.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(`CPB_ACP_TOOL_POLICY_FILE: invalid JSON in "${policyFilePath}": ${error.message}`);
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`CPB_ACP_TOOL_POLICY_FILE: expected a JSON object {"tool/name": "allow"|"deny"}, got ${Array.isArray(parsed) ? "array" : typeof parsed}`);
    }

    const policy = new Map<string, string>();
    for (const [tool, action] of Object.entries(parsed)) {
      if (action !== "allow" && action !== "deny") {
        throw new Error(`CPB_ACP_TOOL_POLICY_FILE: invalid action "${action}" for tool "${tool}" (must be "allow" or "deny")`);
      }
      policy.set(tool, action);
    }
    return policy;
  }

  // 2. Flat env var format
  const denyTools = env.CPB_ACP_DENY_TOOLS;
  const allowTools = env.CPB_ACP_ALLOW_TOOLS;

  if (denyTools || allowTools) {
    const policy = new Map<string, string>();

    if (denyTools) {
      for (const tool of denyTools.split(",")) {
        const trimmed = tool.trim();
        if (trimmed) policy.set(trimmed, "deny");
      }
    }

    if (allowTools) {
      for (const tool of allowTools.split(",")) {
        const trimmed = tool.trim();
        if (trimmed) policy.set(trimmed, "allow");
      }
    }

    return policy.size > 0 ? policy : null;
  }

  // 3. Legacy: CPB_ACP_TERMINAL=deny maps to terminal/create=deny
  if (env.CPB_ACP_TERMINAL === "deny") {
    const policy = new Map();
    policy.set("terminal/create", "deny");
    return policy;
  }

  return null;
}

function commandExists(command: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], { env });
  return result.status === 0;
}

function splitWords(input: string) {
  const words = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (const char of input) {
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
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (quote) throw new Error("unterminated quote in ACP args");
  if (current) words.push(current);
  return words;
}

function parseEnvArgs(value: string | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("ACP args JSON must be an array of strings");
    }
    return parsed;
  }
  return splitWords(trimmed);
}

function safeAuditSegment(value: unknown, fallback: string) {
  const raw = String(value || fallback || "unknown").trim();
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return safe || fallback || "unknown";
}

export function resolveAcpAuditFile(env = process.env) {
  if (env.CPB_ACP_AUDIT_FILE) return path.resolve(env.CPB_ACP_AUDIT_FILE);
  if (env.CPB_ACP_AUDIT === "0") return null;

  const dataRoot = env.CPB_PROJECT_RUNTIME_ROOT;
  const project = env.CPB_ACP_PROJECT || env.CPB_PROJECT;
  const jobId = env.CPB_ACP_JOB_ID || env.CPB_JOB_ID;
  if (!dataRoot || !project || !jobId) return null;

  return path.join(
    path.resolve(dataRoot),
    "acp-audit",
    safeAuditSegment(project, "project"),
    `${safeAuditSegment(jobId, "job")}.jsonl`,
  );
}

function summarizeMcpServers(servers: McpServerConfig[] = []): McpServerSummary[] {
  if (!Array.isArray(servers)) return [];
  return servers.map((server) => ({
    name: server?.name || null,
    type: server?.type || null,
    url: server?.url || null,
    command: server?.command || null,
    args: Array.isArray(server?.args) ? server.args : null,
  }));
}

function summarizeToolUpdate(update: LooseRecord = {}): LooseRecord {
  return {
    sessionUpdate: update.sessionUpdate || null,
    toolCallId: update.toolCallId || update.id || null,
    title: update.title || update.name || update.toolName ? String(update.title || update.name || update.toolName) : null,
    status: update.status || null,
    kind: update.kind || null,
    serverName: update.serverName || update.mcpServerName || update.mcp_server_name || null,
    toolName: update.toolName || update.name || null,
  };
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function toolCallFingerprint(summary: LooseRecord = {}) {
  const toolCallId = textValue(summary.toolCallId).trim();
  if (toolCallId) return `id:${toolCallId}`;
  return [
    summary.toolName,
    summary.title,
    summary.kind,
    summary.serverName,
  ].map((value) => textValue(value).trim()).join("|");
}

function toolCallBudget(env: NodeJS.ProcessEnv = process.env) {
  const phase = textValue(env.CPB_ACP_PHASE).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const phaseBudget = phase ? nonNegativeInteger(env[`CPB_ACP_TOOL_CALL_BUDGET_${phase}`], -1) : -1;
  if (phaseBudget >= 0) return phaseBudget;
  return nonNegativeInteger(env.CPB_ACP_TOOL_CALL_BUDGET, 0);
}

function toolEventBudget(env: NodeJS.ProcessEnv = process.env) {
  const phase = textValue(env.CPB_ACP_PHASE).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const phaseBudget = phase ? nonNegativeInteger(env[`CPB_ACP_TOOL_EVENT_BUDGET_${phase}`], -1) : -1;
  if (phaseBudget >= 0) return phaseBudget;
  return nonNegativeInteger(env.CPB_ACP_TOOL_EVENT_BUDGET, 0);
}

function promptIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  return nonNegativeInteger(
    env.CPB_ACP_IDLE_TIMEOUT_MS,
    nonNegativeInteger(env.CPB_ACP_TIMEOUT_MS, 0),
  );
}

function sessionUpdateIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const explicit = nonNegativeInteger(env.CPB_ACP_SESSION_UPDATE_IDLE_TIMEOUT_MS, -1);
  if (explicit >= 0) return explicit;
  return 0;
}

function executeNoEditToolLimit(env: NodeJS.ProcessEnv = process.env) {
  if (env.CPB_ACP_PHASE !== "execute") return 0;
  return nonNegativeInteger(env.CPB_ACP_EXECUTE_NO_EDIT_TOOL_LIMIT, 0);
}

function executeNoEditIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  if (executeNoEditToolLimit(env) <= 0) return 0;
  const explicit = nonNegativeInteger(env.CPB_ACP_EXECUTE_NO_EDIT_IDLE_TIMEOUT_MS, -1);
  if (explicit >= 0) return explicit;
  return sessionUpdateIdleTimeoutMs(env);
}

function executeNoEditClassification() {
  return "execute_no_edit_progress";
}

function executeNoEditSubject() {
  return "execute phase";
}

function taskRiskPolicySummary(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.CPB_TASK_PHASE_BUDGET_POLICY_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { raw };
    return {
      source: parsed.source || null,
      riskLevel: parsed.riskLevel || null,
      verificationDepth: parsed.verificationDepth || null,
      adversarialRequired: parsed.adversarialRequired === true,
      evidenceRequirements: Array.isArray(parsed.evidenceRequirements) ? parsed.evidenceRequirements : [],
      phases: parsed.phases && typeof parsed.phases === "object" && !Array.isArray(parsed.phases) ? parsed.phases : {},
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
    };
  } catch {
    return { raw };
  }
}

export type AcpRuntimeGuards = {
  promptIdleTimeoutMs: number;
  sessionUpdateIdleTimeoutMs: number;
  executeNoEditIdleTimeoutMs: number;
  toolCallBudget: number;
  toolEventBudget: number;
  executeNoEditToolLimit: number;
  taskRiskPolicy: LooseRecord | null;
};

/** Resolve the phase-aware runtime guard contract shared by every agent transport. */
export function resolveAcpRuntimeGuards(env: NodeJS.ProcessEnv = process.env): AcpRuntimeGuards {
  return {
    promptIdleTimeoutMs: promptIdleTimeoutMs(env),
    sessionUpdateIdleTimeoutMs: sessionUpdateIdleTimeoutMs(env),
    executeNoEditIdleTimeoutMs: executeNoEditIdleTimeoutMs(env),
    toolCallBudget: toolCallBudget(env),
    toolEventBudget: toolEventBudget(env),
    executeNoEditToolLimit: executeNoEditToolLimit(env),
    taskRiskPolicy: taskRiskPolicySummary(env),
  };
}

function isReadOrSearchToolUpdate(summary: LooseRecord = {}) {
  const kind = textValue(summary.kind).trim().toLowerCase();
  if (kind === "read" || kind === "search") return true;
  const text = [
    summary.title,
    summary.toolName,
    summary.serverName,
  ].map((value) => textValue(value).trim()).filter(Boolean).join(" ");
  return /\b(?:Read(?:\s+File)?|Search|Grep|Glob)\b/i.test(text);
}

function isMutatingToolUpdate(summary: LooseRecord = {}) {
  const kind = textValue(summary.kind).trim().toLowerCase();
  if (["edit", "write", "multi_edit", "mutation"].includes(kind)) return true;
  const text = [
    summary.title,
    summary.toolName,
    summary.serverName,
  ].map((value) => textValue(value).trim()).filter(Boolean).join(" ");
  return /\b(?:Edit|Write|MultiEdit|Apply\s+Patch|write_text_file|fs\/write_text_file)\b/i.test(text);
}

function numberFrom(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isRecord(value: unknown): value is LooseRecord {
  return !!value && typeof value === "object";
}

function firstNumber(source: unknown, keys: string[] = []): number | null {
  if (!isRecord(source)) return null;
  for (const key of keys) {
    if (Object.hasOwn(source, key)) {
      const value = numberFrom(source[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function createUsageTotals(): UsageRecord {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    toolCalls: 0,
    functionCalls: 0,
    events: 0,
    tokenSource: null,
  };
}

function createUsageMetricCounts(): UsageMetricCounts {
  return Object.fromEntries(USAGE_METRIC_KEYS.map((key) => [key, 0])) as UsageMetricCounts;
}

function cloneUsageTotals(totals: UsageRecord | null): UsageRecord {
  return { ...createUsageTotals(), ...(totals || {}) };
}

function normalizeAcpUsage(update: LooseRecord = {}): UsageRecord | null {
  const metrics = isRecord(update.metrics) ? update.metrics : {};
  const cost = isRecord(update.cost) ? update.cost : {};
  const candidates = [
    ["usage", update.usage],
    ["tokenUsage", update.tokenUsage],
    ["tokens", update.tokens],
    ["modelUsage", update.modelUsage],
    ["metrics.usage", metrics.usage],
    ["cost.usage", cost.usage],
  ] as Array<[string, unknown]>;
  if (update.sessionUpdate === "usage" || update.sessionUpdate === "token_usage") {
    candidates.push(["sessionUpdate", update]);
  }

  for (const [source, candidate] of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "number") {
      return {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        totalTokens: candidate,
        costUsd: null,
        toolCalls: null,
        functionCalls: null,
        tokenSource: source,
      };
    }
    if (typeof candidate !== "object" || Array.isArray(candidate)) continue;

    const inputTokens = firstNumber(candidate, [
      "inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "prompt", "input",
    ]);
    const cachedInputTokens = firstNumber(candidate, [
      "cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens", "cacheReadTokens",
    ]);
    const outputTokens = firstNumber(candidate, [
      "outputTokens", "output_tokens", "completionTokens", "completion_tokens", "completion", "output",
    ]);
    const reasoningOutputTokens = firstNumber(candidate, [
      "reasoningOutputTokens", "reasoning_output_tokens", "reasoningTokens", "reasoning_tokens",
    ]);
    let totalTokens = firstNumber(candidate, ["totalTokens", "total_tokens", "total", "tokens"]);
    if (totalTokens === null) {
      // Provider APIs generally report reasoning tokens as a subset of output
      // tokens. Adding them again inflates totals; only input + output define
      // the fallback total when the provider omits an explicit total.
      const computed = [inputTokens, outputTokens]
        .filter((value) => value !== null)
        .reduce((sum, value) => sum + value, 0);
      totalTokens = computed > 0 ? computed : null;
    }
    const costUsd = firstNumber(candidate, ["costUsd", "costUSD", "totalCostUsd", "total_cost_usd", "usd"]);
    const toolCalls = firstNumber(candidate, ["toolCalls", "tool_calls"]);
    const functionCalls = firstNumber(candidate, ["functionCalls", "function_calls"]);

    if ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens, costUsd, toolCalls, functionCalls].every((value) => value === null)) {
      continue;
    }

    return {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,
      costUsd,
      toolCalls,
      functionCalls,
      tokenSource: source,
    };
  }

  return null;
}

function addUsage(totals: UsageRecord, usage: UsageRecord | null, reportedCounts: UsageMetricCounts): void {
  if (!usage) return;
  for (const key of USAGE_METRIC_KEYS) {
    const value = numberFrom(usage[key]);
    if (value !== null) {
      totals[key] = (numberFrom(totals[key]) ?? 0) + value;
      reportedCounts[key] += 1;
    }
  }
  totals.events = (numberFrom(totals.events) ?? 0) + 1;
  totals.tokenSource = String(usage.tokenSource || totals.tokenSource || "acp_session_update");
}

function usageDelta(
  before: UsageRecord,
  after: UsageRecord,
  reportedBefore: UsageMetricCounts,
  reportedAfter: UsageMetricCounts,
): UsageRecord | null {
  const delta = createUsageTotals();
  for (const key of USAGE_METRIC_KEYS) {
    delta[key] = reportedAfter[key] > reportedBefore[key]
      ? Math.max(0, (numberFrom(after?.[key]) || 0) - (numberFrom(before?.[key]) || 0))
      : null;
  }
  delta.events = Math.max(0, (numberFrom(after.events) || 0) - (numberFrom(before.events) || 0));
  if ((numberFrom(delta.events) ?? 0) <= 0) return null;
  delta.tokenSource = String(after?.tokenSource || "acp_session_update");
  return delta;
}

// ACP adapter lookup table — replaces hardcoded per-agent resolution
const ACP_ADAPTERS = {
  codex:    { command: "codex-acp",         args: [],            npxPkg: "@zed-industries/codex-acp" },
  claude:   { command: "claude-agent-acp",  args: [],            npxPkg: "@agentclientprotocol/claude-agent-acp" },
  reasonix: { command: "reasonix",          args: ["acp"],       npxPkg: null },
};

function isKnownAdapter(agent: string): agent is keyof typeof ACP_ADAPTERS {
  return agent in ACP_ADAPTERS;
}

function defaultAgentCommand(agent: string): AgentCommand | null {
  const entry = isKnownAdapter(agent) ? ACP_ADAPTERS[agent] : null;
  if (!entry) return null;
  if (commandExists(entry.command)) return { command: entry.command, args: entry.args };
  if (entry.npxPkg) return { command: "npx", args: ["-y", entry.npxPkg] };
  // Reasonix-style: binary itself is the adapter, return as-is
  return { command: entry.command, args: entry.args };
}

export async function resolveAgentCommand(agent: string, env: NodeJS.ProcessEnv = process.env): Promise<AgentCommand> {
  // Try registry-based resolution first
  try {
    const { loadRegistry, getDescriptor, hasAgent } = await import("../../../core/agents/registry.js");
    // retain: dynamic signature mismatch — registry.ts declares loadRegistry(configDir: string) as required,
    // but its body short-circuits on `_loaded && !configDir`, so a no-arg call is runtime-safe. Fixing the
    // source signature is out of scope (cross-module); cast relaxes the param to optional here.
    await (loadRegistry as (configDir?: string) => Promise<void>)();
    if (hasAgent(agent)) {
      const descriptor = getDescriptor(agent);
      if (descriptor) {
        const prefix = descriptor.envPrefix || `CPB_ACP_${agent.toUpperCase()}`;
        const envCommand = env[`${prefix}_COMMAND`];
        let command = envCommand || descriptor.command;
        let args = parseEnvArgs(env[`${prefix}_ARGS`]) ?? [...(descriptor.args || [])];

        // Fallback: if primary command not found and descriptor has fallback
        if (!envCommand && descriptor.fallbackCommand && !commandExists(command)) {
          command = descriptor.fallbackCommand;
          args = [...(descriptor.fallbackArgs || [])];
        }

        appendCodexLaunchConfigArgs(agent, command, args, env);

        return { command, args };
      }
    }
  } catch {
    // Registry unavailable, fall through to legacy
  }

  // Legacy hardcoded resolution
  const defaults = defaultAgentCommand(agent);
  if (!defaults) {
    throw new Error(`Unknown agent: '${agent}'. Register a descriptor or set CPB_ACP_${agent.toUpperCase()}_COMMAND.`);
  }
  const upper = agent.toUpperCase();
  const command = env[`CPB_ACP_${upper}_COMMAND`] || defaults.command;
  const args = parseEnvArgs(env[`CPB_ACP_${upper}_ARGS`]) ?? [...defaults.args];

  appendCodexLaunchConfigArgs(agent, command, args, env);

  return { command, args };
}

export function shouldIsolateAgentHome(agent: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CPB_AGENT_ISOLATE_HOME === "0") return false;
  return true;
}

function jsonRpcError(code: number, message: string, data?: unknown): JsonRpcErrorEnvelope {
  const err: JsonRpcErrorEnvelope = { code, message };
  if (data) err.data = data;
  return err;
}

export function resolveWriteAllowPaths(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] | null {
  return env.CPB_ACP_WRITE_ALLOW
    ? env.CPB_ACP_WRITE_ALLOW.split(",").map((p: string) => canonicalWriteAllowPattern(p.trim(), cwd))
    : null;
}

function canonicalWriteAllowPattern(pattern: string, cwd: string) {
  const absolute = path.resolve(cwd, pattern);
  const wildcardIndex = absolute.indexOf("*");
  const fixedPrefix = wildcardIndex >= 0 ? absolute.slice(0, wildcardIndex) : absolute;
  const wildcardSuffix = wildcardIndex >= 0 ? absolute.slice(wildcardIndex) : "";
  const trailingSeparator = fixedPrefix.endsWith(path.sep);
  const canonical = canonicalPotentialPath(trailingSeparator ? fixedPrefix.slice(0, -1) : fixedPrefix);
  return `${canonical}${trailingSeparator ? path.sep : ""}${wildcardSuffix}`;
}

function canonicalPotentialPath(absolutePath: string) {
  let current = path.resolve(absolutePath);
  const unresolved: string[] = [];
  while (current && !existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    unresolved.unshift(path.basename(current));
    current = parent;
  }
  let canonical = current;
  try {
    canonical = realpathSync(current);
  } catch {}
  return path.join(canonical, ...unresolved);
}

function resolveCodegraphMcpServer(env: NodeJS.ProcessEnv): McpServerConfig | null {
  if (env.CPB_CODEGRAPH_ENABLED === "0") return null;
  const codebaseRoot = path.resolve(
    env.CPB_CODEGRAPH_ROOT ||
    env.CPB_ACP_CWD ||
    env.CPB_CODEBASE_ROOT ||
    env.CPB_PROJECT_PATH_OVERRIDE ||
    process.cwd(),
  );
  return {
    name: "codegraph",
    command: "codegraph",
    args: ["serve", "--mcp", "--path", codebaseRoot],
  };
}

function codexCodegraphMcpServers(env: NodeJS.ProcessEnv): McpServerConfig[] {
  const server = resolveCodegraphMcpServer(env);
  return server ? [server] : [];
}

function isCodexAcpCommand(command: unknown, args: unknown[] = []): boolean {
  const baseCommand = String(command).split("/").pop();
  if (baseCommand === "codex-acp") return true;
  return baseCommand === "npx" && Array.isArray(args) && args.some((arg) => arg === "@zed-industries/codex-acp");
}

export function buildMcpServers(agent: string, env: NodeJS.ProcessEnv): McpServerConfig[] {
  const server = resolveCodegraphMcpServer(env);
  if (!server) return [];

  // Codex ACP rejects non-empty session/new.mcpServers. It receives built-in
  // CodeGraph through process-local launch config instead.
  if (agent === "codex") return [];

  // ACP adapters must opt in to session/new.mcpServers. Some adapters exit
  // after rejecting this field, so retrying with [] is too late because the
  // process is already gone.
  try {
    if (getDescriptor(agent)?.sessionMcpServers === false) return [];
  } catch {
    // Test/custom agents without a loaded registry retain protocol fallback.
  }

  // Claude ACP requires SSE-based MCP servers with a "type" field.
  // When CPB_CODEGRAPH_PORT is set, expose CodeGraph as an SSE endpoint.
  const port = Number(env.CPB_CODEGRAPH_PORT);
  if (Number.isFinite(port) && port > 0) {
    return [{ name: server.name, type: "sse", url: `http://localhost:${port}` }];
  }

  // Fallback: stdio-based MCP server for adapters that support it.
  return [{ name: server.name, type: "stdio", command: server.command, args: server.args }];
}

function resolveTerminalLaunchCommand(command: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): AgentCommand {
  if (env.CPB_ACP_RTK_ENABLED === "0") {
    return { command, args, rtkEnabled: false };
  }
  if (path.basename(String(command || "")) === "rtk") {
    return { command, args, rtkEnabled: true };
  }
  if (!commandExists("rtk", env)) {
    return { command, args, rtkEnabled: false };
  }
  return {
    command: "rtk",
    args: [command, ...args],
    rtkEnabled: true,
  };
}

function shellQuoteForScan(value: string) {
  return value.replace(/\\(["'`$\\])/g, "$1");
}

function commandTextForGuard(command: string, args: string[] = []) {
  return [command, ...args]
    .map((part) => shellQuoteForScan(String(part || "")))
    .join(" ");
}

function shellPayloadForGuard(command: string, args: string[] = []) {
  const baseCommand = path.basename(String(command || ""));
  if ((baseCommand === "sh" || baseCommand === "bash" || baseCommand === "zsh") && args[0] === "-c" && typeof args[1] === "string") {
    return args[1];
  }
  return commandTextForGuard(command, args);
}

function normalizeGuardCommand(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeCanonicalTestCommand(value: string) {
  return normalizeGuardCommand(value).replace(/\s+2>&1\s*$/i, "");
}

function wholeFilesystemSearchReason(command: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  if (env.CPB_ACP_ALLOW_WHOLE_FS_SEARCH === "1") return null;
  const text = shellPayloadForGuard(command, args);
  if (/(^|[\s;&|({])(?:sudo\s+)?find\s+\/(?=\s|$)/.test(text)) {
    return "whole-filesystem find is denied; search the current worktree, CPB_ACP_CWD, CPB_PROJECT_RUNTIME_ROOT, or CPB_HUB_ROOT instead";
  }
  return null;
}

function parseCanonicalTestCommands(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.CPB_CANONICAL_TEST_COMMANDS_JSON || "";
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseDiagnosticTestCommands(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.CPB_DIAGNOSTIC_TEST_COMMANDS_JSON || "";
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function isDjangoTestCommand(payload: string) {
  return /\b(?:python(?:\d+(?:\.\d+)?)?|python3)\s+tests\/runtests\.py(?:\s|$|[;&|])/i.test(payload);
}

function isPytestTestCommand(payload: string) {
  return /\b(?:python(?:\d+(?:\.\d+)?)?|python3)\s+-m\s+pytest(?:\s|$|[;&|])/i.test(payload)
    || /(^|[\s;&|({])pytest(?:\s|$|[;&|])/i.test(payload);
}

function isPackageTestCommand(payload: string) {
  return /(^|[\s;&|({])(?:npm|pnpm|yarn)\s+(?:test|run\s+test)(?:\s|$|[;&|])/i.test(payload);
}

function isAdHocTestScript(payload: string) {
  return /\/tmp\/[^\s;&|]+\.py\b/.test(payload)
    && /(^|[\s;&|({])(?:cat\s+>\s*\/tmp\/[^\s;&|]+\.py|(?:python(?:\d+(?:\.\d+)?)?|python3)\s+\/tmp\/[^\s;&|]+\.py)\b/i.test(payload)
    && /\b(?:django|pytest|runtests\.py|tests\.|DJANGO_SETTINGS_MODULE|unittest)\b/i.test(payload);
}

function isInlineTestScript(payload: string) {
  return /(^|[\s;&|({])(?:python(?:\d+(?:\.\d+)?)?|python3)\s+-c\s+/i.test(payload)
    && /\b(?:django|pytest|runtests\.py|tests\.|DJANGO_SETTINGS_MODULE|unittest|TestCase|assert)\b/i.test(payload);
}

function exactTestCommandBlock(command: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  if (env.CPB_ACP_EXACT_TEST_COMMAND_GUARD !== "1") return null;
  const payload = normalizeGuardCommand(shellPayloadForGuard(command, args));
  const canonicalCommands = parseCanonicalTestCommands(env);
  const canonicalSet = new Set(canonicalCommands.map(normalizeCanonicalTestCommand));
  if (canonicalSet.has(normalizeCanonicalTestCommand(payload))) return null;
  const diagnosticCommands = parseDiagnosticTestCommands(env);
  const diagnosticSet = new Set(diagnosticCommands.map(normalizeGuardCommand));
  if (diagnosticSet.has(normalizeGuardCommand(payload))) return null;
  const adHocScript = isAdHocTestScript(payload) || isInlineTestScript(payload);
  if (!adHocScript && !isDjangoTestCommand(payload) && !isPytestTestCommand(payload) && !isPackageTestCommand(payload)) return null;
  const detail = adHocScript
    ? "ad hoc test scripts are not allowed by the exact-command policy"
    : "test command is broader than the listed canonical commands";
  return {
    classification: "broad_test_command_denied",
    offendingCommand: payload,
    canonicalCommands,
    diagnosticCommands,
    reason: `broad_test_command_denied: ${detail}. Offending command: ${payload}. Canonical commands: ${canonicalCommands.join(" | ") || "(none)"}. Explicit diagnostic commands: ${diagnosticCommands.join(" | ") || "(none)"}`,
  };
}

const MUTATING_TERMINAL_PHASES = new Set(["execute", "remediate", "executor", "remediator"]);
const READ_ONLY_MUTATING_SHELL_PATTERNS: Array<[RegExp, string]> = [
  [/(^|[\s;&|({])git\s+stash(?!(?:\s+(?:list|show)(?:\s|$|[;&|)])))(?=\s|$)/, "git stash"],
  [/(^|[\s;&|({])git\s+reset(?=\s|$)/, "git reset"],
  [/(^|[\s;&|({])git\s+checkout(?=\s|$)/, "git checkout"],
  [/(^|[\s;&|({])git\s+restore(?=\s|$)/, "git restore"],
  [/(^|[\s;&|({])git\s+clean(?=\s|$)/, "git clean"],
  [/(^|[\s;&|({])git\s+apply(?=\s|$)/, "git apply"],
  [/(^|[\s;&|({])git\s+am(?=\s|$)/, "git am"],
  [/(^|[\s;&|({])git\s+merge(?=\s|$)/, "git merge"],
  [/(^|[\s;&|({])git\s+rebase(?=\s|$)/, "git rebase"],
  [/(^|[\s;&|({])git\s+commit(?=\s|$)/, "git commit"],
  [/(^|[\s;&|({])git\s+add(?=\s|$)/, "git add"],
  [/(^|[\s;&|({])git\s+rm(?=\s|$)/, "git rm"],
  [/(^|[\s;&|({])git\s+mv(?=\s|$)/, "git mv"],
  [/(^|[\s;&|({])(?:python(?:\d+(?:\.\d+)?)?|python3)\s+-m\s+pip\s+install(?=\s|$)/, "pip install"],
  [/(^|[\s;&|({])pip(?:3)?\s+install(?=\s|$)/, "pip install"],
  [/(^|[\s;&|({])(?:npm|pnpm|yarn)\s+(?:install|add)(?=\s|$)/, "package install"],
  [/(^|[\s;&|({])(?:sed|gsed)\s+[^;&|]*\s-i(?:\s|$)/, "sed -i"],
  [/(^|[\s;&|({])(?:perl|ruby)\s+[^;&|]*\s-[^;&|]*i[^;&|]*(?:\s|$)/, "in-place script edit"],
];

function readOnlyTerminalMutationReason(command: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  const phase = env.CPB_ACP_PHASE || "";
  if (!phase || MUTATING_TERMINAL_PHASES.has(phase)) return null;
  if (env.CPB_ACP_ALLOW_READONLY_TERMINAL_MUTATION === "1") return null;
  const text = commandTextForGuard(command, args);
  for (const [pattern, label] of READ_ONLY_MUTATING_SHELL_PATTERNS) {
    if (!pattern.test(text)) continue;
    return `read-only phase "${phase}" cannot run mutating terminal command (${label}); use non-mutating inspection, run tests as-is, or copy the worktree to a temporary directory first`;
  }
  return null;
}

function toolUpdateTextForGuard(update: LooseRecord = {}) {
  return [
    update.title,
    update.name,
    update.toolName,
    update.kind,
    update.serverName,
    update.mcpServerName,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ");
}

function toolUpdateCommandTextForGuard(update: LooseRecord = {}) {
  return [
    update.title,
    update.name,
    update.toolName,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ");
}

function disabledWebToolReason(update: LooseRecord = {}, env: NodeJS.ProcessEnv = process.env) {
  if (env.CPB_ACP_DISABLE_WEB_TOOLS !== "1") return null;
  const text = toolUpdateTextForGuard(update);
  if (/\b(?:Web search|webReader|WebSearch|WebFetch)\b/i.test(text) || /\bfetch\b/i.test(String(update.kind || ""))) {
    return "web tool use is disabled for this ACP run; use the checked-out repository, task text, and local tests instead";
  }
  return null;
}

const CLAUDE_COMPATIBLE_AGENT = /^(?:claude|claude-.+)$/;

function readOnlyToolUpdateMutationReason(update: LooseRecord = {}, env: NodeJS.ProcessEnv = process.env) {
  const phase = String(env.CPB_ACP_PHASE || "").trim().toLowerCase();
  const kind = String(update.kind || "").trim().toLowerCase();
  if (phase && !MUTATING_TERMINAL_PHASES.has(phase) && ["edit", "write", "multi_edit"].includes(kind)) {
    return `read-only phase "${phase}" cannot use a mutating ${kind} tool`;
  }
  const text = toolUpdateTextForGuard(update);
  if (!text) return null;
  return readOnlyTerminalMutationReason(text, [], env);
}

function wholeFilesystemToolUpdateSearchReason(update: LooseRecord = {}, env: NodeJS.ProcessEnv = process.env) {
  const text = toolUpdateCommandTextForGuard(update);
  if (!text) return null;
  return wholeFilesystemSearchReason(text, [], env);
}

function codexMcpConfigArgs(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const server of codexCodegraphMcpServers(env)) {
    if (!server?.name || !server.command || !Array.isArray(server.args)) continue;
    const prefix = `mcp_servers.${server.name}`;
    args.push("-c", `${prefix}.command=${JSON.stringify(server.command)}`);
    args.push("-c", `${prefix}.args=${JSON.stringify(server.args)}`);
  }
  return args;
}

function appendCodexLaunchConfigArgs(agent: string, command: string, args: string[], env: NodeJS.ProcessEnv): void {
  if (agent !== "codex" || !isCodexAcpCommand(command, args)) return;

  if (env.CPB_ACP_LAUNCH_PROFILE !== "ui") {
    const headlessArgs = headlessCodexConfigArgs(command, args);
    if (headlessArgs.length > 0) args.push(...headlessArgs);
  }

  const mcpArgs = codexMcpConfigArgs(env);
  if (mcpArgs.length > 0) args.push(...mcpArgs);

  // Append last so the phase contract wins over an isolated or stale Codex
  // home. Managed Codex requirements can still reject a disallowed mode and
  // surface a concrete environment failure instead of silently running read-only.
  args.push(...codexExecutionConfigArgs(command, args, env));
}

function processPathVariants(targetPath: string | null | undefined): string[] {
  if (!targetPath) return [];
  const variants = new Set<string>();
  const resolved = path.resolve(targetPath);
  variants.add(resolved);
  try {
    variants.add(realpathSync(resolved));
  } catch {
    // The path may have already been removed during worktree cleanup.
  }
  if (resolved.startsWith("/tmp/")) variants.add(`/private${resolved}`);
  if (resolved.startsWith("/private/tmp/")) variants.add(resolved.slice("/private".length));
  return [...variants].filter(Boolean);
}

function pathIsWithin(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function terminateProcessesMatchingPath(
  targetPath: string | null | undefined,
  signal: NodeJS.Signals,
  excludePids: Set<number> = new Set([process.pid]),
) {
  if (process.platform === "win32") return 0;
  const variants = processPathVariants(targetPath);
  if (variants.length === 0) return 0;
  const result = spawnSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" });
  if (result.error || typeof result.stdout !== "string") return 0;

  let signaled = 0;
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] || "";
    if (!Number.isInteger(pid) || pid <= 0 || excludePids.has(pid)) continue;
    if (!variants.some((variant) => command.includes(variant))) continue;
    try {
      process.kill(pid, signal);
      signaled += 1;
    } catch {
      // Process already exited.
    }
  }
  return signaled;
}

function auditRuntimeRootFromFile(auditFile: string | null | undefined) {
  if (!auditFile) return null;
  const resolved = path.resolve(auditFile);
  const marker = `${path.sep}acp-audit${path.sep}`;
  const index = resolved.indexOf(marker);
  return index > 0 ? resolved.slice(0, index) : null;
}

function isNarrowResidualProcessPath(targetPath: string) {
  const resolved = path.resolve(targetPath);
  if (resolved === path.parse(resolved).root) return false;
  const withSep = `${resolved}${path.sep}`;
  const tempRoot = path.resolve(tmpdir());
  if (resolved === tempRoot || withSep.startsWith(`${tempRoot}${path.sep}`)) return true;
  return [
    `${path.sep}.omx${path.sep}`,
    `${path.sep}worktrees${path.sep}`,
    `${path.sep}agent-homes${path.sep}`,
    `${path.sep}acp-audit${path.sep}`,
  ].some((marker) => withSep.includes(marker));
}

export class AcpClient {
  agent: string;
  cwd: string;
  prompt: string;
  writeAllowPaths: string[] | null;
  terminalPolicy: string;
  toolPolicy: Map<string, string> | null;
  outputSink: (chunk: string | Buffer) => void;
  errorSink: (chunk: string | Buffer) => void;
  stderrTail: string;
  env: NodeJS.ProcessEnv;
  resumeSessionId: string | null;
  reuseSession: boolean;
  nextId: number;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>;
  terminals: Map<string, TerminalEntry>;
  nextTerminalId: number;
  closed: boolean;
  initialized: AcpInitializeResult | null;
  child: ChildProcess | null;
  childEnv: NodeJS.ProcessEnv | null;
  lineQueue: Promise<void>;
  idleTimer: NodeJS.Timeout | null;
  idleTimeoutMs: number;
  sessionUpdateIdleTimer: NodeJS.Timeout | null;
  sessionUpdateIdleTimeoutMs: number;
  executeNoEditIdleTimer: NodeJS.Timeout | null;
  executeNoEditIdleTimeoutMs: number;
  closeSessionTimeoutMs: number;
  agentHomeInstanceId: string | null;
  auditEnv: NodeJS.ProcessEnv;
  auditFile: string | null;
  activeSessionId: string | null;
  activeSessionCwd: string | null;
  usageTotals: UsageRecord;
  usageReportedCounts: UsageMetricCounts;
  lastPromptUsage: UsageRecord | null;
  toolCallFingerprints: Set<string>;
  toolEventFingerprints: Set<string>;
  executeNoEditToolFingerprints: Set<string>;
  executeNoEditSatisfied: boolean;
  auditUpdateEvents: number;

  constructor({
    agent,
    cwd,
    prompt,
    writeAllowPaths,
    terminalPolicy,
    toolPolicy,
    outputSink = (chunk: string | Buffer) => process.stdout.write(chunk),
    errorSink = (chunk: string | Buffer) => process.stderr.write(chunk),
    env = process.env,
    resumeSessionId = null,
    reuseSession = false,
    agentHomeInstanceId = null,
  }: {
    agent: string;
    cwd: string;
    prompt: string;
    writeAllowPaths?: string[] | null;
    terminalPolicy?: string;
    toolPolicy?: Map<string, string> | null;
    outputSink?: (chunk: string | Buffer) => void;
    errorSink?: (chunk: string | Buffer) => void;
    env?: NodeJS.ProcessEnv;
    resumeSessionId?: string | null;
    reuseSession?: boolean;
    agentHomeInstanceId?: string | null;
  }) {
    this.agent = agent;
    this.cwd = cwd;
    this.prompt = prompt;
    this.writeAllowPaths = writeAllowPaths === undefined ? null : writeAllowPaths;
    this.terminalPolicy = terminalPolicy || "allow";
    this.toolPolicy = toolPolicy || null;
    this.outputSink = outputSink;
    this.errorSink = errorSink;
    this.stderrTail = "";
    this.env = { ...env };
    if (cwd) this.env.CPB_ACP_CWD = cwd;
    this.resumeSessionId = resumeSessionId;
    this.reuseSession = Boolean(reuseSession);
    this.nextId = 1;
    this.pending = new Map();
    this.terminals = new Map();
    this.nextTerminalId = 1;
    this.closed = false;
    this.initialized = null;
    this.childEnv = null;
    this.lineQueue = Promise.resolve();
    this.idleTimer = null;
    this.sessionUpdateIdleTimer = null;
    this.idleTimeoutMs = promptIdleTimeoutMs(this.env);
    this.sessionUpdateIdleTimeoutMs = sessionUpdateIdleTimeoutMs(this.env);
    this.executeNoEditIdleTimer = null;
    this.executeNoEditIdleTimeoutMs = executeNoEditIdleTimeoutMs(this.env);
    this.closeSessionTimeoutMs = nonNegativeInteger(this.env.CPB_ACP_CLOSE_SESSION_TIMEOUT_MS, DEFAULT_CLOSE_SESSION_TIMEOUT_MS);
    this.agentHomeInstanceId = agentHomeInstanceId || this.env.CPB_AGENT_HOME_INSTANCE_ID || null;
    this.auditEnv = { ...this.env };
    this.auditFile = resolveAcpAuditFile(this.auditEnv);
    this.activeSessionId = null;
    this.activeSessionCwd = null;
    this.usageTotals = createUsageTotals();
    this.usageReportedCounts = createUsageMetricCounts();
    this.lastPromptUsage = null;
    this.toolCallFingerprints = new Set();
    this.toolEventFingerprints = new Set();
    this.executeNoEditToolFingerprints = new Set();
    this.executeNoEditSatisfied = false;
    this.auditUpdateEvents = 0;
  }

  setAuditContext(envPatch: NodeJS.ProcessEnv = {}, { cwd = null, writeAllowPaths = undefined }: AuditContextOptions = {}) {
    this.env = { ...envPatch };
    if (cwd) this.env.CPB_ACP_CWD = cwd;
    this.auditEnv = { ...this.env };
    this.auditFile = resolveAcpAuditFile(this.auditEnv);
    this.idleTimeoutMs = promptIdleTimeoutMs(this.env);
    this.sessionUpdateIdleTimeoutMs = sessionUpdateIdleTimeoutMs(this.env);
    this.executeNoEditIdleTimeoutMs = executeNoEditIdleTimeoutMs(this.env);
    this.resetExecuteNoEditProgress();
    this.executeNoEditSatisfied = false;
    if (cwd) this.cwd = cwd;
    if (writeAllowPaths !== undefined) this.writeAllowPaths = writeAllowPaths;
  }

  async recordAudit(event: string, details: LooseRecord = {}, target?: AuditTarget) {
    const auditFile = target ? target.file : this.auditFile;
    if (!auditFile) return;
    const auditEnv = target?.env || this.auditEnv || this.env;
    const entry = {
      ts: new Date().toISOString(),
      event,
      agent: this.agent,
      project: auditEnv.CPB_ACP_PROJECT || null,
      jobId: auditEnv.CPB_ACP_JOB_ID || null,
      phase: auditEnv.CPB_ACP_PHASE || null,
      role: auditEnv.CPB_ACP_ROLE || null,
      ...details,
    };
    await mkdir(path.dirname(auditFile), { recursive: true });
    await appendFile(auditFile, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async start() {
    if (this.isUsable() && this.initialized) return this.initialized;
    if (this.child && this.initialized && !this.isUsable()) {
      throw new Error("ACP agent transport is not reusable because stdin is closed");
    }

    const env: NodeJS.ProcessEnv = buildChildEnv(this.env, {}, { agent: this.agent });
    if (process.platform === "darwin" && !env.SSL_CERT_FILE && existsSync("/etc/ssl/cert.pem")) {
      // sandbox-exec cannot expose the user's login keychain without widening
      // the trust boundary. Codex/rustls accepts this system CA bundle and can
      // establish provider TLS while the rest of HOME remains isolated.
      env.SSL_CERT_FILE = "/etc/ssl/cert.pem";
    }
    const isolateAgentHome = shouldIsolateAgentHome(this.agent, env);
    if (isolateAgentHome) {
      const cpbRoot = env.CPB_ACP_CPB_ROOT || env.CPB_ROOT || this.cwd;
      // env is the filtered child env; CPB_PROJECT_RUNTIME_ROOT may be stripped
      // by buildChildEnv's allowlist even though it is present on this.env.
      // Resolve the agent-home dataRoot from the unfiltered source so isolation
      // does not fail when the project/job context markers survive filtering.
      const homeDataRoot = env.CPB_PROJECT_RUNTIME_ROOT || this.env.CPB_PROJECT_RUNTIME_ROOT || null;
      const homeEnv = await createAgentHome(
        cpbRoot,
        this.agent,
        env.CPB_ACP_JOB_ID || env.CPB_JOB_ID || null,
        {
          parentEnv: env,
          dataRoot: homeDataRoot,
          isolateTemp: Boolean(env.CPB_AGENT_FS_BOUNDARY_JSON),
          instanceId: this.agentHomeInstanceId,
        },
      );
      Object.assign(env, homeEnv);
    }
    const agentHome = {
      isolated: isolateAgentHome,
      home: isolateAgentHome ? env.HOME || null : null,
      xdgConfigHome: isolateAgentHome ? env.XDG_CONFIG_HOME || null : null,
      xdgDataHome: isolateAgentHome ? env.XDG_DATA_HOME || null : null,
      xdgCacheHome: isolateAgentHome ? env.XDG_CACHE_HOME || null : null,
    };
    const { command, args } = await resolveAgentCommand(this.agent, env);
    const launchCodegraphServers = this.agent === "codex"
      ? codexCodegraphMcpServers(env)
      : buildMcpServers(this.agent, env);
    const launchCodegraphSummary = summarizeMcpServers(launchCodegraphServers);
    const launch = buildAgentSandboxLaunch(command, args, { env, cwd: this.cwd });
    const outerWriteRoots = Array.isArray(launch.sandbox?.writeRoots)
      ? launch.sandbox.writeRoots.map(String)
      : [];
    await this.recordAudit("agent_launch", {
      command: path.basename(command),
      mcpServers: launchCodegraphSummary,
      mcpServerNames: launchCodegraphSummary.map((server) => server.name).filter(Boolean),
      codegraphSseUrl: null,
      runtimeGuards: {
        ...resolveAcpRuntimeGuards(env),
        taskRiskPolicy: taskRiskPolicySummary(this.env),
      },
      executionPolicy: {
        codexSandboxMode: this.agent === "codex" ? codexConfiguredSandboxModeForExecution(env) : null,
        effectiveSandboxMode: this.agent === "codex" ? codexSandboxModeForExecution(env) : null,
        sandboxEnforcement: this.agent === "codex" ? codexSandboxEnforcementForExecution(env) : "cpb-outer",
        codexApprovalPolicy: this.agent === "codex" ? "never" : null,
        outerSandboxMode: launch.sandbox?.mode || null,
        outerSandboxProvider: launch.sandbox?.provider || null,
        outerWorkspaceWritable: outerWriteRoots.some((root) => pathIsWithin(this.cwd, root)),
        outerWriteRootCount: outerWriteRoots.length,
      },
      agentHome,
    });
    if (command === "npx" && !env.npm_config_cache) {
      const instanceCache = path.join(tmpdir(), `cpb-npm-cache-${this.agent}-${randomUUID()}`);
      await mkdir(instanceCache, { recursive: true });
      env.npm_config_cache = instanceCache;
    }

    // Agent home isolation keeps provider auth/config available without sharing
    // mutable session history between concurrent ACP jobs.
    this.childEnv = env;
    this.child = spawn(launch.command, launch.args, {
      cwd: this.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.markActivity();
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-ACP_STDERR_TAIL_LIMIT);
      this.errorSink(chunk);
    });

    this.child.on("error", (error: Error) => {
      this.rejectAll(error);
    });

    this.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      this.closed = true;
      this.clearIdleTimer();
      this.clearSessionUpdateIdleTimer();
      this.clearExecuteNoEditIdleTimer();
      if (this.pending.size > 0) {
        const stderrTail = String(redactSecrets(this.stderrTail.trim()) || "").slice(-1000);
        const detail = stderrTail ? `; stderr tail: ${stderrTail}` : "";
        this.rejectAll(new Error(`ACP agent exited before completing requests (code=${code}, signal=${signal})${detail}`));
      }
    });

    const rl = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      this.markActivity();
      this.lineQueue = this.lineQueue.then(() => this.handleLine(line));
    });

    this.markActivity();

    const initialized = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
      clientInfo: {
        name: "cpb",
        title: "CodePatchbay",
        version: "0.1.0",
      },
    }) as AcpInitializeResult;

    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`unsupported ACP protocol version: ${initialized.protocolVersion}`);
    }

    this.initialized = initialized;
    return initialized;
  }

  isUsable() {
    const stdin = this.child?.stdin;
    return Boolean(
      this.child
      && !this.closed
      && stdin
      && stdin.writable
      && !stdin.writableEnded
      && !stdin.destroyed
    );
  }

  async promptOnce(prompt = this.prompt, cwd = this.cwd) {
    const initialized = await this.start();
    const mcpServers = buildMcpServers(this.agent, this.env);
    const usageBefore = cloneUsageTotals(this.usageTotals);
    const usageReportedBefore = { ...this.usageReportedCounts };
    const nativeUsageCursor = await captureNativeUsageCursor(
      this.agent,
      this.childEnv || this.env,
    );
    const newSession = async (servers: McpServerConfig[]) => {
      await this.recordAudit("session_new_request", {
        cwd,
        mcpServers: summarizeMcpServers(servers),
        mcpServerNames: summarizeMcpServers(servers).map((server) => server.name).filter(Boolean),
      });
      try {
        const session = await this.request("session/new", { cwd, mcpServers: servers });
        await this.recordAudit("session_new", {
          cwd,
          sessionId: session.sessionId || null,
          mcpServers: summarizeMcpServers(servers),
          mcpServerNames: summarizeMcpServers(servers).map((server) => server.name).filter(Boolean),
        });
        return session;
      } catch (error) {
        if (servers?.length > 0 && /invalid params/i.test(error.message || "")) {
          await this.recordAudit("session_new_mcp_fallback", {
            cwd,
            reason: error.message || "session/new rejected mcpServers",
            mcpServerNames: summarizeMcpServers(servers).map((server) => server.name).filter(Boolean),
          });
          const session = await this.request("session/new", { cwd, mcpServers: [] });
          await this.recordAudit("session_new", {
            cwd,
            sessionId: session.sessionId || null,
            mcpServers: [],
            mcpServerNames: [],
          });
          return session;
        }
        throw error;
      }
    };

    // Try to resume a cached session, fall back to new
    let session;
    if (this.reuseSession && this.activeSessionId && this.activeSessionCwd === cwd) {
      session = { sessionId: this.activeSessionId };
      await this.recordAudit("session_reuse", { cwd, sessionId: this.activeSessionId });
    } else {
      if (this.reuseSession && this.activeSessionId && this.activeSessionCwd !== cwd) {
        await this.closeActiveSession("cwd_changed");
      }
      if (this.resumeSessionId) {
        try {
          session = await this.request("session/resume", { sessionId: this.resumeSessionId, cwd });
          await this.recordAudit("session_resume", { cwd, sessionId: session.sessionId || this.resumeSessionId });
        } catch {
          session = await newSession(mcpServers);
        }
      } else {
        session = await newSession(mcpServers);
      }
      if (this.reuseSession && session?.sessionId) {
        this.activeSessionId = session.sessionId;
        this.activeSessionCwd = cwd;
      }
    }

    this.markSessionUpdateActivity();
    let promptFailure: unknown = null;
    try {
      await this.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: prompt }],
      });
      await this.lineQueue;
    } catch (error) {
      promptFailure = error;
    } finally {
      this.clearSessionUpdateIdleTimer();
      this.clearExecuteNoEditIdleTimer();
    }

    const protocolUsage = usageDelta(
      usageBefore,
      this.usageTotals,
      usageReportedBefore,
      this.usageReportedCounts,
    );
    const nativeUsage = protocolUsage ? null : await readNativeUsageDelta(nativeUsageCursor);
    this.lastPromptUsage = protocolUsage || nativeUsage;
    if (this.lastPromptUsage) {
      await this.recordAudit("prompt_usage", {
        sessionId: session.sessionId,
        usage: this.lastPromptUsage,
      });
    }

    if (promptFailure) throw promptFailure;

    if (!this.reuseSession && initialized.agentCapabilities?.sessionCapabilities?.close) {
      await this.request("session/close", { sessionId: session.sessionId }).catch(() => null);
      await this.recordAudit("session_close", {
        sessionId: session.sessionId,
        cwd,
        reason: "prompt_complete",
      });
    }

    return session.sessionId;
  }

  async closeActiveSession(reason = "client_close", timeoutMs = this.closeSessionTimeoutMs) {
    if (!this.activeSessionId) return;
    const sessionId = this.activeSessionId;
    const cwd = this.activeSessionCwd;
    this.activeSessionId = null;
    this.activeSessionCwd = null;
    if (!this.child || this.closed || !this.initialized?.agentCapabilities?.sessionCapabilities?.close) return;
    let closeError: unknown = null;
    const closeRequest = this.request("session/close", { sessionId })
      .then(() => "closed" as const)
      .catch((error) => {
        closeError = error;
        return "error" as const;
      });
    if (timeoutMs <= 0) {
      closeRequest.catch(() => null);
      await this.recordAudit("session_close_timeout", { sessionId, cwd, reason, timeoutMs });
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      timer.unref();
    });
    const result = await Promise.race([closeRequest, timeout]);
    if (timer) clearTimeout(timer);
    if (result === "closed") {
      await this.recordAudit("session_close", { sessionId, cwd, reason });
      return;
    }
    if (result === "timeout") {
      closeRequest.catch(() => null);
      await this.recordAudit("session_close_timeout", { sessionId, cwd, reason, timeoutMs });
      return;
    }
    const closeErrorMessage = closeError instanceof Error ? closeError.message : String(closeError || "session/close request failed");
    await this.recordAudit("session_close_error", {
      sessionId,
      cwd,
      reason,
      error: String(redactSecrets(closeErrorMessage) || "session/close request failed").slice(-1000),
    });
  }

  async run() {
    try {
      await this.promptOnce(this.prompt, this.cwd);
    } finally {
      await this.close();
    }
  }

  async close() {
    this.clearIdleTimer();
    this.clearSessionUpdateIdleTimer();
    this.terminateTerminals("SIGTERM");
    if (!this.child || this.closed) {
      this.terminateTerminals("SIGKILL", { drop: true });
      this.terminateAgentProcessTree("SIGKILL");
      return;
    }
    await this.closeActiveSession("client_close");
    const child = this.child;
    const closed = new Promise((resolve) => {
      child.once("close", resolve);
    });
    child.stdin.end();
    const terminateTimer = setTimeout(() => {
      if (!this.closed) this.terminateAgentProcessTree("SIGTERM");
    }, 500).unref();
    const killTimer = setTimeout(() => {
      if (!this.closed) {
        this.terminateTerminals("SIGKILL", { drop: true });
        this.terminateAgentProcessTree("SIGKILL");
      }
    }, 1_500).unref();
    const waitTimer = new Promise((resolve) => setTimeout(resolve, 2_000));
    await Promise.race([closed, waitTimer]);
    clearTimeout(terminateTimer);
    clearTimeout(killTimer);
    this.terminateTerminals("SIGKILL", { drop: true });
    this.terminateAgentProcessTree("SIGKILL");
  }

  waitForTerminalExitStatus(terminal: TerminalEntry | null | undefined, timeoutMs: number): Promise<TerminalExitStatus | null> {
    if (!terminal?.child || terminal.exitStatus || terminal.child.exitCode !== null || terminal.child.signalCode !== null) {
      return Promise.resolve(terminal?.exitStatus || {
        exitCode: terminal?.child?.exitCode ?? null,
        signal: terminal?.child?.signalCode ?? null,
      });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      timer.unref();
      const done = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        resolve({ exitCode, signal });
      };
      const cleanup = () => {
        clearTimeout(timer);
        terminal.child.removeListener("exit", done);
      };
      terminal.child.once("exit", done);
    });
  }

  request(method: string, params: LooseRecord): Promise<LooseRecord> {
    const id = this.nextId++;
    this.markActivity();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  respond(id: JsonRpcId | undefined, result: unknown) {
    if (id === undefined) return;
    this.markActivity();
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown) {
    if (id === undefined) return;
    this.markActivity();
    this.write({ jsonrpc: "2.0", id, error: jsonRpcError(code, message, data) });
  }

  write(message: JsonRpcMessage) {
    if (this.child.stdin.destroyed) {
      throw new Error("ACP agent stdin is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  markActivity() {
    if (!this.child || this.idleTimeoutMs <= 0 || this.closed) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      void this.recordAudit("prompt_idle_timeout", { timeoutMs: this.idleTimeoutMs });
      this.terminateAgentProcessTree("SIGTERM");
      this.rejectAll(new Error(`ACP prompt idle timed out after ${this.idleTimeoutMs}ms without activity`));
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  markSessionUpdateActivity() {
    if (!this.child || this.sessionUpdateIdleTimeoutMs <= 0 || this.closed) return;
    this.clearSessionUpdateIdleTimer();
    this.sessionUpdateIdleTimer = setTimeout(() => {
      const reason = `ACP session update idle timed out after ${this.sessionUpdateIdleTimeoutMs}ms without session updates`;
      void this.recordAudit("session_update_idle_timeout", {
        timeoutMs: this.sessionUpdateIdleTimeoutMs,
        reason,
      });
      this.terminateAgentProcessTree("SIGTERM");
      this.rejectAll(new Error(reason));
    }, this.sessionUpdateIdleTimeoutMs);
    this.sessionUpdateIdleTimer.unref();
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  clearSessionUpdateIdleTimer() {
    if (this.sessionUpdateIdleTimer) {
      clearTimeout(this.sessionUpdateIdleTimer);
      this.sessionUpdateIdleTimer = null;
    }
  }

  clearExecuteNoEditIdleTimer() {
    if (this.executeNoEditIdleTimer) {
      clearTimeout(this.executeNoEditIdleTimer);
      this.executeNoEditIdleTimer = null;
    }
  }

  terminateAgent(signal: NodeJS.Signals) {
    if (!this.child?.pid) return;
    try {
      if (process.platform !== "win32") {
        process.kill(-this.child.pid, signal);
      } else {
        this.child.kill(signal);
      }
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // Process already exited.
      }
    }
  }

  terminateAgentProcessTree(signal: NodeJS.Signals) {
    this.terminateAgent(signal);
    this.terminateResidualProcesses(signal);
  }

  residualProcessPaths() {
    const isolatedHome = this.env.CPB_AGENT_ISOLATE_HOME !== "0";
    // Parallel agents intentionally share the worktree and project runtime.
    // Path-scanning either shared location lets the first completed agent kill
    // the other agent's still-live ACP process. With isolated homes, use only
    // the per-agent paths as residual ownership markers. Legacy non-isolated
    // clients retain the broader cleanup fallback.
    const candidates = isolatedHome
      ? [
          this.childEnv?.HOME,
          this.childEnv?.XDG_CONFIG_HOME,
          this.childEnv?.XDG_DATA_HOME,
          this.childEnv?.XDG_CACHE_HOME,
        ]
      : [
          this.cwd,
          this.activeSessionCwd,
          this.env.CPB_ACP_CWD,
          this.env.CPB_PROJECT_RUNTIME_ROOT,
          this.childEnv?.CPB_PROJECT_RUNTIME_ROOT,
          auditRuntimeRootFromFile(this.auditFile),
        ];
    return candidates
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => path.resolve(value))
      .filter(isNarrowResidualProcessPath);
  }

  terminateResidualProcesses(signal: NodeJS.Signals) {
    const excludePids = new Set([process.pid]);
    if (this.child?.pid) excludePids.add(this.child.pid);
    const seen = new Set<string>();
    let signaled = 0;
    for (const candidate of this.residualProcessPaths()) {
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      signaled += terminateProcessesMatchingPath(resolved, signal, excludePids);
    }
    return signaled;
  }

  signalTerminal(terminal: TerminalEntry, signal: NodeJS.Signals) {
    if (!terminal?.child?.pid) return;
    try {
      if (terminal.detached && process.platform !== "win32") {
        process.kill(-terminal.child.pid, signal);
      } else {
        terminal.child.kill(signal);
      }
    } catch {
      try {
        terminal.child.kill(signal);
      } catch {
        // Process already exited.
      }
    }
  }

  terminateTerminals(signal: NodeJS.Signals, { drop = false, cwd = null }: { drop?: boolean; cwd?: string | null } = {}) {
    const target = cwd ? path.resolve(cwd) : null;
    for (const [terminalId, terminal] of this.terminals) {
      if (target && path.resolve(terminal.cwd || this.cwd) !== target) continue;
      if (!terminal.exitStatus) {
        this.signalTerminal(terminal, signal);
      }
      if (drop) this.terminals.delete(terminalId);
    }
  }

  async cleanupTerminalsForCwd(cwd: string, { reason = "worktree_release", termGraceMs = 500, killGraceMs = 1_500 }: { reason?: string; termGraceMs?: number; killGraceMs?: number } = {}) {
    if (!cwd) return 0;
    const target = path.resolve(cwd);
    const entries = [...this.terminals.entries()]
      .filter(([, terminal]) => path.resolve(terminal.cwd || this.cwd) === target);
    if (entries.length === 0) return 0;

    await this.recordAudit("terminal_cleanup", {
      cwd: target,
      reason,
      terminalIds: entries.map(([terminalId]) => terminalId),
    });

    for (const [, terminal] of entries) {
      if (!terminal.exitStatus) this.signalTerminal(terminal, "SIGTERM");
    }
    await Promise.all(entries.map(([, terminal]) => this.waitForTerminalExitStatus(terminal, termGraceMs)));

    for (const [, terminal] of entries) {
      if (!terminal.exitStatus && terminal.child.exitCode === null && terminal.child.signalCode === null) {
        this.signalTerminal(terminal, "SIGKILL");
      }
    }
    await Promise.all(entries.map(([, terminal]) => this.waitForTerminalExitStatus(terminal, killGraceMs)));

    for (const [terminalId] of entries) this.terminals.delete(terminalId);
    return entries.length;
  }

  rejectAll(error: Error) {
    this.clearSessionUpdateIdleTimer();
    this.clearExecuteNoEditIdleTimer();
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  async handleLine(line: string) {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.errorSink(`[acp:${this.agent}] non-JSON stdout: ${line}\n`);
      return;
    }

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = Object.assign(new Error(message.error.message || `ACP error ${message.error.code}`), {
          code: message.error.code ?? null,
          data: message.error.data ?? null,
          acpError: message.error,
        });
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      await this.handleClientRequest(message);
    }
  }

  async handleClientRequest(message: JsonRpcMessage) {
    try {
      await loadPermissionModules(this.env);

      // Headless UI tool denial (issue #62)
      const launchProfile = this.env.CPB_ACP_LAUNCH_PROFILE;
      if (launchProfile !== "ui" && classifyUiToolRequest(message)) {
        const toolDesc = message.method || message.params?.serverName || message.params?.name || "unknown-ui-tool";
        const denialInfo = {
          role: this.env.CPB_ACP_ROLE || null,
          project: this.env.CPB_ACP_PROJECT || null,
          jobId: this.env.CPB_ACP_JOB_ID || null,
          phase: this.env.CPB_ACP_PHASE || null,
          tool: toolDesc,
          reason: "UI tool denied in headless ACP session",
        };

        // Audit the denial event
        if (_permRecord && denialInfo.jobId && denialInfo.project && this.env.CPB_ACP_CPB_ROOT) {
          await _permRecord(this.env.CPB_ACP_CPB_ROOT, denialInfo.project, denialInfo.jobId, {
            role: denialInfo.role,
            action: "ui-tool-denied",
            targetPath: toolDesc,
            tool: toolDesc,
            reason: denialInfo.reason,
            phase: denialInfo.phase,
          }).catch(() => {});
        }

        throw new Error(`UI tool denied in headless mode: ${toolDesc}`);
      }

      // Per-tool policy enforcement: check before dispatching
      if (this.toolPolicy && message.method) {
        const action = this.toolPolicy.get(message.method);
        if (action === "deny") {
          throw new Error(`tool denied by policy: ${message.method}`);
        }
        // "allow" or no match -> proceed
      }

      switch (message.method) {
        case "session/update":
          await this.handleSessionUpdate(message.params as SessionUpdateParams);
          if (Object.hasOwn(message, "id")) this.respond(message.id, null);
          break;
        case "fs/read_text_file":
          this.respond(message.id, await this.readTextFile(message.params as ReadTextFileParams));
          break;
        case "fs/write_text_file":
          this.respond(message.id, await this.writeTextFile(message.params as WriteTextFileParams));
          break;
        case "session/request_permission":
          this.respond(message.id, this.permissionResponse(message.params as PermissionRequestParams));
          break;
        case "terminal/create":
          this.respond(message.id, await this.createTerminal(message.params as TerminalCreateParams));
          break;
        case "terminal/output":
          this.respond(message.id, this.terminalOutput(message.params as TerminalIdParams));
          break;
        case "terminal/wait_for_exit":
          this.respond(message.id, await this.waitForTerminalExit(message.params as TerminalIdParams));
          break;
        case "terminal/kill":
          this.respond(message.id, this.killTerminal(message.params as TerminalIdParams));
          break;
        case "terminal/release":
          this.respond(message.id, this.releaseTerminal(message.params as TerminalIdParams));
          break;
        default:
          if (Object.hasOwn(message, "id")) {
            this.respondError(message.id, -32601, `method not found: ${message.method}`);
          }
      }
    } catch (error) {
      const err = isRecord(error) ? error : {};
      if (typeof err.message === "string" && err.message.startsWith("PERMISSION_FAIL_FAST:")) {
        this.errorSink(`[acp:${this.agent}] ${err.message}\n`);
        if (Object.hasOwn(message, "id")) {
          this.respondError(message.id, -32000, err.message);
        }
        // Abort the session; agent is stuck on repeated denials
        setImmediate(() => this.close());
        return;
      }
      if (Object.hasOwn(message, "id")) {
        this.respondError(message.id, -32000, err.message as string, err.guardResult);
      } else {
        this.errorSink(`[acp:${this.agent}] ${err.message}\n`);
      }
    }
  }

  async handleSessionUpdate(params: SessionUpdateParams) {
    this.markSessionUpdateActivity();
    const update = params?.update;
    if (!update) return;

    const usage = normalizeAcpUsage(update);
    if (usage) {
      addUsage(this.usageTotals, usage, this.usageReportedCounts);
      await this.recordAudit("token_usage", {
        sessionId: params?.sessionId || null,
        usage,
      });
    }

    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      this.outputSink(update.content.text);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const summary = summarizeToolUpdate(update);
      const wholeFilesystemDeniedReason = wholeFilesystemToolUpdateSearchReason(update, this.env);
      const exactTestBlock = exactTestCommandBlock(toolUpdateCommandTextForGuard(update), [], this.env);
      const failFastDeniedReason = disabledWebToolReason(update, this.env)
        || readOnlyToolUpdateMutationReason(update, this.env)
        || wholeFilesystemDeniedReason;
      const deniedReason = failFastDeniedReason || exactTestBlock?.reason;
      if (deniedReason) {
        await this.recordAudit("tool_blocked", {
          sessionId: params?.sessionId || null,
          ...summary,
          classification: wholeFilesystemDeniedReason
            ? "whole_filesystem_search_denied"
            : exactTestBlock?.classification,
          offendingCommand: exactTestBlock?.offendingCommand,
          canonicalCommands: exactTestBlock?.canonicalCommands,
          diagnosticCommands: exactTestBlock?.diagnosticCommands,
          reason: deniedReason,
        });
        throw new Error(`PERMISSION_FAIL_FAST: ${deniedReason}`);
      }
      await this.enforceExecuteNoEditProgress(params?.sessionId || null, summary);
      await this.enforceToolCallBudget(params?.sessionId || null, summary);
      await this.recordAudit("tool_call", {
        sessionId: params?.sessionId || null,
        ...summary,
      });
      const title = update.title || update.toolCallId || "tool";
      const status = update.status ? ` ${update.status}` : "";
      this.errorSink(`[acp:${this.agent}] ${title}${status}\n`);
    } else if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      for (const entry of update.entries) {
        this.errorSink(`[acp:${this.agent}] plan ${entry.status}: ${entry.content}\n`);
      }
    }
  }

  resetExecuteNoEditProgress() {
    this.executeNoEditToolFingerprints.clear();
    this.clearExecuteNoEditIdleTimer();
  }

  armExecuteNoEditIdleTimer(sessionId: string | null, summary: LooseRecord, count: number) {
    if (this.executeNoEditIdleTimeoutMs <= 0 || this.executeNoEditSatisfied || this.closed) return;
    this.clearExecuteNoEditIdleTimer();
    const limit = executeNoEditToolLimit(this.env);
    const timeoutMs = this.executeNoEditIdleTimeoutMs;
    this.executeNoEditIdleTimer = setTimeout(() => {
      const classification = executeNoEditClassification();
      const reason = `${classification}: ${executeNoEditSubject()} made ${count} read/search tool calls without edits and then went idle for ${timeoutMs}ms; stop re-reading, make the planned source/test edit, or report a concrete blocker`;
      void this.recordAudit("tool_blocked", {
        sessionId,
        ...summary,
        classification,
        noEditToolLimit: limit,
        noEditToolCount: count,
        noEditIdleTimeoutMs: timeoutMs,
        reason,
      });
      this.terminateAgentProcessTree("SIGTERM");
      this.rejectAll(new Error(reason));
    }, timeoutMs);
    // This guard is part of the request's completion contract. Keeping it
    // referenced guarantees a stalled execute request is rejected and audited
    // even when no provider or terminal handle remains active.
  }

  async enforceExecuteNoEditProgress(sessionId: string | null, summary: LooseRecord) {
    const limit = executeNoEditToolLimit(this.env);
    if (limit <= 0) return;
    if (isMutatingToolUpdate(summary)) {
      this.resetExecuteNoEditProgress();
      this.executeNoEditSatisfied = true;
      return;
    }
    if (this.executeNoEditSatisfied) return;
    if (!isReadOrSearchToolUpdate(summary)) return;
    const fingerprint = toolCallFingerprint(summary);
    if (!fingerprint || this.executeNoEditToolFingerprints.has(fingerprint)) return;
    this.executeNoEditToolFingerprints.add(fingerprint);
    const count = this.executeNoEditToolFingerprints.size;
    this.armExecuteNoEditIdleTimer(sessionId, summary, count);
    if (count <= limit) return;
    const classification = executeNoEditClassification();
    const reason = `${classification}: ${executeNoEditSubject()} exceeded no-edit read/search limit ${limit}; stop re-reading, make the planned source/test edit, or report a concrete blocker`;
    await this.recordAudit("tool_blocked", {
      sessionId,
      ...summary,
      classification,
      noEditToolLimit: limit,
      noEditToolCount: count,
      reason,
    });
    throw new Error(`PERMISSION_FAIL_FAST: ${reason}`);
  }

  async enforceToolCallBudget(sessionId: string | null, summary: LooseRecord) {
    this.auditUpdateEvents += 1;
    const fingerprint = toolCallFingerprint(summary);
    if (fingerprint) this.toolCallFingerprints.add(fingerprint);
    const eventFingerprint = [
      fingerprint,
      summary.sessionUpdate,
      summary.title,
      summary.status,
      summary.kind,
      summary.serverName,
      summary.toolName,
    ].map((value) => textValue(value).trim()).join("|");
    if (eventFingerprint) this.toolEventFingerprints.add(eventFingerprint);
    const eventBudget = toolEventBudget(this.env);
    const normalizedToolEvents = this.toolEventFingerprints.size;
    if (eventBudget > 0 && normalizedToolEvents > eventBudget) {
      const reason = `tool_event_budget_exceeded: ACP phase exceeded normalized tool-event budget ${eventBudget}`;
      await this.recordAudit("tool_event_budget_exceeded", {
        sessionId,
        ...summary,
        toolEventBudget: eventBudget,
        auditUpdateEvents: this.auditUpdateEvents,
        normalizedToolEvents,
        reason,
      });
      throw new Error(`PERMISSION_FAIL_FAST: ${reason}`);
    }
    const budget = toolCallBudget(this.env);
    const normalizedToolCalls = this.toolCallFingerprints.size;
    if (budget <= 0 || normalizedToolCalls <= budget) return;
    const reason = `tool_budget_exceeded: ACP phase exceeded normalized tool-call budget ${budget}`;
    await this.recordAudit("tool_budget_exceeded", {
      sessionId,
      ...summary,
      toolCallBudget: budget,
      normalizedToolCalls,
      auditUpdateEvents: this.auditUpdateEvents,
      reason,
    });
    throw new Error(`PERMISSION_FAIL_FAST: ${reason}`);
  }

  async readTextFile(params: ReadTextFileParams) {
    const permResult = await enforcePermission("read", params.path, this.env);
    if (!permResult.allowed) {
      throw Object.assign(new Error(`read denied: ${params.path} (${permResult.reason})`), { classification: permResult.classification || "deny" });
    }
    const content = await readFile(params.path, "utf8");
    if (!params.line && !params.limit) return { content };

    const lines = content.split("\n");
    const start = Math.max((params.line || 1) - 1, 0);
    const end = params.limit ? start + params.limit : lines.length;
    return { content: lines.slice(start, end).join("\n") };
  }

  validateWritePath(targetPath: string) {
    if (this.env.CPB_PERMISSION_MODE === "off") return;
    if (!this.writeAllowPaths) return;
    // Resolve the nearest existing ancestor so symlink/canonical aliases are
    // handled identically even when several target directories do not exist.
    const resolved = canonicalPotentialPath(path.resolve(targetPath));
    const allowed = this.writeAllowPaths.some((pattern: string) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const regex = new RegExp(`^${escaped}$`);
      return regex.test(resolved);
    });
    if (!allowed) {
      throw new Error(`write path not allowed: ${targetPath}`);
    }
  }

  async writeTextFile(params: WriteTextFileParams) {
    const targetPath = params.path;
    this.validateWritePath(targetPath);

    const permResult = await enforcePermission("write", targetPath, this.env);
    if (!permResult.allowed) {
      const classification = permResult.classification || "deny";
      const msg = permResult.recoveryGuidance
        ? `write denied: ${targetPath} (${permResult.reason}); ${permResult.recoveryGuidance}`
        : `write denied: ${targetPath} (${permResult.reason})`;
      if (isRepeatedDenial(targetPath, "write")) {
        throw Object.assign(new Error(`PERMISSION_FAIL_FAST: repeated write denials for ${targetPath}. ${permResult.reason}`), { classification });
      }
      throw Object.assign(new Error(msg), { classification });
    }

    await mkdir(path.dirname(targetPath), { recursive: true });

    if (this.isWikiHandoffFile(targetPath)) {
      this.validateHandoffContent(params.content, targetPath);
    }

    const tmpPath = path.join(
      path.dirname(targetPath),
      `.cpb-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await writeFile(tmpPath, params.content, "utf8");
    await rename(tmpPath, targetPath);
    this.resetExecuteNoEditProgress();
    this.executeNoEditSatisfied = true;
    return null;
  }

  isWikiHandoffFile(filePath: string) {
    const normalized = filePath.replace(/\\/g, "/");
    return /wiki\/projects\/[^/]+\/(inbox|outputs)\/(plan|deliverable)-\d+\.md$/.test(normalized);
  }

  validateHandoffContent(content: unknown, filePath: string) {
    if (!content || typeof content !== "string") return;
    const hasHeader = content.includes("## Handoff");
    const hasFooter = content.includes("## Acceptance-Criteria");
    if (!hasHeader || !hasFooter) {
      throw new Error(
        `Handoff file ${path.basename(filePath)} missing required markers: ` +
        `${!hasHeader ? "## Handoff header" : ""} ${!hasFooter ? "## Acceptance-Criteria footer" : ""}`
      );
    }
  }

  permissionResponse(params: PermissionRequestParams) {
    const wantsReject = this.env.CPB_ACP_PERMISSION === "reject";
    const options = params?.options || [];
    const preferred = options.find((option: PermissionOption) =>
      wantsReject ? option.kind?.startsWith("reject") : option.kind?.startsWith("allow")
    ) || options[0];

    if (!preferred) {
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: preferred.optionId } };
  }

  async createTerminal(params: TerminalCreateParams) {
    if (this.terminalPolicy === "deny") {
      throw new Error("terminal access denied for this phase");
    }

    const terminalCwd = path.resolve(this.cwd, params.cwd || this.cwd);
    const searchDeniedReason = wholeFilesystemSearchReason(params.command, params.args || [], this.env);
    if (searchDeniedReason) {
      await this.recordAudit("terminal_blocked", {
        cwd: terminalCwd,
        command: params.command,
        args: params.args || [],
        reason: searchDeniedReason,
      });
      throw Object.assign(new Error(`execute denied: ${searchDeniedReason}`), {
        classification: "whole_filesystem_search_denied",
      });
    }

    const readOnlyDeniedReason = readOnlyTerminalMutationReason(params.command, params.args || [], this.env);
    if (readOnlyDeniedReason) {
      await this.recordAudit("terminal_blocked", {
        cwd: terminalCwd,
        command: params.command,
        args: params.args || [],
        reason: readOnlyDeniedReason,
      });
      throw Object.assign(new Error(`execute denied: ${readOnlyDeniedReason}`), {
        classification: "read_only_terminal_mutation_denied",
      });
    }

    const broadTestBlock = exactTestCommandBlock(params.command, params.args || [], this.env);
    if (broadTestBlock) {
      await this.recordAudit("terminal_blocked", {
        cwd: terminalCwd,
        command: params.command,
        args: params.args || [],
        classification: broadTestBlock.classification,
        reason: broadTestBlock.reason,
        offendingCommand: broadTestBlock.offendingCommand,
        canonicalCommands: broadTestBlock.canonicalCommands,
        diagnosticCommands: broadTestBlock.diagnosticCommands,
      });
      throw Object.assign(new Error(`execute denied: ${broadTestBlock.reason}`), {
        classification: broadTestBlock.classification,
      });
    }

    const commandLine = [params.command, ...(params.args || [])].join(" ");
    const permResult = enforcePermissionSync("execute", commandLine, this.env);
    if (!permResult.allowed) {
      const classification = permResult.classification || "deny";
      const msg = permResult.recoveryGuidance
        ? `execute denied: ${commandLine} (${permResult.reason}); ${permResult.recoveryGuidance}`
        : `execute denied: ${commandLine} (${permResult.reason})`;
      throw Object.assign(new Error(msg), { classification });
    }

    const guardResult = classifyDeleteRisk(params.command, params.args || [], { cwd: terminalCwd, repoRoot: this.cwd });
    if (!guardResult.allowed) {
      logDeleteBlock(params.command, params.args || [], terminalCwd, guardResult, this.errorSink);
      throw Object.assign(new Error(formatDeleteBlockedMessage(guardResult)), { guardResult });
    }

    const terminalId = `term-${this.nextTerminalId++}`;
    const extraEnv: NodeJS.ProcessEnv = {};
    for (const item of params.env || []) {
      if (item?.name) extraEnv[item.name] = item.value;
    }
    const env = buildChildEnv(this.childEnv || this.env, extraEnv, { agent: this.agent });
    const terminalLaunch = resolveTerminalLaunchCommand(params.command, params.args || [], env);

    const launch = buildAgentSandboxLaunch(terminalLaunch.command, terminalLaunch.args, { env, cwd: terminalCwd });
    const terminalAuditTarget: AuditTarget = {
      file: this.auditFile,
      env: { ...(this.auditEnv || this.env) },
    };
    await this.recordAudit("terminal_launch", {
      terminalId,
      cwd: terminalCwd,
      command: params.command,
      launchCommand: terminalLaunch.command,
      rtkEnabled: terminalLaunch.rtkEnabled,
      sandboxMode: launch.sandbox?.mode || null,
      sandboxProvider: launch.sandbox?.provider || null,
    }, terminalAuditTarget);

    const detached = process.platform !== "win32";
    const child = spawn(launch.command, launch.args, {
      cwd: terminalCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });

    const terminal: TerminalEntry = {
      child,
      cwd: terminalCwd,
      detached,
      output: "",
      truncated: false,
      outputByteLimit: params.outputByteLimit || 1048576,
      exitStatus: null,
      exitAudit: null,
      waiters: [],
    };

    const append = (chunk: Buffer) => {
      this.markActivity();
      terminal.output += chunk.toString("utf8");
      if (Buffer.byteLength(terminal.output, "utf8") > terminal.outputByteLimit) {
        terminal.truncated = true;
        terminal.output = terminal.output.slice(-terminal.outputByteLimit);
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      terminal.exitStatus = { exitCode, signal };
      terminal.exitAudit = this.recordAudit("terminal_exit", {
        terminalId,
        cwd: terminalCwd,
        exitCode,
        signal,
        outputTail: String(redactSecrets(terminal.output) || "").slice(-ACP_TERMINAL_AUDIT_TAIL_LIMIT),
        truncated: terminal.truncated,
      }, terminalAuditTarget).catch((error) => {
        try {
          this.errorSink(`[cpb] failed to record terminal exit audit: ${error instanceof Error ? error.message : String(error)}\n`);
        } catch {
          // Terminal waiters must still settle when a diagnostic sink fails.
        }
      });
      void terminal.exitAudit.then(() => {
        for (const resolve of terminal.waiters) resolve(terminal.exitStatus!);
        terminal.waiters = [];
      });
    });

    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }

  terminalOutput(params: TerminalIdParams) {
    const terminal = this.getTerminal(params.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus: terminal.exitStatus,
    };
  }

  async waitForTerminalExit(params: TerminalIdParams) {
    const terminal = this.getTerminal(params.terminalId);
    if (terminal.exitStatus) {
      await terminal.exitAudit;
      return terminal.exitStatus;
    }
    return new Promise<TerminalExitStatus>((resolve) => terminal.waiters.push(resolve));
  }

  killTerminal(params: TerminalIdParams) {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal.exitStatus) this.signalTerminal(terminal, "SIGTERM");
    return null;
  }

  releaseTerminal(params: TerminalIdParams) {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal.exitStatus) this.signalTerminal(terminal, "SIGTERM");
    this.terminals.delete(params.terminalId);
    return null;
  }

  getTerminal(terminalId: string) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`unknown terminal: ${terminalId}`);
    return terminal;
  }
}

const usage = `Usage: acp-client.js --agent <name> [--cwd <path>]

Reads a prompt from stdin and sends it to an ACP agent over stdio.

Supported agents: codex, claude, or any registered agent from the local registry.

Environment:
  CPB_ACP_{PREFIX}_COMMAND   Override command for agent (e.g. CPB_ACP_CODEX_COMMAND)
  CPB_ACP_{PREFIX}_ARGS      Override args for agent
  CPB_ACP_TIMEOUT_MS         Idle timeout in milliseconds; activity resets it
  CPB_ACP_IDLE_TIMEOUT_MS    Prompt inactivity timeout override; activity resets it
  CPB_ACP_PHASE_TIMEOUT_MS   Hard phase timeout; defaults to 1800000 and cannot be disabled with 0
  CPB_ACP_PERMISSION         allow or reject permission requests
  CPB_ACP_WRITE_ALLOW        Comma-separated glob patterns for allowed write paths
  CPB_ACP_TERMINAL           allow or deny terminal creation
  CPB_ACP_TOOL_POLICY_FILE   Path to JSON file mapping tool names to "allow"|"deny"
  CPB_ACP_DENY_TOOLS         Comma-separated tool names to deny
  CPB_ACP_ALLOW_TOOLS        Comma-separated tool names to explicitly allow
  CPB_AGENT_SANDBOX          off|best-effort|required|strict for agent/terminal process sandboxing
  CPB_ACP_RTK_ENABLED        1/0, wrap ACP terminal commands with rtk when available

Priority: TOOL_POLICY_FILE > DENY_TOOLS/ALLOW_TOOLS > CPB_ACP_TERMINAL
`;

async function parseCli(argv: string[]) {
  const result = { agent: "", cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent") {
      result.agent = argv[++i] ?? "";
    } else if (arg === "--cwd") {
      result.cwd = argv[++i] ?? "";
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (result.agent !== "codex" && result.agent !== "claude") {
    try {
      const { loadRegistry, hasAgent } = await import("../../../core/agents/registry.js");
      // retain: dynamic signature mismatch — registry.ts declares loadRegistry(configDir: string) as required,
      // but its body short-circuits on `_loaded && !configDir`, so a no-arg call is runtime-safe. Cast relaxes
      // the param to optional; fixing the source signature is out of scope (cross-module).
      await (loadRegistry as (configDir?: string) => Promise<void>)();
      if (!hasAgent(result.agent)) {
        throw new Error(`unknown agent: ${result.agent}`);
      }
    } catch (err) {
      if (err.message.startsWith("unknown agent:")) throw err;
      throw new Error("--agent must be a registered agent name (registry unavailable, fallback: codex or claude)");
    }
  }

  result.cwd = path.resolve(result.cwd || process.cwd());
  return result;
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export async function main() {
  const options = await parseCli(process.argv.slice(2));
  const prompt = await readStdin();
  const writeAllowPaths = resolveWriteAllowPaths(options.cwd, process.env);
  const terminalPolicy = process.env.CPB_ACP_TERMINAL === "deny" ? "deny" : "allow";
  const toolPolicy = await parseToolPolicy(process.env);
  const client = new AcpClient({ ...options, prompt, writeAllowPaths, terminalPolicy, toolPolicy });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const code = signal === "SIGINT" ? 130 : 143;
    client.close().finally(() => process.exit(code));
  };
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await client.run();
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function isDirectRun(metaUrl: string, argvPath: string | undefined) {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
