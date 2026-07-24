#!/usr/bin/env node
import { recordValue, type LooseRecord } from "../shared/types.js";
// e2e-npm-pack.js — One-shot E2E: pack → install → doctor → hub → enqueue → verify
// Usage: node scripts/e2e-npm-pack.js [--keep-state] [--project flow]
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  type BigIntStats,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
  createTemporaryWorkspace,
  temporaryWorkspaceErrorDetails,
  type TemporaryWorkspace,
} from "../core/runtime/temporary-workspace.js";
import { REQUIRED_EXECUTOR_FILES } from "../server/services/executor-root.js";
import {
  encodeGithubRemoteCapability,
  normalizeGithubRemoteCapability,
  type GithubRemoteCapability,
} from "../server/services/github/github-remote-capability.js";

const args = process.argv.slice(2);
const KEEP_STATE = args.includes("--keep-state");
const PROJECT = args.find((a) => !a.startsWith("--")) || "flow";

export function resolveE2ePackageRoot(scriptDir: string) {
  const directPackageRoot = path.resolve(scriptDir, "..");
  if (/^dist(?:-tests)?$/.test(path.basename(directPackageRoot))) {
    const sourcePackageRoot = path.resolve(directPackageRoot, "..");
    if (
      existsSync(path.join(sourcePackageRoot, "package.json"))
      && existsSync(path.join(sourcePackageRoot, "cpb"))
    ) {
      return realpathSync(sourcePackageRoot);
    }
  }
  if (
    !existsSync(path.join(directPackageRoot, "package.json"))
    || !existsSync(path.join(directPackageRoot, "cpb"))
  ) {
    throw new Error(`could not resolve package root from ${scriptDir}`);
  }
  return realpathSync(directPackageRoot);
}

const ROOT = resolveE2ePackageRoot(import.meta.dirname);
let HUB_ROOT = path.resolve(process.env.CPB_HUB_ROOT || path.join(homedir(), ".cpb"));
const AUTOMATION_LABEL = process.env.CPB_E2E_LABEL || "cpb";
const TARGET_ISSUE_NUMBER = process.env.CPB_E2E_ISSUE_NUMBER
  ? String(process.env.CPB_E2E_ISSUE_NUMBER).replace(/^#/, "")
  : "";
const AGENT_MODE = (process.env.CPB_E2E_AGENT_MODE || "codex").toLowerCase();
const FINALIZER_MODE = process.env.CPB_E2E_FINALIZER_MODE || "remote";
const ACP_PHASE_TIMEOUT_MS = Number(process.env.CPB_E2E_ACP_PHASE_TIMEOUT_MS || 15 * 60 * 1000);
const DEFAULT_MONITOR_TIMEOUT_MS = Math.max(90 * 60 * 1000, ACP_PHASE_TIMEOUT_MS * 5 + 15 * 60 * 1000);
const MONITOR_TIMEOUT_MS = Number(process.env.CPB_E2E_MONITOR_TIMEOUT_MS || DEFAULT_MONITOR_TIMEOUT_MS);

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const CYAN = "\x1b[0;36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function normalizeGithubRepo(value: unknown) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const withoutGitSuffix = raw.replace(/\.git$/, "");
  const sshMatch = withoutGitSuffix.match(/github\.com[:/]([^/\s]+\/[^/\s]+)$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = withoutGitSuffix.match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)$/);
  if (httpsMatch) return httpsMatch[1];

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(withoutGitSuffix)) {
    return withoutGitSuffix;
  }

  return "";
}

export function resolveGithubRepo({ env = process.env, root = ROOT, execSyncFn = execSync } = {}) {
  const fromEnv = normalizeGithubRepo(env.CPB_E2E_GITHUB_REPO || env.GITHUB_REPOSITORY);
  if (fromEnv) return fromEnv;

  try {
    const remote = execSyncFn("git config --get remote.origin.url", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const fromRemote = normalizeGithubRepo(remote);
    if (fromRemote) return fromRemote;
  } catch {}

  throw new Error("Could not resolve GitHub repo. Set CPB_E2E_GITHUB_REPO=owner/repo.");
}

type E2eNpmPackSafetyOptions = {
  env?: NodeJS.ProcessEnv;
  root?: string;
  homeDir?: string;
  project?: string;
  keepState?: boolean;
  agentMode?: string;
  finalizerMode?: string;
  phaseTimeoutMs?: number;
  monitorTimeoutMs?: number;
  execSyncFn?: (command: string, options?: Parameters<typeof execSync>[1]) => unknown;
};

type E2eNpmPackSafety = {
  hubRoot: string;
  hubIdentity: {
    dev: number;
    ino: number;
    birthtimeMs: number;
    mode: number;
    uid: number;
    gid: number;
  };
  hubMarker: {
    dev: number;
    ino: number;
    birthtimeMs: number;
    mode: number;
    uid: number;
    gid: number;
    content: string;
  };
  repository: string;
  repositoryId: string;
  issueNumber: string;
  automationLabel: string;
  defaultBranch: string;
  sourceBranch: string;
  markerSha: string;
  remoteCapability: GithubRemoteCapability;
};

let activeSafety: E2eNpmPackSafety | null = null;
let hubStartAttempted = false;

const LOCAL_ROOT_MARKER = ".cpb-e2e-root";
const REMOTE_TARGET_MARKER = ".cpb-disposable-target.json";
const REMOTE_TARGET_PURPOSE = "codepatchbay-release-rehearsal";

function requiredText(value: unknown, name: string) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function commandText(value: unknown) {
  return Buffer.isBuffer(value) ? value.toString("utf8").trim() : String(value || "").trim();
}

function parseJsonObject(value: string, name: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error(`${name} is not valid JSON`, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function assertFinitePositiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a finite positive integer`);
  }
}

function validGitRef(value: string) {
  return /^[A-Za-z0-9._/-]+$/.test(value)
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.includes("..")
    && !value.includes("//");
}

function assertLocalDisposableRoot({
  env,
  root,
  homeDir,
  keepState,
}: {
  env: NodeJS.ProcessEnv;
  root: string;
  homeDir: string;
  keepState: boolean;
}) {
  if (env.CPB_E2E_ALLOW_DESTRUCTIVE !== "1") {
    throw new Error("Set CPB_E2E_ALLOW_DESTRUCTIVE=1 only for a dedicated disposable Hub root");
  }
  const configured = requiredText(env.CPB_HUB_ROOT, "CPB_HUB_ROOT");
  if (!path.isAbsolute(configured)) {
    throw new Error("CPB_HUB_ROOT must be an absolute path to a dedicated disposable directory");
  }
  const resolved = path.resolve(configured);
  const rootInfo = lstatSync(resolved);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("CPB_HUB_ROOT must name a real directory, not a symlink");
  }
  const canonical = realpathSync(resolved);
  const canonicalInfo = lstatSync(canonical);
  if (
    !canonicalInfo.isDirectory()
    || canonicalInfo.isSymbolicLink()
    || canonicalInfo.dev !== rootInfo.dev
    || canonicalInfo.ino !== rootInfo.ino
    || canonicalInfo.birthtimeMs !== rootInfo.birthtimeMs
  ) {
    throw new Error("CPB_HUB_ROOT canonical identity changed during validation");
  }

  const canonicalHome = realpathSync(homeDir);
  const protectedPaths = [path.parse(canonical).root, canonicalHome, path.join(canonicalHome, ".cpb")];
  if (protectedPaths.includes(canonical)) {
    throw new Error(`refusing protected Hub root: ${canonical}`);
  }
  const source = realpathSync(path.resolve(root));
  const relativeToSource = path.relative(source, canonical);
  const relativeToHub = path.relative(canonical, source);
  if (
    relativeToSource === ""
    || (!path.isAbsolute(relativeToSource) && relativeToSource !== ".." && !relativeToSource.startsWith(`..${path.sep}`))
    || (!path.isAbsolute(relativeToHub) && relativeToHub !== ".." && !relativeToHub.startsWith(`..${path.sep}`))
  ) {
    throw new Error("CPB_HUB_ROOT and the source checkout must not contain one another");
  }

  const markerPath = path.join(canonical, LOCAL_ROOT_MARKER);
  const markerInfo = lstatSync(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
    throw new Error(`${LOCAL_ROOT_MARKER} must be a real regular file`);
  }
  const marker = parseJsonObject(readFileSync(markerPath, "utf8"), LOCAL_ROOT_MARKER);
  if (marker.schemaVersion !== 1 || marker.purpose !== "codepatchbay-e2e-root" || marker.disposable !== true) {
    throw new Error(`${LOCAL_ROOT_MARKER} must explicitly declare a disposable CodePatchBay E2E root`);
  }

  if (!keepState) {
    const unexpected = readdirSync(canonical).filter((entry) => entry !== LOCAL_ROOT_MARKER);
    if (unexpected.length > 0) {
      throw new Error(`CPB_HUB_ROOT must be pristine; refusing to remove existing entries: ${unexpected.join(", ")}`);
    }
  }
  return canonical;
}

function hubDirectoryIdentity(hubRoot: string) {
  const info = lstatSync(hubRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("disposable Hub root is no longer a real directory");
  }
  return {
    dev: info.dev,
    ino: info.ino,
    birthtimeMs: info.birthtimeMs,
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
  };
}

function assertHubDirectoryIdentity(safety: E2eNpmPackSafety) {
  const current = hubDirectoryIdentity(safety.hubRoot);
  for (const field of ["dev", "ino", "birthtimeMs", "mode", "uid", "gid"] as const) {
    if (current[field] !== safety.hubIdentity[field]) {
      throw new Error(`disposable Hub root identity changed after preflight (${field})`);
    }
  }
  const markerPath = path.join(safety.hubRoot, LOCAL_ROOT_MARKER);
  const markerInfo = lstatSync(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
    throw new Error("disposable Hub root marker is no longer a real regular file");
  }
  for (const field of ["dev", "ino", "birthtimeMs", "mode", "uid", "gid"] as const) {
    if (markerInfo[field] !== safety.hubMarker[field]) {
      throw new Error(`disposable Hub root marker identity changed after preflight (${field})`);
    }
  }
  if (readFileSync(markerPath, "utf8") !== safety.hubMarker.content) {
    throw new Error("disposable Hub root marker content changed after preflight");
  }
}

function parseRemoteMarkerResponse(value: string) {
  const response = parseJsonObject(value, "disposable target marker response");
  const markerPath = String(response.path || "");
  const markerSha = String(response.sha || "");
  const content = String(response.content || "").replace(/\s+/g, "");
  if (markerPath !== REMOTE_TARGET_MARKER) throw new Error("disposable target marker path is invalid");
  if (!/^[0-9a-f]{40}$/i.test(markerSha)) throw new Error("disposable target marker SHA is invalid");
  if (!content) throw new Error("disposable target marker content is missing");
  return {
    marker: parseJsonObject(Buffer.from(content, "base64").toString("utf8"), REMOTE_TARGET_MARKER),
    markerSha,
  };
}

function assertRemoteMarker(
  marker: Record<string, unknown>,
  repository: string,
  issueNumber: string,
  automationLabel: string,
) {
  if (marker.schemaVersion !== 1) throw new Error("disposable target marker schemaVersion must be 1");
  if (marker.purpose !== REMOTE_TARGET_PURPOSE) {
    throw new Error(`disposable target marker purpose must be ${REMOTE_TARGET_PURPOSE}`);
  }
  if (String(marker.repository || "").toLowerCase() !== repository) {
    throw new Error("disposable target marker repository does not match the target");
  }
  for (const permission of [
    "disposable",
    "allowCodePatchBayE2E",
    "allowRepositoryPush",
    "allowDraftPullRequests",
    "allowPullRequestMerge",
    "allowIssueClose",
  ]) {
    if (marker[permission] !== true) throw new Error(`disposable target marker must set ${permission}=true`);
  }
  const allowedIssues = Array.isArray(marker.allowedIssueNumbers)
    ? marker.allowedIssueNumbers.map((value) => String(value))
    : [];
  if (!allowedIssues.includes(issueNumber)) {
    throw new Error(`disposable target marker does not authorize issue #${issueNumber}`);
  }
  const allowedLabels = Array.isArray(marker.allowedAutomationLabels)
    ? marker.allowedAutomationLabels.map((value) => String(value))
    : [];
  if (!allowedLabels.includes(automationLabel)) {
    throw new Error(`disposable target marker does not authorize automation label ${automationLabel}`);
  }
}

function assertExactAutomationIssueSelection({
  execSyncFn,
  root,
  repository,
  issueNumber,
  automationLabel,
}: {
  execSyncFn: NonNullable<E2eNpmPackSafetyOptions["execSyncFn"]>;
  root: string;
  repository: string;
  issueNumber: string;
  automationLabel: string;
}) {
  const response = commandText(execSyncFn(
    `gh issue list --repo ${repository} --state open --label ${shellQuote(automationLabel)} --limit 100 --json number`,
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ));
  let issues: unknown;
  try {
    issues = JSON.parse(response);
  } catch (cause) {
    throw new Error("GitHub issue selection is not valid JSON", { cause });
  }
  if (!Array.isArray(issues)) throw new Error("GitHub issue selection must be an array");
  const numbers = issues.map((issue) => String(recordValue(issue).number || ""));
  if (numbers.length !== 1 || numbers[0] !== issueNumber) {
    throw new Error(
      `automation label ${automationLabel} must select only authorized issue #${issueNumber}; selected ${numbers.join(", ") || "none"}`,
    );
  }
}

export function assertE2eNpmPackSafety(options: E2eNpmPackSafetyOptions = {}): E2eNpmPackSafety {
  const env = options.env || process.env;
  const root = path.resolve(options.root || ROOT);
  const homeDir = path.resolve(options.homeDir || homedir());
  const keepState = options.keepState ?? false;
  const project = options.project ?? "flow";
  const agentMode = String(options.agentMode || "codex").toLowerCase();
  const finalizerMode = String(options.finalizerMode || "remote");
  const phaseTimeoutMs = options.phaseTimeoutMs ?? 15 * 60 * 1000;
  const monitorTimeoutMs = options.monitorTimeoutMs ?? 90 * 60 * 1000;
  const execSyncFn = options.execSyncFn || execSync;

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(project)) {
    throw new Error("project id contains unsafe characters");
  }
  if (!["codex", "claude", "cc", "mixed", "default"].includes(agentMode)) {
    throw new Error("CPB_E2E_AGENT_MODE is unsupported");
  }
  if (finalizerMode !== "remote") {
    throw new Error("CPB_E2E_FINALIZER_MODE must be remote for this release E2E");
  }
  assertFinitePositiveInteger(phaseTimeoutMs, "CPB_E2E_ACP_PHASE_TIMEOUT_MS");
  assertFinitePositiveInteger(monitorTimeoutMs, "CPB_E2E_MONITOR_TIMEOUT_MS");
  if (String(env.CPB_HUB_STATE_REDIS_CONFIG_FILE || "").trim()) {
    throw new Error("CPB_HUB_STATE_REDIS_CONFIG_FILE is forbidden for the disposable npm-pack E2E");
  }
  if (env.CPB_DANGEROUS === "1") {
    throw new Error("CPB_DANGEROUS=1 is forbidden for the disposable npm-pack E2E");
  }

  const hubRoot = assertLocalDisposableRoot({ env, root, homeDir, keepState });
  if (env.CPB_E2E_ALLOW_REMOTE_WRITES !== "1") {
    throw new Error("Set CPB_E2E_ALLOW_REMOTE_WRITES=1 only for an explicitly marked disposable repository");
  }
  const explicitRepository = requiredText(env.CPB_E2E_GITHUB_REPO, "CPB_E2E_GITHUB_REPO");
  const repository = normalizeGithubRepo(explicitRepository).toLowerCase();
  if (!repository || repository !== explicitRepository.toLowerCase()) {
    throw new Error("CPB_E2E_GITHUB_REPO must be an explicit owner/repo value");
  }
  const issueNumber = requiredText(env.CPB_E2E_ISSUE_NUMBER, "CPB_E2E_ISSUE_NUMBER").replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(issueNumber)) {
    throw new Error("CPB_E2E_ISSUE_NUMBER must be one explicit positive issue number");
  }
  const automationLabel = requiredText(env.CPB_E2E_LABEL, "CPB_E2E_LABEL");
  if (automationLabel.length > 100 || /[\u0000-\u001f\u007f]/.test(automationLabel)) {
    throw new Error("CPB_E2E_LABEL is unsafe");
  }
  const requiredAck = `execute-codepatchbay-e2e:${repository}#${issueNumber}`;
  if (env.CPB_E2E_REMOTE_ACK !== requiredAck) {
    throw new Error(`CPB_E2E_REMOTE_ACK must exactly equal ${requiredAck}`);
  }

  const origin = normalizeGithubRepo(commandText(execSyncFn("git config --get remote.origin.url", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }))).toLowerCase();
  if (origin !== repository) {
    throw new Error(`source checkout origin ${origin || "<unknown>"} does not match disposable target ${repository}`);
  }
  execSyncFn("gh auth status", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const repoView = parseJsonObject(commandText(execSyncFn(
    `gh repo view ${repository} --json id,defaultBranchRef`,
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )), "GitHub repository metadata");
  const repositoryId = requiredText(repoView.id, "GitHub repository id");
  const defaultBranch = requiredText(recordValue(repoView.defaultBranchRef).name, "GitHub default branch");
  if (!validGitRef(defaultBranch)) throw new Error("GitHub default branch is unsafe");
  const sourceBranch = requiredText(commandText(execSyncFn("git branch --show-current", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })), "source checkout branch");
  if (sourceBranch !== defaultBranch) {
    throw new Error(`source checkout branch ${sourceBranch} must equal disposable target default branch ${defaultBranch}`);
  }

  const markerResponse = parseRemoteMarkerResponse(commandText(execSyncFn(
    `gh api ${shellQuote(`repos/${repository}/contents/${REMOTE_TARGET_MARKER}?ref=${encodeURIComponent(defaultBranch)}`)}`,
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )));
  assertRemoteMarker(markerResponse.marker, repository, issueNumber, automationLabel);
  assertExactAutomationIssueSelection({ execSyncFn, root, repository, issueNumber, automationLabel });
  const remoteCapability = normalizeGithubRemoteCapability({
    schema: "cpb.github-remote-capability.v1",
    repository,
    repositoryId,
    defaultBranch,
    markerPath: REMOTE_TARGET_MARKER,
    markerSha: markerResponse.markerSha,
    issueNumber,
    automationLabel,
    allowedBranchPrefix: markerResponse.marker.allowedBranchPrefix,
    permissions: {
      repositoryPush: markerResponse.marker.allowRepositoryPush,
      pullRequestCreate: markerResponse.marker.allowDraftPullRequests,
      pullRequestMerge: markerResponse.marker.allowPullRequestMerge,
      issueClose: markerResponse.marker.allowIssueClose,
    },
  });
  const hubMarkerPath = path.join(hubRoot, LOCAL_ROOT_MARKER);
  const hubMarkerInfo = lstatSync(hubMarkerPath);
  return {
    hubRoot,
    hubIdentity: hubDirectoryIdentity(hubRoot),
    hubMarker: {
      dev: hubMarkerInfo.dev,
      ino: hubMarkerInfo.ino,
      birthtimeMs: hubMarkerInfo.birthtimeMs,
      mode: hubMarkerInfo.mode,
      uid: hubMarkerInfo.uid,
      gid: hubMarkerInfo.gid,
      content: readFileSync(hubMarkerPath, "utf8"),
    },
    repository,
    repositoryId,
    issueNumber,
    automationLabel,
    defaultBranch,
    sourceBranch,
    markerSha: markerResponse.markerSha,
    remoteCapability,
  };
}

