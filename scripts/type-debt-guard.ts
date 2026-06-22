#!/usr/bin/env node
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type PatternName =
  | "AnyRecord"
  | "Record<string, any>"
  | "as any"
  | "unknown as"
  | "@ts-ignore"
  | "@ts-expect-error";

type PatternCounts = Partial<Record<PatternName, number>>;
type TypeDebtAllowlist = Record<string, PatternCounts>;

type TypeDebtViolation = {
  path: string;
  pattern: PatternName;
  allowed: number;
  actual: number;
};

type ScanTypeDebtOptions = {
  root?: string;
  scanDir?: string | string[];
  allowlist?: TypeDebtAllowlist;
};

const PATTERNS: Array<{ name: PatternName; regex: RegExp }> = [
  { name: "AnyRecord", regex: /\bAnyRecord\b/g },
  { name: "Record<string, any>", regex: /\bRecord\s*<\s*string\s*,\s*any\s*>/g },
  { name: "as any", regex: /\bas\s+any\b/g },
  { name: "unknown as", regex: /\bunknown\s+as\b/g },
  { name: "@ts-ignore", regex: /@ts-ignore\b/g },
  { name: "@ts-expect-error", regex: /@ts-expect-error\b/g },
];

const DEFAULT_SCAN_DIR = "core/engine";
const DEFAULT_ALLOWLIST = "scripts/type-debt-allowlist.json";
const STRICT_ENGINE_CONFIG = "tsconfig.strict-engine.json";

function slashPath(value: string) {
  return value.split(path.sep).join("/");
}

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-tests") continue;
      files.push(...await listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

async function listTsTarget(root: string, target: string): Promise<string[]> {
  const absoluteTarget = path.resolve(root, target);
  const info = await stat(absoluteTarget).catch(() => null);
  if (!info) return [];
  if (info.isDirectory()) return listTsFiles(absoluteTarget);
  if (info.isFile() && absoluteTarget.endsWith(".ts")) return [absoluteTarget];
  return [];
}

async function strictEngineExtraTargets(root: string, baseScanDir: string) {
  const configPath = path.resolve(root, STRICT_ENGINE_CONFIG);
  const raw = await readFile(configPath, "utf8").catch(() => "");
  if (!raw) return [];
  const config = JSON.parse(raw) as { include?: unknown };
  const includes = Array.isArray(config.include) ? config.include : [];
  return includes
    .map((value) => String(value || ""))
    .filter((value) => value.length > 0 && !value.startsWith(`${baseScanDir}/`) && value !== baseScanDir);
}

async function scanTargets(root: string, scanDir: string | string[] | undefined) {
  if (scanDir) return Array.isArray(scanDir) ? scanDir : [scanDir];
  return [...new Set([DEFAULT_SCAN_DIR, ...await strictEngineExtraTargets(root, DEFAULT_SCAN_DIR)])];
}

function countPattern(source: string, regex: RegExp) {
  regex.lastIndex = 0;
  return [...source.matchAll(regex)].length;
}

export async function scanTypeDebt({
  root = process.cwd(),
  scanDir,
  allowlist = {},
}: ScanTypeDebtOptions = {}) {
  const targets = await scanTargets(root, scanDir);
  const files = [...new Set((await Promise.all(
    targets.map((target) => listTsTarget(root, target))
  )).flat())].sort();
  const scannedPaths = new Set(files.map((file) => slashPath(path.relative(root, file))));
  const counts: TypeDebtAllowlist = {};
  const violations: TypeDebtViolation[] = [];

  for (const file of files) {
    const relative = slashPath(path.relative(root, file));
    const source = await readFile(file, "utf8");
    const fileCounts: PatternCounts = {};
    for (const { name, regex } of PATTERNS) {
      const actual = countPattern(source, regex);
      if (actual > 0) fileCounts[name] = actual;
      const allowed = allowlist[relative]?.[name] || 0;
      if (actual !== allowed) {
        violations.push({ path: relative, pattern: name, allowed, actual });
      }
    }
    if (Object.keys(fileCounts).length > 0) counts[relative] = fileCounts;
  }

  for (const [relative, fileAllowlist] of Object.entries(allowlist)) {
    if (scannedPaths.has(relative)) continue;
    for (const [pattern, allowed] of Object.entries(fileAllowlist) as Array<[PatternName, number]>) {
      if ((allowed || 0) > 0) {
        violations.push({ path: relative, pattern, allowed, actual: 0 });
      }
    }
  }

  return {
    ok: violations.length === 0,
    counts,
    violations,
  };
}

async function readAllowlist(root: string, allowlistPath: string) {
  const file = path.resolve(root, allowlistPath);
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw) as TypeDebtAllowlist;
}

function formatViolations(violations: TypeDebtViolation[]) {
  return violations
    .map((v) => {
      const operator = v.actual > v.allowed ? ">" : "<";
      return `${v.path}: ${v.pattern} ${v.actual} ${operator} allowed ${v.allowed}`;
    })
    .join("\n");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const root = process.cwd();
  const allowlistPath = DEFAULT_ALLOWLIST;

  if (args.has("--write-baseline")) {
    const result = await scanTypeDebt({ root, allowlist: {} });
    const outputPath = path.resolve(root, allowlistPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result.counts, null, 2)}\n`, "utf8");
    console.log(`Wrote ${allowlistPath}`);
    return;
  }

  const allowlist = await readAllowlist(root, allowlistPath);
  const result = await scanTypeDebt({ root, allowlist });
  if (!result.ok) {
    console.error("Type debt guard failed. New or increased broad type debt:\n");
    console.error(formatViolations(result.violations));
    process.exitCode = 1;
    return;
  }
  console.log("Type debt guard passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
