#!/usr/bin/env node
// test-acp-agent.ts — Scriptable ACP agent for integration testing
// Supports:
//   --response <text>           stream a fixed response, ignoring scenarios
//   --scenario-file <path>      JSON response scripts keyed by `match` (substring)
//   --transcript-file <path>    append interaction log
//
// ScenarioResponse contract (matches tests/integration/acp-test-agent.test.ts):
//   match?:      substring matched against prompt text (falls back to always-match)
//   matchRegex?: regex matched against prompt text (legacy)
//   output:      text streamed as agent_message_chunk
//   writes?:     [{ pathRegex, content }] — regex with capture group 1 = file path;
//                content supports {{prompt}} interpolation; written via fs/write_text_file
//   toolCalls?:  [{ toolCallId, title, status }] — emitted as tool_call updates
//   usage?:      { inputTokens, outputTokens, totalTokens, cachedInputTokens? }
import readline from "node:readline";
import { readFile, appendFile } from "node:fs/promises";

const args = process.argv.slice(2);
let scenarioPath = "";
let transcriptPath = "";
let directResponse: string | null = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--scenario-file" && args[i + 1]) scenarioPath = args[++i];
  else if (args[i] === "--transcript-file" && args[i + 1]) transcriptPath = args[++i];
  else if (args[i] === "--response" && args[i + 1]) directResponse = args[++i];
}

interface ScenarioWrite {
  // Template form (managed-worker scenarios): literal path with {{cwd}}/{{prompt}}.
  path?: string;
  // Capture form (acp-test-agent scenarios): regex matched against prompt text,
  // capture group 1 (or full match) is the target path.
  pathRegex?: string;
  content: string;
}

interface ScenarioToolCall {
  toolCallId: string;
  title: string;
  status?: string;
}

interface ScenarioUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
}

interface ScenarioResponse {
  name?: string;
  match?: string;
  matchRegex?: string;
  output: string;
  writes?: ScenarioWrite[];
  toolCalls?: ScenarioToolCall[];
  usage?: ScenarioUsage;
}

interface Scenario {
  responses: ScenarioResponse[];
  default?: { output: string };
}

let scenario: Scenario = { responses: [], default: { output: "" } };

if (scenarioPath) {
  try {
    scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
  } catch (err: any) {
    process.stderr.write(`test-acp-agent: failed to load scenario: ${err.message}\n`);
  }
}

async function appendTranscript(entry: any) {
  if (!transcriptPath) return;
  await appendFile(transcriptPath, JSON.stringify(entry) + "\n").catch(() => {});
}

function responseMatches(resp: ScenarioResponse, text: string): boolean {
  if (typeof resp.match === "string") return text.includes(resp.match);
  if (typeof resp.matchRegex === "string") {
    try {
      return new RegExp(resp.matchRegex, "is").test(text);
    } catch {
      return false;
    }
  }
  // No match key → always matches (matches test "ACP client audits codegraph..." which omits match).
  return true;
}

function selectResponse(text: string): ScenarioResponse | undefined {
  for (const resp of scenario.responses) {
    if (responseMatches(resp, text)) return resp;
  }
  return undefined;
}

const PROTOCOL_VERSION = 1;
let sessionId = "test-session";
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function write(message: any) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function result(id: number | string, value: any) {
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id: number | string, code: number, message: string) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function call(method: string, params: any): Promise<any> {
  const id = nextId++;
  write({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
}

function sendChunk(text: string) {
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

function sendToolCall(tc: ScenarioToolCall) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: tc.toolCallId,
        title: tc.title,
        status: tc.status || "completed",
      },
    },
  });
}

function sendUsage(usage: ScenarioUsage) {
  // Match the shape normalizeAcpUsage reads in server/services/acp/acp-client.ts:
  // it pulls inputTokens/outputTokens/totalTokens/cachedInputTokens from update.usage.
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "usage",
        usage,
      },
    },
  });
}

function interpolate(text: string, promptText: string): string {
  return text.split("{{prompt}}").join(promptText).split("{{cwd}}").join(process.cwd());
}

async function performWrites(writes: ScenarioWrite[] | undefined, promptText: string) {
  if (!writes || writes.length === 0) return;
  for (const w of writes) {
    let target: string | null = null;
    if (typeof w.path === "string" && w.path.length > 0) {
      // Template form: resolve {{cwd}}/{{prompt}} against the agent process state.
      target = interpolate(w.path, promptText);
    } else if (typeof w.pathRegex === "string" && w.pathRegex.length > 0) {
      // Capture form: first capture group (or full match) from the prompt text.
      const m = new RegExp(w.pathRegex, "is").exec(promptText);
      if (m) target = m[1] || m[0];
    }
    if (!target) continue;
    const content = interpolate(w.content, promptText);
    await call("fs/write_text_file", { path: target, content }).catch(() => null);
  }
}

function textFromPrompt(params: any): string {
  const prompt = Array.isArray(params?.prompt) ? params.prompt : [];
  return prompt.map((p: any) => p?.text || "").join("\n");
}

async function handlePrompt(params: any) {
  sessionId = params?.sessionId || sessionId;
  const text = textFromPrompt(params);

  // --response overrides everything: stream fixed text and return.
  if (directResponse !== null) {
    sendChunk(directResponse);
    await appendTranscript({ event: "session/prompt", text: text.substring(0, 200), matched: directResponse.substring(0, 200) });
    return;
  }

  const resp = selectResponse(text);
  const output = resp?.output ?? scenario.default?.output ?? "";

  sendChunk(output);

  if (resp?.toolCalls) {
    for (const tc of resp.toolCalls) sendToolCall(tc);
  }

  if (resp?.usage) {
    sendUsage(resp.usage);
  }

  await performWrites(resp?.writes, text);

  await appendTranscript({ event: "session/prompt", text: text.substring(0, 200), matched: output.substring(0, 200) });
}

async function handleRequest(message: any) {
  // session/prompt is logged inside handlePrompt; only log lifecycle methods here
  // to avoid double-counting in the transcript.
  if (message.method !== "session/prompt") {
    await appendTranscript({ event: message.method });
  }

  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { close: true } },
        agentInfo: { name: "test-acp-agent", title: "Test ACP Agent", version: "0.1.0" },
      });
      break;
    case "session/new":
      result(message.id, { sessionId });
      break;
    case "session/prompt":
      await handlePrompt(message.params);
      result(message.id, null);
      break;
    case "session/close":
      // Persistent ACP pools reuse one process across many sessions: closing a
      // session must NOT terminate the process. Only stdin EOF (client killed
      // the child) ends the agent. Re-initialize sessionId for the next session.
      // (Transcript is logged once at handleRequest entry — do not double-log.)
      result(message.id, null);
      sessionId = "test-session";
      break;
    default:
      if (Object.hasOwn(message, "id")) {
        error(message.id, -32601, `method not found: ${message.method}`);
      }
  }
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message: any;
  try { message = JSON.parse(line); } catch { return; }

  if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "ACP error"));
    else waiter.resolve(message.result);
    return;
  }

  if (message.method) {
    handleRequest(message).catch((err) => {
      if (Object.hasOwn(message, "id")) error(message.id, -32000, err.message);
    });
  }
});

// stdin closed → client terminated the child. Exit cleanly so the pool can
// detect process death and (if needed) spawn a fresh provider.
rl.on("close", () => process.exit(0));
