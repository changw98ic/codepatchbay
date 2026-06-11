import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

// Known ACP-compatible agent binary names from the ACP Registry
// https://agentclientprotocol.com/get-started/agents
const KNOWN_AGENTS = [
  { name: "codex", command: "codex-acp", displayName: "Codex CLI", envPrefix: "CPB_ACP_CODEX", protocol: "acp" },
  { name: "claude", command: "claude-agent-acp", displayName: "Claude Code", envPrefix: "CPB_ACP_CLAUDE", protocol: "acp" },
  { name: "reasonix", command: "reasonix", displayName: "Reasonix", envPrefix: "CPB_ACP_REASONIX", protocol: "acp", args: ["acp"] },
  { name: "opencode", command: "opencode", displayName: "OpenCode", envPrefix: "CPB_ACP_OPENCODE", protocol: "cli" },
  { name: "augment", command: "auggie", displayName: "Augment Code", envPrefix: "CPB_ACP_AUGMENT", protocol: "unknown" },
  { name: "copilot", command: "copilot", displayName: "GitHub Copilot", envPrefix: "CPB_ACP_COPILOT", protocol: "unknown" },
  { name: "openclaw", command: "openclaw", displayName: "OpenClaw", envPrefix: "CPB_ACP_OPENCLAW", protocol: "unknown" },
  { name: "hermes", command: "hermes", displayName: "Hermes Agent", envPrefix: "CPB_ACP_HERMES", protocol: "unknown" },
  { name: "kimi", command: "kimi", displayName: "Kimi CLI", envPrefix: "CPB_ACP_KIMI", protocol: "unknown" },
  { name: "kiro", command: "kiro-cli", displayName: "Kiro CLI", envPrefix: "CPB_ACP_KIRO", protocol: "unknown" },
  { name: "cursor", command: "cursor-agent", displayName: "Cursor Agent", envPrefix: "CPB_ACP_CURSOR", protocol: "cli" },
  { name: "qwen", command: "qwen-code", displayName: "Qwen Code", envPrefix: "CPB_ACP_QWEN", protocol: "unknown" },
  { name: "goose", command: "goose", displayName: "Goose", envPrefix: "CPB_ACP_GOOSE", protocol: "unknown" },
  { name: "cline", command: "cline", displayName: "Cline", envPrefix: "CPB_ACP_CLINE", protocol: "unknown" },
  { name: "pi", command: "pi", displayName: "Pi", envPrefix: "CPB_ACP_PI", protocol: "unknown" },
];

/**
 * Find the full path of a binary by scanning PATH directories.
 * Returns the full path if found, null otherwise.
 */
async function whichBinary(name) {
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  const ext = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];

  for (const dir of pathDirs) {
    for (const e of ext) {
      const fullPath = path.join(dir, name + e);
      try {
        await access(fullPath, constants.X_OK);
        return fullPath;
      } catch {
        // Not found in this directory
      }
    }
  }
  return null;
}

/**
 * Auto-discover ACP agents installed on the system by scanning PATH.
 * Returns an array of agent descriptors with source: "auto-discovered".
 * These are meant to supplement (not replace) manually registered descriptors.
 */
export async function autoDiscoverAgents() {
  const discovered = [];

  const checks = KNOWN_AGENTS.map(async (ka) => {
    const fullPath = await whichBinary(ka.command);
    if (fullPath) {
      discovered.push({
        name: ka.name,
        displayName: ka.displayName,
        command: fullPath,
        args: ka.args || [],
        capabilities: [],
        defaultRoles: [],
        stability: "discovered",
        envPrefix: ka.envPrefix,
        protocol: ka.protocol || "unknown",
        source: "auto-discovered",
      });
    }
  });

  await Promise.all(checks);
  return discovered;
}
