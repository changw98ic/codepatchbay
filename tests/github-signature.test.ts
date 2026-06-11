// @ts-nocheck
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { verifyGithubWebhookSignature } from "../server/services/github-app.js";

function sign(payload, secret) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

test("GitHub webhook signature verifier accepts valid raw-body HMAC", () => {
  const rawBody = Buffer.from('{ "action" : "opened" }', "utf8");
  assert.equal(verifyGithubWebhookSignature({
    signature: sign(rawBody, "secret"),
    rawBody,
    secret: "secret",
  }), true);
});

test("GitHub webhook signature verifier rejects missing malformed or mismatched signatures", () => {
  const rawBody = Buffer.from("{}", "utf8");
  assert.equal(verifyGithubWebhookSignature({ signature: null, rawBody, secret: "secret" }), false);
  assert.equal(verifyGithubWebhookSignature({ signature: "md5=abc", rawBody, secret: "secret" }), false);
  assert.equal(verifyGithubWebhookSignature({ signature: "sha256=NOT_HEX", rawBody, secret: "secret" }), false);
  assert.equal(verifyGithubWebhookSignature({ signature: `sha256=${"f".repeat(64)}`, rawBody, secret: "secret" }), false);
  assert.equal(verifyGithubWebhookSignature({ signature: sign(rawBody, "secret"), rawBody, secret: "wrong" }), false);
});

test("GitHub webhook signature verifier uses raw bytes instead of reserialized JSON", () => {
  const signature = sign('{ "action" : "opened" }', "secret");
  assert.equal(verifyGithubWebhookSignature({
    signature,
    rawBody: Buffer.from('{ "action" : "opened" }', "utf8"),
    secret: "secret",
  }), true);
  assert.equal(verifyGithubWebhookSignature({
    signature,
    rawBody: Buffer.from('{"action":"opened"}', "utf8"),
    secret: "secret",
  }), false);
});
