import { recordValue, type LooseRecord } from "../../shared/types.js";
import { getSetupAgent } from "./agent-catalog.js";
import { normalizeCommandProbe } from "./detect.js";

const SCHEMA_VERSION = 1;

type RunCommand = (command: string, args: string[]) => Promise<LooseRecord>;

function splitCommand(commandLine: string) {
  const parts = String(commandLine || "").trim().split(/\s+/).filter(Boolean);
  return { command: parts[0], args: parts.slice(1) };
}

async function defaultRunCommand(command: string, args: string[] = []) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    const result = await execFileAsync(command, args, {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    const err = recordValue(error);
    return { ok: false, stdout: err.stdout || "", stderr: err.stderr || "", error };
  }
}

function asAgent(agentOrId: unknown): LooseRecord {
  if (typeof agentOrId === "string") {
    const agent = getSetupAgent(agentOrId);
    if (!agent) throw new Error(`Unknown setup agent: ${agentOrId}`);
    return agent;
  }
  if (!agentOrId || typeof agentOrId !== "object") {
    throw new Error("checkSetupAgentHealth requires an agent id or manifest");
  }
  return recordValue(agentOrId);
}

function skippedCheck(reason: string) {
  return {
    installed: false,
    status: "skipped",
    version: null as string | null,
    error: null as unknown,
    evidence: { reason },
  };
}

function okOrProbe(result: LooseRecord) {
  const probe = normalizeCommandProbe(result);
  if (probe.status === "installed") {
    return { ...probe, status: "ok" };
  }
  return probe;
}

function overallStatus(checks: Record<string, LooseRecord>): string {
  if (checks.binary.status !== "installed") return "missing";
  const blocking = [checks.auth, checks.adapter].some((check) => !["ok", "skipped"].includes(check.status));
  return blocking ? "degraded" : "ready";
}

export async function checkSetupAgentHealth(agentOrId: unknown, { runCommand = defaultRunCommand }: LooseRecord = {}) {
  const agent = asAgent(agentOrId);
  const commandRunner = typeof runCommand === "function" ? runCommand as RunCommand : defaultRunCommand;
  const binaryName = typeof agent.binary === "string" ? agent.binary : "";
  const binary = normalizeCommandProbe(await commandRunner(binaryName, ["--version"]));

  let auth: LooseRecord = skippedCheck("agent manifest does not define auth.statusCommand");
  const authConfig = recordValue(agent.auth);
  if (authConfig.statusCommand) {
    const parsed = splitCommand(String(authConfig.statusCommand));
    auth = okOrProbe(await commandRunner(parsed.command, parsed.args));
  }

  let adapter: LooseRecord = skippedCheck("agent manifest does not define adapter.command");
  const adapterConfig = recordValue(agent.adapter);
  if (adapterConfig.command) {
    adapter = okOrProbe(await commandRunner(String(adapterConfig.command), ["--help"]));
  }

  const checks = { binary, auth, adapter };
  return {
    schemaVersion: SCHEMA_VERSION,
    agent: {
      id: agent.id,
      displayName: agent.displayName,
      binary: binaryName,
    },
    status: overallStatus(checks),
    checks,
  };
}
