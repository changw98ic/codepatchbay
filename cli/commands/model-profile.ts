import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const PROFILES_DIR_NAME = "model-profiles";

function configDir(cpbRoot) {
  return process.env.CPB_AGENTS_CONFIG_DIR || path.join(cpbRoot, "cpb-task", "agents");
}

function profilesDir(cpbRoot) {
  return path.join(configDir(cpbRoot), PROFILES_DIR_NAME);
}

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function optionValues(args, name) {
  const results = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) results.push(args[++i]);
  }
  return results;
}

async function ensureProfilesDir(cpbRoot) {
  const dir = profilesDir(cpbRoot);
  await mkdir(dir, { recursive: true });
  return dir;
}

function parseEnvPair(pair) {
  const eqIdx = pair.indexOf("=");
  if (eqIdx < 0) return null;
  const key = pair.slice(0, eqIdx).trim();
  const value = pair.slice(eqIdx + 1).trim();
  if (!key) return null;
  return { key, value };
}

// ─── add ───

async function addProfile(args, { cpbRoot }) {
  const name = optionValue(args, "--name");
  const agent = optionValue(args, "--agent") || "claude";
  const envPairs = optionValues(args, "--env");

  if (!name) {
    console.error("--name is required");
    return 1;
  }
  if (envPairs.length === 0) {
    console.error("At least one --env KEY=VALUE is required");
    return 1;
  }

  const env: Record<string, any> = {};
  for (const pair of envPairs) {
    const parsed = parseEnvPair(pair);
    if (!parsed) {
      console.error(`Invalid --env format: ${pair}. Use KEY=VALUE`);
      return 1;
    }
    env[parsed.key] = parsed.value;
  }

  const profile = {
    name,
    agent,
    env,
    createdAt: new Date().toISOString(),
  };

  const dir = await ensureProfilesDir(cpbRoot);
  const filePath = path.join(dir, `${name}.json`);
  await writeFile(filePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

  console.log(`Model profile '${name}' registered for agent '${agent}':`);
  for (const [key, value] of Object.entries(env)) {
    const display = value.startsWith("${") ? `${value} (resolved at runtime)` : value;
    console.log(`  ${key}=${display}`);
  }
  console.log(`\nUsage: cpb pipeline <project> "task" --agent ${agent} --model ${name}`);
  return 0;
}

// ─── list ───

async function listProfiles(args, { cpbRoot }) {
  const dir = profilesDir(cpbRoot);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    console.log("No model profiles configured.");
    console.log("Add one: cpb model-profile add --name kimi-k2 --agent claude --env ANTHROPIC_MODEL=kimi-k2");
    return 0;
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
  if (jsonFiles.length === 0) {
    console.log("No model profiles configured.");
    return 0;
  }

  const json = args.includes("--json");
  const profiles = [];

  for (const f of jsonFiles) {
    try {
      const raw = await readFile(path.join(dir, f), "utf8");
      const profile = JSON.parse(raw);
      if (profile && profile.name) profiles.push(profile);
    } catch {}
  }

  if (json) {
    console.log(JSON.stringify(profiles, null, 2));
    return 0;
  }

  console.log(`Found ${profiles.length} model profile(s):\n`);
  for (const p of profiles) {
    const envLines = Object.entries(p.env || {}).map(([k, v]) => `    ${k}=${v}`);
    console.log(`  ${p.name} (agent: ${p.agent || "any"})`);
    for (const line of envLines) console.log(line);
    console.log("");
  }
  return 0;
}

// ─── remove ───

async function removeProfile(args, { cpbRoot }) {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    console.error("Usage: cpb model-profile remove <name>");
    return 1;
  }

  const dir = profilesDir(cpbRoot);
  const filePath = path.join(dir, `${name}.json`);
  try {
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath);
    console.log(`Model profile '${name}' removed.`);
    return 0;
  } catch {
    console.error(`Profile '${name}' not found.`);
    return 1;
  }
}

// ─── apply (internal: resolve env vars for a profile) ───

export async function resolveModelProfileEnv(cpbRoot, profileName) {
  const dir = profilesDir(cpbRoot);
  try {
    const raw = await readFile(path.join(dir, `${profileName}.json`), "utf8");
    const profile = JSON.parse(raw);
    if (!profile || !profile.env) return {};

    // Resolve ${VAR} references to actual env var values
    const resolved = {};
    for (const [key, value] of Object.entries(profile.env)) {
      if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
        const envVarName = value.slice(2, -1);
        resolved[key] = process.env[envVarName] || "";
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  } catch {
    return {};
  }
}

// ─── main ───

export async function run(args, { cpbRoot }: Record<string, any> = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage:
  cpb model-profile add --name <name> --agent <agent> --env KEY=VALUE [--env KEY=VALUE ...]
  cpb model-profile list [--json]
  cpb model-profile remove <name>

Examples:
  cpb model-profile add --name kimi-k2 --agent claude \\
    --env ANTHROPIC_BASE_URL=https://api.kimi.ai/v1 \\
    --env ANTHROPIC_MODEL=kimi-k2 \\
    --env ANTHROPIC_API_KEY=\${KIMI_API_KEY}

  cpb model-profile add --name gpt-4o --agent opencode \\
    --env OPENAI_MODEL=gpt-4o \\
    --env OPENAI_API_KEY=\${OPENAI_API_KEY}

  cpb pipeline my-project "task" --agent claude --model kimi-k2`);
    return 0;
  }

  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();

  const subcommand = args[0];
  switch (subcommand) {
    case "add":
      return addProfile(args.slice(1), { cpbRoot });
    case "list":
      return listProfiles(args.slice(1), { cpbRoot });
    case "remove":
    case "rm":
    case "delete":
      return removeProfile(args.slice(1), { cpbRoot });
    default:
      console.error("Unknown subcommand. Use: add, list, remove");
      return 1;
  }
}
