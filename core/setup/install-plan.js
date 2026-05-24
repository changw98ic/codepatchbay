import { spawn } from "node:child_process";
import { getSetupAgent } from "./agent-catalog.js";

function parseSimpleCommand(command) {
  const parts = command.trim().split(/\s+/);
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

function pickMethod(agent, detected) {
  if (agent.install.brew && detected?.tools?.brew?.installed) return "brew";
  if (agent.install.npm && detected?.tools?.npm?.installed) return "npm";
  return Object.keys(agent.install)[0];
}

export function createInstallPlan({ agentId, method, detected } = {}) {
  const agent = getSetupAgent(agentId);
  if (!agent) {
    throw new Error(`Unknown setup agent: ${agentId}`);
  }

  const selectedMethod = method || pickMethod(agent, detected);
  const install = agent.install?.[selectedMethod];
  if (!install) {
    throw new Error(`Agent '${agentId}' does not support install method '${selectedMethod}'`);
  }

  const shell = /[|&;<>()]/.test(install.command);
  const parsed = shell
    ? { command: "sh", args: ["-lc", install.command] }
    : parseSimpleCommand(install.command);

  return {
    agent: {
      id: agent.id,
      displayName: agent.displayName,
      vendor: agent.vendor,
      binary: agent.binary,
    },
    method: selectedMethod,
    label: install.label,
    command: parsed.command,
    args: parsed.args,
    displayCommand: install.command,
    sourceUrl: install.sourceUrl || agent.sourceUrl,
    notes: install.notes || [],
    requiresExplicitConfirmation: true,
    shell,
  };
}

export async function executeInstallPlan(plan, { stdio = "inherit" } = {}) {
  if (!plan?.requiresExplicitConfirmation) {
    throw new Error("Refusing to execute an install plan without explicit-confirmation metadata");
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(plan.command, plan.args, { stdio });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, code });
      else reject(Object.assign(new Error(`Install command exited with code ${code}`), { code }));
    });
  });
}
