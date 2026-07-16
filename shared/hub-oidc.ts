import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { HubPrincipal, HubScope } from "./hub-auth.js";

const OIDC_CONFIG_FORMAT = "cpb-hub-oidc/v1";
const OIDC_PROFILE = "rfc9068";
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_JWKS_BYTES = 1024 * 1024;
const MAX_JWKS_KEYS = 100;
const MAX_TOKEN_BYTES = 32 * 1024;
const MAX_JWT_PART_BYTES = 24 * 1024;
const SAFE_PROJECT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const ALLOWED_ALGORITHMS = new Set<OidcAlgorithm>(["RS256", "ES256"]);
const SCOPE_ORDER: HubScope[] = ["hub:health", "hub:read", "hub:admin"];
const utf8 = new TextDecoder("utf-8", { fatal: true });

type OidcAlgorithm = "RS256" | "ES256";

type GroupGrant = {
  scopes: HubScope[];
  projects: "*" | string[];
};

export type HubOidcConfig = {
  sourceFile: string;
  sourceFingerprint: string;
  profile: "rfc9068";
  issuer: string;
  audiences: string[];
  jwksUri: string;
  algorithms: OidcAlgorithm[];
  groupsClaim: string;
  groupMappings: Map<string, GroupGrant>;
  clockSkewSeconds: number;
  maxTokenAgeSeconds: number;
  jwksCacheSeconds: number;
  jwksRefreshMinSeconds: number;
  requestTimeoutMs: number;
};

export type HubOidcOptions = {
  configFile?: unknown;
  hubRoot?: unknown;
  fetcher?: typeof fetch;
  now?: () => number;
};

export type HubOidcProviderStatus = {
  configured: boolean;
  sourceFile: string | null;
  reloadCount: number;
  lastReloadAt: string | null;
  lastFailureAt: string | null;
  healthy: boolean;
  keyCount: number;
  jwksFreshUntil: string | null;
};

export type HubOidcProvider = {
  configured: boolean;
  initial: HubOidcConfig | null;
  getConfig: () => Promise<HubOidcConfig | null>;
  authenticate: (authorization: unknown, knownConfig?: HubOidcConfig | null) => Promise<HubPrincipal | null>;
  preflight: () => Promise<{ keyCount: number; freshUntil: string | null }>;
  status: () => HubOidcProviderStatus;
};

type ImportedJwk = {
  kid: string | null;
  algorithm: OidcAlgorithm;
  key: KeyObject;
};

type JwksSnapshot = {
  configFingerprint: string;
  keys: Map<string, ImportedJwk>;
  fetchedAt: number;
  freshUntil: number;
  ttlSeconds: number;
  etag: string | null;
  lastModified: string | null;
};

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function codedError(code: string, message: string, cause?: unknown) {
  return Object.assign(new Error(message), { code, cause });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const known = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !known.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unsupported.sort().join(", ")}`);
  }
}

function fileFingerprint(info: Stats) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

function isWithin(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function parseStrictJson(raw: string, label: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  let offset = 0;
  const whitespace = () => {
    while (/\s/.test(raw[offset] || "")) offset += 1;
  };
  const jsonString = () => {
    const start = offset;
    offset += 1;
    while (offset < raw.length) {
      if (raw[offset] === "\\") {
        offset += raw[offset + 1] === "u" ? 6 : 2;
      } else if (raw[offset] === '"') {
        offset += 1;
        return JSON.parse(raw.slice(start, offset)) as string;
      } else {
        offset += 1;
      }
    }
    throw new Error(`invalid ${label} JSON string`);
  };
  const value = (): void => {
    whitespace();
    if (raw[offset] === "{") {
      offset += 1;
      whitespace();
      const names = new Set<string>();
      if (raw[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < raw.length) {
        const name = jsonString();
        if (names.has(name)) throw new Error(`${label} contains duplicate JSON member: ${name}`);
        names.add(name);
        whitespace();
        offset += 1; // colon; JSON.parse already established grammar
        value();
        whitespace();
        if (raw[offset] === "}") {
          offset += 1;
          return;
        }
        offset += 1; // comma
        whitespace();
      }
      return;
    }
    if (raw[offset] === "[") {
      offset += 1;
      whitespace();
      if (raw[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < raw.length) {
        value();
        whitespace();
        if (raw[offset] === "]") {
          offset += 1;
          return;
        }
        offset += 1;
      }
      return;
    }
    if (raw[offset] === '"') {
      jsonString();
      return;
    }
    while (offset < raw.length && !/[\s,\]}]/.test(raw[offset])) offset += 1;
  };
  value();
  whitespace();
  if (offset !== raw.length) throw new Error(`invalid trailing data in ${label} JSON`);
  return parsed;
}

async function inspectPrivateFile(filePath: string, label: string) {
  let linkInfo;
  try {
    linkInfo = await lstat(filePath);
  } catch (error) {
    throw new Error(`cannot inspect ${label} at ${filePath}: ${errnoCode(error) || (error instanceof Error ? error.message : String(error))}`);
  }
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error(`${label} must be a real file: ${filePath}`);
  if (linkInfo.size > MAX_CONFIG_BYTES) throw new Error(`${label} exceeds ${MAX_CONFIG_BYTES} bytes`);
  if (process.platform !== "win32" && (linkInfo.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users: ${filePath}`);
  }
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    throw new Error(`cannot open ${label} at ${filePath}: ${errnoCode(error) || (error instanceof Error ? error.message : String(error))}`);
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || fileFingerprint(opened) !== fileFingerprint(linkInfo)) {
      throw new Error(`${label} changed before it was opened: ${filePath}`);
    }
    return fileFingerprint(opened);
  } finally {
    await handle.close();
  }
}

