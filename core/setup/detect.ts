import { recordValue, type LooseRecord } from "../../shared/types.js";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { listSetupAgents } from "./agent-catalog.js";

const SCHEMA_VERSION = 1;
const execFileAsync = promisify(execFile);

async function defaultRunCommand(command: string, args: string[] = []) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    const err = recordValue(error);
    return {
      ok: false,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      error,
    };
  }
}

function firstLine(text: string) {
  return String(text || "").trim().split(/\r?\n/)[0] || null;
}

function errorKind(error: LooseRecord | null | undefined) {
  if (!error) return "unavailable";
  if (error.code === "ENOENT") return "missing";
  if (error.code === "ETIMEDOUT" || error.timedOut || error.killed) return "timeout";
  return "error";
}

function normalizeError(error: LooseRecord | null | undefined) {
  if (!error) return { kind: "unavailable", code: null, message: "unavailable", signal: null };
  return {
    kind: errorKind(error),
    code: error.code || null,
    message: error.message || String(error),
    signal: error.signal || null,
  };
}

type CommandProbeRecord = LooseRecord & {
  installed: boolean;
  status: string;
  version: string | null;
  error: LooseRecord | null;
};

export function normalizeCommandProbe(result: LooseRecord | null | undefined): CommandProbeRecord {
  if (result?.ok) {
    return {
      installed: true,
      status: "installed",
      version: firstLine(String(result.stdout || result.stderr || "")),
      error: null,
    };
  }

  const rawError = result?.error;
  const error = normalizeError(rawError === undefined || rawError === null ? null : recordValue(rawError));
  return {
    installed: false,
    status: error.kind,
    version: null,
    error: error,
  };
}

function normalizeProbe(result: LooseRecord | null | undefined) {
  return normalizeCommandProbe(result);
}

async function probeTool(name: string, args: string[], runCommand: (command: string, args: string[]) => Promise<LooseRecord>) {
  return normalizeProbe(await runCommand(name, args));
}

async function probeAgent(agent: LooseRecord, runCommand: (command: string, args: string[]) => Promise<LooseRecord>) {
  const adapter = recordValue(agent.adapter);
  const binary = typeof agent.binary === "string" ? agent.binary : "";
  const result: LooseRecord = {
    ...normalizeProbe(await runCommand(binary, ["--version"])),
    id: agent.id,
    displayName: agent.displayName,
    binary,
    recommended: agent.recommended,
    tier: agent.tier,
    roles: agent.roles,
    capabilities: agent.capabilities,
    installMethods: Object.keys(recordValue(agent.install)),
    adapter: Object.keys(adapter).length > 0 ? adapter : null,
    adapterInstalled: null,
    adapterCommand: null,
  };

  // Probe adapter availability when adapter command differs from agent binary
  if (adapter.command && adapter.command !== binary) {
    const adapterArgs = Array.isArray(adapter.args) && adapter.args.length ? adapter.args.map(String) : ["--help"];
    const adapterCommand = String(adapter.command);
    const adapterProbe = normalizeProbe(await runCommand(adapterCommand, adapterArgs));
    result.adapterInstalled = adapterProbe.installed;
    result.adapterCommand = adapterCommand;
  } else if (adapter.command && adapter.command === binary) {
    // Adapter is the same binary (e.g. Reasonix) — already probed above
    result.adapterInstalled = result.installed;
    result.adapterCommand = adapter.command;
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

  const agentEntries = await Promise.all(listSetupAgents().map(async (agent: LooseRecord) => {
    return [String(agent.id), await probeAgent(agent, runCommand)] as [string, LooseRecord];
  }));
  const agents: LooseRecord = {};
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
