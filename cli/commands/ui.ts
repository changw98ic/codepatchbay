// @ts-nocheck
import path from "node:path";
import { existsSync } from "node:fs";
import { buildChildEnv, buildRuntimeEnv } from "../../core/policy/child-env.js";

const GREEN = "\x1b[0;32m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";

export function buildUiServerEnv(parentEnv = process.env, { cpbRoot, executorRoot, port, host } = {}) {
  return buildChildEnv(parentEnv, {
    CPB_PORT: port,
    CPB_HOST: host,
    CPB_ROOT: cpbRoot,
    CPB_EXECUTOR_ROOT: executorRoot || cpbRoot,
  });
}

export function buildUiDevServerEnv(parentEnv = process.env) {
  return buildRuntimeEnv(parentEnv);
}

export async function run(args, { cpbRoot, executorRoot }) {
  let port = process.env.CPB_PORT || "3456";
  let host = process.env.CPB_HOST || "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = args[i + 1] || port;
    if (args[i] === "--host") host = args[i + 1];
  }
  console.log(`${BOLD}Starting CodePatchbay UI...${NC}`);
  const { spawn } = await import("node:child_process");

  const serverRoot = executorRoot || cpbRoot;
  const sourceDistServer = path.join(serverRoot, "dist", "server", "index.js");
  const packagedServer = path.join(serverRoot, "server", "index.js");
  const serverEntry = existsSync(sourceDistServer) ? sourceDistServer : packagedServer;
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

  const hasWebSrc = existsSync(path.join(serverRoot, "web", "vite.config.js")) ||
    existsSync(path.join(serverRoot, "web", "vite.config.ts"));

  if (hasWebSrc) {
    const vite = spawn("npx", ["vite", "--port", "5173"], {
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
