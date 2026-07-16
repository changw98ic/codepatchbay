import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmod, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { openHubOidcProvider } from "../shared/hub-oidc.js";
import { tempRoot } from "./helpers.js";

type SigningKey = {
  algorithm: "RS256" | "ES256";
  kid: string;
  privateKey: KeyObject;
  publicJwk: JsonWebKey & { kid: string; alg: string; use: string; key_ops: string[] };
};

function rsaSigningKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    algorithm: "RS256",
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

function ecSigningKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    algorithm: "ES256",
    kid,
    privateKey,
    publicJwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      alg: "ES256",
      use: "sig",
      key_ops: ["verify"],
    },
  };
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function jwt(key: SigningKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const encodedHeader = base64urlJson({ typ: "at+jwt", alg: key.algorithm, kid: key.kid, ...header });
  const encodedClaims = base64urlJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = key.algorithm === "RS256"
    ? sign("RSA-SHA256", Buffer.from(signingInput, "ascii"), key.privateKey)
    : sign("sha256", Buffer.from(signingInput, "ascii"), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function accessTokenClaims(nowSeconds: number, overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://identity.example.test/tenant",
    aud: "urn:codepatchbay:hub",
    sub: "user-123",
    client_id: "cpb-cli",
    iat: nowSeconds - 10,
    exp: nowSeconds + 300,
    jti: `token-${nowSeconds}`,
    groups: ["cpb-readers", "cpb-health"],
    ...overrides,
  };
}

function oidcConfig(groupMappings: Record<string, unknown> = {
  "cpb-readers": { scopes: ["hub:read"], projects: ["alpha", "beta"] },
  "cpb-health": { scopes: ["hub:health"], projects: ["alpha"] },
}) {
  return {
    format: "cpb-hub-oidc/v1",
    profile: "rfc9068",
    issuer: "https://identity.example.test/tenant",
    audiences: ["urn:codepatchbay:hub"],
    jwksUri: "https://identity.example.test/tenant/keys",
    algorithms: ["RS256"],
    groupsClaim: "groups",
    groupMappings,
    clockSkewSeconds: 30,
    maxTokenAgeSeconds: 3600,
    jwksCacheSeconds: 300,
    jwksRefreshMinSeconds: 30,
    requestTimeoutMs: 1000,
  };
}

async function writeOidcConfig(root: string, config: unknown = oidcConfig()) {
  const filePath = path.join(root, "hub-oidc.json");
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

async function replaceOidcConfig(filePath: string, config: unknown) {
  const next = `${filePath}.next`;
  await writeFile(next, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(next, 0o600);
  await rename(next, filePath);
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("OIDC provider validates RFC 9068 access tokens and maps trusted groups without leaking subjects", async () => {
  const root = await tempRoot("cpb-hub-oidc-valid");
  const key = rsaSigningKey("key-a");
  const configFile = await writeOidcConfig(root);
  let nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  let fetchCount = 0;
  const provider = await openHubOidcProvider({
    configFile,
    now: () => nowMs,
    fetcher: async () => {
      fetchCount += 1;
      return jsonResponse({ keys: [key.publicJwk] });
    },
  });
  const token = jwt(key, accessTokenClaims(nowMs / 1000));

  const principals = await Promise.all(Array.from({ length: 32 }, () => provider.authenticate(`Bearer ${token}`)));
  assert.equal(fetchCount, 1);
  assert.ok(principals.every((principal) => principal?.id === principals[0]?.id));
  assert.match(principals[0]?.id || "", /^oidc:[a-f0-9]{32}$/);
  assert.deepEqual(principals[0], {
    id: principals[0]?.id,
    scopes: ["hub:health", "hub:read"],
    projects: ["alpha", "beta"],
    source: "oidc",
    expiresAt: "2026-07-11T00:05:00.000Z",
  });
  assert.doesNotMatch(JSON.stringify(principals[0]), /user-123|identity\.example/);

  nowMs += 1000;
  const unmapped = await provider.authenticate(`Bearer ${jwt(key, accessTokenClaims(nowMs / 1000, {
    jti: "unmapped-token",
    groups: ["unmapped-group"],
  }))}`);
  assert.deepEqual(unmapped?.scopes, []);
  assert.deepEqual(unmapped?.projects, []);
});

test("OIDC provider rejects JWT substitution, claim, algorithm, and signature failures as invalid credentials", async () => {
  const root = await tempRoot("cpb-hub-oidc-invalid-token");
  const key = rsaSigningKey("key-a");
  const otherKey = rsaSigningKey("key-b");
  const configFile = await writeOidcConfig(root);
  const nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  const provider = await openHubOidcProvider({
    configFile,
    now: () => nowMs,
    fetcher: async () => jsonResponse({ keys: [key.publicJwk] }),
  });
  const valid = accessTokenClaims(nowMs / 1000);
  const duplicateHeader = Buffer.from('{"typ":"at+jwt","alg":"RS256","alg":"none","kid":"key-a"}', "utf8").toString("base64url");
  const duplicatePayload = base64urlJson(valid);
  const duplicateInput = `${duplicateHeader}.${duplicatePayload}`;
  const duplicateMemberToken = `${duplicateInput}.${sign("RSA-SHA256", Buffer.from(duplicateInput, "ascii"), key.privateKey).toString("base64url")}`;
  const invalidTokens = [
    jwt(key, valid, { typ: "JWT" }),
    jwt(key, valid, { alg: "none" }),
    jwt(key, { ...valid, iss: "https://identity.example.test/tenant/" }),
    jwt(key, { ...valid, aud: "another-api" }),
    jwt(key, { ...valid, exp: nowMs / 1000 - 31 }),
    jwt(key, { ...valid, nbf: nowMs / 1000 + 31 }),
    jwt(key, { ...valid, iat: nowMs / 1000 + 31 }),
    jwt(key, { ...valid, jti: undefined }),
    jwt(otherKey, valid, { kid: key.kid }),
    duplicateMemberToken,
    "not-a-jwt",
  ];

  for (const token of invalidTokens) {
    assert.equal(await provider.authenticate(`Bearer ${token}`), null);
  }
  assert.equal(await provider.authenticate("Basic abc"), null);
});

test("OIDC provider verifies ES256 only with P-256 JOSE signatures", async () => {
  const root = await tempRoot("cpb-hub-oidc-es256");
  const key = ecSigningKey("ec-key");
  const configFile = await writeOidcConfig(root, { ...oidcConfig(), algorithms: ["ES256"] });
  const nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  const provider = await openHubOidcProvider({
    configFile,
    now: () => nowMs,
    fetcher: async () => jsonResponse({ keys: [key.publicJwk] }),
  });
  const claims = accessTokenClaims(nowMs / 1000);
  assert.ok(await provider.authenticate(`Bearer ${jwt(key, claims)}`));

  const header = base64urlJson({ typ: "at+jwt", alg: "ES256", kid: key.kid });
  const payload = base64urlJson({ ...claims, jti: "der-signature" });
  const input = `${header}.${payload}`;
  const derSignature = sign("sha256", Buffer.from(input, "ascii"), key.privateKey).toString("base64url");
  assert.equal(await provider.authenticate(`Bearer ${input}.${derSignature}`), null);
});

test("OIDC provider accepts an unambiguous single signing key without kid and rejects ambiguous sets", async () => {
  const root = await tempRoot("cpb-hub-oidc-no-kid");
  const keyA = rsaSigningKey("key-a");
  const keyB = rsaSigningKey("key-b");
  const { kid: ignoredA, ...jwkA } = keyA.publicJwk;
  const { kid: ignoredB, ...jwkB } = keyB.publicJwk;
  assert.ok(ignoredA && ignoredB);
  const configFile = await writeOidcConfig(root);
  const nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  const token = jwt(keyA, accessTokenClaims(nowMs / 1000), { kid: undefined });
  const single = await openHubOidcProvider({
    configFile,
    now: () => nowMs,
    fetcher: async () => jsonResponse({ keys: [jwkA] }),
  });
  assert.ok(await single.authenticate(`Bearer ${token}`));

  const ambiguous = await openHubOidcProvider({
    configFile,
    now: () => nowMs,
    fetcher: async () => jsonResponse({ keys: [jwkA, jwkB] }),
  });
  assert.equal(await ambiguous.authenticate(`Bearer ${token}`), null);
});

test("OIDC JWKS freshness subtracts intermediary Age from advertised max-age", async () => {
  const root = await tempRoot("cpb-hub-oidc-cache-age");
  const key = rsaSigningKey("key-a");
  const configFile = await writeOidcConfig(root);
  let nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  let fetchCount = 0;
  const provider = await openHubOidcProvider({
    configFile,
    now: () => nowMs,
    fetcher: async () => {
      fetchCount += 1;
      return jsonResponse({ keys: [key.publicJwk] }, { "cache-control": "max-age=300", age: "299" });
    },
  });
  const token = jwt(key, accessTokenClaims(nowMs / 1000));
  assert.ok(await provider.authenticate(`Bearer ${token}`));
  assert.equal(fetchCount, 1);
  nowMs += 2000;
  assert.ok(await provider.authenticate(`Bearer ${token}`));
  assert.equal(fetchCount, 2);
});

test("OIDC JWKS cache singleflights rotation, rate-limits unknown kid refresh, and fails closed when no fresh keys exist", async () => {
  const root = await tempRoot("cpb-hub-oidc-rotation");
  const keyA = rsaSigningKey("key-a");
  const keyB = rsaSigningKey("key-b");
  const configFile = await writeOidcConfig(root);
  let nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  let keys = [keyA.publicJwk];
  let fetchCount = 0;
  let failFetch = false;
  const provider = await openHubOidcProvider({
    configFile,
    now: () => nowMs,
    fetcher: async () => {
      fetchCount += 1;
      if (failFetch) throw new Error("identity provider unavailable");
      return jsonResponse({ keys });
    },
  });

  assert.ok(await provider.authenticate(`Bearer ${jwt(keyA, accessTokenClaims(nowMs / 1000))}`));
  assert.equal(fetchCount, 1);

  nowMs += 31_000;
  keys = [keyA.publicJwk, keyB.publicJwk];
  const rotatedToken = jwt(keyB, accessTokenClaims(nowMs / 1000, { jti: "rotated" }));
  const rotated = await Promise.all(Array.from({ length: 32 }, () => provider.authenticate(`Bearer ${rotatedToken}`)));
  assert.ok(rotated.every(Boolean));
  assert.equal(fetchCount, 2);

  const randomKid = jwt({ ...keyB, kid: "random-kid" }, accessTokenClaims(nowMs / 1000, { jti: "random" }));
  assert.equal(await provider.authenticate(`Bearer ${randomKid}`), null);
  assert.equal(fetchCount, 2, "unknown kid refresh must respect the cooldown");

  failFetch = true;
  assert.ok(await provider.authenticate(`Bearer ${rotatedToken}`), "fresh cached keys remain usable");
  nowMs += 301_000;
  await assert.rejects(
    provider.authenticate(`Bearer ${rotatedToken}`),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_IDENTITY_PROVIDER_UNAVAILABLE");
      return true;
    },
  );
});

test("OIDC authorization policy hot-reloads atomically and fails closed until an invalid replacement is repaired", async () => {
  const root = await tempRoot("cpb-hub-oidc-policy-reload");
  const key = rsaSigningKey("key-a");
  const configFile = await writeOidcConfig(root, oidcConfig({
    "cpb-readers": { scopes: ["hub:read"], projects: ["alpha"] },
  }));
  const nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  let fetchCount = 0;
  const provider = await openHubOidcProvider({
    configFile,
    now: () => nowMs,
    fetcher: async () => {
      fetchCount += 1;
      return jsonResponse({ keys: [key.publicJwk] });
    },
  });
  const token = jwt(key, accessTokenClaims(nowMs / 1000, { groups: ["cpb-readers"] }));
  assert.deepEqual((await provider.authenticate(`Bearer ${token}`))?.scopes, ["hub:read"]);

  await replaceOidcConfig(configFile, oidcConfig({
    "cpb-readers": { scopes: ["hub:admin"], projects: "*" },
  }));
  const elevated = await provider.authenticate(`Bearer ${token}`);
  assert.deepEqual(elevated?.scopes, ["hub:admin"]);
  assert.equal(elevated?.projects, "*");
  assert.equal(provider.status().reloadCount, 1);
  assert.equal(fetchCount, 2, "policy reload must discard keys bound to the previous snapshot");

  await writeFile(`${configFile}.next`, "{invalid-json\n", { mode: 0o600 });
  await rename(`${configFile}.next`, configFile);
  await assert.rejects(
    provider.authenticate(`Bearer ${token}`),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_OIDC_CONFIGURATION_UNAVAILABLE");
      return true;
    },
  );

  await replaceOidcConfig(configFile, oidcConfig({
    "cpb-readers": { scopes: ["hub:read"], projects: ["beta"] },
  }));
  const repaired = await provider.authenticate(`Bearer ${token}`);
  assert.deepEqual(repaired?.projects, ["beta"]);
  assert.equal(provider.status().reloadCount, 2);
});

test("an in-flight JWKS response cannot overwrite or authorize against a newer OIDC policy snapshot", async () => {
  const root = await tempRoot("cpb-hub-oidc-policy-race");
  const keyA = rsaSigningKey("key-a");
  const keyB = rsaSigningKey("key-b");
  const configFile = await writeOidcConfig(root, oidcConfig({
    "cpb-readers": { scopes: ["hub:read"], projects: ["alpha"] },
  }));
  const nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  let releaseFirstFetch: (() => void) | null = null;
  let markFirstFetchStarted: (() => void) | null = null;
  const firstFetchStarted = new Promise<void>((resolve) => { markFirstFetchStarted = resolve; });
  const firstFetchReleased = new Promise<void>((resolve) => { releaseFirstFetch = resolve; });
  let fetchCount = 0;
  const provider = await openHubOidcProvider({
    configFile,
    now: () => nowMs,
    fetcher: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        let sent = false;
        return new Response(new ReadableStream({
          pull: async (controller) => {
            if (sent) return;
            sent = true;
            markFirstFetchStarted?.();
            await firstFetchReleased;
            controller.enqueue(Buffer.from(JSON.stringify({ keys: [keyA.publicJwk] }), "utf8"));
            controller.close();
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse({ keys: [keyB.publicJwk] });
    },
  });
  const oldRequest = provider.authenticate(`Bearer ${jwt(keyA, accessTokenClaims(nowMs / 1000, { jti: "old" }))}`);
  await firstFetchStarted;

  await replaceOidcConfig(configFile, oidcConfig({
    "cpb-readers": { scopes: ["hub:read"], projects: ["beta"] },
  }));
  await provider.getConfig();
  const current = await provider.authenticate(`Bearer ${jwt(keyB, accessTokenClaims(nowMs / 1000, { jti: "new" }))}`);
  assert.deepEqual(current?.projects, ["beta"]);

  releaseFirstFetch?.();
  await assert.rejects(
    oldRequest,
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_OIDC_CONFIGURATION_UNAVAILABLE");
      return true;
    },
  );
  const afterRace = await provider.authenticate(`Bearer ${jwt(keyB, accessTokenClaims(nowMs / 1000, { jti: "after" }))}`);
  assert.deepEqual(afterRace?.projects, ["beta"]);
  assert.equal(fetchCount, 2);
});

test("OIDC provider rejects unsafe policy files and JWKS material", async () => {
  const root = await tempRoot("cpb-hub-oidc-unsafe");
  const key = rsaSigningKey("key-a");
  const permissive = await writeOidcConfig(root);
  await chmod(permissive, 0o644);
  if (process.platform !== "win32") {
    await assert.rejects(openHubOidcProvider({ configFile: permissive }), /must not be accessible by group or other users/);
  }

  const insecure = path.join(root, "insecure-oidc.json");
  await writeFile(insecure, `${JSON.stringify({ ...oidcConfig(), jwksUri: "http://identity.example.test/keys" })}\n`, { mode: 0o600 });
  await assert.rejects(openHubOidcProvider({ configFile: insecure }), /jwksUri must be an absolute HTTPS URL/);

  const duplicate = path.join(root, "duplicate-oidc.json");
  const duplicateJson = JSON.stringify(oidcConfig()).replace(
    '"issuer":"https://identity.example.test/tenant"',
    '"issuer":"https://identity.example.test/tenant","issuer":"https://attacker.invalid"',
  );
  await writeFile(duplicate, `${duplicateJson}\n`, { mode: 0o600 });
  await assert.rejects(openHubOidcProvider({ configFile: duplicate }), /duplicate JSON member: issuer/);

  const configFile = await writeOidcConfig(root);
  const nowMs = Date.UTC(2026, 6, 11, 0, 0, 0);
  const privateJwk = { ...key.publicJwk, d: "private-material" };
  const provider = await openHubOidcProvider({
    configFile,
    now: () => nowMs,
    fetcher: async () => jsonResponse({ keys: [privateJwk] }),
  });
  await assert.rejects(
    provider.authenticate(`Bearer ${jwt(key, accessTokenClaims(nowMs / 1000))}`),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_IDENTITY_PROVIDER_UNAVAILABLE");
      return true;
    },
  );
});
