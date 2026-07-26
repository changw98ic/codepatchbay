/**
 * Managed worker worktree lifecycle.
 *
 * A producer return value is never treated as proof. Creation independently
 * verifies the Git registration and stores an immutable filesystem/Git
 * binding. Terminal cleanup accepts only that binding and atomically moves the
 * exact directory generation into a private, no-clobber recovery container.
 */

import { execFile as _execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  fstatSync,
  lstatSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  parseManagedWorktreeContext,
  parseWorktreeOwnership,
  sameReadyWorktreeOwnership,
  sameWorktreeDirectoryIdentity,
  type ManagedWorktreeContext,
  type ReadyWorktreeOwnership,
  type WorktreeDirectoryIdentity,
} from "../../core/contracts/worktree-ownership.js";
import { isRecord, type LooseRecord } from "../../core/contracts/types.js";
import { withDurableDirectoryLock } from "../../core/runtime/durable-directory-lock.js";
import { createWorktree } from "../git/worktree.js";

export const WORKTREE_SLUG = "pipeline";
export const WORKTREE_CREATE_MAX_ATTEMPTS = 3;
export const WORKTREE_CREATE_RETRY_DELAY_MS = 500;
export const WORKTREE_QUARANTINE_PREFIX = ".cpb-cleanup-quarantine-";
export const MANAGED_WORKTREE_VERIFICATION_VERSION = 1 as const;
export const MANAGED_WORKTREE_DISPOSITION_VERSION = 1 as const;

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const UNSIGNED_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const execFileAsync = promisify(_execFile);

type WorktreeLog = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
  info?: (message: string) => void;
};

export type ManagedWorktreeGitRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; maxBuffer?: number },
) => Promise<unknown>;

export type ManagedWorktreeVerification = {
  version: typeof MANAGED_WORKTREE_VERIFICATION_VERSION;
  sourcePath: string;
  sourceTopLevel: string;
  sourceCommonDir: string;
  sourceDirectory: WorktreeDirectoryIdentity;
  commonDirectory: WorktreeDirectoryIdentity;
  verifiedAt: string;
};

export type VerifiedManagedWorktreeContext = ManagedWorktreeContext & {
  verification: ManagedWorktreeVerification;
};

export type ManagedWorktreeDisposition = "quarantined" | "retained";

export type ManagedWorktreeCleanupProof = {
  version: typeof MANAGED_WORKTREE_DISPOSITION_VERSION;
  kind: "managed_worktree_disposition";
  disposition: ManagedWorktreeDisposition;
  ok: true;
  dispositionVerified: true;
  cleanupVerified: true;
  canonicalPathRemoved: boolean;
  gitMetadataRetained: true;
  cleanupDeferred: true;
  quarantinePreserved: boolean;
  quarantineContainer: string | null;
  quarantinePath: string | null;
  binding: VerifiedManagedWorktreeContext;
  worktreePath: string;
  worktreesRoot: string;
  branch: string;
  sourcePath: string;
  reason: "terminal_cleanup" | "product_validation_keep";
  completedAt: string;
};

type DirectorySnapshot = {
  canonical: string;
  identity: WorktreeDirectoryIdentity;
  size: string;
  mtimeNs: string;
};

type DirectoryAuthority = {
  path: string;
  label: string;
  handle: Awaited<ReturnType<typeof open>>;
  identity: WorktreeDirectoryIdentity;
};

type GitWorktreeRegistration = {
  worktree: string;
  branch: string | null;
  detached: boolean;
};

type RecoveryTruth = {
  committed: boolean;
  containerCommitted: boolean;
  renameCommitted: boolean;
  removalCommitted: false;
  quarantinePreserved: boolean | null;
  successorPreserved: boolean | null;
  committedPath?: string;
  recoveryPaths: Record<string, string>;
};

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function cleanupError(
  message: string,
  code: string,
  metadata: Record<string, unknown> = {},
  cause?: unknown,
) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code, ...metadata },
  );
}

function exactKeys(value: LooseRecord, expected: string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw cleanupError(`${label} has unexpected or missing fields`, "WORKTREE_CLEANUP_PROOF_INVALID");
  }
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw cleanupError(`${field} must be a non-empty string without NUL bytes`, "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  return value;
}

