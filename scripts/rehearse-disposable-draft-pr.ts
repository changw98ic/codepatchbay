#!/usr/bin/env node
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { redactSecrets } from "../server/services/secret-policy.js";
import { writeJsonAtomic } from "../shared/fs-utils.js";

const execFileAsync = promisify(execFile);
const ACK_ENV = "CPB_DISPOSABLE_DRAFT_PR_REHEARSAL_ACK";
const ACK_PREFIX = "execute-disposable-draft-pr:";
const MARKER_PATH = ".cpb-disposable-target.json";
const MARKER_PURPOSE = "codepatchbay-release-rehearsal";
const BRANCH_PREFIX = "cpb-release-rehearsal";
const EVIDENCE_GENERATOR = "scripts/rehearse-disposable-draft-pr.ts#rehearseDisposableDraftPr";
const ZERO_OID = "0".repeat(40);

type CommandResult = {
  stdout?: string;
  stderr?: string;
};

type RunCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; maxBuffer?: number; signal?: AbortSignal },
) => Promise<CommandResult>;

type RehearsalOptions = {
  argv?: string[];
  env?: Record<string, string | undefined>;
  root?: string;
  runCommand?: RunCommand;
  now?: () => Date;
  idGenerator?: () => string;
  signal?: AbortSignal;
  commandTimeoutMs?: number;
  cleanupTimeoutMs?: number;
};

type CliProcessLike = {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode?: number;
  on: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  removeListener: (event: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
};

type RehearsalCliOptions = Omit<RehearsalOptions, "argv" | "env" | "signal"> & {
  processRef?: CliProcessLike;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
};

type Violation = {
  gate: string;
  reason: string;
  error?: unknown;
};

type Evidence = {
  schemaVersion: 1;
  generator: typeof EVIDENCE_GENERATOR;
  generatedAt: string;
  ok: boolean;
  mode: "live" | "preflight";
  target: {
    repository: string | null;
    repositoryId?: string | number | null;
    baseBranch: string | null;
    markerVerified: boolean;
    disposable: boolean;
    markerPath: string | null;
    markerSha: string | null;
  };
  branch: string | null;
  pullRequest: {
    number: number | null;
    url: string | null;
    draft: boolean;
    state: string | null;
  };
  cleanup: {
    pullRequestClosed: boolean;
    branchDeleted: boolean;
  };
  operations: Array<Record<string, unknown>>;
  violations: Violation[];
};

type RemoteAuthority = {
  repository: string;
  repositoryId: string;
  baseBranch: string;
  markerSha: string;
};

type PullRequestIdentity = {
  number: number | null;
  url: string;
  draft: boolean;
  state: string | null;
  headRef: string | null;
  headSha: string | null;
  baseRef: string | null;
  title: string | null;
  body: string | null;
  headRepository: string | null;
};

type GenerationCommit = {
  commitSha: string;
  treeSha: string;
  blobSha: string;
};

function defaultRunCommand(command: string, args: string[], options: { cwd?: string; maxBuffer?: number; signal?: AbortSignal } = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 1024 * 1024,
    signal: options.signal,
  }) as Promise<CommandResult>;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("operation aborted");
  }
}

function composeSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`command timed out after ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(parent?.reason || new Error("operation aborted"));
  if (parent) {
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      if (parent) parent.removeEventListener("abort", abort);
    },
  };
}

function boundedRunCommand(runCommand: RunCommand, parentSignal: AbortSignal | undefined, timeoutMs: number): RunCommand {
  return async (command, args, options = {}) => {
    throwIfAborted(parentSignal);
    const bounded = composeSignal(parentSignal, timeoutMs);
    try {
      return await runCommand(command, args, { ...options, signal: bounded.signal });
    } finally {
      bounded.dispose();
    }
  };
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const details = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const code = typeof details.code === "string" ? details.code : undefined;
  return redactSecrets({
    message,
    code,
    ...(typeof details.committed === "boolean" || details.committed === null
      ? { committed: details.committed }
      : {}),
    ...(typeof details.renameCommitted === "boolean" || details.renameCommitted === null
      ? { renameCommitted: details.renameCommitted }
      : {}),
    ...(typeof details.successorPreserved === "boolean"
      ? { successorPreserved: details.successorPreserved }
      : {}),
    ...(typeof details.committedPath === "string"
      ? { committedPath: details.committedPath }
      : {}),
    ...(Array.isArray(details.recoveryPaths)
      ? { recoveryPaths: details.recoveryPaths.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    ...(error instanceof AggregateError
      ? { failures: error.errors.map((entry) => safeError(entry)) }
      : {}),
  });
}

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function parseCli(argv: string[]) {
  const args = argv[0]?.includes("node") || argv[1]?.endsWith(".js") || argv[1]?.endsWith(".ts")
    ? argv.slice(2)
    : argv.slice();
  const owner = valueAfter(args, "--owner");
  const repo = valueAfter(args, "--repo");
  const repository = valueAfter(args, "--repository");
  const [repositoryOwner, repositoryName] = repository?.includes("/") ? repository.split("/", 2) : [owner, repo];
  return {
    execute: args.includes("--execute"),
    owner: repositoryOwner || null,
    repo: repositoryName || null,
    baseBranch: valueAfter(args, "--base"),
    root: valueAfter(args, "--root"),
  };
}

function normalizeGitHubRepo(input: string | null | undefined) {
  if (!input) return null;
  const trimmed = input.trim();
  const ssh = trimmed.match(/^git@github\.com:([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (ssh) return ssh[1].toLowerCase();
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:"].includes(parsed.protocol)) return null;
    const segments = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
    if (segments.length !== 2 || segments.some((segment) => !segment || /\s/.test(segment))) return null;
    return `${segments[0]}/${segments[1]}`.toLowerCase();
  } catch {
    return null;
  }
}

function commandStdout(result: CommandResult) {
  return String(result?.stdout || "").trim();
}

function parseJson(text: string) {
  return JSON.parse(text);
}

function parseMarkerResponse(stdout: string) {
  const response = parseJson(stdout.trim());
  if (!response || typeof response !== "object") throw new Error("disposable marker response is not an object");
  const content = String(response.content || "").replace(/\s+/g, "");
  const sha = String(response.sha || "");
  const markerPath = String(response.path || "");
  if (!content) throw new Error("disposable marker response has no content");
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("disposable marker response has no blob SHA");
  if (markerPath !== MARKER_PATH) throw new Error("disposable marker response path is invalid");
  const decoded = Buffer.from(content, "base64").toString("utf8");
  return { marker: parseJson(decoded), sha, path: markerPath };
}

function validateMarker(marker: unknown, repository: string) {
  if (!marker || typeof marker !== "object") {
    return "marker is not a JSON object";
  }
  const record = marker as Record<string, unknown>;
  if (record.schemaVersion !== 1) return "marker schemaVersion must be 1";
  if (record.purpose !== MARKER_PURPOSE) return `marker purpose must be ${MARKER_PURPOSE}`;
  if (String(record.repository || "").toLowerCase() !== repository.toLowerCase()) {
    return "marker repository does not match target repository";
  }
  if (record.disposable !== true) return "marker must explicitly set disposable=true";
  if (record.allowDraftPullRequests !== true) return "marker must allow draft pull requests";
  if (record.allowPullRequestClose !== true) return "marker must allow rehearsal pull request cleanup";
  if (record.allowBranchDeletion !== true) return "marker must allow rehearsal branch cleanup";
  if (record.allowedBranchPrefix !== `${BRANCH_PREFIX}/`) return `marker allowedBranchPrefix must be ${BRANCH_PREFIX}/`;
  if (record.allowedPayloadPrefix !== ".cpb-release-rehearsals/") {
    return "marker allowedPayloadPrefix must be .cpb-release-rehearsals/";
  }
  return null;
}

function parseRepositoryView(stdout: string) {
  const parsed = parseJson(stdout);
  const defaultBranch = parsed?.defaultBranchRef?.name || parsed?.defaultBranch || parsed?.baseBranch;
  if (typeof defaultBranch !== "string" || !defaultBranch.trim()) {
    throw new Error("target repository did not report a default branch");
  }
  const id = parsed?.id ?? parsed?.databaseId ?? null;
  return { defaultBranch: defaultBranch.trim(), id };
}

function validBranchName(value: string) {
  return /^[A-Za-z0-9._/-]+$/.test(value)
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("..")
    && !value.includes("//");
}

function parsePullRequest(stdout: string): PullRequestIdentity {
  const parsed = parseJson(stdout);
  return {
    number: typeof parsed?.number === "number" ? parsed.number : Number(parsed?.number || 0) || null,
    url: String(parsed?.html_url || parsed?.url || ""),
    draft: parsed?.draft === true,
    state: parsed?.state ? String(parsed.state) : null,
    headRef: parsed?.head?.ref ? String(parsed.head.ref) : null,
    headSha: parsed?.head?.sha ? String(parsed.head.sha) : null,
    baseRef: parsed?.base?.ref ? String(parsed.base.ref) : null,
    title: parsed?.title ? String(parsed.title) : null,
    body: typeof parsed?.body === "string" ? parsed.body : null,
    headRepository: parsed?.head?.repo?.full_name ? String(parsed.head.repo.full_name).toLowerCase() : null,
  };
}

function parsePullRequestList(stdout: string, branch: string) {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed)) throw new Error("pull request discovery response is not an array");
  const entries = parsed.every((item) => Array.isArray(item)) ? parsed.flat() : parsed;
  return entries
    .map((item) => ({
      number: typeof item?.number === "number" ? item.number : Number(item?.number || 0) || null,
      url: String(item?.html_url || item?.url || ""),
      draft: item?.draft === true,
      state: item?.state ? String(item.state) : null,
      headRef: item?.head?.ref ? String(item.head.ref) : null,
      headLabel: item?.head?.label ? String(item.head.label) : null,
      headSha: item?.head?.sha ? String(item.head.sha) : null,
      baseRef: item?.base?.ref ? String(item.base.ref) : null,
      title: item?.title ? String(item.title) : null,
      body: typeof item?.body === "string" ? item.body : null,
      headRepository: item?.head?.repo?.full_name ? String(item.head.repo.full_name).toLowerCase() : null,
    }))
    .filter((item) => item.number !== null)
    .filter((item) => item.headRef === branch || item.headLabel?.endsWith(`:${branch}`));
}

function parseMatchingRefs(stdout: string, branch: string) {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed)) throw new Error("matching refs response is not an array");
  const matching = parsed
    .map((item) => ({
      ref: String(item?.ref || ""),
      sha: String(item?.object?.sha || "").toLowerCase(),
    }))
    .filter((item) => item.ref === `refs/heads/${branch}`);
  if (matching.length > 1) throw new Error("matching refs response contained duplicate exact branches");
  if (matching.some((item) => !/^[0-9a-f]{40}$/i.test(item.sha))) {
    throw new Error("matching refs response did not contain a commit SHA");
  }
  return matching;
}

function parseRefSha(stdout: string, branch: string) {
  const parsed = parseJson(stdout);
  if (String(parsed?.ref || "") !== `refs/heads/${branch}`) {
    throw new Error("remote branch response did not match the expected ref");
  }
  const sha = String(parsed?.object?.sha || "");
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("remote branch response did not contain a commit SHA");
  }
  return sha.toLowerCase();
}

function parseAtomicRefUpdate(stdout: string, clientMutationId: string) {
  const parsed = parseJson(stdout);
  if (parsed?.data?.updateRefs?.clientMutationId !== clientMutationId) {
    throw new Error("atomic branch update did not return the owned generation id");
  }
}

function addViolation(evidence: Evidence, gate: string, reason: string, error?: unknown) {
  evidence.violations.push({
    gate,
    reason,
    ...(error ? { error: safeError(error) } : {}),
  });
}

async function verifyRemoteAuthority({
  evidence,
  runCommand,
  authority,
  mutation,
}: {
  evidence: Evidence;
  runCommand: RunCommand;
  authority: RemoteAuthority;
  mutation: string;
}) {
  const view = parseRepositoryView(commandStdout(await runCommand("gh", [
    "repo",
    "view",
    authority.repository,
    "--json",
    "id,defaultBranchRef",
  ], { maxBuffer: 1024 * 1024 })));
  if (String(view.id ?? "") !== authority.repositoryId) {
    throw new Error(`target repository identity changed before ${mutation}`);
  }

  const markerResponse = parseMarkerResponse(commandStdout(await runCommand("gh", [
    "api",
    `repos/${authority.repository}/contents/${MARKER_PATH}?ref=${encodeURIComponent(authority.baseBranch)}`,
  ], { maxBuffer: 1024 * 1024 })));
  const markerViolation = validateMarker(markerResponse.marker, authority.repository);
  if (markerViolation) {
    throw new Error(`disposable marker capability changed before ${mutation}: ${markerViolation}`);
  }
  if (markerResponse.sha.toLowerCase() !== authority.markerSha.toLowerCase()) {
    throw new Error(`disposable marker generation changed before ${mutation}`);
  }
  evidence.operations.push({
    name: "remote_authority.reverify",
    mutation,
    repository: authority.repository,
    repositoryId: authority.repositoryId,
    baseBranch: authority.baseBranch,
    markerSha: authority.markerSha,
  });
}

async function runAuthorizedRemoteMutation({
  evidence,
  runCommand,
  authority,
  mutation,
  args,
  onAttempt,
}: {
  evidence: Evidence;
  runCommand: RunCommand;
  authority: RemoteAuthority;
  mutation: string;
  args: string[];
  onAttempt?: () => void;
}) {
  await verifyRemoteAuthority({ evidence, runCommand, authority, mutation });
  onAttempt?.();
  evidence.operations.push({
    name: "remote_mutation.attempted",
    mutation,
    repository: authority.repository,
  });
  try {
    const result = await runCommand("gh", args, { maxBuffer: 1024 * 1024 });
    evidence.operations.push({
      name: "remote_mutation.response_received",
      mutation,
      repository: authority.repository,
    });
    return result;
  } catch (error) {
    evidence.operations.push({
      name: "remote_mutation.committed_unknown",
      mutation,
      repository: authority.repository,
      error: safeError(error),
    });
    throw error;
  }
}

function parseObjectSha(stdout: string, label: string) {
  const parsed = parseJson(stdout);
  const sha = String(parsed?.sha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`${label} response did not contain a SHA`);
  return sha;
}

function parseCommitTreeSha(stdout: string, expectedCommitSha: string) {
  const parsed = parseJson(stdout);
  if (String(parsed?.sha || "").toLowerCase() !== expectedCommitSha.toLowerCase()) {
    throw new Error("commit verification response did not match the expected commit SHA");
  }
  const treeSha = String(parsed?.tree?.sha || "").toLowerCase();
  if (!/^[0-9a-f]{40}$/i.test(treeSha)) throw new Error("commit verification response did not contain a tree SHA");
  return { parsed, treeSha };
}

async function createGenerationCommit({
  evidence,
  runCommand,
  authority,
  mutationPrefix,
  parentSha,
  baseTreeSha,
  payloadPath,
  payloadText,
  message,
}: {
  evidence: Evidence;
  runCommand: RunCommand;
  authority: RemoteAuthority;
  mutationPrefix: string;
  parentSha: string;
  baseTreeSha: string;
  payloadPath: string;
  payloadText: string;
  message: string;
}): Promise<GenerationCommit> {
  const encodedPayload = Buffer.from(payloadText, "utf8").toString("base64");
  const blobSha = parseObjectSha(commandStdout(await runAuthorizedRemoteMutation({
    evidence,
    runCommand,
    authority,
    mutation: `${mutationPrefix}.blob.create`,
    args: [
      "api", `repos/${authority.repository}/git/blobs`,
      "-X", "POST",
      "-f", `content=${encodedPayload}`,
      "-f", "encoding=base64",
    ],
  })), "blob creation");
  const verifiedBlob = parseJson(commandStdout(await runCommand("gh", [
    "api", `repos/${authority.repository}/git/blobs/${blobSha}`,
    "-X", "GET",
  ], { maxBuffer: 1024 * 1024 })));
  if (String(verifiedBlob?.sha || "").toLowerCase() !== blobSha
    || String(verifiedBlob?.encoding || "") !== "base64"
    || Buffer.from(String(verifiedBlob?.content || "").replace(/\s+/g, ""), "base64").toString("utf8") !== payloadText) {
    throw new Error("generation blob read-back did not match the exact payload");
  }

  const treeSha = parseObjectSha(commandStdout(await runAuthorizedRemoteMutation({
    evidence,
    runCommand,
    authority,
    mutation: `${mutationPrefix}.tree.create`,
    args: [
      "api", `repos/${authority.repository}/git/trees`,
      "-X", "POST",
      "-f", `base_tree=${baseTreeSha}`,
      "-f", `tree[][path]=${payloadPath}`,
      "-f", "tree[][mode]=100644",
      "-f", "tree[][type]=blob",
      "-f", `tree[][sha]=${blobSha}`,
    ],
  })), "tree creation");
  const verifiedTree = parseJson(commandStdout(await runCommand("gh", [
    "api", `repos/${authority.repository}/git/trees/${treeSha}?recursive=1`,
    "-X", "GET",
  ], { maxBuffer: 1024 * 1024 })));
  const matchingEntries = Array.isArray(verifiedTree?.tree)
    ? verifiedTree.tree.filter((entry: unknown) => {
      const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      return record.path === payloadPath;
    })
    : [];
  if (String(verifiedTree?.sha || "").toLowerCase() !== treeSha
    || verifiedTree?.truncated === true
    || matchingEntries.length !== 1
    || String(matchingEntries[0]?.sha || "").toLowerCase() !== blobSha
    || matchingEntries[0]?.type !== "blob"
    || matchingEntries[0]?.mode !== "100644") {
    throw new Error("generation tree read-back did not bind the exact payload blob");
  }

  const commitSha = parseObjectSha(commandStdout(await runAuthorizedRemoteMutation({
    evidence,
    runCommand,
    authority,
    mutation: `${mutationPrefix}.commit.create`,
    args: [
      "api", `repos/${authority.repository}/git/commits`,
      "-X", "POST",
      "-f", `message=${message}`,
      "-f", `tree=${treeSha}`,
      "-f", `parents[]=${parentSha}`,
    ],
  })), "commit creation");
  const verifiedCommit = parseCommitTreeSha(commandStdout(await runCommand("gh", [
    "api", `repos/${authority.repository}/git/commits/${commitSha}`,
    "-X", "GET",
  ], { maxBuffer: 1024 * 1024 })), commitSha);
  const parents = Array.isArray(verifiedCommit.parsed?.parents) ? verifiedCommit.parsed.parents : [];
  if (verifiedCommit.treeSha !== treeSha
    || parents.length !== 1
    || String(parents[0]?.sha || "").toLowerCase() !== parentSha.toLowerCase()
    || String(verifiedCommit.parsed?.message || "") !== message) {
    throw new Error("generation commit read-back did not bind the exact parent, tree, and message");
  }
  evidence.operations.push({
    name: "generation_commit.verify",
    mutationPrefix,
    repository: authority.repository,
    parentSha,
    commitSha,
    treeSha,
    blobSha,
    payloadPath,
  });
  return { commitSha, treeSha, blobSha };
}

async function atomicUpdateOwnedRef({
  evidence,
  runCommand,
  authority,
  mutation,
  branch,
  beforeOid,
  afterOid,
  clientMutationId,
  onAttempt,
}: {
  evidence: Evidence;
  runCommand: RunCommand;
  authority: RemoteAuthority;
  mutation: string;
  branch: string;
  beforeOid: string;
  afterOid: string;
  clientMutationId: string;
  onAttempt?: () => void;
}) {
  const result = commandStdout(await runAuthorizedRemoteMutation({
    evidence,
    runCommand,
    authority,
    mutation,
    onAttempt,
    args: [
      "api", "graphql",
      "-f", "query=mutation($repositoryId:ID!,$refName:GitRefname!,$beforeOid:GitObjectID!,$afterOid:GitObjectID!,$clientMutationId:String!){updateRefs(input:{repositoryId:$repositoryId,refUpdates:[{name:$refName,beforeOid:$beforeOid,afterOid:$afterOid,force:true}],clientMutationId:$clientMutationId}){clientMutationId}}",
      "-f", `repositoryId=${authority.repositoryId}`,
      "-f", `refName=refs/heads/${branch}`,
      "-f", `beforeOid=${beforeOid}`,
      "-f", `afterOid=${afterOid}`,
      "-f", `clientMutationId=${clientMutationId}`,
    ],
  }));
  parseAtomicRefUpdate(result, clientMutationId);
}

async function readRemoteBranchSha(runCommand: RunCommand, repository: string, branch: string) {
  return parseRefSha(commandStdout(await runCommand("gh", [
    "api",
    `repos/${repository}/git/ref/heads/${branch}`,
    "-X", "GET",
  ], { maxBuffer: 1024 * 1024 })), branch);
}

function assertPullRequestGeneration(
  pullRequest: PullRequestIdentity,
  {
    number,
    branch,
    headSha,
    baseBranch,
    title,
    body,
    repository,
    allowHeadShaChange = false,
  }: {
    number: number;
    branch: string;
    headSha: string;
    baseBranch: string;
    title: string;
    body: string;
    repository: string;
    allowHeadShaChange?: boolean;
  },
) {
  if (pullRequest.number !== number
    || pullRequest.headRef !== branch
    || (!allowHeadShaChange && pullRequest.headSha?.toLowerCase() !== headSha.toLowerCase())
    || pullRequest.baseRef !== baseBranch
    || pullRequest.title !== title
    || pullRequest.body !== body
    || pullRequest.headRepository !== repository.toLowerCase()
    || !pullRequest.draft) {
    throw new Error("pull request no longer matches the owned rehearsal generation");
  }
}

async function discoverOpenPullRequests({
  evidence,
  runCommand,
  repository,
  branch,
}: {
  evidence: Evidence;
  runCommand: RunCommand;
  repository: string;
  branch: string;
}) {
  const owner = repository.split("/", 1)[0];
  const result = await runCommand("gh", [
    "api",
    `repos/${repository}/pulls`,
    "--paginate",
    "--slurp",
    "-X", "GET",
    "-f", "state=open",
    "-f", "per_page=100",
    "-f", `head=${owner}:${branch}`,
  ], { maxBuffer: 1024 * 1024 });
  const discovered = parsePullRequestList(commandStdout(result), branch);
  evidence.operations.push({
    name: "pull_request.discover.open",
    repository,
    branch,
    count: discovered.length,
    numbers: discovered.map((item) => item.number),
  });
  return discovered;
}

async function closePullRequest({
  evidence,
  runCommand,
  authority,
  expectedHeadSha,
  expectedTitle,
  expectedBody,
  allowHeadShaChange = false,
  pullRequest,
  operationName,
}: {
  evidence: Evidence;
  runCommand: RunCommand;
  authority: RemoteAuthority;
  expectedHeadSha: string;
  expectedTitle: string;
  expectedBody: string;
  allowHeadShaChange?: boolean;
  pullRequest: { number: number | null; url?: string | null; draft?: boolean; state?: string | null };
  operationName: string;
}) {
  if (pullRequest.number === null) return false;
  const current = parsePullRequest(commandStdout(await runCommand("gh", [
    "api",
    `repos/${authority.repository}/pulls/${pullRequest.number}`,
    "-X", "GET",
  ], { maxBuffer: 1024 * 1024 })));
  assertPullRequestGeneration(current, {
    number: pullRequest.number,
    branch: evidence.branch || "",
    headSha: expectedHeadSha,
    baseBranch: authority.baseBranch,
    title: expectedTitle,
    body: expectedBody,
    repository: authority.repository,
    allowHeadShaChange,
  });
  if (current.state !== "open") {
    throw new Error("owned rehearsal pull request is not open before cleanup");
  }
  let closeAttempted = false;
  try {
    const closeResult = await runAuthorizedRemoteMutation({
      evidence,
      runCommand,
      authority,
      mutation: `pull_request.close:${pullRequest.number}`,
      onAttempt: () => { closeAttempted = true; },
      args: [
        "api",
        `repos/${authority.repository}/pulls/${pullRequest.number}`,
        "-X", "PATCH",
        "-f", "state=closed",
      ],
    });
    const closeOutput = commandStdout(closeResult);
    if (!closeOutput) throw new Error("rehearsal draft PR close returned no verification payload");
    const closed = parsePullRequest(closeOutput);
    if (closed.state !== "closed") {
      throw new Error("rehearsal draft PR close did not verify state=closed");
    }
    assertPullRequestGeneration(closed, {
      number: pullRequest.number,
      branch: evidence.branch || "",
      headSha: expectedHeadSha,
      baseBranch: authority.baseBranch,
      title: expectedTitle,
      body: expectedBody,
      repository: authority.repository,
      allowHeadShaChange,
    });
    evidence.cleanup.pullRequestClosed = true;
    evidence.pullRequest = {
      number: closed.number || pullRequest.number,
      url: closed.url || pullRequest.url || evidence.pullRequest.url,
      draft: closed.draft || pullRequest.draft === true || evidence.pullRequest.draft,
      state: "closed",
    };
    evidence.operations.push({
      name: operationName,
      repository: authority.repository,
      branch: evidence.branch,
      number: evidence.pullRequest.number,
      state: "closed",
    });
    return true;
  } catch (closeError) {
    if (!closeAttempted) throw closeError;
    try {
      const reconciled = parsePullRequest(commandStdout(await runCommand("gh", [
        "api",
        `repos/${authority.repository}/pulls/${pullRequest.number}`,
        "-X", "GET",
      ], { maxBuffer: 1024 * 1024 })));
      assertPullRequestGeneration(reconciled, {
        number: pullRequest.number,
        branch: evidence.branch || "",
        headSha: expectedHeadSha,
        baseBranch: authority.baseBranch,
        title: expectedTitle,
        body: expectedBody,
        repository: authority.repository,
        allowHeadShaChange,
      });
      if (reconciled.state !== "closed") {
        throw new Error("read-after-error did not verify pull request state=closed");
      }
      evidence.cleanup.pullRequestClosed = true;
      evidence.pullRequest = {
        number: reconciled.number,
        url: reconciled.url || pullRequest.url || evidence.pullRequest.url,
        draft: reconciled.draft,
        state: "closed",
      };
      evidence.operations.push({
        name: `${operationName}.committed_unknown_reconciled`,
        repository: authority.repository,
        branch: evidence.branch,
        number: reconciled.number,
        state: "closed",
      });
      return true;
    } catch (verificationError) {
      throw new AggregateError(
        [closeError, verificationError],
        "pull request close result was uncertain and read-after-attempt reconciliation did not prove closure",
      );
    }
  }
}

async function cleanupBestEffort({
  evidence,
  runCommand,
  authority,
  branch,
  branchCreateAttempted,
  anchorCommitSha,
  payloadTransitionAttempted,
  payloadCommitSha,
  pullRequestCreateAttempted,
  expectedTitle,
  expectedBody,
  generationId,
}: {
  evidence: Evidence;
  runCommand: RunCommand;
  authority: RemoteAuthority;
  branch: string | null;
  branchCreateAttempted: boolean;
  anchorCommitSha: string | null;
  payloadTransitionAttempted: boolean;
  payloadCommitSha: string | null;
  pullRequestCreateAttempted: boolean;
  expectedTitle: string;
  expectedBody: string;
  generationId: string;
}) {
  const repository = authority.repository;
  if (branch && pullRequestCreateAttempted && payloadCommitSha) {
    const prNumber = evidence.pullRequest.number;
    if (prNumber !== null) {
      try {
        await closePullRequest({
          evidence,
          runCommand,
          authority,
          expectedHeadSha: payloadCommitSha,
          expectedTitle,
          expectedBody,
          allowHeadShaChange: true,
          pullRequest: evidence.pullRequest,
          operationName: "pull_request.close.verify",
        });
      } catch (error) {
        addViolation(evidence, "cleanup.pr", "failed to close verified rehearsal draft PR", error);
        evidence.operations.push({
          name: "pull_request.close.failed",
          repository,
          branch,
          number: prNumber,
          error: safeError(error),
        });
      }
    }

    try {
      const discovered = await discoverOpenPullRequests({ evidence, runCommand, repository, branch });
      for (const pullRequest of discovered) {
        if (evidence.cleanup.pullRequestClosed && pullRequest.number === evidence.pullRequest.number) continue;
        if (pullRequest.baseRef !== authority.baseBranch
          || pullRequest.title !== expectedTitle
          || pullRequest.body !== expectedBody
          || pullRequest.headRepository !== repository.toLowerCase()
          || !pullRequest.draft) {
          evidence.operations.push({
            name: "pull_request.cleanup.skip.foreign_generation",
            repository,
            branch,
            number: pullRequest.number,
            expectedHeadSha: payloadCommitSha,
            observedHeadSha: pullRequest.headSha,
          });
          continue;
        }
        if (pullRequest.headSha?.toLowerCase() !== payloadCommitSha.toLowerCase()) {
          evidence.operations.push({
            name: "pull_request.cleanup.generation_head_changed",
            repository,
            branch,
            number: pullRequest.number,
            expectedHeadSha: payloadCommitSha,
            observedHeadSha: pullRequest.headSha,
          });
        }
        try {
          await closePullRequest({
            evidence,
            runCommand,
            authority,
            expectedHeadSha: payloadCommitSha,
            expectedTitle,
            expectedBody,
            allowHeadShaChange: true,
            pullRequest,
            operationName: "pull_request.close.discovered.verify",
          });
        } catch (error) {
          addViolation(evidence, "cleanup.pr.discovered", "failed to close discovered rehearsal draft PR", error);
          evidence.operations.push({
            name: "pull_request.close.discovered.failed",
            repository,
            branch,
            number: pullRequest.number,
            error: safeError(error),
          });
        }
      }
    } catch (error) {
      addViolation(evidence, "cleanup.pr.discover", "failed to discover rehearsal draft PR by generation", error);
      evidence.operations.push({
        name: "pull_request.discover.failed",
        repository,
        branch,
        error: safeError(error),
      });
    }
  }

  if (!branch || !branchCreateAttempted || !anchorCommitSha) return;

  let ownedRefSha: string;
  try {
    const refs = parseMatchingRefs(commandStdout(await runCommand("gh", [
      "api",
      `repos/${repository}/git/matching-refs/heads/${branch}`,
      "-X", "GET",
    ], { maxBuffer: 1024 * 1024 })), branch);
    if (refs.length === 0) {
      evidence.cleanup.branchDeleted = true;
      evidence.operations.push({
        name: "branch.reconcile.absent",
        repository,
        branch,
        branchCreateAttempted: true,
      });
      return;
    }
    const observedSha = refs[0].sha.toLowerCase();
    if (payloadTransitionAttempted && payloadCommitSha && observedSha === payloadCommitSha.toLowerCase()) {
      ownedRefSha = payloadCommitSha.toLowerCase();
      evidence.operations.push({
        name: "branch.reconcile.payload_generation",
        repository,
        branch,
        observedSha,
        committedUnknownRecovered: true,
      });
    } else if (observedSha === anchorCommitSha.toLowerCase()) {
      ownedRefSha = anchorCommitSha.toLowerCase();
      evidence.operations.push({
        name: "branch.reconcile.anchor_generation",
        repository,
        branch,
        observedSha,
        payloadTransitionAttempted,
      });
    } else {
      const successorError = Object.assign(
        new Error("remote branch is not an exact owned anchor or payload generation; preserving ref"),
        { successorPreserved: true },
      );
      addViolation(evidence, "cleanup.branch.successor", "preserved foreign or successor branch generation", successorError);
      evidence.operations.push({
        name: "branch.reconcile.foreign_generation",
        repository,
        branch,
        anchorCommitSha,
        payloadCommitSha,
        observedSha,
        successorPreserved: true,
      });
      return;
    }
  } catch (error) {
    addViolation(evidence, "cleanup.branch.reconcile", "failed to reconcile committed-unknown branch generation", error);
    evidence.operations.push({
      name: "branch.reconcile.failed",
      repository,
      branch,
      anchorCommitSha,
      payloadCommitSha,
      error: safeError(error),
    });
    return;
  }

  let mutationError: unknown = null;
  try {
    const beforeRefs = parseMatchingRefs(commandStdout(await runCommand("gh", [
      "api",
      `repos/${repository}/git/matching-refs/heads/${branch}`,
      "-X", "GET",
    ], { maxBuffer: 1024 * 1024 })), branch);
    if (beforeRefs.length === 0) {
      evidence.cleanup.branchDeleted = true;
      evidence.operations.push({
        name: "branch.delete.verify.already_absent",
        repository,
        branch,
        expectedSha: ownedRefSha,
      });
      return;
    }
    const observedSha = beforeRefs[0].sha.toLowerCase();
    if (observedSha !== ownedRefSha) {
      const successorError = Object.assign(
        new Error("remote branch changed after reconciliation; preserving successor ref"),
        { successorPreserved: true },
      );
      addViolation(evidence, "cleanup.branch.successor", "preserved successor branch generation", successorError);
      evidence.operations.push({
        name: "branch.delete.skip.successor",
        repository,
        branch,
        expectedSha: ownedRefSha,
        observedSha,
        successorPreserved: true,
      });
      return;
    }

    const clientMutationId = `${generationId}:delete-ref`;
    await atomicUpdateOwnedRef({
      evidence,
      runCommand,
      authority,
      mutation: "branch.delete",
      branch,
      beforeOid: ownedRefSha,
      afterOid: ZERO_OID,
      clientMutationId,
    });
    evidence.operations.push({
      name: "branch.delete.atomic.commit",
      repository,
      branch,
      expectedSha: ownedRefSha,
      clientMutationId,
    });
  } catch (error) {
    mutationError = error;
    addViolation(evidence, "cleanup.branch.delete", "atomic rehearsal branch deletion failed", error);
    evidence.operations.push({
      name: "branch.delete.atomic.failed",
      repository,
      branch,
      expectedSha: ownedRefSha,
      error: safeError(error),
    });
  }

  try {
    const refs = parseMatchingRefs(commandStdout(await runCommand("gh", [
      "api",
      `repos/${repository}/git/matching-refs/heads/${branch}`,
      "-X", "GET",
    ], { maxBuffer: 1024 * 1024 })), branch);
    if (refs.length === 0) {
      evidence.cleanup.branchDeleted = true;
      evidence.operations.push({
        name: "branch.delete.verify",
        repository,
        branch,
        expectedSha: ownedRefSha,
        deleted: true,
        mutationReportedError: mutationError !== null,
      });
    } else if (refs[0].sha.toLowerCase() !== ownedRefSha) {
      const successorError = Object.assign(
        new Error("successor branch appeared after owned generation cleanup; preserving ref"),
        { successorPreserved: true },
      );
      addViolation(evidence, "cleanup.branch.successor", "preserved successor branch generation", successorError);
      evidence.operations.push({
        name: "branch.delete.verify.successor",
        repository,
        branch,
        expectedSha: ownedRefSha,
        observedSha: refs[0].sha,
        successorPreserved: true,
      });
    } else {
      if (mutationError === null) {
        addViolation(evidence, "cleanup.branch.verify", "atomic deletion returned success but owned branch still exists");
      }
      evidence.operations.push({
        name: "branch.delete.verify.owned_remains",
        repository,
        branch,
        expectedSha: ownedRefSha,
        mutationReportedError: mutationError !== null,
      });
    }
  } catch (error) {
    addViolation(evidence, "cleanup.branch.verify", "failed to verify rehearsal branch cleanup", error);
    evidence.operations.push({
      name: "branch.delete.verify.failed",
      repository,
      branch,
      expectedSha: ownedRefSha,
      error: safeError(error),
    });
  }
}

export async function rehearseDisposableDraftPr(options: RehearsalOptions = {}) {
  const env = options.env || process.env;
  const commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 15_000;
  const runCommand = boundedRunCommand(options.runCommand || defaultRunCommand, options.signal, commandTimeoutMs);
  const cleanupRunCommand = boundedRunCommand(options.runCommand || defaultRunCommand, undefined, cleanupTimeoutMs);
  const now = options.now || (() => new Date());
  const idGenerator = options.idGenerator || (() => crypto.randomUUID());
  const cli = parseCli(options.argv || process.argv);
  const root = path.resolve(options.root || cli.root || process.cwd());
  const repository = cli.owner && cli.repo ? `${cli.owner}/${cli.repo}`.toLowerCase() : null;
  const requestedBaseBranch = cli.baseBranch;
  const evidence: Evidence = {
    schemaVersion: 1,
    generator: EVIDENCE_GENERATOR,
    generatedAt: now().toISOString(),
    ok: false,
    mode: cli.execute ? "live" : "preflight",
    target: {
      repository,
      baseBranch: requestedBaseBranch,
      markerVerified: false,
      disposable: false,
      markerPath: null,
      markerSha: null,
    },
    branch: null,
    pullRequest: {
      number: null,
      url: null,
      draft: false,
      state: null,
    },
    cleanup: {
      pullRequestClosed: false,
      branchDeleted: false,
    },
    operations: [],
    violations: [],
  };

  if (!repository) {
    addViolation(evidence, "target", "target owner/repo is required via --repository owner/repo or --owner owner --repo repo");
    return evidence;
  }

  let originRepository: string | null = null;
  try {
    const configuredOrigins = commandStdout(await runCommand("git", [
      "config",
      "--get-all",
      "remote.origin.url",
    ], { cwd: root })).split(/\r?\n/).filter(Boolean);
    if (configuredOrigins.length !== 1) {
      throw new Error("current checkout must have exactly one configured origin URL");
    }
    const effectiveFetchOrigins = commandStdout(await runCommand("git", [
      "remote",
      "get-url",
      "--all",
      "origin",
    ], { cwd: root })).split(/\r?\n/).filter(Boolean);
    const effectivePushOrigins = commandStdout(await runCommand("git", [
      "remote",
      "get-url",
      "--push",
      "--all",
      "origin",
    ], { cwd: root })).split(/\r?\n/).filter(Boolean);
    if (effectiveFetchOrigins.length !== 1 || effectivePushOrigins.length !== 1) {
      throw new Error("current origin must resolve to exactly one fetch URL and one push URL");
    }
    const resolvedRepositories = [...effectiveFetchOrigins, ...effectivePushOrigins].map(normalizeGitHubRepo);
    if (resolvedRepositories.some((entry) => !entry)) {
      throw new Error("current origin effective fetch or push URL is not an unambiguous GitHub repository");
    }
    const uniqueRepositories = new Set(resolvedRepositories as string[]);
    if (uniqueRepositories.size !== 1) {
      throw new Error("current origin fetch and push URLs resolve to different repositories");
    }
    originRepository = [...uniqueRepositories][0];
  } catch (error) {
    addViolation(evidence, "origin", "could not resolve current origin repository", error);
  }
  if (originRepository && originRepository === repository.toLowerCase()) {
    addViolation(evidence, "target", "disposable target must not match the current origin repository");
  } else if (originRepository) {
    evidence.operations.push({
      name: "origin.verify",
      repository: originRepository,
      targetRepository: repository,
      different: true,
    });
  }

  if (!cli.execute) {
    addViolation(evidence, "mode", "preflight only; pass --execute with the exact ack env to run the live disposable rehearsal");
    return evidence;
  }

  const requiredAck = `${ACK_PREFIX}${repository}`;
  if (env[ACK_ENV] !== requiredAck) {
    addViolation(evidence, "ack", `${ACK_ENV} must exactly equal ${requiredAck}`);
    return evidence;
  }
  if (evidence.violations.length > 0) return evidence;

  try {
    await runCommand("gh", ["auth", "status"], { maxBuffer: 1024 * 1024 });
    evidence.operations.push({ name: "github.auth.verify", authenticated: true });
  } catch (error) {
    addViolation(evidence, "github.auth", "gh authentication is required for live rehearsal", error);
    return evidence;
  }

  try {
    const view = parseRepositoryView(commandStdout(await runCommand("gh", [
      "repo",
      "view",
      repository,
      "--json",
      "id,defaultBranchRef",
    ], { maxBuffer: 1024 * 1024 })));
    evidence.target.repositoryId = view.id;
    evidence.target.baseBranch = cli.baseBranch || view.defaultBranch;
    if (view.id === null || view.id === undefined || String(view.id).trim() === "") {
      throw new Error("target repository did not report a stable repository id");
    }
    if (!validBranchName(evidence.target.baseBranch)) {
      throw new Error("target base branch has an unsafe ref name");
    }
    evidence.operations.push({
      name: "repository.verify",
      repository,
      repositoryId: view.id,
      baseBranch: evidence.target.baseBranch,
    });
  } catch (error) {
    addViolation(evidence, "target", "failed to read target repository metadata", error);
    return evidence;
  }

  try {
    const markerResponse = parseMarkerResponse(commandStdout(await runCommand("gh", [
      "api",
      `repos/${repository}/contents/${MARKER_PATH}?ref=${encodeURIComponent(evidence.target.baseBranch || "")}`,
    ], { maxBuffer: 1024 * 1024 })));
    const markerViolation = validateMarker(markerResponse.marker, repository);
    if (markerViolation) {
      addViolation(evidence, "marker", markerViolation);
      return evidence;
    }
    evidence.target.markerVerified = true;
    evidence.target.disposable = true;
    evidence.target.markerPath = markerResponse.path;
    evidence.target.markerSha = markerResponse.sha;
    evidence.operations.push({
      name: "marker.verify",
      repository,
      baseBranch: evidence.target.baseBranch,
      path: markerResponse.path,
      sha: markerResponse.sha,
      purpose: MARKER_PURPOSE,
    });
  } catch (error) {
    addViolation(evidence, "marker", "failed to verify disposable target marker", error);
    return evidence;
  }

  const authority: RemoteAuthority = {
    repository,
    repositoryId: String(evidence.target.repositoryId),
    baseBranch: String(evidence.target.baseBranch),
    markerSha: String(evidence.target.markerSha),
  };

  const id = idGenerator().replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
  if (!id) {
    addViolation(evidence, "branch", "rehearsal id must contain at least one safe character");
    return evidence;
  }
  const branch = `${BRANCH_PREFIX}/${id}`;
  evidence.branch = branch;
  const base = evidence.target.baseBranch;
  if (!base) {
    addViolation(evidence, "target", "target base branch is required");
    return evidence;
  }
  let branchCreateAttempted = false;
  let payloadTransitionAttempted = false;
  let pullRequestCreateAttempted = false;
  let anchorCommitSha: string | null = null;
  let payloadCommitSha: string | null = null;
  const expectedTitle = `CodePatchBay disposable draft PR rehearsal ${id}`;
  const expectedBody = `Automated disposable draft PR rehearsal generation ${id} on ${branch}. This PR must be closed by the rehearsal script.`;
  const payloadPath = `.cpb-release-rehearsals/${id}.json`;

  try {
    const baseSha = commandStdout(await runCommand("gh", [
      "api",
      `repos/${repository}/git/ref/heads/${base}`,
      "--jq",
      ".object.sha",
    ], { maxBuffer: 1024 * 1024 })).toLowerCase();
    if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
      throw new Error("target base branch did not resolve to a commit SHA");
    }
    const baseCommit = parseCommitTreeSha(commandStdout(await runCommand("gh", [
      "api", `repos/${repository}/git/commits/${baseSha}`,
      "-X", "GET",
    ], { maxBuffer: 1024 * 1024 })), baseSha);

    const anchorPayload = `${JSON.stringify({
      schemaVersion: 1,
      purpose: "codepatchbay-disposable-draft-pr-rehearsal",
      phase: "anchor",
      generationId: id,
      generatedAt: evidence.generatedAt,
      repository,
      branch,
      parentSha: baseSha,
      noProductionIntent: true,
    }, null, 2)}\n`;
    const anchorGeneration = await createGenerationCommit({
      evidence,
      runCommand,
      authority,
      mutationPrefix: "generation.anchor",
      parentSha: baseSha,
      baseTreeSha: baseCommit.treeSha,
      payloadPath,
      payloadText: anchorPayload,
      message: `CodePatchBay disposable draft PR anchor ${id}`,
    });
    anchorCommitSha = anchorGeneration.commitSha;

    const payloadText = `${JSON.stringify({
      schemaVersion: 1,
      purpose: "codepatchbay-disposable-draft-pr-rehearsal",
      phase: "payload",
      generationId: id,
      generatedAt: evidence.generatedAt,
      repository,
      branch,
      parentSha: anchorGeneration.commitSha,
      noProductionIntent: true,
    }, null, 2)}\n`;
    const payloadGeneration = await createGenerationCommit({
      evidence,
      runCommand,
      authority,
      mutationPrefix: "generation.payload",
      parentSha: anchorGeneration.commitSha,
      baseTreeSha: anchorGeneration.treeSha,
      payloadPath,
      payloadText,
      message: `CodePatchBay disposable draft PR payload ${id}`,
    });
    payloadCommitSha = payloadGeneration.commitSha;

    const existingRefs = parseMatchingRefs(commandStdout(await runCommand("gh", [
      "api", `repos/${repository}/git/matching-refs/heads/${branch}`,
      "-X", "GET",
    ], { maxBuffer: 1024 * 1024 })), branch);
    if (existingRefs.length > 0) {
      throw new Error("rehearsal branch already exists before mutation; preserving pre-existing ref");
    }

    const branchCreateOutput = commandStdout(await runAuthorizedRemoteMutation({
      evidence,
      runCommand,
      authority,
      mutation: "branch.create",
      onAttempt: () => { branchCreateAttempted = true; },
      args: [
        "api",
        `repos/${repository}/git/refs`,
        "-X", "POST",
        "-f", `ref=refs/heads/${branch}`,
        "-f", `sha=${anchorGeneration.commitSha}`,
      ],
    }));
    evidence.operations.push({
      name: "branch.create.owned",
      repository,
      branch,
      baseSha,
      anchorCommitSha: anchorGeneration.commitSha,
    });
    const createdRefSha = parseRefSha(branchCreateOutput, branch);
    if (createdRefSha !== anchorGeneration.commitSha) {
      throw new Error("created rehearsal branch did not point to the unique anchor generation");
    }
    evidence.operations.push({
      name: "branch.create.verify",
      repository,
      branch,
      anchorCommitSha: anchorGeneration.commitSha,
      refSha: createdRefSha,
    });

    await atomicUpdateOwnedRef({
      evidence,
      runCommand,
      authority,
      mutation: "payload.ref_update",
      branch,
      beforeOid: anchorGeneration.commitSha,
      afterOid: payloadGeneration.commitSha,
      clientMutationId: `${id}:payload-ref`,
      onAttempt: () => { payloadTransitionAttempted = true; },
    });
    const observedPayloadSha = await readRemoteBranchSha(runCommand, repository, branch);
    if (observedPayloadSha !== payloadGeneration.commitSha) {
      throw new Error("payload ref update did not verify the unique payload generation");
    }
    evidence.operations.push({
      name: "payload.ref_update.verify",
      repository,
      branch,
      path: payloadPath,
      anchorCommitSha: anchorGeneration.commitSha,
      payloadCommitSha: payloadGeneration.commitSha,
    });

    const beforePullRequestSha = await readRemoteBranchSha(runCommand, repository, branch);
    if (beforePullRequestSha !== payloadGeneration.commitSha) {
      throw new Error("rehearsal branch generation changed before draft PR creation");
    }
    const created = parsePullRequest(commandStdout(await runAuthorizedRemoteMutation({
      evidence,
      runCommand,
      authority,
      mutation: "pull_request.create",
      onAttempt: () => { pullRequestCreateAttempted = true; },
      args: [
        "api",
        `repos/${repository}/pulls`,
        "-X", "POST",
        "-f", `title=${expectedTitle}`,
        "-f", `head=${branch}`,
        "-f", `base=${base}`,
        "-f", `body=${expectedBody}`,
        "-F", "draft=true",
      ],
    })));
    if (!created.number || !created.draft) {
      throw new Error("created pull request was not verified as a draft");
    }
    assertPullRequestGeneration(created, {
      number: created.number,
      branch,
      headSha: payloadGeneration.commitSha,
      baseBranch: base,
      title: expectedTitle,
      body: expectedBody,
      repository,
    });
    if (created.state !== "open") {
      throw new Error("created rehearsal draft PR did not report state=open");
    }
    evidence.pullRequest = {
      number: created.number,
      url: created.url || null,
      draft: created.draft,
      state: created.state,
    };
    evidence.operations.push({
      name: "pull_request.create.verify",
      repository,
      branch,
      baseBranch: base,
      number: created.number,
      url: created.url,
      draft: true,
      state: created.state,
    });

    const verified = parsePullRequest(commandStdout(await runCommand("gh", [
      "api",
      `repos/${repository}/pulls/${created.number}`,
    ], { maxBuffer: 1024 * 1024 })));
    evidence.pullRequest = {
      number: verified.number || created.number,
      url: verified.url || created.url || null,
      draft: verified.draft,
      state: verified.state,
    };
    assertPullRequestGeneration(verified, {
      number: created.number,
      branch,
      headSha: payloadGeneration.commitSha,
      baseBranch: base,
      title: expectedTitle,
      body: expectedBody,
      repository,
    });
    if (verified.state !== "open") {
      throw new Error("live rehearsal pull request verification did not report state=open");
    }
    evidence.operations.push({
      name: "pull_request.read.verify",
      repository,
      branch,
      number: evidence.pullRequest.number,
      url: evidence.pullRequest.url,
      draft: true,
      state: evidence.pullRequest.state,
    });
  } catch (error) {
    addViolation(evidence, "live", "disposable draft PR rehearsal failed", error);
  } finally {
    await cleanupBestEffort({
      evidence,
      runCommand: cleanupRunCommand,
      authority,
      branch,
      branchCreateAttempted,
      anchorCommitSha,
      payloadTransitionAttempted,
      payloadCommitSha,
      pullRequestCreateAttempted,
      expectedTitle,
      expectedBody,
      generationId: id,
    });
  }

  evidence.ok = evidence.mode === "live"
    && evidence.target.markerVerified
    && evidence.target.disposable
    && evidence.pullRequest.draft
    && evidence.pullRequest.state === "closed"
    && evidence.cleanup.pullRequestClosed
    && evidence.cleanup.branchDeleted
    && evidence.violations.length === 0;
  return evidence;
}

export async function writeEvidenceFile(output: string, evidence: Evidence) {
  const resolved = path.resolve(output);
  await writeJsonAtomic(resolved, evidence);
}

export async function runDisposableDraftPrCli(options: RehearsalCliOptions = {}) {
  const {
    processRef = process,
    writeStdout = (value: string) => console.log(value),
    writeStderr = (value: string) => console.error(value),
    ...rehearsalOptions
  } = options;
  const controller = new AbortController();
  let signalExitCode: 130 | 143 | null = null;
  const onSignal = (signal: "SIGINT" | "SIGTERM", exitCode: 130 | 143) => () => {
    if (signalExitCode === null) signalExitCode = exitCode;
    if (!controller.signal.aborted) controller.abort(new Error(`received ${signal}`));
  };
  const onSigint = onSignal("SIGINT", 130);
  const onSigterm = onSignal("SIGTERM", 143);
  processRef.on("SIGINT", onSigint);
  processRef.on("SIGTERM", onSigterm);
  try {
    const evidence = await rehearseDisposableDraftPr({
      ...rehearsalOptions,
      argv: processRef.argv,
      env: processRef.env,
      signal: controller.signal,
    });
    const output = valueAfter(processRef.argv.slice(2), "--output");
    if (output) await writeEvidenceFile(output, evidence);
    writeStdout(JSON.stringify(evidence, null, 2));
    processRef.exitCode = signalExitCode ?? (evidence.ok ? 0 : 1);
    return evidence;
  } catch (error) {
    writeStderr(JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: safeError(error),
    }, null, 2));
    processRef.exitCode = signalExitCode ?? 1;
    return null;
  } finally {
    processRef.removeListener("SIGINT", onSigint);
    processRef.removeListener("SIGTERM", onSigterm);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runDisposableDraftPrCli();
}
