#!/usr/bin/env node
import readline from "node:readline";

let _engineModule = null;
async function getEngine() {
  if (!_engineModule) {
    _engineModule = await import("../core/agents/drivers/browser/engine.mjs");
  }
  return _engineModule;
}

let _schemaModule = null;
async function getSchema() {
  if (!_schemaModule) {
    _schemaModule = await import("../core/agents/drivers/browser/profile-schema.mjs");
  }
  return _schemaModule;
}

const PROTOCOL_VERSION = 1;
const CHUNK_SIZE = 4096;

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "TimeoutError";
  }
}

const sessions = new Map();
let shuttingDown = false;

function writeMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendNotification(method, params) {
  writeMessage({ jsonrpc: "2.0", method, params });
}

function respondError(id, code, message, data) {
  const error = { code, message };
  if (data) error.data = data;
  writeMessage({ jsonrpc: "2.0", id, error });
}

function resolveProviderName(env = process.env) {
  return (
    env.CPB_ACP_BROWSER_AGENT_PROVIDER ||
    env.CPB_ACP_BROWSER_AGENT_VARIANT ||
    env.CPB_ACP_AGENT_VARIANT ||
    "chatgpt"
  );
}

async function mapErrorToJsonRpc(error) {
  const { LoginRequiredError, ProviderProfileError } = await getSchema();
  if (error instanceof LoginRequiredError || error.name === "BrowserAgentLoginRequiredError") {
    return { code: -32001, message: `login required: ${error.message}` };
  }
  if (error instanceof ProviderProfileError) {
    return { code: -32002, message: `provider profile error: ${error.message}` };
  }
  if (error instanceof TimeoutError || error.name === "BrowserAgentTimeoutError") {
    return { code: -32003, message: `timeout: ${error.message}` };
  }
  return { code: -32000, message: error.message || "internal error" };
}

function* chunkText(text, size) {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
  }
}

function streamResult(sessionId, text) {
  for (const chunk of chunkText(text, CHUNK_SIZE)) {
    sendNotification("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      },
    });
  }
}

async function handleInitialize(id) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        sessionCapabilities: { close: true },
      },
      agentInfo: {
        name: "browser-agent",
        version: "1.0.0",
      },
    },
  });
}

async function handleSessionNew(id, params) {
  const sessionId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const abortController = new AbortController();
  sessions.set(sessionId, { abortController, cwd: params?.cwd || process.cwd() });
  writeMessage({ jsonrpc: "2.0", id, result: { sessionId } });
}

async function handleSessionPrompt(id, params) {
  const { sessionId, prompt } = params;
  const session = sessions.get(sessionId);
  if (!session) {
    respondError(id, -32004, `session not found: ${sessionId}`);
    return;
  }

  const promptText = Array.isArray(prompt)
    ? prompt.map((p) => (p.type === "text" ? p.text : "")).join("")
    : String(prompt || "");

  if (!promptText) {
    respondError(id, -32602, "prompt must contain non-empty text");
    return;
  }

  const providerName = resolveProviderName();

  try {
    const { executeBrowserAgent } = await getEngine();
    const result = await executeBrowserAgent({
      providerName,
      prompt: promptText,
      signal: session.abortController.signal,
    });

    streamResult(sessionId, result.text);
    writeMessage({ jsonrpc: "2.0", id, result: null });
  } catch (error) {
    if (error.name === "AbortError" || error.message === "Aborted") {
      respondError(id, -32005, "session aborted");
      return;
    }
    const { code, message } = await mapErrorToJsonRpc(error);
    respondError(id, code, message);
  }
}

async function handleSessionClose(id, params) {
  const { sessionId } = params;
  const session = sessions.get(sessionId);
  if (session) {
    session.abortController.abort();
    sessions.delete(sessionId);
  }
  writeMessage({ jsonrpc: "2.0", id, result: null });
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;

  if (method === "initialize") {
    await handleInitialize(id);
  } else if (method === "session/new") {
    await handleSessionNew(id, params);
  } else if (method === "session/prompt") {
    await handleSessionPrompt(id, params);
  } else if (method === "session/close") {
    await handleSessionClose(id, params);
  } else {
    respondError(id, -32601, `method not found: ${method}`);
  }
}

function setupStdinReader() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write(`[browser-agent] invalid JSON: ${line}\n`);
      return;
    }

    if (shuttingDown) {
      if (Object.hasOwn(message, "id")) {
        respondError(message.id, -32006, "server is shutting down");
      }
      return;
    }

    try {
      await handleRequest(message);
    } catch (error) {
      if (Object.hasOwn(message, "id")) {
        respondError(message.id, -32000, error.message || "internal error");
      } else {
        process.stderr.write(`[browser-agent] ${error.message}\n`);
      }
    }
  });

  rl.on("close", () => {
    shutdown("stdin closed");
  });
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[browser-agent] shutting down: ${reason}\n`);

  for (const [sessionId, session] of sessions) {
    session.abortController.abort();
    sessions.delete(sessionId);
  }

  setTimeout(() => process.exit(0), 500).unref();
}

function onSignal(signal) {
  shutdown(signal);
}

process.once("SIGINT", () => onSignal("SIGINT"));
process.once("SIGTERM", () => onSignal("SIGTERM"));

// Keep stdin alive in non-TTY environments
if (!process.stdin.isTTY) {
  process.stdin.on("end", () => shutdown("stdin end"));
}

setupStdinReader();
