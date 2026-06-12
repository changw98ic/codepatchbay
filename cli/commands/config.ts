import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdir } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import nodePath from "node:path";
import {
  readHubConfig,
  writeHubConfig,
  readProjectConfigFromRoots,
  readProjectJsonFromRoots,
  writeProjectJson,
  mergeAgentConfig,
  isValidSchedulerMode,
} from "../../server/services/agent/agent-config.js";
import { resolveHubRoot } from "../../server/services/hub/hub-registry.js";

const execFile = promisify(execFileCb);
const TEMPLATES_DIR = nodePath.join(import.meta.dirname, "..", "..", "core", "agents", "templates");

type LooseRecord = Record<string, any>;

function optionValue(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

// ─── Provider helpers ───

function optionValues(args: string[], name: string) {
  return args
    .map((a, i) => (a === name && args[i + 1] ? args[i + 1] : null))
    .filter(Boolean);
}

function providerConfigDir(cpbRoot: string) {
  return process.env.CPB_AGENTS_CONFIG_DIR || nodePath.join(resolveHubRoot(cpbRoot), "agents");
}

function fillTemplate(template: string, vars: Record<string, string>) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value || "");
  }
  return result;
}

function statusMark(ok: boolean) {
  return ok ? "OK" : "--";
}

function isCommandAvailable(command: string) {
  return execFile("which", [command])
    .then(() => true)
    .catch(() => false);
}

function envVarSet(name: string) {
  return name ? !!process.env[name] : true;
}

async function loadProviderTemplate(name: string) {
  try {
    return await readFile(nodePath.join(TEMPLATES_DIR, `${name}.json`), "utf8");
  } catch {
    return null;
  }
}

