#!/usr/bin/env node
import { execFileSync } from "node:child_process";

export const PATCH_INTEGRITY_ROOTS = [
  "core/",
  "runtime/",
  "server/",
  "cli/",
  "bridges/",
  "shared/",
  "scripts/",
  "tests/",
  "docs/",
];

type GitStatusEntry = {
  status: string;
  path: string;
};

type PatchIntegrityResult = {
  ok: boolean;
  untrackedImplementationFiles: string[];
};

function normalizeGitPath(value: string) {
  return value.replaceAll("\\", "/").replace(/^"\s*/, "").replace(/"\s*$/, "");
}

export function parseGitStatusPorcelain(statusOutput: string): GitStatusEntry[] {
  return statusOutput
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => ({
      status: entry.slice(0, 2),
      path: normalizeGitPath(entry.slice(3)),
    }))
    .filter((entry) => entry.path.length > 0);
}

export function isPatchRelevantPath(filePath: string) {
  const normalized = normalizeGitPath(filePath);
  return PATCH_INTEGRITY_ROOTS.some((root) => normalized.startsWith(root));
}

export function verifyPatchIntegrityStatus(statusOutput: string): PatchIntegrityResult {
  const untrackedImplementationFiles = parseGitStatusPorcelain(statusOutput)
    .filter((entry) => entry.status === "??")
    .map((entry) => entry.path)
    .filter(isPatchRelevantPath)
    .sort();

  return {
    ok: untrackedImplementationFiles.length === 0,
    untrackedImplementationFiles,
  };
}

export function formatPatchIntegrityFailure(files: string[]) {
  return [
    "Patch integrity failed. Untracked implementation files must be added to the reviewed patch or explicitly excluded:",
    "",
    ...files.map((file) => `- ${file}`),
    "",
    "Run: git status --short --untracked-files=all",
  ].join("\n");
}

function readStatus(root: string) {
  return execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
}

async function main() {
  const root = process.cwd();
  const result = verifyPatchIntegrityStatus(readStatus(root));
  if (!result.ok) {
    console.error(formatPatchIntegrityFailure(result.untrackedImplementationFiles));
    process.exitCode = 1;
    return;
  }
  console.log("Patch integrity passed.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
