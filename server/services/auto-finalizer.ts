import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { access, link, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import {
  MERGE_CLASSIFICATION,
  normalizeMergePath,
  summarizeMergeFiles,
} from "./evolve/evolve.js";
import { appendEvent, eventStreamCursorForRecords, readEvents } from "./event/event-store.js";
import { getJob, recordFinalizerResult } from "./job/job-store.js";
import {
  assertGithubTrustedGitRepository,
  openDraftPullRequest,
  pushGithubCommitWithControlledTransport,
} from "./github/github-issues.js";
import {
  assertGithubRemoteWriteAuthorized,
  normalizeGithubRemoteCapability,
  verifyGithubRemoteWriteCommitted,
  type GithubRemoteAuthorityRequest,
  type GithubRemoteAuthorityValidator,
  type GithubRemoteCapability,
  type GithubRemoteCommitVerifier,
  type GithubRemoteRunCommand,
  type GithubRemoteWriteVerification,
} from "./github/github-remote-capability.js";
import { enqueue as enqueueHubQueue, updateEntry as updateHubQueueEntry } from "./hub/hub-queue.js";
import { actualDiffRiskGuard } from "../../core/triage/rules.js";
import { normalizeRoute, scopesContainCritical } from "../../core/triage/schema.js";
import { buildReviewBundle } from "./review/review-session.js";
import { redactSecrets } from "./secret-policy.js";
import { writeJsonDurableAtomic } from "../../shared/hub-maintenance.js";
import {
  canonicalReviewBundleDirectory,
  verifiedCanonicalReviewBundlePath,
} from "../../shared/orchestrator/review-bundle-path.js";
import type { LooseRecord } from "../../core/contracts/types.js";
import {
  FINALIZER_MUTATION_RECEIPT_SCHEMA,
  finalizerCapabilityDigest,
  finalizerMutationFenceDigest,
} from "./finalizer-contract.js";
import {
  appendFinalizerJournal,
  finalizerJournalClaimId,
  finalizerJournalDigest,
  finalizerJournalFinalizationId,
  finalizerJournalPrEventId,
  readFinalizerJournal,
  type FinalizerJournalRecord,
  type FinalizerJournalSnapshot,
  type FinalizerJournalStage,
} from "./finalizer-journal.js";

const execFileAsync = promisify(execFile);

const PHASE_ROLE_MAP: Record<string, string> = { plan: "planner", execute: "executor", verify: "verifier", review: "reviewer", remediate: "remediator" };

type FinalizerRecord = LooseRecord & {
  id?: string;
  jobId?: string;
  project?: string;
  projectId?: string;
  status?: string | FinalizerRecord;
  code?: string | number;
  type?: string;
  phase?: string;
  agent?: string;
  mode?: string;
  reason?: string;
  reasons?: unknown[];
  description?: string;
  task?: string;
  source?: string;
  sourcePath?: string | null;
  worktree?: string;
  worktreeBranch?: string;
  worktreeBaseBranch?: string;
  cwd?: string | null;
  sessionId?: string | null;
  workerId?: string | null;
  executionBoundary?: string | null;
  priority?: string;
  metadata?: FinalizerRecord;
  sourceContext?: FinalizerRecord;
  routing?: FinalizerRecord;
  effectiveRoute?: FinalizerRecord;
  effective?: FinalizerRecord;
  requestedRoute?: FinalizerRecord;
  requested?: FinalizerRecord;
  ruleRoute?: FinalizerRecord;
  acpRoute?: FinalizerRecord;
  workflow?: string;
  planMode?: string;
  reviewer?: boolean;
  repo?: string;
  repository?: string;
  repositoryFullName?: string;
  issueNumber?: number | string;
  issueUrl?: string;
  issueTitle?: string;
  url?: string;
  entries?: FinalizerRecord[];
  counts?: Record<string, number>;
  classification?: string;
  protectedScopes?: string[];
  actualDiffRisk?: FinalizerRecord & { protected?: boolean; files?: string[] };
  protectedDiff?: FinalizerRecord;
  guardResult?: FinalizerRecord;
  escalation?: FinalizerRecord;
  finalDiffGuard?: FinalizerRecord;
  broken?: boolean;
  kind?: string;
  path?: string;
  links?: FinalizerRecord & { artifacts?: FinalizerRecord[]; eventLog?: string | null };
  evidence?: FinalizerRecord;
  verdict?: FinalizerRecord | string | null;
  verdictDetail?: LooseRecord | null;
  dw?: FinalizerRecord;
  completionGate?: FinalizerRecord;
  outcome?: string;
  layers?: Record<string, FinalizerRecord>;
  detail?: string;
  tests?: unknown;
  basis?: FinalizerRecord;
  blocking?: unknown[];
  blockingMissingInputs?: unknown[];
  blockingCount?: number;
  ok?: boolean;
  stdout?: string;
  stderr?: string;
  result?: FinalizerRecord;
  request?: FinalizerRecord & { body?: string; head?: string };
  branchPreparation?: FinalizerRecord & { commit?: string };
  commit?: string;
  prUrl?: string;
  prNumber?: number;
  error?: unknown;
  changedFiles?: unknown[];
};

type RuntimePathOptions = FinalizerRecord & {
  dataRoot?: string;
};

type RunCommandResult = {
  stdout?: string;
  stderr?: string;
  code?: string | number | null;
  exitCode?: string | number | null;
  status?: string | number | null;
  ok?: boolean;
};

type RunCommandError = Error & {
  stdout?: string;
  stderr?: string;
  code?: number;
};

type RunCommand = (command: string, args: string[], options?: LooseRecord) => Promise<RunCommandResult>;
type RecordFinalizerResultFn = typeof recordFinalizerResult;
type QueueMetadataForEnqueue = NonNullable<NonNullable<Parameters<typeof enqueueHubQueue>[1]>["metadata"]>;
type DraftPullRequestOptions = NonNullable<Parameters<typeof openDraftPullRequest>[0]>;

type RunCommandOptions = {
  runCommand?: RunCommand;
  env?: NodeJS.ProcessEnv;
};

type GitOptions = RunCommandOptions & {
  allowFailure?: boolean;
};

type IssueReference = {
  repo: string;
  number: number;
  url: string;
};

type RouteGuard = FinalizerRecord & {
  blocked: boolean;
  route: FinalizerRecord;
  protectedDiff: FinalizerRecord & {
    protectedScopes?: string[];
    actualDiffRisk: FinalizerRecord & { protected?: boolean; files?: string[] };
  };
  guardResult: FinalizerRecord & {
    allowed?: boolean;
    escalation?: FinalizerRecord | null;
    reviewer?: boolean;
  };
};

type RequeueProtectedDiffUpgradeOptions = {
  hubRoot?: string | null;
  entry?: FinalizerRecord;
  job?: FinalizerRecord;
  projectId?: string | null;
  sourcePath?: string | null;
  issue?: IssueReference | null;
  jobId?: string;
  route?: FinalizerRecord;
  protectedDiff?: RouteGuard["protectedDiff"];
  guardResult?: RouteGuard["guardResult"];
};

type ReviewEvidenceOptions = {
  cpbRoot?: string | null;
  dataRoot?: string | null;
  hubRoot?: string | null;
};

type FinalizeReviewBundleOptions = RuntimePathOptions & {
  cpbRoot?: string;
  hubRoot?: string | null;
  project?: string | null;
  entry?: FinalizerRecord;
  job?: FinalizerRecord;
  sourcePath?: string | null;
  jobId?: string;
  assertMutationLease?: ((context: FinalizerRecord) => Promise<void | boolean> | void | boolean) | null;
  mutationFence?: FinalizerRecord | null;
};

export type FinalizeQueueEntryOptions = RuntimePathOptions & {
  cpbRoot?: string;
  hubRoot?: string | null;
  project?: string | null;
  entry?: FinalizerRecord;
  job?: FinalizerRecord;
  sourcePath?: string | null;
  mode?: "dry-run" | "local" | "remote" | "pr" | string;
  remote?: string;
  issueCloser?: ((issue: FinalizerRecord) => Promise<unknown> | unknown) | null;
  runCommand?: RunCommand;
  createPullRequest?: DraftPullRequestOptions["createPullRequest"] | null;
  pushToken?: string | null;
  transportMode?: string | null;
  allowLiveFinalize?: boolean;
  allowLive?: boolean;
  recordFinalizerResult?: RecordFinalizerResultFn;
  remoteAuthorityValidator?: GithubRemoteAuthorityValidator | null;
  remoteCommitVerifier?: GithubRemoteCommitVerifier | null;
  transportPrincipal?: FinalizerRecord | null;
  assertMutationLease?: ((context: FinalizerRecord) => Promise<void | boolean> | void | boolean) | null;
  mutationFence?: FinalizerRecord | null;
};

type ApprovalGateOptions = RuntimePathOptions & {
  operation?: string | null;
  phase?: string | null;
  channels?: unknown[];
  reason?: string;
  timeoutAt?: string | null;
  ts?: string;
  actor?: string | null;
  action?: string | null;
};

function commandErrorDetails(err: unknown): RunCommandError {
  return err instanceof Error ? err as RunCommandError : Object.assign(new Error(String(err)), { stderr: String(err) });
}

function isFinalizerRecord(value: unknown): value is FinalizerRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finalizerRecord(value: unknown): FinalizerRecord {
  return isFinalizerRecord(value) ? value : {};
}

function commandErrorMessage(err: unknown): string {
  const details = commandErrorDetails(err);
  return String(details.stderr || details.stdout || details.message || "").trim();
}

function redactFinalizerRemoteValue(value: unknown, explicitSecrets: unknown[] = []): unknown {
  const replace = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      let text = entry.replace(
        /\b(cookie|set-cookie|session(?:[_-]?key)?)\s*[:=]\s*[^\s,;]+/gi,
        "$1=[REDACTED]",
      );
      for (const candidate of explicitSecrets) {
        const secret = typeof candidate === "string" ? candidate : "";
        if (secret) text = text.split(secret).join("[REDACTED]");
      }
      return text.length > 4_096 ? `${text.slice(0, 4_096)}…[TRUNCATED]` : text;
    }
    if (Array.isArray(entry)) return entry.slice(0, 32).map(replace);
    if (!isFinalizerRecord(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).slice(0, 32).map(([key, nested]) => [key, replace(nested)]));
  };
  return replace(redactSecrets(value));
}

function redactFinalizerRemoteText(value: unknown, explicitSecrets: unknown[] = []) {
  return String(redactFinalizerRemoteValue(value, explicitSecrets) || "");
}

function boundedCloseTransportResponse(value: unknown, explicitSecrets: unknown[] = []) {
  const response = finalizerRecord(value);
  const bounded = Object.fromEntries(
    ["ok", "state", "status", "code", "message", "stderr", "stdout"]
      .filter((key) => Object.prototype.hasOwnProperty.call(response, key))
      .map((key) => [key, response[key]]),
  );
  return finalizerRecord(redactFinalizerRemoteValue(bounded, explicitSecrets));
}

async function resolveAgentsFromEvents(cpbRoot: string, projectId: string, jobId: string, { dataRoot }: RuntimePathOptions = {}) {
  try {
    const events = await readEvents(cpbRoot, projectId, jobId, { dataRoot });
    const agents: FinalizerRecord = {};
    for (const ev of events) {
      if (ev.type === "phase_result" && ev.phase && ev.agent) {
        const role = PHASE_ROLE_MAP[ev.phase] || ev.phase;
        if (!agents[role]) agents[role] = ev.agent;
      }
    }
    return agents;
  } catch {
    return {};
  }
}

async function runGit(cwd: string, args: string[], {
  allowFailure = false,
  runCommand = execFileAsync,
  env,
}: GitOptions = {}) {
  try {
    const result = await runCommand("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      ...(env ? { env } : {}),
    });
    const explicitFailure = result.ok === false
      || (["code", "exitCode", "status"] as const).some((field) => {
        if (!Object.prototype.hasOwnProperty.call(result, field)) return false;
        const status = result[field];
        const normalized = typeof status === "string" && status.trim() !== "" ? Number(status) : status;
        return typeof normalized !== "number" || !Number.isFinite(normalized) || normalized !== 0;
      });
    if (explicitFailure) {
      throw Object.assign(new Error(String(result.stderr || `git ${args[0] || "command"} failed`)), {
        code: "GIT_COMMAND_FAILED",
        stdout: result.stdout,
        stderr: result.stderr,
        committed: null,
      });
    }
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: 0,
    };
  } catch (err) {
    if (!allowFailure) throw err;
    const details = commandErrorDetails(err);
    return {
      stdout: details.stdout || "",
      stderr: details.stderr || details.message || "",
      exitCode: Number.isInteger(details.code) ? details.code : 1,
    };
  }
}

async function captureWorktreeTree(cwd: string, { runCommand = execFileAsync, env: baseEnv = process.env }: RunCommandOptions = {}) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "cpb-audited-tree-"));
  const indexPath = path.join(temporaryRoot, "index");
  const env = {
    ...baseEnv,
    GIT_INDEX_FILE: indexPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  try {
    await runGit(cwd, ["read-tree", "HEAD"], { runCommand, env });
    await runGit(cwd, ["add", "-A"], { runCommand, env });
    const tree = (await runGit(cwd, ["write-tree"], { runCommand, env })).stdout.trim().toLowerCase();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("audited worktree tree could not be frozen");
    return tree;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function commitFrozenTree(
  cwd: string,
  tree: string,
  parent: string,
  message: string,
  {
    runCommand = execFileAsync,
    env,
    beforeUpdateRef = null,
  }: RunCommandOptions & { beforeUpdateRef?: (() => Promise<void> | void) | null } = {},
) {
  const commit = (await runGit(cwd, ["commit-tree", tree, "-p", parent, "-m", message], { runCommand, env })).stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("frozen audited commit could not be created");
  if (beforeUpdateRef) await beforeUpdateRef();
  await runGit(cwd, ["update-ref", "HEAD", commit, parent], { runCommand, env });
  const committedTree = (await runGit(cwd, ["rev-parse", "--verify", `${commit}^{tree}`], { runCommand, env })).stdout.trim().toLowerCase();
  if (committedTree !== tree) throw new Error("frozen audited commit tree changed");
  return commit;
}

async function pathExists(targetPath: string) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(repoPath: string, { runCommand, env }: RunCommandOptions = {}) {
  const result = await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"], {
    allowFailure: true,
    runCommand,
    env,
  });
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function assertClean(repoPath: string, { runCommand, env }: RunCommandOptions = {}) {
  const status = await runGit(repoPath, ["status", "--porcelain"], { runCommand, env });
  return status.stdout.trim() === "";
}

async function currentBranch(repoPath: string, { runCommand, env }: RunCommandOptions = {}) {
  return (await runGit(repoPath, ["branch", "--show-current"], { runCommand, env })).stdout.trim();
}

async function revParse(repoPath: string, ref = "HEAD", { runCommand, env }: RunCommandOptions = {}) {
  return (await runGit(repoPath, ["rev-parse", "--verify", ref], { runCommand, env })).stdout.trim();
}

async function diffFiles(repoPath: string, fromRef: string, toRef: string, { runCommand, env }: RunCommandOptions = {}) {
  const result = await runGit(repoPath, ["diff", "--name-only", "-z", fromRef, toRef], { runCommand, env });
  return splitNul(result.stdout);
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string, { runCommand, env }: RunCommandOptions = {}) {
  const result = await runGit(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant], {
    allowFailure: true,
    runCommand,
    env,
  });
  return result.exitCode === 0;
}

function reject(code: string, details: FinalizerRecord = {}): FinalizerRecord {
  return {
    ok: false,
    status: "rejected",
    code,
    jobId: details.jobId ?? null,
    ...details,
  };
}

function blocked(code: string, details: FinalizerRecord = {}): FinalizerRecord {
  return {
    ok: false,
    status: "blocked",
    code,
    jobId: details.jobId ?? null,
    ...details,
  };
}

function skipped(code: string, details: FinalizerRecord = {}): FinalizerRecord {
  return {
    ok: false,
    status: "skipped",
    code,
    jobId: details.jobId ?? null,
    ...details,
  };
}

function parseIssueUrl(issueUrl: unknown): { repo: string; number: number; url: string } | null {
  if (typeof issueUrl !== "string" || !issueUrl) return null;
  const match = issueUrl.match(/^https:\/\/github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+)\/issues\/([1-9][0-9]*)$/i);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  const repo = `${match[1]}/${match[2]}`.toLowerCase();
  return {
    repo,
    number,
    url: `https://github.com/${repo}/issues/${number}`,
  };
}

