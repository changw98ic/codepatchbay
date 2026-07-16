import { createHash, timingSafeEqual } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { normalizeBearerToken } from "./network.js";

const HUB_SERVICE_TOKENS_FORMAT = "cpb-hub-service-tokens/v1";
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_SERVICE_TOKENS = 1024;
const MAX_PROJECTS_PER_TOKEN = 4096;
const SAFE_PRINCIPAL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:@-]{0,126}[A-Za-z0-9])?$/;
const SAFE_PROJECT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const RESERVED_PRINCIPAL_IDS = new Set(["legacy-admin", "local-anonymous"]);

export type HubScope = "hub:health" | "hub:read" | "hub:admin";
export type HubPrincipal = {
  id: string;
  scopes: HubScope[];
  projects: "*" | string[];
  source: "legacy-env" | "service-token-file" | "local-anonymous" | "oidc" | "worker-broker";
  expiresAt: string | null;
};

type CompiledCredential = {
  digest: Buffer;
  expiresAtMs: number | null;
  principal: HubPrincipal;
};

export type HubAuthConfig = {
  required: boolean;
  sourceFile: string | null;
  sourceFingerprint: string | null;
  credentialCount: number;
  credentials: CompiledCredential[];
};

export type HubAuthOptions = {
  bearerToken?: unknown;
  serviceTokensFile?: unknown;
  hubRoot?: unknown;
  requireAuthentication?: unknown;
};

export type HubAuthProviderStatus = {
  sourceFile: string | null;
  credentialCount: number;
  reloadCount: number;
  lastReloadAt: string;
  lastFailureAt: string | null;
  healthy: boolean;
};

export type HubAuthProvider = {
  initial: HubAuthConfig;
  getConfig: () => Promise<HubAuthConfig>;
  status: () => HubAuthProviderStatus;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.sort().join(", ")}`);
}

function tokenDigest(token: string) {
  return createHash("sha256").update(token, "utf8").digest();
}

function isWithin(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function parseScopes(value: unknown, principalId: string): HubScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Hub service-token principal '${principalId}' must declare at least one scope`);
  }
  const allowed = new Set<HubScope>(["hub:health", "hub:read", "hub:admin"]);
  const scopes: HubScope[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item as HubScope)) {
      throw new Error(`Hub service-token principal '${principalId}' has unsupported scope: ${String(item)}`);
    }
    if (scopes.includes(item as HubScope)) {
      throw new Error(`Hub service-token principal '${principalId}' has duplicate scope: ${item}`);
    }
    scopes.push(item as HubScope);
  }
  return scopes;
}

function parseProjects(value: unknown, principalId: string): "*" | string[] {
  if (value === "*") return "*";
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROJECTS_PER_TOKEN) {
    throw new Error(`Hub service-token principal '${principalId}' must declare '*' or a non-empty projects array`);
  }
  const projects: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !SAFE_PROJECT_ID.test(item)) {
      throw new Error(`Hub service-token principal '${principalId}' has invalid project id: ${String(item)}`);
    }
    if (projects.includes(item)) {
      throw new Error(`Hub service-token principal '${principalId}' has duplicate project id: ${item}`);
    }
    projects.push(item);
  }
  return projects.sort();
}

