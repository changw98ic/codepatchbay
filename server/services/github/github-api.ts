// Merged from: github-api.ts, github-app.ts

import { createSign, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AnyRecord } from "../../../shared/types.js";
import { redactSecrets } from "../secret-policy.js";

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

export function githubAppConfigPath(hubRoot: string) {
  return path.join(path.resolve(hubRoot), "github", "app.json");
}

function normalizeId(value: any, field: string, errors: string[], { required = true }: AnyRecord = {}) {
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

function normalizeWebhookSecretRef(value: any, errors: string[]) {
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

function normalizePrivateKeyRef(value: any, errors: string[]) {
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

function normalizePermissions(value: any, errors: string[]) {
  const permissions: AnyRecord = {
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
  const input = raw as AnyRecord;
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

export function redactGithubAppConfig(config: AnyRecord | null) {
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

export async function saveGithubAppConfig(hubRoot: string, raw: AnyRecord = {}) {
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
    updatedAt: (raw as AnyRecord).updatedAt || null,
  });
}

export function buildGithubAppReadiness(config: AnyRecord | null) {
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

export function resolveSecretRef(secretRef: any, { env = process.env }: AnyRecord = {}) {
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

export function resolveGithubWebhookSecret(config: AnyRecord | null, options: AnyRecord = {}) {
  if (!config?.webhookSecretRef) {
    throw new Error("GitHub webhook secret reference missing");
  }
  return resolveSecretRef(config.webhookSecretRef, options);
}

export function verifyGithubWebhookSignature({ signature, rawBody, secret }: AnyRecord) {
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

// ============================================================
// github-api.ts exports (original)
// ============================================================

const GITHUB_API = "https://api.github.com";
const TOKEN_TTL_S = 600; // JWT valid for 10 minutes
const TOKEN_CACHE_S = 3300; // Cache installation token ~55 min

// --- Private key resolution ---

export function resolvePrivateKey(config: AnyRecord | null | undefined, { env = process.env }: AnyRecord = {}) {
  if (!config?.privateKeyRef) return null;
  const ref = config.privateKeyRef;

  if (ref.startsWith("env:")) {
    const name = ref.slice("env:".length);
    const value = env[name];
    if (!value) throw new Error(`private key not found: env:${name}`);
    // env var may contain literal \n that need unescaping
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

let tokenCache: { token: string | null; expiresAt: number } = { token: null, expiresAt: 0 };

async function fetchJson(url: string, options: AnyRecord = {}) {
  const requestOptions = options as RequestInit & { headers?: Record<string, string> };
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "codepatchbay",
    ...requestOptions.headers,
  };
  const res = await fetch(url, { ...requestOptions, headers });
  const body = await res.json();
  if (!res.ok) {
    const error = new Error(body.message || `GitHub API ${res.status}`);
    (error as Error & { status?: number; body?: any }).status = res.status;
    (error as Error & { status?: number; body?: any }).body = body;
    throw error;
  }
  return body;
}

export async function getInstallationToken(config: AnyRecord, { env = process.env, forceRefresh = false }: AnyRecord = {}) {
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

// --- Transport: post issue comment ---

export async function postGithubCommentWithApi({ repo, issueNumber, body }: AnyRecord, config: AnyRecord, { env = process.env }: AnyRecord = {}) {
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

// --- Transport: create pull request ---

export async function createPullRequestWithApi(request: AnyRecord, config: AnyRecord, { env = process.env }: AnyRecord = {}) {
  const token = await getInstallationToken(config, { env });
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

export async function closeGithubIssueWithApi({ repo, number, body }: AnyRecord, config: AnyRecord, { env = process.env }: AnyRecord = {}) {
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

// --- Composite transport selector (never throws) ---

function makeDiagnostic(level: string, message: string) {
  return { level, message };
}

export async function resolveGithubTransport(hubRoot: string, { env = process.env }: AnyRecord = {}): Promise<AnyRecord> {
  const diagnostics: AnyRecord[] = [];
  let config: AnyRecord | null = null;

  // Load config
  try {
    config = await loadGithubAppConfig(hubRoot);
  } catch (error) {
    diagnostics.push(makeDiagnostic("error", `Failed to load GitHub App config: ${error.message}`));
  }

  if (!config) {
    diagnostics.push(makeDiagnostic("warn", "GitHub App config not found"));
  }

  // Determine if API mode is possible
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
      diagnostics: [] as AnyRecord[],
      getToken: () => getInstallationToken(config, { env }),
      postComment: (req: AnyRecord) => postGithubCommentWithApi(req, config, { env }),
      createPullRequest: (req: AnyRecord) => createPullRequestWithApi(req, config, { env }),
      closeIssue: (req: AnyRecord) => closeGithubIssueWithApi(req, config, { env }),
    };
  }

  // Fallback: use gh CLI
  let ghAvailable = false;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    await execFileAsync("gh", ["--version"], { timeout: 5000 });
    ghAvailable = true;
  } catch {
    diagnostics.push(makeDiagnostic("warn", "gh CLI not available"));
  }

  if (ghAvailable) {
    const { postGithubCommentWithGh } = await import("./github-issues.js");
    const { createPullRequestWithGh } = await import("./github-issues.js");
    const { closeGithubIssueWithGh } = await import("./github-issues.js");

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
      postComment: (req: AnyRecord) => postGithubCommentWithGh(req),
      createPullRequest: (req: AnyRecord) => createPullRequestWithGh(req),
      closeIssue: (req: AnyRecord) => closeGithubIssueWithGh(req),
    };
  }

  // Unavailable
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
