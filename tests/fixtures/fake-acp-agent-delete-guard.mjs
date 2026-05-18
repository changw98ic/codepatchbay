#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

let sessionId = "fake-session";
let promptId = null;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-delete-guard-agent", version: "0.0.0" },
        authMethods: [],
      },
    });
    return;
  }

  if (message.method === "session/new") {
    write({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
    return;
  }

  if (message.method === "session/prompt") {
    promptId = message.id;
    const prompt = message.params.prompt
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const cmdMatch = prompt.match(/TRY_TERMINAL_COMMAND:\s*(.+)/);
    const argsMatch = prompt.match(/TRY_TERMINAL_ARGS:\s*(.*)/);

    if (cmdMatch) {
      const cmd = cmdMatch[1].trim();
      let args;
      const argsStr = argsMatch?.[1]?.trim();
      if (argsStr?.startsWith("[")) {
        args = JSON.parse(argsStr);
      } else {
        args = argsStr ? argsStr.split(/\s+/) : [];
      }

      write({
        jsonrpc: "2.0",
        method: "terminal/create",
        id: 99,
        params: { sessionId, command: cmd, args },
      });
    } else {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "no-command" },
          },
        },
      });
      write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    }
    return;
  }

  if (message.id === 99 && promptId !== null) {
    const result = message.error ? "blocked" : "not-blocked";
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result },
        },
      },
    });
    write({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
    promptId = null;
    return;
  }

  write({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method: ${message.method}` },
  });
});
