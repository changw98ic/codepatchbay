#!/usr/bin/env node
import readline from "node:readline";

const PROTOCOL_VERSION = 1;
const mode = process.env.CPB_FAKE_ACP_MODE || "default";
let nextId = 1;
const pending = new Map();
let sessionId = "fake-session";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function call(method, params) {
  const id = nextId++;
  write({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function textFromPrompt(params) {
  const prompt = Array.isArray(params?.prompt) ? params.prompt : [];
  return prompt.map((part) => part?.text || "").join("\n");
}

function outputPathFromPrompt(text) {
  const patterns = [
    /Write (?:the )?(?:plan|deliverable|verdict|artifact)?(?: to)?:\s*(.+)$/im,
    /Write .*? to:\s*(.+)$/im,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function sendChunk(text) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeRequestedFile(text, content) {
  const target = outputPathFromPrompt(text);
  if (!target) return;
  await call("fs/write_text_file", { path: target, content }).catch(() => null);
}

function handoffContent() {
  return [
    "## Handoff",
    "Written through ACP fs/write_text_file",
    "",
    "## Acceptance-Criteria",
    "- Fake ACP handoff accepted",
    "",
  ].join("\n");
}

function defaultContent() {
  return "Written through ACP fs/write_text_file\n";
}

async function requestTerminal(command, args) {
  return call("terminal/create", { command, args, cwd: process.cwd() });
}

async function runTerminalAction(text) {
  if (text.includes("ACTION: read_only_terminal")) {
    try {
      await requestTerminal("git", ["status", "--short"]);
      sendChunk("terminal-allowed\n");
    } catch {
      sendChunk("terminal-denied\n");
    }
    return;
  }

  if (text.includes("ACTION: test_terminal")) {
    try {
      await requestTerminal(process.execPath, ["--test", "--help"]);
      sendChunk("terminal-allowed\n");
    } catch {
      sendChunk("terminal-denied\n");
    }
    return;
  }

  if (text.includes("ACTION: unsafe_terminal")) {
    try {
      await requestTerminal("rm", ["-rf", "tmp"]);
      sendChunk("terminal-allowed\n");
    } catch {
      sendChunk("terminal-denied\n");
    }
  }
}

async function handlePrompt(params) {
  sessionId = params?.sessionId || sessionId;
  const text = textFromPrompt(params);

  if (mode === "active") {
    const ticks = Number(process.env.CPB_TEST_ACTIVE_TICKS || 5);
    const tickMs = Number(process.env.CPB_TEST_ACTIVE_TICK_MS || 100);
    for (let i = 1; i <= ticks; i += 1) {
      sendChunk(`tick-${i}\n`);
      if (i < ticks) await delay(tickMs);
    }
    return;
  }

  if (mode === "terminal") {
    await requestTerminal("echo", ["hello"]).catch(() => null);
    sendChunk("done\n");
    return;
  }

  if (mode === "permission-terminal") {
    await runTerminalAction(text);
    return;
  }

  if (mode === "tool-policy") {
    if (text.includes("ACTION: write_file")) {
      await writeRequestedFile(text, "Written by tool-policy agent\n");
    }
    if (text.includes("ACTION: terminal")) {
      await requestTerminal("echo", ["hello"]).catch(() => null);
    }
    sendChunk("done\n");
    return;
  }

  if (mode === "handoff") {
    await writeRequestedFile(text, handoffContent());
    sendChunk("done\n");
    return;
  }

  if (mode === "bad-handoff") {
    await writeRequestedFile(text, "Written through ACP fs/write_text_file\n");
    sendChunk("done\n");
    return;
  }

  await writeRequestedFile(text, defaultContent());
  sendChunk("done\n");
}

async function handleRequest(message) {
  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
          sessionCapabilities: { close: true },
        },
        agentInfo: {
          name: "fake-acp",
          title: "Fake ACP Agent",
          version: "0.1.0",
        },
      });
      break;
    case "session/new":
      sessionId = `fake-session-${Date.now()}`;
      result(message.id, { sessionId });
      break;
    case "session/prompt":
      await handlePrompt(message.params);
      result(message.id, null);
      break;
    case "session/close":
      result(message.id, null);
      process.exit(0);
      break;
    default:
      error(message.id, -32601, `method not found: ${message.method}`);
  }
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "ACP request failed"));
    else waiter.resolve(message.result);
    return;
  }

  if (message.method) {
    handleRequest(message).catch((err) => {
      if (Object.hasOwn(message, "id")) error(message.id, -32000, err.message);
    });
  }
});

// Exit cleanly when the client closes stdin (EOF). Without this the readline
// handle keeps the event loop alive and the fake-agent process lingers as a
// zombie — which under node --test can stall subsequent runClient spawns.
rl.on("close", () => process.exit(0));
