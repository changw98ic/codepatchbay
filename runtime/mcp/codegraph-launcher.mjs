import { spawn } from "child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = resolve(__dirname, "codegraph-mcp-server.mjs");

const DEFAULT_PORT = 3100;

const PORT = parseInt(process.env.CPB_CODEGRAPH_PORT || String(DEFAULT_PORT), 10);
const CODEBASE_ROOT = process.env.CPB_CODEBASE_ROOT || process.cwd();

const STATE_FILE = resolve(
  process.env.CPB_ROOT || resolve(__dirname, "..", ".."),
  "cpb-task",
  "codegraph-state.json"
);

let proc = null;

export function serverScriptPath() {
  return MCP_SERVER;
}

export function buildStdioArgs({ codebaseRoot, cpbRoot } = {}) {
  const root = codebaseRoot || CODEBASE_ROOT;
  const args = [MCP_SERVER, "--codebase-root", root];
  if (cpbRoot) args.push("--cpb-root", cpbRoot);
  return { command: process.execPath, args };
}

export async function start() {
  if (proc) {
    console.error("[codegraph] already running in-process");
    return;
  }

  const cpbRoot = process.env.CPB_ROOT || resolve(__dirname, "..", "..");

  proc = spawn(process.execPath, [
    MCP_SERVER,
    "--codebase-root", CODEBASE_ROOT,
    "--cpb-root", cpbRoot,
    "--sse",
    "--port", String(PORT),
  ], {
    cwd: CODEBASE_ROOT,
    env: { ...process.env, CODEBASE_ROOT },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[codegraph] ${msg}`);
  });

  proc.on("exit", (code) => {
    console.error(`[codegraph] exited code=${code}`);
    proc = null;
  });

  const stateDir = dirname(STATE_FILE);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({
    pid: proc.pid,
    port: PORT,
    codebaseRoot: CODEBASE_ROOT,
    sseUrl: `http://localhost:${PORT}/sse`,
    serverScript: MCP_SERVER,
    startedAt: new Date().toISOString(),
  }));

  console.error(`[codegraph-launcher] SSE on http://localhost:${PORT}/sse (pid=${proc.pid})`);
}

export async function stop() {
  if (!proc && existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      if (state.pid) {
        try { process.kill(state.pid, "SIGTERM"); } catch {}
        console.error(`[codegraph] killed pid=${state.pid}`);
      }
    } catch {}
    try { unlinkSync(STATE_FILE); } catch {}
    return;
  }

  if (proc) {
    proc.kill("SIGTERM");
    proc = null;
  }
  if (existsSync(STATE_FILE)) {
    try { unlinkSync(STATE_FILE); } catch {}
  }
  console.error("[codegraph-launcher] stopped");
}

export function status() {
  let stateFile = null;
  if (existsSync(STATE_FILE)) {
    try { stateFile = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch {}
  }
  return {
    running: !!(proc || stateFile?.pid),
    port: PORT,
    codebaseRoot: CODEBASE_ROOT,
    sseUrl: `http://localhost:${PORT}/sse`,
    pid: proc?.pid || stateFile?.pid,
    serverScript: MCP_SERVER,
    stateFile: STATE_FILE,
  };
}

// CLI entry
const cmd = process.argv[2];
if (cmd === "start") {
  start().catch((e) => { console.error(e); process.exit(1); });
  process.on("SIGINT", () => stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => stop().then(() => process.exit(0)));
} else if (cmd === "stop") {
  stop().then(() => process.exit(0));
} else if (cmd === "status") {
  console.log(JSON.stringify(status(), null, 2));
}
