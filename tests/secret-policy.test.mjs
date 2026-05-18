import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChildEnv,
  RUNTIME_BASICS,
  PROVIDER_CREDENTIALS,
  ALLOWED_ENV,
  redactSecrets,
  isSecretPath,
  isSecretContent,
  isSecretArtifact,
  makeSecretBlockedEvent,
} from "../server/services/secret-policy.js";

// ---------------------------------------------------------------------------
// Child-env allowlist
// ---------------------------------------------------------------------------

test("buildChildEnv preserves runtime basics when present in parent", () => {
  const parent = {
    PATH: "/usr/bin", HOME: "/home/test", SHELL: "/bin/zsh",
    TERM: "xterm", USER: "dev", LOGNAME: "dev",
    LANG: "en_US.UTF-8", TMPDIR: "/tmp",
    CODEX_HOME: "/opt/codex", XDG_CACHE_HOME: "/cache",
    LC_ALL: "en_US.UTF-8", LC_CTYPE: "en_US.UTF-8",
    TEMP: "/tmp", TMP: "/tmp",
  };
  const env = buildChildEnv(parent);
  for (const key of RUNTIME_BASICS) {
    if (key in parent) assert.equal(env[key], parent[key], `${key} should be preserved`);
  }
});

test("buildChildEnv preserves provider credentials when present in parent", () => {
  const parent = {
    OPENAI_API_KEY: "sk-test-openai",
    ANTHROPIC_API_KEY: "sk-ant-test",
    GEMINI_API_KEY: "test-gemini",
    GOOGLE_API_KEY: "test-google",
    AZURE_OPENAI_API_KEY: "test-azure",
    AZURE_OPENAI_ENDPOINT: "https://test.openai.azure.com",
    AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
    AWS_SECRET_ACCESS_KEY: "test-secret",
    AWS_SESSION_TOKEN: "test-session",
    AWS_REGION: "us-east-1",
    AWS_DEFAULT_REGION: "us-west-2",
  };
  const env = buildChildEnv(parent);
  for (const key of PROVIDER_CREDENTIALS) {
    if (key in parent) assert.equal(env[key], parent[key], `${key} should be preserved`);
  }
});

test("buildChildEnv omits arbitrary secret-like env names", () => {
  const parent = {
    CPB_TEST_SECRET: "should-not-appear",
    DATABASE_URL: "postgres://user:pass@host/db",
    AWS_SECRET_ACCESS_KEY: "allowed-secret",
    FOO_TOKEN: "arbitrary-token",
    MY_API_KEY: "random-key",
    GITHUB_TOKEN: "ghp_abc123",
    NPM_TOKEN: "npm_test",
    PYPI_TOKEN: "pypi_test",
    SOME_AUTH_TOKEN: "auth-test",
    CUSTOM_SECRET: "custom-test",
    PRIVATE_KEY: "pk-test",
  };
  const env = buildChildEnv(parent);

  assert.equal(env.CPB_TEST_SECRET, undefined, "CPB_TEST_SECRET must not leak");
  assert.equal(env.DATABASE_URL, undefined, "DATABASE_URL must not leak");
  assert.equal(env.FOO_TOKEN, undefined, "FOO_TOKEN must not leak");
  assert.equal(env.MY_API_KEY, undefined, "MY_API_KEY must not leak");
  assert.equal(env.GITHUB_TOKEN, undefined, "GITHUB_TOKEN must not leak");
  assert.equal(env.NPM_TOKEN, undefined, "NPM_TOKEN must not leak");
  assert.equal(env.PYPI_TOKEN, undefined, "PYPI_TOKEN must not leak");
  assert.equal(env.SOME_AUTH_TOKEN, undefined, "SOME_AUTH_TOKEN must not leak");
  assert.equal(env.CUSTOM_SECRET, undefined, "CUSTOM_SECRET must not leak");
  assert.equal(env.PRIVATE_KEY, undefined, "PRIVATE_KEY must not leak");

  // But AWS_SECRET_ACCESS_KEY is in the explicit provider allowlist
  assert.equal(env.AWS_SECRET_ACCESS_KEY, "allowed-secret");
});