async function readPrivateFile(filePath: string, label: string) {
  let linkInfo;
  try {
    linkInfo = await lstat(filePath);
  } catch (error) {
    throw new Error(`cannot inspect ${label} at ${filePath}: ${errnoCode(error) || (error instanceof Error ? error.message : String(error))}`);
  }
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error(`${label} must be a real file: ${filePath}`);
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    throw new Error(`cannot open ${label} at ${filePath}: ${errnoCode(error) || (error instanceof Error ? error.message : String(error))}`);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || fileFingerprint(before) !== fileFingerprint(linkInfo)) {
      throw new Error(`${label} changed before it was opened: ${filePath}`);
    }
    if (before.size > MAX_CONFIG_BYTES) throw new Error(`${label} exceeds ${MAX_CONFIG_BYTES} bytes`);
    if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
      throw new Error(`${label} must not be accessible by group or other users: ${filePath}`);
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error(`${label} exceeds ${MAX_CONFIG_BYTES} bytes`);
    const after = await handle.stat();
    if (fileFingerprint(before) !== fileFingerprint(after)) throw new Error(`${label} changed while it was being read: ${filePath}`);
    return {
      raw: utf8.decode(buffer.subarray(0, bytesRead)),
      fingerprint: fileFingerprint(after),
    };
  } finally {
    await handle.close();
  }
}

function requiredString(value: unknown, label: string, maxLength = 1024) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || (candidate as number) < min || (candidate as number) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return candidate as number;
}

function httpsUrl(value: unknown, label: string, { allowQuery = false } = {}) {
  const raw = requiredString(value, label, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (!allowQuery && url.search)) {
    throw new Error(`${label} must be an absolute HTTPS URL without credentials${allowQuery ? " or a fragment" : ", query, or fragment"}`);
  }
  return raw;
}

function parseScopes(value: unknown, group: string) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`OIDC group '${group}' must declare at least one scope`);
  const scopes: HubScope[] = [];
  for (const entry of value) {
    if (entry !== "hub:health" && entry !== "hub:read" && entry !== "hub:admin") {
      throw new Error(`OIDC group '${group}' has unsupported scope: ${String(entry)}`);
    }
    if (scopes.includes(entry)) throw new Error(`OIDC group '${group}' has duplicate scope: ${entry}`);
    scopes.push(entry);
  }
  return SCOPE_ORDER.filter((scope) => scopes.includes(scope));
}

