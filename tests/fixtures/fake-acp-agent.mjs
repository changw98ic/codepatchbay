#!/usr/bin/env node
import readline from "node:readline";

const errorMode = process.env.FAKE_ACP_ERROR || null;
const delayMs = Number(process.env.FAKE_ACP_DELAY_MS || 0);

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sessionId = "fake-session";

rl.on("line", async (line) => {
  if (!line.trim()) return;

  const message = JSON.parse(line);
  if (message.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
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
    if (delayMs > 0) await sleep(delayMs);
    if (errorMode) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: errorMode },
      });
      return;
    }
    const prompt = message.params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const match = prompt.match(/Write the plan to: (.+)/);
    if (!match) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "missing output path" },
      });
      return;
    }

    write({
      jsonrpc: "2.0",
      method: "fs/write_text_file",
      id: 99,
      params: {
        sessionId,
        path: match[1].trim(),
        content: "# Plan\n\nWritten through ACP fs/write_text_file.\n",
      },
    });

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

  if (message.id === 99) {
    return;
  }

  write({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method: ${message.method}` },
  });
});

