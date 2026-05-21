#!/usr/bin/env node
/**
 * Fake ACP agent for testing UI tool denial and escalation.
 *
 * On session/prompt it fires a sequence of client-initiated tool calls:
 *   1. computer-use/click          — direct UI tool (should be denied)
 *   2. browser/navigate            — browser tool (should be denied)
 *   3. desktop_automation/screenshot — desktop automation (should be denied)
 *   4. tools/call (computer-use)   — MCP-shaped UI call (should be denied)
 *   5. fs/write_text_file          — non-UI tool (should succeed)
 *
 * When the non-UI fs/write call receives a successful response it writes a
 * marker file so tests can verify the side-effect happened.
 *
 * Env vars:
 *   CPB_UI_TOOL_MARKER  — path written on successful non-UI call (default /tmp/cpb-ui-tool-marker.txt)
 */
import readline from "node:readline";
import { writeFileSync } from "node:fs";

const MARKER = process.env.CPB_UI_TOOL_MARKER || "/tmp/cpb-ui-tool-marker.txt";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const write = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

let sessionId = "fake-session-ui-tools";
let promptId = null;
let callIndex = 0;

// Client-initiated request ids start at 90
const BASE_ID = 90;

// Sequence of client-initiated tool calls
const toolCalls = [
  { method: "computer-use/click", params: { x: 100, y: 200 } },
  { method: "browser/navigate", params: { url: "http://example.com" } },
  { method: "desktop_automation/screenshot", params: {} },
  {
    method: "tools/call",
    params: { serverName: "computer-use", toolName: "click" },
  },
  {
    method: "fs/write_text_file",
    params: {
      path: "/tmp/cpb-ui-test-sideeffect.txt",
      content: "should-not-exist",
    },
  },
];

function sendToolCalls() {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    write({
      jsonrpc: "2.0",
      method: tc.method,
      id: BASE_ID + i,
      params: { sessionId, ...tc.params },
    });
  }
}

function finish() {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "AGENT_DONE" },
      },
    },
  });
  write({
    jsonrpc: "2.0",
    id: promptId,
    result: { stopReason: "end_turn" },
  });
  promptId = null;
}

rl.on("line", (line) => {
  if (!line.trim()) return;

  const message = JSON.parse(line);

  // Silently ack responses to our client-initiated requests (id >= BASE_ID)
  if (
    Object.hasOwn(message, "id") &&
    message.id >= BASE_ID &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
  ) {
    callIndex++;
    // If the fs/write_text_file call (last in sequence, id = BASE_ID+4) got
    // a successful result, write the marker file so tests can verify it.
    if (message.id === BASE_ID + 4 && Object.hasOwn(message, "result")) {
      writeFileSync(MARKER, "non-ui-tool-succeeded");
    }
    // Once all responses are collected, finish the prompt
    if (callIndex >= toolCalls.length) {
      finish();
    }
    return;
  }

  if (message.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-acp-agent-ui-tools", version: "0.0.0" },
        authMethods: [],
      },
    });
    return;
  }

  if (message.method === "session/new") {
    // Assert mcpServers is empty (headless mode should pass [])
    const mcpServers = message.params?.mcpServers;
    if (mcpServers !== undefined && !Array.isArray(mcpServers)) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32602,
          message: `mcpServers must be an array, got ${typeof mcpServers}`,
        },
      });
      return;
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId },
    });
    return;
  }

  if (message.method === "session/prompt") {
    promptId = message.id;
    callIndex = 0;
    sendToolCalls();
    return;
  }

  write({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method: ${message.method}` },
  });
});
