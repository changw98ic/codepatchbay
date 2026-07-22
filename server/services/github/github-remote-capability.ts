import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { LooseRecord } from "../../../shared/types.js";

const execFileAsync = promisify(execFileCb);

export const GITHUB_REMOTE_CAPABILITY_SCHEMA = "cpb.github-remote-capability.v1";
export const GITHUB_REMOTE_MARKER_PATH = ".cpb-disposable-target.json";
export const GITHUB_REMOTE_MARKER_PURPOSE = "codepatchbay-release-rehearsal";

export type GithubRemoteWriteOperation =
  | "repository.push"
  | "pull_request.create"
  | "pull_request.merge"
  | "issue.close";

export type GithubTransportPrincipal = {
  kind: "github_app" | "gh_user";
  stableId: string;
  login: string;
  authorId?: string;
};

export type GithubRemoteCapability = {
  schema: typeof GITHUB_REMOTE_CAPABILITY_SCHEMA;
  repository: string;
  repositoryId: string;
  defaultBranch: string;
  markerPath: typeof GITHUB_REMOTE_MARKER_PATH;
  markerSha: string;
  issueNumber: number;
  automationLabel: string;
  allowedBranchPrefix: string;
  permissions: {
    repositoryPush: boolean;
    pullRequestCreate: boolean;
    pullRequestMerge: boolean;
    issueClose: boolean;
  };
  pullRequest?: {
    number: number;
    headBranch: string;
    baseBranch: string;
    headSha: string;
  };
};

export type GithubRemoteAuthorityRequest = {
  capability: GithubRemoteCapability | LooseRecord;
  operation: GithubRemoteWriteOperation;
  repository: string;
  issueNumber: string | number;
  targetBranch?: string | null;
  pushKind?: "default-branch" | "pull-request-branch" | null;
  headBranch?: string | null;
  baseBranch?: string | null;
  pullRequestNumber?: string | number | null;
  commit?: string | null;
  title?: string | null;
  body?: string | null;
  draft?: boolean | null;
  authorLogin?: string | null;
  authorId?: string | number | null;
};

export type GithubRemoteWriteVerification = {
  committed: boolean | null;
  operation: GithubRemoteWriteOperation;
  evidence?: LooseRecord;
  reason?: string;
  principal?: GithubTransportPrincipal;
};

export type GithubRemoteFinalizationReconciliation = {
  committed: boolean | null;
  pushed: boolean | null;
  closed: boolean | null;
  nextOperation: "repository.push" | "issue.close" | null;
  evidence?: LooseRecord;
  reason?: string;
};

type CommandResult = Omit<LooseRecord, "status"> & {
  stdout?: string;
  stderr?: string;
  code?: string | number | null;
  exitCode?: string | number | null;
  status?: string | number | null;
  ok?: boolean;
};

export type GithubRemoteRunCommand = (
  command: string,
  args: string[],
  options?: LooseRecord,
) => Promise<CommandResult | string>;

export type GithubRemoteAuthorityValidator = (
  request: GithubRemoteAuthorityRequest,
) => Promise<LooseRecord | void>;

export type GithubRemoteCommitVerifier = (
  request: GithubRemoteAuthorityRequest,
) => Promise<GithubRemoteWriteVerification>;

const GITHUB_REMOTE_WRITE_OPERATIONS = new Set<GithubRemoteWriteOperation>([
  "repository.push",
  "pull_request.create",
  "pull_request.merge",
  "issue.close",
]);

function assertKnownOperation(value: unknown): asserts value is GithubRemoteWriteOperation {
  if (typeof value !== "string" || !GITHUB_REMOTE_WRITE_OPERATIONS.has(value as GithubRemoteWriteOperation)) {
    throw new Error("unknown GitHub remote write operation");
  }
}

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical((value as LooseRecord)[key])]),
  );
}

function capabilityVerificationEvidence(capability: GithubRemoteCapability) {
  return {
    repository: capability.repository,
    repositoryId: capability.repositoryId,
    issueNumber: capability.issueNumber,
    capabilityDigest: createHash("sha256")
      .update(JSON.stringify(canonical(capability)), "utf8")
      .digest("hex"),
  };
}

function requiredString(value: unknown, field: string) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function normalizeRepository(value: unknown) {
  const repository = requiredString(value, "remoteCapability.repository").toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) {
    throw new Error("remoteCapability.repository must be owner/repo");
  }
  return repository;
}

function validGitRef(value: string) {
  return /^[A-Za-z0-9._/-]+$/.test(value)
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("..")
    && !value.includes("//");
}

