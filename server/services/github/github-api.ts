// Merged from: github-api.ts, github-app.ts

import { createSign, createHmac, timingSafeEqual } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, chmod, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { LooseRecord } from "../../../shared/types.js";
import { redactSecrets } from "../secret-policy.js";
import {
  assertGithubRemoteWriteAuthorized,
  verifyGithubRemoteWriteCommitted,
  type GithubRemoteAuthorityRequest,
  type GithubRemoteAuthorityValidator,
  type GithubRemoteCommitVerifier,
  type GithubRemoteRunCommand,
  type GithubTransportPrincipal,
} from "./github-remote-capability.js";

const execFileAsync = promisify(execFileCb);

// ============================================================
// github-app.ts exports
// ============================================================

const SCHEMA_VERSION = 1;
const PERMISSION_LEVELS = new Set(["read", "write"]);

export const DEFAULT_GITHUB_APP_PERMISSIONS = {
  metadata: "read",
  issues: "write",
  contents: "write",
  pullRequests: "write",
  checks: "write",
  commitStatuses: "write",
};

function nowIso() {
  return new Date().toISOString();
}

function recordValue(value: unknown): LooseRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as LooseRecord : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

export function githubAppConfigPath(hubRoot: string) {
  return path.join(path.resolve(hubRoot), "github", "app.json");
}

