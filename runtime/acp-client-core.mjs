import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import {
  classifyDeleteRisk,
  formatDeleteBlockedMessage,
  logDeleteBlock,
} from "./delete-guard.js";
import { createAgentHome } from "../core/agents/isolation.js";
import {
  headlessCodexConfigArgs,
  classifyUiToolRequest,
  mergeHeadlessDenyTools,
} from "../core/acp/policy.js";
import { buildChildEnv } from "../core/policy/child-env.js";
import { buildAgentSandboxLaunch } from "../core/policy/agent-sandbox.js";

// Permission matrix integration (Stage 3 / #13)
let _permCheck = null;
let _permEvaluate = null;
let _permRecord = null;
const DENIAL_HISTORY_MAX = 50;
const denialHistory = [];

function buildPermissionEnv(env = process.env) {
  const permEnv = {
    role: env.CPB_ACP_ROLE || null,
    project: env.CPB_ACP_PROJECT || null,
    jobId: env.CPB_ACP_JOB_ID || null,
    phase: env.CPB_ACP_PHASE || null,
    cpbRoot: env.CPB_ACP_CPB_ROOT || env.CPB_ROOT || null,
    sourcePath: env.CPB_PROJECT_PATH_OVERRIDE || env.CPB_ACP_CWD || null,
  };
  return permEnv.role && permEnv.project && permEnv.cpbRoot ? permEnv : null;
}

async function loadPermissionModules(env = process.env) {
  if (_permCheck !== null) return buildPermissionEnv(env);
  const executorRoot = env.CPB_EXECUTOR_ROOT;
  if (!executorRoot) return null;
  try {
    const pm = await import(path.join(executorRoot, "server/services/permission-matrix.js"));
    _permCheck = pm.checkPermission;
    _permEvaluate = pm.evaluatePermissionDecision;
    _permRecord = pm.recordPermissionDenial;
    return buildPermissionEnv(env);
  } catch {
    _permCheck = false;
  }
  return null;
}

function isRepeatedDenial(targetPath, action) {
  const recent = denialHistory.slice(-3);
  let identicalCount = 0;
  for (const d of recent) {
    if (d.targetPath === targetPath && d.action === action) identicalCount++;
  }
  return identicalCount >= 3;
}

async function enforcePermission(action, targetPath, env = process.env) {
  if (env.CPB_PERMISSION_MODE === "off") return { allowed: true };
  const permEnv = await loadPermissionModules(env);
  if (!_permCheck || !permEnv) return { allowed: true };

  // Use ReAct-style decision envelope when available
  if (_permEvaluate) {
    const decision = _permEvaluate(
      permEnv.role, permEnv.phase, action, targetPath,
      permEnv.cpbRoot, permEnv.project,
      { sourcePath: permEnv.sourcePath }
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
      }).catch(() => {});
    }

    return decision;
  }

  // Fallback to legacy checkPermission
  const result = _permCheck(permEnv.role, action, targetPath, permEnv.cpbRoot, permEnv.project, {
    sourcePath: permEnv.sourcePath,
    jobId: permEnv.jobId,
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
    }).catch(() => {});
  }

  return result;
}

function enforcePermissionSync(action, target, env = process.env) {
  if (env.CPB_PERMISSION_MODE === "off") return { allowed: true };
  const permEnv = buildPermissionEnv(env);
  if (!_permCheck || !permEnv) return { allowed: true };

  // Use ReAct-style decision envelope when available
  if (_permEvaluate) {
    const decision = _permEvaluate(
      permEnv.role, permEnv.phase, action, target,
      permEnv.cpbRoot, permEnv.project,
      { sourcePath: permEnv.sourcePath }
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
      }).catch(() => {});
    }
    return decision;
  }

  // Legacy path
  const result = _permCheck(permEnv.role, action, target, permEnv.cpbRoot, permEnv.project, {
    sourcePath: permEnv.sourcePath,
    jobId: permEnv.jobId,
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
    }).catch(() => {});
  }
  return result;
}