function parseProjects(value: unknown, group: string): "*" | string[] {
  if (value === "*") return "*";
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096) {
    throw new Error(`OIDC group '${group}' must declare '*' or a non-empty projects array`);
  }
  const projects: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !SAFE_PROJECT_ID.test(entry)) {
      throw new Error(`OIDC group '${group}' has invalid project id: ${String(entry)}`);
    }
    if (projects.includes(entry)) throw new Error(`OIDC group '${group}' has duplicate project id: ${entry}`);
    projects.push(entry);
  }
  return projects.sort();
}

function parseConfig(raw: string, filePath: string, fingerprint: string): HubOidcConfig {
  const top = record(parseStrictJson(raw, "CPB_HUB_OIDC_CONFIG_FILE"), "Hub OIDC config");
  assertOnlyKeys(top, [
    "format", "profile", "issuer", "audiences", "jwksUri", "algorithms", "groupsClaim", "groupMappings",
    "clockSkewSeconds", "maxTokenAgeSeconds", "jwksCacheSeconds", "jwksRefreshMinSeconds", "requestTimeoutMs",
  ], "Hub OIDC config");
  if (top.format !== OIDC_CONFIG_FORMAT) throw new Error(`unsupported Hub OIDC config format: ${String(top.format || "missing")}`);
  if (top.profile !== OIDC_PROFILE) throw new Error(`unsupported Hub OIDC profile: ${String(top.profile || "missing")}`);
  const issuer = httpsUrl(top.issuer, "Hub OIDC issuer");
  const jwksUri = httpsUrl(top.jwksUri, "Hub OIDC jwksUri", { allowQuery: true });

  if (!Array.isArray(top.audiences) || top.audiences.length === 0 || top.audiences.length > 16) {
    throw new Error("Hub OIDC audiences must contain 1-16 values");
  }
  const audiences = top.audiences.map((entry, index) => requiredString(entry, `Hub OIDC audience ${index}`, 512));
  if (new Set(audiences).size !== audiences.length) throw new Error("Hub OIDC audiences must be unique");

  if (!Array.isArray(top.algorithms) || top.algorithms.length === 0 || top.algorithms.length > ALLOWED_ALGORITHMS.size) {
    throw new Error("Hub OIDC algorithms must be a non-empty allowlist");
  }
  const algorithms: OidcAlgorithm[] = [];
  for (const algorithm of top.algorithms) {
    if (!ALLOWED_ALGORITHMS.has(algorithm as OidcAlgorithm) || algorithms.includes(algorithm as OidcAlgorithm)) {
      throw new Error(`unsupported or duplicate Hub OIDC algorithm: ${String(algorithm)}`);
    }
    algorithms.push(algorithm as OidcAlgorithm);
  }

  const groupsClaim = top.groupsClaim === undefined ? "groups" : requiredString(top.groupsClaim, "Hub OIDC groupsClaim", 256);
  const mappings = record(top.groupMappings, "Hub OIDC groupMappings");
  const mappingEntries = Object.entries(mappings);
  if (mappingEntries.length === 0 || mappingEntries.length > 512) {
    throw new Error("Hub OIDC groupMappings must contain 1-512 groups");
  }
  const groupMappings = new Map<string, GroupGrant>();
  for (const [group, rawGrant] of mappingEntries) {
    requiredString(group, "Hub OIDC group name", 256);
    if (group === "__proto__" || group === "prototype" || group === "constructor") {
      throw new Error(`Hub OIDC group name is reserved: ${group}`);
    }
    const grant = record(rawGrant, `Hub OIDC group '${group}'`);
    assertOnlyKeys(grant, ["scopes", "projects"], `Hub OIDC group '${group}'`);
    const scopes = parseScopes(grant.scopes, group);
    const projects = parseProjects(grant.projects, group);
    if (scopes.includes("hub:admin") && projects !== "*") {
      throw new Error(`OIDC admin group '${group}' must use projects: '*'`);
    }
    groupMappings.set(group, { scopes, projects });
  }

  const clockSkewSeconds = boundedInteger(top.clockSkewSeconds, 60, 0, 300, "Hub OIDC clockSkewSeconds");
  const maxTokenAgeSeconds = boundedInteger(top.maxTokenAgeSeconds, 3600, 60, 86_400, "Hub OIDC maxTokenAgeSeconds");
  const jwksCacheSeconds = boundedInteger(top.jwksCacheSeconds, 300, 0, 86_400, "Hub OIDC jwksCacheSeconds");
  const jwksRefreshMinSeconds = boundedInteger(top.jwksRefreshMinSeconds, 30, 1, 3600, "Hub OIDC jwksRefreshMinSeconds");
  if (jwksCacheSeconds > 0 && jwksRefreshMinSeconds > jwksCacheSeconds) {
    throw new Error("Hub OIDC jwksRefreshMinSeconds must not exceed jwksCacheSeconds");
  }
  const requestTimeoutMs = boundedInteger(top.requestTimeoutMs, 5000, 100, 30_000, "Hub OIDC requestTimeoutMs");

  return {
    sourceFile: filePath,
    sourceFingerprint: fingerprint,
    profile: OIDC_PROFILE,
    issuer,
    audiences,
    jwksUri,
    algorithms,
    groupsClaim,
    groupMappings,
    clockSkewSeconds,
    maxTokenAgeSeconds,
    jwksCacheSeconds,
    jwksRefreshMinSeconds,
    requestTimeoutMs,
  };
}