function assertRemoteAuthorityStillCurrent(safety: E2eNpmPackSafety) {
  const sourceBranch = requiredText(commandText(execSync("git branch --show-current", {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })), "source checkout branch");
  if (sourceBranch !== safety.sourceBranch || sourceBranch !== safety.defaultBranch) {
    throw new Error("source checkout branch changed after E2E preflight");
  }
  const repoView = parseJsonObject(commandText(execSync(
    `gh repo view ${safety.repository} --json id,defaultBranchRef`,
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )), "GitHub repository metadata");
  const repositoryId = requiredText(repoView.id, "GitHub repository id");
  const defaultBranch = requiredText(recordValue(repoView.defaultBranchRef).name, "GitHub default branch");
  if (repositoryId !== safety.repositoryId || defaultBranch !== safety.defaultBranch) {
    throw new Error("disposable repository identity changed after E2E preflight");
  }
  const markerResponse = parseRemoteMarkerResponse(commandText(execSync(
    `gh api ${shellQuote(`repos/${safety.repository}/contents/${REMOTE_TARGET_MARKER}?ref=${encodeURIComponent(defaultBranch)}`)}`,
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )));
  if (markerResponse.markerSha !== safety.markerSha) {
    throw new Error("disposable target marker changed after E2E preflight");
  }
  assertRemoteMarker(markerResponse.marker, safety.repository, safety.issueNumber, safety.automationLabel);
  assertExactAutomationIssueSelection({
    execSyncFn: execSync,
    root: ROOT,
    repository: safety.repository,
    issueNumber: safety.issueNumber,
    automationLabel: safety.automationLabel,
  });
}

function log(tag: string, msg: string) {
  console.log(`${CYAN}[${tag}]${RESET} ${msg}`);
}

function pass(msg: string) {
  console.log(`${GREEN}  PASS${RESET} ${msg}`);
}

function fail(msg: string) {
  console.log(`${RED}  FAIL${RESET} ${msg}`);
}

function shellQuote(value: unknown) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

type ShellRunOptions = {
  cwd?: string;
  timeout?: number;
  silent?: boolean;
  env?: NodeJS.ProcessEnv;
  allowFail?: boolean;
  childDescriptors?: number[];
  exactEnv?: boolean;
  npmEnvironment?: boolean;
};

type ShellRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

let activePackRuntimeValidator: (() => void) | null = null;

const SHELL_STARTUP_ENV_KEYS = new Set([
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "CDPATH",
  "GLOBIGNORE",
]);

const AMBIENT_NETWORK_ENV_KEYS = new Set([
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

export function sanitizeE2eChildEnvironment(
  source: NodeJS.ProcessEnv,
  {
    npm = false,
    ownedHome,
    ownedTemp,
    pathValue,
  }: {
    npm?: boolean;
    ownedHome?: string;
    ownedTemp?: string;
    pathValue?: string;
  } = {},
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (SHELL_STARTUP_ENV_KEYS.has(upper)) continue;
    if (npm && (/^NPM_/i.test(key) || upper === "INIT_CWD" || AMBIENT_NETWORK_ENV_KEYS.has(upper))) continue;
    if (key === "NODE_OPTIONS" || key === "NODE_PATH") continue;
    sanitized[key] = value;
  }
  if (ownedHome !== undefined) sanitized.HOME = ownedHome;
  if (ownedTemp !== undefined) {
    sanitized.TMPDIR = ownedTemp;
    sanitized.TMP = ownedTemp;
    sanitized.TEMP = ownedTemp;
  }
  if (pathValue !== undefined) sanitized.PATH = pathValue;
  return sanitized;
}

function outputText(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
}

function assertActiveRunAuthorities() {
  const errors: unknown[] = [];
  try {
    if (activeSafety) assertHubDirectoryIdentity(activeSafety);
  } catch (error) {
    errors.push(error);
  }
  try {
    activePackRuntimeValidator?.();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "E2E Hub root and installed runtime authority validation both failed");
  }
}

export function run(cmd: string, opts: ShellRunOptions = {}): ShellRunResult {
  assertActiveRunAuthorities();
  let result: string | Buffer | null = null;
  let commandError: unknown = null;
  try {
    result = execSync(cmd, {
      encoding: "utf8",
      cwd: opts.cwd || ROOT,
      timeout: opts.timeout || 120_000,
      stdio: opts.silent ? "pipe" : "inherit",
      env: sanitizeE2eChildEnvironment(
        opts.exactEnv ? { ...opts.env } : { ...process.env, ...opts.env },
        { npm: opts.npmEnvironment },
      ),
    });
  } catch (error) {
    commandError = error;
  }

  let authorityError: unknown = null;
  try {
    assertActiveRunAuthorities();
  } catch (error) {
    authorityError = error;
  }
  if (commandError && authorityError) {
    throw new AggregateError(
      [commandError, authorityError],
      `command failed and E2E authority changed: ${cmd}`,
    );
  }
  if (authorityError) throw authorityError;
  if (commandError) {
    const error = commandError as LooseRecord;
    if (opts.allowFail) {
      return { ok: false, stdout: outputText(error.stdout).trim(), stderr: outputText(error.stderr).trim() };
    }
    fail(`${cmd}`);
    const stderr = outputText(error.stderr).trim();
    if (stderr) console.error(stderr.substring(0, 500));
    throw new Error(`command failed: ${cmd}`, { cause: commandError });
  }
  return { ok: true, stdout: outputText(result).trim(), stderr: "" };
}

function runFile(
  executable: string,
  argv: readonly string[],
  opts: ShellRunOptions = {},
): ShellRunResult {
  assertActiveRunAuthorities();
  let result: string | Buffer | null = null;
  let commandError: unknown = null;
  const childDescriptors = opts.childDescriptors || [];
  try {
    result = execFileSync(executable, [...argv], {
      encoding: "utf8",
      cwd: opts.cwd || ROOT,
      timeout: opts.timeout || 120_000,
      stdio: opts.silent
        ? ["ignore", "pipe", "pipe", ...childDescriptors]
        : ["inherit", "inherit", "inherit", ...childDescriptors],
      env: sanitizeE2eChildEnvironment(
        opts.exactEnv ? { ...opts.env } : { ...process.env, ...opts.env },
        { npm: opts.npmEnvironment },
      ),
    });
  } catch (error) {
    commandError = error;
  }

  let authorityError: unknown = null;
  try {
    assertActiveRunAuthorities();
  } catch (error) {
    authorityError = error;
  }
  const rendered = [executable, ...argv].map(shellQuote).join(" ");
  if (commandError && authorityError) {
    throw new AggregateError(
      [commandError, authorityError],
      `command failed and E2E authority changed: ${rendered}`,
    );
  }
  if (authorityError) throw authorityError;
  if (commandError) {
    const error = commandError as LooseRecord;
    if (opts.allowFail) {
      return { ok: false, stdout: outputText(error.stdout).trim(), stderr: outputText(error.stderr).trim() };
    }
    fail(rendered);
    const stderr = outputText(error.stderr).trim();
    if (stderr) console.error(stderr.substring(0, 500));
    throw new Error(`command failed: ${rendered}`, { cause: commandError });
  }
  return { ok: true, stdout: outputText(result).trim(), stderr: "" };
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function assertPackedExecutorFiles(packEntry: LooseRecord) {
  const files = Array.isArray(packEntry.files) ? packEntry.files : [];
  const packedPaths = new Set(files.map((file) => recordValue(file).path).filter(Boolean));
  const requiredPaths = ["cpb", ...REQUIRED_EXECUTOR_FILES.map((required) => `dist/${required}`)];
  const missing = requiredPaths.filter((required) => !packedPaths.has(required));
  if (missing.length > 0) {
    throw new Error(`Pack is missing executor files: ${missing.join(", ")}`);
  }
  return requiredPaths;
}

export function resolvePackedTarballPath(packDir: string, filename: unknown) {
  const packedFilename = String(filename || "");
  if (
    !packedFilename
    || packedFilename.includes("\0")
    || path.basename(packedFilename) !== packedFilename
    || !packedFilename.endsWith(".tgz")
  ) {
    throw new Error("npm pack returned an unsafe tarball filename");
  }
  const canonicalPackDir = realpathSync(packDir);
  const candidate = path.resolve(canonicalPackDir, packedFilename);
  if (path.dirname(candidate) !== canonicalPackDir) {
    throw new Error("npm pack tarball path escaped the owned pack directory");
  }
  const details = lstatSync(candidate);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new Error("npm pack tarball must be a single-link regular file");
  }
  const canonicalTarball = realpathSync(candidate);
  if (path.dirname(canonicalTarball) !== canonicalPackDir) {
    throw new Error("npm pack tarball resolved outside the owned pack directory");
  }
  return canonicalTarball;
}

export type PackedTreeManifestEntry = {
  path: string;
  type: "directory" | "file";
  mode: number;
  size: number;
  sha256: string | null;
};

export type PackedTreeManifest = {
  schemaVersion: 1;
  entries: PackedTreeManifestEntry[];
};

export type PackedTarballProof = {
  path: string;
  dev: string;
  ino: string;
  birthtimeNs: string;
  mode: string;
  uid: string;
  gid: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  sha512: string;
  sha1: string;
  manifest: PackedTreeManifest;
};

const MAX_E2E_TARBALL_BYTES = 128 * 1024 * 1024;
const MAX_E2E_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_E2E_PACKAGE_ENTRIES = 20_000;
const MAX_TRUSTED_RUNTIME_ENTRIES = 100_000;

function tarString(block: Buffer, start: number, length: number) {
  const field = block.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8").trim();
}

