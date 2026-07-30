#!/usr/bin/env node
/**
 * Deterministic fixture generator for the Local Code Index v2 benchmark.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  FIXTURE_SEED,
  type FixtureSize,
} from "./scenarios.js";

export const GIT_IDENTITY = {
  name: "CPB Benchmark",
  email: "benchmark@codepatchbay.local",
  date: "2025-01-15T10:30:00+00:00",
} as const;

const FILE_BYTES = 4 * 1024;

export interface GeneratedFile {
  relativePath: string;
  content: string;
  language: "typescript" | "javascript" | "json";
}

export interface FixtureManifest {
  eligibleFiles: FixtureSize;
  eligibleBytes: number;
  seed: typeof FIXTURE_SEED;
  generatedInventorySha256: string;
  generatedContentSha256: string;
  gitObjectFormat: "sha1";
  commits: Readonly<{ base: string; branchA: string; branchB: string }>;
  gitIdentity: typeof GIT_IDENTITY;
  languageDistribution: Readonly<{
    typescript: number;
    javascript: number;
    json: number;
  }>;
}

export function fixtureRelativePath(index: number): string {
  const directory = Math.floor(index / 100).toString().padStart(3, "0");
  const stem = `module${index.toString().padStart(5, "0")}`;
  const slot = index % 10;
  const extension = slot < 7 ? ".ts" : slot < 9 ? ".js" : ".json";
  return `src/${directory}/${stem}${extension}`;
}

function moduleName(index: number): string {
  return `module${index.toString().padStart(5, "0")}`;
}

function sourceIndexesBefore(index: number, count: number, size: number): number[] {
  const result: number[] = [];
  for (let offset = 1; result.length < count; offset++) {
    const candidate = (index - offset + size) % size;
    if (candidate % 10 !== 9) result.push(candidate);
  }
  return result;
}

function importSpecifier(fromIndex: number, targetIndex: number): string {
  const fromDir = path.posix.dirname(fixtureRelativePath(fromIndex));
  const target = fixtureRelativePath(targetIndex).replace(/\.(ts|js)$/, "");
  let relative = path.posix.relative(fromDir, target);
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

function padSource(base: string): string {
  const baseBytes = Buffer.byteLength(base, "utf8");
  const remaining = FILE_BYTES - baseBytes;
  if (remaining < 6) throw new Error(`generated source exceeds ${FILE_BYTES} bytes`);
  const padding = `/*${"-".repeat(remaining - 5)}*/\n`;
  const output = base + padding;
  if (Buffer.byteLength(output, "utf8") !== FILE_BYTES) {
    throw new Error("source padding is not byte exact");
  }
  return output;
}

function generateSource(index: number, size: FixtureSize, language: "typescript" | "javascript"): string {
  const refs = sourceIndexesBefore(index, 8, size);
  const imports = refs.slice(0, 2);
  const typeSuffix = language === "typescript" ? ": number" : "";
  const unique = index.toString().padStart(5, "0");
  const valueName = `value${unique}`;
  const localName = `local${unique}`;
  const ambiguousDefinition = index === 0 || index === 1
    ? `export function ambiguousShared(${valueName}${typeSuffix})${typeSuffix} { return ${valueName} + ${index}; }\n`
    : "";
  const importLines = imports.map((target, offset) =>
    `import { ${moduleName(target)} as imported${unique}_${offset} } from ${JSON.stringify(importSpecifier(index, target))};`,
  );
  const referenceLines = refs.map((target) => `  void ${moduleName(target)};`);
  const base = [
    ...importLines,
    "",
    ambiguousDefinition.trimEnd(),
    `export function ${moduleName(index)}(${valueName}${typeSuffix})${typeSuffix} {`,
    `  const ${localName}${typeSuffix} = ${valueName} + ${index};`,
    ...referenceLines,
    `  void imported${unique}_0;`,
    `  void imported${unique}_1;`,
    "  void ambiguousShared;",
    `  return ${localName};`,
    "}",
    "",
  ].filter((line, lineIndex, all) =>
    line !== "" || lineIndex === 0 || all[lineIndex - 1] !== "",
  ).join("\n");
  return padSource(`${base}\n`);
}

function generateJson(index: number): string {
  const prefix = `{"module":${JSON.stringify(moduleName(index))},"index":${index},"padding":"`;
  const suffix = '"}\n';
  const paddingLength = FILE_BYTES - Buffer.byteLength(prefix + suffix, "utf8");
  if (paddingLength < 0) throw new Error("JSON fixture prefix exceeds target size");
  const output = prefix + "x".repeat(paddingLength) + suffix;
  if (Buffer.byteLength(output, "utf8") !== FILE_BYTES) {
    throw new Error("JSON padding is not byte exact");
  }
  return output;
}

function generateFiles(size: FixtureSize): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  for (let index = 0; index < size; index++) {
    const slot = index % 10;
    const language = slot < 7
      ? "typescript"
      : slot < 9
        ? "javascript"
        : "json";
    files.push({
      relativePath: fixtureRelativePath(index),
      language,
      content: language === "json"
        ? generateJson(index)
        : generateSource(index, size, language),
    });
  }
  return files;
}

