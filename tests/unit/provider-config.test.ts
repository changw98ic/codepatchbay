import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProviderConfig,
  providerEnvironmentKeys,
  providerCredentialInputKeys,
  providerVariantFromEnvironment,
  providerKeyForDescriptor,
  providerVariantFromKey,
  isValidProviderConfig,
  applyProviderEnvironment,
  providerFallbacksFromDescriptor,
} from "../../core/agents/provider-config.js";

// --- normalizeProviderConfig ---

describe("normalizeProviderConfig", () => {
  test("returns defaults for empty descriptor", () => {
    const config = normalizeProviderConfig("codex", {});
    assert.equal(config.key, null);
    assert.equal(config.variant, null);
    assert.deepEqual(config.credentialEnv, []);
    assert.deepEqual(config.credentialInputs, []);
    assert.deepEqual(config.environment, {});
    assert.deepEqual(config.derived, {});
    assert.deepEqual(config.values, {});
    assert.deepEqual(config.runtimeEnv, []);
    assert.deepEqual(config.required, []);
    assert.deepEqual(config.normalizers, {});
    assert.deepEqual(config.fallbacks, []);
    assert.equal(config.cliCommand, null);
    assert.deepEqual(config.cliArgs, []);
    assert.equal(config.cliModelEnv, "ANTHROPIC_MODEL");
    assert.equal(config.cliModelArg, "--model");
  });

  test("returns defaults for null descriptor", () => {
    const config = normalizeProviderConfig("codex", null);
    assert.equal(config.key, null);
    assert.equal(config.variant, null);
  });

  test("normalizes provider environment mapping", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        environment: {
          CODEX_API_KEY: ["CODEX_API_KEY", "ANTHROPIC_API_KEY"],
        },
      },
    });
    assert.deepEqual(config.environment, {
      CODEX_API_KEY: ["CODEX_API_KEY", "ANTHROPIC_API_KEY"],
    });
    assert.ok(config.credentialEnv.includes("CODEX_API_KEY"));
  });

  test("filters invalid env names", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        environment: {
          "INVALID-NAME": ["VALID_NAME"],
        },
      },
    });
    assert.deepEqual(config.environment, {});
  });

  test("normalizes derived vars", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        derived: {
          API_BASE: "https://api.example.com",
        },
      },
    });
    assert.deepEqual(config.derived, { API_BASE: "https://api.example.com" });
  });

  test("normalizes values", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        values: {
          REGION: "us-east-1",
        },
      },
    });
    assert.deepEqual(config.values, { REGION: "us-east-1" });
  });

  test("normalizes key and variant", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        key: "codex-default",
        variant: "fast",
      },
    });
    assert.equal(config.key, "codex-default");
    assert.equal(config.variant, "fast");
  });

  test("normalizes keyTemplate", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        keyTemplate: "${agent}:${variant}:${providerKey}",
      },
    });
    assert.equal(config.keyTemplate, "${agent}:${variant}:${providerKey}");
  });

  test("normalizes fallbacks", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        fallbacks: [
          { providerKey: "codex-fast", agent: "codex" },
          { providerKey: "codex-slow", agent: "codex", variant: "slow" },
        ],
      },
    });
    assert.equal(config.fallbacks.length, 2);
    assert.equal(config.fallbacks[0].providerKey, "codex-fast");
    assert.equal(config.fallbacks[0].agent, "codex");
    assert.equal(config.fallbacks[1].variant, "slow");
  });

  test("normalizes CLI config", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        cli: {
          command: "codex-cli",
          args: ["--verbose"],
          modelEnv: "CODEX_MODEL",
          modelArg: "--model",
        },
      },
    });
    assert.equal(config.cliCommand, "codex-cli");
    assert.deepEqual(config.cliArgs, ["--verbose"]);
    assert.equal(config.cliModelEnv, "CODEX_MODEL");
    assert.equal(config.cliModelArg, "--model");
  });

  test("normalizes normalizers", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        normalizers: {
          MODEL: "strip-trailing-bracket-suffix",
          API_KEY: "trim",
        },
      },
    });
    assert.deepEqual(config.normalizers, {
      MODEL: "strip-trailing-bracket-suffix",
      API_KEY: "trim",
    });
  });
});

