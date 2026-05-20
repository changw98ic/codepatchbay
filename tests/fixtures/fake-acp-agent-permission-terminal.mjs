#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

let sessionId = "fake-session";
let pendingPromptId = null;

function finishPrompt(text) {
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
  write({
    jsonrpc: "2.0",
    id: pendingPromptId,
    result: { stopReason: "end_turn" },
  });
  pendingPromptId = null;
}

rl.on("line", (line) => {
  if (!line.trim()) return;

  const message = JSON.parse(line);

  if (message.id === 99 && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
    finishPrompt(message.error ? "terminal-denied" : "terminal-allowed");
    return;
  }

  if (message.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-acp-agent-permission-terminal", version: "0.0.0" },
        authMethods: [],
      },
    });
    return;
  }

  if (message.method === "session/new") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId },
    });
    return;
  }

  if (message.method === "session/prompt") {
    const prompt = message.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    pendingPromptId = message.id;

    const unsafe = prompt.includes("ACTION: unsafe_terminal");
    const testCommand = prompt.includes("ACTION: test_terminal");
    write({
      jsonrpc: "2.0",
      method: "terminal/create",
      id: 99,
      params: testCommand
        ? {
            sessionId,
            command: "npm",
            args: ["test"],
          }
        : unsafe
        ? {
            sessionId,
            command: process.execPath,
            args: ["-e", "require('fs').writeFileSync('x','y')"],
          }
        : {
            sessionId,
            command: "git",
            args: ["status", "--short"],
          },
    });
    return;
  }

  write({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method: ${message.method}` },
  });
});