function requiredAbsolutePath(value: unknown, field: string) {
  const parsed = requiredString(value, field);
  if (!path.isAbsolute(parsed) || path.resolve(parsed) !== parsed) {
    throw cleanupError(`${field} must be an absolute normalized path`, "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  return parsed;
}

function parseTimestamp(value: unknown, field: string) {
  const parsed = requiredString(value, field);
  if (Number.isNaN(Date.parse(parsed))) {
    throw cleanupError(`${field} must be an ISO timestamp`, "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  return parsed;
}

function parseDirectoryIdentity(value: unknown, label: string): WorktreeDirectoryIdentity {
  if (!isRecord(value)) {
    throw cleanupError(`${label} must be an object`, "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  exactKeys(value, ["dev", "ino", "birthtimeNs", "mode", "uid", "gid"], label);
  const parsed: WorktreeDirectoryIdentity = {
    dev: requiredString(value.dev, `${label}.dev`),
    ino: requiredString(value.ino, `${label}.ino`),
    birthtimeNs: requiredString(value.birthtimeNs, `${label}.birthtimeNs`),
    mode: requiredString(value.mode, `${label}.mode`),
    uid: requiredString(value.uid, `${label}.uid`),
    gid: requiredString(value.gid, `${label}.gid`),
  };
  for (const [field, entry] of Object.entries(parsed)) {
    if (!UNSIGNED_INTEGER.test(entry)) {
      throw cleanupError(`${label}.${field} must be an unsigned decimal integer`, "WORKTREE_CLEANUP_PROOF_INVALID");
    }
  }
  if (parsed.ino === "0") {
    throw cleanupError(`${label}.ino must be non-zero`, "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  return parsed;
}

function statsIdentity(info: {
  dev: number | bigint;
  ino: number | bigint;
  birthtimeNs?: bigint;
  birthtimeMs: number | bigint;
  mode: number | bigint;
  uid: number | bigint;
  gid: number | bigint;
}): WorktreeDirectoryIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: info.birthtimeNs === undefined
      ? String(typeof info.birthtimeMs === "bigint"
        ? info.birthtimeMs * 1_000_000n
        : BigInt(Math.trunc(info.birthtimeMs * 1_000_000)))
      : String(info.birthtimeNs),
    mode: String(info.mode),
    uid: String(info.uid),
    gid: String(info.gid),
  };
}

function sameSnapshot(left: DirectorySnapshot, right: DirectorySnapshot) {
  return sameWorktreeDirectoryIdentity(left.identity, right.identity)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

async function captureStableDirectory(candidateInput: string, label: string): Promise<DirectorySnapshot> {
  const candidate = path.resolve(candidateInput);
  let before;
  try {
    before = await lstat(candidate, { bigint: true });
  } catch (cause) {
    throw cleanupError(`${label} is unavailable: ${candidate}`, "WORKTREE_CLEANUP_TARGET_UNSAFE", {
      committed: false,
      recoveryPaths: { directory: candidate },
    }, cause);
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw cleanupError(`${label} must be a real directory: ${candidate}`, "WORKTREE_CLEANUP_TARGET_UNSAFE", {
      committed: false,
      successorPreserved: true,
      recoveryPaths: { directory: candidate },
    });
  }
  const canonical = await realpath(candidate);
  const after = await lstat(candidate, { bigint: true });
  const beforeSnapshot: DirectorySnapshot = {
    canonical,
    identity: statsIdentity(before),
    size: String(before.size),
    mtimeNs: String(before.mtimeNs),
  };
  const afterSnapshot: DirectorySnapshot = {
    canonical,
    identity: statsIdentity(after),
    size: String(after.size),
    mtimeNs: String(after.mtimeNs),
  };
  if (
    !after.isDirectory()
    || after.isSymbolicLink()
    || !sameSnapshot(beforeSnapshot, afterSnapshot)
  ) {
    throw cleanupError(`${label} changed while being inspected: ${candidate}`, "WORKTREE_CLEANUP_GENERATION_CONFLICT", {
      committed: false,
      successorPreserved: true,
      recoveryPaths: { directory: candidate },
    });
  }
  return afterSnapshot;
}

function strictDirectoryOpenFlags() {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw cleanupError("no-follow directory opens are unavailable", "WORKTREE_CLEANUP_PARENT_UNSAFE", {
      committed: false,
    });
  }
  return constants.O_RDONLY | (constants.O_DIRECTORY || 0) | constants.O_NOFOLLOW;
}

async function openDirectoryAuthority(
  directoryPath: string,
  label: string,
  expected?: WorktreeDirectoryIdentity,
): Promise<DirectoryAuthority> {
  const snapshot = await captureStableDirectory(directoryPath, label);
  if (expected && !sameWorktreeDirectoryIdentity(snapshot.identity, expected)) {
    throw cleanupError(`${label} does not match its create-time identity: ${directoryPath}`, "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      successorPreserved: true,
      recoveryPaths: { directory: directoryPath },
    });
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(directoryPath, strictDirectoryOpenFlags());
  } catch (cause) {
    throw cleanupError(`${label} could not be pinned: ${directoryPath}`, "WORKTREE_CLEANUP_PARENT_UNSAFE", {
      committed: false,
      recoveryPaths: { directory: directoryPath },
    }, cause);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isDirectory() || !sameWorktreeDirectoryIdentity(snapshot.identity, statsIdentity(opened))) {
      throw cleanupError(`${label} changed while being pinned: ${directoryPath}`, "WORKTREE_CLEANUP_PARENT_UNSAFE", {
        committed: false,
        successorPreserved: true,
        recoveryPaths: { directory: directoryPath },
      });
    }
    return { path: directoryPath, label, handle, identity: snapshot.identity };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function validateDirectoryAuthoritySync(authority: DirectoryAuthority, metadata: Record<string, unknown>) {
  let descriptor;
  let current;
  try {
    descriptor = fstatSync(authority.handle.fd, { bigint: true });
    current = lstatSync(authority.path, { bigint: true });
  } catch (cause) {
    throw cleanupError(`${authority.label} authority became unavailable: ${authority.path}`, "WORKTREE_CLEANUP_PARENT_UNSAFE", metadata, cause);
  }
  if (
    !descriptor.isDirectory()
    || !current.isDirectory()
    || current.isSymbolicLink()
    || realpathSync(authority.path) !== authority.path
    || !sameWorktreeDirectoryIdentity(authority.identity, statsIdentity(descriptor))
    || !sameWorktreeDirectoryIdentity(authority.identity, statsIdentity(current))
  ) {
    throw cleanupError(`${authority.label} authority changed: ${authority.path}`, "WORKTREE_CLEANUP_PARENT_UNSAFE", metadata);
  }
}

function assertDirectoryIdentitySync(
  directoryPath: string,
  expected: WorktreeDirectoryIdentity,
  metadata: Record<string, unknown>,
) {
  let current;
  try {
    current = lstatSync(directoryPath, { bigint: true });
  } catch (cause) {
    throw cleanupError(`managed worktree became unavailable: ${directoryPath}`, "WORKTREE_CLEANUP_GENERATION_CONFLICT", metadata, cause);
  }
  if (
    !current.isDirectory()
    || current.isSymbolicLink()
    || realpathSync(directoryPath) !== directoryPath
    || !sameWorktreeDirectoryIdentity(expected, statsIdentity(current))
  ) {
    throw cleanupError(`managed worktree no longer matches its create-time identity: ${directoryPath}`, "WORKTREE_CLEANUP_GENERATION_CONFLICT", metadata);
  }
}

function assertMissingSync(candidate: string, metadata: Record<string, unknown>) {
  try {
    lstatSync(candidate);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw cleanupError(`path could not be checked for no-clobber rename: ${candidate}`, "WORKTREE_CLEANUP_QUARANTINE_CONFLICT", metadata, error);
  }
  throw cleanupError(`no-clobber rename destination is occupied: ${candidate}`, "WORKTREE_CLEANUP_QUARANTINE_CONFLICT", {
    ...metadata,
    successorPreserved: true,
  });
}

function assertSafeComponent(name: string, value: unknown) {
  if (typeof value !== "string" || !SAFE_COMPONENT.test(value)) {
    throw cleanupError(`invalid managed worktree ${name}`, "WORKTREE_CLEANUP_PATH_MISMATCH", {
      committed: false,
    });
  }
}

function managedCoordinates(hubRootInput: string, entryId: string, slug: string) {
  assertSafeComponent("entryId", entryId);
  assertSafeComponent("slug", slug);
  const hubRoot = path.resolve(hubRootInput);
  const worktreesRoot = path.join(hubRoot, "worktrees");
  const worktreeJobId = `job-${entryId}`;
  const worktreePath = path.join(worktreesRoot, `${worktreeJobId}-${slug}`);
  const branch = `cpb/${worktreeJobId}-${slug}`;
  const lockRoot = path.join(hubRoot, ".locks");
  const lockPath = path.join(lockRoot, "managed-worktrees.lock");
  return { hubRoot, worktreesRoot, worktreePath, branch, lockRoot, lockPath, worktreeJobId };
}

async function ensureManagedNamespace(hubRootInput: string, entryId: string, slug: string) {
  const hub = await captureStableDirectory(hubRootInput, "Hub root");
  const coordinates = managedCoordinates(hub.canonical, entryId, slug);
  await mkdir(coordinates.lockRoot, { recursive: true });
  const lockRoot = await captureStableDirectory(coordinates.lockRoot, "managed worktree lock root");
  if (lockRoot.canonical !== coordinates.lockRoot) {
    throw cleanupError("managed worktree lock root is not canonical", "WORKTREE_CLEANUP_PARENT_UNSAFE", {
      committed: false,
      recoveryPaths: { lockRoot: coordinates.lockRoot },
    });
  }
  await mkdir(coordinates.worktreesRoot, { recursive: true });
  const worktreesRoot = await captureStableDirectory(coordinates.worktreesRoot, "managed worktrees root");
  if (worktreesRoot.canonical !== coordinates.worktreesRoot) {
    throw cleanupError("managed worktrees root is not canonical", "WORKTREE_CLEANUP_PARENT_UNSAFE", {
      committed: false,
      recoveryPaths: { parent: coordinates.worktreesRoot },
    });
  }
  return coordinates;
}

function parseVerification(value: unknown): ManagedWorktreeVerification {
  if (!isRecord(value)) {
    throw cleanupError("managed worktree verification must be an object", "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  exactKeys(value, [
    "version",
    "sourcePath",
    "sourceTopLevel",
    "sourceCommonDir",
    "sourceDirectory",
    "commonDirectory",
    "verifiedAt",
  ], "managed worktree verification");
  if (value.version !== MANAGED_WORKTREE_VERIFICATION_VERSION) {
    throw cleanupError(`managed worktree verification version must be ${MANAGED_WORKTREE_VERIFICATION_VERSION}`, "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  return {
    version: MANAGED_WORKTREE_VERIFICATION_VERSION,
    sourcePath: requiredAbsolutePath(value.sourcePath, "managed worktree verification.sourcePath"),
    sourceTopLevel: requiredAbsolutePath(value.sourceTopLevel, "managed worktree verification.sourceTopLevel"),
    sourceCommonDir: requiredAbsolutePath(value.sourceCommonDir, "managed worktree verification.sourceCommonDir"),
    sourceDirectory: parseDirectoryIdentity(value.sourceDirectory, "managed worktree verification.sourceDirectory"),
    commonDirectory: parseDirectoryIdentity(value.commonDirectory, "managed worktree verification.commonDirectory"),
    verifiedAt: parseTimestamp(value.verifiedAt, "managed worktree verification.verifiedAt"),
  };
}

export function parseVerifiedManagedWorktreeContext(value: unknown): VerifiedManagedWorktreeContext {
  if (!isRecord(value)) {
    throw cleanupError("verified managed worktree context must be an object", "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  exactKeys(value, ["path", "branch", "baseBranch", "baseCommit", "ownership", "verification"], "verified managed worktree context");
  const context = parseManagedWorktreeContext({
    path: value.path,
    branch: value.branch,
    baseBranch: value.baseBranch,
    baseCommit: value.baseCommit,
    ownership: value.ownership,
  });
  return { ...context, verification: parseVerification(value.verification) };
}

export function managedWorktreeContext(
  value: VerifiedManagedWorktreeContext,
): ManagedWorktreeContext {
  const parsed = parseVerifiedManagedWorktreeContext(value);
  return {
    path: parsed.path,
    branch: parsed.branch,
    baseBranch: parsed.baseBranch,
    baseCommit: parsed.baseCommit,
    ownership: parsed.ownership,
  };
}

function sameVerification(left: ManagedWorktreeVerification, right: ManagedWorktreeVerification) {
  return left.version === right.version
    && left.sourcePath === right.sourcePath
    && left.sourceTopLevel === right.sourceTopLevel
    && left.sourceCommonDir === right.sourceCommonDir
    && sameWorktreeDirectoryIdentity(left.sourceDirectory, right.sourceDirectory)
    && sameWorktreeDirectoryIdentity(left.commonDirectory, right.commonDirectory)
    && left.verifiedAt === right.verifiedAt;
}

function sameVerifiedBinding(left: VerifiedManagedWorktreeContext, right: VerifiedManagedWorktreeContext) {
  return left.path === right.path
    && left.branch === right.branch
    && left.baseBranch === right.baseBranch
    && left.baseCommit === right.baseCommit
    && sameReadyWorktreeOwnership(left.ownership, right.ownership)
    && sameVerification(left.verification, right.verification);
}

async function defaultGitRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; maxBuffer?: number },
) {
  return await execFileAsync(command, args, {
    cwd: opts.cwd,
    maxBuffer: opts.maxBuffer,
    encoding: "utf8",
  });
}

async function gitText(
  runGit: ManagedWorktreeGitRunner,
  repository: string,
  args: string[],
  label: string,
) {
  let result: unknown;
  try {
    result = await runGit("git", ["-C", repository, ...args], {
      cwd: repository,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
  } catch (cause) {
    throw cleanupError(`Git verification failed (${label})`, "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      recoveryPaths: { repository },
    }, cause);
  }
  if (!isRecord(result) || (typeof result.stdout !== "string" && !Buffer.isBuffer(result.stdout))) {
    throw cleanupError(`Git verifier returned no stdout (${label})`, "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      recoveryPaths: { repository },
    });
  }
  return String(result.stdout);
}

async function resolveGitDirectory(repository: string, raw: string, label: string) {
  const reported = raw.trim();
  if (!reported || reported.includes("\0")) {
    throw cleanupError(`Git returned an invalid directory (${label})`, "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      recoveryPaths: { repository },
    });
  }
  return await captureStableDirectory(path.isAbsolute(reported) ? reported : path.resolve(repository, reported), label);
}

function parseWorktreeRegistrations(raw: string): GitWorktreeRegistration[] {
  const tokens = raw.includes("\0") ? raw.split("\0") : raw.split(/\r?\n/);
  const registrations: GitWorktreeRegistration[] = [];
  let current: GitWorktreeRegistration | null = null;
  const finish = () => {
    if (current) registrations.push(current);
    current = null;
  };
  for (const token of tokens) {
    if (token === "") {
      finish();
      continue;
    }
    if (token.startsWith("worktree ")) {
      finish();
      current = { worktree: path.resolve(token.slice("worktree ".length)), branch: null, detached: false };
    } else if (current && token.startsWith("branch ")) {
      current.branch = token.slice("branch ".length);
    } else if (current && token === "detached") {
      current.detached = true;
    }
  }
  finish();
  return registrations;
}

async function verifyManagedGitBinding({
  sourcePath,
  context,
  runGit,
  phase,
  expectedVerification,
}: {
  sourcePath: string;
  context: ManagedWorktreeContext;
  runGit: ManagedWorktreeGitRunner;
  phase: "create" | "cleanup" | "retention";
  expectedVerification?: ManagedWorktreeVerification;
}): Promise<ManagedWorktreeVerification> {
  const source = await captureStableDirectory(sourcePath, "source repository");
  const target = await captureStableDirectory(context.path, "managed worktree");
  if (!sameWorktreeDirectoryIdentity(target.identity, context.ownership.directory)) {
    throw cleanupError("managed worktree directory does not match producer ownership", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      successorPreserved: true,
      recoveryPaths: { canonical: context.path },
    });
  }

  const sourceTop = await resolveGitDirectory(
    source.canonical,
    await gitText(runGit, source.canonical, ["rev-parse", "--show-toplevel"], "source top-level"),
    "source Git top-level",
  );
  if (sourceTop.canonical !== source.canonical) {
    throw cleanupError("source path is not the Git top-level checkout", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      recoveryPaths: { source: source.canonical, topLevel: sourceTop.canonical },
    });
  }
  const sourceCommon = await resolveGitDirectory(
    source.canonical,
    await gitText(runGit, source.canonical, ["rev-parse", "--git-common-dir"], "source common dir"),
    "source Git common directory",
  );
  const worktreeTop = await resolveGitDirectory(
    context.path,
    await gitText(runGit, context.path, ["rev-parse", "--show-toplevel"], "worktree top-level"),
    "worktree Git top-level",
  );
  if (worktreeTop.canonical !== context.path) {
    throw cleanupError("managed worktree is not its Git top-level checkout", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      recoveryPaths: { canonical: context.path, topLevel: worktreeTop.canonical },
    });
  }
  const worktreeCommon = await resolveGitDirectory(
    context.path,
    await gitText(runGit, context.path, ["rev-parse", "--git-common-dir"], "worktree common dir"),
    "worktree Git common directory",
  );
  if (worktreeCommon.canonical !== sourceCommon.canonical) {
    throw cleanupError("managed worktree does not share the source Git common directory", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      recoveryPaths: { sourceCommonDir: sourceCommon.canonical, worktreeCommonDir: worktreeCommon.canonical },
    });
  }

  const registrations = parseWorktreeRegistrations(
    await gitText(runGit, source.canonical, ["worktree", "list", "--porcelain", "-z"], "worktree registration"),
  );
  const expectedRef = `refs/heads/${context.branch}`;
  const pathMatches = registrations.filter((entry) => entry.worktree === context.path);
  const branchMatches = registrations.filter((entry) => entry.branch === expectedRef);
  if (
    pathMatches.length !== 1
    || branchMatches.length !== 1
    || pathMatches[0] !== branchMatches[0]
    || pathMatches[0].detached
  ) {
    throw cleanupError("managed worktree is not uniquely registered to its expected symbolic branch", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      successorPreserved: true,
      recoveryPaths: { canonical: context.path },
    });
  }

  const symbolicBranch = (await gitText(
    runGit,
    context.path,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "worktree symbolic HEAD",
  )).trim();
  if (symbolicBranch !== context.branch) {
    throw cleanupError("managed worktree symbolic HEAD does not match its binding", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      successorPreserved: true,
      recoveryPaths: { canonical: context.path },
    });
  }
  const worktreeHead = (await gitText(runGit, context.path, ["rev-parse", "--verify", "HEAD"], "worktree HEAD")).trim();
  if (!COMMIT.test(worktreeHead) || (phase === "create" && worktreeHead !== context.baseCommit)) {
    throw cleanupError("managed worktree HEAD does not satisfy its base binding", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      recoveryPaths: { canonical: context.path },
    });
  }

  const bindingRaw = (await gitText(
    runGit,
    source.canonical,
    ["config", "--local", "--get", `branch.${context.branch}.cpbBaseBinding`],
    "durable base binding",
  )).trim();
  let durableOwnership: ReadyWorktreeOwnership;
  try {
    durableOwnership = parseWorktreeOwnership(JSON.parse(bindingRaw)) as ReadyWorktreeOwnership;
  } catch (cause) {
    throw cleanupError("managed worktree durable base binding is invalid", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      recoveryPaths: { source: source.canonical },
    }, cause);
  }
  if (!sameReadyWorktreeOwnership(durableOwnership, context.ownership)) {
    throw cleanupError("managed worktree durable base binding differs from create-time ownership", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      successorPreserved: true,
      recoveryPaths: { canonical: context.path, source: source.canonical },
    });
  }

  if (phase === "create") {
    const sourceBranch = (await gitText(
      runGit,
      source.canonical,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      "source symbolic HEAD",
    )).trim();
    const sourceHead = (await gitText(runGit, source.canonical, ["rev-parse", "--verify", "HEAD"], "source HEAD")).trim();
    if (sourceBranch !== context.baseBranch || sourceHead !== context.baseCommit) {
      throw cleanupError("source checkout no longer matches the producer base branch/commit", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
        committed: false,
        recoveryPaths: { source: source.canonical },
      });
    }
  }

  const verification: ManagedWorktreeVerification = {
    version: MANAGED_WORKTREE_VERIFICATION_VERSION,
    sourcePath: source.canonical,
    sourceTopLevel: sourceTop.canonical,
    sourceCommonDir: sourceCommon.canonical,
    sourceDirectory: source.identity,
    commonDirectory: sourceCommon.identity,
    verifiedAt: expectedVerification?.verifiedAt || new Date().toISOString(),
  };
  if (expectedVerification && !sameVerification(verification, expectedVerification)) {
    throw cleanupError("source/common-dir no longer matches the create-time verification", "WORKTREE_CLEANUP_BINDING_MISMATCH", {
      committed: false,
      successorPreserved: true,
      recoveryPaths: {
        source: source.canonical,
        commonDir: sourceCommon.canonical,
        canonical: context.path,
      },
    });
  }
  return verification;
}

