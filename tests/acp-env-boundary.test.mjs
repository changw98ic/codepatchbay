import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AcpClient } from "../runtime/acp-client-core.mjs";
import { AcpPool, resetManagedAcpPoolsForTests } from "../server/services/acp-pool.js";

const tempDirs = [];
let pool = null;

async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

describe("ACP environment boundary", () => {
  afterEach(async () => {
    if (pool) {
      pool.stop();
      pool = null;
    }
    resetManagedAcpPoolsForTests();
    while (tempDirs.length) {
      await rm(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("scrubs arbitrary parent env before launching one-shot ACP clients", async () => {
    const root = await tempDir("cpb-acp-env-pool-");
    const clientPath = path.join(root, "client.sh");
    await writeExecutable(clientPath, `#!/bin/sh
env | sort > "$CPB_ROOT/env.txt"
cat >/dev/null
printf ok
`);

    const saved = { ...process.env };
    try {
      process.env.CPB_ACP_CLIENT = clientPath;
      process.env.OPENAI_API_KEY = "provider-secret";
      process.env.DATABASE_URL = "postgres://secret";
      process.env.RANDOM_TOKEN = "leak";
      process.env.CPB_GITHUB_WEBHOOK_SECRET = "webhook-secret";

      pool = new AcpPool({ cpbRoot: root, hubRoot: root, persistentProcesses: false });
      assert.equal(await pool.execute("codex", "prompt", root, 5000), "ok");

      const envText = await readFile(path.join(root, "env.txt"), "utf8");
      assert.match(envText, new RegExp(`^CPB_ROOT=${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
      assert.match(envText, /^OPENAI_API_KEY=provider-secret$/m);
      assert.doesNotMatch(envText, /DATABASE_URL=/);
      assert.doesNotMatch(envText, /RANDOM_TOKEN=/);
      assert.doesNotMatch(envText, /CPB_GITHUB_WEBHOOK_SECRET=/);
    } finally {
      process.env = saved;
    }
  });

  it("scrubs arbitrary env before launching persistent ACP adapter processes", async () => {
    const root = await tempDir("cpb-acp-env-adapter-");
    const agentPath = path.join(root, "fake-agent.mjs");
    await writeFile(agentPath, `
import { writeFile } from "node:fs/promises";
await writeFile(process.env.CPB_ROOT + "/adapter-env.json", JSON.stringify(process.env));
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

    const client = new AcpClient({
      agent: "codex",
      cwd: root,
      env: {
        PATH: process.env.PATH,
        CPB_ROOT: root,
        CPB_ACP_CPB_ROOT: root,
        CPB_ACP_CODEX_COMMAND: process.execPath,
        CPB_ACP_CODEX_ARGS: JSON.stringify([agentPath]),
        OPENAI_API_KEY: "provider-secret",
        DATABASE_URL: "postgres://secret",
        RANDOM_TOKEN: "leak",
        CPB_GITHUB_WEBHOOK_SECRET: "webhook-secret",
      },
      outputSink: () => {},
      errorSink: () => {},
    });

    await client.start();
    await client.close();

    const env = await readJson(path.join(root, "adapter-env.json"));
    assert.equal(env.CPB_ROOT, root);
    assert.equal(env.OPENAI_API_KEY, "provider-secret");
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.RANDOM_TOKEN, undefined);
    assert.equal(env.CPB_GITHUB_WEBHOOK_SECRET, undefined);
  });

  it("scrubs arbitrary env from CPB-brokered terminal commands", async () => {
    const root = await tempDir("cpb-acp-env-terminal-");
    const commandPath = path.join(root, "dump-terminal-env.mjs");
    await writeFile(commandPath, `
import { writeFile } from "node:fs/promises";
await writeFile(process.env.CPB_ROOT + "/terminal-env.json", JSON.stringify(process.env));
`);

    const client = new AcpClient({
      agent: "codex",
      cwd: root,
      env: {
        PATH: process.env.PATH,
        CPB_ROOT: root,
        OPENAI_API_KEY: "provider-secret",
        DATABASE_URL: "postgres://secret",
        RANDOM_TOKEN: "leak",
      },
      outputSink: () => {},
      errorSink: () => {},
    });

    const { terminalId } = client.createTerminal({
      command: process.execPath,
      args: [commandPath],
      cwd: root,
      env: [
        { name: "AWS_REGION", value: "us-east-1" },
        { name: "REQUEST_TOKEN", value: "request-leak" },
      ],
    });
    await client.waitForTerminalExit({ terminalId });

    const env = await readJson(path.join(root, "terminal-env.json"));
    assert.equal(env.CPB_ROOT, root);
    assert.equal(env.OPENAI_API_KEY, "provider-secret");
    assert.equal(env.AWS_REGION, "us-east-1");
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.RANDOM_TOKEN, undefined);
    assert.equal(env.REQUEST_TOKEN, undefined);
  });
});
