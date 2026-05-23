import path from "node:path";
import { existsSync } from "node:fs";

const GREEN = "\x1b[0;32m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";

export async function run(args, { cpbRoot }) {
  let port = process.env.CPB_PORT || "3456";
  let host = process.env.CPB_HOST || "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = args[i + 1] || port;
    if (args[i] === "--host") host = args[i + 1];
  }
  console.log(`${BOLD}Starting CodePatchbay UI...${NC}`);
  const { spawn } = await import("node:child_process");
  const server = spawn("node", [path.join(cpbRoot, "server/index.js")], {
    env: { ...process.env, CPB_PORT: port, CPB_HOST: host },
    stdio: "inherit",
  });

  const hasWebSrc = existsSync(path.join(cpbRoot, "web", "vite.config.js")) ||
    existsSync(path.join(cpbRoot, "web", "vite.config.ts"));

  if (hasWebSrc) {
    const vite = spawn("npx", ["vite", "--port", "5173"], {
      cwd: path.join(cpbRoot, "web"),
      stdio: "inherit",
    });
    console.log(`${GREEN}Backend:${NC}  http://localhost:${port}`);
    console.log(`${GREEN}Frontend:${NC} http://localhost:5173 (dev mode)`);
    console.log(`${YELLOW}Press Ctrl+C to stop${NC}`);
    process.on("SIGINT", () => {
      server.kill();
      vite.kill();
      process.exit(0);
    });
    await Promise.all([new Promise((r) => server.on("close", r)), new Promise((r) => vite.on("close", r))]);
  } else {
    console.log(`${GREEN}Server:${NC} http://localhost:${port} (serving pre-built UI)`);
    console.log(`${YELLOW}Press Ctrl+C to stop${NC}`);
    process.on("SIGINT", () => {
      server.kill();
      process.exit(0);
    });
    await new Promise((r) => server.on("close", r));
  }
}