async function listProviderTemplates() {
  return new Promise<string[]>((resolve) => {
    readdir(TEMPLATES_DIR, (err, files) => {
      if (err) return resolve([]);
      resolve(files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
    });
  });
}

async function addProvider(args: string[], { cpbRoot }: { cpbRoot: string }) {
  const name = optionValue(args, "--name");
  const command = optionValue(args, "--command");
  const template = optionValue(args, "--template") || "generic-cli";
  const displayName = optionValue(args, "--display-name") || name;
  const description = optionValue(args, "--description") || `${name} coding agent`;
  const apiKeyEnv = optionValue(args, "--api-key-env") || "";
  const baseUrl = optionValue(args, "--base-url") || "";
  const model = optionValue(args, "--model") || "";

  if (!name) {
    console.error("--name is required");
    return 1;
  }
  if (!command) {
    console.error("--command is required (the executable to run the agent)");
    return 1;
  }

  const templateStr = await loadProviderTemplate(template);
  if (!templateStr) {
    const available = await listProviderTemplates();
    console.error(`Unknown template: ${template}. Available: ${available.join(", ")}`);
    return 1;
  }

  const vars = {
    name,
    displayName,
    command,
    description,
    name_upper: name.toUpperCase().replace(/-/g, "_"),
    apiKeyEnv,
    baseUrl,
    model,
  };

  const filled = fillTemplate(templateStr, vars);
  let descriptor: LooseRecord;
  try {
    descriptor = JSON.parse(filled);
  } catch (e) {
    console.error(`Generated invalid JSON: ${(e as Error).message}`);
    return 1;
  }

  // Remove empty provider fields
  if (descriptor.provider) {
    for (const [k, v] of Object.entries(descriptor.provider)) {
      if (!v) delete descriptor.provider[k];
    }
    if (Object.keys(descriptor.provider).length <= 1) delete descriptor.provider;
  }

  const dir = providerConfigDir(cpbRoot);
  await mkdir(dir, { recursive: true });
  const filePath = nodePath.join(dir, `${name}.json`);
  await writeFile(filePath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");

  console.log(`Provider '${name}' registered at ${filePath}`);
  console.log(`  command:    ${descriptor.command}`);
  console.log(`  template:   ${template}`);
  console.log(`  roles:      ${descriptor.defaultRoles.join(", ")}`);
  console.log(`  stability:  ${descriptor.stability}`);
  return 0;
}

async function listProviders(args: string[], { cpbRoot }: { cpbRoot: string }) {
  const { loadRegistry, listAgents } = await import("../../core/agents/registry.js");
  await loadRegistry(providerConfigDir(cpbRoot));
  const agents = listAgents() as LooseRecord[];

  if (agents.length === 0) {
    console.log("No providers registered.");
    return 0;
  }

  const json = args.includes("--json");
  if (json) {
    console.log(JSON.stringify(agents, null, 2));
    return 0;
  }

  const header = "  STS  NAME              DISPLAY NAME             ROLES                       STABILITY";
  console.log(header);
  for (const a of agents) {
    const available = await isCommandAvailable(a.command);
    const roles = (a.defaultRoles || []).join(", ") || "none";
    const line = [
      `  ${statusMark(available)}`,
      (a.name || "").padEnd(18),
      (a.displayName || "").padEnd(25),
      roles.padEnd(28),
      a.stability || "unknown",
    ].join("  ");
    console.log(line);
  }
  console.log("");
  console.log("  STS = command found in PATH");
  return 0;
}

async function testProvider(args: string[], { cpbRoot }: { cpbRoot: string }) {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    console.error("Usage: cpb provider test <name>");
    return 1;
  }

  const { loadRegistry, getDescriptor } = await import("../../core/agents/registry.js");
  await (loadRegistry as (configDir?: string) => Promise<void>)();
  const descriptor = getDescriptor(name) as LooseRecord | null;

  if (!descriptor) {
    console.error(`Provider '${name}' not found in registry.`);
    return 1;
  }

  let passed = 0;
  let failed = 0;

  // Check 1: command in PATH
  const available = await isCommandAvailable(descriptor.command);
  if (available) {
    console.log(`  OK  command '${descriptor.command}' found in PATH`);
    passed++;
  } else {
    console.log(`  --  command '${descriptor.command}' not found in PATH`);
    failed++;
  }

  // Check 2: fallback command
  if (descriptor.fallbackCommand) {
    const fallbackAvail = await isCommandAvailable(descriptor.fallbackCommand);
    if (fallbackAvail) {
      console.log(`  OK  fallback '${descriptor.fallbackCommand}' available`);
      passed++;
    } else {
      console.log(`  --  fallback '${descriptor.fallbackCommand}' not available`);
      failed++;
    }
  }

  // Check 3: API key env var
  if (descriptor.provider?.apiKeyEnv) {
    const set = envVarSet(descriptor.provider.apiKeyEnv);
    if (set) {
      console.log(`  OK  ${descriptor.provider.apiKeyEnv} is set`);
      passed++;
    } else {
      console.log(`  --  ${descriptor.provider.apiKeyEnv} is not set`);
      failed++;
    }
  }

  // Check 4: env override
  const prefix = descriptor.envPrefix;
  if (prefix && process.env[`${prefix}_COMMAND`]) {
    console.log(`  OK  ${prefix}_COMMAND override: ${process.env[`${prefix}_COMMAND`]}`);
    passed++;
  }

  console.log("");
  console.log(`  Result: ${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

async function listTemplatesCmd() {
  const templates = await listProviderTemplates();
  console.log("Available provider templates:");
  for (const t of templates) {
    console.log(`  ${t}`);
  }
  console.log("");
  console.log("Usage: cpb provider add --name <name> --command <cmd> --template <template>");
  return 0;
}

// ─── End provider helpers ───

function parseRuleString(str: string): LooseRecord {
  const parts: LooseRecord = {};
  for (const segment of str.split(";")) {
    const eq = segment.indexOf("=");
    if (eq < 0) continue;
    const key = segment.slice(0, eq).trim();
    const val = segment.slice(eq + 1).trim();
    if (key.startsWith("match.")) {
      if (!parts.match) parts.match = {};
      const matchKey = key.slice(6);
      if (matchKey === "labels") parts.match[matchKey] = val.split(",").map((s) => s.trim());
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

function displayAgents(config: LooseRecord | null | undefined, label: string) {
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

async function applyAgentUpdates(
  args: string[],
  container: LooseRecord,
  field: string,
  onSave: (data: LooseRecord) => Promise<void>,
) {
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

export async function run(args: string[], { cpbRoot }: LooseRecord = {}) {
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
  cpb config <project> --automation-rule '<...>'   Add automation rule

Provider subcommands:
  cpb config provider add --name <name> --command <cmd> [--template <tpl>] [--display-name <name>] [--description <text>] [--api-key-env <VAR>] [--base-url <url>]
  cpb config provider list [--json]
  cpb config provider test <name>
  cpb config provider templates`);
    return 0;
  }

  // ── Provider subcommand delegation ──
  if (args[0] === "provider") {
    if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();
    const subArgs = args.slice(1);
    const sub = subArgs[0];
    switch (sub) {
      case "add":
        return addProvider(subArgs.slice(1), { cpbRoot });
      case "list":
        return listProviders(subArgs.slice(1), { cpbRoot });
      case "test":
        return testProvider(subArgs.slice(1), { cpbRoot });
      case "templates":
        return listTemplatesCmd();
      default:
        console.error("Unknown provider subcommand. Use: add, list, test, templates");
        return 1;
    }
  }

  const isHub = args.includes("--hub");
  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();
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
      const parsePositive = (label: string, value: string | null) => {
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
        console.error((err as Error).message);
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
      const typedSpec = spec as LooseRecord;
      const variantTag = typedSpec.variant ? ` variant:${typedSpec.variant}` : "";
      console.log(`  ${role}: ${typedSpec.agent}${variantTag}`);
    }
    console.log(`\nSource: hub config + project config`);
    return 0;
  }

  // ─── Automation config ───

  if (args.includes("--show-automation")) {
    const { getProject } = await import("../../server/services/hub/hub-registry.js");
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
    const { getProject, updateProject } = await import("../../server/services/hub/hub-registry.js");
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
      a.exclude.labels = excludeLabels.split(",").map((s) => s.trim()).filter(Boolean);
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