test("buildChildEnv filters extra env through the same allowlist", () => {
  const parent = { PATH: "/usr/bin", HOME: "/home/test", OPENAI_API_KEY: "parent-key" };
  const env = buildChildEnv(parent, {
    CPB_ROOT: "/cpb",
    CPB_EXECUTOR_ROOT: "/cpb-release",
    CUSTOM_VAR: "hello",
    SECRET_TOKEN: "extra-secret",
    OPENAI_API_KEY: "extra-key",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CPB_ROOT, "/cpb");
  assert.equal(env.CPB_EXECUTOR_ROOT, "/cpb-release");
  assert.equal(env.OPENAI_API_KEY, "extra-key");
  assert.equal(env.CUSTOM_VAR, undefined);
  assert.equal(env.SECRET_TOKEN, undefined);
});

test("buildChildEnv does not inherit keys absent from parent", () => {
  const parent = { PATH: "/usr/bin" };
  const env = buildChildEnv(parent);
  assert.equal(env.HOME, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("redactSecrets redacts sensitive keys", () => {
  const obj = { token: "abc123", authorization: "Bearer xyz", safe: "hello" };
  const redacted = redactSecrets(obj);
  assert.equal(redacted.token, "[REDACTED]");
  assert.equal(redacted.authorization, "[REDACTED]");
  assert.equal(redacted.safe, "hello");
});

test("redactSecrets redacts Bearer tokens in strings", () => {
  const result = redactSecrets("error: Bearer sk-abc123xyz");
  assert.ok(result.includes("[REDACTED]"));
  assert.ok(!result.includes("sk-abc123xyz"));
});

test("redactSecrets redacts OpenAI key patterns", () => {
  const result = redactSecrets("key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890");
  assert.ok(result.includes("[REDACTED]"));
  assert.ok(!result.includes("sk-proj-"));
});

test("redactSecrets redacts AWS key patterns", () => {
  const result = redactSecrets("identity: AKIAIOSFODNN7EXAMPLE");
  assert.ok(result.includes("[REDACTED]"));
  assert.ok(!result.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("redactSecrets redacts webhook URLs", () => {
  const result = redactSecrets("post to https://hooks.slack.com/services/webhook/secret123");
  assert.ok(result.includes("[REDACTED_URL]"));
  assert.ok(!result.includes("secret123"));
});

test("redactSecrets redacts query-string secrets", () => {
  const result = redactSecrets("fetch https://api.example.com?token=secret123&key=abc");
  assert.ok(!result.includes("secret123"));
  assert.ok(!result.includes("abc"));
  assert.ok(result.includes("[REDACTED]"));
});

test("redactSecrets handles nested objects recursively", () => {
  const obj = {
    level1: {
      level2: {
        api_key: "sk-test-key",
        safe: "value",
        nested: { token: "should-be-redacted" },
      },
    },
  };
  const redacted = redactSecrets(obj);
  assert.equal(redacted.level1.level2.api_key, "[REDACTED]");
  assert.equal(redacted.level1.level2.safe, "value");
  assert.equal(redacted.level1.level2.nested.token, "[REDACTED]");
});

test("redactSecrets handles arrays", () => {
  const arr = [{ token: "abc" }, { safe: "hello" }];
  const redacted = redactSecrets(arr);
  assert.equal(redacted[0].token, "[REDACTED]");
  assert.equal(redacted[1].safe, "hello");
});

test("redactSecrets handles circular references", () => {
  const obj = { a: "safe" };
  obj.self = obj;
  const redacted = redactSecrets(obj);
  assert.equal(redacted.a, "safe");
  assert.equal(redacted.self, "[Circular]");
});

test("redactSecrets passes through primitives", () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(42), 42);
  assert.equal(redactSecrets(true), true);
});

test("redactSecrets handles sensitive key variants", () => {
  const obj = {
    API_KEY: "v1",
    api_key: "v2",
    AUTH_TOKEN: "v3",
    auth_token: "v4",
    PASSWORD: "v5",
    SECRET: "v6",
    CREDENTIAL: "v7",
    COOKIE: "v8",
    ACCESS_KEY: "v9",
    SESSION_KEY: "v10",
    PRIVATE_KEY: "v11",
  };
  const redacted = redactSecrets(obj);
  for (const [k, v] of Object.entries(redacted)) {
    assert.equal(v, "[REDACTED]", `${k} should be redacted`);
  }
});

// ---------------------------------------------------------------------------
// Secret-path detection
// ---------------------------------------------------------------------------

test("isSecretPath detects .env files", () => {
  assert.ok(isSecretPath(".env"));
  assert.ok(isSecretPath(".env.local"));
  assert.ok(isSecretPath(".env.production"));
  assert.ok(isSecretPath("path/to/.env"));
  assert.ok(isSecretPath("path/to/.env.local"));
});

test("isSecretPath detects credential files", () => {
  assert.ok(isSecretPath(".npmrc"));
  assert.ok(isSecretPath(".pypirc"));
  assert.ok(isSecretPath(".netrc"));
  assert.ok(isSecretPath("config/.npmrc"));
});

test("isSecretPath detects SSH keys", () => {
  assert.ok(isSecretPath(".ssh/id_rsa"));
  assert.ok(isSecretPath(".ssh/id_ed25519"));
  assert.ok(isSecretPath("/home/user/.ssh/id_rsa"));
  assert.ok(isSecretPath("deploy_key.pem"));
  assert.ok(isSecretPath("server.key"));
  assert.ok(isSecretPath("test_rsa"));
});

test("isSecretPath detects cloud credential paths", () => {
  assert.ok(isSecretPath(".aws/credentials"));
  assert.ok(isSecretPath(".aws/config"));
  assert.ok(isSecretPath(".config/gcloud/credentials.db"));
  assert.ok(isSecretPath(".azure/token.json"));
  assert.ok(isSecretPath(".kube/config"));
});

test("isSecretPath allows ordinary project files", () => {
  assert.ok(!isSecretPath("src/index.js"));
  assert.ok(!isSecretPath("package.json"));
  assert.ok(!isSecretPath("README.md"));
  assert.ok(!isSecretPath("server/services/role-bridge.js"));
  assert.ok(!isSecretPath("tests/secret-policy.test.mjs"));
  assert.ok(!isSecretPath("context.md"));
  assert.ok(!isSecretPath("decisions.md"));
});

test("isSecretPath handles edge cases", () => {
  assert.ok(!isSecretPath(""));
  assert.ok(!isSecretPath(null));
  assert.ok(!isSecretPath(undefined));
});

test("isSecretPath handles Windows-style paths", () => {
  assert.ok(isSecretPath("path\\.env"));
  assert.ok(isSecretPath("C:\\Users\\.ssh\\id_rsa"));
});

// ---------------------------------------------------------------------------
// Secret-artifact detection
// ---------------------------------------------------------------------------

test("isSecretArtifact detects by secret path name", () => {
  assert.ok(isSecretArtifact(".env", ""));
  assert.ok(isSecretArtifact("deploy.key", ""));
  assert.ok(isSecretArtifact("id_rsa", ""));
});

test("isSecretArtifact detects by content (private key)", () => {
  const content = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowI...\n-----END RSA PRIVATE KEY-----";
  assert.ok(isSecretArtifact("config.txt", content));
});

test("isSecretArtifact detects by content (AWS key)", () => {
  assert.ok(isSecretArtifact("note.md", "access key AKIAIOSFODNN7EXAMPLE here"));
});

test("isSecretArtifact detects by content (OpenAI key)", () => {
  assert.ok(isSecretArtifact("output.md", "using sk-proj-abcdefghijklmnopqrstuvwxyz1234567890"));
});

test("isSecretArtifact allows benign artifacts", () => {
  assert.ok(!isSecretArtifact("deliverable-001.md", "## Changes\n- Fixed bug"));
  assert.ok(!isSecretArtifact("verdict-001.md", "VERDICT: PASS"));
  assert.ok(!isSecretArtifact("plan-001.md", "## Task\nAdd tests"));
});

test("isSecretContent returns false for non-strings", () => {
  assert.ok(!isSecretContent(null));
  assert.ok(!isSecretContent(undefined));
  assert.ok(!isSecretContent(42));
});

// ---------------------------------------------------------------------------
// makeSecretBlockedEvent
// ---------------------------------------------------------------------------

test("makeSecretBlockedEvent produces correct event shape", () => {
  const event = makeSecretBlockedEvent("deploy.pem", "private key detected");
  assert.equal(event.type, "secret_blocked");
  assert.equal(event.artifact, "deploy.pem");
  assert.equal(event.reason, "private key detected");
  assert.ok(event.ts);
});

test("makeSecretBlockedEvent uses default reason", () => {
  const event = makeSecretBlockedEvent(".env");
  assert.equal(event.reason, "secret-like content detected");
});

test("makeSecretBlockedEvent redacts secret-looking artifact identifiers", () => {
  const raw = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
  const event = makeSecretBlockedEvent(raw, "secret key detected");
  assert.equal(event.type, "secret_blocked");
  assert.notEqual(event.artifact, raw);
  assert.ok(!JSON.stringify(event).includes(raw));
});
