#!/usr/bin/env node
// Sends partial response (initialize only) then exits mid-session.
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

let stepsComplete = 0;

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
        agentInfo: { name: "fake-acp-agent-partial-exit", version: "0.0.0" },
        authMethods: [],
      },
    });
    stepsComplete++;
    return;
  }

  if (message.method === "session/new") {
    write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "s1" } });
    stepsComplete++;
    return;
  }

  if (message.method === "session/prompt") {
    // Send a partial update then exit without sending the result response
    process.stdout.write(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"partial...`);

    // Exit without newline or closing the JSON — simulates crash mid-write
    process.exit(1);
  }
});
