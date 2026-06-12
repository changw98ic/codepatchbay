import { readFile, writeFile, mkdir, stat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { listProfiles, loadProfile, loadProfileSkills } from "../../server/services/prompt/prompt-resources.js";
import { resolveHubRoot } from "../../server/services/hub/hub-registry.js";

const MODEL_PROFILES_DIR_NAME = "model-profiles";

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function optionValues(args, name) {
  const results: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) results.push(args[++i]);
  }
  return results;
}

function modelProfilesDir(cpbRoot) {
  const configDir = process.env.CPB_AGENTS_CONFIG_DIR || path.join(resolveHubRoot(cpbRoot), "agents");
  return path.join(configDir, MODEL_PROFILES_DIR_NAME);
}

async function ensureModelProfilesDir(cpbRoot) {
  const dir = modelProfilesDir(cpbRoot);
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

function usage() {
  return [
    "Usage: cpb profile <list|show|use|add|remove> [options]",
    "",
    "Commands:",
    "  cpb profile list [--json]                      List agent profiles",
    "  cpb profile show <role> [--json]               Show profile details",
    "  cpb profile use <role> --project <name>        Bind profile to project",
    "  cpb profile add --name <n> --agent <a> --env K=V  Add model profile",
    "  cpb profile remove <name>                      Remove model profile",
  ].join("\n");
}

// ─── list ───

async function profileList(args, { cpbRoot }) {
  const roles = await listProfiles(cpbRoot);
  if (roles.length === 0) {
    console.log("No profiles found.");
    return 0;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(roles, null, 2));
    return 0;
  }

  for (const role of roles) {
    const profile = await loadProfile(cpbRoot, role);
    const desc = profile.soulMd
      ? profile.soulMd.split("\n").find((l) => l.startsWith("> "))?.slice(2) || ""
      : "";
    console.log(`${role}\t${desc}`);
  }
  return 0;
}

// ─── show ───

async function profileShow(args, { cpbRoot }) {
  const role = args.find((a) => !a.startsWith("-"));
  if (!role) {
    console.error("Usage: cpb profile show <role>");
    return 1;
  }

  const profile = await loadProfile(cpbRoot, role);
  if (!profile.soulMd && !profile.agent.command) {
    console.error(`Profile '${role}' not found or has no config.`);
    return 1;
  }

  const { skills } = await loadProfileSkills(cpbRoot, role);
  const output = {
    role: profile.role,
    agent: profile.agent,
    permissions: profile.permissions,
    acp: profile.acp,
    skills: skills.map((s) => s.name),
    subagentGuidance: profile.subagentGuidance,
  };

  if (args.includes("--json")) {
    console.log(JSON.stringify(output, null, 2));
    return 0;
  }

  console.log(`Role: ${output.role}`);
  console.log(`Agent: ${output.agent.command || "(none)"} ${(output.agent.args || []).join(" ")}`.trim());
  console.log(`ACP profile: ${output.acp.profile}`);
  console.log(`Permissions:`);
  console.log(`  write_paths: ${output.permissions.write_paths.join(", ") || "(none)"}`);
  console.log(`  deny_tools: ${output.permissions.deny_tools.join(", ") || "(none)"}`);
  console.log(`  deny_commands: ${output.permissions.deny_commands}`);
  console.log(`Skills (${output.skills.length}): ${output.skills.join(", ") || "(none)"}`);
  if (output.subagentGuidance) {
    console.log(`Subagent guidance: ${output.subagentGuidance}`);
  }
  return 0;
}

// ─── use ───

