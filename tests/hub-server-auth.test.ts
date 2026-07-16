import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { startHubServer } from "../server/index.js";
import { buildChildEnv } from "../core/policy/child-env.js";
import { verifyHubAccessAudit } from "../server/services/audit/hub-access-audit.js";
import { buildHubControlPlaneEnv, buildHubServerEnv, saveRegistry } from "../server/services/hub/hub-registry.js";
import { tempRoot } from "./helpers.js";

function tokenDigest(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function writeServiceTokensFile(root: string, tokens: unknown[]) {
  const filePath = path.join(root, "service-tokens.json");
  await writeFile(filePath, `${JSON.stringify({
    format: "cpb-hub-service-tokens/v1",
    tokens,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

async function replaceServiceTokensFile(filePath: string, tokens: unknown[]) {
  const temporary = `${filePath}.next`;
  await writeFile(temporary, `${JSON.stringify({
    format: "cpb-hub-service-tokens/v1",
    tokens,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
}

function oidcSigningKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    publicJwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
    },
  };
}

function oidcJwt(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown>, typ = "at+jwt") {
  const header = Buffer.from(JSON.stringify({ typ, alg: "RS256", kid: key.kid }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input, "ascii"), key.privateKey).toString("base64url")}`;
}

function oidcClaims(nowSeconds: number, overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://identity.example.test/tenant",
    aud: "urn:codepatchbay:hub",
    sub: "enterprise-user-123",
    client_id: "cpb-cli",
    iat: nowSeconds - 10,
    exp: nowSeconds + 900,
    jti: `token-${nowSeconds}`,
    groups: ["cpb-readers"],
    ...overrides,
  };
}

async function writeOidcConfig(root: string) {
  const filePath = path.join(root, "hub-oidc.json");
  await writeFile(filePath, `${JSON.stringify({
    format: "cpb-hub-oidc/v1",
    profile: "rfc9068",
    issuer: "https://identity.example.test/tenant",
    audiences: ["urn:codepatchbay:hub"],
    jwksUri: "https://identity.example.test/tenant/keys",
    algorithms: ["RS256"],
    groupsClaim: "groups",
    groupMappings: {
      "cpb-readers": { scopes: ["hub:read"], projects: ["alpha"] },
    },
    clockSkewSeconds: 30,
    maxTokenAgeSeconds: 3600,
    jwksCacheSeconds: 300,
    jwksRefreshMinSeconds: 30,
    requestTimeoutMs: 1000,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

test("Hub refuses a non-loopback bind without a bearer token", async () => {
  const cpbRoot = await tempRoot("cpb-hub-auth-required");
  await assert.rejects(
    startHubServer({ cpbRoot, hubRoot: `${cpbRoot}/hub`, host: "0.0.0.0", port: 0 }),
    /authentication is required/,
  );
});

test("Hub refuses cleartext non-loopback HTTP without an explicit network opt-in", async () => {
  const cpbRoot = await tempRoot("cpb-hub-insecure-http-required");
  await assert.rejects(
    startHubServer({
      cpbRoot,
      hubRoot: `${cpbRoot}/hub`,
      host: "0.0.0.0",
      port: 0,
      bearerToken: "hub-test-token-with-at-least-32-bytes",
    }),
    /refuses cleartext HTTP on non-loopback hosts/,
  );
});

test("loopback Hub without credentials refuses to start by default", async () => {
  const cpbRoot = await tempRoot("cpb-hub-local-anonymous");
  await assert.rejects(
    startHubServer({ cpbRoot, hubRoot: `${cpbRoot}/hub`, host: "127.0.0.1", port: 0 }),
    /authentication is required/,
  );
});

test("loopback anonymous administrator requires explicit development opt-in", async () => {
  const cpbRoot = await tempRoot("cpb-hub-explicit-local-anonymous");
  const hub = await startHubServer({
    cpbRoot,
    hubRoot: `${cpbRoot}/hub`,
    host: "127.0.0.1",
    port: 0,
    allowAnonymousDev: true,
  });
  try {
    const whoami = await fetch(`${hub.url}/api/auth/whoami`);
    assert.equal(whoami.status, 200);
    assert.deepEqual(await whoami.json(), {
      id: "local-anonymous",
      scopes: ["hub:admin"],
      projects: "*",
      source: "local-anonymous",
      expiresAt: null,
    });
  } finally {
    await hub.close();
  }
});

test("configured Hub bearer token protects every endpoint", async () => {
  const cpbRoot = await tempRoot("cpb-hub-auth-endpoints");
  const token = "hub-test-token-with-at-least-32-bytes";
  const hub = await startHubServer({
    cpbRoot,
    hubRoot: `${cpbRoot}/hub`,
    host: "127.0.0.1",
    port: 0,
    bearerToken: token,
  });
  try {
    const unauthorizedHealth = await fetch(`${hub.url}/api/health`);
    const unauthorizedProjects = await fetch(`${hub.url}/api/projects`);
    assert.equal(unauthorizedHealth.status, 401);
    assert.equal(unauthorizedProjects.status, 401);
    assert.equal(unauthorizedHealth.headers.get("www-authenticate"), 'Bearer realm="CodePatchBay Hub"');
    assert.deepEqual(await unauthorizedHealth.json(), {
      error: "unauthorized",
      code: "HUB_AUTHENTICATION_REQUIRED",
      message: "A valid Hub bearer token is required",
    });

    const authorizedHealth = await fetch(`${hub.url}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(authorizedHealth.status, 200);
    assert.equal((await authorizedHealth.json()).ok, true);
  } finally {
    await hub.close();
  }
});

test("Hub service tokens enforce scopes, expose identity, and filter projects", async () => {
  const cpbRoot = await tempRoot("cpb-hub-service-token-server");
  const hubRoot = path.join(cpbRoot, "hub");
  const alphaSource = path.join(cpbRoot, "alpha-source");
  const betaSource = path.join(cpbRoot, "beta-source");
  await mkdir(alphaSource, { recursive: true });
  await mkdir(betaSource, { recursive: true });
  await saveRegistry(hubRoot, {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {
      alpha: {
        id: "alpha",
        name: "alpha",
        sourcePath: alphaSource,
        projectRuntimeRoot: path.join(hubRoot, "projects", "alpha"),
        enabled: true,
      },
      beta: {
        id: "beta",
        name: "beta",
        sourcePath: betaSource,
        projectRuntimeRoot: path.join(hubRoot, "projects", "beta"),
        enabled: true,
      },
    },
  });
  const readerToken = "alpha-reader-token-with-at-least-32-bytes";
  const healthToken = "health-only-token-with-at-least-32-bytes";
  const serviceTokensFile = await writeServiceTokensFile(cpbRoot, [
    {
      id: "alpha-reader",
      tokenSha256: tokenDigest(readerToken),
      scopes: ["hub:read"],
      projects: ["alpha"],
    },
    {
      id: "health-monitor",
      tokenSha256: tokenDigest(healthToken),
      scopes: ["hub:health"],
      projects: "*",
    },
  ]);
  const hub = await startHubServer({
    cpbRoot,
    hubRoot,
    host: "127.0.0.1",
    port: 0,
    serviceTokensFile,
  });
  try {
    const health = await fetch(`${hub.url}/api/health`, {
      headers: { Authorization: `Bearer ${healthToken}` },
    });
    assert.equal(health.status, 200);

    const forbidden = await fetch(`${hub.url}/api/projects`, {
      headers: { Authorization: `Bearer ${healthToken}` },
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), {
      error: "forbidden",
      code: "HUB_SCOPE_REQUIRED",
      message: "Hub scope 'hub:read' is required",
      requiredScope: "hub:read",
    });

    const whoami = await fetch(`${hub.url}/api/auth/whoami`, {
      headers: { Authorization: `Bearer ${readerToken}` },
    });
    assert.equal(whoami.status, 200);
    assert.equal(whoami.headers.get("x-cpb-principal-id"), "alpha-reader");
    assert.deepEqual(await whoami.json(), {
      id: "alpha-reader",
      scopes: ["hub:read"],
      projects: ["alpha"],
      source: "service-token-file",
      expiresAt: null,
    });

    const projects = await fetch(`${hub.url}/api/projects?sensitive=must-not-persist`, {
      headers: { Authorization: `Bearer ${readerToken}` },
    });
    assert.equal(projects.status, 200);
    assert.deepEqual((await projects.json()).map((project: { id: string }) => project.id), ["alpha"]);
  } finally {
    await hub.close();
  }
  const audit = await verifyHubAccessAudit({ hubRoot });
  const auditText = await readFile(audit.filePath, "utf8");
  const records = auditText.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(audit.recordCount, 4);
  assert.deepEqual(records.map((record) => record.outcome), [
    "allowed",
    "authorization_denied",
    "allowed",
    "allowed",
  ]);
  assert.deepEqual(records.map((record) => record.principalId), [
    "health-monitor",
    "health-monitor",
    "alpha-reader",
    "alpha-reader",
  ]);
  assert.doesNotMatch(auditText, /must-not-persist/);
});

test("service-token file satisfies the non-loopback credential requirement", async () => {
  const cpbRoot = await tempRoot("cpb-hub-service-token-non-loopback");
  const token = "non-loopback-service-token-with-at-least-32-bytes";
  const serviceTokensFile = await writeServiceTokensFile(cpbRoot, [{
    id: "remote-reader",
    tokenSha256: tokenDigest(token),
    scopes: ["hub:read"],
    projects: "*",
  }]);
  const hub = await startHubServer({
    cpbRoot,
    hubRoot: path.join(cpbRoot, "hub"),
    host: "0.0.0.0",
    port: 0,
    serviceTokensFile,
    allowInsecureHttp: true,
  });
  await hub.close();
});

test("Hub hot-reloads service-token rotation and fails closed while replacement config is invalid", async () => {
  const cpbRoot = await tempRoot("cpb-hub-service-token-hot-reload");
  const hubRoot = path.join(cpbRoot, "hub");
  const firstToken = "first-hot-reload-token-with-at-least-32-bytes";
  const secondToken = "second-hot-reload-token-with-at-least-32-bytes";
  const secondEntry = {
    id: "second-reader",
    tokenSha256: tokenDigest(secondToken),
    scopes: ["hub:health"],
    projects: "*",
  };
  const serviceTokensFile = await writeServiceTokensFile(cpbRoot, [{
    id: "first-reader",
    tokenSha256: tokenDigest(firstToken),
    scopes: ["hub:health"],
    projects: "*",
  }]);
  const hub = await startHubServer({
    cpbRoot,
    hubRoot,
    host: "127.0.0.1",
    port: 0,
    serviceTokensFile,
  });
  try {
    const first = await fetch(`${hub.url}/api/health`, {
      headers: { Authorization: `Bearer ${firstToken}` },
    });
    assert.equal(first.status, 200);

    await replaceServiceTokensFile(serviceTokensFile, [secondEntry]);
    const revoked = await fetch(`${hub.url}/api/health`, {
      headers: { Authorization: `Bearer ${firstToken}` },
    });
    assert.equal(revoked.status, 401);
    const rotated = await fetch(`${hub.url}/api/health`, {
      headers: { Authorization: `Bearer ${secondToken}` },
    });
    assert.equal(rotated.status, 200);

    const invalid = `${serviceTokensFile}.next`;
    await writeFile(invalid, "{invalid-json\n", { mode: 0o600 });
    await rename(invalid, serviceTokensFile);
    const unavailable = await fetch(`${hub.url}/api/health`, {
      headers: { Authorization: `Bearer ${secondToken}` },
    });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("retry-after"), "5");
    assert.ok(unavailable.headers.get("x-cpb-request-id"));
    const unavailablePayload = await unavailable.json();
    assert.equal(unavailablePayload.code, "HUB_AUTH_CONFIGURATION_UNAVAILABLE");
    assert.equal(unavailablePayload.requestId, unavailable.headers.get("x-cpb-request-id"));

    await replaceServiceTokensFile(serviceTokensFile, [secondEntry]);
    const recovered = await fetch(`${hub.url}/api/health`, {
      headers: { Authorization: `Bearer ${secondToken}` },
    });
    assert.equal(recovered.status, 200);
  } finally {
    await hub.close();
  }

  const audit = await verifyHubAccessAudit({ hubRoot });
  const records = (await readFile(audit.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.outcome), [
    "allowed",
    "authentication_denied",
    "allowed",
    "error",
    "allowed",
  ]);
  assert.equal(records[3].errorCode, "HUB_AUTH_CONFIGURATION_UNAVAILABLE");
  assert.equal(records[3].principalId, null);
});

test("Hub validates OIDC access tokens, enforces mapped authorization, and audits IdP outages", async () => {
  const cpbRoot = await tempRoot("cpb-hub-oidc-server");
  const hubRoot = path.join(cpbRoot, "hub");
  const alphaSource = path.join(cpbRoot, "alpha-source");
  const betaSource = path.join(cpbRoot, "beta-source");
  await mkdir(alphaSource, { recursive: true });
  await mkdir(betaSource, { recursive: true });
  await saveRegistry(hubRoot, {
    version: 1,
    updatedAt: new Date().toISOString(),
    projects: {
      alpha: { id: "alpha", name: "alpha", sourcePath: alphaSource, projectRuntimeRoot: path.join(hubRoot, "projects", "alpha"), enabled: true },
      beta: { id: "beta", name: "beta", sourcePath: betaSource, projectRuntimeRoot: path.join(hubRoot, "projects", "beta"), enabled: true },
    },
  });
  const key = oidcSigningKey("key-a");
  const oidcConfigFile = await writeOidcConfig(cpbRoot);
  let nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  let failIdentityProvider = false;
  let fetchCount = 0;
  const hub = await startHubServer({
    cpbRoot,
    hubRoot,
    host: "127.0.0.1",
    port: 0,
    oidcConfigFile,
    oidcNow: () => nowMs,
    oidcFetcher: async () => {
      fetchCount += 1;
      if (failIdentityProvider) throw new Error("simulated identity provider outage");
      return new Response(JSON.stringify({ keys: [key.publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const readerToken = oidcJwt(key, oidcClaims(nowMs / 1000));
  const unmappedToken = oidcJwt(key, oidcClaims(nowMs / 1000, { jti: "unmapped", groups: ["unmapped"] }));
  const idToken = oidcJwt(key, oidcClaims(nowMs / 1000, { jti: "id-token" }), "JWT");
  try {
    const anonymous = await fetch(`${hub.url}/api/health`);
    assert.equal(anonymous.status, 401, "OIDC-only loopback deployments must not retain anonymous admin access");

    const projects = await fetch(`${hub.url}/api/projects`, { headers: { Authorization: `Bearer ${readerToken}` } });
    assert.equal(projects.status, 200);
    assert.deepEqual((await projects.json()).map((project: { id: string }) => project.id), ["alpha"]);
    assert.match(projects.headers.get("x-cpb-principal-id") || "", /^oidc:[a-f0-9]{32}$/);

    const forbidden = await fetch(`${hub.url}/api/projects`, { headers: { Authorization: `Bearer ${unmappedToken}` } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get("www-authenticate"), 'Bearer realm="CodePatchBay Hub", error="insufficient_scope", scope="hub:read"');
    assert.equal((await forbidden.json()).code, "HUB_SCOPE_REQUIRED");

    const substituted = await fetch(`${hub.url}/api/health`, { headers: { Authorization: `Bearer ${idToken}` } });
    assert.equal(substituted.status, 401, "OIDC ID tokens must not be accepted as API access tokens");
    assert.equal(substituted.headers.get("www-authenticate"), 'Bearer realm="CodePatchBay Hub", error="invalid_token"');

    nowMs += 301_000;
    failIdentityProvider = true;
    const unavailable = await fetch(`${hub.url}/api/health`, { headers: { Authorization: `Bearer ${readerToken}` } });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("retry-after"), "5");
    assert.equal((await unavailable.json()).code, "HUB_IDENTITY_PROVIDER_UNAVAILABLE");
    assert.equal(fetchCount, 2);
  } finally {
    await hub.close();
  }

  const audit = await verifyHubAccessAudit({ hubRoot });
  const records = (await readFile(audit.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.outcome), [
    "authentication_denied",
    "allowed",
    "authorization_denied",
    "authentication_denied",
    "error",
  ]);
  assert.equal(records[1].principalSource, "oidc");
  assert.equal(records[4].errorCode, "HUB_IDENTITY_PROVIDER_UNAVAILABLE");
  assert.doesNotMatch(await readFile(audit.filePath, "utf8"), /enterprise-user-123|simulated identity provider outage/);
});

test("OIDC-only configuration satisfies the non-loopback credential requirement", async () => {
  const cpbRoot = await tempRoot("cpb-hub-oidc-non-loopback");
  const oidcConfigFile = await writeOidcConfig(cpbRoot);
  const hub = await startHubServer({
    cpbRoot,
    hubRoot: path.join(cpbRoot, "hub"),
    host: "0.0.0.0",
    port: 0,
    allowInsecureHttp: true,
    oidcConfigFile,
    oidcFetcher: async () => {
      throw new Error("JWKS should not be fetched during startup");
    },
  });
  await hub.close();
});

test("local break-glass service tokens remain usable during an OIDC JWKS outage", async () => {
  const cpbRoot = await tempRoot("cpb-hub-oidc-break-glass");
  const localToken = "break-glass-service-token-with-at-least-32-bytes";
  const serviceTokensFile = await writeServiceTokensFile(cpbRoot, [{
    id: "break-glass",
    tokenSha256: tokenDigest(localToken),
    scopes: ["hub:admin"],
    projects: "*",
  }]);
  const oidcConfigFile = await writeOidcConfig(cpbRoot);
  const key = oidcSigningKey("key-a");
  const nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  const hub = await startHubServer({
    cpbRoot,
    hubRoot: path.join(cpbRoot, "hub"),
    host: "127.0.0.1",
    port: 0,
    serviceTokensFile,
    oidcConfigFile,
    oidcNow: () => nowMs,
    oidcFetcher: async () => {
      throw new Error("simulated identity provider outage");
    },
  });
  try {
    const local = await fetch(`${hub.url}/api/health`, { headers: { Authorization: `Bearer ${localToken}` } });
    assert.equal(local.status, 200);

    const oidc = await fetch(`${hub.url}/api/health`, {
      headers: { Authorization: `Bearer ${oidcJwt(key, oidcClaims(nowMs / 1000))}` },
    });
    assert.equal(oidc.status, 503);
    assert.equal((await oidc.json()).code, "HUB_IDENTITY_PROVIDER_UNAVAILABLE");

    await writeFile(`${oidcConfigFile}.next`, "{invalid-json\n", { mode: 0o600 });
    await rename(`${oidcConfigFile}.next`, oidcConfigFile);
    const localDuringInvalidPolicy = await fetch(`${hub.url}/api/health`, {
      headers: { Authorization: `Bearer ${localToken}` },
    });
    assert.equal(localDuringInvalidPolicy.status, 200);
    const oidcDuringInvalidPolicy = await fetch(`${hub.url}/api/health`, {
      headers: { Authorization: `Bearer ${oidcJwt(key, oidcClaims(nowMs / 1000, { jti: "invalid-policy" }))}` },
    });
    assert.equal(oidcDuringInvalidPolicy.status, 503);
    assert.equal((await oidcDuringInvalidPolicy.json()).code, "HUB_OIDC_CONFIGURATION_UNAVAILABLE");
  } finally {
    await hub.close();
  }
});

test("Hub fails requests closed when the durable access-audit capacity is exhausted", async () => {
  const cpbRoot = await tempRoot("cpb-hub-access-audit-full");
  const token = "audit-capacity-token-with-at-least-32-bytes";
  const hub = await startHubServer({
    cpbRoot,
    hubRoot: path.join(cpbRoot, "hub"),
    host: "127.0.0.1",
    port: 0,
    bearerToken: token,
    accessAuditMaxBytes: 64 * 1024,
  });
  let unavailable: Response | null = null;
  try {
    for (let index = 0; index < 100; index += 1) {
      const response = await fetch(`${hub.url}/${"x".repeat(4000)}-${index}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.status === 503) {
        unavailable = response;
        break;
      }
    }
    assert.ok(unavailable, "expected access-audit capacity to fail closed");
    assert.ok(unavailable.headers.get("x-cpb-request-id"));
    assert.equal(unavailable.headers.get("retry-after"), "5");
    assert.equal((await unavailable.json()).code, "HUB_ACCESS_AUDIT_UNAVAILABLE");
  } finally {
    await hub.close();
  }
});

test("Hub rejects weak configured bearer tokens", async () => {
  const cpbRoot = await tempRoot("cpb-hub-auth-weak-token");
  await assert.rejects(
    startHubServer({ cpbRoot, host: "127.0.0.1", port: 0, bearerToken: "short" }),
    /at least 32 non-whitespace bytes/,
  );
});

test("Hub child environment receives only explicitly scoped authentication configuration", () => {
  const token = "hub-child-token-with-at-least-32-bytes";
  const serviceTokensFile = "/secure/cpb/hub-service-tokens.json";
  const oidcConfigFile = "/secure/cpb/hub-oidc.json";
  const stateRedisConfigFile = "/secure/cpb/hub-state-redis.json";
  const env = buildHubServerEnv({
    PATH: process.env.PATH,
    CPB_HUB_BEARER_TOKEN: token,
    CPB_HUB_SERVICE_TOKENS_FILE: serviceTokensFile,
    CPB_HUB_OIDC_CONFIG_FILE: oidcConfigFile,
    CPB_HUB_STATE_REDIS_CONFIG_FILE: stateRedisConfigFile,
    CPB_HUB_ACCESS_AUDIT_MAX_BYTES: "536870912",
    CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY: "must-not-leak-to-long-running-hub-child",
    CPB_HUB_ALLOW_INSECURE_HTTP: "1",
    UNRELATED_APPLICATION_SECRET: "must-not-leak",
  }, {
    cpbRoot: "/tmp/cpb",
    executorRoot: "/tmp/cpb",
    hubRoot: "/tmp/cpb-hub",
    host: "0.0.0.0",
    port: "3456",
  });

  assert.equal(env.CPB_HUB_BEARER_TOKEN, token);
  assert.equal(env.CPB_HUB_SERVICE_TOKENS_FILE, serviceTokensFile);
  assert.equal(env.CPB_HUB_OIDC_CONFIG_FILE, oidcConfigFile);
  assert.equal(env.CPB_HUB_STATE_REDIS_CONFIG_FILE, stateRedisConfigFile);
  assert.equal(env.CPB_HUB_ACCESS_AUDIT_MAX_BYTES, "536870912");
  assert.equal(env.CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY, undefined);
  assert.equal(env.CPB_HUB_ALLOW_INSECURE_HTTP, "1");
  assert.equal(env.UNRELATED_APPLICATION_SECRET, undefined);

  const controlPlaneEnv = buildHubControlPlaneEnv({
    PATH: process.env.PATH,
    CPB_HUB_STATE_REDIS_CONFIG_FILE: stateRedisConfigFile,
    CPB_HUB_BEARER_TOKEN: token,
    UNRELATED_APPLICATION_SECRET: "must-not-leak",
  }, {
    cpbRoot: "/tmp/cpb",
    executorRoot: "/tmp/cpb",
    hubRoot: "/tmp/cpb-hub",
  });
  assert.equal(controlPlaneEnv.CPB_HUB_STATE_REDIS_CONFIG_FILE, stateRedisConfigFile);
  assert.equal(controlPlaneEnv.CPB_HUB_BEARER_TOKEN, undefined);
  assert.equal(controlPlaneEnv.UNRELATED_APPLICATION_SECRET, undefined);

  const agentEnv = buildChildEnv({
    PATH: process.env.PATH,
    CPB_HUB_STATE_REDIS_CONFIG_FILE: stateRedisConfigFile,
  });
  assert.equal(agentEnv.CPB_HUB_STATE_REDIS_CONFIG_FILE, undefined);
});
