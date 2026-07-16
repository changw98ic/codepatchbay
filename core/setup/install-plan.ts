import { recordValue, type LooseRecord } from "../../shared/types.js";
import { spawn, type StdioOptions } from "node:child_process";
import { getSetupAgent } from "./agent-catalog.js";

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function stdioValue(value: unknown): StdioOptions {
  if (value === "pipe" || value === "ignore" || value === "inherit") return value;
  if (Array.isArray(value)) return value as StdioOptions;
  return "inherit";
}

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

function rollbackFor(method: string, install: LooseRecord) {
  const command = stringValue(install.command);
  if (method === "npm") {
    const pkg = packageNameFromNpm(command);
    return {
      command: pkg ? `npm uninstall -g ${pkg}` : null,
      notes: pkg ? [] : ["Package name could not be inferred; use vendor uninstall guidance."],
    };
  }
  if (method === "brew") {
    const pkg = brewPackageFromCommand(command);
    const cask = command.includes("--cask");
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

function supplyChainNotesFor({ shell, install }: { shell: boolean; install: LooseRecord }) {
  const notes = ["Review the source URL before executing this plan."];
  if (shell) {
    notes.push("Fetched installer commands require extra supply-chain review before execution.");
  }
  for (const note of stringArray(install.notes)) {
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

export function upgradeFor(method: string, agent: LooseRecord) {
  const upgrade = recordValue(recordValue(agent.upgrade)[method]);
  const upgradeCommand = stringValue(upgrade.command);
  if (!upgradeCommand) return null;
  const parsed = planCommand(upgradeCommand);
  return {
    method,
    label: stringValue(upgrade.label, "upgrade"),
    command: parsed.command,
    args: parsed.args,
    displayCommand: upgradeCommand,
    sourceUrl: upgrade.sourceUrl || agent.sourceUrl,
    notes: stringArray(upgrade.notes),
    requiresExplicitConfirmation: true,
    shell: parsed.shell,
  };
}

function pickMethod(agent: LooseRecord, detected: LooseRecord) {
  const install = recordValue(agent.install);
  const tools = recordValue(recordValue(detected).tools);
  if (install.brew && recordValue(tools.brew).installed) return "brew";
  if (install.npm && recordValue(tools.npm).installed) return "npm";
  return Object.keys(install)[0];
}

export function createInstallPlan({ agentId, method, version, detected }: LooseRecord = {}) {
  const agent = getSetupAgent(stringValue(agentId));
  if (!agent) {
    throw new Error(`Unknown setup agent: ${agentId}`);
  }

  const selectedMethod = stringValue(method) || pickMethod(agent, recordValue(detected));
  const install = recordValue(recordValue(agent.install)[selectedMethod]);
  if (Object.keys(install).length === 0) {
    throw new Error(`Agent '${agentId}' does not support install method '${selectedMethod}'`);
  }

  const hasVersion = version !== undefined && version !== null;
  const displayCommand = hasVersion
    ? renderPinnedCommand(stringValue(install.pinnedCommandTemplate), stringValue(version))
    : stringValue(install.command);
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
    notes: stringArray(install.notes),
    rollback: rollbackFor(selectedMethod, install),
    upgrade: upgradeFor(selectedMethod, agent),
    supplyChainNotes: supplyChainNotesFor({ shell: parsed.shell, install }),
    requiresExplicitConfirmation: true,
    shell: parsed.shell,
  };
}

export async function executeInstallPlan(plan: LooseRecord, { stdio = "inherit" }: LooseRecord = {}) {
  if (!plan?.requiresExplicitConfirmation) {
    throw new Error("Refusing to execute an install plan without explicit-confirmation metadata");
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(stringValue(plan.command), stringArray(plan.args), { stdio: stdioValue(stdio) });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, code });
        else reject(Object.assign(new Error(`Install command exited with code ${code}`), { code }));
      });
    });
}