function tarNumber(block: Buffer, start: number, length: number, name: string) {
  const field = block.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) {
    let value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`tar ${name} exceeds the safe integer bound`);
    return Number(value);
  }
  const text = tarString(block, start, length).replace(/^0+/, "") || "0";
  if (!/^[0-7]+$/.test(text)) throw new Error(`tar ${name} is not valid octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`tar ${name} is outside the safe integer bound`);
  return value;
}

function assertTarChecksum(block: Buffer) {
  const expected = tarNumber(block, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < block.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index];
  }
  if (actual !== expected) throw new Error("npm pack tar header checksum is invalid");
}

function parsePaxRecords(payload: Buffer) {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < payload.length) {
    const space = payload.indexOf(0x20, offset);
    if (space === -1) throw new Error("npm pack PAX record has no length delimiter");
    const lengthText = payload.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error("npm pack PAX record has an invalid length");
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > payload.length) {
      throw new Error("npm pack PAX record exceeds its payload");
    }
    const record = payload.subarray(space + 1, offset + length);
    if (record.at(-1) !== 0x0a) throw new Error("npm pack PAX record is not newline terminated");
    const body = record.subarray(0, -1).toString("utf8");
    const equals = body.indexOf("=");
    if (equals <= 0) throw new Error("npm pack PAX record is malformed");
    records.set(body.slice(0, equals), body.slice(equals + 1));
    offset += length;
  }
  return records;
}

function canonicalPackedRelativePath(archivePath: string) {
  if (
    !archivePath.startsWith("package/")
    || archivePath.includes("\0")
    || archivePath.includes("\\")
    || archivePath.length > 4096
  ) {
    throw new Error(`npm pack archive path is unsafe: ${archivePath || "<empty>"}`);
  }
  const relative = archivePath.slice("package/".length).replace(/\/$/, "");
  const segments = relative.split("/");
  if (!relative || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`npm pack archive path is not canonical: ${archivePath}`);
  }
  return relative;
}

function parsePackedTreeManifest(payload: Buffer) {
  const tar = gunzipSync(payload, { maxOutputLength: MAX_E2E_UNPACKED_BYTES });
  const entries = new Map<string, PackedTreeManifestEntry>();
  const filePayloads = new Map<string, Buffer>();
  let offset = 0;
  let pendingPax = new Map<string, string>();
  let globalPax = new Map<string, string>();
  let pendingLongPath: string | null = null;
  let foundEnd = false;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      if (offset + 512 > tar.length || !tar.subarray(offset, offset + 512).every((byte) => byte === 0)) {
        throw new Error("npm pack tar archive is missing its second zero end block");
      }
      foundEnd = true;
      break;
    }
    assertTarChecksum(header);
    const size = tarNumber(header, 124, 12, "entry size");
    if (size > MAX_E2E_UNPACKED_BYTES || offset + size > tar.length) {
      throw new Error("npm pack tar entry exceeds the unpacked byte bound");
    }
    const body = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (offset > tar.length) throw new Error("npm pack tar entry padding exceeds the archive");

    const typeFlag = String.fromCharCode(header[156] || 0);
    if (typeFlag === "x" || typeFlag === "g") {
      const parsed = parsePaxRecords(body);
      if (typeFlag === "g") globalPax = new Map([...globalPax, ...parsed]);
      else pendingPax = parsed;
      continue;
    }
    if (typeFlag === "L") {
      pendingLongPath = body.subarray(0, body.indexOf(0) === -1 ? body.length : body.indexOf(0)).toString("utf8");
      continue;
    }
    if (typeFlag === "K") throw new Error("npm pack archive contains a GNU long-link entry");

    const pax = new Map([...globalPax, ...pendingPax]);
    pendingPax = new Map();
    const prefix = tarString(header, 345, 155);
    const headerName = tarString(header, 0, 100);
    const archivePath = pendingLongPath || pax.get("path") || (prefix ? `${prefix}/${headerName}` : headerName);
    pendingLongPath = null;
    const relative = canonicalPackedRelativePath(archivePath);
    const effectiveSizeText = pax.get("size");
    const effectiveSize = effectiveSizeText === undefined ? size : Number(effectiveSizeText);
    if (!Number.isSafeInteger(effectiveSize) || effectiveSize !== size) {
      throw new Error(`npm pack PAX size does not match tar entry bytes: ${relative}`);
    }
    const mode = tarNumber(header, 100, 8, "entry mode") & 0o777;
    const type = typeFlag === "5"
      ? "directory"
      : typeFlag === "0" || typeFlag === "\0" || typeFlag === " "
        ? "file"
        : null;
    if (!type) throw new Error(`npm pack archive contains unsupported link or special type ${typeFlag}: ${relative}`);
    if (type === "directory" && size !== 0) throw new Error(`npm pack directory has a non-zero size: ${relative}`);
    if (entries.has(relative)) throw new Error(`npm pack archive contains a duplicate path: ${relative}`);
    entries.set(relative, {
      path: relative,
      type,
      mode,
      size,
      sha256: type === "file" ? createHash("sha256").update(body).digest("hex") : null,
    });
    if (type === "file") filePayloads.set(relative, Buffer.from(body));
    if (entries.size > MAX_E2E_PACKAGE_ENTRIES) throw new Error("npm pack archive exceeds the entry-count bound");
  }
  if (!foundEnd || pendingPax.size > 0 || pendingLongPath !== null) {
    throw new Error("npm pack tar archive is incomplete");
  }
  if (!tar.subarray(offset).every((byte) => byte === 0)) {
    throw new Error("npm pack tar archive has non-zero trailing bytes");
  }

  for (const entry of [...entries.values()]) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join("/");
      const existing = entries.get(directory);
      if (existing && existing.type !== "directory") {
        throw new Error(`npm pack archive path parent is not a directory: ${directory}`);
      }
      if (!existing) {
        entries.set(directory, {
          path: directory,
          type: "directory",
          mode: 0o755,
          size: 0,
          sha256: null,
        });
      }
    }
  }

  const manifest: PackedTreeManifest = {
    schemaVersion: 1,
    entries: [...entries.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
  return { manifest, filePayloads };
}

type PackedTarballIdentity = Omit<PackedTarballProof, "path" | "sha512" | "sha1" | "manifest">;

function packedTarballIdentity(details: BigIntStats): PackedTarballIdentity {
  return {
    dev: String(details.dev),
    ino: String(details.ino),
    birthtimeNs: String(details.birthtimeNs),
    mode: String(details.mode),
    uid: String(details.uid),
    gid: String(details.gid),
    nlink: String(details.nlink),
    size: String(details.size),
    mtimeNs: String(details.mtimeNs),
    ctimeNs: String(details.ctimeNs),
  };
}

function samePackedTarballIdentity(
  left: PackedTarballIdentity,
  right: PackedTarballIdentity,
) {
  return Object.keys(left).every((key) => (
    left[key as keyof typeof left] === right[key as keyof typeof right]
  ));
}

export function assertPackedTarballIntegrity(
  tarballPath: string,
  packEntry: LooseRecord,
  expectedProof?: PackedTarballProof,
): PackedTarballProof {
  const resolvedTarballPath = path.resolve(tarballPath);
  if (realpathSync(resolvedTarballPath) !== resolvedTarballPath) {
    throw new Error("npm pack tarball path must already be canonical");
  }
  const expectedSize = Number(packEntry.size);
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_E2E_TARBALL_BYTES) {
    throw new Error("npm pack tarball size is missing or outside the E2E bound");
  }
  const expectedSha512 = String(packEntry.integrity || "");
  const expectedSha1 = String(packEntry.shasum || "");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(expectedSha512) || !/^[0-9a-f]{40}$/i.test(expectedSha1)) {
    throw new Error("npm pack tarball integrity metadata is missing or invalid");
  }

  let descriptor: number | null = null;
  let primaryError: unknown = null;
  let proof: PackedTarballProof | null = null;
  try {
    descriptor = openSync(resolvedTarballPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    const beforeIdentity = packedTarballIdentity(before);
    const pathBefore = lstatSync(resolvedTarballPath, { bigint: true });
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1n
      || before.size !== BigInt(expectedSize)
      || (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
      || (before.mode & 0o022n) !== 0n
      || !samePackedTarballIdentity(beforeIdentity, packedTarballIdentity(pathBefore))
    ) {
      throw new Error("npm pack tarball descriptor is not bound to the owned single-link path");
    }

    const payload = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < payload.length) {
      const bytesRead = readSync(descriptor, payload, offset, payload.length - offset, offset);
      if (bytesRead === 0) throw new Error("npm pack tarball ended before its declared size");
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if (readSync(descriptor, extra, 0, 1, offset) !== 0) {
      throw new Error("npm pack tarball exceeds its declared size");
    }

    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(resolvedTarballPath, { bigint: true });
    const afterIdentity = packedTarballIdentity(after);
    if (
      !samePackedTarballIdentity(beforeIdentity, afterIdentity)
      || !samePackedTarballIdentity(afterIdentity, packedTarballIdentity(pathAfter))
    ) {
      throw new Error("npm pack tarball identity changed while it was read");
    }

    const sha512 = `sha512-${createHash("sha512").update(payload).digest("base64")}`;
    const sha1 = createHash("sha1").update(payload).digest("hex");
    if (sha512 !== expectedSha512 || sha1 !== expectedSha1.toLowerCase()) {
      throw new Error("npm pack tarball bytes do not match npm integrity metadata");
    }
    const { manifest } = parsePackedTreeManifest(payload);
    proof = { path: resolvedTarballPath, ...afterIdentity, sha512, sha1, manifest };
    if (expectedProof && JSON.stringify(proof) !== JSON.stringify(expectedProof)) {
      throw new Error("npm pack tarball identity changed during isolated installation");
    }
  } catch (error) {
    primaryError = error;
  }

  let closeError: unknown = null;
  if (descriptor !== null) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError && closeError) {
    throw new AggregateError([primaryError, closeError], "tarball verification and descriptor close both failed");
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return proof as PackedTarballProof;
}

function packedManifestFileEntries(manifest: PackedTreeManifest) {
  return manifest.entries.filter((entry) => entry.type === "file");
}

export function assertPackMetadataMatchesManifest(packEntry: LooseRecord, manifest: PackedTreeManifest) {
  const metadataFiles = Array.isArray(packEntry.files) ? packEntry.files.map(recordValue) : [];
  const expected = new Map<string, { size: number; mode: number }>();
  for (const file of metadataFiles) {
    const filePath = String(file.path || "");
    const size = Number(file.size);
    const mode = Number(file.mode);
    if (
      !filePath
      || expected.has(filePath)
      || !Number.isSafeInteger(size)
      || size < 0
      || !Number.isSafeInteger(mode)
      || mode < 0
    ) {
      throw new Error("npm pack file metadata is missing, duplicated, or invalid");
    }
    expected.set(filePath, { size, mode: mode & 0o777 });
  }
  const actualFiles = packedManifestFileEntries(manifest);
  if (actualFiles.length !== expected.size) {
    throw new Error("npm pack JSON file list does not exactly match the verified tar archive");
  }
  for (const file of actualFiles) {
    const metadata = expected.get(file.path);
    if (!metadata || metadata.size !== file.size || metadata.mode !== file.mode) {
      throw new Error(`npm pack JSON metadata does not match verified tar entry: ${file.path}`);
    }
  }
}

function readVerifiedTarballPayload(tarballPath: string, proof: PackedTarballProof) {
  const payload = readFileSync(tarballPath);
  const sha512 = `sha512-${createHash("sha512").update(payload).digest("base64")}`;
  const sha1 = createHash("sha1").update(payload).digest("hex");
  if (payload.length !== Number(proof.size) || sha512 !== proof.sha512 || sha1 !== proof.sha1) {
    throw new Error("npm pack tarball bytes changed after verification");
  }
  return payload;
}

function lockPackagePathForDependency(
  packages: Record<string, LooseRecord>,
  requesterPath: string,
  dependencyName: string,
) {
  let current = requesterPath;
  while (true) {
    const candidate = current
      ? `${current}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    if (!current) break;
    const marker = current.lastIndexOf("/node_modules/");
    current = marker === -1 ? "" : current.slice(0, marker);
  }
  throw new Error(`committed lock does not resolve production dependency ${dependencyName} from ${requesterPath || "root"}`);
}

