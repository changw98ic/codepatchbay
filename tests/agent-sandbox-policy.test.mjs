import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAgentSandboxLaunch } from "../core/policy/agent-sandbox.js";
import { buildChildEnv } from "../core/policy/child-env.js";
import { AcpClient } from "../runtime/acp-client-core.mjs";
import { AcpPool, resetManagedAcpPoolsForTests } from "../server/services/acp-pool.js";

const tempDirs = [];

async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

describe("agent sandbox launch policy", () => {
  afterEach(async () => {
    resetManagedAcpPoolsForTests();
    while (tempDirs.length) {
      await rm(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("leaves launches unchanged when sandboxing is off", () => {
    const launch = buildAgentSandboxLaunch("/bin/echo", ["ok"], {
      env: {},
      cwd: "/tmp",
      platform: "linux",
      probe: () => false,
    });

    assert.equal(launch.command, "/bin/echo");
    assert.deepEqual(launch.args, ["ok"]);
    assert.equal(launch.sandbox.enabled, false);
  });

  it("fails closed when sandboxing is required but unavailable", () => {
    assert.throws(
      () => buildAgentSandboxLaunch("/bin/echo", ["ok"], {
        env: { CPB_AGENT_SANDBOX: "required" },
        cwd: "/tmp",
        platform: "linux",
        probe: () => false,
      }),
      /CPB_AGENT_SANDBOX_REQUIRED/,
    );
  });

  it("wraps strict macOS launches with sandbox-exec and deny network/process profile", () => {
    const launch = buildAgentSandboxLaunch("/bin/echo", ["ok"], {
      env: { CPB_AGENT_SANDBOX: "strict", HOME: "/tmp/cpb-home" },
      cwd: "/tmp/project",
      platform: "darwin",
      probe: (command) => command === "sandbox-exec",
    });

    assert.equal(launch.command, "sandbox-exec");
    assert.equal(launch.args[0], "-p");
    assert.match(launch.args[1], /\(deny network\*\)/);
    assert.match(launch.args[1], /\(deny process-exec\*\)/);
    assert.match(launch.args[1], /\/tmp\/project/);
    assert.equal(launch.args[1].includes("/tmp/cpb-home"), false);
    assert.deepEqual(launch.args.slice(-2), ["/bin/echo", "ok"]);
  });

  it("allows non-system executable roots without allowing the whole home directory", () => {
    const launch = buildAgentSandboxLaunch("/Users/cpb/.local/bin/codex-acp", ["--help"], {
      env: { CPB_AGENT_SANDBOX: "required", HOME: "/Users/cpb" },
      cwd: "/tmp/project",
      platform: "darwin",
      probe: (command) => command === "sandbox-exec",
    });

    assert.equal(launch.command, "sandbox-exec");
    assert.match(launch.args[1], /\/Users\/cpb\/\.local\/bin/);
    assert.equal(launch.args[1].includes("(subpath \"/Users/cpb\")"), false);
    assert.deepEqual(launch.args.slice(-2), ["/Users/cpb/.local/bin/codex-acp", "--help"]);
  });

  it("wraps Linux launches with bwrap and optional network namespace denial", () => {
    const launch = buildAgentSandboxLaunch("/bin/echo", ["ok"], {
      env: { CPB_AGENT_SANDBOX: "required", CPB_AGENT_SANDBOX_NETWORK: "deny" },
      cwd: "/tmp/project",
      platform: "linux",
      probe: (command) => command === "bwrap",
    });

    assert.equal(launch.command, "bwrap");
    assert.ok(launch.args.includes("--unshare-net"));
    assert.ok(launch.args.includes("--ro-bind-try"));
    assert.equal(launch.args.includes("--ro-bind"), false);
    assert.equal(
      launch.args.findIndex((arg, idx) => arg === "--ro-bind-try" && launch.args[idx + 1] === "/tmp/project"),
      -1,
    );
    assert.notEqual(
      launch.args.findIndex((arg, idx) => arg === "--bind-try" && launch.args[idx + 1] === "/tmp/project"),
      -1,
    );
    assert.deepEqual(launch.args.slice(-2), ["/bin/echo", "ok"]);
  });

  it("binds non-system executable roots for Linux bwrap without binding the whole home directory", () => {
    const launch = buildAgentSandboxLaunch("/home/cpb/.local/bin/codex-acp", ["--help"], {
      env: { CPB_AGENT_SANDBOX: "required", HOME: "/home/cpb" },
      cwd: "/tmp/project",
      platform: "linux",
      probe: (command) => command === "bwrap",
    });

    assert.equal(launch.command, "bwrap");
    assert.notEqual(
      launch.args.findIndex((arg, idx) => arg === "--ro-bind-try" && launch.args[idx + 1] === "/home/cpb/.local/bin"),
      -1,
    );
    assert.equal(
      launch.args.findIndex((arg, idx) => arg === "--ro-bind-try" && launch.args[idx + 1] === "/home/cpb"),
      -1,
    );
    assert.deepEqual(launch.args.slice(-2), ["/home/cpb/.local/bin/codex-acp", "--help"]);
  });

  it("fails closed for strict Linux bwrap because subprocess denial is unsupported", () => {
    assert.throws(
      () => buildAgentSandboxLaunch("/bin/echo", ["ok"], {
        env: { CPB_AGENT_SANDBOX: "strict" },
        cwd: "/tmp/project",
        platform: "linux",
        probe: (command) => command === "bwrap",
      }),
      /subprocess denial/,
    );
  });

  it("wraps launches with a custom sandbox command", () => {
    const launch = buildAgentSandboxLaunch("/bin/echo", ["ok"], {
      env: {
        CPB_AGENT_SANDBOX: "required",
        CPB_AGENT_SANDBOX_COMMAND: "/tmp/cpb-sandbox",
        CPB_AGENT_SANDBOX_ARGS: JSON.stringify(["--profile", "strict"]),
      },
      cwd: "/tmp/project",
    });

    assert.equal(launch.command, "/tmp/cpb-sandbox");
    assert.deepEqual(launch.args, ["--profile", "strict", "/bin/echo", "ok"]);
  });

  it("preserves sandbox policy keys in the child env allowlist", () => {
    const env = buildChildEnv({
      CPB_AGENT_SANDBOX: "required",
      CPB_AGENT_SANDBOX_NETWORK: "deny",
      CPB_AGENT_SANDBOX_PROCESS: "deny",
      CPB_AGENT_SANDBOX_COMMAND: "/tmp/cpb-sandbox",
      CPB_AGENT_SANDBOX_ARGS: "[]",
      CPB_AGENT_SANDBOX_ALLOW_READ: "/tmp/project",
      CPB_AGENT_SANDBOX_ALLOW_WRITE: "/tmp/project",
      RANDOM_TOKEN: "leak",
    });

    assert.equal(env.CPB_AGENT_SANDBOX, "required");
    assert.equal(env.CPB_AGENT_SANDBOX_NETWORK, "deny");
    assert.equal(env.CPB_AGENT_SANDBOX_PROCESS, "deny");
    assert.equal(env.CPB_AGENT_SANDBOX_COMMAND, "/tmp/cpb-sandbox");
    assert.equal(env.CPB_AGENT_SANDBOX_ARGS, "[]");
    assert.equal(env.CPB_AGENT_SANDBOX_ALLOW_READ, "/tmp/project");
    assert.equal(env.CPB_AGENT_SANDBOX_ALLOW_WRITE, "/tmp/project");
    assert.equal(env.RANDOM_TOKEN, undefined);
  });

  it("launches ACP provider adapters through the sandbox wrapper", async () => {
    const root = await tempDir("cpb-agent-sandbox-client-");
    const wrapperPath = path.join(root, "sandbox-wrapper.sh");
    const agentPath = path.join(root, "fake-agent.mjs");

    await writeExecutable(wrapperPath, `#!/bin/sh
printf '%s\\n' "$@" > "$CPB_ROOT/sandbox-args.txt"
exec "$@"
`);
    await writeFile(agentPath, `
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
`, "utf8");

    const client = new AcpClient({
      agent: "codex",
      cwd: root,
      env: {
        CPB_ROOT: root,
        CPB_AGENT_SANDBOX: "required",
        CPB_AGENT_SANDBOX_COMMAND: wrapperPath,
        CPB_ACP_CODEX_COMMAND: process.execPath,
        CPB_ACP_CODEX_ARGS: JSON.stringify([agentPath]),
      },
      outputSink: () => {},
      errorSink: () => {},
    });

    try {
      await client.start();
    } finally {
      await client.close();
    }

    const argsText = await readFile(path.join(root, "sandbox-args.txt"), "utf8");
    assert.match(argsText, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(argsText, new RegExp(agentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("launches CPB-brokered terminals through the sandbox wrapper", async () => {
    const root = await tempDir("cpb-agent-sandbox-terminal-");
    const wrapperPath = path.join(root, "sandbox-wrapper.sh");
    await writeExecutable(wrapperPath, `#!/bin/sh
printf '%s\\n' "$@" > "$CPB_ROOT/terminal-sandbox-args.txt"
exec "$@"
`);

    const client = new AcpClient({
      agent: "codex",
      cwd: root,
      env: {
        CPB_ROOT: root,
        CPB_AGENT_SANDBOX: "required",
        CPB_AGENT_SANDBOX_COMMAND: wrapperPath,
      },
      outputSink: () => {},
      errorSink: () => {},
    });

    const { terminalId } = client.createTerminal({
      command: process.execPath,
      args: ["-e", "console.log('sandboxed-terminal')"],
      cwd: root,
    });
    const status = await client.waitForTerminalExit({ terminalId });

    assert.equal(status.exitCode, 0);
    const argsText = await readFile(path.join(root, "terminal-sandbox-args.txt"), "utf8");
    assert.match(argsText, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("launches one-shot ACP pool clients through the sandbox wrapper", async () => {
    const root = await tempDir("cpb-agent-sandbox-pool-");
    const wrapperPath = path.join(root, "sandbox-wrapper.sh");
    const clientPath = path.join(root, "client.sh");

    await writeExecutable(wrapperPath, `#!/bin/sh
printf '%s\\n' "$@" > "$CPB_ROOT/pool-sandbox-args.txt"
exec "$@"
`);
    await writeExecutable(clientPath, `#!/bin/sh
cat >/dev/null
printf ok
`);

    const saved = { ...process.env };
    let pool;
    try {
      process.env.CPB_ACP_CLIENT = clientPath;
      process.env.CPB_AGENT_SANDBOX = "required";
      process.env.CPB_AGENT_SANDBOX_COMMAND = wrapperPath;
      pool = new AcpPool({ cpbRoot: root, hubRoot: root, persistentProcesses: false });

      assert.equal(await pool.execute("codex", "prompt", root, 15000), "ok");
    } finally {
      if (pool) pool.stop();
      process.env = saved;
    }

    const argsText = await readFile(path.join(root, "pool-sandbox-args.txt"), "utf8");
    assert.match(argsText, new RegExp(clientPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
