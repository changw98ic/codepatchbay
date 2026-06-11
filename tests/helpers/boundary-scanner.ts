// @ts-nocheck
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

export async function listSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(full));
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

export function importSpecifiers(source) {
  const specs = [];
  const patterns = [
    /from\s+["']([^"']+)["']/g,
    /import\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      specs.push(match[1]);
    }
  }
  return specs;
}

export function topLevelTarget(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.normalize(path.resolve(path.dirname(fromFile), specifier));
  const relative = path.relative(REPO_ROOT, resolved);
  return relative.split(path.sep)[0] || null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function dynamicPathRefs(source, targetDir) {
  const refs = [];
  const escapedTarget = escapeRegExp(targetDir);
  const patterns = [
    new RegExp(`path\\.join\\([^)]*["']${escapedTarget}["'][^)]*\\)`, "g"),
    new RegExp(`path\\.resolve\\([^)]*["']${escapedTarget}["'][^)]*\\)`, "g"),
    new RegExp("[\"'`]" + escapedTarget + "[/\\\\][^\"'`]*[\"'`]", "g"),
    new RegExp("[\"'`][^\"'`]*(?:^|[/\\\\])" + escapedTarget + "[/\\\\][^\"'`]*[\"'`]", "g"),
    new RegExp("[\"']" + escapedTarget + "[\"']\\s*\\+\\s*[\"'][/\\\\]", "g"),
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      refs.push(match[0].replace(/\s+/g, " "));
    }
  }
  return refs;
}

export async function scanBoundary({ scanDir, forbiddenTargets, forbiddenDynamicRefs = [] }) {
  const violations = new Set();

  for (const file of await listSourceFiles(scanDir)) {
    const source = await readFile(file, "utf8");
    const relFile = path.relative(REPO_ROOT, file);

    for (const specifier of importSpecifiers(source)) {
      const target = topLevelTarget(file, specifier);
      if (target && forbiddenTargets.has(target)) {
        violations.add(`${relFile} -> ${specifier}`);
      }
    }

    for (const dir of forbiddenDynamicRefs) {
      for (const ref of dynamicPathRefs(source, dir)) {
        violations.add(`${relFile} -> ${ref}`);
      }
    }
  }

  return [...violations].sort();
}

export function detectImportViolations(source, fromFile, forbiddenTargets) {
  const violations = [];
  for (const specifier of importSpecifiers(source)) {
    const target = topLevelTarget(fromFile, specifier);
    if (target && forbiddenTargets.has(target)) {
      violations.push({ specifier, target });
    }
  }
  return violations;
}

export function detectDynamicPathViolations(source, targetDir) {
  return dynamicPathRefs(source, targetDir);
}

/**
 * Detect `export * from` re-export shells in a directory.
 * These are pure pass-through files that re-export everything from another layer.
 * @param {object} opts
 * @param {string} opts.scanDir - directory to scan
 * @param {string[]} opts.reexportTargets - top-level dirs that re-exports point to
 * @returns {Promise<string[]>} sorted list of "{relFile}: {specifier}"
 */
export async function scanReexportShells({ scanDir, reexportTargets }) {
  const shells = [];
  const reexportRe = /^export\s+\*\s+from\s+["']([^"']+)["']/gm;

  for (const file of await listSourceFiles(scanDir)) {
    const source = await readFile(file, "utf8");
    const relFile = path.relative(REPO_ROOT, file);
    let match;
    while ((match = reexportRe.exec(source))) {
      const specifier = match[1];
      const target = topLevelTarget(file, specifier);
      if (target && reexportTargets.includes(target)) {
        shells.push(`${relFile}: ${specifier}`);
      }
    }
  }

  return shells.sort();
}

/**
 * Scan for backward-compat keywords in source files.
 * @param {object} opts
 * @param {string} opts.scanDir - directory to scan
 * @param {string[]} opts.keywords - keywords to search for (e.g. ["backward compatibility", "re-export shell"])
 * @returns {Promise<string[]>} sorted list of "{relFile}:{line}: {content}"
 */
export async function scanCompatKeywords({ scanDir, keywords }) {
  const hits = new Set();

  for (const file of await listSourceFiles(scanDir)) {
    const source = await readFile(file, "utf8");
    const relFile = path.relative(REPO_ROOT, file);
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      for (const kw of keywords) {
        if (lineLower.includes(kw.toLowerCase())) {
          hits.add(`${relFile}:${i + 1}: ${lines[i].trim()}`);
          break;
        }
      }
    }
  }

  return [...hits].sort();
}

export async function scanTextFragments({ scanDir, fragments }) {
  const hits = new Set();

  for (const file of await listSourceFiles(scanDir)) {
    const source = await readFile(file, "utf8");
    const relFile = path.relative(REPO_ROOT, file);
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const fragment of fragments) {
        if (lines[i].includes(fragment)) {
          hits.add(`${relFile}:${i + 1}: ${lines[i].trim()}`);
          break;
        }
      }
    }
  }

  return [...hits].sort();
}

export function detectTextFragments(source, fragments) {
  return fragments.filter((fragment) => source.includes(fragment));
}