function parseExpiresAt(value: unknown, principalId: string) {
  if (value === undefined || value === null) return { expiresAt: null, expiresAtMs: null };
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (typeof value !== "string" || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Hub service-token principal '${principalId}' has invalid expiresAt`);
  }
  return { expiresAt: value, expiresAtMs: parsed };
}

function fileFingerprint(info: Stats) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

async function readServiceTokensFile(filePathInput: unknown) {
  const filePath = String(filePathInput || "").trim();
  if (!filePath) return { filePath: null, fingerprint: null, entries: [] as CompiledCredential[] };
  if (!path.isAbsolute(filePath)) {
    throw new Error("CPB_HUB_SERVICE_TOKENS_FILE must be an absolute path");
  }
  let linkInfo;
  try {
    linkInfo = await lstat(filePath);
  } catch (error) {
    throw new Error(`cannot inspect CPB_HUB_SERVICE_TOKENS_FILE at ${filePath}: ${errnoCode(error) || (error instanceof Error ? error.message : String(error))}`);
  }
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE must be a real file: ${filePath}`);
  }
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    throw new Error(`cannot open CPB_HUB_SERVICE_TOKENS_FILE at ${filePath}: ${errnoCode(error) || (error instanceof Error ? error.message : String(error))}`);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE must be a real file: ${filePath}`);
    if (fileFingerprint(linkInfo) !== fileFingerprint(before)) {
      throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE changed before it was opened: ${filePath}`);
    }
    if (before.size > MAX_AUTH_FILE_BYTES) {
      throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE exceeds ${MAX_AUTH_FILE_BYTES} bytes`);
    }
    if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
      throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE must not be accessible by group or other users: ${filePath}`);
    }
    const buffer = Buffer.alloc(MAX_AUTH_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_AUTH_FILE_BYTES) {
      throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE exceeds ${MAX_AUTH_FILE_BYTES} bytes`);
    }
    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    const after = await handle.stat();
    if (fileFingerprint(before) !== fileFingerprint(after)) {
      throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE changed while it was being read: ${filePath}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid CPB_HUB_SERVICE_TOKENS_FILE JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const top = record(parsed, "Hub service-token file");
    assertOnlyKeys(top, ["format", "tokens"], "Hub service-token file");
    if (top.format !== HUB_SERVICE_TOKENS_FORMAT) {
      throw new Error(`unsupported Hub service-token file format: ${String(top.format || "missing")}`);
    }
    if (!Array.isArray(top.tokens) || top.tokens.length === 0 || top.tokens.length > MAX_SERVICE_TOKENS) {
      throw new Error(`Hub service-token file must contain 1-${MAX_SERVICE_TOKENS} tokens`);
    }

    const ids = new Set<string>();
    const digests = new Set<string>();
    const entries: CompiledCredential[] = [];
    for (let index = 0; index < top.tokens.length; index += 1) {
      const item = record(top.tokens[index], `Hub service-token entry ${index}`);
      assertOnlyKeys(item, ["id", "tokenSha256", "scopes", "projects", "expiresAt"], `Hub service-token entry ${index}`);
      const id = typeof item.id === "string" ? item.id : "";
      if (!SAFE_PRINCIPAL_ID.test(id) || RESERVED_PRINCIPAL_IDS.has(id) || ids.has(id)) {
        throw new Error(`invalid or duplicate Hub service-token principal id: ${id || "<missing>"}`);
      }
      ids.add(id);
      const digestHex = typeof item.tokenSha256 === "string" ? item.tokenSha256.toLowerCase() : "";
      if (!/^[a-f0-9]{64}$/.test(digestHex) || digests.has(digestHex)) {
        throw new Error(`invalid or duplicate tokenSha256 for Hub service-token principal '${id}'`);
      }
      digests.add(digestHex);
      const scopes = parseScopes(item.scopes, id);
      const projects = parseProjects(item.projects, id);
      if (scopes.includes("hub:admin") && projects !== "*") {
        throw new Error(`Hub admin principal '${id}' must use projects: '*'`);
      }
      const expiry = parseExpiresAt(item.expiresAt, id);
      entries.push({
        digest: Buffer.from(digestHex, "hex"),
        expiresAtMs: expiry.expiresAtMs,
        principal: {
          id,
          scopes,
          projects,
          source: "service-token-file",
          expiresAt: expiry.expiresAt,
        },
      });
    }
    return { filePath, fingerprint: fileFingerprint(after), entries };
  } finally {
    await handle.close();
  }
}

async function inspectServiceTokensFileFingerprint(filePath: string) {
  let linkInfo;
  try {
    linkInfo = await lstat(filePath);
  } catch (error) {
    throw new Error(`cannot inspect CPB_HUB_SERVICE_TOKENS_FILE at ${filePath}: ${errnoCode(error) || (error instanceof Error ? error.message : String(error))}`);
  }
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE must be a real file: ${filePath}`);
  }
  if (linkInfo.size > MAX_AUTH_FILE_BYTES) {
    throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE exceeds ${MAX_AUTH_FILE_BYTES} bytes`);
  }
  if (process.platform !== "win32" && (linkInfo.mode & 0o077) !== 0) {
    throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE must not be accessible by group or other users: ${filePath}`);
  }
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    throw new Error(`cannot open CPB_HUB_SERVICE_TOKENS_FILE at ${filePath}: ${errnoCode(error) || (error instanceof Error ? error.message : String(error))}`);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || fileFingerprint(linkInfo) !== fileFingerprint(opened)) {
      throw new Error(`CPB_HUB_SERVICE_TOKENS_FILE changed before it was opened: ${filePath}`);
    }
    return fileFingerprint(opened);
  } finally {
    await handle.close();
  }
}