function positiveNumber(value: unknown, field = "remoteCapability.issueNumber") {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error(`${field} must be one positive integer`);
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${field} must be a safe positive integer`);
  }
  return number;
}

function positiveIssueNumber(value: unknown) {
  return positiveNumber(value, "remoteCapability.issueNumber");
}

function permissionValue(permissions: LooseRecord, key: string) {
  if (typeof permissions[key] !== "boolean") {
    throw new Error(`remoteCapability.permissions.${key} must be boolean`);
  }
  return permissions[key] as boolean;
}

export function normalizeGithubRemoteCapability(value: unknown): GithubRemoteCapability {
  const input = recordValue(value);
  if (input.schema !== GITHUB_REMOTE_CAPABILITY_SCHEMA) {
    throw new Error(`remoteCapability.schema must be ${GITHUB_REMOTE_CAPABILITY_SCHEMA}`);
  }
  const defaultBranch = requiredString(input.defaultBranch, "remoteCapability.defaultBranch");
  if (!validGitRef(defaultBranch)) throw new Error("remoteCapability.defaultBranch is unsafe");
  const allowedBranchPrefix = requiredString(input.allowedBranchPrefix, "remoteCapability.allowedBranchPrefix");
  if (!validGitRef(`${allowedBranchPrefix}placeholder`) || !allowedBranchPrefix.endsWith("/")) {
    throw new Error("remoteCapability.allowedBranchPrefix must be a safe branch prefix ending in '/'");
  }
  const markerSha = requiredString(input.markerSha, "remoteCapability.markerSha").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(markerSha)) throw new Error("remoteCapability.markerSha must be a Git blob SHA");
  if (input.markerPath !== GITHUB_REMOTE_MARKER_PATH) {
    throw new Error(`remoteCapability.markerPath must be ${GITHUB_REMOTE_MARKER_PATH}`);
  }
  const automationLabel = requiredString(input.automationLabel, "remoteCapability.automationLabel");
  if (automationLabel.length > 100 || /[\u0000-\u001f\u007f]/.test(automationLabel)) {
    throw new Error("remoteCapability.automationLabel is unsafe");
  }
  const permissions = recordValue(input.permissions);
  let pullRequest: GithubRemoteCapability["pullRequest"];
  if (input.pullRequest !== undefined && input.pullRequest !== null) {
    const binding = recordValue(input.pullRequest);
    const headBranch = requiredString(binding.headBranch, "remoteCapability.pullRequest.headBranch");
    const baseBranch = requiredString(binding.baseBranch, "remoteCapability.pullRequest.baseBranch");
    const headSha = requiredString(binding.headSha, "remoteCapability.pullRequest.headSha").toLowerCase();
    if (!validGitRef(headBranch) || !headBranch.startsWith(allowedBranchPrefix)) {
      throw new Error("remoteCapability.pullRequest.headBranch is outside the capability");
    }
    if (baseBranch !== defaultBranch) {
      throw new Error("remoteCapability.pullRequest.baseBranch must equal the bound default branch");
    }
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      throw new Error("remoteCapability.pullRequest.headSha must be a Git commit SHA");
    }
    pullRequest = {
      number: positiveNumber(binding.number, "remoteCapability.pullRequest.number"),
      headBranch,
      baseBranch,
      headSha,
    };
  }
  return {
    schema: GITHUB_REMOTE_CAPABILITY_SCHEMA,
    repository: normalizeRepository(input.repository),
    repositoryId: requiredString(input.repositoryId, "remoteCapability.repositoryId"),
    defaultBranch,
    markerPath: GITHUB_REMOTE_MARKER_PATH,
    markerSha,
    issueNumber: positiveIssueNumber(input.issueNumber),
    automationLabel,
    allowedBranchPrefix,
    permissions: {
      repositoryPush: permissionValue(permissions, "repositoryPush"),
      pullRequestCreate: permissionValue(permissions, "pullRequestCreate"),
      pullRequestMerge: permissionValue(permissions, "pullRequestMerge"),
      issueClose: permissionValue(permissions, "issueClose"),
    },
    ...(pullRequest ? { pullRequest } : {}),
  };
}

export function encodeGithubRemoteCapability(value: unknown) {
  return Buffer.from(JSON.stringify(normalizeGithubRemoteCapability(value)), "utf8").toString("base64url");
}

export function decodeGithubRemoteCapability(value: unknown) {
  const encoded = requiredString(value, "GitHub remote capability");
  if (encoded.length > 32_768 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("GitHub remote capability encoding is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (cause) {
    throw new Error("GitHub remote capability is not valid encoded JSON", { cause });
  }
  return normalizeGithubRemoteCapability(parsed);
}

function commandFailure(result: CommandResult, operation: string) {
  if (result.ok === false) return `${operation} returned ok=false`;
  for (const field of ["code", "exitCode", "status"] as const) {
    if (!Object.prototype.hasOwnProperty.call(result, field)) continue;
    const value = result[field];
    const normalized = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof normalized !== "number" || !Number.isFinite(normalized) || normalized !== 0) {
      return `${operation} exited with ${field} ${value}`;
    }
  }
  return null;
}

function assertCommandSuccess(value: CommandResult | string, operation: string) {
  const result = typeof value === "string" ? { stdout: value, stderr: "" } : value;
  const failure = commandFailure(result, operation);
  if (failure) {
    throw Object.assign(new Error(`${failure}${result.stderr ? `: ${result.stderr}` : ""}`), {
      code: "GITHUB_REMOTE_COMMAND_FAILED",
      committed: null,
      operation,
    });
  }
  return result;
}

async function runGhJson(
  args: string[],
  operation: string,
  runCommand: GithubRemoteRunCommand,
) {
  const result = assertCommandSuccess(await runCommand("gh", args, {
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
  }), operation);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(result.stdout || ""));
  } catch (cause) {
    throw Object.assign(new Error(`${operation} returned invalid JSON`, { cause }), {
      code: "GITHUB_REMOTE_INVALID_RESPONSE",
      committed: null,
      operation,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error(`${operation} returned a non-object JSON response`), {
      code: "GITHUB_REMOTE_INVALID_RESPONSE",
      committed: null,
      operation,
    });
  }
  return parsed as LooseRecord;
}

async function runGhJsonPages(
  args: string[],
  operation: string,
  runCommand: GithubRemoteRunCommand,
) {
  const result = assertCommandSuccess(await runCommand("gh", args, {
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8",
  }), operation);
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(result.stdout || ""));
  } catch (cause) {
    throw Object.assign(new Error(`${operation} returned invalid JSON`, { cause }), {
      code: "GITHUB_REMOTE_INVALID_RESPONSE",
      committed: null,
      operation,
    });
  }
  if (!Array.isArray(parsed)) return invalidResponse(operation, "paginated response");
  if (parsed.length === 0) return [] as LooseRecord[];
  const pages = parsed.every(Array.isArray) ? parsed : [parsed];
  if (!pages.every((page) => Array.isArray(page))) return invalidResponse(operation, "paginated response");
  const records = pages.flat();
  if (records.some((entry) => entry === null || typeof entry !== "object" || Array.isArray(entry))) {
    return invalidResponse(operation, "paginated response entry");
  }
  return records as LooseRecord[];
}

function invalidResponse(operation: string, field: string): never {
  throw Object.assign(new Error(`${operation} returned an invalid ${field}`), {
    code: "GITHUB_REMOTE_INVALID_RESPONSE",
    committed: null,
    operation,
  });
}

function responseRecord(value: unknown, operation: string, field: string) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidResponse(operation, field);
  }
  return value as LooseRecord;
}

function responseString(value: unknown, operation: string, field: string) {
  if (typeof value !== "string" || !value.trim()) return invalidResponse(operation, field);
  return value;
}

function responsePositiveNumber(value: unknown, operation: string, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalidResponse(operation, field);
  }
  return value;
}

function responseBoolean(value: unknown, operation: string, field: string) {
  if (typeof value !== "boolean") return invalidResponse(operation, field);
  return value;
}

function responseSha(value: unknown, operation: string, field: string) {
  const sha = responseString(value, operation, field).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) return invalidResponse(operation, field);
  return sha;
}

function responseState(value: unknown, allowed: string[], operation: string, field: string) {
  const state = responseString(value, operation, field).toUpperCase();
  if (!allowed.includes(state)) return invalidResponse(operation, field);
  return state;
}

function responseIssueIdentity(
  response: LooseRecord,
  capability: GithubRemoteCapability,
  operation: string,
) {
  const number = responsePositiveNumber(response.number, operation, "issue number");
  const url = responseString(response.url, operation, "issue URL");
  const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)$/i);
  if (
    !match
    || match[1].toLowerCase() !== capability.repository
    || Number(match[2]) !== capability.issueNumber
    || number !== capability.issueNumber
  ) {
    return invalidResponse(operation, "issue identity");
  }
  return { number, url };
}

function responseIssueLabels(response: LooseRecord, operation: string) {
  if (!Array.isArray(response.labels)) return invalidResponse(operation, "issue labels");
  return response.labels.map((label) => {
    const name = typeof label === "string" ? label : recordValue(label).name;
    if (
      typeof name !== "string"
      || !name
      || name.length > 100
      || /[\u0000-\u001f\u007f]/.test(name)
    ) {
      return invalidResponse(operation, "issue label");
    }
    return name;
  });
}

function requestBody(value: unknown) {
  if (typeof value !== "string" || value.length > 65_536 || value.includes("\u0000")) {
    throw new Error("pull request body is invalid");
  }
  return value;
}

function responseBody(value: unknown, operation: string) {
  if (value === null) return "";
  if (typeof value !== "string") return invalidResponse(operation, "pull request body");
  return value;
}

function githubLogin(value: unknown, field: string) {
  const login = requiredString(value, field).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,38}(?:\[bot\])?$/.test(login)) throw new Error(`${field} is invalid`);
  return login;
}

function githubActorId(value: unknown, field: string) {
  const id = typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? value : "";
  if (!id) throw new Error(`${field} is invalid`);
  return id;
}

function normalizeTransportPrincipal(value: unknown): GithubTransportPrincipal | null {
  if (value === undefined || value === null) return null;
  const input = recordValue(value);
  const kind = input.kind === "github_app" || input.kind === "gh_user" ? input.kind : null;
  const stableId = typeof input.stableId === "string" ? input.stableId.trim() : "";
  const login = typeof input.login === "string" ? input.login.trim().toLowerCase() : "";
  if (!kind || !stableId || !login) throw new Error("GitHub transport principal is invalid");
  const authorId = input.authorId === undefined || input.authorId === null
    ? undefined
    : githubActorId(input.authorId, "GitHub transport principal author ID");
  return { kind, stableId, login, ...(authorId ? { authorId } : {}) };
}

function pullRequestGeneration(rawRequest: GithubRemoteAuthorityRequest) {
  const headBranch = requiredString(rawRequest.headBranch, "pull request head branch");
  const baseBranch = requiredString(rawRequest.baseBranch, "pull request base branch");
  const headSha = requiredString(rawRequest.commit, "pull request expected head SHA").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("pull request expected head SHA is invalid");
  const title = requiredString(rawRequest.title, "pull request title");
  const body = requestBody(rawRequest.body);
  if (rawRequest.draft !== true) throw new Error("pull request creation must remain draft");
  const authorLogin = githubLogin(rawRequest.authorLogin, "pull request author login");
  const authorId = githubActorId(rawRequest.authorId, "pull request author ID");
  return { headBranch, baseBranch, headSha, title, body, draft: true, authorLogin, authorId };
}

function normalizePullRequestRestResponse(value: unknown, operation: string) {
  const pullRequest = responseRecord(value, operation, "pull request");
  const number = responsePositiveNumber(pullRequest.number, operation, "pull request number");
  const state = responseState(pullRequest.state, ["OPEN", "CLOSED"], operation, "pull request state");
  const draft = responseBoolean(pullRequest.draft, operation, "pull request draft state");
  const title = responseString(pullRequest.title, operation, "pull request title");
  const body = responseBody(pullRequest.body, operation);
  const url = responseString(pullRequest.html_url, operation, "pull request URL");
  const author = responseRecord(pullRequest.user, operation, "pull request author");
  const head = responseRecord(pullRequest.head, operation, "pull request head");
  const base = responseRecord(pullRequest.base, operation, "pull request base");
  const headRepo = responseRecord(head.repo, operation, "pull request head repository");
  const baseRepo = responseRecord(base.repo, operation, "pull request base repository");
  return {
    number,
    state,
    draft,
    title,
    body,
    url,
    authorLogin: githubLogin(author.login, "pull request response author login"),
    authorId: githubActorId(author.id, "pull request response author ID"),
    headBranch: responseString(head.ref, operation, "pull request head branch"),
    headSha: responseSha(head.sha, operation, "pull request head SHA"),
    headRepository: normalizeRepository(headRepo.full_name),
    baseBranch: responseString(base.ref, operation, "pull request base branch"),
    baseRepository: normalizeRepository(baseRepo.full_name),
  };
}

function pullRequestGenerationMatches(
  actual: ReturnType<typeof normalizePullRequestRestResponse>,
  expected: ReturnType<typeof pullRequestGeneration>,
  capability: GithubRemoteCapability,
) {
  const urlMatch = actual.url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/i);
  return actual.state === "OPEN"
    && actual.draft === expected.draft
    && actual.title === expected.title
    && actual.body === expected.body
    && actual.authorLogin === expected.authorLogin
    && actual.authorId === expected.authorId
    && actual.headBranch === expected.headBranch
    && actual.headSha === expected.headSha
    && actual.baseBranch === expected.baseBranch
    && actual.headRepository === capability.repository
    && actual.baseRepository === capability.repository
    && Boolean(
      urlMatch
      && urlMatch[1].toLowerCase() === capability.repository
      && Number(urlMatch[2]) === actual.number
    );
}

function pullRequestGenerationEvidence(
  actual: ReturnType<typeof normalizePullRequestRestResponse>,
  expected: ReturnType<typeof pullRequestGeneration>,
  capability: GithubRemoteCapability,
) {
  return {
    number: actual.number,
    state: actual.state,
    draft: actual.draft,
    title: actual.title,
    bodyMatches: actual.body === expected.body,
    bodyLength: actual.body.length,
    url: actual.url,
    authorLogin: actual.authorLogin,
    authorId: actual.authorId,
    headBranch: actual.headBranch,
    headSha: actual.headSha,
    headRepository: actual.headRepository,
    baseBranch: actual.baseBranch,
    baseRepository: actual.baseRepository,
    exactGeneration: pullRequestGenerationMatches(actual, expected, capability),
  };
}

function markerFromResponse(response: LooseRecord, capability: GithubRemoteCapability) {
  if (response.path !== capability.markerPath || String(response.sha || "").toLowerCase() !== capability.markerSha) {
    throw new Error("GitHub disposable target marker identity changed");
  }
  const encoded = String(response.content || "").replace(/\s+/g, "");
  let marker: LooseRecord;
  try {
    marker = recordValue(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
  } catch (cause) {
    throw new Error("GitHub disposable target marker content is invalid", { cause });
  }
  return marker;
}

function assertMarkerAuthority(marker: LooseRecord, capability: GithubRemoteCapability) {
  if (marker.schemaVersion !== 1 || marker.purpose !== GITHUB_REMOTE_MARKER_PURPOSE) {
    throw new Error("GitHub disposable target marker purpose changed");
  }
  if (marker.disposable !== true) {
    throw new Error("GitHub disposable target marker must explicitly set disposable=true");
  }
  if (marker.allowCodePatchBayE2E !== true) {
    throw new Error("GitHub disposable target marker must explicitly allow CodePatchBay E2E writes");
  }
  if (String(marker.repository || "").toLowerCase() !== capability.repository) {
    throw new Error("GitHub disposable target marker repository changed");
  }
  if (
    !Array.isArray(marker.allowedIssueNumbers)
    || marker.allowedIssueNumbers.some((value) => (
      typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0
    ))
  ) {
    throw new Error("GitHub disposable target marker allowedIssueNumbers must contain only positive safe integers");
  }
  const issues = marker.allowedIssueNumbers as number[];
  if (!issues.includes(capability.issueNumber)) {
    throw new Error(`GitHub disposable target marker no longer authorizes issue #${capability.issueNumber}`);
  }
  if (
    !Array.isArray(marker.allowedAutomationLabels)
    || marker.allowedAutomationLabels.some((value) => (
      typeof value !== "string" || !value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)
    ))
  ) {
    throw new Error("GitHub disposable target marker allowedAutomationLabels must contain only safe strings");
  }
  const labels = marker.allowedAutomationLabels as string[];
  if (!labels.includes(capability.automationLabel)) {
    throw new Error(`GitHub disposable target marker no longer authorizes label ${capability.automationLabel}`);
  }
  if (String(marker.allowedBranchPrefix || "") !== capability.allowedBranchPrefix) {
    throw new Error("GitHub disposable target marker branch prefix changed");
  }
}

