#!/usr/bin/env node
/**
 * Fake ACP agent that exercises tool policy enforcement.
 * It tries to call fs/write_text_file and terminal/create,
 * then sends "done" regardless of whether the calls were denied.
 */
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

let sessionId = "fake-session";
let requestCount = 0;

rl.on("line", (line) => {
  if (!line.trim()) return;

  const message = JSON.parse(line);

  // Silently ack responses to our server-initiated requests (id >= 90)
  if (Object.hasOwn(message, "id") && message.id >= 90 && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
    return;
  }

  if (message.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-acp-agent-tool-policy", version: "0.0.0" },
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

    // Parse requested actions from prompt
    const actions = prompt.match(/ACTION: (.+)/g) || [];

    for (const actionLine of actions) {
      const action = actionLine.replace("ACTION: ", "").trim();

      if (action === "write_file") {
        const pathMatch = prompt.match(/Write the plan to: (.+)/);
        const filePath = pathMatch ? pathMatch[1].trim() : "/tmp/test.txt";
        requestCount += 1;
        write({
          jsonrpc: "2.0",
          method: "fs/write_text_file",
          id: 90 + requestCount,
          params: {
            sessionId,
            path: filePath,
            content: "# Written by tool-policy agent\n",
          },
        });
      }

      if (action === "terminal") {
        requestCount += 1;
        write({
          jsonrpc: "2.0",
          method: "terminal/create",
          id: 90 + requestCount,
          params: {
            sessionId,
            command: process.execPath,
            args: ["-e", "process.stdout.write('hello')"],
          },
        });
      }

      if (action === "read_file") {
        requestCount += 1;
        write({
          jsonrpc: "2.0",
          method: "fs/read_text_file",
          id: 90 + requestCount,
          params: {
            sessionId,
            path: "/etc/hostname",
          },
        });
      }
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

  write({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method: ${message.method}` },
  });
});
