import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MERGE_CLASSIFICATION = Object.freeze({
  SHARED_STATE: "SHARED_STATE",
  NEEDS_HUMAN: "NEEDS_HUMAN",
  RESOLVABLE_CODE: "RESOLVABLE_CODE",
});

const SHARED_STATE_PREFIXES = [
  ".omx/",
  ".cpb/",
  "cpb-task/",
  "wiki/",
];

const NEEDS_HUMAN_BASENAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
]);

function splitLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gitError(args, err) {
  const details = String(err?.stderr || err?.stdout || err?.message || "").trim();
  return new Error(`git ${args.join(" ")} failed${details ? `: ${details}` : ""}`);
}

async function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: 0,
    };
  } catch (err) {
    if (!allowFailure) throw gitError(args, err);
    return {
      stdout: err?.stdout || "",
      stderr: err?.stderr || err?.message || "",
      exitCode: Number.isInteger(err?.code) ? err.code : 1,
    };
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function normalizeMergePath(filePath) {
  return String(filePath || "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

export function classifyMergePath(filePath) {
  const normalized = normalizeMergePath(filePath);
  const basename = path.posix.basename(normalized);

  if (!normalized) return MERGE_CLASSIFICATION.RESOLVABLE_CODE;
  if (normalized.endsWith(".jsonl")) return MERGE_CLASSIFICATION.SHARED_STATE;
  if (normalized.includes("/leases/") || normalized.startsWith("leases/")) {
    return MERGE_CLASSIFICATION.SHARED_STATE;
  }
  if (SHARED_STATE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return MERGE_CLASSIFICATION.SHARED_STATE;
  }

  if (NEEDS_HUMAN_BASENAMES.has(basename)) return MERGE_CLASSIFICATION.NEEDS_HUMAN;
  if (normalized.includes("guidance-schema")) return MERGE_CLASSIFICATION.NEEDS_HUMAN;
  if (normalized.includes("/schema/") || normalized.includes("/schemas/")) {
    return MERGE_CLASSIFICATION.NEEDS_HUMAN;
  }
  if (/schema\.(json|ya?ml)$/i.test(normalized)) return MERGE_CLASSIFICATION.NEEDS_HUMAN;

  return MERGE_CLASSIFICATION.RESOLVABLE_CODE;
}

export function summarizeMergeFiles(files = []) {
  const entries = [...new Set(files.map(normalizeMergePath).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({
      file,
      classification: classifyMergePath(file),
    }));

  const counts = Object.fromEntries(
    Object.values(MERGE_CLASSIFICATION).map((classification) => [classification, 0]),
  );
  for (const entry of entries) counts[entry.classification] += 1;

  return { entries, counts };
}

async function resolveCandidateCommit(repoRoot, candidate) {
  const refResult = await runGit(repoRoot, ["rev-parse", "--verify", `${candidate}^{commit}`], {
    allowFailure: true,
  });
  if (refResult.exitCode === 0) {
    return {
      commit: refResult.stdout.trim(),
      source: "ref",
      label: candidate,
    };
  }

  const candidatePath = path.resolve(repoRoot, candidate);
  if (await pathExists(candidatePath)) {
    const canonicalPath = await realpath(candidatePath);
    const pathResult = await runGit(canonicalPath, ["rev-parse", "--verify", "HEAD"], {
      allowFailure: true,
    });
    if (pathResult.exitCode === 0) {
      return {
        commit: pathResult.stdout.trim(),
        source: "worktree",
        label: canonicalPath,
      };
    }
  }

  throw new Error(`candidate is not a git ref or worktree: ${candidate}`);
}

function abortReasonsForSummary(changedSummary, conflictSummary, mergeStatus) {
  const reasons = [];

  if (changedSummary.counts[MERGE_CLASSIFICATION.SHARED_STATE] > 0) {
    reasons.push({
      code: "shared_state_changed",
      message: "candidate changes CPB/shared-state files; merge steward must not touch them",
      files: changedSummary.entries
        .filter((entry) => entry.classification === MERGE_CLASSIFICATION.SHARED_STATE)
        .map((entry) => entry.file),
    });
  }

  if (changedSummary.counts[MERGE_CLASSIFICATION.NEEDS_HUMAN] > 0) {
    reasons.push({
      code: "needs_human_changed",
      message: "candidate changes governance/config/schema files that need human review",
      files: changedSummary.entries
        .filter((entry) => entry.classification === MERGE_CLASSIFICATION.NEEDS_HUMAN)
        .map((entry) => entry.file),
    });
  }

  if (mergeStatus === "failed" && conflictSummary.entries.length === 0) {
    reasons.push({
      code: "merge_preview_failed",
      message: "git merge preview failed without reporting resolvable conflict files",
      files: [],
    });
  }

  return reasons;
}

export async function previewMerge({ repoRoot = process.cwd(), baseRef = "HEAD", candidate }: Record<string, any> = {}) {
  if (!candidate) throw new Error("candidate is required");

  const canonicalRepoRoot = await realpath(path.resolve(repoRoot));
  const baseHead = (await runGit(canonicalRepoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
  const candidateInfo = await resolveCandidateCommit(canonicalRepoRoot, candidate);
  const mergeBase = (await runGit(canonicalRepoRoot, ["merge-base", baseHead, candidateInfo.commit])).stdout.trim();
  const changedFiles = splitLines(
    (await runGit(canonicalRepoRoot, ["diff", "--name-only", baseHead, candidateInfo.commit])).stdout,
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cpb-merge-preview-"));
  const worktreePath = path.join(tempRoot, "worktree");
  let mergeResult = { exitCode: 1, stdout: "", stderr: "" };
  let conflictFiles = [];

  try {
    await runGit(canonicalRepoRoot, ["worktree", "add", "--detach", worktreePath, baseHead]);
    mergeResult = await runGit(worktreePath, ["merge", "--no-commit", "--no-ff", candidateInfo.commit], {
      allowFailure: true,
    });
    conflictFiles = splitLines(
      (await runGit(worktreePath, ["diff", "--name-only", "--diff-filter=U"], {
        allowFailure: true,
      })).stdout,
    );
    await runGit(worktreePath, ["merge", "--abort"], { allowFailure: true });
  } finally {
    await runGit(canonicalRepoRoot, ["worktree", "remove", "--force", worktreePath], {
      allowFailure: true,
    });
    await rm(tempRoot, { recursive: true, force: true });
  }

  const changedSummary = summarizeMergeFiles(changedFiles);
  const conflictSummary = summarizeMergeFiles(conflictFiles);
  const mergeStatus = mergeResult.exitCode === 0
    ? "clean"
    : conflictFiles.length > 0
      ? "conflicts"
      : "failed";
  const abortReasons = abortReasonsForSummary(changedSummary, conflictSummary, mergeStatus);

  return {
    repoRoot: canonicalRepoRoot,
    baseRef,
    baseHead,
    candidate: {
      input: candidate,
      ...candidateInfo,
    },
    mergeBase,
    mergeStatus,
    mergeExitCode: mergeResult.exitCode,
    changedFiles: changedSummary.entries,
    changedCounts: changedSummary.counts,
    conflictFiles: conflictSummary.entries,
    conflictCounts: conflictSummary.counts,
    abortReasons,
    safeForSteward: abortReasons.length === 0,
  };
}
