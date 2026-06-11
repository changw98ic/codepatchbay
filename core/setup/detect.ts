import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { listSetupAgents } from "./agent-catalog.js";

const SCHEMA_VERSION = 1;
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

function errorKind(error) {
  if (!error) return "unavailable";
  if (error.code === "ENOENT") return "missing";
  if (error.code === "ETIMEDOUT" || error.timedOut || error.killed) return "timeout";
  return "error";
}

function normalizeError(error) {
  if (!error) return { kind: "unavailable", code: null, message: "unavailable", signal: null };
  return {
    kind: errorKind(error),
    code: error.code || null,
    message: error.message || String(error),
    signal: error.signal || null,
  };
}

export function normalizeCommandProbe(result) {
  if (result?.ok) {
    return {
      installed: true,
      status: "installed",
      version: firstLine(result.stdout || result.stderr),
      error: null,
    };
  }

  const error = normalizeError(result?.error);
  return {
    installed: false,
    status: error.kind,
    version: null,
    error,
  };
}

function normalizeProbe(result) {
  return normalizeCommandProbe(result);
}

async function probeTool(name, args, runCommand) {
  return normalizeProbe(await runCommand(name, args));
}

async function probeAgent(agent, runCommand) {
  const result = {
    ...normalizeProbe(await runCommand(agent.binary, ["--version"])),
    id: agent.id,
    displayName: agent.displayName,
    binary: agent.binary,
    recommended: agent.recommended,
    tier: agent.tier,
    roles: agent.roles,
    capabilities: agent.capabilities,
    installMethods: Object.keys(agent.install || {}),
    adapter: agent.adapter || null,
    adapterInstalled: null,
    adapterCommand: null,
  };

  // Probe adapter availability when adapter command differs from agent binary
  if (agent.adapter?.command && agent.adapter.command !== agent.binary) {
    const adapterArgs = agent.adapter.args?.length ? agent.adapter.args : ["--help"];
    const adapterProbe = normalizeProbe(await runCommand(agent.adapter.command, adapterArgs));
    result.adapterInstalled = adapterProbe.installed;
    result.adapterCommand = agent.adapter.command;
  } else if (agent.adapter?.command && agent.adapter.command === agent.binary) {
    // Adapter is the same binary (e.g. Reasonix) — already probed above
    result.adapterInstalled = result.installed;
    result.adapterCommand = agent.adapter.command;
  }

  return result;
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
    schemaVersion: SCHEMA_VERSION,
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