function githubRepositoryFromRemote(value: unknown): string | null {
  const remote = typeof value === "string" ? value.trim() : "";
  if (!remote) return null;
  const scp = remote.match(/^(?:[^@\s/]+@)?github\.com:([a-z0-9_.-]+\/[a-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (scp) return scp[1].toLowerCase();
  const url = remote.match(/^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return url ? url[1].toLowerCase() : null;
}

async function assertGitRemoteTargetsCapability(
  worktreePath: string,
  remote: string,
  capability: GithubRemoteCapability,
  { runCommand, env }: RunCommandOptions = {},
) {
  let repository = githubRepositoryFromRemote(remote);
  if (!repository) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) || remote.includes("..") || remote.includes("//")) {
      throw Object.assign(new Error("Git remote name is unsafe"), {
        code: "GITHUB_REMOTE_GIT_TARGET_INVALID",
        committed: false,
      });
    }
    const resolved = await runGit(worktreePath, ["remote", "get-url", "--push", "--all", remote], { runCommand, env });
    const pushUrls = resolved.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (pushUrls.length !== 1) {
      throw Object.assign(new Error("Git remote must resolve to exactly one push target"), {
        code: "GITHUB_REMOTE_GIT_TARGET_AMBIGUOUS",
        committed: false,
      });
    }
    repository = githubRepositoryFromRemote(pushUrls[0]);
  }
  if (repository !== capability.repository) {
    throw Object.assign(new Error("Git push target does not match the GitHub capability repository"), {
      code: "GITHUB_REMOTE_GIT_TARGET_MISMATCH",
      committed: false,
    });
  }
}

function sameRemoteCapability(left: GithubRemoteCapability, right: GithubRemoteCapability) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneRemoteAuthorityRequest(request: GithubRemoteAuthorityRequest): GithubRemoteAuthorityRequest {
  const capability = normalizeGithubRemoteCapability(request.capability);
  return {
    capability: {
      ...capability,
      permissions: { ...capability.permissions },
      ...(capability.pullRequest ? { pullRequest: { ...capability.pullRequest } } : {}),
    },
    operation: request.operation,
    repository: request.repository,
    issueNumber: request.issueNumber,
    targetBranch: request.targetBranch ?? null,
    pushKind: request.pushKind ?? null,
    headBranch: request.headBranch ?? null,
    baseBranch: request.baseBranch ?? null,
    pullRequestNumber: request.pullRequestNumber ?? null,
    commit: request.commit ?? null,
    title: request.title ?? null,
    body: request.body ?? null,
    draft: request.draft ?? null,
    authorLogin: request.authorLogin ?? null,
    authorId: request.authorId ?? null,
  };
}

function immutableRemoteAuthorityRequest(request: GithubRemoteAuthorityRequest): GithubRemoteAuthorityRequest {
  const snapshot = cloneRemoteAuthorityRequest(request);
  const capability = snapshot.capability as GithubRemoteCapability;
  Object.freeze(capability.permissions);
  if (capability.pullRequest) Object.freeze(capability.pullRequest);
  Object.freeze(capability);
  return Object.freeze(snapshot);
}

function normalizeTransportPrincipal(value: unknown) {
  const principal = finalizerRecord(value);
  const stableId = typeof principal.stableId === "string" ? principal.stableId.trim() : "";
  const login = typeof principal.login === "string" ? principal.login.trim().toLowerCase() : "";
  if ((principal.kind !== "github_app" && principal.kind !== "gh_user") || !stableId || !login) return null;
  const authorId = typeof principal.authorId === "number" && Number.isSafeInteger(principal.authorId) && principal.authorId > 0
    ? String(principal.authorId)
    : typeof principal.authorId === "string" && /^[1-9][0-9]*$/.test(principal.authorId)
      ? principal.authorId
      : null;
  return { kind: principal.kind, stableId, login, ...(authorId ? { authorId } : {}) };
}

function operationReceipt(operation: string, details: FinalizerRecord = {}) {
  const observedAt = new Date().toISOString();
  const eventId = createHash("sha256")
    .update(operation)
    .update("\0")
    .update(observedAt)
    .update("\0")
    .update(JSON.stringify(details))
    .digest("hex");
  return {
    operation,
    attempted: true,
    committed: true,
    observedAt,
    eventId,
    ...details,
  };
}

function nextJournalRecord(
  snapshot: FinalizerJournalSnapshot,
  stage: FinalizerJournalStage,
  updates: FinalizerRecord = {},
): FinalizerJournalRecord {
  if (!snapshot.record) throw new Error("finalizer journal has no active record");
  const current = snapshot.record;
  return {
    ...current,
    ...updates,
    schema: current.schema,
    finalizationId: current.finalizationId,
    project: current.project,
    entryId: current.entryId,
    originJobId: current.originJobId,
    mode: current.mode,
    repository: current.repository,
    issueNumber: current.issueNumber,
    capabilityDigest: current.capabilityDigest,
    principal: current.principal,
    source: current.source,
    capsule: current.capsule,
    commit: current.commit,
    tree: current.tree,
    preRemoteHead: current.preRemoteHead,
    targetBranch: current.targetBranch,
    generation: current.generation + 1,
    stage,
    receipts: {
      ...current.receipts,
      ...finalizerRecord(updates.receipts),
    },
  };
}

async function sha256File(file: string) {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

async function snapshotFinalizerCapsule(
  intent: FinalizerJournalRecord,
  dataRoot: string,
) {
  const capsule = finalizerRecord(intent.capsule);
  const requestedCapsuleRoot = path.resolve(dataRoot, "finalizer-journals");
  const capsuleRoot = await realpath(requestedCapsuleRoot);
  const expectedPath = path.join(capsuleRoot, `${intent.finalizationId}.bundle`);
  const capsulePath = path.resolve(String(capsule.path || ""));
  const snapshotRoot = await mkdtemp(path.join(tmpdir(), "cpb-finalizer-capsule-snapshot-"));
  const snapshotPath = path.join(snapshotRoot, "capsule.bundle");
  try {
    if (capsulePath !== expectedPath) {
      throw new Error("finalizer capsule escaped its canonical durable authority path");
    }
    const pathInfo = await lstat(capsulePath);
    if (!pathInfo.isFile() || pathInfo.nlink !== 1 || pathInfo.size !== capsule.bytes) {
      throw new Error("finalizer capsule receipt does not match a private regular file");
    }
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    const source = await open(capsulePath, fsConstants.O_RDONLY | noFollow);
    try {
      const openedInfo = await source.stat();
      if (!openedInfo.isFile()
        || openedInfo.nlink !== 1
        || openedInfo.size !== capsule.bytes
        || openedInfo.dev !== pathInfo.dev
        || openedInfo.ino !== pathInfo.ino) {
        throw new Error("finalizer capsule changed while opening its durable receipt");
      }
      await pipeline(
        createReadStream(capsulePath, { fd: source.fd, autoClose: false, start: 0 }),
        createWriteStream(snapshotPath, { flags: "wx", mode: 0o600 }),
      );
    } finally {
      await source.close();
    }
    const snapshotInfo = await lstat(snapshotPath);
    if (!snapshotInfo.isFile()
      || snapshotInfo.nlink !== 1
      || snapshotInfo.size !== capsule.bytes
      || await sha256File(snapshotPath) !== capsule.sha256) {
      throw new Error("finalizer capsule content does not match its durable receipt");
    }
    return {
      path: snapshotPath,
      dispose: () => rm(snapshotRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function persistFinalizerCapsule({
  worktree,
  dataRoot,
  finalizationId,
  commit,
  tree,
  runCommand,
  env,
}: {
  worktree: string;
  dataRoot: string;
  finalizationId: string;
  commit: string;
  tree: string;
  runCommand: RunCommand;
  env: NodeJS.ProcessEnv;
}) {
  const root = path.resolve(dataRoot, "finalizer-journals");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const capsulePath = path.join(canonicalRoot, `${finalizationId}.bundle`);
  const verifyExisting = async () => {
    const info = await lstat(capsulePath);
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0) throw new Error("finalizer capsule is not a private regular file");
    await runGit(worktree, ["bundle", "verify", capsulePath], { runCommand, env });
    const bundleHeads = (await runGit(worktree, ["bundle", "list-heads", capsulePath], { runCommand, env })).stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/, 2))
      .filter((parts) => parts.length === 2);
    if (!bundleHeads.some(([objectId]) => objectId.toLowerCase() === commit)) {
      throw new Error("finalizer capsule does not advertise the bound commit");
    }
    const capsuleCommit = (await runGit(worktree, ["rev-parse", "--verify", `${commit}^{commit}`], { runCommand, env })).stdout.trim().toLowerCase();
    const capsuleTree = (await runGit(worktree, ["rev-parse", "--verify", `${commit}^{tree}`], { runCommand, env })).stdout.trim().toLowerCase();
    if (capsuleCommit !== commit || capsuleTree !== tree) throw new Error("finalizer capsule source identity changed");
    return { path: capsulePath, sha256: await sha256File(capsulePath), bytes: info.size };
  };
  if (await pathExists(capsulePath)) return verifyExisting();

  const temporaryPath = `${capsulePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await runGit(worktree, ["bundle", "create", temporaryPath, "HEAD"], { runCommand, env });
    const temporaryHandle = await open(temporaryPath, "r");
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    try {
      await link(temporaryPath, capsulePath);
    } catch (error) {
      if (finalizerRecord(error).code !== "EEXIST") throw error;
    }
    await rm(temporaryPath, { force: true });
    const directoryHandle = await open(canonicalRoot, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return verifyExisting();
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

type ValidatedCandidateBinding = {
  baseSha: string;
  headSha: string;
  treeHash: string;
  identityHash: string;
  changedFiles: string[];
};

function validatedCandidateBinding(job: FinalizerRecord = {}): ValidatedCandidateBinding | null {
  const completionGate = finalizerRecord(job.completionGate || job.completionGateResult);
  const completionReport = finalizerRecord(job.completionReport || completionGate.completionReport);
  const validation = finalizerRecord(completionReport.candidateValidation);
  const replay = finalizerRecord(validation.cleanReplay);
  const baseSha = typeof validation.baseSha === "string" ? validation.baseSha.toLowerCase() : "";
  const headSha = typeof validation.headSha === "string" ? validation.headSha.toLowerCase() : "";
  const treeHash = typeof validation.treeHash === "string" ? validation.treeHash.toLowerCase() : "";
  const identityHash = typeof validation.identityHash === "string" ? validation.identityHash.toLowerCase() : "";
  const validatedIdentity = typeof validation.validatedCandidateIdentityHash === "string"
    ? validation.validatedCandidateIdentityHash.toLowerCase()
    : "";
  const changedFiles = Array.isArray(validation.changedFiles)
    ? validation.changedFiles.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (
    completionGate.outcome !== "complete"
    || validation.identityMatch !== true
    || replay.cleanApply !== true
    || identityHash !== validatedIdentity
    || !/^[0-9a-f]{40,64}$/.test(baseSha)
    || !/^[0-9a-f]{40,64}$/.test(headSha)
    || !/^[0-9a-f]{40,64}$/.test(treeHash)
    || !/^sha256:[0-9a-f]{64}$/.test(identityHash)
    || String(replay.baseSha || "").toLowerCase() !== baseSha
    || String(replay.expectedTreeHash || "").toLowerCase() !== treeHash
    || String(replay.actualTreeHash || "").toLowerCase() !== treeHash
    || changedFiles.length !== (Array.isArray(validation.changedFiles) ? validation.changedFiles.length : -1)
  ) return null;
  return {
    baseSha,
    headSha,
    treeHash,
    identityHash,
    changedFiles: [...new Set(changedFiles)].sort(),
  };
}

function resolveIssue(metadata: FinalizerRecord = {}): IssueReference | null {
  const rawNumber = metadata.issueNumber;
  const rawRepo = metadata.repo || metadata.repository || metadata.repositoryFullName;
  const hasNumber = rawNumber !== undefined && rawNumber !== null;
  const hasRepo = rawRepo !== undefined && rawRepo !== null;
  const hasUrl = metadata.issueUrl !== undefined && metadata.issueUrl !== null;
  const invalid = (reason: string): never => {
    throw Object.assign(new Error(reason), {
      code: "GITHUB_ISSUE_IDENTITY_INVALID",
      committed: false,
    });
  };

  if (hasNumber || hasRepo) {
    if (
      typeof rawNumber !== "number"
      || !Number.isSafeInteger(rawNumber)
      || rawNumber <= 0
    ) {
      return invalid("GitHub issue metadata number must be a positive safe integer");
    }
    const repo = typeof rawRepo === "string" ? rawRepo.toLowerCase() : "";
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) {
      return invalid("GitHub issue metadata repository must be owner/repo");
    }
    const expectedUrl = `https://github.com/${repo}/issues/${rawNumber}`;
    if (hasUrl) {
      const parsed = parseIssueUrl(metadata.issueUrl);
      if (!parsed || parsed.repo !== repo || parsed.number !== rawNumber || parsed.url !== expectedUrl) {
        return invalid("GitHub issue metadata URL does not match the exact repository and issue number");
      }
    }
    return {
      repo,
      number: rawNumber,
      url: expectedUrl,
    };
  }

  if (!hasUrl) return null;
  const parsed = parseIssueUrl(metadata.issueUrl);
  if (!parsed) return invalid("GitHub issue metadata URL is not canonical");
  return parsed;
}

function splitNul(value: unknown): string[] {
  return String(value || "").split("\0").filter(Boolean);
}

async function changedWorktreeFiles(worktreePath: string, { runCommand, env }: RunCommandOptions = {}) {
  const [unstaged, staged, untracked] = await Promise.all([
    runGit(worktreePath, ["diff", "--name-only", "-z"], { runCommand, env }),
    runGit(worktreePath, ["diff", "--cached", "--name-only", "-z"], { runCommand, env }),
    runGit(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"], { runCommand, env }),
  ]);
  return [...new Set([
    ...splitNul(unstaged.stdout),
    ...splitNul(staged.stdout),
    ...splitNul(untracked.stdout),
  ])];
}

function hasUnsafeChanges(summary: FinalizerRecord): boolean {
  return (
    summary.counts[MERGE_CLASSIFICATION.SHARED_STATE] > 0
    || summary.counts[MERGE_CLASSIFICATION.NEEDS_HUMAN] > 0
  );
}

function unsafeFiles(summary: FinalizerRecord): FinalizerRecord[] {
  return (summary.entries || []).filter((entry: FinalizerRecord) => (
    entry.classification === MERGE_CLASSIFICATION.SHARED_STATE
    || entry.classification === MERGE_CLASSIFICATION.NEEDS_HUMAN
  ));
}

function routingEffectiveRoute(entry: FinalizerRecord = {}, job: FinalizerRecord = {}): FinalizerRecord {
  const metadata = finalizerRecord(entry?.metadata);
  const routing = finalizerRecord(metadata.routing);
  return normalizeRoute(
    routing.effectiveRoute || routing.effective || {
      workflow: metadata.workflow || job.workflow || "standard",
      planMode: metadata.planMode || job.planMode || "full",
      reviewer: Boolean(routing.effectiveRoute?.reviewer || routing.effective?.reviewer),
      source: "queue_metadata",
      reason: "queue routing metadata",
    },
  );
}

function routeAllowsProtectedDiff(route: FinalizerRecord, protectedScopes: string[] = []): { allowed: boolean; escalation: FinalizerRecord | null; reviewer: boolean } {
  if (route?.workflow === "complex" && route?.planMode === "full") {
    return { allowed: true, escalation: null, reviewer: false };
  }

  const hasCritical = scopesContainCritical(protectedScopes);
  const wf = route?.workflow;
  const pm = route?.planMode;

  if (wf === "standard" && pm === "parent") {
    if (!hasCritical) {
      return { allowed: true, escalation: null, reviewer: true };
    }
    return {
      allowed: false,
      escalation: { workflow: "standard", planMode: "full", reviewer: true },
      reviewer: true,
    };
  }

  if (wf === "standard" && pm === "light") {
    // Keep standard workflow, upgrade to full plan + reviewer
    return {
      allowed: false,
      escalation: { workflow: "standard", planMode: "full", reviewer: true },
      reviewer: true,
    };
  }

  if (wf === "direct" && pm === "none") {
    return {
      allowed: false,
      escalation: { workflow: "complex", planMode: "full", reviewer: false },
      reviewer: false,
    };
  }

  return {
    allowed: false,
    escalation: { workflow: "complex", planMode: "full", reviewer: true },
    reviewer: true,
  };
}

function protectedDiffForRoute(files: string[], entry: FinalizerRecord, job: FinalizerRecord): RouteGuard {
  const route = routingEffectiveRoute(entry, job);
  const protectedDiff = actualDiffRiskGuard({ files });
  if (!protectedDiff.actualDiffRisk.protected) {
    return { blocked: false, route, protectedDiff, guardResult: { allowed: true } };
  }
  const guardResult = routeAllowsProtectedDiff(route, protectedDiff.protectedScopes);
  if (guardResult.allowed) {
    return { blocked: false, route, protectedDiff, guardResult };
  }
  return { blocked: true, route, protectedDiff, guardResult };
}

async function requeueProtectedDiffUpgrade({
  hubRoot,
  entry,
  job,
  projectId,
  sourcePath,
  issue,
  jobId,
  route,
  protectedDiff,
  guardResult,
}: RequeueProtectedDiffUpgradeOptions = {}) {
  if (!hubRoot || !entry?.id || !projectId || !route || !protectedDiff || !guardResult) return null;
  const escalation = guardResult?.escalation || { workflow: "complex", planMode: "full", reviewer: true };
  const scopeLevel = scopesContainCritical(protectedDiff.protectedScopes) ? "critical" : "non-critical";
  const upgradeRoute = normalizeRoute({
    category: "protected",
    workflow: escalation.workflow,
    planMode: escalation.planMode,
    reviewer: escalation.reviewer,
    source: "final_diff_guard",
    reason: `final diff touched ${scopeLevel} protected scopes; escalated from ${route.workflow}/${route.planMode}`,
  });
  const guardMetadata = {
    protected: true,
    originalRoute: route,
    effectiveRoute: upgradeRoute,
    protectedScopes: protectedDiff.protectedScopes,
    actualDiffRisk: protectedDiff.actualDiffRisk,
    files: protectedDiff.actualDiffRisk.files,
    sourceJobId: jobId,
    checkedAt: new Date().toISOString(),
  };
  const previousRoutingReasons = Array.isArray(entry.metadata?.routing?.reasons)
    ? entry.metadata.routing.reasons
    : [];
  const entryMetadata = finalizerRecord(entry.metadata);
  const entryRouting = finalizerRecord(entryMetadata.routing);
  const sourceContext = finalizerRecord(entryMetadata.sourceContext);
  const metadata: QueueMetadataForEnqueue = {};
  Object.assign(metadata, entryMetadata);
  if (entryMetadata.sourceContext !== undefined) Object.assign(metadata, { sourceContext });
  Object.assign(metadata, {
    workflow: upgradeRoute.workflow,
    planMode: upgradeRoute.planMode,
    requestedRoute: upgradeRoute,
    routing: {
      ...entryRouting,
      effective: upgradeRoute,
      effectiveRoute: upgradeRoute,
      protectedUpgrade: true,
      protectedScopes: protectedDiff.protectedScopes,
      actualDiffRisk: protectedDiff.actualDiffRisk,
      reasons: [
        ...new Set([
          ...previousRoutingReasons,
          `final diff guard forced ${escalation.workflow}/${escalation.planMode}`,
        ]),
      ],
    },
    finalDiffGuard: guardMetadata,
    originQueueId: entry.id,
    originJobId: jobId,
    supersedesQueueEntryId: entry.id,
    queueDedupeKey: `${entry.metadata?.queueDedupeKey || entry.id}:final-diff-guard:${jobId}`,
    autoFinalize: entry.metadata?.autoFinalize ?? true,
  });

  const upgraded = await enqueueHubQueue(hubRoot, {
    projectId,
    sourcePath: entry.sourcePath || sourcePath || null,
    sessionId: entry.sessionId || null,
    workerId: null,
    cwd: entry.cwd || null,
    executionBoundary: entry.executionBoundary || null,
    type: "routing_upgrade",
    priority: entry.priority || "P1",
    description: entry.description || job?.task || issue?.url || "protected diff routing upgrade",
    metadata,
  });

  await updateHubQueueEntry(hubRoot, entry.id, {
    metadata: {
      finalDisposition: "rejected.final_diff_guard",
      supersededByQueueEntryId: upgraded.id,
      supersededByJobId: jobId,
      finalDiffGuard: guardMetadata,
    },
  }).catch(() => {});

  return upgraded;
}

function buildRoutingContext(entry: FinalizerRecord, job: FinalizerRecord, routeGuard: RouteGuard | null = null): FinalizerRecord {
  const metadata = finalizerRecord(entry?.metadata);
  const routing = finalizerRecord(metadata.routing);
  const sourceContext = finalizerRecord(job?.sourceContext);
  let finalDiffGuard = null;
  if (routeGuard) {
    finalDiffGuard = {
      passed: !routeGuard.blocked,
      protectedScopes: routeGuard.protectedDiff?.protectedScopes || [],
      guardResult: routeGuard.guardResult,
      route: routeGuard.route,
    };
  } else if (metadata.finalDiffGuard) {
    finalDiffGuard = { passed: false, ...finalizerRecord(metadata.finalDiffGuard) };
  }
  const planCache = isFinalizerRecord(sourceContext.parentPlan)
    ? sourceContext.parentPlan
    : (isFinalizerRecord(metadata.planCache) ? metadata.planCache : null);
  return {
    routing,
    planMode: metadata.planMode || job.planMode || null,
    contextPack: metadata.contextPack || null,
    planCache,
    finalDiffGuard,
  };
}

function isInsideRoot(root: string, targetPath: string): boolean {
  if (!root || !targetPath || !path.isAbsolute(targetPath)) return false;
  const relative = path.relative(path.resolve(root), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function displayArtifactPath(artifactPath: unknown, roots: string[] = []): string | null {
  if (!artifactPath) return null;
  const value = String(artifactPath);
  if (!path.isAbsolute(value)) return value;
  for (const root of roots) {
    if (isInsideRoot(root, value)) return path.relative(path.resolve(root), value);
  }
  return path.basename(value);
}

function artifactIdFromPath(artifactPath: unknown): string {
  const name = path.basename(String(artifactPath || "artifact"));
  return name.replace(/\.(?:md|patch|diff|txt|json)$/i, "") || "artifact";
}

function artifactReferenceFromEntry(entry: FinalizerRecord, roots: string[]): { id: string; path: string | null } | null {
  if (!entry || entry.broken) return null;
  return {
    id: entry.id || artifactIdFromPath(entry.path),
    path: displayArtifactPath(entry.path, roots),
  };
}

function artifactReferenceForKind(bundle: FinalizerRecord, kind: string, roots: string[]): { id: string; path: string | null } | null {
  const matches = (bundle?.links?.artifacts || [])
    .filter((entry: FinalizerRecord) => entry?.kind === kind && !entry.broken);
  if (matches.length === 0) return null;
  const entry = kind === "verdict" ? matches[matches.length - 1] : matches[0];
  return artifactReferenceFromEntry(entry, roots);
}

function pushEvidenceLine(lines: string[], value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) pushEvidenceLine(lines, item);
    return;
  }
  if (value === null || value === undefined) return;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text) lines.push(text);
}

function testEvidenceFromVerdict(verdict: FinalizerRecord): string[] {
  const lines: string[] = [];
  pushEvidenceLine(lines, verdict?.tests);
  pushEvidenceLine(lines, verdict?.basis?.tests);
  if (verdict?.layers && typeof verdict.layers === "object") {
    for (const [name, layer] of Object.entries(verdict.layers) as Array<[string, FinalizerRecord]>) {
      if (!layer?.detail) continue;
      pushEvidenceLine(lines, `${name}: ${layer.detail}`);
    }
  }
  return [...new Set(lines)].slice(0, 8);
}

function verdictEvidenceForBody(verdict: LooseRecord | null): FinalizerRecord {
  if (!verdict || typeof verdict !== "object") {
    return { status: "pass", reason: "No structured verdict evidence was found" };
  }
  const blocking = Array.isArray(verdict.blocking) ? verdict.blocking : undefined;
  const blockingMissing = Array.isArray(verdict.blockingMissingInputs) ? verdict.blockingMissingInputs : undefined;
  const blockingCount = typeof verdict.blockingCount === "number"
    ? verdict.blockingCount
    : blocking?.length ?? blockingMissing?.length ?? undefined;
  const out: FinalizerRecord = {};
  Object.assign(out, verdict);
  out.status = String(verdict.status || verdict.verdict || "unavailable");
  out.blockingCount = blockingCount;
  return out;
}

function derivePrVerdictFromBundle(bundle: FinalizerRecord): FinalizerRecord {
  const evidence = finalizerRecord(bundle.evidence);
  const dw = finalizerRecord(bundle.dw);
  const completionGate = isFinalizerRecord(dw.completionGate) ? dw.completionGate : null;
  if (completionGate?.outcome !== "complete") {
    return {
      ok: false,
      code: "COMPLETION_GATE_NOT_COMPLETE",
      completionGate,
    };
  }

  const verdict = isFinalizerRecord(evidence.verdict) ? evidence.verdict : null;
  const status = String(verdict?.status || verdict?.verdict || "").trim().toLowerCase();
  if (status !== "pass") {
    return {
      ok: false,
      code: "VERDICT_NOT_PASS",
      completionGate,
      verdict: verdictEvidenceForBody(verdict),
    };
  }

  return {
    ok: true,
    verdict: "PASS",
    completionGate,
    verdictDetail: verdictEvidenceForBody(verdict),
  };
}

export function buildPrEvidenceFromReviewBundle(bundle: FinalizerRecord, {
  cpbRoot = null,
  dataRoot = null,
  hubRoot = null,
}: ReviewEvidenceOptions = {}): FinalizerRecord {
  const evidence = finalizerRecord(bundle.evidence);
  const roots = [hubRoot, dataRoot, cpbRoot].filter((root): root is string => Boolean(root));
  const artifacts = {
    plan: artifactReferenceForKind(bundle, "plan", roots),
    deliverable: artifactReferenceForKind(bundle, "deliverable", roots),
    review: artifactReferenceForKind(bundle, "review", roots),
    verdict: artifactReferenceForKind(bundle, "verdict", roots),
    diff: artifactReferenceForKind(bundle, "diff", roots),
  };
  if (!artifacts.diff && evidence.diffStat) {
    artifacts.diff = {
      id: "worktree-diff",
      path: `${Array.isArray(evidence.changedFiles) ? evidence.changedFiles.length : 0} changed files`,
    };
  }

  const artifactCount = Array.isArray(bundle?.links?.artifacts) ? bundle.links.artifacts.length : 0;
  return {
    artifacts,
    tests: testEvidenceFromVerdict(isFinalizerRecord(evidence.verdict) ? evidence.verdict : {}),
    audit: {
      eventLog: bundle?.links?.eventLog || null,
      artifactIndex: artifactCount > 0 ? `${artifactCount} artifact references` : null,
    },
    verdictDetail: verdictEvidenceForBody(isFinalizerRecord(evidence.verdict) ? evidence.verdict : null),
  };
}

function commitMessage({ jobId, issueNumber }: { jobId?: string; issueNumber?: number | string }): string {
  return [
    `Finalize CPB job ${jobId} for issue #${issueNumber}`,
    "",
    `CPB-Job: ${jobId}`,
    `Issue: #${issueNumber}`,
  ].join("\n");
}

/**
 * Detect file-level conflicts when parallel finalizes race on the same source.
 * Re-reads the source HEAD; if it advanced since `originalSourceHead`, computes
 * the intersection of intervening changes with the worktree's changed files.
 */
export async function detectParallelConflict(
  sourcePath: string,
  originalSourceHead: string,
  worktreeChangedFiles: string[],
  { runCommand = execFileAsync, env }: RunCommandOptions = {},
) {
  const currentHead = await revParse(sourcePath, "HEAD", { runCommand, env });
  if (currentHead === originalSourceHead) {
    return { conflict: false, sourceAdvanced: false };
  }

  const interveningRaw = await diffFiles(sourcePath, originalSourceHead, currentHead, { runCommand, env });
  const intervening = new Set(interveningRaw.map(normalizeMergePath));
  const worktree = new Set(worktreeChangedFiles.map(normalizeMergePath));

  const overlapping = [...worktree].filter((f) => intervening.has(f)).sort();

  return {
    conflict: overlapping.length > 0,
    sourceAdvanced: true,
    currentHead,
    originalSourceHead,
    interveningFiles: interveningRaw,
    worktreeFiles: worktreeChangedFiles,
    overlappingFiles: overlapping,
  };
}

async function finalizeAsReviewBundle({
  cpbRoot, hubRoot, project, entry, job, sourcePath,
  jobId, dataRoot, assertMutationLease, mutationFence,
}: FinalizeReviewBundleOptions = {}) {
  let bundlePath: string | null = null;
  let bundleSha256: string | null = null;
  let bundleBytes: number | null = null;
  let bundleCommitted = false;
  const stableProject = typeof project === "string" && project ? project : null;
  const stableEntryId = typeof entry?.id === "string" && entry.id ? entry.id : null;
  const stableJobId = typeof jobId === "string" && jobId && jobId !== "unknown" ? jobId : null;
  if (!stableProject || !stableEntryId || !stableJobId || !assertMutationLease || !mutationFence) {
    return blocked("MUTATION_LEASE_REQUIRED", {
      mode: "review_bundle",
      jobId: stableJobId || jobId || null,
      committed: false,
      eventRecorded: false,
      retryable: false,
    });
  }
  if (
    !finalizerMutationFenceDigest(mutationFence)
    || mutationFence.entryId !== stableEntryId
  ) {
    return blocked("MUTATION_FENCE_INVALID", {
      mode: "review_bundle",
      jobId: stableJobId,
      committed: false,
      eventRecorded: false,
      retryable: false,
    });
  }
  const assertReviewBundleMutationLease = async (target: "directory" | "artifact" | "event") => {
    const allowed = await assertMutationLease({
      operation: "review_bundle.publish",
      phase: "before-write",
      mode: "review_bundle",
      project: stableProject,
      entryId: stableEntryId,
      originJobId: stableJobId,
      jobId: stableJobId,
      finalizationId: null,
      generation: null,
      repository: null,
      issueNumber: null,
      commit: null,
      tree: null,
      target,
    });
    if (allowed === false) {
      throw Object.assign(new Error("review bundle mutation lease was rejected"), {
        code: "MUTATION_LEASE_LOST",
        committed: false,
        retryable: true,
      });
    }
  };
  try {
    const bundle = finalizerRecord(await buildReviewBundle(cpbRoot, stableProject, stableJobId, {
      entry, job, sourcePath,
      worktreePath: job?.worktree || null,
      dataRoot,
    }));
    const evidence = finalizerRecord(bundle.evidence);
    const verdict = finalizerRecord(evidence.verdict);

    const authorityRoot = path.resolve(hubRoot || cpbRoot || process.cwd());
    const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
    bundleSha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
    bundleBytes = Buffer.byteLength(serialized, "utf8");
    await assertReviewBundleMutationLease("directory");
    await mkdir(canonicalReviewBundleDirectory(authorityRoot, stableProject), { recursive: true });
    bundlePath = await verifiedCanonicalReviewBundlePath(authorityRoot, stableProject, stableJobId);
    await assertReviewBundleMutationLease("artifact");
    await writeJsonDurableAtomic(bundlePath, bundle);
    bundleCommitted = true;

    if (!cpbRoot) {
      return blocked("REVIEW_BUNDLE_AUDIT_REQUIRED", {
        mode: "review_bundle",
        jobId,
        bundlePath,
        bundleSha256,
        bundleBytes,
        committed: true,
        eventRecorded: false,
        retryable: true,
      });
    }
    try {
      await assertReviewBundleMutationLease("event");
      const recorded = await appendEvent(cpbRoot, stableProject, stableJobId, {
        type: "review_bundle_created",
        jobId: stableJobId,
        project: stableProject,
        bundlePath,
        bundleSha256,
        bundleBytes,
        changedFiles: evidence.changedFiles,
        verdict: verdict.verdict || null,
        ts: new Date().toISOString(),
      }, { dataRoot });
      if (!recorded) throw new Error("review_bundle_created event was not persisted");
    } catch (error) {
      return blocked("REVIEW_BUNDLE_EVENT_RECORD_FAILED", {
        mode: "review_bundle",
        jobId,
        bundlePath,
        bundleSha256,
        bundleBytes,
        committed: true,
        eventRecorded: false,
        retryable: true,
        error: redactFinalizerRemoteText(commandErrorMessage(error)),
      });
    }

    return {
      ok: true,
      status: "review_bundle",
      mode: "review_bundle",
      jobId,
      bundlePath,
      bundleSha256,
      bundleBytes,
      committed: true,
      eventRecorded: true,
      audit: {
        eventType: "review_bundle_created",
        jobId: stableJobId,
        project: stableProject,
        bundlePath,
      },
      changedFiles: evidence.changedFiles,
      verdict: verdict.verdict || null,
    };
  } catch (err) {
    const details = finalizerRecord(err);
    return blocked(String(details.code || "REVIEW_BUNDLE_FAILED"), {
      mode: "review_bundle",
      jobId: stableJobId,
      bundlePath,
      bundleSha256,
      bundleBytes,
      committed: bundleCommitted ? null : false,
      eventRecorded: false,
      retryable: details.retryable !== false && (details.retryable === true || bundleCommitted),
      error: redactFinalizerRemoteText(commandErrorMessage(err)),
    });
  }
}

export async function finalizeSuccessfulQueueEntry({
  cpbRoot,
  project,
  entry,
  job,
  sourcePath,
  mode = "dry-run",
  remote = "origin",
  issueCloser,
  runCommand = execFileAsync,
  createPullRequest,
  pushToken = null,
  transportMode = null,
  dataRoot,
  hubRoot = null,
  allowLiveFinalize = false,
  allowLive = false,
  recordFinalizerResult: recordFinalizerResultFn = recordFinalizerResult,
  remoteAuthorityValidator: injectedRemoteAuthorityValidator = null,
  remoteCommitVerifier: injectedRemoteCommitVerifier = null,
  transportPrincipal: rawTransportPrincipal = null,
  assertMutationLease = null,
  mutationFence = null,
}: FinalizeQueueEntryOptions = {}) {
  const jobId = job?.jobId || job?.id || entry?.jobId || entry?.id || "unknown";
  const projectId = project || job?.project || entry?.projectId || null;
  const dryRun = mode === "dry-run";
  const liveAllowed = Boolean(allowLiveFinalize || allowLive);
  const transportPrincipal = normalizeTransportPrincipal(rawTransportPrincipal);
  const recordAndReturn = async (result: FinalizerRecord) => {
    if (cpbRoot && projectId && jobId && jobId !== "unknown") {
      try {
        await recordFinalizerResultFn(cpbRoot, projectId, jobId, { result, dataRoot });
      } catch (err) {
        return blocked("FINALIZER_AUDIT_RECORD_FAILED", {
          jobId,
          mode,
          committed: result.committed ?? null,
          pushed: result.pushed ?? null,
          closed: result.closed ?? null,
          prUrl: result.prUrl ?? null,
          prNumber: result.prNumber ?? null,
          remoteWrites: result.remoteWrites ?? null,
          remoteIntent: result.remoteIntent ?? null,
          principal: result.principal ?? null,
          commit: result.commit ?? null,
          tree: result.tree ?? null,
          sourceSync: result.sourceSync ?? null,
          eventRecorded: result.eventRecorded ?? null,
          retryable: result.retryable ?? true,
          auditRecordFailed: true,
          error: redactFinalizerRemoteText(commandErrorMessage(err), [pushToken]),
          finalizerResult: result,
        });
      }
    }
    return result;
  };

  if (job?.status !== "completed") {
    return recordAndReturn(skipped("JOB_NOT_COMPLETED", { jobId }));
  }

  let issue: IssueReference | null;
  try {
    issue = resolveIssue(entry?.metadata);
  } catch (err) {
    return recordAndReturn(blocked("ISSUE_IDENTITY_INVALID", {
      jobId,
      mode,
      committed: false,
      error: redactFinalizerRemoteText(commandErrorMessage(err), [pushToken]),
    }));
  }
  if (!issue) {
    return recordAndReturn(await finalizeAsReviewBundle({
      cpbRoot, hubRoot, project: projectId, entry, job, sourcePath,
      jobId, dataRoot, assertMutationLease, mutationFence,
    }));
  }

  if (mode !== "local" && mode !== "remote" && mode !== "pr" && mode !== "dry-run") {
    return recordAndReturn(reject("UNSUPPORTED_MODE", { mode, jobId }));
  }

  if (!dryRun && !liveAllowed) {
    return recordAndReturn(reject("LIVE_FINALIZE_NOT_ALLOWED", { mode, jobId }));
  }

  const entryMetadata = finalizerRecord(entry?.metadata);
  const jobSourceContext = finalizerRecord(job?.sourceContext);
  const rawEntryRemoteCapability = entryMetadata.remoteCapability ?? null;
  const rawJobRemoteCapability = jobSourceContext.remoteCapability ?? null;
  const liveRemoteMode = !dryRun && (mode === "remote" || mode === "pr");
  const liveMutationMode = !dryRun && (mode === "local" || mode === "remote" || mode === "pr");
  let remoteCapability: GithubRemoteCapability | null = null;
  let entryRemoteCapability: GithubRemoteCapability | null = null;
  let jobRemoteCapability: GithubRemoteCapability | null = null;
  try {
    entryRemoteCapability = rawEntryRemoteCapability
      ? normalizeGithubRemoteCapability(rawEntryRemoteCapability)
      : null;
    jobRemoteCapability = rawJobRemoteCapability
      ? normalizeGithubRemoteCapability(rawJobRemoteCapability)
      : null;
  } catch (error) {
    return recordAndReturn(blocked("REMOTE_CAPABILITY_INVALID", {
      mode,
      jobId,
      committed: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  if (
    entryRemoteCapability
    && jobRemoteCapability
    && !sameRemoteCapability(entryRemoteCapability, jobRemoteCapability)
  ) {
    return recordAndReturn(blocked("REMOTE_CAPABILITY_CONFLICT", {
      mode,
      jobId,
      committed: false,
    }));
  }
  remoteCapability = entryRemoteCapability || jobRemoteCapability;
  if (liveRemoteMode && !remoteCapability) {
    return recordAndReturn(blocked("REMOTE_CAPABILITY_MISSING", {
      mode,
      jobId,
      committed: false,
    }));
  }
  if (remoteCapability && (
    remoteCapability.repository !== issue.repo.toLowerCase()
    || remoteCapability.issueNumber !== issue.number
  )) {
    return recordAndReturn(blocked("REMOTE_CAPABILITY_TARGET_MISMATCH", {
      mode,
      jobId,
      committed: false,
      issue,
    }));
  }
  const stableEntryId = typeof entry?.id === "string" && entry.id ? entry.id : null;
  if (liveRemoteMode && (!cpbRoot || !projectId || !stableEntryId || !dataRoot)) {
    return recordAndReturn(blocked("REMOTE_INTENT_JOURNAL_REQUIRED", {
      issue,
      jobId,
      mode,
      committed: false,
      retryable: false,
    }));
  }
  if (liveMutationMode && (!projectId || !stableEntryId || !assertMutationLease || !mutationFence)) {
    return recordAndReturn(blocked("MUTATION_LEASE_REQUIRED", {
      issue,
      jobId,
      mode,
      committed: false,
      retryable: false,
    }));
  }
  if (liveRemoteMode && !transportPrincipal) {
    return recordAndReturn(blocked("GITHUB_TRANSPORT_PRINCIPAL_REQUIRED", {
      issue,
      jobId,
      mode,
      committed: false,
      retryable: false,
    }));
  }
  const ownerDigest = liveMutationMode ? finalizerMutationFenceDigest(mutationFence) : null;
  if (liveMutationMode && !ownerDigest) {
    return recordAndReturn(blocked("MUTATION_FENCE_INVALID", {
      issue,
      jobId,
      mode,
      committed: false,
      retryable: false,
    }));
  }
  let journalSnapshot: FinalizerJournalSnapshot | null = null;

  if (!job?.worktree || !(await pathExists(job.worktree))) {
    return recordAndReturn(reject("NO_WORKTREE", { jobId }));
  }

  if (!sourcePath || !(await pathExists(sourcePath))) {
    return recordAndReturn(reject("NO_SOURCE_PATH", { jobId }));
  }

  const canonicalSourcePath = await realpath(path.resolve(sourcePath));
  const canonicalWorktreePath = await realpath(path.resolve(job.worktree));
  let sourceGitEnv: NodeJS.ProcessEnv;
  let worktreeGitEnv: NodeJS.ProcessEnv;
  try {
    const gitWorkspaceRoot = dataRoot || cpbRoot || canonicalSourcePath;
    sourceGitEnv = await assertGithubTrustedGitRepository(canonicalSourcePath, {
      runCommand,
      env: process.env,
      workspaceRoot: gitWorkspaceRoot,
      boundary: "finalizer source repository",
    });
    worktreeGitEnv = await assertGithubTrustedGitRepository(canonicalWorktreePath, {
      runCommand,
      env: process.env,
      workspaceRoot: gitWorkspaceRoot,
      boundary: "finalizer candidate worktree",
    });
  } catch (err) {
    return recordAndReturn(blocked("GIT_TRUST_BOUNDARY_REJECTED", {
      issue,
      jobId,
      mode,
      committed: false,
      pushed: false,
      closed: false,
      error: redactFinalizerRemoteText(commandErrorMessage(err), [pushToken]),
    }));
  }
  const remoteAuthorityValidator: GithubRemoteAuthorityValidator | null = remoteCapability
    ? async (request) => {
        const trustedRequest = immutableRemoteAuthorityRequest(request);
        const authority = injectedRemoteAuthorityValidator
          ? await injectedRemoteAuthorityValidator(cloneRemoteAuthorityRequest(trustedRequest))
          : await assertGithubRemoteWriteAuthorized(trustedRequest, {
              runCommand: runCommand as GithubRemoteRunCommand,
              principal: transportPrincipal || undefined,
            });
        const authorityRecord = finalizerRecord(authority);
        const observedPrincipal = normalizeTransportPrincipal(authorityRecord.principal || authorityRecord);
        if (!transportPrincipal || !observedPrincipal
          || finalizerJournalDigest(observedPrincipal) !== finalizerJournalDigest(transportPrincipal)) {
          throw Object.assign(new Error("GitHub authority principal does not match the bound transport"), {
            code: "GITHUB_TRANSPORT_PRINCIPAL_MISMATCH",
            committed: false,
          });
        }
        if (trustedRequest.operation === "repository.push") {
          const pushRemote = mode === "pr" && pushToken
            ? `https://github.com/${remoteCapability.repository}.git`
            : mode === "pr" ? "origin" : remote;
          await assertGitRemoteTargetsCapability(canonicalWorktreePath, pushRemote, remoteCapability, {
            runCommand,
            env: worktreeGitEnv,
          });
        }
        return authorityRecord;
      }
    : null;
  const remoteCommitVerifier: GithubRemoteCommitVerifier | null = remoteCapability
    ? async (request) => {
        const trustedRequest = immutableRemoteAuthorityRequest(request);
        const verification = injectedRemoteCommitVerifier
          ? await injectedRemoteCommitVerifier(cloneRemoteAuthorityRequest(trustedRequest))
          : await verifyGithubRemoteWriteCommitted(trustedRequest, {
              runCommand: runCommand as GithubRemoteRunCommand,
              principal: transportPrincipal || undefined,
            });
        const verificationRecord = finalizerRecord(verification);
        const observedPrincipal = normalizeTransportPrincipal(
          verificationRecord.principal || finalizerRecord(verificationRecord.evidence).principal,
        );
        if (!transportPrincipal || !observedPrincipal
          || finalizerJournalDigest(observedPrincipal) !== finalizerJournalDigest(transportPrincipal)) {
          return {
            operation: trustedRequest.operation,
            committed: null,
            reason: "GitHub verifier principal does not match the bound transport",
          };
        }
        return redactFinalizerRemoteValue(verification, [pushToken]) as GithubRemoteWriteVerification;
      }
    : null;

  if (!(await isGitRepo(canonicalSourcePath, { runCommand, env: sourceGitEnv }))) {
    return recordAndReturn(reject("SOURCE_NOT_GIT_REPO", { jobId }));
  }

  if (!(await assertClean(canonicalSourcePath, { runCommand, env: sourceGitEnv }))) {
    return recordAndReturn(reject("SOURCE_NOT_CLEAN", { jobId, mode, dryRun }));
  }

  if (!(await isGitRepo(canonicalWorktreePath, { runCommand, env: worktreeGitEnv }))) {
    return recordAndReturn(reject("WORKTREE_NOT_GIT_REPO", { jobId }));
  }

  const sourceBranch = await currentBranch(canonicalSourcePath, { runCommand, env: sourceGitEnv });
  if (!sourceBranch) {
    return recordAndReturn(reject("NO_SOURCE_BRANCH", { issue, jobId }));
  }

  const sourceHead = await revParse(canonicalSourcePath, "HEAD", { runCommand, env: sourceGitEnv });
  const worktreeBranch = await currentBranch(canonicalWorktreePath, { runCommand, env: worktreeGitEnv });
  const worktreeHead = await revParse(canonicalWorktreePath, "HEAD", { runCommand, env: worktreeGitEnv });
  const uncommittedFiles = await changedWorktreeFiles(canonicalWorktreePath, { runCommand, env: worktreeGitEnv });
  const candidateBinding = validatedCandidateBinding(finalizerRecord(job));
  if (!dryRun && !candidateBinding) {
    return recordAndReturn(blocked("VALIDATED_CANDIDATE_REQUIRED", {
      issue,
      jobId,
      mode,
      committed: false,
      pushed: false,
      closed: false,
    }));
  }
  if (candidateBinding && candidateBinding.headSha !== worktreeHead.toLowerCase()) {
    return recordAndReturn(blocked("VALIDATED_CANDIDATE_HEAD_MISMATCH", {
      issue,
      jobId,
      mode,
      committed: false,
      expectedHead: candidateBinding.headSha,
      actualHead: worktreeHead,
    }));
  }
  const managedBaseBranch = typeof job?.worktreeBaseBranch === "string" && job.worktreeBaseBranch
    ? job.worktreeBaseBranch
    : null;
  const managedBaseCommit = typeof job?.worktreeBaseCommit === "string" && job.worktreeBaseCommit
    ? job.worktreeBaseCommit.toLowerCase()
    : null;
  if (!dryRun && candidateBinding && (
    candidateBinding.baseSha !== sourceHead.toLowerCase()
    || (managedBaseBranch !== null && managedBaseBranch !== sourceBranch)
    || (managedBaseCommit !== null && managedBaseCommit !== candidateBinding.baseSha)
  )) {
    return recordAndReturn(blocked("VALIDATED_CANDIDATE_BASE_MISMATCH", {
      issue,
      jobId,
      mode,
      committed: false,
      expectedSourceBranch: managedBaseBranch,
      actualSourceBranch: sourceBranch,
      expectedSourceHead: candidateBinding.baseSha,
      actualSourceHead: sourceHead,
      managedBaseCommit,
      pushed: false,
      closed: false,
    }));
  }
  if (!dryRun && mode === "pr" && uncommittedFiles.length > 0) {
    return recordAndReturn(reject("WORKTREE_NOT_CLEAN_FOR_LIVE_PR", {
      issue,
      jobId,
      mode,
      uncommittedFiles,
    }));
  }
  let observedTree: string;
  try {
    observedTree = await captureWorktreeTree(canonicalWorktreePath, { runCommand, env: worktreeGitEnv });
  } catch (err) {
    return recordAndReturn(blocked("AUDITED_TREE_CAPTURE_FAILED", {
      issue,
      jobId,
      mode,
      committed: false,
      error: redactFinalizerRemoteText(commandErrorMessage(err), [pushToken]),
    }));
  }
  const auditedTree = candidateBinding?.treeHash || observedTree;
  if (observedTree !== auditedTree) {
    return recordAndReturn(blocked("VALIDATED_CANDIDATE_TREE_MISMATCH", {
      issue,
      jobId,
      mode,
      committed: false,
      expectedTree: auditedTree,
      actualTree: observedTree,
      pushed: false,
      closed: false,
    }));
  }
  let committedFiles: string[] = [];
  if (worktreeHead !== sourceHead) {
    if (!(await isAncestor(canonicalWorktreePath, sourceHead, worktreeHead, { runCommand, env: worktreeGitEnv }))) {
      // Source HEAD advanced since the worktree branched — likely a parallel finalize.
      // Find the merge-base (= the commit the worktree was branched from) and
      // run file-level conflict detection for actionable diagnostics.
      const mbResult = await runGit(canonicalSourcePath, ["merge-base", sourceHead, worktreeHead], {
        allowFailure: true,
        runCommand,
        env: sourceGitEnv,
      });
      if (mbResult.exitCode === 0) {
        const baseCommit = mbResult.stdout.trim();
        const worktreeFiles = [
          ...uncommittedFiles,
          ...(await diffFiles(canonicalWorktreePath, baseCommit, worktreeHead, {
            runCommand,
            env: worktreeGitEnv,
          }).catch((): string[] => [])),
        ];
        const conflictInfo = await detectParallelConflict(
          canonicalSourcePath,
          baseCommit,
          worktreeFiles,
          { runCommand, env: sourceGitEnv },
        ).catch((): null => null);

        if (conflictInfo?.sourceAdvanced) {
          if (cpbRoot && projectId) {
            await appendEvent(cpbRoot, projectId, jobId, {
              type: "parallel_finalize_conflict",
              jobId,
              project: projectId,
              conflict: conflictInfo.conflict,
              originalSourceHead: baseCommit,
              currentSourceHead: conflictInfo.currentHead,
              overlappingFiles: conflictInfo.overlappingFiles,
              interveningFiles: conflictInfo.interveningFiles,
              ts: new Date().toISOString(),
            }, { dataRoot }).catch(() => {});
          }
          return recordAndReturn(reject(conflictInfo.conflict ? "PARALLEL_FILE_CONFLICT" : "SOURCE_ADVANCED_NO_CONFLICT", {
            issue,
            jobId,
            originalSourceHead: baseCommit,
            currentSourceHead: conflictInfo.currentHead,
            overlappingFiles: conflictInfo.overlappingFiles,
            interveningFiles: conflictInfo.interveningFiles,
            retryable: true,
          }));
        }
      }

      return recordAndReturn(reject("WORKTREE_NOT_DESCENDANT", {
        issue,
        jobId,
        sourceHead,
        worktreeHead,
      }));
    }
    committedFiles = await diffFiles(canonicalWorktreePath, sourceHead, worktreeHead, {
      runCommand,
      env: worktreeGitEnv,
    });
  }

  const files = [...new Set([...committedFiles, ...uncommittedFiles])];
  const auditedFiles = await diffFiles(canonicalWorktreePath, sourceHead, auditedTree, {
    runCommand,
    env: worktreeGitEnv,
  });
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...auditedFiles].sort())) {
    return recordAndReturn(blocked("AUDITED_TREE_FILESET_MISMATCH", {
      issue,
      jobId,
      mode,
      committed: false,
      files: [...files].sort(),
      auditedFiles: [...auditedFiles].sort(),
      auditedTree,
    }));
  }
  if (files.length === 0) {
    return recordAndReturn(skipped("NO_CHANGES", { issue, jobId }));
  }

  const summary = summarizeMergeFiles(files);
  if (hasUnsafeChanges(summary)) {
    return recordAndReturn(reject("UNSAFE_WORKTREE_CHANGES", {
      issue,
      jobId,
      files: summary.entries,
      unsafeFiles: unsafeFiles(summary),
    }));
  }

  const routeGuard = protectedDiffForRoute(files, entry, job);
  if (routeGuard.blocked) {
    if (dryRun) {
      return recordAndReturn(reject("ROUTE_PROTECTED_DIFF", {
        issue,
        jobId,
        mode,
        dryRun: true,
        files: summary.entries,
        protectedDiff: routeGuard.protectedDiff,
        originalRoute: routeGuard.route,
        requeuedQueueEntryId: null,
        requeuedWorkflow: routeGuard.guardResult?.escalation?.workflow || "complex",
        requeuedPlanMode: routeGuard.guardResult?.escalation?.planMode || "full",
      }));
    }
    const upgraded = await requeueProtectedDiffUpgrade({
      hubRoot,
      entry,
      job,
      projectId,
      sourcePath: canonicalSourcePath,
      issue,
      jobId,
      route: routeGuard.route,
      protectedDiff: routeGuard.protectedDiff,
      guardResult: routeGuard.guardResult,
    });
    if (cpbRoot && projectId) {
      await appendEvent(cpbRoot, projectId, jobId, {
        type: "finalizer_route_guard",
        jobId,
        project: projectId,
        issue,
        originalRoute: routeGuard.route,
        protectedDiff: routeGuard.protectedDiff,
        guardResult: routeGuard.guardResult,
        requeuedQueueEntryId: upgraded?.id || null,
        action: upgraded ? `requeued_${routeGuard.guardResult.escalation?.workflow || "complex"}_${routeGuard.guardResult.escalation?.planMode || "full"}` : "rejected_no_requeue",
        ts: new Date().toISOString(),
      }, { dataRoot });
    }
    return recordAndReturn(reject("ROUTE_PROTECTED_DIFF", {
      issue,
      jobId,
      files: summary.entries,
      protectedDiff: routeGuard.protectedDiff,
      originalRoute: routeGuard.route,
      requeuedQueueEntryId: upgraded?.id || null,
      requeuedWorkflow: upgraded?.metadata?.workflow || "complex",
      requeuedPlanMode: upgraded?.metadata?.planMode || "full",
    }));
  }

  const planned = {
    commit: !dryRun && uncommittedFiles.length > 0,
    merge: !dryRun && (mode === "local" || mode === "remote"),
    push: !dryRun && (mode === "remote" || mode === "pr"),
    closeIssue: !dryRun && mode === "remote",
    pullRequest: !dryRun && mode === "pr",
    pullRequestPreview: dryRun,
  };

  const assertLiveMutationLease = async (
    operation: string,
    commitIdentity: string | null,
    treeIdentity: string | null,
    intent: FinalizerJournalRecord | null = journalSnapshot?.record || null,
  ) => {
    if (!liveMutationMode || !assertMutationLease) return;
    const allowed = await assertMutationLease({
      operation,
      phase: "before-write",
      mode,
      project: projectId,
      entryId: stableEntryId,
      originJobId: jobId,
      jobId,
      finalizationId: intent?.finalizationId || null,
      generation: intent?.generation || null,
      repository: remoteCapability?.repository || null,
      issueNumber: remoteCapability?.issueNumber || null,
      commit: commitIdentity,
      tree: treeIdentity,
    });
    if (allowed === false) {
      throw Object.assign(new Error("finalizer mutation lease was rejected"), {
        code: "MUTATION_LEASE_LOST",
        committed: false,
        retryable: true,
      });
    }
  };

  const initializeLiveJournal = async (
    commitIdentity: string,
    targetBranch: string,
    preRemoteHead: string | null,
    initialReceipts: FinalizerRecord = {},
  ) => {
    if (!liveRemoteMode || !cpbRoot || !projectId || !stableEntryId || !dataRoot
      || !remoteCapability || !transportPrincipal || !ownerDigest || !assertMutationLease) return null;
    const finalizationId = finalizerJournalFinalizationId({
      project: projectId,
      entryId: stableEntryId,
      originJobId: jobId,
      mode: mode as "remote" | "pr",
      repository: remoteCapability.repository,
      issueNumber: remoteCapability.issueNumber,
      capabilityDigest: finalizerCapabilityDigest(remoteCapability),
      principal: transportPrincipal,
      source: { branch: sourceBranch, head: sourceHead.toLowerCase() },
      commit: commitIdentity.toLowerCase(),
      tree: auditedTree.toLowerCase(),
      preRemoteHead: preRemoteHead?.toLowerCase() || null,
      targetBranch,
    });
    await assertLiveMutationLease("journal.intent", commitIdentity, auditedTree, null);
    const capsule = await persistFinalizerCapsule({
      worktree: canonicalWorktreePath,
      dataRoot,
      finalizationId,
      commit: commitIdentity.toLowerCase(),
      tree: auditedTree.toLowerCase(),
      runCommand,
      env: worktreeGitEnv,
    });
    let snapshot = await readFinalizerJournal(cpbRoot, projectId, stableEntryId, { dataRoot });
    if (snapshot.invalidReason) throw Object.assign(new Error(snapshot.invalidReason), {
      code: "FINALIZER_JOURNAL_INVALID",
      committed: null,
    });
    if (!snapshot.record) {
      const initial: FinalizerJournalRecord = {
        schema: FINALIZER_MUTATION_RECEIPT_SCHEMA,
        finalizationId,
        generation: 1,
        project: projectId,
        entryId: stableEntryId,
        originJobId: jobId,
        mode: mode as "remote" | "pr",
        stage: "claimed",
        repository: remoteCapability.repository,
        issueNumber: remoteCapability.issueNumber,
        capabilityDigest: finalizerCapabilityDigest(remoteCapability),
        principal: transportPrincipal,
        claim: {
          claimId: finalizerJournalClaimId({ finalizationId, ownerDigest, claimGeneration: 1 }),
          claimGeneration: 1,
          ownerDigest,
        },
        source: {
          branch: sourceBranch,
          head: sourceHead.toLowerCase(),
        },
        capsule,
        commit: commitIdentity.toLowerCase(),
        tree: auditedTree.toLowerCase(),
        preRemoteHead: preRemoteHead?.toLowerCase() || null,
        targetBranch,
        receipts: initialReceipts,
      };
      const expectedDigest = finalizerJournalDigest(initial);
      snapshot = await appendFinalizerJournal(cpbRoot, projectId, stableEntryId, initial, {
        dataRoot,
        expected: snapshot,
        assertMutationLease,
        leaseContext: { mode, jobId },
      });
      if (!snapshot.record || finalizerJournalDigest(snapshot.record) !== expectedDigest) {
        throw Object.assign(new Error("finalizer journal initial claim CAS lost"), {
          code: "MUTATION_CLAIM_LOST",
          committed: null,
          retryable: true,
        });
      }
    } else {
      const expectedBinding = {
        finalizationId,
        project: projectId,
        entryId: stableEntryId,
        originJobId: jobId,
        mode,
        repository: remoteCapability.repository,
        issueNumber: remoteCapability.issueNumber,
        capabilityDigest: finalizerCapabilityDigest(remoteCapability),
        principal: transportPrincipal,
        source: { branch: sourceBranch, head: sourceHead.toLowerCase() },
        capsule,
        commit: commitIdentity.toLowerCase(),
        tree: auditedTree.toLowerCase(),
        preRemoteHead: preRemoteHead?.toLowerCase() || null,
        targetBranch,
      };
      const actualBinding = {
        finalizationId: snapshot.record.finalizationId,
        project: snapshot.record.project,
        entryId: snapshot.record.entryId,
        originJobId: snapshot.record.originJobId,
        mode: snapshot.record.mode,
        repository: snapshot.record.repository,
        issueNumber: snapshot.record.issueNumber,
        capabilityDigest: snapshot.record.capabilityDigest,
        principal: snapshot.record.principal,
        source: snapshot.record.source,
        capsule: snapshot.record.capsule,
        commit: snapshot.record.commit,
        tree: snapshot.record.tree,
        preRemoteHead: snapshot.record.preRemoteHead,
        targetBranch: snapshot.record.targetBranch,
      };
      if (finalizerJournalDigest(actualBinding) !== finalizerJournalDigest(expectedBinding)) {
        throw Object.assign(new Error("finalizer journal binding does not match this candidate generation"), {
          code: "REMOTE_INTENT_BINDING_MISMATCH",
          committed: null,
        });
      }
      const activeClaim = finalizerRecord(snapshot.record.claim);
      if (activeClaim.ownerDigest !== ownerDigest) {
        const takeover = finalizerRecord(mutationFence?.takeover);
        if (
          !["owner-dead", "explicit-handoff"].includes(String(takeover.kind || ""))
          || takeover.previousClaimId !== activeClaim.claimId
          || typeof takeover.evidenceId !== "string" || !/^[0-9a-f]{64}$/.test(takeover.evidenceId)
          || typeof takeover.observedAt !== "string"
          || !Number.isFinite(Date.parse(takeover.observedAt))
          || new Date(Date.parse(takeover.observedAt)).toISOString() !== takeover.observedAt
        ) {
          throw Object.assign(new Error("finalizer journal is owned by another process incarnation"), {
            code: "MUTATION_CLAIM_HELD",
            committed: null,
            retryable: true,
          });
        }
        const claimGeneration = Number(activeClaim.claimGeneration) + 1;
        const next = nextJournalRecord(snapshot, snapshot.record.stage, {
          claim: {
            claimId: finalizerJournalClaimId({ finalizationId, ownerDigest, claimGeneration }),
            claimGeneration,
            ownerDigest,
            takeover: {
              kind: takeover.kind,
              previousClaimId: activeClaim.claimId,
              evidenceId: takeover.evidenceId,
              observedAt: takeover.observedAt,
            },
          },
        });
        const expectedDigest = finalizerJournalDigest(next);
        snapshot = await appendFinalizerJournal(cpbRoot, projectId, stableEntryId, next, {
          dataRoot,
          expected: snapshot,
          assertMutationLease,
          leaseContext: { mode, jobId },
        });
        if (!snapshot.record || finalizerJournalDigest(snapshot.record) !== expectedDigest) {
          throw Object.assign(new Error("finalizer journal takeover claim CAS lost"), {
            code: "MUTATION_CLAIM_LOST",
            committed: null,
            retryable: true,
          });
        }
      }
    }
    journalSnapshot = snapshot;
    return snapshot;
  };

  const advanceLiveJournal = async (
    stage: FinalizerJournalStage,
    receiptUpdates: FinalizerRecord = {},
  ) => {
    if (!journalSnapshot || !cpbRoot || !projectId || !stableEntryId || !dataRoot || !assertMutationLease) {
      throw Object.assign(new Error("finalizer journal is unavailable"), {
        code: "FINALIZER_JOURNAL_REQUIRED",
        committed: null,
      });
    }
    const next = nextJournalRecord(journalSnapshot, stage, {
      receipts: receiptUpdates,
    });
    const expectedDigest = finalizerJournalDigest(next);
    const observed = await appendFinalizerJournal(cpbRoot, projectId, stableEntryId, next, {
      dataRoot,
      expected: journalSnapshot,
      assertMutationLease,
      leaseContext: { mode, jobId },
    });
    if (!observed.record || finalizerJournalDigest(observed.record) !== expectedDigest) {
      throw Object.assign(new Error("finalizer journal CAS was lost"), {
        code: "FINALIZER_JOURNAL_CONFLICT",
        committed: null,
        retryable: true,
      });
    }
    journalSnapshot = observed;
    return observed.record;
  };

  if (mode === "pr" || mode === "dry-run") {
    const jobRecord = finalizerRecord(job);
    if (!cpbRoot || !projectId || !jobRecord.jobId) {
      return recordAndReturn(reject("PR_FINALIZE_REQUIRES_JOB_STORE", { issue, jobId }));
    }
    const jobSourceContext = finalizerRecord(jobRecord.sourceContext);
    const prJob = {
      ...jobRecord,
      worktree: canonicalWorktreePath,
      worktreeBranch: jobRecord.worktreeBranch || worktreeBranch,
      worktreeBaseBranch: jobRecord.worktreeBaseBranch || sourceBranch,
      commit: worktreeHead,
      auditedCommit: worktreeHead,
      auditedTree,
      sourceContext: {
        ...jobSourceContext,
        type: "github_issue",
        repo: issue.repo,
        issueNumber: issue.number,
        issueTitle: jobSourceContext.issueTitle || entry?.metadata?.issueTitle || job.task || null,
        remoteCapability,
      },
    };
    const agents = await resolveAgentsFromEvents(cpbRoot, projectId, job.jobId, { dataRoot });
    let prEvidence: FinalizerRecord = {};
    let prVerdict: FinalizerRecord = {};
    try {
      const bundle = finalizerRecord(await buildReviewBundle(cpbRoot, projectId, job.jobId, {
        entry,
        job: prJob,
        sourcePath: canonicalSourcePath,
        worktreePath: canonicalWorktreePath,
        dataRoot,
      }));
      prVerdict = derivePrVerdictFromBundle(bundle);
      if (!prVerdict.ok) {
        return recordAndReturn(blocked(String(prVerdict.code || "PR_EVIDENCE_BLOCKED"), {
          issue,
          jobId,
          mode,
          completionGate: prVerdict.completionGate || null,
          verdict: prVerdict.verdict || null,
        }));
      }
      prEvidence = buildPrEvidenceFromReviewBundle(bundle, { cpbRoot, dataRoot, hubRoot });
    } catch {
      return recordAndReturn(blocked("PR_EVIDENCE_UNAVAILABLE", {
        issue,
        jobId,
        mode,
      }));
    }
    const prVerdictDetail = isFinalizerRecord(prVerdict.verdictDetail) ? prVerdict.verdictDetail : null;
    const evidenceVerdictDetail = isFinalizerRecord(prEvidence.verdictDetail) ? prEvidence.verdictDetail : null;
    const prOptions: DraftPullRequestOptions = {};
    Object.assign(prOptions, prEvidence);
    Object.assign(prOptions, {
      job: prJob,
      verdict: prVerdict.verdict,
      branchPushed: false,
      dryRun,
      allowLive: liveAllowed,
      createPullRequest,
      runCommand,
      pushToken,
      agents,
      routingContext: buildRoutingContext(entry, job, routeGuard),
      verdictDetail: prVerdictDetail || evidenceVerdictDetail,
      completionGate: prVerdict.completionGate || null,
    });
    if (!dryRun) {
      try {
        const preview = await openDraftPullRequest({
          ...prOptions,
          dryRun: true,
          allowLive: false,
          createPullRequest: undefined,
        });
        const prPlan = finalizerRecord(preview.request);
        if (preview.status !== "dry-run" || !prPlan.repo || !prPlan.head || !prPlan.base
          || typeof prPlan.title !== "string" || !prPlan.title || prPlan.title.length > 256
          || typeof prPlan.body !== "string" || prPlan.body.length > 65_536
          || prPlan.body.includes("\u0000") || prPlan.draft !== true) {
          throw Object.assign(new Error("PR recovery plan could not be frozen before finalization"), {
            code: "PR_CREATE_PLAN_MISSING",
            committed: false,
          });
        }
        const frozenPrPlan = { ...prPlan, eventJobId: jobId };
        if (finalizerJournalDigest(redactSecrets(frozenPrPlan)) !== finalizerJournalDigest(frozenPrPlan)) {
          throw Object.assign(new Error("PR recovery plan contains secret-like data and cannot be journaled exactly"), {
            code: "PR_CREATE_PLAN_SECRET_REJECTED",
            committed: false,
          });
        }
        const initialized = await initializeLiveJournal(
          worktreeHead.toLowerCase(),
          String(prJob.worktreeBranch),
          null,
          { prPlan: frozenPrPlan },
        );
        if (!initialized?.record || initialized.record.stage !== "claimed") {
          return recordAndReturn(blocked("REMOTE_RECONCILIATION_REQUIRED", {
            issue,
            jobId,
            mode,
            committed: null,
            retryable: true,
            remoteIntent: initialized?.record || null,
          }));
        }
      } catch (error) {
        const details = finalizerRecord(error);
        return recordAndReturn(blocked(String(details.code || "REMOTE_INTENT_JOURNAL_FAILED"), {
          issue,
          jobId,
          mode,
          committed: details.committed === false ? false : null,
          retryable: details.retryable !== false,
          remoteIntent: journalSnapshot?.record || null,
          error: redactFinalizerRemoteText(commandErrorMessage(error), [pushToken]),
        }));
      }
    }
    Object.assign(prOptions, {
      remoteCapability,
      remoteAuthorityValidator,
      remoteCommitVerifier,
      beforeRemoteMutation: dryRun ? null : async (operation: string, request: LooseRecord) => {
        if (operation === "pull_request.push") {
          if (journalSnapshot?.record?.stage !== "claimed") {
            throw Object.assign(new Error("PR branch push intent is already ambiguous"), { committed: null });
          }
          const branchPushIntent = finalizerRecord(redactSecrets(request));
          branchPushIntent.pullRequestPlan = finalizerRecord(journalSnapshot.record.receipts.prPlan);
          await advanceLiveJournal("pull_request.push.intent", { branchPushIntent });
          await assertLiveMutationLease("pull_request.push", worktreeHead, auditedTree);
          return;
        }
        if (operation === "pull_request.create") {
          if (journalSnapshot?.record?.stage !== "pull_request.push.receipt") {
            throw Object.assign(new Error("PR creation cannot start without a durable branch receipt"), { committed: null });
          }
          await advanceLiveJournal("pull_request.create.intent", {
            pullRequestCreateIntent: finalizerRecord(redactSecrets(request)),
          });
          await assertLiveMutationLease("pull_request.create", worktreeHead, auditedTree);
        }
      },
      afterRemoteMutation: dryRun ? null : async (operation: string, details: LooseRecord) => {
        if (operation === "pull_request.push") {
          try {
            await advanceLiveJournal("pull_request.push.receipt", {
              branchPush: operationReceipt("pull_request.push", {
                repository: journalSnapshot?.record?.repository,
                issueNumber: journalSnapshot?.record?.issueNumber,
                commit: journalSnapshot?.record?.commit,
                tree: journalSnapshot?.record?.tree,
                targetBranch: journalSnapshot?.record?.targetBranch,
                preRemoteHead: journalSnapshot?.record?.preRemoteHead,
                verification: redactFinalizerRemoteValue(details.verification, [pushToken]),
              }),
            });
          } catch (error) {
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
              committed: true,
              attempted: true,
              operation: "pull_request.push",
            });
          }
          return;
        }
        if (operation === "pull_request.create") {
          try {
            const prUrl = typeof details.prUrl === "string" ? details.prUrl : "";
            const prNumber = typeof details.prNumber === "number" ? details.prNumber : Number(details.prNumber);
            if (!prUrl || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
              throw new Error("pull request result identity is invalid");
            }
            const createIntent = finalizerRecord(journalSnapshot?.record?.receipts.pullRequestCreateIntent);
            await advanceLiveJournal("pull_request.create.receipt", {
              pullRequestCreate: operationReceipt("pull_request.create", {
                repository: journalSnapshot?.record?.repository,
                issueNumber: journalSnapshot?.record?.issueNumber,
                commit: journalSnapshot?.record?.commit,
                headBranch: createIntent.headBranch,
                baseBranch: createIntent.baseBranch,
                title: createIntent.title,
                body: createIntent.body,
                draft: createIntent.draft,
                authorLogin: createIntent.authorLogin,
                authorId: createIntent.authorId,
                prUrl,
                prNumber,
                verification: redactFinalizerRemoteValue(details.verification, [pushToken]),
              }),
            });
          } catch (error) {
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
              committed: true,
              attempted: true,
              operation: "pull_request.create",
              operationResult: {
                url: details.prUrl,
                number: details.prNumber,
              },
            });
          }
        }
      },
    });
    const pr = await openDraftPullRequest(prOptions);
    if (dryRun) {
      if (pr.status !== "dry-run") {
        return recordAndReturn(blocked("PR_DRY_RUN_FAILED", {
          issue,
          jobId,
          mode,
          pr,
          error: pr.error || null,
        }));
      }
      return recordAndReturn({
        ok: true,
        status: "dry-run",
        issue,
        mode,
        sourcePath: canonicalSourcePath,
        worktreePath: canonicalWorktreePath,
        sourceBranch,
        worktreeBranch,
        sourceHead,
        worktreeHead,
        files: summary.entries,
        planned,
        completionGate: prVerdict.completionGate || null,
        verdict: prVerdictDetail,
        pr,
      });
    }
    if (pr.status !== "pr.opened") {
      const receipts = finalizerRecord(journalSnapshot?.record?.receipts);
      const branchReceipt = journalCommittedReceipt(receipts, "branchPush", "pull_request.push");
      const createReceipt = journalCommittedReceipt(receipts, "pullRequestCreate", "pull_request.create");
      const prEvidence = finalizerRecord(pr.evidence);
      const prRemoteWrites = finalizerRecord(pr.remoteWrites);
      const prCreateWrite = finalizerRecord(prRemoteWrites.pullRequestCreate);
      const committed = branchReceipt || createReceipt || prCreateWrite.committed === true
        ? true
        : prEvidence.committed === false && prCreateWrite.committed !== null
          ? false
          : null;
      const failure = committed === false ? reject : blocked;
      return recordAndReturn(failure("PR_FINALIZE_FAILED", {
        issue,
        jobId,
        mode,
        committed,
        pushed: branchReceipt ? true : committed === false ? false : null,
        closed: false,
        retryable: true,
        remoteIntent: journalSnapshot?.record || null,
        remoteWrites: {
          branchPush: {
            attempted: Boolean(branchReceipt) || journalSnapshot?.record?.stage !== "claimed",
            committed: branchReceipt ? true : committed === false ? false : null,
            verification: branchReceipt?.verification || null,
          },
          pullRequestCreate: {
            ...prCreateWrite,
            attempted: prCreateWrite.attempted === true
              || Boolean(createReceipt)
              || journalSnapshot?.record?.stage === "pull_request.create.intent"
              || journalSnapshot?.record?.stage === "pull_request.create.receipt",
            committed: createReceipt ? true : prCreateWrite.committed ?? (committed === false ? false : null),
            verification: createReceipt?.verification || prCreateWrite.verification || null,
          },
        },
        principal: transportPrincipal,
        commit: journalSnapshot?.record?.commit || worktreeHead,
        tree: auditedTree,
        pr,
        error: pr.error || null,
      }));
    }

    const commit = pr.branchPreparation?.commit || worktreeHead;
    const remoteWrites = {
      branchPush: {
        attempted: true,
        committed: true,
        verification: pr.branchPreparation?.verification || null,
      },
      pullRequestCreate: {
        ...finalizerRecord(finalizerRecord(pr.remoteWrites).pullRequestCreate),
        attempted: true,
        committed: true,
      },
    };
    let prEventRecorded = false;
    try {
      if (journalSnapshot?.record?.stage !== "pull_request.create.receipt") {
        throw Object.assign(new Error("PR create receipt was not durably journaled"), {
          code: "PR_CREATE_RECEIPT_MISSING",
          committed: true,
        });
      }
      const finalizationId = journalSnapshot.record!.finalizationId;
      const prEventId = finalizerJournalPrEventId(finalizationId);
      await advanceLiveJournal("pr_opened.publish.intent", {
        prEventIntent: {
          jobId: job.jobId,
          prUrl: pr.prUrl,
          prNumber: pr.prNumber,
          eventId: prEventId,
        },
      });
      await assertLiveMutationLease("pr_opened.publish", commit, auditedTree);
      const recordedEvent = await appendEvent(cpbRoot, projectId, job.jobId, {
        type: "pr_opened",
        jobId: job.jobId,
        project: projectId,
        prUrl: pr.prUrl,
        prNumber: pr.prNumber,
        artifact: pr.request?.body ? { type: "github_pr", url: pr.prUrl, number: pr.prNumber } : null,
        transportMode: transportMode || null,
        transportFallback: transportMode === "gh",
        finalizationId,
        eventId: prEventId,
        ts: new Date().toISOString(),
      }, { dataRoot });
      if (!recordedEvent) {
        throw Object.assign(new Error("pr_opened event was not persisted"), {
          code: "PR_OPENED_EVENT_NOT_PERSISTED",
        });
      }
      const persistedEvents = await readEvents(cpbRoot, projectId, job.jobId, { dataRoot });
      const sameEventId = persistedEvents.filter((event) => event.type === "pr_opened" && event.eventId === prEventId);
      const exactEvents = sameEventId.filter((event) => event.project === projectId
        && event.jobId === job.jobId
        && event.finalizationId === finalizationId
        && event.prUrl === pr.prUrl
        && event.prNumber === pr.prNumber);
      if (exactEvents.length === 0 || exactEvents.length !== sameEventId.length) {
        throw Object.assign(new Error("pr_opened event readback did not match its exact bound identity"), {
          code: "PR_OPENED_EVENT_READBACK_MISMATCH",
          committed: true,
        });
      }
      const eventStreamCursor = eventStreamCursorForRecords(persistedEvents);
      const eventRecordDigest = finalizerJournalDigest({
        type: "pr_opened",
        project: projectId,
        jobId: job.jobId,
        finalizationId,
        eventId: prEventId,
        prUrl: pr.prUrl,
        prNumber: pr.prNumber,
      });
      prEventRecorded = true;
      await advanceLiveJournal("pr_opened.publish.receipt", {
        prEvent: operationReceipt("pr_opened.publish", {
          prUrl: pr.prUrl,
          prNumber: pr.prNumber,
          jobId: job.jobId,
          finalizationId,
          eventId: prEventId,
          eventRecordDigest,
          eventStreamCursor,
        }),
      });
      await advanceLiveJournal("event.complete");
    } catch (err) {
      return recordAndReturn(blocked("PR_EVENT_RECORD_FAILED", {
        issue,
        jobId,
        mode,
        commit,
        sourcePath: canonicalSourcePath,
        worktreePath: canonicalWorktreePath,
        sourceBranch,
        worktreeBranch: pr.request?.head || prJob.worktreeBranch,
        sourceHead,
        files: summary.entries,
        pushed: true,
        closed: false,
        committed: true,
        prUrl: pr.prUrl,
        prNumber: pr.prNumber,
        pr,
        remoteWrites,
        tree: auditedTree,
        principal: transportPrincipal,
        remoteIntent: journalSnapshot?.record || null,
        eventRecorded: prEventRecorded,
        retryable: true,
        error: {
          message: redactFinalizerRemoteText(commandErrorMessage(err), [pushToken]),
          code: redactFinalizerRemoteText(finalizerRecord(err).code || "", [pushToken]) || null,
        },
      }));
    }

    return recordAndReturn({
      ok: true,
      status: "pr.opened",
      mode,
      issue,
      jobId,
      commit,
      tree: auditedTree,
      sourcePath: canonicalSourcePath,
      worktreePath: canonicalWorktreePath,
      sourceBranch,
      worktreeBranch: pr.request?.head || prJob.worktreeBranch,
      sourceHead,
      files: summary.entries,
      pushed: true,
      closed: false,
      prUrl: pr.prUrl,
      prNumber: pr.prNumber,
      pr,
      committed: true,
      remoteWrites,
      eventRecorded: true,
      principal: transportPrincipal,
      remoteIntent: journalSnapshot?.record || null,
    });
  }

  let commit = worktreeHead;
  const currentTree = await captureWorktreeTree(canonicalWorktreePath, { runCommand, env: worktreeGitEnv });
  if (currentTree !== auditedTree) {
    return recordAndReturn(blocked("WORKTREE_CHANGED_AFTER_AUDIT", {
      issue,
      jobId,
      mode,
      commit: worktreeHead,
      auditedTree,
      actualTree: currentTree,
      pushed: false,
      closed: false,
      committed: false,
      remoteWrites: {
        push: { attempted: false, committed: false },
        issueClose: { attempted: false, committed: false },
      },
    }));
  }
  if (uncommittedFiles.length > 0) {
    await assertLiveMutationLease("source.commit", worktreeHead, auditedTree);
    commit = await commitFrozenTree(
      canonicalWorktreePath,
      auditedTree,
      worktreeHead,
      commitMessage({ jobId, issueNumber: issue.number }),
      {
        runCommand,
        env: worktreeGitEnv,
        beforeUpdateRef: () => assertLiveMutationLease("source.commit", worktreeHead, auditedTree),
      },
    );
  } else {
    const headTree = await revParse(canonicalWorktreePath, "HEAD^{tree}", { runCommand, env: worktreeGitEnv });
    if (headTree !== auditedTree) {
      return recordAndReturn(blocked("WORKTREE_CHANGED_AFTER_AUDIT", {
        issue,
        jobId,
        mode,
        commit: worktreeHead,
        auditedTree,
        actualTree: headTree,
        pushed: false,
        closed: false,
        committed: false,
      }));
    }
  }

  if (mode === "remote") {
    try {
      const initialized = await initializeLiveJournal(commit.toLowerCase(), sourceBranch, sourceHead.toLowerCase());
      if (!initialized?.record || initialized.record.stage !== "claimed") {
        return recordAndReturn(blocked("REMOTE_RECONCILIATION_REQUIRED", {
          issue,
          jobId,
          mode,
          commit,
          tree: auditedTree,
          committed: null,
          pushed: null,
          closed: null,
          retryable: true,
          remoteIntent: initialized?.record || null,
        }));
      }
    } catch (error) {
      const details = finalizerRecord(error);
      return recordAndReturn(blocked(String(details.code || "REMOTE_INTENT_JOURNAL_FAILED"), {
        issue,
        jobId,
        mode,
        commit,
        tree: auditedTree,
        committed: details.committed === false ? false : null,
        pushed: false,
        closed: false,
        retryable: details.retryable !== false,
        remoteIntent: journalSnapshot?.record || null,
        error: redactFinalizerRemoteText(commandErrorMessage(error), [pushToken]),
      }));
    }
  }

  let pushed: boolean | null = false;
  let closed: boolean | null = false;
  let pushVerification: Awaited<ReturnType<GithubRemoteCommitVerifier>> | null = null;
  let closeVerification: Awaited<ReturnType<GithubRemoteCommitVerifier>> | null = null;
  let closeTransportWarning: FinalizerRecord | null = null;
  let sourceSync: FinalizerRecord | null = null;
  if (mode === "remote") {
    if (!remoteCapability || !remoteAuthorityValidator || !remoteCommitVerifier) {
      return recordAndReturn(blocked("REMOTE_CAPABILITY_MISSING", {
        issue,
        mode,
        jobId,
        commit,
        pushed: false,
        closed: false,
        committed: false,
      }));
    }
    if (!issueCloser) {
      return recordAndReturn(reject("REMOTE_ISSUE_CLOSER_MISSING", {
        issue,
        jobId,
        commit,
        pushed: false,
        closed: false,
        committed: false,
      }));
    }
    let remoteOperation: "repository.push" | "issue.close" = "repository.push";
    let operationAttempted = false;
    try {
      const pushAuthorityRequest: GithubRemoteAuthorityRequest = {
        capability: remoteCapability,
        operation: "repository.push",
        repository: issue.repo,
        issueNumber: issue.number,
        targetBranch: sourceBranch,
        pushKind: "default-branch",
        commit,
      };
      pushVerification = await pushGithubCommitWithControlledTransport({
        worktree: canonicalWorktreePath,
        repository: remoteCapability.repository,
        commit,
        expectedTree: auditedTree,
        expectedRemoteHead: sourceHead,
        targetBranch: sourceBranch,
        token: pushToken,
        runCommand,
        authorize: () => remoteAuthorityValidator(pushAuthorityRequest),
        verify: () => remoteCommitVerifier(pushAuthorityRequest),
        beforeAttempt: async () => {
          if (journalSnapshot?.record?.stage !== "claimed") {
            throw Object.assign(new Error("repository push intent is already ambiguous"), {
              committed: null,
              attempted: false,
            });
          }
          await advanceLiveJournal("repository.push.intent");
          await assertLiveMutationLease("repository.push", commit, auditedTree);
          operationAttempted = true;
        },
        afterCommitted: async (verification) => {
          try {
            await advanceLiveJournal("repository.push.receipt", {
              push: operationReceipt("repository.push", {
                repository: journalSnapshot?.record?.repository,
                issueNumber: journalSnapshot?.record?.issueNumber,
                commit: journalSnapshot?.record?.commit,
                tree: journalSnapshot?.record?.tree,
                targetBranch: journalSnapshot?.record?.targetBranch,
                preRemoteHead: journalSnapshot?.record?.preRemoteHead,
                verification: redactFinalizerRemoteValue(verification, [pushToken]),
              }),
            });
          } catch (error) {
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
              committed: true,
              attempted: true,
              operation: "repository.push",
            });
          }
        },
      });
      pushed = pushVerification.committed;
      if (pushed !== true) {
        return recordAndReturn(reject("REMOTE_PUSH_UNCONFIRMED", {
          issue,
          jobId,
          mode,
          commit,
          tree: auditedTree,
          pushed,
          closed: false,
          committed: pushed,
          verification: pushVerification,
          principal: transportPrincipal,
          remoteIntent: journalSnapshot?.record || null,
          retryable: true,
          remoteWrites: {
            push: { attempted: true, committed: pushed, verification: pushVerification },
            issueClose: { attempted: false, committed: false },
          },
        }));
      }

      remoteOperation = "issue.close";
      operationAttempted = false;
      const closeAuthorityRequest: GithubRemoteAuthorityRequest = {
        capability: remoteCapability,
        operation: "issue.close",
        repository: issue.repo,
        issueNumber: issue.number,
        commit,
      };
      await remoteAuthorityValidator(closeAuthorityRequest);
      if (journalSnapshot?.record?.stage !== "repository.push.receipt") {
        throw Object.assign(new Error("issue close cannot start without a durable push receipt"), {
          committed: null,
          attempted: false,
        });
      }
      await advanceLiveJournal("issue.close.intent");
      await assertLiveMutationLease("issue.close", commit, auditedTree);
      operationAttempted = true;
      let closeResponse: FinalizerRecord = {};
      try {
        closeResponse = finalizerRecord(await issueCloser({
          repo: issue.repo,
          number: issue.number,
          url: issue.url,
          jobId,
          commit,
        }));
        if (closeResponse.ok === false) {
          closeTransportWarning = {
            message: "issue close transport returned ok=false; remote state readback is authoritative",
            response: boundedCloseTransportResponse(closeResponse, [pushToken]),
          };
        }
      } catch (error) {
        closeTransportWarning = {
          message: redactFinalizerRemoteText(commandErrorMessage(error), [pushToken]),
          code: redactFinalizerRemoteText(finalizerRecord(error).code || "", [pushToken]) || null,
        };
      }
      closeVerification = await remoteCommitVerifier(closeAuthorityRequest);
      closed = closeVerification.committed;
      if (closed !== true) {
        return recordAndReturn(blocked(closeResponse.ok === false
          ? "REMOTE_ISSUE_CLOSE_REJECTED"
          : "REMOTE_ISSUE_CLOSE_UNCONFIRMED", {
          issue,
          jobId,
          mode,
          commit,
          tree: auditedTree,
          pushed,
          closed,
          committed: pushed === true ? true : closed,
          verification: closeVerification,
          principal: transportPrincipal,
          remoteIntent: journalSnapshot?.record || null,
          retryable: true,
          remoteWrites: {
            push: { attempted: true, committed: pushed, verification: pushVerification },
            issueClose: {
              attempted: true,
              committed: closed,
              verification: closeVerification,
              ...(closeTransportWarning ? { transportWarning: closeTransportWarning } : {}),
            },
          },
        }));
      }
      try {
        await advanceLiveJournal("issue.close.receipt", {
          issueClose: operationReceipt("issue.close", {
            repository: journalSnapshot?.record?.repository,
            issueNumber: journalSnapshot?.record?.issueNumber,
            commit: journalSnapshot?.record?.commit,
            verification: redactFinalizerRemoteValue(closeVerification, [pushToken]),
            ...(closeTransportWarning ? { transportWarning: closeTransportWarning } : {}),
          }),
        });
        await advanceLiveJournal("remote.complete");
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          committed: true,
          attempted: true,
          operation: "issue.close",
        });
      }
    } catch (err) {
      const errorRecord = finalizerRecord(err);
      const rawOperationCommitted = errorRecord.committed;
      const rawOperationAttempted = errorRecord.attempted;
      const effectiveOperationAttempted = typeof rawOperationAttempted === "boolean"
        ? rawOperationAttempted
        : operationAttempted;
      let operationCommitted: boolean | null;
      if (typeof rawOperationCommitted === "boolean") operationCommitted = rawOperationCommitted;
      else if (rawOperationCommitted === null) operationCommitted = null;
      else operationCommitted = effectiveOperationAttempted ? null : false;
      if (remoteOperation === "repository.push") pushed = operationCommitted;
      else closed = operationCommitted;
      const anyRemoteWriteCommitted = pushed === true || closed === true;
      const failure = anyRemoteWriteCommitted ? blocked : reject;
      return recordAndReturn(failure("REMOTE_FINALIZE_FAILED", {
        issue,
        jobId,
        mode,
        commit,
        tree: auditedTree,
        pushed,
        closed,
        committed: anyRemoteWriteCommitted ? true : operationCommitted,
        operation: remoteOperation,
        principal: transportPrincipal,
        remoteIntent: journalSnapshot?.record || null,
        retryable: anyRemoteWriteCommitted || operationCommitted !== false,
        remoteWrites: {
          push: { attempted: remoteOperation !== "repository.push" || effectiveOperationAttempted, committed: pushed },
          issueClose: {
            attempted: remoteOperation === "issue.close" && effectiveOperationAttempted,
            committed: closed,
          },
        },
        message: redactFinalizerRemoteText(commandErrorMessage(err), [pushToken]),
      }));
    }
  }

  let sourceMergeCommitted = false;
  try {
    await assertLiveMutationLease("source.sync", commit, auditedTree);
    const beforeBranch = await currentBranch(canonicalSourcePath, { runCommand, env: sourceGitEnv });
    const beforeHead = (await revParse(canonicalSourcePath, "HEAD", { runCommand, env: sourceGitEnv })).toLowerCase();
    const beforeClean = await assertClean(canonicalSourcePath, { runCommand, env: sourceGitEnv });
    if (beforeBranch !== sourceBranch || beforeHead !== sourceHead.toLowerCase() || !beforeClean) {
      throw Object.assign(new Error("source branch, HEAD, or cleanliness changed before finalizer sync"), {
        code: "SOURCE_SYNC_PRECONDITION_FAILED",
        committed: mode === "remote" ? true : false,
      });
    }
    await assertLiveMutationLease("source.sync", commit, auditedTree);
    await runGit(canonicalSourcePath, ["merge", "--ff-only", commit], { runCommand, env: sourceGitEnv });
    sourceMergeCommitted = true;
    const actualBranch = await currentBranch(canonicalSourcePath, { runCommand, env: sourceGitEnv });
    const actualHead = (await revParse(canonicalSourcePath, "HEAD", { runCommand, env: sourceGitEnv })).toLowerCase();
    const clean = await assertClean(canonicalSourcePath, { runCommand, env: sourceGitEnv });
    if (actualBranch !== sourceBranch || actualHead !== commit.toLowerCase() || !clean) {
      throw Object.assign(new Error("source sync post-condition is not exact"), {
        code: "SOURCE_SYNC_POSTCONDITION_FAILED",
        committed: mode === "remote" ? true : null,
      });
    }
    sourceSync = {
      committed: true,
      clean: true,
      expectedBranch: sourceBranch,
      previousHead: sourceHead.toLowerCase(),
      expectedHead: commit.toLowerCase(),
      actualBranch,
      actualHead,
      observedAt: new Date().toISOString(),
    };
    if (mode === "remote") {
      await advanceLiveJournal("local.complete", {
        sourceSync: operationReceipt("source.sync", sourceSync),
      });
    }
  } catch (err) {
    const remoteCommitted = mode === "remote";
    const failureCode = remoteCommitted && sourceMergeCommitted
      ? "FINALIZER_JOURNAL_COMPLETE_FAILED"
      : remoteCommitted ? "LOCAL_SOURCE_SYNC_FAILED" : "MERGE_FAILED";
    const failure = remoteCommitted ? blocked : reject;
    return recordAndReturn(failure(failureCode, {
      issue,
      jobId,
      mode,
      commit,
      tree: auditedTree,
      pushed: remoteCommitted ? pushed : false,
      closed: remoteCommitted ? closed : false,
      committed: remoteCommitted ? true : finalizerRecord(err).committed === null ? null : false,
      localSynced: sourceMergeCommitted && Boolean(sourceSync),
      retryable: true,
      sourceSync,
      principal: remoteCommitted ? transportPrincipal : null,
      remoteIntent: remoteCommitted ? journalSnapshot?.record || null : null,
      localSyncError: redactFinalizerRemoteText(commandErrorMessage(err), [pushToken]),
      ...(remoteCommitted ? {
        remoteWrites: {
          push: { attempted: true, committed: true, verification: pushVerification },
          issueClose: {
            attempted: true,
            committed: true,
            verification: closeVerification,
            ...(closeTransportWarning ? { transportWarning: closeTransportWarning } : {}),
          },
        },
      } : {}),
    }));
  }

  return recordAndReturn({
    ok: true,
    status: "finalized",
    mode,
    issue,
    jobId,
    commit,
    tree: auditedTree,
    sourcePath: canonicalSourcePath,
    worktreePath: canonicalWorktreePath,
    sourceBranch,
    worktreeBranch,
    sourceHead,
    files: summary.entries,
    pushed,
    closed,
    committed: true,
    sourceSync,
    ...(mode === "remote" ? {
      localSynced: true,
      remoteWrites: {
        push: { attempted: true, committed: pushed, verification: pushVerification },
        issueClose: {
          attempted: true,
          committed: closed,
          verification: closeVerification,
          ...(closeTransportWarning ? { transportWarning: closeTransportWarning } : {}),
        },
      },
      principal: transportPrincipal,
      remoteIntent: journalSnapshot?.record || null,
    } : {}),
  });

}

