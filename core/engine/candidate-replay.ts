import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { CandidateArtifact } from "./candidate-artifact.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;

export type CandidateReplayBundle = {
  schemaVersion: 1;
  baseSha: string;
  expectedTreeHash: string;
  candidateIdentityHash: string;
  patchSha256: string;
  patchBytes: number;
  bundleHash: string;
  patch: string;
};

export type CandidateCleanReplayRecord = {
  schemaVersion: 1;
  replayedAt: string;
  baseSha: string;
  expectedTreeHash: string;
  actualTreeHash: string | null;
  cleanApply: boolean;
  reason: string | null;
  replayMethod?: "repository_tree" | "persisted_patch_bundle";
  bundleHash?: string | null;
  patchSha256?: string | null;
};

async function git(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return String(stdout || "").trim();
}

async function gitRaw(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  return String(stdout || "");
}

function sha256(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function replayBundleHash(bundle: Omit<CandidateReplayBundle, "bundleHash">) {
  return sha256(JSON.stringify({
    schemaVersion: bundle.schemaVersion,
    baseSha: bundle.baseSha,
    expectedTreeHash: bundle.expectedTreeHash,
    candidateIdentityHash: bundle.candidateIdentityHash,
    patchSha256: bundle.patchSha256,
    patchBytes: bundle.patchBytes,
  }));
}

export async function createCandidateReplayBundle({
  cwd,
  candidate,
}: {
  cwd: string;
  candidate: CandidateArtifact;
}): Promise<CandidateReplayBundle> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const patch = await gitRaw(root, [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    candidate.baseSha,
    candidate.treeHash,
    "--",
  ]);
  const unsigned = {
    schemaVersion: 1 as const,
    baseSha: candidate.baseSha,
    expectedTreeHash: candidate.treeHash,
    candidateIdentityHash: candidate.identityHash,
    patchSha256: sha256(patch),
    patchBytes: Buffer.byteLength(patch, "utf8"),
    patch,
  };
  return {
    ...unsigned,
    bundleHash: replayBundleHash(unsigned),
  };
}

export function validateCandidateReplayBundle(bundle: CandidateReplayBundle): string | null {
  if (bundle.schemaVersion !== 1) return "unsupported candidate replay bundle schema";
  if (!/^[0-9a-f]{40,64}$/i.test(bundle.baseSha)) return "candidate replay base commit is invalid";
  if (!/^[0-9a-f]{40,64}$/i.test(bundle.expectedTreeHash)) return "candidate replay tree hash is invalid";
  if (!/^sha256:[0-9a-f]{64}$/i.test(bundle.candidateIdentityHash)) return "candidate replay identity hash is invalid";
  if (!/^sha256:[0-9a-f]{64}$/i.test(bundle.patchSha256)) return "candidate replay patch hash is invalid";
  if (!/^sha256:[0-9a-f]{64}$/i.test(bundle.bundleHash)) return "candidate replay bundle hash is invalid";
  if (!Number.isInteger(bundle.patchBytes) || bundle.patchBytes < 0 || bundle.patchBytes > MAX_GIT_OUTPUT_BYTES) {
    return "candidate replay patch byte count is invalid";
  }
  if (sha256(bundle.patch) !== bundle.patchSha256) return "candidate replay patch hash mismatch";
  if (Buffer.byteLength(bundle.patch, "utf8") !== bundle.patchBytes) return "candidate replay patch byte count mismatch";
  const { bundleHash: _bundleHash, ...unsigned } = bundle;
  if (replayBundleHash(unsigned) !== bundle.bundleHash) return "candidate replay bundle hash mismatch";
  return null;
}

/**
 * Reconstruct a candidate from a persisted binary patch bundle. Unlike the
 * repository-tree replay below, this remains usable after the mutable
 * worktree and its unreachable Git tree object have been removed.
 */