function normalizeId(value: unknown, field: string, errors: string[], { required = true }: LooseRecord = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) errors.push(`${field} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!/^[1-9][0-9]*$/.test(text)) {
    errors.push(`${field} must be a positive integer`);
    return null;
  }
  return text;
}

function normalizeWebhookSecretRef(value: unknown, errors: string[]) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push("webhookSecretRef is required");
    return null;
  }
  const ref = value.trim();
  if (!/^(env|keychain|credential-manager|libsecret|vault):[A-Za-z0-9_.:/@-]+$/.test(ref)) {
    errors.push("webhookSecretRef must use a supported secret reference prefix");
    return null;
  }
  return ref;
}

function normalizePrivateKeyRef(value: unknown, errors: string[]) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    errors.push("privateKeyRef must be a string");
    return null;
  }
  const ref = value.trim();
  if (!/^(env|file):.+$/.test(ref)) {
    errors.push("privateKeyRef must use env: or file: prefix");
    return null;
  }
  return ref;
}

function normalizePermissions(value: unknown, errors: string[]) {
  const permissions: Record<string, string> = {
    ...DEFAULT_GITHUB_APP_PERMISSIONS,
    ...(value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(
      Object.entries(value).map(([key, level]) => [key, String(level)]),
    ) : {}),
  };

  for (const [key, level] of Object.entries(permissions)) {
    if (!PERMISSION_LEVELS.has(level)) {
      errors.push(`permissions.${key} must be read or write`);
    }
  }
  return permissions;
}

export function validateGithubAppConfig(raw: LooseRecord = {}) {
  const input = raw;
  const errors: string[] = [];
  const appId = normalizeId(input.appId, "appId", errors);
  const installationId = normalizeId(input.installationId, "installationId", errors, { required: false });
  const webhookSecretRef = normalizeWebhookSecretRef(input.webhookSecretRef, errors);
  const privateKeyRef = normalizePrivateKeyRef(input.privateKeyRef, errors);
  const permissions = normalizePermissions(input.permissions, errors);

  const config = {
    schemaVersion: SCHEMA_VERSION,
    appId,
    installationId,
    webhookSecretRef,
    privateKeyRef,
    permissions,
    updatedAt: input.updatedAt || null,
  };

  return {
    valid: errors.length === 0,
    errors,
    config: errors.length === 0 ? config : null,
  };
}

export function redactGithubAppConfig(config: LooseRecord | null) {
  if (!config) return null;
  const { webhookSecret, privateKey, privateKeyPem, ...safe } = config;
  return redactSecrets(safe);
}

async function writeAtomic(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

export async function saveGithubAppConfig(hubRoot: string, raw: LooseRecord = {}) {
  const validation = validateGithubAppConfig(raw);
  if (!validation.valid) {
    throw new Error(`invalid GitHub App config: ${validation.errors.join("; ")}`);
  }
  const config = redactGithubAppConfig({
    ...validation.config,
    updatedAt: nowIso(),
  });
  await writeAtomic(githubAppConfigPath(hubRoot), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export async function loadGithubAppConfig(hubRoot: string) {
  let raw;
  try {
    raw = JSON.parse(await readFile(githubAppConfigPath(hubRoot), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const validation = validateGithubAppConfig(raw);
  if (!validation.valid) {
    throw new Error(`invalid GitHub App config: ${validation.errors.join("; ")}`);
  }
  return redactGithubAppConfig({
    ...validation.config,
    updatedAt: raw.updatedAt || null,
  });
}

export function buildGithubAppReadiness(config: LooseRecord | null) {
  if (!config) {
    return [{
      id: "github-app-config",
      category: "github",
      status: "warn",
      severity: "important",
      message: "GitHub App config missing",
      recommendedAction: "Run: cpb github connect",
    }];
  }

  return [
    {
      id: "github-app-config",
      category: "github",
      status: "ok",
      severity: "info",
      message: `GitHub App ${config.appId} configured`,
      recommendedAction: null,
    },
    {
      id: "github-app-installation",
      category: "github",
      status: config.installationId ? "ok" : "warn",
      severity: config.installationId ? "info" : "important",
      message: config.installationId
        ? `GitHub App installation ${config.installationId} configured`
        : "GitHub App installation id missing",
      recommendedAction: config.installationId ? null : "Run: cpb github connect --installation-id <id>",
    },
    {
      id: "github-app-private-key",
      category: "github",
      status: config.privateKeyRef ? "ok" : "warn",
      severity: config.privateKeyRef ? "info" : "important",
      message: config.privateKeyRef
        ? `Private key configured (${String(config.privateKeyRef).split(":")[0]}:*)`
        : "No private key — outbound transport will use gh CLI",
      recommendedAction: config.privateKeyRef ? null : "Run: cpb github connect --private-key-ref env:CPB_GITHUB_PRIVATE_KEY",
    },
  ];
}

export function resolveSecretRef(secretRef: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}) {
  if (typeof secretRef !== "string" || secretRef.trim() === "") {
    throw new Error("secret reference is required");
  }
  if (secretRef.startsWith("env:")) {
    const name = secretRef.slice("env:".length);
    const value = env[name];
    if (!value) throw new Error(`secret reference not available: env:${name}`);
    return value;
  }
  throw new Error(`unsupported secret reference: ${secretRef.split(":")[0] || "unknown"}`);
}

export function resolveGithubWebhookSecret(config: LooseRecord | null, options: { env?: NodeJS.ProcessEnv } = {}) {
  if (!config?.webhookSecretRef) {
    throw new Error("GitHub webhook secret reference missing");
  }
  return resolveSecretRef(String(config.webhookSecretRef), options);
}

export function verifyGithubWebhookSignature({ signature, rawBody, secret }: LooseRecord) {
  if (typeof signature !== "string" || !signature.startsWith("sha256=")) return false;
  if (!secret || !rawBody) return false;

  const providedHex = signature.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expectedHex = createHmac("sha256", String(secret)).update(body).digest("hex");
  const provided = Buffer.from(providedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// ============================================================
// github-api.ts exports (original)
// ============================================================

const GITHUB_API = "https://api.github.com";
const TOKEN_TTL_S = 600; // JWT valid for 10 minutes
const TOKEN_CACHE_S = 3300; // Cache installation token ~55 min

// --- Private key resolution ---

export function resolvePrivateKey(config: LooseRecord | null | undefined, { env = process.env }: LooseRecord = {}) {
  if (!config?.privateKeyRef) return null;
  const ref = String(config.privateKeyRef);

  if (ref.startsWith("env:")) {
    const name = ref.slice("env:".length);
    const value = recordValue(env)[name];
    if (!value) throw new Error(`private key not found: env:${name}`);
    // env var may contain literal \n that need unescaping
    return String(value).replace(/\\n/g, "\n");
  }

  if (ref.startsWith("file:")) {
    const filePath = ref.slice("file:".length);
    try {
      return readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(`private key file not readable: ${filePath}: ${error.message}`);
    }
  }

  throw new Error(`unsupported private key reference: ${ref.split(":")[0]}`);
}

// --- JWT generation ---

function base64url(buf: Buffer) {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createAppJwt(appId: string, privateKeyPem: string) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8"));
  const payload = base64url(Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + TOKEN_TTL_S,
    iss: appId,
  }), "utf8"));

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(privateKeyPem, "base64");

  return `${header}.${payload}.${base64url(Buffer.from(sig, "base64"))}`;
}

// --- Installation token ---

type InstallationTokenCacheEntry = { token: string; expiresAt: number };

const tokenCache = new Map<string, InstallationTokenCacheEntry>();

function installationTokenCacheKey(config: LooseRecord) {
  return [config.appId, config.installationId, config.privateKeyRef].map((value) => String(value || "")).join(":");
}

async function fetchJson(url: string, options: LooseRecord = {}) {
  // retain: dynamic fetch boundary — LooseRecord (LooseRecord) is not structurally assignable to RequestInit, cast required to spread into fetch()
  const requestOptions = options as RequestInit & { headers?: Record<string, string> };
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "codepatchbay",
    ...requestOptions.headers,
  };
  const res = await fetch(url, { ...requestOptions, headers });
  const body = recordValue(await res.json());
  if (!res.ok) {
    const error: Error & { status?: number; body?: unknown } = new Error(stringValue(body.message, `GitHub API ${res.status}`));
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

export async function getInstallationToken(config: LooseRecord, { env = process.env, forceRefresh = false }: LooseRecord = {}) {
  const cacheKey = installationTokenCacheKey(config);
  const cached = tokenCache.get(cacheKey);
  if (!forceRefresh && cached?.token && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const privateKey = resolvePrivateKey(config, { env });
  if (!privateKey) throw new Error("GitHub App private key not configured");
  if (!config.installationId) throw new Error("GitHub App installation ID not configured");

  const jwt = createAppJwt(String(config.appId), privateKey);
  const body = await fetchJson(`${GITHUB_API}/app/installations/${config.installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  });

  const entry = {
    token: stringValue(body.token),
    expiresAt: (body.expires_at ? new Date(String(body.expires_at)).getTime() : Date.now() + TOKEN_CACHE_S * 1000) - 60000,
  };
  if (!entry.token) throw new Error("GitHub App installation token response was empty");
  tokenCache.set(cacheKey, entry);
  return entry.token;
}

