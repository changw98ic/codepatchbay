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
        agentInfo: { name: "fake-acp-agent-terminal", version: "0.0.0" },
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

    // Extract command from prompt: "Run command: <cmd>"
    const cmdMatch = prompt.match(/Run command: (.+)/);

    if (cmdMatch) {
      // Issue terminal/create request
      write({
        jsonrpc: "2.0",
        method: "terminal/create",
        id: 99,
        params: {
          sessionId,
          command: process.execPath,
          args: ["-e", "process.stdout.write('hello from terminal')"],
        },
      });
    }

    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "done",
          },
        },
      },
    });

    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    return;
  }

  // Silently ack responses to our id=99 requests
  if (message.id === 99) {
    return;
  }

  write({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method: ${message.method}` },
  });
});
