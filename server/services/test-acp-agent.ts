#!/usr/bin/env node
// @ts-nocheck
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const PROTOCOL_VERSION = 1;
const DEFAULT_CHUNK_SIZE = 4096;

const sessions = new Map();
const pending = new Map();
let nextId = 1;
let shuttingDown = false;
const options = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--response") parsed.response = argv[++i] ?? "";
    else if (arg === "--response-file") parsed.responseFile = argv[++i] ?? "";
    else if (arg === "--scenario-file") parsed.scenarioFile = argv[++i] ?? "";
    else if (arg === "--transcript-file") parsed.transcriptFile = argv[++i] ?? "";
    else if (arg === "--delay-ms") parsed.delayMs = Number(argv[++i] ?? 0);
    else if (arg === "--error") parsed.error = argv[++i] ?? "forced test ACP error";
    else if (arg === "--agent-name") parsed.agentName = argv[++i] ?? "";
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: test-acp-agent.js [options]

ACP-compatible deterministic test provider for CodePatchBay.

Options:
  --response TEXT          Stream TEXT for every prompt
  --response-file PATH     Stream file content for every prompt
  --scenario-file PATH     Load JSON response scenario
  --transcript-file PATH   Append JSONL protocol transcript
  --delay-ms N             Delay prompt responses by N milliseconds
  --error TEXT             Return a session/prompt JSON-RPC error
  --agent-name NAME        Agent name reported during initialize`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function record(event) {
  const transcriptFile = options.transcriptFile || process.env.CPB_TEST_ACP_TRANSCRIPT_FILE;
  if (!transcriptFile) return;
  await appendFile(
    path.resolve(transcriptFile),
    `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`,
    "utf8",
  ).catch(() => {});
}

function respond(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeMessage({ jsonrpc: "2.0", id, error });
}

function notify(method, params) {
  writeMessage({ jsonrpc: "2.0", method, params });
}

function requestClient(method, params) {
  const id = nextId++;
  writeMessage({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function textFromPrompt(prompt) {
  if (Array.isArray(prompt)) {
    return prompt.map((part) => (part?.type === "text" ? part.text : "")).join("");
  }
  if (typeof prompt === "string") return prompt;
  return "";
}

function cleanPath(value) {
  return String(value || "").trim().replace(/^["'`]+|["'`]+$/g, "").replace(/[.,]$/, "");
}

function chunkText(text, chunkSize = DEFAULT_CHUNK_SIZE) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));
  return chunks.length > 0 ? chunks : [""];
}

function interpolate(value, context) {
  return String(value ?? "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => {
    if (Object.hasOwn(context, key)) return String(context[key] ?? "");
    return "";
  });
}

async function loadJsonFile(filePath, label) {
  const fullPath = path.resolve(filePath);
  try {
    return JSON.parse(await readFile(fullPath, "utf8"));
  } catch (error) {
    throw new Error(`${label}: failed to read valid JSON from ${fullPath}: ${error.message}`);
  }
}

async function loadTextFile(filePath, label) {
  const fullPath = path.resolve(filePath);
  try {
    return readFile(fullPath, "utf8");
  } catch (error) {
    throw new Error(`${label}: failed to read ${fullPath}: ${error.message}`);
  }
}

async function loadScenario() {
  const scenarioFile = options.scenarioFile || process.env.CPB_TEST_ACP_SCENARIO_FILE;
  if (scenarioFile) {
    const scenario = await loadJsonFile(scenarioFile, "scenario file");
    if (Array.isArray(scenario)) return { responses: scenario };
    if (scenario && typeof scenario === "object") return scenario;
    throw new Error("scenario file: expected object or array");
  }

  const responseFile = options.responseFile || process.env.CPB_TEST_ACP_RESPONSE_FILE;
  if (responseFile) {
    return {
      responses: [
        { output: await loadTextFile(responseFile, "response file") },
      ],
    };
  }

  return {
    responses: [
      { output: options.response ?? process.env.CPB_TEST_ACP_RESPONSE ?? "cpb-test-acp-agent response" },
    ],
  };
}

function matchesEntry(entry, context) {
  if (entry.agent && entry.agent !== context.agent) return false;
  if (entry.phase && entry.phase !== context.phase) return false;
  if (entry.role && entry.role !== context.role) return false;
  if (entry.match && !context.prompt.includes(entry.match)) return false;
  const regex = entry.matchRegex || entry.promptRegex;
  if (regex && !new RegExp(regex, "m").test(context.prompt)) return false;
  return true;
}

function selectResponse(scenario, context) {
  const responses = Array.isArray(scenario.responses) ? scenario.responses : [];
  return responses.find((entry) => matchesEntry(entry, context)) || scenario.default || responses[0] || {};
}

function pathFromWrite(write, context) {
  if (write.path) return interpolate(write.path, context);
  if (!write.pathRegex) throw new Error("scenario write is missing path or pathRegex");
  const match = context.prompt.match(new RegExp(write.pathRegex, "m"));
  if (!match?.[1]) throw new Error(`scenario write pathRegex did not match prompt: ${write.pathRegex}`);
  return cleanPath(interpolate(match[1], context));
}

async function contentFromWrite(write, context) {
  if (write.contentFile) {
    return interpolate(await loadTextFile(interpolate(write.contentFile, context), "scenario write.contentFile"), context);
  }
  return interpolate(write.content ?? "", context);
}

async function writeArtifacts(response, context) {
  const writes = Array.isArray(response.writes) ? response.writes : [];
  for (const write of writes) {
    const filePath = pathFromWrite(write, context);
    const content = await contentFromWrite(write, context);
    await record({ event: "fs/write_text_file", path: filePath });
    await requestClient("fs/write_text_file", { path: filePath, content });
  }
}

