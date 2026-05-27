import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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

function parseRuleString(str) {
  const parts = {};
  for (const segment of str.split(";")) {
    const eq = segment.indexOf("=");
    if (eq < 0) continue;
    const key = segment.slice(0, eq).trim();
    const val = segment.slice(eq + 1).trim();
    if (key.startsWith("match.")) {
      if (!parts.match) parts.match = {};
      const matchKey = key.slice(6);
      if (matchKey === "labels") parts.match[matchKey] = val.split(",").map(s => s.trim());
      else parts.match[matchKey] = val;
    } else if (key.startsWith("action.")) {
      if (!parts.action) parts.action = {};
      parts.action[key.slice(7)] = val;
    } else {
      parts[key] = val;
    }
  }
  return parts;
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
  cpb config <project> --plan-model <profile>   Set model profile for plan phase
  cpb config <project> --execute-model <profile> Set model profile for execute phase
  cpb config <project> --verify-model <profile>  Set model profile for verify phase
  cpb config <project> --review-model <profile>  Set model profile for review phase
  cpb config <project> --instructions <text>    Set project-level agent instructions
  cpb config <project> --clear-instructions     Remove project-level agent instructions
  cpb config <project> --unset-agent            Remove all agent overrides

  Automation:
  cpb config <project> --automation-enabled <true|false>
  cpb config <project> --automation-sync-interval <seconds>
  cpb config <project> --automation-rule '<match.labels=enhancement;action.workflow=standard;action.priority=P2>'
  cpb config <project> --automation-exclude-labels <label1,label2,...>
  cpb config <project> --automation-clear-rules
  cpb config <project> --show-automation`);
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
          const profile = agents.phaseProfiles?.[phase];
          console.log(`  ${phase}: ${agent}${profile ? ` (model: ${profile})` : ""}`);
        }
      }
      if (agents.phaseProfiles && !agents.phases) {
        for (const [phase, profile] of Object.entries(agents.phaseProfiles)) {
          console.log(`  ${phase} model: ${profile}`);
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

  // ─── Automation config (#48) ───

  if (args.includes("--show-automation")) {
    const { resolveHubRoot, getProject } = await import("../../server/services/hub-registry.js");
    const hubRoot = resolveHubRoot(cpbRoot);
    const hubProject = await getProject(hubRoot, project);
    if (!hubProject?.github?.automation) {
      console.log(`No automation config for project '${project}'.`);
      return 0;
    }
    const a = hubProject.github.automation;
    console.log(`Automation for project '${project}':`);
    console.log(`  enabled: ${a.enabled ?? false}`);
    console.log(`  syncIntervalSec: ${a.syncIntervalSec || 0}`);
    if (a.exclude?.labels?.length) console.log(`  exclude labels: ${a.exclude.labels.join(", ")}`);
    if (a.rules?.length) {
      console.log(`  rules:`);
      for (const r of a.rules) {
        const matchParts = [];
        if (r.match?.labels) matchParts.push(`labels:${r.match.labels.join("+")}`);
        if (r.match?.titlePattern) matchParts.push(`title~/${r.match.titlePattern}/`);
        const actionParts = [];
        if (r.action?.workflow) actionParts.push(`workflow:${r.action.workflow}`);
        if (r.action?.priority) actionParts.push(`priority:${r.action.priority}`);
        if (r.action?.planMode) actionParts.push(`planMode:${r.action.planMode}`);
        console.log(`    ${r.name || "unnamed"}: match{${matchParts.join(", ")}} → action{${actionParts.join(", ")}}`);
      }
    } else {
      console.log(`  rules: (none)`);
    }
    return 0;
  }

  const automationEnabled = optionValue(args, "--automation-enabled");
  const syncInterval = optionValue(args, "--automation-sync-interval");
  const ruleStrings = args.flatMap((a, i) => a === "--automation-rule" && args[i + 1] ? [args[i + 1]] : []);
  const excludeLabels = optionValue(args, "--automation-exclude-labels");
  const clearRules = args.includes("--automation-clear-rules");

  if (automationEnabled !== null || syncInterval !== null || ruleStrings.length > 0 || excludeLabels !== null || clearRules) {
    // Automation config lives in the hub registry (same place as github binding)
    const { resolveHubRoot, getProject, updateProject } = await import("../../server/services/hub-registry.js");
    const hubRoot = resolveHubRoot(cpbRoot);
    const hubProject = await getProject(hubRoot, project);
    if (!hubProject?.github) {
      console.error(`Project '${project}' has no GitHub binding. Run: cpb github bind ${project} <owner/repo>`);
      return 1;
    }
    const github = { ...hubProject.github };
    if (!github.automation) {
      github.automation = { enabled: false, rules: [], exclude: { labels: [] }, dedupBy: "issueNumber" };
    }
    const a = github.automation;

    if (automationEnabled !== null) a.enabled = automationEnabled === "true";
    if (syncInterval !== null) a.syncIntervalSec = parseInt(syncInterval, 10) || 0;
    if (excludeLabels !== null) {
      a.exclude = a.exclude || {};
      a.exclude.labels = excludeLabels.split(",").map(s => s.trim()).filter(Boolean);
    }
    if (clearRules) a.rules = [];
    for (const rs of ruleStrings) {
      const rule = parseRuleString(rs);
      if (!rule.match && !rule.action) {
        console.error(`Invalid rule: ${rs}`);
        return 1;
      }
      rule.name = rule.name || `rule-${(a.rules?.length || 0) + 1}`;
      a.rules = a.rules || [];
      a.rules.push(rule);
    }

    await updateProject(hubRoot, project, { github });
    console.log(`Updated automation config for project '${project}'.`);
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

  // Set per-phase model profiles
  const planModel = optionValue(args, "--plan-model");
  const executeModel = optionValue(args, "--execute-model");
  const verifyModel = optionValue(args, "--verify-model");
  const reviewModel = optionValue(args, "--review-model");

  if (!defaultAgent && !planAgent && !executeAgent && !verifyAgent && !reviewAgent && !planModel && !executeModel && !verifyModel && !reviewModel) {
    console.error("No configuration option specified. Use --agent, --plan-agent, --execute-agent, --verify-agent, --review-agent, --*-model, --instructions, or --agents.");
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

  // Store per-phase model profiles
  if (planModel || executeModel || verifyModel || reviewModel) {
    if (!data.agents) data.agents = {};
    const profiles = { ...(data.agents.phaseProfiles || {}) };
    if (planModel) profiles.plan = planModel;
    if (executeModel) profiles.execute = executeModel;
    if (verifyModel) profiles.verify = verifyModel;
    if (reviewModel) profiles.review = reviewModel;
    // Remove null entries
    for (const [k, v] of Object.entries(profiles)) {
      if (!v) delete profiles[k];
    }
    data.agents.phaseProfiles = Object.keys(profiles).length > 0 ? profiles : undefined;
  }

  await writeProjectJson(cpbRoot, project, data);
  console.log(`Updated agent config for project '${project}'.`);
  return 0;
}
