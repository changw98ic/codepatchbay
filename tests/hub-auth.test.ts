import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  authenticateHubRequest,
  hubPrincipalCanAccessProject,
  hubPrincipalHasScope,
  loadHubAuthConfig,
  openHubAuthProvider,
} from "../shared/hub-auth.js";
import { tempRoot } from "./helpers.js";

function digest(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function writeTokenFile(root: string, tokens: unknown[]) {
  const filePath = path.join(root, "hub-service-tokens.json");
  await writeFile(filePath, `${JSON.stringify({
    format: "cpb-hub-service-tokens/v1",
    tokens,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

async function replaceTokenFile(filePath: string, tokens: unknown[]) {
  const temporary = `${filePath}.next`;
  await writeFile(temporary, `${JSON.stringify({
    format: "cpb-hub-service-tokens/v1",
    tokens,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, filePath);
}

test("Hub service-token config authenticates named principals with scopes and project boundaries", async () => {
  const root = await tempRoot("cpb-hub-service-auth");
  const readToken = "project-reader-token-with-at-least-32-bytes";
  const healthToken = "health-monitor-token-with-at-least-32-bytes";
  const filePath = await writeTokenFile(root, [
    {
      id: "project-reader",
      tokenSha256: digest(readToken),
      scopes: ["hub:read"],
      projects: ["alpha"],
    },
    {
      id: "health-monitor",
      tokenSha256: digest(healthToken),
      scopes: ["hub:health"],
      projects: ["alpha"],
    },
  ]);

  const config = await loadHubAuthConfig({ serviceTokensFile: filePath });
  const reader = authenticateHubRequest(`Bearer ${readToken}`, config);
  const monitor = authenticateHubRequest(`Bearer ${healthToken}`, config);

  assert.equal(config.required, true);
  assert.equal(config.credentialCount, 2);
  assert.equal(reader?.id, "project-reader");
  assert.equal(reader && hubPrincipalHasScope(reader, "hub:health"), true);
  assert.equal(reader && hubPrincipalHasScope(reader, "hub:read"), true);
  assert.equal(reader && hubPrincipalCanAccessProject(reader, "alpha"), true);
  assert.equal(reader && hubPrincipalCanAccessProject(reader, "beta"), false);
  assert.equal(monitor && hubPrincipalHasScope(monitor, "hub:health"), true);
  assert.equal(monitor && hubPrincipalHasScope(monitor, "hub:read"), false);
  assert.equal(authenticateHubRequest("Bearer wrong-token", config), null);
});

test("Hub service-token config treats expired credentials as unauthenticated", async () => {
  const root = await tempRoot("cpb-hub-service-auth-expiry");
  const expiredToken = "expired-service-token-with-at-least-32-bytes";
  const activeToken = "active-service-token-with-at-least-32-bytes";
  const filePath = await writeTokenFile(root, [
    {
      id: "expired",
      tokenSha256: digest(expiredToken),
      scopes: ["hub:read"],
      projects: "*",
      expiresAt: "2020-01-01T00:00:00.000Z",
    },
    {
      id: "active",
      tokenSha256: digest(activeToken),
      scopes: ["hub:read"],
      projects: "*",
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
  ]);
  const config = await loadHubAuthConfig({ serviceTokensFile: filePath });

  assert.equal(authenticateHubRequest(`Bearer ${expiredToken}`, config), null);
  assert.equal(authenticateHubRequest(`Bearer ${activeToken}`, config)?.id, "active");
});

test("Hub service-token config fails closed for unsafe files and schemas", async () => {
  const root = await tempRoot("cpb-hub-service-auth-invalid");
  const token = "invalid-config-token-with-at-least-32-bytes";
  const validEntry = {
    id: "reader",
    tokenSha256: digest(token),
    scopes: ["hub:read"],
    projects: ["alpha"],
  };

  const permissive = await writeTokenFile(root, [validEntry]);
  await chmod(permissive, 0o644);
  if (process.platform !== "win32") {
    await assert.rejects(
      loadHubAuthConfig({ serviceTokensFile: permissive }),
      /must not be accessible by group or other users/,
    );
  }

  const target = path.join(root, "real-token-file.json");
  await writeFile(target, `${JSON.stringify({ format: "cpb-hub-service-tokens/v1", tokens: [validEntry] })}\n`, { mode: 0o600 });
  if (process.platform !== "win32") {
    const link = path.join(root, "token-link.json");
    await symlink(target, link);
    await assert.rejects(loadHubAuthConfig({ serviceTokensFile: link }), /must be a real file/);
  }

  const plaintext = path.join(root, "plaintext-token-file.json");
  await writeFile(plaintext, `${JSON.stringify({
    format: "cpb-hub-service-tokens/v1",
    tokens: [{ ...validEntry, token }],
  })}\n`, { mode: 0o600 });
  await assert.rejects(loadHubAuthConfig({ serviceTokensFile: plaintext }), /unsupported fields: token/);

  const restrictedAdmin = path.join(root, "restricted-admin.json");
  await writeFile(restrictedAdmin, `${JSON.stringify({
    format: "cpb-hub-service-tokens/v1",
    tokens: [{ ...validEntry, scopes: ["hub:admin"] }],
  })}\n`, { mode: 0o600 });
  await assert.rejects(loadHubAuthConfig({ serviceTokensFile: restrictedAdmin }), /admin principal.*projects: '\*'/);

  const reservedPrincipal = path.join(root, "reserved-principal.json");
  await writeFile(reservedPrincipal, `${JSON.stringify({
    format: "cpb-hub-service-tokens/v1",
    tokens: [{ ...validEntry, id: "legacy-admin" }],
  })}\n`, { mode: 0o600 });
  await assert.rejects(loadHubAuthConfig({ serviceTokensFile: reservedPrincipal }), /invalid or duplicate.*legacy-admin/);

  const ambiguousExpiry = path.join(root, "ambiguous-expiry.json");
  await writeFile(ambiguousExpiry, `${JSON.stringify({
    format: "cpb-hub-service-tokens/v1",
    tokens: [{ ...validEntry, expiresAt: "01/02/2030" }],
  })}\n`, { mode: 0o600 });
  await assert.rejects(loadHubAuthConfig({ serviceTokensFile: ambiguousExpiry }), /invalid expiresAt/);

  const hubRoot = path.join(root, "hub");
  await mkdir(hubRoot, { recursive: true });
  const insideHub = await writeTokenFile(hubRoot, [validEntry]);
  await assert.rejects(
    loadHubAuthConfig({ serviceTokensFile: insideHub, hubRoot }),
    /must be stored outside the Hub root/,
  );

  await assert.rejects(
    loadHubAuthConfig({ serviceTokensFile: "relative/service-tokens.json" }),
    /must be an absolute path/,
  );

  const oversized = path.join(root, "oversized-token-file.json");
  await writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20), { mode: 0o600 });
  await assert.rejects(loadHubAuthConfig({ serviceTokensFile: oversized }), /exceeds 1048576 bytes/);
});

test("legacy Hub bearer token remains a global administrator and duplicate credentials fail startup", async () => {
  const legacyToken = "legacy-admin-token-with-at-least-32-bytes";
  const config = await loadHubAuthConfig({ bearerToken: legacyToken });
  const principal = authenticateHubRequest(`Bearer ${legacyToken}`, config);

  assert.equal(principal?.id, "legacy-admin");
  assert.equal(principal && hubPrincipalHasScope(principal, "hub:admin"), true);
  assert.equal(principal && hubPrincipalCanAccessProject(principal, "anything"), true);

  const root = await tempRoot("cpb-hub-service-auth-duplicate");
  const filePath = await writeTokenFile(root, [{
    id: "same-token",
    tokenSha256: digest(legacyToken),
    scopes: ["hub:read"],
    projects: "*",
  }]);
  await assert.rejects(
    loadHubAuthConfig({ bearerToken: legacyToken, serviceTokensFile: filePath }),
    /duplicates a token/,
  );
});

test("Hub refuses to start with only expired service credentials", async () => {
  const root = await tempRoot("cpb-hub-service-auth-all-expired");
  const filePath = await writeTokenFile(root, [{
    id: "expired",
    tokenSha256: digest("expired-only-token-with-at-least-32-bytes"),
    scopes: ["hub:health"],
    projects: "*",
    expiresAt: "2020-01-01T00:00:00.000Z",
  }]);

  await assert.rejects(loadHubAuthConfig({ serviceTokensFile: filePath }), /all configured Hub bearer credentials are expired/);
});

test("Hub auth provider atomically reloads rotations and fails closed until invalid files are repaired", async () => {
  const root = await tempRoot("cpb-hub-auth-provider-reload");
  const firstToken = "first-provider-token-with-at-least-32-bytes";
  const secondToken = "second-provider-token-with-at-least-32-bytes";
  const firstEntry = {
    id: "first-reader",
    tokenSha256: digest(firstToken),
    scopes: ["hub:read"],
    projects: ["alpha"],
  };
  const secondEntry = {
    id: "second-reader",
    tokenSha256: digest(secondToken),
    scopes: ["hub:read"],
    projects: ["beta"],
  };
  const filePath = await writeTokenFile(root, [firstEntry]);
  const provider = await openHubAuthProvider({ serviceTokensFile: filePath });
  assert.equal(authenticateHubRequest(`Bearer ${firstToken}`, provider.initial)?.id, "first-reader");

  await replaceTokenFile(filePath, [secondEntry]);
  const concurrentReloads = await Promise.all(Array.from({ length: 32 }, () => provider.getConfig()));
  const rotated = concurrentReloads[0];
  assert.ok(concurrentReloads.every((config) => authenticateHubRequest(`Bearer ${secondToken}`, config)?.id === "second-reader"));
  assert.equal(provider.status().reloadCount, 1);
  assert.equal(authenticateHubRequest(`Bearer ${firstToken}`, rotated), null);
  assert.equal(authenticateHubRequest(`Bearer ${secondToken}`, rotated)?.id, "second-reader");

  const invalid = `${filePath}.next`;
  await writeFile(invalid, "{invalid-json\n", { mode: 0o600 });
  await rename(invalid, filePath);
  await assert.rejects(
    provider.getConfig(),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_AUTH_CONFIGURATION_UNAVAILABLE");
      return true;
    },
  );
  await assert.rejects(provider.getConfig(), /configuration reload failed/i);

  await replaceTokenFile(filePath, [secondEntry]);
  const repaired = await provider.getConfig();
  assert.equal(authenticateHubRequest(`Bearer ${secondToken}`, repaired)?.id, "second-reader");
  assert.equal(provider.status().reloadCount, 2);

  await rm(filePath);
  await assert.rejects(
    provider.getConfig(),
    (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, "HUB_AUTH_CONFIGURATION_UNAVAILABLE");
      return true;
    },
  );
});