// --- providerEnvironmentKeys ---

describe("providerEnvironmentKeys", () => {
  test("returns credential env keys as Set", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        environment: {
          CODEX_API_KEY: ["CODEX_API_KEY"],
        },
      },
    });
    const keys = providerEnvironmentKeys(config);
    assert.ok(keys instanceof Set);
    assert.ok(keys.has("CODEX_API_KEY"));
  });
});

// --- providerCredentialInputKeys ---

describe("providerCredentialInputKeys", () => {
  test("returns credential input keys as Set", () => {
    const config = normalizeProviderConfig("codex", {
      provider: {
        environment: {
          CODEX_API_KEY: ["CODEX_API_KEY"],
        },
      },
    });
    const keys = providerCredentialInputKeys(config);
    assert.ok(keys instanceof Set);
    assert.ok(keys.has("CODEX_API_KEY"));
  });
});

// --- providerVariantFromEnvironment ---

describe("providerVariantFromEnvironment", () => {
  test("returns explicit variant when provided", () => {
    const result = providerVariantFromEnvironment("codex", {}, "fast");
    assert.equal(result, "fast");
  });

  test("reads from CPB_PROVIDER_VARIANT", () => {
    const result = providerVariantFromEnvironment("codex", { CPB_PROVIDER_VARIANT: "slow" });
    assert.equal(result, "slow");
  });

  test("reads from CPB_ACP_AGENT_VARIANT", () => {
    const result = providerVariantFromEnvironment("codex", { CPB_ACP_AGENT_VARIANT: "beta" });
    assert.equal(result, "beta");
  });

  test("reads from agent-specific env", () => {
    const result = providerVariantFromEnvironment("codex", { CPB_ACP_CODEX_VARIANT: "fast" });
    assert.equal(result, "fast");
  });

  test("explicit wins over env", () => {
    const result = providerVariantFromEnvironment("codex", { CPB_PROVIDER_VARIANT: "slow" }, "fast");
    assert.equal(result, "fast");
  });

  test("returns null when nothing set", () => {
    const result = providerVariantFromEnvironment("codex", {});
    assert.equal(result, null);
  });
});

// --- providerKeyForDescriptor ---

describe("providerKeyForDescriptor", () => {
  test("returns key from descriptor", () => {
    const result = providerKeyForDescriptor("codex", {
      provider: { key: "codex-default" },
    });
    assert.equal(result, "codex-default");
  });

  test("falls back to agent name", () => {
    const result = providerKeyForDescriptor("codex", {});
    assert.equal(result, "codex");
  });

  test("interpolates keyTemplate", () => {
    const result = providerKeyForDescriptor("codex", {
      provider: {
        key: "codex-default",
        keyTemplate: "${agent}:${variant}:${providerKey}",
        variant: "fast",
      },
    });
    assert.equal(result, "codex:fast:codex-default");
  });
});

// --- providerVariantFromKey ---

describe("providerVariantFromKey", () => {
  test("returns variant when key matches config key", () => {
    const result = providerVariantFromKey("codex", {
      provider: {
        key: "codex-default",
        variant: "fast",
      },
    }, "codex-default");
    assert.equal(result, "fast");
  });

  test("extracts variant from agent prefix", () => {
    const result = providerVariantFromKey("codex", {}, "codex:fast");
    assert.equal(result, "fast");
  });

  test("returns null for unknown key", () => {
    const result = providerVariantFromKey("codex", {}, "unknown-key");
    assert.equal(result, null);
  });
});

// --- isValidProviderConfig ---

describe("isValidProviderConfig", () => {
  test("returns true for undefined", () => {
    assert.equal(isValidProviderConfig(undefined), true);
  });

  test("returns true for valid object", () => {
    assert.equal(isValidProviderConfig({ key: "codex" }), true);
  });

  test("returns false for non-object", () => {
    assert.equal(isValidProviderConfig("string"), false);
    assert.equal(isValidProviderConfig(42), false);
    assert.equal(isValidProviderConfig(true), false);
  });
});

// --- applyProviderEnvironment ---

