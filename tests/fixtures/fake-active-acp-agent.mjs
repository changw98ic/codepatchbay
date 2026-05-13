#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const sessionId = "fake-active-session";
const tickIntervalMs = Number.parseInt(process.env.FLOW_TEST_ACTIVE_TICK_MS || "70", 10);
const tickCount = Number.parseInt(process.env.FLOW_TEST_ACTIVE_TICKS || "4", 10);
const finalDelayMs = Number.parseInt(process.env.FLOW_TEST_ACTIVE_FINAL_DELAY_MS || "30", 10);

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
        agentInfo: { name: "fake-active-acp-agent", version: "0.0.0" },
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
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `tick-${ticks}\n`,
            },
          },
        },
      });

      if (ticks === tickCount) {
        clearInterval(interval);
        setTimeout(() => {
          write({
            jsonrpc: "2.0",
            id: message.id,
            result: { stopReason: "end_turn" },
          });
        }, finalDelayMs);
      }
    }, tickIntervalMs);
    return;
  }

  write({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method: ${message.method}` },
  });
});
