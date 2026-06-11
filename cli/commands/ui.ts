import path from "node:path";
import { existsSync } from "node:fs";
import net from "node:net";
import { buildChildEnv, buildRuntimeEnv } from "../../core/policy/child-env.js";

const GREEN = "\x1b[0;32m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";

type UiServerEnvOptions = {
  cpbRoot?: string;
  executorRoot?: string;
  port?: string;
  host?: string;
};

type UiCommandOptions = {
  help: boolean;
  port: string;
  host: string;
};

export function uiUsage() {
  return [
    "Usage: cpb ui [--port <port>] [--host <host>]",
    "",
    "Start the CodePatchbay Web UI.",
    "",
    "Options:",
    "  --port <port>   Backend port, default CPB_PORT or 3456.",
    "  --host <host>   Backend host, default CPB_HOST or 127.0.0.1.",
    "  -h, --help      Show this help.",
  ].join("\n");
}

function normalizePort(value: string | undefined, source: string) {
  const raw = value || "3456";
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid ${source}: ${raw}`);
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid ${source}: ${raw}`);
  }
  return String(port);
}

function normalizeHost(value: string, source: string) {
  const host = value.trim();
  if (!host || host.includes("://") || /[\s/]/.test(host)) {
    throw new Error(`invalid ${source}: ${value}`);
  }
  return host;
}

function requireValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

export function parseUiArgs(args: string[] = [], env: Record<string, string | undefined> = process.env): UiCommandOptions {
  let help = false;
  let port: string | undefined;
  let host = env.CPB_HOST || "127.0.0.1";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--port") {
      port = normalizePort(requireValue(args, i, "--port"), "--port");
      i++;
    } else if (arg.startsWith("--port=")) {
      port = normalizePort(arg.slice("--port=".length), "--port");
    } else if (arg === "--host") {
      host = normalizeHost(requireValue(args, i, "--host"), "--host");
      i++;
    } else if (arg.startsWith("--host=")) {
      host = normalizeHost(arg.slice("--host=".length), "--host");
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!help) {
    host = normalizeHost(host, "CPB_HOST");
  }

  if (!port) {
    try {
      port = normalizePort(env.CPB_PORT, "CPB_PORT");
    } catch (error) {
      if (!help) throw error;
      port = "3456";
    }
  }

  return { help, port, host };
}

export function isUiPortAvailable(host: string, port: string | number) {
  const numericPort = typeof port === "number" ? port : Number.parseInt(port, 10);
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close((err) => resolve(!err));
    });
    probe.listen(numericPort, host);
  });
}

export function isLoopbackHost(host: string) {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function assertSafeUiBind(host: string, env: Record<string, string | undefined> = process.env) {
  if (isLoopbackHost(host)) return;
  if (env.CPB_API_KEYS?.trim()) return;
  throw new Error(`--host ${host} requires CPB_API_KEYS; use --host 127.0.0.1 for local unauthenticated UI`);
}

export function buildUiServerEnv(parentEnv = process.env, { cpbRoot, executorRoot, port, host }: UiServerEnvOptions = {}) {
  return buildChildEnv(parentEnv, {
    CPB_PORT: port,
    CPB_HOST: host,
    CPB_ROOT: cpbRoot,
    CPB_EXECUTOR_ROOT: executorRoot || cpbRoot,
  }, { allowKeys: ["CPB_API_KEYS"] });
}

export function buildUiDevServerEnv(parentEnv = process.env) {
  return buildRuntimeEnv(parentEnv);
}

export async function run(args: string[], { cpbRoot, executorRoot }: { cpbRoot: string; executorRoot?: string }) {
  const { help, port, host } = parseUiArgs(args);
  if (help) {
    console.log(uiUsage());
    return 0;
  }
  assertSafeUiBind(host);

  if (!(await isUiPortAvailable(host, port))) {
    console.error(`Cannot start CodePatchbay UI: ${host}:${port} is not available.`);
    console.error("Stop the existing server or choose another port, for example: cpb ui --port 4567");
    return 1;
  }

  const serverRoot = executorRoot || cpbRoot;
  const sourceDistServer = path.join(serverRoot, "dist", "server", "index.js");
  const packagedServer = path.join(serverRoot, "server", "index.js");
  const serverEntry = existsSync(sourceDistServer) ? sourceDistServer : packagedServer;
  const hasWebSrc = existsSync(path.join(serverRoot, "web", "vite.config.js")) ||
    existsSync(path.join(serverRoot, "web", "vite.config.ts"));

  if (hasWebSrc && !(await isUiPortAvailable("127.0.0.1", 5173))) {
    console.error("Cannot start CodePatchbay UI: frontend port 5173 is not available.");
    console.error("Stop the existing Vite server before running cpb ui.");
    return 1;
  }

  console.log(`${BOLD}Starting CodePatchbay UI...${NC}`);
  const { spawn } = await import("node:child_process");

  const server = spawn("node", [serverEntry], {
    env: buildUiServerEnv(process.env, { cpbRoot, executorRoot, port, host }),
    stdio: "inherit",
  });

  server.on("error", (err) => {
    console.error(`Failed to start server: ${err.message}`);
    process.exitCode = 1;
  });
  server.on("exit", (code) => {
    if (code && code !== 0 && !process.exitCode) process.exitCode = code;
  });

  if (hasWebSrc) {
    const vite = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
      cwd: path.join(serverRoot, "web"),
      env: buildUiDevServerEnv(process.env),
      stdio: "inherit",
    });
    vite.on("error", (err) => {
      console.error(`Failed to start vite: ${err.message}`);
      process.exitCode = 1;
    });
    vite.on("exit", (code) => {
      if (code && code !== 0 && !process.exitCode) process.exitCode = code;
    });
    console.log(`${GREEN}Backend:${NC}  http://localhost:${port}`);
    console.log(`${GREEN}Frontend:${NC} http://localhost:5173 (dev mode)`);
    console.log(`${YELLOW}Press Ctrl+C to stop${NC}`);
    process.on("SIGINT", () => {
      server.kill();
      vite.kill();
      process.exitCode = 130;
    });
    await Promise.all([new Promise((r) => server.on("close", r)), new Promise((r) => vite.on("close", r))]);
  } else {
    console.log(`${GREEN}Server:${NC} http://localhost:${port} (serving pre-built UI)`);
    console.log(`${YELLOW}Press Ctrl+C to stop${NC}`);
    process.on("SIGINT", () => {
      server.kill();
      process.exitCode = 130;
    });
    await new Promise((r) => server.on("close", r));
  }
}