function permissionForOperation(operation: GithubRemoteWriteOperation) {
  if (operation === "repository.push") return ["repositoryPush", "allowRepositoryPush"] as const;
  if (operation === "pull_request.create") return ["pullRequestCreate", "allowDraftPullRequests"] as const;
  if (operation === "pull_request.merge") return ["pullRequestMerge", "allowPullRequestMerge"] as const;
  return ["issueClose", "allowIssueClose"] as const;
}

function assertBranchAuthority(request: GithubRemoteAuthorityRequest, capability: GithubRemoteCapability) {
  if (request.operation === "repository.push") {
    const target = requiredString(request.targetBranch, "remote push target branch");
    if (request.pushKind === "default-branch") {
      if (target !== capability.defaultBranch) {
        throw new Error(`remote finalization must push the bound default branch '${capability.defaultBranch}'`);
      }
    } else if (request.pushKind === "pull-request-branch") {
      if (target === capability.defaultBranch || !target.startsWith(capability.allowedBranchPrefix)) {
        throw new Error(`pull request branch '${target}' is outside the capability`);
      }
    } else {
      throw new Error("remote push kind is required");
    }
  }
  if (request.operation === "pull_request.create" || request.operation === "pull_request.merge") {
    const base = requiredString(request.baseBranch, "pull request base branch");
    if (base !== capability.defaultBranch) throw new Error("pull request base branch changed");
    const head = requiredString(request.headBranch, "pull request head branch");
    if (!head.startsWith(capability.allowedBranchPrefix)) {
      throw new Error("pull request head branch is outside the capability");
    }
  }
  if (request.operation === "pull_request.create") {
    const commit = requiredString(request.commit, "pull request expected head SHA").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("pull request expected head SHA is invalid");
    const title = requiredString(request.title, "pull request title");
    if (title.length > 256 || /[\u0000-\u001f\u007f]/.test(title)) {
      throw new Error("pull request title is unsafe");
    }
    requestBody(request.body);
    if (request.draft !== true) throw new Error("pull request creation must remain draft");
  }
  if (request.operation === "pull_request.merge") {
    const binding = capability.pullRequest;
    if (!binding) throw new Error("GitHub capability does not bind one pull request for merge");
    const number = positiveNumber(request.pullRequestNumber, "pull request number");
    const headSha = requiredString(request.commit, "pull request head SHA").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("pull request head SHA is invalid");
    if (
      number !== binding.number
      || request.headBranch !== binding.headBranch
      || request.baseBranch !== binding.baseBranch
      || headSha !== binding.headSha
    ) {
      throw new Error("pull request merge target is outside the bound capability");
    }
  }
}

