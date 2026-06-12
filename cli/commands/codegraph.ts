import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, createWriteStream } from "node:fs";
import { resolveHubRoot } from "../../server/services/hub/hub-registry.js";

function stateFilePath(cpbRoot) {
  return path.join(resolveHubRoot(cpbRoot), "codegraph-state.json");
}

function readState(cpbRoot) {
  const f = stateFilePath(cpbRoot);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function shellQuoteArg(value) {
  const str = String(value);
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

function resolveMcpStdioCommand(codebaseRoot = process.env.CPB_CODEBASE_ROOT || process.cwd()) {
  return process.env.CPB_CODEGRAPH_MCP_STDIO || `codegraph serve --mcp --path ${shellQuoteArg(codebaseRoot)}`;
}

export async function run(args, { cpbRoot, executorRoot }) {
  const sub = args[0] || "status";
  const codebaseRoot = process.env.CPB_CODEBASE_ROOT || process.cwd();

  if (sub === "status") {
    const state = readState(cpbRoot);
    if (!state || !isAlive(state.pid)) {
      console.log("codegraph: stopped");
      if (state) { try { unlinkSync(stateFilePath(cpbRoot)); } catch {} }
      return;
    }
    console.log(`codegraph: running (pid=${state.pid})`);
    console.log(`  MCP stdio: ${state.mcpStdio || resolveMcpStdioCommand(codebaseRoot)}`);
    console.log(`  Codebase: ${state.codebaseRoot}`);
  } else if (sub === "start") {
    const existing = readState(cpbRoot);
    if (existing && isAlive(existing.pid)) {
      console.log(`codegraph: already running (pid=${existing.pid})`);
      return;
    }

    const mcpStdio = resolveMcpStdioCommand(codebaseRoot);

    const stateDir = path.dirname(stateFilePath(cpbRoot));
    mkdirSync(stateDir, { recursive: true });
    const logDir = path.join(stateDir, "codegraph-logs");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "codegraph.log");

    const parts = mcpStdio.split(/\s+/);
    const { spawn } = await import("node:child_process");
    const child = spawn(parts[0], parts.slice(1), {
      cwd: codebaseRoot,
      env: { ...process.env, CODEBASE_ROOT: codebaseRoot },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout?.pipe(createWriteStream(logFile, { flags: "a" }));
    child.stderr?.pipe(createWriteStream(logFile, { flags: "a" }));
    child.unref();

    writeFileSync(stateFilePath(cpbRoot), JSON.stringify({
      pid: child.pid,
      codebaseRoot,
      mcpStdio,
      startedAt: new Date().toISOString(),
    }));

    console.log(`codegraph: started (pid=${child.pid})`);
    console.log(`  MCP stdio: ${mcpStdio}`);
  } else if (sub === "stop") {
    const state = readState(cpbRoot);
    if (!state) {
      console.log("codegraph: not running");
      return;
    }
    try { process.kill(state.pid, "SIGTERM"); } catch {}
    try { unlinkSync(stateFilePath(cpbRoot)); } catch {}
    console.log(`codegraph: stopped (pid=${state.pid})`);
  } else {
    console.log("Usage: cpb codegraph [status|start|stop]");
  }
}
