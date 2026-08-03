#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REPOSITORY_COMMAND_BLOCK_START = "<!-- BEGIN REPOSITORY COMMAND CONTRACT -->";
export const REPOSITORY_COMMAND_BLOCK_END = "<!-- END REPOSITORY COMMAND CONTRACT -->";

const REPOSITORY_DOCUMENTS = ["AGENTS.md", "CLAUDE.md"] as const;
const FRAGMENT_PATH = "docs/fragments/repository-command-contract.md";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

export type RepositoryCommandDocsResult = Readonly<{
  ok: boolean;
  changed: readonly string[];
  violations: readonly Readonly<{ path: string; reason: string }>[];
}>;

function generatedBlock(fragment: string): string {
  return `${REPOSITORY_COMMAND_BLOCK_START}\n${fragment.trim()}\n${REPOSITORY_COMMAND_BLOCK_END}`;
}

function replaceGeneratedBlock(source: string, block: string, relativePath: string): string {
  const start = source.indexOf(REPOSITORY_COMMAND_BLOCK_START);
  const end = source.indexOf(REPOSITORY_COMMAND_BLOCK_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`${relativePath} is missing the repository command contract markers`);
  }
  if (
    source.indexOf(REPOSITORY_COMMAND_BLOCK_START, start + REPOSITORY_COMMAND_BLOCK_START.length) >= 0
    || source.indexOf(REPOSITORY_COMMAND_BLOCK_END, end + REPOSITORY_COMMAND_BLOCK_END.length) >= 0
  ) {
    throw new Error(`${relativePath} contains duplicate repository command contract markers`);
  }
  return `${source.slice(0, start)}${block}${source.slice(end + REPOSITORY_COMMAND_BLOCK_END.length)}`;
}

export async function syncRepositoryCommandDocs(
  input: Readonly<{ root?: string; check?: boolean }> = {},
): Promise<RepositoryCommandDocsResult> {
  const root = path.resolve(input.root || REPO_ROOT);
  const fragment = await readFile(path.join(root, FRAGMENT_PATH), "utf8");
  const block = generatedBlock(fragment);
  const changed: string[] = [];
  const violations: Array<{ path: string; reason: string }> = [];

  for (const relativePath of REPOSITORY_DOCUMENTS) {
    const absolutePath = path.join(root, relativePath);
    const source = await readFile(absolutePath, "utf8");
    let expected: string;
    try {
      expected = replaceGeneratedBlock(source, block, relativePath);
    } catch (error) {
      violations.push({
        path: relativePath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (expected === source) continue;
    changed.push(relativePath);
    if (input.check) {
      violations.push({ path: relativePath, reason: "repository command contract block is stale" });
    } else {
      await writeFile(absolutePath, expected, "utf8");
    }
  }

  return { ok: violations.length === 0, changed, violations };
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = option(args, "--root");
  const known = new Set(["--check", "--root", ...(root ? [root] : [])]);
  const unknown = args.find((arg) => !known.has(arg));
  if (unknown) throw new Error(`unknown option: ${unknown}`);
  const result = await syncRepositoryCommandDocs({ root, check: args.includes("--check") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
