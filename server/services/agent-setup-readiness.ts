// @ts-nocheck
import { listSetupAgents } from "../../core/setup/agent-catalog.js";
import { detectSetupEnvironment } from "../../core/setup/detect.js";

function installMethods(agent) {
  return Object.keys(agent.install || {});
}

function preferredMethod(agent, setupSnapshot = {}) {
  const methods = installMethods(agent);
  if (methods.includes("brew") && setupSnapshot.tools?.brew?.installed) return "brew";
  if (methods.includes("npm") && setupSnapshot.tools?.npm?.installed) return "npm";
  return methods[0] || "manual";
}

function splitSimpleCommand(command) {
  const parts = String(command || "").trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] || "", args: parts.slice(1) };
}

function buildNonExecutingPlan(agent, method) {
  const install = agent.install?.[method] || null;
  if (!install) return null;
  const shell = /[|&;<>()]/.test(install.command || "");
  const parsed = shell
    ? { command: "sh", args: ["-lc", install.command] }
    : splitSimpleCommand(install.command);

  return {
    method,
    label: install.label || method,
    safePlanCommand: `cpb agents install ${agent.id} --method ${method}`,
    command: parsed.command,
    args: parsed.args,
    displayCommand: install.command,
    sourceUrl: install.sourceUrl || agent.sourceUrl || null,
    notes: install.notes || [],
    requiresExplicitConfirmation: true,
    executed: false,
    shell,
  };
}

export function buildAgentSetupReadiness({
  setupSnapshot = {},
  catalog = listSetupAgents(),
} = {}) {
  const agents = catalog.map((agent) => {
    const probe = setupSnapshot.agents?.[agent.id] || { installed: false, status: "missing" };
    const installed = Boolean(probe.installed);
    const method = preferredMethod(agent, setupSnapshot);
    const plan = installed ? null : buildNonExecutingPlan(agent, method);

    return {
      id: agent.id,
      displayName: agent.displayName,
      vendor: agent.vendor,
      binary: agent.binary,
      recommended: Boolean(agent.recommended),
      tier: agent.tier ?? null,
      roles: agent.roles || [],
      capabilities: agent.capabilities || [],
      installed,
      status: probe.status || (installed ? "installed" : "missing"),
      version: probe.version || null,
      error: probe.error || null,
      installMethods: installMethods(agent),
      install: plan,
      auth: {
        methods: agent.auth?.methods || [],
        statusCommand: agent.auth?.statusCommand || null,
        connectCommand: agent.auth?.connectCommand || null,
      },
      adapter: agent.adapter || null,
      sourceUrl: agent.sourceUrl || null,
    };
  });

  return {
    agents,
    timestamp: setupSnapshot.generatedAt || new Date().toISOString(),
  };
}

export async function collectAgentSetupReadiness({
  detect = detectSetupEnvironment,
  catalog = listSetupAgents(),
} = {}) {
  const setupSnapshot = await detect();
  return buildAgentSetupReadiness({ setupSnapshot, catalog });
}
