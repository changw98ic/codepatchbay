import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveSecretRef } from "./github-app.js";

const GITHUB_API = "https://api.github.com";
const TOKEN_TTL_S = 600; // JWT valid for 10 minutes
const TOKEN_CACHE_S = 3300; // Cache installation token ~55 min

// --- Private key resolution ---

export function resolvePrivateKey(config, { env = process.env } = {}) {
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

// --- Installation token ---

let tokenCache = { token: null, expiresAt: 0 };

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

// --- Transport: post issue comment ---

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

// --- Transport: create pull request ---

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

// --- Transport: close issue ---

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

// --- Composite transport selector ---

export async function resolveGithubTransport(hubRoot, { env = process.env } = {}) {
  const { loadGithubAppConfig } = await import("./github-app.js");
  const config = await loadGithubAppConfig(hubRoot);

  // If we have private key + installation, use REST API
  const hasPrivateKey = config?.privateKeyRef && resolvePrivateKey(config, { env }) !== null;
  if (hasPrivateKey && config?.installationId) {
    return {
      mode: "api",
      config,
      getToken: () => getInstallationToken(config, { env }),
      postComment: (req) => postGithubCommentWithApi(req, config, { env }),
      createPullRequest: (req) => createPullRequestWithApi(req, config, { env }),
      closeIssue: (req) => closeGithubIssueWithApi(req, config, { env }),
    };
  }

  // Fallback: use gh CLI
  const { postGithubCommentWithGh } = await import("./github-comments.js");
  const { createPullRequestWithGh } = await import("./github-pr.js");
  const { closeGithubIssueWithGh } = await import("./github-issues.js");
  return {
    mode: "gh",
    config,
    postComment: (req) => postGithubCommentWithGh(req),
    createPullRequest: (req) => createPullRequestWithGh(req),
    closeIssue: (req) => closeGithubIssueWithGh(req),
  };
}
