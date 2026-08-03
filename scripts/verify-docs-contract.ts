#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { run as runCodeIndexCommand } from "../cli/commands/code-index.js";
import { syncRepositoryCommandDocs } from "./sync-repository-command-docs.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DOCUMENTS = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "README.md",
  "README.en.md",
  "SECURITY.md",
] as const;
const README_DOCUMENTS = ["README.md", "README.en.md"] as const;

export type DocsContractViolation = Readonly<{ path: string; reason: string }>;

function codeIndexExamples(source: string): string[][] {
  const commands: string[][] = [];
  for (const line of source.split(/\r?\n/)) {
    const command = line.trim().replace(/\s+#.*$/, "");
    if (!/^(?:\.\/)?cpb code-index\s+/.test(command)) continue;
    commands.push(command.split(/\s+/).slice(2));
  }
  return commands;
}

function normalizedCommand(args: readonly string[]): string {
  return `cpb code-index ${args.join(" ")}`;
}

export async function verifyDocsContract(root = REPO_ROOT) {
  const packageSource = await readFile(path.join(root, "package.json"), "utf8");
  const pkg = JSON.parse(packageSource) as { scripts?: Record<string, string> };
  const scripts = new Set(Object.keys(pkg.scripts || {}));
  const violations: DocsContractViolation[] = [];
  const sources = new Map<string, string>();

  for (const relativePath of DOCUMENTS) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    sources.set(relativePath, source);
    for (const match of source.matchAll(/\bnpm run ([A-Za-z0-9:_-]+)/g)) {
      if (!scripts.has(match[1]!)) {
        violations.push({ path: relativePath, reason: `unknown npm script: ${match[1]}` });
      }
    }
    if (/codepatchbay-web|npm run build:web|npm --workspace codepatchbay-web/i.test(source)) {
      violations.push({ path: relativePath, reason: "removed Web workspace command remains" });
    }
    if (/\bWeb UI\b|飞书|钉钉|\bFeishu\b|\bDingTalk\b/i.test(source)) {
      violations.push({ path: relativePath, reason: "removed product surface remains" });
    }
    if (/cpb code-index query\s+<kind>/i.test(source)) {
      violations.push({ path: relativePath, reason: "generic code-index query syntax remains" });
    }
    if (/\b\d+(?:\+)?[- ]file main-flow\b|\*\*\d+\+\s*个\*\*/i.test(source)) {
      violations.push({ path: relativePath, reason: "fixed test-file count remains" });
    }
  }

  const commandSync = await syncRepositoryCommandDocs({ root, check: true });
  violations.push(...commandSync.violations);

  const readmeCommands = new Map<string, string[][]>();
  for (const relativePath of README_DOCUMENTS) {
    const commands = codeIndexExamples(sources.get(relativePath)!);
    readmeCommands.set(relativePath, commands);
    if (commands.length === 0) {
      violations.push({ path: relativePath, reason: "no executable code-index examples found" });
      continue;
    }
    for (const args of commands) {
      const exitCode = await runCodeIndexCommand([...args, "--syntax-only"], { cpbRoot: root });
      if (exitCode !== 0) {
        violations.push({
          path: relativePath,
          reason: `invalid code-index example: ${normalizedCommand(args)}`,
        });
      }
    }
  }

  const chineseCommands = (readmeCommands.get("README.md") || []).map(normalizedCommand);
  const englishCommands = (readmeCommands.get("README.en.md") || []).map(normalizedCommand);
  if (JSON.stringify(chineseCommands) !== JSON.stringify(englishCommands)) {
    violations.push({ path: "README.en.md", reason: "code-index examples differ from README.md" });
  }

  const security = sources.get("SECURITY.md")!;
  for (const required of ["Hub API", "cpb stream", "Agent execution"]) {
    if (!security.includes(required)) {
      violations.push({ path: "SECURITY.md", reason: `current security surface is missing: ${required}` });
    }
  }

  return { ok: violations.length === 0, violations };
}

async function main() {
  const result = await verifyDocsContract();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