const PROTOCOL_VERSION = 1;

export async function parseToolPolicy(env = process.env) {
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

    const policy = new Map();
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
    const policy = new Map();

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

function commandExists(command, env = process.env) {
  const result = spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command], { env });
  return result.status === 0;
}

function splitWords(input) {
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

function parseEnvArgs(value) {
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

function safeAuditSegment(value, fallback) {
  const raw = String(value || fallback || "unknown").trim();
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return safe || fallback || "unknown";
}

export function resolveAcpAuditFile(env = process.env) {
  if (env.CPB_ACP_AUDIT_FILE) return path.resolve(env.CPB_ACP_AUDIT_FILE);
  if (env.CPB_ACP_AUDIT === "0") return null;

  const cpbRoot = env.CPB_ACP_CPB_ROOT || env.CPB_ROOT;
  const project = env.CPB_ACP_PROJECT || env.CPB_PROJECT;
  const jobId = env.CPB_ACP_JOB_ID || env.CPB_JOB_ID;
  if (!cpbRoot || !project || !jobId) return null;

  return path.join(
    path.resolve(cpbRoot),
    "cpb-task",
    "acp-audit",
    safeAuditSegment(project, "project"),
    `${safeAuditSegment(jobId, "job")}.jsonl`,
  );
}

function summarizeMcpServers(servers = []) {
  if (!Array.isArray(servers)) return [];
  return servers.map((server) => ({
    name: server?.name || null,
    type: server?.type || null,
    url: server?.url || null,
    command: server?.command || null,
    args: Array.isArray(server?.args) ? server.args : null,
  }));
}

function summarizeToolUpdate(update = {}) {
  return {
    sessionUpdate: update.sessionUpdate || null,
    toolCallId: update.toolCallId || update.id || null,
    title: update.title || update.name || update.toolName || null,
    status: update.status || null,
    kind: update.kind || null,
    serverName: update.serverName || update.mcpServerName || update.mcp_server_name || null,
    toolName: update.toolName || update.name || null,
  };
}

function numberFrom(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(source, keys = []) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    if (Object.hasOwn(source, key)) {
      const value = numberFrom(source[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function createUsageTotals() {
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

function cloneUsageTotals(totals) {
  return { ...createUsageTotals(), ...(totals || {}) };
}

function normalizeAcpUsage(update = {}) {
  const candidates = [
    ["usage", update.usage],
    ["tokenUsage", update.tokenUsage],
    ["tokens", update.tokens],
    ["modelUsage", update.modelUsage],
    ["metrics.usage", update.metrics?.usage],
    ["cost.usage", update.cost?.usage],
  ];
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
      const computed = [inputTokens, outputTokens, reasoningOutputTokens]
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

function addUsage(totals, usage) {
  if (!usage) return;
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
    "costUsd",
    "toolCalls",
    "functionCalls",
  ]) {
    const value = numberFrom(usage[key]);
    if (value !== null) totals[key] += value;
  }
  totals.events += 1;
  totals.tokenSource = usage.tokenSource || totals.tokenSource || "acp_session_update";
}

function usageDelta(before, after) {
  const delta = createUsageTotals();
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
    "costUsd",
    "toolCalls",
    "functionCalls",
    "events",
  ]) {
    delta[key] = Math.max(0, (after?.[key] || 0) - (before?.[key] || 0));
  }
  if (delta.events <= 0) return null;
  delta.tokenSource = after?.tokenSource || "acp_session_update";
  return delta;
}

function defaultAgentCommand(agent) {
  // Legacy hardcoded fallback for codex/claude when registry is unavailable
  if (agent === "codex") {
    if (commandExists("codex-acp")) return { command: "codex-acp", args: [] };
    return { command: "npx", args: ["-y", "@zed-industries/codex-acp"] };
  }

  if (agent === "claude") {
    if (commandExists("claude-agent-acp")) return { command: "claude-agent-acp", args: [] };
    return { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] };
  }

  // For other agents, try to use descriptor command directly
  return null;
}

export async function resolveAgentCommand(agent, env = process.env) {
  // Try registry-based resolution first
  try {
    const { loadRegistry, getDescriptor, hasAgent } = await import("../core/agents/registry.js");
    await loadRegistry();
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

export function shouldIsolateAgentHome(agent, env = process.env) {
  if (env.CPB_AGENT_ISOLATE_HOME === "0") return false;
  return agent !== "browser-agent";
}

function jsonRpcError(code, message, data) {
  const err = { code, message };
  if (data) err.data = data;
  return err;
}

export function resolveWriteAllowPaths(cwd = process.cwd(), env = process.env) {
  return env.CPB_ACP_WRITE_ALLOW
    ? env.CPB_ACP_WRITE_ALLOW.split(",").map((p) =>
        p.trim().includes("*") ? path.resolve(cwd, p.trim()) : path.resolve(p.trim())
      )
    : null;
}

function resolveCodegraphMcpServer(env) {
  if (env.CPB_CODEGRAPH_ENABLED === "0") return null;
  const codebaseRoot = path.resolve(
    env.CPB_CODEGRAPH_ROOT ||
    env.CPB_CODEBASE_ROOT ||
    env.CPB_PROJECT_PATH_OVERRIDE ||
    env.CPB_ACP_CWD ||
    process.cwd(),
  );
  return {
    name: "codegraph",
    command: "codegraph",
    args: ["serve", "--mcp", "--path", codebaseRoot],
  };
}

function codexCodegraphMcpServers(env) {
  const server = resolveCodegraphMcpServer(env);
  return server ? [server] : [];
}

function isCodexAcpCommand(command, args = []) {
  const baseCommand = String(command).split("/").pop();
  if (baseCommand === "codex-acp") return true;
  return baseCommand === "npx" && Array.isArray(args) && args.some((arg) => arg === "@zed-industries/codex-acp");
}

function buildMcpServers(agent, env) {
  const server = resolveCodegraphMcpServer(env);
  if (!server) return [];

  // Codex ACP rejects non-empty session/new.mcpServers. It receives built-in
  // CodeGraph through process-local launch config instead.
  if (agent === "codex") return [];

  return [{ name: server.name, type: "stdio", command: server.command, args: server.args }];
}

function resolveTerminalLaunchCommand(command, args = [], env = process.env) {
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

function codexMcpConfigArgs(env) {
  const args = [];
  for (const server of codexCodegraphMcpServers(env)) {
    if (!server?.name || !server.command || !Array.isArray(server.args)) continue;
    const prefix = `mcp_servers.${server.name}`;
    args.push("-c", `${prefix}.command=${JSON.stringify(server.command)}`);
    args.push("-c", `${prefix}.args=${JSON.stringify(server.args)}`);
  }
  return args;
}

function appendCodexLaunchConfigArgs(agent, command, args, env) {
  if (agent !== "codex" || !isCodexAcpCommand(command, args)) return;

  if (env.CPB_ACP_LAUNCH_PROFILE !== "ui") {
    const headlessArgs = headlessCodexConfigArgs(command, args);
    if (headlessArgs.length > 0) args.push(...headlessArgs);
  }

  const mcpArgs = codexMcpConfigArgs(env);
  if (mcpArgs.length > 0) args.push(...mcpArgs);
}

export class AcpClient {
  constructor({
    agent,
    cwd,
    prompt,
    writeAllowPaths,
    terminalPolicy,
    toolPolicy,
    outputSink = (chunk) => process.stdout.write(chunk),
    errorSink = (chunk) => process.stderr.write(chunk),
    env = process.env,
    resumeSessionId = null,
    reuseSession = false,
  }) {
    this.agent = agent;
    this.cwd = cwd;
    this.prompt = prompt;
    this.writeAllowPaths = writeAllowPaths || null;
    this.terminalPolicy = terminalPolicy || "allow";
    this.toolPolicy = toolPolicy || null;
    this.outputSink = outputSink;
    this.errorSink = errorSink;
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
    this.idleTimeoutMs = Number.parseInt(this.env.CPB_ACP_TIMEOUT_MS || "0", 10);
    this.auditEnv = { ...this.env };
    this.auditFile = resolveAcpAuditFile(this.auditEnv);
    this.activeSessionId = null;
    this.activeSessionCwd = null;
    this.usageTotals = createUsageTotals();
    this.lastPromptUsage = null;
  }

  setAuditContext(envPatch = {}, { cwd = null, writeAllowPaths = undefined } = {}) {
    this.env = { ...this.env, ...envPatch };
    if (cwd) this.env.CPB_ACP_CWD = cwd;
    this.auditEnv = { ...this.env };
    this.auditFile = resolveAcpAuditFile(this.auditEnv);
    if (cwd) this.cwd = cwd;
    if (writeAllowPaths !== undefined) this.writeAllowPaths = writeAllowPaths || null;
  }

  async recordAudit(event, details = {}) {
    if (!this.auditFile) return;
    const auditEnv = this.auditEnv || this.env;
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
    await mkdir(path.dirname(this.auditFile), { recursive: true });
    await appendFile(this.auditFile, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async start() {
    if (this.child && !this.closed && this.initialized) return this.initialized;

    const env = buildChildEnv(this.env, {}, { agent: this.agent });
    if (shouldIsolateAgentHome(this.agent, env)) {
      const cpbRoot = env.CPB_ACP_CPB_ROOT || env.CPB_ROOT || this.cwd;
      const homeEnv = await createAgentHome(
        cpbRoot,
        this.agent,
        env.CPB_ACP_JOB_ID || env.CPB_JOB_ID || null,
        { parentEnv: env },
      );
      Object.assign(env, homeEnv);
    }
    const { command, args } = await resolveAgentCommand(this.agent, env);
    const launchCodegraphServers = this.agent === "codex"
      ? codexCodegraphMcpServers(env)
      : buildMcpServers(this.agent, env);
    const launchCodegraphSummary = summarizeMcpServers(launchCodegraphServers);
    await this.recordAudit("agent_launch", {
      command: path.basename(command),
      mcpServers: launchCodegraphSummary,
      mcpServerNames: launchCodegraphSummary.map((server) => server.name).filter(Boolean),
      codegraphSseUrl: null,
    });
    if (command === "npx" && !env.npm_config_cache) {
      const instanceCache = path.join(tmpdir(), `cpb-npm-cache-${this.agent}-${randomUUID()}`);
      await mkdir(instanceCache, { recursive: true });
      env.npm_config_cache = instanceCache;
    }

    // Agent home isolation keeps provider auth/config available without sharing
    // mutable session history between concurrent ACP jobs.
    const launch = buildAgentSandboxLaunch(command, args, { env, cwd: this.cwd });
    this.childEnv = env;
    this.child = spawn(launch.command, launch.args, {
      cwd: this.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.on("data", (chunk) => {
      this.markActivity();
      this.errorSink(chunk);
    });

    this.child.on("error", (error) => {
      this.rejectAll(error);
    });

    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.clearIdleTimer();
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`ACP agent exited before completing requests (code=${code}, signal=${signal})`));
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
    });

    if (initialized.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`unsupported ACP protocol version: ${initialized.protocolVersion}`);
    }

    this.initialized = initialized;
    return initialized;
  }

  async promptOnce(prompt = this.prompt, cwd = this.cwd) {
    const initialized = await this.start();
    const mcpServers = buildMcpServers(this.agent, this.env);
    const usageBefore = cloneUsageTotals(this.usageTotals);
    const newSession = async (servers) => {
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

    await this.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    await this.lineQueue;

    this.lastPromptUsage = usageDelta(usageBefore, this.usageTotals);
    if (this.lastPromptUsage) {
      await this.recordAudit("prompt_usage", {
        sessionId: session.sessionId,
        usage: this.lastPromptUsage,
      });
    }

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

  async closeActiveSession(reason = "client_close") {
    if (!this.activeSessionId) return;
    const sessionId = this.activeSessionId;
    const cwd = this.activeSessionCwd;
    this.activeSessionId = null;
    this.activeSessionCwd = null;
    if (!this.child || this.closed || !this.initialized?.agentCapabilities?.sessionCapabilities?.close) return;
    await this.request("session/close", { sessionId }).catch(() => null);
    await this.recordAudit("session_close", { sessionId, cwd, reason });
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
    this.terminateTerminals("SIGTERM");
    if (!this.child || this.closed) {
      this.terminateTerminals("SIGKILL", { drop: true });
      return;
    }
    await this.closeActiveSession("client_close");
    const child = this.child;
    const closed = new Promise((resolve) => {
      child.once("close", resolve);
    });
    child.stdin.end();
    const terminateTimer = setTimeout(() => {
      if (!this.closed) this.terminateAgent("SIGTERM");
    }, 500).unref();
    const killTimer = setTimeout(() => {
      if (!this.closed) {
        this.terminateTerminals("SIGKILL", { drop: true });
        this.terminateAgent("SIGKILL");
      }
    }, 1_500).unref();
    const waitTimer = new Promise((resolve) => setTimeout(resolve, 2_000));
    await Promise.race([closed, waitTimer]);
    clearTimeout(terminateTimer);
    clearTimeout(killTimer);
    this.terminateTerminals("SIGKILL", { drop: true });
  }

  waitForTerminalExitStatus(terminal, timeoutMs) {
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
      const done = (exitCode, signal) => {
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

  request(method, params) {
    const id = this.nextId++;
    this.markActivity();
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  respond(id, result) {
    this.markActivity();
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message, data) {
    this.markActivity();
    this.write({ jsonrpc: "2.0", id, error: jsonRpcError(code, message, data) });
  }

  write(message) {
    if (this.child.stdin.destroyed) {
      throw new Error("ACP agent stdin is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  markActivity() {
    if (!this.child || this.idleTimeoutMs <= 0 || this.closed) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.terminateAgent("SIGTERM");
      this.rejectAll(new Error(`ACP prompt idle timed out after ${this.idleTimeoutMs}ms without activity`));
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  terminateAgent(signal) {
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

  signalTerminal(terminal, signal) {
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

  terminateTerminals(signal, { drop = false, cwd = null } = {}) {
    const target = cwd ? path.resolve(cwd) : null;
    for (const [terminalId, terminal] of this.terminals) {
      if (target && path.resolve(terminal.cwd || this.cwd) !== target) continue;
      if (!terminal.exitStatus) {
        this.signalTerminal(terminal, signal);
      }
      if (drop) this.terminals.delete(terminalId);
    }
  }

  async cleanupTerminalsForCwd(cwd, { reason = "worktree_release", termGraceMs = 500, killGraceMs = 1_500 } = {}) {
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

  rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  async handleLine(line) {
    if (!line.trim()) return;

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.errorSink(`[acp:${this.agent}] non-JSON stdout: ${line}\n`);
      return;
    }

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || `ACP error ${message.error.code}`);
        error.code = message.error.code ?? null;
        error.data = message.error.data ?? null;
        error.acpError = message.error;
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

  async handleClientRequest(message) {
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
          await this.handleSessionUpdate(message.params);
          if (Object.hasOwn(message, "id")) this.respond(message.id, null);
          break;
        case "fs/read_text_file":
          this.respond(message.id, await this.readTextFile(message.params));
          break;
        case "fs/write_text_file":
          this.respond(message.id, await this.writeTextFile(message.params));
          break;
        case "session/request_permission":
          this.respond(message.id, this.permissionResponse(message.params));
          break;
        case "terminal/create":
          this.respond(message.id, await this.createTerminal(message.params));
          break;
        case "terminal/output":
          this.respond(message.id, this.terminalOutput(message.params));
          break;
        case "terminal/wait_for_exit":
          this.respond(message.id, await this.waitForTerminalExit(message.params));
          break;
        case "terminal/kill":
          this.respond(message.id, this.killTerminal(message.params));
          break;
        case "terminal/release":
          this.respond(message.id, this.releaseTerminal(message.params));
          break;
        default:
          if (Object.hasOwn(message, "id")) {
            this.respondError(message.id, -32601, `method not found: ${message.method}`);
          }
      }
    } catch (error) {
      if (error.message?.startsWith("PERMISSION_FAIL_FAST:")) {
        this.errorSink(`[acp:${this.agent}] ${error.message}\n`);
        if (Object.hasOwn(message, "id")) {
          this.respondError(message.id, -32000, error.message);
        }
        // Abort the session; agent is stuck on repeated denials
        setImmediate(() => this.close());
        return;
      }
      if (Object.hasOwn(message, "id")) {
        this.respondError(message.id, -32000, error.message, error.guardResult);
      } else {
        this.errorSink(`[acp:${this.agent}] ${error.message}\n`);
      }
    }
  }

  async handleSessionUpdate(params) {
    const update = params?.update;
    if (!update) return;

    const usage = normalizeAcpUsage(update);
    if (usage) {
      addUsage(this.usageTotals, usage);
      await this.recordAudit("token_usage", {
        sessionId: params?.sessionId || null,
        usage,
      });
    }

    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      this.outputSink(update.content.text);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      await this.recordAudit("tool_call", {
        sessionId: params?.sessionId || null,
        ...summarizeToolUpdate(update),
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

  async readTextFile(params) {
    const permResult = await enforcePermission("read", params.path, this.env);
    if (!permResult.allowed) {
      const err = new Error(`read denied: ${params.path} (${permResult.reason})`);
      err.classification = permResult.classification || "deny";
      throw err;
    }
    const content = await readFile(params.path, "utf8");
    if (!params.line && !params.limit) return { content };

    const lines = content.split("\n");
    const start = Math.max((params.line || 1) - 1, 0);
    const end = params.limit ? start + params.limit : lines.length;
    return { content: lines.slice(start, end).join("\n") };
  }

  validateWritePath(targetPath) {
    if (this.env.CPB_PERMISSION_MODE === "off") return;
    if (!this.writeAllowPaths) return;
    // Resolve symlinks to prevent escape via symlink chains
    let resolved;
    try {
      resolved = realpathSync(path.resolve(targetPath));
    } catch {
      // Path doesn't exist yet — resolve parent and append basename
      try {
        const parentReal = realpathSync(path.dirname(path.resolve(targetPath)));
        resolved = path.join(parentReal, path.basename(targetPath));
      } catch {
        resolved = path.resolve(targetPath);
      }
    }
    const allowed = this.writeAllowPaths.some((pattern) => {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const regex = new RegExp(`^${escaped}$`);
      return regex.test(resolved);
    });
    if (!allowed) {
      throw new Error(`write path not allowed: ${targetPath}`);
    }
  }

  async writeTextFile(params) {
    const targetPath = params.path;
    this.validateWritePath(targetPath);

    const permResult = await enforcePermission("write", targetPath, this.env);
    if (!permResult.allowed) {
      const classification = permResult.classification || "deny";
      const msg = permResult.recoveryGuidance
        ? `write denied: ${targetPath} (${permResult.reason}); ${permResult.recoveryGuidance}`
        : `write denied: ${targetPath} (${permResult.reason})`;
      if (isRepeatedDenial(targetPath, "write")) {
        const err = new Error(`PERMISSION_FAIL_FAST: repeated write denials for ${targetPath}. ${permResult.reason}`);
        err.classification = classification;
        throw err;
      }
      const err = new Error(msg);
      err.classification = classification;
      throw err;
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
    return null;
  }

  isWikiHandoffFile(filePath) {
    const normalized = filePath.replace(/\\/g, "/");
    return /wiki\/projects\/[^/]+\/(inbox|outputs)\/(plan|deliverable)-\d+\.md$/.test(normalized);
  }

  validateHandoffContent(content, filePath) {
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

  permissionResponse(params) {
    const wantsReject = this.env.CPB_ACP_PERMISSION === "reject";
    const options = params?.options || [];
    const preferred = options.find((option) =>
      wantsReject ? option.kind?.startsWith("reject") : option.kind?.startsWith("allow")
    ) || options[0];

    if (!preferred) {
      return { outcome: { outcome: "cancelled" } };
    }
    return { outcome: { outcome: "selected", optionId: preferred.optionId } };
  }

  async createTerminal(params) {
    if (this.terminalPolicy === "deny") {
      throw new Error("terminal access denied for this phase");
    }

    const terminalCwd = path.resolve(this.cwd, params.cwd || this.cwd);
    const commandLine = [params.command, ...(params.args || [])].join(" ");
    const permResult = enforcePermissionSync("execute", commandLine, this.env);
    if (!permResult.allowed) {
      const classification = permResult.classification || "deny";
      const msg = permResult.recoveryGuidance
        ? `execute denied: ${commandLine} (${permResult.reason}); ${permResult.recoveryGuidance}`
        : `execute denied: ${commandLine} (${permResult.reason})`;
      const err = new Error(msg);
      err.classification = classification;
      throw err;
    }

    const guardResult = classifyDeleteRisk(params.command, params.args || [], { cwd: terminalCwd, repoRoot: this.cwd });
    if (!guardResult.allowed) {
      logDeleteBlock(params.command, params.args || [], terminalCwd, guardResult, this.errorSink);
      const err = new Error(formatDeleteBlockedMessage(guardResult));
      err.guardResult = guardResult;
      throw err;
    }

    const terminalId = `term-${this.nextTerminalId++}`;
    const extraEnv = {};
    for (const item of params.env || []) {
      if (item?.name) extraEnv[item.name] = item.value;
    }
    const env = buildChildEnv(this.childEnv || this.env, extraEnv, { agent: this.agent });
    const terminalLaunch = resolveTerminalLaunchCommand(params.command, params.args || [], env);

    await this.recordAudit("terminal_launch", {
      cwd: terminalCwd,
      command: params.command,
      launchCommand: terminalLaunch.command,
      rtkEnabled: terminalLaunch.rtkEnabled,
    });

    const launch = buildAgentSandboxLaunch(terminalLaunch.command, terminalLaunch.args, { env, cwd: terminalCwd });
    const detached = process.platform !== "win32";
    const child = spawn(launch.command, launch.args, {
      cwd: terminalCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });

    const terminal = {
      child,
      cwd: terminalCwd,
      detached,
      output: "",
      truncated: false,
      outputByteLimit: params.outputByteLimit || 1048576,
      exitStatus: null,
      waiters: [],
    };

    const append = (chunk) => {
      this.markActivity();
      terminal.output += chunk.toString("utf8");
      if (Buffer.byteLength(terminal.output, "utf8") > terminal.outputByteLimit) {
        terminal.truncated = true;
        terminal.output = terminal.output.slice(-terminal.outputByteLimit);
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("exit", (exitCode, signal) => {
      terminal.exitStatus = { exitCode, signal };
      for (const resolve of terminal.waiters) resolve(terminal.exitStatus);
      terminal.waiters = [];
    });

    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }

  terminalOutput(params) {
    const terminal = this.getTerminal(params.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.truncated,
      exitStatus: terminal.exitStatus,
    };
  }

  waitForTerminalExit(params) {
    const terminal = this.getTerminal(params.terminalId);
    if (terminal.exitStatus) return terminal.exitStatus;
    return new Promise((resolve) => terminal.waiters.push(resolve));
  }

  killTerminal(params) {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal.exitStatus) this.signalTerminal(terminal, "SIGTERM");
    return null;
  }

  releaseTerminal(params) {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal.exitStatus) this.signalTerminal(terminal, "SIGTERM");
    this.terminals.delete(params.terminalId);
    return null;
  }

  getTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`unknown terminal: ${terminalId}`);
    return terminal;
  }
}