export function clearTokenCache() {
  tokenCache.clear();
}

type InstallationTokenProvider = () => Promise<string>;

function installationTokenProvider(
  config: LooseRecord,
  { env = process.env, getToken }: LooseRecord = {},
): InstallationTokenProvider {
  if (typeof getToken === "function") {
    return async () => requiredCredential(await getToken(), "GitHub App installation token");
  }
  return async () => requiredCredential(await getInstallationToken(config, { env }), "GitHub App installation token");
}

// --- Transport: post issue comment ---

export async function postGithubCommentWithApi({ repo, issueNumber, body }: LooseRecord, config: LooseRecord, options: LooseRecord = {}) {
  const token = await installationTokenProvider(config, options)();
  const result = await fetchJson(`${GITHUB_API}/repos/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body }),
  });
  return {
    url: result.url || null,
    html_url: result.html_url || null,
    id: result.id || null,
  };
}

// --- Transport: create pull request ---

export async function createPullRequestWithApi(request: LooseRecord, config: LooseRecord, options: LooseRecord = {}) {
  const token = await installationTokenProvider(config, options)();
  const result = await fetchJson(`${GITHUB_API}/repos/${request.repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: request.title,
      body: request.body,
      head: request.head,
      base: request.base,
      draft: request.draft ?? false,
    }),
  });
  return {
    url: result.html_url || result.url || null,
    html_url: result.html_url || null,
    number: result.number || null,
  };
}

// --- Transport: close issue ---

