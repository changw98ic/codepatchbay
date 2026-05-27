import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdir } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFile = promisify(execFileCb);
const TEMPLATES_DIR = path.join(import.meta.dirname, "..", "..", "core", "agents", "templates");

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function optionValues(args, name) {
  return args
    .map((a, i) => (a === name && args[i + 1] ? args[i + 1] : null))
    .filter(Boolean);
}

function configDir(cpbRoot) {
  return process.env.CPB_AGENTS_CONFIG_DIR || path.join(cpbRoot, "cpb-task", "agents");
}

function fillTemplate(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value || "");
  }
  return result;
}

function statusMark(ok) {
  return ok ? "OK" : "--";
}

function isCommandAvailable(command) {
  return execFile("which", [command])
    .then(() => true)
    .catch(() => false);
}

function envVarSet(name) {
  return name ? !!process.env[name] : true;
}

async function loadTemplate(name) {
  try {
    return await readFile(path.join(TEMPLATES_DIR, `${name}.json`), "utf8");
  } catch {
    return null;
  }
}

async function listTemplates() {
  return new Promise((resolve) => {
    readdir(TEMPLATES_DIR, (err, files) => {
      if (err) return resolve([]);
      resolve(files.filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")));
    });
  });
}

// ─── add ───

async function addProvider(args, { cpbRoot }) {
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

  const templateStr = await loadTemplate(template);
  if (!templateStr) {
    const available = await listTemplates();
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
  let descriptor;
  try {
    descriptor = JSON.parse(filled);
  } catch (e) {
    console.error(`Generated invalid JSON: ${e.message}`);
    return 1;
  }

  // Remove empty provider fields
  if (descriptor.provider) {
    for (const [k, v] of Object.entries(descriptor.provider)) {
      if (!v) delete descriptor.provider[k];
    }
    if (Object.keys(descriptor.provider).length <= 1) delete descriptor.provider;
  }

  const dir = configDir(cpbRoot);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.json`);
  await writeFile(filePath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");

  console.log(`Provider '${name}' registered at ${filePath}`);
  console.log(`  command:    ${descriptor.command}`);
  console.log(`  template:   ${template}`);
  console.log(`  roles:      ${descriptor.defaultRoles.join(", ")}`);
  console.log(`  stability:  ${descriptor.stability}`);
  return 0;
}

// ─── list ───

async function listProviders(args, { cpbRoot }) {
  const { loadRegistry, listAgents } = await import("../../core/agents/registry.js");
  await loadRegistry(configDir(cpbRoot));
  const agents = listAgents();

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

// ─── test ───

async function testProvider(args, { cpbRoot }) {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    console.error("Usage: cpb provider test <name>");
    return 1;
  }

  const { loadRegistry, getDescriptor } = await import("../../core/agents/registry.js");
  await loadRegistry();
  const descriptor = getDescriptor(name);

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

// ─── templates ───

async function listTemplatesCmd() {
  const templates = await listTemplates();
  console.log("Available provider templates:");
  for (const t of templates) {
    console.log(`  ${t}`);
  }
  console.log("");
  console.log("Usage: cpb provider add --name <name> --command <cmd> --template <template>");
  return 0;
}

// ─── main ───

export async function run(args, { cpbRoot } = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  cpb provider add --name <name> --command <cmd> [--template <tpl>] [--display-name <name>] [--description <text>] [--api-key-env <VAR>] [--base-url <url>]
  cpb provider list [--json]
  cpb provider test <name>
  cpb provider templates`);
    return 0;
  }

  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();

  const subcommand = args[0];
  switch (subcommand) {
    case "add":
      return addProvider(args.slice(1), { cpbRoot });
    case "list":
      return listProviders(args.slice(1), { cpbRoot });
    case "test":
      return testProvider(args.slice(1), { cpbRoot });
    case "templates":
      return listTemplatesCmd();
    default:
      console.error("Unknown subcommand. Use: add, list, test, templates");
      return 1;
  }
}
