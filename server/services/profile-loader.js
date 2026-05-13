import { readFile } from "node:fs/promises";
import path from "node:path";

const PROFILES_DIR = "profiles";

function defaultProfile(role) {
  return {
    role,
    soulMd: null,
    permissions: { write_paths: [], deny_tools: [], deny_commands: false },
    agent: { command: null, args: [] },
  };
}

export async function loadProfile(flowRoot, role) {
  const profileDir = path.join(flowRoot, PROFILES_DIR, role);
  const profile = defaultProfile(role);

  // Load soul.md
  try {
    profile.soulMd = await readFile(path.join(profileDir, "soul.md"), "utf8");
  } catch {
    // soul.md is optional
  }

  // Load config.json
  try {
    const raw = await readFile(path.join(profileDir, "config.json"), "utf8");
    const config = JSON.parse(raw);
    if (config.permissions) {
      profile.permissions = {
        write_paths: config.permissions.write_paths ?? [],
        deny_tools: config.permissions.deny_tools ?? [],
        deny_commands: config.permissions.deny_commands ?? false,
      };
    }
    if (config.agent) {
      profile.agent = {
        command: config.agent.command ?? null,
        args: config.agent.args ?? [],
      };
    }
  } catch {
    // config.json is optional
  }

  return profile;
}

export async function listProfiles(flowRoot) {
  const { readdir } = await import("node:fs/promises");
  const profilesPath = path.join(flowRoot, PROFILES_DIR);
  let entries;
  try {
    entries = await readdir(profilesPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const profiles = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("_")) {
      profiles.push(entry.name);
    }
  }
  return profiles;
}
