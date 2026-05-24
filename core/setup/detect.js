import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { listSetupAgents } from "./agent-catalog.js";

const execFileAsync = promisify(execFile);

async function defaultRunCommand(command, args = []) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || "",
      error,
    };
  }
}

function firstLine(text) {
  return String(text || "").trim().split(/\r?\n/)[0] || null;
}

function normalizeProbe(result) {
  return {
    installed: Boolean(result?.ok),
    version: result?.ok ? firstLine(result.stdout || result.stderr) : null,
    error: result?.ok ? null : (result?.error?.code || result?.error?.message || "unavailable"),
  };
}

async function probeTool(name, args, runCommand) {
  return normalizeProbe(await runCommand(name, args));
}

async function probeAgent(agent, runCommand) {
  return {
    ...normalizeProbe(await runCommand(agent.binary, ["--version"])),
    id: agent.id,
    displayName: agent.displayName,
    binary: agent.binary,
    recommended: agent.recommended,
    tier: agent.tier,
    roles: agent.roles,
    capabilities: agent.capabilities,
    installMethods: Object.keys(agent.install || {}),
  };
}

export async function detectSetupEnvironment({
  runCommand = defaultRunCommand,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const [node, git, npm, brew] = await Promise.all([
    probeTool("node", ["--version"], runCommand),
    probeTool("git", ["--version"], runCommand),
    probeTool("npm", ["--version"], runCommand),
    probeTool("brew", ["--version"], runCommand),
  ]);

  const agentEntries = await Promise.all(listSetupAgents().map(async (agent) => {
    return [agent.id, await probeAgent(agent, runCommand)];
  }));
  const agents = {};
  for (const [id, agent] of agentEntries) {
    agents[id] = agent;
  }

  return {
    generatedAt: new Date().toISOString(),
    system: {
      platform,
      arch,
      release: os.release(),
      shell: process.env.SHELL || process.env.ComSpec || null,
    },
    tools: { node, git, npm, brew },
    agents,
  };
}