async function profileUse(args, { cpbRoot }) {
  const role = args.find((a) => !a.startsWith("-"));
  const project = optionValue(args, "--project");

  if (!role) {
    console.error("Usage: cpb profile use <role> --project <name>");
    return 1;
  }
  if (!project) {
    console.error("--project is required");
    return 1;
  }

  // Verify profile exists
  const profileDir = path.join(cpbRoot, "profiles", role);
  try {
    const s = await stat(profileDir);
    if (!s.isDirectory()) throw new Error("not a dir");
  } catch {
    console.error(`Profile '${role}' not found.`);
    return 1;
  }

  // Verify project exists (check wiki project dir)
  const wikiProjectDir = path.join(cpbRoot, "wiki", "projects", project);
  try {
    const s = await stat(wikiProjectDir);
    if (!s.isDirectory()) throw new Error("not a dir");
  } catch {
    console.error(`Project '${project}' not found.`);
    return 1;
  }

  // Read the profile's soul.md
  const soulPath = path.join(profileDir, "soul.md");
  let soulContent;
  try {
    soulContent = await readFile(soulPath, "utf8");
  } catch {
    console.error(`Profile '${role}' has no soul.md to copy.`);
    return 1;
  }

  // Write override to wiki/projects/{project}/profiles/{role}/soul.md
  const overrideDir = path.join(wikiProjectDir, "profiles", role);
  await mkdir(overrideDir, { recursive: true });
  const overridePath = path.join(overrideDir, "soul.md");
  await writeFile(overridePath, soulContent, "utf8");

  console.log(`Profile '${role}' bound to project '${project}'.`);
  console.log(`Override written to: ${overridePath}`);
  return 0;
}

// ─── model-profile: add ───

async function modelProfileAdd(args, { cpbRoot }) {
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

  const env: Record<string, string> = {};
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

  const dir = await ensureModelProfilesDir(cpbRoot);
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

// ─── model-profile: list (integrated into profileList above via --models flag) ───

async function modelProfileList(args, { cpbRoot }) {
  const dir = modelProfilesDir(cpbRoot);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    console.log("No model profiles configured.");
    console.log("Add one: cpb profile add --name kimi-k2 --agent claude --env ANTHROPIC_MODEL=kimi-k2");
    return 0;
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
  if (jsonFiles.length === 0) {
    console.log("No model profiles configured.");
    return 0;
  }

  const profiles = [];
  for (const f of jsonFiles) {
    try {
      const raw = await readFile(path.join(dir, f), "utf8");
      const profile = JSON.parse(raw);
      if (profile && profile.name) profiles.push(profile);
    } catch {}
  }

  if (args.includes("--json")) {
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

// ─── model-profile: remove ───

async function modelProfileRemove(args, { cpbRoot }) {
  const name = args.find((a) => !a.startsWith("-"));
  if (!name) {
    console.error("Usage: cpb profile remove <name>");
    return 1;
  }

  const dir = modelProfilesDir(cpbRoot);
  const filePath = path.join(dir, `${name}.json`);
  try {
    await unlink(filePath);
    console.log(`Model profile '${name}' removed.`);
    return 0;
  } catch {
    console.error(`Profile '${name}' not found.`);
    return 1;
  }
}

// ─── model-profile: resolve env (exported for pipeline use) ───

export async function resolveModelProfileEnv(cpbRoot, profileName) {
  const dir = modelProfilesDir(cpbRoot);
  try {
    const raw = await readFile(path.join(dir, `${profileName}.json`), "utf8");
    const profile = JSON.parse(raw) as { name?: string; env?: Record<string, string> };
    if (!profile || !profile.env) return {};

    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(profile.env)) {
      if (typeof value === "string" && value.startsWith("${") && value.endsWith("}")) {
        const envVarName = value.slice(2, -1);
        resolved[key] = process.env[envVarName] || "";
      } else {
        resolved[key] = value as string;
      }
    }
    return resolved;
  } catch {
    return {};
  }
}

// ─── main ───

export async function run(args, { cpbRoot, command }: Record<string, any> = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();

  // When invoked as `cpb model-profile`, all subcommands are model-profile operations
  if (command === "model-profile") {
    const sub = args[0];
    switch (sub) {
      case "add":
        return modelProfileAdd(args.slice(1), { cpbRoot });
      case "list":
        return modelProfileList(args.slice(1), { cpbRoot });
      case "remove":
      case "rm":
      case "delete":
        return modelProfileRemove(args.slice(1), { cpbRoot });
      default:
        console.error("Unknown subcommand. Use: add, list, remove");
        return 1;
    }
  }

  // When invoked as `cpb profile`
  const subcommand = args[0];
  switch (subcommand) {
    case "list":
      return profileList(args.slice(1), { cpbRoot });
    case "show":
      return profileShow(args.slice(1), { cpbRoot });
    case "use":
      return profileUse(args.slice(1), { cpbRoot });
    case "add":
      return modelProfileAdd(args.slice(1), { cpbRoot });
    case "remove":
      return modelProfileRemove(args.slice(1), { cpbRoot });
    default:
      console.error(usage());
      return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2))
    .then((code) => {
      if (Number.isInteger(code)) process.exitCode = code;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
