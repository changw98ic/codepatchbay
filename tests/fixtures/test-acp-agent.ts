#!/usr/bin/env node
// test-acp-agent.ts — Scriptable ACP agent for integration testing
// Supports --scenario-file (JSON response scripts) and --transcript-file (interaction log)
import readline from "node:readline";
import { readFile, appendFile } from "node:fs/promises";

const args = process.argv.slice(2);
let scenarioPath = "";
let transcriptPath = "";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--scenario-file" && args[i + 1]) scenarioPath = args[++i];
  if (args[i] === "--transcript-file" && args[i + 1]) transcriptPath = args[++i];
}

interface ScenarioResponse {
  name: string;
  matchRegex: string;
  output: string;
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

function matchResponse(text: string): string {
  for (const resp of scenario.responses) {
    if (new RegExp(resp.matchRegex, "is").test(text)) return resp.output;
  }
  return scenario.default?.output || "";
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

function textFromPrompt(params: any): string {
  const prompt = Array.isArray(params?.prompt) ? params.prompt : [];
  return prompt.map((p: any) => p?.text || "").join("\n");
}

async function handlePrompt(params: any) {
  sessionId = params?.sessionId || sessionId;
  const text = textFromPrompt(params);
  const output = matchResponse(text);

  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: output },
      },
    },
  });

  await appendTranscript({ type: "prompt", text: text.substring(0, 200), matched: output.substring(0, 200) });
}

async function handleRequest(message: any) {
  await appendTranscript({ type: "request", method: message.method });

  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { sessionCapabilities: { close: true } },
        agentInfo: { name: "test-acp-agent", title: "Test ACP Agent", version: "0.1.0" },
      });
      break;
    case "session/new":
      sessionId = `test-session-${Date.now()}`;
      result(message.id, { sessionId });
      break;
    case "session/prompt":
      await handlePrompt(message.params);
      result(message.id, null);
      break;
    case "session/close":
      result(message.id, null);
      await appendTranscript({ type: "close" });
      process.exit(0);
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