async function loadOidcConfig({ configFile, hubRoot }: HubOidcOptions): Promise<HubOidcConfig | null> {
  const filePath = String(configFile || "").trim();
  if (!filePath) return null;
  if (!path.isAbsolute(filePath)) throw new Error("CPB_HUB_OIDC_CONFIG_FILE must be an absolute path");
  const resolvedHubRoot = String(hubRoot || "").trim();
  if (resolvedHubRoot && isWithin(resolvedHubRoot, filePath)) {
    throw new Error("CPB_HUB_OIDC_CONFIG_FILE must be stored outside the Hub root and its backups");
  }
  const loaded = await readPrivateFile(filePath, "CPB_HUB_OIDC_CONFIG_FILE");
  return parseConfig(loaded.raw, filePath, loaded.fingerprint);
}

function decodeBase64url(part: string) {
  if (!part || !/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("invalid JWT base64url segment");
  const buffer = Buffer.from(part, "base64url");
  if (buffer.length > MAX_JWT_PART_BYTES || buffer.toString("base64url") !== part) {
    throw new Error("invalid or oversized JWT base64url segment");
  }
  return buffer;
}

function parseJwt(token: string) {
  if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = record(parseStrictJson(utf8.decode(decodeBase64url(parts[0])), "JWT header"), "JWT header");
    const claims = record(parseStrictJson(utf8.decode(decodeBase64url(parts[1])), "JWT claims"), "JWT claims");
    const signature = decodeBase64url(parts[2]);
    return { header, claims, signature, signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, "ascii") };
  } catch {
    return null;
  }
}

function bearerToken(authorization: unknown) {
  if (typeof authorization !== "string") return "";
  return authorization.match(/^Bearer\s+([^\s]+)$/i)?.[1] || "";
}

