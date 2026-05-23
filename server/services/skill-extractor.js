import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runtimeDataPath } from "./runtime-root.js";
import { appendEvent } from "./event-store.js";
import { loadProfileSkills } from "./profile-loader.js";

const PROFILES_DIR = "profiles";

function skillsDir(cpbRoot, role) {
  return path.join(cpbRoot, PROFILES_DIR, role, "skills");
}

function slugify(text) {
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
export async function extractSkillFromJob(cpbRoot, project, jobId, job) {
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
  const dir = skillsDir(cpbRoot, role);

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
export async function reviewSkill(cpbRoot, role, fileName, { approve, reviewer }) {
  const dir = skillsDir(cpbRoot, role);
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
export async function listExtractedSkills(cpbRoot, role) {
  const dir = skillsDir(cpbRoot, role);

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

    const fm = parseFrontMatter(content);
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
export async function loadActiveExtractedSkills(cpbRoot, role) {
  const all = await listExtractedSkills(cpbRoot, role);
  return all.filter((s) => s.status === "active");
}

function inferRole(job) {
  if (job.role) return job.role;
  const phases = job.completedPhases || [];
  if (phases.includes("execute")) return "executor";
  if (phases.includes("plan")) return "planner";
  if (phases.includes("verify")) return "verifier";
  return null;
}

function buildSkillContent(fm, job, isPositive) {
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

function parseFrontMatter(content) {
  const parts = content.split("---");
  if (parts.length < 3) return {};
  const fm = {};
  for (const line of parts[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

function updateFrontmatterStatus(content, newStatus, reviewer) {
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
