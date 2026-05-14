import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const PROFILES_DIR = "profiles";
const MAX_SKILLS = 10;

function defaultProfile(role) {
  return {
    role,
    soulMd: null,
    permissions: { write_paths: [], deny_tools: [], deny_commands: false },
    agent: { command: null, args: [] },
  };
}

function parseSkill(filePath, content) {
  // Parse YAML frontmatter between first pair of ---
  const lines = content.split("\n");
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      if (start === -1) start = i;
      else { end = i; break; }
    }
  }
  if (start !== 0 || end <= start) return null;

  const fm = {};
  for (let i = start + 1; i < end; i++) {
    const m = lines[i].match(/^(\w+)\s*:\s*(.+)/);
    if (m) fm[m[1]] = m[2].trim();
  }
  if (!fm.name || !fm.description) return null;

  return { name: fm.name, description: fm.description, path: filePath };
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

  // Load skills
  const skillsDir = path.join(profileDir, "skills");
  let files = [];
  try {
    const allMd = (await readdir(skillsDir)).filter(f => f.endsWith(".md")).sort();
    if (allMd.length > MAX_SKILLS) {
      console.warn(`[profile-loader] ${role}: skills truncated to ${MAX_SKILLS}`);
    }
    files = allMd.slice(0, MAX_SKILLS);
  } catch {
    // skills/ directory missing — graceful degradation
  }

  profile.skills = [];
  for (const file of files) {
    try {
      const content = await readFile(path.join(skillsDir, file), "utf8");
      const skill = parseSkill(path.join(skillsDir, file), content);
      if (skill) profile.skills.push(skill);
      else console.warn(`[profile-loader] ${role}/${file}: missing or malformed frontmatter, skipped`);
    } catch (e) {
      console.warn(`[profile-loader] ${role}/${file}: read error: ${e.message}`);
    }
  }

  return profile;
}

export async function listProfiles(flowRoot) {
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