export type RecoverFinalizerOnlyOptions = RuntimePathOptions & {
  cpbRoot: string;
  dataRoot: string;
  project: string;
  entryId: string;
  jobId: string;
  originJobId: string;
  sourcePath?: string | null;
  runCommand?: RunCommand;
  remoteCapability: GithubRemoteCapability | LooseRecord;
  transportPrincipal: LooseRecord;
  transportMode?: string | null;
  pushToken?: string | null;
  remoteAuthorityValidator?: GithubRemoteAuthorityValidator | null;
  remoteCommitVerifier?: GithubRemoteCommitVerifier | null;
  issueCloser?: ((issue: FinalizerRecord) => Promise<unknown> | unknown) | null;
  createPullRequest?: DraftPullRequestOptions["createPullRequest"] | null;
  assertMutationLease?: ((context: FinalizerRecord) => Promise<void | boolean> | void | boolean) | null;
  mutationFence?: FinalizerRecord | null;
  allowMutation?: boolean;
};

function journalCommittedReceipt(receipts: LooseRecord, key: string, operation: string) {
  const receipt = finalizerRecord(receipts[key]);
  return receipt.operation === operation
    && receipt.attempted === true
    && receipt.committed === true
    && typeof receipt.eventId === "string"
    && typeof receipt.observedAt === "string"
    ? receipt
    : null;
}

