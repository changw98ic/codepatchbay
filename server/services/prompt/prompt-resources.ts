import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { resolveKnowledgePath } from "../knowledge/knowledge.js";

// ── profile-loader ────────────────────────────────────────────────────

const PROFILES_DIR = "profiles";
type AnyRecord = Record<string, any>;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const DEFAULT_SKILL_LIMIT = 10;
export const DEFAULT_SKILL_MAX_BYTES = 32768;

function parseFrontMatter(content: string): AnyRecord {
  const parts = content.split("---");
  if (parts.length < 3) return {};
  const fm: AnyRecord = {};
  for (const line of parts[1].split("\n")) {
    const nm = line.match(/^name:\s*(.+)/);
    if (nm) fm.name = nm[1].trim();
    const dm = line.match(/^description:\s*(.+)/);
    if (dm) fm.description = dm[1].trim();
    const tm = line.match(/^triggers?:\s*(.+)/);
    if (tm) {
      fm.triggers = tm[1].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    }
    const sm = line.match(/^status:\s*(.+)/);
    if (sm) fm.status = sm[1].trim();
  }
  return fm;
}

export async function loadProfileSkills(cpbRoot: string, role: string, options: AnyRecord = {}) {
  const maxSkills = options.maxSkills ?? DEFAULT_SKILL_LIMIT;
  const maxBytes = options.maxBytes ?? DEFAULT_SKILL_MAX_BYTES;
  const includeDrafts = options.includeDrafts ?? false;
  const skillsDir = path.join(cpbRoot, PROFILES_DIR, role, "skills");

  // Scan both root skills/ and skills/extracted/
  const dirsToScan = [skillsDir];
  const extractedDir = path.join(skillsDir, "extracted");
  // Check extracted subdirectory exists
  try {
    const extractedStat = await stat(extractedDir);
    if (extractedStat.isDirectory()) dirsToScan.push(extractedDir);
  } catch {}

  const skills: AnyRecord[] = [];
  const diagnostics: AnyRecord[] = [];

  for (const scanDir of dirsToScan) {
    let entries;
    try {
      entries = await readdir(scanDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith(".") && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    for (const fname of mdFiles) {
      const filePath = path.join(scanDir, fname);

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

      // Draft skills are skipped unless explicitly requested
      if (fm.status === "draft" && !includeDrafts) {
        diagnostics.push({ code: "draft_skipped", source: filePath });
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
        status: fm.status || "active",
        source: filePath,
        content,
      });
    }
  }

  return { skills, diagnostics };
}

export async function selectProfileSkills(cpbRoot: string, role: string, context: AnyRecord = {}, options: AnyRecord = {}) {
  const { skills } = await loadProfileSkills(cpbRoot, role, options);
  const { phase, task, artifactText } = context;
  const matchText = [task, artifactText].filter(Boolean).join(" ").toLowerCase();

  const selected: AnyRecord[] = [];

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

export async function loadProfile(cpbRoot, role, { projectWikiDir = null } = {}) {
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

  // Project-level soul.md override
  if (projectWikiDir) {
    const projectSoulPath = path.join(projectWikiDir, "profiles", role, "soul.md");
    try {
      const projectSoul = await readFile(projectSoulPath, "utf8");
      profile.soulMd = projectSoul;
    } catch {
      // No project-level override
    }
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

// ── skill-extractor ───────────────────────────────────────────────────

import { writeFile, mkdir } from "node:fs/promises";
import { runtimeDataPath } from "../runtime.js";
import { appendEvent } from "../event/event-store.js";

function skillsDirExtract(cpbRoot: string, role: string) {
  return path.join(cpbRoot, PROFILES_DIR, role, "skills");
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * Extract a skill candidate from a completed job.
 * Only extracts from jobs that completed successfully (PASS verdict).
 * Writes a DRAFT skill file and appends a skill_extracted event.
 */
export async function extractSkillFromJob(cpbRoot: string, project: string, jobId: string, job: AnyRecord) {
  const verdict = job.verdict || job.artifacts?.verdict;
  const role = inferRole(job);
  const taskSummary = job.task || job.taskDescription || `job-${jobId}`;
  const phases = job.completedPhases || [];

  if (!role || phases.length === 0) return null;

  const isPositive = verdict === "PASS" || verdict === "pass";
  const isAntiPattern = verdict === "FAIL" || verdict === "fail" || job.status === "failed" || job.status === "blocked";

  if (!isPositive && !isAntiPattern) return null;

  const slug = slugify(taskSummary);
  const fileName = `extracted-${slug}.md`;
  const dir = skillsDirExtract(cpbRoot, role);

  await mkdir(dir, { recursive: true });

  const frontmatter = {
    name: slug,
    description: isPositive
      ? `Positive pattern from ${jobId}: ${taskSummary}`
      : `Anti-pattern from ${jobId}: ${taskSummary}`,
    status: "draft",
    source: "hermes",
    jobId,
    project,
    verdict: isPositive ? "PASS" : "FAIL",
    extractedAt: new Date().toISOString(),
  };

  const content = buildSkillContent(frontmatter, job, isPositive);
  const filePath = path.join(dir, fileName);
  await writeFile(filePath, content, "utf8");

  try {
    await appendEvent(cpbRoot, project, jobId, {
      type: "skill_extracted",
      role,
      fileName,
      verdict: frontmatter.verdict,
      status: "draft",
      ts: frontmatter.extractedAt,
    });
  } catch {}

  return { role, fileName, status: "draft", isPositive, isAntiPattern };
}

/**
 * Review a draft skill — promote to active or reject.
 */
export async function reviewSkill(cpbRoot: string, role: string, fileName: string, { approve, reviewer }: AnyRecord) {
  const dir = skillsDirExtract(cpbRoot, role);
  const filePath = path.join(dir, fileName);

  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const newStatus = approve ? "active" : "rejected";
  const updated = updateFrontmatterStatus(content, newStatus, reviewer);

  await writeFile(filePath, updated, "utf8");

  return { role, fileName, status: newStatus };
}

/**
 * List all extracted (draft + active) skills for a role.
 */
export async function listExtractedSkills(cpbRoot: string, role: string) {
  const dir = skillsDirExtract(cpbRoot, role);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("extracted-") || !entry.name.endsWith(".md")) continue;

    const filePath = path.join(dir, entry.name);
    let content;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const fm: AnyRecord = parseFrontMatter(content);
    skills.push({
      fileName: entry.name,
      role,
      name: fm.name || entry.name,
      description: fm.description || "",
      status: fm.status || "draft",
      source: fm.source || "unknown",
      jobId: fm.jobId || null,
      verdict: fm.verdict || null,
      extractedAt: fm.extractedAt || null,
    });
  }

  return skills;
}

/**
 * Load only ACTIVE extracted skills for a role (for prompt injection).
 */
export async function loadActiveExtractedSkills(cpbRoot: string, role: string) {
  const all = await listExtractedSkills(cpbRoot, role);
  return all.filter((s) => s.status === "active");
}

function inferRole(job: AnyRecord) {
  if (job.role) return job.role;
  const phases = job.completedPhases || [];
  if (phases.includes("execute")) return "executor";
  if (phases.includes("plan")) return "planner";
  if (phases.includes("verify")) return "verifier";
  return null;
}

function buildSkillContent(fm: AnyRecord, job: AnyRecord, isPositive: boolean) {
  const lines = [
    "---",
    `name: ${fm.name}`,
    `description: ${fm.description}`,
    `status: ${fm.status}`,
    `source: ${fm.source}`,
    `jobId: ${fm.jobId}`,
    `project: ${fm.project}`,
    `verdict: ${fm.verdict}`,
    `extractedAt: ${fm.extractedAt}`,
    "---",
    "",
  ];

  const taskSummary = job.task || job.taskDescription || "unknown task";

  if (isPositive) {
    lines.push(`# Positive Pattern: ${taskSummary}`);
    lines.push("");
    lines.push("## Context");
    lines.push(`Project: ${fm.project}`);
    lines.push(`Phases: ${(job.completedPhases || []).join(", ")}`);
    lines.push("");
    lines.push("## Pattern");
    lines.push(`Task "${taskSummary}" was completed successfully.`);
    if (job.artifacts) {
      lines.push("");
      lines.push("## Artifacts");
      for (const [phase, artifact] of Object.entries(job.artifacts)) {
        if (artifact) lines.push(`- ${phase}: ${artifact}`);
      }
    }
  } else {
    lines.push(`# Anti-Pattern: ${taskSummary}`);
    lines.push("");
    lines.push("## Context");
    lines.push(`Project: ${fm.project}`);
    lines.push(`Status: ${job.status}`);
    if (job.error) lines.push(`Error: ${job.error}`);
    lines.push("");
    lines.push("## Failure Pattern");
    lines.push(`Task "${taskSummary}" failed or was blocked.`);
    if (job.completedPhases?.length) {
      lines.push(`Completed phases before failure: ${job.completedPhases.join(", ")}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function updateFrontmatterStatus(content: string, newStatus: string, reviewer: any) {
  const parts = content.split("---");
  if (parts.length < 3) return content;

  let fm = parts[1];
  fm = fm.replace(/status:\s*.+/, `status: ${newStatus}`);
  if (reviewer) {
    if (fm.includes("reviewedBy:")) {
      fm = fm.replace(/reviewedBy:\s*.+/, `reviewedBy: ${reviewer}`);
    } else {
      fm += `\nreviewedBy: ${reviewer}`;
    }
    fm += `\nreviewedAt: ${new Date().toISOString()}`;
  }

  parts[1] = fm;
  return parts.join("---");
}

// ── knowledge-compose ─────────────────────────────────────────────────

import fs from "node:fs/promises";
import {
  PROMPT_COMPOSITION_ORDER,
} from "../knowledge/knowledge.js";
import { isSecretPath, notifySecretBlocked } from "../secret-policy.js";

async function readFileOrNull(filePath, onSecretBlocked) {
  if (isSecretPath(filePath)) {
    notifySecretBlocked(onSecretBlocked, filePath, "secret path read blocked");
    return null;
  }
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function writePolicyForLayer(layerName) {
  const explicit = new Set(["global-soul-profile", "global-provider-runtime-policy"]);
  if (explicit.has(layerName)) return "explicit-confirmation";
  const semi = new Set(["project-memory", "project-wiki-excerpts", "project-context"]);
  if (semi.has(layerName)) return "semi-automatic";
  if (layerName === "session-memory") return "automatic";
  if (layerName === "current-task") return "automatic";
  return "unknown";
}

async function resolveLayerContent(layerName, { hubRoot, sourcePath, dataRoot, projectRuntimeRoot, sessionId, profile, task, onSecretBlocked }) {
  const hub = path.resolve(hubRoot);
  const src = path.resolve(sourcePath);

  switch (layerName) {
    case "global-soul-profile": {
      const soulPath = path.join(hub, "profiles", profile || "default", "soul.md");
      return { content: await readFileOrNull(soulPath, onSecretBlocked), source: "file" };
    }
    case "global-provider-runtime-policy": {
      const policyPath = path.join(hub, "providers", "policy.md");
      return { content: await readFileOrNull(policyPath, onSecretBlocked), source: "file" };
    }
    case "project-context": {
      const ctxPath = path.join(src, ".cpb", "context.md");
      return { content: await readFileOrNull(ctxPath, onSecretBlocked), source: "file" };
    }
    case "project-wiki-excerpts": {
      const wikiFiles = ["overview.md", "architecture.md", "conventions.md", "workflows.md"];
      const parts = [];
      for (const f of wikiFiles) {
        const c = await readFileOrNull(path.join(src, ".cpb", "wiki", f), onSecretBlocked);
        if (c) parts.push(`### ${f}\n${c}`);
      }
      return { content: parts.length ? parts.join("\n\n") : null, source: "file" };
    }
    case "project-memory": {
      const memPath = path.join(src, ".cpb", "memory.md");
      return { content: await readFileOrNull(memPath, onSecretBlocked), source: "file" };
    }
    case "session-memory": {
      const sessMemPath = resolveKnowledgePath({
        sourcePath,
        dataRoot,
        projectRuntimeRoot,
        kind: "session-memory",
        sessionId,
        name: "memory",
      });
      return { content: await readFileOrNull(sessMemPath, onSecretBlocked), source: "file" };
    }
    case "current-task": {
      return { content: task || null, source: "inline" };
    }
    default:
      return { content: null, source: "unknown" };
  }
}

export async function composePromptContext({ hubRoot, sourcePath, dataRoot, projectRuntimeRoot, sessionId, task, profile, onSecretBlocked }: Record<string, any> = {}) {
  const layers = [];

  for (const layerName of PROMPT_COMPOSITION_ORDER) {
    const { content, source } = await resolveLayerContent(layerName, {
      hubRoot,
      sourcePath,
      dataRoot,
      projectRuntimeRoot,
      sessionId,
      task,
      profile,
      onSecretBlocked,
    });
    layers.push({
      name: layerName,
      content,
      source,
      writePolicy: writePolicyForLayer(layerName),
    });
  }

  const assembled = layers
    .filter((l) => l.content !== null)
    .map((l) => `## ${l.name}\n${l.content}`)
    .join("\n\n");

  return { layers, assembled };
}
