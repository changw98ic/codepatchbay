import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { createTemporaryWorkspace } from "../runtime/temporary-workspace.js";

const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;

export type CandidateArtifactUntrackedEntry = {
  path: string;
  kind: "file" | "symlink";
  mode: "100644" | "100755" | "120000";
  bytes: number;
  contentHash: string;
};

export type CandidateArtifact = {
  schemaVersion: 1;
  baseSha: string;
  headSha: string;
  treeHash: string;
  trackedPatchHash: string;
  patchHash: string;
  changedFiles: string[];
  trackedChangedFiles: string[];
  untrackedManifest: CandidateArtifactUntrackedEntry[];
  untrackedManifestHash: string;
  identityHash: string;
};

export type CandidateArtifactIdentity = Pick<
  CandidateArtifact,
  | "schemaVersion"
  | "baseSha"
  | "headSha"
  | "treeHash"
  | "trackedPatchHash"
  | "patchHash"
  | "changedFiles"
  | "trackedChangedFiles"
  | "untrackedManifest"
  | "untrackedManifestHash"
  | "identityHash"
>;

export type CandidateArtifactIdentityMismatch = {
  field: keyof CandidateArtifactIdentity;
  expected: unknown;
  actual: unknown;
};

export type CandidateArtifactVerificationRecord = {
  schemaVersion: 1;
  verifiedAt: string;
  matches: boolean;
  expectedIdentityHash: string;
  actualIdentityHash: string;
  mismatches: CandidateArtifactIdentityMismatch[];
  expected: CandidateArtifactIdentity;
  actual: CandidateArtifactIdentity;
};

type CaptureCandidateArtifactOptions = {
  cwd: string;
  base?: string;
  maxSnapshotAttempts?: number;
  env?: NodeJS.ProcessEnv;
};

type RawCandidateSnapshot = {
  headSha: string;
  treeHash: string;
  trackedPatchHash: string;
  trackedChangedFiles: string[];
  untrackedManifest: CandidateArtifactUntrackedEntry[];
  untrackedManifestHash: string;
};

const IDENTITY_FIELDS: Array<keyof CandidateArtifactIdentity> = [
  "schemaVersion",
  "baseSha",
  "headSha",
  "treeHash",
  "trackedPatchHash",
  "patchHash",
  "changedFiles",
  "trackedChangedFiles",
  "untrackedManifest",
  "untrackedManifestHash",
  "identityHash",
];

function sha256(value: string | Buffer) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown) {
  return JSON.stringify(value);
}

function canonicalHash(value: unknown) {
  return sha256(canonicalJson(value));
}

function nulSeparatedPaths(value: Buffer) {
  return value
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRepoPath)
    .sort();
}

