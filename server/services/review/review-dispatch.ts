/**
 * Review Dispatch — session dispatch, analysis, ACP runner, verifier evidence,
 * remediation handler, and repair handler.
 *
 * Merged from:
 *   - review-dispatch.ts          (dispatch, analyze, accept, reject, cancel)
 *   - review-dispatch-runner.ts   (PersistentAcp, prompt builders, runReview)
 *   - verifier-evidence.ts        (evidence collectors)
 *   - remediation-handler.ts      (remediation lifecycle)
 *   - repair-handler.ts           (repair lifecycle)
 */

// ─── review-dispatch.ts ───────────────────────────────────────────
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, renameSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { lstat, mkdir as mkdirReview, open, readFile, realpath } from "node:fs/promises";
import { execFile } from "child_process";
import { runtimeDataPath } from "../runtime.js";
import { enqueue } from "../hub/hub-queue.js";
import { makeJobId } from "../job/job-store.js";
import {
  getSession,
  updateSession,
  cancelReviewSession,
  parseIssues,
  type ReviewCleanupProof,
  type ReviewDecisionAction,
  type ReviewDecisionIntent,
  type ReviewDecisionJournal,
  type ReviewMergeProof,
  type ReviewSessionRecord,
  type ReviewSourceRepositoryState,
} from "./review-session.js";
import { buildChildEnv } from "../secret-policy.js";
import { resolveHubRoot, getProject } from "../hub/hub-registry.js";
import { recordValue, type LooseRecord } from "../../../core/contracts/types.js";
import {
  captureProcessIdentity,
  killTree,
  type ProcessIdentity,
  type ProcessTreeSystem,
} from "../../../core/runtime/process-tree.js";
import {
  withDirectoryProcessFence,
  withDurableDirectoryLock,
  type DurableDirectoryLockOptions,
} from "../../../core/runtime/durable-directory-lock.js";
import { resolveLinkedGitMetadataReadRoots } from "../../../core/policy/filesystem-boundary.js";
import { fsyncDirectory } from "../../../shared/hub-maintenance.js";
import {
  parseWorktreeOwnership,
  sameReadyWorktreeOwnership,
  sameWorktreeDirectoryIdentity,
  type ReadyWorktreeOwnership,
  type WorktreeDirectoryIdentity,
} from "../../../core/contracts/worktree-ownership.js";

type ReviewWorktreeGitRunner = (cwd: string, args: string[]) => Promise<string>;

type ReviewWorktreeCleanupTestHooks = {
  runGit?: ReviewWorktreeGitRunner;
  beforeIsolation?: (context: {
    sourcePath: string;
    worktreePath: string;
    branch: string;
    quarantinePath: string;
  }) => void | Promise<void>;
  /** Simulates a non-cooperative replacement in the sync mutation window. */
  renameSyncForTests?: (sourcePath: string, quarantinePath: string) => void;
  beforeSourceMutation?: (context: {
    sourcePath: string;
    baseBranchRef: string;
    baseCommit: string;
    fixedWorktreeHead: string;
  }) => void | Promise<void>;
  afterMergeRefCas?: (context: { sourcePath: string; mergeCommit: string }) => void | Promise<void>;
  afterMergeBeforeJournal?: (context: { sourcePath: string; mergeCommit: string }) => void | Promise<void>;
  afterIsolationRename?: (context: {
    worktreePath: string;
    quarantinePath: string;
  }) => void | Promise<void>;
  beforeQuarantineContainerCreate?: (context: { quarantineContainerPath: string }) => void | Promise<void>;
  makeQuarantineId?: () => string;
  fsyncDirectory?: (directory: string) => Promise<void>;
};

type ReviewStorageOptions = LooseRecord & {
  hubRoot?: string;
  dataRoot?: string;
  lockDir?: string;
  skipTransitionCheck?: boolean;
  /** Test seam for identity capture and tree signaling. */
  processTreeSystem?: ProcessTreeSystem;
  /** Test seams and timing for split-phase repair/remediation lock leases. */
  workflowLockOptions?: DurableDirectoryLockOptions;
  /** Per-call test seams for hostile worktree cleanup races and command failures. */
  worktreeCleanupTestHooks?: ReviewWorktreeCleanupTestHooks;
};

type DispatchOptions = ReviewStorageOptions & {
  hubRoot?: string;
};

type ReviewIssue = LooseRecord & {
  severity?: number;
  message?: string;
  description?: string;
};

type AnalysisResult = LooseRecord & {
  ok: boolean;
  summary?: string;
  changes?: unknown[];
  risks?: unknown[];
  recommendation?: string;
  raw?: string;
  error?: string;
};

type AgentCommand = {
  command: string;
  args: string[];
};

type JsonRpcMessage = {
  [key: string]: unknown;
  id?: number;
  method?: string;
  params?: LooseRecord;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

type SessionUpdateParams = LooseRecord & {
  update?: {
    sessionUpdate?: string;
    content?: {
      type?: string;
      text?: string;
    };
  };
};

type AcpChildProcess = ChildProcess & {
  stdin: NonNullable<ChildProcess["stdin"]>;
  stdout: NonNullable<ChildProcess["stdout"]>;
  stderr: NonNullable<ChildProcess["stderr"]>;
};

type EvidenceAvailability = LooseRecord & {
  available: boolean;
  reason?: string;
  content?: string;
  path?: string;
  eventCount?: number;
  events?: LooseRecord[];
  context?: string | null;
};

type VerifierEvidence = LooseRecord & {
  jobState: LooseRecord | null;
  deliverable: EvidenceAvailability | null;
  diff: EvidenceAvailability | null;
  uncommittedDiff: EvidenceAvailability | null;
  eventLog: EvidenceAvailability | null;
  projectContext: EvidenceAvailability | null;
  testResults: EvidenceAvailability | null;
  diagnostics: Array<{ level: string; message: string }>;
};

type ArtifactEventOptions = ReviewStorageOptions & {
  includeLegacyFallback?: boolean;
};

type RemediationRunOptions = ReviewStorageOptions & {
  project: string;
  jobId: string;
  executorRoot?: string | null;
};

type CompleteRemediationOptions = RemediationRunOptions & {
  remediationId?: string;
  remediationFile: string;
  remediationArtifact: string;
  status?: string;
  error?: string | null;
};

type RepairRunOptions = ReviewStorageOptions & {
  project: string;
  jobId: string;
  executorRoot?: string | null;
};

type CompleteRepairOptions = RepairRunOptions & {
  repairId?: string;
  repairFile: string;
  repairArtifact: string;
  status?: string;
  error?: string | null;
};

type LineageTaskOptions = ReviewStorageOptions & {
  project: string;
  jobId: string;
  remediationArtifact?: string;
  remediationStatus?: string;
  repairArtifact?: string;
  repairStatus?: string;
  executorRoot?: string | null;
};

type ReviewRunOptions = {
  signal?: AbortSignal;
  /** Test seam for identity capture and tree signaling. */
  processTreeSystem?: ProcessTreeSystem;
};

type ActiveReviewRun = {
  abort: (reason: string) => void;
  teardown: Promise<void>;
};

type ReviewChildCloseRecord = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
};