function numericDate(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function validateClaims(claims: Record<string, unknown>, config: HubOidcConfig, nowMs: number) {
  if (claims.iss !== config.issuer) return null;
  const subject = typeof claims.sub === "string" && claims.sub.length > 0 && claims.sub.length <= 1024 ? claims.sub : null;
  const clientId = typeof claims.client_id === "string" && claims.client_id.length > 0 && claims.client_id.length <= 512 ? claims.client_id : null;
  const jti = typeof claims.jti === "string" && claims.jti.length > 0 && claims.jti.length <= 1024 ? claims.jti : null;
  if (!subject || !clientId || !jti) return null;

  const audiences = typeof claims.aud === "string"
    ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((entry) => typeof entry === "string") ? claims.aud as string[] : [];
  if (audiences.length === 0 || audiences.length > 16 || !config.audiences.some((audience) => audiences.includes(audience))) return null;

  const exp = numericDate(claims.exp);
  const iat = numericDate(claims.iat);
  const nbf = claims.nbf === undefined ? null : numericDate(claims.nbf);
  if (exp === null || iat === null || (claims.nbf !== undefined && nbf === null)) return null;
  const now = nowMs / 1000;
  const skew = config.clockSkewSeconds;
  if (now >= exp + skew || iat > now + skew || (nbf !== null && now + skew < nbf)) return null;
  if (exp <= iat || exp - iat > config.maxTokenAgeSeconds || now - iat > config.maxTokenAgeSeconds + skew) return null;
  try {
    const expiresAt = new Date(exp * 1000).toISOString();
    return { subject, expiresAt };
  } catch {
    return null;
  }
}

function mapGroups(claims: Record<string, unknown>, config: HubOidcConfig) {
  const value = claims[config.groupsClaim];
  if (value === undefined) return { scopes: [] as HubScope[], projects: [] as string[] };
  if (!Array.isArray(value) || value.length > 512 || !value.every((group) => typeof group === "string" && group.length > 0 && group.length <= 256)) {
    return null;
  }
  const scopes = new Set<HubScope>();
  const projects = new Set<string>();
  let allProjects = false;
  for (const group of value as string[]) {
    const grant = config.groupMappings.get(group);
    if (!grant) continue;
    for (const scope of grant.scopes) scopes.add(scope);
    if (grant.projects === "*") allProjects = true;
    else for (const project of grant.projects) projects.add(project);
  }
  return {
    scopes: SCOPE_ORDER.filter((scope) => scopes.has(scope)),
    projects: allProjects ? "*" as const : [...projects].sort(),
  };
}

function cacheSeconds(response: Response, configured: number) {
  const cacheControl = response.headers.get("cache-control") || "";
  if (/(?:^|,)\s*(?:no-store|no-cache)\b/i.test(cacheControl)) return 0;
  const match = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (!match) return configured;
  const advertised = Number(match[1]);
  if (!Number.isSafeInteger(advertised)) return configured;
  const ageHeader = response.headers.get("age");
  const age = ageHeader !== null && /^\d+$/.test(ageHeader) ? Number(ageHeader) : 0;
  return Math.max(0, Math.min(configured, advertised) - (Number.isSafeInteger(age) ? age : 0));
}

async function boundedResponseBody(response: Response) {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_JWKS_BYTES) throw new Error(`JWKS response exceeds ${MAX_JWKS_BYTES} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_JWKS_BYTES) throw new Error(`JWKS response exceeds ${MAX_JWKS_BYTES} bytes`);
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return utf8.decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total));
}

function importedKeyId(kid: string, algorithm: OidcAlgorithm) {
  return `${kid}\u0000${algorithm}`;
}

function importJwks(raw: string, config: HubOidcConfig) {
  const top = record(parseStrictJson(raw, "Hub OIDC JWKS"), "Hub OIDC JWKS");
  if (!Array.isArray(top.keys) || top.keys.length === 0 || top.keys.length > MAX_JWKS_KEYS) {
    throw new Error(`Hub OIDC JWKS must contain 1-${MAX_JWKS_KEYS} keys`);
  }
  const seenKids = new Set<string>();
  const imported = new Map<string, ImportedJwk>();
  for (let index = 0; index < top.keys.length; index += 1) {
    const jwk = record(top.keys[index], `Hub OIDC JWK ${index}`);
    if (["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((name) => Object.hasOwn(jwk, name))) {
      throw new Error("Hub OIDC JWKS must not contain private or symmetric key material");
    }
    const kid = jwk.kid === undefined ? null : typeof jwk.kid === "string" ? jwk.kid : "";
    if (kid !== null && (!kid || kid.length > 256 || /[\u0000-\u001f\u007f]/.test(kid))) {
      throw new Error("Hub OIDC signing keys must have bounded kid values");
    }
    if (kid !== null) {
      if (seenKids.has(kid)) throw new Error(`Hub OIDC JWKS contains duplicate kid: ${kid}`);
      seenKids.add(kid);
    }
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (jwk.key_ops !== undefined) {
      if (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify") || jwk.key_ops.some((operation) => operation !== "verify")) continue;
    }
    let algorithm: OidcAlgorithm | null = null;
    if (jwk.alg !== undefined) {
      if (typeof jwk.alg !== "string" || !config.algorithms.includes(jwk.alg as OidcAlgorithm)) continue;
      algorithm = jwk.alg as OidcAlgorithm;
    } else if (jwk.kty === "RSA" && config.algorithms.includes("RS256")) {
      algorithm = "RS256";
    } else if (jwk.kty === "EC" && jwk.crv === "P-256" && config.algorithms.includes("ES256")) {
      algorithm = "ES256";
    }
    if (!algorithm) continue;
    if ((algorithm === "RS256" && jwk.kty !== "RSA") || (algorithm === "ES256" && (jwk.kty !== "EC" || jwk.crv !== "P-256"))) {
      throw new Error(`Hub OIDC JWK ${kid || index} does not match ${algorithm}`);
    }
    let key: KeyObject;
    try {
      key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
    } catch (error) {
      throw new Error(`cannot import Hub OIDC JWK ${kid || index}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (algorithm === "RS256" && (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
      throw new Error(`Hub OIDC RSA key ${kid || index} is smaller than 2048 bits`);
    }
    if (algorithm === "ES256" && key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error(`Hub OIDC EC key ${kid || index} is not P-256`);
    }
    const mapKey = kid === null ? `anonymous:${index}\u0000${algorithm}` : importedKeyId(kid, algorithm);
    imported.set(mapKey, { kid, algorithm, key });
  }
  if (imported.size === 0) throw new Error("Hub OIDC JWKS contains no permitted signing keys");
  return imported;
}

function verifyJwtSignature(
  algorithm: OidcAlgorithm,
  signingInput: Buffer,
  key: KeyObject,
  signature: Buffer,
) {
  if (algorithm === "RS256") return verifySignature("RSA-SHA256", signingInput, key, signature);
  if (signature.length !== 64) return false;
  return verifySignature("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" }, signature);
}

