import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../core/contracts/canonical-json.js";
import {
  createReleaseSigningAuthority,
  createReleaseVerificationTrust,
  hashSignedReleaseObject,
  signReleaseObject,
  verifyReleaseObject,
} from "../core/contracts/release-evidence.js";

function keyFixture(keyId = "release-authority-2026") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyBase64Url = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).toString("base64url");
  const publicKeyBase64Url = Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64url");
  return { keyId, privateKeyBase64Url, publicKeyBase64Url };
}

test("canonical JSON is deterministic and rejects non-JSON values", () => {
  assert.equal(canonicalJson({ z: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"z":1}');
  assert.equal(canonicalJson({ a: -0 }), '{"a":0}');
  assert.throws(() => canonicalJson({ value: Number.NaN }), { code: "CANONICAL_JSON_INVALID" });
  assert.throws(() => canonicalJson({ value: undefined }), { code: "CANONICAL_JSON_INVALID" });
  assert.throws(() => canonicalJson({ value: "\ud800" }), { code: "CANONICAL_JSON_INVALID" });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), { code: "CANONICAL_JSON_INVALID" });
});

test("Ed25519 release Module signs canonical objects and verifies with pinned trust", () => {
  const fixture = keyFixture();
  const authority = createReleaseSigningAuthority(fixture);
  const trust = createReleaseVerificationTrust({
    keyId: fixture.keyId,
    publicKeyBase64Url: fixture.publicKeyBase64Url,
  });
  const first = signReleaseObject(authority, { schemaVersion: 2, z: "last", a: "first" });
  const second = signReleaseObject(authority, { a: "first", z: "last", schemaVersion: 2 });

  assert.equal(first.signature, second.signature, "Ed25519 signatures must bind canonical key ordering");
  assert.equal(first.signatureAlgorithm, "Ed25519");
  assert.equal(first.signerKeyId, fixture.keyId);
  assert.match(first.signature, /^[A-Za-z0-9_-]+$/);
  assert.doesNotThrow(() => verifyReleaseObject(trust, first));
  assert.match(hashSignedReleaseObject(first), /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(authority), new RegExp(fixture.privateKeyBase64Url));
});

test("Ed25519 release verification fails closed for tampering and wrong pinned key", () => {
  const fixture = keyFixture();
  const signed = signReleaseObject(createReleaseSigningAuthority(fixture), { schemaVersion: 1, ok: true });
  const trust = createReleaseVerificationTrust({ keyId: fixture.keyId, publicKeyBase64Url: fixture.publicKeyBase64Url });
  assert.throws(
    () => verifyReleaseObject(trust, { ...signed, ok: false }),
    { code: "RELEASE_GATE_RECEIPT_INVALID" },
  );

  const other = keyFixture("other-authority");
  const otherTrust = createReleaseVerificationTrust({ keyId: other.keyId, publicKeyBase64Url: other.publicKeyBase64Url });
  assert.throws(
    () => verifyReleaseObject(otherTrust, signed),
    { code: "RELEASE_GATE_RECEIPT_INVALID" },
  );
});

test("Ed25519 key decoder rejects padding, trailing bytes, PEM, wrong algorithms, and invalid ids", () => {
  const fixture = keyFixture();
  assert.throws(
    () => createReleaseSigningAuthority({ keyId: fixture.keyId, privateKeyBase64Url: "" }),
    { code: "RELEASE_GATE_SIGNING_AUTHORITY_UNAVAILABLE" },
  );
  assert.throws(
    () => createReleaseSigningAuthority({ ...fixture, privateKeyBase64Url: `${fixture.privateKeyBase64Url}=` }),
    { code: "RELEASE_GATE_SIGNING_AUTHORITY_UNAVAILABLE" },
  );
  assert.throws(
    () => createReleaseSigningAuthority({ ...fixture, privateKeyBase64Url: `${fixture.privateKeyBase64Url}AA` }),
    { code: "RELEASE_GATE_SIGNING_AUTHORITY_UNAVAILABLE" },
  );
  assert.throws(
    () => createReleaseSigningAuthority({ ...fixture, privateKeyBase64Url: Buffer.from("-----BEGIN PRIVATE KEY-----").toString("base64url") }),
    { code: "RELEASE_GATE_SIGNING_AUTHORITY_UNAVAILABLE" },
  );
  assert.throws(
    () => createReleaseSigningAuthority({ ...fixture, keyId: "bad key id" }),
    { code: "RELEASE_GATE_SIGNING_AUTHORITY_UNAVAILABLE" },
  );

  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPublic = Buffer.from(rsa.publicKey.export({ format: "der", type: "spki" })).toString("base64url");
  assert.throws(
    () => createReleaseVerificationTrust({ keyId: fixture.keyId, publicKeyBase64Url: rsaPublic }),
    { code: "RELEASE_GATE_RECEIPT_INVALID" },
  );
});
