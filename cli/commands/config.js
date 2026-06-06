import {
  readHubConfig,
  writeHubConfig,
  readProjectConfigFromRoots,
  readProjectJsonFromRoots,
  writeProjectJson,
  mergeAgentConfig,
  isValidSchedulerMode,
} from "../../server/services/agent-config.js";

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
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

function displayAgents(config, label) {
  if (!config || Object.keys(config).length === 0) {
    console.log(`${label}: (no overrides)`);
    return;
  }
  console.log(`${label}:`);
  if (config.default) console.log(`  default: ${config.default}`);
  if (config.phases) {
    for (const [phase, agent] of Object.entries(config.phases)) {
      const variant = config.variants?.[phase];
      const tag = variant ? ` variant:${variant}` : "";
      console.log(`  ${phase}: ${agent}${tag}`);
    }
  }
}

async function applyAgentUpdates(args, container, field, onSave) {
  const defaultAgent = optionValue(args, "--agent");
  const planAgent = optionValue(args, "--plan-agent");
  const executeAgent = optionValue(args, "--execute-agent");
  const verifyAgent = optionValue(args, "--verify-agent");
  const reviewAgent = optionValue(args, "--review-agent");
  const planVariant = optionValue(args, "--plan-variant");
  const executeVariant = optionValue(args, "--execute-variant");
  const verifyVariant = optionValue(args, "--verify-variant");
  const reviewVariant = optionValue(args, "--review-variant");

  const hasAgent = defaultAgent || planAgent || executeAgent || verifyAgent || reviewAgent;
  const hasVariant = planVariant !== null || executeVariant !== null || verifyVariant !== null || reviewVariant !== null;
  if (!hasAgent && !hasVariant) return false;

  const agents = { ...(container[field] || {}) };

  if (defaultAgent) agents.default = defaultAgent;
  if (!agents.phases) agents.phases = {};
  if (planAgent) agents.phases.plan = planAgent;
  if (executeAgent) agents.phases.execute = executeAgent;
  if (verifyAgent) agents.phases.verify = verifyAgent;
  if (reviewAgent) agents.phases.review = reviewAgent;

  // Clean empty phases
  for (const [k, v] of Object.entries(agents.phases)) {
    if (!v) delete agents.phases[k];
  }
  if (Object.keys(agents.phases).length === 0) delete agents.phases;

  // Variants
  if (hasVariant) {
    if (!agents.variants) agents.variants = {};
    if (planVariant !== null) {
      if (planVariant) agents.variants.plan = planVariant;
      else delete agents.variants.plan;
    }
    if (executeVariant !== null) {
      if (executeVariant) agents.variants.execute = executeVariant;
      else delete agents.variants.execute;
    }
    if (verifyVariant !== null) {
      if (verifyVariant) agents.variants.verify = verifyVariant;
      else delete agents.variants.verify;
    }
    if (reviewVariant !== null) {
      if (reviewVariant) agents.variants.review = reviewVariant;
      else delete agents.variants.review;
    }
    if (Object.keys(agents.variants).length === 0) delete agents.variants;
  }

  // Remove default if empty
  if (!agents.default) delete agents.default;

  container[field] = Object.keys(agents).length > 0 ? agents : undefined;
  await onSave(container);
  return true;
}

