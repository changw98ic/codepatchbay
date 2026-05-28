import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AcpClient,
  parseToolPolicy,
  resolveAgentCommand,
  resolveWriteAllowPaths,
} from "../runtime/acp-client-core.mjs";

function restoreEnv(snapshot) {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(snapshot)) {
    process.env[key] = value;
  }
}

async function withTempCpbRoot(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "cpb-acp-policy-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function codexConfigArgs(args, key) {
  const prefix = `${key}=`;
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-c" && String(args[i + 1]).startsWith(prefix)) {
      return args[i + 1].slice(prefix.length);
    }
  }
  return null;
}

describe("ACP client policy env snapshot", () => {
  it("parses tool policy from the provided env instead of live process.env", async () => {
    const saved = { ...process.env };
    try {
      process.env.CPB_ACP_DENY_TOOLS = "fs/delete";
      process.env.CPB_ACP_ALLOW_TOOLS = "";

      const policy = await parseToolPolicy({
        CPB_ACP_DENY_TOOLS: "terminal/create",
      });

      assert.equal(policy.get("terminal/create"), "deny");
      assert.equal(policy.get("fs/delete"), undefined);
    } finally {
      restoreEnv(saved);
    }
  });

  it("resolves write allow paths from the provided env", () => {
    const saved = { ...process.env };
    try {
      delete process.env.CPB_ACP_WRITE_ALLOW;
      const cwd = path.join(path.sep, "tmp", "project");

      const paths = resolveWriteAllowPaths(cwd, {
        CPB_ACP_WRITE_ALLOW: "src/*,/tmp/shared/file.txt",
      });

      assert.deepEqual(paths, [
        path.resolve(cwd, "src/*"),
        path.resolve("/tmp/shared/file.txt"),
      ]);
    } finally {
      restoreEnv(saved);
    }
  });

  it("answers permission requests from the client env snapshot", () => {
    const saved = { ...process.env };
    try {
      process.env.CPB_ACP_PERMISSION = "allow";
      const client = new AcpClient({
        agent: "codex",
        cwd: "/tmp/project",
        env: { CPB_ACP_PERMISSION: "reject" },
      });

      const response = client.permissionResponse({
        options: [
          { optionId: "allow-1", kind: "allow_once" },
          { optionId: "reject-1", kind: "reject_once" },
        ],
      });

      assert.equal(response.outcome.optionId, "reject-1");
    } finally {
      restoreEnv(saved);
    }
  });

  it("resolves agent commands without registry env override leakage", async () => {
    const saved = { ...process.env };
    try {
      process.env.CPB_ACP_CODEX_COMMAND = "/tmp/bad-global-codex";
      process.env.CPB_ACP_CODEX_ARGS = "--bad-global-arg";

      const resolved = await resolveAgentCommand("codex", {
        PATH: process.env.PATH || "",
      });

      assert.notEqual(resolved.command, "/tmp/bad-global-codex");
      assert.deepEqual(resolved.args.includes("--bad-global-arg"), false);
    } finally {
      restoreEnv(saved);
    }
  });

  it("injects built-in CodeRAG as Codex config instead of ACP session mcpServers", async () => {
    await withTempCpbRoot(async (root) => {
      const resolved = await resolveAgentCommand("codex", {
        PATH: process.env.PATH || "",
        CPB_ROOT: root,
        CPB_ACP_CODEX_COMMAND: "codex-acp",
      });

      assert.equal(codexConfigArgs(resolved.args, "mcp_servers.coderag.command"), '"npx"');
      const coderagArgs = codexConfigArgs(resolved.args, "mcp_servers.coderag.args");
      assert.ok(coderagArgs);
      assert.match(coderagArgs, /"supergateway"/);
      assert.match(coderagArgs, /"--sse"/);
      assert.match(coderagArgs, /"http:\/\/localhost:3100\/sse"/);
    });
  });

  it("uses the CodeRAG launcher state URL for Codex MCP config", async () => {
    await withTempCpbRoot(async (root) => {
      await mkdir(path.join(root, "cpb-task"), { recursive: true });
      await writeFile(
        path.join(root, "cpb-task", "coderag-state.json"),
        JSON.stringify({ sseUrl: "http://127.0.0.1:4321/sse" }),
      );

      const resolved = await resolveAgentCommand("codex", {
        PATH: process.env.PATH || "",
        CPB_ROOT: root,
        CPB_ACP_CODEX_COMMAND: "codex-acp",
      });

      const coderagArgs = codexConfigArgs(resolved.args, "mcp_servers.coderag.args");
      assert.ok(coderagArgs);
      assert.match(coderagArgs, /"http:\/\/127.0.0.1:4321\/sse"/);
    });
  });

  it("honors CPB_CODERAG_ENABLED=0 for Codex MCP config injection", async () => {
    await withTempCpbRoot(async (root) => {
      const resolved = await resolveAgentCommand("codex", {
        PATH: process.env.PATH || "",
        CPB_ROOT: root,
        CPB_CODERAG_ENABLED: "0",
        CPB_ACP_CODEX_COMMAND: "codex-acp",
      });

      assert.equal(codexConfigArgs(resolved.args, "mcp_servers.coderag.command"), null);
      assert.equal(codexConfigArgs(resolved.args, "mcp_servers.coderag.args"), null);
    });
  });

  it("keeps Codex ACP session/new mcpServers empty while CodeRAG is enabled", async () => {
    await withTempCpbRoot(async (root) => {
      const agentPath = path.join(root, "fake-codex-agent.mjs");
      const paramsPath = path.join(root, "session-new.json");
      await writeFile(agentPath, `
import { writeFile } from "node:fs/promises";

process.stdin.setEncoding("utf8");
let buffer = "";
function send(id, result) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send(msg.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } } });
    } else if (msg.method === "session/new") {
      await writeFile(${JSON.stringify(paramsPath)}, JSON.stringify(msg.params));
      send(msg.id, { sessionId: "session-1" });
    } else if (msg.method === "session/prompt" || msg.method === "session/close") {
      send(msg.id, {});
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`);

      const client = new AcpClient({
        agent: "codex",
        cwd: root,
        env: {
          PATH: process.env.PATH,
          CPB_ROOT: root,
          CPB_ACP_CPB_ROOT: root,
          CPB_ACP_CODEX_COMMAND: process.execPath,
          CPB_ACP_CODEX_ARGS: JSON.stringify([agentPath]),
          CPB_AGENT_ISOLATE_HOME: "0",
        },
        outputSink: () => {},
        errorSink: () => {},
      });

      try {
        await client.promptOnce("hello", root);
      } finally {
        await client.close();
      }

      const params = JSON.parse(await readFile(paramsPath, "utf8"));
      assert.deepEqual(params.mcpServers, []);
    });
  });

  it("retries session/new without mcpServers when a provider rejects MCP params", async () => {
    await withTempCpbRoot(async (root) => {
      const agentPath = path.join(root, "fake-claude-agent.mjs");
      const paramsPath = path.join(root, "session-new-attempts.json");
      await writeFile(agentPath, `
import { writeFile } from "node:fs/promises";

process.stdin.setEncoding("utf8");
let buffer = "";
const attempts = [];
function send(id, result) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
function sendError(id, message) {
  console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message } }));
}
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      send(msg.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: true } } });
    } else if (msg.method === "session/new") {
      attempts.push(msg.params);
      await writeFile(${JSON.stringify(paramsPath)}, JSON.stringify(attempts));
      if (attempts.length === 1 && msg.params.mcpServers?.length > 0) {
        sendError(msg.id, "Invalid params");
      } else {
        send(msg.id, { sessionId: "session-1" });
      }
    } else if (msg.method === "session/prompt" || msg.method === "session/close") {
      send(msg.id, {});
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`);

      const client = new AcpClient({
        agent: "claude",
        cwd: root,
        env: {
          PATH: process.env.PATH,
          CPB_ROOT: root,
          CPB_ACP_CPB_ROOT: root,
          CPB_ACP_CLAUDE_COMMAND: process.execPath,
          CPB_ACP_CLAUDE_ARGS: JSON.stringify([agentPath]),
          CPB_AGENT_ISOLATE_HOME: "0",
        },
        outputSink: () => {},
        errorSink: () => {},
      });

      try {
        await client.promptOnce("hello", root);
      } finally {
        await client.close();
      }

      const attempts = JSON.parse(await readFile(paramsPath, "utf8"));
      assert.equal(attempts.length, 2);
      assert.ok(attempts[0].mcpServers.length > 0);
      assert.deepEqual(attempts[1].mcpServers, []);
    });
  });
});
