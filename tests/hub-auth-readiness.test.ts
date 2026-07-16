import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { checkHubAuthentication, checkHubBackupSigning } from "../server/services/readiness-checks.js";
import { tempRoot } from "./helpers.js";

async function oidcConfig(root: string) {
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
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}

function publicJwk() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    ...publicKey.export({ format: "jwk" }),
    kid: "readiness-key",
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  };
}

test("Hub authentication readiness preflights configured OIDC keys without exposing identity data", async () => {
  const root = await tempRoot("cpb-hub-auth-readiness-oidc");
  const configFile = await oidcConfig(root);
  const result = await checkHubAuthentication(path.join(root, "hub"), {
    CPB_HOST: "0.0.0.0",
    CPB_HUB_OIDC_CONFIG_FILE: configFile,
  }, {
    fetcher: async () => new Response(JSON.stringify({ keys: [publicJwk()] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(result.status, "ok");
  assert.deepEqual((result.details as { modes: string[] }).modes, ["oidc-rfc9068"]);
  assert.equal((result.details as { oidcKeyCount: number }).oidcKeyCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /cpb-readers|identity\.example|readiness-key/);
});

test("Hub authentication readiness reports IdP failure without leaking endpoint details", async () => {
  const root = await tempRoot("cpb-hub-auth-readiness-outage");
  const configFile = await oidcConfig(root);
  const result = await checkHubAuthentication(path.join(root, "hub"), {
    CPB_HOST: "0.0.0.0",
    CPB_HUB_OIDC_CONFIG_FILE: configFile,
  }, {
    fetcher: async () => {
      throw new Error("sensitive upstream diagnostic");
    },
  });

  assert.equal(result.status, "error");
  assert.equal((result.details as { code: string }).code, "HUB_IDENTITY_PROVIDER_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result), /sensitive upstream diagnostic|identity\.example/);
});

test("Hub authentication readiness rejects missing auth by default and only warns for explicit loopback development mode", async () => {
  const root = await tempRoot("cpb-hub-auth-readiness-anonymous");
  const loopback = await checkHubAuthentication(path.join(root, "hub"), { CPB_HOST: "127.0.0.1" });
  const exposed = await checkHubAuthentication(path.join(root, "hub"), { CPB_HOST: "0.0.0.0" });
  const explicitDev = await checkHubAuthentication(path.join(root, "hub"), {
    CPB_HOST: "127.0.0.1",
    CPB_HUB_ALLOW_ANONYMOUS_DEV: "1",
  });

  assert.equal(loopback.status, "error");
  assert.equal(exposed.status, "error");
  assert.equal(explicitDev.status, "warn");
});

test("Hub backup signing readiness rejects missing or weak keys", () => {
  assert.equal(checkHubBackupSigning({}).status, "error");
  assert.equal(checkHubBackupSigning({ CPB_HUB_BACKUP_SIGNING_KEY: "too-short" }).status, "error");
  assert.equal(
    checkHubBackupSigning({ CPB_HUB_BACKUP_SIGNING_KEY: "backup-signing-key-with-at-least-32-bytes" }).status,
    "ok",
  );
});