export async function run(args, { cpbRoot } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  cpb config --hub --agent <name>                Set global default agent
  cpb config --hub --plan-agent <name>           Set global agent for plan phase
  cpb config --hub --execute-agent <name>        Set global agent for execute phase
  cpb config --hub --verify-agent <name>         Set global agent for verify phase
  cpb config --hub --plan-variant <variant>      Set global variant for plan phase
  cpb config --hub --execute-variant <variant>   Set global variant for execute phase
  cpb config --hub --verify-variant <variant>    Set global variant for verify phase
  cpb config --hub --agents                      Show global agent config
  cpb config --hub --show-concurrency            Show global concurrency config
  cpb config --hub --show-scheduler              Show scheduler mode
  cpb config --hub --scheduler-mode <default|smart>  Set scheduler mode
  cpb config --hub --max-active-per-project <n>  Set default project mutating task cap
  cpb config --hub --acp-provider-max <n>        Set per-provider ACP connection cap
  cpb config --hub --unset-agent                 Remove global agent overrides

  cpb config <project> --agent <name>            Set project default agent
  cpb config <project> --plan-agent <name>       Set agent for plan phase
  cpb config <project> --execute-agent <name>    Set agent for execute phase
  cpb config <project> --verify-agent <name>     Set agent for verify phase
  cpb config <project> --review-agent <name>     Set agent for review phase
  cpb config <project> --plan-variant <variant>  Set variant for plan phase
  cpb config <project> --execute-variant <v>     Set variant for execute phase
  cpb config <project> --verify-variant <v>      Set variant for verify phase
  cpb config <project> --review-variant <v>      Set variant for review phase
  cpb config <project> --agents                  Show effective agent config (merged)
  cpb config <project> --unset-agent             Remove project agent overrides

  Variants: none (env default), mimo (Xiaomi MiMo), kimi (Moonshot Kimi)

  Other:
  cpb config <project> --plan-model <profile>    Set model profile for plan phase
  cpb config <project> --instructions <text>      Set project-level agent instructions
  cpb config <project> --clear-instructions       Remove project-level agent instructions
  cpb config <project> --max-active <n>            Set project concurrent mutating task cap
  cpb config <project> --show-concurrency          Show project concurrency config
  cpb config <project> --show-automation           Show automation config
  cpb config <project> --automation-enabled <t|f>  Enable/disable automation
  cpb config <project> --automation-rule '<...>'   Add automation rule`);
    return 0;
  }

  const isHub = args.includes("--hub");
  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();
  const { resolveHubRoot } = await import("../../server/services/hub-registry.js");
  const hubRoot = resolveHubRoot(cpbRoot);

  // ── Hub-level config ──
  if (isHub) {
    const hubConfig = await readHubConfig(hubRoot);

    if (args.includes("--agents")) {
      displayAgents(hubConfig.agents, "Hub (global)");
      return 0;
    }

    if (args.includes("--show-concurrency")) {
      console.log("Hub concurrency:");
      console.log(`  maxActivePerProject: ${hubConfig.concurrency?.maxActivePerProject || "(default)"}`);
      console.log(`  acpPool.providerMax: ${hubConfig.acpPool?.providerMax || "(default)"}`);
      return 0;
    }

    if (args.includes("--unset-agent")) {
      delete hubConfig.agents;
      await writeHubConfig(hubRoot, hubConfig);
      console.log("Removed global agent overrides.");
      return 0;
    }

    if (args.includes("--show-scheduler")) {
      const mode = hubConfig.scheduler?.mode || "default";
      console.log(`Scheduler mode: ${mode}`);
      return 0;
    }

    const schedulerMode = optionValue(args, "--scheduler-mode");
    if (schedulerMode) {
      if (!isValidSchedulerMode(schedulerMode)) {
        console.error(`Invalid scheduler mode '${schedulerMode}'. Must be 'default' or 'smart'.`);
        return 1;
      }
      hubConfig.scheduler = { ...(hubConfig.scheduler || {}), mode: schedulerMode };
      await writeHubConfig(hubRoot, hubConfig);
      console.log(`Scheduler mode set to '${schedulerMode}'.`);
      return 0;
    }

    const applied = await applyAgentUpdates(args, hubConfig, "agents", async (data) => {
      await writeHubConfig(hubRoot, data);
      console.log("Updated global agent config.");
    });
    if (applied) return 0;

    const maxActivePerProject = optionValue(args, "--max-active-per-project");
    const acpProviderMax = optionValue(args, "--acp-provider-max");
    if (maxActivePerProject !== null || acpProviderMax !== null) {
      const parsePositive = (label, value) => {
        if (value === null) return null;
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1) throw new Error(`${label} must be a positive integer.`);
        return Math.floor(n);
      };
      try {
        if (maxActivePerProject !== null) {
          hubConfig.concurrency = { ...(hubConfig.concurrency || {}) };
          const perProject = parsePositive("--max-active-per-project", maxActivePerProject);
          if (perProject !== null) hubConfig.concurrency.maxActivePerProject = perProject;
        }
        if (acpProviderMax !== null) {
          hubConfig.acpPool = { ...(hubConfig.acpPool || {}) };
          const providerMax = parsePositive("--acp-provider-max", acpProviderMax);
          if (providerMax !== null) hubConfig.acpPool.providerMax = providerMax;
        }
      } catch (err) {
        console.error(err.message);
        return 1;
      }
      await writeHubConfig(hubRoot, hubConfig);
      console.log("Updated global concurrency config.");
      return 0;
    }

    console.error("No configuration option specified. Use --agent, --*-variant, --agents, --show-concurrency, --show-scheduler, --scheduler-mode, --max-active-per-project, --acp-provider-max, or --unset-agent.");
    return 1;
  }

  // ── Project-level config ──
  const project = args.find((a) => !a.startsWith("-"));
  if (!project) {
    console.error("Usage: cpb config --hub [options]  OR  cpb config <project> [options]");
    return 1;
  }

  // Show merged agent config
  if (args.includes("--agents")) {
    const hubConfig = await readHubConfig(hubRoot);
    const projectAgents = await readProjectConfigFromRoots([hubRoot, cpbRoot], project);
    const merged = mergeAgentConfig(hubConfig.agents, projectAgents, null);
    console.log(`Agent config for project '${project}' (merged):`);
    for (const [role, spec] of Object.entries(merged)) {
      const variantTag = spec.variant ? ` variant:${spec.variant}` : "";
      console.log(`  ${role}: ${spec.agent}${variantTag}`);
    }
    console.log(`\nSource: hub config + project config`);
    return 0;
  }

  // ─── Automation config ───

  if (args.includes("--show-automation")) {
    const { getProject } = await import("../../server/services/hub-registry.js");
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
    const { getProject, updateProject } = await import("../../server/services/hub-registry.js");
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

  // ─── Project-level agent + instructions config ───
  const data = await readProjectJsonFromRoots([hubRoot, cpbRoot], project);

  if (args.includes("--show-concurrency")) {
    const maxActive = data.concurrency?.maxActivePerProject ?? data.concurrency?.maxActive;
    console.log(`Concurrency for project '${project}':`);
    console.log(`  maxActivePerProject: ${maxActive || "(default)"}`);
    return 0;
  }

  // Clear instructions
  if (args.includes("--clear-instructions")) {
    delete data.agentInstructions;
    await writeProjectJson(hubRoot, project, data);
    console.log(`Cleared agent instructions for project '${project}'.`);
    return 0;
  }

  // Unset agent overrides
  if (args.includes("--unset-agent")) {
    delete data.agents;
    await writeProjectJson(hubRoot, project, data);
    console.log(`Removed agent overrides for project '${project}'. Using registry defaults.`);
    return 0;
  }

  // Set instructions
  const instructions = optionValue(args, "--instructions");
  if (instructions) {
    data.agentInstructions = instructions;
    await writeProjectJson(hubRoot, project, data);
    console.log(`Set agent instructions for project '${project}'.`);
    return 0;
  }

  const maxActive = optionValue(args, "--max-active") ?? optionValue(args, "--max-active-per-project");
  if (maxActive !== null) {
    const value = Number(maxActive);
    if (!Number.isFinite(value) || value < 1) {
      console.error("--max-active must be a positive integer.");
      return 1;
    }
    data.concurrency = {
      ...(data.concurrency || {}),
      maxActivePerProject: Math.floor(value),
    };
    await writeProjectJson(hubRoot, project, data);
    console.log(`Set project '${project}' maxActivePerProject to ${data.concurrency.maxActivePerProject}.`);
    return 0;
  }

  // Set agent + variant overrides
  const applied = await applyAgentUpdates(args, data, "agents", async (d) => {
    await writeProjectJson(hubRoot, project, d);
    console.log(`Updated agent config for project '${project}'.`);
  });
  if (applied) return 0;

  // Set per-phase model profiles
  const planModel = optionValue(args, "--plan-model");
  const executeModel = optionValue(args, "--execute-model");
  const verifyModel = optionValue(args, "--verify-model");
  const reviewModel = optionValue(args, "--review-model");

  if (planModel || executeModel || verifyModel || reviewModel) {
    if (!data.agents) data.agents = {};
    const profiles = { ...(data.agents.phaseProfiles || {}) };
    if (planModel) profiles.plan = planModel;
    if (executeModel) profiles.execute = executeModel;
    if (verifyModel) profiles.verify = verifyModel;
    if (reviewModel) profiles.review = reviewModel;
    for (const [k, v] of Object.entries(profiles)) {
      if (!v) delete profiles[k];
    }
    data.agents.phaseProfiles = Object.keys(profiles).length > 0 ? profiles : undefined;
    await writeProjectJson(hubRoot, project, data);
    console.log(`Updated agent config for project '${project}'.`);
    return 0;
  }

  console.error("No configuration option specified. Use --agent, --*-agent, --*-variant, --*-model, --instructions, --agents, or --unset-agent.");
  return 1;
}
