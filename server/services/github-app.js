import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./secret-policy.js";

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
  const permissions = normalizePermissions(raw.permissions, errors);

  const config = {
    schemaVersion: SCHEMA_VERSION,
    appId,
    installationId,
    webhookSecretRef,
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
    updatedAt: nowIso(),
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
      recommendedAction: config.installationId ? null : "Run: cpb github install-app",
    },
  ];
}
