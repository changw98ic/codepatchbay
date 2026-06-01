import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync } from "node:fs";
import { spawn } from "node:child_process";

const DEFAULT_PORT = 3100;
const STOP_TIMEOUT_MS = 5000;

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

function resolveMcpStdioCommand() {
  return process.env.CPB_CODEGRAPH_MCP_STDIO || "codegraph mcp";
}

function waitForExit(pid, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      try {
        process.kill(pid, 0);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(check, 100);
      } catch {
        resolve(true);
      }
    };
    check();
  });
}

export async function run(args, { cpbRoot, executorRoot }) {
  const sub = args[0] || "status";
  const port = parseInt(process.env.CPB_CODEGRAPH_PORT || String(DEFAULT_PORT), 10);
  const codebaseRoot = process.env.CPB_CODEBASE_ROOT || process.cwd();

  if (sub === "status") {
    const state = readState(cpbRoot);
    if (!state || !isAlive(state.pid)) {
      console.log("codegraph: stopped");
      if (state) { try { unlinkSync(stateFilePath(cpbRoot)); } catch {} }
      return;
    }
    console.log(`codegraph: running (pid=${state.pid}, port=${state.port})`);
    console.log(`  SSE: ${state.sseUrl}`);
    console.log(`  MCP stdio: ${state.mcpStdio || resolveMcpStdioCommand()}`);
    console.log(`  Codebase: ${state.codebaseRoot}`);
  } else if (sub === "start") {
    const existing = readState(cpbRoot);
    if (existing && isAlive(existing.pid)) {
      console.log(`codegraph: already running (pid=${existing.pid})`);
      return;
    }

    const mcpStdio = resolveMcpStdioCommand();

    const stateDir = path.dirname(stateFilePath(cpbRoot));
    mkdirSync(stateDir, { recursive: true });
    const logDir = path.join(stateDir, "codegraph-logs");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "codegraph.log");
    const logFd = openSync(logFile, "a");

    const child = spawn("npx", [
      "-y", "supergateway",
      "--stdio", mcpStdio,
      "--port", String(port),
      "--ssePath", "/sse",
      "--messagePath", "/message",
    ], {
      cwd: codebaseRoot,
      env: { ...process.env, CODEBASE_ROOT: codebaseRoot },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();

    writeFileSync(stateFilePath(cpbRoot), JSON.stringify({
      pid: child.pid,
      port,
      codebaseRoot,
      sseUrl: `http://localhost:${port}/sse`,
      mcpStdio,
      startedAt: new Date().toISOString(),
    }));

    console.log(`codegraph: started (pid=${child.pid}, port=${port})`);
    console.log(`  SSE: http://localhost:${port}/sse`);
    console.log(`  MCP stdio: ${mcpStdio}`);
  } else if (sub === "stop") {
    const state = readState(cpbRoot);
    if (!state) {
      console.log("codegraph: not running");
      return;
    }
    if (isAlive(state.pid)) {
      try { process.kill(state.pid, "SIGTERM"); } catch {}
      const exited = await waitForExit(state.pid, STOP_TIMEOUT_MS);
      if (!exited) {
        try { process.kill(state.pid, 9); } catch {}
        console.log(`codegraph: force-stopped (pid=${state.pid})`);
      } else {
        console.log(`codegraph: stopped (pid=${state.pid})`);
      }
    } else {
      console.log(`codegraph: process already dead (pid=${state.pid})`);
    }
    try { unlinkSync(stateFilePath(cpbRoot)); } catch {}
  } else {
    console.log("Usage: cpb codegraph [status|start|stop]");
  }
}
