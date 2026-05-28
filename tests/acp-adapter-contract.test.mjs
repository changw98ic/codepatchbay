import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AcpClient } from "../runtime/acp-client-core.mjs";

const tempDirs = [];
let activeClient = null;

async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

function buildFakeAgentScript(options = {}) {
  const {
    initializeDelay = 0,
    requestDelay = 0,
    errorOnInitialize = false,
    errorOnRequest = false,
    closeSession = true,
  } = options;

  return `
import { writeFile } from "node:fs/promises";
const state = {
  initialized: false,
  requestCount: 0,
  closeCount: 0,
};
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      setTimeout(() => {
        if (${errorOnInitialize}) {
          console.log(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: "Initialize error" }
          }));
        } else {
          state.initialized = true;
          console.log(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: ${closeSession} } } }
          }));
        }
      }, ${initializeDelay});
    } else if (msg.method === "request") {
      state.requestCount += 1;
      setTimeout(() => {
        if (${errorOnRequest}) {
          console.log(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32001, message: "Request processing error" }
          }));
        } else {
          console.log(JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: "Response " + state.requestCount }] }
          }));
        }
      }, ${requestDelay});
    } else if (msg.method === "session/close") {
      state.closeCount += 1;
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { closed: true }
      }));
    }
  }
});
process.stdin.on("end", () => {
  writeFile(process.env.CPB_ROOT + "/agent-state.json", JSON.stringify(state)).then(() => process.exit(0));
});
`;
}

async function createAgentClient(agentPath, root, options = {}) {
  const agent = options.agent || "codex";
  const env = {
    PATH: process.env.PATH,
    CPB_ROOT: root,
    CPB_ACP_CPB_ROOT: root,
    [`CPB_ACP_${agent.toUpperCase()}_COMMAND`]: process.execPath,
    [`CPB_ACP_${agent.toUpperCase()}_ARGS`]: JSON.stringify([agentPath]),
  };
  const client = new AcpClient({
    agent,
    cwd: root,
    env,
    outputSink: () => {},
    errorSink: () => {},
  });
  activeClient = client;
  return client;
}