export async function assertGithubRemoteWriteAuthorized(
  rawRequest: GithubRemoteAuthorityRequest,
  {
    runCommand = execFileAsync as GithubRemoteRunCommand,
    principal: rawPrincipal = null,
  }: { runCommand?: GithubRemoteRunCommand; principal?: GithubTransportPrincipal | LooseRecord | null } = {},
): Promise<LooseRecord> {
  const principal = normalizeTransportPrincipal(rawPrincipal);
  assertKnownOperation(rawRequest.operation);
  const capability = normalizeGithubRemoteCapability(rawRequest.capability);
  const repository = normalizeRepository(rawRequest.repository);
  const issueNumber = positiveIssueNumber(rawRequest.issueNumber);
  if (repository !== capability.repository || issueNumber !== capability.issueNumber) {
    throw Object.assign(new Error("remote write target is outside the GitHub capability"), {
      code: "GITHUB_REMOTE_CAPABILITY_TARGET_MISMATCH",
      committed: false,
      operation: rawRequest.operation,
    });
  }
  assertBranchAuthority(rawRequest, capability);
  const [permission, markerPermission] = permissionForOperation(rawRequest.operation);
  if (capability.permissions[permission] !== true) {
    throw new Error(`GitHub capability does not grant ${rawRequest.operation}`);
  }

  const repositoryView = await runGhJson([
    "repo", "view", capability.repository,
    "--json", "id,nameWithOwner,defaultBranchRef",
  ], "github.repository.verify", runCommand);
  if (
    String(repositoryView.id || "") !== capability.repositoryId
    || String(repositoryView.nameWithOwner || "").toLowerCase() !== capability.repository
    || String(recordValue(repositoryView.defaultBranchRef).name || "") !== capability.defaultBranch
  ) {
    throw new Error("GitHub repository identity or default branch changed");
  }

  const markerResponse = await runGhJson([
    "api",
    `repos/${capability.repository}/contents/${capability.markerPath}?ref=${encodeURIComponent(capability.defaultBranch)}`,
  ], "github.marker.verify", runCommand);
  const marker = markerFromResponse(markerResponse, capability);
  assertMarkerAuthority(marker, capability);
  if (marker[markerPermission] !== true) {
    throw new Error(`GitHub disposable target marker no longer grants ${rawRequest.operation}`);
  }

  const issue = await runGhJson([
    "issue", "view", String(capability.issueNumber),
    "--repo", capability.repository,
    "--json", "number,state,labels,url",
  ], "github.issue.verify", runCommand);
  const issueIdentity = responseIssueIdentity(issue, capability, "github.issue.verify");
  const labels = responseIssueLabels(issue, "github.issue.verify");
  if (
    issueIdentity.number !== capability.issueNumber
    || responseState(issue.state, ["OPEN", "CLOSED"], "github.issue.verify", "issue state") !== "OPEN"
    || !labels.includes(capability.automationLabel)
  ) {
    throw new Error("GitHub issue identity, state, or automation label changed");
  }

  if (rawRequest.operation === "pull_request.merge") {
    const binding = capability.pullRequest;
    if (!binding) throw new Error("GitHub capability does not bind one pull request for merge");
    const operation = "github.pull_request.merge.verify";
    const pullRequest = await runGhJson([
      "pr", "view", String(binding.number),
      "--repo", capability.repository,
      "--json", "number,state,headRefName,baseRefName,headRefOid",
    ], operation, runCommand);
    const actual = {
      number: responsePositiveNumber(pullRequest.number, operation, "pull request number"),
      state: responseState(pullRequest.state, ["OPEN", "CLOSED", "MERGED"], operation, "pull request state"),
      headBranch: responseString(pullRequest.headRefName, operation, "pull request head branch"),
      baseBranch: responseString(pullRequest.baseRefName, operation, "pull request base branch"),
      headSha: responseSha(pullRequest.headRefOid, operation, "pull request head SHA"),
    };
    if (
      actual.number !== binding.number
      || actual.state !== "OPEN"
      || actual.headBranch !== binding.headBranch
      || actual.baseBranch !== binding.baseBranch
      || actual.headSha !== binding.headSha
    ) {
      throw new Error("bound pull request identity, state, or head SHA changed before merge");
    }
  }

  if (rawRequest.operation === "pull_request.create") {
    let authorLogin: string;
    let authorId: string;
    if (principal) {
      authorLogin = githubLogin(principal.login, "bound GitHub actor login");
      authorId = githubActorId(principal.authorId || principal.stableId, "bound GitHub actor ID");
    } else {
      const actorOperation = "github.pull_request.create.actor.verify";
      const actor = await runGhJson(["api", "user"], actorOperation, runCommand);
      authorLogin = githubLogin(actor.login, "authenticated GitHub actor login");
      authorId = githubActorId(actor.id, "authenticated GitHub actor ID");
    }
    const headBranch = requiredString(rawRequest.headBranch, "pull request head branch");
    const expectedHeadSha = requiredString(rawRequest.commit, "pull request expected head SHA").toLowerCase();
    const operation = "github.pull_request.create.head.verify";
    const ref = await runGhJson([
      "api",
      `repos/${capability.repository}/git/ref/heads/${encodedBranchPath(headBranch)}`,
    ], operation, runCommand);
    const actualRef = responseString(ref.ref, operation, "Git ref name");
    const actualHeadSha = responseSha(
      responseRecord(ref.object, operation, "Git ref object").sha,
      operation,
      "Git ref SHA",
    );
    if (actualRef !== `refs/heads/${headBranch}` || actualHeadSha !== expectedHeadSha) {
      throw new Error("pull request head branch moved after the authorized push");
    }
    return {
      ...capabilityVerificationEvidence(capability),
      defaultBranch: capability.defaultBranch,
      markerSha: capability.markerSha,
      automationLabel: capability.automationLabel,
      operation: rawRequest.operation,
      authorLogin,
      authorId,
      ...(principal ? { principal } : {}),
    };
  }

  return {
    ...capabilityVerificationEvidence(capability),
    defaultBranch: capability.defaultBranch,
    markerSha: capability.markerSha,
    automationLabel: capability.automationLabel,
    operation: rawRequest.operation,
    ...(principal ? { principal } : {}),
  };
}