async function outputChunks(response, context) {
  if (Array.isArray(response.chunks)) return response.chunks.map((chunk) => interpolate(chunk, context));
  if (response.outputFile) {
    return chunkText(
      interpolate(await loadTextFile(interpolate(response.outputFile, context), "response.outputFile"), context),
      Number(response.chunkSize) || DEFAULT_CHUNK_SIZE,
    );
  }
  if (Object.hasOwn(response, "output")) {
    return chunkText(interpolate(response.output, context), Number(response.chunkSize) || DEFAULT_CHUNK_SIZE);
  }
  return [];
}

async function streamOutput(sessionId, response, context) {
  const chunks = await outputChunks(response, context);
  for (const chunk of chunks) {
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      },
    });
  }
}

async function streamToolCalls(sessionId, response) {
  const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
  for (const call of toolCalls) {
    const update = {
      sessionUpdate: call.sessionUpdate || "tool_call",
      toolCallId: call.toolCallId || call.id || `tool-${nextId++}`,
      title: call.title || call.name || "tool",
      status: call.status || "completed",
    };
    if (call.kind) update.kind = call.kind;
    if (call.serverName) update.serverName = call.serverName;
    if (call.toolName) update.toolName = call.toolName;
    await record({
      event: "session/update",
      sessionUpdate: update.sessionUpdate,
      toolCallId: update.toolCallId,
      title: update.title,
      status: update.status,
    });
    notify("session/update", { sessionId, update });
  }
}

async function streamUsage(sessionId, response) {
  const updates = Array.isArray(response.usageUpdates)
    ? response.usageUpdates
    : (response.usage ? [{ usage: response.usage }] : []);
  for (const entry of updates) {
    const update = {
      sessionUpdate: entry.sessionUpdate || "usage",
      usage: entry.usage || entry,
    };
    await record({
      event: "session/update",
      sessionUpdate: update.sessionUpdate,
      usage: update.usage,
    });
    notify("session/update", { sessionId, update });
  }
}

async function maybeDelay(response) {
  const delayMs = Number(response.delayMs ?? options.delayMs ?? process.env.CPB_TEST_ACP_DELAY_MS ?? 0);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function handleInitialize(id) {
  await record({ event: "initialize" });
  respond(id, {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: { close: true },
    },
    agentInfo: {
      name: options.agentName || process.env.CPB_TEST_ACP_AGENT_NAME || "cpb-test-acp-agent",
      version: "1.0.0",
    },
  });
}

async function handleSessionNew(id, params = {}) {
  const sessionId = `test-acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sessions.set(sessionId, { cwd: params.cwd || process.cwd() });
  await record({
    event: "session/new",
    sessionId,
    cwd: params.cwd || process.cwd(),
    mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [],
  });
  respond(id, { sessionId });
}

async function handleSessionResume(id, params = {}) {
  const sessionId = params.sessionId || `test-acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sessions.set(sessionId, { cwd: params.cwd || process.cwd() });
  await record({ event: "session/resume", sessionId, cwd: params.cwd || process.cwd() });
  respond(id, { sessionId });
}

async function handleSessionPrompt(id, params = {}) {
  const sessionId = params.sessionId;
  const session = sessions.get(sessionId);
  if (!session) {
    respondError(id, -32004, `session not found: ${sessionId}`);
    return;
  }

  const prompt = textFromPrompt(params.prompt);
  const context = {
    agent: process.env.CPB_ACP_AGENT || options.agentName || process.env.CPB_TEST_ACP_AGENT_NAME || "test",
    cwd: session.cwd,
    phase: process.env.CPB_ACP_PHASE || "",
    role: process.env.CPB_ACP_ROLE || "",
    prompt,
    sessionId,
  };
  const scenario = await loadScenario();
  const response = selectResponse(scenario, context);
  await record({ event: "session/prompt", sessionId, prompt, response: response.name || null });

  if (response.error || options.error || process.env.CPB_TEST_ACP_ERROR) {
    respondError(id, response.errorCode || -32000, response.error || options.error || process.env.CPB_TEST_ACP_ERROR);
    return;
  }

  await maybeDelay(response);
  await writeArtifacts(response, context);
  await streamToolCalls(sessionId, response, context);
  await streamUsage(sessionId, response, context);
  await streamOutput(sessionId, response, context);
  respond(id, null);
}

async function handleSessionClose(id, params = {}) {
  if (params.sessionId) sessions.delete(params.sessionId);
  await record({ event: "session/close", sessionId: params.sessionId || null });
  respond(id, null);
}

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (shuttingDown) {
    if (Object.hasOwn(message, "id")) respondError(id, -32006, "server is shutting down");
    return;
  }

  switch (method) {
    case "initialize":
      await handleInitialize(id);
      break;
    case "session/new":
      await handleSessionNew(id, params);
      break;
    case "session/resume":
      await handleSessionResume(id, params);
      break;
    case "session/prompt":
      await handleSessionPrompt(id, params);
      break;
    case "session/close":
      await handleSessionClose(id, params);
      break;
    default:
      respondError(id, -32601, `method not found: ${method}`);
  }
}

async function handleLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write(`[test-acp-agent] invalid JSON: ${line}\n`);
    return;
  }

  if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || `ACP client error ${message.error.code}`));
    else waiter.resolve(message.result);
    return;
  }

  if (message.method) {
    try {
      await handleRequest(message);
    } catch (error) {
      if (Object.hasOwn(message, "id")) respondError(message.id, -32000, error.message || "internal error");
      else process.stderr.write(`[test-acp-agent] ${error.message}\n`);
    }
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const waiter of pending.values()) {
    waiter.reject(new Error("test ACP agent shutting down"));
  }
  pending.clear();
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  void handleLine(line);
});
rl.on("close", () => {
  shutdown();
});
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
