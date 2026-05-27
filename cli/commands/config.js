import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function parseAgents(agents, updates) {
  const result = { ...agents };
  if (updates.default !== undefined) result.default = updates.default || undefined;
  if (updates.phases) {
    result.phases = { ...result.phases, ...updates.phases };
    // Remove null entries
    for (const [k, v] of Object.entries(result.phases)) {
      if (!v) delete result.phases[k];
    }
  }
  // Clean up empty
  if (!result.default) delete result.default;
  if (!result.phases || Object.keys(result.phases).length === 0) delete result.phases;
  return Object.keys(result).length > 0 ? result : null;
}

async function readProjectJson(cpbRoot, project) {
  const filePath = path.join(cpbRoot, "wiki", "projects", project, "project.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeProjectJson(cpbRoot, project, data) {
  const filePath = path.join(cpbRoot, "wiki", "projects", project, "project.json");
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function run(args, { cpbRoot } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  cpb config <project> --agent <name>           Set default agent for all phases
  cpb config <project> --plan-agent <name>      Set agent for plan phase
  cpb config <project> --execute-agent <name>   Set agent for execute phase
  cpb config <project> --verify-agent <name>    Set agent for verify phase
  cpb config <project> --review-agent <name>    Set agent for review phase
  cpb config <project> --agents                 Show current agent configuration
  cpb config <project> --instructions <text>    Set project-level agent instructions
  cpb config <project> --clear-instructions     Remove project-level agent instructions
  cpb config <project> --unset-agent            Remove all agent overrides`);
    return 0;
  }

  const project = args.find((a) => !a.startsWith("-"));
  if (!project) {
    console.error("Usage: cpb config <project> [options]");
    return 1;
  }

  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();
  const data = await readProjectJson(cpbRoot, project);

  // Show current config
  if (args.includes("--agents")) {
    const agents = data.agents || {};
    if (!agents.default && !agents.phases) {
      console.log(`No agent overrides for project '${project}'. Using registry defaults.`);
    } else {
      console.log(`Agent config for project '${project}':`);
      if (agents.default) console.log(`  default: ${agents.default}`);
      if (agents.phases) {
        for (const [phase, agent] of Object.entries(agents.phases)) {
          console.log(`  ${phase}: ${agent}`);
        }
      }
    }
    return 0;
  }

  // Clear instructions
  if (args.includes("--clear-instructions")) {
    delete data.agentInstructions;
    await writeProjectJson(cpbRoot, project, data);
    console.log(`Cleared agent instructions for project '${project}'.`);
    return 0;
  }

  // Unset agent overrides
  if (args.includes("--unset-agent")) {
    delete data.agents;
    await writeProjectJson(cpbRoot, project, data);
    console.log(`Removed agent overrides for project '${project}'. Using registry defaults.`);
    return 0;
  }

  // Set instructions
  const instructions = optionValue(args, "--instructions");
  if (instructions) {
    data.agentInstructions = instructions;
    await writeProjectJson(cpbRoot, project, data);
    console.log(`Set agent instructions for project '${project}'.`);
    return 0;
  }

  // Set agent overrides
  const defaultAgent = optionValue(args, "--agent");
  const planAgent = optionValue(args, "--plan-agent");
  const executeAgent = optionValue(args, "--execute-agent");
  const verifyAgent = optionValue(args, "--verify-agent");
  const reviewAgent = optionValue(args, "--review-agent");

  if (!defaultAgent && !planAgent && !executeAgent && !verifyAgent && !reviewAgent) {
    console.error("No configuration option specified. Use --agent, --plan-agent, --execute-agent, --verify-agent, --review-agent, --instructions, or --agents.");
    return 1;
  }

  const phaseUpdates = {};
  if (planAgent) phaseUpdates.plan = planAgent;
  if (executeAgent) phaseUpdates.execute = executeAgent;
  if (verifyAgent) phaseUpdates.verify = verifyAgent;
  if (reviewAgent) phaseUpdates.review = reviewAgent;

  data.agents = parseAgents(data.agents || {}, {
    default: defaultAgent,
    phases: Object.keys(phaseUpdates).length > 0 ? phaseUpdates : undefined,
  });

  await writeProjectJson(cpbRoot, project, data);
  console.log(`Updated agent config for project '${project}'.`);
  return 0;
}
