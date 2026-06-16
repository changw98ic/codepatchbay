import { spawn } from "node:child_process";
import { getSetupAgent } from "./agent-catalog.js";

function parseSimpleCommand(command: string) {
  const parts = command.trim().split(/\s+/);
  return {
    command: parts[0],
    args: parts.slice(1),
  };
}

function renderPinnedCommand(template: string, version: string) {
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("version must be a non-empty string");
  }
  if (!/^[A-Za-z0-9._+-]+$/.test(version)) {
    throw new Error("version contains unsupported characters");
  }
  if (!template || typeof template !== "string") {
    throw new Error("pinnedCommandTemplate is required when version is supplied");
  }
  return template.replaceAll("{version}", version);
}

function packageNameFromNpm(command: string) {
  const parts = command.trim().split(/\s+/);
  return parts[parts.length - 1] || null;
}

function brewPackageFromCommand(command: string) {
  const parts = command.trim().split(/\s+/);
  return parts[parts.length - 1] || null;
}

function rollbackFor(method: string, install: Record<string, any>) {
  if (method === "npm") {
    const pkg = packageNameFromNpm(install.command);
    return {
      command: pkg ? `npm uninstall -g ${pkg}` : null,
      notes: pkg ? [] : ["Package name could not be inferred; use vendor uninstall guidance."],
    };
  }
  if (method === "brew") {
    const pkg = brewPackageFromCommand(install.command);
    const cask = install.command.includes("--cask");
    return {
      command: pkg ? `brew uninstall ${cask ? "--cask " : ""}${pkg}` : null,
      notes: pkg ? [] : ["Formula name could not be inferred; use vendor uninstall guidance."],
    };
  }
  return {
    command: null,
    notes: ["Use vendor uninstall guidance for fetched installer rollback."],
  };
}

function supplyChainNotesFor({ shell, install }: { shell: boolean; install: Record<string, any> }) {
  const notes = ["Review the source URL before executing this plan."];
  if (shell) {
    notes.push("Fetched installer commands require extra supply-chain review before execution.");
  }
  for (const note of install.notes || []) {
    if (!notes.includes(note)) notes.push(note);
  }
  return notes;
}

function planCommand(command: string) {
  const shell = /[|&;<>()]/.test(command);
  const parsed = shell
    ? { command: "sh", args: ["-lc", command] }
    : parseSimpleCommand(command);
  return { ...parsed, shell };
}

export function upgradeFor(method: string, agent: Record<string, any>) {
  const upgrade = agent.upgrade?.[method] || null;
  if (!upgrade?.command) return null;
  const parsed = planCommand(upgrade.command);
  return {
    method,
    label: upgrade.label || "upgrade",
    command: parsed.command,
    args: parsed.args,
    displayCommand: upgrade.command,
    sourceUrl: upgrade.sourceUrl || agent.sourceUrl,
    notes: upgrade.notes || [],
    requiresExplicitConfirmation: true,
    shell: parsed.shell,
  };
}

function pickMethod(agent: Record<string, any>, detected: Record<string, any>) {
  if (agent.install.brew && detected?.tools?.brew?.installed) return "brew";
  if (agent.install.npm && detected?.tools?.npm?.installed) return "npm";
  return Object.keys(agent.install)[0];
}

export function createInstallPlan({ agentId, method, version, detected }: Record<string, any> = {}) {
  const agent = getSetupAgent(agentId);
  if (!agent) {
    throw new Error(`Unknown setup agent: ${agentId}`);
  }

  const selectedMethod = method || pickMethod(agent, detected);
  const install = agent.install?.[selectedMethod];
  if (!install) {
    throw new Error(`Agent '${agentId}' does not support install method '${selectedMethod}'`);
  }

  const hasVersion = version !== undefined && version !== null;
  const displayCommand = hasVersion
    ? renderPinnedCommand(install.pinnedCommandTemplate, version)
    : install.command;
  const parsed = planCommand(displayCommand);

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
    displayCommand,
    version: hasVersion ? version : undefined,
    sourceUrl: install.sourceUrl || agent.sourceUrl,
    notes: install.notes || [],
    rollback: rollbackFor(selectedMethod, install),
    upgrade: upgradeFor(selectedMethod, agent),
    supplyChainNotes: supplyChainNotesFor({ shell: parsed.shell, install }),
    requiresExplicitConfirmation: true,
    shell: parsed.shell,
  };
}

export async function executeInstallPlan(plan: Record<string, any>, { stdio = "inherit" }: Record<string, any> = {}) {
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