export function computeInventoryHash(files: readonly GeneratedFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0");
    hash.update(String(Buffer.byteLength(file.content, "utf8")), "utf8");
    hash.update("\0");
    hash.update(createHash("sha256").update(file.content, "utf8").digest("hex"), "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function computeContentHash(files: readonly GeneratedFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0");
    hash.update(file.content, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function git(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string {
  return execFileSync("git", [...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim();
}

async function applyBranchEdits(
  outputDir: string,
  sourceIndexes: readonly number[],
  label: string,
): Promise<void> {
  for (const index of sourceIndexes) {
    const filePath = path.join(outputDir, fixtureRelativePath(index));
    const original = await readFile(filePath, "utf8");
    const replacement = label === "branch-a" ? "!" : "?";
    const edited = original.replace("/*-", `/*${replacement}`);
    if (edited === original) throw new Error(`missing deterministic padding in ${filePath}`);
    await writeFile(filePath, edited, "utf8");
  }
}

function editableIndexes(size: FixtureSize): number[] {
  const result: number[] = [];
  for (let index = 0; index < size; index++) {
    if (index % 10 !== 9) result.push(index);
  }
  return result;
}

export async function generateFixture(
  size: FixtureSize,
  outputDir: string,
): Promise<FixtureManifest> {
  const files = generateFiles(size);
  await rm(outputDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  await mkdir(outputDir, { recursive: true });
  for (const file of files) {
    const target = path.join(outputDir, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }

  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_IDENTITY.email,
    GIT_AUTHOR_DATE: GIT_IDENTITY.date,
    GIT_COMMITTER_NAME: GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_IDENTITY.email,
    GIT_COMMITTER_DATE: GIT_IDENTITY.date,
    LC_ALL: "C",
    LANG: "C",
  };
  git(outputDir, ["init", "-q", "--object-format=sha1", "-b", "main"], gitEnv);
  git(outputDir, ["config", "core.autocrlf", "false"], gitEnv);
  git(outputDir, ["config", "core.eol", "lf"], gitEnv);
  git(outputDir, ["add", "--all"], gitEnv);
  git(outputDir, ["commit", "-q", "-m", "base"], gitEnv);
  const base = git(outputDir, ["rev-parse", "HEAD"], gitEnv);

  const editable = editableIndexes(size);
  const branchAIndexes = editable.slice(0, 100);
  const branchBIndexes = editable.slice(50, 150);

  git(outputDir, ["switch", "-q", "-c", "branch-a"], gitEnv);
  await applyBranchEdits(outputDir, branchAIndexes, "branch-a");
  git(outputDir, ["add", "--all"], gitEnv);
  git(outputDir, ["commit", "-q", "-m", "branch-a"], gitEnv);
  const branchA = git(outputDir, ["rev-parse", "HEAD"], gitEnv);

  git(outputDir, ["switch", "-q", "--detach", base], gitEnv);
  git(outputDir, ["switch", "-q", "-c", "branch-b"], gitEnv);
  await applyBranchEdits(outputDir, branchBIndexes, "branch-b");
  git(outputDir, ["add", "--all"], gitEnv);
  git(outputDir, ["commit", "-q", "-m", "branch-b"], gitEnv);
  const branchB = git(outputDir, ["rev-parse", "HEAD"], gitEnv);
  git(outputDir, ["switch", "-q", "main"], gitEnv);

  const distribution = {
    typescript: files.filter((file) => file.language === "typescript").length,
    javascript: files.filter((file) => file.language === "javascript").length,
    json: files.filter((file) => file.language === "json").length,
  };

  return {
    eligibleFiles: size,
    eligibleBytes: files.reduce(
      (total, file) => total + Buffer.byteLength(file.content, "utf8"),
      0,
    ),
    seed: FIXTURE_SEED,
    generatedInventorySha256: computeInventoryHash(files),
    generatedContentSha256: computeContentHash(files),
    gitObjectFormat: "sha1",
    commits: { base, branchA, branchB },
    gitIdentity: GIT_IDENTITY,
    languageDistribution: distribution,
  };
}

async function main(): Promise<void> {
  const size = Number(process.argv[2] ?? "1000") as FixtureSize;
  if (size !== 1000 && size !== 10000) {
    throw new Error("usage: generate <1000|10000> <output-dir>");
  }
  const outputDir = path.resolve(
    process.argv[3]
      ?? path.join(process.cwd(), "artifacts", "bench", `fixture-${size}`),
  );
  const manifest = await generateFixture(size, outputDir);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