export async function replayCandidateBundleInCleanWorktree({
  cwd,
  bundle,
  replayedAt = new Date().toISOString(),
}: {
  cwd: string;
  bundle: CandidateReplayBundle;
  replayedAt?: string;
}): Promise<CandidateCleanReplayRecord> {
  const invalidReason = validateCandidateReplayBundle(bundle);
  if (invalidReason) {
    return {
      schemaVersion: 1,
      replayedAt,
      baseSha: bundle.baseSha,
      expectedTreeHash: bundle.expectedTreeHash,
      actualTreeHash: null,
      cleanApply: false,
      reason: invalidReason,
      replayMethod: "persisted_patch_bundle",
      bundleHash: bundle.bundleHash,
      patchSha256: bundle.patchSha256,
    };
  }

  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "cpb-candidate-bundle-replay-"));
  const replayRoot = path.join(temporaryRoot, "worktree");
  const patchPath = path.join(temporaryRoot, "candidate.patch");
  let worktreeAdded = false;
  let actualTreeHash: string | null = null;

  try {
    await git(root, ["worktree", "add", "--detach", replayRoot, bundle.baseSha]);
    worktreeAdded = true;
    if (bundle.patchBytes > 0) {
      await writeFile(patchPath, bundle.patch, "utf8");
      await git(replayRoot, ["apply", "--index", "--binary", "--whitespace=nowarn", patchPath]);
    }
    actualTreeHash = await git(replayRoot, ["write-tree"]);
    const cleanApply = actualTreeHash === bundle.expectedTreeHash;
    return {
      schemaVersion: 1,
      replayedAt,
      baseSha: bundle.baseSha,
      expectedTreeHash: bundle.expectedTreeHash,
      actualTreeHash,
      cleanApply,
      reason: cleanApply ? null : "replayed bundle tree hash does not match frozen candidate",
      replayMethod: "persisted_patch_bundle",
      bundleHash: bundle.bundleHash,
      patchSha256: bundle.patchSha256,
    };
  } catch (err) {
    return {
      schemaVersion: 1,
      replayedAt,
      baseSha: bundle.baseSha,
      expectedTreeHash: bundle.expectedTreeHash,
      actualTreeHash,
      cleanApply: false,
      reason: err instanceof Error ? err.message : String(err),
      replayMethod: "persisted_patch_bundle",
      bundleHash: bundle.bundleHash,
      patchSha256: bundle.patchSha256,
    };
  } finally {
    if (worktreeAdded) {
      await git(root, ["worktree", "remove", "--force", replayRoot]).catch(() => "");
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Materialize the frozen candidate tree in a disposable worktree rooted at
 * the recorded base commit. This proves that the exact final repository state
 * is reconstructible independently of the mutable solver worktree.
 */
export async function replayCandidateInCleanWorktree({
  cwd,
  candidate,
  replayedAt = new Date().toISOString(),
}: {
  cwd: string;
  candidate: CandidateArtifact;
  replayedAt?: string;
}): Promise<CandidateCleanReplayRecord> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "cpb-candidate-replay-"));
  const replayRoot = path.join(temporaryRoot, "worktree");
  let worktreeAdded = false;
  let actualTreeHash: string | null = null;

  try {
    await git(root, ["worktree", "add", "--detach", "--no-checkout", replayRoot, candidate.baseSha]);
    worktreeAdded = true;
    await git(replayRoot, ["read-tree", "--reset", "-u", candidate.treeHash]);
    actualTreeHash = await git(replayRoot, ["write-tree"]);
    const cleanApply = actualTreeHash === candidate.treeHash;
    return {
      schemaVersion: 1,
      replayedAt,
      baseSha: candidate.baseSha,
      expectedTreeHash: candidate.treeHash,
      actualTreeHash,
      cleanApply,
      reason: cleanApply ? null : "replayed tree hash does not match frozen candidate",
      replayMethod: "repository_tree",
      bundleHash: null,
      patchSha256: null,
    };
  } catch (err) {
    return {
      schemaVersion: 1,
      replayedAt,
      baseSha: candidate.baseSha,
      expectedTreeHash: candidate.treeHash,
      actualTreeHash,
      cleanApply: false,
      reason: err instanceof Error ? err.message : String(err),
      replayMethod: "repository_tree",
      bundleHash: null,
      patchSha256: null,
    };
  } finally {
    if (worktreeAdded) {
      await git(root, ["worktree", "remove", "--force", replayRoot]).catch(() => "");
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
