#!/usr/bin/env node
// Sends a valid response with the wrong id (stale id not in pending map),
// then sends the correct response.
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

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
        agentInfo: { name: "fake-acp-agent-wrong-method", version: "0.0.0" },
        authMethods: [],
      },
    });
    return;
  }

  if (message.method === "session/new") {
    write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1" } });
    return;
  }

  if (message.method === "session/prompt") {
    // Send a response with an id that was never requested (9999)
    write({ jsonrpc: "2.0", id: 9999, result: { unexpected: true } });

    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      },
    });
    write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    return;
  }
});
