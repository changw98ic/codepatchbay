import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { runCommandTree } from "./process-tree.js";

const execFileAsync = promisify(execFile);

function safeRepositoryPath(file: string) {
  return Boolean(file)
    && !file.startsWith("/")
    && !file.includes("\\")
    && !file.split("/").includes("..");
}

function outputText(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export async function applyFrozenGitTreeDelta({
  sourceRoot,
  replayRoot,
  fromTree,
  candidateTree,
  files,
  env,
}: {
  sourceRoot: string;
  replayRoot: string;
  fromTree: string;
  candidateTree: string;
  files: string[];
  env: NodeJS.ProcessEnv;
}) {
  if (!/^[0-9a-f]{40,64}$/i.test(fromTree) || !/^[0-9a-f]{40,64}$/i.test(candidateTree)) {
    throw new Error("frozen tree replay requires Git object ids");
  }
  const scopedFiles = [...new Set(files)].sort();
  for (const file of scopedFiles) {
    if (!safeRepositoryPath(file)) throw new Error(`unsafe frozen tree replay path: ${file}`);
  }
  if (scopedFiles.length === 0) return;

  const { stdout: patch } = await execFileAsync("git", [
    "--literal-pathspecs",
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    fromTree,
    candidateTree,
    "--",
    ...scopedFiles,
  ], {
    cwd: sourceRoot,
    env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (!patch) return;

  const applied = await runCommandTree("git", [
    "apply",
    "--index",
    "--binary",
    "--whitespace=nowarn",
    "-",
  ], {
    cwd: replayRoot,
    env,
    input: patch,
    timeoutMs: 120_000,
  });
  if (applied.exitCode !== 0 || applied.timedOut || applied.error) {
    throw Object.assign(new Error([
      "frozen Git tree patch could not be applied",
      applied.timedOut ? "timed out" : "",
      outputText(applied.stderr || applied.stdout),
      applied.error?.message || "",
    ].filter(Boolean).join(": ")), {
      code: "FROZEN_GIT_TREE_APPLY_FAILED",
      exitCode: applied.exitCode,
      timedOut: applied.timedOut,
    });
  }
}
