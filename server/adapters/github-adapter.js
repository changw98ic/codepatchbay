// GitHub Adapter — Consolidated GitHub boundary interface
// Consolidates: github-app.js, github-api.js, github-events.js, github-comments.js, github-pr.js, github-issues.js

import { createHmac, timingSafeEqual, createSign } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "../services/secret-policy.js";

const execFileAsync = promisify(execFile);

const GITHUB_API = "https://api.github.com";
const TOKEN_TTL_S = 600;
const TOKEN_CACHE_S = 3300;
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

let tokenCache = { token: null, expiresAt: 0 };

// === Config Management ===

export function githubAppConfigPath(hubRoot) {
  return path.join(path.resolve(hubRoot), "github", "app.json");
}

function normalizeId(value, field, errors, { required = true } = {}) {
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

function normalizeWebhookSecretRef(value, errors) {
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

function normalizePrivateKeyRef(value, errors) {
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

function normalizePermissions(value, errors) {
  const permissions = {
    ...DEFAULT_GITHUB_APP_PERMISSIONS,
    ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
  };

  for (const [key, level] of Object.entries(permissions)) {
    if (!PERMISSION_LEVELS.has(level)) {
      errors.push(`permissions.${key} must be read or write`);
    }
  }
  return permissions;
}

export function validateGithubAppConfig(raw = {}) {
  const errors = [];
  const appId = normalizeId(raw.appId, "appId", errors);
  const installationId = normalizeId(raw.installationId, "installationId", errors, { required: false });
  const webhookSecretRef = normalizeWebhookSecretRef(raw.webhookSecretRef, errors);
  const privateKeyRef = normalizePrivateKeyRef(raw.privateKeyRef, errors);
  const permissions = normalizePermissions(raw.permissions, errors);

  const config = {
    schemaVersion: SCHEMA_VERSION,
    appId,
    installationId,
    webhookSecretRef,
    privateKeyRef,
    permissions,
    updatedAt: raw.updatedAt || null,
  };

  return {
    valid: errors.length === 0,
    errors,
    config: errors.length === 0 ? config : null,
  };
}

export function redactGithubAppConfig(config) {
  if (!config) return null;
  const { webhookSecret, privateKey, privateKeyPem, ...safe } = config;
  return redactSecrets(safe);
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

export async function saveGithubAppConfig(hubRoot, raw = {}) {
  const validation = validateGithubAppConfig(raw);
  if (!validation.valid) {
    throw new Error(`invalid GitHub App config: ${validation.errors.join("; ")}`);
  }
  const config = redactGithubAppConfig({
    ...validation.config,
    updatedAt: new Date().toISOString(),
  });
  await writeAtomic(githubAppConfigPath(hubRoot), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export async function loadGithubAppConfig(hubRoot) {
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

export function buildGithubAppReadiness(config) {
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
        ? `Private key configured (${config.privateKeyRef.split(":")[0]}:*)`
        : "No private key — outbound transport will use gh CLI",
      recommendedAction: config.privateKeyRef ? null : "Run: cpb github connect --private-key-ref env:CPB_GITHUB_PRIVATE_KEY",
    },
  ];
}

export function resolveSecretRef(secretRef, { env = process.env } = {}) {
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

export function resolveGithubWebhookSecret(config, options = {}) {
  if (!config?.webhookSecretRef) {
    throw new Error("GitHub webhook secret reference missing");
  }
  return resolveSecretRef(config.webhookSecretRef, options);
}

export function verifyGithubWebhookSignature({ signature, rawBody, secret }) {
  if (typeof signature !== "string" || !signature.startsWith("sha256=")) return false;
  if (!secret || !rawBody) return false;

  const providedHex = signature.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(providedHex)) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expectedHex = createHmac("sha256", secret).update(body).digest("hex");
  const provided = Buffer.from(providedHex, "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function resolvePrivateKey(config, { env = process.env } = {}) {
  if (!config?.privateKeyRef) return null;
  const ref = config.privateKeyRef;

  if (ref.startsWith("env:")) {
    const name = ref.slice("env:".length);
    const value = env[name];
    if (!value) throw new Error(`private key not found: env:${name}`);
    return value.replace(/\\n/g, "\n");
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

// === JWT and Token Management ===

function base64url(buf) {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createAppJwt(appId, privateKeyPem) {
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

async function fetchJson(url, options = {}) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "codepatchbay",
    ...options.headers,
  };
  const res = await fetch(url, { ...options, headers });
  const body = await res.json();
  if (!res.ok) {
    const error = new Error(body.message || `GitHub API ${res.status}`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

export async function getInstallationToken(config, { env = process.env, forceRefresh = false } = {}) {
  if (!forceRefresh && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const privateKey = resolvePrivateKey(config, { env });
  if (!privateKey) throw new Error("GitHub App private key not configured");
  if (!config.installationId) throw new Error("GitHub App installation ID not configured");

  const jwt = createAppJwt(config.appId, privateKey);
  const body = await fetchJson(`${GITHUB_API}/app/installations/${config.installationId}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  });

  tokenCache = {
    token: body.token,
    expiresAt: (body.expires_at ? new Date(body.expires_at).getTime() : Date.now() + TOKEN_CACHE_S * 1000) - 60000,
  };
  return tokenCache.token;
}

export function clearTokenCache() {
  tokenCache = { token: null, expiresAt: 0 };
}

// === API Transport ===

export async function postGithubCommentWithApi({ repo, issueNumber, body }, config, { env = process.env } = {}) {
  const token = await getInstallationToken(config, { env });
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

export async function createPullRequestWithApi(request, config, { env = process.env } = {}) {
  const token = await getInstallationToken(config, { env });
  const result = await fetchJson(`${GITHUB_API}/repos/${request.repo}/pulls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: request.title,
      body: request.body,
      head: request.head,
      base: request.base,
      draft: request.draft ?? true,
    }),
  });
  return {
    url: result.html_url || result.url || null,
    html_url: result.html_url || null,
    number: result.number || null,
  };
}

export async function closeGithubIssueWithApi({ repo, number, body }, config, { env = process.env } = {}) {
  const token = await getInstallationToken(config, { env });
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

// === gh CLI Transport ===

export async function postGithubCommentWithGh({ repo, issueNumber, body }, { runCommand = execFileAsync } = {}) {
  const result = await runCommand("gh", [
    "issue",
    "comment",
    String(issueNumber),
    "--repo",
    repo,
    "--body",
    body,
  ], { maxBuffer: 1024 * 1024 });
  return {
    url: null,
    html_url: null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

export async function closeGithubIssueWithGh({ repo, number, body }, { runCommand = execFileAsync } = {}) {
  const args = ["issue", "close", String(number), "--repo", repo];
  if (body) args.push("--comment", body);
  await runCommand("gh", args, { maxBuffer: 1024 * 1024 });
  return { ok: true };
}

export async function createPullRequestWithGh(request, { runCommand = execFileAsync } = {}) {
  const { mkdtemp } = await import("node:fs/promises");
  const { rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cpb-pr-body-"));
  const bodyFile = path.join(tmpDir, "body.md");
  try {
    await writeFile(bodyFile, request.body || "", "utf8");
    const args = [
      "pr", "create",
      "--draft",
      "--title", request.title,
      "--body-file", bodyFile,
      "--repo", request.repo,
      "--head", request.head,
      "--base", request.base,
    ];
    const result = await runCommand("gh", args, { maxBuffer: 1024 * 1024 });
    const match = String(result.stdout || "").match(/https:\/\/github\.com\/[^\s]+\/pull\/([0-9]+)/);
    return {
      url: match ? match[0] : null,
      html_url: match ? match[0] : null,
      number: match ? Number.parseInt(match[1], 10) : null,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// === Event Normalization ===

function ignored(event, reason) {
  return {
    status: "ignored",
    event,
    reason,
  };
}

function repoFullName(payload = {}) {
  return payload.repository?.full_name || payload.repository?.nameWithOwner || payload.repository?.fullName || null;
}

function actorLogin(payload = {}) {
  return payload.sender?.login || payload.actor?.login || payload.sender?.name || null;
}

function issueAuthorAssociation(issue = {}) {
  return issue.author_association || issue.authorAssociation || issue.author?.association || null;
}

function normalizeLabel(label) {
  if (typeof label === "string") return label;
  return label?.name || null;
}

export function normalizeGithubLabels(labels) {
  return Array.isArray(labels) ? labels.map(normalizeLabel).filter(Boolean) : [];
}

function normalizeGithubIssue(issue = {}, { repo, projectId } = {}) {
  return {
    repository: issue.repository || issue.repo || issue.repositoryFullName || repo || null,
    projectId: issue.projectId || projectId || "flow",
    number: Number(issue.number),
    title: issue.title || `Issue #${issue.number}`,
    state: String(issue.state || "OPEN").toUpperCase(),
    url: issue.url || null,
    labels: normalizeGithubLabels(issue.labels),
    body: issue.body || "",
    createdAt: issue.createdAt || null,
    updatedAt: issue.updatedAt || issue.createdAt || null,
    closedAt: issue.closedAt || null,
  };
}

function baseEnvelope({ event, delivery, projectId, payload, type, issue, url, commandText = null }) {
  const normalizedIssue = issue ? normalizeGithubIssue(issue, { repo: repoFullName(payload), projectId }) : null;
  const authorAssociation = issue ? issueAuthorAssociation(issue) : null;
  return {
    status: "ok",
    type,
    event,
    delivery: delivery || null,
    repo: repoFullName(payload),
    projectId: projectId || normalizedIssue?.projectId || null,
    issueNumber: normalizedIssue?.number ?? null,
    actor: actorLogin(payload),
    action: payload.action || null,
    commandText,
    labels: normalizedIssue?.labels || [],
    url: url || normalizedIssue?.url || null,
    title: normalizedIssue?.title || null,
    body: normalizedIssue?.body || null,
    authorAssociation,
    raw: {
      action: payload.action || null,
      authorAssociation,
    },
  };
}

function normalizeIssuesEvent({ event, delivery, projectId, payload }) {
  if (!payload.issue) return ignored(event, "issues payload missing issue");
  return {
    ...baseEnvelope({
      event,
      delivery,
      projectId,
      payload,
      type: "github_issue",
      issue: payload.issue,
      url: payload.issue.html_url || payload.issue.url || null,
    }),
    label: payload.label?.name || null,
  };
}

function normalizeIssueCommentEvent({ event, delivery, projectId, payload }) {
  if (!payload.issue) return ignored(event, "issue_comment payload missing issue");
  const result = baseEnvelope({
    event,
    delivery,
    projectId,
    payload,
    type: "github_issue_comment",
    issue: payload.issue,
    url: payload.comment?.html_url || payload.issue.html_url || payload.issue.url || null,
    commandText: payload.comment?.body || "",
  });
  const commentAssoc = payload.comment?.author_association || null;
  if (commentAssoc) {
    result.authorAssociation = commentAssoc;
    result.raw.authorAssociation = commentAssoc;
  }
  return result;
}

function normalizeInstallationEvent({ event, delivery, payload }) {
  return {
    status: "ok",
    type: "github_installation",
    event,
    delivery: delivery || null,
    repo: null,
    projectId: null,
    issueNumber: null,
    actor: actorLogin(payload),
    action: payload.action || null,
    commandText: null,
    labels: [],
    url: null,
    installationId: payload.installation?.id ?? null,
    repositories: normalizeGithubLabels(
      (payload.repositories || payload.repositories_added || payload.repositories_removed || [])
        .map((repo) => repo.full_name || repo.nameWithOwner || repo.fullName || repo.name),
    ),
  };
}

export function normalizeGithubWebhookEvent({ event, delivery, payload = {}, projectId = null } = {}) {
  if (event === "issues") {
    return normalizeIssuesEvent({ event, delivery, projectId, payload });
  }
  if (event === "issue_comment") {
    return normalizeIssueCommentEvent({ event, delivery, projectId, payload });
  }
  if (event === "installation" || event === "installation_repositories") {
    return normalizeInstallationEvent({ event, delivery, payload });
  }
  return ignored(event || null, `unsupported event: ${event || "unknown"}`);
}

// === Issues Cache ===

function cachePath(hubRoot) {
  return path.join(path.resolve(hubRoot), "github", "issues.json");
}

export async function readGithubIssues(hubRoot) {
  try {
    const parsed = JSON.parse(await readFile(cachePath(hubRoot), "utf8"));
    const issues = Array.isArray(parsed) ? parsed : parsed.issues;
    if (!Array.isArray(issues)) return [];
    return issues.map((issue) => normalizeGithubIssue(issue));
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function writeGithubIssues(hubRoot, { repo, projectId = "flow", issues, syncedAt = new Date().toISOString() } = {}) {
  const normalized = (issues || [])
    .map((issue) => normalizeGithubIssue(issue, { repo, projectId }))
    .filter((issue) => Number.isFinite(issue.number));
  const payload = {
    version: 1,
    repo: repo || null,
    projectId,
    syncedAt,
    count: normalized.length,
    issues: normalized,
  };
  await writeAtomic(cachePath(hubRoot), `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

async function runGh(args, { cwd, execFile = execFileAsync } = {}) {
  const result = await execFile("gh", args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    encoding: "utf8",
  });
  return typeof result === "string" ? result : result.stdout;
}

async function resolveRepo(repo, { cwd, execFile } = {}) {
  if (repo) return repo;
  const stdout = await runGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], { cwd, execFile });
  return stdout.trim();
}

export async function syncGithubIssuesFromGh(hubRoot, {
  repo,
  projectId = "flow",
  state = "open",
  limit = 1000,
  cwd = process.cwd(),
  execFile,
} = {}) {
  const resolvedRepo = await resolveRepo(repo, { cwd, execFile });
  const normalizedState = ["open", "closed", "all"].includes(String(state).toLowerCase())
    ? String(state).toLowerCase()
    : "open";
  const normalizedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 1000, 1000));
  const stdout = await runGh([
    "issue",
    "list",
    "--repo",
    resolvedRepo,
    "--state",
    normalizedState,
    "--limit",
    String(normalizedLimit),
    "--json",
    "number,title,body,url,state,labels,createdAt,updatedAt,closedAt",
  ], { cwd, execFile });
  const issues = JSON.parse(stdout);
  return writeGithubIssues(hubRoot, {
    repo: resolvedRepo,
    projectId,
    issues,
  });
}

// === Transport Resolution ===

function makeDiagnostic(level, message) {
  return { level, message };
}

export async function resolveGithubTransport(hubRoot, { env = process.env } = {}) {
  const diagnostics = [];
  let config = null;

  try {
    config = await loadGithubAppConfig(hubRoot);
  } catch (error) {
    diagnostics.push(makeDiagnostic("error", `Failed to load GitHub App config: ${error.message}`));
  }

  if (!config) {
    diagnostics.push(makeDiagnostic("warn", "GitHub App config not found"));
  }

  let apiAvailable = false;
  let apiDiagnostics = [];

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
        apiDiagnostics.push(makeDiagnostic("error", `Private key resolution failed: ${error.message}`));
      }
    }
    apiAvailable = config.installationId && config.privateKeyRef && apiDiagnostics.length === 0;
  }

  if (apiAvailable) {
    return {
      mode: "api",
      healthy: true,
      config,
      diagnostics: [],
      getToken: () => getInstallationToken(config, { env }),
      postComment: (req) => postGithubCommentWithApi(req, config, { env }),
      createPullRequest: (req) => createPullRequestWithApi(req, config, { env }),
      closeIssue: (req) => closeGithubIssueWithApi(req, config, { env }),
    };
  }

  let ghAvailable = false;
  try {
    await execFileAsync("gh", ["--version"], { timeout: 5000 });
    ghAvailable = true;
  } catch {
    diagnostics.push(makeDiagnostic("warn", "gh CLI not available"));
  }

  if (ghAvailable) {
    const fallbackReason = apiDiagnostics.length > 0
      ? apiDiagnostics.map((d) => d.message).join("; ")
      : (config ? "API prerequisites not met" : "GitHub App config missing");

    return {
      mode: "gh",
      healthy: true,
      config,
      diagnostics: [
        makeDiagnostic("info", `Using gh CLI fallback: ${fallbackReason}`),
        ...apiDiagnostics,
      ],
      getToken: null,
      postComment: (req) => postGithubCommentWithGh(req),
      createPullRequest: (req) => createPullRequestWithGh(req),
      closeIssue: (req) => closeGithubIssueWithGh(req),
    };
  }

  return {
    mode: "unavailable",
    healthy: false,
    config,
    diagnostics: [
      ...diagnostics,
      ...apiDiagnostics,
      makeDiagnostic("error", "GitHub outbound transport unavailable: neither API nor gh CLI is usable"),
    ],
    getToken: null,
    postComment: null,
    createPullRequest: null,
    closeIssue: null,
  };
}

// === Adapter Factory ===

export function createGithubAdapter(hubRoot, { env = process.env } = {}) {
  let transportPromise = null;
  let configCache = null;

  return {
    // Config
    async loadConfig() {
      if (!configCache) {
        configCache = await loadGithubAppConfig(hubRoot);
      }
      return configCache;
    },

    async saveConfig(raw) {
      const config = await saveGithubAppConfig(hubRoot, raw);
      configCache = config;
      return config;
    },

    validateConfig(raw) {
      return validateGithubAppConfig(raw);
    },

    redactConfig(config) {
      return redactGithubAppConfig(config);
    },

    buildReadiness(config) {
      return buildGithubAppReadiness(config);
    },

    // Webhook
    async verifyWebhookSignature({ signature, rawBody }) {
      const config = await this.loadConfig();
      if (!config?.webhookSecretRef) {
        throw new Error("GitHub webhook secret reference missing");
      }
      const secret = resolveGithubWebhookSecret(config, { env });
      return verifyGithubWebhookSignature({ signature, rawBody, secret });
    },

    normalizeEvent({ event, delivery, payload, projectId }) {
      return normalizeGithubWebhookEvent({ event, delivery, payload, projectId });
    },

    // Transport
    async resolveTransport() {
      if (!transportPromise) {
        transportPromise = resolveGithubTransport(hubRoot, { env });
      }
      return transportPromise;
    },

    async getTransport() {
      return this.resolveTransport();
    },

    // Operations (through transport)
    async postComment(request) {
      const transport = await this.resolveTransport();
      if (!transport.postComment) {
        throw new Error("GitHub comment transport not available");
      }
      return transport.postComment(request);
    },

    async createPullRequest(request) {
      const transport = await this.resolveTransport();
      if (!transport.createPullRequest) {
        throw new Error("GitHub PR transport not available");
      }
      return transport.createPullRequest(request);
    },

    async closeIssue(request) {
      const transport = await this.resolveTransport();
      if (!transport.closeIssue) {
        throw new Error("GitHub issue transport not available");
      }
      return transport.closeIssue(request);
    },

    // Token
    async getToken() {
      const config = await this.loadConfig();
      if (!config) {
        throw new Error("GitHub App config not loaded");
      }
      return getInstallationToken(config, { env });
    },

    clearTokenCache() {
      clearTokenCache();
    },

    // Issues
    async readIssues() {
      return readGithubIssues(hubRoot);
    },

    async syncIssues(options) {
      return syncGithubIssuesFromGh(hubRoot, options);
    },
  };
}
