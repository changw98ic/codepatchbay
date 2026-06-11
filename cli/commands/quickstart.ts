// @ts-nocheck
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import process from "node:process";

const execFile = promisify(execFileCb);

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";

function header(text) {
  console.log(`\n${CYAN}── ${text} ──${NC}\n`);
}

function ok(text) {
  console.log(`${GREEN}✓${NC} ${text}`);
}

function warn(text) {
  console.log(`${YELLOW}!${NC} ${text}`);
}

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

async function isCommandAvailable(command) {
  try {
    await execFile("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function detectAgents() {
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

export async function run(args, { cpbRoot, executorRoot } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  cpb quickstart [--agent <name>] [--project-path <path>] [--project-name <name>] [--demo]
  cpb quickstart --demo    # Run with mock agent (no real agent needed)`);
    return 0;
  }

  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();
  if (!executorRoot) executorRoot = process.env.CPB_EXECUTOR_ROOT || path.resolve(path.dirname(import.meta.url.replace("file://", "")), "..", "..");

  const agentFlag = optionValue(args, "--agent");
  const projectPath = optionValue(args, "--project-path") || process.cwd();
  const projectName = optionValue(args, "--project-name") || path.basename(projectPath).replace(/[^a-zA-Z0-9-]/g, "-");
  const demo = args.includes("--demo");

  // ─── Step 1: Welcome ───
  header("CodePatchbay Quickstart");
  console.log("  This wizard will get you running in 4 steps:");
  console.log("  1. Check environment & agents");
  console.log("  2. Configure your agent");
  console.log("  3. Initialize project");
  console.log("  4. Run your first task");
  console.log("");

  // ─── Step 2: Detect environment ───
  header("Step 1: Environment Check");

  const nodeOk = await isCommandAvailable("node");
  const gitOk = await isCommandAvailable("git");
  if (nodeOk) ok("Node.js installed");
  else warn("Node.js not found — CPB requires Node.js 20+");
  if (gitOk) ok("git installed");
  else warn("git not found — recommended for version control");

  // ─── Step 3: Agent selection ───
  header("Step 2: Agent Setup");

  let selectedAgent = agentFlag;

  if (demo) {
    selectedAgent = "demo";
    ok("Using demo mode (mock agent)");
  } else {
    const agents = await detectAgents();
    const available = agents.filter((a) => a.available);

    if (selectedAgent) {
      const match = agents.find((a) => a.name === selectedAgent);
      if (match) {
        ok(`Using agent: ${match.displayName} (--agent flag)`);
      } else {
        warn(`Agent '${selectedAgent}' not found in known agents. Proceeding anyway.`);
      }
    } else if (available.length === 1) {
      selectedAgent = available[0].name;
      ok(`Auto-detected agent: ${available[0].displayName}`);
    } else if (available.length > 1) {
      ok(`${available.length} agents found: ${available.map((a) => a.displayName).join(", ")}`);
      selectedAgent = "claude"; // Default to Claude if multiple available
      ok(`Defaulting to: Claude Code`);
    } else {
      warn("No agents detected. Install one:");
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
  header("Step 3: Initialize Project");
  console.log(`  Project: ${projectName}`);
  console.log(`  Path:    ${projectPath}`);

  try {
    const initMod = await import("./init.js");
    await initMod.run([projectPath, projectName], { cpbRoot, executorRoot });
    ok(`Project '${projectName}' initialized`);
  } catch (e) {
    // Project may already exist
    if (e.message?.includes("already")) {
      ok(`Project '${projectName}' already exists`);
    } else {
      warn(`Init skipped: ${e.message}`);
    }
  }

  // Configure agent binding
  if (selectedAgent && !demo) {
    try {
      const configMod = await import("./config.js");
      await configMod.run([projectName, "--agent", selectedAgent], { cpbRoot });
      ok(`Agent '${selectedAgent}' bound to project`);
    } catch {
      warn("Could not save agent binding");
    }
  }

  // ─── Step 5: First task guidance ───
  header("Step 4: Ready to Go!");

  console.log("  Your project is set up. Here's how to use it:\n");
  console.log(`  ${CYAN}Run a full pipeline:${NC}`);
  console.log(`    cpb pipeline ${projectName} "Add a hello world endpoint" --agent ${selectedAgent || "claude"}\n`);
  console.log(`  ${CYAN}Or enqueue through the Hub worker:${NC}`);
  console.log(`    cpb run "Add a hello world endpoint" --project ${projectName} --agent ${selectedAgent || "claude"}\n`);
  console.log(`  ${CYAN}Inspect progress:${NC}`);
  console.log(`    cpb status ${projectName}`);
  console.log(`    cpb jobs report\n`);
  console.log(`  ${CYAN}Configure agent instructions:${NC}`);
  console.log(`    cpb config ${projectName} --instructions "Focus on performance and memory safety"\n`);
  console.log(`  ${CYAN}Add a new model provider:${NC}`);
  console.log(`    cpb provider add --name kimi --command kimi-acp --template generic-cli`);
  console.log(`    cpb config ${projectName} --agent kimi\n`);
  console.log(`  ${CYAN}Web UI:${NC}`);
  console.log(`    cpb ui\n`);
  console.log(`  ${CYAN}Help:${NC}`);
  console.log(`    cpb <command> --help\n`);

  return 0;
}
