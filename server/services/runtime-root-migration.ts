#!/usr/bin/env node

import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, registryPath, resolveHubRoot } from "./hub/hub-registry.js";
import { rebuildJobsIndex } from "./job/job-store.js";
import { projectRuntimeRoot, runtimeDataPath } from "./runtime.js";

type MigrationOptions = {
  dryRun?: boolean;
  quarantineNonCodePatchbay?: boolean;
  quarantineNonFlow?: boolean;
};

type RegistryProject = {
  id: string;
  projectRuntimeRoot?: string;
};

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(file) {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
}

function rel(root, file) {
  return path.relative(root, file) || ".";
}

async function sameFile(a, b) {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)]);
    return left.equals(right);
  } catch {
    return false;
  }
}

async function listFiles(root, base = root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, base));
    } else if (entry.isFile()) {
      files.push(path.relative(base, fullPath));
    }
  }
  return files.sort();
}

async function listProjectDirs(root, skipNames = new Set<string>()) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !skipNames.has(name))
    .sort();
}

function registryProjectsById(registry) {
  return registry?.projects && typeof registry.projects === "object" && !Array.isArray(registry.projects)
    ? registry.projects as Record<string, RegistryProject>
    : {};
}

async function loadRequiredRegistry(hubRoot: string) {
  const file = registryPath(hubRoot);
  if (!await exists(file)) {
    throw new Error(`Hub registry required for runtime root migration: ${file}`);
  }
  return loadRegistry(hubRoot);
}

function assertInsideRoot(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`migration target escapes runtime root: ${target}`);
  }
}

function projectRuntimeRootFromRegistry(hubRoot: string, projectsById: Record<string, RegistryProject>, projectId: string) {
  const project = projectsById[projectId];
  if (!project?.projectRuntimeRoot) {
    throw new Error(`project runtime root required for registered project: ${projectId}`);
  }
  const expectedRoot = projectRuntimeRoot(hubRoot, projectId);
  const registeredRoot = path.resolve(project.projectRuntimeRoot);
  if (registeredRoot !== expectedRoot) {
    throw new Error(`invalid projectRuntimeRoot for ${projectId}: must be ${expectedRoot}`);
  }
  return expectedRoot;
}

async function copyOne(root, src, dest, report, dryRun, allowedDestRoot = null) {
  if (allowedDestRoot) assertInsideRoot(allowedDestRoot, dest);
  if (await exists(dest)) {
    if (await sameFile(src, dest)) {
      report.skipped.push(`${rel(root, src)} -> ${rel(root, dest)} (already current)`);
      return true;
    }
    report.conflicts.push(`${rel(root, src)} -> ${rel(root, dest)}`);
    return false;
  }

  if (!dryRun) {
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }
  report.copied.push(`${rel(root, src)} -> ${rel(root, dest)}`);
  return true;
}

async function migrateTree(root, src, dest, report, dryRun, allowedDestRoot = null) {
  if (allowedDestRoot) assertInsideRoot(allowedDestRoot, dest);
  if (!await isDirectory(src)) {
    report.missing.push(rel(root, src));
    return;
  }

  const files = await listFiles(src);
  let clean = true;
  for (const file of files) {
    const ok = await copyOne(root, path.join(src, file), path.join(dest, file), report, dryRun, allowedDestRoot);
    clean &&= ok;
  }

  if (clean && !dryRun) {
    await rm(src, { recursive: true, force: true });
    report.deleted.push(rel(root, src));
  } else if (clean && dryRun) {
    report.wouldDelete.push(rel(root, src));
  } else {
    report.retained.push(`${rel(root, src)} (conflicts require manual review)`);
  }
}

