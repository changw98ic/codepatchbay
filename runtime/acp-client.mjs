#!/usr/bin/env node
import path from "node:path";

// Re-export core API for backward compatibility
export {
  AcpClient,
  parseToolPolicy,
  resolveWriteAllowPaths,
  resolveAgentCommand,
} from "./acp-client-core.mjs";

import { AcpClient, parseToolPolicy, resolveAgentCommand, resolveWriteAllowPaths } from "./acp-client-core.mjs";

const usage = `Usage: acp-client.mjs --agent <name> [--cwd <path>]

Reads a prompt from stdin and sends it to an ACP agent over stdio.

Supported agents: codex, claude (and any registered via CPB_AGENTS_CONFIG_DIR)

Environment:
  CPB_ACP_{PREFIX}_COMMAND   Override command for agent (e.g. CPB_ACP_CODEX_COMMAND)
  CPB_ACP_{PREFIX}_ARGS      Override args for agent
  CPB_ACP_TIMEOUT_MS         Idle timeout in milliseconds; activity resets it (default: 1800000)
  CPB_ACP_PERMISSION         allow or reject permission requests (default: allow)
  CPB_ACP_WRITE_ALLOW        Comma-separated glob patterns for allowed write paths (default: none = allow all)
  CPB_ACP_TERMINAL           allow or deny terminal creation (default: allow)
  CPB_ACP_TOOL_POLICY_FILE   Path to JSON file mapping tool names to "allow"|"deny"
  CPB_ACP_DENY_TOOLS         Comma-separated tool names to deny (e.g. "terminal/create,fs/delete")
  CPB_ACP_ALLOW_TOOLS        Comma-separated tool names to explicitly allow
  CPB_AGENT_SANDBOX          off|best-effort|required|strict for agent/terminal process sandboxing

Priority: TOOL_POLICY_FILE > DENY_TOOLS/ALLOW_TOOLS > CPB_ACP_TERMINAL
`;

async function parseCli(argv) {
  const result = { agent: "", cwd: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--agent") {
      result.agent = argv[++i] ?? "";
    } else if (arg === "--cwd") {
      result.cwd = argv[++i] ?? "";
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  // Validate agent name: allow legacy names + any registered agent
  if (result.agent !== "codex" && result.agent !== "claude") {
    try {
      const { loadRegistry, hasAgent } = await import("../core/agents/registry.js");
      await loadRegistry();
      if (!hasAgent(result.agent)) {
        throw new Error(`unknown agent: ${result.agent}`);
      }
    } catch (err) {
      if (err.message.startsWith("unknown agent:")) throw err;
      throw new Error("--agent must be a registered agent name (registry unavailable, fallback: codex or claude)");
    }
  }
  result.cwd = path.resolve(result.cwd || process.cwd());
  return result;
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export async function main() {
  const options = await parseCli(process.argv.slice(2));
  const prompt = await readStdin();

  const writeAllowPaths = resolveWriteAllowPaths(options.cwd, process.env);

  const terminalPolicy = process.env.CPB_ACP_TERMINAL === "deny" ? "deny" : "allow";
  const toolPolicy = await parseToolPolicy(process.env);

  const client = new AcpClient({ ...options, prompt, writeAllowPaths, terminalPolicy, toolPolicy });
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const code = signal === "SIGINT" ? 130 : 143;
    client.close().finally(() => process.exit(code));
  };
  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await client.run();
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

import { realpathSync as _realpathSync } from "node:fs";
import { fileURLToPath as _fileURLToPath } from "node:url";

function isDirectRun(metaUrl, argvPath) {
  if (!argvPath) return false;
  try {
    return _realpathSync(_fileURLToPath(metaUrl)) === _realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