function assertCoordinatesAndSource(
  coordinates: ReturnType<typeof managedCoordinates>,
  binding: VerifiedManagedWorktreeContext,
  sourcePathInput: string,
) {
  const sourcePath = path.resolve(sourcePathInput);
  if (
    binding.path !== coordinates.worktreePath
    || binding.branch !== coordinates.branch
    || binding.verification.sourcePath !== sourcePath
    || binding.verification.sourceTopLevel !== sourcePath
  ) {
    throw cleanupError("managed worktree binding does not match the exact assignment coordinates", "WORKTREE_CLEANUP_PATH_MISMATCH", {
      committed: false,
      successorPreserved: true,
      recoveryPaths: {
        canonical: coordinates.worktreePath,
        observed: binding.path,
        source: sourcePath,
      },
    });
  }
}

function dispositionProof(
  binding: VerifiedManagedWorktreeContext,
  worktreesRoot: string,
  disposition: ManagedWorktreeDisposition,
  reason: ManagedWorktreeCleanupProof["reason"],
  quarantineContainer: string | null,
  quarantinePath: string | null,
): ManagedWorktreeCleanupProof {
  return {
    version: MANAGED_WORKTREE_DISPOSITION_VERSION,
    kind: "managed_worktree_disposition",
    disposition,
    ok: true,
    dispositionVerified: true,
    cleanupVerified: true,
    canonicalPathRemoved: disposition === "quarantined",
    gitMetadataRetained: true,
    cleanupDeferred: true,
    quarantinePreserved: disposition === "quarantined",
    quarantineContainer,
    quarantinePath,
    binding,
    worktreePath: binding.path,
    worktreesRoot,
    branch: binding.branch,
    sourcePath: binding.verification.sourcePath,
    reason,
    completedAt: new Date().toISOString(),
  };
}

