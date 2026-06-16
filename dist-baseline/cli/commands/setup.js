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
    if (missingRecommended.length === 0)
        return ["All recommended coding agents are installed."];
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
    if (args.includes("--recommended"))
        return "recommended";
    if (args.includes("--non-interactive"))
        return "non-interactive";
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
    lines.push("", `Setup profile: ${result.profilePath || "hub/setup/profile.json"}`, "");
    return lines.join("\n");
}
// ─── Quickstart helpers ───
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";
const execFile = promisify(execFileCb);
const Q_CYAN = "\x1b[0;36m";
const Q_GREEN = "\x1b[0;32m";
const Q_YELLOW = "\x1b[1;33m";
const Q_NC = "\x1b[0m";
function qHeader(text) {
    console.log(`\n${Q_CYAN}── ${text} ──${Q_NC}\n`);
}
function qOk(text) {
    console.log(`${Q_GREEN}✓${Q_NC} ${text}`);
}
function qWarn(text) {
    console.log(`${Q_YELLOW}!${Q_NC} ${text}`);
}
function qOptionValue(args, name) {
    const idx = args.indexOf(name);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}
async function isCommandAvailable(command) {
    try {
        await execFile("which", [command]);
        return true;
    }
    catch {
        return false;
    }
}
async function detectQuickAgents() {
    const known = [
        { name: "claude", command: "claude", displayName: "Claude Code" },
        { name: "codex", command: "codex", displayName: "Codex CLI" },
        { name: "opencode", command: "opencode", displayName: "OpenCode" },
        { name: "cursor", command: "cursor", displayName: "Cursor Agent" },
    ];
    const results = [];
    for (const agent of known) {
        const available = await isCommandAvailable(agent.command);
        results.push({ ...agent, available });
    }
    return results;
}
async function runQuickstart(args, { cpbRoot, executorRoot } = {}) {
    if (args.includes("--help") || args.includes("-h")) {
        console.log(`Usage:
  cpb quickstart [--agent <name>] [--project-path <path>] [--project-name <name>] [--demo]
  cpb quickstart --demo    # Run with mock agent (no real agent needed)`);
        return 0;
    }
    if (!cpbRoot)
        cpbRoot = process.env.CPB_ROOT || process.cwd();
    if (!executorRoot)
        executorRoot = process.env.CPB_EXECUTOR_ROOT || path.resolve(path.dirname(import.meta.url.replace("file://", "")), "..", "..");
    const agentFlag = qOptionValue(args, "--agent");
    const projectPath = qOptionValue(args, "--project-path") || process.cwd();
    const projectName = qOptionValue(args, "--project-name") || path.basename(projectPath).replace(/[^a-zA-Z0-9-]/g, "-");
    const demo = args.includes("--demo");
    // ─── Step 1: Welcome ───
    qHeader("CodePatchbay Quickstart");
    console.log("  This wizard will get you running in 4 steps:");
    console.log("  1. Check environment & agents");
    console.log("  2. Configure your agent");
    console.log("  3. Initialize project");
    console.log("  4. Run your first task");
    console.log("");
    // ─── Step 2: Detect environment ───
    qHeader("Step 1: Environment Check");
    const nodeOk = await isCommandAvailable("node");
    const gitOk = await isCommandAvailable("git");
    if (nodeOk)
        qOk("Node.js installed");
    else
        qWarn("Node.js not found — CPB requires Node.js 20+");
    if (gitOk)
        qOk("git installed");
    else
        qWarn("git not found — recommended for version control");
    // ─── Step 3: Agent selection ───
    qHeader("Step 2: Agent Setup");
    let selectedAgent = agentFlag;
    if (demo) {
        selectedAgent = "demo";
        qOk("Using demo mode (mock agent)");
    }
    else {
        const agents = await detectQuickAgents();
        const available = agents.filter((a) => a.available);
        if (selectedAgent) {
            const match = agents.find((a) => a.name === selectedAgent);
            if (match) {
                qOk(`Using agent: ${match.displayName} (--agent flag)`);
            }
            else {
                qWarn(`Agent '${selectedAgent}' not found in known agents. Proceeding anyway.`);
            }
        }
        else if (available.length === 1) {
            selectedAgent = available[0].name;
            qOk(`Auto-detected agent: ${available[0].displayName}`);
        }
        else if (available.length > 1) {
            qOk(`${available.length} agents found: ${available.map((a) => a.displayName).join(", ")}`);
            selectedAgent = "claude"; // Default to Claude if multiple available
            qOk(`Defaulting to: Claude Code`);
        }
        else {
            qWarn("No agents detected. Install one:");
            console.log("    claude:   curl -fsSL https://claude.ai/install.sh | bash");
            console.log("    codex:    npm install -g @zed-industries/codex-acp");
            console.log("    opencode: curl -fsSL https://opencode.ai/install | bash");
            console.log("");
            console.log("  Then run: cpb quickstart --agent <name>");
            console.log("  Or try:   cpb quickstart --demo");
            return 1;
        }
    }
    // ─── Step 4: Initialize project ───
    qHeader("Step 3: Initialize Project");
    console.log(`  Project: ${projectName}`);
    console.log(`  Path:    ${projectPath}`);
    try {
        const initMod = await import("./init.js");
        await initMod.run([projectPath, projectName], { cpbRoot, executorRoot });
        qOk(`Project '${projectName}' initialized`);
    }
    catch (e) {
        // Project may already exist
        if (e.message?.includes("already")) {
            qOk(`Project '${projectName}' already exists`);
        }
        else {
            qWarn(`Init skipped: ${e.message}`);
        }
    }
    // Configure agent binding
    if (selectedAgent && !demo) {
        try {
            const { resolveHubRoot, updateProject } = await import("../../server/services/hub/hub-registry.js");
            const hubRoot = resolveHubRoot(cpbRoot);
            await updateProject(hubRoot, projectName, { agent: selectedAgent });
            qOk(`Agent '${selectedAgent}' bound to project`);
        }
        catch {
            qWarn("Could not save agent binding");
        }
    }
    // ─── Step 5: First task guidance ───
    qHeader("Step 4: Ready to Go!");
    console.log("  Your project is set up. Here's how to use it:\n");
    console.log(`  ${Q_CYAN}Run a full pipeline:${Q_NC}`);
    console.log(`    cpb pipeline ${projectName} "Add a hello world endpoint" --agent ${selectedAgent || "claude"}\n`);
    console.log(`  ${Q_CYAN}Or enqueue through the Hub worker:${Q_NC}`);
    console.log(`    cpb run "Add a hello world endpoint" --project ${projectName} --agent ${selectedAgent || "claude"}\n`);
    console.log(`  ${Q_CYAN}Inspect progress:${Q_NC}`);
    console.log(`    cpb status ${projectName}`);
    console.log(`    cpb jobs report\n`);
    console.log(`  ${Q_CYAN}Configure agent instructions:${Q_NC}`);
    console.log(`    cpb setup ${projectName}\n`);
    console.log(`  ${Q_CYAN}Web UI:${Q_NC}`);
    console.log(`    cpb ui\n`);
    console.log(`  ${Q_CYAN}Help:${Q_NC}`);
    console.log(`    cpb <command> --help\n`);
    return 0;
}
// ─── Main entry ───
export async function run(args = [], { cpbRoot, executorRoot } = {}) {
    if (args.includes("--help") || args.includes("-h")) {
        console.log("Usage:");
        console.log("  cpb setup [--recommended|--interactive|--non-interactive --agents codex,claude] [--json] [--detect-only]");
        console.log("  cpb setup --quickstart [--agent <name>] [--project-path <path>] [--project-name <name>] [--demo]");
        return 0;
    }
    // Delegate to quickstart flow when --quickstart flag is present
    if (args.includes("--quickstart")) {
        const qsArgs = args.filter((a) => a !== "--quickstart");
        return runQuickstart(qsArgs, { cpbRoot, executorRoot });
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
        });
        result.profilePath = setupProfilePath(cpbRoot);
        if (json)
            console.log(JSON.stringify(result, null, 2));
        else
            console.log(formatWizardHuman(result));
        return 0;
    }
    const snapshot = await detectSetupEnvironment();
    const catalog = listSetupAgents();
    if (json) {
        console.log(JSON.stringify({ ...snapshot, catalog }, null, 2));
    }
    else {
        console.log(formatHuman(snapshot, catalog));
    }
    return 0;
}
