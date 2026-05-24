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
    return `${agent.displayName}: cpb agents install ${agent.id} --method ${method}  # ${install.command}`;
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

  lines.push("", "Nothing is installed by cpb setup. Run cpb agents install <agent> --yes to execute a shown plan.");
  return `${lines.join("\n")}\n`;
}

export async function run(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: cpb setup [--json]");
    return 0;
  }

  const json = args.includes("--json");
  const { detectSetupEnvironment } = await import("../../core/setup/detect.js");
  const { listSetupAgents } = await import("../../core/setup/agent-catalog.js");

  const snapshot = await detectSetupEnvironment();
  const catalog = listSetupAgents();

  if (json) {
    console.log(JSON.stringify({ ...snapshot, catalog }, null, 2));
  } else {
    console.log(formatHuman(snapshot, catalog));
  }
  return 0;
}