export async function openHubOidcProvider(options: HubOidcOptions = {}): Promise<HubOidcProvider> {
  const initial = await loadOidcConfig(options);
  const configured = initial !== null;
  const now = options.now || Date.now;
  const fetcher = options.fetcher || fetch;
  let current = initial;
  let reloadCount = 0;
  let lastReloadAt = initial ? new Date(now()).toISOString() : null;
  let lastFailureAt: string | null = null;
  let configReloadInFlight: Promise<HubOidcConfig> | null = null;
  let jwks: JwksSnapshot | null = null;
  let jwksRefreshInFlight: { fingerprint: string; promise: Promise<JwksSnapshot> } | null = null;
  let lastForcedRefreshAt = Number.NEGATIVE_INFINITY;

  const resetJwks = () => {
    jwks = null;
    jwksRefreshInFlight = null;
    lastForcedRefreshAt = Number.NEGATIVE_INFINITY;
  };

  const getConfig = async () => {
    if (!current) return null;
    if (configReloadInFlight) return configReloadInFlight;
    let fingerprint: string;
    try {
      fingerprint = await inspectPrivateFile(current.sourceFile, "CPB_HUB_OIDC_CONFIG_FILE");
    } catch (error) {
      lastFailureAt = new Date(now()).toISOString();
      throw codedError("HUB_OIDC_CONFIGURATION_UNAVAILABLE", `Hub OIDC configuration reload failed: ${error instanceof Error ? error.message : String(error)}`, error);
    }
    if (configReloadInFlight) return configReloadInFlight;
    if (fingerprint === current.sourceFingerprint) return current;
    configReloadInFlight = (async () => {
      try {
        const loaded = await loadOidcConfig(options);
        if (!loaded || loaded.sourceFile !== current?.sourceFile) throw new Error("Hub OIDC configuration source changed during reload");
        current = loaded;
        reloadCount += 1;
        lastReloadAt = new Date(now()).toISOString();
        lastFailureAt = null;
        resetJwks();
        return loaded;
      } catch (error) {
        lastFailureAt = new Date(now()).toISOString();
        throw codedError("HUB_OIDC_CONFIGURATION_UNAVAILABLE", `Hub OIDC configuration reload failed: ${error instanceof Error ? error.message : String(error)}`, error);
      } finally {
        configReloadInFlight = null;
      }
    })();
    return configReloadInFlight;
  };

  const refreshJwks = async (config: HubOidcConfig) => {
    if (jwksRefreshInFlight?.fingerprint === config.sourceFingerprint) return jwksRefreshInFlight.promise;
    const promise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
      timeout.unref?.();
      let raceTimeout: NodeJS.Timeout | null = null;
      try {
        const headers: Record<string, string> = { accept: "application/jwk-set+json, application/json" };
        if (jwks?.configFingerprint === config.sourceFingerprint) {
          if (jwks.etag) headers["if-none-match"] = jwks.etag;
          if (jwks.lastModified) headers["if-modified-since"] = jwks.lastModified;
        }
        let response: Response;
        try {
          response = await Promise.race([
            fetcher(config.jwksUri, {
              method: "GET",
              headers,
              redirect: "error",
              signal: controller.signal,
              credentials: "omit",
            }),
            new Promise<never>((_, reject) => {
              raceTimeout = setTimeout(() => reject(new Error("Hub OIDC JWKS request timed out")), config.requestTimeoutMs);
              raceTimeout.unref?.();
            }),
          ]);
        } catch (error) {
          throw new Error(`cannot fetch Hub OIDC JWKS: ${error instanceof Error ? error.message : String(error)}`);
        }
        const fetchedAt = now();
        if (current?.sourceFingerprint !== config.sourceFingerprint) {
          throw codedError(
            "HUB_OIDC_CONFIGURATION_UNAVAILABLE",
            "Hub OIDC configuration changed while its JWKS was loading",
          );
        }
        if (response.status === 304 && jwks?.configFingerprint === config.sourceFingerprint) {
          const ttl = cacheSeconds(response, Math.min(config.jwksCacheSeconds, jwks.ttlSeconds));
          jwks = { ...jwks, fetchedAt, freshUntil: fetchedAt + ttl * 1000, ttlSeconds: ttl };
          lastFailureAt = null;
          return jwks;
        }
        if (!response.ok || response.redirected) throw new Error(`Hub OIDC JWKS returned HTTP ${response.status}`);
        const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
        if (contentType !== "application/json" && contentType !== "application/jwk-set+json") {
          throw new Error("Hub OIDC JWKS returned an unsupported content type");
        }
        const raw = await boundedResponseBody(response);
        const keys = importJwks(raw, config);
        const ttl = cacheSeconds(response, config.jwksCacheSeconds);
        if (current?.sourceFingerprint !== config.sourceFingerprint) {
          throw codedError(
            "HUB_OIDC_CONFIGURATION_UNAVAILABLE",
            "Hub OIDC configuration changed while its JWKS was being validated",
          );
        }
        jwks = {
          configFingerprint: config.sourceFingerprint,
          keys,
          fetchedAt,
          freshUntil: fetchedAt + ttl * 1000,
          ttlSeconds: ttl,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
        };
        lastFailureAt = null;
        return jwks;
      } catch (error) {
        if (current?.sourceFingerprint === config.sourceFingerprint) {
          lastFailureAt = new Date(now()).toISOString();
        }
        if (error && typeof error === "object" && "code" in error
          && (error as NodeJS.ErrnoException).code === "HUB_OIDC_CONFIGURATION_UNAVAILABLE") throw error;
        throw codedError("HUB_IDENTITY_PROVIDER_UNAVAILABLE", `Hub identity provider is unavailable: ${error instanceof Error ? error.message : String(error)}`, error);
      } finally {
        clearTimeout(timeout);
        if (raceTimeout) clearTimeout(raceTimeout);
      }
    })();
    const flight = { fingerprint: config.sourceFingerprint, promise };
    jwksRefreshInFlight = flight;
    try {
      return await promise;
    } finally {
      if (jwksRefreshInFlight === flight) jwksRefreshInFlight = null;
    }
  };

  const verificationKey = async (config: HubOidcConfig, kid: string | null, algorithm: OidcAlgorithm) => {
    const lookup = () => {
      if (jwks?.configFingerprint !== config.sourceFingerprint) return null;
      if (kid !== null) return jwks.keys.get(importedKeyId(kid, algorithm)) || null;
      const candidates = [...jwks.keys.values()].filter((candidate) => candidate.algorithm === algorithm);
      return candidates.length === 1 ? candidates[0] : null;
    };
    if (!jwks || jwks.configFingerprint !== config.sourceFingerprint || now() >= jwks.freshUntil) {
      await refreshJwks(config);
    }
    let key = lookup();
    if (key) return key;
    if (kid === null) return null;
    if (jwksRefreshInFlight?.fingerprint === config.sourceFingerprint) {
      await jwksRefreshInFlight.promise;
      return lookup();
    }
    if (now() - lastForcedRefreshAt < config.jwksRefreshMinSeconds * 1000) return null;
    lastForcedRefreshAt = now();
    await refreshJwks(config);
    key = lookup();
    return key;
  };

  const authenticate = async (authorization: unknown, knownConfig?: HubOidcConfig | null) => {
    const token = bearerToken(authorization);
    if (!token) return null;
    const config = knownConfig === undefined ? await getConfig() : knownConfig;
    if (!config) return null;
    const parsed = parseJwt(token);
    if (!parsed) return null;
    const { header, claims, signature, signingInput } = parsed;
    const typ = typeof header.typ === "string" ? header.typ.toLowerCase() : "";
    if (typ !== "at+jwt" && typ !== "application/at+jwt") return null;
    if (Object.hasOwn(header, "crit") || Object.hasOwn(header, "jku") || Object.hasOwn(header, "jwk")
      || Object.hasOwn(header, "x5u") || Object.hasOwn(header, "x5c") || Object.hasOwn(header, "b64")
      || Object.hasOwn(header, "cty")) return null;
    const algorithm = typeof header.alg === "string" && config.algorithms.includes(header.alg as OidcAlgorithm)
      ? header.alg as OidcAlgorithm
      : null;
    let kid: string | null = null;
    if (header.kid !== undefined) {
      if (typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 256
        || /[\u0000-\u001f\u007f]/.test(header.kid)) return null;
      kid = header.kid;
    }
    if (!algorithm) return null;
    const validated = validateClaims(claims, config, now());
    if (!validated) return null;
    const key = await verificationKey(config, kid, algorithm);
    if (!key) return null;
    try {
      if (!verifyJwtSignature(algorithm, signingInput, key.key, signature)) return null;
    } catch {
      return null;
    }
    if (current?.sourceFingerprint !== config.sourceFingerprint) {
      throw codedError("HUB_OIDC_CONFIGURATION_UNAVAILABLE", "Hub OIDC configuration changed while a token was being verified");
    }
    const authorizationMap = mapGroups(claims, config);
    if (!authorizationMap) return null;
    lastFailureAt = null;
    const id = `oidc:${createHash("sha256").update(config.issuer).update("\0").update(validated.subject).digest("hex").slice(0, 32)}`;
    return {
      id,
      scopes: authorizationMap.scopes,
      projects: authorizationMap.projects,
      source: "oidc",
      expiresAt: validated.expiresAt,
    } satisfies HubPrincipal;
  };

  return {
    configured,
    initial,
    getConfig,
    authenticate,
    preflight: async () => {
      const config = await getConfig();
      if (!config) return { keyCount: 0, freshUntil: null };
      if (!jwks || jwks.configFingerprint !== config.sourceFingerprint || now() >= jwks.freshUntil) {
        await refreshJwks(config);
      }
      return {
        keyCount: jwks?.keys.size || 0,
        freshUntil: jwks ? new Date(jwks.freshUntil).toISOString() : null,
      };
    },
    status: () => ({
      configured,
      sourceFile: current?.sourceFile || null,
      reloadCount,
      lastReloadAt,
      lastFailureAt,
      healthy: lastFailureAt === null,
      keyCount: jwks?.keys.size || 0,
      jwksFreshUntil: jwks ? new Date(jwks.freshUntil).toISOString() : null,
    }),
  };
}
