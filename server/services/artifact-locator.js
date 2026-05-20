import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

function validateName(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

export async function allocateArtifactId(dir, prefix) {
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