function canonicalDependencyMap(value: unknown) {
  return Object.fromEntries(
    Object.entries(recordValue(value))
      .map(([name, range]) => [name, String(range)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function packedNodeModulesPackageRoot(packageJsonPath: string) {
  const segments = packageJsonPath.split("/");
  if (segments.pop() !== "package.json") return null;
  if (segments.length === 0 || segments[0] !== "node_modules") return null;
  let index = 0;
  while (index < segments.length) {
    if (segments[index] !== "node_modules") return null;
    index += 1;
    if (segments[index]?.startsWith("@")) {
      if (!segments[index + 1]) return null;
      index += 2;
    } else {
      if (!segments[index]) return null;
      index += 1;
    }
  }
  return segments.join("/");
}

function bundledPackageContainerPaths(packageRoots: readonly string[]) {
  const containers = new Set<string>(["node_modules"]);
  for (const packageRoot of packageRoots) {
    if (packedNodeModulesPackageRoot(`${packageRoot}/package.json`) !== packageRoot) {
      throw new Error(`production dependency has an unsafe package path in the committed lock: ${packageRoot}`);
    }
    const segments = packageRoot.split("/");
    containers.add(packageRoot);
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index] !== "node_modules") continue;
      containers.add(segments.slice(0, index + 1).join("/"));
      if (segments[index + 1]?.startsWith("@")) {
        containers.add(segments.slice(0, index + 2).join("/"));
      }
    }
  }
  return containers;
}

export function assertBundledManifestOwnership(
  manifest: PackedTreeManifest,
  packageRoots: readonly string[],
) {
  const roots = [...new Set(packageRoots)].sort((left, right) => right.length - left.length);
  const containers = bundledPackageContainerPaths(roots);
  for (const entry of manifest.entries) {
    if (entry.path !== "node_modules" && !entry.path.startsWith("node_modules/")) continue;
    if (containers.has(entry.path)) {
      if (entry.type !== "directory") {
        throw new Error(`bundled dependency container is not a directory: ${entry.path}`);
      }
      continue;
    }
    const owner = roots.find((packageRoot) => entry.path.startsWith(`${packageRoot}/`));
    if (!owner) {
      throw new Error(`bundled dependency entry is not owned by the committed production closure: ${entry.path}`);
    }
    const relativePath = entry.path.slice(owner.length + 1);
    if (relativePath === "node_modules" || relativePath.startsWith("node_modules/")) {
      throw new Error(`bundled dependency nested entry is not owned by an independently locked package: ${entry.path}`);
    }
  }
}

type NumericSemver = [number, number, number];

function parseNumericSemver(value: string): NumericSemver | null {
  const match = value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareNumericSemver(left: NumericSemver, right: NumericSemver) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function assertLockedVersionSatisfiesRange(version: string, range: string, edge: string) {
  const actual = parseNumericSemver(version);
  if (!actual) throw new Error(`locked dependency version is not a supported semantic version: ${edge}`);
  const exact = parseNumericSemver(range);
  if (exact) {
    if (compareNumericSemver(actual, exact) !== 0) throw new Error(`locked dependency violates exact range ${range}: ${edge}`);
    return;
  }
  const operator = range[0];
  if (operator !== "^" && operator !== "~") {
    throw new Error(`production dependency range is unsupported by the fail-closed release verifier: ${edge} (${range})`);
  }
  const lower = parseNumericSemver(range.slice(1));
  if (!lower) throw new Error(`production dependency range is invalid: ${edge} (${range})`);
  let upper: NumericSemver;
  if (operator === "~") upper = [lower[0], lower[1] + 1, 0];
  else if (lower[0] > 0) upper = [lower[0] + 1, 0, 0];
  else if (lower[1] > 0) upper = [0, lower[1] + 1, 0];
  else upper = [0, 0, lower[2] + 1];
  if (compareNumericSemver(actual, lower) < 0 || compareNumericSemver(actual, upper) >= 0) {
    throw new Error(`locked dependency ${version} violates declared range ${range}: ${edge}`);
  }
}

export function assertBundledProductionClosure({
  tarballPath,
  proof,
  sourcePackage,
  packageLock,
}: {
  tarballPath: string;
  proof: PackedTarballProof;
  sourcePackage: LooseRecord;
  packageLock: LooseRecord;
}) {
  const sourceDependencies = canonicalDependencyMap(sourcePackage.dependencies);
  const bundled = Array.isArray(sourcePackage.bundleDependencies)
    ? sourcePackage.bundleDependencies
    : Array.isArray(sourcePackage.bundledDependencies)
      ? sourcePackage.bundledDependencies
      : [];
  const directNames = Object.keys(sourceDependencies).sort();
  const bundledNames = bundled.map(String).sort();
  if (JSON.stringify(directNames) !== JSON.stringify(bundledNames)) {
    throw new Error("every production dependency must be explicitly bundled into the release tarball");
  }

  const rawPackages = recordValue(packageLock.packages);
  const packages: Record<string, LooseRecord> = {};
  for (const [packagePath, value] of Object.entries(rawPackages)) packages[packagePath] = recordValue(value);
  const lockRoot = packages[""];
  if (!lockRoot || packageLock.lockfileVersion !== 3) {
    throw new Error("committed npm lock must use lockfileVersion 3 and contain a root package");
  }
  if (
    lockRoot.name !== sourcePackage.name
    || lockRoot.version !== sourcePackage.version
    || JSON.stringify(canonicalDependencyMap(lockRoot.dependencies)) !== JSON.stringify(sourceDependencies)
  ) {
    throw new Error("committed npm lock root does not match the source package identity and dependencies");
  }

  const closure = new Map<string, LooseRecord>();
  const pending = directNames.map((name) => ({ requester: "", name, range: sourceDependencies[name] }));
  while (pending.length > 0) {
    const next = pending.shift() as { requester: string; name: string; range: string };
    const packagePath = lockPackagePathForDependency(packages, next.requester, next.name);
    const locked = packages[packagePath];
    assertLockedVersionSatisfiesRange(
      String(locked.version || ""),
      next.range,
      `${next.requester || "root"} -> ${next.name}`,
    );
    if (closure.has(packagePath)) continue;
    const version = String(locked.version || "");
    const resolved = String(locked.resolved || "");
    const integrity = String(locked.integrity || "");
    if (
      !version
      || !/^https:\/\/registry\.npmjs\.org\//.test(resolved)
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)
    ) {
      throw new Error(`production dependency lacks exact registry provenance in the committed lock: ${packagePath}`);
    }
    if (next.requester === "" && sourceDependencies[next.name] !== version) {
      throw new Error(`root production dependency must be pinned exactly to ${version}: ${next.name}`);
    }
    closure.set(packagePath, locked);
    for (const [dependencyName, range] of Object.entries(canonicalDependencyMap(locked.dependencies))) {
      pending.push({ requester: packagePath, name: dependencyName, range });
    }
  }

  const payload = readVerifiedTarballPayload(tarballPath, proof);
  const parsed = parsePackedTreeManifest(payload);
  if (JSON.stringify(parsed.manifest) !== JSON.stringify(proof.manifest)) {
    throw new Error("npm pack tar manifest changed after its verified proof was captured");
  }
  const packedRootJson = parsed.filePayloads.get("package.json");
  if (!packedRootJson) throw new Error("verified npm tarball has no package.json");
  const packedRoot = recordValue(JSON.parse(packedRootJson.toString("utf8")));
  const packedBundled = Array.isArray(packedRoot.bundleDependencies)
    ? packedRoot.bundleDependencies.map(String).sort()
    : Array.isArray(packedRoot.bundledDependencies)
      ? packedRoot.bundledDependencies.map(String).sort()
      : [];
  if (
    packedRoot.name !== sourcePackage.name
    || packedRoot.version !== sourcePackage.version
    || JSON.stringify(canonicalDependencyMap(packedRoot.dependencies)) !== JSON.stringify(sourceDependencies)
    || JSON.stringify(packedBundled) !== JSON.stringify(bundledNames)
  ) {
    throw new Error("verified tarball package metadata does not preserve the locked bundled dependency declaration");
  }

  const packedPackageRoots = new Set(
    packedManifestFileEntries(proof.manifest)
      .map((entry) => entry.path)
      .map(packedNodeModulesPackageRoot)
      .filter((packageRoot): packageRoot is string => packageRoot !== null),
  );
  const expectedPackageRoots = new Set(closure.keys());
  if (
    packedPackageRoots.size !== expectedPackageRoots.size
    || [...packedPackageRoots].some((packagePath) => !expectedPackageRoots.has(packagePath))
  ) {
    throw new Error("verified tarball bundled package closure does not exactly match the committed production lock");
  }
  assertBundledManifestOwnership(proof.manifest, [...expectedPackageRoots]);
  const result: Array<{
    packagePath: string;
    name: string;
    version: string;
    integrity: string;
    dependencies: Record<string, string>;
  }> = [];
  for (const [packagePath, locked] of closure) {
    const packageJson = parsed.filePayloads.get(`${packagePath}/package.json`);
    if (!packageJson) throw new Error(`verified tarball is missing bundled package metadata: ${packagePath}`);
    const metadata = recordValue(JSON.parse(packageJson.toString("utf8")));
    const expectedName = packagePath.split("/node_modules/").at(-1)?.replace(/^node_modules\//, "");
    if (metadata.name !== expectedName || metadata.version !== locked.version) {
      throw new Error(`bundled dependency identity does not match the committed lock: ${packagePath}`);
    }
    result.push({
      packagePath,
      name: String(metadata.name),
      version: String(locked.version),
      integrity: String(locked.integrity),
      dependencies: canonicalDependencyMap(locked.dependencies),
    });
  }
  return result.sort((left, right) => left.packagePath.localeCompare(right.packagePath));
}

export function assertDoctorHealth(result: { ok: boolean; stdout?: string }) {
  if (!result.ok) throw new Error("cpb doctor command failed");
  let data: LooseRecord;
  try {
    data = recordValue(JSON.parse(result.stdout || ""));
  } catch (cause) {
    throw new Error("cpb doctor did not return valid JSON", { cause });
  }
  if (!Array.isArray(data.checks)) throw new Error("cpb doctor checks are missing");
  const errors = data.checks
    .map(recordValue)
    .filter((check) => check.status === "error");
  const summary = recordValue(data.summary);
  const errorCount = Number(summary.error || 0);
  if (!Number.isSafeInteger(errorCount) || errorCount < 0) {
    throw new Error("cpb doctor error count is invalid");
  }
  if (errors.length > 0 || errorCount > 0) {
    const messages = errors.map((check) => String(check.message || "unknown doctor error"));
    throw new Error(`cpb doctor reported errors: ${messages.join(", ") || errorCount}`);
  }
  return summary;
}

export function e2eResultExitCode(result: string) {
  return result === "completed" ? 0 : 1;
}

export async function withGuaranteedHubTeardown<T>(
  action: () => T | Promise<T>,
  teardown: () => unknown | Promise<unknown>,
): Promise<T> {
  let actionFailed = false;
  let actionError: unknown;
  try {
    return await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
    throw error;
  } finally {
    try {
      await teardown();
    } catch (teardownError) {
      if (actionFailed) {
        throw new AggregateError(
          [actionError, teardownError],
          "E2E pipeline and Hub teardown both failed",
        );
      }
      throw teardownError;
    }
  }
}

export async function enqueueExactIssueBeforeHubStart<T>({
  enqueueExactIssue,
  disableAutomation,
  startHub,
}: {
  enqueueExactIssue: () => boolean | Promise<boolean>;
  disableAutomation: () => unknown | Promise<unknown>;
  startHub: () => T | Promise<T>;
}): Promise<T> {
  let enqueueError: unknown = null;
  try {
    const enqueued = await enqueueExactIssue();
    if (!enqueued) throw new Error("authorized GitHub issue was not enqueued");
  } catch (error) {
    enqueueError = error;
  }

  try {
    await disableAutomation();
  } catch (disableError) {
    if (enqueueError) {
      throw new AggregateError(
        [enqueueError, disableError],
        "exact issue enqueue and automation disable both failed",
      );
    }
    throw disableError;
  }

  if (enqueueError) throw enqueueError;
  return await startHub();
}

function configureAgentRoute() {
  if (AGENT_MODE === "codex") {
    log("GITHUB", "Configuring deterministic ACP agent route (codex all phases)...");
    runInstalledCpb(["config", PROJECT, "--agent", "codex"], { silent: true });
    return { description: "codex all phases", expected: ["default: codex"] };
  }

  if (AGENT_MODE === "claude" || AGENT_MODE === "cc") {
    log("GITHUB", "Configuring deterministic ACP agent route (Claude Code all phases)...");
    runInstalledCpb(["config", PROJECT, "--agent", "claude"], { silent: true });
    return { description: "claude all phases", expected: ["default: claude"] };
  }

  if (AGENT_MODE === "mixed") {
    log("GITHUB", "Configuring deterministic ACP agent route (Codex plan/verify, Claude Code execute)...");
    runInstalledCpb(["config", PROJECT, "--unset-agent"], { silent: true });
    runInstalledCpb(["config", PROJECT, "--plan-agent", "codex"], { silent: true });
    runInstalledCpb(["config", PROJECT, "--execute-agent", "claude"], { silent: true });
    runInstalledCpb(["config", PROJECT, "--verify-agent", "codex"], { silent: true });
    runInstalledCpb(["config", PROJECT, "--review-agent", "codex"], { silent: true });
    return {
      description: "mixed codex/claude",
      expected: ["plan: codex", "execute: claude", "verify: codex", "review: codex"],
    };
  }

  if (AGENT_MODE === "default") {
    log("GITHUB", "Clearing project agent overrides (registry defaults)...");
    runInstalledCpb(["config", PROJECT, "--unset-agent"], { silent: true });
    return { description: "registry defaults", expected: ["No agent overrides"] };
  }

  throw new Error(`Unsupported CPB_E2E_AGENT_MODE '${AGENT_MODE}'. Use codex, mixed, claude, cc, or default.`);
}

// ─── Step 1: Stop everything ───────────────────────────────────────
function stepStop() {
  log("STOP", "Stopping the Hub control plane...");
  // Hub shutdown owns the exact spawn-time identities for its workers and ACP
  // processes. Treat an unverified shutdown as an E2E failure; never replace
  // that ownership proof with a command-line pattern kill.
  runInstalledCpb(["hub", "stop"], { silent: true });
  pass("Stopped the Hub control plane");
}

// ─── Step 2: Clean state ───────────────────────────────────────────
function stepClean() {
  if (KEEP_STATE) {
    log("CLEAN", "Reusing explicitly marked disposable state (--keep-state); no paths will be deleted");
    return;
  }
  log("CLEAN", "Using the verified pristine disposable Hub root; no repository or filesystem cleanup is performed");
  pass("Disposable state is pristine");
}

// ─── Step 3: npm pack + global install ─────────────────────────────
type E2ePackWorkspace = Pick<TemporaryWorkspace, "rootPath" | "cleanup">;

type E2ePackInstallation = {
  binDir: string;
  runtimePath?: string;
  runCpb?: (args: readonly string[], options?: ShellRunOptions) => ShellRunResult;
  verify?: () => void | Promise<void>;
  validateRuntime?: () => void;
  dispose?: () => void | Promise<void>;
};

type IsolatedPackOptions = {
  env?: NodeJS.ProcessEnv;
  createWorkspace?: () => Promise<E2ePackWorkspace>;
  prepare?: (rootPath: string) => E2ePackInstallation | Promise<E2ePackInstallation>;
};

const ISOLATED_PACK_ENV_KEYS = [
  "CPB_ROOT",
  "CPB_EXECUTOR_ROOT",
  "CPB_PROJECT_RUNTIME_ROOT",
  "CPB_HUB_STATE_REDIS_CONFIG_FILE",
  "CPB_DANGEROUS",
  "NODE_OPTIONS",
  "NODE_PATH",
] as const;

let activeInstalledCpbRunner: E2ePackInstallation["runCpb"] | null = null;

function runInstalledCpb(args: readonly string[], options: ShellRunOptions = {}) {
  if (!activeInstalledCpbRunner) throw new Error("isolated installed cpb runner is not active");
  return activeInstalledCpbRunner(args, options);
}

export async function withIsolatedPackInstallation<T>(
  operation: (installation: E2ePackInstallation) => T | Promise<T>,
  options: IsolatedPackOptions = {},
): Promise<T> {
  const env = options.env || process.env;
  const workspace = await (options.createWorkspace || (() => createTemporaryWorkspace({
    prefix: "cpb-e2e-pack-",
    env,
  })))();
  const originalPath = env.PATH;
  const inheritedValues = new Map<string, { present: boolean; value: string | undefined }>();
  for (const key of ISOLATED_PACK_ENV_KEYS) {
    inheritedValues.set(key, {
      present: Object.prototype.hasOwnProperty.call(env, key),
      value: env[key],
    });
    delete env[key];
  }
  let result: T | undefined;
  let primaryError: unknown = null;
  let installation: E2ePackInstallation | null = null;
  const inheritedRuntimeValidator = activePackRuntimeValidator;
  const inheritedCpbRunner = activeInstalledCpbRunner;

  try {
    installation = await (options.prepare || stepPack)(workspace.rootPath);
    activePackRuntimeValidator = installation.validateRuntime
      ? () => {
        inheritedRuntimeValidator?.();
        installation?.validateRuntime?.();
      }
      : inheritedRuntimeValidator;
    activeInstalledCpbRunner = installation.runCpb || inheritedCpbRunner;
    env.PATH = installation.runtimePath || installation.binDir;
    await installation.verify?.();
    result = await operation(installation);
  } catch (error) {
    primaryError = error;
  }

  activePackRuntimeValidator = inheritedRuntimeValidator;
  activeInstalledCpbRunner = inheritedCpbRunner;

  if (originalPath === undefined) delete env.PATH;
  else env.PATH = originalPath;
  for (const key of ISOLATED_PACK_ENV_KEYS) {
    const inherited = inheritedValues.get(key);
    if (inherited?.present && inherited.value !== undefined) env[key] = inherited.value;
    else delete env[key];
  }

  let disposeError: unknown = null;
  try {
    await installation?.dispose?.();
  } catch (error) {
    disposeError = error;
  }

  let cleanupError: unknown = null;
  try {
    await workspace.cleanup();
  } catch (error) {
    cleanupError = error;
  }

  const lifecycleErrors = [primaryError, disposeError, cleanupError].filter((error) => error !== null);
  if (lifecycleErrors.length > 1) {
    throw new AggregateError(
      lifecycleErrors,
      "isolated npm-pack E2E operation, installation disposal, or workspace cleanup failed",
    );
  }
  if (lifecycleErrors.length === 1) throw lifecycleErrors[0];
  return result as T;
}

type InstallPrefixIdentity = {
  dev: string;
  ino: string;
  birthtimeNs: string;
  mode: string;
  uid: string;
  gid: string;
};

function installPrefixIdentity(details: BigIntStats): InstallPrefixIdentity {
  return {
    dev: String(details.dev),
    ino: String(details.ino),
    birthtimeNs: String(details.birthtimeNs),
    mode: String(details.mode),
    uid: String(details.uid),
    gid: String(details.gid),
  };
}

function sameInstallPrefixIdentity(left: InstallPrefixIdentity, right: InstallPrefixIdentity) {
  return Object.keys(left).every((key) => (
    left[key as keyof InstallPrefixIdentity] === right[key as keyof InstallPrefixIdentity]
  ));
}

function assertInstallPrefixAuthority({
  descriptor,
  canonicalPackDir,
  canonicalPrefix,
  expectedIdentity,
}: {
  descriptor: number;
  canonicalPackDir: string;
  canonicalPrefix: string;
  expectedIdentity: InstallPrefixIdentity;
}) {
  if (path.dirname(canonicalPrefix) !== canonicalPackDir) {
    throw new Error("isolated npm prefix is not a direct child of the owned pack directory");
  }
  if (realpathSync(canonicalPrefix) !== canonicalPrefix) {
    throw new Error("isolated npm prefix path is no longer canonical");
  }
  const descriptorDetails = fstatSync(descriptor, { bigint: true });
  const pathDetails = lstatSync(canonicalPrefix, { bigint: true });
  const descriptorIdentity = installPrefixIdentity(descriptorDetails);
  if (
    !descriptorDetails.isDirectory()
    || descriptorDetails.isSymbolicLink()
    || !pathDetails.isDirectory()
    || pathDetails.isSymbolicLink()
    || (typeof process.getuid === "function" && descriptorDetails.uid !== BigInt(process.getuid()))
    || (descriptorDetails.mode & 0o077n) !== 0n
    || !sameInstallPrefixIdentity(descriptorIdentity, expectedIdentity)
    || !sameInstallPrefixIdentity(descriptorIdentity, installPrefixIdentity(pathDetails))
  ) {
    throw new Error("isolated npm prefix identity changed or is not owner-private");
  }
}

type BoundInstallPrefixAuthority = {
  validate: () => void;
  dispose: () => void;
};

export function bindInstallPrefixAuthority(
  canonicalPackDir: string,
  canonicalPrefix: string,
): BoundInstallPrefixAuthority {
  const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_DIRECTORY || 0);
  let descriptor: number | null = openSync(canonicalPrefix, directoryFlags);
  const expectedIdentity = installPrefixIdentity(fstatSync(descriptor, { bigint: true }));

  const validate = () => {
    if (descriptor === null) throw new Error("isolated npm prefix authority is already closed");
    assertInstallPrefixAuthority({
      descriptor,
      canonicalPackDir,
      canonicalPrefix,
      expectedIdentity,
    });
  };

  const dispose = () => {
    if (descriptor === null) return;
    let validationError: unknown = null;
    try {
      validate();
    } catch (error) {
      validationError = error;
    }
    const descriptorToClose = descriptor;
    descriptor = null;
    let closeError: unknown = null;
    try {
      closeSync(descriptorToClose);
    } catch (error) {
      closeError = error;
    }
    if (validationError && closeError) {
      throw new AggregateError([validationError, closeError], "isolated npm prefix validation and close both failed");
    }
    if (validationError) throw validationError;
    if (closeError) throw closeError;
  };

  try {
    validate();
  } catch (primaryError) {
    try {
      dispose();
    } catch (disposeError) {
      throw new AggregateError(
        [primaryError, disposeError],
        "isolated npm prefix binding failed and descriptor disposal also failed",
      );
    }
    throw primaryError;
  }
  return { validate, dispose };
}

type TrustedNpmRuntime = {
  canonicalNode: string;
  canonicalNpmCli: string;
  npmVersion: string;
};

function assertTrustedExecutable(filePath: string, executable: boolean) {
  const canonical = realpathSync(filePath);
  if (canonical !== filePath) throw new Error(`trusted runtime path must already be canonical: ${filePath}`);
  const details = lstatSync(canonical, { bigint: true });
  const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : details.uid;
  if (
    !details.isFile()
    || details.isSymbolicLink()
    || (details.uid !== currentUid && details.uid !== 0n)
    || (details.mode & 0o022n) !== 0n
    || (executable && (details.mode & 0o111n) === 0n)
  ) {
    throw new Error(`trusted runtime file identity is unsafe: ${canonical}`);
  }
  return canonical;
}

export function resolveTrustedNpmRuntime(nodeExecutable = process.execPath): TrustedNpmRuntime {
  const canonicalNode = assertTrustedExecutable(realpathSync(nodeExecutable), true);
  const nodePrefix = path.resolve(path.dirname(canonicalNode), "..");
  const candidates = [
    path.join(nodePrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(nodePrefix, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(canonicalNode), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const npmCliCandidate = candidates.find((candidate) => existsSync(candidate));
  if (!npmCliCandidate) {
    throw new Error(`could not locate the npm CLI adjacent to canonical Node runtime ${canonicalNode}`);
  }
  const canonicalNpmCli = assertTrustedExecutable(realpathSync(npmCliCandidate), false);
  const npmRoot = path.resolve(path.dirname(canonicalNpmCli), "..");
  assertStrictPathDescendant(nodePrefix, npmRoot, "trusted npm package root");
  const npmPackagePath = path.join(npmRoot, "package.json");
  const npmPackage = recordValue(JSON.parse(readFileSync(npmPackagePath, "utf8")));
  const npmVersion = String(npmPackage.version || "");
  if (npmPackage.name !== "npm" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(npmVersion)) {
    throw new Error("canonical npm CLI is not backed by a valid npm package identity");
  }
  return { canonicalNode, canonicalNpmCli, npmVersion };
}

type BoundStaticFile = {
  validate: () => void;
  dispose: () => void;
};

function bindStaticFile(filePath: string, { empty = false }: { empty?: boolean } = {}): BoundStaticFile {
  let descriptor: number | null = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const details = fstatSync(descriptor, { bigint: true });
  const identity = runtimePathIdentity(details);
  const expectedHash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  const validate = () => {
    if (descriptor === null) throw new Error(`bound static file is already closed: ${filePath}`);
    const descriptorDetails = fstatSync(descriptor, { bigint: true });
    const pathDetails = lstatSync(filePath, { bigint: true });
    if (
      !descriptorDetails.isFile()
      || descriptorDetails.isSymbolicLink()
      || !sameRuntimePathIdentity(runtimePathIdentity(descriptorDetails), identity)
      || !sameRuntimePathIdentity(runtimePathIdentity(pathDetails), identity)
      || (empty && descriptorDetails.size !== 0n)
      || createHash("sha256").update(readFileSync(filePath)).digest("hex") !== expectedHash
    ) {
      throw new Error(`bound static file identity or bytes changed: ${filePath}`);
    }
  };
  const dispose = () => {
    if (descriptor === null) return;
    let validationError: unknown = null;
    try {
      validate();
    } catch (error) {
      validationError = error;
    }
    const toClose = descriptor;
    descriptor = null;
    let closeError: unknown = null;
    try {
      closeSync(toClose);
    } catch (error) {
      closeError = error;
    }
    if (validationError && closeError) {
      throw new AggregateError([validationError, closeError], `static file validation and close failed: ${filePath}`);
    }
    if (validationError) throw validationError;
    if (closeError) throw closeError;
  };
  validate();
  return { validate, dispose };
}

function captureTrustedRuntimeTree(root: string): PackedTreeManifest {
  const entries: PackedTreeManifestEntry[] = [];
  const visit = (directory: string, relativeDirectory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const details = lstatSync(absolute, { bigint: true });
      const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : details.uid;
      if (
        details.isSymbolicLink()
        || realpathSync(absolute) !== absolute
        || (details.uid !== currentUid && details.uid !== 0n)
        || (details.mode & 0o022n) !== 0n
      ) {
        throw new Error(`trusted npm runtime tree contains an unsafe path: ${relative}`);
      }
      if (details.isDirectory()) {
        entries.push({
          path: relative,
          type: "directory",
          mode: Number(details.mode & 0o777n),
          size: 0,
          sha256: null,
        });
        visit(absolute, relative);
      } else if (details.isFile() && details.nlink === 1n) {
        entries.push({
          path: relative,
          type: "file",
          mode: Number(details.mode & 0o777n),
          size: Number(details.size),
          sha256: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
        });
      } else {
        throw new Error(`trusted npm runtime tree contains a link or special file: ${relative}`);
      }
      if (entries.length > MAX_TRUSTED_RUNTIME_ENTRIES) {
        throw new Error("trusted npm runtime tree exceeds the entry-count bound");
      }
    }
  };
  visit(root, "");
  return { schemaVersion: 1, entries };
}

export function bindTrustedRuntimeTree(root: string): BoundStaticFile {
  const canonicalRoot = realpathSync(root);
  if (canonicalRoot !== root) throw new Error("trusted npm package root must already be canonical");
  const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_DIRECTORY || 0);
  let descriptor: number | null = openSync(canonicalRoot, directoryFlags);
  const rootIdentity = runtimePathIdentity(fstatSync(descriptor, { bigint: true }));
  const expectedManifest = captureTrustedRuntimeTree(canonicalRoot);
  const validate = () => {
    if (descriptor === null) throw new Error("trusted npm package tree authority is already closed");
    const descriptorDetails = fstatSync(descriptor, { bigint: true });
    const pathDetails = lstatSync(canonicalRoot, { bigint: true });
    if (
      !descriptorDetails.isDirectory()
      || descriptorDetails.isSymbolicLink()
      || !sameRuntimePathIdentity(runtimePathIdentity(descriptorDetails), rootIdentity)
      || !sameRuntimePathIdentity(runtimePathIdentity(pathDetails), rootIdentity)
    ) {
      throw new Error("trusted npm package root identity changed");
    }
    const currentManifest = captureTrustedRuntimeTree(canonicalRoot);
    if (JSON.stringify(currentManifest) !== JSON.stringify(expectedManifest)) {
      throw new Error("trusted npm package execution bytes changed");
    }
  };
  const dispose = () => {
    if (descriptor === null) return;
    let validationError: unknown = null;
    try {
      validate();
    } catch (error) {
      validationError = error;
    }
    const toClose = descriptor;
    descriptor = null;
    let closeError: unknown = null;
    try {
      closeSync(toClose);
    } catch (error) {
      closeError = error;
    }
    if (validationError && closeError) {
      throw new AggregateError([validationError, closeError], "trusted npm tree validation and close failed");
    }
    if (validationError) throw validationError;
    if (closeError) throw closeError;
  };
  validate();
  return { validate, dispose };
}

function createExclusiveEmptyFile(filePath: string) {
  const descriptor = openSync(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let primaryError: unknown = null;
  try {
    fsyncSync(descriptor);
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  try {
    closeSync(descriptor);
  } catch (error) {
    closeError = error;
  }
  if (primaryError && closeError) {
    throw new AggregateError([primaryError, closeError], `empty npm config fsync and close failed: ${filePath}`);
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
}

type TrustedNpmExecution = {
  runtime: TrustedNpmRuntime;
  runtimePath: string;
  registryPackDir: string;
  run: (args: readonly string[], options?: ShellRunOptions) => ShellRunResult;
  runNode: (args: readonly string[], options?: ShellRunOptions) => ShellRunResult;
  validate: () => void;
  dispose: () => void;
};

function resolveSelectedTool(command: string, sourcePath = process.env.PATH) {
  for (const directory of String(sourcePath || "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    try {
      const canonical = realpathSync(candidate);
      const details = lstatSync(canonical, { bigint: true });
      if (
        details.isFile()
        && !details.isSymbolicLink()
        && (details.mode & 0o111n) !== 0n
        && (details.mode & 0o022n) === 0n
      ) {
        return canonical;
      }
    } catch {}
  }
  return null;
}

export function bindTrustedToolShim(runtimeBin: string, command: string, target: string): BoundStaticFile {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(command)) throw new Error("trusted tool shim name is unsafe");
  const canonicalBin = realpathSync(runtimeBin);
  const canonicalTarget = assertTrustedExecutable(realpathSync(target), false);
  const shim = path.join(canonicalBin, command);
  if (path.dirname(shim) !== canonicalBin) throw new Error("trusted tool shim escaped its owned bin");
  symlinkSync(canonicalTarget, shim);
  const shimIdentity = runtimePathIdentity(lstatSync(shim, { bigint: true }));
  const targetAuthority = bindStaticFile(canonicalTarget);
  const validate = () => {
    targetAuthority.validate();
    const details = lstatSync(shim, { bigint: true });
    if (
      !details.isSymbolicLink()
      || realpathSync(shim) !== canonicalTarget
      || !sameRuntimePathIdentity(runtimePathIdentity(details), shimIdentity)
    ) {
      throw new Error(`owned E2E runtime tool shim changed: ${command}`);
    }
  };
  const dispose = () => {
    let validationError: unknown = null;
    try {
      validate();
    } catch (error) {
      validationError = error;
    }
    let targetError: unknown = null;
    try {
      targetAuthority.dispose();
    } catch (error) {
      targetError = error;
    }
    if (validationError && targetError) {
      throw new AggregateError([validationError, targetError], `tool shim and target disposal failed: ${command}`);
    }
    if (validationError) throw validationError;
    if (targetError) throw targetError;
  };
  validate();
  return { validate, dispose };
}

function resolveToolPackageRoot(executable: string, command: string) {
  let current = path.dirname(executable);
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      const metadata = recordValue(JSON.parse(readFileSync(packageJsonPath, "utf8")));
      const bins = typeof metadata.bin === "string" ? { [command]: metadata.bin } : recordValue(metadata.bin);
      if (typeof bins[command] === "string") return realpathSync(current);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`could not bind package-tree provenance for runtime tool: ${command}`);
}

function createTrustedNpmExecution(canonicalPackDir: string): TrustedNpmExecution {
  const runtime = resolveTrustedNpmRuntime();
  const runtimeRoot = path.join(canonicalPackDir, "npm-runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const cacheDir = path.join(runtimeRoot, "cache");
  const tempDir = path.join(runtimeRoot, "tmp");
  const logsDir = path.join(runtimeRoot, "logs");
  const registryPackDir = path.join(runtimeRoot, "registry-packs");
  const buildLockDir = path.join(runtimeRoot, "build-locks");
  const runtimeBin = path.join(runtimeRoot, "bin");
  for (const directory of [cacheDir, tempDir, logsDir, registryPackDir, buildLockDir, runtimeBin]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const userConfig = path.join(runtimeRoot, "user.npmrc");
  const globalConfig = path.join(runtimeRoot, "global.npmrc");
  createExclusiveEmptyFile(userConfig);
  createExclusiveEmptyFile(globalConfig);
  const selectedTools = new Map<string, string>();
  selectedTools.set("node", runtime.canonicalNode);
  selectedTools.set("npm", runtime.canonicalNpmCli);
  const canonicalNpxCli = path.join(path.dirname(runtime.canonicalNpmCli), "npx-cli.js");
  if (existsSync(canonicalNpxCli)) selectedTools.set("npx", assertTrustedExecutable(realpathSync(canonicalNpxCli), false));
  for (const command of ["git", "gh", "codegraph", "codex", "claude", "cc"]) {
    const resolved = resolveSelectedTool(command);
    if (resolved) selectedTools.set(command, resolved);
  }
  for (const required of [
    "git",
    "gh",
    "codegraph",
    ...(AGENT_MODE === "codex" ? ["codex"] : []),
    ...(AGENT_MODE === "mixed" ? ["codex", "claude"] : []),
    ...(AGENT_MODE === "claude" || AGENT_MODE === "cc" ? ["claude"] : []),
  ]) {
    if (!selectedTools.has(required)) throw new Error(`required E2E runtime tool is unavailable: ${required}`);
  }
  const boundToolShims = [...selectedTools].map(([command, target]) => (
    bindTrustedToolShim(runtimeBin, command, target)
  ));
  const boundFiles = [
    bindStaticFile(runtime.canonicalNode),
    bindTrustedRuntimeTree(path.resolve(path.dirname(runtime.canonicalNpmCli), "..")),
    bindTrustedRuntimeTree(resolveToolPackageRoot(selectedTools.get("codegraph") as string, "codegraph")),
    bindStaticFile(userConfig, { empty: true }),
    bindStaticFile(globalConfig, { empty: true }),
  ];
  const fixedArgs = [
    `--userconfig=${userConfig}`,
    `--globalconfig=${globalConfig}`,
    `--cache=${cacheDir}`,
    `--logs-dir=${logsDir}`,
    "--registry=https://registry.npmjs.org/",
    "--ignore-scripts",
    "--audit=false",
    "--fund=false",
    "--update-notifier=false",
    "--progress=false",
    "--color=false",
    "--umask=022",
  ];
  const runtimePath = [runtimeBin, "/usr/bin", "/bin"].join(path.delimiter);
  const childEnv = sanitizeE2eChildEnvironment(process.env, {
    npm: true,
    ownedHome: runtimeRoot,
    ownedTemp: tempDir,
    pathValue: runtimePath,
  });
  for (const key of Object.keys(childEnv)) {
    if (/^CPB_BUILD_/i.test(key)) delete childEnv[key];
  }
  childEnv.CPB_BUILD_LOCK_ROOT = buildLockDir;
  const validate = () => {
    for (const bound of boundFiles) bound.validate();
    for (const bound of boundToolShims) bound.validate();
    for (const directory of [runtimeRoot, cacheDir, tempDir, logsDir, registryPackDir, buildLockDir, runtimeBin]) {
      const details = lstatSync(directory, { bigint: true });
      if (
        !details.isDirectory()
        || details.isSymbolicLink()
        || realpathSync(directory) !== directory
        || (details.mode & 0o077n) !== 0n
        || (typeof process.getuid === "function" && details.uid !== BigInt(process.getuid()))
      ) {
        throw new Error(`owned npm runtime directory identity is unsafe: ${directory}`);
      }
    }
    const actualShims = readdirSync(runtimeBin).sort();
    const expectedShims = [...selectedTools.keys()].sort();
    if (JSON.stringify(actualShims) !== JSON.stringify(expectedShims)) {
      throw new Error("owned E2E runtime bin contents changed");
    }
  };
  const runNpm = (args: readonly string[], options: ShellRunOptions = {}) => {
    validate();
    const result = runFile(runtime.canonicalNode, [runtime.canonicalNpmCli, ...fixedArgs, ...args], {
      ...options,
      cwd: options.cwd || canonicalPackDir,
      env: { ...childEnv, ...options.env },
      exactEnv: true,
      npmEnvironment: true,
    });
    validate();
    return result;
  };
  const runNode = (args: readonly string[], options: ShellRunOptions = {}) => {
    validate();
    const result = runFile(runtime.canonicalNode, args, {
      ...options,
      env: { ...childEnv, ...options.env },
      exactEnv: true,
    });
    validate();
    return result;
  };
  const dispose = () => {
    const errors: unknown[] = [];
    try {
      validate();
    } catch (error) {
      errors.push(error);
    }
    for (const bound of boundFiles.reverse()) {
      try {
        bound.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const bound of boundToolShims.reverse()) {
      try {
        bound.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "trusted npm execution authority disposal failed");
  };
  validate();
  return {
    runtime,
    runtimePath,
    registryPackDir,
    run: runNpm,
    runNode,
    validate,
    dispose,
  };
}

function parseSingleNpmPackResult(result: ShellRunResult, expectedName: string, expectedVersion: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error("trusted npm pack did not return valid JSON", { cause });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("trusted npm pack must return exactly one package result");
  }
  const entry = recordValue(parsed[0]);
  if (entry.name !== expectedName || entry.version !== expectedVersion || !entry.filename) {
    throw new Error("trusted npm pack result does not match the exact requested package identity");
  }
  return entry;
}

export function assertManifestSubtreeMatchesRegistryPackage({
  bundledManifest,
  packagePath,
  registryManifest,
}: {
  bundledManifest: PackedTreeManifest;
  packagePath: string;
  registryManifest: PackedTreeManifest;
}) {
  const prefix = `${packagePath}/`;
  const bundledEntries = bundledManifest.entries
    .filter((entry) => entry.path.startsWith(prefix))
    .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }))
    .filter((entry) => entry.path !== "node_modules" && !entry.path.startsWith("node_modules/"))
    .sort((left, right) => left.path.localeCompare(right.path));
  const registryOwnEntries = registryManifest.entries
    .filter((entry) => entry.path !== "node_modules" && !entry.path.startsWith("node_modules/"))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (JSON.stringify(bundledEntries) !== JSON.stringify(registryOwnEntries)) {
    throw new Error(`bundled dependency bytes differ from the lock-integrity registry tarball: ${packagePath}`);
  }
}

export function assertRegistryDependencyProvenance({
  dependency,
  registryEntry,
  registryProof,
  registryMetadata,
  bundledManifest,
}: {
  dependency: {
    packagePath: string;
    name: string;
    version: string;
    integrity: string;
    dependencies: Record<string, string>;
  };
  registryEntry: LooseRecord;
  registryProof: PackedTarballProof;
  registryMetadata: LooseRecord;
  bundledManifest: PackedTreeManifest;
}) {
  if (
    registryEntry.name !== dependency.name
    || registryEntry.version !== dependency.version
    || registryEntry.integrity !== dependency.integrity
    || registryProof.sha512 !== dependency.integrity
  ) {
    throw new Error(`registry tarball identity or SRI does not match the committed lock: ${dependency.name}@${dependency.version}`);
  }
  if (
    registryMetadata.name !== dependency.name
    || registryMetadata.version !== dependency.version
    || JSON.stringify(canonicalDependencyMap(registryMetadata.dependencies)) !== JSON.stringify(dependency.dependencies)
  ) {
    throw new Error(`registry tarball dependency metadata does not exactly match the committed lock: ${dependency.name}@${dependency.version}`);
  }
  assertManifestSubtreeMatchesRegistryPackage({
    bundledManifest,
    packagePath: dependency.packagePath,
    registryManifest: registryProof.manifest,
  });
}

function verifyBundledRegistryProvenance({
  npmExecution,
  bundledManifest,
  closure,
}: {
  npmExecution: TrustedNpmExecution;
  bundledManifest: PackedTreeManifest;
  closure: Array<{
    packagePath: string;
    name: string;
    version: string;
    integrity: string;
    dependencies: Record<string, string>;
  }>;
}) {
  for (const dependency of closure) {
    npmExecution.validate();
    const result = npmExecution.run([
      "pack",
      `${dependency.name}@${dependency.version}`,
      "--json",
      `--pack-destination=${npmExecution.registryPackDir}`,
      "--prefer-online=true",
    ], { silent: true, timeout: 120_000 });
    const entry = parseSingleNpmPackResult(result, dependency.name, dependency.version);
    const tarballPath = resolvePackedTarballPath(npmExecution.registryPackDir, entry.filename);
    const proof = assertPackedTarballIntegrity(tarballPath, entry);
    assertPackMetadataMatchesManifest(entry, proof.manifest);
    const registryPayload = readVerifiedTarballPayload(tarballPath, proof);
    const registryPackageJson = parsePackedTreeManifest(registryPayload).filePayloads.get("package.json");
    if (!registryPackageJson) {
      throw new Error(`registry tarball is missing package.json: ${dependency.name}@${dependency.version}`);
    }
    const registryMetadata = recordValue(JSON.parse(registryPackageJson.toString("utf8")));
    assertRegistryDependencyProvenance({
      dependency,
      registryEntry: entry,
      registryProof: proof,
      registryMetadata,
      bundledManifest,
    });
  }
}

function verifyPostInstallRepack({
  npmExecution,
  installedPackageRoot,
  expectedName,
  expectedVersion,
  expectedProof,
  canonicalPackDir,
}: {
  npmExecution: TrustedNpmExecution;
  installedPackageRoot: string;
  expectedName: string;
  expectedVersion: string;
  expectedProof: PackedTarballProof;
  canonicalPackDir: string;
}) {
  const repackDir = path.join(canonicalPackDir, "post-install-repack");
  mkdirSync(repackDir, { mode: 0o700 });
  const result = npmExecution.run([
    "pack",
    installedPackageRoot,
    "--json",
    `--pack-destination=${repackDir}`,
  ], { silent: true, timeout: 120_000 });
  const entry = parseSingleNpmPackResult(result, expectedName, expectedVersion);
  const tarballPath = resolvePackedTarballPath(repackDir, entry.filename);
  const proof = assertPackedTarballIntegrity(tarballPath, entry);
  assertPackMetadataMatchesManifest(entry, proof.manifest);
  if (
    proof.sha512 !== expectedProof.sha512
    || proof.sha1 !== expectedProof.sha1
    || JSON.stringify(proof.manifest) !== JSON.stringify(expectedProof.manifest)
  ) {
    throw new Error("post-install npm repack does not exactly reproduce the originally verified release tarball");
  }
}

type RuntimePathIdentity = {
  dev: string;
  ino: string;
  birthtimeNs: string;
  mode: string;
  uid: string;
  gid: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
};

function runtimePathIdentity(details: BigIntStats): RuntimePathIdentity {
  return {
    dev: String(details.dev),
    ino: String(details.ino),
    birthtimeNs: String(details.birthtimeNs),
    mode: String(details.mode),
    uid: String(details.uid),
    gid: String(details.gid),
    nlink: String(details.nlink),
    size: String(details.size),
    mtimeNs: String(details.mtimeNs),
    ctimeNs: String(details.ctimeNs),
  };
}

function sameRuntimePathIdentity(left: RuntimePathIdentity, right: RuntimePathIdentity) {
  return Object.keys(left).every((key) => (
    left[key as keyof RuntimePathIdentity] === right[key as keyof RuntimePathIdentity]
  ));
}

function assertStrictPathDescendant(parent: string, child: string, name: string) {
  const relative = path.relative(parent, child);
  if (
    !relative
    || path.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`${name} is not contained by its owned parent`);
  }
}

function assertOwnedRuntimeNode(
  nodePath: string,
  kind: "directory" | "file",
  expectedIdentity?: RuntimePathIdentity,
) {
  const details = lstatSync(nodePath, { bigint: true });
  if (
    (kind === "directory" ? !details.isDirectory() : !details.isFile())
    || details.isSymbolicLink()
    || realpathSync(nodePath) !== nodePath
    || (typeof process.getuid === "function" && details.uid !== BigInt(process.getuid()))
    || (details.mode & 0o022n) !== 0n
    || (kind === "file" && details.nlink !== 1n)
    || (expectedIdentity && !sameRuntimePathIdentity(runtimePathIdentity(details), expectedIdentity))
  ) {
    throw new Error(`installed ${kind} identity is unsafe or changed: ${nodePath}`);
  }
  return details;
}

function hashInstalledManifestFile(filePath: string, expected: PackedTreeManifestEntry) {
  let descriptor: number | null = null;
  let primaryError: unknown = null;
  let digest = "";
  try {
    descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    const pathBefore = lstatSync(filePath, { bigint: true });
    const beforeIdentity = runtimePathIdentity(before);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1n
      || before.size !== BigInt(expected.size)
      || Number(before.mode & 0o777n) !== expected.mode
      || (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
      || !sameRuntimePathIdentity(beforeIdentity, runtimePathIdentity(pathBefore))
    ) {
      throw new Error(`installed package file identity does not match its manifest: ${expected.path}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, expected.size)));
    let offset = 0;
    while (offset < expected.size) {
      const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, expected.size - offset), offset);
      if (bytesRead === 0) throw new Error(`installed package file ended early: ${expected.path}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (readSync(descriptor, buffer, 0, 1, offset) !== 0) {
      throw new Error(`installed package file exceeds its manifest size: ${expected.path}`);
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(filePath, { bigint: true });
    if (
      !sameRuntimePathIdentity(beforeIdentity, runtimePathIdentity(after))
      || !sameRuntimePathIdentity(beforeIdentity, runtimePathIdentity(pathAfter))
    ) {
      throw new Error(`installed package file changed while hashing: ${expected.path}`);
    }
    digest = hash.digest("hex");
    if (digest !== expected.sha256) {
      throw new Error(`installed package file bytes do not match the verified tarball: ${expected.path}`);
    }
  } catch (error) {
    primaryError = error;
  }
  let closeError: unknown = null;
  if (descriptor !== null) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError && closeError) {
    throw new AggregateError([primaryError, closeError], `installed file verification and close failed: ${expected.path}`);
  }
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return digest;
}

export function assertInstalledTreeMatchesManifest(
  canonicalPackageRoot: string,
  manifest: PackedTreeManifest,
) {
  if (realpathSync(canonicalPackageRoot) !== canonicalPackageRoot) {
    throw new Error("installed package root must be canonical before manifest verification");
  }
  const expected = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  if (expected.size !== manifest.entries.length) throw new Error("verified package manifest contains duplicate paths");
  const seen = new Set<string>();

  const visit = (directory: string, relativeDirectory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (!name || name === "." || name === ".." || name.includes(path.sep)) {
        throw new Error("installed package contains an unsafe directory entry");
      }
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const expectedEntry = expected.get(relative);
      if (!expectedEntry) throw new Error(`installed package contains an unexpected path: ${relative}`);
      const absolute = path.join(directory, name);
      assertStrictPathDescendant(canonicalPackageRoot, absolute, "installed manifest path");
      const details = lstatSync(absolute, { bigint: true });
      if (details.isSymbolicLink() || realpathSync(absolute) !== absolute) {
        throw new Error(`installed package manifest path is a symlink or escaped: ${relative}`);
      }
      if (typeof process.getuid === "function" && details.uid !== BigInt(process.getuid())) {
        throw new Error(`installed package manifest path is not owned by the current user: ${relative}`);
      }
      if (Number(details.mode & 0o777n) !== expectedEntry.mode) {
        throw new Error(`installed package mode does not match the verified tarball: ${relative}`);
      }
      if (expectedEntry.type === "directory") {
        if (!details.isDirectory()) throw new Error(`installed package path type changed: ${relative}`);
        visit(absolute, relative);
      } else {
        if (!details.isFile() || details.nlink !== 1n) {
          throw new Error(`installed package file type or link count is unsafe: ${relative}`);
        }
        hashInstalledManifestFile(absolute, expectedEntry);
      }
      seen.add(relative);
    }
  };

  visit(canonicalPackageRoot, "");
  const missing = manifest.entries.filter((entry) => !seen.has(entry.path));
  if (missing.length > 0) {
    throw new Error(`installed package is missing verified tar paths: ${missing.slice(0, 5).map((entry) => entry.path).join(", ")}`);
  }
  return manifest.entries.length;
}

type InstalledPackageAuthority = {
  binDir: string;
  canonicalPackageRoot: string;
  canonicalExecutorRoot: string;
  canonicalLauncher: string;
  validate: () => void;
  dispose: () => void;
};

export function bindInstalledPackageAuthority({
  canonicalPrefix,
  packageName,
  manifest,
}: {
  canonicalPrefix: string;
  packageName: string;
  manifest?: PackedTreeManifest;
}): InstalledPackageAuthority {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) {
    throw new Error("source package name cannot be mapped safely into the isolated npm prefix");
  }
  const packageSegments = packageName.split("/");
  const binDir = path.join(canonicalPrefix, "bin");
  const libDir = path.join(canonicalPrefix, "lib");
  const nodeModulesDir = path.join(libDir, "node_modules");
  const scopeDir = packageSegments.length === 2 ? path.join(nodeModulesDir, packageSegments[0]) : null;
  const canonicalPackageRoot = path.join(nodeModulesDir, ...packageSegments);
  const canonicalExecutorRoot = path.join(canonicalPackageRoot, "dist");
  const launcherPath = path.join(binDir, "cpb");
  const canonicalLauncher = path.join(canonicalPackageRoot, "cpb");
  assertStrictPathDescendant(canonicalPrefix, canonicalPackageRoot, "installed package root");
  if (path.dirname(canonicalExecutorRoot) !== canonicalPackageRoot) {
    throw new Error("installed executor root is not a direct child of the package root");
  }
  assertStrictPathDescendant(canonicalPrefix, binDir, "installed bin directory");

  let expectedLauncherLinkIdentity: RuntimePathIdentity | null = null;
  const boundNodes: Array<{
    descriptor: number;
    path: string;
    kind: "directory" | "file";
    identity: RuntimePathIdentity;
  }> = [];

  const assertLayout = () => {
    for (const directory of [binDir, libDir, nodeModulesDir, scopeDir, canonicalPackageRoot, canonicalExecutorRoot]) {
      if (directory) assertOwnedRuntimeNode(directory, "directory");
    }
    assertOwnedRuntimeNode(canonicalLauncher, "file");
    const launcherDetails = lstatSync(launcherPath, { bigint: true });
    if (
      !launcherDetails.isSymbolicLink()
      || realpathSync(launcherPath) !== canonicalLauncher
      || (expectedLauncherLinkIdentity
        && !sameRuntimePathIdentity(runtimePathIdentity(launcherDetails), expectedLauncherLinkIdentity))
    ) {
      throw new Error("installed cpb launcher link escaped or changed identity");
    }
    for (const node of boundNodes) {
      const descriptorDetails = fstatSync(node.descriptor, { bigint: true });
      const pathDetails = assertOwnedRuntimeNode(node.path, node.kind, node.identity);
      if (
        !sameRuntimePathIdentity(runtimePathIdentity(descriptorDetails), node.identity)
        || !sameRuntimePathIdentity(runtimePathIdentity(descriptorDetails), runtimePathIdentity(pathDetails))
      ) {
        throw new Error(`installed ${node.kind} descriptor identity changed: ${node.path}`);
      }
    }
    if (manifest) assertInstalledTreeMatchesManifest(canonicalPackageRoot, manifest);
  };

  const closeBoundNodes = () => {
    const closeErrors: unknown[] = [];
    for (const node of boundNodes.splice(0).reverse()) {
      try {
        closeSync(node.descriptor);
      } catch (error) {
        closeErrors.push(error);
      }
    }
    if (closeErrors.length === 1) throw closeErrors[0];
    if (closeErrors.length > 1) {
      throw new AggregateError(closeErrors, "installed package authority descriptors failed to close");
    }
  };

  try {
    assertLayout();
    expectedLauncherLinkIdentity = runtimePathIdentity(lstatSync(launcherPath, { bigint: true }));
    const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_DIRECTORY || 0);
    for (const [nodePath, kind] of [
      [canonicalPackageRoot, "directory"],
      [canonicalExecutorRoot, "directory"],
      [canonicalLauncher, "file"],
    ] as const) {
      const descriptor = openSync(
        nodePath,
        kind === "directory" ? directoryFlags : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const details = fstatSync(descriptor, { bigint: true });
      boundNodes.push({ descriptor, path: nodePath, kind, identity: runtimePathIdentity(details) });
    }
    assertLayout();
  } catch (primaryError) {
    try {
      closeBoundNodes();
    } catch (closeError) {
      throw new AggregateError(
        [primaryError, closeError],
        "installed package authority binding failed and descriptors also failed to close",
      );
    }
    throw primaryError;
  }

  const validate = () => {
    if (boundNodes.length !== 3) throw new Error("installed package authority is already closed");
    assertLayout();
  };
  const dispose = () => {
    if (boundNodes.length === 0) return;
    let validationError: unknown = null;
    try {
      validate();
    } catch (error) {
      validationError = error;
    }
    let closeError: unknown = null;
    try {
      closeBoundNodes();
    } catch (error) {
      closeError = error;
    }
    if (validationError && closeError) {
      throw new AggregateError(
        [validationError, closeError],
        "installed package authority validation and close both failed",
      );
    }
    if (validationError) throw validationError;
    if (closeError) throw closeError;
  };
  return {
    binDir,
    canonicalPackageRoot,
    canonicalExecutorRoot,
    canonicalLauncher,
    validate,
    dispose,
  };
}

function stepPack(packDir: string): E2ePackInstallation {
  const canonicalPackDir = realpathSync(packDir);
  if (path.resolve(packDir) !== canonicalPackDir) {
    throw new Error("owned pack directory must be canonical before isolated installation");
  }
  const packDirDetails = lstatSync(canonicalPackDir, { bigint: true });
  if (
    !packDirDetails.isDirectory()
    || packDirDetails.isSymbolicLink()
    || (typeof process.getuid === "function" && packDirDetails.uid !== BigInt(process.getuid()))
    || (packDirDetails.mode & 0o077n) !== 0n
  ) {
    throw new Error("owned pack directory is not an owner-private real directory");
  }
  const npmExecution = createTrustedNpmExecution(canonicalPackDir);
  let prefixAuthority: BoundInstallPrefixAuthority | null = null;
  let installedAuthority: InstalledPackageAuthority | null = null;

  const validateInstallation = () => {
    npmExecution.validate();
    prefixAuthority?.validate();
    installedAuthority?.validate();
  };

  const disposeInstallation = () => {
    const disposalErrors: unknown[] = [];
    try {
      installedAuthority?.dispose();
    } catch (error) {
      disposalErrors.push(error);
    } finally {
      installedAuthority = null;
    }
    if (prefixAuthority) {
      try {
        prefixAuthority.dispose();
      } catch (error) {
        disposalErrors.push(error);
      } finally {
        prefixAuthority = null;
      }
    }
    try {
      npmExecution.dispose();
    } catch (error) {
      disposalErrors.push(error);
    }
    if (disposalErrors.length === 1) throw disposalErrors[0];
    if (disposalErrors.length > 1) {
      throw new AggregateError(disposalErrors, "installed package and npm prefix authorities both failed disposal");
    }
  };

  try {
    log("PACK", `Building with ${npmExecution.runtime.canonicalNode} and npm ${npmExecution.runtime.npmVersion}...`);
    npmExecution.runNode([path.join(ROOT, "scripts", "build-output.mjs"), "node"], {
      cwd: ROOT,
      timeout: 120_000,
    });
    const packageMeta = recordValue(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")));
    const packageLock = recordValue(JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8")));
    const expectedName = String(packageMeta.name || "").trim();
    const expectedVersion = String(packageMeta.version || "").trim();
    if (!expectedName || !expectedVersion) throw new Error("source package identity is missing");

    const packResult = npmExecution.run([
      "pack",
      ROOT,
      "--json",
      `--pack-destination=${canonicalPackDir}`,
    ], { timeout: 120_000, silent: true });
    const packEntry = parseSingleNpmPackResult(packResult, expectedName, expectedVersion);
    const packedExecutorPaths = assertPackedExecutorFiles(packEntry);
    pass(`Pack contains the root launcher and ${packedExecutorPaths.length - 1} required executor files`);
    const tgzPath = resolvePackedTarballPath(canonicalPackDir, packEntry.filename);
    const tarballProof = assertPackedTarballIntegrity(tgzPath, packEntry);
    assertPackMetadataMatchesManifest(packEntry, tarballProof.manifest);
    const closure = assertBundledProductionClosure({
      tarballPath: tgzPath,
      proof: tarballProof,
      sourcePackage: packageMeta,
      packageLock,
    });
    verifyBundledRegistryProvenance({
      npmExecution,
      bundledManifest: tarballProof.manifest,
      closure,
    });

    const installPrefix = path.join(canonicalPackDir, "install-prefix");
    mkdirSync(installPrefix, { mode: 0o700 });
    const canonicalPrefix = realpathSync(installPrefix);
    prefixAuthority = bindInstallPrefixAuthority(canonicalPackDir, canonicalPrefix);
    validateInstallation();
    log("INSTALL", "Installing the fully bundled tarball offline into an isolated global prefix...");
    npmExecution.run([
      "install",
      "--global",
      `--prefix=${canonicalPrefix}`,
      "--offline=true",
      "--package-lock=false",
      tgzPath,
    ], { timeout: 120_000 });
    validateInstallation();
    assertPackedTarballIntegrity(tgzPath, packEntry, tarballProof);

    installedAuthority = bindInstalledPackageAuthority({
      canonicalPrefix,
      packageName: expectedName,
      manifest: tarballProof.manifest,
    });
    const {
      binDir,
      canonicalPackageRoot,
      canonicalExecutorRoot,
      canonicalLauncher,
    } = installedAuthority;
    validateInstallation();
    verifyPostInstallRepack({
      npmExecution,
      installedPackageRoot: canonicalPackageRoot,
      expectedName,
      expectedVersion,
      expectedProof: tarballProof,
      canonicalPackDir,
    });
    validateInstallation();

    const executeCpb = (cpbArgs: readonly string[], options: ShellRunOptions = {}) => {
      validateInstallation();
      const result = runFile(npmExecution.runtime.canonicalNode, [canonicalLauncher, ...cpbArgs], {
        ...options,
        env: sanitizeE2eChildEnvironment(process.env, {
          npm: true,
          pathValue: npmExecution.runtimePath,
        }),
        exactEnv: true,
      });
      validateInstallation();
      return result;
    };

    return {
      binDir,
      runtimePath: npmExecution.runtimePath,
      runCpb: executeCpb,
      verify() {
        validateInstallation();
        const installedVersion = executeCpb(["--version"], { cwd: ROOT, silent: true }).stdout;
        const expectedVersionOutput = `cpb v${expectedVersion}`;
        if (installedVersion !== expectedVersionOutput) {
          throw new Error(`isolated cpb version mismatch: expected ${expectedVersionOutput}, got ${installedVersion || "missing"}`);
        }
        const versionJson = parseJsonObject(
          executeCpb(["version", "--json"], { cwd: ROOT, silent: true }).stdout,
          "isolated cpb version metadata",
        );
        if (
          versionJson.codeVersion !== expectedVersion
          || versionJson.runtimeBackend !== "node"
          || versionJson.CPB_ROOT !== canonicalPackageRoot
          || versionJson.CPB_EXECUTOR_ROOT !== canonicalExecutorRoot
        ) {
          throw new Error("isolated cpb runtime roots do not match the packed installation");
        }
        validateInstallation();
        pass(`Packed and installed ${installedVersion} in an isolated global prefix`);
      },
      validateRuntime: validateInstallation,
      dispose: disposeInstallation,
    };
  } catch (primaryError) {
    try {
      disposeInstallation();
    } catch (disposeError) {
      throw new AggregateError(
        [primaryError, disposeError],
        "isolated npm installation failed and authority disposal also failed",
      );
    }
    throw primaryError;
  }
}

// ─── Step 4: Doctor ────────────────────────────────────────────────
function stepDoctor() {
  log("DOCTOR", "Running health check...");
  const r = runInstalledCpb(["doctor", "--json"], { silent: true, allowFail: true });
  const summary = assertDoctorHealth({ ok: r.ok, stdout: r.stdout });
  log("DOCTOR", `ok: ${summary.ok || 0}, warn: ${summary.warn || 0}, error: ${summary.error || 0}`);
  pass("Doctor passed with zero errors");
}

// ─── Step 5: Ensure project registered ─────────────────────────────
function stepProject() {
  log("PROJECT", `Ensuring project '${PROJECT}' is registered...`);
  runInstalledCpb(["init", ROOT, PROJECT], { silent: true });
  pass("Project registered");
}

// ─── Step 5.5: Bind GitHub + configure automation ──────────────────
function stepGithub(safety: E2eNpmPackSafety) {
  log("GITHUB", `Binding repo ${safety.repository} to project '${PROJECT}'...`);
  runInstalledCpb(["github", "bind", PROJECT, safety.repository], { silent: true });

  log("GITHUB", `Configuring automation (label: ${AUTOMATION_LABEL})...`);
  runInstalledCpb(["config", PROJECT, "--automation-enabled", "true"], { silent: true });
  runInstalledCpb(["config", PROJECT, "--automation-clear-rules"], { silent: true });
  const rule = `match.labels=${AUTOMATION_LABEL};action.workflow=standard;action.priority=P2`;
  runInstalledCpb(["config", PROJECT, "--automation-rule", rule], { silent: true });

  const route = configureAgentRoute();
  const agents = runInstalledCpb(["config", PROJECT, "--agents"], { silent: true });
  const missing = route.expected.filter((needle) => !agents.stdout.includes(needle));
  if (missing.length > 0) {
    const message = `Project agent route '${route.description}' was not applied; missing ${missing.join(", ")}`;
    fail(message);
    if (agents.stdout) log("GITHUB", agents.stdout);
    throw new Error(message);
  }
  pass("GitHub bound and automation configured");
}

function stepDisableAutomation() {
  log("GITHUB", "Disabling issue automation before Hub startup...");
  runInstalledCpb(["config", PROJECT, "--automation-enabled", "false"], { silent: true });
  pass("Issue automation disabled before Hub startup");
}

// ─── Step 6: Start hub ─────────────────────────────────────────────
async function stepHub() {
  log("HUB", "Starting hub...");
  hubStartAttempted = true;
  runInstalledCpb(["hub", "start"], { timeout: 30_000 });
  await wait(3000);

  const r = runInstalledCpb(["hub", "status"], { silent: true, allowFail: true });
  if (!r.ok || !r.stdout.includes("alive")) {
    throw new Error("Hub not alive after start");
  }
  pass("Hub started and alive");
}

function stopStartedHub() {
  if (!hubStartAttempted) return;
  log("TEARDOWN", "Stopping services...");
  const stopped = runInstalledCpb(["hub", "stop"], { silent: true, allowFail: true });
  if (!stopped.ok) {
    throw new Error(`Hub teardown failed${stopped.stderr ? `: ${stopped.stderr.substring(0, 300)}` : ""}`);
  }
  hubStartAttempted = false;
  pass("Hub stopped");
}

// ─── Step 7: Sync and enqueue GitHub issues ────────────────────────
function stepEnqueue(safety: E2eNpmPackSafety) {
  log("ENQUEUE", `Syncing + enqueueing only ${safety.repository}#${safety.issueNumber}...`);
  assertRemoteAuthorityStillCurrent(safety);

  const encodedCapability = encodeGithubRemoteCapability(safety.remoteCapability);
  const exactArgs = [
    "hub",
    "enqueue-issues",
    PROJECT,
    "--issue",
    safety.issueNumber,
    "--github-write-capability",
    encodedCapability,
    "--sync-first",
    "--json",
  ];
  const dry = runInstalledCpb([...exactArgs, "--dry-run"], { silent: true, allowFail: true });
  if (!dry.ok) {
    throw new Error(`exact issue dry-run failed${dry.stderr ? `: ${dry.stderr.substring(0, 300)}` : ""}`);
  }
  const dryResult = parseJsonObject(dry.stdout, "exact issue dry-run result");
  const matched = Array.isArray(dryResult.matched) ? dryResult.matched.map(recordValue) : [];
  if (
    Number(dryResult.enqueued) !== 1
    || Number(dryResult.total) !== 1
    || matched.length !== 1
    || String(matched[0].number || "") !== safety.issueNumber
  ) {
    throw new Error(`dry-run did not select exactly authorized issue #${safety.issueNumber}`);
  }
  log("ENQUEUE", `Dry run selected only issue #${safety.issueNumber}`);

  assertRemoteAuthorityStillCurrent(safety);
  const enq = runInstalledCpb(exactArgs, { silent: true, allowFail: true });
  if (!enq.ok) {
    throw new Error(`exact issue enqueue failed${enq.stderr ? `: ${enq.stderr.substring(0, 300)}` : ""}`);
  }
  const enqueueResult = parseJsonObject(enq.stdout, "exact issue enqueue result");
  if (
    Number(enqueueResult.total) !== 1
    || Number(enqueueResult.enqueued || 0) + Number(enqueueResult.duplicates || 0) !== 1
  ) {
    throw new Error(`enqueue did not bind exactly authorized issue #${safety.issueNumber}`);
  }
  const entry = latestGithubQueueEntry();
  if (!entry) throw new Error(`no queue entry found for authorized issue #${safety.issueNumber}`);
  pass(`Target issue #${safety.issueNumber} queued as ${entry.id}`);
  return true;
}

// ─── Step 8: Confirm Hub scheduling ────────────────────────────────
async function stepWorker() {
  log("WORKER", "Hub Orchestrator manages workers; no daemon startup required.");
  await wait(2000);

  const r = runInstalledCpb(["hub", "status"], { silent: true });
  if (r.ok) {
    pass("Hub is running and will schedule managed workers from queue entries");
    return;
  }
  throw new Error("Hub status check failed before managed-worker scheduling");
}

function readQueue() {
  const file = path.join(HUB_ROOT, "queue", "queue.json");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function latestGithubQueueEntry() {
  return [...(readQueue().entries || [])]
    .filter((entry) => entry.projectId === PROJECT && (entry.type === "github_issue" || entry.metadata?.source === "github"))
    .filter((entry) => !TARGET_ISSUE_NUMBER || String(entry.metadata?.issueNumber || "") === TARGET_ISSUE_NUMBER)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
}

function remoteFinalizerComplete(entry: LooseRecord) {
  const finalizer = recordValue(recordValue(entry.metadata).finalizer);
  return Boolean(
    finalizer?.ok === true
    && finalizer.status === "finalized"
    && finalizer.mode === FINALIZER_MODE
    && finalizer.pushed === true
    && finalizer.closed === true
    && finalizer.commit
  );
}

// ─── Step 9: Monitor pipeline ──────────────────────────────────────
async function stepMonitor() {
  const maxMinutes = Math.round(MONITOR_TIMEOUT_MS / 60_000);
  log("MONITOR", `Waiting for pipeline + remote finalizer to complete (max ${maxMinutes}min)...`);

  const deadline = Date.now() + MONITOR_TIMEOUT_MS;
  let lastStatus = "";
  let lastQueueStatus = "";

  while (Date.now() < deadline) {
    const entry = latestGithubQueueEntry();
    if (entry) {
      const finalizer = entry.metadata?.finalizer;
      const queueStatus = `${entry.id}:${entry.status}:${finalizer?.status || "no-finalizer"}:${finalizer?.commit || ""}`;
      if (queueStatus !== lastQueueStatus) {
        lastQueueStatus = queueStatus;
        log("MONITOR", `Queue ${entry.id}: ${entry.status}${finalizer ? ` finalizer=${finalizer.status} pushed=${finalizer.pushed} closed=${finalizer.closed}` : ""}`);
      }

      if (entry.status === "completed") {
        if (remoteFinalizerComplete(entry)) {
          pass(`Pipeline completed, pushed ${entry.metadata.finalizer.commit}, merged, and closed issue`);
          return await printSummary() ? "completed" : "failed";
        }
        fail(`Queue completed without remote finalizer success: ${JSON.stringify(finalizer || null)}`);
        await printSummary();
        return "failed";
      }
      if (entry.status === "failed" || entry.status === "cancelled") {
        fail(`Queue ${entry.status}`);
        await printSummary();
        return entry.status;
      }
    }

    const r = runInstalledCpb(["status", PROJECT], { silent: true, allowFail: true });
    const status = r.stdout || "";

    if (status !== lastStatus) {
      lastStatus = status;
      const lines = status.split("\n").filter((l: string) => l.trim());
      for (const line of lines) {
        if (line.includes("Latest job")) {
          log("MONITOR", line.replace(/\x1b\[[0-9;]*m/g, "").trim());
        }
      }
    }

    if (status.includes("failed")) {
      fail("Pipeline failed");
      await printSummary();
      return "failed";
    }
    if (status.includes("blocked")) {
      fail("Pipeline blocked");
      await printSummary();
      return "blocked";
    }

    // Also check queue status for failures (cpb status may not reflect queue state)
    const q = runInstalledCpb(["hub", "queue-status"], { silent: true, allowFail: true });
    if (q.ok && q.stdout.includes("failed:") && !q.stdout.includes("failed:0")) {
      fail("Queue reports failed entry");
      log("MONITOR", q.stdout.replace(/\x1b\[[0-9;]*m/g, "").trim());
      await printSummary();
      return "failed";
    }

    await wait(10000);
  }

  fail(`Pipeline still running after ${maxMinutes} minutes (services left running)`);
  await printSummary();
  return "timeout";
}

// ─── Summary ───────────────────────────────────────────────────────
async function printSummary() {
  console.log("");
  log("SUMMARY", `${BOLD}E2E Test Results${RESET}`);

  // Check latest job
  const r = runInstalledCpb(["status", PROJECT], { silent: true, allowFail: true });
  if (r.ok) console.log(r.stdout);

  // Check queue status
  const q = runInstalledCpb(["hub", "queue-status"], { silent: true, allowFail: true });
  if (q.ok) console.log(q.stdout);

  // Check latest session for CodeGraph usage when Codex participates in the route.
  if (AGENT_MODE === "claude" || AGENT_MODE === "cc") {
    log("MCP", "Pure Claude Code mode; skipping Codex MCP usage check.");
    return true;
  }

  log("MCP", "Checking if Codex used CodeGraph tools...");
  try {
    const sessionDir = path.join(homedir(), ".codex", "sessions");
    let latestSession = null;
    let latestTime = 0;
    const today = new Date();
    const datePath = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}`;
    const dayDir = path.join(sessionDir, datePath);
    if (existsSync(dayDir)) {
      for (const f of readdirSync(dayDir)) {
        if (!f.endsWith(".jsonl")) continue;
        const st = statSync(path.join(dayDir, f));
        if (st.mtimeMs > latestTime) {
          latestTime = st.mtimeMs;
          latestSession = path.join(dayDir, f);
        }
      }
    }
    if (latestSession) {
      const content = readFileSync(latestSession, "utf8");
      const mcpCalls = (content.match(/mcp__codegraph__|mcp_servers\.codegraph|"name":"codegraph"/g) || []).length;
      const execCalls = (content.match(/"name":"exec_command"/g) || []).length;
      if (mcpCalls > 0) {
        pass(`Codex used CodeGraph ${mcpCalls} time(s), exec_command ${execCalls} time(s)`);
        return true;
      } else {
        fail(`Codex did NOT use CodeGraph (exec_command: ${execCalls})`);
        return false;
      }
    } else {
      fail("No recent Codex session found");
      return false;
    }
  } catch (e) {
    fail(`Could not check MCP usage: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function redactE2eErrorText(value: unknown) {
  let text = String(value || "");
  for (const [key, secret] of Object.entries(process.env)) {
    if (
      secret
      && secret.length >= 8
      && /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTHORIZATION|CREDENTIAL)/i.test(key)
    ) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  return text
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]+\b/g, "[REDACTED]");
}

function e2eErrorEvidence(error: unknown, seen: WeakSet<object>, depth: number): LooseRecord {
  if (depth > 8) return { name: "ErrorDepthExceeded", message: "nested error evidence exceeded depth bound" };
  if (!error || typeof error !== "object") {
    return { name: "NonError", message: redactE2eErrorText(error) };
  }
  if (seen.has(error)) return { name: "CircularError", message: "circular error reference omitted" };
  seen.add(error);

  const candidate = error as Error & { code?: unknown; cause?: unknown; errors?: unknown };
  const evidence: LooseRecord = {
    name: redactE2eErrorText(candidate.name || "Error"),
    message: redactE2eErrorText(candidate.message || String(error)),
  };
  if (candidate.code !== undefined) evidence.code = redactE2eErrorText(candidate.code);
  const recovery = temporaryWorkspaceErrorDetails(error);
  if (recovery) evidence.recovery = recovery;
  if (error instanceof AggregateError) {
    evidence.errors = Array.from(error.errors, (child) => e2eErrorEvidence(child, seen, depth + 1));
  }
  if (candidate.cause !== undefined) {
    evidence.cause = e2eErrorEvidence(candidate.cause, seen, depth + 1);
  }
  return evidence;
}

export function formatE2eError(error: unknown) {
  return JSON.stringify(e2eErrorEvidence(error, new WeakSet<object>(), 0), null, 2);
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const safety = assertE2eNpmPackSafety({
    env: process.env,
    root: ROOT,
    project: PROJECT,
    keepState: KEEP_STATE,
    agentMode: AGENT_MODE,
    finalizerMode: FINALIZER_MODE,
    phaseTimeoutMs: ACP_PHASE_TIMEOUT_MS,
    monitorTimeoutMs: MONITOR_TIMEOUT_MS,
  });
  HUB_ROOT = safety.hubRoot;
  process.env.CPB_HUB_ROOT = safety.hubRoot;
  activeSafety = safety;
  if (safety.issueNumber !== TARGET_ISSUE_NUMBER) {
    throw new Error("E2E safety context changed after preflight");
  }
  console.log(`${BOLD}═══════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  CPB E2E Test: npm pack → pipeline${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════${RESET}`);
  console.log(`  Project: ${PROJECT}`);
  console.log(`  Root:    ${ROOT}`);
  console.log(`  Hub:     ${HUB_ROOT}`);
  console.log(`  Label:   ${AUTOMATION_LABEL}`);
  console.log(`  Agent:   ${AGENT_MODE}`);
  console.log(`  Target:  ${safety.repository} (${safety.repositoryId})`);
  console.log(`  Marker:  ${safety.markerSha}`);
  if (TARGET_ISSUE_NUMBER) console.log(`  Issue:   #${TARGET_ISSUE_NUMBER}`);
  console.log(`${BOLD}═══════════════════════════════════════════${RESET}\n`);

  const t0 = Date.now();

  const result = await withIsolatedPackInstallation(async () => (
    withGuaranteedHubTeardown(async () => {
      stepStop();
      stepClean();
      stepDoctor();
      stepProject();
      stepGithub(safety);
      await enqueueExactIssueBeforeHubStart({
        enqueueExactIssue: () => stepEnqueue(safety),
        disableAutomation: stepDisableAutomation,
        startHub: stepHub,
      });
      await stepWorker();
      return stepMonitor();
    }, stopStartedHub)
  ));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n${BOLD}Total time: ${elapsed}s${RESET}`);

  process.exitCode = e2eResultExitCode(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    fail("Unhandled E2E failure");
    console.error(formatE2eError(e));
    process.exitCode = 1;
  });
}
