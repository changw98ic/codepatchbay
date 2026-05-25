import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

function commandExists(command) {
  const result = spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command]);
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
        const command = envCommand || descriptor.command;
        const args = parseEnvArgs(env[`${prefix}_ARGS`]) ?? [...(descriptor.args || [])];

        // Fallback: if primary command not found and descriptor has fallback
        if (!envCommand && descriptor.fallbackCommand && !commandExists(command)) {
          return { command: descriptor.fallbackCommand, args: [...(descriptor.fallbackArgs || [])] };
        }

        // Codex headless config
        if (agent === "codex" && env.CPB_ACP_LAUNCH_PROFILE !== "ui") {
          const headlessArgs = headlessCodexConfigArgs(command, args);
          if (headlessArgs.length > 0) args.push(...headlessArgs);
        }

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

  if (agent === "codex" && env.CPB_ACP_LAUNCH_PROFILE !== "ui") {
    const headlessArgs = headlessCodexConfigArgs(command, args);
    if (headlessArgs.length > 0) args.push(...headlessArgs);
  }

  return { command, args };
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
  }) {
    this.agent = agent;
    this.cwd = cwd;
    this.prompt = prompt;
    this.writeAllowPaths = writeAllowPaths || null;
    this.terminalPolicy = terminalPolicy || "allow";
    this.toolPolicy = toolPolicy || null;
    this.outputSink = outputSink;
    this.errorSink = errorSink;
    this.env = env;
    this.resumeSessionId = resumeSessionId;
    this.nextId = 1;
    this.pending = new Map();
    this.terminals = new Map();
    this.nextTerminalId = 1;
    this.closed = false;
    this.initialized = null;
    this.childEnv = null;
    this.lineQueue = Promise.resolve();
    this.idleTimer = null;
    this.idleTimeoutMs = Number.parseInt(this.env.CPB_ACP_TIMEOUT_MS || "1800000", 10);
  }

  async start() {
    if (this.child && !this.closed && this.initialized) return this.initialized;

    const env = buildChildEnv(this.env, {}, { agent: this.agent });
    const { command, args } = await resolveAgentCommand(this.agent, env);
    if (command === "npx" && !env.npm_config_cache) {
      const instanceCache = path.join(tmpdir(), `cpb-npm-cache-${this.agent}-${randomUUID()}`);
      await mkdir(instanceCache, { recursive: true });
      env.npm_config_cache = instanceCache;
    }

    // Per-agent HOME isolation (default on; disable with CPB_AGENT_ISOLATE_HOME=0)
    if (env.CPB_AGENT_ISOLATE_HOME !== "0") {
      const cpbRoot = env.CPB_ACP_CPB_ROOT || env.CPB_ROOT;
      if (cpbRoot) {
        const { createAgentHome } = await import("../core/agents/isolation.js");
        const homeEnv = await createAgentHome(cpbRoot, this.agent, env.CPB_JOB_ID);
        Object.assign(env, homeEnv);
      }
    }
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

    // Try to resume a cached session, fall back to new
    let session;
    if (this.resumeSessionId) {
      try {
        session = await this.request("session/resume", { sessionId: this.resumeSessionId, cwd });
      } catch {
        session = await this.request("session/new", { cwd, mcpServers: [] });
      }
    } else {
      session = await this.request("session/new", { cwd, mcpServers: [] });
    }

    await this.request("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });
    await this.lineQueue;

    if (initialized.agentCapabilities?.sessionCapabilities?.close) {
      await this.request("session/close", { sessionId: session.sessionId }).catch(() => null);
    }

    return session.sessionId;
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
    if (!this.child || this.closed) return;
    const child = this.child;
    const closed = new Promise((resolve) => {
      child.once("close", resolve);
    });
    child.stdin.end();
    const terminateTimer = setTimeout(() => {
      if (!this.closed) this.terminateAgent("SIGTERM");
    }, 500).unref();
    const killTimer = setTimeout(() => {
      if (!this.closed) this.terminateAgent("SIGKILL");
    }, 1_500).unref();
    const waitTimer = new Promise((resolve) => setTimeout(resolve, 2_000));
    await Promise.race([closed, waitTimer]);
    clearTimeout(terminateTimer);
    clearTimeout(killTimer);
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
        pending.reject(new Error(message.error.message || `ACP error ${message.error.code}`));
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
          this.handleSessionUpdate(message.params);
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
          this.respond(message.id, this.createTerminal(message.params));
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

  handleSessionUpdate(params) {
    const update = params?.update;
    if (!update) return;

    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      this.outputSink(update.content.text);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
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

  createTerminal(params) {
    if (this.terminalPolicy === "deny") {
      throw new Error("terminal access denied for this phase");
    }

    const terminalCwd = params.cwd || this.cwd;
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

    const launch = buildAgentSandboxLaunch(params.command, params.args || [], { env, cwd: terminalCwd });
    const child = spawn(launch.command, launch.args, {
      cwd: params.cwd || this.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const terminal = {
      child,
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
    if (!terminal.exitStatus) terminal.child.kill("SIGTERM");
    return null;
  }

  releaseTerminal(params) {
    const terminal = this.getTerminal(params.terminalId);
    if (!terminal.exitStatus) terminal.child.kill("SIGTERM");
    this.terminals.delete(params.terminalId);
    return null;
  }

  getTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`unknown terminal: ${terminalId}`);
    return terminal;
  }
}