function reviewLifecycleMs(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function reviewChildLifecycleError(message: string, code: string, cause?: unknown) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function monitorReviewChildClose(child: ChildProcess) {
  let processError: Error | null = null;
  return new Promise<ReviewChildCloseRecord>((resolve) => {
    child.once("error", (error) => { processError = error; });
    child.once("close", (code, signal) => resolve({ code, signal, error: processError }));
  });
}

async function waitForReviewChildClose(
  closed: Promise<ReviewChildCloseRecord>,
  timeoutMs: number,
  label: string,
) {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(reviewChildLifecycleError(
          `${label} did not emit close after verified teardown`,
          "CHILD_CLOSE_TIMEOUT",
        )), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateReviewAnalysisChild(
  child: ChildProcess,
  identity: ProcessIdentity | null,
  termGraceMs: number,
  forceVerifyMs: number,
  system?: ProcessTreeSystem,
) {
  if (!child.pid || !identity) {
    throw reviewChildLifecycleError(
      child.pid
        ? `review analysis child ${child.pid} has no verified process identity; refusing to signal`
        : "review analysis child did not expose a pid; refusing to signal",
      "CHILD_PROCESS_IDENTITY_UNAVAILABLE",
    );
  }
  await killTree(child.pid, termGraceMs, {
    requireDescendantScan: true,
    forceVerifyMs,
    expectedRootIdentity: identity,
    ...(system ? { system } : {}),
  });
}

function aggregateReviewChildFailure(label: string, primary: Error, cleanupErrors: unknown[]) {
  const normalized = cleanupErrors.map((error) => error instanceof Error ? error : new Error(String(error)));
  return Object.assign(
    new AggregateError([primary, ...normalized], `${label} failed and child cleanup was not clean`, { cause: primary }),
    { code: "CHILD_LIFECYCLE_CLEANUP_FAILED", primaryError: primary, cleanupErrors: normalized },
  );
}

function gitExec(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(
        new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`, { cause: err }),
        { code: "REVIEW_GIT_COMMAND_FAILED", exitCode: err.code, gitArgs: [...args] },
      ));
      else resolve(stdout.trim());
    });
  });
}

const SAFE_REVIEW_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REVIEW_DECISION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type DirectoryGeneration = {
  dev: string;
  ino: string;
  birthtimeMs: string;
  ctimeMs: string;
};

type DirectoryAuthority = {
  path: string;
  canonicalPath: string;
  generation: DirectoryGeneration;
  identity: WorktreeDirectoryIdentity;
  handle: Awaited<ReturnType<typeof open>>;
};

type RegisteredWorktree = {
  path: string;
  head: string | null;
  branch: string | null;
};

type BoundReviewWorktree = {
  source: DirectoryAuthority;
  worktreesRoot: DirectoryAuthority;
  worktree: DirectoryAuthority;
  sourcePath: string;
  worktreePath: string;
  branch: string;
  branchRef: string;
  head: string;
  baseBranch: string;
  baseBranchRef: string;
  baseCommit: string;
  ownership: ReadyWorktreeOwnership;
  intent: ReviewDecisionIntent;
  quarantineContainer: DirectoryAuthority;
  runGit: ReviewWorktreeGitRunner;
  hooks: ReviewWorktreeCleanupTestHooks;
  removed: boolean;
};

type WorktreeCleanupResult = {
  isolated: true;
  metadataPruned: false;
  metadataRetained: true;
  branchRetained: true;
  quarantinePath: string;
};

function worktreePathFor(cpbRoot: string, jobId: string, projectRuntimeRoot?: string): string {
  const dataRoot = projectRuntimeRoot ? path.resolve(projectRuntimeRoot) : null;
  return dataRoot
    ? path.join(dataRoot, "worktrees", `${jobId}-pipeline`)
    : runtimeDataPath(cpbRoot, "worktrees", `${jobId}-pipeline`);
}

function worktreeError(
  message: string,
  code: string,
  metadata: Record<string, unknown> = {},
  cause?: unknown,
) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code, committed: false, ...metadata },
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
}

function isSimulatedReviewCrash(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const candidate = error as {
    simulateCrash?: unknown;
    code?: unknown;
    cause?: unknown;
    primaryError?: unknown;
  };
  return candidate.simulateCrash === true
    || candidate.code === "TEST_REVIEW_SIMULATED_CRASH"
    || isSimulatedReviewCrash(candidate.cause, seen)
    || isSimulatedReviewCrash(candidate.primaryError, seen)
    || (error instanceof AggregateError && error.errors.some((entry) => isSimulatedReviewCrash(entry, seen)));
}

function directoryGeneration(info: {
  dev: number | bigint;
  ino: number | bigint;
  birthtimeMs: number | bigint;
  ctimeMs: number | bigint;
}): DirectoryGeneration {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeMs: String(info.birthtimeMs),
    ctimeMs: String(info.ctimeMs),
  };
}

function worktreeDirectoryIdentity(info: {
  dev: number | bigint;
  ino: number | bigint;
  birthtimeNs?: bigint;
  birthtimeMs: number | bigint;
  mode: number | bigint;
  uid: number | bigint;
  gid: number | bigint;
}): WorktreeDirectoryIdentity {
  const birthtimeNs = typeof info.birthtimeNs === "bigint"
    ? info.birthtimeNs
    : BigInt(Math.trunc(Number(info.birthtimeMs) * 1_000_000));
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(birthtimeNs),
    mode: String(info.mode),
    uid: String(info.uid),
    gid: String(info.gid),
  };
}

function sameDirectoryInstance(left: DirectoryGeneration, right: DirectoryGeneration) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function sameDirectoryGeneration(left: DirectoryGeneration, right: DirectoryGeneration) {
  return sameDirectoryInstance(left, right) && left.ctimeMs === right.ctimeMs;
}

function strictDirectoryFlags() {
  if (
    typeof constants.O_NOFOLLOW !== "number"
    || constants.O_NOFOLLOW === 0
    || typeof constants.O_DIRECTORY !== "number"
    || constants.O_DIRECTORY === 0
  ) {
    throw worktreeError(
      "strict no-follow directory opens are unavailable",
      "REVIEW_WORKTREE_AUTHORITY_UNAVAILABLE",
    );
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY;
}

async function pinDirectoryAuthority(directory: string, label: string): Promise<DirectoryAuthority> {
  const resolved = path.resolve(directory);
  let before;
  try {
    before = await lstat(resolved, { bigint: true });
  } catch (cause) {
    throw worktreeError(`${label} is unavailable: ${resolved}`, "REVIEW_WORKTREE_PATH_UNAVAILABLE", {}, cause);
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw worktreeError(`${label} is not a no-follow directory: ${resolved}`, "REVIEW_WORKTREE_PATH_UNSAFE");
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(resolved, strictDirectoryFlags());
  } catch (cause) {
    throw worktreeError(`${label} could not be pinned: ${resolved}`, "REVIEW_WORKTREE_AUTHORITY_UNAVAILABLE", {}, cause);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(resolved, { bigint: true });
    const expected = directoryGeneration(before);
    if (
      !opened.isDirectory()
      || after.isSymbolicLink()
      || !after.isDirectory()
      || !sameDirectoryGeneration(expected, directoryGeneration(opened))
      || !sameDirectoryGeneration(expected, directoryGeneration(after))
    ) {
      throw worktreeError(`${label} changed while it was pinned: ${resolved}`, "REVIEW_WORKTREE_GENERATION_CONFLICT");
    }
    return {
      path: resolved,
      canonicalPath: await realpath(resolved),
      generation: expected,
      identity: worktreeDirectoryIdentity(opened),
      handle,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function assertDirectoryAuthority(
  authority: DirectoryAuthority,
  label: string,
  { exactGeneration = false, requirePath = true }: { exactGeneration?: boolean; requirePath?: boolean } = {},
) {
  const descriptor = await authority.handle.stat({ bigint: true });
  const descriptorGeneration = directoryGeneration(descriptor);
  if (
    !descriptor.isDirectory()
    || !sameDirectoryInstance(authority.generation, descriptorGeneration)
    || (exactGeneration && !sameDirectoryGeneration(authority.generation, descriptorGeneration))
  ) {
    throw worktreeError(`${label} descriptor authority changed`, "REVIEW_WORKTREE_GENERATION_CONFLICT");
  }
  if (!requirePath) return;

  let current;
  try {
    current = await lstat(authority.path, { bigint: true });
  } catch (cause) {
    throw worktreeError(`${label} pathname authority disappeared`, "REVIEW_WORKTREE_GENERATION_CONFLICT", {}, cause);
  }
  const currentGeneration = directoryGeneration(current);
  if (
    current.isSymbolicLink()
    || !current.isDirectory()
    || !sameDirectoryInstance(authority.generation, currentGeneration)
    || (exactGeneration && !sameDirectoryGeneration(authority.generation, currentGeneration))
    || await realpath(authority.path) !== authority.canonicalPath
  ) {
    throw worktreeError(`${label} pathname authority changed`, "REVIEW_WORKTREE_GENERATION_CONFLICT");
  }
}

function parseWorktreeList(raw: string): RegisteredWorktree[] {
  return raw
    .split("\0\0")
    .map((record) => record.split("\0").filter(Boolean))
    .filter((fields) => fields.some((field) => field.startsWith("worktree ")))
    .map((fields) => ({
      path: fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length) || "",
      head: fields.find((field) => field.startsWith("HEAD "))?.slice("HEAD ".length) || null,
      branch: fields.find((field) => field.startsWith("branch "))?.slice("branch ".length) || null,
    }));
}

async function canonicalGitPath(cwd: string, raw: string, label: string) {
  if (!raw) throw worktreeError(`${label} is empty`, "REVIEW_WORKTREE_REPOSITORY_MISMATCH");
  try {
    return await realpath(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw));
  } catch (cause) {
    throw worktreeError(`${label} cannot be canonicalized`, "REVIEW_WORKTREE_REPOSITORY_MISMATCH", {}, cause);
  }
}

async function captureRegisteredSourceBase(sourcePath: string) {
  const source = await pinDirectoryAuthority(sourcePath, "registered project source");
  let primaryError: unknown = null;
  let result: { branchRef: string; commit: string } | null = null;
  try {
    if (source.canonicalPath !== path.resolve(sourcePath)) {
      throw worktreeError("registered project source path changed canonical identity", "REVIEW_SOURCE_REPOSITORY_MISMATCH");
    }
    const sourceTop = await canonicalGitPath(
      source.canonicalPath,
      await gitExec(source.canonicalPath, "rev-parse", "--show-toplevel"),
      "registered project Git root",
    );
    if (sourceTop !== source.canonicalPath) {
      throw worktreeError("registered project source is not the exact Git root", "REVIEW_SOURCE_REPOSITORY_MISMATCH");
    }
    const branchRef = await gitExec(source.canonicalPath, "symbolic-ref", "--quiet", "HEAD");
    if (!branchRef.startsWith("refs/heads/")) {
      throw worktreeError("registered project source has no symbolic branch", "REVIEW_SOURCE_BRANCH_UNAVAILABLE");
    }
    await gitExec(source.canonicalPath, "check-ref-format", branchRef);
    const commit = await gitExec(source.canonicalPath, "rev-parse", "--verify", "HEAD");
    if (!/^[0-9a-f]{40,64}$/.test(commit)) {
      throw worktreeError("registered project source HEAD is invalid", "REVIEW_SOURCE_HEAD_INVALID");
    }
    const status = await gitExec(
      source.canonicalPath,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    );
    if (status) {
      throw worktreeError("registered project source is dirty at review dispatch", "REVIEW_SOURCE_DIRTY");
    }
    await assertDirectoryAuthority(source, "registered project source");
    result = { branchRef, commit };
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await source.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    throw new AggregateError([primaryError, closeError], "source base capture and authority close both failed", {
      cause: primaryError,
    });
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return result as { branchRef: string; commit: string };
}

async function assertWorktreeRegistration(binding: BoundReviewWorktree) {
  await assertDirectoryAuthority(binding.source, "registered project source");
  await assertDirectoryAuthority(binding.worktreesRoot, "managed worktrees root");
  await assertDirectoryAuthority(binding.worktree, "managed review worktree", { exactGeneration: true });
  const descriptorIdentity = worktreeDirectoryIdentity(await binding.worktree.handle.stat({ bigint: true }));
  const pathIdentity = worktreeDirectoryIdentity(await lstat(binding.worktreePath, { bigint: true }));
  if (
    !sameWorktreeDirectoryIdentity(binding.ownership.directory, descriptorIdentity)
    || !sameWorktreeDirectoryIdentity(binding.ownership.directory, pathIdentity)
  ) {
    throw worktreeError(
      "review worktree directory does not match its create-time ownership identity",
      "REVIEW_WORKTREE_OWNERSHIP_MISMATCH",
      { recoveryPaths: [binding.worktreePath] },
    );
  }

  const sourceTop = await canonicalGitPath(
    binding.sourcePath,
    await binding.runGit(binding.sourcePath, ["rev-parse", "--show-toplevel"]),
    "registered project Git root",
  );
  if (sourceTop !== binding.source.canonicalPath) {
    throw worktreeError("registered project source is not the exact Git root", "REVIEW_WORKTREE_REPOSITORY_MISMATCH");
  }

  const targetTop = await canonicalGitPath(
    binding.worktreePath,
    await binding.runGit(binding.worktreePath, ["rev-parse", "--show-toplevel"]),
    "review worktree Git root",
  );
  if (targetTop !== binding.worktree.canonicalPath) {
    throw worktreeError("review worktree is not the exact registered Git root", "REVIEW_WORKTREE_REPOSITORY_MISMATCH");
  }

  const sourceCommon = await canonicalGitPath(
    binding.sourcePath,
    await binding.runGit(binding.sourcePath, ["rev-parse", "--git-common-dir"]),
    "registered project Git common directory",
  );
  const targetCommon = await canonicalGitPath(
    binding.worktreePath,
    await binding.runGit(binding.worktreePath, ["rev-parse", "--git-common-dir"]),
    "review worktree Git common directory",
  );
  if (sourceCommon !== targetCommon) {
    throw worktreeError("review worktree belongs to a different repository", "REVIEW_WORKTREE_REPOSITORY_MISMATCH");
  }

  const metadataRoots = await resolveLinkedGitMetadataReadRoots(binding.worktree.canonicalPath);
  const canonicalMetadataRoots = await Promise.all(metadataRoots.map((entry) => realpath(entry).catch(() => "")));
  if (!canonicalMetadataRoots.includes(sourceCommon)) {
    throw worktreeError("review worktree control metadata is not bound to the registered repository", "REVIEW_WORKTREE_REPOSITORY_MISMATCH");
  }

  const symbolicHead = await binding.runGit(binding.worktreePath, ["symbolic-ref", "--quiet", "HEAD"]);
  if (symbolicHead !== binding.branchRef) {
    throw worktreeError("review worktree has an unexpected checked-out branch", "REVIEW_WORKTREE_BRANCH_MISMATCH");
  }
  const worktreeStatus = await binding.runGit(binding.worktreePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (worktreeStatus) {
    throw worktreeError(
      "review worktree has uncommitted changes; preserving it for explicit recovery",
      "REVIEW_WORKTREE_DIRTY",
      { recoveryPaths: [binding.worktreePath] },
    );
  }

  const records = parseWorktreeList(await binding.runGit(binding.sourcePath, ["worktree", "list", "--porcelain", "-z"]));
  const branchRecords = records.filter((entry) => entry.branch === binding.branchRef);
  if (branchRecords.length !== 1 || !branchRecords[0].path || !branchRecords[0].head) {
    throw worktreeError("review worktree branch is not uniquely registered", "REVIEW_WORKTREE_UNREGISTERED");
  }
  const registeredPath = await canonicalGitPath(binding.sourcePath, branchRecords[0].path, "registered review worktree path");
  if (registeredPath !== binding.worktree.canonicalPath) {
    throw worktreeError("review worktree branch is registered at a different path", "REVIEW_WORKTREE_UNREGISTERED");
  }
  const branchHead = await binding.runGit(binding.sourcePath, ["rev-parse", "--verify", binding.branchRef]);
  if (branchHead !== branchRecords[0].head) {
    throw worktreeError("review worktree branch identity changed", "REVIEW_WORKTREE_BRANCH_MISMATCH");
  }
  let durableBaseBinding: ReadyWorktreeOwnership;
  try {
    const parsed = JSON.parse(await binding.runGit(binding.sourcePath, [
      "config",
      "--local",
      "--get",
      `branch.${binding.branch}.cpbBaseBinding`,
    ]));
    const ownership = parseWorktreeOwnership(parsed);
    if (ownership.state !== "ready") throw new Error("ownership is not ready");
    durableBaseBinding = ownership;
  } catch (cause) {
    throw worktreeError(
      "review worktree is missing valid durable Git ownership metadata",
      "REVIEW_WORKTREE_OWNERSHIP_INVALID",
      {},
      cause,
    );
  }
  if (!sameReadyWorktreeOwnership(durableBaseBinding, binding.ownership)) {
    throw worktreeError(
      "review worktree durable Git ownership does not match session/event authority",
      "REVIEW_WORKTREE_OWNERSHIP_MISMATCH",
    );
  }
  if (branchHead !== binding.intent.fixedWorktreeHead) {
    throw worktreeError(
      "review worktree branch moved after decision intent was persisted",
      "REVIEW_WORKTREE_HEAD_MISMATCH",
      { expectedHead: binding.intent.fixedWorktreeHead, actualHead: branchHead },
    );
  }
  binding.head = branchHead;
}

type DurableReviewWorktreeAuthority = {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  ownership: ReadyWorktreeOwnership;
};

function sameDurableReviewWorktreeAuthority(
  left: DurableReviewWorktreeAuthority,
  right: DurableReviewWorktreeAuthority,
) {
  return left.worktreePath === right.worktreePath
    && left.branch === right.branch
    && left.baseBranch === right.baseBranch
    && left.baseCommit === right.baseCommit
    && sameReadyWorktreeOwnership(left.ownership, right.ownership);
}

function parseDurableReviewWorktreeEvent(
  event: LooseRecord,
  project: string,
  jobId: string,
): DurableReviewWorktreeAuthority {
  if (
    event.type !== "worktree_created"
    || event.project !== project
    || event.jobId !== jobId
    || typeof event.worktree !== "string"
    || !path.isAbsolute(event.worktree)
    || typeof event.branch !== "string"
    || typeof event.baseBranch !== "string"
    || typeof event.baseCommit !== "string"
  ) {
    throw worktreeError(
      "durable worktree_created event is missing exact ownership fields",
      "REVIEW_WORKTREE_EVENT_BINDING_INVALID",
    );
  }
  let ownership;
  try {
    ownership = parseWorktreeOwnership(event.worktreeOwnership);
  } catch (cause) {
    throw worktreeError(
      "durable worktree_created event has invalid ownership metadata",
      "REVIEW_WORKTREE_OWNERSHIP_INVALID",
      {},
      cause,
    );
  }
  if (ownership.state !== "ready") {
    throw worktreeError(
      "durable worktree_created event ownership is not ready",
      "REVIEW_WORKTREE_OWNERSHIP_INVALID",
    );
  }
  if (ownership.baseBranch !== event.baseBranch || ownership.baseCommit !== event.baseCommit) {
    throw worktreeError(
      "durable worktree_created event base fields disagree with ownership metadata",
      "REVIEW_WORKTREE_EVENT_BINDING_INVALID",
    );
  }
  return {
    worktreePath: event.worktree,
    branch: event.branch,
    baseBranch: event.baseBranch,
    baseCommit: event.baseCommit,
    ownership,
  };
}

async function loadDurableReviewWorktreeAuthority(
  cpbRoot: string,
  project: string,
  jobId: string,
  dataRoot: string,
): Promise<DurableReviewWorktreeAuthority> {
  const events = await readEventsRem(cpbRoot, project, jobId, {
    dataRoot,
    includeLegacyFallback: false,
  });
  const createdEvents = events.filter((event) => event.type === "worktree_created");
  if (createdEvents.length === 0) {
    throw worktreeError("durable worktree_created event is missing", "REVIEW_WORKTREE_EVENT_BINDING_MISSING");
  }
  const parsed = createdEvents.map((event) => parseDurableReviewWorktreeEvent(event, project, jobId));
  const authority = parsed[0];
  if (parsed.some((entry) => !sameDurableReviewWorktreeAuthority(authority, entry))) {
    throw worktreeError(
      "durable worktree_created events contain conflicting ownership bindings",
      "REVIEW_WORKTREE_EVENT_BINDING_CONFLICT",
    );
  }

  const materialized = materializeJobRem(events);
  let materializedOwnership;
  try {
    materializedOwnership = parseWorktreeOwnership(materialized.worktreeOwnership);
  } catch (cause) {
    throw worktreeError(
      "materialized job has invalid worktree ownership",
      "REVIEW_WORKTREE_JOB_BINDING_MISMATCH",
      {},
      cause,
    );
  }
  if (
    materializedOwnership.state !== "ready"
    || materialized.jobId !== jobId
    || materialized.project !== project
    || materialized.worktree !== authority.worktreePath
    || materialized.worktreeBranch !== authority.branch
    || materialized.worktreeBaseBranch !== authority.baseBranch
    || materialized.worktreeBaseCommit !== authority.baseCommit
    || !sameReadyWorktreeOwnership(materializedOwnership, authority.ownership)
  ) {
    throw worktreeError(
      "materialized job disagrees with durable worktree_created ownership binding",
      "REVIEW_WORKTREE_JOB_BINDING_MISMATCH",
    );
  }
  return authority;
}

async function assertSourceMergeBase(binding: BoundReviewWorktree) {
  await assertDirectoryAuthority(binding.source, "registered project source");
  const sourceTop = await canonicalGitPath(
    binding.sourcePath,
    await binding.runGit(binding.sourcePath, ["rev-parse", "--show-toplevel"]),
    "registered project Git root",
  );
  if (sourceTop !== binding.source.canonicalPath) {
    throw worktreeError("registered project source is not the exact Git root", "REVIEW_SOURCE_REPOSITORY_MISMATCH");
  }
  const currentBranch = await binding.runGit(binding.sourcePath, ["symbolic-ref", "--quiet", "HEAD"]);
  if (currentBranch !== binding.baseBranchRef) {
    throw worktreeError(
      `registered source branch changed: expected ${binding.baseBranchRef}, received ${currentBranch || "detached"}`,
      "REVIEW_SOURCE_BRANCH_MISMATCH",
    );
  }
  const currentHead = await binding.runGit(binding.sourcePath, ["rev-parse", "--verify", "HEAD"]);
  if (currentHead !== binding.baseCommit) {
    throw worktreeError(
      `registered source HEAD changed: expected ${binding.baseCommit}, received ${currentHead}`,
      "REVIEW_SOURCE_HEAD_MISMATCH",
    );
  }
  const status = await binding.runGit(binding.sourcePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status) {
    throw worktreeError(
      "registered source checkout is dirty; refusing to merge review changes",
      "REVIEW_SOURCE_DIRTY",
    );
  }
}

async function readGitReadyWorktreeOwnership(
  runGit: ReviewWorktreeGitRunner,
  sourcePath: string,
  branch: string,
) {
  let parsed;
  try {
    parsed = JSON.parse(await runGit(sourcePath, [
      "config",
      "--local",
      "--get",
      `branch.${branch}.cpbBaseBinding`,
    ]));
  } catch (cause) {
    throw worktreeError(
      "managed review branch is missing valid Git ownership metadata",
      "REVIEW_WORKTREE_OWNERSHIP_INVALID",
      {},
      cause,
    );
  }
  let ownership;
  try {
    ownership = parseWorktreeOwnership(parsed);
  } catch (cause) {
    throw worktreeError(
      "managed review branch has invalid Git ownership metadata",
      "REVIEW_WORKTREE_OWNERSHIP_INVALID",
      {},
      cause,
    );
  }
  if (ownership.state !== "ready") {
    throw worktreeError(
      "managed review branch Git ownership is not ready",
      "REVIEW_WORKTREE_OWNERSHIP_INVALID",
    );
  }
  return ownership;
}

type ReviewDecisionAuthority = {
  hubRoot: string;
  sourcePath: string;
  worktreesRootPath: string;
  expectedWorktreePath: string;
  expectedBranch: string;
  intent: ReviewDecisionIntent;
  ownership: ReadyWorktreeOwnership;
  hooks: ReviewWorktreeCleanupTestHooks;
  runGit: ReviewWorktreeGitRunner;
};

async function loadReviewDecisionAuthority(
  cpbRoot: string,
  session: ReviewSessionRecord,
  action: ReviewDecisionAction,
  options: ReviewStorageOptions,
): Promise<ReviewDecisionAuthority> {
  const journal = session.reviewDecision;
  if (!journal || journal.action !== action) {
    throw worktreeError(
      journal ? `review decision is already bound to ${journal.action}` : "review decision intent is missing",
      journal ? "REVIEW_DECISION_CONFLICT" : "REVIEW_DECISION_INTENT_MISSING",
    );
  }
  const intent = journal.intent;
  const hubRoot = options.hubRoot ? path.resolve(options.hubRoot) : resolveHubRoot(cpbRoot);
  const registered = await getProject(hubRoot, String(session.project));
  if (!registered?.sourcePath) {
    throw worktreeError("sourcePath missing from registered project", "REVIEW_PROJECT_SOURCE_MISSING");
  }
  if (!registered.projectRuntimeRoot) {
    throw worktreeError("projectRuntimeRoot missing from registered project", "REVIEW_PROJECT_RUNTIME_ROOT_MISSING");
  }
  if (typeof session.jobId !== "string" || !SAFE_REVIEW_JOB_ID.test(session.jobId)) {
    throw worktreeError("review session jobId is missing or invalid", "REVIEW_WORKTREE_BINDING_INVALID");
  }
  const expectedWorktreePath = worktreePathFor(cpbRoot, session.jobId, registered.projectRuntimeRoot);
  const expectedBranch = `cpb/${session.jobId}-pipeline`;
  const authority = await loadDurableReviewWorktreeAuthority(
    cpbRoot,
    String(session.project),
    session.jobId,
    registered.projectRuntimeRoot,
  );
  if (
    intent.sourcePath !== path.resolve(registered.sourcePath)
    || session.worktreePath !== expectedWorktreePath
    || intent.worktreePath !== expectedWorktreePath
    || authority.worktreePath !== expectedWorktreePath
    || intent.worktreeBranch !== expectedBranch
    || authority.branch !== expectedBranch
    || session.sourceBaseBranch !== `refs/heads/${authority.baseBranch}`
    || intent.sourceBaseBranch !== session.sourceBaseBranch
    || session.sourceBaseCommit !== authority.baseCommit
    || intent.sourceBaseCommit !== session.sourceBaseCommit
    || authority.ownership.baseBranch !== authority.baseBranch
    || authority.ownership.baseCommit !== authority.baseCommit
    || !sameReadyWorktreeOwnership(intent.worktreeOwnership, authority.ownership)
  ) {
    throw worktreeError(
      "review decision session/event/registered path ownership bindings disagree",
      "REVIEW_WORKTREE_OWNERSHIP_MISMATCH",
    );
  }
  const worktreesRootPath = path.dirname(expectedWorktreePath);
  if (
    path.dirname(intent.quarantineContainerPath) !== worktreesRootPath
    || path.dirname(intent.quarantinePath) !== intent.quarantineContainerPath
    || path.basename(intent.quarantinePath) !== path.basename(expectedWorktreePath)
    || !path.basename(intent.quarantineContainerPath).startsWith(".review-quarantine-")
    || !REVIEW_DECISION_UUID.test(path.basename(intent.quarantineContainerPath).slice(".review-quarantine-".length))
  ) {
    throw worktreeError(
      "review decision quarantine paths escape their exact managed sibling container",
      "REVIEW_WORKTREE_QUARANTINE_BINDING_INVALID",
    );
  }
  const hooks = options.worktreeCleanupTestHooks || {};
  const runGit = hooks.runGit || ((cwd, args) => gitExec(cwd, ...args));
  const gitOwnership = await readGitReadyWorktreeOwnership(runGit, intent.sourcePath, expectedBranch);
  if (!sameReadyWorktreeOwnership(gitOwnership, authority.ownership)) {
    throw worktreeError(
      "review decision event and Git ownership bindings disagree",
      "REVIEW_WORKTREE_OWNERSHIP_MISMATCH",
    );
  }
  const branchHead = await runGit(intent.sourcePath, ["rev-parse", "--verify", `refs/heads/${expectedBranch}`]);
  if (branchHead !== intent.fixedWorktreeHead) {
    throw worktreeError(
      "review worktree branch moved after decision intent",
      "REVIEW_WORKTREE_HEAD_MISMATCH",
      { expectedHead: intent.fixedWorktreeHead, actualHead: branchHead },
    );
  }
  return {
    hubRoot,
    sourcePath: intent.sourcePath,
    worktreesRootPath,
    expectedWorktreePath,
    expectedBranch,
    intent,
    ownership: authority.ownership,
    hooks,
    runGit,
  };
}

async function createPrivateQuarantineContainer(
  root: DirectoryAuthority,
  worktreePath: string,
  hooks: ReviewWorktreeCleanupTestHooks,
) {
  const quarantineId = hooks.makeQuarantineId?.() || randomUUID();
  if (!REVIEW_DECISION_UUID.test(quarantineId)) {
    throw worktreeError("invalid quarantine container nonce", "REVIEW_WORKTREE_QUARANTINE_BINDING_INVALID");
  }
  const containerPath = path.join(root.path, `.review-quarantine-${quarantineId}`);
  await hooks.beforeQuarantineContainerCreate?.({ quarantineContainerPath: containerPath });
  try {
    await mkdirReview(containerPath, { mode: 0o700 });
  } catch (cause) {
    throw worktreeError(
      "exclusive private review quarantine container could not be created",
      errorCode(cause) === "EEXIST"
        ? "REVIEW_WORKTREE_QUARANTINE_COLLISION"
        : "REVIEW_WORKTREE_QUARANTINE_CREATE_FAILED",
      { recoveryPaths: [containerPath, worktreePath] },
      cause,
    );
  }
  const container = await pinDirectoryAuthority(containerPath, "private review quarantine container");
  if ((BigInt(container.identity.mode) & 0o077n) !== 0n) {
    await container.handle.close().catch(() => {});
    throw worktreeError(
      "review quarantine container is not private",
      "REVIEW_WORKTREE_QUARANTINE_BINDING_INVALID",
      { recoveryPaths: [containerPath, worktreePath] },
    );
  }
  return {
    container,
    quarantinePath: path.join(containerPath, path.basename(worktreePath)),
  };
}

async function prepareReviewDecisionIntent(
  cpbRoot: string,
  session: ReviewSessionRecord,
  action: ReviewDecisionAction,
  options: ReviewStorageOptions,
) {
  if (session.reviewDecision) {
    if (session.reviewDecision.action !== action) {
      throw worktreeError(
        `review decision is already bound to ${session.reviewDecision.action}`,
        "REVIEW_DECISION_CONFLICT",
      );
    }
    return session;
  }
  const hubRoot = options.hubRoot ? path.resolve(options.hubRoot) : resolveHubRoot(cpbRoot);
  const registered = await getProject(hubRoot, String(session.project));
  if (!registered?.sourcePath || !registered.projectRuntimeRoot) {
    throw worktreeError("registered project worktree authority is incomplete", "REVIEW_PROJECT_SOURCE_MISSING");
  }
  if (typeof session.jobId !== "string" || !SAFE_REVIEW_JOB_ID.test(session.jobId)) {
    throw worktreeError("review session jobId is missing or invalid", "REVIEW_WORKTREE_BINDING_INVALID");
  }
  if (
    typeof session.sourceBaseBranch !== "string"
    || !session.sourceBaseBranch.startsWith("refs/heads/")
    || typeof session.sourceBaseCommit !== "string"
    || !/^[0-9a-f]{40,64}$/.test(session.sourceBaseCommit)
  ) {
    throw worktreeError("review session source base binding is invalid", "REVIEW_SOURCE_BASE_BINDING_INVALID");
  }
  const expectedWorktreePath = worktreePathFor(cpbRoot, session.jobId, registered.projectRuntimeRoot);
  const expectedBranch = `cpb/${session.jobId}-pipeline`;
  if (session.worktreePath !== expectedWorktreePath) {
    throw worktreeError("review session worktree path is not the managed job path", "REVIEW_WORKTREE_BINDING_INVALID");
  }
  const durable = await loadDurableReviewWorktreeAuthority(
    cpbRoot,
    String(session.project),
    session.jobId,
    registered.projectRuntimeRoot,
  );
  if (
    durable.worktreePath !== expectedWorktreePath
    || durable.branch !== expectedBranch
    || session.sourceBaseBranch !== `refs/heads/${durable.baseBranch}`
    || session.sourceBaseCommit !== durable.baseCommit
  ) {
    throw worktreeError("review session and durable worktree event disagree", "REVIEW_WORKTREE_JOB_BINDING_MISMATCH");
  }
  const hooks = options.worktreeCleanupTestHooks || {};
  const runGit = hooks.runGit || ((cwd, args) => gitExec(cwd, ...args));
  const gitOwnership = await readGitReadyWorktreeOwnership(runGit, registered.sourcePath, expectedBranch);
  if (!sameReadyWorktreeOwnership(gitOwnership, durable.ownership)) {
    throw worktreeError("durable event and Git ownership disagree", "REVIEW_WORKTREE_OWNERSHIP_MISMATCH");
  }

  const source = await pinDirectoryAuthority(registered.sourcePath, "registered project source");
  let root: DirectoryAuthority | null = null;
  let worktree: DirectoryAuthority | null = null;
  let quarantineContainer: DirectoryAuthority | null = null;
  try {
    root = await pinDirectoryAuthority(path.dirname(expectedWorktreePath), "managed worktrees root");
    worktree = await pinDirectoryAuthority(expectedWorktreePath, "managed review worktree");
    if (
      worktree.canonicalPath !== path.join(root.canonicalPath, path.basename(expectedWorktreePath))
      || !sameWorktreeDirectoryIdentity(worktree.identity, durable.ownership.directory)
    ) {
      throw worktreeError(
        "current review worktree is not its create-time owned directory",
        "REVIEW_WORKTREE_OWNERSHIP_MISMATCH",
        { recoveryPaths: [expectedWorktreePath] },
      );
    }
    const fixedHead = await runGit(source.canonicalPath, ["rev-parse", "--verify", `refs/heads/${expectedBranch}`]);
    if (!/^[0-9a-f]{40,64}$/.test(fixedHead)) {
      throw worktreeError("review worktree branch head is invalid", "REVIEW_WORKTREE_HEAD_MISMATCH");
    }
    const sourceBefore = await captureSourceRepositoryState(
      runGit,
      source.canonicalPath,
      session.sourceBaseBranch,
    );
    const quarantine = await createPrivateQuarantineContainer(root, expectedWorktreePath, hooks);
    quarantineContainer = quarantine.container;
    const intent: ReviewDecisionIntent = {
      createdAt: new Date().toISOString(),
      sourcePath: source.canonicalPath,
      sourceBaseBranch: session.sourceBaseBranch,
      sourceBaseCommit: session.sourceBaseCommit,
      sourceBefore,
      worktreePath: expectedWorktreePath,
      worktreeBranch: expectedBranch,
      fixedWorktreeHead: fixedHead,
      worktreeOwnership: durable.ownership,
      quarantineContainerPath: quarantine.container.path,
      quarantineContainerDirectory: quarantine.container.identity,
      quarantinePath: quarantine.quarantinePath,
    };
    const binding: BoundReviewWorktree = {
      source,
      worktreesRoot: root,
      worktree,
      sourcePath: source.canonicalPath,
      worktreePath: expectedWorktreePath,
      branch: expectedBranch,
      branchRef: `refs/heads/${expectedBranch}`,
      head: fixedHead,
      baseBranch: durable.baseBranch,
      baseBranchRef: session.sourceBaseBranch,
      baseCommit: session.sourceBaseCommit,
      ownership: durable.ownership,
      intent,
      quarantineContainer,
      runGit,
      hooks,
      removed: false,
    };
    await assertWorktreeRegistration(binding);
    const journal: ReviewDecisionJournal = {
      version: 1,
      decisionId: randomUUID(),
      action,
      phase: "intent",
      intent,
      mergeProof: null,
      cleanupProof: null,
      final: null,
    };
    return await updateSession(cpbRoot, session.sessionId, { reviewDecision: journal }, options);
  } finally {
    await Promise.allSettled([
      quarantineContainer?.handle.close(),
      worktree?.handle.close(),
      root?.handle.close(),
      source.handle.close(),
    ]);
  }
}

function requirePreparedReviewDecision(
  session: ReviewSessionRecord,
  action: ReviewDecisionAction,
): ReviewDecisionJournal {
  const journal = session.reviewDecision;
  if (!journal || journal.action !== action) {
    throw worktreeError(
      journal ? `review decision is already bound to ${journal.action}` : "review decision intent was not persisted",
      journal ? "REVIEW_DECISION_CONFLICT" : "REVIEW_DECISION_INTENT_MISSING",
    );
  }
  return journal;
}

async function bindReviewWorktree(
  cpbRoot: string,
  session: ReviewSessionRecord,
  action: ReviewDecisionAction,
  options: ReviewStorageOptions,
): Promise<BoundReviewWorktree> {
  const authority = await loadReviewDecisionAuthority(cpbRoot, session, action, options);
  const source = await pinDirectoryAuthority(authority.sourcePath, "registered project source");
  let worktreesRoot: DirectoryAuthority | null = null;
  let worktree: DirectoryAuthority | null = null;
  let quarantineContainer: DirectoryAuthority | null = null;
  try {
    if (source.canonicalPath !== authority.sourcePath) {
      throw worktreeError("registered project source path changed canonical identity", "REVIEW_WORKTREE_REPOSITORY_MISMATCH");
    }
    worktreesRoot = await pinDirectoryAuthority(authority.worktreesRootPath, "managed worktrees root");
    quarantineContainer = await pinDirectoryAuthority(
      authority.intent.quarantineContainerPath,
      "private review quarantine container",
    );
    if (!sameWorktreeDirectoryIdentity(
      quarantineContainer.identity,
      authority.intent.quarantineContainerDirectory,
    )) {
      throw worktreeError(
        "review quarantine container changed after decision intent",
        "REVIEW_WORKTREE_QUARANTINE_BINDING_INVALID",
      );
    }
    worktree = await pinDirectoryAuthority(authority.expectedWorktreePath, "managed review worktree");
    const expectedCanonical = path.join(worktreesRoot.canonicalPath, path.basename(authority.expectedWorktreePath));
    if (worktree.canonicalPath !== expectedCanonical) {
      throw worktreeError("review worktree resolves outside its managed root", "REVIEW_WORKTREE_BINDING_INVALID");
    }
    if (!sameWorktreeDirectoryIdentity(worktree.identity, authority.ownership.directory)) {
      throw worktreeError(
        "canonical review worktree is a logical successor, not the create-time owned directory",
        "REVIEW_WORKTREE_OWNERSHIP_MISMATCH",
        { successorPreserved: true, recoveryPaths: [authority.expectedWorktreePath] },
      );
    }

    const binding: BoundReviewWorktree = {
      source,
      worktreesRoot,
      worktree,
      sourcePath: source.canonicalPath,
      worktreePath: authority.expectedWorktreePath,
      branch: authority.expectedBranch,
      branchRef: `refs/heads/${authority.expectedBranch}`,
      head: "",
      baseBranch: authority.ownership.baseBranch,
      baseBranchRef: authority.intent.sourceBaseBranch,
      baseCommit: authority.intent.sourceBaseCommit,
      ownership: authority.ownership,
      intent: authority.intent,
      quarantineContainer,
      runGit: authority.runGit,
      hooks: authority.hooks,
      removed: false,
    };
    await binding.runGit(binding.sourcePath, ["check-ref-format", binding.baseBranchRef]);
    await assertWorktreeRegistration(binding);
    return binding;
  } catch (error) {
    await Promise.allSettled([
      worktree?.handle.close(),
      worktreesRoot?.handle.close(),
      quarantineContainer?.handle.close(),
      source.handle.close(),
    ]);
    throw error;
  }
}

async function closeBoundReviewWorktree(binding: BoundReviewWorktree) {
  const settled = await Promise.allSettled([
    binding.worktree.handle.close(),
    binding.quarantineContainer.handle.close(),
    binding.worktreesRoot.handle.close(),
    binding.source.handle.close(),
  ]);
  const errors = settled
    .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
    .map((entry) => entry.reason);
  if (errors.length > 0) {
    throw worktreeError(
      "review worktree authority descriptors could not be closed cleanly",
      "REVIEW_WORKTREE_AUTHORITY_CLOSE_FAILED",
      { committed: binding.removed },
      errors.length === 1 ? errors[0] : new AggregateError(errors),
    );
  }
}

async function withBoundReviewWorktree<T>(
  cpbRoot: string,
  session: ReviewSessionRecord,
  actionKind: ReviewDecisionAction,
  options: ReviewStorageOptions,
  action: (binding: BoundReviewWorktree) => Promise<T>,
) {
  const binding = await bindReviewWorktree(cpbRoot, session, actionKind, options);
  let value: T | undefined;
  let primaryError: unknown = null;
  try {
    value = await action(binding);
  } catch (error) {
    primaryError = error;
  }
  try {
    await closeBoundReviewWorktree(binding);
  } catch (closeError) {
    if (!primaryError) throw closeError;
    throw Object.assign(
      new AggregateError([primaryError, closeError], "review worktree operation and authority cleanup both failed", { cause: primaryError }),
      {
        code: errorCode(primaryError) || "REVIEW_WORKTREE_OPERATION_FAILED",
        committed: binding.removed || Boolean((primaryError as { committed?: unknown })?.committed),
      },
    );
  }
  if (primaryError) throw primaryError;
  return value as T;
}

async function isolateBoundReviewWorktree(binding: BoundReviewWorktree): Promise<WorktreeCleanupResult> {
  const quarantinePath = binding.intent.quarantinePath;
  await binding.hooks.beforeIsolation?.({
    sourcePath: binding.sourcePath,
    worktreePath: binding.worktreePath,
    branch: binding.branch,
    quarantinePath,
  });
  try {
    lstatSync(quarantinePath);
    throw worktreeError(
      "review worktree quarantine destination unexpectedly exists",
      "REVIEW_WORKTREE_QUARANTINE_COLLISION",
      { recoveryPaths: [binding.worktreePath, quarantinePath] },
    );
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await assertWorktreeRegistration(binding);
  await assertDirectoryAuthority(binding.quarantineContainer, "private review quarantine container", {
    exactGeneration: true,
  });

  // This is the mutation boundary. The no-follow generation checks and rename
  // are deliberately synchronous and adjacent while the durable/process fence
  // is held. Production executes no callback between the final checks and the
  // rename. A test-only replacement seam proves the post-rename preservation
  // path without weakening the production path.
  const canonicalBefore = lstatSync(binding.worktreePath, { bigint: true });
  const parentBefore = lstatSync(binding.worktreesRoot.path, { bigint: true });
  const containerBefore = lstatSync(binding.quarantineContainer.path, { bigint: true });
  if (
    canonicalBefore.isSymbolicLink()
    || !canonicalBefore.isDirectory()
    || !sameDirectoryGeneration(binding.worktree.generation, directoryGeneration(canonicalBefore))
    || parentBefore.isSymbolicLink()
    || !parentBefore.isDirectory()
    || !sameDirectoryInstance(binding.worktreesRoot.generation, directoryGeneration(parentBefore))
    || containerBefore.isSymbolicLink()
    || !containerBefore.isDirectory()
    || !sameDirectoryGeneration(binding.quarantineContainer.generation, directoryGeneration(containerBefore))
    || !sameWorktreeDirectoryIdentity(
      worktreeDirectoryIdentity(containerBefore),
      binding.intent.quarantineContainerDirectory,
    )
  ) {
    throw worktreeError(
      "review worktree authority changed at the isolation boundary",
      "REVIEW_WORKTREE_GENERATION_CONFLICT",
      { recoveryPaths: [binding.worktreePath] },
    );
  }
  try {
    if (binding.hooks.renameSyncForTests) {
      binding.hooks.renameSyncForTests(binding.worktreePath, quarantinePath);
    } else {
      renameSync(binding.worktreePath, quarantinePath);
    }
  } catch (cause) {
    if (["EEXIST", "ENOTEMPTY", "EISDIR"].includes(errorCode(cause))) {
      throw worktreeError(
        "review worktree quarantine destination won a mutation-window race",
        "REVIEW_WORKTREE_QUARANTINE_COLLISION",
        { recoveryPaths: [binding.worktreePath, quarantinePath] },
        cause,
      );
    }
    throw cause;
  }
  binding.removed = true;
  try {
    await binding.hooks.afterIsolationRename?.({
      worktreePath: binding.worktreePath,
      quarantinePath,
    });
  } catch (cause) {
    if (isSimulatedReviewCrash(cause) && cause && typeof cause === "object") {
      throw Object.assign(cause, {
        committed: true,
        quarantinePreserved: true,
        recoveryPaths: [quarantinePath],
      });
    }
    throw worktreeError(
      "review worktree isolation committed before interruption",
      errorCode(cause) || "REVIEW_WORKTREE_ISOLATION_INTERRUPTED",
      {
        committed: true,
        quarantinePreserved: true,
        recoveryPaths: [quarantinePath],
      },
      cause,
    );
  }

  let quarantineInfo;
  try {
    const syncDirectory = binding.hooks.fsyncDirectory || fsyncDirectory;
    await syncDirectory(binding.quarantineContainer.path);
    await syncDirectory(binding.worktreesRoot.path);
    quarantineInfo = await lstat(quarantinePath, { bigint: true });
  } catch (cause) {
    throw worktreeError(
      "review worktree isolation committed but quarantine durability is unconfirmed",
      "REVIEW_WORKTREE_QUARANTINE_DURABILITY_FAILED",
      { committed: true, quarantinePreserved: true, recoveryPaths: [quarantinePath] },
      cause,
    );
  }
  if (
    quarantineInfo.isSymbolicLink()
    || !quarantineInfo.isDirectory()
    || !sameDirectoryInstance(directoryGeneration(canonicalBefore), directoryGeneration(quarantineInfo))
    || !sameWorktreeDirectoryIdentity(
      binding.ownership.directory,
      worktreeDirectoryIdentity(quarantineInfo),
    )
  ) {
    throw worktreeError(
      "a replacement was isolated instead of the bound review worktree; all observed paths were preserved",
      "REVIEW_WORKTREE_QUARANTINE_GENERATION_CONFLICT",
      { committed: true, quarantinePreserved: true, recoveryPaths: [quarantinePath] },
    );
  }

  await assertDirectoryAuthority(binding.source, "registered project source");
  await assertDirectoryAuthority(binding.worktreesRoot, "managed worktrees root");
  await assertDirectoryAuthority(binding.quarantineContainer, "private review quarantine container");
  await assertDirectoryAuthority(binding.worktree, "isolated review worktree descriptor", { requirePath: false });
  try {
    await lstat(binding.worktreePath);
    throw worktreeError(
      "a successor occupies the canonical review worktree path; both successor and quarantine were preserved",
      "REVIEW_WORKTREE_SUCCESSOR_PRESERVED",
      {
        committed: true,
        successorPreserved: true,
        quarantinePreserved: true,
        recoveryPaths: [binding.worktreePath, quarantinePath],
      },
    );
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const finalQuarantine = await lstat(quarantinePath, { bigint: true });
  if (
    finalQuarantine.isSymbolicLink()
    || !finalQuarantine.isDirectory()
    || !sameDirectoryInstance(directoryGeneration(quarantineInfo), directoryGeneration(finalQuarantine))
    || !sameWorktreeDirectoryIdentity(
      binding.ownership.directory,
      worktreeDirectoryIdentity(finalQuarantine),
    )
  ) {
    throw worktreeError(
      "review worktree quarantine changed after durable isolation",
      "REVIEW_WORKTREE_QUARANTINE_GENERATION_CONFLICT",
      { committed: true, quarantinePreserved: true, recoveryPaths: [quarantinePath] },
    );
  }
  // Deliberately retain the exact worktree administrative metadata and branch.
  // Repository-wide worktree metadata pruning could destroy recovery metadata
  // for unrelated missing worktrees. A later recovery workflow can
  // reconcile this one bound record explicitly from quarantine evidence.
  return {
    isolated: true,
    metadataPruned: false,
    metadataRetained: true,
    branchRetained: true,
    quarantinePath,
  };
}

async function withReviewWorktreeDecisionLock<T>(
  cpbRoot: string,
  sessionId: string,
  options: ReviewStorageOptions,
  operation: () => Promise<T>,
) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw worktreeError("invalid review session id for worktree decision", "REVIEW_WORKTREE_LOCK_PATH_INVALID");
  }
  const hubRoot = options.hubRoot ? path.resolve(options.hubRoot) : resolveHubRoot(cpbRoot);
  const namespace = await pinDirectoryAuthority(path.join(hubRoot, "reviews", ".locks"), "review decision lock namespace");
  const durableLock = path.join(namespace.canonicalPath, `${sessionId}.worktree-decision.lock`);
  const processFence = path.join(namespace.canonicalPath, `${sessionId}.worktree-operation.lock`);
  let value: T | undefined;
  let primaryError: unknown = null;
  try {
    value = await withDirectoryProcessFence(
      processFence,
      () => withDurableDirectoryLock(durableLock, operation, {
        ttlMs: 300_000,
        waitMs: 60_000,
        retryMs: 10,
      }),
      { waitMs: 60_000 },
    );
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    await namespace.handle.close();
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    throw Object.assign(
      new AggregateError([primaryError, closeError], "review decision and lock namespace cleanup both failed", { cause: primaryError }),
      { code: errorCode(primaryError) || "REVIEW_WORKTREE_DECISION_FAILED" },
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return value as T;
}

/**
 * Dispatch a review session to the hub queue.
 * Shared by approve and auto-approve routes.
 */
export async function dispatchSession(cpbRoot: string, sessionId: string, { hubRoot: hubRootOverride }: DispatchOptions = {}) {
  const storageOptions = { hubRoot: hubRootOverride };
  return withReviewWorktreeDecisionLock(cpbRoot, sessionId, storageOptions, async () => {
    const session = await getSession(cpbRoot, sessionId, storageOptions);
    if (!session) return { ok: false, error: "session_not_found" };

    const dispatchKey = `review:${session.sessionId}`;
    if (session.status === "dispatched" && session.jobId) {
      return {
        ok: true,
        sessionId: session.sessionId,
        taskId: session.queueEntryId || session.jobId,
        jobId: session.jobId,
        session,
        project: session.project,
      };
    }
    if (session.status !== "user_review" && session.status !== "dispatched") {
      return { ok: false, error: "invalid_state", status: session.status };
    }

    const hubRoot = hubRootOverride || resolveHubRoot(cpbRoot);
    const registered = await getProject(hubRoot, session.project);
    if (!registered?.sourcePath || !registered.projectRuntimeRoot) {
      return { ok: false, error: "project_not_registered", project: session.project };
    }
    const existingEntries = (await listQueue(hubRoot, { projectId: session.project }))
      .filter((candidate) => candidate.metadata?.queueDedupeKey === dispatchKey);
    if (existingEntries.length > 1) {
      return {
        ok: false,
        error: "dispatch_recovery_ambiguous",
        queueEntryIds: existingEntries.map((candidate) => candidate.id),
      };
    }

    let entry = existingEntries[0] || null;
    if (!entry) {
      const proposedJobId = makeJobId();
      const proposedWorktreePath = worktreePathFor(cpbRoot, proposedJobId, registered.projectRuntimeRoot);
      const proposedSourceBase = await captureRegisteredSourceBase(registered.sourcePath);
      entry = await enqueue(hubRoot, {
        projectId: session.project,
        sourcePath: registered.sourcePath,
        priority: "P1",
        description: session.intent,
        type: "review_dispatch",
        metadata: {
          source: "review",
          reviewSessionId: session.sessionId,
          queueDedupeKey: dispatchKey,
          jobId: proposedJobId,
          reviewSourcePath: path.resolve(registered.sourcePath),
          reviewProjectRuntimeRoot: path.resolve(registered.projectRuntimeRoot),
          reviewWorktreePath: proposedWorktreePath,
          reviewSourceBaseBranch: proposedSourceBase.branchRef,
          reviewSourceBaseCommit: proposedSourceBase.commit,
          workflow: "standard",
          autoFinalize: true,
          requestedAt: new Date().toISOString(),
        },
      });
    }

    const dispatchMetadata = recordValue(entry.metadata);
    const jobId = typeof dispatchMetadata.jobId === "string" ? dispatchMetadata.jobId : "";
    const wtPath = typeof dispatchMetadata.reviewWorktreePath === "string"
      ? dispatchMetadata.reviewWorktreePath
      : "";
    const sourceBaseBranch = typeof dispatchMetadata.reviewSourceBaseBranch === "string"
      ? dispatchMetadata.reviewSourceBaseBranch
      : "";
    const sourceBaseCommit = typeof dispatchMetadata.reviewSourceBaseCommit === "string"
      ? dispatchMetadata.reviewSourceBaseCommit
      : "";
    const expectedWorktreePath = jobId
      ? worktreePathFor(cpbRoot, jobId, registered.projectRuntimeRoot)
      : "";
    const bindingValid = entry.type === "review_dispatch"
      && entry.projectId === session.project
      && entry.description === session.intent
      && dispatchMetadata.reviewSessionId === session.sessionId
      && dispatchMetadata.queueDedupeKey === dispatchKey
      && dispatchMetadata.reviewSourcePath === path.resolve(registered.sourcePath)
      && dispatchMetadata.reviewProjectRuntimeRoot === path.resolve(registered.projectRuntimeRoot)
      && wtPath === expectedWorktreePath
      && sourceBaseBranch.startsWith("refs/heads/")
      && !sourceBaseBranch.includes("\0")
      && /^[0-9a-f]{40,64}$/.test(sourceBaseCommit);
    if (!bindingValid) {
      return {
        ok: false,
        error: "dispatch_recovery_binding_invalid",
        queueEntryId: entry.id,
      };
    }

    try {
      const updated = await updateSession(cpbRoot, session.sessionId, {
        status: "dispatched",
        userVerdict: "approved",
        jobId,
        queueEntryId: entry.id,
        worktreePath: wtPath,
        sourceBaseBranch,
        sourceBaseCommit,
        idempotency: {
          ...session.idempotency,
          dispatchKey,
        },
      }, storageOptions);

      return {
        ok: true,
        sessionId: session.sessionId,
        taskId: entry.id,
        jobId,
        session: updated,
        project: session.project,
      };
    } catch (err) {
      if (err?.message?.includes("already in status: dispatched")) {
        const current = await getSession(cpbRoot, session.sessionId, storageOptions);
        if (current?.status === "dispatched" && current.jobId) {
          return {
            ok: true,
            sessionId: current.sessionId,
            taskId: current.queueEntryId || entry.id,
            jobId: current.jobId,
            session: current,
            project: current.project || session.project,
          };
        }
      }
      throw err;
    }
  });
}

/**
 * Auto-approve path: handles already-dispatched sessions idempotently.
 */
export async function autoApproveSession(cpbRoot: string, sessionId: string, { hubRoot: hubRootOverride }: DispatchOptions = {}) {
  const session = await getSession(cpbRoot, sessionId, { hubRoot: hubRootOverride });
  if (!session) return { ok: false, error: "session_not_found" };

  if (!["dispatched", "user_review"].includes(session.status)) {
    return {
      ok: false,
      error: "invalid_state",
      status: session.status,
      note: "invalid_state_for_auto_approve",
    };
  }

  // If already dispatched with a jobId, just confirm
  if (session.status === "dispatched" && session.jobId) {
    return {
      ok: true,
      dispatched: true,
      sessionId: session.sessionId,
      taskId: session.jobId,
      project: session.project,
      session,
      note: "already_dispatched",
    };
  }

  // Transition from user_review → dispatched, then dispatch
  await updateSession(cpbRoot, session.sessionId, {
    status: "dispatched",
    userVerdict: "approved",
  }, { skipTransitionCheck: true });

  return dispatchSession(cpbRoot, sessionId, { hubRoot: hubRootOverride });
}

/**
 * Cancel a review session.
 */
export async function cancelReviewDispatch(cpbRoot: string, sessionId: string, reason: string, options: ReviewStorageOptions = {}) {
  const session = await getSession(cpbRoot, sessionId, options);
  if (!session) return { ok: false, error: "session_not_found" };

  const cancellation = await withReviewWorktreeDecisionLock(
    cpbRoot,
    session.sessionId,
    options,
    async () => {
      const current = await getSession(cpbRoot, session.sessionId, options);
      if (!current) return { ok: false as const, error: "session_not_found" };
      const updated = await cancelReviewSession(
        cpbRoot,
        current.sessionId,
        reason || "cancelled",
        options,
      );
      if (updated.status !== "cancelled") {
        return {
          ok: false as const,
          error: "invalid_state",
          status: updated.status,
          session: updated,
          project: updated.project,
        };
      }
      return {
        ok: true as const,
        sessionId: updated.sessionId,
        session: updated,
        project: updated.project,
      };
    },
  );
  if (!cancellation.ok) return cancellation;

  // Resolve the active run after the durable cancellation commit. A run that
  // registered while updateSession was in flight is then visible here; a run
  // that registers later re-reads the durable status before spawning ACP.
  const activeRun = activeReviewRuns.get(reviewRunKey(cpbRoot, session.sessionId));
  if (activeRun) {
    activeRun.abort(reason || "cancelled");
    await activeRun.teardown;
  }

  return cancellation;
}

/**
 * Run ACP analysis on a review session.
 */
export async function analyzeSession(cpbRoot: string, sessionId: string, options: ReviewStorageOptions = {}): Promise<AnalysisResult> {
  const session = await getSession(cpbRoot, sessionId, options);
  if (!session) return { ok: false, error: "session_not_found" };

  const sections: string[] = [];
  if (session.intent) sections.push(`## Intent\n${session.intent}`);
  if (session.research?.codex) sections.push(`## Codex Research\n${session.research.codex.slice(0, 3000)}`);
  if (session.research?.claude) sections.push(`## Claude Research\n${session.research.claude.slice(0, 3000)}`);
  if (session.plan) sections.push(`## Implementation Plan\n${session.plan.slice(0, 4000)}`);

  if (session.reviews && session.reviews.length > 0) {
    const latest = session.reviews[session.reviews.length - 1];
    if (latest.codex) sections.push(`## Codex Review (Round ${latest.round})\n${latest.codex.slice(0, 3000)}`);
    if (latest.claude) sections.push(`## Claude Review (Round ${latest.round})\n${latest.claude.slice(0, 3000)}`);
    const issues = [
      ...(latest.codexIssues || []).map((i: ReviewIssue) => `[Codex P${i.severity}] ${i.message || "issue"}`),
      ...(latest.claudeIssues || []).map((i: ReviewIssue) => `[Claude P${i.severity}] ${i.message || "issue"}`),
    ];
    if (issues.length > 0) sections.push(`## Issues Found\n${issues.join("\n")}`);
  }

  if (sections.length === 0) {
    return {
      ok: true,
      summary: "No content available yet for analysis.",
      changes: [],
      risks: [],
      recommendation: `Session is in ${session.status} state.`,
    };
  }

  const prompt = `You are a code review analyst. Analyze the following review session and produce a JSON object.

Project: ${session.project}
Status: ${session.status}

${sections.join("\n\n")}

Respond with ONLY a JSON object (no markdown fences) with these fields:
- "summary": one paragraph explaining what this review is about
- "changes": array of strings describing key changes proposed
- "risks": array of strings describing risks or concerns found
- "recommendation": string with clear approve/reject advice and reasoning`;

  const scriptPath = path.join(cpbRoot, "server", "services", "acp", "acp-client.js");
  const env = buildChildEnv(
    process.env,
    { CPB_ROOT: cpbRoot, CPB_ACP_TIMEOUT_MS: "90000" },
    { agent: "claude" },
  );

  type AcpResult = { error: string } | { output: string };
  const timeoutMs = reviewLifecycleMs("CPB_REVIEW_ANALYSIS_TIMEOUT_MS", 120_000);
  const termGraceMs = reviewLifecycleMs("CPB_REVIEW_ANALYSIS_TERM_GRACE_MS", 1_000);
  const forceVerifyMs = reviewLifecycleMs("CPB_REVIEW_ANALYSIS_KILL_GRACE_MS", 1_000);
  const closeGraceMs = reviewLifecycleMs("CPB_REVIEW_ANALYSIS_CLOSE_GRACE_MS", 1_000);
  const acpResult = await (async (): Promise<AcpResult> => {
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [scriptPath, "--agent", "claude", "--cwd", cpbRoot], {
        cwd: cpbRoot,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }

    const closed = monitorReviewChildClose(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });

    let identity: ProcessIdentity | null = null;
    let initialFailure: Error | null = null;
    if (!child.pid) {
      initialFailure = reviewChildLifecycleError(
        "review analysis child did not expose a pid",
        "CHILD_PROCESS_IDENTITY_UNAVAILABLE",
      );
    } else {
      try {
        identity = captureProcessIdentity(child.pid, {
          strict: true,
          ...(options.processTreeSystem ? { system: options.processTreeSystem } : {}),
        });
        if (!identity) {
          initialFailure = reviewChildLifecycleError(
            `review analysis child ${child.pid} exited before its process identity was captured`,
            "CHILD_PROCESS_IDENTITY_UNAVAILABLE",
          );
        }
      } catch (error) {
        initialFailure = reviewChildLifecycleError(
          `review analysis child ${child.pid} process identity could not be captured`,
          "CHILD_PROCESS_IDENTITY_UNAVAILABLE",
          error,
        );
      }
    }

    let triggerFailure: (error: Error) => void = () => {};
    let failureTriggered = false;
    const forcedFailure = new Promise<Error>((resolve) => {
      triggerFailure = (error) => {
        if (failureTriggered) return;
        failureTriggered = true;
        resolve(error);
      };
    });
    child.stdin?.once("error", (error) => triggerFailure(error));
    if (initialFailure) {
      triggerFailure(initialFailure);
    } else {
      try {
        child.stdin?.end(prompt);
      } catch (error) {
        triggerFailure(error instanceof Error ? error : new Error(String(error)));
      }
    }

    const timeoutMarker = Symbol("review-analysis-timeout");
    let timer: NodeJS.Timeout | null = null;
    const first = await Promise.race([
      closed,
      forcedFailure,
      new Promise<typeof timeoutMarker>((resolve) => {
        timer = setTimeout(() => resolve(timeoutMarker), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (typeof first === "object" && !(first instanceof Error)) {
      if (first.error) return { error: first.error.message };
      if (first.code !== 0 && !stdout) {
        return { error: stderr.slice(-500) || `ACP exited with code ${first.code}` };
      }
      return { output: stdout };
    }

    let primary = first instanceof Error
      ? first
      : reviewChildLifecycleError(`review analysis timed out after ${timeoutMs}ms`, "REVIEW_ANALYSIS_TIMEOUT");
    const cleanupErrors: unknown[] = [];
    try {
      child.stdin?.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await terminateReviewAnalysisChild(
        child,
        identity,
        termGraceMs,
        forceVerifyMs,
        options.processTreeSystem,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }

    let closeRecord: ReviewChildCloseRecord | null = null;
    try {
      closeRecord = await waitForReviewChildClose(closed, closeGraceMs, "review analysis child");
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!child.pid && closeRecord?.error) primary = closeRecord.error;
    else if (closeRecord?.error && closeRecord.error !== primary) cleanupErrors.push(closeRecord.error);
    if (cleanupErrors.length > 0) {
      throw aggregateReviewChildFailure("review analysis", primary, cleanupErrors);
    }
    if (first === timeoutMarker) return { error: "Analysis timed out" };
    return { error: primary.message };
  })();

  // acpResult narrowed by discriminant via typed Promise above.
  if ("error" in acpResult) {
    return { ok: false, summary: `Analysis failed: ${acpResult.error}`, changes: [], risks: [], recommendation: "Could not complete ACP analysis. Review the session content manually." };
  }

  let parsed = null;
  const rawOutput = acpResult.output || "";
  const jsonMatch = rawOutput.match(/```json\s*([\s\S]*?)```/) || rawOutput.match(/\{[\s\S]*"summary"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    } catch { /* fall through */ }
  }

  if (parsed && parsed.summary) {
    return {
      ok: true,
      summary: parsed.summary,
      changes: Array.isArray(parsed.changes) ? parsed.changes : [],
      risks: Array.isArray(parsed.risks) ? parsed.risks : [],
      recommendation: parsed.recommendation || "",
      raw: rawOutput,
    };
  }

  return {
    ok: true,
    summary: rawOutput.slice(0, 500) || "Analysis produced no output.",
    changes: [],
    risks: [],
    recommendation: "Review the raw analysis output for details.",
    raw: rawOutput,
  };
}

function sourceStateComparable(state: ReviewSourceRepositoryState) {
  return JSON.stringify({
    symbolicRef: state.symbolicRef,
    head: state.head,
    baseRefHead: state.baseRefHead,
    mergeHead: state.mergeHead,
    statusPorcelainV2: state.statusPorcelainV2,
    indexEntries: state.indexEntries,
    indexTree: state.indexTree,
    captureErrors: state.captureErrors,
  });
}

function sameSourceState(left: ReviewSourceRepositoryState, right: ReviewSourceRepositoryState) {
  return sourceStateComparable(left) === sourceStateComparable(right);
}

function exactUnchangedSourceState(
  left: ReviewSourceRepositoryState,
  right: ReviewSourceRepositoryState,
) {
  return left.captureErrors.length === 0
    && right.captureErrors.length === 0
    && sameSourceState(left, right);
}

async function captureSourceRepositoryState(
  runGit: ReviewWorktreeGitRunner,
  sourcePath: string,
  baseBranchRef: string,
): Promise<ReviewSourceRepositoryState> {
  const captureErrors: string[] = [];
  const required = async (label: string, args: string[]) => {
    try {
      return await runGit(sourcePath, args);
    } catch (error) {
      captureErrors.push(`${label}: ${errorCode(error) || "GIT_PROBE_FAILED"}: ${errorMessage(error)}`);
      return null;
    }
  };
  const optional = async (label: string, args: string[]) => {
    try {
      return await runGit(sourcePath, args);
    } catch (error) {
      const exitCode = Number((error as { exitCode?: unknown })?.exitCode);
      if (exitCode === 1 || exitCode === 128) return null;
      captureErrors.push(`${label}: ${errorCode(error) || "GIT_PROBE_FAILED"}: ${errorMessage(error)}`);
      return null;
    }
  };
  const symbolicRef = await optional("symbolic HEAD", ["symbolic-ref", "--quiet", "HEAD"]);
  const head = await required("HEAD", ["rev-parse", "--verify", "HEAD"]);
  const baseRefHead = await required("base ref", ["rev-parse", "--verify", baseBranchRef]);
  const mergeHead = await optional("MERGE_HEAD", ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
  const statusPorcelainV2 = await required("status", [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  const indexEntries = await required("index entries", ["ls-files", "--stage", "-z"]);
  const indexTree = await required("index tree", ["write-tree"]);
  const finalStatus = await required("final status", [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
  ]);
  const finalIndexEntries = await required("final index entries", ["ls-files", "--stage", "-z"]);
  const finalMergeHead = await optional("final MERGE_HEAD", ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
  const finalSymbolicRef = await optional("final symbolic HEAD", ["symbolic-ref", "--quiet", "HEAD"]);
  const finalHead = await required("final HEAD", ["rev-parse", "--verify", "HEAD"]);
  const finalBaseRefHead = await required("final base ref", ["rev-parse", "--verify", baseBranchRef]);
  if (
    symbolicRef !== finalSymbolicRef
    || head !== finalHead
    || baseRefHead !== finalBaseRefHead
    || mergeHead !== finalMergeHead
    || statusPorcelainV2 !== finalStatus
    || indexEntries !== finalIndexEntries
  ) {
    captureErrors.push("source repository changed during exact state capture");
  }
  return {
    symbolicRef: finalSymbolicRef,
    head: finalHead,
    baseRefHead: finalBaseRefHead,
    mergeHead: finalMergeHead,
    statusPorcelainV2: finalStatus ?? "",
    indexEntries: finalIndexEntries ?? "",
    indexTree,
    captureErrors,
  };
}

function assertCleanSourceBaseState(intent: ReviewDecisionIntent, state: ReviewSourceRepositoryState) {
  if (state.captureErrors.length > 0 || state.indexTree === null) {
    throw worktreeError(
      "registered source state could not be captured exactly",
      "REVIEW_SOURCE_STATE_UNCONFIRMED",
      { sourceState: state },
    );
  }
  if (state.symbolicRef !== intent.sourceBaseBranch) {
    throw worktreeError(
      `registered source branch changed: expected ${intent.sourceBaseBranch}, received ${state.symbolicRef || "detached"}`,
      "REVIEW_SOURCE_BRANCH_MISMATCH",
      { sourceState: state },
    );
  }
  if (state.head !== intent.sourceBaseCommit || state.baseRefHead !== intent.sourceBaseCommit) {
    throw worktreeError(
      "registered source HEAD/ref changed after review dispatch",
      "REVIEW_SOURCE_HEAD_MISMATCH",
      { sourceState: state },
    );
  }
  if (state.mergeHead !== null || state.statusPorcelainV2 !== "") {
    throw worktreeError(
      "registered source checkout is dirty or has an in-progress merge",
      "REVIEW_SOURCE_DIRTY",
      { sourceState: state },
    );
  }
}

async function withReviewRepositoryMutationFence<T>(
  authority: ReviewDecisionAuthority,
  operation: () => Promise<T>,
) {
  const namespace = await pinDirectoryAuthority(
    path.join(authority.hubRoot, "reviews", ".locks"),
    "review repository mutation lock namespace",
  );
  const digest = createHash("sha256").update(authority.sourcePath).digest("hex");
  const durableLock = path.join(namespace.canonicalPath, `${digest}.repository-mutation.lock`);
  const processFence = path.join(namespace.canonicalPath, `${digest}.repository-operation.lock`);
  let result: T | undefined;
  let primaryError: unknown = null;
  try {
    result = await withDirectoryProcessFence(
      processFence,
      () => withDurableDirectoryLock(durableLock, operation, {
        ttlMs: 300_000,
        waitMs: 60_000,
        retryMs: 10,
      }),
      { waitMs: 60_000 },
    );
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try { await namespace.handle.close(); } catch (error) { closeError = error; }
  if (primaryError && closeError) {
    throw Object.assign(
      new AggregateError([primaryError, closeError], "repository mutation and lock authority close both failed", {
        cause: primaryError,
      }),
      { code: errorCode(primaryError) || "REVIEW_REPOSITORY_MUTATION_FAILED" },
    );
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return result as T;
}

async function exactMergeCommitProof(
  runGit: ReviewWorktreeGitRunner,
  intent: ReviewDecisionIntent,
  decisionId: string,
  mergeCommit: string,
  expectedTree?: string,
) {
  if (!/^[0-9a-f]{40,64}$/.test(mergeCommit)) return null;
  try {
    const parentLine = await runGit(intent.sourcePath, ["rev-list", "--parents", "-n", "1", mergeCommit]);
    const [commit, ...parents] = parentLine.split(/\s+/).filter(Boolean);
    const tree = await runGit(intent.sourcePath, ["show", "-s", "--format=%T", mergeCommit]);
    const message = await runGit(intent.sourcePath, ["show", "-s", "--format=%B", mergeCommit]);
    if (
      commit !== mergeCommit
      || parents.length !== 2
      || parents[0] !== intent.sourceBaseCommit
      || parents[1] !== intent.fixedWorktreeHead
      || (expectedTree !== undefined && tree !== expectedTree)
      || !message.split(/\r?\n/).includes(`CPB-Review-Decision: ${decisionId}`)
    ) return null;
    return { mergeCommit, parents, tree };
  } catch {
    return null;
  }
}

function mergeProofError(
  before: ReviewSourceRepositoryState,
  after: ReviewSourceRepositoryState,
  error: unknown,
  exact: { mergeCommit: string; parents: string[]; tree: string } | null,
): ReviewMergeProof {
  const unchanged = exactUnchangedSourceState(before, after);
  const sourceMutation = !unchanged;
  return {
    outcome: exact ? "committed" : unchanged ? "not_committed" : "unconfirmed",
    mergeCommit: exact?.mergeCommit ?? null,
    parents: exact?.parents ?? [],
    tree: exact?.tree ?? null,
    before,
    after,
    sourceMutation,
    errorCode: errorCode(error) || "REVIEW_MERGE_FAILED",
    error: errorMessage(error),
  };
}

async function createOrRecoverMergeProof(
  authority: ReviewDecisionAuthority,
  journal: ReviewDecisionJournal,
) {
  return withReviewRepositoryMutationFence(authority, async (): Promise<ReviewMergeProof> => {
    const { intent } = journal;
    const before = intent.sourceBefore;
    const observedBefore = await captureSourceRepositoryState(
      authority.runGit,
      authority.sourcePath,
      intent.sourceBaseBranch,
    );
    let expectedTree: string | undefined;
    try {
      await authority.runGit(authority.sourcePath, [
        "merge-base",
        "--is-ancestor",
        intent.sourceBaseCommit,
        intent.fixedWorktreeHead,
      ]);
    } catch (cause) {
      const after = await captureSourceRepositoryState(authority.runGit, authority.sourcePath, intent.sourceBaseBranch);
      return mergeProofError(
        before,
        after,
        worktreeError(
          "review worktree head is not descended from its pinned base commit",
          "REVIEW_WORKTREE_HEAD_NOT_DESCENDANT",
          {},
          cause,
        ),
        null,
      );
    }

    if (observedBefore.baseRefHead && observedBefore.baseRefHead !== intent.sourceBaseCommit) {
      const recovered = await exactMergeCommitProof(
        authority.runGit,
        intent,
        journal.decisionId,
        observedBefore.baseRefHead,
      );
      if (recovered) {
        let recoveredState = observedBefore;
        let validCheckout = recoveredState.symbolicRef === intent.sourceBaseBranch
          && recoveredState.head === recovered.mergeCommit
          && recoveredState.mergeHead === null
          && recoveredState.statusPorcelainV2 === ""
          && recoveredState.captureErrors.length === 0;
        if (
          !validCheckout
          && recoveredState.captureErrors.length === 0
          && recoveredState.symbolicRef === intent.sourceBaseBranch
          && recoveredState.head === recovered.mergeCommit
          && recoveredState.baseRefHead === recovered.mergeCommit
          && recoveredState.mergeHead === null
          && recoveredState.indexEntries === before.indexEntries
          && recoveredState.indexTree === before.indexTree
          && before.captureErrors.length === 0
          && before.statusPorcelainV2 === ""
        ) {
          try {
            await authority.runGit(authority.sourcePath, ["diff", "--quiet"]);
            const untracked = await authority.runGit(authority.sourcePath, [
              "ls-files",
              "--others",
              "--exclude-standard",
              "-z",
            ]);
            if (untracked) throw new Error("source has untracked files after interrupted ref CAS");
            await authority.runGit(authority.sourcePath, [
              "read-tree",
              "--reset",
              "-u",
              recovered.mergeCommit,
            ]);
            recoveredState = await captureSourceRepositoryState(
              authority.runGit,
              authority.sourcePath,
              intent.sourceBaseBranch,
            );
            validCheckout = recoveredState.captureErrors.length === 0
              && recoveredState.symbolicRef === intent.sourceBaseBranch
              && recoveredState.head === recovered.mergeCommit
              && recoveredState.baseRefHead === recovered.mergeCommit
              && recoveredState.mergeHead === null
              && recoveredState.statusPorcelainV2 === "";
          } catch {
            // Preserve the exact observed state; a non-base index/worktree is
            // never overwritten during retry.
          }
        }
        return {
          outcome: "committed",
          mergeCommit: recovered.mergeCommit,
          parents: recovered.parents,
          tree: recovered.tree,
          before,
          after: recoveredState,
          sourceMutation: !exactUnchangedSourceState(before, recoveredState),
          errorCode: validCheckout ? null : "REVIEW_SOURCE_POST_MERGE_MISMATCH",
          error: validCheckout ? null : "exact merge commit exists but source checkout no longer matches it",
        };
      }
    }

    try {
      if (!sameSourceState(before, observedBefore)) {
        throw worktreeError(
          "registered source changed after decision intent was persisted",
          "REVIEW_SOURCE_MUTATION_RACE",
          { before, after: observedBefore },
        );
      }
      assertCleanSourceBaseState(intent, before);
      expectedTree = (await authority.runGit(authority.sourcePath, [
        "merge-tree",
        "--write-tree",
        intent.sourceBaseCommit,
        intent.fixedWorktreeHead,
      ])).split(/\r?\n/, 1)[0];
      if (!/^[0-9a-f]{40,64}$/.test(expectedTree)) {
        throw worktreeError("merge-tree returned an invalid tree", "REVIEW_MERGE_TREE_INVALID");
      }

      await authority.hooks.beforeSourceMutation?.({
        sourcePath: authority.sourcePath,
        baseBranchRef: intent.sourceBaseBranch,
        baseCommit: intent.sourceBaseCommit,
        fixedWorktreeHead: intent.fixedWorktreeHead,
      });
      const finalPreMutation = await captureSourceRepositoryState(
        authority.runGit,
        authority.sourcePath,
        intent.sourceBaseBranch,
      );
      if (!sameSourceState(observedBefore, finalPreMutation)) {
        throw worktreeError(
          "registered source changed inside the repository mutation fence",
          "REVIEW_SOURCE_MUTATION_RACE",
          { before, after: finalPreMutation },
        );
      }
      assertCleanSourceBaseState(intent, finalPreMutation);

      const mergeMessage = [
        `cpb: accept review ${journal.decisionId}`,
        "",
        `CPB-Review-Decision: ${journal.decisionId}`,
      ].join("\n");
      const mergeCommit = await authority.runGit(authority.sourcePath, [
        "commit-tree",
        expectedTree,
        "-p",
        intent.sourceBaseCommit,
        "-p",
        intent.fixedWorktreeHead,
        "-m",
        mergeMessage,
      ]);
      if (!/^[0-9a-f]{40,64}$/.test(mergeCommit)) {
        throw worktreeError("commit-tree returned an invalid merge commit", "REVIEW_MERGE_COMMIT_INVALID");
      }
      await authority.runGit(authority.sourcePath, [
        "update-ref",
        intent.sourceBaseBranch,
        mergeCommit,
        intent.sourceBaseCommit,
      ]);
      await authority.hooks.afterMergeRefCas?.({ sourcePath: authority.sourcePath, mergeCommit });

      const afterRef = await captureSourceRepositoryState(
        authority.runGit,
        authority.sourcePath,
        intent.sourceBaseBranch,
      );
      const refProof = await exactMergeCommitProof(
        authority.runGit,
        intent,
        journal.decisionId,
        mergeCommit,
        expectedTree,
      );
      if (
        !refProof
        || afterRef.baseRefHead !== mergeCommit
        || afterRef.symbolicRef !== intent.sourceBaseBranch
        || afterRef.head !== mergeCommit
      ) {
        throw worktreeError(
          "source ref CAS committed but checkout/ref proof is inconsistent",
          "REVIEW_SOURCE_POST_MERGE_MISMATCH",
          { sourceState: afterRef, mergeCommit },
        );
      }

      // `read-tree` updates the index/worktree for the explicitly CAS-updated
      // base ref without dereferencing HEAD to mutate any other branch ref.
      await authority.runGit(authority.sourcePath, ["read-tree", "--reset", "-u", mergeCommit]);
      const after = await captureSourceRepositoryState(
        authority.runGit,
        authority.sourcePath,
        intent.sourceBaseBranch,
      );
      if (
        after.captureErrors.length > 0
        || after.symbolicRef !== intent.sourceBaseBranch
        || after.head !== mergeCommit
        || after.baseRefHead !== mergeCommit
        || after.mergeHead !== null
        || after.statusPorcelainV2 !== ""
      ) {
        throw worktreeError(
          "source merge committed but checkout post-state is not exact",
          "REVIEW_SOURCE_POST_MERGE_MISMATCH",
          { sourceState: after, mergeCommit },
        );
      }
      try {
        await authority.hooks.afterMergeBeforeJournal?.({ sourcePath: authority.sourcePath, mergeCommit });
      } catch (cause) {
        if (isSimulatedReviewCrash(cause)) {
          throw cause;
        }
        throw worktreeError(
          "source merge committed before post-merge interruption",
          errorCode(cause) || "REVIEW_MERGE_POST_COMMIT_INTERRUPTED",
          { committed: true, mergeCommit, sourceState: after },
          cause,
        );
      }
      return {
        outcome: "committed",
        mergeCommit,
        parents: refProof.parents,
        tree: refProof.tree,
        before,
        after,
        sourceMutation: true,
        errorCode: null,
        error: null,
      };
    } catch (error) {
      if (isSimulatedReviewCrash(error)) throw error;
      const after = await captureSourceRepositoryState(authority.runGit, authority.sourcePath, intent.sourceBaseBranch);
      const exact = after.baseRefHead
        ? await exactMergeCommitProof(authority.runGit, intent, journal.decisionId, after.baseRefHead, expectedTree)
        : null;
      return mergeProofError(before, after, error, exact);
    }
  });
}

async function inspectDecisionIsolation(
  authority: ReviewDecisionAuthority,
): Promise<ReviewCleanupProof> {
  const root = await pinDirectoryAuthority(authority.worktreesRootPath, "managed worktrees root");
  let container: DirectoryAuthority | null = null;
  try {
    container = await pinDirectoryAuthority(
      authority.intent.quarantineContainerPath,
      "private review quarantine container",
    );
    if (!sameWorktreeDirectoryIdentity(
      container.identity,
      authority.intent.quarantineContainerDirectory,
    )) {
      throw worktreeError(
        "review quarantine container no longer matches decision intent",
        "REVIEW_WORKTREE_QUARANTINE_BINDING_INVALID",
      );
    }

    let canonicalInfo: BigIntStats | null = null;
    let quarantineInfo: BigIntStats | null = null;
    try { canonicalInfo = await lstat(authority.intent.worktreePath, { bigint: true }); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    try { quarantineInfo = await lstat(authority.intent.quarantinePath, { bigint: true }); } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const canonicalOwned = Boolean(
      canonicalInfo
      && canonicalInfo.isDirectory()
      && !canonicalInfo.isSymbolicLink()
      && sameWorktreeDirectoryIdentity(
        authority.ownership.directory,
        worktreeDirectoryIdentity(canonicalInfo),
      ),
    );
    const quarantineOwned = Boolean(
      quarantineInfo
      && quarantineInfo.isDirectory()
      && !quarantineInfo.isSymbolicLink()
      && sameWorktreeDirectoryIdentity(
        authority.ownership.directory,
        worktreeDirectoryIdentity(quarantineInfo),
      ),
    );
    const successorPreserved = Boolean(canonicalInfo && !canonicalOwned);
    const recoveryPaths = [
      ...(quarantineInfo ? [authority.intent.quarantinePath] : []),
      ...(canonicalInfo ? [authority.intent.worktreePath] : []),
    ];

    if (quarantineOwned) {
      if (canonicalOwned) {
        return {
          outcome: "unconfirmed",
          committed: false,
          durabilityConfirmed: false,
          quarantinePreserved: true,
          successorPreserved: true,
          recoveryPaths,
          errorCode: "REVIEW_WORKTREE_DUPLICATE_OWNERSHIP",
          error: "the same create-time worktree identity appears at both canonical and quarantine paths",
        };
      }
      try {
        const syncDirectory = authority.hooks.fsyncDirectory || fsyncDirectory;
        await syncDirectory(container.path);
        await syncDirectory(root.path);
        await assertDirectoryAuthority(container, "private review quarantine container");
        await assertDirectoryAuthority(root, "managed worktrees root");
        const final = await lstat(authority.intent.quarantinePath, { bigint: true });
        if (
          final.isSymbolicLink()
          || !final.isDirectory()
          || !sameWorktreeDirectoryIdentity(authority.ownership.directory, worktreeDirectoryIdentity(final))
        ) {
          throw worktreeError(
            "quarantine identity changed during durability proof",
            "REVIEW_WORKTREE_QUARANTINE_GENERATION_CONFLICT",
          );
        }
        return {
          outcome: "committed",
          committed: true,
          durabilityConfirmed: true,
          quarantinePreserved: true,
          successorPreserved,
          recoveryPaths,
          errorCode: null,
          error: null,
        };
      } catch (error) {
        return {
          outcome: "committed",
          committed: true,
          durabilityConfirmed: false,
          quarantinePreserved: true,
          successorPreserved,
          recoveryPaths,
          errorCode: errorCode(error) || "REVIEW_WORKTREE_QUARANTINE_DURABILITY_FAILED",
          error: errorMessage(error),
        };
      }
    }

    if (quarantineInfo) {
      return {
        outcome: canonicalOwned ? "not_committed" : "unconfirmed",
        committed: false,
        durabilityConfirmed: false,
        quarantinePreserved: true,
        successorPreserved,
        recoveryPaths,
        errorCode: "REVIEW_WORKTREE_QUARANTINE_COLLISION",
        error: "quarantine destination is occupied by an unrelated preserved entry",
      };
    }
    if (canonicalOwned) {
      return {
        outcome: "not_committed",
        committed: false,
        durabilityConfirmed: false,
        quarantinePreserved: false,
        successorPreserved: false,
        recoveryPaths,
        errorCode: null,
        error: null,
      };
    }
    return {
      outcome: "unconfirmed",
      committed: false,
      durabilityConfirmed: false,
      quarantinePreserved: false,
      successorPreserved,
      recoveryPaths,
      errorCode: successorPreserved
        ? "REVIEW_WORKTREE_SUCCESSOR_PRESERVED"
        : "REVIEW_WORKTREE_OWNED_DIRECTORY_MISSING",
      error: successorPreserved
        ? "canonical worktree path contains a logical successor; it was preserved"
        : "create-time owned worktree is absent from canonical and quarantine paths",
    };
  } finally {
    await Promise.allSettled([container?.handle.close(), root.handle.close()]);
  }
}

async function fallbackIsolationTruth(
  authority: ReviewDecisionAuthority,
  error: unknown,
  prior: ReviewCleanupProof | null,
): Promise<ReviewCleanupProof> {
  let canonicalInfo: BigIntStats | null = null;
  let quarantineInfo: BigIntStats | null = null;
  try { canonicalInfo = await lstat(authority.intent.worktreePath, { bigint: true }); } catch {
    // Path absence or an unreadable successor is represented by the retained journal/error evidence below.
  }
  try { quarantineInfo = await lstat(authority.intent.quarantinePath, { bigint: true }); } catch {
    // Path absence or an unreadable quarantine is represented by the retained journal/error evidence below.
  }
  const quarantineOwned = Boolean(
    quarantineInfo
    && quarantineInfo.isDirectory()
    && !quarantineInfo.isSymbolicLink()
    && sameWorktreeDirectoryIdentity(
      authority.ownership.directory,
      worktreeDirectoryIdentity(quarantineInfo),
    ),
  );
  const canonicalOwned = Boolean(
    canonicalInfo
    && canonicalInfo.isDirectory()
    && !canonicalInfo.isSymbolicLink()
    && sameWorktreeDirectoryIdentity(
      authority.ownership.directory,
      worktreeDirectoryIdentity(canonicalInfo),
    ),
  );
  const committed = quarantineOwned
    || prior?.committed === true
    || (error as { committed?: unknown })?.committed === true;
  const recoveryPaths = [...new Set([
    ...(prior?.recoveryPaths || []),
    ...(((error as { recoveryPaths?: unknown })?.recoveryPaths as string[] | undefined) || []),
    ...(quarantineInfo ? [authority.intent.quarantinePath] : []),
    ...(canonicalInfo ? [authority.intent.worktreePath] : []),
  ])];
  return {
    outcome: committed ? "committed" : canonicalOwned ? "not_committed" : "unconfirmed",
    committed,
    durabilityConfirmed: false,
    quarantinePreserved: quarantineOwned
      || Boolean(quarantineInfo)
      || prior?.quarantinePreserved === true
      || (error as { quarantinePreserved?: unknown })?.quarantinePreserved === true,
    successorPreserved: Boolean(canonicalInfo && !canonicalOwned)
      || prior?.successorPreserved === true
      || (error as { successorPreserved?: unknown })?.successorPreserved === true,
    recoveryPaths,
    errorCode: errorCode(error) || "REVIEW_WORKTREE_ISOLATION_POSTCHECK_FAILED",
    error: errorMessage(error),
  };
}

async function createOrRecoverCleanupProof(
  cpbRoot: string,
  session: ReviewSessionRecord,
  action: ReviewDecisionAction,
  options: ReviewStorageOptions,
) {
  const prior = session.reviewDecision?.cleanupProof || null;
  let authority: ReviewDecisionAuthority;
  try {
    authority = await loadReviewDecisionAuthority(cpbRoot, session, action, options);
  } catch (error) {
    if (prior?.committed) {
      return {
        ...prior,
        outcome: "committed" as const,
        committed: true,
        durabilityConfirmed: false,
        errorCode: errorCode(error) || "REVIEW_DECISION_AUTHORITY_FAILED",
        error: errorMessage(error),
      };
    }
    throw error;
  }
  let before: ReviewCleanupProof;
  try {
    before = await inspectDecisionIsolation(authority);
  } catch (error) {
    return fallbackIsolationTruth(authority, error, prior);
  }
  if (before.committed || before.errorCode) return before;
  try {
    await withBoundReviewWorktree(cpbRoot, session, action, options, isolateBoundReviewWorktree);
    return await inspectDecisionIsolation(authority);
  } catch (error) {
    if (isSimulatedReviewCrash(error)) throw error;
    let observed: ReviewCleanupProof;
    try {
      observed = await inspectDecisionIsolation(authority);
    } catch (postcheckError) {
      const combined = Object.assign(
        new AggregateError([error, postcheckError], "review isolation and committed-state postcheck both failed", {
          cause: error,
        }),
        {
          code: errorCode(error) || errorCode(postcheckError) || "REVIEW_WORKTREE_ISOLATION_POSTCHECK_FAILED",
          committed: Boolean((error as { committed?: unknown })?.committed),
          quarantinePreserved: Boolean((error as { quarantinePreserved?: unknown })?.quarantinePreserved),
          successorPreserved: Boolean((error as { successorPreserved?: unknown })?.successorPreserved),
          recoveryPaths: ((error as { recoveryPaths?: unknown })?.recoveryPaths as string[] | undefined) || [],
        },
      );
      return fallbackIsolationTruth(authority, combined, prior);
    }
    return {
      ...observed,
      errorCode: errorCode(error) || observed.errorCode || "REVIEW_WORKTREE_CLEANUP_FAILED",
      error: errorMessage(error),
      committed: observed.committed || Boolean((error as { committed?: unknown })?.committed),
      outcome: observed.committed || (error as { committed?: unknown })?.committed === true
        ? "committed"
        : observed.outcome,
      quarantinePreserved: observed.quarantinePreserved
        || Boolean((error as { quarantinePreserved?: unknown })?.quarantinePreserved),
      successorPreserved: observed.successorPreserved
        || Boolean((error as { successorPreserved?: unknown })?.successorPreserved),
      recoveryPaths: [...new Set([
        ...observed.recoveryPaths,
        ...(((error as { recoveryPaths?: unknown })?.recoveryPaths as string[] | undefined) || []),
      ])],
    } satisfies ReviewCleanupProof;
  }
}

function mergedTruth(proof: ReviewMergeProof | null): boolean | null {
  if (!proof) return null;
  if (proof.outcome === "committed") return true;
  if (proof.outcome === "not_committed") return false;
  return null;
}

async function persistDecisionJournal(
  cpbRoot: string,
  session: ReviewSessionRecord,
  journal: ReviewDecisionJournal,
  options: ReviewStorageOptions,
  patch: LooseRecord = {},
) {
  return updateSession(cpbRoot, session.sessionId, { ...patch, reviewDecision: journal }, {
    ...options,
    skipTransitionCheck: true,
  });
}

function finalDecisionResult(session: ReviewSessionRecord) {
  const journal = session.reviewDecision;
  if (!journal?.final) return null;
  const ok = journal.final.status === "completed" || journal.final.status === "expired";
  const recoveryPath = journal.cleanupProof?.quarantinePreserved
    ? journal.intent.quarantinePath
    : undefined;
  return {
    ok,
    sessionId: session.sessionId,
    merged: journal.final.merged,
    mergeFailed: journal.final.status === "merge_failed",
    cleanupFailed: Boolean(journal.cleanupProof?.errorCode),
    ...(journal.final.errorCode && { code: journal.final.errorCode }),
    ...(journal.final.error && { error: journal.final.error }),
    ...(recoveryPath && {
      recoveryPath,
      metadataCleanupDeferred: true,
      branchCleanupDeferred: true,
    }),
    status: journal.final.status,
    session,
    project: session.project,
  };
}

function mergeProofReadyForCleanup(proof: ReviewMergeProof, intent: ReviewDecisionIntent) {
  return proof.outcome === "committed"
    && proof.errorCode === null
    && proof.mergeCommit !== null
    && proof.parents.length === 2
    && proof.parents[0] === intent.sourceBaseCommit
    && proof.parents[1] === intent.fixedWorktreeHead
    && proof.after.captureErrors.length === 0
    && proof.after.symbolicRef === intent.sourceBaseBranch
    && proof.after.head === proof.mergeCommit
    && proof.after.baseRefHead === proof.mergeCommit
    && proof.after.mergeHead === null
    && proof.after.statusPorcelainV2 === "";
}

function cleanupSessionPatch(proof: ReviewCleanupProof, intent: ReviewDecisionIntent) {
  return {
    worktreeIsolationCommitted: proof.committed,
    worktreeIsolationDurabilityConfirmed: proof.durabilityConfirmed,
    worktreeQuarantinePreserved: proof.quarantinePreserved,
    worktreeSuccessorPreserved: proof.successorPreserved,
    worktreeRecoveryPaths: proof.recoveryPaths,
    worktreeCleanupCode: proof.errorCode,
    worktreeCleanupError: proof.error,
    ...(proof.quarantinePreserved && {
      worktreeCleanup: "quarantined_metadata_retained",
      worktreeMetadataCleanup: "deferred",
      worktreeBranchCleanup: "deferred",
      worktreeRecoveryPath: intent.quarantinePath,
    }),
  };
}

/**
 * Accept a review session — merge worktree branch into main.
 */
export async function acceptSession(cpbRoot: string, sessionId: string, options: ReviewStorageOptions = {}) {
  return withReviewWorktreeDecisionLock(cpbRoot, sessionId, options, async () => {
    let session = await getSession(cpbRoot, sessionId, options);
    if (!session) return { ok: false, error: "session_not_found" };
    const alreadyFinal = finalDecisionResult(session);
    if (alreadyFinal) return alreadyFinal;
    if (!session.reviewDecision && session.status !== "user_review" && session.status !== "dispatched") {
      return { ok: false, error: "invalid_state", status: session.status };
    }
    try {
      session = await prepareReviewDecisionIntent(cpbRoot, session, "accept", options);
    } catch (error) {
      if (isSimulatedReviewCrash(error)) throw error;
      return {
        ok: false,
        sessionId,
        merged: null,
        mergeFailed: true,
        cleanupFailed: false,
        code: errorCode(error) || "REVIEW_DECISION_AUTHORITY_FAILED",
        error: errorMessage(error),
        status: session.status,
        session,
        project: session.project,
      };
    }
    let journal = requirePreparedReviewDecision(session, "accept");

    let mergeProof = journal.mergeProof;
    if (!mergeProof) {
      try {
        const authority = await loadReviewDecisionAuthority(cpbRoot, session, "accept", options);
        mergeProof = await withBoundReviewWorktree(cpbRoot, session, "accept", options, async (binding) => {
          const proof = await createOrRecoverMergeProof(authority, journal);
          try {
            await assertWorktreeRegistration(binding);
            return proof;
          } catch (error) {
            return {
              ...proof,
              errorCode: errorCode(error) || "REVIEW_WORKTREE_POST_MERGE_AUTHORITY_FAILED",
              error: errorMessage(error),
            };
          }
        });
      } catch (error) {
        if (isSimulatedReviewCrash(error)) throw error;
        return {
          ok: false,
          sessionId,
          merged: null,
          mergeFailed: true,
          cleanupFailed: false,
          code: errorCode(error) || "REVIEW_DECISION_AUTHORITY_FAILED",
          error: errorMessage(error),
          status: session.status,
          session,
          project: session.project,
        };
      }
      journal = { ...journal, phase: "merge_proof", mergeProof };
      const mergeTruth = mergedTruth(mergeProof);
      session = await persistDecisionJournal(cpbRoot, session, journal, options, {
        userVerdict: "accepted",
        mergePostState: mergeProof.after,
        mergeSourceMutation: mergeProof.sourceMutation,
        ...(mergeTruth !== null && { merged: mergeTruth }),
        ...(mergeProof.errorCode && {
          mergeErrorCode: mergeProof.errorCode,
          mergeError: mergeProof.error,
        }),
      });
    }

    if (!mergeProofReadyForCleanup(mergeProof, journal.intent)) {
      const mergeTruth = mergedTruth(mergeProof);
      const final = {
        status: "merge_failed" as const,
        merged: mergeTruth,
        completedAt: new Date().toISOString(),
        errorCode: mergeProof.errorCode || "REVIEW_MERGE_STATE_UNCONFIRMED",
        error: mergeProof.error || "merge proof is not safe for worktree isolation",
      };
      journal = { ...journal, phase: "final", final };
      session = await persistDecisionJournal(cpbRoot, session, journal, options, {
        status: "merge_failed",
        userVerdict: "accepted",
        mergePostState: mergeProof.after,
        mergeSourceMutation: mergeProof.sourceMutation,
        ...(mergeTruth !== null && { merged: mergeTruth }),
        mergeErrorCode: final.errorCode,
        mergeError: final.error,
      });
      return finalDecisionResult(session);
    }

    const cleanupProof = await createOrRecoverCleanupProof(cpbRoot, session, "accept", options);
    journal = { ...journal, phase: "cleanup_proof", cleanupProof };
    const cleanupPatch = cleanupSessionPatch(cleanupProof, journal.intent);
    session = await persistDecisionJournal(cpbRoot, session, journal, options, {
      status: cleanupProof.committed && cleanupProof.durabilityConfirmed && !cleanupProof.errorCode
        ? session.status
        : "merge_failed",
      userVerdict: "accepted",
      merged: true,
      ...cleanupPatch,
    });

    if (!cleanupProof.committed || !cleanupProof.durabilityConfirmed || cleanupProof.errorCode) {
      return {
        ok: false,
        sessionId,
        merged: true,
        mergeFailed: true,
        cleanupFailed: true,
        code: cleanupProof.errorCode || "REVIEW_WORKTREE_CLEANUP_UNCONFIRMED",
        cleanupError: cleanupProof.error || "review worktree cleanup is not durably proven",
        isolationCommitted: cleanupProof.committed,
        durabilityConfirmed: cleanupProof.durabilityConfirmed,
        quarantinePreserved: cleanupProof.quarantinePreserved,
        successorPreserved: cleanupProof.successorPreserved,
        recoveryPaths: cleanupProof.recoveryPaths,
        ...(cleanupProof.quarantinePreserved && {
          recoveryPath: journal.intent.quarantinePath,
          metadataCleanupDeferred: true,
          branchCleanupDeferred: true,
        }),
        status: "merge_failed",
        session,
        project: session.project,
      };
    }

    const final = {
      status: "completed" as const,
      merged: true,
      completedAt: new Date().toISOString(),
      errorCode: null,
      error: null,
    };
    journal = { ...journal, phase: "final", final };
    session = await persistDecisionJournal(cpbRoot, session, journal, options, {
      status: "completed",
      userVerdict: "accepted",
      merged: true,
      ...cleanupPatch,
    });
    return finalDecisionResult(session);
  });
}

/**
 * Reject a review session — discard worktree.
 */
export async function rejectSession(cpbRoot: string, sessionId: string, options: ReviewStorageOptions = {}) {
  return withReviewWorktreeDecisionLock(cpbRoot, sessionId, options, async () => {
    let session = await getSession(cpbRoot, sessionId, options);
    if (!session) return { ok: false, error: "session_not_found" };
    const alreadyFinal = finalDecisionResult(session);
    if (alreadyFinal) return alreadyFinal;
    if (!session.reviewDecision && session.status !== "user_review") {
      return { ok: false, error: "invalid_state", status: session.status };
    }
    try {
      session = await prepareReviewDecisionIntent(cpbRoot, session, "reject", options);
    } catch (error) {
      if (isSimulatedReviewCrash(error)) throw error;
      return {
        ok: false,
        error: "worktree_cleanup_failed",
        code: errorCode(error) || "REVIEW_DECISION_AUTHORITY_FAILED",
        cleanupError: errorMessage(error),
        isolationCommitted: Boolean((error as { committed?: unknown })?.committed),
        quarantinePreserved: Boolean((error as { quarantinePreserved?: unknown })?.quarantinePreserved),
        successorPreserved: Boolean((error as { successorPreserved?: unknown })?.successorPreserved),
        recoveryPaths: ((error as { recoveryPaths?: unknown })?.recoveryPaths as string[] | undefined) || [],
        status: session.status,
        session,
        project: session.project,
      };
    }
    let journal = requirePreparedReviewDecision(session, "reject");
    let cleanupProof: ReviewCleanupProof;
    try {
      cleanupProof = await createOrRecoverCleanupProof(cpbRoot, session, "reject", options);
    } catch (error) {
      if (isSimulatedReviewCrash(error)) throw error;
      return {
        ok: false,
        error: "worktree_cleanup_failed",
        code: errorCode(error) || "REVIEW_DECISION_AUTHORITY_FAILED",
        cleanupError: errorMessage(error),
        isolationCommitted: Boolean((error as { committed?: unknown })?.committed),
        quarantinePreserved: Boolean((error as { quarantinePreserved?: unknown })?.quarantinePreserved),
        successorPreserved: Boolean((error as { successorPreserved?: unknown })?.successorPreserved),
        recoveryPaths: ((error as { recoveryPaths?: unknown })?.recoveryPaths as string[] | undefined) || [],
        status: session.status,
        session,
        project: session.project,
      };
    }
    journal = { ...journal, phase: "cleanup_proof", cleanupProof };
    const cleanupPatch = cleanupSessionPatch(cleanupProof, journal.intent);
    session = await persistDecisionJournal(cpbRoot, session, journal, options, {
      userVerdict: "rejected",
      ...cleanupPatch,
    });

    if (!cleanupProof.committed || !cleanupProof.durabilityConfirmed || cleanupProof.errorCode) {
      return {
        ok: false,
        error: "worktree_cleanup_failed",
        code: cleanupProof.errorCode || "REVIEW_WORKTREE_CLEANUP_UNCONFIRMED",
        cleanupError: cleanupProof.error || "review worktree cleanup is not durably proven",
        isolationCommitted: cleanupProof.committed,
        durabilityConfirmed: cleanupProof.durabilityConfirmed,
        quarantinePreserved: cleanupProof.quarantinePreserved,
        successorPreserved: cleanupProof.successorPreserved,
        recoveryPaths: cleanupProof.recoveryPaths,
        ...(cleanupProof.quarantinePreserved && {
          recoveryPath: journal.intent.quarantinePath,
          metadataCleanupDeferred: true,
          branchCleanupDeferred: true,
        }),
        status: session.status,
        session,
        project: session.project,
      };
    }

    const final = {
      status: "expired" as const,
      merged: null,
      completedAt: new Date().toISOString(),
      errorCode: null,
      error: null,
    };
    journal = { ...journal, phase: "final", final };
    session = await persistDecisionJournal(cpbRoot, session, journal, options, {
      status: "expired",
      userVerdict: "rejected",
      ...cleanupPatch,
    });
    return finalDecisionResult(session);
  });
}

// ─── review-dispatch-runner.ts ────────────────────────────────────
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { mkdir as mkdirAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import readline from "node:readline";
import { createSession, startSessionResearch, noteReviewAcpCall, assertReviewBudget, updateSessionIfNotCancelled } from "./review-session.js";
import { buildChildEnv as buildChildEnvForRunner } from "../../../core/policy/child-env.js";

const CPB_ROOT = path.resolve(".");
const PROTOCOL_VERSION = 1;
const ACP_STUCK_MS = parseInt(process.env.ACP_STUCK_MS || "300000", 10);
const ACP_TERM_GRACE_MS = parseInt(process.env.CPB_REVIEW_ACP_TERM_GRACE_MS || "1000", 10);
const ACP_KILL_GRACE_MS = parseInt(process.env.CPB_REVIEW_ACP_KILL_GRACE_MS || "1000", 10);
const activeReviewRuns = new Map<string, ActiveReviewRun>();

// ACP adapter lookup table — mirrors acp-client.js
const ACP_ADAPTERS: Record<string, { command: string; args: string[]; npxPkg: string | null }> = {
  codex:    { command: "codex-acp",         args: [],            npxPkg: "@zed-industries/codex-acp" },
  claude:   { command: "claude-agent-acp",  args: [],            npxPkg: "@agentclientprotocol/claude-agent-acp" },
  reasonix: { command: "reasonix",          args: ["acp"],       npxPkg: null },
};

function commandExists(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", cmd]).status === 0;
}

function resolveAgentCommand(agent: string, env: NodeJS.ProcessEnv = process.env): AgentCommand {
  const upper = agent.toUpperCase();
  const envCmd = env[`CPB_ACP_${upper}_COMMAND`];
  if (envCmd) {
    const raw = env[`CPB_ACP_${upper}_ARGS`];
    let args: string[] = [];
    if (raw) {
      try { args = JSON.parse(raw); } catch { args = raw.split(/\s+/).filter(Boolean); }
    }
    return { command: envCmd, args };
  }
  const entry = ACP_ADAPTERS[agent];
  if (!entry) throw new Error(`Unknown agent: '${agent}'. Set CPB_ACP_${upper}_COMMAND.`);
  if (commandExists(entry.command)) return { command: entry.command, args: [...entry.args] };
  if (entry.npxPkg) return { command: "npx", args: ["-y", entry.npxPkg] };
  return { command: entry.command, args: [...entry.args] };
}

function reviewRunKey(cpbRoot: string, sessionId: string) {
  return `${path.resolve(cpbRoot)}:${sessionId}`;
}

function abortErrorForSignal(signal?: AbortSignal, fallback = "review cancelled") {
  const reason = signal?.reason;
  const message = reason instanceof Error ? reason.message : (typeof reason === "string" && reason) ? reason : fallback;
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown) {
  return err instanceof Error && err.name === "AbortError";
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortErrorForSignal(signal);
}

function addAbortHandler(signal: AbortSignal | undefined, onAbort: () => void) {
  if (!signal) return () => {};
  let handled = false;
  const handler = () => {
    if (handled) return;
    handled = true;
    onAbort();
  };
  signal.addEventListener("abort", handler, { once: true });
  // Close the check/listener registration race: AbortSignal does not replay a
  // prior abort event to listeners attached after it fired.
  if (signal.aborted) handler();
  return () => signal.removeEventListener("abort", handler);
}

function raceWithAbort<T>(work: Promise<T>, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (!signal) return work;
  let cleanup = () => {};
  const aborted = new Promise<T>((_, reject) => {
    cleanup = addAbortHandler(signal, () => reject(abortErrorForSignal(signal)));
  });
  return Promise.race([work, aborted]).finally(cleanup);
}

async function terminateReviewAcpChild(
  child: ChildProcess,
  identity: ProcessIdentity | null,
  termGraceMs: number,
  forceVerifyMs: number,
  system?: ProcessTreeSystem,
) {
  try { child.stdin?.end(); } catch {}
  if (!child.pid || !identity) {
    throw reviewChildLifecycleError(
      child.pid
        ? `review ACP child ${child.pid} has no verified process identity; refusing to signal`
        : "review ACP child did not expose a pid; refusing to signal",
      "CHILD_PROCESS_IDENTITY_UNAVAILABLE",
    );
  }
  await killTree(child.pid, termGraceMs, {
    requireDescendantScan: true,
    forceVerifyMs,
    expectedRootIdentity: identity,
    ...(system ? { system } : {}),
  });
}

async function waitForChildTeardown(
  child: ChildProcess,
  identity: ProcessIdentity | null,
  closed: Promise<ReviewChildCloseRecord> | null,
  system?: ProcessTreeSystem,
) {
  const termGraceMs = reviewLifecycleMs("CPB_REVIEW_ACP_TERM_GRACE_MS", ACP_TERM_GRACE_MS);
  const forceVerifyMs = reviewLifecycleMs("CPB_REVIEW_ACP_KILL_GRACE_MS", ACP_KILL_GRACE_MS);
  const closeGraceMs = reviewLifecycleMs("CPB_REVIEW_ACP_CLOSE_GRACE_MS", forceVerifyMs);
  const cleanupErrors: unknown[] = [];
  let teardownError: unknown = null;
  let closeRecord: ReviewChildCloseRecord | null = null;
  try {
    await terminateReviewAcpChild(child, identity, termGraceMs, forceVerifyMs, system);
  } catch (error) {
    teardownError = error;
  }
  if (closed) {
    try {
      closeRecord = await waitForReviewChildClose(closed, closeGraceMs, "review ACP child");
      if (closeRecord.error) cleanupErrors.push(closeRecord.error);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (teardownError) {
    cleanupErrors.push(teardownError);
  }
  if (cleanupErrors.length === 1) {
    const [cleanupError] = cleanupErrors;
    throw cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "review ACP child cleanup failed");
  }
}

class PersistentAcp {
  agent: string;
  nextId: number;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>;
  child: AcpChildProcess | null;
  childIdentity: ProcessIdentity | null;
  childClose: Promise<ReviewChildCloseRecord> | null;
  processTreeSystem?: ProcessTreeSystem;
  initialized: boolean;
  closed: boolean;
  closePromise: Promise<void> | null;
  lastActivity: number;
  watchdog: ReturnType<typeof setInterval> | null;
  sessionId: string | null;

  constructor(agent: string, processTreeSystem?: ProcessTreeSystem) {
    this.agent = agent;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
    this.childIdentity = null;
    this.childClose = null;
    this.processTreeSystem = processTreeSystem;
    this.initialized = false;
    this.closed = false;
    this.closePromise = null;
    this.lastActivity = Date.now();
    this.watchdog = null;
    this.sessionId = null;
  }

  async start(signal?: AbortSignal) {
    throwIfAborted(signal);
    const env = buildChildEnvForRunner(process.env, {}, { agent: this.agent });
    const { command, args } = resolveAgentCommand(this.agent, env);
    if (command === "npx" && !env.npm_config_cache) {
      const cache = path.join(tmpdir(), `cpb-npm-cache-${this.agent}-${randomUUID()}`);
      await mkdirAsync(cache, { recursive: true });
      env.npm_config_cache = cache;
    }

    this.child = spawnChild(command, args, {
      cwd: CPB_ROOT,
      env: buildChildEnvForRunner(env, { CPB_ROOT }, { agent: this.agent }),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }) as AcpChildProcess;
    this.closePromise = null;
    this.childClose = monitorReviewChildClose(this.child);
    if (!this.child.pid) {
      const identityError = reviewChildLifecycleError(
        `${this.agent} ACP child did not expose a pid`,
        "CHILD_PROCESS_IDENTITY_UNAVAILABLE",
      );
      await this.close().catch((cleanupError) => {
        throw aggregateReviewChildFailure(`${this.agent} ACP startup`, identityError, [cleanupError]);
      });
      throw identityError;
    }
    try {
      this.childIdentity = captureProcessIdentity(this.child.pid, {
        strict: true,
        ...(this.processTreeSystem ? { system: this.processTreeSystem } : {}),
      });
      if (!this.childIdentity) {
        throw reviewChildLifecycleError(
          `${this.agent} ACP child ${this.child.pid} exited before its process identity was captured`,
          "CHILD_PROCESS_IDENTITY_UNAVAILABLE",
        );
      }
    } catch (error) {
      const identityError = error instanceof Error
        ? error
        : reviewChildLifecycleError(`${this.agent} ACP child process identity could not be captured`, "CHILD_PROCESS_IDENTITY_UNAVAILABLE");
      await this.close().catch((cleanupError) => {
        throw aggregateReviewChildFailure(`${this.agent} ACP startup`, identityError, [cleanupError]);
      });
      throw identityError;
    }

    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      this.lastActivity = Date.now();
      this.handleLine(line);
    });

    this.child.stderr.on("data", (chunk: Buffer) => {
      this.lastActivity = Date.now();
      process.stderr.write(`[${this.agent}] ${chunk}`);
    });

    this.child.on("exit", () => {
      this.closed = true;
      this.clearWatchdog();
      for (const { reject } of this.pending.values()) {
        reject(new Error(`${this.agent} process exited`));
      }
      this.pending.clear();
    });

    this.child.on("error", (err: Error) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    const init = await raceWithAbort(this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "cpb-review", title: "CodePatchbay Review", version: "0.1.0" },
    }), signal).catch(async (err) => {
      await this.close();
      throw err;
    });

    // retain: dynamic ACP JSON-RPC response from child process — shape not statically guaranteed
    const initRec = init as LooseRecord;
    if (initRec.protocolVersion !== PROTOCOL_VERSION) {
      await this.close();
      throw new Error(`unsupported ACP protocol version: ${String(initRec.protocolVersion)}`);
    }
    this.initialized = true;

    this.startWatchdog();
    return this;
  }

  async sendPrompt(prompt: string, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    if (this.closed) throw new Error(`${this.agent} connection closed`);
    this.lastActivity = Date.now();

    await this.#ensureSession(signal);

    let response = "";
    const startedAt = Date.now();
    let lastTextAt = Date.now();
    const STUCK_MS = parseInt(process.env.ACP_PROMPT_STUCK_MS || "300000", 10);
    const MAX_MS = parseInt(process.env.ACP_PROMPT_MAX_MS || "600000", 10);

    const collectUpdate = (params: SessionUpdateParams) => {
      const update = params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update?.content?.type === "text") {
        response += update.content.text;
        lastTextAt = Date.now();
      }
    };

    let stuckTimer: ReturnType<typeof setInterval> | null = null;
    const stuckGuard = new Promise((_, reject) => {
      stuckTimer = setInterval(() => {
        const noText = Date.now() - lastTextAt > STUCK_MS;
        const tooLong = Date.now() - startedAt > MAX_MS;
        if (noText || tooLong) {
          clearInterval(stuckTimer);
          const reason = tooLong ? `exceeded max ${MAX_MS}ms` : `no text output for ${STUCK_MS}ms`;
          reject(new Error(`${this.agent} prompt stuck: ${reason}`));
        }
      }, 15000);
    });
    let abortCleanup = () => {};
    const abortGuard = new Promise((_, reject) => {
      abortCleanup = addAbortHandler(signal, () => {
        reject(abortErrorForSignal(signal));
      });
    });

    const origHandle = this.handleClientRequest;
    this.handleClientRequest = async (msg: JsonRpcMessage) => {
      if (msg.method === "session/update") {
        collectUpdate(msg.params as SessionUpdateParams);
        if (Object.hasOwn(msg, "id")) this.respond(msg.id, null);
      } else {
        origHandle.call(this, msg);
      }
    };

    try {
      await Promise.race([
        this.request("session/prompt", {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text: prompt }],
        }),
        stuckGuard,
        abortGuard,
      ]);
    } catch (err) {
      console.error(`[${this.agent}] sendPrompt error: ${err.message}`);
      await this.#closeSession();
      throw err;
    } finally {
      clearInterval(stuckTimer);
      abortCleanup();
      this.handleClientRequest = origHandle;
    }

    return response.trim();
  }

  async #ensureSession(signal?: AbortSignal) {
    if (this.sessionId) return;
    const session = await raceWithAbort(this.request("session/new", { cwd: CPB_ROOT, mcpServers: [] }), signal);
    // retain: dynamic ACP JSON-RPC response from child process — shape not statically guaranteed
    this.sessionId = (session as { sessionId?: string }).sessionId || null;
  }

  async #closeSession() {
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = null;
    try {
      this.write({ jsonrpc: "2.0", method: "session/close", params: { sessionId: sid } });
    } catch {}
  }

  async resetSession() {
    await this.#closeSession();
  }

  request(method: string, params: LooseRecord): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`${this.agent} connection closed`));
    const id = this.nextId++;
    this.lastActivity = Date.now();
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  respond(id: number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  write(msg: JsonRpcMessage): void {
    if (this.child?.stdin.destroyed) throw new Error("stdin closed");
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try { msg = JSON.parse(line); } catch { return; }

    if (Object.hasOwn(msg, "id") && (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || `ACP error ${msg.error.code}`));
      else p.resolve(msg.result);
      return;
    }

    if (msg.method) this.handleClientRequest(msg);
  }

  handleClientRequest(msg: JsonRpcMessage): void {
    if (Object.hasOwn(msg, "id")) this.respond(msg.id, null);
  }

  startWatchdog() {
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastActivity > ACP_STUCK_MS) {
        void this.close();
        for (const { reject } of this.pending.values()) {
          reject(new Error(`${this.agent} heartbeat timeout: no activity for ${ACP_STUCK_MS}ms`));
        }
        this.pending.clear();
      }
    }, 10000);
  }

  clearWatchdog() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  async restart(signal?: AbortSignal) {
    await this.close();
    throwIfAborted(signal);
    this.closed = false;
    this.pending.clear();
    this.nextId = 1;
    this.sessionId = null;
    return this.start(signal);
  }

  async close() {
    this.clearWatchdog();
    if (this.closePromise) return this.closePromise;
    const child = this.child;
    const childIdentity = this.childIdentity;
    const childClose = this.childClose;
    if (this.sessionId && child && !this.closed) {
      try { await this.#closeSession(); } catch {}
    }
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(new Error(`${this.agent} connection closed`));
    }
    this.pending.clear();
    this.closePromise = child
      ? waitForChildTeardown(child, childIdentity, childClose, this.processTreeSystem)
      : Promise.resolve();
    try {
      await this.closePromise;
    } finally {
      if (this.child === child) {
        this.child = null;
        this.childIdentity = null;
        this.childClose = null;
      }
    }
  }
}

// --- Prompt builders ---

function researchPrompt(intent: string, project: string): string {
  return `You are CodePatchbay Research Agent. Analyze this task intent for project "${project}":

**Task**: ${intent}

Provide:
1. Feasibility assessment (technical complexity, estimated effort)
2. Key risks and dependencies
3. Suggested approach (high-level)
4. Questions or ambiguities that need clarification

Be concise and structured.`;
}

function planPrompt(intent: string, codexResearch: string, claudeResearch: string): string {
  return `You are CodePatchbay Planner. Based on the research below, create an implementation plan.

**Task**: ${intent}

**Codex Research**:
${codexResearch || "N/A"}

**Claude Research**:
${claudeResearch || "N/A"}

Create a structured plan with:
1. Clear phases with deliverables
2. File-by-file changes
3. Risk mitigation strategies
4. Acceptance criteria

Output the plan as markdown.`;
}

function reviewPrompt(plan: string, reviewer: string): string {
  return `You are CodePatchbay ${reviewer === "codex" ? "Architecture" : "Security & Quality"} Reviewer.
Review this plan critically. For each issue found, use severity tags [P0] [P1] [P2] [P3]:

- [P0] Critical: Will cause system failure or data loss
- [P1] High: Major functional defect or security vulnerability
- [P2] Medium: Performance issue, poor design, or missing edge case
- [P3] Low: Style, naming, or minor improvement

If the plan has no P2+ issues, respond with: "REVIEW: PASS"

**Plan to review**:
${plan}`;
}

function followUpReviewPrompt(reviewer: string, previousIssues: ReviewIssue[], revisedPlan: string): string {
  const issueSummary = previousIssues
    .filter((i: ReviewIssue) => (i.severity || 0) >= 2)
    .map((i: ReviewIssue) => `[P${i.severity}] ${i.description}`)
    .join("\n") || "None";

  return `You are CodePatchbay ${reviewer === "codex" ? "Architecture" : "Security & Quality"} Reviewer (follow-up).
This is a revised plan addressing previous review issues.

**Previous issues**:
${issueSummary}

**Revised plan**:
${revisedPlan}

Review ONLY whether the previous issues were adequately addressed. For new issues use [P0]-[P3] tags. If all previous P2+ issues are resolved and no new P2+ issues exist, respond with: "REVIEW: PASS"`;
}

function revisePrompt(plan: string, codexIssues: ReviewIssue[], claudeIssues: ReviewIssue[]): string {
  const allIssues = [...codexIssues, ...claudeIssues]
    .filter((i: ReviewIssue) => (i.severity || 0) >= 2)
    .map((i: ReviewIssue) => `[P${i.severity}] ${i.description}`)
    .join("\n");

  return `You are CodePatchbay Plan Reviser. Revise this plan to address the issues below.

**Issues found by reviewers**:
${allIssues}

**Original plan**:
${plan}

Provide the revised plan as markdown, addressing each issue.`;
}

// --- Main review cpb ---

const MAX_RETRIES = parseInt(process.env.ACP_MAX_RETRIES || "2", 10);
const MAX_REVIEW_ROUNDS = parseInt(process.env.CPB_REVIEW_MAX_ROUNDS || "5", 10);

async function sendWithRetry(acp: PersistentAcp, prompt: string, agent: string, retries: number = MAX_RETRIES, signal?: AbortSignal): Promise<string> {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    throwIfAborted(signal);
    try {
      return await acp.sendPrompt(prompt, signal);
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw abortErrorForSignal(signal);
      console.error(`[review] ${agent} attempt ${attempt}/${retries + 1} failed: ${err.message}`);
      if (attempt <= retries) {
        console.log(`[review] restarting ${agent} ACP connection`);
        await acp.restart(signal);
      } else {
        throw err;
      }
    }
  }
}

async function updateSessionUnlessCancelled(cpbRoot: string, sessionId: string, patch: LooseRecord, options: LooseRecord = {}) {
  return updateSessionIfNotCancelled(cpbRoot, sessionId, patch, options);
}

function combineReviewFailures(failures: unknown[]) {
  const errors = failures.filter(Boolean);
  if (errors.length === 0) return null;
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, `review failed with ${errors.length} cleanup/persistence errors`);
}

export async function runReview(cpbRoot: string, sessionId: string, options: ReviewRunOptions = {}): Promise<void> {
  const session = await getSession(cpbRoot, sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status === "cancelled") return;

  const controller = new AbortController();
  const key = reviewRunKey(cpbRoot, sessionId);
  if (activeReviewRuns.has(key)) {
    throw new Error(`review already running: ${sessionId}`);
  }
  let teardownResolve: () => void = () => {};
  let teardownReject: (error: unknown) => void = () => {};
  const teardown = new Promise<void>((resolve, reject) => {
    teardownResolve = resolve;
    teardownReject = reject;
  });
  void teardown.catch(() => undefined);
  const externalAbortCleanup = addAbortHandler(options.signal, () => {
    controller.abort(options.signal?.reason || "review aborted");
  });
  if (options.signal?.aborted) controller.abort(options.signal.reason || "review aborted");
  activeReviewRuns.set(key, {
    abort: (reason: string) => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    teardown,
  });

  let codex: PersistentAcp | null = null;
  let claude: PersistentAcp | null = null;
  let terminalPersistError: unknown = null;

  try {
    const currentSession = await getSession(cpbRoot, sessionId);
    if (currentSession?.status === "cancelled") {
      controller.abort(currentSession.detail || "review cancelled before launch");
    }
    throwIfAborted(controller.signal);
    codex = new PersistentAcp("codex", options.processTreeSystem);
    claude = new PersistentAcp("claude", options.processTreeSystem);
    await Promise.all([
      codex.start(controller.signal),
      claude.start(controller.signal),
    ]);
    throwIfAborted(controller.signal);

    // Phase 1: Research. HTTP routes may already have moved the session into
    // researching to enforce idempotency before spawning this runner.
    const initialSession = await getSession(cpbRoot, sessionId);
    if (initialSession?.status === "idle") {
      await startSessionResearch(cpbRoot, sessionId, `dispatch-${sessionId}`);
    }
    console.log(`[review] ${sessionId} phase 1: researching`);

    let currentBudget = await getSession(cpbRoot, sessionId);
    assertReviewBudget(currentBudget);
    throwIfAborted(controller.signal);

    const codexResearchPrompt = researchPrompt(session.intent, session.project);
    const claudeResearchPrompt = researchPrompt(session.intent, session.project);
    const [codexRes, claudeRes] = await Promise.allSettled([
      sendWithRetry(codex, codexResearchPrompt, "codex", MAX_RETRIES, controller.signal),
      sendWithRetry(claude, claudeResearchPrompt, "claude", MAX_RETRIES, controller.signal),
    ]);
    throwIfAborted(controller.signal);
    await noteReviewAcpCall(cpbRoot, sessionId, { agent: "codex", promptBytes: codexResearchPrompt.length });
    await noteReviewAcpCall(cpbRoot, sessionId, { agent: "claude", promptBytes: claudeResearchPrompt.length });

    const codexResearch = codexRes.status === "fulfilled" ? codexRes.value : "";
    const claudeResearch = claudeRes.status === "fulfilled" ? claudeRes.value : "";
    if (!codexResearch && !claudeResearch) throw new Error("both research agents failed");
    await updateSession(cpbRoot, sessionId, {
      research: { codex: codexResearch, claude: claudeResearch },
    });

    // Phase 2: Plan
    throwIfAborted(controller.signal);
    await updateSession(cpbRoot, sessionId, { status: "planning" });
    console.log(`[review] ${sessionId} phase 2: planning`);
    currentBudget = await getSession(cpbRoot, sessionId);
    assertReviewBudget(currentBudget);
    const planPromptText = planPrompt(session.intent, codexResearch, claudeResearch);
    const plan = await sendWithRetry(codex, planPromptText, "codex", MAX_RETRIES, controller.signal);
    throwIfAborted(controller.signal);
    await noteReviewAcpCall(cpbRoot, sessionId, { agent: "codex", promptBytes: planPromptText.length });
    await updateSession(cpbRoot, sessionId, { plan });

    // Phase 3: Review Loop
    let currentPlan = plan;
    let prevCodexIssues: LooseRecord[] = [];
    let prevClaudeIssues: LooseRecord[] = [];
    for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
      throwIfAborted(controller.signal);
      await updateSession(cpbRoot, sessionId, { status: "reviewing", round });
      console.log(`[review] ${sessionId} round ${round}: reviewing`);

      // Budget check before review round
      currentBudget = await getSession(cpbRoot, sessionId);
      try {
        assertReviewBudget(currentBudget);
      } catch (budgetErr) {
        await updateSessionUnlessCancelled(cpbRoot, sessionId, { status: "expired", detail: budgetErr.message });
        console.log(`[review] ${sessionId} expired: ${budgetErr.message}`);
        return;
      }

      // Reset sessions between rounds for independent reviews
      await codex.resetSession().catch((): null => null);
      await claude.resetSession().catch((): null => null);

      const codexPrompt = round === 1
        ? reviewPrompt(currentPlan, "codex")
        : followUpReviewPrompt("codex", prevCodexIssues, currentPlan);
      const claudePrompt = round === 1
        ? reviewPrompt(currentPlan, "claude")
        : followUpReviewPrompt("claude", prevClaudeIssues, currentPlan);

      const results = await Promise.allSettled([
        sendWithRetry(codex, codexPrompt, "codex", MAX_RETRIES, controller.signal),
        sendWithRetry(claude, claudePrompt, "claude", MAX_RETRIES, controller.signal),
      ]);
      throwIfAborted(controller.signal);
      await noteReviewAcpCall(cpbRoot, sessionId, { agent: "codex", promptBytes: codexPrompt.length });
      await noteReviewAcpCall(cpbRoot, sessionId, { agent: "claude", promptBytes: claudePrompt.length });

      const codexReview = results[0].status === "fulfilled" ? results[0].value : "";
      const claudeReview = results[1].status === "fulfilled" ? results[1].value : "";
      if (results[0].status === "rejected") console.error(`[review] codex review failed: ${results[0].reason?.message}`);
      if (results[1].status === "rejected") console.error(`[review] claude review failed: ${results[1].reason?.message}`);
      if (!codexReview && !claudeReview) throw new Error("both reviewers failed");

      const codexIssues = parseIssues(codexReview);
      const claudeIssues = parseIssues(claudeReview);
      prevCodexIssues = codexIssues;
      prevClaudeIssues = claudeIssues;

      const reviews = (await getSession(cpbRoot, sessionId)).reviews;
      await updateSession(cpbRoot, sessionId, {
        reviews: [...reviews, { round, codex: codexReview, claude: claudeReview, codexIssues, claudeIssues }],
      });

      const hasP2 = [...codexIssues, ...claudeIssues].some((i) => i.severity >= 2);
      console.log(`[review] ${sessionId} round ${round}: codex=${codexIssues.length} claude=${claudeIssues.length} hasP2=${hasP2}`);
      if (!hasP2) {
        await updateSessionUnlessCancelled(cpbRoot, sessionId, { status: "user_review" });
        console.log(`[review] ${sessionId} passed at round ${round}`);
        return;
      }

      if (round < MAX_REVIEW_ROUNDS) {
        await updateSession(cpbRoot, sessionId, { status: "revising" });
        console.log(`[review] ${sessionId} revising for round ${round + 1}`);

        // Budget check before revise
        currentBudget = await getSession(cpbRoot, sessionId);
        try {
          assertReviewBudget(currentBudget);
        } catch (budgetErr) {
          await updateSessionUnlessCancelled(cpbRoot, sessionId, { status: "expired", detail: budgetErr.message });
          console.log(`[review] ${sessionId} expired: ${budgetErr.message}`);
          return;
        }

        const revisePromptText = revisePrompt(currentPlan, codexIssues, claudeIssues);
        const revised = await sendWithRetry(codex, revisePromptText, "codex", MAX_RETRIES, controller.signal);
        throwIfAborted(controller.signal);
        await noteReviewAcpCall(cpbRoot, sessionId, { agent: "codex", promptBytes: revisePromptText.length });
        currentPlan = revised;
        await updateSession(cpbRoot, sessionId, { plan: revised });
      }
    }

    await updateSessionUnlessCancelled(cpbRoot, sessionId, { status: "expired" });
    console.log(`[review] ${sessionId} expired after ${MAX_REVIEW_ROUNDS} rounds`);
  } catch (err) {
    if (controller.signal.aborted || isAbortError(err)) {
      console.error(`[review] ${sessionId} cancelled: ${err.message}`);
      try {
        await updateSessionUnlessCancelled(cpbRoot, sessionId, {
          status: "cancelled",
          detail: err.message || "cancelled",
        }, { skipTransitionCheck: true });
      } catch (updateError) {
        terminalPersistError = updateError;
        console.error(`[review] ${sessionId} failed to persist cancellation: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
      }
      return;
    }
    console.error(`[review] ${sessionId} error: ${err.message}`);
    try {
      await updateSessionUnlessCancelled(
        cpbRoot,
        sessionId,
        { status: "expired", detail: err.message || "review failed" },
        { skipTransitionCheck: true },
      );
    } catch (updateError) {
      terminalPersistError = updateError;
      console.error(`[review] ${sessionId} failed to persist error status: ${updateError instanceof Error ? updateError.message : String(updateError)}`);
    }
  } finally {
    const closeResults = await Promise.allSettled([
      codex?.close() || Promise.resolve(),
      claude?.close() || Promise.resolve(),
    ]);
    externalAbortCleanup();
    if (activeReviewRuns.get(key)?.teardown === teardown) activeReviewRuns.delete(key);
    const closeFailures = closeResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    const failure = combineReviewFailures([...closeFailures, terminalPersistError]);
    if (failure) {
      teardownReject(failure);
      throw failure;
    }
    teardownResolve();
  }
}

// ─── verifier-evidence.ts ─────────────────────────────────────────
import { stat } from "node:fs/promises";
import { execFile as execFileVerifier } from "node:child_process";
import { promisify as promisifyVerifier } from "node:util";
import { readEvents } from "../event/event-store.js";
import { reconstructJobState, contextPath, decisionsPath, outputsDir } from "../phase-locator.js";
import { CPB_RUNTIME_ENV, RUNTIME_BASICS } from "../secret-policy.js";

const execFileVerifierAsync = promisifyVerifier(execFileVerifier);

function buildVerifierCommandEnv(parentEnv: NodeJS.ProcessEnv = process.env) {
  const allowed = new Set([...RUNTIME_BASICS, ...CPB_RUNTIME_ENV]);
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(parentEnv || {})) {
    if (allowed.has(key)) env[key] = value;
  }
  return env;
}

export async function collectCurrentDiff(sourcePath: string, { maxLines = 200 }: { maxLines?: number } = {}) {
  if (!sourcePath) return { available: false, reason: "no source path" };

  try {
    const { stdout } = await execFileVerifierAsync("git", ["diff", "--stat", "HEAD"], {
      cwd: sourcePath,
      env: buildVerifierCommandEnv(),
      maxBuffer: 1024 * 1024,
    });
    return { available: true, diff: stdout.slice(0, maxLines * 200) };
  } catch {
    return { available: false, reason: "git diff failed or not a git repo" };
  }
}

export async function collectUncommittedDiff(sourcePath: string, { maxLines = 200 }: { maxLines?: number } = {}) {
  if (!sourcePath) return { available: false, reason: "no source path" };

  try {
    const { stdout } = await execFileVerifierAsync("git", ["diff"], {
      cwd: sourcePath,
      env: buildVerifierCommandEnv(),
      maxBuffer: 1024 * 1024,
    });
    const truncated = stdout.split("\n").slice(0, maxLines).join("\n");
    return { available: true, diff: truncated };
  } catch {
    return { available: false, reason: "git diff failed" };
  }
}

export async function collectTestResults(sourcePath: string, { timeout = 30_000 }: { timeout?: number } = {}) {
  if (!sourcePath) return { available: false, reason: "no source path" };

  try {
    const pkgPath = path.join(sourcePath, "package.json");
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    const testScript = pkg.scripts?.test;
    if (!testScript) return { available: false, reason: "no test script" };

    const { stdout, stderr } = await execFileVerifierAsync("npm", ["test"], {
      cwd: sourcePath,
      env: buildVerifierCommandEnv(),
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { available: true, stdout: stdout.slice(-5000), stderr: stderr.slice(-5000) };
  } catch (err) {
    const stdout = err.stdout?.slice(-5000) || "";
    const stderr = err.stderr?.slice(-5000) || "";
    return { available: true, exitCode: err.code || 1, stdout, stderr };
  }
}

export async function collectEventLog(cpbRoot: string, project: string, jobId: string, { maxEvents = 50, dataRoot = null }: ReviewStorageOptions & { maxEvents?: number } = {}) {
  try {
    const events = await readEvents(cpbRoot, project, jobId, dataRoot
      ? { dataRoot, includeLegacyFallback: false }
      : {});
    if (events.length === 0) {
      return { available: false, reason: "event log is empty or missing" };
    }
    const recent = events.slice(-maxEvents);
    return { available: true, eventCount: events.length, events: recent };
  } catch {
    return { available: false, reason: "event log not found" };
  }
}

export async function collectProjectContext(cpbRoot: string, project: string, options: ReviewStorageOptions = {}) {
  const ctx = await readFile(contextPath(cpbRoot, project, options), "utf8").catch((): null => null);
  const decisions = await readFile(decisionsPath(cpbRoot, project, options), "utf8").catch((): null => null);

  return {
    available: Boolean(ctx || decisions),
    context: ctx,
    decisions,
  };
}

export async function collectDeliverable(cpbRoot: string, project: string, deliverableId: string, options: ReviewStorageOptions = {}) {
  if (!deliverableId) return { available: false, reason: "no deliverable ID" };

  const file = path.join(outputsDir(cpbRoot, project, options), `deliverable-${deliverableId}.md`);
  try {
    const content = await readFile(file, "utf8");
    return { available: true, content, path: file };
  } catch {
    return { available: false, reason: `deliverable file not found: ${file}` };
  }
}

export async function collectVerifierEvidence(cpbRoot: string, project: string, jobId: string, { sourcePath, deliverableId, dataRoot: explicitDataRoot = null }: ReviewStorageOptions & {
  sourcePath?: string | null;
  deliverableId?: string;
} = {}): Promise<VerifierEvidence> {
  const jobState = await reconstructJobState(cpbRoot, project, jobId);

  const evidence: VerifierEvidence = {
    jobState,
    deliverable: null,
    diff: null,
    uncommittedDiff: null,
    eventLog: null,
    projectContext: null,
    testResults: null,
    diagnostics: [],
  };

  const dataRoot = stringValue(explicitDataRoot) || stringValue(jobState?.stateRoot) || null;
  const runtimeOptions = dataRoot ? { dataRoot } : {};
  const resolvedSourcePath = stringValue(sourcePath) || stringValue(jobState?.sourcePath) || stringValue(jobState?.worktree) || null;

  const [deliverable, diff, uncommittedDiff, eventLog, projectContext, testResults] = await Promise.all([
    collectDeliverable(cpbRoot, project, deliverableId, runtimeOptions).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectCurrentDiff(resolvedSourcePath).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectUncommittedDiff(resolvedSourcePath).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectEventLog(cpbRoot, project, jobId, runtimeOptions).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectProjectContext(cpbRoot, project, runtimeOptions).catch((err) => ({
      available: false,
      reason: err.message,
    })),
    collectTestResults(resolvedSourcePath).catch((err) => ({
      available: false,
      reason: err.message,
    })),
  ]);

  evidence.deliverable = deliverable;
  evidence.diff = diff;
  evidence.uncommittedDiff = uncommittedDiff;
  evidence.eventLog = eventLog;
  evidence.projectContext = projectContext;
  evidence.testResults = testResults;

  if (!deliverable.available) {
    evidence.diagnostics.push({
      level: "info",
      message: `deliverable not available: ${deliverable.reason}`,
    });
  }
  if (!diff.available) {
    evidence.diagnostics.push({
      level: "info",
      message: `diff not available: ${diff.reason}`,
    });
  }
  if (!eventLog.available) {
    evidence.diagnostics.push({
      level: "warning",
      message: `event log not available: ${eventLog.reason}`,
    });
  }

  return evidence;
}

// ─── remediation-handler.ts ───────────────────────────────────────
import { readFile as readFileRem } from "node:fs/promises";
import { appendEvent as appendEventRem, checkpointJob as checkpointJobRem, readEvents as readEventsRem, materializeJob as materializeJobRem } from "../event/event-store.js";
import { readJobsIndex, updateJobsIndexEntry as updateJobsIndexEntryRem } from "../job/job-store.js";
import { resolveHubRoot as resolveHubRootRem } from "../hub/hub-registry.js";
import { enqueue as enqueueRem, listQueue } from "../hub/hub-queue.js";
import { allocateArtifactId } from "../artifact-locator.js";
import { runtimeDataRoot, resolveProjectDataRoot } from "../runtime.js";

function remediationDataRoot(cpbRoot: string, options: ReviewStorageOptions = {}): string {
  return options.dataRoot || process.env.CPB_PROJECT_RUNTIME_ROOT || runtimeDataRoot(cpbRoot);
}

async function resolveRemediationDataRoot(cpbRoot: string, project: string, { hubRoot, dataRoot, lockDir }: ReviewStorageOptions = {}): Promise<string> {
  if (dataRoot) return dataRoot;
  if (lockDir) {
    const marker = `${path.sep}remediation-locks${path.sep}`;
    const markerIndex = lockDir.indexOf(marker);
    if (markerIndex > 0) return lockDir.slice(0, markerIndex);
  }
  return resolveProjectDataRoot(cpbRoot, project, {
    hubRoot: hubRoot || process.env.CPB_HUB_ROOT,
    dataRoot: process.env.CPB_PROJECT_RUNTIME_ROOT,
  });
}

type HeldWorkflowLock = {
  lockDir: string;
  releaseRequested: () => void;
  completion: Promise<void>;
  releasing: boolean;
};

const heldWorkflowLocks = new Map<string, HeldWorkflowLock>();

function workflowLockError(
  message: string,
  code: string,
  lockDir: string,
  cause?: unknown,
) {
  return Object.assign(
    new Error(message, cause === undefined ? undefined : { cause }),
    { code, lockDir },
  );
}

function workflowLockCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

async function acquireHeldWorkflowLock(
  lockDir: string,
  label: string,
  lockOptions: DurableDirectoryLockOptions = {},
) {
  const lockKey = path.resolve(lockDir);
  if (heldWorkflowLocks.has(lockKey)) {
    throw workflowLockError(`${label} already running`, "REVIEW_WORKFLOW_LOCK_BUSY", lockKey);
  }

  let markAcquired!: () => void;
  let rejectAcquire!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => {
    markAcquired = resolve;
    rejectAcquire = reject;
  });
  let requestRelease!: () => void;
  const releaseRequested = new Promise<void>((resolve) => { requestRelease = resolve; });
  let entered = false;
  const completion = withDurableDirectoryLock(lockKey, async () => {
    entered = true;
    markAcquired();
    await releaseRequested;
  }, {
    ttlMs: 0,
    waitMs: 100,
    retryMs: 10,
    ...lockOptions,
  });
  void completion.then(
    () => {
      if (!entered) {
        rejectAcquire(workflowLockError(
          `${label} lock ended before acquisition`,
          "REVIEW_WORKFLOW_LOCK_ACQUIRE_FAILED",
          lockKey,
        ));
      }
    },
    (error) => {
      if (!entered) rejectAcquire(error);
    },
  );

  try {
    await acquired;
  } catch (error) {
    await completion.catch(() => undefined);
    const code = workflowLockCode(error);
    if (code === "DIRECTORY_LOCK_BUSY") {
      throw workflowLockError(`${label} already running`, "REVIEW_WORKFLOW_LOCK_BUSY", lockKey, error);
    }
    throw workflowLockError(
      `${label} lock acquisition failed`,
      code || "REVIEW_WORKFLOW_LOCK_ACQUIRE_FAILED",
      lockKey,
      error,
    );
  }

  const lease: HeldWorkflowLock = {
    lockDir: lockKey,
    releaseRequested: requestRelease,
    completion,
    releasing: false,
  };
  heldWorkflowLocks.set(lockKey, lease);
  return lockKey;
}

async function releaseHeldWorkflowLock(lockDir: string, label: string) {
  const lockKey = path.resolve(lockDir);
  const lease = heldWorkflowLocks.get(lockKey);
  if (!lease) {
    throw workflowLockError(
      `${label} lock ownership is unavailable; refusing unowned release`,
      "REVIEW_WORKFLOW_LOCK_OWNERSHIP_UNAVAILABLE",
      lockKey,
    );
  }
  if (!lease.releasing) {
    lease.releasing = true;
    lease.releaseRequested();
  }
  try {
    await lease.completion;
  } finally {
    if (heldWorkflowLocks.get(lockKey) === lease) heldWorkflowLocks.delete(lockKey);
  }
}

async function releaseHeldWorkflowLockAfterFailure(
  lockDir: string,
  label: string,
  primaryError: unknown,
): Promise<never> {
  try {
    await releaseHeldWorkflowLock(lockDir, label);
  } catch (releaseError) {
    throw new AggregateError(
      [primaryError, releaseError],
      `${label} setup and durable lock release failed`,
      { cause: primaryError },
    );
  }
  throw primaryError;
}

async function withHeldWorkflowLockRelease<T>(
  lockDir: string,
  label: string,
  operation: () => Promise<T>,
) {
  let value: T | undefined;
  let primaryError: unknown = null;
  try {
    value = await operation();
  } catch (error) {
    primaryError = error;
  }
  let releaseError: unknown = null;
  try {
    await releaseHeldWorkflowLock(lockDir, label);
  } catch (error) {
    releaseError = error;
  }
  if (primaryError) {
    if (!releaseError) throw primaryError;
    throw new AggregateError(
      [primaryError, releaseError],
      `${label} operation and durable lock release failed`,
      { cause: primaryError },
    );
  }
  if (releaseError) throw releaseError;
  return value as T;
}

function validateIdRem(name: string, value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

async function acquireRemediationLock(cpbRoot: string, project: string, jobId: string, options: ReviewStorageOptions = {}): Promise<string> {
  const lockDir = path.join(remediationDataRoot(cpbRoot, options), "remediation-locks", project, `${jobId}.lock`);
  try {
    return await acquireHeldWorkflowLock(
      lockDir,
      `Remediation for ${project}/${jobId}`,
      options.workflowLockOptions,
    );
  } catch (err) {
    if (workflowLockCode(err) === "REVIEW_WORKFLOW_LOCK_BUSY") {
      throw workflowLockError(
        `Remediation already running for ${project}/${jobId}`,
        "REMEDIATION_ALREADY_RUNNING",
        lockDir,
        err,
      );
    }
    throw err;
  }
}

async function recordRemediationEvent(cpbRoot: string, project: string, jobId: string, event: LooseRecord, options: ArtifactEventOptions = {}): Promise<void> {
  await appendEventRem(cpbRoot, project, jobId, event as Parameters<typeof appendEventRem>[3], options);
  await checkpointJobRem(cpbRoot, project, jobId, options).catch(() => {});
  const state = materializeJobRem(await readEventsRem(cpbRoot, project, jobId, options));
  await updateJobsIndexEntryRem(cpbRoot, project, jobId, state, options).catch(() => {});
}

export async function runRemediation(cpbRoot: string, {
  project,
  jobId,
  executorRoot = null,
  hubRoot,
  dataRoot: explicitDataRoot,
  workflowLockOptions,
}: RemediationRunOptions) {
  validateIdRem("project", project);
  validateIdRem("jobId", jobId);

  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, {
    hubRoot: hubRoot || process.env.CPB_HUB_ROOT,
    dataRoot: explicitDataRoot || process.env.CPB_PROJECT_RUNTIME_ROOT,
  });
  const wikiDir = path.join(dataRoot, "wiki");
  const outputsDir = path.join(wikiDir, "outputs");
  const eventOpts = { dataRoot, includeLegacyFallback: false };
  const lockDir = await acquireRemediationLock(cpbRoot, project, jobId, {
    ...eventOpts,
    workflowLockOptions,
  });

  try {
    let events;
    try {
      events = await readEventsRem(cpbRoot, project, jobId, eventOpts);
    } catch {
      events = [];
    }
    if (events.length === 0) {
      throw new Error(`event file not found or empty for job ${jobId}`);
    }
    const job = materializeJobRem(events);

    const remediationId = await allocateArtifactId(outputsDir, "remediation");
    const remediationFile = path.join(outputsDir, `remediation-${remediationId}.md`);
    const remediationArtifact = `remediation-${remediationId}`;

    let sourcePath = "";
    try {
      const metaFile = path.join(wikiDir, "project.json");
      const meta = JSON.parse(await readFileRem(metaFile, "utf8"));
      sourcePath = meta.sourcePath || "";
    } catch {}

    return { remediationId, remediationFile, remediationArtifact, workflow: job?.workflow || "", sourcePath, dataRoot, lockDir };
  } catch (err) {
    return releaseHeldWorkflowLockAfterFailure(lockDir, "Remediation", err);
  }
}

export async function completeRemediation(cpbRoot: string, { project, jobId, remediationId, remediationFile, remediationArtifact, status, error, executorRoot, hubRoot, dataRoot: explicitDataRoot, lockDir }: CompleteRemediationOptions) {
  if (!lockDir) {
    throw workflowLockError(
      `Remediation for ${project}/${jobId} requires its exact lock lease`,
      "REVIEW_WORKFLOW_LOCK_OWNERSHIP_UNAVAILABLE",
      path.join(remediationDataRoot(cpbRoot, { dataRoot: explicitDataRoot }), "remediation-locks", project, `${jobId}.lock`),
    );
  }
  return withHeldWorkflowLockRelease(lockDir, "Remediation", async () => {
    const dataRoot = await resolveRemediationDataRoot(cpbRoot, project, {
      hubRoot,
      dataRoot: explicitDataRoot,
      lockDir,
    });
    const eventOpts = { dataRoot, includeLegacyFallback: false };
    if (status === "failed") {
      await recordRemediationEvent(cpbRoot, project, jobId, {
        type: "external_remediation_failed",
        jobId,
        project,
        artifact: remediationArtifact,
        file: remediationFile,
        error: error || "unknown error",
        ts: new Date().toISOString(),
      }, eventOpts);
      return;
    }

    let remediationContent;
    try {
      remediationContent = await readFileRem(remediationFile, "utf8");
    } catch {
      await recordRemediationEvent(cpbRoot, project, jobId, {
        type: "external_remediation_failed",
        jobId,
        project,
        artifact: remediationArtifact,
        file: remediationFile,
        error: "remediation report not created",
        ts: new Date().toISOString(),
      }, eventOpts);
      throw new Error("remediation report not created");
    }

    const remediationStatus = parseRemediationStatus(remediationContent);
    if (!remediationStatus) {
      await recordRemediationEvent(cpbRoot, project, jobId, {
        type: "external_remediation_failed",
        jobId,
        project,
        artifact: remediationArtifact,
        file: remediationFile,
        error: `invalid remediation status: ${remediationStatus === null ? "missing" : remediationStatus}`,
        ts: new Date().toISOString(),
      }, eventOpts);
      throw new Error("invalid remediation status");
    }

    await recordRemediationEvent(cpbRoot, project, jobId, {
      type: "external_remediation_completed",
      jobId,
      project,
      artifact: remediationArtifact,
      file: remediationFile,
      remediationStatus,
      ts: new Date().toISOString(),
    }, eventOpts);

    if (remediationStatus === "FIXED") {
      await markJobSuperseded(cpbRoot, project, jobId, eventOpts);
      await createRemediationLineageTask(cpbRoot, { project, jobId, remediationArtifact, remediationStatus, executorRoot, dataRoot });
    }

    return remediationStatus;
  });
}

function parseRemediationStatus(content: string): string | null {
  const firstLine = content.split(/\r?\n/)[0] || "";
  const match = firstLine.match(/^REMEDIATION:\s*([A-Z_]+)/);
  const status = match ? match[1] : null;
  if (status === "FIXED" || status === "NOOP" || status === "BLOCKED") return status;
  return null;
}

async function markJobSuperseded(cpbRoot: string, project: string, jobId: string, options: ArtifactEventOptions = {}): Promise<void> {
  await recordRemediationEvent(cpbRoot, project, jobId, {
    type: "job_superseded",
    jobId,
    project,
    reason: "external_remediation_fixed",
    ts: new Date().toISOString(),
  }, options);
  const state = materializeJobRem(await readEventsRem(cpbRoot, project, jobId, options));
  if (state) {
    state.status = "superseded";
    await updateJobsIndexEntryRem(cpbRoot, project, jobId, state, options).catch(() => {});
  }
}

async function createRemediationLineageTask(cpbRoot: string, { project, jobId, remediationArtifact, remediationStatus, executorRoot, dataRoot }: LineageTaskOptions): Promise<void> {
  const eventOpts = dataRoot ? { dataRoot, includeLegacyFallback: false } : {};
  const job = materializeJobRem(await readEventsRem(cpbRoot, project, jobId, eventOpts));
  if (!job?.task) {
    throw new Error(`job task missing: ${jobId}`);
  }

  // Skip if a completed job already exists for the same task
  try {
    const index = await readJobsIndex(cpbRoot, eventOpts);
    const jobs = index?.jobs || {};
    const alreadyCompleted = Object.values(jobs).some(
      (j) => {
        const candidate = j as LooseRecord;
        return candidate && candidate.task === job.task && candidate.status === "completed" && candidate.project === project;
      },
    );
    if (alreadyCompleted) {
      console.log(`Skip lineage task: task already completed — ${String(job.task || "").slice(0, 60)}`);
      return;
    }
  } catch {}

  const hubRoot = resolveHubRootRem(cpbRoot);
  const entries = await listQueue(hubRoot, { projectId: project });
  const origin =
    entries.find((entry) => entry.metadata?.jobId === jobId) ||
    entries.find((entry) => entry.description === job.task && entry.status === "failed") ||
    entries.find((entry) => entry.description === job.task) ||
    null;

  let sourcePath = origin?.sourcePath || "";
  if (!sourcePath) {
    try {
      const metaFile = path.join(cpbRoot, "wiki", "projects", project, "project.json");
      const meta = JSON.parse(await readFileRem(metaFile, "utf8"));
      sourcePath = meta.sourcePath || "";
    } catch {}
  }

  const entry = await enqueueRem(hubRoot, {
    projectId: project,
    sourcePath,
    sessionId: origin?.sessionId || null,
    workerId: origin?.workerId || null,
    cwd: origin?.cwd || sourcePath,
    executionBoundary: origin?.executionBoundary || "worktree",
    type: origin?.type || "pipeline",
    priority: origin?.priority || "P2",
    description: job.task,
    metadata: {
      ...(origin?.metadata || {}),
      originJobId: jobId,
      originQueueEntryId: origin?.id || null,
      remediationArtifact,
      remediationStatus,
      lineageReason: "external_remediation_fixed_cpb_self_bug",
      sourceContext: {
        ...recordValue(origin?.metadata?.sourceContext || job.sourceContext),
        remediation: {
          previousJobId: jobId,
          previousQueueEntryId: origin?.id || null,
          remediationArtifact,
          remediationStatus,
          lineageReason: "external_remediation_fixed_cpb_self_bug",
          failureReason: job.blockedReason || null,
          failurePhase: job.failurePhase || null,
          failureCode: job.failureCode || null,
          artifacts: job.artifacts || {},
        },
        retry: {
          failureKind: job.failureCode || "external_remediation",
          failureReason: stringValue(job.blockedReason, "external remediation requested"),
          previousJobId: jobId,
          previousPhase: job.failurePhase || null,
          previousOutput: "",
        },
      },
    },
  });

  console.log(`New task: ${entry.id}`);
}

// ─── repair-handler.ts ────────────────────────────────────────────
import { readFile as readFileRepair } from "node:fs/promises";
import { appendEvent as appendEventRepair, checkpointJob as checkpointJobRepair, readEvents as readEventsRepair, materializeJob as materializeJobRepair } from "../event/event-store.js";
import { updateJobsIndexEntry as updateJobsIndexEntryRepair } from "../job/job-store.js";
import { resolveHubRoot as resolveHubRootRepair } from "../hub/hub-registry.js";
import { enqueue as enqueueRepair, listQueue as listQueueRepair } from "../hub/hub-queue.js";
import { allocateArtifactId as allocateArtifactIdRepair } from "../artifact-locator.js";

function validateIdRepair(name: string, value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
}

async function acquireRepairLock(cpbRoot: string, project: string, jobId: string, options: ReviewStorageOptions = {}): Promise<string> {
  const root = options.dataRoot || process.env.CPB_PROJECT_RUNTIME_ROOT || runtimeDataRoot(cpbRoot);
  const lockDir = path.join(root, "repair-locks", project, `${jobId}.lock`);
  try {
    return await acquireHeldWorkflowLock(
      lockDir,
      `Repair for ${project}/${jobId}`,
      options.workflowLockOptions,
    );
  } catch (err) {
    if (workflowLockCode(err) === "REVIEW_WORKFLOW_LOCK_BUSY") {
      throw workflowLockError(
        `Repair already running for ${project}/${jobId}`,
        "REPAIR_ALREADY_RUNNING",
        lockDir,
        err,
      );
    }
    throw err;
  }
}

async function resolveRepairDataRoot(cpbRoot: string, project: string, { hubRoot, dataRoot, lockDir }: ReviewStorageOptions = {}): Promise<string> {
  if (dataRoot) return dataRoot;
  if (lockDir) {
    const marker = `${path.sep}repair-locks${path.sep}`;
    const markerIndex = lockDir.indexOf(marker);
    if (markerIndex > 0) return lockDir.slice(0, markerIndex);
  }
  return resolveProjectDataRoot(cpbRoot, project, {
    hubRoot: hubRoot || process.env.CPB_HUB_ROOT,
    dataRoot: process.env.CPB_PROJECT_RUNTIME_ROOT,
  });
}

async function recordRepairEvent(cpbRoot: string, project: string, jobId: string, event: LooseRecord, options: ArtifactEventOptions = {}): Promise<void> {
  await appendEventRepair(cpbRoot, project, jobId, event as Parameters<typeof appendEventRepair>[3], options);
  await checkpointJobRepair(cpbRoot, project, jobId, options).catch(() => {});
  const state = materializeJobRepair(await readEventsRepair(cpbRoot, project, jobId, options));
  await updateJobsIndexEntryRepair(cpbRoot, project, jobId, state, options).catch(() => {});
}

export async function runRepair(cpbRoot: string, {
  project,
  jobId,
  executorRoot,
  hubRoot,
  dataRoot: explicitDataRoot,
  workflowLockOptions,
}: RepairRunOptions) {
  validateIdRepair("project", project);
  validateIdRepair("jobId", jobId);

  const dataRoot = await resolveProjectDataRoot(cpbRoot, project, {
    hubRoot: hubRoot || process.env.CPB_HUB_ROOT,
    dataRoot: explicitDataRoot || process.env.CPB_PROJECT_RUNTIME_ROOT,
  });
  const outputsDir = path.join(dataRoot, "wiki", "outputs");
  const eventOpts = { dataRoot, includeLegacyFallback: false };
  const lockDir = await acquireRepairLock(cpbRoot, project, jobId, {
    ...eventOpts,
    workflowLockOptions,
  });

  try {
    const eventFile = path.join(dataRoot, "events", project, `${jobId}.jsonl`);
    let events;
    try {
      events = await readEventsRepair(cpbRoot, project, jobId, eventOpts);
    } catch {
      events = [];
    }
    if (events.length === 0) {
      throw new Error(`event file not found or empty: ${eventFile}`);
    }

    const repairId = await allocateArtifactIdRepair(outputsDir, "repair");
    const repairFile = path.join(outputsDir, `repair-${repairId}.md`);
    const repairArtifact = `repair-${repairId}`;

    return { repairId, repairFile, repairArtifact, dataRoot, lockDir };
  } catch (err) {
    return releaseHeldWorkflowLockAfterFailure(lockDir, "Repair", err);
  }
}

export async function completeRepair(cpbRoot: string, { project, jobId, repairId, repairFile, repairArtifact, status, error, executorRoot, hubRoot, dataRoot: explicitDataRoot, lockDir }: CompleteRepairOptions) {
  if (!lockDir) {
    throw workflowLockError(
      `Repair for ${project}/${jobId} requires its exact lock lease`,
      "REVIEW_WORKFLOW_LOCK_OWNERSHIP_UNAVAILABLE",
      path.join(explicitDataRoot || runtimeDataRoot(cpbRoot), "repair-locks", project, `${jobId}.lock`),
    );
  }
  return withHeldWorkflowLockRelease(lockDir, "Repair", async () => {
    const dataRoot = await resolveRepairDataRoot(cpbRoot, project, {
      hubRoot,
      dataRoot: explicitDataRoot,
      lockDir,
    });
    const eventOpts = { dataRoot, includeLegacyFallback: false };
    if (status === "failed") {
      await recordRepairEvent(cpbRoot, project, jobId, {
        type: "external_repair_failed",
        jobId,
        project,
        artifact: repairArtifact,
        file: repairFile,
        error: error || "unknown error",
        ts: new Date().toISOString(),
      }, eventOpts);
      return;
    }

    let repairContent;
    try {
      repairContent = await readFileRepair(repairFile, "utf8");
    } catch {
      await recordRepairEvent(cpbRoot, project, jobId, {
        type: "external_repair_failed",
        jobId,
        project,
        artifact: repairArtifact,
        file: repairFile,
        error: "repair report not created",
        ts: new Date().toISOString(),
      }, eventOpts);
      throw new Error("repair report not created");
    }

    const repairStatus = parseRepairStatus(repairContent);
    if (!repairStatus) {
      await recordRepairEvent(cpbRoot, project, jobId, {
        type: "external_repair_failed",
        jobId,
        project,
        artifact: repairArtifact,
        file: repairFile,
        error: `invalid repair status: ${repairStatus === null ? "missing" : repairStatus}`,
        ts: new Date().toISOString(),
      }, eventOpts);
      throw new Error("invalid repair status");
    }

    await recordRepairEvent(cpbRoot, project, jobId, {
      type: "external_repair_completed",
      jobId,
      project,
      artifact: repairArtifact,
      file: repairFile,
      repairStatus,
      ts: new Date().toISOString(),
    }, eventOpts);

    if (repairStatus === "FIXED") {
      await createRepairLineageTask(cpbRoot, { project, jobId, repairArtifact, repairStatus, executorRoot, dataRoot });
    }

    return repairStatus;
  });
}

function parseRepairStatus(content: string): string | null {
  const firstLine = content.split(/\r?\n/)[0] || "";
  const match = firstLine.match(/^REPAIR:\s*([A-Z_]+)/);
  const status = match ? match[1] : null;
  if (status === "FIXED" || status === "NOOP" || status === "BLOCKED") return status;
  return null;
}

async function createRepairLineageTask(cpbRoot: string, { project, jobId, repairArtifact, repairStatus, executorRoot, dataRoot }: LineageTaskOptions): Promise<void> {
  const eventOpts = dataRoot ? { dataRoot, includeLegacyFallback: false } : {};
  const job = materializeJobRepair(await readEventsRepair(cpbRoot, project, jobId, eventOpts));
  if (!job?.task) {
    throw new Error(`job task missing: ${jobId}`);
  }

  const hubRoot = resolveHubRootRepair(cpbRoot);
  const entries = await listQueueRepair(hubRoot, { projectId: project });
  const origin =
    entries.find((entry) => entry.metadata?.jobId === jobId) ||
    entries.find((entry) => entry.description === job.task && entry.status === "failed") ||
    entries.find((entry) => entry.description === job.task) ||
    null;

  let sourcePath = origin?.sourcePath || "";
  if (!sourcePath) {
    try {
      const metaFile = path.join(cpbRoot, "wiki", "projects", project, "project.json");
      const meta = JSON.parse(await readFileRepair(metaFile, "utf8"));
      sourcePath = meta.sourcePath || "";
    } catch {}
  }

  const entry = await enqueueRepair(hubRoot, {
    projectId: project,
    sourcePath,
    sessionId: origin?.sessionId || null,
    workerId: origin?.workerId || null,
    cwd: origin?.cwd || sourcePath,
    executionBoundary: origin?.executionBoundary || "worktree",
    type: origin?.type || "pipeline",
    priority: origin?.priority || "P2",
    description: job.task,
    metadata: {
      ...(origin?.metadata || {}),
      originJobId: jobId,
      originQueueEntryId: origin?.id || null,
      repairArtifact,
      repairStatus,
      lineageReason: "external_repair_fixed_cpb_self_bug",
      sourceContext: {
        ...recordValue(origin?.metadata?.sourceContext || job.sourceContext),
        repair: {
          previousJobId: jobId,
          previousQueueEntryId: origin?.id || null,
          repairArtifact,
          repairStatus,
          lineageReason: "external_repair_fixed_cpb_self_bug",
          failureReason: stringValue(job.blockedReason) || null,
          failurePhase: job.failurePhase || null,
          failureCode: job.failureCode || null,
          artifacts: job.artifacts || {},
        },
        retry: {
          failureKind: job.failureCode || "external_repair",
          failureReason: stringValue(job.blockedReason, "external repair requested"),
          previousJobId: jobId,
          previousPhase: job.failurePhase || null,
          previousOutput: "",
          artifacts: job.artifacts || {},
        },
        previousFailure: {
          kind: job.failureCode || "external_repair",
          reason: stringValue(job.blockedReason, "external repair requested"),
          jobId,
          phase: job.failurePhase || null,
          artifacts: job.artifacts || {},
          verdict: job.verdict || null,
          adversarialVerdict: job.adversarialVerdict || null,
        },
      },
    },
  });

  console.log(`New task: ${entry.id}`);
}
