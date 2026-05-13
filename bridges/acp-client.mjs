#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const PROTOCOL_VERSION = 1;

const usage = `Usage: acp-client.mjs --agent <codex|claude> [--cwd <path>]

Reads a prompt from stdin and sends it to an ACP agent over stdio.

Environment:
  FLOW_ACP_CODEX_COMMAND    Command for the Codex ACP agent
  FLOW_ACP_CODEX_ARGS       Args for the Codex ACP agent (JSON array or shell-like words)
  FLOW_ACP_CLAUDE_COMMAND   Command for the Claude ACP agent
  FLOW_ACP_CLAUDE_ARGS      Args for the Claude ACP agent (JSON array or shell-like words)
  FLOW_ACP_TIMEOUT_MS       Idle timeout in milliseconds; activity resets it (default: 1800000)
  FLOW_ACP_PERMISSION       allow or reject permission requests (default: allow)
  FLOW_ACP_WRITE_ALLOW      Comma-separated glob patterns for allowed write paths (default: none = allow all)
  FLOW_ACP_TERMINAL         allow or deny terminal creation (default: allow)
`;

function parseCli(argv) {
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
  if (!["codex", "claude"].includes(result.agent)) {
    throw new Error("--agent must be codex or claude");
  }
  result.cwd = path.resolve(result.cwd || process.cwd());
  return result;
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
  if (agent === "codex") {
    if (commandExists("codex-acp")) return { command: "codex-acp", args: [] };
    return { command: "npx", args: ["-y", "@zed-industries/codex-acp"] };
  }

  if (commandExists("claude-agent-acp")) return { command: "claude-agent-acp", args: [] };
  return { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"] };
}

function resolveAgentCommand(agent) {
  const upper = agent.toUpperCase();
  const defaults = defaultAgentCommand(agent);
  return {
    command: process.env[`FLOW_ACP_${upper}_COMMAND`] || defaults.command,
    args: parseEnvArgs(process.env[`FLOW_ACP_${upper}_ARGS`]) ?? defaults.args,
  };
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function jsonRpcError(code, message) {
  return { code, message };
}

class AcpClient {
  constructor({ agent, cwd, prompt, writeAllowPaths, terminalPolicy }) {
    this.agent = agent;
    this.cwd = cwd;
    this.prompt = prompt;
    this.writeAllowPaths = writeAllowPaths || null;
    this.terminalPolicy = terminalPolicy || "allow";
    this.nextId = 1;
    this.pending = new Map();
    this.terminals = new Map();
    this.nextTerminalId = 1;
    this.closed = false;
    this.lineQueue = Promise.resolve();
    this.idleTimer = null;
    this.idleTimeoutMs = Number.parseInt(process.env.FLOW_ACP_TIMEOUT_MS || "1800000", 10);
  }

  async run() {
    const { command, args } = resolveAgentCommand(this.agent);
    this.child = spawn(command, args, {
      cwd: this.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.on("data", (chunk) => {
      this.markActivity();
      process.stderr.write(chunk);
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

    try {
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
          name: "flow",
          title: "Flow",
          version: "0.1.0",
        },
      });

      if (initialized.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`unsupported ACP protocol version: ${initialized.protocolVersion}`);
      }

      const session = await this.request("session/new", {
        cwd: this.cwd,
        mcpServers: [],
      });

      await this.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [
          {
            type: "text",
            text: this.prompt,
          },
        ],
      });
      await this.lineQueue;

      if (initialized.agentCapabilities?.sessionCapabilities?.close) {
        await this.request("session/close", { sessionId: session.sessionId }).catch(() => null);
      }
    } finally {
      this.clearIdleTimer();
      this.child.stdin.end();
      setTimeout(() => {
        if (!this.closed) this.terminateAgent("SIGTERM");
      }, 500).unref();
    }
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

  respondError(id, code, message) {
    this.markActivity();
    this.write({ jsonrpc: "2.0", id, error: jsonRpcError(code, message) });
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
      process.stderr.write(`[acp:${this.agent}] non-JSON stdout: ${line}\n`);
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
      if (Object.hasOwn(message, "id")) {
        this.respondError(message.id, -32000, error.message);
      } else {
        process.stderr.write(`[acp:${this.agent}] ${error.message}\n`);
      }
    }
  }

  handleSessionUpdate(params) {
    const update = params?.update;
    if (!update) return;

    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      process.stdout.write(update.content.text);
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const title = update.title || update.toolCallId || "tool";
      const status = update.status ? ` ${update.status}` : "";
      process.stderr.write(`[acp:${this.agent}] ${title}${status}\n`);
    } else if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      for (const entry of update.entries) {
        process.stderr.write(`[acp:${this.agent}] plan ${entry.status}: ${entry.content}\n`);
      }
    }
  }

  async readTextFile(params) {
    const content = await readFile(params.path, "utf8");
    if (!params.line && !params.limit) return { content };

    const lines = content.split("\n");
    const start = Math.max((params.line || 1) - 1, 0);
    const end = params.limit ? start + params.limit : lines.length;
    return { content: lines.slice(start, end).join("\n") };
  }

  validateWritePath(targetPath) {
    if (!this.writeAllowPaths) return;
    const resolved = path.resolve(targetPath);
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
    await mkdir(path.dirname(targetPath), { recursive: true });

    if (this.isWikiHandoffFile(targetPath)) {
      this.validateHandoffContent(params.content, targetPath);
    }

    const tmpPath = path.join(
      path.dirname(targetPath),
      `.flow-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
    const wantsReject = process.env.FLOW_ACP_PERMISSION === "reject";
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
    const terminalId = `term-${this.nextTerminalId++}`;
    const env = { ...process.env };
    for (const item of params.env || []) env[item.name] = item.value;

    const child = spawn(params.command, params.args || [], {
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

try {
  const options = parseCli(process.argv.slice(2));
  const prompt = await readStdin();

  const writeAllowPaths = process.env.FLOW_ACP_WRITE_ALLOW
    ? process.env.FLOW_ACP_WRITE_ALLOW.split(",").map((p) =>
        p.trim().includes("*") ? path.resolve(options.cwd, p.trim()) : path.resolve(p.trim())
      )
    : null;

  const terminalPolicy = process.env.FLOW_ACP_TERMINAL === "deny" ? "deny" : "allow";

  await new AcpClient({ ...options, prompt, writeAllowPaths, terminalPolicy }).run();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
