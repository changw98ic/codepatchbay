#!/usr/bin/env node

import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeDataPath } from "../server/services/runtime-root.js";

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

async function copyOne(root, src, dest, report) {
  if (await exists(dest)) {
    if (await sameFile(src, dest)) {
      report.skipped.push(`${rel(root, src)} -> ${rel(root, dest)} (already current)`);
      return true;
    }
    report.conflicts.push(`${rel(root, src)} -> ${rel(root, dest)}`);
    return false;
  }

  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
  report.copied.push(`${rel(root, src)} -> ${rel(root, dest)}`);
  return true;
}

async function migrateTree(root, src, dest, report) {
  if (!await isDirectory(src)) {
    report.missing.push(rel(root, src));
    return;
  }

  const files = await listFiles(src);
  let clean = true;
  for (const file of files) {
    const ok = await copyOne(root, path.join(src, file), path.join(dest, file), report);
    clean &&= ok;
  }

  if (clean) {
    await rm(src, { recursive: true, force: true });
    report.deleted.push(rel(root, src));
  } else {
    report.retained.push(`${rel(root, src)} (conflicts require manual review)`);
  }
}

async function migratePipelineState(root, report) {
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
    if (await copyOne(root, src, dest, report)) {
      await rm(src, { force: true });
      report.deleted.push(rel(root, src));
    }
  }

  await removeIfEmptyOrOnlyGitignore(root, srcDir, report);
}

async function removeIfEmptyOrOnlyGitignore(root, dir, report) {
  if (!await isDirectory(dir)) return;
  const entries = await readdir(dir);
  const meaningful = entries.filter((entry) => entry !== ".DS_Store");
  if (meaningful.length === 0 || (meaningful.length === 1 && meaningful[0] === ".gitignore")) {
    await rm(dir, { recursive: true, force: true });
    report.deleted.push(rel(root, dir));
  } else {
    report.retained.push(`${rel(root, dir)} (${meaningful.length} non-CodePatchbay entr${meaningful.length === 1 ? "y" : "ies"})`);
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
}

async function quarantineRemainingRoot(root, dirName, report) {
  const src = path.join(root, dirName);
  if (!await isDirectory(src)) return;

  const quarantineRoot = runtimeDataPath(root, "legacy-quarantine");
  await mkdir(quarantineRoot, { recursive: true });

  let dest = path.join(quarantineRoot, `${dirName.slice(1)}-${stamp()}`);
  let suffix = 1;
  while (await exists(dest)) {
    dest = path.join(quarantineRoot, `${dirName.slice(1)}-${stamp()}-${suffix}`);
    suffix += 1;
  }

  await rename(src, dest);
  report.quarantined.push(`${rel(root, src)} -> ${rel(root, dest)}`);
}

async function cleanupLegacyRoots(root, report, { quarantineNonCodePatchbay = false } = {}) {
  await removeIfEmptyOrOnlyGitignore(root, path.join(root, ".omc", "leases"), report);

  if (quarantineNonCodePatchbay) {
    await quarantineRemainingRoot(root, ".omc", report);
    await quarantineRemainingRoot(root, ".omx", report);
    return;
  }

  await removeIfEmptyOrOnlyGitignore(root, path.join(root, ".omc"), report);
  await removeIfEmptyOrOnlyGitignore(root, path.join(root, ".omx"), report);
}

export async function migrateRuntimeRoot(cpbRoot, options = {}) {
  const root = path.resolve(cpbRoot);
  const report = {
    copied: [],
    skipped: [],
    conflicts: [],
    deleted: [],
    quarantined: [],
    retained: [],
    missing: [],
  };

  await migrateTree(root, path.join(root, ".omc", "events"), runtimeDataPath(root, "events"), report);
  await migratePipelineState(root, report);
  await migrateTree(root, path.join(root, ".omc", "worktrees"), runtimeDataPath(root, "worktrees"), report);
  await cleanupLegacyRoots(root, report, options);

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
  printSection("Deleted", report.deleted);
  printSection("Quarantined", report.quarantined);
  printSection("Retained", report.retained);
  if (
    report.copied.length === 0 &&
    report.skipped.length === 0 &&
    report.conflicts.length === 0 &&
    report.deleted.length === 0 &&
    report.quarantined.length === 0 &&
    report.retained.length === 0
  ) {
    console.log("No legacy runtime data found.");
  }
}

async function main() {
  const cpbRoot = process.env.CPB_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const quarantineNonCodePatchbay = process.argv.includes("--quarantine-non-cpb");
  const report = await migrateRuntimeRoot(cpbRoot, { quarantineNonCodePatchbay });
  printReport(report);
  return report.conflicts.length > 0 ? 2 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
