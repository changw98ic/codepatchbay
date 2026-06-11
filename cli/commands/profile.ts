import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { listProfiles, loadProfile, loadProfileSkills } from "../../server/services/profile-loader.js";

function optionValue(args, name) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
}

function usage() {
  return [
    "Usage: cpb profile <list|show|use> [options]",
    "",
    "Commands:",
    "  cpb profile list [--json]",
    "  cpb profile show <role> [--json]",
    "  cpb profile use <role> --project <name>",
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

// ─── main ───

export async function run(args, { cpbRoot }: Record<string, any> = {}) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return 0;
  }

  if (!cpbRoot) cpbRoot = process.env.CPB_ROOT || process.cwd();

  const subcommand = args[0];
  switch (subcommand) {
    case "list":
      return profileList(args.slice(1), { cpbRoot });
    case "show":
      return profileShow(args.slice(1), { cpbRoot });
    case "use":
      return profileUse(args.slice(1), { cpbRoot });
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