async function migratePipelineState(root, report, dryRun) {
  const srcDir = path.join(root, ".omc", "state");
  if (!await isDirectory(srcDir)) {
    report.missing.push(rel(root, srcDir));
    return;
  }

  const entries = await readdir(srcDir, { withFileTypes: true });
  const pipelineFiles = entries
    .filter((entry) => entry.isFile() && /^pipeline-.+\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const name of pipelineFiles) {
    const src = path.join(srcDir, name);
    const dest = runtimeDataPath(root, "state", name);
    if (await copyOne(root, src, dest, report, dryRun)) {
      if (!dryRun) {
        await rm(src, { force: true });
        report.deleted.push(rel(root, src));
      } else {
        report.wouldDelete.push(rel(root, src));
      }
    }
  }

  await removeIfEmptyOrOnlyGitignore(root, srcDir, report, dryRun);
}

async function removeIfEmptyOrOnlyGitignore(root, dir, report, dryRun) {
  if (!await isDirectory(dir)) return;
  const entries = await readdir(dir);
  const meaningful = entries.filter((entry) => entry !== ".DS_Store");
  if (meaningful.length === 0 || (meaningful.length === 1 && meaningful[0] === ".gitignore")) {
    if (!dryRun) {
      await rm(dir, { recursive: true, force: true });
      report.deleted.push(rel(root, dir));
    } else {
      report.wouldDelete.push(rel(root, dir));
    }
  } else {
    report.retained.push(`${rel(root, dir)} (${meaningful.length} non-CodePatchbay entr${meaningful.length === 1 ? "y" : "ies"})`);
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

async function quarantineRemainingRoot(root, dirName, report, dryRun) {
  const src = path.join(root, dirName);
  if (!await isDirectory(src)) return;

  const quarantineRoot = runtimeDataPath(root, "legacy-quarantine");

  let dest = path.join(quarantineRoot, `${dirName.slice(1)}-${stamp()}`);
  let suffix = 1;
  while (await exists(dest)) {
    dest = path.join(quarantineRoot, `${dirName.slice(1)}-${stamp()}-${suffix}`);
    suffix += 1;
  }

  if (!dryRun) {
    await mkdir(quarantineRoot, { recursive: true });
    await rename(src, dest);
  }
  report.quarantined.push(`${rel(root, src)} -> ${rel(root, dest)}`);
}

async function cleanupLegacyRoots(root, report, dryRun, {
  quarantineNonCodePatchbay = false,
  quarantineNonFlow = false,
} = {}) {
  await removeIfEmptyOrOnlyGitignore(root, path.join(root, ".omc", "leases"), report, dryRun);

  if (quarantineNonCodePatchbay || quarantineNonFlow) {
    await quarantineRemainingRoot(root, ".omc", report, dryRun);
    await quarantineRemainingRoot(root, ".omx", report, dryRun);
    return;
  }

  await removeIfEmptyOrOnlyGitignore(root, path.join(root, ".omc"), report, dryRun);
  await removeIfEmptyOrOnlyGitignore(root, path.join(root, ".omx"), report, dryRun);
}

// --- Legacy .omc migration (original behavior) ---

export async function migrateRuntimeRoot(cpbRoot, options: MigrationOptions = {}) {
  const root = path.resolve(cpbRoot);
  const dryRun = options.dryRun || false;
  const report = {
    copied: [],
    skipped: [],
    conflicts: [],
    deleted: [],
    wouldDelete: [],
    quarantined: [],
    quarantineCandidates: [],
    retained: [],
    missing: [],
  };

  await migrateTree(root, path.join(root, ".omc", "events"), runtimeDataPath(root, "events"), report, dryRun);
  await migratePipelineState(root, report, dryRun);
  await migrateTree(root, path.join(root, ".omc", "worktrees"), runtimeDataPath(root, "worktrees"), report, dryRun);
  await cleanupLegacyRoots(root, report, dryRun, options);

  return report;
}

// --- Issue #26: wiki/projects and cpb-task migration to project runtime roots ---

async function migrateWikiProjectsToRuntimeRoots(cpbRoot, hubRoot, projectsById: Record<string, RegistryProject>, report, dryRun) {
  const wikiProjectsDir = path.join(path.resolve(cpbRoot), "wiki", "projects");
  if (!await isDirectory(wikiProjectsDir)) {
    report.missing.push(rel(cpbRoot, wikiProjectsDir));
    return;
  }

  const projectEntries = await readdir(wikiProjectsDir, { withFileTypes: true });
  for (const entry of projectEntries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === '_template') continue;

    const projectId = entry.name;
    const srcDir = path.join(wikiProjectsDir, projectId);
    const destRoot = projectRuntimeRootFromRegistry(hubRoot, projectsById, projectId);

    const destWikiDir = path.join(destRoot, "wiki");

    if (!await isDirectory(srcDir)) continue;

    const files = await listFiles(srcDir);
    let clean = true;
    for (const file of files) {
      const srcFile = path.join(srcDir, file);
      const destFile = path.join(destWikiDir, file);
      const ok = await copyOne(cpbRoot, srcFile, destFile, report, dryRun, destRoot);
      clean &&= ok;
    }

    if (clean && files.length > 0) {
      if (!dryRun) {
        await rm(srcDir, { recursive: true, force: true });
        report.deleted.push(rel(cpbRoot, srcDir));
      } else {
        report.wouldDelete.push(rel(cpbRoot, srcDir));
      }
    } else if (files.length === 0) {
      if (!dryRun) {
        await rm(srcDir, { recursive: true, force: true });
      }
      report.deleted.push(rel(cpbRoot, srcDir));
    } else {
      report.retained.push(`${rel(cpbRoot, srcDir)} (conflicts require manual review)`);
    }
  }
}

async function findLegacyProjectIds(cpbRoot) {
  const root = path.resolve(cpbRoot);
  const ids = new Set<string>();
  const wikiProjectsDir = path.join(root, "wiki", "projects");
  for (const projectId of await listProjectDirs(wikiProjectsDir, new Set(["_template"]))) {
    ids.add(projectId);
  }

  const cpbTaskDir = runtimeDataPath(root);
  for (const subdir of ["events", "checkpoints", "worktrees"]) {
    for (const projectId of await listProjectDirs(path.join(cpbTaskDir, subdir))) {
      ids.add(projectId);
    }
  }

  return [...ids].sort();
}

async function assertLegacyProjectsRegistered(cpbRoot, projectsById: Record<string, RegistryProject>) {
  const legacyProjectIds = await findLegacyProjectIds(cpbRoot);
  const missing = legacyProjectIds.filter((projectId) => !projectsById[projectId]?.projectRuntimeRoot);
  if (missing.length > 0) {
    throw new Error(`unregistered legacy projects: ${missing.join(", ")}`);
  }
}

async function migrateCpbTaskToRuntimeRoots(cpbRoot, hubRoot, projectsById: Record<string, RegistryProject>, report, dryRun) {
  const cpbTaskDir = runtimeDataPath(cpbRoot);
  if (!await isDirectory(cpbTaskDir)) {
    report.missing.push(rel(cpbRoot, cpbTaskDir));
    return;
  }

  // Migrate per-project subdirectories (events/<project>, checkpoints/<project>)
  const projectScopedDirs = ["events", "checkpoints", "worktrees"];
  for (const subdir of projectScopedDirs) {
    const srcBase = path.join(cpbTaskDir, subdir);
    if (!await isDirectory(srcBase)) continue;

    const entries = await readdir(srcBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectId = entry.name;
      const destRoot = projectRuntimeRootFromRegistry(hubRoot, projectsById, projectId);
      const destDir = path.join(destRoot, subdir, projectId);

      await migrateTree(cpbRoot, path.join(srcBase, projectId), destDir, report, dryRun, destRoot);
    }
    await removeIfEmptyOrOnlyGitignore(cpbRoot, srcBase, report, dryRun);
  }

  // Migrate leases (flat directory, project-scoped via jobId)
  const leasesDir = path.join(cpbTaskDir, "leases");
  if (await isDirectory(leasesDir)) {
    const destLeasesRoot = path.join(path.resolve(hubRoot), "leases");
    await migrateTree(cpbRoot, leasesDir, destLeasesRoot, report, dryRun);
  }

  // Migrate state (pipeline state files)
  const stateDir = path.join(cpbTaskDir, "state");
  if (await isDirectory(stateDir)) {
    const destStateRoot = path.join(path.resolve(hubRoot), "state");
    await migrateTree(cpbRoot, stateDir, destStateRoot, report, dryRun);
  }

  // Migrate jobs-index.json
  const indexPath = path.join(cpbTaskDir, "jobs-index.json");
  if (await exists(indexPath)) {
    const destIndex = path.join(path.resolve(hubRoot), "jobs-index.json");
    await copyOne(cpbRoot, indexPath, destIndex, report, dryRun);
    if (!dryRun) {
      await rm(indexPath, { force: true });
      report.deleted.push(rel(cpbRoot, indexPath));
    } else {
      report.wouldDelete.push(rel(cpbRoot, indexPath));
    }
  }

  await removeIfEmptyOrOnlyGitignore(cpbRoot, cpbTaskDir, report, dryRun);
}

export async function migrateToProjectRuntimeRoots(cpbRoot, hubRoot, options: MigrationOptions = {}) {
  const dryRun = options.dryRun || false;
  const report = {
    copied: [],
    skipped: [],
    conflicts: [],
    deleted: [],
    wouldDelete: [],
    quarantined: [],
    quarantineCandidates: [],
    retained: [],
    missing: [],
  };

  const registry = await loadRequiredRegistry(hubRoot);
  const projectsById = registryProjectsById(registry);
  await assertLegacyProjectsRegistered(cpbRoot, projectsById);

  await migrateWikiProjectsToRuntimeRoots(cpbRoot, hubRoot, projectsById, report, dryRun);
  await migrateCpbTaskToRuntimeRoots(cpbRoot, hubRoot, projectsById, report, dryRun);

  if (!dryRun && report.conflicts.length === 0) {
    for (const project of Object.values(projectsById)) {
      if (project?.projectRuntimeRoot) {
        await rebuildJobsIndex(cpbRoot, { dataRoot: project.projectRuntimeRoot });
      }
    }
  }

  return report;
}

function printSection(title, entries) {
  if (entries.length === 0) return;
  console.log(`${title}:`);
  for (const entry of entries) {
    console.log(`  - ${entry}`);
  }
}

export function printReport(report) {
  console.log("Runtime root migration complete.");
  printSection("Copied", report.copied);
  printSection("Skipped", report.skipped);
  printSection("Conflicts", report.conflicts);
  printSection("Would Delete (dry-run)", report.wouldDelete);
  printSection("Deleted", report.deleted);
  printSection("Quarantined", report.quarantined);
  printSection("Quarantine Candidates", report.quarantineCandidates);
  printSection("Retained", report.retained);
  if (
    report.copied.length === 0 &&
    report.skipped.length === 0 &&
    report.conflicts.length === 0 &&
    report.deleted.length === 0 &&
    report.wouldDelete.length === 0 &&
    report.quarantined.length === 0 &&
    report.quarantineCandidates.length === 0 &&
    report.retained.length === 0
  ) {
    console.log("No legacy runtime data found.");
  }
}

async function main() {
  const cpbRoot = process.env.CPB_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const hubRoot = resolveHubRoot(cpbRoot);
  const hasExecute = process.argv.includes("--execute");
  const hasDryRun = process.argv.includes("--dry-run");
  // Default to dry-run; destructive operations require explicit --execute
  const dryRun = !hasExecute || hasDryRun;
  const quarantineNonCodePatchbay = process.argv.includes("--quarantine-non-cpb");
  const projectRuntime = process.argv.includes("--project-runtime");

  if (dryRun) {
    console.log("=== DRY RUN: No files will be moved or deleted ===\n");
  }

  if (projectRuntime) {
    const report = await migrateToProjectRuntimeRoots(cpbRoot, hubRoot, { dryRun, quarantineNonCodePatchbay });
    printReport(report);
    return report.conflicts.length > 0 ? 2 : 0;
  }

  const report = await migrateRuntimeRoot(cpbRoot, { dryRun, quarantineNonCodePatchbay });
  printReport(report);
  return report.conflicts.length > 0 ? 2 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