function recoveredSourceSync(receipt: FinalizerRecord | null) {
  if (!receipt) return null;
  return {
    committed: true,
    clean: receipt.clean === true,
    expectedBranch: receipt.expectedBranch,
    previousHead: receipt.previousHead,
    expectedHead: receipt.expectedHead,
    actualBranch: receipt.actualBranch,
    actualHead: receipt.actualHead,
    observedAt: receipt.observedAt,
  };
}

function finalizerSafeContinuationProof({
  intent,
  operation,
  decision,
  readbackKey,
  readback,
}: {
  intent: FinalizerJournalRecord;
  operation: string;
  decision: boolean;
  readbackKey: string;
  readback: unknown;
}) {
  return {
    schema: "cpb.finalizer-safe-continuation.v1",
    finalizationId: intent.finalizationId,
    journalDigest: finalizerJournalDigest(intent),
    journalGeneration: intent.generation,
    stage: intent.stage,
    operation,
    decision,
    readbackKey,
    readbackDigest: finalizerJournalDigest(readback),
  };
}

/**
 * Reconcile one durable finalizer journal without re-running the job.
 *
 * The default is deliberately read-only. An incomplete `*.intent` means a
 * request may have crossed the process boundary, so this API observes exact
 * remote truth and never blindly resends it. A mutation-enabled recovery must
 * first win a fresh fenced claim. It may retry a write only after exact
 * readback proves the bound post-condition is absent, using the sealed capsule
 * and the original force-with-lease baseline.
 */
