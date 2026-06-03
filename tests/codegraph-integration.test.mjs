import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function withTempRoot(prefix, fn) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function importFresh(modulePath) {
  return import(`${modulePath}?test=${Date.now()}-${Math.random()}`);
}

describe("codegraph integration", () => {
  it("runtime launcher defaults to the current CodeGraph MCP command", async () => {
    await withTempRoot("cpb-codegraph-runtime-", async (root) => {
      const cpbRoot = path.join(root, "cpb");
      const codebaseRoot = path.join(root, "source dir");
      await mkdir(codebaseRoot, { recursive: true });

      const previousRoot = process.env.CPB_ROOT;
      const previousCodebase = process.env.CPB_CODEBASE_ROOT;
      const previousStdio = process.env.CPB_CODEGRAPH_MCP_STDIO;
      try {
        process.env.CPB_ROOT = cpbRoot;
        process.env.CPB_CODEBASE_ROOT = codebaseRoot;
        delete process.env.CPB_CODEGRAPH_MCP_STDIO;

        const launcher = await importFresh("../runtime/mcp/codegraph-launcher.mjs");
        const status = launcher.status();

        assert.equal(
          status.mcpStdio,
          `codegraph serve --mcp --path '${codebaseRoot}'`,
        );
        assert.equal(status.codebaseRoot, codebaseRoot);
      } finally {
        if (previousRoot === undefined) delete process.env.CPB_ROOT;
        else process.env.CPB_ROOT = previousRoot;
        if (previousCodebase === undefined) delete process.env.CPB_CODEBASE_ROOT;
        else process.env.CPB_CODEBASE_ROOT = previousCodebase;
        if (previousStdio === undefined) delete process.env.CPB_CODEGRAPH_MCP_STDIO;
        else process.env.CPB_CODEGRAPH_MCP_STDIO = previousStdio;
      }
    });
  });

  it("runtime launcher treats stale state pid as stopped", async () => {
    await withTempRoot("cpb-codegraph-stale-", async (root) => {
      const cpbRoot = path.join(root, "cpb");
      const codebaseRoot = path.join(root, "source");
      const stateDir = path.join(cpbRoot, "cpb-task");
      await mkdir(codebaseRoot, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "codegraph-state.json"),
        JSON.stringify({
          pid: 999999999,
          port: 3100,
          codebaseRoot,
          sseUrl: "http://localhost:3100/sse",
        }),
        "utf8",
      );

      const previousRoot = process.env.CPB_ROOT;
      const previousCodebase = process.env.CPB_CODEBASE_ROOT;
      const previousStdio = process.env.CPB_CODEGRAPH_MCP_STDIO;
      try {
        process.env.CPB_ROOT = cpbRoot;
        process.env.CPB_CODEBASE_ROOT = codebaseRoot;
        delete process.env.CPB_CODEGRAPH_MCP_STDIO;

        const launcher = await importFresh("../runtime/mcp/codegraph-launcher.mjs");
        const status = launcher.status();

        assert.equal(status.running, false);
        assert.equal(status.pid, undefined);
      } finally {
        if (previousRoot === undefined) delete process.env.CPB_ROOT;
        else process.env.CPB_ROOT = previousRoot;
        if (previousCodebase === undefined) delete process.env.CPB_CODEBASE_ROOT;
        else process.env.CPB_CODEBASE_ROOT = previousCodebase;
        if (previousStdio === undefined) delete process.env.CPB_CODEGRAPH_MCP_STDIO;
        else process.env.CPB_CODEGRAPH_MCP_STDIO = previousStdio;
      }
    });
  });

  it("CLI status falls back to the current CodeGraph MCP command for old state files", async () => {
    await withTempRoot("cpb-codegraph-cli-", async (root) => {
      const cpbRoot = path.join(root, "cpb");
      const codebaseRoot = path.join(root, "source dir");
      const stateDir = path.join(cpbRoot, "cpb-task");
      await mkdir(codebaseRoot, { recursive: true });
      await mkdir(stateDir, { recursive: true });
      await writeFile(
        path.join(stateDir, "codegraph-state.json"),
        JSON.stringify({
          pid: process.pid,
          port: 3100,
          codebaseRoot,
          sseUrl: "http://localhost:3100/sse",
        }),
        "utf8",
      );

      const previousCodebase = process.env.CPB_CODEBASE_ROOT;
      const previousStdio = process.env.CPB_CODEGRAPH_MCP_STDIO;
      const logs = [];
      const originalLog = console.log;
      try {
        process.env.CPB_CODEBASE_ROOT = codebaseRoot;
        delete process.env.CPB_CODEGRAPH_MCP_STDIO;
        console.log = (...args) => logs.push(args.join(" "));

        const command = await importFresh("../cli/commands/codegraph.js");
        await command.run(["status"], { cpbRoot });

        assert.match(logs.join("\n"), /codegraph: running/);
        assert.match(
          logs.join("\n"),
          new RegExp(`MCP stdio: codegraph serve --mcp --path '${codebaseRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`),
        );
      } finally {
        console.log = originalLog;
        if (previousCodebase === undefined) delete process.env.CPB_CODEBASE_ROOT;
        else process.env.CPB_CODEBASE_ROOT = previousCodebase;
        if (previousStdio === undefined) delete process.env.CPB_CODEGRAPH_MCP_STDIO;
        else process.env.CPB_CODEGRAPH_MCP_STDIO = previousStdio;
      }
    });
  });
});