export async function loadHubAuthConfig({ bearerToken, serviceTokensFile, hubRoot, requireAuthentication }: HubAuthOptions = {}): Promise<HubAuthConfig> {
  const legacyToken = normalizeBearerToken(bearerToken, "CPB Hub bearer token");
  const loaded = await readServiceTokensFile(serviceTokensFile);
  const resolvedHubRoot = String(hubRoot || "").trim();
  if (loaded.filePath && resolvedHubRoot && isWithin(resolvedHubRoot, loaded.filePath)) {
    throw new Error("CPB_HUB_SERVICE_TOKENS_FILE must be stored outside the Hub root and its backups");
  }
  const credentials = [...loaded.entries];
  if (legacyToken) {
    const digest = tokenDigest(legacyToken);
    if (credentials.some((entry) => timingSafeEqual(entry.digest, digest))) {
      throw new Error("CPB_HUB_BEARER_TOKEN duplicates a token in CPB_HUB_SERVICE_TOKENS_FILE");
    }
    credentials.push({
      digest,
      expiresAtMs: null,
      principal: {
        id: "legacy-admin",
        scopes: ["hub:admin"],
        projects: "*",
        source: "legacy-env",
        expiresAt: null,
      },
    });
  }
  if (credentials.length > 0 && !credentials.some((entry) => entry.expiresAtMs === null || entry.expiresAtMs > Date.now())) {
    throw new Error("all configured Hub bearer credentials are expired");
  }
  return {
    required: credentials.length > 0 || requireAuthentication === true,
    sourceFile: loaded.filePath,
    sourceFingerprint: loaded.fingerprint,
    credentialCount: credentials.length,
    credentials,
  };
}

function authConfigurationUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(`Hub authentication configuration reload failed: ${message}`), {
    code: "HUB_AUTH_CONFIGURATION_UNAVAILABLE",
    cause: error,
  });
}

export async function openHubAuthProvider(options: HubAuthOptions = {}): Promise<HubAuthProvider> {
  const initial = await loadHubAuthConfig(options);
  let current = initial;
  let reloadCount = 0;
  let lastReloadAt = new Date().toISOString();
  let lastFailureAt: string | null = null;
  let reloadInFlight: Promise<HubAuthConfig> | null = null;

  const getConfig = async () => {
    if (!current.sourceFile) return current;
    if (reloadInFlight) return reloadInFlight;
    let observedFingerprint: string;
    try {
      observedFingerprint = await inspectServiceTokensFileFingerprint(current.sourceFile);
    } catch (error) {
      lastFailureAt = new Date().toISOString();
      throw authConfigurationUnavailable(error);
    }
    if (reloadInFlight) return reloadInFlight;
    if (observedFingerprint === current.sourceFingerprint) return current;

    reloadInFlight = (async () => {
      try {
        const loaded = await loadHubAuthConfig(options);
        if (loaded.sourceFile !== current.sourceFile || !loaded.sourceFingerprint) {
          throw new Error("Hub service-token source changed during reload");
        }
        current = loaded;
        reloadCount += 1;
        lastReloadAt = new Date().toISOString();
        lastFailureAt = null;
        return current;
      } catch (error) {
        lastFailureAt = new Date().toISOString();
        throw authConfigurationUnavailable(error);
      } finally {
        reloadInFlight = null;
      }
    })();
    return reloadInFlight;
  };

  return {
    initial,
    getConfig,
    status: () => ({
      sourceFile: current.sourceFile,
      credentialCount: current.credentialCount,
      reloadCount,
      lastReloadAt,
      lastFailureAt,
      healthy: lastFailureAt === null,
    }),
  };
}

function bearerValue(authorization: unknown) {
  if (typeof authorization !== "string") return "";
  return authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || "";
}

export function authenticateHubRequest(authorization: unknown, config: HubAuthConfig, now = Date.now()): HubPrincipal | null {
  if (!config.required) {
    return {
      id: "local-anonymous",
      scopes: ["hub:admin"],
      projects: "*",
      source: "local-anonymous",
      expiresAt: null,
    };
  }
  const token = bearerValue(authorization);
  if (!token) return null;
  const digest = tokenDigest(token);
  let matched: CompiledCredential | null = null;
  for (const credential of config.credentials) {
    const equal = timingSafeEqual(credential.digest, digest);
    if (equal) matched = credential;
  }
  if (!matched || (matched.expiresAtMs !== null && matched.expiresAtMs <= now)) return null;
  return {
    ...matched.principal,
    scopes: [...matched.principal.scopes],
    projects: matched.principal.projects === "*" ? "*" : [...matched.principal.projects],
  };
}

export function hubPrincipalHasScope(principal: HubPrincipal, required: HubScope) {
  if (principal.scopes.includes("hub:admin")) return true;
  if (required === "hub:health" && principal.scopes.includes("hub:read")) return true;
  return principal.scopes.includes(required);
}

export function hubPrincipalCanAccessProject(principal: HubPrincipal, projectId: unknown) {
  return principal.projects === "*"
    || (typeof projectId === "string" && principal.projects.includes(projectId));
}
