import { getSetupAgent } from "./agent-catalog.js";
import { normalizeCommandProbe } from "./detect.js";

const SCHEMA_VERSION = 1;

function splitCommand(commandLine) {
  const parts = String(commandLine || "").trim().split(/\s+/).filter(Boolean);
  return { command: parts[0], args: parts.slice(1) };
}

async function defaultRunCommand(command, args = []) {
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
    return { ok: false, stdout: error.stdout || "", stderr: error.stderr || "", error };
  }
}

function asAgent(agentOrId) {
  if (typeof agentOrId === "string") {
    const agent = getSetupAgent(agentOrId);
    if (!agent) throw new Error(`Unknown setup agent: ${agentOrId}`);
    return agent;
  }
  if (!agentOrId || typeof agentOrId !== "object") {
    throw new Error("checkSetupAgentHealth requires an agent id or manifest");
  }
  return agentOrId;
}

function skippedCheck(reason) {
  return {
    installed: false,
    status: "skipped",
    version: null,
    error: null,
    evidence: { reason },
  };
}

function okOrProbe(result) {
  const probe = normalizeCommandProbe(result);
  if (probe.status === "installed") {
    return { ...probe, status: "ok" };
  }
  return probe;
}

function overallStatus(checks) {
  if (checks.binary.status !== "installed") return "missing";
  const blocking = [checks.auth, checks.adapter].some((check) => !["ok", "skipped"].includes(check.status));
  return blocking ? "degraded" : "ready";
}

export async function checkSetupAgentHealth(agentOrId, { runCommand = defaultRunCommand } = {}) {
  const agent = asAgent(agentOrId);
  const binary = normalizeCommandProbe(await runCommand(agent.binary, ["--version"]));

  let auth: Record<string, any> = skippedCheck("agent manifest does not define auth.statusCommand");
  if (agent.auth?.statusCommand) {
    const parsed = splitCommand(agent.auth.statusCommand);
    auth = okOrProbe(await runCommand(parsed.command, parsed.args));
  }

  let adapter: Record<string, any> = skippedCheck("agent manifest does not define adapter.command");
  if (agent.adapter?.command) {
    adapter = okOrProbe(await runCommand(agent.adapter.command, ["--help"]));
  }

  const checks = { binary, auth, adapter };
  return {
    schemaVersion: SCHEMA_VERSION,
    agent: {
      id: agent.id,
      displayName: agent.displayName,
      binary: agent.binary,
    },
    status: overallStatus(checks),
    checks,
  };
}
