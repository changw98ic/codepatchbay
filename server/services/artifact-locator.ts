import { mkdir, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { projectRuntimePath } from "./runtime.js";

export { buildArtifactIndex } from "./job/job-projection.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function validateName(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

export async function allocateArtifactId(dir: string, prefix: string) {
  validateName(prefix, "prefix");
  await mkdir(dir, { recursive: true });

  const lockDir = path.join(dir, ".cpb-id.lock");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!acquired) {
    try { await mkdir(lockDir); } catch { /* force through stale lock */ }
  }

  try {
    const entries = await readdir(dir);
    const pattern = new RegExp(`^${prefix}-(\\d+)\\.md$`);
    let last = 0;
    for (const entry of entries) {
      const match = entry.match(pattern);
      if (match) last = Math.max(last, parseInt(match[1], 10));
    }
    const newId = String(last + 1).padStart(3, "0");
    // Placeholder to prevent collision while holding lock
    await writeFile(path.join(dir, `${prefix}-${newId}.md`), "", "utf8");
    return newId;
  } finally {
    try {
      const { rmdir } = await import("node:fs/promises");
      await rmdir(lockDir);
    } catch {}
  }
}

// --- Wiki artifact path helpers ---

export function planFilePath(cpbRoot: string, project: string, planId: string) {
  return path.join(cpbRoot, "wiki", "projects", project, "inbox", `plan-${planId}.md`);
}

export function deliverableFilePath(cpbRoot: string, project: string, deliverableId: string) {
  return path.join(cpbRoot, "wiki", "projects", project, "outputs", `deliverable-${deliverableId}.md`);
}

export function verdictFilePath(cpbRoot: string, project: string, artifactId: string) {
  return path.join(cpbRoot, "wiki", "projects", project, "outputs", `verdict-${artifactId}.md`);
}

export function reviewFilePath(cpbRoot: string, project: string, deliverableId: string) {
  return path.join(cpbRoot, "wiki", "projects", project, "outputs", `review-${deliverableId}.md`);
}

export function remediationFilePath(cpbRoot: string, project: string, jobId: string) {
  return path.join(cpbRoot, "wiki", "projects", project, "outputs", `remediation-${jobId}.md`);
}

export function wikiLogPath(cpbRoot: string, project: string) {
  return path.join(cpbRoot, "wiki", "projects", project, "log.md");
}

export function dashboardPath(cpbRoot: string) {
  return path.join(cpbRoot, "wiki", "system", "dashboard.md");
}

// --- Runtime root path helpers (issue #26) ---

export function runtimeWikiDir(hubRoot: string, projectId: string) {
  validateName(projectId, "projectId");
  return projectRuntimePath(hubRoot, projectId, "wiki");
}

export function runtimeInboxDir(hubRoot: string, projectId: string) {
  return path.join(runtimeWikiDir(hubRoot, projectId), "inbox");
}

export function runtimeOutputsDir(hubRoot: string, projectId: string) {
  return path.join(runtimeWikiDir(hubRoot, projectId), "outputs");
}

export function legacyWikiDir(cpbRoot: string, projectId: string) {
  validateName(projectId, "projectId");
  return path.join(path.resolve(cpbRoot), "wiki", "projects", projectId);
}

export function legacyInboxDir(cpbRoot: string, projectId: string) {
  return path.join(legacyWikiDir(cpbRoot, projectId), "inbox");
}

export function legacyOutputsDir(cpbRoot: string, projectId: string) {
  return path.join(legacyWikiDir(cpbRoot, projectId), "outputs");
}

async function dirExists(dirPath: string) {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function hasHubRoot(hubRoot: unknown) {
  return typeof hubRoot === "string" && hubRoot.trim().length > 0;
}

export async function resolveWikiDir(hubRoot: unknown, cpbRoot: string, projectId: string) {
  if (hasHubRoot(hubRoot)) {
    return runtimeWikiDir(hubRoot as string, projectId);
  }
  const legDir = legacyWikiDir(cpbRoot, projectId);
  if (await dirExists(legDir)) return legDir;
  return legDir;
}

export async function resolveInboxDir(hubRoot: unknown, cpbRoot: string, projectId: string) {
  if (hasHubRoot(hubRoot)) {
    return runtimeInboxDir(hubRoot as string, projectId);
  }
  const legDir = legacyInboxDir(cpbRoot, projectId);
  if (await dirExists(legDir)) return legDir;
  return legDir;
}

export async function resolveOutputsDir(hubRoot: unknown, cpbRoot: string, projectId: string) {
  if (hasHubRoot(hubRoot)) {
    return runtimeOutputsDir(hubRoot as string, projectId);
  }
  const legDir = legacyOutputsDir(cpbRoot, projectId);
  if (await dirExists(legDir)) return legDir;
  return legDir;
}

function validateRelativePath(relativePath: string) {
  if (String(relativePath).includes("\0")) {
    throw new Error("relative path traversal denied");
  }
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("relative path traversal denied");
  }
  return normalized;
}

export function runtimeArtifactPath(hubRoot: string, projectId: string, relativePath: string) {
  const normalized = validateRelativePath(relativePath);
  return path.join(runtimeWikiDir(hubRoot, projectId), normalized);
}

export function legacyArtifactPath(cpbRoot: string, projectId: string, relativePath: string) {
  const normalized = validateRelativePath(relativePath);
  return path.join(legacyWikiDir(cpbRoot, projectId), normalized);
}

export async function resolveArtifactPath(hubRoot: unknown, cpbRoot: string, projectId: string, relativePath: string) {
  if (hasHubRoot(hubRoot)) {
    return runtimeArtifactPath(hubRoot as string, projectId, relativePath);
  }
  return legacyArtifactPath(cpbRoot, projectId, relativePath);
}

// --- Runtime-aware artifact writers ---

export async function runtimePlanFilePath(hubRoot: unknown, cpbRoot: string, project: string, planId: string) {
  const dir = await resolveInboxDir(hubRoot, cpbRoot, project);
  return path.join(dir, `plan-${planId}.md`);
}

export async function runtimeDeliverableFilePath(hubRoot: unknown, cpbRoot: string, project: string, deliverableId: string) {
  const dir = await resolveOutputsDir(hubRoot, cpbRoot, project);
  return path.join(dir, `deliverable-${deliverableId}.md`);
}

export async function runtimeVerdictFilePath(hubRoot: unknown, cpbRoot: string, project: string, artifactId: string) {
  const dir = await resolveOutputsDir(hubRoot, cpbRoot, project);
  return path.join(dir, `verdict-${artifactId}.md`);
}

export async function runtimeWikiLogPath(hubRoot: unknown, cpbRoot: string, project: string) {
  const dir = await resolveWikiDir(hubRoot, cpbRoot, project);
  return path.join(dir, "log.md");
}