function normalizeRepoPath(value: string) {
  const normalized = value.split(path.sep).join("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").includes("..")) {
    throw new Error(`invalid repository-relative candidate path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

async function gitBuffer(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<Buffer>((resolve, reject) => {
    execFile("git", args, {
      cwd,
      env,
      encoding: "buffer",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function gitText(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return (await gitBuffer(cwd, args, env)).toString("utf8").trim();
}

async function repositoryRoot(cwd: string, env: NodeJS.ProcessEnv) {
  return path.resolve(await gitText(cwd, ["rev-parse", "--show-toplevel"], env));
}

async function resolveCommit(cwd: string, revision: string, env: NodeJS.ProcessEnv) {
  const sha = await gitText(cwd, ["rev-parse", "--verify", `${revision}^{commit}`], env);
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error(`git returned an invalid commit id for ${revision}`);
  return sha.toLowerCase();
}

async function readUntrackedManifest(cwd: string, env: NodeJS.ProcessEnv) {
  const paths = nulSeparatedPaths(await gitBuffer(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], env));
  const manifest: CandidateArtifactUntrackedEntry[] = [];
  for (const relativePath of paths) {
    const absolutePath = path.join(cwd, ...relativePath.split("/"));
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      const target = Buffer.from(await readlink(absolutePath), "utf8");
      manifest.push({
        path: relativePath,
        kind: "symlink",
        mode: "120000",
        bytes: target.byteLength,
        contentHash: sha256(target),
      });
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`unsupported untracked candidate path type: ${relativePath}`);
    }
    const content = await readFile(absolutePath);
    manifest.push({
      path: relativePath,
      kind: "file",
      mode: (stats.mode & 0o111) !== 0 ? "100755" : "100644",
      bytes: content.byteLength,
      contentHash: sha256(content),
    });
  }
  return manifest;
}

async function candidateTreeHash(cwd: string, baseSha: string, env: NodeJS.ProcessEnv) {
  const workspace = await createTemporaryWorkspace({ prefix: "cpb-candidate-index-", env });
  const indexPath = path.join(workspace.rootPath, "index");
  const gitEnv = { ...env, GIT_INDEX_FILE: indexPath };
  let treeHash: string | null = null;
  let primaryError: unknown = null;
  try {
    await gitBuffer(cwd, ["read-tree", baseSha], gitEnv);
    await gitBuffer(cwd, ["add", "-A", "--", "."], gitEnv);
    treeHash = await gitText(cwd, ["write-tree"], gitEnv);
    if (!/^[0-9a-f]{40,64}$/i.test(treeHash)) throw new Error("git write-tree returned an invalid tree id");
  } catch (error) {
    primaryError = error;
  }
  try {
    await workspace.cleanup();
  } catch (cleanupError) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        "candidate tree hashing and temporary-index cleanup failed",
        { cause: cleanupError },
      );
    }
    throw cleanupError;
  }
  if (primaryError) throw primaryError;
  return (treeHash as string).toLowerCase();
}

async function captureRawSnapshot(cwd: string, baseSha: string, env: NodeJS.ProcessEnv): Promise<RawCandidateSnapshot> {
  const [headSha, trackedPatch, trackedChangedFiles, untrackedManifest, treeHash] = await Promise.all([
    resolveCommit(cwd, "HEAD", env),
    gitBuffer(cwd, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", baseSha, "--"], env),
    gitBuffer(cwd, ["diff", "--name-only", "-z", "--no-renames", baseSha, "--"], env).then(nulSeparatedPaths),
    readUntrackedManifest(cwd, env),
    candidateTreeHash(cwd, baseSha, env),
  ]);
  return {
    headSha,
    treeHash,
    trackedPatchHash: sha256(trackedPatch),
    trackedChangedFiles,
    untrackedManifest,
    untrackedManifestHash: canonicalHash(untrackedManifest),
  };
}

function rawSnapshotMatches(left: RawCandidateSnapshot, right: RawCandidateSnapshot) {
  return canonicalJson(left) === canonicalJson(right);
}

function buildCandidateArtifact(baseSha: string, snapshot: RawCandidateSnapshot): CandidateArtifact {
  const untrackedFiles = snapshot.untrackedManifest.map((entry) => entry.path);
  const changedFiles = [...new Set([...snapshot.trackedChangedFiles, ...untrackedFiles])].sort();
  const patchHash = canonicalHash({
    schemaVersion: 1,
    baseSha,
    trackedPatchHash: snapshot.trackedPatchHash,
    untrackedManifestHash: snapshot.untrackedManifestHash,
  });
  const identityFields = {
    schemaVersion: 1 as const,
    baseSha,
    headSha: snapshot.headSha,
    treeHash: snapshot.treeHash,
    trackedPatchHash: snapshot.trackedPatchHash,
    patchHash,
    changedFiles,
    trackedChangedFiles: snapshot.trackedChangedFiles,
    untrackedManifest: snapshot.untrackedManifest,
    untrackedManifestHash: snapshot.untrackedManifestHash,
  };
  return {
    ...identityFields,
    identityHash: canonicalHash(identityFields),
  };
}

/**
 * Capture a stable identity for the complete candidate worktree relative to a
 * base commit. The Git tree includes tracked changes, deletions, executable
 * modes, symlinks, and non-ignored untracked files. The composite patch hash
 * binds the tracked binary diff to the path/content manifest of untracked files.
 */
export async function captureCandidateArtifact({
  cwd,
  base = "HEAD",
  maxSnapshotAttempts = 3,
  env = process.env,
}: CaptureCandidateArtifactOptions): Promise<CandidateArtifact> {
  if (!Number.isInteger(maxSnapshotAttempts) || maxSnapshotAttempts < 1) {
    throw new Error("maxSnapshotAttempts must be a positive integer");
  }
  const root = await repositoryRoot(cwd, env);
  const baseSha = await resolveCommit(root, base, env);
  for (let attempt = 1; attempt <= maxSnapshotAttempts; attempt += 1) {
    const first = await captureRawSnapshot(root, baseSha, env);
    const second = await captureRawSnapshot(root, baseSha, env);
    if (rawSnapshotMatches(first, second)) return buildCandidateArtifact(baseSha, second);
  }
  throw new Error(`candidate worktree changed during ${maxSnapshotAttempts} identity capture attempt(s)`);
}

export function candidateArtifactIdentity(candidate: CandidateArtifact): CandidateArtifactIdentity {
  return {
    schemaVersion: candidate.schemaVersion,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    treeHash: candidate.treeHash,
    trackedPatchHash: candidate.trackedPatchHash,
    patchHash: candidate.patchHash,
    changedFiles: [...candidate.changedFiles],
    trackedChangedFiles: [...candidate.trackedChangedFiles],
    untrackedManifest: candidate.untrackedManifest.map((entry) => ({ ...entry })),
    untrackedManifestHash: candidate.untrackedManifestHash,
    identityHash: candidate.identityHash,
  };
}

export function verifyCandidateArtifactIdentity(
  expectedCandidate: CandidateArtifact,
  actualCandidate: CandidateArtifact,
  { verifiedAt = new Date().toISOString() }: { verifiedAt?: string } = {},
): CandidateArtifactVerificationRecord {
  const expected = candidateArtifactIdentity(expectedCandidate);
  const actual = candidateArtifactIdentity(actualCandidate);
  const mismatches = IDENTITY_FIELDS
    .filter((field) => canonicalJson(expected[field]) !== canonicalJson(actual[field]))
    .map((field) => ({ field, expected: expected[field], actual: actual[field] }));
  return {
    schemaVersion: 1,
    verifiedAt,
    matches: mismatches.length === 0,
    expectedIdentityHash: expected.identityHash,
    actualIdentityHash: actual.identityHash,
    mismatches,
    expected,
    actual,
  };
}

export class CandidateArtifactIdentityMismatchError extends Error {
  readonly verification: CandidateArtifactVerificationRecord;

  constructor(verification: CandidateArtifactVerificationRecord) {
    const fields = verification.mismatches.map((entry) => entry.field).join(", ");
    super(`candidate artifact identity mismatch: ${fields || "unknown"}`);
    this.name = "CandidateArtifactIdentityMismatchError";
    this.verification = verification;
  }
}

export function assertCandidateArtifactIdentityMatch(
  expectedCandidate: CandidateArtifact,
  actualCandidate: CandidateArtifact,
  options: { verifiedAt?: string } = {},
) {
  const verification = verifyCandidateArtifactIdentity(expectedCandidate, actualCandidate, options);
  if (!verification.matches) throw new CandidateArtifactIdentityMismatchError(verification);
  return verification;
}