export async function recoverFinalizerOnly({
  cpbRoot,
  dataRoot,
  project,
  entryId,
  jobId,
  originJobId,
  sourcePath = null,
  runCommand = execFileAsync,
  remoteCapability: rawCapability,
  transportPrincipal: rawPrincipal,
  transportMode = null,
  pushToken = null,
  remoteAuthorityValidator = null,
  remoteCommitVerifier = null,
  issueCloser = null,
  createPullRequest = null,
  assertMutationLease = null,
  mutationFence = null,
  allowMutation = false,
}: RecoverFinalizerOnlyOptions): Promise<FinalizerRecord> {
  let capability: GithubRemoteCapability;
  try {
    capability = normalizeGithubRemoteCapability(rawCapability);
  } catch (error) {
    return blocked("REMOTE_CAPABILITY_INVALID", {
      mode: null,
      jobId,
      committed: false,
      retryable: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const principal = normalizeTransportPrincipal(rawPrincipal);
  if (!principal) {
    return blocked("GITHUB_TRANSPORT_PRINCIPAL_REQUIRED", {
      mode: null,
      jobId,
      committed: false,
      retryable: false,
    });
  }
  let snapshot: FinalizerJournalSnapshot;
  try {
    snapshot = await readFinalizerJournal(cpbRoot, project, entryId, { dataRoot });
  } catch (error) {
    return blocked("REMOTE_INTENT_READ_FAILED", {
      mode: null,
      jobId,
      committed: null,
      retryable: true,
      error: redactFinalizerRemoteText(commandErrorMessage(error)),
    });
  }
  let intent = snapshot.record;
  if (snapshot.invalidReason || !intent) {
    return blocked(snapshot.invalidReason ? "REMOTE_INTENT_JOURNAL_INVALID" : "REMOTE_INTENT_MISSING", {
      mode: intent?.mode || null,
      jobId,
      committed: snapshot.invalidReason ? null : false,
      retryable: !snapshot.invalidReason,
      reason: snapshot.invalidReason,
    });
  }
  if (
    intent.project !== project
    || intent.entryId !== entryId
    || intent.originJobId !== originJobId
    || intent.repository !== capability.repository
    || intent.issueNumber !== capability.issueNumber
    || intent.capabilityDigest !== finalizerCapabilityDigest(capability)
    || finalizerJournalDigest(intent.principal) !== finalizerJournalDigest(principal)
  ) {
    return blocked("REMOTE_INTENT_BINDING_MISMATCH", {
      mode: intent.mode,
      jobId,
      committed: null,
      retryable: false,
      remoteIntent: intent,
    });
  }
  try {
    const verifiedCapsule = await snapshotFinalizerCapsule(intent, dataRoot);
    let verificationRoot: string | null = null;
    try {
      verificationRoot = await mkdtemp(path.join(tmpdir(), "cpb-finalizer-capsule-verify-"));
      const verificationRepo = path.join(verificationRoot, "authority.git");
      const clonedCapsule = path.join(verificationRoot, "candidate.git");
      const verificationEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        HOME: verificationRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      };
      await runGit(verificationRoot, ["init", "--bare", verificationRepo], {
        runCommand,
        env: verificationEnv,
      });
      await runGit(verificationRepo, ["bundle", "verify", verifiedCapsule.path], {
        runCommand,
        env: verificationEnv,
      });
      await runGit(verificationRoot, ["clone", "--bare", "--no-local", verifiedCapsule.path, clonedCapsule], {
        runCommand,
        env: verificationEnv,
      });
      const capsuleCommit = (await revParse(clonedCapsule, `${intent.commit}^{commit}`, {
        runCommand,
        env: verificationEnv,
      })).toLowerCase();
      const capsuleTree = (await revParse(clonedCapsule, `${intent.commit}^{tree}`, {
        runCommand,
        env: verificationEnv,
      })).toLowerCase();
      if (capsuleCommit !== intent.commit || capsuleTree !== intent.tree) {
        throw new Error("finalizer capsule commit/tree does not match its journal binding");
      }
    } finally {
      if (verificationRoot) await rm(verificationRoot, { recursive: true, force: true });
      await verifiedCapsule.dispose();
    }
  } catch (error) {
    return blocked("FINALIZER_CAPSULE_INVALID", {
      mode: intent.mode,
      jobId,
      commit: intent.commit,
      tree: intent.tree,
      committed: null,
      retryable: false,
      remoteIntent: intent,
      error: redactFinalizerRemoteText(commandErrorMessage(error)),
    });
  }

  const ownerDigest = finalizerMutationFenceDigest(mutationFence);
  const assertRecoveryLease = async (operation: string, current: FinalizerJournalRecord) => {
    if (!assertMutationLease) {
      throw Object.assign(new Error("finalizer recovery mutation lease is unavailable"), {
        code: "MUTATION_LEASE_REQUIRED",
        committed: false,
      });
    }
    const allowed = await assertMutationLease({
      operation,
      phase: "before-write",
      mode: current.mode,
      project,
      entryId,
      jobId,
      finalizationId: current.finalizationId,
      generation: current.generation,
      repository: current.repository,
      issueNumber: current.issueNumber,
      commit: current.commit,
      tree: current.tree,
    });
    if (allowed === false) {
      throw Object.assign(new Error("finalizer recovery mutation lease was rejected"), {
        code: "MUTATION_LEASE_LOST",
        committed: false,
      });
    }
  };

  const advanceRecoveryJournal = async (
    stage: FinalizerJournalStage,
    receiptUpdates: FinalizerRecord = {},
  ) => {
    if (!snapshot.record || !assertMutationLease) {
      throw Object.assign(new Error("finalizer recovery journal authority is unavailable"), {
        code: "FINALIZER_JOURNAL_REQUIRED",
        committed: null,
      });
    }
    const next = nextJournalRecord(snapshot, stage, { receipts: receiptUpdates });
    const expectedDigest = finalizerJournalDigest(next);
    const observed = await appendFinalizerJournal(cpbRoot, project, entryId, next, {
      dataRoot,
      expected: snapshot,
      assertMutationLease,
      leaseContext: { mode: next.mode, jobId, recovery: true },
    });
    if (!observed.record || finalizerJournalDigest(observed.record) !== expectedDigest) {
      throw Object.assign(new Error("finalizer recovery journal CAS lost"), {
        code: "MUTATION_CLAIM_LOST",
        committed: null,
      });
    }
    snapshot = observed;
    intent = observed.record;
    return observed.record;
  };

  if (allowMutation) {
    if (!ownerDigest || !assertMutationLease) {
      return blocked("FINALIZER_RECOVERY_FENCE_REQUIRED", {
        mode: intent.mode,
        jobId,
        commit: intent.commit,
        tree: intent.tree,
        committed: false,
        retryable: false,
        remoteIntent: intent,
      });
    }
    const activeClaim = finalizerRecord(intent.claim);
    if (activeClaim.ownerDigest === ownerDigest) {
      return blocked("MUTATION_CLAIM_REENTRY_UNSAFE", {
        mode: intent.mode,
        jobId,
        commit: intent.commit,
        tree: intent.tree,
        committed: null,
        retryable: true,
        remoteIntent: intent,
      });
    }
    if (activeClaim.ownerDigest !== ownerDigest) {
      const takeover = finalizerRecord(mutationFence?.takeover);
      if (
        !["owner-dead", "explicit-handoff"].includes(String(takeover.kind || ""))
        || takeover.previousClaimId !== activeClaim.claimId
        || typeof takeover.evidenceId !== "string" || !/^[0-9a-f]{64}$/.test(takeover.evidenceId)
        || typeof takeover.observedAt !== "string"
        || !Number.isFinite(Date.parse(takeover.observedAt))
        || new Date(Date.parse(takeover.observedAt)).toISOString() !== takeover.observedAt
      ) {
        return blocked("MUTATION_CLAIM_HELD", {
          mode: intent.mode,
          jobId,
          commit: intent.commit,
          tree: intent.tree,
          committed: null,
          retryable: true,
          remoteIntent: intent,
        });
      }
      const claimGeneration = Number(activeClaim.claimGeneration) + 1;
      const claimed = nextJournalRecord(snapshot, intent.stage, {
        claim: {
          claimId: finalizerJournalClaimId({
            finalizationId: intent.finalizationId,
            ownerDigest,
            claimGeneration,
          }),
          claimGeneration,
          ownerDigest,
          takeover: {
            kind: takeover.kind,
            previousClaimId: activeClaim.claimId,
            evidenceId: takeover.evidenceId,
            observedAt: takeover.observedAt,
          },
        },
      });
      try {
        const expectedDigest = finalizerJournalDigest(claimed);
        const observed = await appendFinalizerJournal(cpbRoot, project, entryId, claimed, {
          dataRoot,
          expected: snapshot,
          assertMutationLease,
          leaseContext: { mode: intent.mode, jobId, recovery: true },
        });
        if (!observed.record || finalizerJournalDigest(observed.record) !== expectedDigest) {
          throw Object.assign(new Error("finalizer recovery claim CAS lost"), {
            code: "MUTATION_CLAIM_LOST",
            committed: null,
          });
        }
        snapshot = observed;
        intent = observed.record;
      } catch (error) {
        return blocked(String(finalizerRecord(error).code || "FINALIZER_RECOVERY_CLAIM_FAILED"), {
          mode: intent.mode,
          jobId,
          commit: intent.commit,
          tree: intent.tree,
          committed: null,
          retryable: true,
          remoteIntent: intent,
          error: redactFinalizerRemoteText(commandErrorMessage(error)),
        });
      }
    }
  }

  let receipts = finalizerRecord(intent.receipts);
  const push = intent.mode === "remote"
    ? journalCommittedReceipt(receipts, "push", "repository.push")
    : journalCommittedReceipt(receipts, "branchPush", "pull_request.push");
  const issueClose = journalCommittedReceipt(receipts, "issueClose", "issue.close");
  const pullRequestCreate = journalCommittedReceipt(receipts, "pullRequestCreate", "pull_request.create");
  const prEvent = journalCommittedReceipt(receipts, "prEvent", "pr_opened.publish");
  const sourceSyncReceipt = journalCommittedReceipt(receipts, "sourceSync", "source.sync");

  if (intent.mode === "remote" && intent.stage === "local.complete"
    && push && issueClose && sourceSyncReceipt) {
    return {
      ok: true,
      status: "finalized",
      mode: "remote",
      jobId,
      commit: intent.commit,
      tree: intent.tree,
      pushed: true,
      closed: true,
      committed: true,
      localSynced: true,
      sourceSync: recoveredSourceSync(sourceSyncReceipt),
      remoteWrites: {
        push: { attempted: true, committed: true, verification: push.verification || null },
        issueClose: { attempted: true, committed: true, verification: issueClose.verification || null },
      },
      principal,
      remoteIntent: intent,
      recovered: true,
    };
  }
  if (intent.mode === "pr" && intent.stage === "event.complete" && push && pullRequestCreate && prEvent) {
    const prNumber = Number(pullRequestCreate.prNumber);
    const prUrl = typeof pullRequestCreate.prUrl === "string" ? pullRequestCreate.prUrl : null;
    if (Number.isSafeInteger(prNumber) && prNumber > 0
      && prUrl === `https://github.com/${capability.repository}/pull/${prNumber}`) {
      return {
        ok: true,
        status: "pr.opened",
        mode: "pr",
        jobId,
        commit: intent.commit,
        tree: intent.tree,
        pushed: true,
        closed: false,
        committed: true,
        eventRecorded: true,
        prNumber,
        prUrl,
        remoteWrites: {
          branchPush: { attempted: true, committed: true, verification: push.verification || null },
          pullRequestCreate: { attempted: true, committed: true, verification: pullRequestCreate.verification || null },
        },
        principal,
        remoteIntent: intent,
        recovered: true,
      };
    }
  }

  const reconciliation: FinalizerRecord = {};
  const boundPrincipalDigest = finalizerJournalDigest(principal);
  const verifyBound = async (request: GithubRemoteAuthorityRequest) => {
    if (!remoteCommitVerifier) {
      return {
        operation: request.operation,
        committed: null,
        reason: "GitHub remote readback verifier is unavailable",
      } as GithubRemoteWriteVerification;
    }
    try {
      const verification = await remoteCommitVerifier(request);
      const record = finalizerRecord(verification);
      const evidence = finalizerRecord(record.evidence);
      const observedPrincipal = normalizeTransportPrincipal(record.principal || evidence.principal);
      if (!observedPrincipal || finalizerJournalDigest(observedPrincipal) !== boundPrincipalDigest) {
        return {
          operation: request.operation,
          committed: null,
          reason: "GitHub verifier principal does not match the recovery transport",
        } as GithubRemoteWriteVerification;
      }
      return verification;
    } catch (error) {
      return {
        operation: request.operation,
        committed: null,
        reason: redactFinalizerRemoteText(commandErrorMessage(error)),
      } as GithubRemoteWriteVerification;
    }
  };
  const authorizeBound = async (request: GithubRemoteAuthorityRequest) => {
    if (!remoteAuthorityValidator) {
      throw Object.assign(new Error("GitHub recovery authority validator is unavailable"), {
        code: "GITHUB_REMOTE_AUTHORITY_REQUIRED",
        committed: false,
      });
    }
    const authority = finalizerRecord(await remoteAuthorityValidator(request));
    const observedPrincipal = normalizeTransportPrincipal(authority.principal || authority);
    if (!observedPrincipal || finalizerJournalDigest(observedPrincipal) !== boundPrincipalDigest) {
      throw Object.assign(new Error("GitHub authority principal does not match the recovery transport"), {
        code: "GITHUB_TRANSPORT_PRINCIPAL_MISMATCH",
        committed: false,
      });
    }
    return authority;
  };
  const pushRequest = (): GithubRemoteAuthorityRequest => ({
    capability,
    operation: "repository.push",
    repository: capability.repository,
    issueNumber: capability.issueNumber,
    targetBranch: intent.targetBranch,
    pushKind: intent.mode === "remote" ? "default-branch" : "pull-request-branch",
    ...(intent.mode === "pr" ? { headBranch: intent.targetBranch, baseBranch: capability.defaultBranch } : {}),
    commit: intent.commit,
  });
  const closeRequest = (): GithubRemoteAuthorityRequest => ({
    capability,
    operation: "issue.close",
    repository: capability.repository,
    issueNumber: capability.issueNumber,
    commit: intent.commit,
  });
  const pullRequestIdentity = (verification: GithubRemoteWriteVerification) => {
    const evidence = finalizerRecord(verification.evidence);
    const pullRequest = finalizerRecord(evidence.pullRequest);
    const prNumber = Number(pullRequest.number);
    const prUrl = typeof pullRequest.url === "string" ? pullRequest.url : null;
    return Number.isSafeInteger(prNumber) && prNumber > 0
      && prUrl === `https://github.com/${capability.repository}/pull/${prNumber}`
      ? { prNumber, prUrl }
      : null;
  };
  const observePrOpenedEvent = async () => {
    const eventIntent = finalizerRecord(receipts.prEventIntent);
    const eventJobId = typeof eventIntent.jobId === "string" && eventIntent.jobId ? eventIntent.jobId : null;
    const eventId = typeof eventIntent.eventId === "string" ? eventIntent.eventId : null;
    const prNumber = Number(eventIntent.prNumber);
    const prUrl = typeof eventIntent.prUrl === "string" ? eventIntent.prUrl : null;
    const identity = {
      operation: "pr_opened.publish",
      eventJobId,
      eventId,
      finalizationId: intent.finalizationId,
      prNumber,
      prUrl,
    };
    if (!eventJobId || !eventId || !Number.isSafeInteger(prNumber) || prNumber <= 0
      || prUrl !== `https://github.com/${capability.repository}/pull/${prNumber}`) {
      return { ...identity, committed: null, reason: "invalid pr_opened event intent" };
    }
    try {
      const events = await readEvents(cpbRoot, project, eventJobId, { dataRoot });
      const sameId = events.filter((event) => event.type === "pr_opened" && event.eventId === eventId);
      const exact = sameId.filter((event) => event.finalizationId === intent.finalizationId
        && event.jobId === eventJobId
        && event.project === project
        && event.prUrl === prUrl
        && event.prNumber === prNumber);
      const conflicting = sameId.length !== exact.length;
      return {
        ...identity,
        committed: conflicting ? null : exact.length > 0,
        eventStreamCursor: eventStreamCursorForRecords(events),
        matchingEvents: exact.length,
        ...(conflicting ? { reason: "event id is bound to conflicting pr_opened data" } : {}),
      };
    } catch (error) {
      return {
        ...identity,
        committed: null,
        reason: redactFinalizerRemoteText(commandErrorMessage(error)),
      };
    }
  };
  let safeContinuation: FinalizerRecord | null = null;
  const hasDurableRemoteWrite = () => intent.mode === "remote"
    ? Boolean(journalCommittedReceipt(finalizerRecord(intent.receipts), "push", "repository.push"))
    : Boolean(
        journalCommittedReceipt(finalizerRecord(intent.receipts), "branchPush", "pull_request.push")
        || journalCommittedReceipt(finalizerRecord(intent.receipts), "pullRequestCreate", "pull_request.create"),
      );
  const blockedRecovery = (code: string, committed: boolean | null = null) => blocked(code, {
    mode: intent.mode,
    jobId,
    commit: intent.commit,
    tree: intent.tree,
    committed: hasDurableRemoteWrite() ? true : committed,
    retryable: true,
    remoteIntent: intent,
    reconciliation,
    ...(safeContinuation ? { safeContinuation } : {}),
  });

  const continueRecoveredPush = async (observed: GithubRemoteWriteVerification) => {
    if (intent.stage === "claimed") {
      if (intent.mode === "remote") {
        await advanceRecoveryJournal("repository.push.intent");
      } else {
        const plan = finalizerRecord(receipts.prPlan);
        if (!plan.repo || !plan.head || !plan.base || !plan.title
          || typeof plan.body !== "string" || plan.draft !== true) {
          return { ok: false as const, code: "PR_CREATE_PLAN_MISSING", committed: false as const };
        }
        await advanceRecoveryJournal("pull_request.push.intent", {
          branchPushIntent: {
            capability,
            operation: "repository.push",
            repository: capability.repository,
            issueNumber: capability.issueNumber,
            targetBranch: intent.targetBranch,
            pushKind: "pull-request-branch",
            headBranch: intent.targetBranch,
            baseBranch: capability.defaultBranch,
            commit: intent.commit,
            pullRequestPlan: plan,
          },
        });
      }
      receipts = finalizerRecord(intent.receipts);
    }
    const receiptStage = intent.mode === "remote"
      ? "repository.push.receipt" as const
      : "pull_request.push.receipt" as const;
    const receiptKey = intent.mode === "remote" ? "push" : "branchPush";
    const receiptOperation = intent.mode === "remote" ? "repository.push" : "pull_request.push";
    if (observed.committed === true) {
      await advanceRecoveryJournal(receiptStage, {
        [receiptKey]: operationReceipt(receiptOperation, {
          repository: intent.repository,
          issueNumber: intent.issueNumber,
          commit: intent.commit,
          tree: intent.tree,
          targetBranch: intent.targetBranch,
          preRemoteHead: intent.preRemoteHead,
          verification: observed,
          recovered: true,
        }),
      });
      receipts = finalizerRecord(intent.receipts);
      return { ok: true as const, verification: observed };
    }
    if (observed.committed !== false) {
      return { ok: false as const, code: "REMOTE_PUSH_RECONCILIATION_UNRESOLVED", committed: null };
    }
    if (!pushToken) {
      return { ok: false as const, code: "FINALIZER_RECOVERY_PUSH_TOKEN_REQUIRED", committed: false as const };
    }
    const recoveryRoot = await mkdtemp(path.join(tmpdir(), "cpb-finalizer-recovery-push-"));
    const recoveryRepo = path.join(recoveryRoot, "candidate");
    let verifiedCapsule: Awaited<ReturnType<typeof snapshotFinalizerCapsule>> | null = null;
    const recoveryGitEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      HOME: recoveryRoot,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    try {
      verifiedCapsule = await snapshotFinalizerCapsule(intent, dataRoot);
      await runGit(recoveryRoot, ["clone", "--no-local", verifiedCapsule.path, recoveryRepo], {
        runCommand,
        env: recoveryGitEnv,
      });
      const capsuleCommit = (await revParse(recoveryRepo, "HEAD^{commit}", {
        runCommand,
        env: recoveryGitEnv,
      })).toLowerCase();
      const capsuleTree = (await revParse(recoveryRepo, `${intent.commit}^{tree}`, {
        runCommand,
        env: recoveryGitEnv,
      })).toLowerCase();
      if (capsuleCommit !== intent.commit || capsuleTree !== intent.tree) {
        return { ok: false as const, code: "FINALIZER_CAPSULE_TREE_MISMATCH", committed: false as const };
      }
      const request = pushRequest();
      const pushed = await pushGithubCommitWithControlledTransport({
        worktree: recoveryRepo,
        repository: capability.repository,
        commit: intent.commit,
        expectedTree: intent.tree,
        expectedRemoteHead: intent.preRemoteHead,
        targetBranch: intent.targetBranch,
        token: pushToken,
        env: recoveryGitEnv,
        runCommand,
        authorize: () => authorizeBound(request),
        verify: () => verifyBound(request),
        beforeAttempt: () => assertRecoveryLease(
          intent.mode === "remote" ? "repository.push" : "pull_request.push",
          intent,
        ),
        afterCommitted: async (verification) => {
          await advanceRecoveryJournal(receiptStage, {
            [receiptKey]: operationReceipt(receiptOperation, {
              repository: intent.repository,
              issueNumber: intent.issueNumber,
              commit: intent.commit,
              tree: intent.tree,
              targetBranch: intent.targetBranch,
              preRemoteHead: intent.preRemoteHead,
              verification,
              recovered: true,
            }),
          });
          receipts = finalizerRecord(intent.receipts);
        },
      });
      return pushed.committed === true
        ? { ok: true as const, verification: pushed }
        : { ok: false as const, code: "REMOTE_PUSH_RECONCILIATION_UNRESOLVED", committed: pushed.committed };
    } finally {
      if (verifiedCapsule) await verifiedCapsule.dispose();
      await rm(recoveryRoot, { recursive: true, force: true });
    }
  };

  const observedPush = await verifyBound(pushRequest());
  reconciliation.push = observedPush;
  if (!allowMutation) {
    if (intent.mode === "remote" && ["issue.close.intent", "issue.close.receipt", "remote.complete"].includes(intent.stage)) {
      reconciliation.issueClose = await verifyBound(closeRequest());
    }
    if (intent.mode === "pr" && intent.stage === "pull_request.create.intent") {
      const createIntent = finalizerRecord(receipts.pullRequestCreateIntent);
      reconciliation.pullRequestCreate = await verifyBound({
        capability,
        operation: "pull_request.create",
        repository: capability.repository,
        issueNumber: capability.issueNumber,
        headBranch: intent.targetBranch,
        baseBranch: capability.defaultBranch,
        commit: intent.commit,
        title: typeof createIntent.title === "string" ? createIntent.title : null,
        body: typeof createIntent.body === "string" ? createIntent.body : null,
        draft: createIntent.draft === true,
        authorLogin: typeof createIntent.authorLogin === "string" ? createIntent.authorLogin : null,
        authorId: typeof createIntent.authorId === "string" || typeof createIntent.authorId === "number"
          ? createIntent.authorId
          : null,
      });
    }
    if (intent.mode === "pr" && intent.stage === "pr_opened.publish.intent") {
      reconciliation.prEvent = await observePrOpenedEvent();
    }

    if (intent.stage === "claimed") {
      reconciliation.journal = {
        stage: intent.stage,
        generation: intent.generation,
        claimId: intent.claim.claimId,
        remoteMutationStarted: false,
      };
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: intent.mode === "remote" ? "repository.push" : "pull_request.push",
        decision: false,
        readbackKey: "journal",
        readback: reconciliation.journal,
      });
    } else if (intent.stage === "repository.push.intent"
      && typeof observedPush.committed === "boolean") {
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: "repository.push",
        decision: observedPush.committed,
        readbackKey: "push",
        readback: observedPush,
      });
    } else if (intent.stage === "repository.push.receipt" && push) {
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: "repository.push",
        decision: true,
        readbackKey: "receipts.push",
        readback: push,
      });
    } else if (intent.stage === "issue.close.intent" && push
      && typeof finalizerRecord(reconciliation.issueClose).committed === "boolean") {
      const readback = finalizerRecord(reconciliation.issueClose);
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: "issue.close",
        decision: Boolean(readback.committed),
        readbackKey: "issueClose",
        readback,
      });
    } else if ((intent.stage === "issue.close.receipt" || intent.stage === "remote.complete")
      && push && issueClose) {
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: "issue.close",
        decision: true,
        readbackKey: "receipts.issueClose",
        readback: issueClose,
      });
    } else if (intent.stage === "pull_request.push.intent"
      && typeof observedPush.committed === "boolean") {
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: "pull_request.push",
        decision: observedPush.committed,
        readbackKey: "push",
        readback: observedPush,
      });
    } else if (intent.stage === "pull_request.push.receipt" && push) {
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: "pull_request.push",
        decision: true,
        readbackKey: "receipts.branchPush",
        readback: push,
      });
    } else if (intent.stage === "pull_request.create.intent" && push
      && finalizerRecord(reconciliation.pullRequestCreate).committed === true) {
      const readback = finalizerRecord(reconciliation.pullRequestCreate);
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: "pull_request.create",
        decision: true,
        readbackKey: "pullRequestCreate",
        readback,
      });
    } else if (intent.stage === "pull_request.create.receipt" && push && pullRequestCreate) {
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: "pull_request.create",
        decision: true,
        readbackKey: "receipts.pullRequestCreate",
        readback: pullRequestCreate,
      });
    } else if (intent.stage === "pr_opened.publish.intent" && push && pullRequestCreate
      && typeof finalizerRecord(reconciliation.prEvent).committed === "boolean") {
      const readback = finalizerRecord(reconciliation.prEvent);
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: "pr_opened.publish",
        decision: Boolean(readback.committed),
        readbackKey: "prEvent",
        readback,
      });
    } else if (intent.stage === "pr_opened.publish.receipt" && push && pullRequestCreate && prEvent) {
      safeContinuation = finalizerSafeContinuationProof({
        intent,
        operation: "pr_opened.publish",
        decision: true,
        readbackKey: "receipts.prEvent",
        readback: prEvent,
      });
    }
    const noRemoteWriteStarted = intent.stage === "claimed";
    const firstPushObservedAbsent = (
      intent.stage === "repository.push.intent" || intent.stage === "pull_request.push.intent"
    ) && observedPush.committed === false;
    return blockedRecovery(
      "REMOTE_RECONCILIATION_REQUIRED",
      noRemoteWriteStarted || firstPushObservedAbsent ? false : null,
    );
  }

  try {
    if (intent.mode === "remote") {
      if (intent.stage === "claimed" || intent.stage === "repository.push.intent") {
        const continued = await continueRecoveredPush(observedPush);
        if (!continued.ok) return blockedRecovery(continued.code, continued.committed);
      }
      if (intent.stage === "repository.push.receipt") {
        if (observedPush.committed !== true) {
          return blockedRecovery("REMOTE_PUSH_RECEIPT_CONTRADICTED", observedPush.committed);
        }
        if (!issueCloser) return blockedRecovery("REMOTE_ISSUE_CLOSER_MISSING", false);
        await authorizeBound(closeRequest());
        await advanceRecoveryJournal("issue.close.intent");
      }
      if (intent.stage === "issue.close.intent") {
        let closeVerification = await verifyBound(closeRequest());
        reconciliation.issueClose = closeVerification;
        let transportWarning: FinalizerRecord | null = null;
        if (closeVerification.committed === false) {
          if (!issueCloser) return blockedRecovery("REMOTE_ISSUE_CLOSER_MISSING", false);
          await authorizeBound(closeRequest());
          await assertRecoveryLease("issue.close", intent);
          try {
            const response = finalizerRecord(await issueCloser({
              repo: capability.repository,
              number: capability.issueNumber,
              url: `https://github.com/${capability.repository}/issues/${capability.issueNumber}`,
              jobId,
              commit: intent.commit,
            }));
            if (response.ok === false) transportWarning = { response: boundedCloseTransportResponse(response) };
          } catch (error) {
            transportWarning = { message: redactFinalizerRemoteText(commandErrorMessage(error)) };
          }
          closeVerification = await verifyBound(closeRequest());
          reconciliation.issueClose = closeVerification;
        }
        if (closeVerification.committed !== true) {
          return blockedRecovery("REMOTE_ISSUE_CLOSE_RECONCILIATION_UNRESOLVED", closeVerification.committed);
        }
        await advanceRecoveryJournal("issue.close.receipt", {
          issueClose: operationReceipt("issue.close", {
            repository: intent.repository,
            issueNumber: intent.issueNumber,
            commit: intent.commit,
            verification: closeVerification,
            recovered: true,
            ...(transportWarning ? { transportWarning } : {}),
          }),
        });
      }
      if (intent.stage === "issue.close.receipt") await advanceRecoveryJournal("remote.complete");
      if (intent.stage === "remote.complete") {
        if (!sourcePath) return blockedRecovery("FINALIZER_RECOVERY_SOURCE_REQUIRED", true);
        const canonicalSourcePath = await realpath(sourcePath);
        const sourceGitEnv = await assertGithubTrustedGitRepository(canonicalSourcePath, {
          runCommand,
          env: process.env,
          workspaceRoot: dataRoot,
          boundary: "finalizer recovery source repository",
        });
        await assertGitRemoteTargetsCapability(canonicalSourcePath, "origin", capability, {
          runCommand,
          env: sourceGitEnv,
        });
        const expectedBranch = String(intent.source.branch);
        const previousHead = String(intent.source.head).toLowerCase();
        const readSourceState = async () => ({
          branch: await currentBranch(canonicalSourcePath, { runCommand, env: sourceGitEnv }),
          head: (await revParse(canonicalSourcePath, "HEAD", { runCommand, env: sourceGitEnv })).toLowerCase(),
          clean: await assertClean(canonicalSourcePath, { runCommand, env: sourceGitEnv }),
        });
        let before = await readSourceState();
        if (before.branch !== expectedBranch || !before.clean
          || (before.head !== previousHead && before.head !== intent.commit)) {
          return blockedRecovery("SOURCE_SYNC_PRECONDITION_FAILED", true);
        }
        await assertRecoveryLease("source.sync", intent);
        before = await readSourceState();
        if (before.branch !== expectedBranch || !before.clean
          || (before.head !== previousHead && before.head !== intent.commit)) {
          return blockedRecovery("SOURCE_SYNC_PRECONDITION_FAILED", true);
        }
        if (before.head === previousHead) {
          let commitTree = await runGit(canonicalSourcePath, ["rev-parse", "--verify", `${intent.commit}^{tree}`], {
            allowFailure: true,
            runCommand,
            env: sourceGitEnv,
          });
          if (commitTree.exitCode !== 0) {
            const verifiedCapsule = await snapshotFinalizerCapsule(intent, dataRoot);
            try {
              await runGit(canonicalSourcePath, ["fetch", "--no-tags", verifiedCapsule.path, "HEAD"], {
                runCommand,
                env: sourceGitEnv,
              });
            } finally {
              await verifiedCapsule.dispose();
            }
            commitTree = await runGit(canonicalSourcePath, ["rev-parse", "--verify", `${intent.commit}^{tree}`], {
              runCommand,
              env: sourceGitEnv,
            });
          }
          if (commitTree.stdout.trim().toLowerCase() !== intent.tree) {
            return blockedRecovery("FINALIZER_CAPSULE_TREE_MISMATCH", true);
          }
          await assertRecoveryLease("source.sync", intent);
          await runGit(canonicalSourcePath, ["merge", "--ff-only", intent.commit], {
            runCommand,
            env: sourceGitEnv,
          });
        }
        const after = await readSourceState();
        if (after.branch !== expectedBranch || after.head !== intent.commit || !after.clean) {
          return blockedRecovery("SOURCE_SYNC_POSTCONDITION_FAILED", true);
        }
        const sourceSync = operationReceipt("source.sync", {
          clean: true,
          expectedBranch,
          previousHead,
          expectedHead: intent.commit,
          actualBranch: after.branch,
          actualHead: after.head,
          recovered: true,
        });
        await advanceRecoveryJournal("local.complete", { sourceSync });
      }
    } else {
      if (intent.stage === "claimed" || intent.stage === "pull_request.push.intent") {
        const continued = await continueRecoveredPush(observedPush);
        if (!continued.ok) return blockedRecovery(continued.code, continued.committed);
      }
      if (intent.stage === "pull_request.push.receipt") {
        const branchIntent = finalizerRecord(receipts.branchPushIntent);
        const plan = finalizerRecord(branchIntent.pullRequestPlan || receipts.prPlan);
        if (!createPullRequest || !plan.repo || !plan.head || !plan.base || !plan.title || typeof plan.body !== "string") {
          return blockedRecovery("PR_CREATE_PLAN_MISSING", false);
        }
        const createAuthorityRequest: GithubRemoteAuthorityRequest = {
          capability,
          operation: "pull_request.create",
          repository: String(plan.repo),
          issueNumber: capability.issueNumber,
          headBranch: String(plan.head),
          baseBranch: String(plan.base),
          commit: intent.commit,
          title: String(plan.title),
          body: String(plan.body),
          draft: plan.draft === true,
        };
        const authority = await authorizeBound(createAuthorityRequest);
        const boundCreateRequest: GithubRemoteAuthorityRequest = {
          ...createAuthorityRequest,
          authorLogin: String(authority.authorLogin || ""),
          authorId: String(authority.authorId || ""),
        };
        await advanceRecoveryJournal("pull_request.create.intent", {
          pullRequestCreateIntent: boundCreateRequest,
        });
        await assertRecoveryLease("pull_request.create", intent);
        let response: FinalizerRecord = {};
        let transportError: unknown = null;
        try {
          response = finalizerRecord(await createPullRequest({
            repo: plan.repo,
            head: plan.head,
            base: plan.base,
            title: plan.title,
            body: plan.body,
            draft: true,
          }));
        } catch (error) {
          transportError = error;
        }
        const responseNumber = Number(response.number);
        const verification = await verifyBound({
          ...boundCreateRequest,
          ...(Number.isSafeInteger(responseNumber) && responseNumber > 0 ? { pullRequestNumber: responseNumber } : {}),
        });
        reconciliation.pullRequestCreate = verification;
        if (verification.committed !== true) {
          return blockedRecovery("PR_CREATE_RECONCILIATION_UNRESOLVED", verification.committed);
        }
        const identity = pullRequestIdentity(verification);
        if (!identity) return blockedRecovery("PR_CREATE_IDENTITY_UNCONFIRMED", null);
        await advanceRecoveryJournal("pull_request.create.receipt", {
          pullRequestCreate: operationReceipt("pull_request.create", {
            repository: intent.repository,
            issueNumber: intent.issueNumber,
            commit: intent.commit,
            headBranch: boundCreateRequest.headBranch,
            baseBranch: boundCreateRequest.baseBranch,
            title: boundCreateRequest.title,
            body: boundCreateRequest.body,
            draft: boundCreateRequest.draft,
            authorLogin: boundCreateRequest.authorLogin,
            authorId: boundCreateRequest.authorId,
            ...identity,
            verification,
            recovered: true,
            ...(transportError ? { transportWarning: redactFinalizerRemoteText(commandErrorMessage(transportError)) } : {}),
          }),
        });
        receipts = finalizerRecord(intent.receipts);
      }
      if (intent.stage === "pull_request.create.intent") {
        const createIntent = finalizerRecord(receipts.pullRequestCreateIntent) as GithubRemoteAuthorityRequest;
        const verification = await verifyBound(createIntent);
        reconciliation.pullRequestCreate = verification;
        if (verification.committed !== true) {
          return blockedRecovery("PR_CREATE_RECONCILIATION_UNRESOLVED", verification.committed);
        }
        const identity = pullRequestIdentity(verification);
        if (!identity) return blockedRecovery("PR_CREATE_IDENTITY_UNCONFIRMED", null);
        await advanceRecoveryJournal("pull_request.create.receipt", {
          pullRequestCreate: operationReceipt("pull_request.create", {
            repository: intent.repository,
            issueNumber: intent.issueNumber,
            commit: intent.commit,
            headBranch: createIntent.headBranch,
            baseBranch: createIntent.baseBranch,
            title: createIntent.title,
            body: createIntent.body,
            draft: createIntent.draft,
            authorLogin: createIntent.authorLogin,
            authorId: createIntent.authorId,
            ...identity,
            verification,
            recovered: true,
          }),
        });
        receipts = finalizerRecord(intent.receipts);
      }
      if (intent.stage === "pull_request.create.receipt") {
        const createReceipt = journalCommittedReceipt(receipts, "pullRequestCreate", "pull_request.create");
        if (!createReceipt) return blockedRecovery("PR_CREATE_RECEIPT_MISSING", true);
        const eventId = finalizerJournalPrEventId(intent.finalizationId);
        await advanceRecoveryJournal("pr_opened.publish.intent", {
          prEventIntent: {
            jobId: originJobId,
            prUrl: createReceipt.prUrl,
            prNumber: createReceipt.prNumber,
            eventId,
          },
        });
        receipts = finalizerRecord(intent.receipts);
      }
      if (intent.stage === "pr_opened.publish.intent") {
        const eventIntent = finalizerRecord(receipts.prEventIntent);
        const eventJobId = typeof eventIntent.jobId === "string" && eventIntent.jobId ? eventIntent.jobId : null;
        const eventId = typeof eventIntent.eventId === "string" ? eventIntent.eventId : null;
        const prNumber = Number(eventIntent.prNumber);
        const prUrl = typeof eventIntent.prUrl === "string" ? eventIntent.prUrl : null;
        if (!eventJobId || !eventId || !Number.isSafeInteger(prNumber) || prNumber <= 0
          || prUrl !== `https://github.com/${capability.repository}/pull/${prNumber}`) {
          return blockedRecovery("PR_EVENT_INTENT_INVALID", true);
        }
        let observation = await observePrOpenedEvent();
        reconciliation.prEvent = observation;
        if (observation.committed === false) {
          await assertRecoveryLease("pr_opened.publish", intent);
          await appendEvent(cpbRoot, project, eventJobId, {
            type: "pr_opened",
            jobId: eventJobId,
            project,
            prUrl,
            prNumber,
            artifact: { type: "github_pr", url: prUrl, number: prNumber },
            transportMode,
            transportFallback: transportMode === "gh",
            finalizationId: intent.finalizationId,
            eventId,
            recovered: true,
            ts: new Date().toISOString(),
          }, { dataRoot });
          observation = await observePrOpenedEvent();
          reconciliation.prEvent = observation;
        }
        if (observation.committed !== true || !("eventStreamCursor" in observation)) {
          return blockedRecovery(
            observation.committed === false
              ? "PR_OPENED_EVENT_NOT_PERSISTED"
              : "PR_OPENED_EVENT_RECONCILIATION_UNRESOLVED",
            true,
          );
        }
        await advanceRecoveryJournal("pr_opened.publish.receipt", {
          prEvent: operationReceipt("pr_opened.publish", {
            prUrl,
            prNumber,
            jobId: eventJobId,
            finalizationId: intent.finalizationId,
            eventId,
            eventRecordDigest: finalizerJournalDigest({
              type: "pr_opened",
              project,
              jobId: eventJobId,
              finalizationId: intent.finalizationId,
              eventId,
              prUrl,
              prNumber,
            }),
            eventStreamCursor: observation.eventStreamCursor,
            recovered: true,
          }),
        });
      }
      if (intent.stage === "pr_opened.publish.receipt") await advanceRecoveryJournal("event.complete");
    }
  } catch (error) {
    return blocked(String(finalizerRecord(error).code || "FINALIZER_RECOVERY_FAILED"), {
      mode: intent.mode,
      jobId,
      commit: intent.commit,
      tree: intent.tree,
      committed: hasDurableRemoteWrite()
        ? true
        : finalizerRecord(error).committed === false ? false : null,
      retryable: true,
      remoteIntent: intent,
      reconciliation,
      error: redactFinalizerRemoteText(commandErrorMessage(error)),
    });
  }

  return recoverFinalizerOnly({
    cpbRoot,
    dataRoot,
    project,
    entryId,
    jobId,
    originJobId,
    sourcePath,
    runCommand,
    remoteCapability: capability,
    transportPrincipal: principal,
    transportMode,
    pushToken,
    remoteAuthorityValidator,
    remoteCommitVerifier,
    issueCloser,
    createPullRequest,
    assertMutationLease,
    mutationFence,
    allowMutation: false,
  });
}