export function parseManagedWorktreeDispositionProof(
  value: unknown,
  expectedBinding?: VerifiedManagedWorktreeContext,
): ManagedWorktreeCleanupProof {
  if (!isRecord(value)) {
    throw cleanupError("managed worktree disposition proof must be an object", "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  exactKeys(value, [
    "version",
    "kind",
    "disposition",
    "ok",
    "dispositionVerified",
    "cleanupVerified",
    "canonicalPathRemoved",
    "gitMetadataRetained",
    "cleanupDeferred",
    "quarantinePreserved",
    "quarantineContainer",
    "quarantinePath",
    "binding",
    "worktreePath",
    "worktreesRoot",
    "branch",
    "sourcePath",
    "reason",
    "completedAt",
  ], "managed worktree disposition proof");
  if (
    value.version !== MANAGED_WORKTREE_DISPOSITION_VERSION
    || value.kind !== "managed_worktree_disposition"
    || (value.disposition !== "quarantined" && value.disposition !== "retained")
    || value.ok !== true
    || value.dispositionVerified !== true
    || value.cleanupVerified !== true
    || value.gitMetadataRetained !== true
    || value.cleanupDeferred !== true
  ) {
    throw cleanupError("managed worktree disposition proof has invalid literals", "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  const binding = parseVerifiedManagedWorktreeContext(value.binding);
  if (expectedBinding && !sameVerifiedBinding(binding, parseVerifiedManagedWorktreeContext(expectedBinding))) {
    throw cleanupError("managed worktree disposition proof is bound to a different worktree", "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  const worktreePath = requiredAbsolutePath(value.worktreePath, "managed worktree disposition proof.worktreePath");
  const worktreesRoot = requiredAbsolutePath(value.worktreesRoot, "managed worktree disposition proof.worktreesRoot");
  const branch = requiredString(value.branch, "managed worktree disposition proof.branch");
  const sourcePath = requiredAbsolutePath(value.sourcePath, "managed worktree disposition proof.sourcePath");
  if (
    worktreePath !== binding.path
    || path.dirname(worktreePath) !== worktreesRoot
    || branch !== binding.branch
    || sourcePath !== binding.verification.sourcePath
  ) {
    throw cleanupError("managed worktree disposition proof coordinates do not match its binding", "WORKTREE_CLEANUP_PROOF_INVALID");
  }
  const disposition = value.disposition as ManagedWorktreeDisposition;
  let quarantineContainer: string | null = null;
  let quarantinePath: string | null = null;
  let reason: ManagedWorktreeCleanupProof["reason"];
  if (disposition === "quarantined") {
    if (
      value.canonicalPathRemoved !== true
      || value.quarantinePreserved !== true
      || value.reason !== "terminal_cleanup"
    ) {
      throw cleanupError("quarantined disposition proof has invalid state", "WORKTREE_CLEANUP_PROOF_INVALID");
    }
    quarantineContainer = requiredAbsolutePath(value.quarantineContainer, "managed worktree disposition proof.quarantineContainer");
    quarantinePath = requiredAbsolutePath(value.quarantinePath, "managed worktree disposition proof.quarantinePath");
    if (
      path.dirname(quarantineContainer) !== worktreesRoot
      || !path.basename(quarantineContainer).startsWith(WORKTREE_QUARANTINE_PREFIX)
      || quarantinePath !== path.join(quarantineContainer, "worktree")
    ) {
      throw cleanupError("quarantined disposition proof has an invalid recovery container", "WORKTREE_CLEANUP_PROOF_INVALID");
    }
    reason = "terminal_cleanup";
  } else {
    if (
      value.canonicalPathRemoved !== false
      || value.quarantinePreserved !== false
      || value.quarantineContainer !== null
      || value.quarantinePath !== null
      || value.reason !== "product_validation_keep"
    ) {
      throw cleanupError("retained disposition proof has invalid state", "WORKTREE_CLEANUP_PROOF_INVALID");
    }
    reason = "product_validation_keep";
  }
  return {
    version: MANAGED_WORKTREE_DISPOSITION_VERSION,
    kind: "managed_worktree_disposition",
    disposition,
    ok: true,
    dispositionVerified: true,
    cleanupVerified: true,
    canonicalPathRemoved: disposition === "quarantined",
    gitMetadataRetained: true,
    cleanupDeferred: true,
    quarantinePreserved: disposition === "quarantined",
    quarantineContainer,
    quarantinePath,
    binding,
    worktreePath,
    worktreesRoot,
    branch,
    sourcePath,
    reason,
    completedAt: parseTimestamp(value.completedAt, "managed worktree disposition proof.completedAt"),
  };
}

export type ManagedWorktreeCleanupHooks = {
  afterTargetObserved?: (context: { worktreePath: string }) => void | Promise<void>;
  beforeQuarantineRename?: (context: {
    worktreePath: string;
    quarantineContainer: string;
    quarantinePath: string;
  }) => void | Promise<void>;
  afterQuarantineRename?: (context: {
    worktreePath: string;
    quarantineContainer: string;
    quarantinePath: string;
  }) => void | Promise<void>;
  closeAuthority?: (context: {
    label: string;
    path: string;
    close: () => Promise<void>;
  }) => void | Promise<void>;
};

type CleanupManagedWorkerWorktreeOptions = {
  hubRoot: string;
  sourcePath: string;
  entryId: string;
  managedWorktree: unknown;
  slug?: string;
  runGit?: ManagedWorktreeGitRunner;
  hooks?: ManagedWorktreeCleanupHooks;
};

function recoveryTruthError(primary: unknown, closeErrors: unknown[], truth: RecoveryTruth) {
  if (!truth.containerCommitted && !truth.renameCommitted && closeErrors.length === 0) {
    throw primary;
  }
  const causes = [primary, ...closeErrors].filter((entry) => entry !== null && entry !== undefined);
  const verifiedQuarantine = truth.quarantinePreserved === true && typeof truth.committedPath === "string";
  const message = verifiedQuarantine
    ? `managed worktree quarantine is committed and preserved at ${truth.committedPath}`
    : "managed worktree cleanup stopped with recovery state preserved";
  const wrapped = causes.length > 1
    ? new AggregateError(causes, message, { cause: causes[0] })
    : new Error(message, { cause: causes[0] });
  throw Object.assign(wrapped, {
    code: verifiedQuarantine
      ? "WORKTREE_CLEANUP_QUARANTINE_PRESERVED"
      : "WORKTREE_CLEANUP_RECOVERY_REQUIRED",
    ...truth,
    primaryError: primary,
    closeErrors,
  });
}

async function closeAuthorities(
  authorities: Array<DirectoryAuthority | null>,
  closeAuthority?: ManagedWorktreeCleanupHooks["closeAuthority"],
) {
  const errors: unknown[] = [];
  for (const authority of [...authorities].reverse()) {
    if (!authority) continue;
    try {
      const close = async () => await authority.handle.close();
      if (closeAuthority) {
        await closeAuthority({ label: authority.label, path: authority.path, close });
      } else {
        await close();
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function pathPresence(candidate: string): Promise<boolean | null> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT" ? false : null;
  }
}

async function observeBoundDirectory(
  candidate: string,
  expected: WorktreeDirectoryIdentity,
): Promise<boolean | null> {
  let before;
  let canonical;
  let after;
  try {
    before = await lstat(candidate, { bigint: true });
    canonical = await realpath(candidate);
    after = await lstat(candidate, { bigint: true });
  } catch (error) {
    return errorCode(error) === "ENOENT" ? false : null;
  }
  if (
    !before.isDirectory()
    || before.isSymbolicLink()
    || !after.isDirectory()
    || after.isSymbolicLink()
    || canonical !== candidate
  ) {
    return false;
  }
  const beforeSnapshot: DirectorySnapshot = {
    canonical,
    identity: statsIdentity(before),
    size: String(before.size),
    mtimeNs: String(before.mtimeNs),
  };
  const afterSnapshot: DirectorySnapshot = {
    canonical,
    identity: statsIdentity(after),
    size: String(after.size),
    mtimeNs: String(after.mtimeNs),
  };
  return sameSnapshot(beforeSnapshot, afterSnapshot)
    && sameWorktreeDirectoryIdentity(afterSnapshot.identity, expected);
}

async function observeRecoveryTruth(
  binding: VerifiedManagedWorktreeContext,
  truth: RecoveryTruth,
): Promise<RecoveryTruth> {
  const { committedPath: _cachedCommittedPath, ...historical } = truth;
  const observed: RecoveryTruth = {
    ...historical,
    quarantinePreserved: false,
    successorPreserved: await pathPresence(binding.path),
  };
  if (!truth.renameCommitted) return observed;
  const quarantinePath = truth.recoveryPaths.quarantine;
  if (!quarantinePath) {
    observed.quarantinePreserved = null;
    return observed;
  }
  observed.quarantinePreserved = await observeBoundDirectory(
    quarantinePath,
    binding.ownership.directory,
  );
  if (observed.quarantinePreserved === true) {
    observed.committedPath = quarantinePath;
  }
  return observed;
}

async function cleanupManagedWorkerWorktreeUnlocked({
  hubRoot,
  sourcePath,
  entryId,
  managedWorktree,
  slug = WORKTREE_SLUG,
  runGit = defaultGitRunner,
  hooks = {},
}: CleanupManagedWorkerWorktreeOptions): Promise<ManagedWorktreeCleanupProof> {
  const coordinates = managedCoordinates(hubRoot, entryId, slug);
  const binding = parseVerifiedManagedWorktreeContext(managedWorktree);
  const canonicalSourcePath = (await captureStableDirectory(sourcePath, "source repository")).canonical;
  assertCoordinatesAndSource(coordinates, binding, canonicalSourcePath);
  await verifyManagedGitBinding({
    sourcePath: canonicalSourcePath,
    context: managedWorktreeContext(binding),
    runGit,
    phase: "cleanup",
    expectedVerification: binding.verification,
  });

  let rootAuthority: DirectoryAuthority | null = null;
  let sourceAuthority: DirectoryAuthority | null = null;
  let commonAuthority: DirectoryAuthority | null = null;
  let containerAuthority: DirectoryAuthority | null = null;
  let result: ManagedWorktreeCleanupProof | null = null;
  let primaryError: unknown = null;
  let quarantineContainer: string | null = null;
  let quarantinePath: string | null = null;
  const truth: RecoveryTruth = {
    committed: false,
    containerCommitted: false,
    renameCommitted: false,
    removalCommitted: false,
    quarantinePreserved: false,
    successorPreserved: false,
    recoveryPaths: { canonical: binding.path },
  };

  try {
    rootAuthority = await openDirectoryAuthority(coordinates.worktreesRoot, "managed worktrees root");
    sourceAuthority = await openDirectoryAuthority(
      binding.verification.sourcePath,
      "source repository",
      binding.verification.sourceDirectory,
    );
    commonAuthority = await openDirectoryAuthority(
      binding.verification.sourceCommonDir,
      "source Git common directory",
      binding.verification.commonDirectory,
    );
    const observed = await captureStableDirectory(binding.path, "managed worktree");
    if (!sameWorktreeDirectoryIdentity(observed.identity, binding.ownership.directory)) {
      throw cleanupError("managed worktree is a successor of the create-time directory", "WORKTREE_CLEANUP_GENERATION_CONFLICT", {
        committed: false,
        successorPreserved: true,
        recoveryPaths: { canonical: binding.path },
      });
    }
    await hooks.afterTargetObserved?.({ worktreePath: binding.path });

    quarantineContainer = path.join(
      coordinates.worktreesRoot,
      `${WORKTREE_QUARANTINE_PREFIX}${path.basename(binding.path)}-${Date.now()}-${randomUUID()}`,
    );
    quarantinePath = path.join(quarantineContainer, "worktree");
    await mkdir(quarantineContainer, { mode: 0o700 });
    truth.containerCommitted = true;
    truth.recoveryPaths = {
      canonical: binding.path,
      quarantineContainer,
      quarantine: quarantinePath,
    };
    containerAuthority = await openDirectoryAuthority(quarantineContainer, "managed worktree quarantine container");
    if ((BigInt(containerAuthority.identity.mode) & 0o77n) !== 0n) {
      throw cleanupError("managed worktree quarantine container is not private", "WORKTREE_CLEANUP_QUARANTINE_CONFLICT", truth);
    }
    await rootAuthority.handle.sync();
    validateDirectoryAuthoritySync(rootAuthority, truth);
    validateDirectoryAuthoritySync(containerAuthority, truth);
    assertMissingSync(quarantinePath, truth);

    await hooks.beforeQuarantineRename?.({
      worktreePath: binding.path,
      quarantineContainer,
      quarantinePath,
    });
    await verifyManagedGitBinding({
      sourcePath: canonicalSourcePath,
      context: managedWorktreeContext(binding),
      runGit,
      phase: "cleanup",
      expectedVerification: binding.verification,
    });

    const beforeRename = await captureStableDirectory(binding.path, "managed worktree before quarantine");
    if (!sameWorktreeDirectoryIdentity(beforeRename.identity, binding.ownership.directory)) {
      throw cleanupError("managed worktree changed before quarantine", "WORKTREE_CLEANUP_GENERATION_CONFLICT", truth);
    }
    validateDirectoryAuthoritySync(rootAuthority, truth);
    validateDirectoryAuthoritySync(sourceAuthority, truth);
    validateDirectoryAuthoritySync(commonAuthority, truth);
    validateDirectoryAuthoritySync(containerAuthority, truth);
    assertDirectoryIdentitySync(binding.path, binding.ownership.directory, truth);
    assertMissingSync(quarantinePath, truth);
    renameSync(binding.path, quarantinePath);
    truth.committed = true;
    truth.renameCommitted = true;
    truth.quarantinePreserved = null;

    await hooks.afterQuarantineRename?.({
      worktreePath: binding.path,
      quarantineContainer,
      quarantinePath,
    });
    validateDirectoryAuthoritySync(rootAuthority, truth);
    validateDirectoryAuthoritySync(sourceAuthority, truth);
    validateDirectoryAuthoritySync(commonAuthority, truth);
    validateDirectoryAuthoritySync(containerAuthority, truth);
    try {
      assertMissingSync(binding.path, truth);
    } catch (error) {
      truth.successorPreserved = true;
      throw error;
    }
    const quarantined = await captureStableDirectory(quarantinePath, "quarantined managed worktree");
    if (!sameSnapshot(beforeRename, quarantined)) {
      throw cleanupError("quarantined worktree does not match the renamed directory generation", "WORKTREE_CLEANUP_QUARANTINE_PRESERVED", truth);
    }
    truth.quarantinePreserved = true;
    truth.committedPath = quarantinePath;

    await containerAuthority.handle.sync();
    await rootAuthority.handle.sync();
    validateDirectoryAuthoritySync(rootAuthority, truth);
    validateDirectoryAuthoritySync(sourceAuthority, truth);
    validateDirectoryAuthoritySync(commonAuthority, truth);
    validateDirectoryAuthoritySync(containerAuthority, truth);
    try {
      assertMissingSync(binding.path, truth);
    } catch (error) {
      truth.successorPreserved = true;
      throw error;
    }
    const durable = await captureStableDirectory(quarantinePath, "durable quarantined managed worktree");
    if (!sameSnapshot(quarantined, durable)) {
      throw cleanupError("quarantined worktree changed before durability confirmation", "WORKTREE_CLEANUP_QUARANTINE_PRESERVED", truth);
    }
    result = dispositionProof(
      binding,
      coordinates.worktreesRoot,
      "quarantined",
      "terminal_cleanup",
      quarantineContainer,
      quarantinePath,
    );
  } catch (error) {
    primaryError = error;
  }

  const closeErrors = await closeAuthorities([
    rootAuthority,
    sourceAuthority,
    commonAuthority,
    containerAuthority,
  ], hooks.closeAuthority);
  const finalTruth = await observeRecoveryTruth(binding, truth);
  if (
    !primaryError
    && closeErrors.length === 0
    && (
      finalTruth.quarantinePreserved !== true
      || finalTruth.successorPreserved !== false
    )
  ) {
    primaryError = cleanupError(
      "managed worktree final recovery state could not be verified",
      "WORKTREE_CLEANUP_RECOVERY_REQUIRED",
      finalTruth,
    );
  }
  if (primaryError || closeErrors.length > 0) {
    recoveryTruthError(primaryError, closeErrors, finalTruth);
  }
  return parseManagedWorktreeDispositionProof(result, binding);
}

export async function cleanupManagedWorkerWorktree(
  options: CleanupManagedWorkerWorktreeOptions,
): Promise<ManagedWorktreeCleanupProof> {
  const slug = options.slug || WORKTREE_SLUG;
  const coordinates = await ensureManagedNamespace(options.hubRoot, options.entryId, slug);
  return await withDurableDirectoryLock(
    coordinates.lockPath,
    () => cleanupManagedWorkerWorktreeUnlocked({ ...options, hubRoot: coordinates.hubRoot, slug }),
    { ttlMs: 30_000, waitMs: 30_000 },
  );
}

export async function verifyRetainedManagedWorkerWorktree({
  hubRoot,
  sourcePath,
  entryId,
  managedWorktree,
  slug = WORKTREE_SLUG,
  runGit = defaultGitRunner,
}: CleanupManagedWorkerWorktreeOptions): Promise<ManagedWorktreeCleanupProof> {
  const coordinates = await ensureManagedNamespace(hubRoot, entryId, slug);
  return await withDurableDirectoryLock(coordinates.lockPath, async () => {
    const binding = parseVerifiedManagedWorktreeContext(managedWorktree);
    const canonicalSourcePath = (await captureStableDirectory(sourcePath, "source repository")).canonical;
    assertCoordinatesAndSource(coordinates, binding, canonicalSourcePath);
    await verifyManagedGitBinding({
      sourcePath: canonicalSourcePath,
      context: managedWorktreeContext(binding),
      runGit,
      phase: "retention",
      expectedVerification: binding.verification,
    });
    const root = await openDirectoryAuthority(coordinates.worktreesRoot, "managed worktrees root");
    const source = await openDirectoryAuthority(
      binding.verification.sourcePath,
      "source repository",
      binding.verification.sourceDirectory,
    );
    const common = await openDirectoryAuthority(
      binding.verification.sourceCommonDir,
      "source Git common directory",
      binding.verification.commonDirectory,
    );
    let primaryError: unknown = null;
    let result: ManagedWorktreeCleanupProof | null = null;
    try {
      await verifyManagedGitBinding({
        sourcePath: canonicalSourcePath,
        context: managedWorktreeContext(binding),
        runGit,
        phase: "retention",
        expectedVerification: binding.verification,
      });
      validateDirectoryAuthoritySync(root, { committed: false, recoveryPaths: { canonical: binding.path } });
      validateDirectoryAuthoritySync(source, { committed: false, recoveryPaths: { canonical: binding.path } });
      validateDirectoryAuthoritySync(common, { committed: false, recoveryPaths: { canonical: binding.path } });
      assertDirectoryIdentitySync(binding.path, binding.ownership.directory, {
        committed: false,
        successorPreserved: true,
        recoveryPaths: { canonical: binding.path },
      });
      result = dispositionProof(binding, coordinates.worktreesRoot, "retained", "product_validation_keep", null, null);
    } catch (error) {
      primaryError = error;
    }
    const closeErrors = await closeAuthorities([root, source, common]);
    if (primaryError) throw primaryError;
    if (closeErrors.length > 0) {
      throw Object.assign(new AggregateError(closeErrors, "retained worktree authority close failed"), {
        code: "WORKTREE_CLEANUP_RETENTION_UNVERIFIED",
        committed: false,
        successorPreserved: true,
        recoveryPaths: { canonical: binding.path },
      });
    }
    return parseManagedWorktreeDispositionProof(result, binding);
  }, { ttlMs: 30_000, waitMs: 30_000 });
}

export async function cleanupFailedWorktreeCreate(options: CleanupManagedWorkerWorktreeOptions) {
  return await cleanupManagedWorkerWorktree(options);
}

type CreateManagedWorktree = (options: {
  project: string;
  jobId: string;
  slug: string;
  worktreesRoot: string;
}) => Promise<unknown>;

type CreateIsolatedWorktreeOptions = {
  hubRoot?: string;
  sourcePath?: string;
  entryId?: string;
  slug?: string;
  create?: CreateManagedWorktree;
  runGit?: ManagedWorktreeGitRunner;
  /** @deprecated Cleanup is preserve-only; pathname removal is never invoked. */
  removePath?: (...args: unknown[]) => Promise<unknown>;
  maxAttempts?: number;
  retryDelayMs?: number;
  log?: WorktreeLog | null;
};

async function pathOccupied(candidate: string) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function createIsolatedWorktreeWithRetry({
  hubRoot,
  sourcePath,
  entryId,
  slug = WORKTREE_SLUG,
  create = createWorktree as CreateManagedWorktree,
  runGit = defaultGitRunner,
  maxAttempts = WORKTREE_CREATE_MAX_ATTEMPTS,
  retryDelayMs = WORKTREE_CREATE_RETRY_DELAY_MS,
  log = null,
}: CreateIsolatedWorktreeOptions = {}): Promise<VerifiedManagedWorktreeContext> {
  if (!hubRoot) throw new Error("hubRoot is required for worktree isolation");
  if (!sourcePath) throw new Error("sourcePath is required for worktree isolation");
  if (!entryId) throw new Error("entryId is required for worktree isolation");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) throw new Error("retryDelayMs must be a non-negative integer");

  const coordinates = await ensureManagedNamespace(hubRoot, entryId, slug);
  return await withDurableDirectoryLock(coordinates.lockPath, async () => {
    const source = await captureStableDirectory(sourcePath, "source repository");
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const produced = await create({
          project: source.canonical,
          jobId: coordinates.worktreeJobId,
          slug,
          worktreesRoot: coordinates.worktreesRoot,
        });
        const context = parseManagedWorktreeContext(produced);
        if (context.path !== coordinates.worktreePath || context.branch !== coordinates.branch) {
          throw cleanupError("worktree producer returned the wrong managed coordinates", "WORKTREE_CLEANUP_PATH_MISMATCH", {
            committed: false,
            successorPreserved: true,
            recoveryPaths: { canonical: coordinates.worktreePath, observed: context.path },
          });
        }
        const verification = await verifyManagedGitBinding({
          sourcePath: source.canonical,
          context,
          runGit,
          phase: "create",
        });
        return parseVerifiedManagedWorktreeContext({ ...context, verification });
      } catch (error) {
        lastError = error;
        log?.warn?.(`worktree create attempt ${attempt}/${maxAttempts} failed: ${error instanceof Error ? error.message : String(error)}`);
        if (await pathOccupied(coordinates.worktreePath)) break;
        if (attempt < maxAttempts && retryDelayMs > 0) await delay(retryDelayMs);
      }
    }
    const targetRetained = await pathOccupied(coordinates.worktreePath);
    throw cleanupError(
      `worktree creation could not be independently verified; Git metadata cleanup is deferred: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      "WORKTREE_CLEANUP_DEFERRED",
      {
        committed: false,
        cleanupDeferred: true,
        gitMetadataRetained: true,
        quarantinePreserved: false,
        successorPreserved: targetRetained,
        recoveryPaths: { canonical: coordinates.worktreePath, source: source.canonical },
      },
      lastError,
    );
  }, { ttlMs: 30_000, waitMs: 30_000 });
}
