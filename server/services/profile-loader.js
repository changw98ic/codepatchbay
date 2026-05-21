import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const PROFILES_DIR = "profiles";

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const DEFAULT_SKILL_LIMIT = 10;
export const DEFAULT_SKILL_MAX_BYTES = 32768;

function parseFrontMatter(content) {
  const parts = content.split("---");
  if (parts.length < 3) return {};
  const fm = {};
  for (const line of parts[1].split("\n")) {
    const nm = line.match(/^name:\s*(.+)/);
    if (nm) fm.name = nm[1].trim();
    const dm = line.match(/^description:\s*(.+)/);
    if (dm) fm.description = dm[1].trim();
    const tm = line.match(/^triggers?:\s*(.+)/);
    if (tm) {
      fm.triggers = tm[1].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
  }
  return fm;
}

export async function loadProfileSkills(cpbRoot, role, options = {}) {
  const maxSkills = options.maxSkills ?? DEFAULT_SKILL_LIMIT;
  const maxBytes = options.maxBytes ?? DEFAULT_SKILL_MAX_BYTES;
  const skillsDir = path.join(cpbRoot, PROFILES_DIR, role, "skills");

  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return { skills: [], diagnostics: [] };
  }

  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith(".") && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const skills = [];
  const diagnostics = [];

  for (const fname of mdFiles) {
    const filePath = path.join(skillsDir, fname);

    let fstat;
    try {
      fstat = await stat(filePath);
    } catch {
      diagnostics.push({ code: "unreadable_skill", source: filePath });
      continue;
    }
    if (fstat.size > maxBytes) {
      diagnostics.push({ code: "size_limit", source: filePath });
      continue;
    }

    let content;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      diagnostics.push({ code: "unreadable_skill", source: filePath });
      continue;
    }

    const fm = parseFrontMatter(content);
    if (!fm.name) {
      diagnostics.push({ code: "malformed_skill", source: filePath });
      continue;
    }

    if (skills.length >= maxSkills) {
      diagnostics.push({ code: "skill_limit", source: filePath });
      continue;
    }

    skills.push({
      name: fm.name,
      description: fm.description || "",
      triggers: fm.triggers || [],
      source: filePath,
      content,
    });
  }

  return { skills, diagnostics };
}

export async function selectProfileSkills(cpbRoot, role, context = {}, options = {}) {
  const { skills } = await loadProfileSkills(cpbRoot, role, options);
  const { phase, task, artifactText } = context;
  const matchText = [task, artifactText].filter(Boolean).join(" ").toLowerCase();

  const selected = [];

  for (const skill of skills) {
    const nameLower = skill.name.toLowerCase();
    let reason = null;

    if (phase && (nameLower === phase.toLowerCase() || skill.triggers.includes(phase.toLowerCase()))) {
      reason = `phase:${phase}`;
    }

    if (!reason && matchText) {
      const tokenRe = new RegExp(`[/|$]${escapeRegex(nameLower)}(?![a-zA-Z0-9_])`, "i");
      if (tokenRe.test(matchText)) {
        reason = `task:/${skill.name}`;
      }
    }

    if (!reason && skill.triggers.length > 0 && matchText) {
      for (const trigger of skill.triggers) {
        const triggerRe = new RegExp(`\\b${escapeRegex(trigger)}\\b`, "i");
        if (triggerRe.test(matchText)) {
          reason = `task:trigger:${trigger}`;
          break;
        }
      }
    }

    if (reason) {
      selected.push({ ...skill, reason });
    }
  }

  return selected;
}

function defaultProfile(role) {
  return {
    role,
    soulMd: null,
    permissions: { write_paths: [], deny_tools: [], deny_commands: false },
    agent: { command: null, args: [] },
    subagentGuidance: null,
    acp: { profile: "headless", uiLane: false, uiLaneReason: "" },
  };
}

export async function loadProfile(cpbRoot, role) {
  const profileDir = path.join(cpbRoot, PROFILES_DIR, role);
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
    if (config.subagentGuidance) {
      profile.subagentGuidance = config.subagentGuidance;
    }
    if (config.acp) {
      profile.acp = {
        profile: config.acp.profile || "headless",
        uiLane: Boolean(config.acp.uiLane),
        uiLaneReason: config.acp.uiLaneReason || "",
      };
    }
  } catch {
    // config.json is optional
  }

  return profile;
}

export async function listProfiles(cpbRoot) {
  const { readdir } = await import("node:fs/promises");
  const profilesPath = path.join(cpbRoot, PROFILES_DIR);
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