// ── Approval gate (from approval-gate.ts) ──────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

export async function requestApprovalGate(
  cpbRoot: string,
  project: string,
  jobId: string,
  { operation, phase, channels = [], reason = "approval required", timeoutAt = null, ts = nowIso(), dataRoot }: ApprovalGateOptions = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "approval_required",
    jobId,
    project,
    operation,
    phase,
    channels,
    reason,
    timeoutAt,
    ts,
  }, { dataRoot });
  return getJob(cpbRoot, project, jobId, { dataRoot });
}

export async function approveGate(
  cpbRoot: string,
  project: string,
  jobId: string,
  { actor = null, action = null, ts = nowIso(), dataRoot }: ApprovalGateOptions = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "job_approved",
    jobId,
    project,
    actor,
    action,
    ts,
  }, { dataRoot });
  return getJob(cpbRoot, project, jobId, { dataRoot });
}

export async function timeoutApprovalGate(
  cpbRoot: string,
  project: string,
  jobId: string,
  { reason = "approval timed out", ts = nowIso(), dataRoot }: ApprovalGateOptions = {},
) {
  await appendEvent(cpbRoot, project, jobId, {
    type: "approval_timed_out",
    jobId,
    project,
    reason,
    ts,
  }, { dataRoot });

  const { extractExperienceFromTerminalState } = await import("./event/event-source.js");
  const state = await getJob(cpbRoot, project, jobId, { dataRoot });
  await extractExperienceFromTerminalState(cpbRoot, project, jobId, state, "approval_timed_out").catch(() => {});

  return state;
}
