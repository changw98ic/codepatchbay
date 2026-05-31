import { execFileSync } from "node:child_process";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";

const DEFAULT_PORT = 3100;

function stateFilePath(cpbRoot) {
  return path.join(cpbRoot, "cpb-task", "codegraph-state.json");
}

function readState(cpbRoot) {
  const f = stateFilePath(cpbRoot);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function resolveServerScript(executorRoot) {
  return path.join(executorRoot, "runtime", "mcp", "codegraph-mcp-server.mjs");
}

export async function run(args, { cpbRoot, executorRoot }) {
  const sub = args[0] || "status";
  const port = parseInt(process.env.CPB_CODEGRAPH_PORT || String(DEFAULT_PORT), 10);
  const codebaseRoot = process.env.CPB_CODEBASE_ROOT || process.cwd();
  const serverScript = resolveServerScript(executorRoot);

  if (sub === "status") {
    const state = readState(cpbRoot);
    if (!state || !isAlive(state.pid)) {
      console.log("codegraph: stopped");
      if (state) { try { unlinkSync(stateFilePath(cpbRoot)); } catch {} }
      return;
    }
    console.log(`codegraph: running (pid=${state.pid}, port=${state.port})`);
    console.log(`  SSE: ${state.sseUrl}`);
    console.log(`  Server: ${state.serverScript || serverScript}`);
    console.log(`  Codebase: ${state.codebaseRoot}`);
  } else if (sub === "start") {
    const existing = readState(cpbRoot);
    if (existing && isAlive(existing.pid)) {
      console.log(`codegraph: already running (pid=${existing.pid})`);
      return;
    }

    const stateDir = path.dirname(stateFilePath(cpbRoot));
    mkdirSync(stateDir, { recursive: true });
    const logDir = path.join(stateDir, "codegraph-logs");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "codegraph.log");

    const { spawnSync } = await import("node:child_process");
    const detached = spawnSync(process.execPath, [
      serverScript,
      "--codebase-root", codebaseRoot,
      "--cpb-root", cpbRoot,
      "--sse",
      "--port", String(port),
    ], {
      cwd: codebaseRoot,
      env: { ...process.env, CODEBASE_ROOT: codebaseRoot },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // For detached process, use nohup via shell
    const cmd = `nohup ${process.execPath} ${serverScript} --codebase-root "${codebaseRoot}" --cpb-root "${cpbRoot}" --sse --port ${port} >> ${logFile} 2>&1 & echo $!`;
    const { execSync } = await import("node:child_process");
    const pid = parseInt(execSync(cmd, { cwd: codebaseRoot, env: { ...process.env, CODEBASE_ROOT: codebaseRoot }, shell: "/bin/bash" }).toString().trim(), 10);

    writeFileSync(stateFilePath(cpbRoot), JSON.stringify({
      pid,
      port,
      codebaseRoot,
      sseUrl: `http://localhost:${port}/sse`,
      serverScript,
      startedAt: new Date().toISOString(),
    }));

    console.log(`codegraph: started (pid=${pid}, port=${port})`);
    console.log(`  SSE: http://localhost:${port}/sse`);
    console.log(`  Server: ${serverScript}`);
  } else if (sub === "stop") {
    const state = readState(cpbRoot);
    if (!state) {
      console.log("codegraph: not running");
      return;
    }
    try { process.kill(state.pid, "SIGTERM"); } catch {}
    try { unlinkSync(stateFilePath(cpbRoot)); } catch {}
    console.log(`codegraph: stopped (pid=${state.pid})`);
  } else if (sub === "test") {
    // Quick smoke test of the MCP server in stdio mode
    const testRequest = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    try {
      const result = execFileSync(process.execPath, [serverScript, "--codebase-root", codebaseRoot], {
        input: testRequest + "\n",
        timeout: 15000,
        encoding: "utf8",
        env: { ...process.env, CODEBASE_ROOT: codebaseRoot },
      });
      const response = JSON.parse(result.trim());
      if (response.result?.serverInfo?.name === "codegraph") {
        console.log("codegraph: MCP server OK");
        console.log(`  Server: ${response.result.serverInfo.title} v${response.result.serverInfo.version}`);
        console.log(`  Codebase: ${codebaseRoot}`);
      } else {
        console.error("codegraph: unexpected response:", result.trim());
      }
    } catch (err) {
      console.error(`codegraph: test failed — ${err.message}`);
    }
  } else {
    console.log("Usage: cpb codegraph [status|start|stop|test]");
  }
}