export async function closeGithubIssueWithApi({ repo, number, body }: LooseRecord, config: LooseRecord, options: LooseRecord = {}) {
  const token = await installationTokenProvider(config, options)();
  const patch = await fetchJson(`${GITHUB_API}/repos/${repo}/issues/${number}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ state: "closed", body: body || undefined }),
  });
  return {
    url: patch.html_url || patch.url || null,
    html_url: patch.html_url || null,
    number: patch.number || null,
    state: patch.state || null,
  };
}

// --- Composite transport selector (never throws) ---

function makeDiagnostic(level: string, message: string) {
  return { level, message };
}

export type { GithubTransportPrincipal } from "./github-remote-capability.js";

type GithubExecFile = (
  executable: string,
  args: string[],
  options: LooseRecord,
) => Promise<LooseRecord | string>;

type GithubFetchJson = (url: string, options?: LooseRecord) => Promise<unknown>;

type ResolveGithubTransportOptions = {
  env?: unknown;
  execFile?: GithubExecFile;
  ghExecutable?: string;
  ghConfigDir?: string;
  ghHomeDir?: string;
  getInstallationTokenFn?: (config: LooseRecord, options: LooseRecord) => Promise<string>;
  getAppJwtFn?: (config: LooseRecord, options: LooseRecord) => Promise<string> | string;
  fetchJsonFn?: GithubFetchJson;
};

const POSIX_GH_EXECUTABLES = Object.freeze([
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh",
  "/run/current-system/sw/bin/gh",
]);

const WINDOWS_GH_EXECUTABLES = Object.freeze([
  "C:\\Program Files\\GitHub CLI\\gh.exe",
]);

function requiredCredential(value: unknown, label: string) {
  const credential = typeof value === "string" ? value.trim() : "";
  if (credential.length < 8 || credential.length > 4096 || /\s/.test(credential)) {
    throw new Error(`${label} is empty or malformed`);
  }
  return credential;
}

function commandStdout(value: unknown) {
  return typeof value === "string" ? value : String(recordValue(value).stdout || "");
}

function trustedExecutableCandidates(explicit: unknown) {
  if (typeof explicit === "string" && explicit.trim()) return [explicit.trim()];
  return process.platform === "win32" ? [...WINDOWS_GH_EXECUTABLES] : [...POSIX_GH_EXECUTABLES];
}

async function resolveCanonicalGhExecutable(explicit: unknown) {
  for (const candidate of trustedExecutableCandidates(explicit)) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const canonical = await realpath(candidate);
      const metadata = await stat(canonical);
      if (!metadata.isFile()) continue;
      if (process.platform !== "win32") {
        if ((metadata.mode & 0o022) !== 0) continue;
        await access(canonical, fsConstants.X_OK);
      }
      return canonical;
    } catch {
      // Try the next fixed candidate. PATH lookup is intentionally forbidden.
    }
  }
  return null;
}

async function ensurePrivateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await stat(directory);
  if (!metadata.isDirectory()) throw new Error(`GitHub transport path is not a directory: ${directory}`);
  if (typeof process.getuid === "function" && typeof metadata.uid === "number" && metadata.uid !== process.getuid()) {
    throw new Error(`GitHub transport path is owned by another user: ${directory}`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    await chmod(directory, 0o700);
  }
  return directory;
}

async function assertTrustedUserDirectory(directory: string, label: string) {
  const canonical = await realpath(directory);
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new Error(`${label} is not a directory`);
  if (typeof process.getuid === "function" && typeof metadata.uid === "number" && metadata.uid !== process.getuid()) {
    throw new Error(`${label} is owned by another user`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o022) !== 0) {
    throw new Error(`${label} is writable by another user`);
  }
  return canonical;
}

function trustedPathValue(value: unknown, fallback: string, label: string) {
  const selected = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!path.isAbsolute(selected)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(selected);
}

function controlledPath(executable: string) {
  const directories = process.platform === "win32"
    ? [path.dirname(executable), "C:\\Windows\\System32"]
    : [path.dirname(executable), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(directories)].join(path.delimiter);
}

function defaultGhConfigDirectory(homeDir: string) {
  return process.platform === "win32"
    ? path.join(homeDir, "AppData", "Roaming", "GitHub CLI")
    : path.join(homeDir, ".config", "gh");
}

function controlledGhEnvironment({
  executable,
  homeDir,
  configDir,
  token = null,
}: {
  executable: string;
  homeDir: string;
  configDir: string;
  token?: string | null;
}) {
  const environment: NodeJS.ProcessEnv = {
    HOME: homeDir,
    GH_CONFIG_DIR: configDir,
    GH_HOST: "github.com",
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: controlledPath(executable),
  };
  if (token) environment.GH_TOKEN = token;
  return environment;
}

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function controlledGhRunner({
  executable,
  execFile,
  homeDir,
  configDir,
  tokenProvider = null,
}: {
  executable: string;
  execFile: GithubExecFile;
  homeDir: string;
  configDir: string;
  tokenProvider?: InstallationTokenProvider | null;
}): GithubRemoteRunCommand {
  return async (command, args, rawOptions = {}) => {
    if (command !== "gh") throw new Error("controlled GitHub transport only permits the canonical gh executable");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error("controlled GitHub transport requires string arguments");
    }
    const options = recordValue(rawOptions);
    const token = tokenProvider ? await tokenProvider() : null;
    const cwd = typeof options.cwd === "string" && path.isAbsolute(options.cwd)
      ? path.resolve(options.cwd)
      : undefined;
    return execFile(executable, args, {
      ...(cwd ? { cwd } : {}),
      encoding: "utf8",
      env: controlledGhEnvironment({ executable, homeDir, configDir, token }),
      maxBuffer: boundedPositiveInteger(options.maxBuffer, 2 * 1024 * 1024, 20 * 1024 * 1024),
      timeout: boundedPositiveInteger(options.timeout, 30_000, 120_000),
      windowsHide: true,
    });
  };
}

function normalizedGithubActor(value: unknown): GithubTransportPrincipal {
  const actor = recordValue(value);
  const stableId = String(actor.id || "").trim();
  const login = String(actor.login || "").trim().toLowerCase();
  if (!/^[1-9][0-9]*$/.test(stableId) || !login || login.length > 100 || /[\u0000-\u001f\u007f]/.test(login)) {
    throw new Error("authenticated GitHub actor identity is invalid");
  }
  return { kind: "gh_user", stableId, login };
}

async function readBoundGithubActor(runCommand: GithubRemoteRunCommand) {
  const result = await runCommand("gh", ["api", "user"], { maxBuffer: 1024 * 1024, timeout: 15_000 });
  return normalizedGithubActor(commandJsonObject(result, "authenticated actor"));
}

function commandJsonObject(value: unknown, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(commandStdout(value));
  } catch (cause) {
    throw new Error(`gh returned invalid JSON for ${label}`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`gh returned a non-object response for ${label}`);
  }
  return parsed as LooseRecord;
}

function principalBoundValidators(runCommand: GithubRemoteRunCommand, principal: GithubTransportPrincipal) {
  const validatorOptions = { runCommand, principal };
  const remoteAuthorityValidator: GithubRemoteAuthorityValidator = async (request: GithubRemoteAuthorityRequest) => {
    const result = recordValue(await assertGithubRemoteWriteAuthorized(request, validatorOptions));
    return { ...result, principal };
  };
  const remoteCommitVerifier: GithubRemoteCommitVerifier = async (request: GithubRemoteAuthorityRequest) => {
    const result = await verifyGithubRemoteWriteCommitted(request, validatorOptions);
    return {
      ...result,
      principal,
      evidence: { ...recordValue(result.evidence), principal },
    };
  };
  return { remoteAuthorityValidator, remoteCommitVerifier };
}

async function controlledTransportDirectories(hubRoot: string) {
  const root = path.join(path.resolve(hubRoot), "github", ".transport");
  const homeDir = await ensurePrivateDirectory(path.join(root, "home"));
  const configDir = await ensurePrivateDirectory(path.join(root, "gh-config"));
  return { homeDir, configDir };
}

async function resolveGithubAppPrincipal({
  config,
  env,
  installationToken,
  getAppJwt,
  readJson,
}: {
  config: LooseRecord;
  env: NodeJS.ProcessEnv;
  installationToken: InstallationTokenProvider;
  getAppJwt?: ResolveGithubTransportOptions["getAppJwtFn"];
  readJson: GithubFetchJson;
}): Promise<GithubTransportPrincipal> {
  const appJwt: InstallationTokenProvider = typeof getAppJwt === "function"
    ? async () => requiredCredential(await getAppJwt(config, { env }), "GitHub App JWT")
    : async () => {
        const privateKey = resolvePrivateKey(config, { env });
        if (!privateKey) throw new Error("GitHub App private key not configured");
        return requiredCredential(createAppJwt(String(config.appId), privateKey), "GitHub App JWT");
      };
  const jwt = await appJwt();
  const app = recordValue(await readJson(`${GITHUB_API}/app`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}` },
  }));
  const appId = String(app.id || "").trim();
  const slug = String(app.slug || "").trim().toLowerCase();
  if (appId !== String(config.appId) || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    throw new Error("authenticated GitHub App identity does not match the configured app");
  }

  const expectedLogin = `${slug}[bot]`;
  const token = await installationToken();
  const installation = recordValue(await readJson(`${GITHUB_API}/installation`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }));
  if (
    String(installation.id || "") !== String(config.installationId)
    || String(installation.app_id || "") !== String(config.appId)
    || String(installation.app_slug || "").toLowerCase() !== slug
  ) {
    throw new Error("GitHub App installation token identity does not match the configured installation");
  }
  const bot = recordValue(await readJson(`${GITHUB_API}/users/${encodeURIComponent(expectedLogin)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }));
  const actualLogin = String(bot.login || "").trim().toLowerCase();
  const authorId = String(bot.id || "").trim();
  if (actualLogin !== expectedLogin || !/^[1-9][0-9]*$/.test(authorId) || String(bot.type || "") !== "Bot") {
    throw new Error("GitHub App bot identity is invalid or does not match the authenticated app");
  }
  return {
    kind: "github_app",
    stableId: String(config.installationId),
    login: actualLogin,
    authorId,
  };
}

export async function resolveGithubTransport(
  hubRoot: string,
  options: ResolveGithubTransportOptions = {},
): Promise<LooseRecord> {
  const env = options.env !== null && typeof options.env === "object" && !Array.isArray(options.env)
    ? options.env as NodeJS.ProcessEnv
    : process.env;
  const execute = options.execFile || (execFileAsync as unknown as GithubExecFile);
  const diagnostics: LooseRecord[] = [];
  let config: LooseRecord | null = null;

  // Load config
  try {
    const loaded = await loadGithubAppConfig(hubRoot);
    config = loaded ? recordValue(loaded) : null;
  } catch (error) {
    diagnostics.push(makeDiagnostic("error", `Failed to load GitHub App config: ${recordValue(error).message || error}`));
  }

  if (!config) {
    diagnostics.push(makeDiagnostic("warn", "GitHub App config not found"));
  }

  // Determine if API mode is possible
  let apiAvailable = false;
  const apiDiagnostics: LooseRecord[] = [];

  if (config) {
    if (!config.installationId) {
      apiDiagnostics.push(makeDiagnostic("warn", "GitHub App installation ID not configured"));
    }
    if (!config.privateKeyRef) {
      apiDiagnostics.push(makeDiagnostic("warn", "GitHub App private key not configured"));
    } else {
      try {
        const pk = resolvePrivateKey(config, { env });
        if (!pk) {
          apiDiagnostics.push(makeDiagnostic("error", `Private key not resolvable: ${config.privateKeyRef}`));
        }
      } catch (error) {
        apiDiagnostics.push(makeDiagnostic("error", `Private key resolution failed: ${recordValue(error).message || error}`));
      }
    }
    apiAvailable = Boolean(config.installationId && config.privateKeyRef && apiDiagnostics.length === 0);
  }

  const ghExecutable = await resolveCanonicalGhExecutable(options.ghExecutable);
  let transportDirectories: { homeDir: string; configDir: string } | null = null;
  let versionAvailable = false;
  if (ghExecutable) {
    try {
      transportDirectories = await controlledTransportDirectories(hubRoot);
      const versionRunner = controlledGhRunner({
        executable: ghExecutable,
        execFile: execute,
        ...transportDirectories,
      });
      await versionRunner("gh", ["--version"], { timeout: 5000, maxBuffer: 1024 * 1024 });
      versionAvailable = true;
    } catch (error) {
      diagnostics.push(makeDiagnostic("warn", `canonical gh CLI failed its readiness check: ${String(recordValue(error).message || error)}`));
    }
  } else {
    diagnostics.push(makeDiagnostic("warn", "canonical gh CLI executable not found in a fixed trusted location"));
  }

  let apiBindingFailed = false;
  if (apiAvailable && config && versionAvailable && ghExecutable && transportDirectories) {
    const configuredGetToken = options.getInstallationTokenFn;
    const getToken: InstallationTokenProvider = typeof configuredGetToken === "function"
      ? async () => requiredCredential(await configuredGetToken(config as LooseRecord, { env }), "GitHub App installation token")
      : installationTokenProvider(config, { env });
    try {
      await getToken();
      const principal = await resolveGithubAppPrincipal({
        config,
        env,
        installationToken: getToken,
        getAppJwt: options.getAppJwtFn,
        readJson: options.fetchJsonFn || fetchJson,
      });
      const runCommand = controlledGhRunner({
        executable: ghExecutable,
        execFile: execute,
        ...transportDirectories,
        tokenProvider: getToken,
      });
      const validators = principalBoundValidators(runCommand, principal);
      return {
        mode: "api",
        healthy: true,
        config,
        diagnostics,
        principal,
        ...validators,
        getToken,
        postComment: (req: LooseRecord) => postGithubCommentWithApi(req, config as LooseRecord, { env, getToken }),
        createPullRequest: (req: LooseRecord) => createPullRequestWithApi(req, config as LooseRecord, { env, getToken }),
        closeIssue: (req: LooseRecord) => closeGithubIssueWithApi(req, config as LooseRecord, { env, getToken }),
      };
    } catch (error) {
      apiBindingFailed = true;
      apiDiagnostics.push(makeDiagnostic("error", `GitHub App installation identity/credential binding failed: ${String(recordValue(error).message || error)}`));
    }
  } else if (apiAvailable && !versionAvailable) {
    apiBindingFailed = true;
    apiDiagnostics.push(makeDiagnostic("error", "GitHub App transport requires the canonical gh CLI for same-credential remote verification"));
  }

  // Fallback: resolve one gh credential, bind its actor, and reuse the captured
  // token for every validator, write, and Git push. No later command reads
  // ambient GH_TOKEN, PATH, proxy, CA, or mutable gh auth selection state.
  if (!apiBindingFailed && !apiAvailable && versionAvailable && ghExecutable && transportDirectories) {
    try {
      const bootstrapHome = await assertTrustedUserDirectory(
        trustedPathValue(options.ghHomeDir, os.homedir(), "gh home directory"),
        "gh home directory",
      );
      const defaultConfigDir = defaultGhConfigDirectory(bootstrapHome);
      const selectedConfigDir = trustedPathValue(options.ghConfigDir, defaultConfigDir, "gh config directory");
      const bootstrapConfig = await assertTrustedUserDirectory(selectedConfigDir, "gh config directory");
      if (bootstrapConfig !== bootstrapHome && !bootstrapConfig.startsWith(`${bootstrapHome}${path.sep}`)) {
        throw new Error("gh config directory must remain under the trusted home directory");
      }
      const bootstrapRunner = controlledGhRunner({
        executable: ghExecutable,
        execFile: execute,
        homeDir: bootstrapHome,
        configDir: bootstrapConfig,
      });
      const token = requiredCredential(
        commandStdout(await bootstrapRunner("gh", ["auth", "token", "--hostname", "github.com"], {
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        })),
        "gh authentication token",
      );
      const getToken = async () => token;
      const runCommand = controlledGhRunner({
        executable: ghExecutable,
        execFile: execute,
        ...transportDirectories,
        tokenProvider: getToken,
      });
      const principal = await readBoundGithubActor(runCommand);
      const validators = principalBoundValidators(runCommand, principal);
      const { postGithubCommentWithGh } = await import("./github-issues.js");
      const { createPullRequestWithGh } = await import("./github-issues.js");
      const { closeGithubIssueWithGh } = await import("./github-issues.js");
      type GhCommentRequest = Parameters<typeof postGithubCommentWithGh>[0];
      type GhPullRequest = Parameters<typeof createPullRequestWithGh>[0];
      type GhCloseRequest = Parameters<typeof closeGithubIssueWithGh>[0];

      const fallbackReason = apiDiagnostics.length > 0
        ? apiDiagnostics.map((diagnostic) => diagnostic.message).join("; ")
        : (config ? "API prerequisites not met" : "GitHub App config missing");

      return {
        mode: "gh",
        healthy: true,
        config,
        principal,
        ...validators,
        diagnostics: [
          makeDiagnostic("info", `Using gh CLI fallback: ${fallbackReason}`),
          ...diagnostics,
          ...apiDiagnostics,
        ],
        getToken,
        postComment: (req: GhCommentRequest) => postGithubCommentWithGh(req, { runCommand }),
        createPullRequest: (req: GhPullRequest) => createPullRequestWithGh(req, { runCommand }),
        closeIssue: (req: GhCloseRequest) => closeGithubIssueWithGh(req, { runCommand }),
      };
    } catch (error) {
      diagnostics.push(makeDiagnostic("warn", `gh CLI credential binding failed: ${String(recordValue(error).message || error)}`));
    }
  }

  // Unavailable
  return {
    mode: "unavailable",
    healthy: false,
    config,
    diagnostics: [
      ...diagnostics,
      ...apiDiagnostics,
      makeDiagnostic("error", "GitHub outbound transport unavailable: no same-principal API or canonical gh transport is usable"),
    ],
    principal: null,
    remoteAuthorityValidator: null,
    remoteCommitVerifier: null,
    getToken: null,
    postComment: null,
    createPullRequest: null,
    closeIssue: null,
  };
}