function encodedBranchPath(branch: string) {
  return branch.split("/").map(encodeURIComponent).join("/");
}

export async function verifyGithubRemoteWriteCommitted(
  rawRequest: GithubRemoteAuthorityRequest,
  {
    runCommand = execFileAsync as GithubRemoteRunCommand,
    principal: rawPrincipal = null,
  }: { runCommand?: GithubRemoteRunCommand; principal?: GithubTransportPrincipal | LooseRecord | null } = {},
): Promise<GithubRemoteWriteVerification> {
  const principal = normalizeTransportPrincipal(rawPrincipal);
  const withPrincipal = (verification: GithubRemoteWriteVerification): GithubRemoteWriteVerification => ({
    ...verification,
    ...(principal ? { principal } : {}),
  });
  if (!GITHUB_REMOTE_WRITE_OPERATIONS.has(rawRequest.operation as GithubRemoteWriteOperation)) {
    return withPrincipal({
      committed: null,
      operation: rawRequest.operation,
      reason: "unknown GitHub remote write operation",
    });
  }
  let capability: GithubRemoteCapability;
  try {
    capability = normalizeGithubRemoteCapability(rawRequest.capability);
  } catch (error) {
    return withPrincipal({ committed: null, operation: rawRequest.operation, reason: error instanceof Error ? error.message : String(error) });
  }
  try {
    const repository = normalizeRepository(rawRequest.repository);
    const issueNumber = positiveIssueNumber(rawRequest.issueNumber);
    if (repository !== capability.repository || issueNumber !== capability.issueNumber) {
      throw new Error("remote write verification target is outside the GitHub capability");
    }
    assertBranchAuthority(rawRequest, capability);
    if (rawRequest.operation === "repository.push") {
      const targetBranch = requiredString(rawRequest.targetBranch, "remote push target branch");
      const expectedCommit = requiredString(rawRequest.commit, "remote push commit").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error("remote push commit is invalid");
      const operation = "github.push.verify";
      const ref = await runGhJson([
        "api",
        `repos/${capability.repository}/git/ref/heads/${encodedBranchPath(targetBranch)}`,
      ], operation, runCommand);
      const actualRef = responseString(ref.ref, operation, "Git ref name");
      const actualCommit = responseSha(
        responseRecord(ref.object, operation, "Git ref object").sha,
        operation,
        "Git ref SHA",
      );
      return withPrincipal({
        committed: actualRef === `refs/heads/${targetBranch}` && actualCommit === expectedCommit,
        operation: rawRequest.operation,
        evidence: {
          ...capabilityVerificationEvidence(capability),
          targetBranch,
          expectedRef: `refs/heads/${targetBranch}`,
          actualRef,
          expectedCommit,
          actualCommit,
        },
        ...(actualRef === `refs/heads/${targetBranch}` && actualCommit === expectedCommit
          ? {}
          : { reason: "remote branch ref does not point at the expected commit" }),
      });
    }

    if (rawRequest.operation === "pull_request.create") {
      const expected = pullRequestGeneration(rawRequest);
      const requestedNumber = rawRequest.pullRequestNumber === null || rawRequest.pullRequestNumber === undefined
        ? null
        : positiveIssueNumber(rawRequest.pullRequestNumber);
      const operation = requestedNumber === null
        ? "github.pull_request.create.discover"
        : "github.pull_request.create.verify";
      if (requestedNumber !== null) {
        const pullRequest = normalizePullRequestRestResponse(await runGhJson([
          "api", `repos/${capability.repository}/pulls/${requestedNumber}`,
        ], operation, runCommand), operation);
        const committed = pullRequest.number === requestedNumber
          && pullRequestGenerationMatches(pullRequest, expected, capability);
        return withPrincipal({
          committed,
          operation: rawRequest.operation,
          evidence: {
            ...capabilityVerificationEvidence(capability),
            matchCount: committed ? 1 : 0,
            candidateCount: 1,
            pullRequest: pullRequestGenerationEvidence(pullRequest, expected, capability),
          },
          ...(committed ? {} : { reason: "pull request post-condition did not match the exact creation generation" }),
        });
      }

      const owner = capability.repository.split("/", 1)[0];
      const query = [
        `state=all`,
        `head=${encodeURIComponent(`${owner}:${expected.headBranch}`)}`,
        `base=${encodeURIComponent(expected.baseBranch)}`,
        "per_page=100",
      ].join("&");
      let candidates: ReturnType<typeof normalizePullRequestRestResponse>[] = [];
      let reads = 0;
      for (; reads < 3; reads += 1) {
        candidates = (await runGhJsonPages([
          "api", "--paginate", "--slurp", `repos/${capability.repository}/pulls?${query}`,
        ], operation, runCommand)).map((candidate) => normalizePullRequestRestResponse(candidate, operation));
        if (candidates.length > 0) break;
      }
      const matches = candidates.filter((candidate) => pullRequestGenerationMatches(candidate, expected, capability));
      if (matches.length === 1) {
        return withPrincipal({
          committed: true,
          operation: rawRequest.operation,
          evidence: {
            ...capabilityVerificationEvidence(capability),
            matchCount: 1,
            candidateCount: candidates.length,
            readCount: reads + 1,
            pullRequest: pullRequestGenerationEvidence(matches[0], expected, capability),
            discovered: true,
          },
        });
      }
      if (matches.length === 0 && candidates.length === 0) {
        return withPrincipal({
          committed: null,
          operation: rawRequest.operation,
          evidence: {
            ...capabilityVerificationEvidence(capability),
            matchCount: 0,
            candidateCount: 0,
            readCount: reads,
            discovered: true,
          },
          reason: "no pull request was visible for the exact creation generation; creation truth remains unknown",
        });
      }
      return withPrincipal({
        committed: null,
        operation: rawRequest.operation,
        evidence: {
          ...capabilityVerificationEvidence(capability),
          matchCount: matches.length,
          candidateCount: candidates.length,
          readCount: reads + 1,
          discovered: true,
          candidates: candidates.slice(0, 20).map((candidate) => (
            pullRequestGenerationEvidence(candidate, expected, capability)
          )),
          candidateEvidenceTruncated: candidates.length > 20,
        },
        reason: matches.length > 1
          ? "multiple pull requests match the exact creation generation"
          : "pull request candidates exist but their identity or generation differs",
      });
    }

    if (rawRequest.operation === "pull_request.merge") {
      const number = positiveIssueNumber(rawRequest.pullRequestNumber);
      const mergeBinding = capability.pullRequest;
      if (!mergeBinding) throw new Error("GitHub capability does not bind one pull request for merge");
      const expectedHeadSha = requiredString(rawRequest.commit, "pull request head SHA").toLowerCase();
      if (
        !/^[0-9a-f]{40}$/.test(expectedHeadSha)
        || number !== mergeBinding.number
        || rawRequest.headBranch !== mergeBinding.headBranch
        || rawRequest.baseBranch !== mergeBinding.baseBranch
        || expectedHeadSha !== mergeBinding.headSha
      ) {
        throw new Error("pull request merge verification target is outside the bound capability");
      }
      const operation = "github.pull_request.merge.verify";
      const pullRequest = await runGhJson([
        "pr", "view", String(number),
        "--repo", capability.repository,
        "--json", "number,state,isDraft,headRefName,baseRefName,headRefOid,title,url,mergedAt,mergeCommit",
      ], operation, runCommand);
      const actualNumber = responsePositiveNumber(pullRequest.number, operation, "pull request number");
      const actualState = responseState(pullRequest.state, ["OPEN", "CLOSED", "MERGED"], operation, "pull request state");
      const actualHead = responseString(pullRequest.headRefName, operation, "pull request head branch");
      const actualBase = responseString(pullRequest.baseRefName, operation, "pull request base branch");
      const actualHeadSha = responseSha(pullRequest.headRefOid, operation, "pull request head SHA");
      const actualUrl = responseString(pullRequest.url, operation, "pull request URL");
      const urlMatch = actualUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/i);
      responseString(pullRequest.mergedAt, operation, "pull request merge time");
      responseSha(
        responseRecord(pullRequest.mergeCommit, operation, "pull request merge commit").oid,
        operation,
        "pull request merge commit SHA",
      );
      const committed = actualNumber === number
        && actualState === "MERGED"
        && actualHead === mergeBinding.headBranch
        && actualBase === mergeBinding.baseBranch
        && actualHeadSha === mergeBinding.headSha
        && Boolean(
          urlMatch
          && urlMatch[1].toLowerCase() === capability.repository
          && Number(urlMatch[2]) === number
        );
      return withPrincipal({
        committed,
        operation: rawRequest.operation,
        evidence: {
          ...pullRequest,
          ...capabilityVerificationEvidence(capability),
        },
        ...(committed ? {} : { reason: "pull request merge post-condition did not match" }),
      });
    }

    const operation = "github.issue.close.verify";
    const issue = await runGhJson([
      "issue", "view", String(capability.issueNumber),
      "--repo", capability.repository,
      "--json", "number,state,url",
    ], operation, runCommand);
    const identity = responseIssueIdentity(issue, capability, operation);
    const actualState = responseState(issue.state, ["OPEN", "CLOSED"], operation, "issue state");
    const closed = identity.number === capability.issueNumber && actualState === "CLOSED";
    return withPrincipal({
      committed: closed,
      operation: rawRequest.operation,
      evidence: {
        ...issue,
        ...capabilityVerificationEvidence(capability),
      },
      ...(closed ? {} : { reason: "issue remains open after close request" }),
    });
  } catch (error) {
    return withPrincipal({
      committed: null,
      operation: rawRequest.operation,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function reconcileGithubRemoteFinalization(
  rawRequest: {
    capability: GithubRemoteCapability | LooseRecord;
    repository: string;
    issueNumber: string | number;
    targetBranch: string;
    commit: string;
  },
  { runCommand = execFileAsync as GithubRemoteRunCommand }: { runCommand?: GithubRemoteRunCommand } = {},
): Promise<GithubRemoteFinalizationReconciliation> {
  try {
    const capability = normalizeGithubRemoteCapability(rawRequest.capability);
    const repository = normalizeRepository(rawRequest.repository);
    const issueNumber = positiveIssueNumber(rawRequest.issueNumber);
    const targetBranch = requiredString(rawRequest.targetBranch, "remote reconciliation target branch");
    const commit = requiredString(rawRequest.commit, "remote reconciliation commit").toLowerCase();
    if (
      repository !== capability.repository
      || issueNumber !== capability.issueNumber
      || targetBranch !== capability.defaultBranch
      || !/^[0-9a-f]{40}$/.test(commit)
    ) {
      throw new Error("remote finalization intent identity is invalid");
    }

    const repositoryView = await runGhJson([
      "repo", "view", capability.repository,
      "--json", "id,nameWithOwner,defaultBranchRef",
    ], "github.remote.intent.repository.verify", runCommand);
    if (
      String(repositoryView.id || "") !== capability.repositoryId
      || String(repositoryView.nameWithOwner || "").toLowerCase() !== capability.repository
      || String(recordValue(repositoryView.defaultBranchRef).name || "") !== capability.defaultBranch
    ) {
      throw new Error("GitHub repository identity or default branch changed during intent reconciliation");
    }

    const evidence: LooseRecord = {
      ...capabilityVerificationEvidence(capability),
      targetBranch,
      expectedCommit: commit,
    };
    let closed: boolean | null = null;
    let issueFailure: string | null = null;
    try {
      const issueOperation = "github.remote.intent.issue.verify";
      const issue = await runGhJson([
        "issue", "view", String(capability.issueNumber),
        "--repo", capability.repository,
        "--json", "number,state,url",
      ], issueOperation, runCommand);
      responseIssueIdentity(issue, capability, issueOperation);
      const issueState = responseState(issue.state, ["OPEN", "CLOSED"], issueOperation, "issue state");
      evidence.issueState = issueState;
      closed = issueState === "CLOSED";
    } catch (error) {
      issueFailure = error instanceof Error ? error.message : String(error);
    }

    let pushed: boolean | null = null;
    let refFailure: string | null = null;
    try {
      const refOperation = "github.remote.intent.ref.verify";
      const ref = await runGhJson([
        "api", `repos/${capability.repository}/git/ref/heads/${encodedBranchPath(targetBranch)}`,
      ], refOperation, runCommand);
      const actualRef = responseString(ref.ref, refOperation, "Git ref name");
      if (actualRef !== `refs/heads/${targetBranch}`) invalidResponse(refOperation, "Git ref identity");
      const actualCommit = responseSha(
        responseRecord(ref.object, refOperation, "Git ref object").sha,
        refOperation,
        "Git ref SHA",
      );
      evidence.actualCommit = actualCommit;
      // A started push whose ref points elsewhere is ambiguous: the intended
      // write may have committed and then been advanced by a successor.
      pushed = actualCommit === commit ? true : null;
      if (pushed === null) refFailure = "the default branch no longer identifies the intended commit";
    } catch (error) {
      refFailure = `remote ref truth could not be established: ${error instanceof Error ? error.message : String(error)}`;
    }

    if (pushed === true && closed === true) {
      return { committed: true, pushed, closed, nextOperation: null, evidence };
    }
    if (pushed === true && closed === false) {
      return {
        committed: false,
        pushed,
        closed: false,
        nextOperation: "issue.close",
        evidence,
      };
    }
    return {
      committed: null,
      pushed,
      closed,
      nextOperation: null,
      evidence,
      reason: [refFailure, issueFailure ? `issue truth could not be established: ${issueFailure}` : null]
        .filter(Boolean)
        .join("; ") || "remote finalization truth is incomplete",
    };
  } catch (error) {
    return {
      committed: null,
      pushed: null,
      closed: null,
      nextOperation: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