describe("applyProviderEnvironment", () => {
  test("copies env vars from source mapping", () => {
    const env: Record<string, string | undefined> = { MY_API_KEY: "secret-123" };
    const result = applyProviderEnvironment(env, "codex", {
      provider: {
        environment: { CODEX_API_KEY: ["MY_API_KEY"] },
      },
    });
    assert.equal(env.CODEX_API_KEY, "secret-123");
    assert.ok(result.resolvedEnvironment.CODEX_API_KEY === "secret-123");
  });

  test("applies strip-trailing-bracket-suffix normalizer", () => {
    const env: Record<string, string | undefined> = { MODEL_INPUT: "claude-sonnet[20250219]" };
    applyProviderEnvironment(env, "codex", {
      provider: {
        environment: { MODEL: ["MODEL_INPUT"] },
        normalizers: { MODEL: "strip-trailing-bracket-suffix" },
      },
    });
    assert.equal(env.MODEL, "claude-sonnet");
  });

  test("applies trim normalizer", () => {
    const env: Record<string, string | undefined> = { RAW_KEY: "  secret  " };
    applyProviderEnvironment(env, "codex", {
      provider: {
        environment: { API_KEY: ["RAW_KEY"] },
        normalizers: { API_KEY: "trim" },
      },
    });
    assert.equal(env.API_KEY, "secret");
  });

  test("copies derived vars", () => {
    const env: Record<string, string | undefined> = { BASE_URL: "https://api.example.com" };
    applyProviderEnvironment(env, "codex", {
      provider: {
        derived: { API_ENDPOINT: "BASE_URL" },
      },
    });
    assert.equal(env.API_ENDPOINT, "https://api.example.com");
  });

  test("interpolates static values", () => {
    const env: Record<string, string | undefined> = {};
    applyProviderEnvironment(env, "codex", {
      provider: {
        key: "codex-default",
        values: { PROVIDER_IDENTITY: "${agent}:${variant}" },
        variant: "fast",
      },
    });
    assert.equal(env.PROVIDER_IDENTITY, "codex:fast");
  });

  test("throws on missing required env var", () => {
    const env: Record<string, string | undefined> = {};
    assert.throws(
      () => applyProviderEnvironment(env, "codex", {
        provider: { environment: { API_KEY: ["MISSING_KEY"] }, required: ["API_KEY"] },
      }),
      /Missing configured provider environment/,
    );
  });

  test("sets cliModelEnv when model is specified", () => {
    const env: Record<string, string | undefined> = {};
    applyProviderEnvironment(env, "codex", {
      provider: { cli: { command: "codex-cli" } },
    }, { model: "claude-sonnet" });
    assert.equal(env.ANTHROPIC_MODEL, "claude-sonnet");
  });

  test("skips env mapping when source not set", () => {
    const env: Record<string, string | undefined> = {};
    applyProviderEnvironment(env, "codex", {
      provider: { environment: { TARGET: ["MISSING_SOURCE"] } },
    });
    assert.equal(env.TARGET, undefined);
  });
});

// --- providerFallbacksFromDescriptor ---

describe("providerFallbacksFromDescriptor", () => {
  test("returns empty array when no fallbacks", () => {
    const result = providerFallbacksFromDescriptor("codex", {});
    assert.deepEqual(result, []);
  });

  test("returns fallback candidates with providerKey", () => {
    const result = providerFallbacksFromDescriptor("codex", {
      provider: {
        key: "codex-primary",
        fallbacks: [
          { providerKey: "codex-fast", agent: "codex" },
          { providerKey: "codex-slow", agent: "codex", variant: "slow" },
        ],
      },
    });
    assert.equal(result.length, 2);
    assert.equal(result[0].providerKey, "codex-fast");
    assert.equal(result[0].agent, "codex");
    assert.equal(result[1].variant, "slow");
  });

  test("defaults providerKey to primary key when missing", () => {
    const result = providerFallbacksFromDescriptor("codex", {
      provider: {
        key: "codex-primary",
        fallbacks: [
          { providerKey: "codex-fast", agent: "codex" },
        ],
      },
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].providerKey, "codex-fast");
  });
});
