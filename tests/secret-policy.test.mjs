import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildChildEnv,
  redactSecrets,
  detectSecretInput,
  assertNoSecretInput,
  isSecretPath,
  isSecretArtifact,
} from "../server/services/secret-policy.js";

describe("buildChildEnv", () => {
  it("forwards only explicit runtime and provider env keys", () => {
    const env = buildChildEnv({
      PATH: "/usr/bin",
      CPB_ROOT: "/tmp/cpb",
      CPB_ACP_CUSTOM_AGENT_COMMAND: "agent-bin",
      OPENAI_API_KEY: "provider-secret",
      DATABASE_URL: "postgres://user:pass@example/db",
      RANDOM_TOKEN: "leak",
      CPB_GITHUB_WEBHOOK_SECRET: "webhook-secret",
    }, {
      CPB_JOB_ID: "job-1",
      AWS_REGION: "us-east-1",
      EXTRA_SECRET: "extra-leak",
    });

    assert.strictEqual(env.PATH, "/usr/bin");
    assert.strictEqual(env.CPB_ROOT, "/tmp/cpb");
    assert.strictEqual(env.CPB_ACP_CUSTOM_AGENT_COMMAND, "agent-bin");
    assert.strictEqual(env.CPB_JOB_ID, "job-1");
    assert.strictEqual(env.OPENAI_API_KEY, "provider-secret");
    assert.strictEqual(env.AWS_REGION, "us-east-1");
    assert.strictEqual(env.DATABASE_URL, undefined);
    assert.strictEqual(env.RANDOM_TOKEN, undefined);
    assert.strictEqual(env.CPB_GITHUB_WEBHOOK_SECRET, undefined);
    assert.strictEqual(env.EXTRA_SECRET, undefined);
  });
});

describe("redactSecrets", () => {
  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    assert.strictEqual(redactSecrets(input), "Authorization: Bearer [REDACTED]");
  });

  it("redacts GitHub personal access tokens (ghp_)", () => {
    const input = "token=ghp_abc123def456ghi789";
    assert.strictEqual(redactSecrets(input), "token=[REDACTED]");
  });

  it("redacts GitHub App installation tokens (ghs_)", () => {
    const input = "token=ghs_abc123def456ghi789";
    assert.strictEqual(redactSecrets(input), "token=[REDACTED]");
  });

  it("redacts GitHub fine-grained PATs (github_pat_)", () => {
    const input = "github_pat_abc123def456ghi789jkl012mno345pqr678stu";
    assert.strictEqual(redactSecrets(input), "[REDACTED]");
  });

  it("redacts GitHub token embedded in URL", () => {
    const input = "https://x-access-token:ghs_abc123@github.com/owner/repo.git";
    assert.strictEqual(redactSecrets(input), "[REDACTED_URL]");
  });

  it("redacts query parameter tokens", () => {
    const input = "https://example.com/api?token=secret123&foo=bar";
    assert.strictEqual(redactSecrets(input), "https://example.com/api?token=[REDACTED]&foo=bar");
  });

  it("redacts secrets in nested objects", () => {
    const input = {
      user: "admin",
      password: "supersecret123",
      nested: {
        apiKey: "sk-ant-test123",
      },
    };
    const result = redactSecrets(input);
    assert.strictEqual(result.password, "[REDACTED]");
    assert.strictEqual(result.nested.apiKey, "[REDACTED]");
    assert.strictEqual(result.user, "admin");
  });

  it("redacts secrets in arrays", () => {
    const input = ["ghp_abc123def456", "normal-value", "Bearer tokensecret"];
    const result = redactSecrets(input);
    assert.deepStrictEqual(result, ["[REDACTED]", "normal-value", "Bearer [REDACTED]"]);
  });

  it("preserves non-secret values", () => {
    const input = "Hello world, this is a normal string with no secrets.";
    assert.strictEqual(redactSecrets(input), input);
  });

  it("redacts AWS access keys", () => {
    const input = "AKIAIOSFODNN7EXAMPLE";
    assert.strictEqual(redactSecrets(input), "[REDACTED]");
  });

  it("redacts Google API keys", () => {
    const input = "AIza12345678901234567890123456789012345";
    assert.strictEqual(redactSecrets(input), "[REDACTED]");
  });

  it("redacts stderr containing GitHub token", () => {
    const input = "fatal: unable to access 'https://x-access-token:ghs_abc@github.com/': 401";
    const result = redactSecrets(input);
    assert.ok(!result.includes("ghs_abc"));
    assert.ok(result.includes("[REDACTED_URL]"));
  });

  it("redacts event payload with GitHub token", () => {
    const input = {
      type: "github_event",
      payload: {
        token: "ghp_secret_token_here",
        url: "https://x-access-token:ghs_xxx@github.com/owner/repo.git",
      },
    };
    const result = redactSecrets(input);
    assert.strictEqual(result.payload.token, "[REDACTED]");
    assert.strictEqual(result.payload.url, "[REDACTED_URL]");
  });
});

describe("detectSecretInput", () => {
  it("detects raw secret input with credential assignment", () => {
    const result = detectSecretInput("api_key=secret123");
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.pattern, "credential_assignment");
  });

  it("detects Bearer token input", () => {
    const result = detectSecretInput("Bearer eyJhbGciOiJIUzI1NiJ9");
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.pattern, "bearer_token");
  });

  it("detects GitHub token input", () => {
    const result = detectSecretInput("ghp_abc123def456");
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.pattern, "github_token");
  });

  it("detects GitHub fine-grained PAT input", () => {
    const result = detectSecretInput("github_pat_abc123def456");
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.pattern, "github_pat");
  });

  it("detects GitHub URL with embedded token", () => {
    const result = detectSecretInput("https://x-access-token:ghs_abc@github.com/owner/repo.git");
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.pattern, "github_url_token");
  });

  it("returns no match for clean input", () => {
    const result = detectSecretInput("Hello world");
    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.pattern, null);
  });
});

describe("assertNoSecretInput", () => {
  it("throws on secret input", () => {
    assert.throws(() => assertNoSecretInput("api_key=secret"), /Do not paste API keys/);
  });

  it("returns detection result on clean input", () => {
    const result = assertNoSecretInput("clean input");
    assert.strictEqual(result.matched, false);
  });
});

describe("isSecretPath", () => {
  it("detects .env files", () => {
    assert.strictEqual(isSecretPath(".env"), true);
    assert.strictEqual(isSecretPath("/project/.env.local"), true);
  });

  it("detects SSH keys", () => {
    assert.strictEqual(isSecretPath("id_rsa"), true);
    assert.strictEqual(isSecretPath("/home/user/.ssh/id_ed25519"), true);
  });

  it("detects PEM files", () => {
    assert.strictEqual(isSecretPath("key.pem"), true);
  });

  it("returns false for normal files", () => {
    assert.strictEqual(isSecretPath("index.js"), false);
    assert.strictEqual(isSecretPath("README.md"), false);
  });
});

describe("isSecretArtifact", () => {
  it("detects secret content", () => {
    assert.strictEqual(isSecretArtifact("key.pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIE"), true);
  });

  it("detects secret path", () => {
    assert.strictEqual(isSecretArtifact(".env", "DB_HOST=localhost"), true);
  });

  it("returns false for normal artifacts", () => {
    assert.strictEqual(isSecretArtifact("readme.txt", "Hello world"), false);
  });
});
