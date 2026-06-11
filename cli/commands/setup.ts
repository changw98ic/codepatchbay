function statusMark(installed) {
  return installed ? "OK" : "--";
}

function formatTool(name, probe) {
  const suffix = probe.version ? ` (${probe.version})` : "";
  return `${statusMark(probe.installed)} ${name}${suffix}`;
}

function pickPreferredInstall(agent, snapshot) {
  const methods = Object.entries(agent.install || {});
  return methods.find(([method]) => method === "brew" && snapshot.tools.brew.installed)
    || methods.find(([method]) => method === "npm" && snapshot.tools.npm.installed)
    || methods[0];
}

function recommendedInstallLines(snapshot, catalog) {
  const missingRecommended = catalog.filter((agent) => agent.recommended && !snapshot.agents[agent.id]?.installed);
  if (missingRecommended.length === 0) return ["All recommended coding agents are installed."];

  return missingRecommended.map((agent) => {
    const [method, install] = pickPreferredInstall(agent, snapshot);
    return `${agent.displayName}: cpb agents install ${agent.id} --method ${method}  # ${(install as Record<string, any>).command}`;
  });
}

function formatHuman(snapshot, catalog) {
  const lines = [
    "CodePatchBay Setup",
    "",
    "Detected:",
    `  ${snapshot.system.platform} ${snapshot.system.arch}`,
    `  ${formatTool("Node.js", snapshot.tools.node)}`,
    `  ${formatTool("git", snapshot.tools.git)}`,
    `  ${formatTool("npm", snapshot.tools.npm)}`,
    `  ${formatTool("Homebrew", snapshot.tools.brew)}`,
    "",
    "Agents:",
  ];

  for (const agent of catalog) {
    const probe = snapshot.agents[agent.id];
    const roles = agent.roles.join(", ");
    lines.push(`  ${statusMark(probe?.installed)} ${agent.displayName} (${roles})`);
  }

  lines.push("", "Recommended next steps:");
  for (const line of recommendedInstallLines(snapshot, catalog)) {
    lines.push(`  ${line}`);
  }

  lines.push("", "Detection only. Run cpb setup to launch the installer wizard.");
  return `${lines.join("\n")}\n`;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function parseAgents(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function wizardMode(args) {
  if (args.includes("--recommended")) return "recommended";
  if (args.includes("--non-interactive")) return "non-interactive";
  return "interactive";
}

function formatWizardHuman(result) {
  const lines = [
    "CodePatchBay Setup Wizard",
    "",
    "Selected agents:",
  ];
  for (const agent of result.selectedAgents) {
    const install = result.installations[agent.id];
    const health = result.health[agent.id];
    lines.push(`  ${agent.id}\tinstall:${install?.status || "skipped"}\thealth:${health?.status || "unknown"}`);
  }
  lines.push("", `Setup profile: ${result.profilePath || "cpb-task/setup-profile.json"}`, "");
  return lines.join("\n");
}

export async function run(args = [], { cpbRoot }: Record<string, any> = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: cpb setup [--recommended|--interactive|--non-interactive --agents codex,claude] [--json] [--detect-only]");
    return 0;
  }

  const json = args.includes("--json");
  const detectOnly = args.includes("--detect-only");
  const { detectSetupEnvironment } = await import("../../core/setup/detect.js");
  const { listSetupAgents } = await import("../../core/setup/agent-catalog.js");

  if (!detectOnly) {
    const agentsFlag = optionValue(args, "--agents")
      || args.find((arg) => arg.startsWith("--agents="))?.slice("--agents=".length)
      || "";
    const { runSetupWizard, setupProfilePath } = await import("../../core/setup/wizard.js");
    const { runInstallPlanWithEvents } = await import("../../server/services/setup.js");
    const result = await runSetupWizard({
      cpbRoot,
      mode: wizardMode(args),
      agents: parseAgents(agentsFlag),
      runInstallPlanFn: runInstallPlanWithEvents,
      execute: !json || args.includes("--recommended") || args.includes("--non-interactive") || Boolean(agentsFlag),
      stdio: json ? "ignore" : "inherit",
    }) as Record<string, any>;
    result.profilePath = setupProfilePath(cpbRoot);
    if (json) console.log(JSON.stringify(result, null, 2));
    else console.log(formatWizardHuman(result));
    return 0;
  }

  const snapshot = await detectSetupEnvironment();
  const catalog = listSetupAgents();

  if (json) {
    console.log(JSON.stringify({ ...snapshot, catalog }, null, 2));
  } else {
    console.log(formatHuman(snapshot, catalog));
  }
  return 0;
}
