import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./secret-policy.js";

const SCHEMA_VERSION = 1;
const PERMISSION_LEVELS = new Set(["read", "write"]);
type AnyRecord = Record<string, any>;

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