describe("ACP adapter contract", () => {
  afterEach(async () => {
    if (activeClient) {
      try {
        await activeClient.close();
      } catch {}
      activeClient = null;
    }
    while (tempDirs.length) {
      await rm(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  describe("initialize handshake", () => {
    it("completes initialize handshake successfully", async () => {
      const root = await tempDir("cpb-acp-init-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, buildFakeAgentScript({ closeSession: true }));

      const client = await createAgentClient(agentPath, root);
      await client.start();
      await client.close();

      const state = JSON.parse(await readFile(path.join(root, "agent-state.json"), "utf8"));
      assert.equal(state.initialized, true);
    });

    it("returns protocol version and capabilities in initialize response", async () => {
      const root = await tempDir("cpb-acp-capabilities-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, buildFakeAgentScript({ closeSession: true }));

      const client = await createAgentClient(agentPath, root);
      await client.start();
      await client.close();

      const state = JSON.parse(await readFile(path.join(root, "agent-state.json"), "utf8"));
      assert.equal(state.initialized, true);
    });

    it("propagates initialize errors to client", async () => {
      const root = await tempDir("cpb-acp-init-error-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, buildFakeAgentScript({ errorOnInitialize: true, closeSession: true }));

      const client = await createAgentClient(agentPath, root);

      await assert.rejects(
        client.start(),
        /Initialize error/
      );
    });
  });

  describe("request/response", () => {
    it("sends request and receives response", async () => {
      const root = await tempDir("cpb-acp-request-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, buildFakeAgentScript({ closeSession: true }));

      const client = await createAgentClient(agentPath, root);
      await client.start();

      const response = await client.request("request", { messages: [{ role: "user", content: "test" }] });
      assert.ok(response);
      assert.equal(response.content[0].type, "text");
      assert.equal(response.content[0].text, "Response 1");

      await client.close();

      const state = JSON.parse(await readFile(path.join(root, "agent-state.json"), "utf8"));
      assert.equal(state.requestCount, 1);
    });

    it("handles multiple sequential requests", async () => {
      const root = await tempDir("cpb-acp-multi-request-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, buildFakeAgentScript({ closeSession: true }));

      const client = await createAgentClient(agentPath, root);
      await client.start();

      const response1 = await client.request("request", { messages: [{ role: "user", content: "test1" }] });
      assert.equal(response1.content[0].text, "Response 1");

      const response2 = await client.request("request", { messages: [{ role: "user", content: "test2" }] });
      assert.equal(response2.content[0].text, "Response 2");

      await client.close();

      const state = JSON.parse(await readFile(path.join(root, "agent-state.json"), "utf8"));
      assert.equal(state.requestCount, 2);
    });

    it("propagates request errors to client", async () => {
      const root = await tempDir("cpb-acp-request-error-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, buildFakeAgentScript({ errorOnRequest: true, closeSession: true }));

      const client = await createAgentClient(agentPath, root);
      await client.start();

      await assert.rejects(
        client.request("request", { messages: [{ role: "user", content: "test" }] }),
        /Request processing error/
      );

      await client.close();
    });
  });

  describe("error handling", () => {
    it("handles malformed JSON-RPC responses gracefully", async () => {
      const root = await tempDir("cpb-acp-malformed-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, `
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  console.log("not valid json\\n");
  process.exit(0);
});
`);

      const client = await createAgentClient(agentPath, root);

      await assert.rejects(
        client.start(),
        /exited before completing|exited/i
      );
    });

    it("handles process crashes during request", async () => {
      const root = await tempDir("cpb-acp-crash-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, `
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } } }
      }));
    } else if (msg.method === "request") {
      process.exit(1);
    }
  }
});
`);

      const client = await createAgentClient(agentPath, root);
      await client.start();

      await assert.rejects(
        client.request("request", { messages: [{ role: "user", content: "test" }] }),
        /exit/i
      );
    });
  });

  describe("session close", () => {
    it("closes session via session/close method", async () => {
      const root = await tempDir("cpb-acp-close-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, buildFakeAgentScript({ closeSession: true }));

      const client = await createAgentClient(agentPath, root);
      await client.start();
      await client.request("session/close", {}).catch(() => {});
      await client.close();

      const state = JSON.parse(await readFile(path.join(root, "agent-state.json"), "utf8"));
      assert.equal(state.closeCount, 1);
    });

    it("handles agents without close capability gracefully", async () => {
      const root = await tempDir("cpb-acp-no-close-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, buildFakeAgentScript({ closeSession: false }));

      const client = await createAgentClient(agentPath, root);
      await client.start();

      await client.close();

      const state = JSON.parse(await readFile(path.join(root, "agent-state.json"), "utf8"));
      assert.equal(state.closeCount, 0);
    });

    it("handles session/close errors gracefully", async () => {
      const root = await tempDir("cpb-acp-close-error-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, `
import { writeFile } from "node:fs/promises";
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } } }
      }));
    } else if (msg.method === "session/close") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32002, message: "Close failed" }
      }));
    }
  }
});
process.stdin.on("end", () => {
  writeFile(process.env.CPB_ROOT + "/agent-state.json", JSON.stringify({ closeCount: 0 })).then(() => process.exit(0));
});
`);

      const client = await createAgentClient(agentPath, root);
      await client.start();

      await client.close();
    });
  });

  describe("environment isolation", () => {
    it("scopes environment to requested agent", async () => {
      const root = await tempDir("cpb-acp-env-scope-");
      const agentPath = path.join(root, "fake-agent.mjs");
      await writeFile(agentPath, `
import { writeFile } from "node:fs/promises";
writeFile(process.env.CPB_ROOT + "/agent-env.json", JSON.stringify({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  RANDOM_TOKEN: process.env.RANDOM_TOKEN,
}));
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.includes("\\n")) {
    const msg = JSON.parse(buffer);
    if (msg.method === "initialize") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } } }
      }));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`);

      const env = {
        PATH: process.env.PATH,
        CPB_ROOT: root,
        OPENAI_API_KEY: "openai-secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
        RANDOM_TOKEN: "leak",
      };

      const client = new AcpClient({
        agent: "codex",
        cwd: root,
        env: {
          ...env,
          CPB_ACP_CPB_ROOT: root,
          CPB_ACP_CODEX_COMMAND: process.execPath,
          CPB_ACP_CODEX_ARGS: JSON.stringify([agentPath]),
        },
        outputSink: () => {},
        errorSink: () => {},
      });

      await client.start();
      await client.close();

      const agentEnv = JSON.parse(await readFile(path.join(root, "agent-env.json"), "utf8"));
      assert.equal(agentEnv.OPENAI_API_KEY, "openai-secret");
      assert.equal(agentEnv.ANTHROPIC_API_KEY, undefined);
      assert.equal(agentEnv.RANDOM_TOKEN, undefined);
    });
  });
});
