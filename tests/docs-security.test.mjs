import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = path.resolve(import.meta.dirname, "..");
const secDoc = path.join(repoRoot, "docs/security/codepatchbay-gateway-security.md");

async function readSecurityDoc() {
  return readFile(secDoc, "utf8");
}

async function readReadme() {
  return readFile(path.join(repoRoot, "README.md"), "utf8");
}

// --- Document existence ---

test("D45: docs/security/codepatchbay-gateway-security.md exists", async () => {
  await stat(secDoc);
});

// --- Provider token handling ---

test("D45: security doc states CPB does not copy or store provider tokens", async () => {
  const doc = await readSecurityDoc();
  assert.match(
    doc,
    /does not copy.*(?:provider|API)\s*tokens?|never stores?.*(?:provider|API)\s*tokens?/i,
    "Must explicitly state CPB does not copy or store provider/API tokens"
  );
});

// --- IM key submission ---

test("D45: security doc forbids IM key submission", async () => {
  const doc = await readSecurityDoc();
  assert.match(
    doc,
    /(?:instant\s*messaging|IM)\s+key.*(?:forbidden|prohibited|must not|never submit)/i,
    "Must forbid submitting keys through instant messaging channels"
  );
});

// --- GitHub webhook signatures ---

test("D45: security doc describes GitHub webhook signature verification", async () => {
  const doc = await readSecurityDoc();
  assert.match(
    doc,
    /webhook.*signature.*verif|signature.*verification.*webhook/i,
    "Must describe GitHub webhook signature verification"
  );
});

// --- Draft PR policy ---

test("D45: security doc describes draft PR policy", async () => {
  const doc = await readSecurityDoc();
  assert.match(
    doc,
    /draft\s+PR|PR.*draft/i,
    "Must describe draft PR creation policy"
  );
});

// --- Install safety ---

test("D45: security doc covers install safety", async () => {
  const doc = await readSecurityDoc();
  assert.match(
    doc,
    /install.*safet|npm\s+install.*secur|supply\s+chain/i,
    "Must cover install safety / supply chain"
  );
});

// --- Auth model ---

test("D45: security doc describes auth model", async () => {
  const doc = await readSecurityDoc();
  assert.match(
    doc,
    /auth(?:entication|orization)?\s+model|how.*(?:auth|token).*works/i,
    "Must describe the authentication model"
  );
});

// --- Secret handling ---

test("D45: security doc covers secret handling", async () => {
  const doc = await readSecurityDoc();
  assert.match(
    doc,
    /secret.*handling|how.*secret.*(?:managed|stored|passed)/i,
    "Must cover how secrets/API keys are handled"
  );
});

// --- Worktree safety ---

test("D45: security doc covers worktree safety", async () => {
  const doc = await readSecurityDoc();
  assert.match(
    doc,
    /worktree.*safet|git\s+worktree.*isolat/i,
    "Must cover worktree isolation and safety"
  );
});

// --- Verifier safety ---

test("D45: security doc covers verifier safety", async () => {
  const doc = await readSecurityDoc();
  assert.match(
    doc,
    /verif(?:ier|ication).*safet|verif.*write.*only|verif.*read.?only/i,
    "Must cover verifier constraints and safety"
  );
});

// --- README security link ---

test("D45: README links to security doc or has a Security section", async () => {
  const readme = await readReadme();
  const hasSecuritySection = /^#+\s+Security\b/m.test(readme);
  const hasSecurityLink = /\[.*[Ss]ecurity.*\]\(docs\/security\/codepatchbay-gateway-security\.md\)/.test(readme);
  assert.ok(
    hasSecuritySection || hasSecurityLink,
    "README must have a Security section heading or a link to docs/security/codepatchbay-gateway-security.md"
  );
});
