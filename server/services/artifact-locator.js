import { access, stat } from "node:fs/promises";
import path from "node:path";
import { projectRuntimePath } from "./runtime-root.js";

export { buildArtifactIndex } from "./artifact-index.js";
export { allocateArtifactId } from "../../core/artifacts/canonical-artifact.js";

const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

function validateName(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

// --- Legacy path helpers (backward compat) ---

export function planFilePath(cpbRoot, project, planId) {
  return path.join(cpbRoot, "wiki", "projects", project, "inbox", `plan-${planId}.md`);
}

export function deliverableFilePath(cpbRoot, project, deliverableId) {
  return path.join(cpbRoot, "wiki", "projects", project, "outputs", `deliverable-${deliverableId}.md`);
}

export function verdictFilePath(cpbRoot, project, artifactId) {
  return path.join(cpbRoot, "wiki", "projects", project, "outputs", `verdict-${artifactId}.md`);
}

export function reviewFilePath(cpbRoot, project, deliverableId) {
  return path.join(cpbRoot, "wiki", "projects", project, "outputs", `review-${deliverableId}.md`);
}

export function repairFilePath(cpbRoot, project, jobId) {
  return path.join(cpbRoot, "wiki", "projects", project, "outputs", `repair-${jobId}.md`);
}

export function wikiLogPath(cpbRoot, project) {
  return path.join(cpbRoot, "wiki", "projects", project, "log.md");
}

export function dashboardPath(cpbRoot) {
  return path.join(cpbRoot, "wiki", "system", "dashboard.md");
}

// --- Runtime root path helpers (issue #26) ---

export function runtimeWikiDir(hubRoot, projectId) {
  validateName(projectId, "projectId");
  return projectRuntimePath(hubRoot, projectId, "wiki");
}

export function runtimeInboxDir(hubRoot, projectId) {
  return path.join(runtimeWikiDir(hubRoot, projectId), "inbox");
}

export function runtimeOutputsDir(hubRoot, projectId) {
  return path.join(runtimeWikiDir(hubRoot, projectId), "outputs");
}

export function legacyWikiDir(cpbRoot, projectId) {
  validateName(projectId, "projectId");
  return path.join(path.resolve(cpbRoot), "wiki", "projects", projectId);
}

export function legacyInboxDir(cpbRoot, projectId) {
  return path.join(legacyWikiDir(cpbRoot, projectId), "inbox");
}

export function legacyOutputsDir(cpbRoot, projectId) {
  return path.join(legacyWikiDir(cpbRoot, projectId), "outputs");
}

async function dirExists(dirPath) {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

function hasHubRoot(hubRoot) {
  return typeof hubRoot === "string" && hubRoot.trim().length > 0;
}

export async function resolveWikiDir(hubRoot, cpbRoot, projectId) {
  if (hasHubRoot(hubRoot)) {
    const rtDir = runtimeWikiDir(hubRoot, projectId);
    if (await dirExists(rtDir)) return rtDir;
  }
  const legDir = legacyWikiDir(cpbRoot, projectId);
  if (await dirExists(legDir)) return legDir;
  return hasHubRoot(hubRoot) ? runtimeWikiDir(hubRoot, projectId) : legDir;
}

export async function resolveInboxDir(hubRoot, cpbRoot, projectId) {
  if (hasHubRoot(hubRoot)) {
    const rtDir = runtimeInboxDir(hubRoot, projectId);
    if (await dirExists(rtDir)) return rtDir;
  }
  const legDir = legacyInboxDir(cpbRoot, projectId);
  if (await dirExists(legDir)) return legDir;
  return hasHubRoot(hubRoot) ? runtimeInboxDir(hubRoot, projectId) : legDir;
}

export async function resolveOutputsDir(hubRoot, cpbRoot, projectId) {
  if (hasHubRoot(hubRoot)) {
    const rtDir = runtimeOutputsDir(hubRoot, projectId);
    if (await dirExists(rtDir)) return rtDir;
  }
  const legDir = legacyOutputsDir(cpbRoot, projectId);
  if (await dirExists(legDir)) return legDir;
  return hasHubRoot(hubRoot) ? runtimeOutputsDir(hubRoot, projectId) : legDir;
}

function validateRelativePath(relativePath) {
  if (String(relativePath).includes("\0")) {
    throw new Error("relative path traversal denied");
  }
  const normalized = path.normalize(relativePath);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error("relative path traversal denied");
  }
  return normalized;
}

export function runtimeArtifactPath(hubRoot, projectId, relativePath) {
  const normalized = validateRelativePath(relativePath);
  return path.join(runtimeWikiDir(hubRoot, projectId), normalized);
}

export function legacyArtifactPath(cpbRoot, projectId, relativePath) {
  const normalized = validateRelativePath(relativePath);
  return path.join(legacyWikiDir(cpbRoot, projectId), normalized);
}

export async function resolveArtifactPath(hubRoot, cpbRoot, projectId, relativePath) {
  if (hasHubRoot(hubRoot)) {
    const rtPath = runtimeArtifactPath(hubRoot, projectId, relativePath);
    try {
      await access(rtPath);
      return rtPath;
    } catch {}
  }
  return legacyArtifactPath(cpbRoot, projectId, relativePath);
}

// --- Runtime-aware artifact writers ---

export async function runtimePlanFilePath(hubRoot, cpbRoot, project, planId) {
  const dir = await resolveInboxDir(hubRoot, cpbRoot, project);
  return path.join(dir, `plan-${planId}.md`);
}

export async function runtimeDeliverableFilePath(hubRoot, cpbRoot, project, deliverableId) {
  const dir = await resolveOutputsDir(hubRoot, cpbRoot, project);
  return path.join(dir, `deliverable-${deliverableId}.md`);
}

export async function runtimeVerdictFilePath(hubRoot, cpbRoot, project, artifactId) {
  const dir = await resolveOutputsDir(hubRoot, cpbRoot, project);
  return path.join(dir, `verdict-${artifactId}.md`);
}

export async function runtimeWikiLogPath(hubRoot, cpbRoot, project) {
  const dir = await resolveWikiDir(hubRoot, cpbRoot, project);
  return path.join(dir, "log.md");
}
