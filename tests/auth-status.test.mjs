import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("auth status", () => {
  it("reports provider-native auth status without exposing secret-bearing output", async () => {
    const { getAuthStatus } = await import("../core/auth/status.js");

    const secretOutput = [
      "OPENAI_API_KEY=sk-test-secret-value",
      "/Users/test/.config/gh/hosts.yml",
      "token=ghp_testsecret",
    ].join("\n");

    const status = await getAuthStatus({
      runCommand: async (command, args) => {
        const signature = [command, ...args].join(" ");
        if (signature === "codex auth status") {
          return { ok: true, stdout: "signed in\n", stderr: "" };
        }
        if (signature === "claude doctor") {
          return {
            ok: false,
            stdout: "",
            stderr: secretOutput,
            error: Object.assign(new Error(secretOutput), { code: "ENOENT" }),
          };
        }
        if (signature === "opencode auth list") {
          return {
            ok: false,
            stdout: "",
            stderr: secretOutput,
            error: Object.assign(new Error(secretOutput), { code: 1 }),
          };
        }
        if (signature === "gh auth status") {
          throw Object.assign(new Error(secretOutput), { code: "ETIMEDOUT" });
        }
        throw new Error(`unexpected auth probe: ${signature}`);
      },
    });

    assert.equal(status.schemaVersion, 1);
    assert.equal(status.providers.codex.status, "connected");
    assert.equal(status.providers.claude.status, "missing");
    assert.equal(status.providers.opencode.status, "unknown");
    assert.equal(status.providers.github.status, "unknown");

    const serialized = JSON.stringify(status);
    assert.doesNotMatch(serialized, /sk-test-secret-value/);
    assert.doesNotMatch(serialized, /ghp_testsecret/);
    assert.doesNotMatch(serialized, /hosts\.yml/);
    assert.doesNotMatch(serialized, /\.config\/gh/);
  });

  it("marks providers without status commands as skipped", async () => {
    const { getAuthStatus } = await import("../core/auth/status.js");

    const status = await getAuthStatus({
      providers: [
        {
          id: "custom",
          displayName: "Custom Provider",
          kind: "agent",
          auth: {},
        },
      ],
      runCommand: async () => {
        throw new Error("should not run");
      },
    });

    assert.equal(status.providers.custom.status, "skipped");
    assert.match(status.providers.custom.evidence.reason, /status command/i);
  });
});

describe("auth connect", () => {
  it("returns local-only provider-native connect instructions", async () => {
    const { getAuthConnectInstructions } = await import("../core/auth/connect.js");

    const codex = getAuthConnectInstructions("codex", { baseUrl: "http://127.0.0.1:3456" });
    const claude = getAuthConnectInstructions("claude", { baseUrl: "http://127.0.0.1:3456" });
    const github = getAuthConnectInstructions("github", { baseUrl: "http://127.0.0.1:3456" });

    assert.equal(codex.provider.id, "codex");
    assert.equal(codex.providerNativeCommand, "codex");
    assert.equal(claude.providerNativeCommand, "claude");
    assert.equal(github.providerNativeCommand, "cpb github connect");
    assert.equal(codex.localSetupUrl, "http://127.0.0.1:3456/setup/auth/codex");
    assert.equal(github.localSetupUrl, "http://127.0.0.1:3456/setup/auth/github");
    assert.match(codex.guidance, /Do not paste API keys/i);
  });

  it("rejects IM-style API key submission in the auth parser", async () => {
    const { parseAuthCommand } = await import("../cli/commands/auth.js");

    assert.throws(
      () => parseAuthCommand(["connect", "codex", "OPENAI_API_KEY=sk-test-secret-value"]),
      /Do not paste API keys/i,
    );
    assert.throws(
      () => parseAuthCommand(["connect", "claude", "sk-ant-test-secret-value"]),
      /Do not paste API keys/i,
    );
    assert.throws(
      () => parseAuthCommand(["connect", "github", "Authorization: Bearer ghp_testsecretvalue"]),
      /Do not paste API keys/i,
    );
  });

  it("uses the shared secret policy for raw credential detection", async () => {
    const { detectSecretInput } = await import("../server/services/secret-policy.js");

    const detected = detectSecretInput("Slack: /cpb auth connect codex OPENAI_API_KEY=sk-test-secret-value");
    assert.equal(detected.matched, true);
    assert.equal(detected.kind, "raw_secret_input");
    assert.match(detected.guidance, /provider-native login/i);
    assert.doesNotMatch(detected.redacted, /sk-test-secret-value/);
    assert.match(detected.redacted, /OPENAI_API_KEY=\[REDACTED\]/);
  });
});
